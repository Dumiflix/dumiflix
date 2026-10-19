// js/eztv.js — EZTV API client (TV-episode torrent index).
//
// apibay (the general index DumiFlix uses for episode search) periodically
// goes down or sits behind a Cloudflare challenge — when it does, next-episode
// autoplay and the Next button have nothing to resolve against. EZTV is a fast,
// JSON, TV-only index keyed by IMDB id, used as a fallback so episode playback
// keeps working through apibay outages.
//
// Because lookups are IMDB-scoped, there's zero show-name ambiguity (a generic
// "Example Show" query can't pull in the wrong regional variant). The tradeoff:
// it only covers shows EZTV tracks under that exact imdb.
const EZTV = (() => {
  const BASE = 'https://eztvx.to/api/get-torrents';

  // Hoisted regexes — never rebuild a RegExp per call (hot in sort/filter loops).
  const RE_TT_PREFIX = /^tt/i;
  const RE_NON_DIGIT = /[^0-9]/g;
  const RE_1080P = /1080p/i;

  // Raw-page cache: episode() and showTorrents() both page through the same
  // per-show torrent list (episode() while hunting a season/ep match,
  // showTorrents() while building the full grid), often seconds apart for the
  // same imdb when a show is opened then an episode picked. Cache the raw
  // page response (pre maxBytes-filter) so a repeat page request is free.
  // Hard-capped (LRU) + TTL'd so a long session paging through many shows
  // can never grow this unbounded — this app OOMs on native/GPU memory.
  const _cache = new Map();      // key `${imdbNum}:${page}` -> { data, time }
  const _inflight = new Map();   // same key -> in-flight Promise, dedupes concurrent callers
  const CACHE_TTL = 5 * 60 * 1000;  // 5 min: seeder counts barely move in that window
  const CACHE_MAX = 20;             // hard cap on distinct show/page entries retained

  function _cacheGet(key) {
    const hit = _cache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.time > CACHE_TTL) { _cache.delete(key); return undefined; }
    _cache.delete(key);      // refresh recency (Map preserves insertion order)
    _cache.set(key, hit);
    return hit.data;
  }
  function _cacheSet(key, data) {
    _cache.delete(key);
    _cache.set(key, { data: data, time: Date.now() });
    if (_cache.size > CACHE_MAX) {
      const oldest = _cache.keys().next().value;   // evict least-recently-used
      _cache.delete(oldest);
    }
  }

  function _abort(ms) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), ms);
      return { signal: c.signal, clear: () => clearTimeout(t) };
    } catch (_) {
      return { signal: undefined, clear: () => {} };
    }
  }
  function _numImdb(imdb) { return String(imdb || '').replace(RE_TT_PREFIX, '').replace(RE_NON_DIGIT, ''); }

  // Fetches one raw page (never throws — caller sees [] on any failure), and
  // reports whether it's cache-worthy (only genuine r.ok responses are —
  // network errors/timeouts must not poison the cache for the TTL window).
  async function _fetchPage(imdbNum, page) {
    const ab = _abort(8000);
    try {
      const r = await fetch(`${BASE}?imdb_id=${imdbNum}&limit=100&page=${page}`, { signal: ab.signal });
      if (!r.ok) return { ok: false, data: [] };
      const j = await r.json();
      return { ok: true, data: j.torrents || [] };
    } catch (_) {
      return { ok: false, data: [] };
    } finally {
      ab.clear();
    }
  }

  function _page(imdbNum, page) {
    const key = imdbNum + ':' + page;
    const cached = _cacheGet(key);
    if (cached) return Promise.resolve(cached);
    const inflight = _inflight.get(key);
    if (inflight) return inflight;   // dedupe: concurrent callers share one fetch
    const p = _fetchPage(imdbNum, page).then(res => {
      _inflight.delete(key);
      if (res.ok) _cacheSet(key, res.data);
      return res.data;
    });
    _inflight.set(key, p);
    return p;
  }

  // Find one episode. Pages newest-first (currently-airing episodes land on
  // page 1), filters to the exact season+episode, returns the best-seeded
  // single-episode torrent ≤ maxBytes, or null.
  async function episode(imdb, season, ep, opts = {}) {
    const imdbNum = _numImdb(imdb);
    if (!imdbNum) return null;
    const maxBytes = opts.maxBytes || Infinity;
    const maxPages = opts.maxPages || 3;
    const hits = [];
    for (let p = 1; p <= maxPages; p++) {
      const tors = await _page(imdbNum, p);
      if (!tors.length) break;
      for (const t of tors) {
        if (+t.season !== +season || +t.episode !== +ep) continue;   // episode 0 = pack → skipped
        const sz = parseInt(t.size_bytes || 0, 10) || 0;
        if (sz > maxBytes) continue;
        hits.push(t);
      }
      // Stop once we have a seeded variant (newest-first → current episodes are
      // early). Keep paging if everything found so far is dead.
      if (hits.some(t => parseInt(t.seeds || 0, 10) > 0)) break;
    }
    // Only return a seeded torrent — auto-queuing a 0-seed release would just
    // hang the next-episode download at 0% forever.
    const seeded = hits.filter(t => parseInt(t.seeds || 0, 10) > 0);
    if (!seeded.length) return null;
    seeded.sort((a, b) => {
      const a1080 = RE_1080P.test(a.title) ? 1 : 0;
      const b1080 = RE_1080P.test(b.title) ? 1 : 0;
      if (a1080 !== b1080) return b1080 - a1080;                     // prefer 1080p (smaller than 4K)
      return parseInt(b.seeds || 0, 10) - parseInt(a.seeds || 0, 10);
    });
    const pick = seeded[0];
    return {
      name: pick.title,
      magnet: pick.magnet_url,
      infoHash: (pick.hash || '').toLowerCase(),
      seeders: parseInt(pick.seeds || 0, 10),
      sizeBytes: parseInt(pick.size_bytes || 0, 10) || 0,
    };
  }

  // Every torrent for a show by imdb id, mapped to the apibay row shape the TV
  // episode picker already consumes ({name, info_hash, seeders, size}). Lets
  // openTvShow build its season/episode grid from EZTV when apibay is down.
  async function showTorrents(imdb, opts = {}) {
    const imdbNum = _numImdb(imdb);
    if (!imdbNum) return [];
    const maxBytes = opts.maxBytes || Infinity;
    const maxPages = opts.maxPages || 6;
    const rows = [];
    for (let p = 1; p <= maxPages; p++) {
      const tors = await _page(imdbNum, p);
      if (!tors.length) break;
      for (const t of tors) {
        if (!t.hash) continue;
        const sz = parseInt(t.size_bytes || 0, 10) || 0;
        if (sz > maxBytes) continue;
        rows.push({
          name: t.title,
          info_hash: (t.hash || '').toLowerCase(),
          seeders: parseInt(t.seeds || 0, 10) || 0,
          leechers: parseInt(t.peers || 0, 10) || 0,
          size: sz,
        });
      }
    }
    return rows;
  }

  return { episode, showTorrents };
})();
