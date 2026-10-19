// js/tvmaze.js — canonical episode list source.
//
// TVMaze is a free public API with no key required. We use it to know the
// real season/episode counts for a show (e.g. S03 has 13 episodes) so the
// picker can show every episode, not just the ones apibay happens to seed.
//
//   GET /search/shows?q=<title>     → first hit's show id
//   GET /shows/<id>/episodes        → flat list of all episodes
//
// Cached in localStorage: search hits for 7 days, episode lists for 24 h.

const TVMaze = (() => {
  const SEARCH = 'https://api.tvmaze.com/search/shows';
  const SHOWS  = 'https://api.tvmaze.com/shows';

  const WEEK_MS = 7 * 24 * 3600000;
  const DAY_MS  = 24 * 3600000;

  function ckey(k) { return 'tvmaze:' + k; }
  function cget(k, ttlMs) {
    const v = Storage.get(ckey(k), null);
    if (!v || !v.at || (Date.now() - v.at) > ttlMs) return null;
    return v.data;
  }
  function cset(k, data) { Storage.set(ckey(k), { at: Date.now(), data }); _evictFamily(k); }

  // Bound on-disk growth: cap each cache family (episode lists, search
  // hits — `search:` and `searchm:` share one pool) at ~30 entries,
  // evicting the oldest by the `at` timestamp every entry already carries
  // once the cap is exceeded. Mirrors the 30-entry LRU convention already
  // used in js/opensubs.js. Runs only on write, so the TTL checks in cget
  // above are unaffected and a cache hit still returns exactly what was
  // stored.
  const CACHE_CAP = 30;
  function _evictFamily(k) {
    const prefix = k.startsWith('eps:') ? 'tvmaze:eps:' : 'tvmaze:search';
    const blob = Storage.load();
    const keys = Object.keys(blob).filter(kk => kk.startsWith(prefix));
    if (keys.length <= CACHE_CAP) return;
    keys.sort((a, b) => ((blob[a] && blob[a].at) || 0) - ((blob[b] && blob[b].at) || 0));
    for (const kk of keys.slice(0, keys.length - CACHE_CAP)) delete blob[kk];
    Storage.save(blob);
  }

  async function fetchTimeout(url, ms = 8000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try { return await fetch(url, { signal: ac.signal }); }
    finally { clearTimeout(t); }
  }

  // In-flight promise guard, shared by all three network-backed calls below
  // (their cache keys are prefixed `search:` / `searchm:` / `eps:` so they
  // never collide in one Map). Several call sites in app.js resolve the same
  // show/episode list back-to-back (e.g. two independent `seasonMap(title)`
  // calls racing on first load) — without this they'd fire duplicate TVMaze
  // requests and duplicate localStorage writes; with it, the second caller
  // just awaits the first's in-flight promise.
  const _inflight = new Map();

  function _titleKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }
  function _yearValue(value) {
    const match = String(value || '').match(/\b(19\d{2}|20\d{2})\b/);
    return match ? match[1] : '';
  }
  // TVMaze search is relevance-ranked, not identity-safe. Same-title remakes
  // such as Example Show (2000) and Example Show (2020) can swap first place,
  // so prefer the exact title + premiere year selected by TMDB.
  function pickSearchShow(rows, title, year) {
    const hits = (Array.isArray(rows) ? rows : [])
      .map(row => row && row.show).filter(Boolean);
    if (!hits.length) return null;
    const wantedTitle = _titleKey(title);
    const exactTitle = hits.filter(show => _titleKey(show.name) === wantedTitle);
    const candidates = exactTitle.length ? exactTitle : hits;
    const wantedYear = _yearValue(year);
    if (wantedYear) {
      const exactYear = candidates.find(show => _yearValue(show.premiered) === wantedYear);
      if (exactYear) return exactYear;
    }
    return candidates[0] || null;
  }

  async function searchShow(title, year) {
    const wantedYear = _yearValue(year);
    const key = 'search:' + title.toLowerCase() + (wantedYear ? ':' + wantedYear : '');
    const hit = cget(key, WEEK_MS);
    if (hit !== null) return hit;
    const cached = _inflight.get(key);
    if (cached) return cached;
    const p = (async () => {
      const r = await fetchTimeout(`${SEARCH}?q=${encodeURIComponent(title)}`);
      // Don't poison the cache on a transient failure (rate limit, timeout).
      if (!r.ok) return null;
      const arr = await r.json().catch(() => []);
      const top = pickSearchShow(arr, title, wantedYear);
      const exactTitleHits = (Array.isArray(arr) ? arr : [])
        .map(row => row && row.show).filter(Boolean)
        .filter(show => _titleKey(show.name) === _titleKey(title));
      const sameTitleYears = [...new Set(exactTitleHits
        .map(show => _yearValue(show.premiered)).filter(Boolean))];
      const out = top ? {
        id: top.id,
        name: top.name,
        premiered: top.premiered || '',
        // The tracker picker uses this only to decide whether an otherwise
        // normal title search needs strict year qualification.
        ambiguous: exactTitleHits.length > 1,
        same_title_years: sameTitleYears,
        image: (top.image && (top.image.original || top.image.medium)) || '',
        // IMDb id (e.g. "tt0000000") — passed through to OpenSubtitles for
        // exact-show subtitle search. Falls back to null if TVMaze doesn't
        // have it (some obscure shows).
        imdb_id: (top.externals && top.externals.imdb) || null,
      } : null;
      cset(key, out);
      return out;
    })().then(value => { _inflight.delete(key); return value; }, error => { _inflight.delete(key); throw error; });
    _inflight.set(key, p);
    return p;
  }

  // Multi-result show search — returns several candidates (with imdb + country
  // so the UI can disambiguate regional variants of Example Show).
  // Used as the TV-search fallback when apibay (the usual episode index) is down.
  async function searchShows(title, limit = 6) {
    const key = 'searchm:' + title.toLowerCase();
    const hit = cget(key, WEEK_MS);
    if (hit !== null) return (hit || []).slice(0, limit);
    let p = _inflight.get(key);
    if (!p) {
      p = (async () => {
        // Single pass over the raw hits straight into the slim shape —
        // avoids the map/filter/map three-array churn of the original.
        const out = [];
        try {
          const r = await fetchTimeout(`${SEARCH}?q=${encodeURIComponent(title)}`);
          if (r.ok) {
            const arr = await r.json().catch(() => []);
            if (Array.isArray(arr)) {
              for (let i = 0; i < arr.length; i++) {
                const s = arr[i] && arr[i].show;
                if (!s) continue;
                out.push({
                  id: s.id,
                  name: s.name,
                  premiered: s.premiered || '',
                  country: (s.network && s.network.country && s.network.country.code) ||
                           (s.webChannel && s.webChannel.country && s.webChannel.country.code) || '',
                  image: (s.image && (s.image.medium || s.image.original)) || '',
                  imdb_id: (s.externals && s.externals.imdb) || null,
                });
              }
            }
            cset(key, out);
          }
        } catch (_) {}
        return out;
      })().then(value => { _inflight.delete(key); return value; }, error => { _inflight.delete(key); throw error; });
      _inflight.set(key, p);
    }
    const out = await p;
    return out.slice(0, limit);
  }

  async function episodes(showId) {
    const key = 'eps:' + showId;
    const hit = cget(key, DAY_MS);
    if (hit) return hit;
    let p = _inflight.get(key);
    if (!p) {
      p = (async () => {
        const r = await fetchTimeout(`${SHOWS}/${showId}/episodes`);
        if (!r.ok) return [];
        const arr = await r.json().catch(() => []);
        const n = Array.isArray(arr) ? arr.length : 0;
        // Pre-sized array instead of .map() — one allocation, no growth.
        const slim = new Array(n);
        for (let i = 0; i < n; i++) {
          const e = arr[i];
          slim[i] = { season: e.season, number: e.number, name: e.name || '', airdate: e.airdate || '' };
        }
        cset(key, slim);
        return slim;
      })().then(value => { _inflight.delete(key); return value; }, error => { _inflight.delete(key); throw error; });
      _inflight.set(key, p);
    }
    return p;
  }

  // Returns { show, seasons: Map(seasonNum -> [episode...]) }
  // Specials (season 0) are skipped — they confuse the season chip UI.
  async function seasonMap(title, year) {
    const show = await searchShow(title, year);
    if (!show) return null;
    const eps = await episodes(show.id);
    const seasons = new Map();
    for (const e of eps) {
      if (!e.season) continue;
      if (!seasons.has(e.season)) seasons.set(e.season, []);
      seasons.get(e.season).push(e);
    }
    for (const list of seasons.values()) {
      list.sort((a, b) => a.number - b.number);
    }
    return { show, seasons };
  }

  return { searchShow, searchShows, episodes, seasonMap };
})();
