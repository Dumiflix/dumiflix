"""Laptop engine regressions: admission, recovery, HTTP framing and subtitles."""
import contextlib
import http.client
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest import mock

_ROOT = tempfile.TemporaryDirectory()
os.environ['DUMIFLIX_CACHE_ROOT'] = _ROOT.name
os.environ['DUMIFLIX_LOG_DIR'] = _ROOT.name
os.environ['DUMIFLIX_CACHE_DIRECT_HTTP'] = '0'
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cache
import server


class Response(io.BytesIO):
    status = 200

    def getcode(self):
        return self.status

    def __init__(self, data, length=None, barrier=None, before_read=None):
        super().__init__(data)
        self.headers = {} if length is None else {'Content-Length': str(length)}
        self.barrier = barrier
        self.before_read = before_read

    def read(self, n=-1):
        if self.barrier:
            barrier, self.barrier = self.barrier, None
            barrier.wait(3)
        if self.before_read:
            self.before_read(self.tell())
        return super().read(n)

    read1 = read


class LaptopEngineTests(unittest.TestCase):
    def setUp(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.root = Path(root.name).resolve()
        patches = contextlib.ExitStack()
        self.addCleanup(patches.close)
        for name, value in (
            ('CACHE_ROOT', self.root), ('_HASH_NAMES', True),
            ('_JOBS', {}), ('_active_job_id', None), ('_holds', {}),
            ('_SYNC_JOBS', {}), ('_MANIFEST_LOCKS', {}), ('FREE_FLOOR_BYTES', 0), ('HARD_CAP_BYTES', 100),
            ('CHUNK_BYTES', 10), ('_free_bytes', lambda: 10000),
            ('listing_invalidate', lambda: None), ('queue_thumbs', lambda rel: None),
            ('_protect_rel', lambda: None), ('_provider_protected_rels', lambda: []),
            ('FINALIZE_RETRY_SECONDS', 0),
        ):
            patches.enter_context(mock.patch.object(cache, name, value))
        patches.enter_context(mock.patch.object(server, 'CACHE_ENABLED', True))
        patches.enter_context(mock.patch.object(server, 'TOKEN', ''))
        patches.enter_context(mock.patch.object(server, 'TORRENT_ENABLED', False))

    def job(self, rel='film.mkv', total=0):
        job = {'path': str(self.root / rel), 'rel': rel, 'state': 'started',
               'total': total, 'received': 0, 'name': 'Readable Film.mkv',
               'file_id': rel, 'url': 'http://example.invalid/file'}
        cache._JOBS[rel] = job
        return job

    def handler(self, rel):
        h = server.Handler.__new__(server.Handler)
        h.command = 'POST'
        h.path = '/cache/del'
        raw = json.dumps({'rel': rel}).encode()
        h.headers = {'Content-Length': str(len(raw))}
        h.rfile, h.wfile = io.BytesIO(raw), io.BytesIO()
        h.close_connection = False
        h.send_response = mock.Mock()
        h.send_header = mock.Mock()
        h.end_headers = mock.Mock()
        return h

    def test_aliases_share_holds_manual_delete_eviction_and_growing_job(self):
        target = self.root / 'film.mkv'
        target.write_bytes(b'film')
        job = self.job(total=4)
        job['state'] = 'ready'
        for held, deleted in [('film.mkv', './film.mkv'),
                              ('./film.mkv', 'film.mkv'),
                              ('folder/../film.mkv', 'film.mkv')]:
            with self.subTest(held=held, deleted=deleted):
                cache.hold(held)
                try:
                    self.assertTrue(cache.is_protected(deleted))
                    self.assertIs(cache.job_for_rel(held), job)
                    h = self.handler(deleted)
                    h.do_POST()
                    h.send_response.assert_called_once_with(409)
                    cache.cache_evict(need_bytes=100)
                    self.assertTrue(target.is_file())
                finally:
                    cache.release(deleted)
                self.assertFalse(cache.playback_active()['active'])
        h = self.handler('./film.mkv')
        h.do_POST()
        h.send_response.assert_called_once_with(200)
        self.assertFalse(target.exists())

    def test_delete_serializes_reader_registration(self):
        target = self.root / 'film.mkv'
        target.write_bytes(b'film')
        original_unlink = Path.unlink
        registered = threading.Event()
        reader = []

        def unlink(path, *args, **kwargs):
            if path == target:
                self.assertTrue(cache._HOLDS_LOCK.locked())
                def register():
                    cache.hold('./film.mkv')
                    registered.set()
                thread = threading.Thread(target=register)
                reader.append(thread)
                thread.start()
                self.assertFalse(registered.wait(0.05))
            return original_unlink(path, *args, **kwargs)

        try:
            with mock.patch.object(Path, 'unlink', unlink):
                self.assertTrue(cache.delete_cached('./film.mkv'))
        finally:
            for thread in reader:
                thread.join(2)
            cache.release('film.mkv')
        self.assertTrue(registered.is_set())

    def test_oversized_body_rejected_without_reading_or_dispatching(self):
        h = self.handler('film.mkv')
        h.headers['Content-Length'] = str(server._READ_CAP + 1)
        h.rfile = mock.Mock()
        with mock.patch.object(cache, 'delete_cached') as delete:
            with self.assertRaises(server._RequestBodyTooLarge):
                h.do_POST()
        h.send_response.assert_called_once_with(413)
        h.send_header.assert_any_call('Connection', 'close')
        self.assertTrue(h.close_connection)
        h.rfile.read.assert_not_called()
        delete.assert_not_called()

    def test_oversized_body_closes_real_keep_alive_connection(self):
        httpd = server.DumiHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            with socket.create_connection(httpd.server_address, timeout=2) as sock:
                sock.sendall(('POST /cache/cancel HTTP/1.1\r\nHost: localhost\r\n'
                              'Content-Length: %d\r\n\r\n' % (server._READ_CAP + 1)).encode()
                             + b'GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n')
                response = http.client.HTTPResponse(sock)
                response.begin()
                self.assertEqual(response.status, 413)
                self.assertEqual(response.getheader('Connection'), 'close')
                response.read()
                self.assertEqual(sock.recv(1), b'')
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(2)

    def test_concurrent_unknown_size_writers_cannot_exceed_cap(self):
        barrier = threading.Barrier(2)
        jobs = [self.job('one.mkv'), self.job('two.mkv')]
        errors = []
        def run(rel):
            try:
                cache.cache_download(rel)
            except BaseException as exc:
                errors.append(exc)
        with mock.patch.object(cache, 'HARD_CAP_BYTES', 10), \
                mock.patch.object(cache, '_probe_remote_size', return_value=0), \
                mock.patch.object(cache, '_open_download',
                                  side_effect=lambda *args: Response(b'123456', barrier=barrier)):
            threads = [threading.Thread(target=run, args=(job['rel'],)) for job in jobs]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(5)
                self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(sorted(job['state'] for job in jobs), ['error', 'ready'])
        self.assertEqual(cache._capacity_usage(), 6)

    def test_active_reservations_are_counted_before_first_byte(self):
        first = self.job('one.mkv', 60)
        second = self.job('two.mkv', 50)
        with mock.patch.object(cache, '_open_download') as open_download:
            cache.cache_download(second['rel'])
        self.assertEqual(first['state'], 'started')
        self.assertEqual(second['state'], 'error')
        self.assertIn('cache full', second['error'])
        open_download.assert_not_called()

    def test_import_growth_is_rechecked_during_download(self):
        (self.root / 'old.mkv').write_bytes(b'x' * 20)
        job = self.job(total=50)
        def import_during_read(offset):
            if offset:
                (self.root / 'imported.mkv').write_bytes(b'y' * 30)
        with mock.patch.object(cache, 'HARD_CAP_BYTES', 80), \
                mock.patch.object(cache, '_open_download',
                                  return_value=Response(b'z' * 50, before_read=import_during_read)):
            cache.cache_download(job['rel'])
        self.assertEqual(job['state'], 'error')
        self.assertIn('cache full', job['error'])
        self.assertEqual(cache._capacity_usage(), 50)

    def test_discovered_size_repeats_free_floor_eviction_before_read(self):
        for probe_size in (30, 0):
            with self.subTest(probe_size=probe_size):
                (self.root / 'old.mkv').write_bytes(b'x' * 40)
                job = self.job()
                def free():
                    return 60 - sum(path.stat().st_size for path in self.root.iterdir()
                                    if path.name.endswith(('.mkv', '.part')))
                def before_read(offset):
                    self.assertFalse((self.root / 'old.mkv').exists())
                with mock.patch.object(cache, 'FREE_FLOOR_BYTES', 10), \
                        mock.patch.object(cache, '_free_bytes', side_effect=free), \
                        mock.patch.object(cache, '_probe_remote_size', return_value=probe_size), \
                        mock.patch.object(cache, '_open_download',
                                          return_value=Response(b'z' * 30, length=30,
                                                                before_read=before_read)):
                    cache.cache_download(job['rel'])
                self.assertEqual(job['state'], 'ready', job.get('error'))
                (self.root / job['rel']).unlink()

    def test_sweep_keeps_active_name_and_old_part(self):
        result = cache.reserve('film', 'Readable Film.mkv', 'http://example.invalid/file', 30)
        part = self.root / (result['rel'] + '.part')
        part.write_bytes(b'partial')
        os.utime(part, (0, 0))
        cache._sweep_once()
        self.assertEqual(cache.display_name(result['rel']), 'Readable Film.mkv')
        self.assertTrue(part.exists())

    def failed_promotion(self, total=30):
        job = self.job(total=total)
        with mock.patch.object(cache, '_finalize_part', side_effect=PermissionError('sharing violation')), \
                mock.patch.object(cache, '_open_download', return_value=Response(b'z' * total)):
            cache.cache_download(job['rel'])
        self.assertEqual(job['state'], 'error')
        self.assertEqual(cache._completed_part(Path(job['path']))['size'], total)
        return job

    def test_completed_part_survives_startup_failure_then_promotes(self):
        job = self.failed_promotion()
        cache._JOBS.clear()  # restart drops in-memory download state
        with mock.patch.object(cache, '_finalize_part', side_effect=PermissionError('still busy')):
            cache.cleanup_orphan_parts()
            cache._sweep_once()
        self.assertIsNotNone(cache._completed_part(Path(job['path'])))
        cache.cleanup_orphan_parts()
        self.assertEqual(Path(job['path']).read_bytes(), b'z' * 30)
        self.assertEqual(cache.display_name(job['rel']), 'Readable Film.mkv')
        self.assertFalse(cache._completion_path(Path(job['path'])).exists())

    def test_retry_promotes_complete_part_without_origin_or_truncation(self):
        job = self.failed_promotion()
        with mock.patch.object(cache, '_open_download') as origin, \
                mock.patch.object(cache, '_probe_remote_size') as probe:
            cache.cache_download(job['rel'])
        self.assertEqual(job['state'], 'ready')
        self.assertEqual(Path(job['path']).read_bytes(), b'z' * 30)
        origin.assert_not_called()
        probe.assert_not_called()

    def test_reserve_promotes_completion_before_starting_another_download(self):
        job = self.failed_promotion()
        with mock.patch.object(cache, '_rel_for', return_value=job['rel']):
            result = cache.reserve(job['file_id'], job['name'], job['url'], 30)
        self.assertEqual(result['state'], 'ready')
        self.assertEqual(Path(job['path']).read_bytes(), b'z' * 30)

    def test_incomplete_or_size_mismatched_parts_are_not_recovered(self):
        job = self.job(total=30)
        dest = Path(job['path'])
        part = dest.with_name(dest.name + '.part')
        cache._begin_part_generation(dest)
        part.write_bytes(b'partial')
        cache._record_complete_part(dest, job)
        part.write_bytes(b'bad')
        cache.cleanup_orphan_parts()
        self.assertFalse(part.exists())
        self.assertFalse(dest.exists())

    def test_stale_marker_is_removed_before_sparse_redownload_crashes(self):
        job = self.failed_promotion(total=100)
        dest = Path(job['path'])
        part = dest.with_name(dest.name + '.part')
        old_generation = cache._generation_path(dest).read_text()
        # Crash after rename, before metadata removal; then evict the movie.
        part.replace(dest)
        dest.unlink()
        self.assertTrue(cache._completion_path(dest).exists())
        cache._JOBS.clear()
        job = self.job(total=100)

        def crash_during_read(offset):
            if offset:
                self.assertFalse(cache._completion_path(dest).exists())
                self.assertNotEqual(cache._generation_path(dest).read_text(), old_generation)
                with part.open('r+b') as out:
                    out.seek(99)
                    out.write(b't')  # Full logical size, with an unwritten middle.
                raise SystemExit('simulated service crash')

        with mock.patch.object(cache, '_open_download',
                               return_value=Response(b'z' * 100, before_read=crash_during_read)):
            with self.assertRaises(SystemExit):
                cache.cache_download(job['rel'])
        self.assertEqual(part.stat().st_size, 100)
        self.assertEqual(part.read_bytes()[10:99], bytes(89))
        cache._JOBS.clear()
        cache.cleanup_orphan_parts()
        self.assertFalse(dest.exists())
        self.assertFalse(part.exists())

    def test_completion_marker_cannot_authorize_another_generation(self):
        job = self.failed_promotion(total=100)
        dest = Path(job['path'])
        part = dest.with_name(dest.name + '.part')
        marker = cache._completion_path(dest).read_bytes()
        cache._begin_part_generation(dest)
        with part.open('wb') as out:
            out.write(b'a' * 30)
            out.seek(70)
            out.write(b'b' * 30)
        self.assertEqual(part.stat().st_size, 100)
        cache._completion_path(dest).write_bytes(marker)
        self.assertIsNone(cache._completed_part(dest))
        cache._JOBS.clear()
        cache.cleanup_orphan_parts()
        self.assertFalse(dest.exists())

    def test_marker_rejects_same_generation_file_modified_at_same_size(self):
        job = self.failed_promotion(total=100)
        dest = Path(job['path'])
        part = dest.with_name(dest.name + '.part')
        marker = json.loads(cache._completion_path(dest).read_text())
        with part.open('r+b') as out:
            out.seek(30)
            out.write(bytes(40))
        # Deterministic on filesystems whose timestamp resolution is coarse.
        os.utime(part, ns=(part.stat().st_atime_ns,
                           marker['part_signature']['mtime_ns'] + 1_000_000_000))
        self.assertIsNone(cache._completed_part(dest))
        self.assertFalse(cache._promote_completed_part(dest))

    def test_legacy_size_only_completion_marker_is_not_trusted(self):
        dest = self.root / 'film.mkv'
        part = dest.with_name(dest.name + '.part')
        with part.open('wb') as out:
            out.seek(99)
            out.write(b't')
        cache._completion_path(dest).write_text(json.dumps({'size': 100}))
        self.assertIsNone(cache._completed_part(dest))
        cache.cleanup_orphan_parts()
        self.assertFalse(dest.exists())
        self.assertFalse(part.exists())

    def test_subtitle_aliases_share_one_worker_manifest_and_lock(self):
        rel = 'film.mkv'
        (self.root / rel).write_bytes(b'film')
        text = '1\n00:00:01,000 --> 00:00:02,000\nHello\n'
        for candidate in (None, text):
            with self.subTest(embedded=candidate is None):
                cache._SYNC_JOBS.clear()
                with mock.patch.object(cache.threading, 'Thread') as worker:
                    worker.return_value.is_alive.return_value = True
                    for alias in (rel, './' + rel, 'folder/../' + rel):
                        result = cache.subs_start_sync(alias, candidate)
                        self.assertTrue(result['ok'])
                        self.assertEqual(result['state'], 'syncing')
                        self.assertEqual(cache.subs_state(alias)['state'], 'syncing')
                    worker.assert_called_once()
                    worker.return_value.start.assert_called_once()
                    self.assertEqual(worker.call_args.kwargs['args'][0], rel)
                self.assertEqual(list(cache._SYNC_JOBS), [rel])
        for alias in ('./film.mkv', 'folder/../film.mkv'):
            self.assertIs(cache._manifest_lock(rel), cache._manifest_lock(alias))
            self.assertEqual(cache._manifest_path(rel), cache._manifest_path(alias))
        self.assertEqual(list(cache._MANIFEST_LOCKS), [rel])

    def test_aliased_manifest_writes_share_lock_while_contending(self):
        (self.root / 'film.mkv').write_bytes(b'film')
        first_inside, let_first_finish, second_inside = (threading.Event() for _ in range(3))
        errors = []
        def first_change(manifest):
            first_inside.set()
            if not let_first_finish.wait(3):
                raise RuntimeError('test timed out')
            manifest['entries']['one'] = {'state': 'ready'}
        def second_change(manifest):
            second_inside.set()
            manifest['entries']['two'] = {'state': 'ready'}
        def mutate(alias, change):
            try:
                cache._mutate_manifest(alias, change)
            except BaseException as exc:
                errors.append(exc)
        first = threading.Thread(target=mutate, args=('film.mkv', first_change))
        second = threading.Thread(target=mutate, args=('./film.mkv', second_change))
        first.start()
        try:
            self.assertTrue(first_inside.wait(2))
            second.start()
            self.assertFalse(second_inside.wait(0.05))
        finally:
            let_first_finish.set()
            first.join(3)
            if second.ident is not None:
                second.join(3)
        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(set(cache._load_manifest('film.mkv')['entries']), {'one', 'two'})

    def test_external_sync_restarts_stale_manifest_but_reuses_live_worker(self):
        rel = 'film.mkv'
        (self.root / rel).write_bytes(b'film')
        text = '1\n00:00:01,000 --> 00:00:02,000\nHello\n'
        fp = cache.subsync.fingerprint_srt(text)
        def syncing(manifest):
            manifest['entries'][fp] = {'state': 'syncing', 'attempts': 1}
        cache._mutate_manifest(rel, syncing)
        for dead_job in (None, {'thread': mock.Mock(is_alive=lambda: False)}):
            cache._SYNC_JOBS.clear()
            if dead_job:
                cache._SYNC_JOBS[rel] = dead_job
            with mock.patch.object(cache.threading, 'Thread') as worker:
                result = cache.subs_start_sync(rel, text)
                self.assertEqual(result['state'], 'syncing')
                worker.assert_called_once()
                worker.return_value.start.assert_called_once()
            attempts = cache._load_manifest(rel)['entries'][fp]['attempts']
            with mock.patch.object(cache.threading, 'Thread') as worker:
                cache.subs_start_sync(rel, text)
                worker.assert_not_called()
            self.assertEqual(cache._load_manifest(rel)['entries'][fp]['attempts'], attempts)

    def test_explicit_non_english_tracks_never_block_fallback(self):
        for tracks in ([{'index': 1, 'lang': 'fra'}],
                       [{'index': 1, 'lang': 'eng'}, {'index': 2, 'lang': 'fr'}]):
            with self.subTest(tracks=tracks):
                rel = 'film%d.mkv' % len(tracks)
                (self.root / rel).write_bytes(b'film')
                # Even a very large foreign track must not be extracted.
                with mock.patch.object(cache.subsync, 'probe_embedded_text_tracks', return_value=tracks), \
                        mock.patch.object(cache.subsync, 'extract_text_subtitle', return_value=False) as extract:
                    cache._run_embedded_job(rel)
                self.assertEqual(extract.call_count, len(tracks) - 1)
                self.assertTrue(all(call.args[1] == 1 for call in extract.call_args_list))
                state = cache._load_manifest(rel)
                self.assertTrue(state['embedded_checked'])
                self.assertFalse(state['embedded_found'])
                self.assertFalse(state.get('active_fp'))

    def test_english_and_unknown_tracks_remain_eligible_after_foreign_filter(self):
        for index, language in enumerate(('eng', 'en', 'en-US', 'und', 'unk',
                                          'unknown', ' Unknown ', None)):
            with self.subTest(language=language):
                rel = 'language%d.mkv' % index
                (self.root / rel).write_bytes(b'film')
                tracks = [{'index': i, 'lang': 'fra'} for i in range(4)]
                tracks.append({'index': 4, 'lang': language})
                with mock.patch.object(cache.subsync, 'probe_embedded_text_tracks', return_value=tracks), \
                        mock.patch.object(cache.subsync, 'extract_text_subtitle', return_value=False) as extract:
                    cache._run_embedded_job(rel)
                self.assertEqual([call.args[1] for call in extract.call_args_list], [4])

    def test_unknown_language_track_can_become_active_subtitle(self):
        rel = 'film.mkv'
        (self.root / rel).write_bytes(b'film')
        text = '1\n00:00:01,000 --> 00:00:02,000\nHello\n'
        def extract(_local, _index, target, **_kwargs):
            Path(target).write_text(text)
            return True
        with mock.patch.object(cache, '_MIN_FULL_SUB_CUES', 1), \
                mock.patch.object(cache.subsync, 'probe_embedded_text_tracks',
                                  return_value=[{'index': 1, 'lang': 'unknown'}]), \
                mock.patch.object(cache.subsync, 'extract_text_subtitle', side_effect=extract), \
                mock.patch.object(cache.subsync, 'ffsubsync_available', return_value=False), \
                mock.patch.object(cache.subsync, 'whisper_available', return_value=False), \
                mock.patch.object(cache.subsync, 'measure_offset_silencedetect', return_value=None):
            cache._run_embedded_job(rel)
        manifest = cache._load_manifest(rel)
        self.assertTrue(manifest['embedded_found'])
        self.assertEqual(cache.subs_state(rel)['state'], 'embedded_pending')
        self.assertIsNotNone(cache.subs_baked_target(rel))


if __name__ == '__main__':
    unittest.main()
