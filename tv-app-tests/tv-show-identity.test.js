function assert(value, message = 'assertion failed') {
  if (!value) throw new Error(message);
}
function assertEquals(actual, expected, message = '') {
  if (actual !== expected) throw new Error(message || `expected ${expected}, got ${actual}`);
}

const appSource = await Deno.readTextFile(new URL('../tv-app/app.js', import.meta.url));
const showsSource = await Deno.readTextFile(new URL('../tv-app/js/shows.js', import.meta.url));
const tvmazeSource = await Deno.readTextFile(new URL('../tv-app/js/tvmaze.js', import.meta.url));

function sourceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start);
  if (start < 0 || end < 0) throw new Error(`source block not found: ${startNeedle}`);
  return source.slice(start, end);
}

const identityHelpers = sourceBetween(
  tvmazeSource,
  'function _titleKey',
  '  async function searchShow',
);
const pickSearchShow = new Function(`${identityHelpers}; return pickSearchShow;`)();

Deno.test('TVMaze picks the selected Dark Matter series by premiere year', () => {
  const rows = [
    { show: { id: 1, name: 'Dark Matter', premiered: '2015-06-12' } },
    { show: { id: 2, name: 'Dark Matter', premiered: '2024-05-08' } },
  ];
  assertEquals(pickSearchShow(rows, 'Dark Matter', '2024').id, 2);
  assertEquals(pickSearchShow(rows, 'Dark Matter', '2015').id, 1);
});

const yearHelperSource = sourceBetween(
  appSource,
  'function _releaseYearMatches',
  '  // Aggressive show-name extractor',
);
const releaseYearMatches = new Function(
  `${yearHelperSource}; return _releaseYearMatches;`,
)();

Deno.test('ambiguous tracker results require the selected release year', () => {
  assert(releaseYearMatches('Dark.Matter.2024.S02E01.1080p.WEB-DL', '2024'));
  assert(!releaseYearMatches('Dark.Matter.2015.S02E01.1080p.WEB-DL', '2024'));
  assert(!releaseYearMatches('Dark.Matter.S02E01.1080p.WEB-DL', '2024'));
});

Deno.test('show year flows through every season and torrent lookup path', () => {
  assert(appSource.includes('year: it.year || null, tmdb_id: it.tmdb_id || null'));
  assert(appSource.includes('TVMaze.seasonMap(it.title, it.year)'));
  assert(appSource.includes('`${trackerBaseQ} S${sStr}E${String(ep.number).padStart(2, \'0\')}`'));
  assert(appSource.includes('const trackerBaseQ = strictYear ? `${baseQ} ${show.year}` : baseQ'));
  assert(showsSource.includes('TVMaze.seasonMap(show.title, show.year)'));
  assert(showsSource.includes('_rowsForShowWithImdb(show.title, show.year, imdbId, strictYear)'));
  assert(tvmazeSource.includes("(wantedYear ? ':' + wantedYear : '')"),
    'year-qualified TVMaze results must not reuse a stale title-only cache entry');
});
