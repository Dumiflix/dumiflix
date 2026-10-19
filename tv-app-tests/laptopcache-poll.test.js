// A copy must not be reported failed because one status poll failed.
function assertEquals(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const source = await Deno.readTextFile(new URL('../tv-app/js/laptopcache.js', import.meta.url));

function harness(statusReplies, opts = {}) {
  const ticks = [], timers = [];
  const fetch = (url) => {
    if (url.includes('/cache/fetch')) {
      if (opts.fetchTimesOut) return Promise.reject(new Error('The operation was aborted.'));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, state: 'started', rel: 'movie.mkv' }) });
    }
    const next = statusReplies.length ? statusReplies.shift() : 'throw';
    if (next === 'throw') return Promise.reject(new Error('timeout'));
    if (next === 502) return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(next) });
  };
  const backend = new Function('Storage', 'fetch', 'setTimeout', 'clearTimeout', `${source}; return LaptopCache;`)(
    { get: key => key === 'remux.laptopHost' ? 'laptop' : '' }, fetch,
    (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, () => {},
  );
  backend.uploadFromUrl({ id: 'job1', sourceUrl: 'https://seedr/video', filename: 'movie.mkv', total: 100 }, t => ticks.push(t));
  const drain = async () => {
    for (let round = 0; round < 40; round++) {
      for (let i = 0; i < 20; i++) await Promise.resolve();
      const pending = timers.splice(0).filter(t => t.ms !== 8000 && t.ms !== 10000 && t.ms !== 45000);
      if (!pending.length) break;
      for (const t of pending) await t.fn();
    }
  };
  return { ticks, drain };
}

Deno.test('transient status failures keep the copy alive', async () => {
  const h = harness(['throw', 502, 'throw',
    { state: 'downloading', total: 100, received: 50, progressiveReady: true, ranges: [[0, 50]] },
    { state: 'ready', total: 100, received: 100, ranges: [[0, 100]] }]);
  await h.drain();
  assertEquals(h.ticks.filter(t => t.status === 'error').length, 0);
  assertEquals(h.ticks[h.ticks.length - 1].status, 'ready');
});

Deno.test('a sustained status outage still reports the copy as failed', async () => {
  const h = harness([]);
  await h.drain();
  const errors = h.ticks.filter(t => t.status === 'error');
  assertEquals(errors.length, 1);
});

Deno.test('a server-side error is reported immediately', async () => {
  const h = harness([{ state: 'error', error: 'origin failed' }]);
  await h.drain();
  assertEquals(h.ticks.filter(t => t.status === 'error').map(t => t.error), ['origin failed']);
});

Deno.test('a timed-out copy request that the laptop admitted carries on', async () => {
  const h = harness([
    { state: 'downloading', rel: 'movie.mkv', total: 100, received: 10, ranges: [[0, 10]] },
    { state: 'downloading', total: 100, received: 50, progressiveReady: true, ranges: [[0, 50]] },
    { state: 'ready', total: 100, received: 100, ranges: [[0, 100]] }], { fetchTimesOut: true });
  await h.drain();
  assertEquals(h.ticks.filter(t => t.status === 'error').length, 0);
  assertEquals(h.ticks[h.ticks.length - 1].status, 'ready');
});

Deno.test('a timed-out copy request the laptop never saw is still a failure', async () => {
  const h = harness([{ state: 'unknown' }], { fetchTimesOut: true });
  await h.drain();
  assertEquals(h.ticks.filter(t => t.status === 'error').map(t => t.error), ['The operation was aborted.']);
});
