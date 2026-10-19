import json
import pathlib
import sys
import unittest
from unittest import mock


sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import direct_http


class ContextResponse:
    def __init__(self, value):
        self.payload = json.dumps(value).encode()
        self.closed = False

    def read(self, _limit=None):
        return self.payload

    def close(self):
        self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class QueueOpener:
    def __init__(self, values):
        self.values = list(values)
        self.requests = []

    def open(self, request, timeout=None):
        self.requests.append((request, timeout))
        return ContextResponse(self.values.pop(0))


class DirectRouteTests(unittest.TestCase):
    def test_broker_requires_private_plain_http(self):
        for value in ('https://192.0.2.120:6880', 'http://example.com:6880', ''):
            with self.subTest(value=value):
                with self.assertRaises(direct_http.DirectHttpError):
                    direct_http.RouteBrokerLease(value, 'token')

    def test_globally_routable_broker_is_rejected(self):
        address = mock.Mock(is_private=False, is_loopback=False)
        with mock.patch.object(direct_http.ipaddress, 'ip_address', return_value=address):
            with self.assertRaises(direct_http.DirectHttpError):
                direct_http.RouteBrokerLease('http://198.51.100.1:6880', 'test-token')

    def test_acquire_and_release_require_verified_route_states(self):
        opener = QueueOpener([
            {'ok': True, 'directVerified': True},
            {'ok': True, 'routeVerified': True, 'exitVerified': False},
        ])
        lease = direct_http.RouteBrokerLease(
            'http://192.0.2.120:6880', 'secret', opener=opener,
            lease='a' * 48, renew_interval=60)
        lease.acquire()
        lease.close()
        paths = [row[0].full_url for row in opener.requests]
        self.assertEqual(paths, [
            'http://192.0.2.120:6880/api/route/direct/acquire',
            'http://192.0.2.120:6880/api/route/direct/release',
        ])
        self.assertTrue(all(
            row[0].get_header('X-route-broker-token') == 'secret'
            for row in opener.requests
        ))

    def test_unverified_acquire_fails_closed(self):
        opener = QueueOpener([{'ok': True, 'directVerified': False}])
        lease = direct_http.RouteBrokerLease(
            'http://127.0.0.1:6880', 'secret', opener=opener,
            lease='b' * 48)
        with self.assertRaisesRegex(direct_http.DirectHttpError,
                                    'did not verify direct'):
            lease.acquire()

    def test_non_http_origin_is_rejected_after_lease(self):
        broker = QueueOpener([
            {'ok': True, 'directVerified': True},
            {'ok': True, 'routeVerified': True, 'exitVerified': False},
        ])
        lease = direct_http.RouteBrokerLease(
            'http://127.0.0.1:6880', 'secret', opener=broker,
            lease='c' * 48, renew_interval=60)
        session = direct_http.DirectHttpSession(
            lease, origin_opener=QueueOpener([]))
        with self.assertRaisesRegex(direct_http.DirectHttpError,
                                    r'requires an HTTP\(S\) URL'):
            session.open('file:///tmp/nope', timeout=1)
        session.close()


if __name__ == '__main__':
    unittest.main()
