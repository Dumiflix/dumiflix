// js/knaben.js — Knaben torrent meta-search (api.knaben.org).
//
// General fallback for when apibay is down / Cloudflare-gated. Knaben is an
// aggregating index that spans many trackers — 1337x, The Pirate Bay,
// RuTracker, and more — on independent infrastructure, so it's up when apibay
// isn't. It returns magnet hashes directly, so no per-result detail scrape.
//
// Direct tracker scraping can return Cloudflare HTTP 403 responses
// to TV or phone clients. Knaben exposes the
// catalogue through a JSON API instead.
//
// Rows are mapped to the SAME shape apibay/EZTV return
// ({name, info_hash, seeders, leechers, size}) so this drops straight into the
// existing search + next-episode fallback chains. Magnets are built with
// ApiBay.magnet() (identical btih shape).
//
// CORS: the webOS packaged app (allowCrossDomain) POSTs cross-origin fine —
// using the WebView's normal user agent. Knaben rejects blank/bot UAs, but the
// WebView's Chromium UA is accepted, and fetch() can't set UA anyway.
//
// Junk filter: Knaben's raw results include fake-high-seeder "crack software"
// rows in Applications/Games categories. Restricting to video categories
// (Movies / TV / Anime) + real 40-hex btih + seeders>0 removes them cleanly.
//
// Perf/memory notes for constrained TV runtimes:
// - In-flight requests are deduped by (query, size) — callers that fan out
//   several queries for the same show/episode in quick succession (season
//   packs, S##E## variants) share one network round-trip instead of N.
// - Successful lookups are cached for a short TTL, capped to a small LRU size
//   so the cache can never grow unbounded. `maxBytes` is applied AFTER the
//   cache/fetch (it only filters the already-sorted row set), so callers
//   passing different `maxBytes` for the same query still share one fetch.
const Knaben = (() => {
  const API = 'https://api.knaben.org/v1';
  const VIDEO_RE = /movie|tv|video|anime|show/i; // hoisted — never build per call
  const HASH_RE = /^[0-9a-f]{40}$/;

  const TTL_MS = 45000;   // torrent swarms barely change in under a minute
  const MAX_CACHE = 12;   // hard cap — small objects, but never unbounded

  const cache = new Map();     // key -> { rows, exp }  (Map preserves insertion
                                // order, so re-inserting on hit gives cheap LRU)
  const inflight = new Map();  // key -> Promise<rows>, cleared once settled

  function _mapRow(h) {
    const cat = h.category || '';
    if (!VIDEO_RE.test(cat)) return null;
    const hash = String(h.hash || '').toLowerCase();
    if (!HASH_RE.test(hash)) return null;
    const seeders = parseInt(h.seeders || 0, 10) || 0;
    if (seeders <= 0) return null;
    return {
      name: h.title || '',
      info_hash: hash,
      seeders,
      leechers: parseInt(h.peers || 0, 10) || 0,
      size: parseInt(h.bytes || 0, 10) || 0,
      _tracker: h.tracker || '',
    };
  }

  function _cacheSet(key, rows) {
    // Drop anything expired first, then evict the least-recently-used entry
    // if we're still at cap — keeps the cache small and bounded.
    const now = Date.now();
    for (const [k, v] of cache) {
      if (v.exp <= now) cache.delete(k);
    }
    if (cache.size >= MAX_CACHE) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(key, { rows, exp: now + TTL_MS });
  }

  // Fetch + map once for a given (query, size). Not cached itself — callers
  // handle caching so concurrent identical requests share the same promise
  // and only pay the caching cost once.
  async function _fetchAndMap(query, size) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          order_by: 'seeders',
          order_direction: 'desc',
          size,
          hide_unsafe: true,
          hide_xxx: true,
        }),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const hits = data.hits || [];
      const rows = [];
      for (let i = 0; i < hits.length; i++) {
        const m = _mapRow(hits[i]);
        if (m) rows.push(m);
      }
      rows.sort((a, b) => b.seeders - a.seeders);
      return rows;
    } finally {
      clearTimeout(timer);
    }
  }

  // Search Knaben. Returns apibay-shaped rows, seeded, video-only, sorted by
  // seeders desc. `opts.maxBytes` caps file size; `opts.size` the fetch depth.
  async function search(query, opts = {}) {
    const size = opts.size || 60;
    const key = query + '\x00' + size;

    let rows;
    const cached = cache.get(key);
    if (cached && cached.exp > Date.now()) {
      rows = cached.rows;
      // Bump to most-recently-used position (re-insert = move to Map's end).
      cache.delete(key);
      cache.set(key, cached);
    } else {
      let p = inflight.get(key);
      if (!p) {
        p = _fetchAndMap(query, size).then(r => {
          _cacheSet(key, r);
          return r;
        }).then(value => { inflight.delete(key); return value; }, error => { inflight.delete(key); throw error; });
        inflight.set(key, p);
      }
      rows = await p;
    }

    if (!opts.maxBytes) return rows.slice();
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].size <= opts.maxBytes) out.push(rows[i]);
    }
    return out;
  }

  return { search };
})();
