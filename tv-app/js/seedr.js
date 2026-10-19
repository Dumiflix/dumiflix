// services/seedr.js — seedr.cc API client
//
// Mirrors the Python pipeline at scripts/play-pipeline.
// OAuth password grant → access_token → ?access_token=X&func=Y resource calls.
// Tokens persisted in localStorage (per-app sandbox, not exposed to other apps).

const Seedr = (() => {
  const OAUTH = 'https://www.seedr.cc/oauth_test/token.php';
  const RESOURCE = 'https://www.seedr.cc/oauth_test/resource.php';
  // Seedr's public browser OAuth client identifier; it is not an account credential.
  const CLIENT_ID = 'seedr_chrome';

  // Hoisted regexes (never build a RegExp per call — watch()'s poll loop and
  // fuzzy-name matching run every ~2.5s for the life of a download).
  const RE_PAREN_YEAR = /\((?:19|20)\d\d\)/g;
  const RE_NON_ALNUM = /[^a-z0-9]+/g;
  // Fuzzy key: drop a parenthetical year then all non-alphanumerics, so the
  // display name "Example Movie (2020) [2160p]" and the seedr folder "Example Movie
  // 2160p" collapse to the same "johnwick2160p". Hoisted to module scope (not
  // redefined per watch() call) since it's a pure function of its argument.
  function fuzzyKey(s) {
    return String(s || '').toLowerCase().replace(RE_PAREN_YEAR, ' ').replace(RE_NON_ALNUM, '');
  }

  // Read-only/idempotent resource funcs eligible for in-flight de-dupe.
  // Multiple queue items each run their own Seedr.watch() poll loop, so with
  // 2+ downloads active their listContents() ticks frequently land in the
  // same instant — sharing one in-flight request instead of firing N
  // identical ones saves radio/CPU without changing what any caller sees
  // (same request, same response). This is NOT a time-based cache — an entry
  // only exists while its request is actually pending, so no staleness is
  // introduced for the progress-polling / stall-detection logic below.
  const DEDUPE_FUNCS = new Set(['list_contents', 'fetch_file']);
  const _inflight = new Map();

  function getCfg() {
    return Storage.get('seedr', {});
  }
  function setCfg(patch) {
    Storage.set('seedr', { ...getCfg(), ...patch });
  }

  async function fetchTimeout(url, opts = {}, ms = 15000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try {
      const response = await fetch(url, { ...opts, signal: ac.signal });
      // fetch resolves at headers. Keep the deadline until the JSON body has
      // arrived too, and never turn a body-read timeout into a successful {}.
      const data = await response.json().catch(e => {
        if (ac.signal.aborted) throw e;
        return {};
      });
      return { response, data };
    } finally {
      clearTimeout(t);
    }
  }

  async function login(email, password) {
    const body = new URLSearchParams({
      grant_type: 'password',
      username: email, password,
      client_id: CLIENT_ID, type: 'login',
    });
    const result = await fetchTimeout(OAUTH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const r = result.response, data = result.data;
    if (!r.ok || !data.access_token) {
      throw new Error(data.error_description || data.error || 'login failed');
    }
    setCfg({
      email, password,
      access_token: data.access_token,
      refresh_token: data.refresh_token || null,
    });
    return data;
  }

  // Single in-flight refresh: two concurrent 'expired_token' hits must share
  // one refresh instead of each firing their own request (the loser would
  // overwrite access_token with a stale response). Mirrors Drive's
  // `_refreshing` guard in gdrive.js.
  let _refreshing = null;
  async function refresh() {
    if (_refreshing) return _refreshing;
    _refreshing = (async () => {
      const cfg = getCfg();
      if (!cfg.refresh_token) {
        if (cfg.email && cfg.password) return login(cfg.email, cfg.password);
        throw new Error('no refresh token');
      }
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: cfg.refresh_token,
        client_id: CLIENT_ID,
      });
      const result = await fetchTimeout(OAUTH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const r = result.response, data = result.data;
      if (!r.ok || !data.access_token) {
        // refresh failed — fall back to password
        if (cfg.email && cfg.password) return login(cfg.email, cfg.password);
        throw new Error('refresh failed');
      }
      setCfg({ access_token: data.access_token });
      return data;
    })().then(value => { _refreshing = null; return value; }, error => { _refreshing = null; throw error; });
    return _refreshing;
  }

  async function call(func, params = {}, _retried = false) {
    const cfg = getCfg();
    if (!cfg.access_token) throw new Error('not logged in');

    // Coalesce identical concurrent read-only calls (see DEDUPE_FUNCS above).
    // Only the initial attempt is eligible — a post-refresh retry always
    // fires its own request so it isn't stuck sharing a promise keyed before
    // the token rotated.
    const dedupeKey = (!_retried && DEDUPE_FUNCS.has(func))
      ? func + '|' + JSON.stringify(params)
      : null;
    if (dedupeKey) {
      const pending = _inflight.get(dedupeKey);
      if (pending) return pending;
    }

    const p = (async () => {
      const url = `${RESOURCE}?access_token=${encodeURIComponent(cfg.access_token)}&func=${encodeURIComponent(func)}`;
      const body = new URLSearchParams(params);
      const result = await fetchTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const r = result.response, data = result.data;
      if (data && data.error === 'expired_token' && !_retried) {
        await refresh();
        return call(func, params, true);
      }
      // Seedr normally signals a stale token in-body ('expired_token'), but
      // HTTP-level 401/403 responses must trigger the same refresh and
      // single retry, regardless of body shape. Failed operations reject so
      // callers cannot treat a rejected add/delete as accepted/completed.
      if (!r.ok && (r.status === 401 || r.status === 403) && !_retried) {
        await refresh();
        return call(func, params, true);
      }
      if (!r.ok || (data && (data.result === false || data.error))) {
        throw new Error((data && data.error) || (!r.ok ? 'http_' + r.status : 'seedr operation failed'));
      }
      return data;
    })();

    if (dedupeKey) {
      // Share the cleanup chain so callers receive rejections and no
      // detached rejected promise is left unhandled. Both then handlers
      // support older webOS runtimes without Promise.prototype.finally.
      const tracked = p.then(value => { _inflight.delete(dedupeKey); return value; }, error => { _inflight.delete(dedupeKey); throw error; });
      _inflight.set(dedupeKey, tracked);
      return tracked;
    }
    return p;
  }

  // --- high-level ---
  function listContents(folderId = '0') {
    return call('list_contents', { content_type: 'folder', content_id: folderId });
  }
  function fetchFileUrl(fileId) {
    return call('fetch_file', { folder_file_id: fileId }).then(r => r && r.url);
  }
  // Full fetch_file response ({ url, name, ... }) — the KeepWatching save
  // flow wants the real filename, not just the URL.
  function fetchFile(fileId) {
    return call('fetch_file', { folder_file_id: fileId });
  }
  function deleteItems({ folder_ids = [], file_ids = [], torrent_ids = [] }) {
    const arr = [
      ...folder_ids.map(id => ({ type: 'folder', id })),
      ...file_ids.map(id => ({ type: 'file', id })),
      ...torrent_ids.map(id => ({ type: 'torrent', id })),
    ];
    if (arr.length === 0) return Promise.resolve();
    return call('delete', { delete_arr: JSON.stringify(arr) });
  }
  function addMagnet(magnet) {
    return call('add_torrent', { torrent_magnet: magnet });
  }
  // Wipe everything, except folders whose ids are in `excludeFolderIds` —
  // those hold half-watched files still copying to the pen.
  async function clean(excludeFolderIds) {
    const root = await listContents();
    const ex = new Set([...(excludeFolderIds || [])].map(String));
    return deleteItems({
      folder_ids: (root.folders || []).map(x => x.id).filter(id => !ex.has(String(id))),
      file_ids: (root.files || []).map(x => x.folder_file_id),
      torrent_ids: (root.torrents || []).map(x => x.id),
    });
  }

  // Walk a folder recursively, returning [{path, fileId, size, name}]
  async function walkFolder(folderId, base = '') {
    // Sibling subfolders are fetched concurrently (Promise.all), but results
    // are assembled by mapping-then-flattening in folder order — not by
    // push-as-they-resolve — so the aggregated array is byte-for-byte the
    // same as the old sequential walk (own files first, then each subfolder's
    // files in order).
    async function walk(fid, b) {
      const node = await listContents(fid);
      const files = (node.files || []).map(f => ({
        name: f.name,
        path: b ? `${b}/${f.name}` : f.name,
        fileId: f.folder_file_id,
        size: f.size || 0,
      }));
      const subLists = await Promise.all(
        (node.folders || []).map(sub => walk(sub.id, b ? `${b}/${sub.name}` : sub.name))
      );
      return files.concat(...subLists);
    }
    return walk(folderId, base);
  }

  // Subscribe to a specific torrent's progress. Returns an unsubscribe function.
  // onUpdate({ active, pct, speed, total, folder })
  function watch(infoHash, name, onUpdate) {
    let stopped = false;
    const targetHash = (infoHash || '').toLowerCase();
    const targetName = (name || '').trim().toLowerCase();
    // seedr names the finished folder after the TORRENT's name, which differs
    // from the display name we're handed (e.g. movie picks pass "Example Movie
    // (2020) [2160p]" but the magnet's dn — and thus the seedr folder — is
    // "Example Movie 2160p"). And seedr no longer exposes torrent_hash on folders.
    // So we capture the seedr-side torrent name while it downloads, and snapshot
    // the folders that existed before ours finished, to identify the new one.
    const watchKey = targetHash || 'name:' + targetName;
    let lastTorrentName = (getCfg().watchNames || {})[watchKey] || '';
    function rememberTorrentName(nextName) {
      if (nextName === lastTorrentName) return;
      lastTorrentName = nextName;
      // Keep this separate from the queue schema: a resumed watch can match
      // an already-finished folder on its very first snapshot after reboot.
      const names = { ...(getCfg().watchNames || {}) };
      if (nextName) names[watchKey] = nextName;
      else delete names[watchKey];
      try { setCfg({ watchNames: names }); } catch (_) { /* keep polling if storage is unavailable */ }
    }
    let knownFolderIds = null;
    // Progress hysteresis. seedr's active-torrent list is flaky — a torrent
    // that IS downloading can vanish from `root.torrents` for a tick or two
    // (propagation delay, hash-format mismatch, a hiccup in list_contents).
    // Without memory, every such miss was reported as pct:0/queued:true, so
    // the bar flickered to 0% or looked stuck. Once we've seen it active, we
    // keep reporting the last known progress across a miss instead.
    let seenActive = false;
    let polls = 0;
    let lastPct = 0, lastTotal = 0;
    // Wall-clock of the last real forward progress. If a magnet is added but the
    // torrent never actually materialises on seedr (dead / no seeders / a wipe
    // removed it) OR it stalls at the same % with no finished folder, this stops
    // advancing — after STALL_MS we report {stalled} so the caller can recover
    // instead of showing "queued on seedr" forever while seedr is empty.
    let lastAdvanceAt = Date.now();
    const STALL_MS = 90000;
    const targetKey = fuzzyKey(targetName);
    (async () => {
      while (!stopped) {
        try {
          const root = await listContents();
          const folders = root.folders || [];
          if (knownFolderIds === null) knownFolderIds = new Set(folders.map(f => f.id));
          const t = (root.torrents || []).find(t => (t.hash || '').toLowerCase() === targetHash);
          if (t) {
            if (t.name) rememberTorrentName(String(t.name).trim().toLowerCase());
            seenActive = true;
            const _pct = parseFloat(t.progress) || 0;
            const _spd = parseInt(t.download_rate || 0, 10) || 0;
            if (_pct > lastPct || _spd > 0) lastAdvanceAt = Date.now();   // real progress
            lastPct = _pct;
            lastTotal = parseInt(t.size || 0, 10) || 0;
            if (Date.now() - lastAdvanceAt > STALL_MS) {
              onUpdate({ stalled: true });
              return;
            }
            onUpdate({ active: true, pct: lastPct, speed: _spd, total: lastTotal });
          } else {
            // Torrent is gone from the active list → find its finished folder by,
            // in priority order: torrent_hash (if seedr ever provides it), the
            // seedr torrent name we captured, the display name we were given, or
            // — the reliable fallback — a folder that appeared since we started.
            let folder =
              folders.find(f => (f.torrent_hash || '').toLowerCase() === targetHash) ||
              (lastTorrentName && folders.find(f => (f.name || '').trim().toLowerCase() === lastTorrentName)) ||
              folders.find(f => (f.name || '').trim().toLowerCase() === targetName) ||
              (targetKey && folders.find(f => fuzzyKey(f.name) === targetKey)) ||
              null;
            if (!folder && knownFolderIds) {
              const fresh = folders.filter(f => !knownFolderIds.has(f.id));
              if (fresh.length === 1) folder = fresh[0];
              else if (fresh.length > 1) {
                folder = fresh.sort((a, b) =>
                  String(b.last_update || '').localeCompare(String(a.last_update || '')))[0];
              }
            }
            if (folder) {
              rememberTorrentName('');
              onUpdate({ active: false, pct: 100, folder });
              return;
            }
            // Dead / stuck: no active torrent, no finished folder, and no forward
            // progress for STALL_MS. The magnet never took on seedr (no seeders /
            // seedr dropped it / a wipe removed it). Give up so the caller can
            // recover — otherwise this shows "queued on seedr" forever while
            // seedr is actually empty.
            if (Date.now() - lastAdvanceAt > STALL_MS) {
              onUpdate({ stalled: true });
              return;
            }
            // Not active and no finished folder yet. Before we've EVER seen it
            // downloading, it's genuinely still queued/propagating on seedr.
            // After we've seen it active, a miss is a transient hiccup — keep
            // the last known progress rather than snapping the bar to 0%.
            if (seenActive) {
              onUpdate({ active: true, pct: lastPct, total: lastTotal, speed: 0 });
            } else {
              onUpdate({ active: true, pct: 0, queued: true, total: 0, speed: 0 });
            }
          }
        } catch (e) {
          onUpdate({ error: String(e) });
        }
        // Seedr usually finishes a cached torrent within a second or two of the
        // tap: poll briskly at first, then settle to the normal cadence.
        polls += 1;
        await new Promise(r => setTimeout(r, polls <= 8 ? 1000 : 2500));
      }
    })();
    return () => { stopped = true; };
  }

  function isLoggedIn() {
    const cfg = getCfg();
    // Token may be expired but as long as we have credentials we can
    // always re-auth silently. Treat that as "signed in" so the UI
    // doesn't kick the user back to Settings between sessions.
    return !!(cfg.access_token || (cfg.email && cfg.password));
  }

  // Best-effort re-auth on boot. If we already have a (possibly expired)
  // token we still refresh, because seedr access_tokens last ~1h and the
  // app may have been backgrounded longer.
  async function ensureFresh() {
    const cfg = getCfg();
    if (!cfg.email && !cfg.password && !cfg.refresh_token) return false;
    try { await refresh(); return true; }
    catch (_) { return false; }
  }

  function logout() {
    Storage.clear('seedr');
  }

  return {
    login, refresh, call, isLoggedIn, ensureFresh, logout,
    listContents, fetchFileUrl, fetchFile, deleteItems, addMagnet, clean,
    walkFolder, watch,
  };
})();
