"""Torrent import, staging floor and pause/publication regression tests."""
import os
import pathlib
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

_ROOT = tempfile.TemporaryDirectory()
os.environ['DUMIFLIX_CACHE_ROOT'] = _ROOT.name
os.environ['DUMIFLIX_LOG_DIR'] = _ROOT.name
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import torrent


class TorrentRegressionTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = pathlib.Path(tmp.name)
        self.cache = self.root / 'cache'
        self.cache.mkdir()
        self.staging_root = self.root / 'staging'
        self.staging = self.staging_root / 'job'
        self.staging.mkdir(parents=True)
        self.job = dict(id='job', state='queued', name='Show', source='magnet:?xt=test',
                        staging=str(self.staging), rel=None, rels=[], proc=None,
                        received=0, total=0, progress=0, error=None, _cancel=False)
        patches = [
            mock.patch.object(torrent.cache, 'CACHE_ROOT', self.cache),
            mock.patch.object(torrent.cache, '_HASH_NAMES', False),
            mock.patch.object(torrent.cache, 'record_name'),
            mock.patch.object(torrent.cache, 'maybe_generate_sub'),
            mock.patch.object(torrent, 'STAGING_ROOT', self.staging_root),
            mock.patch.object(torrent, 'MIN_VIDEO_BYTES', 1),
            mock.patch.object(torrent, '_required_mount_ready', return_value=True),
            mock.patch.object(torrent, '_staging_is_same_fs_as_cache', return_value=True),
            mock.patch.object(torrent, '_JOBS', {'job': self.job}),
            mock.patch.object(torrent, '_GLOBAL_PAUSED', threading.Event()),
            mock.patch.object(torrent, '_stdout_reader'),
            mock.patch.object(torrent, '_watchdog'),
        ]
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    def episode(self, name='S01E01.mkv', data=b'episode'):
        path = self.staging / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def proc(self):
        proc = mock.Mock(returncode=0)
        proc.poll.return_value = 0
        proc.wait.return_value = 0
        return proc

    def run_job(self):
        with mock.patch.object(torrent, '_resolve_aria2', return_value='aria2c'), \
                mock.patch.object(torrent, '_fetch_metadata_torrent', return_value=None), \
                mock.patch.object(torrent.subprocess, 'Popen', return_value=self.proc()):
            torrent._run_job('job')

    def run_sequential(self, free, import_result='actual'):
        file = {'index': 1, 'path': 'S01E01.mkv', 'size': 7}
        with mock.patch.object(torrent, '_staging_free_bytes', return_value=free), \
                mock.patch.object(torrent.subprocess, 'Popen', return_value=self.proc()) as spawn:
            if import_result == 'actual':
                torrent._run_sequential_files('job', self.job, 'aria2c', self.staging / 'x.torrent',
                                              self.staging, [file])
            else:
                with mock.patch.object(torrent, '_import_one_file', return_value=None):
                    torrent._run_sequential_files('job', self.job, 'aria2c', self.staging / 'x.torrent',
                                                  self.staging, [file])
            return spawn.call_count

    def test_readable_name_kept_and_other_show_cannot_overwrite_it(self):
        first = torrent._import_one_file('show1', self.episode(data=b'first'), self.staging)
        second = torrent._import_one_file('show2', self.episode(data=b'second'), self.staging)
        self.assertEqual(first['rel'], 'S01E01.mkv')
        self.assertNotEqual(second['rel'], first['rel'])
        self.assertTrue(second['rel'].startswith('S01E01_'))
        self.assertEqual((self.cache / first['rel']).read_bytes(), b'first')
        self.assertEqual((self.cache / second['rel']).read_bytes(), b'second')
        self.assertEqual(second['name'], 'S01E01.mkv')
        torrent.cache.record_name.assert_called_with(second['rel'], 'S01E01.mkv')

    def test_existing_disambiguated_name_is_also_preserved(self):
        rels = []
        for value in (b'one', b'two', b'three'):
            rels.append(torrent._import_one_file('same-job', self.episode(data=value), self.staging)['rel'])
        self.assertEqual(len(set(rels)), 3)
        self.assertEqual([(self.cache / rel).read_bytes() for rel in rels], [b'one', b'two', b'three'])

    def test_concurrent_same_named_imports_preserve_both_sources(self):
        paths = [self.episode('show1/S01E01.mkv', b'one'), self.episode('show2/S01E01.mkv', b'two')]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda p: torrent._import_one_file('job', p, self.staging), paths))
        self.assertEqual(len({r['rel'] for r in results}), 2)
        self.assertEqual({(self.cache / r['rel']).read_bytes() for r in results}, {b'one', b'two'})

    def test_failed_cross_device_copy_cleans_destination_and_keeps_source(self):
        source = self.episode()

        def failed_move(src, dest):
            pathlib.Path(dest).write_bytes(b'partial')
            raise OSError('disk full')

        with mock.patch.object(torrent, '_staging_is_same_fs_as_cache', return_value=False), \
                mock.patch.object(torrent.shutil, 'disk_usage', return_value=mock.Mock(free=10 ** 15)), \
                mock.patch.object(torrent.shutil, 'move', side_effect=failed_move):
            self.assertIsNone(torrent._import_one_file('job', source, self.staging))
        self.assertEqual(source.read_bytes(), b'episode')
        self.assertEqual(list(self.cache.glob('*.mkv')), [])

    def test_partial_import_reports_failure_and_retains_staging_across_cleanup(self):
        self.episode('S01E01.mkv', b'one')
        failed = self.episode('S01E02.mkv', b'two')
        actual = torrent._import_one_file

        def import_one(jid, path, staging):
            return None if path == failed else actual(jid, path, staging)

        with mock.patch.object(torrent, '_import_one_file', side_effect=import_one):
            self.run_job()
        self.assertEqual(self.job['state'], 'error')
        self.assertEqual(len(self.job['rels']), 1)
        self.assertEqual(torrent.status('job')['importFailures'][0]['path'], failed.name)
        self.assertEqual(failed.read_bytes(), b'two')
        torrent._cleanup_staging(self.staging)
        torrent.cleanup_orphan_staging()
        self.assertEqual(failed.read_bytes(), b'two')
        # A retry imports the remaining file without replacing the prior success.
        results = torrent._import_videos('job', self.staging)
        self.assertEqual(len(results), 2)  # includes the previously imported episode
        self.assertEqual(len(list(self.cache.glob('*.mkv'))), 2)

    def test_retry_uses_original_episode_selection_and_never_imports_leftover_bonus(self):
        self.episode('S01E01.mkv', b'one')
        failed = self.episode('S01E02.mkv', b'two')
        bonus = self.episode('Production diary.mkv', b'bonus')
        actual = torrent._import_one_file

        def import_one(jid, path, staging):
            return None if path == failed else actual(jid, path, staging)

        with mock.patch.object(torrent, '_import_one_file', side_effect=import_one):
            with self.assertRaises(torrent._ImportFailure) as raised:
                torrent._import_videos('job', self.staging)
        self.assertEqual([r['name'] for r in raised.exception.results], ['S01E01.mkv'])
        self.assertEqual(raised.exception.failures[0]['path'], 'S01E02.mkv')
        # Simulate a fresh process by relying only on the persisted plan.
        with mock.patch.object(torrent, '_select_primary_video_rows', side_effect=AssertionError('reselected')):
            results = torrent._import_videos('job', self.staging)
        self.assertEqual([r['name'] for r in results], ['S01E01.mkv', 'S01E02.mkv'])
        self.assertEqual(bonus.read_bytes(), b'bonus')
        self.assertEqual(len(list(self.cache.glob('*.mkv'))), 2)
        torrent._cleanup_staging(self.staging)
        self.assertFalse(self.staging.exists())

    def test_selection_must_be_saved_before_any_file_moves(self):
        source = self.episode()
        with mock.patch.object(torrent, '_write_import_selection', side_effect=OSError('disk full')), \
                mock.patch.object(torrent, '_import_one_file') as move:
            with self.assertRaises(OSError):
                torrent._import_videos('job', self.staging)
            move.assert_not_called()
        torrent._cleanup_staging(self.staging)
        self.assertTrue(source.exists())

    def test_all_imports_failing_keeps_download_instead_of_no_video_cleanup(self):
        failed = self.episode()
        with mock.patch.object(torrent, '_import_one_file', return_value=None):
            self.run_job()
        self.assertEqual(self.job['state'], 'error')
        self.assertEqual(self.job['importFailures'][0]['path'], failed.name)
        self.assertTrue(failed.exists())

    def test_successful_import_marks_ready_and_cleans_staging(self):
        self.episode()
        self.run_job()
        self.assertEqual(self.job['state'], 'ready')
        self.assertFalse(self.staging.exists())
        self.assertEqual((self.cache / self.job['rel']).read_bytes(), b'episode')

    def test_unexpected_import_exception_preserves_staging_for_restart(self):
        source = self.episode()
        with mock.patch.object(torrent, '_import_videos', side_effect=RuntimeError('unexpected')):
            self.run_job()
        torrent.cleanup_orphan_staging()
        self.assertEqual(self.job['state'], 'error')
        self.assertTrue(source.exists())

    def test_import_marker_write_failure_does_not_delete_finished_download(self):
        source = self.episode()
        with mock.patch.object(torrent, '_begin_import', side_effect=OSError('read only')):
            self.run_job()
        self.assertEqual(self.job['state'], 'error')
        self.assertTrue(source.exists())

    def test_collision_guard_also_works_with_legacy_unhashed_cache_naming(self):
        (self.cache / 'S01E01.mkv').write_bytes(b'other show')
        with mock.patch.object(torrent.cache, '_rel_for', return_value='S01E01.mkv'):
            result = torrent._import_one_file('new-show', self.episode(), self.staging)
        self.assertNotEqual(result['rel'], 'S01E01.mkv')
        self.assertEqual((self.cache / 'S01E01.mkv').read_bytes(), b'other show')
        self.assertEqual((self.cache / result['rel']).read_bytes(), b'episode')

    def test_sequential_failed_import_keeps_file_for_retry(self):
        source = self.episode()
        self.run_sequential(10 ** 15, import_result='fail')
        self.assertEqual(self.job['state'], 'error')
        self.assertEqual(self.job['importFailures'][0]['path'], source.name)
        torrent.cleanup_orphan_staging()
        self.assertTrue(source.exists())

    def test_sequential_uses_staging_floor_with_larger_cache_floor(self):
        self.episode()
        floor = torrent.STAGING_FREE_FLOOR_BYTES
        with mock.patch.object(torrent.cache, 'FREE_FLOOR_BYTES', floor * 4):
            self.assertEqual(self.run_sequential(floor + 7), 1)
        self.assertEqual(self.job['state'], 'ready')

    def test_sequential_rejects_staging_floor_breach_even_with_smaller_cache_floor(self):
        with mock.patch.object(torrent.cache, 'FREE_FLOOR_BYTES', 0):
            self.assertEqual(self.run_sequential(torrent.STAGING_FREE_FLOOR_BYTES + 6), 0)
        self.assertEqual(self.job['state'], 'error')
        self.assertIn('insufficient staging space', self.job['error'])

    def test_child_published_while_paused_is_resumed(self):
        self.job['state'] = 'metadata'
        child = self.proc()
        with mock.patch.object(torrent, '_pause_proc', return_value=True) as pause, \
                mock.patch.object(torrent, '_resume_proc', return_value=True) as resume:
            torrent.pause_all()
            torrent._publish_proc(self.job, child)
            pause.assert_called_with(child)
            torrent.resume_all()
            resume.assert_called_with(child)
        self.assertFalse(self.job['paused'])

    def test_child_publication_during_resume_cannot_use_stale_pause_flag(self):
        self.job['state'] = 'downloading'
        old_child, new_child = self.proc(), self.proc()
        self.job['proc'] = old_child
        torrent._GLOBAL_PAUSED.set()
        started = threading.Event()
        published = threading.Event()

        def publish():
            started.set()
            torrent._publish_proc(self.job, new_child)
            published.set()

        worker = threading.Thread(target=publish)

        def resume(proc):
            worker.start()
            self.assertTrue(started.wait(2))
            self.assertFalse(published.wait(0.05))
            return True

        with mock.patch.object(torrent, '_pause_proc') as pause, \
                mock.patch.object(torrent, '_resume_proc', side_effect=resume):
            try:
                torrent.resume_all()
            finally:
                worker.join(2)
            self.assertFalse(worker.is_alive())
            self.assertTrue(published.is_set())
            pause.assert_not_called()
        self.assertIs(self.job['proc'], new_child)
        self.assertFalse(self.job['paused'])
        self.assertFalse(torrent._GLOBAL_PAUSED.is_set())


if __name__ == '__main__':
    unittest.main()
