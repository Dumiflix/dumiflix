function assert(value, message = 'assertion failed') {
  if (!value) throw new Error(message);
}
function equal(actual, expected, message = '') {
  if (actual !== expected) throw new Error(message || `expected ${expected}, got ${actual}`);
}
const appSource = await Deno.readTextFile(new URL('../tv-app/app.js', import.meta.url));
function between(start, end) {
  const a = appSource.indexOf(start);
  const b = appSource.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`missing source: ${start}`);
  return appSource.slice(a, b);
}
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
const overlay = between('let _loadingFor =', '  // Set by downloadToServerAndPlay');
const queueFunctions = between('async function addToQueue(', '  // Torrent hashes');
const episodeParser = between('function parseEpisodeName(', '  // Choose the best release for a season-to-pen');
const pickVideo = between('function pickSeedrVideo(', '  function persistQueue()');
const decidePlay = between('async function decidePlayPath(', '  // Seedr-folder sibling-subtitle search');
const uploadFunctions = between('function resumeUpload(', '  function persistQueue()');
const retryFunction = between('function retryItem(', '  // Remove an item from the queue.');

function baseEnv() {
  const nodes = {};
  const calls = { saved: [], watched: [], toasts: [], pops: 0 };
  const env = {
    queue: [], currentVideo: null, currentTab: 'home', activeWatchers: {},
    _keepWatchPending: null, MAX_FILE_BYTES: 5 * 1024 * 1024 * 1024,
    $: selector => nodes[selector] || (nodes[selector] = { hidden: true, style: {} }),
    DPad: { pushBackHandler() {}, popBackHandler() { calls.pops++; } },
    cancelLoading() {}, renderQueue() {}, showTab() {}, unmarkRemoved() {},
    isRemoved: () => false,
    persistQueue: () => calls.saved.push(env.queue.map(item => ({ ...item }))),
    startWatch: item => calls.watched.push(item),
    toast: msg => calls.toasts.push(msg),
    wipeQueueAndSeedr: async () => { env.queue.length = 0; },
    console: { warn() {} },
  };
  return { env, nodes, calls };
}

for (const promoted of [false, true]) {
  for (const outcome of ['terminal', 'superseded', 'retry-success']) {
    Deno.test(`app-queue-followups: ${promoted ? 'promoted' : 'user'} add ${outcome} keeps overlay ownership`, async () => {
      const { env, nodes, calls } = baseEnv();
      let attempts = 0;
      let api;
      env.Seedr = {
        isLoggedIn: () => true, clean: async () => {},
        addMagnet: async () => {
          attempts++;
          equal(nodes['#dumi-loading'].hidden, false, 'overlay survives the first retry');
          if (attempts === 2) {
            if (outcome === 'superseded') api.showLoading('Other', null, 'other');
            if (outcome === 'retry-success') return;
          }
          throw new Error('quota');
        },
      };
      api = new Function('env', `with (env) {
        ${overlay}\n${queueFunctions}
        return { showLoading, addToQueue, promoteNextPending };
      }`)(env);
      if (promoted) {
        env.queue.push({ id: 'pending', name: 'Episode', magnet: 'magnet:ep', phase: 'pending' });
        api.showLoading('Episode', null, 'pending');
        api.promoteNextPending();
        await flush();
      } else {
        await api.addToQueue({ name: 'Episode', magnet: 'magnet:ep', autoplay: true });
      }
      equal(attempts, 2);
      equal(nodes['#dumi-loading'].hidden, outcome === 'terminal');
      equal(calls.pops, outcome === 'terminal' ? 1 : 0);
      equal(env.queue.length, outcome === 'retry-success' ? 1 : 0);
      equal(calls.watched.length, outcome === 'retry-success' ? 1 : 0);
      if (outcome === 'retry-success') equal(env.queue[0].phase, 'seedring');
    });
  }
}

Deno.test('app-queue-followups: folder-read failure persists an error, dismisses loading and allows retry', async () => {
  const { env, nodes, calls } = baseEnv();
  let walks = 0;
  Object.assign(env, {
    Remux: { engine: () => 'laptop' },
    LaptopCache: { reachable: async () => true },
    Seedr: { walkFolder: async () => { walks++; throw new Error('folder unavailable'); } },
  });
  const api = new Function('env', `with (env) {
    ${overlay}\n${uploadFunctions}\n${retryFunction}
    return { showLoading, resumeUpload, retryItem };
  }`)(env);
  const item = { id: 'q', name: 'Episode', folderId: 42, phase: 'seedred' };
  env.queue.push(item);
  api.showLoading(item.name, null, item.id);
  api.resumeUpload(item);
  api.resumeUpload(item);
  await flush();
  equal(walks, 1, 'uploads remain single-flight');
  equal(item.phase, 'error', 'normal Retry button requires phase error');
  assert(item.error.includes('folder unavailable'));
  equal(calls.saved[calls.saved.length - 1][0].phase, 'error');
  equal(nodes['#dumi-loading'].hidden, true);
  equal(item._uploadStarted, false);
  api.retryItem(item);
  await flush();
  equal(walks, 2, 'normal queue retry must attempt a new folder read');
  equal(item.phase, 'error');
});

function playHarness(files, walkFails = false) {
  const calls = { played: [], uploaded: [], ticks: [], persisted: 0, next: 0 };
  const env = {
    Seedr: { walkFolder: async () => { if (walkFails) throw new Error('offline'); return files; } },
    playFromSeedrItem: (item, main) => { item.mainSeedrFileId = main.fileId; calls.played.push(main); return Promise.resolve(); },
    resumeUpload: item => calls.uploaded.push(item),
    autoQueueNextEpisode: async () => { calls.next++; },
    persistQueue: () => calls.persisted++, renderQueue() {},
    loadingTick: item => calls.ticks.push(item),
  };
  return { calls, env, decide: new Function('env', `with (env) {
    ${episodeParser}\n${pickVideo}\n${decidePlay}
    return decidePlayPath;
  }`)(env) };
}
const pack = [
  { fileId: 1, name: 'Show.S01E01.mkv', size: 900 },
  { fileId: 2, name: 'Show.S01E02.mkv', size: 200 },
  { fileId: 3, name: 'Show.S02E02.mkv', size: 800 },
  { fileId: 4, name: 'Show.S01E02.srt', size: 1 },
];
Deno.test('app-queue-followups: pack playback picks the requested episode and starts caching concurrently', async () => {
  const { calls, env, decide } = playHarness(pack);
  const item = { folderId: 42, autoplay: true, show: { season: '1', episode: '2' } };
  let finishPlay;
  const playPending = new Promise(resolve => { finishPlay = resolve; });
  const play = env.playFromSeedrItem;
  env.playFromSeedrItem = (item, main) => {
    play(item, main);
    item.autoplay = false;
    return playPending;
  };
  const playing = decide(item);
  await flush();
  try {
    equal(calls.uploaded[0], item, 'caching must start before playback finishes opening');
  } finally {
    finishPlay();
  }
  await playing;
  equal(calls.played[0].fileId, 2);
  equal(item.mainSeedrFileId, 2, 'the selected identity reaches the existing cache mapping');
  equal(calls.uploaded[0], item);
  equal(calls.next, 1);
});
Deno.test('app-queue-followups: pack episode selection supports top-level context, NxNN and multi-episode files', async () => {
  for (const name of ['Show.1x02.mkv', 'Show.S01E01-E03.mkv', 'Show.1x01-03.mkv']) {
    const { calls, decide } = playHarness([pack[0], { fileId: 8, name, size: 100 }]);
    await decide({ folderId: 42, season: 1, episode: 2 });
    equal(calls.played[0].fileId, 8);
  }
  const { calls, decide } = playHarness(pack);
  await decide({ folderId: 42, episode: 2, show: { season: 1 } });
  equal(calls.played[0].fileId, 2);
});
Deno.test('app-queue-followups: single-video releases retain playback even without episode tags', async () => {
  const video = { fileId: 9, name: 'renamed.mkv', size: 200 };
  const { calls, decide } = playHarness([video]);
  await decide({ folderId: 42, show: { season: 1, episode: 2 } });
  equal(calls.played[0], video);
});
Deno.test('app-queue-followups: underscore-separated pack files select the requested episode without renaming it', async () => {
  for (const tag of ['S01E02', '1x02']) {
    const main = { fileId: 22, name: `Show_${tag}_1080p.mkv`, size: 200 };
    const files = [{ fileId: 21, name: 'Show_S01E01_1080p.mkv', size: 900 }, main];
    const { calls, decide } = playHarness(files);
    await decide({ folderId: 42, show: { season: 1, episode: 2 } });
    equal(calls.played[0], main);
    equal(calls.played[0].name, `Show_${tag}_1080p.mkv`);
    equal(calls.uploaded.length, 1);
    equal(files.length, 2);
  }
});
Deno.test('app-queue-followups: samples cannot replace an untagged single main video', async () => {
  for (const name of ['sample.mkv', 'Show.S01E02.sample.mkv', 'Show_S01E02_sample_1080p.mkv']) {
    const main = { fileId: 22, name: 'group-release.mkv', size: 900 };
    const { calls, decide } = playHarness([{ fileId: 21, name, size: 20 }, main]);
    await decide({ folderId: 42, show: { season: 1, episode: 2 } });
    equal(calls.played[0], main, `sample ${name} must not count as a main video`);
    equal(calls.uploaded.length, 1);
  }
});
Deno.test('app-queue-followups: extras are excluded before counting main videos or ranking episode matches', async () => {
  for (const name of ['extras.mkv', 'featurette.mkv', 'Show.S01E02.trailer.mkv']) {
    const main = { fileId: 22, name: 'group-release.mkv', size: 900 };
    const { calls, decide } = playHarness([{ fileId: 21, name, size: 20 }, main]);
    await decide({ folderId: 42, show: { season: 1, episode: 2 } });
    equal(calls.played[0], main);
  }
  const main = { fileId: 22, name: 'Show.S01E02.mkv', size: 200 };
  const { calls, decide } = playHarness([
    { fileId: 21, name: 'Show.S01E02.sample.mkv', size: 900 }, main,
    { fileId: 23, name: 'Show.S01E01.mkv', size: 500 },
  ]);
  await decide({ folderId: 42, show: { season: 1, episode: 2 } });
  equal(calls.played[0], main, 'bonus labels win over both episode tags and file size');
});
Deno.test('app-queue-followups: sample-only folders cannot start playback or caching', async () => {
  const { calls, decide } = playHarness([{ fileId: 21, name: 'sample.mkv', size: 20 }]);
  const item = { folderId: 42, show: { season: 1, episode: 2 } };
  await decide(item);
  equal(item.phase, 'error');
  equal(calls.played.length, 0);
  equal(calls.uploaded.length, 0);
});
Deno.test('app-queue-followups: filtering samples cannot turn a different episode into the single-main fallback', async () => {
  const { calls, decide } = playHarness([
    { fileId: 21, name: 'Show_S01E02_sample.mkv', size: 20 },
    { fileId: 22, name: 'Show_S01E01_1080p.mkv', size: 900 },
  ]);
  const item = { folderId: 42, show: { season: 1, episode: 2 } };
  await decide(item);
  equal(item.phase, 'error');
  equal(calls.played.length, 0);
  equal(calls.uploaded.length, 0);
});
Deno.test('app-queue-followups: bonus filtering preserves show titles containing Extra or Extras', async () => {
  const main = { fileId: 22, name: 'Extras.S01E02.mkv', size: 200 };
  const { calls, decide } = playHarness([
    { fileId: 21, name: 'Extras.S01E01.mkv', size: 900 }, main,
  ]);
  await decide({ folderId: 42, show: { season: 1, episode: 2 } });
  equal(calls.played[0], main);
});
Deno.test('app-queue-followups: movies and packs without a known episode still select the largest video', async () => {
  for (const show of [null, { season: 1 }]) {
    const { calls, decide } = playHarness(pack);
    await decide({ folderId: 42, show });
    equal(calls.played[0].fileId, 1);
    equal(calls.uploaded.length, 1);
  }
});
Deno.test('app-queue-followups: a missing requested episode fails visibly instead of starting a sibling', async () => {
  const { calls, decide } = playHarness(pack);
  const item = { folderId: 42, show: { season: 1, episode: 9 } };
  await decide(item);
  equal(item.phase, 'error');
  assert(item.error.includes('requested episode'));
  equal(calls.played.length, 0);
  equal(calls.uploaded.length, 0);
  equal(calls.persisted, 1);
  equal(calls.ticks[0], item);
});
Deno.test('app-queue-followups: the folder-read fallback preserves episode selection during caching', async () => {
  const { env } = baseEnv();
  const item = { id: 'q', folderId: 42, phase: 'seedred', show: { season: 1, episode: 2 } };
  let walks = 0;
  Object.assign(env, {
    Remux: { engine: () => 'laptop' }, LaptopCache: { reachable: async () => true },
    Seedr: { walkFolder: async () => { if (++walks === 1) throw new Error('transient'); return pack; } },
    // Stop once copying reaches the first video: selection has happened but
    // no real backend, player or network is needed for this regression.
    resolveSeedrSubs: () => null,
  });
  env.Seedr.fetchFileUrl = async () => { throw new Error('stop after selecting'); };
  const api = new Function('env', `with (env) {
    ${episodeParser}\n${pickVideo}\n${decidePlay}\n${uploadFunctions}
    return { decidePlayPath };
  }`)(env);
  // Provide a microtask-only sleep for the copy retry loop.
  env.sleep = async () => {};
  env._downloadMagnetToLaptop = () => {};
  env.loadingTick = () => {};
  await api.decidePlayPath(item);
  await flush();
  equal(walks, 2);
  equal(item.mainSeedrFileId, 2);
  equal(item.seedrVideos.length, 3, 'the full manifest remains available for exact cache mapping');
});

const norm = between('function _normShow(', '  // Strict show-name match.');
const libConstants = between('const _LIBTITLE_SEP_RE', '// Rank the backend a duplicate lives on');
const libRank = between('function _libSrcRank', '  // Every physical Library copy');
const libGroups = between('function _libCleanShowTitle', '  // Lazily fill a poster tile');
const filenameParser = between('function showFromFilename', '\n\n  async function playDriveFile');
const indexFunction = between('function downloadedIndex()', '    let activeSeason =');
function downloaded(files, year, extra = {}) {
  const env = {
    it: { title: 'Dark Matter', year }, showYear: year,
    canonical: { show: { name: 'Dark Matter' } }, strictYear: false,
    _libState: { cacheFiles: [], driveFiles: files, penComplete: [], laptopFiles: [] },
    wlMetaAll: () => ({}), ...extra,
  };
  return new Function('env', `with (env) {
    ${norm}\n${libConstants}\n${libRank}\n${libGroups}\n${filenameParser}\n${indexFunction}
    return downloadedIndex();
  }`)(env);
}
const releases = [
  { id: 'old', name: 'Dark.Matter.2015.S01E01.mkv' },
  { id: 'new', name: 'Dark.Matter.2024.S01E02.mkv' },
];
Deno.test('app-queue-followups: downloaded marks distinguish same-title series by year', () => {
  const old = downloaded(releases, 2015);
  const recent = downloaded(releases, '2024');
  assert(old.get(1).has(1) && !old.get(1).has(2));
  assert(recent.get(1).has(2) && !recent.get(1).has(1));
  equal(downloaded([releases[0]], 2024).size, 0, 'another known year is never a fallback');
});
Deno.test('app-queue-followups: downloaded marks retain unambiguous yearless libraries but reject ambiguity', () => {
  const yearless = { id: 'unknown', name: 'Dark.Matter.S01E03.mkv' };
  assert(downloaded([yearless], 2024).get(1).has(3));
  assert(downloaded([releases[1], yearless], 2024).get(1).has(3));
  const ambiguous = downloaded([...releases, yearless], 2024);
  assert(ambiguous.get(1).has(2) && !ambiguous.get(1).has(3));
  equal(downloaded([yearless], 2024, { strictYear: true }).size, 0);
  equal(downloaded(releases, null).size, 0);
  assert(downloaded([releases[1]], null).get(1).has(2));
});
Deno.test('app-queue-followups: downloaded marks use the same laptop snapshot and embedded title year as Library', () => {
  const index = downloaded([], null, {
    canonical: null, it: { title: 'Dark Matter (2024)' },
    _libState: { laptopFiles: releases },
  });
  assert(index.get(1).has(2) && !index.get(1).has(1));
});
