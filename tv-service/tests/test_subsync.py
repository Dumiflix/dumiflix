"""Embedded subtitle extraction regression tests (no ffmpeg installation needed)."""
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

_ROOT = tempfile.TemporaryDirectory()
os.environ['DUMIFLIX_CACHE_ROOT'] = _ROOT.name
os.environ['DUMIFLIX_LOG_DIR'] = _ROOT.name
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import subsync


class SubtitleExtractionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source = pathlib.Path(self.tmp.name) / 'episode.mkv'
        self.source.write_bytes(b'media')
        self.out = pathlib.Path(self.tmp.name) / 'subtitle.srt'
        for name, value in (('FFMPEG_BIN', sys.executable), ('FF_ENV', {}),
                            ('_EXTRACT_FAILURES', {}), ('_EXTRACT_BUSY', set())):
            patcher = mock.patch.object(subsync, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def extract(self, track=5, out=None):
        return subsync.extract_text_subtitle(self.source, track, out or self.out, gentle=False)

    def successful_run(self, args, **kwargs):
        pathlib.Path(args[-1]).write_text('1\n00:00:01,000 --> 00:00:02,000\nHello\n')
        return subprocess.CompletedProcess(args, 0)

    def test_timeout_scales_with_whole_file_size_and_preserves_atomic_output(self):
        with self.source.open('wb') as f:
            f.truncate(8 * 1024 ** 3)  # sparse file, no multi-GB allocation
        with mock.patch.object(subsync.subprocess, 'run', side_effect=self.successful_run) as run:
            self.assertTrue(self.extract())
        self.assertEqual(run.call_args.kwargs['timeout'], 2168.0)
        self.assertTrue(run.call_args.kwargs['check'])
        self.assertIn('Hello', self.out.read_text())
        self.assertFalse(pathlib.Path(str(self.out) + '.part').exists())

    def test_os_failure_defers_all_tracks_until_file_changes(self):
        with mock.patch.object(subsync.subprocess, 'run', side_effect=OSError('busy')) as run:
            deferred = self.extract()
            self.assertFalse(deferred)
            self.assertIsInstance(deferred, subsync.TextSubtitleExtractionDeferred)
            self.assertGreater(deferred.retry_after, subsync.time.time())
            retry = self.extract(track=6, out=self.out.with_name('another.srt'))
            self.assertIsInstance(retry, subsync.TextSubtitleExtractionDeferred)
            self.assertFalse(retry)
            self.assertEqual(run.call_count, 1)
            self.source.write_bytes(b'replaced media')
            self.assertFalse(self.extract())
            self.assertEqual(run.call_count, 2)

    def test_failed_track_does_not_block_healthy_alternative(self):
        failed = subprocess.CalledProcessError(1, ['ffmpeg'])

        def run(args, **kwargs):
            if args[args.index('-map') + 1] == '0:5':
                raise failed
            return self.successful_run(args, **kwargs)

        with mock.patch.object(subsync.subprocess, 'run', side_effect=run) as run:
            self.assertIs(self.extract(track=5), False)
            retry = self.extract(track=5, out=self.out.with_name('another.srt'))
            self.assertIsInstance(retry, subsync.TextSubtitleExtractionDeferred)
            self.assertFalse(retry)
            self.assertEqual(run.call_count, 1)
            self.assertTrue(self.extract(track=6))
            self.assertEqual(run.call_count, 2)
        self.assertIn('Hello', self.out.read_text())

    def test_cache_worker_accepts_healthy_alternative_after_failed_conversion(self):
        import cache

        def run(args, **kwargs):
            if args[args.index('-map') + 1] == '0:5':
                raise subprocess.CalledProcessError(1, args)
            return self.successful_run(args, **kwargs)

        with mock.patch.object(cache, 'CACHE_ROOT', pathlib.Path(self.tmp.name)), \
                mock.patch.object(cache, '_SYNC_JOBS', {}), \
                mock.patch.object(cache, '_MIN_FULL_SUB_CUES', 1), \
                mock.patch.object(subsync, 'probe_embedded_text_tracks', return_value=[
                    {'index': 5}, {'index': 6}]), \
                mock.patch.object(subsync.subprocess, 'run', side_effect=run) as runner, \
                mock.patch.object(subsync, 'ffsubsync_available', return_value=False), \
                mock.patch.object(subsync, 'whisper_available', return_value=False), \
                mock.patch.object(subsync, 'measure_offset_silencedetect', return_value=None):
            cache._run_embedded_job(self.source.name)
            manifest = cache._load_manifest(self.source.name)
        self.assertTrue(manifest['embedded_checked'])
        self.assertTrue(manifest['embedded_found'])
        self.assertEqual(runner.call_count, 2)

    def test_cache_worker_retries_deferred_extraction_later(self):
        import cache

        with mock.patch.object(cache, 'CACHE_ROOT', pathlib.Path(self.tmp.name)), \
                mock.patch.object(cache, '_SYNC_JOBS', {}), \
                mock.patch.object(subsync, 'probe_embedded_text_tracks', return_value=[
                    {'index': 5}, {'index': 6}]), \
                mock.patch.object(subsync.subprocess, 'run', side_effect=OSError('busy')) as runner:
            cache._run_embedded_job(self.source.name)
            manifest = cache._load_manifest(self.source.name)
            # A busy/slow file is not proof the subtitles are absent.
            self.assertFalse(manifest.get('embedded_checked'))
            self.assertGreater(manifest['embedded_retry_after'], subsync.time.time())
            self.assertEqual(runner.call_count, 1)
            # Until the retry gate passes, a new request starts no worker.
            with mock.patch.object(cache, '_safe_resolve', return_value=self.source):
                cache.subs_start_sync(self.source.name)
            self.assertNotIn(self.source.name, cache._SYNC_JOBS)

    def test_cooldown_expires(self):
        with mock.patch.object(subsync.time, 'monotonic', return_value=100), \
                mock.patch.object(subsync.subprocess, 'run', side_effect=OSError('busy')):
            self.assertFalse(self.extract())
        with mock.patch.object(subsync.time, 'monotonic', return_value=100 + 30 * 60), \
                mock.patch.object(subsync.subprocess, 'run', side_effect=self.successful_run) as run:
            self.assertTrue(self.extract())
            self.assertEqual(run.call_count, 1)

    def test_busy_file_does_not_start_another_scan(self):
        entered, release = threading.Event(), threading.Event()
        results = []

        def slow_run(args, **kwargs):
            entered.set()
            if not release.wait(2):
                raise RuntimeError('test worker was not released')
            return self.successful_run(args, **kwargs)

        with mock.patch.object(subsync.subprocess, 'run', side_effect=slow_run) as run:
            worker = threading.Thread(target=lambda: results.append(self.extract()))
            worker.start()
            try:
                self.assertTrue(entered.wait(2))
                deferred = self.extract(track=6)
                self.assertFalse(deferred)
                self.assertIsInstance(deferred, subsync.TextSubtitleExtractionDeferred)
            finally:
                release.set()
                worker.join(2)
            self.assertFalse(worker.is_alive())
            self.assertEqual(results, [True])
            self.assertEqual(run.call_count, 1)

    def run_child(self, code, timeout):
        real_run, real_popen = subprocess.run, subprocess.Popen
        children = []

        def popen(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            children.append(child)
            return child

        def run(args, **kwargs):
            return real_run([sys.executable, '-c', code, args[-1]], **kwargs)

        with mock.patch.object(subsync, '_text_extract_timeout', return_value=timeout), \
                mock.patch.object(subsync.subprocess, 'run', side_effect=run), \
                mock.patch.object(subsync.subprocess, 'Popen', side_effect=popen):
            result = self.extract()
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].poll())
        return result

    def test_timeout_kills_and_reaps_real_child_and_cleans_partial(self):
        self.out.write_text('previous subtitle')
        self.assertFalse(self.run_child(
            'import pathlib,sys,time; pathlib.Path(sys.argv[1]).write_text("partial"); time.sleep(60)',
            timeout=0.3))
        self.assertEqual(self.out.read_text(), 'previous subtitle')
        self.assertFalse(pathlib.Path(str(self.out) + '.part').exists())
        with mock.patch.object(subsync.subprocess, 'run') as run:
            deferred = self.extract(track=6)
            self.assertFalse(deferred)
            self.assertIsInstance(deferred, subsync.TextSubtitleExtractionDeferred)
            run.assert_not_called()

    def test_nonzero_exit_does_not_publish_partial_subtitles(self):
        self.assertFalse(self.run_child(
            'import pathlib,sys; pathlib.Path(sys.argv[1]).write_text("partial"); sys.exit(1)',
            timeout=5))
        self.assertFalse(self.out.exists())
        self.assertFalse(pathlib.Path(str(self.out) + '.part').exists())


if __name__ == '__main__':
    unittest.main()
