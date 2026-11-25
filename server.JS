const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const execFileP = require('util').promisify(require('child_process').execFile);
const { XMLParser } = require('fast-xml-parser');

// סגירה מיידית בעת פריסה חדשה ב-Render כדי למנוע תקיעה במצב Deploying
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

const FFMPEG = process.env.FFMPEG_PATH || (() => { try { return require('ffmpeg-static'); } catch (e) { return null; } })();
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '1mb' }));

// --- מפתחות והגדרות בסיס ---
const keyList = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const KEYS = keyList(process.env.GEMINI_API_KEYS);
const TTS_KEYS = keyList(process.env.GEMINI_TTS_KEYS).length ? keyList(process.env.GEMINI_TTS_KEYS) : KEYS;
const GROQ_KEYS = keyList(process.env.GROQ_API_KEYS);
const MAPS_KEY = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
const SEARCH_KEY = String(process.env.GOOGLE_SEARCH_KEY || MAPS_KEY || KEYS[0] || '').trim();
const SEARCH_CX = String(process.env.GOOGLE_SEARCH_CX || '').trim();

const GROQ_BASE = process.env.GROQ_BASE || 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = process.env.GROQ_SEARCH_MODEL || 'openai/gpt-oss-120b';

const TEXT_MODEL = String(process.env.TEXT_MODEL || '').trim() || 'gemini-3.6-flash';
const TEXT_FALLBACK_LIST = keyList(process.env.TEXT_MODEL_FALLBACK || 'gemini-3.5-flash-lite,gemini-3.1-flash-lite')
  .filter(m => m !== 'none' && m !== TEXT_MODEL);
const TEXT_MODELS = [TEXT_MODEL, ...TEXT_FALLBACK_LIST];

const IMAGE_MODEL = String(process.env.IMAGE_MODEL || '').trim() || 'gemini-3.1-flash-image-preview';
const DEFAULT_TTS_MODELS = 'gemini-3.8-flash-tts,gemini-3.8-flash-lite-tts,gemini-3.1-flash-tts-preview,gemini-2.5-flash-preview-tts';
const TTS_LIST = keyList(process.env.TTS_MODEL || DEFAULT_TTS_MODELS).map(m => {
  if (m === 'gemini-3.1-flash-tts') return 'gemini-3.1-flash-tts-preview';
  if (m === 'gemini-2.5-flash-tts') return 'gemini-2.5-flash-preview-tts';
  return m;
});

const VOICE = process.env.VOICE_FEMALE || process.env.VOICE || 'Kore';
const EXT = (process.env.EXT_PATH || '1').replace(/^\/+|\/+$/g, '') || '1';
const HISTORY_EXT = String(process.env.HISTORY_EXT || '').replace(/^\/+|\/+$/g, '');
const LIVE_STREAM_EXT = String(process.env.LIVE_STREAM_EXT || '').replace(/^\/+|\/+$/g, '');

const TOKEN = process.env.YEMOT_TOKEN ||
  (process.env.YEMOT_API_USERNAME && process.env.YEMOT_API_PASSWORD
    ? process.env.YEMOT_API_USERNAME + ':' + process.env.YEMOT_API_PASSWORD
    : '');

const YM = process.env.YEMOT_BASE || 'https://www.call2all.co.il/ym/api/';
const GBASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta/models/';
const BUDGET = Number(process.env.TURN_BUDGET_MS) || 85000;
const REC_MAX = String(parseInt(process.env.REC_MAX, 10) || 30);
const CRAWLER_UA = 'Mozilla/5.0 (compatible; Google-Agent; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent)';

// --- שעון ישראל (Asia/Jerusalem) ונרמול זמנים ---
function getIsraelOffsetMinutes(date = new Date()) {
  try {
    const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
    const ilStr = date.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' });
    return Math.round((new Date(ilStr) - new Date(utcStr)) / 60000);
  } catch (e) {
    return 120;
  }
}

function formatOffset(offsetMin) {
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

function nowIsraelInfo(date = new Date()) {
  const offsetMin = getIsraelOffsetMinutes(date);
  const offsetStr = formatOffset(offsetMin);
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date)) {
    parts[p.type] = p.value;
  }
  const hh = parts.hour === '24' ? '00' : parts.hour;
  const isoLocal = `${parts.year}-${parts.month}-${parts.day}T${hh}:${parts.minute}:${parts.second}${offsetStr}`;
  const humanHe = new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
  const shortStamp = `${parts.day}/${parts.month} ${hh}:${parts.minute}`;
  return { isoLocal, humanHe, offsetStr, offsetMin, parts: { ...parts, hour: hh }, shortStamp };
}

function parseIsraelTimeInput(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s || /^now$/i.test(s) || s === 'עכשיו') return null;

  // יחסי בדקות: "+30m" / "in 30 minutes"
  const relMatch = /^\+?\s*(\d{1,4})\s*(?:m|min|mins|minutes|דקות)$/i.exec(s);
  if (relMatch) {
    return new Date(Date.now() + Number(relMatch[1]) * 60000).toISOString();
  }

  // Unix timestamp בשניות או מילישניות
  if (/^\d{10,13}$/.test(s)) {
    const ms = s.length === 10 ? Number(s) * 1000 : Number(s);
    if (ms > Date.now() - 120000) return new Date(ms).toISOString();
    return null;
  }

  // שעה בלבד "HH:MM" -> היום בישראל (או מחר אם כבר עברה)
  const hmMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (hmMatch) {
    const nowInfo = nowIsraelInfo();
    const hh = String(Math.min(23, Number(hmMatch[1]))).padStart(2, '0');
    const mm = String(Math.min(59, Number(hmMatch[2]))).padStart(2, '0');
    let candidate = new Date(`${nowInfo.parts.year}-${nowInfo.parts.month}-${nowInfo.parts.day}T${hh}:${mm}:00${nowInfo.offsetStr}`);
    if (candidate.getTime() < Date.now() - 300000) {
      candidate = new Date(candidate.getTime() + 86400000);
    }
    return candidate.toISOString();
  }

  // תאריך-שעה ללא אזור זמן (לדוגמה "2026-11-25T08:00:00" או "2026-11-25 08:00")
  const noTzMatch = /^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2}(?::\d{2})?)$/.exec(s);
  if (noTzMatch) {
    const timePart = noTzMatch[2].length === 5 ? noTzMatch[2] + ':00' : noTzMatch[2];
    const approx = new Date(`${noTzMatch[1]}T12:00:00Z`);
    const offsetStr = formatOffset(getIsraelOffsetMinutes(Number.isNaN(approx.getTime()) ? new Date() : approx));
    const parsed = new Date(`${noTzMatch[1]}T${timePart}${offsetStr}`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.getTime() < Date.now() - 300000 ? null : parsed.toISOString();
    }
  }

  // מחרוזת ISO מלאה עם Z או היסט חוקי
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(s)) {
    const parsed = new Date(s);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.getTime() < Date.now() - 300000 ? null : parsed.toISOString();
    }
  }

  return null;
}

function nextMorningIsraelIso() {
  const info = nowIsraelInfo();
  const h = Number(info.parts.hour);
  let target = new Date(`${info.parts.year}-${info.parts.month}-${info.parts.day}T07:00:00${info.offsetStr}`);
  if (h >= 7) target = new Date(target.getTime() + 86400000);
  return target.toISOString();
}

// --- שליחת מייל דרך Google Apps Script ---
const TARGET_EMAIL = String(process.env.TARGET_EMAIL || '').trim();
const GAS_MAIL_URL = String(process.env.GAS_MAIL_URL || '').trim();
const GAS_MAIL_SECRET = String(process.env.GAS_MAIL_SECRET || 'kav-ai-secret-2026').trim();

async function sendViaGasEmail({ subject, body, files }, deadline) {
  if (!GAS_MAIL_URL || !TARGET_EMAIL) {
    throw new Error('חסרה הגדרת GAS_MAIL_URL או TARGET_EMAIL בשרת');
  }
  if (GAS_MAIL_URL.includes('/macros/library/')) {
    throw new Error('כתובת GAS_MAIL_URL היא כתובת ספרייה ולא כתובת Web App (/macros/s/.../exec)');
  }
  const r = await http(GAS_MAIL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    redirect: 'follow',
    body: JSON.stringify({
      token: GAS_MAIL_SECRET,
      to: TARGET_EMAIL,
      subject,
      body,
      files: files || []
    })
  }, 30000, deadline);
  const txt = await r.text();
  let j = {};
  try { j = JSON.parse(txt); } catch (e) {}
  if (!r.ok || j.ok === false) {
    throw new Error('שגיאת Google Apps Script: ' + (j.error || txt.slice(0, 120)));
  }
  return true;
}

// --- הגדרות רדיו RSS ושידור חי ---
const DEFAULT_FEEDS = [
  { n: 'חדשות כאן', u: 'https://www.spreaker.com/show/6095076/episodes/feed' },
  { n: 'כאן רשת ב', u: 'https://omny.fm/shows/kan-news/playlists/podcast.rss' },
  { n: 'קול חי', u: 'https://www.93fm.co.il/feed/' },
  { n: 'חדשות JDN', u: 'https://www.jdn.co.il/feed/' }
];

function parseRadioFeeds() {
  let parsed = [];
  try {
    const rawFeeds = String(process.env.RADIO_FEEDS || '').trim().replace(/^'+|'+$/g, '');
    if (rawFeeds) parsed = JSON.parse(rawFeeds);
  } catch (e) {
    parsed = [];
  }
  const cleaned = (Array.isArray(parsed) ? parsed : [])
    .map(f => {
      if (!f || !f.n) return null;
      let u = String(f.u || '').trim();
      const mdMatch = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(u);
      if (mdMatch) u = mdMatch[2];
      // תיקון אוטומטי של קישור Omny הישן שהוחלף במהדורת השעה הפעילה של כאן
      if (u.includes('2ee97a4e-8795-4260-9648-accf00a38c6a')) {
        u = 'https://www.spreaker.com/show/6095076/episodes/feed';
      }
      return /^https?:\/\//i.test(u) ? { n: String(f.n).trim(), u } : null;
    })
    .filter(Boolean);
  return cleaned.length ? cleaned : DEFAULT_FEEDS;
}
const RADIO_FEEDS = parseRadioFeeds();

// --- פונקציות עזר ---
const sp = s => String(s || '').replace(/[.\-"'&|,=*#\[\]<>()]/g, ' ').replace(/\s+/g, ' ').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isBudget = e => !!(e && e.budget);
const rot = { text: 0, tts: 0 };
const RETRY_STATUS = [429, 500, 502, 503, 504];
const calls = {};

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*34;/g, '"')
    .replace(/&apos;|&#0*39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return n > 31 && n < 65535 ? String.fromCharCode(n) : ' ';
    });
}

const stripHtml = h => decodeHtmlEntities(String(h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, '. '))
  .replace(/\s*\.\s*\.\s*/g, '. ')
  .replace(/\s+/g, ' ')
  .trim();

setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(calls)) {
    if (now - calls[id].t > 3600000) {
      cleanupReplyFiles(calls[id]);
      delete calls[id];
    }
  }
}, 600000).unref();

async function http(url, opt, ms, deadline) {
  const left = deadline ? deadline - Date.now() : ms;
  if (left < 800) { const e = new Error('turn budget exhausted'); e.budget = true; throw e; }
  return fetch(url, { ...opt, signal: AbortSignal.timeout(Math.min(ms, left)) });
}

function pushStatus(s, text) {
  if (!s || !text || s.cancelled) return;
  const clean = String(text).replace(/[*#_\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
  if (!clean) return;
  s.statusQueue = s.statusQueue || [];
  if (s.statusQueue[s.statusQueue.length - 1] !== clean) {
    s.statusQueue.push(clean);
  }
  if (s.onStatus) { const fn = s.onStatus; s.onStatus = null; fn(); }
}

// ============================================================================
// זיכרון מתקשר קבוע והיסטוריית שיחות על גבי אחסון ימות המשיח (שלוחה 9)
// ============================================================================
const callerCache = {};

function memFilePath(phone) {
  const p = String(phone || '').replace(/\D/g, '');
  if (!p || !HISTORY_EXT || !TOKEN) return '';
  return `ivr2:/${HISTORY_EXT}/mem_${p}.ini`;
}

async function loadCallerMemory(phone) {
  const p = String(phone || '').replace(/\D/g, '');
  if (!p) return null;
  if (callerCache[p] && Date.now() - callerCache[p].loadedAt < 600000) {
    return callerCache[p].data;
  }
  const what = memFilePath(p);
  const empty = { phone: p, vc: '', pace: '', len: '', notes: [], conversations: [] };
  if (!what) return empty;
  try {
    const u = YM + 'GetTextFile?token=' + encodeURIComponent(TOKEN) + '&what=' + encodeURIComponent(what);
    const r = await fetch(u, { headers: { 'User-Agent': CRAWLER_UA }, signal: AbortSignal.timeout(4500) });
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus === 'OK' && j.contents) {
      const parsed = JSON.parse(j.contents);
      const data = {
        phone: p,
        vc: parsed.vc || '',
        pace: parsed.pace || '',
        len: parsed.len || '',
        notes: Array.isArray(parsed.notes) ? parsed.notes.slice(0, 15) : [],
        conversations: Array.isArray(parsed.conversations) ? parsed.conversations.slice(0, 15) : []
      };
      callerCache[p] = { loadedAt: Date.now(), data };
      return data;
    }
  } catch (e) {}
  callerCache[p] = { loadedAt: Date.now(), data: empty };
  return empty;
}

async function saveCallerMemoryBg(phone, data) {
  const p = String(phone || '').replace(/\D/g, '');
  const what = memFilePath(p);
  if (!p || !what || !data) return false;
  callerCache[p] = { loadedAt: Date.now(), data };
  try {
    const payload = JSON.stringify({
      phone: p,
      vc: data.vc || '',
      pace: data.pace || '',
      len: data.len || '',
      notes: (data.notes || []).slice(0, 15),
      conversations: (data.conversations || []).slice(0, 12)
    });
    const body = new URLSearchParams({ token: TOKEN, what, contents: payload }).toString();
    const r = await fetch(YM + 'UploadTextFile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CRAWLER_UA },
      body,
      signal: AbortSignal.timeout(7000)
    });
    const j = await r.json().catch(() => ({}));
    return j.responseStatus === 'OK';
  } catch (e) {
    console.error('saveCallerMemoryBg error:', e.message);
    return false;
  }
}

async function recordTurnInCallerHistory(s, questionText, answerText) {
  if (!s || !s.ph || !HISTORY_EXT) return;
  const mem = await loadCallerMemory(s.ph);
  if (!mem) return;
  mem.vc = s.vc || '';
  mem.pace = s.pace || '';
  mem.len = s.len || '';

  const stamp = nowIsraelInfo().shortStamp;
  const cleanQ = String(questionText || 'שאלה קולית').replace(/\s+/g, ' ').trim().slice(0, 220);
  const cleanA = String(answerText || '').replace(/\s+/g, ' ').trim().slice(0, 2200);

  if (!s.convId) {
    s.convId = 'c_' + Date.now().toString(36);
  }
  let conv = mem.conversations.find(c => c.id === s.convId);
  if (!conv) {
    conv = {
      id: s.convId,
      title: cleanQ.slice(0, 55),
      updatedAt: stamp,
      turns: []
    };
    mem.conversations.unshift(conv);
  } else {
    conv.updatedAt = stamp;
    mem.conversations = [conv, ...mem.conversations.filter(c => c.id !== s.convId)];
  }
  conv.turns.push({ q: cleanQ, a: cleanA });
  if (conv.turns.length > 10) conv.turns = conv.turns.slice(-10);
  if (mem.conversations.length > 12) mem.conversations = mem.conversations.slice(0, 12);

  await saveCallerMemoryBg(s.ph, mem);
}

// ============================================================================
// הנחיית המערכת הסוכנותית הרב-שלבית (Plan -> Act -> Verify -> Synthesize)
// ============================================================================
const VOICE_CTL = ' אם המשתמש מבקש לשנות את הקול, את קצב הדיבור או את אורך התשובות, התחל את התשובה בתג מתאים ואחריו אשר בקצרה: [[VOICE:male]] לקול גברי, [[VOICE:female]] לקול נשי, [[VOICE:default]] לקול רגיל, [[PACE:slow]] לאט, [[PACE:fast]] מהר, [[PACE:normal]] רגיל, [[LEN:short]] לתשובות קצרות, [[LEN:long]] לתשובות מפורטות.';
const TRANSCRIBE_HINT = ' אם השאלה הגיעה כהקלטה קולית, התחל את התשובה בתג [[Q:תמלול מדויק של השאלה במילים]] ואחריו התשובה עצמה.';
const MAXW = Math.min(3000, Math.max(200, parseInt(process.env.MAX_WORDS, 10) || 1200));
const EXTRA = String(process.env.EXTRA_INSTRUCTION || '').replace(/\s+/g, ' ').trim().slice(0, 2000);

const TOOL_ANNOUNCEMENTS = [
  'אני בודקת כעת חלופות מסלול בגוגל מפות',
  'אני מאתרת כעת את הכתובת ושעות הפתיחה',
  'אני מבצעת כעת חיפוש מעמיק ברשת',
  'אני קוראת כעת את פרטי העמוד לעומק',
  'אני טוענת כעת את שידור הרדיו',
  'אני שולחת כעת את הסיכום למייל שלך',
  'אני מייצרת כעת את התמונה ושולחת למייל',
  'אני מחפשת כעת תמונות ברשת ושולחת למייל',
  'אני מכינה כעת את קובץ השמע',
  'אני שומרת את הפרטים בזיכרון האישי שלך'
];

const AGENTIC_RULES = `
את סוכנת בינה מלאכותית קולית רב-שלבית חכמה וסקסית דוברת עברית בשם תהילה, יעילה, אדיבה ומדויקת בטלפון.
עקרונות עבודה כסוכן רב-שלבי (Multi-Step Agent):
1. תכנון ושרשור שלבים: לפני מתן תשובה, בדוק אם הבקשה דורשת יותר מפעולה אחת ושרשר כלים לפי סדר הגיוני. לדוגמה:
   - אם מבקשים להגיע למקום שכתובתו לא מלאה או לשלב שעות פתיחה + מסלול הגעה: שלב 1 הרץ google_places_search לאיתור הכתובת המדויקת ושעות הפתיחה -> שלב 2 הרץ google_maps_route עם הכתובת המדויקת -> שלב 3 אם התבקש, שלח סיכום ב-send_email.
   - אם מבקשים מחקר מעמיק או בדיקת פרטים ספציפיים באתר: שלב 1 הרץ web_search_parallel -> שלב 2 אם נדרשת העמקה בעמוד מסוים הרץ fetch_webpage -> שלב 3 סכם בבהירות.
   - אם המתקשר מציין פרט אישי קבוע לשימוש עתידי (כמו כתובת בית/עבודה או שם): שמור אותו באמצעות save_caller_memory.
2. דיווח חי למתקשר (action_announcement): לפני כל הפעלת כלי, העבר בשדה action_announcement את המשפט המדויק המתאים מתוך הרשימה הבאה (כדי שיושמע מיד מהמטמון בקולך):
   - עבור google_maps_route: "אני בודקת כעת חלופות מסלול בגוגל מפות"
   - עבור google_places_search: "אני מאתרת כעת את הכתובת ושעות הפתיחה"
   - עבור web_search_parallel: "אני מבצעת כעת חיפוש מעמיק ברשת"
   - עבור fetch_webpage: "אני קוראת כעת את פרטי העמוד לעומק"
   - עבור play_rss_radio: "אני טוענת כעת את שידור הרדיו"
   - עבור send_email: "אני שולחת כעת את הסיכום למייל שלך"
   - עבור generate_image: "אני מייצרת כעת את התמונה ושולחת למייל"
   - עבור search_and_email_images: "אני מחפשת כעת תמונות ברשת ושולחת למייל"
   - עבור generate_audio: "אני מכינה כעת את קובץ השמע"
   - עבור save_caller_memory: "אני שומרת את הפרטים בזיכרון האישי שלך"
3. תחבורה ציבורית וניווט (google_maps_route): חובה להשתמש ב-google_maps_route לכל שאלת הגעה, אוטובוס, רכבת, רכבת קלה או זמני נסיעה בישראל. לעולם אל תנחש מסלולים או זמני קווים מידע כללי או מחיפוש רשת!
   - כאשר הכלי google_maps_route מחזיר recommended_spoken_response, השתמש בניסוח המדויק שלו בשלמותו: הצג תחילה פירוט מלא, טבעי ומדויק של החלופה הראשונה (המהירה ביותר) כולל כל התחנות, הקווים, ההליכות והשעות, מיד אחריה הצג תקציר קצר וברור של חלופות 2 ו-3, וסיים בהנחיית המקשים של תפריט המסלולים. אם המשתמש שאל שאלה נוספת באותו תור (כמו שעות פתיחה או שליחה למייל), שלב את התשובה עליה בתחילת הדברים ואז מסור את פירוט המסלולים המלא.
4. חיפוש מקומות ועסקים (google_places_search): השתמש בכלי זה למציאת כתובות מדויקות, שעות פתיחה, מספרי טלפון ובתי עסק/מוסדות בישראל.
5. מייל, תמונות, אודיו ורדיו:
   - לשליחת סיכום כתוב, מסלול, רשימה או מידע למייל המוגדר: הפעל send_email.
   - ליצירת תמונות חדשות בבינה מלאכותית ושליחתן למייל: הפעל generate_image (נסח פרומפט עשיר באנגלית).
   - לחיפוש תמונות אמיתיות קיימות באינטרנט (של מקום, מוצר, אישיות או נוף) ושליחתן למייל: הפעל search_and_email_images.
   - ליצירת קובץ קריינות מיוחד: הפעל generate_audio.
   - להאזנה לחדשות, רדיו RSS או שידור חי: הפעל play_rss_radio (אם הוחזרו כותרות חדשות טקסטואליות במצב headlines, הקרא מהדורת חדשות מסודרת ורהוטה מתוך הפריטים שחזרו).
6. סגנון דיבור בטלפון: דבר בעברית טבעית, רהוטה, חמה ומדויקת. אל תקריא כוכביות, סולמיות, סוגריים מרובעים או כתובות URL. כתוב מספרים ושעות בצורה ברורה להקראה, עד ${MAXW} מילים.
`.replace(/\s+/g, ' ').trim();

const buildBaseSys = (mode, extra) => AGENTIC_RULES + ' ' +
  (EXTRA ? 'הנחיית מנהל המערכת: ' + EXTRA + ' ' : '') +
  (extra ? 'הנחיית שלוחה: ' + extra + ' ' : '') + VOICE_CTL + TRANSCRIBE_HINT;

function buildDynamicTurnSys(s) {
  const parts = [s.sys];
  const clock = nowIsraelInfo();
  parts.push(`הזמן הנוכחי בישראל כעת: ${clock.humanHe} (ISO: ${clock.isoLocal}). השתמש בזמן זה לחישוב "עכשיו", "היום", "מחר" וזמני יציאה/הגעה.`);

  if (s.callerMem && Array.isArray(s.callerMem.notes) && s.callerMem.notes.length) {
    parts.push(`פרטים קבועים שנשמרו עבור מתקשר זה: ${s.callerMem.notes.join(' | ')}.`);
  }
  if (s.interruptedLast) {
    parts.push(`הערת הקשר: המתקשר קטע את התשובה הקודמת שלך באמצע ההשמעה כדי לשאול או לבקש משהו חדש.`);
  }

  const wm = s.workingMemory || {};
  const wmNotes = [];
  if (wm.lastRoutes && wm.lastRoutes.length) {
    wmNotes.push('מסלולי תח"צ אחרונים שחושבו בשיחה: ' + wm.lastRoutes.map(r => `חלופה ${r.option} (${r.lines}, יציאה ${r.departure}, הגעה ${r.arrival}, סה"כ ${r.duration}): ${r.fullText}`).join(' || ').slice(0, 1800));
  }
  if (wm.lastPlaces && wm.lastPlaces.length) {
    wmNotes.push('מקומות אחרונים שאותרו: ' + JSON.stringify(wm.lastPlaces).slice(0, 900));
  }
  if (wm.lastSearch) {
    wmNotes.push('ממצאי חיפוש אחרונים מהשיחה: ' + String(wm.lastSearch).slice(0, 900));
  }
  if (wmNotes.length) {
    parts.push('זיכרון עבודה מהתורות הקודמים בשיחה (לשימוש בשאלות המשך או שליחה למייל): ' + wmNotes.join(' | '));
  }
  if (s.len === 'short') {
    parts.push('הנחיה פעילה מהמשתמש: ענה בקצרה ובתמציתיות, בשניים עד ארבעה משפטים (למעט אם נדרש פירוט מסלול תח"צ).');
  }
  return parts.join('\n');
}

// ============================================================================
// תקשורת מול Gemini API (שרשרת מודלים וגיבוי אוטומטי)
// ============================================================================
async function gem(model, body, deadline, pool, opt) {
  pool = pool || 'text';
  opt = opt || {};
  const list = pool === 'tts' ? TTS_KEYS : KEYS;
  if (!list.length) throw new Error(pool === 'tts' ? 'GEMINI_TTS_KEYS is empty' : 'GEMINI_API_KEYS is empty');
  const tries = list.length + (opt.retries === undefined ? 1 : opt.retries);
  let err = model + ' failed', status = 0;
  for (let i = 0; i < tries; i++) {
    const key = list[rot[pool]++ % list.length];
    try {
      const r = await http(GBASE + model + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body)
      }, opt.ms || 30000, deadline);
      if (r.ok) return await r.json();
      status = r.status;
      err = model + ' ' + r.status + ' ' + (await r.text()).slice(0, 220);
      if (!RETRY_STATUS.includes(r.status)) break;
    } catch (e) {
      if (isBudget(e)) throw e;
      status = 0;
      err = model + ' ' + (e.name === 'TimeoutError' ? 'timeout' : e.message);
    }
    if (i < tries - 1) await sleep(350 * (i + 1));
  }
  const e = new Error(err); e.status = status; throw e;
}

const THINK = ['low', 'minimal', null];
const thinkIdx = {};
const downUntil = {};

async function textGen(body, deadline) {
  let lastErr;
  for (let m = 0; m < TEXT_MODELS.length; m++) {
    const model = TEXT_MODELS[m];
    const hasNext = m < TEXT_MODELS.length - 1;
    if (hasNext && (downUntil[model] || 0) > Date.now()) continue;
    for (;;) {
      const lvl = THINK[thinkIdx[model] || 0];
      const gc = { maxOutputTokens: 8192 };
      if (lvl) gc.thinkingConfig = { thinkingLevel: lvl };
      try {
        return await gem(model, { ...body, generationConfig: gc }, deadline, 'text', hasNext ? { retries: 0, ms: 28000 } : { ms: 42000 });
      } catch (e) {
        lastErr = e;
        if (e.status === 400 && /think/i.test(e.message) && (thinkIdx[model] || 0) < THINK.length - 1) {
          thinkIdx[model] = (thinkIdx[model] || 0) + 1;
          continue;
        }
        break;
      }
    }
    if (isBudget(lastErr)) throw lastErr;
    if (!hasNext && !(RETRY_STATUS.includes(lastErr.status) || lastErr.status === 0)) throw lastErr;
    if (hasNext) downUntil[model] = Date.now() + (lastErr.status === 404 ? 3600000 : 120000);
  }
  throw lastErr;
}

// ============================================================================
// מנוע עריכת שפה לתחבורה ציבורית בעברית (Natural Hebrew Transit Phrasing)
// ============================================================================
function cleanTransitHe(str) {
  if (!str) return '';
  return decodeHtmlEntities(String(str))
    .replace(/<[^>]+>/g, ' ')
    .replace(/<->|->|↔/g, ' עד ')
    .replace(/_/g, ', ')
    .replace(/''/g, '"')
    .replace(/(^|[^א-ת])ת\.\s*מרכזית(?=[^א-ת]|$)/g, '$1תחנה מרכזית')
    .replace(/(^|[^א-ת])ת\.\s*רכבת(?=[^א-ת]|$)/g, '$1תחנת רכבת')
    .replace(/(^|[^א-ת])ת\.\s*אוטובוסים(?=[^א-ת]|$)/g, '$1תחנת אוטובוסים')
    .replace(/(^|[\s,/(-])שד['׳"]\s*/g, '$1שדרות ')
    .replace(/(^|[\s,/(-])רח['׳"]\s*/g, '$1רחוב ')
    .replace(/(^|[\s,/(-])צ['׳.]\s*/g, '$1צומת ')
    .replace(/(^|[\s,/(-])מחל['׳"]\s*/g, '$1מחלף ')
    .replace(/(^|[^א-ת])בי["״']ח(?=[^א-ת]|$)/g, '$1בית חולים')
    .replace(/(^|[^א-ת])ביה["״']ח(?=[^א-ת]|$)/g, '$1בית חולים')
    .replace(/(^|[^א-ת])ביה["״']ס(?=[^א-ת]|$)/g, '$1בית ספר')
    .replace(/(^|[\s,/(-])ק\.\s*(?=[א-ת])/g, '$1קריית ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanStopName(rawName) {
  let s = cleanTransitHe(rawName);
  if (!s) return '';
  // הסרת מספרי רציף/קוד זנב מיותרים בסוף שם קו אך שמירה על רציף ברור
  if (s.includes('/')) {
    const [a, b, ...rest] = s.split('/').map(x => x.trim()).filter(Boolean);
    if (a && b) {
      if (/^(?:תחנה מרכזית|תחנת רכבת|מסוף|קניון|מרכז|בית חולים|שער|מחלף|צומת|גשר)/.test(a) || /^(?:רציף|רציפים|קומה|כניסה|יציאה)/.test(b)) {
        s = [a, b, ...rest].join(', ');
      } else {
        s = `${a} פינת ${b}` + (rest.length ? `, ${rest.join(', ')}` : '');
      }
    }
  }
  return s.replace(/\s*,\s*,/g, ',').replace(/\s+/g, ' ').trim();
}

const toStopPhrase = name => !name ? '' : (/^תחנ[תה]\s/.test(name) ? `אל ${name}` : `אל תחנת ${name}`);
const atStopPhrase = name => !name ? '' : (/^תחנ[תה]\s/.test(name) ? `ב${name}` : `בתחנת ${name}`);

function cleanWalkInstruction(rawInstr) {
  if (!rawInstr) return '';
  const lines = String(rawInstr)
    .split(/\r?\n/)
    .map(l => cleanTransitHe(l))
    .filter(l => l && !/דרך מוגבלת לשימוש|ייתכן שהכביש סגור/i.test(l));
  return lines.join('. ')
    .replace(/(\d+)\s*מ['׳](?=\s|$|[.,])/g, '$1 מטר')
    .replace(/0\.1\s*ק["״']מ/g, '100 מטר')
    .replace(/(\d+(?:\.\d+)?)\s*ק["״']מ/g, '$1 קילומטר')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSeconds(durVal) {
  if (typeof durVal === 'number') return durVal;
  const m = /^(\d+)(?:\.\d+)?s$/i.exec(String(durVal || '').trim());
  return m ? Number(m[1]) : 0;
}

function naturalDurationHe(sec) {
  const s = Number(sec) || 0;
  if (s <= 0) return '';
  if (s < 55) return 'פחות מדקה';
  const mins = Math.max(1, Math.round(s / 60));
  if (mins === 1) return 'דקה אחת';
  if (mins === 2) return 'שתי דקות';
  if (mins < 60) return `${mins} דקות`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 1) {
    if (m === 0) return 'שעה בדיוק';
    if (m === 30) return 'שעה וחצי';
    if (m === 15) return 'שעה ורבע';
    if (m === 1) return 'שעה ודקה';
    if (m === 2) return 'שעה ושתי דקות';
    return `שעה ו-${m} דקות`;
  }
  if (h === 2) {
    if (m === 0) return 'שעתיים';
    if (m === 30) return 'שעתיים וחצי';
    if (m === 1) return 'שעתיים ודקה';
    if (m === 2) return 'שעתיים ושתי דקות';
    return `שעתיים ו-${m} דקות`;
  }
  return m ? `${h} שעות ו-${m} דקות` : `${h} שעות`;
}

function naturalDistanceHe(meters) {
  const m = Number(meters) || 0;
  if (m <= 0) return '';
  if (m < 30) return 'מטרים ספורים';
  if (m < 950) {
    const rounded = Math.max(30, Math.round(m / 10) * 10);
    return `כ-${rounded} מטר`;
  }
  const km = (m / 1000).toFixed(1).replace(/\.0$/, '');
  return km === '1' ? 'קילומטר אחד' : `כ-${km} קילומטר`;
}

const fmtTimeIL = isoOrMs => {
  if (!isoOrMs) return '';
  try {
    const d = new Date(isoOrMs);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch (e) {
    return '';
  }
};

function cleanAgencyName(raw) {
  const a = cleanTransitHe(raw);
  if (!a) return '';
  return a
    .replace(/^חברת\s+/i, '')
    .replace(/דרך אגד עוטף ירושלים/g, 'דרך אגד')
    .trim();
}

function describeTransitBoarding(td) {
  const tl = td.transitLine || {};
  const vType = String((tl.vehicle && tl.vehicle.type) || 'BUS').toUpperCase();
  const agency = cleanAgencyName(tl.agencies && tl.agencies[0] && tl.agencies[0].name);
  const lineShort = cleanTransitHe(tl.nameShort || '');
  const lineName = cleanTransitHe(tl.name || '');
  const headsign = cleanTransitHe(td.headsign || '');

  if (vType.includes('HEAVY_RAIL') || vType.includes('TRAIN') || /רכבת ישראל/.test(agency)) {
    const railLine = lineShort && !/רכבת/.test(lineShort) ? ` קו ${lineShort}` : '';
    return {
      label: `רכבת ישראל${railLine}`.trim(),
      boardingPhrase: `עולים על רכבת ישראל${railLine}${headsign ? ' לכיוון ' + headsign : ''}`
    };
  }
  if (vType.includes('LIGHT_RAIL') || vType === 'TRAM' || /רכבת קלה|כפיר|תבל|דנקל/.test(agency)) {
    const lrNum = lineShort ? ` קו ${lineShort}` : '';
    return {
      label: `הרכבת הקלה${lrNum}`.trim(),
      boardingPhrase: `עולים על הרכבת הקלה${lrNum}${headsign ? ' לכיוון ' + headsign : ''}`
    };
  }
  if (vType === 'SUBWAY' || vType === 'FUNICULAR' || vType === 'GONDOLA_LIFT') {
    const vName = cleanTransitHe((tl.vehicle && tl.vehicle.name && tl.vehicle.name.text) || lineShort || lineName || 'הרכבלית');
    return {
      label: vName,
      boardingPhrase: `עולים על ${vName}${headsign ? ' לכיוון ' + headsign : ''}`
    };
  }
  const num = lineShort || lineName || 'אוטובוס';
  const agPart = agency ? ` של ${agency}` : '';
  return {
    label: `קו ${num}`,
    boardingPhrase: `עולים על קו ${num}${agPart}${headsign ? ' לכיוון ' + headsign : ''}`
  };
}

// איחוד צעדי WALK רצופים וניסוח טבעי להקראה בטלפון
function buildPolishedRouteV2(route, originLabel, destLabel) {
  const leg = (route.legs || [])[0] || {};
  const totalSec = parseSeconds(route.duration || leg.duration);
  const totalDurHe = naturalDurationHe(totalSec) ||
    cleanTransitHe(route.localizedValues && route.localizedValues.duration && route.localizedValues.duration.text);

  const rawSteps = leg.steps || [];
  // קיבוץ מקטעי הליכה רצופים למקטע לוגי אחד
  const grouped = [];
  for (const st of rawSteps) {
    const mode = st.travelMode || 'WALK';
    if (mode === 'WALK') {
      const prev = grouped[grouped.length - 1];
      const stepDist = Number(st.distanceMeters) || 0;
      const stepSec = parseSeconds(st.staticDuration);
      const instr = cleanWalkInstruction(st.navigationInstruction && st.navigationInstruction.instructions);
      if (prev && prev.type === 'WALK') {
        prev.distanceMeters += stepDist;
        prev.durationSec += stepSec;
        if (instr && prev.instructions[prev.instructions.length - 1] !== instr) prev.instructions.push(instr);
      } else {
        grouped.push({
          type: 'WALK',
          distanceMeters: stepDist,
          durationSec: stepSec,
          instructions: instr ? [instr] : []
        });
      }
    } else if (mode === 'TRANSIT' && st.transitDetails) {
      grouped.push({ type: 'TRANSIT', td: st.transitDetails, stepSec: parseSeconds(st.staticDuration) });
    } else {
      const instr = cleanWalkInstruction(st.navigationInstruction && st.navigationInstruction.instructions);
      grouped.push({
        type: 'OTHER',
        distanceMeters: Number(st.distanceMeters) || 0,
        durationSec: parseSeconds(st.staticDuration),
        instr
      });
    }
  }

  const spokenSteps = [];
  const walkDetails = [];
  const lineLabels = [];
  let firstTransitDepMs = 0;
  let firstTransitDepText = '';
  let lastTransitArrMs = 0;
  let lastTransitArrText = '';
  let initialWalkSec = 0;
  let trailingWalkSec = 0;
  let seenTransit = false;

  for (let i = 0; i < grouped.length; i++) {
    const g = grouped[i];
    const prev = i > 0 ? grouped[i - 1] : null;
    const next = i < grouped.length - 1 ? grouped[i + 1] : null;

    if (g.type === 'WALK') {
      if (!seenTransit) initialWalkSec += g.durationSec;
      const hasLaterTransit = grouped.slice(i + 1).some(x => x.type === 'TRANSIT');
      if (!hasLaterTransit && seenTransit) trailingWalkSec += g.durationSec;

      const walkDur = naturalDurationHe(g.durationSec);
      const walkDist = naturalDistanceHe(g.distanceMeters);
      const nextStop = next && next.type === 'TRANSIT'
        ? cleanStopName(next.td.stopDetails && next.td.stopDetails.departureStop && next.td.stopDetails.departureStop.name)
        : '';

      if (g.instructions.length) {
        const ctxTitle = !seenTransit
          ? `הליכה לתחנת המוצא${nextStop ? ' (' + nextStop + ')' : ''}`
          : (hasLaterTransit ? `מעבר רגלי אל תחנת ${nextStop || 'ההחלפה'}` : `הליכה מהתחנה האחרונה אל ${cleanTransitHe(destLabel)}`);
        walkDetails.push(`${ctxTitle}: ${g.instructions.join('. ')}.`);
      }

      if (!seenTransit && hasLaterTransit) {
        // הליכה ראשונית לתחנה הראשונה
        if (g.distanceMeters >= 55) {
          spokenSteps.push(`מתחילים בהליכה של ${walkDur || 'כמה דקות'}${walkDist ? ', ' + walkDist : ''}, ${toStopPhrase(nextStop)}.`);
        } else if (nextStop) {
          spokenSteps.push(`ניגשים ${toStopPhrase(nextStop)}${g.distanceMeters >= 20 ? ', במרחק ' + walkDist : ''}.`);
        }
      } else if (seenTransit && hasLaterTransit) {
        // החלפה בין קווים (כולל חישוב זמן ההמתנה בתחנה הבאה)
        const prevArrIso = prev && prev.type === 'TRANSIT' && prev.td.stopDetails && prev.td.stopDetails.arrivalTime;
        const nextDepIso = next && next.type === 'TRANSIT' && next.td.stopDetails && next.td.stopDetails.departureTime;
        let waitPhrase = '';
        if (prevArrIso && nextDepIso) {
          const gapSec = Math.round((new Date(nextDepIso).getTime() - new Date(prevArrIso).getTime()) / 1000) - g.durationSec;
          if (gapSec > 90) {
            waitPhrase = `, וממתינים כ-${naturalDurationHe(gapSec)}`;
          } else if (gapSec >= 0 && gapSec <= 90) {
            waitPhrase = `, שימו לב שזמן ההחלפה קצר מאוד`;
          }
        }
        const prevStop = prev && prev.type === 'TRANSIT'
          ? cleanStopName(prev.td.stopDetails && prev.td.stopDetails.arrivalStop && prev.td.stopDetails.arrivalStop.name)
          : '';
        if (g.distanceMeters < 35 && prevStop && prevStop === nextStop) {
          if (waitPhrase) spokenSteps.push(`נשארים באותה תחנה${waitPhrase}.`);
        } else {
          spokenSteps.push(`משם עוברים בהליכה של ${walkDur || 'דקה אחת'}${walkDist ? ', ' + walkDist : ''}, ${toStopPhrase(nextStop)}${waitPhrase}.`);
        }
      } else if (seenTransit && !hasLaterTransit) {
        // הליכה אחרונה ליעד
        if (g.distanceMeters >= 35) {
          spokenSteps.push(`מהתחנה הולכים ${walkDur || 'דקה אחת'}${walkDist ? ', ' + walkDist : ''}, עד ${cleanTransitHe(destLabel)}.`);
        }
      } else if (!seenTransit && !hasLaterTransit) {
        // מסלול רגלי בלבד
        spokenSteps.push(`הליכה רגלית של ${walkDur}${walkDist ? ' (' + walkDist + ')' : ''} עד ${cleanTransitHe(destLabel)}.`);
      }
    } else if (g.type === 'TRANSIT') {
      seenTransit = true;
      const td = g.td;
      const sd = td.stopDetails || {};
      const lv = td.localizedValues || {};
      const depStop = cleanStopName(sd.departureStop && sd.departureStop.name);
      const arrStop = cleanStopName(sd.arrivalStop && sd.arrivalStop.name);
      const depTime = (lv.departureTime && lv.departureTime.time && lv.departureTime.time.text) || fmtTimeIL(sd.departureTime);
      const arrTime = (lv.arrivalTime && lv.arrivalTime.time && lv.arrivalTime.time.text) || fmtTimeIL(sd.arrivalTime);
      const stopsCount = td.stopCount || 0;

      if (!firstTransitDepMs && sd.departureTime) {
        firstTransitDepMs = new Date(sd.departureTime).getTime();
        firstTransitDepText = depTime;
      }
      if (sd.arrivalTime) {
        lastTransitArrMs = new Date(sd.arrivalTime).getTime();
        lastTransitArrText = arrTime;
      }

      // אם הייתה החלפה ישירה ללא צעד WALK באמצע, נחשב המתנה בין שני קווים
      if (prev && prev.type === 'TRANSIT' && prev.td.stopDetails && prev.td.stopDetails.arrivalTime && sd.departureTime) {
        const gapSec = Math.round((new Date(sd.departureTime).getTime() - new Date(prev.td.stopDetails.arrivalTime).getTime()) / 1000);
        if (gapSec > 90) {
          spokenSteps.push(`ממתינים בתחנה כ-${naturalDurationHe(gapSec)}.`);
        }
      }

      const info = describeTransitBoarding(td);
      lineLabels.push(info.label);

      const prevWasWalkToStop = !!(prev && prev.type === 'WALK' && depStop);
      const timePrefix = depTime ? `בשעה ${depTime} ` : '';
      const fromPart = (!prevWasWalkToStop && depStop) ? ` ${atStopPhrase(depStop)}` : '';
      const stopsPart = stopsCount === 1 ? 'נוסעים תחנה אחת' : (stopsCount > 1 ? `נוסעים ${stopsCount} תחנות` : 'נוסעים');
      const arrPart = `ויורדים${arrTime ? ' ב-' + arrTime : ''}${arrStop ? ' ' + atStopPhrase(arrStop) : ''}.`;
      spokenSteps.push(`${timePrefix}${info.boardingPhrase}${fromPart}, ${stopsPart} ${arrPart}`.replace(/\s+/g, ' '));
    } else if (g.instr) {
      const dist = naturalDistanceHe(g.distanceMeters);
      spokenSteps.push(`${g.instr}${dist ? ' (' + dist + ')' : ''}.`);
    }
  }

  // חישוב מדויק של שעת יציאה ושעת הגעה סופית ליעד (כולל ההליכה האחרונה!)
  const finalArrivalMs = lastTransitArrMs ? (lastTransitArrMs + trailingWalkSec * 1000) : (totalSec ? Date.now() + totalSec * 1000 : 0);
  const finalArrivalText = finalArrivalMs ? fmtTimeIL(finalArrivalMs) : lastTransitArrText;
  const startLeaveMs = firstTransitDepMs ? (firstTransitDepMs - initialWalkSec * 1000) : Date.now();
  const depDisplay = firstTransitDepText || fmtTimeIL(startLeaveMs);
  const linesSummary = lineLabels.length ? lineLabels.join(' ואז ') : 'הליכה רגלית / נסיעה ישירה';

  return {
    sortArrivalMs: finalArrivalMs || (Date.now() + (totalSec || 999999) * 1000),
    totalSec: totalSec || 999999,
    firstDepMs: firstTransitDepMs || startLeaveMs,
    depDisplay,
    finalArrivalText,
    totalDurHe,
    linesSummary,
    spokenBody: spokenSteps.join(' '),
    walkDetailSpeech: walkDetails.length
      ? `פירוט הליכה רגלית: ${walkDetails.join(' ')}`
      : 'אין מקטעי הליכה מורכבים במסלול זה.',
    dedupeKey: `${lineLabels.join('>')}@${depDisplay}`
  };
}

function finalizeTopRoutes(builtRoutes, originClean, destClean) {
  // סינון כפילויות ומיון כך שהחלופה המהירה / המגיעה מוקדם ביותר תהיה חלופה 1
  const seen = new Set();
  const unique = [];
  for (const r of builtRoutes) {
    if (seen.has(r.dedupeKey)) continue;
    seen.add(r.dedupeKey);
    unique.push(r);
  }
  unique.sort((a, b) => (a.sortArrivalMs - b.sortArrivalMs) || (a.totalSec - b.totalSec));
  const top = unique.slice(0, 3);

  return top.map((r, idx) => {
    const numHe = idx === 0 ? 'ראשונה (המהירה ביותר)' : (idx === 1 ? 'שנייה' : 'שלישית');
    const header = `חלופה ${numHe}: זמן כולל ${r.totalDurHe}${r.finalArrivalText ? ', הגעה משוערת ליעד ב-' + r.finalArrivalText : ''}.`;
    const fullText = `${header} ${r.spokenBody}`.replace(/\s+/g, ' ').trim();
    const shortSummary = `חלופה ${idx + 1}: ${r.depDisplay ? 'יציאה לקו הראשון ב-' + r.depDisplay + ' עם ' : ''}${r.linesSummary}, משך כולל ${r.totalDurHe}${r.finalArrivalText ? ', הגעה ליעד ב-' + r.finalArrivalText : ''}.`;
    return {
      option: idx + 1,
      departure: r.depDisplay,
      arrival: r.finalArrivalText,
      duration: r.totalDurHe,
      lines: r.linesSummary,
      firstDepMs: r.firstDepMs,
      fullText,
      shortSummary,
      walkDetailSpeech: r.walkDetailSpeech,
      originClean,
      destClean
    };
  });
}

function buildInitialTransitSpeech(routes, originClean, destClean, notePrefix) {
  if (!routes.length) return '';
  const first = routes[0];
  const parts = [];
  if (notePrefix) parts.push(notePrefix);
  parts.push(`מצאתי ${routes.length === 1 ? 'מסלול הגעה' : routes.length + ' חלופות הגעה'} מ${originClean} אל ${destClean}.`);
  parts.push(`הנה הפירוט המלא של החלופה המהירה ביותר — ${first.fullText}`);

  if (routes.length > 1) {
    parts.push('תקציר החלופות הנוספות:');
    for (let i = 1; i < routes.length; i++) {
      parts.push(routes[i].shortSummary);
    }
  }

  const menuTail = routes.length > 1
    ? `לשמיעת הפירוט המלא של חלופה 2${routes.length > 2 ? ' או 3' : ''} הקש 2${routes.length > 2 ? ' או 3' : ''}, לשמיעה חוזרת של החלופה הראשונה הקש 1, לשליחת כל המסלולים למייל הקש 4, להוראות הליכה מפורטות הקש 5, לבדיקת אוטובוסים מאוחרים יותר הקש 8, או הקש 0 לשאלה חדשה.`
    : `לשמיעה חוזרת הקש 1, לשליחת המסלול למייל הקש 4, להוראות הליכה מפורטות הקש 5, לבדיקת אוטובוסים מאוחרים יותר הקש 8, או הקש 0 לשאלה חדשה.`;
  parts.push(menuTail);
  return parts.join(' ');
}

function buildTransitEmailBody(routes, originClean, destClean) {
  const lines = [
    `פירוט מסלולי הגעה: מ-${originClean} אל ${destClean}`,
    `הופק ב-${nowIsraelInfo().humanHe}`,
    '--------------------------------------------------',
    ''
  ];
  for (const r of routes) {
    lines.push(`=== חלופה ${r.option}: ${r.lines} (סה"כ ${r.duration}, יציאה ${r.departure || '-'}, הגעה ${r.arrival || '-'}) ===`);
    lines.push(r.fullText);
    if (r.walkDetailSpeech && !r.walkDetailSpeech.includes('אין מקטעי')) {
      lines.push(r.walkDetailSpeech);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ============================================================================
// כלי 1: חיפוש מקומות ועסקים בגוגל (Google Places API New)
// ============================================================================
const PLACES_DECL = {
  name: 'google_places_search',
  description: 'Search for places, businesses, synagogues, hospitals, pharmacies, institutions, or landmarks in Israel. Returns exact street address, phone number, open/closed status, opening hours, and rating. Also useful to resolve vague place names before computing transit routes.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Exact Hebrew sentence: "אני מאתרת כעת את הכתובת ושעות הפתיחה"' },
      query: { type: 'STRING', description: 'Search query in Hebrew including city if known (e.g., "בית חולים מעייני הישועה בני ברק", "בית מרקחת תורן ירושלים")' },
      max_results: { type: 'INTEGER', description: 'Number of matching places to return (1 to 5, default 3)' }
    },
    required: ['action_announcement', 'query']
  }
};

async function queryGooglePlacesIL(queryText, maxResults, deadline) {
  if (!MAPS_KEY) return [];
  const count = Math.min(5, Math.max(1, Number(maxResults) || 3));
  const r = await http('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': MAPS_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.currentOpeningHours.openNow,places.regularOpeningHours.weekdayDescriptions,places.rating'
    },
    body: JSON.stringify({
      textQuery: String(queryText).trim(),
      languageCode: 'he',
      regionCode: 'IL',
      maxResultCount: count
    })
  }, 12000, deadline);
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return (j.places || []).map(p => ({
    placeId: p.id || '',
    name: (p.displayName && p.displayName.text) || '',
    address: cleanTransitHe(p.formattedAddress || ''),
    phone: p.nationalPhoneNumber || '',
    openNow: p.currentOpeningHours ? p.currentOpeningHours.openNow : null,
    hours: (p.regularOpeningHours && p.regularOpeningHours.weekdayDescriptions) || [],
    rating: p.rating || null
  }));
}

async function runGooglePlacesSearch(args, s, deadline) {
  if (!MAPS_KEY) return { error: 'GOOGLE_MAPS_API_KEY is not configured' };
  const places = await queryGooglePlacesIL(args.query, args.max_results || 3, deadline);
  if (!places.length) {
    return { status: 'not_found', message: 'לא נמצאו מקומות תואמים בגוגל מפות עבור חיפוש זה.' };
  }
  s.workingMemory = s.workingMemory || {};
  s.workingMemory.lastPlaces = places;
  return { status: 'ok', count: places.length, places };
}

// ============================================================================
// כלי 2: ניווט ותחבורה ציבורית מדויקת בגוגל מפות (Routes API v2 + תיקון עצמי)
// ============================================================================
const MAPS_DECL = {
  name: 'google_maps_route',
  description: 'REQUIRED for all public transit (buses, Israel Railways, light rail), walking, and driving routes in Israel. Automatically returns full step-by-step details for the fastest route plus concise summaries for up to 2 alternatives, with interactive phone menu keys.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Exact Hebrew sentence: "אני בודקת כעת חלופות מסלול בגוגל מפות"' },
      origin: { type: 'STRING', description: 'Starting address, station, or landmark with city in Israel (e.g., "רבי עקיבא 100 בני ברק")' },
      destination: { type: 'STRING', description: 'Destination address, station, or landmark with city in Israel (e.g., "הכותל המערבי ירושלים")' },
      mode: { type: 'STRING', description: '"transit" (default), "walking", or "driving"' },
      departure_time: { type: 'STRING', description: 'Optional: "now", "HH:MM" in Israel time, "+30m", or ISO-8601 timestamp. Omit if arrival_time is used.' },
      arrival_time: { type: 'STRING', description: 'Optional (transit only): desired arrival time in "HH:MM" or ISO-8601 when caller asks to arrive BY a specific time.' }
    },
    required: ['action_announcement', 'origin', 'destination']
  }
};

async function computeRoutesV2Call(originSpec, destSpec, travelMode, depIso, arrIso, deadline) {
  const body = {
    origin: originSpec,
    destination: destSpec,
    travelMode,
    computeAlternativeRoutes: true,
    languageCode: 'he',
    regionCode: 'IL',
    units: 'METRIC'
  };
  if (arrIso && travelMode === 'TRANSIT') {
    body.arrivalTime = arrIso;
  } else if (depIso) {
    body.departureTime = depIso;
  }

  const r = await http('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': MAPS_KEY,
      'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.localizedValues,routes.legs.duration,routes.legs.localizedValues,routes.legs.steps.travelMode,routes.legs.steps.staticDuration,routes.legs.steps.distanceMeters,routes.legs.steps.localizedValues,routes.legs.steps.navigationInstruction,routes.legs.steps.transitDetails'
    },
    body: JSON.stringify(body)
  }, 15000, deadline);

  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, routes: j.routes || [], errorMsg: (j.error && j.error.message) || '' };
}

function formatRouteLegacyBuilt(route, originClean, destClean) {
  const leg = (route.legs || [])[0] || {};
  const totalSec = (leg.duration && leg.duration.value) || 0;
  const totalDurHe = naturalDurationHe(totalSec) || cleanTransitHe(leg.duration && leg.duration.text);
  const steps = [];
  const lineLabels = [];
  let depDisplay = cleanTransitHe(leg.departure_time && leg.departure_time.text);
  const arrDisplay = cleanTransitHe(leg.arrival_time && leg.arrival_time.text);

  for (const st of (leg.steps || [])) {
    if (st.travel_mode === 'TRANSIT' && st.transit_details) {
      const td = st.transit_details;
      const line = td.line || {};
      const num = cleanTransitHe(line.short_name || line.name || 'אוטובוס');
      const ag = cleanAgencyName(line.agencies && line.agencies[0] && line.agencies[0].name);
      const depStop = cleanStopName(td.departure_stop && td.departure_stop.name);
      const arrStop = cleanStopName(td.arrival_stop && td.arrival_stop.name);
      const depT = td.departure_time ? td.departure_time.text : '';
      const arrT = td.arrival_time ? td.arrival_time.text : '';
      if (!depDisplay && depT) depDisplay = depT;
      lineLabels.push(`קו ${num}`);
      steps.push(`${depT ? 'בשעה ' + depT + ' ' : ''}עולים על קו ${num}${ag ? ' של ' + ag : ''}${td.headsign ? ' לכיוון ' + cleanTransitHe(td.headsign) : ''} בתחנת ${depStop}, נוסעים ${td.num_stops || ''} תחנות ויורדים${arrT ? ' ב-' + arrT : ''} בתחנת ${arrStop}.`);
    } else if (st.travel_mode === 'WALKING') {
      const m = st.distance && st.distance.value;
      if (m >= 40) {
        steps.push(`הליכה של ${naturalDurationHe(st.duration && st.duration.value)}, ${naturalDistanceHe(m)}.`);
      }
    }
  }
  return {
    sortArrivalMs: (leg.arrival_time && leg.arrival_time.value ? leg.arrival_time.value * 1000 : Date.now() + totalSec * 1000),
    totalSec,
    firstDepMs: (leg.departure_time && leg.departure_time.value ? leg.departure_time.value * 1000 : Date.now()),
    depDisplay,
    finalArrivalText: arrDisplay,
    totalDurHe,
    linesSummary: lineLabels.join(' ואז ') || 'נסיעה ישירה',
    spokenBody: steps.join(' '),
    walkDetailSpeech: 'פירוט הליכה אינו זמין במצב גיבוי.',
    dedupeKey: `${lineLabels.join('>')}@${depDisplay}`
  };
}

async function runGoogleMapsRoute(args, s, deadline) {
  if (!MAPS_KEY) return { error: 'GOOGLE_MAPS_API_KEY is not configured on the server' };

  const modeMap = { transit: 'TRANSIT', walking: 'WALK', driving: 'DRIVE', bicycling: 'BICYCLE' };
  const travelMode = modeMap[String(args.mode || 'transit').toLowerCase()] || 'TRANSIT';

  let originRaw = String(args.origin || '').trim();
  let destRaw = String(args.destination || '').trim();
  let originClean = cleanTransitHe(originRaw);
  let destClean = cleanTransitHe(destRaw);

  const depIso = parseIsraelTimeInput(args.departure_time);
  const arrIso = parseIsraelTimeInput(args.arrival_time);

  let notePrefix = '';
  let v2 = await computeRoutesV2Call({ address: originRaw }, { address: destRaw }, travelMode, depIso, arrIso, deadline);

  // תיקון עצמי מס' 1: אם כתובת עמומה או לא נמצאו מסלולים, נזהה placeId מדויק דרך Places API
  if ((!v2.routes || !v2.routes.length) && MAPS_KEY) {
    const [oPlaces, dPlaces] = await Promise.all([
      queryGooglePlacesIL(originRaw, 1, deadline).catch(() => []),
      queryGooglePlacesIL(destRaw, 1, deadline).catch(() => [])
    ]);
    if (oPlaces.length || dPlaces.length) {
      const oSpec = oPlaces[0] && oPlaces[0].placeId ? { placeId: oPlaces[0].placeId } : { address: originRaw };
      const dSpec = dPlaces[0] && dPlaces[0].placeId ? { placeId: dPlaces[0].placeId } : { address: destRaw };
      if (oPlaces[0] && oPlaces[0].name) originClean = `${oPlaces[0].name} (${oPlaces[0].address})`;
      if (dPlaces[0] && dPlaces[0].name) destClean = `${dPlaces[0].name} (${dPlaces[0].address})`;
      v2 = await computeRoutesV2Call(oSpec, dSpec, travelMode, depIso, arrIso, deadline);
    }
  }

  // תיקון עצמי מס' 2: אם מדובר בשעת לילה/שבת ואין קווים פעילים כעת, נבדוק בבוקר הקרוב
  if ((!v2.routes || !v2.routes.length) && travelMode === 'TRANSIT' && !depIso && !arrIso) {
    const morningIso = nextMorningIsraelIso();
    const morningTry = await computeRoutesV2Call({ address: originRaw }, { address: destRaw }, 'TRANSIT', morningIso, null, deadline);
    if (morningTry.routes && morningTry.routes.length) {
      v2 = morningTry;
      notePrefix = 'שימו לב: בשעה זו אין קווי תחבורה ציבורית פעילים במסלול זה, לכן הבאתי את הקווים הראשונים הזמינים בבוקר הקרוב.';
    }
  }

  let polished = [];
  if (v2.routes && v2.routes.length > 0) {
    const built = v2.routes.map(rt => buildPolishedRouteV2(rt, originClean, destClean));
    polished = finalizeTopRoutes(built, originClean, destClean);
  } else {
    // גיבוי לממשק Legacy Directions
    const u = new URL('https://maps.googleapis.com/maps/api/directions/json');
    u.searchParams.set('origin', originRaw);
    u.searchParams.set('destination', destRaw);
    u.searchParams.set('mode', String(args.mode || 'transit').toLowerCase());
    u.searchParams.set('alternatives', 'true');
    u.searchParams.set('language', 'he');
    u.searchParams.set('region', 'il');
    u.searchParams.set('departure_time', depIso ? String(Math.floor(new Date(depIso).getTime() / 1000)) : 'now');
    u.searchParams.set('key', MAPS_KEY);

    const r2 = await http(u.toString(), {}, 14000, deadline);
    const j2 = await r2.json().catch(() => ({}));
    if (j2.status === 'OK' && j2.routes && j2.routes.length > 0) {
      const built = j2.routes.map(rt => formatRouteLegacyBuilt(rt, originClean, destClean));
      polished = finalizeTopRoutes(built, originClean, destClean);
    } else {
      return {
        status: 'no_routes_found',
        origin_checked: originClean,
        destination_checked: destClean,
        details: v2.errorMsg || j2.status || 'לא נמצאו מסלולי תחבורה ציבורית זמינים בין נקודות אלו.',
        suggestion: 'נסה למקד את שם העיר או הרחוב באמצעות google_places_search, או לשאול את המתקשר מאיזו עיר מדויקת הוא יוצא.'
      };
    }
  }

  const overviewSpeech = buildInitialTransitSpeech(polished, originClean, destClean, notePrefix);
  s.routeObjects = polished;
  s.routeAlternatives = polished.map(x => x.fullText);
  s.routeOverviewSpeech = overviewSpeech;
  s.routeEmailBody = buildTransitEmailBody(polished, originClean, destClean);
  s.routeQueryMeta = { origin: originRaw, destination: destRaw, mode: args.mode || 'transit', baseDepMs: polished[0].firstDepMs || Date.now() };
  s.routeAudioCache = {};
  s.selectedRouteIdx = 0;
  s.awaitingRouteChoice = true;

  s.workingMemory = s.workingMemory || {};
  s.workingMemory.lastRoutes = polished;

  return {
    status: 'ok',
    total_alternatives: polished.length,
    fastest_route_full_speech: polished[0].fullText,
    other_alternatives_summary: polished.slice(1).map(x => x.shortSummary),
    recommended_spoken_response: overviewSpeech,
    instruction_to_model: 'Read recommended_spoken_response faithfully in natural Hebrew so the caller immediately gets the full step-by-step details of Option 1 (fastest) plus concise summaries of the other alternatives and the interactive keypad options.'
  };
}

// ============================================================================
// כלי 3: חיפוש רשת מקבילי ב-Groq (3 עד 8 שאילתות בו-זמנית)
// ============================================================================
const PARALLEL_SEARCH_DECL = {
  name: 'web_search_parallel',
  description: 'Execute 3 to 8 parallel web search queries simultaneously via Groq for live news, current events, facts, prices, and research (DO NOT use for Israeli public transit routes).',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Exact Hebrew sentence: "אני מבצעת כעת חיפוש מעמיק ברשת"' },
      queries: {
        type: 'ARRAY',
        items: { type: 'STRING' },
        description: 'Between 3 and 8 targeted search queries to execute concurrently'
      }
    },
    required: ['action_announcement', 'queries']
  }
};

let grot = 0;
async function singleGroqQuery(query, deadline) {
  if (!GROQ_KEYS.length) return { query, error: 'GROQ_API_KEYS missing' };
  const key = GROQ_KEYS[grot++ % GROQ_KEYS.length];
  try {
    const r = await http(GROQ_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: 'Search the web and return accurate, up-to-date factual findings in 70-110 words, including source URLs only if relevant for follow-up reading. Plain concise text.' },
          { role: 'user', content: query }
        ],
        tools: [{ type: 'browser_search' }],
        tool_choice: 'required',
        reasoning_effort: 'low',
        max_completion_tokens: 750,
        stream: false
      })
    }, 18000, deadline);
    if (!r.ok) return { query, error: 'HTTP ' + r.status };
    const j = await r.json();
    const text = String((((j.choices || [])[0] || {}).message || {}).content || '').replace(/【[^】]*】/g, '').replace(/\s+/g, ' ').trim();
    return { query, result: text || 'אין תוצאות' };
  } catch (e) {
    return { query, error: e.message };
  }
}

async function runParallelGroqSearch(queries, s, deadline) {
  const list = (Array.isArray(queries) ? queries : []).map(q => String(q).trim()).filter(Boolean).slice(0, 8);
  if (!list.length) return { error: 'No queries provided' };
  const results = await Promise.all(list.map(q => singleGroqQuery(q, deadline)));
  s.workingMemory = s.workingMemory || {};
  s.workingMemory.lastSearch = results.map(r => `${r.query}: ${r.result || r.error}`).join(' | ').slice(0, 1500);
  return { executed_count: results.length, findings: results };
}

// ============================================================================
// כלי 4: קריאת עמוד אינטרנט מלא לעומק (Deep Webpage Reader)
// ============================================================================
const FETCH_WEBPAGE_DECL = {
  name: 'fetch_webpage',
  description: 'Fetch and extract clean readable text from a specific webpage URL when deeper reading is needed after a search.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Exact Hebrew sentence: "אני קוראת כעת את פרטי העמוד לעומק"' },
      url: { type: 'STRING', description: 'Full http/https URL to read' }
    },
    required: ['action_announcement', 'url']
  }
};

async function runFetchWebpage(args, deadline) {
  const u = String(args.url || '').trim();
  if (!/^https?:\/\//i.test(u)) return { error: 'Invalid URL' };
  const r = await http(u, {
    headers: { 'User-Agent': CRAWLER_UA, 'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8' },
    redirect: 'follow'
  }, 12000, deadline);
  if (!r.ok) return { error: 'HTTP ' + r.status };
  const raw = await r.text();
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
  const title = titleMatch ? stripHtml(titleMatch[1]).slice(0, 160) : '';
  const clean = stripHtml(raw).slice(0, 5500);
  return { url: u, title, content: clean || 'לא נמצא תוכן טקסטואלי קריא בעמוד' };
}

// ============================================================================
// כלי 5: רדיו וחדשות RSS חכם (שמע מוקלט + הקראת מבזקי כתבות + שידור חי)
// ============================================================================
const RSS_RADIO_DECL = {
  name: 'play_rss_radio',
  description: 'Play audio news bulletins/podcasts from active RSS feeds, read live breaking news headlines from news RSS feeds (like Kol Chai / JDN), or transfer to live radio stream extension.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Exact Hebrew sentence: "אני טוענת כעת את שידור הרדיו"' },
      station_name: { type: 'STRING', description: 'Station/feed keyword (e.g., "חדשות כאן", "כאן רשת ב", "קול חי", "JDN"), or empty for default' },
      rss_url: { type: 'STRING', description: 'Optional direct RSS feed URL' },
      mode: { type: 'STRING', description: '"auto" (default - plays audio if feed has fresh audio, else returns headlines to read), "headlines" (read news titles/summaries), or "live" (transfers to Yemot live radio extension)' }
    },
    required: ['action_announcement']
  }
};

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function isAudioMedia(url, mime) {
  const u = String(url || '').toLowerCase();
  const m = String(mime || '').toLowerCase();
  if (/\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i.test(u) || m.startsWith('image/')) return false;
  if (m.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|opus)(\?|$)/i.test(u)) return true;
  if (m.startsWith('video/mp4') || /\.mp4(\?|$)/i.test(u)) return true;
  return false;
}

async function prepareRssRadio(args, s, deadline) {
  const mode = String(args.mode || 'auto').toLowerCase();
  if (mode === 'live' && LIVE_STREAM_EXT) {
    s.transferToExt = '/' + LIVE_STREAM_EXT;
    return { status: 'transferring_to_live_stream', extension: LIVE_STREAM_EXT };
  }

  let feedUrl = String(args.rss_url || '').trim();
  let feedTitle = String(args.station_name || '').trim();
  if (!feedUrl && RADIO_FEEDS.length) {
    const found = feedTitle
      ? RADIO_FEEDS.find(f => f.n.includes(feedTitle) || feedTitle.includes(f.n))
      : RADIO_FEEDS[0];
    const picked = found || RADIO_FEEDS[0];
    feedUrl = picked.u;
    feedTitle = picked.n;
  }
  if (!feedUrl) throw new Error('לא הוגדרו תחנות רדיו ב-RADIO_FEEDS');

  const r = await http(feedUrl, { headers: { 'User-Agent': CRAWLER_UA } }, 12000, deadline);
  if (!r.ok) throw new Error('שגיאה בטעינת פיד RSS: ' + r.status);
  const xmlText = await r.text();
  const parsed = xmlParser.parse(xmlText);
  const channel = (parsed.rss && parsed.rss.channel) || parsed.feed || {};
  const rawItems = channel.item || channel.entry || [];
  const list = (Array.isArray(rawItems) ? rawItems : [rawItems]).filter(Boolean);

  const audioCandidates = [];
  const headlineItems = [];
  const cutoffMs = Date.now() - 120 * 86400000; // סינון קבצי ארכיון ישנים מאוד מעל 120 יום

  for (const it of list.slice(0, 10)) {
    const title = stripHtml(it.title || '');
    const desc = stripHtml(it.description || it['content:encoded'] || it.summary || '').slice(0, 260);
    const pubRaw = it.pubDate || it.published || it.updated || '';
    const pubMs = pubRaw ? Date.parse(pubRaw) : Date.now();
    const isFresh = Number.isNaN(pubMs) || pubMs >= cutoffMs;

    if (title) {
      headlineItems.push({ title, summary: desc, published: pubRaw ? fmtTimeIL(pubMs) : '' });
    }

    if (mode !== 'headlines' && isFresh) {
      const encList = [];
      if (it.enclosure) encList.push(...(Array.isArray(it.enclosure) ? it.enclosure : [it.enclosure]));
      if (it['media:content']) encList.push(...(Array.isArray(it['media:content']) ? it['media:content'] : [it['media:content']]));
      for (const enc of encList) {
        const u = decodeHtmlEntities((enc && (enc['@_url'] || enc.url)) || '').trim();
        const tp = (enc && (enc['@_type'] || enc.type)) || '';
        if (u && /^https?:\/\//i.test(u) && isAudioMedia(u, tp)) {
          audioCandidates.push({ title: title || feedTitle || 'משדר חדשות', u });
          break;
        }
      }
    }
  }

  if (audioCandidates.length > 0 && mode !== 'headlines') {
    const files = [];
    const playedTitles = [];
    for (let i = 0; i < Math.min(2, audioCandidates.length); i++) {
      try {
        const res = await prepareMedia({ n: audioCandidates[i].title, u: audioCandidates[i].u }, s.d, deadline);
        if (res && res.name) {
          files.push('f-' + s.d + '/' + res.name);
          playedTitles.push(audioCandidates[i].title);
        }
      } catch (e) {
        console.error('RSS audio prep failed:', e.message);
      }
    }
    if (files.length) {
      s.extraPlayChain = (s.extraPlayChain ? s.extraPlayChain + '.' : '') + files.join('.');
      return {
        status: 'playing_audio_broadcast',
        station: feedTitle,
        episodes_queued: playedTitles,
        instruction_to_model: 'Announce briefly in 1 short sentence that you are now playing the broadcast (e.g. "הנה מהדורת החדשות האחרונה מ' + feedTitle + '"), as the audio file will play immediately right after your sentence.'
      };
    }
  }

  if (headlineItems.length > 0) {
    s.workingMemory = s.workingMemory || {};
    s.workingMemory.lastSearch = headlineItems.slice(0, 6).map(h => `${h.title}: ${h.summary}`).join(' | ');
    return {
      status: 'headlines_ready_to_read',
      station: feedTitle,
      headlines: headlineItems.slice(0, 6),
      instruction_to_model: `This RSS feed (${feedTitle}) provides text news items rather than MP3 files. Read a crisp, engaging Hebrew radio news flash summarizing these ${Math.min(6, headlineItems.length)} latest headlines naturally.`
    };
  }

  throw new Error('לא נמצאו משדרי שמע או כותרות חדשות פעילות בפיד זה');
}

// ============================================================================
// כלי 6: שליחת מייל טקסט מסודר (סיכומים, מסלולים, רשימות, מחקר)
// ============================================================================
const SEND_EMAIL_DECL = {
  name: 'send_email',
  description: 'Send a clean formatted text email (such as transit route instructions, research summary, phone numbers, lists, or notes) to the configured user email address via Google Apps Script.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Exact Hebrew sentence: "אני שולחת כעת את הסיכום למייל שלך"' },
      subject: { type: 'STRING', description: 'Clear Hebrew email subject line' },
      content: { type: 'STRING', description: 'Well-structured Hebrew body text to send in the email' }
    },
    required: ['action_announcement', 'subject', 'content']
  }
};

async function runSendEmail(args, deadline) {
  await sendViaGasEmail({
    subject: String(args.subject || 'סיכום מקו AI').slice(0, 180),
    body: String(args.content || '').slice(0, 15000),
    files: []
  }, deadline);
  return { status: 'sent', to: TARGET_EMAIL };
}

// ============================================================================
// כלי 7: יצירת תמונות (תומך גם ב-Gemini Image וגם ב-Imagen) ושליחה למייל
// ============================================================================
const GEN_IMAGE_DECL = {
  name: 'generate_image',
  description: 'Generate 1 to 4 AI images with custom aspect ratio and email them automatically as attachments via Google Apps Script.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Exact Hebrew sentence: "אני מייצרת כעת את התמונה ושולחת למייל"' },
      prompt: { type: 'STRING', description: 'Detailed image generation prompt in English' },
      aspect_ratio: { type: 'STRING', description: '"1:1" (square), "16:9" (landscape), "9:16" (portrait), "4:3", or "3:4"' },
      count: { type: 'INTEGER', description: 'Number of images to generate, between 1 and 4' }
    },
    required: ['action_announcement', 'prompt']
  }
};

async function generateOneGeminiImage(prompt, aspectRatio, deadline) {
  const key = KEYS[rot.text++ % KEYS.length];
  const r = await http(GBASE + IMAGE_MODEL + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: String(prompt).slice(0, 1200) }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio }
      }
    })
  }, 45000, deadline);

  if (!r.ok) {
    const errTxt = await r.text();
    throw new Error(`שגיאה ביצירת תמונה (${IMAGE_MODEL}): ${r.status} ${errTxt.slice(0, 140)}`);
  }
  const j = await r.json();
  const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  const img = parts.find(p => p.inlineData && p.inlineData.data);
  if (!img) throw new Error('לא התקבלה תמונה מהמודל');
  const mime = img.inlineData.mimeType || 'image/png';
  const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png';
  return { base64: img.inlineData.data, mimeType: mime, ext };
}

async function runGenerateImage(args, deadline) {
  if (!KEYS.length) return { error: 'GEMINI_API_KEYS missing' };

  const count = Math.min(4, Math.max(1, parseInt(args.count, 10) || 1));
  const validRatios = ['1:1', '16:9', '9:16', '4:3', '3:4'];
  const aspectRatio = validRatios.includes(args.aspect_ratio) ? args.aspect_ratio : '1:1';
  let files = [];

  if (/^imagen-/i.test(IMAGE_MODEL)) {
    const key = KEYS[rot.text++ % KEYS.length];
    const r = await http(GBASE + IMAGE_MODEL + ':predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        instances: [{ prompt: String(args.prompt).slice(0, 1000) }],
        parameters: { sampleCount: count, aspectRatio }
      })
    }, 45000, deadline);
    if (!r.ok) throw new Error('שגיאה ביצירת תמונה: ' + r.status + ' ' + (await r.text()).slice(0, 140));
    const j = await r.json();
    const preds = j.predictions || [];
    if (!preds.length) throw new Error('לא התקבלו תמונות מהמודל');
    files = preds.map((p, idx) => ({
      filename: `generated_image_${idx + 1}.png`,
      base64: p.bytesBase64Encoded,
      mimeType: p.mimeType || 'image/png'
    }));
  } else {
    const tasks = Array.from({ length: count }, () => generateOneGeminiImage(args.prompt, aspectRatio, deadline));
    const settled = await Promise.allSettled(tasks);
    const okImgs = settled.filter(x => x.status === 'fulfilled').map(x => x.value);
    if (!okImgs.length) {
      const reason = settled[0] && settled[0].reason ? settled[0].reason.message : 'unknown image error';
      throw new Error(reason);
    }
    files = okImgs.map((img, idx) => ({
      filename: `generated_image_${idx + 1}.${img.ext}`,
      base64: img.base64,
      mimeType: img.mimeType
    }));
  }

  await sendViaGasEmail({
    subject: `התמונות שיצרת מוכנות (${files.length} תמונות, יחס ${aspectRatio})`,
    body: `שלום,\nמצורפות ${files.length} תמונות שנוצרו לפי הבקשה שלך:\n"${args.prompt}"\nיחס גובה-רוחב: ${aspectRatio}`,
    files
  }, deadline);

  return { status: 'success', sent_to: TARGET_EMAIL, count: files.length, aspect_ratio: aspectRatio };
}

// ============================================================================
// כלי 7ב: חיפוש תמונות קיימות ברשת (Google Custom Search API) ושליחה למייל
// ============================================================================
const SEARCH_IMAGES_DECL = {
  name: 'search_and_email_images',
  description: 'Search Google Images for existing real-world images matching a query, download them, verify each file is under 20MB, and send them to the pre-configured email via Google Apps Script.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Exact Hebrew sentence: "אני מחפשת כעת תמונות ברשת ושולחת למייל"' },
      query: { type: 'STRING', description: 'Search query describing the images to find' },
      count: { type: 'INTEGER', description: 'Number of images to download and send, between 1 and 5' }
    },
    required: ['action_announcement', 'query']
  }
};

const MAX_IMG_BYTES = 20 * 1024 * 1024; // 20MB

async function fetchImageUnder20MB(url, idx, deadline) {
  try {
    const r = await http(url, {
      redirect: 'follow',
      headers: { 'User-Agent': CRAWLER_UA }
    }, 15000, deadline);
    if (!r.ok) return null;

    const ctype = String(r.headers.get('content-type') || '').toLowerCase();
    if (!ctype.startsWith('image/') || ctype.includes('svg')) return null;

    const clen = Number(r.headers.get('content-length') || 0);
    if (clen > MAX_IMG_BYTES) return null;

    const reader = r.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_IMG_BYTES) {
        reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    if (total < 1024) return null;

    const buf = Buffer.concat(chunks, total);
    const ext = ctype.includes('png') ? 'png' : ctype.includes('webp') ? 'webp' : ctype.includes('gif') ? 'gif' : 'jpg';
    return {
      filename: `found_image_${idx + 1}.${ext}`,
      base64: buf.toString('base64'),
      mimeType: ctype.split(';')[0].trim(),
      bytes: total
    };
  } catch (e) {
    return null;
  }
}

async function runSearchAndEmailImages(args, deadline) {
  if (!SEARCH_KEY || !SEARCH_CX) {
    throw new Error('חסרה הגדרת GOOGLE_SEARCH_CX לחיפוש תמונות בגוגל');
  }
  const query = String(args.query || '').trim();
  const count = Math.min(5, Math.max(1, parseInt(args.count, 10) || 3));

  const u = new URL('https://www.googleapis.com/customsearch/v1');
  u.searchParams.set('key', SEARCH_KEY);
  u.searchParams.set('cx', SEARCH_CX);
  u.searchParams.set('q', query);
  u.searchParams.set('searchType', 'image');
  u.searchParams.set('num', '10');
  u.searchParams.set('safe', 'active');

  const r = await http(u.toString(), { headers: { 'User-Agent': CRAWLER_UA } }, 15000, deadline);
  const j = await r.json();
  if (!r.ok) {
    throw new Error('שגיאה בחיפוש תמונות בגוגל: ' + ((j.error && j.error.message) || r.status));
  }

  const urls = (j.items || [])
    .map(it => it && it.link)
    .filter(link => typeof link === 'string' && /^https?:\/\//i.test(link));

  if (!urls.length) throw new Error('לא נמצאו תמונות מתאימות בגוגל');

  const downloaded = await Promise.all(urls.map((imgUrl, idx) => fetchImageUnder20MB(imgUrl, idx, deadline)));
  const validFiles = [];
  let totalBytes = 0;
  for (const f of downloaded) {
    if (!f) continue;
    if (totalBytes + f.bytes > MAX_IMG_BYTES) continue;
    totalBytes += f.bytes;
    validFiles.push({
      filename: `found_image_${validFiles.length + 1}${path.extname(f.filename)}`,
      base64: f.base64,
      mimeType: f.mimeType
    });
    if (validFiles.length >= count) break;
  }

  if (!validFiles.length) throw new Error('לא נמצאו תמונות תקינות מתחת ל-20 מגה-בייט להורדה');

  await sendViaGasEmail({
    subject: `תמונות שנמצאו עבור: ${query} (${validFiles.length} תמונות)`,
    body: `שלום,\nמצורפות ${validFiles.length} תמונות שנמצאו בגוגל עבור החיפוש:\n"${query}"\n(כל הקבצים נבדקו ותקינים מתחת למגבלת 20 מ"ב).`,
    files: validFiles
  }, deadline);

  return { status: 'success', sent_to: TARGET_EMAIL, count: validFiles.length };
}


// ============================================================================
// כלי 8: יצירת אודיו/קריינות + כלי 9: שמירת העדפות/כתובת קבועה למתקשר
// ============================================================================
const GEN_AUDIO_DECL = {
  name: 'generate_audio',
  description: 'Generate custom spoken narration audio from text, and play it on the phone, email it as a WAV file via Google Apps Script, or both.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Exact Hebrew sentence: "אני מכינה כעת את קובץ השמע"' },
      script_text: { type: 'STRING', description: 'Exact Hebrew text to synthesize into audio' },
      delivery: { type: 'STRING', description: '"play" (play on phone), "email" (send to email), or "both"' },
      voice_gender: { type: 'STRING', description: '"male" or "female"' },
      title: { type: 'STRING', description: 'Short title for the audio file' }
    },
    required: ['action_announcement', 'script_text', 'delivery']
  }
};

async function runGenerateAudio(args, s, deadline) {
  const voice = args.voice_gender === 'male' ? (process.env.VOICE_MALE || 'Charon') : (process.env.VOICE_FEMALE || 'Kore');
  const wavBuf = await ttsMergedWav(String(args.script_text).slice(0, 4000), deadline, { voice });
  const delivery = String(args.delivery || 'play').toLowerCase();
  const title = String(args.title || 'קובץ שמע מקו AI').slice(0, 60);

  if (delivery === 'email' || delivery === 'both') {
    await sendViaGasEmail({
      subject: `קובץ אודיו חדש: ${title}`,
      body: `שלום,\nמצורף קובץ השמע שביקשת לייצר.\nתוכן הטקסט:\n${args.script_text}`,
      files: [{
        filename: 'audio_output.wav',
        base64: wavBuf.toString('base64'),
        mimeType: 'audio/wav'
      }]
    }, deadline);
  }

  if (delivery === 'play' || delivery === 'both') {
    const name = 'ga' + crypto.randomBytes(4).toString('hex');
    await upload(name, wavBuf, deadline, s.d, 25000);
    s.extraPlayChain = (s.extraPlayChain ? s.extraPlayChain + '.' : '') + 'f-' + s.d + '/' + name;
  }

  return { status: 'success', delivery, emailed_to: (delivery !== 'play') ? TARGET_EMAIL : null };
}

const SAVE_MEMORY_DECL = {
  name: 'save_caller_memory',
  description: 'Save a permanent personal fact or preference for this caller (e.g., home address for transit like "כתובת בית: רבי עקיבא 100 בני ברק", work address, caller name, or permanent instruction) so future phone calls remember it.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Exact Hebrew sentence: "אני שומרת את הפרטים בזיכרון האישי שלך"' },
      fact: { type: 'STRING', description: 'Concise Hebrew key:value fact to remember (e.g., "כתובת בית: רבי עקיבא 100 בני ברק")' },
      clear_all: { type: 'BOOLEAN', description: 'Set true ONLY if the caller explicitly asked to clear/forget all saved personal facts' }
    },
    required: ['action_announcement', 'fact']
  }
};

async function runSaveCallerMemory(args, s) {
  if (!s.ph || !HISTORY_EXT) {
    return { status: 'session_only', note: 'מספר המתקשר חסוי או שלוחת היסטוריה כבויה; נשמר לשיחה הנוכחית בלבד.' };
  }
  const mem = await loadCallerMemory(s.ph);
  if (args.clear_all) {
    mem.notes = [];
  } else {
    const fact = String(args.fact || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (fact) {
      const prefix = fact.includes(':') ? fact.split(':')[0].trim() : '';
      if (prefix) mem.notes = mem.notes.filter(n => !n.startsWith(prefix + ':'));
      mem.notes.unshift(fact);
      mem.notes = mem.notes.slice(0, 15);
    }
  }
  s.callerMem = mem;
  await saveCallerMemoryBg(s.ph, mem);
  return { status: 'saved_permanently', notes: mem.notes };
}

// --- עיבוד מדיה והעלאה לימות ---
const mediaDone = {};
async function prepareMedia(m, d, dl0) {
  const name = 'mf' + crypto.createHash('sha1').update(m.u).digest('hex').slice(0, 12);
  const key = d + '/' + name;
  if (mediaDone[key]) return { name };
  const dl = dl0 || Date.now() + 90000;
  const tmp = path.join(os.tmpdir(), name + '-' + crypto.randomBytes(3).toString('hex'));
  try {
    const r = await http(m.u, { headers: { 'User-Agent': CRAWLER_UA }, redirect: 'follow' }, 45000, dl);
    if (!r.ok) throw new Error('media download ' + r.status);
    const out = fs.createWriteStream(tmp + '.in');
    const reader = r.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (got > 104857600) { reader.cancel().catch(() => {}); throw new Error('media file too large'); }
      if (!out.write(value)) await new Promise(res => out.once('drain', res));
    }
    await new Promise((res, rej) => out.end(e => (e ? rej(e) : res())));
    let buf;
    if (FFMPEG) {
      await execFileP(FFMPEG, ['-y', '-v', 'error', '-i', tmp + '.in', '-vn', '-t', '1200', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', tmp + '.wav'], { timeout: Math.max(5000, dl - Date.now()) });
      buf = fs.readFileSync(tmp + '.wav');
    } else {
      buf = fs.readFileSync(tmp + '.in');
    }
    await upload(name, buf, dl, d, 50000);
    mediaDone[key] = true;
    return { name };
  } finally {
    for (const x of ['.in', '.wav']) fs.rm(tmp + x, { force: true }, () => {});
  }
}

// ============================================================================
// לולאת הסוכן הרב-שלבי (Multi-Step Agentic Execution Loop - עד 6 שלבים)
// ============================================================================
const MAX_AGENT_STEPS = 6;

async function askModel(sys, contents, deadline, s) {
  const base = { systemInstruction: { parts: [{ text: sys }] } };
  const decls = [PARALLEL_SEARCH_DECL, FETCH_WEBPAGE_DECL, RSS_RADIO_DECL, GEN_IMAGE_DECL, SEARCH_IMAGES_DECL, GEN_AUDIO_DECL, SAVE_MEMORY_DECL];
  if (GAS_MAIL_URL && TARGET_EMAIL) decls.push(SEND_EMAIL_DECL);
  if (MAPS_KEY) {
    decls.push(MAPS_DECL);
    decls.push(PLACES_DECL);
  }

  const tools = [{ functionDeclarations: decls }];
  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    if (s && s.cancelled) throw new Error('cancelled');
    const a = await textGen({ ...base, contents, tools }, deadline);
    const cand = (a.candidates || [])[0] || {};
    const fcalls = ((cand.content || {}).parts || []).filter(p => p.functionCall);
    if (!fcalls.length) return a;

    // השמעת הודעת התקדמות חיה למתקשר עבור השלב הנוכחי
    const announcements = fcalls.map(c => (c.functionCall.args || {}).action_announcement).filter(Boolean);
    if (announcements.length) pushStatus(s, announcements[0]);

    const resp = await Promise.all(fcalls.map(async c => {
      const args = c.functionCall.args || {};
      const fname = c.functionCall.name;
      let out;
      try {
        if (fname === 'google_maps_route') {
          out = await runGoogleMapsRoute(args, s, deadline);
        } else if (fname === 'google_places_search') {
          out = await runGooglePlacesSearch(args, s, deadline);
        } else if (fname === 'web_search_parallel') {
          out = await runParallelGroqSearch(args.queries, s, deadline);
        } else if (fname === 'fetch_webpage') {
          out = await runFetchWebpage(args, deadline);
        } else if (fname === 'play_rss_radio') {
          out = await prepareRssRadio(args, s, deadline);
        } else if (fname === 'send_email') {
          out = await runSendEmail(args, deadline);
        } else if (fname === 'generate_image') {
          out = await runGenerateImage(args, deadline);
        } else if (fname === 'search_and_email_images') {
          out = await runSearchAndEmailImages(args, deadline);
        } else if (fname === 'generate_audio') {
          out = await runGenerateAudio(args, s, deadline);
        } else if (fname === 'save_caller_memory') {
          out = await runSaveCallerMemory(args, s);
        } else {
          out = { error: 'Unknown tool: ' + fname };
        }
      } catch (err) {
        if (isBudget(err)) throw err;
        console.error('Tool error', fname, err.message);
        out = { error: err.message };
      }
      return { functionResponse: { name: fname, response: out } };
    }));

    if (s && s.transferToExt) return a;
    contents = [...contents, cand.content, { role: 'user', parts: resp }];
  }
  return textGen({ ...base, contents }, deadline);
}

// ============================================================================
// מנוע TTS מהיר + שרשור מקטעים במקביל להאצת זמן תגובה
// ============================================================================
function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const isNewTts = m => /^gemini-(3\.[8-9]|[4-9])/.test(m);
const isLegacy25Tts = m => /^gemini-2\.5/i.test(m);
const voicesFor = (model, name) => isNewTts(model)
  ? [{ voice: name }, { prebuiltVoiceConfig: { voiceName: name } }]
  : [{ prebuiltVoiceConfig: { voiceName: name } }, { voice: name }];

const vIdx = {};
const ttsDown = {};
const VOICE_BY = { male: process.env.VOICE_MALE || 'Charon', female: VOICE };
const PACE_PREFIX = { slow: 'Say slowly and clearly: ', fast: 'Say briskly and clearly: ' };

const SHORT_RE = /^\s*(?:ת?קצר(?:י)? את התשוב(?:ה|ות)|תענה(?: יותר)? קצר|תענה בקצרה|בקצרה|בקיצור)\s*/;
const LONG_RE = /^\s*(?:תפרט|תרחיב|תאריך את התשוב(?:ה|ות)|תענה(?: יותר)? בהרחבה)\s*/;

function parseCtl(text) {
  const ctl = {};
  let q = '';
  const noQ = text.replace(/\[\[\s*Q\s*:([^\]]*)\]\]/gi, (m, v) => { if (!q) q = v.replace(/\s+/g, ' ').trim(); return ' '; });
  const clean = noQ.replace(/\[\[\s*(VOICE|PACE|LEN)\s*:\s*([a-z]+)\s*\]\]/gi, (m, k, v) => { ctl[k.toLowerCase()] = v.toLowerCase(); return ' '; });
  return { text: clean.replace(/[*#_`~]/g, '').replace(/\s+/g, ' ').trim(), ctl, q: q.slice(0, 500) };
}

function splitTextForChunks(text, firstMax = 420, nextMax = 780) {
  const out = [];
  let cur = '';
  for (let sn of String(text || '').split(/(?<=[.!?:;])\s+/)) {
    for (;;) {
      const limit = out.length === 0 ? firstMax : nextMax;
      if (sn.length <= limit) break;
      let k = sn.lastIndexOf(' ', limit);
      if (k < 150) k = limit;
      if (cur) { out.push(cur); cur = ''; }
      out.push(sn.slice(0, k).trim());
      sn = sn.slice(k).trim();
    }
    if (!sn) continue;
    const limit = out.length === 0 ? firstMax : nextMax;
    if (cur && cur.length + sn.length + 1 > limit) {
      out.push(cur);
      cur = sn;
    } else {
      cur = cur ? cur + ' ' + sn : sn;
    }
  }
  if (cur) out.push(cur);
  return out.filter(Boolean);
}

function pcmOf(buf) {
  let p = 12, rate = 24000;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4), sz = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') rate = buf.readUInt32LE(p + 12);
    if (id === 'data') return { rate, pcm: buf.subarray(p + 8, Math.min(buf.length, p + 8 + sz)) };
    p += 8 + sz + (sz & 1);
  }
  return { rate, pcm: buf.subarray(44) };
}

function to8k(x) {
  const f = x.rate / 8000;
  if (f === 1 || !Number.isInteger(f)) return x;
  const n = Math.floor(x.pcm.length / 2 / f), out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < f; k++) sum += x.pcm.readInt16LE((i * f + k) * 2);
    out.writeInt16LE(Math.round(sum / f), i * 2);
  }
  return { rate: 8000, pcm: out };
}

async function ttsOne(text, deadline, o) {
  o = o || {};
  const pacePrefix = PACE_PREFIX[o.pace] || '';
  let last = new Error('no audio from tts');
  if (TTS_LIST.every(m => (ttsDown[m] || 0) > Date.now())) {
    last = new Error('all tts models are out of quota');
    last.status = 429;
    throw last;
  }
  for (let mi = 0; mi < TTS_LIST.length; mi++) {
    const model = TTS_LIST[mi];
    const hasNext = mi < TTS_LIST.length - 1;
    if ((ttsDown[model] || 0) > Date.now()) continue;
    const V = voicesFor(model, o.voice || VOICE);
    const modelPrefix = isLegacy25Tts(model) && !pacePrefix ? 'Read aloud verbatim: ' : pacePrefix;
    for (let i = 0; i < 3; i++) {
      try {
        const t = await gem(model, {
          contents: [{ role: 'user', parts: [{ text: modelPrefix + text.slice(0, 3000) }] }],
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: V[vIdx[model] || 0] } }
        }, deadline, 'tts', hasNext ? { ms: 42000, retries: 0 } : { ms: 45000 });
        const parts = (((t.candidates || [])[0] || {}).content || {}).parts || [];
        const part = parts.find(p => p.inlineData && p.inlineData.data);
        if (part) {
          let pcm = Buffer.from(part.inlineData.data, 'base64');
          if (pcm.subarray(0, 4).toString() !== 'RIFF') {
            const m = /rate=(\d+)/.exec(part.inlineData.mimeType || '');
            pcm = wav(pcm, m ? Number(m[1]) : 24000);
          }
          return pcm;
        }
        last = new Error('no audio from tts');
      } catch (e) {
        last = e;
        if (isBudget(e)) throw e;
        if (e.status === 400 && /voice|speech/i.test(e.message) && (vIdx[model] || 0) < V.length - 1) {
          vIdx[model] = (vIdx[model] || 0) + 1;
          continue;
        }
        if (e.status === 429 || e.status === 404 || e.status >= 500) break;
      }
    }
    if (hasNext || last.status === 429) {
      ttsDown[model] = Date.now() + (last.status === 404 ? 3600000 : (last.status === 429 ? 600000 : 120000));
    }
  }
  throw last;
}

// איחוד לקובץ WAV אחד (עבור הודעות מערכת קצרות וקבצי מייל)
async function ttsMergedWav(text, deadline, o) {
  const parts = splitTextForChunks(String(text).slice(0, 8000), 800, 850);
  if (parts.length <= 1) return ttsOne(text, deadline, o);
  const bufs = await Promise.all(parts.map(x => ttsOne(x, deadline, o)));
  const gap = Buffer.alloc(2400);
  const pcms = [];
  bufs.forEach((b, i) => { if (i) pcms.push(gap); pcms.push(to8k(pcmOf(b)).pcm); });
  return wav(Buffer.concat(pcms), 8000);
}

// סינתזה והעלאה במקביל של מקטעים לימות להאצת ההשמעה של תשובות ארוכות
async function ttsUploadChain(s, text, deadline, o, basePrefix) {
  const parts = splitTextForChunks(String(text).slice(0, 8500), 420, 780);
  if (!parts.length) return null;
  const uploadedNames = [];
  const chainRefs = await Promise.all(parts.map(async (chunk, idx) => {
    const pcm = await ttsOne(chunk, deadline, o);
    const fname = `${basePrefix}p${idx}`;
    await upload(fname, pcm, deadline, s.d, 26000);
    uploadedNames.push(fname);
    return 'f-' + s.d + '/' + fname;
  }));
  return { chain: chainRefs.join('.'), files: uploadedNames };
}

// --- פעולות קבצים מול API ימות המשיח ---
const EXTP = '/' + EXT;
const yp = (name, d) => 'ivr2:' + (d === undefined ? EXTP : d) + '/' + name + (/\.[a-z0-9]+$/i.test(name) ? '' : '.wav');

async function download(name, deadline, d, returnedPath, apiExt) {
  const candidates = [];
  if (returnedPath && /[a-z0-9_\/.-]+\.wav$/i.test(returnedPath)) {
    const clean = returnedPath.replace(/^ivr2:/i, '');
    candidates.push('ivr2:' + (clean.startsWith('/') ? '' : '/') + clean);
  }
  candidates.push(yp(name, d));
  if (apiExt !== undefined && apiExt !== d) candidates.push(yp(name, apiExt));
  if (d !== '') candidates.push(yp(name, ''));
  const uniquePaths = [...new Set(candidates)];

  let last = '';
  for (let i = 0; i < 6; i++) {
    await sleep(i === 0 ? 400 : 600);
    const targetPath = uniquePaths[i % uniquePaths.length];
    try {
      const r = await http(YM + 'DownloadFile?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent(targetPath), {}, 8000, deadline);
      const b = Buffer.from(await r.arrayBuffer());
      if (r.ok && b.length > 100 && b.subarray(0, 4).toString() === 'RIFF') return b;
      last = r.status + ' ' + b.subarray(0, 80).toString('utf8').replace(/\s+/g, ' ');
    } catch (e) {
      if (isBudget(e)) throw e;
      last = e.message;
    }
  }
  throw new Error('download failed [' + uniquePaths.join(' | ') + '] Q=' + (returnedPath || '') + ' -> ' + last);
}

async function upload(name, buf, deadline, d, ms) {
  const target = yp(name, d);
  const attempts = [
    { q: true, field: 'file' }, { q: true, field: 'upload' },
    { q: false, field: 'upload' }, { q: false, field: 'file' }
  ];
  let last = '';
  for (const a of attempts) {
    try {
      const f = new FormData();
      let url = YM + 'UploadFile';
      if (a.q) {
        url += '?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent(target) + '&convertAudio=1';
      } else {
        f.append('token', TOKEN); f.append('path', target); f.append('convertAudio', '1');
      }
      f.append(a.field, new Blob([buf], { type: 'audio/wav' }), name + '.wav');
      const r = await http(url, { method: 'POST', body: f }, ms || 15000, deadline);
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.responseStatus === 'OK') return;
      last = JSON.stringify(j).slice(0, 200);
    } catch (e) {
      if (isBudget(e)) throw e;
      last = e.message;
      if (ms && e.name === 'TimeoutError') break;
    }
  }
  throw new Error('upload failed (' + target + ') ' + last);
}

function del(name, d) {
  if (!name || !TOKEN) return;
  fetch(YM + 'FileAction?token=' + encodeURIComponent(TOKEN) + '&action=delete&what=' + encodeURIComponent(yp(name, d)), { signal: AbortSignal.timeout(8000) }).catch(() => {});
}

function cleanupReplyFiles(s) {
  if (!s) return;
  if (Array.isArray(s.rFiles)) {
    for (const f of s.rFiles) del(f, s.d);
    s.rFiles = [];
  }
  if (s.routeAudioCache) {
    for (const entry of Object.values(s.routeAudioCache)) {
      if (entry && Array.isArray(entry.files)) {
        for (const f of entry.files) del(f, s.d);
      }
    }
    s.routeAudioCache = {};
  }
}

// --- מטמון הודעות מערכת והודעות שלבים ---
const sysReady = {};
const sysInFlight = {};
async function sysClip(s, text, timeoutMs) {
  const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleanText) return '';
  const dir = (s && s.d) || ('/' + EXT);
  const voice = (s && s.vc && VOICE_BY[s.vc]) || VOICE;
  const hash = crypto.createHash('sha1').update(voice + '|' + cleanText).digest('hex').slice(0, 10);
  const name = 'sp' + hash;
  const key = dir + '/' + name;

  if (sysReady[key]) return 'f-' + dir + '/' + name;

  if (!sysInFlight[key]) {
    sysInFlight[key] = (async () => {
      const waitMs = timeoutMs || 15000;
      const dl = Date.now() + waitMs;
      const pcm = await ttsMergedWav(cleanText, dl, { voice });
      await upload(name, pcm, dl, dir, waitMs);
      sysReady[key] = true;
    })().catch(e => {
      console.error('sysClip fallback:', e.message);
    }).finally(() => {
      delete sysInFlight[key];
    });
  }

  await sysInFlight[key];
  return sysReady[key] ? ('f-' + dir + '/' + name) : ('t-' + sp(cleanText));
}

// ============================================================================
// ניהול שיחות ותפריטים בימות המשיח
// ============================================================================
let CFG = [];
try { CFG = JSON.parse(process.env.EXTENSIONS || '[]'); } catch (e) { CFG = []; }
if (!Array.isArray(CFG) || !CFG.length) CFG = [{ p: EXT, m: '2', x: '', g: process.env.GREETING || '' }];

const DEFAULT_GREET = 'הי, כאן תהילה.';
const EXTS = {};
for (const c of CFG) {
  const p = String(c.p || '').replace(/^\/+|\/+$/g, '');
  if (!/^[0-9]+(\/[0-9]+)*$/.test(p)) continue;
  EXTS[p.replace(/\//g, '_')] = {
    p, d: '/' + p,
    sys: buildBaseSys(c.m, String(c.x || '').replace(/\s+/g, ' ').trim().slice(0, 1000)),
    g: String(c.g || '').trim().slice(0, 300) || DEFAULT_GREET
  };
}
const EXT_FIRST = EXTS[Object.keys(EXTS)[0]] || { p: EXT, d: '/' + EXT, sys: buildBaseSys('2', ''), g: DEFAULT_GREET };
const AGAIN = 'לא שמעתי טוב, דבר שוב';
const ERR = 'תקלה קטנה, ננסה עוד פעם';

const idOf = q => String(q.ApiCallId || 'x').replace(/[^a-zA-Z0-9]/g, '').slice(-24) || 'x';
const phoneOf = q => { const p = String(q.ApiPhone || '').replace(/\D/g, ''); return p.length >= 7 && p.length <= 15 ? p : ''; };
const normApiExt = q => {
  if (q.ApiExtension === undefined || q.ApiExtension === null) return null;
  const raw = String(q.ApiExtension).trim().replace(/^\/+|\/+$/g, '');
  return raw ? '/' + raw : '';
};

const newSession = (d, sys, g, extra) => Object.assign({
  d, sys, g, n: 0, hn: 0, mode: '', job: null, cancelled: false,
  vc: '', pace: '', len: '', h: [], p: '', name: '',
  rFiles: [], t: 0, e: crypto.randomBytes(3).toString('hex'),
  statusQueue: [], routeAlternatives: [], routeObjects: [], routeAudioCache: {},
  workingMemory: {}, callerMem: null, interruptedLast: false, convId: ''
}, extra || {});

const EMPTY = 'None';
const TAP_EMPTY = ',No,no,no,,,,Ok,' + EMPTY;
const digitsOf = v => { const x = String(v == null ? '' : v).trim(); return x === EMPTY ? '' : x; };

const KB_KEYS = { '3': 'אבג', '2': 'דהו', '6': 'זחט', '5': 'יכךל', '4': 'מםנן', '9': 'סעפף', '8': 'צץק', '7': 'רשת' };
const KB_FINAL = { 'כ': 'ך', 'מ': 'ם', 'נ': 'ן', 'פ': 'ף', 'צ': 'ץ' };
const KB_WAIT = Math.min(60, Math.max(3, parseInt(process.env.KBD_WAIT, 10) || 20));
const WAIT_SEC = Math.min(15, Math.max(2, parseInt(process.env.INPUT_WAIT_SEC, 10) || 7));
const MENU_OPEN = 'להקלטת בקשה הקש 1, להקלדה הקש 2';
const MENU = 'להקלטה הקש  1, להקלדה הקש  2';
const KB_MORE = 'לבקשה נוספת, הקש 1 להקלטה או 2 להקלדה';
const KB_START = 'הקלד ולחץ סולמית לסיום';
const kbFinal = t => t.replace(/(?<=[א-ת])[כמנפצ](?=\s|$)/g, c => KB_FINAL[c]);

const askFor = async (s, preText) => {
  s.n++; s.mode = 'rec'; s.p = 'Q' + s.e + s.n; s.name = 'q' + s.e + 'n' + s.n;
  const clip = await sysClip(s, preText);
  return 'read=' + clip + '=' + s.p + ',no,record,' + s.d + ',' + s.name + ',no,,,1,' + REC_MAX;
};
const tapAny = async (s, preText, menuText) => {
  s.n++; s.mode = 'menu'; s.p = 'K' + s.e + s.n;
  const fullPrompt = [preText, menuText || MENU].filter(Boolean).join('. ');
  const clip = await sysClip(s, fullPrompt);
  return 'read=' + clip + '=' + s.p + ',no,1,1,' + WAIT_SEC + TAP_EMPTY;
};
const ansFor = (s, pre) => { s.n++; s.mode = 'ans'; s.p = 'A' + s.e + s.n; return 'read=' + pre + '=' + s.p + ',no,1,1,1' + TAP_EMPTY; };
const routeChoiceFor = (s, pre) => { s.n++; s.mode = 'route_choice'; s.p = 'R' + s.e + s.n; return 'read=' + pre + '=' + s.p + ',no,1,1,10' + TAP_EMPTY; };
const kbAsk = async (s, preText) => {
  s.n++; s.mode = 'type'; s.p = 'K' + s.e + s.n;
  const clip = await sysClip(s, preText);
  return 'read=' + clip + '=' + s.p + ',no,*,1,' + KB_WAIT + TAP_EMPTY;
};

function kbKey(s, raw) {
  const d = String(raw || '').replace(/#/g, '').trim();
  for (const r of d.match(/(\d)\1*/g) || []) {
    const k = r[0], n = r.length;
    if (k === '1') { s.buf += '1'.repeat(Math.floor(n / 2)); continue; }
    if (n === 5) { s.buf += k; continue; }
    if (k === '0') { if (n === 1) s.buf += ' '; else if (n === 2) s.buf = s.buf.slice(0, -1); continue; }
    const L = KB_KEYS[k];
    if (L && n <= L.length) s.buf += L[n - 1];
  }
}

async function kbStep(s, q, id, T0) {
  const d = digitsOf(q[s.p]);
  if (!d) return await tapAny(s, 'לא הוקלד כלום');
  s.buf = '';
  kbKey(s, d);
  const text = kbFinal(s.buf.replace(/\s+/g, ' ').trim().slice(0, 600));
  s.buf = '';
  if (!text) return await kbAsk(s, 'לא הוקלד טקסט, נסו שוב');
  return await runTurn(s, q, id, T0, text);
}

async function runTurn(s, q, id, T0, typed) {
  const recVal = typed ? '' : digitsOf(q[s.p]);
  if (!typed && !recVal) return await tapAny(s, AGAIN);
  s.jobT0 = Date.now();
  s.cancelled = false;
  s.statusQueue = ['קיבלתי, רגע אחד'];
  s.extraPlayChain = '';
  s.transferToExt = '';
  s.awaitingRouteChoice = false;
  s.job = doTurn(s, q, id, s.jobT0, typed, recVal).catch(async e => {
    console.error(id, 'turn crashed', e && e.message);
    return await tapAny(s, ERR);
  });
  return await holdStep(s, q);
}

async function holdStep(s, q) {
  // אפשרות ביטול משימה בלחיצה על 0 בזמן ההמתנה
  const prevHoldKey = 'H' + s.e + s.hn;
  if (q && digitsOf(q[prevHoldKey]) === '0') {
    s.cancelled = true;
    s.job = null;
    s.statusQueue = [];
    return await tapAny(s, 'הבקשה בוטלה');
  }

  if (s.statusQueue && s.statusQueue.length > 0) {
    const msg = s.statusQueue.shift();
    s.hn++;
    const clip = await sysClip(s, msg, 15000);
    return 'read=' + clip + '=H' + s.e + s.hn + ',no,1,1,1' + TAP_EMPTY;
  }

  const waitSig = new Promise(res => { s.onStatus = res; });
  const r = await Promise.race([s.job, waitSig.then(() => null), sleep(5500).then(() => 'tick')]);
  s.onStatus = null;

  if (r && r !== 'tick') {
    s.job = null;
    return r;
  }
  if (s.statusQueue && s.statusQueue.length > 0) {
    const msg = s.statusQueue.shift();
    s.hn++;
    const clip = await sysClip(s, msg, 15000);
    return 'read=' + clip + '=H' + s.e + s.hn + ',no,1,1,1' + TAP_EMPTY;
  }
  if (Date.now() - s.jobT0 > BUDGET + 15000) {
    s.cancelled = true;
    s.job = null;
    return await tapAny(s, ERR);
  }
  s.hn++;
  const waitClip = await sysClip(s, 'עוד רגע', 15000);
  return 'read=' + waitClip + '=H' + s.e + s.hn + ',no,1,1,1' + TAP_EMPTY;
}

async function speakAndReturn(s, text, deadline, useRouteMenu, cacheSlot) {
  const tail = s.extraPlayChain ? '.' + s.extraPlayChain : '';
  s.extraPlayChain = '';
  const builder = useRouteMenu ? routeChoiceFor : ansFor;

  if (cacheSlot && s.routeAudioCache && s.routeAudioCache[cacheSlot]) {
    return builder(s, s.routeAudioCache[cacheSlot].chain + tail);
  }

  let built = null;
  try {
    const basePrefix = 'r' + s.e + 'n' + s.n;
    built = await ttsUploadChain(s, text, deadline, { voice: VOICE_BY[s.vc], pace: s.pace }, basePrefix);
  } catch (te) {
    console.error('ttsUploadChain fallback:', te.message);
  }

  if (!built || !built.chain) {
    return builder(s, 't-' + (sp(text) || sp(ERR)) + tail);
  }

  if (cacheSlot) {
    s.routeAudioCache = s.routeAudioCache || {};
    s.routeAudioCache[cacheSlot] = built;
  } else {
    s.rFiles = [...(s.rFiles || []), ...built.files];
  }
  return builder(s, built.chain + tail);
}

async function doTurn(s, q, id, T0, typed, recVal) {
  const deadline = T0 + BUDGET;
  const qn = s.name;
  try {
    let userPart, tq = typed;
    if (typed) {
      let m;
      if ((m = SHORT_RE.exec(tq))) { s.len = 'short'; tq = tq.slice(m[0].length).trim() || 'אשר בקצרה'; }
      else if ((m = LONG_RE.exec(tq))) { s.len = ''; tq = tq.slice(m[0].length).trim() || 'אשר בהרחבה'; }
      userPart = { text: 'הבקשה הוקלדה במקשי הטלפון: ' + tq };
    } else {
      const audio = await download(qn, deadline, s.d, recVal, s.apiExt);
      del(qn, s.d);
      userPart = { inlineData: { mimeType: 'audio/wav', data: audio.toString('base64') } };
    }

    cleanupReplyFiles(s);

    const turnSys = buildDynamicTurnSys(s);
    s.interruptedLast = false;

    const a = await askModel(
      turnSys,
      [...s.h.slice(-10), { role: 'user', parts: [userPart] }],
      deadline,
      s
    );

    if (s.cancelled) return await tapAny(s, 'הבקשה בוטלה');

    if (s.transferToExt) {
      const target = s.transferToExt;
      s.transferToExt = '';
      const trClip = await sysClip(s, 'מעבירה אותך לשידור החי', 15000);
      return `id_list_message=${trClip}&go_to_folder=${target}`;
    }

    const parts = (((a.candidates || [])[0] || {}).content || {}).parts || [];
    let text = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();
    if (!text && s.awaitingRouteChoice && s.routeOverviewSpeech) {
      text = s.routeOverviewSpeech;
    }
    if (!text) throw new Error('empty answer');

    const ctl = parseCtl(text);
    text = ctl.text || 'הפעולה בוצעה בהצלחה';
    let prefChanged = false;
    if (ctl.ctl.voice === 'male' || ctl.ctl.voice === 'female') { s.vc = ctl.ctl.voice; prefChanged = true; }
    else if (ctl.ctl.voice === 'default') { s.vc = ''; prefChanged = true; }
    if (ctl.ctl.len === 'short') { s.len = 'short'; prefChanged = true; }
    else if (ctl.ctl.len === 'long') { s.len = ''; prefChanged = true; }
    if (ctl.ctl.pace === 'slow' || ctl.ctl.pace === 'fast') { s.pace = ctl.ctl.pace; prefChanged = true; }
    else if (ctl.ctl.pace === 'normal') { s.pace = ''; prefChanged = true; }

    const qtext = tq || ctl.q || '[בקשה קולית]';
    s.lastSpokenAnswer = text;
    s.h.push({ role: 'user', parts: [{ text: qtext }] }, { role: 'model', parts: [{ text }] });
    if (s.h.length > 16) s.h = s.h.slice(-16);

    // שמירת שיחה והעדפות ברקע בשלוחה 9 של ימות המשיח
    if (s.ph && HISTORY_EXT) {
      recordTurnInCallerHistory(s, qtext, text).catch(() => {});
    } else if (prefChanged && s.ph) {
      loadCallerMemory(s.ph).then(mem => {
        if (mem) { mem.vc = s.vc; mem.pace = s.pace; mem.len = s.len; saveCallerMemoryBg(s.ph, mem); }
      }).catch(() => {});
    }

    const isRouteMenu = !!(s.awaitingRouteChoice && s.routeAlternatives && s.routeAlternatives.length > 0);
    return await speakAndReturn(s, text, deadline, isRouteMenu, isRouteMenu ? 'overview' : '');
  } catch (e) {
    console.error(id, 'turn failed:', e.message);
    if (!typed) del(qn, s.d);
    return await tapAny(s, ERR);
  }
}

async function handleRouteMenuKey(s, q, id) {
  const d = digitsOf(q[s.p]);
  const routes = s.routeObjects || [];
  const alts = s.routeAlternatives || [];
  const menuReminder = ' לחלופה אחרת הקש 1, 2 או 3, לשליחה למייל הקש 4, להוראות הליכה הקש 5, ליציאות מאוחרות יותר הקש 8, או הקש 0 לשאלה חדשה.';

  // 1, 2, 3 -> השמעת פירוט מלא של חלופה נבחרת
  const idx = parseInt(d, 10) - 1;
  if (idx >= 0 && idx < alts.length) {
    s.selectedRouteIdx = idx;
    const chosenText = alts[idx] + menuReminder;
    s.n++;
    return await speakAndReturn(s, chosenText, Date.now() + 45000, true, 'alt_' + idx);
  }

  // 4 -> שליחת כל החלופות למייל המוגדר
  if (d === '4') {
    s.n++;
    try {
      const originClean = (routes[0] && routes[0].originClean) || 'מוצא';
      const destClean = (routes[0] && routes[0].destClean) || 'יעד';
      await sendViaGasEmail({
        subject: `מסלולי תחבורה ציבורית: ${originClean} אל ${destClean}`,
        body: s.routeEmailBody || alts.join('\n\n'),
        files: []
      }, Date.now() + 25000);
      return await speakAndReturn(s, 'שלחתי את פירוט כל המסלולים והתחנות למייל שלך בהצלחה.' + menuReminder, Date.now() + 30000, true, 'emailed');
    } catch (e) {
      return await speakAndReturn(s, 'לא הצלחתי לשלוח את המייל כעת.' + menuReminder, Date.now() + 25000, true, '');
    }
  }

  // 5 -> השמעת פירוט הליכה רחוב-אחר-רחוב עבור החלופה הפעילה
  if (d === '5' && routes.length) {
    const sel = routes[s.selectedRouteIdx || 0] || routes[0];
    s.n++;
    return await speakAndReturn(s, `עבור חלופה ${sel.option} — ${sel.walkDetailSpeech}` + menuReminder, Date.now() + 40000, true, 'walk_' + (s.selectedRouteIdx || 0));
  }

  // 8 -> בדיקת יציאות מאוחרות יותר (+30 דקות)
  if (d === '8' && s.routeQueryMeta) {
    const nextMs = (s.routeQueryMeta.baseDepMs || Date.now()) + 30 * 60000;
    s.jobT0 = Date.now();
    s.cancelled = false;
    s.statusQueue = ['בודקת אוטובוסים שיוצאים בעוד חצי שעה'];
    s.job = (async () => {
      const dl = Date.now() + 55000;
      cleanupReplyFiles(s);
      const res = await runGoogleMapsRoute({
        action_announcement: 'בודקת יציאות מאוחרות יותר',
        origin: s.routeQueryMeta.origin,
        destination: s.routeQueryMeta.destination,
        mode: s.routeQueryMeta.mode,
        departure_time: new Date(nextMs).toISOString()
      }, s, dl);
      if (res.status === 'ok' && res.recommended_spoken_response) {
        s.n++;
        return await speakAndReturn(s, res.recommended_spoken_response, dl, true, 'overview');
      }
      return await tapAny(s, 'לא נמצאו נסיעות מאוחרות יותר');
    })().catch(async () => await tapAny(s, ERR));
    return await holdStep(s, q);
  }

  // 9 -> שמיעה חוזרת של הסקירה המלאה
  if (d === '9' && s.routeOverviewSpeech) {
    s.n++;
    return await speakAndReturn(s, s.routeOverviewSpeech, Date.now() + 45000, true, 'overview');
  }

  // 0 או אי-לחיצה -> מעבר חלק לתפריט שאלת המשך
  s.awaitingRouteChoice = false;
  return await tapAny(s, KB_MORE);
}

async function turnStep(s, q, id, T0) {
  if (s.job) return await holdStep(s, q);

  if (s.mode === 'route_choice') {
    return await handleRouteMenuKey(s, q, id);
  }

  if (s.mode === 'ans') {
    const d = digitsOf(q[s.p]);
    if (d === '1' || d === '2') {
      // המתקשר קטע את התשובה באמצע כדי להקליט או להקליד מיד
      s.interruptedLast = true;
      s.mode = 'menu';
    } else {
      return await tapAny(s, KB_MORE);
    }
  }
  if (s.mode === 'menu') {
    const d = digitsOf(q[s.p]);
    if (d === '1') return await askFor(s, 'דבר אחרי הצליל');
    if (d === '2') { s.buf = ''; return await kbAsk(s, KB_START); }
    return await tapAny(s, MENU);
  }
  if (s.mode === 'type') return await kbStep(s, q, id, T0);
  return await runTurn(s, q, id, T0);
}

// ============================================================================
// שלוחת היסטוריית שיחות אינטראקטיבית (/history או זיהוי אוטומטי משלוחה 9)
// ============================================================================
const histSessions = {};

async function handleHistory(req, res) {
  const q = { ...req.query, ...req.body };
  const id = 'h_' + idOf(q);
  res.type('text/plain');

  if (q.hangup === 'yes') {
    const old = histSessions[id];
    if (old) cleanupReplyFiles(old);
    delete histSessions[id];
    return res.send('noop=bye');
  }

  const ph = phoneOf(q);
  if (!ph) {
    return res.send('id_list_message=t-' + sp('היסטוריית השיחות זמינה רק למספר טלפון מזוהה') + '&go_to_folder=/');
  }

  let hs = histSessions[id];
  if (!hs) {
    const mem = await loadCallerMemory(ph);
    hs = histSessions[id] = {
      d: '/' + EXT, vc: (mem && mem.vc) || '', pace: (mem && mem.pace) || '',
      n: 0, idx: 0, state: 'browse', ph, mem, rFiles: [], e: crypto.randomBytes(3).toString('hex')
    };
  } else {
    hs.mem = await loadCallerMemory(ph);
  }

  const convs = (hs.mem && hs.mem.conversations) || [];
  if (!convs.length) {
    const clip = await sysClip(hs, 'אין לך עדיין שיחות שמורות בהיסטוריה. חוזר לתפריט הראשי', 8000);
    delete histSessions[id];
    return res.send(`id_list_message=${clip}&go_to_folder=/`);
  }

  if (hs.idx >= convs.length) hs.idx = 0;
  const cur = convs[hs.idx];
  const d = hs.p ? digitsOf(q[hs.p]) : '';

  if (hs.state === 'confirm_del') {
    hs.state = 'browse';
    if (d === '1') {
      hs.mem.conversations.splice(hs.idx, 1);
      await saveCallerMemoryBg(ph, hs.mem);
      if (!hs.mem.conversations.length) {
        const clip = await sysClip(hs, 'השיחה נמחקה ואין שיחות נוספות. חוזר לתפריט הראשי', 8000);
        delete histSessions[id];
        return res.send(`id_list_message=${clip}&go_to_folder=/`);
      }
      if (hs.idx >= hs.mem.conversations.length) hs.idx = 0;
    }
  } else if (hs.p) {
    if (d === '0') {
      cleanupReplyFiles(hs);
      delete histSessions[id];
      return res.send('go_to_folder=/');
    }
    if (d === '5') hs.idx = (hs.idx + 1) % convs.length;
    else if (d === '6') hs.idx = (hs.idx - 1 + convs.length) % convs.length;
    else if (d === '3') {
      hs.state = 'confirm_del';
      hs.n++; hs.p = 'HD' + hs.e + hs.n;
      const clip = await sysClip(hs, 'לאישור מחיקת השיחה הקש 1, לביטול הקש 2', 8000);
      return res.send('read=' + clip + '=' + hs.p + ',no,1,1,7' + TAP_EMPTY);
    } else if (d === '1') {
      // השמעת תוכן השיחה המלא
      cleanupReplyFiles(hs);
      const transcriptSpeech = cur.turns.map((t, i) => `שאלה ${i + 1}: ${t.q}. תשובה: ${t.a}.`).join(' ') +
        ' סוף השיחה. להמשך השיחה מאותה נקודה הקש 2, לשליחת התמליל למייל הקש 4, לשיחה הבאה הקש 5, ליציאה הקש 0.';
      hs.n++; hs.p = 'HP' + hs.e + hs.n;
      const built = await ttsUploadChain(hs, transcriptSpeech, Date.now() + 55000, { voice: VOICE_BY[hs.vc], pace: hs.pace }, 'hp' + hs.e + hs.n).catch(() => null);
      if (built && built.chain) {
        hs.rFiles = built.files;
        return res.send('read=' + built.chain + '=' + hs.p + ',no,1,1,8' + TAP_EMPTY);
      }
      return res.send('read=t-' + sp(transcriptSpeech.slice(0, 800)) + '=' + hs.p + ',no,1,1,8' + TAP_EMPTY);
    } else if (d === '4') {
      // שליחת תמליל השיחה למייל
      const body = cur.turns.map((t, i) => `שאלה ${i + 1}: ${t.q}\nתשובה: ${t.a}`).join('\n\n---\n\n');
      let msg = 'תמליל השיחה נשלח למייל שלך.';
      try {
        await sendViaGasEmail({ subject: `תמליל שיחה מקו AI: ${cur.title}`, body, files: [] }, Date.now() + 20000);
      } catch (e) {
        msg = 'לא ניתן היה לשלוח את המייל כעת.';
      }
      hs.n++; hs.p = 'HM' + hs.e + hs.n;
      const clip = await sysClip(hs, msg + ' להשמעה הקש 1, להמשך השיחה הקש 2, לשיחה הבאה הקש 5, ליציאה הקש 0.', 9000);
      return res.send('read=' + clip + '=' + hs.p + ',no,1,1,8' + TAP_EMPTY);
    } else if (d === '2') {
      // המשך השיחה בתוך הסוכן החכם עם כל ההקשר השמור!
      const mainId = idOf(q);
      const restoredHistory = [];
      for (const t of cur.turns) {
        restoredHistory.push({ role: 'user', parts: [{ text: t.q }] });
        restoredHistory.push({ role: 'model', parts: [{ text: t.a }] });
      }
      const s = calls[mainId] = newSession(EXT_FIRST.d, EXT_FIRST.sys, EXT_FIRST.g, {
        ph, apiExt: '/' + HISTORY_EXT, vc: hs.vc, pace: hs.pace, len: (hs.mem && hs.mem.len) || '',
        callerMem: hs.mem, convId: cur.id, h: restoredHistory, resumedFromHistory: true
      });
      s.t = Date.now();
      cleanupReplyFiles(hs);
      delete histSessions[id];
      return res.send(await tapAny(s, `ממשיכים את השיחה בנושא ${cur.title}`, MENU));
    }
  }

  const active = hs.mem.conversations[hs.idx];
  const promptText = `שיחה ${hs.idx + 1} מתוך ${hs.mem.conversations.length}, מתאריך ${active.updatedAt}, בנושא: ${active.title}. להשמעת השיחה הקש 1, להמשך השיחה הקש 2, למחיקה הקש 3, לשליחה למייל הקש 4, לשיחה הבאה הקש 5, לקודמת הקש 6, ליציאה הקש 0.`;
  hs.n++; hs.p = 'HB' + hs.e + hs.n;
  const clip = await sysClip(hs, promptText, 12000);
  return res.send('read=' + clip + '=' + hs.p + ',no,1,1,9' + TAP_EMPTY);
}

// ============================================================================
// נתיבי HTTP ובדיקה עצמית (/ , /selftest , /history , /yemot)
// ============================================================================
app.get('/', (q, r) => r.send('ok'));

app.get('/selftest', async (req, res) => {
  const deadline = Date.now() + 35000;
  const checks = {};

  await Promise.all([
    // 1. Gemini Text
    (async () => {
      const t0 = Date.now();
      try {
        const r = await textGen({ contents: [{ role: 'user', parts: [{ text: 'ענה במילה אחת: תקין' }] }] }, deadline);
        const txt = ((((r.candidates || [])[0] || {}).content || {}).parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
        checks.gemini_text = { ok: !!txt, models: TEXT_MODELS, latency_ms: Date.now() - t0, sample: txt.slice(0, 30) };
      } catch (e) {
        checks.gemini_text = { ok: false, error: e.message };
      }
    })(),
    // 2. Gemini TTS
    (async () => {
      const t0 = Date.now();
      try {
        const wavBuf = await ttsOne('בדיקה', deadline, { voice: VOICE });
        checks.gemini_tts = { ok: wavBuf.length > 200, models: TTS_LIST, bytes: wavBuf.length, latency_ms: Date.now() - t0 };
      } catch (e) {
        checks.gemini_tts = { ok: false, error: e.message };
      }
    })(),
    // 3. Google Maps Routes v2 + Places (New)
    (async () => {
      const t0 = Date.now();
      try {
        const [places, routes] = await Promise.all([
          queryGooglePlacesIL('תחנה מרכזית ירושלים', 1, deadline),
          computeRoutesV2Call({ address: 'רבי עקיבא 100 בני ברק' }, { address: 'תחנה מרכזית ירושלים' }, 'TRANSIT', nextMorningIsraelIso(), null, deadline)
        ]);
        checks.google_maps_and_places = {
          ok: places.length > 0 && routes.routes.length > 0,
          places_ok: places.length > 0,
          routes_v2_count: routes.routes.length,
          latency_ms: Date.now() - t0
        };
      } catch (e) {
        checks.google_maps_and_places = { ok: false, error: e.message };
      }
    })(),
    // 4. Groq Parallel Search
    (async () => {
      const t0 = Date.now();
      try {
        const g = await singleGroqQuery('מה עיר הבירה של ישראל', deadline);
        checks.groq_search = { ok: !g.error && !!g.result, model: GROQ_MODEL, latency_ms: Date.now() - t0 };
      } catch (e) {
        checks.groq_search = { ok: false, error: e.message };
      }
    })(),
    // 5. Yemot Extensions
    (async () => {
      const t0 = Date.now();
      try {
        const r = await http(YM + 'GetIVR2Dir?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent('ivr2:/' + EXT), {}, 8000, deadline);
        const j = await r.json();
        checks.yemot_api = { ok: j.responseStatus === 'OK', ext_path: '/' + EXT, history_ext: HISTORY_EXT ? '/' + HISTORY_EXT : null, latency_ms: Date.now() - t0 };
      } catch (e) {
        checks.yemot_api = { ok: false, error: e.message };
      }
    })(),
    // 6. Radio Feeds Reachability
    (async () => {
      const feedStatuses = await Promise.all(RADIO_FEEDS.map(async f => {
        try {
          const r = await http(f.u, { headers: { 'User-Agent': CRAWLER_UA } }, 7000, deadline);
          return { name: f.n, ok: r.ok, status: r.status };
        } catch (e) {
          return { name: f.n, ok: false, error: e.message };
        }
      }));
      checks.radio_feeds = { ok: feedStatuses.some(f => f.ok), feeds: feedStatuses };
    })()
  ]);

  checks.config = {
    version: '3.0.0',
    israel_clock: nowIsraelInfo().humanHe,
    image_model: IMAGE_MODEL,
    email_configured: !!(GAS_MAIL_URL && TARGET_EMAIL && !GAS_MAIL_URL.includes('/macros/library/')),
    image_search_configured: !!(SEARCH_KEY && SEARCH_CX),
    ffmpeg_available: !!FFMPEG
  };

  const allOk = Object.entries(checks).filter(([k]) => k !== 'config').every(([, v]) => v.ok);
  res.status(allOk ? 200 : 207).json({ ok: allOk, checks });
});

app.all('/history', handleHistory);

app.all(['/yemot', '/yemot/:e'], async (req, res) => {
  const q = { ...req.query, ...req.body };
  const id = idOf(q);
  const rawExtDigits = String(q.ApiExtension || '').trim().replace(/^\/+|\/+$/g, '');

  // אם המתקשר נכנס משלוחה 9 (HISTORY_EXT) ואין סשן המשך פעיל, הפנה אוטומטית לתפריט ההיסטוריה
  if (HISTORY_EXT && rawExtDigits === HISTORY_EXT && !req.params.e) {
    const existing = calls[id];
    if (!existing || !existing.resumedFromHistory) {
      return handleHistory(req, res);
    }
  }

  res.type('text/plain');
  const T0 = Date.now();
  const ext = EXTS[String(req.params.e || '')] || EXT_FIRST;
  const apiExt = normApiExt(q);
  const targetDir = req.params.e ? ext.d : (apiExt !== null ? apiExt : ext.d);

  try {
    if (q.hangup === 'yes') {
      const old = calls[id];
      if (old) cleanupReplyFiles(old);
      delete calls[id];
      return res.send('noop=bye');
    }

    let s = calls[id];
    if (!s) {
      const ph = phoneOf(q);
      const mem = ph ? await loadCallerMemory(ph) : null;
      s = calls[id] = newSession(targetDir, ext.sys, ext.g, {
        ph,
        apiExt,
        callerMem: mem,
        vc: (mem && mem.vc) || '',
        pace: (mem && mem.pace) || '',
        len: (mem && mem.len) || ''
      });
    }
    s.t = Date.now();
    if (!s.mode) return res.send(await tapAny(s, s.g, MENU_OPEN));
    const out = await turnStep(s, q, id, T0);
    res.send(out);
  } catch (e) {
    console.error(id, 'fatal', e.message);
    if (!res.headersSent) res.send('id_list_message=t-' + sp(ERR));
  }
});

app.use((err, req, res, next) => {
  if (!res.headersSent) res.type('text/plain').send('id_list_message=t-' + sp(ERR));
});

// הכנה מראש ברקע של הודעות הפתיחה, התפריטים והודעות הביניים הנפוצות
async function warmSystemPrompts() {
  if (!TTS_KEYS.length || !TOKEN) return;
  const dirs = [...new Set([EXT_FIRST.d, '/5', ...Object.values(EXTS).map(e => e.d)])];
  for (const d of dirs) {
    const greet = (Object.values(EXTS).find(e => e.d === d) || EXT_FIRST).g;
    const phrases = [
      greet + '. ' + MENU_OPEN,
      MENU,
      'דבר אחרי הצליל',
      'קיבלתי, רגע אחד',
      'עוד רגע',
      'מעבירה אותך לשידור החי',
      KB_START,
      KB_MORE + '. ' + MENU,
      AGAIN + '. ' + MENU,
      ERR + '. ' + MENU,
      ...TOOL_ANNOUNCEMENTS
    ];
    for (const p of phrases) {
      await sysClip({ d }, p, 20000);
      await sleep(250);
    }
  }
}

if (require.main === module) {
  app.listen(process.env.PORT || 3000, () => {
    console.log('kav-ai-agentic v3.0.0 up');
    setTimeout(() => warmSystemPrompts().catch(() => {}), 1500);
  });
}

module.exports = { app, cleanTransitHe, cleanStopName, naturalDurationHe, naturalDistanceHe, parseIsraelTimeInput, buildPolishedRouteV2, finalizeTopRoutes, buildInitialTransitSpeech };
