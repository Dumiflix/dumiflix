const source = await Deno.readTextFile(new URL('../tv-app/js/seedr.js', import.meta.url));

function assert(value, message = 'assertion failed') {
  if (!value) throw new Error(message);
}
function equal(actual, expected) {
  assert(JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
async function rejects(promise, message) {
  try { await promise; } catch (e) {
    assert(String(e).includes(message), `unexpected rejection: ${e}`);
    return;
  }
  throw new Error('expected rejection');
}
function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(data) };
}
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
function harness(fetcher, saved = { seedr: { access_token: 'token', refresh_token: 'refresh' } }) {
  let now = 0, nextTimer = 0, writes = 0;
  const timers = new Map();
  const storage = {
    get: (key, fallback) => key in saved ? JSON.parse(JSON.stringify(saved[key])) : fallback,
    set(key, value) { saved[key] = JSON.parse(JSON.stringify(value)); writes++; },
    clear(key) { delete saved[key]; },
  };
  const api = new Function('Storage', 'fetch', 'setTimeout', 'clearTimeout', 'Date',
    `${source}; return Seedr;`)(storage, fetcher,
    (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    id => timers.delete(id), { now: () => now });
  return {
    api, saved, timers, writes: () => writes,
    async advance(ms) {
      now += ms;
      const due = [...timers].filter(([, timer]) => timer.at <= now);
      for (const [id, timer] of due) {
        if (timers.delete(id)) timer.callback();
      }
      await flush();
    },
  };
}

Deno.test('Seedr rejects HTTP and in-body failures for every resource operation', async () => {
  const operations = [
    api => api.addMagnet('magnet:?xt=urn:btih:abc'),
    api => api.deleteItems({ folder_ids: [42] }),
    api => api.listContents(), api => api.fetchFile(1), api => api.fetchFileUrl(1),
    api => api.walkFolder(42), api => api.clean(),
  ];
  const failures = [
    [() => response({}, 500), 'http_500'],
    [() => response({ result: false, error: 'quota_full' }), 'quota_full'],
    [() => response({ result: false }), 'seedr operation failed'],
    [() => response({ error: 'file_missing' }), 'file_missing'],
    [() => response(null, 500), 'http_500'],
    [() => ({ ...response({}, 500), json: () => Promise.reject(new SyntaxError('HTML')) }), 'http_500'],
  ];
  for (const [fetcher, message] of failures) {
    for (const operation of operations) {
      const h = harness(fetcher);
      await rejects(operation(h.api), message);
      equal(h.timers.size, 0);
    }
  }
});

Deno.test('Seedr successful adds, deletes, file URLs and empty deletes retain their contracts', async () => {
  const accepted = { result: true, url: 'https://example.test/file' };
  let calls = 0;
  const h = harness(() => { calls++; return response(accepted); });
  equal(await h.api.addMagnet('magnet'), accepted);
  equal(await h.api.deleteItems({ folder_ids: [42], file_ids: [7], torrent_ids: [9] }), accepted);
  equal(await h.api.fetchFileUrl(7), accepted.url);
  await h.api.deleteItems({});
  equal(calls, 3);
});

Deno.test('Seedr failed shared reads reject all subscribers and allow a fresh retry', async () => {
  let finish, calls = 0;
  const h = harness(() => {
    calls++;
    if (calls === 1) return new Promise(resolve => { finish = resolve; });
    return response({ folders: [] });
  });
  const a = rejects(h.api.listContents(), 'http_500');
  const b = rejects(h.api.listContents(), 'http_500');
  equal(calls, 1);
  finish(response({}, 500));
  await Promise.all([a, b]);
  equal(await h.api.listContents(), { folders: [] });
  equal(calls, 2);
});

Deno.test('Seedr refreshes expired tokens or HTTP auth failures once before rejecting', async () => {
  for (const first of [response({ error: 'expired_token' }), response({}, 401), response({}, 403)]) {
    const requests = [];
    const h = harness(url => {
      requests.push(url);
      if (requests.length === 1) return first;
      if (requests.length === 2) return response({ access_token: 'new-token' });
      return response({ error: 'denied' }, 403);
    });
    await rejects(h.api.addMagnet('magnet'), 'denied');
    equal(requests.length, 3);
    assert(requests[2].includes('access_token=new-token'));
  }
});

Deno.test('Seedr body consumption keeps the deadline for resources, refresh and login', async () => {
  for (const operation of [api => api.listContents(), api => api.refresh(), api => api.login('email', 'password')]) {
    let signal;
    const h = harness((_url, opts) => {
      signal = opts.signal;
      return { ...response({}), json: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('body aborted')));
      }) };
    });
    const pending = rejects(operation(h.api), 'body aborted');
    await flush();
    equal(h.timers.size, 1);
    await h.advance(14999);
    equal(signal.aborted, false);
    await h.advance(1);
    await pending;
    equal(signal.aborted, true);
    equal(h.timers.size, 0);
  }
});

Deno.test('Seedr clears the deadline on a network failure or a consumed body', async () => {
  const failing = harness(() => Promise.reject(new Error('offline')));
  await rejects(failing.api.listContents(), 'offline');
  equal(failing.timers.size, 0);
  let signal;
  const good = harness((_url, opts) => { signal = opts.signal; return response({ folders: [] }); });
  await good.api.listContents();
  equal(good.timers.size, 0);
  await good.advance(15000);
  equal(signal.aborted, false);
});

Deno.test('Seedr visible zero-speed torrents time out after 90 seconds without progress', async () => {
  const h = harness(() => response({ torrents: [{ hash: 'abc', name: 'Release', progress: 10, download_rate: 0 }] }));
  const updates = [];
  h.api.watch('ABC', 'Display title', update => updates.push(update));
  await flush();
  for (let i = 0; i < 36; i++) await h.advance(2500);
  assert(!updates.some(update => update.stalled), 'must not stall before the deadline');
  await h.advance(2500);
  equal(updates[updates.length - 1], { stalled: true });
  const count = updates.length;
  await h.advance(10000);
  equal(updates.length, count);
  equal(h.timers.size, 0);
});

Deno.test('Seedr forward progress or positive speed resets the active stall deadline', async () => {
  for (const change of [{ progress: 11, download_rate: 0 }, { progress: 10, download_rate: 1 }]) {
    const torrent = { hash: 'abc', progress: 10, download_rate: 0 };
    const h = harness(() => response({ torrents: [{ ...torrent }] }));
    const updates = [];
    h.api.watch('abc', 'Display', update => updates.push(update));
    await flush();
    for (let i = 0; i < 35; i++) await h.advance(2500);
    Object.assign(torrent, change);
    await h.advance(2500);
    torrent.download_rate = 0;
    for (let i = 0; i < 36; i++) await h.advance(2500);
    assert(!updates.some(update => update.stalled));
    await h.advance(2500);
    equal(updates[updates.length - 1], { stalled: true });
  }
});

Deno.test('Seedr absent torrents still time out and list errors report through the watcher', async () => {
  let fail = true;
  const h = harness(() => fail ? response({}, 500) : response({}));
  const updates = [];
  h.api.watch('abc', 'Display', update => updates.push(update));
  await flush();
  assert(updates[0].error.includes('http_500'));
  fail = false;
  for (let i = 0; i < 37; i++) await h.advance(2500);
  equal(updates[updates.length - 1], { stalled: true });
});

Deno.test('Seedr persists observed release names, isolates watches and matches completed folders after reboot', async () => {
  const torrents = [
    { hash: 'abc', name: 'Actual.Release.Group', progress: 10 },
    { hash: 'def', name: 'Other.Release.Group', progress: 10 },
  ];
  const first = harness(() => response({ torrents }));
  const stopA = first.api.watch('ABC', 'Unrelated display title', () => {});
  const stopB = first.api.watch('def', 'Other display title', () => {});
  await flush();
  equal(first.writes(), 2);
  await first.advance(2500);
  equal(first.writes(), 2); // unchanged poll names do not rewrite storage
  stopA(); stopB();
  await first.advance(2500);
  const folder = { id: 42, name: 'Actual.Release.Group' };
  const second = harness(() => response({ folders: [folder, { id: 43, name: 'Other.Release.Group' }] }), first.saved);
  const updates = [];
  second.api.watch('abc', 'Unrelated display title', update => updates.push(update));
  await flush();
  equal(updates, [{ active: false, pct: 100, folder }]);
  equal(second.saved.seedr.watchNames, { def: 'other.release.group' });
  equal(second.timers.size, 0);
});
