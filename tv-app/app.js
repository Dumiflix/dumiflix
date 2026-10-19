// app.js — DumiFlix main controller
//
// Pure frontend: searches YTS/apibay, hands magnets to seedr, polls progress,
// uploads finished torrents to Google Drive via the native service, then
// streams from Drive (proxied through the service for bearer auth).

// Kill any in-flight playback from a prior session. webOS preserves the
// <video> element's network state across app relaunches (the WebView
// isn't always destroyed when the user backgrounds the app), so a
// relaunch can retain an old media source. Clear the DOM video element.
// Exposed on window so the App IIFE can call it again on visibilitychange.
window._dumiKillStalePlayback = function () {
  try {
    const v = document.getElementById('video');
    if (v) {
      try { v.pause(); } catch (_) {}
      try { v.removeAttribute('src'); } catch (_) {}
      try { [...v.querySelectorAll('source')].forEach((s) => s.remove()); } catch (_) {}
      try { v.load(); } catch (_) {}
    }
  } catch (_) {}
};
// Run immediately at script load — before the App IIFE.
window._dumiKillStalePlayback();
// Also run when the app becomes visible (foreground from background).
// After the App IIFE runs, _dumiForegrounded is set to call closePlayer()
// when a video is active (keeps JS state consistent), or fall through to
// _dumiKillStalePlayback for the DOM-only cleanup otherwise.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    (window._dumiForegrounded || window._dumiKillStalePlayback)();
  }
});

// ---------------------------------------------------------------------------
// Black box — a persistent, always-on flight recorder.
//
// Why it lives in the app (not injected over CDP): when the webOS WebView
// renderer is killed mid-playback (OOM / media-decoder death during a long
// 1080p session) the JS context dies INSTANTLY — no 'error' event fires and
// no minidump is written, so the only forensic trail is whatever was already
// flushed to localStorage. A CDP-injected recorder also dies with the page
// and is wiped by every reinstall; baking it into the app makes it survive
// crash, relaunch, and version updates.
//
// It rings the last ~220 events to localStorage['dumiflix.blackbox']. On the
// next boot, if the previous session's ring didn't end with a clean 'bye'
// marker, that session crashed: the whole ring is archived to
// 'dumiflix.blackbox.prev' for post-mortem, and a 'boot' record notes it.
// Heartbeats (~5s) carry JS-heap MB + buffered-ahead seconds — the memory /
// buffer trajectory that precedes an OOM. window.__bbdump() returns a compact
// summary (heap first/last, max buffer, event tally, last events) for both
// the current and the previous (crashed) session.
// ---------------------------------------------------------------------------
(function blackbox() {
  const KEY = 'dumiflix.blackbox', PREV = 'dumiflix.blackbox.prev', MAX = 220;
  let ring = [];
  // ---- laptop shipper ------------------------------------------------------
  // The localStorage ring is bounded and may rotate before diagnostics are
  // collected. Mirror events to a bounded outbox, drained to the configured
  // laptop POST /log endpoint once a minute and on error-class events.
  // The server keeps durable daily logs even if the TV session crashes.
  // LaptopCache is resolved lazily at SHIP time (it isn't even parsed yet when
  // this runs), the outbox is bounded, and every path swallows: the
  // forensics recorder must never be able to take the app down with it.
  const __bbBootId = Date.now().toString(36);
  const __bbOutbox = [];
  const __bbShipNowTags = { 'v:error': 1, 'js:error': 1, 'js:reject': 1,
                            'mem:dump': 1, 'park': 1, 'boot': 1 };
  let __bbShipBusy = false;
  async function __bbShip() {
    if (__bbShipBusy || !__bbOutbox.length) return;
    __bbShipBusy = true;
    try {
      if (typeof LaptopCache === 'undefined' || !LaptopCache.shipLog || !LaptopCache.available()) return;
      const batch = __bbOutbox.slice(0, 400);
      const ok = await LaptopCache.shipLog({ src: 'tv', boot: __bbBootId, events: batch });
      if (ok) __bbOutbox.splice(0, batch.length);
    } catch (_) {}
    finally { __bbShipBusy = false; }
  }
  function __bbQueue(entry, tag) {
    try {
      __bbOutbox.push(entry);
      if (__bbOutbox.length > 600) __bbOutbox.splice(0, __bbOutbox.length - 600);
      if (__bbShipNowTags[tag]) setTimeout(__bbShip, 1200);
    } catch (_) {}
  }
  setInterval(__bbShip, 60000);
  // Pinned records survive ring eviction: 'boot' (always) + the first 3
  // 'v:error'/'js:error'/'js:reject' records of the session (post-mortem
  // gold once a long-running heartbeat stream would otherwise FIFO-evict
  // them before anyone pulls the black box).
  const PIN_ERROR_TAGS = { 'v:error': 1, 'js:error': 1, 'js:reject': 1 };
  const PIN_ERROR_MAX = 3;
  const pinned = [];
  let pinnedErrorCount = 0;
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(ring)); } catch (_) {} };
  const rec = (tag, data) => {
    try {
      const entry = [Date.now(), tag, data || null];
      ring.push(entry);
      __bbQueue(entry, tag);   // also into the laptop-bound outbox
      if (tag === 'boot' || (PIN_ERROR_TAGS[tag] && pinnedErrorCount < PIN_ERROR_MAX)) {
        pinned.push(entry);
        if (PIN_ERROR_TAGS[tag]) pinnedErrorCount++;
      }
      if (ring.length > MAX) {
        // Evict the OLDEST NON-pinned record, not a blind splice(0, N) --
        // that used to drop 'boot'/early error records the moment a session
        // ran long enough to wrap the ring, right when post-mortem needs
        // them most.
        for (let i = 0; i < ring.length && ring.length > MAX; i++) {
          if (pinned.indexOf(ring[i]) === -1) { ring.splice(i, 1); i--; }
        }
      }
    } catch (_) {}
  };
  // Best-effort app version for the boot record (async; blank on first tick).
  try { fetch('appinfo.json').then((r) => r.json()).then((j) => { window.__APP_VERSION = j.version; }).catch(() => {}); } catch (_) {}

  // Post-mortem: was the previous session a crash (no clean 'bye')?
  let crashed = false, prevLast = null;
  try {
    const prevRaw = localStorage.getItem(KEY);
    if (prevRaw) {
      const prev = JSON.parse(prevRaw);
      if (Array.isArray(prev) && prev.length) {
        const last = prev[prev.length - 1];
        crashed = !(last && last[1] === 'bye');
        prevLast = last;
        localStorage.setItem(PREV, prevRaw);   // archive for inspection
      }
    }
  } catch (_) {}
  // Expose the crash verdict so boot() can auto-resume the interrupted movie.
  try { window.__bbCrashedOnBoot = crashed; } catch (_) {}
  ring = [];
  rec('boot', { ver: window.__APP_VERSION || '', crashed, prevLast });
  persist();

  // ~5s heartbeat: currentTime, readyState, buffered-ahead sec, heap MB, playing,
  // rx (remux-engine session active) -- so a future OOM is attributable to
  // engine mode (TV/laptop remux vs direct-play) straight from the heartbeat.
  setInterval(() => {
    try {
      const v = document.getElementById('video');
      const d = { t: 0, rs: 0, buf: 0, js: 0, pl: 0, rx: 0 };
      if (v) {
        d.t = v.currentTime | 0; d.rs = v.readyState; d.pl = v.paused ? 0 : 1;
        if (v.buffered && v.buffered.length) {
          d.buf = (v.buffered.end(v.buffered.length - 1) - v.currentTime) | 0;
        }
      }
      if (performance.memory) d.js = (performance.memory.usedJSHeapSize / 1048576) | 0;
      try { d.rx = (typeof Remux !== 'undefined' && Remux.hasSession && Remux.hasSession()) ? 1 : 0; } catch (_) {}
      rec('hb', d); persist();
    } catch (_) {}
  }, 5000);

  // Video lifecycle via capture-phase document listeners — non-bubbling media
  // events still traverse the capture phase, so one set catches whichever
  // <video> is live. 'error' carries the MediaError code and is flushed at once.
  ['error', 'stalled', 'waiting', 'seeking', 'seeked', 'ended', 'abort',
   'emptied', 'loadeddata', 'durationchange', 'play', 'pause', 'playing'].forEach((ev) => {
    document.addEventListener(ev, (e) => {
      const v = e && e.target;
      if (!v || v.tagName !== 'VIDEO') return;
      const d = { t: v.currentTime | 0 };
      if (ev === 'error' && v.error) { d.code = v.error.code; d.msg = (v.error.message || '').slice(0, 120); }
      rec('v:' + ev, d);
      if (ev === 'error') persist();
    }, true);
  });

  window.addEventListener('error', (e) => {
    rec('js:error', { m: (e && e.message || '').slice(0, 160), f: (e && e.filename || '').split('/').pop(), ln: e && e.lineno });
    persist();
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    const d = { m: String(r || '').slice(0, 160) };
    if (r && r.stack) d.st = String(r.stack).slice(0, 200);
    rec('js:reject', d); persist();
  });

  // Clean-shutdown markers so a normal background/close isn't read as a crash.
  const bye = (why) => { rec('bye', { why }); persist(); };
  window.addEventListener('pagehide', () => bye('pagehide'));
  window.addEventListener('beforeunload', () => bye('beforeunload'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') bye('hidden');
  });

  // App milestones (e.g. gesture commands) interleave into the trail via this.
  window.__bbEvent = rec;

  // Post-mortem shipment: the previous session crashed — send its whole
  // archived ring to the laptop right away (src 'tv-crash', trivially
  // separable), so the crash trail is durable before anyone asks questions.
  if (crashed) {
    try {
      const prevRing = JSON.parse(localStorage.getItem(PREV) || '[]');
      if (Array.isArray(prevRing) && prevRing.length) {
        setTimeout(() => {
          try {
            if (typeof LaptopCache !== 'undefined' && LaptopCache.shipLog && LaptopCache.available()) {
              LaptopCache.shipLog({ src: 'tv-crash', boot: __bbBootId, events: prevRing.slice(-220) });
            }
          } catch (_) {}
        }, 8000);   // after boot settles — LaptopCache config needs Storage up
      }
    } catch (_) {}
  }
  window.__bbdump = function () {
    let prev = null;
    try { prev = JSON.parse(localStorage.getItem(PREV) || 'null'); } catch (_) {}
    const summ = (a) => {
      if (!Array.isArray(a) || !a.length) return null;
      const t0 = a[0][0], tally = {};
      a.forEach((e) => { tally[e[1]] = (tally[e[1]] || 0) + 1; });
      const hbs = a.filter((e) => e[1] === 'hb');
      return {
        n: a.length, spanSec: ((a[a.length - 1][0] - t0) / 1000) | 0, tally,
        firstHeap: hbs[0] && hbs[0][2].js, lastHeap: hbs.length && hbs[hbs.length - 1][2].js,
        maxBuf: hbs.reduce((m, e) => Math.max(m, e[2].buf || 0), 0),
        last8: a.slice(-8).map((e) => [((e[0] - t0) / 1000).toFixed(0) + 's', e[1], e[2]]),
      };
    };
    return { crashedOnBoot: crashed, current: summ(ring), prev: summ(prev) };
  };
})();

// ---------------------------------------------------------------------------
// Startup compatibility migration for legacy remote-engine configuration.
// 'vps' is a historical name for the remote cache backend; preserve stored
// keys and VPSCACHE:: file IDs so existing installations remain compatible.
// Existing installations may retain hosts, tokens, cache snapshots, engine
// selections and Continue-Watching source tags under the legacy names.
// Copy those values forward before anything else reads Storage so updates
// preserve configuration and playback history.
//
// WHY HERE: this runs as a plain top-level IIFE, textually and temporally
// BEFORE `const App = (() => {...})()` below — i.e. during the single
// synchronous pass that evaluates this script, before DOMContentLoaded ever
// fires boot() and before any timer/event callback (including the blackbox
// IIFE's own heartbeat/ship timers above, which reference LaptopCache) can
// run. Storage itself is already available at this point (js/storage.js is
// first in index.html's <script> list, well before app.js), so this is the
// earliest possible place in the app's own code to do it, and it is
// guaranteed to precede every engine/host read anywhere (this file,
// js/remux.js, js/laptopcache.js).
//
// What migrates (old key -> new key; value copied ONLY when the new key is
// still absent, so a value already saved under the new name always wins —
// safe/idempotent to run on every boot). Old keys are left in place
// afterward (harmless dead weight, not read by anything post-migration):
//   remux.vpsHost      -> remux.laptopHost     (the laptop's host/IP)
//   remux.vpsToken     -> remux.laptopToken    (the laptop's playback token)
//   vpscache.snapshot  -> laptopcache.snapshot (laptopcache.js's on-disk
//                                               cache-listing fallback)
//
// Plus two in-place VALUE fixes (same key, new value — not a rename):
//   remux.engine === 'vps' OR 'phone'  -> rewritten to 'laptop'  (the
//     persisted engine selection; both old identities collapse onto the
//     single remaining laptop-or-tv choice)
//   any 'cw:*' Continue-Watching entry with .source === 'vps' -> rewritten
//     to 'laptop' (the per-file backend tag app.js persists alongside a
//     resume position; the fileId itself still carries the unchanged
//     VPSCACHE:: prefix — see js/laptopcache.js — so playback routing
//     already works unaffected by this; the tag fix just keeps every other
//     comparison of that field consistent post-rename). A 'source' of
//     'phone' is DELIBERATELY left untouched here — it is a different,
//     still-valid meaning (an actual file living on the phone's own
//     storage), not an engine selection.
(function _migrateVpsStorageToLaptop() {
  try {
    if (typeof Storage === 'undefined') return;
    const cfg = Storage.load();
    let changed = false;
    const moveKey = (oldKey, newKey) => {
      if (cfg[newKey] === undefined && cfg[oldKey] !== undefined) {
        cfg[newKey] = cfg[oldKey];
        changed = true;
      }
    };
    moveKey('remux.vpsHost', 'remux.laptopHost');
    moveKey('remux.vpsToken', 'remux.laptopToken');
    moveKey('vpscache.snapshot', 'laptopcache.snapshot');
    if (cfg['remux.engine'] === 'vps' || cfg['remux.engine'] === 'phone') {
      cfg['remux.engine'] = 'laptop';
      changed = true;
    }
    Object.keys(cfg).forEach((k) => {
      if (k.indexOf('cw:') !== 0) return;
      const v = cfg[k];
      if (v && v.source === 'vps') { v.source = 'laptop'; changed = true; }
    });
    if (changed) Storage.save(cfg);
  } catch (_) { /* migration must never be able to block boot */ }
})();

const App = (() => {
  let activeWatchers = {};   // id -> stop fn
  let queue = [];            // { id, name, infoHash, pct, speed, total, folderId? }
  let currentTab = 'home';
  let currentVideo = null;   // { fileId, title, path }
  let _openReqSeq = 0;       // bumped on every openPlayer; lets async play paths (filesOpen) drop a superseded result

  // Trending cache (apibay top100). 15-minute in-session TTL — apibay
  // regenerates the precompiled JSON periodically through the day, so a
  // short cache keeps the row from making people wait. The `day` field
  // is the calendar date (UTC YYYY-MM-DD) the cache was filled on; if
  // the user leaves the app open across midnight the next renderHome
  // will see the day mismatch and refetch.
  let trendingCache = { data: null, at: 0, cat: 'all', day: '' };
  function _todayKey() { return new Date().toISOString().slice(0, 10); }
  // Movies tab state.
  let moviesState = { sort: 'trending', genre: '', minRating: 0, query: '', page: 1 };
  let moviesTotal = 0;
  let moviesInited = false;
  let moviesSearchTimer = null;
  const moviesBrowseCache = new Map();

  // Hard cap on the size of any torrent we'll queue. Picked to fit comfortably
  // inside the seedr free-tier ceiling — anything bigger gets dropped at the
  // surface so the user never even sees a row they can't actually download.
  const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;

  // ---------- helpers ----------
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return [...document.querySelectorAll(sel)]; }
  function fmtSize(n) {
    if (!n) return '0 B';
    const u = ['B','KB','MB','GB','TB'];
    let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
  }
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) return '0:00';
    s = Math.floor(s);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    if (h) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
    return `${m}:${ss}`;
  }
  function toast(msg, ms = 2400) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('is-shown');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('is-shown'), ms);
  }
  function pill(msg) { $('#status-pill').textContent = msg || ''; }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ---------- pre-stream loading overlay ----------
  // Shown the moment the user picks something (instead of dumping them on the
  // Queue tab): a spinner + title + download progress, until the player opens.
  let _loadingFor = null;     // queue item id this overlay is tracking
  let _loadingBack = false;   // is our Back handler on the DPad stack?
  let _remuxLoadPoll = null;
  let _loadingWatchdog = 0;
  function showLoading(title, poster, itemId, statusText) {
    const el = $('#dumi-loading'); if (!el) return;
    _loadingFor = itemId || null;
    $('#dumi-load-title').textContent = title || '';
    $('#dumi-load-status').textContent = statusText || 'Getting it ready…';
    $('#dumi-load-fill').style.width = '0%';
    const bg = $('#dumi-load-bg');
    if (bg) bg.style.backgroundImage = poster ? `url("${poster}")` : 'none';
    el.hidden = false;
    if (!_loadingBack) { try { DPad.pushBackHandler(cancelLoading); _loadingBack = true; } catch (_) {} }
    // Safety net for the RESUME/remux path (no download to track): if a play
    // path ever errors without hiding, don't strand the user on the overlay.
    // 40s comfortably exceeds the worst remux warm-up (~25s) + the seedr retry.
    clearTimeout(_loadingWatchdog); _loadingWatchdog = 0;
    if (!itemId) {
      _loadingWatchdog = setTimeout(() => {
        const p = $('#player');
        if (!$('#dumi-loading').hidden && !(currentVideo && p && p.classList.contains('is-open'))) hideLoading();
      }, 40000);
    }
  }
  // Drive the loading overlay from the remux warm-up (there's no download, so
  // loadingTick's queue-progress path doesn't apply). Polls the session status
  // and advances the bar as segments become ready, so a ~10-20s phone-remux
  // spin-up shows real progress + a spinner instead of a blank screen.
  function startRemuxLoadProgress() {
    stopRemuxLoadProgress();
    const statusEl = $('#dumi-load-status'), fillEl = $('#dumi-load-fill');
    _remuxLoadPoll = setInterval(() => {
      try {
        if ($('#dumi-loading').hidden) { stopRemuxLoadProgress(); return; }
        const st = (typeof Remux !== 'undefined') ? Remux.status() : null;
        const segs = (st && st.segmentsReady) || 0;
        const ready = !!(st && st.ready);
        if (statusEl) statusEl.textContent = ready ? 'Starting playback…' : 'Preparing stream…';
        // Ease toward "ready": a handful of segments = warm; cap at 90% until
        // the player actually takes over (openPlayer -> hideLoading -> 100%).
        if (fillEl) fillEl.style.width = (ready ? 95 : Math.min(90, 15 + segs * 25)) + '%';
      } catch (_) {}
    }, 500);
  }
  function stopRemuxLoadProgress() {
    if (_remuxLoadPoll) { clearInterval(_remuxLoadPoll); _remuxLoadPoll = null; }
  }
  function loadingTick(item) {
    if (!item || _loadingFor !== item.id) return;
    if (item.error || item.phase === 'error') {
      hideLoading();
      toast(`Couldn't start: ${item.error || item.name}`);
      return;
    }
    if (item.phase === 'seedring') {
      const pct = Math.round(item.pct || 0);
      // Seedr often has the file already: "Downloading… 0%" then reads as stuck.
      $('#dumi-load-status').textContent = item.queued ? 'Queued on seedr…'
        : pct > 0 ? `Downloading… ${pct}%` : 'Getting it ready…';
      $('#dumi-load-fill').style.width = `${Math.max(2, Math.min(100, pct))}%`;
    } else if (item.phase === 'copying' && item._torrentFallback) {
      const pct = Math.max(0, Math.min(100, item.pct || 0));
      $('#dumi-load-status').textContent = `Downloading to laptop… ${pct.toFixed(0)}%`;
      $('#dumi-load-fill').style.width = `${Math.max(2, pct)}%`;
    } else if (item.phase === 'copying' || item.phase === 'seedred') {
      // The background copy starts while the player is opening from Seedr; the
      // loading card is about starting playback, the Queue tab shows the copy.
      $('#dumi-load-status').textContent = 'Starting…';
      $('#dumi-load-fill').style.width = '100%';
    }
  }
  function hideLoading() {
    const el = $('#dumi-loading'); if (!el || el.hidden) return;
    stopRemuxLoadProgress();
    clearTimeout(_loadingWatchdog); _loadingWatchdog = 0;
    el.hidden = true;
    _loadingFor = null;
    if (_loadingBack) { try { DPad.popBackHandler(); } catch (_) {} _loadingBack = false; }
  }
  // Set by downloadToServerAndPlay (a direct laptop torrent, no queue item):
  // Back on the overlay must cancel THAT job, which _loadingFor can't track.
  let _loadingCancelHook = null;
  function cancelLoading() {
    _openReqSeq++;   // invalidate every pending opener, including queue-linked loads
    // Back during loading. A downloading PICK (_loadingFor set) is aborted so it
    // stops eating seedr; a RESUME/remux warm-up (no _loadingFor) just backs out
    // — tear down any in-flight remux session, but NEVER wipe the queue.
    const wasDownload = !!_loadingFor;
    if (_loadingCancelHook) {
      const hook = _loadingCancelHook;
      _loadingCancelHook = null;
      hideLoading();
      try { hook(); } catch (_) {}
      toast('Cancelled');
      return;
    }
    hideLoading();
    if (wasDownload) {
      wipeQueueAndSeedr(null, true).catch(() => {});
      toast('Cancelled');
    } else {
      try { if (typeof Remux !== 'undefined') Remux.close(); } catch (_) {}
    }
  }

  // ---------- Subtitles ----------
  // Pick the best English sibling subtitle for a video. Torrents follow
  // common conventions: same basename as the video, optional language tag
  // (`.en.srt`, `.eng.srt`), and sometimes flavor tags (`.forced.`, `.sdh.`).
  function pickEnglishSubtitle(videoName, subs) {
    if (!subs || !subs.length) return null;
    const stem = videoName.replace(/\.[^.]+$/, '').toLowerCase();
    // Regexes hoisted out of the per-item scoring loop below — compiled once
    // per pickEnglishSubtitle() call instead of being rebuilt (and, under the
    // old score(a)/score(b) comparator, rebuilt AGAIN on every comparison)
    // for every candidate subtitle in the folder.
    const RE_LANG_WORD = /\b(en|eng|english)\b/;
    const RE_LANG_DOT = /\.(en|eng)\./;
    const RE_FORCED = /\bforced\b/;
    const RE_SDH = /\bsdh\b|\bcc\b|hearing[-_ ]?impaired/;
    const RE_SRT = /\.srt$/i;
    const RE_VTT = /\.vtt$/i;
    // Score each candidate exactly once (decorate-sort-undecorate) instead of
    // letting Array#sort's comparator recompute it on every comparison — the
    // original's `score(b) - score(a)` redid all of the regex work for the
    // same subtitle repeatedly across an O(n log n) sort.
    const scored = new Array(subs.length);
    for (let i = 0; i < subs.length; i++) {
      const s = subs[i];
      const n = s.name.toLowerCase();
      let pts = 0;
      // Same-stem siblings always beat unrelated subs in the folder.
      if (n.startsWith(stem)) pts += 100;
      // Language hints — `.en.`, `.eng.`, `_en.`, `english`.
      if (RE_LANG_WORD.test(n)) pts += 50;
      else if (RE_LANG_DOT.test(n)) pts += 50;
      // Avoid forced/SDH tracks unless nothing else is available.
      if (RE_FORCED.test(n)) pts -= 30;
      if (RE_SDH.test(n)) pts -= 10;
      // Prefer SRT/VTT over ASS/SSA — ASS styling won't survive our
      // VTT conversion and looks worse than plain text.
      if (RE_SRT.test(s.name)) pts += 5;
      if (RE_VTT.test(s.name)) pts += 6;
      // Tie-breaker: shorter names usually mean main subtitle.
      pts -= n.length * 0.01;
      scored[i] = { s, pts };
    }
    scored.sort((a, b) => b.pts - a.pts);
    return scored[0].s || null;
  }

  // SRT → WebVTT. Browsers can attach VTT but not SRT directly.
  // Convert HH:MM:SS,mmm timestamps to HH:MM:SS.mmm and prepend the WEBVTT header.
  function srtToVtt(srt) {
    const body = srt
      .replace(/\r+/g, '')
      .replace(/^﻿/, '')
      // Strip SRT cue-index lines (a bare integer immediately before a
      // `00:00:00,000 --> ...` timestamp). VTT treats those bare numbers as
      // cue identifiers, which corrupts multi-line cues.
      .replace(/(^|\n)\d+\n(?=\d\d:\d\d:\d\d[,.]\d\d\d\s*-->)/g, '$1')
      .replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2');
    return 'WEBVTT\n\n' + body;
  }

  // Resolve subtitles for a video about to play. First tries the sibling
  // .srt/.vtt files that came with the torrent (best — they're guaranteed
  // Pre-flight subtitle resolver — sibling files ONLY. The OpenSubs lookup
  // used to live here, but it fired BEFORE the video even loaded — robbing
  // embedded English subs of their chance. OpenSubs is now a strict
  // post-load fallback (`fetchOpenSubsFallback`) that only kicks in if
  // the video has no embedded English text tracks after a brief wait.
  async function resolveSubtitleWithFallback(filename, siblings, show) {
    return pickEnglishSubtitle(filename || '', siblings || []) || null;
  }

  // Build OpenSubtitles search params from whatever context we have
  // (explicit show + filename + inferred S/E). Used by the post-load
  // fallback when the file shipped no embedded English subs.
  function buildOpenSubsQuery(filename, show) {
    const inferred = inferShowFromTitle(filename || '');
    let imdbId = null, query = '', season = null, episode = null, year = null;
    if (show && show.title) {
      query = show.title;
      imdbId = show.imdbId || null;
      season = show.season || null;
      episode = show.episode || null;
      year = show.year || null;
    } else if (inferred && inferred.title) {
      query = inferred.title;
      season = inferred.season || null;
      episode = inferred.episode || null;
    } else {
      query = (filename || '').split(' — ').pop().replace(/\.[^.]+$/, '');
      query = Trending.cleanTitle(query) || query;
      const yMatch = (filename || '').match(/\b(19[5-9]\d|20[0-3]\d)\b/);
      if (yMatch) year = yMatch[1];
    }
    // Release names commonly leave a separator behind when SxxExx is
    // removed (for example, "Example Show (2024) -"). Sending that
    // literal string to OpenSubtitles can yield zero episode matches even
    // though the clean series title has plenty.  Keep the year as structured
    // metadata and normalize the text query before any IMDb resolution or
    // provider lookup.
    if (query) {
      const queryYear = query.match(/\b(19[5-9]\d|20[0-3]\d)\b/);
      if (!year && queryYear) year = queryYear[1];
      query = query
        .replace(/\s*\((?:19[5-9]\d|20[0-3]\d)\)\s*/g, ' ')
        .replace(/\s*[-\u2013\u2014]\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
    if (!imdbId && !query) return null;
    return { imdbId, query, season, episode, year, filename };
  }

  async function fetchOpenSubsFallback(filename, show) {
    if (!OpenSubs.hasApiKey()) return null;
    const params = buildOpenSubsQuery(filename, show);
    if (!params) return null;
    // Anchor the search to an IMDb id whenever we can resolve one — a fuzzy
    // text query is how the finder ends up on the wrong film/show entirely.
    // Movies resolve via TMDB search; TV shows via TVMaze (both cached).
    if (!params.imdbId && params.query) {
      try {
        if (params.season) {
          const sm = await TVMaze.seasonMap(params.query, params.year);
          params.imdbId = (sm && sm.show && sm.show.imdb_id) || null;
        } else if (typeof TMDB !== 'undefined') {
          params.imdbId = await TMDB.imdbIdForTitle(params.query, params.year, 'movie');
        }
      } catch (_) {}
    }
    pill('Looking up subtitle…');
    try {
      const got = await OpenSubs.findFor(params);
      pill('');
      if (!got || !got.text) return null;
      return { name: got.name || 'opensubs.srt', _content: got.text };
    } catch (_) {
      pill('');
      return null;
    }
  }

  // The proper finder + auto-sync. Returns a subFile { name, _content,
  // _autoOffset, _scale } or null.
  //   TIER 1: exact match by the file's moviehash → frame-accurate, no sync.
  //   TIER 2: best metadata match, auto-synced to a hash-locked reference sub
  //           (any language) via cue cross-correlation.
  // `streamUrl` is the playing media URL (for the moviehash).
  async function resolveBestSubtitle(streamUrl, filename, show, opts = {}) {
    if (!OpenSubs.hasApiKey()) return null;
    let hashInfo = null;
    if (streamUrl && /^https?:/i.test(streamUrl)) {
      try { hashInfo = await OpenSubs.movieHashFromUrl(streamUrl, opts); } catch (_) {}
    }
    // TIER 1 — exact English subtitle for this exact file.
    if (hashInfo) {
      const exact = await OpenSubs.findExactByHash(hashInfo, 'en', { ...opts, filename }).catch(() => null);
      if (exact && exact.text) {
        pill('Exact subtitle ✓');
        setTimeout(() => { if ($('#status-pill').textContent === 'Exact subtitle ✓') pill(''); }, 5000);
        return { name: exact.name, _content: exact.text, _autoOffset: 0, _scale: 1, _exact: true };
      }
    }
    // TIER 2 — best metadata match.
    const got = await fetchOpenSubsFallback(filename, show);
    if (!got || !got._content) return got || null;
    got._autoOffset = 0; got._scale = 1;
    // Auto-sync to a hash-locked reference (its timing is correct for this file).
    if (hashInfo) {
      const ref = await OpenSubs.findReferenceByHash(hashInfo, { ...opts, filename }).catch(() => null);
      if (ref && ref.text) {
        try {
          const a = alignCuesToReference(parseSrtCues(got._content), parseSrtCues(ref.text));
          if (a && a.confidence >= 0.55 && (Math.abs(a.offset) > 0.3 || (a.scale && a.scale !== 1))) {
            got._autoOffset = a.offset;
            got._scale = a.scale;
            got._syncedBy = 'reference';
            got._syncConfidence = Math.round(a.confidence * 100) / 100;
            const syncMsg = `Auto-synced ${a.offset >= 0 ? '+' : ''}${a.offset.toFixed(1)}s`;
            pill(syncMsg);
            setTimeout(() => { if ($('#status-pill').textContent === syncMsg) pill(''); }, 5000);
          }
        } catch (_) {}
      }
    }
    return got;
  }

  // Returns true if the <video> exposes at least one English embedded text
  // track right now. Used to decide whether to skip OpenSubs entirely.
  function hasEmbeddedEnglishSub(video) {
    const tracks = video && video.textTracks;
    if (!tracks || !tracks.length) return false;
    // Only count IN-BAND tracks (embedded in MKV / MP4) — external <track>
    // elements we appended ourselves are tracked separately.
    const externalSet = new Set(
      [...video.querySelectorAll('track')].map(el => el.track).filter(Boolean)
    );
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (externalSet.has(t)) continue;
      if (t.kind !== 'subtitles' && t.kind !== 'captions') continue;
      const lang = (t.language || '').toLowerCase();
      const label = (t.label || '').toLowerCase();
      if (lang === 'en' || lang === 'eng' || lang.startsWith('en-') ||
          (!lang && /english/.test(label))) return true;
    }
    return false;
  }

  // Wait up to `timeoutMs` for an English embedded text track to appear
  // (in-band tracks often arrive after the first few hundred ms of MKV
  // demuxing). Resolves true on first detection, false on timeout.
  function waitForEmbeddedEnglishSub(video, timeoutMs = 2500) {
    return new Promise((resolve) => {
      if (hasEmbeddedEnglishSub(video)) return resolve(true);
      const tt = video.textTracks;
      if (!tt) return resolve(false);
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        try { tt.removeEventListener('addtrack', onAdd); } catch (_) {}
        clearTimeout(timer);
        resolve(ok);
      };
      const onAdd = () => { if (hasEmbeddedEnglishSub(video)) finish(true); };
      try { tt.addEventListener('addtrack', onAdd); } catch (_) {}
      const timer = setTimeout(() => finish(hasEmbeddedEnglishSub(video)), timeoutMs);
    });
  }

  async function attachSubtitle(video, subFile) {
    if (!subFile) return;
    try {
      const text = subFile._content || await storeFor(subFile.fileId).fetchText(subFile.fileId);
      const isAss = /\.(ass|ssa)$/i.test(subFile.name);
      // ASS/SSA aren't supported by <track> at all and we don't have an
      // ASS renderer — skip cleanly so the video plays without subs.
      if (isAss) return;
      // We bypass <track> entirely on webOS: native cue tracking doesn't
      // populate activeCues during HEVC HW-decoded playback. Parse the
      // SRT/VTT ourselves and render via a DOM overlay on `timeupdate`.
      let cues = parseSrtCues(text);
      // Per-subtitle auto-sync: framerate scale + offset measured against a
      // synced reference (set by the finder). Applied before the global cal.
      const scale = subFile._scale || 1;
      if (scale && scale !== 1) cues = cues.map(c => ({ start: c.start * scale, end: c.end * scale, text: c.text }));
      const auto = subFile._autoOffset || 0;
      // A manual Sync nudge belongs to the SUBTITLE it was made for. Switching
      // to a different sub (menu pick, the file's own embedded track swapping
      // in, an OpenSubs re-pick) must start that sub with a clean offset —
      // otherwise a −6.5s fix for a mistimed external release drags the file's
      // own correctly-timed embedded sub 6.5s out of sync. Only carry the nudge
      // when re-attaching the SAME sub (e.g. auto-sync refining its own offset).
      if (currentVideo) {
        const sameSub = currentVideo._subKey && currentVideo._subKey === subFile.name;
        if (!sameSub) currentVideo._manualOffset = 0;
        currentVideo._subKey = subFile.name || '';
      }
      // subDelaySec() = clamped per-TV A/V calibration (≈0). _manualOffset =
      // this playback's manual nudge. auto = the sub's own measured offset.
      const manual = (currentVideo && currentVideo._manualOffset) || 0;
      cues = shiftCueArray(cues, subDelaySec() + auto + manual);
      if (cues.length) setSubCues(video, cues);
    } catch (e) {
      console.warn('subtitle attach failed', e);
    }
  }

  // Poll the laptop's per-(media,sub) sync state machine (GET
  // /cache/subs/state) until it settles or this playback moves on. `fp`
  // pins one manifest entry; the rollup (fp omitted) is never watched here —
  // callers always pass the fp of the entry they're tracking. Calls
  // onUpdate(st) whenever state OR version changed since the last tick —
  // covers both a syncing→ready landing and an embedded_pending's in-place
  // lazy-verify retime (same fp, version bumped). Never throws (subsState()
  // itself never rejects); stops silently — leaving whatever is currently
  // shown as-is — once currentVideo has moved on, subs were turned off,
  // the entry reaches 'ready'/'failed', or a 15-minute soft timeout elapses (a
  // genuinely wedged laptop shouldn't spin this forever). Returns
  // { stop() } for an explicit early cancel, though callers don't need it —
  // the stale-player check above makes every future tick a no-op anyway.
  function pollLaptopSubState(fileId, fp, onUpdate, opts = {}) {
    const intervalMs = opts.intervalMs || 2500;
    // ffsubsync may legitimately use its full 300s allowance and then enter a
    // fallback pass. Keep watching long enough for that state machine to land.
    const timeoutMs = opts.timeoutMs || 15 * 60 * 1000;
    const playback = opts.playback || currentVideo;
    const isAlive = opts.isAlive || (() => currentVideo === playback && !playback._subHidden);
    const t0 = Date.now();
    let lastKey = '', timer = null, stopped = false;
    const alive = () => !stopped && currentVideo && isAlive();
    const tick = async () => {
      if (!alive() || (Date.now() - t0) > timeoutMs) return;
      const st = await LaptopCache.subsState(fileId, fp);
      if (!alive()) return;
      const key = st.state + '::' + (st.version || 0);
      if (key !== lastKey) {
        lastKey = key;
        try { onUpdate(st); } catch (_) {}
      }
      if (!alive() || st.state === 'ready' || st.state === 'failed') return;   // settled — stop polling
      timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, intervalMs);
    return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
  }

  // Score a TextTrack — higher is better. English embedded > English external
  // > nothing. Non-English never auto-shows ("always default to English").
  function scoreTrack(t, isExternal) {
    if (t.kind !== 'subtitles' && t.kind !== 'captions') return -Infinity;
    const lang = (t.language || '').toLowerCase();
    const label = (t.label || '').toLowerCase();
    const isEnglish =
      lang === 'en' || lang === 'eng' || lang.startsWith('en-')
      || (!lang && /english/.test(label))
      || (!lang && isExternal);  // our external <track> always carries en subs
    if (!isEnglish) return -Infinity;
    let pts = 100;
    // Embedded English wins over external English at equal flavor — embedded
    // tracks are usually higher quality (correct timing, no OCR artefacts).
    if (!isExternal) pts += 5;
    if (/forced/.test(label)) pts -= 30;
    if (/sdh|hearing[-_ ]?impaired|\bcc\b/.test(label)) pts -= 10;
    return pts;
  }

  // Pick the best English track and route its cues to our DOM overlay.
  // webOS HEVC plays in a hardware compositor layer beneath the WebView;
  // UA-rendered cues from `mode: 'showing'` paint onto the <video> element
  // which is just a transparent hole, so they never appear on screen. We
  // use `mode: 'hidden'` instead — cues still fire `cuechange`, and our
  // `#p-subs` div displays the active cue text as a normal DOM element
  // that the WebView composites OVER the video layer.
  function chooseBestTrack(video) {
    const tracks = video.textTracks;
    if (!tracks || tracks.length === 0) return;
    const externalSet = new Set(
      [...video.querySelectorAll('track')].map(el => el.track).filter(Boolean)
    );
    let bestIdx = -1, bestPts = -Infinity;
    for (let i = 0; i < tracks.length; i++) {
      const pts = scoreTrack(tracks[i], externalSet.has(tracks[i]));
      if (pts > bestPts) { bestPts = pts; bestIdx = i; }
    }
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const winner = (i === bestIdx && bestPts >= 0);
      // 'showing' is required on webOS — `hidden` doesn't populate
      // activeCues or fire cuechange there. The CSS hides the UA painter
      // so subs only appear via our own #p-subs DOM overlay.
      t.mode = winner ? 'showing' : 'disabled';
    }
    if (bestIdx >= 0) {
      wireSubOverlay(video, tracks[bestIdx]);
      // On webOS, embedded track cues are populated asynchronously after
      // mode is set to 'showing'. If wireSubOverlay found no cues, register
      // a one-shot cuechange listener to retry once cues arrive.
      if (!_subTimeupdateHandler) {
        const tr = tracks[bestIdx];
        const handler = function() {
          tr.removeEventListener('cuechange', handler);
          wireSubOverlay(video, tr);
        };
        tr.addEventListener('cuechange', handler);
      }
    } else {
      // Only tear down an overlay this selector itself installed — the
      // external-SRT overlay (setSubCues) must survive a no-winner rescan
      // after a mid-play source reload (session recovery, engine swap).
      if (_subState.fromTrack) clearSubOverlay();
    }
  }

  // Strip leftover SRT/VTT inline tags ({\an8}, <i>, ASS-style) so the
  // DOM overlay renders clean text instead of escaping HTML/looking weird.
  function cleanCueText(s) {
    return (s || '')
      .replace(/\{\\[^}]+\}/g, '')                                 // ASS overrides like {\an8}
      .replace(/<\/?[a-z][^>]*>/gi, '')                            // <i>, <b>, etc.
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }

  // Parse SRT (or VTT body) into a sorted array of {start, end, text}.
  // Used because webOS Chromium doesn't populate `track.activeCues` during
  // HEVC playback — we evaluate active cues ourselves on `timeupdate`.
  function parseSrtCues(srt) {
    if (!srt) return [];
    const body = srt
      .replace(/^﻿/, '')
      .replace(/^WEBVTT[^\n]*\n+/i, '')
      .replace(/\r+/g, '');
    const blocks = body.split(/\n{2,}/);
    const cues = [];
    const tsRe = /(\d\d):(\d\d):(\d\d)[,.](\d\d\d)\s*-->\s*(\d\d):(\d\d):(\d\d)[,.](\d\d\d)/;
    for (const block of blocks) {
      const lines = block.split('\n');
      let tsLine = null, tsIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (tsRe.test(lines[i])) { tsLine = lines[i]; tsIdx = i; break; }
      }
      if (!tsLine) continue;
      const m = tsLine.match(tsRe);
      const start = (+m[1])*3600 + (+m[2])*60 + (+m[3]) + (+m[4])/1000;
      const end   = (+m[5])*3600 + (+m[6])*60 + (+m[7]) + (+m[8])/1000;
      const text = lines.slice(tsIdx + 1).join('\n').trim();
      if (text) cues.push({ start, end, text });
    }
    cues.sort((a, b) => a.start - b.start);
    return cues;
  }

  // ---------- subtitle auto-sync (align cues to a synced reference) ----------
  // We build a binary "voice-activity" signal from each subtitle's cue
  // intervals and cross-correlate the candidate against a reference whose
  // timing is known-good for this exact file (a moviehash-matched sub in any
  // language, or an embedded track). The lag that maximises overlap is the
  // offset; we also test a few film/PAL framerate ratios to catch drift. This
  // is the same principle as ffsubsync's reference mode, done on cue timings so
  // it needs no audio decoding (unavailable through the webOS hardware audio path).
  function _cueActivity(cues, rate, n) {
    const a = new Uint8Array(n);
    for (let k = 0, len = cues.length; k < len; k++) {
      const c = cues[k];
      let s = Math.floor(c.start * rate); if (s < 0) s = 0;
      let e = Math.ceil(c.end * rate);   if (e > n) e = n;
      for (let i = s; i < e; i++) a[i] = 1;
    }
    return a;
  }
  // Score the overlap of `tgt` shifted by `lag` bins against `ref`.
  function _overlapAt(tgt, ref, lag) {
    const n = tgt.length;
    let score = 0;
    let i = Math.max(0, -lag);
    const end = Math.min(n, n - lag);
    for (; i < end; i++) if (tgt[i] && ref[i + lag]) score++;
    return score;
  }
  // Align target cues to reference cues. Returns {scale, offset, confidence}.
  // offset/scale map a target time t → t*scale + offset.
  function alignCuesToReference(targetCues, refCues, opts = {}) {
    if (!targetCues || !targetCues.length || !refCues || !refCues.length) {
      return { scale: 1, offset: 0, confidence: 0 };
    }
    const rate = opts.rate || 4;               // 250 ms bins
    const maxLag = opts.maxLagSec || 120;      // search ±2 min
    const dur = Math.max(
      targetCues[targetCues.length - 1].end,
      refCues[refCues.length - 1].end
    ) + maxLag + 5;
    const n = Math.min(opts.maxBins || 200000, Math.ceil(dur * rate));
    const ref = _cueActivity(refCues, rate, n);
    let refTotal = 0;
    for (let i = 0; i < n; i++) refTotal += ref[i];
    if (!refTotal) refTotal = 1;
    const SCALES = [1, 23.976 / 25, 25 / 23.976, 23.976 / 24, 24 / 23.976, 25 / 24, 24 / 25];
    const lagBins = Math.round(maxLag * rate);
    let best = { scale: 1, offset: 0, score: 0 };
    for (let si = 0; si < SCALES.length; si++) {
      const scale = SCALES[si];
      let scaled = targetCues;
      if (scale !== 1) {
        const tlen = targetCues.length;
        scaled = new Array(tlen);
        for (let i = 0; i < tlen; i++) {
          const c = targetCues[i];
          scaled[i] = { start: c.start * scale, end: c.end * scale };
        }
      }
      const tgt = _cueActivity(scaled, rate, n);
      let tgtTotal = 0;
      for (let i = 0; i < n; i++) tgtTotal += tgt[i];
      if (!tgtTotal) tgtTotal = 1;
      for (let lag = -lagBins; lag <= lagBins; lag++) {
        const sc = _overlapAt(tgt, ref, lag);
        if (sc > best.score) best = { scale, offset: lag / rate, score: sc, tgtTotal };
      }
    }
    // Fine pass: re-search ±2 s around the coarse offset at 4× resolution
    // (fixed scale) so the offset lands within ~0.06 s instead of one bin.
    if (best.score > 0) {
      const fr = rate * 4;
      const fn = Math.min((opts.maxBins || 200000) * 4, Math.ceil(dur * fr));
      const refF = _cueActivity(refCues, fr, fn);
      let scaledF = targetCues;
      if (best.scale !== 1) {
        const tlen = targetCues.length;
        scaledF = new Array(tlen);
        for (let i = 0; i < tlen; i++) {
          const c = targetCues[i];
          scaledF[i] = { start: c.start * best.scale, end: c.end * best.scale };
        }
      }
      const tgtF = _cueActivity(scaledF, fr, fn);
      const center = Math.round(best.offset * fr);
      const span = Math.round(2 * fr);
      let fb = { offset: best.offset, score: -1 };
      for (let lag = center - span; lag <= center + span; lag++) {
        const sc = _overlapAt(tgtF, refF, lag);
        if (sc > fb.score) fb = { offset: lag / fr, score: sc };
      }
      best.offset = fb.offset;
    }
    // Confidence: peak overlap relative to the smaller signal's mass.
    const denom = Math.min(refTotal, best.tgtTotal || refTotal);
    const confidence = denom ? best.score / denom : 0;
    return { scale: best.scale, offset: best.offset, confidence };
  }

  let _subState = { cues: [], lastIdx: -1, lastShown: '' };
  let _subTimeupdateHandler = null;
  let _subVideo = null;
  let _subTicker = null;
  function clearSubOverlay() {
    const el = $('#p-subs');
    if (el) { el.classList.remove('is-shown'); el.textContent = ''; }
    if (_subVideo && _subTimeupdateHandler) {
      try { _subVideo.removeEventListener('timeupdate', _subTimeupdateHandler); } catch (_) {}
      try { _subVideo.removeEventListener('seeking', _subTimeupdateHandler); } catch (_) {}
    }
    if (_subTicker) { clearInterval(_subTicker); _subTicker = null; }
    _subState = { cues: [], lastIdx: -1, lastShown: '' };
    _subTimeupdateHandler = null; _subVideo = null;
  }
  // GLOBAL subtitle calibration (seconds), persisted per-TV via the manual Sync
  // control. This is now ONLY for a residual constant A/V offset on this
  // specific TV — per-subtitle mismatch is handled automatically by the
  // exact-match finder + auto-sync (which make every sub content-accurate), so
  // the default is 0 (no blanket shift). Negative shows cues earlier. The
  // per-subtitle auto offset is applied ON TOP of this at attach time.
  function subDelaySec() {
    try {
      const v = localStorage.getItem('nftSubOffset');
      let n = v != null ? (parseFloat(v) || 0) : 0;
      // Reject global offsets outside ±3s to prevent stale per-subtitle
      // adjustments from affecting every title. Manual nudges belong to the
      // current playback (currentVideo._manualOffset), not global calibration.
      if (!(n >= -3 && n <= 3)) n = 0;
      return n;
    } catch (_) { return 0; }
  }
  function shiftCueArray(cues, d) {
    return (cues || []).map(c => ({ start: Math.max(0, c.start + d), end: Math.max(0, c.end + d), text: c.text }));
  }
  // Shift a native TextTrack's VTTCue times in place (idempotent per cue) so
  // the UA painter — the subtitles the user actually sees — is compensated.
  function shiftTrackCues(track, d) {
    if (!track || !track.cues || !d) return;
    for (let i = 0; i < track.cues.length; i++) {
      const c = track.cues[i];
      if (c._dumiShifted) continue;
      try { c.startTime = Math.max(0, c.startTime + d); c.endTime = Math.max(0, c.endTime + d); c._dumiShifted = true; } catch (_) {}
    }
  }
  // Live re-shift (native track + JS overlay) by `delta`, then persist the new
  // cumulative delay. Driven by the TV player's Sync control.
  function nudgeSubDelay(delta) {
    // Per-PLAYBACK nudge — lives on currentVideo and resets with each new
    // video. It used to accumulate into a persisted GLOBAL offset applied to
    // every future sub, so fixing one badly-timed sub silently desynced all
    // content (that's how a −7.5s leftover made every sub 7.5s early). Now it
    // only affects the sub you're watching.
    if (currentVideo) currentVideo._manualOffset = (currentVideo._manualOffset || 0) + delta;
    const v = $('#video');
    if (v && v.textTracks) {
      for (let i = 0; i < v.textTracks.length; i++) {
        const tt = v.textTracks[i];
        if (!tt.cues) continue;
        for (let j = 0; j < tt.cues.length; j++) {
          const c = tt.cues[j];
          try { c.startTime = Math.max(0, c.startTime + delta); c.endTime = Math.max(0, c.endTime + delta); } catch (_) {}
        }
      }
    }
    if (_subState && _subState.cues) {
      _subState.cues = shiftCueArray(_subState.cues, delta);
      _subState.lastIdx = -1; _subState.lastShown = '';
      refreshSkipMarks();   // intro/credits marks move with the nudge
    }
    return (currentVideo && currentVideo._manualOffset) || 0;
  }
  // Persisted store for a CONFIDENT measured TIER3 audio-sync offset (+ its
  // SCALE, when the multi-sample align detected linear drift), keyed by
  // fileId + the subtitle's own name (a different release's sub can need a
  // different offset for the same file, so the name is part of the key).
  // Without this, a reliably-measured offset only lived on the transient
  // `got` object inside openPlayer's post-load IIFE — it vanished the moment
  // that closure was gone (app reload, a later re-open of the same title),
  // so the file re-paid the full subsync cost (or worse, silently played
  // mistimed subs again) on every single replay. Bounded to the most-recent
  // 200 entries, same shrink-oldest pattern as Storage.save()'s cw: eviction.
  function _subOffsetKey(fileId, subName) { return fileId + '::' + (subName || ''); }
  function savePersistedSubOffset(fileId, subName, offset, scale) {
    if (!fileId || !(offset || offset === 0)) return;
    try {
      const m = Storage.get('subOffsets', {});
      m[_subOffsetKey(fileId, subName)] = { offset, scale: scale || 1, ts: Date.now() };
      const keys = Object.keys(m);
      if (keys.length > 200) {
        keys.sort((a, b) => ((m[a] && m[a].ts) || 0) - ((m[b] && m[b].ts) || 0));
        delete m[keys[0]];
      }
      Storage.set('subOffsets', m);
    } catch (_) {}
  }
  // Returns { offset, scale } for a previously-persisted measurement, or null.
  function loadPersistedSubOffset(fileId, subName) {
    try {
      const m = Storage.get('subOffsets', {});
      const e = m[_subOffsetKey(fileId, subName)];
      return e ? { offset: e.offset, scale: e.scale || 1 } : null;
    } catch (_) { return null; }
  }
  // Infer the intro / title-sequence window from the subtitle cues. A theme
  // song has no dialogue, so it shows up as the biggest cue gap in the opening
  // minutes (or a long silent lead-in before the very first line). Returns
  // { start, end } — Skip Intro seeks to `end`, where dialogue resumes — or
  // null when there's no clear intro gap. Far more accurate than a blind +82s.
  function detectIntroFromCues(cues) {
    if (!cues || cues.length < 3) return null;
    const WINDOW = 360;   // only look in the first 6 minutes
    const MIN_GAP = 18;   // real title sequences run ~20–90s of silence
    let best = null;
    if (cues[0].start >= MIN_GAP) best = { gap: cues[0].start, start: 0, end: cues[0].start };
    for (let i = 0; i < cues.length - 1; i++) {
      if (cues[i].end > WINDOW) break;
      const gap = cues[i + 1].start - cues[i].end;
      if (gap >= MIN_GAP && (!best || gap > best.gap)) {
        best = { gap, start: cues[i].end, end: cues[i + 1].start };
      }
    }
    return best ? { start: Math.max(0, best.start), end: best.end } : null;
  }
  function _lastCueEnd(cues) {
    return (cues && cues.length) ? cues[cues.length - 1].end : null;
  }
  // A cue containing song lyrics or a pure music/theme annotation is not
  // spoken dialogue. Exclude ♪-wrapped lyrics so a musical title sequence
  // is not mistaken for a dialogue scene.
  // Regexes hoisted so _isMusicCue (called once per cue, per candidate window)
  // never builds a fresh RegExp on every invocation.
  const _MUSICCUE_NOTE_RE = /[♩♪♫♬♭♮♯]/;
  const _MUSICCUE_TAG_RE = /^[\[(][^\])]*\b(music|theme|singing|song|instrumental|score)\b[^\])]*[\])]$/i;
  function _isMusicCue(text) {
    const t = (text || '').trim();
    if (!t) return false;
    if (_MUSICCUE_NOTE_RE.test(t)) return true;  // musical-note lyric cues
    // whole-cue music/theme sound tag: "[theme music]", "(singing)", "[music playing]"
    return _MUSICCUE_TAG_RE.test(t);
  }
  // Fraction of [a,b] covered by subtitle DIALOGUE (song lyrics excluded). A
  // real title sequence is (near-)silent OR scored to a song, so this tells us
  // whether a crowd "intro" mark lines up with THIS file's cut — a mark sitting
  // over 35% spoken dialogue is the wrong cut.
  function _cueTalkRatio(cues, a, b) {
    if (!cues || b <= a) return 0;
    let t = 0;
    for (let i = 0, len = cues.length; i < len; i++) {
      const c = cues[i];
      if (_isMusicCue(c.text)) continue;             // a themed song IS the intro
      const s = Math.max(a, c.start), e = Math.min(b, c.end);
      if (e > s) t += e - s;
    }
    return t / (b - a);
  }
  // A themed title-SONG montage shows up as a dense run of ♪-lyric cues — the
  // most reliable intro signal when the title sequence isn't silent (the silent-
  // gap detector below misses it entirely because the song fills the gap with
  // cues). Returns the longest music-cue run in the opening stretch, joining
  // lyric lines separated by short spoken/instrumental beats.
  function detectMusicIntro(cues) {
    if (!cues || cues.length < 4) return null;
    const WINDOW = 420, JOIN = 12;   // first ~7 min; bridge ≤12s between lyric lines
    let bestS = null, bestE = null, bestLen = 0, runS = null, runE = null;
    for (let i = 0, len = cues.length; i < len; i++) {
      const c = cues[i];
      if (c.start > WINDOW) break;
      if (!_isMusicCue(c.text)) continue;            // dialogue cues don't extend/break a run
      if (runS == null) { runS = c.start; runE = c.end; }
      else if (c.start - runE <= JOIN) { runE = Math.max(runE, c.end); }
      else { if (runE - runS > bestLen) { bestS = runS; bestE = runE; bestLen = runE - runS; } runS = c.start; runE = c.end; }
    }
    if (runS != null && runE - runS > bestLen) { bestS = runS; bestE = runE; bestLen = runE - runS; }
    // Require a substantial, music-dominated block (a title montage), not a
    // stray 5-second musical sting mid-scene.
    if (bestS != null && bestLen >= 20) return { start: bestS, end: bestE };
    return null;
  }
  // Recompute the intro / recap / credits skip marks for the active video by
  // RECONCILING the crowd database (IntroDB) with signals from the actual file
  // (chapters + this cut's subtitle cues). Crowd marks are precise when right
  // but come from whatever release the submitter had — so we only trust a crowd
  // intro when the file's own subtitles confirm that window is quiet, else we
  // fall back to the silent gap detected from these cues. Called whenever the
  // cues change (load / nudge) AND when the IntroDB fetch lands.
  function refreshSkipMarks() {
    if (!currentVideo) return;
    const cv = currentVideo;
    const cues = (_subState && _subState.cues) || [];
    cv._subIntro = detectIntroFromCues(cues);
    cv._subLastCueEnd = _lastCueEnd(cues);
    const db = cv._dbSegments || null;
    const chaps = Array.isArray(cv._chapters) ? cv._chapters : [];
    const v = $('#video');
    // TRUE movie duration in remux mode (v.duration is only the rolling window).
    const dur = (typeof Remux !== 'undefined' && Remux.hasSession() && Remux.duration)
      ? Remux.duration : ((v && isFinite(v.duration)) ? v.duration : 0);
    const chapMatch = (rx) => {
      for (let i = 0, len = chaps.length; i < len; i++) {
        const c = chaps[i];
        if (rx.test((c.title || '').toLowerCase())) return { start: c.start, end: c.end };
      }
      return null;
    };

    // The crowd DB (IntroDB v3) gives ARRAYS of candidate cuts per type.
    const dbIntro = (db && Array.isArray(db.intro)) ? db.intro : [];
    const dbRecap = (db && Array.isArray(db.recap)) ? db.recap : [];
    const dbOutro = (db && Array.isArray(db.outro)) ? db.outro : [];

    // RECAP — always at the very start; a chapter wins, else the crowd recap
    // candidate nearest 0. (Recaps carry dialogue, so no silence check.)
    let recap = chapMatch(/recap|previously/);
    if (!recap) {
      const c = dbRecap.filter(r => r.start <= 6 && (r.end - r.start) >= 8
                       // a recap is a front-of-episode object — reject crowd
                       // entries whose END lands deep into THIS release
                       // (different cut) or that run absurdly long
                       && (r.end - r.start) <= 240
                       && (!(dur > 0) || r.end <= dur * 0.2 + 60))
                       .sort((a, b) => a.start - b.start)[0];
      if (c) recap = { start: c.start, end: c.end };
    }
    cv._recapMark = recap;

    // INTRO (title sequence) — a chapter wins; else reconcile the crowd intro
    // with THIS file's cues. The title sequence is either (near-)silent OR
    // scored to a themed song (a dense ♪-lyric run). We validate a crowd
    // candidate by its NON-music dialogue ratio (≤35%), and when a title-song
    // montage sits inside that window we use the SONG's tight, file-accurate
    // bounds instead of the loose crowd span. Fallbacks: a standalone song
    // montage, then the silent cue-gap — both aligned to what's playing.
    let intro = chapMatch(/intro|opening|main ?title|title ?sequence/);
    const musicIntro = detectMusicIntro(cues);
    if (!intro && dbIntro.length) {
      let best = null, bestRatio = 1;
      for (const c of dbIntro) {
        if ((c.end - c.start) < 6) continue;
        const r = _cueTalkRatio(cues, c.start, c.end);
        if (r <= 0.35 && r < bestRatio) { best = c; bestRatio = r; }
      }
      if (best) {
        // If the crowd window contains a title-song montage, trust the song's
        // exact bounds (they're measured from THIS file); else the crowd span.
        if (musicIntro && musicIntro.start >= best.start - 12 && musicIntro.end <= best.end + 12)
          intro = musicIntro;
        else
          intro = { start: best.start, end: best.end };
      }
    }
    // No validated crowd cut: a standalone title-song montage is still a strong,
    // file-accurate intro signal; only then fall back to the silent gap.
    if (!intro && musicIntro) intro = musicIntro;
    if (!intro && cv._subIntro && (cv._subIntro.end - cv._subIntro.start) >= 8) {
      intro = { start: cv._subIntro.start, end: cv._subIntro.end };
    }
    cv._introMark = intro;

    // CREDITS — the latest crowd outro candidate that still leaves real outro
    // time → a chapter titled credits → the end of the last spoken line.
    let credits = null;
    // Crowd outro timestamps come from whichever release the contributor
    // watched — a different cut can shift them by minutes. Only accept a
    // crowd candidate that (a) lands in the tail of THIS file and (b)
    // roughly agrees with where OUR subtitles stop, when that's known;
    // otherwise fall through to the chapter / last-spoken-line heuristics.
    const oc = dbOutro.filter(o => o.start != null).sort((a, b) => b.start - a.start)[0];
    if (oc && (!(dur > 0) || (oc.start > dur * 0.6 && oc.start < dur - 5))
        && (cv._subLastCueEnd == null || Math.abs(oc.start - cv._subLastCueEnd) < 90)) {
      credits = { start: oc.start, end: (oc.end != null ? oc.end : (dur || null)) };
    }
    if (!credits) credits = chapMatch(/credit|ending|outro|end ?card/);
    if (!credits && cv._subLastCueEnd != null && dur > 0
        && cv._subLastCueEnd > dur * 0.7 && (dur - cv._subLastCueEnd) > 25) {
      credits = { start: cv._subLastCueEnd, end: dur };
    }
    cv._creditsMark = credits;
  }
  function setSubCues(video, cues) {
    clearSubOverlay();
    _subVideo = video;
    _subState = { cues: cues || [], lastIdx: -1, lastShown: '' };
    refreshSkipMarks();
    if (!cues || !cues.length) return;
    const el = $('#p-subs');
    if (!el) return;
    const render = () => {
      // The TV skin's .nft-subs is the only overlay that actually
      // paints during real playback — #p-subs sits under display:none
      // !important the whole time (tv-player.css). Skip the cue
      // lookup + DOM work entirely rather than churning an invisible node
      // at 10Hz for a whole film on a GPU-starved panel.
      if (window.__nfActive) return;
      // Cues are keyed to ABSOLUTE movie time; in remux mode the <video>
      // clock is relative to the current HLS generation's keyframe start.
      const t = (typeof Remux !== 'undefined' && Remux.hasSession())
        ? Remux.absolute(video.currentTime) : video.currentTime;
      const list = _subState.cues;
      // Linear scan from lastIdx is O(1) amortized for monotonic playback.
      let idx = _subState.lastIdx;
      if (idx < 0 || idx >= list.length || list[idx].end < t || list[idx].start > t) {
        idx = -1;
        // Binary search the first cue whose end >= t.
        let lo = 0, hi = list.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (list[mid].end < t) lo = mid + 1;
          else hi = mid - 1;
        }
        if (lo < list.length && list[lo].start <= t && t < list[lo].end) idx = lo;
      }
      // Same active cue (or same "no cue") as last render — the overlay
      // already reflects it. The 100ms ticker + timeupdate both call render()
      // many times while one cue is on screen (a cue runs ~2-4s), so this
      // early-out is the common case; it skips the clean/escape/innerHTML
      // work below entirely instead of redoing it just to find nothing changed.
      if (idx === _subState.lastIdx) return;
      _subState.lastIdx = idx;
      if (idx < 0) {
        if (_subState.lastShown) {
          el.classList.remove('is-shown');
          el.innerHTML = '';
          _subState.lastShown = '';
        }
        return;
      }
      const txt = cleanCueText(list[idx].text);
      if (txt === _subState.lastShown) return;
      _subState.lastShown = txt;
      el.innerHTML = `<span>${escapeHtml(txt).replace(/\n/g, '<br>')}</span>`;
      el.classList.add('is-shown');
    };
    video.addEventListener('timeupdate', render);
    video.addEventListener('seeking', render);
    // webOS can throttle `timeupdate` during hardware HEVC playback, delaying
    // cues if it is the only render trigger. A steady 100ms ticker reduces
    // subtitle render latency between those events. render() is
    // cheap and idempotent — it only touches the DOM when the active cue text
    // actually changes — so 10 calls/sec is negligible.
    _subTimeupdateHandler = render;
    _subTicker = setInterval(render, 100);
    render();
  }
  // Legacy hook — now a thin wrapper that pulls cues out of a TextTrack
  // (in case some path still hands us one) and re-routes through setSubCues.
  function wireSubOverlay(video, track) {
    if (!track || !track.cues || !track.cues.length) return;
    // Compensate the native UA painter (the subtitles actually visible on this
    // TV) by shifting the track's cue times, then mirror the shifted cues into
    // our JS overlay so both agree.
    shiftTrackCues(track, subDelaySec());
    const cues = [];
    for (let i = 0; i < track.cues.length; i++) {
      const c = track.cues[i];
      cues.push({ start: c.startTime, end: c.endTime, text: c.text });
    }
    setSubCues(video, cues);
    _subState.fromTrack = true;   // provenance: chooseBestTrack may clear this one
  }

  // Score an embedded audio track. Higher is better. We strongly prefer
  // English over any other language; among English tracks we down-rank
  // commentary, audio-description, and "director's narration" so the
  // primary mix wins. If a release has only foreign audio we leave the
  // existing selection alone (don't surprise the user).
  function scoreAudioTrack(t) {
    const lang  = (t.language || '').toLowerCase();
    const label = (t.label || '').toLowerCase();
    const isEnglish =
      lang === 'en' || lang === 'eng' || lang.startsWith('en-')
      || (!lang && /\benglish\b/.test(label));
    if (!isEnglish) return -Infinity;
    let pts = 100;
    if (/\bcommentary\b/.test(label))                             pts -= 60;
    if (/\b(audio.?description|descriptive|narrat|sdh)\b/.test(label)) pts -= 40;
    // Surround / object-audio hints when the codec exposes them.
    if (/\batmos\b/.test(label))                                  pts += 15;
    if (/\b(7\.1|truehd)\b/.test(label))                          pts += 10;
    if (/\b(5\.1|ddp|eac3)\b/.test(label))                        pts += 5;
    return pts;
  }

  // Auto-select the best English audio track. Mirrors chooseBestTrack but
  // for video.audioTracks (HTMLMediaElement-level audio renditions, e.g. a
  // dual-language MKV with English + Spanish audio in one file).
  function chooseBestAudioTrack(video) {
    const tracks = video.audioTracks;
    if (!tracks || tracks.length < 2) return;     // single track → nothing to do
    let bestIdx = -1, bestPts = -Infinity;
    for (let i = 0; i < tracks.length; i++) {
      const pts = scoreAudioTrack(tracks[i]);
      if (pts > bestPts) { bestPts = pts; bestIdx = i; }
    }
    if (bestIdx < 0 || bestPts < 0) return;       // no English track found
    // Most webOS builds want exactly one enabled. Some implementations
    // permit multiple — explicitly disable the others.
    for (let i = 0; i < tracks.length; i++) {
      try { tracks[i].enabled = (i === bestIdx); } catch (_) {}
    }
  }

  // ---------- Tabs ----------
  // The tab panes and nav buttons are static (fixed in index.html, never
  // rebuilt), so the NodeList->Array walk only needs to happen once instead
  // of on every single tab switch.
  let _tabEls = null, _navEls = null;
  function showTab(name) {
    const prevTab = currentTab;
    currentTab = name;
    // Leaving the Live tab while its International source was selected frees
    // that source's ~10-15MB worldwide IPTV catalog (re-fetched cheaply on
    // return) so it isn't resident for the whole session. (Switching the
    // in-tab source toggle away from International has its own release call
    // in _bindLiveSourceToggle — this one covers leaving the tab entirely.)
    if (prevTab === 'live' && name !== 'live' && liveSource === 'intl') releaseInternational();
    if (!_tabEls) _tabEls = $$('.tab');
    if (!_navEls) _navEls = $$('.nav-item');
    const activeId = `tab-${name}`;
    _tabEls.forEach(t => t.classList.toggle('is-active', t.id === activeId));
    _navEls.forEach(n => n.classList.toggle('is-active', n.dataset.tab === name));
    // Movies tab leaves a temporary search input visible if the user navigated
    // away with a remote arrow instead of blurring it. Reset to the button
    // form so the next tab visit starts clean.
    if (name !== 'movies') {
      const qInput = $('#movies-q');
      const qBtn = $('#movies-search-btn');
      if (qInput && qBtn) {
        qInput.style.display = 'none';
        qInput.tabIndex = -1;
        qBtn.style.display = '';
      }
    }
    if (name === 'home') renderHome();
    if (name === 'movies' && !moviesInited) loadMovies(true);
    if (name === 'shows') Shows.onShow();
    if (name === 'live') renderLiveTab();
    if (name === 'files') renderFiles({ reset: true });
    if (name === 'music') renderMusic();
    if (name === 'library') renderLibrary();
    if (name === 'queue') renderQueue();
    if (name === 'search') renderSearchTab();
    if (name === 'settings') renderSettings();
    // Double rAF instead of a hard 50ms delay — the focus target can have
    // zero width on a slow webOS TV when the timeout fires, in which case
    // DPad.focus rejects it and the user lands on nothing.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const first = document.querySelector(`#tab-${name} button, #tab-${name} input, #tab-${name} .tile, #tab-${name} .lib-row, #tab-${name} .q-row`);
      if (first) DPad.focus(first);
    }));
  }

  // ---------- Home ----------
  function wKey(it) {
    // YTS has IMDb identity instead of TMDB. Keep TMDB keys stable when its
    // IMDb lookup completes, but never merge distinct IMDb-only movies.
    const identity = it.tmdb_id || (it._imdb ? 'imdb:' + String(it._imdb).toLowerCase() : '');
    return (it.kind || 'movie') + '|' + String(it.title || '').toLowerCase()
      + '|' + String(it.year || '') + '|' + String(identity);
  }
  const HOME_CATALOG_KEY = 'home.catalog.verified.v1';
  let homeRenderId = 0;
  function homeCatalogSnapshot() {
    try { return Storage.get(HOME_CATALOG_KEY, {}) || {}; } catch (_) { return {}; }
  }
  function homeIsVerified(it, r) {
    return !!(r && r.status === 'verified' && (it.kind === 'tv' || (r.best && r.best.hash)));
  }
  // The laptop catalog is the only verifier for Home, including
  // pending/empty results; an unavailable laptop verifies nothing.
  async function watchableMap(items, opts) {
    opts = opts || {};
    const m = new Map();
    m.available = false;
    m.pending = false;
    if (!items.length) return m;
    const seen = new Set(), uniq = [];
    for (const it of items) { const k = wKey(it); if (!seen.has(k)) { seen.add(k); uniq.push(it); } }
    // Concurrent + cached identity lookup, always after the first Home paint.
    if (typeof TMDB !== 'undefined' && TMDB.hasKey()) {
      await Promise.all(uniq.map(async it => {
        if (it.tmdb_id && !it._imdb) {
          try { it._imdb = await TMDB.imdbId(it.tmdb_id, it.kind === 'tv' ? 'tv' : 'movie'); } catch (_) {}
        }
      }));
    }
    const payload = uniq.map(it => ({ title: it.title, year: Number(it.year) || null,
      kind: it.kind === 'tv' ? 'tv' : 'movie', imdb: it._imdb || null, tmdb_id: Number(it.tmdb_id) || null }));
    let res = null, laptop = false;
    if (typeof Remux !== 'undefined' && Remux.engine() === 'laptop'
        && typeof LaptopCache !== 'undefined' && LaptopCache.catalogCheck) {
      try {
        res = await LaptopCache.catalogCheck(payload, { max_bytes: MAX_FILE_BYTES, wait_ms: opts.wait_ms || 0 });
        laptop = !!(res && Array.isArray(res.results));
      } catch (_) {}
    }
    // Only the laptop catalog verifies (quality, no cams, size, seeders); the
    // phone's check says "has torrents" with no quality evidence, so it is not
    // a source for Home.
    if (laptop) {
      m.available = true;
      m.source = 'laptop';
      uniq.forEach((it, i) => {
        const r = res.results[i];
        const status = r && r.status || 'unverified';
        if (status === 'pending') m.pending = true;
        m.set(wKey(it), { status, best: r && r.best || null, checkedAt: r && r.checkedAt || null });
      });
    }
    return m;
  }

  async function renderHome() {
    const renderId = ++homeRenderId;
    const isCurrent = () => renderId === homeRenderId && currentTab === 'home';
    const rows = $('#rows');
    unobserveTilePosters(rows);
    rows.innerHTML = '';
    let known = homeCatalogSnapshot();
    let weekTrending = [], dayTrending = [], homeItems = [];
    let weekRow = null, dayRow = null;
    let eligibleHeroFocused = false;

    // Persist tile metadata alongside verification so a cold Home paint does
    // not depend on trending, popular, IMDb, or catalog network requests.
    Object.keys(known).forEach(key => {
      const r = known[key], it = r && r.item;
      if (!it || wKey(it) !== key || !homeIsVerified(it, r)) return;
      (r.row === 'day' ? dayTrending : weekTrending).push(Object.assign({}, it));
    });
    const savedOrder = (a, b) => (known[wKey(a)].order || 0) - (known[wKey(b)].order || 0);
    weekTrending.sort(savedOrder);
    dayTrending.sort(savedOrder);
    homeItems = [...weekTrending, ...dayTrending];

    function tmdbTileFromItem(it) {
      return {
        title:    it.title,
        subtitle: [it.year, it.kind === 'tv' ? 'TV' : 'Movie',
                   it.vote ? `${it.vote}★` : null].filter(Boolean).join(' · '),
        poster:   it.poster_sm || it.poster,    // thumbnail size for tiles
        onClick:  () => (it.kind === 'tv'
          ? openTvShow({
              title: it.title, type: 'tv', poster: it.poster || it.poster_sm,
              year: it.year || null, tmdb_id: it.tmdb_id || null,
            })
          : playTmdbMovieInstant(it)),
      };
    }

    function paintHomeCatalog() {
      homeItems.forEach(it => {
        const r = known[wKey(it)];
        const verified = homeIsVerified(it, r);
        it._catalogStatus = verified ? 'verified' : 'unverified';
        if (verified && it.kind !== 'tv') it._torrent = r.best;
        else delete it._torrent;
      });
      // Only verified titles: no cam rips, nothing that fails on tap.
      const keep = it => it._catalogStatus === 'verified';
      const fw = weekTrending.filter(keep), fd = dayTrending.filter(keep);
      function catalogRow(title, items) {
        const row = makeRow(title, items.map(tmdbTileFromItem));
        const useTrendingHero = () => { eligibleHeroFocused = false; };
        row.addEventListener('dpad-focus', useTrendingHero);
        row.addEventListener('focusin', useTrendingHero);
        return row;
      }
      if (weekRow) { unobserveTilePosters(weekRow); weekRow.remove(); weekRow = null; }
      if (dayRow) { unobserveTilePosters(dayRow); dayRow.remove(); dayRow = null; }
      // Insert before Continue Watching/YTS even when a row was initially
      // empty and pending titles become verified on the background retry.
      if (fd.length) {
        dayRow = catalogRow('Trending today', fd);
        rows.insertBefore(dayRow, rows.firstChild);
      }
      if (fw.length) {
        weekRow = catalogRow('Trending this week', fw);
        rows.insertBefore(weekRow, rows.firstChild);
      }
      if (!eligibleHeroFocused) paintHeroFromTmdb(homeItems.find(it => it._catalogStatus === 'verified'));
    }
    // Only these eligible rows restore controls on focus; the shared focus
    // tracker supplies their text and callbacks when the event bubbles up.
    function eligibleHeroRow(row) {
      const restore = e => {
        if (!isCurrent() || !e.target.closest || !e.target.closest('.tile')) return;
        eligibleHeroFocused = true;
        $('#hero-play').hidden = false;
        $('#hero-info').hidden = false;
      };
      row.addEventListener('dpad-focus', restore);
      row.addEventListener('focusin', restore);
      return row;
    }

    // Pending titles are being checked on the laptop right now. Keep asking
    // (each retry waits up to 8 s there) until they settle or Home changes;
    // one retry left most of a fresh 20-title row hidden.
    function verifyWithRetries(items, apply) {
      let retries = 0;
      function settle(wm) {
        apply(wm);
        if (!wm.pending || wm.source !== 'laptop' || !isCurrent() || retries >= 6) return;
        retries++;
        setTimeout(() => {
          if (!isCurrent()) return;
          watchableMap(items, { wait_ms: 8000 }).then(settle).catch(() => {});
        }, 3000);
      }
      watchableMap(items).then(settle).catch(() => {});
    }

    // Everything above is synchronous, including the first saved-set paint.
    paintHomeCatalog();
    rows.appendChild(eligibleHeroRow(makeContinueWatchingRow(Storage.listContinue())));

    // YTS rows verify independently of the TMDB feeds and each other. Keep
    // their established order even when Just Added verifies first.
    let highRow = null, newRow = null;
    function checkYtsRow(yts, title, isHigh) {
      const movies = ((yts && yts.movies) || []).map(m => Object.assign({}, m,
        { kind: 'movie', _imdb: m.imdb_code }));
      function applyYtsCatalog(wm) {
        if (!isCurrent()) return;
        const verified = wm.available ? movies.filter(m => homeIsVerified(m, wm.get(wKey(m)))) : [];
        verified.forEach(m => { m._torrent = wm.get(wKey(m)).best; });
        const oldRow = isHigh ? highRow : newRow;
        if (oldRow) { unobserveTilePosters(oldRow); oldRow.remove(); }
        const row = verified.length ? eligibleHeroRow(makeRow(title, verified.map(m => ({
          title: m.title, subtitle: `${m.year} · ${m.rating}★`,
          poster: m.medium_cover_image, onClick: () => playYtsMovieInstant(m),
        })))) : null;
        if (isHigh) {
          highRow = row;
          if (row) rows.insertBefore(row, newRow);
        } else {
          newRow = row;
          if (row) rows.appendChild(row);
        }
      }
      verifyWithRetries(movies, applyYtsCatalog);
    }
    const ytsHighP = YTS.search('', { limit: 20, sort_by: 'rating', minimum_rating: 7 }).then(yts => {
      if (!isCurrent()) return;
      checkYtsRow(yts, 'Highly Rated', true);
    }).catch(() => {});
    const ytsNewP = YTS.search('', { limit: 20, sort_by: 'date_added' }).then(yts => {
      if (!isCurrent()) return;
      checkYtsRow(yts, 'Just Added', false);
    }).catch(() => {});

    async function loadTrending() {
      // 1) TWO TMDB trending rows on top — both mixed movies + TV.
      //    /trending/all/week → "Trending this week"
      //    /trending/all/day  → "Trending today"
      // Each tile's media_type drives the click handler (movie → YTS,
      // TV → apibay). The replaced apibay top-100 row was biased
      // toward all-time-best-seeded content, not current trends.
      //
      // Tile count + poster size are tuned for webOS' ~200 MB app cap.
      // Tiles use the w185 thumbnail (decoded ~200 KB each, vs ~1.5 MB
      // for w500); the full-size poster is reserved for the hero
      // backdrop only.
      let weekTrending = [], dayTrending = [];
      if (TMDB.hasKey()) {
        // Week and day trending are independent requests — run them together
        // instead of paying two sequential round-trips.
        const [weekRes, dayRes] = await Promise.all([
          TMDB.trendingWeek(16).catch(e => { console.warn('TMDB week trending:', e); return []; }),
          TMDB.trendingDay(16).catch(e => { console.warn('TMDB day trending:', e); return []; }),
        ]);
        weekTrending = weekRes || [];
        dayTrending = dayRes || [];
      }
      // Don't repeat a title across the two rows — if it's in "Trending today",
      // drop it from "Trending this week" so each title shows once.
      if (dayTrending.length && weekTrending.length) {
        const dayIds = new Set(dayTrending.map(it => it.tmdb_id));
        weekTrending = weekTrending.filter(it => !dayIds.has(it.tmdb_id));
      }
      // If the weekly row is thin (e.g. heavy overlap with "today"), top it up
      // with popular movies from this year (and last year if early-year), deduped.
      if (TMDB.hasKey() && weekTrending.length < 8) {
        try {
          const yr = new Date().getFullYear();
          let pop = await TMDB.popularMovies(yr, 20).catch(() => []);
          if (pop.length < 12) pop = pop.concat(await TMDB.popularMovies(yr - 1, 20).catch(() => []));
          const have = new Set([...weekTrending, ...dayTrending].map(it => it.tmdb_id));
          for (const it of pop) {
            if (weekTrending.length >= 14) break;
            if (it.tmdb_id && !have.has(it.tmdb_id)) { have.add(it.tmdb_id); weekTrending.push(it); }
          }
        } catch (_) {}
      }

      return { week: weekTrending, day: dayTrending };
    }
    const fresh = await loadTrending();
    if (!isCurrent()) return;
    // A failed/empty feed must not erase the last-known verified Home.
    if (fresh.week.length || fresh.day.length) {
      weekTrending = fresh.week;
      dayTrending = fresh.day;
      homeItems = [...weekTrending, ...dayTrending];
    }
    paintHomeCatalog();
    function applyCatalog(wm) {
      if (!isCurrent()) return;
      if (wm.available) {
        const next = {};
        homeItems.forEach((it, order) => {
          const r = wm.get(wKey(it));
          if (!homeIsVerified(it, r)) return;
          const item = { title: it.title, year: it.year, kind: it.kind,
            tmdb_id: it.tmdb_id, poster: it.poster, poster_sm: it.poster_sm,
            backdrop: it.backdrop, overview: it.overview, vote: it.vote, _imdb: it._imdb };
          next[wKey(it)] = Object.assign({}, r, { item,
            row: weekTrending.indexOf(it) >= 0 ? 'week' : 'day', order });
        });
        known = next;
        try { Storage.set(HOME_CATALOG_KEY, known); } catch (_) {}
      }
      // No verifier answer and nothing saved: trending rows stay hidden
      // until verified. YTS rows have their own catalog checks above.
      paintHomeCatalog();
    }
    verifyWithRetries(homeItems, applyCatalog);
    await Promise.all([ytsHighP, ytsNewP]);
  }

  // Hero painter for TMDB-sourced items (replaces the apibay-based
  // paintHeroFromTrending). Backdrop comes straight from TMDB, no
  // IMDb roundtrip. Play + Info both kick the lookup-then-enqueue path.
  function paintHeroFromTmdb(it) {
    const verified = !!(it && it._catalogStatus === 'verified');
    $('#hero-play').hidden = !verified;
    $('#hero-info').hidden = !verified;
    if (!verified) {
      $('#hero-title').textContent = 'Welcome to DumiFlix';
      $('#hero-summary').textContent = 'Browse your library or search for something to watch.';
      $('#hero-play').onclick = null;
      $('#hero-info').onclick = null;
      const bg = document.getElementById('bg');
      if (bg) bg.style.backgroundImage = '';
      return;
    }
    $('#hero-title').textContent = it.title + (it.year ? ` (${it.year})` : '');
    const bits = [
      it.kind === 'tv' ? 'TV series' : 'Movie',
      it.vote ? `${it.vote}★` : null,
    ].filter(Boolean);
    $('#hero-summary').textContent = (it.overview && it.overview.length > 220
        ? it.overview.slice(0, 217) + '…'
        : it.overview) || bits.join(' · ');
    $('#hero-play').onclick = () => (it.kind === 'tv' ? openTmdbTv(it) : playTmdbMovieInstant(it));
    $('#hero-info').onclick = () => (it.kind === 'tv' ? openTmdbTv(it) : openTmdbMovie(it));
    const bg = document.getElementById('bg');
    if (bg) bg.style.backgroundImage = it.backdrop ? `url("${it.backdrop}")` : '';
  }

  function paintHeroFromTrending(it) {
    $('#hero-title').textContent = it.title + (it.year ? ` (${it.year})` : '');
    const bits = [
      it.type === 'tv' ? 'TV series' : 'Movie',
      ...(it.quality || []),
      `${it.seeders} seeds`,
    ];
    $('#hero-summary').textContent = bits.join(' · ');
    $('#hero-play').onclick = () => openTrendingItem(it);
    $('#hero-info').onclick = () => openTrendingItem(it);
    // Pull a poster for the hero background.
    Trending.poster(it.title, it.year, it.type).then(url => {
      if (url) $('#bg').style.backgroundImage = `url("${url}")`;
    }).catch(() => {});
  }

  function trendingToTileItem(it) {
    return {
      title: it.title,
      subtitle: [it.year || (it.type === 'tv' ? 'Series' : 'Movie'),
                 it.size ? fmtSize(it.size) : null].filter(Boolean).join(' · '),
      poster: null,                      // filled in async by hydrateTrendingPosters
      _trending: it,
      onClick: () => openTrendingItem(it),
    };
  }

  async function hydrateTrendingPosters(items) {
    // Walk the rendered tiles in #rows and patch in posters as they resolve.
    // Limit concurrency to avoid hammering IMDb's suggestion endpoint.
    const tiles = [...document.querySelectorAll('#rows .row:first-child .tile')];
    const queue = items.slice(0, tiles.length);
    let i = 0;
    const worker = async () => {
      while (i < queue.length) {
        const idx = i++;
        const it = queue[idx];
        try {
          const url = await Trending.poster(it.title, it.year, it.type);
          if (!url) continue;
          const tile = tiles[idx];
          if (!tile) continue;
          const fallback = tile.querySelector('.tile-fallback');
          if (fallback) fallback.remove();
          let poster = tile.querySelector('.tile-poster');
          if (!poster) {
            poster = document.createElement('div');
            poster.className = 'tile-poster';
            tile.insertBefore(poster, tile.firstChild);
          }
          poster.style.backgroundImage = `url("${url}")`;
          // If this tile is the one currently focused, refresh the hero
          // background immediately — otherwise it stays on whatever poster
          // happened to load first.
          if (tile.classList.contains('is-focused')) {
            $('#bg').style.backgroundImage = `url("${url}")`;
          }
        } catch (_) {}
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  // ---------- Continue Watching ----------
  // Many existing CW items (and any played from the Library) have no `show`
  // field because the caller didn't pass one. Re-derive show context from
  // the filename so:
  //   1) the poster lookup uses TV scope (movie scope mis-matches shows),
  //   2) the next-episode auto-queue still fires for items that arrived
  //      without a queue-side show.
  // Returns { title, season, episode } or null.
  // Normalise a show name for matching: collapse to lowercase letters/digits
  // only. "Example.Show" and "Example Show" both become "exampleshow",
  // while "Example Show Extended" retains its distinct suffix. Punctuation
  // and spacing differences collapse without merging these different titles.
  function _normShow(s) {
    // Regex hoisted onto the function object so repeated calls (this runs
    // per-torrent during show matching / dedup) reuse one compiled RegExp
    // instead of allocating a fresh one every call.
    const re = _normShow._re || (_normShow._re = /[^a-z0-9]+/g);
    return String(s || '').toLowerCase().replace(re, '');
  }
  // Strict show-name match. Used to filter apibay results down to torrents
  // that actually belong to the canonical show — so an "Example Show" search
  // doesn't pull in "Example Show Extended" or "Another Example Show".
  function _isShowMatch(torrentName, canonicalShowName) {
    const inf = inferShowFromTitle(torrentName);
    if (!inf || !inf.title) return false;
    return _normShow(inf.title) === _normShow(canonicalShowName);
  }

  // For same-title series, a tracker row is usable only when its release name
  // explicitly carries the selected premiere year. Rows from an IMDb-scoped
  // source (EZTV) bypass this check because their identity is already exact.
  function _releaseYearMatches(name, year) {
    const wanted = String(year || '').match(/\b(?:19\d{2}|20\d{2})\b/);
    if (!wanted) return true;
    const years = String(name || '').match(/\b(?:19\d{2}|20\d{2})\b/g) || [];
    return years.includes(wanted[0]);
  }

  // Aggressive show-name extractor. Strips episode tags, season tags, year,
  // release flags, and anything inside trailing brackets/parens. Used by
  // both CW dedup and the search-result grouping — the search case sees
  // pack-only torrents ("Show.S03.COMPLETE.x264") and "Season N pack"
  // titles, neither of which carry an S##E##.
  function _stripReleaseTags(s) {
    // Called for every torrent candidate during show grouping/matching — often
    // hundreds of times per TV-show open. Compile the regexes once and reuse
    // them (safe: .replace() resets lastIndex on global patterns internally)
    // instead of re-allocating a RegExp per call.
    const R = _stripReleaseTags._re || (_stripReleaseTags._re = [
      /\b(?:[Ss]\d{1,2}[. _-]?[Ee]\d{1,3}|\d{1,2}x\d{1,3}).*$/i, // S##E## / NxNN…
      /\b[Ss]\d{1,2}\b.*$/,                                   // bare S## …
      /\b(?:Season|Series)[. _-]?\d{1,2}\b.*$/i,              // Season N …
      /\b(?:complete|all\s*seasons)\b.*$/i,                   // complete …
      /\b(19[5-9]\d|20[0-3]\d)\b.*$/,                         // year …
      /\s*[\(\[].*$/,                                         // (extras…) [tags]
      /[._]+/g,
      /\s+/g,
      /^[\s\-–—]+|[\s\-–—]+$/g,
    ]);
    return s
      .replace(R[0], '')
      .replace(R[1], '')
      .replace(R[2], '')
      .replace(R[3], '')
      .replace(R[4], '')
      .replace(R[5], '')
      .replace(R[6], ' ')
      .replace(R[7], ' ')
      .replace(R[8], '')
      .trim();
  }

  function inferShowFromTitle(rawTitle) {
    if (!rawTitle) return null;
    // The CW title often looks like "FolderName — File.mkv" — try the file
    // half first (it carries the most reliable S##E## tag), then the folder.
    const halves = String(rawTitle).split(' — ');
    // Pass 1: full S##E## hit (preferred — carries season + episode).
    for (const half of halves.slice().reverse().concat(halves)) {
      const p = parseEpisodeName(half);
      if (!p.isPack && p.season && p.episode) {
        const name = _stripReleaseTags(half);
        if (name) return { title: name, season: p.season, episode: p.episode };
      }
    }
    // Pass 2: pack-mode fallback (Season N pack / complete series). Returns
    // a show name without episode info — callers that need an episode (CW
    // display, player header, next-episode auto-queue) safely fall through
    // when episode is undefined; the search grouper just needs the name.
    for (const half of halves.slice().reverse().concat(halves)) {
      const p = parseEpisodeName(half);
      if (p.isPack || (p.season && !p.episode)) {
        const name = _stripReleaseTags(half);
        if (name) return { title: name, season: p.season || null, isPack: true };
      }
    }
    return null;
  }

  // Resolve the best show context for a CW entry: prefer the saved one
  // (queue-side context with episodesInSeason / seasonNums), fall back to
  // filename inference.
  function resolveShow(it) {
    if (it && it.show && it.show.title && it.show.season && it.show.episode) return it.show;
    return inferShowFromTitle(it && it.title);
  }

  // Stable series identity for Continue-Watching collapse: drop any embedded
  // year and reduce to lowercase alphanumerics, so "Example Show", "example
  // show" and "Example Show 2024" all resolve to one series ("exampleshow")
  // even when queue-side contexts save inconsistent titles.
  function _cwShowId(title) {
    const re = _cwShowId._re || (_cwShowId._re = /\b(?:19|20)\d{2}\b/g);
    return _normShow(String(title || '').replace(re, ' '));
  }
  // Stable movie identity: cleanTitle strips release/quality/year tags, then we
  // reduce to bare alphanumerics so a filename-dotted cache entry and a
  // human-cased seedr entry of the SAME film collapse — colons, spaces and dots
  // all drop ("Example.Movie.The.Sequel" vs "Example Movie: The Sequel
  // 1080p" → one signature).
  function _cwMovieId(stem) {
    const re = _cwMovieId._re || (_cwMovieId._re = /[^a-z0-9]+/g);
    return Trending.cleanTitle(stem || '').toLowerCase().replace(re, '');
  }

  // The raw filenames from torrents are noisy ("Example.Show.S01E02.1080p.
  // HEVC.x265-GROUP[example].mkv"). We tidy them for display
  // and use the same signature for dedup so re-watching a re-downloaded
  // episode (or the same film streamed from seedr then cache) doesn't pile up
  // multiple entries on the home screen.
  function cwSignature(it) {
    const show = resolveShow(it);
    if (show && show.title && show.season && show.episode) {
      return `tv:${_cwShowId(show.title)}:${show.season}:${show.episode}`;
    }
    const stem = (it.title || it.key || '').split(' — ')[0];
    return 'm:' + _cwMovieId(stem);
  }

  function cwDisplayTitle(it) {
    const show = resolveShow(it);
    if (show && show.title && show.season && show.episode) {
      const sN = String(show.season).padStart(2, '0');
      const eN = String(show.episode).padStart(2, '0');
      return `${show.title} · S${sN}E${eN}`;
    }
    const stem = (it.title || it.key || '').split(' — ')[0];
    return Trending.cleanTitle(stem) || stem;
  }

  function dedupeContinueWatching(items) {
    const byKey = new Map();
    for (const it of items) {
      const k = cwSignature(it);
      const prev = byKey.get(k);
      if (!prev || (it.ts || 0) > (prev.ts || 0)) byKey.set(k, it);
    }
    // Collapse multiple episodes of the same show down to just the
    // most-recently-watched one — only the latest episode of each series
    // belongs in Continue Watching, not every episode the user has started.
    const movies = [], byShow = new Map();
    for (const it of byKey.values()) {
      const show = resolveShow(it);
      if (show && show.title && show.season && show.episode) {
        const sk = 'show:' + _cwShowId(show.title);
        const prev = byShow.get(sk);
        if (!prev || (it.ts || 0) > (prev.ts || 0)) byShow.set(sk, it);
      } else {
        movies.push(it);
      }
    }
    return [...movies, ...byShow.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }

  function makeContinueWatchingRow(rawItems) {
    const items = dedupeContinueWatching(rawItems);
    const row = document.createElement('div');
    row.className = 'row';
    const h = document.createElement('h3');
    h.className = 'row-title';
    h.textContent = 'Continue Watching';
    row.appendChild(h);

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'row-empty';
      empty.textContent = 'Nothing to resume yet. Anything you start watching shows up here.';
      row.appendChild(empty);
      return row;
    }

    const strip = document.createElement('div');
    strip.className = 'row-strip';
    items.forEach(it => strip.appendChild(makeResumeTile(it)));
    row.appendChild(strip);
    return row;
  }

  // Shared hold-OK gesture. `onHold` decides what happens; the capture-phase
  // click guard prevents the synthetic click emitted after key/pointer release
  // from also opening or playing the item underneath the hold action.
  function attachLongPressAction(el, onHold) {
    el.dataset.longPressAction = '1';
    let holdT = null, held = false;
    const start = (e) => {
      if (e && e.repeat) return;
      if (holdT || held) return;
      holdT = setTimeout(() => {
        holdT = null; held = true;
        Promise.resolve().then(onHold).catch(() => {});
      }, 700);
    };
    const cancel = () => { if (holdT) { clearTimeout(holdT); holdT = null; } };
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.keyCode === 13) start(); });
    el.addEventListener('keyup', e => {
      if (e.key !== 'Enter' && e.keyCode !== 13) return;
      // The global D-pad deliberately defers marked buttons on keydown. If
      // the hold timer is still pending this was a short OK press: cancel the
      // timer and perform the normal click now. Once a real hold fired,
      // `holdT` is null and the release must do nothing.
      if (holdT) {
        clearTimeout(holdT); holdT = null;
        e.preventDefault(); el.click();
      } else if (held) {
        // Keyboard activation was already prevented by DPad on keydown, so
        // unlike a pointer hold there is no trailing browser click left to
        // swallow. Clear the guard now or it would eat the NEXT short OK.
        held = false;
        e.preventDefault();
      }
    });
    el.addEventListener('pointerdown', start);
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointerleave', cancel);
    // Swallow the click that follows a long-press so it doesn't also play.
    el.addEventListener('click', e => { if (held) { held = false; e.stopPropagation(); e.preventDefault(); } }, true);
  }

  // Long-press (hold OK ~700ms, or press-and-hold with the magic remote) removes
  // a tile's title completely — its Continue Watching entry, the downloaded file,
  // any pen download, and a blocklist mark so self-heal never re-downloads it. A
  // short press still fires the tile's normal click.
  function attachLongPressRemove(el, it, label) {
    attachLongPressAction(el, async () => {
      toast(`Removing “${label}”…`);
      try { await purgeTitle(it); } catch (_) {}
      toast(`Removed “${label}”`);
      if (currentTab === 'home') renderHome();
      else if (currentTab === 'library') renderLibrary();
    });
  }

  // Destructive confirmation that works both from a closed modal (show-card
  // hold) and on top of the already-open show modal (season-chip hold). On
  // cancel, the caller may repaint the underlying modal at the same season.
  function showDestructiveConfirm(opts) {
    const modalEl = $('#modal'), card = $('#modal-card');
    if (!modalEl || !card) return;
    const wasOpen = modalEl.classList.contains('is-open');
    let busy = false, settled = false;
    const cancel = () => {
      if (busy || settled) return;
      settled = true;
      try { DPad.popBackHandler(); } catch (_) {}
      if (wasOpen && opts.onCancel) opts.onCancel();
      else modalEl.classList.remove('is-open');
    };
    card.innerHTML = `
      <h2>${escapeHtml(opts.title || 'Delete?')}</h2>
      <p>${escapeHtml(opts.message || 'This cannot be undone.')}</p>
      <p class="muted" id="bulk-delete-status" style="font-size:16px;"></p>
      <div class="modal-actions">
        <button class="btn" id="bulk-delete-cancel">Cancel</button>
        <button class="btn btn-primary" id="bulk-delete-confirm" style="background:#e50914;">${escapeHtml(opts.confirmLabel || 'Delete')}</button>
      </div>`;
    const cancelBtn = $('#bulk-delete-cancel'), confirmBtn = $('#bulk-delete-confirm');
    cancelBtn.onclick = cancel;
    confirmBtn.onclick = async () => {
      if (busy || settled) return;
      busy = true;
      cancelBtn.disabled = true; confirmBtn.disabled = true;
      const status = $('#bulk-delete-status');
      if (status) status.textContent = 'Deleting…';
      try {
        await opts.onConfirm();
        settled = true;
        try { DPad.popBackHandler(); } catch (_) {} // confirmation handler
        if (wasOpen) closeModal();                  // underlying show handler
        else modalEl.classList.remove('is-open');
        if (opts.onDone) opts.onDone();
      } catch (e) {
        busy = false;
        cancelBtn.disabled = false; confirmBtn.disabled = false;
        if (status) status.textContent = 'Delete failed: ' + (e && e.message ? e.message : String(e));
      }
    };
    DPad.pushBackHandler(cancel);
    modalEl.classList.add('is-open');
    setTimeout(() => DPad.focus(cancelBtn), 50);
  }

  function makeResumeTile(it) {
    const t = document.createElement('button');
    t.className = 'tile tile-resume';
    t.tabIndex = 0;
    const display = cwDisplayTitle(it);
    if (display) t.dataset.heroTitle = display;
    {
      const remaining = it.duration > 0 ? Math.max(0, it.duration - it.position) : 0;
      const sub = remaining ? `${fmtTime(remaining)} left · Resume` : 'Resume';
      t.dataset.heroSubtitle = sub;
    }

    if (it.poster) {
      const img = document.createElement('div');
      img.className = 'tile-poster';
      img.style.backgroundImage = `url("${it.poster}")`;
      t.appendChild(img);
    } else {
      const fb = document.createElement('div');
      fb.className = 'tile-fallback';
      fb.textContent = display;
      t.appendChild(fb);
      // Poster lookup: if filename parses as S##E## or queue-side show data
      // is present, scope the IMDb suggestion to TV to avoid matching a movie
      // with the same title as the show.
      // For things with no episode tag, fall back to movie scope.
      const show = resolveShow(it);
      const isTv = !!(show && show.title && show.season);
      const guess = isTv ? show.title : display;
      // Movies match the IMDb suggestion endpoint FAR better with the year:
      // cwDisplayTitle strips it, so ambiguous names may return no match.
      // Pull the year back out of the raw filename for the movie lookup.
      // TV lookups use the show title without the movie-year hint.
      let year = '';
      let altGuess = '';
      if (!isTv) {
        const raw = String(it.key || '');
        // The key's basename is the original torrent filename — the richest
        // source of title + year ("…/Example.Movie.The.Sequel.2024.2160p…mkv").
        const base = raw.split('/').pop() || raw.split(':').pop() || raw;
        const ym = (base + ' ' + String(it.title || '')).match(/\b(19[5-9]\d|20[0-3]\d)\b/);
        year = ym ? ym[0] : '';
        // The display stem can be a short, ambiguous title ("Example Movie") while the
        // full title lives in that filename ("Example Movie The Sequel"). Keep the
        // filename-parsed title as a fallback guess when it carries more of the
        // title than the display stem does.
        if (/[\/.]/.test(raw)) {
          const fromKey = Trending.cleanTitle(base);
          if (fromKey && fromKey.split(/\s+/).length > String(display || '').split(/\s+/).length) {
            altGuess = fromKey;
          }
        }
      }
      if (guess) {
        const apply = url => {
          if (!url) return false;
          fb.remove();
          const poster = document.createElement('div');
          poster.className = 'tile-poster';
          poster.style.backgroundImage = `url("${url}")`;
          t.insertBefore(poster, t.firstChild);
          // Cache the resolved artwork back onto the CW entry so future renders
          // paint instantly and never depend on a live lookup again.
          try { if (it.key) Storage.setResume(it.key, { poster: url }); } catch (_) {}
          return true;
        };
        Trending.poster(guess, year, isTv ? 'tv' : 'movie').then(url => {
          // Fall back to the filename-derived title when the display stem was
          // too ambiguous to resolve (e.g. "Example Movie" → "Example Movie The Sequel").
          if (apply(url) || !altGuess) return;
          return Trending.poster(altGuess, year, 'movie').then(apply);
        }).catch(() => {});
      }
    }

    const pct = it.duration > 0
      ? Math.min(99, Math.max(2, (it.position / it.duration) * 100))
      : 0;
    const bar = document.createElement('div');
    bar.className = 'tile-progress';
    bar.innerHTML = `<div class="tile-progress-fill" style="width:${pct.toFixed(1)}%;"></div>`;
    t.appendChild(bar);

    const meta = document.createElement('div');
    meta.className = 'tile-meta';
    const remaining = it.duration > 0 ? Math.max(0, it.duration - it.position) : 0;
    const remStr = remaining ? `${fmtTime(remaining)} left` : 'Resume';
    meta.innerHTML = `<div>${escapeHtml(display)}</div>
      <div style="opacity:.7;font-size:14px;">${remStr}</div>`;
    t.appendChild(meta);

    t.onclick = () => resumeItem(it);
    attachLongPressRemove(t, it, display || 'this');
    return t;
  }

  async function resumeItem(it) {
    // Show the full-screen loading overlay IMMEDIATELY on click: phone remuxing
    // spins up for ~10-20s before the player opens, and without this the user
    // stares at the unchanged Continue row (looks frozen). openPlayer() hides it
    // when the player takes over; the progress poll advances the bar as the
    // remux warms. (itemId=null so it's a resume, not a download to cancel.)
    try {
      showLoading((it && (it.title || it.key)) || 'Resuming…', (it && it.poster) || null, null, 'Preparing stream…');
      startRemuxLoadProgress();
    } catch (_) {}
    // Trust the fileId prefix over the recorded `source`. A stale Continue
    // entry may carry the wrong source — e.g. a file that started on seedr,
    // was copied to the phone cache, and had its resume re-keyed to the
    // CACHE:: id but (in older builds) kept source:'seedr'. A CACHE:: id is
    // always a phone-cache file, so route it straight to the cache/Drive
    // player (self-selects backend by prefix) instead of the dead seedr path.
    if (it.fileId && (
      (typeof PhoneCache !== 'undefined' && PhoneCache.isCacheId(it.fileId)) ||
      (typeof LaptopCache !== 'undefined' && LaptopCache.isCacheId(it.fileId))
    )) {
      return playDriveFile(it.fileId, it.title || it.key, it.poster, null, it.show);
    }
    if ((it.source === 'drive' || it.source === 'cache' || it.source === 'laptop') && it.fileId) {
      // playDriveFile self-routes to the cache or Drive by the fileId prefix.
      return playDriveFile(it.fileId, it.title || it.key, it.poster, null, it.show);
    }
    // Pen-drive files ('phone:' + rel). playPhoneRel verifies the file still
    // exists and falls back to a KeepWatching copy before giving up.
    if ((it.source === 'phone' || /^phone:/.test(String(it.fileId || ''))) && it.fileId) {
      return playPhoneRel(String(it.fileId).replace(/^phone:/, ''), it);
    }
    if (it.source === 'seedr' && it.fileId) {
      return resumeSeedrItem(it);
    }
    if (Drive.isSignedIn()) {
      try {
        const all = await Drive.listAll();
        const match = all.find(f => f.id === it.fileId
                                || f.name === it.title
                                || f.path === it.title);
        if (match) return playDriveFile(match.id, match.name, it.poster, match.subtitles, it.show);
      } catch (_) {}
    }
    // Nothing on device and no Drive match — self-heal: re-fetch and resume.
    return refetchAndResume(it);
  }

  // Resume a seedr continue-watching entry. Seedr is a staging area that gets
  // wiped whenever the user picks something new, so the file may be gone —
  // in that case fall back to the KeepWatching copy the wipe saved to the
  // pen, and only then give up (clearing the dead tile instead of leaving a
  // tile that errors forever).
  // Remux gate. When Remux.enabled() is on and the configured
  // engine (TV or laptop) is reachable, start a stream-copy HLS session and
  // return its playlist URL + session handle; otherwise (or on any failure)
  // return the direct URL untouched. NEVER silently transcodes/switches — a
  // failure toasts and plays direct. `sourceReference` is the signed seedr
  // URL or the phone-relative path.
  // A file's TOTAL bitrate is an upper bound on its video bitrate. YTS gives
  // us an exact torrent byte count plus movie runtime before the magnet is
  // submitted, so for those movies we can prove they are below the server's
  // 6 Mbps VIDEO safety ceiling without opening the remote file with ffprobe.
  // Runtime is rounded down to whole minutes by YTS, which only makes this
  // estimate more conservative (shorter duration => higher estimated rate).
  // Unknown/incomplete hints return false and retain the full probe guard.
  function _safeDirectFromSizeDuration(hint) {
    try {
      const bytes = Number(hint && hint.sizeBytes) || 0;
      const seconds = Number(hint && hint.durationSeconds) || 0;
      if (bytes <= 0 || seconds < 300) return false;
      return (bytes * 8 / seconds) <= 6000000;
    } catch (_) { return false; }
  }

  // Production playback is direct-only. Keep the remux implementation below
  // as dormant diagnostic code, but make the policy explicit at the single
  // entry point so no bitrate guard, retry path, or legacy `forceRemux` caller
  // can silently replace the original file URL with an HLS/ffmpeg session.
  const NORMAL_PLAYBACK_REMUX_ALLOWED = false;

  async function _maybeRemux(directUrl, sourceType, sourceReference, startTime, preferEngine, forceRemux, directSafetyHint) {
    if (!NORMAL_PLAYBACK_REMUX_ALLOWED) return { url: directUrl, sess: null };
    if (typeof Remux === 'undefined') return { url: directUrl, sess: null };

    // 4K goes DIRECT, never through remux. Remuxing a 2160p source can only
    // hurt it: a bitrate ceiling can transcode a high-bitrate source down to the cap
    // and throw away exactly the quality 4K exists for. Direct play with the
    // webOS mediaOption path (see setVideoSource) has none of that cost --
    // URI transport preserves source resolution and bitrate, exposes the
    // full media duration for seeking and bounds native buffering. This
    // avoids the rolling remux window and excess decoder memory pressure.
    // Keep one compatible audio track enabled.
    // Only for a token-bearing laptop-cache URL, because that is what the
    // pipeline can fetch on its own without credentials.
    try {
      if (!forceRemux
          && /2160p|\b4k\b|\buhd\b/i.test(String(sourceReference || '') + ' ' + String(directUrl || ''))
          && /[?&]token=/.test(String(directUrl || ''))) {
        return { url: directUrl, sess: null };
      }
    } catch (_) { /* fall through to the normal remux decision */ }
    if (!Remux.enabled() && !forceRemux) {
      // Remux toggle OFF -> direct play, which is what the user asked for and
      // what happens for every normal release. BUT direct play is the ONE path
      // with an unbounded native buffer on some webOS versions. Buffering
      // by time makes memory use scale with bitrate; high-bitrate sources
      // can therefore exhaust the media budget while the JS heap stays flat.
      // The bitrate guard protects devices with tight decoder memory limits.
      //
      // Nothing on the client can bound that -- the only lever is bitrate, and
      // lowering bitrate REQUIRES a transcode, which only the remux engine can
      // do. So a too-hot source OVERRIDES the toggle instead of crashing: we
      // say why, and fall through into the normal engine chain below. The
      // toggle still wins for every source that is actually safe to hand over.
      //
      // Fails OPEN in every uncertain case (no engine reachable, probe failed,
      // bitrate unknown) -- an unknown bitrate is not evidence of a hot one,
      // and this guard must never be the reason something won't play.
      let tooHot = false;
      let directProbe = null;
      // Proven-safe YTS movies skip the blocking REMOTE ffprobe. On the playback
      // path a remote probe can dominate click-to-first-frame latency even
      // for low-bitrate H.264/AAC. Files without a trustworthy size+duration
      // hint still pay the original guard exactly.
      if (!_safeDirectFromSizeDuration(directSafetyHint)) {
        try {
          directProbe = await Remux.probeBitrate(sourceType, sourceReference);
          tooHot = !!(directProbe && directProbe.tooHigh);
        } catch (_) { tooHot = false; }
      }

      // A token-bearing laptop-cache file has a genuinely seekable local HTTP
      // Range source and goes through NativePlayer's URI/mediaOption path. For
      // codecs the TV can consume natively, HONOUR the user's Direct Play
      // setting even when the old bitrate guard says the file is barely hot.
      //
      // A locally cached H.264 source with supported E-AC-3 audio can play
      // through the native pipeline with bounded buffering. Re-encoding a
      // source only slightly above the bitrate guard loses quality for little
      // bandwidth benefit and makes seeks restart the ffmpeg generation.
      //
      // Keep the safety override for an unsupported video codec or audio that
      // NativePlayer explicitly says needs help (DTS/TrueHD). Unknown probe data
      // keeps the existing fail-open behaviour (`tooHot === false`). This is
      // deliberately scoped to laptop-cache URLs; remote/expiring sources retain
      // the conservative guard.
      let compatibleLaptopDirect = false;
      try {
        const vc = String((directProbe && directProbe.videoCodec) || '').toLowerCase();
        const ac = String((directProbe && directProbe.audioCodec) || '').toLowerCase();
        const laptopRangeUrl = /\/cache\/stream\//.test(String(directUrl || ''))
          && /[?&]token=/.test(String(directUrl || ''));
        const nativeVideo = vc === 'h264' || vc === 'hevc';
        const nativeAudio = typeof NativePlayer === 'undefined'
          || !NativePlayer.audioNeedsHelp(ac);
        compatibleLaptopDirect = laptopRangeUrl && nativeVideo && nativeAudio;
      } catch (_) {}
      if (compatibleLaptopDirect) return { url: directUrl, sess: null };
      if (!tooHot) return { url: directUrl, sess: null };
      try { pToast('High-bitrate release — remuxing so the TV doesn’t run out of memory'); } catch (_) {}
    }
    // Engine selection: ONLY the configured/pinned engine is ever attempted —
    // no automatic fallback to a different engine (that used to include a
    // silent switch between local and remote engines). If it can't be reached, this falls
    // straight through to the existing unreachable/error path below (toast +
    // direct play) instead of picking a different engine on the user's
    // behalf. 'tv' is a valid engine, but only via explicit selection in
    // Settings — it is never auto-picked as a fallback either.
    const cur = Remux.engine();
    const order = [];
    if (sourceType === 'phone' || sourceType === 'usb') {
      // A phone/usb source is a path on the PHONE's filesystem. The phone is
      // not a valid remux engine (see js/remux.js), and no
      // other engine can read a raw phone-local path, so nothing can remux
      // this source any more; it plays direct below. (Real, scoped trade-off:
      // a phone-local file with TV-incompatible audio, e.g. DTS/E-AC3, now
      // has no automatic fix. Browsing/playing the file itself is untouched
      // — see js/phone.js for file-server operations.)
    } else if (preferEngine === 'laptop') {
      // A laptop-cache stream URL -- only the laptop (which owns the file)
      // is tried; no automatic fallback to another engine.
      if (Remux.availableFor('laptop')) order.push('laptop');
    } else {
      // Every other source (seedr/Drive/phone-cache URLs): try only the
      // user's configured engine.
      if (Remux.availableFor(cur)) order.push(undefined);   // undefined -> the selected engine
    }
    if (!order.length) return { url: directUrl, sess: null };
    // `order` now holds at most ONE engine (no more auto-fallback across
    // engines — see above), so the loop below is really just "attempt the
    // one engine, once per seedr retry pass". Kept as a loop (rather than a
    // single attempt) so a stale opts.engine override some future caller
    // might still pass through startSession() is handled the same way.
    //
    // Seedr ff_get links COLD-START: the first probe of a freshly-minted link
    // can fail while seedr is still preparing the file, then succeed moments
    // later. Falling straight to direct there plays raw DTS/E-AC3 = SILENT. So
    // for a seedr source we do a second sweep after a short delay before ever
    // dropping to direct -- this is exactly what silently broke a resumed seedr
    // episode (worked instantly on the very next attempt).
    const passes = (sourceType === 'seedr') ? 2 : 1;
    let lastErr = null;
    for (let pass = 0; pass < passes; pass++) {
      if (pass > 0) { try { pill('Preparing stream…'); } catch (_) {} await new Promise(r => setTimeout(r, 2500)); }
      for (let i = 0; i < order.length; i++) {
        try {
          const sess = await Remux.startSession({
            sourceType: sourceType, sourceReference: sourceReference,
            startTime: startTime || 0, videoTrack: null, audioTrack: null,
            engine: order[i],
          });
          if (i > 0) { try { toast('Remux: ' + cur + ' engine down — using ' + order[i]); } catch (_) {} }
          try { pill(''); } catch (_) {}
          return { url: sess.playbackUrl, sess: sess };
        } catch (e) {
          lastErr = e;
          if (e && e.code === 'superseded') return { url: directUrl, sess: null };
        }
      }
    }
    try { pill(''); } catch (_) {}
    // Surface the silent-direct fallback prominently -- for a non-TV-friendly
    // source (DTS/E-AC3) direct play may lack audio, so the user needs
    // to know why rather than watching a silent picture.
    toast('Couldn’t start remux — audio may be missing. Try again.');
    return { url: directUrl, sess: null };
  }

  async function resumeSeedrItem(it) {
    pill('Resolving stream…');
    let url = null;
    try { url = await Seedr.fetchFileUrl(it.fileId); } catch (_) {}
    if (url) {
      pill('');
      const rmx = await _maybeRemux(url, 'seedr', url, it.position || 0);
      openPlayer(rmx.url, it.title || it.key, {
        fileId: it.fileId, source: 'seedr', poster: it.poster || null,
        subtitle: null, show: it.show || null,
        subFilename: String(it.title || '').split(' — ').pop(),
        _remux: rmx.sess,
      });
      return;
    }
    pill('');
    const alt = await findKeepWatchCopy(it.title || it.key).catch(() => null);
    if (alt) {
      Storage.migrateResume(it.fileId, 'phone:' + alt);
      const e = Storage.getResume('phone:' + alt);
      if (e) Storage.setResume('phone:' + alt, { ...e, source: 'phone', fileId: 'phone:' + alt });
      return playPhoneRel(alt, it);
    }
    // Third chance: a silent torrent re-download may be on (or headed to) the
    // pen — find it by torrent hash among the phone's downloads.
    const hash = String(it.redownloadHash || it.infoHash || '').toLowerCase();
    if (hash && typeof PhoneDL !== 'undefined' && PhoneDL.available()) {
      try {
        const raw = await PhoneDL.list();
        const d = raw.filter(x => (x.infohash || '').toLowerCase() === hash)
                     .sort((a, b) => (b.total || 0) - (a.total || 0))[0];
        if (d && d.status === 'complete' && d.rel) {
          Storage.migrateResume(it.fileId, 'phone:' + d.rel);
          const e = Storage.getResume('phone:' + d.rel);
          if (e) Storage.setResume('phone:' + d.rel, { ...e, source: 'phone', fileId: 'phone:' + d.rel });
          return playPhoneRel(d.rel, it);
        }
        if (d && (d.status === 'active' || d.status === 'waiting')) {
          const pct = d.total ? (d.done / d.total * 100).toFixed(0) : '0';
          toast(`Recovering to the pen — ${pct}% · see Library ▸ Watch Later`);
          return;
        }
      } catch (_) {}
    }
    // Gone from seedr, no pen copy, no in-flight recovery — self-heal: re-fetch
    // the exact title from the tracker and resume from the saved position.
    // (refetchAndResume reads the resume BEFORE re-keying, so don't clear it here.)
    return refetchAndResume(it);
  }

  function openTrendingItem(it) {
    if (it.type === 'tv') openTvShow(it);
    else                  openMovieFromTrending(it);
  }

  // For a movie pulled from apibay trending, queue the highest-seeded
  // torrent directly. We intentionally skip the YTS modal — apibay's row
  // is the actual current top torrent and includes 4K when available.
  function openMovieFromTrending(it) {
    const cleanName = it.title + (it.year ? ` (${it.year})` : '');
    addToQueue({
      name: cleanName,
      magnet: ApiBay.magnet({ name: it.raw_name, info_hash: it.info_hash }),
      infoHash: it.info_hash,
      poster: it.poster || null,
      sizeBytes: it.size || 0,
      autoplay: true,
    });
  }

  // Parse a torrent filename into a structured episode label so the picker
  // can show "S01E05 · 1080p" instead of collapsing every row to the show
  // name. Returns { season, episode, isPack, quality, primary, raw }.
  function parseEpisodeName(name) {
    // This runs per-torrent across whole-season fan-outs (dozens to hundreds
    // of calls per TV-show open) — compile once onto the function object and
    // reuse instead of re-allocating a fresh RegExp on every invocation.
    const RE = parseEpisodeName._re || (parseEpisodeName._re = {
      ep1: /\b[Ss](\d{1,2})[. _-]?[Ee](\d{1,3})(?:[. _-]?[Ee](\d{1,3}))?\b/,
      ep2: /\b(\d{1,2})x(\d{1,3})(?:-(\d{1,3}))?\b/,
      season: /\b(?:Season|S)[. _-]?(\d{1,2})\b/i,
      complete: /\b(complete|all\s*seasons|series)\b/i,
      q4k: /\b(?:2160p|4k|uhd)\b/i,
      q1080: /\b1080p\b/i,
      q720: /\b720p\b/i,
      q480: /\b480p\b/i,
      hdr: /\b(?:hdr|dolby[. _-]?vision|dv)\b/i,
      codec: /\b(?:web[. _-]?dl|webrip|bluray|brrip|hdtv|x264|x265|h\.?264|h\.?265|hevc)\b/i,
      codecStrip: /[.\-_ ]/g,
    });
    // Accept either S01E01-style or 1x01-style episode tags. Some torrents
    // (especially older / non-Western releases) use the cross format.
    const ep = name.match(RE.ep1) || name.match(RE.ep2);
    const season = name.match(RE.season);
    const complete = RE.complete.test(name);
    const q = [];
    if (RE.q4k.test(name))            q.push('4K');
    else if (RE.q1080.test(name))     q.push('1080p');
    else if (RE.q720.test(name))      q.push('720p');
    else if (RE.q480.test(name))      q.push('480p');
    if (RE.hdr.test(name)) q.push('HDR');
    const codec = name.match(RE.codec);
    if (codec) q.push(codec[0].toUpperCase().replace(RE.codecStrip, ''));

    let label;
    let s = 0, e = 0, e2 = 0, isPack = false;
    if (ep) {
      s = parseInt(ep[1], 10);
      e = parseInt(ep[2], 10);
      e2 = ep[3] ? parseInt(ep[3], 10) : 0;
      label = e2
        ? `S${String(s).padStart(2,'0')}E${String(e).padStart(2,'0')}-E${String(e2).padStart(2,'0')}`
        : `S${String(s).padStart(2,'0')}E${String(e).padStart(2,'0')}`;
    } else if (season) {
      s = parseInt(season[1], 10);
      isPack = true;
      label = `Season ${s} pack`;
    } else if (complete) {
      isPack = true;
      label = 'Complete series';
    } else {
      label = 'Other';
    }

    const primary = q.length ? `${label} · ${q.join(' · ')}` : label;
    return { season: s, episode: e, endEpisode: e2, isPack, quality: q, primary, raw: name };
  }

  // Choose the best release for a season-to-pen download: prefer a 1080p
  // encode that isn't absurdly large (so a season doesn't blow the pen), then
  // the most seeders. Falls back to the top-seeded release when nothing looks
  // like a clean 1080p. `torrents` is [{t, p}] as built by openTvShow.
  function pickSeasonVariant(torrents) {
    if (!torrents || !torrents.length) return null;
    const re1080 = pickSeasonVariant._re || (pickSeasonVariant._re = /\b1080p\b/i);
    const scored = torrents.map(x => {
      const size = parseInt(x.t.size || 0, 10) || 0;
      const seeders = parseInt(x.t.seeders || 0, 10) || 0;
      const is1080 = re1080.test(x.t.name) ? 1 : 0;
      const tooBig = size > 6 * 1024 * 1024 * 1024 ? 1 : 0;   // >6 GB per episode
      return { x, tier: is1080 - tooBig, seeders };
    });
    scored.sort((a, b) => (b.tier - a.tier) || (b.seeders - a.seeders));
    return scored[0] ? scored[0].x : null;
  }

  // Choose the best FULL-SEASON pack (one torrent, whole season). Prefer 1080p
  // (good quality without the enormity of 4K, which can be 60 GB+ a season),
  // then the most seeders. Unlike per-episode picking there's no size cap — a
  // season pack is naturally large; the pen has no 5 GB limit. `packs` is the
  // [{t, p}] list already filtered to this season's packs.
  function pickSeasonPack(packs) {
    if (!packs || !packs.length) return null;
    const re1080 = pickSeasonPack._re1080 || (pickSeasonPack._re1080 = /\b1080p\b/i);
    const re4k = pickSeasonPack._re4k || (pickSeasonPack._re4k = /\b(?:2160p|4k|uhd)\b/i);
    const scored = packs.map(x => {
      const name = x.t.name || '';
      const seeders = parseInt(x.t.seeders || 0, 10) || 0;
      const is1080 = re1080.test(name) ? 1 : 0;
      const is4k = re4k.test(name) ? 1 : 0;
      // 1080p wins; 4K is a last resort (huge); 720p/other sit in the middle.
      return { x, tier: is1080 * 2 - is4k, seeders };
    });
    scored.sort((a, b) => (b.tier - a.tier) || (b.seeders - a.seeders));
    return scored[0].x;
  }

  // For a TV trending tile, fetch the canonical season/episode list from
  // TVMaze and overlay whatever apibay has seeded. The picker shows every
  // real episode (S03E04 even if there's no torrent for it), greys out
  // ones with no torrent, and groups packs separately.
  async function openTvShow(it) {
    pill('Loading…');
    let items = [];
    let canonical = null;
    try {
      // Resolve the canonical season list first — we need it to decide
      // how many per-season queries to fan out.
      canonical = await TVMaze.seasonMap(it.title, it.year).catch(() => null);
    } catch (_) {}

    // Strip "(2024)" / trailing year tags from the title before querying —
    // apibay's keyword search doesn't always match titles with parentheticals.
    const baseQ = it.title.replace(/\s*\(\d{4}\).*$/, '').trim();
    const showYear = it.year || (canonical && canonical.show
      && String(canonical.show.premiered || '').slice(0, 4)) || null;
    const strictYear = !!(showYear && canonical && canonical.show && canonical.show.ambiguous);
    const trackerBaseQ = strictYear ? `${baseQ} ${showYear}` : baseQ;
    // Dedup of all info_hashes we've ever ingested for this show — shared
    // between the initial broad fetch and the per-episode fan-outs below
    // so a torrent that appears in both queries doesn't get double-counted.
    const seenHashes = new Set();

    function passesFilter(t, trusted) {
      if (parseInt(t.size || 0) > MAX_FILE_BYTES) return false;
      if (parseInt(t.seeders || 0) <= 0) return false;
      // Strict show match — "Example Show" must not pull in "Example Show
      // Extended" or "Another Example Show" episodes. Skipped for `trusted` rows
      // (EZTV is imdb-scoped, so the show is already guaranteed correct and
      // the name match would wrongly drop variants like "Example Show Extended").
      if (!trusted && !_isShowMatch(t.name, it.title)) return false;
      if (!trusted && strictYear && !_releaseYearMatches(t.name, showYear)) return false;
      return true;
    }

    function ingest(rows, trusted) {
      let added = 0;
      for (const t of (rows || [])) {
        const k = (t.info_hash || '').toLowerCase();
        if (!k || seenHashes.has(k)) continue;
        seenHashes.add(k);
        if (!passesFilter(t, trusted)) continue;
        items.push(t);
        added++;
      }
      return added;
    }

    try {
      // apibay's q.php caps at ~100 results. The broad query returns mostly
      // season packs / recent episodes — older episodes are buried. We pair
      // this with per-episode fan-out (below) once the modal is open, so
      // the user sees packs immediately and the grid fills in the next ~3s.
      const queries = [trackerBaseQ];
      if (canonical && canonical.seasons.size) {
        for (const s of canonical.seasons.keys()) {
          queries.push(`${trackerBaseQ} S${String(s).padStart(2, '0')}`);
        }
      }
      const concurrency = 4;
      let cursor = 0;
      async function worker() {
        while (cursor < queries.length) {
          const i = cursor++;
          try { ingest(await ApiBay.search(queries[i])); }
          catch (_) {}
        }
      }
      await Promise.all(Array.from({ length: concurrency }, worker));
    } catch (_) {}
    // apibay yielded nothing (down / Cloudflare-gated) — fall back to EZTV,
    // keyed by the show's imdb id. EZTV rows are trusted (imdb-scoped).
    if (!items.length && typeof EZTV !== 'undefined') {
      let imdb = it.imdb || (canonical && canonical.show && canonical.show.imdb_id) || null;
      if (!imdb) {
        try { const sm = await TVMaze.seasonMap(it.title, showYear); imdb = sm && sm.show && sm.show.imdb_id; }
        catch (_) {}
      }
      if (imdb) {
        pill('Loading episodes (EZTV)…');
        try { ingest(await EZTV.showTorrents(imdb, { maxBytes: MAX_FILE_BYTES }), true); }
        catch (_) {}
      }
    }
    // Still nothing (apibay down AND no EZTV imdb match) — Knaben meta-search
    // by show name. Fans out a couple of season queries for grid coverage.
    if (!items.length && typeof Knaben !== 'undefined') {
      pill('Loading episodes (Knaben)…');
      const kq = [trackerBaseQ];
      if (canonical && canonical.seasons.size) {
        for (const s of canonical.seasons.keys()) {
          kq.push(`${trackerBaseQ} S${String(s).padStart(2, '0')}`);
          if (kq.length >= 5) break;
        }
      }
      for (const q of kq) {
        try { ingest(await Knaben.search(q, { maxBytes: MAX_FILE_BYTES })); }
        catch (_) {}
      }
    }
    pill('');

    let parsed, packs;
    let torrentsByKey;
    let episodesBySeason;
    let seasonNums = [];

    function rebuildIndexes() {
      parsed = items.map(t => ({ t, p: parseEpisodeName(t.name) }));
      packs = parsed.filter(x => x.p.isPack);
      // Index torrents by "season_episode". Multi-episode files (E01-E02)
      // get added under every episode they cover.
      torrentsByKey = new Map();
      const pushVariant = (s, e, x) => {
        const k = `${s}_${e}`;
        if (!torrentsByKey.has(k)) torrentsByKey.set(k, []);
        torrentsByKey.get(k).push(x);
      };
      for (const x of parsed) {
        if (x.p.isPack) continue;
        if (!x.p.season || !x.p.episode) continue;
        const last = x.p.endEpisode && x.p.endEpisode >= x.p.episode
          ? x.p.endEpisode : x.p.episode;
        for (let n = x.p.episode; n <= last; n++) pushVariant(x.p.season, n, x);
      }
      // Build the seasons → episodes structure. TVMaze takes priority; if
      // it didn't resolve we fall back to whatever apibay actually had so
      // the picker still works for obscure shows TVMaze doesn't list.
      episodesBySeason = new Map();
      if (canonical && canonical.seasons.size) {
        seasonNums = [...canonical.seasons.keys()].sort((a, b) => a - b);
        for (const s of seasonNums) {
          episodesBySeason.set(s, canonical.seasons.get(s).map(ep => ({
            season: s, number: ep.number, name: ep.name, airdate: ep.airdate,
            torrents: torrentsByKey.get(`${s}_${ep.number}`) || [],
          })));
        }
        // Merge in seasons/episodes the torrents have but TVMaze's canonical
        // list doesn't (e.g. a regional variant whose seasons TVMaze didn't
        // return for this title) — built purely from the torrent index so the
        // user still sees them.
        const extra = new Map();
        for (const [k, vs] of torrentsByKey) {
          const [sStr, eStr] = k.split('_');
          const s = parseInt(sStr, 10), n = parseInt(eStr, 10);
          const existing = episodesBySeason.get(s);
          if (existing && existing.some(ep => ep.number === n)) continue;
          if (!extra.has(s)) extra.set(s, episodesBySeason.get(s) || []);
          extra.get(s).push({ season: s, number: n, name: '', airdate: '', torrents: vs });
        }
        for (const [s, list] of extra) {
          list.sort((a, b) => a.number - b.number);
          episodesBySeason.set(s, list);
        }
        seasonNums = [...episodesBySeason.keys()].sort((a, b) => a - b);
      } else {
        const fb = new Map();
        for (const [k, vs] of torrentsByKey) {
          const [sStr, eStr] = k.split('_');
          const s = parseInt(sStr, 10);
          const n = parseInt(eStr, 10);
          if (!fb.has(s)) fb.set(s, []);
          fb.get(s).push({ season: s, number: n, name: '', airdate: '', torrents: vs });
        }
        seasonNums = [...fb.keys()].sort((a, b) => a - b);
        for (const s of seasonNums) {
          fb.get(s).sort((a, b) => a.number - b.number);
          episodesBySeason.set(s, fb.get(s));
        }
      }
    }
    rebuildIndexes();

    if (!seasonNums.length && !packs.length) {
      toast('No episodes found');
      return;
    }

    // Lazy per-episode fan-out for one season. The broad fetch above only
    // surfaces season packs for older shows (apibay's keyword search ranks
    // packs over single episodes). Querying "<show> S01E01" / S01E02 / …
    // is the only way to find the actual per-episode torrents. We do this
    // per-season-on-demand because shows with 100+ episodes would mean
    // hundreds of queries upfront.
    const fetchedSeasons = new Set();
    async function enrichSeason(seasonNum) {
      if (fetchedSeasons.has(seasonNum)) return;
      fetchedSeasons.add(seasonNum);
      if (!canonical || !canonical.seasons.has(seasonNum)) return;
      const eps = canonical.seasons.get(seasonNum);
      const sStr = String(seasonNum).padStart(2, '0');
      const queries = eps.map(ep =>
        `${trackerBaseQ} S${sStr}E${String(ep.number).padStart(2, '0')}`);
      const concurrency = 6;
      let cur = 0;
      let totalAdded = 0;
      async function worker() {
        while (cur < queries.length) {
          const i = cur++;
          try {
            const added = ingest(await ApiBay.search(queries[i]));
            if (added) totalAdded += added;
            // Rebuild + re-render in batches as results arrive so the user
            // sees the grid fill in instead of waiting on the whole season.
            if (added && $('#modal').classList.contains('is-open')
                && activeSeason === seasonNum) {
              rebuildIndexes();
              render();
            }
          } catch (_) {}
        }
      }
      await Promise.all(Array.from({ length: concurrency }, worker));
      if (totalAdded && $('#modal').classList.contains('is-open')
          && activeSeason === seasonNum) {
        rebuildIndexes();
        render();
      }
    }

    // Which episodes of THIS show are already on the pen/cache/Drive — used to
    // stamp ✓ marks in the grid, mark whole seasons as downloaded, and flip the
    // download button into an "open in Library" shortcut once a season is done.
    // Reuses the Library's own grouping so the show-match logic stays identical;
    // best-effort and synchronous — an empty Library snapshot just yields no
    // marks (no harm), and it refreshes on every render as downloads complete.
    function downloadedIndex() {
      const out = new Map();
      try {
        const showName = (canonical && canonical.show && canonical.show.name) || it.title;
        const want = _normShow(_libCleanShowTitle(showName));
        const year = _libShowYear(showName, { year: showYear });
        const { shows } = libBuildGroups(
          _libState.cacheFiles, _libState.driveFiles, _libState.penComplete, _libState.laptopFiles);
        const matches = shows.filter(s => _normShow(_libCleanShowTitle(s.title)) === want);
        // An explicit premiere year must never borrow a remake's episodes.
        // Keep yearless libraries usable only when the identity is unambiguous.
        const g = (year && matches.find(s => String(s.year || '') === year))
          || (matches.length === 1 && (!year || (!matches[0].year && !strictYear))
            ? matches[0] : null);
        if (g) for (const [s, list] of g.seasons) {
          out.set(s, new Set(list.map(x => x.episode).filter(n => n != null)));
        }
      } catch (_) {}
      return out;
    }

    let activeSeason = seasonNums[0] || 1;
    const card = $('#modal-card');

    function render() {
      const eps = episodesBySeason.get(activeSeason) || [];
      const showName = (canonical && canonical.show && canonical.show.name) || it.title;
      const dl = downloadedIndex();
      const dlSet = dl.get(activeSeason) || new Set();
      const packSeasons = new Set((packs || []).map(x => x.p && x.p.season).filter(Boolean));
      const bestPack = pickSeasonPack((packs || [])
        .filter(x => x.p && x.p.isPack && x.p.season === activeSeason));
      const doneCount = eps.filter(e => dlSet.has(e.number)).length;
      const seasonDone = eps.length > 0 && doneCount >= eps.length;

      // Pack-first, status-aware season button. If the whole season is already
      // on the pen it becomes a jump-to-Library shortcut; if a full-season pack
      // exists we advertise its size/quality; otherwise we grab episodes one by
      // one (still no 5 GB cap).
      let btnLabel, btnNote, btnMode;
      if (seasonDone) {
        btnMode = 'library';
        btnLabel = `▶ Open Season ${activeSeason} in Library`;
        btnNote = `All ${eps.length} episodes downloaded`;
      } else if (bestPack) {
        btnMode = 'download';
        const q = (bestPack.p.quality && bestPack.p.quality.join(' · ')) || '';
        btnLabel = `⬇ Download full Season ${activeSeason} pack`;
        btnNote = `${q ? q + ' · ' : ''}${fmtSize(parseInt(bestPack.t.size || 0, 10) || 0)} · ${bestPack.t.seeders} seeds · no 5 GB cap`;
      } else {
        btnMode = 'download';
        btnLabel = `⬇ Download Season ${activeSeason}`;
        btnNote = 'No full-season pack — grabs each episode · no 5 GB cap';
      }

      card.innerHTML = `
        <h2>${escapeHtml(showName)}</h2>
        <p class="tvshow-sub">${canonical
          ? `Season ${activeSeason} · ${eps.length} episode${eps.length === 1 ? '' : 's'}`
            + (doneCount ? ` · <span class="tvshow-tag tvshow-tag-done">✓ ${doneCount} downloaded</span>` : '')
            + (bestPack ? ` · <span class="tvshow-tag tvshow-tag-pack">pack available</span>` : '')
          : 'Couldn\'t reach the episode database — showing only torrents we found.'}</p>
        ${seasonNums.length ? `
          <div class="chips" id="season-chips" style="padding:0 0 12px;">
            ${seasonNums.map(s => {
              const sd = (dl.get(s) || new Set()).size;
              const mark = sd ? ' <span class="chip-badge chip-badge-done">✓</span>'
                : (packSeasons.has(s) ? ' <span class="chip-badge chip-badge-pack">⬇</span>' : '');
              return `<button class="chip ${s === activeSeason ? 'is-active' : ''}" data-s="${s}">Season ${s}${mark}</button>`;
            }).join('')}
          </div>
          <div class="season-bar">
            <button class="btn btn-primary" id="dl-season-pen" data-mode="${btnMode}">${btnLabel}</button>
            <span class="muted season-bar-note">${btnNote}</span>
          </div>
          <div class="ep-grid" id="ep-grid">
            ${eps.map(ep => {
              const has = ep.torrents.length > 0;
              const done = dlSet.has(ep.number);
              const best = has ? pickSeasonVariant(ep.torrents) : null;
              const big = best && (parseInt(best.t.size || 0, 10) || 0) > MAX_FILE_BYTES;
              const badges = (done ? '<span class="ep-badge ep-badge-done">✓</span>' : '')
                + (!done && big ? '<span class="ep-badge ep-badge-big">⬇</span>' : '');
              const sub = done ? 'Downloaded'
                : has ? `${ep.torrents.length} variant${ep.torrents.length === 1 ? '' : 's'}${big ? ' · watch later' : ''}`
                : 'No torrent';
              const clickable = has || done;
              return `
                <button class="ep-cell ${clickable ? '' : 'is-empty'} ${done ? 'is-done' : ''}"
                        data-e="${ep.number}"
                        ${has ? 'data-has="1"' : ''}
                        tabindex="${clickable ? 0 : -1}"
                        ${clickable ? '' : 'aria-disabled="true"'}>
                  <div class="ep-num">E${String(ep.number).padStart(2,'0')}${badges}</div>
                  ${ep.name ? `<div class="ep-cell-name">${escapeHtml(ep.name)}</div>` : ''}
                  <div class="ep-cell-meta">${sub}</div>
                </button>`;
            }).join('')}
          </div>` : ''}
        ${packs.length ? `
          <h3 class="pack-head">Other season packs</h3>
          <div class="results-list" id="pack-list">
            ${packs.slice(0, 12).map((x, i) => `
              <button class="result-row ep-row" tabindex="0" data-idx="${i}">
                <div class="ep-text">
                  <div class="ep-primary">${escapeHtml(x.p.primary)}</div>
                  <div class="ep-raw">${escapeHtml(x.t.name)}</div>
                </div>
                <div class="ep-meta">${fmtSize(parseInt(x.t.size, 10))} · ${x.t.seeders} seeds</div>
              </button>`).join('')}
          </div>` : ''}
        <div class="modal-actions"><button class="btn" id="m-cancel">Cancel</button></div>
      `;
      $('#m-cancel').onclick = closeModal;
      const dlBtn = $('#dl-season-pen');
      if (dlBtn) dlBtn.onclick = () => {
        if (dlBtn.dataset.mode === 'library') { closeModal(); showTab('library'); }
        else downloadSeasonToPen();
      };

      $$('#pack-list .result-row').forEach((row, i) => {
        row.onclick = () => queuePick(packs[i]);
      });
      $$('#season-chips .chip').forEach(c => {
        c.onclick = () => {
          activeSeason = parseInt(c.dataset.s, 10);
          render();
          // Lazy-fetch per-episode torrents for this season — fires once
          // per season and re-renders the grid as results stream in.
          enrichSeason(activeSeason).catch(() => {});
          setTimeout(() => {
            const firstAvail = $('#ep-grid .ep-cell:not(.is-empty)');
            DPad.focus(firstAvail || $('#ep-grid .ep-cell'));
          }, 30);
        };
      });
      $$('#ep-grid .ep-cell').forEach(cell => {
        if (cell.classList.contains('is-empty')) return;
        cell.onclick = () => {
          const n = parseInt(cell.dataset.e, 10);
          // Already downloaded and no fresh torrent to re-grab → jump to the
          // Library, where it plays and auto-advances with zero re-fetch.
          if (cell.classList.contains('is-done') && !cell.dataset.has) {
            closeModal(); showTab('library'); return;
          }
          openEpisodeVariants(activeSeason, n);
        };
      });
    }

    function queuePick(x, season, episode) {
      closeModal();
      const show = season && episode ? {
        title: it.title,
        poster: it.poster || null,
        year: showYear,
        identityAmbiguous: strictYear,
        season,
        episode,
        // Episode total per season — used to decide whether to roll into the
        // next season after the last episode finishes.
        episodesInSeason: (episodesBySeason.get(season) || []).length,
        seasonNums,
        // IMDb id of the show, when TVMaze had it. Used by the OpenSubs
        // fallback (parent_imdb_id search) to scope subtitle lookups to
        // exactly this show — defends against same-keyword shows
        // ("Example Show" vs "Another Example Show") leaking into the result set.
        imdbId: (canonical && canonical.show && canonical.show.imdb_id) || null,
      } : null;
      addToQueue({
        name: x.t.name,
        magnet: ApiBay.magnet(x.t),
        infoHash: x.t.info_hash,
        poster: it.poster || null,
        show,
        sizeBytes: parseInt(x.t.size || 0, 10) || 0,
        autoplay: true,
      });
    }

    // Download a whole season to the pen (aria2), bypassing seedr's 5 GB /
    // one-at-a-time limits. PREFERS a full-season PACK — a single torrent that
    // carries every episode — so we grab the season in ONE download instead of
    // chasing each episode's own torrent. aria2 keeps the pack's multi-file
    // layout; the phone reports one row per episode and the Library groups them
    // into a season (by each file's S##E## name) and plays them in order. Only
    // when no season pack exists do we fall back to per-episode downloads.
    async function downloadSeasonToPen() {
      // When the LAN/laptop server engine is active, download to ITS disk cache
      // (no 5 GB seedr cap) instead of the phone pen. A season pack imports
      // every episode as its own cache entry, so they appear in the Library and
      // play via the server remux. The phone path below is untouched otherwise.
      if (typeof Remux !== 'undefined' && Remux.engine() === 'laptop'
          && typeof LaptopCache !== 'undefined' && LaptopCache.available()) {
        return downloadSeasonToServer(activeSeason);
      }
      if (typeof PhoneDL === 'undefined' || !PhoneDL.available()) {
        toast('Set your phone host in Settings first'); showTab('settings'); return;
      }
      const s = activeSeason;
      const btn = $('#dl-season-pen');
      const resetBtn = () => { if (btn) { btn.disabled = false; btn.textContent = `⬇ Download Season ${s} to Pen`; } };
      if (btn) { btn.disabled = true; btn.textContent = `Finding Season ${s} pack…`; }
      const showName = (canonical && canonical.show && canonical.show.name) || it.title;
      const safe = showName.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim() || 'Show';
      const sStr = String(s).padStart(2, '0');
      const dir = `Downloads/${safe}/Season ${sStr}`;
      const imdbId = (canonical && canonical.show && canonical.show.imdb_id) || null;

      // 1) Full-season pack — one torrent, the whole season, no per-episode grind.
      const seasonPacks = (packs || []).filter(x => x.p && x.p.isPack && x.p.season === s);
      const pack = pickSeasonPack(seasonPacks);
      if (pack) {
        try {
          await PhoneDL.add(ApiBay.magnet(pack.t), { dir });   // no `out` → keep pack layout
          closeModal();
          toast(`⬇ Downloading Season ${s} pack (${fmtSize(parseInt(pack.t.size || 0, 10) || 0)}) to pen`, 4500);
          showTab('library');
        } catch (e) {
          resetBtn();
          toast('Couldn\'t start the season pack: ' + (e.message || e));
        }
        return;
      }

      // 2) No pack for this season — fall back to fetching episodes individually.
      if (btn) btn.textContent = `No pack — finding episodes…`;
      await enrichSeason(s).catch(() => {});
      const eps = (episodesBySeason.get(s) || []).filter(ep => ep.torrents && ep.torrents.length);
      if (!eps.length) { toast('No season pack or episode torrents found for this season'); resetBtn(); return; }
      toast('No full-season pack found — grabbing episodes individually', 3500);
      const all = wlMetaAll();
      let queued = 0;
      for (const ep of eps) {
        const best = pickSeasonVariant(ep.torrents);
        if (!best) continue;
        const eStr = String(ep.number).padStart(2, '0');
        const out = `${safe} S${sStr}E${eStr}.mkv`;
        const rel = `${dir}/${out}`;
        const magnet = ApiBay.magnet(best.t);
        const hash = (best.t.info_hash || '').toLowerCase();
        const key = hash || magnet.slice(0, 60);
        if (all[key] && all[key].rel) continue;         // already downloaded/known
        try {
          await PhoneDL.add(magnet, { dir, out });
          all[key] = {
            hash, gid: null,
            title: `${showName} — S${sStr}E${eStr}`, name: best.t.name,
            poster: it.poster || null, kind: 'tv',
            show: { title: showName, poster: it.poster || null, year: showYear,
                    identityAmbiguous: strictYear, season: s, episode: ep.number,
                    episodesInSeason: eps.length, seasonNums, imdbId },
            sizeBytes: parseInt(best.t.size || 0, 10) || 0, rel,
            addedAt: Date.now() + ep.number,           // stable per-episode order
          };
          queued++;
        } catch (_) {}
      }
      wlMetaSetAll(all);
      closeModal();
      if (queued) { toast(`⬇ Downloading ${queued} episode${queued === 1 ? '' : 's'} of Season ${s} to pen`, 4200); showTab('library'); }
      else toast('Those episodes are already on your pen');
    }

    // Server (laptop) equivalent of downloadSeasonToPen: hand the season pack
    // (or, failing that, each episode's magnet) to the server's direct-torrent
    // downloader. Finished files become VPSCACHE:: cache entries that the
    // Library already renders + plays — no pen/wlMeta bookkeeping needed.
    async function downloadSeasonToServer(s) {
      const btn = $('#dl-season-pen');
      const resetBtn = () => { if (btn) { btn.disabled = false; btn.textContent = `⬇ Download Season ${s} to Server`; } };
      if (btn) { btn.disabled = true; btn.textContent = `Finding Season ${s} pack…`; }
      const showName = (canonical && canonical.show && canonical.show.name) || it.title;
      const sStr = String(s).padStart(2, '0');
      const onTick = (t) => {
        if (t.status === 'error') toast('Server download failed: ' + (t.error || ''), 4000);
        else if (t.status === 'ready') {
          const n = (t.rels || []).length;
          toast(`✓ Season ${s} on server — ${n} file${n === 1 ? '' : 's'} ready`, 4000);
          if (currentTab === 'library' && typeof renderLibrary === 'function') renderLibrary();
        }
      };
      // 1) Full-season pack — one torrent carrying every episode.
      const seasonPacks = (packs || []).filter(x => x.p && x.p.isPack && x.p.season === s);
      const pack = pickSeasonPack(seasonPacks);
      if (pack) {
        LaptopCache.addTorrent({ source: ApiBay.magnet(pack.t), name: `${showName} S${sStr}` }, onTick);
        closeModal();
        toast(`⬇ Downloading Season ${s} pack (${fmtSize(parseInt(pack.t.size || 0, 10) || 0)}) to server`, 4500);
        showTab('library');
        return;
      }
      // 2) No pack — grab each episode's best magnet (server queues them).
      if (btn) btn.textContent = `No pack — finding episodes…`;
      await enrichSeason(s).catch(() => {});
      const eps = (episodesBySeason.get(s) || []).filter(ep => ep.torrents && ep.torrents.length);
      if (!eps.length) { toast('No season pack or episode torrents found for this season'); resetBtn(); return; }
      let queued = 0;
      for (const ep of eps) {
        const best = pickSeasonVariant(ep.torrents);
        if (!best) continue;
        const eStr = String(ep.number).padStart(2, '0');
        LaptopCache.addTorrent({ source: ApiBay.magnet(best.t), name: `${showName} S${sStr}E${eStr}.mkv` }, onTick);
        queued++;
      }
      closeModal();
      if (queued) { toast(`⬇ Downloading ${queued} episode${queued === 1 ? '' : 's'} of Season ${s} to server`, 4200); showTab('library'); }
      else toast('No episode torrents found for this season');
    }

    function openEpisodeVariants(s, e) {
      const eps = episodesBySeason.get(s) || [];
      const epRow = eps.find(x => x.number === e);
      const variants = (epRow && epRow.torrents) || [];
      variants.sort((a, b) => parseInt(b.t.seeders||0,10) - parseInt(a.t.seeders||0,10));
      const epLabel = `S${String(s).padStart(2,'0')}E${String(e).padStart(2,'0')}`;
      const epName = epRow && epRow.name ? ` — ${epRow.name}` : '';
      card.innerHTML = `
        <h2>${escapeHtml(it.title)} — ${epLabel}${escapeHtml(epName)}</h2>
        <p style="margin:8px 0 16px;color:#aaa;">Pick a quality. Under 5 GB streams instantly; larger files download to your phone to watch later.</p>
        <div class="results-list" id="var-list">
          ${variants.map((x, i) => {
            const big = (parseInt(x.t.size || 0, 10) || 0) > MAX_FILE_BYTES;
            return `
            <button class="result-row ep-row" tabindex="0" data-idx="${i}">
              <div class="ep-text">
                <div class="ep-primary">${escapeHtml((x.p.quality && x.p.quality.join(' · ')) || 'Unknown quality')}${big ? ' <span class="wl-badge">⬇ Watch later</span>' : ''}</div>
                <div class="ep-raw">${escapeHtml(x.t.name)}</div>
              </div>
              <div class="ep-meta">${fmtSize(parseInt(x.t.size, 10))} · ${x.t.seeders} seeds${big ? ' · over 5 GB → downloads to pen' : ''}</div>
            </button>`;
          }).join('')}
        </div>
        <div class="modal-actions">
          <button class="btn" id="m-back">← Seasons</button>
          <button class="btn" id="m-cancel">Cancel</button>
        </div>
      `;
      $('#m-cancel').onclick = closeModal;
      $('#m-back').onclick = () => {
        render();
        setTimeout(() => DPad.focus($('#ep-grid .ep-cell:not(.is-empty)')), 30);
      };
      $$('#var-list .result-row').forEach((row, i) => {
        row.onclick = () => {
          const x = variants[i];
          const big = (parseInt(x.t.size || 0, 10) || 0) > MAX_FILE_BYTES;
          if (big) {
            // Too big for seedr's 5 GB cap → torrent straight to the laptop,
            // loading overlay up the whole way, plays when it lands.
            closeModal();
            downloadToServerAndPlay({
              name: x.t.name, magnet: ApiBay.magnet(x.t), infoHash: x.t.info_hash,
              poster: it.poster || null, sizeBytes: parseInt(x.t.size || 0, 10) || 0,
              title: `${it.title} — ${epLabel}`, kind: 'tv',
              show: {
                title: (canonical && canonical.show && canonical.show.name) || it.title,
                poster: it.poster || null, year: showYear,
                identityAmbiguous: strictYear, season: s, episode: e,
                episodesInSeason: (episodesBySeason.get(s) || []).length, seasonNums,
                imdbId: (canonical && canonical.show && canonical.show.imdb_id) || null,
              },
            });
          } else {
            queuePick(x, s, e);
          }
        };
      });
      setTimeout(() => DPad.focus($('#var-list .result-row')), 30);
    }

    if (!$('#modal').classList.contains('is-open')) DPad.pushBackHandler(closeModal);
    $('#modal').classList.add('is-open');
    render();
    // Kick off per-episode fetch for the season we just opened on. Doesn't
    // block — packs and the greyed grid render immediately, the grid then
    // fills in as results arrive (~3s for a 10-episode season).
    enrichSeason(activeSeason).catch(() => {});
    setTimeout(() => {
      const first = $('#dl-season-pen')
                 || $('#ep-grid .ep-cell:not(.is-empty)')
                 || $('#ep-grid .ep-cell')
                 || $('#pack-list .result-row')
                 || $('#m-cancel');
      if (first) DPad.focus(first);
    }, 50);
  }

  function makeRow(title, items) {
    const row = document.createElement('div');
    row.className = 'row';
    const h = document.createElement('h3');
    h.className = 'row-title';
    h.textContent = title;
    row.appendChild(h);
    const strip = document.createElement('div');
    strip.className = 'row-strip';
    items.forEach(it => strip.appendChild(makeTile(it)));
    row.appendChild(strip);
    return row;
  }

  // Lazy-load tile posters via IntersectionObserver. webOS has a hard
  // ~200 MB WebView memory cap; loading all posters up front (~70+ tiles
  // across home rows × ~200 KB decoded each = 14+ MB just for thumbnails)
  // tips the app into OOM-restart. We only set background-image when the
  // tile is within 1.5× viewport-width of being visible, and CLEAR it
  // when more than 3× viewport-width away — freeing the decoded bitmap
  // back to the GC.
  const _tileObserver = (typeof IntersectionObserver !== 'undefined')
    ? new IntersectionObserver((entries) => {
        for (const e of entries) {
          const el = e.target;
          const url = el.dataset.poster;
          if (!url) continue;
          if (e.isIntersecting) {
            if (!el.style.backgroundImage) {
              el.style.backgroundImage = `url("${url}")`;
            }
          } else {
            // Off-screen by margin — drop the bitmap back to the GC.
            el.style.backgroundImage = '';
            // Fallback for an unexpected detach. Row replacement explicitly
            // unobserves first: removing an already offscreen tile need not
            // produce another intersection notification.
            if (el.isConnected === false) _tileObserver.unobserve(el);
          }
        }
      }, { rootMargin: '150% 0px' })   // start loading 1.5 viewports early
    : null;

  function unobserveTilePosters(root) {
    if (!_tileObserver || !root) return;
    root.querySelectorAll('.tile-poster[data-poster]').forEach(el => {
      _tileObserver.unobserve(el);
      el.style.backgroundImage = '';
    });
  }

  function makeTile({ title, subtitle, poster, onClick }) {
    const t = document.createElement('button');
    t.className = 'tile';
    t.tabIndex = 0;
    if (title) t.dataset.heroTitle = title;
    if (subtitle) t.dataset.heroSubtitle = subtitle;
    if (poster) {
      const img = document.createElement('div');
      img.className = 'tile-poster';
      img.dataset.poster = poster;
      // If IntersectionObserver isn't available (webOS 4 fallback), load
      // immediately so we don't end up with blank tiles.
      if (_tileObserver) _tileObserver.observe(img);
      else img.style.backgroundImage = `url("${poster}")`;
      t.appendChild(img);
    } else {
      const fb = document.createElement('div');
      fb.className = 'tile-fallback';
      fb.textContent = title;
      t.appendChild(fb);
    }
    const meta = document.createElement('div');
    meta.className = 'tile-meta';
    meta.innerHTML = `<div>${escapeHtml(title)}</div>${subtitle ? `<div style="opacity:.7;font-size:14px;">${escapeHtml(subtitle)}</div>` : ''}`;
    t.appendChild(meta);
    t.addEventListener('click', onClick);
    return t;
  }

  function escapeHtml(s) {
    // This is on the hottest path in the whole app (every title/label in every
    // render). The original allocated a brand-new lookup object on EVERY
    // matched character; cache the map + regex once on the function instead.
    const map = escapeHtml._map || (escapeHtml._map = {
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    });
    const re = escapeHtml._re || (escapeHtml._re = /[&<>"']/g);
    return String(s || '').replace(re, c => map[c]);
  }

  // For interpolating a URL into a CSS `url('…')` value inside an HTML
  // `style` attribute. Strips chars that could escape either the CSS string
  // or the surrounding HTML attribute. Anything weird → empty (no poster).
  function escapeCssUrl(s) {
    const v = String(s || '');
    const re = escapeCssUrl._re || (escapeCssUrl._re = /["'()\\\s<>]/);
    if (re.test(v)) return '';
    return v;
  }

  // ---------- Movie modal ----------
  // ---- TMDB tile bridges ----
  // TMDB gives us title + year + poster. To play, we need a magnet.
  // Movies: YTS by query_term → existing openMovieModal flow.
  // TV: apibay search by title (cat=205 = HD TV) → addToQueue with the
  // top-seeded result. If lookup misses, drop the user on the search
  // tab pre-filled with the title.
  // Pick the file to auto-play for a movie. A 4K release that fits inside
  // Seedr's hard 5 GiB ceiling always wins; seed count only breaks ties within
  // the same resolution. The old "4K only when it has >=8 seeds and at least
  // 40% as many as 1080p" rule routinely chose 1080p even though a perfectly
  // usable, in-budget 4K release was available.
  const _RE_IS_4K = /2160|4k|uhd/i;
  const _RE_IS_1080 = /1080/i;
  function pickBestTorrent(torrents) {
    // Single pass instead of filter→map→3×sort: for the small per-movie
    // torrent lists this is trivial either way, but it avoids allocating
    // three intermediate arrays plus their sorted copies on every call
    // (this runs on every trending-tile tap and modal open).
    let best4k = null, best1080 = null, bestAny = null;
    const list = torrents || [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if ((t.size_bytes || 0) > MAX_FILE_BYTES) continue;
      const s = parseInt(t.seeds || 0, 10);
      if (!(s > 0)) continue;
      if (!bestAny || s > bestAny.s) bestAny = { t, s };
      const q = t.quality || '';
      if (_RE_IS_4K.test(q) && (!best4k || s > best4k.s)) best4k = { t, s };
      if (_RE_IS_1080.test(q) && (!best1080 || s > best1080.s)) best1080 = { t, s };
    }
    if (!bestAny) return null;
    if (best4k) return best4k.t;
    if (best1080) return best1080.t;
    return bestAny.t;
  }

  // A title search can return a remake or an unrelated film. IMDb is exact;
  // otherwise both the normalized title and selected year must agree.
  function _movieTitleKey(title) {
    let key = String(title || '').replace(/\s*\(\d{4}\).*$/, '').toLowerCase();
    // NFD makes composed/decomposed accents agree; retain non-Latin text
    // rather than collapsing every foreign title to the same empty key.
    if (typeof key.normalize === 'function') key = key.normalize('NFD');
    return key.replace(/[\u0300-\u036f]/g, '')
      .replace(/[\s\u0000-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u009f\u2010-\u2015\u2018-\u201f\u2026\u3001\u3002\u3008-\u3011\uff01\uff08\uff09\uff0c\uff0e\uff1a\uff1b\uff1f]+/g, '');
  }

  function _movieIdentityMatches(movie, selected) {
    if (!movie || !selected) return false;
    const imdb = selected._imdb || selected.imdb_id || selected.imdb || selected.imdb_code;
    if (/^tt\d+$/.test(imdb || '')) return movie.imdb_code === imdb;
    const wanted = _movieTitleKey(selected.title);
    return !!wanted && _movieTitleKey(movie.title) === wanted
      && (!selected.year || String(movie.year) === String(selected.year));
  }

  async function lookupYtsMovie(selected) {
    let imdb = selected._imdb || selected.imdb_id || selected.imdb || selected.imdb_code;
    if (!/^tt\d+$/.test(imdb || '') && selected.tmdb_id
        && typeof TMDB !== 'undefined' && typeof TMDB.imdbId === 'function') {
      try { imdb = await TMDB.imdbId(selected.tmdb_id, 'movie'); } catch (_) {}
    }
    const identity = { ...selected, _imdb: imdb };
    const query = /^tt\d+$/.test(imdb || '') ? imdb : selected.title;
    const yts = await YTS.search(query, { limit: 6, sort_by: 'seeds' });
    let movie = ((yts && yts.movies) || []).find(m => _movieIdentityMatches(m, identity)) || null;
    // list_movies already carries torrents; the detail call only adds a round
    // trip to every tap unless they are missing.
    if (movie && movie.id && !(Array.isArray(movie.torrents) && movie.torrents.length)) {
      try {
        const d = await YTS.detail(movie.id);
        if (d && d.movie) movie = _movieIdentityMatches(d.movie, identity) ? d.movie : null;
      } catch (_) {}
    }
    return movie;
  }

  // A tap on a title we already have plays that copy at its saved position
  // instead of re-adding the torrent to Seedr and losing the saved position.
  // The lookup is capped so a slow
  // phone check never delays a new title; a different year in the file name
  // (a remake) is not treated as the same movie.
  async function playLocalCopyIfPresent({ title, year, poster, show }) {
    if (!title) return false;
    let hit = null, known = 0;
    // Instant: the last-known laptop listing (no network). Refresh it in the
    // background for the next tap.
    try {
      if (typeof LaptopCache !== 'undefined' && LaptopCache.listKnown) {
        const files = LaptopCache.listKnown();
        known = files.length;
        hit = _pickCachedMatch([[files, 'laptop']], title, show || null);
        LaptopCache.listAll().catch(() => {});
      }
    } catch (_) { hit = null; }
    // The live lookup (up to 1.5 s) only when nothing is known yet, e.g. the
    // first launch; otherwise a new title would pay it on every tap.
    if (!hit && !known) {
      try {
        hit = await Promise.race([
          findCachedFileFor(title, show || null),
          new Promise(resolve => setTimeout(() => resolve(null), 1500)),
        ]);
      } catch (_) { hit = null; }
    }
    if (!hit || !hit.id) return false;
    const fileYear = /(?:^|\D)((?:19|20)\d{2})(?:\D|$)/.exec(String(hit.name || ''));
    if (year && fileYear && String(fileYear[1]) !== String(year)) return false;
    playDriveFile(hit.id, title, poster, hit.subtitles || [], show || null);
    return true;
  }

  // YTS-backed movie tile -> one-click playback. Home/search/movie-browser
  // tiles used to open the quality modal and require a second click; the user
  // intent is already unambiguous, so resolve details, choose the best
  // in-budget release (4K first), and enter the normal Seedr+cache pipeline.
  // The modal remains available from explicit Info/detail flows.
  async function playYtsMovieInstant(stub) {
    if (!stub) return;
    const label = stub.title || 'movie';
    // One loading card from the tap until the picture appears; addToQueue's
    // own showLoading takes the same overlay over once the pick is queued.
    showLoading(label, stub.large_cover_image || stub.medium_cover_image || null, null, 'Getting it ready…');
    if (await playLocalCopyIfPresent({ title: stub.title, year: stub.year,
      poster: stub.large_cover_image || stub.medium_cover_image || null })) return;
    let movie = stub;
    const verified = stub._torrent && stub._torrent.hash ? stub._torrent : null;
    try {
      if (!verified && stub.id) {
        const detail = await YTS.detail(stub.id);
        if (detail && detail.movie) movie = detail.movie;
      }
    } catch (_) {}
    const best = verified ? (movie.torrents || []).find(t =>
      String(t.hash).toLowerCase() === String(verified.hash).toLowerCase()) || verified
      : pickBestTorrent(movie.torrents);
    if (!best) {
      hideLoading();
      if ((movie.torrents || []).length) return openMovieModal(movie);
      toast('No suitable file found');
      return;
    }
    return addToQueue({
      name: best.name || `${movie.title_long || movie.title} [${best.quality}]`,
      magnet: YTS.magnet(best, `${movie.title} ${best.quality}`),
      infoHash: best.hash,
      poster: movie.large_cover_image || movie.medium_cover_image || null,
      sizeBytes: best.size_bytes || best.size || 0,
      durationSeconds: (Number(movie.runtime) || 0) * 60,
      autoplay: true,
    });
  }

  // Trending movie click → start playing the best file immediately.
  // FAST PATH: the phone already pre-resolved the best magnet for this title
  // (watchableMap stashed it on it._torrent), so we go straight to seedr with
  // no on-TV search at all. Fallback: resolve on YTS, then the picker/search.
  async function playTmdbMovieInstant(it) {
    if (!it) return;
    const tilePoster = it.poster || it.poster_sm || null;
    showLoading(it.title || 'Loading…', tilePoster, null, 'Getting it ready…');
    // The YTS lookup starts now, alongside the local check; a saved copy wins.
    const lookup = (it._torrent && it._torrent.hash) ? null
      : lookupYtsMovie(it).catch(e => { console.warn('trending movie lookup:', e); return null; });
    if (await playLocalCopyIfPresent({ title: it.title, year: it.year, poster: tilePoster })) return;
    if (it._torrent && it._torrent.hash) {
      const t = it._torrent;
      if ((t.size || 0) > MAX_FILE_BYTES) {
        return downloadToServerAndPlay({
          title: it.title, year: it.year, kind: 'movie',
          poster: it.poster || it.poster_sm || null,
          magnet: ApiBay.magnet({ info_hash: t.hash, name: t.name }),
          infoHash: t.hash, sizeBytes: t.size || 0, name: t.name,
        });
      }
      addToQueue({
        name: t.name || `${it.title}${t.quality ? ' [' + t.quality + ']' : ''}`,
        magnet: ApiBay.magnet({ info_hash: t.hash, name: t.name }),
        infoHash: t.hash,
        poster: it.poster || it.poster_sm || null,
        sizeBytes: t.size || 0,
        autoplay: true,
      });
      return;
    }
    const movie = await lookup;
    const best = movie ? pickBestTorrent(movie.torrents) : null;
    if (!best) {
      hideLoading();
      if (movie && (movie.torrents || []).length) return openMovieModal(movie);  // all over cap → let user choose
      showTab('search');
      selectSearchType('movies', false);
      const si = $('#search-input');
      if (si) {
        si.value = it.title + (it.year ? ` ${it.year}` : '');
        const go = $('#search-go');
        if (go) go.click();
      }
      toast('No suitable file — searching');
      return;
    }
    return addToQueue({
      name: `${movie.title_long || movie.title} [${best.quality}]`,
      magnet: YTS.magnet(best, `${movie.title} ${best.quality}`),
      infoHash: best.hash,
        poster: movie.large_cover_image || movie.medium_cover_image || it.poster || null,
        sizeBytes: best.size_bytes || 0,
        durationSeconds: (Number(movie.runtime) || 0) * 60,
        autoplay: true,
    });
  }

  async function openTmdbMovie(it) {
    toast(`Finding "${it.title}" on YTS…`);
    try {
      const best = await lookupYtsMovie(it);
      if (best) return openMovieModal(best);
    } catch (e) { console.warn('TMDB→YTS lookup:', e); }
    // Fallback: route to Search tab pre-filled
    showTab('search');
    selectSearchType('movies', false);
    const si = $('#search-input');
    if (si) {
      si.value = it.title + (it.year ? ` ${it.year}` : '');
      const go = $('#search-go');
      if (go) go.click();
    }
    toast(`Not on YTS — searching apibay instead`);
  }

  async function openTmdbTv(it) {
    return openTvShow({
      title: it.title, type: 'tv', poster: it.poster || it.poster_sm,
      year: it.year || null, tmdb_id: it.tmdb_id || null,
      imdb: it._imdb || it.imdb || null,
    });
  }

  async function openMovieModal(stub) {
    let movie = stub;
    try {
      const detail = await YTS.detail(stub.id);
      if (detail && detail.movie) movie = detail.movie;
    } catch (_) {}

    const card = $('#modal-card');
    const allTorrents = movie.torrents || [];
    // Show EVERY variant. ≤5 GB → instant seedr stream; >5 GB → "Download to
    // watch later" straight to the pen drive (no size limit).
    const torrents = allTorrents
      .slice()
      .sort((a, b) => (parseInt(b.seeds || 0) - parseInt(a.seeds || 0)));
    const emptyMsg = 'No torrents from YTS — try Search instead.';
    card.innerHTML = `
      <h2>${escapeHtml(movie.title_long || movie.title)}</h2>
      <p style="margin:12px 0;color:#aaa;">${movie.year || ''}${movie.runtime ? ' · ' + movie.runtime + ' min' : ''}${movie.rating ? ' · ' + movie.rating + '★' : ''}</p>
      <p>${escapeHtml(movie.description_full || movie.summary || '')}</p>
      <h3 style="margin-top:24px;font-size:22px;">Select quality</h3>
      <div class="results-list" id="qual-list">
        ${torrents.length === 0 ? `<p style="color:#888;">${emptyMsg}</p>`
          : torrents.map((t, i) => {
              const big = (t.size_bytes || 0) > MAX_FILE_BYTES;
              return `
          <button class="result-row" tabindex="0" data-idx="${i}">
            <div class="result-name">${escapeHtml(t.quality)} · ${escapeHtml(t.type || '')}${t.video_codec ? ' · ' + escapeHtml(t.video_codec) : ''}${big ? ' <span class="wl-badge">⬇ Watch later</span>' : ''}</div>
            <div class="result-meta">${escapeHtml(t.size || fmtSize(t.size_bytes || 0))} · ${t.seeds || 0} seeds${big ? ' · over 5 GB → downloads to pen' : ''}</div>
          </button>`;
            }).join('')}
      </div>
      <div class="modal-actions">
        <button class="btn" id="m-cancel">Cancel</button>
      </div>
    `;
    const modalEl = $('#modal');
    if (!modalEl.classList.contains('is-open')) DPad.pushBackHandler(closeModal);
    modalEl.classList.add('is-open');
    $('#m-cancel').onclick = closeModal;
    $$('#qual-list .result-row').forEach((row, i) => {
      row.onclick = () => {
        closeModal();
        const t = torrents[i];
        const big = (t.size_bytes || 0) > MAX_FILE_BYTES;
        const common = {
          name: `${movie.title_long || movie.title} [${t.quality}]`,
          magnet: YTS.magnet(t, `${movie.title} ${t.quality}`),
          infoHash: t.hash,
          poster: movie.large_cover_image || movie.medium_cover_image,
          sizeBytes: t.size_bytes || 0,
          durationSeconds: (Number(movie.runtime) || 0) * 60,
        };
        if (big) downloadToServerAndPlay({ ...common, title: movie.title, year: movie.year, kind: 'movie' });
        else     addToQueue({ ...common, autoplay: true });
      };
    });
    setTimeout(() => {
      const first = $('#qual-list .result-row');
      if (first) DPad.focus(first); else DPad.focus($('#m-cancel'));
    }, 50);
  }

  function closeModal() {
    const modalEl = $('#modal');
    if (!modalEl.classList.contains('is-open')) return;
    modalEl.classList.remove('is-open');
    DPad.popBackHandler();
  }

  // ---------- Search ----------
  // Recent searches live in localStorage so the user doesn't have to retype
  // common queries every session. On a TV remote without a hardware keyboard,
  // re-typing is painful — surfacing the last 12 queries as clickable chips
  // gives a one-click recall.
  const SEARCH_HISTORY_MAX = 12;
  function pushSearchHistory(q) {
    const norm = q.trim();
    if (!norm) return;
    let hist = Storage.get('searchHistory', []);
    hist = hist.filter(h => h.toLowerCase() !== norm.toLowerCase());
    hist.unshift(norm);
    if (hist.length > SEARCH_HISTORY_MAX) hist = hist.slice(0, SEARCH_HISTORY_MAX);
    Storage.set('searchHistory', hist);
  }

  function renderSearchTab() {
    const results = $('#search-results');
    // Don't clobber an existing result set — only paint the empty state when
    // the user is starting fresh.
    if (results.querySelector('.tile, .result-row')) return;
    const input = $('#search-input');
    const q = input ? input.value.trim() : '';
    if (q) return;
    const hist = Storage.get('searchHistory', []);
    if (!hist.length) {
      results.innerHTML = `
        <div class="search-empty">
          <h3 class="search-empty-title">Find anything to watch</h3>
          <p class="search-empty-body">
            Try a movie, show, or actor — DumiFlix searches YTS, then the open
            torrent index, and queues whatever has the most seeders.
          </p>
        </div>`;
      return;
    }
    results.innerHTML = `
      <div class="search-empty">
        <div class="search-empty-label">Recent searches</div>
        <div class="chips" id="search-history">
          ${hist.map(h => `<button class="chip" data-q="${escapeHtml(h)}">${escapeHtml(h)}</button>`).join('')}
        </div>
      </div>`;
    $$('#search-history .chip').forEach(c => {
      c.onclick = () => {
        const v = c.dataset.q || '';
        $('#search-input').value = v;
        runSearch();
      };
    });
  }

  // The user picks Movies or TV Shows before searching — we route to the
  // right backend (YTS for movie metadata, apibay for episode-level
  // torrents). Searching both at once meant TV groupings were polluted by
  // YTS's broad title matches and movie tiles drowned the show tiles.
  let _searchType = 'movies';

  // Change the search backend without accidentally running the text left by a
  // previous search. Home hero fallbacks call this before replacing the query;
  // clicking a chip calls it with `runCurrent=true` for the familiar live
  // Movies/TV switch. Keeping this in one place also keeps chip state and the
  // input's accessible label in sync.
  function selectSearchType(type, runCurrent = true) {
    _searchType = type === 'tv' ? 'tv' : 'movies';
    $$('#search-type .chip').forEach(c => {
      c.classList.toggle('is-active', c.dataset.type === _searchType);
    });
    const input = $('#search-input');
    if (input) input.placeholder = _searchType === 'tv' ? 'Search TV shows' : 'Search movies';
    if (runCurrent && input && input.value.trim()) runSearch();
  }

  // Music tab chips. The "YouTube Music" entry opens the in-app YT Music
  // IFrame Player. We seed it from the user's saved "favorite query"
  // (Settings → YT Music) or fall back to a generic shuffle search so the
  // user always lands on _something_ playable.
  function bindMusicChips() {
    const chip = $('#ytmusic-chip');
    if (!chip) return;
    chip.onclick = async () => {
      const query = (Storage.get('ytm_default_query', '') || '').trim()
                 || 'popular music shuffle';
      toast('Searching YouTube Music…');
      let tracks = [];
      try {
        tracks = await YTMusic.search(query);
      } catch (e) {
        toast('YT Music: ' + (e.message || String(e)));
        return;
      }
      if (!tracks.length) { toast('No results for "' + query + '"'); return; }
      // Shuffle so re-clicking the chip doesn't replay the same song.
      for (let i = tracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
      }
      YTPlayer.open(tracks);
    };
  }

  function bindSearchTypeChips() {
    const chips = $$('#search-type .chip');
    chips.forEach(c => {
      c.onclick = () => selectSearchType(c.dataset.type, true);
    });
  }

  const _RE_RUTRACKER = /rutracker/i;
  async function runSearchMovies(q, results) {
    let movies = [];
    try {
      const yts = await YTS.search(q, { limit: 30 });
      movies = (yts && yts.movies) || [];
    } catch (e) { movies = []; }
    if (movies.length) {
      const frag = document.createDocumentFragment();
      movies.forEach(m => {
        frag.appendChild(makeTile({
          title: m.title, subtitle: `${m.year} · ${m.rating}★`,
          poster: m.medium_cover_image, onClick: () => playYtsMovieInstant(m),
        }));
      });
      results.appendChild(frag);
      return movies.length;
    }
    // YTS returned nothing (down, or the film isn't in YTS's library) →
    // Knaben meta-search. These rows are raw torrents (not YTS stubs), so
    // clicking queues the top-seeded pick directly.
    if (typeof Knaben === 'undefined') return 0;
    let rows = [];
    try { rows = await Knaben.search(q); } catch (_) {}
    // Collapse to one tile per movie title (best-seeded release per title),
    // so the grid shows films, not 40 near-duplicate releases. RuTracker's
    // "Russian / English [year, cast…]" titles don't parse into a clean film
    // name, so they're skipped for the DISPLAY grid — their magnets still
    // flow through the raw next-episode / direct-queue paths.
    const byTitle = new Map();
    for (const r of rows) {
      if (_RE_RUTRACKER.test(r._tracker || '')) continue;
      if ((parseInt(r.size || 0, 10) || 0) > MAX_FILE_BYTES) continue;
      if ((parseInt(r.seeders || 0, 10) || 0) <= 0) continue;
      const key = _normShow(cleanTorrentTitle(r.name)) || r.info_hash;
      const prev = byTitle.get(key);
      const q4 = _RE_IS_4K.test(r.name || '') ? 1 : 0;
      const p4 = prev && _RE_IS_4K.test(prev.name || '') ? 1 : 0;
      if (!prev || q4 > p4 || (q4 === p4 && r.seeders > prev.seeders)) byTitle.set(key, r);
    }
    const picks = [...byTitle.values()].sort((a, b) => b.seeders - a.seeders).slice(0, 24);
    if (picks.length) {
      const frag = document.createDocumentFragment();
      picks.forEach(r => {
        frag.appendChild(makeTile({
          title: cleanTorrentTitle(r.name),
          subtitle: `${fmtSize(r.size)} · ${r.seeders.toLocaleString()} seeds`,
          poster: null,
          onClick: () => addToQueue({
            name: r.name, magnet: ApiBay.magnet(r), infoHash: r.info_hash,
            poster: null, sizeBytes: r.size || 0, autoplay: true,
          }),
        }));
      });
      results.appendChild(frag);
    }
    return picks.length;
  }

  // Strip torrent decoration (year, quality, codec, group) down to a display
  // title for grouping Knaben's raw movie rows into per-film tiles.
  const _RE_TORRENT_NOISE = /\b(19|20)\d\d\b|\b(2160p|1080p|720p|480p|4k|uhd|bluray|brrip|bdrip|web[\s._-]?dl|webrip|hdtv|x264|x265|hevc|h\.?264|h\.?265)\b/i;
  const _RE_TITLE_PUNCT1 = /[._]+/g;
  const _RE_TITLE_PUNCT2 = /[\[\](){}]/g;
  const _RE_TITLE_SPACE = /\s+/g;
  function cleanTorrentTitle(name) {
    let s = String(name || '');
    // RuTracker rows are "Russian title / English title [year, country, ...]".
    // Keep the segment with the most Latin letters (the English one).
    if (s.includes(' / ')) {
      s = s.split(' / ')
        .map(seg => ({ seg, latin: (seg.match(/[A-Za-z]/g) || []).length }))
        .sort((a, b) => b.latin - a.latin)[0].seg;
    }
    // Cut at the first "noise" token — year or a quality/source tag — keeping
    // the leading title words.
    const cut = s.search(_RE_TORRENT_NOISE);
    if (cut > 3) s = s.slice(0, cut);
    return s.replace(_RE_TITLE_PUNCT1, ' ').replace(_RE_TITLE_PUNCT2, ' ').replace(_RE_TITLE_SPACE, ' ').trim()
            || String(name || '').slice(0, 40);
  }

  async function runSearchTv(q, results) {
    let torrents = [];
    try { torrents = await ApiBay.search(q); } catch (_) {}
    // apibay down / empty → Knaben meta-search (1337x + TPB + others) as a
    // seeded fallback so TV search still returns shows.
    if (!torrents.length && typeof Knaben !== 'undefined') {
      try { torrents = await Knaben.search(q, { maxBytes: MAX_FILE_BYTES }); } catch (_) {}
    }

    // Group by inferred show name. Skip rows where we can't infer one
    // (those are either movies or torrents with weird unparseable
    // filenames — the user picked TV mode, so show TV-only).
    // Oversized torrents are excluded from the count too, otherwise a show
    // tile would advertise "20 torrents" but only 2 are actually downloadable.
    const byShow = new Map();
    for (const t of torrents) {
      if (!t.info_hash || parseInt(t.seeders || 0, 10) <= 0) continue;
      if (parseInt(t.size || 0, 10) > MAX_FILE_BYTES) continue;
      const inf = inferShowFromTitle(t.name);
      if (!inf || !inf.title) continue;
      const key = _normShow(inf.title);
      if (!key) continue;
      const e = byShow.get(key) || { title: inf.title, count: 0, seeders: 0 };
      e.count += 1;
      e.seeders += parseInt(t.seeders || 0, 10);
      byShow.set(key, e);
    }
    let shows = [...byShow.values()].sort((a, b) => b.seeders - a.seeders);

    // apibay returned nothing (down / Cloudflare-gated) — resolve shows via
    // TVMaze instead so search still works. Clicking a tile opens the picker,
    // which falls back to EZTV (keyed by the imdb we stash here).
    if (!shows.length) {
      try {
        const hits = await TVMaze.searchShows(q, 8);
        shows = (hits || []).map(h => ({
          title: h.name, imdb: h.imdb_id, poster: h.image || null,
          country: h.country || '', year: (h.premiered || '').slice(0, 4),
          count: 0, seeders: 0, viaTvmaze: true,
        }));
      } catch (_) {}
    }

    const frag = document.createDocumentFragment();
    shows.forEach(show => {
      const sub = show.viaTvmaze
        ? `TV series${show.country ? ' · ' + show.country : ''}${show.year ? ' · ' + show.year : ''}`
        : `TV series · ${show.count} torrent${show.count === 1 ? '' : 's'} · ${show.seeders.toLocaleString()} seeds`;
      const tile = makeTile({
        title: show.title,
        subtitle: sub,
        poster: show.poster || null,
        onClick: () => openTvShow({
          title: show.title, type: 'tv', imdb: show.imdb || null, year: show.year || null,
        }),
      });
      Trending.poster(show.title, '', 'tv').then(url => {
        if (!url || !document.contains(tile)) return;
        const fb = tile.querySelector('.tile-fallback');
        if (fb) fb.remove();
        let p = tile.querySelector('.tile-poster');
        if (!p) {
          p = document.createElement('div');
          p.className = 'tile-poster';
          tile.insertBefore(p, tile.firstChild);
        }
        p.style.backgroundImage = `url("${url}")`;
      }).catch(() => {});
      frag.appendChild(tile);
    });
    results.appendChild(frag);
    return shows.length;
  }

  async function runSearch() {
    const q = $('#search-input').value.trim();
    if (!q) return;
    hideSuggest();
    pushSearchHistory(q);
    pill('Searching…');
    const results = $('#search-results');
    unobserveTilePosters(results);
    results.innerHTML = '';

    let n;
    if (_searchType === 'tv') {
      n = await runSearchTv(q, results);
      pill(n ? `${n} show${n === 1 ? '' : 's'}` : 'No TV shows found');
    } else {
      n = await runSearchMovies(q, results);
      pill(n ? `${n} movies` : 'No movies found');
    }

    setTimeout(() => {
      const first = $('#search-results > *');
      if (first) DPad.focus(first);
    }, 50);
  }

  // ---------- Search typeahead suggestions ----------
  // One debounced, session-cached IMDb-suggestion request per pause in typing —
  // deliberately light on the API. Suggestions are just a shortcut: picking one
  // fills the query, switches Movies/TV to match, and runs the REAL torrent
  // search (that's the only call that hits apibay/YTS/Knaben).
  let _suggestTimer = null;
  let _suggestSeq = 0;
  function hideSuggest() {
    const box = $('#search-suggest');
    if (box) { box.hidden = true; box.innerHTML = ''; }
  }
  async function renderSuggest(q) {
    const box = $('#search-suggest');
    if (!box || typeof Trending === 'undefined' || !Trending.suggest) return;
    q = (q || '').trim();
    if (q.length < 2) { hideSuggest(); return; }
    const seq = ++_suggestSeq;
    let items = [];
    try { items = await Trending.suggest(q); } catch (_) { items = []; }
    if (seq !== _suggestSeq) return;                        // superseded by a newer keystroke
    if (($('#search-input').value || '').trim() !== q) return;  // input moved on
    if (!items.length) { hideSuggest(); return; }
    const frag = document.createDocumentFragment();
    items.forEach(it => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'suggest-row';
      const badge = it.type === 'tv' ? 'TV' : 'Movie';
      const sub = [it.year, it.cast].filter(Boolean).join(' · ');
      row.innerHTML =
        `<span class="suggest-poster" style="${it.poster ? `background-image:url('${it.poster}')` : ''}"></span>`
        + `<span class="suggest-meta"><span class="suggest-title">${escapeHtml(it.title)}</span>`
        + `${sub ? `<span class="suggest-sub">${escapeHtml(sub)}</span>` : ''}</span>`
        + `<span class="suggest-badge">${badge}</span>`;
      row.onclick = () => pickSuggestion(it);
      frag.appendChild(row);
    });
    box.innerHTML = '';
    box.appendChild(frag);
    box.hidden = false;
  }
  function pickSuggestion(it) {
    hideSuggest();
    const input = $('#search-input');
    if (input) input.value = it.title;
    // Flip Movies/TV to match the suggestion so the right backend runs.
    const wantType = it.type === 'tv' ? 'tv' : 'movies';
    if (_searchType !== wantType) selectSearchType(wantType, false);
    runSearch();
  }
  function onSearchInput() {
    const q = ($('#search-input').value || '').trim();
    clearTimeout(_suggestTimer);
    if (q.length < 2) { hideSuggest(); return; }
    // Debounce: one request after the user pauses, never per keystroke.
    _suggestTimer = setTimeout(() => renderSuggest(q), 280);
  }

  // ---------- Movies tab (YTS browse with sort/genre/rating filters) ----------
  function bindMoviesChips() {
    const sortChips = $$('#movies-sort .chip');
    sortChips.forEach(c => c.onclick = () => {
      sortChips.forEach(x => x.classList.toggle('is-active', x === c));
      moviesState.sort = c.dataset.sort;
      loadMovies(true);
    });
    const genreChips = $$('#movies-genre .chip');
    genreChips.forEach(c => c.onclick = () => {
      genreChips.forEach(x => x.classList.toggle('is-active', x === c));
      moviesState.genre = c.dataset.genre;
      loadMovies(true);
    });
    const ratingChips = $$('#movies-rating .chip');
    ratingChips.forEach(c => c.onclick = () => {
      ratingChips.forEach(x => x.classList.toggle('is-active', x === c));
      moviesState.minRating = parseInt(c.dataset.rating, 10) || 0;
      loadMovies(true);
    });
    const qInput = $('#movies-q');
    const qBtn = $('#movies-search-btn');
    qInput.addEventListener('input', (e) => {
      clearTimeout(moviesSearchTimer);
      moviesSearchTimer = setTimeout(() => {
        moviesState.query = e.target.value.trim();
        qBtn.textContent = moviesState.query
          ? `Search: ${moviesState.query}`
          : 'Search…';
        loadMovies(true);
      }, 350);
    });
    qInput.addEventListener('blur', () => {
      // Hide the input again so D-pad navigation can't land on it and
      // accidentally re-summon the on-screen keyboard.
      qInput.style.display = 'none';
      qBtn.style.display = '';
      DPad.focus(qBtn);
    });
    qInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); qInput.blur(); }
    });
    qBtn.addEventListener('click', () => {
      qBtn.style.display = 'none';
      qInput.style.display = '';
      qInput.tabIndex = 0;
      qInput.value = moviesState.query || '';
      qInput.focus();
    });
    $('#movies-more').onclick = () => {
      moviesState.page += 1;
      loadMovies(false);
    };
  }

  let _moviesReq = 0;
  async function loadMovies(reset) {
    // Each call gets a serial. Fast filter changes (sort → genre → rating in
    // 300ms) all start their own loadMovies; if a slower fetch resolves AFTER
    // a faster one with newer filters, we drop it on the floor instead of
    // overwriting the grid with stale results.
    const req = ++_moviesReq;
    if (reset) { moviesState.page = 1; moviesTotal = 0; }
    const grid = $('#movies-grid');
    const statusEl = $('#movies-status');
    const moreBtn = $('#movies-more');
    if (reset) { unobserveTilePosters(grid); grid.innerHTML = ''; }
    statusEl.textContent = 'Loading…';
    moreBtn.style.display = 'none';

    const cacheKey = JSON.stringify(moviesState);
    let r;
    const cached = moviesBrowseCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 600_000) {
      r = cached.data;
    } else {
      try {
        r = await YTS.browse({
          sort: moviesState.sort,
          genre: moviesState.genre,
          minRating: moviesState.minRating,
          query: moviesState.query,
          page: moviesState.page,
          limit: 30,
        });
        moviesBrowseCache.set(cacheKey, { at: Date.now(), data: r });
        // Bound the browse cache — a long browsing session otherwise retains
        // every sort/genre/query/page result (each a full 30-item page) for the
        // life of the session. Keep the ~24 most-recent by timestamp.
        if (moviesBrowseCache.size > 24) {
          const entries = [...moviesBrowseCache.entries()].sort((a, b) => a[1].at - b[1].at);
          for (let i = 0; i < entries.length - 24; i++) moviesBrowseCache.delete(entries[i][0]);
        }
      } catch (e) {
        if (req !== _moviesReq) return;     // a newer call superseded us
        statusEl.textContent = 'YTS unreachable: ' + e.message;
        return;
      }
    }
    if (req !== _moviesReq) return;          // newer call wins
    moviesInited = true;
    const movies = (r && r.movies) || [];
    moviesTotal = (r && r.total) || movies.length;
    if (!movies.length) {
      statusEl.textContent = (moviesState.page === 1)
        ? 'No movies match those filters.'
        : 'No more results.';
      return;
    }
    statusEl.textContent = '';
    const frag = document.createDocumentFragment();
    movies.forEach(m => frag.appendChild(makeMovieTile(m)));
    grid.appendChild(frag);
    if (moviesTotal > moviesState.page * 30) {
      moreBtn.style.display = 'inline-block';
    }
    setTimeout(() => {
      const first = $('#movies-grid > *');
      if (first && reset) DPad.focus(first);
    }, 50);
  }

  function makeMovieTile(m) {
    const t = document.createElement('button');
    t.className = 'tile';
    t.tabIndex = 0;
    if (m.title) t.dataset.heroTitle = m.title;
    {
      const sub = [m.year, m.runtime ? `${m.runtime}m` : null,
                   m.rating ? `${m.rating}★` : null].filter(Boolean).join(' · ');
      if (sub) t.dataset.heroSubtitle = sub;
    }
    if (m.medium_cover_image) {
      const img = document.createElement('div');
      img.className = 'tile-poster';
      img.style.backgroundImage = `url("${m.medium_cover_image}")`;
      t.appendChild(img);
    } else {
      const fb = document.createElement('div');
      fb.className = 'tile-fallback';
      fb.textContent = m.title;
      t.appendChild(fb);
    }
    if (m.rating) {
      const badge = document.createElement('div');
      badge.className = 'tile-badge';
      badge.textContent = `★ ${m.rating}`;
      t.appendChild(badge);
    }
    const meta = document.createElement('div');
    meta.className = 'tile-meta';
    const sub = [m.year, m.runtime ? `${m.runtime}m` : null].filter(Boolean).join(' · ');
    meta.innerHTML = `<div>${escapeHtml(m.title)}</div><div style="opacity:.7;font-size:14px;">${escapeHtml(sub)}</div>`;
    t.appendChild(meta);
    t.onclick = () => playYtsMovieInstant(m);
    return t;
  }

  // ---------- Queue ----------
  // Add a torrent: push the magnet to seedr first, then start the watcher only
  // if seedr accepted it. Doing addMagnet AFTER startWatch races: the watcher
  // polls seedr, sees nothing, and reports "queued" indefinitely while the
  // addMagnet POST is still in flight. Worse, an addMagnet failure used to
  // surface only as a toast — the queue row sat stuck at 0% with no recovery.

  // Coalesce rapid-fire progress ticks into at most one #queue-list rebuild
  // per animation frame. renderQueue() rebuilds the entire list's innerHTML
  // from scratch (fresh nodes + onclick handlers per row); Drive/cache
  // uploadFromUrl ticks can fire many times a second per byte-chunk over the
  // Luna bridge, and repeating a full rebuild that often is wasted CPU/GPU
  // work on a low-end TV renderer for a bar that only needs to look smooth,
  // not frame-accurate. Trailing-edge only — never drops the final state,
  // just spaces the DOM churn out to the display's own refresh cadence.
  let _queueRenderScheduled = false;
  function scheduleRenderQueue() {
    if (_queueRenderScheduled) return;
    _queueRenderScheduled = true;
    requestAnimationFrame(() => { _queueRenderScheduled = false; renderQueue(); });
  }

  async function addToQueue({ name, magnet, infoHash, poster, show, sizeBytes, durationSeconds, autoplay, priority, _resume }) {
    if (!Seedr.isLoggedIn()) {
      toast('Sign in to seedr first (Settings)');
      showTab('settings'); return;
    }
    // Defense-in-depth: surface filters (movie modal, episode picker, search,
    // next-episode auto-queue) all drop rows over MAX_FILE_BYTES, but if any
    // path ever forgets to pass through one of them, seedr will silently
    // refuse the magnet on its side and the row will sit at 0% forever.
    // Reject here with a clear toast so the user sees why and the queue
    // never accumulates undownloadable items.
    const sz = parseInt(sizeBytes || 0, 10) || 0;
    if (sz > MAX_FILE_BYTES) {
      toast(`Skipped: ${name} is ${fmtSize(sz)} — over the 5 GB seedr limit`);
      return;
    }
    const hash = (infoHash || '').toLowerCase();
    // Removed-title guard: a deliberate user pick (autoplay) OVERRIDES an earlier
    // removal — clear the blocklist so it downloads and plays. A background/auto
    // add (autoplay=false: next-episode prefetch, self-heal, etc.) of a removed
    // title is honoured as removed and dropped.
    if (autoplay) {
      unmarkRemoved({ hash, title: name });
    } else if (isRemoved({ hash, title: name })) {
      return;
    }
    // Only dedupe for background auto-queues. A user pick (autoplay) must
    // ALWAYS play fresh — never short-circuit to a stale same-hash item still
    // sitting in the queue from a previous watch. The autoplay wipe below
    // clears the queue anyway, so there's nothing to collide with.
    if (hash && !autoplay) {
      const existing = queue.find(q => (q.infoHash || '').toLowerCase() === hash);
      if (existing) {
        toast(`Already in queue: ${existing.name}`);
        showTab('queue');
        return;
      }
    }
    // Auto-priority: if the user explicitly picked something (autoplay)
    // and the queue isn't empty, wipe everything so the new pick goes
    // straight to the active seedr slot instead of waiting behind items
    // the user is no longer interested in. We DON'T wipe for background
    // next-episode auto-queues (autoplay=false) — those should respect
    // the existing queue and just append.
    if (autoplay && (queue.length > 0 || seedrSlotBusy(null))) {
      await wipeQueueAndSeedr(null, true);   // silent — the loading overlay is the feedback
    } else if (!autoplay && priority && seedrSlotBusy(null)) {
      // Priority next-episode prefetch: the episode you're about to watch beats
      // whatever's parked in seedr, so wipe to free the slot and fetch it NOW
      // instead of waiting behind other items. The wipe copies any half-watched
      // seedr item to the pen first, and the caller only sets priority when the
      // current stream ISN'T seedr — so nothing you're using is lost.
      await wipeQueueAndSeedr(`Prioritising next episode: ${name}`, true);
    } else if (!autoplay && seedrSlotBusy(null)) {
      // Non-priority background auto-queue: slot busy, so just park as pending —
      // the existing promoteNextPending() chain picks it up when the active
      // item drains.
    }

    const id = `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const item = {
      id, name, magnet, infoHash: hash, poster, show,
      pct: 0, speed: 0, total: sz,
      durationSeconds: Number(durationSeconds) || 0,
      phase: 'adding',
      addedAt: Date.now(),
      autoplay: !!autoplay,
      // Continue-Watching self-heal: saved {position,duration} to reapply once
      // this re-fetched file plays under its new fileId (see openPlayer).
      _resume: _resume || null,
    };
    queue.push(item);
    persistQueue();
    if (autoplay) showLoading(name, poster, id);   // loading overlay, not the Queue tab
    else toast(`Added: ${name}`);
    renderQueue();
    // Background auto-queue, slot still occupied → park as pending. The
    // user-click AND priority-prefetch paths can't hit this branch because they
    // already wiped the slot free above.
    if (!autoplay && !priority && seedrSlotBusy(id)) {
      item.phase = 'pending';
      persistQueue();
      renderQueue();
      return;
    }
    try {
      await Seedr.addMagnet(magnet);
    } catch (e) {
      // Seedr rejected the magnet — most often a quota/full-folder error.
      // Wipe and try ONCE more so a user pick is never blocked by stale
      // server-side state we couldn't see from the client.
      console.warn('Seedr.addMagnet failed, wiping + retry once:', e);
      try {
        // Blocking: seedr must be truly empty for the retry, so wait for any
        // half-watched files to finish copying to the pen before the clean.
        // The loading overlay narrates the save so the extra wait reads as
        // deliberate, not stuck.
        await wipeQueueAndSeedr(`Seedr was full — wiped for: ${name}`, false, {
          blocking: true,
          onProgress: (pct) => {
            try {
              const el = $('#dumi-load-status');
              if (el) el.textContent = `Saving your last video to the pen first… ${pct.toFixed(0)}%`;
            } catch (_) {}
          },
        });
      } catch (_) {}
      // The wipe cleared `queue` (including our item). Re-push it now.
      if (!queue.find(q => q.id === id)) queue.push(item);
      persistQueue();
      renderQueue();
      try {
        await Seedr.addMagnet(magnet);
      } catch (e2) {
        const idx = queue.findIndex(q => q.id === id);
        if (idx >= 0) queue.splice(idx, 1);
        persistQueue();
        renderQueue();
        if (_loadingFor === item.id) hideLoading();
        toast('Add failed: ' + (e2.message || e2));
        return;
      }
    }
    item.phase = 'seedring';
    persistQueue();
    startWatch(item);
  }

  // Is some OTHER queue item currently occupying seedr's single active-
  // download slot? `excludeId` lets us skip the just-added item so the
  // check looks at everyone else.
  function seedrSlotBusy(excludeId) {
    return queue.some(q =>
      q.id !== excludeId &&
      (q.phase === 'seedring' || q.phase === 'adding'));
  }

  // Walk the queue, find the oldest pending item, send its magnet to seedr.
  // Idempotent — if something's already active, no-op. Called from every
  // transition that frees the seedr slot: a download finishing, a queue
  // removal, an add-magnet failure.
  function promoteNextPending() {
    if (!Seedr.isLoggedIn()) return;
    if (seedrSlotBusy(null)) return;
    const next = queue.find(q => q.phase === 'pending');
    if (!next) return;
    next.phase = 'adding';
    persistQueue();
    renderQueue();
    Seedr.addMagnet(next.magnet)
      .then(() => {
        next.phase = 'seedring';
        persistQueue();
        renderQueue();
        startWatch(next);
      })
      .catch(async (e) => {
        // Seedr full/erroring — the user's next episode takes priority. Seedr
        // is just a staging area (cache/Drive copies persist), so free its
        // other folders and retry. We KEEP the folder currently streaming so a
        // live seedr playback isn't yanked.
        console.warn('promote addMagnet failed — freeing seedr + retry:', e);
        try {
          const keep = (currentVideo && currentVideo.source === 'seedr' &&
                        currentVideo._queueItem) ? currentVideo._queueItem.folderId : null;
          // Folders mid-copy to the pen (KeepWatching) must survive too, and so
          // must folders still being copied to the cache (videos or subtitles):
          // deleting one breaks the copy even when playback is already local.
          const kwKeep = new Set(_keepWatchPending ? _keepWatchPending.folderIds : []);
          queue.forEach(q => {
            if (q.folderId && (q._cacheCopiesPending || q.phase === 'copying' || q.phase === 'cooldown')) {
              kwKeep.add(q.folderId);
            }
          });
          const toDelete = queue
            .filter(q => q.id !== next.id && q.folderId && q.folderId !== keep
                      && !kwKeep.has(q.folderId))
            .map(q => q.folderId);
          if (toDelete.length) {
            await Seedr.deleteItems({ folder_ids: toDelete }).catch(() => {});
            queue.forEach(q => {
              if (q.folderId && q.folderId !== keep && q.id !== next.id
                  && !kwKeep.has(q.folderId)) q.folderId = null;
            });
            persistQueue();
          } else if (!keep) {
            await Seedr.clean([...kwKeep]).catch(() => {});   // keep only mid-copy folders
          }
          await Seedr.addMagnet(next.magnet);
          next.phase = 'seedring';
          persistQueue(); renderQueue();
          startWatch(next);
          return;
        } catch (e2) {
          const idx = queue.findIndex(q => q.id === next.id);
          if (idx >= 0) queue.splice(idx, 1);
          persistQueue();
          renderQueue();
          if (_loadingFor === next.id) hideLoading();
          toast(`Add failed: ${next.name} — ${e2.message || e2}`);
          promoteNextPending();
        }
      });
  }

  // Torrent hashes that never took on seedr (dead / no seeders). We skip these
  // when re-resolving an episode so recovery doesn't re-pick the same dead file.
  const _deadSeedrHashes = new Set();

  // A queued item's seedr download never materialised (see Seedr.watch stall).
  // Drop the phantom entry and try to recover: for an episode, re-resolve a
  // DIFFERENT release (dead hash excluded) and re-queue it, carrying the same
  // autoplay intent so it still opens when ready. Bounded to avoid a loop.
  async function handleSeedrStall(item) {
    const wantAutoplay = !!item.autoplay;
    const show = item.show;
    const deadHash = (item.infoHash || '').toLowerCase();
    if (deadHash) _deadSeedrHashes.add(deadHash);
    const retries = item._stallRetries || 0;
    // Remove the phantom queue entry.
    const idx = queue.findIndex(q => q.id === item.id);
    if (idx >= 0) { queue.splice(idx, 1); persistQueue(); renderQueue(); }
    const giveUp = (msg) => {
      if (wantAutoplay) { hideLoading(); toast(msg); }
      promoteNextPending();
    };
    if (retries >= 2 || !show || !show.season || !show.episode) {
      giveUp('That download stalled on seedr — no seeders. Try again.');
      return;
    }
    // Re-resolve the SAME episode from the trackers (findNextEpisodeQueueable now
    // skips dead hashes) and re-queue a fresh release.
    let found = null;
    try { found = await findNextEpisodeQueueable(show, { season: show.season, episode: show.episode }); }
    catch (_) {}
    if (found && found.add && !_deadSeedrHashes.has((found.add.infoHash || '').toLowerCase())) {
      const fresh = { ...found.add, autoplay: wantAutoplay };
      addToQueue(fresh);
      // Tag the just-pushed item so a repeat stall counts toward the cap.
      const q = queue[queue.length - 1];
      if (q) q._stallRetries = retries + 1;
      persistQueue();
      return;
    }
    giveUp('Couldn’t find a working release for that episode.');
  }

  function startWatch(item) {
    if (activeWatchers[item.id]) activeWatchers[item.id]();
    activeWatchers[item.id] = Seedr.watch(item.infoHash, item.name, (u) => {
      if (u.stalled) {
        try { activeWatchers[item.id](); } catch (_) {}
        delete activeWatchers[item.id];
        handleSeedrStall(item);
        return;
      }
      if (u.error) { item.error = u.error; renderQueue(); loadingTick(item); return; }
      if (u.active) {
        const pct = u.pct || 0, speed = u.speed || 0, total = u.total || 0, queued = !!u.queued;
        // Seedr's poll (every ~2.5s) repeats identical values during its
        // hysteresis window (see Seedr.watch's `seenActive` fallback) —
        // skip the full queue-list rebuild when nothing actually changed.
        const unchanged = item.phase === 'seedring' && !item.error &&
          item.pct === pct && item.speed === speed && item.total === total && item.queued === queued;
        item.phase = 'seedring';
        item.pct = pct;
        item.speed = speed;
        item.total = total;
        item.queued = queued;
        if (item.error) item.error = null;
        if (!unchanged) { renderQueue(); loadingTick(item); }
        return;
      }
      item.folderId = u.folder.id;
      item.folderName = u.folder.name;
      item.phase = 'seedred';
      item.pct = 100;   // seedr download finished — close the bar (it often
                        // vanishes from the active list a tick before 100%)
      item.queued = false;
      item.error = null;
      persistQueue();
      renderQueue();
      loadingTick(item);
      delete activeWatchers[item.id];
      // Seedr's download slot is now free — kick off the next pending
      // magnet (if any). Drive upload runs in parallel; that doesn't share
      // the seedr download slot.
      promoteNextPending();
      // Decide whether to play immediately (small single-file → seedr
      // play + parallel Drive upload) or queue Drive upload first
      // (large single-file → upload, then play from Drive). Pack flow
      // unchanged. Async — runs to completion in the background.
      decidePlayPath(item).catch((e) => {
        item.error = String(e && e.message || e);
        renderQueue();
      });
    });
  }

  // Threshold below which a single-file torrent is small enough to fit
  // alongside a queued next episode in seedr's free quota — at that size
  // we play immediately and upload to Drive concurrently. Above this, we
  // serialise: upload first, then play from Drive, then fetch next.
  const SEEDR_PLAY_NOW_BYTES = 2 * 1024 * 1024 * 1024;

  // Called when a queue item transitions from seedring to seedred. Walks
  // the folder once, picks the play strategy based on file count + size,
  // dispatches: instant-play (≤2 GB single-file), upload-first (>2 GB
  // single-file), or the existing pack flow (multi-file).
  async function decidePlayPath(item) {
    if (!item.folderId) return;
    let files;
    try { files = await Seedr.walkFolder(item.folderId); }
    catch (_) {
      // Soft-fail: fall back to the existing copy flow which itself walks
      // the folder. The user still gets their content; just no auto-play.
      resumeUpload(item);
      return;
    }
    const videos = files.filter(f => /\.(mp4|mkv|mov|m4v|webm|avi|mpg|mpeg)$/i.test(f.name));
    if (videos.length === 0) {
      item.phase = 'error';
      item.error = 'no video files in seedr folder';
      persistQueue(); renderQueue(); loadingTick(item);
      return;
    }

    // Play IMMEDIATELY from seedr the moment the download finishes — regardless
    // of size or file count. Never wait on a cache/Drive upload and bury the
    // file in Library. The background upload (resumeUpload) still runs so the
    // file persists on the phone + the seedr slot frees for the next episode.
    // For a pack, honour the requested episode; otherwise play the largest
    // video. playFromSeedrItem no-ops for non-autoplay (prefetched) items,
    // so those just cache silently.
    // `wasUserInitiated` is captured before playFromSeedrItem clears autoplay:
    // only the user's pick chains to the next episode here (auto-queued
    // siblings chain via the player's 50%-watched trigger instead).
    const main = pickSeedrVideo(item, videos);
    if (!main) {
      item.phase = 'error';
      item.error = 'requested episode not found in seedr folder';
      persistQueue(); renderQueue(); loadingTick(item);
      return;
    }
    const wasUserInitiated = !!item.autoplay;
    // Playback and persistence have no ordering dependency once Seedr has the
    // completed file. Start both immediately: the TV probes/opens the Seedr
    // stream while the laptop simultaneously begins its permanent cache copy.
    // Previously `await playFromSeedrItem()` delayed the cache until all URL
    // mint/remux work finished (or stalled), defeating mid-play takeover.
    const playP = playFromSeedrItem(item, main, () => _openReqSeq);
    resumeUpload(item);
    await playP;
    if (wasUserInitiated && item.show && item.show.season) {
      autoQueueNextEpisode(item).catch(() => {});
    }
  }

  // Seedr-folder sibling-subtitle search, as a Promise that NEVER rejects.
  // This is the walkFolder + fetch/decode round trip the latency trace
  // flagged as pure additive latency when it ran sequentially before play —
  // callers now fire this once and hand the returned Promise straight to
  // openPlayer's meta.subtitle, which resolves it lazily in its own
  // post-play IIFE instead of gating play on it.
  function _seedrSiblingSubtitle(folderId, filename, show) {
    const subs = files => files.filter(f => /\.(srt|vtt|ass|ssa|sub)$/i.test(f.name));
    return Seedr.walkFolder(folderId)
      .then(all => resolveSeedrSubs(filename, subs(all)))
      .then(seedrSubs => resolveSubtitleWithFallback(filename, seedrSubs || [], show))
      .catch(() => null);
  }

  // Validate a freshly-minted Seedr CDN URL with a two-byte Range request.
  // A completed Seedr folder can still return a permanently dead ff_get URL
  // (HTTP 404 can leave <video> emitting only `waiting` indefinitely).
  // `false` means an explicit unusable HTTP/content response;
  // `null` means the browser could not probe (CORS/transient), in which case
  // playback still fails open exactly as before.
  async function _probeSeedrStream(url) {
    if (!url) return false;
    let ctrl = null, timer = null;
    try {
      ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(url, {
        cache: 'no-store', signal: ctrl.signal,
        headers: { Range: 'bytes=0-1' },
      });
      const ct = String(r.headers.get('content-type') || '').toLowerCase();
      try { if (r.body && r.body.cancel) r.body.cancel(); } catch (_) {}
      if (!r.ok) return false;
      if (ct.indexOf('text/html') >= 0 || ct.indexOf('application/json') >= 0) return false;
      return true;
    } catch (_) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Cache-hit fast path (Seedr flow): the CURRENTLY SELECTED engine's host
  // may already have this exact release sitting in its on-disk cache (a
  // prior download, a season-queue prefetch, or an earlier watch of the
  // same file) — see Remux.resolveCache(). On a hit this plays through the
  // SAME cached-drive machinery playDriveFile uses for /cache/stream
  // (_maybeRemux + openPlayer against a plain Range-servable URL), skipping
  // Seedr's URL-mint entirely.
  //
  // `fileId`/`source` are passed through UNCHANGED (the original seedr
  // identity, never a cache-backend id) so Storage.getResume/setResume keys
  // identically regardless of which path actually served the bytes —
  // continue-watching must not fork into two entries for one file.
  // Returns true on success (caller must not fall through to the seedr
  // path), false on ANY failure (caller falls through unchanged).
  async function _playSeedrCacheHit(hit, fileId, name, poster, show, subtitleP, startTime, extraMeta, openReq) {
    const req = openReq == null ? _openReqSeq : openReq;
    const openingVideo = currentVideo;
    if (req !== _openReqSeq) return false;
    if (!hit || !hit.rel || typeof Remux === 'undefined') return false;
    try {
      const u = Remux.cacheStreamUrl(hit.rel);
      if (!u) return false;
      const engine = Remux.engine();
      // Same locality restriction playDriveFile applies to a laptop-cache
      // URL: resolveCache() only ever asked ONE host, so pin to that same
      // host instead of letting _maybeRemux pick a different one.
      const preferEngine = (engine === 'laptop') ? engine : undefined;
      // Queue playback is direct-play only. A cache hit must not silently
      // introduce a remux before the later laptop-cache takeover.
      const rmx = (extraMeta && extraMeta._queueItem)
        ? { url: u, sess: null }
        : await _maybeRemux(u, 'seedr', u, startTime || 0, preferEngine);
      if (req !== _openReqSeq || currentVideo !== openingVideo) return false;
      openPlayer(rmx.url, name, Object.assign({
        fileId, source: 'seedr', poster: poster || null,
        subtitle: subtitleP, show, _remux: rmx.sess, cacheRel: hit.rel,
      }, extraMeta || {}));
      return true;
    } catch (_) {
      return false;
    }
  }

  // Open the player against a queue item's seedr URL. Sets the in-use
  // flag so the seedr cleanup knows to wait for closePlayer. No-op if
  // the user is already watching something else (we don't yank focus).
  async function playFromSeedrItem(item, mainFile, requestSequence) {
    // Retain the intended file even when the Seedr probe never opens a player.
    if (item && mainFile) item.mainSeedrFileId = mainFile.fileId;
    if (!item || !item.autoplay) return;
    if (currentVideo) return;       // user already watching something
    if (item._playStarting) return;
    item._playStarting = true;
    // Capture before cache resolution/URL minting. The caller supplies the
    // sequence reader so this queued open retains its original request.
    const req = requestSequence ? requestSequence() : null;
    const openingVideo = currentVideo;
    const isCurrent = () => (!requestSequence || requestSequence() === req)
      && currentVideo === openingVideo && item.autoplay && !item._uploadCancelled
      && queue.indexOf(item) >= 0;

    // Consume autoplay only AFTER a player has actually been opened. The old
    // early clear meant a dead Seedr URL also disabled the cache-complete
    // fallback, so the finished laptop copy never auto-opened later.
    const consumed = () => {
      item.autoplay = false;
      persistQueue();
    };

    try {

    // Fire the cache-resolve, the seedr URL mint, AND the subtitle sibling
    // search all in PARALLEL — none of the three has an ordering dependency
    // on the other two. A cache hit means urlP's result is simply never
    // awaited (still pre-caught below so an eventual rejection never surfaces
    // as an unhandled-rejection warning); a miss falls through to exactly the
    // old sequential-await behavior, just no longer serialized against subs.
    const resolveP = (typeof Remux !== 'undefined' && Remux.resolveCache)
      ? Remux.resolveCache(mainFile.name) : Promise.resolve(null);
    const urlP = Seedr.fetchFileUrl(mainFile.fileId);
    urlP.catch(() => {});
    const subtitleP = _seedrSiblingSubtitle(item.folderId, mainFile.name, item.show);

    const hit = await resolveP;
    if (!isCurrent()) return;
    if (hit && await _playSeedrCacheHit(
      hit, mainFile.fileId, mainFile.name, item.poster, item.show, subtitleP, 0,
      { _queueItem: item }, req,
    )) { consumed(); return; }
    if (!isCurrent()) return;

    let url;
    try { url = await urlP; }
    catch (e) {
      if (!isCurrent()) return;
      item._seedrUnavailable = true; toast(`Stream URL failed: ${e.message || e}`); return;
    }
    if (!isCurrent()) return;
    if (!url) { item._seedrUnavailable = true; toast('No stream URL'); return; }
    const probe = await _probeSeedrStream(url);
    if (!isCurrent()) return;
    // This is always a durable queue item with a laptop cache running in
    // parallel. An inconclusive webOS fetch probe must not fail open into a
    // readyState-0 player; keep autoplay armed so the finished cache opens.
    if (probe !== true) {
      item._seedrUnavailable = true;
      try {
        const st = $('#dumi-load-status');
        if (st) st.textContent = 'Seedr stream unavailable — caching directly to laptop…';
      } catch (_) {}
      return;   // autoplay remains armed; the laptop cache opens when ready
    }
    if (!isCurrent()) return;       // another user action won while probing
    // A queued Seedr file starts direct and remains direct when its laptop
    // copy takes over. No remux/transcode is introduced on either side.
    const rmx = { url, sess: null };
    openPlayer(rmx.url, mainFile.name, {
      fileId: mainFile.fileId,
      source: 'seedr',
      poster: item.poster || null,
      subtitle: subtitleP,
      show: item.show,
      // Back-ref to the queue item — used by swapPlaybackToDrive when the
      // background Drive upload finishes mid-stream so we can hot-swap
      // v.src to the Drive proxy without breaking playback.
      _queueItem: item,
      _remux: rmx.sess,
    });
    consumed();
    } finally {
      item._playStarting = false;
    }
  }

  // Always-delete cleanup. Drive holds the file permanently now, so the
  // seedr copy has no further purpose — clearing it immediately frees the
  // slot for the next download. If the user happens to still be watching
  // from the seedr URL when this fires, swapPlaybackToDrive() switches
  // them onto the Drive proxy first so playback continues seamlessly
  // from the same position.
  async function releaseSeedr(item) {
    if (!item || !item.folderId || item._cacheCopiesPending || item._uploadCancelled) return;
    if (item._seedrReleasing) return;
    if (item._seedrReleaseTimer) clearTimeout(item._seedrReleaseTimer);
    item._seedrReleaseTimer = 0;
    if (currentVideo && currentVideo._queueItem === item
        && (currentVideo._directSeedr || currentVideo._localHandoffPending)) {
      item._deferSeedrRelease = true;
      return;
    }
    item._seedrReleasing = true;
    const folderId = item.folderId;
    const releaseGen = item._seedrReleaseGen || 0;
    const ownsRelease = () => !item._uploadCancelled
      && (item._seedrReleaseGen || 0) === releaseGen && item.folderId === folderId;
    try {
      await Seedr.deleteItems({ folder_ids: [folderId] });
      if (!ownsRelease()) return;
      item.folderId = null;
      item._seedrReleaseAttempts = 0;
      persistQueue();
      // The seedr slot just freed up — run the same promotion the watcher
      // would have done so any pending magnet starts downloading.
      promoteNextPending();
    } catch (_) {
      // Retain the durable owner and retry transient failures, capped at one
      // attempt a minute. Boot also sweeps completed items retaining a folder.
      if (ownsRelease()) {
        item._seedrReleaseAttempts = (item._seedrReleaseAttempts || 0) + 1;
        const delay = Math.min(60000, 2000 * Math.pow(2, Math.min(5, item._seedrReleaseAttempts - 1)));
        item._seedrReleaseTimer = setTimeout(() => {
          if (!ownsRelease()) return;
          item._seedrReleaseTimer = 0;
          releaseSeedr(item);
        }, delay);
      }
    } finally {
      item._seedrReleasing = false;
    }
  }

  // Seedr can finish a torrent yet refuse both playback and background-copy
  // reads for the resulting ff_get URL with a hard CDN 404. In that case
  // retrying freshly minted Seedr URLs cannot recover:
  // send the ORIGINAL magnet to the laptop torrent engine, import the finished
  // files into its normal cache, then either open them or take over a live
  // Seedr playback. One promise per queue item keeps the playback probe and
  // upload failure paths from starting duplicate torrent jobs.
  function _downloadMagnetToLaptop(item) {
    if (!item || queue.indexOf(item) < 0 || !item.magnet || typeof LaptopCache === 'undefined') return Promise.resolve(false);
    if (item._torrentFallbackPromise) return item._torrentFallbackPromise;

    let cancelled = false;
    let activeHandle = null;
    let busySince = 0;
    let retryTimer = 0;
    const videoRe = /\.(mkv|mp4|m4v|avi|ts|m2ts|mov|webm|mpg|mpeg)$/i;
    // Capture source identities before fallback can release the Seedr folder.
    // Normal copies retain this small manifest, including across app restarts.
    const seedrFilesP = item.seedrVideos && item.seedrVideos.length
      ? Promise.resolve(item.seedrVideos)
      : item.folderId ? Seedr.walkFolder(item.folderId).then(files => {
        item.seedrVideos = files.filter(f => videoRe.test(f.name))
          .map(f => ({ fileId: f.fileId, name: f.name, size: f.size || 0 }));
        persistQueue();
        return item.seedrVideos;
      }).catch(() => []) : Promise.resolve([]);

    item._torrentFallback = true;
    item._backend = 'laptop';
    item.phase = 'copying';
    item.pct = Math.max(0, item.pct || 0);
    item.error = null;
    persistQueue(); renderQueue(); loadingTick(item);

    item._torrentFallbackPromise = new Promise((resolve) => {
      let settled = false;
      let completing = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = 0;
        item._uploadHandle = null;
        resolve(ok);
      };
      const cancel = () => {
        cancelled = true;
        if (retryTimer) clearTimeout(retryTimer);
        try { activeHandle && activeHandle.cancel(); } catch (_) {}
        finish(false);
      };
      item._uploadHandle = { cancel };

      const complete = async (ids) => {
        // rels may be hashed or collision-suffixed. The listing preserves the
        // original torrent filenames; only the ready job's own IDs qualify.
        const results = await Promise.all([seedrFilesP, LaptopCache.listAll().catch(() => [])]);
        if (cancelled || settled || queue.indexOf(item) < 0) { finish(false); return; }
        item.driveFiles = mapTorrentCacheFiles(results[0], ids, results[1]);
        if (item.mainSeedrFileId == null && results[0].length) {
          item.mainSeedrFileId = results[0].slice().sort((a, b) => (b.size || 0) - (a.size || 0))[0].fileId;
        }
        for (const f of item.driveFiles) {
          if (f.seedrFileId == null) continue;
          try { Storage.migrateResume(f.seedrFileId, f.fileId, { source: 'laptop' }); } catch (_) {}
        }
        item.phase = 'drive-ready';
        item.pct = 100;
        item.uploadStage = 'ready';
        item.error = null;
        item._torrentJobId = null;
        persistQueue(); renderQueue();
        if (currentTab === 'library') renderLibrary();

        const cv = currentVideo;
        const streamingThis = cv && cv._queueItem === item && cv._directSeedr;
        const cached = cachedPlaybackFile(item, cv);
        const main = cachedSeedrFile(item, item.mainSeedrFileId)
          || (item.mainSeedrFileId == null && item.driveFiles.length === 1 ? item.driveFiles[0] : null);
        if (streamingThis) {
          if (cached) LaptopCache.probePlayUrl(cached.fileId).then((probe) => {
            if (queue.indexOf(item) >= 0 && probe && probe.ok && currentVideo === cv && cv._directSeedr
                && String(cv.fileId) === String(cached.seedrFileId)) {
              swapPlaybackToDrive(item, cached.fileId);
            }
          }).catch(() => {});
        } else if (!cv && item.autoplay && main) {
          item.autoplay = false;
          persistQueue();
          playDriveFile(main.fileId, item.name, item.poster || null, null, item.show || null);
          releaseSeedr(item);
        } else {
          releaseSeedr(item);
        }
        finish(true);
      };

      let launch;
      const onTick = (t) => {
        if (cancelled || settled || completing) return;
        if (queue.indexOf(item) < 0) { cancel(); return; }
        if (t.jobId && item._torrentJobId !== t.jobId) {
          item._torrentJobId = t.jobId;
          persistQueue();
        }
        if (t.status === 'error') {
          const err = String(t.error || 'torrent download failed');
          // The laptop intentionally runs one torrent at a time. If this is a
          // resumed app session, adopt the matching server job; otherwise wait
          // without cancelling somebody else's download.
          if (/\bbusy\b/i.test(err)) {
            if (!busySince) busySince = Date.now();
            LaptopCache.torrentList().then(jobs => {
              if (cancelled || settled || queue.indexOf(item) < 0) { finish(false); return; }
              const match = (jobs || []).find(j => j && j.id
                && String(j.name || '') === String(item.name || ''));
              if (match) {
                item._torrentJobId = match.id;
                persistQueue();
                retryTimer = setTimeout(pollExisting, 0);
              } else if (Date.now() - busySince < 5 * 60 * 1000) {
                item.uploadStage = 'waiting for laptop torrent slot';
                loadingTick(item); scheduleRenderQueue();
                retryTimer = setTimeout(launch, 4000);
              } else {
                item.phase = 'error'; item.error = err;
                persistQueue(); renderQueue(); loadingTick(item); finish(false);
              }
            }).catch(() => { retryTimer = setTimeout(launch, 4000); });
            return;
          }
          item.phase = 'error';
          item.error = err;
          persistQueue(); renderQueue(); loadingTick(item);
          finish(false);
          return;
        }
        busySince = 0;
        if (t.status === 'ready') {
          let ids = (t.fileIds || []).filter(id => videoRe.test(String(id || '')));
          if (!ids.length && t.fileId && videoRe.test(String(t.fileId))) ids = [t.fileId];
          if (!ids.length) {
            item.phase = 'error';
            item.error = 'downloaded, but no playable video was found';
            persistQueue(); renderQueue(); loadingTick(item);
            finish(false);
            return;
          }
          ids = ids.slice().sort((a, b) => String(a).localeCompare(String(b)));
          completing = true;
          complete(ids).catch(e => {
            if (cancelled || settled || queue.indexOf(item) < 0) { finish(false); return; }
            item.phase = 'error'; item.error = String(e && e.message || e);
            persistQueue(); renderQueue(); loadingTick(item); finish(false);
          });
          return;
        }

        let pct = Number(t.progress || 0);
        if (pct <= 1) pct *= 100;
        if (!pct && t.total) pct = (Number(t.received || 0) / Number(t.total)) * 100;
        item.pct = Math.max(0, Math.min(99.9, pct || 0));
        item.uploadStage = t.stage || t.status || 'downloading';
        // Persist coarse progress so a relaunch paints an honest percentage
        // before the first reattached status tick arrives.
        if (!item._lastTorrentPersist || Date.now() - item._lastTorrentPersist > 10000) {
          item._lastTorrentPersist = Date.now();
          persistQueue();
        }
        loadingTick(item); scheduleRenderQueue();
      };

      const pollExisting = async () => {
        if (cancelled || settled || !item._torrentJobId) return;
        if (queue.indexOf(item) < 0) { cancel(); return; }
        const s = await LaptopCache.torrentStatus(item._torrentJobId);
        if (cancelled || settled || queue.indexOf(item) < 0) { finish(false); return; }
        if (s.state === 'ready') {
          const rels = s.rels || (s.rel ? [s.rel] : []);
          onTick({ status: 'ready', jobId: item._torrentJobId,
            fileIds: rels.map(rel => LaptopCache.PFX + rel),
            fileId: s.rel ? LaptopCache.PFX + s.rel : null,
            total: s.total || 0, received: s.received || 0 });
          return;
        }
        if (s.state === 'error' || s.state === 'aborted') {
          onTick({ status: 'error', jobId: item._torrentJobId, error: s.error || s.state });
          return;
        }
        if (s.state === 'unknown') {
          item._torrentJobId = null;
          persistQueue();
          launch();
          return;
        }
        onTick({ status: s.state === 'metadata' ? 'metadata' : 'downloading',
          jobId: item._torrentJobId, stage: s.state,
          progress: s.progress || 0, total: s.total || 0, received: s.received || 0 });
        retryTimer = setTimeout(pollExisting, 2000);
      };

      launch = () => {
        if (cancelled || settled || queue.indexOf(item) < 0) { finish(false); return; }
        if (item._torrentJobId) { pollExisting(); return; }
        activeHandle = LaptopCache.addTorrent(
          { source: item.magnet, name: item.name || '' }, onTick,
        );
        // Keep the wrapper installed: queue wipe/removal cancels retries and
        // whichever concrete laptop job is active at that instant.
        item._uploadHandle = { cancel };
      };
      launch();
    }).finally(() => {
      item._torrentFallbackPromise = null;
    });
    return item._torrentFallbackPromise;
  }

  // Switch a DIRECT (non-remux) Seedr player onto a safe growing laptop
  // prefix. Accelerate only after the replacement plays, or has loaded and
  // restored a paused position. The old Seedr media request is then discarded,
  // keeping the free account at no more than two connections.
  function swapPlaybackToGrowingCache(item, storeFileId, jobId, seedrFileId) {
    if (!item || !storeFileId || !jobId || typeof LaptopCache === 'undefined') return Promise.resolve(false);
    if (!currentVideo || currentVideo._queueItem !== item) return Promise.resolve(false);
    const cv = currentVideo;
    if (!cv._directSeedr || cv._remux || String(cv.fileId) !== String(seedrFileId)) return Promise.resolve(false);
    if (cv._growingHandoffPromise) return cv._growingHandoffPromise;
    // A queue item can contain several videos. Only a handoff for the actual
    // playing file may discard a sibling's backoff and failure cap.
    if (item._growingHandoffRetry && item._growingHandoffRetry.seedrFileId !== String(seedrFileId)) {
      item._growingHandoffRetry = null;
      item._growingHandoffFailures = 0;
    }
    if ((item._growingHandoffFailures || 0) >= 3) return Promise.resolve(false);

    const v = $('#video');
    const old = {
      src: cv.src, fileId: cv.fileId, source: cv.source,
      cacheRel: cv._cacheRel, resumeFileId: cv._resumeFileId,
      resumeSource: cv._resumeSource,
    };
    const clock = playbackResumeClock(cv, v);
    if (!growingCoversPlayhead(cv, clock)) return Promise.resolve(false);
    if (!growingHandoffRetryReady(item, cv, clock)) return Promise.resolve(false);
    const position = clock.position;
    const wasPlaying = !v.paused;
    const newSrc = LaptopCache.growingStreamUrl(storeFileId);
    const token = `${Date.now()}_${Math.random()}`;
    cv._growingToken = token;
    cv._localHandoffPending = true;

    const handoff = new Promise((resolve) => {
      let settled = false;
      let timeout = 0;
      let playingSeen = false;
      const cleanup = () => {
        clearTimeout(timeout);
        v.removeEventListener('playing', onPlaying);
        v.removeEventListener('loadeddata', onLoaded);
        v.removeEventListener('canplay', onLoaded);
        v.removeEventListener('seeked', onLoaded);
        v.removeEventListener('error', onError, true);
        cv._cancelGrowingHandoff = null;
      };
      const cancel = () => {
        if (settled) return;
        settled = true; cleanup();
        cv._growingToken = null;
        cv._growingHandoffPromise = null;
        cv._localHandoffPending = false;
        refreshPlaybackSourceStatus(cv);
        resolve(false);
      };
      cv._cancelGrowingHandoff = cancel;
      const fail = () => {
        if (settled) return;
        settled = true; cleanup();
        if (currentVideo === cv && cv._growingToken === token) {
          item._growingHandoffFailures = (item._growingHandoffFailures || 0) + 1;
          // Snapshot the latest published ranges, not just those at attempt
          // start. Bytes downloaded during a failed seek cannot unlock retry.
          item._growingHandoffRetry = {
            failedAt: Date.now(), seedrFileId: String(seedrFileId),
            total: cv._growingTotal,
            ranges: (cv._growingRanges || []).filter(r => Array.isArray(r)).map(r => r.slice()),
          };
          rollbackGrowingCache(item, seedrFileId, jobId);
        }
        try { window.__bbEvent && window.__bbEvent('seedr:growing-failed', { at: Math.round(position) }); } catch (_) {}
        resolve(false);
      };
      const onError = (event) => {
        // This temporary capture listener runs before the player's generic
        // recovery handler; the growing handoff owns this one rollback.
        if (currentVideo !== cv || cv._growingToken !== token || cv.src !== newSrc) {
          cancel();
          return;
        }
        try { event.stopImmediatePropagation(); } catch (_) {}
        fail();
      };
      const finishLoaded = () => {
        if (settled || currentVideo !== cv || cv._growingToken !== token) return;
        if (String(v.currentSrc || v.src || '').indexOf('/cache/growing/') < 0) return;
        if (cv._pendingResume !== null || v.seeking || v.readyState < 2) return;
        if (wasPlaying && !playingSeen) return;
        // fastSeek may settle on an earlier keyframe; a finished seek near the
        // target is the restore (matches the visible player's own rule).
        if (!wasPlaying && Math.abs((v.currentTime || 0) - position) > 15) return;
        if (!wasPlaying) v.pause();
        settled = true; cleanup();
        cv._localHandoffPending = false;
        cv._growingHandoffPromise = null;
        cv._handoffClock = null;
        refreshPlaybackSourceStatus(cv);
        pToast('Playing from growing laptop cache');
        try { window.__bbEvent && window.__bbEvent('seedr:growing-playing', { at: Math.round(position) }); } catch (_) {}
        if (typeof inspectLaptopMedia === 'function') inspectLaptopMedia(cv, newSrc);
        if (cv._growingFinalReady) {
          finalizeGrowingCache(item, storeFileId);
        } else {
          // Give Chromium a short beat to close the replaced Seedr socket.
          setTimeout(() => {
            if (currentVideo === cv && cv._growingCache && cv._growingJobId === jobId) {
              LaptopCache.accelerate(jobId).then((r) => {
                try { window.__bbEvent && window.__bbEvent('seedr:growing-accelerate', { ok: !!(r && r.ok), accelerated: !!(r && r.accelerated) }); } catch (_) {}
              }).catch(() => {});
            }
          }, 900);
        }
        resolve(true);
      };

      const onPlaying = () => {
        if (currentVideo !== cv || cv._growingToken !== token
            || String(v.currentSrc || v.src || '').indexOf('/cache/growing/') < 0) return;
        playingSeen = true;
        finishLoaded();
      };

      // A paused source never emits playing. Restore on the first decoded
      // frame, then acknowledge the loaded, settled position without playing.
      const onLoaded = () => {
        if (settled || currentVideo !== cv || cv._growingToken !== token) return;
        if (String(v.currentSrc || v.src || '').indexOf('/cache/growing/') < 0 || v.readyState < 2) return;
        if (cv._pendingResume !== null) {
          cv._pendingResume = null;
          if (Math.abs((v.currentTime || 0) - position) > 0.75) {
            resumeSeek(v, position);
            return;
          }
        }
        finishLoaded();
      };
      v.addEventListener('playing', onPlaying);
      v.addEventListener('loadeddata', onLoaded);
      v.addEventListener('canplay', onLoaded);
      v.addEventListener('seeked', onLoaded);
      v.addEventListener('error', onError, true);
      try { Storage.migrateResume(cv.fileId, storeFileId, { source: 'laptop' }); } catch (_) {}
      cv.src = newSrc;
      cv.fileId = storeFileId;
      cv.source = 'laptop';
      cv._cacheRel = storeFileId.slice(LaptopCache.PFX.length);
      cv._directSeedr = false;
      cv._growingCache = true;
      cv._growingJobId = jobId;
      cv._growingSeedr = old;
      cv._growingWasPlaying = wasPlaying;
      cv._handoffClock = clock;
      cv._pendingResume = position;
      cv._parked = null;
      delete cv._resumeFileId;
      delete cv._resumeSource;
      try { if (typeof Remux !== 'undefined') Remux.bindVideo(null); } catch (_) {}
      setVideoSource(v, newSrc);
      if (!wasPlaying) v.pause();
      _syncWatchdog(v, cv.isAudio);
      if (wasPlaying) v.play().catch(() => {});
      timeout = setTimeout(fail, 15000);
    });
    cv._growingHandoffPromise = handoff;
    return handoff;
  }

  // Compare union coverage at the SAME current playhead in both snapshots:
  // clock movement, range reordering and unrelated islands are not progress.
  function growingHandoffRangeProgress(ranges, total, playhead) {
    const tailStart = Math.max(0, total - Math.max(4 * 1024 * 1024, total * 0.005));
    const sorted = (ranges || []).filter(r => Array.isArray(r)
      && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] > r[0])
      .map(r => [Math.max(0, r[0]), Math.min(total, r[1])]).sort((a, b) => a[0] - b[0]);
    let frontier = playhead, tailEnd = tailStart, tailBytes = 0;
    sorted.forEach(r => {
      if (r[0] <= frontier && r[1] > frontier) frontier = r[1];
      const start = Math.max(tailEnd, r[0]);
      if (r[1] > start) { tailBytes += r[1] - start; tailEnd = r[1]; }
    });
    return { frontier, tailBytes };
  }

  function growingHandoffRetryReady(item, cv, clock) {
    const retry = item._growingHandoffRetry;
    if (!retry) return true;
    if (Date.now() - retry.failedAt < 60000 * (item._growingHandoffFailures || 1)) return false;
    const total = Number(cv._growingTotal || 0);
    if (!Number.isFinite(total) || total <= 0 || total !== retry.total) return false;
    const rate = Number.isFinite(clock.duration) && clock.duration > 0 ? total / clock.duration : 0;
    const playhead = rate ? Math.max(0, Math.min(total, clock.position * rate)) : total;
    const before = growingHandoffRangeProgress(retry.ranges, total, playhead);
    const after = growingHandoffRangeProgress(cv._growingRanges, total, playhead);
    // Require about ten seconds of useful media (at least 4 MiB), or newly
    // published tail/index coverage, which can be just a small seek index.
    const aheadStep = Math.min(total, Math.max(4 * 1024 * 1024, rate * 10, total * 0.005));
    return after.frontier - before.frontier >= aheadStep
      || after.tailBytes > before.tailBytes;
  }

  // Hand off only when the copy already holds the playhead plus ~20 s, so the
  // swap's seek never waits on bytes the copier has not reached. A
  // copy that started late was "ready" (index + 32 MiB) while the playhead sat
  // far past its head, and the doomed swap froze the picture for ~13 s.
  function growingCoversPlayhead(cv, clock) {
    const total = Number(cv._growingTotal || 0);
    const duration = Number(clock && clock.duration);
    if (!(total > 0) || !(duration > 0)) return true;
    const rate = total / duration;
    const at = Math.max(0, Math.min(total, (Number(clock.position) || 0) * rate));
    const need = Math.min(total, at + Math.max(16 * 1024 * 1024, rate * 20));
    return (cv._growingRanges || []).some(r => Array.isArray(r) && r[0] <= at && r[1] >= need);
  }

  function refreshPlaybackSourceStatus(cv) {
    if (currentVideo !== cv) return;
    try { if (window.__nftRefreshSourceStatus) window.__nftRefreshSourceStatus(); } catch (_) {}
  }

  // The element's clock temporarily becomes zero/NaN on a source replacement
  // or decoder park. Pending positions are already in absolute movie time.
  function playbackResumeClock(cv, v) {
    const remux = typeof Remux !== 'undefined' && Remux.hasSession();
    const pending = Number.isFinite(cv._pendingResume);
    const saved = cv._handoffClock;
    const restoring = saved && (pending || cv._localHandoffPending || v.seeking || v.readyState < 2);
    return {
      position: cv._parked ? cv._parked.pos : pending ? cv._pendingResume
        : restoring ? saved.position : remux ? Remux.absolute(v.currentTime || 0) : (v.currentTime || 0),
      duration: cv._parked ? cv._parked.dur : remux && Remux.duration ? Remux.duration
        : Number.isFinite(v.duration) && v.duration > 0 ? v.duration : saved ? saved.duration : 0,
    };
  }

  // Each landed video records its Seedr identity. Never infer an episode from
  // its position in a pack, including while only an earlier sibling is ready.
  function cachedSeedrFile(item, seedrFileId) {
    if (!item || seedrFileId == null) return null;
    return (item.driveFiles || []).find(f => f.seedrFileId != null
      && String(f.seedrFileId) === String(seedrFileId)) || null;
  }

  function mapTorrentCacheFiles(seedrFiles, ids, listing) {
    const cached = ids.map(id => (listing || []).find(f => String(f.id) === String(id)) || null);
    const sameSize = (a, b) => !a.size || !b.size || Number(a.size) === Number(b.size);
    const matches = (a, b) => b && a.name === b.name && sameSize(a, b);
    return ids.map((id, i) => {
      const meta = cached[i];
      const out = { fileId: id, name: meta && meta.name || String(id).split('/').pop(), size: meta && meta.size || 0 };
      // One video on each side of the same torrent is unambiguous even when
      // a cache rel/name is unavailable. Known size contradictions still veto.
      if (seedrFiles.length === 1 && ids.length === 1 && (!meta || sameSize(seedrFiles[0], meta))) {
        out.seedrFileId = seedrFiles[0].fileId;
      } else {
        const sources = seedrFiles.filter(f => matches(f, meta));
        if (sources.length === 1 && cached.filter(f => matches(sources[0], f)).length === 1) {
          out.seedrFileId = sources[0].fileId;
        }
      }
      return out;
    });
  }

  function cachedPlaybackFile(item, cv) {
    if (!item || !cv || cv._queueItem !== item) return null;
    if (cv.source === 'seedr') return cachedSeedrFile(item, cv.fileId);
    return (item.driveFiles || []).find(f => String(f.fileId) === String(cv.fileId)) || null;
  }

  function cancelGrowingWaitNotice(cv) {
    if (!cv) return;
    clearTimeout(cv._growingWaitTimer);
    cv._growingWaitTimer = null;
  }

  function cancelGrowingHandoff(cv) {
    if (!cv) return;
    cancelGrowingWaitNotice(cv);
    if (cv._cancelGrowingHandoff) cv._cancelGrowingHandoff();
  }

  function rollbackGrowingCache(item, seedrFileId, jobId) {
    const cv = currentVideo;
    if (!cv || cv._queueItem !== item || cv._growingJobId !== jobId) return false;
    const old = cv._growingSeedr;
    if (cv._growingCache ? !old || String(old.fileId) !== String(seedrFileId)
      : !cv._directSeedr || String(cv.fileId) !== String(seedrFileId)) return false;
    const v = $('#video');
    const clock = playbackResumeClock(cv, v);
    const wasPlaying = cv._localHandoffPending ? cv._growingWasPlaying : !v.paused;
    const growing = cv._growingCache;
    cancelGrowingHandoff(cv);
    cv._growingRanges = [];
    cv._growingBytesPerSec = 0;
    cv._growingTotal = 0;
    cv._growingJobId = null;
    cv._growingFinalReady = false;
    cv._growingToken = null;
    cv._growingSeekTarget = null;
    cv._growingHandoffPromise = null;
    cv._growingSeedr = null;
    cv._localHandoffPending = false;
    if (!growing) { refreshPlaybackSourceStatus(cv); return true; }
    const storeFileId = cv.fileId;
    cv.src = old.src; cv.fileId = old.fileId; cv.source = old.source;
    cv._cacheRel = old.cacheRel; cv._resumeFileId = old.resumeFileId;
    cv._resumeSource = old.resumeSource; cv._directSeedr = true;
    cv._growingCache = false;
    cv._pendingResume = clock.position;
    cv._handoffClock = clock;
    cv._parked = null;
    try { Storage.migrateResume(storeFileId, old.fileId, { source: 'seedr' }); } catch (_) {}
    setVideoSource(v, old.src);
    _syncWatchdog(v, cv.isAudio);
    if (wasPlaying) v.play().catch(() => {});
    else v.pause();
    refreshPlaybackSourceStatus(cv);
    return true;
  }

  function updateGrowingCacheTick(item, tick, seedrFileId) {
    const cv = currentVideo;
    if (!cv || cv._queueItem !== item || !tick.jobId) return;
    if (cv._growingCache) {
      if (cv._growingJobId !== tick.jobId || String(cv.fileId) !== String(tick.fileId)) return;
    } else if (!cv._directSeedr || String(cv.fileId) !== String(seedrFileId)) return;
    cv._growingJobId = tick.jobId;
    cv._growingRanges = tick.ranges || [];
    cv._growingBytesPerSec = Number(tick.bytesPerSec || 0);
    cv._growingTotal = Number(tick.total || 0);
  }

  // ready is terminal: there may never be another poll after a failed growing
  // attempt. Wait for that attempt before choosing the completed-file path.
  function completeCachePlayback(item, storeFileId, seedrFileId) {
    const cv = currentVideo;
    if (!cv || cv._queueItem !== item) return Promise.resolve(false);
    if (cv._directSeedr && seedrFileId != null && String(cv.fileId) !== String(seedrFileId)) return Promise.resolve(false);
    const expectedSeedrId = seedrFileId == null ? cv.fileId : seedrFileId;
    if (cv._growingCache && String(cv.fileId) === String(storeFileId)) {
      finalizeGrowingCache(item, storeFileId);
    }
    const pending = cv._growingHandoffPromise || Promise.resolve();
    return pending.then(() => {
      if (currentVideo !== cv || cv._queueItem !== item) return false;
      if (cv._growingCache && String(cv.fileId) === String(storeFileId)) {
        return finalizeGrowingCache(item, storeFileId);
      }
      if (cv._directSeedr && String(cv.fileId) === String(expectedSeedrId)) {
        return swapPlaybackToDrive(item, storeFileId);
      }
      return true;
    });
  }

  function finalizeGrowingCache(item, storeFileId) {
    const cv = currentVideo;
    if (!cv || cv._queueItem !== item || !cv._growingCache
        || String(cv.fileId) !== String(storeFileId)) return false;
    cv._growingFinalReady = true;
    if (cv._localHandoffPending) return false;
    cv._growingCache = false;
    cv._growingFinalReady = false;
    cv._growingJobId = null;
    cv._growingToken = null;
    cv._growingSeedr = null;
    cancelGrowingWaitNotice(cv);
    cv._directSeedr = false;
    cv.source = 'laptop';
    try { Storage.migrateResume(cv._resumeFileId || cv.fileId, storeFileId, { source: 'laptop' }); } catch (_) {}
    pToast('Laptop cache download complete — seeking unlocked');
    try { window.__bbEvent && window.__bbEvent('seedr:growing-ready', {}); } catch (_) {}
    releaseSeedr(item);
    return true;
  }

  // Player is mid-stream from this item's Seedr URL when the background copy
  // completes. Swap the source to the completed cache/Drive proxy at the same
  // position so the user doesn't notice the cutover. Existing
  // _pendingResume + loadedmetadata machinery handles the seek for us.
  function swapPlaybackToDrive(item, completedFileId) {
    if (!item || !item.driveFiles || !item.driveFiles.length) return Promise.resolve(false);
    if (!currentVideo || currentVideo._queueItem !== item) return Promise.resolve(false);
    if (!currentVideo._directSeedr && !currentVideo._localHandoffPending) return Promise.resolve(false);
    const cv = currentVideo;
    const cached = cachedPlaybackFile(item, cv);
    const storeFileId = completedFileId || (cached && cached.fileId);
    if (!storeFileId) return Promise.resolve(false);
    if (cv._localHandoffPromise) return cv._localHandoffPromise;
    cv._localHandoffPending = true;
    if (cv._seedrStartTimer) {
      clearTimeout(cv._seedrStartTimer);
      cv._seedrStartTimer = 0;
    }
    const v = $('#video');
    const be = storeFor(storeFileId);
    const backendKind = (typeof LaptopCache !== 'undefined' && be === LaptopCache) ? 'laptop'
      : (be === PhoneCache) ? 'cache' : 'drive';
    const newSrc = be.streamUrl(storeFileId);
    const wasPlaying = !v.paused;
    // ABSOLUTE movie position — v.currentTime is window-relative under remux.
    const clock = playbackResumeClock(cv, v);
    const position = clock.position;
    cv._handoffClock = clock;
    const src = backendKind;
    // Warm the backend before we hit it — Drive primes its bearer-token proxy,
    // the cache is a no-op. Idempotent + in-flight-deduped.
    be.armProxy().catch(() => {});
    // Tear down the OLD remux session before swapping — otherwise its ffmpeg
    // leaks (a second, orphaned transcode) and the seek bar / subtitle overlay
    // keep reading the dead session's time base.
    try { if (typeof Remux !== 'undefined') { Remux.close(); Remux.bindVideo(null); } } catch (_) {}
    cv._remux = null;

    const handoff = (async () => {
      // Cache takeover is direct-play only. The replacement is the same file
      // on a local Range server, so do not create a remux/transcode session.
      const rmx = { url: newSrc, sess: null };
      if (currentVideo !== cv || cv._queueItem !== item) return false;

      // Commit the identity only after the replacement URL/remux is ready.
      // Until this point _localHandoffPending keeps every user seek blocked,
      // so the still-playing Seedr source cannot receive a late Range burst.
      try { Storage.migrateResume(cv._resumeFileId || cv.fileId, storeFileId, { source: src }); } catch (_) {}
      cv.fileId = storeFileId;
      cv.source = src;
      cv._directSeedr = false;
      cv._growingCache = false;
      cv._growingFinalReady = false;
      cv._growingJobId = null;
      cv._growingToken = null;
      cv._growingHandoffPromise = null;
      cv._growingSeedr = null;
      cancelGrowingWaitNotice(cv);
      delete cv._resumeFileId;
      delete cv._resumeSource;
      cv._decodeRetries = 0;
      cv._retriedUrl = false;
      cv._urlRetries = 0;
      cv.src = rmx.url;
      cv._remux = rmx.sess;
      // A remux session opens AT `position` (server-side); direct playback needs
      // the client resume-seek. resumeSeek converts abs→relative when needed.
      cv._pendingResume = rmx.sess ? null : position;
      cv._parked = null;
      if (typeof Remux !== 'undefined') Remux.bindVideo(rmx.sess ? v : null);
      // setVideoSource (not raw v.src=) so any stale <source> children are cleared.
      setVideoSource(v, rmx.url);
      _syncWatchdog(v, cv.isAudio);
      if (wasPlaying) v.play().catch(() => {});
      cv._localHandoffPending = false;
      cv._localHandoffPromise = null;
      pToast(backendKind === 'laptop' ? 'Switched to laptop cache'
             : backendKind === 'cache' ? 'Switched to local cache' : 'Switched to Drive');
      try { window.__bbEvent && window.__bbEvent('seedr:handoff', { backend: backendKind, position: Math.round(position) }); } catch (_) {}
      if (backendKind === 'laptop' && typeof inspectLaptopMedia === 'function') inspectLaptopMedia(cv, rmx.url);
      // The media element now points only at the completed local/cache source;
      // it is safe to free Seedr and promote the next queued download.
      releaseSeedr(item);
      return true;
    })().catch((err) => {
      if (currentVideo === cv) {
        cv._localHandoffPending = false;
        cv._localHandoffPromise = null;
        // No replacement identity was committed, so Seedr remains authoritative
        // and its seek lock remains active.
        cv._directSeedr = true;
      }
      try { window.__bbEvent && window.__bbEvent('seedr:handoff-failed', { error: String(err && (err.message || err) || 'unknown') }); } catch (_) {}
      return false;
    });
    cv._localHandoffPromise = handoff;
    return handoff;
  }

  // Kick off (or resume) a Drive upload for an item that already finished
  // seedr download. Idempotent: ignored if a copy is already running, or if
  // the item is already on Drive.
  function resumeUpload(item) {
    if (!item || !item.folderId) return;
    if (item.phase === 'copying' || item.phase === 'cooldown') return;
    if (item.phase === 'drive-ready') return;
    // Guard against the watcher firing two `active:false` ticks back-to-back
    // (the seedr poll + a delayed reply queued from a prior poll). Without
    // this we'd launch two parallel uploads racing for the same Drive
    // session.
    if (item._uploadStarted) return;
    item._uploadStarted = true;
    item.error = null;
    copyToGdrive(item)
      .catch(e => {
        item.phase = 'error';
        item.error = String(e);
        persistQueue(); renderQueue(); loadingTick(item);
      })
      .finally(() => { item._uploadStarted = false; });
  }

  // After seedr finishes a torrent: walk the folder, push each video file
  // through the service to Drive, then delete from seedr to free the cap.
  async function copyToGdrive(item) {
    // Cache backend selection: when the laptop remux engine is selected,
    // prefer caching the next episode on the laptop's own (disk-safety-
    // bounded) cache so playback resumes there near-instantly. This check
    // MUST come first and MUST be gated on Remux.engine()==='laptop' —
    // never on LaptopCache reachability alone — so a tv-engine user's
    // next-episode cache is never silently redirected to the laptop.
    // Otherwise prefer the phone's local cache (fast LAN + pre-fetches the
    // next episode locally) — this is a STORAGE choice, not a remux-engine
    // one (the phone remains a legitimate place to stash files; see
    // js/phonecache.js), independent of which engine actually transcodes
    // it later. Fall back to Google Drive only when neither cache is
    // reachable.
    // The laptop's health probe has a 2.5 s budget; one slow answer (spun-down
    // HDD, busy Wi-Fi) used to drop a whole title to "cloud only". Retry a
    // couple of times before choosing another backend.
    const laptopCacheReachable = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await sleep(attempt === 1 ? 1500 : 4000);
        if (await LaptopCache.reachable()) return true;
      }
      return false;
    };
    let backend = null;
    if (Remux.engine() === 'laptop' && typeof LaptopCache !== 'undefined' && await laptopCacheReachable()) {
      backend = LaptopCache;
    } else if (await PhoneCache.reachable()) {
      backend = PhoneCache;
    } else if (Drive.available() && Drive.isSignedIn()) {
      backend = Drive;
    }
    if (!backend) {
      item.phase = 'cloud-ready';
      item.pct = 100;
      persistQueue(); renderQueue();
      toast(`Ready (cloud only): ${item.name}`);
      if (currentTab === 'library') renderLibrary();
      // While this title streams from Seedr, keep trying to start the laptop
      // copy: a slow health probe at play time must not leave seeking locked
      // for the whole movie.
      if (Remux.engine() === 'laptop' && (item._cloudRetries || 0) < 10) {
        item._cloudRetries = (item._cloudRetries || 0) + 1;
        setTimeout(() => {
          const cv = currentVideo;
          if (item.phase === 'cloud-ready' && cv && cv._queueItem === item && cv._directSeedr) {
            resumeUpload(item);
          }
        }, 20000);
      }
      return;
    }
    item._cloudRetries = 0;
    item._backend = (backend === LaptopCache) ? 'laptop' : (backend === PhoneCache) ? 'cache' : 'drive';

    item.phase = 'copying';
    item.pct = 0;
    item.driveFiles = [];
    persistQueue(); renderQueue();

    const files = await Seedr.walkFolder(item.folderId);
    const videos = files.filter(f => /\.(mp4|mkv|mov|m4v|webm|avi|mpg|mpeg)$/i.test(f.name));
    const subs   = files.filter(f => /\.(srt|vtt|ass|ssa|sub)$/i.test(f.name));
    if (videos.length === 0) {
      item.phase = 'error';
      item.error = 'no video files in seedr folder';
      persistQueue(); renderQueue(); loadingTick(item);
      return;
    }

    if (item.mainSeedrFileId == null) {
      const main = pickSeedrVideo(item, videos);
      if (!main) {
        item.phase = 'error';
        item.error = 'requested episode not found in seedr folder';
        persistQueue(); renderQueue(); loadingTick(item);
        return;
      }
      item.mainSeedrFileId = main.fileId;
    }
    item.seedrVideos = videos.map(f => ({ fileId: f.fileId, name: f.name, size: f.size || 0 }));

    // A Seedr URL failing on the TV does NOT prove it will fail from the
    // laptop.  The laptop cache deliberately borrows a verified direct route
    // while aria2 is stopped, and that different network path often succeeds
    // when webOS/CDN playback does not.  Always give the normal Seedr→laptop
    // copy its three fresh-link attempts below. The user has explicitly
    // enabled automatic fallback, so only their real failure may start the
    // protected torrent path using the queue item's original magnet.

    const subdir = item.folderName || item.name;
    let aggDone = 0;
    // Pre-sum all video file sizes so the progress denominator is stable
    // from the very first tick — prevents the bar jumping to 99.9% instantly
    // when tick.total hasn't arrived yet, or snapping to 100% at file 2+.
    let aggTotal = videos.reduce((s, f) => s + (f.size || 0), 0);

    // Early playback handoffs must retain Seedr until every sibling is copied.
    item._cacheCopiesPending = true;

    // Subtitles are tiny but each one is a Seedr link + cache job round trip.
    // Copy them after the first video has landed: the video copy starts at
    // once, Seedr is idle then (playback has moved to the laptop, so no third
    // connection), and later episodes in a pack still get their subs early.
    // Playback keeps its already-resolved subtitles across source swaps.
    item.driveSubtitles = item.driveSubtitles || [];
    let subsCopied = false;
    const copySubtitles = async () => {
      if (subsCopied) return;
      subsCopied = true;
      for (const s of subs) {
        try {
          const sourceUrl = await Seedr.fetchFileUrl(s.fileId);
          if (!sourceUrl) continue;
          const dlId = `${item.id}_sub_${s.fileId}`;
          await new Promise((resolve) => {
            let done = false;
            backend.uploadFromUrl({ id: dlId, sourceUrl, filename: s.name, subdir, total: s.size || 0 }, (tick) => {
              if (done) return;
              if (tick.error || tick.status === 'error') { done = true; resolve(); return; }
              if (tick.status === 'ready') {
                done = true;
                item.driveSubtitles.push({ fileId: tick.fileId, name: s.name });
                resolve();
              }
            });
          });
        } catch (_) { /* a missing sub shouldn't block the video copies */ }
      }
      persistQueue();
    };

    // Brief breather between episodes within a season pack. The keep-alive
    // upload agent already paces gracefully; we just want a small gap so
    // Drive doesn't see N parallel session opens in the same second.
    const EPISODE_COOLDOWN_MS = 30_000;
    let firstFile = true;

    for (const f of videos) {
      if (!firstFile && videos.length > 1) {
        item.phase = 'cooldown';
        item.uploadStage = null;
        item.cooldownUntil = Date.now() + EPISODE_COOLDOWN_MS;
        persistQueue(); renderQueue();
        await sleep(EPISODE_COOLDOWN_MS);
        item.cooldownUntil = null;
        item.phase = 'copying';
        persistQueue(); renderQueue();
      }
      firstFile = false;

      const dlIdBase = `${item.id}_${f.fileId}`;
      let fileTotal = 0, fileWritten = 0;

      // One upload attempt against a given seedr link. Wrapped so the retry
      // loop below can re-mint and try again: seedr links can be COLD (403/
      // "preparing" for the first seconds after a torrent finishes — exactly
      // when this code runs) or expired by the time the queue reaches this
      // file. The live-playback path already re-mints + retries on error;
      // without the same here the background copy dead-ends the queue card
      // on "Error: HTTP Error 403" for a file that is sitting right there
      // in seedr.
      const attemptUpload = (sourceUrl, dlId) => new Promise((resolve, reject) => {
          let finished = false;
          item._uploadHandle = backend.uploadFromUrl({ id: dlId, sourceUrl, filename: f.name,
                                                       subdir, total: f.size || 0 }, (tick) => {
            if (finished || item._uploadCancelled) return;
            if (tick.error || tick.status === 'error') {
              finished = true;
              item.error = tick.error || 'upload failed';
              // A failed job's growing file may disappear on the engine. Leave
              // it before the retry gets a new job/rel, and discard old ranges.
              if (backend === LaptopCache) rollbackGrowingCache(item, f.fileId, dlId);
              reject(new Error(item.error));
              return;
            }
            if (tick.total) fileTotal = tick.total;
            // Show whichever is higher: bytes flowing through (received from
            // seedr) vs. bytes confirmed by Drive (written). The bar moves
            // immediately when seedr starts feeding, instead of waiting for
            // the first 8 MB chunk to land on Drive.
            fileWritten = Math.max(tick.received || 0, tick.written || 0);
            item.uploadStage = tick.stage || tick.status || null;
            item.uploadReceived = tick.received || 0;
            item.uploadWritten = tick.written || 0;
            const progressTotal = aggTotal || (aggDone + fileTotal);
            item.pct = Math.min(99.9, ((aggDone + fileWritten) / Math.max(1, progressTotal)) * 100);
            if (backend === LaptopCache) updateGrowingCacheTick(item, tick, f.fileId);
            if (backend === LaptopCache && tick.status !== 'ready'
                && tick.progressiveReady && tick.fileId && tick.jobId) {
              swapPlaybackToGrowingCache(item, tick.fileId, tick.jobId, f.fileId).catch(() => {});
            }
            loadingTick(item);
            // Per-chunk tick over the Luna bridge — coalesced to one DOM
            // rebuild per animation frame (see scheduleRenderQueue above).
            // The terminal states (drive-ready / error / cooldown, below and
            // in the outer caller) still call renderQueue() directly for an
            // immediate, unthrottled paint.
            scheduleRenderQueue();
            if (tick.status === 'ready') {
              finished = true;
              item.driveFiles.push({ fileId: tick.fileId, seedrFileId: f.fileId, size: fileTotal, name: f.name });
              // Migrate the user's resume position from the seedr fileId
              // to the Drive fileId. The instant-play flow saved CW under
              // the seedr fileId; once Drive holds the file the seedr
              // copy will be deleted, so we re-key the entry now to keep
              // the playhead alive across that transition. Tag the entry with
              // the backing store's source so a later resume routes to the
              // cache/Drive player, not the (now-gone) seedr path.
              try {
                Storage.migrateResume(f.fileId, tick.fileId,
                  { source: item._backend === 'laptop' ? 'laptop' : (item._backend === 'cache' ? 'cache' : 'drive') });
              } catch (_) {}
              if (backend === LaptopCache) completeCachePlayback(item, tick.fileId, f.fileId).catch(() => {});
              aggDone += fileTotal;
              // NOTE: do not bump `aggTotal` here — the live `pct` calc above
              // already adds `fileTotal` to the denominator. Adding it again
              // on completion makes the bar jump backward at every file
              // boundary inside a multi-file pack.
              resolve();
            }
          });
        });

      let _uploadedOk = false;
      // Only a real Seedr source failure hands the title to the laptop torrent
      // engine; a slow or unreachable laptop does not (a timed-out admission
      // once sent a healthy Seedr title to a torrent tunnel that was down).
      let sawSourceFailure = false;
      const seedrSourceFailed = error =>
        /\b(?:403|404|410)\b|forbidden|not found|no stream url/i.test(String(error || ''));
      for (let _try = 0; _try < 3 && !_uploadedOk; _try++) {
        if (item._uploadCancelled) return;
        if (_try > 0) { item.error = null; await sleep(4000 * _try); }
        if (item._uploadCancelled) return;
        // Only a real source failure needs a new link. Cache admission can
        // reject busy before reading it, so keep this candidate while waiting.
        const sourceUrl = await Seedr.fetchFileUrl(f.fileId).catch(() => null);
        if (item._uploadCancelled) return;
        if (!sourceUrl) { item.error = 'no stream URL from seedr'; sawSourceFailure = true; continue; }
        fileTotal = 0; fileWritten = 0;
        let capacityBackoff = 4000;
        while (!item._uploadCancelled) {
          try {
            await attemptUpload(sourceUrl, _try ? `${dlIdBase}_r${_try}` : dlIdBase);
            _uploadedOk = true;
            break;
          } catch (_) {
            if (seedrSourceFailed(item.error)) sawSourceFailure = true;
            if (!/\bbusy\b/i.test(item.error || '')) break;
            item.error = null;
            item.uploadStage = 'waiting for cache capacity';
            loadingTick(item); scheduleRenderQueue();
            await sleep(capacityBackoff);
            capacityBackoff = Math.min(60000, capacityBackoff * 2);
          }
        }
        // If admission outlasted the URL's lifetime, the accepted job reports
        // a real source error and the outer loop mints a fresh link normally.
        if (item._uploadCancelled) return;
      }
      if (!_uploadedOk) {
        item._cacheCopiesPending = false;
        if (backend === LaptopCache && item.magnet && sawSourceFailure) {
          item._seedrUnavailable = true;
          return _downloadMagnetToLaptop(item);
        }
        // Every attempt failed. Stop the loop so we don't silently succeed-
        // with-missing-files. The outer caller flips phase to 'error' and
        // surfaces a retry option.
        item.phase = 'error';
        persistQueue(); renderQueue(); loadingTick(item);
        return;
      }
      await copySubtitles();
    }
    await copySubtitles();

    item._cacheCopiesPending = false;

    if (item.driveFiles.length > 0) {
      item.phase = 'drive-ready';
      item.pct = 100;
      delete activeWatchers[item.id];
      persistQueue();
      renderQueue();
      toast(`${item._backend === 'laptop' ? 'Saved to laptop cache' : item._backend === 'cache' ? 'Saved to local cache' : 'Saved to Drive'}: ${item.name}`);
      if (currentTab === 'library') renderLibrary();
      // If this exact item is still reading Seedr, take it over immediately at
      // the same absolute playhead. Seeking stays locked until the completed
      // replacement is committed; only then does swapPlaybackToDrive release
      // Seedr and promote the next queued download. When playback is already
      // local (including a cache-resolve hit), no handoff is needed.
      const _cached = cachedPlaybackFile(item, currentVideo);
      const _store = _cached && _cached.fileId;
      const _growingThis = currentVideo && currentVideo._queueItem === item
                           && currentVideo._growingCache
                           && String(currentVideo.fileId) === String(_store);
      const _streamingThis = currentVideo && currentVideo._queueItem === item
                             && currentVideo._directSeedr;
      if (_growingThis) {
        completeCachePlayback(item, _store).then(() => {
          if (currentVideo && currentVideo._queueItem === item && !currentVideo._directSeedr
              && !currentVideo._localHandoffPending) releaseSeedr(item);
        }).catch(() => {});
      } else if (_streamingThis && _store) {
        if (item._backend === 'laptop') {
          // /cache/status state=ready is authoritative: the server has already
          // atomically renamed the complete file, so a second Range probe only
          // adds another round trip before the handoff.
          swapPlaybackToDrive(item, _store);
        } else {
          // The phone-local copy is ready — switch the live seedr stream onto it
          // NOW (a brief re-buffer) instead of finishing on seedr. This gives an
          // immediate on-device copy AND frees the seedr slot right away, so the
          // (already-queued) next episode can start downloading instead of waiting
          // for this one to end. swapPlaybackToDrive migrates the resume position
          // and re-points currentVideo to the cache/Drive source.
          swapPlaybackToDrive(item, _store);
        }
      } else if (!_streamingThis) {
        // Drive/cache has the file permanently. Delete the seedr copy so the
        // slot is free for the next item — the seedr free tier can't carry
        // both the just-watched episode AND whatever's up next.
        releaseSeedr(item);
      }
      // A failed Seedr start leaves autoplay armed, including for packs. Open
      // the cached counterpart of the original main file once it is ready.
      const main = cachedSeedrFile(item, item.mainSeedrFileId);
      if (item.autoplay && !currentVideo && main) {
        item.autoplay = false;
        persistQueue();
        const subs = item.driveSubtitles || null;
        playDriveFile(main.fileId, item.name, item.poster, subs, item.show);
        if (item.show && item.show.season) {
          autoQueueNextEpisode(item).catch(() => {});
        }
      }
    } else {
      item.phase = 'error';
      item.error = item.error || 'no files uploaded';
      persistQueue(); renderQueue();
    }
  }

  // Playback and the copy-only recovery path must select the same pack file.
  function pickSeedrVideo(item, videos) {
    const RE = pickSeedrVideo._re || (pickSeedrVideo._re = {
      underscore: /_/g,
      bonus: /(?:^|[. _-])samples?(?:[. _-]|$)|(?:^|[. _-])(?:extras?|featurettes?|trailers?)(?:[. _-]*\d+)?\.[a-z0-9]+$/i,
    });
    // Samples and labelled bonus clips must not count as another episode or
    // beat the main video. Keep the original manifest/IDs for cache mapping.
    const mainVideos = videos.filter(f => !RE.bonus.test(f.name));
    const show = item.show || {};
    const seasonValue = show.season != null ? show.season : item.season;
    const episodeValue = show.episode != null ? show.episode : item.episode;
    const season = Number(seasonValue), episode = Number(episodeValue);
    const hasEpisode = seasonValue != null && episodeValue != null
      && Number.isInteger(season) && season >= 0 && Number.isInteger(episode) && episode > 0;
    const choices = hasEpisode ? mainVideos.filter(f => {
      // Underscores are word characters, so normalize them for the parser's
      // episode boundaries without changing the stored Seedr filename.
      const p = parseEpisodeName(f.name.replace(RE.underscore, ' '));
      if (mainVideos.length === 1 && !p.episode) return true;
      return p.season === season && p.episode > 0 && p.episode <= episode
        && (p.endEpisode || p.episode) >= episode;
    }) : mainVideos;
    return choices.slice().sort((a, b) => (b.size || 0) - (a.size || 0))[0] || null;
  }

  function persistQueue() {
    // `magnet` is persisted so pending items can be promoted after a reboot
    // — without it we'd have no way to send the magnet to seedr later.
    // `autoplay` is persisted so a mid-flight seedr download with autoplay
    // intent survives a brief tab switch — but boot() clears it once on
    // load so a long-stale queue doesn't pop the player on the next launch.
    Storage.set('queue', queue.map(({ id, name, magnet, infoHash, pct, total, durationSeconds, folderId, folderName, poster, phase, driveFiles, driveSubtitles, mainSeedrFileId, seedrVideos, show, addedAt, autoplay, _torrentFallback, _torrentJobId, _backend, uploadStage }) =>
      ({ id, name, magnet, infoHash, pct, total, durationSeconds, folderId, folderName, poster, phase, driveFiles, driveSubtitles, mainSeedrFileId, seedrVideos, show, addedAt, autoplay, _torrentFallback, _torrentJobId, _backend, uploadStage })));
  }
  function loadQueue() {
    queue = Storage.get('queue', []);
    // `drive-ready` items used to be filtered out here because the old
    // copyToGdrive removed them from the queue on success. The new flow
    // keeps them visible (they're playable Library entries), but if a
    // user manually removed all the things they want to keep we still
    // honour the prior intent — drop nothing here.
    // Boot-time autoplay reset, narrowed: keep the flag on items that are
    // still mid-flight (queued / seedring / seedred / copying) so a download
    // the user explicitly asked to autoplay still pops the player when it
    // finishes — even if the app was closed and reopened in between. Only
    // wipe the flag on items already past the playback gate (drive-ready /
    // played) or stuck in error, where re-autoplay would be surprising.
    const PENDING = new Set(['queued', 'seedring', 'seedred', 'copying', 'cooldown']);
    queue.forEach(it => {
      if (!it) return;
      // An item persisted in 'adding' means the app crashed between push-to-queue
      // and the Seedr.addMagnet() call confirming acceptance. Seedr never saw the
      // magnet, so startWatch would poll indefinitely. Reset to 'pending' so
      // promoteNextPending() re-sends the magnet cleanly on next boot.
      if (it.phase === 'adding') it.phase = 'pending';
      // An item persisted in 'cooldown' has a valid folderId — it was between
      // two file uploads. Reset to 'seedred' so resumeUpload picks it up.
      if (it.phase === 'cooldown') it.phase = 'seedred';
      // An item persisted mid-copy ('copying') was streaming seedr→cache/Drive
      // when the app died. Its in-memory copy loop is gone with the old JS
      // runtime, but resumeUpload's same-session guard skips 'copying', so
      // boot()'s recovery sweep would leave it ORPHANED forever — clogging the
      // next-episode auto-queue's `pending>=2` guard so nothing new downloads.
      // Reset to 'seedred' (it still has a folderId) so the boot sweep re-drives
      // the copy from seedr.
      if (it.phase === 'copying' && !it._torrentFallback) { it.phase = 'seedred'; it._uploadStarted = false; }
      if (!PENDING.has(it.phase)) it.autoplay = false;
    });
    Storage.set('queue', queue);
  }

  // ---------- KeepWatching: never lose a half-watched video to a wipe ----------
  // When the seedr staging area is about to be wiped, any file the user is
  // part-way through gets copied seedr→pen first (aria2 on the phone, LAN-
  // independent), its Continue Watching entry re-keyed to the pen copy, and
  // the pen copy expires 3 days after the last watch (phone-side cleanup).
  let _keepWatchPending = null;      // { promise, folderIds:Set, fileIds:Set }
  let _keepWatchOnProgress = null;   // live progress sink for the blocking path

  // Regexes hoisted so _penBasename never rebuilds them per call.
  const _PEN_BASENAME_STRIP_RE = /[\\/:*?"<>|]+/g;
  const _PEN_BASENAME_EXT_RE = /\.[a-z0-9]{2,4}$/i;
  function _penBasename(title) {
    let base = String(title || '').split(' — ').pop().trim()
      .replace(_PEN_BASENAME_STRIP_RE, '_');
    if (!_PEN_BASENAME_EXT_RE.test(base)) base += '.mkv';
    return base || 'video.mkv';
  }

  // Start seedr→pen copies for half-watched files and return the seedr folder
  // ids the clean must keep alive until those copies land. Non-blocking by
  // default: the migration finishes in the background. opts.blocking makes it
  // wait (used when seedr MUST be fully emptied, e.g. quota-full retry).
  async function preserveHalfWatchedSeedr(opts = {}) {
    if (typeof PhoneDL === 'undefined' || !PhoneDL.available()) return null;
    _keepWatchOnProgress = opts.onProgress || null;
    // A previous wipe's preservation may still be copying — don't restart it,
    // just honor its folder exclusions (and wait for it in blocking mode).
    if (_keepWatchPending) {
      if (opts.blocking) { try { await _keepWatchPending.promise; } catch (_) {} }
      return _keepWatchPending._done ? null : {
        folderIds: [..._keepWatchPending.folderIds],
        fileIds: [..._keepWatchPending.fileIds],
      };
    }
    const cw = Storage.listContinue()
      .filter(x => x.source === 'seedr' && x.fileId)
      .filter(x => (x.position || 0) > 300
                && (!x.duration || (x.position / x.duration) < 0.92))
      .filter(x => !(currentVideo && String(currentVideo.fileId) === String(x.fileId)))
      .slice(0, 2);
    if (!cw.length) return null;
    let rootFolders = [];
    try { rootFolders = ((await Seedr.listContents()) || {}).folders || []; } catch (_) {}
    const jobs = [];
    const folderIds = new Set();
    // Two half-watched files can land in the same seedr folder search — cache
    // each folder's file listing so the second item's scan reuses the first
    // item's network round-trips instead of re-walking folders it already saw.
    // Only successful walks are cached; a transient failure isn't remembered,
    // so the next item still gets a fresh attempt at that folder.
    const _folderFilesCache = new Map();
    async function _walkFolderCached(id) {
      if (_folderFilesCache.has(id)) return _folderFilesCache.get(id);
      const files = await Seedr.walkFolder(id);
      _folderFilesCache.set(id, files);
      return files;
    }
    for (const it of cw) {
      try {
        let f = null;
        try { f = await Seedr.fetchFile(it.fileId); } catch (_) {}
        if (!f || !f.url) {
          // Source already gone from seedr — skip straight to the torrent
          // fallback if this entry knows its magnet.
          if (it.magnet) queueSilentPenDownload({ fileId: it.fileId, magnet: it.magnet,
            infoHash: it.infoHash, title: it.title, poster: it.poster }).catch(() => {});
          continue;
        }
        const base = _penBasename(f.name || it.title);
        // Already saved once (fully — findKeepWatchCopy skips in-flight
        // partials)? Just re-key the resume entry, don't copy again.
        const already = await findKeepWatchCopy(base).catch(() => null);
        if (already) {
          Storage.migrateResume(it.fileId, 'phone:' + already);
          const pe = Storage.getResume('phone:' + already);
          if (pe) Storage.setResume('phone:' + already, { ...pe, source: 'phone', fileId: 'phone:' + already });
          continue;
        }
        const r = await PhoneDL.add(f.url, { dir: KEEPWATCH_REL, out: base });
        let jobFolder = null;
        for (const fo of rootFolders) {
          try {
            const files = await _walkFolderCached(fo.id);
            if (files.some(x => String(x.fileId) === String(it.fileId))) {
              jobFolder = fo.id;
              folderIds.add(fo.id); break;
            }
          } catch (_) {}
        }
        // Carry the torrent identity so a failed copy can fall back to a
        // silent full re-download. The CW entry has it for recent plays;
        // otherwise the (not-yet-cleared) queue item for this folder does.
        const qItem = queue.find(q => q.folderId && jobFolder != null
                                   && String(q.folderId) === String(jobFolder));
        jobs.push({ fileId: it.fileId, gid: r.gid, folderId: jobFolder,
                    rel: r.rel || (KEEPWATCH_REL + '/' + base),
                    magnet: it.magnet || (qItem && qItem.magnet) || null,
                    infoHash: String(it.infoHash || (qItem && qItem.infoHash) || '').toLowerCase(),
                    title: it.title || (qItem && qItem.name) || '',
                    poster: it.poster || (qItem && qItem.poster) || null });
      } catch (e) { console.warn('[keepwatch] save failed:', e); }
    }
    if (!jobs.length) return null;
    toast('Saving your half-watched video to the pen…', 3500);
    const state = { folderIds, fileIds: new Set(jobs.map(j => j.fileId)), _done: false };
    state.promise = _waitKeepWatchJobs(jobs, folderIds)
      .catch(() => {})
      .then(() => { state._done = true; if (_keepWatchPending === state) _keepWatchPending = null; });
    _keepWatchPending = state;
    if (opts.blocking) { try { await state.promise; } catch (_) {} return null; }
    return { folderIds: [...folderIds], fileIds: [...state.fileIds] };
  }

  // Is a KeepWatching copy verifiably COMPLETE on the pen? Present by exact
  // name, and no .aria2 sidecar (aria2 keeps one next to the data until the
  // download truly finishes).
  async function _keepWatchComplete(rel) {
    try {
      const data = await Phone.listFiles(KEEPWATCH_REL);
      const base = String(rel).split('/').pop();
      const names = new Set((data.entries || []).map(e => e.name));
      return names.has(base) && !names.has(base + '.aria2');
    } catch (_) { return false; }
  }

  // Poll the pen copies; when they land, re-key the resume entries to the pen
  // ('phone:' + rel) and delete the now-redundant seedr folders.
  //
  // The pen is the arbiter, not aria2's status: a job that errored, timed out,
  // or got purged does NOT migrate and does NOT free its seedr folder — the
  // source must never be wiped before a verified copy exists. Unfinished
  // copies keep downloading phone-side; the next wipe (or the next click on
  // the tile) adopts the finished copy and frees the folder then.
  async function _waitKeepWatchJobs(jobs, folderIds) {
    const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline) {
      const list = await PhoneDL.list().catch(() => []);
      // Index once per poll so each job is an O(1) lookup instead of a
      // list.find() scan — matters once PhoneDL is tracking several transfers.
      const byGid = new Map(list.map(x => [x.gid, x]));
      let settled = 0, doneB = 0, totB = 0;
      for (const j of jobs) {
        const d = byGid.get(j.gid);
        if (!d) { settled++; continue; }            // purged — verified below anyway
        if (d.status === 'complete') { settled++; doneB += d.total || 0; totB += d.total || 0; continue; }
        if (d.status === 'error')    { j.failed = true; settled++; continue; }
        doneB += d.done || 0; totB += d.total || 0;
      }
      if (_keepWatchOnProgress && totB) {
        try { _keepWatchOnProgress(Math.min(100, (doneB / totB) * 100)); } catch (_) {}
      }
      if (settled >= jobs.length) break;
      await new Promise(r => setTimeout(r, 2500));
    }
    const freedFolders = [];
    for (const j of jobs) {
      const ok = !j.failed && await _keepWatchComplete(j.rel);
      if (!ok) {
        // The pen copy didn't make it (source died / too slow / forced empty).
        // If we know the original torrent, silently re-download the whole
        // thing to the pen — it'll simply be there next time play is pressed.
        if (j.magnet) queueSilentPenDownload(j).catch(() => {});
        continue;
      }
      const key = 'phone:' + j.rel;
      Storage.migrateResume(j.fileId, key);
      const e = Storage.getResume(key);
      if (e) Storage.setResume(key, { ...e, source: 'phone', fileId: key });
      try {
        Phone.postWatchState({ key, rel: j.rel, title: (e && e.title) || '',
                               position: (e && e.position) || 0,
                               duration: (e && e.duration) || 0, ts: Date.now() });
      } catch (_) {}
      if (j.folderId != null) freedFolders.push(j.folderId);
    }
    if (freedFolders.length) {
      try { await Seedr.deleteItems({ folder_ids: freedFolders }); } catch (_) {}
    }
  }

  // Silent background re-download of a lost half-watched video, straight to
  // the pen via the phone's aria2 (regular torrent, no seedr involved).
  // Registers Watch Later metadata so the Library shows it with its poster,
  // and tags the still-seedr-keyed resume entry with the torrent hash so
  // resumeSeedrItem can adopt the finished download on the next play.
  async function queueSilentPenDownload(j) {
    if (typeof PhoneDL === 'undefined' || !PhoneDL.available()) return;
    try {
      const r = await PhoneDL.add(j.magnet);
      const hash = String(j.infoHash || '').toLowerCase();
      const key = hash || (j.magnet || '').slice(0, 60);
      const all = wlMetaAll();
      if (!all[key]) {
        all[key] = { hash, gid: r.gid, title: j.title || 'Recovering video…',
                     name: j.title || '', poster: j.poster || null, year: '',
                     kind: 'movie', sizeBytes: 0, rel: '', addedAt: Date.now() };
        wlMetaSetAll(all);
      }
      const e = Storage.getResume(j.fileId);
      if (e) Storage.setResume(j.fileId, { ...e, redownloadHash: hash });
      console.log('[keepwatch] silently re-downloading via torrent:', j.title);
    } catch (e2) { console.warn('[keepwatch] re-queue failed:', e2); }
  }

  // Reusable wipe: cancel uploads, Seedr.clean(), empty queue.
  // Used by (a) the "Wipe queue + seedr" header button on the Queue tab
  // and (b) the auto-priority path in addToQueue when the user picks
  // something while the slot/quota is occupied.
  //
  // No confirmation prompt — the button is destructive but explicit,
  // and the auto-priority path is invoked from a user click that the
  // user intends to take priority. A toast records what happened.
  //
  // Half-watched files are copied to the pen first (see above) — their seedr
  // folders survive this wipe and are deleted by the background migration
  // once the pen copy lands. opts.blocking forces a full empty (waits for the
  // copies) for the quota-full retry path.
  async function wipeQueueAndSeedr(reason, silent, opts = {}) {
    const hadItems = queue.length > 0;
    // Cancel any in-flight Drive uploads so the keep-alive workers
    // don't keep trying after we yank the seedr folder underneath.
    try {
      for (const it of queue) {
        it._uploadCancelled = true;
        it._seedrReleaseGen = (it._seedrReleaseGen || 0) + 1;
        if (it._seedrReleaseTimer) clearTimeout(it._seedrReleaseTimer);
        it._seedrReleaseTimer = 0;
        try { it._uploadHandle && it._uploadHandle.cancel(); } catch (_) {}
      }
    } catch (_) {}
    // Stop the per-item seedr watchers so they don't fire post-clean.
    try {
      for (const id of Object.keys(activeWatchers || {})) {
        try { activeWatchers[id] && activeWatchers[id](); } catch (_) {}
        delete activeWatchers[id];
      }
    } catch (_) {}
    if (Seedr.isLoggedIn()) {
      let keep = null;
      try { keep = await preserveHalfWatchedSeedr(opts); }
      catch (e) { console.warn('[keepwatch]', e); }
      try { await Seedr.clean(keep && keep.folderIds); }
      catch (e) { console.warn('Seedr.clean failed:', e); }
    }
    queue.length = 0;
    persistQueue();
    renderQueue();
    if (silent) return;
    if (reason) toast(reason);
    else if (hadItems) toast('Queue + seedr wiped');
    else toast('Nothing to wipe');
  }

  let _queueWipeBound = false;
  function bindQueueWipeButton() {
    if (_queueWipeBound) return;
    const btn = document.getElementById('queue-wipe-all');
    if (!btn) return;
    _queueWipeBound = true;
    btn.onclick = async () => {
      const prev = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Wiping…';
      try { await wipeQueueAndSeedr(); }
      finally {
        btn.disabled = false;
        btn.textContent = prev;
      }
    };
  }

  // renderQueue runs on every seedr/upload progress tick (startWatch's
  // Seedr.watch callback, resumeUpload, promoteNextPending, …) — potentially
  // several times a second while something is downloading. The original
  // implementation nuked #queue-list and rebuilt every row (createElement +
  // innerHTML + a fresh poster <div>) on every single tick, which is pure
  // layout/paint/GC churn for what's almost always just a percentage and a
  // bar width changing. Rows are now cached per queue-item id and only their
  // dynamic bits (text/width/visibility) are touched; the row's identity, its
  // DPad tabIndex/focus state, and its click handler all survive re-renders.
  const _queueRows = new Map();   // item.id -> row element (with ._els cached)
  const _RETRY_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 11-9-9"/><path d="M21 4v5h-5"/></svg>';
  const _REMOVE_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>';
  // Upload-stage → status text. Hoisted so renderQueue doesn't allocate this
  // little lookup object fresh for every row on every tick.
  const _UPLOAD_STAGE_TEXT = {
    starting:            'Preparing upload…',
    authorizing:         'Authorizing with Drive…',
    'opening-session':   'Opening Drive session…',
    'connecting-source': 'Connecting to seedr…',
    streaming:           null,   // fall through to %-based text
    uploading:           null,
  };

  function _makeQueueRow() {
    const row = document.createElement('div');
    row.className = 'q-row';
    row.tabIndex = 0;
    row.innerHTML = `
      <div class="q-poster"></div>
      <div class="q-body">
        <div class="q-name"></div>
        <div class="q-sub muted" hidden></div>
        <div class="q-meta"></div>
        <div class="q-bar"><div class="q-bar-fill"></div></div>
      </div>
      <button class="q-retry" tabindex="0" aria-label="Retry" style="display:none;">${_RETRY_SVG}</button>
      <button class="q-remove" tabindex="0" aria-label="Remove">${_REMOVE_SVG}</button>
    `;
    row._els = {
      poster: row.querySelector('.q-poster'),
      name:   row.querySelector('.q-name'),
      sub:    row.querySelector('.q-sub'),
      meta:   row.querySelector('.q-meta'),
      fill:   row.querySelector('.q-bar-fill'),
      retry:  row.querySelector('.q-retry'),
    };
    row.onclick = (e) => {
      if (e.target.closest('.q-retry')) { retryItem(row._item); return; }
      if (e.target.closest('.q-remove')) { removeFromQueue(row._item); return; }
      if (row._ready) { playFromQueue(row._item); return; }
      if (row._stuckUpload) {
        toast(`Retrying upload: ${row._item.name}`);
        resumeUpload(row._item);
        return;
      }
      toast(row._meta);
    };
    return row;
  }

  function renderQueue() {
    bindQueueWipeButton();
    const list = document.getElementById('queue-list');
    if (!list) return;
    if (queue.length === 0) {
      _queueRows.clear();
      list.innerHTML = '<p class="muted" style="padding:20px;">No active downloads. Pick something to watch from Home or Search.</p>';
      return;
    }
    const liveIds = new Set();
    queue.forEach(item => {
      liveIds.add(item.id);
      const ready = item.phase === 'drive-ready' || item.phase === 'cloud-ready' || (item.pct >= 100 && item.folderId);
      const stuckUpload = item.folderId
        && item.phase !== 'copying'
        && item.phase !== 'cooldown'
        && item.phase !== 'drive-ready'
        && item.phase !== 'cloud-ready';
      let meta;
      if (item.error && stuckUpload)           meta = `Error: ${item.error} · tap to retry`;
      else if (item.error)                     meta = `Error: ${item.error}`;
      else if (item.phase === 'drive-ready')   meta = 'On Drive';
      else if (item.phase === 'cloud-ready')   meta = 'In seedr';
      else if (item.phase === 'copying') {
        const stageText = _UPLOAD_STAGE_TEXT[item.uploadStage];
        if (item._torrentFallback) {
          meta = item.uploadStage === 'waiting for laptop torrent slot'
            ? 'Waiting for laptop download slot…'
            : `Downloading to laptop · ${(item.pct || 0).toFixed(1)}%`;
        } else if (stageText) {
          meta = stageText;
        } else if ((item.uploadWritten || 0) === 0 && (item.uploadReceived || 0) > 0) {
          // Bytes are flowing from seedr but no chunk has landed on Drive yet.
          // Show buffering with the % so user sees movement.
          meta = `Buffering from seedr · ${item.pct.toFixed(1)}%`;
        } else {
          meta = `Uploading to Drive · ${item.pct.toFixed(1)}%`;
        }
      }
      else if (item.phase === 'cooldown') {
        const wait = Math.max(0, (item.cooldownUntil || 0) - Date.now());
        const m = Math.ceil(wait / 60_000);
        meta = `Next episode in ${m} min`;
      }
      else if (item.phase === 'pending')       meta = 'Waiting — seedr free tier downloads one at a time';
      else if (item.phase === 'adding')        meta = 'Adding to seedr…';
      else if (item.phase === 'seedred')       meta = 'Preparing upload…';
      // seedring: a torrent that seedr hasn't started (or has briefly dropped
      // from its active list before any progress) reports queued — show that
      // instead of a bare "0.0% · 0 B/s", matching the loading overlay.
      else if (item.queued)                    meta = 'Queued on seedr…';
      else                                     meta = `${(item.pct || 0).toFixed(1)}% · ${fmtSize(item.speed || 0)}/s`;
      const titleLine = item.show && item.show.season
        ? `${item.show.title} · S${String(item.show.season).padStart(2,'0')}E${String(item.show.episode).padStart(2,'0')}`
        : item.name;
      const subLine = item.show && item.show.season ? item.name : '';
      // Show the Retry button for items that are explicitly in error or
      // visibly stuck (folder on seedr but Drive upload didn't kick in).
      // Other phases (seedring / copying / cooldown / ready) don't need
      // a retry surface — they're either in flight or already done.
      const showRetry = item.phase === 'error' || stuckUpload;

      let row = _queueRows.get(item.id);
      if (!row) { row = _makeQueueRow(); _queueRows.set(item.id, row); }
      row._item = item;
      row._ready = ready;
      row._stuckUpload = stuckUpload;
      row._meta = meta;
      const els = row._els;
      els.poster.style.backgroundImage = item.poster ? `url('${escapeCssUrl(item.poster)}')` : 'none';
      els.name.textContent = titleLine;
      els.sub.hidden = !subLine;
      if (subLine) els.sub.textContent = subLine;
      els.meta.textContent = meta;
      els.fill.style.width = `${Math.min(100, Math.max(0, item.pct || 0)).toFixed(1)}%`;
      // .q-retry has an author `display:flex` rule in app.css, which beats the
      // UA stylesheet's [hidden]{display:none} on origin precedence — toggling
      // the `hidden` attribute alone would NOT actually hide this button (it
      // did hide correctly in the original because the element was simply
      // absent from the DOM when !showRetry). Set inline display explicitly
      // instead, since inline style always wins the cascade.
      els.retry.style.display = showRetry ? '' : 'none';
      // Reusing nodes means order matters: append in current queue order.
      // appendChild on an already-attached node just moves it — no teardown.
      list.appendChild(row);
    });
    // Drop rows for items no longer in the queue (removed / retried away).
    for (const [id, row] of _queueRows) {
      if (!liveIds.has(id)) { row.remove(); _queueRows.delete(id); }
    }
  }

  // Manually retry a stuck queue item. Two cases:
  //  - item already has a seedr folder → re-fire copyToGdrive (the Drive
  //    upload is what was stuck).
  //  - no folder → re-send the magnet to seedr. Goes to 'pending' if the
  //    slot is busy, else straight to 'seedring'.
  function retryItem(item) {
    if (!item) return;
    item.error = null;
    if (item.folderId) {
      item._uploadStarted = false;       // let resumeUpload re-arm
      item.phase = 'seedred';
      persistQueue(); renderQueue();
      resumeUpload(item);
      toast(`Retrying upload: ${item.name}`);
      return;
    }
    if (!item.magnet) {
      toast('No magnet to retry — remove and re-add');
      return;
    }
    // No folder — start over on the seedr side. promoteNextPending /
    // seedrSlotBusy ensure we respect the 1-active-download rule.
    if (seedrSlotBusy(item.id)) {
      item.phase = 'pending';
      persistQueue(); renderQueue();
      toast('Queued — waiting for slot');
      return;
    }
    item.phase = 'adding';
    persistQueue(); renderQueue();
    Seedr.addMagnet(item.magnet)
      .then(() => {
        item.phase = 'seedring';
        persistQueue(); renderQueue();
        startWatch(item);
        toast(`Retrying: ${item.name}`);
      })
      .catch(e => {
        item.phase = 'error';
        item.error = String(e.message || e);
        persistQueue(); renderQueue();
        toast('Retry failed: ' + e.message);
      });
  }

  // Remove an item from the queue. If the item still owns a seedr folder,
  // delete that too so it doesn't sit there counting against the quota.
  async function removeFromQueue(item) {
    const wasActive = item.phase === 'seedring' || item.phase === 'adding';
    const idx = queue.findIndex(q => q.id === item.id);
    if (idx < 0) return;
    queue.splice(idx, 1);
    item.autoplay = false;
    item._uploadCancelled = true;
    item._seedrReleaseGen = (item._seedrReleaseGen || 0) + 1;
    try { item._uploadHandle && item._uploadHandle.cancel(); } catch (_) {}
    if (item._seedrReleaseTimer) clearTimeout(item._seedrReleaseTimer);
    item._seedrReleaseTimer = 0;
    if (activeWatchers[item.id]) {
      try { activeWatchers[item.id](); } catch (_) {}
      delete activeWatchers[item.id];
    }
    persistQueue();
    renderQueue();
    toast(`Removed: ${item.name}`);
    if (item.folderId && Seedr.isLoggedIn()) {
      Seedr.deleteItems({ folder_ids: [item.folderId] }).catch(() => {});
    }
    // The seedr slot just freed up — start the next pending magnet.
    if (wasActive) promoteNextPending();
    // A remove is a full removal: also purge Continue Watching, the downloaded
    // file, any pen download, and blocklist the title so self-heal never brings
    // it back on its own.
    const f = (item.driveFiles && item.driveFiles[0]) || null;
    purgeTitle({ fileId: f ? f.fileId : null, title: item.name, infoHash: item.infoHash, show: item.show });
  }

  // ---- Removed blocklist ---------------------------------------------------
  // Titles the user explicitly removed. self-heal (refetchAndResume) and any
  // background auto-queue consult this so a removed title never silently
  // re-downloads. Cleared the moment the user deliberately re-adds it (a pick).
  const _REMKEY_EXT_RE = /\.(mkv|mp4|avi|mov|m4v|webm|ts)$/i;
  const _REMKEY_CLEAN_RE = /[^a-z0-9]+/g;
  function _remKey(s) {
    return String(s || '').toLowerCase()
      .replace(_REMKEY_EXT_RE, '')
      .replace(_REMKEY_CLEAN_RE, ' ').trim();
  }
  function markRemoved({ hash, title }) {
    const s = Storage.get('removed', {}); const now = Date.now();
    if (hash)  s['h:' + String(hash).toLowerCase()] = now;
    if (title) s['t:' + _remKey(title)] = now;
    Storage.set('removed', s);
  }
  function isRemoved({ hash, title }) {
    const s = Storage.get('removed', {});
    if (hash && s['h:' + String(hash).toLowerCase()]) return true;
    if (title && s['t:' + _remKey(title)]) return true;
    return false;
  }
  function unmarkRemoved({ hash, title }) {
    const s = Storage.get('removed', {}); let changed = false;
    const hk = hash ? 'h:' + String(hash).toLowerCase() : null;
    const tk = title ? 't:' + _remKey(title) : null;
    if (hk && s[hk]) { delete s[hk]; changed = true; }
    if (tk && s[tk]) { delete s[tk]; changed = true; }
    if (changed) Storage.set('removed', s);
  }

  // Completely remove a title: its Continue Watching entry(ies), the downloaded
  // file (phone cache / Drive), any queue entries + their seedr folders, any
  // in-flight pen download, and blocklist it so self-heal never re-fetches it.
  async function purgeTitle(it) {
    if (!it) return;
    const fileId = it.fileId || '';
    const title  = it.title || it.name || it.key || '';
    const hash   = String(it.redownloadHash || it.infoHash || '').toLowerCase();
    const key    = _remKey(title);
    // 1) Continue Watching — this entry and any alias/dupe for the same file/title.
    try {
      if (fileId) Storage.clearResume(fileId);
      Storage.listContinue().forEach(e => {
        if ((fileId && e.fileId === fileId) || (key && _remKey(e.title || e.key) === key)) {
          try { Storage.clearResume(e.fileId); } catch (_) {}
        }
      });
    } catch (_) {}
    // 2) Delete the actual file (laptop cache / phone cache / Drive).
    try {
      if (fileId && typeof LaptopCache !== 'undefined' && LaptopCache.isCacheId(fileId)) {
        await LaptopCache.del(fileId).catch(() => {});
      } else if (fileId && typeof PhoneCache !== 'undefined' && PhoneCache.isCacheId(fileId)) {
        await PhoneCache.del(fileId).catch(() => {});
      } else if (fileId && typeof Drive !== 'undefined' && Drive.isSignedIn && Drive.isSignedIn()) {
        await Drive.del(fileId).catch(() => {});
      }
    } catch (_) {}
    // 3) Any queue entries for this title/hash + their seedr folders.
    try {
      const gone = queue.filter(q =>
        (hash && (q.infoHash || '').toLowerCase() === hash) ||
        (key && _remKey(q.name) === key));
      for (const q of gone) {
        q.autoplay = false;
        q._uploadCancelled = true;
        q._seedrReleaseGen = (q._seedrReleaseGen || 0) + 1;
        try { q._uploadHandle && q._uploadHandle.cancel(); } catch (_) {}
        if (q._seedrReleaseTimer) clearTimeout(q._seedrReleaseTimer);
        q._seedrReleaseTimer = 0;
        if (activeWatchers[q.id]) { try { activeWatchers[q.id](); } catch (_) {} delete activeWatchers[q.id]; }
        if (q.folderId && Seedr.isLoggedIn()) Seedr.deleteItems({ folder_ids: [q.folderId] }).catch(() => {});
      }
      if (gone.length) { queue = queue.filter(q => gone.indexOf(q) < 0); persistQueue(); renderQueue(); }
    } catch (_) {}
    // 4) Cancel any in-flight pen (PhoneDL) download for this hash.
    try {
      if (hash && typeof PhoneDL !== 'undefined' && PhoneDL.available()) {
        const raw = await PhoneDL.list().catch(() => []);
        for (const x of (raw || [])) {
          if ((x.infohash || '').toLowerCase() === hash && x.gid) await PhoneDL.remove(x.gid).catch(() => {});
        }
      }
    } catch (_) {}
    // 5) Blocklist so self-heal / auto-queue never bring it back on their own.
    markRemoved({ hash, title });
  }

  function playFromQueue(item) {
    if (item.phase === 'drive-ready' && item.driveFiles && item.driveFiles.length) {
      const main = [...item.driveFiles].sort((a, b) => b.size - a.size)[0];
      playDriveFile(main.fileId, item.name, item.poster, item.driveSubtitles, item.show);
      return;
    }
    if (item.folderId) { playFolder(item); return; }
    toast('Nothing to play');
  }

  // ---------- Live TV ----------
  // Channel list comes from the configured LiveTV playlist source.
  // Each tile shows the channel logo + name +
  // FTA channel number. Click → openPlayer(streamUrl, name, {source:'live'}).
  let _liveCache = null;
  let _liveCategory = '';
  // Cached refs to the (static, never-recreated) Live tab DOM nodes — this
  // view re-renders on every category-chip click, so skip the repeated
  // querySelector churn.
  let _liveGridEl = null, _liveStatusEl = null, _liveGroupsEl = null;
  function _liveEls() {
    if (!_liveGridEl) {
      _liveGridEl = $('#live-grid');
      _liveStatusEl = $('#live-status');
      _liveGroupsEl = $('#live-groups');
    }
    return { grid: _liveGridEl, status: _liveStatusEl, groupBar: _liveGroupsEl };
  }

  // Source toggle for the merged Live tab — 'fta' (configured FTA playlist) or
  // 'intl' (iptv-org world directory). renderLive()/renderInternational()
  // below are untouched from their pre-merge selves (same ids, same fetch/
  // render logic); this just decides which one runs and which panel shows.
  let liveSource = Storage.get('liveSource', 'fta');
  let _liveSourceBound = false;
  function _bindLiveSourceToggle() {
    if (_liveSourceBound) return;
    _liveSourceBound = true;
    $$('#live-source .chip').forEach((c) => {
      c.onclick = () => {
        const next = c.dataset.source || 'fta';
        if (next === liveSource) return;
        // Switching away from International within the tab (not just
        // leaving the tab entirely, which showTab's own check covers).
        const leavingIntl = liveSource === 'intl' && next !== 'intl';
        liveSource = next;
        Storage.set('liveSource', liveSource);
        if (leavingIntl) releaseInternational();
        renderLiveTab();
      };
    });
  }
  function renderLiveTab() {
    _bindLiveSourceToggle();
    $$('#live-source .chip').forEach(c => c.classList.toggle('is-active', (c.dataset.source || 'fta') === liveSource));
    const ftaPanel = $('#live-panel-fta');
    const intlPanel = $('#live-panel-intl');
    if (ftaPanel) ftaPanel.hidden = liveSource !== 'fta';
    if (intlPanel) intlPanel.hidden = liveSource !== 'intl';
    if (liveSource === 'intl') renderInternational();
    else renderLive();
  }

  async function renderLive() {
    const { grid, status, groupBar } = _liveEls();
    if (!_liveCache) {
      grid.innerHTML = '';
      status.textContent = 'Loading channels…';
    }
    let channels = _liveCache;
    try {
      channels = await LiveTV.fetchChannels();
      _liveCache = channels;
    } catch (e) {
      status.textContent = `Couldn't load the configured playlist: ${e.message}`;
      return;
    }
    status.textContent = '';

    // Backfill `category` for any cached channels saved before the
    // categoriser shipped — they'll be missing the field on first launch.
    for (const c of channels) {
      if (!c.category) c.category = LiveTV.categorize(c);
    }

    // Topical category chips (News / Sports / Kids / …). User-configured
    // playlists may group channels geographically; derive topical categories
    // from channel names for browsing.
    const categories = LiveTV.listCategories(channels);
    groupBar.innerHTML = `
      <button class="chip ${_liveCategory === '' ? 'is-active' : ''}" data-c="">All (${channels.length})</button>
      ${categories.map(c => `
        <button class="chip ${_liveCategory === c.name ? 'is-active' : ''}" data-c="${escapeHtml(c.name)}">${escapeHtml(c.name)} (${c.count})</button>
      `).join('')}`;
    $$('#live-groups .chip').forEach(c => {
      c.onclick = () => {
        _liveCategory = c.dataset.c || '';
        renderLive();
      };
    });

    const filtered = _liveCategory ? channels.filter(c => c.category === _liveCategory) : channels;
    const frag = document.createDocumentFragment();
    for (const ch of filtered) {
      const t = document.createElement('button');
      t.className = 'live-tile';
      t.tabIndex = 0;
      t.dataset.heroTitle = ch.name;
      t.dataset.heroSubtitle = ch.chno
        ? `Ch ${ch.chno} · Live · ${ch.category || 'FTA'}`
        : `Live · ${ch.category || 'FTA'}`;
      const logo = ch.logo
        ? `<div class="live-tile-logo" style="background-image:url('${escapeCssUrl(ch.logo) || ch.logo}');"></div>`
        : `<div class="live-tile-logo"></div>`;
      t.innerHTML = `
        ${ch.chno ? `<div class="live-tile-chno">CH ${ch.chno}</div>` : ''}
        <div class="live-tile-live">LIVE</div>
        ${logo}
        <div class="live-tile-name">${escapeHtml(ch.name)}</div>
      `;
      t.onclick = () => playLive(ch);
      frag.appendChild(t);
    }
    grid.innerHTML = '';
    grid.appendChild(frag);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const first = $('#live-grid .live-tile');
      const _activeTab1 = document.querySelector('.tab.is-active');
      if (first && _activeTab1 && _activeTab1.id === 'tab-live') {
        // Only steal focus if the user is still on the Live tab — they may
        // have navigated away during the fetch.
        if (!document.querySelector('#tab-live .is-focused')) DPad.focus(first);
      }
    }));
  }

  async function playLive(ch) {
    if (!ch || !ch.url) { toast('No stream URL'); return; }
    const streamUrl = ch.url;
    const fallbacks = Array.isArray(ch.fallbacks) ? ch.fallbacks.slice() : [];
    openPlayer(streamUrl, ch.name, {
      source: 'live',
      poster: ch.logo || null,
      // Give the player a stable, channel-scoped fileId so resume bookkeeping
      // is uniform — we'll skip the actual resume save in persistCurrentResume
      // for live streams, but having an id avoids null-checks elsewhere.
      fileId: 'live:' + ch.id,
      // Alternate URLs for the same channel (iptv-org often lists 3-5 mirrors
      // per channel). On a stream error the player walks this list before
      // giving up — many top mirrors are geo-blocked or stale.
      fallbacks,
    });
  }

  // ---------- Files tab (configured file-server storage) ----------
  // Browses the phone's /files/list endpoint. State is just the current
  // relative path — drill-in pushes a back handler that pops it back up.
  let _filesPath = '';      // empty = FILES_ROOT
  const _filesBack = [];    // breadcrumb stack of paths we drilled in from
  // Cache the entries currently rendered — needed when the user taps an
  // image so we can build the slideshow playlist from sibling files in
  // the same folder without re-fetching from the phone.
  let _filesEntries = [];
  const VIDEO_RE = /\.(mp4|mkv|mov|m4v|webm|avi|mpg|mpeg|ts|m2ts)$/i;
  const AUDIO_RE = /\.(m4a|flac|mp3|wav|opus|ogg|aac|aiff)$/i;
  // HEIC won't decode in webOS Chromium — keep it out of the slideshow
  // candidate set so we never try to display a black frame.
  const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp)$/i;
  // Cached refs to the (static) Files tab DOM nodes.
  let _filesListEl = null, _filesStatusEl = null, _filesBreadcrumbEl = null;
  function _filesEls() {
    if (!_filesListEl) {
      _filesListEl = $('#files-list');
      _filesStatusEl = $('#files-status');
      _filesBreadcrumbEl = $('#files-breadcrumb');
    }
    return { list: _filesListEl, status: _filesStatusEl, breadcrumb: _filesBreadcrumbEl };
  }

  // ---------- Photo slideshow ----------
  const Slideshow = (() => {
    const INTERVAL_MS = 5000;
    let imgs = [];     // [{name, relPath}]
    let idx = 0;
    let timer = null;
    let paused = false;
    let infoFadeTimer = null;
    let dpadWasEnabled = false;
    // Cached refs — the slideshow overlay is a fixed pair of nodes reused
    // across every open()/close() cycle for the life of the app.
    let imgEl = null, infoEl = null, rootEl = null;
    function _els() {
      if (!imgEl) { imgEl = $('#slideshow-img'); infoEl = $('#slideshow-info'); rootEl = $('#slideshow'); }
      return { img: imgEl, info: infoEl, root: rootEl };
    }

    function _show() {
      const it = imgs[idx];
      const { img, info } = _els();
      img.src = Phone.streamUrl(it.relPath);
      info.textContent =
        `${it.name}  ·  ${idx + 1} / ${imgs.length}${paused ? '  ·  paused' : ''}`;
      info.style.opacity = '0.85';
      clearTimeout(infoFadeTimer);
      infoFadeTimer = setTimeout(() => {
        info.style.opacity = '0';
      }, 2500);
    }

    function _schedule() {
      clearTimeout(timer);
      if (paused) return;
      timer = setTimeout(_next, INTERVAL_MS);
    }
    function _next() { idx = (idx + 1) % imgs.length; _show(); _schedule(); }
    function _prev() { idx = (idx - 1 + imgs.length) % imgs.length; _show(); _schedule(); }
    function _togglePause() { paused = !paused; _show(); _schedule(); }

    function _onKey(e) {
      // Capture-phase listener — runs before DPad's nav handler.
      const k = e.key;
      if (k === 'ArrowRight' || k === 'MediaTrackNext') { e.preventDefault(); e.stopImmediatePropagation(); _next(); }
      else if (k === 'ArrowLeft' || k === 'MediaTrackPrevious') { e.preventDefault(); e.stopImmediatePropagation(); _prev(); }
      else if (k === ' ' || k === 'Enter' || k === 'MediaPlayPause' || k === 'ArrowUp' || k === 'ArrowDown') {
        e.preventDefault(); e.stopImmediatePropagation(); _togglePause();
      }
      // Escape is handled by the BACK handler we pushed onto DPad below.
    }

    function open(images, startIdx) {
      if (!images || !images.length) return;
      imgs = images;
      idx = Math.max(0, Math.min(startIdx | 0, imgs.length - 1));
      paused = false;
      _els().root.style.display = 'flex';
      _show();
      _schedule();
      // Block the rest of the app from getting arrow keys while the
      // slideshow owns the screen. DPad doesn't expose its enabled
      // state, so we just disable then re-enable on close.
      try { DPad.disable(); dpadWasEnabled = true; } catch (_) {}
      document.addEventListener('keydown', _onKey, true);
      DPad.pushBackHandler(close);
    }

    function close() {
      clearTimeout(timer); timer = null;
      clearTimeout(infoFadeTimer); infoFadeTimer = null;
      const { img, root } = _els();
      root.style.display = 'none';
      img.src = 'about:blank';
      imgs = []; idx = 0; paused = false;
      document.removeEventListener('keydown', _onKey, true);
      DPad.popBackHandler();
      if (dpadWasEnabled) { try { DPad.enable(); } catch (_) {} dpadWasEnabled = false; }
    }
    return { open, close };
  })();

  async function renderFiles(opts = {}) {
    // Reset folder-drill state ONLY on tab entry (opts.reset) — so leaving
    // the tab and returning starts at the root listing. Navigation
    // re-renders (filesEnterFolder / filesGoUp) must NOT reset,
    // otherwise drilling into a folder immediately snaps back to the root.
    if (opts.reset) {
      while (_filesBack.length) {
        if (_filesBack.length === 1) DPad.popBackHandler();
        _filesBack.pop();
      }
      _filesPath = '';
    }

    const { list: lEl, status: sEl, breadcrumb: bEl } = _filesEls();
    lEl.innerHTML = '';
    bEl.textContent = '';

    if (!Phone.hasHost()) {
      sEl.textContent = 'Phone host not set — open Settings → Phone.';
      return;
    }

    sEl.textContent = 'Loading…';
    let data;
    try {
      data = await Phone.listFiles(_filesPath);
    } catch (e) {
      sEl.textContent = 'Phone unreachable: ' + (e.message || e);
      return;
    }
    sEl.textContent = '';
    bEl.textContent = '/' + (data.path || '');
    _filesEntries = data.entries || [];

    const frag = document.createDocumentFragment();

    // Back row when not at root.
    if (_filesPath) {
      const back = document.createElement('div');
      back.className = 'lib-row';
      back.tabIndex = 0;
      back.innerHTML = '<div class="lib-name">← Up</div>';
      back.onclick = filesGoUp;
      frag.appendChild(back);
    }

    if (!data.entries || !data.entries.length) {
      const m = document.createElement('p');
      m.className = 'muted';
      m.style.padding = '20px';
      m.textContent = '(empty)';
      frag.appendChild(m);
      lEl.appendChild(frag);
      requestAnimationFrame(() => {
        const r = lEl.querySelector('.lib-row');   // the "← Up" row, if any
        if (r) DPad.focus(r);
      });
      return;
    }

    for (const e of data.entries) {
      const row = document.createElement('div');
      row.className = 'lib-row';
      row.tabIndex = 0;
      if (e.type === 'dir') {
        row.innerHTML = `<div class="lib-name">📁 ${escapeHtml(e.name)}</div>`;
        row.onclick = () => filesEnterFolder(e.name);
      } else {
        const human = fmtSize(e.size);
        let icon = '📄';
        if (VIDEO_RE.test(e.name)) icon = '🎬';
        else if (AUDIO_RE.test(e.name)) icon = '🎵';
        else if (IMAGE_RE.test(e.name)) icon = '🖼';
        row.innerHTML = `
          <div class="lib-name">${icon} ${escapeHtml(e.name)}</div>
          <div class="lib-size">${human}</div>`;
        row.onclick = () => filesOpen(e);
      }
      frag.appendChild(row);
    }
    lEl.appendChild(frag);

    // Land D-pad focus on the first content row once the async listing is
    // built — covers tab entry and folder drill in/out, where the previously
    // focused row was removed by this re-render. Skip the "← Up" row.
    requestAnimationFrame(() => {
      const rows = lEl.querySelectorAll('.lib-row');
      const target = (_filesPath && rows.length > 1) ? rows[1] : rows[0];
      if (target) DPad.focus(target);
    });
  }

  function filesEnterFolder(name) {
    _filesBack.push(_filesPath);
    _filesPath = _filesPath ? `${_filesPath}/${name}` : name;
    if (_filesBack.length === 1) DPad.pushBackHandler(filesGoUp);
    renderFiles();
  }

  function filesGoUp() {
    if (!_filesBack.length) return;
    _filesPath = _filesBack.pop();
    if (!_filesBack.length) DPad.popBackHandler();
    renderFiles();
  }

  function filesOpen(entry) {
    const relPath = _filesPath ? `${_filesPath}/${entry.name}` : entry.name;
    if (VIDEO_RE.test(entry.name)) {
      // Route through the remux so a DTS/E-AC3 phone file transcodes to AAC
      // (else it's silent on the TV). No-op when remuxing is off.
      const _wantId = 'phone:' + relPath;
      // Honor a saved resume position (remux opens AT it, server-side); apply
      // the same "near the end -> start over" guard openPlayer uses.
      const _sv = Storage.getResume(_wantId) || {};
      const _pos = (_sv.duration && _sv.position && _sv.position < _sv.duration - 30) ? _sv.position : 0;
      const _open = ++_openReqSeq;
      (async () => {
        const rmx = await _maybeRemux(Phone.streamUrl(relPath), 'phone', relPath, _pos);
        // Staleness guard: if the user opened something else while we warmed up,
        // drop this result (and its session) instead of hijacking the new play.
        if (_open !== _openReqSeq) { try { if (rmx.sess) Remux.close(); } catch (_) {} return; }
        openPlayer(rmx.url, entry.name, {
          fileId: _wantId,
          source: 'phone',
          _remux: rmx.sess,
        });
      })();
      return;
    }
    if (AUDIO_RE.test(entry.name)) {
      // Reuse the existing music player path — fake a track object that
      // openPlayer recognizes as audio.
      openPlayer(Phone.streamUrl(relPath), entry.name, {
        fileId:  'phone-audio:' + relPath,
        source:  'phone',
        isAudio: true,
      });
      return;
    }
    if (IMAGE_RE.test(entry.name)) {
      // Build the slideshow playlist from every image in the current
      // folder so flipping right/left walks through siblings.
      const imgs = _filesEntries
        .filter(e => e.type === 'file' && IMAGE_RE.test(e.name))
        .map(e => ({
          name: e.name,
          relPath: _filesPath ? `${_filesPath}/${e.name}` : e.name,
        }));
      const start = imgs.findIndex(im => im.name === entry.name);
      Slideshow.open(imgs, start < 0 ? 0 : start);
      return;
    }
    toast('Cannot preview ' + entry.name + ' here.');
  }

  // ---------- Music remote (optional phone client controls DumiFlix) ----------
  // The optional companion service acts as a broker. We POST current
  // playback state on every meaningful transition and poll for commands
  // (play/pause/next/prev/seek/playByName) coming from the phone.
  const MusicRemote = (() => {
    // lastCmdId is the highest command id we've SEEN. We skip executing
    // anything ≤ this. On a fresh app launch we initialise it from the
    // broker's current max so historical commands (e.g. an old playbyid
    // from a previous session) don't auto-fire — they're treated as
    // already-seen. `_primed` flips true after the first tick completes.
    let lastCmdId = 0;
    let _primed = false;
    let loopTimer = null;
    let lastPosPost = 0;
    // Hoisted once instead of compiled per playytmusic call (rare path, but free).
    const YT_URL_ID_RE = /(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/;
    const YT_BARE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

    function publish(patch) {
      if (!MacOnTV.hasHost()) return;
      let url;
      try { url = MacOnTV.url('/remote/state'); } catch (_) { return; }
      try {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        }).catch(() => {});
      } catch (_) {}
    }

    function publishCurrent() {
      const v = $('#video');
      if (!currentVideo || !currentVideo.isAudio) {
        publish({ isPlaying: false, trackId: null, name: null, path: null,
                  position: 0, duration: 0, codec: null, sampleRate: null });
        return;
      }
      const m = currentVideo._musicItem || {};
      publish({
        isPlaying:  !v.paused && !v.ended,
        trackId:    m.id || null,
        name:       m.name || currentVideo.title || null,
        path:       m.path || null,
        position:   v.currentTime || 0,
        duration:   v.duration || 0,
        codec:      (m.codec || currentVideo.codec || '') || null,
        sampleRate: m.sample_rate || null,
      });
    }

    function publishPositionThrottled() {
      const now = Date.now();
      if (now - lastPosPost < 2500) return;
      lastPosPost = now;
      publishCurrent();
    }

    async function tick() {
      if (!MacOnTV.hasHost()) return;
      let url;
      try { url = MacOnTV.url('/remote/commands?since=' + lastCmdId); }
      catch (_) { return; }
      let data;
      try {
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) return;
        data = await r.json();
      } catch (_) { return; }
      const cmds = (data && data.commands) || [];
      // Time-windowed priming: on first tick we still suppress stale
      // commands (so reopening the app doesn't replay yesterday's phone
      // remote), but anything queued within FRESH_CMD_WINDOW_S of "now"
      // is treated as live and executes. A command queued shortly after
      // SSAP launch must survive the cold-boot priming pass.
      const FRESH_CMD_WINDOW_S = 90;
      const nowS = Date.now() / 1000;
      for (const c of cmds) {
        lastCmdId = Math.max(lastCmdId, c.id || 0);
        if (!_primed) {
          const ageS = c.createdAt ? (nowS - c.createdAt) : Infinity;
          if (ageS > FRESH_CMD_WINDOW_S) continue;
        }
        try { await handle(c); } catch (e) { console.error('remote cmd error', e); }
      }
      _primed = true;
    }

    async function handle(c) {
      const v = $('#video');
      const cmd = (c.cmd || '').toLowerCase();
      const args = c.args || {};
      if (cmd === 'play') {
        if (currentVideo && currentVideo.isAudio) { try { await v.play(); } catch (_) {} }
        return;
      }
      if (cmd === 'pause') {
        if (currentVideo && currentVideo.isAudio) { v.pause(); }
        return;
      }
      if (cmd === 'toggle') {
        if (currentVideo && currentVideo.isAudio) {
          if (v.paused) { try { await v.play(); } catch (_) {} } else { v.pause(); }
        }
        return;
      }
      if (cmd === 'next') {
        if (currentVideo && currentVideo.isAudio && _musicQueue.length) advanceMusic(+1);
        return;
      }
      if (cmd === 'prev') {
        if (currentVideo && currentVideo.isAudio && _musicQueue.length) {
          if (v.currentTime > 3) { if (!blockDirectSeedrSeek(0)) v.currentTime = 0; }
          else advanceMusic(-1);
        }
        return;
      }
      if (cmd === 'seek') {
        if (currentVideo && currentVideo.isAudio && typeof args.seconds === 'number') {
          const target = Math.max(0, Math.min(v.duration || 0, args.seconds));
          if (!blockDirectSeedrSeek(target)) v.currentTime = target;
        }
        return;
      }
      if (cmd === 'stop') {
        if (currentVideo && currentVideo.isAudio) closePlayer();
        return;
      }
      if (cmd === 'playbyname') {
        const want = String(args.name || '').toLowerCase();
        if (!want) return;
        let list = [];
        try { list = await MacOnTV.music(); } catch (_) { return; }
        const hit = list.find(m => (m.name || '').toLowerCase() === want)
                 || list.find(m => (m.path || '').toLowerCase().endsWith('/' + want))
                 || list.find(m => (m.path || '').toLowerCase() === want);
        if (!hit) return;
        playMusicFile(hit, list);
        return;
      }
      if (cmd === 'playbyid') {
        const id = String(args.id || '');
        if (!id) return;
        let list = [];
        try { list = await MacOnTV.music(); } catch (_) { return; }
        const hit = list.find(m => m.id === id);
        if (!hit) return;
        playMusicFile(hit, list);
        return;
      }
      if (cmd === 'playfolder') {
        // Play every track under a top-level music folder (matches the
        // Music tab's drill-in: `path` is "folder/file.m4a" form). Optional
        // args: trackIndex (number) or trackName (string) to choose the
        // starting track; defaults to the first one in the folder. The
        // resulting _musicQueue is the folder's tracks only, so auto-next
        // walks within the folder rather than spilling into root files.
        // args.shuffle (bool) — when true, also flip the persistent shuffle
        // toggle on so the queue auto-advances in random order. A random
        // trackIndex can vary the first song while retaining shuffle.
        const folder = String(args.folder || '').toLowerCase();
        if (!folder) return;
        let list = [];
        try { list = await MacOnTV.music(); } catch (_) { return; }
        const prefix = folder + '/';
        const filtered = list.filter(m => (m.path || '').toLowerCase().startsWith(prefix));
        if (!filtered.length) return;
        if (args.shuffle && !_musicShuffle) setMusicShuffle(true);
        let start = filtered[0];
        if (typeof args.trackIndex === 'number' && filtered[args.trackIndex]) {
          start = filtered[args.trackIndex];
        } else if (args.trackName) {
          const want = String(args.trackName).toLowerCase();
          const hit = filtered.find(m => (m.name || '').toLowerCase() === want);
          if (hit) start = hit;
        } else if (args.shuffle) {
          start = filtered[Math.floor(Math.random() * filtered.length)];
        }
        playMusicFile(start, filtered);
        return;
      }
      if (cmd === 'playytmusic') {
        // Music remote request: open the player with a radio queue
        // seeded from args.videoId (single track or whole YT URL accepted),
        // or fall back to a search if args.query is set instead. The
        // remote command carries the seed; the TV handles playback.
        try {
          let videoId = String(args.videoId || args.seed || '').trim();
          // Accept full URLs too, just pull the id.
          const urlMatch = videoId.match(YT_URL_ID_RE);
          if (urlMatch) videoId = urlMatch[1];
          let tracks = [];
          if (videoId && YT_BARE_ID_RE.test(videoId)) {
            // Seed track always first, then radio continuation.
            tracks = [{ videoId, title: '', artist: '' }];
            try {
              const radio = await YTMusic.getRadio(videoId);
              for (const t of radio) {
                if (!tracks.some(x => x.videoId === t.videoId)) tracks.push(t);
              }
            } catch (e) { console.warn('radio fetch failed', e); }
          } else if (args.query) {
            const hits = await YTMusic.search(String(args.query));
            if (args.shuffle && hits.length > 1) {
              for (let i = hits.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [hits[i], hits[j]] = [hits[j], hits[i]];
              }
            }
            tracks = hits;
          }
          if (!tracks.length) { console.warn('playytmusic: no tracks resolved'); return; }
          // If the user requested shuffle on a radio queue, randomize order
          // (the seed stays first because YT's autoplay starts there).
          if (args.shuffle && tracks.length > 2) {
            const head = tracks.slice(0, 1);
            const tail = tracks.slice(1);
            for (let i = tail.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [tail[i], tail[j]] = [tail[j], tail[i]];
            }
            tracks = head.concat(tail);
          }
          YTPlayer.open(tracks);
        } catch (e) {
          console.error('playytmusic failed', e);
        }
        return;
      }
    }

    function start() {
      if (loopTimer) return;
      loopTimer = setInterval(tick, 1500);
      tick();
    }
    function stopLoop() {
      if (loopTimer) clearInterval(loopTimer);
      loopTimer = null;
    }
    return { start, stop: stopLoop, publish, publishCurrent, publishPositionThrottled };
  })();

  // ---------- DumiFlix phone/native remote ----------
  // Full-app remote: PUBLISHES the whole player+app status to the phone broker
  // (POST /dumi/pub) and POLLS for commands (GET /dumi/poll?since=N), then
  // executes them against the real app. Unlike MusicRemote (music-only, relay
  // broker) this drives VIDEO too and covers transport, subtitles, menus,
  // continue-watching, search and next-episode. The paired remote UI is served
  // by the same phone at /remote.
  const DumiRemote = (() => {
    // Read live at snapshot time — __APP_VERSION is populated by an async
    // appinfo.json fetch, so a value captured at module-eval time would be
    // stale. Falls back to the current build string until the fetch resolves.
    const VER = () => window.__APP_VERSION || '0.9.48';
    let lastCmdId = 0, primed = false, pubTimer = null, pollTimer = null;
    // `phoneHost` may intentionally point at the laptop media engine. That
    // host has no /dumi/pub or /dumi/poll broker routes; retrying both every
    // 1.5s forever produced a pair of 404s throughout every playback. Latch a
    // definitive unsupported-route response for this base. A changed host (or
    // an app reload) clears the latch and probes the new broker normally.
    let unsupportedBrokerBase = null;
    let searchResults = [], searchQuery = null;

    function base() {
      try {
        const b = (typeof Phone !== 'undefined' && Phone.hasHost()) ? Phone.base() : null;
        if (unsupportedBrokerBase && b && b !== unsupportedBrokerBase) unsupportedBrokerBase = null;
        return (b && b !== unsupportedBrokerBase) ? b : null;
      }
      catch (_) { return null; }
    }

    function markBrokerUnsupported(b, status) {
      if (!b || (status !== 404 && status !== 405)) return false;
      unsupportedBrokerBase = b;
      running = false;
      if (pubTimer) clearInterval(pubTimer);
      pubTimer = null;
      try { window.__bbEvent && window.__bbEvent('dumi:unsupported', { status }); } catch (_) {}
      return true;
    }

    // The floating Skip pill the nft player would show, computed the same way
    // (reconciled marks, recap before intro, then credits/next).
    // ---- Remux time mapping ----
    // While a remux session is live, v.currentTime/v.duration are WINDOW-
    // relative (the rolling HLS window), but skip marks, resume entries and
    // everything the phone remote shows/sends are ABSOLUTE movie times. The
    // in-app player already maps through Remux (see updateSkipButton /
    // _commitSeekAbsolute); the remote must use the same mapping or its
    // seeks land inside the ~30s window instead of the movie — which also
    // drags the (correctly-absolute) subtitle overlay out of step with the
    // picture the instant a remote seek/skip is used.
    function _rmxOn() { return typeof Remux !== 'undefined' && Remux.hasSession(); }
    function _absPos(v) { return _rmxOn() ? Remux.absolute(v.currentTime || 0) : (v.currentTime || 0); }
    function _absDur(v) { return (_rmxOn() && Remux.duration) || v.duration || 0; }
    function _seekAbs(v, absTarget) {
      const dur = _absDur(v);
      const t = Math.max(0, Math.min((dur || absTarget + 1) - 0.5, absTarget));
      if (blockDirectSeedrSeek(t)) return false;
      if (!_rmxOn()) { try { v.currentTime = t; } catch (_) {} return; }
      Remux.seekAbsolute(t).then((r) => {
        const rel = (r && typeof r.relativeTime === 'number')
          ? r.relativeTime : Remux.toRelative(t);
        try { v.currentTime = rel; } catch (_) {}
      }).catch(() => { /* superseded / no session — nothing to land */ });
    }

    function currentSkip(cv, v) {
      if (!cv || !cv.show || $('#player').classList.contains('is-live')) return null;
      const t = _absPos(v);
      const rc = cv._recapMark;
      if (rc && t >= Math.max(0, rc.start - 1) && t < rc.end - 1.5) return { label: 'Skip Recap', target: rc.end };
      const io = cv._introMark;
      if (io && t >= Math.max(0, io.start - 1) && t < io.end - 1.5) return { label: 'Skip Intro', target: io.end };
      const cr = cv._creditsMark;
      if (cr && cr.start != null && t >= cr.start) return { label: 'Skip Credits', target: cr.end || _absDur(v) };
      return null;
    }

    function nextEpInfo(cv) {
      if (!cv || !cv.show || typeof findNextEpisodeInQueue !== 'function') return null;
      try {
        const q = findNextEpisodeInQueue(cv.show);
        if (q) return { name: q.name || '', phase: q.phase || '', pct: Math.round(q.pct || 0) };
      } catch (_) {}
      return null;
    }

    // Storage.listContinue() parses the whole config blob (which also carries
    // the much larger subtitle/poster/TVMaze caches) out of localStorage on
    // every call. snapshot() runs on every publishNow(), and publishNow() fires
    // on every remote command (several have no throttle — e.g. vol/seekpct)
    // as well as every 1.5s tick, so an unthrottled remote (volume drag, etc.)
    // could reparse that blob many times a second. A short TTL cache collapses
    // those bursts to one real read per window; the payload freshness this
    // trades away is well under the app's own 1.5s publish cadence, so nothing
    // observable on the phone side changes.
    let _contCache = null, _contCacheAt = 0;
    function contList() {
      const now = Date.now();
      if (_contCache && (now - _contCacheAt) < 1000) return _contCache;
      try {
        _contCache = Storage.listContinue().slice(0, 14).map(it => ({
          key: it.key, title: it.title || it.key, source: it.source || null,
          fileId: it.fileId || null, poster: it.poster || null,
          position: it.position || 0, duration: it.duration || 0,
          show: it.show || null,
        }));
      } catch (_) { return []; }
      _contCacheAt = now;
      return _contCache;
    }

    function snapshot() {
      const v = $('#video');
      const cv = currentVideo;
      const common = {
        ver: VER(),
        continue: contList(),
        searchResults: searchResults.map((it, i) => ({
          title: it.title, year: it.year, type: it.type,
          poster: it.poster || null, extra: it.cast || '', idx: i,
        })),
        searchQuery,
      };
      if (!cv) return Object.assign({ mode: 'idle' }, common);
      const isAudio = !!cv.isAudio;
      const hasCues = !!(_subState && _subState.cues && _subState.cues.length);
      return Object.assign({
        mode: isAudio ? 'audio' : 'video',
        title: cv.title || '', show: cv.show || null, poster: cv.poster || null,
        position: _absPos(v), duration: _absDur(v),
        paused: !!v.paused, buffering: !$('#p-buffering').hidden,
        source: cv.source || null,
        sub: {
          on: hasCues && !cv._subHidden,
          offset: (cv._manualOffset || 0),
          name: cv._subKey || null,
        },
        skip: currentSkip(cv, v),
        upNext: !$('#p-upnext').hidden,
        volume: (typeof v.volume === 'number') ? v.volume : 1,
        muted: !!v.muted, rate: v.playbackRate || 1,
        next: nextEpInfo(cv),
      }, common);
    }

    let _pubInFlight = false;
    function publishNow() {
      const b = base(); if (!b) return;
      // In-flight guard: if the phone/Wi-Fi stalls, don't let 1.5s publishes
      // pile up into a growing queue of buffered requests (they compete for
      // memory with the video decoder on the same network). One at a time; a
      // short abort timeout frees a stuck one. (No diff-skip — the phone's
      // liveness/staleness signal needs the steady heartbeat.)
      if (_pubInFlight) return;
      let body;
      try { body = JSON.stringify(snapshot()); } catch (_) { return; }
      _pubInFlight = true;
      const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const killer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, 4000) : null;
      try {
        fetch(b + '/dumi/pub', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body, cache: 'no-store', signal: ctrl ? ctrl.signal : undefined,
        }).then(r => { markBrokerUnsupported(b, r && r.status); })
          .catch(() => {}).finally(() => { if (killer) clearTimeout(killer); _pubInFlight = false; });
      } catch (_) { if (killer) clearTimeout(killer); _pubInFlight = false; }
    }

    function toggleSubtitles() {
      const v = $('#video'); const cv = currentVideo; if (!cv) return;
      if (_subState && _subState.cues && _subState.cues.length) {
        cv._subCuesBackup = _subState.cues; clearSubOverlay(); cv._subHidden = true;
      } else if (cv._subCuesBackup && cv._subCuesBackup.length) {
        setSubCues(v, cv._subCuesBackup); cv._subHidden = false;
      }
    }

    async function doSearch(q) {
      searchQuery = q; searchResults = [];
      if (typeof Trending !== 'undefined' && Trending.suggest) {
        try { searchResults = (await Trending.suggest(q) || []).slice(0, 12); } catch (_) {}
      }
      publishNow();               // push results to the remote immediately
    }

    async function doNextEpisode() {
      const cv = currentVideo; if (!cv || !cv.show) return;
      try {
        const next = await findManualNextEpisode(cv);
        if (currentVideo !== cv) return;
        if (next) triggerUpNext(next); else pToast('No next episode found');
      } catch (_) {}
    }

    async function handle(c) {
      const v = $('#video');
      const cmd = (c.cmd || '').toLowerCase();
      const a = c.args || {};
      // A remote command is real activity — clear the idle screensaver so
      // nothing runs behind it.
      try { Screensaver.wake(); } catch (_) {}
      // Commands with args.silent drive playback WITHOUT summoning the control
      // bar. Open a short suppression window the nft player checks before
      // auto-showing controls on the resulting play/pause event.
      if (a && a.silent) { try { window.__nftSilentUntil = performance.now() + 1800; } catch (_) {} }
      switch (cmd) {
        case 'toggle': {
          // Gate on the <video> element's REAL state, not the currentVideo JS
          // object: webOS preserves #video playback across an app reload while
          // currentVideo resets to null, so remote commands must still control
          // the video actually on screen. An empty currentSrc means the player has no
          // loaded media, so there is nothing to toggle.
          if (!v) break;
          // The 2s play/pause repeat window lives HERE (on the TV), not in the
          // remote. A remote may resend a held command every ~0.5s; the TV
          // toggles at most once per 2s, anchored to a toggle that ACTUALLY took
          // effect. So if a command is dropped in transit or the <video> ignores
          // it, the next resend retries instead of stalling for 2s.
          const nowT = performance.now();
          if (nowT - (window.__lastToggleAt || 0) < 2000) return;   // gated resend: no-op, skip republish
          window.__lastToggleAt = nowT;                             // claim window (blocks re-entry during await)
          if (window.__npResume && window.__npResume()) {           // parked → reload + play
            try { window.__bbEvent && window.__bbEvent('cmd:toggle', { parked: 1 }); } catch (_) {}
            break;
          }
          if (!v.currentSrc) { window.__lastToggleAt = 0; break; }
          const wasPaused = v.paused;
          if (wasPaused) { try { await v.play(); } catch (_) {} } else { v.pause(); }
          if (v.paused === wasPaused) {
            window.__lastToggleAt = 0;                               // didn't actually flip -> allow immediate retry
          } else {
            try { window.__bbEvent && window.__bbEvent('cmd:toggle', { paused: v.paused }); } catch (_) {}
          }
          break;
        }
        case 'play':
          if (window.__npResume && window.__npResume()) break;      // parked → reload + play
          if (currentVideo && v.paused) { try { await v.play(); } catch (_) {} }
          break;
        case 'pause':  if (currentVideo && !v.paused) v.pause(); break;
        case 'seekby': {
          if (!(currentVideo && v.duration)) break;
          // Drop sub-150ms seek bounces (deliberate repeated skips are far
          // slower, so nothing intentional is lost, but a stray double-fire
          // can't re-buffer the decoder twice).
          const nowS = performance.now();
          if (nowS - (window.__lastSeekAt || 0) < 150) break;
          window.__lastSeekAt = nowS;
          _seekAbs(v, _absPos(v) + (+a.delta || 0));
          try { window.__bbEvent && window.__bbEvent('cmd:seekby', { d: +a.delta || 0, to: _absPos(v) | 0 }); } catch (_) {}
          break;
        }
        case 'seekpct': { const d = _absDur(v); if (currentVideo && d && typeof a.pct === 'number') _seekAbs(v, a.pct * d); break; }
        case 'seekto': if (currentVideo && typeof a.seconds === 'number') _seekAbs(v, a.seconds); break;
        case 'skip': { const cv = currentVideo; if (cv) { const sk = currentSkip(cv, v); if (sk) _seekAbs(v, sk.target); } break; }
        case 'next': await doNextEpisode(); break;
        case 'stop': case 'back': if (currentVideo) closePlayer(); break;
        case 'volup':   if (currentVideo) { v.muted = false; v.volume = Math.min(1, (v.volume || 0) + 0.1); } break;
        case 'voldown': if (currentVideo) { v.volume = Math.max(0, (v.volume || 0) - 0.1); } break;
        case 'vol':     if (currentVideo && typeof a.level === 'number') { v.muted = false; v.volume = Math.max(0, Math.min(1, a.level)); } break;
        case 'mute':    if (currentVideo) v.muted = !v.muted; break;
        case 'rate':    if (currentVideo && typeof a.rate === 'number') setPlayerRate(v, a.rate); break;
        case 'subtoggle': toggleSubtitles(); break;
        case 'subnudge': if (typeof nudgeSubDelay === 'function') nudgeSubDelay(+a.delta || 0); break;
        case 'subreset': { const cv = currentVideo; if (cv && typeof nudgeSubDelay === 'function') nudgeSubDelay(-(cv._manualOffset || 0)); break; }
        case 'menu': if (typeof openMenu === 'function' && a.kind) openMenu(a.kind); break;
        case 'closemenu': if (typeof closeMenu === 'function') closeMenu(); break;
        case 'resume': if (typeof resumeItem === 'function' && a.fileId) {
          resumeItem({ fileId: a.fileId, source: a.source, title: a.title, show: a.show, poster: a.poster, key: a.key });
        } break;
        case 'search': if (a.query) await doSearch(String(a.query)); break;
        case 'playsearch': { const it = searchResults[a.index]; if (it) pickSuggestion(it); break; }
        case 'tab': if (typeof showTab === 'function' && a.name) showTab(a.name); break;
        case 'wipeseedr': if (typeof wipeQueueAndSeedr === 'function') wipeQueueAndSeedr('Prioritising next episode (remote)', true); break;
      }
      publishNow();               // reflect the result to the remote at once
    }

    // ---- LONG-POLL command loop --------------------------------------------
    // webOS throttles this app's setInterval to ~seconds (even foreground, even
    // during video), so a fast poll timer is impossible. Instead the TV holds
    // ONE request open on the phone (/dumi/poll?wait=25); the server pushes the
    // command back the instant it's enqueued, we run it, then immediately re-open
    // the request. fetch resolution is network-driven, not timer-driven, so this
    // stays responsive regardless of timer throttling or the media relay.
    let running = false, looping = false;

    function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

    async function pollOnce() {
      const b = base();
      if (!b) { await sleep(2000); return; }
      let killer = null;
      try {
        const ctrl = new AbortController();
        killer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, 30000);
        const r = await fetch(b + '/dumi/poll?since=' + lastCmdId + '&wait=25',
                              { cache: 'no-store', signal: ctrl.signal });
        if (!r.ok) {
          if (markBrokerUnsupported(b, r.status)) return;
          await sleep(1500); return;
        }
        const data = await r.json();
        clearTimeout(killer); killer = null;
        const cmds = (data && data.commands) || [];
        if (data && typeof data.maxId === 'number' && data.maxId < lastCmdId) {
          // A broker restart resets its in-memory sequence. Poll from zero
          // next time; initial priming still skips commands from before boot.
          lastCmdId = 0;
          if (!primed) { lastCmdId = data.maxId; primed = true; }
          return;
        }
        // Prime on the first response: adopt the broker's max id without
        // executing so commands queued before/while away don't replay.
        if (!primed) {
          lastCmdId = Math.max(lastCmdId, (data && data.maxId) || 0);
          for (const c of cmds) lastCmdId = Math.max(lastCmdId, c.id || 0);
          primed = true; return;
        }
        for (const c of cmds) {
          lastCmdId = Math.max(lastCmdId, c.id || 0);
          try { await handle(c); } catch (e) { console.error('dumi remote cmd', e); }
        }
      } catch (_) {
        await sleep(1200);                       // network error / abort — backoff
      } finally {
        if (killer) clearTimeout(killer);
      }
    }

    async function pollLoop() {
      if (looping) return;                       // exactly one loop at a time
      looping = true;
      while (running) { await pollOnce(); }
      looping = false;
    }

    function pubTick() { publishNow(); }

    function start() {
      if (!base()) return;                       // no phone host configured
      // Re-prime so commands queued while away are adopted (not replayed).
      primed = false;
      running = true;
      pollLoop();                                // idempotent; no-op if already looping
      if (pubTimer) clearInterval(pubTimer);
      pubTimer = setInterval(pubTick, 1500);     // status pub (throttling here is harmless)
      publishNow();
    }
    function stop() {
      running = false;
      if (pubTimer) clearInterval(pubTimer);
      pubTimer = null;
    }
    // Re-prime + ensure the loop is alive whenever we return to the foreground.
    try {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') { try { start(); } catch (_) {} }
      });
    } catch (_) {}
    return { start, stop, publishNow };
  })();

  // ---------- YouTube Music player ----------
  // The IFrame embed path is dead for our file:// origin — YouTube returns
  // error 153 regardless of UA tricks, sandbox flags, or IFrame API usage.
  // Following webosbrew/youtube-webos's pattern, we instead do a TOP-LEVEL
  // navigation to music.youtube.com/watch — the WebView becomes YT Music,
  // YT's own player + d-pad work natively, and the user exits back to the
  // TV's home screen via the remote's Home key (relaunching DumiFlix from
  // the apps menu when they want it again).
  const YTPlayer = (() => {
    function open(tracks) {
      if (!tracks || !tracks.length) return;
      const seed = tracks[0].videoId;
      if (!seed) return;
      // /watch with &list=RDMM<id> = YT Music's auto-generated radio mix
      // for that seed, so the user gets a continuous queue, not just one
      // song. autoplay=1 ensures playback starts without user interaction
      // (we already came from a user-driven chip click or remote command).
      const url = `https://music.youtube.com/watch?v=${seed}&list=RDAMVM${seed}&autoplay=1`;
      window.location.href = url;
    }
    // close() is a no-op here — once we've navigated, our JS is gone and
    // the user uses the remote's Home key to exit. Kept for callers.
    function close() {}
    return { open, close, isOpen: () => false };
  })();

  // ---------- Music playback queue ----------
  // The list view passes its (already-sorted) array of tracks plus the
  // clicked track's index into playMusicFile. We stash both so the player's
  // 'ended' handler can advance to the next track without re-opening the
  // tab UI. Shuffle is a Fisher-Yates permutation of the index range,
  // regenerated whenever the playlist source changes.
  let _musicQueue = [];        // [{id, name, codec, profile, ...}]
  let _musicCursor = -1;       // current index INTO _musicShuffleOrder
  let _musicAdvanceTimer = 0;  // setInterval id (deadman for end-of-track)
  let _musicShuffleOrder = []; // permutation indices into _musicQueue
  let _musicShuffle = Storage.get('musicShuffle', false);

  function shuffleArray(arr) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function rebuildShuffleOrder(currentTrackIdx) {
    const range = _musicQueue.map((_, i) => i);
    if (!_musicShuffle || range.length <= 1) {
      _musicShuffleOrder = range;
      _musicCursor = currentTrackIdx;
      return;
    }
    // Keep the currently-playing track at the front so the shuffle starts
    // "from here" and doesn't re-shuffle the already-played one back in.
    const rest = range.filter(i => i !== currentTrackIdx);
    _musicShuffleOrder = [currentTrackIdx, ...shuffleArray(rest)];
    _musicCursor = 0;
  }

  function setMusicShuffle(on) {
    _musicShuffle = !!on;
    Storage.set('musicShuffle', _musicShuffle);
    // Re-permute around the currently-playing track so the user hears the
    // toggle take effect on the NEXT track, not the current one.
    if (_musicQueue.length) {
      const _ctiRaw = _musicShuffleOrder[_musicCursor];
      const currentTrackIdx = (_ctiRaw == null) ? 0 : _ctiRaw;
      rebuildShuffleOrder(currentTrackIdx);
    }
    updateShuffleButton();
  }

  function updateShuffleButton() {
    const b = $('#p-shuffle');
    if (!b) return;
    b.dataset.state = _musicShuffle ? 'on' : 'off';
    b.setAttribute('aria-pressed', _musicShuffle ? 'true' : 'false');
  }

  function advanceMusic(direction = +1) {
    if (!_musicQueue.length) { closePlayer(); return; }
    const nextCursor = _musicCursor + direction;
    if (nextCursor < 0 || nextCursor >= _musicShuffleOrder.length) {
      // End of (shuffled) list. Loop back to the start so the user has a
      // never-ending stream of music — same Spotify-style behavior.
      _musicCursor = ((nextCursor % _musicShuffleOrder.length) + _musicShuffleOrder.length)
                    % _musicShuffleOrder.length;
    } else {
      _musicCursor = nextCursor;
    }
    const trackIdx = _musicShuffleOrder[_musicCursor];
    const m = _musicQueue[trackIdx];
    if (!m) { closePlayer(); return; }
    startMusicTrack(m);
  }

  async function startMusicTrack(m) {
    const badge = formatCodecBadge(m);
    if (badge.isAtmos && !_atmosTipShown) {
      _atmosTipShown = true;
      toast('Atmos: set TV → Sound → Audio Out → Pass Through', 4200);
    }
    const url = MacOnTV.musicStreamUrl(m.id);
    openPlayer(url, m.name, {
      fileId: 'music:' + m.id,
      source: 'music',
      poster: null,
      subtitle: null,
      show: null,
      isAudio: true,
      codec: m.codec,
      profile: m.profile,
      musicItem: m,
    });
    // Defer to next tick so currentVideo has been populated before we publish.
    setTimeout(() => MusicRemote.publishCurrent(), 0);
    // Deadman timer for end-of-track auto-advance. Runs independently of
    // the <video> element's timeupdate events — on webOS HLS playback,
    // timeupdate often stops firing 1-2 s before currentTime reaches
    // duration (the player buffers + pauses internally near EOF), so a
    // pure timeupdate-driven check can miss the trigger. This interval
    // polls every 250 ms with the same end-condition.
    if (_musicAdvanceTimer) clearInterval(_musicAdvanceTimer);
    const v2 = $('#video');
    _musicAdvanceTimer = setInterval(() => {
      if (!currentVideo || !currentVideo.isAudio) {
        clearInterval(_musicAdvanceTimer); _musicAdvanceTimer = 0; return;
      }
      if (currentVideo._musicEndFired) return;
      const cur = v2.currentTime || 0;
      const knownDur = (currentVideo._musicItem &&
                        Number(currentVideo._musicItem.duration_s)) || 0;
      const liveDur = isFinite(v2.duration) && v2.duration > 0 ? v2.duration : 0;
      const dur = knownDur > 0 ? knownDur : liveDur;
      if (!dur || cur < 1) return;
      // Threshold is generous (1.0 s) — webOS's HLS player can stop
      // ticking currentTime up to ~1 s shy of duration, so anything
      // tighter risks never firing on some tracks.
      if (dur - cur < 1.0) {
        currentVideo._musicEndFired = true;
        clearInterval(_musicAdvanceTimer); _musicAdvanceTimer = 0;
        advanceMusic(+1);
      }
    }, 250);

  }

  // ---------- Music tab (configured music daemon) ----------
  // The optional music service scans its configured library and (for .m4a only)
  // rewraps on the fly so webOS — which doesn't recognise the .m4a container
  // — gets MP4 (eac3 codec-copied so Dolby Atmos survives bit-identically)
  // or FLAC (alac → flac, lossless). Everything else streams as-is.
  let _musicPoll = null;
  let _atmosTipShown = false;

  function formatCodecBadge(m) {
    const c = (m.codec || '').toLowerCase();
    const sr = m.sample_rate || 0;
    const ch = m.channels || 0;
    const bits = m.bits || 0;
    const profile = (m.profile || '').toLowerCase();
    const isAtmos = profile.includes('atmos')
      || (c === 'eac3' && (ch >= 6 || profile.includes('joc')));
    const lossless = (c === 'alac' || c === 'flac');
    let label;
    if (c === 'eac3' || c === 'ec-3') label = isAtmos ? 'DD+ Atmos' : 'DD+';
    else if (c === 'ac3')             label = 'Dolby AC3';
    else if (c === 'alac')            label = 'ALAC';
    else if (c === 'flac')            label = 'FLAC';
    else if (c === 'mp3')             label = 'MP3';
    else if (c === 'aac' || c === 'mp4a') label = 'AAC';
    else if (c === 'opus')            label = 'Opus';
    else if (c === 'pcm_s16le' || c === 'pcm_s24le' || c === 'pcm_f32le') label = 'PCM';
    else label = c.toUpperCase() || '—';
    const parts = [label];
    if (lossless && bits && sr) parts.push(`${bits}/${Math.round(sr/1000)}`);
    else if (sr)                parts.push(`${Math.round(sr/1000)} kHz`);
    if (ch === 1)               parts.push('mono');
    else if (ch === 2)          parts.push('stereo');
    else if (ch > 2)            parts.push(`${ch}ch`);
    return {
      text:     parts.join(' · '),
      isAtmos,
      // NOTE: the original expression here was `lossless || cond ? lossless
      // : lossless` — both ternary arms return `lossless`, so the condition
      // was dead weight. Collapsed to the value it always evaluated to.
      lossless,
    };
  }

  async function renderMusic() {
    if (_musicPoll) { clearInterval(_musicPoll); _musicPoll = null; }
    // Re-enter the tab → root view. Pop any stale folder back-handler left
    // from a previous visit where the user navigated away without pressing Back.
    if (_musicView) DPad.popBackHandler();
    _musicView = '';
    musicRefresh._lastSig = null;  // force a full rebuild on tab re-entry
    const lEl = $('#music-list');
    const sEl = $('#music-status');
    if (!MacOnTV.hasHost()) {
      sEl.textContent = 'Scanning LAN for the daemon…';
      lEl.innerHTML = '';
      try {
        await MacOnTV.discover();
      } catch (e) {
        sEl.textContent = 'Media relay host not set — open Settings → Media relay (' + (e.message || e) + ')';
        return;
      }
    }
    await musicRefresh();
    // Light polling discovers files added to the daemon's configured
    // music directory without requiring a tab reload.
    _musicPoll = setInterval(() => {
      if (currentTab !== 'music') { clearInterval(_musicPoll); _musicPoll = null; return; }
      musicRefresh().catch(() => {});
    }, 8000);
  }

  async function musicRefresh() {
    const lEl = $('#music-list');
    const sEl = $('#music-status');
    let list = [];
    try { list = await MacOnTV.music(); }
    catch (e) {
      sEl.textContent = 'Media relay unreachable: ' + (e.message || e);
      return;
    }
    if (!list.length) {
      // Avoid re-writing the same "no music yet" markup every 8s poll.
      if (musicRefresh._lastSig !== 'EMPTY') {
        musicRefresh._lastSig = 'EMPTY';
        lEl.innerHTML = '<p class="muted" style="padding:20px;">'
          + 'No music yet — add audio files to your music server\'s configured directory.</p>';
      }
      sEl.textContent = '';
      return;
    }
    sEl.textContent = `${list.length} track${list.length === 1 ? '' : 's'}`;
    // Skip the whole row rebuild when nothing changed since the last poll
    // (same folder view, same track ids/mtimes) — the background poll fires
    // every 8s while the user just sits on the tab, so this avoids a full
    // innerHTML + row-construction churn for no visible change.
    let sig = _musicView + '|' + list.length + '|';
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      sig += m.id + ':' + (m.mtime || 0) + ',';
    }
    if (sig === musicRefresh._lastSig) return;
    musicRefresh._lastSig = sig;
    // Group by top-level subfolder under MUSIC_DIR (e.g. "Example Artist/Example Album/03.m4a"
    // → folder "Example Artist"). Loose root files appear inline.
    const folders = new Map();
    const loose = [];
    for (const m of list) {
      const sep = (m.path || '').indexOf('/');
      if (sep < 0) loose.push(m);
      else {
        const folder = m.path.slice(0, sep);
        if (!folders.has(folder)) folders.set(folder, []);
        folders.get(folder).push(m);
      }
    }
    const renderFolderRow = (name, items) => {
      let total = 0, newest = 0, hasAtmos = false;
      for (const m of items) {
        total += m.size || 0;
        if (m.mtime && m.mtime > newest) newest = m.mtime;
        if (!hasAtmos && (m.profile || '').toLowerCase().includes('atmos')) hasAtmos = true;
      }
      const row = document.createElement('div');
      row.className = 'lib-row';
      row.tabIndex = 0;
      row.innerHTML = `
        <div class="lib-name">📁 ${escapeHtml(name)}</div>
        ${hasAtmos ? '<span class="lib-codec is-atmos">Atmos</span>' : ''}
        <div class="lib-size">${items.length} track${items.length === 1 ? '' : 's'} · ${fmtSize(total)}</div>`;
      row._sortKey = newest;
      row.onclick = () => musicEnterFolder(name);
      return row;
    };
    // Closure-capture the visible list so end-of-track auto-advance knows
    // which playlist to walk. Re-rendered every musicRefresh, which is fine
    // — the rebound onclick uses the freshest list.
    const renderTrackRow = (m, contextList) => {
      const b = formatCodecBadge(m);
      const cls = 'lib-codec' + (b.isAtmos ? ' is-atmos' : (b.lossless ? ' is-lossless' : ''));
      const row = document.createElement('div');
      row.className = 'lib-row';
      row.tabIndex = 0;
      row.innerHTML = `
        <div class="lib-name">${escapeHtml(m.name)}</div>
        <span class="${cls}">${escapeHtml(b.text)}</span>
        <div class="lib-size">${fmtSize(m.size)}</div>`;
      row._sortKey = m.mtime || 0;
      row.onclick = () => playMusicFile(m, contextList);
      return row;
    };
    // Build off-DOM with a single fragment append instead of N appendChild
    // calls (each of which would otherwise force a layout on this list).
    const frag = document.createDocumentFragment();
    if (!_musicView) {
      const rows = [];
      const rootContext = loose.slice();
      for (const [name, items] of folders) rows.push(renderFolderRow(name, items));
      for (const m of loose) rows.push(renderTrackRow(m, rootContext));
      rows.sort((a, b) => (b._sortKey || 0) - (a._sortKey || 0));
      for (const r of rows) frag.appendChild(r);
    } else {
      const back = document.createElement('div');
      back.className = 'lib-row';
      back.tabIndex = 0;
      back.innerHTML = `
        <div class="lib-name">← All folders</div>
        <div class="lib-size">${escapeHtml(_musicView)}</div>`;
      back.onclick = () => musicExitFolder();
      frag.appendChild(back);
      const items = (folders.get(_musicView) || []).slice()
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      if (!items.length) _musicView = '';
      for (const m of items) frag.appendChild(renderTrackRow(m, items));
    }
    lEl.innerHTML = '';
    lEl.appendChild(frag);
  }

  let _musicView = '';
  function musicEnterFolder(name) {
    _musicView = name;
    DPad.pushBackHandler(() => musicExitFolder());
    musicRefresh().catch(() => {});
  }
  function musicExitFolder() {
    if (!_musicView) return;
    _musicView = '';
    DPad.popBackHandler();
    musicRefresh().catch(() => {});
  }

  // Click a track in the Music tab. `list` is the ordered set of tracks in
  // the user's current view (folder drill-in or root). After the clicked
  // track ends, the player walks the rest of the list — shuffled if the
  // user has shuffle on, otherwise in display order — and loops.
  function playMusicFile(m, list) {
    _musicQueue = Array.isArray(list) && list.length ? list.slice() : [m];
    const trackIdx = _musicQueue.findIndex(t => t.id === m.id);
    rebuildShuffleOrder(trackIdx < 0 ? 0 : trackIdx);
    startMusicTrack(m);
  }

  // ---------- International (iptv-org worldwide directory) ----------
  // Same playback path as Live (HLS → openPlayer with source:'live'); only
  // the listing changes. iptv-org gives us ~10K playable channels worldwide;
  // we render them paginated by country + category.
  let _intlAll = null;
  let _intlCountry = '';     // ISO 3166-1 alpha-2; '' = all
  let _intlCategory = '';    // iptv-org category id; '' = all
  let _intlPage = 1;
  const INTL_PAGE_SIZE = 60;
  // Tracks what's already painted into #intl-grid so paging ("Load more")
  // only builds the newly-revealed tail instead of tearing down and
  // rebuilding every tile shown so far (grows unbounded as the user pages
  // through a ~10K-channel list).
  let _intlRenderState = { country: null, category: null, count: 0 };

  let _intlLoadSeq = 0;
  function releaseInternational() {
    _intlLoadSeq++;
    _intlAll = null;
    _intlPage = 1;
    _intlRenderState = { country: null, category: null, count: 0 };
    ['#intl-grid', '#intl-countries', '#intl-cats'].forEach(selector => {
      const el = $(selector);
      if (el) el.innerHTML = '';
    });
    try { IPTV.releaseCache(); } catch (_) {}
  }

  async function renderInternational() {
    const req = ++_intlLoadSeq;
    const grid = $('#intl-grid');
    const status = $('#intl-status');
    const moreBtn = $('#intl-more');
    const countriesBar = $('#intl-countries');
    const catsBar = $('#intl-cats');
    if (!_intlAll) {
      grid.innerHTML = '';
      countriesBar.innerHTML = '';
      catsBar.innerHTML = '';
      status.textContent = 'Loading worldwide channels (~19 MB, one-time)…';
      moreBtn.style.display = 'none';
    }

    let channels = _intlAll;
    if (!channels) {
      try {
        channels = await IPTV.fetchAll();
        if (req !== _intlLoadSeq) return;
        _intlAll = channels;
      } catch (e) {
        if (req !== _intlLoadSeq) return;
        status.textContent = `Couldn't reach iptv-org: ${e.message}`;
        return;
      }
    }
    status.textContent = `${channels.length.toLocaleString()} channels available`;

    // Country chips (top 24 by channel count + an "All").
    const countries = IPTV.listCountries(channels, 24);
    countriesBar.innerHTML = `
      <span class="chips-label">Country</span>
      <button class="chip ${_intlCountry === '' ? 'is-active' : ''}" data-cc="">All (${channels.length.toLocaleString()})</button>
      ${countries.map(c => `
        <button class="chip ${_intlCountry === c.code ? 'is-active' : ''}" data-cc="${c.code}">
          <span class="chip-flag">${c.flag || ''}</span>${escapeHtml(c.name)} (${c.count})
        </button>
      `).join('')}`;
    $$('#intl-countries .chip').forEach(c => {
      c.onclick = () => {
        _intlCountry = c.dataset.cc || '';
        _intlPage = 1;
        renderInternational();
      };
    });

    // Category chips, scoped to whatever country is selected — that way the
    // counts reflect the user's actual filter.
    const countryFiltered = _intlCountry
      ? channels.filter(ch => ch.country === _intlCountry)
      : channels;
    const cats = IPTV.listCategories(countryFiltered);
    catsBar.innerHTML = `
      <span class="chips-label">Category</span>
      <button class="chip ${_intlCategory === '' ? 'is-active' : ''}" data-cat="">All</button>
      ${cats.map(c => `
        <button class="chip ${_intlCategory === c.id ? 'is-active' : ''}" data-cat="${c.id}">${escapeHtml(c.name)} (${c.count})</button>
      `).join('')}`;
    $$('#intl-cats .chip').forEach(c => {
      c.onclick = () => {
        _intlCategory = c.dataset.cat || '';
        _intlPage = 1;
        renderInternational();
      };
    });

    const filtered = _intlCategory
      ? countryFiltered.filter(ch => ch.categories.includes(_intlCategory))
      : countryFiltered;

    const showCount = _intlPage * INTL_PAGE_SIZE;
    const slice = filtered.slice(0, showCount);
    // Same country+category as last paint → this is a "Load more" tick, so
    // only the newly-revealed tail needs building; a filter change (or the
    // very first paint) still needs a full clear+rebuild since the set itself
    // changed.
    const sameFilter = _intlRenderState.country === _intlCountry && _intlRenderState.category === _intlCategory
      && slice.length >= _intlRenderState.count;
    const already = sameFilter ? _intlRenderState.count : 0;
    if (!sameFilter) grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = already; i < slice.length; i++) {
      const ch = slice[i];
      const t = document.createElement('button');
      t.className = 'live-tile';
      t.tabIndex = 0;
      t.dataset.heroTitle = ch.name;
      const countryName = IPTV.countryName(ch.country) || ch.country;
      const flag = IPTV.countryFlag(ch.country) || '';
      const sub = [
        flag ? `${flag} ${countryName}` : countryName,
        ch.category && ch.category !== 'general' ? ((cats.find(c => c.id === ch.category) || {}).name || ch.category) : null,
        ch.quality || null,
      ].filter(Boolean).join(' · ');
      t.dataset.heroSubtitle = sub;
      const logo = ch.logo
        ? `<div class="live-tile-logo" style="background-image:url('${escapeCssUrl(ch.logo) || ch.logo}');"></div>`
        : `<div class="live-tile-logo"></div>`;
      t.innerHTML = `
        ${flag ? `<div class="live-tile-chno"><span class="chip-flag">${flag}</span>${ch.country}</div>` : ''}
        <div class="live-tile-live">LIVE</div>
        ${logo}
        <div class="live-tile-name">${escapeHtml(ch.name)}</div>
      `;
      t.onclick = () => playLive(ch);
      frag.appendChild(t);
    }
    grid.appendChild(frag);
    _intlRenderState = { country: _intlCountry, category: _intlCategory, count: slice.length };

    if (filtered.length > slice.length) {
      moreBtn.style.display = 'inline-block';
      moreBtn.textContent = `Load more (${(filtered.length - slice.length).toLocaleString()} left)`;
      moreBtn.onclick = () => { _intlPage += 1; renderInternational(); };
    } else {
      moreBtn.style.display = 'none';
    }

    if (filtered.length === 0) {
      status.textContent = 'No channels match those filters.';
    } else {
      status.textContent = `Showing ${slice.length.toLocaleString()} of ${filtered.length.toLocaleString()} channels`;
    }

    requestAnimationFrame(() => requestAnimationFrame(() => {
      // Post-merge: International is a panel inside #tab-live (not its own
      // tab), gated by the live-source toggle rather than a tab id.
      const _activeTab2 = document.querySelector('.tab.is-active');
      const tabActive = !!(_activeTab2 && _activeTab2.id === 'tab-live' && liveSource === 'intl');
      if (!tabActive) return;
      if (document.querySelector('#tab-live .is-focused')) return;
      const first = $('#intl-grid .live-tile') || $('#intl-countries .chip');
      if (first) DPad.focus(first);
    }));
  }

  // ---------- Library (Drive first, then seedr leftovers) ----------
  // Cached Drive listing keyed by root_folder_name so a folder reattach
  // invalidates automatically. Library re-visits render from cache
  // instantly (~0ms) while a fresh fetch runs in the background; if the
  // refresh returns a different file set we swap the rows in place.
  const LIB_CACHE_KEY = 'libCache';
  function readLibCache() {
    const c = Storage.get(LIB_CACHE_KEY, null);
    if (!c) return null;
    if (c.root !== Drive.rootFolderName()) return null;
    return c;
  }
  function writeLibCache(driveFiles) {
    Storage.set(LIB_CACHE_KEY, {
      ts: Date.now(),
      root: Drive.rootFolderName(),
      driveFiles,
    });
  }
  // Stable shape-comparison so we can decide whether to re-render after a
  // background refresh — only the bits the row actually displays.
  function libDriveFingerprint(files) {
    if (!files || !files.length) return '';
    return files.map(f => `${f.id}|${f.name}|${f.size || 0}`).join('\n');
  }

  // ---------- Watch Later (direct-to-pen downloads, aria2) ----------
  // Files over seedr's 5 GB cap download straight to the pen drive via the
  // phone's aria2. They live OUTSIDE the seedr queue, so "Wipe queue + seedr"
  // never touches them. Metadata (title/poster) is kept locally so the Library
  // shows a real card; the live progress/finish state comes from /torrent/list.
  function wlMetaAll()     { return Storage.get('watchLater', {}) || {}; }
  function wlMetaSetAll(m) { Storage.set('watchLater', m); }

  // Download directly to the configured laptop cache and play when ready.
  // For titles above Seedr's 5 GB limit, keep a full-screen progress overlay
  // visible throughout the play request. If the laptop backend is unavailable,
  // fall back to the separately configured phone download path.
  const _DTSP_VIDEO_RE = /\.(mkv|mp4|m4v|avi|ts|mov|webm)$/i;
  async function downloadToServerAndPlay(meta) {
    if (typeof LaptopCache === 'undefined' || !LaptopCache.available()) {
      return downloadWatchLater(meta);      // no laptop — legacy phone path
    }
    const label = meta.title || meta.name || 'Download';
    showLoading(label, meta.poster || null, null, 'Sending to laptop…');
    const fillEl = $('#dumi-load-fill'), stEl = $('#dumi-load-status');
    let done = false;
    const h = LaptopCache.addTorrent(
      { source: meta.magnet, name: meta.name || meta.title || '' },
      (t) => {
        if (done) return;
        if (t.status === 'error') {
          done = true; _loadingCancelHook = null; hideLoading();
          toast('Laptop download failed: ' + (t.error || 'unknown'), 4000);
          return;
        }
        if (t.status === 'ready') {
          done = true; _loadingCancelHook = null;
          const ids = (t.fileIds || []).filter(id => _DTSP_VIDEO_RE.test(id));
          const fid = t.fileId || ids[0] || (t.fileIds || [])[0];
          if (!fid) {
            hideLoading();
            toast('Downloaded, but no playable file found', 4000);
            return;
          }
          // openPlayer hides the overlay when playback actually starts.
          playDriveFile(fid, label, meta.poster || null, null, meta.show || null);
          return;
        }
        // metadata / downloading ticks — progress may arrive as 0-1 or 0-100.
        let pct = +t.progress || 0;
        if (pct <= 1) pct = pct * 100;
        pct = Math.max(0, Math.min(100, pct));
        if (t.status === 'metadata' || t.stage === 'metadata') {
          if (stEl) stEl.textContent = 'Fetching torrent metadata…';
        } else {
          if (stEl) stEl.textContent = `Downloading to laptop — ${pct.toFixed(0)}%`;
          if (fillEl) fillEl.style.width = pct.toFixed(0) + '%';
        }
      });
    _loadingCancelHook = () => { try { h.cancel(); } catch (_) {} };
  }

  async function downloadWatchLater(meta) {
    if (typeof PhoneDL === 'undefined' || !PhoneDL.available()) {
      toast('Set your phone host in Settings first');
      showTab('settings'); return;
    }
    const hash = (meta.infoHash || '').toLowerCase();
    const key  = hash || (meta.magnet || '').slice(0, 60);
    toast(`Sending "${meta.title || meta.name}" to phone…`);
    try {
      const r = await PhoneDL.add(meta.magnet);
      const all = wlMetaAll();
      all[key] = {
        hash, gid: r.gid, title: meta.title || meta.name, name: meta.name || meta.title,
        poster: meta.poster || null, year: meta.year || '', kind: meta.kind || 'movie',
        // Episode context (season/episode/imdb) so a >5 GB episode grouped into
        // the Library plays in order and scopes its subtitle lookups correctly.
        show: meta.show || null,
        sizeBytes: meta.sizeBytes || 0, rel: '', addedAt: Date.now(),
      };
      wlMetaSetAll(all);
      let msg = '⬇ Downloading to phone — Library ▸ Watch Later';
      if (r.evicted && r.evicted.removed && r.evicted.removed.length)
        msg += ` · freed ${fmtSize(r.evicted.freed)}`;
      toast(msg, 4200);
      showTab('library');
    } catch (e) {
      toast('Download failed: ' + (e.message || e));
    }
  }

  function _dlKey(d) { return (d.infohash || '').toLowerCase() || d.gid; }

  // Hoisted once instead of built inside the mergeDownloads() loop (that loop
  // runs on every 2.5s Watch Later poll tick, once per download row).
  const METADATA_NAME_RE = /^\[METADATA\]/;

  // Merge live aria2 rows (deduped by infohash, real download preferred over
  // its [METADATA] placeholder) with stored metadata. Stored-only entries
  // survive an aria2 session reset and stay playable via their saved rel.
  function mergeDownloads(rawList, meta) {
    const byHash = new Map();
    for (const d of rawList) {
      const k = _dlKey(d);
      const isMeta = METADATA_NAME_RE.test(d.name || '');
      const prev = byHash.get(k);
      if (!prev) { byHash.set(k, d); continue; }
      const prevMeta = METADATA_NAME_RE.test(prev.name || '');
      const better = (!isMeta && prevMeta) ||
        (isMeta === prevMeta && ((d.total || 0) > (prev.total || 0) || (d.rel && !prev.rel)));
      if (better) byHash.set(k, d);
    }
    const rows = [], seen = new Set();
    for (const [k, d] of byHash) {
      const m = meta[k] || {};
      rows.push({
        key: k, gid: d.gid, infohash: d.infohash,
        title: m.title || (d.name || '').replace(METADATA_NAME_RE, ''),
        poster: m.poster || null, name: d.name,
        status: d.status, total: d.total, done: d.done, speed: d.speed,
        seeders: d.seeders, err: d.err, rel: d.rel, addedAt: m.addedAt || 0,
      });
      seen.add(k);
    }
    for (const k of Object.keys(meta)) {
      if (seen.has(k)) continue;
      const m = meta[k];
      rows.push({
        key: k, gid: m.gid, infohash: m.hash,
        title: m.title, poster: m.poster, name: m.name,
        status: m.rel ? 'complete' : 'waiting',
        total: m.sizeBytes || 0, done: m.rel ? (m.sizeBytes || 0) : 0,
        speed: 0, seeders: null, err: null, rel: m.rel || '', addedAt: m.addedAt || 0,
      });
    }
    // Rel-level dedupe: the server now also reports finished files straight
    // from the pen's filesystem ('fs:' rows, so downloads survive an aria2
    // restart). When the same file arrives via aria2/stored-metadata AND the
    // fs scan, keep the richer row (poster/title) and drop the bare fs one.
    // Tracks each rel's index in `deduped` directly (instead of indexOf) so a
    // watch-later list with many rows doesn't turn this into an O(n²) scan.
    const byRel = new Map();
    const deduped = [];
    for (const r of rows) {
      if (!r.rel) { deduped.push(r); continue; }
      const prev = byRel.get(r.rel);
      if (!prev) { byRel.set(r.rel, { row: r, idx: deduped.length }); deduped.push(r); continue; }
      const prevIsFs = String(prev.row.gid || '').indexOf('fs:') === 0;
      const curIsFs  = String(r.gid || '').indexOf('fs:') === 0;
      if (prevIsFs && !curIsFs) {
        deduped[prev.idx] = r;
        byRel.set(r.rel, { row: r, idx: prev.idx });
      }
    }
    deduped.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return deduped;
  }

  function renderWatchLater(rows) {
    const el = document.getElementById('lib-downloads');
    if (!el) return;
    if (!rows || !rows.length) { el.innerHTML = ''; return; }
    let html = '<h3 class="row-title" style="padding:0 0 4px;">Watch Later · on phone</h3>';
    for (const r of rows) {
      const pct  = r.total ? Math.min(100, r.done / r.total * 100) : 0;
      const done = r.status === 'complete' && r.rel;
      const isErr = r.status === 'error';
      const isKeep = (r.rel || '').indexOf(KEEPWATCH_REL + '/') === 0;
      let info;
      if (done)        info = 'Ready · ' + fmtSize(r.total);
      else if (isErr)  info = 'Error: ' + ((r.err || '').slice(0, 60) || 'failed');
      else if (r.status === 'waiting') info = 'Starting…';
      else info = pct.toFixed(0) + '% · ' + fmtSize(r.done) + ' / ' + fmtSize(r.total) +
                  (r.speed ? ' · ' + fmtSize(r.speed) + '/s' : '') +
                  (r.seeders != null ? ' · ' + r.seeders + ' seeders' : '');
      if (isKeep) info += ' · Saved for you — keeps 3 days after last watch';
      html += `
        <div class="lib-row dl-row${done ? ' is-ready' : ''}" data-key="${escapeHtml(r.key)}" tabindex="0">
          <div style="flex:1;min-width:0;">
            <div class="lib-name">${done ? '▶ ' : ''}${escapeHtml(r.title || r.name || 'download')}</div>
            ${done ? '' : `<div class="dl-bar"><div class="dl-fill" style="width:${pct}%"></div></div>`}
            <div class="lib-size" style="margin-top:4px;">${escapeHtml(info)}</div>
          </div>
          <button class="btn dl-rm" data-key="${escapeHtml(r.key)}" title="Remove + delete from pen">✕</button>
        </div>`;
    }
    el.innerHTML = html;
    el.querySelectorAll('.dl-row').forEach(row => {
      row.onclick = (ev) => {
        if (ev.target && ev.target.classList.contains('dl-rm')) return;
        const r = rows.find(x => x.key === row.dataset.key);
        if (r && r.status === 'complete' && r.rel) playPenDownload(r);
        else toast('Still downloading…');
      };
    });
    el.querySelectorAll('.dl-rm').forEach(btn => {
      btn.onclick = (ev) => { ev.stopPropagation(); removeWatchLater(btn.dataset.key); };
    });
  }

  let _wlPollTimer = null;
  // Fingerprint of the last "complete" set that actually reached
  // renderLibGrid() — refreshWatchLater() runs every 2.5s while on the
  // Library tab, but the grouped grid only needs rebuilding when a download
  // actually finishes, not on every progress tick.
  let _wlCompleteFp = '';
  async function refreshWatchLater() {
    if (typeof PhoneDL === 'undefined' || !PhoneDL.available()) {
      renderWatchLater([]);
      _libState.penComplete = [];
      if (_wlCompleteFp !== '') { _wlCompleteFp = ''; renderLibGrid(); }
      return;
    }
    const meta = wlMetaAll();
    const raw  = await PhoneDL.list();
    const rows = mergeDownloads(raw, meta);
    // Persist a finished file's rel so it stays playable after an aria2 reset.
    let dirty = false;
    for (const r of rows) {
      if (r.status === 'complete' && r.rel && meta[r.key] && meta[r.key].rel !== r.rel) {
        meta[r.key].rel = r.rel; dirty = true;
      }
    }
    if (dirty) wlMetaSetAll(meta);
    // Finished pen downloads fold into the grouped Library grid (as show cards
    // / movie tiles); the "Downloading" strip carries only in-flight jobs, so a
    // 10-episode season download doesn't spam 10 rows once it lands.
    const complete = rows.filter(r => r.status === 'complete' && r.rel);
    const active   = rows.filter(r => !(r.status === 'complete' && r.rel));
    _libState.penComplete = complete;
    renderWatchLater(active);
    // Skip the heavier grouped-grid rebuild unless the finished set changed —
    // avoids re-running renderLibGrid() (already fired once via renderLibList
    // on tab entry) on every idle poll tick.
    const fp = complete.map(r => r.key).join(',');
    if (fp !== _wlCompleteFp) {
      _wlCompleteFp = fp;
      renderLibGrid();
    }
  }
  function startWatchLaterPoll() {
    stopWatchLaterPoll();
    refreshWatchLater();
    _wlPollTimer = setInterval(() => {
      if (currentTab !== 'library') { stopWatchLaterPoll(); return; }
      refreshWatchLater();
    }, 2500);
  }
  function stopWatchLaterPoll() { if (_wlPollTimer) { clearInterval(_wlPollTimer); _wlPollTimer = null; } }

  // aria2-dashboard publishes completed torrents into the laptop's ordinary
  // /cache/list index. Keep the open TV Library subscribed to that cheap
  // index so a just-finished movie/season appears without navigating away or
  // relaunching the app. Fingerprinting prevents the expensive poster/group
  // grid from being rebuilt on every poll when nothing changed.
  let _laptopLibPollTimer = null;
  let _laptopLibPollBusy = false;
  let _laptopLibFp = '';
  function laptopLibraryFingerprint(files) {
    return (files || []).map(f => [
      String(f.id || ''), String(f.name || ''), Number(f.size || 0), Number(f.mtime || 0),
    ].join('\u001f')).sort().join('\u001e');
  }
  function applyLaptopLibraryFiles(files, list) {
    const fresh = files || [];
    const fp = laptopLibraryFingerprint(fresh);
    _libState.laptopFiles = fresh;
    if (fp === _laptopLibFp) return false;
    _laptopLibFp = fp;
    renderLibGrid(list);
    return true;
  }
  async function refreshLaptopLibrary() {
    if (_laptopLibPollBusy || currentTab !== 'library') return;
    if (typeof LaptopCache === 'undefined' || !LaptopCache.available()) return;
    _laptopLibPollBusy = true;
    try {
      const fresh = await LaptopCache.listAll();
      if (currentTab === 'library') applyLaptopLibraryFiles(fresh);
    } catch (_) {}
    finally { _laptopLibPollBusy = false; }
  }
  function startLaptopLibraryPoll() {
    stopLaptopLibraryPoll();
    _laptopLibPollTimer = setInterval(() => {
      if (currentTab !== 'library') { stopLaptopLibraryPoll(); return; }
      refreshLaptopLibrary();
    }, 5000);
  }
  function stopLaptopLibraryPoll() {
    if (_laptopLibPollTimer) {
      clearInterval(_laptopLibPollTimer);
      _laptopLibPollTimer = null;
    }
  }

  async function removeWatchLater(key) {
    try {
      const raw = await PhoneDL.list();
      const meta = wlMetaAll();
      const row = mergeDownloads(raw, meta).find(r => r.key === key);
      const gids = raw.filter(d => (d.infohash || '') === key).map(d => d.gid).filter(Boolean);
      if (!gids.length && meta[key] && meta[key].gid) gids.push(meta[key].gid);
      for (const g of gids) {
        if (String(g).indexOf('fs:') === 0) continue;   // fs rows have no aria2 job
        try {
          await fetch(Phone.base() + '/torrent/remove', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gid: g, delete_files: true }),
          });
        } catch (_) {}
      }
      // Delete the file itself too — covers finished downloads aria2 forgot
      // after a restart (the fs-scan rows). No-op when aria2 already did it.
      const rel = (row && row.rel) || (meta[key] && meta[key].rel) || '';
      if (rel) {
        try {
          await fetch(Phone.base() + '/files/delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rel }),
          });
        } catch (_) {}
      }
      delete meta[key];
      wlMetaSetAll(meta);
    } catch (_) {}
    toast('Removed');
    refreshWatchLater();
  }

  // ---------- pen-drive playback (shared by Watch Later, Continue Watching,
  // and the KeepWatching fallback) ----------
  const KEEPWATCH_REL = 'Downloads/KeepWatching';

  // Hoisted regexes (each used inside a per-file loop) so repeated calls to
  // findKeepWatchCopy()/playPhoneRel() don't recompile a RegExp per entry.
  const KEEPWATCH_EXT_RE = /\.[a-z0-9]{2,4}$/i;
  const KEEPWATCH_NONALNUM_RE = /[^a-z0-9]+/g;
  const ARIA2_SIDECAR_RE = /\.aria2$/i;
  const SUBTITLE_EXT_RE = /\.(srt|vtt)$/i;

  // Look for a saved copy of a wiped seedr file in the pen's KeepWatching
  // folder. Loose name match (case/punctuation-insensitive) because the
  // display title and the real filename rarely agree byte-for-byte.
  async function findKeepWatchCopy(title) {
    if (typeof Phone === 'undefined' || !Phone.hasHost()) return null;
    const norm = s => String(s || '').toLowerCase()
      .replace(KEEPWATCH_EXT_RE, '').replace(KEEPWATCH_NONALNUM_RE, '');
    const want = norm(String(title || '').split(' — ').pop());
    if (!want) return null;
    try {
      const data = await Phone.listFiles(KEEPWATCH_REL);
      const names = new Set((data.entries || []).map(e => e.name));
      // A video with a live .aria2 sidecar is still downloading — not a copy.
      const files = (data.entries || [])
        .filter(e => e.type === 'file' && !ARIA2_SIDECAR_RE.test(e.name)
                  && !names.has(e.name + '.aria2'));
      const hit = files.find(f => {
        const n = norm(f.name);
        return n === want || n.startsWith(want) || want.startsWith(n);
      });
      return hit ? KEEPWATCH_REL + '/' + hit.name : null;
    } catch (_) { return null; }
  }

  // Play a file that lives on the pen drive, by its path relative to the pen
  // root. Verifies it still exists first (auto-eviction / 3-day expiry may
  // have removed it), falls back to a KeepWatching copy, and only then fails —
  // with a clear message and the dead resume entry cleaned up.
  async function playPhoneRel(rel, it = {}) {
    pill('Starting…');
    let exists = await Phone.fileExists(rel).catch(() => false);
    if (!exists) {
      // fileExists false-negatives on a slow phone / 5s timeout. Before anything
      // drastic, confirm via the directory listing whether the file is REALLY
      // gone (authoritative) — a transient probe failure must never re-download
      // a file that's actually sitting on the pen.
      const nm = rel.split('/').pop();
      const d  = rel.split('/').slice(0, -1).join('/');
      let reallyGone = false;
      try {
        const data = await Phone.listFiles(d);
        reallyGone = !(data.entries || []).some(e => e.name === nm);
      } catch (_) { reallyGone = false; }   // couldn't list → don't refetch, try to play
      if (!reallyGone) {
        exists = true;   // it's there — the probe flaked; play it
      } else {
        const alt = await findKeepWatchCopy(it.title || nm);
        if (alt && alt !== rel) {
          Storage.migrateResume('phone:' + rel, 'phone:' + alt);
          rel = alt;
        } else {
          pill('');
          // Genuinely gone from the pen and no local copy — self-heal: re-fetch
          // the exact title and resume where we left off. Keep the resume entry
          // intact so refetchAndResume can read the saved position from it.
          return refetchAndResume({ ...it, fileId: it.fileId || ('phone:' + rel) });
        }
      }
    }
    const vidName = rel.split('/').pop();
    const dir     = rel.split('/').slice(0, -1).join('/');
    let sub = null;
    try {
      const data = await Phone.listFiles(dir);
      const subs = (data.entries || [])
        .filter(e => e.type === 'file' && SUBTITLE_EXT_RE.test(e.name))
        .map(e => ({ name: e.name }));
      const pick = pickEnglishSubtitle(vidName, subs);
      if (pick) {
        const r = await fetch(Phone.streamUrl(dir ? dir + '/' + pick.name : pick.name));
        const buf = await r.arrayBuffer();
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
        catch (_) { text = new TextDecoder('windows-1252').decode(buf); }
        sub = { name: pick.name, _content: text };
      }
    } catch (_) {}
    pill('');
    const show = it.show || showFromFilename(vidName);
    // For a phone source we pass the RELATIVE path as the remux source ref —
    // the server resolves it to an absolute path against its known roots.
    const rmx = await _maybeRemux(Phone.streamUrl(rel), 'phone', rel, it.position || 0);
    openPlayer(rmx.url, it.title || vidName, {
      fileId: 'phone:' + rel, source: 'phone',
      poster: it.poster || null, subtitle: sub, show: show || null,
      subFilename: vidName,
      _remux: rmx.sess,
    });
    return true;
  }

  // Play a finished pen download from the Watch Later list.
  async function playPenDownload(dl) {
    if (!dl.rel) { toast('Not ready yet'); return; }
    const ok = await playPhoneRel(dl.rel, { title: dl.title, poster: dl.poster });
    if (!ok) refreshWatchLater();
  }

  async function renderLibrary() {
    startWatchLaterPoll();
    startLaptopLibraryPoll();
    const list = $('#lib-list');

    // Hot path: render from cache immediately if we have one.
    const cached = readLibCache();
    let renderedDriveFp = null;
    if (cached && cached.driveFiles && cached.driveFiles.length) {
      renderLibList(list, cached.driveFiles, null, []);
      renderedDriveFp = libDriveFingerprint(cached.driveFiles);
    } else {
      unobserveTilePosters(list);
      list.innerHTML = '<p class="muted" style="padding:20px;">Loading…</p>';
    }

    // Cold path: fetch the phone cache + Drive + Seedr IN PARALLEL. Render
    // each as it arrives so the user doesn't wait on the slowest.
    const cachePromise = (typeof PhoneCache !== 'undefined' && PhoneCache.available())
      ? PhoneCache.listAll().catch(() => [])
      : Promise.resolve([]);
    // Laptop cache files live on the laptop (only when the laptop engine is
    // set up). They land in their OWN _libState.laptopFiles bucket so they
    // show a LAPTOP tag and self-route to the LaptopCache backend by their
    // VPSCACHE:: id.
    const laptopPromise = (typeof LaptopCache !== 'undefined' && LaptopCache.available())
      ? LaptopCache.listAll().catch(() => [])
      : Promise.resolve([]);
    const drivePromise = Drive.isSignedIn()
      ? Drive.listAll().catch(() => [])
      : Promise.resolve([]);
    const seedrPromise = Seedr.isLoggedIn()
      ? Seedr.listContents().catch(() => null)
      : Promise.resolve(null);

    let driveFiles = cached ? cached.driveFiles : [];
    let seedr = null;
    let cacheFiles = [];

    cachePromise.then(fresh => {
      cacheFiles = fresh || [];
      if (cacheFiles.length) renderLibList(list, driveFiles, seedr, cacheFiles);
    });
    laptopPromise.then(fresh => {
      applyLaptopLibraryFiles(fresh, list);
    });
    drivePromise.then(fresh => {
      driveFiles = fresh || [];
      writeLibCache(driveFiles);
      const fp = libDriveFingerprint(driveFiles);
      if (fp !== renderedDriveFp) {
        renderLibList(list, driveFiles, seedr, cacheFiles);
        renderedDriveFp = fp;
      }
    });
    seedrPromise.then(fresh => {
      seedr = fresh;
      // Only re-render when we have something to show in the seedr section.
      if (seedr && ((seedr.folders || []).length || (seedr.files || []).length)) {
        renderLibList(list, driveFiles, seedr, cacheFiles);
      }
    });

    // Settle once all finish so the empty-state message can win if needed.
    const [c, d, s, v] = await Promise.all([cachePromise, drivePromise, seedrPromise, laptopPromise]);
    const dlEl = document.getElementById('lib-downloads');
    const hasDownloads = !!(dlEl && dlEl.children.length);
    const hasPen = !!(_libState.penComplete && _libState.penComplete.length);
    const hasLaptop = !!(v && v.length);
    if ((!c || !c.length) && (!d || !d.length) && !hasLaptop &&
        (!s || ((s.folders || []).length === 0 && (s.files || []).length === 0)) &&
        !hasDownloads && !hasPen) {
      unobserveTilePosters(list);
      list.innerHTML = '<p class="muted" style="padding:20px;">Library empty. Pick something from Home or Search — it caches to your phone (Drive as fallback).</p>';
    } else if ((!c || !c.length) && (!d || !d.length) && !hasLaptop &&
               (!s || ((s.folders || []).length === 0 && (s.files || []).length === 0)) &&
               !hasPen) {
      unobserveTilePosters(list);
      list.innerHTML = '';   // downloads section above carries the content
    }
  }

  // ---------- Library (world-class grouped view) ----------
  // Everything the user owns, normalized and grouped: TV shows become poster
  // cards that drill into a season/episode grid and play in order (local
  // autoplay-next, no tracker round-trip); movies become poster tiles; the
  // cloud-in-transit seedr items stay in a compact strip below. The four
  // sources (phone cache / Drive / finished pen downloads / seedr) land in one
  // shared `_libState` so the async cache/Drive/seedr fetches AND the 2.5s
  // pen-download poll can each re-render the same grid as their data arrives.
  let _libState = { driveFiles: [], seedr: null, cacheFiles: [], penComplete: [], laptopFiles: [] };
  let _libView = 'all';

  function bindLibraryViewChips() {
    const chips = $$('#library-view .chip');
    const saved = Storage.get('libraryView', 'all');
    _libView = saved === '4k' ? '4k' : 'all';
    chips.forEach(c => c.classList.toggle('is-active', c.dataset.view === _libView));
    chips.forEach(c => {
      c.onclick = () => {
        _libView = c.dataset.view === '4k' ? '4k' : 'all';
        Storage.set('libraryView', _libView);
        chips.forEach(x => x.classList.toggle('is-active', x === c));
        renderLibGrid();
      };
    });
  }

  // Hoisted regexes for the title-cleaning / grouping hot path — libBuildGroups
  // runs these over every file in the library on every render (Drive/cache
  // fetch, seedr poll, pen-download poll), so compiling a fresh RegExp per
  // call per item was pure repeated overhead. Compiled once at module load.
  const _LIBTITLE_SEP_RE = /[._]+/g;
  const _LIBTITLE_SPACE_RE = /\s+/g;
  const _LIBSHOW_QUALITY_CUT_RE = /\b(1080p|720p|480p|2160p|4k|uhd|bluray|blu-ray|brrip|bdrip|web[\s-]?dl|webrip|hdtv|x264|x265|h ?264|h ?265|hevc|xvid|dvdrip|hdrip|aac|ac3|eac3|dts|hdr|remux|proper|repack|multi|amzn|dsnp|nf|hmax)\b/i;
  const _LIBSHOW_TRAILYEAR_RE = /\s*[\(\[]?(?:19[5-9]\d|20[0-4]\d)[\)\]]?[\s\-–—]*$/;
  const _LIBSHOW_TRAILPUNCT_RE = /[\s\-–—:]+$/;
  const _LIBTITLE_EXT_RE = /\.[a-z0-9]{2,4}$/i;
  const _LIBTITLE_YEAR_RE = /\b(19[5-9]\d|20[0-4]\d)\b/;
  const _LIBTITLE_YEAR_G_RE = /\b(19[5-9]\d|20[0-4]\d)\b/g;
  const _LIBTITLE_QUALITY_CUT_RE = /\b(1080p|720p|480p|2160p|4k|uhd|bluray|blu-ray|brrip|bdrip|web[\s-]?dl|webrip|hdtv|x264|x265|h ?264|h ?265|hevc|xvid|dvdrip|hdrip|aac|ac3|eac3|dts|hdr|remux|proper|repack|extended|remastered|unrated|imax|directors?[.\s]?cut)\b/i;
  const _LIBTITLE_BRACKET_RE = /[\(\)\[\]]/g;
  const _LIBTITLE_TRAILDASH_RE = /[-–—\s]+$/;
  const _LIBSHOWNAME_FROM_FILE_RE = /^(.*?)[. _]+S(\d{1,2})[. _]?E(\d{1,2})/i;
  const _LIBFOLDER_VIDEO_EXT_RE = /\.(mp4|mkv|mov|m4v|webm|avi|mpg|mpeg)$/i;
  const _LIBFOLDER_SUB_EXT_RE = /\.(srt|vtt|ass|ssa|sub)$/i;
  // Bonus-disc videos have no S##E## identity, so treating them as movies
  // makes poster lookup confidently attach unrelated artwork. New torrent
  // imports filter these before download; this display guard also repairs
  // libraries that already contain the old imports.
  const _LIB_BONUS_VIDEO_RE = /^(?:episode\s*\d+\s+extended\s+version|sample)\b|\b(?:behind[ ._-]*the[ ._-]*scenes|making[ ._-]*of|featurette|deleted[ ._-]*scenes|gag[ ._-]*reel)\b/i;

  // Rank the backend a duplicate lives on: a full-quality local pen copy beats
  // the laptop cache beats the phone cache beats a Drive copy. Used to pick
  // which one to actually play when the same episode/movie exists in more
  // than one place.
  function _libSrcRank(src) {
    return src === 'pen' ? 4 : src === 'laptop' ? 3 : src === 'cache' ? 2 : 1;
  }

  // Tie-break rank within one backend. The library keeps a single entry per
  // episode; ranking only by backend would make the first /cache/list entry
  // win even when a higher-resolution copy is available on the same backend.
  //   * resolution first  — 2160p beats 1080p beats 720p
  //   * then a '.TV.' remux — same picture, but reordered so the AC-3 5.1
  //     track leads for compatible AV receivers. Prefer it over a TrueHD-first
  //     original when the playback path cannot decode or pass through TrueHD.
  function _libQualityRank(it) {
    const n = String((it && (it.name || it.title)) || '');
    let r = /2160p|\b4k\b|\buhd\b/i.test(n) ? 300 : /1080p/i.test(n) ? 200 : /720p/i.test(n) ? 100 : 0;
    if (/\.TV\./i.test(n)) r += 10;
    return r;
  }
  // Combined: backend dominates (a local pen file still beats a remote 4K),
  // quality only decides ties within the same backend.
  function _libRank(it) {
    return _libSrcRank(it && it.source) * 1000 + _libQualityRank(it);
  }

  // The one resolution word to label a variant with in the picker. Reuses
  // parseEpisodeName's resolution detection rather than a fourth private copy
  // of the same regexes; HDR/codec tags are deliberately dropped so the chip
  // row stays short enough to read across a room.
  function _libResLabel(it) {
    const q = parseEpisodeName(String((it && (it.name || it.title)) || '')).quality || [];
    return q.find(x => x === '4K' || x === '1080p' || x === '720p' || x === '480p') || 'SD';
  }

  // Ordered, de-duplicated resolutions present across a season, best first.
  function _libSeasonResolutions(eps) {
    const order = ['4K', '1080p', '720p', '480p', 'SD'];
    const seen = new Set();
    for (const ep of eps) for (const v of (ep.variants || [ep])) seen.add(_libResLabel(v));
    return order.filter(r => seen.has(r));
  }

  // The user's chosen resolution per show, so picking 4K once sticks across
  // episodes, seasons and app restarts instead of resetting to whatever
  // _libRank happens to prefer.
  function _libResPref(showKey) {
    const all = Storage.get('libResPref', {}) || {};
    return all[showKey] || null;
  }
  function _libSetResPref(showKey, res) {
    const all = Storage.get('libResPref', {}) || {};
    if (res) all[showKey] = res; else delete all[showKey];
    Storage.set('libResPref', all);
  }

  // Resolve one episode to the copy matching the chosen resolution, falling
  // back to the best-ranked copy when this episode wasn't downloaded in it —
  // a half-finished 4K season still plays, episode by episode, instead of
  // showing gaps.
  function _libPickVariant(ep, res) {
    if (!res || !ep || !ep.variants || ep.variants.length < 2) return ep;
    return ep.variants.find(v => _libResLabel(v) === res) || ep;
  }

  // Build a real 4K-only projection instead of merely filtering show cards.
  // Duplicate 1080p/2160p episodes are grouped as variants in the normal
  // Library; this projection selects the 4K variant itself, drops seasons and
  // episodes that have no 4K copy, and therefore makes every tile in the 4K
  // tab point at the file the badge promises.
  function _lib4KShow(show) {
    const seasons = new Map();
    for (const s of show.seasonNums) {
      const eps = [];
      for (const ep of (show.seasons.get(s) || [])) {
        const fourK = (ep.variants || [ep]).find(v => _libResLabel(v) === '4K');
        if (fourK) eps.push({ ...fourK, variants: [fourK] });
      }
      if (eps.length) seasons.set(s, eps);
    }
    const seasonNums = [...seasons.keys()].sort((a, b) => a - b);
    if (!seasonNums.length) return null;
    return {
      ...show, seasons, seasonNums,
      _allLibraryShow: show,
      epCount: seasonNums.reduce((n, s) => n + seasons.get(s).length, 0),
    };
  }

  // Every physical Library copy in a show/season, including lower-resolution
  // variants hidden behind the episode winner. The 4K projection carries its
  // original group in `_allLibraryShow`, so deleting "Season 5" from the 4K
  // tab still removes both its 4K and 1080p copies as the wording promises.
  function _libBulkItems(show, seasonNum) {
    const sourceShow = show._allLibraryShow || show;
    const seasons = seasonNum == null ? sourceShow.seasonNums : [seasonNum];
    const seen = new Set(), out = [];
    for (const s of seasons) {
      for (const ep of (sourceShow.seasons.get(s) || [])) {
        for (const it of (ep.variants || [ep])) {
          const fileId = it.source === 'pen' ? ('phone:' + it.rel) : it.id;
          const key = fileId || `${it.source}:${it.rel || it.name}`;
          if (seen.has(key)) continue;
          seen.add(key); out.push(it);
        }
      }
    }
    return out;
  }

  async function _libDeleteItems(items) {
    // A small batch keeps a large multi-season delete responsive without
    // opening dozens of simultaneous LAN/Drive requests on the TV browser.
    for (let i = 0; i < items.length; i += 4) {
      await Promise.all(items.slice(i, i + 4).map(it => purgeTitle({
        fileId: it.source === 'pen' ? ('phone:' + it.rel) : it.id,
        title: it.name || it.title,
        infoHash: it.infoHash,
      })));
    }
  }

  function confirmDeleteLibraryShow(show) {
    const items = _libBulkItems(show, null);
    showDestructiveConfirm({
      title: `Delete ${show.title}?`,
      message: `Delete the entire show and all ${items.length} stored episode file${items.length === 1 ? '' : 's'}?`,
      confirmLabel: 'Delete entire show',
      onConfirm: () => _libDeleteItems(items),
      onDone: () => { toast(`Deleted ${show.title}`); renderLibrary(); },
    });
  }

  function confirmDeleteLibrarySeason(show, seasonNum) {
    const items = _libBulkItems(show, seasonNum);
    showDestructiveConfirm({
      title: `Delete Season ${seasonNum}?`,
      message: `Delete all ${items.length} stored episode file${items.length === 1 ? '' : 's'} from ${show.title} Season ${seasonNum}?`,
      confirmLabel: `Delete Season ${seasonNum}`,
      onConfirm: () => _libDeleteItems(items),
      onCancel: () => openLibraryShow(show, seasonNum),
      onDone: () => { toast(`Deleted ${show.title} Season ${seasonNum}`); renderLibrary(); },
    });
  }

  // Normalize a TV show title for grouping: collapse separators and strip a
  // trailing release-year tag ("Example Show 2024" → "Example Show") so the same
  // show's differently-tagged episode files collapse to one card. Guards single
  // numeric-only titles — the strip needs a separator + a title in front.
  function _libCleanShowTitle(t) {
    let s = String(t || '').replace(_LIBTITLE_SEP_RE, ' ').replace(_LIBTITLE_SPACE_RE, ' ').trim();
    // Cut release/quality junk that leaked in front of the episode tag, e.g.
    // "Example Show 2024 1080p" out of "Example.Show.2024.1080p.S01E02" — otherwise
    // the year isn't trailing and the show won't merge with its plain-title siblings.
    const cut = s.search(_LIBSHOW_QUALITY_CUT_RE);
    if (cut > 0) s = s.slice(0, cut).trim();
    const withoutYear = s.replace(_LIBSHOW_TRAILYEAR_RE, '').replace(_LIBSHOW_TRAILPUNCT_RE, '').trim();
    return withoutYear || s.replace(_LIBSHOW_TRAILPUNCT_RE, '').trim();
  }

  function _libIsBonusVideo(it) {
    return !!(it && !it.season && !it.episode
      && _LIB_BONUS_VIDEO_RE.test(String(it.name || it.title || '')));
  }

  // Turn a raw filename into a clean display title: drop the extension, cut at
  // the first release/quality marker, normalize separators, keep a trailing
  // (year) if one was present.
  function cleanLibTitle(name) {
    const orig = String(name || '');
    let s = orig.replace(_LIBTITLE_EXT_RE, '').replace(_LIBTITLE_SEP_RE, ' ');
    const ym = s.match(_LIBTITLE_YEAR_RE);
    const year = ym ? ym[1] : '';
    const cut = s.search(_LIBTITLE_QUALITY_CUT_RE);
    if (cut > 0) s = s.slice(0, cut);
    s = s.replace(_LIBTITLE_YEAR_G_RE, ' ')
         .replace(_LIBTITLE_BRACKET_RE, ' ').replace(_LIBTITLE_SPACE_RE, ' ')
         .replace(_LIBTITLE_TRAILDASH_RE, '').trim();
    if (!s) s = orig.replace(_LIBTITLE_EXT_RE, '');
    return year ? `${s} (${year})` : s;
  }

  // Normalize one source row into the common Library item shape. `source` is
  // 'cache' | 'drive' | 'pen'; `raw` is the backend's own row (cache/Drive
  // file, or a merged pen-download row).
  function libItem(source, raw) {
    if (source === 'pen') {
      const meta  = wlMetaAll()[raw.key] || {};
      const ctx   = (meta.show && meta.show.season) ? meta.show : null;
      const fname = (raw.rel || '').split('/').pop() || raw.name || raw.title || '';
      const parsed = ctx
        ? { title: ctx.title, season: ctx.season, episode: ctx.episode }
        : (showFromFilename(fname) || showFromFilename(raw.title || ''));
      return {
        source, id: null, rel: raw.rel,
        name: fname, title: raw.title || fname,
        size: raw.total || meta.sizeBytes || 0,
        poster: raw.poster || meta.poster || null,
        subtitles: null, showCtx: ctx,
        showYear: parsed ? (_libShowYear(parsed.title, ctx) || _libShowYear((showFromFilename(fname) || {}).title)) : null,
        showTitle: parsed ? _libCleanShowTitle(parsed.title) : cleanLibTitle(raw.title || fname),
        season: parsed ? parsed.season : null,
        episode: parsed ? parsed.episode : null,
        resumeKey: 'phone:' + raw.rel,
      };
    }
    const fname  = raw.name || '';
    const parsed = showFromFilename(fname);
    return {
      source, id: raw.id, rel: null,
      name: fname, title: fname,
      size: raw.size || 0, poster: null,
      subtitles: raw.subtitles || null, showCtx: null,
      showYear: parsed ? _libShowYear(parsed.title) : null,
      showTitle: parsed ? _libCleanShowTitle(parsed.title) : cleanLibTitle(fname),
      season: parsed ? parsed.season : null,
      episode: parsed ? parsed.episode : null,
      resumeKey: raw.id,
    };
  }

  function _libShowYear(title, ctx) {
    if (ctx && ctx.year) return String(ctx.year);
    const normalized = String(title || '').replace(_LIBTITLE_SEP_RE, ' ');
    const match = normalized.match(/\S.*?\s+[([]?((?:19|20)\d{2})[)\]]?(?:\s|$)/);
    return match ? match[1] : '';
  }

  // Select a physical 4K movie copy, preserving the normal backend preference
  // in All while ensuring that the 4K tab actually plays the 4K file.
  function _lib4KMovie(movie) {
    return (movie.variants || [movie]).find(v => _libResLabel(v) === '4K') || null;
  }

  // Bucket normalized items into { shows:[...], movies:[...] }. TV episodes
  // group by normalized show title → season → episode (deduped across sources,
  // best backend wins). Everything without an S##E## is a movie.
  function libBuildGroups(cacheFiles, driveFiles, penComplete, laptopFiles) {
    const items = [];
    (cacheFiles || []).forEach(f => items.push(libItem('cache', f)));
    (laptopFiles   || []).forEach(f => items.push(libItem('laptop', f)));
    (driveFiles  || []).forEach(f => items.push(libItem('drive', f)));
    (penComplete || []).forEach(r => items.push(libItem('pen', r)));

    // Yearless files can join a known series only when that title has a
    // single premiere year in this snapshot. Two remakes stay separate.
    const yearsByTitle = new Map();
    for (const it of items) {
      if (!it.season || !it.showYear) continue;
      const base = _normShow(it.showTitle);
      if (!yearsByTitle.has(base)) yearsByTitle.set(base, new Set());
      yearsByTitle.get(base).add(it.showYear);
    }
    const showsMap = new Map();
    const movieMap = new Map();
    const movieVariants = new Map();
    for (const it of items) {
      if (_libIsBonusVideo(it)) continue;
      if (it.season && it.episode != null && it.showTitle) {
        const base = _normShow(it.showTitle);
        const years = yearsByTitle.get(base);
        const year = it.showYear || (years && years.size === 1 ? [...years][0] : '');
        const key = base + (year ? ':' + year : '');
        let g = showsMap.get(key);
        if (!g) { g = { key, title: it.showTitle, year, poster: null, showCtx: null, seasons: new Map() }; showsMap.set(key, g); }
        // Upgrade the display title toward the nicest-cased canonical: a
        // showCtx (TVMaze) title wins; otherwise a mixed-case variant beats an
        // all-lowercase filename-derived one ("Example Show" beats "example show").
        const cand = (it.showCtx && it.showCtx.title) ? _libCleanShowTitle(it.showCtx.title) : it.showTitle;
        if (cand && ((it.showCtx && it.showCtx.title) || (/[A-Z]/.test(cand) && !/[A-Z]/.test(g.title)))) g.title = cand;
        if (!g.poster && it.poster) g.poster = it.poster;
        if (it.showCtx && (!g.showCtx || (it.showCtx.imdbId && !g.showCtx.imdbId))) g.showCtx = it.showCtx;
        if (!g.seasons.has(it.season)) g.seasons.set(it.season, []);
        g.seasons.get(it.season).push(it);
      } else {
        const key = _normShow(it.showTitle) || it.name;
        if (!movieVariants.has(key)) movieVariants.set(key, []);
        movieVariants.get(key).push(it);
        const prev = movieMap.get(key);
        if (!prev || _libRank(it) > _libRank(prev)) movieMap.set(key, it);
      }
    }

    const shows = [...showsMap.values()].map(g => {
      for (const [s, arr] of g.seasons) {
        // Keep ONE entry per episode as before — but no longer throw the
        // losers away. When the same episode exists twice (a 1080p rip and a
        // 2160p rip), both are real files the user has; collapsing to the
        // winner is what made a second copy look like it had never
        // downloaded. The winner still leads (so nothing changes for the
        // common single-copy case), and every copy hangs off it in
        // `.variants`, best-first, for the quality picker to offer.
        const byEp = new Map();
        const allByEp = new Map();
        for (const e of arr) {
          if (!allByEp.has(e.episode)) allByEp.set(e.episode, []);
          allByEp.get(e.episode).push(e);
          const prev = byEp.get(e.episode);
          if (!prev || _libRank(e) > _libRank(prev)) byEp.set(e.episode, e);
        }
        for (const [num, win] of byEp) {
          win.variants = allByEp.get(num).slice().sort((a, b) => _libRank(b) - _libRank(a));
        }
        g.seasons.set(s, [...byEp.values()].sort((a, b) => a.episode - b.episode));
      }
      g.seasonNums = [...g.seasons.keys()].sort((a, b) => a - b);
      g.epCount = g.seasonNums.reduce((n, s) => n + g.seasons.get(s).length, 0);
      if (!g.poster && g.showCtx && g.showCtx.poster) g.poster = g.showCtx.poster;
      const years = yearsByTitle.get(_normShow(g.title));
      if (g.year && years && years.size > 1) g.title += ` (${g.year})`;
      return g;
    }).sort((a, b) => a.title.localeCompare(b.title));

    // Schwartzian transform: precompute cleanLibTitle once per movie instead of
    // recomputing it on both sides of every comparator call during the sort
    // (cleanLibTitle runs several regexes — O(n log n) calls adds up fast on a
    // large movie library, versus O(n) here).
    for (const [key, movie] of movieMap) {
      movie.variants = movieVariants.get(key).slice().sort((a, b) => _libRank(b) - _libRank(a));
    }
    const movies = [...movieMap.values()]
      .map(m => ({ m, k: cleanLibTitle(m.title) }))
      .sort((a, b) => a.k.localeCompare(b.k))
      .map(x => x.m);
    return { shows, movies };
  }

  // Lazily fill a poster tile that had no artwork up front — resolves the IMDb
  // suggestion poster (session-cached) and swaps it in for the text fallback.
  function attachLazyPoster(tileEl, guess, isTv) {
    if (!tileEl || !guess) return;
    Trending.poster(guess, '', isTv ? 'tv' : 'movie').then(url => {
      if (!url) return;
      const fb = tileEl.querySelector('.tile-fallback');
      const poster = document.createElement('div');
      poster.className = 'tile-poster';
      poster.style.backgroundImage = `url("${url}")`;
      if (fb) fb.replaceWith(poster);
      else tileEl.insertBefore(poster, tileEl.firstChild);
    }).catch(() => {});
  }

  // Highest resolution + HDR flag across a set of filenames → a compact badge
  // string ("4K", "1080p", "1080p HDR"). Empty when nothing parseable.
  const _QRANK = { '480p': 1, '720p': 2, '1080p': 3, '4K': 4 };
  function libQualityBadge(names) {
    let best = '', bestRank = 0, hdr = false;
    for (const n of (names || [])) {
      const q = parseEpisodeName(n || '').quality || [];
      for (const tok of q) {
        if (tok === 'HDR') hdr = true;
        else if (_QRANK[tok] && _QRANK[tok] > bestRank) { bestRank = _QRANK[tok]; best = tok; }
      }
    }
    if (!best && !hdr) return '';
    return [best, hdr ? 'HDR' : ''].filter(Boolean).join(' ');
  }
  // Stamp a quality badge onto a Library tile's top-left corner.
  function stampQuality(tileEl, badge) {
    if (!tileEl || !badge) return;
    const el = document.createElement('div');
    el.className = 'tile-qbadge';
    el.textContent = badge;
    tileEl.appendChild(el);
  }

  function makeLibShowCard(show) {
    // Name the actual season when only one is downloaded ("Season 8 · 24 eps")
    // instead of the uninformative "1 season · 24 eps".
    const eps = `${show.epCount} ep${show.epCount === 1 ? '' : 's'}`;
    const sub = (show.seasonNums.length === 1 && Number.isFinite(show.seasonNums[0]))
      ? `Season ${show.seasonNums[0]} · ${eps}`
      : `${show.seasonNums.length} seasons · ${eps}`;
    const t = makeTile({ title: show.title, subtitle: sub, poster: show.poster || null,
                         onClick: () => openLibraryShow(show) });
    if (!show.poster) attachLazyPoster(t, show.title, true);
    const names = [];
    for (const s of show.seasonNums) for (const ep of show.seasons.get(s)) names.push(ep.name);
    stampQuality(t, libQualityBadge(names));
    t.title = 'Hold OK to delete the entire show';
    attachLongPressAction(t, () => confirmDeleteLibraryShow(show));
    return t;
  }

  function makeLibMovieTile(item) {
    const title = cleanLibTitle(item.title);
    const t = makeTile({ title, subtitle: fmtSize(item.size || 0), poster: item.poster || null,
                         onClick: () => playLibraryItem(item, null) });
    if (!item.poster) attachLazyPoster(t, title, false);
    stampQuality(t, libQualityBadge([item.name || item.title]));
    attachLongPressRemove(t, {
      fileId: item.source === 'pen' ? ('phone:' + item.rel) : item.id,
      title: item.title, infoHash: item.infoHash,
    }, title);
    return t;
  }

  // Play one Library item directly (movie, or a lone episode with no chain).
  // `show` carries the local autoplay-next context when we're playing in order.
  function playLibraryItem(item, show) {
    // Show the full-screen loading overlay immediately: a library file still
    // spins up a remux (~10-20s) before the player opens, and without this the
    // Library grid just sits there looking frozen. openPlayer() hides it when
    // the player takes over; the error paths below hide it on failure.
    try {
      showLoading(item.title || 'Loading…',
        item.poster || (show && show.poster) || null, null, 'Preparing stream…');
      startRemuxLoadProgress();
    } catch (_) {}
    if (item.source === 'pen') {
      return playPhoneRel(item.rel, { title: item.title, poster: item.poster || (show && show.poster) || null, show: show || item.showCtx || null });
    }
    return playDriveFile(item.id, item.title, item.poster || (show && show.poster) || null, item.subtitles, show || null);
  }

  // Play episode `idx` of a flat, in-order chain of local episodes, wiring up
  // the NEXT local episode so end-of-episode autoplay stays entirely on the
  // pen/cache — no seedr or apibay round-trip needed to continue a season.
  function playLibraryEpisode(chain, idx) {
    const item = chain[idx];
    if (!item) return;
    const base = item.showCtx ? { ...item.showCtx } : {};
    const show = {
      title: base.title || item.showTitle,
      year: base.year || item.showYear || null,
      poster: base.poster || item.poster || null,
      season: item.season, episode: item.episode,
      episodesInSeason: base.episodesInSeason || 0,
      seasonNums: base.seasonNums || [],
      imdbId: base.imdbId || null,
    };
    const nxt = chain[idx + 1];
    if (nxt) {
      show._localNext = () => playLibraryEpisode(chain, idx + 1);
      show._localNextLabel = `${show.title} — S${String(nxt.season).padStart(2, '0')}E${String(nxt.episode).padStart(2, '0')}`;
    }
    playLibraryItem(item, show);
  }

  // Drill-down modal for one Library show: season chips + episode grid, playing
  // in order from local files with resume progress shown per episode.
  function openLibraryShow(show, initialSeason) {
    const card = $('#modal-card');
    let activeSeason = show.seasonNums.indexOf(initialSeason) >= 0
      ? initialSeason : (show.seasonNums[0] || 1);
    let pickedRes = _libResPref(show.key);
    // Rebuilt on every render because the picked resolution changes which
    // copy each slot points at — including for auto-advance, so playing on
    // past the end of an episode stays in the quality that was chosen.
    let chain = [];

    function render() {
      const rawEps = show.seasons.get(activeSeason) || [];
      const resList = _libSeasonResolutions(rawEps);
      if (pickedRes && resList.indexOf(pickedRes) < 0) pickedRes = null;
      const activeRes = pickedRes || resList[0] || null;
      chain = show.seasonNums.flatMap(s =>
        (show.seasons.get(s) || []).map(ep => _libPickVariant(ep, activeRes)));
      const eps = rawEps.map(ep => _libPickVariant(ep, activeRes));
      card.innerHTML = `
        <div class="lib-show-head">
          ${show.poster ? `<div class="lib-show-poster" style="background-image:url('${escapeCssUrl(show.poster)}')"></div>` : ''}
          <div>
            <h2 style="margin:0 0 6px;">${escapeHtml(show.title)}</h2>
            <p style="margin:0;color:#aaa;">${(show.seasonNums.length === 1 && Number.isFinite(show.seasonNums[0]))
              ? `Season ${show.seasonNums[0]} · ${show.epCount} episode${show.epCount === 1 ? '' : 's'} on your devices`
              : `${show.seasonNums.length} seasons · ${show.epCount} episode${show.epCount === 1 ? '' : 's'} on your devices`}</p>
            <p style="margin:4px 0 0;color:#666;font-size:13px;">Hold OK on a season to delete it · Hold OK on an episode to delete it</p>
          </div>
        </div>
        ${show.seasonNums.length > 1 ? `
          <div class="chips" id="lib-season-chips" style="padding:14px 0 12px;">
            ${show.seasonNums.map(s => `
              <button class="chip ${s === activeSeason ? 'is-active' : ''}" data-s="${s}">Season ${s}</button>
            `).join('')}
          </div>` : `<h3 class="lib-season-head">Season ${activeSeason}</h3>`}
        ${resList.length > 1 ? `
          <div class="chips" id="lib-res-chips" style="padding:0 0 12px;">
            ${resList.map(r => `
              <button class="chip ${r === activeRes ? 'is-active' : ''}" data-r="${escapeHtml(r)}">${escapeHtml(r)}</button>
            `).join('')}
          </div>` : ''}
        <div class="ep-grid" id="lib-ep-grid">
          ${eps.map(ep => {
            const ci = chain.indexOf(ep);
            const rz = Storage.getResume(ep.resumeKey);
            const pct = (rz && rz.duration > 0)
              ? Math.min(99, Math.max(3, (rz.position / rz.duration) * 100)) : 0;
            const tag = ep.source === 'pen' ? 'PEN' : ep.source === 'laptop' ? 'LAPTOP'
              : ep.source === 'cache' ? 'PHONE' : 'DRIVE';
            // Only worth the space once a season actually has more than one
            // resolution — and then it has to be per-cell, because a season
            // is often only partly re-downloaded in the higher one.
            const resTag = resList.length > 1 ? ` · ${escapeHtml(_libResLabel(ep))}` : '';
            return `
              <button class="ep-cell lib-ep" data-ci="${ci}" tabindex="0">
                <div class="ep-num">E${String(ep.episode).padStart(2, '0')}</div>
                <div class="ep-cell-meta">${escapeHtml(fmtSize(ep.size || 0))} · ${tag}${resTag}</div>
                ${pct ? `<div class="lib-ep-bar"><div class="lib-ep-fill" style="width:${pct.toFixed(0)}%"></div></div>` : ''}
              </button>`;
          }).join('')}
        </div>
        <div class="modal-actions"><button class="btn" id="m-close">Close</button></div>
      `;
      $('#m-close').onclick = closeModal;
      $$('#lib-season-chips .chip').forEach(c => {
        c.onclick = () => {
          activeSeason = parseInt(c.dataset.s, 10);
          render();
          setTimeout(() => DPad.focus($('#lib-ep-grid .ep-cell')), 30);
        };
        attachLongPressAction(c, () => confirmDeleteLibrarySeason(show, parseInt(c.dataset.s, 10)));
      });
      $$('#lib-res-chips .chip').forEach(c => {
        c.onclick = () => {
          pickedRes = c.dataset.r;
          _libSetResPref(show.key, pickedRes);
          render();
          // Keep focus on the chip that was just pressed, not back on the
          // grid — picking a resolution is usually a "compare them" action.
          setTimeout(() => DPad.focus($('#lib-res-chips .chip.is-active') || $('#lib-ep-grid .ep-cell')), 30);
        };
      });
      $$('#lib-ep-grid .ep-cell').forEach(cell => {
        cell.onclick = () => {
          const ci = parseInt(cell.dataset.ci, 10);
          closeModal();
          playLibraryEpisode(chain, ci);
        };
        // Hold-OK delete, same gesture the Library movie tiles already have.
        // Episodes had NO delete path at all — a stored episode could only be
        // removed by SSH'ing into the laptop. Mirrors makeLibMovieTile's
        // fileId shape so purgeTitle routes to the right backend, then
        // re-renders this modal so the row disappears in place.
        const ep = chain[parseInt(cell.dataset.ci, 10)];
        if (ep) {
          attachLongPressRemove(cell, {
            fileId: ep.source === 'pen' ? ('phone:' + ep.rel) : ep.id,
            title: ep.name || `${show.title} E${ep.episode}`,
            infoHash: ep.infoHash,
          }, `E${String(ep.episode).padStart(2, '0')}`);
        }
      });
    }

    if (!$('#modal').classList.contains('is-open')) DPad.pushBackHandler(closeModal);
    $('#modal').classList.add('is-open');
    render();
    setTimeout(() => DPad.focus($('#lib-ep-grid .ep-cell') || $('#m-close')), 50);
  }

  // Entry point kept for the existing renderLibrary call sites — records the
  // latest cache/Drive/seedr snapshot into _libState and repaints the grid.
  function renderLibList(list, driveFiles, seedr, cacheFiles) {
    _libState.driveFiles = driveFiles || [];
    _libState.seedr = seedr;
    _libState.cacheFiles = cacheFiles || [];
    renderLibGrid(list);
  }

  function renderLibGrid(list) {
    list = list || document.getElementById('lib-list');
    if (!list) return;
    let { shows, movies } = libBuildGroups(
      _libState.cacheFiles, _libState.driveFiles, _libState.penComplete, _libState.laptopFiles);
    if (_libView === '4k') {
      shows = shows.map(_lib4KShow).filter(Boolean);
      movies = movies.map(_lib4KMovie).filter(Boolean);
    }
    const seedr = _libState.seedr;
    // Build everything off-DOM in a fragment and touch `list` exactly once —
    // the original attached the "Cloud · in transit" section to the live DOM
    // BEFORE populating its rows (each row append then landed on a connected
    // node), and appended each section separately. Batching avoids that and
    // collapses however many reflow-triggering mutations down to a single one.
    const frag = document.createDocumentFragment();

    // Cloud · in transit FIRST — these are still arriving (seedr → pen), so the
    // user wants them front-and-centre to track/grab them, above the settled
    // TV/movie library below.
    if (_libView === 'all' && seedr && ((seedr.folders || []).length || (seedr.files || []).length)) {
      const sec = document.createElement('div');
      sec.className = 'lib-section';
      sec.innerHTML = '<h3 class="row-title" style="padding:0 0 8px;">Cloud · in transit</h3>';
      (seedr.folders || []).forEach(f => {
        const row = document.createElement('div');
        row.className = 'lib-row';
        row.tabIndex = 0;
        row.innerHTML = `<div class="lib-name">${escapeHtml(f.name)}</div><div class="lib-size">${fmtSize(f.size || 0)}</div>`;
        row.onclick = () => playFolder({
          folderId: f.id, folderName: f.name, name: f.name,
          total: Number(f.size || 0),
        });
        sec.appendChild(row);
      });
      (seedr.files || []).forEach(f => {
        const row = document.createElement('div');
        row.className = 'lib-row';
        row.tabIndex = 0;
        row.innerHTML = `<div class="lib-name">${escapeHtml(f.name)}</div><div class="lib-size">${fmtSize(f.size || 0)}</div>`;
        row.onclick = () => playFile(f.folder_file_id, f.name);
        sec.appendChild(row);
      });
      frag.appendChild(sec);
    }

    if (shows.length) {
      const sec = document.createElement('div');
      sec.className = 'lib-section';
      sec.innerHTML = '<h3 class="row-title" style="padding:0;">TV Shows</h3>';
      const grid = document.createElement('div');
      grid.className = 'lib-grid';
      shows.forEach(s => grid.appendChild(makeLibShowCard(s)));
      sec.appendChild(grid);
      frag.appendChild(sec);
    }

    if (movies.length) {
      const sec = document.createElement('div');
      sec.className = 'lib-section';
      sec.innerHTML = '<h3 class="row-title" style="padding:0;">Movies</h3>';
      const grid = document.createElement('div');
      grid.className = 'lib-grid';
      movies.forEach(m => grid.appendChild(makeLibMovieTile(m)));
      sec.appendChild(grid);
      frag.appendChild(sec);
    }

    if (_libView === '4k' && !shows.length && !movies.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.style.padding = '20px 60px';
      empty.textContent = 'No 4K titles are stored yet.';
      frag.appendChild(empty);
    }

    unobserveTilePosters(list);
    list.innerHTML = '';
    list.appendChild(frag);
  }

  // Route a stored file's playback ops to the backend that owns it. Cache
  // files carry the CACHE:: prefix on their id; everything else is Drive.
  function storeFor(fileId) {
    if (typeof LaptopCache !== 'undefined' && LaptopCache.isCacheId(fileId)) return LaptopCache;
    return (typeof PhoneCache !== 'undefined' && PhoneCache.isCacheId(fileId))
      ? PhoneCache : Drive;
  }

  // Derive { title, season, episode } from a release filename so a cache /
  // Drive file played without explicit show context (Library, Continue
  // Watching of a loose file) still triggers the next-episode chain.
  function showFromFilename(name) {
    const m = String(name || '').match(_LIBSHOWNAME_FROM_FILE_RE);
    if (!m) return null;
    const title = m[1].replace(_LIBTITLE_SEP_RE, ' ').replace(_LIBTITLE_SPACE_RE, ' ').trim();
    if (!title) return null;
    return { title, season: parseInt(m[2], 10), episode: parseInt(m[3], 10) };
  }

  async function playDriveFile(fileId, title, poster, subtitles, show) {
    if (!show || !show.season) { const d = showFromFilename(title); if (d) show = d; }
    const be = storeFor(fileId);
    const backendKind = (typeof LaptopCache !== 'undefined' && be === LaptopCache) ? 'laptop'
      : (be === PhoneCache) ? 'cache' : 'drive';
    const isCache = backendKind !== 'drive';
    // The cache backend's own rel path for this fileId. Both LaptopCache and
    // PhoneCache mint fileId as PFX + rel but only export PFX/isCacheId, not
    // a relOf() helper — strip the prefix here the same way their own
    // internal relOf() does. Threaded into currentVideo so the TV player's
    // scrub-preview code can ask /cache/thumbs for a storyboard; null for
    // Drive (no cache bolt-on there), which is exactly "no previews".
    const cacheRel = (isCache && be.isCacheId && be.isCacheId(fileId))
      ? fileId.slice(be.PFX.length) : null;
    pill(isCache ? 'Starting cache…' : 'Starting Drive…');
    // Hand the backend a chance to warm up before the <video> hits it. The
    // cache backend arms nothing (direct LAN stream); Drive primes its proxy
    // by POSTing a fresh bearer token to the native service. probePlayUrl
    // below hits that same local proxy, so arming genuinely must finish
    // first (a probe racing an unarmed proxy would 401/503 on a perfectly
    // fine file) — this one stays a sequential await, but it's the
    // service-side "no-op" arm call, not one of the slow round-trips below.
    try { await be.armProxy(); }
    catch (e) {
      pill(''); hideLoading();
      toast('Playback not ready: ' + (e.message || e));
      return;
    }
    // Reachability, the play-URL pre-flight probe, and (on a cold resume,
    // where resumeItem() passes subtitles=null) the subtitle listing used to
    // be three separate sequential round-trips — up to 2.5s + 5s + 6s of
    // serial waiting before the remux POST was ever issued. None of them has
    // an ordering dependency on each other, so fire them together instead:
    // the wait becomes the slowest one of the three, not their sum.
    const needSubs = !subtitles;
    // Hand-rolled allSettled: Promise.allSettled is ES2020 and older webOS
    // Chromium builds in the fleet predate it — a missing method here would
    // silently kill the whole play action.
    const settle = (p) => Promise.resolve(p).then(
      (value) => ({ status: 'fulfilled', value: value }),
      (reason) => ({ status: 'rejected', reason: reason })
    );
    const [statusRes, probeRes, listRes] = await Promise.all([
      settle(be.serviceStatus()),
      settle(be.probePlayUrl(fileId)),
      settle(needSubs ? be.listAll() : Promise.resolve(null)),
    ]);
    // Confirm the backend is actually serving. For Drive this checks the
    // 127.0.0.1:5051 proxy bound; for the cache it confirms the phone is
    // reachable — either way we tell the user instead of a black screen.
    // (status call is best-effort: a rejected promise here is silently
    // ignored, same as the try/catch this replaced.)
    // Pre-flight result first — it hits the ACTUAL play URL, so it's the
    // authoritative reachability signal. The health ping below must never
    // outrank it.
    const probe = probeRes.status === 'fulfilled' ? probeRes.value : null;
    // The serviceStatus / health gate is DRIVE-ONLY. For Drive it's real: the
    // 127.0.0.1:5051 bearer-token proxy must be bound before the <video> can
    // fetch, and there's no other signal for that. For the CACHE it was pure
    // harm — a 2.5s /health ping that shares the same LAN link the file
    // streams over, so right after the TV or the laptop's Wi-Fi power-save
    // wakes BOTH the ping and everything else are briefly slow, and the ping
    // loses the race → "Cache unreachable" on a Continue-Watching click for a
    // file that streams perfectly. The cache already has a dedicated, better
    // authority just below: probePlayUrl, which distinguishes a genuinely
    // evicted file (→ re-fetch) from a transient flake (→ play anyway via the
    // listing check). So the cache leans on THAT and never on the health ping.
    if (!isCache && statusRes.status === 'fulfilled') {
      const p = (statusRes.value && statusRes.value.proxy) || {};
      if (!p.listening) {
        pill(''); hideLoading();
        toast('Drive proxy not listening: ' + (p.error || 'unknown'));
        return;
      }
    }
    // Pre-flight the actual play URL — surfaces a revoked-token 503 (Drive) or
    // an evicted/missing cache file before the <video> shows "Network error".
    // Reuse the concurrently-fetched listing below instead of firing a second
    // listAll() for the same purpose (presence-check and subtitle lookup both
    // just need "the current file list").
    let listedAll = listRes.status === 'fulfilled' ? listRes.value : null;
    if (probe && !probe.ok) {
      // The backend answered but the file didn't stream. For the phone cache
      // this is EITHER a real eviction OR just a transient hiccup (slow phone,
      // a momentary 5xx, or the 5s probe timing out). NEVER kick off a multi-GB
      // re-download on a maybe — confirm the file is genuinely gone from the
      // cache listing first. If it's still there, the probe just flaked: fall
      // through and play it (openPlayer resumes from the saved position as
      // usual). Only a confirmed-absent file self-heals via re-fetch.
      if (isCache) {
        let present = true;   // default present, so a listing failure never triggers a re-download
        try { const all = listedAll || await be.listAll(); listedAll = all; present = all.some(f => f.id === fileId); }
        catch (_) {}
        if (!present) { pill(''); return refetchAndResume({ fileId, title, poster, show }); }
        // else: file really is there — ignore the flaky probe and play on.
      } else {
        pill(''); hideLoading();
        const reason = (probe.error || '').slice(0, 120) || `HTTP ${probe.status}`;
        toast('Playback failed: ' + reason);
        return;
      }
    }
    pill('');
    const u = be.streamUrl(fileId);
    let subs = subtitles;
    if (!subs) {
      try {
        const all = listedAll || await be.listAll();
        const me = all.find(f => f.id === fileId);
        subs = me && me.subtitles ? me.subtitles : [];
      } catch (_) { subs = []; }
    }
    const sub = await resolveSubtitleWithFallback(title || '', subs || [], show);
    // Cache/Drive files can carry audio unsupported by a TV (DTS, E-AC3,
    // TrueHD) — played direct they're SILENT. Route them through the remux
    // (video stream-copy, audio transcoded to AAC) exactly like the seedr
    // path. `_maybeRemux` is a no-op when remuxing is off, so direct playback
    // is unchanged. sourceType 'seedr' just means "treat the reference as a
    // URL input" (the only non-filesystem source the remux accepts); the
    // cache/Drive stream URL is LAN/loopback and reachable by the on-TV
    // remux ffmpeg. startTime = saved resume position so the rolling window
    // opens at the right spot (mirrors resumeSeedrItem).
    const _sv = (fileId && Storage.getResume(fileId)) || {};
    const _pos = (_sv.duration && _sv.position && _sv.position < _sv.duration - 30) ? _sv.position : 0;
    // --- LAPTOP PLAYER (external display / AV receiver) ------------------
    // mpv can bitstream TrueHD Atmos / DTS:X to compatible HDMI audio
    // hardware and runs outside the webOS memory sandbox.
    // Laptop-cached files only (mpv reads the file straight off the disk it
    // lives on). ANY failure — laptop off, nobody logged in, mpv missing,
    // route absent — falls through to the full TV playback below, which is
    // deliberately untouched: the TV app stays the always-working backup.
    if (backendKind === 'laptop' && laptopPlayerOn()) {
      try {
        const lp = await LaptopCache.playerOpen(fileId, { start: _pos, title: title || fileId });
        if (lp && lp.ok) {
          hideLoading(); pill('');
          try { pToast('▶ Playing on external display / AV receiver'); } catch (_) {}
          switchTvToSoundbarInput();
          try { window.__bbEvent && window.__bbEvent('laptop:play', { r: String(title || fileId).slice(0, 40), at: _pos | 0 }); } catch (_) {}
          return;
        }
        try { window.__bbEvent && window.__bbEvent('laptop:fallback', { e: String((lp && lp.error) || '').slice(0, 80) }); } catch (_) {}
      } catch (_) { /* fall through to TV playback */ }
    }
    // Pin the remux to the engine that OWNS this cache, instead of letting it
    // default to the user's selected engine: a laptop-cache URL is local to
    // the laptop, so pin straight to it. A phone-cache URL instead goes
    // through _maybeRemux's normal path (try only the configured tv/laptop
    // engine, same as any other LAN URL — no forced phone consultation).
    // Drive URLs are public -> the normal path too (null = no forced pin).
    const _preferEngine = backendKind === 'laptop' ? 'laptop' : null;
    const rmx = await _maybeRemux(u, 'seedr', u, _pos, _preferEngine);
    openPlayer(rmx.url, title || fileId, { fileId, source: backendKind,
                                     poster, subtitle: sub, show, _remux: rmx.sess,
                                     subFilename: String(title || '').split(' — ').pop(),
                                     cacheRel });
  }

  // A Seedr folder rendered in Library used to be passed as a throwaway
  // {folderId,name} object.  That opened a direct URL, but it was detached
  // from the real queue row, so an errored/stale cache job never restarted.
  // Resolve the durable row (or create one for a Seedr-only folder) before
  // playback so one click always means "play now and cache directly".
  function _seedrLibraryQueueItem(source) {
    if (!source || !source.folderId) return source;
    const folderId = String(source.folderId);
    let item = queue.find(q => q && String(q.folderId || '') === folderId);
    if (!item) {
      item = {
        id: `q_seedr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: source.name || source.folderName || 'Seedr download',
        folderId: source.folderId,
        folderName: source.folderName || source.name || '',
        poster: source.poster || null,
        show: source.show || null,
        pct: 100,
        speed: 0,
        total: Number(source.total || 0),
        phase: 'seedred',
        addedAt: Date.now(),
        autoplay: true,
      };
      queue.push(item);
    } else {
      if (!item.folderName && source.folderName) item.folderName = source.folderName;
      if (!item.poster && source.poster) item.poster = source.poster;
      if (!item.show && source.show) item.show = source.show;
      item.autoplay = true;
    }

    if (item.phase !== 'drive-ready' && item.phase !== 'copying' && item.phase !== 'cooldown') {
      item.error = null;
      item._seedrUnavailable = false;
      item._torrentFallback = false;
      item._torrentJobId = null;
      item._uploadStarted = false;
      item.phase = 'seedred';
    }
    persistQueue();
    renderQueue();
    if (item.phase === 'seedred') resumeUpload(item);
    return item;
  }

  async function playFolder(item) {
    if (!item.folderId) { toast('Not ready'); return; }
    item = _seedrLibraryQueueItem(item);
    // `cloud-ready` is only a transient fallback: it means every persistent
    // backend failed its short reachability probe at the instant Seedr
    // finished. Retry now because the laptop may already be reachable again.
    // resumeUpload is single-flight, so a concurrent recovery sweep is safe.
    if (item.phase === 'cloud-ready') resumeUpload(item);
    // Full-screen loading overlay from the very first tap — folder walk +
    // subtitle fetch + remux warm-up can run 10s+ and the pill alone reads
    // as "nothing happened". openPlayer()/the error paths hide it.
    try {
      showLoading(item.folderName || item.name || 'Loading…',
        item.poster || null, item.id, 'Preparing stream…');
      startRemuxLoadProgress();
      loadingTick(item);
    } catch (_) {}
    pill('Loading…');
    try {
      const files = await Seedr.walkFolder(item.folderId);
      const videos = files
        .filter(f => _LIBFOLDER_VIDEO_EXT_RE.test(f.name))
        .sort((a, b) => b.size - a.size);
      const subs = files.filter(f => _LIBFOLDER_SUB_EXT_RE.test(f.name));
      if (!videos.length) { toast('No video files in folder'); pill(''); hideLoading(); return; }
      const main = videos[0];
      pill('');
      const seedrSubs = await resolveSeedrSubs(main.name, subs);
      playFile(main.fileId, item.folderName ? `${item.folderName} — ${main.name}` : main.name,
               item.poster, seedrSubs, item.show, main.name, { _queueItem: item });
    } catch (e) {
      pill('');
      hideLoading();
      toast('Couldn\'t open folder: ' + e.message);
    }
  }

  // For seedr-side playback, fetch the chosen subtitle's content via its
  // streamable URL and turn it into the same shape Drive subs use, so the
  // player path stays uniform.
  async function resolveSeedrSubs(videoName, subs) {
    const pick = pickEnglishSubtitle(videoName, subs);
    if (!pick) return [];
    try {
      const u = await Seedr.fetchFileUrl(pick.fileId);
      if (!u) return [];
      const r = await fetch(u);
      const buf = await r.arrayBuffer();
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
      catch (_) { text = new TextDecoder('windows-1252').decode(buf); }
      // Stash the decoded text on the picked sub so attachSubtitle can use
      // it without going back to Drive.fetchText.
      return [{ ...pick, _content: text }];
    } catch (_) {
      return [];
    }
  }

  async function playFile(fileId, title, poster, subtitles, show, subFilename, extraMeta) {
    const req = ++_openReqSeq;
    const openingVideo = currentVideo;
    const isCurrent = () => req === _openReqSeq && currentVideo === openingVideo;
    // Same overlay as playLibraryItem: URL mint + subtitle resolution +
    // remux spin-up sit between the tap and openPlayer() — without a
    // full-screen indicator the Library just looks frozen for ~10s.
    const trackedQueueId = extraMeta && extraMeta._queueItem
      ? extraMeta._queueItem.id : null;
    try {
      showLoading(title || 'Loading…', poster || null, trackedQueueId, 'Preparing stream…');
      startRemuxLoadProgress();
    } catch (_) {}
    pill('Resolving stream…');
    try {
      // The release's own filename (not the display title, which may carry a
      // "Folder — " prefix) — the identity /cache/resolve matches on disk.
      const releaseName = subFilename || String(title || '').split(' — ').pop();
      // Cache-hit fast path, fired in PARALLEL with the seedr URL mint (never
      // awaited when it hits) — same contract as playFromSeedrItem.
      const resolveP = (typeof Remux !== 'undefined' && Remux.resolveCache)
        ? Remux.resolveCache(releaseName) : Promise.resolve(null);
      resolveP.catch(() => {});   // cancellation can return before this lookup settles
      const urlP = Seedr.fetchFileUrl(fileId);
      urlP.catch(() => {});
      // subtitles[] here is already resolved by the CALLER (a sibling list
      // from a prior walkFolder, or a Library listing) — this call is local/
      // synchronous, not a network round trip, so no fire-and-forget needed.
      const sub = await resolveSubtitleWithFallback(title || '', subtitles || [], show);
      if (!isCurrent()) return;
      const hit = await resolveP;
      if (!isCurrent()) return;
      const _sv = (fileId && Storage.getResume(fileId)) || {};
      const _pos = (_sv.duration && _sv.position && _sv.position < _sv.duration - 30) ? _sv.position : 0;
      if (hit) pill('');
      if (hit && await _playSeedrCacheHit(hit, fileId, title, poster, show, sub, _pos,
        Object.assign({ subFilename: releaseName }, extraMeta || {}), req)) {
        return;
      }
      if (!isCurrent()) return;
      const u = await urlP;
      if (!isCurrent()) return;
      if (!u) throw new Error('no stream URL returned');
      const probe = await _probeSeedrStream(u);
      if (!isCurrent()) return;
      const queueItem = extraMeta && extraMeta._queueItem;
      // For a queue-linked Library click, an inconclusive browser probe is
      // not good enough to open the player: webOS may report only a CORS/
      // network exception and then leave <video> dead at readyState 0. The
      // direct laptop cache is already running, so keep the user on its
      // tracked loading screen until local bytes are playable. Non-queue
      // callers retain the historic fail-open behavior for CORS-only probes.
      if (queueItem ? probe !== true : probe === false) {
        if (queueItem) {
          queueItem._seedrUnavailable = true;
          stopRemuxLoadProgress();
          loadingTick(queueItem);
          try {
            const status = $('#dumi-load-status');
            if (status) status.textContent = 'Seedr stream unavailable — caching directly to laptop…';
          } catch (_) {}
          return;
        }
        throw new Error('Seedr stream unavailable');
      }
      pill('');
      const rmx = (extraMeta && extraMeta._queueItem)
        ? { url: u, sess: null }
        : await _maybeRemux(u, 'seedr', u, _pos);
      if (!isCurrent()) return;
      openPlayer(rmx.url, title, Object.assign({
        fileId, source: 'seedr', poster, subtitle: sub, show,
        _remux: rmx.sess, subFilename: releaseName,
      }, extraMeta || {}));
    } catch (e) {
      if (!isCurrent()) return;
      pill('');
      hideLoading();
      toast('Stream failed: ' + e.message);
    }
  }
  async function playFromLibrary(path) {
    try { showLoading(String(path || 'Loading…'), null, null, 'Preparing stream…'); } catch (_) {}
    if (Drive.isSignedIn()) {
      try {
        const all = await Drive.listAll();
        const match = all.find(f => f.path === path || f.name === path);
        if (match) return playDriveFile(match.id, match.name);
      } catch (_) {}
    }
    if (Seedr.isLoggedIn()) {
      try {
        const root = await Seedr.listContents();
        for (const f of (root.folders || [])) {
          const files = await Seedr.walkFolder(f.id);
          const match = files.find(x => x.path === path || x.name === path);
          if (match) return playFile(match.fileId, match.name);
        }
      } catch (_) {}
    }
    hideLoading();
    toast('File not found in library');
  }

  // ---------- Episode helpers ----------
  // Find the best torrent for the next episode of a show. Returns the
  // payload addToQueue() expects, or null if no next episode is available.
  // We try apibay directly with a season/episode query; if that misses, we
  // fall back to TVMaze for the canonical list and re-query per season.
  // Authoritative next-episode resolver. Walks the real TVMaze episode guide
  // (cached 24h) so it rolls across season boundaries correctly — the final
  // episode of a season resolves to E1 of the next season — regardless of
  // whether the caller pre-loaded season context. Falls back to the caller's
  // episodesInSeason/seasonNums heuristic only when TVMaze is unreachable.
  // Returns { season, episode, imdb } or null (genuine series finale).
  async function resolveNextEpisodeTarget(show) {
    if (!show || !show.title) return null;
    const cur = { season: show.season || 1, episode: show.episode || 0 };
    try {
      const sm = await TVMaze.seasonMap(show.title, show.year);
      if (sm && sm.seasons && sm.seasons.size) {
        if (!show.year && sm.show && sm.show.premiered) {
          show.year = String(sm.show.premiered).slice(0, 4) || null;
        }
        if (show.year && sm.show && sm.show.ambiguous) show.identityAmbiguous = true;
        const imdb = (sm.show && sm.show.imdb_id) || show.imdbId || show.imdb || null;
        const seasonNums = [...sm.seasons.keys()].sort((a, b) => a - b);
        const flat = [];
        for (const s of seasonNums) {
          for (const e of sm.seasons.get(s)) flat.push({ season: s, episode: e.number });
        }
        // Our position in the real ordered list; the next entry is the true
        // next episode — which crosses the season line when we're at a finale.
        const idx = flat.findIndex(e => e.season === cur.season && e.episode === cur.episode);
        if (idx >= 0) {
          return (idx + 1 < flat.length)
            ? { season: flat[idx + 1].season, episode: flat[idx + 1].episode, imdb }
            : null;   // last episode in the guide — series finale
        }
        // Current episode not in the guide (numbering mismatch): try same-season
        // next, else jump to the first episode of the next season that exists.
        const same = flat.find(e => e.season === cur.season && e.episode === cur.episode + 1);
        if (same) return { season: same.season, episode: same.episode, imdb };
        const ns = seasonNums.find(s => s > cur.season);
        if (ns) {
          const first = sm.seasons.get(ns)[0];
          return { season: ns, episode: first ? first.number : 1, imdb };
        }
        return null;
      }
    } catch (_) {}
    // Heuristic fallback — TVMaze unreachable.
    const imdb = show.imdbId || show.imdb || null;
    const epsInSeason = show.episodesInSeason || 0;
    const seasonNums = show.seasonNums || [];
    if (epsInSeason && cur.episode < epsInSeason) {
      return { season: cur.season, episode: cur.episode + 1, imdb };
    }
    if (seasonNums.length) {
      const i = seasonNums.indexOf(cur.season);
      if (i >= 0 && i + 1 < seasonNums.length) return { season: seasonNums[i + 1], episode: 1, imdb };
      return null;
    }
    return { season: cur.season, episode: cur.episode + 1, imdb };
  }

  async function findNextEpisodeQueueable(show, target) {
    if (!show || !show.title) return null;
    if (!target) {
      target = await resolveNextEpisodeTarget(show);
      if (!target) return null;   // series finale or unresolvable
    }
    // Seed the imdb id so Source B (EZTV) resolves without a second lookup.
    if (target.imdb && !show.imdbId && !show.imdb) show.imdbId = target.imdb;

    const baseQ = show.title.replace(/\s*\(\d{4}\).*$/, '').trim();
    const strictYear = !!(show.year && show.identityAmbiguous);
    const trackerBaseQ = strictYear ? `${baseQ} ${show.year}` : baseQ;
    const sStr = String(target.season).padStart(2, '0');
    const eStr = String(target.episode).padStart(2, '0');

    // Show-name match for next-episode. Same normalisation as _isShowMatch, but
    // also accepts a torrent whose name EXTENDS the canonical name — so a
    // "Example Show" (short title from a trending tile) still matches an
    // "Example.Show.Extended.S01E02" release, while never matching a shorter
    // unrelated show. The exact season+episode + seeded guards below keep this
    // from auto-queuing the wrong thing.
    function nextEpMatch(torrentName) {
      const inf = inferShowFromTitle(torrentName);
      if (!inf || !inf.title) return false;
      const a = _normShow(inf.title), b = _normShow(show.title);
      if (!a || !b) return false;
      if (!(a === b || a.startsWith(b))) return false;
      return !strictYear || _releaseYearMatches(torrentName, show.year);
    }

    // Source A: apibay (best when up — keyword search finds the exact variant).
    const candidates = [];
    for (const q of [
      `${trackerBaseQ} S${sStr}E${eStr}`,
      `${trackerBaseQ} ${target.season}x${eStr}`,
    ]) {
      try {
        const r = await ApiBay.search(q);
        for (const t of (r || [])) {
          if (!nextEpMatch(t.name)) continue;
          const p = parseEpisodeName(t.name);
          // Accept only single-episode torrents that match our exact season/episode,
          // and only when seeded — we don't want to enqueue a dead torrent.
          if (p.isPack) continue;
          if (p.season !== target.season || p.episode !== target.episode) continue;
          if (parseInt(t.seeders || 0, 10) <= 0) continue;
          if (parseInt(t.size || 0, 10) > MAX_FILE_BYTES) continue;
          if (_deadSeedrHashes.has((t.info_hash || '').toLowerCase())) continue;  // never took on seedr
          candidates.push({ t, p });
        }
      } catch (_) {}
      if (candidates.length) break;
    }
    if (candidates.length) {
      // Prefer 1080p over 4K (smaller, faster), then highest seeders.
      candidates.sort((a, b) => {
        const aIs1080 = a.p.quality.includes('1080p') ? 1 : 0;
        const bIs1080 = b.p.quality.includes('1080p') ? 1 : 0;
        if (aIs1080 !== bIs1080) return bIs1080 - aIs1080;
        return parseInt(b.t.seeders, 10) - parseInt(a.t.seeders, 10);
      });
      const pick = candidates[0];
      return {
        label: `${show.title} — S${sStr}E${eStr}`,
        add: {
          name: pick.t.name,
          magnet: ApiBay.magnet(pick.t),
          infoHash: pick.t.info_hash,
          poster: show.poster || null,
          show: { ...show, season: target.season, episode: target.episode },
          sizeBytes: parseInt(pick.t.size || 0, 10) || 0,
        },
      };
    }

    // Source B: EZTV fallback (imdb-scoped, reliable when apibay is down or
    // Cloudflare-gated). Resolve the show's imdb id from the saved show context
    // or, failing that, via TVMaze.
    let imdb = show.imdbId || show.imdb || null;
    if (!imdb && show.title) {
      try { const sm = await TVMaze.seasonMap(show.title, show.year); imdb = sm && sm.show && sm.show.imdb_id; }
      catch (_) {}
    }
    if (imdb && typeof EZTV !== 'undefined') {
      try {
        const got = await EZTV.episode(imdb, target.season, target.episode, { maxBytes: MAX_FILE_BYTES });
        if (got && got.infoHash && !_deadSeedrHashes.has((got.infoHash || '').toLowerCase())) {
          return {
            label: `${show.title} — S${sStr}E${eStr}`,
            add: {
              name: got.name,
              magnet: got.magnet,
              infoHash: got.infoHash,
              poster: show.poster || null,
              show: { ...show, season: target.season, episode: target.episode },
              sizeBytes: got.sizeBytes || 0,
            },
          };
        }
      } catch (_) {}
    }

    // Source C: Knaben meta-search (1337x + TPB + others). Last resort when
    // both apibay and EZTV miss — an exact S##E## keyword query, filtered to
    // the exact season/episode + seeded + size cap, same as Source A.
    if (typeof Knaben !== 'undefined') {
      for (const q of [
        `${trackerBaseQ} S${sStr}E${eStr}`,
        `${trackerBaseQ} ${target.season}x${eStr}`,
      ]) {
        try {
          const rows = await Knaben.search(q, { maxBytes: MAX_FILE_BYTES });
          const cands = [];
          for (const r of rows) {
            if (!nextEpMatch(r.name)) continue;
            const p = parseEpisodeName(r.name);
            if (p.isPack) continue;
            if (p.season !== target.season || p.episode !== target.episode) continue;
            if (_deadSeedrHashes.has((r.info_hash || '').toLowerCase())) continue;
            cands.push({ r, p });
          }
          if (!cands.length) continue;
          cands.sort((a, b) => {
            const a1 = a.p.quality.includes('1080p') ? 1 : 0;
            const b1 = b.p.quality.includes('1080p') ? 1 : 0;
            if (a1 !== b1) return b1 - a1;
            return b.r.seeders - a.r.seeders;
          });
          const pick = cands[0].r;
          return {
            label: `${show.title} — S${sStr}E${eStr}`,
            add: {
              name: pick.name,
              magnet: ApiBay.magnet(pick),
              infoHash: pick.info_hash,
              poster: show.poster || null,
              show: { ...show, season: target.season, episode: target.episode },
              sizeBytes: pick.size || 0,
            },
          };
        } catch (_) {}
      }
    }
    return null;
  }

  // Re-find a movie's torrent by title, for Continue-Watching self-heal. YTS
  // first (clean, quality-tagged), apibay as fallback. Returns a queueable
  // { label, add:{name,magnet,infoHash,poster,sizeBytes} } or null.
  async function findMovieQueueable(title, year) {
    const q = String(title || '')
      .replace(/\s*[—–-]\s*S\d+\s*E\d+.*$/i, '')   // strip any "— S01E02" episode tail
      .replace(/\s*\(\d{4}\).*$/, '')               // strip "(2019)…"
      .replace(/\s*\[[^\]]*\]\s*$/, '')             // strip "[1080p]" tags
      .trim();
    if (!q) return null;
    try {
      const yts = await YTS.search(q, { limit: 6, sort_by: 'seeds' });
      const movies = (yts && yts.movies) || [];
      let movie = (year && movies.find(m => String(m.year) === String(year))) || movies[0] || null;
      if (movie) { try { const d = await YTS.detail(movie.id); if (d && d.movie) movie = d.movie; } catch (_) {} }
      const best = movie ? pickBestTorrent(movie.torrents) : null;
      if (best) return {
        label: movie.title,
        add: {
          name: `${movie.title_long || movie.title} [${best.quality}]`,
          magnet: YTS.magnet(best, `${movie.title} ${best.quality}`),
          infoHash: best.hash,
          poster: movie.large_cover_image || movie.medium_cover_image || null,
          sizeBytes: best.size_bytes || 0,
        },
      };
    } catch (_) {}
    // apibay fallback (movies category): 4K fit under the cap wins, then
    // seed count. This matches the one-click YTS picker and the phone's
    // pre-resolver instead of silently dropping back to 1080p here.
    try {
      const rows = await ApiBay.search(q, { cat: 201 });
      const hit = (rows || [])
        .filter(r => r.info_hash && r.info_hash !== '0'.repeat(40))
        .filter(r => (parseInt(r.seeders) || 0) > 0)
        .filter(r => (parseInt(r.size) || 0) <= MAX_FILE_BYTES)
        .sort((a, b) => {
          const aq = _RE_IS_4K.test(a.name || '') ? 1 : 0;
          const bq = _RE_IS_4K.test(b.name || '') ? 1 : 0;
          if (aq !== bq) return bq - aq;
          return (parseInt(b.seeders) || 0) - (parseInt(a.seeders) || 0);
        })[0];
      if (hit) return {
        label: hit.name,
        add: {
          name: hit.name, magnet: ApiBay.magnet(hit), infoHash: hit.info_hash,
          poster: null, sizeBytes: parseInt(hit.size) || 0,
        },
      };
    } catch (_) {}
    return null;
  }

  // Continue-Watching self-heal. The tile's file is gone from the device (seedr
  // wiped, pen unplugged/pruned, cache evicted) and no local copy exists — so
  // instead of dead-ending with "pick it again", re-acquire the exact title from
  // its original source and resume from the saved position. Re-acquisition order,
  // most reliable first:
  //   1) a torrent hash/magnet recorded on the entry → re-download that exact torrent
  //   2) a TV episode (show.season+episode) → re-find that exact S##E## on the trackers
  //   3) otherwise a movie → re-find by title/year (YTS, apibay fallback)
  // The queued item carries the saved {position,duration}; openPlayer applies it
  // to the freshly-downloaded file's new id so playback continues where it left
  // off. Returns true if a re-fetch was started.
  // The concrete cached file backing a Continue-Watching entry, or null.
  // Matches on season/episode for a show, else on the recorded title -- the
  // same normalisation findNextEpisodeInLocalStores uses.
  async function findCachedFileFor(title, show) {
    const lists = [];
    try {
      if (typeof LaptopCache !== 'undefined' && LaptopCache.available()) {
        lists.push([await LaptopCache.listAll().catch(() => []), 'laptop']);
      }
    } catch (_) {}
    try {
      if (typeof PhoneCache !== 'undefined'
          && await PhoneCache.reachable().catch(() => false)) {
        lists.push([await PhoneCache.listAll().catch(() => []), 'cache']);
      }
    } catch (_) {}
    return _pickCachedMatch(lists, title, show);
  }

  // The best cached copy of `title` (or of show S##E##) across [files, kind]
  // lists; shared by findCachedFileFor and the instant tap-to-play check.
  function _pickCachedMatch(lists, title, show) {
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const wantShow = norm(show && show.title);
    const wantTitle = norm(String(title || '').split(' — ').pop());
    let best = null;
    for (const [files, kind] of lists) {
      for (const f of (files || [])) {
        const d = showFromFilename(f.name);
        if (wantShow && show && show.season && show.episode) {
          if (!d || d.season !== show.season || d.episode !== show.episode) continue;
          const t = norm(d.title);
          if (!t || (!wantShow.startsWith(t) && !t.startsWith(wantShow))) continue;
        } else {
          // Whole words only: "example" must not match "examples".
          const n = ' ' + norm(f.name) + ' ';
          if (!wantTitle || !n.includes(' ' + wantTitle + ' ')) continue;
        }
        const cand = { id: f.id, name: f.name, subtitles: f.subtitles || [], kind };
        // Prefer the higher-quality copy when the cache holds several.
        if (!best || _libQualityRank({ name: f.name }) > _libQualityRank({ name: best.name })) {
          best = cand;
        }
      }
    }
    return best;
  }

  async function refetchAndResume(it) {
    if (!it) return false;
    const saved = (it.fileId && Storage.getResume(it.fileId)) || {};
    const position = saved.position || it.position || 0;
    const duration = saved.duration || it.duration || 0;
    const title    = it.title || it.key || saved.title || '';
    const show     = it.show || saved.show || null;
    const poster   = it.poster || saved.poster || null;

    // Respect a user removal: a title the user deleted must NEVER silently
    // re-download itself. Clear the stale Continue-Watching tile so it stops
    // offering (and re-triggering) itself, and stop here.
    const remHash = String(it.redownloadHash || it.infoHash || saved.infoHash || '').toLowerCase();
    if (isRemoved({ hash: remHash, title })) {
      try { if (it.fileId) Storage.clearResume(it.fileId); } catch (_) {}
      if (currentTab === 'home') renderHome();
      toast('Removed earlier — not re-downloading');
      return false;
    }

    // (0) ALREADY ON THE LAPTOP CACHE — never re-download a file we own.
    //
    // This ran straight into the torrent paths below, so a Continue-Watching
    // entry whose recorded fileId had gone stale (the seedr staging area is
    // wiped routinely) re-fetched an episode that was sitting on the laptop
    // the whole time. The saved playhead is re-keyed onto the cached file's
    // own id so resume lands where the user left off rather than at 0.
    try {
      const localFile = await findCachedFileFor(title, show);
      if (localFile) {
        if (position > 5) {
          Storage.setResume(localFile.id, {
            position, duration, title, fileId: localFile.id,
            source: localFile.kind, poster, show,
          });
        }
        if (it.fileId && it.fileId !== localFile.id) {
          try { Storage.clearResume(it.fileId); } catch (_) {}
        }
        playDriveFile(localFile.id, localFile.name, poster, localFile.subtitles, show);
        return true;
      }
    } catch (_) { /* fall through to the normal re-fetch paths */ }

    let add = null;
    // (1) Exact torrent by recorded hash / magnet — the most faithful recovery.
    const hash = String(it.redownloadHash || it.infoHash || saved.infoHash || saved.redownloadHash || '')
      .replace(/[^a-f0-9]/gi, '').toLowerCase();
    const magnet = it.magnet || saved.magnet || (hash.length === 40 ? `magnet:?xt=urn:btih:${hash}` : null);
    if (magnet) {
      add = { name: title || 'Continue watching', magnet, infoHash: hash || null, poster, show, sizeBytes: 0 };
    }
    // (2) TV episode — re-find the exact CURRENT season/episode (target = current).
    if (!add && show && show.title && show.season && show.episode) {
      try {
        const found = await findNextEpisodeQueueable(show, { season: show.season, episode: show.episode });
        if (found && found.add) add = found.add;
      } catch (_) {}
    }
    // (3) Movie — re-find by title.
    if (!add && title) {
      try {
        const found = await findMovieQueueable(title, (show && show.year) || null);
        if (found && found.add) add = found.add;
      } catch (_) {}
    }
    if (!add || (!add.magnet && !add.infoHash)) {
      toast('Couldn’t re-fetch this one — try Search');
      return false;
    }
    add.autoplay = true;
    // Carry the resume so openPlayer applies it to the new download's fileId.
    add._resume = {
      position, duration, title,
      poster: poster || add.poster || null,
      show: show || add.show || null,
      fromFileId: it.fileId || null,
    };
    const at = (position && duration) ? ` — resuming at ${fmtTime(position)}` : '';
    toast(`Re-fetching "${title || add.name}"${at}`);
    addToQueue(add);
    return true;
  }

  // Set of queue phases counted as "still actively in flight" by the next-
  // episode prefetch throttle below. Hoisted so autoQueueNextEpisode doesn't
  // rebuild the same tiny array (and re-pay indexOf's linear scan) every call.
  const _ACTIVE_QUEUE_PHASES = new Set(['pending', 'adding', 'seedring', 'seedred', 'copying', 'cooldown']);

  // Run after a queue item finishes uploading to Drive — if it had show
  // context, auto-queue the next episode so the user doesn't have to hunt
  // it down manually.
  // Bake the NEXT episode's subtitles on the laptop WHILE the current one
  // plays. The subtitle pipeline costs ~30-45s from a cold start (ffprobe +
  // embedded-track extraction + bake — or an OpenSubs fetch + submit), and
  // starting that work only at playback leaves subtitles unavailable during
  // auto-advance. Prewarm the next known episode so subsState can already be
  // ready/embedded_pending when playback opens.
  //
  // Idempotent per playback/queue item (_subsPrewarmed). Fire-and-forget:
  // every failure path is silent because this is pure opportunism — the
  // at-play-time pipeline is untouched and still does the work if this
  // didn't get to run (user skipped ahead, laptop was busy, no next episode).
  async function prewarmNextEpisodeSubs(item) {
    if (!item || item._subsPrewarmed || item._subsPrewarmInFlight) return;
    if (!item.show || !item.show.season || !item.show.episode) return;
    // Availability, local-index lookup and the sync worker are all network/
    // disk operations. Do not permanently mark a transient miss as complete:
    // autoQueueNextEpisode is retried while playback continues, and a later
    // pass can prewarm as soon as the downloaded file lands in the cache.
    item._subsPrewarmInFlight = true;
    try {
      if (typeof LaptopCache === 'undefined' || !LaptopCache.available()) return;
      const target = await resolveNextEpisodeTarget(item.show).catch(() => null);
      if (!target) return;
      const hit = await findNextEpisodeInLocalStores(item.show, target).catch(() => null);
      if (!hit || !hit.fileId || !LaptopCache.isCacheId(hit.fileId)) return;
      // Kick the embedded-extraction job for the file's own subtitle track.
      // Instant no-op when a bake already exists (state ready/embedded_pending).
      const r = await LaptopCache.startSync(hit.fileId, {});
      let st = r && r.state;
      try { window.__bbEvent && window.__bbEvent('subs:prewarm', { s: target.season, e: target.episode, st: st || '?' }); } catch (_) {}
      // Stay with the background job until it actually settles. A single 55s
      // check was shorter than ffsubsync's own 300s timeout, so prewarm usually
      // walked away while work was still running and the next playback still
      // paid the cold-start delay. Bound this at 15 minutes, but keep it fully
      // asynchronous -- autoQueueNextEpisode never awaits this helper.
      if (st === 'syncing') {
        const deadline = Date.now() + 15 * 60 * 1000;
        while (st === 'syncing' && Date.now() < deadline) {
          await new Promise(res => setTimeout(res, 10000));
          try { st = (await LaptopCache.subsState(hit.fileId)).state; } catch (_) { return; }
        }
      }
      if (st === 'none') {
        const nextShow = { ...item.show, season: target.season, episode: target.episode };
        const cand = await fetchOpenSubsFallback(hit.name || '', nextShow).catch(() => null);
        if (cand && cand._content) {
          const submitted = await LaptopCache.startSync(hit.fileId, { srt: cand._content, name: cand.name });
          // Accepted is not the same as prepared: a `syncing` reply still has
          // no servable subtitle. Leave the success flag clear so the periodic
          // prewarm pass keeps watching/retrying until the manifest is ready.
          if (submitted && ['ready', 'embedded_pending'].includes(submitted.state)) {
            item._subsPrewarmed = true;
          }
          try { window.__bbEvent && window.__bbEvent('subs:prewarm', { s: target.season, e: target.episode, st: 'opensubs-submitted' }); } catch (_) {}
        }
      } else if (st === 'ready' || st === 'embedded_pending') {
        item._subsPrewarmed = true;
      }
    } catch (_) { /* opportunistic — never surfaces */ }
    finally { item._subsPrewarmInFlight = false; }
  }

  // Per-host memo of whether /season/* is reachable — probed once per
  // resolved engine base and remembered, rather than re-probing on every
  // trigger (early-play, 50%-watched, post-upload can all fire per item).
  // Keyed by Remux.base() so a Settings host change or an engine switch
  // (TV/Laptop) re-probes instead of trusting a stale answer for the
  // wrong host. season.py only ever runs alongside the cache bolt-on
  // (laptop-class hosts) — the TV engine simply has no route
  // there, so this naturally reads false for it without special-casing.
  const _seasonHostCache = new Map();
  async function _seasonAvailable() {
    if (typeof Remux === 'undefined') return false;
    let b;
    try { b = Remux.base(); } catch (_) { return false; }
    if (_seasonHostCache.has(b)) return _seasonHostCache.get(b);
    const st = await Remux.seasonStatus().catch(() => null);
    const ok = !!st;
    _seasonHostCache.set(b, ok);
    return ok;
  }

  async function autoQueueNextEpisode(item, opts = {}) {
    if (!item || !item.show || !item.show.season) return;
    // Subtitle prewarm rides every trigger that fires this function (early-
    // play at ~60s, 50%-watched, post-upload) — including the paths that
    // return early below because the next episode needs no DOWNLOAD. Needing
    // no download is precisely the case where the next play would otherwise
    // pay the 30s+ subtitle cold start.
    prewarmNextEpisodeSubs(item).catch(() => {});
    // The early-play, 50%-watched and post-upload triggers can overlap. Block
    // only a CURRENT attempt here; `_nextQueued` is set below only after the
    // target is genuinely local/queued. The old code marked it before any I/O,
    // so one transient search/enqueue/disk failure permanently disabled every
    // later retry for the rest of the playback.
    if (item._nextQueued || item._nextQueueInFlight) return;
    item._nextQueueInFlight = true;
    try {
      // Already on the pen/cache (Library in-order playback flags the next
      // episode as local) → nothing to fetch.
      if (item.show._localNext) { item._nextQueued = true; return; }
      // Don't pile up too far ahead. If there are already 2+ genuinely in-flight
      // downloads with show context, skip — the user is clearly batching. Count
      // ONLY active phases: an item that's errored or terminally stuck (e.g. a
      // copy orphaned by a restart whose seedr source is gone) must NOT count, or
      // it permanently blocks all future next-episode prefetch.
      const pending = queue.filter(q =>
        q.show && !q.error && _ACTIVE_QUEUE_PHASES.has(q.phase)).length;
      if (pending >= 2) return;
    // NEVER re-download something the laptop cache already has.
    //
    // item.show._localNext above only gets set by Library in-order playback,
    // so every OTHER entry point (Continue Watching, a loose file, the phone
    // remote, auto-advance) reached findNextEpisodeQueueable with no idea the
    // episode was sitting on the laptop already -- and queued a fresh torrent
    // for a file we own. Resolve the target once, ask the local stores first,
    // and only fall through to the torrent path on a genuine miss.
      const target = await resolveNextEpisodeTarget(item.show).catch(() => null);
      if (!target) return;                       // series finale / transiently unresolvable
      const localHit = await findNextEpisodeInLocalStores(item.show, target).catch(() => null);
      if (localHit) { item._nextQueued = true; return; }  // indexed cache hit
    // season.py's persistent queue (laptop, survives the TV screen
    // turning off) is preferred over this client-side `queue` array (which
    // dies with the app) whenever the active engine's host exposes it. A
    // pre-check against the server's OWN queue state catches an episode
    // that's already queued/downloading/ready there but hasn't landed in
    // LaptopCache's listing yet (so findNextEpisodeInLocalStores above missed
    // it) — season.enqueue() itself also dedupes by release name, but we
    // don't have that name until findNextEpisodeQueueable runs its (costly)
    // torrent search below, so this show/season/episode check is the
    // cheaper first line of defense against a redundant search+enqueue.
      const seasonOn = await _seasonAvailable().catch(() => false);
      if (seasonOn) {
        const st = await Remux.seasonStatus().catch(() => null);
        const already = st && Array.isArray(st.items) && st.items.some(it => it
          && String(it.show || '').toLowerCase() === String(item.show.title || '').toLowerCase()
          && it.season === target.season && it.episode === target.episode
          && it.state !== 'error');
        if (already) { item._nextQueued = true; return; }
      }
      const next = await findNextEpisodeQueueable(item.show, target).catch(() => null);
      if (!next) return;
      if (seasonOn) {
        const enq = await Remux.seasonEnqueue([{
          name: next.add.name,
          kind: 'magnet',
          source: next.add.magnet,
          show: item.show.title,
          season: target.season,
          episode: target.episode,
          bytes: next.add.sizeBytes || 0,
        }]).catch(() => null);
        if (enq && enq.added > 0) {
          item._nextQueued = true;
          toast(`Queued next (server): ${next.label}`);
          return;
        }
        if (enq) {
          // `added:0` is only success if a NON-ERROR copy really exists. Older
          // servers deduped failed entries too; accepting that no-op is what
          // left an episode permanently stuck after one disk-floor failure.
          const confirm = await Remux.seasonStatus().catch(() => null);
          const live = confirm && Array.isArray(confirm.items) && confirm.items.some(it => it
            && String(it.show || '').toLowerCase() === String(item.show.title || '').toLowerCase()
            && it.season === target.season && it.episode === target.episode
            && it.state !== 'error');
          if (live) { item._nextQueued = true; return; }
        }
        // Enqueue failed or was a failed-item no-op — use the client queue as a
        // fallback instead of silently declaring the episode handled.
      }
      // Don't double-queue if we're already downloading this exact infoHash.
      if (queue.some(q => (q.infoHash || '').toLowerCase() === next.add.infoHash.toLowerCase())) {
        item._nextQueued = true;
        return;
      }
      addToQueue({ ...next.add, priority: !!opts.priority });
      item._nextQueued = true;
      toast(`Queued next: ${next.label}`);
    } finally {
      item._nextQueueInFlight = false;
    }
  }

  // ---------- Player ----------
  // The player runs as one big overlay above the rest of the UI. State lives
  // on `currentVideo`; the DOM nodes live in #player. We keep the menus
  // (audio / subtitle / speed) as a separate stack so opening one hides
  // whatever was visible before.
  let activeMenu = null;        // 'audio' | 'subtitles' | 'speed' | null
  let upnextTimer = null;
  let upnextDeadline = 0;
  // Set once the user EXPLICITLY dismisses the auto-triggered Up Next card
  // (Back / Cancel) — per-file, reset in openPlayer(). Distinct from just
  // hiding the dialog (see rearmUpNext()): a dismissal must suppress the
  // credits-window auto-offer for the rest of THIS file even if playback
  // later seeks back out of the credits window and re-enters it.
  let upnextAutoDismissed = false;

  // Hoisted regexes — built once instead of per function call (openPlayer and
  // persistCurrentResume can run many times over a playback session).
  const _PLAYER_HTTPS_RE = /^https?:/i;
  const _PLAYER_EPISODE_RE = /\bS\d{1,2}[._\s-]?E\d{1,3}\b|\b\d{1,2}x\d{2}\b/i;
  const _PLAYER_PHONEKEY_RE = /^phone:/;

  function pToast(msg) {
    const t = $('#p-toast');
    t.hidden = false;
    t.textContent = msg;
    requestAnimationFrame(() => t.classList.add('is-shown'));
    clearTimeout(pToast._t);
    pToast._t = setTimeout(() => {
      t.classList.remove('is-shown');
      setTimeout(() => { t.hidden = true; }, 200);
    }, 900);
  }

  // Conservative byte-window estimate for direct growing-file playback.
  // A single served interval must contain both decoder safety margins.
  function growingSeekDecision(targetSeconds, duration, total, ranges, bytesPerSec) {
    const unknown = { allowed: false, seconds: null };
    if (!Number.isFinite(targetSeconds) || !Number.isFinite(duration) || duration <= 0
        || !Number.isFinite(total) || total <= 0) return unknown;
    const est = (Math.max(0, Math.min(duration, targetSeconds)) / duration) * total;
    const margins = growingSeekMargins(duration, total);
    const start = Math.max(0, est - margins.before);
    const end = Math.min(total, est + margins.after);
    let frontier = 0;
    const validRanges = (Array.isArray(ranges) ? ranges : []).filter(r => Array.isArray(r) && r.length === 2
      && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[0] >= 0 && r[1] > r[0]);
    for (const r of validRanges) {
      if (r[0] <= start && r[1] >= end) return { allowed: true, seconds: 0 };
      if (r[0] <= start) frontier = Math.max(frontier, Math.min(r[1], end));
    }
    // Include the gap from the nearest downloaded frontier to the required
    // window, subtracting any tail bytes already present. Aggregate lane speed
    // gives a rough wait, not a promise about the next server range update.
    let needed = end - frontier;
    for (const r of validRanges) {
      needed -= Math.max(0, Math.min(end, r[1]) - Math.max(frontier, r[0]));
    }
    return { allowed: false, seconds: Number.isFinite(bytesPerSec) && bytesPerSec > 0
      ? Math.max(1, Math.ceil(Math.max(0, needed) / bytesPerSec)) : null };
  }

  // Bytes a seek on the partial laptop copy needs around its target: ~10 s
  // before it (fastSeek lands on an earlier keyframe) and ~30 s after it
  // (play buffer while the copy catches up), with small floors. The player
  // (tv-player.js copyMargins) trims the drawn downloaded segments by
  // the same amounts, so a grey area on the seek bar is always jumpable.
  function growingSeekMargins(duration, total) {
    const rate = total / duration;
    return { before: Math.max(4 * 1024 * 1024, rate * 10, total * 0.005),
             after: Math.max(32 * 1024 * 1024, rate * 30, total * 0.02) };
  }

  // Seedr remains sequential-only; growing local playback may seek into a
  // downloaded window. Every caller passes an absolute movie-time target.
  // `silent` is for internal re-seeks (resume, recycle): no user toast.
  let _seedrSeekNoticeAt = 0;
  function blockDirectSeedrSeek(targetSeconds, silent) {
    const cv = currentVideo;
    if (!cv || cv.isLive) return false;
    let decision = null;
    if (!cv._directSeedr && !cv._localHandoffPending) {
      if (!cv._growingCache) return false;
      const v = $('#video');
      decision = growingSeekDecision(targetSeconds, cv._parked ? cv._parked.dur : v.duration, cv._growingTotal,
        cv._growingRanges, cv._growingBytesPerSec);
      if (decision.allowed) {
        cv._growingSeekTarget = targetSeconds;
        return false;
      }
    }
    if (silent) return true;
    // Held D-pad events must not churn the toast compositor.
    const now = Date.now();
    if (now - _seedrSeekNoticeAt > 900) {
      _seedrSeekNoticeAt = now;
      pToast(cv._localHandoffPending
        ? 'Switching to local cache — seeking unlocks in a moment'
        : cv._directSeedr
          ? 'Caching in background — seeking unlocks after the local switch'
          : 'That part is still downloading' + (decision && decision.seconds !== null
            ? ' — ready in ~' + decision.seconds + ' s' : ''));
      try { window.__bbEvent && window.__bbEvent('seedr:seek-blocked', { handoff: !!cv._localHandoffPending }); } catch (_) {}
    }
    return true;
  }

  function scheduleGrowingWaitNotice(v) {
    const cv = currentVideo;
    if (!cv || !cv._growingCache || cv._localHandoffPending || cv._parked) return;
    if (cv._growingWaitTimer) return;
    cv._growingWaitTimer = setTimeout(() => {
      cv._growingWaitTimer = null;
      if (currentVideo !== cv || !cv._growingCache || cv._localHandoffPending || cv._parked) return;
      const target = Number.isFinite(cv._growingSeekTarget) ? cv._growingSeekTarget : v.currentTime;
      // Recheck the latest ranges/rate after the decoder has waited a beat.
      // This only explains the wait; keep the growing request and source alive.
      blockDirectSeedrSeek(target);
    }, 2200);
  }

  // Snappy directional seek indicator. Shows only the accumulated skip amount
  // ("«30s" / "30s»") on the side you're seeking toward, WITHOUT summoning the
  // full controls overlay. Instant paint, quick auto-hide after the last press.
  function showSeekIndicator(delta) {
    const el = document.getElementById('p-seek');
    if (!el) return;
    const fwd = delta >= 0;
    const secs = Math.abs(delta);
    el.classList.toggle('left', !fwd);
    el.classList.toggle('right', fwd);
    el.innerHTML = fwd
      ? `<span class="p-seek-num">${secs}s</span><span class="p-seek-chev">»</span>`
      : `<span class="p-seek-chev">«</span><span class="p-seek-num">${secs}s</span>`;
    el.hidden = false;
    el.classList.add('is-shown');
    clearTimeout(showSeekIndicator._t);
    showSeekIndicator._t = setTimeout(() => {
      el.classList.remove('is-shown');
      setTimeout(() => { el.hidden = true; }, 150);
    }, 650);
  }

  function setBuffering(on) { $('#p-buffering').hidden = !on; }

  function setPlayIcon(playing) {
    const path = playing
      ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>'              // pause
      : '<path d="M7 4l13 8-13 8V4z"/>';                       // play
    $('#p-play-icon').innerHTML = path;
  }

  // Assign a media URL to the <video> element. The optional music service's
  // /music/stream rewraps .m4a on the fly so what arrives at the TV is
  // already a container webOS knows (MKV for Dolby Atmos eac3 / AAC, FLAC
  // for ALAC) — the platform sniffs the response Content-Type and routes to
  // the audio decoder, which on webOS is what carries Dolby bitstream
  // through to eARC. So a plain `v.src = url` is enough; no source-element
  // gymnastics needed.

  // ---- native-player handoff -------------------------------------------
  // The webOS built-in Media Player (com.webos.app.mediadiscovery) runs OUTSIDE
  // the web-app sandbox and uses a separate memory budget. A handoff can
  // reduce pressure on the WebView during high-resolution playback.
  //
  // Use `luna://com.webos.applicationManager/launch` for handoff. Launch
  // permission is independent of enumeration methods (listLaunchPoints /
  // getAppInfo / running), which may return "Denied method call".
  //
  // Deep-link support depends on the target player. launch()
  // returns success regardless of whether the target app understood `params`,
  // so if the deep link is ignored the user simply lands on the Media Player's
  // own screen and picks the file. That degradation is acceptable and is why
  // nothing here treats a `true` return as proof of playback.
  // ---- laptop-player (external display / AV receiver) glue ---------------
  // Defaults off because webOS suspends this app while an HDMI input is
  // active. Enable it when an external player and remote are configured.
  function laptopPlayerOn() {
    try { return Storage.get('laptopPlayer', false) === true; } catch (_) { return false; }
  }
  // Select the configured HDMI input for an external display / AV receiver.
  // Input apps use the same applicationManager/launch call as native-player
  // handoff. The function name is retained for compatibility with callers.
  function switchTvToSoundbarInput() {
    try {
      if (typeof PalmServiceBridge === 'undefined') return false;
      const id = Storage.get('laptopHdmiApp', '');
      if (!id) return false;
      const b = new PalmServiceBridge();
      b.onservicecallback = function () {};
      b.call('luna://com.webos.applicationManager/launch', JSON.stringify({ id }));
      return true;
    } catch (_) { return false; }
  }

  // ---- laptop playback controller (TV-remote control after returning) ----
  // webOS suspends this app while the configured HDMI input is active, so
  // app code cannot receive remote keys then. On return, show D-pad controls
  // for pause/seek/stop and switching back to video. The companion service's
  // /remote page can control playback while this app is suspended.
  let _lpCtlTimer = null;
  async function maybeShowLaptopController() {
    try {
      if (typeof LaptopCache === 'undefined' || !LaptopCache.playerStatus || !laptopPlayerOn()) return;
      if (currentVideo) return;                          // TV is already playing something
      const st = await LaptopCache.playerStatus();
      if (!st || !st.running) return;
      showLaptopController(st);
    } catch (_) {}
  }
  function showLaptopController(st) {
    const card = $('#modal-card'), modalEl = $('#modal');
    if (!card || !modalEl || modalEl.classList.contains('is-open')) return;
    const esc = s => escapeHtml(String(s || ''));
    card.innerHTML = `
      <h2 style="margin:0 0 6px;">Playing on external display / AV receiver</h2>
      <p class="muted" id="lp-title" style="margin:0 0 4px;">${esc(st.title || st.rel)}</p>
      <p class="muted" id="lp-pos" style="margin:0 0 16px;"></p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button class="btn btn-primary" id="lp-watch">▶ Watch (switch TV input)</button>
        <button class="btn" id="lp-toggle">${st.paused ? 'Resume' : 'Pause'}</button>
        <button class="btn" id="lp-b30">−30s</button>
        <button class="btn" id="lp-f30">+30s</button>
        <button class="btn" id="lp-stop">⏹ Stop laptop playback</button>
        <button class="btn" id="lp-close">Close</button>
      </div>`;
    const close = () => {
      clearInterval(_lpCtlTimer); _lpCtlTimer = null;
      modalEl.classList.remove('is-open');
      try { DPad.popBackHandler(); } catch (_) {}
    };
    const paint = (s) => {
      if (!s) return;
      const posEl = $('#lp-pos'), tEl = $('#lp-toggle');
      if (posEl) posEl.textContent = `${fmtTime(s.pos || 0)} / ${fmtTime(s.dur || 0)}`
        + (s.paused ? ' · paused' : '') + (s.aoFormat ? ` · ${s.aoFormat}` : '');
      if (tEl) tEl.textContent = s.paused ? 'Resume' : 'Pause';
    };
    paint(st);
    $('#lp-watch').onclick = () => { switchTvToSoundbarInput(); };
    $('#lp-toggle').onclick = async () => {
      const cur = await LaptopCache.playerStatus().catch(() => null);
      await LaptopCache.playerCmd(cur && cur.paused ? 'resume' : 'pause').catch(() => {});
      paint(await LaptopCache.playerStatus().catch(() => null));
    };
    $('#lp-b30').onclick = () => LaptopCache.playerCmd('seek', { delta: -30 }).catch(() => {});
    $('#lp-f30').onclick = () => LaptopCache.playerCmd('seek', { delta: 30 }).catch(() => {});
    $('#lp-stop').onclick = async () => { await LaptopCache.playerStop().catch(() => {}); close(); };
    $('#lp-close').onclick = close;
    DPad.pushBackHandler(close);
    modalEl.classList.add('is-open');
    setTimeout(() => { try { DPad.focus($('#lp-watch')); } catch (_) {} }, 50);
    clearInterval(_lpCtlTimer);
    _lpCtlTimer = setInterval(async () => {
      if (!modalEl.classList.contains('is-open')) { clearInterval(_lpCtlTimer); return; }
      const s = await LaptopCache.playerStatus().catch(() => null);
      if (s && !s.running) { close(); return; }   // finished/stopped elsewhere
      paint(s);
    }, 3000);
  }

  const NATIVE_PLAYER_ID = 'com.webos.app.mediadiscovery';
  function nativeHandoffEnabled() {
    try { return Storage.get('nativeFor4K', true) !== false; } catch (_) { return true; }
  }
  function looks4K(title) {
    return /2160p|\b4k\b|\buhd\b/i.test(String(title || ''));
  }
  function handoffToNativePlayer(url, title) {
    if (!url || typeof PalmServiceBridge === 'undefined') return false;
    try {
      const b = new PalmServiceBridge();
      b.onservicecallback = function () {};
      // Several param spellings in one call: the player ignores what it does
      // not recognise, and this costs nothing versus guessing wrong.
      b.call('luna://com.webos.applicationManager/launch', JSON.stringify({
        id: NATIVE_PLAYER_ID,
        params: { target: url, uri: url, path: url, mediaType: 'video', title: title || '' },
      }));
      try { window.__bbEvent && window.__bbEvent('native:handoff', { t: String(title || '').slice(0, 40) }); } catch (_) {}
      return true;
    } catch (_) { return false; }
  }

  // Single video path: hand the URL to webOS's native pipeline (see
  // js/native-player.js for the transport details). Nothing here buffers
  // media in JavaScript.
  //
  // Fetching media into ArrayBuffers for MSE charges those allocations to
  // the WebView's memory budget. Native URI playback keeps media buffering
  // outside the JavaScript heap and avoids SourceBuffer scheduling stalls.
  function setVideoSource(v, url, opts = {}) {
    if (v._firstPlayingCleanup) v._firstPlayingCleanup();
    if (currentVideo) currentVideo._sourceGen = (currentVideo._sourceGen || 0) + 1;
    NativePlayer.load(v, url, { startTime: opts.startTime });
  }

  // Keep NativePlayer's buffer-runaway watchdog active for every finite video.
  // Its dump hook now routes through bindPlayer's remux-aware recycle, so an
  // HLS session is restarted at ABSOLUTE movie time instead of reloading a
  // stale rolling-window URL at a relative timestamp.
  function _syncWatchdog(v, isAudio) {
    try {
      if (!v || isAudio) { NativePlayer.stopWatchdog(); return; }
      NativePlayer.startWatchdog(v);
    } catch (_) {}
  }

  // Seek for a resume/swap landing. Prefer fastSeek — it snaps to the nearest
  // keyframe, whereas a plain `currentTime =` to a cold (unbuffered) mid-GOP
  // offset makes webOS decode-error (code 3), especially on MKV and right after
  // a seedr→local source swap. Keyframe-aligning lets the decoder start clean.
  function resumeSeek(v, t) {
    t = Math.max(0, t || 0);
    const cv = currentVideo;
    // Internal restores stay as before on Seedr and during source handoffs
    // (they restore the same position). Only steady growing-file playback
    // must not jump past the downloaded bytes: that read would stall.
    const growing = cv && cv._growingCache && !cv._directSeedr && !cv._localHandoffPending;
    const abs = (typeof Remux !== 'undefined' && Remux.hasSession()) ? Remux.absolute(t) : t;
    if (growing && blockDirectSeedrSeek(abs, true)) return false;
    if (typeof v.fastSeek === 'function') {
      try { v.fastSeek(t); return true; } catch (_) {}
    }
    try { v.currentTime = t; return true; } catch (_) { return false; }
  }

  // Chapter marks and format badges for a laptop source. A Seedr link is never
  // probed: ffprobe on it is a third Seedr connection next to the TV stream
  // and the laptop copy (Seedr allows two); which can cause ffprobe 502s and
  // timeouts right as the copy started. The engine maps its own cache links
  // to the local file, so this costs no Seedr traffic.
  function inspectLaptopMedia(cv, src) {
    if (!cv || !src || /seedr\.cc/i.test(src)) return;
    if (typeof Remux === 'undefined' || typeof Remux.inspectMedia !== 'function'
        || Remux.engine() !== 'laptop' || !Remux.availableFor('laptop')) return;
    const gen = cv._sourceGen;
    Remux.inspectMedia(src).then(info => {
      if (!info || currentVideo !== cv || cv._sourceGen !== gen) return;
      if (Array.isArray(info.chapters)) cv._chapters = info.chapters;
      cv._mediaInfo = { video: info.video || null, audio: info.audio || [] };
      renderMediaInfo(cv._mediaInfo);
    }).catch(() => {});
  }

  function openPlayer(src, title, meta = {}) {
    _openReqSeq++;   // any new playback supersedes a still-awaiting async play path
    hideLoading();   // the player takes over from the pre-stream loading overlay
    // Anything starting on the TV supersedes external playback to prevent
    // overlapping audio from the previous title. Fire-and-
    // forget; a no-op when nothing is playing there.
    try {
      if (typeof LaptopCache !== 'undefined' && LaptopCache.playerStop && laptopPlayerOn()) {
        LaptopCache.playerStop();
      }
    } catch (_) {}
    // Playback can start with NO remote key press (Up-Next auto-advance, crash
    // auto-resume, phone/gesture remote) — and the idle screensaver only
    // dismisses on key/mouse/touch. Without this, an active saver keeps
    // streaming + decoding a 4K ambient clip behind the movie indefinitely
    // (two simultaneous decodes → OOM). Every playback start dismisses it.
    try { Screensaver.wake(); } catch (_) {}
    const v = $('#video');
    const playerEl = $('#player');
    // A hot source switch can move from an existing remux generation to a
    // direct laptop-cache URL without first closing the fullscreen player
    // (cache takeover, retry, or an explicit Direct Play reopen). Merely
    // bindVideo(null) does not close Remux's session/time base; leaving it alive
    // makes the direct file inherit the old HLS offset and routes seek/subtitle
    // clocks through a session that no longer owns the <video>. Tear it down
    // before currentVideo is replaced. Normal direct opens are a no-op here.
    try {
      if (!meta._remux && typeof Remux !== 'undefined' && Remux.hasSession()) {
        Remux.close();
        Remux.bindVideo(null);
      }
    } catch (_) {}
    // Capture whether the player was already open before we mutate anything.
    // Music auto-advance calls openPlayer() while is-open is already set;
    // we must not push a second back-handler in that case.
    const playerWasOpen = playerEl.classList.contains('is-open');
    if (!playerWasOpen) {
      const focused = DPad.current() || document.activeElement;
      playerEl._browseFocus = focused && !focused.closest('#player') ? focused : null;
    }
    // meta.subtitle may be a resolved sub object/null (the historical
    // contract) OR a Promise that resolves to one — callers on the seedr hot
    // path hand over a Promise so sibling-subtitle discovery (a Seedr folder
    // walk) never blocks play; it's awaited once, right where it's first
    // read, inside the async subtitle IIFE below. Every other synchronous use
    // in this function reads `fileId`/`source`/`poster` only.
    const { fileId, source, poster } = meta;
    const subtitleMeta = meta.subtitle;
    const isLive = source === 'live';

    // 4K -> hand the file to the TV's own player and stop here. Our <video>
    // lives inside WAM's low-end-device sandbox, which is what makes 4K
    // OOM-prone in-app; the native player has the whole device. Only for
    // laptop-cached files, because only those have a token-bearing URL the
    // native player can fetch without credentials (LaptopCache.streamUrl embeds
    // ?token=, so no SMB login prompt).
    try {
      if (!isLive && nativeHandoffEnabled() && looks4K(title)
          && typeof LaptopCache !== 'undefined' && fileId && LaptopCache.isCacheId
          && LaptopCache.isCacheId(fileId)) {
        const nurl = LaptopCache.streamUrl(fileId);
        if (nurl && handoffToNativePlayer(nurl, title)) {
          try { pToast('Opening in the TV player (4K)'); } catch (_) {}
          return;
        }
      }
    } catch (_) { /* fall through to normal in-app playback */ }
    const isAudio = source === 'music' || !!meta.isAudio;
    // If the caller didn't pass show context (Library / direct seedr file
    // / older CW entry), infer it from the filename so the next-episode
    // 50%-watched trigger and post-upload chain still fire for TV content.
    // Skip inference for live channels and audio — "Track 03 S01E01" would
    // be a false positive on a track name.
    const show = (isLive || isAudio) ? null : (meta.show || inferShowFromTitle(title));
    cancelGrowingHandoff(currentVideo);
    currentVideo = {
      src, title, fileId, source, poster, show, isLive, isAudio,
      // `source:'seedr'` is retained for some cache-hit resume identities, so
      // keep a separate truth bit for whether media bytes still come from the
      // signed Seedr upstream. A verified cache hit must remain seekable.
      _directSeedr: source === 'seedr' && !meta.cacheRel,
      subFilename: meta.subFilename || '',
      codec: meta.codec || '', profile: meta.profile || '',
      // Alternate stream URLs (live only) — error handler walks this list
      // when a feed 403s / 404s / DNS-fails so the user doesn't get stuck on
      // a single dead mirror.
      fallbacks: Array.isArray(meta.fallbacks) ? meta.fallbacks.slice() : [],
      // Back-ref to the queue item this playback belongs to (only set when
      // the play path was triggered from a queued seedr item). closePlayer
      // uses it to release the seedr lock and trigger deferred cleanup.
      _queueItem: meta._queueItem || null,
      // The walk_music() entry that drove this audio playback, if any.
      // MusicRemote reads it to publish trackId/codec/sampleRate to the
      // optional phone music remote.
      _musicItem: meta.musicItem || null,
      // Remux session handle ({sessionId, playbackMode, originalDuration,
      // actualStartTime,...}) when this playback goes through the TV/laptop
      // HLS remux; null for a normal direct URL. Drives absolute-time mapping.
      _remux: meta._remux || null,
      // Cache-relative path (server's /cache/... identity) when this playback
      // is serving from a laptop on-disk cache hit — playDriveFile and
      // _playSeedrCacheHit are the only two callers that ever set it. Lets the
      // TV player's scrub-preview code ask /cache/thumbs for a storyboard;
      // null (no previews) for every other source, including a direct seedr
      // URL or a cache MISS that fell through to seedr.
      _cacheRel: meta.cacheRel || null,
    };
    v.querySelectorAll('track').forEach(t => {
      if (t._objectUrl) URL.revokeObjectURL(t._objectUrl);
      t.remove();
    });
    // Clear the previous video's subtitle overlay immediately so stale cues
    // cannot render over a new title while its subtitle finder is pending or
    // returns no match. The finder/sibling subtitle repaints the clean overlay.
    clearSubOverlay();
    // Resolve the resume position BEFORE assigning src — on a cached source the
    // browser can fire `loadedmetadata` synchronously between `v.src=` and the
    // pendingResume assignment, dropping the seek.
    // Live streams have no resume — every join is "now".
    currentVideo._pendingResume = null;
    if (fileId && !isLive) {
      const saved = Storage.getResume(fileId);
      if (saved && saved.position && saved.duration
          && saved.position < saved.duration - 30) {
        currentVideo._pendingResume = saved.position;
        currentVideo._handoffClock = { position: saved.position, duration: saved.duration };
      }
    }
    // Continue-Watching self-heal: this playback is a re-fetch of a title whose
    // original file went missing (see refetchAndResume). The fresh download has
    // a brand-new fileId with no resume history, so seed the seek from the
    // position we carried on the queue item and persist it under the new id —
    // both so this session resumes in place and so the CW tile now points at the
    // recovered file. Retire the dead tile to avoid two entries for one title.
    if (fileId && !isLive && !currentVideo._pendingResume) {
      const rq = meta._queueItem && meta._queueItem._resume;
      // Resume on a meaningful position even if we never captured a duration —
      // "Continue" must never restart from zero. (Only skip if we KNOW the saved
      // point is within 30s of the end.)
      if (rq && rq.position > 5 && (!rq.duration || rq.position < rq.duration - 30)) {
        currentVideo._pendingResume = rq.position;
        try {
          Storage.setResume(fileId, {
            position: rq.position, duration: rq.duration || 0,
            title: rq.title || title, fileId, source,
            poster: rq.poster || poster || null,
            show: show || rq.show || null, ts: Date.now(),
          });
          if (rq.fromFileId && rq.fromFileId !== fileId) Storage.clearResume(rq.fromFileId);
        } catch (_) {}
        rq.position = 0;   // single-shot — don't re-seed on auto-advance
      }
    }
    // Toggle the player's live styling — hides the seek bar / time / speed /
    // rew / fwd controls and shows the LIVE badge.
    playerEl.classList.toggle('is-live', isLive);
    playerEl.classList.toggle('is-audio', isAudio);
    // Ask the native pipeline to OPEN at the resume offset rather than loading
    // at 0 and seeking there afterwards. Only for direct playback: under remux
    // the server already opened the stream at the position, so the window is
    // relative and a start offset would double-apply. _pendingResume stays set
    // either way — the loadeddata handler still seeks if this didn't take.
    setVideoSource(v, src, {
      isAudio, codec: meta.codec,
      startTime: currentVideo._remux ? 0 : (currentVideo._pendingResume || 0),
    });
    // Watch for the pipeline accumulating instead of draining, and dump the
    // decoder before WAM gets SIGKILLed. See NativePlayer's watchdog notes.
    // Remux-aware through bindPlayer's recycle hook — see _syncWatchdog.
    _syncWatchdog(v, isAudio);
    // Bind the <video> to the remux module (for seek/health/absolute-time)
    // ONLY when this playback is a remux session; null clears any prior bind.
    if (typeof Remux !== 'undefined') {
      Remux.bindVideo(currentVideo._remux ? v : null);
    }
    setPlayerRate(v, 1);
    // Defensive unmute: the <video> element persists across playbacks (this
    // function never recreates it), so a mute set by the remote 'mute'
    // command on a PREVIOUS title otherwise silently carries onto this
    // completely unrelated one — nothing else resets v.muted at playback
    // start. openPlayer is the one place every playback funnels through, so
    // it's the right place to guarantee a clean slate.
    v.muted = false;
    if (show && show.season && show.episode) {
      $('#p-show').textContent = `${show.title} · S${String(show.season).padStart(2,'0')}E${String(show.episode).padStart(2,'0')}`;
    } else {
      $('#p-show').textContent = '';
    }
    $('#p-title').textContent = title;
    $('#p-bar-fill').style.width = '0%';
    $('#p-bar-buffer').style.width = '0%';
    $('#p-bar-thumb').style.left = '0%';
    $('#p-time').textContent = '0:00 / 0:00';
    $('#p-time-remaining').textContent = '';
    const ccEl = $('#p-cc');
    // R1: start OFF regardless of whether a sibling sub exists — a sibling
    // is now just a candidate (see the post-load IIFE below), never
    // auto-shown, so the icon must not claim "on" for something that isn't
    // actually displayed yet. Each async path below flips it to 'on' (shown)
    // or 'pending' (verifying) only once it truly attaches something.
    ccEl.dataset.state = 'off';
    if (isAudio) {
      updateShuffleButton();
    }
    $('#p-upnext').hidden = true;
    $('#p-skip').hidden = true;   // reset from the previous video
    upnextAutoDismissed = false;
    const miEl = $('#p-mediainfo');
    miEl.hidden = true; miEl.innerHTML = '';
    closeMenu();
    setBuffering(true);
    playerEl.classList.add('is-open');
    // Take the (now fully-occluded) home/tab DOM out of the compositor while the
    // opaque fullscreen player is up — frees its decoded poster/backdrop bitmaps
    // and GPU layers for the whole session so they don't fight the video decoder
    // for limited GPU memory. Removed again in closePlayer.
    document.body.classList.add('has-player');
    showOverlay();
    const playCv = currentVideo;
    const startPlayback = (retried) => {
      let attempt;
      try { attempt = v.play(); }
      catch (e) { attempt = Promise.reject(e); }
      if (!attempt || typeof attempt.catch !== 'function') return;
      attempt.catch(e => {
        if (currentVideo !== playCv) return;
        // A back-to-back episode transition releases the previous hardware
        // decoder before opening the next source. Chromium/webOS may settle
        // that old pause/load one task after the new play(), rejecting it with
        // AbortError even though the new source is decoded and ready. Retry
        // once after the teardown settles; only surface a real second failure.
        const interrupted = e && (e.name === 'AbortError'
          || /play\(\) request was interrupted by a call to (?:pause|load)/i.test(e.message || ''));
        if (!retried && interrupted) {
          setTimeout(() => {
            if (currentVideo === playCv && v.paused) startPlayback(true);
          }, 120);
          return;
        }
        // A seedr cold-start rejects play() with "no supported source was found"
        // on the first hit of a freshly-minted ff_get link (seedr is still
        // preparing the file). The `error` event fires alongside and drives the
        // warm-up retry below — so don't also flash a scary fatal toast here for
        // a source we're about to self-heal.
        if (source === 'seedr') return;
        toast('Playback error: ' + e.message);
      });
    };
    startPlayback(false);
    // Some Seedr CDN failures never emit a media `error` on webOS: the player
    // remains in `waiting` at 0:00 indefinitely. Give direct Seedr playback a
    // short runway, then retry the same fresh URL through the configured remux
    // engine. If the URL has become a hard 4xx in the meantime, the explicitly
    // enabled protected-torrent fallback takes over for a queue-backed item.
    if (source === 'seedr' && !currentVideo._remux) {
      const cv = currentVideo;
      cv._hasPlayed = false;
      cv._seedrStartTimer = setTimeout(async () => {
        cv._seedrStartTimer = 0;
        if (currentVideo !== cv || cv._hasPlayed || cv._directSeedr === false || v.readyState >= 2) return;
        const sourceGen = cv._sourceGen;
        const ownsSource = () => currentVideo === cv && cv._sourceGen === sourceGen
          && cv._directSeedr !== false && !cv._localHandoffPending;
        try { window.__bbEvent && window.__bbEvent('seedr:start-stall', { rs: v.readyState, ns: v.networkState }); } catch (_) {}
        if (cachedPlaybackFile(cv._queueItem, cv)) {
          swapPlaybackToDrive(cv._queueItem);
          return;
        }
        let fresh = null;
        try { fresh = await Seedr.fetchFileUrl(cv.fileId); } catch (_) {}
        if (!fresh || !ownsSource() || cv._hasPlayed) return;
        const probe = await _probeSeedrStream(fresh);
        if (!ownsSource() || cv._hasPlayed) return;
        if (probe === false) {
          if (cv._queueItem) {
            cv._queueItem._seedrUnavailable = true;
            _downloadMagnetToLaptop(cv._queueItem);
          }
          return;
        }
        if (cv._queueItem) return;
        const absPos = v.currentTime || 0;
        const rmx = await _maybeRemux(fresh, 'seedr', fresh, absPos, undefined, true);
        if (!ownsSource() || cv._hasPlayed || !rmx.sess) {
          if (rmx.sess && typeof Remux !== 'undefined') Remux.close();
          return;
        }
        cv.src = rmx.url;
        cv._remux = rmx.sess;
        cv._pendingResume = null;
        Remux.bindVideo(v);
        setVideoSource(v, rmx.url);
        _syncWatchdog(v, cv.isAudio);
        v.play().catch(() => {});
      }, 5000);
    }
    // Chapter markers and format badges are OPTIONAL and must never compete
    // with the first frame. Inspect them once playback has actually started.
    // A direct Seedr stream uses the selected laptop engine (with its auth
    // token); legacy phone endpoints remain a fallback for a genuine phone
    // host rather than being fired blindly at the laptop and returning 404.
    if (!isLive && !isAudio && _PLAYER_HTTPS_RE.test(src)) {
      const inspectCv = currentVideo, inspectGen = currentVideo._sourceGen;
      const ownsSource = () => currentVideo === inspectCv && inspectCv._sourceGen === inspectGen;
      let inspected = false;
      const inspectAfterPlaying = () => {
        if (inspected) return;
        inspected = true;
        if (!ownsSource()) return;
        // Seedr links are never probed (see inspectLaptopMedia); the laptop copy
        // is inspected when playback moves onto it.
        if (inspectCv._directSeedr || /seedr\.cc/i.test(src)) return;
        const engineInspect = typeof Remux !== 'undefined'
          && typeof Remux.inspectMedia === 'function'
          && Remux.engine() === 'laptop'
          && Remux.availableFor('laptop');
        if (engineInspect) {
          Remux.inspectMedia(src).then(info => {
            if (!info || !ownsSource()) return;
            if (Array.isArray(info.chapters)) currentVideo._chapters = info.chapters;
            currentVideo._mediaInfo = { video: info.video || null, audio: info.audio || [] };
            renderMediaInfo(currentVideo._mediaInfo);
          }).catch(() => {});
          return;
        }
        if (typeof Phone === 'undefined' || !Phone.hasHost()) return;
        Phone.chapters({ url: src }).then(ch => {
          if (ownsSource() && Array.isArray(ch)) {
            currentVideo._chapters = ch;
          }
        }).catch(() => {});
        Phone.mediaInfo({ url: src }).then(info => {
          if (info && ownsSource()) {
            currentVideo._mediaInfo = info;
            renderMediaInfo(info);
          }
        }).catch(() => {});
      };
      const cleanup = () => {
        v.removeEventListener('playing', onFirstPlaying);
        clearTimeout(firstPlayingTimer);
        if (v._firstPlayingCleanup === cleanup) v._firstPlayingCleanup = null;
      };
      let firstPlayingTimer = null;
      const onFirstPlaying = () => {
        if (v._firstPlayingCleanup !== cleanup) return;
        cleanup();
        inspectAfterPlaying();
      };
      v._firstPlayingCleanup = cleanup;
      v.addEventListener('playing', onFirstPlaying);
      // A very fast cached source can reach playing during synchronous player
      // setup. Do not miss it, but still defer work off this startup stack.
      if (!v.paused && v.readyState >= 2) firstPlayingTimer = setTimeout(onFirstPlaying, 0);
    }
    // Crowd-sourced intro / recap / credits marks from IntroDB — TheIntroDB
    // (keyless) with a SkipDB fallback. This is the SponsorBlock-for-TV data:
    // it gives a PRECISE "Skip Intro" / "Skip Recap" / "Skip Credits" mark even
    // when the container ships no chapters and the subtitle-gap heuristic would
    // only be guessing. TV episodes only: it needs an IMDb id + season +
    // episode. When the show context didn't carry an id (Library / cache files
    // whose show was parsed from a filename) we resolve it once via TVMaze.
    if (!isLive && !isAudio && typeof IntroDB !== 'undefined'
        && show && show.season && show.episode) {
      const myFileId = fileId;
      const sNo = show.season, eNo = show.episode;
      (async () => {
        let imdb = show.imdbId || null;
        if (!imdb && show.title && typeof TVMaze !== 'undefined') {
          try {
            const sm = await TVMaze.seasonMap(show.title, show.year);
            imdb = (sm && sm.show && sm.show.imdb_id) || null;
            if (imdb && currentVideo && currentVideo.show) currentVideo.show.imdbId = imdb;
          } catch (_) {}
        }
        if (!imdb) return;
        const seg = await IntroDB.segments(imdb, sNo, eNo);
        if (seg && currentVideo && currentVideo.fileId === myFileId) {
          currentVideo._dbSegments = seg;
          // Reconcile the crowd marks against the file's chapters/subtitles now
          // that the DB has landed (subs may have loaded before this fetch).
          try { refreshSkipMarks(); } catch (_) {}
        }
      })();
    }
    // A sibling sub found in the file's folder is now just a CANDIDATE — it
    // is NOT auto-shown here. R1: nothing auto-shows until it's either a
    // laptop-baked/embedded entry (LaptopCache branch below) or an oracle
    // measurement comes back reliable (non-LaptopCache tail below). The manual
    // Sync HUD / subtitle-menu picker (untouched, further down this file)
    // remains the one path that can show anything unverified.
    // OpenSubs is now strictly a post-load fallback. If the user passed a
    // sibling sub OR the MKV ships an embedded English track, we never
    // hit the OpenSubs API. Otherwise we wait briefly for embedded tracks
    // to surface (in-band tracks arrive after the demuxer warms up) and
    // only THEN search OpenSubs.
    const subtitleVideo = currentVideo;
    let subtitleRun = 0;
    const prepareSubtitles = async () => {
      const run = ++subtitleRun;
      const alive = () => currentVideo === subtitleVideo && run === subtitleRun && !subtitleVideo._subHidden;
      // Resolve a Promise-shaped meta.subtitle here — the ONE place it's
      // read — so a still-in-flight Seedr sibling-subtitle walk never delays
      // v.play() above; preparation runs fully after playback starts.
      let subtitle = (subtitleMeta && typeof subtitleMeta.then === 'function')
        ? await subtitleMeta.catch(() => null) : subtitleMeta;
      if (!alive()) return;
      // Normal sidecars carry only an id/name. Load the decoded text before
      // cue validation, attaching, or submission to the persistent sync store.
      if (subtitle && !subtitle._content) {
        try {
          const subtitleId = subtitle.fileId || subtitle.id;
          subtitle = { ...subtitle, fileId: subtitleId, _content: await storeFor(subtitleId).fetchText(subtitleId) };
        } catch (_) { subtitle = null; }
        if (!alive()) return;
      }
      // A sibling sub with almost no cues is an ad stub (YTS ships an .srt
      // holding four "YTS.MX" plugs) or a forced-only track — either way it
      // must NOT count as "we have subtitles", or the real finder never runs
      // and the movie plays essentially subtitle-less.
      let subIsFlimsy = false;
      if (subtitle && subtitle._content) {
        try { subIsFlimsy = parseSrtCues(subtitle._content).length < 40; } catch (_) {}
      }
      const hasRealSibling = subtitle && subtitle._content && !subIsFlimsy;
      if (isLive) return;           // live channels don't need subs
      if (isAudio) return;          // music tracks: no subs lookup
      // Stale-player guard: user may open a different video while an async
      // lookup is in flight; only attach to the SAME currentVideo.
      const myFileId = subtitleVideo.fileId;

      // Handoffs mutate this playback object; currentSrc may still describe
      // the old resource while source selection is pending. Use its owned URL.
      const streamUrl = subtitleVideo.src || src || '';
      const metadataOnly = !!(subtitleVideo._directSeedr || subtitleVideo._growingCache);
      const finderOpts = { metadataOnly, duration: playbackResumeClock(subtitleVideo, v).duration };
      const filenameForSub = meta.subFilename || title || (fileId || '');
      const canPhone = typeof Phone !== 'undefined' && Phone.hasHost()
                       && streamUrl && _PLAYER_HTTPS_RE.test(streamUrl);
      // The selected laptop engine can sync a direct Seedr/Drive URL too; it
      // does not need an HLS remux session to decode that source. This matters
      // when phoneHost is the laptop itself: Phone.subsync() carries no engine
      // token and was returning 401, while Remux.subsync() already attaches
      // the correct X-Playback-Token for the same server.
      const canDirectEngineSubsync = typeof Remux !== 'undefined'
        && typeof Remux.subsync === 'function'
        && Remux.engine && Remux.engine() === 'laptop'
        && Remux.availableFor && Remux.availableFor('laptop')
        && streamUrl && _PLAYER_HTTPS_RE.test(streamUrl);
      // Audio-sync can run on whichever engine is actually decoding this
      // playback: an active remux session's engine (TV/laptop) decodes the
      // source itself, OR the phone for direct-play sources. So subsync is
      // possible when a remux session is active (any engine) OR the phone is set.
      const canSubsync = !metadataOnly && ((typeof Remux !== 'undefined' && Remux.hasSession()
                          && typeof Remux.subsync === 'function')
                          || canDirectEngineSubsync || canPhone);

      // The phone can demux the file's OWN subtitle track only when it has the
      // actual file on disk — i.e. a pen download or a cached file it serves
      // from /files/stream/ or /cache/stream/. A seedr (or Drive) stream is
      // remote: ffmpeg would have to pull the whole MKV over HTTP, which is
      // slow and flaky — so for streaming we rely on the external finder.
      let isPhoneLocalFile = false;
      if (canPhone) {
        const pb = Phone.base();
        isPhoneLocalFile = streamUrl.indexOf(pb + '/files/stream/') === 0
                        || streamUrl.indexOf(pb + '/cache/stream/') === 0;
      }

      // R1/R2/R3/R5: a LaptopCache (laptop-cached) item is fully driven by the
      // server's persistent, content-fingerprinted bake/verify store — every
      // (media, sub) pair there is measured AT MOST ONCE, ever, and reused
      // forever (including on resume — it re-funnels through here at offset
      // 0, instantly). Everything else (seedr/Drive/phone) falls through to
      // the live-oracle tail below, unchanged except for its new R1 gating.
      // A Seedr item may be SERVED from a completed laptop-cache hit while
      // retaining its original Seedr fileId for Continue-Watching identity.
      // Playback identity and subtitle-store identity are separate: cacheRel
      // owns the persistent manifest without forking the resume key.
      const laptopSubFileId = (typeof LaptopCache !== 'undefined'
        && currentVideo && currentVideo._cacheRel)
        ? (LaptopCache.PFX + currentVideo._cacheRel) : myFileId;
      const isLaptopCache = typeof LaptopCache !== 'undefined'
        && LaptopCache.isCacheId(laptopSubFileId);
      if (isLaptopCache && !metadataOnly) {
        let lastShownFp = null, lastShownOffset = null;
        // Fetch + attach one manifest entry (baked-ready or presumed-synced
        // embedded). Never shows anything for a fileId/hide-state that has
        // since moved on.
        const showLaptopEntry = async (entry, announceBuiltin) => {
          if (!alive() || !entry || !entry.fp) return false;
          let text;
          try { text = await LaptopCache.fetchSubs(laptopSubFileId, entry.fp); } catch (_) { return false; }
          if (!alive()) return false;
          attachSubtitle(v, {
            name: `laptop:${entry.fp}.srt`, _content: text, _autoOffset: 0, _scale: 1,
            _exact: entry.state === 'ready', _bakedFp: entry.fp,
          });
          ccEl.dataset.state = 'on';
          if (announceBuiltin && entry.source === 'embedded' && entry.state === 'embedded_pending') {
            try { pToast('Using the show’s built-in subtitles'); } catch (_) {}
          }
          lastShownFp = entry.fp; lastShownOffset = entry.offset || 0;
          return true;
        };
        // Shared external-subtitle fetch+submit fallback (R4) — the sibling
        // / OpenSubtitles finder, submitted to the laptop for sync. Two call
        // sites need this: startSync's SYNCHRONOUS reply already 'none' (no
        // embedded track at all, fast path, below) and a background
        // embedded-probe job that was 'syncing' resolving to 'none' LATER
        // (the poll callback's 'none' branch in `watch`, right below) —
        // both mean the same thing ("no embedded track"), so both must run
        // the same fallback instead of only the synchronous path doing it.
        const tryExternalFallback = async () => {
          if (!alive()) return;
          let candidate = hasRealSibling ? subtitle : null;
          if (!candidate) candidate = await resolveBestSubtitle(streamUrl, filenameForSub, show, finderOpts);
          if (!alive() || !candidate || !candidate._content) return;   // no candidate at all — leave hidden, CC 'off'
          // Never leave a first-time playback subtitle-less while the laptop
          // spends minutes measuring/baking the provider candidate.  This is
          // the same best-match behavior used by non-cache playback: show the
          // candidate immediately, then let the persistent watcher replace it
          // with the verified copy as soon as background sync lands.
          attachSubtitle(v, candidate);
          ccEl.dataset.state = 'on';
          try { pToast('Subtitles: best match'); } catch (_) {}
          let r2;
          try {
            r2 = await LaptopCache.startSync(laptopSubFileId, { srt: candidate._content, name: candidate.name });
          } catch (_) {
            return;   // best match remains visible; persistence can retry later
          }
          if (!alive()) return;
          if (r2.state === 'ready' || r2.state === 'embedded_pending') {
            await showLaptopEntry(r2, true);
            watch(r2.fp);
          } else if (r2.state === 'syncing') {
            ccEl.dataset.state = 'pending';
            try { pToast('Syncing subtitles…'); } catch (_) {}
            watch(r2.fp);
          }
          // else: server declined to start — leave hidden, CC 'off'.
        };
        // Background watcher for a state/version upgrade: hot-applies a
        // syncing→ready landing (attach + toast) and an embedded_pending's
        // in-place lazy-verify retime (silent refetch, toast only when the
        // offset actually moved), drops the CC icon back to 'off' on an
        // eventual 'failed' (R1 — never leave the 'pending' spinner lying),
        // and on 'none' — the embedded probe resolved NEGATIVELY after this
        // playback was already watching its 'syncing' job — stops this poll
        // and runs the same external fallback the synchronous 'none' path
        // below runs, so the CC icon doesn't stay wedged on 'pending' and
        // OpenSubs fallback still fires.
        const watch = (fp) => {
          const handle = pollLaptopSubState(laptopSubFileId, fp, async (upd) => {
            if (!alive()) return;
            if (upd.state === 'ready') {
              const changed = lastShownFp !== upd.fp
                || Math.abs((upd.offset || 0) - (lastShownOffset || 0)) > 0.01;
              const ok = await showLaptopEntry(upd, false);
              if (ok && changed) { try { pToast('Subtitles synced'); } catch (_) {} }
            } else if (upd.state === 'embedded_pending') {
              await showLaptopEntry(upd, true);
            } else if (upd.state === 'syncing') {
              ccEl.dataset.state = 'pending';
              try { pToast('Syncing subtitles…'); } catch (_) {}
            } else if (upd.state === 'failed' && ccEl.dataset.state === 'pending') {
              ccEl.dataset.state = 'off';
            } else if (upd.state === 'none') {
              handle.stop();
              await tryExternalFallback();
            }
          }, { playback: subtitleVideo, isAlive: alive });
          return handle;
        };

        await (async () => {
          const st = await LaptopCache.subsState(laptopSubFileId);
          if (!alive()) return;
          if (st.state === 'ready' || st.state === 'embedded_pending') {
            await showLaptopEntry(st, true);
            watch(st.fp);
            return;
          }
          if (st.state === 'syncing') {
            ccEl.dataset.state = 'pending';
            try { pToast('Syncing subtitles…'); } catch (_) {}
            watch(st.fp);
            return;
          }
          // 'none' or 'failed' — try embedded extraction first (R3).
          const r = await LaptopCache.startSync(laptopSubFileId, {});
          if (!alive()) return;
          if (r.state === 'ready' || r.state === 'embedded_pending') {
            await showLaptopEntry(r, true);
            watch(r.fp);
            return;
          }
          // The common case on a fresh rel: the server fired the background
          // embedded-probe thread and returned immediately — not a failure.
          // Watch it just like every other 'syncing' branch in this function.
          if (r.state === 'syncing') {
            ccEl.dataset.state = 'pending';
            try { pToast('Syncing subtitles…'); } catch (_) {}
            watch(r.fp);
            return;
          }
          if (r.state !== 'none') return;   // startSync itself failed — nothing more to try
          // No embedded track (or already checked negative) — fall back to
          // the sibling / OpenSubtitles finder and submit it for sync (R4).
          await tryExternalFallback();
        })();
        return;
      }

      // A real sibling sub is held as a CANDIDATE only — it is NOT auto-shown
      // here (R1). It still falls through into the same TIER1-3 oracle-
      // verification flow below (the PRIMARY block skips the redundant
      // OpenSubs lookup and uses this sibling as `got` directly) so it gets
      // submitted to whatever oracle is reachable instead of being silently
      // discarded (R4/R6).

      // BACKGROUND BONUS — the file's OWN embedded subtitle track, but ONLY for
      // a DOWNLOADED TV EPISODE (apibay show MKVs usually carry a proper in-band
      // English track; webOS's <video> never exposes in-band tracks to JS, so
      // the phone demuxes it with ffmpeg — perfectly synced since it comes from
      // the file). Movies and streaming skip this and rely on the external
      // finder below. The demux reads the whole local file (~15-30s for an
      // episode, cached after), so it runs in the background and swaps in only
      // if the external match below wasn't already frame-exact.
      const isEpisode = !!show || _PLAYER_EPISODE_RE.test(filenameForSub);
      let haveExact = false, embeddedWon = false;
      if (isEpisode && isPhoneLocalFile && !metadataOnly) {
        Phone.embeddedSubs({ url: streamUrl }).then(res => {
          if (!res || !res.found || !res.srt || res.forced) return;
          if (!alive()) return;
          if (currentVideo._subHidden) return;   // user turned subtitles OFF — don't re-attach
          // The embedded track comes FROM this file, so it is the true frame-
          // exact sub — it wins even over an OpenSubs "exact" moviehash match,
          // because those can be mislabeled uploads from a different cut.
          // Prefer the embedded timing over an external match's exact flag.
          embeddedWon = true;
          // Phone always delivers SRT text (ffmpeg -c:s srt) whatever the
          // source codec — name it .srt so an embedded ASS source doesn't trip
          // attachSubtitle's ASS-skip guard.
          attachSubtitle(v, {
            name: 'embedded.srt', _content: res.srt,
            _autoOffset: 0, _scale: 1, _exact: true, _embedded: true,
          });
          ccEl.dataset.state = 'on';
          try { pToast('Using the show’s built-in subtitles'); } catch (_) {}
        }).catch(() => {});
      }

      // PRIMARY — external subtitle matched to THIS release's filename:
      // exact moviehash (frame-accurate) → best release-name match → auto-sync.
      // Shown ASAP so subs appear within ~1-2s. Retry once on a transient miss
      // (OpenSubtitles is flaky on the first uncached lookup). Skipped when a
      // real sibling sub was already supplied with the file (R4) — that
      // sibling IS the candidate; it still has to clear the same oracle gate
      // below (R1) rather than re-paying a redundant OpenSubs TIER1/TIER2 hit.
      let got = hasRealSibling ? subtitle : await resolveBestSubtitle(streamUrl, filenameForSub, show, finderOpts);
      if (!got && !hasRealSibling && alive()) {
        await new Promise(r => setTimeout(r, 4000));
        if (alive()) {
          got = await resolveBestSubtitle(streamUrl, filenameForSub, show, finderOpts);
        }
      }
      if (!got) return;
      if (got._exact) haveExact = true;   // frame-accurate — keep it over embedded
      if (!alive()) return;
      if (embeddedWon) return;            // embedded already swapped in — it wins
      if (currentVideo._subHidden) return;   // user turned subtitles OFF — don't re-attach
      // Exact and reference-aligned matches already have verified timing.
      if (got._exact || got._syncedBy === 'reference') {
        attachSubtitle(v, got);
        ccEl.dataset.state = 'on';
      }

      // Re-apply a PREVIOUSLY MEASURED, confident TIER3 offset for this exact
      // fileId+sub before doing any new work. Fixes the "offset resets to 0"
      // bug: the measured offset used to live only on the transient `got`
      // object inside this one IIFE run, so it evaporated on every reload /
      // re-open of the same title (app restart, resume from a fresh session,
      // a decode-error resync). This also short-circuits the TIER3 gate right
      // below (it checks `!got._syncedBy`), so a confidently-synced title
      // never re-pays the audio-decode cost on a later replay. A persisted
      // entry is itself a PRIOR reliable oracle measurement, so showing it
      // now satisfies R1 exactly like a fresh reliable TIER3 result does.
      const _persisted = loadPersistedSubOffset(myFileId, got.name);
      if (_persisted != null && !got._exact && !got._syncedBy) {
        got._autoOffset = _persisted.offset; got._syncedBy = 'audio';
        if (_persisted.scale && _persisted.scale !== 1) got._scale = _persisted.scale;
        attachSubtitle(v, got);
        ccEl.dataset.state = 'on';
      }

      // With no reachable sync engine or persisted measurement, show the best
      // external subtitle match immediately. A fresh Seedr stream may not yet
      // have a cache ID, so waiting for the cache subtitle store would leave
      // playback without subtitles indefinitely. Later playback of a completed
      // cache copy can use the verified/baked subtitle store automatically.
      if (!canSubsync && !got._exact && !got._syncedBy) {
        attachSubtitle(v, got);
        ccEl.dataset.state = 'on';
        try { pToast('Subtitles: best match'); } catch (_) {}
        return;
      }

      // TIER 3 — literal sync-to-audio for a finder sub that is neither an
      // exact moviehash match nor reference-aligned: whichever oracle is
      // decoding this playback (the active TV/laptop remux engine, or the
      // phone for a direct-play source — see canSubsync/_engineSync below)
      // measures the true offset and snaps the (already-showing) sub into
      // sync. Skipped if embedded wins (already synced), and skipped when a
      // persisted measurement from a prior playback of this same file+sub
      // already applied above.
      if (!got._exact && !got._syncedBy && canSubsync) {
        // In remux mode `streamUrl` is the localhost/LAN remux route
        // (127.0.0.1:9891 on the TV) — the phone can't reach it, so subsync
        // would silently fail and the sub would keep its raw (mismatched-
        // release) timing. Point the phone at the ORIGINAL source instead
        // (the signed seedr/Drive https URL it CAN decode). Non-remux
        // playback and phone-local sources fall through to streamUrl.
        const _rmxSess = (currentVideo && currentVideo._remux) || null;
        const _rmxSrc = (_rmxSess && _rmxSess.sourceReference) || '';
        // The phone must decode the ORIGINAL source, not the localhost remux URL.
        // For seedr/Drive that's already an https URL; for a phone/usb source the
        // sourceReference is a bare relative PATH, so reconstruct its fetchable
        // phone stream URL (the phone can serve + decode its own file).
        let syncUrl = streamUrl;
        // Analyze the REAL source (seedr https OR a LAN cache stream URL), not
        // the rolling HLS playlist — the playlist only holds a few live
        // segments, so the recognizer can't seek to the dialogue window and
        // returns garbage. Any http(s) source the engine can decode qualifies.
        if (_rmxSrc && /^https?:/i.test(_rmxSrc)) syncUrl = _rmxSrc;
        else if (_rmxSess && (_rmxSess.sourceType === 'phone' || _rmxSess.sourceType === 'usb') && _rmxSrc
                 && typeof Phone !== 'undefined') syncUrl = Phone.streamUrl(_rmxSrc);
        // Route to the engine that's decoding THIS playback: an active remux
        // session's engine (so a laptop session syncs on the laptop, not the
        // phone), else the phone for direct-play sources.
        const _engineSync = ((currentVideo && currentVideo._remux) || canDirectEngineSubsync)
                         && typeof Remux !== 'undefined'
                         && typeof Remux.subsync === 'function';
        const r = await (_engineSync ? Remux.subsync(syncUrl, got._content, 900)
                                  : Phone.subsync(syncUrl, got._content, 900)).catch(() => null);
        // Oracle CONFIGURED but didn't answer (phone asleep, engine busy):
        // same reality as no oracle at all — holding the sub forever serves
        // nobody. Show the best match unsynced rather than nothing; a later
        // reliable measurement still retunes it.
        if (!r || !r.ok) {
          if (!alive()) return;
          if (embeddedWon || currentVideo._subHidden) return;
          attachSubtitle(v, got);
          ccEl.dataset.state = 'on';
          try { pToast('Subtitles: best match'); } catch (_) {}
          return;
        }
        if (!alive()) return;
        if (embeddedWon) return;    // embedded arrived while we measured
        if (currentVideo._subHidden) return;   // user turned subtitles OFF — don't re-attach
        // R1: not confident enough to show AT ALL — held, CC stays 'off'.
        // (Manual menu can still surface a different pick.)
        if (!r.reliable) return;
        // A meaningful CORRECTION is either a real constant offset OR a real
        // SCALE (linear drift from a framerate mismatch — subsync.py's
        // multi-sample fit reports offset as the value AT t=0, so a file
        // that's drifting can have a tiny t=0 offset yet still need a scale
        // correction; gating on offset alone would miss it). ~0.05%/min of
        // drift accumulates to >1s over a 45min episode, well above any
        // measurement noise from the per-window alignment. Either way the
        // measurement itself is now reliable, so the sub shows; a
        // negligible correction just isn't worth persisting or announcing.
        const _scaleDelta = Math.abs((r.scale || 1) - 1);
        if (Math.abs(r.offset || 0) > 1.0 || _scaleDelta > 0.0008) {
          got._autoOffset = r.offset; got._syncedBy = 'audio';
          if (r.scale && r.scale !== 1) got._scale = r.scale;
          attachSubtitle(v, got);
          ccEl.dataset.state = 'on';
          // Persist (offset + scale) so this exact fileId+sub reliably
          // re-applies on the next reload/replay instead of resetting to 0
          // and re-measuring cold.
          savePersistedSubOffset(myFileId, got.name, r.offset, r.scale);
          try { pToast(`Synced to audio ${r.offset >= 0 ? '+' : ''}${r.offset.toFixed(1)}s`); } catch (_) {}
        } else {
          attachSubtitle(v, got);
          ccEl.dataset.state = 'on';
        }
      }
    };
    prepareSubtitles();
    // Upgrade once the same playback owns the completed local file. A run
    // token cancels older discovery/alignment without confusing a new title.
    if (subtitleVideo._directSeedr || subtitleVideo._growingCache) {
      const waitForLocalSubtitleSource = () => {
        if (currentVideo !== subtitleVideo || subtitleVideo._subHidden) return;
        if (!subtitleVideo._directSeedr && !subtitleVideo._growingCache
            && !subtitleVideo._localHandoffPending) {
          prepareSubtitles();
          return;
        }
        setTimeout(waitForLocalSubtitleSource, 2500);
      };
      setTimeout(waitForLocalSubtitleSource, 2500);
    }
    // Track lists are recreated when src changes, so wire listeners against
    // the *current* lists and stash both the function refs AND the list refs
    // — closePlayer needs to call removeEventListener on the same list
    // object we added to (webOS swaps the list on subsequent v.src writes,
    // so v.textTracks at close time is a different object).
    currentVideo._trackHandlers = null;
    currentVideo._textTracksList = null;
    currentVideo._audioTracksList = null;
    if (v.textTracks && typeof v.textTracks.addEventListener === 'function') {
      const onTextTrack = () => chooseBestTrack(v);
      const onAudioTrack = () => {
        // Auto-select English when a multi-track video lands. Runs on every
        // addtrack because webOS sometimes streams the audio track list in
        // — first track arrives, then second a moment later.
        chooseBestAudioTrack(v);
        if (activeMenu === 'audio') buildMenu('audio');
      };
      v.textTracks.addEventListener('addtrack', onTextTrack);
      currentVideo._textTracksList = v.textTracks;
      if (v.audioTracks && typeof v.audioTracks.addEventListener === 'function') {
        v.audioTracks.addEventListener('addtrack', onAudioTrack);
        currentVideo._audioTracksList = v.audioTracks;
      }
      currentVideo._trackHandlers = { onTextTrack, onAudioTrack };
    }
    // Only push a back-handler the first time the player opens. Music
    // auto-advance calls openPlayer() again while the player is already open
    // (is-open stays set between tracks). Without this guard each track
    // advance stacks an extra closePlayer on _backStack, requiring N Back
    // presses to fully unwind after an N-track session.
    if (!playerWasOpen) {
      DPad.pushBackHandler(closePlayer);
    }
    setTimeout(() => DPad.focus($('#p-play')), 60);
  }

  function persistCurrentResume() {
    if (!currentVideo || !currentVideo.fileId) return;
    if (currentVideo.isLive) return;
    if (currentVideo.isAudio) return;   // music tracks: too short to resume
    const v = $('#video');
    const clock = playbackResumeClock(currentVideo, v);
    // In remux mode v.duration is only the rolling HLS window (and can be
    // Infinity), so gate on the true runtime from Remux instead — otherwise we
    // silently never persist a resume point for remux playback.
    if (!clock.duration || !Number.isFinite(clock.duration)) return;
    // The key/source we persist under can differ from the live stream
    // identity: while still streaming a seedr URL whose local cache copy has
    // landed, we re-point the resume entry at the local fileId (so Continue
    // works after the seedr copy is deleted) WITHOUT touching
    // currentVideo.fileId/source (the stream + seedr-drop recovery still need
    // the seedr id). _resumeFileId / _resumeSource carry that override.
    const rid = currentVideo._resumeFileId || currentVideo.fileId;
    const rsrc = currentVideo._resumeSource || currentVideo.source;
    const resumeInfo = {
      // Resume position/duration must be in ABSOLUTE movie time — in remux
      // mode v.currentTime is relative to the current HLS generation.
      position: clock.position,
      duration: clock.duration,
      title: currentVideo.title,
      fileId: rid,
      source: rsrc,
      poster: currentVideo.poster || null,
      show: currentVideo.show || null,
    };
    // Torrent identity for the seedr-loss fallback: if this file dies on
    // seedr before a pen copy lands, the magnet lets the phone silently
    // re-download the whole torrent. (Conditional so a later playback
    // without queue context doesn't blank out a stored magnet.)
    const qi = currentVideo._queueItem;
    if (qi && qi.magnet) resumeInfo.magnet = qi.magnet;
    if (qi && qi.infoHash) resumeInfo.infoHash = qi.infoHash;
    Storage.setResume(rid, resumeInfo);
    // Crash-recovery breadcrumb: enough to re-open THIS exact playback after a
    // webOS OOM-kill. openPlayer resolves the resume position from the fileId's
    // resume entry (saved just above), so we only need the resolved stream URL +
    // reopen meta here. Cleared on a clean close / end so a normal exit doesn't
    // auto-relaunch a movie. Skipped for live (no resume) and audio.
    try {
      if (!currentVideo.isLive && !currentVideo.isAudio) {
        localStorage.setItem('dumiflix.lastPlaying', JSON.stringify({
          src: currentVideo.src || v.currentSrc || '',
          title: currentVideo.title || '',
          fileId: currentVideo.fileId, source: currentVideo.source,
          poster: currentVideo.poster || null, show: currentVideo.show || null,
          subFilename: currentVideo.subFilename || '',
          codec: currentVideo.codec || '', profile: currentVideo.profile || '',
          // ABSOLUTE movie position (v.currentTime is window-relative in remux
          // mode). crash-recovery re-routes through resumeItem(), which starts
          // a FRESH remux at this position -- so it must not be window-relative.
          position: clock.position,
          ts: Date.now(),
        }));
      }
    } catch (_) {}
    // Mirror pen-file positions to the phone: half-watched files dodge
    // auto-eviction for 3 days, and KeepWatching copies expire 3 days after
    // the LAST watch (not the download). Fire-and-forget.
    if (typeof Phone !== 'undefined' && Phone.hasHost()
        && _PLAYER_PHONEKEY_RE.test(String(currentVideo.fileId))) {
      Phone.postWatchState({
        key: currentVideo.fileId,
        rel: String(currentVideo.fileId).slice(6),
        title: currentVideo.title || '',
        position: clock.position,
        duration: clock.duration,
        ts: Date.now(),
      });
    }
  }

  function restoreBrowsingFocus(playerEl) {
    const previous = playerEl._browseFocus;
    playerEl._browseFocus = null;
    try {
      const visible = el => {
        if (!el || el.isConnected === false || el.disabled || el.closest('#player, [hidden]')) return false;
        const tab = el.closest('.tab');
        if (tab && !tab.classList.contains('is-active')) return false;
        const modal = el.closest('.modal');
        if (modal && !modal.classList.contains('is-open')) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const candidates = [previous].concat(Array.from(document.querySelectorAll(
        '.modal.is-open button, .tab.is-active button, .tab.is-active input, .tab.is-active [tabindex], .nav-item.is-active'
      )));
      const target = candidates.find(visible);
      if (target) {
        DPad.focus(target);
        try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }
      }
    } catch (_) {}
  }

  function closePlayer() {
    const v = $('#video');
    if (v._firstPlayingCleanup) v._firstPlayingCleanup();
    const playerEl = $('#player');
    const wasAudio = currentVideo && currentVideo.isAudio;
    if (currentVideo && currentVideo._seedrStartTimer) {
      clearTimeout(currentVideo._seedrStartTimer);
      currentVideo._seedrStartTimer = 0;
    }
    persistCurrentResume();
    cancelGrowingHandoff(currentVideo);
    // Detach MSE BEFORE anything else touches the element. A live MediaSource
    // left attached keeps its fetch pump and SourceBuffer alive against a
    // <video> we are tearing down -- and this panel permits exactly one
    // activated media player, so a leak here blocks the NEXT playback, not
    // this one, which is a miserable thing to debug.
    // Clean, user-initiated exit — drop the crash-recovery breadcrumb so we
    // don't auto-relaunch a movie the user deliberately left.
    try { localStorage.removeItem('dumiflix.lastPlaying'); } catch (_) {}
    const rk = currentVideo && (currentVideo._resumeFileId || currentVideo.fileId);
    // Remux-aware: v.duration/v.currentTime are the rolling WINDOW under remux,
    // so the raw check would read almost every mid-movie close as "near the end"
    // and wrongly wipe the resume. Use the true movie duration + absolute time.
    const closeClock = currentVideo ? playbackResumeClock(currentVideo, v) : { position: 0, duration: 0 };
    const _durClose = closeClock.duration;
    const _curClose = closeClock.position;
    if (rk && _durClose && (_durClose - _curClose) < 60) {
      Storage.clearResume(rk);
    }
    // Deferred seedr cleanup: while the user streamed this item's seedr URL,
    // its local copy finished and we kept the seedr folder alive so the stream
    // wouldn't break (see copyToGdrive drive-ready). Playback is ending now —
    // free the slot for the next download.
    let releaseOnClose = null;
    if (currentVideo && currentVideo._queueItem
        && currentVideo._queueItem._deferSeedrRelease) {
      const qi = currentVideo._queueItem;
      qi._deferSeedrRelease = false;
      releaseOnClose = qi;
    }
    // (Fallback) If the player was streaming a seedr URL whose upload has since
    // finished but the resume wasn't already re-keyed to the local copy, do it
    // now — with the right source — so a future resume click finds the file
    // after the seedr copy is deleted.
    if (currentVideo && currentVideo.source === 'seedr' && currentVideo._queueItem) {
      const cached = cachedSeedrFile(currentVideo._queueItem, currentVideo.fileId);
      const driveId = cached && cached.fileId;
      if (driveId && rk && rk !== driveId) {
        const _be = storeFor(driveId);
        const s = (typeof LaptopCache !== 'undefined' && _be === LaptopCache) ? 'laptop'
          : (_be === PhoneCache) ? 'cache' : 'drive';
        try { Storage.migrateResume(rk, driveId, { source: s }); } catch (_) {}
      }
    }
    if (currentVideo && currentVideo._trackHandlers) {
      const { onTextTrack, onAudioTrack } = currentVideo._trackHandlers;
      const tt = currentVideo._textTracksList || v.textTracks;
      const at = currentVideo._audioTracksList || v.audioTracks;
      try { tt && tt.removeEventListener('addtrack', onTextTrack); } catch (_) {}
      try { at && at.removeEventListener('addtrack', onAudioTrack); } catch (_) {}
    }
    clearSubOverlay();
    // Tear down any remux session (DELETE on the engine -> kills ffmpeg +
    // removes temp; clears the module's polling/timers/guards). No-op if none.
    if (typeof Remux !== 'undefined') {
      Remux.close();
      Remux.bindVideo(null);
    }
    if (_musicAdvanceTimer) {
      clearInterval(_musicAdvanceTimer);
      _musicAdvanceTimer = 0;
    }
    // Hand the decoder back. Single-decoder webOS targets run
    // --max-activated-media-players=1, so a <video> still holding a stream
    // blocks the NEXT playback from getting a decoder at all.
    try { NativePlayer.stopWatchdog(); } catch (_) {}
    NativePlayer.release(v);
    cancelUpNext();
    $('#p-skip').hidden = true;
    closeMenu();
    playerEl.classList.remove('is-open');
    document.body.classList.remove('has-player');   // re-show the home/tab DOM
    playerEl.classList.remove('is-live');
    playerEl.classList.remove('is-audio');
    // Tear down the subtitle-sync HUD if it was open for this playback.
    _syncMode = false;
    { const hud = document.getElementById('p-sync'); if (hud) hud.hidden = true; }
    currentVideo = null;
    if (releaseOnClose) releaseSeedr(releaseOnClose);
    if (wasAudio) MusicRemote.publishCurrent();
    DPad.popBackHandler();
    restoreBrowsingFocus(playerEl);
  }

  function showOverlay() {
    $('#player-overlay').classList.add('is-shown');
    clearTimeout(showOverlay._t);
    showOverlay._t = setTimeout(() => {
      // Don't auto-hide the overlay while a menu is open or the up-next
      // prompt is showing — those need the user to deliberately dismiss them.
      if (activeMenu || !$('#p-upnext').hidden) return;
      $('#player-overlay').classList.remove('is-shown');
    }, 4500);
  }

  // ---------- Subtitle-timing HUD ----------
  // A compact on-screen sync control. Unlike the full-screen track menu (which
  // blacks out the video, so the user couldn't see their timing nudges land),
  // this leaves the video + subtitles fully visible so each ◄/► nudge is
  // immediately visible on the subs.
  let _syncMode = false;
  function updateSyncVal() {
    const off = (currentVideo && currentVideo._manualOffset) || 0;
    const el = document.getElementById('p-sync-val');
    if (el) el.textContent = `${off >= 0 ? '+' : ''}${off.toFixed(1)}s`;
  }
  function openSyncHud() {
    const hud = document.getElementById('p-sync');
    if (!hud) return;
    _syncMode = true;
    updateSyncVal();
    hud.hidden = false;
    setTimeout(() => { const b = document.getElementById('p-sync-minus'); if (b) { try { DPad.focus(b); } catch (_) {} } }, 30);
  }
  function closeSyncHud() {
    const hud = document.getElementById('p-sync');
    if (hud) hud.hidden = true;
    _syncMode = false;
    showOverlay();
    const cc = document.getElementById('p-cc') || document.getElementById('p-play');
    if (cc) { try { DPad.focus(cc); } catch (_) {} }
  }
  function syncNudge(delta) {
    const d = nudgeSubDelay(delta);
    updateSyncVal();
    return d;
  }

  // ---------- Menus (audio / subtitles / speed) ----------
  const _SPEED_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];   // hoisted — same array every call
  const _YEAR_RE = /\b(19[5-9]\d|20[0-3]\d)\b/;
  const _EXT_RE = /\.[^.]+$/;
  function setPlayerRate(video, rate) {
    const next = Number(rate) || 1;
    video.playbackRate = next;
    const label = `${next}×`;
    const legacy = $('#p-speed-label');
    if (legacy) legacy.textContent = label;
    const speedTag = document.querySelector('.nft-spd-tag');
    if (speedTag) speedTag.textContent = label;
  }
  function buildMenu(kind) {
    const v = $('#video');
    const list = $('#p-menu-list');
    list.innerHTML = '';
    // Single pass over the <track> elements instead of spread+map+filter
    // (collapses three array allocations into one Set build).
    const externalSet = new Set();
    const trackEls = v.querySelectorAll('track');
    for (let i = 0; i < trackEls.length; i++) {
      if (trackEls[i].track) externalSet.add(trackEls[i].track);
    }
    if (kind === 'subtitles') {
      $('#p-menu-title').textContent = 'Subtitles';
      // Batch every row into a fragment and append once at the end — avoids
      // one layout/reflow per appendChild on a list that can hold a dozen+
      // rows (tracks + OpenSubtitles + timing nudges).
      const frag = document.createDocumentFragment();
      const customAvailable = !!(currentVideo && (
        (_subState && _subState.cues && _subState.cues.length)
        || (currentVideo._subCuesBackup && currentVideo._subCuesBackup.length)));
      const customActive = customAvailable && !currentVideo._subHidden
        && !!(_subState && _subState.cues && _subState.cues.length);
      let anyActive = customActive;
      for (let i = 0; i < v.textTracks.length; i++) {
        const m = v.textTracks[i].mode;
        if (m === 'hidden' || m === 'showing') { anyActive = true; break; }
      }
      addMenuItem(frag, 'Off', () => {
        for (const t of v.textTracks) t.mode = 'disabled';
        // Latch OFF so the async resolvers (embedded demux / external / audio-sync)
        // don't re-attach the track seconds later. Back up cues for a later toggle-on.
        if (currentVideo) {
          if (_subState && _subState.cues && _subState.cues.length) {
            currentVideo._subCuesBackup = _subState.cues;
          }
          currentVideo._subHidden = true;
        }
        clearSubOverlay();
        $('#p-cc').dataset.state = 'off';
        closeMenu();
      }, !anyActive);
      const seen = new Set();
      if (customAvailable) {
        seen.add('dumiflix-sidecar');
        addMenuItem(frag, 'English', () => {
          if (!currentVideo) return;
          if (!_subState || !_subState.cues || !_subState.cues.length) {
            const backup = currentVideo._subCuesBackup || [];
            if (backup.length) setSubCues(v, backup);
          }
          currentVideo._subHidden = false;
          $('#p-cc').dataset.state = 'on';
          closeMenu();
        }, customActive, 'Sidecar');
      }
      for (let i = 0; i < v.textTracks.length; i++) {
        const t = v.textTracks[i];
        if (t.kind !== 'subtitles' && t.kind !== 'captions') continue;
        const lang = (t.language || '').toUpperCase();
        const label = t.label
          || (lang ? `${lang}` : (externalSet.has(t) ? 'English' : `Track ${i + 1}`));
        const key = `${label}-${i}`;
        if (seen.has(key)) continue; seen.add(key);
        const sub = externalSet.has(t) ? 'External' : 'Embedded';
        addMenuItem(frag, label, () => {
          if (currentVideo) currentVideo._subHidden = false;   // user turned subs back ON
          for (let j = 0; j < v.textTracks.length; j++) {
            v.textTracks[j].mode = (j === i) ? 'showing' : 'disabled';
          }
          const selTrack = v.textTracks[i];
          wireSubOverlay(v, selTrack);
          // On webOS, embedded track cues are populated asynchronously.
          // If wireSubOverlay found no cues, retry on the first cuechange.
          if (!_subTimeupdateHandler) {
            const handler = function() {
              selTrack.removeEventListener('cuechange', handler);
              wireSubOverlay(v, selTrack);
            };
            selTrack.addEventListener('cuechange', handler);
          }
          $('#p-cc').dataset.state = 'on';
          closeMenu();
        }, t.mode === 'showing', sub);
      }
      if (!seen.size) {
        addMenuItem(frag, 'No subtitles available', null, false);
      }
      // OpenSubtitles manual chooser. Always offered when a key is
      // configured — the auto-pick can be wrong (especially on older
      // shows where DVDRip subs outnumber HD ones), so this is the
      // escape hatch for the user to swap to a different release.
      if (OpenSubs.hasApiKey()) {
        addMenuItem(frag, 'Search OpenSubtitles…', () => {
          openOpenSubsPicker();
        }, false, 'pick a different release');
      }
      // Manual timing nudge for THIS playback only (repeated presses walk the
      // sub into sync). Per-playback (currentVideo._manualOffset) so nudging one
      // bad sub can't desync everything else. NOTE: the TV player has
      // its own always-visible "Sync" button (video stays visible while you
      // adjust) — this menu path is the fallback for the legacy #player.
      addMenuItem(frag, 'Subs earlier −0.5s', () => {
        const d = nudgeSubDelay(-0.5);
        pToast(`Subtitle timing ${d >= 0 ? '+' : ''}${d.toFixed(1)}s`);
      }, false, 'if subs lag the voices');
      addMenuItem(frag, 'Subs later +0.5s', () => {
        const d = nudgeSubDelay(+0.5);
        pToast(`Subtitle timing ${d >= 0 ? '+' : ''}${d.toFixed(1)}s`);
      }, false, 'if subs lead the voices');
      list.appendChild(frag);
    } else if (kind === 'audio') {
      $('#p-menu-title').textContent = 'Audio';
      const tracks = v.audioTracks;
      if (tracks && tracks.length) {
        const frag = document.createDocumentFragment();
        for (let i = 0; i < tracks.length; i++) {
          const t = tracks[i];
          const lang = (t.language || '').toUpperCase();
          const label = t.label || (lang ? `${lang}` : `Track ${i + 1}`);
          // Codec hints aren't exposed on AudioTrack — best we can do is a
          // generic note. webOS picks the right codec automatically; this
          // menu just lets the user pick a different language stream.
          addMenuItem(frag, label, () => {
            for (let j = 0; j < tracks.length; j++) {
              tracks[j].enabled = (j === i);
            }
            closeMenu();
          }, t.enabled);
        }
        list.appendChild(frag);
      } else {
        addMenuItem(list, 'Single audio track', null, true,
          'webOS handles Dolby/Atmos passthrough automatically');
      }
    } else if (kind === 'speed') {
      $('#p-menu-title').textContent = 'Playback speed';
      const frag = document.createDocumentFragment();
      for (const s of _SPEED_STEPS) {
        addMenuItem(frag, `${s}×`, () => {
          setPlayerRate(v, s);
          closeMenu();
        }, Math.abs(v.playbackRate - s) < 0.01);
      }
      list.appendChild(frag);

    }
  }

  function addMenuItem(list, label, onClick, isActive, sub) {
    const b = document.createElement('button');
    b.className = 'p-menu-item' + (isActive ? ' is-active' : '');
    b.tabIndex = onClick ? 0 : -1;
    b.innerHTML = `
      <svg class="p-menu-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      <span>${escapeHtml(label)}</span>
      ${sub ? `<span class="p-menu-sub">${escapeHtml(sub)}</span>` : ''}
    `;
    if (onClick) b.onclick = onClick;
    list.appendChild(b);
  }

  // Manual OpenSubtitles picker — opens the menu with the top N candidates
  // for the current video. Click a row → fetch + attach as the active sub.
  // Used when the auto-pick was poorly synced (e.g. DVDRip sub against an
  // HD video) and the user wants to try a different release.
  async function openOpenSubsPicker() {
    if (!currentVideo) return;
    const v = $('#video');
    const cv = currentVideo;
    const filename = cv.subFilename || cv.title || '';
    let imdbId = null, query = '', season = null, episode = null, year = null;
    if (cv.show && cv.show.title) {
      query = cv.show.title;
      imdbId = cv.show.imdbId || null;
      season = cv.show.season || null;
      episode = cv.show.episode || null;
    } else {
      const inferred = inferShowFromTitle(filename);
      if (inferred && inferred.title) {
        query = inferred.title;
        season = inferred.season || null;
        episode = inferred.episode || null;
      } else {
        const cleaned = (filename || '').split(' — ').pop().replace(_EXT_RE, '');
        query = Trending.cleanTitle(cleaned) || cleaned;
        const yMatch = (filename || '').match(_YEAR_RE);
        if (yMatch) year = yMatch[1];
      }
    }
    activeMenu = 'subtitles';
    $('#p-menu-title').textContent = 'OpenSubtitles — loading…';
    $('#p-menu-list').innerHTML = '';
    $('#p-menu').hidden = false;
    showOverlay();
    let candidates = [];
    try {
      candidates = await OpenSubs.findCandidates({
        imdbId, query, season, episode, year, filename, limit: 12,
      });
    } catch (_) {}
    // The user may have closed the menu (or the player) while we were
    // fetching — bail if the menu state moved on.
    if (activeMenu !== 'subtitles' || !currentVideo || currentVideo !== cv) return;
    const list = $('#p-menu-list');
    list.innerHTML = '';
    $('#p-menu-title').textContent = 'OpenSubtitles — pick a release';
    if (!candidates.length) {
      addMenuItem(list, 'No matches found', null, false);
      addMenuItem(list, '← Back', () => buildMenu('subtitles'), false);
      requestAnimationFrame(() => DPad.focus($('#p-menu-list .p-menu-item')));
      return;
    }
    // Batch the (up to 12) candidate rows + back button into one fragment
    // append instead of one reflow per row.
    const frag = document.createDocumentFragment();
    candidates.forEach((c) => {
      addMenuItem(frag, c.label, async () => {
        $('#p-menu-title').textContent = 'Downloading subtitle…';
        let res;
        try { res = await OpenSubs.getContent(c.result); }
        catch (e) {
          if (currentVideo !== cv) return;
          toast('Subtitle download failed: ' + (e.message || e)); closeMenu(); return;
        }
        if (currentVideo !== cv) return;
        // Detach any prior external <track> we previously attached.
        [...v.querySelectorAll('track')].forEach(t => {
          if (t._objectUrl) URL.revokeObjectURL(t._objectUrl);
          t.remove();
        });
        if (currentVideo) currentVideo._subHidden = false;   // user chose a sub → subs ON
        await attachSubtitle(v, { name: res.name, _content: res.text });
        if (currentVideo !== cv) return;
        $('#p-cc').dataset.state = 'on';
        toast('Subtitle swapped');
        closeMenu();
      }, false, c.meta);
    });
    addMenuItem(frag, '← Back', () => buildMenu('subtitles'), false);
    list.appendChild(frag);
    requestAnimationFrame(() => {
      const first = $('#p-menu-list .p-menu-item');
      if (first) DPad.focus(first);
    });
  }

  function openMenu(kind) {
    activeMenu = kind;
    buildMenu(kind);
    $('#p-menu').hidden = false;
    showOverlay();
    setTimeout(() => {
      const focusEl = $('#p-menu-list .p-menu-item.is-active') || $('#p-menu-list .p-menu-item');
      if (focusEl) DPad.focus(focusEl);
    }, 30);
  }

  function closeMenu() {
    activeMenu = null;
    $('#p-menu').hidden = true;
    // Restore focus to the play button so the D-pad has a visible anchor
    // after the menu disappears. Without this, .is-focused stays on the
    // now-hidden .p-menu-item, leaving no glowing element on screen.
    const pp = $('#p-play');
    if (pp) DPad.focus(pp);
  }

  // ---------- Up next ----------
  // Hide the dialog + stop its countdown WITHOUT the permanent per-file
  // dismissal cancelUpNext() sets below — used by rearmUpNext() when the
  // credits-window auto-trigger backs off after the user seeks out of the
  // window (see tv-player.js's checkUpNextTrigger), so a later
  // re-entry into the window can still offer the card again.
  function hideUpNextDialog() {
    clearInterval(upnextTimer);
    upnextTimer = null;
    const upEl = $('#p-upnext');
    if (upEl) upEl.hidden = true;
    const fillEl = $('#p-upnext-progress-fill');
    if (fillEl) fillEl.classList.remove('is-filling');
    const labelEl = $('#p-upnext .p-upnext-label');
    if (labelEl) labelEl.textContent = 'Up next';
  }
  function cancelUpNext() {
    upnextAutoDismissed = true;
    hideUpNextDialog();
    // Restore focus to the play button so the D-pad has a visible anchor
    // after the Up Next dialog is dismissed.
    const pp = $('#p-play');
    if (pp) DPad.focus(pp);
  }
  // Bridge-exposed counterpart for the re-arm case — see hideUpNextDialog's
  // doc comment. Deliberately does NOT set upnextAutoDismissed.
  function rearmUpNext() {
    hideUpNextDialog();
  }
  // index.html has no dedicated node for the up-next thumbnail (added after
  // the static markup was written) — create it once and cache it, mirroring
  // the hot-path DOM-caching pattern used elsewhere (e.g. updateSkipButton's
  // cached nodes). Inserted right above the title so it reads "art, then
  // title", matching the compact up-next card.
  function upNextThumbEl() {
    if (upNextThumbEl._el) return upNextThumbEl._el;
    const upEl = document.getElementById('p-upnext');
    const titleEl = document.getElementById('p-upnext-title');
    if (!upEl || !titleEl) return null;
    const el = document.createElement('img');
    el.className = 'p-upnext-thumb';
    el.alt = '';
    el.hidden = true;
    upEl.insertBefore(el, titleEl);
    upNextThumbEl._el = el;
    return el;
  }
  // Best-effort poster for the resolved next-episode object — every shape
  // maybeShowUpNext() can produce already carries one somewhere (the queued
  // item, the apibay/EZTV `add` payload) or falls back to the current show's
  // own art. Artwork is optional: a miss just leaves the card
  // text-only rather than inventing a new artwork lookup.
  function upNextPosterFor(cv, next) {
    return (next && next.poster)
      || (next && next.queueItem && next.queueItem.poster)
      || (next && next.add && next.add.poster)
      || (cv && cv.show && cv.show.poster)
      || null;
  }

  // For TV episodes: when current playback ends (or the credits mark is
  // reached, see checkUpNextTrigger in tv-player.js), queue the next
  // episode and offer to start it. 5-second countdown so the user can cancel.
  // Look for an already-queued item that's the next episode of this show.
  // Returns the matched queue item or null. Lets Up Next jump directly to
  // an in-flight or ready episode without burning an apibay query when the
  // ≤2 GB flow has already started downloading the next one in parallel.
  function findNextEpisodeInQueue(show, target) {
    if (!show || !show.title) return null;
    // maybeShowUpNext passes the authoritative (TVMaze) target; the other,
    // synchronous callers don't — fall back to the season/episode heuristic.
    if (!target) {
      if (!show.season || !show.episode) return null;
      const epsInSeason = show.episodesInSeason || 0;
      const seasonNums = show.seasonNums || [];
      if (epsInSeason && show.episode < epsInSeason) {
        target = { season: show.season, episode: show.episode + 1 };
      } else if (seasonNums.length) {
        const idx = seasonNums.indexOf(show.season);
        if (idx < 0 || idx + 1 >= seasonNums.length) return null;
        target = { season: seasonNums[idx + 1], episode: 1 };
      } else {
        target = { season: show.season, episode: show.episode + 1 };
      }
    }
    const wantTitle = _normShow(show.title);
    return queue.find(q =>
      q.show && q.show.season === target.season && q.show.episode === target.episode
      && _normShow(q.show.title || '') === wantTitle
    ) || null;
  }

  // Local-store next episode: an already-cached copy of the target episode
  // on the laptop/phone cache. Continue-Watching and search starts never set
  // show._localNext (that wiring is Library-modal-only), so without this
  // the auto-advance for an ALREADY-DOWNLOADED next episode fell through to
  // a wasteful — and often failing — tracker re-search.
  // LaptopCache.listAll()
  // never fails closed on a dead network — it serves the last-good listing
  // (tagged `.stale`) or, on a fresh boot with no in-memory copy at all, the
  // compact on-disk snapshot (tagged `.fromSnapshot`) persisted on every
  // prior successful refresh. Either way `f.id` here is a genuine
  // `VPSCACHE::<rel>` id, so the match below plays it through the exact
  // same playDriveFile() path a normal (live-listed) cache hit would — no
  // special-casing needed for the stale/snapshot case.
  async function findNextEpisodeInLocalStores(show, target) {
    if (!show || !show.title || !target) return null;
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const want = norm(show.title);
    if (!want) return null;
    const lists = [];
    try {
      if (typeof LaptopCache !== 'undefined' && LaptopCache.available()) {
        // .catch(() => []) is defense-in-depth only now — LaptopCache.listAll()
        // resolves (never rejects) even when its own live fetch fails.
        lists.push(await LaptopCache.listAll().catch(() => []));
      }
    } catch (_) {}
    try {
      if (typeof PhoneCache !== 'undefined'
          && await PhoneCache.reachable().catch(() => false)) {
        lists.push(await PhoneCache.listAll().catch(() => []));
      }
    } catch (_) {}
    // Rank matching copies with the Library grid's quality tiebreak so
    // listing order cannot choose a lower-quality duplicate.
    let best = null;
    let bestFromStale = false;
    for (const files of lists) {
      for (const f of (files || [])) {
        const d = showFromFilename(f.name);
        if (!d || d.season !== target.season || d.episode !== target.episode) continue;
        const t = norm(d.title);
        if (!t || (!want.startsWith(t) && !t.startsWith(want))) continue;
        if (!best || _libQualityRank({ name: f.name }) > _libQualityRank({ name: best.name })) {
          best = f;
          bestFromStale = !!(files && files.stale);
        }
      }
    }
    if (!best) return null;
    // Record when up-next resolves from a stale/snapshot listing so diagnostics
    // can distinguish a cached match from a successful live network request.
    if (bestFromStale) {
      try { window.__bbEvent && window.__bbEvent('upnext:stale-list', { s: target.season, e: target.episode }); } catch (_) {}
    }
    const f = best;
    const sStr = String(target.season).padStart(2, '0');
    const eStr = String(target.episode).padStart(2, '0');
    const nextShow = { ...show, season: target.season, episode: target.episode,
                       _localNext: null, _localNextLabel: null };
    return {
      label: `${show.title} — S${sStr}E${eStr}`,
      // Concrete file identity for callers that need more than a play action
      // (the subtitle prewarm asks the laptop to bake THIS file's subs).
      fileId: f.id,
      name: f.name,
      local: () => playDriveFile(f.id, f.name, show.poster || null,
                                 f.subtitles || [], nextShow),
    };
  }

  // One authoritative manual-Next resolver shared by the legacy player, the
  // TV overlay and the phone remote. Local Library chaining comes first,
  // followed by an already-queued copy, an already-cached copy, and only then
  // a tracker lookup. The old three independent implementations skipped the
  // local-cache steps, so their Next buttons could report "not found" while
  // the automatic end-of-episode path could see the same file.
  async function findManualNextEpisode(cv) {
    if (!cv || !cv.show) return null;
    if (cv.show._localNext) {
      return { label: cv.show._localNextLabel || 'Next episode', local: cv.show._localNext };
    }
    const target = await resolveNextEpisodeTarget(cv.show);
    if (!target) return null;
    const queued = findNextEpisodeInQueue(cv.show, target);
    if (queued) {
      const sStr = String(queued.show.season).padStart(2, '0');
      const eStr = String(queued.show.episode).padStart(2, '0');
      return { label: `${queued.show.title} — S${sStr}E${eStr}`, queueItem: queued };
    }
    return await findNextEpisodeInLocalStores(cv.show, target)
      || await findNextEpisodeQueueable(cv.show, target);
  }

  async function maybeShowUpNext() {
    const cv = currentVideo;
    if (!cv || !cv.show || !cv.show.season || !cv.show.episode) return;
    // A deliberate per-file dismissal (Back/Cancel on a previously-shown
    // card) suppresses the AUTO offer for the rest of this file — see
    // cancelUpNext(). Doesn't affect the manual Next controls (nft's
    // control-row Next button, the legacy #p-next-ep button), which call
    // triggerUpNext() directly and never come through here.
    if (upnextAutoDismissed) return;
    // Idempotent: the player's 'ended' event AND its near-end fallback both
    // call this — don't restart the countdown if it's already showing.
    const upEl = $('#p-upnext');
    if (upEl && !upEl.hidden) return;
    // Defense-in-depth: the AUTO countdown must only ever fire near the
    // genuine end of the episode. Real triggers are the nft credits-mark
    // trigger (fires at cv._creditsMark.start, falling back to d-30s), its
    // subTimer d-1s fallback, and the legacy 'ended' handler — all comfortably
    // inside 90s of the true end for a real credits sequence, so if we're
    // called with more left than that we're being mis-fired early (a bad
    // crowd/chapter credits mark, or a future regression) — bail and let the
    // rest of the episode play. The manual Next controls do NOT come through
    // here (they call triggerUpNext directly), so this never blocks a
    // deliberate skip.
    try {
      const _pv = $('#video');
      // v.duration/v.currentTime are WINDOW-relative while a remux session
      // is live — the raw check made "remaining" read as ffmpeg's encode
      // lead over the playhead (routinely >45s), which silently discarded
      // every genuine end-of-episode call: auto-advance simply never fired
      // under remux. Map through Remux like every other absolute-time
      // consumer in this file.
      const _rmx = (typeof Remux !== 'undefined' && Remux.hasSession());
      const _d = (_rmx && Remux.duration) || (_pv ? _pv.duration : 0);
      const _t = _rmx ? Remux.absolute(_pv ? (_pv.currentTime || 0) : 0)
                      : (_pv ? (_pv.currentTime || 0) : 0);
      if (_d > 0 && _t > 0 && (_d - _t) > 90) return;
    } catch (_) {}
    // First, check if the next episode is already in our queue (seedring,
    // seedred, copying, or drive-ready). The ≤2 GB instant-play flow
    // queues it the moment the current one's seedr download finishes, so
    // by end-of-episode it's usually available without an apibay round-trip.
    let next = null;
    // Library play-in-order: the next episode is already on the pen/cache, so
    // play it directly with zero tracker round-trips. Takes priority over the
    // queue/apibay paths below.
    if (cv.show._localNext) {
      next = { label: cv.show._localNextLabel || 'Next episode', local: cv.show._localNext };
    }
    if (!next) {
      // Resolve the true next episode ONCE (TVMaze-authoritative, rolls across
      // season boundaries), then reuse it for both the local-queue check and
      // the tracker search so they can never disagree.
      const target = await resolveNextEpisodeTarget(cv.show);
      if (currentVideo !== cv) return;   // user moved on during the lookup
      if (target) {
        const queued = findNextEpisodeInQueue(cv.show, target);
        if (queued) {
          const sStr = String(queued.show.season).padStart(2, '0');
          const eStr = String(queued.show.episode).padStart(2, '0');
          next = { label: `${queued.show.title} — S${sStr}E${eStr}`, queueItem: queued };
        } else {
          // Already cached on the laptop/phone? Play it directly — never
          // re-search trackers for a file we already hold.
          next = await findNextEpisodeInLocalStores(cv.show, target)
              || await findNextEpisodeQueueable(cv.show, target);
        }
      }
    }
    // Bail if the user closed the player (or started a different video) while
    // the apibay search was in flight. Without this guard, a quick Back press
    // immediately after the credits would auto-queue an episode the user
    // didn't ask for.
    if (currentVideo !== cv) return;
    if (!next) return;
    $('#p-upnext-title').textContent = next.label;
    const thumbEl = upNextThumbEl();
    if (thumbEl) {
      const poster = upNextPosterFor(cv, next);
      if (poster) { thumbEl.src = poster; thumbEl.hidden = false; }
      else { thumbEl.removeAttribute('src'); thumbEl.hidden = true; }
    }
    const labelEl = $('#p-upnext .p-upnext-label');
    upEl.hidden = false;
    showOverlay();
    setTimeout(() => DPad.focus($('#p-upnext-play')), 50);
    const UPNEXT_MS = 5000;   // 5s up-next countdown
    upnextDeadline = Date.now() + UPNEXT_MS;
    clearInterval(upnextTimer);
    // GPU-friendly fill: ONE CSS transform:scaleX transition run over exactly
    // 5s, instead of the old per-100ms `style.width` write (a layout-forcing
    // property on every tick — expensive on older webOS Chromium). Reset
    // instantly (transition class off), force a reflow, then add the class
    // back so the transition always restarts from empty on a fresh show.
    const fillEl = $('#p-upnext-progress-fill');
    if (fillEl) {
      fillEl.classList.remove('is-filling');
      fillEl.style.transform = 'scaleX(0)';
      void fillEl.offsetWidth;
      fillEl.classList.add('is-filling');
    }
    // The bar's motion no longer depends on this interval at all (pure CSS
    // now) — it only drives the "Playing in N…" text and the final autoplay.
    const _tick = () => {
      const left = Math.max(0, upnextDeadline - Date.now());
      if (labelEl) labelEl.textContent = left > 0 ? `Playing in ${Math.ceil(left / 1000)}…` : 'Up next';
      if (left <= 0) {
        cancelUpNext();
        triggerUpNext(next);
      }
    };
    _tick();
    upnextTimer = setInterval(_tick, 200);
    $('#p-upnext-play').onclick = () => { cancelUpNext(); triggerUpNext(next); };
    $('#p-upnext-cancel').onclick = () => cancelUpNext();
  }

  function triggerUpNext(next) {
    closePlayer();
    // Cover the gap between tearing down this player and the next source
    // resolving with the loading overlay — shown SYNCHRONOUSLY right after
    // closePlayer (before any await) so the home screen never paints between
    // the two players. openPlayer() calls hideLoading() when the next video is
    // ready; the failure branches below hide it explicitly.
    // Local Library chain — the next episode is already on the pen/cache;
    // play it straight away (openPlayer will hide the loading overlay).
    if (next.local) {
      showLoading(next.label, next.poster || null, null);
      next.local();
      return;
    }
    if (next.queueItem) {
      // Already in our queue — play it directly from whichever source is
      // furthest along. We don't re-addToQueue (would dedup as "already in
      // queue" anyway, but this is more explicit).
      const it = next.queueItem;
      if (it.phase === 'drive-ready' && it.driveFiles && it.driveFiles.length) {
        showLoading(next.label, it.poster, it.id);
        const main = [...it.driveFiles].sort((a, b) => b.size - a.size)[0];
        playDriveFile(main.fileId, it.name, it.poster, it.driveSubtitles, it.show);
        return;
      }
      // Seedr copy is COMPLETE (seedred / copying / cloud-ready) → play from
      // seedr. Guard against a still-in-progress 'seedring' item that already
      // has a folder — its file is partial and playFolder would open a broken
      // stream; those fall through to the wait-and-autoplay path below.
      const seedrReady = it.folderId &&
        (it.phase === 'seedred' || it.phase === 'copying' || it.phase === 'cloud-ready');
      if (seedrReady) {
        showLoading(next.label, it.poster, it.id);
        playFolder(it);
        return;
      }
      // Still downloading (seedring with no/partial folder, or pending). DON'T
      // dead-end on a toast — the episode IS coming. Mark it to auto-open the
      // moment its download finishes (decidePlayPath plays autoplay items), keep
      // the loading overlay up with live % progress, and make sure it's actually
      // being worked (promote it if it was parked behind the slot).
      it.autoplay = true;
      persistQueue();
      showLoading(next.label, it.poster, it.id);
      loadingTick(it);
      promoteNextPending();
      return;
    }
    // Up Next had to fall back to apibay (the auto-queued chain didn't
    // pre-fetch this episode). Mark it autoplay:true so decidePlayPath
    // opens the player when seedr is done AND triggers the chain to
    // fetch the episode after this one. addToQueue(autoplay) shows its own
    // loading overlay, so home still never flashes.
    if (next.add) addToQueue({ ...next.add, autoplay: true });
  }

  // Render the video/audio format badges (4K · HDR10 · TrueHD 7.1 Atmos) from
  // the phone's media-info probe. Shows the DEFAULT audio track — what actually
  // plays — since webOS picks the default and we can't switch in-band tracks.
  const _AUDIO_CODEC_NAMES = {
    aac: 'AAC', ac3: 'Dolby Digital', eac3: 'Dolby Digital+', truehd: 'Dolby TrueHD',
    dts: 'DTS', dca: 'DTS', flac: 'FLAC', opus: 'Opus', vorbis: 'Vorbis',
    mp3: 'MP3', pcm_s16le: 'PCM', pcm_s24le: 'PCM', pcm_bluray: 'PCM', mlp: 'MLP',
  };
  function renderMediaInfo(info) {
    // #p-mediainfo is static player chrome (declared once in index.html,
    // never replaced) — cache the lookup instead of re-querying every call.
    const box = renderMediaInfo._box || (renderMediaInfo._box = document.getElementById('p-mediainfo'));
    if (!box) return;
    const badges = [];
    const v = info && info.video;
    if (v) {
      const w = v.width || 0, h = v.height || 0;
      const res = (w >= 3000 || h >= 1600) ? '4K'
                : (w >= 1900 || h >= 1000) ? '1080p'
                : (w >= 1200) ? '720p' : 'SD';
      badges.push({ t: res });
      if (v.hdr && v.hdr !== 'SDR') badges.push({ t: v.hdr, cls: 'is-hdr' });
      else if (v.bit_depth >= 10) badges.push({ t: '10-bit' });
    }
    const auds = (info && info.audio) || [];
    const a = auds.find(x => x.default) || auds[0];
    if (a) {
      const name = _AUDIO_CODEC_NAMES[a.codec] || String(a.codec || '').toUpperCase();
      const layout = a.layout || (a.channels ? a.channels + 'ch' : '');
      badges.push({ t: (name + (layout ? ' ' + layout : '')).trim(),
                    cls: a.channels >= 6 ? 'is-surround' : '' });
      if (a.atmos) badges.push({ t: 'Atmos', cls: 'is-atmos' });
    }
    if (!badges.length) { box.innerHTML = ''; box.hidden = true; return; }
    // Build off-DOM, then attach once — avoids one reflow-triggering mutation
    // per badge (this box is rebuilt on every video/audio-track change).
    const frag = document.createDocumentFragment();
    badges.forEach(b => {
      const el = document.createElement('span');
      el.className = 'p-badge' + (b.cls ? ' ' + b.cls : '');
      el.textContent = b.t;
      frag.appendChild(el);
    });
    box.textContent = '';
    box.appendChild(frag);
    box.hidden = false;
  }

  // Decide whether to show Skip Intro / Skip Recap / Skip Credits right now.
  // Precise when the phone returned chapter markers (seek to the chapter
  // boundary); a conservative heuristic Skip Intro otherwise (TV episodes,
  // early in the file, user-initiated so a fixed forward jump is safe). Called
  // every timeupdate; sets currentVideo._skipTarget = absolute seconds to seek.
  function updateSkipButton(v, cv) {
    // This runs on every 'timeupdate' tick (several times/sec during
    // playback) — all four nodes it touches are static player chrome, so
    // cache them on the function itself instead of re-querying each tick.
    const btn = updateSkipButton._btn || (updateSkipButton._btn = document.getElementById('p-skip'));
    if (!btn) return;
    const upEl = updateSkipButton._up || (updateSkipButton._up = document.getElementById('p-upnext'));
    const playBtn = updateSkipButton._play !== undefined ? updateSkipButton._play
                     : (updateSkipButton._play = document.getElementById('p-play'));
    // When the button vanishes, don't leave D-pad focus stranded on a hidden
    // control (pressing OK would then fall through to play/pause) — hand focus
    // back to the play button.
    const hide = () => {
      if (cv) { cv._skipTarget = null; cv._skipKind = null; }
      if (!btn.hidden) {
        const wasFocused = btn.classList.contains('is-focused');
        btn.hidden = true;
        if (wasFocused && playBtn) { try { DPad.focus(playBtn); } catch (_) {} }
      }
    };
    // In remux mode the skip MARKS are in absolute movie time but v.currentTime
    // is window-relative, and v.duration is only the rolling window -- so both
    // the current time and the total must come from Remux, or Skip Intro/Recap/
    // Credits fire at the wrong moment (or never show, since v.duration is null).
    const _rmx = (typeof Remux !== 'undefined' && Remux.hasSession());
    const dur = (_rmx && Remux.duration) ? Remux.duration : v.duration;
    if (!cv || cv.isLive || cv.isAudio || !dur) return hide();
    // The TV player draws its own focusable Skip pill and owns the
    // keyboard — the legacy #p-skip button can't be reached there, so stand down.
    if (window.__nfActive) return hide();
    if (!upEl.hidden) return hide();  // up-next dialog owns the screen
    const t = _rmx ? Remux.absolute(v.currentTime) : v.currentTime;
    let label = null, target = null, kind = null;
    // Use the RECONCILED marks (crowd DB validated against this file's chapters
    // + subtitles) — same source the TV player uses, so both agree and
    // neither fires the raw DB intro that can land on the wrong cut.
    const rc = cv._recapMark, io = cv._introMark, cr = cv._creditsMark;
    // A used mark must not resurrect the button just because a remux
    // out-of-window seek lands on the PRECEDING KEYFRAME (a couple of seconds
    // before the requested target) and nowAbs() still reads inside the old
    // window a beat later — see the matching cv._skipConsumed logic in
    // tv-player.js's computeSkip() for the full story; this legacy
    // button (stood down whenever the TV player is active, see
    // window.__nfActive above) shares the SAME per-mark consumed store on cv
    // so the two never disagree. Re-arms once playback moves back to clearly
    // before the mark's start, so rewinding into it offers the button again.
    const SKIP_REARM_MARGIN = 2;
    const consumed = cv._skipConsumed || (cv._skipConsumed = {});
    if (rc && t < rc.start - SKIP_REARM_MARGIN) consumed.recap = false;
    if (io && t < io.start - SKIP_REARM_MARGIN) consumed.intro = false;
    if (cr && t < cr.start - SKIP_REARM_MARGIN) consumed.credits = false;
    if (!io && cv.show && cv.show.season && t < 12 - SKIP_REARM_MARGIN) consumed.heuristic = false;
    if (rc && !consumed.recap && t >= Math.max(0, rc.start - 1) && t < rc.end - 1.5) {
      label = 'Skip Recap'; target = rc.end; kind = 'recap';
    } else if (io && !consumed.intro && t >= Math.max(0, io.start - 1) && t < io.end - 1.5) {
      label = 'Skip Intro'; target = io.end; kind = 'intro';
    } else if (cr && !consumed.credits && (dur - t) > 20 && t >= Math.max(0, cr.start - 1)) {
      const oEnd = (cr.end != null) ? cr.end : dur;
      if (t < oEnd - 1.5) { label = 'Skip Credits'; target = Math.min(oEnd, dur - 1.2); kind = 'credits'; }
    }
    // Last resort — no marks at all: a conservative heuristic Skip Intro in the
    // opening minutes of a TV episode.
    if (!label && !io && !consumed.heuristic && cv.show && cv.show.season) {
      if (t >= 12 && t <= 240) { label = 'Skip Intro'; target = Math.min(t + 82, dur - 5); kind = 'heuristic'; }
    }
    if (label && target != null && target > t + 1.5) {
      cv._skipTarget = target;
      cv._skipKind = kind;
      const lbl = updateSkipButton._lbl || (updateSkipButton._lbl = document.getElementById('p-skip-label'));
      if (lbl) lbl.textContent = label;
      // Reveal + move focus onto it so a single OK press skips the chapter.
      // Only steal focus on the hidden→shown transition so we don't fight the
      // user's navigation while it stays up.
      if (btn.hidden) { btn.hidden = false; try { DPad.focus(btn); } catch (_) {} }
    } else {
      hide();
    }
  }

  function bindPlayer() {
    const v = $('#video');
    const overlay = $('#player-overlay');
    let _lastPersist = 0;

    // --- webOS native-memory guard ---
    // Decode surfaces and demux buffers can accumulate outside the JavaScript
    // heap during long playback, so performance.memory cannot measure all
    // media memory. Releasing and reloading the media element, then seeking
    // back, limits that pressure while preserving the playback position.
    //
    // On single-decoder devices the reload cannot be hidden (cannot pre-buffer a
    // second <video> to hot-swap — max-activated-media-players=1) and the HW
    // overlay returns BLACK frames to canvas (can't hold up a freeze-frame). So
    // a reload can briefly interrupt the picture. Prefer pause and seek
    // opportunities, with a periodic backstop during continuous playback:
    //   SOFT — on pause past RC_SOFT played-seconds, deferred ~1.2s so only a
    //          sustained pause flushes (a quick pause-scrub avoids the reload;
    //          a stepped-away pause hides it) + muted repaint so returning shows
    //          the frame, not black.
    //   SEEK — on a user seek past RC_SEEK played-seconds — the seek already
    //          rebuffers, so the relief rides along invisibly.
    //   HARD — mid-play forced flush. Direct media refreshes at 25 min;
    //          remux/HLS uses 8 min to bound native memory more tightly.
    //          window.__RC_HARD still overrides the threshold (set it to
    //          Infinity to disable the backstop entirely).
    // Driven off media events so webOS's background-timer throttling can't stall
    // relief. Trade-off: an interaction-free stream now pays one ~1s black-gap
    // periodic flush instead of risking native/GPU exhaustion; resume lands at
    // the exact absolute movie time either way.
    const RC_SOFT = 5 * 60;    // pause-flush past this many PLAYED seconds
    // Defer seek-triggered recycling to reduce repeated decoder rebuilds.
    // The periodic backstop still applies during uninterrupted playback.
    const RC_SEEK = 15 * 60;   // seek-flush past this many PLAYED seconds
    const RC_HARD_DIRECT = 25 * 60;
    const RC_HARD_REMUX = 8 * 60;
    let _rcPlayed = 0, _rcLastAt = performance.now();
    let _rcRunning = !v.paused && !v.ended && !v.seeking && v.readyState >= 2, _rcSeeking = !!v.seeking;
    let _rcBusy = false, _pausedFlushTimer = null;
    // SOFT/SEEK honor a window override (number) or disable (=== false). HARD
    // honors a window override (number, including Infinity to disable) and
    // otherwise defaults ON at RC_HARD.
    const _softThresh = () => window.__RC_SOFT === false ? Infinity : (window.__RC_SOFT || RC_SOFT);
    const _seekThresh = () => window.__RC_SEEK === false ? Infinity : (window.__RC_SEEK || RC_SEEK);
    const _hardThresh = () => {
      if (typeof window.__RC_HARD === 'number') return window.__RC_HARD;
      const remuxed = typeof Remux !== 'undefined' && Remux.hasSession();
      return remuxed ? RC_HARD_REMUX : RC_HARD_DIRECT;
    };

    // Eligibility must NOT depend on the `currentVideo` JS object: after a
    // a page relaunch the media element may survive while currentVideo resets
    // to null. Gating on currentVideo would disable recycling for that session.
    // Gate on the element's own state
    // instead (same reasoning as the toggle handler). A finite, positive
    // duration also excludes live streams (which report Infinity / 0 duration).
    function _rcEligible() {
      const remuxed = typeof Remux !== 'undefined' && Remux.hasSession();
      const duration = remuxed ? Number(Remux.duration || 0) : Number(v && v.duration);
      const position = remuxed ? Number(Remux.absolute(v.currentTime) || 0)
        : Number(v && v.currentTime);
      return v && v.currentSrc
        && !(currentVideo && currentVideo.isAudio)
        && !(currentVideo && currentVideo.isLive)
        && Number.isFinite(duration) && duration > 0
        && (duration - position) > 45;
    }
    function _rcTrack() {
      const now = performance.now();
      // Use elapsed playing time: delayed timeupdates must not disable the
      // native-memory backstop. Seek distance never enters this clock.
      if (!_rcBusy && _rcRunning && !_rcSeeking) _rcPlayed += Math.max(0, now - _rcLastAt) / 1000;
      _rcLastAt = now;
    }
    v.addEventListener('playing', () => {
      _rcTrack();
      _rcRunning = true;
    });
    // `stalled` reports missing network bytes, not a stopped decoder: a
    // buffered video may keep playing without another `playing` event.
    ['pause', 'waiting', 'ended', 'emptied'].forEach(name => {
      v.addEventListener(name, () => { _rcTrack(); _rcRunning = false; });
    });
    v.addEventListener('seeking', () => {
      _rcTrack(); _rcSeeking = true; _rcRunning = false;
    });
    v.addEventListener('seeked', () => {
      _rcLastAt = performance.now();
      _rcSeeking = false;
      _rcRunning = !v.paused && !v.ended && v.readyState >= 2;
    });
    v.addEventListener('loadedmetadata', () => {
      if (!_rcBusy) _rcPlayed = 0;
      _rcLastAt = performance.now();
      _rcSeeking = false;
      _rcRunning = !v.paused && !v.ended && v.readyState >= 2;
    });
    async function _rcFlush(why) {
      if (_rcBusy || !_rcEligible()) return;
      const seekTarget = (typeof Remux !== 'undefined' && Remux.hasSession())
        ? Remux.absolute(v.currentTime || 0) : (v.currentTime || 0);
      if (blockDirectSeedrSeek(seekTarget, true)) return;
      _rcBusy = true;
      // Snapshot the playback session. If the user backs out or switches titles
      // during the async flush, `currentVideo` changes — we must NOT re-seek /
      // re-play the old source on top of the new state (that would resurrect a
      // stale decoder or clobber a freshly-opened video). The try/finally
      // guarantees _rcBusy always clears, so an early return can never leave the
      // guard permanently disabled.
      const cv = currentVideo;
      const t = v.currentTime, wasPaused = v.paused, src = v.currentSrc;
      const remuxed = typeof Remux !== 'undefined' && Remux.hasSession();
      const absoluteT = remuxed ? Remux.absolute(t) : t;
      const wasMuted = v.muted;
      // A seek can trigger this recycle from its own `seeked` event. Hand the
      // subtitle hold from the seek to the recycle so the first operation
      // cannot repaint against the second operation's new HLS time base.
      let nftSeekToken = null;
      if (remuxed && typeof window.__nftBeginExternalSeek === 'function') {
        try { nftSeekToken = window.__nftBeginExternalSeek(); } catch (_) {}
      }
      try {
        window.__bbEvent && window.__bbEvent('rc:flush', {
          t: t | 0, abs: absoluteT | 0, played: _rcPlayed | 0, why, remux: remuxed ? 1 : 0,
        });
      } catch (_) {}
      // A mid-play flush is briefly visible as a black gap while the element
      // reloads — show the app's normal buffering spinner over it so it reads
      // as a buffer. A pause flush is hidden by the (stuck) paused UI already.
      if (why !== 'pause') { try { setBuffering(true); } catch (_) {} }
      const waitForMedia = () => {
        if (!v.error && v.readyState >= 2) return Promise.resolve();
        return new Promise((resolve) => {
          let done = false;
          const fin = () => { if (done) return; done = true; resolve(); };
          v.addEventListener('loadeddata', fin, { once: true });
          v.addEventListener('canplay', fin, { once: true });
          setTimeout(fin, 6000);
        });
      };
      const rebuild = async () => {
        NativePlayer.release(v);                  // release native decoder + buffers
        await new Promise((r) => setTimeout(r, 80));
        if (currentVideo !== cv) return false;
        if (remuxed) {
          // Force a fresh server generation even when the target is inside the
          // current rolling window. Remux owns the absolute↔relative mapping
          // and reloads the playlist through NativePlayer/mediaOption.
          await Remux.seekAbsolute(absoluteT, { force: true });
          if (currentVideo !== cv) return false;
        } else {
          setVideoSource(v, src, { startTime: t });
        }
        await waitForMedia();
        if (currentVideo !== cv) return false;
        const landing = remuxed ? Remux.toRelative(absoluteT) : t;
        if (remuxed) {
          // ALWAYS land at the exact relative point, even when it is only
          // 1-5s from zero. The old `difference > 5` tolerance skipped this
          // assignment after a common preceding-keyframe restart (live trace:
          // requested relative 3.x, element left at 0), permanently shifting
          // subtitles by that skipped gap after a seek-bar scrub.
          //
          // Remux.seekAbsolute has already verified this point is buffered.
          // Use exact currentTime, never fastSeek: keyframe snapping is the
          // very offset we are correcting. Wait for webOS to acknowledge the
          // new clock before releasing the subtitle hold or resuming playback.
          await new Promise((resolve) => {
            let done = false, poll = null, timeout = null;
            const finish = () => {
              if (done) return;
              done = true;
              clearTimeout(poll); clearTimeout(timeout);
              try { v.removeEventListener('seeked', check); } catch (_) {}
              try { v.removeEventListener('timeupdate', check); } catch (_) {}
              resolve();
            };
            const check = () => {
              const ct = Number(v.currentTime);
              if (!v.seeking && v.readyState >= 2 && Number.isFinite(ct)
                  && Math.abs(ct - landing) <= 0.75) return finish();
              poll = setTimeout(check, 80);
            };
            v.addEventListener('seeked', check);
            v.addEventListener('timeupdate', check);
            try { v.currentTime = Math.max(0, landing); } catch (_) {}
            timeout = setTimeout(finish, 5000);
            poll = setTimeout(check, 0);
          });
        } else if (Math.abs((v.currentTime || 0) - landing) > 5) {
          // Direct MKV recovery keeps fastSeek's cold-decoder safety.
          resumeSeek(v, landing);
        }
        return currentVideo === cv;
      };
      try {
        if (!await rebuild() || currentVideo !== cv) return;
        // VERIFY THE REBUILD. Everything above is a destructive teardown —
        // release the decoder, drop the source, build a new one — and a pause
        // flush deliberately shows NO spinner, so if the element fails to come
        // back the user is looking at a dead player with no feedback and no
        // log line. That is indistinguishable from a crash, and it is the one
        // failure this routine never checked for.
        //
        // readyState >= HAVE_CURRENT_DATA means the pipeline actually decoded
        // something; v.error means it gave up. Either way, say so, and try one
        // clean rebuild before leaving the element dead.
        if (v.error || v.readyState < 2) {
          try {
            window.__bbEvent && window.__bbEvent('rc:flush-bad', {
              why, t: t | 0, rs: v.readyState, err: v.error ? v.error.code : 0,
            });
          } catch (_) {}
          // A brief engine outage across this window can leave the element at
          // readyState 0 / networkState 3 with error === null and no events.
          // Retry explicitly rather than waiting for an error callback.
          //
          // A transient blip must not be fatal, so retry with backoff across
          // ~15s rather than giving up after one attempt (one attempt lands
          // while the network is still down and always fails). The spinner is
          // forced ON here even for a pause flush: the no-spinner rule is for
          // an invisible SUCCESSFUL flush, and showing a dead frame with no
          // feedback is exactly what made this look like a crash.
          try { setBuffering(true); } catch (_) {}
          let ok = false;
          const backoff = [500, 1000, 2000, 4000, 8000];
          for (let i = 0; i < backoff.length; i++) {
            await new Promise((r) => setTimeout(r, backoff[i]));
            if (currentVideo !== cv) return;
            try { await rebuild(); } catch (_) {}
            if (currentVideo !== cv) return;
            ok = !v.error && v.readyState >= 2;
            if (ok) break;
          }
          try { setBuffering(false); } catch (_) {}
          try {
            window.__bbEvent && window.__bbEvent('rc:flush-retry', {
              why, rs: v.readyState, err: v.error ? v.error.code : 0, ok,
            });
          } catch (_) {}
        }
        if (!wasPaused) {
          try { await v.play(); } catch (_) {}
          if (currentVideo !== cv) return;
        } else {
          // Paint the seek frame: webOS leaves a paused, freshly-reloaded
          // <video> BLACK until it decodes at least one frame. A brief MUTED
          // play -> pause forces that decode without visible motion or an
          // audio blip — so a stepped-away user returns to the frame, not black.
          try {
            v.muted = true;
            await v.play();
            if (currentVideo !== cv) return;
            await new Promise((r) => setTimeout(r, 140));
            if (currentVideo !== cv) return;
            v.pause();
          } catch (_) {}
        }
      } catch (e) {
        // Was a bare `catch (_) {}`. This routine tears the video element
        // down and rebuilds it; an exception in the middle leaves it dead,
        // and on a pause flush there is no spinner to hint at it either. The
        // blackbox is the only place this can ever surface, so record it.
        try {
          window.__bbEvent && window.__bbEvent('rc:flush-throw', {
            why, t: t | 0, msg: String((e && e.message) || e).slice(0, 120),
          });
        } catch (_) {}
        // Last-resort recovery: if the remux control call failed after the
        // decoder was released, reattach the existing URL instead of leaving
        // the player permanently empty. The net-death guard can relaunch the
        // app later if the browser network stack itself is gone.
        if (currentVideo === cv && !v.currentSrc) {
          try {
            setVideoSource(v, src, { startTime: remuxed ? 0 : t });
            if (!wasPaused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
          } catch (_) {}
        }
      } finally {
        if (currentVideo === cv) v.muted = wasMuted;
        if (currentVideo === cv && nftSeekToken != null && typeof window.__nftEndExternalSeek === 'function') {
          try { window.__nftEndExternalSeek(nftSeekToken); } catch (_) {}
        }
        if (currentVideo === cv && why !== 'pause') { try { setBuffering(false); } catch (_) {} }
        // Report the landing state of EVERY flush, not just the broken ones —
        // without this there is no way to tell a flush that worked from one
        // that quietly wedged the player.
        try {
          window.__bbEvent && window.__bbEvent('rc:flush-done', {
            why, rs: v.readyState, err: v.error ? v.error.code : 0,
            paused: v.paused, t: (v.currentTime || 0) | 0,
          });
        } catch (_) {}
        _rcPlayed = 0; _rcLastAt = performance.now(); _rcBusy = false;
      }
    }
    // NativePlayer's rising-buffer watchdog uses the same safe path. Returning
    // true tells it the request was accepted asynchronously.
    window.__dumiRecycleMedia = (why) => {
      if (_rcBusy || !_rcEligible()) return false;
      _rcFlush(`watchdog:${why}`);
      return true;
    };
    // Opportunistic pause flush. Deferred ~1.2s so it only fires when the pause
    // STICKS — a quick pause-scrub-resume cancels it (via the play handler
    // below), so the reload is never seen; a genuine stepped-away pause hides it
    // completely, and the muted-repaint in _rcFlush means returning shows the
    // frame, not black (the old black-on-pause bug).
    v.addEventListener('pause', () => {
      if (_rcBusy || _rcPlayed < _softThresh()) return;
      if (_pausedFlushTimer) clearTimeout(_pausedFlushTimer);
      _pausedFlushTimer = setTimeout(() => {
        _pausedFlushTimer = null;
        if (v.paused && !_rcBusy) _rcFlush('pause');
      }, 1200);
    });
    v.addEventListener('play', () => {
      if (_pausedFlushTimer) { clearTimeout(_pausedFlushTimer); _pausedFlushTimer = null; }
    });
    // Seek relief: a user seek already tears into a rebuffer, so folding the
    // memory flush into it is invisible. Only when enough has played since the
    // last flush (avoids a flush on every scrub tick). The flush's own internal
    // fastSeek can't re-trigger this — _rcBusy guards re-entry and _rcPlayed
    // resets to 0 right after, so the follow-on 'seeked' sees nothing to do.
    v.addEventListener('seeked', () => {
      // Never on the partial laptop copy: reloading the growing stream costs
      // seconds and competes with the copy; HARD covers long sessions.
      if (currentVideo && currentVideo._growingCache) return;
      if (!_rcBusy && _rcPlayed >= _seekThresh()) _rcFlush('seek');
    });

    // ---- pause-park -----------------------------------------------------
    // A long-paused <video> holds the hardware decoder slot
    // (--max-activated-media-players=1) and its stream buffer. JavaScript
    // cannot inspect native-pipeline health, so after a few minutes of pause
    // release the decoder entirely and remember the position. Resume re-opens
    // the stream there via mediaOption playTime.start, avoiding a separate
    // cold seek that can trigger a decode error. This permits a brief blank
    // frame on resume in exchange for releasing native memory while paused.
    //
    // Remux sessions are excluded: their lifecycle (server-side ffmpeg,
    // rolling window) has its own idle handling, and a park/reload here
    // would strand the session's generation counter.
    const PARK_AFTER_MS = 150000;   // 2.5 min — under the 3-min screensaver delay
    let _parkTimer = null;
    function _parkEligible() {
      return currentVideo && !currentVideo.isLive && !currentVideo.isAudio
        && !currentVideo._directSeedr && !currentVideo._localHandoffPending
        && v.paused && !v.ended && v.currentSrc
        && !(typeof Remux !== 'undefined' && Remux.hasSession());
    }
    function _parkNow() {
      if (!_parkEligible() || currentVideo._parked) return;
      const pos = v.currentTime || 0;
      // dur: the NF overlay's clock falls back to this while the element is
      // released — without it the seek bar zeroes out and every d-pad step
      // clamps into 0..0 until resume (dead seekbar during a long pause).
      currentVideo._parked = { src: currentVideo.src, pos,
                               dur: (isFinite(v.duration) && v.duration > 0) ? v.duration : 0 };
      try { window.__bbEvent && window.__bbEvent('park', { at: pos | 0 }); } catch (_) {}
      try { NativePlayer.stopWatchdog(); } catch (_) {}
      NativePlayer.release(v);
    }
    // Resume from park. Returns true when it consumed the key (callers stop
    // there); false = not parked, caller proceeds with a normal play toggle.
    window.__npResume = function () {
      const cv = currentVideo;
      const p = cv && cv._parked;
      if (!p) return false;
      // No seek gate: parking never happens on Seedr or mid-handoff (see
      // _parkEligible), and p.pos is where playback already was.
      cv._parked = null;
      cv._pendingResume = p.pos;
      cv._handoffClock = { position: p.pos, duration: p.dur };
      try { window.__bbEvent && window.__bbEvent('park:resume', { at: p.pos | 0 }); } catch (_) {}
      setVideoSource(v, p.src, { startTime: p.pos });
      try { NativePlayer.startWatchdog(v); } catch (_) {}
      try { const pr = v.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (_) {}
      return true;
    };
    v.addEventListener('pause', () => {
      clearTimeout(_parkTimer);
      _parkTimer = setTimeout(_parkNow,
        (typeof window.__PARK_MS === 'number') ? window.__PARK_MS : PARK_AFTER_MS);
    });
    v.addEventListener('play', () => { clearTimeout(_parkTimer); _parkTimer = null; });

    // Player chrome is static (declared in index.html, never replaced) — cache
    // the nodes so the per-frame timeupdate handler stops re-querying the DOM.
    const _elBarFill = $('#p-bar-fill'), _elBarThumb = $('#p-bar-thumb'),
          _elTime = $('#p-time'), _elTimeRem = $('#p-time-remaining'),
          _elNextEp = document.getElementById('p-next-ep'),
          _elUpnext = document.getElementById('p-upnext'),
          _elBarBuffer = $('#p-bar-buffer');
    function setBarFromTime() {
      // In remux mode show absolute movie time against the TRUE full duration,
      // not the rolling HLS media-playlist's truncated v.duration.
      const _rmxOn = typeof Remux !== 'undefined' && Remux.hasSession();
      const curAbs = _rmxOn ? Remux.absolute(v.currentTime) : v.currentTime;
      // Total runtime comes from Remux (the true movie length) in remux mode —
      // NOT currentVideo._remux (may be unset) and NOT v.duration (the rolling
      // HLS window). Falls back to v.duration for direct playback.
      const totalDur = (_rmxOn && Remux.duration) ? Remux.duration : (v.duration || 0);
      const pct = isFinite(curAbs) && totalDur > 0
        ? Math.max(0, Math.min(100, (curAbs / totalDur) * 100)) : 0;
      _elBarFill.style.width = pct + '%';
      _elBarThumb.style.left = pct + '%';
      _elTime.textContent = `${fmtTime(curAbs)} / ${fmtTime(totalDur)}`;
      const left = Math.max(0, (totalDur || 0) - curAbs) / (v.playbackRate || 1);
      _elTimeRem.textContent = left > 0 ? `-${fmtTime(left)}` : '';
    }

    // webOS throttles — and near the end often outright stalls — `timeupdate`
    // during HLS playback (the remux stream IS HLS), so a timeupdate-only HUD
    // freezes intermittently: the bar/clock stops moving even though the video
    // plays on. A steady 250 ms ticker keeps them advancing. It defers to the
    // scrub preview (non-null _seekTimer owns the bar during a D-pad seek) and
    // no-ops while paused/seeking/live, so it never fights the other painters.
    let _hudTicker = null;
    function _startHudTicker() {
      if (_hudTicker) return;
      _hudTicker = setInterval(() => {
        if (!v || v.paused || v.seeking || _seekTimer) return;
        if (currentVideo && currentVideo.isLive) return;
        // Legacy HUD is display:none under the TV skin — don't repaint
        // an invisible bar 4x/second for the whole session.
        if (window.__nfActive) return;
        setBarFromTime();
      }, 250);
    }
    function _stopHudTicker() {
      if (_hudTicker) { clearInterval(_hudTicker); _hudTicker = null; }
    }

    v.addEventListener('timeupdate', () => {
      // Live streams: no progress bar (hidden via .is-live), no resume,
      // no episode auto-queue. Skip everything.
      if (currentVideo && currentVideo.isLive) return;
      if (!window.__nfActive) setBarFromTime();   // legacy HUD hidden under nft skin
      // Track played seconds for the pause/seek thresholds. The mid-play
      // backstop defaults to 25 min for direct playback and 8 min for remux/HLS;
      // window.__RC_HARD can override either threshold.
      _rcTrack();
      if (!_rcBusy && _rcPlayed >= _hardThresh()) _rcFlush('hard');
      const now = Date.now();
      if (now - _lastPersist > 15_000) { _lastPersist = now; persistCurrentResume(); }
      const cv = currentVideo;
      // Subtitle preparation has a longer lifecycle than queueing. At the first
      // 60s trigger the next episode usually is NOT cached yet, so prewarm sees
      // a local miss while the queue correctly starts its download. Once that
      // item is marked queued, queue retries stop -- but subtitle retries must
      // continue until the imported file exists and its manifest settles.
      if (cv && cv.show && cv.show.season && !cv._subsPrewarmed
          && !cv._subsPrewarmInFlight && now >= (cv._subsPrewarmRetryAt || 0)
          && v.duration > 0 && v.currentTime >= 60) {
        cv._subsPrewarmRetryAt = now + 60_000;
        prewarmNextEpisodeSubs(cv).catch(() => {});
      }
      // Pre-fetch the next episode EARLY (≈1 min in, once playback is stable),
      // then retry at a bounded cadence until it is genuinely local/queued.
      // Search, engine availability and disk space are all transient; a single
      // failed attempt must not strand the episode for the whole playback.
      // Marked priority when the current stream isn't seedr — then a full seedr
      // gets wiped to make room (safe: nothing we're streaming lives in seedr).
      if (cv && cv.show && cv.show.season && !cv._nextQueued
          && !cv._nextQueueInFlight && now >= (cv._nextPrefetchRetryAt || 0)
          && v.duration > 0 && v.currentTime >= 60) {
        cv._nextPrefetched = true;
        cv._nextPrefetchRetryAt = now + 60_000;
        autoQueueNextEpisode(cv, { priority: cv.source !== 'seedr' }).catch(() => {});
      }
      // Show the "Next ep" skip button in the last 5% (TV episodes only).
      // Hidden during the Up Next auto-advance dialog so we don't have
      // two next-episode CTAs on screen at once.
      const nextBtn = _elNextEp;
      if (nextBtn) {
        const isTvEp = !!(cv && cv.show && cv.show.season && cv.show.episode);
        // Show the Next button for the last 5 minutes of the episode.
        const nearEnd = v.duration > 0 && (v.duration - v.currentTime) <= 300;
        const upnextOpen = !_elUpnext.hidden;
        // The TV player has its own Next-episode pill and owns input.
        const shouldShow = isTvEp && nearEnd && !upnextOpen && !window.__nfActive;
        // Move focus onto it when it appears (so OK triggers it, not play/pause)
        // and hand focus back to play when it hides.
        if (shouldShow && nextBtn.hidden) { nextBtn.hidden = false; try { DPad.focus(nextBtn); } catch (_) {} }
        else if (!shouldShow && !nextBtn.hidden) {
          const wasFocused = nextBtn.classList.contains('is-focused');
          nextBtn.hidden = true;
          if (wasFocused) { const pp = document.getElementById('p-play'); if (pp) { try { DPad.focus(pp); } catch (_) {} } }
        }
      }
      updateSkipButton(v, cv);
    });
    v.addEventListener('progress', () => {
      try {
        if (!v.buffered || !v.buffered.length || !v.duration) return;
        const end = v.buffered.end(v.buffered.length - 1);
        _elBarBuffer.style.width = `${(end / Math.max(v.duration, end)) * 100}%`;
        // Resume seeks deferred from `loadedmetadata` because duration was
        // Infinity at that point: try again now that we have buffered data.
        // In remux mode _pendingResume is ABSOLUTE movie time but v.currentTime
        // is window-relative -- toRelative() converts it (usually to ~0, since
        // the remux already opened AT this position), so we never over-seek
        // past the rolling window. Pass-through for direct playback.
        if (currentVideo
            && !(currentVideo._localHandoffPending && currentVideo._growingCache)
            && Number.isFinite(currentVideo._pendingResume)
            && v.duration && Number.isFinite(v.duration)) {
          const rt = Math.max(0, (typeof Remux !== 'undefined'
            ? Remux.toRelative(currentVideo._pendingResume) : currentVideo._pendingResume));
          if (end > rt) {
            if (resumeSeek(v, rt)) currentVideo._pendingResume = null;
          }
        }
      } catch (_) {}
    });
    // Apply the deferred resume/swap seek on `loadeddata` (first frame actually
    // DECODED) rather than `loadedmetadata` (header only). A blind seek fired at
    // loadedmetadata — before any frame is decoded — is the single most common
    // trigger of a webOS "Decoding error" (code 3), especially on MKV and right
    // after a seedr→local swap. Seeking once the pipeline is warm is far more
    // reliable. The Infinity-duration case (HTTP without Content-Length) still
    // defers to the `progress` handler, which seeks once a finite duration and
    // buffered data exist.
    v.addEventListener('loadeddata', () => {
      if (currentVideo
          && !(currentVideo._localHandoffPending && currentVideo._growingCache)
          && Number.isFinite(currentVideo._pendingResume)
          && v.duration && Number.isFinite(v.duration)) {
        // ABSOLUTE -> window-relative in remux mode (see the 'progress' handler).
        const rt = Math.max(0, (typeof Remux !== 'undefined'
          ? Remux.toRelative(currentVideo._pendingResume) : currentVideo._pendingResume));
        // Skip when mediaOption's playTime.start already opened the decoder at
        // the resume point — seeking to where we already are just risks a cold
        // decode for nothing.
        if (Math.abs((v.currentTime || 0) - rt) <= 5 || resumeSeek(v, rt)) {
          currentVideo._pendingResume = null;
        }
      }
    });
    v.addEventListener('loadedmetadata', () => {
      setBarFromTime();
      // During a remux session the HLS output structurally never carries a
      // text track worth selecting (remux.py maps video+audio only) — but a
      // mid-play session recovery reloads the source, re-fires this event,
      // and a no-winner chooseBestTrack() would clearSubOverlay() away the
      // already-attached external subs for the rest of the episode.
      if (!(typeof Remux !== 'undefined' && Remux.hasSession())) chooseBestTrack(v);
      chooseBestAudioTrack(v);
    });
    // The `addtrack` listeners used to live here, but webOS replaces the
    // TextTrackList / AudioTrackList object on each `v.src` assignment, which
    // orphans listeners attached at boot. They're now wired in openPlayer()
    // against whatever lists exist for the current source, and removed in
    // closePlayer() so they don't leak across sessions.
    v.addEventListener('error', () => {
      // closePlayer() calls v.load() after removeAttribute('src') which
      // fires a synthetic error — we don't want that to retoast or cycle
      // fallbacks on a player that's already gone.
      if (!currentVideo || !$('#player').classList.contains('is-open')) return;
      setBuffering(false);
      const code = v.error ? v.error.code : 0;
      const msg = ({
        1: 'Playback aborted',
        2: 'Network error',
        3: 'Decoding error',
        4: 'Source not supported',
      })[code] || 'Playback failed';
      // Failover: live channels carry a list of alternate stream URLs. Walk
      // it on every error before surrendering — most "Failed to load
      // resource" hits are geo-blocked / stale mirrors and the next URL in
      // the list usually plays.
      if (currentVideo && currentVideo.fallbacks && currentVideo.fallbacks.length) {
        const next = currentVideo.fallbacks.shift();
        pToast(`${msg} — trying mirror ${currentVideo.fallbacks.length === 0 ? 'last' : 'next'}`);
        setBuffering(true);
        // Through setVideoSource, not a bare v.src — live mirrors are mostly
        // HLS and still need the mediaOption transport type + 4K caps.
        try { setVideoSource(v, next); v.play().catch(() => {}); } catch (_) {}
        return;
      }
      // Self-heal VOD network drops instead of dying on a black screen.
      // Seedr URLs are token-signed and expire mid-film — re-fetch a fresh
      // one and resume at the same position. Pen/cache streams survive an
      // file-server restart — re-attach the same URL after a beat.
      // One attempt per playback session so a genuinely dead source still
      // surfaces the error.
      if (currentVideo && !currentVideo.isLive) {
        const cv = currentVideo;
        const pos = v.currentTime || 0;
        // ABSOLUTE movie position for all recovery branches: v.currentTime is
        // window-relative under remux, and _pendingResume is consumed as ABSOLUTE
        // (the resume handlers toRelative() it), so storing a window-relative
        // value there would double-subtract sst and rewind to the window start.
        const absPos = (typeof Remux !== 'undefined' && Remux.hasSession()) ? Remux.absolute(pos) : pos;
        // Seedr self-heal. Token-signed ff_get links are BOTH expirable AND
        // cold-started: the first hit on a freshly-minted link can return a
        // non-video "preparing" response, which webOS reports as code 4
        // (SRC_NOT_SUPPORTED) — NOT a network error. So we retry on both code 2
        // (mid-film token expiry / network drop) and code 4 (cold start / stale
        // link), re-fetching a fresh URL each time. Seedr is usually serving
        // real bytes by the 2nd–3rd attempt; cap the retries so a genuinely
        // dead file still surfaces the error instead of looping forever.
        if (cv.source === 'seedr' && cv._directSeedr !== false && cv.fileId && (code === 2 || code === 4)) {
          const sourceGen = cv._sourceGen;
          const ownsSource = () => currentVideo === cv && cv._sourceGen === sourceGen
            && cv.source === 'seedr' && cv._directSeedr !== false && !cv._localHandoffPending;
          cv._urlRetries = (cv._urlRetries || 0) + 1;
          if (cv._urlRetries <= 4) {
            // A landed local copy beats re-fetching an expiring token — a LAN
            // cache / Drive proxy is more reliable. (This and the seedr re-fetch
            // are the only places we swap the <video> src; the happy path keeps
            // streaming seedr to avoid a black re-buffer.)
            if (cachedPlaybackFile(cv._queueItem, cv)) {
              pToast('Stream dropped — switching to local copy…');
              setBuffering(true);
              swapPlaybackToDrive(cv._queueItem);
              return;
            }
            pToast(cv._urlRetries === 1 ? 'Warming up stream…' : `Reconnecting… (${cv._urlRetries})`);
            setBuffering(true);
            // Brief pause on the first retry lets seedr finish preparing the
            // file; back off further on later attempts.
            const delay = cv._urlRetries === 1 ? 600 : 1800;
            setTimeout(() => {
              if (!ownsSource()) return;
              Seedr.fetchFileUrl(cv.fileId).then(async (u) => {
                if (!u || !ownsSource()) return;
                // Tear down the stale remux session (its ffmpeg's seedr source
                // just expired) and re-enter _maybeRemux with the FRESH URL, so
                // the fresh stream still transcodes (else it swaps to a silent
                // direct DTS stream + leaks the old transcode). No-op when off.
                try { if (typeof Remux !== 'undefined') { Remux.close(); Remux.bindVideo(null); } } catch (_) {}
                cv._remux = null;
                const rmx = cv._queueItem ? { url: u, sess: null }
                  : await _maybeRemux(u, 'seedr', u, absPos > 5 ? absPos : 0);
                if (!ownsSource()) return;
                cv.src = rmx.url;
                cv._remux = rmx.sess;
                cv._pendingResume = rmx.sess ? null : (absPos > 5 ? absPos : null);
                if (typeof Remux !== 'undefined') Remux.bindVideo(rmx.sess ? v : null);
                setVideoSource(v, rmx.url);
                _syncWatchdog(v, cv.isAudio);   // _remux may have just changed above
                v.play().catch(() => {});
              }).catch(() => {});
            }, delay);
            return;
          }
        }
        // Decoding error (code 3) on a VOD source is almost always a seek
        // landing on a cold, mid-GOP offset — worst on MKV and right after a
        // seedr→local swap — NOT a broken file. So recover instead of dying on
        // a black screen: re-attach the source and re-sync to a keyframe-safe
        // point a few seconds BEFORE the failed position (stepping further back
        // each try). If we're still on seedr and a local copy has landed, switch
        // to it — a LAN file re-syncs far more reliably than an expiring token.
        // Bounded per run of failures; the `playing` handler resets the budget
        // on every clean resume so a long session with many skips keeps healing.
        if (code === 3 && cv.src && !cv.isAudio) {
          cv._decodeRetries = (cv._decodeRetries || 0) + 1;
          if (cv._decodeRetries <= 3) {
            if (cv.source === 'seedr' && cachedPlaybackFile(cv._queueItem, cv)) {
              pToast('Re-syncing — switching to local copy…');
              setBuffering(true);
              swapPlaybackToDrive(cv._queueItem);
              return;
            }
            const safe = Math.max(0, absPos - 3 * cv._decodeRetries);
            pToast('Re-syncing video…');
            setBuffering(true);
            setTimeout(() => {
              if (currentVideo !== cv) return;
              cv._pendingResume = safe > 1 ? safe : null;
              setVideoSource(v, cv.src);
              v.play().catch(() => {});
            }, 400);
            return;
          }
        }
        // Pen/cache streams survive an file-server restart — re-attach the
        // same URL once after a beat (network error only; a code-4 here is a
        // genuine codec problem, not worth a retry loop).
        if ((cv.source === 'phone' || cv.source === 'cache') && cv.src
             && code === 2 && !cv._retriedUrl) {
          cv._retriedUrl = true;
          pToast('Stream dropped — reconnecting…');
          setBuffering(true);
          setTimeout(() => {
            if (currentVideo !== cv) return;
            cv._pendingResume = absPos > 5 ? absPos : null;
            setVideoSource(v, cv.src);
            v.play().catch(() => {});
          }, 1500);
          return;
        }
      }
      // A seedr source that STILL errors after 4 fresh-link retries is a
      // seedr-side refusal (their CDN 4xx-ing the file — DMCA-blocked release
      // or traffic cap), not a codec problem. "Source not supported" sent the
      // user chasing formats; say what actually needs doing instead.
      if (currentVideo && currentVideo.source === 'seedr'
          && (code === 2 || code === 4) && (currentVideo._urlRetries || 0) >= 4) {
        pToast('Seedr can’t serve this file — delete it in seedr and re-add the torrent (or pick another release). Press Back to exit');
      } else {
        pToast(`${msg} — press Back to exit`);
      }
      // Keep the overlay up — without this it auto-hides 4.5s after the last
      // user input and the user is left staring at a black fullscreen with
      // no controls and no error context. Cancel the auto-hide timer too.
      overlay.classList.add('is-shown');
      clearTimeout(showOverlay._t);
      DPad.focus($('#p-back'));
    });
    v.addEventListener('waiting', () => {
      setBuffering(true);
      scheduleGrowingWaitNotice(v);
    });
    v.addEventListener('playing', () => {
      cancelGrowingWaitNotice(currentVideo);
      setBuffering(false); setPlayIcon(true);
      _startHudTicker();   // keep the bar/clock moving even when timeupdate stalls
      // Clean resume — reset the decode-recovery budget so later seeks/skips in
      // this same session each get a fresh set of re-sync attempts.
      if (currentVideo) {
        currentVideo._growingSeekTarget = null;
        if (!Number.isFinite(currentVideo._pendingResume) && !v.seeking) currentVideo._handoffClock = null;
        currentVideo._decodeRetries = 0;
        currentVideo._hasPlayed = true;
        if (currentVideo._seedrStartTimer) {
          clearTimeout(currentVideo._seedrStartTimer);
          currentVideo._seedrStartTimer = 0;
        }
      }
    });
    v.addEventListener('canplay', () => {
      cancelGrowingWaitNotice(currentVideo);
      setBuffering(false);
    });
    v.addEventListener('pause', () => {
      setPlayIcon(false);
      _stopHudTicker(); setBarFromTime();   // snap the bar to the exact paused position
      if (currentVideo && currentVideo.isAudio) MusicRemote.publishCurrent();
    });
    v.addEventListener('play', () => {
      setPlayIcon(true);
      if (currentVideo && currentVideo.isAudio) MusicRemote.publishCurrent();
    });
    v.addEventListener('seeked', () => {
      if (currentVideo && !currentVideo._localHandoffPending
          && !Number.isFinite(currentVideo._pendingResume)) currentVideo._handoffClock = null;
      if (currentVideo && currentVideo.isAudio) MusicRemote.publishCurrent();
    });
    v.addEventListener('timeupdate', () => {
      if (currentVideo && currentVideo.isAudio) MusicRemote.publishPositionThrottled();
      // Auto-advance fallback. HLS streams without ENDLIST keep
      // video.duration = Infinity, so we prefer the known track duration
      // from the music-list response (ffprobed by the daemon). Falls
      // back to v.duration when there's no library duration (e.g. the
      // user is somehow playing a non-music HLS stream).
      if (!currentVideo || !currentVideo.isAudio) return;
      if (currentVideo._musicEndFired) return;
      const cur = v.currentTime;
      const liveDur = v.duration;
      const itemDur = (currentVideo._musicItem &&
                       Number(currentVideo._musicItem.duration_s)) || 0;
      const dur = (itemDur > 0) ? itemDur
                : (isFinite(liveDur) && liveDur > 0) ? liveDur
                : 0;
      if (!dur || cur <= 1) return;
      if (dur - cur < 0.4) {
        currentVideo._musicEndFired = true;
        advanceMusic(+1);
      }
    });
    v.addEventListener('ended', () => {
      setPlayIcon(false);
      _stopHudTicker();
      if (currentVideo && currentVideo.isAudio) {
        // Music: walk the playlist. Guard with _musicEndFired to prevent
        // a stale 'ended' event (fired async by the media engine after
        // deadman/timeupdate already advanced to the next track) from
        // skipping the new track.
        if (!currentVideo._musicEndFired) {
          currentVideo._musicEndFired = true;
          advanceMusic(+1);
        }
        return;
      }
      if (currentVideo && currentVideo.show && currentVideo.show.season) {
        maybeShowUpNext();
      } else {
        closePlayer();
      }
    });

    function togglePlay() {
      // Parked (decoder released after a long pause) — resume re-opens the
      // stream at the parked position instead of a doomed v.play().
      if (window.__npResume && window.__npResume()) { showOverlay(); return; }
      if (v.paused) v.play(); else v.pause();
      showOverlay();
    }
    // Optimistic seek with an INSTANT first tap. A lone skip commits
    // immediately (no debounce lag) — a 10s jump stays inside the buffered
    // window, so it's a cheap keyframe seek in both direct and remux mode.
    // Rapid follow-up taps still coalesce: they accumulate during a short
    // window and re-commit the final target once, so three quick +10 taps
    // cause at most one extra decoder reset (to +30) rather than one per tap.
    // Uses HTMLMediaElement.fastSeek() when available — on webOS this snaps to
    // the nearest keyframe (no backward-scan) and is the fastest seek path.
    let _seekDelta = 0;
    let _seekTimer = null;
    let _seekBaseTime = 0;
    // Seek to an ABSOLUTE movie-time target. Direct mode: a plain (fast) seek.
    // Remux mode: Remux.seekAbsolute decides — in-window -> local seek to the
    // relative offset; out-of-window -> the phone restarts the ffmpeg
    // generation at the nearest preceding keyframe and we seek to the exact
    // frame within the new generation. Never blocks healthy playback.
    function _commitSeekAbsolute(absTarget) {
      const duration = _totalDur();
      absTarget = Math.max(0, Math.min((duration || absTarget + 1) - 0.5, absTarget));
      if (blockDirectSeedrSeek(absTarget)) return false;
      // If we were playing, resume after the seek — a remux restart reloads the
      // <video> src (which pauses it), so a large seek/skip would otherwise
      // leave playback stopped.
      const wasPlaying = !v.paused;
      const doSeek = (rel, exact) => {
        try {
          if (exact) v.currentTime = rel;
          else if (typeof v.fastSeek === 'function') v.fastSeek(rel);
          else v.currentTime = rel;
        } catch (_) { try { v.currentTime = rel; } catch (_) {} }
        if (wasPlaying && v.paused) { try { v.play().catch(() => {}); } catch (_) {} }
      };
      if (typeof Remux === 'undefined' || !Remux.hasSession()) {
        doSeek(Math.max(0, Math.min((v.duration || absTarget + 1) - 0.5, absTarget)), false);
        return;
      }
      Remux.seekAbsolute(absTarget).then((r) => {
        const rel = (r && typeof r.relativeTime === 'number')
          ? r.relativeTime : Remux.toRelative(absTarget);
        doSeek(rel, true);
      }).catch((e) => {
        // Leave benign/expected rejections (a closer generation superseded us,
        // no active session) silent — only a genuine SEEK_TIMEOUT_MS trip
        // leaves the user stuck at a stale position with zero feedback.
        if (e && e.code === 'timeout') toast('Seek is taking longer than expected');
      });
    }
    // The true full-movie duration (v.duration is the rolling HLS window in
    // remux mode) and the current ABSOLUTE position.
    function _totalDur() {
      return (typeof Remux !== 'undefined' && Remux.hasSession() && Remux.duration)
        || v.duration || 0;
    }
    function _curAbs() {
      return (typeof Remux !== 'undefined' && Remux.hasSession())
        ? Remux.absolute(v.currentTime || 0) : (v.currentTime || 0);
    }
    function seekBy(s) {
      // Work in ABSOLUTE movie time so a large accumulated seek can jump
      // outside the buffered window (which restarts the generation).
      const wasIdle = !_seekTimer;
      const base = wasIdle ? _curAbs() : _seekBaseTime;
      const delta = wasIdle ? s : _seekDelta + s;
      const dur = _totalDur();
      const want = Math.max(0, dur > 0 ? Math.min(dur, base + delta) : (base + delta));
      if (blockDirectSeedrSeek(want)) return;
      _seekBaseTime = base;
      _seekDelta = delta;
      // Optimistic UI — paint the new absolute position immediately.
      if (dur > 0) {
        if (_elBarFill)  _elBarFill.style.width = `${(want / dur) * 100}%`;
        if (_elBarThumb) _elBarThumb.style.left  = `${(want / dur) * 100}%`;
        if (_elTime)  _elTime.textContent = `${fmtTime(want)} / ${fmtTime(dur)}`;
        if (_elTimeRem) {
          const left = Math.max(0, dur - want) / (v.playbackRate || 1);
          _elTimeRem.textContent = left > 0 ? `-${fmtTime(left)}` : '';
        }
      }
      showSeekIndicator(_seekDelta);
      clearTimeout(_seekTimer);
      if (wasIdle) {
        // Lone tap: commit right away so the video jumps instantly.
        _commitSeekAbsolute(want);
        // Hold a brief coalescing window; if more taps land they accumulate and
        // the branch below re-commits the final target once.
        _seekTimer = setTimeout(() => { _seekTimer = null; _seekDelta = 0; }, 260);
      } else {
        // Rapid follow-up taps: debounce a single final coalesced seek.
        _seekTimer = setTimeout(() => {
          _seekTimer = null;
          const d = _totalDur();
          const finalAbs = Math.max(0, d > 0 ? Math.min(d, _seekBaseTime + _seekDelta)
                                             : (_seekBaseTime + _seekDelta));
          _seekDelta = 0;
          _commitSeekAbsolute(finalAbs);
        }, 160);
      }
    }
    function seekTo(pct) {
      const dur = _totalDur();
      if (!dur) return;
      _commitSeekAbsolute(Math.max(0, Math.min(dur, dur * pct)));
      showOverlay();
    }
    function bumpSpeed(dir) {
      const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
      const i = speeds.findIndex(s => Math.abs(s - v.playbackRate) < 0.01);
      const next = speeds[Math.max(0, Math.min(speeds.length - 1, i + dir))];
      setPlayerRate(v, next);
      pToast(`${next}× speed`);
      showOverlay();
    }

    $('#p-play').onclick = togglePlay;
    $('#p-rew').onclick = () => seekBy(-10);
    $('#p-fwd').onclick = () => seekBy(10);
    $('#p-back').onclick = () => closePlayer();
    // Skip Intro / Recap / Credits — seeks to the target updateSkipButton set.
    const skipBtn = $('#p-skip');
    if (skipBtn) {
      skipBtn.onclick = () => {
        const cv = currentVideo;
        if (!cv || cv._skipTarget == null) return;
        if (blockDirectSeedrSeek(Math.max(0, cv._skipTarget))) return;
        // Mark this mark KIND consumed so updateSkipButton doesn't resurrect
        // the button a beat later just because the post-seek landing spot
        // (remux lands on the preceding keyframe) still reads inside the old
        // window — see updateSkipButton's cv._skipConsumed comment.
        if (cv._skipKind) {
          const consumed = cv._skipConsumed || (cv._skipConsumed = {});
          consumed[cv._skipKind] = true;
        }
        // _skipTarget is ABSOLUTE movie time (intro/recap marks are absolute) —
        // route through the remux-aware seek so a skip past the buffered window
        // restarts the generation at the target keyframe.
        _commitSeekAbsolute(Math.max(0, cv._skipTarget));
        cv._skipTarget = null;
        cv._skipKind = null;
        skipBtn.hidden = true;
        showOverlay();
      };
    }
    // Skip to next episode button (shown in last 5% via timeupdate hook).
    // Reuses the Up Next lookup but bypasses the dialog/timer.
    const nextEpBtn = $('#p-next-ep');
    if (nextEpBtn) {
      nextEpBtn.onclick = async () => {
        const cv = currentVideo;
        if (!cv || !cv.show || !cv.show.season || !cv.show.episode) return;
        nextEpBtn.disabled = true;
        try {
          const next = await findManualNextEpisode(cv);
          if (currentVideo !== cv) return;     // user navigated away
          if (!next) { pToast('No next episode found'); return; }
          cancelUpNext();                       // close any open Up Next prompt
          triggerUpNext(next);
        } catch (e) {
          pToast('Next ep failed: ' + (e.message || e));
        } finally {
          nextEpBtn.disabled = false;
        }
      };
    }
    $('#p-cc').onclick = () => openMenu('subtitles');
    $('#p-audio').onclick = () => openMenu('audio');
    $('#p-speed').onclick = () => openMenu('speed');
    const syncMinus = $('#p-sync-minus'), syncPlus = $('#p-sync-plus');
    if (syncMinus) syncMinus.onclick = () => syncNudge(-0.5);
    if (syncPlus) syncPlus.onclick = () => syncNudge(+0.5);
    const shufBtn = $('#p-shuffle');
    if (shufBtn) {
      shufBtn.onclick = () => {
        setMusicShuffle(!_musicShuffle);
        pToast(_musicShuffle ? 'Shuffle on' : 'Shuffle off');
        showOverlay();
      };
    }
    // Bar click → seek. Bound on the wrap (~30px tall) instead of the bar
    // (~6px) so a magic-cursor click anywhere in the timeline strip seeks
    // — the user shouldn't need pixel-perfect aim.
    const barEl = $('#p-bar');
    $('#p-bar-wrap').onclick = (e) => {
      // DPad fires `el.click()` on Enter, which produces a synthetic
      // MouseEvent with clientX = 0. Ignore those so pressing Enter while the
      // bar is focused doesn't yank the playhead to 0% — only real cursor
      // clicks should seek.
      if (!e.clientX) return;
      const rect = barEl.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      seekTo(Math.max(0, Math.min(1, pct)));
    };

    // Magic cursor / mouse: any pointer activity inside the player wakes
    // the overlay. Without this the LG remote's magic cursor can't reach
    // the top buttons (back / cc / audio / speed) — the overlay auto-hides
    // 4.5s after the last keypress, and pointermove was previously a
    // no-op. Bind on the player container so the listener doesn't leak
    // out of the playback session.
    const playerEl = $('#player');
    const wakeOverlay = () => {
      if (!playerEl.classList.contains('is-open')) return;
      if (activeMenu) return;     // menu has its own focus; don't reset its timer
      showOverlay();
    };
    playerEl.addEventListener('pointermove', wakeOverlay);
    playerEl.addEventListener('mousemove', wakeOverlay);     // older webOS

    // Window-capture listener — fires BEFORE DPad's document-capture handler.
    // We use it for two things:
    //   1. Wake the overlay on the first arrow press (idle player has the
    //      controls at opacity 0, so the user has no visual feedback).
    //   2. Hijack ArrowLeft/Right so they always seek -/+10s in the player,
    //      instead of moving D-pad focus between sibling controls. The big
    //      circular rew/fwd buttons still work via Enter; this just gives
    //      the user a one-press seek that matches every other TV player.
    window.addEventListener('keydown', (e) => {
      if (window.__nfActive) return;          // tv tv-player owns keyboard
      if (!playerEl.classList.contains('is-open')) return;
      if (activeMenu) return;
      if (!_elUpnext.hidden) return;
      const k = e.key;
      // Subtitle-sync mode owns Left/Right → nudge the subs (not seek), so the
      // user can walk the timing while watching. Enter still passes through to
      // DPad so the focused −/+ button clicks.
      if (_syncMode) {
        if (k === 'ArrowLeft')  { e.preventDefault(); e.stopPropagation(); syncNudge(-0.5); return; }
        if (k === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); syncNudge(+0.5); return; }
      }
      // Seek: Arrow Left / Right anywhere in the player. Skipped for live
      // streams — there's nothing to seek to on an HLS live edge, and the
      // bar is hidden anyway.
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        if (currentVideo && currentVideo.isLive) {
          // Let DPad handle nav between top buttons (back / cc / audio).
          showOverlay();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        const step = k === 'ArrowLeft' ? -10 : 10;
        seekBy(step);
        // Side-button seek stays minimal: collapse the full controls so ONLY
        // the seek indicator shows. Don't focus the bar — pulling DPad focus
        // into the (hidden) controls is what was re-summoning the overlay.
        overlay.classList.remove('is-shown');
        clearTimeout(showOverlay._t);
        return;
      }
      // Arrow Up / Down / Enter: just wake the overlay; let DPad handle the
      // actual focus move so navigation between top buttons / center
      // controls / bar still works.
      if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'Enter') {
        showOverlay();   // also resets the auto-hide timer when already shown
      }
    }, true);

    // Player-specific shortcuts. Intentionally do NOT bind ArrowLeft/Right —
    // those are owned by DPad for navigating between the controls. Use the
    // dedicated TV remote media keys (or Enter on a focused rewind/forward
    // button) for seeking.
    document.addEventListener('keydown', (e) => {
      if (!playerEl.classList.contains('is-open')) return;
      if (_syncMode) {
        // Back closes the HUD; swallow the other player shortcuts while it's up
        // so a stray key doesn't seek/toggle behind it. Arrows/Enter are handled
        // by the capture listener + DPad.
        if (e.key === 'Escape' || e.key === 'GoBack' || e.keyCode === 461) {
          closeSyncHud(); e.preventDefault(); e.stopPropagation();
        }
        return;
      }
      if (activeMenu) {
        if (e.key === 'Escape' || e.key === 'GoBack' || e.keyCode === 461) {
          closeMenu(); e.preventDefault(); e.stopPropagation();
        }
        return;
      }
      if (!_elUpnext.hidden) {
        if (e.key === 'Escape' || e.key === 'GoBack' || e.keyCode === 461) {
          cancelUpNext(); e.preventDefault(); e.stopPropagation();
        }
        return;
      }
      switch (e.key) {
        case ' ':
        case 'MediaPlayPause':       e.preventDefault(); togglePlay(); break;
        case 'MediaPause':           e.preventDefault(); v.pause(); break;
        case 'MediaPlay':            e.preventDefault(); v.play(); break;
        case 'MediaStop':            e.preventDefault(); closePlayer(); break;
        case 'MediaFastForward':     e.preventDefault(); seekBy(10); break;
        case 'MediaRewind':          e.preventDefault(); seekBy(-10); break;
        case 'MediaTrackNext':
          e.preventDefault();
          if (currentVideo && currentVideo.isAudio) advanceMusic(+1);
          else seekBy(10);
          break;
        case 'MediaTrackPrevious':
          e.preventDefault();
          if (currentVideo && currentVideo.isAudio) advanceMusic(-1);
          else seekBy(-10);
          break;
        case 'c': case 'C':          openMenu('subtitles'); break;
        case 'a': case 'A':          openMenu('audio'); break;
        case '>':                    bumpSpeed(+1); break;
        case '<':                    bumpSpeed(-1); break;
      }
    });
  }

  // ---------- Settings ----------
  function renderSettings() {
    const sCfg = Storage.get('seedr', {});
    $('#set-email').value = sCfg.email || '';
    $('#set-password').value = sCfg.password ? '********' : '';
    $('#set-status').textContent = Seedr.isLoggedIn()
      ? (sCfg.email ? `Signed in as ${sCfg.email}` : 'Signed in to Seedr')
      : 'Not signed in.';

    $('#set-gd-client').value = Drive.clientId() || '';
    const gdSecret = $('#set-gd-secret');
    if (gdSecret) gdSecret.value = Drive.clientSecret() || '';
    refreshDriveStatus();

    const osInput = $('#set-os-key');
    if (osInput) {
      const saved = OpenSubs.getApiKey();
      osInput.value = saved ? '••••••••••••' + saved.slice(-4) : '';
      $('#set-os-status').textContent = saved
        ? 'API key set — sub fallback active.'
        : 'No API key — sibling subs only.';
    }

    const macInput = $('#set-mac-host');
    if (macInput) {
      const macHost = MacOnTV.host() || '';
      macInput.value = macHost;
      $('#set-mac-status').textContent = macHost
        ? `Configured: ${macHost}` : 'Not configured.';
    }

    renderSaverSettings();
    renderRemuxSettings();
    renderLaptopPlayerSettings();
    renderBluetoothAudioSettings();
  }

  let bluetoothSettingsGeneration = 0;
  let bluetoothSettingsBusy = false;

  function confirmBluetoothDisconnect(device) {
    return new Promise(resolve => {
      const modalEl = $('#modal'), card = $('#modal-card');
      if (!modalEl || !card) { resolve(false); return; }
      const previousFocus = DPad.current();
      let settled = false;
      const finish = confirmed => {
        if (settled) return;
        settled = true;
        modalEl.classList.remove('is-open');
        try { DPad.popBackHandler(); } catch (_) {}
        if (previousFocus && document.body.contains(previousFocus)) {
          setTimeout(() => DPad.focus(previousFocus), 0);
        }
        resolve(confirmed);
      };
      card.innerHTML = `
        <h2>Disconnect Bluetooth audio?</h2>
        <p>DumiFlix will disconnect <strong>${escapeHtml(device.name)}</strong> and the TV will return to its previous sound output.</p>
        <div class="modal-actions">
          <button class="btn" id="bt-disconnect-cancel">Cancel</button>
          <button class="btn btn-primary" id="bt-disconnect-confirm">Disconnect</button>
        </div>`;
      $('#bt-disconnect-cancel').onclick = () => finish(false);
      $('#bt-disconnect-confirm').onclick = () => finish(true);
      DPad.pushBackHandler(() => finish(false));
      modalEl.classList.add('is-open');
      setTimeout(() => DPad.focus($('#bt-disconnect-cancel')), 50);
    });
  }

  async function renderBluetoothAudioSettings(message, focusAddress) {
    const listEl = $('#set-bt-devices');
    const statusEl = $('#set-bt-status');
    const refreshBtn = $('#set-bt-refresh');
    if (!listEl || !statusEl || !refreshBtn || typeof BluetoothAudio === 'undefined') return;

    const generation = ++bluetoothSettingsGeneration;
    refreshBtn.onclick = () => renderBluetoothAudioSettings();
    refreshBtn.disabled = bluetoothSettingsBusy;
    listEl.innerHTML = '<div class="muted">Checking paired devices…</div>';
    statusEl.textContent = message || 'Reading the TV Bluetooth settings…';

    let devices;
    try {
      devices = await BluetoothAudio.list();
    } catch (err) {
      if (generation !== bluetoothSettingsGeneration) return;
      listEl.innerHTML = '<div class="muted">Bluetooth audio is unavailable.</div>';
      statusEl.textContent = err && err.message ? err.message : 'Could not read paired Bluetooth devices.';
      refreshBtn.disabled = false;
      return;
    }
    if (generation !== bluetoothSettingsGeneration) return;

    if (!devices.length) {
      listEl.innerHTML = '<div class="muted">No paired Bluetooth audio devices.</div>';
      statusEl.textContent = 'Pair headphones in the TV Settings app first, then refresh this list.';
      refreshBtn.disabled = false;
      return;
    }

    listEl.innerHTML = devices.map((device, index) => {
      const label = device.state === 'connecting' ? 'Connecting…'
        : device.state === 'disconnecting' ? 'Disconnecting…'
        : device.connected ? 'Disconnect' : 'Connect';
      const disabled = bluetoothSettingsBusy || device.busy ? ' disabled' : '';
      return `<div class="bt-device-row">
        <div class="bt-device-copy">
          <div class="bt-device-name">${escapeHtml(device.name)}</div>
          <div class="bt-device-state${device.connected ? ' is-connected' : ''}">${escapeHtml(device.state)}</div>
        </div>
        <button class="btn${device.connected ? '' : ' btn-primary'}" data-bt-device="${index}"${disabled}>${label}</button>
      </div>`;
    }).join('');

    const connected = devices.filter(device => device.connected);
    statusEl.textContent = message || (connected.length
      ? `TV audio is connected to ${connected.map(device => device.name).join(', ')}.`
      : `${devices.length} paired audio device${devices.length === 1 ? '' : 's'} · none connected.`);
    refreshBtn.disabled = bluetoothSettingsBusy;

    $$('[data-bt-device]').forEach(button => {
      button.onclick = async () => {
        const device = devices[Number(button.dataset.btDevice)];
        if (!device || bluetoothSettingsBusy || device.busy) return;
        if (device.connected && !(await confirmBluetoothDisconnect(device))) return;

        const connecting = !device.connected;
        bluetoothSettingsBusy = true;
        refreshBtn.disabled = true;
        $$('[data-bt-device]').forEach(item => { item.disabled = true; });
        button.textContent = connecting ? 'Connecting…' : 'Disconnecting…';
        statusEl.textContent = `${connecting ? 'Connecting' : 'Disconnecting'} ${device.name}…`;
        try {
          if (connecting) await BluetoothAudio.connect(device.address);
          else await BluetoothAudio.disconnect(device.address);
          await BluetoothAudio.waitForState(device.address, connecting, 18000);
          bluetoothSettingsBusy = false;
          toast(`${device.name} ${connecting ? 'connected' : 'disconnected'}.`);
          await renderBluetoothAudioSettings(null, device.address);
        } catch (err) {
          bluetoothSettingsBusy = false;
          const detail = err && err.message ? err.message : 'Bluetooth request failed.';
          toast(detail, 4200);
          await renderBluetoothAudioSettings(detail, device.address);
        }
      };
    });
    if (focusAddress) {
      const index = devices.findIndex(device =>
        device.address.toLowerCase() === String(focusAddress).toLowerCase());
      const button = index >= 0 ? $(`[data-bt-device="${index}"]`) : null;
      if (button) setTimeout(() => DPad.focus(button), 0);
    }
  }

  // usePhoneRemux is a legacy configuration name for the remux toggle;
  // Remux.enabled()/setEnabled() retain it for stored-data compatibility.
  // Laptop-player (external display / AV receiver) toggle + live status probe.
  function renderLaptopPlayerSettings() {
    const wrap = $('#set-laptop-player');
    if (!wrap) return;
    const chips = $$('#set-laptop-player .chip');
    const statusEl = $('#set-laptop-status');
    const hdmiInput = $('#set-laptop-hdmi-app');
    if (hdmiInput) {
      hdmiInput.value = Storage.get('laptopHdmiApp', '');
      hdmiInput.onchange = () => Storage.set('laptopHdmiApp', hdmiInput.value.trim());
    }
    const paint = () => chips.forEach(c =>
      c.classList.toggle('is-active', c.dataset.v === (laptopPlayerOn() ? 'on' : 'off')));
    chips.forEach(ch => ch.onclick = () => {
      try { Storage.set('laptopPlayer', ch.dataset.v === 'on'); } catch (_) {}
      paint();
    });
    paint();
    if (statusEl && typeof LaptopCache !== 'undefined' && LaptopCache.playerStatus) {
      statusEl.textContent = 'Checking laptop…';
      LaptopCache.playerStatus().then(st => {
        if (!st || st.ok === false) {
          statusEl.textContent = 'Laptop player unreachable — plays fall back to the TV.';
        } else if (st.running) {
          statusEl.textContent = `Playing: ${st.title || st.rel || ''} · ${st.audioCodec || ''}${st.aoFormat === 'spdif' ? ' (bitstream)' : ''}`;
        } else {
          statusEl.textContent = 'Laptop ready · idle. Phone remote: http://<laptop>:9891/remote?token=…';
        }
      }).catch(() => { statusEl.textContent = 'Laptop player unreachable — plays fall back to the TV.'; });
    }
  }

  function renderRemuxSettings() {
    const enabledEl = $('#set-remux-enabled');
    if (!enabledEl || typeof Remux === 'undefined') return;
    const statusEl = $('#set-remux-status');
    const chips = $$('#set-remux-enabled .chip');
    const engineChips = $$('#set-remux-engine .chip');
    const markOn = on => chips.forEach(c =>
      c.classList.toggle('is-active', c.dataset.v === (on ? 'on' : 'off')));
    const markEngine = e => engineChips.forEach(c =>
      c.classList.toggle('is-active', c.dataset.v === e));
    const paint = () => {
      const on = Remux.enabled();
      const eng = Remux.engine();
      markOn(on);
      markEngine(eng);
      if (!statusEl) return;
      if (!NORMAL_PLAYBACK_REMUX_ALLOWED) {
        statusEl.textContent = 'Direct playback · remuxing is unavailable in this build';
        return;
      }
      if (!on) { statusEl.textContent = 'Direct only · remux is disabled for production playback'; return; }
      if (eng === 'tv') {
        statusEl.textContent = 'On · TV engine (on-TV ffmpeg, no phone needed) · applies to the next video';
      } else {
        // eng === 'laptop' — the other valid engine in Remux._validEngine.
        statusEl.textContent = 'On · Laptop engine'
          + (Remux.laptopHost() ? ` · ${Remux.laptopHost()} · applies to the next video` : ' · set the laptop host below first');
      }
    };
    // Laptop host + token inputs (persist on change; the switch above picks the engine).
    const laptopHostEl = $('#set-remux-laptop-host');
    const laptopTokEl = $('#set-remux-laptop-token');
    if (laptopHostEl) {
      laptopHostEl.value = Remux.laptopHost() || '';
      laptopHostEl.onchange = () => { Remux.setLaptopHost(laptopHostEl.value); paint(); };
    }
    if (laptopTokEl) {
      try { laptopTokEl.value = Storage.get('remux.laptopToken', '') || ''; } catch (_) {}
      laptopTokEl.onchange = () => { try { Storage.set('remux.laptopToken', (laptopTokEl.value || '').trim()); } catch (_) {} };
    }
    chips.forEach(ch => ch.onclick = () => {
      if (ch.dataset.v === 'on') {
        Remux.setEnabled(false);
        toast('Remux is disabled — DumiFlix plays the original file directly.');
      } else {
        Remux.setEnabled(false);
      }
      paint();
    });
    engineChips.forEach(ch => ch.onclick = () => { Remux.setEngine(ch.dataset.v); paint(); });
    paint();
  }

  // Idle-screensaver controls (on/off, scene set, idle delay, preview). Chips
  // are static HTML; this paints the active state and (re)wires the clicks —
  // idempotent, so it's safe to call on every Settings open. The chip node
  // lists are queried once per call (not once per paint) since they're
  // static — repeated chip clicks reuse the cached arrays instead of
  // re-querying the DOM each time.
  function renderSaverSettings() {
    const enabledEl = $('#set-saver-enabled');
    if (!enabledEl) return;
    const DEF = { enabled: true, mode: 'mix', delayMs: 180000 };
    const statusEl = $('#set-saver-status');
    const enabledChips = $$('#set-saver-enabled .chip');
    const modeChips = $$('#set-saver-mode .chip');
    const delayChips = $$('#set-saver-delay .chip');
    const cur = () => Object.assign({}, DEF, Storage.get('screensaver', {}) || {});
    const mark = (chips, val) => chips
      .forEach(c => c.classList.toggle('is-active', c.dataset.v === String(val)));
    const paint = () => {
      const c = cur();
      mark(enabledChips, c.enabled ? 'on' : 'off');
      mark(modeChips, c.mode);
      mark(delayChips, c.delayMs);
      const scene = c.mode === 'fire' ? 'fireplace'
                  : c.mode === 'rain' ? 'rain & cozy' : 'fireplace + rain';
      const idle = `after ${Math.round(c.delayMs / 60000)} min idle`;
      if (!c.enabled) { statusEl.textContent = 'Off'; return; }
      statusEl.textContent = `On · ${idle} · checking local videos…`;
      // Show the available local source, with public stock clips as fallback.
      Screensaver.probeSources().then(n => {
        const src = n.local ? `${n.local} local video${n.local === 1 ? '' : 's'}`
                  : `${scene} stock loops`;
        statusEl.textContent = `On · ${src} · ${idle}`;
      }).catch(() => { statusEl.textContent = `On · ${idle}`; });
    };
    const save = patch => { Storage.set('screensaver', Object.assign(cur(), patch)); paint(); };
    enabledChips.forEach(ch => ch.onclick = () => {
      const on = ch.dataset.v === 'on';
      if (!on) Screensaver.stop();
      save({ enabled: on });
    });
    modeChips.forEach(ch => ch.onclick = () => save({ mode: ch.dataset.v }));
    delayChips.forEach(ch => ch.onclick = () => save({ delayMs: parseInt(ch.dataset.v, 10) }));
    const prev = $('#set-saver-preview');
    if (prev) prev.onclick = () => Screensaver.preview();
    paint();
  }

  async function refreshDriveStatus() {
    const list = $('#storage-list');
    list.innerHTML = '<div class="muted" style="margin-top:12px;">Scanning…</div>';
    if (!Drive.isSignedIn()) {
      list.innerHTML = '<div class="muted" style="margin-top:12px;">Not signed in to Google Drive. Paste your OAuth client ID and tap Sign in.</div>';
      return;
    }
    try {
      const q = await Drive.quota();
      const usedPct = q.total ? ((q.total - q.free) / q.total) * 100 : 0;
      list.innerHTML = `
        <div class="storage-row">
          <div><strong>Google Drive</strong> <span class="muted">${escapeHtml(q.email || '')}</span></div>
          <div class="muted">${fmtSize(q.free)} free of ${fmtSize(q.total)} (${usedPct.toFixed(0)}% used)</div>
          <div class="muted" style="margin-top:6px;">Files saved to <code>${escapeHtml(Drive.rootFolderName())}</code></div>
          <div class="q-bar" style="margin-top:10px;"><div class="q-bar-fill" style="width:${usedPct}%;"></div></div>
        </div>
      `;
    } catch (e) {
      list.innerHTML = `<div class="muted" style="margin-top:12px;">Drive error: ${escapeHtml(e.message)}.</div>`;
    }
  }

  let _signInPoll = null;
  async function startDriveSignIn() {
    const clientId = $('#set-gd-client').value.trim();
    const secretInput = $('#set-gd-secret');
    const clientSecret = secretInput ? secretInput.value.trim() : '';
    if (!clientId || !clientSecret) { toast('Paste the Google OAuth client ID and secret first'); return; }
    Drive.setClientId(clientId);
    Drive.setClientSecret(clientSecret);
    $('#set-gd-status').textContent = 'Requesting code…';
    let dev;
    try { dev = await Drive.startSignIn(); }
    catch (e) { $('#set-gd-status').textContent = 'Error: ' + e.message; return; }
    const html = `
      <div style="margin-top:8px;">
        <div>1. On your phone or laptop, open <strong>${escapeHtml(dev.verification_url)}</strong></div>
        <div>2. Enter this code: <strong style="font-size:32px;letter-spacing:4px;">${escapeHtml(dev.user_code)}</strong></div>
        <div class="muted" style="margin-top:8px;">Waiting for you to authorize…</div>
      </div>`;
    $('#set-gd-status').innerHTML = html;
    if (_signInPoll) _signInPoll.cancelled = true;
    const poll = _signInPoll = { cancelled: false };
    try {
      await Drive.pollSignIn(dev.device_code, dev.interval, dev.expires_in);
      if (poll.cancelled) return;
      $('#set-gd-status').textContent = 'Signed in.';
      try { await Drive.armProxy(); } catch (_) {}
      refreshDriveStatus();
    } catch (e) {
      if (poll.cancelled) return;
      $('#set-gd-status').textContent = 'Sign-in failed: ' + e.message;
    }
  }

  function bindSettings() {
    // Hoisted so click handlers below never rebuild a RegExp per click.
    const RE_MASKED_VALUE = /^•/;

    $('#set-login').onclick = async () => {
      const email = $('#set-email').value.trim();
      const pwInput = $('#set-password').value;
      const cfg = Storage.get('seedr', {});
      const password = (pwInput && pwInput !== '********') ? pwInput : cfg.password;
      if (!email || !password) { toast('Email and password required'); return; }
      $('#set-status').textContent = 'Signing in…';
      try {
        await Seedr.login(email, password);
        $('#set-status').textContent = `Signed in as ${email}`;
        toast('Signed in');
      } catch (e) {
        $('#set-status').textContent = 'Sign-in failed: ' + e.message;
      }
    };
    const wipeBtn = $('#set-seedr-wipe');
    if (wipeBtn) {
      wipeBtn.onclick = async () => {
        if (!Seedr.isLoggedIn()) { toast('Not signed in to seedr'); return; }
        wipeBtn.disabled = true;
        const prevText = wipeBtn.textContent;
        wipeBtn.textContent = 'Wiping…';
        try {
          await Seedr.clean();
          // Detach every queue item from its now-vanished seedr folder.
          // Items that didn't make it to Drive get marked 'error' so the
          // user can hit Retry and re-send the magnet; items already on
          // Drive are untouched (Drive copy is what matters).
          let mutated = 0;
          for (const it of queue) {
            if (it.folderId) {
              it.folderId = null;
              if (it.phase !== 'drive-ready' && it.phase !== 'cloud-ready') {
                it.phase = 'error';
                it.error = 'seedr wiped — tap retry';
              }
              mutated++;
            }
          }
          if (mutated) { persistQueue(); renderQueue(); }
          // Pending items can now grab the slot.
          promoteNextPending();
          toast('Seedr wiped');
        } catch (e) {
          toast('Wipe failed: ' + (e.message || e));
        } finally {
          wipeBtn.disabled = false;
          wipeBtn.textContent = prevText;
        }
      };
    }
    // --- TMDB key settings ---
    const tmdbInput = $('#set-tmdb-key');
    const tmdbStatus = $('#set-tmdb-status');
    if (tmdbInput) {
      const override = (function(){
        try { return localStorage.getItem('dumiflix.tmdb.v1') || ''; }
        catch (_) { return ''; }
      })();
      tmdbInput.value = '';
      if (override) {
        tmdbInput.placeholder = `Override saved: ${override.slice(0, 6)}…${override.slice(-4)}`;
        tmdbStatus.textContent = 'Using your TMDB key.';
      } else {
        tmdbInput.placeholder = 'TMDB API read access token or v3 key';
        tmdbStatus.textContent = 'No TMDB key set. Paste yours above + Save to show trending rows.';
      }
    }
    const tmdbSave = $('#set-tmdb-save');
    if (tmdbSave) {
      tmdbSave.onclick = () => {
        const v = (tmdbInput.value || '').trim();
        if (!v) { tmdbStatus.textContent = 'Paste a key first.'; return; }
        TMDB.setKey(v);
        TMDB.clearCache();
        tmdbInput.value = '';
        tmdbInput.placeholder = `Saved: ${v.slice(0, 6)}…${v.slice(-4)}`;
        tmdbStatus.textContent = 'Saved. Reopen Home to see trending rows.';
      };
    }
    const tmdbClear = $('#set-tmdb-clear');
    if (tmdbClear) {
      tmdbClear.onclick = () => {
        TMDB.setKey('');             // removes the saved key; trending rows hide
        TMDB.clearCache();
        tmdbInput.placeholder = 'TMDB API read access token or v3 key';
        tmdbStatus.textContent = 'Key cleared. Trending rows are off until you add one.';
      };
    }
    const tmdbTest = $('#set-tmdb-test');
    if (tmdbTest) {
      tmdbTest.onclick = async () => {
        const before = TMDB.getKey();
        const typed = (tmdbInput.value || '').trim();
        if (typed) TMDB.setKey(typed);
        if (!TMDB.hasKey()) { tmdbStatus.textContent = 'No key to test.'; return; }
        tmdbTest.disabled = true;
        tmdbStatus.textContent = 'Testing…';
        try {
          const r = await TMDB.trendingMovies(3);
          tmdbStatus.textContent = `OK — ${r.length} trending movies fetched`
            + (r[0] ? ` (top: ${r[0].title})` : '');
        } catch (e) {
          tmdbStatus.textContent = 'Failed: ' + (e.message || e);
          if (typed && !before) TMDB.setKey('');
        } finally {
          tmdbTest.disabled = false;
        }
      };
    }

    $('#set-gd-signin').onclick = startDriveSignIn;
    $('#set-gd-signout').onclick = () => {
      Drive.signOut();
      renderSettings();
      toast('Signed out of Drive');
    };
    $('#storage-refresh').onclick = refreshDriveStatus;

    const reattach = $('#set-gd-reattach');
    if (reattach) {
      reattach.onclick = async () => {
        if (!Drive.isSignedIn()) { toast('Sign in to Drive first'); return; }
        reattach.disabled = true;
        const prev = reattach.textContent;
        reattach.textContent = 'Searching…';
        try {
          const candidates = await Drive.findExistingRoots();
          if (!candidates.length) {
            toast('No existing folder found in Drive root');
            return;
          }
          const winner = candidates[0];
          if (winner.count === 0) {
            // Pick the bare folder anyway, but say so.
            await Drive.reattachToFolder(winner.name, winner.id);
            toast(`Pointed at ${winner.name} (empty)`);
          } else {
            await Drive.reattachToFolder(winner.name, winner.id);
            toast(`Reattached to ${winner.name} — ${winner.count} files`);
          }
          // Drop the cached listing — it belongs to the old folder.
          Storage.clear(LIB_CACHE_KEY);
          renderSettings();
          // Force the Library to re-read from the new root.
          if (typeof renderLibrary === 'function') renderLibrary();
        } catch (e) {
          toast('Reattach failed: ' + (e.message || e));
        } finally {
          reattach.disabled = false;
          reattach.textContent = prev;
        }
      };
    }

    const osSave = $('#set-os-save');
    if (osSave) {
      osSave.onclick = () => {
        const v = $('#set-os-key').value.trim();
        // Skip the masked-display value (••••XXXX) — only save real input.
        if (v && !RE_MASKED_VALUE.test(v)) OpenSubs.setApiKey(v);
        $('#set-os-status').textContent = OpenSubs.hasApiKey()
          ? 'API key saved — sub fallback active.'
          : 'No API key — sibling subs only.';
        toast(OpenSubs.hasApiKey() ? 'OpenSubs key saved' : 'OpenSubs key cleared');
      };
    }
    const osClear = $('#set-os-clear');
    if (osClear) {
      osClear.onclick = () => {
        OpenSubs.setApiKey('');
        $('#set-os-key').value = '';
        $('#set-os-status').textContent = 'No API key — sibling subs only.';
        toast('OpenSubs key cleared');
      };
    }

    // Phone host (Files tab + file server)
    {
      const inp = $('#set-phone-host');
      if (inp && Phone.hasHost()) inp.value = Phone.host();
      const save = $('#set-phone-save');
      if (save) {
        save.onclick = () => {
          const v = $('#set-phone-host').value.trim();
          Phone.setHost(v);
          $('#set-phone-status').textContent = Phone.hasHost()
            ? `Saved: ${Phone.host()}` : 'Cleared.';
        };
      }
      const test = $('#set-phone-test');
      if (test) {
        test.onclick = async () => {
          const typed = $('#set-phone-host').value.trim();
          if (typed) Phone.setHost(typed);
          if (!Phone.hasHost()) { toast('Enter a host first'); return; }
          $('#set-phone-status').textContent = 'Testing…';
          try {
            const h = await Phone.health();
            const mount = h.files_root_mounted ? '✓ HDD mounted' : '✗ HDD NOT mounted';
            $('#set-phone-status').textContent = `OK — ${mount} at ${h.files_root}`;
          } catch (e) {
            $('#set-phone-status').textContent = 'Failed: ' + (e.message || e);
          }
        };
      }
    }

    const macSave = $('#set-mac-save');
    if (macSave) {
      macSave.onclick = () => {
        const v = $('#set-mac-host').value.trim();
        MacOnTV.setHost(v);
        $('#set-mac-status').textContent = MacOnTV.hasHost()
          ? `Saved: ${MacOnTV.host()}` : 'Cleared.';
        toast(MacOnTV.hasHost() ? 'Media relay host saved' : 'Media relay host cleared');
      };
    }
    const macTest = $('#set-mac-test');
    if (macTest) {
      macTest.onclick = async () => {
        // Allow testing with the just-typed value even before Save.
        const typed = $('#set-mac-host').value.trim();
        if (typed) MacOnTV.setHost(typed);
        if (!MacOnTV.hasHost()) { toast('Enter a host first'); return; }
        $('#set-mac-status').textContent = 'Testing…';
        try {
          const h = await MacOnTV.health();
          $('#set-mac-status').textContent =
            `OK — qBittorrent ${h.qbt_reachable ? 'reachable' : 'NOT reachable'} · downloads → ${h.download_dir}`;
        } catch (e) {
          $('#set-mac-status').textContent = 'Failed: ' + (e.message || e);
        }
      };
    }
    const macDetect = $('#set-mac-detect');
    if (macDetect) {
      macDetect.onclick = async () => {
        $('#set-mac-status').textContent = 'Scanning LAN for the daemon…';
        try {
          const host = await MacOnTV.discover();
          $('#set-mac-host').value = host;
          $('#set-mac-status').textContent = `Found: ${host}`;
          toast('Media relay host auto-detected: ' + host);
        } catch (e) {
          $('#set-mac-status').textContent = 'Auto-detect failed: ' + (e.message || e);
        }
      };
    }

    // YouTube Music (Phase 0 spike — cookies + test call)
    const ytmFields = {
      '__Secure-3PSID':    '#set-ytm-3psid',
      '__Secure-3PAPISID': '#set-ytm-3papisid',
      'SAPISID':           '#set-ytm-sapisid',
      'HSID':              '#set-ytm-hsid',
      'SSID':              '#set-ytm-ssid',
    };
    const ytmStatus = $('#set-ytm-status');
    // Pre-fill from storage so a returning user sees their values populated.
    {
      const saved = YTMusic.getCookies() || {};
      for (const [k, sel] of Object.entries(ytmFields)) {
        const el = $(sel);
        if (el && saved[k]) el.value = saved[k];
      }
    }
    if ($('#set-ytm-save')) {
      $('#set-ytm-save').onclick = () => {
        const cookies = {};
        for (const [k, sel] of Object.entries(ytmFields)) {
          const v = ($(sel) && $(sel).value || '').trim();
          if (v) cookies[k] = v;
        }
        const missing = YTMusic.COOKIE_KEYS.filter(k => !cookies[k]);
        YTMusic.setCookies(cookies);
        ytmStatus.textContent = missing.length
          ? `Saved (${Object.keys(cookies).length}/5). Missing: ${missing.join(', ')}`
          : `Saved all 5 cookies.`;
      };
    }
    if ($('#set-ytm-clear')) {
      $('#set-ytm-clear').onclick = () => {
        YTMusic.clearCookies();
        Object.values(ytmFields).forEach(sel => { const el = $(sel); if (el) el.value = ''; });
        ytmStatus.textContent = 'Cleared.';
      };
    }
    if ($('#set-ytm-test')) {
      $('#set-ytm-test').onclick = async () => {
        ytmStatus.textContent = 'Testing… (may take a few seconds)';
        try {
          const report = await YTMusic.test();
          ytmStatus.textContent = report;
        } catch (e) {
          ytmStatus.textContent = 'Test crashed: ' + (e && e.message ? e.message : String(e));
        }
      };
    }
  }

  // ---------- Global back ----------
  function globalBack() {
    if ($('#modal').classList.contains('is-open')) { closeModal(); return; }
    if ($('#player').classList.contains('is-open')) { closePlayer(); return; }
    if (currentTab !== 'home') { showTab('home'); return; }
  }

  function bindNav() {
    $$('.nav-item').forEach(n => {
      n.addEventListener('click', () => showTab(n.dataset.tab));
    });
    $('#search-go').onclick = runSearch;
    $('#search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); hideSuggest(); runSearch(); return; }
      // DPad ignores arrows inside inputs (caret nav), so hop into the
      // suggestion list ourselves when the user presses Down.
      if (e.key === 'ArrowDown') {
        const first = document.querySelector('#search-suggest:not([hidden]) .suggest-row');
        if (first) { e.preventDefault(); DPad.focus(first); }
      }
    });
    $('#search-input').addEventListener('input', onSearchInput);
    const liveRefresh = $('#live-refresh');
    if (liveRefresh) {
      // Single button now covers both Live sources — branches on the
      // live-source toggle; neither refresh body's internals changed.
      liveRefresh.onclick = async () => {
        if (liveSource === 'intl') {
          releaseInternational();
          const req = _intlLoadSeq;
          $('#intl-status').textContent = 'Refreshing channels…';
          try { await IPTV.fetchAll({ force: true }); }
          catch (_) {}
          if (req !== _intlLoadSeq || currentTab !== 'live' || liveSource !== 'intl') return;
          renderInternational();
        } else {
          _liveCache = null;
          $('#live-status').textContent = 'Refreshing channels…';
          try { await LiveTV.fetchChannels({ force: true }); }
          catch (_) {}
          renderLive();
        }
      };
    }
  }

  // Update the global hero background + (on Home) the hero title/summary
  // whenever focus lands on a tile. DPad uses class-based focus, so we
  // listen to its custom `dpad-focus` event instead of `focusin`.
  function bindBackgroundTracker() {
    const onFocusMove = (target) => {
      const tile = target.closest && target.closest('.tile');
      if (!tile) return;
      const poster = tile.querySelector('.tile-poster');
      if (poster) {
        const img = poster.style.backgroundImage;
        if (img && img !== 'none') {
          $('#bg').style.backgroundImage = img;
        }
      }
      if (currentTab === 'home') {
        const t = tile.dataset.heroTitle;
        const s = tile.dataset.heroSubtitle;
        if (t) $('#hero-title').textContent = t;
        if (s !== undefined) $('#hero-summary').textContent = s || '';
        // Hero Play/Info should act on the currently-focused tile.
        $('#hero-play').onclick = () => tile.click();
        $('#hero-info').onclick = () => tile.click();
      }
    };
    document.addEventListener('dpad-focus', (e) => onFocusMove(e.target));
    document.addEventListener('focusin', (e) => onFocusMove(e.target));
  }

  // ---------- Boot intent ----------
  // Consume launch intents from an external automation through the configured
  // companion service. Its /intent endpoint clears on read so a consumed
  // request cannot replay on a later boot. 'play-music' is the protocol kind.
  async function consumeBootIntent() {
    if (!MacOnTV.hasHost()) {
      // Auto-discovery is best-effort; if there's no daemon on the LAN the
      // intent simply never arrives — fine.
      try { await MacOnTV.discover(); } catch (_) { return; }
    }
    const intent = await MacOnTV.fetchIntent();
    if (!intent) return;
    if (intent.kind === 'play-music') {
      await consumePlayMusicIntent(intent.args || {});
    }
  }

  // Pick a starting track and hand it to the music player. With no folder
  // filter we draw from the whole library; with one we scope to that
  // top-level subfolder (matches the Music tab's drill-in semantics).
  // Shuffle defaults on — the Music tab's persistent shuffle preference is
  // updated to match so the user sees the toggle reflect what's happening.
  async function consumePlayMusicIntent(args) {
    let list = [];
    try { list = await MacOnTV.music(); } catch (_) { return; }
    if (!list.length) return;
    if (args.folder) {
      const prefix = String(args.folder).toLowerCase() + '/';
      list = list.filter(m => (m.path || '').toLowerCase().startsWith(prefix));
      if (!list.length) return;
    }
    const shuffle = args.shuffle !== false;
    if (shuffle !== _musicShuffle) setMusicShuffle(shuffle);
    const start = shuffle
      ? list[Math.floor(Math.random() * list.length)]
      : list[0];
    showTab('music');
    playMusicFile(start, list);
  }

  // ---------- Idle screensaver ----------
  // After a few minutes of no remote input on a resting screen (no player, no
  // music), fade in a looping ambient video — a fireplace or a
  // rainy window — streamed on demand from Mixkit's CDN. The FIRST key press
  // dismisses it and is swallowed so it doesn't also act on the app underneath.
  // Purely cosmetic; gated so it never appears over playback.
  const Screensaver = (() => {
    const BASE = 'https://assets.mixkit.co/videos';
    // Fallback only — short verified 720p loops used when no proper videos have
    // been downloaded to the phone yet (or the phone is unreachable).
    const CLIPS = {
      fire: [22834, 30252, 1242, 25027, 2709, 22833, 48497, 42782, 42781],
      rain: [2846, 4331, 4332, 4422, 2716, 18312],
    };
    const LOCAL_DIR = 'Ambient';   // folder of downloaded cozy loops on the pen drive
    const DEFAULTS = { enabled: true, mode: 'mix', delayMs: 180000 };
    const ROTATE_MS = 480000;   // drift to a fresh scene every ~8 min of idling
    // Hoisted so `refreshLocal` (re-run every 5 min by localTimer) never
    // recompiles the same RegExp literal on each pass.
    const AMBIENT_FILE_RE = /\.(mp4|m4v|webm|mkv|mov)$/i;

    let overlay = null, video = null;
    let last = Date.now();
    let pollTimer = null, rotTimer = null, localTimer = null;
    let active = false, forced = false;
    let queue = [], qi = 0, fails = 0;
    let localUrls = [];

    function cfg() { return Object.assign({}, DEFAULTS, Storage.get('screensaver', {}) || {}); }
    function mixkitUrl(id) { return `${BASE}/${id}/${id}-720.mp4`; }

    // Local ambient videos: files in the configured server's Ambient folder. These
    // win over the Mixkit fallback whenever the phone is reachable and the folder
    // has files. Refreshed on boot and every few minutes so newly-added videos
    // appear without a restart.
    async function refreshLocal() {
      try {
        if (typeof Phone === 'undefined' || !Phone.hasHost()) { localUrls = []; return; }
        const listing = await Phone.listFiles(LOCAL_DIR);
        const files = ((listing && listing.entries) || [])
          .filter(e => e.type === 'file' && AMBIENT_FILE_RE.test(e.name));
        localUrls = files.map(e => Phone.streamUrl(LOCAL_DIR + '/' + e.name));
      } catch (_) { localUrls = []; }
    }

    function shuffle(a) {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }

    function build() {
      if (overlay) return;
      overlay = document.createElement('div');
      overlay.className = 'dumi-saver';
      overlay.hidden = true;
      video = document.createElement('video');
      video.className = 'dumi-saver-video';
      video.loop = true;
      video.setAttribute('playsinline', '');
      overlay.appendChild(video);
      const hint = document.createElement('div');
      hint.className = 'dumi-saver-hint';
      hint.textContent = 'Press any key to resume';
      overlay.appendChild(hint);
      document.body.appendChild(overlay);
      video.addEventListener('error', onClipError);
    }

    function makeQueue() {
      let urls;
      if (localUrls.length) {
        urls = localUrls.slice();               // downloaded ambient videos on the pen
      } else {
        const c = cfg();
        const ids = c.mode === 'fire' ? CLIPS.fire.slice()
                  : c.mode === 'rain' ? CLIPS.rain.slice()
                  : CLIPS.fire.concat(CLIPS.rain);
        urls = ids.map(mixkitUrl);              // last resort: short Mixkit loops
      }
      queue = shuffle(urls); qi = 0;
    }

    function playCurrent() {
      if (!queue.length) return;
      try {
        const url = queue[qi % queue.length];
        // Through the webOS mediaOption path, NOT a bare video.src: the bare
        // path may buffer by time without a memory bound. Local clips can
        // include high-bitrate 4K files, so long idle sessions need the same
        // native-memory protection as movie playback. URI transport bounds
        // buffering, and limiting resolution to 1920x1080 keeps ambient
        // playback within the budget of constrained webOS devices.
        video.querySelectorAll('source').forEach(s => s.remove());
        video.removeAttribute('src');
        const mo = { mediaTransportType: 'URI',
                     option: { adaptiveStreaming: { maxWidth: 1920, maxHeight: 1080 } } };
        const s = document.createElement('source');
        s.setAttribute('src', url);
        s.setAttribute('type', 'video/mp4;mediaOption=' + escape(JSON.stringify(mo)));
        // A failed <source> fires 'error' on the SOURCE element, not the
        // media element — without this a dead clip URL is a silent black
        // screen instead of a hop to the next clip.
        s.addEventListener('error', onClipError);
        video.appendChild(s);
        video.load();
        const p = video.play();
        if (p && p.catch) p.catch(() => {});
      } catch (_) {}
    }
    function nextClip() {
      if (!active) return;
      // Never rotate onto a fresh 4K clip if real playback somehow started
      // underneath us — bail out entirely instead.
      if (mediaBusy()) { stop(); return; }
      qi++; playCurrent();
    }

    // TRUE when any real media element (movie, live TV, music,
    // phone-cast…) is actively playing. The saver must never run — or keep
    // running — over one: a hidden second 4K decode can exhaust device memory.
    function mediaBusy() {
      const els = document.querySelectorAll('video, audio');
      for (let i = 0; i < els.length; i++) {
        const m = els[i];
        if (m === video) continue;
        if (m.currentSrc && !m.paused && !m.ended) return true;
      }
      return false;
    }

    function onClipError() {
      if (!active) return;
      // A dead URL / no internet → hop to the next clip; give up after a few
      // so we never sit on a black screen forever (retries on the next idle).
      if (++fails > 4) { stop(); return; }
      nextClip();
    }

    function canStart() {
      if (active) return false;
      if (window.__nfActive) return false;                 // nft player owns the screen
      if (currentVideo) return false;                      // something is playing
      if (mediaBusy()) return false;                       // any live media element (music, live TV…)
      const player = document.getElementById('player');
      if (player && player.classList.contains('is-open')) return false;
      return true;
    }

    function start(force) {
      if (!force && !cfg().enabled) return;
      if (!canStart()) return;
      build();
      active = true; forced = !!force; fails = 0;
      makeQueue();
      overlay.hidden = false;
      requestAnimationFrame(() => overlay.classList.add('is-on'));
      playCurrent();
      clearInterval(rotTimer);
      rotTimer = setInterval(nextClip, ROTATE_MS);
    }

    function stop() {
      if (!active) return;
      active = false; forced = false; last = Date.now();
      clearInterval(rotTimer); rotTimer = null;
      if (!overlay) return;
      overlay.classList.remove('is-on');
      setTimeout(() => {
        if (active) return;                 // re-armed in the meantime
        overlay.hidden = true;
        try {
          video.pause();
          video.querySelectorAll('source').forEach(s => s.remove());
          video.removeAttribute('src');
          video.load();
        } catch (_) {}
      }, 450);
    }

    // Registered on `window` in the CAPTURE phase so it runs BEFORE DPad's
    // document-level capture handler — letting us swallow the dismiss key
    // before it navigates the app underneath.
    function onActivity(e) {
      last = Date.now();
      if (active) {
        if (e && e.type === 'keydown') {
          try { e.stopPropagation(); e.preventDefault(); } catch (_) {}
        }
        stop();
      }
    }

    function tick() {
      if (active || !cfg().enabled) return;
      if (Date.now() - last >= cfg().delayMs && canStart()) start(false);
    }

    function begin() {
      window.addEventListener('keydown', onActivity, true);
      ['mousedown', 'mousemove', 'wheel', 'touchstart'].forEach(ev =>
        window.addEventListener(ev, onActivity, true));
      // Belt-and-braces: if ANY other media element starts playing while the
      // saver is up (auto-advance, auto-resume, phone remote — no key press
      // involved), kill the saver instantly. 'play' doesn't bubble, but
      // capture-phase listeners on document still see it.
      document.addEventListener('play', e => {
        if (e.target === video) return;
        last = Date.now();
        if (active) stop();
      }, true);
      refreshLocal();
      clearInterval(localTimer);
      // Re-scan the local folder every 5 min — but stay silent while anything is
      // actually playing; no reason to hit the network mid-movie.
      localTimer = setInterval(() => {
        if (mediaBusy()) return;
        refreshLocal();
      }, 300000);
      clearInterval(pollTimer);
      pollTimer = setInterval(tick, 15000);
    }

    // Dismiss + reset the idle clock from a NON-keyboard control path (e.g. the
    // phone remote) so an action fired from the phone doesn't run/play behind a
    // still-visible overlay.
    function wake() { last = Date.now(); if (active) stop(); }

    // Refresh the local source count so Settings can show whether local
    // videos or public stock clips will be used.
    async function probeSources() {
      await refreshLocal();
      return { local: localUrls.length };
    }

    return { begin, stop, wake, preview: () => start(true),
             isActive: () => active, probeSources };
  })();

  // Crash recovery: if webOS OOM-killed us mid-movie, silently re-open that
  // exact playback at its saved position so a crash is a ~5s blip instead of a
  // trip back to Home. Every branch is guarded so a clean exit, a stale
  // breadcrumb, or a tight crash-loop never auto-launches anything.
  function resumeAfterCrash() {
    // A self-heal restart may have closed the page via
    // window.close() -- if that happened to complete a clean pagehide/
    // beforeunload/visibilitychange cycle first, window.__bbCrashedOnBoot
    // would read false even though this exact "resume the interrupted
    // playback" flow is still what we want, same as a genuine crash. This
    // breadcrumb (written right before that restart -- see
    // _netDeathExecuteRestart below) makes this boot recover
    // unconditionally instead of gambling on how cleanly window.close()
    // unwound. Always consumed (cleared) here regardless of how the rest
    // of this function proceeds, so a stale/irrelevant breadcrumb never
    // lingers past its 5-minute window.
    let netdeathBoot = false;
    try {
      const raw = localStorage.getItem('netdeath_restart');
      if (raw) {
        localStorage.removeItem('netdeath_restart');
        const b = JSON.parse(raw);
        netdeathBoot = !!(b && b.ts && (Date.now() - b.ts) < 5 * 60 * 1000);
      }
    } catch (_) {}
    if (!window.__bbCrashedOnBoot && !netdeathBoot) return;   // clean start → nothing to recover
    let lp = null;
    try { lp = JSON.parse(localStorage.getItem('dumiflix.lastPlaying') || 'null'); } catch (_) {}
    if (!lp || !lp.src || !lp.fileId) return;
    // Only recover a RECENT interruption — never resurrect a days-old movie.
    if (!lp.ts || (Date.now() - lp.ts) > 15 * 60 * 1000) return;
    // Crash-loop guard: if we auto-resumed moments ago and got killed again
    // right away, don't bounce straight back into the same crash — land on Home.
    let lastAuto = 0;
    try { lastAuto = +localStorage.getItem('dumiflix.autoResumeAt') || 0; } catch (_) {}
    if (lastAuto && (Date.now() - lastAuto) < 90 * 1000) {
      try { localStorage.removeItem('dumiflix.autoResumeAt'); } catch (_) {}
      try { window.__bbEvent && window.__bbEvent('resume:loop-guard', { agoMs: Date.now() - lastAuto }); } catch (_) {}
      return;
    }
    try { localStorage.setItem('dumiflix.autoResumeAt', String(Date.now())); } catch (_) {}
    try { window.__bbEvent && window.__bbEvent('resume:auto', { title: lp.title, pos: lp.position | 0 }); } catch (_) {}
    // Let the shell paint Home first, then re-open. openPlayer resolves the seek
    // from the fileId's resume entry (saved every 15s), landing within ~15s of
    // where the crash hit.
    setTimeout(() => {
      // Re-route through resumeItem (NOT openPlayer(lp.src, ...)): under remux
      // lp.src is the now-DEAD remux session URL, and replaying it 404s. resumeItem
      // resolves the source afresh by fileId/source and re-enters _maybeRemux, so
      // a crash mid-remux recovers into a brand-new transcode session at the saved
      // ABSOLUTE position. Falls back to direct openPlayer only if the routing
      // can't classify the entry.
      try {
        if (typeof resumeItem === 'function' && lp.fileId && lp.source) {
          Promise.resolve(resumeItem(lp)).catch(() => {});
        } else {
          openPlayer(lp.src, lp.title, {
            fileId: lp.fileId, source: lp.source, poster: lp.poster,
            show: lp.show, subFilename: lp.subFilename,
            codec: lp.codec, profile: lp.profile,
          });
        }
      } catch (_) {}
    }, 1200);
  }

  // ---------------------------------------------------------------------
  // Self-heal restart. Some webOS versions can silently kill the page's
  // browser NETWORK process for the rest of the session: every fetch/XHR to
  // every origin then rejects with a network-level TypeError forever, while
  // the <video> element (a separate decode pipeline) and this app's own
  // Luna service (a separate Node process with its own network stack) both
  // keep working fine.
  //
  // Closing the page can tear down the entire app bundle, including the
  // service process, before a delayed local relaunch fires. Recovery uses
  // two stages so a full relaunch can be delegated outside the app bundle:
  //
  //   STAGE 1: `location.reload()` can respawn the network stack without
  //   tearing down the app bundle or returning to the Home screen.
  //   STAGE 2 (heavy hammer, only once stage 1 has demonstrably not fixed
  //   it): ask the Luna service to relaunch us -- which now ALSO POSTs to
  //   the configured remote engine (tv-service/server.py)'s /tv/relaunch,
  //   asking IT to SSAP cold-launch this app from an outside machine, the
  //   recovery path for affected firmware even when our own
  //   app bundle gets torn down -- then window.close().
  //
  // Either stage relies on the existing resumeAfterCrash() flow (above) to
  // land back in the interrupted playback on the next boot.
  //
  // Detection: a cheap /health probe against the ACTIVE remux engine, and --
  // only if THAT looks network-dead -- one independent second origin
  // (api.tvmaze.com, already a dependency elsewhere in this app). Both must
  // reject with a genuine network-level TypeError (never an HTTP error
  // status -- fetch() resolves for those, it doesn't throw, and that's a
  // server problem, not the browser's network stack) before concluding the
  // stack itself, not just one host, is gone. Normally that takes 2
  // CONSECUTIVE rounds; the very first probe on a boot that follows a
  // stage-1 reload only needs ONE (see _netDeathStage1BootRecent below) --
  // a targeted reload that didn't fix anything already IS the second data
  // point, no need to wait out a second full round to confirm it again.
  const NETDEATH_TRIP_ROUNDS = 2;
  const NETDEATH_INTERVAL_ACTIVE_MS = 60000;    // while something is playing/loaded
  const NETDEATH_INTERVAL_IDLE_MS = 180000;     // back off when idle (Home, nothing loaded)
  const NETDEATH_BOOT_PROBE_MS = 45000;         // first probe after a stage-1 reload boot -- fast read
  const NETDEATH_PROBE_TIMEOUT_MS = 5000;
  const NETDEATH_MIN_UPTIME_MS = 5 * 60 * 1000;   // never in the first 5 min after a COLD boot
  const NETDEATH_COOLDOWN_MS = 30 * 60 * 1000;        // stage 2: at most once per 30 min
  const NETDEATH_STAGE1_COOLDOWN_MS = 10 * 60 * 1000; // stage 1: at most once per 10 min
  const NETDEATH_LAST_KEY = 'dumiflix.netdeath.lastRestartAt';         // stage-2 cooldown timestamp
  const NETDEATH_STAGE1_LAST_KEY = 'dumiflix.netdeath.lastStage1At';   // stage-1 cooldown timestamp
  const NETDEATH_BREADCRUMB_KEY = 'netdeath_restart';
  const NETDEATH_STAGE1_RECENT_MS = 5 * 60 * 1000;   // matches resumeAfterCrash()'s own window
  const _netDeathBootAt = Date.now();
  let _netDeathInFlight = false;
  let _netDeathConsecutive = 0;
  let _netDeathTimer = null;
  let _netDeathPending = null;   // { reason, stage } once tripped, cleared once executed
  let _netDeathWaitTimer = null;
  let _netDeathPauseSince = 0;
  let _netDeathFirstTickDone = false;

  // Non-destructive read of any breadcrumb left by a stage-1 reload --
  // does NOT clear it (resumeAfterCrash() above is the one authoritative
  // reader that clears it, for the separate "should THIS boot auto-resume
  // playback" decision -- unaffected by the stage field, unchanged) and
  // runs BEFORE resumeAfterCrash() does: this whole block executes at
  // script-parse time, while resumeAfterCrash() only runs later, inside
  // boot(), which isn't wired up until 'DOMContentLoaded' fires (bottom of
  // this file) -- so reading it here first always sees it. True only for a
  // RECENT stage-1 breadcrumb: this boot is itself the reload stage 1
  // triggered, not a genuine cold start, so the guard rails and trip
  // threshold below react fast instead of treating it like any other boot.
  let _netDeathStage1BootRecent = false;
  try {
    const raw = localStorage.getItem('netdeath_restart');
    if (raw) {
      const b = JSON.parse(raw);
      _netDeathStage1BootRecent = !!(b && b.ts && b.stage === 1 &&
        (Date.now() - b.ts) < NETDEATH_STAGE1_RECENT_MS);
    }
  } catch (_) {}

  // Own tiny pause-duration tracker (capture-phase, same technique the
  // blackbox IIFE up top uses for video lifecycle events, so it works
  // regardless of when/whether bindPlayer() has run yet). Independent of
  // the pause-park/memory-relief timers in bindPlayer() -- those exist for
  // a different purpose (freeing the decoder) with different thresholds.
  document.addEventListener('pause', (e) => {
    if (e && e.target && e.target.tagName === 'VIDEO') _netDeathPauseSince = Date.now();
  }, true);
  document.addEventListener('play', (e) => {
    if (e && e.target && e.target.tagName === 'VIDEO') _netDeathPauseSince = 0;
  }, true);

  function _netDeathIsTypeError(e) {
    return !!(e && (e instanceof TypeError || e.name === 'TypeError'));
  }
  async function _netDeathFetch(url) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), NETDEATH_PROBE_TIMEOUT_MS);
    try { await fetch(url, { cache: 'no-store', signal: ac.signal }); }
    finally { clearTimeout(timer); }
  }
  async function _netDeathProbeRound() {
    let url = null;
    try { url = (typeof Remux !== 'undefined') ? (Remux.base() + '/health') : null; } catch (_) { url = null; }
    if (!url) return false;   // active engine not configured -- nothing to conclude this round
    try { await _netDeathFetch(url); return false; }              // engine origin answered -- alive
    catch (e) { if (!_netDeathIsTypeError(e)) return false; }      // timeout/abort/CORS -- not proof
    // Engine origin looked network-dead -- corroborate on a second,
    // independent origin before concluding the WHOLE stack (not just that
    // one host) is gone.
    try { await _netDeathFetch('https://api.tvmaze.com/search/shows?q=ping'); return false; }
    catch (e2) { return _netDeathIsTypeError(e2); }
  }
  function _netDeathIdle() {
    try {
      const v = document.getElementById('video');
      return !currentVideo || !v || (v.paused && !v.currentTime);
    } catch (_) { return true; }
  }
  function _netDeathScheduleNext() {
    clearTimeout(_netDeathTimer);
    // After a stage-1 reload, get a fast read instead of waiting out the
    // normal idle/active backoff -- but only for the very first tick after
    // this boot; if that one comes back alive, there's no reason to keep
    // polling fast forever.
    const delay = (_netDeathStage1BootRecent && !_netDeathFirstTickDone)
      ? NETDEATH_BOOT_PROBE_MS
      : (_netDeathIdle() ? NETDEATH_INTERVAL_IDLE_MS : NETDEATH_INTERVAL_ACTIVE_MS);
    _netDeathTimer = setTimeout(_netDeathTick, delay);
  }
  async function _netDeathTick() {
    const isFirstTick = !_netDeathFirstTickDone;
    _netDeathFirstTickDone = true;
    try {
      // No probes while one is already in flight, and only while foreground.
      if (!_netDeathInFlight && document.visibilityState === 'visible') {
        _netDeathInFlight = true;
        try {
          const bothDead = await _netDeathProbeRound();
          _netDeathConsecutive = bothDead ? (_netDeathConsecutive + 1) : 0;
          // A stage-1 reload boot's FIRST probe only needs ONE dead round to
          // escalate straight to stage 2 -- the reload already stood in for
          // the usual "give it a second chance" round, so seeing it dead
          // again right after a targeted reload IS the confirmation, not a
          // fresh, isolated blip that deserves its own 2-round grace period.
          const threshold = (_netDeathStage1BootRecent && isFirstTick) ? 1 : NETDEATH_TRIP_ROUNDS;
          if (_netDeathConsecutive >= threshold) {
            _netDeathConsecutive = 0;
            _netDeathArmRestart(
              (_netDeathStage1BootRecent && isFirstTick) ? 'stage1-reload-still-dead' : 'probe-2x');
          }
        } finally { _netDeathInFlight = false; }
      }
    } finally { _netDeathScheduleNext(); }
  }
  _netDeathScheduleNext();

  // Recovery guard rails. MIN_UPTIME_MS ("never in the first 5 min after
  // boot") is meant to let a genuine cold start settle in -- it's skipped
  // when THIS boot is itself a stage-1 netdeath reload, since the entire
  // point of that reload was to get a fast, decisive read right away, not
  // to sit on it for another 5 minutes. Cooldowns are per-stage and
  // independent (each its own localStorage timestamp, so both survive the
  // restart itself): stage 1 (a cheap reload) may repeat at most once every
  // 10 min; stage 2 (the heavy service+laptop relaunch) at most once every
  // 30 min.
  function _netDeathGuardOk(stage) {
    if (!_netDeathStage1BootRecent && (Date.now() - _netDeathBootAt) < NETDEATH_MIN_UPTIME_MS) return false;
    const key = stage === 2 ? NETDEATH_LAST_KEY : NETDEATH_STAGE1_LAST_KEY;
    const cooldown = stage === 2 ? NETDEATH_COOLDOWN_MS : NETDEATH_STAGE1_COOLDOWN_MS;
    let last = 0;
    try { last = +localStorage.getItem(key) || 0; } catch (_) {}
    return !(last && (Date.now() - last) < cooldown);
  }
  // Safe = video works fine on a dead network, so never interrupt it mid-
  // play: ended, paused continuously >60s, or nothing playing at all.
  function _netDeathSafeMoment() {
    try {
      const v = document.getElementById('video');
      if (!currentVideo || !v) return true;
      if (v.ended) return true;
      if (v.paused && _netDeathPauseSince && (Date.now() - _netDeathPauseSince) >= 60000) return true;
      return false;
    } catch (_) { return false; }
  }
  // The active remux engine's base URL + its own token, mirroring
  // remux.js's internal base()/_token() engine-scoping (neither is exported
  // on the public Remux api, so this reads Storage the same way _token()
  // does rather than duplicating a second source of truth for the token).
  // Stage 2 hands these straight to the Luna service so it can POST
  // <base>/tv/relaunch on the laptop engine's OWN network stack (this
  // page's is the one that's dead). Only has real effect when the active
  // engine IS the laptop. With 'tv' active, only the service's local
  // relaunch attempts apply; the TV engine does not expose /tv/relaunch.
  function _netDeathEngineInfo() {
    let base = '';
    try { if (typeof Remux !== 'undefined') base = Remux.base() || ''; } catch (_) {}
    let token = '';
    try {
      const eng = (typeof Remux !== 'undefined' && Remux.engine) ? Remux.engine() : '';
      if (eng === 'laptop') token = Storage.get('remux.laptopToken', '') || Storage.get('remux.token', '') || '';
      // 'tv' (loopback, on-device) needs no token.
    } catch (_) {}
    return { base, token };
  }
  // Same PalmServiceBridge call shape switchTvToSoundbarInput()/
  // handoffToNativePlayer() already use successfully elsewhere in this file
  // (they call luna://com.webos.applicationManager/launch directly for a
  // DIFFERENT app id) -- here we ask our OWN service to do the relaunch
  // instead, since the service outlives this page closing itself below.
  function _netDeathCallServiceRestart(onDone) {
    // Wait for the service to CONFIRM before letting the caller close the
    // page. A naive fire-and-close (200ms) races the service's cold start: the Luna call dies with the
    // page and the laptop POST never goes out. The service now responds as
    // soon as the laptop has been notified — only then is it safe to die.
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { onDone && onDone(); } catch (_) {}
    };
    try {
      if (typeof PalmServiceBridge === 'undefined') { finish(); return; }
      const b = new PalmServiceBridge();
      b.onservicecallback = finish;
      b.call('luna://com.dumiflix.tv.service/restart', JSON.stringify(_netDeathEngineInfo()));
    } catch (_) { finish(); }
    setTimeout(finish, 6000);   // failsafe: close anyway, laptop may still act
  }
  function _netDeathExecuteRestart(reason, stage) {
    // persistCurrentResume() already runs on the player's own 15s heartbeat
    // -- call it once more explicitly so neither stage ever loses more than
    // an instant of position, even if the last tick was a while ago.
    try { persistCurrentResume(); } catch (_) {}
    try {
      localStorage.setItem(NETDEATH_BREADCRUMB_KEY, JSON.stringify({ ts: Date.now(), reason, stage }));
    } catch (_) {}
    try { window.__bbEvent && window.__bbEvent('netdeath:restart', { reason, stage }); } catch (_) {}
    if (stage === 2) {
      try { localStorage.setItem(NETDEATH_LAST_KEY, String(Date.now())); } catch (_) {}
      // Ask the service to relaunch us -- it keeps running after this page
      // dies, so its ~1.5s-delayed LOCAL launch (service/service.js's
      // 'restart' method) still fires IF the app bundle happens to survive;
      // that method now ALSO POSTs to the laptop's /tv/relaunch as its
      // first action, which is what actually works when the bundle doesn't.
      // Then close our OWN page right away: appinfo.json has
      // handlesRelaunch:false, so a launch request against a STILL-RUNNING
      // instance just foregrounds it (no reload) -- only if the page is
      // actually gone by the time a delayed launch fires does it perform a
      // real cold start. window.close() is LG's own documented way for a
      // webOS TV app to exit itself.
      _netDeathCallServiceRestart(() => {
        setTimeout(() => { try { window.close(); } catch (_) {} }, 250);
      });
    } else {
      try { localStorage.setItem(NETDEATH_STAGE1_LAST_KEY, String(Date.now())); } catch (_) {}
      // Cheap first attempt: no service call, no app-bundle teardown -- just
      // reload the page and see if that alone respawns the browser's dead
      // network process. resumeAfterCrash() (above) recognizes this exact
      // breadcrumb on the next boot and resumes the interrupted playback
      // the same way a full crash-recovery would.
      try { location.reload(); } catch (_) {}
    }
  }
  function _netDeathArmRestart(reason) {
    if (_netDeathPending) return;   // already waiting for a safe moment
    // A recent stage-1 breadcrumb means THIS boot is the reload stage 1
    // triggered -- tripping again here means that cheap attempt didn't fix
    // anything, so go straight to the heavy hammer instead of reloading in
    // a loop.
    const stage = _netDeathStage1BootRecent ? 2 : 1;
    if (!_netDeathGuardOk(stage)) {
      try { window.__bbEvent && window.__bbEvent('netdeath:suppressed', { reason, stage }); } catch (_) {}
      return;
    }
    _netDeathPending = { reason, stage };
    try { window.__bbEvent && window.__bbEvent('netdeath:detected', { reason, stage }); } catch (_) {}
    const check = () => {
      if (!_netDeathPending) return;
      if (_netDeathSafeMoment()) {
        const p = _netDeathPending; _netDeathPending = null;
        _netDeathExecuteRestart(p.reason, p.stage);
        return;
      }
      _netDeathWaitTimer = setTimeout(check, 15000);
    };
    check();
  }

  function boot() {
    loadQueue();
    bindNav();
    bindPlayer();
    bindSettings();
    bindMoviesChips();
    bindLibraryViewChips();
    bindMusicChips();
    bindSearchTypeChips();
    bindBackgroundTracker();
    DPad.setBackHandler(globalBack);
    Screensaver.begin();
    // App opened while the laptop is mid-playback (user came back from the
    // HDMI input via Home) — offer the D-pad controller right away.
    setTimeout(() => { try { maybeShowLaptopController(); } catch (_) {} }, 4000);
    // Pre-warm the on-TV remux service at boot so the FIRST playback engages
    // instantly. Otherwise the ~3s LS2 service-spawn happens at play time, and
    // a slow warm-up can make startSession abort -> the app falls back to
    // DIRECT playback, which may be silent for unsupported E-AC3/DTS. Fire-and-
    // forget, only when the TV engine is the selected remux engine.
    try {
      if (typeof Remux !== 'undefined' && Remux.engine
          && Remux.engine() === 'tv' && Remux.available && Remux.available()) {
        Remux.ensureTvEngine().catch(() => {});
      }
    } catch (_) {}
    // Proactive session-lost recovery. The engine keeps exactly ONE session:
    // an engine restart (or another client taking the slot) kills ours while
    // the <video> keeps playing ZOMBIE content from its buffer — the old
    // behavior was to drain that buffer (up to ~90s), hard-error, and limp
    // through the code-2/4 retry maze. The health poller detects the drop in
    // ~15s; this rebuilds the session at the CURRENT absolute position so
    // the user sees one short spinner instead of a stall + desync chain.
    try {
      if (typeof Remux !== 'undefined' && Remux.onSessionLost) {
        let _slBusy = false;
        Remux.onSessionLost(async () => {
          if (_slBusy) return;
          const cv = currentVideo;
          const v = $('#video');
          if (!cv || !v || cv.isLive || !cv._remux) return;
          _slBusy = true;
          try {
            // Old mapping stays valid for the buffered zombie content —
            // capture the true absolute position BEFORE closing anything.
            const absPos = Remux.hasSession()
              ? Remux.absolute(v.currentTime || 0) : (v.currentTime || 0);
            pToast('Stream engine hiccup — reconnecting…');
            setBuffering(true);
            try { Remux.close(); Remux.bindVideo(null); } catch (_) {}
            cv._remux = null;
            let src = cv.src;
            if (cv.source === 'seedr' && cv.fileId) {
              try { src = (await Seedr.fetchFileUrl(cv.fileId)) || cv.src; } catch (_) {}
            }
            if (currentVideo !== cv) return;
            const rmx = await _maybeRemux(src, 'seedr', src, absPos > 5 ? absPos : 0);
            if (currentVideo !== cv) return;
            cv._remux = rmx.sess;
            cv.src = rmx.url;
            cv._pendingResume = rmx.sess ? null : (absPos > 5 ? absPos : null);
            Remux.bindVideo(rmx.sess ? v : null);
            setVideoSource(v, rmx.url);
            _syncWatchdog(v, cv.isAudio);   // _remux may have just changed above
            try { v.play().catch(() => {}); } catch (_) {}
          } catch (_) {
          } finally {
            _slBusy = false;
          }
        });
      }
    } catch (_) {}
    showTab('home');
    // Daily refresh of the Trending Now row. Apibay regenerates its top100
    // through the day so this poller checks every hour: if the calendar
    // day has rolled over since the last fetch, drop the cache and (if
    // the user is sitting on Home) re-render so they see the new list
    // without having to navigate away and back.
    setInterval(() => {
      if (trendingCache.day && trendingCache.day !== _todayKey()) {
        trendingCache = { data: null, at: 0, cat: 'all', day: '' };
        if (currentTab === 'home') renderHome();
      }
    }, 60 * 60 * 1000);
    // Start the optional phone/native remote for gesture control.
    try { DumiRemote.start(); } catch (_) {}
    // If we came back from a mid-movie crash, resume that playback automatically.
    try { resumeAfterCrash(); } catch (_) {}
    // MusicRemote polling is opt-in; call MusicRemote.start() to enable it.
    // Consume a one-shot launch intent from an external automation.
    // Delay briefly so discovery can finish after a cold launch.
    setTimeout(() => { consumeBootIntent().catch(() => {}); }, 600);
    if (Drive.isSignedIn()) Drive.armProxy().catch(() => {});
    // Refresh seedr in the background so resuming a watch doesn't fail on
    // an expired access token. Without this the user has to re-sign in
    // through Settings every time the access token rolls (~1 hour).
    Seedr.ensureFresh().catch(() => {});
    // Resume watchers for items mid-flight on seedr. Pending items haven't
    // been sent to seedr yet — leave them alone; promoteNextPending below
    // will start the next one once the current download finishes (or
    // immediately if nothing is active).
    queue.filter(it => it.pct < 100 && !it.folderId && it.infoHash
                       && it.phase !== 'pending').forEach(startWatch);
    promoteNextPending();
    // Items that finished seedr but never made it to Drive (app closed during
    // upload, network blip, etc.) live with folderId set but phase not
    // 'drive-ready'. Kick them off again so they don't sit stuck forever.
    // Completed items retaining a folder still owe a final quota release.
    queue.filter(it => it.folderId && it.phase === 'drive-ready').forEach(releaseSeedr);
    queue.filter(it => it.folderId && it.phase !== 'drive-ready').forEach(it => {
      if (it._torrentFallback) _downloadMagnetToLaptop(it);
      else resumeUpload(it);
    });
    if (queue.length && Seedr.isLoggedIn()) {
      Seedr.listContents().then(root => {
        let changed = false;
        const newlyMatched = [];
        for (const it of queue) {
          if (it.folderId) continue;
          const folder = (root.folders || []).find(f => (f.torrent_hash || '').toLowerCase() === it.infoHash);
          if (folder) {
            it.folderId = folder.id;
            it.folderName = folder.name;
            it.pct = 100;
            it.phase = 'seedred';
            changed = true;
            newlyMatched.push(it);
          }
        }
        if (changed) { persistQueue(); renderQueue(); }
        newlyMatched.forEach(resumeUpload);
      }).catch(() => {});
    }
    // Boot-time housekeeping (delayed so it doesn't compete with the user's
    // first interaction). Runs at most once per 24 hours regardless of how
    // often the app is launched.
    setTimeout(() => {
      runDailyHousekeeping().catch(() => {});
    }, 30_000);
  }

  // ---------- Housekeeping ----------
  // Runs at most once per 24h. Cleans up old Drive files and stale queue
  // entries. Items currently in Continue Watching are protected.
  async function runDailyHousekeeping() {
    const last = Storage.get('housekeeping_at', 0);
    if (Date.now() - last < 24 * 3600_000) return;
    Storage.set('housekeeping_at', Date.now());
    pruneStuckQueueItems();
    if (Drive.isSignedIn()) {
      try { await pruneOldDriveFiles(); }
      catch (e) { console.warn('drive prune failed', e); }
    }
  }

  // Drop queue items that have nothing actionable left — no infoHash, no
  // folderId, and no driveFiles. These are usually leftover ghosts from
  // earlier crashes; they can't progress and shouldn't clutter the UI.
  // drive-ready items are completed Library entries — never silently prune them.
  function pruneStuckQueueItems() {
    const before = queue.length;
    queue = queue.filter(it => {
      // drive-ready items are playable Library entries — keep them forever.
      if (it.phase === 'drive-ready') return true;
      // Active or recoverable: keep.
      if (it.infoHash || it.folderId) return true;
      // No way to make progress on this — drop it.
      return false;
    });
    if (queue.length !== before) {
      persistQueue(); renderQueue();
    }
  }

  // Delete Drive files older than 14 days, sparing anything currently in
  // Continue Watching. Folders that go empty get removed too so the cache
  // doesn't fill with hollow subdirs.
  async function pruneOldDriveFiles() {
    const TTL = 14 * 24 * 3600_000;
    const cutoff = Date.now() - TTL;
    const protectedIds = new Set(
      Storage.listContinue().map(it => it.fileId).filter(Boolean)
    );
    const all = await Drive.listAll();
    let removed = 0;
    for (const f of all) {
      if (protectedIds.has(f.id)) continue;
      if (!f.mtime || f.mtime > cutoff) continue;
      try {
        await Drive.del(f.id);
        // Companion subtitle siblings are now orphaned — also remove them.
        for (const sub of (f.subtitles || [])) {
          try { await Drive.del(sub.id); } catch (_) {}
        }
        removed++;
      } catch (_) {}
    }
    if (removed > 0) {
      toast(`Cleaned up ${removed} old file${removed === 1 ? '' : 's'} from Drive`);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);

  // Foreground-resume handler. Called by the visibilitychange listener above
  // when the app returns from background. If a video is playing, call
  // closePlayer() to keep JS state consistent (currentVideo, back-stack,
  // timers). If nothing is playing, fall through to the DOM-only cleanup.
  window._dumiForegrounded = function() {
    if (currentVideo) { closePlayer(); } else { window._dumiKillStalePlayback(); }
    // Returning from the configured HDMI input while the external player runs:
    // greet the user with the D-pad controller instead of a dead-feeling
    // home screen (see showLaptopController).
    setTimeout(() => { maybeShowLaptopController(); }, 600);
  };

  // --- Bridge for the TV-native player overlay. Exposes a controlled
  //     slice of the closure so the new D-pad player can drive metadata,
  //     subtitle cues (for sync offset), close, menus, and next-episode. ---
  try {
    window.__dumi = {
      get currentVideo() { return currentVideo; },
      get subState() { return _subState; },
      // The remux module so the NF player can map window-relative <video> time
      // to absolute movie time (seek bar total, elapsed, subtitle cue timing,
      // seek across the whole movie). Null when the module isn't present.
      Remux: (typeof Remux !== 'undefined') ? Remux : null,
      dpad: (typeof DPad !== 'undefined') ? DPad : null,
      closePlayer: closePlayer, openMenu: openMenu, closeMenu: closeMenu,
      setSubCues: setSubCues, clearSubOverlay: clearSubOverlay, parseSrtCues: parseSrtCues,
      nudgeSubDelay: nudgeSubDelay, subDelaySec: subDelaySec,
      triggerUpNext: (typeof triggerUpNext !== 'undefined') ? triggerUpNext : null,
      maybeShowUpNext: (typeof maybeShowUpNext !== 'undefined') ? maybeShowUpNext : null,
      cancelUpNext: (typeof cancelUpNext !== 'undefined') ? cancelUpNext : null,
      rearmUpNext: (typeof rearmUpNext !== 'undefined') ? rearmUpNext : null,
      findNextEpisodeInQueue: (typeof findNextEpisodeInQueue !== 'undefined') ? findNextEpisodeInQueue : null,
      findManualNextEpisode: (typeof findManualNextEpisode !== 'undefined') ? findManualNextEpisode : null,
      findNextEpisodeQueueable: (typeof findNextEpisodeQueueable !== 'undefined') ? findNextEpisodeQueueable : null,
      findNextEpisodeInLocalStores: (typeof findNextEpisodeInLocalStores !== 'undefined') ? findNextEpisodeInLocalStores : null,
      prewarmNextEpisodeSubs: (typeof prewarmNextEpisodeSubs !== 'undefined') ? prewarmNextEpisodeSubs : null,
      findCachedFileFor: (typeof findCachedFileFor !== 'undefined') ? findCachedFileFor : null,
      playDriveFile: (typeof playDriveFile !== 'undefined') ? playDriveFile : null,
      resolveNextEpisodeTarget: (typeof resolveNextEpisodeTarget !== 'undefined') ? resolveNextEpisodeTarget : null,
      refetchAndResume: (typeof refetchAndResume !== 'undefined') ? refetchAndResume : null,
      findMovieQueueable: (typeof findMovieQueueable !== 'undefined') ? findMovieQueueable : null,
      pToast: (typeof pToast !== 'undefined') ? pToast : null,
      blockDirectSeedrSeek: (typeof blockDirectSeedrSeek !== 'undefined') ? blockDirectSeedrSeek : null,
      setBuffering: (typeof setBuffering !== 'undefined') ? setBuffering : null,
      // Reliability plumbing (also used for on-device diagnostics).
      playPhoneRel: (typeof playPhoneRel !== 'undefined') ? playPhoneRel : null,
      resumeItem: (typeof resumeItem !== 'undefined') ? resumeItem : null,
      findKeepWatchCopy: (typeof findKeepWatchCopy !== 'undefined') ? findKeepWatchCopy : null,
      preserveHalfWatchedSeedr: (typeof preserveHalfWatchedSeedr !== 'undefined') ? preserveHalfWatchedSeedr : null,
      wipeQueueAndSeedr: (typeof wipeQueueAndSeedr !== 'undefined') ? wipeQueueAndSeedr : null,
      resolveBestSubtitle: (typeof resolveBestSubtitle !== 'undefined') ? resolveBestSubtitle : null,
      fetchOpenSubsFallback: (typeof fetchOpenSubsFallback !== 'undefined') ? fetchOpenSubsFallback : null,
      listContinue: () => Storage.listContinue(),
      playPenDownload: (typeof playPenDownload !== 'undefined') ? playPenDownload : null,
      refreshWatchLater: (typeof refreshWatchLater !== 'undefined') ? refreshWatchLater : null,
      queueSilentPenDownload: (typeof queueSilentPenDownload !== 'undefined') ? queueSilentPenDownload : null,
    };
  } catch (e) { /* bridge optional — player degrades gracefully */ }

  return { showTab, addToQueue };
})();
