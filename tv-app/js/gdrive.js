// js/gdrive.js — Google Drive client + thin Luna wrapper around the service.
//
// Auth: Limited Input Device flow (TVs / set-top boxes). User goes to
// google.com/device on a phone, types the code shown on the TV, done.
//
// Drive scope: drive.file — we can only see/touch files our app creates.
// That keeps the consent screen friendly and limits blast radius.
//
// Where things live:
//   - All app videos live under a single per-install Drive folder.
//   - One subfolder per torrent (the "name" we picked when adding it).
//   - Files keep their original filenames.
//
// Service interaction:
//   - We hand the service { refreshToken, clientId } and let it refresh
//     access tokens itself for long-running uploads.
//   - For playback we proxy through service:5051 so <video> doesn't have to
//     send Authorization headers (it can't).

const Drive = (() => {
  // Generate a per-install opaque root name on first use that looks like
  // a system cache directory ("._cache_<hex>"). Stored in cfg.root_folder_name
  // so the same folder is reused across launches.
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  // Configure your own Google OAuth device-flow client in local settings.
  const DEFAULT_CLIENT_ID = '';
  const DEFAULT_CLIENT_SECRET = '';

  function randomHex(n) {
    const b = new Uint8Array(n);
    (crypto || window.crypto).getRandomValues(b);
    return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  function generateRootName() {
    return `._cache_${randomHex(8)}`;
  }

  const OAUTH_DEVICE     = 'https://oauth2.googleapis.com/device/code';
  const OAUTH_TOKEN      = 'https://oauth2.googleapis.com/token';
  const DRIVE_API        = 'https://www.googleapis.com/drive/v3';

  // Regexes hoisted to module scope — these used to be re-literal'd inside
  // hot functions (listAll runs a fresh instance per folder-tree walk,
  // ensureFolder's escape runs per API round trip). A RegExp literal is
  // cheap in modern V8 but not free, and this file has no reason to pay it
  // more than once per process lifetime.
  const FOLDER_NAME_ESCAPE_RE = /'/g;
  const VIDEO_EXT_RE = /\.(mp4|mkv|mov|m4v|webm|avi|mpg|mpeg)$/i;
  const SUBTITLE_EXT_RE = /\.(srt|vtt|ass|ssa|sub)$/i;

  // Bound requests so an unresponsive service cannot retain sockets and
  // response buffers indefinitely. Use both then handlers for cleanup on
  // older webOS runtimes without Promise.prototype.finally.
  const FETCH_TIMEOUT_MS = 20000;
  function fetchTimed(url, init, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || FETCH_TIMEOUT_MS);
    return fetch(url, { ...init, signal: ctrl.signal }).then(value => { clearTimeout(t); return value; }, error => { clearTimeout(t); throw error; });
  }

  // ---------- config ----------
  function cfg() {
    const c = Storage.get('gdrive', {});
    if (!c.client_id)     c.client_id = DEFAULT_CLIENT_ID;
    if (!c.client_secret) c.client_secret = DEFAULT_CLIENT_SECRET;
    if (!c.root_folder_name) {
      c.root_folder_name = generateRootName();
      // The cached root_folder_id (if any) points at the old DumiFlix
      // folder — drop it so the next ensureRootFolder() resolves the
      // newly named opaque folder instead.
      delete c.root_folder_id;
      Storage.set('gdrive', c);
    }
    return c;
  }
  function patch(p) { Storage.set('gdrive', { ...cfg(), ...p }); }
  function rootFolderName() { return cfg().root_folder_name; }

  function isSignedIn() {
    const c = cfg();
    return !!(c.client_id && c.client_secret && c.refresh_token);
  }

  function clientId() { return cfg().client_id; }
  function clientSecret() { return cfg().client_secret; }
  function setClientSecret(secret) { patch({ client_secret: String(secret || '').trim() }); }

  function setClientId(id) {
    const v = String(id || '').trim() || DEFAULT_CLIENT_ID;
    patch({ client_id: v });
  }

  // ---------- OAuth: limited input device flow ----------
  // 1. POST /device/code with client_id + scope → device_code, user_code, verification_url
  // 2. UI shows verification_url + user_code, user authorizes on phone
  // 3. Poll /token until success or expiry
  async function startSignIn() {
    const c = cfg();
    if (!c.client_id || !c.client_secret) throw new Error('OAuth client ID and secret not set');
    const r = await fetchTimed(OAUTH_DEVICE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.client_id, scope: SCOPE }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.device_code) {
      throw new Error(data.error_description || data.error || 'device-code failed');
    }
    return data; // { device_code, user_code, verification_url, expires_in, interval }
  }

  async function pollSignIn(deviceCode, intervalSec, expiresIn, onTick) {
    const c = cfg();
    if (!c.client_id || !c.client_secret) throw new Error('OAuth client ID and secret not set');
    const deadline = Date.now() + (expiresIn || 600) * 1000;
    let interval = Math.max(1, intervalSec || 5);
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, interval * 1000));
      if (onTick) onTick({ status: 'polling' });
      const r = await fetchTimed(OAUTH_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: c.client_id,
          client_secret: c.client_secret,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.access_token) {
        patch({
          refresh_token: data.refresh_token,
          access_token: data.access_token,
          expires_at: Date.now() + (data.expires_in || 3600) * 1000 - 30000,
        });
        return data;
      }
      if (data.error === 'authorization_pending') continue;
      if (data.error === 'slow_down') { interval += 2; continue; }
      if (data.error === 'access_denied') throw new Error('denied');
      if (data.error === 'expired_token') throw new Error('code expired');
      // any other error → retry until deadline
    }
    throw new Error('sign-in timed out');
  }

  function signOut() {
    Storage.clear('gdrive');
  }

  // ---------- access-token ----------
  // Single in-flight refresh: two callers hitting an expired token must share
  // one POST to /token, not race two separate refreshes (the loser would keep
  // a stale token and 401 on its next API call).
  let _refreshing = null;
  async function accessToken() {
    const c = cfg();
    if (!c.client_id || !c.client_secret || !c.refresh_token) throw new Error('not signed in');
    if (c.access_token && c.expires_at && Date.now() < c.expires_at) {
      return c.access_token;
    }
    if (_refreshing) return _refreshing;
    _refreshing = (async () => {
      // Re-read cfg() inside the IIFE so a sign-out / re-sign-in that lands
      // between the outer cfg() snapshot and the actual fetch sees the new
      // refresh token, not the stale one.
      const cur = cfg();
      if (!cur.client_id || !cur.client_secret || !cur.refresh_token) throw new Error('not signed in');
      const r = await fetchTimed(OAUTH_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: cur.client_id,
          client_secret: cur.client_secret,
          refresh_token: cur.refresh_token,
          grant_type: 'refresh_token',
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.access_token) {
        // invalid_grant means Google has revoked the refresh token. This
        // happens automatically after ~7 days when the OAuth consent screen
        // is in "Testing" mode (Google Cloud Console), or whenever the user
        // revokes access from their Google Account. Either way, no amount
        // of retrying will help — the refresh_token itself is dead and the
        // user has to re-sign-in. Tag the error so the UI can show a clear
        // "Re-sign in" prompt instead of a cryptic OAuth error message.
        const reason = data.error_description || data.error || 'token refresh failed';
        if (data.error === 'invalid_grant') {
          patch({ refresh_token: null, access_token: null, expires_at: 0 });
          const err = new Error('Drive sign-in expired — open Settings → Google Drive to reconnect');
          err.code = 'INVALID_GRANT';
          err.googleError = reason;
          throw err;
        }
        throw new Error(reason);
      }
      patch({
        access_token: data.access_token,
        expires_at: Date.now() + (data.expires_in || 3600) * 1000 - 30000,
      });
      return data.access_token;
    })().then(value => { _refreshing = null; return value; }, error => { _refreshing = null; throw error; });
    return _refreshing;
  }

  // ---------- Drive primitives ----------
  async function api(pathQs, init = {}) {
    const tok = await accessToken();
    const r = await fetchTimed(`${DRIVE_API}${pathQs}`, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${tok}` },
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`Drive ${r.status}: ${txt.slice(0, 200)}`);
    }
    return r.json();
  }

  // Find or create a folder by name under a given parent (default root).
  async function ensureFolder(name, parentId = 'root') {
    const q = [
      `name='${name.replace(FOLDER_NAME_ESCAPE_RE, "\\'")}'`,
      `mimeType='application/vnd.google-apps.folder'`,
      `'${parentId}' in parents`,
      `trashed=false`,
    ].join(' and ');
    const list = await api(`/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10`);
    if (list.files && list.files[0]) return list.files[0].id;
    const created = await api(`/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      }),
    });
    return created.id;
  }

  // In-flight guard: without it, two callers racing before root_folder_id is
  // cached (e.g. a home-row refresh and a library-tab refresh both booting
  // at once) would each list-then-create the root folder concurrently,
  // leaving a duplicate "._cache_<hex>" folder sitting on the user's Drive.
  let _rootFolderInFlight = null;
  async function rootFolderId() {
    const c = cfg();
    if (c.root_folder_id) return c.root_folder_id;
    if (_rootFolderInFlight) return _rootFolderInFlight;
    _rootFolderInFlight = (async () => {
      const cur = cfg();
      if (cur.root_folder_id) return cur.root_folder_id;
      const id = await ensureFolder(cur.root_folder_name, 'root');
      patch({ root_folder_id: id });
      return id;
    })().then(value => { _rootFolderInFlight = null; return value; }, error => { _rootFolderInFlight = null; throw error; });
    return _rootFolderInFlight;
  }

  // After a reinstall, the freshly generated `._cache_<hex>` doesn't match
  // the user's existing folder, so the Library renders empty even though
  // their files are sitting on Drive untouched. Find every plausible root
  // (`._cache_*` plus the legacy `DumiFlix`), score each by file count,
  // and re-point the app at the winner.
  async function findExistingRoots() {
    const q = "mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false and (name contains '._cache_' or name='DumiFlix')";
    const list = await api(`/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=100`);
    const folders = list.files || [];
    // Child-count queries are independent per candidate folder — run them
    // concurrently. Promise.all preserves input order regardless of which
    // resolves first, so `scored` lands in the exact same folder order as
    // the old sequential loop before the (stable) sort below.
    const scored = await Promise.all(folders.map(async (f) => {
      const cq = `'${f.id}' in parents and trashed=false`;
      const cl = await api(`/files?q=${encodeURIComponent(cq)}&fields=files(id)&pageSize=1000`);
      return { id: f.id, name: f.name, count: (cl.files || []).length };
    }));
    scored.sort((a, b) => b.count - a.count);
    return scored;
  }
  async function reattachToFolder(name, id) {
    const c = cfg();
    c.root_folder_name = name;
    c.root_folder_id = id;
    Storage.set('gdrive', c);
  }

  // ---------- high-level: list, delete, storage info ----------
  // Walk the root and collect videos. Each video gets a `subtitles` array of
  // sibling subtitle files (same folder).
  //
  // The naive BFS made one API call per folder. For users with N release
  // folders that's 1 + N round-trips on a slow TV connection (~300ms each
  // = 10s+ for 30 folders). We batch instead: gather ALL folder IDs at the
  // current depth, then issue a SINGLE query that filters by all of them
  // via OR (`'a' in parents or 'b' in parents...`) up to a per-call cap
  // dictated by Drive's `q` length limit.
  // Concurrent callers (app.js fires listAll() from the home row, the
  // library tab and the cache-eviction sweep, sometimes within the same
  // tick) share one Drive tree walk instead of issuing N redundant BFS's —
  // each of which is a burst of paginated API calls. Safe to share the
  // resolved array: no caller mutates it in place, they only read/filter it.
  let _listAllInFlight = null;
  function listAll() {
    if (!isSignedIn()) return Promise.resolve([]);
    if (_listAllInFlight) return _listAllInFlight;
    _listAllInFlight = listAllWalk().then(value => { _listAllInFlight = null; return value; }, error => { _listAllInFlight = null; throw error; });
    return _listAllInFlight;
  }

  async function listAllWalk() {
    const root = await rootFolderId();
    const out = [];
    const folderPath = new Map();   // folderId -> "Example Show/S01" string
    folderPath.set(root, '');

    // Depth-batched BFS. `currentLevel` is folder IDs whose contents we
    // need to fetch this round.
    let currentLevel = [root];
    while (currentLevel.length) {
      const childrenByParent = new Map();   // parentId -> [files]
      for (const id of currentLevel) childrenByParent.set(id, []);
      // Drive's q has a soft length limit; chunk the parent list.
      const CHUNK = 50;
      for (let i = 0; i < currentLevel.length; i += CHUNK) {
        const chunk = currentLevel.slice(i, i + CHUNK);
        const orClause = chunk.map(id => `'${id}' in parents`).join(' or ');
        let pageToken;
        do {
          const qs = new URLSearchParams({
            q: `(${orClause}) and trashed=false`,
            fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)',
            pageSize: '1000',
          });
          if (pageToken) qs.set('pageToken', pageToken);
          const page = await api(`/files?${qs}`);
          for (const f of (page.files || [])) {
            for (const p of (f.parents || [])) {
              if (childrenByParent.has(p)) childrenByParent.get(p).push(f);
            }
          }
          pageToken = page.nextPageToken;
        } while (pageToken);
      }

      const nextLevel = [];
      for (const [parentId, files] of childrenByParent) {
        const path = folderPath.get(parentId) || '';
        const folderSubs = files.filter(f => SUBTITLE_EXT_RE.test(f.name)).map(f => ({
          id: f.id, name: f.name, size: parseInt(f.size || '0', 10),
        }));
        const folderVideos = files.filter(f => VIDEO_EXT_RE.test(f.name)).map(f => ({
          id: f.id, name: f.name,
          size: parseInt(f.size || '0', 10),
          path: path ? `${path}/${f.name}` : f.name,
          mtime: Date.parse(f.modifiedTime) || 0,
          subtitles: folderSubs,
        }));
        out.push(...folderVideos);
        for (const f of files) {
          if (f.mimeType === 'application/vnd.google-apps.folder') {
            const childPath = path ? `${path}/${f.name}` : f.name;
            folderPath.set(f.id, childPath);
            nextLevel.push(f.id);
          }
        }
      }
      currentLevel = nextLevel;
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  // Fetch a small file's content as text. Used for subtitles (always tiny).
  async function fetchText(fileId) {
    const tok = await accessToken();
    const r = await fetchTimed(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!r.ok) throw new Error(`fetchText ${r.status}`);
    const buf = await r.arrayBuffer();
    // Most subs are UTF-8 but Latin-1 / Windows-1252 happen too. Try UTF-8
    // first; if it produces replacement chars, fall back to Latin-1.
    let txt;
    try { txt = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (_) { txt = new TextDecoder('windows-1252').decode(buf); }
    return txt;
  }

  async function del(fileId) {
    const tok = await accessToken();
    const r = await fetchTimed(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!r.ok && r.status !== 404) {
      const txt = await r.text().catch(() => '');
      throw new Error(`delete ${r.status}: ${txt.slice(0, 120)}`);
    }
  }

  async function quota() {
    const data = await api(`/about?fields=storageQuota,user`);
    const q = data.storageQuota || {};
    const limit = parseInt(q.limit || '0', 10);
    const used  = parseInt(q.usage || '0', 10);
    return {
      total: limit,
      free: limit ? Math.max(0, limit - used) : 0,
      used,
      email: (data.user && data.user.emailAddress) || '',
    };
  }

  // ---------- Luna wrappers around the service ----------
  function svcAvailable() { return typeof WebOSServiceBridge !== 'undefined'; }
  const SVC = 'luna://com.dumiflix.tv.service/';

  function lunaCall(method, params) {
    return new Promise((resolve, reject) => {
      if (!svcAvailable()) { reject(new Error('not on webOS')); return; }
      const bridge = new WebOSServiceBridge();
      bridge.onservicecallback = (raw) => {
        let msg; try { msg = JSON.parse(raw); } catch (_) { msg = {}; }
        if (msg.returnValue) resolve(msg);
        else reject(new Error(msg.errorText || msg.errorCode || 'service error'));
      };
      try { bridge.call(SVC + method, JSON.stringify(params)); }
      catch (e) { reject(e); }
    });
  }

  function lunaSubscribe(method, params, onTick) {
    if (!svcAvailable()) {
      onTick({ status: 'error', error: 'not on webOS' });
      return { cancel() {} };
    }
    const bridge = new WebOSServiceBridge();
    let cancelled = false;
    bridge.onservicecallback = (raw) => {
      if (cancelled) return;
      let msg; try { msg = JSON.parse(raw); } catch (_) { msg = { status: 'error', error: 'parse' }; }
      onTick(msg);
    };
    try { bridge.call(SVC + method, JSON.stringify({ ...params, subscribe: true })); }
    catch (e) { onTick({ status: 'error', error: String(e && e.message || e) }); }
    return {
      cancel() {
        cancelled = true;
        try { bridge.cancel(); } catch (_) {}
      },
    };
  }

  function authPayload() {
    const c = cfg();
    return {
      clientId: c.client_id,
      clientSecret: c.client_secret,
      refreshToken: c.refresh_token,
      rootFolder: c.root_folder_name,
    };
  }

  // Service-side: download from sourceUrl → upload to Drive folder.
  // onTick({ status, total, written, error, fileId, fileName })
  function uploadFromUrl({ id, sourceUrl, filename, subdir }, onTick) {
    return lunaSubscribe('upload', {
      id, sourceUrl, filename, subdir,
      ...authPayload(),
    }, onTick);
  }

  // Build a play URL that the service proxies to Drive with a fresh bearer.
  // The token isn't sent — the service has its own copy that we POST via 'arm'.
  //
  // We MUST re-arm before each play. webOS idle-kills the native service after
  // ~30s of inactivity; when it respawns to handle a /play HTTP request, the
  // process is fresh and `auth` is empty, so /play returns 503 "drive not
  // signed in". The in-flight promise is cleared once it resolves so the next
  // call genuinely re-arms — only concurrent callers within one round-trip
  // share the in-flight Luna call.
  let _armInFlight = null;
  async function armProxy() {
    if (_armInFlight) return _armInFlight;
    _armInFlight = lunaCall('arm', authPayload())
      .then(value => { _armInFlight = null; return value; }, error => { _armInFlight = null; throw error; });
    return _armInFlight;
  }
  function streamUrl(fileId) {
    return `http://127.0.0.1:5051/play?id=${encodeURIComponent(fileId)}`;
  }

  // Ask the native service whether its play proxy is actually listening.
  // Returns { listening, error, address, pid, node } or rejects.
  async function serviceStatus() {
    const r = await lunaCall('status', {});
    return r;
  }

  // Pre-flight: hit the local proxy with a HEAD-style probe. If the service
  // is up and Drive auth is live, we get 200/206. If auth has gone bad
  // we get 503 with a body like "auth: refresh failed" — far more useful
  // than the generic <video> "Network error".
  async function probePlayUrl(fileId, { timeoutMs = 6000 } = {}) {
    const u = streamUrl(fileId);
    try {
      // We send a tiny Range so Drive returns 206 quickly without streaming
      // the whole file. Some HTTP stacks ignore HEAD on the proxy, so we
      // use a 0-1 ranged GET — same code path the <video> takes.
      const r = await fetchTimed(u, { headers: { Range: 'bytes=0-1' } }, timeoutMs);
      if (r.ok || r.status === 206) return { ok: true, status: r.status };
      const body = await r.text().catch(() => '');
      return { ok: false, status: r.status, error: body || `HTTP ${r.status}` };
    } catch (e) {
      return { ok: false, status: 0, error: String(e.message || e) };
    }
  }

  return {
    // OAuth
    isSignedIn, clientId, setClientId, clientSecret, setClientSecret, startSignIn, pollSignIn, signOut,
    accessToken,
    // Drive
    listAll, del, quota, rootFolderId, rootFolderName, fetchText,
    // Luna
    available: svcAvailable, uploadFromUrl, armProxy, streamUrl,
    serviceStatus, probePlayUrl,
    // Recovery
    findExistingRoots, reattachToFolder,
  };
})();
