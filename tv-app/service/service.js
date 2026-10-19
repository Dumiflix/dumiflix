// service.js — DumiFlix native service
//
// What this does:
//   1. Receives "upload" Luna calls from the app: download a video from a
//      source URL (typically seedr's CDN) and stream-upload it to Google
//      Drive using a resumable upload session.
//   2. Runs an HTTP play proxy on 127.0.0.1:5051. <video> can't send
//      Authorization headers, so we proxy: the TV asks us by Drive fileId,
//      we add the bearer and forward Range to Drive.
//
// We keep our own OAuth refresh-token cache here so long-running uploads
// don't have to round-trip access tokens through the Luna call payload.

const Service = require('webos-service');
const fs = require('fs');
const http = require('http');
const https = require('https');
const url = require('url');

const service = new Service('com.dumiflix.tv.service');
const STREAM_PORT = 5051;

// webOS idle-kills node services within seconds of the last Luna call
// returning. Our 5051 HTTP proxy is invisible to that lifecycle, so it
// gets torn down right when the <video> element tries to connect →
// connection refused → "Network error" / "no supported file" at the
// player. Hold an ActivityManager activity at boot so the platform
// treats this service as busy and keeps it alive indefinitely.
service.activityManager.create('dumiflix.tv.proxy.keepalive', (act) => {
  // Never complete the activity — we WANT it to live forever. The
  // callback exists only so webos-service knows the activity was
  // accepted; we just stash the handle.
  service._keepalive = act;
});

const OAUTH_TOKEN = 'https://oauth2.googleapis.com/token';
const DRIVE_API   = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
// Default kept for backwards compat with installs from before the
// opaque-folder change. New installs always pass rootFolder explicitly.
const DEFAULT_ROOT_FOLDER = 'DumiFlix';

// Keep-alive agent for googleapis. Without this each 8 MB chunk opens a
// fresh TCP+TLS connection (~500 ms on a TV) — over a multi-GB upload
// that's minutes wasted on handshakes. Sockets are reused across chunks
// of the same upload, across uploads, and across the play proxy.
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 6,
});

// ---------- token cache ----------
const auth = {
  clientId: null,
  clientSecret: null,
  refreshToken: null,
  accessToken: null,
  expiresAt: 0,
  rootFolderId: null,
  rootFolderName: null,
};

function setAuth({ clientId, clientSecret, refreshToken, rootFolder }) {
  if (clientId)     auth.clientId = clientId;
  if (clientSecret) auth.clientSecret = clientSecret;
  if (refreshToken) auth.refreshToken = refreshToken;
  // If the app changed which folder we should be using, drop the cached
  // folder ID so the next ensureRootFolder() looks up / creates the new one.
  if (rootFolder && rootFolder !== auth.rootFolderName) {
    auth.rootFolderName = rootFolder;
    auth.rootFolderId = null;
  } else if (rootFolder && !auth.rootFolderName) {
    auth.rootFolderName = rootFolder;
  }
  // invalidate cached access token if creds changed
  auth.accessToken = null;
  auth.expiresAt = 0;
}

// Single in-flight refresh: parallel uploads + a stream proxy hit must share
// one POST to /token. Without this, the loser keeps the now-stale token and
// 401s on its next Drive call.
let _refreshing = null;
async function accessToken() {
  if (!auth.refreshToken || !auth.clientId || !auth.clientSecret) throw new Error('drive not signed in');
  if (auth.accessToken && Date.now() < auth.expiresAt) return auth.accessToken;
  if (_refreshing) return _refreshing;
  _refreshing = (async () => {
    const body = new URLSearchParams({
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      refresh_token: auth.refreshToken,
      grant_type: 'refresh_token',
    });
    const res = await postForm(OAUTH_TOKEN, body);
    if (!res.access_token) throw new Error(res.error_description || res.error || 'refresh failed');
    auth.accessToken = res.access_token;
    auth.expiresAt = Date.now() + (res.expires_in || 3600) * 1000 - 60_000;
    return auth.accessToken;
  })().finally(() => { _refreshing = null; });
  return _refreshing;
}

// ---------- Drive helpers ----------
async function ensureRootFolder() {
  if (auth.rootFolderId) return auth.rootFolderId;
  const tok = await accessToken();
  const name = auth.rootFolderName || DEFAULT_ROOT_FOLDER;
  const safe = name.replace(/'/g, "\\'");
  const q = `name='${safe}' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`;
  const list = await driveJSON(`/files?q=${encodeURIComponent(q)}&fields=files(id)`, { tok });
  if (list.files && list.files[0]) {
    auth.rootFolderId = list.files[0].id;
    return auth.rootFolderId;
  }
  const created = await driveJSON(`/files?fields=id`, {
    tok, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root'],
    }),
  });
  auth.rootFolderId = created.id;
  return auth.rootFolderId;
}

async function ensureSubfolder(name, parentId) {
  if (!name) return parentId;
  const tok = await accessToken();
  const safe = name.replace(/'/g, "\\'");
  const q = `name='${safe}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const list = await driveJSON(`/files?q=${encodeURIComponent(q)}&fields=files(id)`, { tok });
  if (list.files && list.files[0]) return list.files[0].id;
  const created = await driveJSON(`/files?fields=id`, {
    tok, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name, mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  });
  return created.id;
}

function driveJSON(pathQs, { tok, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${DRIVE_API}${pathQs}`);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      agent: httpsAgent,
      headers: { Authorization: `Bearer ${tok}`, ...headers },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); }
        } else {
          reject(new Error(`Drive ${res.statusCode}: ${buf.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function postForm(urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = body.toString();
    const req = https.request({
      hostname: u.hostname, path: u.pathname + (u.search || ''),
      method: 'POST',
      agent: httpsAgent,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf || '{}')); }
        catch (_) { resolve({ raw: buf, status: res.statusCode }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sanitize(s) {
  return String(s == null ? '' : s)
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 200) || 'file';
}

// ---------- Luna: arm — accept refresh token from app ----------
service.register('arm', (message) => {
  const p = message.payload || {};
  setAuth({
    clientId: p.clientId,
    clientSecret: p.clientSecret,
    refreshToken: p.refreshToken,
    rootFolder: p.rootFolder,
  });
  message.respond({ returnValue: true });
});

// ---------- Luna: storage — Drive quota ----------
service.register('storage', async (message) => {
  const p = message.payload || {};
  if (p.clientId || p.refreshToken) setAuth(p);
  try {
    const tok = await accessToken();
    const data = await driveJSON(`/about?fields=storageQuota,user`, { tok });
    const q = data.storageQuota || {};
    const limit = parseInt(q.limit || '0', 10);
    const used  = parseInt(q.usage || '0', 10);
    message.respond({
      returnValue: true,
      total: limit,
      used,
      free: limit ? Math.max(0, limit - used) : 0,
      email: (data.user && data.user.emailAddress) || '',
    });
  } catch (e) {
    message.respond({ returnValue: false, errorText: String(e.message || e) });
  }
});

// ---------- Luna: upload (subscription) ----------
//
// Payload: { id, sourceUrl, filename, subdir, clientId, refreshToken }
// Subscribe to receive periodic { status, total, written, error, fileId } updates.
// status ∈ "starting" | "uploading" | "ready" | "error".

const uploads = {};

service.register('upload', async (message) => {
  const p = message.payload || {};
  const id = String(p.id || Date.now());

  if (uploads[id]) {
    if (message.isSubscription) uploads[id].subscribers.push(message);
    message.respond({ returnValue: true, id, ...stateOf(id), subscribed: !!message.isSubscription });
    return;
  }

  if (p.clientId || p.refreshToken) setAuth(p);
  const sourceUrl = p.sourceUrl || '';
  const filename = sanitize(p.filename);
  const subdir   = sanitize(p.subdir).slice(0, 80);
  if (!sourceUrl) { message.respond({ returnValue: false, errorText: 'missing sourceUrl' }); return; }

  const state = uploads[id] = {
    id, sourceUrl, filename, subdir,
    total: 0, received: 0, written: 0,
    status: 'starting', stage: 'starting', error: null,
    fileId: null, fileName: filename,
    started: Date.now(),
    subscribers: [],
  };

  message.respond({ returnValue: true, id, ...stateOf(id), subscribed: !!message.isSubscription });
  if (message.isSubscription) state.subscribers.push(message);

  go(state).catch(err => {
    state.status = 'error';
    state.stage = 'error';
    state.error = String(err.message || err);
    emit(id);
  }).finally(() => {
    // Drop the entry after a short grace so a retry of the same dlId
    // gets a fresh upload session instead of re-attaching to a dead one.
    setTimeout(() => { delete uploads[id]; }, 60_000);
  });
});

function stateOf(id) {
  const d = uploads[id];
  if (!d) return null;
  return {
    total: d.total, received: d.received, written: d.written,
    status: d.status, stage: d.stage, error: d.error,
    fileId: d.fileId, fileName: d.fileName,
  };
}

function emit(id) {
  const d = uploads[id];
  if (!d) return;
  const payload = { returnValue: true, id, ...stateOf(id) };
  d.subscribers = d.subscribers.filter(sub => {
    try { sub.respond(payload); return true; } catch (_) { return false; }
  });
}

// Pipeline: GET sourceUrl → resumable Drive upload session → stream PUT chunks.
async function go(state) {
  state.stage = 'authorizing';
  emit(state.id);
  const root = await ensureRootFolder();
  const parent = state.subdir ? await ensureSubfolder(state.subdir, root) : root;
  const tok = await accessToken();

  state.stage = 'opening-session';
  emit(state.id);
  const sessionUrl = await openResumable({
    tok,
    metadata: { name: state.filename, parents: [parent] },
  });

  state.stage = 'connecting-source';
  emit(state.id);

  const CHUNK = 8 * 1024 * 1024;
  // Connect to the source with a bounded retry. A seedr link minted the
  // moment a torrent finishes can 403/"preparing" for a few seconds (cold
  // start); one-shotting that surfaced "source HTTP 403" on the queue card
  // for a file that is genuinely sitting in seedr. Only the CONNECT phase
  // is retried — once bytes are streaming a failure must fail the job,
  // since the Drive resumable session offset can't rewind.
  const connectSource = (attempt) => new Promise((cres, crej) => {
    httpGetFollow(state.sourceUrl, (err, res) => {
      if (err || (res.statusCode !== 200 && res.statusCode !== 206)) {
        if (res) { try { res.resume(); } catch (_) {} }
        const e = err || new Error(`source HTTP ${res.statusCode}`);
        if (attempt < 2) setTimeout(() => connectSource(attempt + 1).then(cres, crej), 4000 * (attempt + 1));
        else crej(e);
        return;
      }
      cres(res);
    });
  });
  const res = await connectSource(0);
  await new Promise((resolve, reject) => {
      state.total = parseInt(res.headers['content-length'] || '0', 10) || 0;
      state.status = 'uploading';
      state.stage = 'streaming';
      emit(state.id);

      // Idle timeout — if no bytes arrive for 60s, abort.
      let idleTimer = null;
      function bumpIdle() {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          try { res.destroy(new Error('source idle timeout')); } catch (_) {}
        }, 60_000);
      }
      bumpIdle();

      // Chunk queue. We keep incoming buffers as a list and only concat at
      // the moment we need to slice an 8 MB chunk for Drive. Avoids the
      // O(N) re-copy that Buffer.concat([buf, chunk]) does on every data
      // event when buf is already large.
      const queue = [];
      let queued = 0;
      let offset = 0;
      let lastEmit = 0;
      let pumpChain = Promise.resolve();

      function takeBytes(n) {
        // Pull exactly n bytes off the front of the queue.
        const out = Buffer.allocUnsafe(n);
        let written = 0;
        while (written < n) {
          const head = queue[0];
          const need = n - written;
          if (head.length <= need) {
            head.copy(out, written);
            written += head.length;
            queue.shift();
          } else {
            head.copy(out, written, 0, need);
            queue[0] = head.slice(need);
            written += need;
          }
        }
        queued -= n;
        return out;
      }

      function pumpChunk(final) {
        pumpChain = pumpChain.then(async () => {
          while (queued >= CHUNK || (final && queued > 0)) {
            const size = final && queued < CHUNK ? queued : CHUNK;
            const chunk = takeBytes(size);
            const total = state.total || (final ? offset + chunk.length : '*');
            const isLast = final && queued === 0;
            const result = await putChunk(sessionUrl, chunk, offset, total, isLast);
            offset += chunk.length;
            state.written = offset;
            if (Date.now() - lastEmit > 600) { lastEmit = Date.now(); emit(state.id); }
            if (result && result.fileId) {
              state.fileId = result.fileId;
              state.status = 'ready';
              state.stage = 'ready';
              emit(state.id);
              if (idleTimer) clearTimeout(idleTimer);
              resolve();
              return;
            }
          }
        }).catch((err) => {
          state.status = 'error';
          state.stage = 'error';
          state.error = String(err.message || err);
          emit(state.id);
          if (idleTimer) clearTimeout(idleTimer);
          reject(err);
        });
      }

      res.on('data', (chunk) => {
        bumpIdle();
        queue.push(chunk);
        queued += chunk.length;
        state.received += chunk.length;
        // Throttle emits to ~1.5/s so UI moves while we're buffering toward
        // the first 8 MB chunk, but we don't flood Luna with progress events.
        if (Date.now() - lastEmit > 600) { lastEmit = Date.now(); emit(state.id); }
        if (queued >= CHUNK) pumpChunk(false);
      });
      res.on('end', () => {
        if (idleTimer) clearTimeout(idleTimer);
        pumpChunk(true);
      });
      res.on('error', (e) => {
        if (idleTimer) clearTimeout(idleTimer);
        state.status = 'error';
        state.stage = 'error';
        state.error = String(e.message || e);
        emit(state.id);
        reject(e);
      });
  });
}

// Get with redirect following. Single error/response handler — errors at any
// depth surface via cb(err). 30s connect/header timeout per hop.
function httpGetFollow(targetUrl, cb, depth = 0) {
  if (depth > 5) { cb(new Error('too many redirects')); return; }
  let settled = false;
  const safe = (fn) => (...args) => { if (settled) return; settled = true; fn(...args); };
  const lib = targetUrl.startsWith('https:') ? https : http;
  let req;
  try {
    req = lib.get(targetUrl, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try { res.resume(); } catch (_) {}
        // Resolve to whatever the next hop yields. The current settled flag
        // applies to THIS hop's request; the next hop manages its own.
        settled = true;
        httpGetFollow(res.headers.location, cb, depth + 1);
        return;
      }
      safe(cb)(null, res);
    });
  } catch (e) {
    cb(e);
    return;
  }
  req.setTimeout(30_000, () => {
    try { req.destroy(new Error('source connect timeout')); } catch (_) {}
  });
  req.on('error', safe((e) => cb(e)));
}

function openResumable({ tok, metadata }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(metadata);
    const u = new URL(`${DRIVE_UPLOAD}/files?uploadType=resumable`);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST',
      agent: httpsAgent,
      headers: {
        Authorization: `Bearer ${tok}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/octet-stream',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        if (res.statusCode === 200 && res.headers.location) {
          resolve(res.headers.location);
        } else {
          reject(new Error(`session ${res.statusCode}: ${buf.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// PUT a chunk. If isLast, includes a definitive total in Content-Range and
// expects a 200/201 with file metadata.
function putChunk(sessionUrl, chunk, offset, total, isLast) {
  return new Promise((resolve, reject) => {
    const u = new URL(sessionUrl);
    const end = offset + chunk.length - 1;
    const totalStr = total === '*' ? '*' : String(total);
    let settled = false;
    const settle = (fn) => (...args) => { if (settled) return; settled = true; fn(...args); };
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      method: 'PUT',
      agent: httpsAgent,
      headers: {
        'Content-Length': chunk.length,
        'Content-Range': `bytes ${offset}-${end}/${totalStr}`,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        if (res.statusCode === 308) {
          settle(resolve)({}); // continue
        } else if (res.statusCode === 200 || res.statusCode === 201) {
          try {
            const meta = JSON.parse(buf);
            settle(resolve)({ fileId: meta.id });
          } catch (_) { settle(resolve)({}); }
        } else {
          settle(reject)(new Error(`PUT ${res.statusCode}: ${buf.slice(0, 200)}`));
        }
      });
    });
    // 5-minute ceiling per chunk. If a PUT hangs (network blip or Drive
    // stalling), surface it as an error rather than freeze the UI.
    req.setTimeout(5 * 60_000, () => {
      try { req.destroy(new Error('Drive PUT timeout')); } catch (_) {}
    });
    req.on('error', settle(reject));
    req.write(chunk);
    req.end();
  });
}

// ---------- Luna: delete ----------
service.register('delete', async (message) => {
  const p = message.payload || {};
  if (p.clientId || p.refreshToken) setAuth(p);
  const fileId = p.fileId || '';
  if (!fileId) { message.respond({ returnValue: false, errorText: 'missing fileId' }); return; }
  try {
    const tok = await accessToken();
    await driveJSON(`/files/${encodeURIComponent(fileId)}`, { tok, method: 'DELETE' });
    message.respond({ returnValue: true });
  } catch (e) {
    message.respond({ returnValue: false, errorText: String(e.message || e) });
  }
});

// ---------- Local stream proxy ----------
//
// http://127.0.0.1:5051/play?id=<driveFileId>
// Forwards Range to Drive (alt=media) and pipes the response back.
//
// Why proxy? <video> can't add Authorization headers to its src. We hold the
// token here and add it.

// Track listen state so the app can ask whether the proxy actually came up.
// webOS native services may be blocked from binding listening sockets — we
// want to know rather than silently fail.
const proxyState = { listening: false, error: null, address: null };

// Tiny file logger so we can see exactly what <video> sends and what the
// service responds when playback "doesn't work" — generic media errors
// give us nothing, but a log line per request tells the whole story.
const PROXY_LOG = '/tmp/dumiflix-proxy.log';
function plog(line) {
  try {
    fs.appendFileSync(PROXY_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch (_) {}
}

const proxyServer = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  if (u.pathname !== '/play') { res.writeHead(404); res.end(); return; }
  const fileId = String(u.query.id || '');
  if (!fileId) { res.writeHead(400); res.end('missing id'); return; }
  const isHead = (req.method || 'GET').toUpperCase() === 'HEAD';
  const reqRange = req.headers.range || '';
  plog(`→ ${req.method} id=${fileId.slice(0, 12)} range=${reqRange || '(none)'} ua=${(req.headers['user-agent'] || '').slice(0, 40)}`);

  // A client that opens /play and stops reading otherwise pins the Drive
  // socket forever; clamp the whole request at 2 minutes idle.
  req.socket.setTimeout(120_000, () => { try { req.socket.destroy(); } catch (_) {} });

  let tok;
  try { tok = await accessToken(); }
  catch (e) { res.writeHead(503); res.end(`auth: ${e.message}`); return; }

  const target = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  // For HEAD we ask Drive for `bytes=0-0` so it returns 206 + Content-Range
  // cheaply — we synthesize a clean 200 from those headers without piping
  // any body. webOS `<video>` issues HEAD before the first GET to learn
  // size + Accept-Ranges; if we forwarded a full body on HEAD the player
  // would mis-parse and bail with "decoding error".
  const upstreamRange = req.headers.range
    || (isHead ? 'bytes=0-0' : null);
  const opts = {
    agent: httpsAgent,
    headers: {
      Authorization: `Bearer ${tok}`,
      ...(upstreamRange ? { Range: upstreamRange } : {}),
    },
  };
  const proxyReq = https.get(target, opts, (proxyRes) => {
    plog(`  drive ${proxyRes.statusCode} ct=${proxyRes.headers['content-type'] || ''} cr=${proxyRes.headers['content-range'] || ''} loc=${(proxyRes.headers.location || '').slice(0, 60)}`);
    // Drive sometimes redirects to a CDN — follow once.
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      const next = proxyRes.headers.location;
      // Reuse the keep-alive agent so seek bursts don't pay a full TLS
      // handshake to the CDN every Range request — that adds ~500ms per seek
      // on a TV-grade CPU.
      const nextOpts = {
        agent: httpsAgent,
        headers: upstreamRange ? { Range: upstreamRange } : {},
      };
      const r2req = https.get(next, nextOpts, (r2) => {
        plog(`  cdn ${r2.statusCode} ct=${r2.headers['content-type'] || ''} cr=${r2.headers['content-range'] || ''} cl=${r2.headers['content-length'] || ''}`);
        relay(r2, res, { isHead });
      });
      r2req.setTimeout(30_000, () => { try { r2req.destroy(new Error('cdn timeout')); } catch (_) {} });
      r2req.on('error', (e) => { plog(`  cdn err ${e.message}`); endErr(res, e); });
      proxyRes.resume();
      return;
    }
    relay(proxyRes, res, { isHead });
  });
  proxyReq.setTimeout(30_000, () => { try { proxyReq.destroy(new Error('drive timeout')); } catch (_) {} });
  proxyReq.on('error', (e) => { plog(`  drive err ${e.message}`); endErr(res, e); });
});

proxyServer.on('listening', () => {
  proxyState.listening = true;
  try { proxyState.address = JSON.stringify(proxyServer.address()); } catch (_) {}
});
proxyServer.on('error', (e) => {
  proxyState.listening = false;
  proxyState.error = String(e && (e.code || e.message) || e);
});
try { proxyServer.listen(STREAM_PORT, '127.0.0.1'); }
catch (e) { proxyState.error = `listen-throw: ${String(e && (e.code || e.message) || e)}`; }

service.register('status', (message) => {
  message.respond({
    returnValue: true,
    proxy: proxyState,
    pid: process.pid,
    node: process.version,
    platform: process.platform,
  });
});

// ---------- Luna: restart — relaunch the app after a webOS network kill ----------
//
// webOS 25 can silently kill the PAGE's browser network process for the
// rest of a session: every page-side fetch/XHR then rejects with a
// network-level TypeError, TV-wide, until a full app relaunch -- while this
// service runs as a separate Node process with its OWN network stack, so it
// keeps working and is what the app calls to fix itself (see ledger #18 /
// app.js's netdeath detector).
//
// luna://com.webos.applicationManager/launch is the exact same bus method
// app.js already calls successfully FROM THE PAGE (via PalmServiceBridge,
// see switchTvToSoundbarInput()/handoffToNativePlayer() in app.js) to
// launch a configured HDMI input or com.webos.app.mediadiscovery. This just
// targets our own app id
// instead, and issues the call from the SERVICE rather than the page,
// because the page is about to close itself and the service is what
// outlives that close to fire the (deliberately delayed) launch.
//
// appinfo.json has "handlesRelaunch": false. Per webOS App Manager
// semantics that means `launch` against an app that's STILL RUNNING just
// brings the existing instance to the foreground -- it does NOT reload the
// page or restart the process. So this only produces a genuine relaunch if
// the page has ALREADY closed itself (window.close(), called by app.js's
// _netDeathExecuteRestart() right after invoking this method) by the time
// the delayed call below fires; the delay exists to give that close time to
// actually take effect.
//
// Belt-and-suspenders for "the page couldn't close itself": also try
// luna://com.webos.service.applicationManager/closeByAppId immediately.
// Unlike `launch`, this is NOT part of webOS TV's public third-party SDK
// (webostv.developer.lge.com only documents launch/getAppLoadStatus on
// com.webos.applicationManager) -- closeByAppId only turned up in webOS OSE
// / devmode community references, so whether THIS service's ACL permits it
// is genuinely unverified. It costs nothing to try: on success it
// guarantees the page is gone before the delayed launch fires even if
// window.close() silently no-op'd; on failure/rejection it's swallowed and
// changes nothing -- the delayed launch below still fires either way, and
// in the worst case (both self-close paths fail) this degrades to a
// harmless no-op foreground-bring rather than a crash.
//
// Closing the page can tear down the whole app bundle, including this
// service process, before a delayed local launch fires. The TV can then
// remain on Home without relaunching the app. An SSAP launch from a
// separate machine can cold-start the app independently of that lifecycle.
// tv-service/server.py exposes POST /tv/relaunch for this purpose.
// _relaunchViaLaptop() below runs FIRST, before the local attempts, using
// the service network stack (which can still work when the page's is dead).
function _relaunchViaLaptop(base, token) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(String(base || ''));
    } catch (e) {
      try { plog(`restart: laptop relaunch — bad base "${String(base || '')}": ${String(e && e.message || e)}`); } catch (_) {}
      resolve(false);
      return;
    }
    if (u.protocol !== 'http:') {
      // LAN-only deploy (server.py binds plain http) -- deliberately not
      // supporting https here; see server.py's DUMIFLIX_TV_BIND default.
      try { plog(`restart: laptop relaunch — skipping non-http base "${u.protocol}//${u.host}"`); } catch (_) {}
      resolve(false);
      return;
    }
    const path = (u.pathname === '/' ? '' : u.pathname) +
      '/tv/relaunch?token=' + encodeURIComponent(token || '');
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path, method: 'POST',
      timeout: 5000, headers: { 'Content-Length': 0 },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { plog(`restart: laptop /tv/relaunch -> ${res.statusCode} ${body.slice(0, 200)}`); } catch (_) {}
        // The response arriving is NOT required for the relaunch to
        // succeed -- server.py acts on its own delay regardless -- this is
        // purely for the log.
        resolve(res.statusCode === 200);
      });
    });
    req.on('error', (e) => {
      try { plog(`restart: laptop /tv/relaunch error ${String(e && e.message || e)}`); } catch (_) {}
      resolve(false);
    });
    req.on('timeout', () => {
      try { req.destroy(); } catch (_) {}
      try { plog('restart: laptop /tv/relaunch timeout'); } catch (_) {}
      resolve(false);
    });
    req.end();
  });
}
service.register('restart', (message) => {
  // Payload: { base, token } — the CURRENTLY ACTIVE remux engine's base URL
  // and its own token, exactly as app.js's netdeath detector reads them
  // from Remux.base()/its engine-scoped Storage token (see
  // _netDeathEngineInfo() in app.js). Fired FIRST, before anything else
  // below, so it has the best possible head start before this process
  // might get torn down along with the app bundle.
  const p = message.payload || {};
  const engineBase = String(p.base || '').trim();
  // Respond the moment the laptop has been notified (or that path is
  // unavailable): the PAGE holds itself open waiting for this response
  // before window.close()ing — fire-drill showed anything else races the
  // service cold start and the laptop POST never leaves the box. After the
  // POST lands, server.py acts on its own 3s delay and needs nothing from
  // this process, so being reaped right after responding is fine.
  let responded = false;
  const respondOnce = (ok, via) => {
    if (responded) return;
    responded = true;
    try { message.respond({ returnValue: !!ok, via: via }); } catch (_) {}
  };
  if (engineBase) {
    _relaunchViaLaptop(engineBase, p.token)
      .then((ok) => respondOnce(ok, 'laptop'))
      .catch(() => respondOnce(false, 'laptop-error'));
  } else {
    try { plog('restart: no active-engine base in payload — laptop relaunch skipped, local attempts only'); } catch (_) {}
    respondOnce(false, 'no-base');
  }
  setTimeout(() => respondOnce(false, 'timeout'), 4500);
  // Respond LAST, not first: this is a DYNAMIC service — webOS reaps the
  // Node process as soon as no call is pending, so the original
  // respond-then-setTimeout shape let the process die before the delayed
  // launch could fire, potentially leaving the TV on Home.
  // A withheld respond() is what keeps us alive through the whole dance.
  try {
    service.call('luna://com.webos.service.applicationManager/closeByAppId',
      { id: 'com.dumiflix.tv' },
      (msg) => {
        try { plog(`restart: closeByAppId resp=${JSON.stringify(msg && msg.payload)}`); } catch (_) {}
      });
  } catch (e) {
    try { plog(`restart: closeByAppId threw ${String(e && e.message || e)}`); } catch (_) {}
  }
  const fire = (attempt) => {
    try {
      service.call('luna://com.webos.applicationManager/launch',
        { id: 'com.dumiflix.tv' },
        (msg) => {
          try { plog(`restart: launch attempt ${attempt} resp=${JSON.stringify(msg && msg.payload)}`); } catch (_) {}
          if (attempt === 1) {
            // One more pass in case attempt 1 raced the page's own close
            // (launch against a still-closing instance only foregrounds it).
            setTimeout(() => fire(2), 3000);
          } else {
            respondOnce(true, 'local-launch');
          }
        });
    } catch (e) {
      try { plog(`restart: launch attempt ${attempt} threw ${String(e && e.message || e)}`); } catch (_) {}
      respondOnce(false, 'local-error');
    }
  };
  setTimeout(() => fire(1), 1500);
});

// ---------- Luna: discover — find the companion relay on the LAN ----------
//
// Payload: { port?: number, signature?: string }
// Returns: { found: true, host: "192.0.2.20:5052", info: {...} } on success,
//          { found: false, scanned: N } if nothing answered.
//
// Flow:
//   1. Ask connectionmanager for the TV's current IP + subnet.
//   2. Iterate every host on the /24 (skip self, .0, .1, .255).
//   3. Fire short-timeout HTTP GETs in parallel against /health on each
//      candidate. The first one that responds with a JSON body containing
//      `music_dir` (our signature) wins.
//   4. Cache nothing on the service side — the app stores the winner in
//      localStorage so the next launch starts from the cached host.

function _getTVNetwork() {
  // luna://com.webos.service.connectionmanager/getStatus reports the active
  // interface. Wired and Wi-Fi both surface as { wired|wifi: { state, ipAddress,
  // netmask, gateway, ... } }. We pick whichever is "connected".
  return new Promise((resolve, reject) => {
    const sub = service.call(
      'luna://com.webos.service.connectionmanager/getStatus',
      { subscribe: false },
      (msg) => {
        if (!msg || msg.payload == null) {
          return reject(new Error('connectionmanager: empty payload'));
        }
        const p = msg.payload;
        if (p.returnValue === false) {
          return reject(new Error(p.errorText || 'connectionmanager error'));
        }
        const cand = [p.wired, p.wifi].filter(Boolean);
        const active = cand.find(c => c.state === 'connected' && c.ipAddress);
        if (!active) return reject(new Error('no active network interface'));
        resolve({
          ip:      active.ipAddress,
          netmask: active.netmask || '255.255.255.0',
          gateway: active.gateway || '',
        });
      });
    setTimeout(() => {
      try { sub && sub.cancel && sub.cancel(); } catch (_) {}
      reject(new Error('connectionmanager: timeout'));
    }, 4000);
  });
}

function _probeHealth(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request({
      host, port, path: '/health', method: 'GET',
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume(); resolve(null); return;
      }
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(parts).toString('utf8'));
          // Signature: our daemon always returns { ok: true, music_dir, ... }
          if (j && j.ok === true && typeof j.music_dir === 'string') {
            resolve({ host: `${host}:${port}`, info: j });
            return;
          }
        } catch (_) {}
        resolve(null);
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(null); });
    req.end();
  });
}

service.register('discover', async (message) => {
  const p = message.payload || {};
  const port = parseInt(p.port || 5052, 10);
  try {
    const net = await _getTVNetwork();
    // Build the /24 candidate list — slot in the gateway and TV's IP last
    // so we don't waste batches on hosts that obviously aren't the relay.
    const parts = net.ip.split('.').map(n => parseInt(n, 10));
    if (parts.length !== 4 || parts.some(isNaN)) {
      message.respond({ returnValue: false, errorText: `bad ip: ${net.ip}` });
      return;
    }
    const base = `${parts[0]}.${parts[1]}.${parts[2]}.`;
    const self = parts[3];
    const candidates = [];
    for (let i = 2; i < 255; i++) {
      if (i === self) continue;
      candidates.push(base + i);
    }
    // Probe in parallel batches of 64 so we don't open 250 sockets at once
    // (webOS Node may cap fd's tight). 400 ms timeout per probe; whole /24
    // finishes in ~2 s on a quiet LAN.
    const BATCH = 64;
    const TIMEOUT_MS = 400;
    let found = null;
    let scanned = 0;
    for (let start = 0; start < candidates.length && !found; start += BATCH) {
      const chunk = candidates.slice(start, start + BATCH);
      const results = await Promise.all(chunk.map(h => _probeHealth(h, port, TIMEOUT_MS)));
      scanned += chunk.length;
      found = results.find(Boolean) || null;
    }
    if (found) {
      message.respond({ returnValue: true, found: true,
                        host: found.host, info: found.info,
                        scanned, tv_ip: net.ip });
    } else {
      message.respond({ returnValue: true, found: false,
                        scanned, tv_ip: net.ip });
    }
  } catch (e) {
    message.respond({ returnValue: false, errorText: String(e.message || e) });
  }
});

// ---------- Luna: probe — measure throughput on TV ----------
//
// Payload: { seedrUrl, bytes, mode: 'seedr'|'stream',
//            clientId?, clientSecret?, refreshToken? }
// Returns timings for comparing transfer paths.
//
// mode 'drive' (probeDriveBuffered) was removed: it pulled the whole
// requested byte range into one in-memory Buffer.concat with no cap on
// `bytes`, and `grep -rn "'probe'" tv-app/app.js tv-app/js/*.js` (plus a
// repo-wide grep for probeDriveBuffered/probeSeedrFetch/probeDriveStreamed)
// turns up zero callers of this Luna method anywhere in the shipped
// client — it's a leftover throughput-comparison helper from before the
// current native-player pipeline. If a whole-buffer Drive probe is ever
// needed again, clamp `bytes` to a sane maximum before reintroducing it.
service.register('probe', async (message) => {
  const p = message.payload || {};
  if (p.clientId || p.refreshToken) setAuth(p);
  const seedrUrl = p.seedrUrl;
  const bytes = parseInt(p.bytes || 52428800, 10);
  const mode = p.mode || 'seedr';
  if (!seedrUrl) { message.respond({ returnValue: false, errorText: 'missing seedrUrl' }); return; }

  try {
    if (mode === 'seedr') {
      const r = await probeSeedrFetch(seedrUrl, bytes);
      message.respond({ returnValue: true, ...r });
    } else if (mode === 'stream') {
      const r = await probeDriveStreamed(seedrUrl, bytes);
      message.respond({ returnValue: true, ...r });
    } else {
      message.respond({ returnValue: false, errorText: 'mode must be seedr|stream' });
    }
  } catch (e) {
    message.respond({ returnValue: false, errorText: String(e.message || e) });
  }
});

function probeSeedrFetch(seedrUrl, bytes) {
  return new Promise((resolve, reject) => {
    const u = new URL(seedrUrl);
    const t0 = Date.now();
    const req = https.request({
      hostname: u.hostname, path: u.pathname + (u.search || ''),
      method: 'GET', agent: httpsAgent,
      headers: { Range: `bytes=0-${bytes - 1}` },
    }, (res) => {
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        return reject(new Error(`seedr ${res.statusCode}`));
      }
      let received = 0;
      res.on('data', (c) => { received += c.length; });
      res.on('end', () => {
        const t1 = Date.now();
        resolve({
          mode: 'seedr',
          bytes_requested: bytes,
          bytes_received: received,
          status: res.statusCode,
          total_ms: t1 - t0,
          mbps: received > 0 ? (received * 8 / 1e6) / ((t1 - t0) / 1000) : 0,
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function probeDriveStreamed(seedrUrl, bytes) {
  const tok = await accessToken();
  const sessionUrl = await openResumable({
    tok,
    metadata: { name: '_dumiflix_tv_probe_stream.bin', mimeType: 'application/octet-stream' },
  });

  const t0 = Date.now();
  // Open seedr fetch and pipe its body straight into a Drive PUT.
  return await new Promise((resolve, reject) => {
    const su = new URL(seedrUrl);
    const seedrReq = https.request({
      hostname: su.hostname, path: su.pathname + (su.search || ''),
      method: 'GET', agent: httpsAgent,
      headers: { Range: `bytes=0-${bytes - 1}` },
    }, (seedrRes) => {
      if (seedrRes.statusCode !== 200 && seedrRes.statusCode !== 206) {
        return reject(new Error(`seedr ${seedrRes.statusCode}`));
      }
      const cl = parseInt(seedrRes.headers['content-length'] || '0', 10) || bytes;
      const du = new URL(sessionUrl);
      const putReq = https.request({
        hostname: du.hostname, path: du.pathname + (du.search || ''),
        method: 'PUT', agent: httpsAgent,
        headers: {
          'Content-Length': cl,
          'Content-Range': `bytes 0-${cl - 1}/${cl}`,
        },
      }, (putRes) => {
        let body = '';
        putRes.on('data', (c) => body += c);
        putRes.on('end', () => {
          const t1 = Date.now();
          let fileId = null;
          try { fileId = JSON.parse(body).id || null; } catch (_) {}
          resolve({
            mode: 'stream',
            bytes: cl,
            total_ms: t1 - t0,
            mbps: (cl * 8 / 1e6) / ((t1 - t0) / 1000),
            drive_status: putRes.statusCode,
            fileId,
          });
        });
        putRes.on('error', reject);
      });
      putReq.on('error', reject);
      seedrRes.pipe(putReq);
    });
    seedrReq.on('error', reject);
    seedrReq.end();
  });
}

function relay(src, res, opts) {
  const isHead = !!(opts && opts.isHead);
  const status = src.statusCode || 200;
  const upstreamCT = (src.headers['content-type'] || '').toLowerCase();

  // If Drive responded with an error envelope (HTML / JSON), don't blindly
  // pipe it into <video> — that's exactly what makes the player show
  // "source not supported" instead of the actual reason. Surface upstream
  // status + a short body so the app can toast something useful.
  const looksLikeError = status >= 400
    || upstreamCT.startsWith('text/html')
    || upstreamCT.startsWith('application/json');
  if (looksLikeError) {
    let buf = '';
    src.setEncoding('utf8');
    src.on('data', (c) => { if (buf.length < 1024) buf += c; });
    src.on('end', () => {
      try {
        res.writeHead(status >= 400 ? status : 502, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Connection': 'close',
        });
        res.end(`drive ${status} ${upstreamCT}: ${buf.slice(0, 500)}`);
      } catch (_) {}
    });
    src.on('error', () => { try { res.end(); } catch (_) {} });
    return;
  }

  // HEAD response: synthesize a clean 200 with the full file's
  // Content-Length (parsed from `bytes 0-0/<total>`), then end without
  // piping. We must drain the upstream stream so the keep-alive socket is
  // returned to the agent's pool instead of being half-read forever.
  if (isHead) {
    const cr = src.headers['content-range'] || '';
    const m = /\/(\d+)\s*$/.exec(cr);
    const total = m ? m[1] : src.headers['content-length'];
    const h = { 'Accept-Ranges': 'bytes' };
    if (src.headers['content-type']) h['Content-Type'] = src.headers['content-type'];
    if (total) h['Content-Length'] = String(total);
    if (src.headers['last-modified']) h['Last-Modified'] = src.headers['last-modified'];
    if (src.headers['etag']) h['ETag'] = src.headers['etag'];
    plog(`  ← HEAD 200 ct=${h['Content-Type'] || ''} cl=${h['Content-Length'] || ''}`);
    res.writeHead(200, h);
    res.end();
    src.resume();
    return;
  }
  const headers = {};
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    if (src.headers[k]) headers[k] = src.headers[k];
  }
  if (!headers['accept-ranges']) headers['accept-ranges'] = 'bytes';
  // DO NOT force a content-type when Drive omits one. webOS sniffs the
  // container from the bytes and picks the right decoder; lying about it
  // (e.g. defaulting to video/mp4 for an MKV) is what makes the player
  // bail with "no supported file was found".
  plog(`  ← ${status} ct=${headers['content-type'] || ''} cl=${headers['content-length'] || ''} cr=${headers['content-range'] || ''}`);
  res.writeHead(status, headers);
  src.pipe(res);
  res.on('close', () => plog(`  conn closed (status=${status})`));
}

function endErr(res, e) {
  try { res.writeHead(502); res.end(String(e.message || e)); } catch (_) {}
}
