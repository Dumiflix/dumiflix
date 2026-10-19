"""
player.py -- mpv on the laptop as the LOSSLESS playback engine.

This optional Windows player sends media to an HDMI display and a compatible
receiver. mpv can pass supported lossless audio bitstreams directly to the
receiver, avoiding the TV browser's codec and memory limits. The TV app selects
a title while this module manages playback, resume position, and auto-advance.

Design notes:
  * One mpv process per playback, spawned fresh on every open. loadfile-into-
    a-live-process is faster but doubles the state machine; a spawn is ~1s.
  * Control is mpv's JSON IPC over a named pipe. The pipe is opened PER
    REQUEST -- no long-lived handle to go stale when mpv exits.
  * Position resume is mpv's own --save-position-on-quit + watch-later dir.
    --watch-later-options=start keeps it to the POSITION ONLY -- without
    that, a muted test run would persist mute=yes into the next real play.
  * Auto-advance lives HERE, not in the TV app: while the TV shows the HDMI
    input, webOS SUSPENDS the app -- nothing on the TV can drive the next
    episode. A watcher thread advances to the next episode in the cache when
    a file plays to (near) the end.
"""

import os
import re
import json
import time
import threading
import subprocess
import shutil
from pathlib import Path

try:
    import cache            # rel -> safe local path + listing (laptop builds only)
except Exception:           # pragma: no cover
    cache = None

MPV_BIN = os.environ.get('DUMIFLIX_MPV') or 'mpv'
_STATE_ROOT = Path.home() / '.dumiflix'
PIPE = r'\\.\pipe\dumiflix-mpv'
WATCH_LATER = os.environ.get('DUMIFLIX_MPV_WATCHLATER') or str(_STATE_ROOT / 'watch-later')
LOG_FILE = os.path.join(
    os.environ.get('DUMIFLIX_LOG_DIR') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs'),
    'mpv-last.log')
# mpv's default display is used unless an explicit screen index is configured.
# Display indices can change after lid, adapter, or monitor topology changes.
FS_SCREEN = os.environ.get('DUMIFLIX_MPV_SCREEN', 'default')
AUDIO_DEVICE_OVERRIDE = os.environ.get('DUMIFLIX_MPV_AUDIO', '')

JOB_FILE = os.environ.get('DUMIFLIX_MPV_JOB_FILE') or str(_STATE_ROOT / 'tmp' / 'mpv-job.json')
LAUNCH_TASK = os.environ.get('DUMIFLIX_MPV_LAUNCH_TASK') or 'DumiFlixMpv'   # interactive-user scheduled task that execs mpv

_LOCK = threading.RLock()
_current = None             # {'rel','path','title','opened_at'}
_no_session_until = 0.0     # cached "nobody logged in" verdict — a failed spawn
                            # costs ~12s (task run + pipe wait); remembering it
                            # for 2 min keeps the TV's fallback near-instant
_last_pos = 0.0             # last observed time-pos / duration -- fed by the
_last_dur = 0.0             # watcher; used to call "finished vs stopped" after exit
_user_stopped = False       # explicit /player/stop -> never auto-advance past it
_audio_device = None        # cached auto-picked wasapi device string

VIDEO_EXT_RE = re.compile(r'\.(mkv|mp4|m4v|avi|ts|mov|webm|mpg|mpeg|wmv|flv)$', re.I)
EPISODE_RE = re.compile(r'\bS(\d{1,2})[. _-]?E(\d{1,3})\b', re.I)


def available() -> bool:
    return os.name == 'nt' and bool(shutil.which(MPV_BIN))


# ---------------------------------------------------------------------------
# mpv IPC (named pipe, one connection per request)
# ---------------------------------------------------------------------------

def _ipc(command, timeout=4.0):
    """Send one command list to mpv, return its response dict or None.

    mpv broadcasts EVENTS on the same pipe, interleaved with responses --
    read lines until the matching request_id shows up (bounded)."""
    req_id = int(time.time() * 1000) % 1000000
    payload = (json.dumps({'command': command, 'request_id': req_id}) + '\n').encode()
    deadline = time.time() + timeout
    try:
        with open(PIPE, 'r+b', buffering=0) as p:
            p.write(payload)
            for _ in range(200):
                if time.time() > deadline:
                    return None
                line = p.readline()
                if not line:
                    return None
                try:
                    msg = json.loads(line.decode('utf-8', 'replace'))
                except ValueError:
                    continue
                if msg.get('request_id') == req_id:
                    return msg
    except OSError:
        return None
    return None


def _get(prop):
    r = _ipc(['get_property', prop])
    return r.get('data') if (r and r.get('error') == 'success') else None


def _set(prop, value):
    r = _ipc(['set_property', prop, value])
    return bool(r and r.get('error') == 'success')


# ---------------------------------------------------------------------------
# Audio device auto-pick -- external display / AV receiver over HDMI
# ---------------------------------------------------------------------------

def _pick_audio_device():
    """Select the WASAPI device for an external display or AV receiver.
    The default Windows output may be built-in speakers rather than HDMI.
    Cache per process; DUMIFLIX_MPV_AUDIO overrides automatic selection."""
    global _audio_device
    if AUDIO_DEVICE_OVERRIDE:
        return AUDIO_DEVICE_OVERRIDE
    # Cache POSITIVE results only: an empty probe (e.g. run from session 0
    # before anyone logged in) must retry next open, or the HDMI
    # endpoint appearing at login would never be picked up.
    if _audio_device:
        return _audio_device
    try:
        out = subprocess.run([MPV_BIN, '--audio-device=help'],
                             capture_output=True, text=True, timeout=15,
                             encoding='utf-8', errors='replace').stdout or ''
        best = ''
        for m in re.finditer(r"'(wasapi/[^']+)'\s+\(([^)]*)\)", out):
            dev, desc = m.group(1), m.group(2)
            if re.search(r'hdmi|digital|display', desc, re.I):
                best = dev
                break
        _audio_device = best
        print('[player] audio device: %s' % (best or '(system default)'))
    except Exception as e:
        print('[player] audio-device probe failed: %s' % e)
        _audio_device = ''
    return _audio_device


# ---------------------------------------------------------------------------
# lifecycle
# ---------------------------------------------------------------------------

def _resolve(rel_or_url):
    """A cache rel becomes a LOCAL path (direct disk read); http(s) passes
    through untouched (seedr/remote plays work too, just not the point)."""
    s = str(rel_or_url or '')
    if re.match(r'^https?://', s, re.I):
        return s, None
    if cache is None:
        raise ValueError('no cache module for rel resolution')
    p = cache._safe_resolve(s)          # raises PermissionError on traversal
    if not p.is_file():
        raise FileNotFoundError(s)
    return str(p), s


def _has_interactive_session():
    """True when a user desktop exists (explorer.exe running in any session).
    Cheap (~0.2s) and callable from session 0."""
    try:
        r = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq explorer.exe', '/FO', 'CSV'],
                           capture_output=True, text=True, timeout=10)
        return 'explorer.exe' in (r.stdout or '')
    except Exception:
        return True     # uncertain -> let the spawn attempt decide


def _spawn(path, start=0.0, mute=False):
    """Launch mpv IN THE INTERACTIVE USER SESSION via the DumiFlixMpv
    scheduled task. A server running as SYSTEM in session 0 has
    no interactive desktop or audio endpoints. mpv can otherwise appear to
    start without advancing playback or initializing audio output.
    Session 0 cannot CreateProcessAsUser without SYSTEM token juggling, but
    it CAN schtasks-/run a task registered for the logged-on user — the
    standard session hop. The named-pipe IPC is global across sessions, so
    control stays right here."""
    os.makedirs(WATCH_LATER, exist_ok=True)
    os.makedirs(os.path.dirname(JOB_FILE), exist_ok=True)
    args = [
        MPV_BIN, path,
        '--input-ipc-server=' + PIPE,
        '--fs', '--fs-screen=' + FS_SCREEN,
        '--force-window=immediate',
        '--keep-open=no',
        '--no-terminal', '--msg-level=all=warn',
        '--log-file=' + LOG_FILE,
        '--hwdec=auto-safe',
        # Pass supported bitstreams to a compatible HDMI receiver for native
        # decoding of TrueHD Atmos / DTS:X outside the browser pipeline.
        '--audio-spdif=ac3,eac3,dts,dts-hd,truehd',
        '--audio-exclusive=yes',
        '--save-position-on-quit',
        '--watch-later-dir=' + WATCH_LATER,
        '--watch-later-options=start',
        # English subs from the file itself. subs-fallback-forced=no keeps a
        # "Forced foreign language only" track from beating the full dialogue
        # track — the same trap the server-side extractor fell into.
        '--slang=eng,en', '--subs-fallback=yes', '--subs-fallback-forced=no',
    ]
    dev = _pick_audio_device()
    if dev:
        args.append('--audio-device=' + dev)
    if start and start > 1:
        args.append('--start=%.3f' % float(start))
    if mute:
        args.append('--mute=yes')
    with open(JOB_FILE, 'w', encoding='utf-8') as f:
        json.dump({'argv': args, 'ts': time.time()}, f)
    r = subprocess.run(['schtasks', '/run', '/tn', LAUNCH_TASK],
                       capture_output=True, text=True, timeout=15)
    if r.returncode != 0:
        raise RuntimeError('mpv launch task failed: %s'
                           % (r.stderr or r.stdout or '').strip()[:200])
    # The task starts async; the IPC pipe answering is the true "mpv is up"
    # signal. The FIRST launch after a boot is COLD -- GPU/libplacebo shader
    # init can take significantly longer than a warm launch before the
    # pipe becomes serviceable. So wait generously (35s). We also treat
    # "mpv.exe exists but pipe not answering yet" as still-starting rather
    # than dead, so a slow cold start is never mistaken for no-session.
    for i in range(175):                       # 175 * 0.2s = 35s
        time.sleep(0.2)
        if _get('pid') is not None:
            return True
        # Every ~5s, if mpv isn't even a process yet, the launch truly failed
        # (no session / task misfire) -- bail early instead of waiting 35s.
        if i in (25, 50) and not _mpv_running():
            break
    raise RuntimeError('mpv did not come up — is anyone logged into the laptop? '
                       '(the player needs an unlocked user session for display/audio)')


def _mpv_running():
    try:
        r = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq mpv.exe', '/FO', 'CSV'],
                           capture_output=True, text=True, timeout=8)
        return 'mpv.exe' in (r.stdout or '')
    except Exception:
        return False


def _alive():
    return _get('pid') is not None


def player_open(body):
    """POST /player/open {rel|url, start?, title?, mute?}"""
    global _current, _user_stopped, _last_pos, _last_dur
    rel_or_url = (body or {}).get('rel') or (body or {}).get('url') or ''
    if not rel_or_url:
        return {'status': 400, 'ok': False, 'error': 'missing rel/url'}
    if not available():
        return {'status': 501, 'ok': False, 'error': 'mpv not installed'}
    try:
        path, rel = _resolve(rel_or_url)
    except PermissionError as e:
        return {'status': 403, 'ok': False, 'error': str(e)}
    except FileNotFoundError:
        return {'status': 404, 'ok': False, 'error': 'no such cache file'}
    except ValueError as e:
        return {'status': 400, 'ok': False, 'error': str(e)}
    global _no_session_until, _ao_restarts, _ao_dead_polls
    if not (body or {}).get('_heal'):
        _ao_restarts = 0            # fresh user open -> fresh heal budget
    _ao_dead_polls = 0
    if time.time() < _no_session_until:
        return {'status': 503, 'ok': False,
                'error': 'no laptop session (cached) — log into the laptop to use the external player'}
    # Instant pre-check: no explorer.exe = nobody logged into the desktop =
    # mpv has no display/audio to attach to. Fails in ~0.2s instead of the
    # 12s task-run + pipe-wait, so the TV fallback is effectively immediate.
    if not _has_interactive_session():
        _no_session_until = time.time() + 60
        return {'status': 503, 'ok': False,
                'error': 'nobody logged into the laptop — log in (or enable auto-logon) for the external player'}
    with _LOCK:
        _stop_locked(save_position=True)
        _user_stopped = False
        _last_pos = _last_dur = 0.0
        try:
            _spawn(path, start=float((body or {}).get('start') or 0), mute=bool((body or {}).get('mute')))
            _no_session_until = 0.0
        except Exception as e:
            print('[player] open failed: %s' % e)
            if 'logged in' in str(e):
                _no_session_until = time.time() + 120
            return {'status': 503, 'ok': False, 'error': str(e)}
        _current = {'rel': rel, 'path': path, 'title': (body or {}).get('title') or (rel or path),
                    'opened_at': time.time()}
        _ensure_watcher()
    print('[player] open %s (start=%s)' % (rel or path, (body or {}).get('start') or 0))
    return {'ok': True, 'rel': rel, 'path': path}


def _stop_locked(save_position=True):
    """Quit mpv via IPC (which persists the resume position thanks to
    --save-position-on-quit); if the pipe won't answer, taskkill — SYSTEM may
    kill user-session processes even though it can't start them."""
    if not _alive():
        return
    try:
        _ipc(['quit'] if save_position else ['quit', '0'], timeout=2.0)
        for _ in range(20):
            if _get('pid') is None:
                return
            time.sleep(0.15)
    except Exception:
        pass
    try:
        subprocess.run(['taskkill', '/F', '/IM', 'mpv.exe'],
                       capture_output=True, timeout=10)
    except Exception:
        pass


def player_stop(_body=None):
    global _user_stopped, _current
    with _LOCK:
        _user_stopped = True
        _stop_locked(save_position=True)
        cur, _current = _current, None
    print('[player] stop (was: %s)' % ((cur or {}).get('rel')))
    return {'ok': True}


def player_pause(_body=None):
    return {'ok': _set('pause', True)}


def player_resume(_body=None):
    return {'ok': _set('pause', False)}


def player_seek(body):
    sec = (body or {}).get('seconds')
    delta = (body or {}).get('delta')
    if sec is not None:
        r = _ipc(['seek', float(sec), 'absolute'])
    elif delta is not None:
        r = _ipc(['seek', float(delta), 'relative'])
    else:
        return {'status': 400, 'ok': False, 'error': 'seconds or delta required'}
    return {'ok': bool(r and r.get('error') == 'success')}


def player_status(_body=None):
    if not _alive():
        return {'ok': True, 'running': False, 'last': (_current or {}).get('rel')}
    pos = _get('time-pos') or 0
    dur = _get('duration') or 0
    aop = _get('audio-out-params') or {}
    return {
        'ok': True, 'running': True,
        'rel': (_current or {}).get('rel'),
        'title': (_current or {}).get('title'),
        'pos': round(float(pos or 0), 1), 'dur': round(float(dur or 0), 1),
        'paused': bool(_get('pause')),
        'muted': bool(_get('mute')),
        'audioCodec': _get('audio-codec-name'),
        # 'spdif' here == the bitstream is going out untouched (the bar is
        # doing the decoding -- exactly what this whole path exists for).
        'aoFormat': (aop or {}).get('format'),
        'video': {'w': _get('width'), 'h': _get('height')},
        'sub': _get('current-tracks/sub/title') or _get('current-tracks/sub/lang'),
    }


def player_next(_body=None):
    nxt = _next_episode_rel()
    if not nxt:
        return {'status': 404, 'ok': False, 'error': 'no next episode in cache'}
    return player_open({'rel': nxt})


# ---------------------------------------------------------------------------
# auto-advance
# ---------------------------------------------------------------------------

def _norm_title(s):
    return re.sub(r'[^a-z0-9]+', ' ', str(s or '').lower()).strip()


def _next_episode_rel():
    """Next episode of the CURRENT show present in the cache, or None.
    Same-season e+1 first, else (s+1, e=1). Highest quality copy wins the
    tie (2160p > 1080p > 720p), mirroring the TV app's rule."""
    cur = (_current or {}).get('rel') or ''
    m = EPISODE_RE.search(cur)
    if not m or cache is None:
        return None
    s, e = int(m.group(1)), int(m.group(2))
    show = _norm_title(cur[:m.start()])
    if not show:
        return None
    want = [(s, e + 1), (s + 1, 1)]
    best, best_q = None, -1
    for p, _sz, _mt in cache.cache_files():
        rel = str(p.relative_to(cache.CACHE_ROOT))
        name = cache.display_name(rel)
        if not VIDEO_EXT_RE.search(name or rel):
            continue
        m2 = EPISODE_RE.search(name)
        if not m2:
            continue
        se = (int(m2.group(1)), int(m2.group(2)))
        if se not in want:
            continue
        t = _norm_title(name[:m2.start()])
        if not t or not (t.startswith(show) or show.startswith(t)):
            continue
        # same-season beats next-season; then quality
        rank = (1 if se == want[0] else 0) * 1000
        rank += 300 if re.search(r'2160p|\b4k\b|uhd', name, re.I) else \
                200 if re.search(r'1080p', name, re.I) else \
                100 if re.search(r'720p', name, re.I) else 0
        if rank > best_q:
            best, best_q = rel, rank
    return best


_ao_dead_polls = 0
_ao_restarts = 0

_watcher_started = False


def _ensure_watcher():
    global _watcher_started
    if _watcher_started:
        return
    _watcher_started = True
    threading.Thread(target=_watch, daemon=True).start()


def _watch():
    """Poll playback; when a file plays to (near) its end and mpv exits,
    open the next episode. An explicit /player/stop suppresses this."""
    global _last_pos, _last_dur, _current
    while True:
        time.sleep(2.0)
        try:
            with _LOCK:
                alive = _alive()
            if alive:
                pos, dur = _get('time-pos'), _get('duration')
                if isinstance(pos, (int, float)):
                    _last_pos = float(pos)
                if isinstance(dur, (int, float)):
                    _last_dur = float(dur)
                _heal_dead_audio()
                continue
            if _current is None or _user_stopped:
                continue
            finished = _last_dur > 0 and _last_pos >= max(0.0, _last_dur - 120)
            cur = _current
            _current = None                    # consume — one decision per exit
            if not finished:
                print('[player] exited mid-file at %.0fs/%.0fs — no auto-advance'
                      % (_last_pos, _last_dur))
                continue
            nxt = _next_episode_rel_for(cur.get('rel') or '')
            if nxt:
                print('[player] auto-advance -> %s' % nxt)
                player_open({'rel': nxt})
            else:
                print('[player] finished %s — no next episode in cache' % cur.get('rel'))
        except Exception as e:                  # the watcher must never die
            print('[player] watcher: %s' % e)


def _heal_dead_audio():
    """Recover audio output after HDMI input-switch renegotiation.
    An exclusive WASAPI endpoint can reset when an external display or AV
    receiver changes inputs, leaving current-ao=None. Reopen at the current
    position after two failed polls, allowing six seconds for startup and
    at most two recovery attempts per user open."""
    global _ao_dead_polls, _ao_restarts
    cur = _current
    if cur is None:
        _ao_dead_polls = 0
        return
    if time.time() - (cur.get('opened_at') or 0) < 6:
        return
    try:
        dead = _get('current-ao') is None and _get('audio-codec-name')
    except Exception:
        return
    if not dead:
        _ao_dead_polls = 0
        return
    _ao_dead_polls += 1
    if _ao_dead_polls < 2 or _ao_restarts >= 2:
        return
    _ao_dead_polls = 0
    _ao_restarts += 1
    print('[player] audio output dead (HDMI renegotiation) — reopening at %.0fs (heal %d/2)'
          % (_last_pos, _ao_restarts))
    player_open({'rel': cur.get('rel'), 'start': max(0.0, _last_pos - 2),
                 'title': cur.get('title'), '_heal': True})


def _next_episode_rel_for(rel):
    global _current
    saved = _current
    _current = {'rel': rel}
    try:
        return _next_episode_rel()
    finally:
        _current = saved
