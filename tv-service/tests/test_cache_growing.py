"""Growing-cache integration checks; run with python3 tests/test_cache_growing.py."""
import collections
import contextlib
import http.client
import json
import os
import pathlib
import socket
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest import mock


# These modules resolve their roots and feature flags at import time.
_ROOT = tempfile.TemporaryDirectory()
os.environ['DUMIFLIX_CACHE_ROOT'] = _ROOT.name
os.environ['DUMIFLIX_LOG_DIR'] = _ROOT.name
os.environ['DUMIFLIX_CACHE_ENABLED'] = '1'
os.environ['DUMIFLIX_CACHE_DIRECT_HTTP'] = '0'
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import cache
import server


CHUNK = 4096


def fast_origin_retries():
    # Cache's backoff alone is skipped; HTTP pacing and the remux watchdog
    # keep their real sleeps instead of spinning on a globally patched time.
    return mock.patch.object(cache, 'time', SimpleNamespace(
        time=time.time, monotonic=time.monotonic, sleep=lambda _seconds: None))


def wait_for(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.002)
    raise AssertionError('timed out waiting for cache state')


def ebml(kind, payload):
    key = kind.to_bytes((kind.bit_length() + 7) // 8, 'big')
    width = next(w for w in range(1, 9) if len(payload) < (1 << (w * 7)) - 1)
    size = ((1 << (width * 7)) | len(payload)).to_bytes(width, 'big')
    return key + size + payload


def mkv_header(cues_start, later_seekhead=None):
    header = ebml(0x1A45DFA3, ebml(0x4282, b'matroska'))
    segment = bytes.fromhex('1853806701ffffffffffffff')
    segment_start = len(header) + len(segment)
    seek = ebml(0x4DBB, ebml(0x53AB, bytes.fromhex('1549a966')) + ebml(0x53AC, b'\0'))
    cues_seek = b''
    if cues_start is not None:
        # SeekPosition is relative to Segment DATA, not the Segment ID.
        # Put the fields in the opposite order to the first Seek entry.
        cues_seek = ebml(0x4DBB, ebml(0x53AC, (cues_start - segment_start).to_bytes(8, 'big'))
                         + ebml(0x53AB, bytes.fromhex('1c53bb6b')))
    if later_seekhead == 'adjacent':
        heads = ebml(0x114D9B74, seek) + ebml(0x114D9B74, cues_seek)
    elif later_seekhead is not None:
        second = later_seekhead
        seek += ebml(0x4DBB, ebml(0x53AB, bytes.fromhex('114d9b74'))
                     + ebml(0x53AC, (second - segment_start).to_bytes(8, 'big')))
        first = header + segment + ebml(0x114D9B74, seek) + bytes.fromhex('1f43b675ff')
        return first + bytes(second - len(first)) + ebml(0x114D9B74, cues_seek)
    else:
        heads = ebml(0x114D9B74, seek + cues_seek)
    return header + segment + heads + bytes.fromhex('1f43b675ff')


def mkv_source(cues_start=CHUNK * 120, total=CHUNK * 128 + 317,
               later_seekhead=None, cues_payload=None):
    prefix = mkv_header(cues_start, later_seekhead)
    source = bytearray((i * 17 + i // 251) % 256 for i in range(total))
    source[:len(prefix)] = prefix
    if cues_start is not None:
        payload = ebml(0xBB, ebml(0xB3, b'\0')) if cues_payload is None else cues_payload
        cues = ebml(0x1C53BB6B, payload)
        source[cues_start:cues_start + len(cues)] = cues
    return bytes(source)


def mp4_source(faststart=False, extended=False, eof_moov=False, eof_mdat=False):
    def box(kind, payload, large=False, eof=False):
        if eof:
            return bytes(4) + kind + payload
        if large:
            return (1).to_bytes(4, 'big') + kind + (16 + len(payload)).to_bytes(8, 'big') + payload
        return (8 + len(payload)).to_bytes(4, 'big') + kind + payload
    ftyp = box(b'ftyp', b'isom\0\0\0\0')
    moov = box(b'moov', b'x' * (CHUNK - 8), extended, eof_moov)
    mdat = box(b'mdat', b'y' * (CHUNK * 120 - 16), extended, eof_mdat)
    padding = box(b'free', b'padding!')
    if faststart:
        return ftyp + moov + mdat, 0
    if eof_mdat:
        return ftyp + mdat, 0
    return ftyp + mdat + padding + moov, len(ftyp) + len(mdat)


class Origin(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        source = self.server.source
        value = self.headers.get('Range')
        start, end = 0, len(source) - 1
        if value:
            a, b = value[6:].split('-')
            start, end = int(a), int(b) if b else end
        with self.server.lock:
            self.server.requests.append((start, end))
            budget = getattr(self.server, 'refuse_starts', {})
            refuse = budget.get(start, 0) > 0
            if refuse:
                budget[start] -= 1
        if refuse:
            codes = getattr(self.server, 'refuse_codes', {}).get(start, [])
            self.send_response(codes.pop(0) if codes else 503)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        self.send_response(206 if value and not self.server.ignore_range else 200)
        if self.server.ignore_range:
            start, end = 0, len(source) - 1
        elif value:
            self.send_header('Content-Range', f'bytes {start}-{end}/{len(source)}')
        self.send_header('Content-Length', str(end + 1 - start))
        self.end_headers()
        gate = getattr(self.server, 'gates', {}).get(start)
        if gate:
            entered, release = gate
            entered.set()
            release.wait(3)
        truncated = getattr(self.server, 'truncate_starts', {}).pop(start, None)
        body_end = min(end, start + truncated - 1) if truncated is not None else end
        try:
            for offset in range(start, body_end + 1, CHUNK):
                time.sleep(0.003)
                self.wfile.write(source[offset:min(offset + CHUNK, body_end + 1)])
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


class TrackedResponse:
    """Count bytes actually fetched by each client reader, including early close."""
    def __init__(self, response, start, owner):
        self.response, self.offset, self.owner = response, start, owner
        self.start = start
        self.closed = False
        with owner.lock:
            owner.responses.append(self)
            owner.open_connections += 1
            owner.max_connections = max(owner.max_connections, owner.open_connections)

    def __getattr__(self, name):
        return getattr(self.response, name)

    def read(self, size):
        return self._track(self.response.read(size))

    def read1(self, size):
        return self._track(self.response.read1(size))

    def _track(self, data):
        with self.owner.lock:
            self.owner.reads.append((self.offset, self.offset + len(data)))
            job = getattr(self.owner, 'current_job', None)
            if job:
                self.owner.progress.append((job.get('received', 0), job.get('contiguous', 0)))
        self.offset += len(data)
        return data

    def close(self):
        if not self.closed:
            self.closed = True
            self.response.close()
            with self.owner.lock:
                self.owner.open_connections -= 1

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class CacheGrowingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.origin = ThreadingHTTPServer(('127.0.0.1', 0), Origin)
        cls.origin.daemon_threads = True
        cls.origin.lock = threading.Lock()
        cls.engine = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.engine.daemon_threads = True
        cls.threads = []
        for httpd in (cls.origin, cls.engine):
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            cls.threads.append(thread)

    @classmethod
    def tearDownClass(cls):
        for httpd in (cls.origin, cls.engine):
            httpd.shutdown()
            httpd.server_close()
        for thread in cls.threads:
            thread.join(2)
        _ROOT.cleanup()

    def setUp(self):
        self.patches = contextlib.ExitStack()
        self.addCleanup(self.patches.close)
        for module, name, value in (
            (cache, 'CHUNK_BYTES', CHUNK),
            (cache, 'GROWING_MIN_BYTES', CHUNK * 2),
            (cache, 'GROWING_MP4_PROBE_BYTES', CHUNK * 4),
            (cache, 'GROWING_MKV_PROBE_BYTES', CHUNK * 4),
            (cache, 'FREE_FLOOR_BYTES', 0),
            (cache, 'queue_thumbs', lambda _rel: None),
            (cache, 'maybe_generate_sub', lambda _rel: None),
            (cache, 'listing_invalidate', lambda: None),
            (server, 'TOKEN', ''),
            (server, 'GROWING_NO_PROGRESS_SECONDS', 0.18),
        ):
            self.patches.enter_context(mock.patch.object(module, name, value))
        cache._JOBS.clear()
        cache._active_job_id = None
        for path in cache.CACHE_ROOT.iterdir():
            if path.is_file():
                path.unlink()
        self.lock = threading.Lock()
        self.open_connections = self.max_connections = 0
        self.reads = []
        self.responses = []
        self.progress = []
        self.current_job = None
        self.origin.requests = []
        self.origin.ignore_range = False
        self.origin.refuse_starts = {}
        self.origin.refuse_codes = {}
        self.origin.truncate_starts = {}
        self.origin.gates = {}
        original_open = cache._job_urlopen

        def tracked_open(job, request, timeout):
            value = request.get_header('Range')
            start = int(value[6:].split('-')[0]) if value else 0
            response = original_open(job, request, timeout)
            if response.status == 200:
                start = 0
            return TrackedResponse(response, start, self)

        self.patches.enter_context(mock.patch.object(cache, '_job_urlopen', tracked_open))

    def start_download(self, size=CHUNK * 128 + 317, source=None, name='movie.mkv'):
        self.origin.source = source if source is not None else bytes(
            (i * 17 + i // 251) % 256 for i in range(size))
        size = len(self.origin.source)
        result = cache.reserve('test-source', name,
                               f'http://127.0.0.1:{self.origin.server_port}/file', size)
        self.assertTrue(result['ok'], result)
        job = cache._JOBS[result['id']]
        self.current_job = job
        self.progress.clear()
        worker = threading.Thread(target=cache.cache_download, args=(result['id'],), daemon=True)
        worker.start()
        self.addCleanup(self.stop_worker, job, worker)
        return result['id'], job, worker

    def stop_worker(self, job, worker):
        if worker.is_alive():
            job['_cancel'] = True
            for _entered, release in self.origin.gates.values():
                release.set()
            worker.join(3)
        self.assertFalse(worker.is_alive())

    def assert_complete(self, job, worker, overlap=False):
        worker.join(4)
        self.assertFalse(worker.is_alive())
        self.assertEqual(job['state'], 'ready', job.get('error'))
        self.assertEqual(job['received'], len(self.origin.source))
        self.assertEqual(job['contiguous'], job['total'])
        self.assertEqual(pathlib.Path(job['path']).read_bytes(), self.origin.source)
        self.assertLessEqual(self.max_connections, 2)
        # Every source byte is read; only a prefetched index may be repeated.
        cursor = 0
        for start, end in sorted((a, b) for a, b in self.reads if a != b):
            if overlap:
                self.assertLessEqual(start, cursor, 'missing origin reads')
            else:
                self.assertEqual(start, cursor, 'overlapping or missing origin reads')
            cursor = max(cursor, end)
        self.assertEqual(cursor, len(self.origin.source))
        self.assertEqual(cache.growing_ranges(job), [[0, job['total']]])
        self.assertEqual(cache.bytes_per_sec(job), 0)
        self.assert_progress_monotonic(self.progress)

    def assert_progress_monotonic(self, samples):
        for index, name in enumerate(('received', 'contiguous')):
            values = [sample[index] for sample in samples]
            self.assertEqual(values, sorted(values), name + ' went backwards')

    def test_counter_assertion_checks_each_counter_independently(self):
        self.assert_progress_monotonic([(100, 90), (101, 91), (101, 91)])
        for samples in ([(100, 90), (101, 80)], [(100, 90), (99, 91)]):
            with self.subTest(samples=samples), self.assertRaises(AssertionError):
                self.assert_progress_monotonic(samples)

    def status(self, job_id):
        connection = http.client.HTTPConnection('127.0.0.1', self.engine.server_port, timeout=2)
        try:
            connection.request('GET', '/cache/status?id=' + job_id)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_accelerate_during_head(self):
        job_id, job, worker = self.start_download()
        wait_for(lambda: cache.progressive_ready(job))
        self.assertLess(job['contiguous'], job['_split'])
        self.assertTrue(cache.accelerate(job_id)['accelerated'])
        wait_for(lambda: job['_tail_end'] > job['_split'])
        ranges = cache.growing_ranges(job)
        self.assertEqual(len(ranges), 2)
        for start, end in ranges:
            self.assertEqual(cache.growing_available(job, start), end)
        self.assertEqual(cache.growing_available(job, ranges[0][1]), ranges[0][1])
        status, payload = self.status(job_id)
        self.assertEqual(status, 200)
        self.assertEqual(len(payload['ranges']), 2)
        self.assertGreater(payload['bytesPerSec'], 0)
        with job['_io_lock']:
            self.assertEqual(sum(n for _t, n in job['_rate_samples']), job['received'])
        self.assert_complete(job, worker)
        self.assertEqual(self.max_connections, 2)
        self.assertEqual(len(self.origin.requests), 2)
        self.assertEqual(self.status(job_id)[1]['ranges'], [[0, job['total']]])

    def test_accelerate_during_sequential_tail(self):
        # Head is below the growing threshold, like a 16-256 MiB real file.
        cache.GROWING_MIN_BYTES = CHUNK * 70
        job_id, job, worker = self.start_download()
        wait_for(lambda: cache.progressive_ready(job))
        old_split = job['_split']
        self.assertGreater(job['contiguous'], old_split)
        self.assertTrue(cache.accelerate(job_id)['accelerated'])
        wait_for(lambda: job.get('_accelerated'))
        self.assertGreater(job['_split'], old_split)
        self.assert_complete(job, worker)
        self.assertEqual(self.max_connections, 2)
        self.assertEqual(len(self.origin.requests), 2)
        self.assertGreater(self.origin.requests[1][0], old_split)

    def test_refused_second_connection_is_finished_by_the_main_lane(self):
        # Seedr refusing the tail range (over its connection limit) must not
        # fail the copy: the head finishes its half, then fetches the rest.
        with fast_origin_retries():
            job_id, job, worker = self.start_download()
            wait_for(lambda: cache.progressive_ready(job))
            # Refuse the tail lane's four attempts; the main lane's later
            # resume from the same offset is then served.
            self.origin.refuse_starts = {job['_split']: 4}
            self.addCleanup(lambda: setattr(self.origin, 'refuse_starts', {}))
            self.assertTrue(cache.accelerate(job_id)['accelerated'])
            worker.join(8)
        self.assertEqual(job['state'], 'ready', job.get('error'))
        self.assertEqual(pathlib.Path(job['path']).read_bytes(), self.origin.source)
        self.assertEqual(job['received'], len(self.origin.source))

    def test_very_late_acceleration_does_not_duplicate_tiny_remainder(self):
        job_id, job, worker = self.start_download()
        wait_for(lambda: job.get('contiguous', 0) >= job['total'] - CHUNK * 2)
        cache.accelerate(job_id)
        self.assert_complete(job, worker)
        self.assertEqual(len(self.origin.requests), 1)

    def test_small_file_and_range_ignored_fallback(self):
        for size, ignore_range in ((CHUNK * 2 + 17, False), (CHUNK * 16 + 17, True)):
            with self.subTest(size=size):
                self.origin.ignore_range = ignore_range
                _job_id, job, worker = self.start_download(size)
                self.assert_complete(job, worker)
                self.assertFalse(job['range_supported'])
                # Use a different cache identity for the next iteration.
                pathlib.Path(job['path']).unlink()
                self.reads.clear()

    def test_mp4_probe_does_not_latch_incomplete_prefix(self):
        dest = cache.CACHE_ROOT / 'probe.mp4'
        part = pathlib.Path(str(dest) + '.part')
        atom = lambda kind, size: size.to_bytes(4, 'big') + kind + bytes(size - 8)
        data = atom(b'ftyp', CHUNK * 2) + atom(b'moov', CHUNK) + atom(b'mdat', CHUNK)
        job = {'state': 'downloading', 'path': str(dest), 'contiguous': CHUNK * 2}
        part.write_bytes(data[:CHUNK * 2])
        self.assertFalse(cache.progressive_ready(job))
        self.assertNotIn('_progressive_unsafe', job)
        part.write_bytes(data[:CHUNK * 2 + 32])
        job['contiguous'] = CHUNK * 2 + 32
        self.assertFalse(cache.progressive_ready(job))
        self.assertNotIn('_progressive_unsafe', job)
        part.write_bytes(data)
        job['contiguous'] = len(data)
        self.assertTrue(cache.progressive_ready(job))
        # An unreadable probe is inconclusive even past the probe limit.
        job.pop('_progressive_ready')
        job.pop('_container_index')
        part.unlink()
        self.assertFalse(cache.progressive_ready(job))
        self.assertNotIn('_progressive_unsafe', job)
        # A short disk read must not be mistaken for a complete bounded probe.
        part.write_bytes(data[:CHUNK * 2])
        self.assertFalse(cache.progressive_ready(job))
        self.assertNotIn('_progressive_unsafe', job)
        part.write_bytes(atom(b'ftyp', 16) + atom(b'mdat', CHUNK * 4))
        self.assertFalse(cache.progressive_ready(job))
        self.assertTrue(job['_progressive_unsafe'])

    def gate_origin(self, start):
        entered, release = threading.Event(), threading.Event()
        self.origin.gates[start] = (entered, release)
        self.addCleanup(release.set)
        return entered, release

    @contextlib.contextmanager
    def gate_primary(self, offset):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        read_some = cache._read_some

        def gated_read(response, want):
            if response.start == 0 and response.offset >= offset:
                entered.set()
                release.wait(5)
            return read_some(response, want)

        try:
            with mock.patch.object(cache, '_read_some', gated_read):
                yield entered, release
        finally:
            release.set()

    def reset_copy(self, job):
        pathlib.Path(job['path']).unlink()
        self.reads.clear()
        self.responses.clear()
        self.progress.clear()
        self.origin.requests.clear()
        self.origin.gates.clear()
        self.max_connections = 0

    def assert_index_handoff(self, source, index_start, name):
        index_entered, release_index = self.gate_origin(index_start)
        with self.gate_primary(CHUNK * 2) as (head_entered, release_head):
            _job_id, job, worker = self.start_download(source=source, name=name)
            self.assertTrue(head_entered.wait(2))
            primary = self.responses[0]
            self.assertEqual(job['contiguous'], cache.GROWING_MIN_BYTES)
            with mock.patch.object(cache, 'GROWING_MIN_BYTES', CHUNK * 3):
                self.assertFalse(cache.progressive_ready(job))
            self.assertTrue(cache.progressive_ready(job))
            self.assertEqual(cache.growing_available(job, index_start), index_start)
            self.assertEqual(self.origin.requests, [(0, len(source) - 1)])
            self.assertFalse(primary.closed)
            self.assertEqual(self.open_connections, 1)
            self.assertFalse(job['_index_wanted'])
            # Reading the head does not spend the second connection.
            _connection, head = self.open_growing(job, 'bytes=0-31')
            self.assertEqual(head.read(), source[:32])
            self.assertFalse(job['_index_wanted'])
            # A reader other than the TV's handoff (the TV may still hold its
            # Seedr connections) never asks for the index lane.
            other, _other_response = self.open_growing(
                job, 'bytes=%d-%d' % (index_start, len(source) - 1), player='')
            time.sleep(0.2)
            self.assertFalse(job['_index_wanted'])
            other.close()
            _connection, response = self.open_growing(
                job, 'bytes=%d-%d' % (index_start, len(source) - 1))
            wait_for(lambda: job['_index_wanted'])
            self.assertEqual(self.max_connections, 1)
            release_head.set()
            self.assertTrue(index_entered.wait(2))
            wait_for(lambda: self.open_connections == 2)
            self.assertFalse(primary.closed)
            self.assertEqual(self.open_connections, 2)
            self.assertEqual(job['_index_range'], (index_start, index_start))
            wait_for(lambda: job['contiguous'] >= CHUNK * 8)
            self.assertFalse(primary.closed)
            started = time.monotonic()
            release_index.set()
            self.assertEqual(response.read(), source[index_start:])
            self.assertLess(time.monotonic() - started, 0.5)
            self.assertEqual(job['_index_range'], (index_start, len(source)))
            self.assertTrue(cache.progressive_ready(job))
            self.assertEqual(self.origin.requests, [
                (0, len(source) - 1), (index_start, len(source) - 1)])
            self.assert_complete(job, worker, overlap=True)
            self.assertEqual(primary.offset, len(source))
            self.assertEqual(self.max_connections, 2)

    def test_mkv_end_cues_are_fetched_on_growing_demand(self):
        self.assert_index_handoff(mkv_source(), CHUNK * 120, 'movie.mkv')

    def test_later_seekheads_in_the_head_are_followed_before_handoff(self):
        for later in ('adjacent', 512):
            with self.subTest(later=later):
                self.assert_index_handoff(mkv_source(later_seekhead=later),
                                          CHUNK * 120, 'movie.mkv')
                self.reset_copy(self.current_job)

    def test_unresolved_linked_seekhead_stays_gated_until_copied(self):
        with self.gate_primary(CHUNK * 2) as (entered, release):
            _job_id, job, worker = self.start_download(
                source=mkv_source(later_seekhead=CHUNK * 112))
            self.assertTrue(entered.wait(2))
            self.assertFalse(cache.progressive_ready(job))
            self.assertTrue(job['_container_index']['seekhead'])
            self.assertEqual(len(self.origin.requests), 1)
            self.assertFalse(job['_index_active'])
            release.set()
            wait_for(lambda: cache.progressive_ready(job))
            self.assertFalse(job['_container_index'].get('seekhead'))
            self.assertEqual(job['_container_index']['start'], CHUNK * 120)
            self.assert_complete(job, worker)
            self.assertEqual(self.max_connections, 1)

    def test_older_readiness_poll_cannot_replace_resolved_cues_metadata(self):
        source = mkv_source(later_seekhead=CHUNK * 112)
        snapshot, release_poll = threading.Event(), threading.Event()
        results, errors = [], []
        parse = cache._mkv_index_info

        def delayed_parse(data, total, read_at=None):
            info = parse(data, total, read_at)
            if threading.current_thread() is older:
                self.assertTrue(info['seekhead'])
                snapshot.set()
                release_poll.wait(3)
            return info

        def poll():
            try:
                results.append(cache.progressive_ready(job))
            except Exception as e:
                errors.append(e)

        with self.gate_primary(CHUNK * 2) as (head, release_head), \
                self.gate_primary(CHUNK * 114) as (linked, release_linked), \
                self.gate_primary(CHUNK * 116) as (resumed, release_rest):
            _job_id, job, worker = self.start_download(source=source)
            self.assertTrue(head.wait(2))
            older = threading.Thread(target=poll)
            with mock.patch.object(cache, '_mkv_index_info', delayed_parse):
                older.start()
                try:
                    self.assertTrue(snapshot.wait(2))
                    release_head.set()
                    self.assertTrue(linked.wait(2))
                    self.assertTrue(cache.progressive_ready(job))
                    resolved = job['_container_index']
                    self.assertEqual(resolved, {'safe': False, 'start': CHUNK * 120})
                finally:
                    release_poll.set()
                    older.join(2)
                self.assertFalse(older.is_alive())
                self.assertEqual(errors, [])
                self.assertEqual(results, [True])
                self.assertIs(job['_container_index'], resolved)
                self.assertTrue(job['_progressive_ready'])
            started = time.monotonic()
            _connection, response = self.open_growing(
                job, 'bytes=%d-%d' % (CHUNK * 120, len(source) - 1))
            wait_for(lambda: job['_index_wanted'])
            release_linked.set()
            self.assertTrue(resumed.wait(2))
            self.assertEqual(response.read(), source[CHUNK * 120:])
            self.assertLess(time.monotonic() - started, 0.5)
            self.assertEqual(job['_index_range'], (CHUNK * 120, len(source)))
            self.assertEqual(self.max_connections, 2)
            release_rest.set()
            self.assert_complete(job, worker, overlap=True)

    def test_seekhead_chains_and_cycles_are_bounded(self):
        segment_start = len(ebml(0x1A45DFA3, ebml(0x4282, b'matroska'))) + 12

        def seek(kind, target):
            return ebml(0x4DBB, ebml(0x53AB, kind.to_bytes(4, 'big'))
                        + ebml(0x53AC, (target - segment_start).to_bytes(8, 'big')))

        data = mkv_header(None, 512)[:512] + ebml(0x114D9B74, seek(0x114D9B74, 768))
        data += bytes(768 - len(data)) + ebml(0x114D9B74, seek(0x1C53BB6B, CHUNK * 120))
        self.assertEqual(cache._mkv_index_info(data, CHUNK * 128),
                         {'safe': False, 'start': CHUNK * 120})
        # A link back to the already parsed first head cannot loop forever.
        data = mkv_header(None, 512)[:512] + ebml(0x114D9B74, seek(0x114D9B74, segment_start))
        self.assertEqual(cache._mkv_index_info(data, CHUNK * 128), {'safe': True})

    def test_incomplete_cues_beyond_budget_stay_gated_until_complete(self):
        cues_start = CHUNK * 120
        source = mkv_source(cues_payload=bytes(CHUNK * 6 - 1))
        cues_end = cues_start + len(ebml(0x1C53BB6B, bytes(CHUNK * 6 - 1)))
        end_chunk = (cues_end + CHUNK - 1) // CHUNK * CHUNK
        with mock.patch.object(cache, 'GROWING_INDEX_MAX_BYTES', CHUNK), \
                self.gate_primary(cues_start + CHUNK) as (partial, release_partial), \
                self.gate_primary(end_chunk) as (complete, release_complete):
            _job_id, job, worker = self.start_download(source=source)
            self.assertTrue(partial.wait(2))
            self.assertFalse(cache.progressive_ready(job))
            self.assertNotIn('_progressive_ready', job)
            self.assertEqual(len(self.origin.requests), 1)
            self.assertEqual(self.max_connections, 1)
            release_partial.set()
            self.assertTrue(complete.wait(2))
            self.assertTrue(cache.progressive_ready(job))
            _connection, response = self.open_growing(
                job, 'bytes=%d-%d' % (cues_start, cues_end - 1))
            self.assertEqual(response.read(), source[cues_start:cues_end])
            self.assertFalse(job['_index_wanted'])
            release_complete.set()
            self.assert_complete(job, worker)

    def test_mp4_end_moov_stays_gated_until_its_region_is_copied(self):
        for name, extended, eof_moov in (('movie.mp4', False, False),
                                         ('movie.mov', True, False),
                                         ('movie.m4v', False, True)):
            with self.subTest(name=name), self.gate_primary(CHUNK * 2) as (entered, release):
                source, index_start = mp4_source(extended=extended, eof_moov=eof_moov)
                _job_id, job, worker = self.start_download(source=source, name=name)
                self.assertTrue(entered.wait(2))
                self.assertFalse(cache.progressive_ready(job))
                self.assertEqual(job['_container_index']['start'], index_start)
                self.assertEqual(len(self.origin.requests), 1)
                self.assertFalse(self.responses[0].closed)
                release.set()
                self.assert_complete(job, worker)
                self.assertEqual(self.max_connections, 1)
                self.reset_copy(job)

    def test_inline_cues_and_no_cues_and_faststart_keep_one_sequential_lane(self):
        for name, source in (('inline.mkv', mkv_source(cues_start=512)),
                             ('no-cues.webm', mkv_source(cues_start=None)),
                             ('faststart.mp4', mp4_source(faststart=True)[0])):
            with self.subTest(name=name):
                _job_id, job, worker = self.start_download(source=source, name=name)
                wait_for(lambda: cache.progressive_ready(job))
                self.assertLess(job['contiguous'], job['_split'])
                self.assertFalse(job['_index_active'])
                self.assert_complete(job, worker)
                self.assertEqual(len(self.origin.requests), 1)
                self.assertEqual(self.max_connections, 1)
                pathlib.Path(job['path']).unlink()
                self.reads.clear()
                self.progress.clear()
                self.origin.requests.clear()

    def test_mkv_incomplete_header_falls_back_only_after_bounded_probe(self):
        dest = cache.CACHE_ROOT / 'probe.webm'
        part = pathlib.Path(str(dest) + '.part')
        # The EBML header body cannot fit in the bounded probe.
        data = ebml(0x1A45DFA3, b'x' * (CHUNK * 8))
        job = {'state': 'downloading', 'path': str(dest), 'contiguous': CHUNK * 2}
        part.write_bytes(data[:CHUNK * 2])
        self.assertFalse(cache.progressive_ready(job))
        part.write_bytes(data[:cache.GROWING_MKV_PROBE_BYTES])
        job['contiguous'] = cache.GROWING_MKV_PROBE_BYTES
        self.assertTrue(cache.progressive_ready(job))

    def test_index_offsets_larger_than_32_bits(self):
        total, start = 5_192_669_404, 5_191_322_193
        self.assertEqual(cache._mkv_index_info(mkv_header(start), total),
                         {'safe': False, 'start': start})
        ftyp = (16).to_bytes(4, 'big') + b'ftypisom\0\0\0\0'
        mdat = (1).to_bytes(4, 'big') + b'mdat' + (start - len(ftyp)).to_bytes(8, 'big')
        self.assertEqual(cache._mp4_index_info(ftyp + mdat, total),
                         {'safe': False, 'start': start})
        self.assertEqual(total - start, 1_347_211)

    def test_index_refusal_retries_quickly_while_main_stays_open(self):
        index_start = CHUNK * 120
        source = mkv_source()
        self.origin.refuse_starts = {index_start: 4}
        self.origin.refuse_codes = {index_start: [403, 404, 425, 429]}
        with mock.patch.object(server, 'GROWING_NO_PROGRESS_SECONDS', 4), \
                self.gate_primary(CHUNK * 2) as (head, release_head), \
                self.gate_primary(CHUNK * 8) as (entered, release):
            _job_id, job, worker = self.start_download(source=source)
            self.assertTrue(head.wait(2))
            started = time.monotonic()
            _connection, response = self.open_growing(
                job, 'bytes=%d-%d' % (index_start, len(source) - 1))
            wait_for(lambda: job['_index_wanted'])
            release_head.set()
            self.assertTrue(entered.wait(2))
            self.assertEqual(response.read(), source[index_start:])
            self.assertLess(time.monotonic() - started, 3.5)
            self.assertEqual(self.origin.requests.count((index_start, len(source) - 1)), 5)
            self.assertFalse(self.responses[0].closed)
            self.assertEqual(self.responses[0].offset, CHUNK * 8)
            self.assertEqual(self.max_connections, 2)
            release.set()
            self.assert_complete(job, worker, overlap=True)

    def test_failed_partial_or_stalled_index_can_be_requested_by_a_later_read(self):
        source = mkv_source()
        index_start = CHUNK * 120
        for stall in (False, True):
            with self.subTest(stall=stall):
                index_entered, release_index = self.gate_origin(index_start)
                if not stall:
                    self.origin.truncate_starts = {index_start: CHUNK * 2}
                    release_index.set()
                with mock.patch.object(server, 'GROWING_NO_PROGRESS_SECONDS', 1.3), \
                        self.gate_primary(CHUNK * 2) as (head, release_initial), \
                        self.gate_primary(CHUNK * 12) as (paused, release_head), \
                        self.gate_primary(CHUNK * 20) as (resumed, release_rest):
                    _job_id, job, worker = self.start_download(source=source)
                    self.assertTrue(head.wait(2))
                    _connection, response = self.open_growing(
                        job, 'bytes=%d-%d' % (index_start, len(source) - 1))
                    wait_for(lambda: job['_index_wanted'])
                    release_initial.set()
                    self.assertTrue(index_entered.wait(2))
                    self.assertTrue(paused.wait(2))
                    wait_for(lambda: not job['_index_active'])
                    self.assertFalse(job['_index_wanted'])
                    self.assertEqual(job['state'], 'downloading')
                    self.assertFalse(self.responses[0].closed)
                    have_end = index_start if stall else index_start + CHUNK * 2
                    self.assertEqual(job['_index_range'], (index_start, have_end))
                    with self.assertRaises(http.client.IncompleteRead) as error:
                        response.read()
                    self.assertEqual(error.exception.partial, source[index_start:have_end])
                    self.assertEqual(self.origin.requests.count((index_start, len(source) - 1)), 1)
                    release_index.set()
                    _connection, retry = self.open_growing(
                        job, 'bytes=%d-%d' % (have_end, len(source) - 1))
                    wait_for(lambda: job['_index_wanted'])
                    release_head.set()
                    self.assertTrue(resumed.wait(2))
                    self.assertEqual(retry.read(), source[have_end:])
                    self.assertEqual(job['_index_range'], (index_start, len(source)))
                    self.assertEqual(self.origin.requests.count((have_end, len(source) - 1)),
                                     2 if stall else 1)
                    self.assertFalse(self.responses[0].closed)
                    release_rest.set()
                    self.assert_complete(job, worker, overlap=True)
                    self.assertEqual(self.max_connections, 2)
                self.reset_copy(job)

    def test_failed_index_does_not_prevent_main_completion(self):
        index_start = CHUNK * 120
        self.origin.truncate_starts = {index_start: CHUNK}
        _job_id, job, worker = self.start_download(source=mkv_source())
        wait_for(lambda: cache.progressive_ready(job))
        _connection, response = self.open_growing(
            job, 'bytes=%d-%d' % (index_start, job['total'] - 1))
        # Continued main progress keeps this one request alive after failure.
        self.assertEqual(response.read(), self.origin.source[index_start:])
        self.assert_complete(job, worker, overlap=True)
        self.assertEqual(self.origin.requests.count((index_start, job['total'] - 1)), 1)
        self.assertFalse(job['_index_wanted'])

    def test_index_larger_than_budget_finishes_on_one_connection(self):
        with mock.patch.object(cache, 'GROWING_INDEX_MAX_BYTES', CHUNK), \
                self.gate_primary(CHUNK * 2) as (entered, release):
            _job_id, job, worker = self.start_download(source=mkv_source())
            self.assertTrue(entered.wait(2))
            self.assertFalse(cache.progressive_ready(job))
            self.assertFalse(job['_index_wanted'])
            self.assertEqual(len(self.origin.requests), 1)
            self.assertFalse(self.responses[0].closed)
            release.set()
            self.assert_complete(job, worker)
            self.assertEqual(self.responses[0].offset, job['total'])
            self.assertEqual(self.max_connections, 1)

    def test_eof_mdat_is_not_mistaken_for_trailing_moov(self):
        source, _start = mp4_source(eof_mdat=True)
        _job_id, job, worker = self.start_download(source=source, name='movie.mp4')
        wait_for(lambda: job.get('contiguous', 0) >= cache.GROWING_MIN_BYTES)
        self.assertFalse(cache.progressive_ready(job))
        self.assertTrue(job['_progressive_unsafe'])
        self.assertFalse(job['_index_active'])
        self.assert_complete(job, worker)

    def test_accelerated_tail_waits_for_index_and_recovers_after_partial_failure(self):
        for fail_tail in (False, True):
            with self.subTest(fail_tail=fail_tail):
                index_entered, release_index = self.gate_origin(CHUNK * 120)
                with self.gate_primary(CHUNK * 2) as (head, release_initial), \
                        self.gate_primary(CHUNK * 16) as (entered, release_head):
                    job_id, job, worker = self.start_download(source=mkv_source())
                    self.assertTrue(head.wait(2))
                    _connection, response = self.open_growing(
                        job, 'bytes=%d-%d' % (CHUNK * 120, job['total'] - 1))
                    wait_for(lambda: job['_index_wanted'])
                    release_initial.set()
                    self.assertTrue(index_entered.wait(2))
                    self.assertTrue(entered.wait(2))
                    self.assertEqual(self.max_connections, 2)
                    self.assertTrue(cache.accelerate(job_id)['accelerated'])
                    if fail_tail:
                        self.origin.truncate_starts = {job['_split']: CHUNK * 3}
                    release_head.set()
                    wait_for(lambda: job['contiguous'] > CHUNK * 20)
                    self.assertFalse(job['_accelerated'])
                    self.assertEqual(len(self.origin.requests), 2)
                    release_index.set()
                    self.assertEqual(response.read(), self.origin.source[CHUNK * 120:])
                    wait_for(lambda: job['_tail_end'] > job['_split'])
                    self.assertTrue(job['_accelerated'])
                    self.assertEqual(job['_index_range'], (CHUNK * 120, job['total']))
                    self.assert_complete(job, worker, overlap=True)
                    self.assertEqual(self.max_connections, 2)
                self.reset_copy(job)

    def test_cancelling_index_fetch_closes_both_connections(self):
        entered, release = self.gate_origin(CHUNK * 120)
        _job_id, job, worker = self.start_download(source=mkv_source())
        wait_for(lambda: cache.progressive_ready(job))
        _connection, response = self.open_growing(
            job, 'bytes=%d-%d' % (CHUNK * 120, job['total'] - 1))
        self.assertTrue(entered.wait(2))
        job['_cancel'] = True
        worker.join(2)
        release.set()
        self.assertFalse(worker.is_alive())
        self.assertEqual(job['state'], 'aborted')
        self.assertFalse(pathlib.Path(job['path'] + '.part').exists())
        self.assertEqual(self.open_connections, 0)
        self.assertEqual(self.max_connections, 2)
        self.assertFalse(job['_index_active'])
        with self.assertRaises(http.client.IncompleteRead):
            response.read()

    def test_sparse_partial_is_rebuilt_and_complete_index_copy_can_be_promoted(self):
        source = mkv_source()
        rel = cache._rel_for('test-source', 'movie.mkv', len(source))
        dest = cache.CACHE_ROOT / rel
        part = pathlib.Path(str(dest) + '.part')
        # A stale sparse part already has the final logical length. It must
        # not be mistaken for a complete movie or a readable prefix.
        with part.open('wb') as out:
            out.write(b'old header')
            out.seek(len(source) - 1)
            out.write(b'x')
        with mock.patch.object(cache, '_finalize_part', side_effect=PermissionError('sharing violation')):
            _job_id, job, worker = self.start_download(source=source)
            worker.join(4)
        self.assertFalse(worker.is_alive())
        self.assertEqual(job['state'], 'error')
        self.assertEqual(part.read_bytes(), source)
        self.assertIsNotNone(cache._completed_part(dest))
        before = list(self.origin.requests)
        result = cache.reserve('test-source', 'movie.mkv', job['url'], len(source))
        self.assertEqual(result['state'], 'ready')
        self.assertEqual(dest.read_bytes(), source)
        self.assertFalse(part.exists())
        self.assertEqual(self.origin.requests, before)

    def stalled_job(self):
        dest = cache.CACHE_ROOT / 'stalled.mkv'
        pathlib.Path(str(dest) + '.part').write_bytes(b'abcd')
        job = {'rel': dest.name, 'path': str(dest), 'state': 'downloading',
               'total': 32, 'received': 4, 'contiguous': 4, '_head_end': 4,
               '_progressive_ready': True, 'created_at': time.time()}
        cache._JOBS['stalled'] = job
        cache.GROWING_MIN_BYTES = 1
        return job

    def open_growing(self, job, byte_range='bytes=4-15', player='tv'):
        connection = http.client.HTTPConnection('127.0.0.1', self.engine.server_port, timeout=5)
        self.addCleanup(connection.close)
        query = '?player=' + player if player else ''
        connection.request('GET', '/cache/growing/' + job['rel'] + query, headers={'Range': byte_range})
        response = connection.getresponse()
        self.assertEqual(response.status, 206)
        return connection, response

    def test_growing_no_progress_deadline(self):
        job = self.stalled_job()
        started = time.monotonic()
        _connection, response = self.open_growing(job)
        with self.assertRaises(http.client.IncompleteRead) as error:
            response.read()
        self.assertEqual(error.exception.partial, b'')
        self.assertGreaterEqual(time.monotonic() - started, 0.15)
        self.assertLess(time.monotonic() - started, 1)
        wait_for(lambda: job['rel'] not in cache._holds)

    def test_growing_delivers_new_bytes_and_tolerates_rename(self):
        job = self.stalled_job()
        _connection, response = self.open_growing(job, 'bytes=0-7')
        self.assertEqual(response.read(4), b'abcd')
        dest = pathlib.Path(job['path'])
        part = pathlib.Path(str(dest) + '.part')
        with part.open('ab') as out:
            out.write(b'efgh')
        part.replace(dest)  # State publication deliberately lags the rename.
        job['_head_end'] = job['contiguous'] = 8
        self.assertEqual(response.read(), b'efgh')

    def test_growing_resets_deadline_on_progress(self):
        job = self.stalled_job()
        _connection, response = self.open_growing(job, 'bytes=4-6')

        def trickle():
            for value in (b'e', b'f', b'g'):
                time.sleep(0.11)
                with pathlib.Path(job['path'] + '.part').open('ab') as out:
                    out.write(value)
                job['_head_end'] += 1

        producer = threading.Thread(target=trickle)
        producer.start()
        try:
            self.assertEqual(response.read(), b'efg')
        finally:
            producer.join(2)

    def test_growing_stops_on_disconnect_or_terminal_job(self):
        for action in ('disconnect', 'error', 'aborted', 'cancel'):
            with self.subTest(action=action):
                # A departed player waiting in a gap is reaped by the deadline.
                server.GROWING_NO_PROGRESS_SECONDS = 1 if action == 'disconnect' else 5
                job = self.stalled_job()
                connection, response = self.open_growing(job)
                if action == 'disconnect':
                    # HTTPResponse owns the socket once Connection: close is
                    # observed; shut down its fd to model a departing player.
                    response.fp.raw._sock.shutdown(socket.SHUT_RDWR)
                    response.close()
                    connection.close()
                else:
                    if action == 'cancel':
                        job['_cancel'] = True
                    else:
                        job['state'] = action
                    with self.assertRaises(http.client.IncompleteRead):
                        response.read()
                wait_for(lambda: job['rel'] not in cache._holds,
                         timeout=3 if action == 'disconnect' else 0.5)

    def test_read_some_publishes_partial_chunks_on_slow_origin(self):
        class Paced:
            def __init__(self, delay, piece=1000):
                self.delay, self.piece = delay, piece
            def read1(self, n):
                time.sleep(self.delay)
                return b'x' * min(n, self.piece)
        with mock.patch.object(cache, 'PUBLISH_INTERVAL_SECONDS', 0.12):
            started = time.monotonic()
            data = cache._read_some(Paced(0.05), 1_000_000)
            self.assertLess(time.monotonic() - started, 0.5)
            self.assertTrue(0 < len(data) < 1_000_000)
            # A fast origin still fills the whole chunk in one publication.
            self.assertEqual(len(cache._read_some(Paced(0), 50_000)), 50_000)

        class ReadOnly:
            def read(self, n):
                return b'y' * n
        self.assertEqual(cache._read_some(ReadOnly(), 10), b'y' * 10)

    def test_status_reads_do_not_wait_for_a_busy_writer(self):
        lock = threading.Lock()
        now = time.monotonic()
        job = {'state': 'downloading', '_io_lock': lock, '_head_end': 10, '_split': 20,
               '_tail_end': 25, '_index_range': (30, 40), '_rate_started': now - 5,
               '_rate_samples': collections.deque([(now - 0.1, 5)])}
        lock.acquire()  # a writer stuck in a slow disk write
        try:
            started = time.monotonic()
            self.assertEqual(cache.growing_ranges(job), [[0, 10], [20, 25], [30, 40]])
            self.assertGreater(cache.bytes_per_sec(job), 0)
            self.assertLess(time.monotonic() - started, 1.0)
        finally:
            lock.release()

    def test_health_summary_reuses_recent_usage(self):
        calls = []
        with mock.patch.object(cache, 'cache_files', side_effect=lambda: calls.append(1) or []), \
                mock.patch.dict(cache._SUMMARY_USED, {'at': 0.0, 'used': 0}):
            cache.status_summary(max_age=30)
            cache.status_summary(max_age=30)
            cache.status_summary()   # accounting callers always rescan
        self.assertEqual(len(calls), 2)

    def test_ranges_merge_and_rate_window(self):
        now = time.monotonic()
        job = {'state': 'downloading', '_head_end': 10, '_split': 20,
               '_tail_end': 25, '_io_lock': threading.Lock(),
               '_rate_started': now - 5,
               '_rate_samples': collections.deque([(now - 4, 9999), (now - 1, 250)])}
        self.assertEqual(cache.growing_ranges(job), [[0, 10], [20, 25]])
        self.assertAlmostEqual(cache.bytes_per_sec(job), 100)
        job['_head_end'] = 20
        self.assertEqual(cache.growing_ranges(job), [[0, 25]])
        self.assertEqual(cache.growing_available(job, 0), 25)
        self.assertEqual(cache.growing_available(job, 25), 25)
        job['_index_range'] = (30, 40)
        self.assertEqual(cache.growing_ranges(job), [[0, 25], [30, 40]])
        job['_tail_end'] = 30
        self.assertEqual(cache.growing_ranges(job), [[0, 40]])
        job['_rate_samples'] = collections.deque([(now - 4, 9999)])
        self.assertEqual(cache.bytes_per_sec(job), 0)
        for state in ('started', 'error', 'aborted'):
            job['state'] = state
            self.assertEqual(cache.growing_ranges(job), [])
            self.assertEqual(cache.bytes_per_sec(job), 0)
        status, unknown = self.status('missing')
        self.assertEqual(status, 404)
        self.assertEqual(unknown['ranges'], [])
        self.assertEqual(unknown['bytesPerSec'], 0)

    def test_finalize_retries_permission_error(self):
        original_replace = pathlib.Path.replace
        attempts = []

        def flaky_replace(part, dest):
            if str(part).endswith('.mkv.part'):
                attempts.append(1)
                if len(attempts) < 3:
                    raise PermissionError('simulated Windows sharing violation')
            return original_replace(part, dest)

        with mock.patch.object(cache, 'FINALIZE_RETRY_SECONDS', 0.5), \
                mock.patch.object(pathlib.Path, 'replace', flaky_replace):
            _job_id, job, worker = self.start_download(CHUNK * 2)
            self.assert_complete(job, worker)
        self.assertEqual(len(attempts), 3)

    def test_finalize_exhaustion_preserves_complete_part(self):
        original_replace = pathlib.Path.replace

        def blocked_replace(part, dest):
            if str(part).endswith('.mkv.part'):
                raise PermissionError('simulated persistent Windows sharing violation')
            return original_replace(part, dest)

        with mock.patch.object(cache, 'FINALIZE_RETRY_SECONDS', 0.08), \
                mock.patch.object(pathlib.Path, 'replace', blocked_replace):
            _job_id, job, worker = self.start_download(CHUNK * 2)
            worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(job['state'], 'error')
        self.assertEqual(pathlib.Path(job['path'] + '.part').read_bytes(), self.origin.source)

    @unittest.skipUnless(os.name != 'nt', 'POSIX single-rename behavior')
    def test_posix_finalize_does_not_retry(self):
        with mock.patch.object(pathlib.Path, 'replace', side_effect=PermissionError) as replace:
            with self.assertRaises(PermissionError):
                cache._finalize_part(cache.CACHE_ROOT / 'part', cache.CACHE_ROOT / 'final')
        self.assertEqual(replace.call_count, 1)


if __name__ == '__main__':
    unittest.main()
