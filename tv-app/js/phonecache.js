// js/phonecache.js — local cache backend on a configured phone.
//
// Drop-in replacement for the `Drive` module's caching/playback surface.
// Instead of uploading seedr files to Google Drive and streaming them back
// over the internet, this downloads them to the phone's internal flash (via
// the companion service's /cache/* endpoints) and streams them over the LAN —
// far faster, and the next episode is pre-fetched locally while you watch.
//
// fileIds are the cache-relative path prefixed with `CACHE::` so the rest of
// the app can route per-file ops (streamUrl / probe / fetchText) to the right
// backend purely from the id, with Google Drive as the fallback.
const PhoneCache = (() => {
  const PFX = 'CACHE::';

  function hasHost() { return Phone.hasHost(); }
  function base()    { return Phone.base(); }      // throws if host unset
  function isCacheId(id) { return typeof id === 'string' && id.startsWith(PFX); }
  function relOf(id)  { return isCacheId(id) ? id.slice(PFX.length) : id; }

  // Every fetch below gets an abort timeout so a wedged phone/server can't
  // pin an open socket + response buffer for the life of the page. Unlike a
  // bare AbortController+setTimeout, this also hands back `clear()` so the
  // timer (and the closure it holds) is torn down the moment the fetch
  // settles instead of lingering for the rest of `ms` on every call —
  // on memory-constrained TVs those dangling timers/closures add up.
  function _timeoutSignal(ms) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), ms);
      return { signal: c.signal, clear: () => clearTimeout(t) };
    } catch (_) {
      return { signal: undefined, clear: () => {} };
    }
  }

  // In-flight guard so concurrent callers asking "is the phone up?" at the
  // same moment (backend selection + the playback service-status check can
  // land within a tick of each other) share one /health round trip instead
  // of firing two. No TTL here on purpose — reachability can flip at any
  // time and callers use it to decide cache-vs-Drive fallback, so every call
  // that isn't truly concurrent still does a live check.
  let _reachableInflight = null;

  // Is the phone reachable AND is its cache drive mounted? Decides whether we
  // cache locally (preferred) or fall back to Google Drive.
  async function reachable() {
    if (!hasHost()) return false;
    if (_reachableInflight) return _reachableInflight;
    const t = _timeoutSignal(2500);
    _reachableInflight = (async () => {
      try {
        const r = await fetch(base() + '/health', { cache: 'no-store', signal: t.signal });
        if (!r.ok) return false;
        const j = await r.json();
        return !!j.cache_root_mounted;
      } catch (_) { return false; }
      finally { t.clear(); }
    })();
    try { return await _reachableInflight; }
    finally { _reachableInflight = null; }
  }

  // Download `sourceUrl` to the phone cache. onTick mirrors Drive.uploadFromUrl:
  //   { status:'starting'|'uploading'|'ready'|'error', total, received, written, stage, fileId, error }
  // Returns { cancel() }.
  function uploadFromUrl({ id, sourceUrl, filename, subdir }, onTick) {
    let cancelled = false;
    let timer = null;
    const jobId = String(id);

    const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };

    (async () => {
      const t0 = _timeoutSignal(10000);
      try {
        let r, j;
        try {
          r = await fetch(base() + '/cache/fetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: jobId, url: sourceUrl, name: filename, subdir: subdir || '' }),
            signal: t0.signal,
          });
          j = await r.json().catch(() => ({}));
        } finally { t0.clear(); }
        if (!r.ok || !j.ok) { onTick({ status: 'error', error: (j && j.error) || `HTTP ${r.status}` }); return; }

        const fileId = PFX + j.rel;
        if (j.state === 'ready') {
          _invalidateListCache(); // a new file just landed — next listAll() must see it
          onTick({ status: 'ready', fileId, total: 0, received: 0, written: 0, stage: 'ready' });
          return;
        }
        onTick({ status: 'starting', stage: 'connecting', total: 0, received: 0, fileId });

        const poll = async () => {
          if (cancelled) return;
          const t = _timeoutSignal(8000);
          try {
            const sr = await fetch(base() + '/cache/status?id=' + encodeURIComponent(jobId),
                                    { cache: 'no-store', signal: t.signal });
            const s = await sr.json().catch(() => ({}));
            if (cancelled) return;
            if (s.state === 'ready') {
              _invalidateListCache();
              onTick({ status: 'ready', fileId, total: s.total || 0, received: s.received || 0,
                       written: s.received || 0, stage: 'ready' });
              return;
            }
            if (s.state === 'error')  { onTick({ status: 'error', error: s.error || 'cache download failed' }); return; }
            if (s.state === 'cancelled' || s.state === 'unknown') { onTick({ status: 'error', error: s.state }); return; }
            // still downloading
            onTick({ status: 'uploading', total: s.total || 0, received: s.received || 0,
                     written: s.received || 0, stage: 'streaming', fileId });
            timer = setTimeout(poll, 1200);
          } catch (e) {
            if (!cancelled) { onTick({ status: 'error', error: String(e && e.message || e) }); }
          } finally { t.clear(); }
        };
        poll();
      } catch (e) {
        onTick({ status: 'error', error: String(e && e.message || e) });
      }
    })();

    return {
      cancel() {
        cancelled = true;
        stop();
        try {
          fetch(base() + '/cache/cancel', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: jobId }),
          }).catch(() => {});
        } catch (_) {}
      },
    };
  }

  function streamUrl(fileId) {
    const segs = relOf(fileId).split('/').filter(Boolean).map(encodeURIComponent);
    return base() + '/cache/stream/' + segs.join('/');
  }

  // No bearer-token proxy to arm (unlike Drive) — the LAN stream is direct.
  async function armProxy() { /* no-op */ }

  async function serviceStatus() {
    const ok = await reachable();
    return { proxy: { listening: ok, address: hasHost() ? base() : '' } };
  }

  async function probePlayUrl(fileId) {
    const t = _timeoutSignal(5000);
    try {
      const r = await fetch(streamUrl(fileId), { headers: { Range: 'bytes=0-1' },
                                                 cache: 'no-store', signal: t.signal });
      return { ok: r.status === 206 || r.status === 200, status: r.status };
    } catch (e) { return { ok: false, status: 0, error: String(e && e.message || e) }; }
    finally { t.clear(); }
  }

  // listAll() result cache. There's exactly one key (this module only ever
  // talks to a single phone host), so a hard LRU cap is moot — the "unbounded
  // growth" risk an LRU guards against doesn't exist here. What we do bound
  // is staleness: a short TTL plus explicit invalidation on our own mutations
  // (del / a finished uploadFromUrl) so it never disagrees with what this
  // module itself just did, while collapsing the back-to-back listAll()
  // calls callers make (presence check immediately followed by a subtitle
  // lookup) into a single request.
  const LIST_TTL_MS = 4000;
  let _listCache = null;    // { data, ts }
  let _listInflight = null; // shared promise for concurrent callers

  function _invalidateListCache() { _listCache = null; }

  async function listAll() {
    if (_listCache && (Date.now() - _listCache.ts) < LIST_TTL_MS) return _listCache.data;
    if (_listInflight) return _listInflight;
    const t = _timeoutSignal(6000);
    _listInflight = (async () => {
      try {
        const r = await fetch(base() + '/cache/list', { cache: 'no-store', signal: t.signal });
        const j = await r.json();
        const data = (j.files || []).map(f => ({
          id: PFX + f.id, name: f.name, size: f.size, path: f.path, mtime: f.mtime, subtitles: [],
        }));
        _listCache = { data, ts: Date.now() };
        return data;
      } catch (_) {
        _listCache = null;
        return [];
      } finally { t.clear(); }
    })();
    try { return await _listInflight; }
    finally { _listInflight = null; }
  }

  async function del(fileId) {
    _invalidateListCache(); // optimistic: the id must not resurface from a stale list
    const t = _timeoutSignal(5000);
    try {
      await fetch(base() + '/cache/del', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel: relOf(fileId) }),
        signal: t.signal,
      });
    } catch (_) {}
    finally { t.clear(); }
  }

  async function fetchText(fileId) {
    const t = _timeoutSignal(8000);
    try {
      const r = await fetch(streamUrl(fileId), { cache: 'no-store', signal: t.signal });
      if (!r.ok) throw new Error(`cache ${r.status}`);
      return await r.text();
    } finally { t.clear(); }
  }

  // Surface parity with Drive so call sites can treat them uniformly.
  function available()      { return hasHost(); }
  function isSignedIn()     { return hasHost(); }
  function rootFolderName() { return 'internal-cache'; }

  return {
    PFX, isCacheId, reachable, uploadFromUrl, streamUrl, armProxy, serviceStatus,
    probePlayUrl, listAll, del, fetchText, available, isSignedIn, rootFolderName,
  };
})();
