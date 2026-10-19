// js/storage.js — config persistence via localStorage.
//
// localStorage on webOS is per-app, ~5MB. Fine for OAuth tokens, queue state,
// and continue-watching positions.

const Storage = (() => {
  const KEY = 'dumiflix.config.v1';

  // In-memory memoization of the parsed config. The whole app funnels through
  // this one localStorage blob (which grows to multiple MB with the subtitle /
  // TVMaze / poster caches), and it was being JSON.parse'd on EVERY access —
  // every Storage.get, every 15s resume-save, and 3x per 1.5s DumiRemote
  // publish — spiking transient allocation at exactly the moments the video
  // decoder is grabbing native buffers. We parse once and keep the live object;
  // every write goes through save(), which updates the cache, so it never goes
  // stale (webOS is single-app: nothing else mutates our localStorage).
  let _cache = null;

  function load() {
    if (_cache) return _cache;
    try { _cache = JSON.parse(localStorage.getItem(KEY) || '{}'); }
    catch (_) { _cache = {}; }
    return _cache;
  }
  function save(cfg) {
    _cache = cfg || {};   // the mutated object IS the live cache from here on
    try {
      localStorage.setItem(KEY, JSON.stringify(_cache));
      return;
    } catch (e) {
      if (!e || e.name !== 'QuotaExceededError') throw e;
    }
    // Quota exceeded: evict the oldest continue-watching entries one at a
    // time and retry until it fits or there's nothing left to evict. (The
    // old code only tried once, which under sustained quota pressure — e.g.
    // a big subtitle/poster cache blob — left localStorage silently stale
    // forever even though more evictable cw: entries existed.) Bounded by
    // the shrinking cw: count, so it can never spin on a non-cw blob.
    for (;;) {
      const toEvict = Object.keys(_cache)
        .filter(k => k.startsWith('cw:'))
        .sort((a, b) => ((_cache[a] && _cache[a].ts) || 0) - ((_cache[b] && _cache[b].ts) || 0));
      if (!toEvict.length) break;
      delete _cache[toEvict[0]];
      try {
        localStorage.setItem(KEY, JSON.stringify(_cache));
        return;
      } catch (_) { /* still over quota — evict another and retry */ }
    }
  }
  function get(k, dflt) {
    const c = load();
    return (k in c) ? c[k] : dflt;
  }
  function set(k, v) {
    const c = load();
    c[k] = v;
    save(c);
  }
  function clear(k) {
    const c = load();
    delete c[k];
    save(c);
  }

  // --- continue-watching (per-file resume positions) ---
  // `key` is a stable id: Drive fileId for Drive items, seedr file_id for
  // seedr items. Stored value: { position, duration, title, fileId, source,
  // poster, ts }.
  function watchKey(key) { return 'cw:' + key; }
  function getResume(key) {
    const c = load();
    return (c[watchKey(key)] || null);
  }
  function setResume(key, info) {
    if (!key) return;
    const c = load();
    const prev = c[watchKey(key)] || {};
    c[watchKey(key)] = { ...prev, ...info, ts: Date.now() };
    save(c);
  }
  function clearResume(key) {
    const c = load();
    delete c[watchKey(key)];
    save(c);
  }
  // Move a resume entry from one key to another. Used when a video that
  // started life on seedr finishes uploading to Drive — the user's playhead
  // gets re-keyed against the Drive fileId so a future resume click finds
  // it after the seedr fileId is gone. No-op if the source key is empty.
  // `patch` overrides fields on the migrated entry — critically `source`. A
  // seedr→cache/Drive move MUST update source too, otherwise the entry keeps
  // its old fileId prefix's mismatched source (e.g. a CACHE:: fileId still
  // tagged source:'seedr') and a later resume routes to the dead seedr path.
  function migrateResume(fromKey, toKey, patch) {
    if (!fromKey || !toKey || fromKey === toKey) return;
    const c = load();
    const src = c[watchKey(fromKey)];
    if (!src) return;
    c[watchKey(toKey)] = { ...src, ...(patch || {}), fileId: toKey, ts: Date.now() };
    delete c[watchKey(fromKey)];
    save(c);
  }
  function listContinue() {
    const c = load();
    const keys = Object.keys(c);
    // Single pass instead of entries().filter().map().filter(): the config
    // blob's top-level keys also include the (much larger-valued) subtitle /
    // poster / TVMaze caches, so walking it 3x with intermediate arrays for
    // every call (this backs the home-row "Continue Watching" rebuild) was
    // pure throwaway allocation for no benefit.
    const out = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (!k.startsWith('cw:')) continue;
      const v = c[k];
      // Hide things we've practically finished (within 60s of the end).
      // Guard v (like the original's `!it.duration` did implicitly via
      // spreading null/undefined) so a corrupt/null cw: entry is skipped
      // over instead of throwing on `.duration`.
      if (v && v.duration && (v.duration - (v.position || 0)) <= 60) continue;
      out.push({ key: k.slice(3), ...v });
    }
    out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return out.length > 20 ? out.slice(0, 20) : out;
  }

  return { load, save, get, set, clear, getResume, setResume, clearResume, migrateResume, listContinue };
})();
