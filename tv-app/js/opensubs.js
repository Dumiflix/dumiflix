// js/opensubs.js — OpenSubtitles.com REST API fallback for subtitles.
//
// Used only when the torrent didn't ship with a sibling .srt/.vtt file. The
// player's primary path is still pickEnglishSubtitle over the seedr/Drive
// folder; this module fills in the gap.
//
// API: https://api.opensubtitles.com/api/v1
// Auth: free API key — register a "consumer" at
//       https://www.opensubtitles.com/en/consumers (~30 sec)
//       Paste the key into Settings → OpenSubtitles.
//
// Match strategy: search by IMDb ID (or query+year+season+episode), then
// score every result against the actual torrent filename — release groups
// (MeGusta, FLUX, RARBG, YIFY, etc.) tend to share their codec / cut /
// timing, so a sub uploaded for the same release is most likely to sync.
//
// Quotas (free tier): 1000 search/day, 5 downloads/day anonymous /
// 10/day with a registered user. Subs are cached in localStorage per
// (imdb|query, season, episode) so re-watches cost zero downloads.

const OpenSubs = (() => {
  const API = 'https://api.opensubtitles.com/api/v1';
  const USER_AGENT = 'DumiFlix v0.1';

  // Supply an API key in Settings to enable subtitle searches/downloads.
  // No shared credential ships with the app.
  const DEFAULT_API_KEY = '';

  // On-disk subtitle-content cache cap. Subtitle text is small (10-100 KB)
  // each but the cache grows unboundedly across watches — this is the LRU
  // ceiling (oldest `ts` evicted first) applied before every write, shared
  // by all three cache sites below so it can't drift out of sync.
  const CACHE_CAP = 30;

  // ---------------------------------------------------------------------
  // Regexes hoisted to module scope: on this Chromium-53..79 range building
  // a RegExp per call is a real allocation (and a GC-pressure source) that
  // matters when scoreMatch/rankCandidates run over a dozen-plus candidates.
  // None of these carry the `g` flag except RELEASE_TOKENS_RE, and String
  // .match()/.test() with a global regex resets lastIndex on entry, so
  // reusing the same compiled object across calls (even interleaved ones —
  // JS is single-threaded/synchronous here) is safe.
  // ---------------------------------------------------------------------
  const RE_BLURAY = /\b(bluray|brrip|bdrip|blu.?ray)\b/i;
  const RE_WEBDL = /\b(web.?dl|webrip|amzn|nf|hulu|atvp|dsnp)\b/i;
  const RE_HDTV = /\bhdtv\b/i;
  const RE_DVDRIP = /\b(dvdrip|xvid)\b/i;
  const HD_RE = /\b(2160p|1080p|720p)\b/i;
  const RESOLUTION_RE = /\b(2160p|1080p|720p|480p)\b/;
  const EXT_RE = /\.[a-z0-9]{2,4}$/i;               // strip filename extension
  const GROUP_RE = /-\s*([a-z0-9]{2,})\s*$/i;        // trailing "-GROUP" token
  const NORM_TITLE_RE = /[^a-z0-9]+/g;
  const SE_RE = /\bs(\d{1,2})[._\s-]?e(\d{1,3})\b/i;
  const SE_ALT_RE = /\b(\d{1,2})x(\d{2})\b/;
  const RELEASE_TOKENS_RE = /\b(x264|x265|h ?264|h ?265|hevc|avc|xvid|divx|aac|ac3|eac3|dd ?5 ?1|ddp ?5 ?1|dts|truehd|atmos|flac|web ?dl|webrip|web|bluray|brrip|bdrip|hdtv|dvdrip|remux|amzn|nf|dsnp|hmax|atvp|hulu|pcok|repack|proper|internal|2160p|1080p|720p|480p|hdr10?|dovi|dv|10bit|imax)\b/gi;

  function apiKey() {
    return Storage.get('opensubsKey', '') || DEFAULT_API_KEY;
  }
  function setApiKey(key) { Storage.set('opensubsKey', String(key || '').trim()); }
  function hasApiKey() { return !!apiKey(); }

  // Bounded fetch: every network call gets an AbortController + timeout so a
  // stalled request can never pin resources (buffers, the pending promise's
  // closure) for the life of a long playback session.
  function _fetchTimeout(url, init, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    // Note: no `.finally()` here — Promise.prototype.finally is ES2018 and
    // is not available on webOS 4's Chromium 53. Use the two-arg `.then()`
    // form instead, which every target runtime (Chromium 53/68/79) supports.
    return fetch(url, { ...init, signal: ctrl.signal }).then(
      (r) => { clearTimeout(timer); return r; },
      (e) => { clearTimeout(timer); throw e; }
    );
  }

  // In-flight de-dupe for the JSON API: if two call sites ask for the exact
  // same (method, path, body) while a request is still pending, they share
  // one Promise instead of firing a second identical HTTP request. Safe to
  // share because the dedupe key maps to the fully-PARSED result, never to
  // a raw Response (whose body stream can only be consumed once).
  const _inflightApi = new Map();
  async function _apiRaw(path, init) {
    const key = apiKey();
    if (!key) throw new Error('OpenSubtitles API key not set');
    const r = await _fetchTimeout(`${API}${path}`, {
      ...init,
      headers: {
        'Api-Key': key,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers || {}),
      },
    }, 15000);
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`OpenSubs ${r.status}: ${txt.slice(0, 120)}`);
    }
    return r.json();
  }
  function _api(path, init = {}) {
    const dkey = (init.method || 'GET') + ' ' + path + ' ' + (init.body || '');
    const hit = _inflightApi.get(dkey);
    if (hit) return hit;
    const p = _apiRaw(path, init).then(
      (v) => { _inflightApi.delete(dkey); return v; },
      (e) => { _inflightApi.delete(dkey); throw e; }
    );
    _inflightApi.set(dkey, p);
    return p;
  }

  // In-flight de-dupe + decode for downloaded subtitle bodies, keyed by the
  // (one-shot, signed) CDN link. Same safety rule as above: the shared
  // promise resolves to decoded text, never to the raw Response.
  const _inflightDl = new Map();
  async function _fetchSubtitleText(url) {
    const hit = _inflightDl.get(url);
    if (hit) return hit;
    const p = (async () => {
      const r = await _fetchTimeout(url, {}, 8000);
      if (!r.ok) throw new Error(`download HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
      catch (_) { return new TextDecoder('windows-1252').decode(buf); }
    })().then(
      (v) => { _inflightDl.delete(url); return v; },
      (e) => { _inflightDl.delete(url); throw e; }
    );
    _inflightDl.set(url, p);
    return p;
  }

  // Search for subtitles. Pass `imdbId` when known (best-quality match);
  // otherwise pass `query` (+ optional `year`). For TV episodes pass
  // season/episode. When BOTH imdbId and season/episode are present we use
  // parent_imdb_id (the show's tt-id), which scopes the search to that one
  // show, preventing subtitles for "Example Show" from appearing in a
  // search for "Example Show Returns".
  async function search({ imdbId, query, season, episode, year, languages = 'en' } = {}) {
    if (!hasApiKey()) return [];
    const params = new URLSearchParams({ languages });
    const idDigits = imdbId ? String(imdbId).replace(/^tt/i, '') : '';
    if (idDigits && (season || episode)) {
      // TV episode — anchor to the show's IMDb ID via parent_imdb_id.
      params.set('parent_imdb_id', idDigits);
    } else if (idDigits) {
      // Movie — direct imdb_id.
      params.set('imdb_id', idDigits);
    } else if (query) {
      params.set('query', query);
      if (year) params.set('year', String(year));
    } else {
      throw new Error('search needs imdbId or query');
    }
    if (season)  params.set('season_number', String(season));
    if (episode) params.set('episode_number', String(episode));
    const data = await _api(`/subtitles?${params}`);
    return (data && data.data) || [];
  }

  // Score a search result against the actual video filename. Higher is
  // better. The most important signal is
  // "does the sub's framerate match the video", because a 25-fps DVDRip
  // sub against a 23.976-fps Blu-ray drifts progressively until you're
  // 30+ seconds out by the end of an episode. Match release timing before
  // using title similarity to break ties.
  const RELEASE_TAGS = [
    'megusta', 'galaxytv', 'rarbg', 'yify', 'yts', 'ethel', 'flux',
    'ntg', 'ntb', 'kit', 'aacc', 'silence', 'joy', 'utr', 'kogi',
    'edge2020', 'evo', 'sva', 'd3g', 'dimension', 'lol', 'killers', 'tla',
    'reward', 'bia', 'orpheus', 'krissz', 'aakraa', 'maximersk', 'psychd',
    'playweb', 'kitsune',
  ];
  // Source kind a torrent comes from. Subs uploaded for the SAME kind
  // share the same scene cuts/timing.
  function detectSourceKind(s) {
    if (RE_BLURAY.test(s)) return 'bluray';
    if (RE_WEBDL.test(s))  return 'webdl';
    if (RE_HDTV.test(s))   return 'hdtv';
    if (RE_DVDRIP.test(s)) return 'dvdrip';
    return null;
  }
  function isHdFilename(s) { return HD_RE.test(s); }

  // The release GROUP is the token after the final dash, e.g.
  // "Example.Show.S01E02.1080p.WEB.H264-ExampleGroup.mkv" → "examplegroup". This
  // is the single strongest filename signal (a sub uploaded for the exact same
  // group's rip syncs frame-for-frame), and unlike RELEASE_TAGS it works for
  // ANY group, not just ones we've hard-coded.
  function releaseGroup(name) {
    const s = String(name || '').replace(EXT_RE, '');   // strip extension
    const m = s.match(GROUP_RE);
    return m ? m[1].toLowerCase() : '';
  }
  // Meaningful release tokens (source / codec / audio / resolution / HDR). The
  // more of these the sub's release name shares with the video's, the more
  // likely it's the same encode and syncs.
  function releaseTokens(s) {
    const set = new Set();
    const m = String(s || '').toLowerCase().match(RELEASE_TOKENS_RE);
    if (m) for (const t of m) set.add(t.replace(/\s+/g, ''));
    return set;
  }

  // Per-filename properties are invariant across every candidate scored
  // against that filename, but scoreMatch (a hot loop inside pickBest /
  // rankCandidates, up to a dozen-plus results) used to recompute all of
  // them — several regexes each — on EVERY call. A tiny single-slot memo
  // (scoreMatch is always called back-to-back with the same filename in
  // those loops) turns that into "once per filename" with zero change to
  // the returned score, since every field here is a pure function of the
  // filename string.
  let _fnKey = null;
  let _fnInfo = null;
  function _filenameInfo(filename) {
    const fn = String(filename || '');
    if (fn === _fnKey) return _fnInfo;
    const fnLower = fn.toLowerCase();
    const wantKind = detectSourceKind(fnLower);
    const isHd = isHdFilename(fnLower);
    const wantFps = (wantKind === 'bluray' || wantKind === 'webdl' || isHd)
      ? 23.976
      : (wantKind === 'hdtv' ? 25.0 : null);
    const info = {
      fnLower,
      wantKind,
      isHd,
      wantFps,
      vGroup: releaseGroup(fnLower),
      vTok: releaseTokens(fnLower),
      se: fnLower.match(SE_RE),
      qMatch: fnLower.match(RESOLUTION_RE),
    };
    _fnKey = fn;
    _fnInfo = info;
    return info;
  }

  function scoreMatch(sub, filename, opts = {}) {
    let pts = 0;
    const attr = sub.attributes || {};
    const fi = _filenameInfo(filename);
    const fnLower = fi.fnLower;
    const releaseFiles = (attr.files || []).map(f => (f.file_name || '').toLowerCase());
    const releaseTitle = (attr.release || '').toLowerCase();
    const allText = (releaseTitle + ' ' + releaseFiles.join(' ')).toLowerCase();

    // 0) Forced-only tracks contain only selected translated lines rather
    //    than full dialogue. Penalize them so release-tag matches cannot
    //    rank a sparse track above a complete subtitle track.
    if (attr.foreign_parts_only || /\bforced\b/.test(allText)) pts -= 1000;

    // 1) Source-kind match (Blu-ray sub for Blu-ray video, etc.) — this
    //    strongly correlates with timing match because both come from the
    //    same upstream master.
    const wantKind = fi.wantKind;
    const haveKind = detectSourceKind(allText);
    if (wantKind && haveKind) {
      if (wantKind === haveKind) pts += 80;
      // DVDRip subs against HD video almost always desync — kill them.
      else if (haveKind === 'dvdrip' && (wantKind === 'bluray' || wantKind === 'webdl')) pts -= 200;
    }
    // No source kind detectable on the sub side AND user video is HD?
    // Likely an unspecified DVDRip — small penalty.
    if (!haveKind && fi.isHd && !attr.hd) pts -= 40;

    // 2) Framerate match. 23.976 is film cadence (Blu-ray, WEB-DL). 25 is
    //    PAL DVD/HDTV. 29.97 is NTSC DVD. Mismatch causes drift.
    const wantFps = fi.wantFps;
    const subFps = parseFloat(attr.fps) || 0;
    if (wantFps && subFps) {
      if (Math.abs(subFps - wantFps) < 0.1) pts += 60;
      else                                  pts -= 80;
    }

    // 3) HD flag aligns with HD content.
    if (fi.isHd) {
      if (attr.hd) pts += 25;
      else         pts -= 25;
    }

    // 4) Release-group match — the strongest filename signal: same group's
    //    rip ⇒ same cut ⇒ frame-for-frame sync. Prefer the GENERIC group token
    //    (works for any group), fall back to the known-tag allowlist for odd
    //    namings. Awarded once.
    const vGroup = fi.vGroup;
    let groupHit = !!(vGroup && vGroup.length >= 3 && allText.includes(vGroup));
    if (!groupHit) {
      for (const tag of RELEASE_TAGS) {
        if (fnLower.includes(tag) && allText.includes(tag)) { groupHit = true; break; }
      }
    }
    if (groupHit) pts += 200;

    // 4b) Token overlap — how many release tokens (source/codec/audio/res/HDR)
    //     the sub's release name shares with the video's. A broad "looks like
    //     the same encode" signal that lifts the right sub even when the group
    //     is absent. Capped so it never outweighs an exact group/hash match.
    const vTok = fi.vTok;
    if (vTok.size) {
      let shared = 0;
      for (const t of vTok) if (allText.includes(t)) shared++;
      pts += Math.min(72, shared * 12);
    }

    // 4c) Episode match. Reward the exact SxxExx appearing in the sub's own
    //     release; and if the sub names a DIFFERENT episode, penalize hard —
    //     defends against the API / _filterFeature letting a neighbouring
    //     episode of the same show slip into the pool.
    const se = fi.se;
    if (se) {
      const a = 's' + se[1].padStart(2, '0') + 'e' + se[2].padStart(2, '0');
      const b = se[1].replace(/^0/, '') + 'x' + se[2].padStart(2, '0');
      if (allText.includes(a) || allText.includes(b)) pts += 30;
      const subSE = allText.match(SE_RE) || allText.match(SE_ALT_RE);
      if (subSE) {
        const sameEp = parseInt(se[1], 10) === parseInt(subSE[1], 10)
                    && parseInt(se[2], 10) === parseInt(subSE[2], 10);
        if (!sameEp) pts -= 300;
      }
    }

    // 5) Quality match (1080p/720p/2160p in the release name).
    const qMatch = fi.qMatch;
    if (qMatch) {
      const q = qMatch[1];
      if (allText.includes(q)) pts += 40;
    }

    // 6) Trusted uploaders + machine-translated penalty.
    if (attr.from_trusted)       pts += 15;
    if (attr.machine_translated) pts -= 200;
    if (attr.ai_translated)      pts -= 80;
    if (attr.hearing_impaired)   pts -= 5;

    // 7) Popularity tiebreaker — capped so it never outweighs sync signals.
    pts += Math.min(40, Math.log10((attr.download_count || 0) + 1) * 10);
    return pts;
  }

  // Strict title-match guard for query-based searches. When the user has
  // no IMDb ID and we fall back to a keyword search, OpenSubtitles can
  // return episodes from other shows whose names contain the query word
  // ("Example" might pull "Example Show", "Example Series", or "Example
  // Story"). We post-filter via parent_title equality on a normalized
  // string. No-op when imdbId-anchored.
  function _normTitle(s) {
    return String(s || '').toLowerCase().replace(NORM_TITLE_RE, '');
  }
  function _matchesTitle(sub, wantTitleNorm) {
    if (!wantTitleNorm) return true;
    const fd = (sub.attributes || {}).feature_details || {};
    const cand = _normTitle(fd.parent_title || fd.title || '');
    return cand === wantTitleNorm;
  }

  function pickBest(results, filename) {
    if (!results.length) return null;
    const scored = results.map(r => ({ r, s: scoreMatch(r, filename) }));
    scored.sort((a, b) => b.s - a.s);
    return scored[0].r;
  }

  // Score-sort the results and return the top N. Used by the player's
  // "Search OpenSubtitles…" menu so the user can manually pick a release
  // when the auto-pick was wrong.
  function rankCandidates(results, filename, limit = 12) {
    return results
      .map(r => ({ r, s: scoreMatch(r, filename) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map(({ r, s }) => ({
        result: r,
        score: s,
        label: (function() {
          const rel = ((r.attributes || {}).release || '').slice(0, 70);
          if (rel) return rel;
          const f0 = (((r.attributes || {}).files) || [])[0];
          const fn = f0 && f0.file_name;
          return (fn && fn.slice(0, 70)) || 'subtitle';
        })(),
        meta: [
          (r.attributes || {}).hd ? 'HD' : null,
          (r.attributes || {}).fps ? `${(r.attributes).fps}fps` : null,
          (r.attributes || {}).from_trusted ? '✓ trusted' : null,
          (r.attributes || {}).hearing_impaired ? 'SDH' : null,
          `${(r.attributes || {}).download_count || 0} dl`,
        ].filter(Boolean).join(' · '),
      }));
  }

  // Resolve the chosen result to the actual subtitle text.
  async function getContent(result) {
    if (!hasApiKey()) return null;
    const fileEntry = result && result.attributes && result.attributes.files && result.attributes.files[0];
    if (!fileEntry || !fileEntry.file_id) throw new Error('no file id in result');
    const data = await _api('/download', {
      method: 'POST',
      body: JSON.stringify({ file_id: fileEntry.file_id }),
    });
    if (!data || !data.link) throw new Error('no download link');
    const text = await _fetchSubtitleText(data.link);
    return { text, name: fileEntry.file_name || 'opensubs.srt' };
  }

  // Cache key: stable signature of the lookup INCLUDING a release fingerprint
  // (source kind + resolution) from the filename. Without it, watching a
  // different release of the same title returned the previous release's
  // cached sub — usually out of sync. Same release → still zero-quota.
  function _cacheKey({ imdbId, query, season, episode }, filename) {
    const fn = String(filename || '').toLowerCase();
    const fp = [
      detectSourceKind(fn) || '',
      ((fn.match(RESOLUTION_RE) || [])[1] || ''),
    ].filter(Boolean).join('.');
    return [
      imdbId ? 'imdb:' + String(imdbId).replace(/^tt/i, '') : 'q:' + (query || '').toLowerCase().trim(),
      season ? 's' + season : '',
      episode ? 'e' + episode : '',
      fp ? 'r:' + fp : '',
    ].filter(Boolean).join('|');
  }

  // Belt-and-braces post-filters on the API's own matching:
  //  - requested S/E must equal the result's feature_details (the API
  //    occasionally pads results with neighboring episodes),
  //  - a movie searched by IMDb id must not return a different feature.
  function _filterFeature(results, { imdbId, season, episode }) {
    let out = results;
    if (season && episode) {
      const f = out.filter(r => {
        const fd = (r.attributes || {}).feature_details || {};
        return (!fd.season_number || fd.season_number == season)
            && (!fd.episode_number || fd.episode_number == episode);
      });
      out = f;
    } else if (imdbId) {
      const want = parseInt(String(imdbId).replace(/^tt/i, ''), 10);
      const f = out.filter(r => {
        const fd = (r.attributes || {}).feature_details || {};
        return !fd.imdb_id || fd.imdb_id === want;
      });
      out = f;
    }
    return out;
  }

  // Shared LRU-evict-then-persist for the on-disk subtitle cache — factored
  // out because it was duplicated (identically) across findFor,
  // findExactByHash and findReferenceByHash, all three writing into the
  // same `opensubsCache` blob with the same 30-entry cap.
  function _cacheStore(cache, key, res) {
    try {
      cache[key] = { ...res, ts: Date.now() };
      const entries = Object.entries(cache);
      if (entries.length > CACHE_CAP) {
        entries.sort((a, b) => ((a[1] && a[1].ts) || 0) - ((b[1] && b[1].ts) || 0));
        for (const [k] of entries.slice(0, entries.length - CACHE_CAP)) delete cache[k];
      }
      Storage.set('opensubsCache', cache);
    } catch (_) { /* quota — ignore */ }
  }

  // High-level: returns { text, name } or null.
  async function findFor({ imdbId, query, season, episode, year, filename } = {}) {
    if (!hasApiKey()) return null;
    const key = _cacheKey({ imdbId, query, season, episode }, filename);
    const cache = Storage.get('opensubsCache', {}) || {};
    if (cache[key]) {
      // Read-time re-validation: entries cached BEFORE the forced-track
      // scorer existed can hold a forced/partial pick (a handful of
      // foreign-dialogue-only cues), and a cache hit bypasses the scorer
      // entirely, allowing a foreign-dialogue-only track to reappear.
      // A full episode runs 500-900 cues; anything under ~120
      // (cache.py's _MIN_FULL_SUB_CUES) or forced-named is dropped here so
      // the search + fixed scorer run again and re-cache a real track.
      const e = cache[key];
      const cues = ((e && e.text) || '').split('-->').length - 1;
      const forcedName = /forced|dothraki|valyrian/i.test((e && e.name) || '');
      if (e && e.text && cues >= 120 && !forcedName) return e;
      delete cache[key];
      Storage.set('opensubsCache', cache);
    }
    let results;
    try { results = await search({ imdbId, query, season, episode, year }); }
    catch (e) {
      console.warn('[opensubs] search failed:', e.message);
      return null;
    }
    if (!results.length) return null;
    // Strict title match when no IMDb ID was available — drops episodes
    // from same-keyword shows that slip through OpenSubtitles' fuzzy
    // query matcher.
    if (!imdbId && query) {
      const wantNorm = _normTitle(query);
      const filtered = results.filter(r => _matchesTitle(r, wantNorm));
      results = filtered;
    }
    results = _filterFeature(results, { imdbId, season, episode });
    const best = pickBest(results, filename || query || '');
    if (!best) return null;
    let res;
    try { res = await getContent(best); }
    catch (e) {
      console.warn('[opensubs] download failed:', e.message);
      return null;
    }
    _cacheStore(cache, key, res);
    return res;
  }

  // Return the top N ranked candidates (without downloading any of them).
  // The caller renders these as a chooser; getContent(result) downloads
  // the one the user picked.
  async function findCandidates({ imdbId, query, season, episode, year, filename, limit = 12 } = {}) {
    if (!hasApiKey()) return [];
    let results;
    try { results = await search({ imdbId, query, season, episode, year }); }
    catch (e) { return []; }
    if (!imdbId && query) {
      const wantNorm = _normTitle(query);
      const filtered = results.filter(r => _matchesTitle(r, wantNorm));
      results = filtered;
    }
    results = _filterFeature(results, { imdbId, season, episode });
    return rankCandidates(results, filename || query || '', limit);
  }

  // ============================================================
  // Moviehash exact-match — the "find the EXACT subtitle" path.
  // ============================================================
  // OpenSubtitles' moviehash = filesize + the sum of every 64-bit
  // little-endian word in the first AND last 64 KiB of the file. A sub
  // uploaded by someone who had THIS EXACT file is hash-matched → it is
  // frame-accurate for this release, i.e. already synced to the audio.
  // This is the gold-standard finder: when it hits, no sync is needed.
  async function movieHashFromUrl(url, opts = {}) {
    // Seedr playback and its cache copy already own the two upstream slots.
    // The caller defers media reads until the completed local source is ready.
    if (!url || opts.metadataOnly) return null;
    const CHUNK = 65536;
    const MASK = (1n << 64n) - 1n;
    const range = async (a, b) => {
      const r = await _fetchTimeout(url, { headers: { Range: `bytes=${a}-${b}` }, cache: 'no-store' }, 10000);
      if (r.status !== 206 && r.status !== 200) throw new Error('range ' + r.status);
      const cr = r.headers.get('Content-Range');
      const buf = await r.arrayBuffer();
      return { buf, total: cr ? parseInt((cr.split('/')[1] || '0'), 10) : 0 };
    };
    let head;
    try { head = await range(0, CHUNK - 1); } catch (_) { return null; }
    let size = head.total;
    if (!size) {
      try {
        const h = await _fetchTimeout(url, { method: 'HEAD', cache: 'no-store' }, 10000);
        size = parseInt(h.headers.get('Content-Length') || '0', 10);
      } catch (_) {}
    }
    if (!size || size < CHUNK * 2) return null;
    let tail;
    try { tail = await range(size - CHUNK, size - 1); } catch (_) { return null; }
    let hash = BigInt(size);
    const add = (buf) => {
      const dv = new DataView(buf);
      const n = (buf.byteLength >> 3) << 3;
      for (let i = 0; i < n; i += 8) hash = (hash + dv.getBigUint64(i, true)) & MASK;
    };
    add(head.buf); add(tail.buf);
    return { moviehash: hash.toString(16).padStart(16, '0'), moviebytesize: size };
  }

  async function searchByHash(moviehash, languages) {
    if (!hasApiKey()) return [];
    const params = new URLSearchParams({ moviehash });
    if (languages) params.set('languages', languages);
    const data = await _api(`/subtitles?${params}`);
    const arr = (data && data.data) || [];
    // The API returns near-matches too; keep only true hash matches.
    return arr.filter(s => {
      const m = (s.attributes || {}).moviehash_match;
      return m === true || m === 'true';
    });
  }

  function _trackWords(name) {
    return String(name || '').toLowerCase().replace(/\.(srt|vtt|ass|ssa)$/i, '')
      .replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function _hashFeatureTitle(result, opts) {
    const fd = ((result || {}).attributes || {}).feature_details || {};
    // API titles are preferable; the playing filename supplies context when
    // older uploads have no feature title. Drop year/episode/release tails.
    return String(fd.title || fd.parent_title || opts.filename || '')
      .split(/\b(?:19\d{2}|20\d{2}|s\d{1,2}e\d{1,3}|\d{3,4}p|web[ ._-]?dl|bluray)\b/i)[0];
  }

  function _partialTrack(name, title) {
    let words = _trackWords(name);
    const feature = _trackWords(title);
    if (feature && (words === feature || words.indexOf(feature + ' ') === 0)) {
      words = words.slice(feature.length).trim();
      // With the feature prefix removed, explicit flavor words elsewhere
      // in the release are safe to inspect too (e.g. Movie FORCED 1080p).
      return /(?:^| )(?:forced|foreign (?:parts? )?only|dothraki only|valyrian only)(?: |$)/.test(words);
    }
    // Flavor tags belong at the end of a release (optionally before its
    // language), not inside a feature title such as "Forced Example".
    return /(?:^| )(?:forced|foreign (?:parts? )?only|dothraki(?: only)?|valyrian(?: only)?)(?: (?:en|eng|english))?$/.test(words);
  }

  function _fullHashContent(res, opts) {
    if (!res || !res.text || _partialTrack(res.name, res._featureTitle || _hashFeatureTitle(null, opts))) return false;
    let count = 0, first = Infinity, last = -Infinity;
    const re = /(\d{1,2}):(\d{2}):(\d{2})[,.]\d+\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.]\d+/g;
    let m;
    while ((m = re.exec(res.text))) {
      const start = +m[1] * 3600 + +m[2] * 60 + +m[3];
      const end = +m[4] * 3600 + +m[5] * 60 + +m[6];
      if (end <= start) continue;
      count++; first = Math.min(first, start); last = Math.max(last, end);
    }
    if (!count) return false;
    // Compare coverage to THIS video's runtime. Complete shorts can have a
    // handful of cues; without a known runtime do not assume feature length.
    const duration = Number(opts.duration);
    return !(isFinite(duration) && duration > 0) || last - first >= duration * 0.5;
  }

  function _rankHashSubs(results, opts) {
    const full = results.filter(r => {
      const a = r.attributes || {};
      const title = _hashFeatureTitle(r, opts);
      return !a.foreign_parts_only && !a.forced
        && !_partialTrack(a.release, title)
        && !(a.files || []).some(f => _partialTrack(f.file_name, title));
    });
    const clean = full.filter(r => !((r.attributes || {}).machine_translated));
    const pool = clean.length ? clean : full;
    pool.sort((a, b) => {
      const A = a.attributes || {}, B = b.attributes || {};
      const ra = (A.from_trusted ? 2 : 0) - (A.ai_translated ? 1 : 0);
      const rb = (B.from_trusted ? 2 : 0) - (B.ai_translated ? 1 : 0);
      if (rb !== ra) return rb - ra;
      return (B.download_count || 0) - (A.download_count || 0);
    });
    return pool;
  }

  // Keep downloaded content (including rejected partials) shared between the
  // English and all-language passes. Validate per runtime/title at each call;
  // a failed network request is retryable. Bound memory like the disk cache.
  const _hashDownloads = new Map();
  function _hashContent(hashInfo, result) {
    const file = ((result.attributes || {}).files || [])[0];
    if (!file || !file.file_id) return Promise.resolve(null);
    const key = hashInfo.moviehash + ':' + file.file_id;
    if (_hashDownloads.has(key)) return _hashDownloads.get(key);
    const pending = getContent(result).catch(() => {
      _hashDownloads.delete(key);
      return null;
    });
    _hashDownloads.set(key, pending);
    if (_hashDownloads.size > CACHE_CAP) _hashDownloads.delete(_hashDownloads.keys().next().value);
    return pending;
  }

  async function _findFullHashContent(hashInfo, results, opts) {
    const ranked = _rankHashSubs(results, opts);
    for (const candidate of ranked) {
      const content = await _hashContent(hashInfo, candidate);
      if (!content) continue;
      const res = { ...content, _featureTitle: _hashFeatureTitle(candidate, opts) };
      if (_fullHashContent(res, opts)) return res;
    }
    return null;
  }

  // Exact English sub for this file (frame-accurate) or null. `hashInfo` is
  // the object returned by movieHashFromUrl. Cached by hash so re-watches
  // cost zero download quota.
  async function findExactByHash(hashInfo, languages = 'en', opts = {}) {
    if (!hasApiKey() || !hashInfo || !hashInfo.moviehash) return null;
    const ckey = 'hash:' + hashInfo.moviehash + ':' + languages;
    const cache = Storage.get('opensubsCache', {}) || {};
    if (cache[ckey]) {
      if (_fullHashContent(cache[ckey], opts)) return cache[ckey];
      delete cache[ckey];
      Storage.set('opensubsCache', cache);
    }
    let results;
    try { results = await searchByHash(hashInfo.moviehash, languages); }
    catch (e) { console.warn('[opensubs] hash search failed:', e.message); return null; }
    let res = await _findFullHashContent(hashInfo, results, opts);
    if (!res) return null;
    res = { ...res, exact: true };
    _cacheStore(cache, ckey, res);
    return res;
  }

  // A hash-matched sub in ANY language — its cue TIMINGS are a frame-accurate
  // reference for this file (used to auto-sync a non-exact English sub when no
  // audio analysis is available). Returns { text, name } or null.
  async function findReferenceByHash(hashInfo, opts = {}) {
    if (!hasApiKey() || !hashInfo || !hashInfo.moviehash) return null;
    const ckey = 'ref:' + hashInfo.moviehash;
    const cache = Storage.get('opensubsCache', {}) || {};
    if (cache[ckey]) {
      if (_fullHashContent(cache[ckey], opts)) return cache[ckey];
      delete cache[ckey];
      Storage.set('opensubsCache', cache);
    }
    let results;
    try { results = await searchByHash(hashInfo.moviehash); }   // no language filter = all
    catch (_) { return null; }
    const res = await _findFullHashContent(hashInfo, results, opts);
    if (!res) return null;
    _cacheStore(cache, ckey, res);
    return res;
  }

  return {
    search, getContent, pickBest, scoreMatch, findFor, findCandidates,
    movieHashFromUrl, searchByHash, findExactByHash, findReferenceByHash,
    setApiKey, hasApiKey,
    getApiKey: apiKey,
  };
})();
