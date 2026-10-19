#!/usr/bin/env python3
"""
torrent.py -- DumiFlix direct-BitTorrent-to-local-disk downloader (LAN
laptop bolt-on; optional everywhere else).

WHY THIS EXISTS
---------------
Remote download services may impose size limits or expiring URLs. This
module drives a local `aria2c` binary to download a magnet/.torrent onto the
same disk cache.py already manages (cap/floor/eviction). Finished files become
ordinary cache entries served through /cache/stream and the remux pipeline.

This module is imported by server.py ONLY when both this file is present
AND `DUMIFLIX_TORRENT_ENABLED=1` is set -- the exact same guarded-import +
opt-in-flag pattern server.py already uses for cache.py. Hosts that do
not run local torrent jobs leave this flag unset.

DISK BUDGET -- ONE SHARED CAP, NOT A SECOND ONE
------------------------------------------------
This module does NOT invent its own byte cap or free-disk floor. Every
safety check here reads cache.HARD_CAP_BYTES / cache.FREE_FLOOR_BYTES and
calls cache.cache_evict()/cache.cache_files() directly, exactly like
cache.py's own cache_download() mid-flight checks. A torrent download and
a seedr-episode prefetch are two independent producers sharing one
disk-budget accountant (cache.py); both re-check REAL shutil.disk_usage()
and a REAL re-walk of the cache directory before trusting any number.

STAGING LOCATION vs cache.cache_files()
----------------------------------------
aria2 writes into `cache.CACHE_ROOT / '.torrents' / <job id>` WHILE a
download is in flight -- a dot-prefixed directory under the same cache
root cache.py already manages. `Path.rglob('*')`
recurses into dot-prefixed directories and returns their real-named
contents (a plain `movie.mkv` inside `.torrents/<job>/` is NOT itself
dot-prefixed), so cache.py's OWN cache_files() has been hardened (see its
docstring) to also skip any path whose relative-to-CACHE_ROOT parts
contain a dot-prefixed directory, not just a dot-prefixed leaf filename.
That is what keeps an in-flight torrent invisible to /cache/list, the cap
accounting, and cache_evict()'s eviction candidates until it is
deliberately promoted into a real cache entry on completion.

ARIA2 PROGRESS: STDOUT PARSING, NOT RPC -- AND WHY
----------------------------------------------------
aria2's JSON-RPC server gives structured progress, but wiring it here
would mean allocating a free RPC port, minting/rotating a secret token,
managing a long-lived RPC-enabled aria2 process across jobs, and parsing
a schema that still needs the same "never trust the declared size, only
real bytes on disk" discipline for the actual safety checks. Given the
safety-CRITICAL numbers (free disk floor, cache cap) already have to come
from real filesystem introspection regardless (shutil.disk_usage, a real
walk of the staging dir) -- not from anything aria2 self-reports -- RPC
buys structured *display* progress at a real robustness cost, for a
number we can't fully trust anyway. So: aria2 is spawned as a plain
subprocess with `--summary-interval=5`, its stdout is read line-by-line by
a background thread that regex-parses aria2's own human-readable ticker
lines (`[#gid RECV/TOTAL(NN%) ...]`, sizes in KiB/MiB/GiB) purely for
progress DISPLAY and for one best-effort early "declared total exceeds
cap" refusal. A SEPARATE watchdog thread, independent of stdout entirely,
re-checks real shutil.disk_usage().free against cache.FREE_FLOOR_BYTES and
a real recursive byte-count of the staging dir against cache.HARD_CAP_BYTES
every few seconds -- THAT is the actual safety guarantee, mirroring
cache.cache_download()'s mid-flight checks.

One parsing wrinkle: aria2 prints a `FILE: ...`
line identifying what a given GID is actually fetching. For a magnet, the
metadata-resolution phase shows `FILE: [MEMORY][METADATA]<name>`; for an
http(s) .torrent URL, aria2 first fetches the tiny .torrent file itself
and shows `FILE: <path>.torrent` BEFORE it ever starts the real content
GID. Both would otherwise be misread as a tiny "real" total. This module
tracks a one-way `content_seen` flag that only flips true once a `FILE:`
line appears that is neither `[MEMORY]...` nor `*.torrent` -- transitions
from metadata/torrent-fetch to real content are one-directional, so a
simple sticky boolean is enough; no per-GID bookkeeping needed.

SEASON PACKS -- ONE JOB, MANY CACHE ENTRIES
---------------------------------------------
A torrent is very often a whole-season pack, not a single file. On
completion this module does NOT keep only the largest video file: it
walks the finished staging tree and registers each primary whitelisted video
over MIN_VIDEO_BYTES as its OWN cache entry. When a pack contains multiple
S##E##/1x01 files, only those episode-tagged files qualify, so bonus-disc
featurettes such as "Episode 1 Extended Version" never become fake movies,
each under its own hashed `rel` (derived from `<job id>/<path within the
torrent>` so same-named files in different subdirectories never collide),
each with its ORIGINAL filename preserved via cache.record_name() so the
app's Library can parse S##E## and group the season. A single-file torrent
naturally yields exactly one cache entry through the same code path.

SEQUENTIAL PER-FILE DOWNLOAD -- WHEN A SEASON PACK CAN'T BE STAGED WHOLE
-------------------------------------------------------------------------
A 4K season pack can be ~10x the staging SSD's free space even though no
SINGLE episode is. Downloading the whole pack (the code path above) would
stage the entire thing at once and simply fail with no room left. Instead,
BEFORE starting the real download, this module tries to learn the torrent's
file list (index/path/size) via a metadata-only probe (_fetch_metadata_torrent
+ _parse_aria2_file_list), and if there is more than one qualifying video
file AND the combined size would eat too much of the CURRENT staging free
space (_should_sequential(), env-tunable via DUMIFLIX_TORRENT_SEQ_THRESHOLD /
forceable via DUMIFLIX_TORRENT_SEQUENTIAL=1), it downloads ONE file at a time
via aria2c's `--select-file=<idx>` (verified: every other file in the torrent
is left as a 0-byte placeholder, so peak staging is ~one file), importing and
deleting each file immediately before starting the next (_run_sequential_files).
This planning step is STRICTLY ADDITIVE and best-effort: if metadata
resolution fails, times out, is cancelled, or doesn't parse, `video_files`
stays None and _run_job falls straight through to the ORIGINAL whole-torrent
path, completely unchanged -- a torrent that worked before this change keeps
working exactly the same way. `_import_one_file()` holds the actual
move-into-cache logic shared by both the whole-pack sweep (_import_videos)
and the sequential per-file loop, so there is exactly one place that decides
how a finished video file becomes a cache entry.

STATE MACHINE (per job, process-wide dict, guarded by _LOCK for admission
and child publication/pause/resume -- other field updates are plain
assignments, same convention cache.py's own _JOBS uses):

    queued -> metadata -> downloading -> importing -> ready | error | aborted

Public surface: add(), status(), cancel(), active_list(),
cleanup_orphan_staging().
"""

from __future__ import annotations

import os
import hashlib
import json
import re
import shutil
import signal
import subprocess
import threading
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Optional

import cache  # sibling module -- the ONE shared disk-budget accountant (cap/floor/eviction/rel naming)

__all__ = [
    'ARIA2_BIN', 'add', 'status', 'cancel', 'pause_all', 'resume_all',
    'active_list', 'cleanup_orphan_staging',
]

# Windows-first, Linux-safe: every OS-specific branch is keyed off this flag, mirroring remux.py.
_IS_WIN = (os.name == 'nt')

# On the laptop aria2c is on PATH; DUMIFLIX_ARIA2 can also point at an explicit binary path.
ARIA2_BIN = os.environ.get('DUMIFLIX_ARIA2', 'aria2c')

# WHERE TORRENTS ARE WRITTEN WHILE DOWNLOADING.
#
# Default stays under the cache root (dot-prefixed, so cache_files() skips it),
# which is correct when the cache lives on the same fast disk. But when the
# cache is an external USB HDD, staging there is actively harmful: BitTorrent
# writes pieces in random order across the whole file for hours, which is the
# worst possible access pattern for spinning rust and keeps the drive spun up
# the entire time. Staging on the SSD and moving ONE sequential copy to the HDD
# at the end is far kinder to the drive and much faster.
#
# Set DUMIFLIX_TORRENT_STAGING to an SSD path to split them. Everything
# downstream now handles staging and cache being on DIFFERENT filesystems --
# see _import_videos() (cross-device move) and _watchdog() (which drive's free
# space is being checked).
STAGING_ROOT = Path(os.environ.get('DUMIFLIX_TORRENT_STAGING')
                    or (cache.CACHE_ROOT / '.torrents'))

# Optional remote-storage mode: CACHE_ROOT can be a mounted filesystem.
# Refuse work when the mount disappears instead of filling the underlying
# mountpoint or writing payloads onto the wrong machine.
REQUIRE_MOUNT = os.environ.get('DUMIFLIX_TORRENT_REQUIRE_MOUNT', '0') == '1'


def _required_mount_ready() -> bool:
    if not REQUIRE_MOUNT:
        return True
    try:
        return cache.CACHE_ROOT.is_dir() and os.path.ismount(str(cache.CACHE_ROOT))
    except OSError:
        return False

# A split staging filesystem needs its own free-space floor. Inheriting a
# large destination reserve can abort downloads on a healthy scratch disk.
# Keep at least 4 GiB free on staging independently of the cache's reserve.
STAGING_FREE_FLOOR_BYTES = max(
    int(os.environ.get('DUMIFLIX_TORRENT_STAGING_FLOOR_BYTES', 4 * 1024 ** 3)),
    4 * 1024 ** 3,
)


def _existing_ancestor(p: Path) -> Path:
    """Nearest existing ancestor of `p` -- shutil.disk_usage() needs a path
    that exists, and the staging dir may not be created yet on a cold start."""
    q = p
    for _ in range(6):
        if q.exists():
            return q
        if q.parent == q:
            break
        q = q.parent
    return q


def _staging_free_bytes() -> int:
    """Free space on the STAGING filesystem. Distinct from _free_bytes(), which
    reports the CACHE filesystem -- once the two are split, checking the wrong
    one means the guard is watching a drive the download isn't filling."""
    try:
        return shutil.disk_usage(_existing_ancestor(STAGING_ROOT)).free
    except OSError:
        return 0


def _staging_is_same_fs_as_cache() -> bool:
    try:
        return _existing_ancestor(STAGING_ROOT).stat().st_dev == cache.CACHE_ROOT.stat().st_dev
    except OSError:
        return False

# Skip samples/extras/nfo-adjacent junk in a season pack -- only register real episodes/movies.
MIN_VIDEO_BYTES = int(os.environ.get('DUMIFLIX_TORRENT_MIN_VIDEO_BYTES') or 100 * 1024 * 1024)

_EPISODE_VIDEO_RE = re.compile(
    r'(?i)(?:\bS\d{1,2}[. _-]?E\d{1,3}\b|\b\d{1,2}x\d{1,3}\b)')
_OBVIOUS_BONUS_VIDEO_RE = re.compile(
    r'(?i)(?:^|[/\\])(?:sample(?:[. _-]|$)|episode[. _-]*\d+[. _-]+extended[. _-]+version\b)'
    r'|\b(?:behind[. _-]*the[. _-]*scenes|making[. _-]*of|featurette|deleted[. _-]*scenes|gag[. _-]*reel)\b')


def _select_primary_video_rows(rows: list) -> list:
    """Remove obvious bonus clips, then prefer episode-tagged rows for packs.

    A standalone movie or oddly-named single episode keeps the historical
    size/extension behaviour. The stricter selection only activates when at
    least two conventional episode files prove that the torrent is a season
    pack, which avoids importing arbitrary Blu-ray extras as Library movies.
    Rows may carry a string or Path in their ``path`` field.
    """
    primary = [row for row in rows
               if not _OBVIOUS_BONUS_VIDEO_RE.search(str(row.get('path') or ''))]
    tagged = [row for row in primary
              if _EPISODE_VIDEO_RE.search(str(row.get('path') or ''))]
    return tagged if len(tagged) >= 2 else primary

# Belt-and-suspenders alongside the FILE:-line metadata/content classification (see
# _stdout_reader): a total below this is never treated as "the real payload size" for
# the one-shot early cap-refusal, even if `content_seen` already flipped true. Guards
# the edge case of an http(s) .torrent URL whose locally-saved filename doesn't happen
# to end in '.torrent' (no Content-Disposition hint) -- which would otherwise let a
# tiny torrent-metafile total latch cap_checked=True and permanently skip the early
# refusal check for the REAL (large) total that arrives moments later.
_MIN_CONTENT_BYTES_FOR_CAP_CHECK = 20 * 1024 * 1024

# How often the watchdog thread re-checks REAL disk usage while a download is in flight.
DISK_CHECK_INTERVAL_S = 5

# Single-flight by default; a small cap is honored if explicitly raised via env.
MAX_CONCURRENT = max(1, int(os.environ.get('DUMIFLIX_TORRENT_CONCURRENCY') or 1))

_ACTIVE_STATES = {'queued', 'metadata', 'downloading', 'importing'}

# Cap on retained TERMINAL (ready/error/aborted) job records. _JOBS is
# in-memory only and was never pruned, so on a long-uptime server it grew by
# one dict per torrent ever added, unbounded. We keep the most recent N
# terminal records (so /torrent/status still answers for recently-finished
# jobs) and drop the oldest beyond that. Active jobs are never pruned.
_MAX_TERMINAL_JOBS = int(os.environ.get('DUMIFLIX_TORRENT_MAX_TERMINAL_JOBS') or 64)

_LOCK = threading.Lock()          # guards _JOBS insertion and child publication/pause/resume
_JOBS: dict = {}                  # job_id -> dict(state, name, source, staging, received, total,
                                   #                progress, error, rel, rels, proc, _cancel, ...)
_GLOBAL_PAUSED = threading.Event()  # watcher gate: new children self-pause while playback is active


def _publish_proc(job: dict, proc: Optional[subprocess.Popen]) -> None:
    # Publish + test the pause flag in the SAME critical section as the
    # pause/resume passes. A resume cannot miss a child that then SIGSTOPs
    # itself using the old flag value.
    with _LOCK:
        job['proc'] = proc
        if proc is not None:
            job['paused'] = _GLOBAL_PAUSED.is_set()
            if job['paused']:
                _pause_proc(proc)

# ===========================================================================
# aria2 stdout parsing -- see module docstring for why stdout, not RPC.
# ===========================================================================

# Matches aria2's periodic per-GID ticker line, e.g.:
#   [#d76c90 32KiB/10MiB(0%) CN:1 DL:90KiB ETA:1m52s]
#   [#29a75b 0B/0B CN:0 SD:0 DL:0B]                      <- metadata phase, no percent shown
_TICKER_RE = re.compile(
    r'\[#(?P<gid>[0-9a-fA-F]+)\s+(?P<recv>[\d.]+[A-Za-z]*)/(?P<total>[\d.]+[A-Za-z]*)'
    r'(?:\((?P<pct>\d+)%\))?'
)
# Matches the "FILE: <path>" line aria2 prints once per GID inside each summary block.
_FILE_RE = re.compile(r'^FILE:\s*(.+?)\s*$')

_UNIT_MULT = {
    'B': 1,
    'K': 1024, 'KI': 1024, 'KIB': 1024,
    'M': 1024 ** 2, 'MI': 1024 ** 2, 'MIB': 1024 ** 2,
    'G': 1024 ** 3, 'GI': 1024 ** 3, 'GIB': 1024 ** 3,
    'T': 1024 ** 4, 'TI': 1024 ** 4, 'TIB': 1024 ** 4,
}


def _parse_size_token(tok: str) -> Optional[int]:
    """'32KiB' -> 32768, '10MiB' -> 10485760, '0B' -> 0. None if unparseable."""
    m = re.match(r'^([\d.]+)([A-Za-z]*)$', (tok or '').strip())
    if not m:
        return None
    try:
        num = float(m.group(1))
    except ValueError:
        return None
    mult = _UNIT_MULT.get(m.group(2).upper(), 1)
    return int(num * mult)


def _derive_name(source: str) -> str:
    """Best-effort human name for a job that didn't get an explicit `name`:
    a magnet's dn= param, or an http(s) URL's basename."""
    try:
        if source.startswith('magnet:'):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(source).query)
            dn = (qs.get('dn') or [None])[0]
            if dn:
                return urllib.parse.unquote_plus(dn)
        else:
            base = os.path.basename(urllib.parse.urlparse(source).path)
            if base:
                return urllib.parse.unquote(base)
    except Exception:
        pass
    return source[:80]


def _resolve_aria2() -> Optional[str]:
    """Resolve ARIA2_BIN to a runnable path: an explicit path (checked to
    exist) or a bare command name resolved against PATH. Never raises --
    returns None if aria2 isn't available, so add() can fail fast+clean
    rather than the background job dying later."""
    p = ARIA2_BIN
    if os.path.isabs(p) or os.sep in p or '/' in p:
        return p if os.path.exists(p) else None
    return shutil.which(p)


# ===========================================================================
# Sequential per-file planning -- see module docstring "SEQUENTIAL PER-FILE
# DOWNLOAD". Everything here is a best-effort PROBE: on any failure, the
# caller (_run_job) falls straight through to the original whole-torrent
# path, unmodified. Nothing here is allowed to be a hard requirement for a
# torrent that used to work.
# ===========================================================================

# Bound on how long a magnet's metadata-only resolution is allowed to run
# before planning gives up and falls back to the whole-torrent path (which
# will itself attempt metadata resolution again as its very first phase --
# so a genuinely dead magnet fails the same way it always did, just after
# some extra wasted seconds up front rather than instead of them).
_METADATA_TIMEOUT_S = int(os.environ.get('DUMIFLIX_TORRENT_METADATA_TIMEOUT_S') or 120)

# `aria2c -S <torrent>` prints an index+path line, e.g. `  1|./Pack/Show.S01E01.mkv`,
# followed by a line carrying the exact byte count in parens, e.g.
# `  |11GiB (12,607,042,523)`. Parse the byte count rather than rounded units.
# The parenthesized figure (not the human-readable GiB/MiB) is what's parsed,
# since that's the one without any rounding loss.
_S_HEADER_RE = re.compile(r'^\s*(\d+)\|(.+?)\s*$')
_S_SIZE_RE = re.compile(r'^\s*\|.*\(([\d,]+)\)\s*$')


def _fetch_metadata_torrent(jid: str, job: dict, aria2_bin: str, source: str,
                             staging: Path) -> Optional[Path]:
    """Resolve `source` (magnet or http(s) .torrent URL) to an on-disk
    .torrent file WITHOUT downloading any real content -- just enough to let
    _parse_aria2_file_list() see the per-file breakdown before committing to
    whole-pack vs sequential. Magnet: aria2c --bt-metadata-only=true
    --bt-save-metadata=true (verified: writes <infohash>.torrent into --dir).
    http(s): fetched directly via urllib -- it's already a small file, no
    need to spin up a second aria2 process just to grab it. Returns None on
    ANY failure (including cancellation) -- see section docstring."""
    meta_dir = staging / '_meta'
    try:
        meta_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None

    if source.startswith('magnet:'):
        cmd = [aria2_bin, '--dir', str(meta_dir), '--bt-metadata-only=true',
               '--bt-save-metadata=true', '--seed-time=0',
               '--console-log-level=warn', '--summary-interval=0', source]
        proc = None
        try:
            # DEVNULL, not PIPE: this process's stdout is never drained (we
            # only care about its exit code + the .torrent file it writes),
            # and --summary-interval=0 still leaves some warn-level chatter
            # possible over a long resolution -- with PIPE that could fill
            # the OS pipe buffer and block the child on write(). DEVNULL
            # sidesteps that entirely. Process-group/no-window setup from
            # _popen_kwargs() is still needed so _kill_proc() can clean-kill
            # this the same way as every other aria2 child.
            kw = _popen_kwargs()
            kw['stdout'] = subprocess.DEVNULL
            kw['stderr'] = subprocess.DEVNULL
            proc = subprocess.Popen(cmd, **kw)
            _publish_proc(job, proc)
            # Poll rather than a blocking wait() so cancel() can interrupt
            # metadata resolution too -- DHT/tracker lookups can legitimately
            # take a while, and a magnet with no reachable peers would
            # otherwise hang the job with no way out but killing the process.
            deadline = time.time() + _METADATA_TIMEOUT_S
            while proc.poll() is None:
                if job.get('_cancel') or time.time() > deadline:
                    _kill_proc(proc)
                    return None
                if _GLOBAL_PAUSED.is_set():
                    # Paused playback time must not consume the metadata
                    # resolution timeout budget.
                    deadline += 0.5
                time.sleep(0.5)
        except Exception:
            if proc is not None:
                _kill_proc(proc)
            return None
        finally:
            _publish_proc(job, None)
        if proc.returncode != 0:
            return None
        for p in meta_dir.glob('*.torrent'):
            return p
        return None

    # http(s) .torrent URL -- a plain small-file fetch.
    try:
        req = urllib.request.Request(source, headers={'User-Agent': 'aria2c/1.37.0'})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
        dest = meta_dir / 'source.torrent'
        dest.write_bytes(data)
        return dest
    except Exception:
        return None


def _parse_aria2_file_list(aria2_bin: str, torrent_path: Path) -> list:
    """Parse `aria2c -S <torrent>` into [{'index', 'path', 'size'}, ...],
    1-based indices matching --select-file=N. Returns [] on any failure --
    caller treats an empty/short list as "can't plan, fall back"."""
    try:
        out = subprocess.run([aria2_bin, '-S', str(torrent_path)],
                              capture_output=True, text=True, timeout=30,
                              encoding='utf-8', errors='replace')
    except Exception:
        return []
    files = []
    pending = None   # (index, path) waiting for its size line
    for line in (out.stdout or '').splitlines():
        m = _S_HEADER_RE.match(line)
        if m:
            pending = (int(m.group(1)), m.group(2).strip())
            continue
        sm = _S_SIZE_RE.match(line)
        if sm and pending is not None:
            idx, path = pending
            try:
                size = int(sm.group(1).replace(',', ''))
            except ValueError:
                size = 0
            files.append({'index': idx, 'path': path, 'size': size})
            pending = None
    return files


def _should_sequential(qualifying_files: list) -> bool:
    """Decide whole-pack vs one-file-at-a-time. `qualifying_files` is already
    filtered to video files >= MIN_VIDEO_BYTES. Forced on via
    DUMIFLIX_TORRENT_SEQUENTIAL=1 (as long as at least one file qualifies --
    forcing it on a single-file torrent is a harmless one-iteration loop, not
    an error, and is useful for testing the sequential path deliberately).
    Otherwise: only when there's more than one qualifying file (nothing to
    gain from the extra metadata round-trip on a single-file torrent) AND the
    combined size exceeds DUMIFLIX_TORRENT_SEQ_THRESHOLD (default 0.8) of the
    CURRENT staging free space -- i.e. the whole pack could plausibly not
    fit. Mirrors _admit_total()'s "don't wait for an actual failure" spirit,
    just applied before any bytes are written instead of mid-download."""
    if not qualifying_files:
        return False
    if os.environ.get('DUMIFLIX_TORRENT_SEQUENTIAL') == '1':
        return True
    if len(qualifying_files) <= 1:
        return False
    total = sum(f['size'] for f in qualifying_files)
    try:
        threshold = float(os.environ.get('DUMIFLIX_TORRENT_SEQ_THRESHOLD') or 0.8)
    except ValueError:
        threshold = 0.8
    return total > (_staging_free_bytes() * threshold)


# ===========================================================================
# Shared-cap disk safety -- reads cache.py's own numbers/helpers, never a
# second independent limit. Mirrors cache.cache_download()'s philosophy:
# never trust a declared size, always re-check REAL bytes.
# ===========================================================================

def _free_bytes() -> int:
    try:
        return shutil.disk_usage(cache.CACHE_ROOT).free
    except OSError:
        return 0


def _other_cache_total() -> int:
    """Real, current total of every OTHER finished cache file. Excludes this
    (and every) in-flight torrent staging dir because cache.cache_files()
    now skips anything under a dot-prefixed directory -- see cache.py.

    A remote torrent host may write to a network-mounted cache. Per-file
    stats can be slow enough to strand a control request, so read the
    event-driven, atomic `.listing.json` inventory instead. The real
    free-space floor remains the hard mid-flight safety boundary even if
    another process mutates the
    cache between index refreshes.
    """
    if REQUIRE_MOUNT:
        try:
            indexed = cache._read_listing()
            if indexed is not None:
                return sum(max(0, int(f.get('size') or 0)) for f in indexed
                           if isinstance(f, dict))
        except Exception:
            pass
        # Missing/corrupt index on a fresh sink: do not fall back to hundreds
        # of synchronous network filesystem stats. The real free-space floor below remains
        # authoritative until the event-driven index is rebuilt.
        return 0
    return sum(s for _p, s, _m in cache.cache_files())


def _dir_bytes(root: Path) -> int:
    total = 0
    if not root.exists():
        return 0
    for p in root.rglob('*'):
        if p.is_file():
            try:
                total += p.stat().st_size
            except OSError:
                pass
    return total


def _admit_total(total_bytes: int) -> bool:
    """One-shot early refusal once aria2 reports the torrent's real total
    (post metadata-resolution): evict oldest-first if that would make it
    fit, then refuse if it still won't. Mirrors cache.reserve()'s preflight."""
    # The free-space floor is authoritative in remote-storage mode: it comes from
    # the mounted laptop filesystem, not a potentially stale index.
    if REQUIRE_MOUNT and total_bytes > max(0, _free_bytes() - cache.FREE_FLOOR_BYTES):
        return False
    other = _other_cache_total()
    if other + total_bytes <= cache.HARD_CAP_BYTES:
        return True
    # Never mass-delete a cache library over a high-latency network mount.
    # The laptop's own cache service remains the eviction owner.
    if REQUIRE_MOUNT:
        return False
    cache.cache_evict(need_bytes=total_bytes, protect_rel=cache.protected_rel())
    other = _other_cache_total()
    return (other + total_bytes) <= cache.HARD_CAP_BYTES


# ===========================================================================
# Process control -- Windows headless spawn / clean kill, guarded by _IS_WIN.
# ===========================================================================

def _popen_kwargs() -> dict:
    kw = dict(stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
              stdin=subprocess.DEVNULL, bufsize=1, universal_newlines=True,
              # Windows defaults text pipes to cp1252 -- aria2c prints UTF-8
              # filenames, and one bad byte would kill the stdout reader.
              encoding='utf-8', errors='replace')
    if _IS_WIN:
        # No console window for a headless service process.
        kw['creationflags'] = subprocess.CREATE_NO_WINDOW
    else:
        # Own process group so cancel() can SIGTERM/SIGKILL the whole tree
        # without touching the server process -- same trick remux.py uses.
        kw['preexec_fn'] = os.setsid
    return kw


def _kill_proc(proc: Optional[subprocess.Popen]) -> None:
    """Clean, cross-platform teardown. Windows: taskkill /F /T (whole tree).
    Unix: SIGTERM the process group, SIGKILL if it doesn't die promptly."""
    if proc is None or proc.poll() is not None:
        return
    if _IS_WIN:
        try:
            subprocess.run(['taskkill', '/F', '/T', '/PID', str(proc.pid)], capture_output=True)
            proc.wait(timeout=3)
            return
        except Exception:
            pass
        try:
            proc.kill()
            proc.wait(timeout=2)
        except Exception:
            pass
    else:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except Exception:
            pass
        try:
            proc.wait(timeout=3)
            return
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            proc.wait(timeout=2)
        except Exception:
            pass


def _pause_proc(proc: Optional[subprocess.Popen]) -> bool:
    """Suspend one aria2 process group. The production torrent engine runs
    on Linux engine hosts; Windows local mode is deliberately disabled and therefore
    refuses to pretend it can safely pause a whole process tree."""
    if proc is None or proc.poll() is not None or _IS_WIN:
        return False
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGSTOP)
        return True
    except Exception:
        return False


def _resume_proc(proc: Optional[subprocess.Popen]) -> bool:
    if proc is None or proc.poll() is not None or _IS_WIN:
        return False
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGCONT)
        return True
    except Exception:
        return False


# ===========================================================================
# Background threads per job: stdout reader (progress display + one-shot
# early cap refusal) and watchdog (the actual, stdout-independent safety
# guarantee -- real disk_usage + real staging-dir size, every few seconds).
# ===========================================================================

def _stdout_reader(jid: str, proc: subprocess.Popen, stop_event: threading.Event) -> None:
    job = _JOBS.get(jid)
    if job is None or proc.stdout is None:
        return
    content_seen = False   # one-way flip: True once a REAL (non-metadata) FILE: line is seen
    cap_checked = False
    try:
        for line in proc.stdout:
            if stop_event.is_set():
                break
            line = line.rstrip('\n')

            fm = _FILE_RE.match(line)
            if fm:
                path = fm.group(1)
                is_meta = path.endswith('.torrent') or '[MEMORY]' in path
                if not is_meta:
                    content_seen = True
                continue

            tm = _TICKER_RE.search(line)
            if not tm:
                continue
            if not content_seen:
                # Still resolving magnet metadata, or fetching the .torrent
                # file itself -- these totals are not the real payload size.
                if job['state'] == 'queued':
                    job['state'] = 'metadata'
                continue

            if job['state'] in ('queued', 'metadata'):
                job['state'] = 'downloading'

            total = _parse_size_token(tm.group('total'))
            if total:
                job['total'] = total
                if not cap_checked and total >= _MIN_CONTENT_BYTES_FOR_CAP_CHECK:
                    cap_checked = True
                    if not _admit_total(total):
                        job['_cancel'] = True
                        job['error'] = 'cache full (torrent total exceeds cap)'
                        _kill_proc(proc)
                        break

            recv = _parse_size_token(tm.group('recv'))
            if recv is not None:
                job['received'] = recv
                if job.get('total'):
                    job['progress'] = max(0, min(100, int(recv * 100 / job['total'])))
                else:
                    pct = tm.group('pct')
                    if pct is not None:
                        job['progress'] = int(pct)
    except Exception:
        pass


def _watchdog(jid: str, proc: subprocess.Popen, stop_event: threading.Event) -> None:
    """THE actual disk-safety guarantee -- entirely independent of aria2's
    stdout. Every DISK_CHECK_INTERVAL_S: real staging-drive free space vs the
    independent STAGING_FREE_FLOOR_BYTES (never let it dip below), and a real
    staging-dir byte count vs
    cache.HARD_CAP_BYTES combined with every other real cache file already on
    disk (evict oldest-first if that helps, abort if it still won't fit).
    Mirrors cache.cache_download()'s mid-flight checks exactly, just on a
    several-second cadence instead of per-chunk (a torrent's rate of change
    is far slower than a raw HTTP stream)."""
    job = _JOBS.get(jid)
    if job is None:
        return
    staging = Path(job['staging'])
    while not stop_event.wait(DISK_CHECK_INTERVAL_S):
        if job.get('_cancel'):
            _kill_proc(proc)
            return
        if not _required_mount_ready():
            job['_cancel'] = True
            job['error'] = 'remote cache mount disconnected'
            _kill_proc(proc)
            return
        # Check the drive actually being written to. When staging is split onto
        # the SSD, the cache drive isn't growing during the download at all --
        # watching it would leave the real target completely unguarded.
        if _staging_free_bytes() < STAGING_FREE_FLOOR_BYTES:
            job['_cancel'] = True
            job['error'] = 'free disk floor breached mid-download (staging drive)'
            _kill_proc(proc)
            return
        if not _staging_is_same_fs_as_cache() and _free_bytes() < cache.FREE_FLOOR_BYTES:
            # The cache drive still has to have room for the final move.
            job['_cancel'] = True
            job['error'] = 'free disk floor breached mid-download (cache drive)'
            _kill_proc(proc)
            return
        staged = _dir_bytes(staging)
        other = _other_cache_total()
        if other + staged > cache.HARD_CAP_BYTES:
            if REQUIRE_MOUNT:
                job['_cancel'] = True
                job['error'] = 'cache full (mid-download)'
                _kill_proc(proc)
                return
            cache.cache_evict(need_bytes=staged, protect_rel=cache.protected_rel())
            other = _other_cache_total()
            if other + staged > cache.HARD_CAP_BYTES:
                job['_cancel'] = True
                job['error'] = 'cache full (mid-download)'
                _kill_proc(proc)
                return


# ===========================================================================
# Completion -- import every whitelisted video file in the finished staging
# tree as its OWN cache entry (season-pack aware).
# ===========================================================================

def _reserve_import_destination(file_key: str, name: str) -> tuple:
    """Keep the readable name when free; exclusively reserve any destination.

    Existing files have no trustworthy source identity, so never replace one.
    The source suffix keeps colliding episode names readable and distinct;
    exclusive creation also covers concurrent torrent imports.
    """
    rel = cache._rel_for(file_key, name)
    stem, ext = os.path.splitext(rel)
    suffix = hashlib.sha256(file_key.encode('utf-8')).hexdigest()[:12]
    attempt = 0
    while True:
        candidate = rel if not attempt else (
            f'{stem}_{suffix}{"" if attempt == 1 else "_" + str(attempt)}{ext}')
        dest = cache.CACHE_ROOT / candidate
        try:
            with dest.open('xb'):
                pass
            return candidate, dest
        except FileExistsError:
            attempt += 1


def _import_one_file(jid: str, p: Path, staging: Path) -> Optional[dict]:
    """Move ONE already-qualified video file from staging into cache.CACHE_ROOT
    as its own hashed entry, preserving its original filename via
    cache.record_name(). Shared body used by BOTH _import_videos() (the
    whole-torrent completion sweep, one call per file in a loop) and
    _run_sequential_files() (one call per file, immediately after that file
    finishes downloading) -- there is exactly one place that decides how a
    finished video file becomes a cache entry. Returns {'rel', 'size', 'name'}
    or None if the file couldn't be moved (caller decides what that means)."""
    try:
        size = p.stat().st_size
    except OSError:
        return None
    try:
        rel_in_staging = p.relative_to(staging).as_posix()
    except ValueError:
        rel_in_staging = p.name
    # file_key includes the job id + the file's own path within the
    # torrent, so two same-named episodes in different subdirectories
    # (or across two different jobs) never collide on the hashed rel.
    file_key = f'{jid}/{rel_in_staging}'
    try:
        cache.CACHE_ROOT.mkdir(parents=True, exist_ok=True)
        rel, dest = _reserve_import_destination(file_key, p.name)
    except OSError:
        return None
    # Staging and cache may now be on DIFFERENT drives (SSD staging ->
    # HDD cache). p.replace() is an atomic rename and CANNOT cross a
    # filesystem boundary -- it raises OSError, which the old code caught
    # and `continue`d past, i.e. it would have SILENTLY DROPPED every
    # imported file the moment staging moved off the cache drive. So: keep
    # the atomic rename when they're on the same filesystem, and fall back
    # to shutil.move (copy + unlink) when they're not.
    moved = False
    try:
        if _staging_is_same_fs_as_cache():
            p.replace(dest)
        else:
            # A cross-device move is a real copy, so make sure the
            # DESTINATION can actually take it first -- otherwise we fill
            # the cache drive to 0 bytes and fail halfway.
            try:
                if shutil.disk_usage(cache.CACHE_ROOT).free - size < cache.FREE_FLOOR_BYTES:
                    cache.cache_evict(need_bytes=size, protect_rel=cache.protected_rel())
                    if shutil.disk_usage(cache.CACHE_ROOT).free - size < cache.FREE_FLOOR_BYTES:
                        return None          # no room even after eviction; leave it staged
            except OSError:
                pass
            shutil.move(str(p), str(dest))
        moved = True
    except OSError:
        return None
    finally:
        if not moved:
            # This destination belongs to us. Remove an empty reservation or
            # incomplete cross-device copy, while keeping the staged source.
            try:
                dest.unlink()
            except OSError:
                pass
    cache.record_name(rel, p.name)   # preserve the ORIGINAL filename for the Library UI
    # The file just became a finished cache entry -- kick off background
    # Whisper subtitle generation (single-flight/bounded-concurrency,
    # never blocks this import; see cache.maybe_generate_sub()).
    try:
        cache.maybe_generate_sub(rel)
    except Exception:
        pass
    return {'rel': rel, 'size': size, 'name': p.name}


class _ImportFailure(RuntimeError):
    """Partial import: retain successes for callers that can report progress.

    Legacy callers expect a list of dictionaries on success. Raising on any
    failure prevents those callers from treating a partial list as complete.
    """
    def __init__(self, results, failures):
        self.results = results
        self.failures = failures
        super().__init__('import failed; staging kept for retry: ' + ', '.join(
            failure['path'] for failure in failures))


_IMPORT_SELECTION_FILE = '.import-selection.json'


def _write_import_selection(staging: Path, selection: list) -> None:
    path = staging / _IMPORT_SELECTION_FILE
    part = path.with_name(path.name + '.part')
    part.write_text(json.dumps(selection), encoding='utf-8')
    part.replace(path)


def _import_selection(staging: Path) -> list:
    """Persist selection before moving files; never reclassify leftovers."""
    path = staging / _IMPORT_SELECTION_FILE
    if path.exists():
        selection = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(selection, list):
            raise ValueError('invalid import selection')
        for entry in selection:
            relative = Path(entry['path'])
            if relative.is_absolute() or '..' in relative.parts:
                raise ValueError('invalid path in import selection')
        return selection
    qualified = []
    for p in sorted(staging.rglob('*')):
        if not p.is_file():
            continue
        ext = os.path.splitext(p.name)[1].lower()
        if ext not in cache._ALLOWED_EXTS:
            continue
        try:
            size = p.stat().st_size
        except OSError:
            # An unreadable candidate must not be silently left out of the
            # durable plan, which would authorize cleanup after other moves.
            raise
        if size < MIN_VIDEO_BYTES:
            continue
        qualified.append({'path': p, 'size': size})
    selection = [{'path': row['path'].relative_to(staging).as_posix(), 'result': None}
                 for row in _select_primary_video_rows(qualified)]
    _write_import_selection(staging, selection)
    return selection


def _import_videos(jid: str, staging: Path) -> list:
    """Return imported file dictionaries, or raise _ImportFailure.

    The original list contract is also used by the dashboard helper. A
    partial failure raises before it can report success or clean staging.
    Retrying uses only unfinished entries in the original durable selection.
    """
    if not staging.exists():
        return []
    _begin_import(staging)
    selection = _import_selection(staging)
    results = []
    failures = []
    for entry in selection:
        if entry.get('result') is not None:
            results.append(entry['result'])
            continue
        path = staging / entry['path']
        error = 'could not move file into cache (check destination space and permissions)'
        try:
            r = _import_one_file(jid, path, staging)
        except Exception as e:
            r = None
            error = str(e)
        if r is not None:
            results.append(r)
            entry['result'] = r
            _write_import_selection(staging, selection)
        else:
            failures.append({'path': entry['path'], 'error': error})
    if failures:
        raise _ImportFailure(results, failures)
    (staging / _IMPORT_RETRY_MARKER).unlink()
    return results


_IMPORT_RETRY_MARKER = '.import-retry'


def _begin_import(staging: Path) -> None:
    # Persist BEFORE moving anything: a crash or exception mid-import must
    # also survive the next startup's orphan sweep for a manual retry.
    (staging / _IMPORT_RETRY_MARKER).touch()


def _import_failed(job: dict, failures: list) -> None:
    job['importFailures'] = failures
    job['state'] = 'error'
    job['error'] = 'import failed; staging kept for retry: ' + ', '.join(
        f['path'] for f in failures)


def _cleanup_staging(staging: Path, force: bool = False) -> None:
    try:
        if not force and (staging / _IMPORT_RETRY_MARKER).exists():
            return
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
    except Exception:
        pass


def _finish_cancelled_or_stopped(job: dict, staging: Path) -> None:
    """Shared terminal-state logic for a job that stopped via the `_cancel`
    kill-signal, whether that was a genuine user cancel() or a disk-safety
    stop (floor breach / over-cap) raised by the watchdog. 'aborted' means the
    CALLER asked to stop; a disk-safety stop shares the same `_cancel`
    plumbing but is a real failure, not a user cancellation -- reported as
    'error' with the specific reason already recorded in job['error'].
    Reused by the planning phase, the sequential per-file loop, and the
    original whole-torrent path so all three agree on this distinction."""
    if job.get('_user_cancelled'):
        job['state'] = 'aborted'
        job['error'] = job.get('error') or 'cancelled'
    else:
        job['state'] = 'error'
        job['error'] = job.get('error') or 'download stopped'
    _cleanup_staging(staging)


# ===========================================================================
# Job lifecycle
# ===========================================================================

def _run_job(jid: str) -> None:
    job = _JOBS.get(jid)
    if job is None:
        return
    staging = Path(job['staging'])
    proc = None
    try:
        if not _required_mount_ready():
            job['state'] = 'error'
            job['error'] = 'remote cache filesystem is not mounted'
            return
        staging.mkdir(parents=True, exist_ok=True)
        job['state'] = 'metadata'

        aria2_bin = _resolve_aria2()
        if not aria2_bin:
            job['state'] = 'error'
            job['error'] = f'aria2 binary not found ({ARIA2_BIN})'
            _cleanup_staging(staging)
            return

        # ---- SEQUENTIAL PLANNING (additive, best-effort) -----------------
        # See module docstring "SEQUENTIAL PER-FILE DOWNLOAD". ANY failure
        # here (unparseable output, timeout, cancellation) leaves
        # video_files == None, which falls straight through to the ORIGINAL
        # whole-torrent path below, completely unchanged.
        video_files = None
        torrent_path = None
        try:
            torrent_path = _fetch_metadata_torrent(jid, job, aria2_bin, job['source'], staging)
        except Exception:
            torrent_path = None

        if job.get('_cancel'):
            _finish_cancelled_or_stopped(job, staging)
            return

        if torrent_path is not None:
            try:
                files = _parse_aria2_file_list(aria2_bin, torrent_path)
            except Exception:
                files = []
            qualifying = _select_primary_video_rows([
                f for f in files
                if os.path.splitext(f['path'])[1].lower() in cache._ALLOWED_EXTS
                and f.get('size', 0) >= MIN_VIDEO_BYTES
            ])
            if _should_sequential(qualifying):
                video_files = sorted(qualifying, key=lambda f: f['index'])

        if video_files:
            job['state'] = 'downloading'
            job['filesTotal'] = len(video_files)
            job['filesDone'] = 0
            job['currentFile'] = None
            _run_sequential_files(jid, job, aria2_bin, torrent_path, staging, video_files)
            return

        # ---- ORIGINAL WHOLE-TORRENT PATH (unchanged) ----------------------
        job['state'] = 'metadata' if job['source'].startswith('magnet:') else 'downloading'

        cmd = [
            aria2_bin, '--dir', str(staging),
            '--seed-time=0', '--bt-stop-timeout=1200', '--summary-interval=5',
            '--file-allocation=none', '--console-log-level=warn',
            '--bt-metadata-only=false',
            job['source'],
        ]
        proc = subprocess.Popen(cmd, **_popen_kwargs())
        _publish_proc(job, proc)

        stop_event = threading.Event()
        reader_t = threading.Thread(target=_stdout_reader, args=(jid, proc, stop_event),
                                     daemon=True, name=f'torrent-read-{jid[:8]}')
        watchdog_t = threading.Thread(target=_watchdog, args=(jid, proc, stop_event),
                                       daemon=True, name=f'torrent-wd-{jid[:8]}')
        reader_t.start()
        watchdog_t.start()

        proc.wait()
        stop_event.set()
        reader_t.join(timeout=5)
        watchdog_t.join(timeout=DISK_CHECK_INTERVAL_S + 2)

        if job.get('_cancel'):
            _finish_cancelled_or_stopped(job, staging)
            return

        if proc.returncode != 0:
            job['state'] = 'error'
            job['error'] = job.get('error') or f'aria2 exited with code {proc.returncode}'
            _cleanup_staging(staging)
            return

        job['state'] = 'importing'
        _begin_import(staging)
        failures = []
        try:
            results = _import_videos(jid, staging)
        except _ImportFailure as e:
            results, failures = e.results, e.failures
        job['rels'] = [r['rel'] for r in results]
        job['rel'] = max(results, key=lambda r: r['size'])['rel'] if results else None
        if failures:
            _import_failed(job, failures)
            return
        if not results:
            job['state'] = 'error'
            job['error'] = 'no video file >= min size found in torrent'
            _cleanup_staging(staging, force=True)
            return

        total_sz = sum(r['size'] for r in results)
        job['received'] = total_sz
        job['total'] = total_sz
        job['progress'] = 100
        job['state'] = 'ready'
        _cleanup_staging(staging, force=True)
    except Exception as e:
        importing = job.get('state') == 'importing'
        job['state'] = 'error'
        job['error'] = str(e)
        if not importing:
            _cleanup_staging(staging)
    finally:
        _publish_proc(job, None)
        with _LOCK:
            job['paused'] = False


def _run_sequential_files(jid: str, job: dict, aria2_bin: str, torrent_path: Path,
                           staging: Path, video_files: list) -> None:
    """Download a season pack ONE video file at a time via aria2c
    --select-file=<idx> (verified: every other file in the torrent is left as
    a 0-byte placeholder), importing and deleting each file immediately
    before starting the next, so peak staging stays ~one file instead of the
    whole pack. `video_files` is already filtered to qualifying video files
    and sorted by index -- see _should_sequential(). Manages job['state']/
    error/cleanup entirely itself; the caller (_run_job) just returns after
    calling this."""
    results = []
    for vf in video_files:
        # Cancellation must abort promptly BETWEEN files, not just during one.
        if job.get('_cancel'):
            job['rels'] = [r['rel'] for r in results]
            _finish_cancelled_or_stopped(job, staging)
            return

        # Real, current free space on the STAGING drive -- never trust the
        # torrent's declared size or the planning-time snapshot; a prior
        # file's cleanup (or anything else on the box) may have changed
        # things since. Same discipline as _admit_total()/the watchdog:
        # check REAL bytes right before committing to this file.
        free = _staging_free_bytes()
        if free - vf['size'] < STAGING_FREE_FLOOR_BYTES:
            job['rels'] = [r['rel'] for r in results]
            job['state'] = 'error'
            job['error'] = (f"insufficient staging space for {vf['path']} "
                             f"({vf['size']} bytes needed, {free} free)")
            _cleanup_staging(staging)
            return

        job['currentFile'] = vf['path']
        job['received'] = 0
        job['total'] = vf['size']
        job['progress'] = 0

        cmd = [
            aria2_bin, '--dir', str(staging),
            '--seed-time=0', '--bt-stop-timeout=1200', '--summary-interval=5',
            '--file-allocation=none', '--console-log-level=warn',
            f'--select-file={vf["index"]}',
            str(torrent_path),
        ]
        try:
            proc = subprocess.Popen(cmd, **_popen_kwargs())
        except Exception as e:
            job['rels'] = [r['rel'] for r in results]
            job['state'] = 'error'
            job['error'] = f'failed to start aria2 for {vf["path"]}: {e}'
            _cleanup_staging(staging)
            return
        _publish_proc(job, proc)

        stop_event = threading.Event()
        reader_t = threading.Thread(target=_stdout_reader, args=(jid, proc, stop_event),
                                     daemon=True, name=f'torrent-read-{jid[:8]}')
        watchdog_t = threading.Thread(target=_watchdog, args=(jid, proc, stop_event),
                                       daemon=True, name=f'torrent-wd-{jid[:8]}')
        reader_t.start()
        watchdog_t.start()

        proc.wait()
        stop_event.set()
        reader_t.join(timeout=5)
        watchdog_t.join(timeout=DISK_CHECK_INTERVAL_S + 2)
        _publish_proc(job, None)

        if job.get('_cancel'):
            job['rels'] = [r['rel'] for r in results]
            _finish_cancelled_or_stopped(job, staging)
            return

        if proc.returncode != 0:
            job['rels'] = [r['rel'] for r in results]
            job['state'] = 'error'
            job['error'] = job.get('error') or (
                f'aria2 exited with code {proc.returncode} on {vf["path"]}')
            _cleanup_staging(staging)
            return

        rel_path_str = vf['path'][2:] if vf['path'].startswith('./') else vf['path']
        file_path = staging / rel_path_str
        if not file_path.is_file():
            job['rels'] = [r['rel'] for r in results]
            job['state'] = 'error'
            job['error'] = f'expected file missing after download: {vf["path"]}'
            _cleanup_staging(staging)
            return

        job['state'] = 'importing'
        _begin_import(staging)
        error = 'could not move file into cache (check destination space and permissions)'
        try:
            r = _import_one_file(jid, file_path, staging)
        except Exception as e:
            r = None
            error = str(e)
        if r is None:
            job['rels'] = [rr['rel'] for rr in results]
            _import_failed(job, [{'path': vf['path'], 'error': error}])
            return

        (staging / _IMPORT_RETRY_MARKER).unlink()
        results.append(r)
        job['rels'] = [rr['rel'] for rr in results]
        job['filesDone'] = len(results)
        job['state'] = 'downloading'   # back to downloading for the next file

    if not results:
        job['state'] = 'error'
        job['error'] = 'no video file >= min size found in torrent'
        _cleanup_staging(staging)
        return

    job['rel'] = max(results, key=lambda r: r['size'])['rel']   # largest, single-item convenience
    total_sz = sum(r['size'] for r in results)
    job['received'] = total_sz
    job['total'] = total_sz
    job['progress'] = 100
    job['currentFile'] = None
    job['state'] = 'ready'
    _cleanup_staging(staging)


def add(source: str, name: Optional[str] = None, job_id: Optional[str] = None) -> dict:
    """Start a new torrent download. `source` is a magnet URI or an
    http(s) .torrent URL. Returns {'ok': True, 'id', 'state': 'queued'} or
    {'ok': False, 'status', 'error'}."""
    source = (source or '').strip()
    if not source:
        return {'ok': False, 'status': 400, 'error': 'missing source'}
    if not (source.startswith('magnet:') or source.startswith(('http://', 'https://'))):
        return {'ok': False, 'status': 400, 'error': 'source must be a magnet URI or http(s) .torrent URL'}

    if not _resolve_aria2():
        return {'ok': False, 'status': 500, 'error': f'aria2 binary not found ({ARIA2_BIN})'}

    if not _required_mount_ready():
        return {'ok': False, 'status': 503, 'error': 'remote cache filesystem is not mounted'}

    with _LOCK:
        _prune_terminal_jobs_locked()
        active = [j for j in _JOBS.values() if j['state'] in _ACTIVE_STATES]
        if len(active) >= MAX_CONCURRENT:
            return {'ok': False, 'status': 409, 'error': 'busy', 'state': 'busy', 'id': active[0]['id']}

        # A fresh deploy may not have created CACHE_ROOT yet (e.g. no seedr prefetch
        # has run before the first torrent add) -- shutil.disk_usage() requires the
        # path to exist, and _free_bytes() would otherwise silently read as 0 and
        # every add() would wrongly 507. Mirrors cache.reserve()'s own mkdir-first.
        try:
            cache.CACHE_ROOT.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            return {'ok': False, 'status': 500, 'error': f'cache root unavailable: {e}'}

        # Opportunistic reclaim before committing to a new download (cap-only pass,
        # same as cache.py's own periodic sweep) -- cheap and may buy floor headroom.
        if not REQUIRE_MOUNT:
            try:
                cache.cache_evict(protect_rel=cache.protected_rel())
            except Exception:
                pass
        if _free_bytes() < cache.FREE_FLOOR_BYTES:
            return {'ok': False, 'status': 507, 'error': 'insufficient free disk'}
        if _staging_free_bytes() < STAGING_FREE_FLOOR_BYTES:
            return {'ok': False, 'status': 507,
                    'error': 'insufficient free disk on torrent staging drive'}

        jid = (job_id or uuid.uuid4().hex[:16])
        job = {
            'id': jid, 'state': 'queued', 'name': (name if isinstance(name, str) and name else _derive_name(source)),
            'source': source, 'staging': str(STAGING_ROOT / jid),
            'received': 0, 'total': 0, 'progress': 0, 'error': None,
            'rel': None, 'rels': [], 'proc': None, '_cancel': False, '_user_cancelled': False,
            'paused': _GLOBAL_PAUSED.is_set(),
            # Sequential per-file mode only (see _run_sequential_files): stay at
            # their zero-ish defaults and are simply unused for a whole-torrent
            # job, so existing callers reading `status()` see no change there.
            'filesDone': 0, 'filesTotal': 0, 'currentFile': None,
            'created_at': time.time(),
        }
        _JOBS[jid] = job

    threading.Thread(target=_run_job, args=(jid,), daemon=True, name=f'torrent-{jid[:8]}').start()
    return {'ok': True, 'id': jid, 'state': 'queued'}


def status(job_id: str) -> dict:
    job = _JOBS.get(job_id)
    if job is None:
        return {'ok': False, 'id': job_id, 'state': 'unknown'}
    return {
        'ok': True, 'id': job['id'], 'state': job['state'], 'name': job['name'],
        'rel': job['rel'], 'rels': list(job['rels']),
        # In sequential mode, 'received'/'total'/'progress' describe the file
        # CURRENTLY in flight (filesTotal > 0 signals that -- a whole-torrent
        # job leaves filesTotal at 0 and these three keep their original,
        # whole-job meaning, unchanged for existing callers).
        'received': job['received'], 'total': job['total'], 'progress': job['progress'],
        'error': job['error'],
        'importFailures': list(job.get('importFailures', [])),
        'paused': bool(job.get('paused')),
        'filesDone': job.get('filesDone', 0), 'filesTotal': job.get('filesTotal', 0),
        'currentFile': job.get('currentFile'),
    }


def cancel(job_id: str) -> dict:
    job = _JOBS.get(job_id)
    if job is None:
        return {'ok': False, 'status': 404, 'error': 'unknown job'}
    job['_cancel'] = True
    job['_user_cancelled'] = True
    _kill_proc(job.get('proc'))
    return {'ok': True}


def pause_all() -> dict:
    """Idempotently pause every current/future aria2 child until resume_all.
    SIGSTOP is kernel-enforced, so it halts peer traffic and disk writes even
    while aria2 is resolving metadata."""
    paused = 0
    with _LOCK:
        _GLOBAL_PAUSED.set()
        for job in _JOBS.values():
            if job.get('state') not in _ACTIVE_STATES:
                continue
            job['paused'] = True
            if _pause_proc(job.get('proc')):
                paused += 1
    return {'ok': True, 'paused': True, 'processes': paused}


def resume_all() -> dict:
    """Resume every suspended child and allow newly-created children to run."""
    resumed = 0
    with _LOCK:
        _GLOBAL_PAUSED.clear()
        for job in _JOBS.values():
            if job.get('state') not in _ACTIVE_STATES:
                continue
            if _resume_proc(job.get('proc')):
                resumed += 1
            job['paused'] = False
    return {'ok': True, 'paused': False, 'processes': resumed}


def active_list() -> list:
    return [status(jid) for jid, j in list(_JOBS.items()) if j['state'] in _ACTIVE_STATES]


def _prune_terminal_jobs_locked() -> None:
    """Drop the oldest terminal (ready/error/aborted) job records beyond
    _MAX_TERMINAL_JOBS so _JOBS can't grow unbounded over a long uptime.
    Active jobs are always kept. Caller MUST hold _LOCK."""
    terminal = [(jid, j) for jid, j in _JOBS.items() if j.get('state') not in _ACTIVE_STATES]
    excess = len(terminal) - _MAX_TERMINAL_JOBS
    if excess <= 0:
        return
    terminal.sort(key=lambda kv: kv[1].get('created_at', 0))
    for jid, _j in terminal[:excess]:
        _JOBS.pop(jid, None)


def shutdown_all() -> None:
    """Cancel every active download and kill its aria2 child. Meant for a
    graceful server shutdown so no aria2 is left orphaned downloading into the
    staging dir. Idempotent and exception-safe."""
    try:
        with _LOCK:
            jobs = list(_JOBS.values())
    except Exception:
        return
    for j in jobs:
        try:
            if j.get('state') in _ACTIVE_STATES:
                j['_cancel'] = True
                j['_user_cancelled'] = True
                _kill_proc(j.get('proc'))
        except Exception:
            pass


# ===========================================================================
# Startup cleanup -- mirrors cache.cleanup_orphan_parts(): any staging dir
# surviving a restart is dead (in-memory _JOBS doesn't survive either).
# Import failures/incomplete imports carry a durable retry marker and must
# be kept, since these files already finished downloading.
# ===========================================================================

def cleanup_orphan_staging() -> None:
    if not _required_mount_ready():
        return
    if not STAGING_ROOT.exists():
        return
    for child in STAGING_ROOT.iterdir():
        # <cache>/.torrents/dashboard is the aria2 dashboard's own staging
        # root (its default config); its downloads outlive this engine.
        if child.name.lower() == 'dashboard':
            continue
        if child.is_dir() and (child / _IMPORT_RETRY_MARKER).exists():
            continue
        try:
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            else:
                child.unlink()
        except OSError:
            pass
