// js/introdb.js — crowd-sourced intro / recap / credits / preview timestamps so
// the player can offer a PRECISE "Skip Intro" / "Skip Recap" / "Skip Credits"
// mark instead of only guessing from subtitle-cue gaps. SponsorBlock, but for TV.
//
// Two providers, both KEYLESS for reads (no account, no API key):
//   1. TheIntroDB  — api.theintrodb.org/v1/media  (primary; best coverage,
//      returns weighted community averages; coverage can differ from SkipDB).
//      Reads are open: the OpenAPI `security: [{}]` means no auth required; an
//      API key only adds the caller's OWN pending submissions to the average.
//   2. SkipDB      — api.skipdb.tv/api/segments   (fallback).
//
// Both are queried by IMDb id + season + episode and normalised to one shape:
//   { intro, recap, outro, preview, source }
//   each segment: { start, end } in SECONDS, or null. Credits/preview `end`
//   may be null → "runs to the end of the media".
const IntroDB = (() => {
  // v3 returns each segment type as an ARRAY of every distinct submitted cut
  // (v1 collapsed them to one weighted average, which can land between two
  // releases). Arrays let the caller pick the candidate that matches THIS file.
  const IDB = 'https://api.theintrodb.org/v3/media';
  const SDB = 'https://api.skipdb.tv/api/segments';
  const TIMEOUT_MS = 9000;

  // --- Bounded cache: TTL + hard LRU cap -------------------------------------
  // Long binge sessions can call segments() for dozens of episodes over many
  // hours on memory-constrained TVs, so the cache must never grow
  // unbounded and must not serve stale data forever. Map preserves insertion
  // order, which we (ab)use as the LRU recency order: a hit re-inserts the key
  // at the end, and inserts past the cap evict the oldest (front) entry.
  const CACHE_MAX = 150;
  const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — crowd data is near-static
  const _cache = new Map();                // key -> { v: normalised|null, exp }
  // In-flight guard: dedupe concurrent lookups for the same episode (e.g. the
  // player re-firing the effect on a fast re-render) into one network round trip.
  const _inflight = new Map();              // key -> Promise

  function _cacheGet(key) {
    const entry = _cache.get(key);
    if (!entry) return undefined;
    if (entry.exp <= Date.now()) { _cache.delete(key); return undefined; }
    _cache.delete(key); _cache.set(key, entry); // bump recency
    return entry.v;
  }
  function _cacheSet(key, v) {
    if (_cache.has(key)) _cache.delete(key);
    else if (_cache.size >= CACHE_MAX) {
      const oldest = _cache.keys().next().value;
      _cache.delete(oldest);
    }
    _cache.set(key, { v, exp: Date.now() + CACHE_TTL_MS });
  }

  async function _get(url) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, { signal: ac.signal, cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch (_) { return null; } finally { clearTimeout(t); }
  }

  // TheIntroDB v3: each of intro/recap/credits/preview is an ARRAY (omitted when
  // empty). intro/recap carry an end (start may be null = from 0); credits/
  // preview carry a start (end may be null = to end of media). We keep ALL
  // candidates per type so the app can disambiguate cuts.
  function _arr(list, needEnd) {
    if (!Array.isArray(list) || !list.length) return [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const hasS = s.start_ms != null, hasE = s.end_ms != null;
      if (needEnd) {
        if (!hasE) continue;
        const start = hasS ? s.start_ms / 1000 : 0, end = s.end_ms / 1000;
        if (end - start >= 3) out.push({ start, end });
      } else {
        if (!hasS) continue;
        out.push({ start: s.start_ms / 1000, end: hasE ? s.end_ms / 1000 : null });
      }
    }
    return out;
  }
  function _fromIntroDB(j) {
    if (!j) return null;
    const intro = _arr(j.intro, true), recap = _arr(j.recap, true);
    const outro = _arr(j.credits, false), preview = _arr(j.preview, false);
    if (!intro.length && !recap.length && !outro.length) return null;
    return { intro, recap, outro, preview, source: 'theintrodb' };
  }

  // SkipDB: single segment each, wrapped into the same array shape.
  function _fromSkipDB(j) {
    const s = j && j.segments; if (!s) return null;
    const c = seg => (seg && seg.start_ms != null && seg.end_ms != null)
      ? [{ start: seg.start_ms / 1000, end: seg.end_ms / 1000 }] : [];
    const intro = c(s.intro), recap = c(s.recap), outro = c(s.outro), preview = c(s.preview);
    if (!intro.length && !recap.length && !outro.length) return null;
    return { intro, recap, outro, preview, source: 'skipdb' };
  }

  async function _fetch(imdbId, season, episode) {
    const q = (season != null && episode != null) ? `&season=${season}&episode=${episode}` : '';
    const idParam = encodeURIComponent(imdbId);
    // Sequential, not Promise.all: SDB is a fallback only spent when IDB has
    // nothing, so parallelizing would burn a wasted request (and CPU parsing
    // it) on the common case where the primary source already answers.
    let out = _fromIntroDB(await _get(`${IDB}?imdb_id=${idParam}${q}`));
    if (!out) out = _fromSkipDB(await _get(`${SDB}?imdb_id=${idParam}${q}`));
    return out;
  }

  // Fetch normalised segment CANDIDATES for one episode (or movie: pass null
  // s/e), or null on miss. Each of intro/recap/outro/preview is an array of
  // {start,end} (seconds). TheIntroDB v3 first; SkipDB only if it had nothing.
  async function segments(imdbId, season, episode) {
    if (!imdbId) return null;
    const key = `${imdbId}|${season}|${episode}`;
    const cached = _cacheGet(key);
    if (cached !== undefined) return cached;
    let p = _inflight.get(key);
    if (!p) {
      // NB: Promise.prototype.finally is Chrome 63+; webOS 4 ships Chromium
      // 53, so clear the guard via a .then/.catch pair instead (both settle
      // paths run the same cleanup; _fetch itself never actually rejects).
      p = _fetch(imdbId, season, episode);
      _inflight.set(key, p);
      p.then(() => _inflight.delete(key), () => _inflight.delete(key));
    }
    const out = await p;
    _cacheSet(key, out);
    return out;
  }

  return { segments };
})();
