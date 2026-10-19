// js/iptv.js — Worldwide IPTV channel directory
//
// Backed by iptv-org's public GitHub-hosted API:
//   https://iptv-org.github.io/api/{channels,streams,logos,countries,categories}.json
//
// Three big files (~9 MB / ~3 MB / ~7 MB) need to be merged:
//   channels.json — id → { name, country, categories[], is_nsfw, ... }
//   streams.json  — { channel?, title, url, quality } — many entries lack `channel`
//   logos.json    — { channel, in_use, url, width, height }
//
// The merge keeps only channels that have BOTH a metadata record AND at least
// one stream URL. Result is ~10–12 K playable channels worldwide.
//
// Cached in memory only — even one of these JSONs blows past the 5 MB
// localStorage quota. Per-session load is fine; subsequent tab switches hit
// the in-memory cache and are instant. app.js already drops the cache via
// releaseCache() whenever the user leaves the Intl tab, so the ~15 MB merged
// catalog doesn't linger; the small TTL below is just a backstop in case that
// ever stops happening.

const IPTV = (() => {
  const API = 'https://iptv-org.github.io/api';

  // These source files run 3–9 MB each over whatever wifi the TV has, so give
  // them much more rope than the small JSON-API timeouts used elsewhere in
  // this app (those are usually 6–15s).
  const FETCH_TIMEOUT_MS = 30000;

  // Channel/stream/logo lists barely change day to day. This TTL just stops
  // the merged catalog (~15 MB) from being held forever if a caller keeps
  // fetchAll() alive without ever calling releaseCache().
  const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

  // Promise that resolves to the merged channel list. Reset to null by an
  // explicit refresh, a TTL miss, or a failed fetch — every other caller
  // (including concurrent ones) awaits this same promise, so fetchAll() is
  // naturally deduped in-flight.
  let _all = null;
  let _allAt = 0;

  // Country code → { name, flag }. Filled at first fetchAll().
  let _countryMeta = new Map();
  // Category id → display name. Filled at first fetchAll().
  let _categoryMeta = new Map();

  // ---------- hoisted regexes (never build a RegExp inside a hot loop) ----------
  const _RE_QUALITY_4K = /4k|2160/;
  const _RE_QUALITY_NUM = /(\d{3,4})/;
  const _RE_EMPTY_LABEL = /^\s*$/;

  // Shared, never-mutated empty array for the (very common) single-stream
  // channel case — callers always .slice()/spread this before touching it
  // (see app.js playLive / currentVideo.fallbacks), so one shared instance
  // across thousands of channel objects is safe and saves that many tiny
  // array allocations.
  const _NO_FALLBACKS = [];

  async function _json(url) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(url, { signal: ac.signal });
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Rough numeric rank for stream quality so we can pick the best one when a
  // channel has multiple feeds.
  function qualityRank(q) {
    if (!q) return 0;
    const s = String(q).toLowerCase();
    if (_RE_QUALITY_4K.test(s)) return 2160;
    const m = s.match(_RE_QUALITY_NUM);
    return m ? parseInt(m[1], 10) : 0;
  }

  // Given a channel's raw stream list, pick the best-quality usable stream
  // and build the ordered fallback URL list (best-to-worst, minus the pick).
  // Split out of the fetchAll() merge loop so the extremely common
  // single-stream case (most channels only have one feed) can skip the
  // filter/sort/slice/map chain entirely.
  function _pickStream(list) {
    if (list.length === 1) {
      return { best: list[0], fallbacks: _NO_FALLBACKS };
    }
    // iptv-org tags some streams with `label: "Geo-blocked"` /
    // "Geo-restricted" / "Not 24/7" / "Timeshift". Prefer unlabeled streams
    // to reduce failures from geographic or scheduling restrictions.
    // Fall back to labeled streams when no unlabeled stream is available.
    const usable = list.filter(s => !s.label || _RE_EMPTY_LABEL.test(s.label));
    const candidates = usable.length ? usable : list;
    candidates.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
    // Stash the rest for failover: when openPlayer hits an error event, the
    // renderer can swap in the next URL without a round trip to the API.
    // Built with a plain loop (not slice+map+filter) to avoid two throwaway
    // intermediate arrays per channel.
    const fallbacks = [];
    for (let i = 1; i < candidates.length; i++) {
      const u = candidates[i].url;
      if (u) fallbacks.push(u);
    }
    return { best: candidates[0], fallbacks };
  }

  async function fetchAll({ force = false } = {}) {
    if (_all && !force && (Date.now() - _allAt) < CACHE_TTL_MS) return _all;
    // Stamp the start time now (not just on success) so a second caller that
    // comes in while this fetch is still in flight sees a fresh _allAt and
    // correctly awaits the same in-flight promise instead of the TTL check
    // treating the not-yet-settled cache as stale and firing a duplicate
    // fetch of all 5 large JSON files.
    _allAt = Date.now();
    const p = (async () => {
      let [channels, streams, logos, countries, categories] = await Promise.all([
        _json(`${API}/channels.json`),
        _json(`${API}/streams.json`),
        _json(`${API}/logos.json`),
        _json(`${API}/countries.json`),
        _json(`${API}/categories.json`),
      ]);

      _countryMeta.clear();
      for (const c of countries) _countryMeta.set(c.code, { name: c.name, flag: c.flag });
      _categoryMeta.clear();
      for (const c of categories) _categoryMeta.set(c.id, c.name);
      countries = null;               // consumed into _countryMeta — drop the ~raw array early
      categories = null;

      const channelById = new Map();
      for (const c of channels) channelById.set(c.id, c);
      channels = null;                // consumed into channelById

      // Logos: prefer the first `in_use: true` entry per channel; fall back
      // to anything with a URL.
      const logoByChannel = new Map();
      for (const l of logos) {
        if (!l.channel || !l.url) continue;
        const have = logoByChannel.get(l.channel);
        if (!have || (l.in_use && !have.in_use)) {
          logoByChannel.set(l.channel, { url: l.url, in_use: !!l.in_use });
        }
      }
      logos = null;                   // consumed into logoByChannel

      // Streams: group by channel id. Skip orphan streams (no `channel`
      // key) — they have no metadata, no logo, no categories, so the grid
      // would be junk rows.
      const streamsByChannel = new Map();
      for (const s of streams) {
        if (!s.channel || !s.url) continue;
        const bucket = streamsByChannel.get(s.channel);
        if (bucket) bucket.push(s);
        else streamsByChannel.set(s.channel, [s]);
      }
      streams = null;                 // consumed into streamsByChannel

      const out = [];
      for (const [id, list] of streamsByChannel) {
        const ch = channelById.get(id);
        if (!ch) continue;
        if (ch.is_nsfw) continue;        // safe-by-default; xxx category is also gated
        const { best, fallbacks } = _pickStream(list);
        const logo = logoByChannel.get(id);
        out.push({
          id,
          name: ch.name,
          country: ch.country || '',
          categories: ch.categories || [],
          // First category is the "primary" one — used for grid bucketing.
          category: (ch.categories && ch.categories[0]) || 'general',
          logo: logo ? logo.url : null,
          url: best.url,
          fallbacks,
          quality: best.quality || null,
        });
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    })();
    _all = p.then((result) => {
      _allAt = Date.now();
      return result;
    }).catch((e) => {
      // On failure, drop the cached promise so the next call retries instead
      // of returning a permanently-broken Promise.
      _all = null;
      throw e;
    });
    return _all;
  }

  // Drops the cached channel list (and any in-flight fetch promise — same
  // variable serves both roles above) so the ~10–15 MB merged catalog can be
  // garbage-collected once the caller is done with the World TV tab. Safe to
  // call any time: the next fetchAll() sees _all as null and transparently
  // re-fetches + rebuilds everything from scratch, same as a first load.
  function releaseCache() {
    _all = null;
    _allAt = 0;
  }

  // Top countries by channel count, plus a name + flag so the chip can
  // render "🇺🇸 United States (1234)".
  function listCountries(channels, limit = 24) {
    const seen = new Map();
    for (const c of channels) {
      if (!c.country) continue;
      seen.set(c.country, (seen.get(c.country) || 0) + 1);
    }
    const sorted = [...seen.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, limit);
    return top.map(([code, count]) => {
      const meta = _countryMeta.get(code) || {};
      return { code, count, name: meta.name || code, flag: meta.flag || '' };
    });
  }

  function listCategories(channels) {
    const seen = new Map();
    for (const c of channels) {
      for (const cat of (c.categories || [])) seen.set(cat, (seen.get(cat) || 0) + 1);
    }
    return [...seen.entries()]
      .filter(([id]) => id !== 'xxx')        // hide adult bucket from chips
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => ({ id, count, name: _categoryMeta.get(id) || id }));
  }

  function countryName(code) {
    const m = _countryMeta.get(code);
    return m ? m.name : code;
  }
  function countryFlag(code) {
    const m = _countryMeta.get(code);
    return m ? m.flag : '';
  }

  return {
    fetchAll, listCountries, listCategories, countryName, countryFlag,
    qualityRank, releaseCache,
  };
})();
