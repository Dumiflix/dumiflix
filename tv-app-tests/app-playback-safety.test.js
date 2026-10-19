// Execute the production functions with controlled media events/network replies.
// No TV, laptop, broker, or real timers are touched by these regressions.
const source = await Deno.readTextFile(new URL('../tv-app/app.js', import.meta.url));
function assert(value, message = 'assertion failed') { if (!value) throw new Error(message); }
function equal(actual, expected, message = '') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function section(start, end, from = 0) {
  const a = source.indexOf(start, from), b = source.indexOf(end, a);
  assert(a >= 0 && b >= 0, 'missing section ' + start);
  return source.slice(a, b);
}
function compile(env, code, result) {
  return new Function('env', `with (env) { ${code}\nreturn ${result}; }`)(env);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function timers() {
  const pending = new Map(); let next = 0;
  return {
    pending,
    setTimeout(fn, ms) { const id = ++next; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    run(ms) {
      const match = [...pending].find(([, t]) => t.ms === ms);
      assert(match, 'missing timer ' + ms);
      pending.delete(match[0]); return match[1].fn();
    },
  };
}
function media() {
  const listeners = new Map();
  const v = {
    currentSrc: 'https://seedr/old', currentTime: 120, duration: 2000,
    paused: false, ended: false, readyState: 2, muted: false, seeking: false,
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    play() { v.paused = false; return Promise.resolve(); },
    pause() { v.paused = true; },
    emit(name) { for (const fn of [...(listeners.get(name) || [])]) fn(); },
  };
  return { v, listeners };
}
const setter = section('  function setVideoSource(', '  // Keep NativePlayer');
const recovery = section("    v.addEventListener('error', () => {", "    v.addEventListener('waiting', () => {");

function recoveryHarness() {
  const { v } = media(), clock = timers();
  v.error = { code: 2 };
  const cv = { source: 'seedr', src: v.currentSrc, fileId: 's1', _sourceGen: 1, _directSeedr: true };
  const calls = { loads: [], remux: 0, closes: 0 };
  const env = {
    ...clock, v, currentVideo: cv, $: () => ({ classList: { contains: () => true } }),
    NativePlayer: { load(video, url) { calls.loads.push(url); video.currentSrc = url; } },
    Remux: { hasSession: () => false, close() { calls.closes++; }, bindVideo() {} },
    Seedr: { fetchFileUrl: () => Promise.resolve('https://seedr/fresh') },
    _maybeRemux: async url => { calls.remux++; return { url, sess: null }; },
    cachedPlaybackFile: () => null, pToast() {}, setBuffering() {}, _syncWatchdog() {},
  };
  const api = compile(env, setter + recovery, '{ setVideoSource }');
  return { env, cv, v, calls, api, clock };
}
for (const boundary of ['timer', 'URL', 'remux']) {
  Deno.test(`app-playback-safety: stale Seedr recovery cannot overwrite a handoff at ${boundary}`, async () => {
    const h = recoveryHarness(), pending = deferred();
    if (boundary === 'URL') h.env.Seedr.fetchFileUrl = () => pending.promise;
    if (boundary === 'remux') h.env._maybeRemux = () => { h.calls.remux++; return pending.promise; };
    h.v.emit('error');
    if (boundary !== 'timer') { h.clock.run(600); await flush(); }
    h.cv.source = 'laptop'; h.cv.fileId = 'local'; h.cv._directSeedr = false;
    h.api.setVideoSource(h.v, '/cache/local');
    if (boundary === 'timer') h.clock.run(600);
    else pending.resolve(boundary === 'URL' ? 'https://seedr/late' : { url: 'https://seedr/late', sess: null });
    await flush();
    equal(h.calls.loads, ['/cache/local']); equal(h.cv.src, 'https://seedr/old');
    equal(h.calls.closes, boundary === 'remux' ? 1 : 0);
  });
}
Deno.test('app-playback-safety: recovery also rejects a newer source generation on the same Seedr object', async () => {
  const h = recoveryHarness(), pending = deferred();
  h.env.Seedr.fetchFileUrl = () => pending.promise;
  h.v.emit('error'); h.clock.run(600);
  h.api.setVideoSource(h.v, 'https://seedr/new-generation');
  pending.resolve('https://seedr/stale'); await flush();
  equal(h.calls.loads, ['https://seedr/new-generation']); equal(h.calls.remux, 0);
});
Deno.test('app-playback-safety: an owned queue retry remains direct and restores its position', async () => {
  const h = recoveryHarness(); h.cv._queueItem = {};
  h.v.emit('error'); h.clock.run(600); await flush();
  equal(h.calls.loads, ['https://seedr/fresh']); equal(h.calls.remux, 0);
  equal(h.cv._pendingResume, 120);
});

const playFile = section('  async function playFile(', '  async function playFromLibrary(');
const cacheHit = section('  async function _playSeedrCacheHit(', '  // Open the player against');
const queuedPlay = section('  async function playFromSeedrItem(', '  // Always-delete cleanup.');
function openingHarness() {
  const calls = { opens: [], hidden: 0, toasts: [] };
  const env = {
    _openReqSeq: 0, currentVideo: null, queue: [], persistQueue() {},
    _seedrSiblingSubtitle: () => Promise.resolve(null),
    showLoading() {}, startRemuxLoadProgress() {}, pill() {},
    hideLoading() { calls.hidden++; }, toast(t) { calls.toasts.push(t); },
    Storage: { getResume: () => null },
    Remux: { resolveCache: () => Promise.resolve(null), cacheStreamUrl: rel => '/cache/' + rel, engine: () => 'laptop' },
    Seedr: { fetchFileUrl: () => Promise.resolve('https://seedr/file') },
    resolveSubtitleWithFallback: () => Promise.resolve(null),
    _probeSeedrStream: () => Promise.resolve(true),
    _maybeRemux: url => Promise.resolve({ url, sess: null }),
    openPlayer(url, title, meta) { calls.opens.push([url, title]); env._openReqSeq++; env.currentVideo = { title, ...meta }; },
  };
  return { env, calls, api: compile(env, cacheHit + playFile + queuedPlay, '{ playFile, _playSeedrCacheHit, playFromSeedrItem }') };
}
for (const boundary of ['subtitles', 'cache lookup', 'URL', 'probe', 'remux', 'cache opener']) {
  Deno.test(`app-playback-safety: Back cancels playFile during ${boundary}`, async () => {
    const h = openingHarness(), pending = deferred();
    if (boundary === 'subtitles') h.env.resolveSubtitleWithFallback = () => pending.promise;
    if (boundary === 'cache lookup') h.env.Remux.resolveCache = () => pending.promise;
    if (boundary === 'URL') h.env.Seedr.fetchFileUrl = () => pending.promise;
    if (boundary === 'probe') h.env._probeSeedrStream = () => pending.promise;
    if (boundary === 'remux' || boundary === 'cache opener') h.env._maybeRemux = () => pending.promise;
    if (boundary === 'cache opener') h.env.Remux.resolveCache = () => Promise.resolve({ rel: 'movie' });
    const playing = h.api.playFile('s1', 'Old'); await flush();
    h.env._openReqSeq++;
    pending.resolve(boundary === 'URL' ? 'https://seedr/late'
      : boundary === 'probe' ? true : boundary.includes('remux') || boundary === 'cache opener'
      ? { url: '/late', sess: null } : null);
    await playing;
    equal(h.calls.opens, []); equal(h.calls.toasts, []); equal(h.calls.hidden, 0);
  });
}
Deno.test('app-playback-safety: only the latest title opens when requests resolve out of order', async () => {
  const h = openingHarness(), first = deferred();
  h.env.Seedr.fetchFileUrl = id => id === 'old' ? first.promise : Promise.resolve('/new');
  const old = h.api.playFile('old', 'Old'); await flush();
  await h.api.playFile('new', 'New'); first.resolve('/old'); await old;
  equal(h.calls.opens, [['/new', 'New']]);
});
Deno.test('app-playback-safety: a closed current player invalidates a pending opener even before another open', async () => {
  const h = openingHarness(), pending = deferred();
  h.env.currentVideo = { title: 'Current' };
  h.env._probeSeedrStream = () => pending.promise;
  const playing = h.api.playFile('next', 'Next'); await flush();
  h.env.currentVideo = null; pending.resolve(true); await playing;
  equal(h.calls.opens, []);
});
Deno.test('app-playback-safety: cache opener reports no open after a cancelled rejected await', async () => {
  const h = openingHarness(), pending = deferred();
  h.env._maybeRemux = () => pending.promise;
  const opening = h.api._playSeedrCacheHit({ rel: 'movie' }, 's1', 'Old');
  h.env._openReqSeq++; pending.reject(new Error('cancelled'));
  equal(await opening, false); equal(h.calls.opens, []);
});
Deno.test('app-playback-safety: normal Seedr and cache-hit opens retain subtitle/file metadata', async () => {
  for (const hit of [null, { rel: 'movie' }]) {
    const h = openingHarness(); h.env.Remux.resolveCache = () => Promise.resolve(hit);
    await h.api.playFile('s1', 'Title');
    equal(h.calls.opens, [[hit ? '/cache/movie' : 'https://seedr/file', 'Title']]);
  }
});

const recycle = section('    const RC_SOFT =', '    // NativePlayer\'s rising-buffer watchdog');
function recycleHarness(paused = true) {
  const { v } = media(), clock = timers(); v.paused = paused;
  let now = 0, pauses = 0;
  v.pause = () => { pauses++; v.paused = true; };
  const env = {
    ...clock, v, currentVideo: { title: 'Old' }, window: {}, performance: { now: () => now },
    NativePlayer: { release() {} }, blockDirectSeedrSeek: () => false, setBuffering() {},
    setVideoSource(video, src) { video.currentSrc = src; }, resumeSeek() {},
  };
  const api = compile(env, recycle, '{ _rcFlush, _rcTrack, played: () => _rcPlayed, busy: () => _rcBusy }');
  return { env, api, clock, v, tick(ms) { now += ms; }, pauses: () => pauses };
}
for (const boundary of ['play', 'repaint']) {
  Deno.test(`app-playback-safety: paused recycle cannot pause/unmute a new title after ${boundary}`, async () => {
    const h = recycleHarness(), pending = deferred();
    if (boundary === 'play') h.v.play = () => pending.promise;
    const recycling = h.api._rcFlush('pause'); h.clock.run(80); await flush();
    if (boundary === 'repaint') assert([...h.clock.pending.values()].some(t => t.ms === 140));
    h.env.currentVideo = { title: 'New' }; h.v.muted = true; h.v.paused = false;
    if (boundary === 'play') pending.resolve(); else h.clock.run(140);
    await recycling;
    equal(h.pauses(), 0); equal(h.v.paused, false); equal(h.v.muted, true); equal(h.api.busy(), false);
  });
}
Deno.test('app-playback-safety: recycle accumulates sparse playback updates but excludes seeks, pauses and stalls', () => {
  const h = recycleHarness(false);
  h.v.emit('playing');
  for (let i = 0; i < 1200; i++) { h.tick(3000); h.v.currentTime += 3; h.api._rcTrack(); }
  equal(h.api.played(), 3600, 'one hour of 3-second timeupdates must count');
  h.v.emit('seeking'); h.tick(30000); h.v.currentTime += 900; h.api._rcTrack();
  equal(h.api.played(), 3600, 'seek time and distance do not count');
  h.v.emit('seeked'); h.tick(3000); h.api._rcTrack(); equal(h.api.played(), 3603);
  h.v.paused = true; h.v.emit('pause'); h.tick(600000); h.api._rcTrack(); equal(h.api.played(), 3603);
  h.v.paused = false; h.v.emit('playing'); h.tick(3000); h.v.emit('waiting');
  h.tick(60000); h.api._rcTrack(); equal(h.api.played(), 3606);
  h.v.emit('playing'); h.tick(3000); h.api._rcTrack(); equal(h.api.played(), 3609);
  h.v.emit('loadedmetadata'); equal(h.api.played(), 0);
});

const torrent = section('  function _downloadMagnetToLaptop(', '  // Switch a DIRECT');
const remove = section('  async function removeFromQueue(', '  // ---- Removed blocklist');
function fallbackHarness() {
  const item = { id: 'q', name: 'Title', magnet: 'magnet:x', autoplay: true, seedrVideos: [{ fileId: 's1', name: 'movie.mkv' }] };
  let tick; const calls = { cancelled: 0, opens: [], lists: 0 };
  const env = {
    queue: [item], currentVideo: null, currentTab: 'home', activeWatchers: {},
    persistQueue() {}, renderQueue() {}, loadingTick() {}, scheduleRenderQueue() {}, toast() {}, purgeTitle() {},
    Seedr: { isLoggedIn: () => false },
    LaptopCache: {
      addTorrent(args, cb) { tick = cb; return { cancel() { calls.cancelled++; } }; },
      listAll() { calls.lists++; return Promise.resolve([]); },
    },
    mapTorrentCacheFiles: () => [{ fileId: 'local', seedrFileId: 's1' }],
    cachedPlaybackFile: () => null, cachedSeedrFile: () => ({ fileId: 'local' }),
    Storage: { migrateResume() {} }, playDriveFile: id => calls.opens.push(id), releaseSeedr() {},
  };
  const api = compile(env, torrent + remove, '{ _downloadMagnetToLaptop, removeFromQueue }');
  return { env, item, calls, api, emit: value => tick(value) };
}
for (const boundary of ['download', 'listing']) {
  Deno.test(`app-playback-safety: removal cancels laptop fallback during ${boundary} and rejects late ready`, async () => {
    const h = fallbackHarness(), pending = deferred();
    if (boundary === 'listing') h.env.LaptopCache.listAll = () => pending.promise;
    const download = h.api._downloadMagnetToLaptop(h.item);
    if (boundary === 'listing') { h.emit({ status: 'ready', fileIds: ['local.mkv'] }); await flush(); }
    await h.api.removeFromQueue(h.item);
    h.emit({ status: 'ready', fileIds: ['local.mkv'] }); pending.resolve([]);
    equal(await download, false); await flush();
    equal(h.calls.cancelled, 1); equal(h.calls.opens, []); equal(h.env.queue.length, 0);
    equal(h.item.autoplay, false); equal(h.item.phase, 'copying');
  });
}
Deno.test('app-playback-safety: fallback ignores ready for an item removed by another queue operation', async () => {
  const h = fallbackHarness(), download = h.api._downloadMagnetToLaptop(h.item);
  h.env.queue.length = 0; h.emit({ status: 'ready', fileIds: ['movie.mkv'] });
  equal(await download, false); equal(h.calls.opens, []); equal(h.calls.cancelled, 1);
});

const copy = section('  async function copyToGdrive(', '  function persistQueue()');
function copyHarness(outcomes) {
  const calls = { uploads: 0, mints: 0, urls: [], fallback: 0, waits: [], waited: 0, stages: [] };
  const item = { id: 'q', folderId: 1, magnet: 'magnet:x', name: 'Title', mainSeedrFileId: 's1' };
  const laptop = {
    reachable: () => Promise.resolve(true),
    uploadFromUrl(args, tick) {
      calls.urls.push(args.sourceUrl);
      const outcome = typeof outcomes === 'function' ? outcomes(calls) : outcomes[calls.uploads];
      calls.uploads++;
      Promise.resolve().then(() => tick(outcome === 'ready'
        ? { status: 'ready', fileId: 'local', total: 100 } : { status: 'error', error: outcome }));
      return { cancel() {} };
    },
  };
  const env = {
    LaptopCache: laptop, Remux: { engine: () => 'laptop' },
    Seedr: { walkFolder: () => Promise.resolve([{ fileId: 's1', name: 'movie.mkv', size: 100 }]), fetchFileUrl: () => Promise.resolve('/seedr/' + (++calls.mints)) },
    persistQueue() {}, renderQueue() {}, scheduleRenderQueue() {}, toast() {},
    currentTab: 'home', currentVideo: null, activeWatchers: {},
    loadingTick(it) { calls.stages.push(it.uploadStage); },
    sleep: ms => { calls.waits.push(ms); calls.waited += ms; return Promise.resolve(); },
    rollbackGrowingCache() {}, updateGrowingCacheTick() {}, completeCachePlayback: () => Promise.resolve(),
    Storage: { migrateResume() {} }, releaseSeedr() {}, cachedPlaybackFile: () => null,
    cachedSeedrFile: () => null,
    _downloadMagnetToLaptop: () => { calls.fallback++; return Promise.resolve(false); },
  };
  return { calls, item, env, copy: compile(env, copy, 'copyToGdrive') };
}
Deno.test('app-playback-safety: repeated cache busy responses preserve all three source attempts', async () => {
  const h = copyHarness(['busy', 'cache busy', 'busy', 'busy', 'HTTP 403', 'HTTP 500', 'ready']);
  await h.copy(h.item);
  equal(h.calls.uploads, 7); equal(h.calls.mints, 3); equal(h.calls.fallback, 0); equal(h.item.phase, 'drive-ready');
  equal(h.calls.urls.slice(0, 5), Array(5).fill('/seedr/1'));
  equal(h.calls.waits.slice(0, 4), [4000, 8000, 16000, 32000]);
  equal(h.calls.stages.filter(s => s === 'waiting for cache capacity').length, 4);
});
Deno.test('app-playback-safety: three real source failures still trigger the existing magnet fallback', async () => {
  const h = copyHarness(['busy', 'busy', 'HTTP 403', 'HTTP 404', 'HTTP 500']);
  await h.copy(h.item); equal(h.calls.uploads, 5); equal(h.calls.fallback, 1);
});

Deno.test('app-playback-safety: laptop timeouts alone never send a Seedr title to the torrent fallback', async () => {
  const h = copyHarness(['The operation was aborted.', 'Failed to fetch', 'HTTP 500']);
  await h.copy(h.item); equal(h.calls.uploads, 3); equal(h.calls.fallback, 0); equal(h.item.phase, 'error');
});
const release = section('  async function releaseSeedr(', '  // Seedr can finish');
Deno.test('app-playback-safety: failed folder releases retry with bounded backoff and free quota on success', async () => {
  const clock = timers(), calls = { deletes: 0, promotes: 0 }, item = { folderId: 42 };
  const env = {
    ...clock, currentVideo: null,
    Seedr: { async deleteItems() { if (++calls.deletes <= 7) throw new Error('offline'); } },
    persistQueue() {}, promoteNextPending() { calls.promotes++; },
  };
  const releaseSeedr = compile(env, release, 'releaseSeedr');
  await releaseSeedr(item);
  for (const delay of [2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    equal(item.folderId, 42); clock.run(delay); await flush();
  }
  equal(item.folderId, null); equal(calls.deletes, 8); equal(calls.promotes, 1); equal(clock.pending.size, 0);
});
Deno.test('app-playback-safety: release retries defer to active Seedr playback and pending sibling copies', async () => {
  const item = { folderId: 42 }, calls = [];
  const env = { currentVideo: { _queueItem: item, _directSeedr: true }, Seedr: { deleteItems: async () => calls.push(42) }, persistQueue() {}, promoteNextPending() {} };
  const releaseSeedr = compile(env, release, 'releaseSeedr');
  await releaseSeedr(item); equal(calls, []); equal(item._deferSeedrRelease, true);
  env.currentVideo = null; item._cacheCopiesPending = true;
  await releaseSeedr(item); equal(calls, []);
  item._cacheCopiesPending = false; await releaseSeedr(item); equal(calls, [42]);
});
Deno.test('app-playback-safety: boot sweeps completed folders without restarting their copy loops', () => {
  const sweep = source.match(/queue\.filter\(it => it\.folderId && it\.phase === 'drive-ready'\)\.forEach\(releaseSeedr\);/);
  assert(sweep); const calls = [];
  compile({ queue: [{ folderId: 1, phase: 'drive-ready' }, { folderId: 2, phase: 'copying' }, { phase: 'drive-ready' }], releaseSeedr: it => calls.push(it.folderId) }, sweep[0], 'null');
  equal(calls, [1]);
});

const unobserve = section('  function unobserveTilePosters(', '  function makeTile(');
Deno.test('app-playback-safety: replacing search rows explicitly releases offscreen poster observations first', async () => {
  const poster = { style: { backgroundImage: 'url(poster)' } }, observed = new Set([poster]);
  const results = {
    querySelectorAll: () => [poster],
    set innerHTML(value) { equal(observed.size, 0, 'must unobserve before detaching'); equal(value, ''); },
  };
  const env = {
    _tileObserver: { unobserve: el => observed.delete(el) },
    $: s => s === '#search-input' ? { value: 'movie' } : results,
    hideSuggest() {}, pushSearchHistory() {}, pill() {}, _searchType: 'movies',
    runSearchMovies: () => Promise.resolve(0), setTimeout() {},
  };
  await compile(env, unobserve + section('  async function runSearch()', '  // ---------- Search typeahead'), 'runSearch')();
  equal(poster.style.backgroundImage, '');
  for (const container of ['rows', 'weekRow', 'dayRow', 'list']) {
    assert(source.includes(`unobserveTilePosters(${container});`), container + ' replacement must release poster descendants');
  }
});

const international = section('  let _intlAll =', '  // ---------- Library (Drive first');
Deno.test('app-playback-safety: leaving International frees every owner and rejects an in-flight render', async () => {
  const pending = deferred(), nodes = {}, calls = { released: 0 };
  const env = {
    $: id => nodes[id] || (nodes[id] = { innerHTML: 'channels', style: {}, textContent: '' }),
    IPTV: { fetchAll: () => pending.promise, releaseCache() { calls.released++; } },
  };
  const api = compile(env, international, `{
    renderInternational, releaseInternational,
    seed: () => { _intlAll = [{ name: 'channel' }]; _intlPage = 4; _intlRenderState.count = 240; },
    state: () => [_intlAll, _intlPage, _intlRenderState.count]
  }`);
  api.seed(); api.releaseInternational();
  equal(api.state(), [null, 1, 0]);
  const rendering = api.renderInternational(); api.releaseInternational();
  pending.resolve([{ name: 'late channel' }]); await rendering;
  equal(api.state(), [null, 1, 0]); equal(calls.released, 2);
  for (const id of ['#intl-grid', '#intl-countries', '#intl-cats']) equal(nodes[id].innerHTML, '');
  assert(source.includes("name !== 'live' && liveSource === 'intl') releaseInternational();"));
  assert(source.includes('if (leavingIntl) releaseInternational();'));
});

const remoteStart = source.indexOf('  const DumiRemote =');
const poll = section('    async function pollOnce()', '    async function pollLoop()', remoteStart);
function pollHarness() {
  const clock = timers(), calls = { urls: [], commands: [] };
  const env = {
    ...clock, lastCmdId: 0, primed: false, base: () => 'http://broker', AbortController,
    sleep: () => Promise.resolve(), markBrokerUnsupported: () => false,
    fetch: async url => { calls.urls.push(url); return { ok: true, json: async () => ({ maxId: 0, commands: [] }) }; },
    handle: async cmd => calls.commands.push(cmd.id),
  };
  return { env, calls, clock, poll: compile(env, poll, 'pollOnce') };
}
Deno.test('app-playback-safety: phone poll deadline aborts a stalled JSON body and permits the next poll', async () => {
  const h = pollHarness();
  h.env.fetch = async (url, opts) => ({ ok: true, json: () => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  const polling = h.poll(); await flush();
  equal(h.clock.pending.size, 1, 'headers must not clear the body deadline');
  h.clock.run(30000); await polling; equal(h.clock.pending.size, 0);
  h.env.fetch = async () => ({ ok: true, json: async () => ({ maxId: 1, commands: [{ id: 1 }] }) });
  await h.poll(); equal(h.env.lastCmdId, 1); equal(h.calls.commands, []); equal(h.clock.pending.size, 0);
});
Deno.test('app-playback-safety: broker sequence reset resumes low numbered commands while initial priming skips old ones', async () => {
  const h = pollHarness();
  const responses = [{ maxId: 100, commands: [{ id: 100 }] }, { maxId: 1, commands: [] }, { maxId: 2, commands: [{ id: 1 }, { id: 2 }] }];
  h.env.fetch = async url => { h.calls.urls.push(url); return { ok: true, json: async () => responses.shift() }; };
  await h.poll(); equal(h.calls.commands, []); equal(h.env.lastCmdId, 100);
  await h.poll(); equal(h.env.lastCmdId, 0);
  await h.poll(); equal(h.calls.commands, [1, 2]); equal(h.env.lastCmdId, 2);
  equal(h.calls.urls.map(u => u.match(/since=(\d+)/)[1]), ['0', '100', '0']);
});
Deno.test('app-playback-safety: phone toggle resumes a parked video with no currentSrc', async () => {
  const toggle = section("        case 'toggle': {", "        case 'play':", remoteStart);
  let resumed = 0, played = 0;
  const env = { v: { currentSrc: '', play() { played++; } }, performance: { now: () => 5000 }, window: { __npResume: () => { resumed++; return true; } } };
  await compile(env, `async function toggle() { switch ('toggle') { ${toggle} } }`, 'toggle')();
  equal(resumed, 1); equal(played, 0); equal(env.window.__lastToggleAt, 5000);
});

const focusRestore = section('  function restoreBrowsingFocus(', '  function closePlayer()');
function focusNode(options = {}) {
  return {
    isConnected: options.connected !== false, disabled: false,
    closest(selector) {
      if (selector === '#player, [hidden]') return options.hidden ? {} : null;
      return null;
    },
    getBoundingClientRect: () => ({ width: options.zero ? 0 : 100, height: 100 }),
    focus() { this.nativeFocused = true; },
  };
}
Deno.test('app-playback-safety: close restores the browsing tile or a visible fallback, never the hidden player', () => {
  for (const detached of [false, true]) {
    const previous = focusNode({ connected: !detached }), hidden = focusNode({ hidden: true }), fallback = focusNode();
    let focused;
    const restore = compile({ document: { querySelectorAll: () => [hidden, fallback] }, DPad: { focus: el => { focused = el; } } }, focusRestore, 'restoreBrowsingFocus');
    const player = { _browseFocus: previous }; restore(player);
    equal(focused === (detached ? fallback : previous), true); equal(focused.nativeFocused, true); equal(player._browseFocus, null);
  }
});

const inspect = section('    if (!isLive && !isAudio && _PLAYER_HTTPS_RE.test(src))', '    // Crowd-sourced intro');
const close = section('  function restoreBrowsingFocus(', '  function showOverlay()');
Deno.test('app-playback-safety: failed-start listeners and deferred inspections are removed on source replacement and close', async () => {
  const { v, listeners } = media(), clock = timers(), nodes = {};
  v.paused = true;
  let inspections = 0;
  const ui = () => ({ classList: { remove() {}, contains: () => false }, hidden: false });
  const releaseItem = { _deferSeedrRelease: true };
  let releases = 0;
  const env = {
    ...clock, v, currentVideo: { fileId: 's1', _sourceGen: 1, _queueItem: releaseItem }, isLive: false, isAudio: false,
    src: 'https://seedr/file', _PLAYER_HTTPS_RE: /^https:/, _PLAYER_PHONEKEY_RE: /^PHONE:/,
    $: id => id === '#video' ? v : nodes[id] || (nodes[id] = ui()),
    NativePlayer: { load() {}, stopWatchdog() {}, release() {} },
    Remux: { engine: () => 'laptop', availableFor: () => true, inspectMedia: async () => { inspections++; return {}; }, close() {}, bindVideo() {} },
    persistCurrentResume() {}, cancelGrowingHandoff() {}, playbackResumeClock: () => ({ duration: 2000, position: 120 }),
    releaseSeedr(item) { equal(item === releaseItem, true); equal(env.currentVideo, null); releases++; },
    Storage: { clearResume() {} }, localStorage: { removeItem() {} }, clearSubOverlay() {}, 
    _musicAdvanceTimer: 0, _syncMode: false, cancelUpNext() {}, closeMenu() {},
    document: { body: ui(), getElementById: () => ui(), querySelectorAll: () => [] }, DPad: { popBackHandler() {} },
  };
  const api = compile(env, setter + close + `function bindInspection() { ${inspect} }`, '{ setVideoSource, bindInspection, closePlayer }');
  for (let i = 0; i < 10; i++) {
    api.bindInspection(); equal(listeners.get('playing').size, 1);
    api.setVideoSource(v, '/replacement'); equal(listeners.get('playing').size, 0);
  }
  v.paused = false; api.bindInspection(); equal(clock.pending.size, 1);
  api.closePlayer(); equal(listeners.get('playing').size, 0); equal(clock.pending.size, 0);
  v.emit('playing'); await flush(); equal(inspections, 0); equal(releases, 1);
});

Deno.test('app-playback-safety: Back invalidates queue-linked and cancel-hook open requests immediately', async () => {
  const cancel = section('  function cancelLoading()', '  // ---------- Subtitles ----------');
  for (const mode of ['resume', 'queue', 'hook']) {
    const calls = [];
    const env = {
      _openReqSeq: 17, _loadingFor: mode === 'queue' ? 'q' : null,
      _loadingCancelHook: mode === 'hook' ? () => calls.push('cancelled') : null,
      hideLoading() { calls.push('hidden'); }, toast() {},
      wipeQueueAndSeedr: () => { equal(env._openReqSeq, 18); calls.push('wipe'); return Promise.resolve(); },
      Remux: { close() { calls.push('close'); } },
    };
    compile(env, cancel, 'cancelLoading')(); await flush();
    equal(env._openReqSeq, 18); equal(calls, ['hidden', mode === 'queue' ? 'wipe' : mode === 'hook' ? 'cancelled' : 'close']);
  }
});

Deno.test('app-playback-safety: surviving webOS playback accumulates recycle time without a new playing event', () => {
  const h = recycleHarness(false);
  h.env.currentVideo = null;
  h.tick(3000); h.v.currentTime += 3; h.api._rcTrack();
  equal(h.api.played(), 3);
});

for (const newer of ['open', 'open then close', 'Back']) {
  Deno.test(`app-playback-safety: queued cache lookup keeps original ownership across ${newer}`, async () => {
    const h = openingHarness(), pending = deferred();
    const item = { id: 'q', autoplay: true, folderId: 42 };
    h.env.queue.push(item);
    h.env.Remux.resolveCache = () => pending.promise;
    const opening = h.api.playFromSeedrItem(item, { fileId: 's1', name: 'Old' }, () => h.env._openReqSeq);
    if (newer === 'Back') h.env._openReqSeq++;
    else h.env.openPlayer('/new', 'New');
    if (newer === 'open then close') h.env.currentVideo = null;
    pending.resolve({ rel: 'old' }); await opening;
    equal(h.calls.opens, newer === 'Back' ? [] : [['/new', 'New']]);
    equal(item.autoplay, true, 'a cancelled opener did not play and must not consume autoplay');
    equal(item._playStarting, false);
  });
}
for (const boundary of ['URL', 'probe']) {
  Deno.test(`app-playback-safety: queued direct open rechecks ownership after ${boundary}`, async () => {
    const h = openingHarness(), pending = deferred();
    const item = { id: 'q', autoplay: true, folderId: 42 }; h.env.queue.push(item);
    if (boundary === 'URL') h.env.Seedr.fetchFileUrl = () => pending.promise;
    else h.env._probeSeedrStream = () => pending.promise;
    const opening = h.api.playFromSeedrItem(item, { fileId: 's1', name: 'Old' }, () => h.env._openReqSeq);
    await flush(); h.env.openPlayer('/new', 'New'); h.env.currentVideo = null;
    pending.resolve(boundary === 'URL' ? '/seedr/old' : true); await opening;
    equal(h.calls.opens, [['/new', 'New']]); equal(h.calls.toasts, []);
  });
}
Deno.test('app-playback-safety: queue caller supplies the sequence and successful opens still consume autoplay', async () => {
  assert(source.includes('playFromSeedrItem(item, main, () => _openReqSeq)'));
  for (const hit of [null, { rel: 'old' }]) {
    const h = openingHarness(), item = { id: 'q', autoplay: true, folderId: 42 };
    h.env.queue.push(item); h.env.Remux.resolveCache = () => Promise.resolve(hit);
    await h.api.playFromSeedrItem(item, { fileId: 's1', name: 'Old' }, () => h.env._openReqSeq);
    equal(h.calls.opens, [[hit ? '/cache/old' : 'https://seedr/file', 'Old']]);
    equal(item.autoplay, false); equal(h.env.currentVideo._queueItem === item, true);
  }
});

Deno.test('app-playback-safety: stalled delivery cannot disable recycle time while buffered playback advances', () => {
  const h = recycleHarness(false); h.v.emit('playing');
  h.tick(3000); h.api._rcTrack();
  h.v.emit('stalled');
  for (let i = 0; i < 600; i++) { h.tick(3000); h.v.currentTime += 3; h.api._rcTrack(); }
  equal(h.api.played(), 1803, 'stalled alone is not a playback interruption');
  h.v.emit('waiting'); h.tick(60000); h.api._rcTrack(); equal(h.api.played(), 1803);
  h.v.emit('playing'); h.tick(3000); h.api._rcTrack(); equal(h.api.played(), 1806);
});

Deno.test('app-playback-safety: an hour of cache contention uses one Seedr URL and capped admission backoff', async () => {
  const h = copyHarness(calls => calls.waited < 3600000 ? 'busy' : 'ready');
  await h.copy(h.item);
  equal(h.calls.mints, 1); equal(h.calls.fallback, 0); equal(h.item.phase, 'drive-ready');
  assert(h.calls.uploads < 70, 'admission retries must back off instead of polling every four seconds');
  equal(h.calls.waits.slice(0, 6), [4000, 8000, 16000, 32000, 60000, 60000]);
  assert(h.calls.waits.every(ms => ms <= 60000));
});
Deno.test('app-playback-safety: a URL that expires during capacity waiting is refreshed after admission', async () => {
  const h = copyHarness(['busy', 'busy', 'HTTP 403', 'ready']);
  await h.copy(h.item);
  equal(h.calls.urls, ['/seedr/1', '/seedr/1', '/seedr/1', '/seedr/2']);
  equal(h.calls.mints, 2); equal(h.calls.fallback, 0); equal(h.item.phase, 'drive-ready');
});
Deno.test('app-playback-safety: removal during a capacity wait cannot mint or launch another attempt', async () => {
  const h = copyHarness(['busy', 'ready']), pending = deferred();
  h.env.sleep = () => pending.promise;
  const copying = h.copy(h.item); await flush();
  equal(h.calls.uploads, 1); h.item._uploadCancelled = true; pending.resolve(); await copying;
  equal(h.calls.uploads, 1); equal(h.calls.mints, 1); equal(h.calls.fallback, 0);
});

const wipe = section('  async function wipeQueueAndSeedr(', '  let _queueWipeBound');
const purge = section('  async function purgeTitle(', '  function playFromQueue(');
function releaseRemovalHarness() {
  const clock = timers(), pending = deferred(), item = { id: 'q', name: 'Old', folderId: 42, phase: 'drive-ready' };
  const calls = { deletes: 0, promotes: 0 };
  const env = {
    ...clock, currentVideo: null, queue: [item], activeWatchers: {},
    Seedr: { isLoggedIn: () => true, deleteItems: () => { calls.deletes++; return pending.promise; }, clean: () => Promise.resolve() },
    persistQueue() {}, renderQueue() {}, toast() {},
    promoteNextPending() { calls.promotes++; },
    preserveHalfWatchedSeedr: () => Promise.resolve(null),
    Storage: { listContinue: () => [] }, _remKey: name => name, markRemoved() {},
  };
  return { clock, pending, item, calls, env, api: compile(env, release + remove + wipe + purge, '{ releaseSeedr, removeFromQueue, wipeQueueAndSeedr, purgeTitle }') };
}
for (const operation of ['remove', 'wipe', 'purge']) {
  Deno.test(`app-playback-safety: ${operation} invalidates a pending delete before it can schedule a release retry`, async () => {
    const h = releaseRemovalHarness(), releasing = h.api.releaseSeedr(h.item);
    equal(h.calls.deletes, 1);
    if (operation === 'remove') await h.api.removeFromQueue(h.item);
    else if (operation === 'wipe') await h.api.wipeQueueAndSeedr(null, true);
    else await h.api.purgeTitle({ title: h.item.name });
    assert(h.item._seedrReleaseGen > 0); equal(h.env.queue.length, 0);
    h.pending.reject(new Error('delete failed after removal')); await releasing; await flush();
    equal(h.clock.pending.size, 0); equal(h.item._seedrReleaseTimer, 0);
    const before = h.calls.deletes; await h.api.releaseSeedr(h.item); equal(h.calls.deletes, before);
    equal(h.calls.promotes, 0);
  });
}
Deno.test('app-playback-safety: a removed item rejects an already queued release retry callback', async () => {
  const h = releaseRemovalHarness(), releasing = h.api.releaseSeedr(h.item);
  h.pending.reject(new Error('offline')); await releasing;
  const retry = [...h.clock.pending.values()][0].fn;
  await h.api.removeFromQueue(h.item);
  const before = h.calls.deletes; retry(); await flush();
  equal(h.calls.deletes, before); equal(h.clock.pending.size, 0); equal(h.item._seedrReleaseTimer, 0);
});
