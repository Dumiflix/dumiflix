#!/usr/bin/env python3
"""
DumiFlix TV-native remux HTTP server.

Runs ON the webOS TV (python3), driving the bundled static ffmpeg to
stream-copy a source (seedr signed URL, or a local/USB file) into a rolling
MPEG-TS HLS window that the app's <video> plays over localhost/LAN. This is
the same /playback API used by optional companion engines, so the app's
remux.js uses a common client contract across configured hosts.

Auth model:
  * control routes (POST /playback/start, seek, pause, resume; DELETE) are
    gated by a bearer token -- the app sends X-Playback-Token.
  * media routes (GET status, master.m3u8, segments/*, file) are sid-gated
    only: the <video> element can't send headers, and the unguessable
    session id in the path IS the capability.
"""
import os
import re
import sys
import json
import hmac
import signal
import atexit
import threading
import time
import urllib.parse
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import remux  # noqa: E402
try:
    import subsync  # noqa: E402  — subtitle audio-sync (optional; absent on older builds)
except Exception:
    subsync = None
try:
    import cache  # noqa: E402  — optional engine-local next-episode disk cache
except Exception:
    cache = None
# Gated on BOTH the module being importable AND an explicit opt-in env flag, so
# the exact same server.py binary still runs unmodified wherever cache.py is
# absent or the flag is unset. Cache-enabled deployments opt in explicitly.
CACHE_ENABLED = bool(cache) and os.environ.get('DUMIFLIX_CACHE_ENABLED', '0') == '1'
try:
    import torrent  # noqa: E402  — direct-BitTorrent-to-cache downloader (optional bolt-on;
    #                                enabled only on explicitly configured engine hosts)
except Exception:
    torrent = None
# Torrent execution has two mutually-exclusive modes:
#   local  — local aria2 process (explicit DUMIFLIX_TORRENT_ENABLED=1)
#   remote — this server is only an authenticated control proxy; aria2/DHT/
#            trackers/peers run on an optional remote torrent host, which
#            manages its own storage. No local BitTorrent process or socket
#            is opened in remote mode.
TORRENT_LOCAL_ENABLED = bool(torrent) and os.environ.get('DUMIFLIX_TORRENT_ENABLED', '0') == '1'
TORRENT_REMOTE_URL = os.environ.get('DUMIFLIX_TORRENT_REMOTE_URL', '').rstrip('/')
TORRENT_REMOTE_ENABLED = bool(TORRENT_REMOTE_URL)
TORRENT_ENABLED = TORRENT_LOCAL_ENABLED or TORRENT_REMOTE_ENABLED
TORRENT_LOOPBACK_ONLY = os.environ.get('DUMIFLIX_TORRENT_LOOPBACK_ONLY', '0') == '1'


def _persistent_torrent_queue_status() -> dict:
    """Report unfinished persistent aria2 entries without exposing sources."""
    path = os.environ.get('DUMIFLIX_PERSISTENT_TORRENT_SESSION',
                          '/var/lib/dumiflix-aria2/aria2.session')
    try:
        pending = 0
        with open(path, 'r', encoding='utf-8', errors='replace') as fh:
            for raw in fh:
                stripped = raw.strip()
                if not stripped or stripped.startswith('#') or raw[0].isspace():
                    continue
                pending += 1
        return {'ok': True, 'configured': True, 'pending': pending}
    except FileNotFoundError:
        return {'ok': True, 'configured': False, 'pending': 0}
    except Exception as exc:
        return {'ok': False, 'configured': True, 'pending': None,
                'error': f'persistent queue status failed: {exc}'}


def _torrent_remote(method: str, path: str, body=None) -> tuple:
    """Forward a torrent CONTROL request to the configured remote engine.
    Media bytes do not traverse this HTTP proxy. The remote engine manages
    its own storage; this proxy only forwards control requests.

    Returns (http_status, json_dict), including useful JSON from an HTTPError.
    Every failure is bounded so an unavailable engine cannot strand a TV request.
    """
    if not TORRENT_REMOTE_ENABLED:
        return 503, {'ok': False, 'error': 'remote torrent engine is not configured'}
    data = None
    headers = {'Accept': 'application/json'}
    token = os.environ.get('DUMIFLIX_TORRENT_REMOTE_TOKEN', '')
    if token:
        headers['X-Playback-Token'] = token
    if body is not None:
        data = json.dumps(body).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(TORRENT_REMOTE_URL + path, data=data,
                                 headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            raw = res.read(2 * 1024 * 1024)
            return res.status, json.loads(raw.decode('utf-8', 'replace') or '{}')
    except urllib.error.HTTPError as ex:
        try:
            raw = ex.read(2 * 1024 * 1024)
            payload = json.loads(raw.decode('utf-8', 'replace') or '{}')
        except Exception:
            payload = {'ok': False, 'error': f'Remote torrent HTTP {ex.code}'}
        return ex.code, payload
    except Exception as ex:
        return 502, {'ok': False, 'error': f'Remote torrent engine unavailable: {ex}'}
try:
    import player  # noqa: E402  — optional mpv player (external display / AV receiver;
    #                               laptop-only bolt-on, absent everywhere else)
except Exception:
    player = None
PLAYER_ENABLED = bool(player)
try:
    import webos_ssap  # noqa: E402  — optional stdlib-only LG SSAP client.
    # Pair locally first; its private .webos.json state must not be published.
except Exception:
    webos_ssap = None

# ===========================================================================
# Persistent diagnostics — everything lands in LOG_DIR as dated files
# ===========================================================================
# Two feeds share a folder: console output is mirrored to dated server logs,
# and the TV app's bounded diagnostic ring is shipped over POST /log.
# Persisting that ring preserves crash evidence after its in-memory entries
# rotate away. Choose storage independent of removable media for durability.
LOG_DIR = os.environ.get('DUMIFLIX_LOG_DIR') \
    or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs')
LOG_KEEP_DAYS = int(os.environ.get('DUMIFLIX_LOG_KEEP_DAYS', '30'))
_LOG_FILE_RE = re.compile(r'^[a-z0-9_-]{1,24}-\d{8}\.log$')


def _log_prune():
    """Drop log files older than LOG_KEEP_DAYS. Best-effort."""
    try:
        cutoff = time.time() - LOG_KEEP_DAYS * 86400
        for name in os.listdir(LOG_DIR):
            if not _LOG_FILE_RE.match(name):
                continue
            p = os.path.join(LOG_DIR, name)
            try:
                if os.path.getmtime(p) < cutoff:
                    os.remove(p)
            except OSError:
                pass
    except OSError:
        pass


class _Tee:
    """Mirror a stream into LOG_DIR/server-YYYYMMDD.log with timestamps.

    Rolls over at midnight on write. Every failure path swallows — logging
    must never be the thing that kills the server."""
    def __init__(self, orig):
        self.orig = orig
        self._day = None
        self._f = None
        self._nl = True          # last chunk ended a line -> stamp the next one

    def _file(self):
        day = time.strftime('%Y%m%d')
        if day != self._day:
            try:
                if self._f:
                    self._f.close()
            except Exception:
                pass
            self._f = None
            try:
                os.makedirs(LOG_DIR, exist_ok=True)
                self._f = open(os.path.join(LOG_DIR, 'server-%s.log' % day),
                               'a', encoding='utf-8', errors='replace')
                self._day = day
                _log_prune()
            except Exception:
                self._f = None
        return self._f

    def write(self, s):
        try:
            self.orig.write(s)
        except Exception:
            pass
        f = self._file()
        if f is None:
            return
        try:
            if self._nl:
                f.write(time.strftime('%H:%M:%S '))
            f.write(s)
            self._nl = s.endswith('\n')
            f.flush()
        except Exception:
            pass

    def flush(self):
        try:
            self.orig.flush()
        except Exception:
            pass
        try:
            if self._f:
                self._f.flush()
        except Exception:
            pass


sys.stdout = _Tee(sys.stdout)
sys.stderr = _Tee(sys.stderr)
# Background/on-demand subtitle GENERATION (Whisper transcription written as
# a cache-sidecar .en.srt -- see subsync.generate_sub) needs BOTH the cache
# bolt-on (sidecars live under CACHE_ROOT, served via /cache/subs) and
# subsync's own Whisper-model gate (subsync.subgen_enabled() -- default on
# whenever DUMIFLIX_WHISPER_MODEL is configured+present, opt-out via
# DUMIFLIX_SUBGEN_ENABLED=0). Computed once at import time like CACHE_ENABLED/
# TORRENT_ENABLED above; used only to report readiness on /health -- the
# /cache/subs and /subgen routes below re-check the same condition per
# request via cache.py (which itself calls subsync.subgen_enabled()).
SUBGEN_ENABLED = CACHE_ENABLED and bool(subsync) and subsync.subgen_enabled()
try:
    import season  # noqa: E402  — optional persistent season prefetch queue
except Exception:
    season = None
# Needs the cache to land files in, so it rides on the same gate. No separate
# env flag: a host with the cache on is exactly a host that can prefetch.
SEASON_ENABLED = CACHE_ENABLED and bool(season)

PORT = int(os.environ.get('DUMIFLIX_TV_PORT', '9891'))
TOKEN = os.environ.get('DUMIFLIX_TV_TOKEN', '')      # empty -> control routes open; keep the default loopback bind
_READ_CAP = 4 * 1024 * 1024
GROWING_NO_PROGRESS_SECONDS = 30.0
_TV_APP_ID = 'com.dumiflix.tv'   # must match tv-app/appinfo.json's "id" — SSAP launch target


def _redacted_path(path):
    """Keep request diagnostics without recording query credentials."""
    parts = urllib.parse.urlsplit(path)
    query = urllib.parse.urlencode([
        (key, '[redacted]' if key.lower() == 'token' else value)
        for key, value in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    ])
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, query, ''))


def _byte_range(value, total):
    """Parse one byte range for both completed and growing cache responses."""
    if not value or not value.startswith('bytes=') or ',' in value:
        return 0, total - 1, 200
    match = re.fullmatch(r'bytes=(\d*)-(\d*)', value)
    if not match or not any(match.groups()):
        raise ValueError('invalid range')
    a, b = match.groups()
    start = int(a) if a else max(0, total - int(b))
    end = min(int(b), total - 1) if a and b else total - 1
    if start < 0 or start >= total or end < start:
        raise ValueError('unsatisfiable range')
    return start, end, 206


class DumiHTTPServer(ThreadingHTTPServer):
    # Python enables SO_REUSEADDR for HTTPServer. On Unix that only permits a
    # quick restart after TIME_WAIT; on Windows it permits MULTIPLE live
    # listeners on the same address/port. Requests were consequently split
    # between three independent queue/index/subtitle state machines. Bind
    # exclusively on Windows so a duplicate launcher fails loudly instead.
    allow_reuse_address = os.name != 'nt'


class _RequestBodyTooLarge(Exception):
    """Stop dispatch after sending the sole response for an oversized body."""


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    # Per-connection socket timeout. Without it, ThreadingHTTPServer spawns one
    # unbounded thread per connection with NO timeout, so a slow/stalled client
    # (declares Content-Length then trickles bytes, or holds a keep-alive
    # socket idle) pins a handler thread forever -- unbounded thread/fd growth.
    # 120s comfortably exceeds any legitimate LAN request (segments are a few
    # MB over LAN; the TV polls status every ~5s during playback), so a real
    # client never trips it, while a wedged one is reclaimed. Overridable.
    timeout = int(os.environ.get('DUMIFLIX_TV_CONN_TIMEOUT') or 120)

    def log_message(self, *a):        # quiet; the service captures stdout
        pass

    def handle(self):
        # A client vanishing mid-request (TV app killed, seek abandoning a
        # segment fetch, Windows 10054 resets) is ROUTINE here, but the
        # default ThreadingHTTPServer prints a full traceback per event --
        # thousands of noise lines per session in server.log. Swallow just
        # the disconnect family; real bugs still traceback as before.
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError,
                TimeoutError, _RequestBodyTooLarge):
            pass

    # ---------- helpers ----------
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        if self.close_connection:
            self.send_header('Connection', 'close')
        # No forced `Connection: close`: protocol_version is HTTP/1.1 and
        # every response here already sends a correct Content-Length, the
        # only prerequisite for coherent keep-alive framing -- so the
        # default keep-alive applies and a poller (playlist/status) doesn't
        # pay for a brand-new TCP connection + thread on every request.
        self.end_headers()
        if self.command == 'HEAD':
            return
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _read_json(self):
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except (TypeError, ValueError):
            n = 0
        if n > _READ_CAP:
            self.close_connection = True
            self._json(413, {'error': 'request body too large'})
            raise _RequestBodyTooLarge()
        try:
            raw = self.rfile.read(n) if n else b''
            return json.loads(raw or b'{}')
        except Exception:
            return {}

    def _authed(self) -> bool:
        if not TOKEN:
            return True                # no token configured: trust local caller
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        tok = qs.get('token', [None])[0] or self.headers.get('X-Playback-Token')
        if tok and hmac.compare_digest(str(tok), TOKEN):
            return True
        auth = (self.headers.get('Authorization') or '').strip()
        if auth.lower().startswith('bearer '):
            return hmac.compare_digest(auth[7:].strip(), TOKEN)
        return False

    def _unauthorized(self):
        # Drain any pending POST body off self.rfile before replying: with
        # keep-alive now the default (see _json), an unread body left in the
        # socket buffer would corrupt the next pipelined request's framing
        # on this same reused connection.
        self._read_json()
        # A 401 on a control route is ALWAYS worth a log line: it's the
        # signature of a token mismatch between the app and this engine
        # (e.g. the app still carrying another engine's token after a host
        # switch), which otherwise fails perfectly silently.
        try:
            print('[tv-remux] 401 unauthorized %s %s' % (
                getattr(self, 'command', '?'), _redacted_path(self.path)),
                file=sys.stderr, flush=True)
        except Exception:
            pass
        return self._json(401, {'error': 'unauthorized'})

    def _split(self, path):
        tail = path[len('/playback/'):]
        sid, _, rest = tail.partition('/')
        return sid, rest

    def _reply(self, result):
        if isinstance(result, dict) and 'error' in result and isinstance(result.get('status'), int):
            # Engine failures used to vanish into a silent JSON error -- the
            # single most expensive blind spot when diagnosing "why didn't it
            # play". One line per failed control call; query strings stripped
            # so signed source URLs never land in the log.
            try:
                msg = re.sub(r'\?\S*', '?...', str(result['error']))
                if len(msg) > 500:
                    msg = msg[:200] + ' … ' + msg[-280:]   # verdict lives at the tail
                print('[tv-remux] %s %s -> %s %s' % (
                    getattr(self, 'command', '?'), _redacted_path(self.path),
                    result['status'], msg), file=sys.stderr, flush=True)
            except Exception:
                pass
            return self._json(result['status'], {'error': result['error']})
        return self._json(200, result)

    def _stream_file(self, target, head_only=False, mime=None):
        try:
            size = target.stat().st_size
        except OSError:
            return self._json(404, {'error': 'not found'})
        try:
            start, end, status = _byte_range(self.headers.get('Range'), size)
        except ValueError:
            return self._range_unsatisfiable(size)
        length = max(0, end - start + 1)
        if mime is None:
            mime = 'video/mp2t' if str(target).endswith('.ts') else 'application/octet-stream'
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(length))
        self.send_header('Accept-Ranges', 'bytes')
        if status == 206:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache')
        # No forced `Connection: close` here either (see _json) -- Content-
        # Length is already correct above for both the 200 and 206 cases, so
        # keep-alive framing is coherent and a segment-fetch burst right
        # after start/seek doesn't pay for a fresh TCP connection + thread
        # per segment. The one case that DOES need to close the connection
        # is a body that ends up shorter than the Content-Length we already
        # promised (an early break/exception below) -- that's handled by
        # explicitly setting self.close_connection = True so a truncated
        # body can never corrupt the framing of the next reused request.
        self.end_headers()
        if head_only:
            return
        try:
            with open(target, 'rb') as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        self.close_connection = True   # short write -- don't reuse this connection
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, OSError):
            self.close_connection = True   # body cut short -- framing is now unreliable

    def _stream_growing_cache(self, rel, head_only=False):
        """Serve a validated partial cache file while its missing bytes grow.

        Content-Length/Content-Range describe the final origin size. Reads
        wait only when they reach a not-yet-written gap; the accelerated tail
        is independently readable for players that request metadata there.
        """
        job = cache.job_for_rel(rel)
        if job is None:
            target = cache.stream_target(rel)
            if target is None:
                return self._json(404, {'error': 'not cached'})
            return self._stream_file(target, head_only=head_only)
        if job.get('state') != 'ready' and not cache.progressive_ready(job):
            return self._json(409, {'error': 'growing cache is not ready'})
        total = int(job.get('total') or 0)
        if total <= 0:
            return self._json(409, {'error': 'growing cache size is unknown'})

        try:
            start, end, status = _byte_range(self.headers.get('Range'), total)
        except ValueError:
            return self._range_unsatisfiable(total)
        length = end - start + 1
        self.send_response(status)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(length))
        self.send_header('Accept-Ranges', 'bytes')
        if status == 206:
            self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, total))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if head_only:
            return

        pos = start
        # Only the TV's own handoff URL proves the player has left Seedr; any
        # other reader of the growing file must not open an extra origin lane.
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        index_requested = query.get('player', [''])[0] != 'tv'
        last_progress = time.monotonic()
        received = int(job.get('received') or 0)
        published = sum(b - a for a, b in cache.growing_ranges(job))
        try:
            while pos <= end:
                state = job.get('state')
                now_received = int(job.get('received') or 0)
                ranges = cache.growing_ranges(job)
                now_published = sum(b - a for a, b in ranges)
                # A seek can wait ahead of the copier for longer than the
                # deadline. Progress elsewhere in the job keeps that wait live.
                if now_received > received or now_published > published:
                    last_progress = time.monotonic()
                received = max(received, now_received)
                published = max(published, now_published)
                if (state in ('error', 'aborted') or job.get('_cancel')
                        or time.monotonic() - last_progress >= GROWING_NO_PROGRESS_SECONDS):
                    self.close_connection = True
                    break
                # The same snapshot answers availability: one range read per chunk.
                available = next((min(end + 1, b) for a, b in ranges if a <= pos < b), pos)
                if available <= pos:
                    info = job.get('_container_index') or {}
                    index_start = int(info.get('start') or 0)
                    if (not index_requested and not info.get('seekhead')
                            and 0 < index_start <= pos < total
                            and total - index_start <= cache.GROWING_INDEX_MAX_BYTES
                            and job.get('range_supported')):
                        # The TV player has left Seedr. Ask once per request
                        # so a failed lane waits for a later read.
                        if not job.get('_index_active'):
                            job['_index_wanted'] = True
                        index_requested = True
                    time.sleep(0.04)
                    continue
                target = cache.growing_target(job)
                if target is None:
                    # Atomic .part -> final rename can occur between the state
                    # and path reads; retry the new name on the next turn.
                    time.sleep(0.02)
                    continue
                want = min(1024 * 1024, available - pos)
                try:
                    with open(target, 'rb') as f:
                        f.seek(pos)
                        chunk = f.read(want)
                except OSError:
                    time.sleep(0.02)
                    continue
                if not chunk:
                    time.sleep(0.02)
                    continue
                self.wfile.write(chunk)
                pos += len(chunk)
                last_progress = time.monotonic()
        except (BrokenPipeError, ConnectionResetError, OSError):
            self.close_connection = True

    def _range_unsatisfiable(self, total):
        self.send_response(416)
        self.send_header('Content-Range', 'bytes */%d' % total)
        self.send_header('Content-Length', '0')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

    # ---------- routes ----------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, HEAD, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Playback-Token, Authorization')
        self.send_header('Content-Length', '0')
        # No forced `Connection: close` (see _json) -- keep-alive is fine
        # for a zero-length preflight response.
        self.end_headers()

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if CACHE_ENABLED and path == '/catalog/status':
            if not self._authed():
                return self._unauthorized()
            import catalog
            return self._json(200, catalog.get_catalog(cache.CACHE_ROOT).status())
        if (TORRENT_ENABLED and TORRENT_LOOPBACK_ONLY and
                path.startswith('/torrent/') and self.client_address[0] not in ('127.0.0.1', '::1')):
            return self._json(403, {'ok': False, 'error': 'torrent control requires loopback access'})
        if PLAYER_ENABLED and path == '/player/status':
            if not self._authed():
                return self._unauthorized()
            return self._json(200, player.player_status())

        if PLAYER_ENABLED and path == '/remote':
            # Minimal LAN remote for laptop playback. Needed because webOS
            # SUSPENDS the TV app while the TV shows the HDMI input — nothing
            # on the TV can pause/seek. Open on the phone browser:
            #   http://<LAPTOP_HOST>:9891/remote?token=...
            if not self._authed():
                return self._unauthorized()
            html = _REMOTE_HTML.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(html)))
            self.end_headers()
            try:
                self.wfile.write(html)
            except OSError:
                pass
            return

        if path == '/log/list':
            # Remote diagnosis without SSH: what logs exist, how big.
            if not self._authed():
                return self._unauthorized()
            out = []
            try:
                for name in sorted(os.listdir(LOG_DIR)):
                    if not _LOG_FILE_RE.match(name):
                        continue
                    p = os.path.join(LOG_DIR, name)
                    try:
                        out.append({'file': name, 'size': os.path.getsize(p),
                                    'mtime': int(os.path.getmtime(p))})
                    except OSError:
                        pass
            except OSError:
                pass
            return self._json(200, {'ok': True, 'dir': LOG_DIR, 'files': out})

        if path == '/log/tail':
            # Last N lines of one log file (default: today's tv log).
            if not self._authed():
                return self._unauthorized()
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            name = (qs.get('file') or ['tv-%s.log' % time.strftime('%Y%m%d')])[0]
            n = max(1, min(2000, int((qs.get('n') or ['300'])[0] or 300)))
            if not _LOG_FILE_RE.match(name):
                return self._json(400, {'error': 'bad file name'})
            p = os.path.join(LOG_DIR, name)
            if not os.path.isfile(p):
                return self._json(404, {'error': 'no such log', 'file': name})
            try:
                with open(p, 'rb') as f:
                    # Read at most the trailing 1 MB — plenty for 2000 lines.
                    f.seek(0, 2)
                    size = f.tell()
                    f.seek(max(0, size - 1048576))
                    lines = f.read().decode('utf-8', 'replace').splitlines()[-n:]
            except OSError as ex:
                return self._json(500, {'error': str(ex)})
            return self._json(200, {'ok': True, 'file': name, 'lines': lines})

        if path == '/health':
            # UNAUTHENTICATED contract: {ok, host, ffmpeg, port} ONLY. The
            # cache_* fields are added ONLY when the caller is authed (they
            # disclose disk usage/paths on a public IP) -- LaptopCache.reachable()
            # always sends the token, so it still sees cache_enabled===true.
            payload = {'ok': True, 'host': 'tv', 'ffmpeg': remux.ensure_ffmpeg_staged(),
                       'port': PORT}
            authed = self._authed()
            if CACHE_ENABLED and authed:
                info = cache.status_summary(max_age=30.0)   # keep the TV's probe fast
                payload.update({
                    'cache_enabled': True,
                    'cache_root': info['root'],
                    'cache_used_bytes': info['used'],
                    'cache_cap_bytes': info['cap'],
                    'cache_floor_bytes': info['floor'],
                    'cache_free_disk_bytes': info['free'],
                })
                direct = info.get('direct_http') or {}
                payload['cache_direct_http_enabled'] = bool(direct.get('enabled'))
                payload['cache_direct_http_configured'] = bool(direct.get('configured'))
            if TORRENT_ENABLED and authed:
                payload['torrent_enabled'] = True
                # `vps` is the historical protocol value for an optional remote engine.
                payload['torrent_mode'] = 'vps' if TORRENT_REMOTE_ENABLED else 'local'
                if TORRENT_LOCAL_ENABLED:
                    payload.update({
                        'torrent_staging_root': str(torrent.STAGING_ROOT),
                        'torrent_staging_free_bytes': torrent._staging_free_bytes(),
                        'torrent_staging_floor_bytes': torrent.STAGING_FREE_FLOOR_BYTES,
                    })
            if SUBGEN_ENABLED and authed:
                payload['subs_enabled'] = True
            return self._json(200, payload)
        if SEASON_ENABLED and path == '/season/status':
            if not self._authed():
                return self._unauthorized()
            return self._json(200, season.status())

        if CACHE_ENABLED and path == '/cache/active':
            if not self._authed():
                return self._unauthorized()
            return self._json(200, cache.playback_active())
        if CACHE_ENABLED and path == '/cache/list':
            if not self._authed():
                return self._unauthorized()
            info = cache.status_summary()
            # Served from the listing index (cache.listing_files), not a live
            # walk: recursive traversal and per-file manifest reads can delay
            # next-episode lookup and Library browsing on slow storage.
            # id/rel stay the stable hashed identifier (the fileId round-trips
            # through self-heal + streaming on it); name is the real original
            # filename from the display-name index.
            info['files'] = cache.listing_files()
            return self._json(200, info)
        if CACHE_ENABLED and path == '/cache/resolve':
            # Contract (shared with the TV app): "does this exact release filename already have a
            # COMPLETED local copy" -- lets the client skip straight to
            # /cache/stream/<rel> instead of routing a seedr URL through
            # /playback/start and paying remux.py's own (now indexed, see
            # /cache/list above) _resolve_cached_copy() lookup. Same
            # token-gating + CORS (via _json) as every sibling /cache/*
            # route; served from the SAME indexed listing, never a live
            # walk, so this is O(1) exactly like /cache/list.
            if not self._authed():
                return self._unauthorized()
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            # parse_qs has already percent-decoded the value -- a second
            # unquote() would corrupt names containing literal '%NN' runs
            # (e.g. "100%20Off" would become "100 Off" and 404).
            name = (qs.get('name') or [''])[0].strip()
            if not name:
                return self._json(400, {'error': 'missing name'})
            # Exact basename match against the SAME two candidates
            # remux._resolve_cached_copy() checks: the on-disk rel's own
            # basename (matches in un-hashed LAN mode) OR the recorded
            # original filename (matches in the default hashed-filename
            # mode). listing_files() already lists ONLY completed files
            # (cache_files() excludes '*.part' and any dot-prefixed
            # staging subtree), so every candidate here is by definition
            # "COMPLETED". Ties broken by (size, mtime) descending --
            # largest, then newest -- for a deterministic pick among
            # multiple matches.
            best = None
            for f in cache.listing_files():
                rel = f.get('rel') or ''
                rel_base = rel.rsplit('/', 1)[-1]
                if rel_base != name and f.get('name') != name:
                    continue
                key = (f.get('size', 0), f.get('mtime', 0))
                if best is None or key > (best.get('size', 0), best.get('mtime', 0)):
                    best = f
            if best is None:
                return self._json(404, {'error': 'not cached'})
            return self._json(200, {'rel': best['rel'], 'size': best.get('size', 0)})
        if CACHE_ENABLED and path == '/cache/subs':
            if not self._authed():
                return self._unauthorized()
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            # parse_qs already percent-decoded these (see /cache/resolve).
            rel = (qs.get('rel') or [''])[0]
            fp = (qs.get('fp') or [''])[0] or None
            if not rel:
                return self._json(400, {'error': 'missing rel'})
            target = cache.subs_baked_target(rel, fp)
            if target is None:
                state = cache.subs_state(rel, fp).get('state', 'none')
                return self._json(404, {'error': 'not ready', 'state': state})
            return self._stream_file(target, mime='application/x-subrip; charset=utf-8')
        if CACHE_ENABLED and path == '/cache/subs/state':
            if not self._authed():
                return self._unauthorized()
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            # parse_qs already percent-decoded these (see /cache/resolve).
            rel = (qs.get('rel') or [''])[0]
            fp = (qs.get('fp') or [''])[0] or None
            if not rel:
                return self._json(400, {'error': 'missing rel'})
            return self._json(200, cache.subs_state(rel, fp))
        if CACHE_ENABLED and path == '/cache/thumbs':
            # Trick-play storyboard manifest -- streaming-style paused/
            # scrubbing seek-bar previews. Contract (agreed with the TV-app
            # agent working the client side in parallel):
            #   200 {state:'ready', interval, tileWidth, tileHeight, cols,
            #        rows, count, duration, sheets:[...]} once generated
            #   202 {state:'generating'} -- and (re)kicks generation, cached
            #        file with no sheets yet (never started, mid-pass, or a
            #        prior attempt errored -- all retry the same way)
            #   404 {error:'not cached'} -- rel isn't a completed cache file
            if not self._authed():
                return self._unauthorized()
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            # parse_qs already percent-decoded this (see /cache/resolve --
            # never unquote() an already-decoded parse_qs value again).
            rel = (qs.get('rel') or [''])[0]
            if not rel:
                return self._json(400, {'error': 'missing rel'})
            try:
                target = cache.stream_target(rel)
            except Exception:
                target = None
            if target is None:
                return self._json(404, {'error': 'not cached'})
            manifest = cache.thumbs_state(rel)
            if manifest.get('state') == 'ready':
                enc_rel = urllib.parse.quote(rel, safe='')
                sheet_count = int(manifest.get('sheetCount') or 0)
                sheets = ['/cache/thumbs/sheet?rel=%s&i=%d' % (enc_rel, i)
                          for i in range(sheet_count)]
                return self._json(200, {
                    'state': 'ready',
                    'interval': manifest.get('interval'),
                    'tileWidth': manifest.get('tileWidth'),
                    'tileHeight': manifest.get('tileHeight'),
                    'cols': manifest.get('cols'),
                    'rows': manifest.get('rows'),
                    'count': manifest.get('count'),
                    'duration': manifest.get('duration'),
                    'sheets': sheets,
                })
            # Not ready (never attempted / mid-generation / a previous
            # attempt errored) -- queue_thumbs() is single-flight and
            # idempotent, so a poll storm from concurrent scrub requests
            # never launches more than one ffmpeg pass for this rel.
            cache.queue_thumbs(rel)
            return self._json(202, {'state': 'generating'})
        if CACHE_ENABLED and path == '/cache/thumbs/sheet':
            # Sheet JPEG. Token-gated the same way as the manifest above,
            # but NOTE: the TV app's <img>/CSS loaders that actually fetch
            # this can't send X-Playback-Token, so these URLs arrive with
            # ?token=... instead -- _authed() already accepts that.
            if not self._authed():
                return self._unauthorized()
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            # parse_qs already percent-decoded these (see /cache/resolve).
            rel = (qs.get('rel') or [''])[0]
            i = (qs.get('i') or [''])[0]
            if not rel:
                return self._json(400, {'error': 'missing rel'})
            target = cache.thumbs_sheet_path(rel, i)
            if target is None:
                return self._json(404, {'error': 'not found'})
            return self._stream_file(target, mime='image/jpeg')
        if CACHE_ENABLED and path.startswith('/cache/status'):
            if not self._authed():
                return self._unauthorized()
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            job_id = (qs.get('id') or [''])[0]
            job = cache._JOBS.get(job_id)
            if not job:
                return self._json(404, {'ok': False, 'id': job_id, 'rel': None, 'state': 'unknown',
                                        'ranges': [], 'bytesPerSec': 0})
            size = job.get('received', 0)
            rel = job.get('rel')
            return self._json(200, {
                'ok': True, 'id': job_id, 'rel': rel, 'state': job.get('state'),
                'size': size, 'received': size, 'total': job.get('total', 0),
                'contiguous': job.get('contiguous', size if job.get('state') == 'ready' else 0),
                'progressiveReady': cache.progressive_ready(job),
                'rangeSupported': bool(job.get('range_supported')),
                'accelerated': bool(job.get('_accelerated')),
                'ranges': cache.growing_ranges(job),
                'bytesPerSec': cache.bytes_per_sec(job),
                'error': job.get('error'),
                'subs_ready': cache.subs_ready(rel) if rel else False,
                'subs_url': cache.subs_url(rel) if rel else None,
            })
        if CACHE_ENABLED and path.startswith('/cache/growing/'):
            if not self._authed():
                return self._unauthorized()
            rel = urllib.parse.unquote(path[len('/cache/growing/'):])
            cache.hold(rel)
            try:
                return self._stream_growing_cache(rel)
            finally:
                cache.release(rel)
        if CACHE_ENABLED and path.startswith('/cache/stream/'):
            if not self._authed():
                return self._unauthorized()
            rel = urllib.parse.unquote(path[len('/cache/stream/'):])
            # hold() BEFORE resolving the file, so there is no window between
            # confirming it exists and protecting it in which the 60s sweep or
            # a concurrent download's eviction could delete it. Holding a not-
            # yet-resolved rel is harmless (the registry is keyed purely on the
            # string). release() no matter how the response ends (BrokenPipe, a
            # Range read, any error).
            cache.hold(rel)
            try:
                target = cache.stream_target(rel)
                if target is None:
                    return self._json(404, {'error': 'not cached'})
                return self._stream_file(target)
            finally:
                cache.release(rel)
        if TORRENT_ENABLED and path == '/torrent/list':
            if not self._authed():
                return self._unauthorized()
            if TORRENT_REMOTE_ENABLED:
                code, res = _torrent_remote('GET', '/torrent/list')
                return self._json(code, res)
            return self._json(200, {'ok': True, 'jobs': torrent.active_list()})
        if TORRENT_ENABLED and path == '/torrent/queue-status':
            if not self._authed():
                return self._unauthorized()
            if TORRENT_REMOTE_ENABLED:
                code, res = _torrent_remote('GET', '/torrent/queue-status')
                return self._json(code, res)
            jobs = torrent.active_list()
            persistent = _persistent_torrent_queue_status()
            ok = bool(persistent.get('ok'))
            busy = (not ok or bool(jobs) or
                    int(persistent.get('pending') or 0) > 0)
            return self._json(200 if ok else 503, {
                'ok': ok,
                'busy': busy,
                'activeJobs': len(jobs),
                'persistent': persistent,
            })
        if TORRENT_ENABLED and path == '/torrent/status':
            if not self._authed():
                return self._unauthorized()
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            job_id = (qs.get('id') or [''])[0]
            if TORRENT_REMOTE_ENABLED:
                code, res = _torrent_remote(
                    'GET', '/torrent/status?id=' + urllib.parse.quote(job_id, safe=''))
                return self._json(code, res)
            res = torrent.status(job_id)
            return self._json(200 if res.get('ok') else 404, res)
        if path == '/tv/relaunch/test':
            # Side-effect-free SSAP sanity check. Confirm the configured TV
            # is reachable and the local pairing key works before using the
            # relaunch endpoint. Not called by the TV app itself.
            if not self._authed():
                return self._unauthorized()
            if webos_ssap is None:
                return self._json(503, {'error': 'ssap unavailable'})
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            ip = (qs.get('ip') or [''])[0].strip()
            if not ip:
                return self._json(400, {'error': 'missing ip'})
            try:
                info = webos_ssap.WebOSManager(ip).call('ssap://system/getSystemInfo')
                print('[tv-relaunch] test ip=%s -> ok' % ip, file=sys.stderr, flush=True)
                return self._json(200, {'ok': True, 'target': ip, 'info': info})
            except Exception as e:
                print('[tv-relaunch] test ip=%s -> %s' % (ip, e), file=sys.stderr, flush=True)
                return self._json(502, {'error': str(e)})
        if path.startswith('/playback/'):
            sid, rest = self._split(path)
            if not sid:
                return self._json(400, {'error': 'missing session id'})
            if rest == 'status':
                return self._reply(remux.playback_status(sid))
            if rest == 'master.m3u8':
                data, mime = remux.get_playlist(sid)
                if data is None:
                    return self._json(404, {'error': 'playlist not ready'})
                self.send_response(200)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-cache, no-store')
                self.send_header('Access-Control-Allow-Origin', '*')
                # No forced `Connection: close` (see _json) -- Content-Length
                # is already set above, so keep-alive framing is coherent
                # and every playlist poll doesn't pay for a fresh connection.
                self.end_headers()
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    self.close_connection = True
                return
            if rest.startswith('segments/'):
                tgt = remux.get_segment(sid, urllib.parse.unquote(rest[len('segments/'):]))
                if not tgt:
                    return self._json(404, {'error': 'segment not found'})
                return self._stream_file(tgt)
            if rest == 'file':
                tgt = remux.get_direct_file(sid)
                if not tgt:
                    return self._json(404, {'error': 'not found'})
                return self._stream_file(tgt)
            if rest == 'thumb':
                # Scrub-preview JPEG (sid-gated like segments: <img> can't send
                # headers, the unguessable session id in the path is the
                # capability). 404s whenever DUMIFLIX_THUMBS isn't enabled on
                # this host -- the client just hides the preview.
                qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                try:
                    t = float((qs.get('t') or ['0'])[0])
                except ValueError:
                    t = 0.0
                tgt = remux.playback_thumbnail(sid, t)
                if not tgt:
                    return self._json(404, {'error': 'no thumbnail'})
                return self._stream_file(tgt, mime='image/jpeg')
            return self._json(404, {'error': 'unknown playback path'})
        return self._json(404, {'error': 'not found'})

    def do_HEAD(self):
        path = urllib.parse.urlparse(self.path).path
        if CACHE_ENABLED and path.startswith('/cache/growing/'):
            if not self._authed():
                self.send_response(401)
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            rel = urllib.parse.unquote(path[len('/cache/growing/'):])
            cache.hold(rel)
            try:
                return self._stream_growing_cache(rel, head_only=True)
            finally:
                cache.release(rel)
        if CACHE_ENABLED and path.startswith('/cache/stream/'):
            if not self._authed():
                self.send_response(401)
                self.send_header('Content-Length', '0')
                # No forced `Connection: close` (see _json).
                self.end_headers()
                return
            rel = urllib.parse.unquote(path[len('/cache/stream/'):])
            # hold() before resolving (see the GET handler) to close the same
            # existence-check -> protect window; release() unconditionally.
            cache.hold(rel)
            try:
                target = cache.stream_target(rel)
                if target is not None:
                    return self._stream_file(target, head_only=True)
            finally:
                cache.release(rel)
        if path.startswith('/playback/'):
            sid, rest = self._split(path)
            if rest.startswith('segments/'):
                tgt = remux.get_segment(sid, urllib.parse.unquote(rest[len('segments/'):]))
                if tgt:
                    return self._stream_file(tgt, head_only=True)
            if rest == 'file':
                tgt = remux.get_direct_file(sid)
                if tgt:
                    return self._stream_file(tgt, head_only=True)
        self.send_response(404)
        self.send_header('Content-Length', '0')
        # No forced `Connection: close` (see _json).
        self.end_headers()

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if CACHE_ENABLED and path == '/catalog/check':
            if not self._authed():
                return self._unauthorized()
            import catalog
            try:
                result = catalog.get_catalog(cache.CACHE_ROOT).check(self._read_json())
            except ValueError as exc:
                return self._json(400, {'error': str(exc)})
            except OSError:
                return self._json(503, {'error': 'catalog storage unavailable'})
            return self._json(200, result)
        if (TORRENT_ENABLED and TORRENT_LOOPBACK_ONLY and
                path.startswith('/torrent/') and self.client_address[0] not in ('127.0.0.1', '::1')):
            return self._json(403, {'ok': False, 'error': 'torrent control requires loopback access'})
        if CACHE_ENABLED and path == '/cache/fetch':
            if not self._authed():
                return self._unauthorized()
            body = self._read_json() or {}
            file_id = str(body.get('id') or '')
            url = body.get('url')
            name = body.get('name') or ''
            if not file_id or not url:
                return self._json(400, {'error': 'need id + url'})
            try:
                expected = int(body.get('total') or 0)
            except (TypeError, ValueError):
                expected = 0
            res = cache.reserve(file_id, name, url, expected_bytes=expected, job_id=file_id)
            if not res.get('ok'):
                err_body = {'error': res.get('error', 'reserve failed')}
                if 'state' in res:
                    err_body['state'] = res['state']
                return self._json(res.get('status', 500), err_body)
            if res.get('state') == 'started':
                threading.Thread(target=cache.cache_download, args=(res['id'],),
                                 daemon=True).start()
            # Contract: 200 {ok:true, id, rel, state} with state in
            # {'started','ready'} -- echoes both the client-supplied id and
            # the server-derived rel back.
            return self._json(200, {'ok': True, 'id': res['id'], 'rel': res['rel'],
                                     'state': res['state']})
        if CACHE_ENABLED and path == '/cache/cancel':
            if not self._authed():
                return self._unauthorized()
            body = self._read_json() or {}
            job = cache._JOBS.get(str(body.get('id') or ''))
            if job:
                job['_cancel'] = True
            return self._json(200, {'ok': True})
        if CACHE_ENABLED and path == '/cache/accelerate':
            if not self._authed():
                return self._unauthorized()
            body = self._read_json() or {}
            res = cache.accelerate(str(body.get('id') or ''))
            code = int(res.pop('status', 200))
            return self._json(code, res)
        if CACHE_ENABLED and path == '/cache/del':
            if not self._authed():
                return self._unauthorized()
            body = self._read_json() or {}
            rel = str(body.get('rel') or body.get('id') or '')
            try:
                if not cache.delete_cached(rel):
                    return self._json(409, {'error': 'file is actively playing'})
            except PermissionError as e:
                return self._json(403, {'error': str(e)})
            except OSError as e:
                return self._json(500, {'error': str(e)})
            return self._json(200, {'ok': True})
        if CACHE_ENABLED and path == '/subgen':
            # Repurposed contract (the legacy fast/wait/whole-file-generate
            # contract is fully retired): kick off the baked-subtitle sync
            # engine for an already-cached `rel`. Without `srt`: R3 embedded-
            # track extraction/verify. With `srt` (+ optional `name`): R4/R5
            # external-candidate align+bake. Returns immediately; the caller
            # polls GET /cache/subs/state. See cache.subs_start_sync().
            if not self._authed():
                return self._unauthorized()
            body = self._read_json() or {}
            rel = str(body.get('rel') or '')
            if not rel:
                return self._json(400, {'error': 'missing rel'})
            srt = body.get('srt') if isinstance(body.get('srt'), str) else None
            name = body.get('name') if isinstance(body.get('name'), str) else None
            res = cache.subs_start_sync(rel, srt=srt, name=name)
            code = res.pop('status', 200) if isinstance(res, dict) else 200
            return self._json(code, res)
        if TORRENT_ENABLED and path == '/torrent/add':
            if not self._authed():
                return self._unauthorized()
            body = self._read_json() or {}
            source = body.get('source') or body.get('magnet') or body.get('url')
            if not source or not isinstance(source, str):
                return self._json(400, {'error': 'need source (magnet URI or .torrent URL)'})
            name = body.get('name') if isinstance(body.get('name'), str) else None
            job_id = body.get('id') if isinstance(body.get('id'), str) else None
            if TORRENT_REMOTE_ENABLED:
                code, res = _torrent_remote('POST', '/torrent/add', {
                    'source': source, 'name': name, 'id': job_id,
                })
                return self._json(code, res)
            res = torrent.add(source, name=name, job_id=job_id)
            return self._json(200 if res.get('ok') else res.get('status', 500), res)
        if TORRENT_ENABLED and path == '/torrent/pause':
            if not self._authed():
                return self._unauthorized()
            self._read_json()  # consume framed body before HTTP/1.1 keep-alive reuse
            if TORRENT_REMOTE_ENABLED:
                code, res = _torrent_remote('POST', '/torrent/pause', {})
                return self._json(code, res)
            return self._json(200, torrent.pause_all())
        if TORRENT_ENABLED and path == '/torrent/resume':
            if not self._authed():
                return self._unauthorized()
            self._read_json()  # consume framed body before HTTP/1.1 keep-alive reuse
            if TORRENT_REMOTE_ENABLED:
                code, res = _torrent_remote('POST', '/torrent/resume', {})
                return self._json(code, res)
            return self._json(200, torrent.resume_all())
        if TORRENT_ENABLED and path == '/torrent/cancel':
            if not self._authed():
                return self._unauthorized()
            body = self._read_json() or {}
            if TORRENT_REMOTE_ENABLED:
                code, res = _torrent_remote('POST', '/torrent/cancel', {
                    'id': str(body.get('id') or ''),
                })
                return self._json(code, res)
            res = torrent.cancel(str(body.get('id') or ''))
            return self._json(200 if res.get('ok') else res.get('status', 404), res)
        if SEASON_ENABLED and path == '/season/queue':
            # Body: {items:[{name,kind:'magnet'|'url',source,show?,season?,
            #                episode?,bytes?}], replace?:bool}
            # Order IS watch order -- the client puts the episode being watched
            # first, then the rest. The queue then runs with no client at all.
            if not self._authed():
                return self._unauthorized()
            body = self._read_json() or {}
            return self._json(200, season.enqueue(body.get('items') or [],
                                                  replace=bool(body.get('replace'))))

        if SEASON_ENABLED and path == '/season/clear':
            if not self._authed():
                return self._unauthorized()
            body = self._read_json() or {}
            return self._json(200, season.clear(only_terminal=bool(body.get('onlyTerminal'))))

        if path == '/playback/probe':
            # remux-OFF guard (see remux.playback_probe): read-only bitrate
            # check, no session and no ffmpeg. Same bearer gating as /start.
            if not self._authed():
                return self._unauthorized()
            res = remux.playback_probe(self._read_json())
            return self._reply(res)

        if path == '/playback/start':
            if not self._authed():
                return self._unauthorized()
            body = self._read_json()
            # One line per start attempt (URL-redacted): with this plus the
            # _reply error line, "engine never asked" vs "engine asked and
            # failed" is finally distinguishable from the log alone.
            try:
                print('[tv-remux] start %s %s t=%s' % (
                    body.get('sourceType'),
                    remux._redact_ref(str(body.get('sourceReference') or ''))[:140],
                    body.get('startTime')), file=sys.stderr, flush=True)
            except Exception:
                pass
            res = remux.playback_start(body)
            # Log the CLAIMED clock too: requested-vs-actualStartTime is the
            # first thing to check whenever "subs are off" gets reported --
            # without this line the claim vanishes with the session.
            try:
                if isinstance(res, dict) and res.get('sessionId'):
                    print('[tv-remux] started %s mode=%s actualStart=%s' % (
                        str(res.get('sessionId'))[:8], res.get('playbackMode'),
                        res.get('actualStartTime')), file=sys.stderr, flush=True)
            except Exception:
                pass
            return self._reply(res)
        if PLAYER_ENABLED and path.startswith('/player/'):
            if not self._authed():
                return self._unauthorized()
            body = self._read_json() or {}
            fn = {'/player/open': player.player_open, '/player/stop': player.player_stop,
                  '/player/pause': player.player_pause, '/player/resume': player.player_resume,
                  '/player/seek': player.player_seek, '/player/next': player.player_next,
                  }.get(path)
            if not fn:
                return self._json(404, {'error': 'unknown player path'})
            res = fn(body)
            code = res.pop('status', 200) if isinstance(res, dict) else 200
            return self._json(code, res)

        if path == '/log':
            # TV blackbox intake: {src, boot, events:[[ts,tag,data],...]}.
            # Appends NDJSON to LOG_DIR/<src>-YYYYMMDD.log. Token-gated like
            # everything else; src is sanitised so it can't traverse paths.
            if not self._authed():
                return self._unauthorized()
            body = self._read_json() or {}
            src = re.sub(r'[^a-z0-9_-]', '', str(body.get('src') or 'tv').lower())[:24] or 'tv'
            boot = str(body.get('boot') or '')[:24]
            events = body.get('events') or []
            written = 0
            try:
                os.makedirs(LOG_DIR, exist_ok=True)
                p = os.path.join(LOG_DIR, '%s-%s.log' % (src, time.strftime('%Y%m%d')))
                with open(p, 'a', encoding='utf-8', errors='replace') as f:
                    for e in events[:800]:
                        try:
                            f.write(json.dumps(
                                {'ts': e[0], 'boot': boot, 'tag': e[1],
                                 'd': (e[2] if len(e) > 2 else None)},
                                ensure_ascii=False) + '\n')
                            written += 1
                        except Exception:
                            continue
            except OSError as ex:
                return self._json(500, {'error': str(ex)})
            return self._json(200, {'ok': True, 'written': written})

        if path == '/media/inspect':
            # One authenticated, memoized ffprobe for the optional player
            # badges and chapter marks. The TV launches this only after the
            # first frame, so metadata can never hold playback startup.
            if not self._authed():
                return self._unauthorized()
            return self._reply(remux.media_inspect(self._read_json() or {}))
        if path == '/subsync':
            # Subtitle audio-sync ON this engine (so the configured host does it instead
            # of routing back to the phone). Token-gated + heavy (decodes audio).
            if not self._authed():
                return self._unauthorized()
            if subsync is None:
                return self._json(501, {'error': 'subsync not available'})
            res = subsync.handle_subsync(self._read_json())
            code = res.pop('status', 200) if isinstance(res, dict) else 200
            return self._json(code, res)
        if path == '/tv/relaunch':
            # A local Luna relaunch can fail because closing the page also
            # tears down its bundled service before a delayed launch fires.
            # An SSAP launch from this separate engine survives that teardown.
            # The calling TV service supplies its own LAN address through the
            # connection; an explicit body {"ip": "..."} overrides the target
            # for testing. Neither path needs a baked-in TV address.
            if not self._authed():
                return self._unauthorized()
            body = self._read_json() or {}
            override_ip = body.get('ip') if isinstance(body.get('ip'), str) else None
            target_ip = (override_ip or self.client_address[0] or '').strip()
            if not target_ip:
                return self._json(400, {'error': 'no target ip'})
            if webos_ssap is None:
                print('[tv-relaunch] /tv/relaunch: webos_ssap not available on this host',
                      file=sys.stderr, flush=True)
                return self._json(503, {'error': 'ssap unavailable'})
            # Respond immediately -- the caller is fire-and-forget (it acts on
            # its own ~200ms window.close() delay regardless of what we say)
            # and the TV-side page/service that triggered this may already be
            # mid-teardown, so nothing about ITS liveness should gate our
            # reply.
            self._json(200, {'ok': True, 'target': target_ip})

            def _do_relaunch(ip):
                def _attempt(n):
                    try:
                        webos_ssap.WebOSManager(ip).launch_app(_TV_APP_ID)
                        print('[tv-relaunch] launch_app(%s) attempt %d -> ok' % (ip, n),
                              file=sys.stderr, flush=True)
                        return True
                    except Exception as e:
                        print('[tv-relaunch] launch_app(%s) attempt %d -> %s' % (ip, n, e),
                              file=sys.stderr, flush=True)
                        return False
                # Give the TV page ~3s to actually finish dying (its own
                # window.close(), plus whatever webOS does to tear the app
                # bundle down) before we SSAP-launch, so this lands on a
                # genuinely-closed app instead of racing a still-closing one.
                time.sleep(3)
                if not _attempt(1):
                    time.sleep(4)
                    _attempt(2)

            threading.Thread(target=_do_relaunch, args=(target_ip,), daemon=True,
                              name='tv-relaunch').start()
            return
        if path.startswith('/playback/'):
            sid, rest = self._split(path)
            if not sid:
                return self._json(400, {'error': 'missing session id'})
            if rest == 'seek':
                return self._reply(remux.playback_seek(sid, self._read_json()))
            if rest == 'pause':
                return self._reply(remux.playback_pause(sid))
            if rest == 'resume':
                return self._reply(remux.playback_resume(sid))
            return self._json(404, {'error': 'unknown playback path'})
        # Unmatched POST path: drain any pending body before replying (see
        # _unauthorized) so a reused keep-alive connection isn't corrupted.
        self._read_json()
        return self._json(404, {'error': 'not found'})

    def do_DELETE(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith('/playback/'):
            sid, _ = self._split(path)
            if sid:
                return self._reply(remux.playback_delete(sid))
        return self._json(404, {'error': 'not found'})


# The /remote control page (see the /remote route). Token comes from the
# page's own URL query and rides every API call it makes.
_REMOTE_HTML = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DumiFlix Laptop Remote</title><style>
body{background:#111;color:#eee;font-family:system-ui;margin:0;padding:18px;text-align:center}
h3{margin:6px 0 2px;font-weight:600} #st{color:#999;min-height:40px;font-size:14px;margin:8px 0 14px}
.row{display:flex;gap:10px;justify-content:center;margin:10px 0}
button{background:#2a2a2a;color:#eee;border:1px solid #444;border-radius:12px;
padding:10px 6px;font-size:17px;flex:1;max-width:150px;min-height:56px}
button:active{background:#e50914}.wide{max-width:100%}
#st{white-space:pre-line}
#bar{height:6px;background:#333;border-radius:3px;margin:14px 0}
#fill{height:100%;width:0;background:#e50914;border-radius:3px}
</style></head><body>
<h3>Laptop player</h3><div id="st">connecting…</div>
<div id="bar"><div id="fill"></div></div>
<div class="row"><button onclick="cmd('seek',{delta:-30})">−30s</button>
<button id="pp" onclick="toggle()">⏯</button>
<button onclick="cmd('seek',{delta:30})">+30s</button></div>
<div class="row"><button onclick="cmd('seek',{delta:-300})">−5m</button>
<button onclick="cmd('seek',{delta:300})">+5m</button></div>
<div class="row"><button onclick="cmd('next',{})">Next ep ⏭</button>
<button onclick="cmd('stop',{})">⏹ Stop</button></div>
<script>
const TOKEN=new URLSearchParams(location.search).get('token')||'';
let paused=false;
const api=(p,b)=>fetch(p+'?token='+TOKEN,b?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}:{}).then(r=>r.json()).catch(()=>({}));
function cmd(n,b){api('/player/'+n,b||{}).then(poll)}
function toggle(){cmd(paused?'resume':'pause')}
function fmt(s){s=Math.max(0,s|0);const h=(s/3600)|0,m=((s%3600)/60)|0,x=s%60;return (h?h+':':'')+String(m).padStart(2,'0')+':'+String(x).padStart(2,'0')}
function poll(){api('/player/status').then(d=>{
  if(!d||!d.running){document.getElementById('st').textContent='nothing playing';document.getElementById('fill').style.width='0%';return}
  paused=!!d.paused;
  document.getElementById('pp').textContent=paused?'▶':'⏸';
  document.getElementById('st').textContent=(d.title||d.rel||'')+'\\n'+fmt(d.pos)+' / '+fmt(d.dur)
    +(d.aoFormat==='spdif'?' · bitstream':'')+(d.audioCodec?' · '+d.audioCodec:'');
  document.getElementById('fill').style.width=(d.dur?100*d.pos/d.dur:0)+'%';
})}
setInterval(poll,2000);poll();
</script></body></html>"""


def main():
    remux.cleanup_temp_root()          # remove leftover segments and writers from a prior run
    ok = remux.ensure_ffmpeg_staged()
    if CACHE_ENABLED:
        cache.cleanup_orphan_parts()   # unconditional -- any '.part' didn't survive the restart
        cache.rebuild_listing()        # physical HDD is authoritative after every restart
        cache.start_sweep_thread()
        import catalog
        catalog.get_catalog(cache.CACHE_ROOT).start_refresh_thread()
    if TORRENT_LOCAL_ENABLED:
        torrent.cleanup_orphan_staging()   # any staging dir didn't survive the restart either
    if SEASON_ENABLED:
        # Resumes a half-finished season from disk. This is the ONLY queue in
        # the codebase that survives a restart -- torrent._JOBS and cache._JOBS
        # are in-memory by design, which is fine for a one-shot fetch but not
        # for something that runs for hours with the TV switched off.
        season.start()
    sys.stdout.write(f'[tv-remux] ffmpeg={remux.FFMPEG_BIN} present={ok} '
                     f'tmp={remux.REMUX_TEMP_ROOT} port={PORT} token={"set" if TOKEN else "none"} '
                     f'cache={"on" if CACHE_ENABLED else "off"} '
                     f'torrent={"remote" if TORRENT_REMOTE_ENABLED else ("local" if TORRENT_LOCAL_ENABLED else "off")}\n')
    sys.stdout.flush()
    bind = os.environ.get('DUMIFLIX_TV_BIND', '127.0.0.1')  # localhost-only by default
    srv = DumiHTTPServer((bind, PORT), Handler)

    # Graceful shutdown: an active remux launches ffmpeg in its OWN process
    # group (os.setsid) so it survives the parent -- great for signalling it
    # mid-run, but it means a plain exit would ORPHAN ffmpeg still writing into
    # temp root with no monitor thread left to prune it. This can exhaust
    # storage or RAM on tmpfs. On a clean stop (SIGTERM from a service manager,
    # Ctrl-C -> SIGINT/KeyboardInterrupt) we tear the session down explicitly.
    # (An UNclean kill -9 can't run this -- that case is covered on the NEXT
    # startup by remux.cleanup_temp_root() -> reap_orphan_ffmpeg().)
    def _shutdown(*_a):
        remux.shutdown_all()
        if TORRENT_LOCAL_ENABLED:
            try:
                torrent.shutdown_all()
            except Exception:
                pass
    atexit.register(_shutdown)

    def _on_term(signum, frame):
        raise SystemExit(0)   # unwinds serve_forever -> finally below
    try:
        signal.signal(signal.SIGTERM, _on_term)
    except Exception:
        pass   # e.g. not in the main thread on some embedded launchers

    try:
        srv.serve_forever()
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        _shutdown()
        try:
            srv.server_close()
        except Exception:
            pass


if __name__ == '__main__':
    main()
