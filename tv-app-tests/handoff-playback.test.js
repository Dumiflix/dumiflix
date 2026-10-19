function assert(value, message = 'assertion failed') {
  if (!value) throw new Error(message);
}
function equal(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const source = await Deno.readTextFile(new URL('../tv-app/app.js', import.meta.url));
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('missing section: ' + start);
  return source.slice(a, b);
}
const handoff = section('  function swapPlaybackToGrowingCache(', '  // Kick off (or resume) a Drive upload');
const torrent = section('  function _downloadMagnetToLaptop(', '  // Switch a DIRECT (non-remux) Seedr player');
const gate = section('  function growingSeekDecision(', '  // Snappy directional seek indicator.');
const copy = section('  async function copyToGdrive(', '  function persistQueue()');
const resume = section('  function persistCurrentResume()', '  function showOverlay()');
const play = section('  async function playFromSeedrItem(', '  // Always-delete cleanup.');
const seek = section('  function resumeSeek(', '  function openPlayer(');
const recovery = section("    v.addEventListener('error', () => {", "    v.addEventListener('waiting', () => {");
const MiB = 1024 * 1024;
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }

function player(paused = false) {
  const item = { id: 'pack', name: 'Show', folderId: 'folder', driveFiles: [] };
  const cv = { _queueItem: item, fileId: 'seedr2', source: 'seedr', src: 'https://seedr/ep2', _directSeedr: true };
  const calls = { sources: [], migrations: [], toasts: [], opens: [], probes: [], released: 0, plays: 0 };
  const listeners = new Map(), timers = new Map(), entries = new Map();
  let timerId = 0;
  const v = {
    src: cv.src, currentSrc: cv.src, currentTime: 120, duration: 1000, paused,
    readyState: 4, seeking: false,
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    play() { this.paused = false; calls.plays++; return Promise.resolve(); },
    pause() { this.paused = true; },
    fastSeek(t) { this.currentTime = t; this.seeking = true; },
  };
  const cache = {
    PFX: 'VPSCACHE::', reachable: () => Promise.resolve(true),
    growingStreamUrl: id => '/cache/growing/' + id,
    streamUrl: id => '/cache/stream/' + id,
    accelerate: () => Promise.resolve({ ok: true }), armProxy: () => Promise.resolve(),
    listAll: () => Promise.resolve([]),
    probePlayUrl: id => { calls.probes.push(id); return Promise.resolve({ ok: true }); },
  };
  const ui = { classList: { remove() {}, contains: () => true }, hidden: false };
  const env = {
    state: { cv }, queue: [item], $: id => id === '#video' ? v : ui, LaptopCache: cache, PhoneCache: {},
    storeFor: () => env.Remux.engine() === 'tv' ? env.PhoneCache : cache,
    Storage: {
      getResume: id => entries.get(id),
      setResume: (id, info) => entries.set(id, info), clearResume: id => entries.delete(id),
      migrateResume(from, to, patch) {
        calls.migrations.push([from, to]);
        if (from !== to && entries.has(from)) {
          entries.set(to, { ...entries.get(from), ...patch, fileId: to }); entries.delete(from);
        }
      },
    },
    Remux: { engine: () => 'laptop', resolveCache: () => Promise.resolve(null),
      hasSession: () => false, close() {}, bindVideo() {} },
    Seedr: {}, Drive: {}, persistQueue() {}, renderQueue() {}, loadingTick() {}, scheduleRenderQueue() {},
    toast() {}, currentTab: '', renderLibrary() {}, activeWatchers: {}, sleep: () => Promise.resolve(),
    window: {}, localStorage: { setItem() {}, removeItem() {} },
    document: { body: ui, getElementById: () => ui },
    pToast: t => calls.toasts.push(t), _syncWatchdog() {},
    setBuffering() {},
    releaseSeedr: it => { if (!it._cacheCopiesPending) calls.released++; },
    resumeUpload: it => { calls.resumes = (calls.resumes || 0) + 1; },
    playDriveFile: id => calls.opens.push(id), autoQueueNextEpisode: () => Promise.resolve(),
    _seedrSiblingSubtitle: () => Promise.resolve(null), _probeSeedrStream: () => Promise.resolve(false),
    openPlayer() { throw new Error('unavailable Seedr must not open'); },
    clearSubOverlay() {}, cancelUpNext() {}, closeMenu() {},
    NativePlayer: { stopWatchdog() {}, release() {} }, DPad: { popBackHandler() {} },
    _PLAYER_PHONEKEY_RE: /^PHONE:/,
    setVideoSource(video, src) {
      calls.sources.push(src); video.src = video.currentSrc = src;
      video.currentTime = 0; video.readyState = 0; video.duration = NaN;
      video.seeking = false; video.paused = true;
    },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  const api = new Function(...Object.keys(env), `let currentVideo = state.cv;
    let _musicAdvanceTimer = 0, _syncMode = false;
    ${handoff}\n${torrent}\n${gate}\n${seek}\n${copy}\n${resume}\n${play}
    return { swapPlaybackToGrowingCache, rollbackGrowingCache, updateGrowingCacheTick,
      swapPlaybackToDrive, completeCachePlayback, cachedSeedrFile, playbackResumeClock,
      growingSeekDecision, scheduleGrowingWaitNotice, cancelGrowingWaitNotice,
      blockDirectSeedrSeek, copyToGdrive, playFromSeedrItem, persistCurrentResume, closePlayer,
      _downloadMagnetToLaptop, mapTorrentCacheFiles,
      bindRecovery: () => { const v = $('#video'); ${recovery} },
      replace: cv => { currentVideo = cv; }, current: () => currentVideo };`)(...Object.values(env));
  function emit(name) {
    if (name === 'loadeddata') { v.readyState = 2; v.duration = 1000; }
    if (name === 'seeked') v.seeking = false;
    const e = { stopped: false, stopImmediatePropagation() { this.stopped = true; } };
    for (const fn of Array.from(listeners.get(name) || [])) { fn(e); if (e.stopped) break; }
    return e;
  }
  function run(ms) {
    for (const [id, t] of Array.from(timers)) if (t.ms === ms) { timers.delete(id); t.fn(); }
  }
  const fid = 'VPSCACHE::ep2.mkv';
  return { api, cv, item, v, calls, timers, listeners, entries, env, cache, emit, run, fid,
    start: (job = 'job2', id = fid) => api.swapPlaybackToGrowingCache(item, id, job, 'seedr2') };
}

Deno.test('handoff-playback: growing gate needs ~10 s behind and ~30 s ahead of the target and updates ETA', () => {
  const h = player(), decide = h.api.growingSeekDecision;
  // 1000 MiB over 1000 s = 1 MiB/s: margins are max(4 MiB, 10 s, 0.5%) and max(32 MiB, 30 s, 2%).
  equal(decide(500, 1000, 1000 * MiB, [[490 * MiB, 532 * MiB]], 0).allowed, true);
  equal(decide(500, 1000, 1000 * MiB, [[491 * MiB, 532 * MiB]], 0).allowed, false);
  equal(decide(500, 1000, 1000 * MiB, [[490 * MiB, 531 * MiB]], 0).allowed, false);
  // 5 MiB/s: 50 MiB behind, 150 MiB ahead.
  equal(decide(500, 1000, 5000 * MiB, [[2450 * MiB, 2650 * MiB]], 0).allowed, true);
  equal(decide(500, 1000, 5000 * MiB, [[2450 * MiB, 2649 * MiB]], 0).allowed, false);
  equal(decide(500, 1000, 1000 * MiB, [[0, 400 * MiB]], 50 * MiB).seconds, 3);
});

Deno.test('handoff-playback: failed active copy rolls back at current time and retry owns new ranges/source', async () => {
  const h = player();
  h.env.Seedr.walkFolder = () => Promise.resolve([{ fileId: 'seedr2', name: 'ep2.mkv', size: 1000 * MiB }]);
  h.env.Seedr.fetchFileUrl = () => Promise.resolve('https://seedr/ep2');
  const uploads = [];
  h.cache.uploadFromUrl = (args, tick) => { uploads.push({ args, tick }); return { cancel() {} }; };
  const copying = h.api.copyToGdrive(h.item);
  await flush();
  const tick = { status: 'uploading', jobId: uploads[0].args.id, fileId: h.fid,
    total: 1000 * MiB, progressiveReady: true, ranges: [[0, 400 * MiB]], bytesPerSec: 50 * MiB };
  uploads[0].tick(tick);
  h.emit('loadeddata'); h.emit('seeked'); h.emit('playing');
  await flush();
  h.v.currentTime = 180;
  uploads[0].tick({ status: 'error', error: 'disk read failed' });
  equal(h.cv.fileId, 'seedr2'); equal(h.cv._directSeedr, true);
  equal(h.cv._pendingResume, 180); equal(h.cv._growingRanges, []);
  equal(h.cv._growingJobId, null); equal(h.listeners.get('error').size, 0);
  await flush();
  equal(uploads.length, 2);
  const nextId = 'VPSCACHE::retry-ep2.mkv';
  uploads[1].tick({ ...tick, jobId: uploads[1].args.id, fileId: nextId });
  equal(h.cv.fileId, nextId); equal(h.cv._growingJobId, uploads[1].args.id);
  equal(h.cv._growingRanges, tick.ranges);
  h.emit('loadeddata'); h.emit('seeked'); h.emit('playing');
  uploads[1].tick({ ...tick, status: 'ready', jobId: uploads[1].args.id, fileId: nextId, ranges: [[0, tick.total]] });
  await copying;
  equal(h.cv._growingCache, false);
  equal(h.item.driveFiles[0].seedrFileId, 'seedr2');
});

Deno.test('handoff-playback: pending failure preserves paused restore and ignores a sibling failure', async () => {
  const h = player(true), p = h.start();
  equal(h.api.rollbackGrowingCache(h.item, 'seedr1', 'job2'), false);
  equal(h.api.rollbackGrowingCache(h.item, 'seedr2', 'other-job'), false);
  equal(h.api.rollbackGrowingCache(h.item, 'seedr2', 'job2'), true);
  equal(await p, false); equal(h.cv._pendingResume, 120); equal(h.v.paused, true);
  equal(h.calls.plays, 0); equal(h.cv._growingTotal, 0); equal(h.cv._growingBytesPerSec, 0);
});

Deno.test('handoff-playback: completed recovery waits for the playing episode then uses its counterpart', async () => {
  const h = player();
  h.item.driveFiles = [{ fileId: 'VPSCACHE::ep1.mkv', seedrFileId: 'seedr1' }];
  equal(await h.api.swapPlaybackToDrive(h.item), false);
  equal(h.calls.sources, []); equal(h.cv._localHandoffPending, undefined);
  h.item.driveFiles.push({ fileId: h.fid, seedrFileId: 'seedr2' });
  equal(await h.api.swapPlaybackToDrive(h.item), true);
  equal(h.cv.fileId, h.fid); equal(h.cv._pendingResume, 120);
  equal(h.calls.sources, ['/cache/stream/' + h.fid]);
});

Deno.test('handoff-playback: network and decode recovery callers never substitute an earlier cached sibling', async () => {
  for (const code of [2, 3, 4]) {
    const h = player();
    h.api.bindRecovery(); h.v.error = { code };
    h.item.driveFiles = [{ fileId: 'VPSCACHE::ep1.mkv', seedrFileId: 'seedr1' }];
    h.emit('error');
    equal(h.calls.sources, []); equal(h.cv.fileId, 'seedr2');
    h.item.driveFiles.push({ fileId: h.fid, seedrFileId: 'seedr2' });
    h.emit('error'); await flush();
    equal(h.calls.sources, ['/cache/stream/' + h.fid]);
    equal(h.cv._pendingResume, 120);
  }
});

Deno.test('handoff-playback: close keeps a local episode resume out of episode one', async () => {
  const h = player();
  h.item.driveFiles = [{ fileId: 'VPSCACHE::ep1.mkv', seedrFileId: 'seedr1' }, { fileId: h.fid, seedrFileId: 'seedr2' }];
  await h.api.swapPlaybackToDrive(h.item);
  h.calls.migrations.length = 0;
  h.api.closePlayer();
  equal(h.entries.get(h.fid).position, 120);
  equal(h.calls.migrations, []); equal(h.entries.has('VPSCACHE::ep1.mkv'), false);
});

Deno.test('handoff-playback: close fallback migrates only the exact Seedr file', () => {
  const h = player();
  h.item.driveFiles = [{ fileId: 'VPSCACHE::ep1.mkv', seedrFileId: 'seedr1' }, { fileId: h.fid, seedrFileId: 'seedr2' }];
  h.api.closePlayer();
  equal(h.calls.migrations, [['seedr2', h.fid]]);
  equal(h.entries.get(h.fid).position, 120); equal(h.entries.has('seedr2'), false);
});

Deno.test('handoff-playback: close during restore and while parked persists their clock', () => {
  const pending = player(true);
  pending.start();
  pending.api.closePlayer();
  equal(pending.entries.get(pending.fid).position, 120);
  equal(pending.entries.get(pending.fid).duration, 1000);
  const parked = player(true);
  parked.cv.source = 'laptop'; parked.cv.fileId = parked.fid;
  parked.cv._parked = { pos: 420, dur: 1000 };
  parked.v.currentTime = 0; parked.v.duration = NaN;
  parked.api.closePlayer();
  equal(parked.entries.get(parked.fid).position, 420);
  equal(parked.entries.get(parked.fid).duration, 1000);
});

Deno.test('handoff-playback: remux pending positions remain absolute when persisting', () => {
  const h = player();
  h.env.Remux.hasSession = () => true; h.env.Remux.duration = 1000;
  h.env.Remux.absolute = t => 300 + t;
  h.cv._pendingResume = 420; h.v.currentTime = 0;
  h.api.persistCurrentResume();
  equal(h.entries.get('seedr2').position, 420);
});

Deno.test('handoff-playback: close cancels handoff listeners/timer and cannot swallow the next title error', async () => {
  const h = player(true), p = h.start();
  h.api.closePlayer(); equal(await p, false);
  equal(h.listeners.get('error').size, 0);
  equal(Array.from(h.timers.values()).filter(t => t.ms === 15000).length, 0);
  h.api.replace({ src: 'https://next/title', fileId: 'next', source: 'seedr' });
  let errors = 0; h.v.addEventListener('error', () => errors++);
  h.emit('error'); h.run(15000);
  equal(errors, 1); equal(h.calls.sources.length, 1);
});

Deno.test('handoff-playback: stale capture listener checks ownership before stopping an error', async () => {
  const h = player(true), p = h.start();
  h.api.replace({ src: 'https://next/title', fileId: 'next', source: 'seedr' });
  let errors = 0; h.v.addEventListener('error', () => errors++);
  equal(h.emit('error').stopped, false); equal(errors, 1);
  equal(await p, false); equal(h.calls.sources.length, 1);
});

Deno.test('handoff-playback: long growing wait shows ETA without changing the source', () => {
  const h = player();
  h.cv._growingCache = true; h.cv._directSeedr = false;
  h.cv._growingTotal = 1000 * MiB; h.cv._growingRanges = [[0, 400 * MiB]];
  h.cv._growingBytesPerSec = 50 * MiB; h.cv._growingSeekTarget = 500;
  h.api.scheduleGrowingWaitNotice(h.v);
  equal(h.calls.toasts, []);
  h.run(2200);
  equal(h.calls.toasts, ['That part is still downloading — ready in ~3 s']);
  equal(h.calls.sources, []);
});

Deno.test('handoff-playback: wait notice rechecks fresh ranges and respects cancellation/player ownership', () => {
  const h = player();
  Object.assign(h.cv, { _growingCache: true, _directSeedr: false, _growingTotal: 1000 * MiB,
    _growingRanges: [], _growingBytesPerSec: MiB, _growingSeekTarget: 500 });
  h.api.scheduleGrowingWaitNotice(h.v);
  h.cv._growingRanges = [[0, 1000 * MiB]]; h.run(2200);
  equal(h.calls.toasts, []);
  h.cv._growingRanges = []; h.api.scheduleGrowingWaitNotice(h.v);
  h.api.cancelGrowingWaitNotice(h.cv); h.run(2200); equal(h.calls.toasts, []);
  h.api.scheduleGrowingWaitNotice(h.v); h.api.replace({}); h.run(2200);
  equal(h.calls.toasts, []);
});

Deno.test('handoff-playback: failed Seedr pack start autoplays the intended main cached file', async () => {
  const h = player(); h.api.replace(null); h.item.autoplay = true;
  const videos = [{ fileId: 'seedr1', name: 'ep1.mkv', size: 300 }, { fileId: 'seedr2', name: 'ep2.mkv', size: 200 }];
  h.env.Seedr.walkFolder = () => Promise.resolve(videos);
  h.env.Seedr.fetchFileUrl = id => Promise.resolve('https://seedr/' + id);
  await h.api.playFromSeedrItem(h.item, videos[1]);
  equal(h.item.autoplay, true); equal(h.item.mainSeedrFileId, 'seedr2');
  h.cache.uploadFromUrl = (args, tick) => {
    tick({ status: 'ready', fileId: args.filename === 'ep1.mkv' ? 'VPSCACHE::ep1.mkv' : h.fid, total: args.total });
    return { cancel() {} };
  };
  await h.api.copyToGdrive(h.item);
  equal(h.item.driveFiles.length, 2); equal(h.calls.opens, [h.fid]); equal(h.item.autoplay, false);
});

Deno.test('handoff-playback: phone pack completion takes over the playing episode', async () => {
  const h = player();
  h.env.Remux.engine = () => 'tv';
  Object.assign(h.env.PhoneCache, { reachable: () => Promise.resolve(true),
    streamUrl: id => '/phone/' + id, armProxy: () => Promise.resolve(),
    uploadFromUrl(args, tick) { tick({ status: 'ready', total: args.total, fileId: 'CACHE::' + args.filename }); return { cancel() {} }; },
  });
  h.env.Seedr.walkFolder = () => Promise.resolve([
    { fileId: 'seedr1', name: 'ep1.mkv', size: 100 }, { fileId: 'seedr2', name: 'ep2.mkv', size: 200 },
  ]);
  h.env.Seedr.fetchFileUrl = id => Promise.resolve('https://seedr/' + id);
  await h.api.copyToGdrive(h.item);
  equal(h.cv.fileId, 'CACHE::ep2.mkv'); equal(h.cv._pendingResume, 120);
  equal(h.cv.source, 'cache');
  equal(h.calls.sources, ['/phone/CACHE::ep2.mkv']);
});

Deno.test('handoff-playback: laptop terminal errors keep job/file identity and discard ranges', async () => {
  const src = await Deno.readTextFile(new URL('../tv-app/js/laptopcache.js', import.meta.url));
  // A dropped status request is retried (laptopcache-poll.test.js covers
  // the sustained-outage error); server-reported states fail at once.
  for (const status of [{ state: 'error', error: 'disk full' }, { state: 'aborted' }, { state: 'unknown' }]) {
    const ticks = [];
    const fetch = url => {
      if (url.includes('/cache/status') && status === null) return Promise.reject(new Error('network down'));
      return Promise.resolve({ ok: true, json: () => Promise.resolve(url.includes('/cache/status') ? status
        : { ok: true, state: 'started', rel: 'ep2.mkv' }) });
    };
    const cache = new Function('Storage', 'fetch', 'setTimeout', 'clearTimeout', `${src}; return LaptopCache;`)(
      { get: key => key === 'remux.laptopHost' ? 'laptop' : '' }, fetch, () => 1, () => {},
    );
    cache.uploadFromUrl({ id: 'job2', sourceUrl: 'https://seedr/ep2', filename: 'ep2.mkv' }, t => ticks.push(t));
    await flush();
    const error = ticks[ticks.length - 1];
    equal(error.status, 'error'); equal(error.jobId, 'job2'); equal(error.fileId, 'VPSCACHE::ep2.mkv');
    equal(error.ranges, []); equal(error.bytesPerSec, 0);
  }
  const ticks = [];
  const fetch = url => url.includes('/cache/status') ? Promise.reject(new Error('network down'))
    : Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, state: 'started', rel: 'ep2.mkv' }) });
  const cache = new Function('Storage', 'fetch', 'setTimeout', 'clearTimeout', `${src}; return LaptopCache;`)(
    { get: key => key === 'remux.laptopHost' ? 'laptop' : '' }, fetch, () => 1, () => {},
  );
  cache.uploadFromUrl({ id: 'job2', sourceUrl: 'https://seedr/ep2', filename: 'ep2.mkv' }, t => ticks.push(t));
  await flush();
  equal(ticks.filter(t => t.status === 'error').length, 0);
});

function prepareTorrent(h, seedrFiles, listing) {
  h.item.magnet = 'magnet:test';
  h.env.Seedr.walkFolder = () => Promise.resolve(seedrFiles);
  h.cache.listAll = () => Promise.resolve(listing);
  let tick;
  h.cache.addTorrent = (_args, cb) => { tick = cb; return { cancel() {} }; };
  return { ready: ids => tick({ status: 'ready', fileIds: ids, jobId: 'torrent-job' }) };
}

Deno.test('handoff-playback: single-video torrent fallback maps and replaces Seedr without cache metadata', async () => {
  const h = player();
  h.api.persistCurrentResume();
  const torrent = prepareTorrent(h, [{ fileId: 'seedr2', name: 'Movie.mkv', size: 100 }], []);
  const p = h.api._downloadMagnetToLaptop(h.item);
  torrent.ready([h.fid]);
  equal(await p, true); await flush();
  equal(h.item.driveFiles[0].seedrFileId, 'seedr2');
  equal(h.calls.probes, [h.fid]); equal(h.cv.fileId, h.fid);
  equal(h.cv._pendingResume, 120); equal(h.entries.get(h.fid).position, 120);
  equal(h.entries.has('seedr2'), false);
  equal(h.item.seedrVideos, [{ fileId: 'seedr2', name: 'Movie.mkv', size: 100 }]);
});

Deno.test('handoff-playback: torrent pack maps original names behind hashed rels and uses episode two', async () => {
  const h = player();
  const ids = ['VPSCACHE::aaa.mkv', 'VPSCACHE::zzz.mkv'];
  const seedr = [{ fileId: 'seedr1', name: 'Episode One.mkv', size: 200 },
    { fileId: 'seedr2', name: 'Episode Two.mkv', size: 100 }];
  const listing = [{ id: ids[1], name: 'Episode Two.mkv', size: 100 },
    { id: 'VPSCACHE::unrelated.mkv', name: 'Episode Two.mkv', size: 100 },
    { id: ids[0], name: 'Episode One.mkv', size: 200 }];
  const torrent = prepareTorrent(h, seedr, listing);
  const p = h.api._downloadMagnetToLaptop(h.item);
  torrent.ready(ids);
  equal(await p, true); await flush();
  equal(h.calls.probes, [ids[1]]); equal(h.cv.fileId, ids[1]);
  equal(h.cv._pendingResume, 120);
  equal(h.api.cachedSeedrFile(h.item, 'seedr1').fileId, ids[0]);
  equal(h.api.cachedSeedrFile(h.item, 'seedr2').fileId, ids[1]);
});

Deno.test('handoff-playback: torrent mapping enables later recovery and exact close-time resume migration', async () => {
  for (const close of [true, false]) {
    const h = player();
    const torrent = prepareTorrent(h, [{ fileId: 'seedr2', name: 'Movie.mkv', size: 100 }], []);
    h.cache.probePlayUrl = () => Promise.resolve({ ok: false });
    const p = h.api._downloadMagnetToLaptop(h.item);
    torrent.ready([h.fid]); await p; await flush();
    equal(h.cv.fileId, 'seedr2');
    if (close) {
      h.api.closePlayer(); equal(h.entries.get(h.fid).position, 120);
      equal(h.entries.has('seedr2'), false);
    } else {
      h.api.bindRecovery(); h.v.error = { code: 2 }; h.emit('error');
      equal(h.cv.fileId, h.fid); equal(h.cv._pendingResume, 120);
    }
  }
});

Deno.test('handoff-playback: partial, ambiguous, or conflicting torrent matches retain the playing Seedr file', async () => {
  const seedr = [{ fileId: 'seedr1', name: 'ep1.mkv', size: 100 },
    { fileId: 'seedr2', name: 'ep2.mkv', size: 100 }];
  const cases = [
    { seedr, listing: [{ id: 'VPSCACHE::only.mkv', name: 'ep1.mkv', size: 100 }] },
    { seedr, listing: [{ id: 'VPSCACHE::only.mkv', name: 'unmatched.mkv', size: 100 }] },
    { seedr: seedr.map(f => ({ ...f, name: 'episode.mkv' })),
      listing: [{ id: 'VPSCACHE::only.mkv', name: 'episode.mkv', size: 100 }] },
    { seedr: [seedr[1]], listing: [{ id: 'VPSCACHE::only.mkv', name: 'ep2.mkv', size: 200 }] },
  ];
  for (const c of cases) {
    const h = player();
    const torrent = prepareTorrent(h, c.seedr, c.listing);
    const p = h.api._downloadMagnetToLaptop(h.item);
    torrent.ready(['VPSCACHE::only.mkv']); await p; await flush();
    equal(h.cv.fileId, 'seedr2'); equal(h.calls.sources, []); equal(h.calls.probes, []);
    equal(h.calls.released, 0); equal(h.api.cachedSeedrFile(h.item, 'seedr2'), null);
  }
});

Deno.test('handoff-playback: two cache candidates for the same pack file cannot claim a Seedr identity', () => {
  const h = player();
  const ids = ['VPSCACHE::a.mkv', 'VPSCACHE::b.mkv'];
  const result = h.api.mapTorrentCacheFiles([{ fileId: 'seedr2', name: 'ep2.mkv', size: 100 }],
    ids, ids.map(id => ({ id, name: 'ep2.mkv', size: 100 })));
  equal(result.map(f => f.seedrFileId), [undefined, undefined]);
});

Deno.test('handoff-playback: resumed torrent fallback uses persisted manifest and autoplays the intended pack file', async () => {
  const h = player(); h.api.replace(null);
  h.item.autoplay = true; h.item.mainSeedrFileId = 'seedr2';
  h.item.seedrVideos = JSON.parse(JSON.stringify([
    { fileId: 'seedr1', name: 'ep1.mkv', size: 200 }, { fileId: 'seedr2', name: 'ep2.mkv', size: 100 },
  ]));
  const ids = ['VPSCACHE::a.mkv', 'VPSCACHE::b.mkv'];
  prepareTorrent(h, [], [{ id: ids[0], name: 'ep1.mkv', size: 200 }, { id: ids[1], name: 'ep2.mkv', size: 100 }]);
  h.env.Seedr.walkFolder = () => { throw new Error('persisted identities should be reused'); };
  h.item._torrentJobId = 'existing-job';
  h.cache.torrentStatus = () => Promise.resolve({ state: 'ready', rels: ids.map(id => id.slice(10)) });
  equal(await h.api._downloadMagnetToLaptop(h.item), true);
  equal(h.calls.opens, [ids[1]]); equal(h.item.autoplay, false);
});

Deno.test('handoff-playback: cancelling fallback during metadata lookup prevents a late handoff', async () => {
  const h = player();
  const torrent = prepareTorrent(h, [{ fileId: 'seedr2', name: 'Movie.mkv', size: 100 }], []);
  let finishList;
  h.cache.listAll = () => new Promise(resolve => { finishList = resolve; });
  const p = h.api._downloadMagnetToLaptop(h.item);
  torrent.ready([h.fid]);
  h.item._uploadHandle.cancel(); equal(await p, false);
  finishList([]); await flush();
  equal(h.calls.sources, []); equal(h.calls.migrations, []); equal(h.calls.probes, []);
});

Deno.test('handoff-playback: reattached ready torrent invalidates the cached listing before identity matching', async () => {
  const src = await Deno.readTextFile(new URL('../tv-app/js/laptopcache.js', import.meta.url));
  let listings = 0;
  const storage = new Map();
  const fetch = url => Promise.resolve({ ok: true, json: () => Promise.resolve(url.includes('/torrent/status')
    ? { state: 'ready', rels: ['new.mkv'] }
    : { files: ++listings === 1 ? [] : [{ rel: 'new.mkv', name: 'Movie.mkv', size: 100 }] }) });
  const cache = new Function('Storage', 'fetch', `${src}; return LaptopCache;`)(
    { get: key => key === 'remux.laptopHost' ? 'laptop' : storage.get(key), set: (key, value) => storage.set(key, value) }, fetch,
  );
  equal(await cache.listAll(), []); equal(await cache.listAll(), []); equal(listings, 1);
  await cache.torrentStatus('existing-job');
  const files = await cache.listAll();
  equal(listings, 2); equal(files[0].id, 'VPSCACHE::new.mkv'); equal(files[0].name, 'Movie.mkv');
});

Deno.test('handoff-playback: a flaky laptop health probe is retried before going cloud-only', async () => {
  const h = player();
  const answers = [false, false, true];
  h.cache.reachable = () => Promise.resolve(answers.length ? answers.shift() : true);
  h.env.Seedr.walkFolder = () => Promise.resolve([]);
  await h.api.copyToGdrive(h.item);
  equal(h.item._backend, 'laptop');
  equal(answers.length, 0);
});

Deno.test('handoff-playback: a cloud-only title streaming from Seedr keeps retrying the laptop copy', async () => {
  const h = player();
  h.cache.reachable = () => Promise.resolve(false);
  h.env.PhoneCache.reachable = () => Promise.resolve(false);
  h.env.Drive.available = () => false;
  h.item.phase = 'seedred';
  await h.api.copyToGdrive(h.item);
  equal(h.item.phase, 'cloud-ready');
  equal(Array.from(h.timers.values()).some(t => t.ms === 20000), true);
  h.run(20000);
  equal(h.calls.resumes, 1);
});
