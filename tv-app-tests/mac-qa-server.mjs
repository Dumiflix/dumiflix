#!/usr/bin/env node
// Local DumiFlix webOS simulator for QA against a configured engine.
// Credentials are read at runtime and are never logged.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const option = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
if (argv.includes('--help')) {
  process.stdout.write([
    'Usage: node mac-qa-server.mjs [options]',
    '  --root PATH          TV app directory (default: ../tv-app)',
    '  --port PORT          Local simulator port (default: 8766)',
    '  --laptop URL         Laptop backend URL (required)',
    '  --run-script PATH    Optional user-supplied PowerShell token configuration',
    '  --seedr-config PATH  Optional ignored JSON file containing Seedr tokens',
    '',
    'DUMIFLIX_QA_LAPTOP_TOKEN may be used instead of --run-script.',
  ].join('\n'));
  process.exit(0);
}

const root = path.resolve(option('--root', path.join(here, '..', 'tv-app')));
const port = Number(option('--port', process.env.DUMIFLIX_QA_PORT || '8766'));
const laptopOrigin = option(
  '--laptop',
  process.env.DUMIFLIX_QA_LAPTOP_ORIGIN || '',
).replace(/\/+$/, '');
const runScript = option('--run-script', process.env.DUMIFLIX_QA_RUN_SCRIPT || '');
const seedrConfig = option('--seedr-config', process.env.DUMIFLIX_QA_SEEDR_CONFIG || '');

function laptopToken() {
  if (process.env.DUMIFLIX_QA_LAPTOP_TOKEN) return process.env.DUMIFLIX_QA_LAPTOP_TOKEN;
  if (!runScript) return '';
  const script = fs.readFileSync(runScript, 'utf8');
  const match = script.match(/\$env:DUMIFLIX_TV_TOKEN\s*=\s*(["'])(.*?)\1/i);
  return match ? match[2] : '';
}

function seedrState() {
  if (!seedrConfig) return {};
  const value = JSON.parse(fs.readFileSync(seedrConfig, 'utf8'));
  return {
    email: value.email || '',
    access_token: value.access_token || '',
    refresh_token: value.refresh_token || '',
  };
}

const token = laptopToken();
if (!laptopOrigin) throw new Error('Laptop backend missing: pass --laptop or DUMIFLIX_QA_LAPTOP_ORIGIN');
if (!token) throw new Error('Laptop token missing: pass --run-script or DUMIFLIX_QA_LAPTOP_TOKEN');
const seedr = seedrState();
const simulatorHost = `http://127.0.0.1:${port}/__qa_laptop`;
const allowedFetchHosts = new Set([
  'www.seedr.cc', 'iptv-org.github.io', 'api.tvmaze.com',
  'eztvx.to', 'apibay.org', 'api.knaben.org', 'movies-api.accel.li', 'yts.mx',
  'api.opensubtitles.com', 'api.themoviedb.org', 'v3.sg.media-imdb.com',
  'music.youtube.com',
]);

const bootstrap = `<script>(function(){
  var key='dumiflix.config.v1',cfg={};
  try{cfg=JSON.parse(localStorage.getItem(key)||'{}')}catch(_){cfg={}}
  cfg['remux.engine']='laptop';
  cfg['remux.laptopHost']=${JSON.stringify(simulatorHost)};
  cfg['remux.laptopToken']=${JSON.stringify(token)};
  ${Object.keys(seedr).length ? `cfg.seedr=${JSON.stringify(seedr)};` : ''}
  if(new URLSearchParams(location.search).has('qaReset')){
    delete cfg.queue;
    Object.keys(cfg).forEach(function(k){if(k.indexOf('cw:')===0)delete cfg[k]});
  }
  localStorage.setItem(key,JSON.stringify(cfg));
  // Historical simulator marker retained for QA-client compatibility.
  sessionStorage.setItem('dumiflix.qa','mac-laptop-backend');
  var nativeFetch=window.fetch.bind(window);
  window.fetch=function(input,init){
    var raw=typeof input==='string'?input:(input&&input.url)||'';
    try{
      var parsed=new URL(raw);
      var allowed=${JSON.stringify([...allowedFetchHosts])};
      if(parsed.protocol==='https:'&&allowed.indexOf(parsed.hostname)>=0)
        return nativeFetch('/__qa_fetch?url='+encodeURIComponent(raw),init);
    }catch(_){}
    return nativeFetch(input,init);
  };
})();</script>`;

function requestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on('error', reject);
  });
}

function copyRequestHeaders(req, names) {
  const headers = {};
  for (const name of names) if (req.headers[name]) headers[name] = req.headers[name];
  return headers;
}

async function proxy(req, res, target, requestHeaders, responseHeaders) {
  const controller = new AbortController();
  const abortUpstream = () => controller.abort();
  // A video Range response can be gigabytes long. When Chromium closes or
  // swaps the <video>, stop the upstream LAN read immediately instead of
  // silently draining the abandoned movie and keeping /cache/active latched.
  req.once('aborted', abortUpstream);
  res.once('close', abortUpstream);
  try {
    const body = await requestBody(req);
    const upstream = await fetch(target, {
      method: req.method,
      headers: requestHeaders,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      signal: controller.signal,
    });
    const headers = {};
    for (const name of responseHeaders) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    res.writeHead(upstream.status, headers);
    if (req.method === 'HEAD' || !upstream.body) res.end();
    else {
      Readable.fromWeb(upstream.body)
        .on('error', () => { if (!res.writableEnded) res.destroy(); })
        .pipe(res);
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`QA proxy failed: ${error.message}`);
  }
}

const mime = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4', '.png': 'image/png', '.svg': 'image/svg+xml',
};

http.createServer(async (req, res) => {
  const incoming = new URL(req.url, `http://${req.headers.host}`);
  if (incoming.pathname === '/__qa_fetch') {
    let target;
    try { target = new URL(incoming.searchParams.get('url') || ''); }
    catch (_) { res.writeHead(400).end('Bad target'); return; }
    if (target.protocol !== 'https:' || !allowedFetchHosts.has(target.hostname)) {
      res.writeHead(403).end('Forbidden target'); return;
    }
    await proxy(
      req, res, target,
      copyRequestHeaders(req, ['content-type', 'authorization', 'api-key', 'accept', 'range']),
      // Do not forward content-length: fetch transparently decompresses JSON.
      ['content-type', 'content-range', 'accept-ranges'],
    );
    return;
  }
  if (incoming.pathname.startsWith('/__qa_laptop')) {
    const suffix = req.url.slice('/__qa_laptop'.length) || '/';
    await proxy(
      req, res, laptopOrigin + suffix,
      copyRequestHeaders(req, ['content-type', 'x-playback-token', 'authorization', 'range']),
      ['content-type', 'content-length', 'content-range', 'accept-ranges'],
    );
    return;
  }

  const relative = incoming.pathname === '/' ? 'index.html' : decodeURIComponent(incoming.pathname.slice(1));
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(file, (error, bytes) => {
    if (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Not found'); return; }
    if (relative === 'index.html') {
      bytes = Buffer.from(bytes.toString('utf8').replace('</head>', `${bootstrap}\n</head>`));
    }
    res.writeHead(200, {
      'content-type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store', 'content-length': bytes.length,
    });
    if (req.method === 'HEAD') res.end(); else res.end(bytes);
  });
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`DumiFlix QA simulator: http://127.0.0.1:${port}/?qaReset=1\n`);
});
