/* native-player.js — native video playback for webOS TVs.
 *
 * Native video decoding and JavaScript allocations use separate memory pools.
 * Constrained TV runtimes can impose small JavaScript and external-allocation
 * budgets, making large fetch buffers and MSE SourceBuffers expensive.
 * Hand media URLs to the native pipeline for bounded buffering outside JS.
 * Codec, resolution, HDR, and audio passthrough support vary by firmware;
 * check the target device's capabilities before selecting tracks.
 */
window.NativePlayer = (function () {
  'use strict';

  // Advertise the supported 4K output size explicitly; window.screen may
  // report CSS pixels, and pipeline defaults can otherwise limit resolution.
  var MAX_W = 3840;
  var MAX_H = 2160;

  // The <source> `type` attribute is a GATE, not a description.
  //
  // The element runs canPlayType() on it and DROPS any <source> that scores "".
  // Some TVs return canPlayType('video/x-matroska') === "" — advertising an
  // MKV's real MIME makes the element discard the source before the native
  // pipeline ever sees it. 'video/mp4' scores "maybe", passes the gate, and
  // the native demuxer then sniffs the ACTUAL container off the bytes.
  //
  // Use the gate MIME for MKV sources too; the native demuxer detects
  // the actual container from the media bytes.
  var GATE_MIME = 'video/mp4';

  function isHls(url) { return /\.m3u8(\?|$)/i.test(String(url || '')); }

  /* Build the mediaOption blob.
   *
   * mediaOption travels ONLY on a <source> element's `type` attribute.
   * Setting v.src directly bypasses these source-level pipeline options.
   *
   * mediaTransportType 'URI' = play this file directly, with the pipeline's own
   * bounded buffering and full-file duration for the seek bar.
   */
  function buildOption(url, opts) {
    opts = opts || {};
    var mo = {
      mediaTransportType: isHls(url) ? 'HLS' : 'URI',
      option: {
        adaptiveStreaming: { maxWidth: MAX_W, maxHeight: MAX_H },
      },
    };

    // Native resume. playTime.start is in MILLISECONDS and asks the pipeline to
    // BEGIN at that offset — the decoder opens clean at a keyframe there.
    //
    // This replaces load-then-seek, which is what made resume flaky: a cold
    // `currentTime =` into an unbuffered mid-GOP offset makes webOS throw
    // decode error 3, worst on MKV. Starting there instead of seeking there
    // sidesteps the whole failure mode.
    var start = Math.max(0, Number(opts.startTime) || 0);
    if (start > 1) {
      mo.option.transmission = { playTime: { start: Math.round(start * 1000) } };
    }
    return mo;
  }

  /* Point the <video> at `url` through the native pipeline.
   * Returns the mediaOption actually used (handy for logging/asserts).
   */
  function load(v, url, opts) {
    opts = opts || {};
    // Drop any previous <source> children first: v.load() would otherwise
    // reconsider a stale one and we would race our own last playback.
    try { v.querySelectorAll('source').forEach(function (s) { s.remove(); }); } catch (_) {}

    var mo = buildOption(url, opts);
    try {
      var s = document.createElement('source');
      s.setAttribute('src', url);
      s.setAttribute('type', GATE_MIME + ';mediaOption=' + escape(JSON.stringify(mo)));
      // src attribute and <source> children are mutually exclusive: whichever
      // is set on the element itself WINS and the children are ignored. So the
      // attribute must be removed, not just left stale.
      v.removeAttribute('src');
      v.appendChild(s);
      v.load();
      _lastUrl = url;          // the watchdog needs this to reload after a dump
      return mo;
    } catch (_) {
      // Absolute last resort. Loses 4K (pipeline defaults to 1080p) but plays.
      try { v.src = url; v.load(); } catch (__) {}
      return null;
    }
  }

  /* Release the native decoder + its buffers.
   *
   * With --max-activated-media-players=1, a <video> still holding a
   * decoded stream blocks the NEXT playback from getting one. Clearing src and
   * calling load() is what actually hands the pipeline's memory back; simply
   * pausing does not.
   */
  function release(v) {
    _lastUrl = null;
    if (!v) return;
    try { v.pause(); } catch (_) {}
    try { v.querySelectorAll('source').forEach(function (s) { s.remove(); }); } catch (_) {}
    try { v.removeAttribute('src'); v.load(); } catch (_) {}
  }

  /* Does this need a server-side audio remux to be audible?
   * True when the ONLY audio is something the pipeline cannot decode.
   */
  function audioNeedsHelp(codec) {
    return /truehd|dts/i.test(String(codec || ''));
  }

  /* ---- memory watchdog -------------------------------------------------
   *
   * WHAT TO WATCH, and why it is not the JS heap.
   *
   * Native decode memory lives outside the JavaScript heap, so JS heap
   * metrics alone cannot detect excessive native media buffering. Approximate
   * pinned bytes as buffered seconds times bitrate. Low-bitrate sources can
   * safely buffer longer, so require both a high buffer level and sustained
   * growth across consecutive samples before releasing and reloading at the
   * current position. This avoids repeatedly interrupting stable playback.
   */
  var DANGER_BUFFER_SECONDS = 60;   // conservative buffer-duration threshold
  var RISING_MARGIN = 2;            // seconds of growth to count as "rising"
  var CONSECUTIVE_BAD = 3;          // ~15s of sustained growth before acting
  var CHECK_MS = 5000;
  var HEAP_DANGER_RATIO = 0.9;      // secondary: our own heap near its limit

  var _lastUrl = null;              // for reloading after a dump
  var _timer = 0;
  var _bad = 0;
  var _dumps = 0;
  var _prevAhead = 0;

  function bufferAhead(v) {
    try {
      if (!v.buffered || !v.buffered.length) return 0;
      return v.buffered.end(v.buffered.length - 1) - v.currentTime;
    } catch (_) { return 0; }
  }

  function heapRatio() {
    try {
      var m = performance.memory;
      if (!m || !m.jsHeapSizeLimit) return 0;
      return m.usedJSHeapSize / m.jsHeapSizeLimit;
    } catch (_) { return 0; }
  }

  /* Release and immediately reload at the current position. */
  function dump(v, why) {
    if (!v || !_lastUrl) return false;
    // app.js owns the remux-aware recycle path: it forces a fresh server HLS
    // generation at ABSOLUTE movie time before rebuilding the native decoder.
    // Use it for direct playback too when available so timed and watchdog
    // relief share one verified recovery implementation.
    try {
      if (typeof window.__dumiRecycleMedia === 'function'
          && window.__dumiRecycleMedia(why)) return true;
    } catch (_) {}
    var at = 0, wasPaused = true, wasMuted = false;
    try { at = v.currentTime || 0; wasPaused = v.paused; wasMuted = v.muted; } catch (_) {}
    _dumps++;
    try { window.__bbEvent && window.__bbEvent('mem:dump', { why: why, at: Math.round(at) }); } catch (_) {}
    var url = _lastUrl;
    release(v);
    // Reopen AT the same offset via playTime.start, so this costs one black
    // second rather than a reload-then-seek (which is what decode-errors on
    // a cold mid-GOP offset).
    load(v, url, { startTime: at });
    try { v.muted = wasMuted; } catch (_) {}
    if (!wasPaused) { try { var p = v.play(); if (p && p.catch) p.catch(function () {}); } catch (_) {} }
    return true;
  }

  function startWatchdog(v) {
    stopWatchdog();
    _bad = 0;
    _timer = setInterval(function () {
      try {
        if (!v || v.paused || v.ended || !_lastUrl) { _bad = 0; _prevAhead = 0; return; }
        var ahead = bufferAhead(v);
        var rising = ahead > (_prevAhead + RISING_MARGIN);
        _prevAhead = ahead;
        // Both conditions, deliberately: a big-but-steady buffer is healthy
        // (it is draining as fast as it fills), and a rising buffer at a
        // normal level is just the pipeline topping up after a seek.
        var runaway = (ahead > DANGER_BUFFER_SECONDS) && rising;
        var heapBad = heapRatio() > HEAP_DANGER_RATIO;
        if (!runaway && !heapBad) { _bad = 0; return; }
        _bad++;
        if (_bad >= CONSECUTIVE_BAD) {
          _bad = 0;
          dump(v, runaway ? 'buffer:' + Math.round(ahead) + 's' : 'heap');
        }
      } catch (_) { _bad = 0; }
    }, CHECK_MS);
  }

  function stopWatchdog() {
    if (_timer) { clearInterval(_timer); _timer = 0; }
    _bad = 0;
  }

  function stats(v) {
    return { bufferAhead: +bufferAhead(v).toFixed(1), heapRatio: +heapRatio().toFixed(3),
             dumps: _dumps, watching: !!_timer, url: !!_lastUrl };
  }

  return {
    load: load,
    release: release,
    buildOption: buildOption,
    audioNeedsHelp: audioNeedsHelp,
    isHls: isHls,
    startWatchdog: startWatchdog,
    stopWatchdog: stopWatchdog,
    dump: dump,
    stats: stats,
    maxWidth: MAX_W,
    maxHeight: MAX_H,
  };
})();
