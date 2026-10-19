// js/livetv.js — Live TV channels from a user-configured M3U playlist.
//
// Set the playlist URL in local settings (livetv.url) or pass it to
// fetchChannels({ url }). The playlist determines the region; no regional
// source is selected by default.
//
// The M3U is extended (EXTINF + EXTVLCOPT). We pull the visible attrs
// (channel name, logo, chno, group) and the stream URL — the EXTVLCOPT
// hints (user-agent, referrer) are VLC-specific and the webOS <video>
// element doesn't honour them. Playlists must expose directly usable URLs.

const LiveTV = (() => {
  function playlistUrl() { return String(Storage.get('livetv.url', '') || '').trim(); }
  function setPlaylistUrl(url) {
    Storage.set('livetv.url', String(url || '').trim());
    Storage.clear('livetv');
  }
  // Channel list rarely changes. 1 hour TTL keeps lookups instant on tab
  // switches without going stale.
  const CACHE_TTL_MS = 60 * 60 * 1000;
  const FETCH_TIMEOUT_MS = 15000;

  // Regexes hoisted to module scope — never compiled per call. The two
  // stateful (global) ones are safe to share: LINE_SPLIT_RE has no `g` flag,
  // and ATTR_RE/DIGIT_RE always run to natural exhaustion (loop until
  // exec/replace returns null), which per spec resets `lastIndex` to 0 —
  // so no cross-call leakage even though the object is reused.
  const LINE_SPLIT_RE = /\r?\n/;
  const ATTR_RE = /([a-z][a-z0-9-]*)="([^"]*)"/gi;
  const DIGIT_RE = /\d+/g;

  // Parse one EXTINF attribute string. Format:
  //   tvg-id="..." tvg-logo="..." group-title="..." tvg-chno="71"
  // Returns {tvgId, logo, group, chno}.
  function parseAttrs(line) {
    const out = {};
    ATTR_RE.lastIndex = 0; // defensive reset — see note above
    let m;
    while ((m = ATTR_RE.exec(line)) !== null) {
      out[m[1]] = m[2];
    }
    return out;
  }

  function parseM3U(text) {
    const lines = text.split(LINE_SPLIT_RE);
    const channels = [];
    let pending = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXTM3U')) continue;
      if (line.startsWith('#EXTINF')) {
        // "#EXTINF:-1 attrs , Display Name"
        const commaIdx = line.lastIndexOf(',');
        const name = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : '';
        const attrPart = commaIdx >= 0 ? line.slice(0, commaIdx) : line;
        const attrs = parseAttrs(attrPart);
        pending = {
          name,
          id: attrs['tvg-id'] || attrs['channel-id'] || name,
          logo: attrs['tvg-logo'] || '',
          chno: parseInt(attrs['tvg-chno'] || '0', 10) || 0,
          group: attrs['group-title'] || '',
        };
        continue;
      }
      if (line.startsWith('#')) continue;            // EXTVLCOPT etc — ignored
      if (pending) {
        pending.url = line;
        channels.push(pending);
        pending = null;
      }
    }
    return channels;
  }

  // Sort by playlist-provided channel number when present, then by name
  // for channels without a number.
  function sortChannels(channels) {
    return channels.slice().sort((a, b) => {
      const aHas = a.chno > 0, bHas = b.chno > 0;
      if (aHas && bHas) return a.chno - b.chno;
      if (aHas) return -1;
      if (bHas) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  // In-flight guard: if a fetch is already underway (e.g. renderLive()
  // fires again from a chip click, or a force-refresh lands mid-flight),
  // every caller awaits the SAME promise instead of racing a second
  // network request against the low-end device's radio/CPU budget.
  let inflight = null;
  let inflightUrl = '';

  async function doFetch(url) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(url, { signal: ac.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      const channels = sortChannels(parseM3U(text));
      // Tag once at fetch time so chip filtering and tile classNames don't
      // re-run the regex pass on every render.
      for (const c of channels) c.category = categorize(c);
      Storage.set('livetv', { url, at: Date.now(), channels });
      return channels;
      // `text` and the pre-sort array fall out of scope here — nothing
      // large is retained past this call.
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchChannels({ force = false, url = playlistUrl() } = {}) {
    url = String(url || '').trim();
    if (!url) return [];
    if (!force) {
      const cached = Storage.get('livetv', null);
      if (cached && cached.url === url && cached.at && (Date.now() - cached.at) < CACHE_TTL_MS && Array.isArray(cached.channels)) {
        return cached.channels;
      }
    }
    if (inflight && inflightUrl === url) return inflight; // join the same playlist request
    const request = doFetch(url);
    inflight = request;
    inflightUrl = url;
    try {
      return await request;
    } finally {
      if (inflight === request) {
        inflight = null;
        inflightUrl = '';
      }
    }
  }

  function listGroups(channels) {
    const seen = new Map();
    for (const c of channels) {
      const g = c.group || 'Other';
      seen.set(g, (seen.get(g) || 0) + 1);
    }
    return [...seen.entries()].map(([name, count]) => ({ name, count }));
  }

  // ---------- categorisation ----------
  // Some playlists group by geography instead of genre. Classify by channel
  // name heuristics for the news / sports / kids filters and attach a
  // `category` field to each channel.
  //
  // Match specific categories before broad ones: "Example World Movies"
  // belongs in Movies, while "Example Crime Drama" belongs in Crime.
  // Use generic genre terms without a default region or channel mapping.
  // Digits are stripped before matching so "2Crime" also matches "crime".
  const CATEGORY_PATTERNS = [
    { name: 'Sports',     re: /\b(sports?|cricket|rugby|tennis|golf|racing|football|soccer|basketball|baseball|hockey|wrestling|boxing|surfing|cycling|athletics)\b/ },
    { name: 'Kids',       re: /\b(kids?|children|cartoons?|toons?|junior|toddler|teen)\b/ },
    { name: 'News',       re: /\b(news|headlines|current affairs|business)\b/ },
    { name: 'Movies',     re: /\b(movies?|cinema|films?)\b/ },
    { name: 'Multicultural', re: /\b(multicultural|multilingual|international|world languages|language learning)\b/ },
    { name: 'Crime',      re: /\b(crime|investigations?|forensic|murder|criminal|detective)\b/ },
    { name: 'Documentary', re: /\b(documentary|documentaries|history|wildlife|nature|science|geographic|animals?|warfare|machines|adventure|travel)\b/ },
    { name: 'Reality',    re: /\b(reality|talent|makeover|dating|competition)\b/ },
    { name: 'Lifestyle',  re: /\b(lifestyle|food|home|garden|cooking|fashion|family|health|medical|rescue)\b/ },
    { name: 'Comedy',     re: /\b(comedy|sitcom|standup|stand-up|humor|humour|adult animation)\b/ },
    { name: 'Drama',      re: /\b(drama|romance|thriller)\b/ },
    { name: 'Music',      re: /\b(music|radio|chill|hits|concerts?|jazz|classical|pop|rock)\b/ },
    { name: 'Shopping',   re: /\b(shop|shopping|retail)\b/ },
  ];

  // Display order for the chip rail. Categories with no
  // matches in the current channel set are skipped at render time.
  const CATEGORY_ORDER = [
    'News', 'Sports', 'Movies', 'Kids', 'Drama', 'Comedy',
    'Documentary', 'Reality', 'Crime', 'Lifestyle', 'Music',
    'Multicultural', 'Shopping', 'Entertainment',
  ];

  function categorize(ch) {
    // Strip digits so "2Crime" matches "Crime". Lower-case once so the
    // patterns can stay cheap (no /i flag).
    const text = ((ch.name || '') + ' ' + (ch.id || '')).toLowerCase().replace(DIGIT_RE, ' ');
    for (const cat of CATEGORY_PATTERNS) {
      if (cat.re.test(text)) return cat.name;
    }
    return 'Entertainment';
  }

  function listCategories(channels) {
    const seen = new Map();
    for (const c of channels) {
      const cat = c.category || categorize(c);
      seen.set(cat, (seen.get(cat) || 0) + 1);
    }
    // Return in canonical display order, dropping empty categories.
    return CATEGORY_ORDER
      .filter(name => seen.has(name))
      .map(name => ({ name, count: seen.get(name) }));
  }

  return { playlistUrl, setPlaylistUrl, fetchChannels, listGroups, listCategories, categorize, parseM3U, sortChannels };
})();
