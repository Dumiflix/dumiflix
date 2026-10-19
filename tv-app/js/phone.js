// js/phone.js — client for an optional phone companion service, not included
// in this repository. Its /files/* endpoints browse and stream attached storage.

const Phone = (() => {
  // Hoisted once — old Chromium (53/68/79) re-allocates a RegExp object on
  // every evaluation of a literal, so building these inside base() on every
  // call would churn the GC for no reason on memory-constrained TVs.
  const HTTP_RE = /^https?:\/\//i;
  const TRAIL_SLASH_RE = /\/+$/;
  const JSON_HEADERS = { 'Content-Type': 'application/json' };

  // Per-endpoint default timeouts (ms). Every fetch below is bounded so a
  // wedged phone can never leave a dangling in-flight request (and its
  // response-buffer memory) alive forever. Repeated slow leaks can exhaust
  // a constrained TV runtime even when each individual allocation is small.
  const T_HEALTH = 15000;
  const T_LIST = 20000;
  const T_CHECK = 45000;   // checkTorrents may probe many titles on the phone
  const T_WATCHSTATE = 10000; // fire-and-forget; just bounds cleanup, not awaited

  function host() {
    return (Storage.get('phoneHost', '') || '').trim();
  }
  function setHost(h) {
    Storage.set('phoneHost', String(h || '').trim());
  }
  function hasHost() { return !!host(); }
  function base() {
    const h = host();
    if (!h) throw new Error('Phone host not set in Settings');
    if (HTTP_RE.test(h)) return h.replace(TRAIL_SLASH_RE, '');
    return `http://${h.includes(':') ? h : h + ':5052'}`;
  }

  // In-flight GET dedupe: while a request for an exact URL is still pending,
  // any other caller asking for the same URL rides the same promise instead
  // of opening a second socket. Entries are removed the instant the request
  // settles, so this never serves stale data across separate calls — only
  // genuinely concurrent callers (e.g. two UI paths both listing the same
  // KeepWatching folder on startup) ever share a result.
  const _inflight = new Map();

  async function _json(path, timeoutMs) {
    const url = base() + path;
    const existing = _inflight.get(url);
    if (existing) return existing;
    const p = (async () => {
      let ctrl, timer;
      try { ctrl = new AbortController(); timer = setTimeout(() => ctrl.abort(), timeoutMs || T_LIST); } catch (_) {}
      try {
        const r = await fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
        if (!r.ok) {
          const txt = await r.text().catch(() => '');
          throw new Error(`phone ${r.status}: ${txt.slice(0, 160)}`);
        }
        return await r.json();
      } finally { if (timer) clearTimeout(timer); }
    })();
    _inflight.set(url, p);
    try { return await p; }
    finally { _inflight.delete(url); }
  }

  function health() { return _json('/health', T_HEALTH); }

  // Offload torrent-availability checks to the phone (parallel HTTP it does far
  // better than the webOS browser). payload: { items:[{title,year,kind}], ... }
  // → { results:[{title,kind,watchable}] } in the same order as items.
  async function checkTorrents(payload) {
    let ctrl, timer;
    try { ctrl = new AbortController(); timer = setTimeout(() => ctrl.abort(), T_CHECK); } catch (_) {}
    try {
      const r = await fetch(base() + '/torrents/check', {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify(payload || {}),
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!r.ok) throw new Error('torrents/check ' + r.status);
      return r.json();
    } finally { if (timer) clearTimeout(timer); }
  }

  // List a directory under FILES_ROOT on the phone. `relPath` is the path
  // relative to the root ('' = root). Returns { root, path, entries: [...] }.
  async function listFiles(relPath = '') {
    const q = relPath ? '?path=' + encodeURIComponent(relPath) : '';
    return _json('/files/list' + q, T_LIST);
  }

  // Build a stream URL for a file path relative to FILES_ROOT. The path
  // segments are individually URL-encoded so spaces / special chars don't
  // break the request line.
  function streamUrl(relPath) {
    const segs = String(relPath).split('/').filter(Boolean).map(encodeURIComponent);
    return base() + '/files/stream/' + segs.join('/');
  }

  // Shared executor for the four "cancellable POST with timeout" endpoints
  // below (subsync / embeddedSubs / chapters / mediaInfo). Same shape as
  // before: returns a Promise with a `.cancel()` hung on it that aborts the
  // in-flight fetch and resolves to `null` (same path as any other failure).
  function _cancellablePost(path, body, timeoutMs, parse) {
    let ctrl, timer;
    try { ctrl = new AbortController(); timer = setTimeout(() => ctrl.abort(), timeoutMs); } catch (_) {}
    const p = (async () => {
      try {
        const r = await fetch(base() + path, {
          method: 'POST', headers: JSON_HEADERS,
          body: JSON.stringify(body || {}),
          signal: ctrl ? ctrl.signal : undefined,
        });
        if (!r.ok) return null;
        const j = await r.json();
        return parse ? parse(j) : j;
      } catch (_) { return null; }
      finally { if (timer) clearTimeout(timer); }
    })();
    p.cancel = () => { try { ctrl && ctrl.abort(); } catch (_) {} };
    return p;
  }

  // Literal sync-to-audio: the phone decodes the file's audio (ffmpeg) and
  // cross-correlates speech against the subtitle cues, returning the true
  // offset vs the audio. LONG-running (audio decode is ~4× realtime) — call it
  // in the background: the caller already shows a sub and applies the offset
  // when this resolves. Returns { ok, offset, confidence, ... } or null.
  // Cancellable: see _cancellablePost above for the `.cancel()` shape/contract.
  function subsync(mediaUrl, srt, maxSec) {
    return _cancellablePost('/subsync', { url: mediaUrl, srt: srt || '', max_sec: maxSec || 900 }, 360000);
  }

  // Extract the file's OWN embedded English subtitle track (perfectly synced —
  // it came from the file). webOS never exposes in-band MKV subs to JS, so the
  // phone's ffmpeg pulls them out and returns SRT. LONG-running the first time
  // for a big file (reads it end-to-end), cached thereafter — so call it in the
  // background and swap the sub in when it resolves. `loc` is one of:
  //   { cache: relUnderCacheRoot }  { path: relUnderFilesRoot }  { url: streamUrl }
  // Returns { found, srt, lang, forced, sdh, cues } or null.
  // Cancellable — see _cancellablePost above for the `.cancel()` shape/contract.
  function embeddedSubs(loc, timeoutMs) {
    return _cancellablePost('/subs/embedded', loc, timeoutMs || 300000);
  }

  // Read the file's chapter markers (Intro / Recap / Opening / End Credits)
  // for precise Skip Intro / Skip Credits. Only reads the container header, so
  // it's fast even for a seedr STREAM url (no full-file read). `loc` is one of:
  //   { cache: relUnderCacheRoot }  { path: relUnderFilesRoot }  { url: streamUrl }
  // Returns [{start, end, title}] (empty array if none) or null on failure.
  // Cancellable — see _cancellablePost above for the `.cancel()` shape/contract.
  function chapters(loc, timeoutMs) {
    return _cancellablePost('/media/chapters', loc, timeoutMs || 20000, j => (j && j.chapters) || []);
  }

  // Probe the file's video (resolution / bit depth / HDR type) and audio
  // streams (codec / channel layout / Atmos) so the player can show the user
  // exactly what they're getting. Header-only read → fast, works for a seedr
  // STREAM url too. Returns { video, audio:[...] } or null.
  // Cancellable — see _cancellablePost above for the `.cancel()` shape/contract.
  function mediaInfo(loc, timeoutMs) {
    return _cancellablePost('/media/info', loc, timeoutMs || 20000);
  }

  // Does a file exist on the pen? Cheap Range probe of the stream endpoint.
  async function fileExists(relPath) {
    let ctrl, timer;
    try { ctrl = new AbortController(); timer = setTimeout(() => ctrl.abort(), 5000); } catch (_) {}
    try {
      const r = await fetch(streamUrl(relPath), {
        headers: { Range: 'bytes=0-0' }, cache: 'no-store',
        signal: ctrl ? ctrl.signal : undefined,
      });
      return r.status === 206 || r.status === 200;
    } catch (_) { return false; }
    finally { if (timer) clearTimeout(timer); }
  }

  // Sync a continue-watching position to the phone. The phone uses it to
  // shield half-watched pen files from auto-eviction and to expire
  // KeepWatching copies 3 days after the last watch. Fire-and-forget.
  function postWatchState(entry) {
    try {
      let ctrl, timer;
      try { ctrl = new AbortController(); timer = setTimeout(() => ctrl.abort(), T_WATCHSTATE); } catch (_) {}
      fetch(base() + '/watchstate', {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify(entry || {}),
        signal: ctrl ? ctrl.signal : undefined,
      }).catch(() => {}).then(() => { if (timer) clearTimeout(timer); });
    } catch (_) {}
  }

  return { host, setHost, hasHost, base, health, checkTorrents, listFiles, streamUrl,
           subsync, embeddedSubs, chapters, mediaInfo, fileExists, postWatchState };
})();
