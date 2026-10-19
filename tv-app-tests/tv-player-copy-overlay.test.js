// Copy/status overlay package: evaluate the production pure models and renderer.
const source = await Deno.readTextFile(new URL('../tv-app/tv-player.js', import.meta.url));
function equal(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assert(value, message = 'assertion failed') { if (!value) throw new Error(message); }
function between(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a, `missing ${start}`);
  return source.slice(a, b);
}
const models = between('  function clamp(', '  function seedrSeekBlocked(');
const api = new Function(`${models}
  return { copyInProgress, downloadState, seekLocked, sourceStatus, remainingText, playerTimeState, formatTvClock };`)();
const copy = (ranges, extra = {}) => ({ _growingCache: true, _growingJobId: 'playing-file-job', _growingTotal: 1000, _growingRanges: ranges, ...extra });
const status = cv => api.sourceStatus(cv, api.downloadState(cv));

Deno.test('copy overlay maps disjoint byte ranges to fractions and counts union bytes without mutating input', () => {
  const cv = copy([[800, 900], [100, 300], [200, 400], [400, 500]]);
  const original = JSON.stringify(cv);
  equal(api.downloadState(cv), {
    segments: [{ start: 0.1, width: 0.4 }, { start: 0.8, width: 0.1 }], percent: 50, complete: false,
  });
  equal(JSON.stringify(cv), original);
});

Deno.test('copy overlay clips invalid/out-of-bounds ranges and rejects non-finite totals', () => {
  equal(api.downloadState(copy([[-50, 100], [950, 1200], [8, 2], [NaN, 400], [0, Infinity], null, 'bad'])), {
    segments: [{ start: 0, width: 0.1 }, { start: 0.95, width: 0.05 }], percent: 15, complete: false,
  });
  for (const total of [0, -1, NaN, Infinity, undefined]) {
    equal(api.downloadState(copy([[0, 100]], { _growingTotal: total })), { segments: [], percent: null, complete: false });
  }
  equal(api.downloadState(copy(undefined)), { segments: [], percent: null, complete: false });
  equal(api.downloadState(copy([])), { segments: [], percent: 0, complete: false });
});

Deno.test('copy overlay hides segments for complete and inactive copies, including stale range state', () => {
  equal(api.downloadState(copy([[500, 1000], [0, 500], [100, 900]])), { segments: [], percent: 100, complete: true });
  equal(status(copy([[0, 1000]])), '');
  const local = copy([[0, 640]], { _growingCache: false });
  equal(api.downloadState(local), { segments: [], percent: null, complete: false });
  equal(status(local), '');
  equal(status(null), '');
});

Deno.test('source pill distinguishes Seedr, partial laptop, switching, unknown progress, and zero copy speed', () => {
  equal(status(copy([[0, 120]], { _directSeedr: true })), 'Seedr · copying to laptop 12%');
  equal(status({ _directSeedr: true, _growingJobId: 'playing-file-job' }), 'Seedr · copying to laptop');
  equal(status({ _directSeedr: true }), 'Seedr');
  equal(status(copy([[0, 640]], { _growingBytesPerSec: 48000000 })), 'Laptop · 64% · 48 MB/s');
  equal(status(copy([], { _growingBytesPerSec: 0 })), 'Laptop · 0% · 0 MB/s');
  equal(status(copy(undefined, { _growingBytesPerSec: -5 })), 'Laptop · copying');
  equal(status(copy([[0, 640]], { _localHandoffPending: true, _directSeedr: true })), 'Switching to laptop…');
});

Deno.test('terminal copy/fallback queue states override stale current-file jobs and downloaded ranges', () => {
  for (const phase of ['error', 'cloud-ready', 'drive-ready', 'cooldown', 'pending']) {
    const cv = copy([[0, 640]], { _directSeedr: true,
      _queueItem: { phase, _backend: 'laptop', _torrentFallback: true, _torrentJobId: 'stale-torrent' } });
    equal(api.copyInProgress(cv), false);
    equal(status(cv), 'Seedr');
    equal(api.downloadState(cv), { segments: [], percent: null, complete: false });
    equal(api.seekLocked(cv), true);
  }
});

Deno.test('copy status follows the playing file job rather than a sibling queue copy or another backend', () => {
  const item = { phase: 'copying', _backend: 'laptop' };
  const cv = copy([[0, 120]], { _directSeedr: true, _queueItem: item });
  equal(status(cv), 'Seedr · copying to laptop 12%');
  cv._growingJobId = null;
  equal(status(cv), 'Seedr'); // Queue copying a sibling does not imply this file is copying.
  equal(api.downloadState(cv).segments, []);
  for (const backend of ['cache', 'drive']) {
    item._backend = backend; cv._growingJobId = 'stale-laptop-job';
    equal(status(cv), 'Seedr');
  }
});

Deno.test('Seedr pill follows active torrent fallback through failure and a new current-file retry', () => {
  const item = { phase: 'copying', _backend: 'laptop', _torrentFallback: true, _torrentJobId: 'torrent-job' };
  const cv = { _directSeedr: true, _queueItem: item };
  equal(status(cv), 'Seedr · copying to laptop');
  item._torrentJobId = null; item._torrentFallbackPromise = {};
  equal(status(cv), 'Seedr · copying to laptop'); // Includes startup before the first torrent tick.
  item.phase = 'error';
  equal(status(cv), 'Seedr');
  item.phase = 'copying'; item._torrentFallback = false;
  equal(status(cv), 'Seedr');
  cv._growingJobId = 'retry-job'; cv._growingRanges = [[0, 120]]; cv._growingTotal = 1000;
  equal(status(cv), 'Seedr · copying to laptop 12%');
  item.phase = 'error';
  equal(status(cv), 'Seedr');
});

Deno.test('seek lock is presentation only and leaves partial laptop target decisions to the existing gate', () => {
  equal(api.seekLocked({ _directSeedr: true }), true);
  equal(api.seekLocked({ _localHandoffPending: true }), true);
  equal(api.seekLocked(copy([[0, 100]])), false);
  equal(api.seekLocked(null), false);
});

Deno.test('remaining and end time handle long titles, rates, end clamping, unknown duration and midnight', () => {
  const utcClock = ms => new Date(ms).toISOString().slice(11, 16);
  const now = Date.UTC(2026, 9, 17, 23, 40);
  equal(api.playerTimeState(7200, 1070, now, 1, utcClock), { remaining: '-1:42:10', endsAt: 'Ends at 01:22' });
  equal(api.playerTimeState(1200, 0, now, 2, utcClock), { remaining: '-20:00', endsAt: 'Ends at 23:50' });
  equal(api.playerTimeState(10, 20, now, 1, utcClock), { remaining: '-0:00', endsAt: 'Ends at 23:40' });
  equal(api.playerTimeState(60, -10, now, 0, utcClock), { remaining: '-1:00', endsAt: 'Ends at 23:41' });
  equal(api.playerTimeState(60, NaN, now, NaN, utcClock), { remaining: '-1:00', endsAt: 'Ends at 23:41' });
  for (const duration of [0, -1, Infinity, NaN]) {
    equal(api.playerTimeState(duration, 10, now, 1, () => { throw new Error('must not format unknown end'); }),
      { remaining: '--:--', endsAt: '' });
  }
});

Deno.test('TV clock requests locale hours/minutes and falls back to padded 24-hour time when Intl fails', () => {
  const clockCode = between('  function formatTvClock(', '  // End pure overlay models.');
  let options;
  function LocalDate() {
    return { toLocaleTimeString(locales, opts) { equal(locales, []); options = opts; return '11:48 PM'; } };
  }
  equal(new Function('Date', `${clockCode} return formatTvClock(0);`)(LocalDate), '11:48 PM');
  equal(options, { hour: 'numeric', minute: '2-digit' });
  function BrokenIntlDate() {
    return { toLocaleTimeString() { throw new Error('Intl unavailable'); }, getHours: () => 3, getMinutes: () => 7 };
  }
  equal(new Function('Date', `${clockCode} return formatTvClock(0);`)(BrokenIntlDate), '03:07');
});

function node() {
  const classes = new Set();
  return { style: {}, textContent: '', attrs: {}, children: [],
    classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
    setAttribute(name, value) { this.attrs[name] = value; },
    appendChild(child) { this.children.push(child); },
  };
}
// Renderer tests use a realistic file (1000 MiB over 1000 s = 1 MiB/s) so the
// jumpable trim (10 s / 10 MiB before, 32 MiB after) is visible and exact.
const MiB = 1024 * 1024;
const copyMiB = (ranges, extra = {}) => copy(ranges.map(r => [r[0] * MiB, r[1] * MiB]), { _growingTotal: 1000 * MiB, ...extra });
const pct = el => [Number(parseFloat(el.style.left).toFixed(3)), Number(parseFloat(el.style.width).toFixed(3))];
function renderer() {
  const R = { rew: node(), fwd: node(), downloaded: node(), downloadEls: [], source: node(), sourceText: node(), ends: node(),
    rewLabel: 'Back 10 seconds', fwdLabel: 'Forward 10 seconds' };
  let clockCalls = 0;
  const bridge = { currentVideo: copyMiB([[0, 120], [800, 900]], { _directSeedr: true }),
    blockDirectSeedrSeek() { throw new Error('render must never call the seek gate'); } };
  const V = { playbackRate: 1 };
  const win = {};
  const rendererCode = between('  function updateTransferUI(', '  function wake(');
  const render = new Function('R', 'bridge', 'V', 'elt', 'formatClock', 'window', `${models}
    formatTvClock = formatClock;
    var active = true, controlsShown = true, lastCopyPaintAt = null, lastEndPaintAt = null, lastSeekLocked = null;
    function dur() { return 1000; }
    ${rendererCode}
    return { paint: updateTransferUI, visible: value => { controlsShown = value; },
      isVisible: () => controlsShown, activate: value => { active = value; },
      refresh: window.__nftRefreshSourceStatus };`)(
    R, bridge, V, node, ms => { clockCalls++; return String(ms); }, win);
  return { R, bridge, ...render, clockCalls: () => clockCalls };
}

Deno.test('visible renderer throttles ranges to 2 Hz and clock to 1 Hz while unlocking immediately', () => {
  const h = renderer();
  h.paint(1000, 60, 0);
  equal(h.R.sourceText.textContent, 'Seedr · copying to laptop 22%');
  equal(h.R.rew.attrs['aria-disabled'], 'true');
  // [0,120] touches the start: no leading trim, 32 MiB off the end -> 0..8.8%.
  // [800,900]: 10 MiB off the start, 32 MiB off the end -> 81..86.8%.
  equal(h.R.downloadEls.map(pct), [[0, 8.8], [81, 5.8]]);
  h.bridge.currentVideo = copyMiB([[0, 640]], { _growingBytesPerSec: 48000000 });
  h.paint(1000, 61, 100);
  equal(h.R.fwd.attrs['aria-disabled'], 'false');
  equal(h.R.sourceText.textContent, 'Seedr · copying to laptop 22%');
  h.paint(1000, 61, 499);
  equal(h.clockCalls(), 1);
  h.paint(1000, 61, 500);
  equal(h.R.sourceText.textContent, 'Laptop · 64% · 48 MB/s');
  equal(h.R.downloadEls[1].style.display, 'none');
  equal(h.clockCalls(), 1);
  h.paint(1000, 62, 999); equal(h.clockCalls(), 1);
  h.paint(1000, 62, 1000); equal(h.clockCalls(), 2);
});

Deno.test('hidden renderer does no work; resumed/completed copies reuse nodes and clear stale UI', () => {
  const h = renderer();
  h.visible(false); h.paint(1000, 0, 0);
  equal(h.R.downloadEls.length, 0); equal(h.clockCalls(), 0);
  h.visible(true); h.paint(1000, 60, 500);
  const original = h.R.downloadEls.slice();
  h.visible(false);
  h.bridge.currentVideo = copyMiB([[0, 1000]]);
  h.paint(1000, 60, 1500);
  equal(h.clockCalls(), 1);
  assert(h.R.source.classList.contains('nft-source-visible'));
  h.visible(true); h.paint(1000, 60, 1600);
  equal(h.R.sourceText.textContent, '');
  assert(!h.R.source.classList.contains('nft-source-visible'));
  assert(h.R.downloadEls.every(el => el.style.display === 'none'));
  h.bridge.currentVideo = copyMiB([[0, 150], [700, 800]]);
  h.paint(1000, 60, 2100);
  equal(h.R.downloadEls.length, 2);
  assert(h.R.downloadEls.every((el, i) => el === original[i]));
  equal(h.R.downloaded.children.length, 2);
});

Deno.test('source refresh clears switching while controls are hidden without waking other UI', () => {
  const h = renderer();
  h.bridge.currentVideo._localHandoffPending = true;
  h.paint(1000, 60, 0);
  equal(h.R.sourceText.textContent, 'Switching to laptop…');
  h.visible(false);
  h.bridge.currentVideo._localHandoffPending = false;
  h.bridge.currentVideo._growingJobId = null;
  h.refresh();
  equal(h.R.sourceText.textContent, 'Seedr');
  assert(h.R.source.classList.contains('nft-source-seedr'));
  assert(h.R.source.classList.contains('nft-source-visible'));
  equal(h.isVisible(), false);
  equal(h.clockCalls(), 1);
  equal(h.R.downloadEls.length, 2);
  h.bridge.currentVideo = { source: 'laptop' };
  h.refresh();
  equal(h.R.sourceText.textContent, '');
  assert(!h.R.source.classList.contains('nft-source-seedr'));
  assert(!h.R.source.classList.contains('nft-source-visible'));
  h.activate(false);
  h.bridge.currentVideo = { _directSeedr: true };
  h.refresh();
  equal(h.R.sourceText.textContent, '');
});

Deno.test('paused visible UI reuses its tick at 500 ms and hidden idle controls schedule no tick', () => {
  const loopCode = between('  function loop()', '  function updateTransferUI(');
  const R = { fill: node(), head: node(), bubble: node(), buf: node(), cur: node(), dur: node() };
  const V = { paused: true, buffered: { length: 0 } };
  const scheduled = [], paints = [];
  const loop = new Function('R', 'V', 'setTimeout', 'updateTransferUI', `${models}
    var active = true, uiTimer = 0, controlsShown = true, seekTarget = null, seekPending = null;
    var lastTimeStr = '', MEDIA_TICK = 500, UI_TICK = 100;
    function dur() { return 600; } function nowAbs() { return 60; }
    ${loopCode}
    return { run: loop, visible: value => { controlsShown = value; } };`)(
    R, V, (fn, ms) => { scheduled.push(ms); return 1; }, (...args) => paints.push(args));
  loop.run(); equal(scheduled, [500]); equal(R.dur.textContent, '-9:00');
  V.paused = false; loop.run(); equal(scheduled, [500, 100]);
  loop.visible(false); loop.run(); equal(scheduled, [500, 100]);
  equal(paints.length, 3); // updateTransferUI itself owns the hidden guard.
});
