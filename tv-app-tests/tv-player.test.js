function assert(value, message = 'assertion failed') {
  if (!value) throw new Error(message);
}
function equal(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
const playerSource = await Deno.readTextFile(new URL('../tv-app/tv-player.js', import.meta.url));
const dpadSource = await Deno.readTextFile(new URL('../tv-app/js/dpad.js', import.meta.url));
const appSource = await Deno.readTextFile(new URL('../tv-app/app.js', import.meta.url));
function between(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a, `missing source: ${start}`);
  return source.slice(a, b);
}
function timers() {
  const pending = new Map();
  let serial = 0;
  return {
    pending,
    setTimeout(fn, ms) { const id = ++serial; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    run(ms) {
      for (const [id, task] of Array.from(pending)) {
        if (task.ms === ms) { pending.delete(id); task.fn(); }
      }
    },
  };
}
function dom() {
  const elements = [], capture = [];
  const document = {
    body: {}, activeElement: null,
    querySelectorAll(selector) {
      return selector === '.is-focused' ? elements.filter(e => e.classList.contains('is-focused')) : elements;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    addEventListener(type, fn) { if (type === 'keydown') capture.push(fn); },
  };
  // DPad queries this separately from the focusable candidates.
  const query = document.querySelector.bind(document);
  document.querySelector = selector => selector === '.modal.is-open' ? null : query(selector);
  document.body.querySelectorAll = selector => document.querySelectorAll(selector);
  function element(classes = [], tagName = 'BUTTON') {
    const names = new Set(classes), listeners = {};
    const el = {
      tagName, dataset: {}, tabIndex: 0, hidden: false, disabled: false, clicks: 0,
      classList: { add: n => names.add(n), remove: n => names.delete(n), contains: n => names.has(n) },
      focus(options) {
        if (el.rejectOptions && options) throw new Error('old Chromium');
        if (document.activeElement && document.activeElement !== el) document.activeElement.blur();
        document.activeElement = el;
      },
      blur() {
        if (document.activeElement !== el) return;
        document.activeElement = null;
        el.emit('blur', { type: 'blur', target: el });
      },
      scrollIntoView() {}, dispatchEvent(e) { el.emit(e.type, e); }, closest() { return null; },
      getBoundingClientRect() { return el.rect || { left: 0, top: 0, width: 100, height: 20 }; },
      addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
      click() {
        const e = { preventDefault() {}, stopPropagation() {} };
        for (const fn of listeners.click || []) fn(e);
        el.clicks++;
        if (el.onclick) el.onclick();
      },
      emit(type, e) { for (const fn of listeners[type] || []) fn(e); },
    };
    elements.push(el);
    return el;
  }
  function key(code, type = 'keydown') {
    const e = { keyCode: code, key: ({ 13: 'Enter', 38: 'ArrowUp', 40: 'ArrowDown' })[code] || '',
      target: document.activeElement || document.body, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = true; this.immediate = true; } };
    if (type === 'keydown') for (const fn of capture) { fn(e); if (e.immediate) break; }
    if (!e.stopped && e.target.emit) e.target.emit(type, e);
    return e;
  }
  const dpad = new Function('document', 'CustomEvent', `${dpadSource}; return DPad;`)(document, CustomEvent);
  return { document, element, key, dpad };
}

function keyHarness() {
  const h = dom(), clock = timers(), calls = [];
  const rows = [h.element(['p-menu-item']), h.element(['p-menu-item', 'is-active']),
    h.element(['p-menu-item']), h.element(['p-menu-item'])];
  rows[2].tabIndex = -1; // Informational rows have no click handler in app.js.
  const menu = { hidden: false, querySelectorAll: () => rows };
  const up = { hidden: true }, next = h.element();
  h.document.getElementById = id => ({ 'p-menu': menu, 'p-upnext': up, 'p-upnext-play': next })[id];
  const R = {};
  for (const name of ['pp', 'scrub', 'rew', 'fwd', 'subsB', 'audioB', 'speedB', 'syncB', 'skipPill', 'nextB']) R[name] = h.element(['nft-btn']);
  const env = {
    doc: h.document, R, PLAYER: {}, V: { paused: false }, bridge: { dpad: h.dpad, closeMenu() { menu.hidden = true; calls.push('closeMenu'); } },
    clamp: (v, a, b) => Math.max(a, Math.min(v, b)),
    togglePlay() { calls.push('toggle'); }, showControls() { calls.push('show'); },
    resetHide() {}, press() {}, commitSeek() { calls.push('seek'); }, nudge(n) { calls.push(n); },
    openAppMenu(kind) { calls.push(kind); }, nudgeSync() {}, curDelay() { return 0; },
    doSkip() { calls.push('skip'); }, doNext() { calls.push('next'); }, doClose() { calls.push('close'); },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  };
  const code = between(playerSource, '  var KEY =', '\n\n  // One icon family')
    + between(playerSource, '  function closestCls(', '\n  function onPointerMove(')
    + between(playerSource, '  function onMenuKey(', '\n  function moveFocusH(')
    + between(playerSource, '  function activateFocused()', '\n  function openAppMenu(');
  const api = new Function(...Object.keys(env), `let active = true, controlsShown = true, focusEl = R.pp, seekTarget = null;
    function isPillFocused() { return focusEl === R.skipPill; }
    function setFocus(el) { focusEl = el; }
    ${code}
    return { onKey, onPointer, focus: name => { focusEl = R[name]; }, hide: () => { controlsShown = false; } };`)(...Object.values(env));
  h.dpad.disable(); // activate() disables the earlier document capture listener.
  h.document.addEventListener('keydown', api.onKey, true);
  return { ...h, ...api, menu, rows, calls, up, next, R };
}

Deno.test('player menus navigate enabled rows, select once, clamp, and keep Back in the menu', () => {
  for (const kind of ['subtitles', 'audio', 'speed']) {
    const h = keyHarness();
    // openMenu(kind) paints the active row after 30ms; also works before that timer.
    if (kind !== 'subtitles') h.dpad.focus(h.rows[1]);
    assert(h.key(40).prevented);
    assert(h.rows[3].classList.contains('is-focused'));
    h.key(40);
    assert(h.rows[3].classList.contains('is-focused'));
    h.key(38);
    assert(h.rows[1].classList.contains('is-focused'));
    assert(h.key(13).prevented);
    equal(h.rows.map(r => r.clicks), [0, 1, 0, 0]);
    equal(h.calls, []);
    for (const code of [461, 10009, 27, 8]) {
      h.menu.hidden = false;
      assert(h.key(code).immediate);
    }
    equal(h.calls.filter(c => c === 'closeMenu').length, 4);
    assert(!h.calls.includes('close'));
  }
});

Deno.test('empty or rebuilt menus cannot activate a stale row', () => {
  const h = keyHarness();
  h.dpad.focus(h.rows[3]);
  h.rows.splice(0);
  assert(h.key(13).prevented);
  const replacement = h.element(['p-menu-item']);
  h.rows.push(replacement);
  h.key(13);
  equal(replacement.clicks, 1);
});

Deno.test('media Play/Pause toggles with every focused control and over menus or Up Next', () => {
  const h = keyHarness();
  h.menu.hidden = true;
  for (const name of ['pp', 'scrub', 'rew', 'fwd', 'subsB', 'audioB', 'speedB', 'syncB', 'skipPill', 'nextB']) {
    h.focus(name);
    const e = h.key(463);
    assert(e.prevented && e.immediate);
  }
  h.menu.hidden = false;
  h.key(463);
  h.menu.hidden = true;
  h.up.hidden = false;
  h.key(463);
  h.hide();
  h.key(463);
  equal(h.calls.filter(c => c === 'toggle').length, 13);
  assert(h.calls.every(c => c === 'toggle' || c === 'show'));
  equal(h.next.clicks, 0);
});

Deno.test('OK still activates focused menu controls and skip pills', () => {
  const h = keyHarness();
  h.menu.hidden = true;
  for (const name of ['subsB', 'audioB', 'speedB', 'skipPill']) { h.focus(name); h.key(13); }
  equal(h.calls, ['subtitles', 'audio', 'speed', 'skip']);
});

Deno.test('Magic Remote clicks still open controls and reach menu row click handlers', () => {
  const h = keyHarness();
  const pointer = target => ({ target, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });
  h.menu.hidden = true;
  for (const name of ['subsB', 'audioB', 'speedB']) {
    const e = pointer(h.R[name]);
    h.onPointer(e);
    assert(e.prevented && e.stopped);
  }
  equal(h.calls.filter(c => c !== 'show'), ['subtitles', 'audio', 'speed']);
  h.menu.hidden = false;
  const e = pointer(h.rows[3]);
  h.onPointer(e);
  assert(!e.prevented && !e.stopped, 'player capture must let the menu receive pointer clicks');
  if (!e.stopped) e.target.click();
  equal(h.rows[3].clicks, 1);
});

Deno.test('DPad native focus routes short OK and hold pairs to real tile handlers', async () => {
  const h = dom(), clock = timers();
  let held = 0;
  const attach = new Function('setTimeout', 'clearTimeout',
    between(appSource, '  function attachLongPressAction(', '\n\n  // Long-press (hold OK') + '\nreturn attachLongPressAction;')(
    clock.setTimeout, clock.clearTimeout);
  const tile = h.element(['tile']);
  tile.rejectOptions = true; // Exercise the old-webOS focus() fallback too.
  attach(tile, () => { held++; });
  h.dpad.focus(tile);
  assert(h.document.activeElement === tile);
  h.key(13); equal(tile.clicks, 0);
  h.key(13, 'keyup'); equal(tile.clicks, 1);
  h.key(13); clock.run(700); await Promise.resolve();
  h.key(13, 'keyup'); equal(held, 1); equal(tile.clicks, 1);
  h.key(13); h.key(13, 'keyup'); equal(tile.clicks, 2);
  const ordinary = h.element();
  h.dpad.focus(ordinary);
  assert(h.document.activeElement !== tile, 'leaving a hold tile must not send later keys back to it');
  h.key(13); h.key(13, 'keyup'); clock.run(700); await Promise.resolve();
  equal(ordinary.clicks, 1); equal(held, 1); equal(tile.clicks, 2);
});

Deno.test('leaving a hold tile before release cancels deletion without activating it', async () => {
  for (const departure of ['down', 'native blur']) {
    const h = dom(), clock = timers();
    let held = 0;
    const attach = new Function('setTimeout', 'clearTimeout',
      between(appSource, '  function attachLongPressAction(', '\n\n  // Long-press (hold OK') + '\nreturn attachLongPressAction;')(
      clock.setTimeout, clock.clearTimeout);
    const tile = h.element(['tile']), next = h.element(['tile']);
    next.rect = { left: 0, top: 100, width: 100, height: 20 };
    attach(tile, () => { held++; });
    attach(next, () => { held++; });
    h.dpad.focus(tile);
    h.key(13);
    equal(clock.pending.size, 1);
    if (departure === 'down') h.key(40);
    else next.focus();
    assert(h.document.activeElement === next);
    equal(clock.pending.size, 0);
    h.key(13, 'keyup'); clock.run(700); await Promise.resolve();
    equal(held, 0); equal(tile.clicks, 0); equal(next.clicks, 0);
    h.dpad.focus(tile);
    h.key(13); h.key(13, 'keyup');
    equal(tile.clicks, 1);
    h.key(13); clock.run(700); await Promise.resolve();
    equal(held, 1);
    h.dpad.focus(next); // A completed hold must also release its held latch.
    h.key(13, 'keyup');
    h.dpad.focus(tile);
    h.key(13); h.key(13, 'keyup');
    equal(tile.clicks, 2); equal(held, 1); equal(clock.pending.size, 0);
  }
});

function seekHarness(synchronous = false) {
  const clock = timers(), listeners = new Map(), blockedTargets = [];
  const V = { paused: true, seeking: !synchronous, readyState: 4, currentTime: 0,
    fastSeek(t) { this.currentTime = t; if (synchronous) this.emit('seeked'); },
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name) { listeners.delete(name); },
    emit(name) { const fn = listeners.get(name); if (fn) fn(); },
  };
  const env = { V, Promise, Number, active: true, bridge: { blockDirectSeedrSeek(t) { blockedTargets.push(t); return t === 80; } },
    clamp: (v, a, b) => Math.max(a, Math.min(v, b)), dur: () => 100, parkState: () => null, RMX: () => null,
    beginExternalSeek() {}, endExternalSeek() {}, wake() {},
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  };
  const api = new Function(...Object.keys(env),
    between(playerSource, '  function seedrSeekBlocked(', '\n  function maxSeek(')
    + between(playerSource, '  function seekAbs(', '\n  function p2(') + '\nreturn seekAbs;')(...Object.values(env));
  return { api, V, listeners, clock, blockedTargets };
}

Deno.test('seek events share one poll and settlement removes all timers/listeners', async () => {
  const h = seekHarness();
  const result = h.api(30);
  h.clock.run(0);
  h.V.emit('timeupdate'); h.V.emit('timeupdate'); h.V.emit('seeked');
  equal(Array.from(h.clock.pending.values()).map(t => t.ms).sort(), [100, 5000]);
  const staleCheck = h.listeners.get('timeupdate');
  h.V.seeking = false; h.V.emit('seeked');
  await result;
  equal(h.listeners.size, 0); equal(h.clock.pending.size, 0);
  h.V.seeking = true; staleCheck();
  equal(h.clock.pending.size, 0);
});

Deno.test('seek timeout and synchronous seeked settlement leave no poll behind', async () => {
  for (const synchronous of [false, true]) {
    const h = seekHarness(synchronous);
    const result = h.api(20);
    if (!synchronous) { h.V.emit('timeupdate'); h.clock.run(5000); }
    await result;
    equal(h.listeners.size, 0); equal(h.clock.pending.size, 0);
  }
});

Deno.test('Seedr seek gate receives the requested target and prevents seeking', async () => {
  const h = seekHarness();
  equal(await h.api(80), { blocked: true });
  equal(h.blockedTargets, [80]); equal(h.V.currentTime, 0); equal(h.clock.pending.size, 0);
});

Deno.test('subtitle replacement repaints matching cue indexes/times and still deduplicates unchanged cues', () => {
  const bridge = { subState: { cues: [{ start: 1, end: 5, text: 'Old language' }] } };
  let text = '', writes = 0;
  const subTextEl = { set textContent(value) { text = value; writes++; } };
  const render = new Function('bridge', 'subTextEl', `let subSeekHold = false, subOffset = 0, lastSubKey = '', lastSubCues = null;
    ${between(playerSource, '  function cleanCue(', '\n  function fireUpNext(')}
    return renderSub;`)(bridge, subTextEl);
  render(2); render(3); equal(text, 'Old language'); equal(writes, 1);
  bridge.subState.cues = [{ start: 1, end: 5, text: 'New language' }];
  render(3); equal(text, 'New language'); equal(writes, 2);
  bridge.subState.cues = []; render(3); equal(text, '');
  bridge.subState.cues = [{ start: 1, end: 5, text: 'Restored language' }];
  render(3); equal(text, 'Restored language');
});
