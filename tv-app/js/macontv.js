// js/macontv.js — client for an optional companion service, not included
// in this repository. The configured server exposes a torrent and music
// HTTP API on the LAN. Discovery scans /health on the local /24 and checks
// the `music_dir` signature before accepting a server.
// MacOnTV and macHost are historical API/storage names kept for compatibility.

const MacOnTV = (() => {
  // Regexes hoisted to module scope so a busy remote-control session (a
  // fetch every 1.5s while music/video plays) never rebuilds a RegExp per
  // call — cheap per-call, but this runs for the entire life of a session.
  const RE_ABSOLUTE_URL = /^https?:\/\//i;
  const RE_TRAILING_SLASHES = /\/+$/;
  const RE_HOST_NOT_SET = /host not set/i;

  // Bound every fetch so an unavailable companion server cannot retain
  // sockets and response buffers indefinitely on memory-constrained TVs.
  // Timeouts follow the same unreachable-server error path as other failures.
  const FETCH_TIMEOUT_MS = 20000;

  function host() {
    return (Storage.get('macHost', '') || '').trim();
  }
  function setHost(h) {
    Storage.set('macHost', String(h || '').trim());
  }
  function hasHost() { return !!host(); }

  // base() and the public url() below both need "host -> origin" — one
  // place that knows the "192.0.2.10" / "192.0.2.10:5052" / full-URL
  // rule instead of two copies drifting apart.
  function _origin(h) {
    if (!h) throw new Error('Companion host not set in Settings');
    // Allow user to type "192.0.2.10" or "192.0.2.10:5052" or full URL.
    if (RE_ABSOLUTE_URL.test(h)) return h.replace(RE_TRAILING_SLASHES, '');
    return `http://${h.includes(':') ? h : h + ':5052'}`;
  }
  function base() { return _origin(host()); }

  // fetch() wrapped with an AbortController-based timeout. A timeout just
  // surfaces as a normal thrown error (AbortError), so every existing catch
  // site here already treats thrown fetch errors as an unreachable server.
  function _fetchTimed(url, init) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    const opts = init ? { ...init, signal: ac.signal } : { signal: ac.signal };
    return fetch(url, opts).then(value => { clearTimeout(timer); return value; }, error => { clearTimeout(timer); throw error; });
  }

  // ---------- LAN auto-discovery ----------
  // Calls the native service's `discover` Luna method, which knows the TV's
  // own IP (via connectionmanager) and parallel-scans the /24 for the
  // companion service's /health signature. On success the new host is persisted to
  // localStorage so the next launch starts from a warm cache.
  //
  // Single in-flight: parallel fetches that all fail should converge on
  // ONE discovery, not 5 racing scans.
  let _discovering = null;
  function discover({ port = 5052 } = {}) {
    if (_discovering) return _discovering;
    _discovering = (async () => {
      if (typeof WebOSServiceBridge === 'undefined') {
        throw new Error('discovery requires the webOS service bridge');
      }
      return await new Promise((resolve, reject) => {
        const bridge = new WebOSServiceBridge();
        let done = false;
        let fallback;
        const finish = (fn, x) => {
          if (done) return;
          done = true;
          // Scan already answered (or errored) — drop the dead-man timer
          // instead of letting it fire uselessly up to 12s later.
          clearTimeout(fallback);
          fn(x);
        };
        bridge.onservicecallback = (raw) => {
          let msg; try { msg = JSON.parse(raw); } catch (_) { msg = {}; }
          if (msg.returnValue === false) {
            finish(reject, new Error(msg.errorText || 'discover failed'));
            return;
          }
          if (msg.found && msg.host) {
            setHost(msg.host);
            finish(resolve, msg.host);
          } else {
            finish(reject, new Error(
              'no companion service answered on ' + (msg.tv_ip || '?') +
              ' /24 (scanned ' + (msg.scanned || 0) + ' hosts)'));
          }
        };
        try {
          bridge.call('luna://com.dumiflix.tv.service/discover',
                      JSON.stringify({ port }));
        } catch (e) {
          finish(reject, e);
        }
        // Whole /24 scan should resolve in ~2 s. Cap at 12 s so we don't
        // hang the UI forever if the service is wedged.
        fallback = setTimeout(() => finish(reject, new Error('discover timed out')), 12000);
      });
    })().then(value => { _discovering = null; return value; }, error => { _discovering = null; throw error; });
    return _discovering;
  }

  // Wrap fetch so any network-layer failure (TypeError "Failed to fetch",
  // DNS, refused, timeout) triggers a single discovery attempt and one
  // retry on the new host. Application-level failures (404, 5xx) do NOT
  // trigger discovery — those mean we found the right host but the call
  // itself failed, and rescanning the LAN wouldn't fix that.
  async function _json(path, init = {}) {
    let r;
    try {
      r = await _fetchTimed(base() + path, init);
    } catch (netErr) {
      // base() throws when no host is set — that's not a network error,
      // it bubbles out so the UI can prompt the user.
      if (RE_HOST_NOT_SET.test(netErr.message || '')) throw netErr;
      try {
        await discover();
      } catch (discErr) {
        const tail = discErr && discErr.message ? ' (' + discErr.message + ')' : '';
        throw new Error('Companion service not reachable' + tail);
      }
      r = await _fetchTimed(base() + path, init);
    }
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`Companion service ${r.status}: ${txt.slice(0, 160)}`);
    }
    return r.json().catch(() => { throw new Error('Companion service: invalid JSON response'); });
  }

  function health() { return _json('/health'); }

  function add(query) {
    return _json('/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
  }

  async function queue() {
    const data = await _json('/queue');
    return data.torrents || [];
  }

  async function list() {
    const data = await _json('/list');
    return data.videos || [];
  }

  function streamUrl(id) {
    return base() + '/stream/' + encodeURIComponent(id);
  }

  // Music — configurable music library root on the companion server.
  // The daemon ffprobes each file and reports codec/sample-rate/channels so
  // the UI can show "ALAC 24/48 stereo" or "DD+ Atmos 5.1" at a glance.
  // /music/stream rewraps .m4a on the fly (eac3 → mp4 with -c copy so Dolby
  // Atmos survives bit-identically; alac → flac for lossless playback).
  async function music() {
    const data = await _json('/music/list');
    return data.music || [];
  }
  function musicStreamUrl(id) {
    return base() + '/music/stream/' + encodeURIComponent(id);
  }
  // Fetch the daemon-extracted embedded English subtitle as SRT text.
  // webOS Chromium doesn't surface in-band MKV text tracks for HEVC files,
  // so the daemon ffprobes / ffmpegs the file and we attach it as external.
  async function fetchEmbeddedSubs(id) {
    try {
      const r = await _fetchTimed(base() + '/subs/' + encodeURIComponent(id));
      if (!r.ok) return null;
      const text = await r.text();
      if (!text || text.length < 32) return null;
      return text;
    } catch (_) { return null; }
  }

  function del(hash) {
    return _json('/item/' + encodeURIComponent(hash), { method: 'DELETE' });
  }

  // Boot intent — one-shot signal stored by the companion service when an external
  // trigger (for example, POST /play-music) requests an action on TV launch.
  // Returns {kind, args, createdAt, expiresAt} or null.
  // The service clears the intent atomically on read, so a relaunch within
  // the same window won't replay it.
  async function fetchIntent() {
    try {
      const r = await _fetchTimed(base() + '/intent', { cache: 'no-store' });
      if (!r.ok) return null;
      const d = await r.json();
      return (d && d.intent) || null;
    } catch (_) { return null; }
  }

  return {
    hasHost, setHost, host, health, discover,
    add, queue, list, streamUrl, del, fetchEmbeddedSubs,
    music, musicStreamUrl, fetchIntent,
    // Compose URLs for the broker (music remote control). Doesn't go
    // through _json because callers want full control over method/body and
    // need to react to non-2xx without triggering discovery.
    url(path) {
      return _origin(host()) + path;
    },
  };
})();
