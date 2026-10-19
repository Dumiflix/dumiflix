// js/ytmusic.js — YouTube Music client (Phase 0 spike).
//
// This module's job in Phase 0 is to TEST whether the TV's WebView can talk
// to YT Music's Innertube API at all. Two showstoppers we expect:
//   1. CORS: file:// origin trying to hit https://music.youtube.com may get
//      blocked by the browser before YT Music even sees the request.
//   2. SAPISIDHASH origin check: browsers won't let JS set the Origin
//      header, so YT Music's auth signature (which hashes the origin) will
//      mismatch whatever the browser sends. Some endpoints honor X-Origin
//      instead; we set it as a probe.
//
// The exposed `test()` runs two requests so the UI can show which (if any)
// got through:
//   • Strategy 1: anonymous /browse — proves CORS works for unauthenticated
//     calls (this is the floor; if it fails, nothing else will).
//   • Strategy 2: SAPISIDHASH /browse FEmusic_liked_playlists — proves
//     authenticated user-data calls work. This is the real bar for Path B.

const YTMusic = (() => {
  const COOKIE_KEYS = ['__Secure-3PSID', '__Secure-3PAPISID', 'SAPISID', 'HSID', 'SSID'];
  // Public WEB_REMIX Innertube key shipped in YouTube Music's web client, not an account credential.
  const INNERTUBE_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
  const CLIENT = {
    clientName:    'WEB_REMIX',
    clientVersion: '1.20240619.01.00',
    hl: 'en',
  };
  const ORIGIN = 'https://music.youtube.com';

  // Regex to identify a real artist row (channel/album-style browseId) vs.
  // bullet/year/duration filler. Hoisted — built once, not per track row.
  const ARTIST_ID_RE = /^UC|^MPRE|^MPLA/;
  const DURATION_RE  = /^\d+:\d+$/;

  // Reused across every SAPISIDHASH computation instead of allocating one
  // per call.
  const _encoder = new TextEncoder();

  function setCookies(cookies) { Storage.set('ytm_cookies', cookies); }
  function getCookies()        { return Storage.get('ytm_cookies', null); }
  function clearCookies()      { Storage.clear('ytm_cookies'); }

  // SAPISIDHASH = SHA-1(`<timestamp> <SAPISID> <origin>`) in hex.
  // The hash is only a function of (ts, sapisid, origin), and ts is
  // second-granular, so a burst of concurrent authed calls (e.g. the
  // playback flow's getRadio() immediately followed by a search()) within
  // the same second would otherwise recompute an identical SHA-1 digest
  // more than once. One-entry memo avoids that without retaining anything
  // beyond a couple of short strings.
  let _hashMemo = null; // { ts, sapisid, origin, value }
  async function sapisidhash(sapisid, origin) {
    const ts = Math.floor(Date.now() / 1000);
    if (_hashMemo && _hashMemo.ts === ts && _hashMemo.sapisid === sapisid && _hashMemo.origin === origin) {
      return _hashMemo.value;
    }
    const data = _encoder.encode(`${ts} ${sapisid} ${origin}`);
    const buf  = await crypto.subtle.digest('SHA-1', data);
    const hex  = Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    const value = `SAPISIDHASH ${ts}_${hex}`;
    _hashMemo = { ts, sapisid, origin, value };
    return value;
  }

  const FETCH_TIMEOUT_MS = 15000;

  // In-flight promise guard: if two call sites fire the exact same
  // endpoint+payload+strategy while a request is already outstanding (e.g.
  // the music chip double-clicked, or concurrent getRadio()+search() racing),
  // the second caller just awaits the first's promise instead of opening a
  // duplicate socket — saves both memory and a redundant crypto/network hit.
  const _inflight = new Map();

  async function _doCall(endpoint, payload, strategy) {
    const cookies = getCookies();
    const body = { context: { client: CLIENT }, ...payload };
    const headers = { 'Content-Type': 'application/json' };
    if (strategy === 'sapisid') {
      if (!cookies || !cookies.SAPISID) {
        throw new Error('SAPISID cookie not saved');
      }
      headers['Authorization'] = await sapisidhash(cookies.SAPISID, ORIGIN);
      // Origin is forbidden for fetch() to set; X-Origin is a common
      // Google fallback header. Worth a shot — many internal endpoints
      // honor it for the SAPISIDHASH origin check.
      headers['X-Origin']      = ORIGIN;
      headers['X-Goog-AuthUser'] = '0';
    }
    const url = `${ORIGIN}/youtubei/v1/${endpoint}?key=${INNERTUBE_KEY}&prettyPrint=false`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    let r;
    try {
      r = await fetch(url, {
        method:      'POST',
        headers,
        body:        JSON.stringify(body),
        credentials: 'include',   // ask the browser to send cookies cross-origin
        signal:      ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    let parsed;
    const txt = await r.text();
    try { parsed = JSON.parse(txt); } catch (_) { parsed = txt.slice(0, 500); }
    return { ok: r.ok, status: r.status, body: parsed };
  }

  // One Innertube call.
  // strategy: 'none' (no auth) | 'sapisid' (cookies + SAPISIDHASH header)
  function call(endpoint, payload, strategy = 'sapisid') {
    const key = strategy + '|' + endpoint + '|' + JSON.stringify(payload);
    const pending = _inflight.get(key);
    if (pending) return pending;
    const p = _doCall(endpoint, payload, strategy).then(value => { _inflight.delete(key); return value; }, error => { _inflight.delete(key); throw error; });
    _inflight.set(key, p);
    return p;
  }

  // Two-step diagnostic so the UI can show exactly where we stand.
  async function test() {
    const out = [];
    out.push('=== Strategy 1: anonymous /browse (CORS floor) ===');
    try {
      const r = await call('browse', { browseId: 'FEmusic_home' }, 'none');
      out.push(`status: ${r.status}`);
      if (typeof r.body === 'object' && r.body.contents) {
        out.push('PASS: anonymous browse returned contents — CORS works.');
      } else if (typeof r.body === 'object' && r.body.error) {
        out.push('error: ' + JSON.stringify(r.body.error).slice(0, 400));
      } else {
        out.push('body preview: ' + JSON.stringify(r.body).slice(0, 400));
      }
    } catch (e) {
      out.push('NETWORK FAIL: ' + (e && e.message ? e.message : String(e)));
      out.push('(Almost certainly CORS blocked the request before it left the TV.)');
    }
    out.push('');
    out.push('=== Strategy 2: SAPISIDHASH /browse FEmusic_liked_playlists (auth bar) ===');
    const cookies = getCookies();
    if (!cookies) {
      out.push('SKIPPED: no cookies saved. Paste them and Save first.');
    } else {
      try {
        const r = await call('browse', { browseId: 'FEmusic_liked_playlists' }, 'sapisid');
        out.push(`status: ${r.status}`);
        if (typeof r.body === 'object' && r.body.contents) {
          out.push('PASS: user library returned contents — full Path B unlocked.');
        } else if (typeof r.body === 'object' && r.body.error) {
          out.push('error: ' + JSON.stringify(r.body.error).slice(0, 500));
          out.push('(Auth rejected — usually means the SAPISIDHASH origin');
          out.push(' mismatch we predicted, or stale cookies. Try refreshing');
          out.push(' cookies from a fresh music.youtube.com signin.)');
        } else {
          out.push('body preview: ' + JSON.stringify(r.body).slice(0, 500));
        }
      } catch (e) {
        out.push('NETWORK FAIL: ' + (e && e.message ? e.message : String(e)));
      }
    }
    return out.join('\n');
  }

  // Shared iterative walker for both Innertube response shapes below.
  // Innertube's JSON is verbose and rearranges itself across A/B tests, so
  // we walk every node and pluck `rendererKey` wherever it appears rather
  // than hard-coding a single path. Written as an explicit stack instead of
  // recursion — same depth-first pre-order visit sequence as the original
  // per-caller `walk()` closures (children pushed in reverse so the first
  // child/key is processed next), but without allocating a fresh recursive
  // closure per call and without growing the native call stack on deep/wide
  // Innertube payloads.
  function extractRenderers(root, rendererKey, mapFn) {
    const out = [];
    const seen = new Set();
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
        continue;
      }
      const item = node[rendererKey];
      if (item) {
        const mapped = mapFn(item);
        if (mapped && !seen.has(mapped.videoId)) {
          seen.add(mapped.videoId);
          out.push(mapped);
        }
      }
      const keys = Object.keys(node);
      for (let i = keys.length - 1; i >= 0; i--) stack.push(node[keys[i]]);
    }
    return out;
  }

  function parseTrackList(json) {
    return extractRenderers(json, 'musicResponsiveListItemRenderer', extractTrack);
  }

  function extractTrack(item) {
    let videoId = item.playlistItemData && item.playlistItemData.videoId;
    const cols = item.flexColumns || [];
    if (!videoId) {
      for (const c of cols) {
        const runs = (c.musicResponsiveListItemFlexColumnRenderer
                     && c.musicResponsiveListItemFlexColumnRenderer.text
                     && c.musicResponsiveListItemFlexColumnRenderer.text.runs) || [];
        for (const r of runs) {
          const v = r.navigationEndpoint
                 && r.navigationEndpoint.watchEndpoint
                 && r.navigationEndpoint.watchEndpoint.videoId;
          if (v) { videoId = v; break; }
        }
        if (videoId) break;
      }
    }
    if (!videoId) return null;
    const runsAt = i =>
      (cols[i] && cols[i].musicResponsiveListItemFlexColumnRenderer
        && cols[i].musicResponsiveListItemFlexColumnRenderer.text
        && cols[i].musicResponsiveListItemFlexColumnRenderer.text.runs) || [];
    const title = runsAt(0).map(r => r.text).join('') || '(unknown)';
    const subRuns = runsAt(1);
    // The artist row mixes artist names with bullets and album/year text;
    // browseEndpoint with channel-style browseIds tags real artists.
    const artistRuns = subRuns.filter(r =>
      r.navigationEndpoint
      && r.navigationEndpoint.browseEndpoint
      && ARTIST_ID_RE.test(r.navigationEndpoint.browseEndpoint.browseId || ''));
    const artist = (artistRuns.length
      ? artistRuns.map(r => r.text).join(', ')
      : subRuns.filter(r => r.text && r.text !== ' • ' && !DURATION_RE.test(r.text))
               .map(r => r.text).join(' '));
    return { videoId, title, artist };
  }

  // Cached library (so playback doesn't re-fetch hundreds of tracks every
  // time — the user's Liked Songs don't churn fast). TTL: 24 hours. Single
  // fixed key, so the cache is already bounded to one entry — no LRU needed.
  function _cacheGet() { return Storage.get('ytm_liked_cache', null); }
  function _cacheSet(tracks) {
    Storage.set('ytm_liked_cache', { tracks, fetchedAt: Date.now() });
  }
  const CACHE_TTL_MS = 24 * 3600 * 1000;

  async function getLikedSongs(opts = {}) {
    const cached = _cacheGet();
    if (!opts.force && cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
      return cached.tracks;
    }
    const r = await call('browse', { browseId: 'FEmusic_liked_videos' }, 'sapisid');
    if (!r.ok) {
      throw new Error(`liked-songs fetch failed: ${r.status} ${
        typeof r.body === 'object' ? JSON.stringify(r.body).slice(0, 200) : r.body}`);
    }
    const tracks = parseTrackList(r.body);
    if (tracks.length) _cacheSet(tracks);
    return tracks;
  }

  // /search filter param for "songs only" (vs. albums/playlists/videos).
  // These are opaque base64-encoded protobufs; this constant is the one
  // YT Music's web client sends when you click the "Songs" filter chip.
  const SEARCH_FILTER_SONGS = 'EgWKAQIIAWoMEA4QChADEAQQCRAF';

  async function search(query, { filter = 'songs' } = {}) {
    const payload = { query };
    if (filter === 'songs') payload.params = SEARCH_FILTER_SONGS;
    const r = await call('search', payload, 'sapisid');
    if (!r.ok) {
      throw new Error(`search failed: ${r.status} ${
        typeof r.body === 'object' ? JSON.stringify(r.body).slice(0, 200) : r.body}`);
    }
    return parseTrackList(r.body);
  }

  function extractRadioItem(it) {
    const videoId = it.videoId
      || (it.navigationEndpoint && it.navigationEndpoint.watchEndpoint
          && it.navigationEndpoint.watchEndpoint.videoId);
    if (!videoId) return null;
    const title = (it.title && it.title.runs && it.title.runs.map(r => r.text).join('')) || '';
    const artist = (it.shortBylineText && it.shortBylineText.runs
                   && it.shortBylineText.runs.map(r => r.text).join('')) || '';
    return { videoId, title, artist };
  }

  // Get a radio queue seeded from videoId. YT Music's radio playlistId
  // convention: 'RDAMVM' + videoId. /next returns the queue panel which
  // contains playlistPanelVideoRenderer entries — different shape from
  // browse, but extractRadioItem pulls videoId/title/artist from it too.
  async function getRadio(seedVideoId) {
    const payload = {
      enablePersistentPlaylistPanel: true,
      isAudioOnly:                   true,
      videoId:                       seedVideoId,
      playlistId:                    'RDAMVM' + seedVideoId,
    };
    const r = await call('next', payload, 'sapisid');
    if (!r.ok) {
      throw new Error(`next failed: ${r.status} ${
        typeof r.body === 'object' ? JSON.stringify(r.body).slice(0, 200) : r.body}`);
    }
    return extractRenderers(r.body, 'playlistPanelVideoRenderer', extractRadioItem);
  }

  return { COOKIE_KEYS, setCookies, getCookies, clearCookies, test, call,
           getLikedSongs, parseTrackList, search, getRadio };
})();
