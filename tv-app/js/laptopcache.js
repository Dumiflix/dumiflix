// js/laptopcache.js — laptop-side next-episode cache backend.
//
// Strict mirror of js/phonecache.js's public surface (same PFX pattern,
// same method names/shapes) so every existing PhoneCache call site keeps
// working unmodified when this module is swapped in instead. The
// difference is where the bytes land: instead of the phone's internal
// flash over the LAN, this downloads to a configured laptop's disk (via
// the dumiflix-remux service's /cache/* routes, also on the LAN) and
// streams back from there — so the next episode is ready the instant the
// laptop engine is selected, with none of the seedr magnet/wait phase.
//
// Unlike the phone's ungated /cache/* routes, EVERY route here sits behind
// the same X-Playback-Token gate as /playback/start (hashed cache filenames
// are still guessable/brute-forceable without it). GET/HEAD/POST calls
// carry the token as a header; the one exception is /cache/stream, whose
// URL is handed directly to <video>/ffmpeg/a Range-probing fetch, so its
// token travels as a query param instead (see streamUrl() below).
//
// fileIds are the cache-relative path prefixed with `VPSCACHE::` so the
// rest of the app can route per-file ops (streamUrl / probe / fetchText)
// to the right backend purely from the id, exactly like PhoneCache's
// `CACHE::` scheme. `VPSCACHE::` is a historical name for the remote cache
// backend, retained for compatibility with persisted fileIds and snapshots.
//
// This module is ONLY ever selected as a backend when Remux.engine()
// === 'laptop' — callers must gate on that themselves (this module does not
// re-derive the engine choice; reachable() additionally cross-checks
// Remux.availableFor('laptop') as a belt-and-suspenders guard against a
// stale/mis-set host being used while a different engine is active).
const LaptopCache = (() => {
  const PFX = 'VPSCACHE::';
  // Consecutive failed /cache/status polls (backoff ~20 s plus timeouts) before a
  // copy is reported as failed.
  const POLL_FAILURE_LIMIT = 9;

  function _laptopHost() {
    try { return (Storage.get('remux.laptopHost', '') || '').trim(); } catch (_) { return ''; }
  }
  function hasHost() { return !!_laptopHost(); }

  // Mirrors Remux.base()'s 'laptop' branch exactly (js/remux.js): bare
  // host/IP gets an implicit http:// prefix; throws if unset.
  function base() {
    const h = _laptopHost();
    if (!h) throw new Error('Laptop host not set in Settings');
    return (h.indexOf('://') >= 0) ? h : ('http://' + h);
  }

  // Same fallback chain as Remux._token()'s 'laptop' branch (js/remux.js):
  // the laptop's own token, falling back to the shared phone token if unset.
  function _token() {
    try { return Storage.get('remux.laptopToken', '') || Storage.get('remux.token', '') || ''; } catch (_) { return ''; }
  }
  function _authHeaders(extra) {
    const h = Object.assign({}, extra || {});
    const t = _token();
    if (t) h['X-Playback-Token'] = t;
    return h;
  }

  function isCacheId(id) { return typeof id === 'string' && id.startsWith(PFX); }
  function relOf(id)  { return isCacheId(id) ? id.slice(PFX.length) : id; }

  // Same rationale as phonecache.js's _timeoutSignal: an abort timeout so a
  // wedged laptop (or a LAN stall) can't pin an open socket for the life of
  // the page, with `clear()` so the timer is torn down the moment the fetch
  // settles instead of lingering for the rest of `ms`.
  function _timeoutSignal(ms) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), ms);
      return { signal: c.signal, clear: () => clearTimeout(t) };
    } catch (_) {
      return { signal: undefined, clear: () => {} };
    }
  }

  // In-flight guard so concurrent "is the laptop up?" callers (backend
  // selection + a playback service-status check landing within a tick of
  // each other) share one /health round trip instead of firing two. No TTL
  // on purpose, same as phonecache.js — reachability can flip at any time
  // and callers use it to decide laptop-vs-fallback, so every non-concurrent
  // call still does a live check.
  let _reachableInflight = null;

  // Is the laptop reachable, is its cache actually enabled server-side, AND
  // is the laptop engine itself still the one in play? cache_enabled===true
  // is the laptop equivalent of the phone's cache_root_mounted check; the
  // extra Remux.availableFor('laptop') guard means a stale laptopHost
  // lingering in Storage after the user switches engines can never make
  // this resolve true for the wrong engine.
  async function reachable() {
    if (!hasHost()) return false;
    if (_reachableInflight) return _reachableInflight;
    const t = _timeoutSignal(2500);
    _reachableInflight = (async () => {
      try {
        if (typeof Remux !== 'undefined' && !Remux.availableFor('laptop')) return false;
        const r = await fetch(base() + '/health', {
          cache: 'no-store', signal: t.signal, headers: _authHeaders(),
        });
        if (!r.ok) return false;
        const j = await r.json();
        return j.cache_enabled === true;
      } catch (_) { return false; }
      finally { t.clear(); }
    })();
    try { return await _reachableInflight; }
    finally { _reachableInflight = null; }
  }

  // Catalog availability is independent of the disk-cache health flag. A
  // failed request throws so Home can distinguish an unavailable verifier
  // from a working verifier that returned no verified titles.
  async function catalogCheck(items, opts) {
    opts = opts || {};
    const wait = Math.max(0, Math.min(8000, Math.floor(Number(opts.wait_ms) || 0)));
    const t = _timeoutSignal(wait + 5000);
    try {
      const r = await fetch(base() + '/catalog/check', {
        method: 'POST', headers: _authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ items: items || [],
          max_bytes: opts.max_bytes || 5 * 1024 * 1024 * 1024, wait_ms: wait }),
        signal: t.signal,
      });
      if (!r.ok) throw new Error('catalog/check ' + r.status);
      const j = await r.json();
      if (!j || !Array.isArray(j.results)) throw new Error('Invalid catalog reply');
      return j;
    } finally { t.clear(); }
  }

  // A copy request that timed out may still have been admitted; report the
  // job in /cache/fetch's reply shape when the engine knows it.
  async function _existingJob(jobId) {
    const t = _timeoutSignal(8000);
    try {
      const r = await fetch(base() + '/cache/status?id=' + encodeURIComponent(jobId), {
        cache: 'no-store', signal: t.signal, headers: _authHeaders(),
      });
      const s = await r.json().catch(() => ({}));
      if (!r.ok || !s || !s.rel || !s.state || s.state === 'unknown'
          || s.state === 'error' || s.state === 'aborted') return null;
      return { ok: true, id: jobId, rel: s.rel, state: s.state === 'ready' ? 'ready' : 'started' };
    } catch (_) {
      return null;
    } finally { t.clear(); }
  }

  // Reserve + download `sourceUrl` on the laptop's disk. onTick mirrors
  // Drive.uploadFromUrl / PhoneCache.uploadFromUrl:
  //   { status:'starting'|'uploading'|'ready'|'error', total, received, written, stage, fileId, error }
  // Returns { cancel() }.
  function uploadFromUrl({ id, sourceUrl, filename, subdir, total }, onTick) {
    let cancelled = false;
    let timer = null;
    const jobId = String(id);
    let fileId = null;

    const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const fail = error => {
      if (!cancelled) onTick({ jobId, fileId, ranges: [], bytesPerSec: 0, status: 'error', error });
    };
    // One slow or dropped status request is not a failed copy: the laptop
    // keeps downloading while the TV streams from it. An isolated timeout
    // can otherwise roll healthy growing playback back to Seedr even though
    // the copy succeeds. Give up only after a sustained outage.
    let pollFailures = 0;

    (async () => {
      // Admission can take well over 10 s when the laptop disk is waking or
      // busy after an engine restart: the engine may create the job after
      // the initial request times out. Wait longer, and on a timeout ask
      // whether the job exists before calling it failed.
      const t0 = _timeoutSignal(45000);
      try {
        let r, j;
        try {
          r = await fetch(base() + '/cache/fetch', {
            method: 'POST',
            headers: _authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ id: jobId, url: sourceUrl, name: filename,
                                   total: Number(total || 0) }),
            signal: t0.signal,
          });
          j = await r.json().catch(() => ({}));
        } catch (e) {
          if (cancelled) return;
          const started = await _existingJob(jobId);
          if (!started) throw e;
          r = { ok: true, status: 200 };
          j = started;
        } finally { t0.clear(); }
        if (cancelled) return;
        if (!r.ok || !j.ok) { fail((j && j.error) || `HTTP ${r.status}`); return; }

        // `rel` is the LOCKED wire contract's stable identifier (the server's
        // hashed relative cache path) — fileId is always PFX + rel, never a
        // client-side guess, so it round-trips correctly through /cache/list's
        // self-heal / subtitle lookups later.
        const rel = j.rel;
        fileId = PFX + rel;
        if (j.state === 'ready') {
          _invalidateListCache(); // a new file just landed — next listAll() must see it
          onTick({ status: 'ready', fileId, jobId, total: Number(total || 0),
                   received: Number(total || 0), written: Number(total || 0),
                   ranges: j.ranges || (total > 0 ? [[0, Number(total)]] : []),
                   bytesPerSec: Number(j.bytesPerSec || 0), stage: 'ready' });
          return;
        }
        onTick({ status: 'starting', stage: 'connecting', jobId,
                 total: Number(total || 0), received: 0, fileId, ranges: [], bytesPerSec: 0 });

        const poll = async () => {
          if (cancelled) return;
          const t = _timeoutSignal(8000);
          try {
            const sr = await fetch(base() + '/cache/status?id=' + encodeURIComponent(jobId), {
              cache: 'no-store', signal: t.signal, headers: _authHeaders(),
            });
            // 404 carries {state:'unknown'} (terminal); other non-OK replies
            // are transient like a timeout.
            if (!sr.ok && sr.status !== 404) throw new Error('HTTP ' + sr.status);
            const s = await sr.json();
            if (cancelled) return;
            pollFailures = 0;
            if (s.state === 'ready') {
              // /cache/status also echoes `rel` per the wire contract — prefer
              // it (falls back to the /cache/fetch response's rel) so fileId
              // is derived from the server's own confirmation, not just the
              // reservation echo.
              const relFinal = s.rel || rel;
              const fid = PFX + relFinal;
              _invalidateListCache();
              onTick({ status: 'ready', fileId: fid, jobId, total: s.total || 0,
                       received: s.received || 0, written: s.received || 0,
                       contiguous: s.contiguous || s.received || 0,
                       progressiveReady: true, rangeSupported: !!s.rangeSupported,
                       accelerated: !!s.accelerated, ranges: s.ranges || [],
                       bytesPerSec: Number(s.bytesPerSec || 0), stage: 'ready' });
              return;
            }
            if (s.state === 'error') { fail(s.error || 'laptop cache download failed'); return; }
            if (s.state === 'aborted' || s.state === 'unknown') { fail(s.state); return; }
            // still downloading
            onTick({ status: 'uploading', jobId, total: s.total || 0,
                     received: s.received || 0, written: s.received || 0,
                     contiguous: s.contiguous || 0,
                     progressiveReady: !!s.progressiveReady,
                     rangeSupported: !!s.rangeSupported,
                     accelerated: !!s.accelerated, ranges: s.ranges || [],
                     bytesPerSec: Number(s.bytesPerSec || 0), stage: 'streaming', fileId });
            timer = setTimeout(poll, 250);
          } catch (e) {
            if (cancelled) return;
            pollFailures += 1;
            if (pollFailures >= POLL_FAILURE_LIMIT) { fail(String(e && e.message || e)); return; }
            timer = setTimeout(poll, Math.min(4000, 500 * pollFailures));
          } finally { t.clear(); }
        };
        poll();
      } catch (e) {
        fail(String(e && e.message || e));
      }
    })();

    return {
      cancel() {
        cancelled = true;
        stop();
        try {
          fetch(base() + '/cache/cancel', {
            method: 'POST', headers: _authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ id: jobId }),
          }).catch(() => {});
        } catch (_) {}
      },
    };
  }

  // Direct BitTorrent download on the server (for torrents over seedr's ~5 GB
  // free cap). The finished video file(s) land IN the server's disk cache, so
  // each becomes a normal VPSCACHE:: entry -> shows in the Library + plays via
  // the same remux path. A season pack yields MANY entries (one per episode).
  // onTick: { status:'starting'|'metadata'|'downloading'|'ready'|'error',
  //           jobId, progress, total, received, rels:[...], fileIds:[...], error }
  // Returns { cancel() }.
  function addTorrent({ source, name }, onTick) {
    let cancelled = false, timer = null, jobId = '';
    const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
    (async () => {
      const t0 = _timeoutSignal(15000);
      let r, j;
      try {
        r = await fetch(base() + '/torrent/add', {
          method: 'POST', headers: _authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ source, name: name || '' }), signal: t0.signal,
        });
        j = await r.json().catch(() => ({}));
      } catch (e) { onTick({ status: 'error', error: String(e && e.message || e) }); t0.clear(); return; }
      finally { t0.clear(); }
      if (!r.ok || !j.ok) { onTick({ status: 'error', error: (j && j.error) || `HTTP ${r.status}` }); return; }
      jobId = j.id;
      onTick({ status: 'starting', jobId, stage: 'metadata' });
      const poll = async () => {
        if (cancelled) return;
        const t = _timeoutSignal(8000);
        try {
          const sr = await fetch(base() + '/torrent/status?id=' + encodeURIComponent(jobId),
                                 { cache: 'no-store', signal: t.signal, headers: _authHeaders() });
          const s = await sr.json().catch(() => ({}));
          if (cancelled) return;
          if (s.state === 'ready') {
            _invalidateListCache();   // new cache entries just landed
            const rels = s.rels || (s.rel ? [s.rel] : []);
            onTick({ status: 'ready', jobId, rels, fileIds: rels.map(x => PFX + x),
                     fileId: s.rel ? PFX + s.rel : null, total: s.total || 0, received: s.received || 0 });
            return;
          }
          if (s.state === 'error' || s.state === 'aborted' || s.state === 'unknown') {
            onTick({ status: 'error', error: s.error || s.state }); return;
          }
          onTick({ status: (s.state === 'metadata' ? 'metadata' : 'downloading'), jobId,
                   stage: s.state, progress: s.progress || 0, total: s.total || 0, received: s.received || 0 });
          timer = setTimeout(poll, 2000);
        } catch (e) { if (!cancelled) onTick({ status: 'error', error: String(e && e.message || e) }); }
        finally { t.clear(); }
      };
      poll();
    })();
    return { cancel() {
      cancelled = true; stop();
      try {
        if (jobId) fetch(base() + '/torrent/cancel', {
          method: 'POST', headers: _authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ id: jobId }),
        }).catch(() => {});
      } catch (_) {}
    } };
  }

  // One-shot status of a torrent job (for a Library "downloading…" indicator).
  async function torrentStatus(jobId) {
    const t = _timeoutSignal(8000);
    try {
      const r = await fetch(base() + '/torrent/status?id=' + encodeURIComponent(jobId),
                            { cache: 'no-store', signal: t.signal, headers: _authHeaders() });
      const j = await r.json().catch(() => ({}));
      // Reattached jobs bypass addTorrent's ready branch. Their new cache
      // files must also be visible to exact Seedr/cached-file matching.
      if (j.state === 'ready') _invalidateListCache();
      return j;
    } catch (e) { return { state: 'unknown', error: String(e && e.message || e) }; }
    finally { t.clear(); }
  }

  // All in-flight torrent jobs (active_list from the server).
  async function torrentList() {
    const t = _timeoutSignal(8000);
    try {
      const r = await fetch(base() + '/torrent/list', { cache: 'no-store', signal: t.signal, headers: _authHeaders() });
      const j = await r.json().catch(() => ({}));
      return (j && j.jobs) || [];
    } catch (_) { return []; }
    finally { t.clear(); }
  }

  // Token travels in the query string here (not a header) because this URL
  // is handed directly to <video>/ffmpeg -is / a plain browser Range-probe,
  // none of which can attach a custom header.
  function streamUrl(fileId) {
    const segs = relOf(fileId).split('/').filter(Boolean).map(encodeURIComponent);
    return base() + '/cache/stream/' + segs.join('/') + '?token=' + encodeURIComponent(_token());
  }

  function growingStreamUrl(fileId) {
    const segs = relOf(fileId).split('/').filter(Boolean).map(encodeURIComponent);
    // player=tv tells the engine this read comes from the TV after it left
    // Seedr, so it may open the second origin connection for a trailing index.
    return base() + '/cache/growing/' + segs.join('/') + '?token=' + encodeURIComponent(_token())
      + '&player=tv';
  }

  async function accelerate(jobId) {
    const t = _timeoutSignal(5000);
    try {
      const r = await fetch(base() + '/cache/accelerate', {
        method: 'POST', headers: _authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ id: String(jobId || '') }), signal: t.signal,
      });
      const j = await r.json().catch(() => ({}));
      return Object.assign({ ok: r.ok }, j);
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    finally { t.clear(); }
  }

  // Baked/verified subtitle for a cached file, keyed by the media's rel path
  // AND (optionally) the manifest entry's content fingerprint — the server's
  // "sync once, store forever" store (embedded-extracted or laptop-measured
  // + baked at offset 0). Same token-in-query convention as streamUrl() since
  // fetchSubs() below hands this straight to fetch(). `fp` omitted asks the
  // server for whichever entry the rel's rollup currently points at.
  function subsUrl(fileId, fp) {
    // Server contract is a query param (GET /cache/subs?rel=<rel>&fp=<fp>),
    // NOT a path segment — matching the /subgen + /cache/status shape, not
    // /cache/stream.
    let url = base() + '/cache/subs?rel=' + encodeURIComponent(relOf(fileId));
    if (fp) url += '&fp=' + encodeURIComponent(fp);
    url += '&token=' + encodeURIComponent(_token());
    return url;
  }

  // Best-effort text fetch of the sidecar — mirrors fetchText()'s shape so
  // callers can treat it the same way (throws on a non-OK response).
  async function fetchSubs(fileId, fp) {
    const t = _timeoutSignal(8000);
    try {
      const r = await fetch(subsUrl(fileId, fp), { cache: 'no-store', signal: t.signal });
      if (!r.ok) throw new Error(`laptop subs ${r.status}`);
      return await r.text();
    } finally { t.clear(); }
  }

  // Is the sidecar ready for this file yet? Reads the same listAll() the
  // Library/playback path already fetches (short TTL, shared in-flight
  // promise) rather than a bespoke round trip, so this stays cheap even when
  // called on every playback start.
  async function subsReady(fileId) {
    try {
      const all = await listAll();
      const f = all.find(x => x.id === fileId);
      return !!(f && f.subs_ready);
    } catch (_) { return false; }
  }

  // Poll the server's per-(media,sub) state machine — the rollup when `fp`
  // is omitted, else that exact manifest entry's raw state. Never throws.
  // Transport failure is distinct from a real server-side `none`: a poller
  // must not interpret one Wi-Fi/network-stack blip as "no embedded sub" and
  // start a competing fallback job.
  async function subsState(fileId, fp) {
    const t = _timeoutSignal(4000);
    try {
      let url = base() + '/cache/subs/state?rel=' + encodeURIComponent(relOf(fileId));
      if (fp) url += '&fp=' + encodeURIComponent(fp);
      url += '&token=' + encodeURIComponent(_token());
      const r = await fetch(url, { cache: 'no-store', signal: t.signal, headers: _authHeaders() });
      const j = await r.json().catch(() => ({}));
      return (r.ok && j && j.state) ? j : { state: 'unavailable' };
    } catch (_) { return { state: 'unavailable' }; }
    finally { t.clear(); }
  }

  // Kick off (or advance) the server's sync state machine for this file:
  //   - opts.srt omitted  -> embedded-extraction/verify flow (R3).
  //   - opts.srt provided -> external-candidate align+bake flow (R4/R5),
  //     opts.name is the candidate's source label for the manifest.
  // Fires-and-returns-immediately server-side (background thread does the
  // actual work) — callers poll subsState() for progress. Returns the full
  // parsed JSON ({ok, state, fp, ...}), not just {ok}, so a caller can branch
  // on the state it landed in without a second round trip.
  async function startSync(fileId, opts) {
    opts = opts || {};
    const t = _timeoutSignal(5000);
    try {
      const r = await fetch(base() + '/subgen', {
        method: 'POST', headers: _authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ rel: relOf(fileId), srt: opts.srt, name: opts.name }),
        signal: t.signal,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) return { ok: false, state: 'none', error: (j && j.error) || `HTTP ${r.status}` };
      return j;
    } catch (e) { return { ok: false, state: 'none', error: String(e && e.message || e) }; }
    finally { t.clear(); }
  }

  // No bearer-token proxy to arm (unlike Drive) — the laptop stream is direct.
  async function armProxy() { /* no-op */ }

  async function serviceStatus() {
    const ok = await reachable();
    return { proxy: { listening: ok, address: hasHost() ? base() : '' } };
  }

  async function probePlayUrl(fileId) {
    const t = _timeoutSignal(5000);
    try {
      const r = await fetch(streamUrl(fileId), { headers: { Range: 'bytes=0-1' },
                                                 cache: 'no-store', signal: t.signal });
      return { ok: r.status === 206 || r.status === 200, status: r.status };
    } catch (e) { return { ok: false, status: 0, error: String(e && e.message || e) }; }
    finally { t.clear(); }
  }

  // listAll() result cache — same rationale as phonecache.js: exactly one
  // key (this module only ever talks to a single laptop host), so what's
  // bounded is staleness (short TTL + explicit invalidation on our own
  // mutations), not size.
  const LIST_TTL_MS = 4000;
  let _listCache = null;    // { data, ts }
  let _listInflight = null; // shared promise for concurrent callers

  function _invalidateListCache() { _listCache = null; }

  // Compact on-disk fallback for a listing, survives a full app restart —
  // covers the "fresh boot, browser network stack still dead" case where
  // there is no in-memory _listCache to fall back to at all (e.g. right
  // after the webOS firmware kills the page's network process and the app
  // gets relaunched). Only names/rels/sizes: enough to answer "is episode
  // N+1 already cached" (findNextEpisodeInLocalStores' filename match) and
  // to build a playable streamUrl() from `rel`, without the cost/staleness
  // risk of persisting the full listing (subs_ready, mtime, path) which is
  // cheap to re-fetch once the network recovers.
  //
  // `vpscache.snapshot` is a historical remote-cache storage key. The startup
  // migration copies it to `laptopcache.snapshot` to preserve saved listings.
  const SNAPSHOT_KEY = 'laptopcache.snapshot';
  // A 1 TB cache can comfortably exceed 200 episodes. The snapshot is the
  // authoritative fallback when webOS's network process dies, so truncating it
  // made older cached episodes look absent and triggered duplicate downloads.
  // 2,000 compact {rel,name,size} records remain tiny relative to the TV's
  // configured 50 MB localStorage quota while covering the whole practical HDD.
  const SNAPSHOT_CAP = 2000;

  function _persistSnapshot(data) {
    try {
      // Most-recently-cached first (mtime desc) so the bounded snapshot keeps the
      // entries most likely to matter for "what's the next episode" — older
      // library items fall off before recently-downloaded ones do.
      const sorted = data.slice().sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      const n = Math.min(sorted.length, SNAPSHOT_CAP);
      const files = new Array(n);
      for (let i = 0; i < n; i++) {
        const f = sorted[i];
        files[i] = { r: relOf(f.id), n: f.name, s: f.size };
      }
      Storage.set(SNAPSHOT_KEY, { at: Date.now(), files });
    } catch (_) {}
  }
  function _loadSnapshot() {
    try { return Storage.get(SNAPSHOT_KEY, null); } catch (_) { return null; }
  }

  // Last-known listing without touching the network (in-memory, else the
  // persisted snapshot). For "do we already have this title?" at tap time:
  // /cache/list can take seconds over Wi-Fi, and playback re-verifies the
  // file before using it anyway.
  function listKnown() {
    if (_listCache && _listCache.data) return _listCache.data;
    const snap = _loadSnapshot();
    if (!snap || !Array.isArray(snap.files)) return [];
    return snap.files.map(f => ({ id: PFX + f.r, name: f.n, size: f.s, subtitles: [] }));
  }

  async function listAll() {
    if (_listCache && (Date.now() - _listCache.ts) < LIST_TTL_MS) return _listCache.data;
    if (_listInflight) return _listInflight;
    const t = _timeoutSignal(6000);
    _listInflight = (async () => {
      try {
        const r = await fetch(base() + '/cache/list', { cache: 'no-store', signal: t.signal, headers: _authHeaders() });
        const j = await r.json();
        // Per the LOCKED wire contract, `rel` (not `id`) is the authoritative
        // hashed-path field on /cache/list entries — build fileId from it
        // directly so it is guaranteed to equal PFX + the same rel used to
        // build streamUrl()/store the file, which is what playDriveFile's
        // self-heal (`all.some(f=>f.id===fileId)`) and subtitle lookup
        // (`all.find(f=>f.id===fileId)`) both depend on to actually match.
        const data = (j.files || []).map(f => ({
          id: PFX + f.rel, name: f.name, size: f.size, path: f.path, mtime: f.mtime, subtitles: [],
          // Whisper-generated sidecar .srt, written next to the cache file at
          // download time (see server-side cache-time subgen). Optional field —
          // older/other server builds simply omit it, which reads as "not
          // ready" here and the client falls back to the external finder.
          subs_ready: !!f.subs_ready,
        }));
        _listCache = { data, ts: Date.now() };
        _persistSnapshot(data);
        return data;
      } catch (_) {
        // Preserve the last successful listing during network failures so
        // cached episodes remain discoverable. Mark it stale for callers
        // that need freshness, and use the persisted snapshot when no
        // in-memory listing is available.
        if (_listCache && _listCache.data) {
          _listCache.data.stale = true;
          _listCache.data.staleTs = _listCache.data.staleTs || _listCache.ts;
          // Debounce: don't re-attempt (and re-pay the fetch timeout) on
          // every call while the network stays dead — TTL still lets a
          // genuine recovery be noticed on the next natural refresh window.
          _listCache.ts = Date.now();
          return _listCache.data;
        }
        const snap = _loadSnapshot();
        if (snap && snap.files && snap.files.length) {
          const out = snap.files.map(f => ({
            id: PFX + f.r, name: f.n, size: f.s, path: '', mtime: 0, subtitles: [], subs_ready: false,
          }));
          out.stale = true;
          out.staleTs = snap.at;
          out.fromSnapshot = true;
          _listCache = { data: out, ts: Date.now() };
          return out;
        }
        return [];
      } finally { t.clear(); }
    })();
    try { return await _listInflight; }
    finally { _listInflight = null; }
  }

  async function del(fileId) {
    _invalidateListCache(); // optimistic: the id must not resurface from a stale list
    const t = _timeoutSignal(5000);
    try {
      await fetch(base() + '/cache/del', {
        method: 'POST', headers: _authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ rel: relOf(fileId) }),
        signal: t.signal,
      });
    } catch (_) {}
    finally { t.clear(); }
  }

  async function fetchText(fileId) {
    const t = _timeoutSignal(8000);
    try {
      const r = await fetch(streamUrl(fileId), { cache: 'no-store', signal: t.signal });
      if (!r.ok) throw new Error(`laptop cache ${r.status}`);
      return await r.text();
    } finally { t.clear(); }
  }

  // Surface parity with Drive/PhoneCache so call sites can treat all three
  // uniformly. Deliberately keyed off the laptop engine being the active
  // pick, not merely "is a host configured" — a leftover laptopHost value
  // must never make this module report available while a different engine
  // is chosen.
  function available()      { return typeof Remux !== 'undefined' && Remux.availableFor('laptop'); }
  function isSignedIn()     { return available(); }
  function rootFolderName() { return 'laptop-cache'; }

  // ---- optional mpv player (external display / AV receiver) ----------------------------
  // With a compatible HDMI receiver, mpv can bitstream TrueHD Atmos / DTS:X
  // even when the TV pipeline cannot decode those formats. These are thin
  // wrappers over the server's /player routes; body===undefined means GET.
  async function _playerCall(pathname, body, ms) {
    const t = _timeoutSignal(ms || 5000);
    try {
      const r = await fetch(base() + pathname, body !== undefined
        ? { method: 'POST', headers: _authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(body || {}), signal: t.signal }
        : { cache: 'no-store', headers: _authHeaders(), signal: t.signal });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) return { ok: false, error: (j && j.error) || `HTTP ${r.status}` };
      return j;
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    finally { t.clear(); }
  }
  function playerOpen(fileId, opts) {
    return _playerCall('/player/open', {
      rel: relOf(fileId), start: (opts && opts.start) || 0, title: (opts && opts.title) || '',
    }, 16000);   // covers a cold mpv spawn; the no-session case fails fast server-side
  }
  function playerStop()   { return _playerCall('/player/stop', {}); }
  function playerStatus() { return _playerCall('/player/status', undefined); }
  function playerCmd(name, body) { return _playerCall('/player/' + name, body || {}); }

  // Ship a diagnostics batch to the laptop's POST /log (NDJSON in the
  // engine's configured log directory). Used by app.js's blackbox so the
  // TV's crash/event ring is durable on the laptop. Best-effort
  // by contract: returns false on ANY failure and never throws — a logging
  // path must never be able to break playback.
  async function shipLog(payload) {
    if (!hasHost()) return false;
    const t = _timeoutSignal(6000);
    try {
      const r = await fetch(base() + '/log', {
        method: 'POST', headers: _authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload), signal: t.signal,
      });
      return r.ok;
    } catch (_) { return false; }
    finally { t.clear(); }
  }

  return {
    PFX, isCacheId, reachable, catalogCheck, uploadFromUrl, streamUrl, growingStreamUrl, listKnown,
    accelerate, armProxy, serviceStatus,
    probePlayUrl, listAll, del, fetchText, available, isSignedIn, rootFolderName,
    addTorrent, torrentStatus, torrentList,
    subsUrl, fetchSubs, subsReady, subsState, startSync, shipLog,
    playerOpen, playerStop, playerStatus, playerCmd,
  };
})();
