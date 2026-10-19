function assert(value, message = 'assertion failed') {
  if (!value) throw new Error(message);
}
function equal(actual, expected, message = '') {
  if (actual !== expected) throw new Error(message || `expected ${expected}, got ${actual}`);
}
const appSource = await Deno.readTextFile(new URL('../tv-app/app.js', import.meta.url));
const showsSource = await Deno.readTextFile(new URL('../tv-app/js/shows.js', import.meta.url));
function between(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`missing source: ${start}`);
  return source.slice(a, b);
}
const norm = between(appSource, 'function _normShow', '  // Strict show-name match.');
const episodeParser = between(appSource, 'function parseEpisodeName', '  // Choose the best release for a season-to-pen');
const movieHelpers = between(appSource, 'const _RE_IS_4K', '  // YTS-backed movie tile');
const GiB = 1024 ** 3;
function movies(YTS = {}, TMDB = {}) {
  return new Function('YTS', 'MAX_FILE_BYTES', 'TMDB', `${norm}\n${movieHelpers}\nreturn { pickBestTorrent, lookupYtsMovie };`)(YTS, 5 * GiB, TMDB);
}
function torrent(quality, seeds, size = 2 * GiB) {
  return { quality, seeds, size_bytes: size, hash: quality };
}

Deno.test('automatic movie resolution rejects Dune 1984 and unrelated titles from the right year', async () => {
  let detailCalls = 0;
  const { lookupYtsMovie } = movies({
    search: async () => ({ movies: [
      { id: 1, title: 'Dune', year: 1984 },
      { id: 2, title: 'Other Movie', year: 2021 },
    ] }),
    detail: async () => { detailCalls++; },
  });
  equal(await lookupYtsMovie({ title: 'Dune', year: '2021' }), null);
  equal(detailCalls, 0);
});

Deno.test('movie lookup searches IMDb when known and revalidates detail identity', async () => {
  let query;
  let wrongDetail = false;
  const correct = { id: 2, title: 'Dune', year: 2021, imdb_code: 'tt1160419' };
  const { lookupYtsMovie } = movies({
    search: async q => { query = q; return { movies: [
      { id: 1, title: 'Dune', year: 1984, imdb_code: 'tt0087182' }, correct,
    ] }; },
    detail: async () => ({ movie: wrongDetail ? { ...correct, imdb_code: 'tt0087182' } : correct }),
  });
  equal(await lookupYtsMovie({ title: 'Dune', year: 2021, _imdb: 'tt1160419' }), correct);
  equal(query, 'tt1160419');
  wrongDetail = true;
  equal(await lookupYtsMovie({ title: 'Dune', _imdb: 'tt1160419' }), null);
});

Deno.test('movie title and year match survives punctuation but cannot switch identity on detail', async () => {
  const selected = { title: 'Spider-Man: No Way Home', year: 2021 };
  let detail = { title: 'Spider Man No Way Home', year: 2021 };
  const { lookupYtsMovie } = movies({
    search: async () => ({ movies: [{ id: 1, ...detail }] }),
    detail: async () => ({ movie: detail }),
  });
  equal(await lookupYtsMovie(selected), detail);
  detail = { title: 'Other Movie', year: 2021 };
  equal(await lookupYtsMovie(selected), null);
});

Deno.test('movie identity folds diacritics and preserves distinct non-Latin titles', async () => {
  const amelie = { title: 'Amelie', year: 2001 };
  const tokyo = { title: '東京', year: 2024 };
  const { lookupYtsMovie } = movies({ search: async () => ({ movies: [
    amelie, { title: '北京', year: 2024 }, tokyo,
  ] }) });
  equal(await lookupYtsMovie({ title: 'Amélie', year: 2001 }), amelie);
  equal(await lookupYtsMovie({ title: 'Ame\u0301lie', year: 2001 }), amelie);
  equal(await lookupYtsMovie({ title: '東京', year: 2024 }), tokyo);
});

Deno.test('movie identity rejects empty and punctuation-only title keys', async () => {
  const { lookupYtsMovie } = movies({ search: async () => ({ movies: [
    { title: '', year: 2024 }, { title: '?!', year: 2024 },
  ] }) });
  equal(await lookupYtsMovie({ title: '...', year: 2024 }), null);
  equal(await lookupYtsMovie({ title: '', year: 2024 }), null);
});

Deno.test('movie lookup resolves IMDb from TMDB before searching translated titles', async () => {
  const calls = [];
  const movie = { title: 'Amelie', year: 2001, imdb_code: 'tt0211915' };
  const { lookupYtsMovie } = movies({
    search: async q => { calls.push(q); return { movies: [movie] }; },
  }, {
    imdbId: async (id, kind) => { equal(id, 194); equal(kind, 'movie'); calls.push('tmdb'); return 'tt0211915'; },
  });
  const selected = { title: 'Le Fabuleux Destin d’Amélie Poulain', year: 2001, tmdb_id: 194 };
  equal(await lookupYtsMovie(selected), movie);
  equal(calls.join(','), 'tmdb,tt0211915');
  calls.length = 0;
  equal(await lookupYtsMovie({ ...selected, _imdb: movie.imdb_code }), movie);
  equal(calls.join(','), 'tt0211915', 'a preloaded IMDb ID should skip TMDB');
});

Deno.test('failed TMDB external-ID lookup safely falls back to normalized title and year', async () => {
  let query;
  const movie = { title: 'Amelie', year: 2001 };
  const { lookupYtsMovie } = movies({
    search: async q => { query = q; return { movies: [movie] }; },
  }, { imdbId: async () => { throw new Error('offline'); } });
  equal(await lookupYtsMovie({ title: 'Amélie', year: 2001, tmdb_id: 194 }), movie);
  equal(query, 'Amélie');
});

Deno.test('movie picker excludes unseeded files before preferring in-cap 4K', () => {
  const { pickBestTorrent } = movies();
  const hd = torrent('1080p', 100);
  equal(pickBestTorrent([torrent('2160p', 0, 4 * GiB), hd]), hd);
  const fourK = torrent('2160p', 1, 4 * GiB);
  equal(pickBestTorrent([hd, fourK]), fourK);
  equal(pickBestTorrent([torrent('2160p', 10, 5 * GiB + 1), hd]), hd);
  equal(pickBestTorrent([torrent('2160p', 0), torrent('1080p', 'invalid')]), null);
  equal(pickBestTorrent([torrent('2160p', 1, 5 * GiB)]).quality, '2160p');
});

Deno.test('TMDB Play and Info share the guarded movie lookup and mismatches fall back to Search', async () => {
  const calls = [];
  const input = { value: '' };
  const paths = between(appSource, 'async function playTmdbMovieInstant', '  async function openTmdbTv');
  const api = new Function('lookupYtsMovie', 'toast', 'showTab', 'selectSearchType', '$',
    'pickBestTorrent', 'openMovieModal', 'addToQueue', 'showLoading', 'hideLoading', 'playLocalCopyIfPresent',
    `${paths}; return { playTmdbMovieInstant, openTmdbMovie };`)(
    async () => null, () => {}, tab => calls.push(tab), type => calls.push(type),
    selector => selector === '#search-input' ? input : null,
    () => { throw new Error('must not pick a torrent for a mismatched movie'); },
    () => { throw new Error('must not open a mismatched movie'); },
    () => { throw new Error('must not queue a mismatched movie'); },
    () => calls.push('loading'), () => calls.push('hide'), async () => false,
  );
  await api.playTmdbMovieInstant({ title: 'Dune', year: 2021 });
  await api.openTmdbMovie({ title: 'Dune', year: 2021 });
  equal(input.value, 'Dune 2021');
  equal(calls.join(','), 'loading,hide,search,movies,search,movies');
});

Deno.test('TV hero delegates to the Home show flow with year and identity', async () => {
  let received;
  const open = new Function('openTvShow', between(appSource, 'async function openTmdbTv', '  async function openMovieModal')
    + '; return openTmdbTv;')(it => { received = it; return 'show-modal'; });
  equal(await open({ title: 'Dark Matter', year: '2024', tmdb_id: 2, poster_sm: 'poster' }), 'show-modal');
  equal(received.title, 'Dark Matter');
  equal(received.year, '2024');
  equal(received.tmdb_id, 2);
  equal(received.poster, 'poster');
});

const infer = new Function(`${episodeParser}\n${between(appSource, 'function _stripReleaseTags', '  // Resolve the best show context')}\nreturn inferShowFromTitle;`)();
Deno.test('NxNN parsing strips the episode tag and release tail just like SxxEyy', () => {
  for (const name of ['Friends.1x01.1080p.mkv', 'Friends.S01E01.1080p.mkv']) {
    const show = infer(name);
    equal(show.title, 'Friends');
    equal(show.season, 1);
    equal(show.episode, 1);
  }
});

function shows(deps = {}) {
  // Exercise the full module; expose the existing private async entry points
  // only in this harness so fallback and modal wiring run as production does.
  const source = showsSource.replace('    onShow,', '    onShow, openShowModal, rowsForShow: _rowsForShowWithImdb,');
  const names = ['ApiBay', 'EZTV', 'Knaben', 'TVMaze', 'document', 'DPad', 'App', 'setTimeout'];
  const defaults = {
    ApiBay: { search: async () => [], magnet: row => 'magnet:' + row.info_hash },
    EZTV: { showTorrents: async () => [] }, Knaben: { search: async () => [] },
    document: {}, DPad: { pushBackHandler() {}, popBackHandler() {}, focus() {} },
    setTimeout: () => 0,
  };
  return new Function(...names, source + '; return Shows;')(...names.map(name => deps[name] || defaults[name]));
}
const showHelpers = shows()._test;
function row(name, size = GiB, seeders = 10) {
  return { name, size, seeders, info_hash: name.toLowerCase() };
}
Deno.test('Season Play caps packs before selection and starts E01 before highly seeded E08', () => {
  const first = row('Friends.1994.S01E01.720p');
  const last = row('Friends.1994.S01E08.1080p', GiB, 100);
  const hugePack = row('Friends.1994.S01.1080p', 6 * GiB, 1000);
  equal(showHelpers.pickSeasonPlay([hugePack, last, first]), first);
  const fittingPack = row('Friends.1994.S01.720p', 5 * GiB);
  equal(showHelpers.pickSeasonPlay([hugePack, last, first, fittingPack]), fittingPack);
  equal(showHelpers.pickSeasonPlay([hugePack, row('Friends.S01E01', GiB, 0)]), null);
});
Deno.test('Season Play ranks variants only within the first playable episode', () => {
  const first = row('Friends.1x01.1080p');
  equal(showHelpers.pickSeasonPlay([
    row('Friends.1x01.2160p', 6 * GiB), row('Friends.1x08.1080p', GiB, 100), first,
  ]), first);
  const payload = showHelpers.buildAddToQueuePayload({ title: 'Friends', year: '1994' }, 'S01', first);
  equal(payload.autoplay, true);
  equal(payload.show.season, 1);
  equal(payload.show.episode, 1);
  equal(payload.show.year, '1994');
});
Deno.test('Shows tracker identity rejects Smiling Friends and other premiere years', () => {
  const good = row('Friends.1994.S01E01.1080p');
  const accepted = showHelpers.filterShowRows([
    row('Smiling.Friends.1994.S01E01'), row('Friends.From.College.1994.S01'),
    row('Friends.2024.S01E01'), row('Friends.S01E01'), good,
  ], 'Friends', '1994', true);
  equal(accepted.length, 1);
  equal(accepted[0], good);
  equal(showHelpers.filterShowRows([row('1923.2022.S01E01')], '1923', '2022').length, 1);
});
Deno.test('yearless tracker releases are accepted only when premiere-year matching is not strict', () => {
  const yearless = row('Friends.S01E01.1080p');
  const correct = row('Friends.1994.S01E01.1080p');
  const wrong = row('Friends.2024.S01E01.1080p');
  const ordinary = showHelpers.filterShowRows([yearless, correct, wrong], 'Friends', '1994', false);
  equal(ordinary.length, 2);
  equal(ordinary[0], yearless);
  equal(ordinary[1], correct);
  const strict = showHelpers.filterShowRows([yearless, correct, wrong], 'Friends', '1994', true);
  equal(strict.length, 1);
  equal(strict[0], correct);
});

Deno.test('ApiBay and Knaben retain yearless releases for unambiguous shows when EZTV is unavailable', async () => {
  const yearless = row('Friends.S01E01.1080p');
  let apiRows = [yearless];
  let eztvCalls = 0;
  const api = shows({
    ApiBay: { search: async () => apiRows },
    EZTV: { showTorrents: async () => { eztvCalls++; throw new Error('offline'); } },
    Knaben: { search: async () => [yearless] },
  });
  equal((await api.rowsForShow('Friends', '1994', 'tt0108778', false))[0], yearless);
  equal(eztvCalls, 0);
  apiRows = [];
  equal((await api.rowsForShow('Friends', '1994', 'tt0108778', false))[0], yearless);
  equal(eztvCalls, 1);
  equal((await api.rowsForShow('Friends', '1994', 'tt0108778', true)).length, 0);
});

Deno.test('unrelated ApiBay rows cannot suppress EZTV; Knaben is filtered too', async () => {
  let eztvCalls = 0;
  const trusted = row('Friends.S01E01');
  const api = shows({
    ApiBay: { search: async () => [row('Smiling.Friends.2020.S01E01')] },
    EZTV: { showTorrents: async imdb => { equal(imdb, 'tt0108778'); eztvCalls++; return [trusted]; } },
    Knaben: { search: async () => [row('Smiling.Friends.1994.S01E01'), row('Friends.1994.S01E01')] },
  });
  equal((await api.rowsForShow('Friends', '1994', 'tt0108778', false))[0], trusted);
  equal(eztvCalls, 1);
  const fallback = await api.rowsForShow('Friends', '1994', null, false);
  equal(fallback.length, 1);
  equal(fallback[0].name, 'Friends.1994.S01E01');
});
Deno.test('Shows modal Play queues a capped first episode with autoplay and season context', async () => {
  const play = { dataset: { action: 'play', season: '1' } };
  const modal = { classList: { contains: () => false, add() {}, remove() {} } };
  const card = { innerHTML: '', querySelector: () => play };
  let queued;
  const api = shows({
    ApiBay: { search: async () => [
      row('Friends.1994.S01.1080p', 8 * GiB), row('Friends.1994.S01E08.1080p', GiB, 100),
      row('Friends.1994.S01E01.720p'),
    ], magnet: pick => 'magnet:' + pick.info_hash },
    TVMaze: { seasonMap: async () => ({ show: { imdb_id: 'tt0108778' }, seasons: new Map([[1, [{ number: 1 }, { number: 8 }]]]) }) },
    document: { getElementById: id => id === 'modal-card' ? card : id === 'modal' ? modal : null,
      querySelectorAll: () => [play] },
    App: { addToQueue: payload => { queued = payload; } },
  });
  await api.openShowModal({ title: 'Friends', year: '1994' });
  play.onclick();
  assert(queued);
  equal(queued.autoplay, true);
  equal(queued.show.season, 1);
  equal(queued.show.episode, 1);
  equal(queued.show.imdbId, 'tt0108778');
  equal(queued.show.episodesInSeason, 2);
  assert(queued.infoHash.includes('s01e01'));
});

const libConstants = between(appSource, 'const _LIBTITLE_SEP_RE', '// Rank the backend a duplicate lives on');
const libRank = between(appSource, 'function _libSrcRank', '  // Every physical Library copy');
const libGroups = between(appSource, 'function _libCleanShowTitle', '  // Lazily fill a poster tile');
const filenameParser = between(appSource, 'function showFromFilename', '\n\n  async function playDriveFile');
const library = new Function('wlMetaAll', `${norm}\n${episodeParser}\n${libConstants}\n${libRank}\n${libGroups}\n${filenameParser}
return { build: libBuildGroups, fourK: _lib4KMovie };`)(() => ({}));
Deno.test('Library keeps Dark Matter 2015 and 2024 identities separate', () => {
  const { shows } = library.build([], [
    { id: 'a', name: 'Dark.Matter.2015.S01E01.1080p.mkv' },
    { id: 'b', name: 'Dark.Matter.2024.S01E01.2160p.mkv' },
  ], []);
  equal(shows.length, 2);
  equal(shows[0].key, 'darkmatter:2015');
  equal(shows[1].key, 'darkmatter:2024');
  equal(shows[0].title, 'Dark Matter (2015)');
  equal(shows[1].title, 'Dark Matter (2024)');
});
Deno.test('Library merges yearless files only with an unambiguous known series year', () => {
  const files = [
    { id: 'a', name: 'Dark.Matter.2015.S01E01.mkv' },
    { id: 'b', name: 'Dark.Matter.S01E02.mkv' },
  ];
  equal(library.build([], files, []).shows.length, 1);
  files.push({ id: 'c', name: 'Dark.Matter.2024.S01E01.mkv' });
  equal(library.build([], files, []).shows.length, 3);
});
Deno.test('Library retains Drive 4K movie behind laptop 1080p and projects its actual file', () => {
  const { movies } = library.build([], [
    { id: 'drive-4k', name: 'Dune.2021.2160p.mkv' },
  ], [], [{ id: 'laptop-hd', name: 'Dune.2021.1080p.mkv' }]);
  equal(movies.length, 1);
  equal(movies[0].id, 'laptop-hd');
  equal(movies[0].variants.length, 2);
  equal(library.fourK(movies[0]).id, 'drive-4k');
  const onlyHD = library.build([], [{ id: 'hd', name: 'Dune.2021.1080p.mkv' }], []).movies[0];
  equal(library.fourK(onlyHD), null);
  assert(between(appSource, 'function renderLibGrid', '  // Route a stored file').includes('movies.map(_lib4KMovie).filter(Boolean)'));
});

Deno.test('tapping a title already saved locally plays that copy and never touches Seedr', async () => {
  const calls = [];
  const paths = between(appSource, 'async function playTmdbMovieInstant', '  async function openTmdbTv');
  const api = new Function('lookupYtsMovie', 'toast', 'showTab', 'selectSearchType', '$',
    'pickBestTorrent', 'openMovieModal', 'addToQueue', 'showLoading', 'hideLoading', 'playLocalCopyIfPresent',
    `${paths}; return { playTmdbMovieInstant };`)(
    async () => { throw new Error('must not search for a torrent'); }, () => {}, () => {}, () => {}, () => null,
    () => null, () => {}, () => { throw new Error('must not queue a saved movie'); },
    (title, poster, id, status) => calls.push(['loading', title, status]), () => calls.push(['hide']),
    async args => { calls.push(['local', args.title, args.year]); return true; },
  );
  await api.playTmdbMovieInstant({ title: 'Spider-Man: Brand New Day', year: 2026, poster: 'p.jpg' });
  equal(JSON.stringify(calls), JSON.stringify([['loading', 'Spider-Man: Brand New Day', 'Getting it ready…'], ['local', 'Spider-Man: Brand New Day', 2026]]));
});

Deno.test('local copy lookup plays a matching year, rejects a remake and gives up after 1.5 s', async () => {
  const helper = between(appSource, 'async function playLocalCopyIfPresent', '  // YTS-backed movie tile');
  const make = (finder, timers) => new Function('findCachedFileFor', 'playDriveFile', 'setTimeout',
    `${helper}; return playLocalCopyIfPresent;`)(finder, (...args) => timers.played.push(args),
    (fn, ms) => { timers.list.push({ fn, ms }); return timers.list.length; });
  const t1 = { played: [], list: [] };
  const hit = { id: 'VPSCACHE::Dune.2021.2160p.mkv', name: 'Dune.2021.2160p.mkv', subtitles: [] };
  equal(await make(async () => hit, t1)({ title: 'Dune', year: 2021, poster: 'p' }), true);
  equal(t1.played[0][0], 'VPSCACHE::Dune.2021.2160p.mkv');
  const t2 = { played: [], list: [] };
  equal(await make(async () => hit, t2)({ title: 'Dune', year: 1984, poster: 'p' }), false);
  equal(t2.played.length, 0);
  const t3 = { played: [], list: [] };
  const pending = make(() => new Promise(() => {}), t3)({ title: 'Dune', year: 2021 });
  equal(t3.list[0].ms, 1500);
  t3.list[0].fn();
  equal(await pending, false);
});

Deno.test('tap-time local check answers from the last-known laptop list without waiting on the network', async () => {
  const helper = between(appSource, 'async function playLocalCopyIfPresent', '  // YTS-backed movie tile');
  const picker = between(appSource, 'function _pickCachedMatch', '  async function refetchAndResume');
  const played = [], refreshed = [];
  const LaptopCache = {
    listKnown: () => [{ id: 'VPSCACHE::Spider-Man.Brand.New.Day.2026.1080p.mp4', name: 'Spider-Man.Brand.New.Day.2026.1080p.mp4' },
                      { id: 'VPSCACHE::Superman.2025.mkv', name: 'Superman.2025.mkv' }],
    listAll: () => { refreshed.push(1); return new Promise(() => {}); },
  };
  const play = new Function('LaptopCache', 'findCachedFileFor', 'playDriveFile', 'setTimeout', 'showFromFilename', '_libQualityRank',
    `${picker}\n${helper}; return playLocalCopyIfPresent;`)(
    LaptopCache, () => { throw new Error('known list hit must not run the slow lookup'); },
    (...args) => played.push(args), () => { throw new Error('no timer needed'); }, () => null, () => 0);
  equal(await play({ title: 'Spider-Man: Brand New Day', year: 2026, poster: 'p' }), true);
  equal(played[0][0], 'VPSCACHE::Spider-Man.Brand.New.Day.2026.1080p.mp4');
  equal(refreshed.length, 1);
});
