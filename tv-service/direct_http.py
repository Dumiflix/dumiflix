#!/usr/bin/env python3
"""Borrow a verified direct route for one Seedr-to-cache HTTP transfer.

An optional, separately deployed route broker grants a short renewable lease
only after verifying direct HTTP egress. It must pause conflicting torrent
work before changing routes and restore a verified route before that work
resumes. The dashboard implementation is not included in this repository;
this client is enabled only through explicit environment configuration.

This client never receives a route until the broker has verified direct
egress. It renews the lease in the background for long downloads and ignores
proxy environment variables for both broker and origin requests.
"""

from __future__ import annotations

import ipaddress
import json
import os
import secrets
import threading
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional


class DirectHttpError(RuntimeError):
    """The broker could not prove or retain the required route."""


def enabled() -> bool:
    return os.environ.get('DUMIFLIX_CACHE_DIRECT_HTTP', '0') == '1'


def _broker_url() -> str:
    return os.environ.get('DUMIFLIX_CACHE_ROUTE_BROKER_URL', '').rstrip('/')


def _broker_token() -> str:
    return os.environ.get('DUMIFLIX_CACHE_ROUTE_BROKER_TOKEN', '')


def _valid_private_broker(value: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme.lower() != 'http' or not parsed.hostname:
            return False
        address = ipaddress.ip_address(parsed.hostname)
        return address.is_private or address.is_loopback
    except ValueError:
        return bool(parsed.hostname and parsed.hostname.lower() == 'localhost')


def config_summary() -> dict[str, Any]:
    on = enabled()
    ready = bool(on and _broker_token() and _valid_private_broker(_broker_url()))
    return {'enabled': on, 'configured': ready}


class RouteBrokerLease:
    def __init__(self, base_url: str, token: str,
                 opener: Optional[Any] = None,
                 lease: Optional[str] = None,
                 renew_interval: float = 10.0):
        if not _valid_private_broker(base_url):
            raise DirectHttpError('cache route broker must be private HTTP')
        if not token:
            raise DirectHttpError('cache route broker token is missing')
        self.base_url = base_url.rstrip('/')
        self.token = token
        self.lease = lease or secrets.token_hex(24)
        self.renew_interval = max(2.0, float(renew_interval))
        self.opener = opener or urllib.request.build_opener(
            urllib.request.ProxyHandler({}))
        self._stop = threading.Event()
        self._lost = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._request_lock = threading.Lock()
        self._responses: list[Any] = []
        self._acquired = False

    @classmethod
    def from_env(cls) -> 'RouteBrokerLease':
        return cls(_broker_url(), _broker_token())

    def _request(self, action: str, timeout: float = 35.0) -> dict:
        payload = json.dumps({'lease': self.lease}).encode('utf-8')
        request = urllib.request.Request(
            self.base_url + '/api/route/direct/' + action,
            data=payload,
            headers={
                'Content-Type': 'application/json',
                'X-Route-Broker-Token': self.token,
            },
            method='POST',
        )
        try:
            with self.opener.open(request, timeout=timeout) as response:
                raw = response.read(64 * 1024)
            result = json.loads(raw.decode('utf-8', 'replace') or '{}')
        except (OSError, ValueError, json.JSONDecodeError,
                urllib.error.URLError) as exc:
            raise DirectHttpError('cache route broker is unavailable') from exc
        if not isinstance(result, dict) or not result.get('ok'):
            raise DirectHttpError('cache route broker rejected the request')
        return result

    def acquire(self) -> None:
        result = self._request('acquire')
        if result.get('directVerified') is not True:
            raise DirectHttpError('cache route broker did not verify direct egress')
        self._acquired = True
        self._thread = threading.Thread(
            target=self._renew_loop, daemon=True,
            name='cache-direct-route-renew')
        self._thread.start()

    def _renew_loop(self) -> None:
        while not self._stop.wait(self.renew_interval):
            try:
                with self._request_lock:
                    # close() may win the lock after this iteration wakes.
                    if self._stop.is_set():
                        return
                    self._request('renew', timeout=15)
            except DirectHttpError:
                self._lost.set()
                with self._lock:
                    responses = list(self._responses)
                for response in responses:
                    try:
                        response.close()
                    except Exception:
                        pass
                return

    def assert_active(self) -> None:
        if self._lost.is_set():
            raise DirectHttpError('direct cache route lease was lost')

    def track(self, response):
        self.assert_active()
        with self._lock:
            self._responses.append(response)
        return response

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3)
        # A renewal may outlive the bounded join. Wait for its client request
        # before releasing. A timeout cannot cancel the server handler; the
        # broker also rejects retired IDs before processing late renewals.
        with self._request_lock:
            self._release()

    def _release(self) -> None:
        if not self._acquired:
            return
        self._acquired = False
        try:
            result = self._request('release')
            # New brokers restore direct idle mode when there is no torrent,
            # and return routeVerified. Accept the legacy exitVerified shape
            # during rolling upgrades so either deployment order is safe.
            if (result.get('routeVerified') is not True and
                    result.get('exitVerified') is not True):
                raise DirectHttpError('cache route broker did not verify the restored route')
        except DirectHttpError:
            # Fail safe: the broker keeps aria2 stopped unless it independently
            # verifies the configured exit route. Cache completion must remain durable.
            pass


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        scheme = urllib.parse.urlsplit(newurl).scheme.lower()
        if scheme not in ('http', 'https'):
            raise DirectHttpError('direct HTTP redirect used an unsupported scheme')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class DirectHttpSession:
    def __init__(self, lease: RouteBrokerLease,
                 origin_opener: Optional[Any] = None):
        self.lease = lease
        self.opener = origin_opener or urllib.request.build_opener(
            urllib.request.ProxyHandler({}), _SafeRedirectHandler())
        self.lease.acquire()

    @classmethod
    def from_env(cls) -> 'DirectHttpSession':
        return cls(RouteBrokerLease.from_env())

    def open(self, request, timeout: float):
        self.lease.assert_active()
        url = request.full_url if isinstance(
            request, urllib.request.Request) else str(request)
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme.lower() not in ('http', 'https') or not parsed.hostname:
            raise DirectHttpError('direct cache HTTP requires an HTTP(S) URL')
        try:
            response = self.opener.open(request, timeout=timeout)
        except OSError:
            self.lease.assert_active()
            raise
        return self.lease.track(response)

    def close(self) -> None:
        self.lease.close()
