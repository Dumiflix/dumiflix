"""
season.py -- persistent, TV-independent season prefetch queue (optional engine module).

WHY THIS EXISTS
---------------
Playing straight off seedr is rate-limited and expiring. Every seek relaunches
ffmpeg, which re-opens the source URL from scratch, so a handful of seek-bar
clicks earn an `HTTP error 429 Too Many Requests`; ffmpeg then reads a
truncated file and exits, and the TV is left on a dead player pinned at t=0.
A file already on local disk has none of those failure modes -- no rate limit,
no expiry, no network at all -- and remux.py's `_resolve_cached_copy()` already
prefers a local copy automatically once one exists.

So the fix is structural: get the WHOLE SEASON onto local disk ahead of time.
Episode 1 can still start instantly from seedr (the app hands over to the local
copy mid-episode via swapPlaybackToDrive once it lands); every later episode is
simply already here.

WHY IT LIVES HERE AND NOT IN THE TV APP
---------------------------------------
Downloads must keep running even when the TV is switched off.
A queue driven from the app stops the moment the screen does. This module runs
on the engine host, independent of any client.

It also PERSISTS, which nothing else in this codebase does: torrent._JOBS and
cache._JOBS are plain process dicts and are documented as not surviving a
restart. A season is hours of downloading -- losing the queue to a reboot or a
crash would be the normal case, not an edge case. State is written with the
same atomic tmp+os.replace pattern cache.py already uses for .names.json.

SCOPE / NON-GOALS
-----------------
This module does NOT search for torrents or decide which release is best --
that needs episode metadata and indexer access the client already has, and
doing it here would duplicate it badly. The client resolves the season into a
concrete ordered list of sources and POSTs it; this module owns the boring,
long-running, must-not-be-lost part: ordering, persistence, disk budget,
dispatch, and not evicting its own finished work.
"""

import os
import json
import time
import uuid
import threading
from pathlib import Path
from typing import Optional

import cache

try:
    import torrent
except Exception:                      # torrent bolt-on is optional
    torrent = None

# Dot-prefixed on purpose: cache_files() skips every dot-prefixed path, so the
# queue file can never be mistaken for media, counted toward the cap, or evicted.
_STATE_NAME = '.season-queue.json'
_STATE_VERSION = 1

_LOCK = threading.RLock()
_STATE = {'version': _STATE_VERSION, 'items': []}
_worker: Optional[threading.Thread] = None
_wake = threading.Event()
_stop = threading.Event()

# How long to sit out after failing to make room before re-trying the same
# item. Without this, a season larger than the cache spins at 100% CPU
# re-attempting an eviction that can never succeed.
_SPACE_RETRY_SECONDS = float(os.environ.get('DUMIFLIX_SEASON_SPACE_RETRY', '300'))
_POLL_SECONDS = 2.0
_BUSY_RETRY_SECONDS = 5.0

TERMINAL = ('ready', 'error', 'skipped')

# _STATE['items'] is a PERSISTENT, never-restart-cleared list (see _load()'s
# own docstring: "this is the ONLY queue in the codebase that survives a
# restart"). Nothing ever dropped a finished/failed/skipped item, so a queue
# fed one season after another for months would grow _STATE['items'] --
# and therefore the on-disk .season-queue.json AND every /season/status
# response -- unbounded. Mirrors torrent.py's own _MAX_TERMINAL_JOBS +
# _prune_terminal_jobs_locked() fix for the identical shape in its _JOBS
# dict. queued/claimed/active items are NEVER pruned -- only terminal ones,
# and only once the terminal count exceeds the cap.
_MAX_TERMINAL_ITEMS = int(os.environ.get('DUMIFLIX_SEASON_MAX_TERMINAL', '200'))
# Separate, smaller cap on what a single /season/status POLL actually
# returns in its 'items' array -- a client polling every couple of seconds
# for a progress bar has no use for the full (up to _MAX_TERMINAL_ITEMS)
# history on every tick. See status()'s own docstring for exactly what
# stays in vs. gets trimmed.
_STATUS_ITEMS_MAX = int(os.environ.get('DUMIFLIX_SEASON_STATUS_ITEMS_MAX', '60'))


# ---------------------------------------------------------------- persistence

def _state_path() -> Path:
    return cache.CACHE_ROOT / _STATE_NAME


def _load() -> None:
    """Read the queue off disk. Any claimed/active item goes back to queued:
    if we are loading, the process that owned that job is gone, and its
    in-memory torrent/cache job died with it (both modules are explicit that
    their job dicts don't survive a restart). Re-queuing is safe because the
    worker skips anything already complete on disk before re-downloading."""
    global _STATE
    try:
        raw = _state_path().read_text(encoding='utf-8')
        data = json.loads(raw)
        if not isinstance(data, dict) or not isinstance(data.get('items'), list):
            raise ValueError('malformed season queue')
    except FileNotFoundError:
        return
    except Exception:
        # A corrupt queue must not take the whole server down on boot.
        return
    for it in data['items']:
        if it.get('state') == 'ready':
            # Recover queues written by older versions that could mistake an
            # in-progress import for a completed file before it was deleted.
            try:
                path = cache._safe_resolve(it.get('rel') or '')
                present = path.is_file() and path.stat().st_size > 0
            except (OSError, ValueError):
                present = False
            if not present:
                it.update(state='queued', rel=None, jobId=None, error=None, notBefore=0.0)
        if it.get('state') in ('claimed', 'active'):
            it['state'] = 'queued'
            it['jobId'] = None
    _STATE = {'version': _STATE_VERSION, 'items': data['items']}


def _prune_terminal_locked() -> None:
    """Drop the oldest terminal (ready/error/skipped) items beyond
    _MAX_TERMINAL_ITEMS so a persistent, restart-surviving queue can't grow
    forever over months of seasons. queued/active items are always kept --
    claimed items are also kept. Caller MUST hold _LOCK."""
    terminal = [it for it in _STATE['items'] if it.get('state') in TERMINAL]
    excess = len(terminal) - _MAX_TERMINAL_ITEMS
    if excess <= 0:
        return
    terminal.sort(key=lambda it: it.get('updatedAt', 0))
    drop_ids = {it.get('id') for it in terminal[:excess]}
    _STATE['items'] = [it for it in _STATE['items'] if it.get('id') not in drop_ids]


def _save_locked() -> None:
    """Atomic write (tmp + os.replace), mirroring cache._write_names(). A
    half-written queue file would be indistinguishable from a corrupt one on
    the next boot, and would silently lose a season's worth of progress.

    Prunes terminal history (see _prune_terminal_locked) BEFORE writing, so
    every call site that persists state -- enqueue(), clear(), and every
    state transition in _tick() -- gets the bound for free without having
    to remember to call it separately."""
    _prune_terminal_locked()
    p = _state_path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix('.tmp')
        tmp.write_text(json.dumps(_STATE, ensure_ascii=False), encoding='utf-8')
        os.replace(str(tmp), str(p))
    except Exception:
        pass


# ------------------------------------------------------------------ inventory

def _import_source_present(entry) -> bool:
    """A readable torrent reservation is not completion evidence.

    Its persisted owner is '<job id>/<path within staging>'. The importer
    keeps that source (and its retry marker) on failure or interrupted copies;
    a successful move removes it only AFTER the destination is complete.
    This check therefore survives losing the in-memory producer job records.
    URL cache writers publish via .part rename; their ids have no such path.
    """
    owner = entry.get('file_id') if isinstance(entry, dict) else None
    if not isinstance(owner, str) or '/' not in owner:
        return False
    relative = Path(owner)
    if relative.is_absolute() or '..' in relative.parts:
        return True
    staging = getattr(torrent, 'STAGING_ROOT', None)
    if not isinstance(staging, (str, os.PathLike)):
        return True  # Cannot establish that a reserved import has finished.
    try:
        (Path(staging) / relative).stat()
    except FileNotFoundError:
        return False
    except OSError:
        return True
    return True


def _existing_rel_for(name: str) -> Optional[str]:
    """Return the cache rel of a FINISHED file matching `name`, else None.

    Same matching rule as remux._resolve_cached_copy(): release filenames carry
    group, quality and episode, so an exact name match is a strong identity.
    cache_files() excludes URL download parts and hidden staging. Readable
    torrent destinations also need the durable source-removal check: copies
    across drives are visible at their final name before they finish.
    """
    if not name:
        return None
    files = cache.cache_files()
    # Reservations publish their index entry before creating a destination.
    # Read the index after inventory so even newly visible copies have owners.
    with cache._NAMES_LOCK:
        names = cache._load_names()
    for p, size, _mtime in files:
        if size <= 0:
            continue
        rel = str(p.relative_to(cache.CACHE_ROOT)).replace('\\', '/')
        entry = names.get(rel)
        original = entry.get('name') if isinstance(entry, dict) else entry
        if (p.name == name or original == name) and not _import_source_present(entry):
            return rel
    return None


def protected_rels() -> set:
    """Every rel this queue considers its own finished work.

    Registered with cache.register_protect_provider() so eviction skips them.
    Without this the queue eats itself: episodes 2-10 sit finished on disk with
    no open reader and no live session, which makes them the OLDEST, least
    protected files in the cache -- precisely what cache_evict() deletes first
    to make room for episode 11. The queue would then never converge.

    Only non-terminal-and-ready items count. Once a queue is cleared the
    protection lifts, so this can never permanently pin the whole disk.
    """
    with _LOCK:
        return {it['rel'] for it in _STATE['items']
                if it.get('rel') and it.get('state') == 'ready'}


# -------------------------------------------------------------------- queueing

def enqueue(items: list, replace: bool = False) -> dict:
    """
    Add episodes to the queue. `items` is an ordered list of dicts:
        {name, kind: 'magnet'|'url', source, show?, season?, episode?, bytes?}
    Order is watch order -- the worker takes them front to back, so the client
    should put the episode about to be watched first.

    Idempotent on `name`: re-queuing a live/ready item does not duplicate work.
    A failed item is deliberately reset in place and retried -- treating an
    error as a permanent duplicate strands that episode forever.
    """
    added, skipped = 0, 0
    with _LOCK:
        if replace:
            _STATE['items'] = [it for it in _STATE['items'] if it.get('state') == 'active']
        by_name = {it.get('name'): it for it in _STATE['items'] if it.get('name')}
        for raw in (items or []):
            name = (raw.get('name') or '').strip()
            source = (raw.get('source') or '').strip()
            kind = (raw.get('kind') or '').strip().lower()
            if not name or not source or kind not in ('magnet', 'url'):
                skipped += 1
                continue
            previous = by_name.get(name)
            if previous and previous.get('state') == 'error':
                previous.update({
                    'kind': kind,
                    'source': source,
                    'show': raw.get('show'),
                    'season': raw.get('season'),
                    'episode': raw.get('episode'),
                    'bytes': int(raw.get('bytes') or 0),
                    'state': 'queued',
                    'rel': None,
                    'jobId': None,
                    'error': None,
                    'updatedAt': time.time(),
                    'notBefore': 0.0,
                })
                added += 1
                continue
            if previous:
                skipped += 1
                continue
            entry = {
                'id': uuid.uuid4().hex[:16],
                'name': name,
                'kind': kind,
                'source': source,
                'show': raw.get('show'),
                'season': raw.get('season'),
                'episode': raw.get('episode'),
                'bytes': int(raw.get('bytes') or 0),
                'state': 'queued',
                'rel': None,
                'jobId': None,
                'error': None,
                'addedAt': time.time(),
                'updatedAt': time.time(),
                'notBefore': 0.0,
            }
            _STATE['items'].append(entry)
            by_name[name] = entry
            added += 1
        _save_locked()
    _wake.set()
    return {'added': added, 'skipped': skipped, 'total': len(_STATE['items'])}


def clear(only_terminal: bool = False) -> dict:
    """Drop queued/claimed/terminal items, cancelling dispatch preparation.
    Keep active items: dispatch has committed and must remain tracked."""
    with _LOCK:
        before = len(_STATE['items'])
        if only_terminal:
            _STATE['items'] = [it for it in _STATE['items'] if it.get('state') not in TERMINAL]
        else:
            _STATE['items'] = [it for it in _STATE['items'] if it.get('state') == 'active']
        _save_locked()
        return {'removed': before - len(_STATE['items']), 'total': len(_STATE['items'])}


def status() -> dict:
    """Queue snapshot for the app's progress UI.

    'items' is capped independently of the persisted-state cap (see
    _prune_terminal_locked): a long-running queue can still legitimately
    hold up to _MAX_TERMINAL_ITEMS finished/errored/skipped episodes, but a
    client polling this every couple of seconds for a progress bar has no
    use for all of them on every single tick. 'counts'/'pendingBytes' below
    are computed over the FULL list first, so the UI's totals stay accurate
    even though the itemized list handed back is trimmed."""
    with _LOCK:
        items = [dict(it) for it in _STATE['items']]
    counts = {}
    for it in items:
        counts[it['state']] = counts.get(it['state'], 0) + 1
    live = None
    for it in items:
        if it['state'] == 'active':
            live = _job_progress(it)
            break
    try:
        summary = cache.status_summary()
    except Exception:
        summary = {}
    # Every non-terminal (queued/claimed/active) item always stays -- that's what
    # actually drives the progress UI, and there are realistically at most
    # a season's worth of them -- plus the most-recently-updated terminal
    # items up to the cap, so a poller sees "what's left to do" in full and
    # "what just finished/failed" as recent history, without every episode
    # this queue has EVER processed riding along on every single poll.
    live_items = [it for it in items if it.get('state') not in TERMINAL]
    done_items = sorted((it for it in items if it.get('state') in TERMINAL),
                        key=lambda it: it.get('updatedAt', 0), reverse=True)
    display_items = live_items + done_items[:max(0, _STATUS_ITEMS_MAX - len(live_items))]
    return {
        'running': bool(_worker and _worker.is_alive()),
        'counts': counts,
        'active': live,
        'pendingBytes': sum(it.get('bytes') or 0
                            for it in items if it['state'] in ('queued', 'claimed', 'active')),
        'cache': {'used': summary.get('used'), 'cap': summary.get('cap'),
                  'free': summary.get('free'), 'floor': summary.get('floor')},
        'items': display_items,
    }


def _job_progress(it: dict) -> dict:
    """Best-effort live progress for the item currently downloading."""
    out = {'id': it['id'], 'name': it['name'], 'kind': it['kind'],
           'episode': it.get('episode'), 'percent': None, 'downloaded': None}
    jid = it.get('jobId')
    if not jid:
        return out
    try:
        j = _job_record(it['kind'], jid)
        out['percent'] = j.get('percent')
        out['downloaded'] = j.get('downloaded') or j.get('received')
        out['state'] = j.get('state')
    except Exception:
        pass
    return out


def _job_record(kind: str, jid: str) -> dict:
    """Uniform job view over the two producers.

    torrent.py exposes a public status(); cache.py has no accessor at all --
    server.py's /cache/status handler reads cache._JOBS directly, so we do the
    same rather than adding a public API to cache.py for one caller. Guarded:
    a missing job dict is normal after a restart (both job registries are
    in-memory) and must read as "unknown", not crash the worker.
    """
    if kind == 'magnet':
        if torrent is None:
            return {}
        return torrent.status(jid) or {}
    return dict(getattr(cache, '_JOBS', {}).get(jid) or {})


# ---------------------------------------------------------------------- worker

def _have_room_for(nbytes: int) -> bool:
    """True if `nbytes` fits under BOTH the cap and the free-disk floor after
    a best-effort eviction pass. Eviction skips protected files, which now
    includes this queue's own finished episodes (see protected_rels)."""
    try:
        if nbytes > 0:
            cache.cache_evict(need_bytes=nbytes, protect_rel=cache.protected_rel())
        s = cache.status_summary()
        used, cap, free, floor = s['used'], s['cap'], s['free'], s['floor']
        return (used + nbytes) <= cap and (free - nbytes) >= floor
    except Exception:
        return True          # never block a download on a failed accounting read


class _ProducerBusy(RuntimeError):
    pass


def _dispatch(it: dict) -> str:
    """Start the download for `it`, returning a job id, or raise."""
    if it['kind'] == 'magnet':
        if torrent is None:
            raise RuntimeError('torrent downloader unavailable on this host')
        # torrent.add() runs aria2 on THIS host's route. Only the explicitly
        # enabled local mode (server.py TORRENT_LOCAL_ENABLED) may do that;
        # otherwise a season magnet could bypass the configured remote-only policy.
        if os.environ.get('DUMIFLIX_TORRENT_ENABLED', '0') != '1':
            raise RuntimeError('local torrents are disabled on this host')
        res = torrent.add(it['source'], name=it.get('name'))
    else:
        res = cache.reserve(it['id'], it['name'], it['source'],
                            expected_bytes=it.get('bytes') or 0)
    res = res or {}
    if not res.get('ok'):
        if res.get('state') == 'busy' or res.get('error') == 'busy':
            raise _ProducerBusy('waiting for downloader')
        raise RuntimeError(res.get('error') or 'download refused')
    jid = res.get('id') or res.get('jobId')
    if not jid:
        raise RuntimeError('downloader returned no job id')
    # cache.py never starts its own thread -- server.py's /cache/fetch spawns
    # one. Mirror that ownership convention here rather than changing cache.py.
    if it['kind'] == 'url' and res.get('state') == 'started':
        threading.Thread(target=cache.cache_download, args=(jid,),
                         daemon=True, name='season-fetch-%s' % jid[:8]).start()
    return jid


def _terminal_state(it: dict) -> Optional[tuple]:
    """(state, rel_or_error) once the item's job finishes, else None."""
    # The authoritative completion signal is the file appearing on disk --
    # both producers ultimately import into CACHE_ROOT, and a finished file is
    # exactly what every consumer cares about.
    rel = _existing_rel_for(it['name'])
    if rel:
        return ('ready', rel)
    jid = it.get('jobId')
    if not jid:
        return ('error', 'no job id')
    try:
        j = _job_record(it['kind'], jid)
    except Exception:
        return None
    if not j:
        # Job record gone (server restarted under us). The file didn't appear,
        # so re-queue rather than silently declaring success or failure.
        return ('error', 'job record lost (server restart)')
    st = (j or {}).get('state')
    if st in ('ready', 'done', 'complete'):
        # Producer says done but the name didn't match -- a season pack often
        # imports under the episode's own filename rather than ours. Accept the
        # producer's own reported rel(s) if it gave us any.
        rels = j.get('rels') or ([j['rel']] if j.get('rel') else [])
        return ('ready', rels[0]) if rels else ('error', 'completed but no file matched')
    if st in ('error', 'aborted', 'cancelled'):
        return ('error', j.get('error') or st)
    return None


def _loop() -> None:
    while not _stop.is_set():
        try:
            _tick()
        except Exception:
            pass
        _wake.wait(timeout=_POLL_SECONDS)
        _wake.clear()


def _tick() -> None:
    with _LOCK:
        # A second tick cannot select work while the first prepares its claim.
        if any(it['state'] == 'claimed' for it in _STATE['items']):
            return
        active = next((it for it in _STATE['items'] if it['state'] == 'active'), None)
        now = time.time()
        nxt = None
        if not active and not _stop.is_set():
            nxt = next((it for it in _STATE['items']
                        if it['state'] == 'queued' and (it.get('notBefore') or 0) <= now), None)
            if nxt:
                nxt['state'] = 'claimed'
                nxt['updatedAt'] = now
                _save_locked()

    if active:
        # The owner may still be inside the producer's reservation call.
        if not active.get('jobId'):
            return
        done = _terminal_state(active)
        if done:
            with _LOCK:
                active['state'] = done[0]
                if done[0] == 'ready':
                    active['rel'] = done[1]
                else:
                    active['error'] = str(done[1])[:300]
                active['updatedAt'] = time.time()
                _save_locked()
            _wake.set()
        return

    if not nxt:
        return

    try:
        # Preparation stays outside _LOCK: eviction calls protected_rels(),
        # and producers can hold their own locks while calling that provider.
        rel = _existing_rel_for(nxt['name'])
        have_room = bool(rel) or _have_room_for(nxt.get('bytes') or 0)
        with _LOCK:
            # clear()/replace may have cancelled this claim during disk I/O.
            if not any(it is nxt for it in _STATE['items']):
                return
            if _stop.is_set():
                nxt['state'] = 'queued'
            elif rel:
                nxt['state'] = 'ready'
                nxt['rel'] = rel
            elif not have_room:
                nxt['state'] = 'queued'
                nxt['notBefore'] = now + _SPACE_RETRY_SECONDS
                nxt['error'] = 'waiting for cache space'
            else:
                # Commit dispatch atomically. From here clear()/replace retain
                # this item even while the producer is registering its job.
                nxt['state'] = 'active'
            nxt['updatedAt'] = now
            _save_locked()
            if nxt['state'] != 'active':
                _wake.set()
                return

        jid = _dispatch(nxt)
    except _ProducerBusy as e:
        with _LOCK:
            nxt['state'] = 'queued'
            nxt['jobId'] = None
            nxt['notBefore'] = time.time() + _BUSY_RETRY_SECONDS
            nxt['error'] = str(e)
            nxt['updatedAt'] = time.time()
            _save_locked()
        return
    except Exception as e:
        with _LOCK:
            if not any(it is nxt for it in _STATE['items']):
                return
            # A single bad magnet must not stall the rest of the season.
            nxt['state'] = 'error'
            nxt['error'] = str(e)[:300]
            nxt['updatedAt'] = now
            _save_locked()
        _wake.set()
        return

    with _LOCK:
        nxt['state'] = 'active'
        nxt['jobId'] = jid
        nxt['error'] = None
        nxt['updatedAt'] = now
        _save_locked()


def start() -> None:
    """Load persisted state and start the single worker. Idempotent."""
    global _worker
    with _LOCK:
        if _worker and _worker.is_alive():
            return
        _load()
    try:
        cache.register_protect_provider(protected_rels)
    except Exception:
        pass
    _stop.clear()
    _worker = threading.Thread(target=_loop, daemon=True, name='season-queue')
    _worker.start()


def shutdown() -> None:
    _stop.set()
    _wake.set()
