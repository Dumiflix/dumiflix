"""Cache ownership, reader-registration and admission regressions."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
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


class CacheReviewTests(unittest.TestCase):
    def setUp(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.root = Path(root.name)
        patches = contextlib.ExitStack()
        self.addCleanup(patches.close)
        for name, value in (
            ('CACHE_ROOT', self.root), ('_HASH_NAMES', False),
            ('_JOBS', {}), ('_active_job_id', None), ('_holds', {}),
            ('FREE_FLOOR_BYTES', 0), ('HARD_CAP_BYTES', 100),
            ('_free_bytes', lambda: 10000), ('listing_invalidate', lambda: None),
            ('maybe_generate_sub', lambda _rel: None),
            ('_protect_rel', lambda: None), ('_provider_protected_rels', lambda: []),
        ):
            patches.enter_context(mock.patch.object(cache, name, value))

    def complete(self, file_id, name, content=b'content!'):
        result = cache.reserve(file_id, name, 'http://example.invalid/file', len(content))
        self.assertTrue(result['ok'], result)
        (self.root / result['rel']).write_bytes(content)
        cache._JOBS[result['id']]['state'] = 'ready'
        cache._active_job_id = None
        return result['rel']

    def test_same_casefolded_and_truncated_names_have_distinct_owners(self):
        for first, second in (
            ('movie.mkv', 'movie.mkv'), ('Episode.mkv', 'episode.MKV'),
            ('x' * 125 + 'a.mkv', 'x' * 125 + 'b.mkv'),
            ('unsafe?.mkv', 'unsafe*.mkv'),
        ):
            with self.subTest(first=first, second=second):
                one_id, two_id = 'one-' + first, 'two-' + second
                one = self.complete(one_id, first)
                # A different title: same name, different byte size.
                two = self.complete(two_id, second, b'other content')
                self.assertNotEqual(one.casefold(), two.casefold())
                self.assertEqual(one, cache._sanitize_name(first, one_id))
                self.assertIn(hashlib.sha256(two_id.encode()).hexdigest()[:12], two)
                self.assertEqual(cache.display_name(one), first)
                self.assertEqual(cache.display_name(two), second)
                # Simulate restart: ownership must survive without job memory.
                cache._JOBS.clear()
                for file_id, name, rel in ((one_id, first, one), (two_id, second, two)):
                    result = cache.reserve(file_id, name, 'http://example.invalid/file', 8)
                    self.assertEqual(result['state'], 'ready')
                    self.assertEqual(result['rel'], rel)
                self.assertEqual((self.root / one).read_bytes(), b'content!')

    def test_legacy_names_keep_paths_and_gain_owner_on_first_lookup(self):
        rel = 'Legacy Movie.mkv'
        (self.root / rel).write_bytes(b'legacy')
        cache._names_path().write_text(json.dumps({rel: 'Legacy Movie.mkv'}))
        result = cache.reserve('legacy-id', 'Legacy Movie.mkv', 'http://example.invalid/file', 6)
        self.assertEqual(result['state'], 'ready')
        self.assertEqual(result['rel'], rel)
        other = cache.reserve('different-id', 'Legacy Movie.mkv', 'http://example.invalid/file', 7)
        self.assertEqual(other['state'], 'started')
        self.assertNotEqual(other['rel'], rel)
        cache.record_name(rel, 'Display update.mkv')  # old callers omit file id
        self.assertEqual(cache.display_name(rel), 'Display update.mkv')
        self.assertEqual(cache._rel_for('legacy-id', 'Legacy Movie.mkv'), rel)
        self.assertEqual((self.root / rel).read_bytes(), b'legacy')

    def test_same_title_from_a_new_seedr_id_reuses_the_existing_copy(self):
        # Seedr replays hand the same movie over under a new file id each time.
        first = self.complete('seedr-old', 'Movie.2026.1080p.mp4', b'same bytes')
        again = cache.reserve('seedr-new', 'Movie.2026.1080p.mp4', 'http://example.invalid/file', len(b'same bytes'))
        self.assertEqual(again['state'], 'ready')
        self.assertEqual(again['rel'], first)
        self.assertEqual(sorted(p.name for p in self.root.iterdir() if p.suffix == '.mp4'), [first])

    def test_unindexed_case_variant_is_adopted_without_rename(self):
        (self.root / 'Movie.MKV').write_bytes(b'legacy')
        result = cache.reserve('legacy', 'movie.mkv', 'http://example.invalid/file', 6)
        self.assertEqual(result['rel'], 'Movie.MKV')
        self.assertEqual(result['state'], 'ready')

    def test_suffix_does_not_overwrite_unowned_existing_file(self):
        self.complete('first', 'movie.mkv')
        suffix = hashlib.sha256(b'second').hexdigest()[:12]
        occupied = self.root / ('movie_' + suffix + '.mkv')
        occupied.write_bytes(b'legacy!')   # unrelated: a different size
        result = cache.reserve('second', 'movie.mkv', 'http://example.invalid/file', 6)
        self.assertNotEqual(result['rel'], occupied.name)
        self.assertEqual(occupied.read_bytes(), b'legacy!')

    def test_prune_preserves_started_and_growing_ownership(self):
        result = cache.reserve('first', 'movie.mkv', 'http://example.invalid/file', 8)
        cache.prune_names([])
        self.assertIn(result['rel'], cache._load_names())
        cache._JOBS.clear()
        (self.root / (result['rel'] + '.part')).write_bytes(b'part')
        cache.prune_names([])
        self.assertIn(result['rel'], cache._load_names())

    def test_hash_names_keep_original_derivation(self):
        with mock.patch.object(cache, '_HASH_NAMES', True):
            self.assertEqual(cache._rel_for('id', 'movie.mkv'),
                             hashlib.sha256(b'id').hexdigest()[:24] + '.mkv')

    def test_eviction_preserves_registered_reader(self):
        target = self.root / 'held.mkv'
        target.write_bytes(b'held')
        cache.hold(target.name)
        try:
            cache.cache_evict(need_bytes=100)
            self.assertTrue(target.exists())
        finally:
            cache.release(target.name)
        cache.cache_evict(need_bytes=100)
        self.assertFalse(target.exists())

    def test_eviction_serializes_unlink_with_reader_registration(self):
        target = self.root / 'old.mkv'
        target.write_bytes(b'old')
        entered, registered = threading.Event(), threading.Event()
        original_unlink = Path.unlink
        reader = None

        def register():
            entered.set()
            cache.hold(target.name)
            registered.set()

        def unlink(path, *args, **kwargs):
            nonlocal reader
            if path == target:
                self.assertTrue(cache._HOLDS_LOCK.locked())
                reader = threading.Thread(target=register)
                reader.start()
                self.assertTrue(entered.wait(1))
                self.assertFalse(registered.wait(0.05))
            return original_unlink(path, *args, **kwargs)

        try:
            with mock.patch.object(Path, 'unlink', unlink):
                cache.cache_evict(need_bytes=100)
        finally:
            if reader:
                reader.join(1)
                self.assertFalse(reader.is_alive())
            cache.release(target.name)
        self.assertTrue(registered.is_set())

    def test_oversized_reservation_never_evicts(self):
        target = self.root / 'old.mkv'
        target.write_bytes(b'old')
        with mock.patch.object(cache, 'cache_evict') as evict:
            result = cache.reserve('large', 'large.mkv', 'http://example.invalid/file', 101)
        self.assertFalse(result['ok'])
        self.assertEqual(result['status'], 507)
        evict.assert_not_called()
        self.assertEqual(target.read_bytes(), b'old')

    def test_oversized_known_or_probed_download_never_evicts(self):
        target = self.root / 'old.mkv'
        target.write_bytes(b'old')
        for initial in (0, 101):
            with self.subTest(initial=initial):
                job = {'path': str(self.root / 'large.mkv'), 'rel': 'large.mkv',
                       'url': 'http://example.invalid/file', 'total': initial}
                cache._JOBS['large'] = job
                cache._active_job_id = 'large'
                with mock.patch.object(cache, '_probe_remote_size', return_value=101), \
                        mock.patch.object(cache, 'cache_evict') as evict:
                    cache.cache_download('large')
                self.assertEqual(job['state'], 'error')
                self.assertIn('cap', job['error'])
                evict.assert_not_called()
                self.assertIsNone(cache._active_job_id)
                self.assertEqual(target.read_bytes(), b'old')
                self.assertFalse((self.root / 'large.mkv.part').exists())


class GrowingReaderLockTests(unittest.TestCase):
    def test_growing_ranges_never_waits_for_busy_writers(self):
        lock = threading.Lock()
        job = {'state': 'downloading', '_io_lock': lock, '_head_end': 8 << 20,
               '_split': 0, '_tail_end': 0, '_index_range': (100 << 20, 101 << 20)}
        lock.acquire()  # a copy lane is mid-write
        try:
            import time
            started = time.monotonic()
            for _ in range(20):
                ranges = cache.growing_ranges(job)
            elapsed = time.monotonic() - started
        finally:
            lock.release()
        self.assertEqual(ranges, [[0, 8 << 20], [100 << 20, 101 << 20]])
        self.assertLess(elapsed, 0.1)


if __name__ == '__main__':
    unittest.main()
