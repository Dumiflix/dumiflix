"""Persistent, fail-closed release verification. All network work runs in workers."""
import json
import html
import http.client
import math
import os
from pathlib import Path
import queue
import re
import socket
import tempfile
import threading
import time
import unicodedata
import urllib.parse

DAY = 24 * 60 * 60
MIN_BYTES = 700 * 1024 ** 2
MAX_BYTES = 5 * 1024 ** 3
MAX_ITEMS = 256
MAX_ENTRIES = 4096
MAX_QUEUE = 128
REFRESH_BATCH = 16
MAX_RESPONSE_BYTES = 2 * 1024 ** 2
MAX_STORE_BYTES = 64 * 1024 ** 2
HTTP_TIMEOUT = 12
LOOKUP_TIMEOUT = 30
VERIFICATION_VERSION = 3
YTS_BASES = ('https://movies-api.accel.li/api/v2', 'https://yts.mx/api/v2')
_PACK_RE = re.compile(
    r'\b(?:collection|complete|duology|trilogy|quadrilogy|pentalogy|hexalogy|'
    r'anthology|saga|boxset|box[ ._-]*set|all[ ._-]*\d+[ ._-]*movies|'
    r'\d+[ ._-]*movies?[ ._-]*pack)\b', re.I)
_HASH_RE = re.compile(r'^[a-fA-F0-9]{40}$')
_EPISODE_RE = re.compile(r'\b(?:s\d{1,2}(?:e\d{1,3})?|\d{1,2}x\d{1,3}|season \d+)\b')
_BAD_SOURCE_RE = re.compile(
    r'\b(?:(?:hd|hq|new)?cam(?:rip|s)?|(?:hd)?(?:ts|tc)(?:rip)?|'
    r'(?:hd)?tele(?:sync|cine)(?:rip)?|(?:dvd)?(?:scr|screener)(?:rip)?|'
    r'pdvd|predvd|r5|workprint)\b')


class LookupUnavailable(Exception):
    """No definitive negative answer was possible; retain the previous result."""


def _norm(value):
    value = ''.join(c for c in unicodedata.normalize('NFKD', value)
                    if not unicodedata.combining(c))
    return ' '.join(re.findall(r'[^\W_]+', value.casefold()))


def _is_cam(name):
    return bool(_BAD_SOURCE_RE.search(_norm(name))) or bool(
        re.search(r'\b(?:hd[ ._-]*cam|hd[ ._-]*ts|dvd[ ._-]*scr)\b', name, re.I))


def _parse_quality(name):
    n = _norm(name)
    if re.search(r'\b(?:2160p?|4k|uhd)\b', n):
        return '2160p'
    if re.search(r'\b1080p?\b', n):
        return '1080p'
    return ''


def _imdb(value):
    value = str(value or '').strip().lower()
    if value.isdigit() and int(value):
        value = 'tt' + value.zfill(7)
    return value if re.fullmatch(r'tt\d{7,}', value) else ''


def _title_in_name(name, title):
    """Match the entire leading title, followed only by release metadata.

    Substrings, reordered words, sequels and extra subtitle words cannot pass.
    IMDb-tagged alternate/localized movie titles are handled separately.
    """
    n, t = _norm(name), _norm(title)
    if not t:
        return False
    if n == t:
        return True
    if not n.startswith(t + ' '):
        return False
    tail = n[len(t) + 1:]
    return bool(re.match(r'(?:19\d{2}|20\d{2}|s\d{1,2}(?:e\d{1,3})?|'
                         r'\d{1,2}x\d{1,3}|season \d+|1080p?|2160p?|4k|uhd)\b', tail))


def _year_ok(release_suffix, year):
    return year is not None and bool(re.match(str(year) + r'\b', _norm(release_suffix)))


def _release_metadata(name, title):
    """Exclude an identified leading title, retaining repeated source tags."""
    normalized = _norm(name)
    if _title_in_name(name, title):
        return normalized[len(_norm(title)):].strip()
    return normalized


def _identity(row, item, name, tv=False):
    target = item.get('imdb')
    tags = set(re.findall(r'(?<![a-z0-9])tt\d{7,}(?![a-z0-9])', name.lower()))
    tag = _imdb(row.get('imdb_code') or row.get('imdb'))
    if tag:
        tags.add(tag)
    if target and tags:
        return tags == {target} and (not tv or _title_in_name(name, item['title']))
    if not _title_in_name(name, item['title']):
        return False
    tail = _norm(name)[len(_norm(item['title'])):].strip()
    if tv and _EPISODE_RE.match(tail):
        return True
    # The release year must immediately follow the title. A later upload year
    # or a numeric title (e.g. "2099", a synthetic example) is not identity evidence.
    return _year_ok(tail, item['year'])


class _Resolver:
    """A fixed daemon pool bounds DNS waits, which socket timeouts do not cover.

    An OS resolver call cannot be cancelled. If it hangs, it occupies one of
    these four slots, never a catalog worker or an ever-growing helper pool.
    """
    def __init__(self, workers=4, capacity=MAX_QUEUE):
        self.jobs = queue.Queue(maxsize=capacity)
        self.stopped = threading.Event()
        self.threads = [threading.Thread(target=self._worker, name='catalog-dns-%d' % i,
                                         daemon=True) for i in range(workers)]
        for thread in self.threads:
            thread.start()

    def _worker(self):
        while not self.stopped.is_set():
            try:
                host, port, deadline, event, result = self.jobs.get(timeout=.2)
            except queue.Empty:
                continue
            try:
                if time.monotonic() < deadline:
                    result['addresses'] = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)[:16]
            except Exception as exc:
                result['error'] = exc
            finally:
                event.set()
                self.jobs.task_done()

    def resolve(self, host, port, deadline):
        event, result = threading.Event(), {}
        try:
            self.jobs.put_nowait((host, port, deadline, event, result))
        except queue.Full:
            raise LookupUnavailable('DNS queue is full') from None
        if not event.wait(max(0, deadline - time.monotonic())) or time.monotonic() >= deadline:
            raise LookupUnavailable('DNS deadline exceeded')
        if 'error' in result:
            raise LookupUnavailable('DNS lookup failed') from result['error']
        return result.get('addresses', [])

    def close(self):
        self.stopped.set()
        for thread in self.threads:
            thread.join(timeout=1)


_RESOLVER = None
_RESOLVER_LOCK = threading.Lock()


def _connect(address, deadline, wire, source_address=None):
    global _RESOLVER
    with _RESOLVER_LOCK:
        if _RESOLVER is None:
            _RESOLVER = _Resolver()
        resolver = _RESOLVER
    for family, socktype, proto, _, target in resolver.resolve(*address, deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        sock = socket.socket(family, socktype, proto)
        wire[0] = sock  # the watchdog can interrupt connection establishment
        try:
            sock.settimeout(remaining)
            if source_address:
                sock.bind(source_address)
            sock.connect(target)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise LookupUnavailable('connection deadline exceeded')
            sock.settimeout(remaining)  # TLS handshake shares the remaining time
            return sock
        except OSError:
            sock.close()
        except Exception:
            sock.close()
            raise
    raise LookupUnavailable('connection failed or deadline exceeded')


def _http_json(url, deadline=None, json_body=None):
    """Bound memory and wall time, including peers that continuously trickle data.

    A socket shutdown watchdog covers response headers as well as body reads.
    read1 avoids waiting for an entire chunk before checking the deadline.
    All mirrors and redirects share the caller's overall lookup deadline.
    """
    deadline = min(deadline if deadline is not None else math.inf,
                   time.monotonic() + HTTP_TIMEOUT)
    request_body = json.dumps(json_body).encode('utf-8') if json_body is not None else None
    headers = {'User-Agent': 'DumiFlix-Catalog/1.0', 'Accept': 'application/json',
               'Accept-Encoding': 'identity'}
    if request_body is not None:
        headers['Content-Type'] = 'application/json'
    for _ in range(4):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise LookupUnavailable('HTTP deadline exceeded')
        parts = urllib.parse.urlsplit(url)
        if parts.scheme != 'https' or not parts.hostname or parts.username or parts.password:
            raise LookupUnavailable('invalid upstream URL')
        connection = http.client.HTTPSConnection(parts.hostname, parts.port,
                                                 timeout=min(HTTP_TIMEOUT, remaining))
        wire = [None]
        connection._create_connection = lambda address, timeout, source_address=None: _connect(
            address, deadline, wire, source_address)
        def abort():
            sock = wire[0] or connection.sock
            if sock is not None:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            connection.close()
        watchdog = threading.Timer(remaining, abort)
        watchdog.daemon = True
        watchdog.start()
        response = None
        try:
            connection.connect()
            wire[0] = connection.sock
            if time.monotonic() >= deadline:
                raise LookupUnavailable('HTTP deadline exceeded')
            path = urllib.parse.urlunsplit(('', '', parts.path or '/', parts.query, ''))
            connection.request('POST' if request_body is not None else 'GET', path,
                               body=request_body, headers=headers)
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                if request_body is not None:
                    raise LookupUnavailable('upstream POST redirect')
                url = urllib.parse.urljoin(url, response.getheader('Location') or '')
                continue
            if response.status != 200:
                raise LookupUnavailable('upstream HTTP error')
            length = response.getheader('Content-Length')
            if length is not None and int(length) > MAX_RESPONSE_BYTES:
                raise LookupUnavailable('upstream response too large')
            body = bytearray()
            while True:
                if time.monotonic() >= deadline:
                    raise LookupUnavailable('HTTP deadline exceeded')
                chunk = response.read1(min(65536, MAX_RESPONSE_BYTES + 1 - len(body)))
                if time.monotonic() >= deadline:
                    raise LookupUnavailable('HTTP deadline exceeded')
                if not chunk:
                    return json.loads(body.decode('utf-8'))
                body.extend(chunk)
                if len(body) > MAX_RESPONSE_BYTES:
                    raise LookupUnavailable('upstream response too large')
        finally:
            watchdog.cancel()
            # Join before advancing a redirect: the closure must never abort a
            # later connection after its own request has completed.
            watchdog.join()
            if response is not None:
                response.close()
            connection.close()
    raise LookupUnavailable('too many upstream redirects')


def _candidate(hash_value, name, size, seeders, quality, source, max_bytes):
    try:
        size, seeders = int(size), int(seeders)
    except (TypeError, ValueError, OverflowError):
        return None
    if (not isinstance(hash_value, str) or not _HASH_RE.fullmatch(hash_value)
            or hash_value == '0' * 40 or not isinstance(name, str) or len(name) > 1024
            or source not in ('yts', 'apibay', 'knaben')
            or quality not in ('2160p', '1080p')
            or not MIN_BYTES <= size <= max_bytes or seeders < 5):
        return None
    return {'hash': hash_value.lower(), 'name': name, 'size': size,
            'quality': quality, 'seeders': seeders, 'source': source}


def _best(rows):
    return max(rows, key=lambda r: (r['quality'] == '2160p', r['seeders']), default=None)


def verify(item, max_bytes, http_json=None, monotonic=None):
    """YTS releases are proper encodes; all other candidates need name filters."""
    monotonic = monotonic or time.monotonic
    deadline = monotonic() + LOOKUP_TIMEOUT
    fetch = http_json or (lambda url, **kwargs: _http_json(url, deadline=deadline, **kwargs))
    def checked_fetch(url, json_body=None):
        if monotonic() >= deadline:
            raise LookupUnavailable('lookup deadline exceeded')
        payload = fetch(url, json_body=json_body) if json_body is not None else fetch(url)
        if monotonic() >= deadline:
            raise LookupUnavailable('lookup deadline exceeded')
        return payload
    tv = item['kind'] == 'tv'
    yts_answered = tv
    if not tv:
        for base in YTS_BASES:
            try:
                payload = checked_fetch(base + '/list_movies.json?' + urllib.parse.urlencode(
                    {'query_term': item.get('imdb') or item['title']}))
                if payload.get('status') != 'ok' or not isinstance(payload.get('data'), dict):
                    raise LookupUnavailable()
                candidates = []
                for movie in payload['data'].get('movies', []):
                    title = movie.get('title') or ''
                    identity_name = '%s %s' % (title, movie.get('year', ''))
                    if not _identity(movie, item, identity_name):
                        continue
                    for torrent in movie.get('torrents', []):
                        quality = torrent.get('quality')
                        name = '%s %s YTS' % (identity_name, quality)
                        if _is_cam(str(torrent.get('type', ''))):
                            continue
                        candidate = _candidate(torrent.get('hash'), name,
                                               torrent.get('size_bytes'), torrent.get('seeds'),
                                               quality, 'yts', max_bytes)
                        if candidate:
                            candidates.append(candidate)
                best = _best(candidates)
                if best:
                    return 'verified', best
                yts_answered = True
                # An empty mirror may lag: try the second base before other sources.
            except Exception:
                pass
    candidates = []
    def add_candidate(row, source):
        if not isinstance(row, dict):
            return
        name = row.get('name') or ''
        if not isinstance(name, str):
            return
        name = html.unescape(name)
        if not _identity(row, item, name, tv=tv):
            return
        metadata = _release_metadata(name, item['title'])
        if _is_cam(metadata) or (not tv and (_PACK_RE.search(metadata) or _EPISODE_RE.search(metadata))):
            return
        candidate = _candidate(row.get('info_hash'), name, row.get('size'),
                               row.get('seeders'), _parse_quality(metadata), source, max_bytes)
        if candidate:
            candidates.append(candidate)
    apibay_answered = True
    for cat in ((205,) if tv else (201, 207)):
        try:
            rows = checked_fetch('https://apibay.org/q.php?' + urllib.parse.urlencode(
                {'q': item['title'], 'cat': cat}))
            if not isinstance(rows, list):
                raise LookupUnavailable()
            for row in rows:
                add_candidate(row, 'apibay')
        except Exception:
            apibay_answered = False
    knaben_answered = False
    try:
        query = item['title']
        if not tv and item['year'] is not None:
            query += ' %s' % item['year']
        payload = checked_fetch('https://api.knaben.org/v1', json_body={
            'query': query, 'order_by': 'seeders', 'order_direction': 'desc',
            'size': 100, 'hide_unsafe': True, 'hide_xxx': True})
        if not isinstance(payload, dict) or not isinstance(payload.get('hits'), list):
            raise LookupUnavailable()
        for hit in payload['hits']:
            if not isinstance(hit, dict):
                continue
            categories = hit.get('categoryId')
            if not isinstance(categories, list) or not any(
                    type(cat) is int and cat // 1000000 == (2 if tv else 3)
                    for cat in categories):
                continue
            add_candidate(dict(hit, name=hit.get('title'), info_hash=hit.get('hash'),
                               size=hit.get('bytes')), 'knaben')
        knaben_answered = True
    except Exception:
        pass
    best = _best(candidates)
    if best:
        return 'verified', None if tv else best
    if not yts_answered or not (apibay_answered or knaben_answered):
        raise LookupUnavailable()
    return 'unverified', None


def _item(value):
    if (not isinstance(value, dict) or not isinstance(value.get('title'), str)
            or len(value['title']) > 300 or not 0 < len(_norm(value['title'])) <= 300
            or value.get('kind') not in ('movie', 'tv')):
        raise ValueError('each item needs title and kind movie or tv')
    year = value.get('year')
    if year is not None and (type(year) is not int or not 1800 <= year <= 2200):
        raise ValueError('year must be an integer or null')
    imdb = value.get('imdb')
    if imdb is not None and (not isinstance(imdb, str) or len(imdb) > 32 or not _imdb(imdb)):
        raise ValueError('imdb must be a valid IMDb id or null')
    tmdb = value.get('tmdb_id')
    if tmdb is not None and (type(tmdb) is not int or tmdb <= 0):
        raise ValueError('tmdb_id must be an integer or null')
    return {'title': value['title'].strip(), 'kind': value['kind'], 'year': year,
            'imdb': _imdb(imdb) or None, 'tmdb_id': tmdb}


def item_key(item):
    return json.dumps([item['kind'], _norm(item['title']), item.get('year'),
                       item.get('imdb')], ensure_ascii=True, separators=(',', ':'))


class Catalog:
    def __init__(self, path, clock=time.time, lookup=verify, workers=4):
        self.path = Path(path)
        self.clock, self.lookup = clock, lookup
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.entries = {}
        self.last_refresh_at = self.next_refresh_at = None
        self.jobs = queue.Queue(maxsize=MAX_QUEUE)
        self.pending = {}
        # Ordered, bounded by MAX_ENTRIES. Deferred identities have no event or
        # copied job payload until there is space in the network queue.
        self.deferred = {}
        self.retry_at = {}
        self.worker_count = workers
        self.threads = []
        self.refresh_thread = self.writer_thread = None
        self.stopped = threading.Event()
        self.dirty = threading.Event()
        self.revision = self.saved_revision = 0
        self.save_error = None
        try:
            with self.path.open('rb') as stream:
                raw = stream.read(MAX_STORE_BYTES + 1)
            if len(raw) > MAX_STORE_BYTES:
                return
            payload = json.loads(raw)
            version = payload.get('verificationVersion')
            current = version == VERIFICATION_VERSION
            for key, entry in payload.get('entries', {}).items():
                if len(self.entries) >= MAX_ENTRIES:
                    break
                try:
                    item = _item(entry['item'])
                    if key != item_key(item) or entry['status'] not in ('verified', 'unverified', 'pending'):
                        continue
                    for field in ('checkedAt', 'lastSeenAt'):
                        value = entry[field]
                        if value is None and field == 'checkedAt':
                            continue
                        if type(value) not in (int, float) or not math.isfinite(value):
                            raise ValueError('invalid timestamp')
                    cap = entry['max_bytes']
                    if type(cap) is not int or not 0 < cap <= MAX_BYTES:
                        continue
                    if not current and version != 2:
                        # Old positives may have passed rules fixed in this version.
                        entry.update(status='pending', best=None, checkedAt=None, needsCheck=True)
                    elif entry['status'] == 'verified' and item['kind'] == 'movie':
                        best = entry.get('best') or {}
                        if not _candidate(best.get('hash'), best.get('name', ''), best.get('size'),
                                          best.get('seeders'), best.get('quality'),
                                          best.get('source'), cap):
                            continue
                    elif entry['status'] != 'verified':
                        entry['best'] = None
                        if version == 2:
                            entry.update(checkedAt=None, needsCheck=True)
                    self.entries[key] = entry
                    if entry.get('needsCheck'):
                        self.deferred[key] = None
                except (KeyError, TypeError, ValueError, AttributeError, OverflowError):
                    continue
            self.last_refresh_at = payload.get('lastRefreshAt')
        except (OSError, ValueError, TypeError, AttributeError):
            pass

    def _write_snapshot(self, snapshot):
        """Only the writer calls this; serialization and I/O hold no catalog lock."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp = tempfile.mkstemp(prefix='.' + self.path.name, dir=str(self.path.parent))
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                json.dump(snapshot, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, self.path)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)

    def _dirty_locked(self):
        self.revision += 1
        self.dirty.set()
        if self.writer_thread is None:
            self.writer_thread = threading.Thread(target=self._writer, name='catalog-store', daemon=True)
            self.writer_thread.start()

    def _writer(self):
        while not self.stopped.is_set():
            if not self.dirty.wait(.2):
                continue
            if self.stopped.wait(.05):
                break  # coalesce rapid request and worker mutations
            with self.lock:
                self.dirty.clear()
                revision = self.revision
                # Entry/item/best dictionaries are replaced, never mutated by
                # the serializer. Only the shallow snapshot holds the lock.
                snapshot = {'verificationVersion': VERIFICATION_VERSION,
                            'entries': {key: dict(entry) for key, entry in self.entries.items()},
                            'lastRefreshAt': self.last_refresh_at}
            try:
                self._write_snapshot(snapshot)
                with self.changed:
                    self.saved_revision = revision
                    self.save_error = None
                    self.changed.notify_all()
            except Exception as exc:
                with self.changed:
                    self.save_error = exc
                    self.dirty.set()
                    self.changed.notify_all()
                self.stopped.wait(1)

    def flush(self, timeout=3):
        """Wait for durable writes at shutdown or in persistence checks."""
        deadline = time.monotonic() + timeout
        with self.changed:
            target = self.revision
            while self.saved_revision < target:
                if self.save_error is not None:
                    raise OSError('catalog storage unavailable') from self.save_error
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('catalog write timed out')
                self.changed.wait(remaining)

    def _start_workers_locked(self):
        if not self.threads:
            for i in range(self.worker_count):
                thread = threading.Thread(target=self._worker, name='catalog-%d' % i, daemon=True)
                self.threads.append(thread)
                thread.start()

    def _enqueue_locked(self, key):
        if key in self.pending:
            return
        entry = self.entries[key]
        entry['needsCheck'] = True
        if self.clock() < self.retry_at.get(key, 0) or len(self.pending) >= MAX_QUEUE:
            self.deferred[key] = None
            return
        self.pending[key] = True
        self.deferred.pop(key, None)
        self.jobs.put_nowait((key, dict(entry['item']), entry['max_bytes']))
        self._start_workers_locked()

    def _drain_deferred_locked(self):
        for _ in range(min(REFRESH_BATCH, len(self.deferred))):
            if len(self.pending) >= MAX_QUEUE:
                break
            key = next(iter(self.deferred))
            del self.deferred[key]
            if key in self.entries:
                self._enqueue_locked(key)

    def _worker(self):
        while not self.stopped.is_set():
            try:
                key, item, cap = self.jobs.get(timeout=.2)
            except queue.Empty:
                continue
            try:
                status, best = self.lookup(item, cap)
                with self.lock:
                    entry = self.entries.get(key)
                    if entry and entry['max_bytes'] == cap:
                        entry.update(status=status, best=best, checkedAt=self.clock(), needsCheck=False)
                        self.retry_at.pop(key, None)
                        self._dirty_locked()
            except Exception:
                with self.lock:
                    self.retry_at[key] = self.clock() + 60
                    self.deferred[key] = None
            finally:
                with self.changed:
                    self.pending.pop(key, None)
                    entry = self.entries.get(key)
                    if entry and entry['max_bytes'] != cap:
                        self.deferred[key] = None
                    self._drain_deferred_locked()
                    self.changed.notify_all()
                self.jobs.task_done()

    def _prune_locked(self, now):
        for key, entry in list(self.entries.items()):
            if now - entry['lastSeenAt'] >= 30 * DAY and key not in self.pending:
                del self.entries[key]
                self.deferred.pop(key, None)
                self.retry_at.pop(key, None)

    def check(self, body):
        if not isinstance(body, dict) or not isinstance(body.get('items'), list):
            raise ValueError('items must be an array')
        if len(body['items']) > MAX_ITEMS:
            raise ValueError('at most %d items per request' % MAX_ITEMS)
        cap, wait = body.get('max_bytes'), body.get('wait_ms', 0)
        if type(cap) is not int or cap <= 0:
            raise ValueError('max_bytes must be a positive integer')
        if type(wait) is not int or not 0 <= wait <= 8000:
            raise ValueError('wait_ms must be an integer from 0 to 8000')
        cap = min(cap, MAX_BYTES)
        items = [_item(value) for value in body['items']]
        deadline = time.monotonic() + wait / 1000
        waiting = set()
        with self.changed:
            if self.save_error is not None:
                raise OSError('catalog storage unavailable') from self.save_error
            now = self.clock()
            mutated = False
            if len(self.entries) >= MAX_ENTRIES:
                before = len(self.entries)
                self._prune_locked(now)
                mutated = before != len(self.entries)
            for item in items:
                key = item_key(item)
                entry = self.entries.get(key)
                if entry is None:
                    if len(self.entries) >= MAX_ENTRIES:
                        continue  # bounded admission: return pending; caller can retry
                    entry = {'item': item, 'status': 'pending', 'best': None,
                             'checkedAt': None, 'lastSeenAt': now, 'max_bytes': cap}
                    self.entries[key] = entry
                    mutated = True
                if entry['lastSeenAt'] != now:
                    entry['lastSeenAt'] = now
                    mutated = True
                if entry['max_bytes'] != cap:
                    entry.update(max_bytes=cap, status='pending', best=None, checkedAt=None)
                    mutated = True
                if entry['checkedAt'] is None or now - entry['checkedAt'] >= DAY:
                    self._enqueue_locked(key)
                    waiting.add(key)
            if mutated:
                self._dirty_locked()
            while any(key in self.pending or (key in self.deferred and
                      self.clock() >= self.retry_at.get(key, 0)) for key in waiting):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self.changed.wait(remaining)
            results = []
            for item in items:
                key = item_key(item)
                entry = self.entries.get(key)
                status, best, checked = 'pending', None, None
                if entry and entry['max_bytes'] == cap:
                    status, best, checked = entry['status'], entry['best'], entry['checkedAt']
                results.append({'key': key, 'title': item['title'], 'kind': item['kind'],
                                'status': status, 'best': best, 'checkedAt': checked})
            return {'results': results}

    def refresh_due(self):
        """Mark daily work once; feed only a bounded batch into the worker queue."""
        with self.lock:
            now = self.clock()
            startup = self.next_refresh_at is None
            if startup or now >= self.next_refresh_at:
                self._prune_locked(now)
                for key, entry in self.entries.items():
                    stale = entry['checkedAt'] is None or now - entry['checkedAt'] >= DAY
                    if ((startup and stale) or (not startup and now - entry['lastSeenAt'] <= 14 * DAY)):
                        if key not in self.pending:
                            entry['needsCheck'] = True
                            self.deferred[key] = None
                self.last_refresh_at = now
                self.next_refresh_at = now + DAY
                self._dirty_locked()
            self._drain_deferred_locked()

    def start_refresh_thread(self):
        with self.lock:
            if self.refresh_thread:
                return
            def run():
                while not self.stopped.is_set():
                    try:
                        self.refresh_due()
                    except Exception:
                        pass
                    self.stopped.wait(1)
            self.refresh_thread = threading.Thread(target=run, name='catalog-refresh', daemon=True)
            self.refresh_thread.start()

    def status(self):
        with self.lock:
            return {'entries': len(self.entries),
                    'verified': sum(e['status'] == 'verified' for e in self.entries.values()),
                    'queue': len(self.pending) + len(self.deferred),
                    'lastRefreshAt': self.last_refresh_at, 'nextRefreshAt': self.next_refresh_at}

    def close(self):
        try:
            self.flush()
        except (OSError, TimeoutError):
            pass
        self.stopped.set()
        self.dirty.set()
        extras = [t for t in (self.refresh_thread, self.writer_thread) if t]
        for thread in self.threads + extras:
            thread.join(timeout=1)


_INSTANCE = None
_INSTANCE_LOCK = threading.Lock()


def get_catalog(cache_root):
    global _INSTANCE
    with _INSTANCE_LOCK:
        if _INSTANCE is None:
            _INSTANCE = Catalog(os.environ.get('DUMIFLIX_CATALOG_PATH') or
                                str(Path(cache_root) / '.catalog.json'))
        return _INSTANCE
