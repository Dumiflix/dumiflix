// services/dpad.js — D-pad keyboard navigation for TV remote
//
// Geometry-based 2D nav: every focusable element has a rect, arrow keys pick
// the best neighbor in that direction. Works for any layout (rows, grids,
// vertical lists) without scope-specific code.
//
// LG remote keys:
//   ArrowUp/Down/Left/Right — directional
//   Enter — select
//   Backspace / 461 (LG back) — back/escape

const DPad = (() => {
  let _scope = document.body;
  let _onBack = null;
  let _enabled = true;

  // Hoisted: was rebuilt as a fresh string literal on every focusables()
  // call. A module-level const avoids the (tiny but pointless) reallocation
  // on a path that fires on every d-pad keypress.
  const FOCUSABLE_SELECTOR = '[tabindex], button, input, .tile, .lib-row, .q-row, .result-row, .nav-item, .btn';

  // Visibility/eligibility check for a single candidate. `openModal` is
  // passed in (computed once per pass by _entries) instead of re-querying
  // the whole document for every candidate element.
  function _isVisible(el, openModal) {
    if (el.disabled) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    // skip nodes inside hidden tabs
    const tab = el.closest('.tab');
    if (tab && !tab.classList.contains('is-active')) return null;
    const player = el.closest('.player');
    if (player && !player.classList.contains('is-open')) return null;
    const modal = el.closest('.modal');
    if (modal && !modal.classList.contains('is-open')) return null;
    // When a modal is open, restrict focus to elements inside it.
    if (openModal && !el.closest('.modal')) return null;
    return r;
  }

  // Single pass over candidates: measures each element's rect exactly once
  // and keeps it alongside the element, instead of the old two-pass
  // approach (once to filter, again in move()'s distance math) which
  // forced a second layout read per element per keypress — expensive on
  // low-end webOS Chromium. Also avoids the old spread-into-array +
  // .filter() intermediate array; this builds the result array directly.
  function _entries(scope) {
    scope = scope || _scope;
    const openModal = document.querySelector('.modal.is-open'); // hoisted out of the per-candidate loop
    const cand = scope.querySelectorAll(FOCUSABLE_SELECTOR);
    const out = [];
    for (let i = 0; i < cand.length; i++) {
      const el = cand[i];
      const rect = _isVisible(el, openModal);
      if (rect) out.push({ el: el, rect: rect });
    }
    return out;
  }

  function current() {
    const f = document.querySelector('.is-focused');
    if (f) return f;
    const entries = _entries();
    return entries.length ? entries[0].el : undefined;
  }

  function focus(el) {
    if (!el) return;
    const previous = document.activeElement;
    if (previous && previous !== el && previous.dataset && previous.dataset.longPressAction === '1') {
      previous.blur();
    }
    document.querySelectorAll('.is-focused').forEach(n => n.classList.remove('is-focused'));
    el.classList.add('is-focused');
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
    // Hold controls consume the raw keydown/keyup pair on the element itself.
    // CSS focus alone leaves those events targeting the previous native focus.
    if (el.tagName === 'INPUT' || (el.dataset && el.dataset.longPressAction === '1')) {
      if (el.dataset && el.dataset.longPressAction === '1' && !el._dpadHoldBlurBound) {
        el.addEventListener('blur', () => {
          // The shared hold handler cancels its timer on pointerleave. Cancel
          // BEFORE releasing OK, or its keyup handler would click a short press.
          // The release also resets a completed hold's latch. Keep both events
          // local so departure cannot activate a different control.
          el.dispatchEvent(new CustomEvent('pointerleave'));
          const release = new CustomEvent('keyup', { cancelable: true });
          release.key = 'Enter';
          el.dispatchEvent(release);
        });
        el._dpadHoldBlurBound = true;
      }
      try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
    }
    // Notify listeners (background tracker, hero updater) that focus moved.
    // We can't rely on `focusin` because tiles use class-based focus, not
    // native browser focus.
    try { el.dispatchEvent(new CustomEvent('dpad-focus', { bubbles: true })); } catch (_) {}
  }

  function _centerOf(r) {
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function move(dir) {
    const entries = _entries();
    if (entries.length === 0) return;
    const cur = current();
    let curEntry = null;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].el === cur) { curEntry = entries[i]; break; }
    }
    if (!curEntry) { focus(entries[0].el); return; }
    const a = _centerOf(curEntry.rect);
    let best = null, bestScore = Infinity;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.el === cur) continue;
      const b = _centerOf(entry.rect);
      const dx = b.x - a.x, dy = b.y - a.y;
      let primary, secondary;
      // switch instead of 4 independent ifs: dir is always exactly one of
      // these, so this evaluates one branch instead of testing all four.
      switch (dir) {
        case 'left':  if (dx >= -2) continue; primary = -dx; secondary = Math.abs(dy); break;
        case 'right': if (dx <= 2)  continue; primary = dx;  secondary = Math.abs(dy); break;
        case 'up':    if (dy >= -2) continue; primary = -dy; secondary = Math.abs(dx); break;
        case 'down':  if (dy <= 2)  continue; primary = dy;  secondary = Math.abs(dx); break;
        default: continue;
      }
      // weight: small primary distance + small secondary offset wins
      const score = primary + secondary * 2;
      if (score < bestScore) { bestScore = score; best = entry.el; }
    }
    if (best) focus(best);
  }

  function setBackHandler(fn) { _onBack = fn; }

  // Stack-based variant for nested overlays. push at open, pop at close —
  // back lands on the right handler even when modal opens on top of player.
  const _backStack = [];
  function pushBackHandler(fn) {
    if (_onBack) _backStack.push(_onBack);
    _onBack = fn;
  }
  function popBackHandler() {
    _onBack = _backStack.pop() || null;
  }

  function handle(e) {
    if (!_enabled) return;
    const k = e.key;
    const code = e.keyCode;
    // While editing text, the user expects native keyboard behaviour:
    // arrows move the caret, Backspace deletes. Don't hijack any of those.
    // Escape/GoBack still bubble to the back handler so the user can exit
    // the field.
    const tag = e.target && e.target.tagName;
    const inEditable = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
    if (k === 'Escape' || k === 'GoBack' || code === 461 || code === 10009) {
      if (_onBack) { e.preventDefault(); _onBack(e); }
      return;
    }
    if (k === 'Backspace') {
      if (inEditable) return;                 // let the input delete a char
      if (_onBack) { e.preventDefault(); _onBack(e); }
      return;
    }
    if (inEditable && (k === 'ArrowLeft' || k === 'ArrowRight'
                       || k === 'ArrowUp' || k === 'ArrowDown')) {
      return;                                  // caret nav inside the field
    }
    if (k === 'Enter') {
      // Inside an input, let the field's own keydown handler run (e.g.
      // search-input's Enter fires runSearch). Without this, DPad clicks
      // the input itself, which is a no-op.
      if (inEditable) return;
      const cur = current();
      if (cur) {
        e.preventDefault();
        // Controls with a hold action need the raw keydown/keyup pair so they
        // can distinguish a short OK press from a destructive hold. Their
        // own keyup handler performs the normal click when the hold threshold
        // was not reached; all other controls keep the historical keydown
        // activation behavior.
        if (cur.dataset && cur.dataset.longPressAction === '1') return;
        cur.click();
      }
      return;
    }
    if (k === 'ArrowUp')    { e.preventDefault(); move('up'); return; }
    if (k === 'ArrowDown')  { e.preventDefault(); move('down'); return; }
    if (k === 'ArrowLeft')  { e.preventDefault(); move('left'); return; }
    if (k === 'ArrowRight') { e.preventDefault(); move('right'); return; }
  }

  function enable() { _enabled = true; }
  function disable() { _enabled = false; }

  document.addEventListener('keydown', handle, true);

  return { focus, current, move, setBackHandler, pushBackHandler, popBackHandler, enable, disable };
})();
