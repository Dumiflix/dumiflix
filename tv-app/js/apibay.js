// services/apibay.js — generic torrent search (apibay.org)
//
// CORS NOTE: apibay.org does *not* always send Access-Control-Allow-Origin.
// On webOS, fetch() from a packaged web app is exempt from same-origin
// restrictions when the app declares no specific allowlist (the embedded
// browser treats packaged apps as privileged). On a regular browser this
// fails — but on the TV it works.
//
// If a future webOS firmware tightens this, the workaround is a 1-file
// Cloudflare Worker that proxies the request and adds the CORS header.
// Free tier is more than enough for personal use.

const ApiBay = (() => {
  const BASE = 'https://apibay.org';
  const TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
  ];
  // Hoisted so search()/magnet() never rebuild these on every call.
  const ZERO_HASH = '0'.repeat(40);
  const TRACKER_QS = TRACKERS.map(u => `tr=${encodeURIComponent(u)}`).join('&');

  const FETCH_TIMEOUT_MS = 8000;

  // app.js routinely fans out several overlapping searches concurrently
  // (per-season + per-episode queries, movie/TV fallbacks, TMDB lookups) —
  // a short TTL plus in-flight dedupe collapses duplicate queries issued
  // within the same burst into a single network round-trip, and the LRU
  // cap bounds cache memory use on constrained TV runtimes.
  const CACHE_TTL_MS = 15000;
  const CACHE_MAX = 30;

  const cache = new Map();    // key -> { rows, at }
  const inflight = new Map(); // key -> Promise<rows>  (in-flight request guard)

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
    // Bump to most-recently-used (Map preserves insertion order).
    cache.delete(key);
    cache.set(key, hit);
    return hit.rows;
  }

  function cacheSet(key, rows) {
    cache.set(key, { rows, at: Date.now() });
    while (cache.size > CACHE_MAX) {
      cache.delete(cache.keys().next().value); // evict oldest
    }
  }

  async function fetchSearch(query, catParam) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(`${BASE}/q.php?q=${encodeURIComponent(query)}${catParam}`, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const items = await r.json();
      return (items || [])
        .filter(t => t.info_hash && t.info_hash !== ZERO_HASH)
        .sort((a, b) => parseInt(b.seeders || 0, 10) - parseInt(a.seeders || 0, 10));
    } finally {
      clearTimeout(timer);
    }
  }

  async function search(query, { cat } = {}) {
    const catParam = cat ? `&cat=${cat}` : '';
    const key = query + catParam;

    const cached = cacheGet(key);
    if (cached) return cached.slice(); // copy — callers must not mutate the cached array

    const pending = inflight.get(key);
    if (pending) return (await pending).slice();

    const promise = fetchSearch(query, catParam)
      .then(rows => { cacheSet(key, rows); return rows; })
      .then(value => { inflight.delete(key); return value; }, error => { inflight.delete(key); throw error; });
    inflight.set(key, promise);

    const rows = await promise; // rejects the same way the original fetch/parse did
    return rows.slice();
  }

  function magnet(item) {
    const dn = encodeURIComponent(item.name);
    return `magnet:?xt=urn:btih:${item.info_hash}&dn=${dn}&${TRACKER_QS}`;
  }

  return { search, magnet, TRACKERS };
})();
