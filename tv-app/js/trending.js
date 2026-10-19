// js/trending.js — apibay top100 trending + IMDb poster lookup.
//
// Mirrors the Discover tab from the web remote. apibay categories 207/211
// are HD/4K movies, 208/212 are HD/4K TV. Poster lookup hits IMDb's keyless
// suggestion endpoint and caches results to localStorage so re-renders are
// free.

const Trending = (() => {
  const APIBAY_TOP = 'https://apibay.org/precompiled/data_top100_{cat}.json';
  const IMDB_SUGGEST = 'https://v3.sg.media-imdb.com/suggestion/x/{q}.json';

  const CATS = {
    all:    [207, 208, 211, 212],
    movies: [207, 211],
    tv:     [208, 212],
  };
  const TV_CATS = new Set([208, 212]);
  const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;
  const POSTER_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
  const FETCH_TIMEOUT = 8000;      // apibay/IMDb both keyless + can hang on webOS's flaky wifi
  const CAT_TTL = 60 * 1000;       // raw per-category apibay response cache (all/movies/tv share cats)
  const SUGGEST_CAP = 200;         // typeahead cache — session-lived, must not grow unbounded
  const POSTER_FLUSH_DELAY = 800;  // coalesce bursts of poster() resolutions into one localStorage write

  // ---------- name cleanup (port of remote.cmd_trending helpers) ----------
  const QUALITY_TOK = /\b(2160p|1080p|720p|480p|4k|uhd|hdr10?|dolby[. _-]?vision|dv|web[. _-]?dl|webrip|bluray|brrip|hdtv|dvdrip|x264|x265|h\.?264|h\.?265|hevc|aac|ddp?5\.1|dts(?:[. _-]?hd)?|atmos|truehd|amzn|nf|hulu|atvp|dsnp|mkv|mp4|10bit|8bit|yify|yts(?:\.mx|\.am)?|repack|proper|extended|imax|remux|ita|eng|multi|sub|subs)\b/i;
  const YEAR_RE = /\b(19[5-9]\d|20[0-3]\d)\b/;
  const TV_EP_TOK = /\b[Ss](\d{1,2})[. _-]?[Ee](\d{1,3})\b/;
  const TV_SEASON_ONLY = /\b[Ss]eason[. _-]?(\d{1,2})\b/i;
  const QUALITY_4K_RE = /\b(?:2160p|4k|uhd)\b/i;
  const QUALITY_1080_RE = /\b1080p\b/i;
  const QUALITY_720_RE = /\b720p\b/i;
  const QUALITY_HDR_RE = /\b(?:hdr|dolby[. _-]?vision|dv)\b/i;
  const DOT_UNDERSCORE_RE = /[._]+/g;
  const WS_RE = /\s+/g;
  const TRIM_PUNCT_RE = /^[\s\-–—._]+|[\s\-–—._]+$/g;
  const WORD_START_RE = /\b\w/g;
  const IMDB_THUMB_RE = /\._V1_[^.]*\./;
  const NON_ALNUM_RE = /[^a-z0-9]+/g;
  const ID_TT_RE = /^tt/;
  const SKIP_Q_RE = /episode|video game/;
  const TV_Q_RE = /tv series|tv mini/;

  function cleanTitle(name) {
    let s = name;
    const cuts = [];
    for (const r of [TV_EP_TOK, TV_SEASON_ONLY, YEAR_RE, QUALITY_TOK]) {
      const m = s.match(r);
      if (m) cuts.push(m.index);
    }
    if (cuts.length) s = s.slice(0, Math.min(...cuts));
    s = s.replace(DOT_UNDERSCORE_RE, ' ').replace(WS_RE, ' ').replace(TRIM_PUNCT_RE, '');
    if (s && (s === s.toLowerCase() || s === s.toUpperCase())) {
      s = s.toLowerCase().replace(WORD_START_RE, c => c.toUpperCase());
    }
    return s;
  }

  function detectQuality(name) {
    const out = [];
    if (QUALITY_4K_RE.test(name))        out.push('4K');
    else if (QUALITY_1080_RE.test(name)) out.push('1080p');
    else if (QUALITY_720_RE.test(name))  out.push('720p');
    if (QUALITY_HDR_RE.test(name)) out.push('HDR');
    return out;
  }

  function _fetchTimeout(url, opts) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
    const merged = Object.assign({}, opts, { signal: ac.signal });
    return fetch(url, merged).then(
      (r) => { clearTimeout(timer); return r; },
      (e) => { clearTimeout(timer); throw e; }
    );
  }

  // ---------- trending fetch ----------
  // Raw per-category apibay responses are cached briefly and in-flight requests
  // are shared, since 'all' and 'movies'/'tv' overlap on the same four cats —
  // without this, calling load() a couple of times in quick succession (e.g. a
  // fast tab switch) re-downloads and re-parses the same top100 JSON per cat.
  const _catCache = new Map();   // cat -> { data, at }
  const _catInflight = new Map(); // cat -> Promise<row[]>

  function _fetchCat(cat) {
    const cached = _catCache.get(cat);
    if (cached && (Date.now() - cached.at) < CAT_TTL) return Promise.resolve(cached.data);
    const inflight = _catInflight.get(cat);
    if (inflight) return inflight;
    // Only cache genuine successes. Caching a failed/timed-out fetch would make
    // a transient network hiccup "stick" for a full CAT_TTL — the original
    // simply retried fresh on the next load(), so a bad status or thrown error
    // must fall through uncached and let the next call try again immediately.
    const p = _fetchTimeout(APIBAY_TOP.replace('{cat}', cat))
      .then((r) => { if (!r.ok) throw new Error('bad status'); return r.json(); })
      .then((data) => {
        const rows = data || [];
        _catCache.set(cat, { data: rows, at: Date.now() });
        _catInflight.delete(cat);
        return rows;
      })
      .catch(() => {
        _catInflight.delete(cat);
        return [];
      });
    _catInflight.set(cat, p);
    return p;
  }

  async function load(category = 'all', limit = 48) {
    const cats = CATS[category] || CATS.all;
    const seen = new Map();
    const out = [];
    const perCat = await Promise.all(cats.map((cat) => _fetchCat(cat)));
    for (let ci = 0; ci < cats.length; ci++) {
      const cat = cats[ci];
      const isTv = TV_CATS.has(cat);
      const rows = perCat[ci];
      try {
        for (const row of rows) {
          if (!row.info_hash || row.info_hash === '0000000000000000000000000000000000000000') continue;
          const name = row.name || '';
          const title = cleanTitle(name);
          if (title.length < 2) continue;
          let year = '';
          if (!isTv) {
            const ym = name.match(YEAR_RE);
            year = ym ? ym[0] : '';
          }
          const key = isTv ? ('tv:' + title.toLowerCase())
                           : `movie:${title.toLowerCase()}:${year}`;
          const size = parseInt(row.size || 0, 10) || 0;
          const seed = parseInt(row.seeders || 0, 10) || 0;
          if (seed <= 0) continue;
          if (!isTv && size > MAX_FILE_BYTES) continue;
          const existing = seen.get(key);
          if (existing) {
            if (seed > existing.seeders) {
              existing.info_hash = row.info_hash;
              existing.raw_name = name;
              existing.size = size;
              existing.seeders = seed;
              existing.quality = detectQuality(name);
            } else {
              existing.seeders += seed;
            }
            continue;
          }
          const entry = {
            title, year,
            type: isTv ? 'tv' : 'movie',
            quality: detectQuality(name),
            seeders: seed, size,
            info_hash: row.info_hash,
            raw_name: name,
          };
          seen.set(key, entry);
          out.push(entry);
        }
      } catch (_) { /* ignore one-cat failure */ }
    }
    out.sort((a, b) => b.seeders - a.seeders);
    return out.slice(0, limit);
  }

  // ---------- poster cache (IMDb suggestion endpoint) ----------
  // Loaded once and kept as a live reference (Storage itself memoizes its
  // parsed blob — see storage.js — so mutating this object in place already
  // updates Storage's in-memory copy). Only the actual localStorage write
  // (JSON.stringify of the WHOLE config blob) is debounced below, since that
  // was previously happening once per poster() call — O(n) full-blob
  // serializations when hydrating a grid of n tiles.
  let _posterCache = null;
  let _posterDirty = false;
  let _posterFlushTimer = null;

  function _posterCacheGet() {
    if (!_posterCache) _posterCache = Storage.get('posterCache', {});
    return _posterCache;
  }
  function _flushPosterCacheNow() {
    if (_posterFlushTimer) { clearTimeout(_posterFlushTimer); _posterFlushTimer = null; }
    if (!_posterDirty || !_posterCache) return;
    _posterDirty = false;
    Storage.set('posterCache', _posterCache);
  }
  function _schedulePosterFlush() {
    _posterDirty = true;
    if (_posterFlushTimer) return;
    _posterFlushTimer = setTimeout(_flushPosterCacheNow, POSTER_FLUSH_DELAY);
  }
  if (typeof window !== 'undefined') {
    // Best-effort: flush any pending poster-cache write before the app is
    // backgrounded/killed. webOS suspends via visibilitychange far more often
    // than it fires pagehide, so cover both.
    window.addEventListener('pagehide', _flushPosterCacheNow);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') _flushPosterCacheNow();
    });
  }

  async function _imdbSuggest(term) {
    try {
      const url = IMDB_SUGGEST.replace('{q}', encodeURIComponent(term));
      const r = await _fetchTimeout(url);
      if (!r.ok) return [];
      const j = await r.json();
      return j.d || [];
    } catch (_) {
      return [];
    }
  }

  // Keep the poster cache from blowing past localStorage's quota. Drop the
  // oldest 20% of entries once we exceed the soft cap.
  function cacheEvict(cache, max = 500) {
    const keys = Object.keys(cache);
    if (keys.length <= max) return cache;
    const sorted = keys.sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0));
    const drop = Math.ceil(keys.length * 0.2);
    for (let i = 0; i < drop; i++) delete cache[sorted[i]];
    return cache;
  }

  // In-flight guard: hydrateTrendingPosters()-style callers can map the same
  // title/year/type across overlapping renders before the first lookup
  // resolves — share one IMDb request instead of firing duplicates.
  const _posterInflight = new Map();

  async function poster(title, year = '', type = 'movie') {
    if (!title) return null;
    const key = `${type}:${title.toLowerCase()}:${year}`;
    const cache = _posterCacheGet();
    const hit = cache[key];
    if (hit && (Date.now() - (hit.ts || 0)) < POSTER_TTL) return hit.url || null;

    const already = _posterInflight.get(key);
    if (already) return already;

    const p = (async () => {
      const term = (year && type === 'movie') ? `${title} ${year}`.trim() : title;
      const wantTv = type === 'tv';
      let art = null;
      const results = await _imdbSuggest(term);
      for (const x of results) {
        const q = (x.q || '').toLowerCase();
        const isTvHit = q.includes('tv');
        if (wantTv && !isTvHit) continue;
        if (!wantTv && isTvHit) continue;
        const img = (x.i || {}).imageUrl;
        if (img) { art = img; break; }
      }
      if (!art) {
        for (const x of results) {
          const img = (x.i || {}).imageUrl;
          if (img) { art = img; break; }
        }
      }
      if (art && IMDB_THUMB_RE.test(art)) {
        // SX300, not SX400: tiles render ~220px wide, so 400px was ~1.8x oversized
        // and decode memory scales with pixel AREA. 300px stays crisp on the TV
        // while cutting per-poster decode ~44% across the whole home/search grid.
        art = art.replace(IMDB_THUMB_RE, '._V1_SX300_.');
      }
      cache[key] = { url: art, ts: Date.now() };
      cacheEvict(cache);
      _schedulePosterFlush();
      return art;
    })();
    _posterInflight.set(key, p);
    try {
      return await p;
    } finally {
      _posterInflight.delete(key);
    }
  }

  // Typeahead suggestions for the Search tab. Same IMDb suggestion endpoint as
  // the poster cache (one lightweight, CDN-cached request per term), normalized
  // to { title, year, type, imdb, poster, cast }. Titles only — people (nm…),
  // single episodes and games are dropped. Results are cached per lowercased
  // term for the session so re-typing the same prefix costs nothing.
  // Capped LRU (insertion-order Map): a long session of varied searches must
  // not let this grow without bound.
  const _suggestCache = new Map();
  const _suggestInflight = new Map();

  async function suggest(term) {
    const key = String(term || '').trim().toLowerCase();
    if (key.length < 2) return [];
    if (_suggestCache.has(key)) {
      // Refresh recency (Map preserves insertion order — re-insert to mark MRU).
      const hit = _suggestCache.get(key);
      _suggestCache.delete(key);
      _suggestCache.set(key, hit);
      return hit;
    }
    const already = _suggestInflight.get(key);
    if (already) return already;

    const p = (async () => {
      const raw = await _imdbSuggest(key);
      const out = [];
      for (const x of raw) {
        const id = x.id || '';
        if (!ID_TT_RE.test(id)) continue;             // titles only (skip nm… people)
        const q = (x.q || '').toLowerCase();
        if (SKIP_Q_RE.test(q)) continue;               // skip single episodes & games
        const isTv = TV_Q_RE.test(q);                  // "TV movie" stays a movie (single file)
        let img = (x.i || {}).imageUrl || null;
        if (img && IMDB_THUMB_RE.test(img)) img = img.replace(IMDB_THUMB_RE, '._V1_SX120_.');
        out.push({
          title: x.l || '', year: x.y || '',
          type: isTv ? 'tv' : 'movie', imdb: id,
          poster: img, cast: (x.s || '').slice(0, 60),
        });
        if (out.length >= 8) break;
      }
      _suggestCache.set(key, out);
      if (_suggestCache.size > SUGGEST_CAP) {
        // Map iterates insertion order — first key is the least-recently-used.
        _suggestCache.delete(_suggestCache.keys().next().value);
      }
      return out;
    })();
    _suggestInflight.set(key, p);
    try {
      return await p;
    } finally {
      _suggestInflight.delete(key);
    }
  }

  return { load, poster, cleanTitle, detectQuality, suggest };
})();
