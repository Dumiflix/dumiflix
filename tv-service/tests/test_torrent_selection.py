import pathlib
import sys
import unittest


sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import torrent


class TorrentVideoSelectionTests(unittest.TestCase):
    def test_season_pack_keeps_episode_files_and_drops_bonus_disc_videos(self):
        rows = [
            {'path': 'Show S02E01 Main.mkv', 'size': 3_000_000_000},
            {'path': 'Show S02E02 Main.mkv', 'size': 3_100_000_000},
            {'path': 'Episode 1 Extended Version.mkv', 'size': 580_000_000},
            {'path': 'Short Bonus Clip.mkv', 'size': 110_000_000},
        ]
        selected = torrent._select_primary_video_rows(rows)
        self.assertEqual([row['path'] for row in selected], [
            'Show S02E01 Main.mkv',
            'Show S02E02 Main.mkv',
        ])

    def test_standalone_movie_and_nonstandard_episode_names_are_preserved(self):
        movie = [{'path': 'The Invitation (2015).mkv', 'size': 1_000_000_000}]
        self.assertEqual(torrent._select_primary_video_rows(movie), movie)

        anime = [
            {'path': 'Show - 01.mkv', 'size': 900_000_000},
            {'path': 'Show - 02.mkv', 'size': 900_000_000},
        ]
        self.assertEqual(torrent._select_primary_video_rows(anime), anime)

    def test_obvious_sample_is_filtered_even_without_episode_tags(self):
        rows = [
            {'path': 'Movie.mkv', 'size': 2_000_000_000},
            {'path': 'sample.mkv', 'size': 200_000_000},
        ]
        self.assertEqual(torrent._select_primary_video_rows(rows), [rows[0]])


if __name__ == '__main__':
    unittest.main()
