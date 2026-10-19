// js/remux.js — pure-remux (stream-copy) HLS client, TV or laptop engine.
//
// Talks to a remux service's /playback/* API: either the on-TV ffmpeg
// service (com.dumiflix.tv.service, over LS2) or a configured laptop on the LAN
// running the same server. The server runs ffmpeg with "-c:v copy -c:a copy"
// only: this module never asks for and never accepts a transcode. If the
// source's codecs can't be stream-copied into an MPEG-TS HLS container the
// server returns an error, which startSession() surfaces as a rejected
// Promise with `.code === 'unsupported-format'` — it does NOT silently fall
// back to a direct URL. Callers that want a one-time direct play after such
// a failure read Remux.offerDirect() and build the direct URL themselves
// (Seedr.fetchFileUrl / Phone.streamUrl), same as the feature-OFF path.
//
// Supported remux engines are TV and laptop. Optional phone companion
// APIs provide file browsing and downloads separately from remuxing.
//
// Whole feature is OPTIONAL and OFF by default, gated by the persisted
// 'usePhoneRemux' Storage flag (Remux.enabled()/setEnabled()) — the name is
// a historical storage identifier retained for compatibility. It gates
// remuxing via whichever engine (tv/laptop) is configured. A toggle
// only takes effect on the NEXT openPlayer() call — nothing here reacts to
// the flag mid-session.
//
// Only ONE remux session is ever tracked by this module at a time (matches
// the server's "one active session" contract). Starting a new one implicitly
// invalidates any previous in-flight polling via a generation counter, and
// close() always frees the server-side session + local timers.

const Remux = (() => {
  const JSON_HEADERS = { 'Content-Type': 'application/json' };
  // Second-layer production interlock. app.js already rejects every normal
  // remux request at its playback boundary; this keeps Settings or a future
  // caller from re-enabling the engine accidentally. The implementation stays
  // versioned below for explicitly-authorized diagnostics only.
  const PRODUCTION_REMUX_ALLOWED = false;

  // Adaptive poll cadence: segments for a local/burst-read source often clear
  // in well under a second (see remux.py's LOCAL_READRATE_INITIAL_BURST_SECONDS),
  // so a flat 700ms cadence was pure poll-granularity slack on the hot path —
  // up to ~700ms of nothing-but-waiting on top of the real segment-production
  // time. Poll FAST for the first few seconds (when a session is most likely
  // to still be warming up) and back off to the steady cadence after, so a
  // long-running health-independent poll (a slow remote seedr source that
  // hasn't cleared 2 segments yet) doesn't hammer the engine forever.
  const POLL_MS_FAST = 175;         // cadence for the first POLL_FAST_WINDOW_MS
  const POLL_MS = 700;              // steady-state cadence after the fast window
  const POLL_FAST_WINDOW_MS = 4000; // how long to stay on the fast cadence
  const START_TIMEOUT_MS = 25000; // give up if the engine never gets segmentsReady
  const SEEK_TIMEOUT_MS = 20000;  // give up waiting for the post-seek generation
  // MIN_SEGMENTS_READY stays 2, not 1, even for local/cached sources: nothing
  // in this codebase establishes that webOS's native
  // HLS pipeline reliably starts on a playlist that only ever lists a single
  // segment — and the existing tuning below (2s local segment time, full-
  // speed initial burst) already makes 2 segments arrive fast on a local
  // source, so the win from dropping to 1 is small while an unverified single-
  // segment playlist risks a worse failure mode (stuck buffering / a decoder
  // that never gets a stable duration) than the ~1 extra poll tick it costs.
  const MIN_SEGMENTS_READY = 2;   // enough head start to hand off; with -re on the
                                  // engine (segments arrive at ~1x) 2 keeps startup snappy
  const HEALTH_POLL_MS = 5000;    // background /status ticks once playing
  const HEALTH_MISS_LIMIT = 3;    // consecutive failed health polls -> unhealthy
  const BUFFER_SAFETY_S = 1.0;    // don't call a seek "local" right at a buffered edge

  const HTTP_RE = /^https?:\/\//i;

  // ---- persisted on/off toggle -----------------------------------------
  // Read fresh every call (never cached) so Settings can flip it any time;
  // per the brief, only the NEXT openPlayer() picks up the new value —
  // that's enforced by callers reading enabled() once at session-start time,
  // not by anything in here.
  function enabled() {
    return PRODUCTION_REMUX_ALLOWED
      && Storage.get('usePhoneRemux', false) === true;
  }
  function setEnabled(v) {
    Storage.set('usePhoneRemux', PRODUCTION_REMUX_ALLOWED && !!v);
  }

  // ---- engine ('tv' | 'laptop') -------------------------------------------
  // TV engine: an on-TV ffmpeg remux service (com.dumiflix.tv.service) that we
  // launch over LS2 and reach at http://127.0.0.1:<port>. Laptop engine: the
  // same /playback API running on a laptop on the LAN, at a
  // user-configured host + its own password token. Chosen to offload the
  // transcode onto a host with more CPU resources; only serves URL sources
  // it can fetch (seedr/Drive), not phone-local files.
  var _TV_DEFAULT_BASE = 'http://127.0.0.1:9891';
  var _tvBase = null;           // resolved from the LS2 start response
  var _tvStarting = null;       // in-flight ensureTvEngine() promise
  var _engineOverride = null;   // transient single-session engine pick;
                                // set fresh at each startSession(), so it persists for the
                                // life of that session (health polls/seek/DELETE all use it)
                                // and is reset by the next startSession().
  // Only 'tv' and 'laptop' are valid persisted engine identifiers.
  function _validEngine(e) { return (e === 'tv' || e === 'laptop') ? e : null; }
  function _laptopHost() { try { return (Storage.get('remux.laptopHost', '') || '').trim(); } catch (_) { return ''; } }
  function engine() {
    if (_validEngine(_engineOverride)) return _engineOverride;
    // Default = LAPTOP: offload to a configured LAN host. 'tv'
    // is also selectable in Settings, but is never auto-picked as a fallback
    // — an unreachable laptop surfaces as an error instead of silently
    // switching engines.
    return _validEngine(Storage.get('remux.engine', 'laptop')) || 'laptop';
  }
  // Availability of a SPECIFIC engine (without switching the persisted default) --
  // lets callers check reachability before starting a session.
  function availableFor(e) {
    if (e === 'tv') return _lunaSupported();
    if (e === 'laptop') return !!_laptopHost();
    return false;
  }
  function setEngine(e) {
    Storage.set('remux.engine', _validEngine(e) || 'laptop');
    _tvBase = null;             // force a re-resolve on the next TV session
  }
  function laptopHost() { return _laptopHost(); }
  function setLaptopHost(h) { Storage.set('remux.laptopHost', (h || '').trim()); }
  function _lunaSupported() {
    return typeof PalmServiceBridge !== 'undefined';
  }
  function _luna(method, params) {
    return new Promise(function (resolve, reject) {
      try {
        var bridge = new PalmServiceBridge();
        var done = false;
        bridge.onservicecallback = function (msg) {
          if (done) return; done = true;
          try {
            var r = JSON.parse(msg);
            if (r && r.returnValue) resolve(r);
            else reject(_mkErr((r && r.errorText) || 'luna call failed', 'luna'));
          } catch (e) { reject(e); }
        };
        bridge.call('luna://com.dumiflix.tv.service/' + method, JSON.stringify(params || {}));
        setTimeout(function () { if (!done) { done = true; reject(_mkErr('luna timeout', 'luna-timeout')); } }, 10000);
      } catch (e) { reject(e); }
    });
  }
  // Launch (idempotent) the on-TV remux service and cache its base URL.
  function ensureTvEngine() {
    if (_tvBase) return Promise.resolve(_tvBase);
    if (_tvStarting) return _tvStarting;
    if (!_lunaSupported()) {          // not on webOS — fall back to the fixed localhost base
      _tvBase = _TV_DEFAULT_BASE;
      return Promise.resolve(_tvBase);
    }
    _tvStarting = _luna('start', {}).then(function (r) {
      _tvBase = (r && r.base) || _TV_DEFAULT_BASE;
      _tvStarting = null;
      return _tvBase;
    }).catch(function (e) { _tvStarting = null; throw e; });
    return _tvStarting;
  }

  // ---- base URL ----------------------------------------------------------
  function base() {
    var e = engine();
    if (e === 'tv') return _tvBase || _TV_DEFAULT_BASE;
    if (e === 'laptop') {
      var h = _laptopHost();
      if (!h) throw _mkErr('Laptop host not set in Settings', 'laptop-unavailable');
      return (h.indexOf('://') >= 0) ? h : ('http://' + h);
    }
    // Unreachable: engine() only ever returns 'tv' or 'laptop' (_validEngine
    // rejects anything else). Deliberately NOT a fallback to Phone.base() --
    // unsupported engine selections must fail without changing hosts.
    throw _mkErr('No remux engine selected', 'engine-unavailable');
  }
  function available() { return availableFor(engine()); }
  // `Remux.LAPTOP` is retained as a public API value. The host is
  // Storage-backed and can change in
  // Settings, so this is a live getter rather than a snapshot taken at
  // module-load time — reading Remux.LAPTOP always reflects the currently
  // configured engine's base.
  // (Object.defineProperty is ES5; safe on every webOS Chromium.)

  // ---- module-scoped single-session state --------------------------------
  let _gen = 0;                 // bumped on every startSession/close — guards stale async callbacks
  let _sessionId = null;
  let _mode = null;             // 'hls-remux' | 'direct' | null
  let _playbackUrl = null;
  let _originalDuration = 0;
  let _sessionStartTime = 0;    // absolute movie-time the CURRENT generation's playlist starts at
  let _sourceReference = '';    // ORIGINAL source (seedr/Drive https URL, or phone-rel path)
  let _sourceType = '';         // 'seedr' | 'phone' | 'usb' — for the CURRENT session
  let _videoCodec = '', _audioCodec = '', _container = '';
  // fMP4/MSE only. The engine parses this out of init.mp4's real avcC/hvcC
  // bytes, so it may be null on the very first status poll (ffmpeg writes the
  // init segment a beat after the session opens) -- callers must wait for it
  // rather than substituting a guess.
  let _mseMime = null;
  let _outputMode = 'mpegts';
  let _videoEl = null;          // bound <video> element, for buffered-range checks + playlist reload
  let _startSeekHandler = null; // one-shot: pin playback to the window start (not the live edge)
  let _healthy = false;
  let _healthMisses = 0;
  let _onSessionLost = null;    // app callback: server dropped our live session
  let _lostFired = false;       // one shot per session
  let _healthTimer = null;
  let _lastStatus = null;
  let _lastFailure = null;      // {sourceType, sourceReference, startTime, videoTrack, audioTrack, error}
  let _closed = true;

  function _mkErr(msg, code) {
    const e = new Error(msg);
    if (code) e.code = code;
    return e;
  }

  // Never put a signed seedr URL (or any sourceReference) into a thrown
  // error's message / console — only the sessionId and an HTTP status.
  function _redactedSourceTag(sourceType) {
    return '[' + (sourceType || 'source') + ']';
  }

  function _fetchTimeout(url, opts, ms) {
    let ctrl, timer;
    try { ctrl = new AbortController(); timer = setTimeout(() => ctrl.abort(), ms); } catch (_) {}
    return fetch(url, Object.assign({}, opts, { signal: ctrl ? ctrl.signal : undefined }))
      .then(value => { if (timer) clearTimeout(timer); return value; }, error => { if (timer) clearTimeout(timer); throw error; });
  }

  // /playback/start is password-gated on the laptop (SSRF guard). The token
  // is the server's dashboard password, stored on the TV via Storage
  // 'remux.laptopToken' (falling back to the legacy shared 'remux.token' —
  // set in Settings). Segment/playlist fetches use the unguessable session
  // id instead, so they need no token.
  function _token() {
    var e = engine();
    if (e === 'tv') return '';   // localhost-bound service needs no token
    if (e === 'laptop') {
      // /playback/start is password-gated even on the LAN. Its own token,
      // falling back to the shared 'remux.token' if unset.
      try { return Storage.get('remux.laptopToken', '') || Storage.get('remux.token', '') || ''; } catch (_) { return ''; }
    }
    return '';
  }
  function _req(method, path, body, ms) {
    const url = base() + path;
    const headers = Object.assign({}, JSON_HEADERS);
    const tok = _token();
    if (tok) headers['X-Playback-Token'] = tok;
    const opts = { method, headers: headers, cache: 'no-store' };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return _fetchTimeout(url, opts, ms || 12000).then(r =>
      r.text().then(txt => {
        let data = {};
        try { data = txt ? JSON.parse(txt) : {}; } catch (_) {}
        if (!r.ok) {
          const err = _mkErr(
            (data && (data.error || data.message)) || ('remux ' + r.status),
            (data && data.code) || (r.status === 415 || r.status === 422 ? 'unsupported-format'
              : r.status === 404 ? 'no-session' : 'server-error')
          );
          throw err;
        }
        return data;
      })
    );
  }

  // ---- HLS buffered-range check (for the "local seek" fast path) --------
  function _isLocallyBuffered(v, t) {
    if (!v || !v.buffered) return false;
    try {
      for (let i = 0; i < v.buffered.length; i++) {
        if (t >= v.buffered.start(i) + BUFFER_SAFETY_S && t <= v.buffered.end(i) - BUFFER_SAFETY_S) {
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  // A server-side seek replaces every segment behind the SAME playlist URL.
  // Native webOS HLS does not make that replacement synchronous: immediately
  // after load() it can briefly retain the previous generation's currentTime
  // (a stale value or an invalid sentinel clock),
  // then clear the buffer and reset the clock a beat later.  Returning as soon
  // as the SERVER says "ready" lets the caller seek against that transient
  // clock; the subsequent media reset discards the seek, so playback starts at
  // the preceding keyframe while subtitle/seek UI believes the exact target
  // was committed.
  //
  // Arm this BEFORE NativePlayer.load().  It resolves only after the element
  // has observed the reset and the requested relative point is present in the
  // NEW buffered window.  Requiring two consecutive sane samples filters the
  // transient invalid clocks during HLS replacement.
  function _waitForReloadedMedia(v, relativeTarget, gen, deadline) {
    if (!v) return Promise.resolve();
    relativeTarget = Math.max(0, Number(relativeTarget) || 0);
    return new Promise((resolve, reject) => {
      let timer = null, done = false, sawReset = v.readyState < 2, stable = 0;

      function cleanup() {
        if (timer) clearTimeout(timer);
        try { v.removeEventListener('emptied', onReset); } catch (_) {}
        try { v.removeEventListener('loadstart', onReset); } catch (_) {}
      }
      function finish(err) {
        if (done) return;
        done = true;
        cleanup();
        if (err) reject(err); else resolve();
      }
      function onReset() { sawReset = true; stable = 0; }
      function sample() {
        if (done) return;
        if (gen !== _gen) return finish(_mkErr('remux: session superseded', 'superseded'));
        if (Date.now() > deadline) {
          return finish(_mkErr('Timed out waiting for the TV media clock after seek', 'timeout'));
        }

        // load() normally drops readyState synchronously. Keep observing it in
        // addition to loadstart/emptied because this webOS build occasionally
        // suppresses one of those events during a same-URL HLS reload.
        if (v.readyState < 2) sawReset = true;

        let covered = false, clockSane = false;
        const ct = Number(v.currentTime);
        try {
          for (let i = 0; i < v.buffered.length; i++) {
            const start = v.buffered.start(i), end = v.buffered.end(i);
            // The target may be exactly zero. Even then require real buffered
            // media (not webOS's transient [0,0] range) before declaring it
            // usable. A small edge allowance is safe because this is followed
            // by an exact currentTime assignment, not a local-buffer decision.
            if (end > start + 0.05
                && relativeTarget >= start - 0.25
                && relativeTarget <= end - 0.05) covered = true;
            if (Number.isFinite(ct) && ct >= start - 1 && ct <= end + 1) clockSane = true;
          }
        } catch (_) {}

        if (sawReset && v.readyState >= 2 && covered && clockSane) stable++;
        else stable = 0;
        if (stable >= 2) return finish();
        timer = setTimeout(sample, 100);
      }

      v.addEventListener('emptied', onReset);
      v.addEventListener('loadstart', onReset);
      timer = setTimeout(sample, 0);
    });
  }

  // Let the player hand us its <video> element once it knows the src is a
  // remux playlist — used for buffered-range seek checks and to reload the
  // playlist in place after a server-side seek regenerates it at a new
  // keyframe. Passing null unbinds (call this from Remux.close() too).
  function bindVideo(v) {
    // Detach any prior binding's start-seek handler.
    if (_videoEl && _startSeekHandler) {
      try { _videoEl.removeEventListener('loadedmetadata', _startSeekHandler); } catch (_) {}
      try { _videoEl.removeEventListener('canplay', _startSeekHandler); } catch (_) {}
    }
    _videoEl = v || null;
    _startSeekHandler = null;
    if (!v || _mode !== 'hls-remux') return;
    // webOS treats the rolling (omit_endlist) playlist as LIVE and starts at
    // the live edge. For a movie we must start at the BEGINNING of the
    // available window — which the engine anchored to our requested start
    // (sessionStartTime). Correct a live-edge start once the media is ready;
    // the app's own resume-seek (if any) fine-tunes to the exact frame after.
    let done = false;
    _startSeekHandler = function () {
      if (done || !_videoEl) return;
      try {
        if (_videoEl.seekable && _videoEl.seekable.length) {
          const start = _videoEl.seekable.start(0);
          if (_videoEl.currentTime > start + 2) _videoEl.currentTime = start;
          done = true;
        }
      } catch (_) {}
    };
    v.addEventListener('loadedmetadata', _startSeekHandler);
    v.addEventListener('canplay', _startSeekHandler);
    if (v.readyState >= 1) _startSeekHandler();
  }

  // ---- absolute <-> video-relative time mapping --------------------------
  // absoluteMovieTime = sessionStartTime + video.currentTime — the single
  // formula every consumer (progress bar, resume, subtitle cues, skip
  // intro/recap, next-episode, seeks) must use whenever a remux session is
  // active, because a generation can start at a keyframe BEFORE the
  // requested position.
  function absolute(videoCurrentTime) {
    if (_mode !== 'hls-remux') return videoCurrentTime;   // direct mode: no offset
    return _sessionStartTime + (videoCurrentTime || 0);
  }
  function toRelative(absoluteTime) {
    if (_mode !== 'hls-remux') return absoluteTime;
    return Math.max(0, (absoluteTime || 0) - _sessionStartTime);
  }

  // ---- status polling -----------------------------------------------------
  function _statusOnce(sessionId) {
    return _req('GET', '/playback/' + sessionId + '/status');
  }

  function _pollUntilReady(sessionId, gen, deadline, startedAt) {
    // startedAt is only ever passed by our OWN recursive call below — every
    // external caller (startSession, seekAbsolute) omits it, so the first
    // entry of a given warm-up always stamps "now" as the true start.
    if (startedAt == null) startedAt = Date.now();
    if (gen !== _gen) return Promise.reject(_mkErr('remux: session superseded', 'superseded'));
    return _statusOnce(sessionId).then(st => {
      if (gen !== _gen) throw _mkErr('remux: session superseded', 'superseded');
      _lastStatus = st;
      // Only a genuine failure aborts the warm-up. ffmpeg's informational
      // stderr (now under st.stderrTail) — e.g. the benign "-re Resumed
      // reading after a lag" pacing notices on a jittery seedr URL — must
      // NOT kill a healthy stream. The server flags real failures via
      // st.fatal / st.state==='error' (and real launch failures already
      // reject the POST before we ever poll).
      if (st && (st.fatal || st.state === 'error')) {
        const _d = (st.errors && st.errors.length) ? String(st.errors[st.errors.length - 1])
                 : (st.stderrTail && st.stderrTail.length ? String(st.stderrTail[st.stderrTail.length - 1])
                 : 'remux failed');
        throw _mkErr(_d, 'server-error');
      }
      if (st && (st.ready || (st.segmentsReady || 0) >= MIN_SEGMENTS_READY)) return st;
      if (Date.now() > deadline) {
        throw _mkErr('Timed out waiting for the engine to prepare the stream', 'timeout');
      }
      const pollMs = (Date.now() - startedAt) < POLL_FAST_WINDOW_MS ? POLL_MS_FAST : POLL_MS;
      return new Promise(resolve => setTimeout(resolve, pollMs)).then(() =>
        _pollUntilReady(sessionId, gen, deadline, startedAt)
      );
    });
  }

  // ---- background health polling (drives Remux.active()) -----------------
  function _stopHealthPoll() {
    if (_healthTimer) { clearTimeout(_healthTimer); _healthTimer = null; }
  }
  function _startHealthPoll(gen) {
    _stopHealthPoll();
    const tick = () => {
      if (gen !== _gen || _closed) return;
      _statusOnce(_sessionId).then(st => {
        if (gen !== _gen || _closed) return;
        _lastStatus = st;
        _healthMisses = 0;
        _healthy = !(st && (st.fatal || st.state === 'error'));
        _healthTimer = setTimeout(tick, HEALTH_POLL_MS);
      }).catch((err) => {
        if (gen !== _gen || _closed) return;
        // NOTE: we deliberately do NOT tear down the session (_reset) on a 404
        // here. A transient/racey 404 would then flip hasSession() false and
        // snap the seek bar to the rolling window + desync subtitles on a
        // still-good playback. Only an explicit close() ends a session; a
        // genuinely dead one surfaces via the <video> error path instead.
        _healthMisses++;
        if (_healthMisses >= HEALTH_MISS_LIMIT) _healthy = false;
        // Proactive recovery hook: HEALTH_MISS_LIMIT consecutive NO-SESSION
        // replies mean the server genuinely dropped this session (engine
        // restart / single-session takeover) while the <video> may still be
        // playing ZOMBIE content from its buffer. Without this the user
        // watches up to the whole buffer cushion, then falls into the hard
        // error path. Fire ONCE per session; the app rebuilds at the
        // current absolute position (the old mapping stays valid for the
        // buffered content, so the handoff is seamless).
        if (!_lostFired && _healthMisses >= HEALTH_MISS_LIMIT
            && err && err.code === 'no-session' && _onSessionLost) {
          _lostFired = true;
          try { _onSessionLost(); } catch (_) {}
        }
        _healthTimer = setTimeout(tick, HEALTH_POLL_MS);
      });
    };
    _healthTimer = setTimeout(tick, HEALTH_POLL_MS);
  }

  // ---- start a session -----------------------------------------------------
  // opts: {sourceType('seedr'|'phone'|'usb'), sourceReference, startTime,
  //        videoTrack, audioTrack}
  // Resolves {sessionId, playbackUrl, playbackMode, originalDuration,
  //           actualStartTime, videoCodec, audioCodec, container}.
  // ---- MSE / fMP4 opt-in -------------------------------------------------
  // Native playback buffers outside the JavaScript allocation budget.
  // No MSE consumer is included, so ignore the historical useMsePlayer
  // storage flag to avoid requesting fMP4 sessions with no playback consumer.
  function mseEnabled() { return false; }
  function setMseEnabled(_v) { /* no-op: MSE path removed */ }
  // The exact RFC 6381 mime the engine parsed out of the init segment's own
  // avcC/hvcC bytes. MUST be passed to addSourceBuffer() verbatim -- guessing
  // it from a profile NAME is the classic silent NotSupportedError. null means
  // "not ready yet, or don't use MSE", never "substitute something plausible".
  function mseMimeType() { return _mseMime || null; }

  // remux-OFF guard: ask the engine whether a source is too high-bitrate to
  // hand STRAIGHT to the TV. Direct play is the one path with nothing bounding
  // a TIME-based buffer. A ~49s buffer pins (49s x bitrate) of native memory
  // and can trigger a WAM OOM kill at high bitrates. For example, 11 Mbps
  // needs ~67 MB while 6.2 Mbps needs ~38 MB.
  //
  // Deliberately NOT gated on enabled(): the toggle being OFF is precisely when
  // this question needs asking. Read-only on the server (one ffprobe, no
  // session, no ffmpeg), so it can't disturb anything that's already playing.
  //
  // Resolves to null on any failure or unreachable engine -- callers MUST treat
  // null as "carry on with direct play". An unknown bitrate is not evidence of
  // a hot one, and playback must never be blocked by a probe.
  function probeBitrate(sourceType, sourceReference, videoTrack) {
    if (!available()) return Promise.resolve(null);
    return _req('POST', '/playback/probe', {
      sourceType: sourceType,
      sourceReference: sourceReference,
      selectedVideoTrack: videoTrack != null ? videoTrack : undefined,
    }, 15000).catch(() => null);
  }

  // ---- cache-hit fast path (Seedr flow) -----------------------------------
  // Ask the CURRENT engine's host whether it already has a file matching
  // `name` (the release's own filename) sitting in its on-disk cache --
  // GET /cache/resolve?name=<name> -> {rel, size} on a hit, 404 on a miss.
  // Only laptop-class hosts run cache.py with the cache bolt-on enabled;
  // the TV engine simply 404s (or the request errors outright if the
  // host is unset/unreachable) -- either way this resolves null, so callers
  // never need to know which engines actually have a cache. Read-only, no
  // session created, safe to fire in parallel with anything else on the hot
  // path (e.g. Seedr.fetchFileUrl).
  function resolveCache(name) {
    if (!name) return Promise.resolve(null);
    try { base(); } catch (_) { return Promise.resolve(null); }
    return _req('GET', '/cache/resolve?name=' + encodeURIComponent(name), undefined, 4000)
      .catch(() => null);
  }

  // Build a Range-servable stream URL for a resolveCache() hit's `rel`,
  // against the SAME engine base resolveCache() just answered from. Mirrors
  // LaptopCache.streamUrl()'s token-in-query convention (this URL goes straight
  // to <video>/ffmpeg, neither of which can attach a custom header). null
  // when the current engine has no base configured (mirrors resolveCache's
  // silence -- callers must treat null as "not available here").
  function cacheStreamUrl(rel) {
    if (!rel) return null;
    let b;
    try { b = base(); } catch (_) { return null; }
    const segs = String(rel).split('/').filter(Boolean).map(encodeURIComponent);
    return b + '/cache/stream/' + segs.join('/') + '?token=' + encodeURIComponent(_token());
  }

  // ---- season prefetch queue (laptop bolt-on) -------------------------------
  // season.py runs on the same host as cache.py (see the cache-hit fast path
  // above) and owns a PERSISTENT next-episode download queue that survives
  // the TV screen turning off -- unlike the client's own in-memory queue.
  // Both calls resolve null on ANY failure (host absent, route absent, no
  // cache bolt-on on this engine, network error) so callers can always fall
  // back to the client-side queue without special-casing which engine is
  // active.
  function seasonStatus() {
    try { base(); } catch (_) { return Promise.resolve(null); }
    return _req('GET', '/season/status', undefined, 6000).catch(() => null);
  }
  function seasonEnqueue(items, opts) {
    opts = opts || {};
    try { base(); } catch (_) { return Promise.resolve(null); }
    return _req('POST', '/season/queue', { items: items || [], replace: !!opts.replace }, 8000)
      .catch(() => null);
  }

  function startSession(opts) {
    opts = opts || {};
    // Supersede any prior session FIRST, while _engineOverride still reflects
    // the OLD session's engine -- so close()'s DELETE reaches the right host.
    // close() then clears the override (via _reset), and we pick this session's
    // engine below. (A new session invalidates in-flight polls via _gen.)
    close();   // no-op if nothing was open; also clears timers/video binding
    // Transient per-session engine pick (fallback chain). null => use the
    // persisted default. Set AFTER the teardown so it persists for THIS
    // session's lifetime (start, health polls, seek, DELETE).
    _engineOverride = _validEngine(opts.engine) || null;
    if (!available()) {
      const msg = engine() === 'tv'
        ? 'TV remux engine unavailable on this device'
        : 'Laptop not configured — set the laptop host in Settings';
      const e = _mkErr(msg, engine() === 'tv' ? 'tv-unavailable' : 'laptop-unavailable');
      _lastFailure = { opts, error: e };
      _engineOverride = null;
      return Promise.reject(e);
    }
    const gen = ++_gen;
    _closed = false;

    const body = {
      sourceType: opts.sourceType,
      sourceReference: opts.sourceReference,
      remuxEnabled: true,
      // Ask the engine for fragmented MP4 when the MSE path is on. Omitted
      // entirely otherwise, so the server keeps its MPEG-TS default and an
      // engine that predates this field is unaffected.
      outputMode: (mseEnabled() && opts.allowMse !== false) ? 'fmp4' : undefined,
      startTime: opts.startTime || 0,
      selectedVideoTrack: opts.videoTrack != null ? opts.videoTrack : undefined,
      selectedAudioTrack: opts.audioTrack != null ? opts.audioTrack : undefined,
    };

    // TV engine: launch (idempotent) the on-TV remux service and resolve its
    // base URL before the first /playback call. Laptop engine: base is
    // already the configured host, so skip straight to the request.
    const _ensure = engine() === 'tv' ? ensureTvEngine() : Promise.resolve();
    return _ensure.then(() => {
      if (gen !== _gen) throw _mkErr('remux: superseded before start completed', 'superseded');
      return _req('POST', '/playback/start', body, 20000);
    }).then(res => {
      if (gen !== _gen) throw _mkErr('remux: superseded before start completed', 'superseded');
      if (!res || !res.sessionId || !res.playbackUrl) {
        throw _mkErr('Engine returned an incomplete session', 'server-error');
      }
      _sessionId = res.sessionId;
      _mode = res.playbackMode || 'hls-remux';
      // Absolute URL: the server returns a root-relative path (/playback/...),
      // but the app runs from a file:// origin, so a relative <video> src would
      // resolve there instead of the engine's host. Prepend the engine base once.
      _playbackUrl = /^https?:/i.test(res.playbackUrl)
        ? res.playbackUrl : (base() + res.playbackUrl);
      _originalDuration = res.originalDuration || 0;
      // Zero is a valid, authoritative keyframe start. `||` treated it as
      // missing and substituted the requested resume time, shifting every
      // absolute-time consumer (subtitles, resume, seek bar) by that amount.
      _sessionStartTime = (typeof res.actualStartTime === 'number')
        ? res.actualStartTime : (opts.startTime || 0);
      _sourceReference = opts.sourceReference || '';
      _sourceType = opts.sourceType || '';
      _videoCodec = res.videoCodec || '';
      _audioCodec = res.audioCodec || '';
      _container = res.container || '';
      _outputMode = res.outputMode || (body.outputMode || 'mpegts');
      _mseMime = res.mseMimeType || null;   // usually null here; status() fills it in

      if (_mode !== 'hls-remux') {
        // Direct passthrough decided by the server for this source (no HLS
        // polling needed) — resolve as-is. Never reached for a source we
        // asked to remux unless the server treats it as trivially copyable
        // already; this module never itself decides to switch modes.
        _healthy = true;
        return _result(res);
      }

      const deadline = Date.now() + START_TIMEOUT_MS;
      return _pollUntilReady(_sessionId, gen, deadline).then(st => {
        if (gen !== _gen) throw _mkErr('remux: superseded during warm-up', 'superseded');
        // The engine can only parse the codec string once ffmpeg has actually
        // written init.mp4, so it appears on the first READY status rather than
        // on the start response. Capture it here -- the MSE player needs it
        // before it can call addSourceBuffer().
        if (st && st.mseMimeType) _mseMime = st.mseMimeType;
        if (st && st.outputMode) _outputMode = st.outputMode;
        _healthy = true;
        _healthMisses = 0;
        _lostFired = false;      // fresh session → re-arm the lost-session hook
        _startHealthPoll(gen);
        return _result(res);
      });
    }).catch(err => {
      _lastFailure = {
        sourceType: opts.sourceType, sourceReference: opts.sourceReference,
        startTime: opts.startTime, videoTrack: opts.videoTrack, audioTrack: opts.audioTrack,
        error: err,
      };
      // Best-effort teardown of a session the engine half-started (e.g. we
      // timed out waiting for segments, or a later generation superseded
      // this one) — fire-and-forget, never throws into the caller's catch.
      if (gen === _gen && _sessionId) {
        const dyingId = _sessionId;
        _req('DELETE', '/playback/' + dyingId).catch(() => {});
      }
      if (gen === _gen) { _reset(); }
      throw err;
    });
  }

  function _result(res) {
    return {
      sessionId: _sessionId,
      playbackMode: _mode,
      playbackUrl: _playbackUrl,
      originalDuration: _originalDuration,
      actualStartTime: _sessionStartTime,
      // The ORIGINAL source (e.g. the signed seedr https URL). playbackUrl is
      // the localhost/LAN remux route, which off-device helpers like the
      // phone subtitle syncer can't reach — they must decode this instead.
      sourceReference: _sourceReference,
      sourceType: _sourceType,
      videoCodec: _videoCodec,
      audioCodec: _audioCodec,
      container: _container,
    };
  }

  // ---- seek (large seeks, Skip Intro/Recap, resume, audio-track change) --
  // absTarget is ABSOLUTE movie time. Resolves either:
  //   {local:true}                       — caller just sets video.currentTime = toRelative(absTarget)
  //   {local:false, actualStartTime}     — playlist was reloaded onto the bound <video>;
  //                                        caller now seeks from the new keyframe to the exact target:
  //                                        video.currentTime = absTarget - actualStartTime
  function seekAbsolute(absTarget, opts) {
    opts = opts || {};
    if (_closed || !_sessionId) return Promise.reject(_mkErr('no active remux session', 'no-session'));
    if (_mode !== 'hls-remux') {
      // Direct mode: everything is "local" — the caller owns currentTime.
      return Promise.resolve({ local: true });
    }
    const gen = _gen;
    const localTarget = toRelative(absTarget);
    if (!opts.force && _isLocallyBuffered(_videoEl, localTarget)) {
      return Promise.resolve({ local: true });
    }
    return _req('POST', '/playback/' + _sessionId + '/seek', { absoluteTime: absTarget }, SEEK_TIMEOUT_MS)
      .then(res => {
        if (gen !== _gen) throw _mkErr('remux: session superseded', 'superseded');
        if (!res || typeof res.actualStartTime !== 'number') {
          throw _mkErr('Seek failed on the engine', 'server-error');
        }
        _sessionStartTime = res.actualStartTime;
        const relativeTarget = Math.max(0, absTarget - _sessionStartTime);
        const deadline = Date.now() + SEEK_TIMEOUT_MS;
        // Must be armed before load(): otherwise a synchronous emptied/
        // loadstart would be missed and an old buffered range could satisfy
        // the readiness check.
        const mediaReady = _videoEl
          ? _waitForReloadedMedia(_videoEl, relativeTarget, gen, deadline)
          : Promise.resolve();
        // New generation of the playlist at the new keyframe — reload it
        // onto the bound <video> so the decoder restarts clean instead of
        // trying to keep playing a playlist whose segments no longer exist.
        if (_videoEl) {
          // Preserve webOS's mediaOption/HLS transport path. A raw `.src =`
          // here discarded the <source> mediaOption used everywhere else and
          // made a forced decoder recycle behave differently from first play.
          if (typeof NativePlayer !== 'undefined' && NativePlayer.load) {
            NativePlayer.load(_videoEl, _playbackUrl, { startTime: 0 });
          } else {
            _videoEl.src = _playbackUrl;
            _videoEl.load();
          }
        }
        // The engine and the TV element warm independently. Both must be ready:
        // server-only readiness is what let the exact landing seek race (and
        // lose to) webOS's delayed media-clock reset.
        return Promise.all([
          _pollUntilReady(_sessionId, gen, deadline),
          mediaReady,
        ]).then(() => {
          if (gen !== _gen) throw _mkErr('remux: session superseded', 'superseded');
          return {
            local: false,
            actualStartTime: _sessionStartTime,
            relativeTime: relativeTarget,
          };
        });
      });
  }

  // ---- pause/resume (notify the engine so it can idle ffmpeg) -------------
  function pause() {
    if (_closed || !_sessionId) return Promise.resolve();
    return _req('POST', '/playback/' + _sessionId + '/pause').catch(() => {});
  }
  function resume() {
    if (_closed || !_sessionId) return Promise.resolve();
    return _req('POST', '/playback/' + _sessionId + '/resume').catch(() => {});
  }

  // ---- close ---------------------------------------------------------------
  function _reset() {
    _stopHealthPoll();
    _sessionId = null; _mode = null; _playbackUrl = null;
    _originalDuration = 0; _sessionStartTime = 0;
    _videoCodec = ''; _audioCodec = ''; _container = '';
    _healthy = false; _healthMisses = 0; _lastStatus = null;
    _videoEl = null;
    _engineOverride = null;   // a per-session engine pick never outlives its session
    _closed = true;
  }
  function close() {
    _gen++;   // invalidate any in-flight poll/health-tick immediately
    const dyingId = _sessionId;
    // Issue the teardown DELETE BEFORE _reset() clears _engineOverride, so it
    // targets the engine this (dying) session actually ran on -- not whatever
    // the persisted default happens to be.
    if (dyingId) {
      _req('DELETE', '/playback/' + dyingId).catch(() => {});
    }
    _reset();
  }

  // ---- status snapshot (for a debug/HUD readout, not required by the API) -
  function status() {
    return _lastStatus;
  }

  // Subtitle audio-sync ON the currently-selected engine's server (the TV
  // service or the laptop, whichever is active, both expose /subsync).
  // Decodes the ORIGINAL source's audio + cross-correlates against the SRT
  // cues -> {ok, offset, reliable,...}. Runs where the engine already
  // fetches the source (so a laptop session syncs on the laptop, not the
  // phone). Resolves null on any failure (best-effort).
  function subsync(mediaUrl, srt, maxSec) {
    let url;
    try { url = base() + '/subsync'; } catch (_) { return Promise.resolve(null); }
    const headers = Object.assign({}, JSON_HEADERS);
    const tok = _token();
    if (tok) headers['X-Playback-Token'] = tok;
    return _fetchTimeout(url, {
      method: 'POST', headers: headers, cache: 'no-store',
      body: JSON.stringify({ url: mediaUrl, srt: srt || '', max_sec: maxSec || 900 }),
    }, 360000).then(r => (r && r.ok) ? r.json() : null).catch(() => null);
  }

  // Optional, post-first-frame player metadata. The engine combines chapter
  // and stream inspection into one token-authenticated, memoized ffprobe so
  // the TV no longer sends unsupported /media/info + /media/chapters calls to
  // a host that only implements remux/cache APIs.
  function inspectMedia(mediaUrl) {
    if (!mediaUrl) return Promise.resolve(null);
    try { base(); } catch (_) { return Promise.resolve(null); }
    return _req('POST', '/media/inspect', { url: mediaUrl }, 30000)
      .catch(() => null);
  }

  // True while a healthy HLS remux session is live — the player's native
  // memory-recycle guard (_rcEligible in app.js) must skip its destructive
  // v.removeAttribute('src'); v.load() flush while this is true, since that
  // would tear down the decoder mid-stream out from under the engine's
  // rolling window.
  function active() {
    return !_closed && _mode === 'hls-remux' && _healthy;
  }

  // Health-INDEPENDENT session predicate. `active()` folds in `_healthy`,
  // which flips false after a few missed status polls, including when an
  // engine is busy transcoding audio during warm-up. The
  // time-base (sessionStartTime + duration) stays VALID across a health blip:
  // the ffmpeg process and its window are unchanged, a poll just didn't answer
  // in time. UI that maps time (seek bar, subtitle overlay, resume duration,
  // seek routing) must key on "is a remux session governing this playback",
  // NOT on the transient health flag -- otherwise a blip snaps the seek bar to
  // the ~30s rolling window and desyncs subtitles to raw window-relative time.
  function hasSession() {
    return !_closed && _mode === 'hls-remux';
  }

  // On an unsupported-codec / engine-unavailable failure, the UI can offer
  // "play directly instead, just this once" — this hands back the exact
  // source info + error from the last failed startSession() so the caller
  // can build its normal direct URL (Seedr.fetchFileUrl / Phone.streamUrl)
  // without touching the persisted usePhoneRemux setting.
  function offerDirect() {
    return _lastFailure;
  }

  // Scrub-preview thumbnail URL for an ABSOLUTE movie time, or null when the
  // active engine doesn't generate them. Server-side this is gated by
  // DUMIFLIX_THUMBS=1. Enable it only with sufficient CPU and disk-backed
  // temporary storage so previews do not compete with live remuxing.
  // Times are bucketed to 5s so a scrub back and forth re-hits the browser/
  // server cache instead of minting a new JPEG per pixel.
  function thumbUrl(absTime) {
    if (!_sessionId || _mode !== 'hls-remux') return null;
    if (engine() !== 'laptop') return null;
    let b;
    try { b = base(); } catch (_) { return null; }
    const t = Math.max(0, Math.round((absTime || 0) / 5) * 5);
    return b + '/playback/' + _sessionId + '/thumb?t=' + t;
  }

  // ---- seek-bar sprite-sheet storyboard (cache bolt-on, TV engine 404s) ---
  // Manifest for a resolveCache() hit's `rel` — GET /cache/thumbs?rel=<rel> ->
  //   200 {state:'ready', interval, tileWidth, tileHeight, cols, rows, count,
  //        duration, sheets:[...]}
  //   202 {state:'generating'}
  //   404 -> caught below
  // Frame k lives in sheet floor(k/(cols*rows)), cell k%(cols*rows), row-major,
  // and covers [k*interval, (k+1)*interval) of absolute movie time. Same
  // silent-null-on-any-failure contract as resolveCache() — host absent,
  // route absent, network error, or a 404/202 with a broken body all resolve
  // null so a caller can always treat "no manifest" as "no previews here"
  // without special-casing why. A 202 body (still generating) IS handed back
  // as-is so the caller can decide whether/when to retry — only genuine
  // failures collapse to null.
  function thumbsManifest(rel) {
    if (!rel) return Promise.resolve(null);
    try { base(); } catch (_) { return Promise.resolve(null); }
    return _req('GET', '/cache/thumbs?rel=' + encodeURIComponent(rel), undefined, 6000)
      .catch(() => null);
  }
  // Turn one manifest `sheets[i]` entry (already engine-base-relative, e.g.
  // "/cache/thumbs/sheet?rel=...&i=0") into a loadable URL for an <img> or a
  // CSS background-image — appends the auth token the same way
  // cacheStreamUrl() does, since neither of those requests can carry a custom
  // header. null when the current engine has no base configured (mirrors
  // cacheStreamUrl's silence).
  function thumbsSheetUrl(path) {
    if (!path) return null;
    let b;
    try { b = base(); } catch (_) { return null; }
    const sep = path.indexOf('?') >= 0 ? '&' : '?';
    return b + path + sep + 'token=' + encodeURIComponent(_token());
  }

  const api = {
    enabled, setEnabled, available, availableFor, base, probeBitrate,
    resolveCache, cacheStreamUrl, seasonStatus, seasonEnqueue,
    thumbsManifest, thumbsSheetUrl,
    mseEnabled, setMseEnabled, mseMimeType, outputMode: () => _outputMode,
    // Raw session id — the MSE player builds its own segment URLs, and the
    // sid in the path IS the capability for the media routes.
    sessionId: () => _sessionId,
    engine, setEngine, ensureTvEngine, laptopHost, setLaptopHost,
    startSession, seekAbsolute, pause, resume, close,
    bindVideo, absolute, toRelative, status, active, hasSession, subsync, inspectMedia, offerDirect,
    thumbUrl,
    // Register the app's proactive recovery for a server-side session drop
    // (engine restart / takeover under a still-playing <video>).
    onSessionLost: function (cb) { _onSessionLost = cb; },
  };
  Object.defineProperty(api, 'LAPTOP', {
    get: function () { try { return base(); } catch (_) { return ''; } },
  });
  Object.defineProperty(api, 'sessionStartTime', {
    get: function () { return _sessionStartTime; },
  });
  // True full-movie runtime (seconds). v.duration on the <video> is only the
  // rolling HLS window in remux mode, so the HUD must read the total from here.
  Object.defineProperty(api, 'duration', {
    get: function () { return _originalDuration; },
  });
  return api;
})();
