#!/usr/bin/env python3
"""Subtitle audio-sync for the tv-service remux engines (local or optional remote engine).

PRIMARY (when a Whisper model is configured): MULTI-SAMPLE alignment. A
handful of short (~60s) windows spread across the middle of the file are
transcribed with ffmpeg's `whisper` filter IN PARALLEL, each aligned
independently to the passed-in subtitle's cue text (difflib text matching,
nearest in time), and the resulting (anchor_time, offset) points are fit for
either a constant offset or a linear DRIFT (offset that grows across the
episode -- a framerate mismatch a single sample can never distinguish from
noise). See _whisper_multi_offset(). Seconds, not the ~15 minutes a full-file
transcription would cost -- this is alignment, not transcription: only a
few short samples are ever decoded, never the whole track.

FALLBACK (no Whisper model, or every sampled window failed outright): decodes
the source's ACTUAL audio (ffmpeg silencedetect -> speech intervals) and
mean-subtracted normalized cross-correlates it against the subtitle's cue
timings to measure a constant offset. Uses the engine's env-configured
ffmpeg (a string path) + FF_ENV so it can decode a seedr HTTPS
URL directly on the engine host without a proxy through another client.

Pure stdlib (no numpy). Exposed to the server via handle_subsync(body) -> dict.
"""
import os
import re
import sys
import time
import difflib
import hashlib
import statistics
import subprocess
import threading

from concurrent.futures import ThreadPoolExecutor, as_completed

from remux import FFMPEG_BIN, FF_ENV, probe as _remux_probe   # reuse the engine's ffmpeg + SSL env

# Whisper ASR model (ggml, for the ffmpeg `whisper` filter). When set + present,
# subsync aligns TRANSCRIBED WORDS to the subtitle text -- far more accurate +
# confident than silencedetect cross-correlation, which keys off any sound.
_WHISPER_MODEL = os.environ.get('DUMIFLIX_WHISPER_MODEL', '').strip()


def _has_whisper():
    return bool(_WHISPER_MODEL) and os.path.isfile(_WHISPER_MODEL) and os.path.exists(str(FFMPEG_BIN))


def subgen_enabled():
    """True if background/on-demand SUBTITLE GENERATION (as opposed to the
    alignment-only handle_subsync() below) should run on this host: a
    Whisper model is configured + present, and the caller hasn't opted out
    via DUMIFLIX_SUBGEN_ENABLED=0. Defaults ON whenever a model is actually
    usable -- no env var needed on a host that has one; a host with none is
    off regardless of the flag (there is nothing to generate with)."""
    if not _has_whisper():
        return False
    return os.environ.get('DUMIFLIX_SUBGEN_ENABLED', '1') != '0'


def sub_sidecar_rel(rel):
    """Cache-relative path of the LEGACY generated-subtitle sidecar for
    `rel` -- single source of truth for the naming convention cache.py's
    eviction/listing code relies on to clean up any '<rel>.en.srt' left
    over from the retired whole-file-generation design (see
    generate_sub() below). Superseded for new subtitle work by the
    fingerprinted CACHE_ROOT/.subs/<rel>/ tree cache.py now owns."""
    return str(rel) + '.en.srt'


def ffsubsync_bin():
    """Path to the ffsubsync CLI (DUMIFLIX_FFSUBSYNC env, or on PATH), or ''.
    ffsubsync (github.com/smacke/ffsubsync) is the industry-standard aligner:
    10ms-window VAD speech fingerprint x FFT cross-correlation over the WHOLE
    file, framerate-drift aware, no model needed. Made PRIMARY here because
    Whisper segment timestamps can carry an early bias that shifts
    an already correct subtitle. Whole-file speech fingerprint alignment
    provides an independent correction without that transcription bias."""
    p = os.environ.get('DUMIFLIX_FFSUBSYNC') or ''
    if p and os.path.isfile(p):
        return p
    try:
        import shutil as _sh
        return _sh.which('ffsubsync') or ''
    except Exception:
        return ''


def ffsubsync_available():
    return bool(ffsubsync_bin())


_FFS_OFFSET_RE = re.compile(r'offset seconds:\s*(-?[\d.]+)')
_FFS_SCALE_RE = re.compile(r'framerate scale factor:\s*([\d.]+)')


def measure_offset_ffsubsync(path, srt_text, max_offset_seconds=120, timeout=300):
    """Align `srt_text` against LOCAL media `path` with ffsubsync. Returns a
    measure_offset_progressive()-shaped dict ({'offset','scale','reliable',
    'confidence','pass'}) or None on any failure (caller falls back to the
    whisper/silencedetect tiers). Offset semantics match the whisper tier:
    the amount to ADD to cue times."""
    exe = ffsubsync_bin()
    if not exe or not os.path.isfile(path):
        return None
    import tempfile as _tf
    tmp_in = tmp_out = None
    try:
        fd, tmp_in = _tf.mkstemp(suffix='.srt', prefix='ffs_in_')
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(srt_text)
        fd, tmp_out = _tf.mkstemp(suffix='.srt', prefix='ffs_out_')
        os.close(fd)
        cmd = [exe, path, '-i', tmp_in, '-o', tmp_out,
               '--max-offset-seconds', str(int(max_offset_seconds))]
        kw = dict(capture_output=True, text=True, encoding='utf-8',
                  errors='replace', timeout=timeout)
        if os.name == 'nt':
            kw['creationflags'] = (subprocess.CREATE_NO_WINDOW
                                   | subprocess.BELOW_NORMAL_PRIORITY_CLASS)
        r = subprocess.run(cmd, **kw)
        out = (r.stdout or '') + (r.stderr or '')
        m_off = _FFS_OFFSET_RE.search(out)
        if not m_off:
            return None
        offset = float(m_off.group(1))
        m_sc = _FFS_SCALE_RE.search(out)
        scale = float(m_sc.group(1)) if m_sc else 1.0
        if not (abs(offset) <= max_offset_seconds and 0.8 <= scale <= 1.25):
            return None
        return {'ok': True, 'offset': round(offset, 3), 'scale': scale,
                'reliable': True, 'confidence': None, 'pass': 'ffsubsync'}
    except Exception as e:
        print('[subsync] ffsubsync: %s' % e, file=sys.stderr)
        return None
    finally:
        for p2 in (tmp_in, tmp_out):
            if p2:
                try:
                    os.unlink(p2)
                except OSError:
                    pass


def whisper_available():
    """Public wrapper around _has_whisper() -- so cache.py (and any other
    sibling module) doesn't need to reach into a leading-underscore name
    from this module."""
    return _has_whisper()


# Embedded TEXT subtitle codecs (R3) -- explicitly excludes bitmap formats
# (hdmv_pgs_subtitle/dvd_subtitle/xsub) that can't be extracted to .srt text.
TEXT_SUB_CODECS = frozenset({'subrip', 'ass', 'ssa', 'mov_text'})


_FORCED_TITLE_RE = re.compile(r'forced|foreign', re.I)
_SDH_TITLE_RE = re.compile(r'\bsdh\b|hearing|\bhi\b|caption', re.I)


def _sub_track_score(c):
    """Rank an embedded text-sub candidate. HIGHER IS BETTER.

    A forced track contains only selected foreign-language lines rather
    than full dialogue. Releases may still mark that track as the default,
    so selecting the first English/default track can produce sparse subs.
    For example, a forced track may contain only a few dozen cues while a
    full dialogue or SDH track contains hundreds. Prefer complete tracks
    even when the container's default flag points at the forced variant.

    So: English first, then NON-forced (dominant), then plain dialogue over
    SDH (SDH is complete but adds '[door creaks]' annotations). `default` is
    only a last tie-break precisely because forced tracks abuse it.
    """
    score = 0
    if c['lang'] in ('eng', 'en'):
        score += 1000
    elif not c['lang'] or c['lang'] in ('und', 'unk'):
        score += 200          # untagged is usually the release's main language
    if not c['forced']:
        score += 500          # dominant: never take a forced track if a full one exists
    if not c['sdh']:
        score += 50
    if c['default']:
        score += 5
    return score


def probe_embedded_text_tracks(local_path):
    """ALL embedded TEXT subtitle tracks (subrip/ass/ssa/mov_text -- see
    TEXT_SUB_CODECS) in a LOCAL media file, BEST FIRST (see
    _sub_track_score). Uses the existing remux.probe()'s full ffprobe JSON
    (info['raw']['streams']). Each entry is {index (absolute ffprobe stream
    index), lang, codec, forced, sdh, default, title}. Empty list when there
    is no text-sub track or the probe failed -- never raises.

    Returning the RANKED LIST rather than one pick lets the extractor fall
    through to the next candidate when the winner turns out to be near-empty
    (a mislabelled forced track), which flags alone cannot always catch."""
    try:
        info = _remux_probe(str(local_path), timeout=20.0)
    except Exception as e:
        print('[subsync] probe_embedded_text_tracks: %s' % e, file=sys.stderr)
        return []
    streams = ((info.get('raw') or {}).get('streams')) or []
    candidates = []
    for s in streams:
        if s.get('codec_type') != 'subtitle':
            continue
        codec = s.get('codec_name')
        if codec not in TEXT_SUB_CODECS:
            continue
        idx = s.get('index')
        if idx is None:
            continue
        tags = s.get('tags') or {}
        disp = s.get('disposition') or {}
        title = (tags.get('title') or '').strip()
        lang = (tags.get('language') or '').strip().lower() or None
        # Trust EITHER the disposition flag or the title text: plenty of
        # releases label a forced track only in its title, and others only
        # via the flag.
        forced = bool(disp.get('forced')) or bool(_FORCED_TITLE_RE.search(title))
        sdh = bool(disp.get('hearing_impaired')) or bool(_SDH_TITLE_RE.search(title))
        candidates.append({'index': idx, 'lang': lang, 'codec': codec,
                           'forced': forced, 'sdh': sdh,
                           'default': bool(disp.get('default')), 'title': title})
    candidates.sort(key=_sub_track_score, reverse=True)
    return candidates


def probe_embedded_text_track(local_path):
    """Best embedded TEXT subtitle track, or None. Thin wrapper over
    probe_embedded_text_tracks() kept for existing callers."""
    tracks = probe_embedded_text_tracks(local_path)
    return tracks[0] if tracks else None


def count_srt_cues(text):
    """Number of cues in an SRT body -- just the timing-line count. Used to
    reject a near-empty extraction (a forced track that neither its
    disposition nor its title admitted to being one)."""
    return text.count('-->')


_EXTRACT_LOCK = threading.Lock()
_EXTRACT_BUSY = set()
_EXTRACT_FAILURES = {}  # (canonical path, track or None) -> (identity, monotonic deadline, reason)
_EXTRACT_RETRY_SECONDS = 30 * 60


class TextSubtitleExtractionDeferred:
    """False-valued temporary result, distinct from a failed conversion.

    Callers must not persist this as proof that embedded subtitles are
    absent. retry_after is a Unix timestamp suitable for a retry gate.
    """
    def __init__(self, retry_after, reason):
        self.retry_after = retry_after
        self.reason = reason

    def __bool__(self):
        return False


def _extraction_deferred(reason):
    return TextSubtitleExtractionDeferred(time.time() + _EXTRACT_RETRY_SECONDS, reason)


def _text_extract_timeout(size):
    # Demuxing a text track still scans the WHOLE container. Budget for a
    # busy USB HDD delivering only 4 MiB/s, plus two minutes of startup/slack.
    return 120.0 + max(0, size) / (4 * 1024 ** 2)


def extract_text_subtitle(local_path, stream_index, out_path, gentle=True):
    """Extract once per file at a time; back off failures for 30 minutes.

    Conversion failures cool down only that track, allowing healthy alternate
    tracks. Timeouts and OS failures defer the entire file, avoiding repeated
    full-file scans on a busy drive. Returns True, False (track conversion
    failed), or a false-valued TextSubtitleExtractionDeferred (try later).
    Size/mtime/inode changes invalidate process-local cooldowns, independent
    of the caller's temporary output name.
    """
    try:
        path = os.path.normcase(os.path.realpath(local_path))
        st = os.stat(path)
        identity = (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
    except (OSError, TypeError, ValueError):
        return False
    with _EXTRACT_LOCK:
        now = time.monotonic()
        # Drop expired records so failures don't accumulate over server uptime.
        for key, (_identity, deadline, _reason) in list(_EXTRACT_FAILURES.items()):
            if deadline <= now:
                del _EXTRACT_FAILURES[key]
        if path in _EXTRACT_BUSY:
            return TextSubtitleExtractionDeferred(time.time() + 5, 'file is already extracting')
        for key in ((path, None), (path, stream_index)):
            failed = _EXTRACT_FAILURES.get(key)
            if failed and failed[0] == identity:
                return TextSubtitleExtractionDeferred(time.time() + failed[1] - now, failed[2])
        _EXTRACT_BUSY.add(path)
    ok = False
    try:
        ok = _extract_text_subtitle(path, stream_index, out_path, gentle,
                                    _text_extract_timeout(st.st_size))
        return ok
    finally:
        with _EXTRACT_LOCK:
            _EXTRACT_BUSY.discard(path)
            if isinstance(ok, TextSubtitleExtractionDeferred):
                _EXTRACT_FAILURES[(path, None)] = (
                    identity, time.monotonic() + _EXTRACT_RETRY_SECONDS, ok.reason)
            elif ok:
                _EXTRACT_FAILURES.pop((path, stream_index), None)
            else:
                _EXTRACT_FAILURES[(path, stream_index)] = (
                    identity, time.monotonic() + _EXTRACT_RETRY_SECONDS, 'track conversion failed')


def _extract_text_subtitle(local_path, stream_index, out_path, gentle, timeout):
    """Extract embedded text-subtitle stream `stream_index` (an ABSOLUTE
    ffprobe stream index, as returned by probe_embedded_text_track) from
    `local_path` to `out_path` as .srt via `ffmpeg -c:s srt`. Atomic
    (writes '<out_path>.part' then os.replace()s over the final name).
    `gentle` lowers the ffmpeg subprocess's OS scheduling priority (nice
    on POSIX, BELOW_NORMAL_PRIORITY_CLASS on Windows) the same way
    _run_whisper_filter/_ff_speech_intervals already do, so this never
    competes with a latency-critical live remux on the same host. Never
    raises -- returns True/False or TextSubtitleExtractionDeferred."""
    out_path = str(out_path)
    if not os.path.exists(FFMPEG_BIN):
        return _extraction_deferred('ffmpeg is unavailable')
    if not local_path or not os.path.isfile(str(local_path)):
        return _extraction_deferred('media file is unavailable')
    part = out_path + '.part'
    # -f srt is required because `part` ends in '.part', not '.srt' -- ffmpeg
    # infers the output muxer from the file extension and can't guess one
    # from '.part', so without an explicit -f it fails every time with
    # "Unable to choose an output format" (returncode -22). The .part name
    # itself must stay as-is for the atomic os.replace() pattern below.
    args = [str(FFMPEG_BIN), '-nostdin', '-hide_banner', '-y', '-i', str(local_path),
            '-map', '0:%d' % int(stream_index), '-c:s', 'srt', '-f', 'srt', part]
    env = {**os.environ, **FF_ENV}
    kw = {'stdout': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL,
          'timeout': timeout, 'env': env, 'check': True}
    if os.name == 'nt':
        flags = subprocess.CREATE_NO_WINDOW
        if gentle:
            flags |= subprocess.BELOW_NORMAL_PRIORITY_CLASS
        kw['creationflags'] = flags
    elif gentle:
        def _nice():
            try:
                os.nice(12)
            except Exception:
                pass
        kw['preexec_fn'] = _nice
    try:
        if os.path.exists(part):
            os.remove(part)
    except OSError:
        pass
    try:
        # run() kills AND waits for the direct ffmpeg child on TimeoutExpired
        # (including Windows), before we remove its partial output below.
        subprocess.run(args, **kw)
    except Exception as e:
        print('[subsync] extract_text_subtitle: %s' % e, file=sys.stderr)
        try:
            if os.path.exists(part):
                os.remove(part)
        except OSError:
            pass
        if isinstance(e, subprocess.CalledProcessError):
            return False
        return _extraction_deferred(str(e))
    if not os.path.isfile(part):
        return False
    try:
        os.replace(part, out_path)
        return True
    except OSError as e:
        print('[subsync] extract_text_subtitle replace: %s' % e, file=sys.stderr)
        try:
            os.remove(part)
        except OSError:
            pass
        return _extraction_deferred(str(e))


def _ff_speech_intervals(src, start, dur, noise='-30dB', mindur=0.35, gentle=True):
    """Speech (non-silence) intervals over [start, start+dur] via ffmpeg
    silencedetect. A fast pre-input seek decodes ONLY that window so a short
    window locks a constant offset in seconds. Returns ABSOLUTE-time intervals,
    or None on failure. `gentle` runs ffmpeg at nice +12 (long background pass)."""
    if not os.path.exists(FFMPEG_BIN):
        return None
    start = max(0, int(start)); dur = max(1, int(dur))
    args = [str(FFMPEG_BIN), '-nostdin', '-hide_banner']
    if start > 0:
        args += ['-ss', str(start)]          # fast pre-input seek -> decode from here
    args += ['-t', str(dur), '-i', src, '-vn', '-af',
             'highpass=f=180,lowpass=f=3200,silencedetect=noise=%s:d=%s' % (noise, mindur),
             '-f', 'null', '-']

    def _gentle():
        try:
            os.nice(12)
        except Exception:
            pass

    env = {**os.environ, **FF_ENV}   # SSL_CERT_DIR so an https seedr URL decodes
    try:
        p = subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                           timeout=dur * 4 + 60, env=env,
                           preexec_fn=(_gentle if (gentle and os.name != 'nt') else None))
    except Exception as e:
        print('[subsync] ffmpeg: %s' % e, file=sys.stderr)
        return None
    sils, cur = [], None
    for line in p.stderr.decode('utf-8', 'replace').splitlines():
        m = re.search(r'silence_start:\s*(-?[\d.]+)', line)
        if m:
            cur = max(0.0, float(m.group(1))); continue
        m = re.search(r'silence_end:\s*([\d.]+)', line)
        if m and cur is not None:
            sils.append((cur, float(m.group(1)))); cur = None
    # Invert silence -> speech over the seeked timeline [0, dur] (with -ss before
    # -i, silencedetect timestamps restart at 0), then shift back to absolute.
    speech, t = [], 0.0
    for (s, e) in sils:
        if s > t:
            speech.append((t, min(s, dur)))
        t = max(t, e)
    if t < dur:
        speech.append((t, dur))
    return [(s + start, e + start) for (s, e) in speech]


def _srt_cues(text):
    cues = []
    rx = re.compile(r'(\d\d):(\d\d):(\d\d)[,.](\d\d\d)\s*-->\s*(\d\d):(\d\d):(\d\d)[,.](\d\d\d)')
    for m in rx.finditer(text or ''):
        s = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3)) + int(m.group(4)) / 1000.0
        e = int(m.group(5)) * 3600 + int(m.group(6)) * 60 + int(m.group(7)) + int(m.group(8)) / 1000.0
        cues.append((s, e))
    return cues


def _act_win(intervals, rate, w0, w1):
    """Binary activity array for [w0, w1] at `rate` samples/sec."""
    n = int((w1 - w0) * rate)
    if n <= 0:
        return bytearray(0), 0
    a = bytearray(n)
    for (s, e) in intervals:
        x = int((s - w0) * rate); y = int((e - w0) * rate)
        if x < 0:
            x = 0
        if y > n:
            y = n
        for i in range(x, y):
            a[i] = 1
    return a, n


def _ncc_offset(speech, cues, w0, w1, rate, maxlag):
    """Mean-subtracted normalized cross-correlation of cue activity vs audio
    speech activity over [w0, w1]. Returns (offset_seconds, r)."""
    sp, n = _act_win(speech, rate, w0, w1)
    if n <= 0:
        return 0.0, 0.0
    cu, _ = _act_win(cues, rate, w0, w1)
    sm = sum(sp) / float(n)
    cm = sum(cu) / float(n)
    spc = [sp[i] - sm for i in range(n)]
    cuc = [cu[i] - cm for i in range(n)]
    sden = (sum(x * x for x in spc) ** 0.5) or 1.0
    cden = (sum(x * x for x in cuc) ** 0.5) or 1.0
    lb = int(maxlag * rate)
    best_r, best_lag = -9.0, 0
    for lag in range(-lb, lb + 1):
        s = 0.0
        i = -lag if lag < 0 else 0
        end = n - lag if lag > 0 else n
        j = i
        while j < end:
            s += cuc[j] * spc[j + lag]
            j += 1
        r = s / (sden * cden)
        if r > best_r:
            best_r, best_lag = r, lag
    return best_lag / float(rate), best_r


def _subsync_offset(speech, cues, w0, w1, rate=5, maxlag=20):
    """Trust the offset only when the full window and its first half AGREE --
    a real lock is window-stable; a noise peak wanders. Returns (offset,
    reliable, r)."""
    off_full, r_full = _ncc_offset(speech, cues, w0, w1, rate, maxlag)
    mid = w0 + (w1 - w0) / 2.0
    off_half, _r2 = _ncc_offset(speech, cues, w0, mid, rate, maxlag)
    reliable = (abs(off_full - off_half) <= 1.5) and (r_full >= 0.08)
    return off_full, reliable, round(r_full, 3)


# ---------------------------------------------------------------------------
# Whisper ASR path -- transcribe real dialogue, align WORDS to the subtitle
# text. Robust to music/effects (which silencedetect wrongly treats as speech).
# ---------------------------------------------------------------------------

def _srt_cues_text(text, shift=0.0):
    """[(start, end, text), ...] -- like _srt_cues but keeps the line text.
    `shift` adds a constant offset (seconds) to every timestamp -- used when
    parsing a whisper-filter .srt whose own clock reset to 0 at a non-zero
    `-ss` window start (see generate_sub)."""
    out = []
    rx = re.compile(r'(\d\d):(\d\d):(\d\d)[,.](\d\d\d)\s*-->\s*'
                    r'(\d\d):(\d\d):(\d\d)[,.](\d\d\d)\s*\n(.*?)(?:\n\n|\Z)', re.S)
    for m in rx.finditer(text or ''):
        s = int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3]) + int(m[4]) / 1000.0
        e = int(m[5]) * 3600 + int(m[6]) * 60 + int(m[7]) + int(m[8]) / 1000.0
        out.append((s + shift, e + shift, ' '.join(m[9].split())))
    return out


def srt_cues_text(text, shift=0.0):
    """Public wrapper around _srt_cues_text() -- so cache.py doesn't reach
    into a leading-underscore name from this module (mirrors
    whisper_available() above, same reason)."""
    return _srt_cues_text(text, shift)


def fingerprint_srt(text):
    """Bare-hex content fingerprint for an .srt's text -- stable identity
    for cache.py's baked-subtitle manifest keying (rel + this fingerprint
    -> a (media, sub) pair measured at most once, ever). Never carries a
    'sha256:' prefix on disk (a colon is a Windows path landmine, same
    reason the whisper model path is kept relative elsewhere in this
    module) -- callers may add that prefix themselves for a readable
    manifest value."""
    norm = (text or '').strip()
    return hashlib.sha256(norm.encode('utf-8', 'replace')).hexdigest()[:20]


_TS_PAIR_RE = re.compile(
    r'(\d\d):(\d\d):(\d\d)[,.](\d\d\d)\s*-->\s*(\d\d):(\d\d):(\d\d)[,.](\d\d\d)')


def bake_srt(text, offset=0.0, scale=1.0):
    """Rewrite ONLY the timestamp lines of an .srt, applying `scale`/
    `offset` (shifted = max(0.0, sec*scale + offset)) via the SAME
    timestamp pattern _srt_cues already matches on, re-rendered with the
    existing _fmt_srt_ts(). Every other byte -- indices, cue text
    (including multi-line/tagged content), blank-line separators --
    passes through UNTOUCHED. Deliberately NOT a parse/reformat
    round-trip through _srt_cues_text/_format_srt, which collapses
    multi-line cue text to one line for whisper-alignment matching and
    would corrupt a real subtitle file's formatting if reused here."""
    def _shift(sec):
        return max(0.0, sec * scale + offset)

    def _repl(m):
        s = (int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
             + int(m.group(4)) / 1000.0)
        e = (int(m.group(5)) * 3600 + int(m.group(6)) * 60 + int(m.group(7))
             + int(m.group(8)) / 1000.0)
        return '%s --> %s' % (_fmt_srt_ts(_shift(s)), _fmt_srt_ts(_shift(e)))

    return _TS_PAIR_RE.sub(_repl, text or '')


def _fmt_srt_ts(t):
    """Seconds (float) -> 'HH:MM:SS,mmm', carrying rounding overflow up
    through s/m/h so e.g. 59.9995 never renders as '..:60,000'."""
    if t < 0:
        t = 0.0
    ms_total = int(round(t * 1000))
    h, rem = divmod(ms_total, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return '%02d:%02d:%02d,%03d' % (h, m, s, ms)


def _format_srt(cues):
    """[(start, end, text), ...] -> a clean, well-formed .srt string with
    sequential 1-based indices and blank-line-separated cues."""
    lines = []
    for i, (s, e, text) in enumerate(cues, 1):
        if e <= s:
            e = s + 1.0
        lines.append(str(i))
        lines.append('%s --> %s' % (_fmt_srt_ts(s), _fmt_srt_ts(e)))
        lines.append(text)
        lines.append('')
    return '\n'.join(lines) + '\n'


def _norm_txt(t):
    return re.sub(r'[^a-z0-9 ]', '', (t or '').lower()).strip()


def _is_dialogue(t):
    """A cue with real speech (not just a [sound] / (music) description)."""
    stripped = re.sub(r'[\[\(][^\]\)]*[\]\)]', '', t or '').strip()
    return len(re.sub(r'[^a-zA-Z]', '', stripped)) >= 8


def _densest_dialogue_start(cues, win=180):
    """Start second of the `win`-length window richest in DIALOGUE cues (so
    Whisper transcribes actual speech, not a music montage). None if sparse."""
    dlg = [c for c in cues if _is_dialogue(c[2])]
    if len(dlg) < 8:
        return None
    end = int(cues[-1][1]) if cues else 0
    best_st, best_cnt, st = 0, 0, 0
    while st < max(1, end):
        cnt = sum(1 for c in dlg if st <= c[0] < st + win)
        if cnt > best_cnt:
            best_cnt, best_st = cnt, st
        st += 20
    return best_st if best_cnt >= 8 else None


def _run_whisper_filter(src, start, dur, gentle=False):
    """Run ffmpeg's whisper filter over [start, start+dur] of `src`; return
    the RAW .srt text ffmpeg wrote, or None on failure/missing output. Runs
    from the model's own dir with a RELATIVE model path so a Windows
    drive-colon can't break filter parsing. `gentle` lowers the ffmpeg
    subprocess's OS scheduling priority (nice on POSIX,
    BELOW_NORMAL_PRIORITY_CLASS on Windows) -- used both for a long
    background full-file transcription (generate_sub) AND for the live
    multi-sample alignment path (_whisper_multi_offset, called from a live
    /subsync request while a remux/seek may be actively running on the same
    weak host) so up to _ANCHOR_MAX_WORKERS concurrent whisper.cpp
    subprocesses yield CPU to the latency-critical remux/seek ffmpeg process
    instead of competing with it at equal OS priority."""
    model_dir = os.path.dirname(_WHISPER_MODEL) or '.'
    model_name = os.path.basename(_WHISPER_MODEL)
    # Per-process + random suffix so two concurrent whisper passes (two
    # different /subsync requests, or two workers in _whisper_multi_offset that
    # happen to share the same integer window `start`) can never collide on the
    # output filename and read/delete each other's .srt -- the model dir is
    # shared host-wide and subsync.py has no lock of its own (cache.py's
    # per-rel _SYNC_LOCK only serializes syncs of the SAME rel).
    out_name = 'ws_%d_%d_%s.srt' % (int(start), os.getpid(), os.urandom(4).hex())
    out_path = os.path.join(model_dir, out_name)
    try:
        if os.path.exists(out_path):
            os.remove(out_path)
    except OSError:
        pass
    filt = ('whisper=model=%s:language=en:format=srt:destination=%s:use_gpu=false'
            % (model_name, out_name))
    args = [str(FFMPEG_BIN), '-nostdin', '-hide_banner']
    if start > 0:
        args += ['-ss', str(int(start))]          # 0-based ts in output -> add start back
    args += ['-t', str(int(dur)), '-i', src, '-vn', '-af', filt, '-f', 'null', '-']
    env = {**os.environ, **FF_ENV}
    kw = {'stdout': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL,
          'timeout': int(dur) * 3 + 120, 'env': env, 'cwd': model_dir}
    if os.name == 'nt':
        flags = subprocess.CREATE_NO_WINDOW
        if gentle:
            flags |= subprocess.BELOW_NORMAL_PRIORITY_CLASS
        kw['creationflags'] = flags
    elif gentle:
        def _nice():
            try:
                os.nice(15)
            except Exception:
                pass
        kw['preexec_fn'] = _nice
    # The finally MUST wrap subprocess.run too: on a whisper TIMEOUT (or any
    # launch error) ffmpeg may already have written a partial `out_path`, and
    # the previous structure returned on the exception BEFORE reaching the
    # cleanup finally -- leaking one ws_*.srt in the model dir per timeout,
    # forever (no sweep covers that dir). Now every exit path unlinks it.
    try:
        try:
            subprocess.run(args, **kw)
        except Exception as e:
            print('[subsync] whisper: %s' % e, file=sys.stderr)
            return None
        if not os.path.isfile(out_path):
            return None
        try:
            return open(out_path, encoding='utf-8', errors='replace').read()
        except OSError:
            return None
    finally:
        try:
            os.remove(out_path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Full-file subtitle GENERATION -- the actual architecture-decision feature.
# Transcribes the WHOLE audio track (or, with max_sec, a bounded preview
# window) and writes a standalone .srt whose timing IS Whisper's own
# timestamps -- correct by construction, no offset/alignment step needed.
# ---------------------------------------------------------------------------

# Full-file generation is clamped to this many seconds of audio so a
# corrupt/huge source can't run the background thread forever.
_GEN_MAX_SEC = int(os.environ.get('DUMIFLIX_SUBGEN_MAX_SEC') or 4 * 3600)
# "fast" preview window (POST /subgen {fast:true}): a short window well past
# any cold-open/credits, transcribed synchronously for a quick first subtitle.
FAST_PREVIEW_SEC = int(os.environ.get('DUMIFLIX_SUBGEN_PREVIEW_SEC') or 180)
FAST_PREVIEW_START = int(os.environ.get('DUMIFLIX_SUBGEN_PREVIEW_START') or 60)


def generate_sub(local_path, out_srt_path, max_sec=None, start_sec=None):
    """Generate an English subtitle for `local_path` -- a LOCAL cache file,
    never an http URL -- by transcribing its audio with Whisper and writing
    a clean .srt to `out_srt_path`. Whisper's OWN timestamps become the cue
    timing: correct by construction, no offset, no per-play variance.

    Full-file by default (probes duration via remux.probe(), clamped to
    DUMIFLIX_SUBGEN_MAX_SEC). Pass `max_sec` (optionally with `start_sec`)
    for a bounded preview window instead (see FAST_PREVIEW_SEC/_START).

    Robust: no-ops (returns False) if no Whisper model is configured, the
    source doesn't exist, or `out_srt_path` already exists (skip-if-exists;
    callers additionally single-flight per rel on top of this). Atomic:
    writes '<out_srt_path>.part' then os.replace()s over the final name, so
    a concurrent reader (server.py's /cache/subs) never observes a partial
    file. Never raises -- always returns True/False."""
    out_srt_path = str(out_srt_path)
    if os.path.isfile(out_srt_path):
        return False
    if not _has_whisper():
        return False
    if not local_path or not os.path.isfile(str(local_path)):
        return False

    try:
        if max_sec:
            start = float(start_sec if start_sec is not None else FAST_PREVIEW_START)
            dur = float(max_sec)
        else:
            start = 0.0
            dur = None
            try:
                info = _remux_probe(str(local_path), timeout=20.0)
                dur = info.get('duration')
            except Exception as e:
                print('[subsync] generate_sub probe: %s' % e, file=sys.stderr)
            if not dur or dur <= 0:
                dur = _GEN_MAX_SEC
            dur = min(float(dur) + 2.0, float(_GEN_MAX_SEC))   # small pad for a clean tail cue

        raw = _run_whisper_filter(str(local_path), start, dur, gentle=True)
        if not raw:
            return False
        cues = [c for c in _srt_cues_text(raw, shift=start) if c[2]]
        if not cues:
            return False

        part = out_srt_path + '.part'
        with open(part, 'w', encoding='utf-8') as f:
            f.write(_format_srt(cues))
        os.replace(part, out_srt_path)
        return True
    except Exception as e:
        print('[subsync] generate_sub: %s' % e, file=sys.stderr)
        try:
            if os.path.exists(out_srt_path + '.part'):
                os.remove(out_srt_path + '.part')
        except OSError:
            pass
        return False


# ---------------------------------------------------------------------------
# Multi-sample alignment -- the actual PRIMARY subsync path. Instead of
# transcribing the whole file (generate_sub, above -- slow, ~15 min) or a
# single 120s window (the old _whisper_offset -- fast, but blind to drift),
# sample a handful of short (~60s) windows spread across the MIDDLE of the
# file, transcribe them IN PARALLEL, align each to the subtitle text
# independently, then fit the resulting (time, offset) points: a flat fit
# means a constant offset, a sloped fit means linear DRIFT (framerate
# mismatch) -- something a single sample can never distinguish from noise.
# ---------------------------------------------------------------------------

# All knobs below are env-overridable so a slower/faster box (or a
# pathologically short file) can be tuned without a code change; defaults
# targeted at "a handful of samples, well under 30s wall-clock in parallel".
_ANCHOR_WIN_SEC = float(os.environ.get('DUMIFLIX_SUBSYNC_WINDOW_SEC') or 60)
_ANCHOR_SPACING_SEC = float(os.environ.get('DUMIFLIX_SUBSYNC_SPACING_SEC') or 300)
_ANCHOR_EDGE_SEC = float(os.environ.get('DUMIFLIX_SUBSYNC_EDGE_SEC') or 90)
_ANCHOR_MAX_WINDOWS = int(os.environ.get('DUMIFLIX_SUBSYNC_MAX_WINDOWS') or 6)
_ANCHOR_MAX_WORKERS = int(os.environ.get('DUMIFLIX_SUBSYNC_MAX_WORKERS') or 4)
_ANCHOR_MIN_MATCHES = int(os.environ.get('DUMIFLIX_SUBSYNC_MIN_MATCHES') or 3)
_ANCHOR_MAXLAG_SEC = float(os.environ.get('DUMIFLIX_SUBSYNC_MAXLAG_SEC') or 60)
# Base tolerance (seconds) for rejecting an outlier window whose measured
# offset sits far from the median of all windows. Adaptive at fit time: a
# genuinely drifting sub spreads the offsets, MAD grows, and this floor is
# widened so the real end-points are kept (see _whisper_multi_offset).
_ANCHOR_INLIER_TOL = float(os.environ.get('DUMIFLIX_SUBSYNC_INLIER_TOL') or 2.5)


def _pick_anchor_windows(duration, cues, win=_ANCHOR_WIN_SEC, spacing=_ANCHOR_SPACING_SEC,
                          edge=_ANCHOR_EDGE_SEC, max_windows=_ANCHOR_MAX_WINDOWS):
    """Up to `max_windows` anchor start-times spread ~`spacing`s apart across
    the MIDDLE of the file (skipping `edge`s at both ends -- cold opens /
    credits are usually music, not dialogue), each nudged within its own
    slot toward the locally densest DIALOGUE region (reusing _is_dialogue)
    so whisper hears real speech, not a montage. Falls back to a single
    centered window when the file is too short for the full spacing scheme,
    or [] when there's no usable duration at all."""
    if not duration or duration <= 0:
        return []
    lo, hi = edge, duration - edge
    if hi - lo < win:
        mid = max(0.0, (duration - win) / 2.0)
        return [round(mid, 1)]

    starts, t = [], lo
    while t <= hi - win and len(starts) < max_windows:
        starts.append(t)
        t += spacing
    if not starts:
        starts = [lo]

    dlg = [c for c in cues if _is_dialogue(c[2])]
    windows = []
    for t in starts:
        if not dlg:
            windows.append(t)
            continue
        lo_s = max(lo, t - spacing / 2.0)
        hi_s = min(hi - win, t + spacing / 2.0)
        if hi_s < lo_s:
            hi_s = lo_s
        best_t, best_cnt, cur = t, -1, lo_s
        while cur <= hi_s:
            cnt = sum(1 for c in dlg if cur <= c[0] < cur + win)
            if cnt > best_cnt:
                best_cnt, best_t = cnt, cur
            cur += 15.0
        windows.append(best_t)

    # De-dup (a density shift can collapse two adjacent slots together).
    out, seen = [], set()
    for w in sorted(windows):
        key = round(w / 10.0)
        if key in seen:
            continue
        seen.add(key)
        out.append(round(w, 1))
    return out[:max_windows]


def _match_window_offset(raw_text, wstart, wdur, subs,
                          maxlag=_ANCHOR_MAXLAG_SEC, min_matches=_ANCHOR_MIN_MATCHES):
    """Align ONE window's raw whisper .srt text to `subs` ([(cue_start,
    norm_text), ...]) the same way the old single-window _whisper_offset
    did: nearest-in-time + best difflib text ratio per transcribed line.
    Returns {t: anchor_mid, offset, matches, tight} or None when there
    aren't enough confident matches to trust this window at all."""
    if not raw_text:
        return None
    segs = _srt_cues_text(raw_text, shift=wstart)
    deltas = []
    for (s, _e, text) in segs:
        wn = _norm_txt(text)
        if len(wn) < 10:                          # skip fragments / music tags
            continue
        best, bestr = None, 0.0
        for st, stext in subs:
            if abs(st - s) > maxlag:
                continue
            r = difflib.SequenceMatcher(None, wn, stext).ratio()
            if r > bestr:
                bestr, best = r, st
        if best is not None and bestr >= 0.55:
            deltas.append(s - best)
    if len(deltas) < min_matches:
        return None
    deltas.sort()
    med = statistics.median(deltas)
    core = [d for d in deltas if abs(d - med) <= 2.0] or deltas   # drop mismatches
    off = statistics.median(core)
    n = len(core)
    tight = statistics.pstdev(core) if n > 1 else 0.0
    return {'t': wstart + wdur / 2.0, 'offset': off, 'matches': n, 'tight': round(tight, 3)}


def _linreg(points):
    """Least-squares fit offset = a + b*t over [(t, offset), ...]. Pure
    stdlib (no numpy). Returns (a, b); b==0 (flat) if points share one t."""
    n = len(points)
    sx = sum(t for t, _o in points)
    sy = sum(o for _t, o in points)
    sxx = sum(t * t for t, _o in points)
    sxy = sum(t * o for t, o in points)
    denom = n * sxx - sx * sx
    if denom == 0:
        return sy / n, 0.0
    b = (n * sxy - sx * sy) / denom
    a = (sy - b * sx) / n
    return a, b


def _whisper_multi_offset(src, cues, max_windows=None):
    """PRIMARY subsync algorithm: sample a handful of ~60s windows spread
    across the file, transcribe them in parallel, align each independently
    to `cues`, then fit the (anchor_time, offset) points -- flat -> a
    constant offset, sloped -> linear DRIFT (framerate mismatch), reported
    as offset-at-t=0 + scale=1+slope so a caller can apply both the same way
    the reference-alignment tier already does. Returns a full result dict
    (pass='whisper-multi') on ANY usable measurement, or None if every
    window failed outright (caller falls back to silencedetect). `max_windows`
    (default: _ANCHOR_MAX_WINDOWS) lets a caller cap the sample count for a
    cheap first pass -- see measure_offset_progressive()."""
    if not cues:
        return None
    subs = [(c[0], _norm_txt(c[2])) for c in cues if _norm_txt(c[2])]
    if not subs:
        return None

    try:
        info = _remux_probe(src, timeout=20.0)
        duration = float(info.get('duration') or 0)
    except Exception as e:
        print('[subsync] multi probe: %s' % e, file=sys.stderr)
        duration = 0.0

    if duration > 0:
        windows = _pick_anchor_windows(duration, cues, max_windows=(max_windows or _ANCHOR_MAX_WINDOWS))
    else:
        # No duration available -- fall back to ONE dialogue-dense window
        # (still runs through the same per-window matcher below).
        start = _densest_dialogue_start(cues, win=120)
        windows = [float(start)] if start is not None else []
    if not windows:
        return None

    results = {}
    workers = max(1, min(_ANCHOR_MAX_WORKERS, len(windows)))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        # gentle=True: this runs WHILE the same (often weak/power-trimmed)
        # host may be actively remuxing/seeking live video for playback --
        # lowering these subprocesses' OS scheduling priority lets the
        # latency-critical remux ffmpeg process win contention instead of
        # competing at equal priority (see _run_whisper_filter docstring).
        futs = {ex.submit(_run_whisper_filter, src, w, _ANCHOR_WIN_SEC, True): w for w in windows}
        for fut in as_completed(futs):
            w = futs[fut]
            try:
                raw = fut.result()
            except Exception as e:
                print('[subsync] window %.0f: %s' % (w, e), file=sys.stderr)
                raw = None
            r = _match_window_offset(raw, w, _ANCHOR_WIN_SEC, subs)
            if r:
                results[w] = r

    points = [results[w] for w in sorted(results)]
    if not points:
        return None

    samples = [[round(p['t'], 1), round(p['offset'], 2)] for p in points]

    # Single usable anchor -- same shape as the old single-window path:
    # constant offset, no drift signal possible from one point.
    if len(points) == 1:
        p = points[0]
        conf = max(0.0, min(0.95, 0.5 + 0.06 * p['matches'] - 0.08 * p['tight']))
        return {
            'ok': True, 'offset': round(p['offset'], 2), 'scale': 1.0,
            'reliable': conf >= 0.55, 'confidence': round(conf, 2), 'r': round(conf, 2),
            'matches': p['matches'], 'samples': samples, 'pass': 'whisper-multi',
        }

    # ---- OUTLIER REJECTION (robust) --------------------------------------
    # One window can mis-align (a cold open, a repeated line, a music bed) and
    # land far from the truth. Least-squares is NOT robust to that: a single
    # outlier can distort both the reported offset and the drift slope.
    # Reject windows whose offset sits far from the MEDIAN before fitting. The
    # tolerance is ADAPTIVE via MAD: a tight cluster + one jump -> small tol
    # (drop the jump); a genuinely drifting sub -> the offsets legitimately
    # spread, MAD grows, tol grows, and the real end-points are KEPT so drift
    # still fits.
    all_offs = [p['offset'] for p in points]
    med_all = statistics.median(all_offs)
    mad = statistics.median([abs(o - med_all) for o in all_offs])
    tol = max(_ANCHOR_INLIER_TOL, 3.0 * mad)
    inliers = [p for p in points if abs(p['offset'] - med_all) <= tol]
    if len(inliers) < 2:
        inliers = points                       # too few to trust any rejection
    dropped = len(points) - len(inliers)
    total_matches = sum(p['matches'] for p in inliers)

    ts = [p['t'] for p in inliers]
    offs = [p['offset'] for p in inliers]
    n = len(inliers)
    spread = max(offs) - min(offs)
    span = max(ts) - min(ts)
    avg_tight = sum(p['tight'] for p in inliers) / n

    a, b = _linreg(list(zip(ts, offs)))
    sse_lin = sum((o - (a + b * t)) ** 2 for t, o in zip(ts, offs))
    mean_o = sum(offs) / n
    sse_const = sum((o - mean_o) ** 2 for o in offs)
    drift_total = abs(b) * span if span > 0 else 0.0
    # Only call it DRIFT (vs. noise around one constant offset) when there are
    # enough CLEAN inliers to trust a slope (>=3), the trend accumulates to
    # something worth correcting over the sampled span, AND it explains the
    # spread clearly better than a flat line. Two points can always be joined
    # by a line, so they can never justify a drift claim on their own.
    use_linear = (n >= 3 and span > 0 and drift_total >= 1.0
                  and sse_lin < sse_const * 0.5)

    if use_linear:
        residual = (sse_lin / n) ** 0.5
        conf = max(0.0, min(0.97, 0.55 + 0.05 * n - 0.1 * residual - 0.05 * dropped))
        return {
            'ok': True, 'offset': round(a, 2), 'scale': round(1.0 + b, 5),
            'reliable': conf >= 0.55, 'confidence': round(conf, 2), 'r': round(conf, 2),
            'matches': total_matches, 'samples': samples, 'pass': 'whisper-multi',
        }

    offset = statistics.median(offs)
    conf = max(0.0, min(0.98, 0.55 + 0.06 * n - 0.12 * max(spread, avg_tight) - 0.05 * dropped))
    return {
        'ok': True, 'offset': round(offset, 2), 'scale': 1.0,
        'reliable': conf >= 0.55, 'confidence': round(conf, 2), 'r': round(conf, 2),
        'matches': total_matches, 'samples': samples, 'pass': 'whisper-multi',
    }


def measure_offset_progressive(src, cues, fast_windows=2, full_windows=None):
    """Two-phase reuse of _whisper_multi_offset -- R4's progressive
    early-enable ("a single confident window may enable subs early,
    refined when remaining windows land") and R5's "measure once, cheaply
    first" efficiency requirement. Phase 1 samples only `fast_windows`
    anchors; if that already comes back reliable, return it immediately
    (tagged phase='fast') without spending the full window budget.
    Otherwise escalate to `full_windows` (default: the full
    _ANCHOR_MAX_WINDOWS budget) and return THAT result if it produced
    anything (tagged phase='full'), falling back to the phase-1 result
    (even if unreliable) rather than None, and only returning None if
    NEITHER phase produced any usable measurement at all."""
    phase1 = _whisper_multi_offset(src, cues, max_windows=fast_windows)
    if phase1 and phase1.get('reliable'):
        phase1['phase'] = 'fast'
        return phase1
    phase2 = _whisper_multi_offset(src, cues, max_windows=(full_windows or _ANCHOR_MAX_WINDOWS))
    if phase2:
        phase2['phase'] = 'full'
        return phase2
    if phase1:
        phase1['phase'] = 'full'
        return phase1
    return None


def measure_offset_silencedetect(path, srt_text, max_sec=900):
    """Whisper-free measurement for the cache's background sync jobs -- the
    same fast/slow silencedetect tiers handle_subsync() falls back to,
    returned in a measure_offset_progressive()-shaped dict ({'offset',
    'scale','reliable','confidence','pass'}) so callers treat both paths
    identically. Returns None when the SRT has no cues or the audio could
    not be decoded at all. Without this, a whisper-less host failed every
    external candidate outright and never verified an embedded track --
    silently disabling the whole bake pipeline."""
    cues = _srt_cues(srt_text)
    if not cues:
        return None
    FAST_START, FAST_DUR = 30, 330
    speech = _ff_speech_intervals(path, FAST_START, FAST_DUR, gentle=True)
    if speech:
        off, reliable, r = _subsync_offset(speech, cues, FAST_START,
                                           FAST_START + FAST_DUR, maxlag=45)
        if reliable:
            return {'ok': True, 'offset': round(off, 2), 'scale': 1.0,
                    'reliable': True, 'confidence': r, 'pass': 'sd-fast'}
    max_sec = max(420, min(1800, int(max_sec)))
    speech = _ff_speech_intervals(path, 0, max_sec, gentle=True)
    if speech is None:
        return None
    off, reliable, r = _subsync_offset(speech, cues, 0, max_sec,
                                       maxlag=min(90, max(45, max_sec // 10)))
    return {'ok': True, 'offset': round(off, 2), 'scale': 1.0,
            'reliable': reliable, 'confidence': r, 'pass': 'sd-slow'}


def handle_subsync(body):
    """body: { url|path, srt, max_sec? } -> dict (with an optional 'status' key
    for the server to map to an HTTP code). PRIMARY: multi-sample Whisper
    alignment -- a handful of parallel-transcribed windows fit for a
    constant offset or linear drift (when a model is configured; see
    _whisper_multi_offset). FALLBACK: silencedetect fast/slow
    cross-correlation."""
    src = (body.get('url') or body.get('path') or '').strip()
    srt = body.get('srt') or ''
    if not src or not srt:
        return {'error': 'need url/path + srt', 'status': 400}
    cues = _srt_cues(srt)
    if not cues:
        return {'ok': True, 'offset': 0, 'confidence': 0, 'reason': 'no cues'}
    # tv-service engines decode the source URL directly (a seedr https link the
    # engine can fetch); a local path is honored too if the caller passes one.
    target = src if src.startswith(('http://', 'https://')) else (src if os.path.isfile(src) else src)
    # If the source is OUR OWN /cache/stream URL, decode the LOCAL file instead
    # of fetching it back over HTTP -- an http MKV seek is slow/flaky (the whole
    # reason the auto-sync was failing), while a local seek is instant.
    m = re.search(r'/cache/stream/([^?]+)', target)
    if m:
        try:
            import cache            # sibling; present only on cache-enabled hosts
            import urllib.parse as _up
            local = str(cache.CACHE_ROOT / _up.unquote(m.group(1)))
            if os.path.isfile(local):
                target = local
        except Exception:
            pass
    is_local = os.path.isfile(target)
    t0 = time.time()

    # PRIMARY (local files): ffsubsync -- see ffsubsync_bin() for why it
    # outranks Whisper: transcription timestamp bias can shift synced tracks.
    # URL sources fall through to the tiers below.
    if is_local and ffsubsync_available():
        w = measure_offset_ffsubsync(target, srt)
        if w:
            w['source'] = 'local'
            w['took_sec'] = round(time.time() - t0, 1)
            return w

    # SECONDARY: multi-sample Whisper alignment -- a handful of short (~60s)
    # windows spread across the middle of the file, transcribed IN PARALLEL
    # and each aligned independently to the subtitle text, then fit for a
    # constant offset OR linear DRIFT (see _whisper_multi_offset above).
    # Returns a full result (possibly reliable:False) on any usable
    # measurement; only falls through to silencedetect below when whisper
    # isn't configured at all, or every sampled window failed outright
    # (decode error / unreadable source).
    if _has_whisper():
        try:
            cues_t = _srt_cues_text(srt)
            w = _whisper_multi_offset(target, cues_t) if cues_t else None
        except Exception as e:
            print('[subsync] whisper multi offset: %s' % e, file=sys.stderr)
            w = None
        if w:
            w['source'] = 'local' if is_local else 'url'
            w['took_sec'] = round(time.time() - t0, 1)
            return w

    # maxlag: the old default (20s) made any release-cut mismatch bigger than
    # ±20s STRUCTURALLY invisible to this whisper-less tier -- the only tier
    # the TV engine ever has -- no matter how much audio was decoded. The
    # whisper tier searches ±60s; give the correlation tiers a comparable
    # reach (45s fast, up to 90s slow) so a recap/logo-reel difference is at
    # least measurable.
    FAST_START, FAST_DUR = 30, 330
    speech = _ff_speech_intervals(target, FAST_START, FAST_DUR, gentle=False)
    if speech:
        off, reliable, r = _subsync_offset(speech, cues, FAST_START,
                                           FAST_START + FAST_DUR, maxlag=45)
        if reliable:
            return {
                'ok': True, 'offset': round(off, 2), 'reliable': True, 'r': r,
                'analyzed_sec': FAST_DUR, 'window': [FAST_START, FAST_START + FAST_DUR],
                'pass': 'fast', 'source': 'local' if is_local else 'url',
                'took_sec': round(time.time() - t0, 1),
            }

    try:
        max_sec = int(body.get('max_sec') or 900)
    except Exception:
        max_sec = 900
    max_sec = max(420, min(1800, max_sec))
    speech = _ff_speech_intervals(target, 0, max_sec, gentle=True)
    if speech is None:
        return {'error': 'ffmpeg unavailable or decode failed', 'status': 503}
    offset, reliable, r = _subsync_offset(speech, cues, 0, max_sec,
                                          maxlag=min(90, max(45, max_sec // 10)))
    return {
        'ok': True, 'offset': round(offset, 2), 'reliable': reliable, 'r': r,
        'analyzed_sec': max_sec, 'speech_intervals': len(speech), 'pass': 'slow',
        'source': 'local' if is_local else 'url',
        'took_sec': round(time.time() - t0, 1),
    }
