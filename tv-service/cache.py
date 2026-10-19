#!/usr/bin/env python3
"""
cache.py -- optional engine-local "next episode" disk cache for the DumiFlix remux
engine (tv-service/server.py + remux.py).

WHY THIS EXISTS
---------------
When the cache is enabled, the app pre-downloads the next episode onto the
engine host so playback can start without waiting for the origin. The cache
may share a volume with other applications, so disk usage must stay bounded:
a hard byte cap, a free-disk floor, single-flight downloads, atomic partial
writes, and a refusal to evict actively streamed files. The same safeguards
apply whether the engine is used locally or behind an authenticated proxy:
  - filenames are sha256(file_id)[:24] + a whitelisted extension, never a
    raw client-supplied name;
  - every /cache/* route is token-gated by the caller (server.py), not just
    LAN-scoped;
  - a single process-wide lock + `_active_job_id` enforce single-flight
    (409 'cache busy' on a second concurrent fetch);
  - every write re-checks REAL on-disk totals/free space (never an
    in-memory counter) before, during, and after the transfer, and refuses
    (507) rather than ever pushing the shared volume under the floor;
  - the file backing the engine's single active RemuxSession (as reported by
    remux.active_source_path()) is NEVER a candidate for eviction -- if
    honoring the cap/floor would require deleting it, the write is refused
    instead ("no prefetch this time"), it never corrupts a live stream.

This module is imported by server.py ONLY when both `cache.py` is present
AND `DUMIFLIX_CACHE_ENABLED=1` is set -- so the exact same server.py still
runs unmodified on TV/phone builds where neither is true.
"""

from __future__ import annotations

import collections
import hashlib
import http.client
import json
import math
import os
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

import remux  # sibling module -- read-only accessor only, see _protect_rel()
try:
    import direct_http  # Windows-only, opt-in Seedr/cache direct-route helper
except Exception:
    direct_http = None
try:
    import subsync  # sibling; optional -- absent on older builds that don't ship it,
    #                  or its own Whisper-model gate (subsync.subgen_enabled()) may be off
except Exception:
    subsync = None

# ===========================================================================
# Constants (env-overridable, but clamped server-side so no config value can
# ever push the true cap above 8 GiB or the floor below 4 GiB -- see plan's
# safetyPolicy).
# ===========================================================================

# Resolved ONCE, here, rather than at every call site: cache_files() walks
# CACHE_ROOT directly (via rglob) while _safe_resolve()/_protect_rel() build
# paths through .resolve(). If CACHE_ROOT itself were left unresolved (e.g. a
# symlinked parent directory), those two families of Path objects would be
# canonicalized differently and a `Path ==` comparison between them -- exactly
# what cache_evict() uses to skip the pinned/active file -- would silently
# never match, defeating the "never evict what's playing" guarantee. Resolving
# once here keeps every Path built from CACHE_ROOT in the same canonical form.
CACHE_ROOT = Path(os.environ.get('DUMIFLIX_CACHE_ROOT', str(Path.home() / 'dumiflix-cache'))).resolve()
# The floor is a HARD guarantee: at least 4 GiB remains free on a shared
# volume. A stale or misconfigured value can only raise that floor.
# The cap defaults to 8 GiB and is clamped by a separate ceiling; dedicated
# storage can raise both DUMIFLIX_CACHE_CAP_MAX and DUMIFLIX_CACHE_CAP_BYTES.
_CAP_CEILING = int(os.environ.get('DUMIFLIX_CACHE_CAP_MAX') or 8 * 1024 ** 3)
HARD_CAP_BYTES = min(int(os.environ.get('DUMIFLIX_CACHE_CAP_BYTES') or 8 * 1024 ** 3),
                      _CAP_CEILING)
FREE_FLOOR_BYTES = max(int(os.environ.get('DUMIFLIX_CACHE_FLOOR_BYTES', 4 * 1024 ** 3)),
                        4 * 1024 ** 3)
# Four MiB is still small relative to the minimum free-space floor,
# but reduces Python read/write calls and the relatively expensive Windows
# disk-usage query from once per MiB to once per four MiB. Bounds are still
# checked against the complete projected chunk BEFORE it is written, so this
# throughput improvement does not weaken the cap/floor guarantee.
CHUNK_BYTES = 4 * 1024 * 1024
GROWING_MIN_BYTES = max(CHUNK_BYTES, int(os.environ.get(
    'DUMIFLIX_CACHE_GROWING_MIN_BYTES') or 32 * 1024 ** 2))
# Inspect bounded container headers; small trailing indexes can be fetched
# on demand after the player leaves its direct origin stream.
GROWING_MP4_PROBE_BYTES = max(CHUNK_BYTES, int(os.environ.get(
    'DUMIFLIX_CACHE_GROWING_MP4_PROBE_BYTES') or 16 * 1024 ** 2))
GROWING_MKV_PROBE_BYTES = 16 * 1024 ** 2
GROWING_INDEX_MAX_BYTES = 64 * 1024 ** 2
RATE_WINDOW_SECONDS = 2.5
# On a slow origin a full CHUNK_BYTES read can take longer than the growing
# route's no-progress deadline; publish whatever arrived at least this often.
PUBLISH_INTERVAL_SECONDS = 0.25
FINALIZE_RETRY_SECONDS = 10.0 if os.name == 'nt' else 0.0
FINALIZE_RETRY_SLEEP = 0.05
OVERSHOOT_FACTOR = 1.20            # abort if received > 1.20x the declared/expected size
PART_MAX_AGE_S = 600               # sweep purges a stale '*.part' older than this
SWEEP_INTERVAL_S = max(15, int(os.environ.get(
    'DUMIFLIX_CACHE_SWEEP_INTERVAL_SECONDS') or 60))
# A sleeping external HDD must not be woken merely to prove that it is still
# idle.  When configured, the sweep remains active during real cache work and
# stops touching CACHE_ROOT after this many seconds without such work.
SWEEP_IDLE_SKIP_S = max(0, int(os.environ.get(
    'DUMIFLIX_CACHE_SWEEP_IDLE_SKIP_SECONDS') or 0))

# Video container extensions this cache will ever write. A client-supplied
# `name` that doesn't match one of these is coerced to '.bin' -- the on-disk
# filename is NEVER derived from the raw client string (see _rel_for()).
_ALLOWED_EXTS = frozenset({
    '.mp4', '.mkv', '.m4v', '.mov', '.avi', '.webm',
    '.mpg', '.mpeg', '.ts', '.m2ts', '.flv', '.wmv',
})

# Generated-subtitle sidecars (subsync.sub_sidecar_rel() -> '<rel>.en.srt')
# are NOT cache media: cache_files()/eviction below must never count or
# evict them as if they were a video entry, but a sidecar SHOULD disappear
# the moment its media file does (eviction, /cache/del, a stale sweep) so it
# never orphans next to a file that no longer exists. Matched broadly by
# extension ('*.srt') rather than only the exact '.en.srt' suffix, so any
# other subtitle sidecar convention that lands in the cache root is equally
# invisible to cap/floor accounting.
_SUBTITLE_EXT = '.srt'

# Below this many cues an extracted "English" subtitle is a FORCED track
# (foreign-language lines only), not the episode's dialogue. A 50-minute
# episode runs 500-900 cues; a forced track runs a few dozen. Only used to
# decide whether to keep looking at lower-ranked tracks -- never to discard
# the only subtitle a file has.
_MIN_FULL_SUB_CUES = 120

# ===========================================================================
# Process-wide state -- single-flight enforcement.
# ===========================================================================

CACHE_LOCK = threading.Lock()
_JOBS: dict = {}                 # job_id -> cache-download state (see reserve())
_active_job_id: Optional[str] = None
_ACTIVITY_LOCK = threading.Lock()
_last_cache_activity = time.monotonic()


def _mark_cache_activity() -> None:
    global _last_cache_activity
    with _ACTIVITY_LOCK:
        _last_cache_activity = time.monotonic()


def _cache_idle_for() -> float:
    with _ACTIVITY_LOCK:
        return max(0.0, time.monotonic() - _last_cache_activity)

# _JOBS grew one entry per distinct file EVER fetched, forever -- nothing
# ever popped it (unlike _active_job_id, which is cleared per-download).
# torrent.py hit and fixed the identical shape in its own _JOBS
# (_MAX_TERMINAL_JOBS + _prune_terminal_jobs_locked(), see torrent.py) --
# ported here verbatim. Only TERMINAL jobs (not currently in flight) are
# ever pruned; a season-prefetch run over months of shows is exactly the
# workload that made this a real, if slow (~300-500B/entry), leak.
_JOB_ACTIVE_STATES = {'started', 'downloading'}
_MAX_TERMINAL_JOBS = int(os.environ.get('DUMIFLIX_CACHE_MAX_TERMINAL_JOBS') or 64)


def _prune_terminal_jobs_locked() -> None:
    """Drop the oldest terminal (ready/error/aborted) job records beyond
    _MAX_TERMINAL_JOBS so _JOBS can't grow unbounded over a long uptime.
    Active jobs are always kept. Caller MUST hold CACHE_LOCK."""
    terminal = [(jid, j) for jid, j in _JOBS.items() if j.get('state') not in _JOB_ACTIVE_STATES]
    excess = len(terminal) - _MAX_TERMINAL_JOBS
    if excess <= 0:
        return
    terminal.sort(key=lambda kv: kv[1].get('created_at', 0))
    for jid, _j in terminal[:excess]:
        _JOBS.pop(jid, None)

# ===========================================================================
# Open-reader registry -- rel -> refcount of clients ACTIVELY reading it via
# GET/HEAD /cache/stream right now. This is a SEPARATE, stronger guarantee
# than remux.active_source_path(): that accessor is None whenever a cached
# episode plays DIRECT (remux disabled, or the source fails can_stream_copy)
# -- both realistic -- so relying on it alone leaves the file evictable mid-
# stream any time no RemuxSession happens to be open on it. server.py calls
# hold() before serving bytes and release() in a `finally` (even on
# BrokenPipe/Range/errors), so a rel with refcount>0 is protected regardless
# of whether a RemuxSession exists at all.
# ===========================================================================

_HOLDS_LOCK = threading.Lock()
_holds: dict = {}                # rel -> open-reader refcount


def hold(rel: str) -> None:
    """Register one active reader of `rel`. Must be paired with release()."""
    _mark_cache_activity()
    rel = _norm_rel(rel)
    if not rel:
        return
    with _HOLDS_LOCK:
        _holds[rel] = _holds.get(rel, 0) + 1


def release(rel: str) -> None:
    """Unregister one active reader of `rel` (call from a `finally`)."""
    rel = _norm_rel(rel)
    with _HOLDS_LOCK:
        n = _holds.get(rel, 0) - 1
        if n <= 0:
            _holds.pop(rel, None)
        else:
            _holds[rel] = n


def playback_active() -> dict:
    """Cheap watcher signal: active cache HTTP readers OR an active remux
    source means playback is consuming the laptop's network/disk pipeline.
    The watcher adds its own idle hold, so brief Range-request gaps do not
    cause torrent pause/resume flapping."""
    with _HOLDS_LOCK:
        readers = sum(max(0, int(n)) for n in _holds.values())
    try:
        remux_active = bool(remux.active_source_path())
    except Exception:
        remux_active = False
    return {'active': bool(readers or remux_active),
            'readers': readers, 'remux': remux_active}


def _is_held(rel: Optional[str]) -> bool:
    if not rel:
        return False
    with _HOLDS_LOCK:
        return _holds.get(_norm_rel(rel), 0) > 0


# ===========================================================================
# Display-name and source-ownership index. Legacy rel -> name strings remain
# readable; new entries also record the file id so readable LAN names cannot
# alias different sources. CACHE_LOCK may acquire _NAMES_LOCK, never the reverse.
# ===========================================================================

_NAMES_LOCK = threading.Lock()


def _names_path() -> Path:
    return CACHE_ROOT / '.names.json'


def _load_names() -> dict:
    try:
        with open(_names_path(), 'r') as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _write_names(d: dict) -> None:
    try:
        CACHE_ROOT.mkdir(parents=True, exist_ok=True)
        tmp = _names_path().with_name('.names.json.tmp')
        with open(tmp, 'w') as f:
            json.dump(d, f)
        tmp.replace(_names_path())
    except Exception:
        pass


def record_name(rel: str, name: str, file_id: Optional[str] = None) -> None:
    """Remember a display name, preserving any previously recorded owner."""
    if not rel or not name:
        return
    with _NAMES_LOCK:
        d = _load_names()
        old = d.get(rel)
        owner = old.get('file_id') if isinstance(old, dict) else None
        if file_id is not None:
            owner = str(file_id)
        entry = {'name': name, 'file_id': owner} if owner is not None else name
        if old != entry:
            d[rel] = entry
            _write_names(d)
            listing_invalidate()   # a new file just became listable


def display_name(rel: str) -> str:
    """Original filename for `rel` if known, else the hashed rel itself."""
    with _NAMES_LOCK:
        entry = _load_names().get(rel)
        return (entry.get('name') if isinstance(entry, dict) else entry) or rel


def prune_names(valid_rels) -> None:
    """Drop name entries whose file no longer exists (called by the sweep)."""
    valid = set(valid_rels)
    # Do not prune a reservation between choosing its name and publishing
    # its job. Keep the same CACHE_LOCK -> _NAMES_LOCK order as reserve().
    with CACHE_LOCK, _NAMES_LOCK:
        d = _load_names()
        active = {j.get('rel') for j in _JOBS.values()
                  if j.get('state') in ('started', 'downloading')}
        # A growing file still needs its owner while it is a .part. Recheck
        # under this lock: the sweep's file snapshot can predate a reservation.
        pruned = {k: v for k, v in d.items()
                  if k in valid or (CACHE_ROOT / k).exists()
                  or (CACHE_ROOT / (k + '.part')).exists()
                  or k in active}
        if len(pruned) != len(d):
            _write_names(pruned)


# ===========================================================================
# Listing index -- makes /cache/list instant, and keeps the HDD asleep
# ===========================================================================
# Rebuilding a listing walks CACHE_ROOT and reads each subtitle manifest.
# These small reads can be expensive on slow or network-mounted storage.
# Serve an atomic JSON index and refresh it on file or subtitle changes
# rather than on each read, reducing latency and unnecessary disk activity.
_LISTING_LOCK = threading.Lock()
_listing_refreshing = False
_listing_dirty = False


def _listing_path() -> Path:
    return CACHE_ROOT / '.listing.json'


# What the LIBRARY should see. cache_files() itself must keep returning
# everything (eviction accounting and the sweep need the true inventory),
# but the listing served to the TV is only playable video: torrent imports
# drag in .sub/.idx/.ass/.nfo/.txt/.jpg siblings (only bare '.srt' was ever
# excluded), and each of those rendered as a "movie" tile in the Library.
_LISTING_VIDEO_EXTS = ('.mkv', '.mp4', '.m4v', '.avi', '.ts', '.mov',
                       '.webm', '.mpg', '.mpeg', '.wmv', '.flv')


def _build_listing() -> list:
    """The expensive, always-correct listing. Walks the tree."""
    files = []
    for p, s, m in cache_files():
        rel = str(p.relative_to(CACHE_ROOT))
        name = display_name(rel)
        # Check the DISPLAY name, falling back to rel: legacy hashed rels
        # carry no meaningful extension of their own.
        probe = (name or rel).lower()
        if not probe.endswith(_LISTING_VIDEO_EXTS):
            continue
        files.append({'id': rel, 'rel': rel, 'name': name,
                      'size': s, 'mtime': int(m),
                      'subs_ready': subs_ready(rel), 'subs_url': subs_url(rel)})
    return files


def _write_listing(files: list) -> None:
    try:
        CACHE_ROOT.mkdir(parents=True, exist_ok=True)
        tmp = _listing_path().with_name('.listing.json.tmp')
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump({'v': 1, 'files': files}, f)
        tmp.replace(_listing_path())
    except Exception:
        pass


def _read_listing():
    try:
        with open(_listing_path(), 'r', encoding='utf-8') as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get('files'), list):
            return d['files']
    except Exception:
        pass
    return None


def listing_invalidate() -> None:
    """Something changed -- rebuild the index in the background.

    Single-flight: concurrent invalidations (a batch import finishing, a
    burst of manifest writes) collapse into one walk instead of one each."""
    global _listing_refreshing, _listing_dirty
    with _LISTING_LOCK:
        if _listing_refreshing:
            # Do not drop a mutation that lands during a build. The current
            # walk may already have passed the newly-imported file, so request
            # one more pass when this flight finishes.
            _listing_dirty = True
            return
        _listing_refreshing = True
        _listing_dirty = False

    def _run():
        global _listing_refreshing, _listing_dirty
        while True:
            try:
                _write_listing(_build_listing())
            except Exception:
                pass
            with _LISTING_LOCK:
                if _listing_dirty:
                    _listing_dirty = False
                    continue
                _listing_refreshing = False
                return

    threading.Thread(target=_run, daemon=True).start()


def rebuild_listing() -> list:
    """Synchronously reconcile the persisted index with the physical cache.

    Called once at service startup, before routes go live, so a process death
    between a completed file move and its background invalidation cannot leave
    that file invisible for the lifetime of the next server process.
    """
    files = _build_listing()
    _write_listing(files)
    return files


def listing_files() -> list:
    """Files for GET /cache/list. Served from the index; only the very first
    call on a fresh cache (no index file yet) pays for a walk."""
    _mark_cache_activity()
    cached = _read_listing()
    if cached is not None:
        return cached
    files = _build_listing()
    _write_listing(files)
    return files


# ===========================================================================
# Path safety
# ===========================================================================

def _safe_resolve(rel: str) -> Path:
    """Resolve <CACHE_ROOT>/<rel>, refusing any escape via '..', an absolute
    path, or a symlink pointing outside the root. All cache paths must
    remain contained in CACHE_ROOT after resolution."""
    rel = (rel or '').replace('\\', '/').strip().lstrip('/')
    if not rel:
        raise PermissionError('empty path')
    root = CACHE_ROOT.resolve()
    target = (root / rel).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        raise PermissionError(f'path escapes cache root: {rel!r}')
    return target


def _ext_for(name: str) -> str:
    ext = os.path.splitext(str(name or ''))[1].lower()
    return ext if ext in _ALLOWED_EXTS else '.bin'


# Baked-subtitle store root -- dot-prefixed so cache_files()'s existing
# skip-any-dot-prefixed-path-component logic (see its docstring) already
# hides this whole tree from cap/floor accounting, the same mechanism that
# already hides .torrents/ and .names.json. <rel> below is always the SAME
# flat, already-sanitized cache-relative filename _rel_for() produces for
# the media file itself (never a nested path), mirrored 1:1 as a directory
# name under here.
_SUBS_ROOT_NAME = '.subs'


def _subs_dir(rel: str) -> Path:
    """Resolve CACHE_ROOT/.subs/<rel>, refusing any escape via '..', an
    absolute path, or a symlink pointing outside that root -- same
    containment contract as _safe_resolve() above, applied under the
    dot-prefixed subs root instead of CACHE_ROOT directly. Does NOT create
    the directory (callers mkdir on their own write paths)."""
    rel = _norm_rel(rel)
    if not rel:
        raise PermissionError('empty path')
    root = (CACHE_ROOT / _SUBS_ROOT_NAME).resolve()
    target = (root / rel).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        raise PermissionError(f'path escapes subs root: {rel!r}')
    return target


# Trick-play storyboard store -- same dot-prefixed-subtree convention as
# .subs/ above (invisible to cache_files()/cap/floor accounting). <rel> is
# again the flat cache-relative media filename, mirrored 1:1 as a directory
# name here. See the "Trick-play thumbnails" section near the end of this
# file for the generator/manifest/queue.
_THUMBS_ROOT_NAME = '.thumbs'


def _thumbs_dir(rel: str) -> Path:
    """Resolve CACHE_ROOT/.thumbs/<rel>, refusing any escape via '..', an
    absolute path, or a symlink pointing outside that root -- identical
    containment contract to _subs_dir() above, applied under the
    dot-prefixed thumbs root instead. Does NOT create the directory."""
    rel = (rel or '').strip().lstrip('/').lstrip('\\')
    if not rel:
        raise PermissionError('empty path')
    root = (CACHE_ROOT / _THUMBS_ROOT_NAME).resolve()
    target = (root / rel).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        raise PermissionError(f'path escapes thumbs root: {rel!r}')
    return target


# Hashing keeps media paths opaque by default. A trusted LAN deployment may
# opt into readable names for its library and subtitle filename matching.
# Authentication is still required; naming alone is not access control.
_HASH_NAMES = os.environ.get('DUMIFLIX_CACHE_HASH_NAMES', '1') != '0'
# Characters that are unsafe in a Windows/Unix path; stripped (spaces, dots,
# S01E08 etc. are KEPT so the app can parse + display the real title).
_UNSAFE_NAME_RE = None  # lazy-compiled below to avoid a module-level import churn


def _sanitize_name(name: str, file_id: str) -> str:
    """Filesystem-safe real filename for LAN mode (keeps a whitelisted ext)."""
    import re as _re
    base = os.path.basename(str(name or '')).strip()
    base = _re.sub(r'[\\/:*?"<>|\x00-\x1f]', '', base)   # path-hostile only
    stem, ext = os.path.splitext(base)
    if ext.lower() not in _ALLOWED_EXTS:
        ext = _ext_for(name)
    stem = (stem or '').strip()[:120]
    if not stem:
        stem = 'cache_' + hashlib.sha256(str(file_id).encode('utf-8')).hexdigest()[:12]
    return stem + ext


def _rel_for(file_id: str, name: str, expected_bytes: int = 0) -> str:
    """Return (and claim) a stable filename without renaming legacy files."""
    if not _HASH_NAMES:
        file_id = str(file_id)
        with _NAMES_LOCK:
            names = _load_names()
            for rel, entry in names.items():
                if isinstance(entry, dict) and entry.get('file_id') == file_id:
                    return rel
            # Case-fold on every platform for portable, case-insensitive names.
            taken = {rel.casefold(): rel for rel in names}
            try:
                for path in CACHE_ROOT.iterdir():
                    rel = path.name[:-5] if path.name.endswith('.part') else path.name
                    taken.setdefault(rel.casefold(), rel)
            except FileNotFoundError:
                pass
            candidate = _sanitize_name(name, file_id)
            stem, ext = os.path.splitext(candidate)
            digest = hashlib.sha256(file_id.encode('utf-8')).hexdigest()[:12]
            attempt = 0
            while candidate.casefold() in taken:
                existing = taken[candidate.casefold()]
                # The same movie re-fetched through Seedr arrives under a new
                # file id every time; an existing copy of exactly the expected
                # size is that file, not another title with the same name
                # (repeated origin lookups can otherwise duplicate the same file).
                if expected_bytes and int(expected_bytes) > 0:
                    try:
                        if (CACHE_ROOT / existing).stat().st_size == int(expected_bytes):
                            candidate = existing
                            break
                    except OSError:
                        pass
                entry = names.get(existing)
                owner = entry.get('file_id') if isinstance(entry, dict) else None
                # Old files have no source identity. Adopt their first caller
                # in place, so existing cache lookup keeps working unchanged.
                if (owner is None and attempt == 0) or owner == file_id:
                    candidate = existing
                    break
                attempt += 1
                suffix = digest if attempt == 1 else '%s-%d' % (digest, attempt)
                candidate = '%s_%s%s' % (stem, suffix, ext)
            names[candidate] = {'name': name, 'file_id': file_id}
            _write_names(names)
            listing_invalidate()
            return candidate
    h = hashlib.sha256(str(file_id).encode('utf-8')).hexdigest()[:24]
    return h + _ext_for(name)


def _unlink_quiet(p: Path) -> None:
    try:
        if p.exists():
            p.unlink()
    except OSError:
        pass


def _cleanup_sub_sidecars(rel: str) -> None:
    """Delete every subtitle artifact for a media file that no longer
    exists (or is being manually deleted): the LEGACY Whisper-generated
    '<rel>.en.srt' sidecar AND the new baked-subtitle tree
    CACHE_ROOT/.subs/<rel>/ (manifest.json + every <fp>.srt/<fp>.orig.srt).
    Shared by cache_evict()'s per-deleted-file cleanup and server.py's
    POST /cache/del, so both call sites use one implementation instead of
    duplicating the rmtree. Best-effort -- never raises.

    ALSO removes the trick-play thumbnail storyboard sidecar
    (CACHE_ROOT/.thumbs/<rel>/) for the identical reason: a media file's
    preprocessed artifacts (subs AND thumbs) must never outlive the file
    itself, and this is the one place both existing call sites already
    funnel through -- see the "Trick-play thumbnails" section further down
    for queue_thumbs()/_thumbs_dir()."""
    if not rel:
        return
    # Every deletion route (manual /cache/del and cache_evict's own cleanup)
    # funnels through here, so it is the one place the listing index has to
    # learn that a file went away.
    listing_invalidate()
    _unlink_quiet(CACHE_ROOT / (rel + '.en.srt'))
    # _MANIFEST_LOCKS (defined further below) held one threading.Lock() per
    # unique rel EVER synced, never removed -- a slow, unbounded leak over a
    # long uptime. The safe place to drop it is exactly HERE: the media file
    # (and therefore its whole .subs/<rel>/ manifest tree, rmtree'd right
    # below) is being permanently removed, so no FUTURE _manifest_lock(rel)
    # call for this rel is legitimate -- eviction/delete of the same rel a
    # second time is a no-op elsewhere in this module. Popping a dict entry
    # is not the same as invalidating an in-flight critical section: a
    # concurrent _mutate_manifest() call already holding this rel's lock
    # keeps its own reference and finishes normally either way. Every file
    # currently IN the cache is inherently bounded by HARD_CAP_BYTES, so
    # tying removal to eviction/delete keeps _MANIFEST_LOCKS bounded by "how
    # many distinct files could ever be in the cache at once" instead of
    # "how many were ever downloaded across the process's entire uptime".
    with _MANIFEST_META_LOCK:
        _MANIFEST_LOCKS.pop(_norm_rel(rel), None)
    try:
        d = _subs_dir(rel)
    except PermissionError:
        d = None
    if d is not None:
        shutil.rmtree(d, ignore_errors=True)

    # Same leak-prevention + removal reasoning as _MANIFEST_LOCKS above,
    # applied to the thumbs manifest lock dict and the in-memory generation
    # queue: this rel is going away permanently, so no future thumbs job
    # for it is legitimate, and a currently-QUEUED-but-not-yet-started
    # entry must not try to generate storyboards for a file that's about to
    # not exist (an already-RUNNING job still finishes normally -- it holds
    # its own reference and _run_thumbs_job() fails closed with 'error'
    # once the source file is gone, same as any other missing-source case).
    with _THUMBS_MANIFEST_META_LOCK:
        _THUMBS_MANIFEST_LOCKS.pop(rel, None)
    with _THUMBS_QUEUE_LOCK:
        _thumbs_queued_rels.discard(rel)
        try:
            _thumbs_queue.remove(rel)
        except ValueError:
            pass
    try:
        td = _thumbs_dir(rel)
    except PermissionError:
        td = None
    if td is not None:
        shutil.rmtree(td, ignore_errors=True)


# ===========================================================================
# Eviction pinning -- never delete the file behind the live RemuxSession.
# ===========================================================================

def _protect_rel() -> Optional[str]:
    """Best-effort: derive the cache-relative path of the file currently
    backing the engine's one active RemuxSession, so cache_evict() can skip it.
    remux.active_source_path() returns either the public /cache/stream/<rel>
    URL we handed back as sourceReference (the shipped scheme) or, for the
    deferred usb-fast-path, a raw absolute path already under CACHE_ROOT.
    Returns None (nothing to protect) on any parse failure -- fails safe by
    simply not pinning, which the preflight/mid-flight/sweep floor+cap
    checks still bound independently."""
    try:
        src = remux.active_source_path()
    except Exception:
        return None
    if not src:
        return None
    try:
        parsed = urllib.parse.urlparse(src)
        path = parsed.path if parsed.scheme else src
    except Exception:
        path = src
    marker = '/cache/stream/'
    if marker in path:
        return urllib.parse.unquote(path.split(marker, 1)[1])
    try:
        p = Path(path).resolve()
        return str(p.relative_to(CACHE_ROOT.resolve()))
    except Exception:
        return None


def protected_rel() -> Optional[str]:
    """Public accessor for the rel path cache_evict() should never delete --
    the file backing the live RemuxSession, if any. Exposed so other bolt-on
    modules sharing this disk budget (e.g. torrent.py) can pass the same
    protection into their own cache_evict() calls without reaching into the
    module-private _protect_rel()."""
    return _protect_rel()


_protect_providers = []
_protect_providers_lock = threading.Lock()


def register_protect_provider(fn) -> None:
    """
    Register a callable returning an iterable of cache-relative paths that
    eviction and manual delete must both skip.

    Exists because protection used to be exactly TWO things: a file with an
    open reader, and the single file backing the live RemuxSession. That is
    the right model when every download is a one-shot fetch of the thing you
    are about to watch. It breaks the moment a season is queued ahead of
    time: episodes 2-10 are finished on disk, have no reader, and back no
    session, so they are the OLDEST-mtime, least-protected files in the
    cache -- i.e. exactly what cache_evict() reaches for first. The queue
    would then delete its own completed work to make room for its next item
    and never converge.

    A provider registry (rather than season.py being imported here) keeps the
    dependency pointing one way: season.py imports cache, never the reverse.
    Providers are called inside eviction, so they must be cheap and must not
    take a lock that eviction could already hold.

    A raising or slow provider must never wedge eviction -- every call site
    swallows exceptions and treats a failure as "protects nothing", which
    fails toward reclaiming space rather than filling the disk.
    """
    with _protect_providers_lock:
        if fn not in _protect_providers:
            _protect_providers.append(fn)


def _norm_rel(rel) -> str:
    """One resolved identity for readers, aliases, providers and deletion."""
    try:
        identity = _safe_resolve(str(rel or '')).relative_to(CACHE_ROOT.resolve()).as_posix()
        return identity.casefold() if os.name == 'nt' else identity
    except (PermissionError, OSError, ValueError):
        return ''


def _provider_protected_rels() -> set:
    """Union of every registered provider's rels. Best-effort by design."""
    out = set()
    with _protect_providers_lock:
        providers = list(_protect_providers)
    for fn in providers:
        try:
            for rel in (fn() or ()):
                if rel:
                    out.add(str(rel))
        except Exception:
            continue
    return out


def is_protected(rel: str) -> bool:
    """True if `rel` names a file with an open reader (refcount>0, i.e. some
    client is mid GET/HEAD /cache/stream on it right now) OR the file
    currently backing the live RemuxSession -- used by server.py's
    /cache/del handler so a manual delete can't defeat the same protection
    eviction already honors. Either condition alone is sufficient: a file is
    never evictable/deletable while ANY client is actively reading it,
    session or not."""
    if _is_held(rel):
        return True
    if _norm_rel(rel) in {_norm_rel(r) for r in _provider_protected_rels()}:
        return True
    protect_rel = _protect_rel()
    if not protect_rel:
        return False
    try:
        return _safe_resolve(rel) == _safe_resolve(protect_rel)
    except PermissionError:
        return False


def delete_cached(rel: str) -> bool:
    """Delete a cache entry, serializing the final check with new readers."""
    target = _safe_resolve(rel)
    if is_protected(rel):
        return False
    with _HOLDS_LOCK:
        if _holds.get(_norm_rel(rel), 0) > 0:
            return False
        if target.is_file():
            target.unlink()
    _cleanup_sub_sidecars(str(target.relative_to(CACHE_ROOT.resolve())))
    return True


# ===========================================================================
# Inventory + eviction
# ===========================================================================

def cache_files():
    """Fresh (never memoized) [(Path, size, mtime), ...] of finished cache
    files -- always re-walks CACHE_ROOT, skips '*.part'.

    Also skips anything living under a dot-prefixed DIRECTORY, not just a
    dot-prefixed leaf filename: `Path.rglob('*')` happily recurses into a
    directory like `.torrents/<job>/` and returns its real-named contents
    (e.g. `movie.mkv`), so checking only `p.name` would let an in-flight
    staged download (torrent.py's bolt-on downloader stages under
    CACHE_ROOT/.torrents/<job>/ while aria2 is still writing it) get counted
    as a finished cache file -- eligible for cache_evict() to delete out
    from under an active writer, and wrongly listed in /cache/list before
    it's actually imported. Any path component other than CACHE_ROOT itself
    that starts with '.' now hides the whole subtree from this inventory --
    the same intent that already excluded '.names.json', just applied one
    level deeper now that a bolt-on stages real files under a dotdir."""
    out = []
    if not CACHE_ROOT.exists():
        return out
    for p in CACHE_ROOT.rglob('*'):
        if not p.is_file() or p.name.endswith('.part') or p.name.lower().endswith(_SUBTITLE_EXT):
            continue
        try:
            rel_parts = p.relative_to(CACHE_ROOT).parts
        except ValueError:
            continue
        if any(part.startswith('.') for part in rel_parts):
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        out.append((p, st.st_size, st.st_mtime))
    return out


def _free_bytes() -> int:
    try:
        return shutil.disk_usage(CACHE_ROOT).free
    except OSError:
        return 0


def _capacity_usage(exclude: Optional[Path] = None) -> int:
    """Finished/importing files plus each writer's reserved or actual bytes.

    Callers that admit/write bytes hold CACHE_LOCK. A part and its final path
    share one budget entry, including during atomic promotion. Sparse tail
    writes are conservatively charged at their full logical size.
    """
    usage = {p: size for p, size, _mtime in cache_files()}
    for part in CACHE_ROOT.rglob('*.part'):
        if any(piece.startswith('.') for piece in part.relative_to(CACHE_ROOT).parts):
            continue
        try:
            dest = part.with_name(part.name[:-5])
            usage[dest] = max(usage.get(dest, 0), part.stat().st_size)
        except OSError:
            pass
    for job in list(_JOBS.values()):
        if job.get('state') in _JOB_ACTIVE_STATES and job.get('path'):
            dest = Path(job['path'])
            usage[dest] = max(usage.get(dest, 0), int(job.get('total') or 0),
                              int(job.get('received') or 0))
    return sum(size for path, size in usage.items() if path != exclude)


def _pending_capacity() -> int:
    """Bytes promised to active cache writers that are not yet on disk."""
    pending = {}
    for job in list(_JOBS.values()):
        if job.get('state') not in _JOB_ACTIVE_STATES or not job.get('path'):
            continue
        dest = Path(job['path'])
        actual = 0
        for path in (dest, dest.with_name(dest.name + '.part')):
            try:
                actual = max(actual, path.stat().st_size)
            except OSError:
                pass
        pending[dest] = max(pending.get(dest, 0),
                            max(0, int(job.get('total') or 0) - actual))
    return sum(pending.values())


def _preflight_download(job: dict, expected: int) -> None:
    """Repeat cap AND free-floor admission whenever a size is discovered."""
    if expected > HARD_CAP_BYTES:
        raise RuntimeError('file exceeds cache cap')
    with CACHE_LOCK:
        job['total'] = expected
        if (_capacity_usage() > HARD_CAP_BYTES
                or _free_bytes() - _pending_capacity() < FREE_FLOOR_BYTES):
            cache_evict(protect_rel=_protect_rel())
        if _capacity_usage() > HARD_CAP_BYTES:
            raise RuntimeError('cache full')
        if _free_bytes() - _pending_capacity() < FREE_FLOOR_BYTES:
            raise RuntimeError('insufficient free disk')


def cache_evict(need_bytes: int = 0, protect_rel: Optional[str] = None) -> None:
    """Delete oldest-by-mtime finished files (never the protected one, and
    never one with an open reader -- see the open-reader registry above)
    until the cap AND the floor (given an incoming write of `need_bytes`) are
    both satisfied, or there's nothing left to evict. Best-effort: does not
    raise and does not itself decide success/failure -- callers (reserve(),
    cache_download(), the periodic sweep) re-check real totals/free space
    afterward to make that call themselves."""
    files = cache_files()
    files.sort(key=lambda t: t[2])          # oldest mtime first
    total = _capacity_usage()
    free = _free_bytes() - _pending_capacity()

    protect_path = None
    if protect_rel:
        try:
            protect_path = _safe_resolve(protect_rel)
        except PermissionError:
            protect_path = None

    # Files a registered provider claims (today: the season prefetch queue's
    # own finished episodes). Computed ONCE per eviction pass, not per file --
    # the season worker calls eviction on every queued item, and re-deriving
    # this inside the loop would make a large season quadratic.
    provider_protected = {_norm_rel(r) for r in _provider_protected_rels()}

    for p, s, _m in files:
        over_cap = (total + need_bytes) > HARD_CAP_BYTES
        under_floor = (free - need_bytes) < FREE_FLOOR_BYTES
        if not over_cap and not under_floor:
            break
        if protect_path is not None and p == protect_path:
            continue
        try:
            rel = str(p.relative_to(CACHE_ROOT))
        except ValueError:
            rel = None
        if provider_protected and _norm_rel(rel) in provider_protected:
            continue
        try:
            # Serialize reader registration with both the final check and
            # unlink. A reader holding this rel must win before deletion.
            with _HOLDS_LOCK:
                if _holds.get(_norm_rel(rel), 0) > 0:
                    continue
                p.unlink()
            total -= s
            free += s
        except OSError:
            pass
        else:
            # Neither the legacy sidecar nor the new .subs/ tree is itself
            # in `files` (cache_files() skips '*.srt' and dot-prefixed
            # subtrees), so they never affect the cap/floor math above --
            # but they must not outlive the media file they were generated
            # for.
            if rel:
                _cleanup_sub_sidecars(rel)


_SUMMARY_USED = {'at': 0.0, 'used': 0}


def status_summary(max_age: float = 0.0) -> dict:
    """Cache usage. ``max_age`` lets /health reuse a recent total: summing
    the whole cache walks hundreds of files (~250 ms warm, seconds on a
    spun-down HDD), which made the TV's 2.5 s reachability probe fail."""
    now = time.monotonic()
    if max_age and _SUMMARY_USED['at'] and now - _SUMMARY_USED['at'] <= max_age:
        used = _SUMMARY_USED['used']
    else:
        used = sum(s for _, s, _ in cache_files())
        _SUMMARY_USED.update(at=now, used=used)
    result = {
        'root': str(CACHE_ROOT),
        'cap': HARD_CAP_BYTES,
        'floor': FREE_FLOOR_BYTES,
        'used': used,
        'free': _free_bytes(),
    }
    if direct_http is not None:
        result['direct_http'] = direct_http.config_summary()
    return result


# ===========================================================================
# reserve() -- single-flight preflight, holds CACHE_LOCK
# ===========================================================================

def reserve(file_id: str, name: str, url: str, expected_bytes: int = 0,
            job_id: Optional[str] = None) -> dict:
    """Under CACHE_LOCK: refuse 409 if another download is in flight; if the
    file is already fully cached, return 'ready' immediately (no download
    needed, no single-flight conflict); otherwise re-walk the REAL current
    total and re-read REAL free bytes, evict oldest-first (protecting the
    active session's file AND any open-reader-held file) if that would help,
    and refuse 507 if the cap or floor would still be violated. On success,
    registers the job and sets `_active_job_id` so the caller can spawn
    cache_download(job_id) in a background thread.

    Response shape matches the locked wire contract exactly:
      success -> {'ok': True, 'id': <job/file id>, 'rel': <hashed path>,
                  'state': 'started' | 'ready'}
      busy    -> {'ok': False, 'status': 409, 'error': 'busy', 'state': 'busy',
                  'id': <id of the in-flight job>}
      refused -> {'ok': False, 'status': 507, 'error': '...'}
    `job_id` (== the client-supplied `id`) is always echoed back as `id`."""
    global _active_job_id
    jid = job_id or hashlib.sha256(str(file_id).encode('utf-8')).hexdigest()[:16]

    with CACHE_LOCK:
        rel = _rel_for(file_id, name, expected_bytes)
        dest = CACHE_ROOT / rel
        record_name(rel, name, file_id)
        _prune_terminal_jobs_locked()
        active_dest = any(j.get('path') == str(dest) and j.get('state') in _JOB_ACTIVE_STATES
                          for j in _JOBS.values())
        if not active_dest and _completed_part(dest) is not None:
            try:
                _promote_completed_part(dest)
            except OSError as e:
                return {'ok': False, 'status': 409,
                        'error': 'completed download awaiting promotion: %s' % e}
        if dest.is_file():
            try:
                sz = dest.stat().st_size
            except OSError:
                sz = 0
            _JOBS[jid] = {'state': 'ready', 'received': sz, 'total': sz, 'rel': rel,
                          'path': str(dest), 'url': url, 'error': None, 'file_id': file_id,
                          'created_at': time.time()}
            # Already a finished cache entry -- e.g. a re-fetch of something
            # cached before this feature shipped, or before Whisper was
            # configured. Covers the "successful import" trigger for a file
            # that never goes through cache_download()'s success path below.
            try:
                maybe_generate_sub(rel)
            except Exception:
                pass
            return {'ok': True, 'id': jid, 'rel': rel, 'state': 'ready'}

        if _active_job_id is not None:
            existing = _JOBS.get(_active_job_id)
            if existing and existing.get('state') in ('started', 'downloading'):
                return {'ok': False, 'status': 409, 'error': 'busy', 'state': 'busy',
                        'id': _active_job_id}
            _active_job_id = None   # stale reference with no live job -- clear and proceed

        try:
            CACHE_ROOT.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            return {'ok': False, 'status': 500, 'error': f'cache root unavailable: {e}'}

        if expected_bytes > HARD_CAP_BYTES:
            return {'ok': False, 'status': 507, 'error': 'file exceeds cache cap'}

        protect_rel = _protect_rel()
        cache_evict(need_bytes=expected_bytes, protect_rel=protect_rel)

        files = cache_files()
        total = _capacity_usage()
        free = _free_bytes() - _pending_capacity()

        if free - expected_bytes < FREE_FLOOR_BYTES:
            return {'ok': False, 'status': 507, 'error': 'insufficient free disk'}
        if total + expected_bytes > HARD_CAP_BYTES:
            return {'ok': False, 'status': 507, 'error': 'cache full'}

        job = {'state': 'started', 'received': 0, 'total': expected_bytes, 'rel': rel,
               'path': str(dest), 'url': url, 'name': name, 'error': None,
               '_cancel': False, 'file_id': file_id, 'created_at': time.time()}
        _JOBS[jid] = job
        _active_job_id = jid
        return {'ok': True, 'id': jid, 'rel': rel, 'state': 'started'}


# ===========================================================================
# cache_download() -- spawned in a daemon thread by the caller after reserve()
# ===========================================================================

def _job_urlopen(job: dict, request, timeout: float):
    session = job.get('_direct_http_session')
    if session is not None:
        return session.open(request, timeout=timeout)
    return urllib.request.urlopen(request, timeout=timeout)


def _probe_remote_size(job: dict, timeout: float = 10.0) -> int:
    """Best-effort discovery of the REAL remote size, without ever reading
    the body. The client always sends total:0 (see module docstring), so
    without this, HARD_CAP_BYTES enforcement would be a no-op and only the
    free-disk floor would bound a growing download. Tries HEAD first, then
    falls back to a 1-byte Range GET for hosts that don't implement HEAD well
    (reading Content-Range's total on a 206, never the 1-byte body itself).
    Returns 0 ("unknown") if the size can't be determined either way."""
    try:
        req = urllib.request.Request(job['url'], method='HEAD',
                                      headers={'User-Agent': 'DumiFlix-Cache/1.0'})
        with _job_urlopen(job, req, timeout=timeout) as r:
            cl = r.headers.get('Content-Length')
            if cl:
                return int(cl)
    except Exception:
        pass
    try:
        req2 = urllib.request.Request(job['url'], headers={
            'User-Agent': 'DumiFlix-Cache/1.0', 'Range': 'bytes=0-0'})
        with _job_urlopen(job, req2, timeout=timeout) as r:
            if r.status == 206:
                cr = r.headers.get('Content-Range', '')
                if '/' in cr:
                    try:
                        return int(cr.rsplit('/', 1)[-1])
                    except ValueError:
                        pass
            else:
                # Server ignored the Range request and would have sent the
                # whole body starting here -- Content-Length IS the real
                # total. We never call .read() on it, so no bytes are
                # actually pulled before the `with` block closes it.
                cl = r.headers.get('Content-Length')
                if cl:
                    try:
                        return int(cl)
                    except ValueError:
                        pass
    except Exception:
        pass
    return 0


def _warm_probe_cache(path: Path) -> None:
    """Best-effort background ffprobe warm-up for a freshly finished cache
    file -- see cache_download()'s success-path call site. Backgrounded
    here on TOP of remux.probe_cached()'s own internal backgrounding of the
    sidecar write, so the actual ffprobe subprocess call never runs on
    cache_download()'s thread either -- the download is already fully done
    by this point and must return immediately. No-op (swallowed) if remux
    can't probe the file for any reason: a cold ffprobe simply runs again
    on first play, exactly the behavior that existed before this feature."""
    def _run():
        try:
            remux.probe_cached(str(path))
        except Exception:
            pass
    threading.Thread(target=_run, daemon=True, name='cache-probe-warm').start()


def _recoverable_lane_error(exc: BaseException) -> bool:
    """Network/origin trouble on the second (tail) connection: the main lane
    can finish those bytes itself. Bounds, cancel and route-lease errors are
    not recoverable and still stop the whole copy."""
    if isinstance(exc, (urllib.error.URLError, http.client.HTTPException, OSError)):
        return True
    return isinstance(exc, RuntimeError) and str(exc).startswith('origin ')


def _log_open_failure(attempt: int, started: float, reason: str,
                      start: Optional[int]) -> None:
    # Origin URLs carry signed tokens: log only the reason, offset and timing.
    try:
        print('[cache] origin open attempt %d failed after %.1fs: %s (offset %s)'
              % (attempt + 1, time.monotonic() - started, reason,
                 'none' if start is None else start), flush=True)
    except Exception:
        pass


def _abort_response(response) -> None:
    """Unblock a reader parked in recv (closing alone may not wake it)."""
    try:
        response.fp.raw._sock.shutdown(socket.SHUT_RDWR)
    except Exception:
        pass
    try:
        response.close()
    except Exception:
        pass


def _open_download(job: dict, start: Optional[int] = None,
                   end: Optional[int] = None, attempts: int = 4,
                   timeout: float = 30):
    """Open one origin connection with bounded cold-link retries."""
    headers = {
        'User-Agent': 'DumiFlix-Cache/1.0',
        'Accept-Encoding': 'identity',
    }
    if start is not None:
        headers['Range'] = 'bytes=%d-%s' % (
            start, '' if end is None else str(end))
    req = urllib.request.Request(job['url'], headers=headers)
    last_error = None
    for attempt in range(attempts):
        started = time.monotonic()
        stop = job.get('_stop_event')
        if job.get('_cancel') or (stop is not None and stop.is_set()):
            raise RuntimeError('cancelled')
        try:
            return _job_urlopen(job, req, timeout=timeout)
        except urllib.error.HTTPError as e:
            last_error = e
            e.close()
            _log_open_failure(attempt, started, 'HTTP %s' % e.code, start)
            if attempt == attempts - 1 or e.code not in (403, 404, 425, 429,
                                               500, 502, 503, 504):
                raise
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_error = e
            _log_open_failure(attempt, started, type(e).__name__, start)
            if attempt == attempts - 1:
                raise
        time.sleep(3 * (attempt + 1))
    raise last_error or RuntimeError('origin connection failed')


def _validated_content_range(response, start: int, end: int,
                             total: int) -> bool:
    """True only for the exact 206 response requested."""
    if getattr(response, 'status', response.getcode()) != 206:
        return False
    value = str(response.headers.get('Content-Range') or '').strip()
    try:
        unit, value = value.split(None, 1)
        bounds, remote_total = value.split('/', 1)
        a, b = bounds.split('-', 1)
        return (unit.lower() == 'bytes' and int(a) == start and int(b) == end
                and remote_total != '*' and int(remote_total) == total)
    except (ValueError, TypeError):
        return False


def _mp4_box(data: bytes, off: int, total: int) -> tuple:
    if off + 8 > len(data):
        raise EOFError
    size = int.from_bytes(data[off:off + 4], 'big')
    kind = data[off + 4:off + 8]
    header = 8
    if size == 1:
        if off + 16 > len(data):
            raise EOFError
        size = int.from_bytes(data[off + 8:off + 16], 'big')
        header = 16
    elif size == 0:
        if not total:
            raise EOFError
        size = total - off
    if size < header or (total and off + size > total):
        raise ValueError('invalid MP4 box size')
    return kind, off + size


def _mp4_index_info(data: bytes, total: int) -> Optional[dict]:
    off = 0
    n = len(data)
    incomplete = None if n < GROWING_MP4_PROBE_BYTES else False
    try:
        while off + 8 <= n:
            if data[off:off + 8] == b'\x00\x00\x00\x00mdat' and not total:
                return {'safe': False}
            kind, end = _mp4_box(data, off, total)
            if kind == b'mdat':
                # The next top-level box may be moov (or padding before it).
                # Its headers are checked after the trailing region arrives.
                return {'safe': False, 'start': end if total > end else 0}
            if kind == b'moov':
                return {'safe': True} if end <= n else (
                    None if incomplete is None else {'safe': False})
            if end > n:
                break
            off = end
    except EOFError:
        pass
    except ValueError:
        return {'safe': False}
    return None if incomplete is None else {'safe': False}


def _mp4_faststart_ready(path: Path, contiguous: int) -> Optional[bool]:
    """True/False for a conclusive probe; None while more bytes are needed."""
    try:
        with open(path, 'rb') as f:
            data = f.read(min(int(contiguous or 0), GROWING_MP4_PROBE_BYTES))
    except OSError:
        return None
    info = _mp4_index_info(data, 0)
    return info['safe'] if info is not None else None


def _ebml_vint(data: bytes, off: int, element_id: bool = False) -> tuple:
    if off >= len(data):
        raise EOFError
    first = data[off]
    width = 1
    mask = 0x80
    while mask and not first & mask:
        width += 1
        mask >>= 1
    if not mask or width > (4 if element_id else 8):
        raise ValueError('invalid EBML integer')
    if off + width > len(data):
        raise EOFError
    value = int.from_bytes(data[off:off + width], 'big')
    if not element_id:
        value &= (1 << (width * 7)) - 1
        if value == (1 << (width * 7)) - 1:
            value = None  # Unknown-sized Segment is common in Matroska.
    return value, width


def _ebml_element(data: bytes, off: int) -> tuple:
    kind, width = _ebml_vint(data, off, element_id=True)
    size, size_width = _ebml_vint(data, off + width)
    start = off + width + size_width
    return kind, start, None if size is None else start + size


def _mkv_seek_entries(data: bytes, segment_start: int, total: int) -> tuple:
    pos = 0
    links = []
    while pos < len(data):
        kind, start, end = _ebml_element(data, pos)
        if end is None or end > len(data):
            raise ValueError('invalid SeekHead entry')
        if kind == 0x4DBB:  # Seek
            child = start
            seek_id = seek_position = None
            while child < end:
                key, value_start, value_end = _ebml_element(data, child)
                if value_end is None or value_end > end:
                    raise ValueError('invalid Seek field')
                value = data[value_start:value_end]
                if key == 0x53AB:
                    seek_id = int.from_bytes(value, 'big')
                elif key == 0x53AC:
                    if not 1 <= len(value) <= 8:
                        raise ValueError('invalid SeekPosition')
                    seek_position = int.from_bytes(value, 'big')
                child = value_end
            if seek_id in (0x1C53BB6B, 0x114D9B74) and seek_position is not None:
                target = segment_start + seek_position
                if total and target >= total:
                    raise ValueError('Seek target outside file')
                if seek_id == 0x1C53BB6B:
                    return target, links
                links.append(target)
        pos = end
    return None, links


def _mkv_index_info(data: bytes, total: int, read_at=None) -> Optional[dict]:
    try:
        kind, _start, off = _ebml_element(data, 0)
        if kind != 0x1A45DFA3 or off is None:
            raise ValueError('invalid EBML header')
        kind, segment_start, _end = _ebml_element(data, off)
        if kind != 0x18538067:
            raise ValueError('missing Segment')
        off = segment_start
        links = collections.deque()
        visited = set()
        complete = False
        while True:
            if total and off == total:
                complete = True
                break
            try:
                kind, start, end = _ebml_element(data, off)
            except EOFError:
                break
            if kind == 0x1C53BB6B:  # Inline Cues still need their complete body.
                return {'safe': False, 'start': off}
            if kind == 0x1F43B675:  # Follow known links past the first Cluster.
                complete = True
                break
            if end is None:
                raise ValueError('unknown-sized header element')
            if end > len(data):
                break
            if kind == 0x114D9B74:  # SeekHead
                visited.add(off)
                cues, more = _mkv_seek_entries(data[start:end], segment_start, total)
                if cues is not None:
                    return {'safe': False, 'start': cues}
                links.extend(more)
            off = end
        header_bytes = min(len(data), off + 12) if complete else 0
        pending = []
        remaining = GROWING_MKV_PROBE_BYTES
        while links:
            off = links.popleft()
            if off in visited:
                continue
            visited.add(off)
            header = data[off:off + 12] if off + 12 <= len(data) else (
                read_at(off, 12) if read_at is not None else data[off:off + 12])
            try:
                kind, start, end = _ebml_element(header, 0)
            except EOFError:
                pending.append(off)
                continue
            if kind != 0x114D9B74 or end is None:
                raise ValueError('invalid linked SeekHead')
            if end - start > remaining:
                pending.append(off)
                continue
            remaining -= end - start
            body = data[off + start:off + end] if off + end <= len(data) else (
                read_at(off + start, end - start) if read_at is not None else b'')
            if len(body) != end - start:
                pending.append(off)
                continue
            cues, more = _mkv_seek_entries(body, segment_start, total)
            if cues is not None:
                return {'safe': False, 'start': cues}
            links.extend(more)
        if pending:
            # A known link is not proof that the container has no Cues. A
            # linked SeekHead must arrive before growing playback is safe.
            return {'safe': False, 'start': min(pending), 'seekhead': True,
                    'header_bytes': header_bytes}
        return {'safe': True} if complete else None
    except EOFError:
        return None
    except ValueError:
        return {'safe': True}  # Preserve the MKV fallback for unparseable headers.


def _container_index_info(job: dict) -> Optional[dict]:
    info = job.get('_container_index')
    if info is not None and not info.get('seekhead'):
        return info
    ext = Path(str(job.get('path') or '')).suffix.lower()
    mkv = ext in ('.mkv', '.webm')
    if not mkv and ext not in ('.mp4', '.m4v', '.mov'):
        return {'safe': ext in ('.ts', '.m2ts')}
    limit = GROWING_MKV_PROBE_BYTES if mkv else GROWING_MP4_PROBE_BYTES
    contiguous = int(job.get('contiguous') or 0)
    total = int(job.get('total') or 0)
    path = growing_target(job)
    if path is None:
        return None
    try:
        with open(path, 'rb') as f:
            amount = min(contiguous, limit)
            if info is not None and info.get('header_bytes'):
                # Revisit the linked heads without rereading media in the
                # rest of the bounded prefix on every readiness poll.
                amount = min(amount, info['header_bytes'])
            data = f.read(amount)
            if mkv:
                ranges = growing_ranges(job)

                def read_at(offset, amount):
                    for start, end in ranges:
                        if start <= offset < end:
                            f.seek(offset)
                            return f.read(min(amount, end - offset))
                    return b''

                info = _mkv_index_info(data, total, read_at)
            else:
                info = _mp4_index_info(data, total)
    except OSError:
        return None
    if info is None and (len(data) >= limit or (total and len(data) >= total)):
        info = {'safe': mkv}
    # Probes read different range snapshots concurrently. Once one resolves
    # the index, an older unresolved SeekHead result must never replace it.
    # This lock covers publication only, never disk reads or copy writers.
    with job.setdefault('_container_index_lock', threading.Lock()):
        current = job.get('_container_index')
        if current is not None and not current.get('seekhead'):
            return current
        if info is not None:
            job['_container_index'] = info
    return info


def _mkv_cues_complete(path: Path, start: int, contiguous: int, total: int) -> bool:
    if start >= contiguous:
        return False
    try:
        with open(path, 'rb') as f:
            f.seek(start)
            data = f.read(min(12, contiguous - start))
        kind, _start, end = _ebml_element(data, 0)
        return (kind == 0x1C53BB6B and end is not None
                and start + end <= contiguous and (not total or start + end <= total))
    except (OSError, EOFError, ValueError):
        return False


def _mp4_tail_ready(path: Path, start: int, total: int) -> bool:
    """Inspect trailing box headers only, after their entire region is written."""
    try:
        with open(path, 'rb') as f:
            off = start
            while off + 8 <= total:
                f.seek(off)
                data = f.read(min(16, total - off))
                kind, end = _mp4_box(data, 0, total - off)
                if kind == b'moov':
                    return True
                off += end
    except (OSError, EOFError, ValueError):
        pass
    return False


def progressive_ready(job: dict) -> bool:
    """Whether the prefix and any required index are safe for growing playback."""
    if job.get('state') == 'ready':
        return True
    if job.get('state') != 'downloading':
        return False
    contiguous = int(job.get('contiguous') or 0)
    if contiguous < GROWING_MIN_BYTES:
        return False
    if job.get('_progressive_ready'):
        return True
    if job.get('_progressive_unsafe'):
        return False
    info = _container_index_info(job)
    if info is None:
        return False
    safe = info['safe']
    start = int(info.get('start') or 0)
    if start:
        ext = Path(str(job.get('path') or '')).suffix.lower()
        total = int(job.get('total') or 0)
        if info.get('seekhead'):
            safe = False
        elif ext in ('.mkv', '.webm'):
            # A local seek can fetch a bounded trailing index after the TV
            # releases Seedr; the main copy keeps its connection throughout.
            safe = total > 0 and (growing_available(job, start) >= total
                                 or (job.get('range_supported') and
                                     0 < total - start <= GROWING_INDEX_MAX_BYTES))
            if not safe:
                path = growing_target(job)
                safe = path is not None and _mkv_cues_complete(path, start, contiguous, total)
        elif total > 0 and growing_available(job, start) >= total:
            path = growing_target(job)
            safe = path is not None and _mp4_tail_ready(path, start, total)
    if safe:
        job['_progressive_ready'] = True
    elif safe is False and not start:
        # Only latch a conclusive result, even when the configured growing
        # minimum is smaller than the bounded MP4 probe.
        job['_progressive_unsafe'] = True
    return bool(safe)


def job_for_rel(rel: str) -> Optional[dict]:
    """Return the newest job for a cache-relative path."""
    candidates = [j for j in list(_JOBS.values()) if _norm_rel(j.get('rel')) == _norm_rel(rel)]
    if not candidates:
        return None
    candidates.sort(key=lambda j: j.get('created_at', 0), reverse=True)
    return candidates[0]


def growing_target(job: dict) -> Optional[Path]:
    """Current readable path: part while active, final once ready."""
    dest = Path(str(job.get('path') or ''))
    part = dest.parent / (dest.name + '.part')
    # Rename may finish before the worker publishes state='ready'.
    if part.is_file():
        return part
    return dest if dest.is_file() else None


# Readers (status polls, growing requests) must not stall behind a writer
# that holds _io_lock through a slow disk write. Lock-free reads of the
# monotonic counters can only under-report a range for one call, never
# expose bytes that are not on disk.
_READER_LOCK_WAIT_S = 0.25


def _published_ranges(job: dict) -> list:
    head_end = int(job.get('_head_end') or job.get('contiguous') or 0)
    split = int(job.get('_split') or 0)
    tail_end = int(job.get('_tail_end') or split)
    index_start, index_end = job.get('_index_range') or (0, 0)
    ranges = [[0, head_end], [split, tail_end], [index_start, index_end]]
    merged = []
    for start, end in sorted(ranges):
        if end <= start:
            continue
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged


def growing_ranges(job: dict) -> list:
    """Sorted, merged byte intervals actually published by the writers.

    Never waits for the writers: with two copy lanes the lock is nearly
    always held, and a 0.25 s wait per call capped growing reads at about
    0.5 MB/s (below a 4K stream). The lock-free read can only under-report.
    """
    lock = job.get('_io_lock')
    locked = bool(lock) and lock.acquire(blocking=False)
    try:
        if job.get('state') == 'ready':
            total = int(job.get('total') or job.get('received') or 0)
            return [[0, total]] if total > 0 else []
        if job.get('state') != 'downloading':
            return []
        return _published_ranges(job)
    finally:
        if locked:
            lock.release()


def growing_available(job: dict, offset: int) -> int:
    """Exclusive readable end for offset, from the same intervals as status."""
    for start, end in growing_ranges(job):
        if start <= offset < end:
            return end
    return offset


def bytes_per_sec(job: dict) -> float:
    """Aggregate bytes written in a rolling 2.5 second window, including idle."""
    lock = job.get('_io_lock')
    locked = bool(lock) and lock.acquire(timeout=_READER_LOCK_WAIT_S)
    try:
        if job.get('state') != 'downloading' or not job.get('_rate_samples'):
            return 0.0
        now = time.monotonic()
        # Snapshot instead of trimming: without the lock a writer may be
        # appending, and iterating a deque while it changes raises.
        samples = list(job['_rate_samples'])
        recent = sum(n for t, n in samples if t >= now - RATE_WINDOW_SECONDS)
        elapsed = min(RATE_WINDOW_SECONDS, now - job['_rate_started'])
        return recent / elapsed if elapsed > 0 else 0.0
    finally:
        if locked:
            lock.release()


def _read_some(response, want: int) -> bytes:
    """Up to ``want`` bytes: a full chunk when fast, partial when slow.

    ``read(n)`` blocks until n bytes arrive, so at 100 KiB/s a 4 MiB chunk
    would publish nothing to growing readers for ~40 s. ``read1`` returns
    what is buffered; coalesce it so fast links still write large chunks.
    """
    read1 = getattr(response, 'read1', None)
    if read1 is None:
        return response.read(want)
    buf = bytearray()
    deadline = time.monotonic() + PUBLISH_INTERVAL_SECONDS
    while len(buf) < want:
        part = read1(want - len(buf))
        if not part:
            break
        buf += part
        if time.monotonic() >= deadline:
            break
    return bytes(buf)


def _finalize_part(part: Path, dest: Path) -> None:
    """Retry Windows reader sharing violations; POSIX keeps its single rename."""
    deadline = time.monotonic() + FINALIZE_RETRY_SECONDS
    while True:
        try:
            part.replace(dest)
            return
        except PermissionError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(FINALIZE_RETRY_SLEEP)


def _completion_path(dest: Path) -> Path:
    return dest.with_name('.' + dest.name + '.complete.json')


def _generation_path(dest: Path) -> Path:
    return dest.with_name('.' + dest.name + '.generation')


def _clear_part_metadata(dest: Path, *, strict: bool = False) -> None:
    for path in (_completion_path(dest), _generation_path(dest)):
        if strict:
            path.unlink(missing_ok=True)
        else:
            _unlink_quiet(path)


def _begin_part_generation(dest: Path) -> None:
    # A crash after rename may leave completion metadata behind. Invalidate it
    # BEFORE opening/truncating a new part, and fail closed if removal fails.
    _clear_part_metadata(dest, strict=True)
    with _generation_path(dest).open('x', encoding='ascii') as out:
        out.write(os.urandom(16).hex())
        out.flush()
        os.fsync(out.fileno())


def _part_signature(part: Path) -> dict:
    st = part.stat()
    return {'device': st.st_dev, 'inode': st.st_ino,
            'mtime_ns': st.st_mtime_ns, 'ctime_ns': st.st_ctime_ns}


def _completed_part(dest: Path) -> Optional[dict]:
    """Recover only the exact file generation recorded as complete.

    Length alone cannot prove completion: a sparse tail has its full logical
    length even while the middle is missing. Legacy size-only markers cannot
    safely establish completion and are deliberately not trusted.
    """
    try:
        marker = json.loads(_completion_path(dest).read_text(encoding='utf-8'))
        generation = _generation_path(dest).read_text(encoding='ascii')
        part = dest.with_name(dest.name + '.part')
        size = int(marker['size'])
        if (len(generation) == 32 and marker['generation'] == generation
                and marker['part_signature'] == _part_signature(part)
                and size >= 0 and part.stat().st_size == size):
            return marker
    except (OSError, ValueError, TypeError, KeyError):
        pass
    return None


def _record_complete_part(dest: Path, job: dict) -> None:
    marker = _completion_path(dest)
    tmp = marker.with_name(marker.name + '.tmp')
    part = dest.with_name(dest.name + '.part')
    data = {'size': part.stat().st_size,
            'generation': _generation_path(dest).read_text(encoding='ascii'),
            'part_signature': _part_signature(part),
            'name': job.get('name'), 'file_id': job.get('file_id')}
    with tmp.open('w', encoding='utf-8') as out:
        json.dump(data, out)
        out.flush()
        os.fsync(out.fileno())
    tmp.replace(marker)


def _promote_completed_part(dest: Path) -> bool:
    marker = _completed_part(dest)
    if marker is None:
        return False
    # Never overwrite a newer finished entry during orphan recovery.
    if dest.exists():
        raise FileExistsError('completed cache destination already exists')
    _finalize_part(dest.with_name(dest.name + '.part'), dest)
    _clear_part_metadata(dest)
    record_name(str(dest.relative_to(CACHE_ROOT)), marker.get('name'), marker.get('file_id'))
    listing_invalidate()
    return True


def accelerate(job_id: str) -> dict:
    """Permit the second origin range after local playback is confirmed."""
    job = _JOBS.get(str(job_id))
    if not job:
        return {'ok': False, 'status': 404, 'error': 'unknown cache job'}
    if job.get('state') == 'ready':
        return {'ok': True, 'state': 'ready', 'accelerated': False}
    if job.get('state') != 'downloading':
        return {'ok': False, 'status': 409, 'error': 'cache job is not downloading'}
    if not job.get('range_supported'):
        return {'ok': True, 'state': job.get('state'), 'accelerated': False,
                'reason': 'origin does not support validated byte ranges'}
    if not progressive_ready(job):
        return {'ok': False, 'status': 409, 'error': 'growing stream is not ready'}
    lock = job.get('_io_lock')
    if lock:
        with lock:
            job['_accelerate'] = True
    else:
        job['_accelerate'] = True
    return {'ok': True, 'state': job.get('state'), 'accelerated': True}


def cache_download(job_id: str) -> None:
    """Download atomically while exposing a safe, contiguous growing prefix.

    A known-size origin keeps one validated full-file Range open. A growing
    read can request a small trailing index on a second connection once the
    TV leaves Seedr. After local playback is confirmed, :func:`accelerate`
    permits a tail connection, waiting for any index lane to finish first.
    Range-less origins retain the single sequential connection path.
    """
    global _active_job_id
    _mark_cache_activity()
    job = _JOBS.get(job_id)
    if job is None:
        return
    dest = Path(job['path'])
    part = dest.parent / (dest.name + '.part')
    direct_session = None
    complete_part = False
    try:
        if _completed_part(dest) is not None:
            complete_part = True
            _promote_completed_part(dest)
            size = dest.stat().st_size
            job.update(state='ready', received=size, total=size, contiguous=size, error=None)
            return
        if direct_http is not None and direct_http.enabled():
            # Fail closed: an enabled direct route that cannot be established
            # must never silently fetch through an unverified default route.
            direct_session = direct_http.DirectHttpSession.from_env()
            job['_direct_http_session'] = direct_session
        job['state'] = 'downloading'
        dest.parent.mkdir(parents=True, exist_ok=True)

        # Seedr's folder listing already supplies the exact file byte count;
        # trust that first so starting the copy does not pay a redundant HEAD.
        # Older/other clients that omit it retain the original remote probe.
        expected = int(job.get('total') or 0)
        if expected <= 0:
            expected = _probe_remote_size(job)
        _preflight_download(job, expected)

        io_lock = threading.Lock()
        stop_event = threading.Event()
        for key in ('_progressive_ready', '_progressive_unsafe', '_container_index'):
            job.pop(key, None)
        job.update({
            '_io_lock': io_lock, '_stop_event': stop_event,
            '_accelerate': False, '_accelerated': False,
            '_head_end': 0, '_tail_end': 0, '_split': 0,
            '_index_range': (0, 0), '_index_wanted': False, '_index_active': False,
            'received': 0, 'contiguous': 0, 'range_supported': False,
            '_rate_started': time.monotonic(), '_rate_samples': collections.deque(),
        })
        tail_thread = None
        tail_error = []
        index_thread = None
        index_response = None

        # A single unbuffered descriptor is shared by the copy lanes. The lock
        # makes each seek+write atomic and avoids a second Windows writer
        # handle, which could otherwise make the final rename fail.
        _begin_part_generation(dest)
        with open(part, 'w+b', buffering=0) as out:
            def write_chunk(offset: int, chunk: bytes, lane: str) -> int:
                if job.get('_cancel') or stop_event.is_set():
                    raise RuntimeError('cancelled')
                clen = len(chunk)
                with io_lock, CACHE_LOCK:
                    end_offset = offset + clen
                    overlap = sum(max(0, min(end_offset, b) - max(offset, a))
                                  for a, b in _published_ranges(job))
                    projected = int(job.get('received') or 0) + clen - overlap
                    # Check every hard bound against the complete projected
                    # write while both workers share this lock.
                    if (_free_bytes() - clen) < FREE_FLOOR_BYTES:
                        raise RuntimeError('free disk floor breached mid-download')
                    if (_capacity_usage(exclude=dest) + max(expected, projected)) > HARD_CAP_BYTES:
                        raise RuntimeError('cache full (mid-download)')
                    if expected and projected > expected * OVERSHOOT_FACTOR:
                        raise RuntimeError('download exceeded expected size (overshoot guard)')
                    out.seek(offset)
                    out.write(chunk)
                    if lane == 'head':
                        job['_head_end'] = max(int(job.get('_head_end') or 0), end_offset)
                    elif lane == 'index':
                        # Publish the pair atomically for lock-free readers.
                        start, end = job['_index_range']
                        job['_index_range'] = (start, max(end, end_offset))
                    else:
                        job['_tail_end'] = max(int(job.get('_tail_end') or 0), end_offset)
                    job['received'] = projected
                    now = time.monotonic()
                    samples = job['_rate_samples']
                    samples.append((now, clen))
                    while samples and samples[0][0] < now - RATE_WINDOW_SECONDS:
                        samples.popleft()
                    ranges = _published_ranges(job)
                    job['contiguous'] = ranges[0][1] if ranges and ranges[0][0] == 0 else 0
                _mark_cache_activity()
                return end_offset

            def consume(response, start: int, end: Optional[int], lane: str) -> int:
                offset = start
                while end is None or offset <= end:
                    if job.get('_cancel') or stop_event.is_set():
                        raise RuntimeError('cancelled')
                    want = CHUNK_BYTES if end is None else min(CHUNK_BYTES, end + 1 - offset)
                    chunk = _read_some(response, want)
                    if not chunk:
                        break
                    if end is not None and offset + len(chunk) > end + 1:
                        raise RuntimeError('origin exceeded requested byte range')
                    offset = write_chunk(offset, chunk, lane)
                    # Only the primary worker assigns the second connection.
                    if lane == 'head':
                        maybe_start_index()
                        maybe_start_tail(offset)
                        if tail_thread is not None:
                            end = int(job['_split']) - 1
                if end is not None and offset != end + 1:
                    raise RuntimeError('origin ended before requested byte range completed')
                return offset

            def run_index(start: int) -> None:
                nonlocal index_response
                try:
                    # The TV's old Seedr socket may take a moment to close.
                    # Keep opens short enough to fit its handoff watchdog.
                    for attempt in range(8):
                        try:
                            index_response = _open_download(job, start, expected - 1,
                                                            attempts=1, timeout=1.0)
                            break
                        except Exception as e:
                            if not _recoverable_lane_error(e) or attempt == 7:
                                raise
                            if stop_event.wait(0.5):
                                raise RuntimeError('cancelled')
                    with index_response as response:
                        if not _validated_content_range(response, start, expected - 1, expected):
                            raise RuntimeError('origin returned an invalid index Content-Range')
                        consume(response, start, expected - 1, 'index')
                except Exception:
                    # The main response never depends on this optional lane.
                    # Keep partial bytes; a later growing read can retry them.
                    pass
                finally:
                    index_response = None
                    job['_index_wanted'] = False
                    job['_index_active'] = False

            def maybe_start_index() -> None:
                nonlocal index_thread
                if (not job.get('_index_wanted') or not job.get('range_supported')
                        or tail_thread is not None
                        or (index_thread is not None and index_thread.is_alive())):
                    return
                job['_index_wanted'] = False
                info = _container_index_info(job)
                start = int((info or {}).get('start') or 0)
                if (not start or info.get('seekhead')
                        or not 0 < expected - start <= GROWING_INDEX_MAX_BYTES):
                    return
                with io_lock:
                    have_end = growing_available(job, start)
                    if have_end >= expected:
                        return
                    job['_index_range'] = (start, have_end)
                job['_index_active'] = True
                index_thread = threading.Thread(target=run_index, args=(have_end,), daemon=True,
                                                name='cache-index-range')
                index_thread.start()

            def run_tail(start: int) -> None:
                end = expected - 1
                try:
                    response = _open_download(job, start, end)
                    if not _validated_content_range(response, start, end, expected):
                        response.close()
                        raise RuntimeError('origin returned an invalid tail Content-Range')
                    with response:
                        consume(response, start, end, 'tail')
                except Exception as e:
                    tail_error.append(e)
                    # A refused or dropped second connection must not abort the
                    # main lane. Origins may throttle parallel requests; the
                    # main lane finishes these bytes afterwards.
                    if not _recoverable_lane_error(e):
                        stop_event.set()

            def maybe_start_tail(offset: int) -> None:
                nonlocal tail_thread
                if (tail_thread is not None or not job.get('_accelerate')
                        or not job.get('range_supported')
                        or (index_thread is not None and index_thread.is_alive())):
                    return
                with io_lock:
                    if tail_thread is not None:
                        return
                    start = int(job['_split'])
                    if offset >= start:
                        # The prefix now includes the sequential tail already
                        # written. Divide ONLY the unread remainder; cap the
                        # existing response's reads at the new boundary.
                        remaining = expected - offset
                        if remaining < CHUNK_BYTES * 2:
                            return
                        start = offset + (remaining // 2 // CHUNK_BYTES) * CHUNK_BYTES
                        job['_head_end'] = offset
                        job['_split'] = start
                        job['_tail_end'] = start
                        job['contiguous'] = max(int(job.get('contiguous') or 0), offset)
                    job['_accelerated'] = True
                    tail_thread = threading.Thread(target=run_tail, args=(start,), daemon=True,
                                                   name='cache-tail-range')
                    tail_thread.start()

            ranged = bool(expected and expected >= CHUNK_BYTES * 4)
            split = 0
            if ranged:
                split = max(CHUNK_BYTES,
                            (expected // 2 // CHUNK_BYTES) * CHUNK_BYTES)
                split = min(split, expected - CHUNK_BYTES)
                job['_split'] = split
                job['_tail_end'] = split
                first = _open_download(job, 0, expected - 1)
                if _validated_content_range(first, 0, expected - 1, expected):
                    job['range_supported'] = True
                elif getattr(first, 'status', first.getcode()) == 200:
                    # Range ignored: this response already is the full body,
                    # so keep it and preserve the one-connection fallback.
                    ranged = False
                    split = 0
                    job['_split'] = 0
                    job['_tail_end'] = 0
                else:
                    first.close()
                    raise RuntimeError('origin returned an invalid head Content-Range')
            else:
                first = _open_download(job)

            if not expected:
                try:
                    expected = int(first.headers.get('Content-Length') or 0)
                except (TypeError, ValueError):
                    expected = 0
                try:
                    _preflight_download(job, expected)
                except Exception:
                    first.close()
                    raise

            try:
                with first:
                    consume(first, 0, expected - 1 if ranged else None, 'head')
                if ranged:
                    if tail_thread is not None:
                        while tail_thread.is_alive():
                            tail_thread.join(0.25)
                            if job.get('_cancel'):
                                stop_event.set()
                        if tail_error:
                            if job.get('_cancel') or stop_event.is_set():
                                raise tail_error[0]
                            # Finish what the failed tail lane did not write
                            # with a replacement connection.
                            resume_at = int(job.get('_tail_end') or job.get('_split') or 0)
                            if resume_at < expected:
                                response = _open_download(job, resume_at, expected - 1)
                                if not _validated_content_range(response, resume_at, expected - 1, expected):
                                    response.close()
                                    raise RuntimeError('origin returned an invalid tail Content-Range')
                                with response:
                                    consume(response, resume_at, expected - 1, 'tail')
            except Exception:
                stop_event.set()
                if tail_thread is not None and tail_thread.is_alive():
                    tail_thread.join(35)
                raise
            finally:
                stop_event.set()
                if index_thread is not None:
                    if index_response is not None:
                        _abort_response(index_response)
                    index_thread.join()

        if expected:
            if int(job.get('received') or 0) != expected:
                raise RuntimeError('download received byte count did not match expected size')
            if int(job.get('contiguous') or 0) != expected:
                raise RuntimeError('download byte count did not match expected size')
            if part.stat().st_size != expected:
                raise RuntimeError('download file size did not match expected size')

        # POST-FLIGHT: atomic rename, same filesystem.
        _record_complete_part(dest, job)
        complete_part = True
        _finalize_part(part, dest)
        _clear_part_metadata(dest)
        try:
            st = dest.stat()
            job['received'] = st.st_size
            job['total'] = st.st_size
        except OSError:
            pass
        job['state'] = 'ready'
        # Drift-correction pass -- cap-only (no incoming need_bytes now).
        cache_evict(protect_rel=_protect_rel())
        # The file just became a finished cache entry, but the LISTING index
        # (.listing.json, served by /cache/list AND consulted by remux.py's
        # _resolve_cached_copy() fast path) doesn't know that yet: the ONLY
        # earlier invalidation trigger was record_name() at the top of
        # reserve() -- called BEFORE this download even started, while the
        # rel was still just a '.part' -- and record_name() only invalidates
        # when the display name is NEW, which it normally isn't on a repeat
        # fetch. Without this, a freshly-finished file stayed invisible to
        # both /cache/list and the fast-path cache lookup until some
        # UNRELATED event (an eviction, a subtitle manifest write) happened
        # to rebuild the index. This is what makes "fresh files resolve"
        # true for indexed lookups immediately after publication.
        listing_invalidate()
        # No unconditional ffprobe here. A growing-cache handoff is already
        # playing these bytes; normal playback probes lazily only when codec
        # compatibility actually requires it.
        # Kick off background trick-play thumbnail generation (streaming-style
        # paused/scrubbing seek-bar previews) for the file that just landed.
        # Same "cheap enough to do once per successful cache" reasoning as
        # the probe warm-up just above -- NOT a repeat of the reverted
        # maybe_generate_sub() mistake below (an unconditional ~15-minute
        # Whisper pass on every file): this is ONE CPU-bounded, low-priority
        # ffmpeg pass, single-flight process-wide (see queue_thumbs()),
        # queued here so generation is already warm/in-progress by the time
        # a viewer first pauses or scrubs instead of starting cold on that
        # first request (queue_thumbs() is also the lazy-backfill trigger
        # for anything cached before this existed -- see GET /cache/thumbs).
        try:
            queue_thumbs(job['rel'])
        except Exception:
            pass
        # The file just became a finished cache entry -- kick off background
        # Whisper subtitle generation (single-flight, bounded concurrency,
        # never blocks this thread; see maybe_generate_sub()). Never let a
        # subgen hiccup turn an otherwise-successful download into an error.
        try:
            maybe_generate_sub(job['rel'])
        except Exception:
            pass
    except Exception as e:
        cancelled = bool(job.get('_cancel')) or str(e) == 'cancelled'
        job['state'] = 'aborted' if cancelled else 'error'
        job['error'] = 'cancelled' if cancelled else str(e)
        # Preserve complete bytes for recovery if Windows keeps rejecting
        # the rename beyond the bounded retry window.
        if not complete_part:
            _unlink_quiet(part)
            _clear_part_metadata(dest)
    finally:
        job.pop('_direct_http_session', None)
        if direct_session is not None:
            direct_session.close()
        with CACHE_LOCK:
            if _active_job_id == job_id:
                _active_job_id = None


# ===========================================================================
# Startup + periodic sweep
# ===========================================================================

def cleanup_orphan_parts() -> None:
    """Promote durably completed downloads; discard incomplete orphan parts."""
    if not CACHE_ROOT.exists():
        return
    for part in CACHE_ROOT.rglob('*.part'):
        dest = part.with_name(part.name[:-5])
        if _completed_part(dest) is not None:
            try:
                _promote_completed_part(dest)
            except OSError:
                pass  # Keep the complete bytes and marker for the next attempt.
        else:
            _unlink_quiet(part)
            _clear_part_metadata(dest)


def _sweep_subs_once() -> None:
    """Drop any CACHE_ROOT/.subs/<rel> directory whose <rel> no longer
    resolves to a real media file in cache_files() -- covers a media file
    that disappeared some way OTHER than cache_evict()/_cleanup_sub_sidecars()
    (e.g. a manual rm on disk). Stray '*.part' files under .subs/ are
    already purged by _sweep_once()'s existing generic CACHE_ROOT-wide
    '*.part' pass below (and cleanup_orphan_parts() at startup) -- neither
    of those is dot-prefix-aware, unlike cache_files(), so they already
    reach into .subs/ on their own."""
    subs_root = CACHE_ROOT / _SUBS_ROOT_NAME
    if not subs_root.exists():
        return
    valid = {str(p.relative_to(CACHE_ROOT)) for p, _s, _m in cache_files()}
    try:
        children = list(subs_root.iterdir())
    except OSError:
        return
    for child in children:
        try:
            if not child.is_dir():
                continue
        except OSError:
            continue
        if child.name not in valid:
            shutil.rmtree(child, ignore_errors=True)


def _sweep_once() -> None:
    if not CACHE_ROOT.exists():
        return
    cache_evict(protect_rel=_protect_rel())
    # Drop display-name entries whose file was evicted, so the index doesn't
    # grow unbounded.
    try:
        prune_names([str(p.relative_to(CACHE_ROOT)) for p, _s, _m in cache_files()])
    except Exception:
        pass
    try:
        _sweep_subs_once()
    except Exception:
        pass
    now = time.time()
    with CACHE_LOCK:
        active = {Path(j['path']) for j in _JOBS.values()
                  if j.get('state') in _JOB_ACTIVE_STATES and j.get('path')}
        for p in CACHE_ROOT.rglob('*.part'):
            dest = p.with_name(p.name[:-5])
            if dest in active:
                continue
            try:
                if _completed_part(dest) is not None:
                    _promote_completed_part(dest)
                elif now - p.stat().st_mtime > PART_MAX_AGE_S:
                    _unlink_quiet(p)
            except OSError:
                pass


def start_sweep_thread() -> threading.Thread:
    """Daemon thread, every SWEEP_INTERVAL_S: re-walks CACHE_ROOT for real
    sizes, re-enforces cap+floor (protecting the active session's file), and
    deletes any '*.part' older than PART_MAX_AGE_S -- belt-and-suspenders
    against a missed abort path or clock skew, independent of any restart."""
    def _loop():
        while True:
            time.sleep(SWEEP_INTERVAL_S)
            try:
                if SWEEP_IDLE_SKIP_S and _cache_idle_for() >= SWEEP_IDLE_SKIP_S:
                    continue
                _sweep_once()
            except Exception:
                pass
    t = threading.Thread(target=_loop, daemon=True, name='cache-sweep')
    t.start()
    return t


# ===========================================================================
# Subtitle SYNC engine -- persistent, content-fingerprinted "baked
# subtitle" store (R2: sync ONCE, store FOREVER).
#
# A prior architecture called maybe_generate_sub() from cache_download()'s
# success path and reserve()'s already-cached fast path below (plus
# torrent.py's _import_videos()) to transcribe the WHOLE audio track with
# Whisper the moment a video finished caching -- ~15 minutes of full-file
# transcription per episode, spent unconditionally on every import whether
# or not the user ever needed synced subs for that file. maybe_generate_sub()
# is kept below as a no-op so its old call sites (cache_download(), reserve(),
# torrent.py) don't need touching -- this whole section replaces it with an
# on-demand, measure-at-most-once-ever engine instead:
#
#   CACHE_ROOT/.subs/<rel>/manifest.json    -- one entry per content
#                                               fingerprint ever tried for
#                                               this media file
#   CACHE_ROOT/.subs/<rel>/<fp>.srt         -- baked, servable at offset 0
#   CACHE_ROOT/.subs/<rel>/<fp>.orig.srt    -- preserved pre-bake original
#
# subs_start_sync() is the single entry point (POST /subgen, repurposed):
# without `srt` it kicks off R3's embedded-track extraction/lazy-verify
# (measured at most once per rel EVER, gated by manifest.embedded_checked);
# with `srt` it kicks off R4/R5's external-candidate align+bake flow
# (measured at most once per (rel, fp) EVER). Both run in a low-priority
# background daemon thread and are single-flighted per rel via _SYNC_JOBS;
# callers poll subs_state()/subs_baked_target() for the result. Both reuse
# subsync.measure_offset_progressive(), itself a thin wrapper over the
# existing _whisper_multi_offset -- no new sync algorithm, only new storage
# + scheduling around the one that already exists.
# ===========================================================================

_MANIFEST_META_LOCK = threading.Lock()
_MANIFEST_LOCKS: dict = {}          # rel -> threading.Lock, get-or-create


def _manifest_lock(rel: str) -> threading.Lock:
    rel = _norm_rel(rel)
    with _MANIFEST_META_LOCK:
        lk = _MANIFEST_LOCKS.get(rel)
        if lk is None:
            lk = threading.Lock()
            _MANIFEST_LOCKS[rel] = lk
        return lk


def _manifest_path(rel: str) -> Optional[Path]:
    try:
        return _subs_dir(rel) / 'manifest.json'
    except PermissionError:
        return None


def _empty_manifest(rel: str) -> dict:
    return {'rel': rel, 'active_fp': None, 'embedded_checked': False,
            'embedded_found': False, 'entries': {}}


def _load_manifest(rel: str) -> dict:
    """Never raises -- a missing or corrupt manifest.json is just a fresh
    'nothing tried yet' skeleton."""
    p = _manifest_path(rel)
    if p is None or not p.is_file():
        return _empty_manifest(rel)
    try:
        with open(p, 'r', encoding='utf-8') as f:
            d = json.load(f)
        if not isinstance(d, dict) or not isinstance(d.get('entries'), dict):
            return _empty_manifest(rel)
        d.setdefault('rel', rel)
        d.setdefault('active_fp', None)
        d.setdefault('embedded_checked', False)
        d.setdefault('embedded_found', False)
        return d
    except Exception:
        return _empty_manifest(rel)


def _save_manifest(rel: str, manifest: dict) -> None:
    """Atomic write (.part + os.replace), matching every other atomic-write
    convention already in this module. Best-effort -- never raises."""
    p = _manifest_path(rel)
    if p is None:
        return
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name('manifest.json.part')
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(manifest, f)
        os.replace(tmp, p)
    except Exception:
        pass


def _mutate_manifest(rel: str, fn) -> dict:
    """Single choke point for every manifest read-modify-write: under this
    rel's lock, load, call fn(manifest) to mutate it in place, save,
    return it. Keeps two racing workers (an embedded job vs. an
    external-candidate job for the same rel, or a late duplicate request)
    from ever interleaving writes."""
    lk = _manifest_lock(rel)
    with lk:
        manifest = _load_manifest(rel)
        fn(manifest)
        _save_manifest(rel, manifest)
    # subs_ready/subs_url are part of the cached listing, so a manifest write
    # can change what /cache/list should report. Outside the lock: the rebuild
    # re-reads manifests itself.
    listing_invalidate()
    return manifest


def _rollup_entry(rel: str, manifest: dict):
    """(fp, entry, state) for GET /cache/subs(/state)'s no-fp ROLLUP: an
    active READY entry first, else an EMBEDDED_PENDING entry (R3's
    presumed-synced exemption -- servable even before verification), else
    an in-flight SYNCING job, else (None, None, 'none')."""
    entries = manifest.get('entries') or {}
    active_fp = manifest.get('active_fp')
    if active_fp and (entries.get(active_fp) or {}).get('state') == 'ready':
        return active_fp, entries[active_fp], 'ready'
    for fp, e in entries.items():
        if e.get('state') == 'embedded_pending':
            return fp, e, 'embedded_pending'
    with _SYNC_LOCK:
        job = _SYNC_JOBS.get(_norm_rel(rel))
    if job:
        fp = job.get('fp')
        return fp, entries.get(fp), 'syncing'
    return None, None, 'none'


# Per-rel single-flight for the background sync/extraction workers below --
# mirrors the existing _active_job_id pattern (one meta-lock + one dict),
# applied per-rel instead of process-wide since subtitle work for two
# DIFFERENT media files is fine running concurrently. RLock (not Lock):
# subs_start_sync() below calls _rollup_entry() -- which itself takes this
# same lock to peek at _SYNC_JOBS -- from INSIDE its own `with _SYNC_LOCK`
# critical section (it needs the manifest rollup, not just the raw job
# dict, to report 'embedded_pending' correctly even while the embedded
# job's lazy-verify phase is still running); a plain Lock would deadlock
# on that same-thread re-entry.
_SYNC_LOCK = threading.RLock()
_SYNC_JOBS: dict = {}                # rel -> {'fp': <hex or None>, 'thread': Thread}


def subs_ready(rel: str) -> bool:
    """True iff `rel`'s manifest ROLLUP state is 'ready' or
    'embedded_pending' -- i.e. GET /cache/subs has something servable
    right now (R3's presumed-synced exemption included)."""
    manifest = _load_manifest(rel)
    _fp, _e, state = _rollup_entry(rel, manifest)
    return state in ('ready', 'embedded_pending')


def subs_baked_target(rel: str, fp: Optional[str] = None) -> Optional[Path]:
    """Resolved Path to a baked <fp>.srt (the manifest ROLLUP's fp when
    `fp` is omitted), or None if there's nothing servable (caller maps
    that to 404)."""
    if not fp:
        manifest = _load_manifest(rel)
        fp, _e, state = _rollup_entry(rel, manifest)
        if not fp or state not in ('ready', 'embedded_pending'):
            return None
    try:
        d = _subs_dir(rel)
    except PermissionError:
        return None
    p = d / (fp + '.srt')
    return p if p.is_file() else None


def subs_target(rel: str) -> Optional[Path]:
    """Backward-compat alias for subs_baked_target(rel) (rollup fp) -- kept
    because it's part of this module's existing public surface; GET
    /cache/subs itself now calls subs_baked_target(rel, fp) directly so it
    can also serve an EXACT fp."""
    return subs_baked_target(rel)


def subs_url(rel: str, fp: Optional[str] = None) -> Optional[str]:
    """The /cache/subs URL for `rel` (optionally pinned to an exact `fp`),
    or None if subtitle sync is unavailable on this host (no subsync
    module) -- callers (server.py's /cache/list, /cache/status,
    subs_state()) only attach this field when it's non-None."""
    if subsync is None:
        return None
    url = '/cache/subs?rel=' + urllib.parse.quote(rel, safe='')
    if fp:
        url += '&fp=' + urllib.parse.quote(fp, safe='')
    return url


def subs_state(rel: str, fp: Optional[str] = None) -> dict:
    """GET /cache/subs/state logic. `fp` given -> that EXACT entry's raw
    state ({'state': 'none', 'fp': fp} if unknown). `fp` omitted -> the
    manifest ROLLUP (see _rollup_entry): ready > embedded_pending >
    syncing > none."""
    manifest = _load_manifest(rel)
    entries = manifest.get('entries') or {}
    if fp:
        e = entries.get(fp)
        if not e:
            return {'state': 'none', 'source': None, 'confidence': None,
                    'offset': None, 'scale': None, 'fp': fp, 'version': None,
                    'url': None}
        state = e.get('state', 'none')
        return {
            'state': state, 'source': e.get('source'), 'confidence': e.get('confidence'),
            'offset': e.get('offset'), 'scale': e.get('scale'), 'fp': fp,
            'version': e.get('version', 0),
            'url': subs_url(rel, fp) if state in ('ready', 'embedded_pending') else None,
        }
    rfp, e, state = _rollup_entry(rel, manifest)
    # An embedded-extraction job starts before it has a subtitle fingerprint
    # (job.fp/e are both None). _rollup_entry correctly reports that flight as
    # `syncing`; do not collapse it to `none` merely because no manifest entry
    # exists yet. The client must keep polling instead of launching a premature
    # external fallback against the still-running embedded probe.
    if state == 'syncing' and not e:
        return {'state': 'syncing', 'source': None, 'confidence': None,
                'offset': None, 'scale': None, 'fp': rfp, 'version': None,
                'url': None}
    if state == 'none' or not e:
        return {'state': 'none', 'source': None, 'confidence': None,
                'offset': None, 'scale': None, 'fp': None, 'version': None,
                'url': None}
    return {
        'state': state, 'source': e.get('source'), 'confidence': e.get('confidence'),
        'offset': e.get('offset'), 'scale': e.get('scale'), 'fp': rfp,
        'version': e.get('version', 0),
        'url': subs_url(rel, rfp) if state in ('ready', 'embedded_pending') else None,
    }


def maybe_generate_sub(rel: str) -> None:
    """NO-OP. A prior architecture called this from cache_download()'s
    success path and reserve()'s already-cached fast path (plus
    torrent.py's _import_videos()) to unconditionally transcribe the WHOLE
    audio track the moment a video finished caching -- exactly the
    wasteful auto-run this re-architecture removes. Subtitle work now only
    ever starts on-demand via subs_start_sync() (POST /subgen), driven by
    the app once it actually needs subs for a given play. Kept as a real
    (if empty) function rather than deleted so its existing call sites
    keep working unchanged -- they just no longer trigger anything."""
    return


def subs_start_sync(rel: str, srt: Optional[str] = None, name: Optional[str] = None) -> dict:
    """POST /subgen handler logic (repurposed contract; the legacy
    fast/wait/whole-file-generate contract is fully retired).

      srt omitted -> R3 embedded-extraction/verify flow. Single-flight +
                     measure-once-EVER via manifest.embedded_checked.
      srt given   -> R4/R5 external-candidate align+bake flow. Fingerprinted
                     by content (subsync.fingerprint_srt); measured at most
                     once EVER per (rel, fp) -- a 'ready' or already-running
                     'syncing'/'embedded_pending' entry short-circuits.

    Returns immediately: {'ok': True, 'state': ..., 'fp': ...} (or an
    {'error','status'} dict server.py maps to an HTTP code). The actual
    work runs in a background daemon thread; callers poll subs_state().
    Never raises."""
    if subsync is None:
        return {'error': 'subsync not available', 'status': 501}
    try:
        local = _safe_resolve(rel)
    except PermissionError:
        return {'error': 'bad rel', 'status': 400}
    if not local.is_file():
        return {'error': 'not cached', 'status': 404}

    rel = _norm_rel(rel)
    srt_text = srt if isinstance(srt, str) and srt.strip() else None

    with _SYNC_LOCK:
        job = _SYNC_JOBS.get(rel)
        if job and job.get('thread') and job['thread'].is_alive():
            manifest = _load_manifest(rel)
            cur_fp, _e, state = _rollup_entry(rel, manifest)
            return {'ok': True, 'state': state, 'fp': cur_fp}

        if srt_text is None:
            manifest = _load_manifest(rel)
            # A deferred extraction (file busy/slow) waits for its retry gate.
            if (manifest.get('embedded_checked')
                    or float(manifest.get('embedded_retry_after') or 0) > time.time()):
                cur_fp, _e, state = _rollup_entry(rel, manifest)
                return {'ok': True, 'state': state, 'fp': cur_fp}
            _SYNC_JOBS[rel] = {'fp': None, 'thread': None}
            t = threading.Thread(target=_run_embedded_job, args=(rel,), daemon=True,
                                  name=('subs-emb-%s' % rel)[:60])
            _SYNC_JOBS[rel]['thread'] = t
            t.start()
            return {'ok': True, 'state': 'syncing', 'fp': None}

        fp = subsync.fingerprint_srt(srt_text)
        manifest = _load_manifest(rel)
        entry = (manifest.get('entries') or {}).get(fp)
        if entry and entry.get('state') in ('ready', 'embedded_pending'):
            return {'ok': True, 'state': entry['state'], 'fp': fp}

        def _mk(m):
            e = m.setdefault('entries', {}).setdefault(fp, {})
            e['source'] = ('external:%s' % name) if name else 'external'
            e['state'] = 'syncing'
            e['attempts'] = int(e.get('attempts') or 0) + 1
            e.setdefault('created_at', time.time())
            e.setdefault('version', 0)
        _mutate_manifest(rel, _mk)

        _SYNC_JOBS[rel] = {'fp': fp, 'thread': None}
        t = threading.Thread(target=_run_sync_job, args=(rel, fp, srt_text, name), daemon=True,
                              name=('subs-ext-%s' % rel)[:60])
        _SYNC_JOBS[rel]['thread'] = t
        t.start()
        return {'ok': True, 'state': 'syncing', 'fp': fp}


def _bake_write(d: Path, fp: str, baked_text: str) -> bool:
    """Atomic write of the baked <fp>.srt (part + os.replace)."""
    try:
        d.mkdir(parents=True, exist_ok=True)
        part = d / (fp + '.srt.part')
        part.write_text(baked_text, encoding='utf-8')
        os.replace(str(part), str(d / (fp + '.srt')))
        return True
    except OSError as e:
        print('[cache] bake write failed: %s' % e)
        return False


def _run_embedded_job(rel: str) -> None:
    """Background worker for R3's embedded-track path. Runs the actual
    ffprobe/ffmpeg extraction AT MOST ONCE PER REL, EVER (embedded_checked
    short-circuits every future call, even across a service restart).
    Extracts + bakes at offset 0 immediately (servable the instant this
    reaches 'embedded_pending' -- the show-immediately moment), THEN
    lazily verifies with a couple of low-priority whisper windows and
    hot-corrects the baked file in place if it's off; an unreliable verify
    leaves the entry 'embedded_pending' FOREVER (single attempt, never
    demoted -- R3's presumed-synced exemption is refined, never revoked)."""
    try:
        manifest = _load_manifest(rel)
        if manifest.get('embedded_checked'):
            return
        try:
            local = _safe_resolve(rel)
        except PermissionError:
            return
        if not local.is_file():
            return

        try:
            tracks = subsync.probe_embedded_text_tracks(str(local))
        except Exception as e:
            print('[cache] embedded probe %s: %s' % (rel, e))
            tracks = []

        if not tracks:
            def _mk_none(m):
                m['embedded_checked'] = True
                m['embedded_found'] = False
            _mutate_manifest(rel, _mk_none)
            return

        try:
            d = _subs_dir(rel)
        except PermissionError:
            def _mk_bad(m):
                m['embedded_checked'] = True
                m['embedded_found'] = False
            _mutate_manifest(rel, _mk_bad)
            return
        d.mkdir(parents=True, exist_ok=True)

        # Walk the ranked candidates and take the first that actually looks
        # like FULL dialogue. Flags alone are not enough: a forced track that
        # admits it neither in disposition.forced nor in its title still
        # extracts to a handful of cues. For example, a one-cue forced
        # track is not full dialogue for a feature-length video even when
        # another track contains hundreds of cues. Validate the extraction
        # as well as the container's metadata before reporting success.
        #
        # A sub-threshold extraction is REJECTED outright rather than kept as
        # a fallback. Reporting embedded_found=False lets the client fall
        # through to its OpenSubtitles finder and get real subtitles; keeping
        # the 1-cue track would mark the rel 'embedded_pending' (i.e. served
        # and done) and that fallback would never run.
        text = ''
        deferred = None
        deferred_type = getattr(subsync, 'TextSubtitleExtractionDeferred', ())
        # Unknown language may still be English; explicit foreign tags must
        # leave the English fallback available. Filter BEFORE the attempt cap.
        tracks = [cand for cand in tracks
                  if str(cand.get('lang') or '').strip().lower()
                  in ('', 'und', 'unk', 'unknown', 'en', 'eng', 'english')
                  or str(cand.get('lang') or '').lower().startswith(('en-', 'en_'))]
        for cand in tracks[:4]:
            tmp_extract = d / ('_extract_%d.srt' % int(time.time() * 1000))
            ok = subsync.extract_text_subtitle(str(local), cand['index'], str(tmp_extract), gentle=True)
            if deferred_type and isinstance(ok, deferred_type):
                # File-wide and temporary (e.g. a timeout on a busy disk): not
                # proof the track is absent, so retry the whole probe later.
                _unlink_quiet(tmp_extract)
                deferred = ok
                break
            got = ''
            if ok and tmp_extract.is_file():
                try:
                    got = tmp_extract.read_text(encoding='utf-8', errors='replace')
                except OSError:
                    got = ''
            _unlink_quiet(tmp_extract)
            if not got.strip():
                continue
            cues = subsync.count_srt_cues(got)
            if cues >= _MIN_FULL_SUB_CUES:
                text = got
                print('[cache] embedded %s: track idx=%s (%s) %d cues'
                      % (rel, cand['index'], cand.get('title') or cand.get('lang'), cues))
                break
            print('[cache] embedded %s: track idx=%s only %d cues (forced?) — rejected'
                  % (rel, cand['index'], cues))

        if not text.strip():
            if deferred is not None:
                def _mk_later(m):
                    m['embedded_retry_after'] = float(deferred.retry_after)
                _mutate_manifest(rel, _mk_later)
                print('[cache] embedded %s: deferred (%s)' % (rel, deferred.reason))
                return
            def _mk_empty(m):
                m['embedded_checked'] = True
                m['embedded_found'] = False
                m.pop('embedded_retry_after', None)
            _mutate_manifest(rel, _mk_empty)
            return

        fp = subsync.fingerprint_srt(text)
        baked = subsync.bake_srt(text, 0.0, 1.0)
        try:
            (d / (fp + '.orig.srt')).write_text(text, encoding='utf-8')
        except OSError:
            pass
        if not _bake_write(d, fp, baked):
            def _mk_writefail(m):
                m['embedded_checked'] = True
                m['embedded_found'] = False
            _mutate_manifest(rel, _mk_writefail)
            return

        def _mk_pending(m):
            m['embedded_checked'] = True
            m['embedded_found'] = True
            m.pop('embedded_retry_after', None)
            m['active_fp'] = fp
            e = m.setdefault('entries', {}).setdefault(fp, {})
            e['source'] = 'embedded'
            e['state'] = 'embedded_pending'
            e['offset'] = 0.0
            e['scale'] = 1.0
            e['confidence'] = None
            e['pass'] = None
            e.setdefault('created_at', time.time())
            e['version'] = int(e.get('version') or 0) + 1
            e['attempts'] = int(e.get('attempts') or 0) + 1
        _mutate_manifest(rel, _mk_pending)

        # Subs are now servable ('embedded_pending'). Lazily verify in the
        # background with a couple of low-priority whisper windows.
        try:
            cues = subsync.srt_cues_text(text)
        except Exception:
            cues = []
        if not cues:
            return   # nothing to verify with -- stays embedded_pending forever

        try:
            # PRIMARY: ffsubsync (unbiased). This matters MOST here: an
            # embedded track is synced by construction; speech-recognition
            # timestamp bias can introduce a false offset into a synced track.
            result = None
            if subsync.ffsubsync_available():
                result = subsync.measure_offset_ffsubsync(str(local), text)
            if result is None and subsync.whisper_available():
                result = subsync.measure_offset_progressive(str(local), cues, fast_windows=2)
            if result is None and not subsync.whisper_available():
                # Whisper-less host: verify with the same silencedetect
                # correlation the live /subsync endpoint falls back to,
                # instead of never verifying at all.
                result = subsync.measure_offset_silencedetect(str(local), text)
        except Exception as e:
            print('[cache] embedded verify %s: %s' % (rel, e))
            result = None

        if not result or not result.get('reliable'):
            return   # unreliable -- stays embedded_pending forever (R5: single attempt)

        offset = float(result.get('offset') or 0.0)
        scale = float(result.get('scale') or 1.0)
        meaningfully_off = abs(offset) > 0.7 or abs(scale - 1.0) > 0.0008

        if meaningfully_off:
            if not _bake_write(d, fp, subsync.bake_srt(text, offset, scale)):
                return   # keep serving the offset-0 bake rather than a half-written one

        def _mk_done(m):
            e = m.setdefault('entries', {}).setdefault(fp, {})
            e['state'] = 'ready'
            e['offset'] = offset if meaningfully_off else 0.0
            e['scale'] = scale if meaningfully_off else 1.0
            e['confidence'] = result.get('confidence')
            e['pass'] = result.get('pass')
            e['verified_at'] = time.time()
            if meaningfully_off:
                e['version'] = int(e.get('version') or 0) + 1
        _mutate_manifest(rel, _mk_done)
    finally:
        with _SYNC_LOCK:
            _SYNC_JOBS.pop(_norm_rel(rel), None)


def _run_sync_job(rel: str, fp: str, srt_text: str, name: Optional[str]) -> None:
    """Background worker for R4/R5's external-candidate path. Writes the
    pre-bake original immediately, measures against the LOCAL cache file
    with the two-phase progressive whisper pass (subsync.
    measure_offset_progressive), then bakes + marks 'ready' on a reliable
    measurement (confidence >= 0.55, the same threshold subsync.py's
    _whisper_multi_offset already uses for `reliable`) or 'failed'
    otherwise (an explicit re-POST with the same srt -- same fp -- is the
    only way back to 'syncing'; no silent auto-retry)."""
    try:
        try:
            local = _safe_resolve(rel)
        except PermissionError:
            def _mk_badrel(m):
                e = m.setdefault('entries', {}).setdefault(fp, {})
                e['state'] = 'failed'
                e['last_error'] = 'bad rel'
            _mutate_manifest(rel, _mk_badrel)
            return
        if not local.is_file():
            def _mk_notcached(m):
                e = m.setdefault('entries', {}).setdefault(fp, {})
                e['state'] = 'failed'
                e['last_error'] = 'not cached'
            _mutate_manifest(rel, _mk_notcached)
            return

        try:
            d = _subs_dir(rel)
        except PermissionError:
            def _mk_badsubdir(m):
                e = m.setdefault('entries', {}).setdefault(fp, {})
                e['state'] = 'failed'
                e['last_error'] = 'bad subs dir'
            _mutate_manifest(rel, _mk_badsubdir)
            return
        d.mkdir(parents=True, exist_ok=True)
        try:
            (d / (fp + '.orig.srt')).write_text(srt_text, encoding='utf-8')
        except OSError:
            pass

        try:
            cues = subsync.srt_cues_text(srt_text)
        except Exception:
            cues = []
        # Same forced/partial-track guard the embedded path (R3) has always
        # had: a candidate with a handful of cues is a forced-narrative or
        # partial track (for example, a "FORCED"-tagged external SRT with
        # only five foreign-dialogue cues replacing a complete subtitle),
        # and baking it marks the file 'ready' forever -- measure-once means
        # there is no second chance without a manual manifest clear.
        if len(cues) < _MIN_FULL_SUB_CUES:
            def _mk_forced(m):
                e = m.setdefault('entries', {}).setdefault(fp, {})
                e['state'] = 'failed'
                e['last_error'] = 'forced/partial track: %d cues' % len(cues)
            _mutate_manifest(rel, _mk_forced)
            print('[cache] sync job %s: candidate rejected -- %d cues (< %d, forced/partial?)'
                  % (rel, len(cues), _MIN_FULL_SUB_CUES))
            return
        result = None
        # PRIMARY: ffsubsync (unbiased whole-file VAD x FFT). Whisper is only
        # a fallback -- its segment timestamps carry a ~1s early bias that
        # mis-shifted known-synced subs (see subsync.ffsubsync_bin).
        if cues and subsync.ffsubsync_available():
            try:
                result = subsync.measure_offset_ffsubsync(str(local), srt_text)
            except Exception as e:
                print('[cache] sync job (ffsubsync) %s: %s' % (rel, e))
                result = None
        if result is None and cues and subsync.whisper_available():
            try:
                result = subsync.measure_offset_progressive(str(local), cues, fast_windows=2)
            except Exception as e:
                print('[cache] sync job %s: %s' % (rel, e))
                result = None
        elif result is None and cues:
            # No whisper on this host -- fall back to the silencedetect
            # correlation the live /subsync endpoint uses, instead of failing
            # every external candidate outright (which silently disabled the
            # whole bake pipeline on whisper-less hosts).
            try:
                result = subsync.measure_offset_silencedetect(str(local), srt_text)
            except Exception as e:
                print('[cache] sync job (silencedetect) %s: %s' % (rel, e))
                result = None

        if not result or not result.get('reliable'):
            def _mk_fail(m):
                e = m.setdefault('entries', {}).setdefault(fp, {})
                e['state'] = 'failed'
                e['last_error'] = 'unreliable measurement' if result else 'no measurement'
                e['confidence'] = (result or {}).get('confidence')
                e['pass'] = (result or {}).get('pass')
            _mutate_manifest(rel, _mk_fail)
            return

        offset = float(result.get('offset') or 0.0)
        scale = float(result.get('scale') or 1.0)
        if not _bake_write(d, fp, subsync.bake_srt(srt_text, offset, scale)):
            def _mk_bakefail(m):
                e = m.setdefault('entries', {}).setdefault(fp, {})
                e['state'] = 'failed'
                e['last_error'] = 'bake write failed'
            _mutate_manifest(rel, _mk_bakefail)
            return

        def _mk_ready(m):
            m['active_fp'] = fp
            e = m.setdefault('entries', {}).setdefault(fp, {})
            e['state'] = 'ready'
            e['offset'] = offset
            e['scale'] = scale
            e['confidence'] = result.get('confidence')
            e['pass'] = result.get('pass')
            e['verified_at'] = time.time()
            e['version'] = int(e.get('version') or 0) + 1
        _mutate_manifest(rel, _mk_ready)
    finally:
        with _SYNC_LOCK:
            _SYNC_JOBS.pop(_norm_rel(rel), None)


# ===========================================================================
# Trick-play thumbnails -- streaming-style paused/scrubbing seek-bar previews.
# ===========================================================================
#
# Preprocessed ONCE per cached file, on the engine host, into JPEG
# "storyboard" sprite sheets under CACHE_ROOT/.thumbs/<rel>/ -- dot-prefixed,
# same convention as .subs/.probes/.torrents, so it needs no change to
# cache_files()'s existing "skip any dot-prefixed path component" rule (see
# that function's docstring) to stay invisible to cap/floor accounting.
#
# Contract served by server.py's GET /cache/thumbs(/sheet) (agreed with the
# TV-app agent working the client side in parallel):
#   GET /cache/thumbs?rel=<rel>
#     200 {state:'ready', interval, tileWidth, tileHeight, cols, rows,
#          count, duration, sheets:[...]}
#     202 {state:'generating'}   -- and (re)kicks generation if nothing is
#                                    currently in flight for this rel
#     404 {error:'not cached'}   -- rel isn't a completed cached file
#   GET /cache/thumbs/sheet?rel=<rel>&i=<n>  -> image/jpeg, 404 if absent
# Frame k lives on sheet floor(k/(cols*rows)), cell k mod (cols*rows),
# row-major, and covers time [k*interval, (k+1)*interval).
#
# ONE generation running at a time, process-wide (CPU-bounded): a single background worker thread drains a small FIFO queue,
# so a burst of "queue this rel" calls (a fresh download finishing, several
# concurrent lazy GETs) collapses to at most one ffmpeg pass in flight ever,
# with everything else waiting its turn instead of piling up concurrent
# transcodes on the engine host.

# One ffmpeg pass per file: sample every `interval` seconds (fps=1/interval),
# scale+letterbox each sample to an exact 320x180 tile (force_original_
# aspect_ratio=decrease + pad -- uniform cells regardless of the source's
# real aspect ratio, black bars same as any other letterboxed preview), then
# tile() batches consecutive samples straight into 10x10 JPEG grid sheets --
# no separate "write frames, then assemble sheets" second pass.
_THUMB_TILE_W = 320
_THUMB_TILE_H = 180
_THUMB_GRID_COLS = 10
_THUMB_GRID_ROWS = 10
_THUMB_PER_SHEET = _THUMB_GRID_COLS * _THUMB_GRID_ROWS       # 100
_THUMB_JPEG_QUALITY = 6          # ffmpeg -q:v (2=best .. 31=worst); 5-7 is a
#                                   good size/quality trade for a 320x180 tile
_THUMB_MAX_FRAMES = 400          # hard ceiling regardless of duration


def _thumb_interval_seconds(duration: float) -> int:
    """Seconds between storyboard samples, picked by duration so the total
    frame count for the whole file stays roughly in the ~120-400 range --
    tight enough to feel like a real streaming-app scrubber, sparse enough
    that a long movie doesn't turn into 1000+ tiny JPEGs on a CPU-bounded
    background pass. Buckets by rough length first (short/medium/long);
    the final clamp is what actually GUARANTEES the upper bound regardless
    of how the buckets are tuned later -- e.g. a file right at the top of
    the "< 2h" bucket would be ~720 frames at interval=10 without it."""
    if not duration or duration <= 0:
        return 10
    if duration < 30 * 60:
        interval = 5
    elif duration < 120 * 60:
        interval = 10
    else:
        interval = 15
    if duration / interval > _THUMB_MAX_FRAMES:
        interval = max(interval, int(math.ceil(duration / _THUMB_MAX_FRAMES)))
    return max(1, interval)


# ---- manifest.json (state machine: none -> generating -> ready | error) ---
# Mirrors _manifest_lock/_load_manifest/_save_manifest/_mutate_manifest
# above almost exactly, one dict per rel here instead of per (rel, subtitle
# candidate) -- kept as its own lock table (never the subs one) since these
# are two independent artifact stores for the same rel.

_THUMBS_MANIFEST_META_LOCK = threading.Lock()
_THUMBS_MANIFEST_LOCKS: dict = {}     # rel -> threading.Lock, get-or-create


def _thumbs_manifest_lock(rel: str) -> threading.Lock:
    with _THUMBS_MANIFEST_META_LOCK:
        lk = _THUMBS_MANIFEST_LOCKS.get(rel)
        if lk is None:
            lk = threading.Lock()
            _THUMBS_MANIFEST_LOCKS[rel] = lk
        return lk


def _thumbs_manifest_path(rel: str) -> Optional[Path]:
    try:
        return _thumbs_dir(rel) / 'manifest.json'
    except PermissionError:
        return None


def _thumbs_empty_manifest(rel: str) -> dict:
    return {'rel': rel, 'state': 'none'}


def _load_thumbs_manifest(rel: str) -> dict:
    """Never raises -- a missing/corrupt manifest.json is just 'none',
    exactly like _load_manifest()'s subs equivalent."""
    p = _thumbs_manifest_path(rel)
    if p is None or not p.is_file():
        return _thumbs_empty_manifest(rel)
    try:
        with open(p, 'r', encoding='utf-8') as f:
            d = json.load(f)
        if not isinstance(d, dict) or not d.get('state'):
            return _thumbs_empty_manifest(rel)
        d.setdefault('rel', rel)
        return d
    except Exception:
        return _thumbs_empty_manifest(rel)


def _save_thumbs_manifest(rel: str, manifest: dict) -> None:
    """Atomic write (.part + os.replace), same convention as every other
    manifest in this module. Best-effort -- never raises. NOTE: this is
    what makes 'ready' atomic, per the generation contract below -- the
    JPEG sheets themselves are written+renamed individually BEFORE this is
    ever called with state='ready', so a reader can never observe 'ready'
    for a manifest whose sheets aren't actually all on disk yet."""
    p = _thumbs_manifest_path(rel)
    if p is None:
        return
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name('manifest.json.part')
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(manifest, f)
        os.replace(tmp, p)
    except Exception:
        pass


def _thumbs_mutate_manifest(rel: str, fn) -> dict:
    lk = _thumbs_manifest_lock(rel)
    with lk:
        manifest = _load_thumbs_manifest(rel)
        fn(manifest)
        _save_thumbs_manifest(rel, manifest)
    return manifest


def _thumbs_mark_generating(rel: str) -> None:
    def _mut(d):
        d['rel'] = rel
        d['state'] = 'generating'
        d.pop('error', None)
    _thumbs_mutate_manifest(rel, _mut)


def _thumbs_mark_error(rel: str, msg: str) -> None:
    def _mut(d):
        d['rel'] = rel
        d['state'] = 'error'
        d['error'] = str(msg)[:300]
    _thumbs_mutate_manifest(rel, _mut)


def thumbs_state(rel: str) -> dict:
    """Public read accessor for GET /cache/thumbs -- the manifest as
    stored, or {'state': 'none'} if generation was never attempted."""
    return _load_thumbs_manifest(rel)


def thumbs_sheet_path(rel: str, index) -> Optional[Path]:
    """Resolved Path to sheet `index`'s JPEG, or None (-> 404) if the
    manifest isn't 'ready', the index is out of range, or (shouldn't
    happen, but never trust the filesystem blindly) the file is somehow
    missing on disk despite a 'ready' manifest."""
    manifest = _load_thumbs_manifest(rel)
    if manifest.get('state') != 'ready':
        return None
    try:
        i = int(index)
    except (TypeError, ValueError):
        return None
    try:
        sheet_count = int(manifest.get('sheetCount') or 0)
    except (TypeError, ValueError):
        sheet_count = 0
    if i < 0 or i >= sheet_count:
        return None
    try:
        d = _thumbs_dir(rel)
    except PermissionError:
        return None
    p = d / ('sheet_%04d.jpg' % i)
    return p if p.is_file() else None


# ---- single-flight, one-at-a-time background queue -------------------------

_THUMBS_QUEUE_LOCK = threading.Lock()
_thumbs_queue: collections.deque = collections.deque()
_thumbs_queued_rels: set = set()
_thumbs_active_rel: Optional[str] = None
_thumbs_worker_started = False


def queue_thumbs(rel: str) -> None:
    """Idempotent enqueue for background storyboard generation. Safe to
    call from many places (a cache_download() success, a lazy /cache/thumbs
    GET for a not-yet-generated rel) -- a rel that's already ready, already
    queued, or already the actively-running job is a no-op. Exactly ONE
    generation ever runs at a time process-wide: a single worker thread
    drains this FIFO queue serially (CPU-bounded, one at a time), so a burst of callers never launches more than one ffmpeg pass
    concurrently."""
    global _thumbs_worker_started
    if not rel:
        return
    if _load_thumbs_manifest(rel).get('state') == 'ready':
        return
    already_inflight = False
    started_new = False
    with _THUMBS_QUEUE_LOCK:
        already_inflight = (rel == _thumbs_active_rel) or (rel in _thumbs_queued_rels)
        if not already_inflight:
            _thumbs_queued_rels.add(rel)
            _thumbs_queue.append(rel)
        if not _thumbs_worker_started:
            _thumbs_worker_started = True
            started_new = True
    if not already_inflight:
        # Written outside the queue lock (disk I/O) -- matches every other
        # manifest mutation in this module, none of which happen while
        # holding a coordination lock.
        _thumbs_mark_generating(rel)
    if started_new:
        threading.Thread(target=_thumbs_worker_loop, daemon=True,
                          name='dumiflix-thumbs-worker').start()


def _thumbs_worker_loop() -> None:
    """The one and only thumbs-generation thread. Exits (clearing the
    'started' flag under the same lock other callers check) once the queue
    drains, rather than blocking forever on an empty queue -- the next
    queue_thumbs() call simply spins up a fresh one. That flag flip and the
    emptiness check happen under one lock acquisition, so there's no window
    where a just-enqueued rel is silently missed."""
    global _thumbs_worker_started, _thumbs_active_rel
    while True:
        with _THUMBS_QUEUE_LOCK:
            if not _thumbs_queue:
                _thumbs_worker_started = False
                return
            rel = _thumbs_queue.popleft()
            _thumbs_queued_rels.discard(rel)
            _thumbs_active_rel = rel
        try:
            _run_thumbs_job(rel)
        except Exception as e:
            _thumbs_mark_error(rel, 'internal error: %s' % e)
        finally:
            with _THUMBS_QUEUE_LOCK:
                _thumbs_active_rel = None


def _run_thumbs_job(rel: str) -> None:
    """The actual generation, run OFF the request thread by the worker
    loop above -- never called directly.

    Duration comes from remux.probe_cached() (memo -> sidecar -> ffprobe),
    reusing the SAME persisted probe sidecar cache_download() already warms
    right after a fresh download (see _warm_probe_cache/queue_thumbs' call
    site below) instead of paying for a second fresh ffprobe here.

    Spawns exactly ONE low-priority ffmpeg pass: fps=1/interval samples the
    source, scale+pad letterboxes every sample to a uniform 320x180 tile,
    and tile=10x10 batches consecutive samples directly into JPEG sheet
    images -- no second pass to assemble sheets from separate frame files.
    Priority is lowered the same portable way subsync.py's gentle ffmpeg
    passes already do: BELOW_NORMAL_PRIORITY_CLASS on Windows (the laptop
    host this is actually for), os.nice() elsewhere.

    ATOMIC FINISH: each sheet is written to '<name>.jpg.part' (ffmpeg
    can't target '.jpg' directly while keeping the format explicit for a
    '.part'-suffixed path, same trick subsync.extract_text_subtitle() uses)
    and only os.replace()'d to its final '<name>.jpg' name -- a per-file
    rename, portable to Windows unlike a whole-directory rename -- AFTER
    ffmpeg exits 0. The manifest is flipped to 'ready' (via the existing
    atomic .part+replace JSON write) only once every produced sheet has
    already been renamed into place, so a kill/crash mid-pass can only ever
    leave stale '.part'/partial files behind under a manifest that still
    says 'generating' or 'error' -- never 'ready' for an incomplete set.
    A stale 'generating' manifest from a crashed prior process is
    self-healing: it carries no in-memory queue state, so the next
    /cache/thumbs GET's queue_thumbs() call (which keys off the IN-MEMORY
    queue/active-rel, not the manifest) queues a fresh attempt, and any
    leftover partial output from the dead run is cleared before this pass
    writes anything (see the glob-and-unlink below)."""
    try:
        target = stream_target(rel)
    except Exception:
        target = None
    if target is None or not target.is_file():
        _thumbs_mark_error(rel, 'source file missing')
        return

    try:
        info = remux.probe_cached(str(target))
    except Exception as e:
        _thumbs_mark_error(rel, 'probe failed: %s' % str(e)[:200])
        return
    try:
        duration = float(info.get('duration') or 0)
    except (TypeError, ValueError):
        duration = 0.0
    if duration <= 0:
        _thumbs_mark_error(rel, 'unknown duration')
        return
    video = info.get('video') or {}
    if not video and not (info.get('video_streams') or []):
        _thumbs_mark_error(rel, 'no video stream')
        return

    interval = _thumb_interval_seconds(duration)
    cols, rows = _THUMB_GRID_COLS, _THUMB_GRID_ROWS
    per_sheet = _THUMB_PER_SHEET
    analytical_count = max(1, int(math.ceil(duration / interval)))
    analytical_sheets = int(math.ceil(analytical_count / per_sheet))

    try:
        out_dir = _thumbs_dir(rel)
    except PermissionError as e:
        _thumbs_mark_error(rel, str(e))
        return
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        _thumbs_mark_error(rel, 'mkdir failed: %s' % e)
        return

    # Clear any leftover output from a previous crashed/partial/regenerated
    # attempt so this pass never mixes old and new sheets, and a shorter
    # regeneration doesn't leave a stale higher-numbered sheet file behind
    # for thumbs_sheet_path() to (harmlessly, but pointlessly) still find.
    for p in out_dir.glob('sheet_*.jpg*'):
        _unlink_quiet(p)

    W, H = _THUMB_TILE_W, _THUMB_TILE_H
    vf = ('fps=1/%d,scale=%d:%d:force_original_aspect_ratio=decrease,'
          'pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=black,tile=%dx%d'
          % (interval, W, H, W, H, cols, rows))
    # Explicit stream index from the probe (which already filters out
    # attached-pic "video" streams -- cover art) rather than letting
    # ffmpeg's own default stream selection guess; falls back to the
    # generic 'best video stream' selector if the probe didn't resolve one.
    try:
        video_index = int(video.get('index'))
        map_args = ['-map', '0:%d' % video_index]
    except (TypeError, ValueError):
        map_args = ['-map', '0:v:0']

    out_pattern = str(out_dir / 'sheet_%04d.jpg.part')
    cmd = ([remux.FFMPEG_BIN, '-nostdin', '-hide_banner', '-loglevel', 'error',
            '-y', '-i', str(target)] + map_args +
           ['-an', '-sn', '-vf', vf, '-q:v', str(_THUMB_JPEG_QUALITY),
            # -start_number 0: the image2 muxer's own default is 1, which
            # would silently misalign every sheet index against the
            # contract's i=0-based /cache/thumbs/sheet addressing (and
            # against thumbs_sheet_path()'s 'sheet_%04d.jpg' % i lookup
            # below, which also assumes zero-based numbering).
            '-start_number', '0',
            '-f', 'image2', '-c:v', 'mjpeg', out_pattern])
    env = {**os.environ, **remux.FF_ENV}
    # A single pass necessarily decodes the WHOLE source start to finish
    # (fps downsampling happens after decode, not via seeking -- the "one
    # ffmpeg pass per file" requirement rules out a seek-per-frame
    # approach), so the timeout has to comfortably exceed real-time decode
    # even on a slow/CPU-starved laptop running this at low priority: 3x
    # the source duration, floored at 30 minutes.
    kw = {'stdout': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL,
          'timeout': max(1800, int(duration * 3)), 'env': env}
    if os.name == 'nt':
        kw['creationflags'] = (subprocess.CREATE_NO_WINDOW
                                | subprocess.BELOW_NORMAL_PRIORITY_CLASS)
    else:
        def _gentle():
            try:
                os.nice(15)
            except Exception:
                pass
        kw['preexec_fn'] = _gentle

    # hold()/release() -- same open-reader protection GET/HEAD /cache/stream
    # already gets -- so a concurrent download's eviction pass (or a manual
    # /cache/del) can't pull the source out from under this background
    # ffmpeg the way an unheld background read otherwise could.
    hold(rel)
    try:
        r = subprocess.run(cmd, **kw)
    except Exception as e:
        _thumbs_mark_error(rel, 'ffmpeg failed: %s' % str(e)[:200])
        return
    finally:
        release(rel)
    if r.returncode != 0:
        _thumbs_mark_error(rel, 'ffmpeg exited %s' % r.returncode)
        return

    parts = sorted(out_dir.glob('sheet_*.jpg.part'))
    if not parts:
        _thumbs_mark_error(rel, 'no sheets produced')
        return
    actual_sheets = 0
    for p in parts:
        final = p.with_suffix('')      # 'sheet_0000.jpg.part' -> 'sheet_0000.jpg'
        try:
            os.replace(str(p), str(final))
            actual_sheets += 1
        except OSError:
            pass
    if actual_sheets == 0:
        _thumbs_mark_error(rel, 'sheet rename failed')
        return

    # Trust reality over the analytical estimate for the final numbers: if
    # ffmpeg's tile filter didn't flush a trailing partial group the way
    # the analytical math assumed, `count` must never claim more frames
    # than sheets actually on disk, or the client would 404 fetching the
    # last one. If more sheets exist than expected (shouldn't happen), the
    # smaller analytical figure is used -- harmless, just a few unused
    # trailing cells on the spare sheet.
    final_sheet_count = min(actual_sheets, analytical_sheets) if actual_sheets >= analytical_sheets \
        else actual_sheets
    final_count = min(analytical_count, final_sheet_count * per_sheet)

    def _mk_ready(d):
        d.update({
            'rel': rel, 'state': 'ready', 'interval': interval,
            'tileWidth': W, 'tileHeight': H, 'cols': cols, 'rows': rows,
            'count': final_count, 'duration': duration,
            'sheetCount': final_sheet_count, 'error': None,
            'generated_at': time.time(),
        })
    _thumbs_mutate_manifest(rel, _mk_ready)


# ===========================================================================
# Serving -- GET /cache/stream/<rel>
# ===========================================================================

def stream_target(rel: str) -> Optional[Path]:
    """Resolve `rel` under CACHE_ROOT and bump its mtime (soft LRU-by-access,
    same trick the phone's /cache/stream uses) so the file being actively
    streamed is the LAST candidate cache_evict() would ever consider, on top
    of the hard pin via remux.active_source_path(). Returns None if the path
    doesn't resolve to a real file (caller maps that to 404)."""
    _mark_cache_activity()
    try:
        target = _safe_resolve(rel)
    except PermissionError:
        return None
    if not target.is_file():
        return None
    try:
        os.utime(target, None)
    except OSError:
        pass
    return target
