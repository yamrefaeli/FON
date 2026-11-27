const { XMLParser } = require('fast-xml-parser');

const CRAWLER_UA = 'Mozilla/5.0 (compatible; Google-Agent; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent)';
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

// ============================================================================
// מאגר צדדי נרחב, מתעדכן ומפורט של פודקאסטים, רדיו, שיעורי תורה ושירים (סעיף 14)
// נטען ונשלף רק לפי בקשת המשתמש, כולל מעקב פרקים אישי לכל מתקשר!
// ============================================================================
const CURATED_PODCASTS_AND_RADIO = [
  // --- חדשות ואקטואליה ---
  {
    id: 'kan_hourly',
    category: 'חדשות ואקטואליה',
    name: 'חדשות כאן - מהדורת השעה',
    keywords: ['חדשות כאן', 'מהדורת השעה', 'חדשות', 'רשת ב חדשות', 'מבזק'],
    type: 'audio_rss',
    url: 'https://www.spreaker.com/show/6095076/episodes/feed',
    description: 'מהדורת החדשות העדכנית של כאן רשת ב המתעדכנת מדי שעה עגולה (כ-5 דקות).'
  },
  {
    id: 'kan_reshet_bet',
    category: 'חדשות ואקטואליה',
    name: 'כאן רשת ב - בחצי היום והנבחרים',
    keywords: ['כאן רשת ב', 'בחצי היום', 'אקטואליה', 'ראיונות כאן'],
    type: 'audio_rss',
    url: 'https://omny.fm/shows/kan-news/playlists/podcast.rss',
    description: 'הראיונות, הפרשנויות והכתבות המרכזיות מתוכניות האקטואליה של כאן רשת ב.'
  },
  {
    id: 'kol_chai_news',
    category: 'חדשות ואקטואליה חרדית',
    name: 'רדיו קול חי - מבזקי חדשות',
    keywords: ['קול חי', 'חדשות קול חי', '93'],
    type: 'headlines_rss',
    url: 'https://www.93fm.co.il/feed/',
    description: 'מבזקי חדשות וכותרות שוטפות מאתר רדיו קול חי.'
  },
  {
    id: 'jdn_news',
    category: 'חדשות ואקטואליה חרדית',
    name: 'חדשות JDN - מבזקים שוטפים',
    keywords: ['jdn', 'חדשות חרדים', 'מבזקי jdn'],
    type: 'headlines_rss',
    url: 'https://www.jdn.co.il/feed/',
    description: 'כותרות ודיווחים שוטפים מהעולם החרדי והכללי מאתר JDN.'
  },

  // --- תורה, הלכה וחסידות ---
  {
    id: 'rav_chota',
    category: 'תורה והלכה',
    name: 'הרב בנימין חותה - הלכה יומית ושיעורים',
    keywords: ['הרב חותה', 'בנימין חותה', 'הלכה', 'הלכה יומית', 'שיעור הלכה'],
    type: 'audio_rss',
    url: 'https://feeds.transistor.fm/a1c278d1-5049-41f1-aeae-c200557f75e2',
    description: 'שיעורי הלכה ברורים, אקטואליים ומרתקים מפי הרב בנימין חותה.'
  },
  {
    id: 'zrikat_chasidut',
    category: 'תורה וחסידות',
    name: 'זריקת חסידות - הפודקאסט',
    keywords: ['זריקת חסידות', 'חסידות', 'פרשת שבוע', 'חיזוק'],
    type: 'audio_rss',
    url: 'https://rss.buzzsprout.com/749555.rss',
    description: 'רעיונות עמוקים וקצרים מתורת החסידות לחיי היומיום.'
  },
  {
    id: 'nekuda_pnimit',
    category: 'חסידות והתבודדות',
    name: 'הנקודה הפנימית - רן ובר (רבי נחמן מברסלב)',
    keywords: ['רן ובר', 'הנקודה הפנימית', 'ברסלב', 'רבי נחמן', 'התבודדות'],
    type: 'audio_rss',
    url: 'https://anchor.fm/s/7b47fefc/podcast/rss',
    description: 'שיעורים ושיחות חיזוק בתורת רבי נחמן מברסלב עם רן ובר.'
  },
  {
    id: 'kakedem_tora',
    category: 'תורה ואמונה',
    name: 'כקדם - לחדש חיי תורה',
    keywords: ['כקדם', 'תורה ואמונה', 'מוסר'],
    type: 'audio_rss',
    url: 'https://anchor.fm/s/fefe92d8/podcast/rss',
    description: 'פודקאסט בנושאי תורה, אמונה ומוסר בעיון מתחדש.'
  },
  {
    id: 'yesivat_hakotel',
    category: 'תורה וישיבות',
    name: 'שיעורי ישיבת הכותל - הרב ברוך וידר',
    keywords: ['ישיבת הכותל', 'הרב ברוך וידר', 'שיחת מוסר'],
    type: 'audio_rss',
    url: 'https://anchor.fm/s/b76d9f2c/podcast/rss',
    description: 'שיחות ושיעורי תורה מישיבת הכותל בירושלים.'
  },

  // --- מוזיקה, ראיונות ותרבות יהודית ---
  {
    id: 'menachem_toker',
    category: 'מוזיקה וראיונות',
    name: 'פודקאסטר - מנחם טוקר',
    keywords: ['מנחם טוקר', 'טוקר', 'מוזיקה חסידית', 'זמרים'],
    type: 'audio_rss',
    url: 'https://rss.buzzsprout.com/2569538.rss',
    description: 'שיחות פתוחות, סיפורים ומוזיקה עם מנחם טוקר ואמני המוזיקה היהודית.'
  },
  {
    id: 'choshvim_tov',
    category: 'פסיכולוגיה וצמיחה אישית',
    name: 'חושבים טוב - יהודית כץ',
    keywords: ['חושבים טוב', 'יהודית כץ', 'פסיכולוגיה חיובית', 'מודעות'],
    type: 'audio_rss',
    url: 'https://feeds.simplecast.com/w2pVTj5d',
    description: 'פודקאסט מוביל בעברית על פסיכולוגיה חיובית, הרגלים ואיכות חיים.'
  },

  // --- היסטוריה, מדע, טכנולוגיה וכלכלה ---
  {
    id: 'osim_tech',
    category: 'טכנולוגיה ומדע',
    name: 'עושים טכנולוגיה - ד"ר יובל דרור',
    keywords: ['עושים טכנולוגיה', 'טכנולוגיה', 'יובל דרור', 'בינה מלאכותית פודקאסט'],
    type: 'audio_rss',
    url: 'https://www.spreaker.com/show/4231127/episodes/feed',
    description: 'מאחורי הקלעים של עולם הטכנולוגיה, הסייבר והבינה המלאכותית מרשת עושים היסטוריה.'
  },
  {
    id: 'osim_all',
    category: 'היסטוריה, מדע וידע כללי',
    name: 'רשת עושים היסטוריה - הערוץ הראשי',
    keywords: ['עושים היסטוריה', 'רן לוי', 'מדע', 'היסטוריה', 'עושים רפואה'],
    type: 'audio_rss',
    url: 'https://www.spreaker.com/show/4552198/episodes/feed',
    description: 'מיטב הפרקים מרשת הפודקאסטים עושים היסטוריה במדע, היסטוריה, רפואה ומשפט.'
  },
  {
    id: 'keshbagrosh',
    category: 'כלכלה וכסף',
    name: 'כשבגרוש היה חור - היסטוריה כלכלית',
    keywords: ['כשבגרוש היה חור', 'כלכלה', 'כסף', 'השקעות'],
    type: 'audio_rss',
    url: 'https://www.spreaker.com/show/4482630/episodes/feed',
    description: 'סיפורים מרתקים על כלכלה, כסף ומשברים פיננסיים בארץ ובעולם.'
  },
  {
    id: 'osim_tanach',
    category: 'תנ"ך והיסטוריה',
    name: 'עושים תנ"ך - יותם שטיינמן',
    keywords: ['עושים תנך', 'תנ"ך', 'ארכיאולוגיה', 'תקופת המקרא'],
    type: 'audio_rss',
    url: 'https://www.spreaker.com/show/4231125/episodes/feed',
    description: 'מסע היסטורי אל תקופת המקרא והמזרח הקדום.'
  },
  {
    id: 'schar_sofrim',
    category: 'שפה וספרות',
    name: 'שכר סופרים - מדברים עברית וספרות',
    keywords: ['שכר סופרים', 'ספרות', 'עברית'],
    type: 'audio_rss',
    url: 'https://feeds.captivate.fm/sofrim/',
    description: 'שיחות מרתקות על כתיבה, שפה ותרבות עברית.'
  },
  {
    id: 'live_kcm',
    category: 'מוזיקה ושידור חי',
    name: 'קול חי מיוזיק - שידור חי רציף',
    keywords: ['קול חי מיוזיק', 'שידור חי', 'מוזיקה חיה', 'רדיו מוזיקה'],
    type: 'live_stream',
    url: 'live_ext',
    description: 'מעבר ישיר לשלוחת השידור החי של קול חי מיוזיק.'
  }
];

const BLOCKED_CONTENT_RE = /שירי הבשורה|wordsoflife|messianic|ישוע\b/i;

function decodeBasicEntities(str) {
  return String(str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#0*34;/gi, '"')
    .replace(/&apos;|&#0*39;/gi, "'")
    .replace(/&#8211;|&#8212;/g, '-')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPlayableAudioUrl(url, mime) {
  const u = String(url || '').toLowerCase();
  const m = String(mime || '').toLowerCase();
  if (/\.(jpg|jpeg|png|gif|webp|svg|pdf)(\?|$)/i.test(u) || m.startsWith('image/')) return false;
  if (m.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|opus)(\?|$)/i.test(u)) return true;
  if (m.startsWith('video/mp4') || /\.mp4(\?|$)/i.test(u)) return true;
  return false;
}

// ============================================================================
// מאגר שירים וסינגלים עבריים/חסידיים מתעדכן מחזורית + חיפוש שירים לפי זמר/שיר
// ============================================================================
const musicStore = {
  lastRefreshedAt: 0,
  tracks: [],
  refreshing: null
};

const DEFAULT_MUSIC_RSS_SOURCES = [
  { name: 'חדשות המוזיקה - המחדש', url: 'https://hm-news.co.il/feed/' },
  { name: 'JDN מוזיקה וסינגלים', url: 'https://www.jdn.co.il/category/music/feed/' },
  { name: 'קול חי חדשות המוזיקה', url: 'https://www.93fm.co.il/feed/' }
];

const DEFAULT_ARTISTS_FOR_SEED = ['ישי ריבו', 'אברהם פריד', 'משה קליין', 'מרדכי בן דוד', 'עקיבא תורג׳מן'];

async function fetchTextSafe(url, timeoutMs = 10000) {
  const r = await fetch(url, {
    headers: { 'User-Agent': CRAWLER_UA, 'Accept': 'application/rss+xml,application/xml,text/xml,text/html,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.text();
}

function extractMp3LinksFromHtmlOrXml(rawText) {
  const matches = String(rawText || '').match(/https?:\/\/[^\s"'<>\\]+\.(?:mp3|m4a)(?:\?[^\s"'<>\\]*)?/gi) || [];
  const out = [];
  const seen = new Set();
  for (const m of matches) {
    const clean = decodeBasicEntities(m);
    if (!seen.has(clean) && !/doubleclick|ads|pixel/i.test(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

async function fetchItunesIsraelSongs(term, limit = 6) {
  const out = [];
  try {
    const u = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&country=IL&limit=${limit}`;
    const j = JSON.parse(await fetchTextSafe(u, 8000));
    for (const tr of (j.results || [])) {
      const title = `${tr.trackName || ''} - ${tr.artistName || ''}`.trim();
      if (tr.previewUrl && title && !BLOCKED_CONTENT_RE.test(title)) {
        out.push({
          id: 'it_s_' + tr.trackId,
          title,
          source: 'קטלוג שירים עברי/חסידי',
          audioUrl: tr.previewUrl
        });
      }
    }
  } catch (e) {}
  return out;
}

async function scrapeFreshMusicTracks(extraMusicFeeds = []) {
  const found = [];
  const seenUrls = new Set();
  const extraFromEnv = (() => {
    try { return JSON.parse(process.env.MUSIC_FEEDS || '[]'); } catch (e) { return []; }
  })();
  const sources = [...DEFAULT_MUSIC_RSS_SOURCES, ...extraFromEnv, ...extraMusicFeeds];

  // 1. שאיבת סינגלים מלאים מאתרי חדשות המוזיקה החסידית והיהודית
  await Promise.allSettled(sources.map(async src => {
    try {
      const xml = await fetchTextSafe(src.url, 9000);
      const parsed = xmlParser.parse(xml);
      const ch = (parsed.rss && parsed.rss.channel) || parsed.feed || {};
      const rawItems = ch.item || ch.entry || [];
      const items = (Array.isArray(rawItems) ? rawItems : [rawItems]).filter(Boolean).slice(0, 18);

      const needPageCheck = [];
      for (const it of items) {
        const title = decodeBasicEntities(it.title || '');
        if (!title || BLOCKED_CONTENT_RE.test(title)) continue;
        const link = decodeBasicEntities(it.link && (it.link['@_href'] || it.link) || '');
        const directMp3s = extractMp3LinksFromHtmlOrXml(JSON.stringify(it));

        if (directMp3s.length) {
          const u = directMp3s[0];
          if (!seenUrls.has(u)) {
            seenUrls.add(u);
            found.push({
              id: 'm_' + Buffer.from(u).toString('base64url').slice(-10),
              title,
              source: src.name + ' (סינגל מלא)',
              audioUrl: u,
              pageUrl: link
            });
          }
        } else if (link && /סינגל|שיר|דואט|ניגון|מחרוזת|אלבום|קליפ|מוזיקה/i.test(title) && needPageCheck.length < 5) {
          needPageCheck.push({ title, link, source: src.name });
        }
      }

      await Promise.allSettled(needPageCheck.map(async cand => {
        const html = await fetchTextSafe(cand.link, 7500);
        const pageMp3s = extractMp3LinksFromHtmlOrXml(html);
        if (pageMp3s.length && !seenUrls.has(pageMp3s[0])) {
          seenUrls.add(pageMp3s[0]);
          found.push({
            id: 'm_' + Buffer.from(pageMp3s[0]).toString('base64url').slice(-10),
            title: cand.title,
            source: cand.source + ' (סינגל מלא)',
            audioUrl: pageMp3s[0],
            pageUrl: cand.link
          });
        }
      }));
    } catch (e) {}
  }));

  // 2. העשרת המאגר בלהיטים יהודיים ועבריים מוכרים לחיפוש והשמעה מיידית
  const artistBatches = await Promise.allSettled(DEFAULT_ARTISTS_FOR_SEED.map(a => fetchItunesIsraelSongs(a, 3)));
  for (const b of artistBatches) {
    if (b.status === 'fulfilled') {
      for (const s of b.value) {
        if (!seenUrls.has(s.audioUrl)) {
          seenUrls.add(s.audioUrl);
          found.push(s);
        }
      }
    }
  }

  if (found.length) {
    musicStore.tracks = found.slice(0, 45);
    musicStore.lastRefreshedAt = Date.now();
  }
  return musicStore.tracks;
}

async function getMusicCatalog(forceRefresh = false, extraFeeds = []) {
  const age = Date.now() - musicStore.lastRefreshedAt;
  if (!forceRefresh && musicStore.tracks.length && age < 30 * 60000) {
    return musicStore.tracks;
  }
  if (!musicStore.refreshing) {
    musicStore.refreshing = scrapeFreshMusicTracks(extraFeeds).finally(() => {
      musicStore.refreshing = null;
    });
  }
  return await musicStore.refreshing;
}

async function searchSongsLive(query, jamendoClientId = '') {
  const q = String(query || '').trim();
  const baseTracks = await getMusicCatalog(false);
  const qWords = q.toLowerCase().split(/\s+/).filter(w => w.length >= 2 && !/^(שיר|שירים|נגן|השמע|של|חדש|חדשים)$/.test(w));

  let matched = qWords.length
    ? baseTracks.filter(t => qWords.some(w => t.title.toLowerCase().includes(w)))
    : baseTracks.slice(0, 12);

  // חיפוש חי לפי שם הזמר או השיר בספריית המוזיקה הישראלית
  if (q && qWords.length) {
    const liveSongs = await fetchItunesIsraelSongs(qWords.join(' '), 8);
    const seen = new Set(matched.map(x => x.audioUrl));
    for (const s of liveSongs) {
      if (!seen.has(s.audioUrl)) {
        seen.add(s.audioUrl);
        matched.push(s);
      }
    }
  }

  if (jamendoClientId && q) {
    try {
      const ju = `https://api.jamendo.com/v3.0/tracks/?client_id=${encodeURIComponent(jamendoClientId)}&format=json&limit=5&search=${encodeURIComponent(q)}&audioformat=mp32`;
      const jj = JSON.parse(await fetchTextSafe(ju, 7500));
      for (const tr of (jj.results || [])) {
        if (tr.audio) matched.push({ id: 'jm_' + tr.id, title: `${tr.name} - ${tr.artist_name}`, source: 'Jamendo', audioUrl: tr.audio });
      }
    } catch (e) {}
  }

  return matched.length ? matched.slice(0, 12) : baseTracks.slice(0, 10);
}

async function resolveYoutubeAudioUrl(youtubeUrl) {
  const u = String(youtubeUrl || '').trim();
  if (!/youtube\.com|youtu\.be/i.test(u)) return null;
  try {
    const r = await fetch('https://api.cobalt.tools/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': CRAWLER_UA },
      body: JSON.stringify({ url: u, downloadMode: 'audio', audioFormat: 'mp3' }),
      signal: AbortSignal.timeout(9000)
    });
    if (r.ok) {
      const j = await r.json();
      if (j && j.url) return j.url;
    }
  } catch (e) {}
  return null;
}

// ============================================================================
// חיפוש פודקאסטים בקטלוג המובנה + חיפוש חי ב-Apple Podcasts ישראל ושליפת פרקים
// ============================================================================
const dynamicPodcastsCache = {};

async function searchPodcastsDirectory(query, extraRadioFeeds = []) {
  const q = String(query || '').trim().toLowerCase();
  const mergedShows = [
    ...CURATED_PODCASTS_AND_RADIO,
    ...extraRadioFeeds.map((f, idx) => ({
      id: 'env_rf_' + idx,
      category: 'תחנות מוגדרות',
      name: f.n,
      keywords: [f.n.toLowerCase()],
      type: 'audio_rss',
      url: f.u,
      description: f.n
    })),
    ...Object.values(dynamicPodcastsCache)
  ];

  const uniqueShows = [];
  const seenU = new Set();
  for (const sh of mergedShows) {
    if (seenU.has(sh.url) || BLOCKED_CONTENT_RE.test(sh.name)) continue;
    seenU.add(sh.url);
    uniqueShows.push(sh);
  }

  if (!q) return uniqueShows;

  let matches = uniqueShows.filter(sh =>
    sh.name.toLowerCase().includes(q) ||
    sh.category.toLowerCase().includes(q) ||
    (sh.keywords || []).some(k => k.toLowerCase().includes(q) || q.includes(k.toLowerCase()))
  );

  if (matches.length < 2 && q.length >= 2) {
    try {
      const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=podcast&country=IL&limit=6`;
      const ij = JSON.parse(await fetchTextSafe(itunesUrl, 8000));
      for (const item of (ij.results || [])) {
        const cName = decodeBasicEntities(item.collectionName || query);
        if (item.feedUrl && !seenU.has(item.feedUrl) && !BLOCKED_CONTENT_RE.test(cName)) {
          seenU.add(item.feedUrl);
          const dynShow = {
            id: 'it_' + item.collectionId,
            category: item.primaryGenreName || 'פודקאסט',
            name: cName,
            artist: decodeBasicEntities(item.artistName || ''),
            keywords: [q],
            type: 'audio_rss',
            url: item.feedUrl,
            description: `פודקאסט מאת ${decodeBasicEntities(item.artistName || '')} (${item.trackCount || '?'} פרקים)`
          };
          dynamicPodcastsCache[dynShow.id] = dynShow;
          matches.push(dynShow);
        }
      }
    } catch (e) {}
  }

  return matches.length ? matches : uniqueShows.slice(0, 12);
}

async function fetchShowEpisodes(feedUrl, limit = 15) {
  const xml = await fetchTextSafe(feedUrl, 11000);
  const parsed = xmlParser.parse(xml);
  const ch = (parsed.rss && parsed.rss.channel) || parsed.feed || {};
  const showTitle = decodeBasicEntities(ch.title || '');
  const rawItems = ch.item || ch.entry || [];
  const list = (Array.isArray(rawItems) ? rawItems : [rawItems]).filter(Boolean);

  const episodes = [];
  const headlines = [];

  for (let i = 0; i < Math.min(30, list.length); i++) {
    const it = list[i];
    const title = decodeBasicEntities(it.title || `פרק ${i + 1}`);
    const summary = decodeBasicEntities(it.description || it['itunes:summary'] || it.summary || '').slice(0, 220);
    const guid = decodeBasicEntities((it.guid && (it.guid['#text'] || it.guid)) || it.id || title);
    const pubDate = decodeBasicEntities(it.pubDate || it.published || '');

    headlines.push({ index: i + 1, title, summary, pubDate });

    const encs = [];
    if (it.enclosure) encs.push(...(Array.isArray(it.enclosure) ? it.enclosure : [it.enclosure]));
    if (it['media:content']) encs.push(...(Array.isArray(it['media:content']) ? it['media:content'] : [it['media:content']]));
    for (const enc of encs) {
      const u = decodeBasicEntities((enc && (enc['@_url'] || enc.url)) || '');
      const tp = (enc && (enc['@_type'] || enc.type)) || '';
      if (u && isPlayableAudioUrl(u, tp)) {
        episodes.push({
          index: episodes.length + 1,
          guid: String(guid).slice(0, 120),
          title,
          summary,
          pubDate,
          audioUrl: u
        });
        break;
      }
    }
    if (episodes.length >= limit) break;
  }

  return { showTitle, episodes, headlines: headlines.slice(0, 10) };
}

module.exports = {
  CURATED_PODCASTS_AND_RADIO,
  musicStore,
  getMusicCatalog,
  searchSongsLive,
  resolveYoutubeAudioUrl,
  searchPodcastsDirectory,
  fetchShowEpisodes,
  isPlayableAudioUrl
};
