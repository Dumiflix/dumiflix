function assert(value, message = 'assertion failed') {
  if (!value) throw new Error(message);
}
function assertEquals(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const appSource = await Deno.readTextFile(new URL('../tv-app/app.js', import.meta.url));
function section(start, end) {
  const a = appSource.indexOf(start);
  const b = appSource.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`missing app code: ${start}`);
  return appSource.slice(a, b);
}
const decisionSource = section('  function growingSeekDecision(', '  // Snappy directional seek indicator.');
const handoffSource = section('  function swapPlaybackToGrowingCache(', '  // Kick off (or resume) a Drive upload');
const copySource = section('  async function copyToGdrive(', '  function persistQueue()');
const resumeSource = section('  function resumeSeek(', '  function openPlayer(');
const MiB = 1024 * 1024;
const decide = new Function(`${decisionSource}; return growingSeekDecision;`)();

// Window: est - max(4 MiB, 10 s of media, 0.5%) .. est + max(32 MiB, 30 s of media, 2%).
Deno.test('growing seek requires the whole minimum safety window in one range', () => {
  const total = 1000 * MiB;
  assertEquals(decide(500, 1000, total, [[490 * MiB, 532 * MiB]], 0).allowed, true);
  assertEquals(decide(500, 1000, total, [[491 * MiB, 532 * MiB]], 0).allowed, false);
  assertEquals(decide(500, 1000, total, [[490 * MiB, 531 * MiB]], 0).allowed, false);
  assertEquals(decide(500, 1000, total, [[0, 510 * MiB], [511 * MiB, total]], 0).allowed, false);
  assertEquals(decide(900, 1000, total, [[0, 100 * MiB], [850 * MiB, total]], 0).allowed, true);
});

Deno.test('growing seek scales margins to file size and clamps both ends', () => {
  const total = 5000 * MiB;
  assertEquals(decide(500, 1000, total, [[2450 * MiB, 2800 * MiB]], 0).allowed, true);
  assertEquals(decide(500, 1000, total, [[2451 * MiB, 2800 * MiB]], 0).allowed, false);
  assertEquals(decide(0, 1000, total, [[0, 100 * MiB]], 0).allowed, false);
  assertEquals(decide(0, 1000, total, [[0, 300 * MiB]], 0).allowed, true);
  assertEquals(decide(1000, 1000, total, [[4950 * MiB, total]], 0).allowed, true);
  assertEquals(decide(0, 100, 4 * MiB, [[0, 4 * MiB]], 0).allowed, true);
});

Deno.test('growing seek estimates wait from the frontier and omits unknown rate/runtime', () => {
  assertEquals(decide(500, 1000, 1000 * MiB, [[0, 400 * MiB]], 50 * MiB), { allowed: false, seconds: 3 });
  assertEquals(decide(500, 1000, 1000 * MiB, [[0, 400 * MiB]], 0), { allowed: false, seconds: null });
  for (const duration of [0, Infinity, NaN]) {
    assertEquals(decide(5, duration, 1000 * MiB, [[0, 1000 * MiB]], MiB), { allowed: false, seconds: null });
  }
  assertEquals(decide(undefined, 1000, 1000 * MiB, [], MiB), { allowed: false, seconds: null });
});

function buildPlayer(paused = true) {
  const item = { id: 'q1', driveFiles: [], folderId: 'folder' };
  const state = { video: { _queueItem: item, _directSeedr: true, fileId: 'seedr1', src: 'https://seedr/video', source: 'seedr' } };
  const listeners = new Map();
  const timers = new Map();
  const calls = { sources: [], releases: 0, plays: 0, accelerated: [], seeks: [], toasts: [], sourceRefreshes: [] };
  let timerId = 0, now = 1000000;
  const v = {
    currentTime: 120, duration: 1000, paused, seeking: false, readyState: 4,
    src: state.video.src, currentSrc: state.video.src,
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    play() { this.paused = false; calls.plays++; return Promise.resolve(); },
    pause() { this.paused = true; },
    fastSeek(t) { calls.seeks.push(t); this.currentTime = t; this.seeking = true; },
  };
  const cache = {
    PFX: 'VPSCACHE::', growingStreamUrl: id => '/cache/growing/' + id.slice(10),
    streamUrl: id => '/cache/stream/' + id.slice(10),
    accelerate: id => { calls.accelerated.push(id); return Promise.resolve({ ok: true }); },
    armProxy: () => Promise.resolve(),
  };
  const env = {
    state, $: () => v, LaptopCache: cache, PhoneCache: {}, storeFor: () => cache,
    Storage: { migrateResume() {} }, Remux: { engine: () => 'laptop', hasSession: () => false, close() {}, bindVideo() {} },
    Seedr: {}, Drive: {}, persistQueue() {}, renderQueue() {}, loadingTick() {}, scheduleRenderQueue() {},
    toast() {}, currentTab: '', renderLibrary() {}, activeWatchers: {},
    Date: { now: () => now },
    window: { __nftRefreshSourceStatus() {
      calls.sourceRefreshes.push({ pending: state.video._localHandoffPending, seedr: state.video._directSeedr });
    } }, pToast: t => calls.toasts.push(t), _syncWatchdog() {},
    releaseSeedr: it => { if (!it._cacheCopiesPending) calls.releases++; },
    setVideoSource(video, src) {
      calls.sources.push(src);
      video.currentSrc = video.src = src;
      video.currentTime = 0; video.readyState = 0; video.seeking = false; video.paused = true;
    },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  const api = new Function(...Object.keys(env), `let currentVideo = state.video;
    ${decisionSource}\n${resumeSource}\n${handoffSource}\n${copySource}
    return { copyToGdrive, swapPlaybackToGrowingCache, updateGrowingCacheTick, completeCachePlayback,
      blockDirectSeedrSeek, resumeSeek, finalizeGrowingCache, rollbackGrowingCache, cancelGrowingHandoff,
      replaceVideo: cv => { currentVideo = cv; } };`)(...Object.values(env));
  function emit(name) {
    if (name === 'loadeddata' || name === 'canplay') v.readyState = 2;
    if (name === 'seeked') v.seeking = false;
    for (const fn of Array.from(listeners.get(name) || [])) fn({ stopImmediatePropagation() {} });
  }
  function runTimers(ms) {
    for (const [id, timer] of Array.from(timers)) {
      if (timer.ms === ms) { timers.delete(id); timer.fn(); }
    }
  }
  const fid = 'VPSCACHE::movie.mkv';
  return { api, env, cache, item, cv: state.video, v, calls, emit, runTimers, fid, timers, listeners,
    advance: ms => { now += ms; },
    publish: ranges => api.updateGrowingCacheTick(item,
      { jobId: 'job1', fileId: fid, total: 1000 * MiB, ranges }, 'seedr1'),
    start: () => api.swapPlaybackToGrowingCache(item, fid, 'job1', 'seedr1') };
}

Deno.test('paused growing handoff restores position and succeeds without playing', async () => {
  const h = buildPlayer();
  const promise = h.start();
  assert(h.cv._localHandoffPending);
  h.emit('loadeddata');
  assertEquals(h.calls.seeks, [120]);
  assert(h.cv._localHandoffPending, 'must wait for seek acknowledgement');
  h.emit('seeked');
  assertEquals(await promise, true);
  assertEquals(h.v.currentTime, 120);
  assertEquals(h.v.paused, true);
  assertEquals(h.calls.plays, 0);
  assertEquals(h.cv._localHandoffPending, false);
  assertEquals(h.cv._growingHandoffPromise, null);
  assertEquals(h.listeners.get('loadeddata').size, 0);
  h.runTimers(15000);
  assertEquals(h.calls.sources.length, 1);
  h.runTimers(900);
  assertEquals(h.calls.accelerated, ['job1']);
});

Deno.test('playing growing handoff still waits for playing before acceleration', async () => {
  const h = buildPlayer(false);
  const promise = h.start();
  h.emit('loadeddata'); h.emit('seeked');
  assert(h.cv._localHandoffPending);
  h.runTimers(900);
  assertEquals(h.calls.accelerated, []);
  h.emit('playing');
  assertEquals(await promise, true);
  h.runTimers(900);
  assertEquals(h.calls.accelerated, ['job1']);
});

Deno.test('growing failure stops after three attempts but completed playback still switches', async () => {
  const h = buildPlayer();
  for (let i = 0; i < 3; i++) {
    h.publish([[0, (300 + i * 50) * MiB]]);
    const p = h.start();
    h.emit('error');
    assertEquals(await p, false);
    assertEquals(h.cv._directSeedr, true);
    assertEquals(h.cv._localHandoffPending, false);
    assertEquals(h.cv._pendingResume, 120, 'rollback must retain the original position across retries');
    h.advance(60000 * (i + 1));
  }
  assertEquals(h.item._growingHandoffFailures, 3);
  const sourceCount = h.calls.sources.length;
  h.publish([[0, 600 * MiB], [999 * MiB, 1000 * MiB]]);
  assertEquals(await h.start(), false);
  assertEquals(h.calls.sources.length, sourceCount);
  h.item.driveFiles.push({ fileId: h.fid });
  await h.api.completeCachePlayback(h.item, h.fid, 'seedr1');
  assert(h.calls.sources.at(-1).startsWith('/cache/stream/'));
  assertEquals(h.cv._directSeedr, false);
  assertEquals(h.api.blockDirectSeedrSeek(900), false);
});

for (const { failures, elapsed } of [{ failures: 1, elapsed: 600000 }, { failures: 3, elapsed: 0 }]) {
  Deno.test(`another file on the same queue item can hand off after ${failures} failures and ${elapsed} ms`, async () => {
    const h = buildPlayer();
    for (let i = 0; i < failures; i++) {
      if (i) h.advance(60000 * i);
      h.publish([[0, (300 + i * 50) * MiB]]);
      const attempt = h.start();
      h.emit('error');
      assertEquals(await attempt, false);
    }
    h.advance(elapsed);
    const previousRetry = h.item._growingHandoffRetry;
    const next = { _queueItem: h.item, _directSeedr: true,
      fileId: 'seedr2', src: 'https://seedr/second', source: 'seedr' };
    h.api.replaceVideo(next);
    h.v.src = h.v.currentSrc = next.src;
    h.v.currentTime = 90; h.v.readyState = 4;
    const fid = 'VPSCACHE::second.mkv';
    h.api.updateGrowingCacheTick(h.item, { jobId: 'job2', fileId: fid, total: 1000 * MiB,
      ranges: [[0, 500 * MiB], [999 * MiB, 1000 * MiB]] }, 'seedr2');
    // A late tick for the old file must not reset its failure state.
    assertEquals(await h.start(), false);
    assertEquals(h.item._growingHandoffRetry, previousRetry);
    assertEquals(h.item._growingHandoffFailures, failures);
    const attempt = h.api.swapPlaybackToGrowingCache(h.item, fid, 'job2', 'seedr2');
    assert(next._localHandoffPending, 'the new file must get its own first attempt');
    assertEquals(h.item._growingHandoffRetry, null);
    assertEquals(h.item._growingHandoffFailures, 0);
    h.emit('loadeddata'); h.emit('seeked');
    assertEquals(await attempt, true);
    assertEquals(next.fileId, fid);
    assertEquals(h.v.currentTime, 90);
  });
}

Deno.test('growing handoff waits until the copy covers the playhead plus a margin', async () => {
  const h = buildPlayer();
  // Index present but the head is behind the playhead (120 s = 120 MiB here).
  h.publish([[0, 100 * MiB], [990 * MiB, 1000 * MiB]]);
  assertEquals(await h.start(), false);
  assertEquals(h.calls.sources.length, 0);
  assertEquals(h.item._growingHandoffFailures || 0, 0, 'a skipped swap is not a failure');
  assertEquals(!!h.cv._localHandoffPending, false);
  // Covers the playhead but not ~20 s beyond it.
  h.publish([[0, 130 * MiB], [990 * MiB, 1000 * MiB]]);
  assertEquals(await h.start(), false);
  h.publish([[0, 141 * MiB], [990 * MiB, 1000 * MiB]]);
  const swap = h.start();
  assertEquals(h.calls.sources.length, 1);
  h.emit('loadeddata'); h.emit('seeked');
  assertEquals(await swap, true);
});

Deno.test('failed growing handoff needs both backoff and meaningful progress before retrying', async () => {
  const h = buildPlayer();
  h.publish([[0, 300 * MiB]]);
  const first = h.start();
  // The failure snapshot must include progress made during the stalled seek.
  const ranges = [[0, 350 * MiB]];
  h.publish(ranges);
  h.emit('error');
  assertEquals(await first, false);
  assertEquals(h.item._growingHandoffFailures, 1);
  assertEquals(h.cv._localHandoffPending, false);
  assertEquals(h.cv._growingHandoffPromise, null);
  assertEquals(h.calls.sourceRefreshes.at(-1), { pending: false, seedr: true });
  const count = h.calls.sources.length;
  assertEquals(await h.start(), false);
  h.publish([[0, 400 * MiB]]);
  h.advance(59999);
  assertEquals(await h.start(), false, 'progress alone must not retry');
  h.advance(1);
  // Reordering, overlapping ranges, tiny growth and an unrelated island do
  // not improve the contiguous window past the playhead enough to retry.
  for (const unchanged of [ranges, [[200 * MiB, 350 * MiB], [0, 300 * MiB]],
    [[0, 351 * MiB]], [[0, 350 * MiB], [700 * MiB, 800 * MiB]]]) {
    h.publish(unchanged);
    assertEquals(await h.start(), false, 'elapsed backoff alone must not retry');
  }
  assertEquals(h.calls.sources.length, count);
  // The engine may reuse/mutate the original ranges array on later ticks.
  ranges[0][1] = 400 * MiB;
  h.publish(ranges);
  const second = h.start();
  assertEquals(h.calls.sources.length, count + 1);
  h.emit('error');
  assertEquals(await second, false);
  h.publish([[0, 450 * MiB]]);
  h.advance(60000);
  assertEquals(await h.start(), false, 'second failure requires 120 seconds');
  h.advance(60000);
  const third = h.start();
  assert(h.cv._localHandoffPending);
  h.emit('loadeddata'); h.emit('seeked');
  assertEquals(await third, true);
});

Deno.test('new published tail range permits retry after backoff without prefix growth', async () => {
  const h = buildPlayer();
  h.publish([[0, 300 * MiB]]);
  const first = h.start(); h.emit('error'); await first;
  h.advance(60000);
  h.publish([[0, 300 * MiB], [1000 * MiB - 64 * 1024, 1000 * MiB]]);
  const second = h.start();
  assert(h.cv._localHandoffPending);
  h.emit('loadeddata'); h.emit('seeked');
  assertEquals(await second, true);
});

Deno.test('growing retries judge useful progress at the current Seedr playhead', async () => {
  const h = buildPlayer();
  h.publish([[0, 300 * MiB]]);
  const first = h.start(); h.emit('error'); await first;
  h.advance(60000);
  h.cv._pendingResume = null;
  h.v.readyState = 4;
  h.v.currentTime = 200;
  h.publish([[0, 300 * MiB]]);
  assertEquals(await h.start(), false, 'clock movement is not copy progress');
  h.v.currentTime = 360;
  h.publish([[0, 350 * MiB]]);
  assertEquals(await h.start(), false, 'growth behind the playhead is not useful');
  h.publish([[0, 400 * MiB]]);
  const second = h.start();
  h.emit('loadeddata'); h.emit('seeked');
  assertEquals(await second, true);
  assertEquals(h.v.currentTime, 360);
});

Deno.test('completed cache bypasses active growing backoff without new range progress', async () => {
  const h = buildPlayer();
  h.publish([[0, 300 * MiB]]);
  const first = h.start(); h.emit('error'); await first;
  assertEquals(await h.start(), false);
  h.item.driveFiles.push({ fileId: h.fid });
  assertEquals(await h.api.completeCachePlayback(h.item, h.fid, 'seedr1'), true);
  assert(h.calls.sources.at(-1).startsWith('/cache/stream/'));
});

Deno.test('growing cancellation clears switching immediately and rollback refreshes Seedr status', async () => {
  const h = buildPlayer();
  const first = h.start();
  h.api.cancelGrowingHandoff(h.cv);
  assertEquals(h.cv._localHandoffPending, false);
  assertEquals(h.calls.sourceRefreshes.at(-1).pending, false);
  assertEquals(await first, false);
  assertEquals(h.api.rollbackGrowingCache(h.item, 'seedr1', 'job1'), true);
  assertEquals(h.calls.sourceRefreshes.at(-1), { pending: false, seedr: true });
  assertEquals(h.item._growingHandoffFailures, undefined);
});

Deno.test('terminal ready during pending growing failure falls back to completed stream', async () => {
  const h = buildPlayer();
  h.start();
  h.item.driveFiles.push({ fileId: h.fid });
  const ready = h.api.completeCachePlayback(h.item, h.fid, 'seedr1');
  assert(h.cv._growingFinalReady);
  h.runTimers(15000);
  await ready;
  assert(h.calls.sources.at(-1).startsWith('/cache/stream/'));
  assertEquals(h.cv._growingCache, false);
  assertEquals(h.cv._growingFinalReady, false);
  assertEquals(h.cv._growingJobId, null);
  assertEquals(h.api.blockDirectSeedrSeek(900), false);
  assertEquals(h.v.paused, true);
  assertEquals(h.cv._pendingResume, 120, 'completed fallback must restore the pre-handoff position');
});

Deno.test('terminal ready during successful paused growing handoff finalizes without a reload', async () => {
  const h = buildPlayer();
  h.start();
  h.item.driveFiles.push({ fileId: h.fid });
  const ready = h.api.completeCachePlayback(h.item, h.fid, 'seedr1');
  h.emit('canplay'); h.emit('seeked');
  await ready;
  assertEquals(h.calls.sources.length, 1);
  assertEquals(h.cv._growingCache, false);
  assertEquals(h.api.blockDirectSeedrSeek(900), false);
});

Deno.test('range ticks and completed fallback cannot affect another file/job/player', async () => {
  const h = buildPlayer();
  const tick = { jobId: 'job1', fileId: h.fid, ranges: [[0, 500 * MiB]], total: 1000 * MiB, bytesPerSec: 50 * MiB };
  h.api.updateGrowingCacheTick({}, tick, 'seedr1');
  assertEquals(h.cv._growingRanges, undefined);
  h.api.updateGrowingCacheTick(h.item, tick, 'other-seedr');
  assertEquals(h.cv._growingRanges, undefined);
  h.api.updateGrowingCacheTick(h.item, tick, 'seedr1');
  h.start();
  h.api.updateGrowingCacheTick(h.item, { ...tick, jobId: 'other', ranges: [[0, tick.total]] }, 'seedr1');
  assertEquals(h.cv._growingRanges, tick.ranges);
  const ready = h.api.completeCachePlayback(h.item, h.fid, 'seedr1');
  h.api.replaceVideo({ _queueItem: {} });
  h.runTimers(15000);
  await ready;
  assertEquals(h.calls.sources.length, 1);
});

Deno.test('user seeks stay locked on Seedr/pending, internal restores do not, downloaded growing targets unlock', async () => {
  const h = buildPlayer();
  const tick = { jobId: 'job1', fileId: h.fid, ranges: [[0, 500 * MiB]], total: 1000 * MiB, bytesPerSec: 50 * MiB };
  h.api.updateGrowingCacheTick(h.item, tick, 'seedr1');
  assertEquals(h.api.blockDirectSeedrSeek(100), true);
  // The one saved-position restore on Seedr stays allowed, as before.
  assertEquals(h.api.resumeSeek(h.v, 100), true);
  const p = h.start();
  assertEquals(h.api.blockDirectSeedrSeek(100), true);
  // Handoff restores (growing and completed-file swaps) must never be gated.
  assertEquals(h.api.resumeSeek(h.v, 100), true);
  h.emit('loadeddata'); h.emit('seeked');
  await p;
  assertEquals(h.api.blockDirectSeedrSeek(100), false);
  assertEquals(h.api.blockDirectSeedrSeek(900), true);
  assertEquals(h.api.resumeSeek(h.v, 900), false);
  assertEquals(h.api.resumeSeek(h.v, 100), true);
});

Deno.test('laptop cache status ticks forward ranges and speed, including terminal ready', async () => {
  const source = await Deno.readTextFile(new URL('../tv-app/js/laptopcache.js', import.meta.url));
  const statuses = [
    { state: 'downloading', total: 100, received: 60, progressiveReady: true, ranges: [[0, 60]], bytesPerSec: 20 },
    { state: 'ready', total: 100, received: 100, ranges: [[0, 100]], bytesPerSec: 0 },
  ];
  const ticks = [], timers = new Map();
  let timerId = 0;
  const fetch = url => Promise.resolve({ ok: true, json: () => Promise.resolve(url.includes('/cache/status')
    ? statuses.shift() : { ok: true, state: 'downloading', rel: 'movie.mkv' }) });
  const backend = new Function('Storage', 'fetch', 'setTimeout', 'clearTimeout', `${source}; return LaptopCache;`)(
    { get: key => key === 'remux.laptopHost' ? 'laptop' : '' }, fetch,
    (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, id => timers.delete(id),
  );
  backend.uploadFromUrl({ id: 'job1', sourceUrl: 'https://seedr/video', filename: 'movie.mkv', total: 100 }, tick => ticks.push(tick));
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assertEquals(ticks.find(t => t.status === 'uploading').ranges, [[0, 60]]);
  assertEquals(ticks.find(t => t.status === 'uploading').bytesPerSec, 20);
  for (const [id, timer] of Array.from(timers)) {
    if (timer.ms === 250) { timers.delete(id); await timer.fn(); }
  }
  assertEquals(ticks.at(-1).status, 'ready');
  assertEquals(ticks.at(-1).ranges, [[0, 100]]);
  assertEquals(ticks.at(-1).bytesPerSec, 0);
  assertEquals(Array.from(timers.values()).filter(t => t.ms === 250).length, 0);
});

Deno.test('copy callback starts video first and hands off on ready before subtitle persistence', async () => {
  const h = buildPlayer();
  const order = [], uploads = [];
  h.item.folderId = 'folder'; h.item.name = 'Movie';
  h.cache.reachable = () => Promise.resolve(true);
  h.env.Seedr.walkFolder = () => Promise.resolve([
    { fileId: 'sub1', name: 'Movie.en.srt', size: 12 },
    { fileId: 'seedr1', name: 'Movie.mkv', size: 1000 * MiB },
  ]);
  h.env.Seedr.fetchFileUrl = id => { order.push('url:' + id); return Promise.resolve('https://seedr/' + id); };
  h.cache.uploadFromUrl = (args, tick) => { order.push('copy:' + args.filename); uploads.push({ args, tick }); return { cancel() {} }; };
  const copying = h.api.copyToGdrive(h.item);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assertEquals(order, ['url:seedr1', 'copy:Movie.mkv']);
  const tick = { status: 'uploading', fileId: h.fid, jobId: 'job1', total: 1000 * MiB,
    ranges: [[0, 300 * MiB]], bytesPerSec: 50 * MiB, progressiveReady: true };
  uploads[0].tick(tick);
  assert(h.cv._growingCache);
  assertEquals(h.cv._growingRanges, tick.ranges);
  uploads[0].tick({ ...tick, status: 'ready', ranges: [[0, tick.total]], received: tick.total });
  // No further video ticks will arrive. Its handoff fails while the subtitle
  // copy is still outstanding, and must recover to /cache/stream immediately.
  h.emit('error');
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert(h.calls.sources.at(-1).startsWith('/cache/stream/'));
  assertEquals(h.calls.releases, 0, 'Seedr subtitle siblings must remain available');
  assertEquals(order, ['url:seedr1', 'copy:Movie.mkv', 'url:sub1', 'copy:Movie.en.srt']);
  uploads[1].tick({ status: 'ready', fileId: 'VPSCACHE::Movie.en.srt' });
  await copying;
  assertEquals(h.item.driveSubtitles, [{ fileId: 'VPSCACHE::Movie.en.srt', name: 'Movie.en.srt' }]);
  assertEquals(h.item._cacheCopiesPending, false);
  assertEquals(h.calls.releases, 1);
  assertEquals(h.item.phase, 'drive-ready');
});

Deno.test('progressive copy ticks respect growing backoff and still switch on terminal ready', async () => {
  const h = buildPlayer();
  h.item.name = 'Movie';
  h.cache.reachable = () => Promise.resolve(true);
  h.env.Seedr.walkFolder = () => Promise.resolve([{ fileId: 'seedr1', name: 'Movie.mkv', size: 1000 * MiB }]);
  h.env.Seedr.fetchFileUrl = () => Promise.resolve('https://seedr/video');
  let onTick;
  h.cache.uploadFromUrl = (_, tick) => { onTick = tick; return { cancel() {} }; };
  const copying = h.api.copyToGdrive(h.item);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const tick = { status: 'uploading', fileId: h.fid, jobId: 'job1', total: 1000 * MiB,
    ranges: [[0, 300 * MiB]], progressiveReady: true };
  onTick(tick);
  assert(h.cv._localHandoffPending);
  h.emit('error');
  const count = h.calls.sources.length;
  onTick({ ...tick, ranges: [[0, 350 * MiB]] });
  assertEquals(h.calls.sources.length, count);
  h.advance(60000);
  onTick(tick);
  assertEquals(h.calls.sources.length, count);
  onTick({ ...tick, ranges: [[0, 350 * MiB]] });
  assertEquals(h.calls.sources.length, count + 1);
  h.emit('error');
  // No time/progress wait is required for the finished file.
  onTick({ ...tick, status: 'ready', received: tick.total, ranges: [[0, tick.total]] });
  await copying;
  assert(h.calls.sources.at(-1).startsWith('/cache/stream/'));
  assertEquals(h.cv._directSeedr, false);
  assertEquals(h.item._growingHandoffFailures, 2);
});

Deno.test('ready before any progressive tick goes directly to the completed stream', async () => {
  const h = buildPlayer();
  h.item.name = 'Movie';
  h.cache.reachable = () => Promise.resolve(true);
  h.env.Seedr.walkFolder = () => Promise.resolve([{ fileId: 'seedr1', name: 'Movie.mkv', size: 100 }]);
  h.env.Seedr.fetchFileUrl = () => Promise.resolve('https://seedr/video');
  h.cache.uploadFromUrl = (_, tick) => {
    tick({ status: 'ready', progressiveReady: true, fileId: h.fid, jobId: 'job1', total: 100, ranges: [[0, 100]], bytesPerSec: 0 });
    return { cancel() {} };
  };
  await h.api.copyToGdrive(h.item);
  assertEquals(h.calls.sources.length, 1);
  assert(h.calls.sources[0].startsWith('/cache/stream/'));
  assertEquals(h.cv._directSeedr, false);
  assertEquals(h.cv._localHandoffPending, false);
});

Deno.test('completion for a sibling video cannot replace the currently playing file', async () => {
  const h = buildPlayer();
  h.item.driveFiles.push({ fileId: h.fid });
  assertEquals(await h.api.completeCachePlayback(h.item, h.fid, 'sibling'), false);
  assertEquals(h.calls.sources.length, 0);
});
