"""Offline catalogue verification, scheduling, persistence and HTTP contract tests."""
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import catalog

MOVIE = {'title': 'The Matrix', 'year': 1999, 'kind': 'movie',
         'imdb': 'tt0133093', 'tmdb_id': 603}
HASH = 'a' * 40
CAP = catalog.MAX_BYTES


def setUpModule():
    global _network_guard, _network_attempts
    _network_guard = [mock.patch(name, side_effect=AssertionError('tests must not use the network'))
                      for name in ('socket.create_connection', 'socket.socket.connect', 'socket.getaddrinfo')]
    _network_attempts = [guard.start() for guard in _network_guard]


def tearDownModule():
    for guard in reversed(_network_guard):
        guard.stop()
    assert all(attempt.call_count == 0 for attempt in _network_attempts), 'unexpected network attempts'


def row(name='The.Matrix.1999.1080p.BluRay', **changes):
    value = {'info_hash': HASH, 'name': name, 'size': 2 * 1024 ** 3,
             'seeders': 50}
    value.update(changes)
    return value


def yts(torrents=None, **changes):
    value = {'title': 'The Matrix', 'year': 1999, 'imdb_code': 'tt0133093',
             'torrents': torrents if torrents is not None else [
                 {'hash': HASH, 'quality': '1080p', 'size_bytes': 2 * 1024 ** 3,
                  'seeds': 20, 'type': 'bluray'}]}
    value.update(changes)
    return {'status': 'ok', 'data': {'movies': [value]}}


def knaben(name='The.Matrix.1999.1080p.WEBRip', **changes):
    value = {'hash': HASH, 'title': name, 'bytes': 2 * 1024 ** 3,
             'seeders': 50, 'categoryId': [3001000]}
    value.update(changes)
    return value


def fake_http(rows=(), yts_payload=None, hits=()):
    def fetch(url, json_body=None):
        if 'list_movies' in url:
            return yts_payload if yts_payload is not None else {'status': 'ok', 'data': {}}
        if 'api.knaben.org' in url:
            return {'hits': list(hits)}
        return list(rows)
    return mock.Mock(side_effect=fetch)


class VerificationTests(unittest.TestCase):
    def test_all_bad_release_tags_are_rejected(self):
        for tag in ('CAM', 'CAMRip', 'HDCAM', 'HDTS', 'TS', 'TC', 'HDTC',
                    'TELESYNC', 'TELECINE', 'SCREENER', 'SCR', 'DVDSCR', 'R5',
                    'WORKPRINT', 'HD-CAM', 'DVD.SCR', 'DVDSCREENER', 'HDTSRip',
                    'HDTELESYNC', 'HDCAMRip', 'HDTelecine', 'DVDScreenerRip'):
            with self.subTest(tag=tag):
                self.assertEqual(catalog.verify(MOVIE, CAP, fake_http([
                    row('The.Matrix.1999.1080p.' + tag)])), ('unverified', None))
        self.assertFalse(catalog._is_cam('Ghosts.2025.1080p.WEB'))

    def test_quality_size_seeder_and_hash_rules(self):
        for changes in ({'name': 'The.Matrix.1999.720p'},
                        {'name': 'The.Matrix.1999.1080i'},
                        {'name': 'The.Matrix.1999.1080p.Collection'},
                        {'name': 'The.Matrix.1999.1080p.3.Movie.Pack'},
                        {'name': 'The_Matrix_1999_1080p_Collection'},
                        {'size': catalog.MIN_BYTES - 1}, {'size': CAP + 1},
                        {'seeders': 4}, {'seeders': 'bad'},
                        {'info_hash': '0' * 40}, {'info_hash': 'invalid'}):
            with self.subTest(changes=changes):
                self.assertEqual(catalog.verify(MOVIE, CAP, fake_http([row(**changes)])),
                                 ('unverified', None))
        for size in (catalog.MIN_BYTES, CAP):
            self.assertEqual(catalog.verify(MOVIE, CAP, fake_http([
                row(size=size, seeders='5')]))[0], 'verified')
        for quality in ('1080p', '2160p', '4K', 'UHD'):
            self.assertEqual(catalog.verify(MOVIE, CAP, fake_http([
                row('The.Matrix.1999.' + quality)]))[0], 'verified')

    def test_imdb_overrides_title_but_conflicting_tags_never_pass(self):
        self.assertEqual(catalog.verify(MOVIE, CAP, fake_http([
            row('Localized.Title.1080p', imdb='0133093')]))[0], 'verified')
        self.assertEqual(catalog.verify(MOVIE, CAP, fake_http([
            row(imdb='tt9999999')])), ('unverified', None))
        self.assertEqual(catalog.verify(MOVIE, CAP, fake_http([
            row('The.Matrix.1999.1080p.tt0133093')]))[0], 'verified')
        self.assertEqual(catalog.verify(MOVIE, CAP, fake_http([
            row('The.Matrix.1999.1080p.tt9999999', imdb=MOVIE['imdb'])]))[0], 'unverified')
        self.assertEqual(catalog.verify(MOVIE, CAP, fake_http([
            row('The_Matrix_1999_1080p_tt9999999')]))[0], 'unverified')

    def test_strict_title_and_exact_year(self):
        for name in ('Matrix.1999.1080p', 'The.Matrix.Reloaded.1999.1080p',
                     'The.Matrix.2000.1080p', 'The.Matrix.1998.1080p',
                     'The.Matrix.1080p', 'The.Matrix.2010.1080p.Uploaded.1999',
                     'Another.The.Matrix.1999.1080p', 'The.1999.Matrix.1080p'):
            with self.subTest(name=name):
                self.assertEqual(catalog.verify(MOVIE, CAP, fake_http([row(name)]))[0], 'unverified')
        self.assertEqual(catalog.verify(MOVIE, CAP, fake_http([row()]))[0], 'verified')
        film = dict(MOVIE, title='1917', year=2019, imdb=None)
        self.assertEqual(catalog.verify(film, CAP, fake_http([row('1917.1080p')]))[0], 'unverified')

    def test_missing_year_requires_matching_imdb_evidence(self):
        film = dict(MOVIE, title='The Thing', imdb='tt0084787', year=None)
        for imdb in (film['imdb'], None):
            item = dict(film, imdb=imdb)
            for release_year in (1982, 2011):
                self.assertEqual(catalog.verify(item, CAP, fake_http([
                    row('The.Thing.%d.1080p.BluRay' % release_year)]))[0], 'unverified')
            self.assertEqual(catalog.verify(item, CAP, fake_http([], yts(
                title='The Thing', year=2011, imdb_code='')))[0], 'unverified')
        self.assertEqual(catalog.verify(film, CAP, fake_http([
            row('The.Thing.1982.1080p.BluRay', imdb=film['imdb'])]))[0], 'verified')
        self.assertEqual(catalog.verify(film, CAP, fake_http([], yts(
            title='The Thing', year=1982, imdb_code=film['imdb'])))[0], 'verified')

    def test_source_words_in_title_are_not_source_metadata(self):
        film = dict(MOVIE, title='Cam', year=2018, imdb='tt8361028')
        for source in ('WEB', 'BluRay'):
            for imdb in (film['imdb'], None):
                self.assertEqual(catalog.verify(film, CAP, fake_http([
                    row('Cam.2018.1080p.' + source, imdb=imdb)]))[0], 'verified')
        for tag in ('CAM', 'DVDSCREENER', 'HDTSRip', 'HDTELESYNC'):
            self.assertEqual(catalog.verify(film, CAP, fake_http([
                row('Cam.2018.1080p.' + tag, imdb=film['imdb'])]))[0], 'unverified')
        payload = yts(title='Cam', year=2018, imdb_code=film['imdb'])
        self.assertEqual(catalog.verify(film, CAP, fake_http([], payload))[0], 'verified')
        payload['data']['movies'][0]['torrents'][0]['type'] = 'DVDSCREENER'
        self.assertEqual(catalog.verify(film, CAP, fake_http([], payload))[0], 'unverified')

    def test_yts_preferred_and_best_quality_then_seeders(self):
        torrents = [
            {'hash': 'a' * 40, 'quality': '1080p', 'size_bytes': 2_000_000_000, 'seeds': 500},
            {'hash': 'b' * 40, 'quality': '2160p', 'size_bytes': 4_000_000_000, 'seeds': 8},
            {'hash': 'c' * 40, 'quality': '2160p', 'size_bytes': 4_000_000_000, 'seeds': 10},
            {'hash': 'd' * 40, 'quality': '2160p', 'size_bytes': CAP + 1, 'seeds': 900},
        ]
        http = fake_http([row()], yts(torrents))
        status, best = catalog.verify(MOVIE, CAP, http)
        self.assertEqual((status, best['hash'], best['source']), ('verified', 'c' * 40, 'yts'))
        self.assertEqual(http.call_count, 1)
        self.assertIn('query_term=tt0133093', http.call_args.args[0])
        http = fake_http([], yts(imdb_code='tt9999999'))
        self.assertEqual(catalog.verify(MOVIE, CAP, http)[0], 'unverified')
        http = fake_http([], yts(imdb_code='', title='The Matrix Reloaded'))
        self.assertEqual(catalog.verify(MOVIE, CAP, http)[0], 'unverified')

    def test_yts_mirror_and_apibay_fallback(self):
        http = fake_http([row()], yts(torrents=[]))
        self.assertEqual(catalog.verify(MOVIE, CAP, http)[1]['source'], 'apibay')
        self.assertIn('cat=201', http.call_args_list[-3].args[0])
        self.assertIn('cat=207', http.call_args_list[-2].args[0])
        def mirror(url):
            if catalog.YTS_BASES[0] in url:
                raise OSError('offline')
            return yts()
        self.assertEqual(catalog.verify(MOVIE, CAP, mirror)[1]['source'], 'yts')
        http = fake_http([], yts(imdb_code='', title='The Matrix', year=1999))
        self.assertEqual(catalog.verify(dict(MOVIE, imdb=None), CAP, http)[0], 'verified')
        self.assertIn('query_term=The+Matrix', http.call_args.args[0])

    def test_failed_yts_mirror_does_not_poison_definitive_answers(self):
        def fetch(url, json_body=None):
            if catalog.YTS_BASES[0] in url:
                return {'status': 'ok', 'data': {}}
            if 'apibay.org' in url:
                return []
            raise OSError('offline')
        self.assertEqual(catalog.verify(MOVIE, CAP, fetch), ('unverified', None))

    def test_both_yts_failures_preserve_unknown_result_but_allow_positive(self):
        for hits in ([], [knaben()]):
            def fetch(url, json_body=None):
                if 'list_movies' in url:
                    raise OSError('offline')
                if 'api.knaben.org' in url:
                    return {'hits': hits}
                return []
            with self.subTest(hits=hits):
                if hits:
                    status, best = catalog.verify(MOVIE, CAP, fetch)
                    self.assertEqual((status, best['source']), ('verified', 'knaben'))
                else:
                    with self.assertRaises(catalog.LookupUnavailable):
                        catalog.verify(MOVIE, CAP, fetch)

    def test_knaben_definitive_negative_with_blocked_apibay_and_yts_mirror(self):
        film = dict(MOVIE, title='Resident Evil', year=2026)
        hits = [knaben('Resident Evil 2026.1080p.CAM.TS.AAC.x264'),
                knaben('Resident Evil 2026 1080p WEB H264-FLUX', categoryId=[2000000])]
        def fetch(url, json_body=None):
            if catalog.YTS_BASES[0] in url:
                return {'status': 'ok', 'data': {}}
            if 'api.knaben.org' in url:
                return {'hits': hits}
            raise OSError('403 or DNS failure')
        self.assertEqual(catalog.verify(film, CAP, fetch), ('unverified', None))

    def test_knaben_movie_categories_and_query(self):
        for categories in ([3001000], [2000000, 3001000]):
            http = fake_http(hits=[knaben(categoryId=categories)])
            status, best = catalog.verify(MOVIE, CAP, http)
            self.assertEqual((status, best['source']), ('verified', 'knaben'))
            self.assertEqual(http.call_args.kwargs['json_body'], {
                'query': 'The Matrix 1999', 'order_by': 'seeders', 'order_direction': 'desc',
                'size': 100, 'hide_unsafe': True, 'hide_xxx': True})
        for categories in ([], None, '3001000', ['3001000'], [2000000], [10000000], [4000000]):
            with self.subTest(categories=categories):
                self.assertEqual(catalog.verify(MOVIE, CAP, fake_http(hits=[
                    knaben(categoryId=categories)])), ('unverified', None))
        item = dict(MOVIE, year=None)
        http = fake_http()
        catalog.verify(item, CAP, http)
        self.assertEqual(http.call_args.kwargs['json_body']['query'], item['title'])

    def test_knaben_uses_all_release_filters_and_best_candidate(self):
        for changes in ({'title': 'The.Matrix.1999.1080p.TELESYNC'},
                        {'title': 'The.Matrix.Reloaded.1999.1080p'},
                        {'title': 'The.Matrix.1999.720p'},
                        {'title': 'The.Matrix.1999.1080p.Collection'},
                        {'title': 'The.Matrix.2000.1080p'},
                        {'title': 'The.Matrix.1999.1080p.tt9999999'},
                        {'bytes': catalog.MIN_BYTES - 1}, {'bytes': CAP + 1},
                        {'seeders': 4}, {'hash': '0' * 40}):
            with self.subTest(changes=changes):
                self.assertEqual(catalog.verify(MOVIE, CAP, fake_http(hits=[
                    knaben(**changes)])), ('unverified', None))
        http = fake_http([row(seeders=500)], hits=[
            knaben('The.Matrix.1999.2160p.WEB', hash='b' * 40, seeders=5)])
        self.assertEqual(catalog.verify(MOVIE, CAP, http)[1]['hash'], 'b' * 40)

    def test_html_entities_are_decoded_before_identity_and_release_filters(self):
        for name in ('The.Matrix.1999.1080p.&#67;AM',
                     'The.Matrix.1999.1080p.&#x54;S',
                     'The.Matrix.1999.1080p.Collec&#116;ion',
                     'The.Matrix.1999.1080p.&#116;t9999999'):
            with self.subTest(name=name):
                self.assertEqual(catalog.verify(MOVIE, CAP, fake_http(
                    [row(name)], hits=[knaben(name)])), ('unverified', None))
        film = dict(MOVIE, title='Dumb & Dumber', year=1994, imdb=None)
        name = 'Dumb &amp; Dumber 1994 1080p WEB'
        for source in ('apibay', 'knaben'):
            def fetch(url, json_body=None):
                if 'list_movies' in url:
                    return {'status': 'ok', 'data': {}}
                if source == 'apibay' and 'apibay.org' in url:
                    return [row(name)]
                if source == 'knaben' and 'api.knaben.org' in url:
                    return {'hits': [knaben(name)]}
                raise OSError('offline')
            with self.subTest(source=source):
                status, best = catalog.verify(film, CAP, fetch)
                self.assertEqual((status, best['source']), ('verified', source))
                self.assertEqual(best['name'], 'Dumb & Dumber 1994 1080p WEB')

    def test_movie_rejects_episodic_metadata_from_both_sources(self):
        for marker in ('S01E01', 'S01', '3x01', 'Season 3', '&#83;01E01'):
            name = 'The.Matrix.1999.%s.1080p.WEB' % marker
            with self.subTest(marker=marker):
                self.assertEqual(catalog.verify(MOVIE, CAP, fake_http([
                    row(name, imdb=MOVIE['imdb'])], hits=[knaben(name, imdb=MOVIE['imdb'])])),
                                 ('unverified', None))
        film = dict(MOVIE, title='Season 3', imdb=None)
        self.assertEqual(catalog.verify(film, CAP, fake_http(hits=[
            knaben('Season 3 1999 1080p WEB')]))[0], 'verified')

    def test_malformed_hits_do_not_suppress_later_candidates(self):
        malformed = [None, False, 7, 'bad', [], {}, {'title': ['bad']}]
        for source in ('apibay', 'knaben'):
            http = fake_http(rows=malformed + [row()] if source == 'apibay' else [],
                             hits=malformed + [knaben()] if source == 'knaben' else [])
            with self.subTest(source=source):
                status, best = catalog.verify(MOVIE, CAP, http)
                self.assertEqual((status, best['source']), ('verified', source))
        self.assertEqual(catalog.verify(MOVIE, CAP, fake_http(hits=malformed)),
                         ('unverified', None))

    def test_non_yts_stage_requires_knaben_or_every_apibay_category(self):
        def fetch(url, json_body=None):
            if 'list_movies' in url:
                return {'status': 'ok', 'data': {}}
            if 'cat=201' in url:
                return []
            raise OSError('403')
        with self.assertRaises(catalog.LookupUnavailable):
            catalog.verify(MOVIE, CAP, fetch)
        for payload in ({}, {'hits': None}):
            def malformed(url, json_body=None):
                if 'api.knaben.org' in url:
                    return payload
                raise OSError('403')
            with self.assertRaises(catalog.LookupUnavailable):
                catalog.verify(MOVIE, CAP, malformed)

    def test_apibay_quality_priority(self):
        rows = [row(seeders=1000), row('The.Matrix.1999.2160p', seeders=5, info_hash='b' * 40),
                row('The.Matrix.1999.2160p', seeders=8, info_hash='c' * 40)]
        self.assertEqual(catalog.verify(MOVIE, CAP, fake_http(rows))[1]['hash'], 'c' * 40)

    def test_international_titles_keep_identity(self):
        for title, release in (('Amélie', 'Amelie'), ('七人の侍', '七人の侍')):
            item = dict(MOVIE, title=title, imdb=None)
            self.assertEqual(catalog.verify(item, CAP, fake_http([
                row(release + '.1999.1080p')]))[0], 'verified')

    def test_tv_strict_title_seeded_quality_size_and_year(self):
        show = dict(MOVIE, title='Ghosts', kind='tv', year=2021, imdb=None)
        for name, changes, expected in (
                ('Ghosts.2021.S01E01.1080p.WEB', {}, 'verified'),
                ('Ghosts.2021.S01.Complete.1080p', {}, 'verified'),
                ('Ghosts.2021.S01E01.1080p', {'seeders': 4}, 'unverified'),
                ('Ghosts.2021.S01E01.720p', {}, 'unverified'),
                ('Ghosts.2021.S01E01.1080p.HDTS', {}, 'unverified'),
                ('Ghosts.US.2021.S01E01.1080p', {}, 'unverified'),
                ('Ghosts.2019.S01E01.1080p', {}, 'unverified'),
                ('Ghosts.2021.S01E01.1080p', {'size': CAP + 1}, 'unverified')):
            with self.subTest(name=name, changes=changes):
                http = fake_http([row(name, **changes)])
                self.assertEqual(catalog.verify(show, CAP, http), (expected, None))
                self.assertEqual(http.call_count, 2)
                self.assertIn('cat=205', http.call_args_list[0].args[0])
        tagged = dict(show, imdb='tt0133093')
        self.assertEqual(catalog.verify(tagged, CAP, fake_http([
            row('Wrong.Title.1080p', imdb=tagged['imdb'])]))[0], 'unverified')

    def test_tv_episode_and_season_identity_without_year(self):
        show = dict(MOVIE, title='Tulsa King', kind='tv', year=2022)
        for marker in ('S03E01', 'S03', '3x01', 'season 3', 'S04E01 W W D D'):
            name = 'Tulsa King %s 1080p WEB' % marker
            with self.subTest(marker=marker):
                self.assertEqual(catalog.verify(show, CAP, fake_http([row(name)])),
                                 ('verified', None))
                http = fake_http(hits=[knaben(name, categoryId=[2001000])])
                self.assertEqual(catalog.verify(show, CAP, http), ('verified', None))
                self.assertEqual(http.call_args.kwargs['json_body']['query'], 'Tulsa King')
        for title, name in (('Tulsa King', 'Tulsa Kings S01E01 1080p'),
                            ('The Diplomat', 'The Diplomat Wife S01E01 1080p')):
            item = dict(show, title=title)
            for imdb in (None, item['imdb']):
                self.assertEqual(catalog.verify(item, CAP, fake_http([
                    row(name, imdb=imdb)], hits=[knaben(name, imdb=imdb,
                                                       categoryId=[2001000])])),
                                 ('unverified', None))
        for categories in ([3001000], [10000000], []):
            self.assertEqual(catalog.verify(show, CAP, fake_http(hits=[
                knaben('Tulsa King S03 Complete 1080p', categoryId=categories)])),
                             ('unverified', None))

    def test_lookup_deadline_is_shared_across_mirrors_and_providers(self):
        clock = [0]
        def fetch(url):
            clock[0] += 16
            return {'status': 'ok', 'data': {}} if 'list_movies' in url else []
        http = mock.Mock(side_effect=fetch)
        with self.assertRaises(catalog.LookupUnavailable):
            catalog.verify(MOVIE, CAP, http, monotonic=lambda: clock[0])
        self.assertEqual(http.call_count, 2)  # no fresh deadline for the third endpoint

    def test_default_transport_receives_one_lookup_deadline(self):
        with mock.patch.object(catalog, '_http_json', return_value={}) as http:
            with self.assertRaises(catalog.LookupUnavailable):
                catalog.verify(MOVIE, CAP, monotonic=lambda: 100)
        self.assertTrue(all(call.kwargs['deadline'] == 100 + catalog.LOOKUP_TIMEOUT
                            for call in http.call_args_list))

    def test_network_failure_is_not_a_negative(self):
        with self.assertRaises(catalog.LookupUnavailable):
            catalog.verify(MOVIE, CAP, mock.Mock(side_effect=OSError('offline')))


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.response = mock.Mock(status=200)
        self.response.getheader.return_value = None
        self.response.read1.side_effect = io.BytesIO(b'{"ok":true}').read
        self.connection = mock.Mock()
        self.connection.getresponse.return_value = self.response
        opening = mock.patch.object(catalog.http.client, 'HTTPSConnection', return_value=self.connection)
        self.opening = opening.start()
        self.addCleanup(opening.stop)

    def test_http_uses_twelve_second_timeout(self):
        self.assertEqual(catalog._http_json('https://example.invalid'), {'ok': True})
        self.assertLessEqual(self.opening.call_args.kwargs['timeout'], 12)
        self.assertGreater(self.opening.call_args.kwargs['timeout'], 11)
        self.assertTrue(self.response.close.called)

    def test_post_sends_json_with_shared_transport_bounds(self):
        before = time.monotonic()
        self.assertEqual(catalog._http_json('https://example.invalid/v1',
                                           deadline=before + 1, json_body={'query': 'The Matrix'}),
                         {'ok': True})
        request = self.connection.request.call_args
        self.assertEqual(request.args, ('POST', '/v1'))
        self.assertEqual(json.loads(request.kwargs['body']), {'query': 'The Matrix'})
        self.assertEqual(request.kwargs['headers']['Content-Type'], 'application/json')
        self.assertLessEqual(self.opening.call_args.kwargs['timeout'], 1)

    def test_rejects_oversized_advertised_or_streamed_response(self):
        for length, body in ((length, body) for length in (str(catalog.MAX_RESPONSE_BYTES + 1), None)
                             for body in (None, {'query': 'The Matrix'})):
            with self.subTest(length=length, body=body):
                self.response.getheader.return_value = length
                self.response.read1.side_effect = io.BytesIO(b'x' * (catalog.MAX_RESPONSE_BYTES + 1)).read
                self.response.read1.reset_mock()
                with self.assertRaises(catalog.LookupUnavailable):
                    catalog._http_json('https://example.invalid', json_body=body)
                if length:
                    self.response.read1.assert_not_called()
                self.assertTrue(all(call.args[0] <= 65536 for call in self.response.read1.call_args_list))

    def test_trickling_response_cannot_extend_total_deadline(self):
        clock = [0]
        def trickle(size):
            clock[0] += .4
            return b' '
        self.response.read1.side_effect = trickle
        with mock.patch.object(catalog.time, 'monotonic', side_effect=lambda: clock[0]):
            with self.assertRaises(catalog.LookupUnavailable):
                catalog._http_json('https://example.invalid', deadline=1)
        self.assertEqual(self.response.read1.call_count, 3)

    def test_post_rejects_redirects_and_insecure_urls(self):
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                self.response.status = status
                self.response.getheader.return_value = 'https://mirror.invalid/next'
                self.opening.reset_mock()
                with self.assertRaises(catalog.LookupUnavailable):
                    catalog._http_json('https://example.invalid', json_body={'query': 'film'})
                self.assertEqual(self.opening.call_count, 1)
                self.assertTrue(self.response.close.called)
        self.opening.reset_mock()
        with self.assertRaises(catalog.LookupUnavailable):
            catalog._http_json('http://example.invalid', json_body={})
        self.opening.assert_not_called()

    def test_watchdog_interrupts_blocked_headers_and_body(self):
        for stage, body in ((stage, body) for stage in ('headers', 'body') for body in (None, {})):
            with self.subTest(stage=stage, body=body):
                aborted = threading.Event()
                self.connection.sock.shutdown.side_effect = lambda *_: aborted.set()
                def blocked(*_):
                    if not aborted.wait(1):
                        self.fail('watchdog did not shut down the socket')
                    raise OSError('socket shut down')
                self.connection.getresponse.side_effect = blocked if stage == 'headers' else None
                self.response.read1.side_effect = blocked
                before = time.monotonic()
                with self.assertRaises(OSError):
                    catalog._http_json('https://example.invalid', deadline=before + .05,
                                       json_body=body)
                self.assertLess(time.monotonic() - before, .5)

    def test_redirects_share_the_http_deadline(self):
        self.response.status = 302
        self.response.getheader.return_value = 'https://mirror.invalid/next'
        clock = [0]
        def redirect():
            clock[0] += .4
            return self.response
        self.connection.getresponse.side_effect = redirect
        with mock.patch.object(catalog.time, 'monotonic', side_effect=lambda: clock[0]):
            with self.assertRaises(catalog.LookupUnavailable):
                catalog._http_json('https://example.invalid', deadline=1)
        self.assertEqual(self.opening.call_count, 3)
        self.assertLess(self.opening.call_args.kwargs['timeout'], .3)


class ConnectionTests(unittest.TestCase):
    def test_stalled_dns_has_bounded_waits_helpers_and_queue(self):
        release, started = threading.Event(), threading.Event()
        def stalled(*args, **kwargs):
            started.set()
            release.wait(2)
            return []
        with mock.patch.object(catalog.socket, 'getaddrinfo', side_effect=stalled):
            resolver = catalog._Resolver(workers=1, capacity=1)
            try:
                before = time.monotonic()
                with self.assertRaises(catalog.LookupUnavailable):
                    resolver.resolve('example.invalid', 443, before + .05)
                self.assertTrue(started.is_set())
                self.assertLess(time.monotonic() - before, .5)
                with self.assertRaises(catalog.LookupUnavailable):
                    resolver.resolve('second.invalid', 443, time.monotonic() + .01)
                with self.assertRaisesRegex(catalog.LookupUnavailable, 'queue is full'):
                    resolver.resolve('third.invalid', 443, time.monotonic() + .01)
                self.assertEqual(resolver.jobs.qsize(), 1)
                self.assertEqual(len(resolver.threads), 1)
            finally:
                release.set()
                resolver.close()

    def test_all_addresses_share_connection_deadline(self):
        clock = [0]
        sock = mock.Mock()
        def failed_connect(*_):
            clock[0] += .7
            raise OSError('connection failed')
        sock.connect.side_effect = failed_connect
        resolver = mock.Mock()
        resolver.resolve.return_value = [(2, 1, 6, '', ('127.0.0.1', 443))] * 4
        with mock.patch.object(catalog, '_RESOLVER', resolver), \
                mock.patch.object(catalog.socket, 'socket', return_value=sock), \
                mock.patch.object(catalog.time, 'monotonic', side_effect=lambda: clock[0]):
            with self.assertRaises(catalog.LookupUnavailable):
                catalog._connect(('example.invalid', 443), 1, [None])
        self.assertEqual(sock.connect.call_count, 2)
        self.assertAlmostEqual(sock.settimeout.call_args_list[-1].args[0], .3)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 100 * catalog.DAY
        self.best = catalog._candidate(HASH, 'The.Matrix.1999.1080p',
                                      2_000_000_000, 10, '1080p', 'yts', CAP)
        self.lookup = mock.Mock(return_value=('verified', self.best))
        self.store = self.make_store()

    def make_store(self, **kwargs):
        store = catalog.Catalog(Path(self.temp.name) / '.catalog.json',
                                clock=lambda: self.now, lookup=kwargs.pop('lookup', self.lookup), **kwargs)
        self.addCleanup(store.close)
        return store

    def check(self, wait=1000, items=None, **changes):
        body = {'items': [MOVIE] if items is None else items, 'max_bytes': CAP, 'wait_ms': wait}
        body.update(changes)
        return self.store.check(body)['results']

    def test_persistence_round_trip_and_fresh_cache(self):
        result = self.check()[0]
        self.assertEqual(result['status'], 'verified')
        self.assertEqual(result['checkedAt'], self.now)
        self.store.jobs.join()
        self.store.flush()
        loaded = self.make_store()
        self.assertEqual(loaded.check({'items': [MOVIE], 'max_bytes': CAP})['results'][0], result)
        self.assertEqual(self.lookup.call_count, 1)
        self.assertEqual(len(list(Path(self.temp.name).iterdir())), 1)
        with mock.patch.object(catalog.os, 'replace', wraps=catalog.os.replace) as replace:
            self.now += 1
            self.check()
            self.store.flush()
        self.assertEqual(replace.call_count, 1)
        self.assertEqual(self.make_store().entries[result['key']]['lastSeenAt'], self.now)

    def test_keys_identity_and_order(self):
        self.check(items=[MOVIE, dict(MOVIE, title='THE.MATRIX')])
        self.assertEqual(self.store.status()['entries'], 1)
        items = [dict(MOVIE, kind='tv'), dict(MOVIE, year=2000), dict(MOVIE, imdb=None), MOVIE]
        results = self.check(items=items)
        self.assertEqual([r['kind'] for r in results], ['tv', 'movie', 'movie', 'movie'])
        self.assertEqual(len(set(r['key'] for r in results)), 4)

    def test_wait_zero_timeout_and_completion(self):
        started, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def lookup(*_):
            started.set()
            release.wait(3)
            return 'verified', self.best
        self.store.lookup = lookup
        before = time.monotonic()
        self.assertEqual(self.check(wait=0)[0]['status'], 'pending')
        self.assertLess(time.monotonic() - before, .5)
        self.assertTrue(started.wait(1))
        before = time.monotonic()
        self.assertEqual(self.check(wait=50)[0]['status'], 'pending')
        self.assertGreaterEqual(time.monotonic() - before, .04)
        self.assertLess(time.monotonic() - before, .5)
        timer = threading.Timer(.03, release.set)
        timer.start()
        self.addCleanup(timer.cancel)
        self.assertEqual(self.check(wait=1000)[0]['status'], 'verified')

    def test_wait_is_one_budget_for_whole_batch(self):
        release = threading.Event()
        self.addCleanup(release.set)
        def lookup(*_):
            release.wait(3)
            return 'unverified', None
        self.store.lookup = lookup
        before = time.monotonic()
        results = self.check(wait=80, items=[dict(MOVIE, year=year) for year in range(2000, 2010)])
        self.assertTrue(all(r['status'] == 'pending' for r in results))
        self.assertLess(time.monotonic() - before, .4)
        release.set()
        self.store.jobs.join()

    def test_stale_entries_recheck_and_failure_backoff(self):
        self.check()
        self.now += catalog.DAY
        self.lookup.side_effect = OSError('offline')
        self.assertEqual(self.check()[0]['status'], 'verified')
        self.assertEqual(self.check()[0]['checkedAt'], self.now - catalog.DAY)
        self.assertEqual(self.lookup.call_count, 2)
        self.now += 61
        self.lookup.side_effect = None
        self.lookup.return_value = ('unverified', None)
        self.assertEqual(self.check()[0]['status'], 'unverified')
        self.assertEqual(self.store.status()['verified'], 0)

    def test_unknown_network_failure_remains_pending_and_worker_survives(self):
        self.lookup.side_effect = OSError('offline')
        self.assertEqual(self.check()[0]['status'], 'pending')
        self.assertIsNone(self.check()[0]['checkedAt'])
        self.now += 61
        self.lookup.side_effect = None
        self.assertEqual(self.check()[0]['status'], 'verified')

    def test_refresh_startup_daily_recent_and_prune(self):
        self.check()
        key = catalog.item_key(MOVIE)
        for age in (2, 15, 31):
            entry = dict(self.store.entries[key], item=dict(MOVIE, year=1999 + age),
                         lastSeenAt=self.now - age * catalog.DAY,
                         checkedAt=self.now - 2 * catalog.DAY)
            self.store.entries[catalog.item_key(entry['item'])] = entry
        self.store.refresh_due()
        self.store.jobs.join()
        self.assertEqual(self.lookup.call_count, 3)  # initial + two stale entries
        self.assertEqual(self.store.status()['entries'], 3)
        self.assertEqual(self.store.status()['nextRefreshAt'], self.now + catalog.DAY)
        self.store.refresh_due()
        self.assertEqual(self.lookup.call_count, 3)
        self.now += catalog.DAY
        self.store.refresh_due()
        self.store.jobs.join()
        self.assertEqual(self.lookup.call_count, 5)  # recent 0/2-day entries only
        self.assertEqual(self.store.status()['lastRefreshAt'], self.now)

    def test_refresh_scheduler_survives_an_exception(self):
        attempted = threading.Event()
        def failed():
            attempted.set()
            raise OSError('disk unavailable')
        self.store.refresh_due = failed
        self.store.start_refresh_thread()
        self.assertTrue(attempted.wait(1))
        self.assertTrue(self.store.refresh_thread.is_alive())
        self.store.start_refresh_thread()  # idempotent

    def test_pool_is_bounded_and_duplicate_jobs_coalesce(self):
        release = threading.Event()
        four = threading.Event()
        count = [0]
        lock = threading.Lock()
        self.addCleanup(release.set)
        def lookup(*_):
            with lock:
                count[0] += 1
                if count[0] == 4:
                    four.set()
            release.wait(3)
            return 'unverified', None
        self.store.lookup = lookup
        items = [dict(MOVIE, year=2000 + i) for i in range(10)]
        self.check(wait=0, items=items)
        self.check(wait=0, items=items)
        self.assertTrue(four.wait(1))
        self.assertEqual(count[0], 4)
        self.assertEqual(self.store.status()['queue'], 10)
        release.set()
        self.store.jobs.join()
        self.assertEqual(count[0], 10)

    def test_changed_cap_is_reverified_and_global_cap_is_enforced(self):
        self.check(max_bytes=CAP * 2)
        self.assertEqual(self.lookup.call_args.args[1], CAP)
        self.check(max_bytes=1_000_000_000)
        self.assertEqual(self.lookup.call_count, 2)
        self.assertEqual(self.lookup.call_args.args[1], 1_000_000_000)

    def test_cap_change_during_lookup_queues_new_policy(self):
        started, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        caps = []
        def lookup(item, cap):
            caps.append(cap)
            if len(caps) == 1:
                started.set()
                release.wait(3)
                return 'verified', self.best
            return 'unverified', None
        self.store.lookup = lookup
        self.check(wait=0)
        self.assertTrue(started.wait(1))
        self.assertEqual(self.check(wait=0, max_bytes=1_000_000_000)[0]['status'], 'pending')
        release.set()
        self.store.jobs.join()
        self.assertEqual(caps, [CAP, 1_000_000_000])
        result = self.check(max_bytes=1_000_000_000)[0]
        self.assertEqual((result['status'], result['best']), ('unverified', None))

    def test_admission_queue_and_retention_are_bounded(self):
        self.store.worker_count = 0
        with mock.patch.object(catalog, 'MAX_ENTRIES', 7), mock.patch.object(catalog, 'MAX_QUEUE', 3):
            for start in (0, 5, 10):
                results = self.check(wait=0, items=[dict(MOVIE, title='Film %d' % i)
                                                  for i in range(start, start + 5)])
                self.assertEqual(len(results), 5)
                self.assertTrue(all(r['status'] == 'pending' for r in results))
            self.assertEqual(len(self.store.entries), 7)
            self.assertEqual(len(self.store.pending), 3)
            self.assertEqual(len(self.store.deferred), 4)
            self.assertEqual(self.store.jobs.qsize(), 3)
            # Reclaim expired, inactive identities and admit a later request.
            self.now += 31 * catalog.DAY
            self.check(wait=0, items=[dict(MOVIE, title='New Film')])
            self.assertEqual(len(self.store.entries), 4)  # 3 in-flight + new

    def test_refresh_overflow_is_drained_incrementally(self):
        self.check()
        base = dict(self.store.entries[catalog.item_key(MOVIE)])
        self.store.entries.clear()
        self.now += 2 * catalog.DAY
        for i in range(20):
            item = dict(MOVIE, title='Film %d' % i)
            self.store.entries[catalog.item_key(item)] = dict(base, item=item)
        self.lookup.reset_mock()
        with mock.patch.object(catalog, 'MAX_QUEUE', 2), mock.patch.object(catalog, 'REFRESH_BATCH', 1):
            self.store.refresh_due()
            self.store.jobs.join()
        self.assertEqual(self.lookup.call_count, 20)
        self.assertFalse(self.store.pending)
        self.assertFalse(self.store.deferred)
        self.assertTrue(all(e['checkedAt'] == self.now for e in self.store.entries.values()))

    def test_persistence_is_coalesced_and_does_not_hold_catalog_lock(self):
        started, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        write = self.store._write_snapshot
        def slow_write(snapshot):
            started.set()
            release.wait(2)
            write(snapshot)
        with mock.patch.object(self.store, '_write_snapshot', side_effect=slow_write) as writer:
            self.check()
            self.assertTrue(started.wait(1))
            before = time.monotonic()
            for i in range(20):
                self.now += 1
                self.check(wait=0)
            self.assertLess(time.monotonic() - before, .5)
            release.set()
            self.store.flush()
            self.assertEqual(writer.call_count, 2)  # first snapshot + coalesced mutations
        self.assertEqual(self.make_store().entries[catalog.item_key(MOVIE)]['lastSeenAt'], self.now)

    def test_legacy_verifications_are_invalidated_and_load_is_bounded(self):
        self.check()
        self.store.flush()
        payload = json.loads(self.store.path.read_text())
        payload.pop('verificationVersion')
        base = next(iter(payload['entries'].values()))
        for i in range(5):
            item = dict(MOVIE, title='Film %d' % i)
            payload['entries'][catalog.item_key(item)] = dict(base, item=item)
        self.store.path.write_text(json.dumps(payload))
        with mock.patch.object(catalog, 'MAX_ENTRIES', 2):
            loaded = self.make_store()
        self.assertEqual(len(loaded.entries), 2)
        self.assertTrue(all(e['status'] == 'pending' and e['best'] is None
                            and e['checkedAt'] is None for e in loaded.entries.values()))

    def test_v2_store_preserves_positives_and_promptly_rechecks_negatives(self):
        self.check()
        self.store.flush()
        payload = json.loads(self.store.path.read_text())
        payload['verificationVersion'] = 2
        base = next(iter(payload['entries'].values()))
        show = dict(MOVIE, kind='tv')
        payload['entries'][catalog.item_key(show)] = dict(base, item=show, best=None)
        for status in ('unverified', 'pending'):
            item = dict(MOVIE, title=status)
            payload['entries'][catalog.item_key(item)] = dict(base, item=item, status=status,
                                                             best=None, needsCheck=False)
        bad = dict(MOVIE, title='Bad cached movie')
        payload['entries'][catalog.item_key(bad)] = dict(base, item=bad,
                                                        best=dict(self.best, source='unknown'))
        self.store.path.write_text(json.dumps(payload))
        self.lookup.reset_mock()
        loaded = self.make_store()
        self.assertEqual(loaded.entries[catalog.item_key(MOVIE)], base)
        self.assertEqual(loaded.entries[catalog.item_key(show)], payload['entries'][catalog.item_key(show)])
        self.assertNotIn(catalog.item_key(bad), loaded.entries)
        self.assertEqual(len(loaded.deferred), 2)
        for status in ('unverified', 'pending'):
            entry = loaded.entries[catalog.item_key(dict(MOVIE, title=status))]
            self.assertEqual(entry['status'], status)
            self.assertIsNone(entry['checkedAt'])
            self.assertTrue(entry['needsCheck'])
        loaded.refresh_due()
        loaded.jobs.join()
        self.assertEqual(self.lookup.call_count, 2)
        self.assertTrue(all(entry['status'] == 'verified' for entry in loaded.entries.values()))
        loaded.flush()
        self.assertEqual(json.loads(loaded.path.read_text())['verificationVersion'], 3)

    def test_input_validation(self):
        for changes in ({'max_bytes': 0}, {'max_bytes': True}, {'wait_ms': -1},
                        {'wait_ms': 8001}, {'wait_ms': 1.5}, {'items': {}},
                        {'items': [dict(MOVIE, title='')]}, {'items': [dict(MOVIE, kind='x')]},
                        {'items': [dict(MOVIE, year=True)]}, {'items': [dict(MOVIE, imdb='x')]},
                        {'items': [MOVIE] * (catalog.MAX_ITEMS + 1)},
                        {'items': [dict(MOVIE, title='x' * 301)]},
                        {'items': [dict(MOVIE, tmdb_id='603')]}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.check(**changes)

    def test_corrupt_store_is_ignored(self):
        self.store.path.write_text('{broken')
        self.assertEqual(self.make_store().status()['entries'], 0)

    def test_environment_path_and_hidden_default(self):
        with mock.patch.object(catalog, '_INSTANCE', None), mock.patch.dict(
                os.environ, {'DUMIFLIX_CATALOG_PATH': str(Path(self.temp.name) / 'custom.json')}):
            instance = catalog.get_catalog(self.temp.name)
            self.addCleanup(instance.close)
            self.assertEqual(instance.path.name, 'custom.json')
        with mock.patch.object(catalog, '_INSTANCE', None), mock.patch.dict(
                os.environ, {'DUMIFLIX_CATALOG_PATH': ''}):
            instance = catalog.get_catalog(self.temp.name)
            self.addCleanup(instance.close)
            self.assertEqual(instance.path.name, '.catalog.json')


class RouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        with mock.patch.dict(os.environ, {'DUMIFLIX_LOG_DIR': cls.temp.name,
                                         'DUMIFLIX_CACHE_ROOT': cls.temp.name}):
            import server
            cls.server = server

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def request(self, method, path, body=None, headers=None, enabled=True):
        h = self.server.Handler.__new__(self.server.Handler)
        h.command, h.path = method, path
        raw = json.dumps(body).encode() if body is not None else b''
        h.headers = {'Content-Length': str(len(raw)), **(headers or {})}
        h.rfile, h.wfile = io.BytesIO(raw), io.BytesIO()
        h.client_address = ('127.0.0.1', 1234)
        h.send_response, h.send_header, h.end_headers = mock.Mock(), mock.Mock(), mock.Mock()
        h.close_connection = False
        with mock.patch.object(self.server, 'CACHE_ENABLED', enabled), \
                mock.patch.object(self.server, 'TOKEN', 'test-token'):
            getattr(h, 'do_' + method)()
        return h.send_response.call_args.args[0], json.loads(h.wfile.getvalue() or b'{}')

    def test_routes_auth_validation_and_json_contract(self):
        store = catalog.Catalog(Path(self.temp.name) / '.catalog.json',
                                lookup=lambda *_: ('verified', catalog._candidate(
                                    HASH, 'The.Matrix.1999.1080p', 2_000_000_000, 5, '1080p', 'yts', CAP)))
        self.addCleanup(store.close)
        with mock.patch.object(catalog, 'get_catalog', return_value=store):
            for method, path in (('POST', '/catalog/check'), ('GET', '/catalog/status')):
                self.assertEqual(self.request(method, path)[0], 401)
            headers = {'X-Playback-Token': 'test-token'}
            code, reply = self.request('POST', '/catalog/check',
                                       {'items': [MOVIE, dict(MOVIE, kind='tv')],
                                        'max_bytes': CAP, 'wait_ms': 1000}, headers)
            self.assertEqual(code, 200)
            self.assertEqual(len(reply['results']), 2)
            result = reply['results'][0]
            self.assertEqual(set(result), {'key', 'title', 'kind', 'status', 'best', 'checkedAt'})
            self.assertEqual(result['status'], 'verified')
            self.assertEqual(set(result['best']), {'hash', 'name', 'size', 'quality', 'seeders', 'source'})
            code, status = self.request('GET', '/catalog/status', headers=headers)
            self.assertEqual(code, 200)
            self.assertEqual(set(status), {'entries', 'verified', 'queue', 'lastRefreshAt', 'nextRefreshAt'})
            self.assertEqual(status['entries'], 2)
            for body in ({}, [], {'items': [], 'max_bytes': CAP, 'wait_ms': 8001},
                         {'items': [MOVIE] * (catalog.MAX_ITEMS + 1), 'max_bytes': CAP}):
                self.assertEqual(self.request('POST', '/catalog/check', body, headers)[0], 400)
            for method, path in (('POST', '/catalog/check'), ('GET', '/catalog/status')):
                self.assertEqual(self.request(method, path, headers=headers, enabled=False)[0], 404)

    def test_storage_failure_is_json_503(self):
        store = mock.Mock()
        store.check.side_effect = OSError('disk unavailable')
        with mock.patch.object(catalog, 'get_catalog', return_value=store):
            code, reply = self.request('POST', '/catalog/check', {}, {'X-Playback-Token': 'test-token'})
        self.assertEqual((code, reply), (503, {'error': 'catalog storage unavailable'}))


if __name__ == '__main__':
    unittest.main()
