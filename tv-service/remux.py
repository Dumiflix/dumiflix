#!/usr/bin/env python3
"""
remux.py -- DumiFlix playback remux engine (stdlib only).

WHY THIS EXISTS
---------------
webOS TVs can only reliably decode a limited set of codec/container
combinations over HTTP. When a phone/usb/seedr source can't be played
directly, this module wraps ffmpeg to repackage it into a rolling
MPEG-TS HLS playlist that the TV can pull over LAN. VIDEO is stream-copied
unless the source bitrate exceeds the TV's RAM-safe ceiling. AUDIO keeps
AAC, AC-3, and E-AC-3 bit-for-bit in MPEG-TS; in particular, copying E-AC-3
is what preserves Dolby Digital Plus Atmos/JOC for eARC passthrough. DTS and
TrueHD are transcoded to AAC for compatibility with internal TV pipelines that cannot
emit them. `can_stream_copy()` therefore only gates on the VIDEO codec
(H.264/HEVC); any audio codec is accepted because unsupported audio still
has the AAC fallback. The MPEG-TS is written by the SEGMENT muxer with
mpegts_flags=+system_b (DVB tables) -- to support TV decoders that require DVB tables for audio routing.

The whole feature is optional and controlled by a client-persisted
"usePhoneRemux" toggle (a historical storage identifier retained for
compatibility), passed as `remuxEnabled` on `/playback/start`. When that's False,
this module does not touch ffmpeg at all -- it just gates access to a
raw Range-servable file (phone/usb) or hands back the existing signed
seedr URL untouched (the pre-existing direct-play path).

===========================================================================
HTTP SERVER ENDPOINT CONTRACT
===========================================================================

This module is transport-agnostic: it never touches `BaseHTTPRequestHandler`
directly. It hands back plain dicts / bytes / `pathlib.Path` objects; the
server is responsible for actually writing HTTP responses (headers, Range
handling via the existing `_stream_file` helper, JSON encoding via `_json`).

Suggested wiring, mirroring the existing `/cache/*` and `/files/stream/*`
prefix-dispatch style already used in `do_GET`/`do_POST`:

    # do_POST, near the /cache/fetch /cache/cancel /cache/del block:
    if path == '/playback/start':
        body = self._read_json() or {}
        result = remux.playback_start(body)
        code = 200 if 'error' not in result else result.get('status', 400)
        return self._json(code, result)

    if path.startswith('/playback/') and path.endswith('/seek'):
        sid = path.split('/')[2]
        body = self._read_json() or {}
        result = remux.playback_seek(sid, body)
        ...

    # do_GET, near the /music/stream/ block:
    if path.startswith('/playback/') and path.endswith('/master.m3u8'):
        sid = path.split('/')[2]
        data, mime = remux.get_playlist(sid)
        if data is None:
            return self._json(404, {'error': 'no such session or not ready'})
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        return

    if path.startswith('/playback/') and '/segments/' in path:
        sid = path.split('/')[2]
        seg = path.rsplit('/', 1)[-1]
        seg_path = remux.get_segment(sid, seg)
        if seg_path is None:
            return self._json(404, {'error': 'no such segment'})
        # segments are immutable once written -> cacheable
        return self._stream_file(seg_path)  # server should add:
        #   Content-Type: video/mp2t (remux.HLS_SEGMENT_MIME)
        #   Cache-Control: public, max-age=31536000, immutable

    if path.startswith('/playback/') and path.endswith('/file'):
        sid = path.split('/')[2]
        file_path = remux.get_direct_file(sid)
        if file_path is None:
            return self._json(404, {'error': 'no such session'})
        return self._stream_file(file_path, head_only=head_only)

Every one of the functions below that takes a `sid` looks it up against
the single live `SessionManager` instance and returns a clean "not found"
signal (`None` / `{'error': ..., 'status': 404}`) if the id doesn't match
the *currently active* session -- so a stale/replaced/expired session id
can never be used to reach another session's ffmpeg process or temp dir.
The session id itself (`secrets.token_urlsafe(32)`, ~256 bits) is the
capability token baked into every `/playback/{id}/...` URL; the server
should ADDITIONALLY apply whatever LAN-facing auth gate it already uses
for other endpoints (e.g. the `_cam_authed()`/`_cam_deny()` pair), but
even without that this module will refuse any id it didn't itself mint.

Function-by-function contract:

  playback_start(body: dict) -> dict
      body keys: sourceType ('seedr'|'phone'|'usb'), sourceReference (str),
                 remuxEnabled (bool), startTime (float seconds),
                 selectedVideoTrack (int|None), selectedAudioTrack (int|None)
      success -> {sessionId, playbackMode ('hls-remux'|'direct'), playbackUrl,
                  originalDuration, actualStartTime, videoCodec, audioCodec,
                  container}
      failure -> {'error': str, 'status': int}   (caller maps status -> HTTP code)
      NOTE: for sourceType == 'seedr' with remuxEnabled == False, sessionId
      is None and playbackUrl IS the original seedr URL -- this is the
      pre-existing direct-play path and deliberately bypasses session
      gating (a signed seedr URL is already unguessable and short-lived).

  playback_seek(sid: str, body: dict) -> dict
      body: {absoluteTime: float}. Kills the current ffmpeg generation and
      restarts at the nearest preceding keyframe. -> {'actualStartTime': float}
      or {'error': ..., 'status': ...}.

  playback_pause(sid: str) -> dict   -- SIGSTOPs ffmpeg (user-initiated).
  playback_resume(sid: str) -> dict  -- SIGCONTs ffmpeg.
  playback_delete(sid: str) -> dict  -- {'ok': bool}. Kills ffmpeg, rmtrees temp.
  playback_status(sid: str) -> dict  -- diagnostics, see RemuxSession.status().

  get_playlist(sid: str) -> (bytes | None, mime | None)
      Serve with Cache-Control: no-cache (the playlist mutates every segment).

  get_segment(sid: str, seg_name: str) -> pathlib.Path | None
      Validates seg_name against a strict `seg_NNNNN.ts` pattern (defends
      against path traversal) and marks it as fetched (drives backpressure
      + absolutePosition tracking). Caller streams the Path with Range
      support (e.g. the server's existing `_stream_file`). Segments are
      immutable once written -> safe to cache aggressively.

  get_direct_file(sid: str) -> pathlib.Path | None
      Only valid for a 'direct'-mode session (remux OFF, phone/usb source).
      Caller Range-streams this path directly; no ffmpeg involved.

All "success" dicts are plain JSON-serializable; the server should
`json.dumps()` them as-is.

MIME/type constants exported for the server's MIME table:
  HLS_PLAYLIST_MIME = 'application/vnd.apple.mpegurl'
  HLS_SEGMENT_MIME  = 'video/mp2t'

Time mapping (per product brief): a remux generation may start at a
keyframe BEFORE the requested position, so the player's own
`video.currentTime` resets to 0 at the start of every new generation.
The true position in the ORIGINAL movie is:

    absoluteMovieTime = sessionStartTime + video.currentTime

`sessionStartTime` is exactly `actualStartTime` as returned by
`playback_start`/`playback_seek` above. Progress bar, resume history,
subtitle cue timing, skip-intro/recap, next-episode, and all future
seeks must be computed against `absoluteMovieTime`, never the player's
raw `currentTime`.
"""

from __future__ import annotations

import collections
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Optional

# Windows compatibility gate. Every Windows-specific branch in this module
# is keyed off this flag; Unix hosts use the POSIX process-control path.
_IS_WIN = (os.name == 'nt')

__all__ = [
    'FFMPEG_BIN', 'FFPROBE_BIN', 'FF_ENV',
    'HLS_PLAYLIST_MIME', 'HLS_SEGMENT_MIME',
    'RemuxError',
    'ensure_ffmpeg_staged', 'probe', 'probe_cached', 'can_stream_copy',
    'cleanup_temp_root', 'reap_orphan_ffmpeg', 'shutdown_all',
    'RemuxSession', 'SessionManager',
    'playback_start', 'playback_seek', 'playback_pause', 'playback_resume',
    'playback_delete', 'playback_status', 'get_playlist', 'get_segment',
    'get_direct_file',
    'active_source_path',
]

# ===========================================================================
# Configurable ffmpeg / ffprobe locations and executable availability check.
# ===========================================================================

# TV build: ffmpeg/ffprobe are a self-contained static-musl armv7 binary
# bundled inside the webOS service (bin/ next to this file). No staging, no
# shared-lib path needed. Overridable via env for testing.
_SELF_DIR = os.path.dirname(os.path.abspath(__file__))
FFMPEG_BIN = os.environ.get('DUMIFLIX_FFMPEG', os.path.join(_SELF_DIR, 'bin', 'ffmpeg'))
FFPROBE_BIN = os.environ.get('DUMIFLIX_FFPROBE', os.path.join(_SELF_DIR, 'bin', 'ffprobe'))
# Static binary -> no LD_LIBRARY_PATH. SSL_CERT_DIR points the built-in openssl
# at the TV's CA store so the https protocol (seedr signed URLs) verifies TLS.
# On Windows the Linux path is wrong (and would BREAK TLS by overriding the
# system store the gnutls build reads by default), so we don't force it there;
# an explicit DUMIFLIX_SSL_CERT_DIR/FILE still wins on any platform.
FF_ENV = {}
_ssl_dir = os.environ.get('DUMIFLIX_SSL_CERT_DIR',
                          '' if os.name == 'nt' else '/etc/ssl/certs')
if _ssl_dir:
    FF_ENV['SSL_CERT_DIR'] = _ssl_dir
_ssl_file = os.environ.get('DUMIFLIX_SSL_CERT_FILE', '')
if _ssl_file:
    FF_ENV['SSL_CERT_FILE'] = _ssl_file

_stage_lock = threading.Lock()


def ensure_ffmpeg_staged() -> bool:
    """
    TV build: ffmpeg/ffprobe ship inside the webOS service package (bin/),
    so there is nothing to stage. Just confirm the bundled binaries exist
    and are executable. Never raises.
    """
    with _stage_lock:
        try:
            for b in (FFMPEG_BIN, FFPROBE_BIN):
                p = Path(b)
                if not p.exists():
                    return False
                try:
                    os.chmod(b, 0o755)
                except OSError:
                    pass  # read-only app dir is fine if the bit is already set
            return True
        except Exception:
            return False


class RemuxError(Exception):
    """Raised for any ffmpeg/ffprobe launch or probing failure."""
    pass


# ===========================================================================
# Probing + stream-copy compatibility check
# ===========================================================================

# Video/audio codecs that MPEG-TS containers can carry via stream copy.
# (H.264/HEVC video + AAC/AC-3/E-AC-3/MP2 audio are universally supported
# by TS muxers and webOS decoders; VP9/AV1/Opus/etc. cannot be losslessly
# repackaged into TS without transcoding, so they're rejected outright.)
_TS_VIDEO_CODECS_OK = frozenset({'h264', 'hevc'})
_TS_AUDIO_CODECS_OK = frozenset({'aac', 'ac3', 'eac3', 'mp2'})


def _redact_ref(source_ref: str) -> str:
    """
    Strip the query string off a URL before it's ever written to a log
    line or exception message -- seedr signed URLs carry auth in the
    query string and must never be logged in full. Local filesystem
    paths (phone/usb) pass through unchanged since they carry no secret.
    """
    try:
        if '://' in source_ref:
            return source_ref.split('?', 1)[0]
    except Exception:
        pass
    return source_ref


def probe(source_ref: str, timeout: float = 20.0) -> dict:
    """
    Run `ffprobe -print_format json -show_format -show_streams` against
    `source_ref` (a seedr signed URL, or a plain phone/usb filesystem
    path) and return a simplified summary:

        {
          'container': str | None,          # ffprobe format_name (raw, may be comma-joined)
          'duration': float | None,          # seconds
          'video_streams': [ {index, codec, width, height, profile}, ... ],
          'audio_streams': [ {index, codec, channels, language}, ... ],
          'video': video_streams[0] or None, # convenience: default/first video stream
          'audio': audio_streams[0] or None, # convenience: default/first audio stream
          'raw': <full ffprobe JSON>,        # kept for advanced callers (track listing UI etc.)
        }

    Raises RemuxError (never a bare subprocess exception) on any failure,
    with the source reference redacted in the message.
    """
    ensure_ffmpeg_staged()
    cmd = [
        FFPROBE_BIN, '-v', 'error',
        '-print_format', 'json',
        '-show_format', '-show_streams', '-show_chapters',
    ]
    # LOCAL-source speed tuning ONLY (see module notes on probe caching).
    # A local disk read has none of a remote seedr URL's network
    # latency/availability variance, so ffprobe's generous default analyze
    # ceiling (~5MB / ~5s -- sized for a live/damaged REMOTE stream) can be
    # safely tightened here: a well-formed file returns long before hitting
    # either ceiling regardless, so this only shortens a pathological worst
    # case, never the common one, and it's still generous (2MB/2s, not an
    # aggressive `0`/near-zero cut that risks mis-detecting duration/streams
    # on a variable or oddly-muxed file). A REMOTE source is completely
    # untouched -- same "local fast path, remote byte-for-byte unchanged"
    # split this file already uses for LOCAL_HLS_TIME_SECONDS etc.
    if _is_local_source(source_ref):
        cmd += ['-probesize', '2000000', '-analyzeduration', '2000000']
    cmd.append(source_ref)
    env = {**os.environ, **FF_ENV}
    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           encoding='utf-8', errors='replace',
                           timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        raise RemuxError(f'ffprobe timed out probing source ({_redact_ref(source_ref)})')
    except FileNotFoundError:
        raise RemuxError('ffprobe binary not found -- call ensure_ffmpeg_staged() first')

    if r.returncode != 0:
        # Keep the TAIL of stderr, not the head: ffprobe prints the (long,
        # signed) URL first and the verdict ("Server returned 403 Forbidden")
        # LAST, so a head-truncate used to cut off the only line that says
        # what actually went wrong.
        _serr = (r.stderr or r.stdout or '').strip()
        if len(_serr) > 300:
            _serr = '…' + _serr[-300:]
        raise RemuxError(f'ffprobe failed ({_redact_ref(source_ref)}): {_serr}')

    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError as e:
        raise RemuxError(f'ffprobe returned invalid JSON: {e}')

    fmt = data.get('format') or {}
    streams = data.get('streams') or []

    video_streams = []
    audio_streams = []
    for s in streams:
        codec_type = s.get('codec_type')
        if codec_type == 'video':
            # ffprobe reports mjpeg/png "video" streams for embedded cover
            # art on some containers; skip anything that's clearly a
            # single attached-pic frame so it doesn't get mistaken for the
            # real video track.
            if (s.get('disposition') or {}).get('attached_pic'):
                continue
            video_streams.append({
                'index': s.get('index'),
                'codec': s.get('codec_name'),
                'width': s.get('width'),
                'height': s.get('height'),
                'profile': s.get('profile'),
                # Usually absent in Matroska (the container carries only a
                # total). source_video_bitrate() falls back to
                # format.bit_rate minus the audio tracks when it's missing.
                'bit_rate': s.get('bit_rate'),
            })
        elif codec_type == 'audio':
            audio_streams.append({
                'index': s.get('index'),
                'codec': s.get('codec_name'),
                'channels': s.get('channels'),
                'language': (s.get('tags') or {}).get('language'),
                # Needed to back out the video bitrate from a container total
                # (DTS 5.1 is 1.5 Mbps of an 11 Mbps file -- not noise).
                'bit_rate': s.get('bit_rate'),
            })

    duration = None
    try:
        if fmt.get('duration') is not None:
            duration = float(fmt.get('duration'))
    except (TypeError, ValueError):
        duration = None

    return {
        'container': fmt.get('format_name'),
        'duration': duration,
        'video_streams': video_streams,
        'audio_streams': audio_streams,
        'video': video_streams[0] if video_streams else None,
        'audio': audio_streams[0] if audio_streams else None,
        'raw': data,
    }


def can_stream_copy(probe_info: dict, video_track: Optional[int] = None,
                     audio_track: Optional[int] = None) -> tuple:
    """
    Decide whether `probe_info` (as returned by probe()) can be
    repackaged into MPEG-TS HLS with pure stream copy.

    `video_track`/`audio_track`, if given, select which *logical* stream
    (0-indexed among video_streams / audio_streams respectively) to
    check -- matching the `selectedVideoTrack`/`selectedAudioTrack`
    request fields, which likewise index into the "Nth video/audio
    stream" space (ffmpeg's own `-map 0:v:N` addressing).

    Returns (True, '') if safe to stream-copy, or (False, reason) with a
    clear, user-facing explanation of exactly which codec is the
    problem -- callers MUST surface this as an "unsupported format"
    error rather than silently transcoding or silently falling back to
    direct playback.
    """
    video_streams = probe_info.get('video_streams') or []
    audio_streams = probe_info.get('audio_streams') or []

    if not video_streams:
        return False, 'no video stream found in source'

    vt = video_track if isinstance(video_track, int) and 0 <= video_track < len(video_streams) else 0
    vcodec = video_streams[vt].get('codec')
    if vcodec not in _TS_VIDEO_CODECS_OK:
        return False, (
            f'video codec {vcodec!r} cannot be stream-copied into MPEG-TS HLS '
            f'(supported: {sorted(_TS_VIDEO_CODECS_OK)})'
        )

    # AUDIO: no codec restriction. Unsupported input audio is transcoded, so we
    # always TRANSCODE the audio to AAC (see _launch) rather than stream-copy --
    # ffmpeg's full decoder set handles any source codec. The old TS-copy
    # whitelist would wrongly reject DTS/TrueHD and fall back to silent direct
    # playback. (No audio stream at all is fine too -- -map 0:a:N? just omits it.)

    return True, ''


# ===========================================================================
# HLS tuning constants (rolling-window remux, per product brief)
# ===========================================================================

HLS_TIME_SECONDS = 4            # target segment duration (smaller -> faster startup with -re)
# Segments the file-reaper keeps around the playhead (in 4s units; ~48s by
# default). A longer window can keep short seeks within buffered segments.
# Increase it only with sufficient disk-backed temporary storage; retain
# conservative limits when temporary storage consumes system RAM.
HLS_LIST_SIZE = int(os.environ.get('DUMIFLIX_REMUX_WINDOW_SEGMENTS') or 12)
_SEGMENT_SAFETY_MARGIN = 4      # extra segments tolerated on disk before we force-prune
                                 # (belt-and-suspenders on top of ffmpeg's own delete_segments)
# Bound segment bytes independently of segment count. A RAM-backed temp
# directory consumes system memory, so the default is a conservative 60 MB.
# Disk-backed hosts can configure a larger budget through the environment.
_BYTE_CAP_BYTES = int(os.environ.get('DUMIFLIX_REMUX_CAP_MB') or 60) * 1024 * 1024
_MIN_KEEP_SEGMENTS = 4          # never prune below this many, even under the byte cap (buffer floor)

_LEAD_LIMIT_SEGMENTS = HLS_LIST_SIZE     # producedSegment - consumedSegment beyond this -> SIGSTOP ffmpeg
_LEAD_RESUME_SEGMENTS = 4                # lead must drop to this (hysteresis) before SIGCONT

# --- Local-file fast-path tunables ----------------------------------------
# A local source (a local/USB path or disk-cache file -- see
# active_source_path()) can be lseek'd and read far faster than a
# remote seedr URL, so it's given a smaller target segment duration (faster
# first-playable-segment, since the segment muxer can only emit once a full
# segment is flushed) plus a "read burst" that lets ffmpeg mux the first
# few segments as fast as disk I/O allows before -re's real-time pacing
# resumes to protect the rolling window from a runaway-fast producer. A
# REMOTE (seedr) source is completely untouched -- both new env vars only
# apply when RemuxSession detects a non-http(s) source_ref (see
# RemuxSession.__init__ / _is_local_source below), so default behavior for
# every existing seedr/URL playback path is unchanged byte-for-byte.
LOCAL_HLS_TIME_SECONDS = float(os.environ.get('DUMIFLIX_REMUX_LOCAL_SEGMENT_SECONDS', '2'))
LOCAL_READRATE_INITIAL_BURST_SECONDS = float(os.environ.get('DUMIFLIX_REMUX_LOCAL_BURST_SECONDS', '6'))
# Every segment-COUNT window constant above (HLS_LIST_SIZE, _SEGMENT_SAFETY_
# MARGIN, _MIN_KEEP_SEGMENTS, _LEAD_LIMIT_SEGMENTS, _LEAD_RESUME_SEGMENTS) is
# implicitly defined in units of HLS_TIME_SECONDS (4s) segments -- e.g.
# HLS_LIST_SIZE=12 means "keep ~48s of rolling buffer". When a session uses
# a shorter LOCAL segment duration, RemuxSession scales those counts by the
# same ratio (see _scaled_window_counts) so the *time* window/backpressure
# budget they represent stays constant -- otherwise a smaller segment size
# would silently shrink the safety margin and worsen the "reaper deletes a
# not-yet-fetched segment" GOTCHA documented on _monitor_loop. For a REMOTE
# source the ratio is always 1.0, so this is a no-op there.

# Max output audio channels after transcode. Mono/stereo/5.1 are conservative
# compatibility targets; some TV pipelines cannot route 7.1 AAC and go silent.
# Higher channel counts are downmixed by ffmpeg's default -ac matrix.
# Raise this setting to 8 only when the playback device supports that layout.
MAX_AUDIO_CHANNELS = int(os.environ.get('DUMIFLIX_REMUX_MAX_AUDIO_CHANNELS', '6'))

# Preserve AC-3/E-AC-3 bitstreams in MPEG-TS for compatible TV/eARC pipelines.
# TrueHD/DTS use the AAC compatibility path. Disable passthrough for a
# TV/receiver combination that cannot decode the copied Dolby audio.
DOLBY_AUDIO_PASSTHROUGH = (
    os.environ.get('DUMIFLIX_REMUX_DOLBY_PASSTHROUGH', '1').strip().lower()
    not in ('0', 'false', 'no', 'off')
)

# --- Video bitrate ceiling (the webOS native-buffer OOM guard) ------------
# TV media pipelines may buffer ahead by time rather than bytes. At a 49s
# buffer depth, 6.18 Mbps pins roughly 38 MB, while 11 Mbps pins about 67 MB.
# A native demux/decode buffer can exhaust memory even with a flat JS heap;
# reducing the JS or server segment window alone will not fix that failure.
#
# Above MAX_SOURCE_VIDEO_BITRATE, encode down to TARGET_VIDEO_BITRATE rather
# than copying video. The conservative 6 Mbps default limits native-buffer
# pressure; adjust it for the memory budget of the target playback device.
MAX_SOURCE_VIDEO_BITRATE = int(os.environ.get('DUMIFLIX_REMUX_MAX_VIDEO_BITRATE', '6000000'))
TARGET_VIDEO_BITRATE = int(os.environ.get('DUMIFLIX_REMUX_TARGET_VIDEO_BITRATE', '5000000'))
# Try Intel Quick Sync first and software x264 as a portable fallback.
# Hardware encoders may be listed even with no usable GPU or matching driver;
# the runtime one-frame probe below verifies initialization before selection.
# Both choices are env-overridable for hosts with different hardware.
VIDEO_ENCODER = os.environ.get('DUMIFLIX_REMUX_VIDEO_ENCODER', 'h264_qsv')
VIDEO_ENCODER_FALLBACK = os.environ.get('DUMIFLIX_REMUX_VIDEO_ENCODER_FALLBACK', 'libx264')

_HEARTBEAT_TIMEOUT_SECONDS = 30.0        # no TV activity for this long -> watchdog closes the session
_MONITOR_INTERVAL_SECONDS = 1.0
_LAUNCH_READY_TIMEOUT_SECONDS = 8.0      # how long to wait for index.m3u8 to appear before declaring failure

# Temp root. /tmp can be RAM-backed on embedded hosts, so the byte cap above
# remains essential. Point DUMIFLIX_REMUX_TMP at disk-backed scratch storage
# when the host should keep segments off RAM or needs a different temp path.
REMUX_TEMP_ROOT = Path(os.environ.get('DUMIFLIX_REMUX_TMP', '/tmp/dumiflix_remux'))

HLS_PLAYLIST_MIME = 'application/vnd.apple.mpegurl'
HLS_SEGMENT_MIME = 'video/mp2t'

# '.ts' = the shipped MPEG-TS path (native <video> + HLS). '.m4s' = the fMP4
# fragments the MSE path needs -- MSE's byte-stream spec only defines ISO BMFF
# and WebM, so MPEG-TS cannot be fed to a SourceBuffer at all. Both share the
# seg_%05d numbering so every index-based consumer (window pruning,
# backpressure, the reaper) keeps working untouched across both modes.
_SEG_NAME_RE = re.compile(r'^seg_(\d{5})\.(?:ts|m4s)$')
# The fMP4 initialization segment (moov). Not numbered, fetched exactly once
# per session, and must be served alongside the fragments.
_INIT_NAME = 'init.mp4'

_LOG_PATH = os.environ.get('DUMIFLIX_REMUX_LOG', '/tmp/dumiflix-remux.log')


def source_video_bitrate(probe_info: dict, video_track: Optional[int] = None) -> Optional[int]:
    """
    Best-effort VIDEO bitrate in bits/sec for a probe() result, or None.

    Matroska almost never carries a per-stream bit_rate for video, so the
    workhorse path is (container total - every audio track's bitrate). That
    subtraction avoids overstating video bitrate when audio accounts for a
    significant share of the container bitrate.

    Returns None when nothing usable is present. Callers MUST treat None as
    "unknown" and leave the stream-copy path alone -- guessing wrong in the
    other direction would silently start re-encoding every file whose
    container omits a bitrate.
    """
    if not probe_info:
        return None
    vids = probe_info.get('video_streams') or []
    if video_track is not None:
        v = next((s for s in vids if s.get('index') == video_track), None)
    else:
        v = (probe_info.get('video') or (vids[0] if vids else None))
    # 1) an explicit per-stream number, when the container bothered to store one
    try:
        if v and v.get('bit_rate'):
            br = int(v['bit_rate'])
            if br > 0:
                return br
    except (TypeError, ValueError):
        pass
    # 2) container total minus the audio tracks
    try:
        total = int(((probe_info.get('raw') or {}).get('format') or {}).get('bit_rate'))
    except (TypeError, ValueError):
        return None
    if total <= 0:
        return None
    audio_bits = 0
    for a in (probe_info.get('audio_streams') or []):
        try:
            if a.get('bit_rate'):
                audio_bits += max(0, int(a['bit_rate']))
        except (TypeError, ValueError):
            continue
    est = total - audio_bits
    return est if est > 0 else total


_video_encoder_choice: Optional[str] = None
_video_encoder_lock = threading.Lock()


def _pick_video_encoder() -> str:
    """
    Return the first configured encoder that ACTUALLY opens on this host,
    resolved once per process and cached.

    `ffmpeg -encoders` listing an encoder proves only that it was compiled
    in, not that it can initialize -- SDK/driver mismatches can prevent
    h264_nvenc from starting, and h264_amf may be listed with no AMD GPU
    present. Discovering that at session-launch time would show
    up as a dead playback rather than a clean fallback, so probe it here
    with a throwaway 1-frame encode and remember the answer.
    """
    global _video_encoder_choice
    with _video_encoder_lock:
        if _video_encoder_choice:
            return _video_encoder_choice
        for enc in (VIDEO_ENCODER, VIDEO_ENCODER_FALLBACK):
            if not enc:
                continue
            try:
                r = subprocess.run(
                    [FFMPEG_BIN, '-nostdin', '-hide_banner', '-loglevel', 'error',
                     '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=0.04',
                     '-c:v', enc, '-frames:v', '1', '-f', 'null', '-'],
                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                    env={**os.environ, **FF_ENV}, timeout=30,
                )
                if r.returncode == 0:
                    _video_encoder_choice = enc
                    if enc != VIDEO_ENCODER:
                        _mlog('video encoder %r unavailable, using %r' % (VIDEO_ENCODER, enc))
                    return enc
                _mlog('video encoder %r failed to open: %s'
                      % (enc, (r.stderr or b'').decode('utf-8', 'replace').strip()[:300]))
            except Exception as e:
                _mlog('video encoder %r probe error: %s' % (enc, e))
        # Nothing opened. Return the fallback anyway so the caller produces a
        # real ffmpeg error instead of a confusing None.
        _video_encoder_choice = VIDEO_ENCODER_FALLBACK or VIDEO_ENCODER
        return _video_encoder_choice


def _mlog(msg: str) -> None:
    """Best-effort append log (the service discards python stdout). Surfaces
    reaper-thread errors that would otherwise be invisible."""
    try:
        with open(_LOG_PATH, 'a') as f:
            f.write(msg.rstrip() + '\n')
    except Exception:
        pass


def _dir_bytes(files) -> int:
    total = 0
    for f in files:
        try:
            total += f.stat().st_size
        except OSError:
            pass
    return total


def reap_orphan_ffmpeg() -> int:
    """
    Kill any ffmpeg still writing into REMUX_TEMP_ROOT left over from a
    PREVIOUS, uncleanly-killed server run.

    Each ffmpeg generation has its own process group and can survive an
    abrupt server exit. Without the server's monitor thread, an orphan can
    keep writing segments without pruning. This exhausts storage and can
    exhaust system RAM when REMUX_TEMP_ROOT is backed by tmpfs. Stop the
    writer before cleanup_temp_root() deletes its files.

    Best-effort and stdlib-only: use /proc where available, otherwise ps on
    POSIX hosts or wmic on Windows. Match only ffmpeg whose command line references
    our own REMUX_TEMP_ROOT, so an unrelated ffmpeg on the device is never
    touched. Returns the number of processes signalled.
    """
    root = str(REMUX_TEMP_ROOT)
    killed = 0
    if _IS_WIN:
        # Match the configured temp root in the command line before taskkill.
        # Skip best-effort cleanup when wmic is unavailable.
        try:
            out = subprocess.run(
                ['wmic', 'process', 'where', "name='ffmpeg.exe'",
                 'get', 'ProcessId,CommandLine', '/format:csv'],
                capture_output=True, text=True,
                encoding='utf-8', errors='replace', timeout=10).stdout
            for line in out.splitlines():
                if root in line:
                    parts = line.rsplit(',', 1)
                    pid = parts[-1].strip()
                    if pid.isdigit():
                        subprocess.run(['taskkill', '/F', '/T', '/PID', pid],
                                       capture_output=True)
                        killed += 1
        except Exception:
            pass
        if killed:
            _mlog('reaped %d orphan ffmpeg from a prior run' % killed)
        return killed

    # Prefer /proc on Linux and embedded webOS hosts, where `ps` may
    # provide limited process details. Fall back to `ps` on hosts without
    # /proc, such as macOS and BSD.
    if os.path.isdir('/proc'):
        killed = _reap_ffmpeg_via_proc(root)
    else:
        killed = _reap_ffmpeg_via_ps(root)
    if killed:
        _mlog('reaped %d orphan ffmpeg from a prior run' % killed)
    return killed


def _kill_pid_group(pid: int) -> bool:
    """SIGKILL a pid's whole process group (ffmpeg is launched setsid), falling
    back to the bare pid. Returns True if a signal was delivered."""
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
        return True
    except Exception:
        try:
            os.kill(pid, signal.SIGKILL)
            return True
        except Exception:
            return False


def _reap_ffmpeg_via_proc(root: str) -> int:
    killed = 0
    self_pid = os.getpid()
    try:
        entries = os.listdir('/proc')
    except OSError:
        return 0
    for entry in entries:
        if not entry.isdigit():
            continue
        pid = int(entry)
        if pid == self_pid:
            continue
        try:
            with open('/proc/%s/cmdline' % entry, 'rb') as f:
                raw = f.read()
        except Exception:
            continue
        if not raw:
            continue
        args = raw.split(b'\x00')
        exe = os.path.basename(args[0].decode('utf-8', 'replace')) if args and args[0] else ''
        cmd = raw.decode('utf-8', 'replace')
        # Must be an ffmpeg AND reference OUR temp root (the segment output
        # path REMUX_TEMP_ROOT/<sid>/seg_%05d.ts is always in its argv). Both
        # conditions guard against ever killing an unrelated device ffmpeg.
        if 'ffmpeg' not in exe or root not in cmd:
            continue
        if _kill_pid_group(pid):
            killed += 1
    return killed


def _reap_ffmpeg_via_ps(root: str) -> int:
    killed = 0
    self_pid = os.getpid()
    out = ''
    for cmd in (['ps', '-Ao', 'pid=,command='], ['ps', 'ax', '-o', 'pid=,command=']):
        try:
            out = subprocess.run(cmd, capture_output=True, text=True,
                                 encoding='utf-8', errors='replace', timeout=10).stdout
            if out:
                break
        except Exception:
            continue
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2 or not parts[0].isdigit():
            continue
        pid = int(parts[0])
        cmdline = parts[1]
        if pid == self_pid:
            continue
        toks = cmdline.split()
        exe = os.path.basename(toks[0]) if toks else ''
        # Same two-condition guard as the /proc path: an ffmpeg referencing our
        # own temp root, never an unrelated ffmpeg.
        if 'ffmpeg' not in exe or root not in cmdline:
            continue
        if _kill_pid_group(pid):
            killed += 1
    return killed


def cleanup_temp_root() -> None:
    """Remove leftover session directories once at server startup.
    Reap orphan ffmpeg processes first so surviving writers cannot refill
    the directories during cleanup, including on RAM-backed storage."""
    try:
        reap_orphan_ffmpeg()
    except Exception:
        pass
    try:
        if REMUX_TEMP_ROOT.exists():
            for child in list(REMUX_TEMP_ROOT.iterdir()):
                try:
                    if child.is_dir():
                        shutil.rmtree(child, ignore_errors=True)
                    else:
                        child.unlink()
                except Exception:
                    pass
    except Exception:
        pass


def shutdown_all() -> None:
    """Close the currently-active session (kills its ffmpeg process group and
    frees its temp dir) and WAIT for that teardown to finish. Idempotent and
    exception-safe -- meant to be called from a server SIGTERM/SIGINT
    handler / atexit hook so a graceful stop never leaves an ffmpeg
    orphaned writing into temporary storage. A no-op when nothing is playing.

    Deliberately calls close_current_blocking(), NOT close_current(): the
    latter (used on the hot playback_start path, see SessionManager.
    _close_current_locked) detaches and tears down in the BACKGROUND so a
    new session never waits on the old one's up-to-~10s kill/join/rmtree
    chain -- exactly wrong for a process that's about to exit, which must
    actually wait or risk orphaning ffmpeg with nothing left alive to prune
    it (an unclean `kill -9` is still covered on the NEXT startup by
    cleanup_temp_root() -> reap_orphan_ffmpeg(), but a clean stop should
    never need that safety net)."""
    try:
        _manager.close_current_blocking()
    except Exception:
        pass


def _new_temp_dir(session_id: str) -> Path:
    REMUX_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
    d = REMUX_TEMP_ROOT / session_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def _read_rss_bytes(pid: int) -> Optional[int]:
    """Best-effort resident memory of an ffmpeg child, via /proc/<pid>/status."""
    try:
        with open(f'/proc/{pid}/status', 'r') as f:
            for line in f:
                if line.startswith('VmRSS:'):
                    kb = int(line.split()[1])
                    return kb * 1024
    except Exception:
        return None
    return None


def _segment_files(temp_dir) -> list:
    """Every media segment in a session temp dir, in index order, for EITHER
    container.

    This existed inline as `glob('seg_*.ts')` in two places. That hardcoded
    '.ts' is silently catastrophic for the fMP4 path: the monitor loop counts
    segments and bytes to drive window pruning, the byte cap and producer
    backpressure, so a glob that matches nothing means it believes the session
    has produced NOTHING and prunes nothing -- i.e. exactly the unbounded
    temp-dir growth the whole bounded-window architecture exists to prevent.
    Caught on the first fMP4 run: playlist listed fragments, status reported
    producedSegment=-1 / cachedBytes=0.

    Filtering through _SEG_NAME_RE (rather than a looser glob) keeps the
    strict seg_NNNNN naming contract that index parsing depends on, and
    excludes init.mp4, which is not a numbered media segment and must never
    be pruned as one.
    """
    try:
        return sorted((p for p in temp_dir.glob('seg_*') if _SEG_NAME_RE.match(p.name)),
                      key=lambda p: p.name)
    except Exception:
        return []


def _max_segment_index(files) -> int:
    best = -1
    for f in files:
        m = _SEG_NAME_RE.match(f.name)
        if m:
            best = max(best, int(m.group(1)))
    return best


def _measure_seek_landing(source_ref: str, target_time: float,
                          timeout: float = 8.0,
                          reason_out: Optional[list] = None) -> Optional[float]:
    """Ask FFMPEG ITSELF where `-ss target_time` lands: copy a single packet
    per stream with -copyts and read the absolute timestamp back. This is
    the reliable measurement for sources with broken HEVC picture order
    where ffprobe's interval seek can land at a different GOP from ffmpeg's
    own -ss. Reporting that estimate as actualStartTime can skew subtitle
    cues, the seek bar, and resume positions.

    Reads the landing back at PACKET level (min `pts_time` across every
    packet the micro-extraction produced), not `format=start_time`:
    Some ffprobe builds omit format-level start_time for a single-packet
    Matroska extraction while still reporting packet timestamps. Packet
    PTS avoids an unnecessary keyframe-scan fallback on those builds;
    format=start_time is kept as a
    cheap compat fallback for an ffprobe build that returns no packets at
    all.

    Returns None on any failure (caller falls back to the ffprobe-based
    estimate). If `reason_out` is given, a short failure reason is
    appended to it so the caller can log WHY, not just that it failed."""
    out = None
    reason = 'unknown failure'
    try:
        fd, out = tempfile.mkstemp(suffix='.mkv', prefix='dumiflix_landing_')
        os.close(fd)
        env = {**os.environ, **FF_ENV}
        cmd = [
            FFMPEG_BIN, '-nostdin', '-hide_banner', '-loglevel', 'error',
            '-noaccurate_seek', '-ss', str(target_time), '-i', source_ref,
            '-map', '0:v:0?', '-map', '0:a:0?',
            '-frames:v', '1', '-frames:a', '1',
            '-c', 'copy', '-copyts',
            '-y', '-f', 'matroska', out,
        ]
        ff = subprocess.run(cmd, capture_output=True, timeout=timeout, env=env)
        pr = subprocess.run(
            [FFPROBE_BIN, '-v', 'error', '-show_entries', 'packet=pts_time',
             '-of', 'json', out],
            capture_output=True, text=True, encoding='utf-8', errors='replace',
            timeout=timeout, env=env)
        times = []
        for pkt in (json.loads(pr.stdout or '{}').get('packets') or []):
            if not isinstance(pkt, dict):
                continue
            try:
                times.append(float(pkt.get('pts_time')))
            except (TypeError, ValueError):
                continue
        if times:
            t = min(times)
            if 0.0 <= t <= target_time + 0.001:
                return t
            reason = 'packet landing %.3f out of range for target %.3f' % (t, target_time)
        else:
            # COMPAT FALLBACK: no packets reported at all -- try the old
            # format-level read before giving up (cheap; only hit when the
            # packet probe already came back empty).
            pr2 = subprocess.run(
                [FFPROBE_BIN, '-v', 'error', '-show_entries', 'format=start_time',
                 '-of', 'json', out],
                capture_output=True, text=True, encoding='utf-8', errors='replace',
                timeout=timeout, env=env)
            st = (json.loads(pr2.stdout or '{}').get('format') or {}).get('start_time')
            try:
                t = float(st)
            except (TypeError, ValueError):
                t = None
            if t is not None and 0.0 <= t <= target_time + 0.001:
                return t
            errtail = (ff.stderr or b'').decode('utf-8', 'replace').strip()
            if len(errtail) > 160:
                errtail = errtail[-160:]
            reason = 'no packets; ffmpeg rc=%s stderr tail: %s' % (ff.returncode, errtail)
    except Exception as e:
        reason = '%s: %s' % (type(e).__name__, str(e)[:160])
    finally:
        if out:
            try:
                os.unlink(out)
            except OSError:
                pass
    if reason_out is not None:
        reason_out.append(reason)
    return None


def _find_preceding_keyframe(source_ref: str, target_time: float,
                              window_seconds: float = 30.0, timeout: float = 12.0) -> float:
    """Thin caching wrapper around _find_preceding_keyframe_impl (P3-lite,
    seek cache): read-before-measure against the SAME per-file
    sidecar store probe_cached() uses, keyed by this source file's identity
    (_probe_key) plus a whole-second bucket of `target_time` (_seek_bucket
    -- the true landing is itself a GOP/keyframe boundary, so a
    fraction-of-a-second-different repeat request resolves to the same
    answer in practice).

    On a miss this delegates to _find_preceding_keyframe_impl UNCHANGED --
    every measurement method, fallback order, and the documented
    ffprobe-vs-ffmpeg landing disagreement (see that function's docstring
    below) is preserved exactly. This wrapper only ever SKIPS the whole
    cascade on a hit or RECORDS its final answer on a miss -- it never
    substitutes a different measurement or a different method."""
    target_time = max(0.0, target_time)
    if target_time == 0.0:
        return 0.0
    src_key = _probe_key(source_ref)
    bucket = _seek_bucket(target_time) if src_key is not None else None
    if src_key is not None:
        cached = _landing_cache_get(src_key, bucket)
        if cached is not None:
            return cached
    landing = _find_preceding_keyframe_impl(source_ref, target_time, window_seconds, timeout)
    if src_key is not None:
        _landing_cache_put(src_key, bucket, landing)
    return landing


def _find_preceding_keyframe_impl(source_ref: str, target_time: float,
                                   window_seconds: float = 30.0, timeout: float = 12.0) -> float:
    """
    Best-effort lookup of the nearest video keyframe at-or-before
    `target_time`, by asking ffprobe for keyframe presentation
    timestamps in a [target-window, target] interval (using
    `-read_intervals` so this seeks rather than scanning the whole
    file -- fast even for large seedr sources).

    This is what lets us report an honest `actualStartTime` even though
    ffmpeg's own `-ss` (before `-i`) seek is *already* keyframe-accurate
    on its own -- we independently re-derive the same keyframe boundary
    so the number we report to the client matches what ffmpeg actually
    did, without having to scrape ffmpeg's stderr for timestamps.

    _launch() below feeds the RETURN VALUE of this function straight to
    ffmpeg as `-ss` (not the raw requested time) -- so whatever we return
    here is where ffmpeg genuinely starts producing output, not just what
    we report. That makes the old single-window fallback an actual
    correctness bug, not just an honesty shortfall: some encodes (e.g. a
    scene-cut-only GOP over long static shots -- common on certain x265 web
    rips) can have NO keyframe within the first `window_seconds` behind
    `target_time`. Silently returning `target_time` unmodified in that case
    made ffmpeg start playback exactly at that (non-keyframe) point, and
    ffmpeg's segment muxer resets output PTS to ~0 there -- so the
    session's `actualStartTime` (== `target_time`) permanently disagreed
    with the real content position by however far back the true GOP
    boundary actually was, silently well beyond a few seconds. Every
    absolute-time consumer downstream (sessionStartTime + video.currentTime:
    subtitle cues, seek bar, resume) inherits that gap as a constant skew.
    Retry with a doubling window (bounded by `timeout`) before giving up,
    so a real sparse-GOP gap is still found instead of misreported.
    """
    target_time = max(0.0, target_time)
    if target_time == 0.0:
        return 0.0

    # PRIMARY: ffmpeg's own landing (see _measure_seek_landing) -- the only
    # measurement guaranteed to match what _launch()'s `-ss` will really do.
    # One retry: a transiently-busy host (live transcode + thumbnails) can
    # time the first attempt out, and silently falling back to the ffprobe
    # scan is exactly the GOP-off subtitle skew this measurement exists to
    # prevent -- so a fallback is LOGGED, never silent.
    _landing_reasons = []
    measured = _measure_seek_landing(source_ref, target_time, reason_out=_landing_reasons)
    if measured is None:
        measured = _measure_seek_landing(source_ref, target_time, reason_out=_landing_reasons)
    if measured is not None:
        return measured
    _mlog('landing-measure failed twice for t=%.3f (%s) -- %s -- falling back to '
          'keyframe scan; subtitle clock may skew by up to one GOP'
          % (target_time, _redact_ref(source_ref),
             _landing_reasons[-1] if _landing_reasons else 'no reason captured'))

    deadline = time.monotonic() + timeout

    # FALLBACK 1: measure where the DEMUXER actually lands for a seek to
    # `target_time`. `-read_intervals '<target>%'` performs the exact same
    # avformat-level seek that `-ss <target>` performs at launch, and with
    # -skip_frame nokey the first frames listed are the keyframes decoded
    # from that landing point. On a healthy file this equals the nearest
    # keyframe <= target (same value the window-scan below finds). But on a
    # damaged index -- e.g. x265 web rips with broken POC ordering, where a
    # window-scan lists IRAP frames the demuxer can NOT actually land on --
    # the two DISAGREE by a whole GOP (10s+ on long-GOP rips): ffmpeg
    # really started a GOP earlier than the reported actualStartTime, and
    # every absolute-time consumer (subtitle cues, seek bar, resume)
    # inherited that gap as a constant skew -- user-visible as "subs way
    # out of sync after resume/seek". The landing measurement is the
    # truth; the window-scan below remains only as a fallback.
    try:
        remaining = deadline - time.monotonic()
        # PACKET-level (not frame-level) probe, deliberately: on a damaged
        # file the demuxer can land at a cluster that contains NO keyframe
        # at all -- decode (and any frame-level listing) only reports from
        # the next IRAP, a whole GOP later, while the actual DEMUXED
        # packets (and crucially the AUDIO the TV hears) start at the
        # landing. Packets are the only view that can't lie about where
        # `-ss` really begins.
        cmd = [
            FFPROBE_BIN, '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'packet=pts_time,dts_time',
            '-read_intervals', f'{target_time}%+#24',
            '-of', 'json',
            source_ref,
        ]
        env = {**os.environ, **FF_ENV}
        r = subprocess.run(cmd, capture_output=True, text=True,
                           encoding='utf-8', errors='replace',
                           timeout=max(1.0, min(remaining, timeout)), env=env)
        parsed = json.loads(r.stdout or '{}')
        landing = []
        for pkt in (parsed.get('packets') or []):
            if not isinstance(pkt, dict):
                continue
            ts = pkt.get('pts_time')
            if ts is None:
                ts = pkt.get('dts_time')
            try:
                t = float(ts)
            except (TypeError, ValueError):
                continue
            landing.append(t)
        # min over the first packets <= target: packets arrive in decode
        # order (out of presentation order on B-frame/broken-POC content),
        # so "first listed" is unreliable but the minimum is the landing.
        cand = [t for t in landing if t <= target_time + 0.001]
        if cand:
            return min(cand)
    except Exception:
        pass

    w = window_seconds
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0.5:
            break
        lo = max(0.0, target_time - w)
        cmd = [
            FFPROBE_BIN, '-v', 'error',
            '-skip_frame', 'nokey',
            '-select_streams', 'v:0',
            '-show_entries', 'frame=pts_time',
            '-read_intervals', f'{lo}%{target_time}',
            '-of', 'json',
            source_ref,
        ]
        env = {**os.environ, **FF_ENV}
        try:
            r = subprocess.run(cmd, capture_output=True, text=True,
                                encoding='utf-8', errors='replace',
                                timeout=min(remaining, timeout), env=env)
            # Parse structured JSON rather than `-of csv=p=0`: the csv writer
            # unconditionally trails every line with a field separator even
            # for this single-field (pts_time) selection -- e.g.
            # "1226.016000," not "1226.016000" -- which once made float()
            # raise on every single line (silently defeating the whole
            # keyframe landing measurement). JSON's `pts_time` field
            # is a plain quoted number with no such footgun, and each value
            # is still explicitly float()-verified below before use, so a
            # future ffprobe formatting change fails closed (skipped line)
            # instead of silently reporting a wrong keyframe.
            times = []
            try:
                parsed = json.loads(r.stdout or '{}')
            except (ValueError, TypeError):
                parsed = {}
            for frame in (parsed.get('frames') or []):
                pts = frame.get('pts_time') if isinstance(frame, dict) else None
                if pts is None:
                    continue
                try:
                    t = float(pts)
                except (TypeError, ValueError):
                    continue
                times.append(t)
            at_or_before = [t for t in times if t <= target_time]
            if at_or_before:
                return max(at_or_before)
            if times:
                return min(times)
        except Exception:
            pass
        if lo <= 0.0:
            break   # already widened back to the start of the file -- nothing more to find
        w *= 4
    return target_time


def _map_args(video_track: Optional[int], audio_track: Optional[int]) -> list:
    """
    Build the `-map` pair for the selected logical video/audio stream.
    `0:v:N?`/`0:a:N?` select the Nth video/audio stream of input 0
    (ffmpeg's own stream-specifier indexing, 0-based within each type),
    with the trailing `?` making the map optional so a source with no
    audio (or a track index that doesn't exist) doesn't hard-fail ffmpeg.
    """
    vt = video_track if isinstance(video_track, int) and video_track >= 0 else 0
    at = audio_track if isinstance(audio_track, int) and audio_track >= 0 else 0
    return ['-map', f'0:v:{vt}?', '-map', f'0:a:{at}?']


def _is_local_source(source_ref: str) -> bool:
    """True when `source_ref` is a local filesystem path rather than a
    remote (seedr) URL. Every http(s) source today is 'seedr'; every
    non-URL source_ref is already validated elsewhere (playback_start) to
    be an absolute local path -- phone/usb today, and the natural
    integration seam (active_source_path()) for a laptop disk-cache file
    tomorrow. Deriving this from the string itself, rather than from
    source_type, means the local fast-path below works for ANY future
    local-file source_type without remux.py needing to know its name."""
    return not source_ref.startswith(('http://', 'https://'))


_CACHE_STREAM_RE = re.compile(r'/cache/stream/([^?]+)')


def _resolve_self_cache_ref(source_ref: str) -> str:
    """
    If `source_ref` is THIS SAME SERVER's own /cache/stream/<name> URL (the
    TV asking us to play back a file we already hold on local disk -- e.g.
    a torrent/cache-fetched cache item), rewrite it to the local CACHE_ROOT
    filesystem path instead of leaving it as an http(s) URL. Without this,
    probe()/every seek's keyframe lookup/the ffmpeg -i arg all fetch the
    file back over HTTP from ourselves -- a pointless self-loopback that's
    especially slow on a power-trimmed host -- AND it silently defeats
    _is_local_source()'s fast-path tuning below (LOCAL_HLS_TIME_SECONDS,
    -readrate_initial_burst), which only ever activates for a local
    source_ref.

    Mirrors subsync.py's identical rewrite in handle_subsync(), but resolves
    through cache._safe_resolve() (traversal-safe: rejects '..'/absolute/
    symlink escapes) rather than a raw CACHE_ROOT/unquote join.

    No-op (returns source_ref unchanged) when: the string doesn't match the
    /cache/stream/ pattern (every seedr/phone/usb source_ref that ISN'T our
    own cache URL, i.e. the overwhelming common case), `cache` isn't
    importable (TV/phone builds never ship cache.py -- this whole rewrite is
    then permanently dead code, exactly as intended), or the resolved local
    file doesn't actually exist on disk (fail safe back to the HTTP fetch
    rather than hand ffmpeg a path that 404s).
    """
    m = _CACHE_STREAM_RE.search(source_ref)
    if not m:
        return source_ref
    try:
        import cache  # sibling; present only on cache-enabled hosts (see server.py CACHE_ENABLED)
        import urllib.parse as _up
        local = cache._safe_resolve(_up.unquote(m.group(1)))
        if local.is_file():
            return str(local)
    except Exception:
        pass
    return source_ref


def _resolve_cached_copy(source_ref: str) -> str:
    """
    If `source_ref` is a REMOTE http(s) URL naming a file this host ALREADY
    holds COMPLETE in its local cache, play the local copy instead.

    Distinct from _resolve_self_cache_ref above, which only rewrites OUR OWN
    /cache/stream/ URLs. A remote URL may name a release already downloaded
    into the cache; reusing the completed file avoids a redundant HTTPS fetch.

    Remote sources can be rate-limited and signed URLs can expire. Each seek
    reopens the source, so repeated seeks can otherwise trigger HTTP 429 or a
    truncated stream. Local playback removes those network failure modes and
    enables the same local-source tuning as the rewrite above.

    Matching is on the URL's final path segment, because seedr and the cache
    both use the release filename verbatim -- these names carry group,
    quality and episode, so a false positive would need two genuinely
    different files with an identical release name.

    PERFORMANCE: consult the listing index first and verify the matched file
    with one stat(). Recursive directory walks can be slow on cold external
    drives. The index is event-driven, so rechecking existence prevents an
    entry evicted after the last rebuild from becoming a dead ffmpeg path.
    Fall back to a directory walk only when no index has ever been built,
    never on an ordinary miss; new titles must remain cheap to look up.

    SAFETY: both the index and the slow-walk fallback are built from
    cache.cache_files()/cache.listing_files(), which list ONLY finished
    files -- '*.part' and any dot-prefixed staging subtree (torrent.py
    writes in-flight downloads under .torrents/) are excluded. So a
    partially downloaded copy can never be substituted for a complete
    remote source. Zero-byte entries are rejected too.

    No-op on: non-http refs (phone/usb paths), hosts without cache.py
    (TV/phone builds never ship it), and any name with no exact match.
    """
    if not source_ref.lower().startswith(('http://', 'https://')):
        return source_ref
    try:
        import cache  # sibling; cache-enabled hosts only
        import urllib.parse as _up
        path = _up.urlparse(source_ref).path or ''
        name = _up.unquote(path.rsplit('/', 1)[-1]).strip()
        # A too-short/degenerate tail (e.g. a URL ending in '/') is never a
        # real release filename -- bail rather than risk a loose match.
        if len(name) < 5:
            return source_ref

        listing = cache._read_listing()
        if listing is not None:
            # FAST PATH: the index already exists -- this is every call
            # after the very first one on a given cache. Matches the SAME
            # two candidates the slow walk below checks (the on-disk rel's
            # own basename, which equals `name` only in un-hashed LAN mode;
            # and the recorded original filename, which is what matches in
            # the default hashed-filename cache mode).
            for entry in listing:
                rel = entry.get('rel') or ''
                rel_base = rel.rsplit('/', 1)[-1]
                if rel_base != name and entry.get('name') != name:
                    continue
                try:
                    target = cache._safe_resolve(rel)
                except PermissionError:
                    continue
                if target.is_file():   # single stat -- staleness guard against a rebuild-lagged index
                    return str(target)
                # Stale index entry (evicted since the index was last built).
                # NOT a cue to fall back to the slow walk -- a re-walk right
                # now would almost certainly find nothing either, since the
                # file is genuinely gone. Keep scanning in case of another
                # (unlikely) matching entry, otherwise fall through exactly
                # like a genuine miss.
            return source_ref

        # SLOW FALLBACK: no index has EVER been built for this cache (a
        # fresh install, or the very first lookup before anything primed
        # .listing.json). This is the ONLY case that pays the honest walk --
        # the exact loop this function used before this fix, preserved
        # verbatim so a brand-new cache's first lookup still matches ANY
        # extension (not just the video-only subset listing_files() serves)
        # and any non-video match keeps working exactly as before.
        # cache.listing_files() is called first purely for its side effect
        # (it builds + persists .listing.json when missing), so this slow
        # branch is paid AT MOST ONCE per cache lifetime -- every later
        # call, including the very next play, takes the fast path above.
        try:
            cache.listing_files()
        except Exception:
            pass
        for p, size, _mtime in cache.cache_files():
            if size <= 0:
                continue
            if p.name == name:
                return str(p)
            try:
                rel = str(p.relative_to(cache.CACHE_ROOT)).replace('\\', '/')
            except Exception:
                continue
            # The cache sanitizes filenames on write, so the on-disk name can
            # differ from the original; .names.json keeps the real one.
            if cache.display_name(rel) == name:
                return str(p)
    except Exception:
        pass
    return source_ref


# ===========================================================================
# probe() caching + seek-landing caching --
# an in-process memo backed by a persistent per-file sidecar, so a repeat
# play OR a repeat/nearby seek of the SAME file never re-pays the ffprobe
# (probe()) / ffmpeg+ffprobe cascade (_find_preceding_keyframe_impl) that
# produced the answer the first time. Both caches share ONE JSON blob per
# source file (see _sidecar_* below) since they're both keyed off the same
# "given this file, what did we already learn" identity.
# ===========================================================================

def _probe_key(source_ref: str) -> Optional[str]:
    """Stable identity string for a source file, used as the cache key for
    BOTH the probe cache and the seek-landing cache below. Returns None
    when no safe/stable key can be derived -- callers MUST treat that as
    "don't cache this lookup" rather than caching under a degenerate key.

    MUST be invariant across a re-minted seedr signed URL for the SAME
    underlying file: the app re-fetches a fresh signed URL (fresh
    token/expiry query string) every time it plays or resumes an item,
    even when the file itself hasn't changed at all -- keying on the raw
    source_ref would make every single play look like a brand-new,
    never-seen file and defeat this cache entirely.

      - LOCAL (already resolved to a filesystem path by
        _resolve_self_cache_ref/_resolve_cached_copy, or a genuine
        phone/usb path): keyed by the resolved absolute path PLUS
        (size, mtime) from a single stat() -- fully known up front, so a
        lookup and a later write use the IDENTICAL key, and a file
        replaced at the same path (re-fetch after eviction, a different
        release saved under a reused hashed name) naturally invalidates
        instead of returning stale info for different bytes.
      - REMOTE (still an http(s) URL after resolution -- i.e. genuinely
        not present in the local cache, or cache disabled entirely on
        this host): keyed by the URL path's final segment ALONE. Byte
        SIZE cannot be folded into a REMOTE lookup key -- there is no way
        to learn a remote file's size without either a full ffprobe (the
        exact cost this cache exists to avoid) or an extra HEAD/Range
        round-trip (reintroducing the same network latency on every
        lookup, hit or not). This basename-alone heuristic is not a new
        risk this cache introduces: _resolve_cached_copy() above already
        treats an exact release-filename match as authoritative identity
        for substituting a whole different playback source, on the
        documented reasoning that two genuinely different files sharing
        an identical release name (group/quality/episode all baked into
        the name) is vanishingly unlikely. Once a probe DOES complete for
        a remote source, its container-reported byte size (when present)
        is stored ALONGSIDE the cached result as a 'size' field -- see
        probe_cached() -- for future collision diagnostics, without being
        folded into the lookup key itself, since nothing can supply a
        comparable fresh size at lookup time to check it against.
    """
    if _is_local_source(source_ref):
        try:
            st = os.stat(source_ref)
        except OSError:
            return None
        return 'local|%s|%d|%d' % (os.path.abspath(source_ref), st.st_size, int(st.st_mtime))
    try:
        import urllib.parse as _up
        path = _up.urlparse(source_ref).path or ''
        name = _up.unquote(path.rsplit('/', 1)[-1]).strip()
    except Exception:
        name = ''
    if len(name) < 5:
        return None
    return 'remote|%s' % name


# ---- per-file sidecar store (dot-prefixed, cache-eligible hosts only) ----
#
# Lives at CACHE_ROOT/.probes/<sha256(key)>.json -- dot-prefixed, the SAME
# convention cache.py's cache_files() already uses to hide .subs/,
# .torrents/, .names.json etc from cap/floor accounting and /cache/list
# (see cache.py:591-606's "any path component ... that starts with '.'"
# rule), so this new sidecar type needed no change there at all. Filename
# is a hash of the key, never a literal path component, so an unusual
# basename (unicode, path-hostile characters) can't become an unsafe path.
# No-op (in-process memo only, see _PROBE_MEMO/_LANDING_MEMO below) on a
# host with no cache module / no CACHE_ROOT -- TV/phone builds never ship
# cache.py, exactly like every other `import cache` in this file.

_SIDECAR_META_LOCK = threading.Lock()
_SIDECAR_LOCKS: dict = {}           # key(str) -> threading.Lock, get-or-create
_SIDECAR_LOCKS_MAX = 512            # bounded -- same shape as the memo caches below


def _sidecar_lock(key: str) -> threading.Lock:
    with _SIDECAR_META_LOCK:
        lk = _SIDECAR_LOCKS.get(key)
        if lk is None:
            if len(_SIDECAR_LOCKS) >= _SIDECAR_LOCKS_MAX:
                # A lock for a key nobody's touched in a while is safe to
                # forget -- a fresh one is created on demand if it's ever
                # needed again.
                for old in list(_SIDECAR_LOCKS.keys())[:_SIDECAR_LOCKS_MAX // 4]:
                    _SIDECAR_LOCKS.pop(old, None)
            lk = threading.Lock()
            _SIDECAR_LOCKS[key] = lk
        return lk


def _sidecar_path(key: str) -> Optional[Path]:
    try:
        import cache  # sibling; optional, see module note above
        import hashlib
        h = hashlib.sha256(key.encode('utf-8')).hexdigest()[:24]
        return cache.CACHE_ROOT / '.probes' / (h + '.json')
    except Exception:
        return None


def _sidecar_read(key: str) -> dict:
    """Never raises -- a missing/corrupt/unavailable sidecar is just an
    empty blob, mirroring cache.py's own _load_manifest()."""
    p = _sidecar_path(key)
    if p is None or not p.is_file():
        return {}
    try:
        with open(p, 'r', encoding='utf-8') as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _sidecar_mutate(key: str, fn) -> None:
    """Under this key's lock: load, fn(blob) mutates it in place, atomic
    write. Best-effort -- never raises; a failed write just means the next
    probe/seek pays the real cost again, exactly like before this cache
    existed. Mirrors cache.py's _mutate_manifest almost exactly, one level
    up (one blob per SOURCE FILE here vs. one per cache rel there)."""
    p = _sidecar_path(key)
    if p is None:
        return
    with _sidecar_lock(key):
        try:
            blob = _sidecar_read(key)
            fn(blob)
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix('.json.part')
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(blob, f)
            os.replace(str(tmp), str(p))
        except Exception:
            pass


# ---- probe() memo + sidecar ------------------------------------------------

_PROBE_MEMO_LOCK = threading.Lock()
_PROBE_MEMO: dict = {}              # key(str) -> probe() result dict
_PROBE_MEMO_MAX = 512               # bounded so a long-uptime host can't grow this forever


def _probe_memo_prune_locked() -> None:
    """Drop the oldest quarter once the memo exceeds _PROBE_MEMO_MAX. Caller
    MUST hold _PROBE_MEMO_LOCK. Regular dicts preserve insertion order on
    every Python version this runs on, and a hit re-inserts (see
    probe_cached) rather than just reading -- so "oldest" here means
    "least recently used", not just "first ever inserted"."""
    if len(_PROBE_MEMO) <= _PROBE_MEMO_MAX:
        return
    drop = len(_PROBE_MEMO) - (_PROBE_MEMO_MAX * 3 // 4)
    for k in list(_PROBE_MEMO.keys())[:drop]:
        _PROBE_MEMO.pop(k, None)


def _probe_sidecar_write(key: str, result: dict, size_hint: Optional[int] = None) -> None:
    """ALWAYS backgrounded (see probe_cached()'s call site): a probe result
    is only a few KB, but this must never add disk-write latency to the
    caller returning the probe it just got, whether that came from a fresh
    ffprobe or the memo."""
    def _run():
        def _mut(d: dict) -> None:
            d['probe'] = result
            if size_hint is not None:
                d['size'] = size_hint
        _sidecar_mutate(key, _mut)
    threading.Thread(target=_run, daemon=True, name='probe-sidecar-write').start()


def probe_cached(source_ref: str, timeout: float = 20.0) -> dict:
    """probe(), but memo -> sidecar -> ffprobe (see the module notes
    above). Same return shape and the same RemuxError-on-failure contract
    as probe() itself, so every call site that used to call probe()
    directly can swap this in with no other change. A cache MISS costs
    exactly what probe() always cost; a HIT costs one dict lookup (memo)
    or one small JSON read (sidecar) instead of an ffprobe subprocess."""
    key = _probe_key(source_ref)
    if key is not None:
        with _PROBE_MEMO_LOCK:
            hit = _PROBE_MEMO.get(key)
            if hit is not None:
                del _PROBE_MEMO[key]        # re-insert as most-recently-used
                _PROBE_MEMO[key] = hit
                return hit
        blob = _sidecar_read(key)
        cached = blob.get('probe') if isinstance(blob, dict) else None
        if isinstance(cached, dict):
            with _PROBE_MEMO_LOCK:
                _PROBE_MEMO[key] = cached
                _probe_memo_prune_locked()
            return cached

    result = probe(source_ref, timeout=timeout)

    if key is not None:
        with _PROBE_MEMO_LOCK:
            _PROBE_MEMO[key] = result
            _probe_memo_prune_locked()
        size_hint = None
        if not _is_local_source(source_ref):
            # See _probe_key's docstring -- learned only AFTER a real probe,
            # never required for the lookup itself.
            try:
                size_hint = int(((result.get('raw') or {}).get('format') or {}).get('size'))
            except (TypeError, ValueError):
                size_hint = None
        _probe_sidecar_write(key, result, size_hint)
    return result


# ---- seek-landing memo + sidecar (P3-lite) ---------------------------------

_LANDING_MEMO_LOCK = threading.Lock()
_LANDING_MEMO: dict = {}            # (src_key, bucket) -> float landing
_LANDING_MEMO_MAX = 512
_LANDING_PER_FILE_MAX = 64          # cap on distinct buckets persisted per sidecar


def _seek_bucket(target_time: float) -> str:
    """Bucket a requested seek target to the nearest whole second. Buckets,
    not exact floats: the measured landing is itself a keyframe/GOP
    boundary (typically several seconds of granularity), so two seek
    requests a fraction of a second apart resolve to the identical
    measured landing in practice -- exact-float keying would make a
    bit-different-but-effectively-identical resume position (a saved
    1523.014s vs. a fresh 1523.019s) always miss."""
    return str(int(round(max(0.0, target_time))))


def _landing_memo_prune_locked() -> None:
    if len(_LANDING_MEMO) <= _LANDING_MEMO_MAX:
        return
    drop = len(_LANDING_MEMO) - (_LANDING_MEMO_MAX * 3 // 4)
    for k in list(_LANDING_MEMO.keys())[:drop]:
        _LANDING_MEMO.pop(k, None)


def _landing_cache_get(src_key: str, bucket: str) -> Optional[float]:
    mk = (src_key, bucket)
    with _LANDING_MEMO_LOCK:
        v = _LANDING_MEMO.get(mk)
    if v is not None:
        return v
    blob = _sidecar_read(src_key)
    landings = blob.get('landings') if isinstance(blob, dict) else None
    if isinstance(landings, dict) and bucket in landings:
        try:
            v = float(landings[bucket])
        except (TypeError, ValueError):
            return None
        with _LANDING_MEMO_LOCK:
            _LANDING_MEMO[mk] = v
            _landing_memo_prune_locked()
        return v
    return None


def _landing_cache_put(src_key: str, bucket: str, value: float) -> None:
    mk = (src_key, bucket)
    with _LANDING_MEMO_LOCK:
        _LANDING_MEMO[mk] = value
        _landing_memo_prune_locked()

    def _run():
        def _mut(d: dict) -> None:
            landings = d.setdefault('landings', {})
            landings[bucket] = value
            # Bounded per-file too -- a long scrub session (many distinct
            # seek targets on one file) must not grow this sidecar forever.
            if len(landings) > _LANDING_PER_FILE_MAX:
                for k in list(landings.keys())[:len(landings) - _LANDING_PER_FILE_MAX]:
                    landings.pop(k, None)
        _sidecar_mutate(src_key, _mut)
    threading.Thread(target=_run, daemon=True, name='landing-sidecar-write').start()


# ===========================================================================
# RemuxSession
# ===========================================================================

class RemuxSession:
    """
    One playback session: either a live rolling-HLS remux ('hls-remux'
    mode, phone/usb/seedr source + ffmpeg stream-copy) or a simple
    token-gated pass-through to a local file ('direct' mode, remux OFF,
    phone/usb only -- seedr-direct bypasses sessions entirely, see
    playback_start()).

    Not constructed directly by callers -- use SessionManager.
    """

    def __init__(self, mode: str, source_type: str, source_ref: str,
                 requested_start_time: float, video_track: Optional[int],
                 audio_track: Optional[int]):
        assert mode in ('hls-remux', 'direct')
        self.id = secrets.token_urlsafe(32)
        self.mode = mode
        self.source_type = source_type
        self.source_ref = source_ref
        self.video_track = video_track
        self.audio_track = audio_track

        self.requested_start_time = max(0.0, requested_start_time)
        self.actual_start_time = self.requested_start_time

        # Local-file fast path (see _is_local_source / module docstring
        # above LOCAL_HLS_TIME_SECONDS): a smaller target segment duration
        # for a local source_ref, with every segment-COUNT window/
        # backpressure constant scaled by the same ratio so the *time*
        # window they represent is unchanged. ratio == 1.0 (no-op) for a
        # remote/seedr source, which keeps that path byte-for-byte the same
        # as before this tuning pass.
        self._is_local = mode == 'hls-remux' and _is_local_source(source_ref)
        self.segment_time_seconds = LOCAL_HLS_TIME_SECONDS if self._is_local else HLS_TIME_SECONDS
        _ratio = (HLS_TIME_SECONDS / self.segment_time_seconds) if self.segment_time_seconds > 0 else 1.0
        self._hls_list_size = max(1, round(HLS_LIST_SIZE * _ratio))
        self._segment_safety_margin = max(1, round(_SEGMENT_SAFETY_MARGIN * _ratio))
        self._min_keep_segments = max(1, round(_MIN_KEEP_SEGMENTS * _ratio))
        self._lead_limit_segments = self._hls_list_size
        self._lead_resume_segments = max(1, round(_LEAD_RESUME_SEGMENTS * _ratio))

        self.original_duration: Optional[float] = None
        self.video_codec: Optional[str] = None
        self.audio_codec: Optional[str] = None
        self.audio_channels: Optional[int] = None
        self.container: Optional[str] = None
        self.stream_copy: bool = (mode == 'hls-remux')

        # Video bitrate ceiling (see MAX_SOURCE_VIDEO_BITRATE). Populated from
        # the probe by SessionManager.start_remux_session BEFORE start(), so
        # _launch() can read it. `stream_copy` is deliberately NOT repurposed
        # for this -- it still means "this is an ffmpeg remux session", which
        # is what status() has always reported; the transcode decision is
        # surfaced alongside it as a separate key instead.
        self.source_video_bitrate: Optional[int] = None
        self.video_transcode: bool = False

        # Output container. 'mpegts' is the shipped path: MPEG-TS segments fed
        # to a native <video> via HLS, which is what every existing fix in this
        # file was built and verified against -- it stays the DEFAULT and is
        # untouched. 'fmp4' emits fragmented MP4 for the MSE player, which
        # cannot accept MPEG-TS at all (the Media Source byte-stream spec only
        # defines ISO BMFF and WebM). Opt-in per session so the two coexist.
        self.output_mode: str = 'mpegts'
        # Cached RFC 6381 mime for the MSE client, parsed from init.mp4 once it
        # exists (ffmpeg writes it early, but not necessarily before the first
        # status poll -- hence lazy + cached rather than computed at launch).
        self._mse_mime: Optional[str] = None

        self.temp_dir: Optional[Path] = None
        self.proc: Optional[subprocess.Popen] = None
        self._stderr_tail = collections.deque(maxlen=40)
        self._stderr_thread: Optional[threading.Thread] = None

        self.state = 'starting'          # 'starting'|'running'|'paused'|'closed'|'error'
        self.consumed_segment = -1       # highest segment index the TV has actually fetched
        self._backpressure_suspended = False
        self._user_paused = False
        self.errors: list = []

        self.tv_heartbeat = time.monotonic()
        self.created_at = time.monotonic()
        self.closed = False

        self.lock = threading.RLock()
        self._monitor_thread: Optional[threading.Thread] = None

    # -- lifecycle -----------------------------------------------------

    def start(self) -> None:
        """Launch the first ffmpeg generation. Raises RemuxError on failure."""
        assert self.mode == 'hls-remux'
        self.temp_dir = _new_temp_dir(self.id)
        self._launch(self.requested_start_time)
        self.state = 'running'
        self._monitor_thread = threading.Thread(
            target=self._monitor_loop, daemon=True, name=f'remux-monitor-{self.id[:8]}')
        self._monitor_thread.start()

    def mse_mime_type(self) -> Optional[str]:
        """`video/mp4; codecs="..."` for this session's init segment, or None.

        The client MUST pass this to addSourceBuffer() verbatim -- guessing the
        codec string from a profile NAME is the classic way to get an opaque
        NotSupportedError. None means "don't use the MSE path", not "try
        something plausible".
        """
        if self.output_mode != 'fmp4':
            return None
        if self._mse_mime:
            return self._mse_mime
        try:
            p = self.temp_dir / _INIT_NAME
            if not p.is_file():
                return None
            codec = mse_codec_from_init(p.read_bytes())
            if codec:
                self._mse_mime = 'video/mp4; codecs="%s"' % codec
        except Exception:
            return None
        return self._mse_mime

    def _muxer_args(self) -> list:
        """Output-muxer args for this session's container.

        'mpegts' (default, unchanged): the segment muxer with DVB system_b
        tables -- see the long note at the call site; some TV decoders go SILENT on
        ffmpeg's default ATSC tables, so that flag is load-bearing.

        'fmp4': fragmented MP4 for MSE. Notes that matter:
          * `-tag:v hvc1` is REQUIRED for HEVC. ffmpeg defaults to the 'hev1'
            sample entry, which MSE implementations widely reject; hvc1 puts
            the parameter sets in the sample description where they expect it.
            Harmless to omit for H.264, so it's applied only for HEVC.
          * Video stays `-c:v copy` in this mode ALWAYS -- the entire point of
            the MSE path is 4K passthrough with no transcode. The bitrate
            ceiling exists to bound the NATIVE pipeline's time-based buffer,
            and MSE replaces that with an explicit byte budget we control, so
            the ceiling is not just unnecessary here, applying it would defeat
            the feature.
          * The init segment (moov) is written once as init.mp4 and fetched
            once by the client before any fragment.
        """
        seg = str(self.segment_time_seconds)
        if self.output_mode != 'fmp4':
            return [
                '-f', 'segment',
                '-segment_format', 'mpegts',
                '-segment_format_options', 'mpegts_flags=+system_b',
                '-segment_time', seg,
                '-segment_list_size', '0',
                '-segment_list_flags', '+live',
                '-segment_list_type', 'm3u8',
                '-segment_list', str(self.temp_dir / 'index.m3u8'),
                '-segment_list_entry_prefix', '/playback/%s/segments/' % self.id,
                str(self.temp_dir / 'seg_%05d.ts'),
            ]
        args = []
        if (self.video_codec or '').lower() == 'hevc':
            args += ['-tag:v', 'hvc1']
        args += [
            '-f', 'hls',
            '-hls_segment_type', 'fmp4',
            # CMAF/fMP4 movflags. Without these the fragmenter mangles HEVC:
            # Missing composition offsets or fragment metadata can drop HEVC
            # frames and produce reference-picture errors during fMP4 muxing.
            #   negative_cts_offsets - HEVC B-frames carry negative composition
            #       offsets; without this they cannot be represented and frames
            #       are dropped rather than reordered.
            #   default_base_moof + omit_tfhd_offset - the CMAF-correct way to
            #       express fragment offsets; MSE parsers expect it.
            #   frag_keyframe - only ever cut a fragment at a keyframe.
            '-movflags', '+negative_cts_offsets+default_base_moof+omit_tfhd_offset+frag_keyframe',
            '-hls_fmp4_init_filename', _INIT_NAME,
            '-hls_time', seg,
            '-hls_list_size', '0',
            # NOTE: `independent_segments` is deliberately NOT set. It asserts
            # every fragment is independently decodable, which on an open-GOP
            # HEVC source the muxer can only honour by DROPPING the leading
            # pictures after each CRA. Missing video frames with continuous
            # audio can then leave timeline gaps and stall playback.
            '-hls_segment_filename', str(self.temp_dir / 'seg_%05d.m4s'),
            '-hls_base_url', '/playback/%s/segments/' % self.id,
            str(self.temp_dir / 'index.m3u8'),
        ]
        return args

    def _video_args(self) -> list:
        """ffmpeg video codec args: stream-copy, or a bitrate-capped encode.

        Stream-copy stays the default and the common case -- it is the
        quality-critical, CPU-heavy stream and re-encoding it is pure loss.
        We only encode when the SOURCE bitrate would pin more of the target TV's
        native media buffer than it has RAM for (see MAX_SOURCE_VIDEO_BITRATE
        for the buffer budget).
        """
        # The MSE path NEVER transcodes video. The bitrate ceiling exists to
        # bound the NATIVE pipeline's time-based buffer; MSE replaces that with
        # an explicit byte budget the client controls, so capping bitrate here
        # would throw away the quality this whole path exists to preserve.
        if self.output_mode == 'fmp4' or not self.video_transcode:
            return ['-c:v', 'copy']
        enc = _pick_video_encoder()
        # Everything except libx264 here is a hardware encoder (qsv/nvenc/amf),
        # which differ from x264 in two ways that matter below: pixel format and
        # whether forced keyframes actually become IDRs.
        _hw = enc != 'libx264'
        args = [
            '-c:v', enc,
            '-preset', 'veryfast',
            # Cap the PEAK, not just the average: the TV's buffer is sized in
            # time, so a bursty VBR peak is exactly what overruns it. bufsize
            # = 2x target keeps the VBV window to ~2s of leeway.
            '-b:v', str(TARGET_VIDEO_BITRATE),
            '-maxrate', str(TARGET_VIDEO_BITRATE),
            '-bufsize', str(TARGET_VIDEO_BITRATE * 2),
            # 8-bit. A Main10/HDR source would otherwise either refuse to open
            # on some encoders or emit a profile the target TV can't decode. QSV wants
            # nv12 and merely WARNS then auto-corrects if handed yuv420p, so
            # name the right one per encoder rather than eat the warning.
            '-pix_fmt', 'nv12' if _hw else 'yuv420p',
            # Keyframe cadence: with -c:v copy the segment muxer could only cut
            # at a SOURCE keyframe, and the segment-COUNT window constants were
            # calibrated around that. Now that we own the encoder we must put
            # keyframes on the segment grid ourselves -- left alone, the
            # encoder's default GOP (~256 frames) stretches every segment to
            # ~10s and blows those constants wide open.
            '-force_key_frames', 'expr:gte(t,n_forced*%g)' % self.segment_time_seconds,
        ]
        if _hw:
            # Hardware encoders can treat -force_key_frames as a hint and emit
            # non-IDR frames. The segment muxer can only cut at real IDRs, so
            # -forced_idr is needed to keep segments near the target duration.
            # nvenc/amf behave the same way; libx264 has no such option (passing
            # it there is a hard error), hence the branch.
            args += ['-forced_idr', '1']
        else:
            # Stop x264 inserting extra scene-cut IDRs between the forced ones
            # (harmless for output, but it fragments the segment grid).
            args += ['-sc_threshold', '0']
        return args

    def _audio_args(self) -> list:
        """Return ffmpeg's audio codec arguments for the selected source track.

        AAC is copied when its channel layout is already TV-safe. AC-3 and
        E-AC-3 are copied in the MPEG-TS output so the original Dolby bitstream
        -- including E-AC-3 Atmos/JOC metadata -- reaches a compatible AV receiver over
        eARC. DTS/TrueHD and over-wide AAC still use the existing AAC fallback.
        """
        ch = self.audio_channels if isinstance(self.audio_channels, int) and self.audio_channels > 0 else None
        codec = (self.audio_codec or '').lower()
        if (DOLBY_AUDIO_PASSTHROUGH and self.output_mode == 'mpegts'
                and codec in ('ac3', 'eac3')):
            return ['-c:a', 'copy']
        if codec == 'aac' and not (ch is not None and ch > MAX_AUDIO_CHANNELS):
            return ['-c:a', 'copy']
        chn = ch or 2
        out_channels = min(chn, MAX_AUDIO_CHANNELS)
        bitrate = '384k' if out_channels > 2 else '192k'
        args = ['-c:a', 'aac', '-b:a', bitrate]
        if out_channels != chn:
            # Downmix (e.g. 7.1 -> 5.1, or a TrueHD/Atmos bed -> 5.1) using
            # ffmpeg's default channel-layout-aware downmix matrix.
            args += ['-ac', str(out_channels)]
        # DTS/E-AC3 frequently decode to a NON-standard layout (e.g. 5.1(side)),
        # which the AAC encoder can emit as 'unknown'. Some playback pipelines
        # cannot route that multichannel stream. Force a standard layout matching
        # the output channel count so the AAC has a routable configuration.
        layout = {1: 'mono', 2: 'stereo', 6: '5.1', 8: '7.1'}.get(out_channels)
        if layout:
            args += ['-channel_layout', layout]
        # Anti-drift: this path DECODES then RE-ENCODES audio (video stays
        # -c:v copy, so it never needs this), and decode->encode sample-clock
        # rounding on a long-running session can accumulate into a slowly
        # growing A/V skew even though each individual frame's rounding error
        # is tiny. -af aresample=async=1 lets the resampler insert/drop
        # samples to track the input clock instead of silently drifting.
        args += ['-af', 'aresample=async=1']
        return args

    def _audio_is_copied(self) -> bool:
        """True when _audio_args() will pass the audio through untouched
        (-c:a copy). The seek-trim/actual_start_time pairing in _launch()
        depends on this: accurate seek can only trim DECODED streams, so a
        copied audio track always begins at the demuxer landing regardless
        of the -ss value."""
        args = self._audio_args()
        return args[:2] == ['-c:a', 'copy']

    def _launch(self, start_time: float) -> None:
        """(Re)start ffmpeg at `start_time`, updating actual_start_time."""
        if self.output_mode == 'fmp4' and (self.video_codec or '').lower() == 'hevc' and start_time:
            # Stream-copied HEVC cut at an open-GOP CRA leaves undecodable
            # leading frames (see find_clean_hevc_start). Step back to a start
            # the decoder actually accepts. t=0 is inherently safe, so this only
            # runs for real seeks/resumes.
            safe = find_clean_hevc_start(self.source_ref, start_time)
            if safe != start_time:
                _mlog('hevc open-GOP: moved start %.3f -> %.3f for a decodable landing'
                      % (start_time, safe))
            start_time = safe
            self.actual_start_time = safe
        elif self.video_transcode and not self._audio_is_copied():
            # TRANSCODE path with DECODED audio uses ACCURATE seek (see the
            # -noaccurate_seek note in the arg list below), so ffmpeg trims
            # every stream to exactly `start_time` and actual_start_time is
            # exact BY CONSTRUCTION -- no keyframe-landing measurement, and
            # no chance of the measured value disagreeing with where the
            # output really begins.
            #
            # This is not an optimisation, it is a correctness requirement.
            # A container landing can precede the requested IDR by an entire
            # GOP. With -noaccurate_seek, copied audio can start at that earlier
            # landing while decoded video starts only at the IDR, producing
            # audio-only pre-roll and a matching subtitle clock error.
            # Stream-copying both streams does not introduce that asymmetry.
            #
            # CRITICAL GUARD (`not self._audio_is_copied()`): the exactness
            # argument above requires accurate seek to trim EVERY stream --
            # and it can only trim DECODED streams. With Dolby passthrough
            # (-c:a copy, e.g. E-AC-3 Atmos over eARC) the copied audio
            # starts at the demuxer LANDING while trimmed video starts at
            # `start_time`, the muxer's PTS base follows the earlier audio,
            # and reporting `start_time` skews the entire absolute clock --
            # subtitles visibly lead the speech by (requested - landing),
            # up to a whole GOP, after every seek/resume.
            # That combination takes the measured-landing branch below.
            self.actual_start_time = max(0.0, float(start_time or 0.0))
        else:
            actual = _find_preceding_keyframe(self.source_ref, start_time)
            self.actual_start_time = actual

        cmd = [
            FFMPEG_BIN, '-nostdin', '-hide_banner', '-loglevel', 'warning',
            # -re: pace INPUT reading to real time. Without it a fast source (a
            # local file, or a fast CDN) stream-copies to completion in seconds,
            # racing past the consumed-segment backpressure, and the file-reaper
            # then deletes the beginning before the TV ever loads it — so the
            # window ends up at the tail. -re keeps production ~1x so the rolling
            # window tracks the playhead. Harmless for a slow source (it only
            # caps the rate, never speeds it up). Compatible with -c copy.
            '-re',
            # For a LOCAL source only (see _is_local_source), let ffmpeg burst-
            # read the first LOCAL_READRATE_INITIAL_BURST_SECONDS of content at
            # full disk speed before -re's real-time pacing kicks in -- this is
            # what actually gets the first segment (and therefore first
            # playable frame) out fast for a cache file, without discarding
            # -re's window-protecting throttle for the rest of playback. A
            # remote/seedr source never gets this flag, so its behavior is
            # unchanged.
            *(['-readrate_initial_burst', str(LOCAL_READRATE_INITIAL_BURST_SECONDS)]
              if self._is_local else []),
            # -noaccurate_seek: ffmpeg's default `-ss` (input-seek) behavior,
            # when a stream is actually DECODED (as AUDIO is here -- AC3/etc
            # -> AAC via _audio_args(), unless already AAC and copied), trims
            # every decoded frame whose PTS is before the literal `-ss`
            # value, only emitting output from THAT exact timestamp onward.
            # VIDEO is `-c:v copy` (never decoded), so it is NEVER trimmed --
            # it starts wherever the demuxer lands, i.e. genuinely AT
            # `actual` (the true preceding keyframe found above). That
            # asymmetry silently produced a VIDEO-ONLY, SILENT pre-roll on
            # every resume/seek whose target wasn't itself a keyframe: video
            # ran from `actual`, but transcoded audio didn't start until the
            # ORIGINAL requested time, `requested - actual` seconds later --
            # for example, a landing 4.7s before the requested time leaves
            # transcoded audio silent for that interval unless trimming is
            # disabled to match the copied video.
            # -noaccurate_seek disables the trim for every stream, so a
            # transcoded audio track pre-rolls in lockstep with the
            # stream-copied video instead of joining roughly a GOP late.
            # Passthrough audio (-c:a copy) was
            # never decoded either, so it was already unaffected either way.
            #
            # ...all of which applies to the STREAM-COPY path, and ONLY to it.
            # The TRANSCODE path must NOT use this flag: there video is decoded
            # too, so it cannot begin before the next true IDR, while the audio
            # would still start back at the container landing -- the same
            # asymmetry as the original bug, just with the two streams swapped.
            # For a seek to 1500s with a landing at 1492.6s, audio from the
            # landing and video from the IDR yield 7.4s of audio-only pre-roll.
            # Letting ffmpeg's default ACCURATE seek trim BOTH streams to the
            # exact -ss value realigns them and makes actual_start_time exact
            # by construction (see _launch above).
            # ...UNLESS the audio is COPIED (Dolby passthrough): accurate
            # seek cannot trim a copied stream, so dropping the flag there
            # only desyncs the trimmed video (and the reported clock) from
            # the untrimmable audio. With the flag, both streams start at
            # the landing and actual_start_time (measured, see _launch)
            # matches -- decoded video picks up at the landing IDR on
            # healthy files, so there is no pre-roll in the common case.
            *([] if (self.video_transcode and not self._audio_is_copied())
              else ['-noaccurate_seek']),
            # -ss gets the ORIGINAL requested time, NOT the measured landing:
            # actual_start_time was measured for a seek to *start_time* (see
            # _measure_seek_landing). Re-seeking to the landing value itself
            # can land yet another cluster earlier on a damaged index -- the
            # pair (ss=requested, report=measured(requested)) is the only
            # combination that agrees by construction. On healthy files both
            # -ss values land on the same keyframe, so nothing changes.
            '-ss', str(max(0.0, float(start_time or 0.0))),
            '-i', self.source_ref,
            *_map_args(self.video_track, self.audio_track),
            # Video: pure stream-copy (the quality-critical, CPU-heavy stream)
            # UNLESS the source bitrate exceeds what the target TV's ~49s native
            # buffer can hold in RAM -- see _video_args()/MAX_SOURCE_VIDEO_BITRATE.
            # Audio: see _audio_args() -- AAC/AC-3/E-AC-3 are copied when safe;
            # copying E-AC-3 preserves DD+ Atmos/JOC for eARC passthrough.
            # DTS/TrueHD and over-wide AAC use the AAC compatibility fallback.
            #
            # NOTE the interaction with -noaccurate_seek above: it disables
            # ffmpeg's pre-`-ss` frame trimming for EVERY stream, so a
            # TRANSCODED video track still starts at the demuxer's landing
            # (the true preceding keyframe) exactly as a copied one does.
            # That is what keeps actual_start_time -- measured with `-c copy`
            # by _measure_seek_landing -- valid on the transcode path too;
            # without it, accurate-seek would start the encode at the exact
            # requested time and desync every subtitle by up to a GOP.
            *self._video_args(),
            *self._audio_args(),
            # SEGMENT muxer with DVB (system_b) TS tables -- REQUIRED for audio.
            # DVB-based TV decoders can fail to route audio with the default
            # ATSC tables, even for AAC. Only the segment muxer's
            # segment_format_options forwards mpegts_flags to the child TS muxer;
            # the HLS muxer drops it. The segment muxer resets output PTS to ~0
            # after -ss, so the app's sessionStartTime + video.currentTime
            # mapping (subtitles, seek bar) stays correct.
            # Output muxer -- see _muxer_args(). 'mpegts' (the default) is the
            # long-standing segment-muxer + DVB system_b path, moved there
            # VERBATIM; 'fmp4' is the additive MSE branch. Segment duration is
            # only ever a TARGET in the copy path: since video is -c:v copy the
            # muxer can only cut at a source keyframe, so real segment length is
            # capped by the source's GOP spacing.
            *self._muxer_args(),
        ]
        env = {**os.environ, **FF_ENV}
        # preexec_fn=os.setsid puts ffmpeg in its own process group so
        # close()/seek() can reliably signal it (and any helper children it
        # spawns) without touching the server process. Windows has neither
        # preexec_fn (raises ValueError) nor POSIX process groups --
        # CREATE_NEW_PROCESS_GROUP is the closest equivalent and lets
        # _kill_proc's `taskkill /T` reach the whole ffmpeg child tree there.
        # ABOVE_NORMAL_PRIORITY_CLASS is the complementary half of the
        # subsync gentle-mode fix (see subsync.py's _whisper_multi_offset):
        # this IS the latency-critical, user-facing process on a weak,
        # power-trimmed host, so it should win OS scheduling contention
        # against a concurrent (deliberately de-prioritized) whisper.cpp
        # subsync pass rather than compete at equal priority.
        popen_kw = (
            {'preexec_fn': os.setsid} if not _IS_WIN
            else {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP
                                    | subprocess.ABOVE_NORMAL_PRIORITY_CLASS}
        )
        if self.output_mode == 'fmp4':
            # On affected ffmpeg builds, a bare -hls_fmp4_init_filename is
            # written to the process CWD, not next to the playlist or the
            # segments -- even though every other path we pass is absolute.
            # Left alone that (a) 404s, since the server only serves out of the
            # session temp dir, and worse (b) makes every concurrent session
            # collide on one shared working-directory init.mp4 and leak it after the
            # session ends.
            # Pinning CWD to the session dir puts init.mp4 exactly where the
            # segments are, keeps the playlist's EXT-X-MAP URI a clean relative
            # 'init.mp4', and lets it be reaped with the rest of the temp dir.
            # Safe because every other path in the argv is already absolute.
            popen_kw['cwd'] = str(self.temp_dir)
        try:
            self.proc = subprocess.Popen(
                cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                **popen_kw,
            )
        except FileNotFoundError:
            raise RemuxError('ffmpeg binary not found -- call ensure_ffmpeg_staged() first')
        except Exception as e:
            raise RemuxError(f'failed to launch ffmpeg: {e}')

        self._stderr_tail.clear()
        self._stderr_thread = threading.Thread(
            target=self._drain_stderr, daemon=True, name=f'remux-stderr-{self.id[:8]}')
        self._stderr_thread.start()

        # Wait briefly for the playlist to appear, or bail out early if
        # ffmpeg exits immediately (bad -map, unreadable source, etc).
        # Tight 50ms poll (not a fixed multi-second sleep) -- this loop is on
        # the hot path of every seek's server-side latency (playback_seek()
        # -> RemuxSession.seek() -> _launch() blocks here before the HTTP
        # response even goes out), so shaving the poll granularity directly
        # shaves worst-case seek-response latency without touching the
        # keyframe-scan correctness above.
        deadline = time.monotonic() + _LAUNCH_READY_TIMEOUT_SECONDS
        playlist = self.temp_dir / 'index.m3u8'
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                tail = ' | '.join(self._stderr_tail)
                raise RemuxError(f'ffmpeg exited early (code {self.proc.returncode}): {tail}'[:500])
            if playlist.exists():
                return
            time.sleep(0.05)
        # Not necessarily fatal -- large/slow sources may just need a
        # bit longer for the first segment. Leave it running; status()
        # will report ready=False until the playlist shows up.

    def _drain_stderr(self) -> None:
        proc = self.proc
        if proc is None or proc.stderr is None:
            return
        try:
            for raw_line in proc.stderr:
                try:
                    line = raw_line.decode('utf-8', 'replace').rstrip()
                except Exception:
                    continue
                if line:
                    self._stderr_tail.append(_redact_ref(line))
        except Exception:
            pass

    def seek(self, absolute_time: float) -> float:
        """
        Kill the current ffmpeg generation and relaunch at the nearest
        preceding keyframe to `absolute_time`. Returns the new
        actualStartTime. Raises RemuxError if the session is closed or
        relaunch fails.
        """
        assert self.mode == 'hls-remux'
        with self.lock:
            if self.closed:
                raise RemuxError('session is closed')

            self._kill_proc(self.proc)

            # Wipe stale segments/playlist so the TV never fetches a
            # segment from the previous generation after a seek.
            if self.temp_dir and self.temp_dir.exists():
                for f in self.temp_dir.glob('*'):
                    try:
                        f.unlink()
                    except OSError:
                        pass

            self.requested_start_time = max(0.0, absolute_time)
            self.consumed_segment = -1
            self._backpressure_suspended = False
            self._user_paused = False
            self.state = 'starting'

            self._launch(self.requested_start_time)
            self.state = 'running'
            return self.actual_start_time

    def pause(self) -> None:
        """User-initiated pause (distinct from automatic backpressure SIGSTOP)."""
        with self.lock:
            if self.closed:
                raise RemuxError('session is closed')
            self._user_paused = True
            if self.proc and self.proc.poll() is None:
                self._suspend_proc(self.proc)
            self.state = 'paused'

    def resume(self) -> None:
        with self.lock:
            if self.closed:
                raise RemuxError('session is closed')
            self._user_paused = False
            if self.proc and self.proc.poll() is None:
                self._resume_proc(self.proc)
            self.state = 'running'
            # If backpressure still applies, the monitor loop will
            # re-SIGSTOP it on its next tick -- we don't fight that here.

    def note_segment_fetched(self, seg_name: str) -> None:
        m = _SEG_NAME_RE.match(seg_name)
        if m:
            idx = int(m.group(1))
            with self.lock:
                if idx > self.consumed_segment:
                    self.consumed_segment = idx
        self.heartbeat()

    def heartbeat(self) -> None:
        self.tv_heartbeat = time.monotonic()

    def status(self) -> dict:
        with self.lock:
            ts_files = []
            playlist_bytes = 0
            if self.temp_dir and self.temp_dir.exists():
                ts_files = _segment_files(self.temp_dir)
                playlist_path = self.temp_dir / 'index.m3u8'
                if playlist_path.exists():
                    try:
                        playlist_bytes = playlist_path.stat().st_size
                    except OSError:
                        playlist_bytes = 0

            cached_bytes = 0
            for f in ts_files:
                try:
                    cached_bytes += f.stat().st_size
                except OSError:
                    pass

            mem = None
            if self.proc and self.proc.poll() is None:
                mem = _read_rss_bytes(self.proc.pid)

            produced = _max_segment_index(ts_files)
            ready = bool(self.temp_dir and (self.temp_dir / 'index.m3u8').exists())

            # Best-effort absolute position estimate for diagnostics only;
            # the authoritative source of truth for the UI is always
            # sessionStartTime (== actual_start_time) + video.currentTime
            # computed client-side, per the module's time-mapping contract.
            approx_elapsed = max(self.consumed_segment, 0) * self.segment_time_seconds
            absolute_position = self.actual_start_time + approx_elapsed

            return {
                'mode': self.mode,
                'state': self.state,
                'absolutePosition': absolute_position,
                'currentSegment': self.consumed_segment,
                'producedSegment': produced,
                'cachedSegments': len(ts_files),
                'cachedBytes': cached_bytes,
                'ffmpegMem': mem,
                'tempBytes': cached_bytes + playlist_bytes,
                'streamCopy': self.stream_copy,
                'videoTranscode': self.video_transcode,
                'outputMode': self.output_mode,
                'mseMimeType': self.mse_mime_type(),
                'sourceVideoBitrate': self.source_video_bitrate,
                'targetVideoBitrate': TARGET_VIDEO_BITRATE if self.video_transcode else None,
                'tvHeartbeat': self.tv_heartbeat,
                'backpressureSuspended': self._backpressure_suspended,
                'userPaused': self._user_paused,
                # 'errors' carries ONLY genuinely fatal/operational errors --
                # the client treats a non-empty 'errors' as a failure. ffmpeg's
                # informational stderr (e.g. the benign "-re Resumed reading
                # after a lag" pacing notices on a jittery network source) goes
                # under 'stderrTail' so it never aborts a healthy warm-up.
                'errors': self.errors[-10:],
                'stderrTail': list(self._stderr_tail)[-10:],
                'fatal': self.state == 'error',
                'procAlive': bool(self.proc and self.proc.poll() is None),
                'ready': ready,
                'segmentsReady': len(ts_files),
            }

    def close(self) -> None:
        with self.lock:
            if self.closed:
                return
            self.closed = True
            self.state = 'closed'
            proc = self.proc

        # Kill outside the lock so a slow proc.wait() doesn't block
        # other threads calling status()/note_segment_fetched().
        self._kill_proc(proc)

        if self._stderr_thread is not None:
            self._stderr_thread.join(timeout=2)
        if self._monitor_thread is not None:
            self._monitor_thread.join(timeout=_MONITOR_INTERVAL_SECONDS * 3)

        if self.temp_dir and self.temp_dir.exists():
            shutil.rmtree(self.temp_dir, ignore_errors=True)
        # self.id is never re-registered anywhere once SessionManager
        # drops its reference -- this is the "token revoked" step.

    @staticmethod
    def _win_suspend_resume(pid: int, resume: bool) -> bool:
        """Real suspend/resume on Windows via ntdll NtSuspendProcess /
        NtResumeProcess. This USED to be a documented no-op, which silently
        disabled backpressure on the laptop engine: ffmpeg ran unpaced
        through stalls, the rolling window slid past the playhead, and the
        reaper evicted segments the TV hadn't fetched yet -- constant
        rebuffering that looked like a slow network. PROCESS_SUSPEND_RESUME
        = 0x0800."""
        try:
            import ctypes
            k32 = ctypes.windll.kernel32
            ntdll = ctypes.windll.ntdll
            h = k32.OpenProcess(0x0800, False, int(pid))
            if not h:
                return False
            try:
                fn = ntdll.NtResumeProcess if resume else ntdll.NtSuspendProcess
                return fn(h) == 0
            finally:
                k32.CloseHandle(h)
        except Exception:
            return False

    @staticmethod
    def _suspend_proc(proc: subprocess.Popen) -> bool:
        """Pause the producer: SIGSTOP on Unix, NtSuspendProcess on Windows
        (see _win_suspend_resume)."""
        if _IS_WIN:
            return RemuxSession._win_suspend_resume(proc.pid, resume=False)
        try:
            os.kill(proc.pid, signal.SIGSTOP)
            return True
        except OSError:
            return False

    @staticmethod
    def _resume_proc(proc: subprocess.Popen) -> bool:
        """Resume the producer: SIGCONT on Unix, NtResumeProcess on Windows."""
        if _IS_WIN:
            return RemuxSession._win_suspend_resume(proc.pid, resume=True)
        try:
            os.kill(proc.pid, signal.SIGCONT)
            return True
        except OSError:
            return False

    @staticmethod
    def _kill_proc(proc: Optional[subprocess.Popen]) -> None:
        if proc is None or proc.poll() is not None:
            return
        # Make sure it's not sitting SIGSTOPped -- a stopped process won't
        # act on SIGTERM until continued. No-op on Windows (see
        # _resume_proc), where nothing can be SIGSTOPped in the first place.
        RemuxSession._resume_proc(proc)

        if not _IS_WIN:
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
        else:
            # No process-group signals on Windows -- ffmpeg was launched
            # with CREATE_NEW_PROCESS_GROUP, so taskkill /T can tear down
            # it and any helper children it spawned.
            try:
                subprocess.run(
                    ['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                    capture_output=True,
                )
                proc.wait(timeout=3)
                return
            except Exception:
                pass
            try:
                proc.kill()
                proc.wait(timeout=2)
            except Exception:
                pass

    # -- rolling-window backpressure + disk-cap monitor -----------------

    def _monitor_loop(self) -> None:
        """
        Runs for the lifetime of the session (across seeks, which
        replace self.proc but not this thread). Each tick:
          1. Prunes any segment files beyond the safety margin (belt and
             suspenders on top of ffmpeg's own -hls_flags delete_segments).
          2. Enforces the absolute byte cap.
          3. SIGSTOPs ffmpeg when it has produced too far ahead of what
             the TV has actually consumed (backpressure), SIGCONTs it
             once the TV has caught back up. Never touches ffmpeg while
             the user has explicitly paused (self._user_paused) --
             that's a separate, sticky state.
        """
        while True:
            time.sleep(_MONITOR_INTERVAL_SECONDS)
            # Keep the monitor alive after a failed tick so segment pruning
            # continues. Unbounded growth can exhaust storage or, with a
            # RAM-backed temp directory, system memory. Log and retry.
            try:
                with self.lock:
                    if self.closed:
                        return
                    temp_dir = self.temp_dir
                    proc = self.proc
                    user_paused = self._user_paused
                    consumed = self.consumed_segment

                if temp_dir is None or not temp_dir.exists():
                    continue

                ts_files = _segment_files(temp_dir)

                # 1. Count-based prune: bounded window around the playhead.
                #    Uses this session's (possibly local-scaled, see
                #    __init__) list size + safety margin so a shorter local
                #    segment duration still represents the same TIME window
                #    as the module defaults do for a remote source.
                max_keep = self._hls_list_size + self._segment_safety_margin
                if len(ts_files) > max_keep:
                    for f in ts_files[:-max_keep]:
                        try:
                            f.unlink()
                        except OSError:
                            pass
                    ts_files = ts_files[-max_keep:]

                # 2. Enforce the byte cap, including on RAM-backed storage.
                #    Drop oldest segments without going below the buffer floor.
                total_bytes = _dir_bytes(ts_files)
                while total_bytes > _BYTE_CAP_BYTES and len(ts_files) > self._min_keep_segments:
                    oldest = ts_files.pop(0)
                    try:
                        oldest.unlink()
                    except OSError:
                        pass
                    total_bytes = _dir_bytes(ts_files)

                # 3. Backpressure: SIGSTOP ffmpeg when it produces too far ahead
                #    of what the TV consumed; SIGCONT once it catches up.
                if proc is None or proc.poll() is not None or user_paused:
                    continue
                produced = _max_segment_index(ts_files)
                if produced < 0:
                    continue
                lead = produced - max(consumed, -1)

                with self.lock:
                    suspended = self._backpressure_suspended
                if not suspended and lead > self._lead_limit_segments:
                    if self._suspend_proc(proc):     # False only on Unix OSError (ProcessLookupError, PermissionError, ...)
                        with self.lock:
                            self._backpressure_suspended = True
                elif suspended and lead <= self._lead_resume_segments:
                    if self._resume_proc(proc):
                        with self.lock:
                            self._backpressure_suspended = False
            except Exception as e:
                _mlog('monitor tick error: %r' % (e,))
                continue


# ===========================================================================
# SessionManager -- at most ONE active session at a time
# ===========================================================================

class SessionManager:
    """
    Enforces "ONE active session" server-wide: starting a new session
    (remux or direct) always closes whatever was previously active
    first. A background watchdog thread closes the active session if it
    goes _HEARTBEAT_TIMEOUT_SECONDS without any TV activity (playlist
    fetch, segment fetch, or explicit heartbeat/status poll) -- this is
    what tears down ffmpeg + frees the temp dir on TV disconnect even if
    the client never calls DELETE explicitly.
    """

    def __init__(self):
        self._session: Optional[RemuxSession] = None
        self._lock = threading.RLock()
        self._watchdog = threading.Thread(
            target=self._watchdog_loop, daemon=True, name='remux-watchdog')
        self._watchdog.start()

    def _close_current_locked(self, wait: bool = False) -> None:
        """Detach the previous session immediately; tear it down for real
        either inline (`wait=True`) or in a background thread (the
        default).

        RemuxSession.close() pays the prior ffmpeg's
        SIGTERM/SIGKILL-wait chain plus two thread joins plus an rmtree --
        up to ~8-10s worst case (real-world ffmpeg usually dies on SIGTERM
        in milliseconds, but the worst case is what a back-to-back play,
        next-episode, or engine swap used to pay serially, on the new
        session's own critical path, since this used to call
        self._session.close() inline before returning). The new session
        never needs the old one to have actually finished dying -- it gets
        its own temporary directory (REMUX_TEMP_ROOT/<new session's own uuid id>,
        see _new_temp_dir) and its own ffmpeg process group, so there is no
        directory/port collision hazard from letting the two briefly
        overlap while the old one is still exiting.

        Detaching is safe the instant `self._session` is cleared below: no
        handler can reach the old session by id any more (get()/close()
        only match against `self._session`), and active_source_path()
        stops reporting its source_ref immediately too -- both exactly as
        if close() had already fully run. close() itself still flips
        `self.closed = True` synchronously under ITS OWN lock as the very
        first thing it does, before any of the slow work, so there is no
        window where a detached session still looks 'open' to anything
        holding a stale reference to it.

        `wait=True` is for shutdown_all()/close_current_blocking() only --
        a graceful process stop must actually wait for the old ffmpeg to
        exit and its temporary directory to be freed before the process itself
        exits, or that ffmpeg is orphaned writing into RAM with nothing
        left alive to prune it (see cleanup_temp_root()'s docstring)."""
        sess = self._session
        self._session = None
        if sess is None or sess.closed:
            return
        if wait:
            try:
                sess.close()
            except Exception:
                pass
            return
        def _teardown() -> None:
            try:
                sess.close()
            except Exception:
                pass
        threading.Thread(target=_teardown, daemon=True,
                          name='remux-teardown-%s' % sess.id[:8]).start()

    def start_remux_session(self, source_type: str, source_ref: str, start_time: float,
                             video_track: Optional[int], audio_track: Optional[int],
                             probe_info: Optional[dict],
                             output_mode: str = 'mpegts') -> RemuxSession:
        with self._lock:
            self._close_current_locked()
            sess = RemuxSession('hls-remux', source_type, source_ref, start_time,
                                 video_track, audio_track)
            if probe_info:
                sess.original_duration = probe_info.get('duration')
                v = probe_info.get('video') or {}
                a = probe_info.get('audio') or {}
                sess.video_codec = v.get('codec')
                sess.audio_codec = a.get('codec')
                sess.audio_channels = a.get('channels')
                sess.container = 'mpegts-hls'
                # The bitrate-ceiling decision MUST be made here, before
                # sess.start() -> _launch() builds the ffmpeg arg list.
                # Unknown bitrate (None) deliberately leaves stream-copy in
                # place rather than guessing -- see source_video_bitrate().
                sess.source_video_bitrate = source_video_bitrate(probe_info, video_track)
                sess.video_transcode = (
                    sess.source_video_bitrate is not None
                    and sess.source_video_bitrate > MAX_SOURCE_VIDEO_BITRATE
                )
            # Container choice must also land BEFORE start() -> _launch().
            if output_mode == 'fmp4':
                sess.output_mode = 'fmp4'
                # MSE owns its own byte budget, so the bitrate ceiling (which
                # exists purely to bound the native pipeline) does not apply.
                sess.video_transcode = False
            # start() creates the temporary directory and launches ffmpeg; if the
            # launch fails (RemuxError -- e.g. a resume position past EOF, the
            # source dying between probe() and launch, or a seedr URL expiring
            # in that window) the half-started session is NEVER registered, so
            # without this teardown its already-created temp dir (RAM on the
            # TV) and any stderr-drain thread would leak on every failed start
            # -- accumulating orphaned temporary directories across repeated bad resumes
            # until the next server restart's cleanup_temp_root(). close() is
            # idempotent and safe on a session whose monitor thread never
            # started (start() launches it only AFTER _launch succeeds).
            try:
                sess.start()  # may raise RemuxError
            except Exception:
                try:
                    sess.close()
                except Exception:
                    pass
                raise
            self._session = sess
            return sess

    def start_direct_session(self, source_type: str, source_ref: str) -> RemuxSession:
        with self._lock:
            self._close_current_locked()
            sess = RemuxSession('direct', source_type, source_ref, 0.0, None, None)
            sess.state = 'running'
            sess.stream_copy = False  # not applicable -- no ffmpeg involved at all
            self._session = sess
            return sess

    def get(self, session_id: str) -> Optional[RemuxSession]:
        with self._lock:
            s = self._session
            if s is not None and s.id == session_id and not s.closed:
                return s
            return None

    def close(self, session_id: str) -> bool:
        with self._lock:
            s = self._session
            if s is not None and s.id == session_id:
                s.close()
                self._session = None
                return True
            return False

    def close_current(self) -> None:
        """Detach whatever session is active, if any -- NON-BLOCKING (see
        _close_current_locked). Used at the top of playback_start so
        opening ANY new playback (including the direct-seedr path, which
        creates no session of its own) detaches a prior remux/ffmpeg
        immediately, without paying its up-to-~10s teardown latency on the
        new session's own critical path."""
        with self._lock:
            self._close_current_locked()

    def close_current_blocking(self) -> None:
        """Synchronous variant for a graceful process shutdown (see the
        module's shutdown_all()) -- waits for the old session's ffmpeg to
        actually exit and its temporary directory to be freed before returning, so
        the process never exits while ffmpeg is still writing into RAM
        with no monitor thread left alive to prune it."""
        with self._lock:
            self._close_current_locked(wait=True)

    def _watchdog_loop(self) -> None:
        while True:
            time.sleep(5.0)
            with self._lock:
                s = self._session
            if s is None or s.closed:
                continue
            idle = time.monotonic() - s.tv_heartbeat
            if idle > _HEARTBEAT_TIMEOUT_SECONDS:
                try:
                    s.close()
                except Exception:
                    pass
                with self._lock:
                    if self._session is s:
                        self._session = None


# Module-level singleton -- the server imports this module once and all
# handler functions below route through this one manager, matching the
# "ONE active session" requirement server-wide (not per-connection).
_manager = SessionManager()


def active_source_path() -> Optional[str]:
    """Read-only accessor: the source_ref of the currently active session,
    or None if no session is open/it has been closed. Pure read, no I/O, no
    mutation of SessionManager/RemuxSession state -- exists solely so an
    external bolt-on disk cache (tv-service/cache.py) can pin the file that
    is actively being streamed against eviction, without that module ever
    reaching into remux.py's private state directly."""
    s = _manager._session
    if s is not None and not s.closed:
        return s.source_ref
    return None


# ===========================================================================
# Handler functions -- see the module docstring for the full contract.
# ===========================================================================

def _err(message: str, status: int = 400) -> dict:
    return {'error': message, 'status': status}


def playback_probe(body: dict) -> dict:
    """
    "Is this source safe to hand STRAIGHT to the TV?" -- the remux-OFF guard.

    Why this route has to exist at all: with the remux toggle off, the client
    never calls /playback/start, so no server-side cap can ever reach that
    path. But direct play is exactly where the TV is most exposed -- it gets
    the raw file, and a time-based native buffer can pin tens of megabytes
    without an application-level byte bound. At a 49s buffer depth, increasing
    the bitrate from 6.18 to 11 Mbps raises the buffer from about 38 to 67 MB. The only lever is bitrate, and lowering
    bitrate REQUIRES a transcode -- which only the remux engine can do. So the
    client asks this first and routes a too-hot release through the (capped)
    remux path instead of handing the TV a stream that will kill it.

    Deliberately cheap and side-effect free: one ffprobe, no session, no
    ffmpeg, nothing closed. Resolves a cached local copy first so it costs no
    network on an already-downloaded file.

    Returns {videoBitrate, ceiling, tooHigh, videoCodec, audioCodec}.
    videoBitrate/tooHigh are null/False when the bitrate can't be determined --
    callers MUST treat that as "proceed as before" and never block playback on
    it (an unknown-bitrate source is not evidence of a hot one).
    """
    source_ref = body.get('sourceReference')
    if not source_ref or not isinstance(source_ref, str):
        return _err('missing sourceReference', 400)
    video_track = body.get('selectedVideoTrack')
    if not isinstance(video_track, int):
        video_track = None
    try:
        ref = _resolve_cached_copy(_resolve_self_cache_ref(source_ref))
        info = probe_cached(ref)
        vbr = source_video_bitrate(info, video_track)
    except Exception as e:
        # Never fail the caller's playback over a probe -- report "unknown".
        return {'videoBitrate': None, 'ceiling': MAX_SOURCE_VIDEO_BITRATE,
                'tooHigh': False, 'videoCodec': None, 'audioCodec': None,
                'note': 'probe failed: %s' % e}
    return {
        'videoBitrate': vbr,
        'ceiling': MAX_SOURCE_VIDEO_BITRATE,
        'tooHigh': bool(vbr is not None and vbr > MAX_SOURCE_VIDEO_BITRATE),
        'videoCodec': (info.get('video') or {}).get('codec'),
        'audioCodec': (info.get('audio') or {}).get('codec'),
    }


def media_inspect(body: dict) -> dict:
    """Return player badges and chapter marks from the same memoized ffprobe
    used by the bitrate guard.

    This replaces two legacy Phone-only calls (/media/info and
    /media/chapters). It is deliberately one authenticated request and one
    probe, and callers launch it only after the first frame so optional UI
    metadata can never delay playback startup.
    """
    source_ref = body.get('url') or body.get('sourceReference')
    if not source_ref or not isinstance(source_ref, str):
        return _err('missing url', 400)
    try:
        ref = _resolve_cached_copy(_resolve_self_cache_ref(source_ref))
        info = probe_cached(ref)
    except Exception as exc:
        return _err('media inspect failed: %s' % exc, 502)

    raw = info.get('raw') or {}
    streams = raw.get('streams') or []
    video = None
    audio = []
    for stream in streams:
        kind = stream.get('codec_type')
        disposition = stream.get('disposition') or {}
        if kind == 'video' and not disposition.get('attached_pic') and video is None:
            pix_fmt = str(stream.get('pix_fmt') or '').lower()
            try:
                bit_depth = int(stream.get('bits_per_raw_sample') or 0)
            except (TypeError, ValueError):
                bit_depth = 0
            if bit_depth <= 0:
                bit_depth = 12 if ('12le' in pix_fmt or '12be' in pix_fmt) else (
                    10 if ('10le' in pix_fmt or '10be' in pix_fmt or 'p010' in pix_fmt) else 8)
            transfer = str(stream.get('color_transfer') or '').lower()
            side = json.dumps(stream.get('side_data_list') or []).lower()
            if 'dovi' in side or 'dolby vision' in side:
                hdr = 'Dolby Vision'
            elif transfer == 'smpte2084':
                hdr = 'HDR10'
            elif transfer == 'arib-std-b67':
                hdr = 'HLG'
            else:
                hdr = 'SDR'
            video = {
                'codec': stream.get('codec_name'),
                'width': stream.get('width'),
                'height': stream.get('height'),
                'bit_depth': bit_depth,
                'hdr': hdr,
            }
        elif kind == 'audio':
            tags = stream.get('tags') or {}
            profile = str(stream.get('profile') or '').lower()
            title = str(tags.get('title') or '').lower()
            side = json.dumps(stream.get('side_data_list') or []).lower()
            atmos = ('atmos' in profile or 'atmos' in title or 'joc' in profile
                     or 'joc' in title or 'atmos' in side or 'joc' in side)
            audio.append({
                'codec': stream.get('codec_name'),
                'channels': stream.get('channels') or 0,
                'layout': stream.get('channel_layout') or '',
                'atmos': bool(atmos),
                'lang': str(tags.get('language') or '').lower(),
                'default': bool(disposition.get('default')),
            })

    chapters = []
    for chapter in raw.get('chapters') or []:
        try:
            start = float(chapter.get('start_time') or chapter.get('start') or 0)
            end = float(chapter.get('end_time') or chapter.get('end') or start)
        except (TypeError, ValueError):
            continue
        chapters.append({
            'start': round(start, 3),
            'end': round(end, 3),
            'title': str((chapter.get('tags') or {}).get('title') or ''),
        })
    return {'ok': True, 'video': video, 'audio': audio, 'chapters': chapters}


def playback_start(body: dict) -> dict:
    try:
        source_type = body.get('sourceType')
        source_ref = body.get('sourceReference')
        remux_enabled = bool(body.get('remuxEnabled', False))
        try:
            start_time = float(body.get('startTime') or 0.0)
        except (TypeError, ValueError):
            start_time = 0.0
        video_track = body.get('selectedVideoTrack')
        audio_track = body.get('selectedAudioTrack')
        if not isinstance(video_track, int):
            video_track = None
        if not isinstance(audio_track, int):
            audio_track = None

        if source_type not in ('seedr', 'phone', 'usb'):
            return _err('invalid sourceType (expected seedr|phone|usb)', 400)
        if not source_ref or not isinstance(source_ref, str):
            return _err('missing sourceReference', 400)

        # Security: phone/usb sources must be plain absolute filesystem
        # paths -- SAF content-URIs and USB-OTG special handling are
        # explicitly out of scope for this build (phase 2), and we never
        # accept an arbitrary remote URL as a "phone"/"usb" source from
        # an untrusted LAN client (that's what 'seedr' is for -- a
        # server-issued signed URL, never a client-supplied one).
        if source_type in ('phone', 'usb'):
            if source_ref.startswith(('http://', 'https://')):
                return _err('phone/usb sourceReference must be a local filesystem path, not a URL', 400)
            p = Path(source_ref)
            if not p.is_absolute():
                return _err('phone/usb sourceReference must be an absolute path', 400)

        # Opening ANY new playback ends the previously active session first --
        # including the direct-seedr branch below, which creates no session of
        # its own, so a prior remux's ffmpeg can never keep running.
        _manager.close_current()

        if not remux_enabled:
            return _start_direct(source_type, source_ref, start_time)

        # 'fmp4' opts this session into the MSE path. Anything else (including
        # absent) keeps the shipped MPEG-TS behaviour byte-for-byte, so an old
        # client that knows nothing about this field is unaffected.
        output_mode = 'fmp4' if str(body.get('outputMode') or '').lower() == 'fmp4' else 'mpegts'
        return _start_remux(source_type, source_ref, start_time, video_track, audio_track,
                            output_mode=output_mode)
    except Exception as e:
        return _err(f'internal error: {e}', 500)


def _start_direct(source_type: str, source_ref: str, start_time: float) -> dict:
    """
    remuxEnabled == False. Preserves the pre-existing direct-play path:
      - seedr: hand back the signed URL as-is, no session created (it's
        already an unguessable, time-limited URL -- no extra gating adds
        real security here, and the server's existing direct-play
        handling for seedr already knows how to serve it).
      - phone/usb: create a lightweight token-gated 'direct' session so
        the TV fetches the file through a capability-token URL rather
        than a raw filesystem path ever reaching an untrusted client.
    """
    if source_type == 'seedr':
        return {
            'sessionId': None,
            'playbackMode': 'direct',
            'playbackUrl': source_ref,
            'originalDuration': None,
            'actualStartTime': start_time,
            'videoCodec': None,
            'audioCodec': None,
            'container': None,
        }

    # phone/usb only below -- source_ref is already guaranteed a local
    # absolute path by playback_start()'s validation, so this is a no-op in
    # practice today; kept for consistency with _start_remux and so a future
    # phone/usb-shaped self-referential cache URL is handled the same way.
    source_ref = _resolve_self_cache_ref(source_ref)

    p = Path(source_ref)
    if not p.exists() or not p.is_file():
        return _err('file not found', 404)

    info = {}
    try:
        info = probe_cached(source_ref)
    except RemuxError:
        info = {}  # non-fatal for direct mode -- codec info is informational only here

    sess = _manager.start_direct_session(source_type, source_ref)
    video = (info.get('video') or {})
    audio = (info.get('audio') or {})
    return {
        'sessionId': sess.id,
        'playbackMode': 'direct',
        'playbackUrl': f'/playback/{sess.id}/file',
        'originalDuration': info.get('duration'),
        'actualStartTime': start_time,
        'videoCodec': video.get('codec'),
        'audioCodec': audio.get('codec'),
        'container': info.get('container'),
    }


def _start_remux(source_type: str, source_ref: str, start_time: float,
                  video_track: Optional[int], audio_track: Optional[int],
                  output_mode: str = 'mpegts') -> dict:
    # Rewrite our own /cache/stream/<name> URL back to the local cache file
    # (see _resolve_self_cache_ref) BEFORE probe()/session creation, so
    # every downstream consumer of source_ref -- probe(), the keyframe
    # lookup on every seek, and the ffmpeg -i arg in _launch() -- reads
    # straight off local disk instead of looping the request back through
    # our own HTTP server. Applied exactly once here: RemuxSession stores
    # whatever source_ref it's constructed with, so seek()/_launch() (which
    # reuse self.source_ref, never a fresh value from the request body)
    # automatically see the already-rewritten local path too.
    source_ref = _resolve_self_cache_ref(source_ref)
    # ...and if it's a REMOTE url we already hold a finished copy of, play the
    # local file instead of re-streaming it. Must be applied here for the same
    # "exactly once, before the session stores it" reason as the line above --
    # that is what makes every subsequent seek use the local path too, which is
    # precisely where the seedr 429 stall used to happen.
    source_ref = _resolve_cached_copy(source_ref)

    if source_type in ('phone', 'usb'):
        p = Path(source_ref)
        if not p.exists() or not p.is_file():
            return _err('file not found', 404)

    if not ensure_ffmpeg_staged():
        return _err('ffmpeg is not available on this device', 500)

    try:
        info = probe_cached(source_ref)
    except RemuxError as e:
        return _err(f'probe failed: {e}', 502)

    ok, reason = can_stream_copy(info, video_track, audio_track)
    if not ok:
        # Hard requirement: NEVER silently transcode or fall back --
        # surface a clear, specific error instead.
        return _err(f'unsupported format for stream-copy remux: {reason}', 415)

    try:
        sess = _manager.start_remux_session(
            source_type, source_ref, start_time, video_track, audio_track, info,
            output_mode=output_mode)
    except RemuxError as e:
        return _err(f'failed to start remux: {e}', 500)

    return {
        'sessionId': sess.id,
        'playbackMode': 'hls-remux',
        'playbackUrl': f'/playback/{sess.id}/master.m3u8',
        'originalDuration': sess.original_duration,
        'actualStartTime': sess.actual_start_time,
        'videoCodec': sess.video_codec,
        'audioCodec': sess.audio_codec,
        'container': 'mpegts-hls',
    }


def playback_seek(sid: str, body: dict) -> dict:
    sess = _manager.get(sid)
    if sess is None:
        return _err('unknown or expired session', 404)
    if sess.mode != 'hls-remux':
        return _err('seek is only applicable to hls-remux sessions', 400)
    try:
        absolute_time = float(body.get('absoluteTime') or 0.0)
    except (TypeError, ValueError):
        return _err('invalid absoluteTime', 400)
    try:
        actual = sess.seek(absolute_time)
    except RemuxError as e:
        return _err(f'seek failed: {e}', 500)
    return {'actualStartTime': actual}


def playback_pause(sid: str) -> dict:
    sess = _manager.get(sid)
    if sess is None:
        return _err('unknown or expired session', 404)
    if sess.mode != 'hls-remux':
        return _err('pause is only applicable to hls-remux sessions', 400)
    try:
        sess.pause()
    except RemuxError as e:
        return _err(str(e), 500)
    return {'ok': True, 'state': sess.state}


def playback_resume(sid: str) -> dict:
    sess = _manager.get(sid)
    if sess is None:
        return _err('unknown or expired session', 404)
    if sess.mode != 'hls-remux':
        return _err('resume is only applicable to hls-remux sessions', 400)
    try:
        sess.resume()
    except RemuxError as e:
        return _err(str(e), 500)
    return {'ok': True, 'state': sess.state}


def playback_delete(sid: str) -> dict:
    ok = _manager.close(sid)
    return {'ok': ok}


def playback_status(sid: str) -> dict:
    sess = _manager.get(sid)
    if sess is None:
        return _err('unknown or expired session', 404)
    # A status poll from the TV app is itself a liveness signal (it's
    # normally driven by the TV's own playback UI while a video is
    # open), so it counts toward the heartbeat/disconnect-timeout logic
    # the same way playlist/segment fetches do.
    sess.heartbeat()
    return sess.status()


def get_playlist(sid: str):
    """Returns (bytes, mime) or (None, None) if not found/not ready."""
    sess = _manager.get(sid)
    if sess is None or sess.mode != 'hls-remux' or sess.temp_dir is None:
        return None, None
    sess.heartbeat()
    playlist_path = sess.temp_dir / 'index.m3u8'
    if not playlist_path.exists():
        return None, None
    try:
        data = playlist_path.read_bytes()
    except OSError:
        return None, None
    # The segment muxer writes a plain m3u8 with no playlist type. Inject
    # EXT-X-PLAYLIST-TYPE:EVENT so webOS treats it as a growing VOD and starts
    # at the BEGINNING instead of the live edge. Idempotent.
    if b'EXT-X-PLAYLIST-TYPE' not in data and data.startswith(b'#EXTM3U'):
        nl = data.find(b'\n')
        if nl != -1:
            data = data[:nl + 1] + b'#EXT-X-PLAYLIST-TYPE:EVENT\n' + data[nl + 1:]
    return data, HLS_PLAYLIST_MIME


_IDR_STEP_SECONDS = float(os.environ.get('DUMIFLIX_IDR_STEP_SECONDS', '4'))
_IDR_MAX_STEPS = int(os.environ.get('DUMIFLIX_IDR_MAX_STEPS', '6'))


def _decode_ref_errors(source_ref: str, start: float, probe_seconds: float = 2.0) -> int:
    """Count HEVC reference-picture errors when decoding from `start`.

    Not every keyframe is a safe place to BEGIN a stream-copied HEVC stream.
    An open-GOP CRA picture is flagged as a keyframe, but its leading (RASL)
    frames reference pictures BEFORE it -- pictures that were never emitted
    when we cut there. The decoder then discards them, which is why a
    mid-stream 4K seek produced a video track with ~6-second holes while the
    audio was perfectly continuous, and why playback wedged at the first hole.
    A session started at t=0 has no such leading pictures and decodes clean --
    that contrast is what pinned this down.
    ffprobe cannot tell IDR from CRA directly, so ask the decoder: it reports
    "Could not find ref with POC" / "Error constructing the frame RPS" exactly
    when we have cut in the wrong place.
    """
    # MUST be copy-then-decode, in two stages. Decoding the SOURCE directly --
    # with or without -noaccurate_seek -- always reports clean, because ffmpeg's
    # decoder recognises RASL pictures after a CRA and discards them silently.
    # The damage only exists in the COPIED output, where those same frames were
    # passed through verbatim and their references were not. So: copy exactly
    # the way the session copies, then decode THAT, which is what the TV's
    # decoder will face. Two earlier single-stage versions of this probe both
    # returned 0 for every candidate and made the search a no-op.
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(suffix='.ts', prefix='idrprobe-')
        os.close(fd)
        c = subprocess.run(
            [FFMPEG_BIN, '-nostdin', '-hide_banner', '-v', 'error', '-y',
             '-noaccurate_seek', '-ss', str(max(0.0, start)), '-i', source_ref,
             '-map', '0:v:0', '-c:v', 'copy', '-t', str(probe_seconds),
             '-f', 'mpegts', tmp],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            env={**os.environ, **FF_ENV}, timeout=60,
        )
        if c.returncode != 0 or not os.path.getsize(tmp):
            return 0
        d = subprocess.run(
            [FFMPEG_BIN, '-nostdin', '-hide_banner', '-v', 'error',
             '-i', tmp, '-map', '0:v:0', '-f', 'null', '-'],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            env={**os.environ, **FF_ENV}, timeout=60,
        )
        err = (d.stderr or b'').decode('utf-8', 'replace')
        return err.count('POC') + err.count('RPS')
    except Exception:
        return 0          # fail OPEN: never block playback on a probe
    finally:
        if tmp:
            try: os.unlink(tmp)
            except Exception: pass


def find_clean_hevc_start(source_ref: str, target: float) -> float:
    """Nearest start at/before `target` that decodes without missing references.

    Walks backwards in _IDR_STEP_SECONDS increments, decode-probing each
    candidate, and returns the first clean one. Falls back to `target`
    unchanged if nothing verifies -- a slightly imperfect start is far better
    than refusing to play. Only worth doing for stream-COPIED HEVC; H.264
    closed-GOP content (the whole TS path) never exhibits this.
    """
    t = max(0.0, float(target or 0.0))
    if t <= 0:
        return 0.0
    for step in range(_IDR_MAX_STEPS + 1):
        cand = max(0.0, t - step * _IDR_STEP_SECONDS)
        if _decode_ref_errors(source_ref, cand) == 0:
            return cand
        if cand <= 0:
            break
    return t


def _iter_boxes(buf: bytes, start: int, end: int):
    """Yield (fourcc, payload_start, payload_end) for ISO-BMFF boxes in a range."""
    i = start
    while i + 8 <= end:
        size = int.from_bytes(buf[i:i + 4], 'big')
        typ = buf[i + 4:i + 8]
        if size == 1:                       # 64-bit largesize
            if i + 16 > end:
                return
            size = int.from_bytes(buf[i + 8:i + 16], 'big')
            body = i + 16
        elif size == 0:                     # extends to end of file
            size = end - i
            body = i + 8
        else:
            body = i + 8
        if size < 8 or i + size > end:
            return
        yield typ, body, i + size
        i += size


def _find_box(buf: bytes, path: tuple, start: int = 0, end: Optional[int] = None):
    """Walk a nested box path, e.g. (b'moov',b'trak',b'mdia',b'minf',b'stbl',b'stsd')."""
    end = len(buf) if end is None else end
    if not path:
        return (start, end)
    for typ, b, e in _iter_boxes(buf, start, end):
        if typ == path[0]:
            got = _find_box(buf, path[1:], b, e)
            if got:
                return got
    return None


def mse_codec_from_init(init_bytes: bytes) -> Optional[str]:
    """
    Build the RFC 6381 codec string MSE needs, FROM THE INIT SEGMENT'S OWN BYTES.

    Deliberately not derived from ffprobe's `profile`/`level` fields: those are
    human-readable names ("High", "Main 10") that have to be mapped back to
    numeric idc values by hand, and a single wrong digit makes
    `addSourceBuffer()` throw NotSupportedError with no useful diagnostic. The
    avcC/hvcC box already contains the exact bytes the codec string encodes, so
    reading them is both shorter and impossible to get subtly wrong.

    Returns e.g. 'avc1.640028' or 'hvc1.2.4.L153.B0', or None if the init
    segment can't be parsed (caller should then refuse the MSE path rather
    than guess).
    """
    codecs = []
    moov = _find_box(init_bytes, (b'moov',))
    if not moov:
        return None
    # EVERY track must be declared, not just video. ffmpeg muxes video AND audio
    # into ONE fMP4 byte stream (init has two trak boxes, each fragment two traf
    # boxes), and MSE rejects an append whose stream contains a track the
    # SourceBuffer's codecs list never mentioned. Declaring only the video codec
    # is the subtlest possible version of this bug: isTypeSupported() returns
    # true, addSourceBuffer() succeeds, init and fragments fetch cleanly -- and
    # then the very first appendBuffer is refused and the element reports a flat
    # MEDIA_ERR_SRC_NOT_SUPPORTED with nothing pointing at the audio track.
    for _t, tb, te in _iter_boxes(init_bytes, moov[0], moov[1]):
        if _t != b'trak':
            continue
        c = _codec_for_trak(init_bytes, tb, te)
        if c and c not in codecs:
            codecs.append(c)
    return ','.join(codecs) if codecs else None


def _codec_for_trak(init_bytes: bytes, tb: int, te: int) -> Optional[str]:
    """RFC 6381 codec string for ONE trak, or None if unrecognised."""
    try:
        stsd = _find_box(init_bytes, (b'mdia', b'minf', b'stbl', b'stsd'), tb, te)
        if not stsd:
            return None
        s, e = stsd
        # stsd payload: 4 bytes version/flags, 4 bytes entry_count, then entries.
        for typ, b, be in _iter_boxes(init_bytes, s + 8, e):
            fourcc = typ.decode('latin1')
            if fourcc in ('avc1', 'avc3'):
                # VisualSampleEntry has 78 bytes of fixed fields before children.
                cfg = _find_box(init_bytes, (b'avcC',), b + 78, be)
                if not cfg:
                    continue
                cs, _ce = cfg
                d = init_bytes[cs:cs + 4]
                if len(d) < 4:
                    continue
                return 'avc1.%02X%02X%02X' % (d[1], d[2], d[3])
            if fourcc in ('hvc1', 'hev1'):
                cfg = _find_box(init_bytes, (b'hvcC',), b + 78, be)
                if not cfg:
                    continue
                cs, _ce = cfg
                d = init_bytes[cs:cs + 13]
                if len(d) < 13:
                    continue
                b1 = d[1]
                profile_space = (b1 >> 6) & 0x03
                tier_flag = (b1 >> 5) & 0x01
                profile_idc = b1 & 0x1F
                compat = int.from_bytes(d[2:6], 'big')
                # The compatibility flags go into the string bit-REVERSED.
                rev = int('{:032b}'.format(compat)[::-1], 2)
                constraints = d[6:12]
                parts = ['hvc1',
                         '%s%d' % (['', 'A', 'B', 'C'][profile_space], profile_idc),
                         '%X' % rev,
                         '%s%d' % ('LH'[tier_flag], d[12])]
                # Trailing all-zero constraint bytes are omitted by convention.
                cbytes = list(constraints)
                while cbytes and cbytes[-1] == 0:
                    cbytes.pop()
                parts += ['%02X' % c for c in cbytes]
                return '.'.join(parts)
            if fourcc == 'mp4a':
                # AudioSampleEntry carries 28 bytes of fixed fields before its
                # child boxes. The codec string is
                # mp4a.<objectTypeIndication>.<audioObjectType>; for the AAC we
                # always produce that is mp4a.40.2 (MPEG-4 audio / AAC-LC).
                # Parsed rather than hardcoded, but defaulting to AAC-LC because
                # that is what _audio_args() emits and a wrong AOT here would
                # fail the append exactly as silently as omitting the track did.
                oti, aot = 0x40, 2
                try:
                    esds = _find_box(init_bytes, (b'esds',), b + 28, be)
                    if esds:
                        blob = init_bytes[esds[0] + 4:esds[1]]   # skip version/flags
                        j = blob.find(b'\x04')                   # DecoderConfigDescriptor
                        if j >= 0:
                            k = j + 1
                            while k < len(blob) and (blob[k] & 0x80):  # varint length
                                k += 1
                            k += 1
                            if k < len(blob):
                                oti = blob[k]
                        j = blob.find(b'\x05')                   # DecoderSpecificInfo
                        if j >= 0:
                            k = j + 1
                            while k < len(blob) and (blob[k] & 0x80):
                                k += 1
                            k += 1
                            if k < len(blob):
                                aot = (blob[k] >> 3) & 0x1F
                except Exception:
                    oti, aot = 0x40, 2
                return 'mp4a.%02X.%d' % (oti, aot or 2)
            if fourcc in ('ac-3', 'ec-3'):
                return fourcc
    except Exception:
        return None
    return None


def get_segment(sid: str, seg_name: str) -> Optional[Path]:
    """
    Returns the Path to a segment file for the server to Range-stream,
    or None if the session/segment doesn't exist. `seg_name` is
    strictly validated against `seg_NNNNN.ts` to prevent any path
    traversal via a crafted segment name in the URL.
    """
    sess = _manager.get(sid)
    if sess is None or sess.mode != 'hls-remux' or sess.temp_dir is None:
        return None
    # init.mp4 is the fMP4 mode's initialization segment (moov): unnumbered,
    # fetched exactly once before any fragment. Allowing it by exact-string
    # equality keeps the traversal guarantee -- no separator, no '..', nothing
    # user-shaped ever reaches the join below.
    if seg_name != _INIT_NAME and not _SEG_NAME_RE.match(seg_name):
        return None
    path = sess.temp_dir / seg_name
    if not path.exists() or not path.is_file():
        return None
    sess.note_segment_fetched(seg_name)
    return path


def get_direct_file(sid: str) -> Optional[Path]:
    """
    Returns the Path for a 'direct'-mode (remux OFF, phone/usb) session
    for the server to Range-stream, or None if not found/wrong mode.
    """
    sess = _manager.get(sid)
    if sess is None or sess.mode != 'direct':
        return None
    sess.heartbeat()
    path = Path(sess.source_ref)
    if not path.exists() or not path.is_file():
        return None
    return path


# ---------------------------------------------------------------------------
# Scrub-preview thumbnails (streaming-style seek previews).
#
# OFF unless DUMIFLIX_THUMBS=1. Enable only with disk-backed temporary storage
# and sufficient CPU so preview generation does not compete with live remuxing.
# Each preview is one 320px JPEG
# (~10-20 KB) generated on demand into the SESSION's temp dir, so the whole
# set is reaped with the session by the exact same cleanup that already
# bounds segments. Times bucket to 5s so scrubbing back and forth re-serves
# the same file, and the count cap bounds worst-case disk to a few MB.
# ---------------------------------------------------------------------------
_THUMBS_ENABLED = os.environ.get('DUMIFLIX_THUMBS', '0') == '1'
_THUMB_BUCKET_SECONDS = 5
_THUMB_MAX_FILES = 240          # ~15 KB each -> <=~4 MB per session
_thumb_lock = threading.Lock()  # one generator ffmpeg at a time; bursts queue


def playback_thumbnail(sid: str, t: float) -> Optional[Path]:
    if not _THUMBS_ENABLED:
        return None
    sess = _manager.get(sid)
    if sess is None or sess.temp_dir is None:
        return None
    try:
        bucket = max(0, int(float(t) // _THUMB_BUCKET_SECONDS) * _THUMB_BUCKET_SECONDS)
    except (TypeError, ValueError):
        return None
    td = sess.temp_dir / 'thumbs'
    out = td / ('%d.jpg' % bucket)
    if out.is_file():
        return out
    with _thumb_lock:
        if out.is_file():                # generated while we waited for the lock
            return out
        try:
            td.mkdir(parents=True, exist_ok=True)
            jpgs = sorted(td.glob('*.jpg'), key=lambda p: p.stat().st_mtime)
            while len(jpgs) >= _THUMB_MAX_FILES:
                try:
                    jpgs.pop(0).unlink()
                except OSError:
                    break
            part = td / ('%d.part.jpg' % bucket)
            cmd = [
                FFMPEG_BIN, '-nostdin', '-hide_banner', '-loglevel', 'error',
                '-ss', str(bucket), '-i', sess.source_ref,
                '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '7',
                '-y', '-f', 'image2', str(part),
            ]
            kw = {'capture_output': True, 'timeout': 6,
                  'env': {**os.environ, **FF_ENV}}
            if _IS_WIN:
                kw['creationflags'] = (subprocess.CREATE_NO_WINDOW
                                       | subprocess.BELOW_NORMAL_PRIORITY_CLASS)
            subprocess.run(cmd, **kw)
            if part.is_file() and part.stat().st_size > 0:
                os.replace(part, out)
                return out
            try:
                part.unlink()
            except OSError:
                pass
        except Exception:
            pass
    return None
