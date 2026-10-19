function assert(value, message = 'assertion failed') {
  if (!value) throw new Error(message);
}
function assertEquals(actual, expected, message = '') {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(message || `expected ${right}, got ${left}`);
}

const appSource = await Deno.readTextFile(new URL('../tv-app/app.js', import.meta.url));
const playerSource = await Deno.readTextFile(
  new URL('../tv-app/tv-player.js', import.meta.url),
);

function sourceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start);
  if (start < 0 || end < 0) throw new Error(`source block not found: ${startNeedle}`);
  return source.slice(start, end);
}

const libConstants = sourceBetween(
  appSource,
  'const _LIBTITLE_SEP_RE',
  '// Rank the backend a duplicate lives on',
);
const libHelpers = sourceBetween(
  appSource,
  'function _libCleanShowTitle',
  '// Turn a raw filename into a clean display title',
);
const showFromFilenameSource = sourceBetween(
  appSource,
  'function showFromFilename',
  '\n\n  async function playDriveFile',
);
const { cleanShow, isBonus, showFromFilename } = new Function(
  `${libConstants}\n${libHelpers}\n${showFromFilenameSource}\n`
    + 'return { cleanShow: _libCleanShowTitle, isBonus: _libIsBonusVideo, showFromFilename };',
)();

Deno.test('library merges parenthesized-year TV filenames into one canonical show', () => {
  const parsed = showFromFilename(
    'Example Kingdom (2022) - S02E01 - The First Crossing (1080p BluRay).mkv',
  );
  assert(parsed, 'episode filename should parse');
  assertEquals(parsed.season, 2);
  assertEquals(parsed.episode, 1);
  assertEquals(cleanShow(parsed.title), 'Example Kingdom');
  assertEquals(cleanShow('Example Kingdom'), 'Example Kingdom');
  assertEquals(cleanShow('1883'), '1883', 'year-only show names must survive cleanup');
});

Deno.test('already-imported bonus-disc clips do not render as unrelated movies', () => {
  assert(isBonus({ name: 'Episode 1 Extended Version.mkv' }));
  assert(isBonus({ name: 'Behind the Scenes - Dragons.mkv' }));
  assert(!isBonus({ name: 'The Invitation (2015).mkv' }));
  assert(!isBonus({ name: 'Example Kingdom S02E01.mkv', season: 2, episode: 1 }));
});

Deno.test('open Library notices a newly indexed laptop torrent without repainting unchanged data', () => {
  const fingerprintSource = sourceBetween(
    appSource,
    'function laptopLibraryFingerprint',
    '\n  function applyLaptopLibraryFiles',
  );
  const fingerprint = new Function(
    `${fingerprintSource}; return laptopLibraryFingerprint;`,
  )();
  const first = [
    { id: 'VPSCACHE::a.mkv', name: 'Show S01E01.mkv', size: 100, mtime: 1 },
    { id: 'VPSCACHE::b.mkv', name: 'Show S01E02.mkv', size: 200, mtime: 2 },
  ];
  assertEquals(fingerprint(first), fingerprint(first.slice().reverse()),
    'listing order alone must not repaint the Library');
  assert(fingerprint(first) !== fingerprint(first.concat({
    id: 'VPSCACHE::c.mkv', name: 'Show S01E03.mkv', size: 300, mtime: 3,
  })), 'a newly published episode must change the Library fingerprint');

  const pollSource = sourceBetween(
    appSource,
    'function startLaptopLibraryPoll',
    '\n  function stopLaptopLibraryPoll',
  );
  assert(pollSource.includes("currentTab !== 'library'"));
  assert(pollSource.includes('refreshLaptopLibrary()'));
  assert(pollSource.includes('5000'));
});

Deno.test('manual Next resolves local Library and cache paths before trackers', async () => {
  const helperSource = sourceBetween(
    appSource,
    'async function findManualNextEpisode',
    '\n\n  async function maybeShowUpNext',
  );
  const calls = [];
  const helper = new Function(
    'resolveNextEpisodeTarget', 'findNextEpisodeInQueue',
    'findNextEpisodeInLocalStores', 'findNextEpisodeQueueable',
    `${helperSource}; return findManualNextEpisode;`,
  )(
    async () => ({ season: 1, episode: 2 }),
    () => null,
    async () => { calls.push('cache'); return { label: 'cached', local() {} }; },
    async () => { calls.push('tracker'); return { label: 'tracker' }; },
  );

  const local = () => {};
  const direct = await helper({ show: { _localNext: local, _localNextLabel: 'S01E02' } });
  assertEquals(direct.label, 'S01E02');
  assert(direct.local === local);
  assertEquals(calls, []);

  const cached = await helper({ show: { title: 'Show', season: 1, episode: 1 } });
  assertEquals(cached.label, 'cached');
  assertEquals(calls, ['cache'], 'tracker must not run when a cached episode exists');
});

Deno.test('TV Next delegates to the complete app-side resolver', () => {
  const nextSource = sourceBetween(playerSource, 'function doNext()', '\n\n  function visibleControls');
  assert(nextSource.includes('bridge.findManualNextEpisode(cv)'));
  assert(appSource.includes('findManualNextEpisode: (typeof findManualNextEpisode'));
});

Deno.test('TV episode title drops unmatched release-group punctuation', () => {
  const cleanSource = sourceBetween(playerSource, 'function cleanTitle', '\n\n  function onWaiting');
  const cleanTitle = new Function('TITLE_JUNK_RE', `${cleanSource}; return cleanTitle;`)(
    /\b(2160p|1080p|720p|480p|4k|uhd|hdr10\+?|hdr|dv|dovi|hevc|x26[45]|h ?26[45]|av1|web[- ]?dl|webrip|web|bluray|blu ray|bdrip|brrip|hdtv|dvdrip|ddp?[.\s]?[257][.\s]?[01]?|aac|ac3|eac3|atmos|truehd|dts(-?hd)?|proper|repack|remux|extended|10bit|8bit|multi|dual[- ]?audio)\b/i,
  );
  assertEquals(
    cleanTitle(
      'Example Kingdom (2022) - S02E01 - The First Crossing (1080p BluRay x265).mkv',
      { title: 'Example Kingdom' },
    ),
    'The First Crossing',
  );
});

Deno.test('episode transition retries only an interrupted first play request', () => {
  const openSource = sourceBetween(appSource, 'function openPlayer(', '\n\n  function persistCurrentResume');
  assert(openSource.includes("e.name === 'AbortError'"));
  assert(openSource.includes('if (!retried && interrupted)'));
  assert(openSource.includes('currentVideo === playCv && v.paused'));
});

Deno.test('sidecar subtitles and speed are reflected in the TV controls', () => {
  const menuSource = sourceBetween(appSource, 'function setPlayerRate(', '\n\n  function addMenuItem');
  assert(menuSource.includes("document.querySelector('.nft-spd-tag')"));
  assert(menuSource.includes("addMenuItem(frag, 'English'"));
  assert(menuSource.includes('currentVideo._subCuesBackup'));
  assert(!menuSource.includes("addMenuItem(frag, 'No subtitles available', null, false);\n      }\n      // OpenSubtitles")
    || menuSource.includes('if (!seen.size)'));
});

Deno.test('TMDB movie fallback forces movie search instead of stale TV mode', () => {
  const movieSource = sourceBetween(appSource, 'async function openTmdbMovie', '\n\n  async function openTmdbTv');
  assert(movieSource.includes("selectSearchType('movies', false)"));
});

Deno.test('Mac QA proxy aborts abandoned upstream video responses', async () => {
  const serverSource = await Deno.readTextFile(
    new URL('./mac-qa-server.mjs', import.meta.url),
  );
  const proxySource = sourceBetween(
    serverSource,
    'async function proxy(',
    '\n\nconst mime',
  );
  assert(proxySource.includes("req.once('aborted', abortUpstream)"));
  assert(proxySource.includes("res.once('close', abortUpstream)"));
  assert(proxySource.includes('signal: controller.signal'));
});
