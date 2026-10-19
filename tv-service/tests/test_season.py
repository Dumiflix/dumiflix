"""Season queue admission, cancellation and completed-file regressions."""
import contextlib
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
import season
import torrent as torrent_backend


class SeasonRegressionTests(unittest.TestCase):
    def setUp(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.root = Path(root.name)
        patches = contextlib.ExitStack()
        self.addCleanup(patches.close)
        patches.enter_context(mock.patch.object(season.cache, 'CACHE_ROOT', self.root))
        patches.enter_context(mock.patch.object(season, '_STATE', {'version': 1, 'items': []}))
        patches.enter_context(mock.patch.object(season, '_stop', threading.Event()))
        patches.enter_context(mock.patch.object(season, '_wake', threading.Event()))
        patches.enter_context(mock.patch.object(season, 'torrent', mock.Mock()))
        patches.enter_context(mock.patch.dict(os.environ, {'DUMIFLIX_TORRENT_ENABLED': '1'}))
        patches.enter_context(mock.patch.object(season, '_have_room_for', return_value=True))

    def enqueue(self, kind='url', name='Show.S01E01.mkv', replace=False):
        season.enqueue([{'kind': kind, 'name': name, 'source': 'test-source', 'bytes': 7}],
                       replace=replace)
        return season._STATE['items'][-1]

    def persisted(self):
        return json.loads(season._state_path().read_text())['items']

    def test_busy_producers_back_off_without_adopting_manual_job(self):
        for kind in ('url', 'magnet'):
            with self.subTest(kind=kind):
                season.clear()
                item = self.enqueue(kind)
                with mock.patch.object(season.cache, 'reserve') as reserve, \
                        mock.patch.object(season.threading, 'Thread') as writer:
                    producer = season.torrent.add if kind == 'magnet' else reserve
                    producer.return_value = {'ok': False, 'state': 'busy', 'error': 'busy',
                                             'id': 'unrelated-manual-job'}
                    producer.reset_mock()
                    season._tick()
                    self.assertEqual(item['state'], 'queued')
                    self.assertIsNone(item['jobId'])
                    self.assertGreater(item['notBefore'], item['updatedAt'])
                    self.assertEqual(self.persisted()[0]['state'], 'queued')
                    season._tick()
                    producer.assert_called_once()
                    writer.assert_not_called()

    def test_refused_producers_report_error_even_with_job_id(self):
        for kind in ('url', 'magnet'):
            with self.subTest(kind=kind):
                season.clear()
                item = self.enqueue(kind)
                with mock.patch.object(season.cache, 'reserve') as reserve, \
                        mock.patch.object(season.threading, 'Thread') as writer:
                    producer = season.torrent.add if kind == 'magnet' else reserve
                    producer.return_value = {'ok': False, 'status': 507,
                                             'error': 'insufficient free disk', 'id': 'other'}
                    season._tick()
                    self.assertEqual(item['state'], 'error')
                    self.assertIsNone(item['jobId'])
                    self.assertIn('insufficient free disk', item['error'])
                    writer.assert_not_called()

    def test_only_started_url_reservations_start_a_writer(self):
        for state in ('started', 'ready', 'downloading'):
            with self.subTest(state=state), \
                    mock.patch.object(season.cache, 'reserve', return_value={
                        'ok': True, 'id': 'own-job', 'state': state}), \
                    mock.patch.object(season.threading, 'Thread') as writer:
                item = self.enqueue(name=state + '.mkv')
                self.assertEqual(season._dispatch(item), 'own-job')
                if state == 'started':
                    writer.assert_called_once_with(target=season.cache.cache_download,
                                                  args=('own-job',), daemon=True,
                                                  name='season-fetch-own-job')
                    writer.return_value.start.assert_called_once()
                else:
                    writer.assert_not_called()

    def test_missing_job_id_is_an_error_without_writer(self):
        item = self.enqueue()
        with mock.patch.object(season.cache, 'reserve', return_value={
                'ok': True, 'state': 'started'}), \
                mock.patch.object(season.threading, 'Thread') as writer:
            season._tick()
            self.assertEqual(item['state'], 'error')
            self.assertIn('no job id', item['error'])
            writer.assert_not_called()

    def test_local_torrents_still_require_explicit_opt_in(self):
        for value in ('0', '', 'true'):
            with self.subTest(value=value), \
                    mock.patch.dict(os.environ, {'DUMIFLIX_TORRENT_ENABLED': value}):
                item = self.enqueue('magnet', name=value + '.mkv')
                with self.assertRaisesRegex(RuntimeError, 'local torrents are disabled'):
                    season._dispatch(item)
        season.torrent.add.assert_not_called()

    def run_blocked_tick(self, target, action, result):
        entered, release = threading.Event(), threading.Event()
        errors = []

        def blocked(*args):
            entered.set()
            if not release.wait(5):
                raise RuntimeError('test did not release worker')
            return result

        def tick():
            try:
                season._tick()
            except BaseException as exc:
                errors.append(exc)

        with mock.patch.object(season, target, side_effect=blocked) as operation:
            worker = threading.Thread(target=tick)
            worker.start()
            try:
                self.assertTrue(entered.wait(5), 'worker did not reach barrier')
                action(operation)
            finally:
                release.set()
                worker.join(5)
            self.assertFalse(worker.is_alive(), 'worker did not finish')
            self.assertEqual(errors, [])

    def test_clear_and_replace_cancel_claim_before_dispatch(self):
        for replace in (False, True):
            with self.subTest(replace=replace):
                season.clear()
                item = self.enqueue()

                def cancel(operation):
                    self.assertEqual(item['state'], 'claimed')
                    self.assertEqual(self.persisted()[0]['state'], 'claimed')
                    season._tick()  # A second tick cannot claim the same item.
                    operation.assert_called_once()
                    if replace:
                        self.enqueue(name='Replacement.mkv', replace=True)
                    else:
                        self.assertEqual(season.clear()['removed'], 1)

                with mock.patch.object(season, '_dispatch') as dispatch:
                    self.run_blocked_tick('_have_room_for', cancel, True)
                    dispatch.assert_not_called()
                self.assertNotIn(item, season._STATE['items'])
                self.assertNotIn(item['id'], [it['id'] for it in self.persisted()])
                self.assertEqual([it['name'] for it in season._STATE['items']],
                                 ['Replacement.mkv'] if replace else [])

    def test_clear_and_replace_retain_committed_dispatch_until_job_recorded(self):
        for replace in (False, True):
            with self.subTest(replace=replace):
                season._STATE['items'] = []
                item = self.enqueue()

                def clear(operation):
                    self.assertEqual(item['state'], 'active')
                    self.assertIsNone(item['jobId'])
                    season._tick()  # Reservation in flight is not a lost job.
                    operation.assert_called_once()
                    if replace:
                        self.enqueue(name='Replacement.mkv', replace=True)
                    else:
                        self.assertEqual(season.clear()['removed'], 0)

                self.run_blocked_tick('_dispatch', clear, 'own-job')
                self.assertIs(season._STATE['items'][0], item)
                self.assertEqual(item['jobId'], 'own-job')
                self.assertEqual(self.persisted()[0]['jobId'], 'own-job')

    def test_shutdown_cancels_preparation_without_losing_queue_item(self):
        item = self.enqueue()
        with mock.patch.object(season, '_dispatch') as dispatch:
            self.run_blocked_tick('_have_room_for', lambda _: season.shutdown(), True)
            dispatch.assert_not_called()
        self.assertEqual(item['state'], 'queued')
        self.assertEqual(self.persisted()[0]['state'], 'queued')

    def test_preparation_error_does_not_leave_claim_stuck(self):
        item = self.enqueue()
        with mock.patch.object(season, '_existing_rel_for', side_effect=OSError('disk error')):
            season._tick()
        self.assertEqual(item['state'], 'error')
        self.assertIn('disk error', item['error'])

    def test_no_space_requeues_claim_with_backoff(self):
        item = self.enqueue()
        with mock.patch.object(season, '_have_room_for', return_value=False), \
                mock.patch.object(season, '_dispatch') as dispatch:
            season._tick()
            dispatch.assert_not_called()
        self.assertEqual(item['state'], 'queued')
        self.assertGreater(item['notBefore'], item['updatedAt'])

    def test_restart_requeues_claimed_and_active_items(self):
        claimed = self.enqueue(name='claimed.mkv')
        active = self.enqueue(name='active.mkv')
        claimed['state'] = 'claimed'
        active.update(state='active', jobId='old-job')
        season._save_locked()
        season._load()
        self.assertEqual([it['state'] for it in season._STATE['items']], ['queued', 'queued'])
        self.assertEqual([it['jobId'] for it in season._STATE['items']], [None, None])

    def test_hashed_completed_episode_is_found_after_restart(self):
        for index_entry in ('Show.S01E01.mkv',
                            {'name': 'Show.S01E01.mkv', 'file_id': 'pack-id'}):
            with self.subTest(index_entry=index_entry):
                season.clear()
                rel = '0123456789abcdef01234567.mkv'
                (self.root / rel).write_bytes(b'episode')
                (self.root / '.names.json').write_text(json.dumps({rel: index_entry}))
                self.enqueue()
                season._load()  # No live producer registry is needed.
                with mock.patch.object(season, '_dispatch') as dispatch:
                    season._tick()
                    dispatch.assert_not_called()
                item = season._STATE['items'][0]
                self.assertEqual((item['state'], item['rel']), ('ready', rel))
                self.assertIn(rel, season.protected_rels())

    def test_names_index_does_not_make_partial_empty_or_missing_files_complete(self):
        for rel in ('empty.mkv', 'missing.mkv', 'download.mkv.part', '.torrents/staged.mkv'):
            with self.subTest(rel=rel):
                path = self.root / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                if rel != 'missing.mkv':
                    path.write_bytes(b'' if rel == 'empty.mkv' else b'partial')
                (self.root / '.names.json').write_text(json.dumps({rel: 'Show.S01E01.mkv'}))
                self.assertIsNone(season._existing_rel_for('Show.S01E01.mkv'))

    def test_readable_unindexed_name_still_matches(self):
        (self.root / 'Show.S01E01.mkv').write_bytes(b'episode')
        self.assertEqual(season._existing_rel_for('Show.S01E01.mkv'), 'Show.S01E01.mkv')

    def test_cross_drive_import_prefix_is_not_ready_even_after_reload(self):
        for name in ('Show?.S01E01.mkv', 'x' * 125 + '.mkv', 'Show.S01E01.mkv'):
            with self.subTest(name=name), contextlib.ExitStack() as patches:
                season.clear()
                item = self.enqueue(name=name)
                staging = self.root / '.staging' / 'import-job'
                staging.mkdir(parents=True, exist_ok=True)
                source = staging / name
                source.write_bytes(b'abcdefghijkl')
                patches.enter_context(mock.patch.object(season, 'torrent', torrent_backend))
                patches.enter_context(mock.patch.object(torrent_backend, 'STAGING_ROOT', staging.parent))
                patches.enter_context(mock.patch.object(torrent_backend, '_JOBS', {}))
                patches.enter_context(mock.patch.object(torrent_backend, '_staging_is_same_fs_as_cache',
                                                        return_value=False))
                patches.enter_context(mock.patch.object(season.cache, '_HASH_NAMES', False))
                patches.enter_context(mock.patch.object(season.cache, 'FREE_FLOOR_BYTES', 0))
                patches.enter_context(mock.patch.object(season.cache, 'listing_invalidate'))
                patches.enter_context(mock.patch.object(season.cache, 'reserve', return_value={
                    'ok': False, 'state': 'busy', 'error': 'busy', 'id': 'manual-job'}))

                def fail_copy(src, dest):
                    Path(dest).write_bytes(Path(src).read_bytes()[:4])
                    self.assertIsNone(season._existing_rel_for(name))
                    season._tick()
                    self.assertEqual(item['state'], 'queued')
                    self.assertIsNone(item['jobId'])
                    season._load()  # Completion must not depend on job memory.
                    self.assertEqual(season._STATE['items'][0]['state'], 'queued')
                    self.assertIsNone(season._existing_rel_for(name))
                    raise OSError('copy failed')

                patches.enter_context(mock.patch.object(torrent_backend.shutil, 'move',
                                                        side_effect=fail_copy))
                self.assertIsNone(torrent_backend._import_one_file('import-job', source, staging))
                self.assertTrue(source.exists())
                self.assertIsNone(season._existing_rel_for(name))
                pending = season._STATE['items'][0]
                pending['notBefore'] = 0
                with mock.patch.object(season, '_dispatch', return_value='episode-job') as dispatch:
                    season._tick()
                    dispatch.assert_called_once()
                self.assertEqual((pending['state'], pending['jobId']), ('active', 'episode-job'))
                season._STATE['items'] = []

    def test_readable_import_becomes_ready_only_after_source_removed(self):
        name = 'Show?.S01E01.mkv'
        item = self.enqueue(name=name)
        staging = self.root / '.staging' / 'import-job'
        staging.mkdir(parents=True)
        source = staging / name
        source.write_bytes(b'abcdefghijkl')

        def copy(src, dest):
            Path(dest).write_bytes(Path(src).read_bytes())
            # Even a full-size destination can still fail during metadata copy.
            self.assertIsNone(season._existing_rel_for(name))
            Path(src).unlink()
            return dest

        with mock.patch.object(season, 'torrent', torrent_backend), \
                mock.patch.object(torrent_backend, 'STAGING_ROOT', staging.parent), \
                mock.patch.object(torrent_backend, '_staging_is_same_fs_as_cache', return_value=False), \
                mock.patch.object(torrent_backend.shutil, 'move', side_effect=copy), \
                mock.patch.object(season.cache, '_HASH_NAMES', False), \
                mock.patch.object(season.cache, 'FREE_FLOOR_BYTES', 0), \
                mock.patch.object(season.cache, 'listing_invalidate'), \
                mock.patch.object(season.cache, 'maybe_generate_sub'), \
                mock.patch.object(season, '_dispatch') as dispatch:
            result = torrent_backend._import_one_file('import-job', source, staging)
            self.assertEqual(season._existing_rel_for(name), result['rel'])
            season._tick()
            dispatch.assert_not_called()
            self.assertEqual((item['state'], item['rel']), ('ready', result['rel']))
            season._load()
            self.assertEqual(season._STATE['items'][0]['state'], 'ready')

    def test_import_owner_published_during_inventory_is_checked(self):
        name = 'Show?.S01E01.mkv'
        source = self.root / '.staging' / 'import-job' / name
        source.parent.mkdir(parents=True)
        source.write_bytes(b'abcdefghijkl')
        dest = self.root / 'Show.S01E01.mkv'

        def inventory():
            season.cache.record_name(dest.name, name, 'import-job/' + name)
            dest.write_bytes(b'abcd')
            return [(dest, 4, dest.stat().st_mtime)]

        with mock.patch.object(season, 'torrent', torrent_backend), \
                mock.patch.object(torrent_backend, 'STAGING_ROOT', source.parent.parent), \
                mock.patch.object(season.cache, 'listing_invalidate'), \
                mock.patch.object(season.cache, 'cache_files', side_effect=inventory):
            self.assertIsNone(season._existing_rel_for(name))

    def test_interrupted_import_keeps_completion_unproven_after_startup_cleanup(self):
        name = 'Show?.S01E01.mkv'
        self.enqueue(name=name)
        staging = self.root / '.staging' / 'import-job'
        staging.mkdir(parents=True)
        source = staging / name
        source.write_bytes(b'abcdefghijkl')
        torrent_backend._begin_import(staging)
        with mock.patch.object(season, 'torrent', torrent_backend), \
                mock.patch.object(torrent_backend, 'STAGING_ROOT', staging.parent), \
                mock.patch.object(torrent_backend, '_required_mount_ready', return_value=True), \
                mock.patch.object(torrent_backend, '_JOBS', {}), \
                mock.patch.object(season.cache, '_HASH_NAMES', False), \
                mock.patch.object(season.cache, 'listing_invalidate'):
            rel = season.cache._rel_for('import-job/' + name, name)
            (self.root / rel).write_bytes(b'abcd')  # Interrupted cross-drive copy.
            season._load()
            torrent_backend.cleanup_orphan_staging()
            self.assertTrue(source.exists())
            self.assertIsNone(season._existing_rel_for(name))
            self.assertEqual(season._STATE['items'][0]['state'], 'queued')

    def test_reload_requeues_missing_and_empty_ready_files(self):
        for contents in (None, b''):
            with self.subTest(contents=contents):
                season._STATE['items'] = []
                item = self.enqueue()
                rel = 'missing-or-empty.mkv'
                if contents is not None:
                    (self.root / rel).write_bytes(contents)
                item.update(state='ready', rel=rel, jobId='old-job', notBefore=123)
                season._save_locked()
                season._load()
                pending = season._STATE['items'][0]
                self.assertEqual(pending['state'], 'queued')
                self.assertIsNone(pending['rel'])
                self.assertIsNone(pending['jobId'])
                self.assertEqual(pending['notBefore'], 0)


if __name__ == '__main__':
    unittest.main()
