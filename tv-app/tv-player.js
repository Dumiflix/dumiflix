/* tv-player.js — memory/CPU-conscious TV player UI for DumiFlix (webOS).
 *
 * Main changes from the supplied version:
 *  - only one installation is allowed per page
 *  - progress UI runs at 10 fps only while visible (not 60 fps for the whole video)
 *  - subtitle work is media-event driven, with a low-frequency fallback
 *  - pills/up-next checks run twice per second instead of on every animation frame
 *  - pending timeouts and async next-episode work are invalidated on deactivate
 *  - hot-path DOM nodes are cached
 */
(function () {
  'use strict';

  if (window.__dumiNftPlayerInstalled) return;
  window.__dumiNftPlayerInstalled = true;

  var doc = document;
  var V = null, PLAYER = null, nft = null, subsEl = null, subTextEl = null, toastEl = null, bridge = null;
  var active = false, built = false, uiTimer = 0, hideTimer = 0, toastTimer = 0;
  var commitTimer = 0, subTimer = 0, lastMove = 0, seekIndTimer = 0;
  var bubbleTimer = 0, speedTimer = 0;
  var controlsShown = false, seekTarget = null, seekPending = null;
  var seekBusy = false, seekRequestId = 0;
  var dpadTarget = null, dpadLastAt = 0;
  var upnextFired = false, seekAccum = 0, skipTarget = null, skipKind = null;
  var subOffset = 0, lastSubKey = '', lastTimeStr = '', lastTimeUpdateAt = 0;
  var lastSubCues = null;
  var lastCopyPaintAt = null, lastEndPaintAt = null, lastSeekLocked = null;
  var subSeekHold = false, subSeekSerial = 0;
  var nextPending = false, nextRequestId = 0;
  var focusEl = null, controls = [], R = {};
  // ---- seek-bar sprite-sheet scrub previews (cache-backed sources only) ---
  var thumbsInfo = null, thumbsRel = null, thumbsRetryTimer = 0;
  // ---- Timeline trick-play FILMSTRIP (replaces the old single sprite
  // card) — ~7 cards centered on screen, center = the seek target. See
  // showFilmstrip()/assignStripCards() below for the full contract.
  var stripCenterIdx = -1, stripSliding = false, stripSlideTimer = 0;
  var stripWarmedSheet = -1, stripCardPitch = 0;
  var STRIP_OFFSETS = [-3, -2, -1, 0, 1, 2, 3];
  var STRIP_SLIDE_MS = 150, STRIP_WARM_MARGIN = 10;

  var D_PAD_SEEK_STEP = 10;
  var D_PAD_GESTURE_IDLE = 900;
  var QUICK_SKIP_INDICATOR_MS = 600;
  // A remux seek has to restart FFmpeg and replace the media generation, so
  // rapid presses are combined before doing that expensive work. Direct Play
  // commits every 10-second press immediately and does not use this delay.
  var REMUX_SEEK_IDLE = 750;
  var AUTO_HIDE = 4000;
  var UI_TICK = 100;
  var MEDIA_TICK = 500;

  var KEY = {
    LEFT: 37, RIGHT: 39, UP: 38, DOWN: 40, OK: 13, BACK: 461,
    BACK2: 10009, ESC: 27, PLAY: 415, PAUSE: 19, PLAYPAUSE: 463,
    FF: 417, RW: 412, STOP: 413
  };

  // One icon family: 24-grid, filled shapes for transport (play/pause/next),
  // 2px round-capped strokes for utilities. Rounded corners throughout so the
  // glyphs sit naturally inside the 16px-radius buttons (concentric feel).
  var ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M9.2 5.4v13.2c0 1 1.1 1.6 1.9 1L20.4 13c.8-.5.8-1.6 0-2.1L11.1 4.4c-.8-.6-1.9 0-1.9 1z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><rect x="6" y="4.8" width="4.4" height="14.4" rx="1.8"/><rect x="13.6" y="4.8" width="4.4" height="14.4" rx="1.8"/></svg>',
    back10: '<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.6A7.4 7.4 0 1 0 19.4 12"/><path d="M12 1.8 9 4.6l3 2.8"/></g><text x="12" y="15.8" text-anchor="middle" font-size="8.4" font-weight="800" fill="currentColor" stroke="none">10</text></svg>',
    fwd10: '<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.6A7.4 7.4 0 1 1 4.6 12"/><path d="M12 1.8 15 4.6l-3 2.8"/></g><text x="12" y="15.8" text-anchor="middle" font-size="8.4" font-weight="800" fill="currentColor" stroke="none">10</text></svg>',
    cc: '<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.8" y="4.6" width="18.4" height="14.8" rx="3.4"/><path d="M11 10.1a2.6 2.6 0 1 0 0 3.8M17.6 10.1a2.6 2.6 0 1 0 0 3.8"/></g></svg>',
    audio: '<svg viewBox="0 0 24 24"><path d="M4 9.2A1.2 1.2 0 0 1 5.2 8h2.6l4.4-3.5c.8-.6 1.9-.1 1.9.9v13.2c0 1-1.1 1.5-1.9.9L7.8 16H5.2A1.2 1.2 0 0 1 4 14.8z"/><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 9a4.4 4.4 0 0 1 0 6M19.6 6.6a8 8 0 0 1 0 10.8"/></g></svg>',
    speed: '<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5.4 18.6a9 9 0 1 1 13.2 0"/><path d="M12 13.6l3.8-4.4"/></g><circle cx="12" cy="14.2" r="1.7"/></svg>',
    sync: '<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.4 12a8.4 8.4 0 1 1-2.46-5.94"/><path d="M20.4 3.6v4.2h-4.2"/></g></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M6.4 5.6v12.8c0 1 1.1 1.6 1.9 1l8.8-6.4c.7-.5.7-1.5 0-2L8.3 4.6c-.8-.6-1.9 0-1.9 1z"/><rect x="17.2" y="4.8" width="2.8" height="14.4" rx="1.4"/></svg>',
    cloud: '<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M7.2 18.4h10a4.2 4.2 0 0 0 .5-8.37 6 6 0 0 0-11.5 1.5A3.45 3.45 0 0 0 7.2 18.4z"/></svg>',
    laptop: '<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="12" rx="2"/><path d="M2 20h20l-2-4H4z"/></g></svg>',
    lock: '<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></g></svg>',
    chev: '<svg viewBox="0 0 14 24"><path d="M3.3 2.9 1.2 5l7 7-7 7 2.1 2.1L12.4 12z"/></svg>'
  };

  function elt(tag, cls, html) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function $(s) { return nft ? nft.querySelector(s) : null; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function fmt(s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : '' + m) + ':' + String(sec).padStart(2, '0');
  }
  // Pure overlay models: no bridge calls, media mutations, DOM or clock reads.
  function copyInProgress(cv) {
    if (!cv || !(cv._directSeedr || cv._growingCache)) return false;
    var item = cv._queueItem;
    // The source flag survives copy failures. Terminal queue state must win
    // over a stale job/range snapshot, including failed torrent fallbacks.
    if (item && (item.phase !== 'copying' || item._backend !== 'laptop')) return false;
    // Growing ticks attach this job only when the playing file matches; a
    // queue-wide 'copying' phase alone may refer to a sibling in a pack.
    if (cv._growingJobId) return true;
    // Torrent fallback copies the whole pack and has no growing-file ticks.
    return !!(item && item._torrentFallback
      && (item._torrentJobId || item._torrentFallbackPromise));
  }
  // Same margins as app.js growingSeekMargins: segments are drawn trimmed by
  // them so the grey area matches where a jump is allowed.
  function copyMargins(duration, total) {
    var rate = Number.isFinite(duration) && duration > 0 ? total / duration : 0;
    return { before: Math.max(4 * 1024 * 1024, rate * 10, total * 0.005),
             after: Math.max(32 * 1024 * 1024, rate * 30, total * 0.02) };
  }
  function downloadState(cv, duration) {
    cv = cv || {};
    var total = cv._growingTotal;
    var copying = copyInProgress(cv);
    if (!copying || !Number.isFinite(total) || total <= 0 || !Array.isArray(cv._growingRanges)) {
      return { segments: [], percent: null, complete: false };
    }
    var ranges = [], merged = [], bytes = 0;
    for (var i = 0; i < cv._growingRanges.length; i++) {
      var r = cv._growingRanges[i];
      if (!Array.isArray(r) || !Number.isFinite(r[0]) || !Number.isFinite(r[1])) continue;
      var start = clamp(r[0], 0, total), end = clamp(r[1], 0, total);
      if (end > start) ranges.push([start, end]);
    }
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    for (var j = 0; j < ranges.length; j++) {
      var last = merged[merged.length - 1], next = ranges[j];
      if (last && next[0] <= last[1]) last[1] = Math.max(last[1], next[1]);
      else merged.push([next[0], next[1]]);
    }
    // Without a known duration the gate cannot judge a jump either; draw the
    // raw downloaded ranges then.
    var segments = [], m = Number.isFinite(duration) && duration > 0
      ? copyMargins(duration, total) : { before: 0, after: 0 };
    for (var k = 0; k < merged.length; k++) {
      bytes += merged[k][1] - merged[k][0];
      // A segment touching the file start or end needs no margin on that side.
      var s0 = merged[k][0] > 0 ? merged[k][0] + m.before : 0;
      var s1 = merged[k][1] < total ? merged[k][1] - m.after : total;
      if (s1 > s0) segments.push({ start: s0 / total, width: (s1 - s0) / total });
    }
    var complete = bytes >= total;
    return { segments: complete ? [] : segments, percent: Math.floor(bytes / total * 100), complete: complete };
  }
  function seekLocked(cv) {
    return !!(cv && (cv._directSeedr || cv._localHandoffPending));
  }
  function sourceStatus(cv, download) {
    cv = cv || {};
    if (cv._localHandoffPending) return 'Switching to laptop…';
    var percent = download.percent == null ? '' : download.percent + '%';
    var copying = copyInProgress(cv);
    if (cv._directSeedr) return copying
      ? 'Seedr · copying to laptop' + (percent ? ' ' + percent : '') : 'Seedr';
    if (!cv._growingCache || !copying || download.complete) return '';
    var speed = cv._growingBytesPerSec;
    return 'Laptop' + (percent ? ' · ' + percent : ' · copying')
      + (Number.isFinite(speed) && speed >= 0 ? ' · ' + Math.round(speed / 1000000) + ' MB/s' : '');
  }
  function remainingText(duration, position) {
    if (!Number.isFinite(duration) || duration <= 0) return '--:--';
    return '-' + fmt(Math.max(0, duration - (Number.isFinite(position) ? Math.max(0, position) : 0)));
  }
  function playerTimeState(duration, position, nowMs, rate, formatClock) {
    if (!Number.isFinite(duration) || duration <= 0) return { remaining: '--:--', endsAt: '' };
    var remaining = Math.max(0, duration - (Number.isFinite(position) ? Math.max(0, position) : 0));
    var speed = Number.isFinite(rate) && rate > 0 ? rate : 1;
    return { remaining: remainingText(duration, position), endsAt: 'Ends at ' + formatClock(nowMs + remaining / speed * 1000) };
  }
  function formatTvClock(ms) {
    var date = new Date(ms);
    try {
      return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
    }
  }
  // End pure overlay models.

  function seedrSeekBlocked(target) {
    try {
      return !!(bridge && bridge.blockDirectSeedrSeek
        && bridge.blockDirectSeedrSeek(target));
    } catch (e) { return false; }
  }
  function maxSeek() {
    try {
      if (V.seekable && V.seekable.length) return V.seekable.end(V.seekable.length - 1);
    } catch (e) {}
    return isFinite(V.duration) ? V.duration : 0;
  }
  // ---- remux time mapping -------------------------------------------------
  // Under the remux, <video> plays a ROLLING WINDOW: V.currentTime is relative
  // to the current HLS generation (0-based) and V.duration is only the window
  // length. The TRUE movie clock is Remux: absoluteMovieTime = sessionStartTime
  // + V.currentTime, total = Remux.duration. ALL of NF's position/seek/subtitle
  // logic runs in ABSOLUTE movie time via these helpers, so the seek bar shows
  // the real duration, subs (which are keyed to absolute time) sync, and seeks
  // span the whole movie (in-window = instant, out-of-window = ffmpeg relaunch).
  function RMX() {
    var r = (bridge && bridge.Remux) || (typeof Remux !== 'undefined' ? Remux : null);
    return r;
  }
  function rmxOn() {
    var r = RMX();
    try { return !!(r && r.hasSession()); } catch (e) { return false; }
  }
  // Pause-park (app.js): after a long pause the <video> is released (no src,
  // currentTime/duration gone) and the position lives in currentVideo._parked.
  // Without these fallbacks the bar zeroes out mid-pause and every d-pad step
  // clamps into 0..0 — a dead seekbar exactly when the trick-play UI is up.
  // (Park never coexists with a remux session — app.js excludes those.)
  function parkState() {
    var cv = bridge && bridge.currentVideo;
    return (cv && cv._parked) || null;
  }
  function nowAbs() {
    var p = parkState();
    if (p) return p.pos || 0;
    var r = RMX();
    if (r && rmxOn()) { try { return r.absolute(V.currentTime || 0); } catch (e) {} }
    return V.currentTime || 0;
  }
  // True total runtime (movie length) in remux mode; the plain media duration
  // otherwise. Named dur() because every existing caller wants "the total".
  function dur() {
    var p = parkState();
    if (p && p.dur > 0) return p.dur;
    var r = RMX();
    if (r && rmxOn()) { try { if (r.duration > 0) return r.duration; } catch (e) {} }
    var d = V.duration;
    return (isFinite(d) && d > 0) ? d : maxSeek();
  }
  // Absolute movie time currently buffered ahead (for the buffer bar).
  function bufferedAbsEnd() {
    try {
      if (V.buffered && V.buffered.length) {
        var e = V.buffered.end(V.buffered.length - 1);
        var r = RMX();
        return (r && rmxOn()) ? r.absolute(e) : e;
      }
    } catch (e2) {}
    return nowAbs();
  }
  // Other app subsystems can replace the media generation too (notably the
  // native-memory recycle guard in app.js). Treat those exactly like a normal
  // scrub seek: hide the old cue while the HLS clock/base is changing and only
  // repaint after the replacement generation has landed. The serial makes
  // nested hand-offs safe — a recycle triggered by seeked supersedes the
  // original seek's hold, so the first operation cannot release subtitles in
  // the middle of the second one.
  function beginExternalSeek() {
    var token = ++subSeekSerial;
    subSeekHold = true;
    lastSubKey = ' ';
    if (subTextEl) subTextEl.textContent = '';
    return token;
  }
  function endExternalSeek(token) {
    if (token !== subSeekSerial) return;
    subSeekHold = false;
    lastSubKey = ' ';
    if (active) renderSub(nowAbs());
  }
  window.__nftBeginExternalSeek = beginExternalSeek;
  window.__nftEndExternalSeek = endExternalSeek;

  // Seek to an ABSOLUTE movie time. In remux mode: in-window seeks land instantly
  // (V.currentTime = toRelative); out-of-window seeks relaunch ffmpeg at a
  // preceding keyframe (Remux.seekAbsolute). Direct playback: plain currentTime.
  function seekAbs(abs) {
    abs = clamp(abs, 0, Math.max(0, dur() - 0.5));
    if (seedrSeekBlocked(abs)) return Promise.resolve({ blocked: true });
    // Subtitle cues use the remux absolute clock. During a large seek that
    // clock is deliberately replaced before webOS finishes replacing the HLS
    // media generation, so suppress rendering until the requested frame has
    // actually landed. Otherwise a transient/stale media currentTime can paint
    // a cue from the wrong scene and leave it visible throughout buffering.
    var subToken = beginExternalSeek();
    function finishSubSeek(promise) {
      return Promise.resolve(promise).then(function (value) {
        endExternalSeek(subToken);
        return value;
      }, function (err) {
        endExternalSeek(subToken);
        throw err;
      });
    }
    // Parked video (see parkState above): there is no media element to seek —
    // retarget the park bookmark instead, so __npResume() re-opens the stream
    // at the scrubbed position. Touching V here would be a silent no-op and
    // the user's scrub would be discarded on resume.
    var pk = parkState();
    if (pk) {
      pk.pos = abs;
      wake();
      return finishSubSeek(Promise.resolve({ local: true, parked: true }));
    }
    var wasPlaying = !V.paused;
    function land(relativeTime, exact) {
      relativeTime = Math.max(0, relativeTime);
      return new Promise(function (resolve) {
        var settled = false, timer = 0, poll = 0;
        function cleanup() {
          clearTimeout(timer); clearTimeout(poll);
          try { V.removeEventListener('seeked', check); } catch (e) {}
          try { V.removeEventListener('timeupdate', check); } catch (e) {}
        }
        function finish() {
          if (settled) return;
          settled = true; cleanup(); resolve();
        }
        function check() {
          if (settled) return;
          clearTimeout(poll); poll = 0;
          if (!active) return finish();
          var ct = Number(V.currentTime);
          // For remux HLS we use an exact currentTime seek and wait for the
          // native pipeline to acknowledge it. Direct playback keeps fastSeek
          // (cold MKV safety) and may intentionally snap to a keyframe, so its
          // seeked event is sufficient without a target-distance test.
          if (!V.seeking && V.readyState >= 2 && Number.isFinite(ct)
              && (!exact || Math.abs(ct - relativeTime) <= 0.75)) return finish();
          poll = setTimeout(check, 100);
        }

        V.addEventListener('seeked', check);
        V.addEventListener('timeupdate', check);
        try {
          if (exact) V.currentTime = relativeTime;
          else if (typeof V.fastSeek === 'function') V.fastSeek(relativeTime);
          else V.currentTime = relativeTime;
        } catch (e) {
          try { V.currentTime = relativeTime; } catch (e2) {}
        }
        // A large remux seek reloads the media source, which pauses the
        // element. Resume only if it was playing before the seek; paused
        // trick-play remains paused after the seek.
        if (wasPlaying && V.paused) {
          try { V.play().catch(function () {}); } catch (e3) {}
        }
        if (!settled) {
          timer = setTimeout(finish, 5000);
          clearTimeout(poll);
          poll = setTimeout(check, 0);
        }
      });
    }
    var r = RMX();
    if (r && rmxOn()) {
      PLAYER.classList.add('nft-buffering');
      return finishSubSeek(r.seekAbsolute(abs).then(function (res) {
        if (!active) return;
        // Out-of-window remux seeks restart at the PRECEDING keyframe. Land at
        // the exact requested time inside that new generation instead of
        // leaving playback at the earlier keyframe.
        var rel = (res && typeof res.relativeTime === 'number')
          ? res.relativeTime : r.toRelative(abs);
        return land(rel, true).then(function () {
          lastSubKey = ' ';
          // Staying paused (paused trick-play scrub): no 'playing' event is
          // coming to clear the spinner this function put up — clear it here.
          if (V.paused) PLAYER.classList.remove('nft-buffering');
          wake();
          return res;
        });
      }).catch(function () {
        // Fall back only when the requested absolute time still maps into the
        // current local window. A negative/out-of-window relative time would
        // otherwise jump to the start and make the bar look unresponsive.
        var fallback = null;
        try {
          var rel = r.toRelative(abs), end = maxSeek();
          if (rel >= 0 && (!end || rel <= end + 0.5)) fallback = land(rel, true);
        } catch (e) {}
        return Promise.resolve(fallback).then(function () {
          if (V.paused) PLAYER.classList.remove('nft-buffering');
          wake();
          return null;
        });
      }));
    } else {
      return finishSubSeek(land(abs, false).then(function () {
        wake();
        return { local: true };
      }));
    }
  }
  function p2(n) {
    n = parseInt(n, 10);
    return isNaN(n) ? '' : (n < 10 ? '0' + n : '' + n);
  }
  // On-screen title from a raw release filename:
  //   "Example.Show.S01E02.Example.Episode.1080p.HEVC.x265-GROUP[example].mkv"
  //   → "Example Episode"       (with show context — the show line already
  //                               carries "EXAMPLE SHOW · S01E02")
  //   → "Example Show S01E02 Example Episode"  (no show context)
  // Strategy: drop the extension, normalise separators, cut at the first
  // quality/source token, strip bracketed groups and trailing years.
  var TITLE_JUNK_RE = /\b(2160p|1080p|720p|480p|4k|uhd|hdr10\+?|hdr|dv|dovi|hevc|x26[45]|h ?26[45]|av1|web[- ]?dl|webrip|web|bluray|blu ray|bdrip|brrip|hdtv|dvdrip|ddp?[.\s]?[257][.\s]?[01]?|aac|ac3|eac3|atmos|truehd|dts(-?hd)?|proper|repack|remux|extended|10bit|8bit|multi|dual[- ]?audio)\b/i;
  function cleanTitle(raw, show) {
    var s = String(raw || '');
    s = s.replace(/\.(mkv|mp4|avi|m4v|webm|mov|mpg|mpeg|ts)$/i, '');
    s = s.replace(/[._]+/g, ' ');
    var cut = s.search(TITLE_JUNK_RE);
    if (cut > 0) s = s.slice(0, cut);
    s = s.replace(/[\[(][^\])]*[\])]/g, ' ');            // [EZTVx.to] / (2025)
    s = s.replace(/\s+(19|20)\d{2}\s*$/, '');            // trailing bare year
    if (show && show.title) {
      s = s.replace(/\bS\d{1,2}[Ex]\d{1,3}\b/i, ' ');    // dup of the show line
      var st = String(show.title).trim();
      if (st && s.trim().toLowerCase().indexOf(st.toLowerCase()) === 0) {
        s = s.trim().slice(st.length);                   // "Example Show Example Episode" → "Example Episode"
      }
    }
    // A quality cut can leave the opening half of a release group behind
    // ("Example Episode (1080p…" -> "Example Episode ("). Treat unmatched
    // bracket punctuation as trailing decoration too.
    s = s.replace(/\s{2,}/g, ' ').replace(/^[\s\-–—:·]+|[\s\-–—:·\(\[\{]+$/g, '').trim();
    if (!s && show && show.title) s = String(show.title).trim();
    return s || String(raw || '');
  }

  function onWaiting() { if (active) PLAYER.classList.add('nft-buffering'); }
  function onPlaying() { if (active) PLAYER.classList.remove('nft-buffering'); }
  function onSeeked() { if (active) PLAYER.classList.remove('nft-buffering'); }
  function onEnded() {
    if (active && !upnextFired) {
      upnextFired = true;
      fireUpNext();
    }
  }
  function onTimeUpdate() {
    if (!active) return;
    lastTimeUpdateAt = Date.now();
    if (!subSeekHold) renderSub(nowAbs());
    if (controlsShown) wake();
  }

  function build() {
    if (built) return true;
    PLAYER = doc.getElementById('player');
    V = doc.getElementById('video');
    if (!PLAYER || !V) return false;
    built = true;

    nft = elt('div');
    nft.id = 'nft';
    nft.innerHTML =
      '<div class="nft-trick-dim"></div>' +
      '<div class="nft-scrim-top"></div><div class="nft-scrim-bottom"></div>' +
      '<div class="nft-top"><div class="nft-heading"><div class="nft-show"></div><div class="nft-title"></div></div>' +
        '<div class="nft-source"><span class="nft-src-ic nft-src-cloud">' + ICON.cloud + '</span>' +
          '<span class="nft-src-ic nft-src-laptop">' + ICON.laptop + '</span>' +
          '<span class="nft-source-text"></span></div></div>' +
      '<div class="nft-center"><div class="nft-flash"></div><div class="nft-trick"></div></div>' +
      '<div class="nft-bottom">' +
        '<div class="nft-scrub nft-focusable">' +
          '<div class="nft-bubble"><img class="nft-thumb" alt="">' +
            '<div class="nft-bub-row"><span class="nft-bub-t">0:00</span><span class="nft-delta"></span></div></div>' +
          '<div class="nft-strip"><div class="nft-strip-row">' +
            '<div class="nft-strip-card"><div class="nft-strip-img"></div></div>' +
            '<div class="nft-strip-card"><div class="nft-strip-img"></div></div>' +
            '<div class="nft-strip-card"><div class="nft-strip-img"></div></div>' +
            '<div class="nft-strip-card nft-strip-center"><div class="nft-strip-img"></div></div>' +
            '<div class="nft-strip-card"><div class="nft-strip-img"></div></div>' +
            '<div class="nft-strip-card"><div class="nft-strip-img"></div></div>' +
            '<div class="nft-strip-card"><div class="nft-strip-img"></div></div>' +
          '</div><div class="nft-strip-time">0:00</div></div>' +
          '<div class="nft-track"><div class="nft-downloaded"></div><div class="nft-buf"></div><div class="nft-fill"></div><div class="nft-head"></div></div></div>' +
        '<div class="nft-times"><span class="nft-cur">0:00</span><span class="nft-time-end"><span class="nft-dur">--:--</span><span class="nft-ends"></span></span></div>' +
        '<div class="nft-controls">' +
          '<button class="nft-btn nft-icon nft-focusable nft-rew">' + ICON.back10 + '<span class="nft-lock">' + ICON.lock + '</span></button>' +
          // Both play/pause glyphs live in the DOM; the is-paused class
          // cross-fades them (opacity+scale, interruptible) instead of an
          // innerHTML swap that popped with no transition.
          '<button class="nft-btn nft-icon nft-play nft-focusable nft-pp">' +
            '<span class="nft-ic nft-ic-play">' + ICON.play + '</span>' +
            '<span class="nft-ic nft-ic-pause">' + ICON.pause + '</span>' +
          '</button>' +
          '<button class="nft-btn nft-icon nft-focusable nft-fwd">' + ICON.fwd10 + '<span class="nft-lock">' + ICON.lock + '</span></button>' +
          '<div class="nft-gap"></div>' +
          '<button class="nft-btn nft-focusable nft-subs-b">' + ICON.cc + '<span>Subtitles</span></button>' +
          '<button class="nft-btn nft-focusable nft-audio-b">' + ICON.audio + '<span>Audio</span></button>' +
          '<button class="nft-btn nft-focusable nft-speed-b">' + ICON.speed + '<span class="nft-spd-tag">1×</span></button>' +
          '<button class="nft-btn nft-focusable nft-sync-b">' + ICON.sync + '<span>Sync 0.0s</span></button>' +
          '<button class="nft-btn nft-focusable nft-next-b" style="display:none">' + ICON.next + '<span>Next</span></button>' +
        '</div>' +
      '</div>';
    PLAYER.appendChild(nft);

    subsEl = elt('div', 'nft-subs');
    // Keep one text node for the full playback to limit glyph and raster
    // pressure on memory-constrained renderers. textContent reuses the same
    // layer and avoids parsing subtitle text as markup.
    subTextEl = elt('span');
    subsEl.appendChild(subTextEl);
    PLAYER.appendChild(subsEl);
    PLAYER.appendChild(elt('div', 'nft-spin',
      '<svg viewBox="0 0 48 48"><circle class="nft-spin-rail" cx="24" cy="24" r="20"/>' +
      '<circle cx="24" cy="24" r="20"/></svg>'));
    toastEl = elt('div', 'nft-toast');
    PLAYER.appendChild(toastEl);

    R.skipPill = elt('div', 'nft-skip-pill nft-focusable', ICON.next + '<span>Skip Intro</span>');
    PLAYER.appendChild(R.skipPill);
    R.seekInd = elt('div', 'nft-seek-ind');
    PLAYER.appendChild(R.seekInd);

    R.show = $('.nft-show'); R.title = $('.nft-title'); R.scrub = $('.nft-scrub');
    R.downloaded = $('.nft-downloaded'); R.downloadEls = [];
    R.source = $('.nft-source'); R.sourceText = $('.nft-source-text'); R.ends = $('.nft-ends');
    R.rewLabel = 'Back 10 seconds'; R.fwdLabel = 'Forward 10 seconds';
    R.track = $('.nft-track'); R.rew = $('.nft-rew'); R.fwd = $('.nft-fwd');
    R.subsB = $('.nft-subs-b'); R.audioB = $('.nft-audio-b'); R.speedB = $('.nft-speed-b');
    R.fill = $('.nft-fill'); R.buf = $('.nft-buf'); R.head = $('.nft-head');
    R.bubble = $('.nft-bubble'); R.bubT = $('.nft-bub-t'); R.delta = $('.nft-delta');
    R.cur = $('.nft-cur'); R.dur = $('.nft-dur'); R.pp = $('.nft-pp'); R.flash = $('.nft-flash');
    R.trick = $('.nft-trick'); R.spd = $('.nft-spd-tag'); R.syncB = $('.nft-sync-b');
    R.nextB = $('.nft-next-b');
    R.syncLabel = R.syncB.querySelector('span');
    R.skipLabel = R.skipPill.querySelector('span');
    R.markEls = [];   // chapter-marker dots on the scrub track (lazy)
    R.thumb = $('.nft-thumb');
    // The ok-class only flips on a REAL load, so a 404 (engine without
    // thumbnails) or a broken image can never show; while the next bucket
    // loads, the previous frame stays up — a close preview beats a flicker.
    R.thumb.addEventListener('load', function () { R.bubble.classList.add('nft-thumb-ok'); });
    R.thumb.addEventListener('error', function () { R.bubble.classList.remove('nft-thumb-ok'); });
    // Filmstrip: 7 fixed card slots (see the strip markup above), grabbed
    // once here and reused for the life of the app — content is reassigned
    // per-slot, the DOM node count never changes.
    R.strip = $('.nft-strip'); R.stripRow = $('.nft-strip-row'); R.stripTime = $('.nft-strip-time');
    R.stripCards = []; R.stripImgs = []; R.stripUrl = [];
    var stripCardNodes = nft.querySelectorAll('.nft-strip-card');
    var stripImgNodes = nft.querySelectorAll('.nft-strip-img');
    for (var si = 0; si < stripCardNodes.length; si++) {
      R.stripCards.push(stripCardNodes[si]);
      R.stripImgs.push(stripImgNodes[si]);
      R.stripUrl.push('');
    }
    // Row-to-row pitch for the slide FX, MEASURED (not hardcoded) so it
    // always matches the real CSS card width + gap even if those change.
    stripCardPitch = (R.stripCards.length > 1)
      ? (R.stripCards[1].offsetLeft - R.stripCards[0].offsetLeft) : 0;
    controls = [R.rew, R.pp, R.fwd, R.subsB, R.audioB, R.speedB, R.syncB, R.nextB];

    V.addEventListener('play', onPlayState);
    V.addEventListener('pause', onPlayState);
    V.addEventListener('waiting', onWaiting);
    V.addEventListener('playing', onPlaying);
    V.addEventListener('seeked', onSeeked);
    V.addEventListener('ended', onEnded);
    V.addEventListener('timeupdate', onTimeUpdate);
    doc.addEventListener('keydown', onKey, true);
    PLAYER.addEventListener('click', onPointer, true);
    PLAYER.addEventListener('mousemove', onPointerMove, true);
    return true;
  }

  function closestCls(el, cls) {
    while (el && el !== PLAYER) {
      if (el.classList && el.classList.contains(cls)) return el;
      el = el.parentNode;
    }
    return null;
  }
  function appMenuOpen() {
    var menu = doc.getElementById('p-menu'), up = doc.getElementById('p-upnext');
    return (menu && !menu.hidden) || (up && !up.hidden);
  }
  function onPointer(e) {
    if (!active || appMenuOpen()) return;
    var btn = closestCls(e.target, 'nft-btn');
    if (btn) {
      e.preventDefault(); e.stopPropagation();
      showControls(); setFocus(btn); activateFocused(); resetHide();
      return;
    }
    var stripCard = closestCls(e.target, 'nft-strip-card');
    if (stripCard && !stripCard.classList.contains('nft-strip-empty')) {
      e.preventDefault(); e.stopPropagation();
      showControls(); setFocus(R.scrub); stripCardClickAt(stripCard); resetHide();
      return;
    }
    if (closestCls(e.target, 'nft-scrub')) {
      e.preventDefault(); e.stopPropagation();
      showControls(); setFocus(R.scrub); scrubClickAt(e.clientX); resetHide();
      return;
    }
    if (closestCls(e.target, 'nft-skip-pill')) {
      e.preventDefault(); e.stopPropagation(); doSkip(); return;
    }
    e.preventDefault(); e.stopPropagation();
    if (!controlsShown) showControls(); else togglePlay();
    resetHide();
  }
  function onPointerMove() {
    if (!active || appMenuOpen()) return;
    var now = Date.now();
    if (now - lastMove < 120) return;
    lastMove = now;
    if (!controlsShown) showControls(); else resetHide();
  }
  function scrubClickAt(clientX) {
    var track = R.track;
    // D-pad-generated synthetic clicks report x=0. Only a real Magic Remote
    // pointer click should translate screen coordinates into a seek.
    if (!track || !clientX) return;
    var rect = track.getBoundingClientRect();
    if (!rect.width) return;
    resetDpadGesture();
    var target = clamp((clientX - rect.left) / rect.width, 0, 1) * dur();
    if (seedrSeekBlocked(target)) return;
    seekTarget = target;
    showBubble();
    commitSeek();
  }
  // Filmstrip card click → seek: the SAME commit machinery as scrubClickAt
  // above (set seekTarget, then commitSeek() -> seekAbs()) so remux
  // window/absolute mapping, resume bookkeeping and play/pause semantics
  // stay in exactly one place — no parallel seek path. Unlike a track click,
  // the target time is already known exactly (the card's own manifest
  // bucket, an integer index * interval — no clientX/track-width math), so
  // the strip is force-recentered with an immediate snapStripTo() rather
  // than letting showFilmstrip() run its usual one-pitch slide-then-correct
  // (that's for continuous scrub stepping; a direct card pick should land
  // exactly where the user pointed, instantly).
  function stripCardClickAt(card) {
    var info = thumbsInfo;
    if (!info || stripCenterIdx < 0 || !card) return;
    var slot = R.stripCards.indexOf(card);
    if (slot < 0 || card.classList.contains('nft-strip-empty')) return;
    var idx = clamp(stripCenterIdx + STRIP_OFFSETS[slot], 0, info.count - 1);
    var t = clamp(idx * info.interval, 0, Math.max(0, dur() - 0.5));
    if (seedrSeekBlocked(t)) return;
    resetDpadGesture();
    seekTarget = t;
    R.stripTime.textContent = fmt(t);
    maybeWarmAdjacentSheet(idx);
    snapStripTo(idx);
    commitSeek();
  }

  function activate() {
    if (active || !build()) return;
    active = true;
    bridge = window.__dumi || null;
    window.__nfActive = true;
    try { if (bridge && bridge.dpad) bridge.dpad.disable(); } catch (e) {}
    PLAYER.classList.add('nft-on');

    var cv = bridge && bridge.currentVideo;
    var rawTitle = (cv && cv.title) || (doc.getElementById('p-title') || {}).textContent || '';
    var showCtx = (cv && cv.show && cv.show.title) ? cv.show : null;
    R.title.textContent = cleanTitle(rawTitle, showCtx);
    R.show.textContent = showCtx
      ? showCtx.title + ' · S' + p2(showCtx.season) + 'E' + p2(showCtx.episode)
      : (doc.getElementById('p-show') || {}).textContent || '';

    subOffset = 0;
    subSeekHold = false;
    subSeekSerial++;
    seekTarget = null;
    seekPending = null;
    seekBusy = false;
    resetDpadGesture();
    seekRequestId++;
    seekAccum = 0;
    lastSubKey = ' ';
    lastTimeStr = '';
    lastCopyPaintAt = lastEndPaintAt = lastSeekLocked = null;
    lastTimeUpdateAt = 0;
    upnextFired = false;
    nextPending = false;
    nextRequestId++;
    skipTarget = null;
    skipKind = null;
    lastMarksSig = '';        // new episode → re-place the chapter markers
    updateSyncLabel();

    R.skipPill.classList.remove('nft-vis');
    R.seekInd.classList.remove('nft-vis');
    resetThumbs();
    if (cv && cv._cacheRel) preloadThumbs(cv._cacheRel);
    onPlayState();
    showControls();

    if (subTimer) clearInterval(subTimer);
    subTimer = setInterval(mediaTick, MEDIA_TICK);
    mediaTick();
  }

  function mediaTick() {
    if (!active) return;
    if (!subSeekHold && Date.now() - lastTimeUpdateAt > MEDIA_TICK + 250) renderSub(nowAbs());
    var d = dur();
    var t = nowAbs();
    updatePills(d);
    updateSyncLabel();
    refreshMarks(d);
    checkUpNextTrigger(t, d);
    // Final safety net: the credits-window trigger above covers the normal
    // case, but a file with neither a credits mark nor enough runtime for the
    // 30s fallback window (very short clip) still gets an offer right at the
    // true end. Same upnextFired guard, so this never double-fires with it.
    if (d > 0 && t >= d - 1 && !upnextFired) {
      upnextFired = true;
      fireUpNext();
    }
  }
  // Up-next prompt: fire at the credits mark (falling back to the last
  // ~30s when the file has no mark) instead of waiting for the d-1s fallback
  // just above. Shares the SAME upnextFired guard (never double-fires with
  // it) but, unlike that one-shot fallback, RE-ARMS when playback moves back
  // to clearly before the window — rewinding out of the credits to rewatch a
  // scene and coming back re-offers the card. bridge.rearmUpNext() (distinct
  // from cancelUpNext) hides an already-showing card WITHOUT the permanent
  // per-file dismissal a deliberate Back press sets.
  var UPNEXT_REARM_MARGIN = 3;
  function upNextWindowStart(cv, d) {
    if (d <= 0) return null;
    var cr = cv && cv._creditsMark;
    var start = (cr && cr.start > 0) ? cr.start : Math.max(0, d - 30);
    // Mirror app.js's maybeShowUpNext() defense-in-depth ceiling (90s): an
    // implausibly early credits mark (bad crowd/chapter data) must never
    // trigger the early offer here — returning null makes checkUpNextTrigger
    // skip it entirely, so upnextFired stays false and the classic d-1s
    // fallback in mediaTick is still free to fire at the genuine end.
    if (d - start > 90) return null;
    return start;
  }
  function checkUpNextTrigger(t, d) {
    var cv = bridge && bridge.currentVideo;
    if (!cv || !cv.show) return;   // only episodic content has an up-next flow
    var windowStart = upNextWindowStart(cv, d);
    if (windowStart == null) return;
    if (upnextFired) {
      if (t < windowStart - UPNEXT_REARM_MARGIN) {
        upnextFired = false;
        try { if (bridge && bridge.rearmUpNext) bridge.rearmUpNext(); } catch (e) {}
      }
      return;
    }
    if (t >= windowStart) {
      upnextFired = true;
      fireUpNext();
    }
  }

  // Chapter markers: quiet dots on the scrub track at "skippable structure"
  // boundaries — end of recap, end of intro, start of credits — so the bar
  // pre-reads the episode's shape at a glance. Signature-cached: the DOM is
  // only touched when the marks (or duration) actually change.
  var lastMarksSig = '';
  function refreshMarks(d) {
    if (!R.track) return;
    var cv = bridge && bridge.currentVideo;
    var pts = [];
    if (cv && d > 0) {
      var m;
      if ((m = cv._recapMark) && m.end > 0 && m.end < d) pts.push(m.end);
      if ((m = cv._introMark) && m.end > 0 && m.end < d) pts.push(m.end);
      if ((m = cv._creditsMark) && m.start > 0 && m.start < d) pts.push(m.start);
    }
    var sig = (d | 0) + '|' + pts.map(function (p) { return p | 0; }).join(',');
    if (sig === lastMarksSig) return;
    lastMarksSig = sig;
    while (R.markEls.length < pts.length) {
      var dot = elt('i', 'nft-mark');
      R.track.appendChild(dot);
      R.markEls.push(dot);
    }
    for (var i = 0; i < R.markEls.length; i++) {
      if (i < pts.length) {
        R.markEls[i].style.left = (pts[i] / d * 100) + '%';
        R.markEls[i].style.display = '';
      } else {
        R.markEls[i].style.display = 'none';
      }
    }
  }

  function deactivate() {
    if (!active) return;
    active = false;
    window.__nfActive = false;
    try { if (bridge && bridge.dpad) bridge.dpad.enable(); } catch (e) {}

    PLAYER.classList.remove('nft-on', 'nft-controls-shown', 'nft-buffering');
    nft.classList.remove('nft-show');
    R.skipPill.classList.remove('nft-vis', 'nft-focused');
    R.seekInd.classList.remove('nft-vis');
    R.bubble.classList.remove('nft-vis');
    if (subTextEl) subTextEl.textContent = '';
    lastSubCues = null;
    toastEl.classList.remove('nft-vis');
    resetThumbs();   // also hides the filmstrip + the nft-trick-on dim class

    clearTimeout(hideTimer);
    clearTimeout(commitTimer);
    clearTimeout(seekIndTimer);
    clearTimeout(bubbleTimer);
    clearTimeout(toastTimer);
    clearTimeout(speedTimer);
    hideTimer = commitTimer = seekIndTimer = bubbleTimer = toastTimer = speedTimer = 0;
    if (uiTimer) { clearTimeout(uiTimer); uiTimer = 0; }
    if (subTimer) { clearInterval(subTimer); subTimer = 0; }

    nextRequestId++;
    seekRequestId++;
    subSeekSerial++;
    subSeekHold = false;
    nextPending = false;
    seekTarget = null;
    seekPending = null;
    seekBusy = false;
    resetDpadGesture();
    bridge = null;
    controlsShown = false;
    focusEl = null;
  }

  function loop() {
    uiTimer = 0;
    if (!active) return;

    var d = dur();
    // While scrubbing, paint the requested target immediately. While a remux
    // seek is landing, keep that committed target on-screen instead of
    // snapping the playhead back to the old position for several seconds.
    var t = seekTarget != null ? seekTarget
      : (seekPending != null ? seekPending : nowAbs());
    var fraction = d > 0 ? clamp(t / d, 0, 1) : 0;
    R.fill.style.transform = 'scaleX(' + fraction + ')';
    R.head.style.left = fraction * 100 + '%';
    // Clamp the bubble away from the edges so the (300px-wide, centered)
    // preview card never hangs off-screen at the ends of the track.
    if (R.bubble.classList.contains('nft-vis')) {
      R.bubble.style.left = clamp(fraction, 0.1, 0.9) * 100 + '%';
    }

    var buffered = 0;
    try {
      if (V.buffered && V.buffered.length && d > 0) buffered = clamp(bufferedAbsEnd() / d, 0, 1);
    } catch (e) {}
    R.buf.style.width = buffered * 100 + '%';

    var current = fmt(t);
    var total = remainingText(d, t);
    var timeSig = current + '|' + total;
    if (timeSig !== lastTimeStr) {
      R.cur.textContent = current;
      R.dur.textContent = total;
      lastTimeStr = timeSig;
    }

    updateTransferUI(d, t, Date.now());

    if (controlsShown || seekTarget != null || seekPending != null) {
      // Paused controls still need copy/clock updates; reuse this one timer.
      uiTimer = setTimeout(loop, V.paused && seekTarget == null && seekPending == null ? MEDIA_TICK : UI_TICK);
    }
  }
  function updateTransferUI(d, t, now) {
    if (!controlsShown) return;
    var cv = bridge && bridge.currentVideo;
    var locked = seekLocked(cv);
    if (locked !== lastSeekLocked) {
      R.rew.classList.toggle('nft-locked', locked);
      R.fwd.classList.toggle('nft-locked', locked);
      R.rew.setAttribute('aria-disabled', String(locked));
      R.fwd.setAttribute('aria-disabled', String(locked));
      R.rew.setAttribute('aria-label', R.rewLabel + (locked ? ' (locked while copying)' : ''));
      R.fwd.setAttribute('aria-label', R.fwdLabel + (locked ? ' (locked while copying)' : ''));
      lastSeekLocked = locked;
    }
    if (lastCopyPaintAt == null || now - lastCopyPaintAt >= 500) {
      lastCopyPaintAt = now;
      var download = downloadState(cv, d), segments = download.segments;
      // Grow a high-water pool only as needed; reuse/hide nodes on later ticks.
      for (var i = 0; i < Math.max(segments.length, R.downloadEls.length); i++) {
        var el = R.downloadEls[i], segment = segments[i];
        if (!el) {
          el = elt('div', 'nft-download-segment');
          R.downloaded.appendChild(el);
          R.downloadEls.push(el);
        }
        if (segment) {
          el.style.left = segment.start * 100 + '%';
          el.style.width = segment.width * 100 + '%';
          el.style.display = '';
        } else el.style.display = 'none';
      }
      paintSourceStatus(cv, download);
    }
    if (lastEndPaintAt == null || now - lastEndPaintAt >= 1000) {
      lastEndPaintAt = now;
      var times = playerTimeState(d, t, now, V.playbackRate, formatTvClock);
      if (R.ends.textContent !== times.endsAt) R.ends.textContent = times.endsAt;
    }
  }
  function paintSourceStatus(cv, download) {
    var status = sourceStatus(cv, download);
    if (R.sourceText.textContent !== status) R.sourceText.textContent = status;
    R.source.classList.toggle('nft-source-visible', !!status);
    // Cloud glyph while the picture still comes from Seedr, laptop after.
    R.source.classList.toggle('nft-source-seedr', !!(cv && cv._directSeedr));
  }
  // Source changes must clear a stale switching pill even with controls hidden.
  // Paint only the pill; do not wake the timeline or reveal the controls.
  window.__nftRefreshSourceStatus = function () {
    if (!active || !bridge || !R.sourceText || !R.source) return;
    var cv = bridge.currentVideo;
    paintSourceStatus(cv, downloadState(cv, dur()));
  };
  function wake() { if (active && !uiTimer) loop(); }

  function onPlayState() {
    if (!active) return;
    R.pp.classList.toggle('is-paused', !!V.paused);
    var silent = false;
    try { silent = window.__nftSilentUntil && performance.now() < window.__nftSilentUntil; } catch (e) {}
    if (silent) flash(V.paused ? ICON.pause : ICON.play);
    else if (V.paused) showControls(true);
    else resetHide();
    // Paused trick-play preview (filmstrip when a sprite
    // manifest is ready, else the plain bubble) — cache-backed sources only,
    // so a Seedr-only/remote file (no sprite sheets) never grows a bare
    // time-only popup it never had before; scrubbing (seekStep) still shows
    // the same preview for every source, unchanged.
    var cv = bridge && bridge.currentVideo;
    if (V.paused && cv && cv._cacheRel) {
      showBubble();
    } else if (!V.paused && seekTarget == null && !bubbleTimer) {
      hideBubble();
    }
    if (V.paused && built) {
      // Pause contract: the timeline takes focus, so LEFT/RIGHT
      // step the trick-play strip immediately and OK commits — without
      // first navigating up from the buttons row (DOWN still reaches it).
      showControls();
      setFocus(R.scrub);
    }
    wake();
  }
  function togglePlay() {
    // Pause-park (app.js): a long pause releases the hardware decoder to
    // stop it OOM-rotting; a parked video has no src, so V.play() would be
    // a silent no-op. __npResume re-opens the stream at the parked position.
    if (window.__npResume && window.__npResume()) { flash(ICON.play); return; }
    if (V.paused) {
      V.play().catch(function () {});
      flash(ICON.play);
    } else {
      V.pause();
      flash(ICON.pause);
    }
  }
  function flash(icon) {
    R.flash.innerHTML = icon;
    R.flash.classList.remove('nft-go');
    void R.flash.offsetWidth;
    R.flash.classList.add('nft-go');
  }

  function resetDpadGesture() {
    dpadTarget = null;
    dpadLastAt = 0;
    seekAccum = 0;
  }
  function advanceDpadTarget(dir) {
    var now = Date.now();
    if (dpadTarget == null || now - dpadLastAt > D_PAD_GESTURE_IDLE) {
      dpadTarget = seekTarget != null ? seekTarget
        : (seekPending != null ? seekPending : nowAbs());
      seekAccum = 0;
    }
    dpadLastAt = now;
    var before = dpadTarget;
    dpadTarget = clamp(before + dir * D_PAD_SEEK_STEP,
      0, Math.max(0, dur() - 0.5));
    seekAccum += Math.round(dpadTarget - before);
    return dpadTarget;
  }
  function seekStep(dir) {
    var target = advanceDpadTarget(dir);
    if (seedrSeekBlocked(target)) {
      resetDpadGesture();
      hideBubble();
      hideSeekInd();
      return;
    }
    // D-pad contract: every key event is one exact 10-second
    // step. Repeated presses build from the visible/pending target, never
    // from a stale media clock and never from a sprite-sheet bucket edge.
    seekTarget = target;
    // Quick-skip is not trick-play: keep the preview cards/sprite sheets out
    // of this path and flash only the compact cumulative +/-seconds indicator.
    hideBubble();
    showSeekInd(seekAccum);
    clearTimeout(commitTimer);
    // Direct Range playback can start the native seek now. commitSeek keeps
    // an in-flight seek serialized; further presses remain in seekTarget and
    // are applied to the final accumulated point as soon as it lands.
    var r = RMX();
    if (r && rmxOn()) commitTimer = setTimeout(commitSeek, REMUX_SEEK_IDLE);
    else commitSeek();
    wake();
  }
  function commitSeek() {
    clearTimeout(commitTimer);
    commitTimer = 0;
    if (seekTarget == null) return;
    if (seedrSeekBlocked(seekTarget)) {
      seekTarget = null;
      seekPending = null;
      seekBusy = false;
      resetDpadGesture();
      hideBubble();
      hideSeekInd();
      return;
    }
    // Remux generation replacements must stay serialized. Direct Play does
    // not: a newer D-pad press supersedes the in-flight native currentTime
    // request immediately, so rapid +10s presses go straight to the newest
    // accumulated target instead of first waiting for an obsolete frame.
    var r = RMX();
    if (seekBusy && r && rmxOn()) return;
    var t = seekTarget;
    seekTarget = null;
    seekPending = t;
    seekBusy = true;
    var requestId = ++seekRequestId;
    Promise.resolve(seekAbs(t)).then(finishSeek, finishSeek);
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(hideBubble, 250);
    clearTimeout(seekIndTimer);
    seekIndTimer = setTimeout(hideSeekInd, QUICK_SKIP_INDICATOR_MS);
    wake();

    function finishSeek() {
      if (!active || requestId !== seekRequestId) return;
      seekBusy = false;
      if (seekTarget != null) {
        // The user moved again while this request was in flight. Keep the new
        // card selected and land it next without another full idle delay.
        clearTimeout(commitTimer);
        commitTimer = setTimeout(commitSeek, 180);
      } else {
        seekPending = null;
      }
      wake();
    }
  }
  function seekStepMinimal(dir) {
    seekStep(dir);
  }
  function showSeekInd(delta) {
    var forward = delta >= 0, amount = Math.abs(delta);
    var chevs = '<span class="nft-si-chevs">' + ICON.chev + ICON.chev + ICON.chev + '</span>';
    R.seekInd.className = 'nft-seek-ind ' + (forward ? 'right' : 'left') + ' nft-vis';
    R.seekInd.innerHTML = forward
      ? '<span class="nft-si-num">' + amount + 's</span>' + chevs
      : chevs + '<span class="nft-si-num">' + amount + 's</span>';
    clearTimeout(seekIndTimer);
    seekIndTimer = setTimeout(hideSeekInd, 1000);
  }
  function hideSeekInd() { R.seekInd.classList.remove('nft-vis'); }
  function nudge(direction) { seekStep(direction > 0 ? 1 : -1); }
  function showBubble() {
    // A previous commit's delayed hide must never erase a newly-started scrub.
    clearTimeout(bubbleTimer);
    bubbleTimer = 0;
    var t = seekTarget != null ? seekTarget
      : (seekPending != null ? seekPending : nowAbs());
    // Timeline trick-play FILMSTRIP wins whenever a sprite-sheet
    // manifest is ready (cache-backed sources); every other source falls
    // back to the plain time/delta(+optional single JPEG) bubble, unchanged.
    if (thumbsInfo && thumbsInfo.sheets && thumbsInfo.sheets.length &&
        thumbsInfo.interval > 0 && thumbsInfo.cols && thumbsInfo.rows) {
      R.bubble.classList.remove('nft-vis');
      showFilmstrip(t);
    } else {
      // Self-heal: activate()'s one-shot preload can race the bridge's
      // currentVideo assignment and silently skip even when the manifest is
      // ready server-side and _cacheRel is set, leaving thumbsInfo null.
      // Kick the fetch the first time the preview actually wants the strip;
      // thumbsRel doubles as the once-per-rel guard so this never spams.
      var cvh = bridge && bridge.currentVideo;
      if (!thumbsInfo && cvh && cvh._cacheRel && cvh._cacheRel !== thumbsRel) {
        preloadThumbs(cvh._cacheRel);
      }
      hideFilmstrip();
      showPlainBubble(t);
    }
  }
  function showPlainBubble(t) {
    var delta = Math.round(t - nowAbs());
    R.bubT.textContent = fmt(t);
    R.delta.textContent = delta ? (delta > 0 ? '+' : '') + delta + 's' : '';
    updateThumb(t);
    R.bubble.classList.add('nft-vis');
  }
  // Seek-preview frame for the plain fallback bubble (no sprite manifest).
  // Engine-generated 320px JPEG, bucketed to 5s server-side; the TV only
  // ever holds this ONE <img>, so memory cost is a single decoded 300x168
  // bitmap regardless of movie length. Throttled so a held-down seek
  // doesn't queue a JPEG per repeat.
  var lastThumbAt = 0;
  function updateThumb(t) {
    var r = RMX(), u = null;
    try { u = (r && r.thumbUrl) ? r.thumbUrl(t) : null; } catch (e) {}
    if (!u) { R.bubble.classList.remove('nft-thumb-ok'); return; }
    if (u === R.thumb.getAttribute('src')) return;   // same 5s bucket
    var now = Date.now();
    if (now - lastThumbAt < 250) return;
    lastThumbAt = now;
    R.thumb.src = u;                                 // 'load' flips nft-thumb-ok
  }

  // ---- TV-native trick-play filmstrip (cache-backed sources with a ready
  // sprite manifest) ---------------------------------------------------------
  // ~7 fixed card slots (offsets -3..+3 manifest INTERVALS from the target),
  // center = the seek target — enlarged/bordered, timestamp underneath. The
  // strip is always centered on screen (never over the scrub head); the
  // scrub head on the track below keeps tracking the target as before.
  // Memory/network: each slot is one <div> whose background-image is the
  // ONE sheet its frame lives on; 7 consecutive frames overwhelmingly share
  // a sheet (100 cells/sheet server-side), so the DOM references at most
  // ~2 sheet URLs at once, and stepping past a sheet boundary just
  // overwrites a slot's background-image (nothing is left pinning the old
  // sheet's decoded bitmap). No sheet is ever prefetched wholesale — only
  // the single immediately-adjacent one warms, within STRIP_WARM_MARGIN
  // manifest frames of crossing into it.
  function showFilmstrip(t) {
    var info = thumbsInfo;
    var perSheet = info.cols * info.rows;
    if (!perSheet || !info.count) { hideFilmstrip(); return; }
    var centerIdx = clamp(Math.floor(t / info.interval), 0, info.count - 1);
    R.stripTime.textContent = fmt(t);
    R.strip.classList.add('nft-vis');
    PLAYER.classList.add('nft-trick-on');
    maybeWarmAdjacentSheet(centerIdx);

    if (stripCenterIdx < 0) {                  // first paint this activation
      snapStripTo(centerIdx);
      return;
    }
    if (centerIdx === stripCenterIdx) {
      // Same manifest bucket — but a slide may still be in flight toward an
      // abandoned target (fast direction reversal / key bounce). Cut it off
      // and settle here, or its stale timer would later repaint the center
      // card to the wrong frame.
      if (stripSliding) snapStripTo(centerIdx);
      return;
    }
    var dir = centerIdx > stripCenterIdx ? 1 : -1;
    if (stripSliding) {
      // Rapid repeated steps (held-down key, the 3x FF/RW nudge, etc.) —
      // never let a slide queue up behind another; jump straight to latest.
      snapStripTo(centerIdx);
    } else {
      slideStripTo(centerIdx, dir);
    }
  }
  function hideFilmstrip() {
    if (!R.strip) return;
    R.strip.classList.remove('nft-vis');
    PLAYER.classList.remove('nft-trick-on');
    clearTimeout(stripSlideTimer);
    stripSlideTimer = 0;
    stripSliding = false;
    stripCenterIdx = -1;
    stripWarmedSheet = -1;
  }
  // GPU-safe slide: translate the row by one measured card-pitch in the
  // step direction, then — once the transition would have finished —
  // reassign every card to the new center and reset the transform with no
  // transition (slide, then invisibly re-center — the DOM/card count never
  // changes, only content + a transform).
  function slideStripTo(centerIdx, dir) {
    stripSliding = true;
    R.stripRow.style.transition = '';
    R.stripRow.style.transform = 'translateX(' + (dir > 0 ? -stripCardPitch : stripCardPitch) + 'px)';
    clearTimeout(stripSlideTimer);
    stripSlideTimer = setTimeout(function () { snapStripTo(centerIdx); }, STRIP_SLIDE_MS);
  }
  // Instant (no-transition) settle on `centerIdx` — used for the very first
  // paint AND to cut off a slide a faster-than-the-animation step
  // interrupted, so the strip can never lag behind or queue motion.
  function snapStripTo(centerIdx) {
    clearTimeout(stripSlideTimer);
    stripSlideTimer = 0;
    R.stripRow.style.transition = 'none';
    R.stripRow.style.transform = 'translateX(0)';
    void R.stripRow.offsetWidth;      // commit the snap before re-arming the transition
    R.stripRow.style.transition = '';
    assignStripCards(centerIdx);
    stripCenterIdx = centerIdx;
    stripSliding = false;
  }
  function assignStripCards(centerIdx) {
    var info = thumbsInfo, perSheet = info.cols * info.rows;
    var bgSize = (info.cols * 100) + '% ' + (info.rows * 100) + '%';
    var r = RMX();
    for (var i = 0; i < STRIP_OFFSETS.length; i++) {
      var idx = centerIdx + STRIP_OFFSETS[i];
      var card = R.stripCards[i], img = R.stripImgs[i];
      if (idx < 0 || idx >= info.count) {
        // Off the end of the manifest (near t=0 or t=duration) — clear the
        // background too, not just the opacity, so an edge-of-movie slot
        // never keeps a stale sheet referenced once it goes empty.
        card.classList.add('nft-strip-empty');
        if (R.stripUrl[i]) { img.style.backgroundImage = ''; R.stripUrl[i] = ''; }
        continue;
      }
      var sheetIdx = Math.floor(idx / perSheet), cell = idx % perSheet;
      var col = cell % info.cols, row = Math.floor(cell / info.cols);
      var url = null;
      try { url = (r && r.thumbsSheetUrl) ? r.thumbsSheetUrl(info.sheets[sheetIdx]) : null; } catch (e) {}
      if (!url) {
        card.classList.add('nft-strip-empty');
        if (R.stripUrl[i]) { img.style.backgroundImage = ''; R.stripUrl[i] = ''; }
        continue;
      }
      card.classList.remove('nft-strip-empty');
      if (R.stripUrl[i] !== url) {
        R.stripUrl[i] = url;
        img.style.backgroundSize = bgSize;
        img.style.backgroundImage = 'url(' + url + ')';
      }
      var posX = info.cols > 1 ? (col / (info.cols - 1) * 100) : 0;
      var posY = info.rows > 1 ? (row / (info.rows - 1) * 100) : 0;
      img.style.backgroundPosition = posX + '% ' + posY + '%';
    }
  }
  // Pre-warms the ONE sheet neighboring the current one once the center
  // frame is within STRIP_WARM_MARGIN cells of a sheet boundary, so sliding
  // across it never flashes gray. Not attached to the DOM, so it never
  // becomes a live memory reference held by this module — a one-shot
  // browser-cache prefetch hint, deduped per sheet so it fires once.
  function maybeWarmAdjacentSheet(centerIdx) {
    var info = thumbsInfo, perSheet = info.cols * info.rows;
    if (!perSheet) return;
    var sheetIdx = Math.floor(centerIdx / perSheet);
    var posInSheet = centerIdx - sheetIdx * perSheet;
    var neighbor = -1;
    if (posInSheet < STRIP_WARM_MARGIN && sheetIdx > 0) neighbor = sheetIdx - 1;
    else if (perSheet - posInSheet <= STRIP_WARM_MARGIN && (sheetIdx + 1) * perSheet < info.count) neighbor = sheetIdx + 1;
    if (neighbor < 0 || neighbor === stripWarmedSheet) return;
    stripWarmedSheet = neighbor;
    var r = RMX(), url = null;
    try { url = (r && r.thumbsSheetUrl) ? r.thumbsSheetUrl(info.sheets[neighbor]) : null; } catch (e) {}
    if (url) { var warm = new Image(); warm.src = url; }
  }
  // Manifest preload: fire-and-forget at file start (see activate()), one
  // retry ~30s later if the sheets are still being generated server-side.
  // rel-guarded so a stale resolve from a file the user has since left can
  // never paint over the state of whatever's playing now.
  function resetThumbs() {
    thumbsInfo = null; thumbsRel = null;
    if (thumbsRetryTimer) { clearTimeout(thumbsRetryTimer); thumbsRetryTimer = 0; }
    hideFilmstrip();
    for (var i = 0; i < R.stripCards.length; i++) {
      R.stripCards[i].classList.add('nft-strip-empty');
      R.stripImgs[i].style.backgroundImage = '';
      R.stripUrl[i] = '';
    }
  }
  function preloadThumbs(rel) {
    var r = RMX();
    if (!r || !r.thumbsManifest || !rel) return;
    thumbsRel = rel;
    r.thumbsManifest(rel).then(function (m) {
      if (!active || rel !== thumbsRel) return;   // superseded by a new file
      if (m && m.state === 'ready' && m.sheets && m.sheets.length) {
        thumbsInfo = m;
      } else if (m && m.state === 'generating') {
        clearTimeout(thumbsRetryTimer);
        thumbsRetryTimer = setTimeout(function () { preloadThumbs(rel); }, 30000);
      }
    }).catch(function () {});
  }
  function hideBubble() {
    R.bubble.classList.remove('nft-vis');
    hideFilmstrip();
  }

  function cleanCue(s) {
    return String(s)
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .trim();
  }
  function cues() {
    try { return (bridge && bridge.subState && bridge.subState.cues) || []; }
    catch (e) { return []; }
  }
  function renderSub(t) {
    if (subSeekHold) return;
    var arr = cues();
    if (arr !== lastSubCues) {
      lastSubCues = arr;
      lastSubKey = ' ';
    }
    if (!arr.length) {
      if (lastSubKey) { subTextEl.textContent = ''; lastSubKey = ''; }
      return;
    }

    var tt = t - subOffset, lo = 0, hi = arr.length - 1, best = -1, idx = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid].start <= tt) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    for (var i = best; i >= 0; i--) {
      if (arr[i].end >= tt) { idx = i; break; }
      if (arr[i].start < tt - 30) break;
    }

    var key = idx < 0 ? '' : idx + ':' + arr[idx].start;
    if (key === lastSubKey) return;
    lastSubKey = key;
    if (idx < 0) { subTextEl.textContent = ''; return; }

    var text = cleanCue(arr[idx].text);
    subTextEl.textContent = text || '';
  }
  function fireUpNext() {
    try { if (bridge && bridge.maybeShowUpNext) bridge.maybeShowUpNext(); } catch (e) {}
  }
  function curDelay() {
    try {
      var cv = bridge && bridge.currentVideo;
      return (cv && cv._manualOffset) || 0;
    } catch (e) { return 0; }
  }
  function nudgeSync(delta) {
    try { if (bridge && bridge.nudgeSubDelay) bridge.nudgeSubDelay(delta); } catch (e) {}
    lastSubKey = ' ';
    updateSyncLabel();
    var delay = curDelay();
    toast('Subtitle delay ' + (delay >= 0 ? '+' : '') + delay.toFixed(1) + 's');
  }
  function updateSyncLabel() {
    var label = R.syncLabel;
    if (!label) return;
    var delay = curDelay();
    var text = 'Sync ' + (delay >= 0 ? '+' : '') + delay.toFixed(1) + 's';
    if (label.textContent !== text) label.textContent = text;
  }

  // A skip mark, once used, must not resurrect the pill just because the
  // post-seek landing spot is still numerically inside the mark's window —
  // the remux engine's out-of-window seek lands on the PRECEDING KEYFRAME
  // (Remux.seekAbsolute reopens the playlist at res.actualStartTime, which
  // can sit a couple of seconds before the requested target), and even an
  // in-window HTML5 seek can snap to the nearest keyframe before it. Either
  // way nowAbs() right after a skip can still read < mark.end, and this
  // function used to treat that as "still in the intro" and show the pill
  // again a beat later. Consumption is tracked per mark KIND on the video
  // object itself (bridge.currentVideo._skipConsumed), not in this module's
  // own state, so it stays correct even if the legacy #p-skip button (app.js)
  // were ever the one drawing the control instead. Re-arms once playback
  // moves back to clearly BEFORE the mark's start, so rewinding into the
  // intro to rewatch it offers the button again.
  var SKIP_REARM_MARGIN = 2;
  function skipConsumedState(cv) {
    return cv._skipConsumed || (cv._skipConsumed = {});
  }
  function computeSkip(t) {
    var cv = bridge && bridge.currentVideo;
    if (!cv || !cv.show || PLAYER.classList.contains('is-live')) return null;
    var consumed = skipConsumedState(cv);
    var recap = cv._recapMark;
    if (recap) {
      if (t < recap.start - SKIP_REARM_MARGIN) consumed.recap = false;
      if (!consumed.recap && t >= Math.max(0, recap.start - 1) && t < recap.end - 1.5) {
        return { kind: 'recap', label: 'Skip Recap', target: recap.end };
      }
    }
    var intro = cv._introMark;
    if (intro) {
      if (t < intro.start - SKIP_REARM_MARGIN) consumed.intro = false;
      if (!consumed.intro && t >= Math.max(0, intro.start - 1) && t < intro.end - 1.5) {
        return { kind: 'intro', label: 'Skip Intro', target: intro.end };
      }
    }
    return null;
  }
  function setPill(el, show, noFocus) {
    if (!el) return;
    var wasVisible = el.classList.contains('nft-vis');
    if (show && !wasVisible) {
      el.classList.add('nft-vis');
      if (!noFocus) setFocus(el);
    } else if (!show && wasVisible) {
      el.classList.remove('nft-vis');
      if (focusEl === el) setFocus(controlsShown ? R.pp : null);
    }
  }
  function isPillFocused() { return focusEl === R.skipPill; }
  function updatePills(d) {
    var cv = bridge && bridge.currentVideo;
    var isEpisode = cv && cv.show && cv.show.season != null && !PLAYER.classList.contains('is-live');
    var upNext = doc.getElementById('p-upnext');
    var upVisible = upNext && !upNext.hidden;
    var nearEnd = isEpisode && d > 0 && d - nowAbs() <= 300;

    var nextDisplay = nearEnd && !upVisible ? '' : 'none';
    if (R.nextB.style.display !== nextDisplay) R.nextB.style.display = nextDisplay;

    var skip = nearEnd || upVisible ? null : computeSkip(nowAbs());
    if (skip) {
      if (R.skipLabel.textContent !== skip.label) R.skipLabel.textContent = skip.label;
      skipTarget = skip.target;
      skipKind = skip.kind;
    } else {
      skipTarget = null;
      skipKind = null;
    }
    setPill(R.skipPill, !!skip);
  }
  function doSkip() {
    if (skipTarget == null) return;
    if (seedrSeekBlocked(skipTarget)) return;
    if (skipKind) {
      var cv = bridge && bridge.currentVideo;
      if (cv) skipConsumedState(cv)[skipKind] = true;
    }
    seekAbs(skipTarget);
    setPill(R.skipPill, false);
    lastSubKey = ' ';
    wake();
  }
  function doNext() {
    if (nextPending) return;
    nextPending = true;
    var requestId = ++nextRequestId;

    function current() { return active && requestId === nextRequestId; }
    function finish() { if (requestId === nextRequestId) nextPending = false; }
    function notFound(message) {
      if (!current()) return;
      finish();
      toast(message || 'No next episode found');
    }

    try {
      var cv = bridge && bridge.currentVideo;
      if (!cv || !cv.show) { finish(); return; }
      toast('Finding next episode…');

      // app.js owns the complete lookup order (Library-local callback,
      // queued, cached, then tracker). The previous overlay-only resolver
      // skipped both local paths and claimed there was no next episode while
      // automatic Up Next could see and play the same cached file.
      if (bridge.findManualNextEpisode) {
        bridge.findManualNextEpisode(cv).then(function (result) {
          if (!current()) return;
          finish();
          if (result && bridge.triggerUpNext) bridge.triggerUpNext(result);
          else toast('No next episode found');
        }).catch(function () { notFound(); });
        return;
      }

      var proceed = function (target) {
        if (!current()) return;
        var next = bridge.findNextEpisodeInQueue && bridge.findNextEpisodeInQueue(cv.show, target);
        if (next && bridge.triggerUpNext) {
          finish();
          bridge.triggerUpNext({ queueItem: next });
          return;
        }
        if (!bridge.findNextEpisodeQueueable) { notFound(); return; }
        bridge.findNextEpisodeQueueable(cv.show, target).then(function (result) {
          if (!current()) return;
          finish();
          if (result && bridge.triggerUpNext) bridge.triggerUpNext(result);
          else toast('No next episode found');
        }).catch(function () { notFound(); });
      };

      if (bridge.resolveNextEpisodeTarget) {
        bridge.resolveNextEpisodeTarget(cv.show).then(function (target) {
          if (!current()) return;
          if (!target) { notFound('No next episode — series finale'); return; }
          proceed(target);
        }).catch(function () { if (current()) proceed(null); });
      } else {
        proceed(null);
      }
    } catch (e) { finish(); }
  }

  function visibleControls() {
    return controls.filter(function (control) {
      return control && control.style.display !== 'none';
    });
  }
  function activePill() {
    return R.skipPill && R.skipPill.classList.contains('nft-vis') ? R.skipPill : null;
  }
  function setFocus(el) {
    if (focusEl === el) return;
    if (focusEl) focusEl.classList.remove('nft-focused');
    R.scrub.classList.remove('nft-focused');
    R.skipPill.classList.remove('nft-focused');
    focusEl = el;
    if (el) el.classList.add('nft-focused');
  }
  function showControls(sticky) {
    if (!controlsShown) {
      nft.classList.add('nft-show');
      PLAYER.classList.add('nft-controls-shown');
      controlsShown = true;
    }
    if (!focusEl) setFocus(R.pp);
    wake();
    resetHide(sticky);
  }
  function hideControls() {
    nft.classList.remove('nft-show');
    PLAYER.classList.remove('nft-controls-shown');
    controlsShown = false;
    setFocus(activePill());
    hideBubble();
    if (seekTarget != null) commitSeek();
  }
  function cancelScrub() {
    clearTimeout(commitTimer);
    commitTimer = 0;
    seekTarget = null;
    if (!seekBusy) seekPending = null;
    resetDpadGesture();
    hideBubble();
    wake();
  }
  function resetHide(sticky) {
    clearTimeout(hideTimer);
    hideTimer = 0;
    if (!sticky && !V.paused && controlsShown) {
      hideTimer = setTimeout(hideControls, AUTO_HIDE);
    }
  }

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('nft-vis');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (toastEl) toastEl.classList.remove('nft-vis');
    }, 1600);
  }

  function onMenuKey(menu, code) {
    if (code === KEY.BACK || code === KEY.BACK2 || code === KEY.ESC || code === 8) {
      if (bridge && bridge.closeMenu) bridge.closeMenu();
      showControls();
      return true;
    }
    if (code !== KEY.UP && code !== KEY.DOWN && code !== KEY.OK) return false;
    // DPad stays disabled while the player owns the remote. Use its focus
    // painter only, and keep navigation inside the current menu's rows.
    var nodes = menu.querySelectorAll('.p-menu-item'), rows = [], index = -1, selected = -1;
    for (var i = 0; i < nodes.length; i++) {
      var row = nodes[i];
      if (row.disabled || row.tabIndex < 0 || row.hidden) continue;
      if (row.classList.contains('is-focused')) index = rows.length;
      if (row.classList.contains('is-active')) selected = rows.length;
      rows.push(row);
    }
    if (!rows.length) return true;
    if (index < 0) index = selected < 0 ? 0 : selected;
    if (code === KEY.UP || code === KEY.DOWN) {
      index = clamp(index + (code === KEY.DOWN ? 1 : -1), 0, rows.length - 1);
    }
    if (bridge && bridge.dpad) bridge.dpad.focus(rows[index]);
    if (code === KEY.OK) rows[index].click();
    return true;
  }

  function onKey(e) {
    if (!active) return;
    var code = e.keyCode, handled = true;
    // A transport key always toggles playback, including over a menu or Up
    // Next. It must never activate the currently highlighted UI control.
    if (code === KEY.PLAYPAUSE) {
      togglePlay();
      showControls();
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      return;
    }
    var menu = doc.getElementById('p-menu');
    if (menu && !menu.hidden) {
      if (onMenuKey(menu, code)) {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      }
      return;
    }

    var up = doc.getElementById('p-upnext');
    if (up && !up.hidden) {
      if (code === KEY.OK || code === KEY.PLAY) {
        var playButton = doc.getElementById('p-upnext-play');
        if (playButton) playButton.click();
        e.preventDefault(); e.stopPropagation();
        return;
      }
      if (code === KEY.BACK || code === KEY.BACK2 || code === KEY.ESC) {
        var cancelButton = doc.getElementById('p-upnext-cancel');
        if (cancelButton) cancelButton.click();
        e.preventDefault(); e.stopPropagation();
        return;
      }
      return;
    }

    if (code === KEY.BACK || code === KEY.BACK2 || code === KEY.ESC) {
      // Back cancels an uncommitted preview first. A second Back exits the
      // player, matching the player's scrub-mode escape behavior.
      if (seekTarget != null) cancelScrub();
      else doClose();
    } else if (code === KEY.OK) {
      if (isPillFocused()) activateFocused();
      else if (!controlsShown) { showControls(); togglePlay(); }
      else activateFocused();
    } else if (code === KEY.LEFT || code === KEY.RIGHT) {
      var direction = code === KEY.RIGHT ? 1 : -1;
      if (isPillFocused()) { showControls(); setFocus(R.pp); }
      else if (!controlsShown) {
        // The old "minimal" path updated a hidden bar, so the first Left/Right
        // press looked dead and auto-committed before any preview appeared.
        // Enter the same visible filmstrip path used by an already-focused
        // timeline from the very first press.
        showControls();
        setFocus(R.scrub);
        seekStep(direction);
      }
      else if (focusEl === R.scrub) seekStep(direction);
      else if (focusEl === R.syncB) nudgeSync(direction * 0.5);
      else moveFocusH(direction);
    } else if (code === KEY.UP) {
      if (isPillFocused()) { showControls(); setFocus(R.scrub); }
      else if (!controlsShown) showControls();
      else if (focusEl !== R.scrub) setFocus(R.scrub);
    } else if (code === KEY.DOWN) {
      if (isPillFocused()) { showControls(); setFocus(R.subsB); }
      else if (!controlsShown) { showControls(); setFocus(R.subsB); }
      else if (focusEl === R.scrub) setFocus(R.pp);
    } else if (code === KEY.PLAY) {
      if (V.paused) togglePlay();
      showControls();
    } else if (code === KEY.PAUSE) {
      if (!V.paused) togglePlay();
      showControls();
    } else if (code === KEY.FF) {
      showControls(); setFocus(R.scrub); seekTarget = null;
      seekStep(1); seekStep(1); seekStep(1);
    } else if (code === KEY.RW) {
      showControls(); setFocus(R.scrub); seekTarget = null;
      seekStep(-1); seekStep(-1); seekStep(-1);
    } else if (code === KEY.STOP) {
      doClose();
    } else {
      handled = false;
    }

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      resetHide();
    }
  }
  function moveFocusH(direction) {
    var visible = visibleControls(), index = visible.indexOf(focusEl);
    if (index < 0) { setFocus(visible[0]); return; }
    setFocus(visible[clamp(index + direction, 0, visible.length - 1)]);
  }
  // OK-press pulse: a quick dip-and-return from the focused scale. Restarted
  // via reflow so rapid presses each get their own pulse (interruptible).
  function press(el) {
    if (!el || !el.classList || el === R.scrub) return;
    el.classList.remove('nft-press');
    void el.offsetWidth;
    el.classList.add('nft-press');
  }
  function activateFocused() {
    press(focusEl);
    if (focusEl === R.scrub) {
      if (seekTarget != null) commitSeek(); else togglePlay();
      return;
    }
    if (focusEl === R.pp) return togglePlay();
    if (focusEl === R.rew) return nudge(-1);
    if (focusEl === R.fwd) return nudge(1);
    if (focusEl === R.subsB) return openAppMenu('subtitles');
    if (focusEl === R.audioB) return openAppMenu('audio');
    if (focusEl === R.speedB) return openAppMenu('speed');
    if (focusEl === R.syncB) return nudgeSync(-curDelay());
    if (focusEl === R.skipPill) return doSkip();
    if (focusEl === R.nextB) return doNext();
  }
  function openAppMenu(kind) {
    try {
      if (bridge && bridge.openMenu) {
        hideBubble();
        bridge.openMenu(kind);
      }
    } catch (e) {}
    if (kind === 'speed') {
      clearTimeout(speedTimer);
      speedTimer = setTimeout(function () {
        if (active) R.spd.textContent = (V.playbackRate || 1) + '×';
      }, 300);
    }
  }
  function doClose() {
    try {
      if (bridge && bridge.closePlayer) {
        bridge.closePlayer();
        return;
      }
    } catch (e) {}
    try {
      V.pause();
      V.removeAttribute('src');
      V.load();
    } catch (e2) {}
  }

  function init() {
    var player = doc.getElementById('player');
    // Permit a later script injection to install after a lazily-created player.
    if (!player) { window.__dumiNftPlayerInstalled = false; return; }
    new MutationObserver(function () {
      var open = player.classList.contains('is-open');
      if (open && !active) activate();
      else if (!open && active) deactivate();
    }).observe(player, { attributes: true, attributeFilter: ['class'] });
    if (player.classList.contains('is-open')) activate();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
