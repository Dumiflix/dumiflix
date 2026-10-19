import os
import pathlib
import sys
import tempfile
import unittest

_ROOT = tempfile.TemporaryDirectory()
os.environ['DUMIFLIX_CACHE_ROOT'] = _ROOT.name
os.environ.pop('DUMIFLIX_TORRENT_STAGING', None)
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
staging = pathlib.Path(_ROOT.name) / '.torrents'
(staging / 'dashboard' / 'Show.S08').mkdir(parents=True)
(staging / 'dashboard' / 'Show.S08' / 'episode.mkv').write_bytes(b'in progress')
(staging / '0123456789abcdef').mkdir()

import torrent  # noqa: E402  (import must not sweep staging)

AFTER_IMPORT = ((staging / '0123456789abcdef').is_dir(),
                (staging / 'dashboard' / 'Show.S08' / 'episode.mkv').is_file())


class StagingCleanupTests(unittest.TestCase):
    def test_import_does_not_sweep_staging(self):
        self.assertEqual(AFTER_IMPORT, (True, True))

    def test_cleanup_keeps_dashboard_downloads(self):
        torrent.cleanup_orphan_staging()
        self.assertFalse((staging / '0123456789abcdef').exists())
        self.assertTrue((staging / 'dashboard' / 'Show.S08' / 'episode.mkv').is_file())


if __name__ == '__main__':
    unittest.main()
