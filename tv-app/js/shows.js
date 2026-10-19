// js/shows.js — "Shows" tab: a TV-show browser mirroring the Movies tab's
// UX (filter chips + sort + grid of poster tiles), plus two things Movies
// doesn't need: (a) a per-title QUALITY badge sourced from live torrent
// results, and (b) a "Watch Later" action that downloads straight to the
// LAPTOP's disk cache (via the server's aria2c torrent downloader) instead
// of the phone pen.
//
// LOAD ORDER: plain classic script, no import/export. Must load AFTER
// tvmaze.js / tmdb.js / eztv.js / apibay.js / knaben.js / trending.js /
// laptopcache.js / remux.js / dpad.js / storage.js, and BEFORE app.js — so
// this file's top level must never reference the bare `App` identifier
// (it's only touched from inside click handlers fired well after boot,
// exactly like the load-order constraint the rest of the app already
// follows).
//
// OWNERSHIP: this file is 100% self-contained. Movies' own filter/grid/
// modal logic lives entirely inside app.js's private `App` IIFE with no
// exposed helpers (parseEpisodeName, makeMovieTile, openMovieModal,
// moviesState, pickSeasonVariant, pickSeasonPack, escapeHtml, toast,
// fmtSize — none of it is returned from App's IIFE, see app.js's
// `return { showTab, addToQueue };`). Shows therefore REIMPLEMENTS the
// *shape* of that UX as new code, calling only free-standing globals
// (TVMaze, TMDB, Trending, ApiBay, EZTV, Knaben, LaptopCache, Remux, DPad,
// Storage) plus the one already-public App method, `App.addToQueue`, for
// the Play action.
//
// PRODUCTION SURFACE: `Shows.onShow()` — the only thing app.js calls.
// `Shows._test` is an ADDITIVE, test-only surface (pure functions with no
// DOM/fetch side effects) so the headless harness can exercise real logic
// without scraping the DOM. app.js never touches `_test`.

const Shows = (() => {
  // ---------- private state (never touched by app.js) ----------
  let showsState = { sort: 'trending', genre: '', decade: '', query: '', page: 1 };

  // Mirrors app.js's moviesBrowseCache: JSON.stringify(state) -> {at, data},
  // 10-min TTL, 24-entry LRU cap.
  const showsBrowseCache = new Map();
  const BROWSE_TTL_MS = 600000;
  const BROWSE_CAP = 24;

  // Monotonic serial guard — mirrors app.js's _moviesReq. Fast filter
  // changes (sort -> genre -> decade within the debounce window) each
  // start their own loadShows(); if a slower fetch resolves AFTER a
  // faster one with newer filters, it's dropped instead of clobbering
  // the grid with stale results.
  let _showsReq = 0;

  // Session cache for the lazy on-focus tile quality badge, keyed by
  // tmdb_id -> { badges:[...], ts }. Re-focusing a tile never re-fetches.
  // LRU-capped the same way as its sibling showsBrowseCache above (oldest-
  // by-ts eviction once the cap is exceeded) — unlike showsBrowseCache this
  // grows one entry per distinct SHOW ever focused rather than per filter
  // combo, so left unbounded it accumulates for the entire session as the
  // user scrolls.
  const _qualityCache = new Map();
  const QUALITY_CACHE_CAP = 150;
  const _qualityInflight = new Map(); // tmdb_id -> in-flight Promise<badges>

  let _bound = false;        // one-time chip/DOM binder guard
  let _searchTimer = null;

  const PAGE_SIZE = 20;                 // TMDB's own page size
  const FOCUS_DEBOUNCE_MS = 350;        // don't fire N lookups on fast d-pad scroll
  const FETCH_TIMEOUT_MS = 8000;
  const TMDB_API_BASE = 'https://api.themoviedb.org/3';

  // Static TMDB TV genre id -> name (same idiom Movies already uses for
  // YTS genres — no dynamic /genre/tv/list call needed).
  const GENRES = [
    ['10759', 'Action & Adventure'], ['16', 'Animation'], ['35', 'Comedy'],
    ['80', 'Crime'], ['99', 'Documentary'], ['18', 'Drama'],
    ['10751', 'Family'], ['10762', 'Kids'], ['9648', 'Mystery'],
    ['10763', 'News'], ['10764', 'Reality'], ['10765', 'Sci-Fi & Fantasy'],
    ['10766', 'Soap'], ['10767', 'Talk'], ['10768', 'War & Politics'],
    ['37', 'Western'],
  ];
  function _genreName(id) {
    const hit = GENRES.find(g => g[0] === String(id));
    return hit ? hit[1] : null;
  }

  // Decade -> TMDB discover first_air_date RANGE (TMDB's own
  // first_air_date_year param is a single year, not a range).
  const DECADE_RANGES = {
    '2020s': ['2020-01-01', '2029-12-31'],
    '2010s': ['2010-01-01', '2019-12-31'],
    '2000s': ['2000-01-01', '2009-12-31'],
    '1990s': ['1990-01-01', '1999-12-31'],
    classic: ['1900-01-01', '1989-12-31'],
  };

  // ---------- tiny local helpers (app.js's escapeHtml/toast are private
  // to its own closure — reimplemented here, not imported) ----------
  function _qsa(sel) { return [...document.querySelectorAll(sel)]; }
  function _escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function _toast(msg, ms) {
    try {
      const t = document.getElementById('toast');
      if (!t) return;
      t.textContent = msg;
      t.classList.add('is-shown');
      clearTimeout(_toast._t);
      _toast._t = setTimeout(() => t.classList.remove('is-shown'), ms || 2400);
    } catch (_) {}
  }

  // ---------- TMDB auth (tmdb.js's _fetch/_doFetch are private to its own
  // closure with no discover/search-tv support — this is a shows.js-LOCAL
  // authenticated fetch reusing the already-public TMDB.getKey()/hasKey(),
  // mirroring tmdb.js's own v3-key-vs-v4-token branch exactly) ----------
  const RE_V4_TOKEN = /^eyJ/;
  function _authedUrl(path, params) {
    const key = TMDB.getKey();
    const isV4 = RE_V4_TOKEN.test(key || '');
    const qs = new URLSearchParams(params || {});
    qs.set('language', 'en');
    if (!isV4) qs.set('api_key', key || '');
    const headers = { Accept: 'application/json' };
    if (isV4) headers.Authorization = 'Bearer ' + key;
    return { url: `${TMDB_API_BASE}${path}?${qs.toString()}`, headers };
  }
  async function _tmdbGet(path, params) {
    const { url, headers } = _authedUrl(path, params);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(url, { headers, signal: ctrl.signal });
      if (!r.ok) throw new Error(`TMDB ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  // Shapes a raw TMDB /discover/tv or /search/tv row into the tile-friendly
  // form (tmdb.js's own _normalize is private + movie/tv-generic; this is a
  // shows.js-local equivalent so genre_ids/first_air_date survive, which
  // sortAndFilter() needs).
  function _normalizeTv(r) {
    return {
      tmdb_id: r.id,
      title: r.name || r.original_name || '',
      year: (r.first_air_date || '').slice(0, 4) || '',
      first_air_date: r.first_air_date || '',
      poster: r.poster_path ? (TMDB.POSTER_BASE + r.poster_path) : null,
      poster_sm: r.poster_path ? (TMDB.POSTER_TINY + r.poster_path) : null,
      vote: Math.round((r.vote_average || 0) * 10) / 10,
      genre_ids: r.genre_ids || [],
      overview: r.overview || '',
    };
  }

  // ---------- pure query builder (Shows._test.buildDiscoverQuery) ----------
  // Returns { path, params } — no fetch side effect, independently testable.
  function buildDiscoverQuery(state) {
    state = state || {};
    const params = { page: state.page || 1, 'vote_count.gte': 20 };
    if (state.genre) params.with_genres = state.genre;
    const range = DECADE_RANGES[state.decade];
    if (range) {
      params['first_air_date.gte'] = range[0];
      params['first_air_date.lte'] = range[1];
    }
    switch (state.sort) {
      case 'top_rated':
        // Gate against single-vote outliers — same vote-count-floor
        // precedent as tmdb.js's own popularMovies() (tmdb.js:244).
        params.sort_by = 'vote_average.desc';
        params['vote_count.gte'] = 50;
        break;
      case 'recent':
        params.sort_by = 'first_air_date.desc';
        break;
      case 'popular':
      default:
        params.sort_by = 'popularity.desc';
        break;
    }
    return { path: '/discover/tv', params };
  }

  // ---------- pure filter+sort (Shows._test.sortAndFilter) ----------
  // Used (a) as the client-side filter for the 'trending' branch — TMDB's
  // trending endpoint takes no genre/decade/query params, so those are
  // applied here instead — and (b) as a standalone, independently-testable
  // filter/sort utility. `items` are already-normalized show objects
  // (genre_ids/first_air_date/year/title/vote as shaped by _normalizeTv,
  // or TMDB.trendingTV()'s own shape, which lacks genre_ids — genre
  // filtering is a no-op when that field is absent, documented at the
  // trending call site below rather than here).
  function sortAndFilter(items, state) {
    state = state || {};
    let out = (items || []).slice();
    if (state.query) {
      const q = state.query.trim().toLowerCase();
      if (q) out = out.filter(x => (x.title || '').toLowerCase().includes(q));
    }
    if (state.genre) {
      out = out.filter(x => Array.isArray(x.genre_ids)
        && x.genre_ids.map(String).includes(String(state.genre)));
    }
    const range = DECADE_RANGES[state.decade];
    if (range) {
      out = out.filter((x) => {
        const d = x.first_air_date || (x.year ? (x.year + '-01-01') : '');
        return !!d && d >= range[0] && d <= range[1];
      });
    }
    switch (state.sort) {
      case 'top_rated':
        out.sort((a, b) => (b.vote || 0) - (a.vote || 0));
        break;
      case 'recent':
        out.sort((a, b) => (b.first_air_date || '').localeCompare(a.first_air_date || ''));
        break;
      default:
        break; // 'trending' / 'popular' — keep the source's own ordering
    }
    return out;
  }

  // ---------- fetchers (side-effecting; not part of _test) ----------
  async function _fetchTrending(state) {
    // Zero new fetch code for the default sort — TMDB.trendingTV() is
    // already public and 12h-cached. genre_ids isn't part of its shape,
    // so genre filtering is skipped for this branch (decade/query still
    // apply via sortAndFilter, both of which work off fields trendingTV()
    // DOES carry: year/title).
    const raw = await TMDB.trendingTV(60);
    const items = sortAndFilter(raw, Object.assign({}, state, { genre: '' }));
    return { items, total: items.length };
  }
  async function _fetchDiscover(state) {
    const { path, params } = buildDiscoverQuery(state);
    const j = await _tmdbGet(path, params);
    const items = (j.results || []).map(_normalizeTv);
    return { items, total: j.total_results || items.length };
  }
  async function _fetchSearch(state) {
    const j = await _tmdbGet('/search/tv', { query: state.query, page: state.page || 1 });
    const items = sortAndFilter((j.results || []).map(_normalizeTv),
      Object.assign({}, state, { query: '' })); // query already applied server-side
    return { items, total: j.total_results || items.length };
  }

  function _isTrendingBranch(state) {
    return state.sort === 'trending' && !state.genre && !state.query;
  }

  // ---------- quality parsing (Shows._test.parseQualityBadges) ----------
  // Reuses the already-public Trending.detectQuality() for resolution+HDR
  // (same precedence table as app.js's private parseEpisodeName — app.js
  // never exposes that function, see the file-header note) plus one small
  // LOCAL regex for the source/codec tag, built from the identical token
  // vocabulary already proven at trending.js:26 / app.js:2031. Returns an
  // ORDERED SET of distinct badges (not a single best-of reduction like
  // app.js's libQualityBadge) — requirement 1(a) asks for every quality
  // available, not one pick.
  const RE_SOURCE_TAG = /\b(WEB[. _-]?DL|WEBRip|BluRay|BDRip|HDTV)\b/i;
  function _sourceTag(name) {
    const m = String(name || '').match(RE_SOURCE_TAG);
    if (!m) return '';
    return m[0].toUpperCase().replace(/[. _]/g, '').replace(/^WEBDL$/, 'WEB-DL');
  }
  function parseQualityBadges(names) {
    const seen = new Set();
    const out = [];
    (names || []).forEach((name) => {
      if (!name) return;
      const detected = (typeof Trending !== 'undefined' && Trending.detectQuality)
        ? Trending.detectQuality(name) : [];   // ['4K','HDR'] / ['1080p'] / []
      const src = _sourceTag(name);
      const parts = detected.slice();
      if (src) parts.push(src);
      if (!parts.length) return; // nothing recognizable — don't stamp junk
      const label = parts.join(' ');
      if (!seen.has(label)) { seen.add(label); out.push(label); }
    });
    return out;
  }

  // ---------- episode-name classifier (small, LOCAL reimplementation of
  // app.js's private parseEpisodeName — same closure-encapsulation reason
  // as the quality parser: app.js never exposes it. Only the piece Shows
  // actually needs — season/pack detection, not the full label-building —
  // is reimplemented here.) ----------
  const RE_EP = /\b[Ss](\d{1,2})[. _-]?[Ee](\d{1,3})\b/;
  const RE_EP_CROSS = /\b(\d{1,2})x(\d{1,3})\b/i;
  const RE_SEASON_PACK = /\b(?:Season|S)[. _-]?(\d{1,2})\b/i;
  const RE_COMPLETE = /\b(complete|all\s*seasons|series)\b/i;
  function _classify(name) {
    const n = String(name || '');
    const ep = n.match(RE_EP) || n.match(RE_EP_CROSS);
    if (ep) return { season: parseInt(ep[1], 10), episode: parseInt(ep[2], 10), isPack: false };
    const season = n.match(RE_SEASON_PACK);
    if (season) return { season: parseInt(season[1], 10), episode: 0, isPack: true };
    if (RE_COMPLETE.test(n)) return { season: 0, episode: 0, isPack: true };
    return { season: 0, episode: 0, isPack: false };
  }

  // Best single-episode release: prefer a clean 1080p that isn't absurdly
  // large, else the most-seeded. Small reimplementation of app.js's private
  // pickSeasonVariant — same selection RULE, copied verbatim; only the
  // input shape differs (flat apibay/EZTV/Knaben-shaped rows here, not the
  // {t,p} wrapper app.js's openTvShow builds).
  const RE_1080 = /\b1080p\b/i;
  function pickBestVariant(rows) {
    if (!rows || !rows.length) return null;
    const scored = rows.map((r) => {
      const size = parseInt(r.size || 0, 10) || 0;
      const seeders = parseInt(r.seeders || 0, 10) || 0;
      const is1080 = RE_1080.test(r.name || '') ? 1 : 0;
      const tooBig = size > 6 * 1024 * 1024 * 1024 ? 1 : 0;
      return { r, tier: is1080 - tooBig, seeders };
    });
    scored.sort((a, b) => (b.tier - a.tier) || (b.seeders - a.seeders));
    return scored[0] ? scored[0].r : null;
  }

  // Best full-SEASON pack. Small reimplementation of app.js's private
  // pickSeasonPack — same rule (1080p wins, 4K last resort, then seeders).
  const RE_4K = /\b(?:2160p|4k|uhd)\b/i;
  function pickBestPack(rows) {
    if (!rows || !rows.length) return null;
    const scored = rows.map((r) => {
      const name = r.name || '';
      const seeders = parseInt(r.seeders || 0, 10) || 0;
      const is1080 = RE_1080.test(name) ? 1 : 0;
      const is4k = RE_4K.test(name) ? 1 : 0;
      return { r, tier: is1080 * 2 - is4k, seeders };
    });
    scored.sort((a, b) => (b.tier - a.tier) || (b.seeders - a.seeders));
    return scored[0] ? scored[0].r : null;
  }

  const MAX_PLAY_BYTES = 5 * 1024 * 1024 * 1024;
  function pickSeasonPlay(rows) {
    const usable = (rows || []).filter(r => (parseInt(r.size || 0, 10) || 0) <= MAX_PLAY_BYTES
      && (parseInt(r.seeders || 0, 10) || 0) > 0);
    const packs = usable.filter(r => _classify(r.name).isPack);
    if (packs.length) return pickBestPack(packs);
    const episodes = usable.filter(r => _classify(r.name).episode > 0);
    if (!episodes.length) return null;
    const first = Math.min.apply(null, episodes.map(r => _classify(r.name).episode));
    return pickBestVariant(episodes.filter(r => _classify(r.name).episode === first));
  }

  // ---------- request-shape builders (Shows._test.build*Payload) ----------
  // Exact call shape copied verbatim from app.js's downloadSeasonToServer
  // (app.js:2594-2634) — the proven laptop-download path. No network side
  // effect; returns the plain object LaptopCache.addTorrent's first argument
  // expects, so this is independently testable.
  function buildWatchLaterPayload(show, season, pick) {
    const sStr = String(season).padStart(2, '0');
    return { source: ApiBay.magnet(pick), name: `${show && show.title} S${sStr}` };
  }

  // Exact shape App.addToQueue expects (app.js:3554's destructured params).
  function buildAddToQueuePayload(show, label, pick, context) {
    const cls = _classify((pick && pick.name) || '');
    context = context || {};
    return {
      name: `${show && show.title} ${label || ''}`.trim(),
      magnet: ApiBay.magnet(pick),
      infoHash: (pick && pick.info_hash || '').toLowerCase(),
      poster: (show && show.poster) || null,
      show: {
        title: show && show.title,
        poster: (show && show.poster) || null,
        year: (show && show.year) || null,
        identityAmbiguous: !!(show && show.identityAmbiguous),
        season: context.season || cls.season || null,
        episode: cls.episode || context.episode || 1,
        episodesInSeason: context.episodesInSeason || 0,
        seasonNums: context.seasonNums || [],
        imdbId: context.imdbId || null,
      },
      sizeBytes: parseInt((pick && pick.size) || 0, 10) || 0,
      autoplay: true,
    };
  }

  // ---------- torrent-name sourcing for quality lookups (ApiBay -> EZTV ->
  // Knaben fallback chain — the 'lazy per-tile/on-focus' option: NOT an
  // eager per-tile fetch across the whole grid, which would thrash EZTV's
  // 20-entry/5-min, ApiBay's 30-entry/15s, and Knaben's 12-entry/45s
  // caches) ----------
  // ApiBay query, matching the HOME page's proven recipe (app.js openTvShow):
  // title WITHOUT the year and WITHOUT a category filter. The old query did
  // the opposite twice over — it appended the show's start year (release
  // names carry the episode tag, not the series premiere year, so apibay's
  // naive keyword match returned nothing) AND passed cat 205, which is the
  // SD "TV shows" bucket only, silently excluding the HD categories where
  // every 1080p/2160p release actually lives. Together: "No torrents found"
  // on the Shows tab for the same show the Home page finds instantly.
  // The year variant is kept only as a RETRY for ordinary titles. When TVMaze
  // confirms that multiple series share the exact title, the year becomes a
  // required identity field: query it first and reject unqualified releases.
  function _releaseYearMatches(name, year) {
    const wanted = String(year || '').match(/\b(?:19\d{2}|20\d{2})\b/);
    if (!wanted) return true;
    const years = String(name || '').match(/\b(?:19\d{2}|20\d{2})\b/g) || [];
    return years.includes(wanted[0]);
  }
  // Unscoped trackers use keyword matching, so validate identity before a
  // nonempty response is allowed to suppress the IMDb-scoped EZTV fallback.
  function _filterShowRows(rows, title, year, strictYear) {
    const canonical = String(title || '').replace(/\s*\(\d{4}\).*$/, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '');
    return (rows || []).filter(row => {
      const name = String(row.name || '');
      if (!_classify(name).season && !RE_COMPLETE.test(name)) return false;
      const base = name.replace(/\b(?:s\d{1,2}(?:[. _-]?e\d{1,3})?|\d{1,2}x\d{1,3}|(?:season|series)[. _-]?\d{1,2}|complete|all\s*seasons)\b.*$/i, '')
        .replace(/\b(?:1080p|720p|480p|2160p|4k|uhd|web[. _-]?dl|webrip|bluray|hdtv|x26[45])\b.*$/i, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '');
      const titleMatches = base === canonical || base.replace(/(?:19|20)\d{2}$/, '') === canonical;
      if (!titleMatches) return false;
      // Ordinary releases often omit the premiere year. Require it only
      // for ambiguous titles, while still rejecting an explicit wrong year.
      const releaseYear = base === canonical ? '' : base.slice(canonical.length);
      return !year || (releaseYear ? releaseYear === String(year) : !strictYear);
    });
  }

  async function _apiBaySearch(title, year, strictYear) {
    const base = String(title || '').replace(/\s*\(\d{4}\).*$/, '').trim();
    let rows = [];
    const firstQuery = strictYear && year ? `${base} ${year}`.trim() : base;
    try { rows = await ApiBay.search(firstQuery); } catch (_) {}
    rows = _filterShowRows(rows, title, year, strictYear);
    if (!rows.length && year && !strictYear) {
      try { rows = _filterShowRows(await ApiBay.search(`${base} ${year}`.trim()), title, year, strictYear); } catch (_) {}
    }
    return rows;
  }
  async function _namesFromApiBay(title, year) {
    try {
      const rows = await _apiBaySearch(title, year);
      return (rows || []).map(r => r.name).filter(Boolean);
    } catch (_) { return []; }
  }
  async function _namesFromEztv(title, year) {
    try {
      const show = await TVMaze.searchShow(title, year);
      const imdb = show && show.imdb_id;
      if (!imdb) return [];
      const rows = await EZTV.showTorrents(imdb);
      return (rows || []).map(r => r.name).filter(Boolean);
    } catch (_) { return []; }
  }
  async function _namesFromKnaben(title, year) {
    try {
      const rows = _filterShowRows(await Knaben.search(title), title, year);
      return rows.map(r => r.name).filter(Boolean);
    } catch (_) { return []; }
  }
  // Single-flight + session-cached (per tmdb_id) lookup for the grid tile
  // badge. Debounced by the caller (~350ms) so fast d-pad scrolling never
  // fires N requests.
  async function _lookupQuality(tmdbId, title, year) {
    const cached = _qualityCache.get(tmdbId);
    if (cached) return cached.badges;
    const inflight = _qualityInflight.get(tmdbId);
    if (inflight) return inflight;
    const p = (async () => {
      let names = await _namesFromApiBay(title, year);
      if (!names.length) names = await _namesFromEztv(title, year);
      if (!names.length) names = await _namesFromKnaben(title, year);
      const badges = parseQualityBadges(names);
      _qualityCache.set(tmdbId, { badges, ts: Date.now() });
      if (_qualityCache.size > QUALITY_CACHE_CAP) {
        const entries = [..._qualityCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
        for (let i = 0; i < entries.length - QUALITY_CACHE_CAP; i++) _qualityCache.delete(entries[i][0]);
      }
      return badges;
    })();
    _qualityInflight.set(tmdbId, p);
    try { return await p; }
    finally { _qualityInflight.delete(tmdbId); }
  }

  function _scheduleTileQuality(tile) {
    const tmdbId = tile.dataset.tmdbId;
    if (!tmdbId) return;
    clearTimeout(tile._qTimer);
    tile._qTimer = setTimeout(() => {
      if (document.activeElement !== tile) return; // focus moved on before debounce fired
      const title = tile.dataset.heroTitle || '';
      const yearMatch = (tile.dataset.heroSubtitle || '').match(/\b(19|20)\d{2}\b/);
      _lookupQuality(tmdbId, title, yearMatch ? yearMatch[0] : '').then((badges) => {
        if (!badges || !badges.length) return;
        const q = tile.querySelector('.tile-qbadge');
        if (q) { q.textContent = badges.slice(0, 2).join(' · '); q.hidden = false; }
      });
    }, FOCUS_DEBOUNCE_MS);
  }

  // ---------- tile rendering ----------
  // Lazy-load tile posters via IntersectionObserver — ported verbatim from
  // app.js's Home/Movies tile pattern (app.js:2874-2935, see its comment
  // there for the full rationale). webOS has a hard ~200 MB WebView memory
  // cap; this grid can grow unbounded via "Load More" (showsState.page
  // keeps incrementing, tiles are only ever appended — see loadShows below),
  // so loading every poster up front, and never freeing the ones that
  // scroll off, tips the app into OOM-restart over a normal browsing
  // session. We only set background-image when the tile is within 1.5x
  // viewport-width of being visible, and CLEAR it when more than 3x
  // viewport-width away — freeing the decoded bitmap back to the GC. One
  // shared observer for the whole module means tiles from every "Load
  // More" page share the exact same eviction as the first page, instead of
  // each page accumulating its own permanently-loaded set.
  const _tileObserver = (typeof IntersectionObserver !== 'undefined')
    ? new IntersectionObserver((entries) => {
        for (const e of entries) {
          const el = e.target;
          const url = el.dataset.poster;
          if (!url) continue;
          if (e.isIntersecting) {
            if (!el.style.backgroundImage) {
              el.style.backgroundImage = `url("${url}")`;
            }
          } else {
            // Off-screen by margin — drop the bitmap back to the GC.
            el.style.backgroundImage = '';
            // Tile removed from the DOM entirely (grid reset on filter
            // change / re-search) fires this callback with
            // isIntersecting=false too — unobserve so the detached node
            // isn't held onto for the rest of the session. Guarded
            // `=== false` so ancient webOS builds without Node.isConnected
            // keep the old (leaky but working) behavior.
            if (el.isConnected === false) _tileObserver.unobserve(el);
          }
        }
      }, { rootMargin: '150% 0px' })   // start loading 1.5 viewports early
    : null;

  function _makeTile(show) {
    const t = document.createElement('button');
    t.className = 'tile';
    t.tabIndex = 0;
    t.dataset.tmdbId = String(show.tmdb_id);
    // data-hero-* is consumed by app.js's existing, tab-agnostic
    // bindBackgroundTracker — Shows gets the Home-hero-background
    // integration for free with zero app.js change.
    if (show.title) t.dataset.heroTitle = show.title;
    const sub = [show.year, show.vote ? `${show.vote}★` : null].filter(Boolean).join(' · ');
    if (sub) t.dataset.heroSubtitle = sub;

    // w185 thumbnail (~200 KB decoded), not w500 (~1.5 MB) — matches
    // app.js's own tile budget (app.js:1398-1401). The full-size `poster`
    // is still what buildWatchLaterPayload/buildAddToQueuePayload send
    // downstream (Library/Continue-Watching art, same as app.js's own
    // queue payloads), just never decoded as a grid tile background here.
    const posterSrc = show.poster_sm || show.poster;
    if (posterSrc) {
      const img = document.createElement('div');
      img.className = 'tile-poster';
      img.dataset.poster = posterSrc;
      // If IntersectionObserver isn't available (webOS 4 fallback), load
      // immediately so we don't end up with blank tiles.
      if (_tileObserver) _tileObserver.observe(img);
      else img.style.backgroundImage = `url("${posterSrc}")`;
      t.appendChild(img);
    } else {
      const fb = document.createElement('div');
      fb.className = 'tile-fallback';
      fb.textContent = show.title;
      t.appendChild(fb);
    }
    if (show.vote) {
      const badge = document.createElement('div');
      badge.className = 'tile-badge';
      badge.textContent = `★ ${show.vote}`;
      t.appendChild(badge);
    }
    // Empty quality-badge slot, filled in lazily on d-pad focus.
    const q = document.createElement('div');
    q.className = 'tile-qbadge';
    q.hidden = true;
    t.appendChild(q);

    const meta = document.createElement('div');
    meta.className = 'tile-meta';
    meta.innerHTML = `<div>${_escapeHtml(show.title)}</div>`
      + `<div style="opacity:.7;font-size:14px;">${_escapeHtml(show.year || '')}</div>`;
    t.appendChild(meta);

    t.onclick = () => openShowModal(show);
    return t;
  }

  // ---------- browse loader ----------
  async function loadShows(reset) {
    const req = ++_showsReq;
    if (reset) showsState.page = 1;
    const grid = document.getElementById('shows-grid');
    const statusEl = document.getElementById('shows-status');
    const moreBtn = document.getElementById('shows-more');
    if (!grid || !statusEl) return; // #tab-shows not wired yet
    if (reset) grid.innerHTML = '';
    statusEl.textContent = 'Loading…';
    if (moreBtn) moreBtn.style.display = 'none';

    if (!TMDB.hasKey()) {
      statusEl.textContent = 'Add a TMDB API key in Settings to browse TV shows.';
      return;
    }

    const cacheKey = JSON.stringify(showsState);
    let result;
    const cached = showsBrowseCache.get(cacheKey);
    if (cached && (Date.now() - cached.at) < BROWSE_TTL_MS) {
      result = cached.data;
    } else {
      try {
        if (showsState.query) result = await _fetchSearch(showsState);
        else if (_isTrendingBranch(showsState)) result = await _fetchTrending(showsState);
        else result = await _fetchDiscover(showsState);
        showsBrowseCache.set(cacheKey, { at: Date.now(), data: result });
        if (showsBrowseCache.size > BROWSE_CAP) {
          const entries = [...showsBrowseCache.entries()].sort((a, b) => a[1].at - b[1].at);
          for (let i = 0; i < entries.length - BROWSE_CAP; i++) showsBrowseCache.delete(entries[i][0]);
        }
      } catch (e) {
        if (req !== _showsReq) return;
        statusEl.textContent = 'TMDB unreachable: ' + (e && e.message || e);
        return;
      }
    }
    if (req !== _showsReq) return;
    const items = (result && result.items) || [];
    const total = (result && result.total) || items.length;
    if (!items.length) {
      statusEl.textContent = (showsState.page === 1)
        ? 'No shows match those filters.'
        : 'No more results.';
      return;
    }
    statusEl.textContent = '';
    const frag = document.createDocumentFragment();
    items.forEach(it => frag.appendChild(_makeTile(it)));
    grid.appendChild(frag);
    // The trending branch is capped to TMDB.trendingTV()'s own single page
    // (~20-60 items, no server-side pagination) — hide Load More there.
    if (moreBtn && !_isTrendingBranch(showsState) && total > showsState.page * PAGE_SIZE) {
      moreBtn.style.display = 'inline-block';
    }
    setTimeout(() => {
      const first = grid.firstElementChild;
      if (first && reset && typeof DPad !== 'undefined') { try { DPad.focus(first); } catch (_) {} }
    }, 50);
  }

  // ---------- chip/search/grid binding (once) ----------
  function _bindOnce() {
    if (_bound) return;
    _bound = true;

    const sortChips = _qsa('#shows-sort .chip');
    sortChips.forEach((c) => {
      c.onclick = () => {
        sortChips.forEach(x => x.classList.toggle('is-active', x === c));
        showsState.sort = c.dataset.sort || 'trending';
        loadShows(true);
      };
    });
    const genreChips = _qsa('#shows-genre .chip');
    genreChips.forEach((c) => {
      c.onclick = () => {
        genreChips.forEach(x => x.classList.toggle('is-active', x === c));
        showsState.genre = c.dataset.genre || '';
        loadShows(true);
      };
    });
    const decadeChips = _qsa('#shows-decade .chip');
    decadeChips.forEach((c) => {
      c.onclick = () => {
        decadeChips.forEach(x => x.classList.toggle('is-active', x === c));
        showsState.decade = c.dataset.decade || '';
        loadShows(true);
      };
    });

    const qInput = document.getElementById('shows-q');
    const qBtn = document.getElementById('shows-search-btn');
    if (qInput && qBtn) {
      qInput.addEventListener('input', (e) => {
        clearTimeout(_searchTimer);
        _searchTimer = setTimeout(() => {
          showsState.query = e.target.value.trim();
          qBtn.textContent = showsState.query ? `Search: ${showsState.query}` : 'Search…';
          loadShows(true);
        }, 300);
      });
      qInput.addEventListener('blur', () => {
        qInput.style.display = 'none';
        qInput.tabIndex = -1;
        qBtn.style.display = '';
        try { DPad.focus(qBtn); } catch (_) {}
      });
      qInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); qInput.blur(); }
      });
      qBtn.addEventListener('click', () => {
        qBtn.style.display = 'none';
        qInput.style.display = '';
        qInput.tabIndex = 0;
        qInput.value = showsState.query || '';
        qInput.focus();
      });
    }

    const moreBtn = document.getElementById('shows-more');
    if (moreBtn) {
      moreBtn.onclick = () => { showsState.page += 1; loadShows(false); };
    }

    const grid = document.getElementById('shows-grid');
    if (grid) {
      grid.addEventListener('focusin', (e) => {
        const tile = e.target && e.target.closest && e.target.closest('.tile');
        if (tile && grid.contains(tile)) _scheduleTileQuality(tile);
      });
    }
  }

  // ---------- modal (Play + Watch Later) ----------
  const _pendingWatchLater = new Set();

  function closeShowModal() {
    const modalEl = document.getElementById('modal');
    if (!modalEl || !modalEl.classList.contains('is-open')) return;
    modalEl.classList.remove('is-open');
    try { DPad.popBackHandler(); } catch (_) {}
  }

  async function _watchLaterSeason(show, seasonNum, pick) {
    const gated = typeof Remux !== 'undefined' && Remux.engine() === 'laptop'
      && typeof LaptopCache !== 'undefined' && LaptopCache.available();
    if (!gated) { _toast('Enable the laptop engine in Settings for Watch Later'); return; }

    const payload = buildWatchLaterPayload(show, seasonNum, pick);
    const dupKey = `${show.tmdb_id}:${seasonNum}`;
    // Duplicate-job guard: an in-flight local job, or an already-downloaded
    // file with a matching name prefix, both skip a redundant re-download.
    if (_pendingWatchLater.has(dupKey)) { _toast('Already downloading — check Library'); return; }
    try {
      const already = await LaptopCache.listAll();
      const nameLower = payload.name.toLowerCase();
      if ((already || []).some(f => (f.name || '').toLowerCase().indexOf(nameLower) === 0)) {
        _toast('Already on the laptop — check Library');
        return;
      }
    } catch (_) {}

    _pendingWatchLater.add(dupKey);
    const onTick = (t) => {
      if (t.status === 'error') {
        _pendingWatchLater.delete(dupKey);
        _toast('Laptop download failed: ' + (t.error || ''), 4000);
      } else if (t.status === 'ready') {
        _pendingWatchLater.delete(dupKey);
        const n = (t.rels || []).length;
        _toast(`✓ ${payload.name} on laptop — ${n} file${n === 1 ? '' : 's'} ready`, 4000);
      }
    };
    LaptopCache.addTorrent(payload, onTick);
    closeShowModal();
    _toast(`⬇ Downloading ${payload.name} to laptop`, 4000);
  }

  async function openShowModal(show) {
    const card = document.getElementById('modal-card');
    const modalEl = document.getElementById('modal');
    if (!card || !modalEl) return;
    card.innerHTML = '<h2>Loading…</h2>';
    if (!modalEl.classList.contains('is-open')) {
      try { DPad.pushBackHandler(closeShowModal); } catch (_) {}
    }
    modalEl.classList.add('is-open');

    let seasonData = null;
    try { seasonData = await TVMaze.seasonMap(show.title, show.year); } catch (_) {}

    const genres = (show.genre_ids || []).map(_genreName).filter(Boolean);
    const headerMeta = [show.year, show.vote ? show.vote + '★' : null, genres.join(', ')]
      .filter(Boolean).join(' · ');

    if (!seasonData || !seasonData.seasons || !seasonData.seasons.size) {
      card.innerHTML = `
        <h2>${_escapeHtml(show.title)}</h2>
        <p style="margin:12px 0;color:#aaa;">${_escapeHtml(headerMeta)}</p>
        <p>${_escapeHtml(show.overview || '')}</p>
        <p class="muted">No season data available for this title.</p>
        <div class="modal-actions"><button class="btn" id="shows-m-cancel">Cancel</button></div>`;
      const cancelBtn = document.getElementById('shows-m-cancel');
      if (cancelBtn) {
        cancelBtn.onclick = closeShowModal;
        setTimeout(() => { try { DPad.focus(cancelBtn); } catch (_) {} }, 50);
      }
      return;
    }

    const tvmazeSeasons = [...seasonData.seasons.keys()].sort((a, b) => a - b);
    const imdbId = (seasonData.show && seasonData.show.imdb_id) || null;
    const strictYear = !!(show.year && seasonData.show && seasonData.show.ambiguous);
    show.identityAmbiguous = strictYear;

    // Always-fresh lookup for the modal (accuracy matters more here than on
    // the grid tile) — bypasses the tile's session _qualityCache on purpose.
    let allRows = await _rowsForShowWithImdb(show.title, show.year, imdbId, strictYear);
    const bySeason = new Map();
    allRows.forEach((row) => {
      const c = _classify(row.name || '');
      if (!c.season) return;
      if (!bySeason.has(c.season)) bySeason.set(c.season, []);
      bySeason.get(c.season).push(Object.assign({}, row, { _cls: c }));
    });

    // Reconcile TVMaze's season numbering with the torrents' numbering.
    // TVMaze can return air-date-year seasons (e.g. Example Show: 2020,
    // 2021), while release names use S01, S02. Keying the render only on
    // TVMaze's numbers can hide valid torrent seasons. If the two numberings don't overlap
    // at all, render by the seasons the torrents actually have (what the
    // user can download); otherwise keep TVMaze's list and just append any
    // torrent-only seasons it missed. Standard shows (S01=1) are unchanged.
    const torrentSeasons = [...bySeason.keys()].sort((a, b) => a - b);
    const overlap = tvmazeSeasons.some(n => bySeason.has(n));
    let seasonNums;
    if (!overlap && torrentSeasons.length) {
      seasonNums = torrentSeasons;
    } else {
      seasonNums = tvmazeSeasons.slice();
      for (const s of torrentSeasons) if (!seasonNums.includes(s)) seasonNums.push(s);
      seasonNums.sort((a, b) => a - b);
    }

    card.innerHTML = `
      <h2>${_escapeHtml(show.title)}</h2>
      <p style="margin:12px 0;color:#aaa;">${_escapeHtml(headerMeta)}</p>
      <p>${_escapeHtml(show.overview || '')}</p>
      <h3 style="margin-top:24px;font-size:22px;">Seasons</h3>
      <div class="results-list" id="shows-season-list">
        ${seasonNums.map((n) => {
          const eps = seasonData.seasons.get(n) || [];
          const rows = bySeason.get(n) || [];
          const badges = parseQualityBadges(rows.map(r => r.name));
          const badgeStr = badges.length ? badges.slice(0, 3).join(' · ') : 'No torrents found';
          const dis = rows.length ? '' : 'disabled';
          // eps is empty for a torrent-only season (TVMaze had it under a
          // different number) — fall back to the torrent count so the row
          // still reads sensibly instead of "0 episodes".
          const epCount = eps.length || rows.filter(r => !r._cls.isPack).length;
          const epLabel = epCount ? ` — ${epCount} episode${epCount === 1 ? '' : 's'}` : '';
          return `
        <div class="result-row" data-season="${n}">
          <div class="result-name">Season ${n}${epLabel}
            <div class="result-meta">${_escapeHtml(badgeStr)}</div>
          </div>
          <div class="result-row-actions">
            <button class="btn btn-sm" data-action="play" data-season="${n}" ${dis}>Play</button>
            <button class="btn btn-sm" data-action="watch-later" data-season="${n}" ${dis}>Watch Later</button>
          </div>
        </div>`;
        }).join('')}
      </div>
      <div class="modal-actions"><button class="btn" id="shows-m-cancel">Cancel</button></div>`;

    const cancelBtn = document.getElementById('shows-m-cancel');
    if (cancelBtn) cancelBtn.onclick = closeShowModal;

    _qsa('#shows-season-list [data-action]').forEach((btn) => {
      btn.onclick = () => {
        const n = parseInt(btn.dataset.season, 10);
        const rows = bySeason.get(n) || [];
        if (!rows.length) return;
        const packs = rows.filter(r => r._cls.isPack);
        const episodesOnly = rows.filter(r => !r._cls.isPack);
        const playing = btn.dataset.action === 'play';
        const pick = playing ? pickSeasonPlay(rows) : (packs.length ? pickBestPack(packs)
          : pickBestVariant(episodesOnly.length ? episodesOnly : rows));
        if (!pick) { _toast('No seeded file under 5 GB — try Watch Later'); return; }
        if (playing) {
          closeShowModal();
          const eps = seasonData.seasons.get(n) || [];
          const episodeNums = eps.map(ep => ep.number).filter(num => num > 0);
          const payload = buildAddToQueuePayload(show, `S${String(n).padStart(2, '0')}`, pick, {
            season: n, episode: episodeNums.length ? Math.min.apply(null, episodeNums) : 1,
            episodesInSeason: eps.length, seasonNums, imdbId,
          });
          if (typeof App !== 'undefined' && App.addToQueue) App.addToQueue(payload);
        } else {
          _watchLaterSeason(show, n, pick);
        }
      };
    });

    setTimeout(() => {
      const first = card.querySelector('.result-row [data-action]') || cancelBtn;
      if (first) { try { DPad.focus(first); } catch (_) {} }
    }, 50);
  }

  // Same ApiBay -> EZTV -> Knaben chain as the tile lookup, but takes an
  // already-resolved imdbId (from TVMaze.seasonMap) so it skips a redundant
  // TVMaze.searchShow round trip when the modal already has it.
  async function _rowsForShowWithImdb(title, year, imdbId, strictYear) {
    let rows = [];
    try { rows = await _apiBaySearch(title, year, strictYear); } catch (_) {}
    if (!rows.length && imdbId) {
      try { rows = await EZTV.showTorrents(imdbId); } catch (_) {}
    }
    if (!rows.length) {
      const base = String(title || '').replace(/\s*\(\d{4}\).*$/, '').trim();
      const query = strictYear && year ? `${base} ${year}` : base;
      try { rows = _filterShowRows(await Knaben.search(query), title, year, strictYear); } catch (_) {}
    }
    return rows || [];
  }

  // ---------- production entry point ----------
  function onShow() {
    _bindOnce();
    const cacheKey = JSON.stringify(showsState);
    const cached = showsBrowseCache.get(cacheKey);
    const fresh = cached && (Date.now() - cached.at) < BROWSE_TTL_MS;
    if (!fresh) loadShows(true);
  }

  return {
    onShow,
    // Additive, test-only surface — app.js never calls this. Pure
    // functions only (no DOM/fetch side effects) so the headless harness
    // can exercise real logic against fixtures.
    _test: {
      buildDiscoverQuery,
      sortAndFilter,
      parseQualityBadges,
      buildWatchLaterPayload,
      buildAddToQueuePayload,
      releaseYearMatches: _releaseYearMatches,
      pickSeasonPlay,
      filterShowRows: _filterShowRows,
    },
  };
})();
