function assert(value, message = 'assertion failed') {
  if (!value) throw new Error(message);
}
function assertEquals(actual, expected) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right}, got ${left}`);
}
function assertStrictEquals(actual, expected) {
  if (actual !== expected) throw new Error('values are not strictly equal');
}

const appSource = await Deno.readTextFile(
  new URL('../tv-app/app.js', import.meta.url),
);
const start = appSource.indexOf('function _seedrLibraryQueueItem(source)');
const end = appSource.indexOf('\n\n  async function playFolder', start);
if (start < 0 || end < 0) throw new Error('Seedr Library queue helper not found');
const helperSource = appSource.slice(start, end);

function buildHelper(queue) {
  const calls = { persist: 0, render: 0, resumed: [] };
  const helper = new Function(
    'queue', 'persistQueue', 'renderQueue', 'resumeUpload',
    `${helperSource}; return _seedrLibraryQueueItem;`,
  )(
    queue,
    () => calls.persist++,
    () => calls.render++,
    (item) => calls.resumed.push(item),
  );
  return { helper, calls };
}

Deno.test('Seedr Library click recovers the matching failed cache row', () => {
  const existing = {
    id: 'q_existing',
    folderId: 42,
    name: 'Movie',
    phase: 'error',
    error: 'origin refused',
    _seedrUnavailable: true,
    _torrentFallback: true,
    _torrentJobId: 'old',
    _uploadStarted: true,
  };
  const queue = [existing];
  const { helper, calls } = buildHelper(queue);
  const result = helper({ folderId: '42', folderName: 'Movie' });

  assertStrictEquals(result, existing);
  assertEquals(existing.phase, 'seedred');
  assertEquals(existing.error, null);
  assertEquals(existing._seedrUnavailable, false);
  assertEquals(existing._torrentFallback, false);
  assertEquals(existing._torrentJobId, null);
  assertEquals(existing._uploadStarted, false);
  assertEquals(existing.autoplay, true);
  assertEquals(calls.persist, 1);
  assertEquals(calls.render, 1);
  assertEquals(calls.resumed, [existing]);
});

Deno.test('Seedr-only Library folder gets a durable cache queue row', () => {
  const queue = [];
  const { helper, calls } = buildHelper(queue);
  const result = helper({
    folderId: 7,
    folderName: 'Cloud Movie',
    name: 'Cloud Movie',
    total: 1234,
  });

  assertEquals(queue.length, 1);
  assertStrictEquals(result, queue[0]);
  assert(result.id.startsWith('q_seedr_'));
  assertEquals(result.phase, 'seedred');
  assertEquals(result.total, 1234);
  assertEquals(result.autoplay, true);
  assertEquals(calls.resumed, [result]);
});

Deno.test('queue-linked Seedr playback stays cache-first on an inconclusive probe', () => {
  const playStart = appSource.indexOf('async function playFile(');
  const playEnd = appSource.indexOf('\n  async function playFromLibrary', playStart);
  const playSource = appSource.slice(playStart, playEnd);
  assert(
    playSource.includes('if (queueItem ? probe !== true : probe === false)'),
    'queue-linked Seedr playback must not fail open on an inconclusive probe',
  );
  assert(
    appSource.includes("item.poster || null, item.id, 'Preparing stream…'"),
    'Library loading overlay must track the durable queue item',
  );
  assert(
    playSource.includes("showLoading(title || 'Loading…', poster || null, trackedQueueId"),
    'playFile must preserve the queue-tracked loading overlay',
  );
  const queuedStart = appSource.indexOf('async function playFromSeedrItem(');
  const queuedEnd = appSource.indexOf('\n  // Always-delete cleanup', queuedStart);
  const queuedSource = appSource.slice(queuedStart, queuedEnd);
  assert(
    queuedSource.includes('if (probe !== true)'),
    'queued Seedr autoplay must not fail open on an inconclusive probe',
  );
});

Deno.test('failed direct Seedr caching automatically enters protected torrent fallback', () => {
  const copyStart = appSource.indexOf('async function copyToGdrive(item)');
  const copyEnd = appSource.indexOf('\n  function persistQueue()', copyStart);
  const copySource = appSource.slice(copyStart, copyEnd);
  assert(
    copySource.includes('if (backend === LaptopCache && item.magnet && sawSourceFailure)'),
    'fallback must require the protected laptop torrent backend, a saved magnet and a real source failure',
  );
  assert(
    copySource.includes('return _downloadMagnetToLaptop(item);'),
    'three failed direct Seedr attempts must start the torrent fallback',
  );
  assert(
    copySource.indexOf('for (let _try = 0; _try < 3')
      < copySource.indexOf('return _downloadMagnetToLaptop(item);'),
    'torrent fallback must happen only after all direct Seedr retries',
  );
});

Deno.test('automatic torrent fallback resumes after an app restart', () => {
  assert(
    appSource.includes('if (it._torrentFallback) _downloadMagnetToLaptop(it);\n      else resumeUpload(it);'),
    'persisted torrent fallback must resume instead of restarting direct Seedr caching',
  );
});

Deno.test('hard Seedr playback failure starts the same protected fallback', () => {
  const stallStart = appSource.indexOf('// Some Seedr CDN failures never emit');
  const stallEnd = appSource.indexOf('// Chapter markers and format badges', stallStart);
  const stallSource = appSource.slice(stallStart, stallEnd);
  assert(
    stallSource.includes('if (probe === false)'),
    'only an explicit failed playback probe may trigger this fallback',
  );
  assert(
    stallSource.includes('_downloadMagnetToLaptop(cv._queueItem);'),
    'hard Seedr playback failure must enter the protected torrent fallback',
  );
});
