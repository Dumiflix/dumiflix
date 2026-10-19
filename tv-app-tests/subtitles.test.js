function equal(a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function assert(v, message = 'assertion failed') { if (!v) throw new Error(message); }
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
const app = await Deno.readTextFile(new URL('../tv-app/app.js', import.meta.url));
const opensubs = await Deno.readTextFile(new URL('../tv-app/js/opensubs.js', import.meta.url));
function section(start, end) {
  const a = app.indexOf(start), b = app.indexOf(end, a);
  assert(a >= 0 && b > a, 'missing source section ' + start);
  return app.slice(a, b);
}
function srt(n = 150, step = 12) {
  function stamp(t) { return [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60].map(x => String(x).padStart(2, '0')).join(':') + ',000'; }
  return Array.from({ length: n }, (_, i) => `${i + 1}\n${stamp(i * step)} --> ${stamp(i * step + 1)}\nDialogue ${i}\n`).join('\n');
}
function result(id, attrs = {}) {
  return { attributes: { moviehash_match: true, release: 'Movie.1080p.WEB-DL',
    feature_details: { imdb_id: 123 }, files: [{ file_id: id, file_name: id + '.srt' }], ...attrs } };
}
function provider(rows, contents = {}, cache = {}) {
  const calls = [], data = { opensubsKey: 'test-api-key', opensubsCache: cache };
  const api = new Function('Storage', 'fetch', opensubs + '; return OpenSubs;')({
    get: (k, fallback) => data[k] || fallback, set: (k, v) => { data[k] = v; },
  }, async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('/subtitles?')) return { ok: true, json: async () => ({ data: typeof rows === 'function' ? rows(url) : rows }) };
    if (url.endsWith('/download')) return { ok: true, json: async () => ({ link: 'https://subs/' + JSON.parse(init.body).file_id }) };
    if (url.startsWith('https://subs/')) return { ok: true, arrayBuffer: async () => new TextEncoder().encode(contents[url.split('/').pop()] || srt()).buffer };
    return { status: 206, headers: { get: () => 'bytes 0-65535/131072' }, arrayBuffer: async () => new ArrayBuffer(65536) };
  });
  return { api, calls, data };
}

Deno.test('subtitles: metadata-only hashing opens no media reader; local hashing still works', async () => {
  const h = provider([]);
  equal(await h.api.movieHashFromUrl('https://seedr/movie', { metadataOnly: true }), null);
  equal(h.calls.length, 0);
  equal((await h.api.movieHashFromUrl('http://laptop/cache/stream/movie')).moviebytesize, 131072);
  equal(h.calls.length, 2);
});

for (const mode of ['episode', 'movie', 'title']) {
  Deno.test('subtitles: ' + mode + ' mismatch fails closed for automatic and manual searches', async () => {
    const row = result('wrong', { feature_details: { imdb_id: 999, season_number: 1, episode_number: 2, parent_title: 'Other Show' } });
    const params = mode === 'episode' ? { imdbId: 'tt123', season: 1, episode: 1 }
      : mode === 'movie' ? { imdbId: 'tt123' } : { query: 'Wanted Show', season: 1, episode: 2 };
    const h = provider([row]);
    equal(await h.api.findFor(params), null);
    equal(await h.api.findCandidates(params), []);
    assert(!h.calls.some(c => c.url.endsWith('/download')));
  });
}

for (const attrs of [{ foreign_parts_only: true }, { forced: true }, { release: 'Movie FORCED' },
  { files: [{ file_id: 'partial', file_name: 'foreign-parts-only.srt' }] },
  { files: [{ file_id: 'partial', file_name: 'Movie_EN_forced.srt' }] }]) {
  Deno.test('subtitles: hash picker rejects partial track ' + JSON.stringify(attrs), async () => {
    const h = provider([result('partial', { ...attrs, from_trusted: true, download_count: 99999 }), result('full')]);
    equal((await h.api.findExactByHash({ moviehash: 'abc' })).name, 'full.srt');
    equal((await h.api.findReferenceByHash({ moviehash: 'abc' })).name, 'full.srt');
    assert(h.calls.filter(c => c.url.endsWith('/download')).every(c => JSON.parse(c.init.body).file_id === 'full'));
  });
}

Deno.test('subtitles: partial-only hash results never download or attach', async () => {
  const h = provider([result('partial', { foreign_parts_only: true })]);
  equal(await h.api.findExactByHash({ moviehash: 'abc' }), null);
  equal(await h.api.findReferenceByHash({ moviehash: 'abc' }), null);
  assert(!h.calls.some(c => c.url.endsWith('/download')));
});

for (const text of [srt(5), srt(150, 1)]) {
  Deno.test('subtitles: sparse/clustered hash content and legacy cache fail coverage check (' + text.length + ')', async () => {
    const cache = { 'hash:abc:en': { name: 'old.srt', text }, 'ref:abc': { name: 'old.srt', text } };
    const h = provider([result('bad')], { bad: text }, cache);
    equal(await h.api.findExactByHash({ moviehash: 'abc' }, 'en', { duration: 1800 }), null);
    equal(await h.api.findReferenceByHash({ moviehash: 'abc' }, { duration: 1800 }), null);
    equal(h.data.opensubsCache, {});
  });
}

const pipeline = section('    const subtitleVideo = currentVideo;', '    // Track lists are recreated');
const resolver = section('  async function resolveBestSubtitle(', '  // Returns true if the <video>');
function playback(options = {}) {
  const cv = { fileId: 'seedr1', src: 'https://seedr/movie', source: 'seedr', _directSeedr: true, ...options.cv };
  const calls = { attached: [], finder: [], sync: [], fetched: [], backends: [], states: [], embedded: [] }, timers = [];
  const cc = { dataset: {} };
  const cache = { PFX: 'VPSCACHE::', isCacheId: id => id.startsWith('VPSCACHE::'),
    subsState: async id => { calls.states.push(id); return { state: 'none' }; },
    startSync: async (id, args) => { calls.sync.push({ id, args }); return { state: 'none' }; },
  };
  const env = { initial: cv, subtitleMeta: options.subtitle || null, isLive: false, isAudio: false,
    fileId: cv.fileId, src: cv.src, title: 'Movie.mkv', meta: {}, show: null, v: {}, ccEl: cc,
    playbackResumeClock: () => ({ duration: options.duration || 1800 }),
    Phone: { hasHost: () => true, base: () => 'http://laptop',
      subsync: async () => { throw new Error('wrong sync engine'); },
      embeddedSubs: args => { calls.embedded.push(args); return Promise.resolve(null); } },
    Remux: { hasSession: () => false, engine: () => 'laptop', availableFor: () => true,
      subsync: async url => { calls.sync.push(url); return options.alignment ? options.alignment.promise : { ok: true, reliable: true, offset: 2 }; } },
    LaptopCache: cache, _PLAYER_HTTPS_RE: /^https?:/, _PLAYER_EPISODE_RE: /S\d+E\d+/,
    storeFor: id => { calls.backends.push(id); return { fetchText: async id => { calls.fetched.push(id); if (options.fetchFail) throw new Error('missing'); return srt(); } }; },
    parseSrtCues: text => Array.from({ length: text.split('-->').length - 1 }, () => ({})),
    resolveBestSubtitle: async (url, filename, show, opts) => {
      calls.finder.push({ url, opts });
      return options.finder ? options.finder(url, opts) : { name: 'external.srt', _content: srt(), _syncedBy: options.syncedBy };
    },
    attachSubtitle: (v, sub) => calls.attached.push(sub), pToast() {},
    loadPersistedSubOffset: () => null, savePersistedSubOffset() {},
    pollLaptopSubState: () => ({ stop() {} }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  };
  const api = new Function(...Object.keys(env), `let currentVideo = initial; ${pipeline}
    return { replace: cv => { currentVideo = cv; } };`)(...Object.values(env));
  return { cv, calls, cc, cache, api, timers,
    local(growing = false) { Object.assign(cv, { fileId: 'VPSCACHE::movie', src: 'http://laptop/cache/stream/movie', source: 'laptop', _directSeedr: false, _growingCache: growing }); },
    tick() { const t = timers.shift(); assert(t); t.fn(); },
  };
}

Deno.test('subtitles: Seedr playback uses metadata without invoking audio alignment', async () => {
  const h = playback(); await flush();
  equal(h.calls.finder[0].opts, { metadataOnly: true, duration: 1800 });
  equal(h.calls.sync, []); equal(h.calls.attached.length, 1);
});

Deno.test('subtitles: finder passes metadata-only policy into movie hashing', async () => {
  const h = provider([]);
  const find = new Function('OpenSubs', 'fetchOpenSubsFallback', resolver + '; return resolveBestSubtitle;')(
    h.api, async () => ({ name: 'metadata.srt', _content: srt() }));
  equal((await find('https://seedr/movie', 'Movie', null, { metadataOnly: true })).name, 'metadata.srt');
  equal(h.calls.length, 0);
});

Deno.test('subtitles: sibling discovery survives growing and completed identity handoffs', async () => {
  const pending = deferred(), h = playback({ subtitle: pending.promise });
  h.local(true); pending.resolve({ fileId: 'sidecar', name: 'movie.srt' }); await flush();
  equal(h.calls.fetched, ['sidecar']); equal(h.calls.attached.length, 1);
  equal(h.calls.sync, []); h.tick(); await flush(); equal(h.calls.states, []);
  h.local(); h.tick(); await flush();
  equal(h.calls.states, ['VPSCACHE::movie']);
  equal(h.calls.sync[1].args.srt, srt());
  equal(h.calls.attached.length, 2);
});

Deno.test('subtitles: completed handoff supersedes an awaiting metadata lookup once', async () => {
  const pending = deferred(), h = playback({ finder: () => pending.promise });
  await flush(); h.local(); h.tick(); await flush();
  pending.resolve({ name: 'external.srt', _content: srt() }); await flush();
  equal(h.calls.attached.length, 1);
  equal(h.calls.finder.map(c => c.url), ['https://seedr/movie', 'http://laptop/cache/stream/movie']);
  equal(h.timers.length, 0);
});

Deno.test('subtitles: in-flight alignment accepts same playback object after file-id handoff', async () => {
  const alignment = deferred(), h = playback({ cv: { _directSeedr: false, source: 'cache', src: 'http://laptop/files/stream/movie' }, alignment });
  await flush(); h.local(); alignment.resolve({ ok: true, reliable: true, offset: 2 }); await flush();
  equal(h.calls.attached.length, 1);
});

Deno.test('subtitles: failed laptop sidecar fetch falls back to OpenSubtitles', async () => {
  const h = playback({ cv: { fileId: 'VPSCACHE::movie', _directSeedr: false }, subtitle: { fileId: 'sidecar', name: 'movie.srt' }, fetchFail: true });
  await flush(); equal(h.calls.fetched, ['sidecar']); equal(h.calls.finder.length, 1);
  equal(h.calls.attached[0].name, 'external.srt');
  equal(h.calls.sync[1].args.srt, srt());
});

Deno.test('subtitles: reference-aligned candidates attach immediately', async () => {
  const h = playback({ syncedBy: 'reference' }); await flush();
  equal(h.calls.attached.length, 1); equal(h.calls.sync, []); equal(h.cc.dataset.state, 'on');
});

Deno.test('subtitles: closed or replaced playback cannot receive pending discovery/alignment', async () => {
  for (const replacement of [null, { fileId: 'seedr1' }]) {
    const pending = deferred(), h = playback({ subtitle: pending.promise });
    h.api.replace(replacement); pending.resolve({ name: 'old.srt', _content: srt() }); await flush();
    equal(h.calls.attached, []); h.tick(); equal(h.timers.length, 0);
  }
});

Deno.test('subtitles: manual downloads recheck ownership after close or next, including failures', async () => {
  const picker = section('  async function openOpenSubsPicker()', '  function openMenu(');
  for (const replacement of [null, { fileId: 'next' }]) for (const fail of [false, true]) {
    const pending = deferred(), rows = [], effects = [], cv = { title: 'Movie.mkv' };
    const el = { dataset: {}, appendChild() {} }, video = { querySelectorAll: () => { effects.push('detach'); return []; } };
    const env = { initial: cv, $: id => id === '#video' ? video : el,
      inferShowFromTitle: () => null, Trending: { cleanTitle: x => x }, _EXT_RE: /\.[^.]+$/, _YEAR_RE: /\b(20\d\d)\b/,
      OpenSubs: { findCandidates: async () => [{ label: 'Full', result: {} }], getContent: () => pending.promise },
      showOverlay() {}, document: { createDocumentFragment: () => el },
      addMenuItem: (_list, label, fn) => { if (label === 'Full') rows.push(fn); },
      requestAnimationFrame() {}, DPad: {}, buildMenu() {}, URL: {},
      attachSubtitle: () => effects.push('attach'), toast: () => effects.push('toast'), closeMenu: () => effects.push('close'),
    };
    const api = new Function(...Object.keys(env), `let currentVideo = initial, activeMenu; ${picker}
      return { open: openOpenSubsPicker, replace: cv => { currentVideo = cv; } };`)(...Object.values(env));
    await api.open(); const work = rows[0](); api.replace(replacement);
    if (fail) pending.reject(new Error('download failed')); else pending.resolve({ name: 'old.srt', text: srt() });
    await work; equal(effects, []);
  }
});

Deno.test('subtitles: Drive id-only sidecars fetch from the right backend and remain the selected subtitle', async () => {
  const h = playback({ cv: { fileId: 'drive-movie', _directSeedr: false, source: 'drive' },
    subtitle: { id: 'drive-sub', name: 'movie.en.srt' } });
  await flush();
  equal(h.calls.backends, ['drive-sub']); equal(h.calls.fetched, ['drive-sub']);
  equal(h.calls.finder, []); equal(h.calls.attached[0].fileId, 'drive-sub');
});

for (const [duration, text] of [[60, srt(5)], [240, srt(20)], [1800, srt(30, 60)]]) {
  Deno.test('subtitles: full hash subtitles use runtime rather than fixed cue/span minimums (' + duration + 's)', async () => {
    const h = provider([result('full')], { full: text });
    const opts = { duration };
    equal((await h.api.findExactByHash({ moviehash: 'abc' }, 'en', opts)).text, text);
    equal((await h.api.findReferenceByHash({ moviehash: 'abc' }, opts)).text, text);
    // A previously downloaded short/full track must also survive cache reuse.
    equal((await h.api.findExactByHash({ moviehash: 'abc' }, 'en', opts)).text, text);
    equal((await h.api.findReferenceByHash({ moviehash: 'abc' }, opts)).text, text);
    equal(h.calls.filter(c => c.url.endsWith('/download')).length, 1);
  });
}

Deno.test('subtitles: unknown runtime does not imply a feature-length title', async () => {
  const text = srt(5), h = provider([result('short')], { short: text });
  equal((await h.api.findExactByHash({ moviehash: 'abc' })).text, text);
  equal((await h.api.findReferenceByHash({ moviehash: 'abc' })).text, text);
});

Deno.test('subtitles: hash lookups skip a popular unmarked partial and share all downloaded content', async () => {
  const h = provider([result('partial', { from_trusted: true, download_count: 99999 }), result('full')], { partial: srt(5) });
  const opts = { duration: 1800 };
  equal((await h.api.findExactByHash({ moviehash: 'abc' }, 'en', opts)).name, 'full.srt');
  equal((await h.api.findReferenceByHash({ moviehash: 'abc' }, opts)).name, 'full.srt');
  equal(h.calls.filter(c => c.url.endsWith('/download')).map(c => JSON.parse(c.init.body).file_id), ['partial', 'full']);
});

Deno.test('subtitles: an exact-search rejection is reused when reference search has another valid language', async () => {
  const partial = result('partial', { from_trusted: true });
  const h = provider(url => url.includes('languages=en') ? [partial] : [partial, result('french')], { partial: srt(5) });
  const opts = { duration: 1800 };
  equal(await h.api.findExactByHash({ moviehash: 'abc' }, 'en', opts), null);
  equal((await h.api.findReferenceByHash({ moviehash: 'abc' }, opts)).name, 'french.srt');
  equal(h.calls.filter(c => c.url.endsWith('/download')).map(c => JSON.parse(c.init.body).file_id), ['partial', 'french']);
});

for (const title of ['Forced to Fight', 'Forced', 'Foreign Parts Only']) {
  Deno.test('subtitles: feature-title words are not mistaken for subtitle flavor (' + title + ')', async () => {
    const name = title.replace(/ /g, '.') + '.2011.en.srt';
    const attrs = { release: name, feature_details: { title }, files: [{ file_id: 'full', file_name: name }] };
    const h = provider([result('full', attrs)]), opts = { duration: 1800 };
    equal((await h.api.findExactByHash({ moviehash: 'abc' }, 'en', opts)).name, name);
    equal((await h.api.findReferenceByHash({ moviehash: 'abc' }, opts)).name, name);
    // The cached name is validated with its saved feature title as well.
    equal((await h.api.findExactByHash({ moviehash: 'abc' }, 'en', opts)).name, name);
  });
}

Deno.test('subtitles: Forced to Fight remains eligible even when old results lack a feature title', async () => {
  const name = 'Forced.to.Fight.2011.en.srt';
  const h = provider([result('full', { release: name, files: [{ file_id: 'full', file_name: name }] })]);
  equal((await h.api.findExactByHash({ moviehash: 'abc' }, 'en', { duration: 1800 })).name, name);
});

Deno.test('subtitles: title-aware flavor filtering still rejects actual forced tags after the title', async () => {
  const title = 'Forced to Fight';
  const h = provider([result('partial', { from_trusted: true, feature_details: { title }, release: 'Forced.to.Fight.2011.FORCED.1080p' }),
    result('full', { feature_details: { title }, release: 'Forced.to.Fight.2011.1080p' })]);
  equal((await h.api.findExactByHash({ moviehash: 'abc' }, 'en', { duration: 1800 })).name, 'full.srt');
  equal(h.calls.filter(c => c.url.endsWith('/download')).map(c => JSON.parse(c.init.body).file_id), ['full']);
});

Deno.test('subtitles: resolver carries runtime and filename into exact and reference validation', async () => {
  const seen = [];
  const api = { hasApiKey: () => true, movieHashFromUrl: async () => ({ moviehash: 'abc' }),
    findExactByHash: async (hash, lang, opts) => { seen.push({ method: 'exact', lang, opts }); return null; },
    findReferenceByHash: async (hash, opts) => { seen.push({ method: 'reference', opts }); return null; } };
  const find = new Function('OpenSubs', 'fetchOpenSubsFallback', resolver + '; return resolveBestSubtitle;')(
    api, async () => ({ name: 'metadata.srt', _content: srt() }));
  await find('http://laptop/cache/stream/movie', 'Short.2011.mkv', null, { duration: 60 });
  equal(seen, [{ method: 'exact', lang: 'en', opts: { duration: 60, filename: 'Short.2011.mkv' } },
    { method: 'reference', opts: { duration: 60, filename: 'Short.2011.mkv' } }]);
});
