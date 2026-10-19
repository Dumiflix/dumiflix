function assert(value, message = 'assertion failed') {
  if (!value) throw new Error(message);
}
function equal(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
const appSource = await Deno.readTextFile(new URL('../tv-app/app.js', import.meta.url));
const cacheSource = await Deno.readTextFile(new URL('../tv-app/js/laptopcache.js', import.meta.url));
const start = appSource.indexOf('  function wKey(');
const end = appSource.indexOf('  function paintHeroFromTrending(', start);
assert(start >= 0 && end > start, 'Home source boundaries');
const homeSource = appSource.slice(start, end);
const ytsPlayStart = appSource.indexOf('  async function playYtsMovieInstant(');
const ytsPlayEnd = appSource.indexOf('  // Trending movie click', ytsPlayStart);
assert(ytsPlayStart >= 0 && ytsPlayEnd > ytsPlayStart, 'YTS playback source boundaries');
const ytsPlaySource = appSource.slice(ytsPlayStart, ytsPlayEnd);
const trackerStart = appSource.indexOf('  function bindBackgroundTracker()');
const trackerEnd = appSource.indexOf('  // ---------- Boot intent', trackerStart);
assert(trackerStart >= 0 && trackerEnd > trackerStart, 'focus tracker source boundaries');
const trackerSource = appSource.slice(trackerStart, trackerEnd);
const GiB = 1024 ** 3;
const best = { hash: 'verified-hash', name: 'Good.2026.1080p.WEB-DL', size: 2 * GiB,
  quality: '1080p', seeders: 20, source: 'apibay' };
function item(title, id, kind = 'movie') {
  return { title, tmdb_id: id, kind, year: 2026, poster: title + '.jpg' };
}
function ytsItem(title, id) {
  return { title, id, imdb_code: 'tt' + id, year: 2026, rating: 8,
    medium_cover_image: title + '.jpg', torrents: [{ hash: 'low-quality', quality: '720p', size_bytes: GiB }] };
}
function result(status = 'verified', torrent = best) {
  return { status, best: torrent, checkedAt: 1234 };
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

// Small DOM double that keeps row ordering and the actual tile callbacks.
class Row {
  constructor(title, items = []) {
    this.title = title;
    this.items = items;
    this.children = [];
    this.style = {};
    this.listeners = {};
  }
  set innerHTML(value) {
    assert(value === '');
    this.children.forEach(child => { child.parent = null; });
    this.children = [];
  }
  get firstChild() { return this.children[0] || null; }
  insertBefore(child, before) {
    const index = before ? this.children.indexOf(before) : this.children.length;
    assert(index >= 0, 'reference row must be attached');
    this.children.splice(index, 0, child);
    child.parent = this;
  }
  appendChild(child) { this.insertBefore(child, null); }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  remove() {
    if (this.parent) {
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    }
  }
}
function harness(options = {}) {
  const nodes = {};
  for (const id of ['rows', 'hero-title', 'hero-summary', 'hero-play', 'hero-info', 'bg']) nodes[id] = new Row(id);
  const saved = options.saved || {};
  const timers = [], calls = { laptop: [], phone: [], imdb: [], played: [] };
  const listeners = {};
  const deps = {
    Storage: { get: (k, d) => saved[k] === undefined ? d : saved[k],
      set: (k, v) => { saved[k] = v; }, listContinue: () => [] },
    TMDB: { hasKey: () => true,
      trendingWeek: options.weekFetch || (async () => options.week || []),
      trendingDay: options.dayFetch || (async () => options.day || []),
      popularMovies: options.popularFetch || (async () => []), imdbId: async (id, kind) => {
        calls.imdb.push({ id, kind });
        return options.imdb ? options.imdb(id, kind) : 'tt' + id;
      } },
    YTS: { search: options.ytsFetch || (async (query, opts) => ({ movies: options.yts ? [{ title: opts.sort_by, year: 2026 }] : [] })) },
    Remux: { engine: () => options.engine || 'laptop' },
    LaptopCache: { catalogCheck: async (items, opts) => {
      calls.laptop.push({ items, opts });
      return options.catalog ? options.catalog(items, opts) : { results: items.map(() => result()) };
    } },
    Phone: { hasHost: () => options.phoneHost !== false, checkTorrents: async payload => {
      calls.phone.push(payload);
      return options.phone ? options.phone(payload) : { results: payload.items.map(() => ({ watchable: true, best })) };
    } },
    MAX_FILE_BYTES: 5 * GiB, currentTab: 'home',
    $: selector => nodes[selector.slice(1)], document: { getElementById: id => nodes[id],
      addEventListener: (name, handler) => { listeners[name] = handler; } },
    unobserveTilePosters: () => {}, makeRow: (title, items) => new Row(title, items),
    makeContinueWatchingRow: () => new Row('Continue Watching', [
      { title: 'Saved Movie', onClick: () => calls.played.push('continue') },
    ]),
    playTmdbMovieInstant: it => calls.played.push(it), openTmdbMovie: () => {},
    openTvShow: it => calls.played.push(it), openTmdbTv: it => calls.played.push(it),
    playYtsMovieInstant: options.playYts || (m => calls.played.push(m.title)),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  };
  const api = new Function(...Object.keys(deps), homeSource + trackerSource + `
    return { renderHome, watchableMap, wKey, paintHeroFromTmdb, bindBackgroundTracker, key: HOME_CATALOG_KEY,
      setTab: value => { currentTab = value; } };
  `)(...Object.values(deps));
  return { api, nodes, saved, timers, calls,
    focusRow: (row, name) => {
      const it = row.items[0];
      const tile = { dataset: { heroTitle: it.title, heroSubtitle: it.subtitle },
        closest: () => tile, querySelector: () => null, click: it.onClick };
      const event = { target: tile };
      row.listeners[name](event);
      listeners[name](event);
    },
    titles: () => nodes.rows.children.filter(r => /^Trending/.test(r.title)).flatMap(r => r.items.map(it => it.title)),
    persist: (it, entry = result()) => {
      if (!saved[api.key]) saved[api.key] = {};
      saved[api.key][api.wKey(it)] = { ...entry, item: { ...it }, row: 'week', order: 0 };
    },
  };
}

Deno.test('Home renders only verified titles and attaches the exact movie file to tile and hero taps', async () => {
  const good = item('Good', 1), pending = item('Pending', 2), bad = item('Cam', 3), unknown = item('Unknown', 4);
  const h = harness({ week: [pending, good], day: [bad, unknown],
    catalog: async () => ({ results: [result('pending', null), result(), result('unverified', null)] }) });
  await h.api.renderHome();
  await settle();
  equal(h.titles(), ['Good']);
  equal(good._torrent, best);
  const tile = h.nodes.rows.children.find(r => r.title === 'Trending this week').items[0];
  tile.onClick();
  h.nodes['hero-play'].onclick();
  equal(h.calls.played, [good, good]);
  equal(h.nodes['hero-title'].textContent, 'Good (2026)');
  equal(h.calls.phone.length, 0);
  const stored = h.saved[h.api.key][h.api.wKey(good)];
  equal({ status: stored.status, best: stored.best, checkedAt: stored.checkedAt }, result());
  equal(stored.item.title, good.title);
  equal(stored.row, 'week');
  equal(Object.keys(h.saved[h.api.key]).length, 1);
});

Deno.test('persisted verified set paints before IMDb and catalog requests complete, including after restart', async () => {
  const good = item('Good', 1), fresh = item('Fresh', 2), lookup = deferred();
  const h = harness({ week: [good, fresh], imdb: () => lookup.promise });
  h.persist(good);
  h.persist(fresh, result('pending', null));
  await h.api.renderHome();
  equal(h.titles(), ['Good']);
  equal(h.calls.laptop.length, 0);
  equal(good._torrent, best);
  equal(h.nodes['hero-title'].textContent, 'Good (2026)');
  const restarted = harness({ saved: JSON.parse(JSON.stringify(h.saved)),
    week: [item('Good', 1), item('Fresh', 2)], imdb: () => lookup.promise });
  await restarted.api.renderHome();
  equal(restarted.titles(), ['Good']);
});

Deno.test('saved Home tiles and hero paint synchronously while trending or popular requests stall', async () => {
  const warm = harness({ week: [item('Saved Week', 1)], day: [item('Saved Day', 2)] });
  await warm.api.renderHome();
  await settle();
  for (const stalled of ['trending', 'popular']) {
    const feed = deferred();
    const h = harness({ saved: JSON.parse(JSON.stringify(warm.saved)), yts: true,
      weekFetch: stalled === 'trending' ? () => feed.promise : async () => [item('Fresh', 3)],
      popularFetch: stalled === 'popular' ? () => feed.promise : async () => [] });
    const rendering = h.api.renderHome();
    // No microtask or network response is needed for this first paint.
    equal(h.titles(), ['Saved Week', 'Saved Day']);
    equal(h.nodes['hero-title'].textContent, 'Saved Week (2026)');
    h.nodes['hero-play'].onclick();
    equal(h.calls.played[0]._torrent, best);
    equal(h.nodes.rows.children[2].title, 'Continue Watching');
    await settle();
    equal(h.nodes.rows.children.map(r => r.title), [
      'Trending this week', 'Trending today', 'Continue Watching', 'Highly Rated', 'Just Added',
    ]);
    equal(h.calls.laptop.map(c => c.items.map(it => it.title)), [['rating'], ['date_added']]);
    feed.resolve([]);
    await rendering;
    await settle();
  }
});

Deno.test('Just Added renders independently of a stalled Highly Rated request and retains YTS row order', async () => {
  const feed = deferred(), high = deferred();
  const h = harness({ weekFetch: () => feed.promise,
    ytsFetch: async (query, opts) => opts.sort_by === 'rating' ? high.promise
      : { movies: [{ title: 'New', year: 2026 }] } });
  const rendering = h.api.renderHome();
  await settle();
  equal(h.nodes.rows.children.map(r => r.title), ['Continue Watching', 'Just Added']);
  high.resolve({ movies: [{ title: 'Rated', year: 2026 }] });
  await settle();
  equal(h.nodes.rows.children.map(r => r.title), ['Continue Watching', 'Highly Rated', 'Just Added']);
  feed.resolve([]);
  await rendering;
});

Deno.test('focusing YTS or Continue Watching restores hero controls and the existing tracker callbacks', async () => {
  const reply = deferred();
  const h = harness({ day: [item('Unavailable', 1)], yts: true,
    catalog: items => items[0].tmdb_id ? reply.promise : Promise.resolve({ results: items.map(() => result()) }) });
  h.api.bindBackgroundTracker();
  await h.api.renderHome();
  await settle();
  for (const title of ['Continue Watching', 'Highly Rated', 'Just Added']) {
    const row = h.nodes.rows.children.find(r => r.title === title);
    for (const event of ['dpad-focus', 'focusin']) {
      h.api.paintHeroFromTmdb(null);
      equal(h.nodes['hero-play'].hidden, true);
      equal(h.nodes['hero-info'].onclick, null);
      h.focusRow(row, event);
      equal(h.nodes['hero-play'].hidden, false);
      equal(h.nodes['hero-info'].hidden, false);
      equal(h.nodes['hero-title'].textContent, row.items[0].title);
      h.nodes['hero-play'].onclick();
      h.nodes['hero-info'].onclick();
    }
  }
  equal(h.calls.played, ['continue', 'continue', 'continue', 'continue',
    'rating', 'rating', 'rating', 'rating', 'date_added', 'date_added', 'date_added', 'date_added']);
  reply.resolve({ results: [result('unverified', null)] });
  await settle();
  equal(h.nodes['hero-play'].hidden, false);
  equal(h.nodes['hero-info'].hidden, false);
  equal(h.nodes['hero-title'].textContent, 'date_added');
  h.nodes['hero-play'].onclick();
  equal(h.calls.played[h.calls.played.length - 1], 'date_added');
});

Deno.test('pending titles stay hidden then appear on the single delayed wait_ms retry in the correct row order', async () => {
  const a = item('Week', 1), b = item('Day', 2);
  let count = 0;
  const h = harness({ week: [a], day: [b], yts: true,
    catalog: async items => ({ results: items[0].tmdb_id && ++count === 1
      ? [result('pending', null), result('pending', null)] : items.map(() => result()) }) });
  await h.api.renderHome();
  await settle();
  equal(h.titles(), []);
  equal(h.nodes['hero-play'].hidden, true);
  equal(h.timers.length, 1);
  equal(h.timers[0].ms, 3000);
  h.timers.shift().fn();
  await settle();
  equal(h.titles(), ['Week', 'Day']);
  equal(h.nodes.rows.children.map(r => r.title), ['Trending this week', 'Trending today', 'Continue Watching', 'Highly Rated', 'Just Added']);
  equal(h.calls.laptop.filter(c => c.items[0].tmdb_id).map(c => c.opts.wait_ms), [0, 8000]);
  equal(h.timers.length, 0);
  equal(h.nodes['hero-title'].textContent, 'Week (2026)');
});

Deno.test('titles still pending on retry appear on a later render, without an endless polling loop', async () => {
  let ready = false;
  const h = harness({ day: [item('Later', 1)],
    catalog: async () => ({ results: [result(ready ? 'verified' : 'pending', ready ? best : null)] }) });
  await h.api.renderHome();
  await settle();
  for (let i = 0; i < 6; i++) {
    equal(h.timers.length, 1);
    h.timers.shift().fn();
    await settle();
  }
  equal(h.titles(), []);
  equal(h.calls.laptop.length, 7);
  equal(h.timers.length, 0);
  ready = true;
  await h.api.renderHome();
  await settle();
  equal(h.titles(), ['Later']);
});

Deno.test('laptop unverified, pending, and empty answers never trigger phone fallback', async () => {
  for (const results of [[result('pending', null)], [result('unverified', null)], []]) {
    const h = harness({ day: [item('Hidden', 1)], catalog: async () => ({ results }) });
    await h.api.renderHome();
    await settle();
    equal(h.titles(), []);
    equal(h.calls.phone.length, 0);
  }
});

Deno.test('the phone is never a verifier: without the laptop catalog no trending title is shown', async () => {
  for (const engine of ['laptop', 'phone']) {
    const good = item('Good', 1);
    const h = harness({ week: [good], engine, catalog: async () => { throw new Error('offline'); } });
    await h.api.renderHome();
    await settle();
    equal(h.titles(), []);
    equal(h.calls.laptop.length, engine === 'laptop' ? 1 : 0);
    equal(h.calls.phone.length, 0);
    equal(good._torrent, undefined);
  }
});

Deno.test('catalog request resolves movie and TV IMDb IDs, deduplicates and sends exact contract fields', async () => {
  const movie = item('Good', 1), tv = item('Show', 2, 'tv');
  const h = harness();
  await h.api.watchableMap([movie, { ...movie }, tv]);
  equal(h.calls.laptop[0], { items: [
    { title: 'Good', year: 2026, kind: 'movie', imdb: 'tt1', tmdb_id: 1 },
    { title: 'Show', year: 2026, kind: 'tv', imdb: 'tt2', tmdb_id: 2 },
  ], opts: { max_bytes: 5 * GiB, wait_ms: 0 } });
  equal(h.calls.imdb, [{ id: 1, kind: 'movie' }, { id: 2, kind: 'tv' }]);
  assert(h.api.wKey(movie) !== h.api.wKey({ ...movie, year: 1984 }));
  assert(h.api.wKey(movie) !== h.api.wKey({ ...movie, kind: 'tv' }));
  equal(h.api.wKey(movie), h.api.wKey({ ...movie, _imdb: 'tt-new-lookup' }));
});

Deno.test('failed IMDb lookup still checks the catalog using title, year and TMDB identity', async () => {
  const h = harness({ imdb: async () => { throw new Error('TMDB offline'); } });
  await h.api.watchableMap([item('Good', 1)]);
  equal(h.calls.laptop[0].items[0].imdb, null);
  equal(h.calls.laptop[0].items[0].tmdb_id, 1);
});

Deno.test('verified TV may have no best, while a verified movie without a file stays hidden', async () => {
  const movie = item('No file', 1), tv = item('Show', 2, 'tv');
  const h = harness({ week: [movie], day: [tv], catalog: async () => ({ results: [result('verified', null), result('verified', null)] }) });
  await h.api.renderHome();
  await settle();
  equal(h.titles(), ['Show']);
  equal(h.nodes['hero-title'].textContent, 'Show (2026)');
  equal(tv._torrent, undefined);
});

Deno.test('fresh unverified results evict saved titles and clear the stale hero and torrent', async () => {
  const good = item('Good', 1), reply = deferred();
  const h = harness({ week: [good], catalog: () => reply.promise });
  h.persist(good);
  await h.api.renderHome();
  equal(h.titles(), ['Good']);
  reply.resolve({ results: [result('unverified', null)] });
  await settle();
  equal(h.titles(), []);
  equal(h.saved[h.api.key], {});
  equal(good._torrent, undefined);
  equal(h.nodes['hero-play'].hidden, true);
  equal(h.nodes['hero-play'].onclick, null);
  equal(h.nodes.bg.style.backgroundImage, '');
});

Deno.test('offline cold start shows no unverified trending rows and no hero', async () => {
  const h = harness({ day: [item('Offline', 1)], catalog: async () => { throw new Error('offline'); },
    phone: async () => { throw new Error('offline'); } });
  await h.api.renderHome();
  await settle();
  equal(h.titles(), []);
  equal(h.nodes['hero-title'].textContent, 'Welcome to DumiFlix');
  equal(h.nodes['hero-play'].hidden, true);
  equal(h.nodes['hero-info'].onclick, null);
  equal(h.saved[h.api.key], undefined);
});

Deno.test('offline with a saved set keeps only saved verified titles', async () => {
  const good = item('Good', 1);
  const h = harness({ day: [good, item('Unknown', 2)], catalog: async () => { throw new Error('offline'); }, phoneHost: false });
  h.persist(good);
  await h.api.renderHome();
  await settle();
  equal(h.titles(), ['Good']);
  equal(h.nodes['hero-title'].textContent, 'Good (2026)');
});

Deno.test('a superseded render or departed Home ignores old catalog responses and pending timers', async () => {
  const firstReply = deferred();
  let count = 0;
  const h = harness({ day: [item('Good', 1)],
    catalog: () => ++count === 1 ? firstReply.promise : Promise.resolve({ results: [result()] }) });
  await h.api.renderHome();
  await h.api.renderHome();
  await settle();
  firstReply.resolve({ results: [result('unverified', null)] });
  await settle();
  equal(h.titles(), ['Good']);
  const pending = harness({ day: [item('Later', 2)], catalog: async () => ({ results: [result('pending', null)] }) });
  await pending.api.renderHome();
  await settle();
  pending.api.setTab('library');
  pending.timers.shift().fn();
  await settle();
  equal(pending.calls.laptop.length, 1);
});

Deno.test('YTS Home rows hide unverified files, preserve verified order and send IMDb identities directly', async () => {
  const high = [ytsItem('Cam', 1), ytsItem('First Rated', 2), ytsItem('Pending', 3),
    ytsItem('Second Rated', 4), ytsItem('Missing File', 5)];
  const fresh = [ytsItem('First New', 6), ytsItem('720p Only', 7), ytsItem('Second New', 8)];
  const verified = new Set(['tt2', 'tt4', 'tt6', 'tt8']);
  const h = harness({ ytsFetch: async (query, opts) => ({ movies: opts.sort_by === 'rating' ? high : fresh }),
    catalog: async items => ({ results: items.map(it => verified.has(it.imdb) ? result()
      : result(it.imdb === 'tt3' ? 'pending' : it.imdb === 'tt5' ? 'verified' : 'unverified', null)) }) });
  await h.api.renderHome();
  await settle();
  equal(h.nodes.rows.children.map(r => [r.title, r.items.map(it => it.title)]), [
    ['Continue Watching', ['Saved Movie']], ['Highly Rated', ['First Rated', 'Second Rated']],
    ['Just Added', ['First New', 'Second New']],
  ]);
  equal(h.calls.laptop.map(c => c.items), [high, fresh].map(movies => movies.map(m => ({
    title: m.title, year: 2026, kind: 'movie', imdb: m.imdb_code, tmdb_id: null,
  }))));
  equal(h.calls.imdb, []);
});

Deno.test('YTS Home omits empty verified rows and hides both rows when the laptop is unavailable', async () => {
  for (const mode of ['unverified', 'missing-file', 'empty', 'offline', 'phone']) {
    const h = harness({ yts: true, engine: mode === 'phone' ? 'phone' : 'laptop',
      catalog: async items => {
        if (mode === 'offline') throw new Error('offline');
        return { results: mode === 'empty' ? [] : items.map(() => result(
          mode === 'missing-file' ? 'verified' : 'unverified', null)) };
      } });
    await h.api.renderHome();
    await settle();
    equal(h.nodes.rows.children.map(r => r.title), ['Continue Watching']);
    equal(h.calls.phone, []);
    equal(h.timers.length, 0);
  }
});

Deno.test('same-title YTS movies with different IMDb IDs cannot share verification', async () => {
  const first = ytsItem('Same Title', 1), second = { ...ytsItem('Same Title', 2), medium_cover_image: 'second.jpg' };
  const playback = ytsPlaybackHarness();
  const h = harness({ playYts: playback.play,
    ytsFetch: async (query, opts) => ({ movies: opts.sort_by === 'rating' ? [first, second] : [] }),
    catalog: async items => ({ results: items.map(it => it.imdb === first.imdb_code
      ? result() : result('unverified', null)) }) });
  await h.api.renderHome();
  await settle();
  equal(h.calls.laptop[0].items.map(it => it.imdb), [first.imdb_code, second.imdb_code]);
  const row = h.nodes.rows.children.find(r => r.title === 'Highly Rated');
  equal(row.items.map(it => it.poster), [first.medium_cover_image]);
  await row.items[0].onClick();
  equal(playback.calls.queued.map(q => q.infoHash), [best.hash]);
});

Deno.test('same-title YTS movies keep separate verified hashes through the pending retry', async () => {
  const first = ytsItem('Same Title', 1), second = { ...ytsItem('Same Title', 2), medium_cover_image: 'second.jpg' };
  const secondBest = { ...best, hash: 'second-verified-hash' };
  const playback = ytsPlaybackHarness();
  const h = harness({ playYts: playback.play,
    ytsFetch: async (query, opts) => ({ movies: opts.sort_by === 'date_added' ? [first, second] : [] }),
    catalog: async (items, opts) => ({ results: items.map(it => it.imdb === first.imdb_code
      ? result() : opts.wait_ms ? result('verified', secondBest) : result('pending', null)) }) });
  await h.api.renderHome();
  await settle();
  equal(h.calls.laptop[0].items.map(it => it.imdb), [first.imdb_code, second.imdb_code]);
  equal(h.nodes.rows.children.find(r => r.title === 'Just Added').items.map(it => it.poster), [first.medium_cover_image]);
  equal(h.timers.map(t => t.ms), [3000]);
  h.timers.pop().fn();
  await settle();
  equal(h.calls.laptop[1].items.map(it => it.imdb), [first.imdb_code, second.imdb_code]);
  const row = h.nodes.rows.children.find(r => r.title === 'Just Added');
  equal(row.items.map(it => it.poster), [first.medium_cover_image, second.medium_cover_image]);
  for (const tile of row.items) await tile.onClick();
  equal(playback.calls.queued.map(q => q.infoHash), [best.hash, secondBest.hash]);
  equal(playback.calls.picks, []);
});

Deno.test('a stalled YTS catalog does not delay trending or the other YTS row', async () => {
  const high = deferred();
  const h = harness({ week: [item('Week', 1)], day: [item('Day', 2)], yts: true,
    catalog: async items => items[0].title === 'rating' ? high.promise : { results: items.map(() => result()) } });
  await h.api.renderHome();
  await settle();
  equal(h.nodes.rows.children.map(r => r.title), ['Trending this week', 'Trending today', 'Continue Watching', 'Just Added']);
  high.resolve({ results: [result()] });
  await settle();
  equal(h.nodes.rows.children.map(r => r.title), [
    'Trending this week', 'Trending today', 'Continue Watching', 'Highly Rated', 'Just Added',
  ]);
});

Deno.test('pending YTS rows get one 3-second retry with wait_ms and preserve Home and tile order', async () => {
  const high = [ytsItem('First Rated', 1), ytsItem('Second Rated', 2)], fresh = [ytsItem('New', 3)];
  const h = harness({ day: [item('Trending', 10)],
    ytsFetch: async (query, opts) => ({ movies: opts.sort_by === 'rating' ? high : fresh }),
    catalog: async (items, opts) => ({ results: items.map(it => it.tmdb_id || opts.wait_ms
      ? result() : result('pending', null)) }) });
  await h.api.renderHome();
  await settle();
  equal(h.nodes.rows.children.map(r => r.title), ['Trending today', 'Continue Watching']);
  equal(h.timers.map(t => t.ms), [3000, 3000]);
  // Just Added verifies before Highly Rated, even though its retry was scheduled second.
  h.timers.pop().fn();
  await settle();
  equal(h.nodes.rows.children.map(r => r.title), ['Trending today', 'Continue Watching', 'Just Added']);
  h.timers.pop().fn();
  await settle();
  equal(h.nodes.rows.children.map(r => [r.title, r.items.map(it => it.title)]), [
    ['Trending today', ['Trending']], ['Continue Watching', ['Saved Movie']],
    ['Highly Rated', ['First Rated', 'Second Rated']], ['Just Added', ['New']],
  ]);
  equal(h.calls.laptop.filter(c => !c.items[0].tmdb_id).map(c => c.opts.wait_ms), [0, 0, 8000, 8000]);
  equal(h.timers.length, 0);
});

Deno.test('YTS titles still pending after every retry stay hidden, with polling capped', async () => {
  const h = harness({ yts: true, catalog: async items => ({ results: items.map(() => result('pending', null)) }) });
  await h.api.renderHome();
  await settle();
  for (let i = 0; i < 6; i++) {
    equal(h.timers.length, 2);
    h.timers.splice(0).forEach(t => t.fn());
    await settle();
  }
  equal(h.nodes.rows.children.map(r => r.title), ['Continue Watching']);
  equal(h.calls.laptop.map(c => c.opts.wait_ms), [0, 0].concat(Array(12).fill(8000)));
  equal(h.timers.length, 0);
});

Deno.test('a YTS row pending on the first retry appears once a later retry verifies it', async () => {
  let checks = 0;
  const h = harness({ yts: true, catalog: async items => {
    checks++;
    return { results: items.map(() => checks > 4 ? result() : result('pending', null)) };
  } });
  await h.api.renderHome();
  await settle();
  h.timers.splice(0).forEach(t => t.fn());
  await settle();
  equal(h.nodes.rows.children.map(r => r.title), ['Continue Watching']);
  h.timers.splice(0).forEach(t => t.fn());
  await settle();
  equal(h.nodes.rows.children.map(r => r.title), ['Continue Watching', 'Highly Rated', 'Just Added']);
  equal(h.timers.length, 0);
});

Deno.test('YTS ignores superseded catalog replies and retry replies after leaving Home', async () => {
  const oldReply = deferred();
  let count = 0;
  const h = harness({ yts: true, catalog: async items => ++count <= 2 ? oldReply.promise
    : { results: items.map(() => result()) } });
  await h.api.renderHome();
  await h.api.renderHome();
  await settle();
  oldReply.resolve({ results: [result('pending', null)] });
  await settle();
  equal(h.nodes.rows.children.map(r => r.title), ['Continue Watching', 'Highly Rated', 'Just Added']);
  equal(h.timers.length, 0);

  const retryReply = deferred();
  const pending = harness({ yts: true, catalog: async (items, opts) => opts.wait_ms ? retryReply.promise
    : { results: items.map(() => result('pending', null)) } });
  await pending.api.renderHome();
  await settle();
  pending.timers.pop().fn();
  await settle();
  pending.api.setTab('library');
  pending.timers.pop().fn();
  retryReply.resolve({ results: [result()] });
  await settle();
  equal(pending.nodes.rows.children.map(r => r.title), ['Continue Watching']);
  equal(pending.calls.laptop.map(c => c.opts.wait_ms), [0, 0, 8000]);
});

Deno.test('YTS search replies after leaving Home do not start catalog requests or paint tiles', async () => {
  const feed = deferred();
  const h = harness({ ytsFetch: () => feed.promise });
  const rendering = h.api.renderHome();
  h.api.setTab('library');
  feed.resolve({ movies: [ytsItem('Stale', 1)] });
  await rendering;
  await settle();
  equal(h.nodes.rows.children.map(r => r.title), ['Continue Watching']);
  equal(h.calls.laptop, []);
});

function ytsPlaybackHarness(options = {}) {
  const calls = { queued: [], details: [], picks: [], magnets: [] };
  const deps = {
    YTS: { detail: async id => { calls.details.push(id); return { movie: options.detail }; },
      magnet: t => { calls.magnets.push(t); return 'magnet:' + t.hash; } },
    pickBestTorrent: torrents => { calls.picks.push(torrents); return torrents[0]; },
    showLoading: () => {}, hideLoading: () => {}, playLocalCopyIfPresent: async () => false,
    openMovieModal: () => {}, toast: () => {}, addToQueue: q => { calls.queued.push(q); },
  };
  const play = new Function(...Object.keys(deps), ytsPlaySource + '; return playYtsMovieInstant;')(...Object.values(deps));
  return { calls, play };
}

Deno.test('verified YTS tile taps use the catalog hash for YTS, ApiBay and Knaben releases, bypassing the picker', async () => {
  for (const source of ['yts', 'apibay', 'knaben']) {
    const m = ytsItem('Verified Movie', 1);
    const verified = { ...best, source };
    // A YTS match retains torrent metadata; other sources need no YTS match.
    if (source === 'yts') m.torrents.push({ hash: verified.hash.toUpperCase(), quality: '1080p', size_bytes: 2 * GiB });
    const playback = ytsPlaybackHarness();
    const h = harness({ playYts: playback.play,
      ytsFetch: async (query, opts) => ({ movies: opts.sort_by === 'rating' ? [m] : [] }),
      catalog: async () => ({ results: [result('verified', verified)] }) });
    await h.api.renderHome();
    await settle();
    await h.nodes.rows.children.find(r => r.title === 'Highly Rated').items[0].onClick();
    equal(playback.calls.queued.length, 1);
    equal(playback.calls.queued[0].infoHash.toLowerCase(), verified.hash);
    equal(playback.calls.queued[0].magnet.toLowerCase(), 'magnet:' + verified.hash);
    equal(playback.calls.queued[0].sizeBytes, verified.size);
    equal(playback.calls.queued[0].autoplay, true);
    equal(playback.calls.details, []);
    equal(playback.calls.picks, []);
    equal(playback.calls.magnets[0], source === 'yts' ? m.torrents[1] : verified);
  }
});

Deno.test('YTS playback without a verified torrent keeps the existing detail lookup and picker', async () => {
  const stub = ytsItem('Search Movie', 1), detail = { ...stub, runtime: 120 };
  const h = ytsPlaybackHarness({ detail });
  await h.play(stub);
  equal(h.calls.details, [stub.id]);
  equal(h.calls.picks, [detail.torrents]);
  equal(h.calls.queued[0].infoHash, 'low-quality');
  equal(h.calls.queued[0].durationSeconds, 7200);
});

function cacheHarness(fetch, config = {}) {
  const timers = [], cleared = [];
  const api = new Function('Storage', 'fetch', 'setTimeout', 'clearTimeout', cacheSource + '; return LaptopCache;')(
    { get: (k, d) => ({ 'remux.laptopHost': 'laptop:8765', 'remux.laptopToken': 'test-token', ...config })[k] || d },
    fetch, (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, id => cleared.push(id));
  return { api, timers, cleared };
}
Deno.test('LaptopCache catalogCheck posts authenticated contract JSON and bounds wait_ms with a matching timeout', async () => {
  const calls = [], reply = { results: [result()] };
  const h = cacheHarness(async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => reply }; });
  const items = [{ title: 'Good', year: 2026, kind: 'movie', imdb: 'tt1', tmdb_id: 1 }];
  equal(await h.api.catalogCheck(items, { max_bytes: GiB, wait_ms: 99999 }), reply);
  equal(calls[0].url, 'http://laptop:8765/catalog/check');
  equal(calls[0].opts.method, 'POST');
  equal(calls[0].opts.headers, { 'Content-Type': 'application/json', 'X-Playback-Token': 'test-token' });
  equal(JSON.parse(calls[0].opts.body), { items, max_bytes: GiB, wait_ms: 8000 });
  equal(h.timers[0].ms, 13000);
  equal(h.cleared, [1]);
  await h.api.catalogCheck(items, { wait_ms: -1 });
  equal(JSON.parse(calls[1].opts.body), { items, max_bytes: 5 * GiB, wait_ms: 0 });
});

Deno.test('LaptopCache catalog failures reject for fallback and always clear their timeout', async () => {
  for (const fetch of [
    async () => { throw new Error('offline'); },
    async () => ({ ok: false, status: 503 }),
    async () => ({ ok: true, json: async () => ({}) }),
  ]) {
    const h = cacheHarness(fetch);
    let threw = false;
    try { await h.api.catalogCheck([]); } catch (_) { threw = true; }
    assert(threw);
    equal(h.cleared, [1]);
  }
});

Deno.test('LaptopCache catalog uses the shared token fallback and preserves an explicit host scheme', async () => {
  let received;
  const h = cacheHarness(async (url, opts) => { received = { url, opts }; return { ok: true, json: async () => ({ results: [] }) }; },
    { 'remux.laptopHost': 'https://laptop', 'remux.laptopToken': '', 'remux.token': 'shared-test-token' });
  await h.api.catalogCheck([]);
  equal(received.url, 'https://laptop/catalog/check');
  equal(received.opts.headers['X-Playback-Token'], 'shared-test-token');
});
