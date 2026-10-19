// js/phonedl.js — direct-to-pen torrent downloads ("watch later").
//
// For files over seedr's 5 GB cap, DumiFlix hands the magnet to aria2 running
// on a configured phone (spawned by an optional companion service, inheriting its
// network environment). The file lands straight on the attached drive and
// streams back over the LAN via the existing Range-capable /files/stream
// endpoint — no seedr, no Google Drive, no size limit.
//
// These downloads live ENTIRELY outside the seedr queue, so "Wipe queue +
// seedr" never touches them. The phone auto-evicts oldest movies to make room.
const PhoneDL = (() => {
  // Per-endpoint timeouts: generous enough to never trip during normal
  // operation, tight enough that a wedged phone-side service fails fast
  // instead of hanging a fetch (and the closures/buffers it holds) forever
  // on memory-constrained TV runtimes.
  const T_HEALTH = 2500;
  const T_LIST   = 4000;
  const T_ADD     = 10000;
  const T_REMOVE  = 5000;
  const T_EVICT   = 15000;

  // fetch() with an AbortController-backed timeout that is ALWAYS cleared.
  // An uncleared setTimeout keeps the AbortController (and its capture) alive
  // in memory for the whole timeout window even after the request already
  // settled, wasting memory on constrained TV runtimes.
  // Falls back to a plain fetch (no signal) on runtimes without
  // AbortController, same as the original per-call guard.
  function _fetch(url, opts, ms) {
    let signal, timer;
    try {
      const c = new AbortController();
      timer = setTimeout(() => c.abort(), ms);
      signal = c.signal;
    } catch (_) { /* AbortController unsupported — no signal, no timeout */ }
    const init = signal ? Object.assign({}, opts, { signal }) : opts;
    const p = fetch(url, init);
    // Promise.prototype.finally is ES2018 (Chrome 63+) and does not exist on
    // webOS 4's Chromium 53 — use then(onFulfilled, onRejected) instead so the
    // timer is cleared on both paths without relying on a newer API.
    if (!timer) return p;
    return p.then(
      (r) => { clearTimeout(timer); return r; },
      (e) => { clearTimeout(timer); throw e; }
    );
  }

  function available() { return typeof Phone !== 'undefined' && Phone.hasHost(); }
  function base() { return Phone.base(); }   // throws if host unset

  // Phone reachable AND the pen drive mounted (downloads need it). A pure
  // status read, so concurrent callers dedupe onto one in-flight request
  // instead of firing N identical /health round-trips.
  let _reachableInflight = null;
  async function reachable() {
    if (!available()) return false;
    if (_reachableInflight) return _reachableInflight;
    const p = (async () => {
      try {
        const r = await _fetch(base() + '/health', { cache: 'no-store' }, T_HEALTH);
        if (!r.ok) return false;
        const j = await r.json();
        return !!j.files_root_mounted;
      } catch (_) { return false; }
    })();
    _reachableInflight = p;
    p.then(
      () => { if (_reachableInflight === p) _reachableInflight = null; },
      () => { if (_reachableInflight === p) _reachableInflight = null; }
    );
    return p;
  }

  // Add a magnet (or http/https URL). Returns { ok, gid, rel?, evicted? }.
  // opts.dir (rel subdir under the pen root) + opts.out (filename) pin the
  // final path so the caller knows `rel` before the download completes —
  // used by the save-my-place KeepWatching flow.
  async function add(magnet, opts = {}) {
    const body = { magnet };
    if (opts.dir) body.dir = opts.dir;
    if (opts.out) body.out = opts.out;
    const r = await _fetch(base() + '/torrent/add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, T_ADD);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j;
  }

  // Live status of every download: [{gid,name,status,total,done,speed,seeders,
  // err,infohash,rel}]. Soft-fails to [] so the Library never errors out.
  // Callers poll this frequently (e.g. every 2.5s while Library is open) and
  // sometimes from more than one place at once; dedupe concurrent calls onto
  // a single in-flight fetch — it's a read-only snapshot, so racing callers
  // sharing the same answer is indistinguishable from them racing the network.
  let _listInflight = null;
  async function list() {
    if (_listInflight) return _listInflight;
    const p = (async () => {
      try {
        const r = await _fetch(base() + '/torrent/list', { cache: 'no-store' }, T_LIST);
        const j = await r.json();
        return j.downloads || [];
      } catch (_) { return []; }
    })();
    _listInflight = p;
    p.then(
      () => { if (_listInflight === p) _listInflight = null; },
      () => { if (_listInflight === p) _listInflight = null; }
    );
    return p;
  }

  async function remove(gid) {
    try {
      await _fetch(base() + '/torrent/remove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gid }),
      }, T_REMOVE);
    } catch (_) {}
  }

  // Free oldest movies on the pen up to `targetFreeGb` free. Returns the
  // server's eviction report ({freed, removed:[{name,size}], free}).
  async function evict(targetFreeGb) {
    try {
      const r = await _fetch(base() + '/torrent/evict', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_free_gb: targetFreeGb || 0 }),
      }, T_EVICT);
      return await r.json();
    } catch (_) { return null; }
  }

  // Build a playback URL for a finished download's relative path on the pen.
  function streamUrl(rel) { return Phone.streamUrl(rel); }

  return { available, reachable, add, list, remove, evict, streamUrl };
})();
