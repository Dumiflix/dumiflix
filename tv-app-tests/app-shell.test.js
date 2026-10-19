function assert(value, message = 'assertion failed') {
  if (!value) throw new Error(message);
}
function equal(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const source = await Deno.readTextFile(new URL('../tv-app/app.js', import.meta.url));
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a, 'missing source section ' + start);
  return source.slice(a, b);
}
const saverSource = section('  const Screensaver = (() => {', '  // Crash recovery:');

function screensaver(phone, mode = 'mix') {
  const played = [], media = [];
  function element(tag) {
    const node = {
      tag, children: [], attrs: {}, hidden: false,
      classList: { add() {}, remove() {}, contains: () => false },
      setAttribute(k, v) { this.attrs[k] = v; },
      removeAttribute(k) { delete this.attrs[k]; },
      appendChild(child) { this.children.push(child); child.parent = this; },
      remove() { this.parent.children = this.parent.children.filter(c => c !== this); },
      querySelectorAll: function () { return this.children.filter(c => c.tag === 'source'); },
      addEventListener() {}, load() {}, pause() {},
      play() { played.push(this.children[0].attrs); return Promise.resolve(); },
    };
    if (tag === 'video') media.push(node);
    return node;
  }
  const env = {
    Phone: phone, Storage: { get: () => ({ mode }) }, window: {}, currentVideo: null,
    document: { createElement: element, body: element('body'),
      querySelectorAll: () => media, getElementById: () => null },
    requestAnimationFrame: fn => fn(), setInterval: () => 1, clearInterval() {},
  };
  const api = new Function(...Object.keys(env), saverSource + '; return Screensaver;')(...Object.values(env));
  return { api, played };
}

Deno.test('app shell: ambient playback prefers configured local video files', async () => {
  const h = screensaver({
    hasHost: () => true,
    listFiles: async dir => {
      equal(dir, 'Ambient');
      return { entries: [{ type: 'file', name: 'rain.MP4' },
        { type: 'file', name: 'notes.txt' }, { type: 'directory', name: 'other.mp4' }] };
    },
    streamUrl: path => 'http://192.0.2.10:5052/files/stream/' + path,
  });
  equal(await h.api.probeSources(), { local: 1 });
  h.api.preview();
  assert(h.api.isActive());
  equal(h.played[0].src, 'http://192.0.2.10:5052/files/stream/Ambient/rain.MP4');
  const options = JSON.parse(unescape(h.played[0].type.split('mediaOption=')[1]));
  equal(options.mediaTransportType, 'URI');
  equal(options.option.adaptiveStreaming, { maxWidth: 1920, maxHeight: 1080 });
});

for (const [name, phone] of [
  ['unconfigured', { hasHost: () => false }],
  ['unreachable', { hasHost: () => true, listFiles: async () => { throw new Error('offline'); } }],
  ['empty', { hasHost: () => true, listFiles: async () => ({ entries: [] }) }],
]) {
  Deno.test('app shell: ambient playback uses stock clips when local source is ' + name, async () => {
    const h = screensaver(phone, 'rain');
    equal(await h.api.probeSources(), { local: 0 });
    h.api.preview();
    assert(/^https:\/\/assets\.mixkit\.co\/videos\/\d+\/\d+-720\.mp4$/.test(h.played[0].src));
    assert([2846, 4331, 4332, 4422, 2716, 18312].some(id => h.played[0].src.includes('/' + id + '/')));
  });
}

Deno.test('app shell: music opens the direct audio stream', async () => {
  const track = { id: 'track-1', name: 'Example song', codec: 'flac', profile: '' }, opened = [];
  const env = {
    formatCodecBadge: () => ({ isAtmos: false }),
    MacOnTV: { musicStreamUrl: id => 'http://192.0.2.20:5052/music/stream/' + id },
    openPlayer: (...args) => opened.push(args), setTimeout: () => 1, setInterval: () => 1,
    clearInterval() {}, $: () => ({}),
  };
  const play = new Function(...Object.keys(env), `let _musicAdvanceTimer = 0;
    ${section('  async function startMusicTrack(', '  // ---------- Music tab')}
    return startMusicTrack;`)(...Object.values(env));
  await play(track);
  equal(opened[0][0], 'http://192.0.2.20:5052/music/stream/track-1');
  equal(opened[0][2].isAudio, true);
  equal(opened[0][2].musicItem, track);
});

Deno.test('app shell: HDMI handoff requires a configured input app', () => {
  const calls = [];
  let input = '';
  const switchInput = new Function('Storage', 'PalmServiceBridge',
    section('  function switchTvToSoundbarInput()', '  // ---- laptop playback controller')
    + '; return switchTvToSoundbarInput;')(
      { get: (key, fallback) => input || fallback },
      function () { this.call = (url, payload) => calls.push([url, JSON.parse(payload)]); },
    );
  equal(switchInput(), false);
  equal(calls, []);
  input = 'com.webos.app.hdmi3';
  equal(switchInput(), true);
  equal(calls, [['luna://com.webos.applicationManager/launch', { id: input }]]);
});
