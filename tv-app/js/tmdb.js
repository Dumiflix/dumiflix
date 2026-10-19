// js/tmdb.js — 7-day-trending movies + TV from TMDB, with YTS/apibay
// magnet lookup on tile-tap. Posters come from TMDB's image CDN (no
// IMDb-suggest round-trip needed). Tile metadata is cached for the day
// so repeat renders within the day are instant.
//
// Auth: TMDB v4 bearer token (longer "API Read Access Token", starts
// with "eyJhb..."). Stored in localStorage under 'dumiflix.tmdb.v1'.
// Without a key, all loaders return [] silently — Home keeps working
// without trending rows.
//
// On tap (handled in app.js):
//   movie → TMDB title+year → YTS.search(query_term=...) → openMovieModal
//   tv    → TMDB title       → apibay search cat=205 by name → addToQueue

const TMDB = (() => {
  const KEY_STORAGE = 'dumiflix.tmdb.v1';
  const CACHE_STORAGE = 'dumiflix.tmdb.cache.v3';   // v3: w780 backdrop (was w1280)
  const POSTER_BASE = 'https://image.tmdb.org/t/p/w500';
  const POSTER_TINY = 'https://image.tmdb.org/t/p/w185';
  const CACHE_TTL_MS = 12 * 60 * 60 * 1000;          // 12 h
  const FETCH_TIMEOUT_MS = 8000;

  // Regexes hoisted to module scope — never build a RegExp per call.
  const RE_V4_TOKEN  = /^eyJ/;
  const RE_NON_ALNUM = /[^a-z0-9]+/g;

  // Configure a personal TMDB key in Settings; no shared credential ships
  // with the app. Missing keys leave the catalog rows empty.
  const BAKED_TOKEN = '';

  // ---- key persistence ----
  function getKey() {
    try {
      const k = localStorage.getItem(KEY_STORAGE);
      if (k && k.trim()) return k;
    } catch (_) {}
    return BAKED_TOKEN;
  }
  function setKey(k) {
    try {
      if (k) localStorage.setItem(KEY_STORAGE, String(k).trim());
      else   localStorage.removeItem(KEY_STORAGE);
    } catch (_) {}
  }
  function hasKey() { return !!getKey(); }

  // ---- shared fetch helper ----
  // Supports BOTH key formats:
  //   v3 key  (32-char hex, e.g. "YOUR_TMDB_V3_KEY") → ?api_key=KEY
  //   v4 token (long "eyJhb…" JWT)             → Authorization: Bearer KEY
  function _isV4(k) { return RE_V4_TOKEN.test(k || ''); }

  // In-flight request guard: if the same TMDB path is requested twice
  // before the first resolves (e.g. Home's tile loop calling imdbId()
  // back-to-back, or two rows racing on the same trending window), the
  // second caller just awaits the first's promise instead of opening a
  // second socket/response buffer. Entries are removed as soon as the
  // request settles, so this map never grows beyond concurrent requests.
  const _inflight = new Map();

  async function _fetch(path) {
    const key = getKey();
    if (!key) throw new Error('TMDB API key not set');
    const existing = _inflight.get(path);
    if (existing) return existing;
    const p = _doFetch(path, key);
    _inflight.set(path, p);
    try {
      return await p;
    } finally {
      _inflight.delete(path);
    }
  }

  async function _doFetch(path, key) {
    let url = `https://api.themoviedb.org/3${path}`;
    const headers = { 'Accept': 'application/json' };
    if (_isV4(key)) {
      headers['Authorization'] = 'Bearer ' + key;
    } else {
      url += (path.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(key);
    }
    url += (url.includes('?') ? '&' : '?') + 'language=en';
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let r;
    try {
      r = await fetch(url, { headers, signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
    if (!r.ok) throw new Error(`TMDB ${r.status}`);
    return r.json();
  }

  // ---- cache (per-day, in localStorage) ----
  // In-memory mirror of the localStorage blob. Home's render loop can
  // call imdbId()/trending*() many times per second (once per tile);
  // without this, each call would re-JSON.parse the entire cache blob
  // from localStorage even on a pure cache hit. The mirror is loaded
  // once lazily and kept in sync on every write, so parsing happens at
  // most once per page life (or once after clearCache()).
  let _cacheMem = null;
  function _loadCache() {
    if (_cacheMem) return _cacheMem;
    try { _cacheMem = JSON.parse(localStorage.getItem(CACHE_STORAGE) || '{}'); }
    catch (_) { _cacheMem = {}; }
    return _cacheMem;
  }
  function _saveCache(c) {
    _cacheMem = c;
    try { localStorage.setItem(CACHE_STORAGE, JSON.stringify(c)); }
    catch (_) {}
  }
  function _isFresh(entry) {
    return entry && entry.at
        && (Date.now() - entry.at) < CACHE_TTL_MS;
  }

  // Bound the imdbId/imdbIdForTitle resolver caches ('imdb.*' and
  // 'imdbq.*' slots), which otherwise grow one entry per unique
  // tmdbId/title ever looked up for the life of the install. Once a
  // family exceeds a soft cap, evict the oldest 20% by their `at`
  // timestamp. trending.*/popular.* slots are untouched (small, fixed
  // cardinality, already refreshed in place via _isFresh) — except
  // popular.*, which is keyed by year and could otherwise accumulate
  // one pair of slots per calendar year the app stays installed.
  const IMDB_CACHE_SOFT_CAP = 200;
  const POPULAR_CACHE_SOFT_CAP = 12;
  function _evictOldest(cache, prefix, cap) {
    const keys = Object.keys(cache).filter(k => k.startsWith(prefix));
    if (keys.length <= cap) return;
    keys.sort((a, b) => ((cache[a] && cache[a].at) || 0) - ((cache[b] && cache[b].at) || 0));
    const drop = Math.max(1, Math.ceil(keys.length * 0.2));
    for (const k of keys.slice(0, drop)) delete cache[k];
  }

  // Normalize a TMDB result. /trending/all/* returns mixed movie + tv
  // items distinguished by `media_type`. Movies use title/release_date,
  // TV uses name/first_air_date — we flatten both into the same shape.
  function _normalize(r, fixedKind) {
    const kind = fixedKind || r.media_type ||
                 (r.title ? 'movie' : (r.name ? 'tv' : 'movie'));
    return {
      tmdb_id:    r.id,
      kind,                          // 'movie' or 'tv'
      title:      kind === 'movie' ? (r.title || r.original_title)
                                   : (r.name  || r.original_name),
      year:       (r.release_date || r.first_air_date || '').slice(0, 4) || '',
      overview:   r.overview || '',
      vote:       Math.round((r.vote_average || 0) * 10) / 10,
      poster:     r.poster_path ? (POSTER_BASE + r.poster_path) : null,
      poster_sm:  r.poster_path ? (POSTER_TINY + r.poster_path) : null,
      // w780 backdrop — covers the hero block at acceptable quality and
      // decodes to ~2 MB vs w1280's ~3.5 MB. webOS WebView cap is tight
      // and the hero backdrop is the single biggest image in the app.
      backdrop:   r.backdrop_path
                    ? ('https://image.tmdb.org/t/p/w780' + r.backdrop_path)
                    : null,
    };
  }

  // ---- trending fetchers ----
  // window: 'day' or 'week'; kind: 'all' | 'movie' | 'tv'
  async function _trending(kind, window, limit) {
    if (!hasKey()) return [];
    const cache = _loadCache();
    const slot  = `trending.${kind}.${window}`;
    if (_isFresh(cache[slot]) && cache[slot].data) {
      return cache[slot].data.slice(0, limit);
    }
    const j = await _fetch(`/trending/${kind}/${window}?page=1`);
    const fixed = kind === 'all' ? null : kind;
    const items = (j.results || []).map(r => _normalize(r, fixed));
    cache[slot] = { at: Date.now(), data: items };
    _saveCache(cache);
    return items.slice(0, limit);
  }
  const trendingAll     = (window = 'week', limit = 20) => _trending('all',   window,  limit);
  const trendingMovies  = (limit = 20)                  => _trending('movie', 'week', limit);
  const trendingTV      = (limit = 20)                  => _trending('tv',    'week', limit);
  const trendingDay     = (limit = 20)                  => _trending('all',   'day',  limit);
  const trendingWeek    = (limit = 20)                  => _trending('all',   'week', limit);

  // Resolve a TMDB id → IMDB id (tt…), cached. Lets the phone match torrents
  // by IMDB code so similar-named films are never confused. A resolved id is
  // cached forever (stable); a miss is cached briefly so we don't spam.
  async function imdbId(tmdbId, kind) {
    if (!hasKey()) return null;
    if (!tmdbId) return null;
    const cache = _loadCache();
    const slot = `imdb.${kind === 'tv' ? 'tv' : 'movie'}.${tmdbId}`;
    const c = cache[slot];
    if (c && c.id) return c.id;
    if (c && !c.id && _isFresh(c)) return null;
    let id = null;
    try {
      const j = await _fetch((kind === 'tv' ? '/tv/' : '/movie/') + tmdbId + '/external_ids');
      id = (j && j.imdb_id) || null;
    } catch (_) {}
    cache[slot] = { id, at: Date.now() };
    _evictOldest(cache, 'imdb.', IMDB_CACHE_SOFT_CAP);
    _saveCache(cache);
    return id;
  }

  // Resolve a TITLE (+optional year) straight to an IMDb id. Search TMDB for
  // the feature, then map its tmdb_id via /external_ids. Used by the subtitle
  // finder: an id-anchored OpenSubtitles search can't land on the wrong film,
  // a fuzzy text query can. Cached by normalized title+year.
  async function imdbIdForTitle(title, year, kind = 'movie') {
    if (!hasKey()) return null;
    const t = String(title || '').trim();
    if (!t) return null;
    const norm = t.toLowerCase().replace(RE_NON_ALNUM, '');
    const cache = _loadCache();
    const slot = `imdbq.${kind}.${norm}.${year || ''}`;
    const c = cache[slot];
    if (c && c.id) return c.id;
    if (c && !c.id && _isFresh(c)) return null;
    let id = null;
    try {
      const q = encodeURIComponent(t);
      const yq = year ? (kind === 'tv' ? `&first_air_date_year=${year}`
                                       : `&primary_release_year=${year}`) : '';
      const j = await _fetch(`/search/${kind === 'tv' ? 'tv' : 'movie'}?query=${q}${yq}&page=1`);
      const hit = ((j && j.results) || [])[0];
      if (hit && hit.id) id = await imdbId(hit.id, kind);
    } catch (_) {}
    cache[slot] = { id, at: Date.now() };
    _evictOldest(cache, 'imdbq.', IMDB_CACHE_SOFT_CAP);
    _saveCache(cache);
    return id;
  }

  // Popular movies from a given year (by TMDB popularity). Used to backfill a
  // thin weekly-trending row. vote_count gate keeps it to real, watchable films.
  async function popularMovies(year, limit = 20) {
    if (!hasKey()) return [];
    const cache = _loadCache();
    const slot = `popular.movie.${year || 'all'}`;
    if (_isFresh(cache[slot]) && cache[slot].data) return cache[slot].data.slice(0, limit);
    const yq = year ? `&primary_release_year=${year}` : '';
    const j = await _fetch(`/discover/movie?sort_by=popularity.desc&vote_count.gte=50&page=1${yq}`);
    const items = (j.results || []).map(r => _normalize(r, 'movie'));
    cache[slot] = { at: Date.now(), data: items };
    _evictOldest(cache, 'popular.', POPULAR_CACHE_SOFT_CAP);
    _saveCache(cache);
    return items.slice(0, limit);
  }

  // ---- per-key cache clear (used when user signs out / changes key) ----
  function clearCache() {
    _cacheMem = {};
    try { localStorage.removeItem(CACHE_STORAGE); } catch (_) {}
  }

  return {
    getKey, setKey, hasKey,
    trendingAll, trendingMovies, trendingTV,
    trendingDay, trendingWeek,
    imdbId, imdbIdForTitle, popularMovies,
    clearCache,
    POSTER_BASE, POSTER_TINY,
  };
})();
