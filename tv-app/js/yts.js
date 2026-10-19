// services/yts.js — YTS movie metadata + magnet construction
//
// YTS does send Access-Control-Allow-Origin: * on its public API, so this
// works directly from the TV with no proxy. If a future YTS change breaks
// CORS, we fall back to apibay.

const YTS = (() => {
  const TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
  ];
  // Pre-encode the tracker query fragment once — magnet() is called per
  // playback and the tracker list never changes, so this avoids re-mapping
  // and re-encoding the same 5 URLs on every call.
  const TRACKERS_QS = TRACKERS.map(u => `tr=${encodeURIComponent(u)}`).join('&');

  const HOSTS = [
    'https://movies-api.accel.li/api/v2',
    'https://yts.mx/api/v2',
  ];

  // Small bounded cache for GET results, keyed by path+querystring. Keeps
  // repeat lookups (e.g. detail() for a movie already seen in search()) off
  // the network while bounding memory use on constrained TV runtimes. TTL is short since browse/search results go stale quickly;
  // app.js layers its own longer-lived cache on top for browse().
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const CACHE_MAX = 40;
  const cache = new Map(); // key -> { at, data }
  const inFlight = new Map(); // key -> Promise, dedupes concurrent identical requests

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > CACHE_TTL_MS) {
      cache.delete(key);
      return undefined;
    }
    // Touch for LRU: re-insert so it's last (most-recently-used).
    cache.delete(key);
    cache.set(key, hit);
    return hit.data;
  }

  function cacheSet(key, data) {
    if (cache.size >= CACHE_MAX) {
      // Map preserves insertion order, so the first key is the oldest/LRU.
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), data });
  }

  async function _try(host, path, qs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch(`${host}${path}?${qs}`, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (data.status !== 'ok') throw new Error(data.status_message || 'yts error');
      return data.data;
    } finally {
      clearTimeout(timer);
    }
  }

  async function call(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const key = `${path}?${qs}`;

    const cached = cacheGet(key);
    if (cached !== undefined) return cached;

    const pending = inFlight.get(key);
    if (pending) return pending;

    const p = (async () => {
      let lastErr;
      for (const h of HOSTS) {
        try {
          const data = await _try(h, path, qs);
          cacheSet(key, data);
          return data;
        } catch (e) { lastErr = e; }
      }
      throw lastErr;
    })();

    inFlight.set(key, p);
    try {
      return await p;
    } finally {
      inFlight.delete(key);
    }
  }

  function search(query, { limit = 20, sort_by = 'seeds', minimum_rating = 0 } = {}) {
    return call('/list_movies.json', { query_term: query, limit, sort_by, minimum_rating });
  }

  function detail(id) {
    return call('/movie_details.json', { movie_id: id, with_images: true, with_cast: true });
  }

  // Same sort taxonomy the web Movies tab uses. "trending" is synthesized:
  // YTS has no real trending feed, so we sort by date_added then re-rank by
  // download_count to approximate "what people are watching this week".
  const SORTS = {
    trending: ['download_count', 'desc'],
    liked:    ['like_count',     'desc'],
    rating:   ['rating',         'desc'],
    newest:   ['date_added',     'desc'],
    year:     ['year',           'desc'],
  };

  async function browse({ sort = 'trending', genre = '', minRating = 0, query = '', page = 1, limit = 30 } = {}) {
    if (sort === 'trending' && !query) {
      // pull more rows and re-rank by download count
      const recent = await call('/list_movies.json', {
        sort_by: 'date_added', order_by: 'desc',
        limit: Math.min(50, limit * 2), page,
        ...(genre ? { genre } : {}),
        ...(minRating ? { minimum_rating: minRating } : {}),
      });
      // Slice before sort so we never mutate the (possibly cached) array
      // backing `recent.movies` — call() may hand the same reference back
      // to a future identical request.
      const movies = ((recent && recent.movies) || []).slice();
      movies.sort((a, b) => (b.download_count || 0) - (a.download_count || 0));
      return { movies: movies.slice(0, limit), total: recent.movie_count || movies.length };
    }
    const [sort_by, order_by] = SORTS[sort] || SORTS.trending;
    const params = { sort_by, order_by, limit, page };
    if (genre) params.genre = genre;
    if (minRating) params.minimum_rating = minRating;
    if (query) params.query_term = query;
    const data = await call('/list_movies.json', params);
    return { movies: (data && data.movies) || [], total: (data && data.movie_count) || 0 };
  }

  // Given a YTS "torrent" item (hash, quality), build a magnet URI.
  function magnet(t, name) {
    const dn = encodeURIComponent(name || 'movie');
    return `magnet:?xt=urn:btih:${t.hash}&dn=${dn}&${TRACKERS_QS}`;
  }

  return { search, browse, detail, magnet, TRACKERS, SORTS };
})();
