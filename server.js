const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const execFileP = require('util').promisify(require('child_process').execFile);

const {
  createZipBuffer,
  createRtlDocxBuffer,
  buildRichRtlEmailHtml,
  normalizeSpokenEmailInput,
  spellEmailForHebrewSpeech,
  guessMimeByExt,
  buildSelfExtractingZipHtml
} = require('./fileBuilder');

const {
  CURATED_PODCASTS_AND_RADIO,
  musicStore,
  getMusicCatalog,
  searchSongsLive,
  resolveYoutubeAudioUrl,
  searchPodcastsDirectory,
  fetchShowEpisodes
} = require('./mediaCatalog');

// סגירה מיידית בעת פריסה חדשה ב-Render כדי למנוע תקיעה במצב Deploying
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

const FFMPEG = process.env.FFMPEG_PATH || (() => { try { return require('ffmpeg-static'); } catch (e) { return null; } })();
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '2mb' }));

// ============================================================================
// מפתחות, מודלים והגדרות מערכת (גרסה 4.0.0)
// ============================================================================
const keyList = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const uniqueList = arr => [...new Set(arr.filter(Boolean))];

const KEYS = keyList(process.env.GEMINI_API_KEYS);
// איחוד אוטומטי של מפתחות ה-TTS ומפתחות הטקסט למניעת חנק מכסה (סעיף 2)
const TTS_KEYS = uniqueList([...keyList(process.env.GEMINI_TTS_KEYS), ...KEYS]);
const GROQ_KEYS = keyList(process.env.GROQ_API_KEYS);
const MAPS_KEY = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
const SEARCH_KEY = String(process.env.GOOGLE_SEARCH_KEY || MAPS_KEY || KEYS[0] || '').trim();
const SEARCH_CX = String(process.env.GOOGLE_SEARCH_CX || '').trim();
const JAMENDO_CLIENT_ID = String(process.env.JAMENDO_CLIENT_ID || '').trim();

const GROQ_BASE = process.env.GROQ_BASE || 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_SEARCH_MODELS = uniqueList([
  ...keyList(process.env.GROQ_SEARCH_MODEL || 'openai/gpt-oss-120b,openai/gpt-oss-20b'),
  'openai/gpt-oss-20b'
]);
const GROQ_REASONING_MODELS = uniqueList(
  keyList(process.env.GROQ_REASONING_MODELS || 'qwen/qwen3.8-27b,openai/gpt-oss-120b')
);
const GROQ_STAGGER_MS = Math.max(25, parseInt(process.env.GROQ_STAGGER_MS, 10) || 40);

const TEXT_MODEL = String(process.env.TEXT_MODEL || '').trim() || 'gemini-3.6-flash';
const TEXT_FALLBACK_LIST = keyList(process.env.TEXT_MODEL_FALLBACK || 'gemini-3.5-flash-lite,gemini-3.1-flash-lite')
  .filter(m => m !== 'none' && m !== TEXT_MODEL);
const TEXT_MODELS = uniqueList([TEXT_MODEL, ...TEXT_FALLBACK_LIST]);

const IMAGE_MODEL = String(process.env.IMAGE_MODEL || '').trim() || 'gemini-3.1-flash-lite-image';
const DEFAULT_TTS_MODELS = 'gemini-3.8-flash-tts,gemini-3.8-flash-lite-tts,gemini-3.1-flash-tts-preview,gemini-2.5-flash-preview-tts,gemini-2.5-pro-preview-tts';
const TTS_LIST = uniqueList([
  ...keyList(process.env.TTS_MODEL || DEFAULT_TTS_MODELS).map(m => {
    if (m === 'gemini-3.1-flash-tts') return 'gemini-3.1-flash-tts-preview';
    if (m === 'gemini-2.5-flash-tts') return 'gemini-2.5-flash-preview-tts';
    return m;
  }),
  'gemini-3.8-flash-tts',
  'gemini-3.8-flash-lite-tts',
  'gemini-3.1-flash-tts-preview',
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-pro-preview-tts'
]);

const VOICE = process.env.VOICE_FEMALE || process.env.VOICE || 'Kore';
const VOICE_BY = { male: process.env.VOICE_MALE || 'Charon', female: VOICE };

const EXT = (process.env.EXT_PATH || '1').replace(/^\/+|\/+$/g, '') || '1';
const CHAT_EXT = (process.env.CHAT_EXT || '5').replace(/^\/+|\/+$/g, '') || '5';
const BOOKMARKS_EXT = (process.env.BOOKMARKS_EXT || '6').replace(/^\/+|\/+$/g, '') || '6';
const LIVE_STREAM_EXT = String(process.env.LIVE_STREAM_EXT || '7').replace(/^\/+|\/+$/g, '');
const MEDIA_PLAYER_EXT = (process.env.MEDIA_PLAYER_EXT || '8').replace(/^\/+|\/+$/g, '') || '8';
const HISTORY_EXT = String(process.env.HISTORY_EXT || '9').replace(/^\/+|\/+$/g, '');

const TOKEN = process.env.YEMOT_TOKEN ||
  (process.env.YEMOT_API_USERNAME && process.env.YEMOT_API_PASSWORD
    ? process.env.YEMOT_API_USERNAME + ':' + process.env.YEMOT_API_PASSWORD
    : '');

const YM = process.env.YEMOT_BASE || 'https://www.call2all.co.il/ym/api/';
const GBASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta/models/';

// סעיף 1 + סעיף 7: הקלטה והקלדה ללא הגבלה קצרה + תקציב זמן נדיב לשרשור רב-שלבי
const BUDGET = Number(process.env.TURN_BUDGET_MS) || 150000;
const REC_MAX = String(Math.max(60, parseInt(process.env.REC_MAX, 10) || 300)); // ברירת מחדל: 300 שניות (5 דקות!)
const REC_SILENCE = String(Math.min(5, Math.max(2, parseInt(process.env.REC_SILENCE_SEC, 10) || 3))); // 3 שניות שקט כדי לא לקטוע מחשבה
const KB_WAIT = Math.min(120, Math.max(10, parseInt(process.env.KBD_WAIT, 10) || 45)); // 45 שניות להקלדה נוחה
const WAIT_SEC = Math.min(20, Math.max(3, parseInt(process.env.INPUT_WAIT_SEC, 10) || 8));
const CRAWLER_UA = 'Mozilla/5.0 (compatible; Google-Agent; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent)';

// ============================================================================
// שעון ישראל (Asia/Jerusalem) ונרמול זמנים
// ============================================================================
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
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
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

  const relMatch = /^\+?\s*(\d{1,4})\s*(?:m|min|mins|minutes|דקות)$/i.exec(s);
  if (relMatch) return new Date(Date.now() + Number(relMatch[1]) * 60000).toISOString();

  if (/^\d{10,13}$/.test(s)) {
    const ms = s.length === 10 ? Number(s) * 1000 : Number(s);
    return ms > Date.now() - 120000 ? new Date(ms).toISOString() : null;
  }

  const hmMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (hmMatch) {
    const nowInfo = nowIsraelInfo();
    const hh = String(Math.min(23, Number(hmMatch[1]))).padStart(2, '0');
    const mm = String(Math.min(59, Number(hmMatch[2]))).padStart(2, '0');
    let candidate = new Date(`${nowInfo.parts.year}-${nowInfo.parts.month}-${nowInfo.parts.day}T${hh}:${mm}:00${nowInfo.offsetStr}`);
    if (candidate.getTime() < Date.now() - 300000) candidate = new Date(candidate.getTime() + 86400000);
    return candidate.toISOString();
  }

  const noTzMatch = /^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2}(?::\d{2})?)$/.exec(s);
  if (noTzMatch) {
    const timePart = noTzMatch[2].length === 5 ? noTzMatch[2] + ':00' : noTzMatch[2];
    const approx = new Date(`${noTzMatch[1]}T12:00:00Z`);
    const offsetStr = formatOffset(getIsraelOffsetMinutes(Number.isNaN(approx.getTime()) ? new Date() : approx));
    const parsed = new Date(`${noTzMatch[1]}T${timePart}${offsetStr}`);
    if (!Number.isNaN(parsed.getTime())) return parsed.getTime() < Date.now() - 300000 ? null : parsed.toISOString();
  }

  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(s)) {
    const parsed = new Date(s);
    if (!Number.isNaN(parsed.getTime())) return parsed.getTime() < Date.now() - 300000 ? null : parsed.toISOString();
  }
  return null;
}

function nextMorningIsraelIso() {
  const info = nowIsraelInfo();
  let target = new Date(`${info.parts.year}-${info.parts.month}-${info.parts.day}T07:00:00${info.offsetStr}`);
  if (Number(info.parts.hour) >= 7) target = new Date(target.getTime() + 86400000);
  return target.toISOString();
}

// ============================================================================
// שליחת מיילים עשירים ב-HTML RTL + אישור קולי לכתובת מייל מותאמת (סעיפים 10, 11)
// ============================================================================
const TARGET_EMAIL = String(process.env.TARGET_EMAIL || '').trim();
const GAS_MAIL_URL = String(process.env.GAS_MAIL_URL || '').trim();
const GAS_MAIL_SECRET = String(process.env.GAS_MAIL_SECRET || 'kav-ai-secret-2026').trim();

async function sendViaGasEmail({ to, subject, body, htmlBody, badgeText, files, attachHtmlCopy }, deadline) {
  const finalTo = String(to || TARGET_EMAIL || '').trim();
  if (!GAS_MAIL_URL || !finalTo) {
    throw new Error('חסרה הגדרת GAS_MAIL_URL או כתובת מייל יעד');
  }
  if (GAS_MAIL_URL.includes('/macros/library/')) {
    throw new Error('כתובת GAS_MAIL_URL היא כתובת ספרייה ולא כתובת Web App (/macros/s/.../exec)');
  }

  const attachList = Array.isArray(files) ? [...files] : [];
  const fileNames = attachList.map(f => f.filename).filter(Boolean);
  const richHtml = htmlBody || buildRichRtlEmailHtml({
    subject,
    bodyText: body || '',
    badgeText: badgeText || 'קו AI הסוכנותי • תהילה גרסה 4.0',
    attachedFilesList: fileNames
  });

  // אם מתבקש עותק HTML מעוצב (למקרה שסקריפט ישן ב-GAS שולח טקסט רגיל בלבד), נצרף גם קובץ HTML מעוצב ונוח לפתיחה
  if (attachHtmlCopy) {
    attachList.push({
      filename: 'סיכום_מעוצב_RTL.html',
      base64: Buffer.from(richHtml, 'utf8').toString('base64'),
      mimeType: 'text/html'
    });
  }

  const r = await http(GAS_MAIL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': CRAWLER_UA },
    redirect: 'follow',
    body: JSON.stringify({
      token: GAS_MAIL_SECRET,
      to: finalTo,
      subject,
      body: body || '',
      htmlBody: richHtml,
      html: richHtml,
      files: attachList
    })
  }, 35000, deadline);

  const txt = await r.text();
  let j = {};
  try { j = JSON.parse(txt); } catch (e) {}
  if (!r.ok || j.ok === false) {
    // אם ג'ימייל חסם קובץ .js או .zip עם קוד, נעטוף אוטומטית בדף HTML להורדה בלחיצה אחת ונשלח מיד!
    const hasBlockedExt = attachList.some(f => /\.(js|gs|sh|bat|cmd|zip)$/i.test(f.filename || ''));
    if (hasBlockedExt) {
      const safeFiles = attachList.map(f => {
        if (/\.zip$/i.test(f.filename || '')) {
          const htmlWrapper = buildSelfExtractingZipHtml({
            zipFilename: f.filename,
            zipBuffer: Buffer.from(f.base64, 'base64'),
            title: subject || f.filename
          });
          return {
            filename: f.filename.replace(/\.zip$/i, '') + '_שנה_סיומת_ל_html.txt',
            base64: Buffer.from(htmlWrapper, 'utf8').toString('base64'),
            mimeType: 'text/plain'
          };
        }
        if (/\.(js|gs|sh|bat|cmd)$/i.test(f.filename || '')) {
          return { ...f, filename: f.filename + '.txt', mimeType: 'text/plain' };
        }
        return f;
      });
      const rRetry = await http(GAS_MAIL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': CRAWLER_UA },
        redirect: 'follow',
        body: JSON.stringify({ token: GAS_MAIL_SECRET, to: finalTo, subject, body: body || '', htmlBody: richHtml, html: richHtml, files: safeFiles })
      }, 35000, deadline);
      const jRetry = await rRetry.json().catch(() => ({}));
      if (rRetry.ok && jRetry.ok !== false) {
        return { sent_to: finalTo, attachments_count: safeFiles.length, wrapped_for_gmail_security: true };
      }
    }
    throw new Error('שגיאת שליחת מייל: ' + (j.error || txt.slice(0, 120)));
  }
  return { sent_to: finalTo, attachments_count: attachList.length };
}

// שער אימות כתובת מייל מותאמת אישית (סעיף 11)
async function dispatchOrRequireEmailConfirmation(s, requestedRecipient, mailPayload, deadline) {
  const cleanCustom = normalizeSpokenEmailInput(requestedRecipient);
  const defaultClean = String(TARGET_EMAIL || '').trim().toLowerCase();

  // אם לא הוגדרה כתובת אחרת או שזו כתובת ברירת המחדל / כתובת שכבר אושרה בשיחה זו -> שלח מיד!
  if (!cleanCustom || cleanCustom === defaultClean || (s && s.confirmedEmails && s.confirmedEmails.has(cleanCustom))) {
    const res = await sendViaGasEmail({ ...mailPayload, to: cleanCustom || TARGET_EMAIL }, deadline);
    return { status: 'sent', ...res };
  }

  // שמירה להמתנה לאישור המתקשר עם הקראת הכתובת המאוייתת!
  const spelled = spellEmailForHebrewSpeech(cleanCustom);
  if (s) {
    s.pendingEmail = {
      to: cleanCustom,
      spelled,
      payload: mailPayload
    };
    s.awaitingEmailConfirm = true;
  }
  return {
    status: 'awaiting_user_email_confirmation',
    detected_email: cleanCustom,
    spelled_for_speech: spelled,
    instruction_to_model: `חובה להקריא למתקשר בבירור את כתובת המייל שזוהתה: "${spelled}" ולבקש ממנו: "לאישור ושליחת המייל הקש 1, לתיקון כתובת המייל הקש 2, או לביטול הקש 0." המייל והקבצים שמורים ומוכנים לשליחה מיד לאחר האישור.`
  };
}

// --- הגדרות רדיו RSS ---
function parseRadioFeeds() {
  let parsed = [];
  try {
    const rawFeeds = String(process.env.RADIO_FEEDS || '').trim().replace(/^'+|'+$/g, '');
    if (rawFeeds) parsed = JSON.parse(rawFeeds);
  } catch (e) { parsed = []; }
  return (Array.isArray(parsed) ? parsed : [])
    .map(f => {
      if (!f || !f.n) return null;
      let u = String(f.u || '').trim();
      const mdMatch = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(u);
      if (mdMatch) u = mdMatch[2];
      if (u.includes('2ee97a4e-8795-4260-9648-accf00a38c6a')) u = 'https://www.spreaker.com/show/6095076/episodes/feed';
      return /^https?:\/\//i.test(u) ? { n: String(f.n).trim(), u } : null;
    })
    .filter(Boolean);
}
const RADIO_FEEDS = parseRadioFeeds();

// --- פונקציות עזר כלליות ---
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isBudget = e => !!(e && e.budget);
const rot = { text: 0, tts: 0, groq: 0 };
const RETRY_STATUS = [429, 500, 502, 503, 504];

// הפרדה מלאה לפי מתקשר + מזהה שיחה (סעיף 13)
const calls = {};
const activeCallsByPhone = {};
const bgTasksByPhone = {};

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#0*34;/gi, '"')
    .replace(/&apos;|&#0*39;/gi, "'")
    .replace(/&#8211;|&#8212;/g, '-')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return n > 31 && n < 65535 ? String.fromCharCode(n) : ' ';
    });
}

const stripHtml = h => decodeHtmlEntities(
  String(h || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, '. ')
).replace(/\s*\.\s*\.\s*/g, '. ').replace(/\s+/g, ' ').trim();

setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(calls)) {
    if (now - calls[key].t > 3600000) {
      cleanupReplyFiles(calls[key]);
      if (calls[key].ph && activeCallsByPhone[calls[key].ph] === key) {
        delete activeCallsByPhone[calls[key].ph];
      }
      delete calls[key];
    }
  }
}, 600000).unref();

async function http(url, opt, ms, deadline) {
  const left = deadline ? deadline - Date.now() : ms;
  if (left < 700) { const e = new Error('turn budget exhausted'); e.budget = true; throw e; }
  return fetch(url, { ...opt, signal: AbortSignal.timeout(Math.min(ms, left)) });
}

function pushStatus(s, text) {
  if (!s || !text || s.cancelled || s.detachedToBg) return;
  const clean = String(text).replace(/[*#_\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!clean) return;
  s.statusQueue = s.statusQueue || [];
  if (s.statusQueue[s.statusQueue.length - 1] !== clean) {
    s.statusQueue.push(clean);
  }
  if (s.onStatus) { const fn = s.onStatus; s.onStatus = null; fn(); }
}

// ============================================================================
// זיכרון מתקשר מופרד, היסטוריית שיחות, מעקב פרקים, סימניות ומשימות רקע (סעיפים 8,9,13,14,15)
// ============================================================================
const callerCache = {};

function memFilePath(phone) {
  const p = String(phone || '').replace(/\D/g, '');
  if (!p || !HISTORY_EXT || !TOKEN) return '';
  return `ivr2:/${HISTORY_EXT}/mem_${p}.ini`;
}

function normalizeCallerMemObj(p, raw) {
  const parsed = raw || {};
  return {
    phone: p,
    vc: parsed.vc || '',
    pace: parsed.pace || '',
    len: parsed.len || '',
    notes: Array.isArray(parsed.notes) ? parsed.notes.slice(0, 20) : [],
    conversations: Array.isArray(parsed.conversations) ? parsed.conversations.slice(0, 20) : [],
    episodeProgress: (parsed.episodeProgress && typeof parsed.episodeProgress === 'object') ? parsed.episodeProgress : {},
    bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks.slice(0, 30) : [],
    completedBgTasks: Array.isArray(parsed.completedBgTasks) ? parsed.completedBgTasks.slice(0, 10) : [],
    lastPlayingMedia: parsed.lastPlayingMedia || null
  };
}

async function loadCallerMemory(phone) {
  const p = String(phone || '').replace(/\D/g, '');
  if (!p) return null;
  if (callerCache[p] && Date.now() - callerCache[p].loadedAt < 600000) {
    return callerCache[p].data;
  }
  const what = memFilePath(p);
  const empty = normalizeCallerMemObj(p, {});
  if (!what) return empty;
  try {
    const u = YM + 'GetTextFile?token=' + encodeURIComponent(TOKEN) + '&what=' + encodeURIComponent(what);
    const r = await fetch(u, { headers: { 'User-Agent': CRAWLER_UA }, signal: AbortSignal.timeout(5000) });
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus === 'OK' && j.contents) {
      const data = normalizeCallerMemObj(p, JSON.parse(j.contents));
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
  const normalized = normalizeCallerMemObj(p, data);
  callerCache[p] = { loadedAt: Date.now(), data: normalized };
  try {
    const body = new URLSearchParams({ token: TOKEN, what, contents: JSON.stringify(normalized) }).toString();
    const r = await fetch(YM + 'UploadTextFile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CRAWLER_UA },
      body,
      signal: AbortSignal.timeout(8000)
    });
    const j = await r.json().catch(() => ({}));
    return j.responseStatus === 'OK';
  } catch (e) {
    console.error('saveCallerMemoryBg error:', e.message);
    return false;
  }
}

function buildSmartConversationTitle(questionText, answerText) {
  let q = String(questionText || '').replace(/^הבקשה הוקלדה במקשי הטלפון:\s*/, '').replace(/[*#_\[\]]/g, '').replace(/\s+/g, ' ').trim();
  if (!q || q === '[בקשה קולית]') {
    q = String(answerText || 'שיחה עם תהילה').split(/[.!?]/)[0].trim();
  }
  const words = q.split(' ').slice(0, 8).join(' ');
  return words.slice(0, 65) || 'שיחה שמורה';
}

async function recordTurnInCallerHistory(s, questionText, answerText) {
  if (!s || !s.ph || !HISTORY_EXT) return;
  const mem = await loadCallerMemory(s.ph);
  if (!mem) return;
  mem.vc = s.vc || '';
  mem.pace = s.pace || '';
  mem.len = s.len || '';

  const stamp = nowIsraelInfo().shortStamp;
  const cleanQ = String(questionText || 'שאלה קולית').replace(/\s+/g, ' ').trim().slice(0, 350);
  const cleanA = String(answerText || '').replace(/\s+/g, ' ').trim().slice(0, 2500);

  if (!s.convId) s.convId = 'c_' + Date.now().toString(36);
  let conv = mem.conversations.find(c => c.id === s.convId);
  if (!conv) {
    conv = {
      id: s.convId,
      title: buildSmartConversationTitle(cleanQ, cleanA),
      updatedAt: stamp,
      turns: []
    };
    mem.conversations.unshift(conv);
  } else {
    conv.updatedAt = stamp;
    mem.conversations = [conv, ...mem.conversations.filter(c => c.id !== s.convId)];
  }
  conv.turns.push({ q: cleanQ, a: cleanA });
  if (conv.turns.length > 14) conv.turns = conv.turns.slice(-14);
  if (mem.conversations.length > 18) mem.conversations = mem.conversations.slice(0, 18);

  s.callerMem = mem;
  await saveCallerMemoryBg(s.ph, mem);
}

// שליחת צנתוק (RunTzintuk) למתקשר בסיום משימת רקע (סעיף 8)
async function sendYemotTzintuk(phone) {
  const p = String(phone || '').replace(/\D/g, '');
  if (!p || !TOKEN) return false;
  try {
    // ניסיון שליחת צנתוק ישיר למספר המתקשר דרך RunTzintuk של ימות המשיח
    for (const phonesParam of [p, `tzl:${p}`]) {
      const u = `${YM}RunTzintuk?token=${encodeURIComponent(TOKEN)}&phones=${encodeURIComponent(phonesParam)}`;
      const r = await fetch(u, { headers: { 'User-Agent': CRAWLER_UA }, signal: AbortSignal.timeout(10000) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && (j.responseStatus === 'OK' || j.callsCount > 0)) {
        return true;
      }
    }
  } catch (e) {
    console.error('Tzintuk call note:', e.message);
  }
  return false;
}

// ============================================================================
// תמלול איכותי ומדויק להקלטות ארוכות באמצעות Groq Whisper-Large-V3-Turbo (סעיף 1)
// ============================================================================
async function transcribeHebrewWhisper(wavBuf, deadline) {
  if (!GROQ_KEYS.length || !wavBuf || wavBuf.length < 1500) return '';
  const key = GROQ_KEYS[rot.groq++ % GROQ_KEYS.length];
  try {
    const f = new FormData();
    f.append('file', new Blob([wavBuf], { type: 'audio/wav' }), 'recording.wav');
    f.append('model', 'whisper-large-v3-turbo');
    f.append('language', 'he');
    f.append('response_format', 'json');
    const r = await http(GROQ_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'User-Agent': CRAWLER_UA },
      body: f
    }, 18000, deadline);
    if (!r.ok) return '';
    const j = await r.json();
    return String(j.text || '').replace(/\s+/g, ' ').trim();
  } catch (e) {
    return '';
  }
}

// ============================================================================
// הנחיית המערכת הסוכנותית הרב-שלבית — תהילה גרסה 4.0 (סעיפים 4, 6, 7, 8, 12, 16)
// ============================================================================
const VOICE_CTL = ' אם המשתמש מבקש לשנות את הקול, את קצב הדיבור או את אורך התשובות, התחילי בתג מתאים ואחריו אשרי בקצרה: [[VOICE:male]] לקול גברי, [[VOICE:female]] לקול נשי, [[VOICE:default]] לקול רגיל, [[PACE:slow]] לאט, [[PACE:fast]] מהר, [[PACE:normal]] רגיל, [[LEN:short]] לתשובות קצרות, [[LEN:long]] לתשובות מפורטות.';
const TRANSCRIBE_HINT = ' אם השאלה הגיעה כהקלטה קולית ולא סופק תמלול מראש, התחילי בתג [[Q:תמלול מדויק של השאלה]] ואחריו התשובה.';
const MAXW = Math.min(3500, Math.max(200, parseInt(process.env.MAX_WORDS, 10) || 2500));
const EXTRA = String(process.env.EXTRA_INSTRUCTION || '').replace(/\s+/g, ' ').trim().slice(0, 2000);

const AGENTIC_RULES = `
את סוכנת בינה מלאכותית קולית רב-שלבית חכמה וסקסית דוברת עברית בשם תהילה, יעילה, אדיבה, מהירה ומדויקת בטלפון.
עקרונות פעולה כסוכנת רב-שלבית ברמה הגבוהה ביותר (Multi-Step Autonomous Agent):
1. הודעות ביניים חיות וספציפיות (action_announcement): לפני כל הפעלת כלי, חובה לכתוב בשדה action_announcement משפט קצר, ספציפי וחי בעברית המתאר בדיוק את מה שאת מבצעת כרגע עבור המתקשר — לעולם לא משפט כללי או מכני! דוגמאות:
   - "מחפשת לך נסיעה מרבי עקיבא בבני ברק לכותל המערבי בגוגל מפות"
   - "יוצרת לך תמונה של בית המקדש בשקיעה ושולחת למייל"
   - "מפעילה את השמעת הפרק החדש של עושים טכנולוגיה"
   - "מתייעצת עם מודל החשיבה העמוקה לכתיבת הקוד המלא"
   - "אורזת את קובצי התוכנה ומסמך הוורד ושולחת למייל"
2. שרשור פעולות מרובות ברצף (עד 12 שלבים בתור): את מסוגלת לבצע סדרה ארוכה של פעולות בזו אחר זו באותו תור! למשל: שלב 1 חיפוש מידע וקישורים ב-web_search_parallel -> שלב 2 שאיבת תוכן מלא מכתובות URL שחזרו באמצעות fetch_webpage -> שלב 3 שליחה למודל חשיבה עמוקה deep_reasoning_expert לכתיבת מסמך/קוד מקיף -> שלב 4 יצירת תמונה ב-generate_image -> שלב 5 סגירת התוצרים לקובצי Word או קוד או ZIP ושליחתם במייל HTML מהודר דרך create_and_email_files.
3. ביצוע ברקע עם צנתוק (start_background_task): כאשר המשתמש מבקש מראש משימה כבדה מאוד בצירוף בקשה להמשיך בשיחה או לקבל צנתוק בסיום (או מאשר מעבר לרקע), הפעילי start_background_task — המשימה תרוץ ברקע ותשלח למתקשר צנתוק אוטומטי בסיומה!
4. תחבורה ציבורית (google_maps_route): חובה להשתמש אך ורק ב-google_maps_route לכל מסלול הגעה בישראל.
   - כלל ברזל בניסוח תח"צ: בלי שום הקדמות או הסברים מה את הולכת לעשות! פתחי מיד במילים: "המסלול המהיר ביותר:" והקריאי מיד את recommended_spoken_response בדיוק כפי שחזר מהכלי (שכולל את המסלול המהיר ביותר ברצף חד + שורה קצרה לחלופות 2 ו-3 + מקשי ההרחבה כמו 5 להליכה ו-4 למייל).
5. פרויקטים מורכבים, קוד, מסמכי Word ומיילים מעוצבים:
   - לפרויקטים מורכבים, אלגוריתמים, כתיבת תוכנות שלמות או ניתוח עומק: העבירי תחילה ל-deep_reasoning_expert (שמריץ מודלי Reasoning כמו Qwen 3.8 ו-GPT-OSS High Reasoning ב-Groq).
   - ליצירת קובצי קוד, פרויקטי תוכנה מרובי-קבצים (ב-ZIP), או מסמכי Word (.docx) בעברית RTL ושליחתם במייל HTML מעוצב: השתמשי ב-create_and_email_files.
   - לשליחת תשובה או סיכום כתוב ב-HTML מעוצב מימין לשמאל למייל: השתמשי ב-send_email.
   - שליחה לכל כתובת מייל מבוקשת: אם המשתמש ביקש לשלוח לכתובת מייל ספציפית, העבירי אותה בשדה recipient_email — המערכת תבצע אוטומטית הקראה ואישור של הכתובת מול המתקשר לפני השליחה!
6. פודקאסטים, רדיו ושירים להורדה/השמעה:
   - רק כאשר המשתמש מבקש פודקאסט, שיעור, חדשות או שירים/מוזיקה — היכנסי תחילה למאגר הצדדי באמצעות browse_media_catalog כדי לראות מה קיים, אילו שירים חדשים נשאבו, ואיזה פרק המתקשר אוחז!
   - להפעלת ההשמעה בנגן המתקדם (שתומך בהרצה קדימה/אחורה 1 ו-3, שמירה בסימניות ב-5 וחזרה לשיחה ב-8): הפעילי play_media_item.
7. סגנון דיבור בטלפון: דברי בעברית טבעית, חיה, זורמת ונעימה להאזנה, ללא כוכביות, סולמיות או הקראת כתובות URL גולמיות, עד ${MAXW} מילים.
`.replace(/\s+/g, ' ').trim();

const buildBaseSys = (mode, extra) => AGENTIC_RULES + ' ' +
  (EXTRA ? 'הנחיית מנהל המערכת: ' + EXTRA + ' ' : '') +
  (extra ? 'הנחיית שלוחה: ' + extra + ' ' : '') + VOICE_CTL + TRANSCRIBE_HINT;

function buildDynamicTurnSys(s) {
  const parts = [s.sys];
  const clock = nowIsraelInfo();
  parts.push(`הזמן הנוכחי בישראל כעת: ${clock.humanHe} (ISO: ${clock.isoLocal}).`);

  if (s.callerMem) {
    if (Array.isArray(s.callerMem.notes) && s.callerMem.notes.length) {
      parts.push(`פרטים קבועים של המתקשר (${s.ph || 'מזוהה'}): ${s.callerMem.notes.join(' | ')}.`);
    }
    const epEntries = Object.entries(s.callerMem.episodeProgress || {});
    if (epEntries.length) {
      const epSummary = epEntries.slice(0, 6).map(([k, v]) => `${v.showName || k}: פרק אחרון "${v.lastEpisodeTitle}" (#${v.lastEpisodeIndex || 1})`).join(' | ');
      parts.push(`מעקב פרקים אחרונים שהמתקשר שמע: ${epSummary}.`);
    }
  }
  if (s.interruptedLast) {
    parts.push(`הערת הקשר: המתקשר קטע את התשובה הקודמת באמצע ההשמעה.`);
  }

  const wm = s.workingMemory || {};
  const wmNotes = [];
  if (wm.lastRoutes && wm.lastRoutes.length) {
    wmNotes.push('מסלולי תח"צ אחרונים: ' + wm.lastRoutes.map(r => `חלופה ${r.option} (${r.lines}, יציאה ${r.departure}, הגעה ${r.arrival}): ${r.fullText}`).join(' || ').slice(0, 1600));
  }
  if (wm.lastPlaces && wm.lastPlaces.length) {
    wmNotes.push('מקומות אחרונים: ' + JSON.stringify(wm.lastPlaces).slice(0, 800));
  }
  if (wm.lastSearch) {
    wmNotes.push('ממצאי חיפוש וקישורים אחרונים: ' + String(wm.lastSearch).slice(0, 1400));
  }
  if (wm.lastCatalog) {
    wmNotes.push('תוצאות אחרונות ממאגר המדיה/שירים: ' + JSON.stringify(wm.lastCatalog).slice(0, 1400));
  }
  if (wmNotes.length) {
    parts.push('זיכרון עבודה מהשיחה הנוכחית: ' + wmNotes.join(' | '));
  }
  if (s.len === 'short') {
    parts.push('הנחיית אורך פעילה: עני בקצרה ובתמציתיות (2–4 משפטים).');
  }
  return parts.join('\n');
}

// ============================================================================
// תקשורת מול Gemini API + ניתוב חשיבה דינמי (כולל ב-Flash Lite כשצריך! סעיפים 12, 16)
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
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key, 'User-Agent': CRAWLER_UA },
        body: JSON.stringify(body)
      }, opt.ms || 32000, deadline);
      if (r.ok) return await r.json();
      status = r.status;
      err = model + ' ' + r.status + ' ' + (await r.text()).slice(0, 220);
      if (!RETRY_STATUS.includes(r.status)) break;
    } catch (e) {
      if (isBudget(e)) throw e;
      status = 0;
      err = model + ' ' + (e.name === 'TimeoutError' ? 'timeout' : e.message);
    }
    if (i < tries - 1) await sleep(300 * (i + 1));
  }
  const e = new Error(err); e.status = status; throw e;
}

// זיהוי אוטומטי האם השאלה דורשת Reasoning עמוק (אפילו ב-Flash Lite) או תגובה מהירה במיוחד!
function detectDesiredThinkingLevel(contents, stepIndex = 0) {
  if (stepIndex >= 2) return 'medium';
  const lastText = JSON.stringify((contents || []).slice(-2));
  if (/קוד|תוכנה|פרויקט|בנה|כתוב מסמך|תכנן|נתח|השווה|עומק|מורכב|אלגוריתם|חישוב|מחקר מקיף/i.test(lastText)) {
    return 'medium';
  }
  if (/מה השעה|שלום|תודה|מה נשמע|קול גברי|קול נשי|דבר מהר|דבר לאט/i.test(lastText)) {
    return 'minimal';
  }
  return 'low';
}

const thinkUnsupported = {};
const downUntil = {};

async function textGen(body, deadline, desiredThinking = 'low') {
  let lastErr;
  for (let m = 0; m < TEXT_MODELS.length; m++) {
    const model = TEXT_MODELS[m];
    const hasNext = m < TEXT_MODELS.length - 1;
    if (hasNext && (downUntil[model] || 0) > Date.now()) continue;

    const candidateLevels = thinkUnsupported[model] ? [null] : uniqueList([desiredThinking, 'low', 'minimal', null]);
    for (const lvl of candidateLevels) {
      const gc = { maxOutputTokens: 8192 };
      if (lvl) gc.thinkingConfig = { thinkingLevel: lvl };
      try {
        return await gem(model, { ...body, generationConfig: gc }, deadline, 'text', hasNext ? { retries: 0, ms: 30000 } : { ms: 48000 });
      } catch (e) {
        lastErr = e;
        if (e.status === 400 && /think/i.test(e.message)) {
          if (lvl === 'minimal') thinkUnsupported[model] = true;
          continue;
        }
        break;
      }
    }
    if (isBudget(lastErr)) throw lastErr;
    if (!hasNext && !(RETRY_STATUS.includes(lastErr.status) || lastErr.status === 0)) throw lastErr;
    if (hasNext) downUntil[model] = Date.now() + (lastErr.status === 404 ? 3600000 : 60000);
  }
  throw lastErr;
}

// ============================================================================
// מנוע ניסוח תחבורה ציבורית חד, ישיר וללא הקדמות מיותרות (סעיף 4)
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
    if (m === 0) return 'שעה';
    if (m === 30) return 'שעה וחצי';
    if (m === 15) return 'שעה ורבע';
    if (m === 1) return 'שעה ודקה';
    if (m === 2) return 'שעה ושתי דקות';
    return `שעה ו-${m} דקות`;
  }
  if (h === 2) {
    if (m === 0) return 'שעתיים';
    if (m === 30) return 'שעתיים וחצי';
    return `שעתיים ו-${m} דקות`;
  }
  return m ? `${h} שעות ו-${m} דקות` : `${h} שעות`;
}

function naturalDistanceHe(meters) {
  const m = Number(meters) || 0;
  if (m <= 0) return '';
  if (m < 30) return 'מטרים ספורים';
  if (m < 950) return `כ-${Math.max(30, Math.round(m / 10) * 10)} מטר`;
  const km = (m / 1000).toFixed(1).replace(/\.0$/, '');
  return km === '1' ? 'קילומטר אחד' : `כ-${km} קילומטר`;
}

const fmtTimeIL = isoOrMs => {
  if (!isoOrMs) return '';
  try {
    const d = new Date(isoOrMs);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch (e) { return ''; }
};

function cleanAgencyName(raw) {
  const a = cleanTransitHe(raw);
  return a ? a.replace(/^חברת\s+/i, '').replace(/דרך אגד עוטף ירושלים/g, 'דרך אגד').trim() : '';
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
    return { label: `רכבת ישראל${railLine}`.trim(), boardingPhrase: `עולים על רכבת ישראל${railLine}${headsign ? ' לכיוון ' + headsign : ''}` };
  }
  if (vType.includes('LIGHT_RAIL') || vType === 'TRAM' || /רכבת קלה|כפיר|תבל|דנקל/.test(agency)) {
    const lrNum = lineShort ? ` קו ${lineShort}` : '';
    return { label: `הרכבת הקלה${lrNum}`.trim(), boardingPhrase: `עולים על הרכבת הקלה${lrNum}${headsign ? ' לכיוון ' + headsign : ''}` };
  }
  if (vType === 'SUBWAY' || vType === 'FUNICULAR' || vType === 'GONDOLA_LIFT') {
    const vName = cleanTransitHe((tl.vehicle && tl.vehicle.name && tl.vehicle.name.text) || lineShort || lineName || 'הרכבלית');
    return { label: vName, boardingPhrase: `עולים על ${vName}${headsign ? ' לכיוון ' + headsign : ''}` };
  }
  const num = lineShort || lineName || 'אוטובוס';
  return { label: `קו ${num}`, boardingPhrase: `עולים על קו ${num}${agency ? ' של ' + agency : ''}${headsign ? ' לכיוון ' + headsign : ''}` };
}

function buildPolishedRouteV2(route, originLabel, destLabel) {
  const leg = (route.legs || [])[0] || {};
  const totalSec = parseSeconds(route.duration || leg.duration);
  const totalDurHe = naturalDurationHe(totalSec) || cleanTransitHe(route.localizedValues && route.localizedValues.duration && route.localizedValues.duration.text);

  const grouped = [];
  for (const st of (leg.steps || [])) {
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
        grouped.push({ type: 'WALK', distanceMeters: stepDist, durationSec: stepSec, instructions: instr ? [instr] : [] });
      }
    } else if (mode === 'TRANSIT' && st.transitDetails) {
      grouped.push({ type: 'TRANSIT', td: st.transitDetails, stepSec: parseSeconds(st.staticDuration) });
    } else {
      const instr = cleanWalkInstruction(st.navigationInstruction && st.navigationInstruction.instructions);
      grouped.push({ type: 'OTHER', distanceMeters: Number(st.distanceMeters) || 0, durationSec: parseSeconds(st.staticDuration), instr });
    }
  }

  const spokenSteps = [];
  const walkDetails = [];
  const lineLabels = [];
  let firstTransitDepMs = 0, firstTransitDepText = '', lastTransitArrMs = 0, lastTransitArrText = '';
  let initialWalkSec = 0, trailingWalkSec = 0, seenTransit = false;

  for (let i = 0; i < grouped.length; i++) {
    const g = grouped[i], prev = i > 0 ? grouped[i - 1] : null, next = i < grouped.length - 1 ? grouped[i + 1] : null;
    if (g.type === 'WALK') {
      if (!seenTransit) initialWalkSec += g.durationSec;
      const hasLaterTransit = grouped.slice(i + 1).some(x => x.type === 'TRANSIT');
      if (!hasLaterTransit && seenTransit) trailingWalkSec += g.durationSec;

      const walkDur = naturalDurationHe(g.durationSec);
      const walkDist = naturalDistanceHe(g.distanceMeters);
      const nextStop = next && next.type === 'TRANSIT' ? cleanStopName(next.td.stopDetails && next.td.stopDetails.departureStop && next.td.stopDetails.departureStop.name) : '';

      if (g.instructions.length) {
        const ctxTitle = !seenTransit ? `הליכה לתחנת המוצא${nextStop ? ' (' + nextStop + ')' : ''}` : (hasLaterTransit ? `מעבר רגלי ${toStopPhrase(nextStop || 'ההחלפה')}` : `הליכה מהתחנה אל ${cleanTransitHe(destLabel)}`);
        walkDetails.push(`${ctxTitle}: ${g.instructions.join('. ')}.`);
      }

      if (!seenTransit && hasLaterTransit) {
        if (g.distanceMeters >= 60) spokenSteps.push(`הליכה של ${walkDur} ${toStopPhrase(nextStop)}.`);
        else if (nextStop) spokenSteps.push(`ניגשים ${toStopPhrase(nextStop)}.`);
      } else if (seenTransit && hasLaterTransit) {
        const prevArrIso = prev && prev.type === 'TRANSIT' && prev.td.stopDetails && prev.td.stopDetails.arrivalTime;
        const nextDepIso = next && next.type === 'TRANSIT' && next.td.stopDetails && next.td.stopDetails.departureTime;
        let waitPhrase = '';
        if (prevArrIso && nextDepIso) {
          const gapSec = Math.round((new Date(nextDepIso).getTime() - new Date(prevArrIso).getTime()) / 1000) - g.durationSec;
          if (gapSec > 90) waitPhrase = `, המתנה של כ-${naturalDurationHe(gapSec)}`;
          else if (gapSec >= 0 && gapSec <= 90) waitPhrase = `, החלפה צפופה`;
        }
        const prevStop = prev && prev.type === 'TRANSIT' ? cleanStopName(prev.td.stopDetails && prev.td.stopDetails.arrivalStop && prev.td.stopDetails.arrivalStop.name) : '';
        if (g.distanceMeters < 35 && prevStop && prevStop === nextStop) {
          if (waitPhrase) spokenSteps.push(`באותה תחנה${waitPhrase}.`);
        } else {
          spokenSteps.push(`מעבר של ${walkDur || 'דקה אחת'} ${toStopPhrase(nextStop)}${waitPhrase}.`);
        }
      } else if (seenTransit && !hasLaterTransit) {
        if (g.distanceMeters >= 40) spokenSteps.push(`ומשם ${walkDur} הליכה ליעד.`);
      } else {
        spokenSteps.push(`הליכה של ${walkDur} (${walkDist}) עד היעד.`);
      }
    } else if (g.type === 'TRANSIT') {
      seenTransit = true;
      const td = g.td, sd = td.stopDetails || {}, lv = td.localizedValues || {};
      const depStop = cleanStopName(sd.departureStop && sd.departureStop.name);
      const arrStop = cleanStopName(sd.arrivalStop && sd.arrivalStop.name);
      const depTime = (lv.departureTime && lv.departureTime.time && lv.departureTime.time.text) || fmtTimeIL(sd.departureTime);
      const arrTime = (lv.arrivalTime && lv.arrivalTime.time && lv.arrivalTime.time.text) || fmtTimeIL(sd.arrivalTime);
      const stopsCount = td.stopCount || 0;

      if (!firstTransitDepMs && sd.departureTime) { firstTransitDepMs = new Date(sd.departureTime).getTime(); firstTransitDepText = depTime; }
      if (sd.arrivalTime) { lastTransitArrMs = new Date(sd.arrivalTime).getTime(); lastTransitArrText = arrTime; }

      if (prev && prev.type === 'TRANSIT' && prev.td.stopDetails && prev.td.stopDetails.arrivalTime && sd.departureTime) {
        const gapSec = Math.round((new Date(sd.departureTime).getTime() - new Date(prev.td.stopDetails.arrivalTime).getTime()) / 1000);
        if (gapSec > 90) spokenSteps.push(`המתנה של ${naturalDurationHe(gapSec)}.`);
      }

      const info = describeTransitBoarding(td);
      lineLabels.push(info.label);
      const prevWasWalkToStop = !!(prev && prev.type === 'WALK' && depStop);
      const fromPart = (!prevWasWalkToStop && depStop) ? ` ${atStopPhrase(depStop)}` : '';
      const stopsPart = stopsCount === 1 ? 'תחנה אחת' : (stopsCount > 1 ? `${stopsCount} תחנות` : '');
      spokenSteps.push(`${depTime ? 'ב-' + depTime + ' ' : ''}${info.boardingPhrase}${fromPart},${stopsPart ? ' נוסעים ' + stopsPart : ''} ויורדים${arrTime ? ' ב-' + arrTime : ''}${arrStop ? ' ' + atStopPhrase(arrStop) : ''}.`.replace(/\s+/g, ' '));
    } else if (g.instr) {
      spokenSteps.push(`${g.instr}.`);
    }
  }

  const finalArrivalMs = lastTransitArrMs ? (lastTransitArrMs + trailingWalkSec * 1000) : (totalSec ? Date.now() + totalSec * 1000 : 0);
  const finalArrivalText = finalArrivalMs ? fmtTimeIL(finalArrivalMs) : lastTransitArrText;
  const startLeaveMs = firstTransitDepMs ? (firstTransitDepMs - initialWalkSec * 1000) : Date.now();
  const depDisplay = firstTransitDepText || fmtTimeIL(startLeaveMs);
  const linesSummary = lineLabels.length ? lineLabels.join(' ואז ') : 'הליכה ישירה';

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
      ? `הרחבת מסלול והוראות הליכה: זמן כולל ${totalDurHe}, הגעה סופית ליעד ב-${finalArrivalText || '-'}. ${walkDetails.join(' ')}`
      : `זמן כולל ${totalDurHe}, הגעה ב-${finalArrivalText || '-'}. אין מקטעי הליכה מורכבים במסלול זה.`,
    dedupeKey: `${lineLabels.join('>')}@${depDisplay}`
  };
}

function finalizeTopRoutes(builtRoutes, originClean, destClean) {
  const seen = new Set();
  const unique = [];
  for (const r of builtRoutes) {
    if (seen.has(r.dedupeKey)) continue;
    seen.add(r.dedupeKey);
    unique.push(r);
  }
  unique.sort((a, b) => (a.sortArrivalMs - b.sortArrivalMs) || (a.totalSec - b.totalSec));
  return unique.slice(0, 3).map((r, idx) => {
    const fullText = `${r.spokenBody} סך הכול ${r.totalDurHe}${r.finalArrivalText ? ', הגעה ב-' + r.finalArrivalText : ''}.`.replace(/\s+/g, ' ').trim();
    const shortSummary = `חלופה ${idx + 1}: ${r.depDisplay ? 'ב-' + r.depDisplay + ' עם ' : ''}${r.linesSummary}, ${r.totalDurHe}${r.finalArrivalText ? ', הגעה ב-' + r.finalArrivalText : ''}.`;
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

// סעיף 4: פתיחה חדה וישירה ב-"המסלול המהיר ביותר:" ללא הקדמות מיותרות!
function buildInitialTransitSpeech(routes, originClean, destClean, notePrefix) {
  if (!routes.length) return '';
  const parts = [];
  if (notePrefix) parts.push(notePrefix);
  parts.push(`המסלול המהיר ביותר: ${routes[0].fullText}`);
  for (let i = 1; i < routes.length; i++) {
    parts.push(routes[i].shortSummary);
  }
  const tail = routes.length > 1
    ? `לפירוט חלופה 2${routes.length > 2 ? ' או 3' : ''} הקש 2${routes.length > 2 ? ' או 3' : ''}, לשליחה למייל 4, להרחבה והליכה 5, לאוטובוס הבא 8, לשאלה חדשה 0.`
    : `לשליחה למייל הקש 4, להרחבה והליכה 5, לאוטובוס הבא 8, לשאלה חדשה 0.`;
  parts.push(tail);
  return parts.join(' ');
}

function buildTransitEmailBody(routes, originClean, destClean) {
  const lines = [
    `# מסלולי תחבורה ציבורית: מ-${originClean} אל ${destClean}`,
    `הופק ב-${nowIsraelInfo().humanHe}`,
    '---'
  ];
  for (const r of routes) {
    lines.push(`## חלופה ${r.option}: ${r.lines} (סה"כ ${r.duration} | יציאה: ${r.departure || '-'} | הגעה: ${r.arrival || '-'})`);
    lines.push(r.fullText);
    lines.push(`- **הרחבה והליכה:** ${r.walkDetailSpeech}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ============================================================================
// כלים 1–2: Google Places + Google Maps Routes v2
// ============================================================================
const PLACES_DECL = {
  name: 'google_places_search',
  description: 'Search businesses, synagogues, hospitals, pharmacies, institutions, or landmarks in Israel for exact address, phone number, open status, and hours.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Specific Hebrew announcement, e.g. "בודקת את הכתובת ושעות הפתיחה של מעייני הישועה"' },
      query: { type: 'STRING', description: 'Search query in Hebrew including city if known' },
      max_results: { type: 'INTEGER', description: '1 to 5 (default 3)' }
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
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.currentOpeningHours.openNow,places.regularOpeningHours.weekdayDescriptions,places.rating',
      'User-Agent': CRAWLER_UA
    },
    body: JSON.stringify({ textQuery: String(queryText).trim(), languageCode: 'he', regionCode: 'IL', maxResultCount: count })
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
  if (!places.length) return { status: 'not_found', message: 'לא נמצאו מקומות תואמים.' };
  if (s) { s.workingMemory = s.workingMemory || {}; s.workingMemory.lastPlaces = places; }
  return { status: 'ok', count: places.length, places };
}

const MAPS_DECL = {
  name: 'google_maps_route',
  description: 'REQUIRED for all Israeli public transit, bus, train, light rail, walking, and driving routes.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Specific Hebrew announcement naming origin & destination, e.g. "מחפשת לך נסיעה מרבי עקיבא בבני ברק לכותל המערבי בגוגל מפות"' },
      origin: { type: 'STRING', description: 'Starting address/station/landmark with city in Israel' },
      destination: { type: 'STRING', description: 'Destination address/station/landmark with city in Israel' },
      mode: { type: 'STRING', description: '"transit" (default), "walking", or "driving"' },
      departure_time: { type: 'STRING', description: 'Optional: "now", "HH:MM", "+30m", or ISO-8601' },
      arrival_time: { type: 'STRING', description: 'Optional (transit): desired arrival time in "HH:MM" or ISO-8601' }
    },
    required: ['action_announcement', 'origin', 'destination']
  }
};

async function computeRoutesV2Call(originSpec, destSpec, travelMode, depIso, arrIso, deadline) {
  const body = {
    origin: originSpec, destination: destSpec, travelMode,
    computeAlternativeRoutes: true, languageCode: 'he', regionCode: 'IL', units: 'METRIC'
  };
  if (arrIso && travelMode === 'TRANSIT') body.arrivalTime = arrIso;
  else if (depIso) body.departureTime = depIso;

  const r = await http('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': MAPS_KEY,
      'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.localizedValues,routes.legs.duration,routes.legs.localizedValues,routes.legs.steps.travelMode,routes.legs.steps.staticDuration,routes.legs.steps.distanceMeters,routes.legs.steps.localizedValues,routes.legs.steps.navigationInstruction,routes.legs.steps.transitDetails',
      'User-Agent': CRAWLER_UA
    },
    body: JSON.stringify(body)
  }, 15000, deadline);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, routes: j.routes || [], errorMsg: (j.error && j.error.message) || '' };
}

async function runGoogleMapsRoute(args, s, deadline) {
  if (!MAPS_KEY) return { error: 'GOOGLE_MAPS_API_KEY is not configured' };
  const modeMap = { transit: 'TRANSIT', walking: 'WALK', driving: 'DRIVE', bicycling: 'BICYCLE' };
  const travelMode = modeMap[String(args.mode || 'transit').toLowerCase()] || 'TRANSIT';
  const originRaw = String(args.origin || '').trim();
  const destRaw = String(args.destination || '').trim();
  let originClean = cleanTransitHe(originRaw);
  let destClean = cleanTransitHe(destRaw);
  const depIso = parseIsraelTimeInput(args.departure_time);
  const arrIso = parseIsraelTimeInput(args.arrival_time);

  let notePrefix = '';
  let v2 = await computeRoutesV2Call({ address: originRaw }, { address: destRaw }, travelMode, depIso, arrIso, deadline);

  if ((!v2.routes || !v2.routes.length) && MAPS_KEY) {
    const [oPlaces, dPlaces] = await Promise.all([
      queryGooglePlacesIL(originRaw, 1, deadline).catch(() => []),
      queryGooglePlacesIL(destRaw, 1, deadline).catch(() => [])
    ]);
    if (oPlaces.length || dPlaces.length) {
      const oSpec = oPlaces[0] && oPlaces[0].placeId ? { placeId: oPlaces[0].placeId } : { address: originRaw };
      const dSpec = dPlaces[0] && dPlaces[0].placeId ? { placeId: dPlaces[0].placeId } : { address: destRaw };
      if (oPlaces[0] && oPlaces[0].name) originClean = oPlaces[0].name;
      if (dPlaces[0] && dPlaces[0].name) destClean = dPlaces[0].name;
      v2 = await computeRoutesV2Call(oSpec, dSpec, travelMode, depIso, arrIso, deadline);
    }
  }

  if ((!v2.routes || !v2.routes.length) && travelMode === 'TRANSIT' && !depIso && !arrIso) {
    const morningTry = await computeRoutesV2Call({ address: originRaw }, { address: destRaw }, 'TRANSIT', nextMorningIsraelIso(), null, deadline);
    if (morningTry.routes && morningTry.routes.length) {
      v2 = morningTry;
      notePrefix = 'כעת אין אוטובוסים פעילים, בבוקר הקרוב:';
    }
  }

  if (!v2.routes || !v2.routes.length) {
    return { status: 'no_routes_found', details: v2.errorMsg || 'לא נמצאו מסלולים זמינים בין נקודות אלו.' };
  }

  const built = v2.routes.map(rt => buildPolishedRouteV2(rt, originClean, destClean));
  const polished = finalizeTopRoutes(built, originClean, destClean);
  const overviewSpeech = buildInitialTransitSpeech(polished, originClean, destClean, notePrefix);

  if (s) {
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
  }

  return {
    status: 'ok',
    recommended_spoken_response: overviewSpeech,
    instruction_to_model: 'Output recommended_spoken_response directly starting immediately with "המסלול המהיר ביותר:" with ZERO preamble or extra introduction!'
  };
}

// ============================================================================
// כלי 3: חיפוש רשת מקבילי מדורג ב-Groq + חילוץ URL-ים אמיתיים + גוגל (סעיפים 3, 5)
// ============================================================================
const PARALLEL_SEARCH_DECL = {
  name: 'web_search_parallel',
  description: 'Execute 2 to 8 parallel web searches with staggered dispatch (zero rate-limit errors) and return both accurate findings AND real https:// source URLs that can be passed to fetch_webpage.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Specific Hebrew announcement describing what you are searching for, e.g. "מחפשת ברשת מידע עדכני על..."' },
      queries: { type: 'ARRAY', items: { type: 'STRING' }, description: '2 to 8 targeted search queries' }
    },
    required: ['action_announcement', 'queries']
  }
};

function extractUrlsFromGroqMessage(msg) {
  const rawBlob = JSON.stringify(msg.executed_tools || '') + ' ' + String(msg.content || '');
  const matches = rawBlob.match(/https?:\/\/[^\s"'<>\\)\]]+/gi) || [];
  const urls = [];
  const seen = new Set();
  for (const m of matches) {
    const clean = m.replace(/[.,;:]+$/, '');
    if (!seen.has(clean) && !/exa\.ai\/search|googleapis\.com/i.test(clean)) {
      seen.add(clean);
      urls.push(clean);
    }
  }
  return urls.slice(0, 8);
}

async function singleGroqStaggeredQuery(query, idx, deadline) {
  // סעיף 3: דירוג שליחה בהפרש של כ-40 אלפיות שנייה + חלוקת עומס בין שני מודלים נפרדים ב-Groq!
  if (idx > 0) await sleep(idx * GROQ_STAGGER_MS);
  if (!GROQ_KEYS.length) return { query, error: 'GROQ_API_KEYS missing' };

  for (let attempt = 0; attempt < 3; attempt++) {
    const key = GROQ_KEYS[(rot.groq++) % GROQ_KEYS.length];
    const model = GROQ_SEARCH_MODELS[(idx + attempt) % GROQ_SEARCH_MODELS.length];
    try {
      const r = await http(GROQ_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'User-Agent': CRAWLER_UA },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'Search the web thoroughly. Return accurate, current factual details in 80-130 words AND include the exact https:// source URLs you relied on.' },
            { role: 'user', content: query }
          ],
          tools: [{ type: 'browser_search' }],
          tool_choice: 'required',
          reasoning_effort: 'low',
          max_completion_tokens: 550,
          stream: false
        })
      }, 20000, deadline);

      if (r.status === 429) {
        const resetHdr = r.headers.get('x-ratelimit-reset-tokens') || '';
        const secMatch = /(\d+(?:\.\d+)?)s/.exec(resetHdr);
        const waitMs = secMatch ? Math.min(4500, Math.ceil(Number(secMatch[1]) * 1000) + 150) : (1200 * (attempt + 1));
        await sleep(waitMs);
        continue;
      }
      if (!r.ok) return { query, error: 'HTTP ' + r.status };

      const j = await r.json();
      const msg = ((j.choices || [])[0] || {}).message || {};
      const urls = extractUrlsFromGroqMessage(msg);
      const text = String(msg.content || '').replace(/【[^】]*】/g, '').replace(/\s+/g, ' ').trim();
      return { query, model_used: model, result: text || 'אין תוצאות', urls };
    } catch (e) {
      if (isBudget(e)) throw e;
      if (attempt === 2) return { query, error: e.message };
      await sleep(500);
    }
  }
  return { query, error: 'rate_limited_after_retries' };
}

async function tryGoogleCustomWebSearch(query, deadline) {
  if (!SEARCH_KEY || !SEARCH_CX) return [];
  try {
    const u = new URL('https://www.googleapis.com/customsearch/v1');
    u.searchParams.set('key', SEARCH_KEY);
    u.searchParams.set('cx', SEARCH_CX);
    u.searchParams.set('q', query);
    u.searchParams.set('num', '5');
    const r = await http(u.toString(), { headers: { 'User-Agent': CRAWLER_UA } }, 8000, deadline);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.items || []).map(it => ({ title: it.title, url: it.link, snippet: it.snippet }));
  } catch (e) { return []; }
}

async function runParallelGroqSearch(queries, s, deadline) {
  const list = (Array.isArray(queries) ? queries : []).map(q => String(q).trim()).filter(Boolean).slice(0, 8);
  if (!list.length) return { error: 'No queries provided' };

  const [groqResults, googleItems] = await Promise.all([
    Promise.all(list.map((q, idx) => singleGroqStaggeredQuery(q, idx, deadline))),
    tryGoogleCustomWebSearch(list[0], deadline)
  ]);

  const allUrls = uniqueList([
    ...groqResults.flatMap(r => r.urls || []),
    ...googleItems.map(g => g.url)
  ]).slice(0, 12);

  if (s) {
    s.workingMemory = s.workingMemory || {};
    s.workingMemory.lastSearch = JSON.stringify({ findings: groqResults.map(r => ({ q: r.query, res: r.result })), urls: allUrls }).slice(0, 2000);
  }
  return {
    executed_count: groqResults.length,
    findings: groqResults,
    google_top_links: googleItems,
    discovered_urls_for_fetch_webpage: allUrls
  };
}

// ============================================================================
// כלי 4: שאיבת אתרים משודרגת — תומך בכתובת בודדת או מספר כתובות במקביל (סעיף 5)
// ============================================================================
const FETCH_WEBPAGE_DECL = {
  name: 'fetch_webpage',
  description: 'Scrape and extract clean full text and internal links from 1 to 4 webpage URLs concurrently.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Specific Hebrew announcement, e.g. "קוראת לעומק את המידע מתוך האתר שנמצא"' },
      url: { type: 'STRING', description: 'Primary http/https URL to scrape' },
      urls: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Optional list of up to 4 URLs to scrape concurrently' }
    },
    required: ['action_announcement']
  }
};

async function scrapeOneUrl(u, deadline) {
  const target = String(u || '').trim();
  if (!/^https?:\/\//i.test(target)) return { url: target, error: 'Invalid URL' };
  try {
    const r = await http(target, {
      headers: { 'User-Agent': CRAWLER_UA, 'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8' },
      redirect: 'follow'
    }, 14000, deadline);
    if (!r.ok) return { url: target, error: 'HTTP ' + r.status };
    const raw = await r.text();
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
    const title = titleMatch ? stripHtml(titleMatch[1]).slice(0, 180) : '';
    const subLinks = uniqueList((raw.match(/href=["'](https?:\/\/[^"'#\s]+)["']/gi) || []).map(x => x.slice(6, -1))).slice(0, 8);
    const clean = stripHtml(raw).slice(0, 9000);
    return { url: target, title, content: clean || 'לא נמצא טקסט קריא', sample_links: subLinks };
  } catch (e) {
    return { url: target, error: e.message };
  }
}

async function runFetchWebpage(args, deadline) {
  const targets = uniqueList([args.url, ...(Array.isArray(args.urls) ? args.urls : [])]).slice(0, 4);
  if (!targets.length) return { error: 'No URL provided' };
  const pages = await Promise.all(targets.map(u => scrapeOneUrl(u, deadline)));
  return { scraped_count: pages.length, pages };
}

// ============================================================================
// כלי 5: מודל חשיבה עמוקה לפרויקטים מורכבים ב-Groq (Qwen 3.8 / GPT-OSS High Reasoning — סעיף 12)
// ============================================================================
const DEEP_REASONING_DECL = {
  name: 'deep_reasoning_expert',
  description: 'Invoke a heavy reasoning model via Groq (Qwen 3.8 / GPT-OSS-120B High Reasoning) for complex software engineering, full multi-file code generation, deep analysis, math/logic proofs, or comprehensive structured documents.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Specific Hebrew announcement, e.g. "מפעילה מודל חשיבה עמוקה לבניית התוכנה המלאה"' },
      task_prompt: { type: 'STRING', description: 'Complete, detailed specification of the complex task, context, constraints, and desired output structure' },
      preferred_model: { type: 'STRING', description: 'Optional: "qwen" (qwen/qwen3.8-27b) or "gpt-oss" (openai/gpt-oss-120b)' }
    },
    required: ['action_announcement', 'task_prompt']
  }
};

async function runDeepReasoningExpert(args, deadline) {
  if (!GROQ_KEYS.length) return { error: 'GROQ_API_KEYS missing' };
  const pref = String(args.preferred_model || '').toLowerCase();
  const orderedModels = pref.includes('gpt')
    ? uniqueList(['openai/gpt-oss-120b', ...GROQ_REASONING_MODELS])
    : uniqueList([...GROQ_REASONING_MODELS, 'openai/gpt-oss-120b']);

  let lastErr = 'Reasoning failed';
  for (const model of orderedModels) {
    const key = GROQ_KEYS[rot.groq++ % GROQ_KEYS.length];
    try {
      const payload = {
        model,
        messages: [
          { role: 'system', content: 'You are a senior architect, software engineer, and analytical researcher. Produce thorough, complete, production-ready code, analysis, or Hebrew documentation with zero placeholders.' },
          { role: 'user', content: String(args.task_prompt || '').slice(0, 14000) }
        ],
        max_completion_tokens: 6500
      };
      if (model.includes('gpt-oss')) payload.reasoning_effort = 'high';

      const r = await http(GROQ_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'User-Agent': CRAWLER_UA },
        body: JSON.stringify(payload)
      }, 45000, deadline);

      if (!r.ok) {
        lastErr = `${model} HTTP ${r.status}`;
        continue;
      }
      const j = await r.json();
      const rawOut = String((((j.choices || [])[0] || {}).message || {}).content || '');
      // ניקוי תגיות <think> אם המודל פלט חשיבה גולמית ושמירה על הפתרון הנקי
      const cleaned = rawOut.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      return { status: 'ok', reasoning_model_used: model, solution: cleaned || rawOut };
    } catch (e) {
      if (isBudget(e)) throw e;
      lastErr = e.message;
    }
  }
  return { error: lastErr };
}

// ============================================================================
// כלים 6–7: שליחת מייל HTML RTL + יצירת קובצי Word (.docx), קוד ופרויקטים ב-ZIP (סעיפים 10, 11)
// ============================================================================
const SEND_EMAIL_DECL = {
  name: 'send_email',
  description: 'Send a richly styled RTL HTML Hebrew email to the default user email or to any explicitly requested email address (automatically triggers voice confirmation if custom email).',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Specific Hebrew announcement, e.g. "מעצבת ושולחת את התשובה המלאה למייל"' },
      subject: { type: 'STRING', description: 'Clear Hebrew email subject line' },
      content: { type: 'STRING', description: 'Rich Hebrew content (supports Markdown headings #, ##, **bold**, bullet lists -, and ```code``` blocks which render into styled RTL HTML)' },
      recipient_email: { type: 'STRING', description: 'Optional: ONLY provide if the caller explicitly asked to send to a specific email address' }
    },
    required: ['action_announcement', 'subject', 'content']
  }
};

async function runSendEmail(args, s, deadline) {
  return await dispatchOrRequireEmailConfirmation(s, args.recipient_email, {
    subject: String(args.subject || 'סיכום מקו AI').slice(0, 180),
    body: String(args.content || '').slice(0, 25000),
    files: []
  }, deadline);
}

const CREATE_FILES_EMAIL_DECL = {
  name: 'create_and_email_files',
  description: 'Create and email Word documents (.docx in full RTL Hebrew), source code files (.py, .js, .html, .sql, .json, .md), or complete multi-file software projects bundled as a .zip archive with instructions, wrapped in a styled RTL HTML email.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Specific Hebrew announcement, e.g. "מייצרת את מסמך הוורד וקובצי הקוד ושולחת למייל"' },
      subject: { type: 'STRING', description: 'Email subject in Hebrew' },
      explanation_hebrew: { type: 'STRING', description: 'Detailed Hebrew explanation and usage instructions to appear in the styled RTL HTML email body' },
      word_documents: {
        type: 'ARRAY',
        description: 'Optional list of Microsoft Word (.docx) documents to generate in RTL Hebrew',
        items: {
          type: 'OBJECT',
          properties: {
            filename: { type: 'STRING', description: 'e.g. "סיכום_מקיף.docx"' },
            title: { type: 'STRING', description: 'Document main header title' },
            content: { type: 'STRING', description: 'Full structured content (supports #, ##, ### headings, **bold**, bullets, code blocks)' }
          },
          required: ['filename', 'content']
        }
      },
      project_files: {
        type: 'ARRAY',
        description: 'Optional list of code, web, data, or text files (can be multiple files forming a complete software project)',
        items: {
          type: 'OBJECT',
          properties: {
            path: { type: 'STRING', description: 'File name or relative path inside project, e.g. "src/index.js" or "app.html"' },
            content: { type: 'STRING', description: 'Complete file source code or text content' }
          },
          required: ['path', 'content']
        }
      },
      bundle_as_zip: { type: 'BOOLEAN', description: 'Set true when sending >=2 project files or a structured multi-folder software project so they arrive neatly inside a .zip archive' },
      zip_filename: { type: 'STRING', description: 'Optional zip name, e.g. "project_bundle.zip"' },
      recipient_email: { type: 'STRING', description: 'Optional custom recipient email if explicitly requested by caller' }
    },
    required: ['action_announcement', 'subject', 'explanation_hebrew']
  }
};

async function runCreateAndEmailFiles(args, s, deadline) {
  const attachments = [];

  // 1. יצירת מסמכי Word (.docx) תקניים בעברית RTL
  for (const doc of (Array.isArray(args.word_documents) ? args.word_documents : [])) {
    if (!doc || !doc.content) continue;
    let fn = String(doc.filename || 'מסמך.docx').trim();
    if (!/\.docx$/i.test(fn)) fn += '.docx';
    const docxBuf = createRtlDocxBuffer({ title: doc.title || args.subject, content: doc.content });
    attachments.push({
      filename: fn,
      base64: docxBuf.toString('base64'),
      mimeType: guessMimeByExt(fn)
    });
  }

  // 2. יצירת קובצי קוד / תוכנה (כקבצים בודדים או כארכיון פרויקט ZIP שלם!)
  const projFiles = (Array.isArray(args.project_files) ? args.project_files : []).filter(f => f && f.path && f.content !== undefined);
  if (projFiles.length > 0) {
    if (args.bundle_as_zip || projFiles.length > 3 || projFiles.some(f => f.path.includes('/'))) {
      const zipEntries = projFiles.map(f => ({ name: f.path, data: String(f.content) }));
      if (!zipEntries.some(e => /readme/i.test(e.name))) {
        zipEntries.push({ name: 'README_HE.md', data: `# ${args.subject}\n\n${args.explanation_hebrew || ''}\n` });
      }
      const zipBuf = createZipBuffer(zipEntries);
      let zName = String(args.zip_filename || 'project_files.zip').trim();
      if (!/\.zip$/i.test(zName)) zName += '.zip';
      attachments.push({
        filename: zName,
        base64: zipBuf.toString('base64'),
        mimeType: 'application/zip'
      });
    } else {
      for (const pf of projFiles) {
        const baseName = path.basename(pf.path);
        attachments.push({
          filename: baseName,
          base64: Buffer.from(String(pf.content), 'utf8').toString('base64'),
          mimeType: guessMimeByExt(baseName)
        });
      }
    }
  }

  return await dispatchOrRequireEmailConfirmation(s, args.recipient_email, {
    subject: String(args.subject || 'קבצים ומסמכים מקו AI').slice(0, 180),
    body: String(args.explanation_hebrew || ''),
    files: attachments,
    attachHtmlCopy: true
  }, deadline);
}

// ============================================================================
// כלים 8–10: יצירת תמונות, חיפוש תמונות ברשת ויצירת אודיו (תומכים ב-recipient_email!)
// ============================================================================
const GEN_IMAGE_DECL = {
  name: 'generate_image',
  description: 'Generate 1 to 4 AI images with custom aspect ratio and email them in a styled RTL HTML email.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Specific Hebrew announcement describing the image being created, e.g. "יוצרת לך תמונה של..."' },
      prompt: { type: 'STRING', description: 'Detailed English image generation prompt' },
      aspect_ratio: { type: 'STRING', description: '"1:1", "16:9", "9:16", "4:3", or "3:4"' },
      count: { type: 'INTEGER', description: '1 to 4' },
      recipient_email: { type: 'STRING', description: 'Optional custom recipient email if explicitly requested' }
    },
    required: ['action_announcement', 'prompt']
  }
};

async function generateOneGeminiImage(prompt, aspectRatio, deadline) {
  const j = await gem(IMAGE_MODEL, {
    contents: [{ role: 'user', parts: [{ text: String(prompt).slice(0, 1200) }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio } }
  }, deadline, 'text', { ms: 45000, retries: 1 });
  const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  const img = parts.find(p => p.inlineData && p.inlineData.data);
  if (!img) throw new Error('לא התקבלה תמונה מהמודל');
  const mime = img.inlineData.mimeType || 'image/png';
  return { base64: img.inlineData.data, mimeType: mime, ext: mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png' };
}

async function runGenerateImage(args, s, deadline) {
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
      body: JSON.stringify({ instances: [{ prompt: String(args.prompt).slice(0, 1000) }], parameters: { sampleCount: count, aspectRatio } })
    }, 45000, deadline);
    if (!r.ok) throw new Error('שגיאה ביצירת תמונה: ' + r.status);
    const j = await r.json();
    files = (j.predictions || []).map((p, idx) => ({ filename: `generated_image_${idx + 1}.png`, base64: p.bytesBase64Encoded, mimeType: p.mimeType || 'image/png' }));
  } else {
    const settled = await Promise.allSettled(Array.from({ length: count }, () => generateOneGeminiImage(args.prompt, aspectRatio, deadline)));
    const okImgs = settled.filter(x => x.status === 'fulfilled').map(x => x.value);
    if (!okImgs.length) throw new Error(settled[0] && settled[0].reason ? settled[0].reason.message : 'שגיאה ביצירת התמונה');
    files = okImgs.map((img, idx) => ({ filename: `generated_image_${idx + 1}.${img.ext}`, base64: img.base64, mimeType: img.mimeType }));
  }

  return await dispatchOrRequireEmailConfirmation(s, args.recipient_email, {
    subject: `התמונות שיצרת מוכנות (${files.length} תמונות, יחס ${aspectRatio})`,
    body: `שלום,\nמצורפות **${files.length} תמונות** שנוצרו עבורך בבינה מלאכותית.\n- **תיאור התמונה:** ${args.prompt}\n- **יחס תצוגה:** ${aspectRatio}`,
    files
  }, deadline);
}

const SEARCH_IMAGES_DECL = {
  name: 'search_and_email_images',
  description: 'Search Google Images for existing photos, verify each is under 20MB, and email them.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Specific Hebrew announcement, e.g. "מחפשת ברשת תמונות של... ושולחת למייל"' },
      query: { type: 'STRING', description: 'Image search query' },
      count: { type: 'INTEGER', description: '1 to 5' },
      recipient_email: { type: 'STRING', description: 'Optional custom recipient email if explicitly requested' }
    },
    required: ['action_announcement', 'query']
  }
};

const MAX_IMG_BYTES = 20 * 1024 * 1024;
async function fetchImageUnder20MB(url, idx, deadline) {
  try {
    const r = await http(url, { redirect: 'follow', headers: { 'User-Agent': CRAWLER_UA } }, 14000, deadline);
    if (!r.ok) return null;
    const ctype = String(r.headers.get('content-type') || '').toLowerCase();
    if (!ctype.startsWith('image/') || ctype.includes('svg')) return null;
    if (Number(r.headers.get('content-length') || 0) > MAX_IMG_BYTES) return null;
    const reader = r.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_IMG_BYTES) { reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    if (total < 1024) return null;
    const ext = ctype.includes('png') ? 'png' : ctype.includes('webp') ? 'webp' : ctype.includes('gif') ? 'gif' : 'jpg';
    return { filename: `found_image_${idx + 1}.${ext}`, base64: Buffer.concat(chunks, total).toString('base64'), mimeType: ctype.split(';')[0].trim(), bytes: total };
  } catch (e) { return null; }
}

async function runSearchAndEmailImages(args, s, deadline) {
  if (!SEARCH_KEY || !SEARCH_CX) throw new Error('חסרה הגדרת GOOGLE_SEARCH_CX לחיפוש תמונות');
  const query = String(args.query || '').trim();
  const count = Math.min(5, Math.max(1, parseInt(args.count, 10) || 3));
  const u = new URL('https://www.googleapis.com/customsearch/v1');
  u.searchParams.set('key', SEARCH_KEY); u.searchParams.set('cx', SEARCH_CX);
  u.searchParams.set('q', query); u.searchParams.set('searchType', 'image');
  u.searchParams.set('num', '10'); u.searchParams.set('safe', 'active');

  const r = await http(u.toString(), { headers: { 'User-Agent': CRAWLER_UA } }, 14000, deadline);
  const j = await r.json();
  if (!r.ok) throw new Error('שגיאה בחיפוש תמונות בגוגל: ' + ((j.error && j.error.message) || r.status));

  const urls = (j.items || []).map(it => it && it.link).filter(l => typeof l === 'string' && /^https?:\/\//i.test(l));
  if (!urls.length) throw new Error('לא נמצאו תמונות מתאימות');

  const downloaded = await Promise.all(urls.map((imgUrl, idx) => fetchImageUnder20MB(imgUrl, idx, deadline)));
  const validFiles = [];
  let totalBytes = 0;
  for (const f of downloaded) {
    if (!f || totalBytes + f.bytes > MAX_IMG_BYTES) continue;
    totalBytes += f.bytes;
    validFiles.push({ filename: `found_image_${validFiles.length + 1}${path.extname(f.filename)}`, base64: f.base64, mimeType: f.mimeType });
    if (validFiles.length >= count) break;
  }
  if (!validFiles.length) throw new Error('לא נמצאו תמונות תקינות להורדה');

  return await dispatchOrRequireEmailConfirmation(s, args.recipient_email, {
    subject: `תמונות שנמצאו עבור: ${query} (${validFiles.length} תמונות)`,
    body: `שלום,\nמצורפות **${validFiles.length} תמונות** שנמצאו ברשת עבור החיפוש: **"${query}"**.`,
    files: validFiles
  }, deadline);
}

const GEN_AUDIO_DECL = {
  name: 'generate_audio',
  description: 'Synthesize custom spoken narration audio and play it on the call, email it as WAV, or both.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Specific Hebrew announcement, e.g. "מקליטה ומכינה לך את קריינות השמע"' },
      script_text: { type: 'STRING', description: 'Exact Hebrew text to synthesize' },
      delivery: { type: 'STRING', description: '"play", "email", or "both"' },
      voice_gender: { type: 'STRING', description: '"male" or "female"' },
      title: { type: 'STRING', description: 'Short title' },
      recipient_email: { type: 'STRING', description: 'Optional custom recipient email' }
    },
    required: ['action_announcement', 'script_text', 'delivery']
  }
};

async function runGenerateAudio(args, s, deadline) {
  const voice = args.voice_gender === 'male' ? VOICE_BY.male : VOICE_BY.female;
  const wavBuf = await ttsMergedWav(String(args.script_text).slice(0, 4500), deadline, { voice });
  const delivery = String(args.delivery || 'play').toLowerCase();
  const title = String(args.title || 'קובץ קריינות מקו AI').slice(0, 70);

  if (delivery === 'play' || delivery === 'both') {
    const name = 'ga' + crypto.randomBytes(4).toString('hex');
    await upload(name, wavBuf, deadline, s.d, 25000);
    s.extraPlayChain = (s.extraPlayChain ? s.extraPlayChain + '.' : '') + 'f-' + s.d + '/' + name;
  }
  if (delivery === 'email' || delivery === 'both') {
    return await dispatchOrRequireEmailConfirmation(s, args.recipient_email, {
      subject: `קובץ אודיו חדש: ${title}`,
      body: `שלום,\nמצורף קובץ השמע שביקשת לייצר.\n\n### טקסט הקריינות:\n${args.script_text}`,
      files: [{ filename: 'narration.wav', base64: wavBuf.toString('base64'), mimeType: 'audio/wav' }]
    }, deadline);
  }
  return { status: 'success', delivery };
}

// ============================================================================
// כלים 11–12: מאגר צדדי של פודקאסטים, רדיו ושירים + נגן מתקדם עם סימניות והרצה (סעיפים 14, 15)
// ============================================================================
const BROWSE_CATALOG_DECL = {
  name: 'browse_media_catalog',
  description: 'Enter the rich side-database of Hebrew Podcasts, Shiurim, Radio News, and Downloadable Music/Songs ONLY when the caller asks about podcasts, radio, lessons, or songs. Shows available shows/songs, latest episodes, AND which episode this caller is currently holding at!',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Specific Hebrew announcement, e.g. "נכנסת למאגר הפודקאסטים והמוזיקה ובודקת את הפרקים האחרונים"' },
      content_type: { type: 'STRING', description: '"podcasts" (podcasts/radio/shiurim), "music" (new downloadable singles & songs), or "all"' },
      query: { type: 'STRING', description: 'Optional search keyword (show name, topic, artist, or song name; leave empty to see top recommendations & caller progress)' },
      show_episodes_of_url: { type: 'STRING', description: 'Optional RSS feed URL to inspect its exact list of episodes' }
    },
    required: ['action_announcement', 'content_type']
  }
};

async function runBrowseMediaCatalog(args, s, deadline) {
  const ctype = String(args.content_type || 'all').toLowerCase();
  const q = String(args.query || '').trim();
  const out = {};

  if (args.show_episodes_of_url) {
    const feedInfo = await fetchShowEpisodes(args.show_episodes_of_url, 12);
    out.show_title = feedInfo.showTitle;
    out.episodes = feedInfo.episodes;
    out.headlines = feedInfo.headlines;
  } else {
    if (ctype === 'podcasts' || ctype === 'all') {
      const shows = await searchPodcastsDirectory(q, RADIO_FEEDS);
      out.podcasts_and_radio = shows.slice(0, 12).map(sh => {
        const prog = s && s.callerMem && s.callerMem.episodeProgress ? s.callerMem.episodeProgress[sh.id] : null;
        return {
          id: sh.id,
          name: sh.name,
          category: sh.category,
          type: sh.type,
          rss_url: sh.url,
          description: sh.description,
          caller_last_progress: prog ? `שמע לאחרונה את פרק #${prog.lastEpisodeIndex}: "${prog.lastEpisodeTitle}" (${prog.updatedAt})` : 'טרם האזין'
        };
      });
      // אם נמצאה תוכנית מובהקת אחת של אודיו, נטען מיד גם את 6 הפרקים האחרונים שלה!
      if (shows.length >= 1 && q && shows[0].type === 'audio_rss') {
        try {
          const epData = await fetchShowEpisodes(shows[0].url, 8);
          out.top_match_episodes = { show_id: shows[0].id, show_name: shows[0].name, episodes: epData.episodes, headlines: epData.headlines.slice(0, 6) };
        } catch (e) {}
      }
    }
    if (ctype === 'music' || ctype === 'all') {
      const tracks = await searchSongsLive(q, JAMENDO_CLIENT_ID);
      out.songs_and_singles = tracks.slice(0, 10);
    }
  }

  if (s) {
    s.workingMemory = s.workingMemory || {};
    s.workingMemory.lastCatalog = out;
  }
  return out;
}

const PLAY_MEDIA_ITEM_DECL = {
  name: 'play_media_item',
  description: 'Play a podcast episode, radio news bulletin, downloadable song/single, or YouTube audio link in the caller-isolated Advanced Media Player (supports 1=Rewind, 2=Pause, 3=Fast-Forward, 5=Save Bookmark, 8=Return to Chat), or read news headlines if text feed.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Specific Hebrew announcement, e.g. "מכינה להשמעה את הפרק של עושים טכנולוגיה בנגן המתקדם"' },
      media_type: { type: 'STRING', description: '"podcast_rss" (play episode from RSS feed), "direct_audio" (direct mp3/audio URL from music catalog), "youtube" (YouTube video URL), or "live_radio" (transfer to live stream extension)' },
      title: { type: 'STRING', description: 'Clear Hebrew title of the song or podcast episode being played' },
      source_url: { type: 'STRING', description: 'RSS feed URL, direct MP3 URL, or YouTube URL' },
      show_id: { type: 'STRING', description: 'Optional show ID for saving caller episode progress' },
      episode_number: { type: 'INTEGER', description: 'Optional 1-based episode index from latest (1 = newest episode, 2 = second newest, or next episode after caller progress)' }
    },
    required: ['action_announcement', 'media_type']
  }
};

// הכנת תיקיית נגן מדיה אישית ומבודדת לכל מתקשר ב-/8/<phoneFolder> עם מקשי הרצה, סימניות וחזרה לצ'אט (סעיפים 13, 15)
async function prepareCallerSmartPlayer(s, audioUrl, mediaMeta, deadline) {
  const folderId = s && s.ph ? s.ph : ('c' + String((s && s.id) || 'guest').slice(-8));
  const playerDir = `/${MEDIA_PLAYER_EXT}/${folderId}`;
  const playerExtIni = [
    'type=playfile',
    'title=נגן מדיה אישי',
    'say_details_message=no',
    'listening_mark=yes',
    'star_extension=yes',
    'control_play5=go_to_folder',
    `playfile_control_play_5_goto=/${BOOKMARKS_EXT}`,
    'control_play8=go_to_folder',
    `playfile_control_play_8_goto=/${CHAT_EXT}`,
    'control_play0=go_to_folder',
    `playfile_control_play_0_goto=/${CHAT_EXT}`,
    `playfile_end_goto=/${CHAT_EXT}`,
    `playfile_error_goto=/${CHAT_EXT}`
  ].join('\n');

  // כתיבת הגדרת הנגן האישי בימות המשיח
  const iniBody = new URLSearchParams({ token: TOKEN, what: `ivr2:${playerDir}/ext.ini`, contents: playerExtIni }).toString();
  await fetch(YM + 'UploadTextFile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CRAWLER_UA },
    body: iniBody,
    signal: AbortSignal.timeout(8000)
  }).catch(() => {});

  // הורדה והמרה של קובץ השמע עד 45 דקות ב-ffmpeg ל-000.wav בתיקיית המתקשר האישית
  const tmp = path.join(os.tmpdir(), 'mp_' + crypto.randomBytes(4).toString('hex'));
  try {
    const r = await http(audioUrl, { headers: { 'User-Agent': CRAWLER_UA }, redirect: 'follow' }, 55000, deadline);
    if (!r.ok) throw new Error('שגיאה בהורדת קובץ המדיה: ' + r.status);
    const out = fs.createWriteStream(tmp + '.in');
    const reader = r.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (got > 120 * 1024 * 1024) { reader.cancel().catch(() => {}); throw new Error('קובץ המדיה גדול מדי'); }
      if (!out.write(value)) await new Promise(res => out.once('drain', res));
    }
    await new Promise((res, rej) => out.end(e => (e ? rej(e) : res())));

    let buf;
    if (FFMPEG) {
      await execFileP(FFMPEG, ['-y', '-v', 'error', '-i', tmp + '.in', '-vn', '-t', '2700', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', tmp + '.wav'], {
        timeout: Math.max(8000, deadline - Date.now())
      });
      buf = fs.readFileSync(tmp + '.wav');
    } else {
      buf = fs.readFileSync(tmp + '.in');
    }

    // מחיקת קובץ קודם בתיקיית הנגן האישי כדי ש-000.wav יתנגן מיד
    del('000', playerDir);
    await upload('000', buf, deadline, playerDir, 55000);
  } finally {
    for (const ext of ['.in', '.wav']) fs.rm(tmp + ext, { force: true }, () => {});
  }

  // שמירת המדיה הפעילה ומעקב פרקים עבור המתקשר (סעיפים 14, 15)
  if (s && s.ph) {
    const mem = await loadCallerMemory(s.ph);
    mem.lastPlayingMedia = {
      title: mediaMeta.title || 'שמע',
      audioUrl,
      showId: mediaMeta.showId || '',
      episodeIndex: mediaMeta.episodeIndex || 1,
      playerDir,
      startedAtMs: Date.now(),
      updatedAt: nowIsraelInfo().shortStamp
    };
    if (mediaMeta.showId) {
      mem.episodeProgress[mediaMeta.showId] = {
        showName: mediaMeta.showName || mediaMeta.title,
        lastEpisodeTitle: mediaMeta.title,
        lastEpisodeIndex: mediaMeta.episodeIndex || 1,
        audioUrl,
        updatedAt: nowIsraelInfo().shortStamp
      };
    }
    s.callerMem = mem;
    await saveCallerMemoryBg(s.ph, mem);
  }

  if (s) {
    s.transferToPlayer = {
      dir: playerDir,
      title: mediaMeta.title || 'השמע המבוקש'
    };
    s.inMediaPlayer = true;
    s.mediaStartedAt = Date.now();
  }
  return {
    status: 'transferring_to_smart_player',
    title: mediaMeta.title,
    controls_announced_automatically: '1=אחורה, 2=עצירה/המשך, 3=קדימה, 5=שמירה בסימניות, 8=חזרה לשיחה'
  };
}

async function runPlayMediaItem(args, s, deadline) {
  const mtype = String(args.media_type || 'podcast_rss').toLowerCase();
  if (mtype === 'live_radio' && LIVE_STREAM_EXT) {
    if (s) s.transferToExt = '/' + LIVE_STREAM_EXT;
    return { status: 'transferring_to_live_stream', extension: LIVE_STREAM_EXT };
  }

  let srcUrl = String(args.source_url || '').trim();
  let title = String(args.title || '').trim();
  let showId = String(args.show_id || '').trim();
  let showName = title;
  let epNum = Math.max(1, parseInt(args.episode_number, 10) || 1);

  if (mtype === 'youtube') {
    const resolved = await resolveYoutubeAudioUrl(srcUrl);
    if (!resolved) {
      // נפילה חכמה לחיפוש השיר במאגר השירים החינמי
      const altSongs = await searchSongsLive(title || srcUrl, JAMENDO_CLIENT_ID);
      if (!altSongs.length) throw new Error('לא ניתן היה לחלץ אודיו ישיר מקישור היוטיוב הזה');
      srcUrl = altSongs[0].audioUrl;
      title = altSongs[0].title;
    } else {
      srcUrl = resolved;
    }
    return await prepareCallerSmartPlayer(s, srcUrl, { title: title || 'שיר מיוטיוב' }, deadline);
  }

  if (mtype === 'direct_audio') {
    if (!srcUrl) {
      const tracks = await searchSongsLive(title, JAMENDO_CLIENT_ID);
      if (!tracks.length) throw new Error('לא נמצא קובץ שיר תואם להשמעה');
      srcUrl = tracks[0].audioUrl;
      title = tracks[0].title;
    }
    return await prepareCallerSmartPlayer(s, srcUrl, { title: title || 'שיר מהמאגר' }, deadline);
  }

  // podcast_rss / radio RSS
  if (!srcUrl) {
    const shows = await searchPodcastsDirectory(title || 'חדשות כאן', RADIO_FEEDS);
    const picked = shows[0];
    if (!picked) throw new Error('לא נמצאה תחנה או פודקאסט תואם');
    if (picked.type === 'live_stream' && LIVE_STREAM_EXT) {
      if (s) s.transferToExt = '/' + LIVE_STREAM_EXT;
      return { status: 'transferring_to_live_stream', extension: LIVE_STREAM_EXT };
    }
    srcUrl = picked.url;
    showId = showId || picked.id;
    showName = picked.name;
  }

  const feedData = await fetchShowEpisodes(srcUrl, 15);
  showName = feedData.showTitle || showName;

  if (feedData.episodes.length > 0) {
    const ep = feedData.episodes[Math.min(feedData.episodes.length - 1, epNum - 1)] || feedData.episodes[0];
    return await prepareCallerSmartPlayer(s, ep.audioUrl, {
      title: `${showName} - ${ep.title}`.slice(0, 90),
      showId: showId || 'pod_' + Buffer.from(srcUrl).toString('base64url').slice(-8),
      showName,
      episodeIndex: ep.index
    }, deadline);
  }

  if (feedData.headlines.length > 0) {
    return {
      status: 'headlines_ready_to_read',
      station: showName,
      headlines: feedData.headlines.slice(0, 7),
      instruction_to_model: `קראי מהדורת חדשות קולחת וברורה מתוך ${Math.min(7, feedData.headlines.length)} הכותרות העדכניות של ${showName}.`
    };
  }
  throw new Error('לא נמצאו פרקי שמע או מבזקים פעילים בפיד');
}

// ============================================================================
// כלים 13–14: שמירת זיכרון מתקשר + הפעלת משימות מרובות ברקע עם צנתוק (סעיף 8)
// ============================================================================
const SAVE_MEMORY_DECL = {
  name: 'save_caller_memory',
  description: 'Save permanent personal facts/preferences for this caller (home/work address, name, regular preferences).',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Specific Hebrew announcement, e.g. "שומרת את הכתובת שלך בזיכרון הקבוע"' },
      fact: { type: 'STRING', description: 'Key:value fact in Hebrew' },
      clear_all: { type: 'BOOLEAN', description: 'True ONLY if caller asked to clear all saved facts' }
    },
    required: ['action_announcement', 'fact']
  }
};

async function runSaveCallerMemory(args, s) {
  if (!s || !s.ph || !HISTORY_EXT) return { status: 'session_only' };
  const mem = await loadCallerMemory(s.ph);
  if (args.clear_all) {
    mem.notes = [];
  } else {
    const fact = String(args.fact || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    if (fact) {
      const prefix = fact.includes(':') ? fact.split(':')[0].trim() : '';
      if (prefix) mem.notes = mem.notes.filter(n => !n.startsWith(prefix + ':'));
      mem.notes.unshift(fact);
      mem.notes = mem.notes.slice(0, 20);
    }
  }
  s.callerMem = mem;
  await saveCallerMemoryBg(s.ph, mem);
  return { status: 'saved_permanently', notes: mem.notes };
}

const START_BG_TASK_DECL = {
  name: 'start_background_task',
  description: 'Run a long, multi-step research/coding/document/media pipeline asynchronously in the background so the caller can continue chatting or hang up and receive an automatic callback Tzintuk when finished!',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Specific Hebrew announcement, e.g. "מעבירה את הפרויקט לביצוע מלא ברקע עם שליחת צנתוק בסיום"' },
      task_title: { type: 'STRING', description: 'Short Hebrew title of the background project' },
      detailed_mission: { type: 'STRING', description: 'Full instructions for the background agent to execute (research, deep reasoning, generating files/images, emailing results)' }
    },
    required: ['action_announcement', 'task_title', 'detailed_mission']
  }
};

function launchDetachedBackgroundAgent({ phone, originConvId, historySnapshot, sysPrompt, taskTitle, detailedMission }) {
  if (!phone) return false;
  const bgId = 'bg_' + Date.now().toString(36);
  bgTasksByPhone[phone] = { id: bgId, title: taskTitle, startedAt: Date.now(), status: 'running' };

  (async () => {
    const bgDeadline = Date.now() + 280000; // עד 4.5 דקות ברקע!
    const bgSession = {
      ph: phone,
      d: '/' + CHAT_EXT,
      sys: sysPrompt,
      confirmedEmails: new Set(),
      workingMemory: {}
    };
    let finalSummary = '';
    try {
      const bgContents = [
        ...(historySnapshot || []).slice(-6),
        {
          role: 'user',
          parts: [{
            text: `בצעי כעת במשימת רקע מלאה ויסודית את הפרויקט הבא (אל תקראי שוב ל-start_background_task; בצעי את כל החיפושים, החשיבה העמוקה, יצירת הקבצים והשליחה למייל הדרושים וסכמי את התוצאה הכוללת באופן ברור להקראה למתקשר כשישוב לקו): ${detailedMission}`
          }]
        }
      ];
      const res = await askModel(sysPrompt, bgContents, bgDeadline, bgSession, { isBackground: true });
      const parts = (((res.candidates || [])[0] || {}).content || {}).parts || [];
      finalSummary = parseCtl(parts.filter(p => !p.thought).map(p => p.text || '').join('').trim()).text || 'המשימה הושלמה בהצלחה.';
    } catch (e) {
      finalSummary = `ביצוע המשימה ברקע נתקל בתקלה חלקית: ${e.message}`;
    }

    delete bgTasksByPhone[phone];

    const mem = await loadCallerMemory(phone);
    if (mem) {
      mem.completedBgTasks = mem.completedBgTasks || [];
      mem.completedBgTasks.unshift({
        id: bgId,
        title: taskTitle,
        originConvId: originConvId || '',
        resultSpeech: finalSummary.slice(0, 2500),
        completedAt: nowIsraelInfo().shortStamp
      });
      mem.completedBgTasks = mem.completedBgTasks.slice(0, 8);

      // הוספת התוצאה גם לשיחה הספציפית שממנה יצאה משימת הרקע!
      if (originConvId) {
        const origConv = mem.conversations.find(c => c.id === originConvId);
        if (origConv) {
          origConv.turns.push({ q: `[משימת רקע: ${taskTitle}]`, a: finalSummary.slice(0, 2500) });
          origConv.updatedAt = nowIsraelInfo().shortStamp;
        }
      }
      await saveCallerMemoryBg(phone, mem);
    }

    // אם המתקשר עדיין בשיחה חיה — נעדכן אותו בשיחה; אם כבר ניתק — נשלח לו צנתוק חוזר!
    const liveKey = activeCallsByPhone[phone];
    if (liveKey && calls[liveKey]) {
      calls[liveKey].pendingBgNotice = `דרך אגב, סיימתי עבורך ברקע את המשימה בנושא ${taskTitle}!`;
    } else {
      await sendYemotTzintuk(phone);
    }
  })().catch(e => console.error('BG task fatal:', e.message));

  return true;
}

// ============================================================================
// לולאת הסוכנת הרב-שלבית (עד 12 שלבים ברצף! סעיפים 7, 8, 12)
// ============================================================================
const MAX_AGENT_STEPS = 12;

async function askModel(sys, contents, deadline, s, opts = {}) {
  const base = { systemInstruction: { parts: [{ text: sys }] } };
  const decls = [
    PARALLEL_SEARCH_DECL,
    FETCH_WEBPAGE_DECL,
    DEEP_REASONING_DECL,
    BROWSE_CATALOG_DECL,
    PLAY_MEDIA_ITEM_DECL,
    GEN_IMAGE_DECL,
    GEN_AUDIO_DECL,
    SAVE_MEMORY_DECL
  ];
  if (!opts.isBackground) decls.push(START_BG_TASK_DECL);
  if (SEARCH_KEY && SEARCH_CX) decls.push(SEARCH_IMAGES_DECL);
  if (GAS_MAIL_URL && TARGET_EMAIL) {
    decls.push(SEND_EMAIL_DECL);
    decls.push(CREATE_FILES_EMAIL_DECL);
  }
  if (MAPS_KEY) {
    decls.push(MAPS_DECL);
    decls.push(PLACES_DECL);
  }

  const tools = [{ functionDeclarations: decls }];
  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    if (s && s.cancelled) throw new Error('cancelled');
    const desiredThinking = detectDesiredThinkingLevel(contents, step);
    const a = await textGen({ ...base, contents, tools }, deadline, desiredThinking);
    const cand = (a.candidates || [])[0] || {};
    const fcalls = ((cand.content || {}).parts || []).filter(p => p.functionCall);
    if (!fcalls.length) return a;

    // סעיף 6: הודעת ביניים חיה וספציפית לפעולה הנוכחית
    const announcements = fcalls.map(c => (c.functionCall.args || {}).action_announcement).filter(Boolean);
    if (announcements.length && !opts.isBackground) {
      pushStatus(s, announcements[0]);
    }

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
        } else if (fname === 'deep_reasoning_expert') {
          out = await runDeepReasoningExpert(args, deadline);
        } else if (fname === 'send_email') {
          out = await runSendEmail(args, s, deadline);
        } else if (fname === 'create_and_email_files') {
          out = await runCreateAndEmailFiles(args, s, deadline);
        } else if (fname === 'generate_image') {
          out = await runGenerateImage(args, s, deadline);
        } else if (fname === 'search_and_email_images') {
          out = await runSearchAndEmailImages(args, s, deadline);
        } else if (fname === 'generate_audio') {
          out = await runGenerateAudio(args, s, deadline);
        } else if (fname === 'browse_media_catalog') {
          out = await runBrowseMediaCatalog(args, s, deadline);
        } else if (fname === 'play_media_item') {
          out = await runPlayMediaItem(args, s, deadline);
        } else if (fname === 'save_caller_memory') {
          out = await runSaveCallerMemory(args, s);
        } else if (fname === 'start_background_task') {
          if (!s || !s.ph) {
            out = { error: 'משימת רקע עם צנתוק זמינה רק למספר טלפון מזוהה' };
          } else {
            if (!s.convId) s.convId = 'c_' + Date.now().toString(36);
            launchDetachedBackgroundAgent({
              phone: s.ph,
              originConvId: s.convId,
              historySnapshot: s.h,
              sysPrompt: s.sys,
              taskTitle: args.task_title || 'משימה מרובת שלבים',
              detailedMission: args.detailed_mission
            });
            out = {
              status: 'running_in_background',
              instruction_to_model: `אשרי למתקשר בקצרה שהעברת את "${args.task_title}" לביצוע מלא ברקע ושתשלחי לו צנתוק מיד כשתסתיים, והציעי להמשיך לשוחח בינתיים על כל נושא אחר.`
            };
          }
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

    if (s && (s.transferToExt || s.transferToPlayer || s.awaitingEmailConfirm)) {
      contents = [...contents, cand.content, { role: 'user', parts: resp }];
      if (s.transferToExt || s.transferToPlayer) return a;
    } else {
      contents = [...contents, cand.content, { role: 'user', parts: resp }];
    }
  }
  return textGen({ ...base, contents }, deadline, 'low');
}

// ============================================================================
// מנוע קול Gemini קבוע 100% + גיבוי עצבי WAV (לעולם לא קול רובוטי של ימות!)
// + אינדקס מזהי השמעה קבוע (Persistent Audio Registry — סעיף 2)
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
const PACE_PREFIX = { slow: 'Say slowly and clearly: ', fast: 'Say briskly and clearly: ' };

const SHORT_RE = /^\s*(?:ת?קצר(?:י)? את התשוב(?:ה|ות)|תענ[יה](?: יותר)? קצר|תענ[יה] בקצרה|בקצרה|בקיצור)\s*/;
const LONG_RE = /^\s*(?:תפרט(?:י)?|תרחיב(?:י)?|תאריכ(?:י)? את התשוב(?:ה|ות)|תענ[יה](?: יותר)? בהרחבה)\s*/;

function parseCtl(text) {
  const ctl = {};
  let q = '';
  const noQ = String(text || '').replace(/\[\[\s*Q\s*:([^\]]*)\]\]/gi, (_, v) => { if (!q) q = v.replace(/\s+/g, ' ').trim(); return ' '; });
  const clean = noQ.replace(/\[\[\s*(VOICE|PACE|LEN)\s*:\s*([a-z]+)\s*\]\]/gi, (_, k, v) => { ctl[k.toLowerCase()] = v.toLowerCase(); return ' '; });
  return { text: clean.replace(/[*#_`~]/g, '').replace(/\s+/g, ' ').trim(), ctl, q: q.slice(0, 600) };
}

function splitTextForChunks(text, firstMax = 280, nextMax = 750) {
  const out = [];
  let cur = '';
  for (let sn of String(text || '').split(/(?<=[.!?:;])\s+/)) {
    for (;;) {
      const limit = out.length === 0 ? firstMax : nextMax;
      if (sn.length <= limit) break;
      let k = sn.lastIndexOf(' ', limit);
      if (k < 100) k = limit;
      if (cur) { out.push(cur); cur = ''; }
      out.push(sn.slice(0, k).trim());
      sn = sn.slice(k).trim();
    }
    if (!sn) continue;
    const limit = out.length === 0 ? firstMax : nextMax;
    if (cur && cur.length + sn.length + 1 > limit) { out.push(cur); cur = sn; }
    else cur = cur ? cur + ' ' + sn : sn;
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

// גיבוי קול עצבי בעברית (WAV 8kHz) — מבטיח ב-100% שלעולם לא יושמע הקול הרובוטי המכני של ימות המשיח גם אם נגמרה המכסה היומית של מפתח ה-Gemini!
async function neuralHebrewEmergencyWav(text, deadline) {
  if (!FFMPEG) throw new Error('ffmpeg unavailable for neural fallback');
  const sentences = splitTextForChunks(String(text || '').slice(0, 2500), 175, 180);
  const mp3Buffers = [];
  for (const seg of sentences) {
    const u = 'https://translate.google.com/translate_tts?ie=UTF-8&tl=iw&client=tw-ob&q=' + encodeURIComponent(seg);
    const r = await http(u, { headers: { 'User-Agent': CRAWLER_UA } }, 9000, deadline);
    if (!r.ok) throw new Error('neural fallback http ' + r.status);
    mp3Buffers.push(Buffer.from(await r.arrayBuffer()));
  }
  const tmp = path.join(os.tmpdir(), 'nfb_' + crypto.randomBytes(4).toString('hex'));
  try {
    fs.writeFileSync(tmp + '.mp3', Buffer.concat(mp3Buffers));
    await execFileP(FFMPEG, ['-y', '-v', 'error', '-i', tmp + '.mp3', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', tmp + '.wav'], { timeout: 10000 });
    return fs.readFileSync(tmp + '.wav');
  } finally {
    for (const x of ['.mp3', '.wav']) fs.rm(tmp + x, { force: true }, () => {});
  }
}

async function ttsOne(text, deadline, o) {
  o = o || {};
  const pacePrefix = PACE_PREFIX[o.pace] || '';
  let last = new Error('no audio from tts');

  for (let mi = 0; mi < TTS_LIST.length; mi++) {
    const model = TTS_LIST[mi];
    if ((ttsDown[model] || 0) > Date.now()) continue;
    const V = voicesFor(model, o.voice || VOICE);
    const modelPrefix = isLegacy25Tts(model) && !pacePrefix ? 'Read aloud verbatim: ' : pacePrefix;

    for (let i = 0; i < 2; i++) {
      try {
        const t = await gem(model, {
          contents: [{ role: 'user', parts: [{ text: modelPrefix + text.slice(0, 3000) }] }],
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: V[vIdx[model] || 0] } }
        }, deadline, 'tts', { ms: 38000, retries: 0 });
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
    // סעיף 2: קירור קצר של 12 שניות בלבד על עומס דקתי (ולא 10 דקות שנעלו את הקול!)
    if (last.status === 404) ttsDown[model] = Date.now() + 3600000;
    else if (last.status === 429) ttsDown[model] = Date.now() + 12000;
  }

  // אם כל 5 מודלי ה-TTS של Gemini החזירו 429 באותה שנייה, נפיק קובץ שמע עצבי אמיתי ב-WAV כדי שלעולם לא יושמע קול רובוטי של ימות!
  return await neuralHebrewEmergencyWav(text, deadline);
}

async function ttsMergedWav(text, deadline, o) {
  const parts = splitTextForChunks(String(text).slice(0, 8000), 650, 800);
  if (parts.length <= 1) return ttsOne(text, deadline, o);
  const bufs = await Promise.all(parts.map(x => ttsOne(x, deadline, o)));
  const gap = Buffer.alloc(2000);
  const pcms = [];
  bufs.forEach((b, i) => { if (i) pcms.push(gap); pcms.push(to8k(pcmOf(b)).pcm); });
  return wav(Buffer.concat(pcms), 8000);
}

// סעיף 16: מקטע ראשון קצר במיוחד (280 תווים) + העלאה במקביל למהירות תגובה מרבית
async function ttsUploadChain(s, text, deadline, o, basePrefix) {
  const parts = splitTextForChunks(String(text).slice(0, 9000), 280, 750);
  if (!parts.length) return null;
  const uploadedNames = [];
  const chainRefs = await Promise.all(parts.map(async (chunk, idx) => {
    if (idx > 0) await sleep(idx * 80); // פיזור קל למניעת 429 רגעי ב-TTS
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
    await sleep(i === 0 ? 400 : 650);
    const targetPath = uniquePaths[i % uniquePaths.length];
    try {
      const r = await http(YM + 'DownloadFile?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent(targetPath), { headers: { 'User-Agent': CRAWLER_UA } }, 9000, deadline);
      const b = Buffer.from(await r.arrayBuffer());
      if (r.ok && b.length > 100 && b.subarray(0, 4).toString() === 'RIFF') return b;
      last = r.status + ' ' + b.subarray(0, 80).toString('utf8').replace(/\s+/g, ' ');
    } catch (e) {
      if (isBudget(e)) throw e;
      last = e.message;
    }
  }
  throw new Error('download failed [' + uniquePaths.join(' | ') + '] -> ' + last);
}

async function upload(name, buf, deadline, d, ms) {
  const target = yp(name, d);
  const attempts = [{ q: true, field: 'file' }, { q: true, field: 'upload' }, { q: false, field: 'upload' }, { q: false, field: 'file' }];
  let last = '';
  for (const a of attempts) {
    try {
      const f = new FormData();
      let url = YM + 'UploadFile';
      if (a.q) url += '?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent(target) + '&convertAudio=1';
      else { f.append('token', TOKEN); f.append('path', target); f.append('convertAudio', '1'); }
      f.append(a.field, new Blob([buf], { type: 'audio/wav' }), name + '.wav');
      const r = await http(url, { method: 'POST', headers: { 'User-Agent': CRAWLER_UA }, body: f }, ms || 18000, deadline);
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
  fetch(YM + 'FileAction?token=' + encodeURIComponent(TOKEN) + '&action=delete&what=' + encodeURIComponent(yp(name, d)), {
    headers: { 'User-Agent': CRAWLER_UA },
    signal: AbortSignal.timeout(8000)
  }).catch(() => {});
}

function cleanupReplyFiles(s) {
  if (!s) return;
  if (Array.isArray(s.rFiles)) {
    for (const f of s.rFiles) del(f, s.d);
    s.rFiles = [];
  }
  if (s.routeAudioCache) {
    for (const entry of Object.values(s.routeAudioCache)) {
      if (entry && Array.isArray(entry.files)) for (const f of entry.files) del(f, s.d);
    }
    s.routeAudioCache = {};
  }
}

// ============================================================================
// אינדקס מזהי השמעות מהירות קבוע בימות המשיח (Persistent Audio ID Registry — סעיף 2)
// השרת טוען בעלייה את כל הקבצים שכבר קיימים בימות בלי ליצור מחדש, ומוחק/מעדכן רק בעת שינוי!
// ============================================================================
const REGISTRY_PATH = HISTORY_EXT ? `ivr2:/${HISTORY_EXT}/audio_registry_v4.ini` : '';
const sysReady = {};     // key: "/5/sp1234567890" -> true
const sysRegistry = {};  // key: "/5/sp1234567890" -> { name, dir, text, voice, semanticId }
const sysInFlight = {};
let registryDirty = false;
let fallbackErrClipRef = '';

function clipHashName(voice, cleanText) {
  return 'sp' + crypto.createHash('sha1').update(voice + '|' + cleanText).digest('hex').slice(0, 10);
}

async function listYemotWavSet(dirPath) {
  if (!TOKEN) return new Set();
  try {
    const u = YM + 'GetIVR2Dir?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent('ivr2:' + dirPath);
    const r = await fetch(u, { headers: { 'User-Agent': CRAWLER_UA }, signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => ({}));
    const files = (j.files || []).map(f => String(f.name || '')).filter(n => n.endsWith('.wav') && !n.startsWith('~'));
    return new Set(files.map(n => n.replace(/\.wav$/i, '')));
  } catch (e) {
    return new Set();
  }
}

async function persistAudioRegistry() {
  if (!REGISTRY_PATH || !TOKEN || !registryDirty) return;
  registryDirty = false;
  try {
    const body = new URLSearchParams({
      token: TOKEN,
      what: REGISTRY_PATH,
      contents: JSON.stringify({ version: '4.0.0', entries: sysRegistry })
    }).toString();
    await fetch(YM + 'UploadTextFile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CRAWLER_UA },
      body,
      signal: AbortSignal.timeout(8000)
    });
  } catch (e) {}
}

async function sysClip(s, text, timeoutMs, semanticId = '') {
  const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleanText) return fallbackErrClipRef;
  const dir = (s && s.d) || ('/' + CHAT_EXT);
  const voice = (s && s.vc && VOICE_BY[s.vc]) || VOICE;
  const name = clipHashName(voice, cleanText);
  const key = dir + '/' + name;

  if (sysReady[key]) return 'f-' + dir + '/' + name;

  if (!sysInFlight[key]) {
    sysInFlight[key] = (async () => {
      const waitMs = timeoutMs || 18000;
      const dl = Date.now() + waitMs;
      const pcm = await ttsMergedWav(cleanText, dl, { voice });
      await upload(name, pcm, dl, dir, waitMs);
      sysReady[key] = true;
      sysRegistry[key] = { name, dir, text: cleanText, voice, semanticId: semanticId || '', updatedAt: Date.now() };
      registryDirty = true;
      if (semanticId === 'sys_err') fallbackErrClipRef = 'f-' + dir + '/' + name;
      persistAudioRegistry().catch(() => {});
    })().catch(e => {
      console.error('sysClip synthesis error:', e.message);
    }).finally(() => {
      delete sysInFlight[key];
    });
  }

  await sysInFlight[key];
  if (sysReady[key]) return 'f-' + dir + '/' + name;
  // לעולם לא מחזירים t- רובוטי! אם נוצר קובץ שגיאה קולי קבוע מחזירים אותו
  return fallbackErrClipRef || ('f-' + dir + '/' + name);
}

// ============================================================================
// הגדרת שלוחות ותפריטים בימות המשיח
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
  d, sys, g, n: 0, hn: 0, mode: '', job: null, cancelled: false, detachedToBg: false,
  vc: '', pace: '', len: '', h: [], p: '', name: '',
  rFiles: [], t: 0, e: crypto.randomBytes(3).toString('hex'),
  statusQueue: [], routeAlternatives: [], routeObjects: [], routeAudioCache: {},
  workingMemory: {}, callerMem: null, interruptedLast: false, convId: '',
  confirmedEmails: new Set(), pendingEmail: null, awaitingEmailConfirm: false,
  inMediaPlayer: false, mediaStartedAt: 0, pendingBgNotice: '', offeredBgSwitch: false
}, extra || {});

const EMPTY = 'None';
const TAP_EMPTY = ',No,no,no,,,,Ok,' + EMPTY;
const digitsOf = v => { const x = String(v == null ? '' : v).trim(); return x === EMPTY ? '' : x; };

const KB_KEYS = { '3': 'אבג', '2': 'דהו', '6': 'זחט', '5': 'יכךל', '4': 'מםנן', '9': 'סעפף', '8': 'צץק', '7': 'רשת' };
const KB_FINAL = { 'כ': 'ך', 'מ': 'ם', 'נ': 'ן', 'פ': 'ף', 'צ': 'ץ' };
const MENU_OPEN = 'להקלטת בקשה הקש 1, להקלדה הקש 2, להיסטוריה 9';
const MENU = 'להקלטה הקש 1, להקלדה הקש 2';
const KB_MORE = 'לבקשה נוספת, הקש 1 להקלטה או 2 להקלדה';
const KB_START = 'הקלד את הבקשה ללא הגבלת אורך ובסיום הקש סולמית';
const kbFinal = t => t.replace(/(?<=[א-ת])[כמנפצ](?=\s|$)/g, c => KB_FINAL[c]);

// סעיף 1: הקלטה ארוכה ונוחה (עד REC_MAX=300 שניות, סיום ב-# או ב-REC_SILENCE שניות שקט)
const askFor = async (s, preText) => {
  s.n++; s.mode = 'rec'; s.p = 'Q' + s.e + s.n; s.name = 'q' + s.e + 'n' + s.n;
  const clip = await sysClip(s, preText);
  return 'read=' + clip + '=' + s.p + ',no,record,' + s.d + ',' + s.name + ',no,,,' + REC_SILENCE + ',' + REC_MAX;
};
const tapAny = async (s, preText, menuText) => {
  s.n++; s.mode = 'menu'; s.p = 'K' + s.e + s.n;
  const fullPrompt = [preText, menuText === null ? '' : (menuText || MENU)].filter(Boolean).join('. ');
  const clip = await sysClip(s, fullPrompt);
  return 'read=' + clip + '=' + s.p + ',no,1,1,' + WAIT_SEC + TAP_EMPTY;
};
const ansFor = (s, pre) => { s.n++; s.mode = 'ans'; s.p = 'A' + s.e + s.n; return 'read=' + pre + '=' + s.p + ',no,1,1,1' + TAP_EMPTY; };
const routeChoiceFor = (s, pre) => { s.n++; s.mode = 'route_choice'; s.p = 'R' + s.e + s.n; return 'read=' + pre + '=' + s.p + ',no,1,1,10' + TAP_EMPTY; };
const emailConfirmFor = (s, pre) => { s.n++; s.mode = 'confirm_email'; s.p = 'E' + s.e + s.n; return 'read=' + pre + '=' + s.p + ',no,1,1,12' + TAP_EMPTY; };
const bgResumeChoiceFor = (s, pre) => { s.n++; s.mode = 'bg_resume_choice'; s.p = 'B' + s.e + s.n; return 'read=' + pre + '=' + s.p + ',no,1,1,10' + TAP_EMPTY; };

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
  // סעיף 1: תמיכה בטקסט מוקלד ארוך עד 4000 תווים
  const text = kbFinal(s.buf.replace(/\s+/g, ' ').trim().slice(0, 4000));
  s.buf = '';
  if (!text) return await kbAsk(s, 'לא הוקלד טקסט, נסו שוב');
  return await runTurn(s, q, id, T0, text);
}

async function runTurn(s, q, id, T0, typed) {
  const recVal = typed ? '' : digitsOf(q[s.p]);
  if (!typed && !recVal) return await tapAny(s, AGAIN);
  s.jobT0 = Date.now();
  s.cancelled = false;
  s.detachedToBg = false;
  s.offeredBgSwitch = false;
  s.lastUserPromptSummary = typed || 'משימה מרובת שלבים';
  s.statusQueue = ['קיבלתי, רגע אחד'];
  s.extraPlayChain = '';
  s.transferToExt = '';
  s.transferToPlayer = null;
  s.awaitingRouteChoice = false;
  s.awaitingEmailConfirm = false;

  s.job = doTurn(s, q, id, s.jobT0, typed, recVal).catch(async e => {
    console.error(id, 'turn crashed', e && e.message);
    return await tapAny(s, ERR);
  });
  return await holdStep(s, q);
}

// סעיף 8: המתנה חכמה התומכת גם בביטול (0) וגם במעבר לריצה ברקע עם צנתוק (2) במשימות ארוכות!
async function holdStep(s, q) {
  const prevHoldKey = 'H' + s.e + s.hn;
  const pressed = q ? digitsOf(q[prevHoldKey]) : '';

  if (pressed === '0') {
    s.cancelled = true;
    s.job = null;
    s.statusQueue = [];
    return await tapAny(s, 'הבקשה בוטלה');
  }

  // אם המתקשר הקיש 2 כדי להעביר את המשימה המתמשכת לרקע עם צנתוק ולהמשיך לשוחח!
  if (pressed === '2' && s.ph && s.job) {
    const runningPromise = s.job;
    const taskTitle = String(s.lastUserPromptSummary || 'משימה מורכבת').slice(0, 55);
    const originConvId = s.convId || ('c_' + Date.now().toString(36));
    s.convId = originConvId;
    s.detachedToBg = true;
    s.job = null;
    s.statusQueue = [];

    runningPromise.then(async () => {
      const answerText = s.lastSpokenAnswer || 'המשימה ברקע הושלמה בהצלחה.';
      const mem = await loadCallerMemory(s.ph);
      if (mem) {
        mem.completedBgTasks.unshift({
          id: 'bg_' + Date.now().toString(36),
          title: taskTitle,
          originConvId,
          resultSpeech: answerText.slice(0, 2500),
          completedAt: nowIsraelInfo().shortStamp
        });
        await saveCallerMemoryBg(s.ph, mem);
      }
      const liveKey = activeCallsByPhone[s.ph];
      if (liveKey && calls[liveKey]) {
        calls[liveKey].pendingBgNotice = `סיימתי ברקע את המשימה בנושא ${taskTitle}!`;
      } else {
        await sendYemotTzintuk(s.ph);
      }
    }).catch(() => {});

    return await tapAny(s, 'העברתי את הפעולה לביצוע ברקע ואשלח לך צנתוק בסיום. אפשר להמשיך לשוחח כרגיל');
  }

  if (s.statusQueue && s.statusQueue.length > 0) {
    const msg = s.statusQueue.shift();
    s.hn++;
    const clip = await sysClip(s, msg, 16000);
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
    const clip = await sysClip(s, msg, 16000);
    return 'read=' + clip + '=H' + s.e + s.hn + ',no,1,1,1' + TAP_EMPTY;
  }
  const elapsedMs = Date.now() - s.jobT0;
  if (elapsedMs > BUDGET + 15000) {
    s.cancelled = true;
    s.job = null;
    return await tapAny(s, ERR);
  }

  // סעיף 8: אחרי 18 שניות של משימה מורכבת, נציע למתקשר לעבור לביצוע ברקע + צנתוק!
  if (elapsedMs > 18000 && !s.offeredBgSwitch && s.ph) {
    s.offeredBgSwitch = true;
    s.hn++;
    const offerClip = await sysClip(s, 'המשימה ארוכה ועדיין בעיבוד. להמשך המתנה אל תקיש כלום, או הקש 2 להעברה לרקע עם צנתוק בסיום והמשך שיחה', 18000);
    return 'read=' + offerClip + '=H' + s.e + s.hn + ',no,1,1,3' + TAP_EMPTY;
  }

  s.hn++;
  const waitClip = await sysClip(s, 'עוד רגע', 15000);
  return 'read=' + waitClip + '=H' + s.e + s.hn + ',no,1,1,1' + TAP_EMPTY;
}

async function speakAndReturn(s, text, deadline, modeType, cacheSlot) {
  const tail = s.extraPlayChain ? '.' + s.extraPlayChain : '';
  s.extraPlayChain = '';
  const builder = modeType === 'route'
    ? routeChoiceFor
    : (modeType === 'email_confirm' ? emailConfirmFor : (modeType === 'bg_resume' ? bgResumeChoiceFor : ansFor));

  if (cacheSlot && s.routeAudioCache && s.routeAudioCache[cacheSlot]) {
    return builder(s, s.routeAudioCache[cacheSlot].chain + tail);
  }

  const basePrefix = 'r' + s.e + 'n' + s.n;
  const built = await ttsUploadChain(s, text, deadline, { voice: VOICE_BY[s.vc], pace: s.pace }, basePrefix);

  if (!built || !built.chain) {
    return builder(s, (fallbackErrClipRef || await sysClip(s, ERR)) + tail);
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
    let userParts = [], tq = typed || '';
    if (typed) {
      let m;
      if ((m = SHORT_RE.exec(tq))) { s.len = 'short'; tq = tq.slice(m[0].length).trim() || 'אשרי בקצרה'; }
      else if ((m = LONG_RE.exec(tq))) { s.len = ''; tq = tq.slice(m[0].length).trim() || 'אשרי בהרחבה'; }
      userParts = [{ text: 'הבקשה הוקלדה במקשי הטלפון: ' + tq }];
    } else {
      const audio = await download(qn, deadline, s.d, recVal, s.apiExt);
      del(qn, s.d);
      // סעיף 1: להקלטות ארוכות או מורכבות נריץ גם Whisper-Large-V3-Turbo ב-Groq לדיוק מקסימלי בשמות, כתובות מייל והכתבות ארוכות!
      let whisperTxt = '';
      if (audio.length > 75000 && GROQ_KEYS.length) {
        whisperTxt = await transcribeHebrewWhisper(audio, deadline);
        if (whisperTxt) {
          tq = whisperTxt;
          s.lastUserPromptSummary = whisperTxt.slice(0, 80);
        }
      }
      userParts = [{ inlineData: { mimeType: 'audio/wav', data: audio.toString('base64') } }];
      if (whisperTxt) {
        userParts.push({ text: `[תמלול עזר מדויק מ-Whisper להקלטה זו: "${whisperTxt}"]` });
      }
    }

    if (!s.detachedToBg) cleanupReplyFiles(s);

    const turnSys = buildDynamicTurnSys(s);
    s.interruptedLast = false;

    const a = await askModel(
      turnSys,
      [...s.h.slice(-12), { role: 'user', parts: userParts }],
      deadline,
      s
    );

    if (s.cancelled) return await tapAny(s, 'הבקשה בוטלה');

    // סעיף 15: העברה לנגן המדיה החכם עם הודעה קצרה לפני ההפעלה!
    if (s.transferToPlayer) {
      const tp = s.transferToPlayer;
      s.transferToPlayer = null;
      const introMsg = `מפעילה את ${tp.title}. להרצה אחורה הקש 1, לעצירה 2, לקדימה 3, לשמירה בסימניות 5, ולחזרה לשיחה איתי הקש 8.`;
      const trClip = await sysClip(s, introMsg, 18000);
      return `id_list_message=${trClip}&go_to_folder=${tp.dir}`;
    }

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

    // סעיף 4: אם מדובר בתשובת תחבורה ציבורית בלבד, נוודא שהיא מתחילה ישר ב-"המסלול המהיר ביותר:" ללא הקדמות מיותרות!
    if (s.awaitingRouteChoice && s.routeOverviewSpeech && text.includes('המסלול המהיר ביותר:')) {
      const idxFast = text.indexOf('המסלול המהיר ביותר:');
      if (idxFast > 0 && idxFast < 120) text = text.slice(idxFast);
    }

    if (s.pendingBgNotice) {
      text = `${s.pendingBgNotice} ${text}`;
      s.pendingBgNotice = '';
    }

    if (ctl.ctl.voice === 'male' || ctl.ctl.voice === 'female') s.vc = ctl.ctl.voice;
    else if (ctl.ctl.voice === 'default') s.vc = '';
    if (ctl.ctl.len === 'short') s.len = 'short';
    else if (ctl.ctl.len === 'long') s.len = '';
    if (ctl.ctl.pace === 'slow' || ctl.ctl.pace === 'fast') s.pace = ctl.ctl.pace;
    else if (ctl.ctl.pace === 'normal') s.pace = '';

    const qtext = tq || ctl.q || '[בקשה קולית]';
    s.lastUserPromptSummary = qtext.slice(0, 70);
    s.lastSpokenAnswer = text;
    s.h.push({ role: 'user', parts: [{ text: qtext }] }, { role: 'model', parts: [{ text }] });
    if (s.h.length > 18) s.h = s.h.slice(-18);

    if (s.ph && HISTORY_EXT) {
      recordTurnInCallerHistory(s, qtext, text).catch(() => {});
    }

    if (s.detachedToBg) return 'noop=detached';

    if (s.awaitingEmailConfirm && s.pendingEmail) {
      return await speakAndReturn(s, text, deadline, 'email_confirm', '');
    }

    const isRouteMenu = !!(s.awaitingRouteChoice && s.routeAlternatives && s.routeAlternatives.length > 0);
    return await speakAndReturn(s, text, deadline, isRouteMenu ? 'route' : 'ans', isRouteMenu ? 'overview' : '');
  } catch (e) {
    console.error(id, 'turn failed:', e.message);
    if (!typed) del(qn, s.d);
    return await tapAny(s, ERR);
  }
}

// ============================================================================
// טיפול באימות ותיקון כתובת מייל מותאמת אישית (סעיף 11)
// ============================================================================
async function handleEmailConfirmStep(s, q) {
  const d = digitsOf(q[s.p]);
  if (!s.pendingEmail) {
    s.awaitingEmailConfirm = false;
    return await tapAny(s, KB_MORE);
  }

  if (d === '1') {
    const targetTo = s.pendingEmail.to;
    const payload = s.pendingEmail.payload;
    s.pendingEmail = null;
    s.awaitingEmailConfirm = false;
    s.confirmedEmails.add(targetTo);
    try {
      await sendViaGasEmail({ ...payload, to: targetTo }, Date.now() + 30000);
      s.n++;
      return await speakAndReturn(s, `המייל נשלח בהצלחה לכתובת שאישרת. ${KB_MORE}`, Date.now() + 30000, 'ans', '');
    } catch (e) {
      return await tapAny(s, 'הייתה תקלה בשליחת המייל לכתובת זו');
    }
  }

  if (d === '2') {
    // הקלטה מחדש של כתובת המייל בלבד מבלי לאבד את הקבצים/התוכן המוכנים!
    s.n++; s.mode = 'reenter_email_rec'; s.p = 'EQ' + s.e + s.n; s.name = 'eq' + s.e + 'n' + s.n;
    const clip = await sysClip(s, 'אמור כעת לאט ובבירור באנגלית את כתובת המייל המלאה ובסיום הקש סולמית');
    return 'read=' + clip + '=' + s.p + ',no,record,' + s.d + ',' + s.name + ',no,,,3,45';
  }

  s.pendingEmail = null;
  s.awaitingEmailConfirm = false;
  return await tapAny(s, 'שליחת המייל בוטלה');
}

async function handleReenterEmailAudio(s, q) {
  const recVal = digitsOf(q[s.p]);
  const deadline = Date.now() + 35000;
  try {
    const audio = await download(s.name, deadline, s.d, recVal, s.apiExt);
    del(s.name, s.d);
    const whisperTxt = await transcribeHebrewWhisper(audio, deadline);
    const r = await textGen({
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'audio/wav', data: audio.toString('base64') } },
          { text: `חלץ אך ורק את כתובת המייל התקנית באנגלית מתוך ההקלטה (תמלול עזר: "${whisperTxt}"). החזר אך ורק את כתובת המייל בפורמט user@domain.com ללא שום מילה נוספת.` }
        ]
      }]
    }, deadline, 'minimal');
    const rawOut = ((((r.candidates || [])[0] || {}).content || {}).parts || []).map(p => p.text || '').join(' ');
    const extracted = normalizeSpokenEmailInput(rawOut) || normalizeSpokenEmailInput(whisperTxt);
    if (!extracted) {
      return await tapAny(s, 'לא הצלחתי לזהות כתובת מייל תקינה');
    }
    s.pendingEmail.to = extracted;
    s.pendingEmail.spelled = spellEmailForHebrewSpeech(extracted);
    s.n++;
    return await speakAndReturn(
      s,
      `קלטתי את הכתובת המעודכנת: ${s.pendingEmail.spelled}. לאישור ושליחה הקש 1, לתיקון נוסף הקש 2, או לביטול הקש 0.`,
      deadline,
      'email_confirm',
      ''
    );
  } catch (e) {
    del(s.name, s.d);
    return await tapAny(s, ERR);
  }
}

// ============================================================================
// תפריט מקשי התחבורה הציבורית (1,2,3, 4=מייל HTML, 5=הרחבה והליכה, 8=אוטובוס הבא)
// ============================================================================
async function handleRouteMenuKey(s, q) {
  const d = digitsOf(q[s.p]);
  const routes = s.routeObjects || [];
  const alts = s.routeAlternatives || [];
  const menuReminder = ' לחלופה אחרת הקש 1 עד 3, למייל 4, להרחבה והליכה 5, לאוטובוס הבא 8, לשאלה חדשה 0.';

  const idx = parseInt(d, 10) - 1;
  if (idx >= 0 && idx < alts.length) {
    s.selectedRouteIdx = idx;
    s.n++;
    return await speakAndReturn(s, `חלופה ${idx + 1}: ${alts[idx]}${menuReminder}`, Date.now() + 45000, 'route', 'alt_' + idx);
  }

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
      return await speakAndReturn(s, 'שלחתי את כל המסלולים המעוצבים למייל שלך.' + menuReminder, Date.now() + 30000, 'route', 'emailed');
    } catch (e) {
      return await speakAndReturn(s, 'לא הצלחתי לשלוח את המייל כעת.' + menuReminder, Date.now() + 25000, 'route', '');
    }
  }

  if (d === '5' && routes.length) {
    const sel = routes[s.selectedRouteIdx || 0] || routes[0];
    s.n++;
    return await speakAndReturn(s, `חלופה ${sel.option} — ${sel.walkDetailSpeech}${menuReminder}`, Date.now() + 40000, 'route', 'walk_' + (s.selectedRouteIdx || 0));
  }

  if (d === '8' && s.routeQueryMeta) {
    const nextMs = (s.routeQueryMeta.baseDepMs || Date.now()) + 30 * 60000;
    s.jobT0 = Date.now();
    s.cancelled = false;
    s.statusQueue = [`מחפשת לך אוטובוסים מאוחרים יותר מ${cleanTransitHe(s.routeQueryMeta.origin)}`];
    s.job = (async () => {
      const dl = Date.now() + 55000;
      cleanupReplyFiles(s);
      const res = await runGoogleMapsRoute({
        action_announcement: 'בודקת אוטובוסים מאוחרים יותר',
        origin: s.routeQueryMeta.origin,
        destination: s.routeQueryMeta.destination,
        mode: s.routeQueryMeta.mode,
        departure_time: new Date(nextMs).toISOString()
      }, s, dl);
      if (res.status === 'ok' && res.recommended_spoken_response) {
        s.n++;
        return await speakAndReturn(s, res.recommended_spoken_response, dl, 'route', 'overview');
      }
      return await tapAny(s, 'לא נמצאו נסיעות מאוחרות יותר');
    })().catch(async () => await tapAny(s, ERR));
    return await holdStep(s, q);
  }

  if (d === '9' && s.routeOverviewSpeech) {
    s.n++;
    return await speakAndReturn(s, s.routeOverviewSpeech, Date.now() + 45000, 'route', 'overview');
  }

  s.awaitingRouteChoice = false;
  return await tapAny(s, KB_MORE);
}

async function turnStep(s, q, id, T0) {
  if (s.job) return await holdStep(s, q);

  // סעיף 8: חזרה למשימת רקע שהסתיימה לאחר צנתוק!
  if (s.mode === 'bg_resume_choice') {
    const d = digitsOf(q[s.p]);
    const bgTask = s.pendingCompletedBg;
    s.pendingCompletedBg = null;
    if (d === '1' && bgTask) {
      if (bgTask.originConvId && s.callerMem) {
        const origConv = s.callerMem.conversations.find(c => c.id === bgTask.originConvId);
        if (origConv) {
          s.convId = origConv.id;
          s.h = [];
          for (const t of origConv.turns) {
            s.h.push({ role: 'user', parts: [{ text: t.q }] }, { role: 'model', parts: [{ text: t.a }] });
          }
        }
      }
      s.n++;
      return await speakAndReturn(s, `הנה תוצאת המשימה בנושא ${bgTask.title}: ${bgTask.resultSpeech}. להמשך אותה שיחה הקש 1 להקלטה או 2 להקלדה.`, Date.now() + 55000, 'ans', '');
    }
    return await tapAny(s, s.g, MENU_OPEN);
  }

  if (s.mode === 'confirm_email') return await handleEmailConfirmStep(s, q);
  if (s.mode === 'reenter_email_rec') return await handleReenterEmailAudio(s, q);
  if (s.mode === 'route_choice') return await handleRouteMenuKey(s, q);

  if (s.mode === 'ans') {
    const d = digitsOf(q[s.p]);
    if (d === '1' || d === '2') {
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
    if (d === '9' && HISTORY_EXT) return `go_to_folder=/${HISTORY_EXT}`;
    if (d === '6' && BOOKMARKS_EXT) return `go_to_folder=/${BOOKMARKS_EXT}`;
    return await tapAny(s, MENU, null);
  }
  if (s.mode === 'type') return await kbStep(s, q, id, T0);
  return await runTurn(s, q, id, T0);
}

// ============================================================================
// שלוחת סימניות אישית (/bookmarks ושלוחה 6 — סעיף 15)
// ============================================================================
const bookmarkSessions = {};

async function handleBookmarks(req, res) {
  const q = { ...req.query, ...req.body };
  const ph = phoneOf(q);
  const id = 'bm_' + (ph || '') + '_' + idOf(q);
  res.type('text/plain');

  if (q.hangup === 'yes') {
    if (bookmarkSessions[id]) cleanupReplyFiles(bookmarkSessions[id]);
    delete bookmarkSessions[id];
    return res.send('noop=bye');
  }

  const dummySession = { d: '/' + CHAT_EXT, vc: '' };
  if (!ph) {
    const clip = await sysClip(dummySession, 'שלוחת הסימניות זמינה רק למספר טלפון מזוהה. חוזרת לשיחה', 15000);
    return res.send(`id_list_message=${clip}&go_to_folder=/${CHAT_EXT}`);
  }

  const mem = await loadCallerMemory(ph);
  // אם המתקשר הגיע לכאן בלחיצה על מקש 5 מתוך נגן המדיה האישי (/8/<phone>) — נשמור אוטומטית סימניה ונחזיר לנגן!
  const mainKey = activeCallsByPhone[ph];
  const activeCall = mainKey ? calls[mainKey] : null;
  if (activeCall && activeCall.inMediaPlayer && mem.lastPlayingMedia && !bookmarkSessions[id]) {
    const lp = mem.lastPlayingMedia;
    const elapsedMin = Math.max(0, Math.round((Date.now() - (lp.startedAtMs || Date.now())) / 60000));
    mem.bookmarks = mem.bookmarks || [];
    mem.bookmarks.unshift({
      id: 'bmk_' + Date.now().toString(36),
      title: lp.title,
      audioUrl: lp.audioUrl,
      playerDir: lp.playerDir,
      approxMinute: elapsedMin,
      savedAt: nowIsraelInfo().shortStamp
    });
    mem.bookmarks = mem.bookmarks.slice(0, 25);
    await saveCallerMemoryBg(ph, mem);
    const savedClip = await sysClip(activeCall, `הסימניה עבור ${lp.title} נשמרה בהצלחה. ממשיכה בהשמעה`, 15000);
    return res.send(`id_list_message=${savedClip}&go_to_folder=${lp.playerDir}`);
  }

  let bs = bookmarkSessions[id];
  if (!bs) {
    bs = bookmarkSessions[id] = { d: '/' + CHAT_EXT, vc: mem.vc || '', pace: mem.pace || '', idx: 0, n: 0, p: '', rFiles: [], e: crypto.randomBytes(3).toString('hex') };
  }

  const bms = mem.bookmarks || [];
  if (!bms.length) {
    const clip = await sysClip(bs, 'אין לך עדיין סימניות שמורות. חוזרת לשיחה עם תהילה', 15000);
    delete bookmarkSessions[id];
    return res.send(`id_list_message=${clip}&go_to_folder=/${CHAT_EXT}`);
  }

  const d = bs.p ? digitsOf(q[bs.p]) : '';
  if (bs.p) {
    if (d === '0' || d === '8') {
      cleanupReplyFiles(bs);
      delete bookmarkSessions[id];
      return res.send(`go_to_folder=/${CHAT_EXT}`);
    }
    if (d === '5') bs.idx = (bs.idx + 1) % bms.length;
    else if (d === '6') bs.idx = (bs.idx - 1 + bms.length) % bms.length;
    else if (d === '3') {
      bms.splice(bs.idx, 1);
      await saveCallerMemoryBg(ph, mem);
      if (!bms.length) {
        const clip = await sysClip(bs, 'הסימניה נמחקה ואין סימניות נוספות', 15000);
        delete bookmarkSessions[id];
        return res.send(`id_list_message=${clip}&go_to_folder=/${CHAT_EXT}`);
      }
      if (bs.idx >= bms.length) bs.idx = 0;
    } else if (d === '1') {
      const chosen = bms[bs.idx];
      cleanupReplyFiles(bs);
      delete bookmarkSessions[id];
      if (chosen.playerDir) {
        const clip = await sysClip(bs, `מפעילה את הסימניה: ${chosen.title}`, 15000);
        return res.send(`id_list_message=${clip}&go_to_folder=${chosen.playerDir}`);
      }
    }
  }

  const cur = bms[bs.idx];
  const prompt = `סימניה ${bs.idx + 1} מתוך ${bms.length}: ${cur.title}, נשמרה בדקה ${cur.approxMinute || 0} בתאריך ${cur.savedAt}. להפעלה הקש 1, למחיקה 3, לסימניה הבאה 5, לקודמת 6, לחזרה לשיחה 8 או 0.`;
  bs.n++; bs.p = 'BM' + bs.e + bs.n;
  const built = await ttsUploadChain(bs, prompt, Date.now() + 30000, { voice: VOICE_BY[bs.vc], pace: bs.pace }, 'bm' + bs.e + bs.n);
  bs.rFiles = (built && built.files) || [];
  return res.send('read=' + (built ? built.chain : await sysClip(bs, ERR)) + '=' + bs.p + ',no,1,1,9' + TAP_EMPTY);
}

// ============================================================================
// שלוחת היסטוריה משודרגת עם הקראת כותרי שיחה בקול Gemini (/history ושלוחה 9 — סעיף 9)
// ============================================================================
const histSessions = {};

async function handleHistory(req, res) {
  const q = { ...req.query, ...req.body };
  const ph = phoneOf(q);
  const id = 'h_' + (ph || '') + '_' + idOf(q);
  res.type('text/plain');

  if (q.hangup === 'yes') {
    if (histSessions[id]) cleanupReplyFiles(histSessions[id]);
    delete histSessions[id];
    return res.send('noop=bye');
  }

  if (!ph) {
    const clip = await sysClip({ d: '/' + CHAT_EXT }, 'היסטוריית השיחות זמינה רק למספר טלפון מזוהה', 15000);
    return res.send(`id_list_message=${clip}&go_to_folder=/`);
  }

  let hs = histSessions[id];
  const mem = await loadCallerMemory(ph);
  if (!hs) {
    hs = histSessions[id] = {
      d: '/' + CHAT_EXT, vc: (mem && mem.vc) || '', pace: (mem && mem.pace) || '',
      n: 0, idx: 0, state: 'browse', ph, mem, rFiles: [], e: crypto.randomBytes(3).toString('hex')
    };
  } else {
    hs.mem = mem;
  }

  const convs = (hs.mem && hs.mem.conversations) || [];
  if (!convs.length) {
    const clip = await sysClip(hs, 'אין לך עדיין שיחות שמורות בהיסטוריה. עוברת לשיחה חדשה', 15000);
    delete histSessions[id];
    return res.send(`id_list_message=${clip}&go_to_folder=/${CHAT_EXT}`);
  }

  if (hs.idx >= convs.length) hs.idx = 0;
  const cur = convs[hs.idx];
  const d = hs.p ? digitsOf(q[hs.p]) : '';

  if (hs.state === 'pick_from_titles' && d) {
    hs.state = 'browse';
    const pickedIdx = parseInt(d, 10) - 1;
    if (pickedIdx >= 0 && pickedIdx < Math.min(5, convs.length)) {
      hs.idx = pickedIdx;
    }
  } else if (hs.state === 'confirm_del') {
    hs.state = 'browse';
    if (d === '1') {
      hs.mem.conversations.splice(hs.idx, 1);
      await saveCallerMemoryBg(ph, hs.mem);
      if (!hs.mem.conversations.length) {
        const clip = await sysClip(hs, 'השיחה נמחקה ואין שיחות נוספות', 15000);
        delete histSessions[id];
        return res.send(`id_list_message=${clip}&go_to_folder=/${CHAT_EXT}`);
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
    else if (d === '7') {
      // סעיף 9: הקראת רשימת כותרי השיחות האחרונות לבחירה מהירה!
      cleanupReplyFiles(hs);
      hs.state = 'pick_from_titles';
      const top5 = convs.slice(0, 5).map((c, i) => `לבחירת שיחה ${i + 1}, בנושא ${c.title}, מתאריך ${c.updatedAt}, הקש ${i + 1}.`).join(' ');
      hs.n++; hs.p = 'HT' + hs.e + hs.n;
      const built = await ttsUploadChain(hs, `רשימת כותרי השיחות האחרונות שלך: ${top5}`, Date.now() + 45000, { voice: VOICE_BY[hs.vc], pace: hs.pace }, 'ht' + hs.e + hs.n);
      hs.rFiles = (built && built.files) || [];
      return res.send('read=' + built.chain + '=' + hs.p + ',no,1,1,9' + TAP_EMPTY);
    } else if (d === '3') {
      hs.state = 'confirm_del';
      hs.n++; hs.p = 'HD' + hs.e + hs.n;
      const clip = await sysClip(hs, 'לאישור מחיקת השיחה הקש 1, לביטול הקש 2', 15000);
      return res.send('read=' + clip + '=' + hs.p + ',no,1,1,7' + TAP_EMPTY);
    } else if (d === '1') {
      cleanupReplyFiles(hs);
      const transcriptSpeech = `כותרת השיחה: ${cur.title}. ` +
        cur.turns.map((t, i) => `שאלה ${i + 1}: ${t.q}. תשובת תהילה: ${t.a}.`).join(' ') +
        ' סוף השיחה. להמשך השיחה מאותה נקודה הקש 2, לשליחת התמליל המעוצב למייל הקש 4, לשיחה הבאה הקש 5, ליציאה הקש 0.';
      hs.n++; hs.p = 'HP' + hs.e + hs.n;
      const built = await ttsUploadChain(hs, transcriptSpeech, Date.now() + 55000, { voice: VOICE_BY[hs.vc], pace: hs.pace }, 'hp' + hs.e + hs.n);
      hs.rFiles = (built && built.files) || [];
      return res.send('read=' + built.chain + '=' + hs.p + ',no,1,1,9' + TAP_EMPTY);
    } else if (d === '4') {
      const mdBody = cur.turns.map((t, i) => `### שאלה ${i + 1}: ${t.q}\n${t.a}`).join('\n\n---\n\n');
      let msg = 'תמליל השיחה נשלח בעיצוב מלא למייל שלך.';
      try {
        await sendViaGasEmail({ subject: `תמליל שיחה מקו AI: ${cur.title}`, body: mdBody, files: [], attachHtmlCopy: true }, Date.now() + 25000);
      } catch (e) { msg = 'לא ניתן היה לשלוח את המייל כעת.'; }
      hs.n++; hs.p = 'HM' + hs.e + hs.n;
      const clip = await sysClip(hs, msg + ' להשמעה הקש 1, להמשך השיחה הקש 2, לשיחה הבאה הקש 5, ליציאה 0.', 15000);
      return res.send('read=' + clip + '=' + hs.p + ',no,1,1,8' + TAP_EMPTY);
    } else if (d === '2') {
      const callKey = (ph ? ph + '_' : '') + idOf(q);
      const restoredHistory = [];
      for (const t of cur.turns) {
        restoredHistory.push({ role: 'user', parts: [{ text: t.q }] }, { role: 'model', parts: [{ text: t.a }] });
      }
      const s = calls[callKey] = newSession('/' + CHAT_EXT, EXT_FIRST.sys, EXT_FIRST.g, {
        id: idOf(q), ph, apiExt: '/' + HISTORY_EXT, vc: hs.vc, pace: hs.pace, len: (hs.mem && hs.mem.len) || '',
        callerMem: hs.mem, convId: cur.id, h: restoredHistory, resumedFromHistory: true
      });
      activeCallsByPhone[ph] = callKey;
      s.t = Date.now();
      cleanupReplyFiles(hs);
      delete histSessions[id];
      return res.send(await tapAny(s, `ממשיכים את השיחה בנושא ${cur.title}`, MENU));
    }
  }

  cleanupReplyFiles(hs);
  const active = hs.mem.conversations[hs.idx];
  const promptText = `שיחה ${hs.idx + 1} מתוך ${hs.mem.conversations.length}. כותרת השיחה: ${active.title}, מתאריך ${active.updatedAt}, עם ${active.turns.length} חילופי דברים. להשמעת השיחה הקש 1, להמשך השיחה הקש 2, למחיקה 3, לשליחה למייל 4, לשיחה הבאה 5, לקודמת 6, להקראת רשימת כל הכותרות הקש 7, ליציאה 0.`;
  hs.n++; hs.p = 'HB' + hs.e + hs.n;
  const built = await ttsUploadChain(hs, promptText, Date.now() + 35000, { voice: VOICE_BY[hs.vc], pace: hs.pace }, 'hb' + hs.e + hs.n);
  hs.rFiles = (built && built.files) || [];
  return res.send('read=' + built.chain + '=' + hs.p + ',no,1,1,9' + TAP_EMPTY);
}

// ============================================================================
// נתיבי HTTP, דשבורד סטטוס מעוצב (/status) ובדיקה עצמית (/selftest)
// ============================================================================
app.get('/', (q, r) => r.send('ok'));

app.get('/status', (req, res) => {
  const info = nowIsraelInfo();
  const html = buildRichRtlEmailHtml({
    subject: 'סטטוס מערכת קו AI — תהילה גרסה 4.0.0',
    badgeText: `פעיל באוויר • ${info.humanHe}`,
    bodyText: [
      `## סיכום רכיבי המערכת הפעילים`,
      `- **מודל סוכנת ראשי:** \`${TEXT_MODEL}\` (גיבויים: \`${TEXT_FALLBACK_LIST.join(', ') || 'ללא'}\`)`,
      `- **שרשרת מודלי קול (TTS):** \`${TTS_LIST.join(', ')}\` + גיבוי קול עצבי WAV (0% רובוטיות)`,
      `- **מודלי חשיבה עמוקה ב-Groq:** \`${GROQ_REASONING_MODELS.join(', ')}\``,
      `- **מזהי השמעות מהירות טעונים מדיסק ימות:** **${Object.keys(sysReady).length}** קבצים מוכנים ב-0ms`,
      `- **פודקאסטים ותחנות במאגר הצדדי:** **${CURATED_PODCASTS_AND_RADIO.length}+** תוכניות קבועות + חיפוש חי ב-Apple Podcasts ישראל`,
      `- **שירים וסינגלים שנשאבו למאגר:** **${musicStore.tracks.length}** שירים זמינים להשמעה`,
      `- **שיחות פעילות כרגע:** **${Object.keys(calls).length}** | **משימות רקע רצות:** **${Object.keys(bgTasksByPhone).length}**`
    ].join('\n')
  });
  res.type('text/html').send(html);
});

app.get('/selftest', async (req, res) => {
  const deadline = Date.now() + 38000;
  const checks = {};

  await Promise.all([
    (async () => {
      const t0 = Date.now();
      try {
        const r = await textGen({ contents: [{ role: 'user', parts: [{ text: 'עני במילה אחת: תקין' }] }] }, deadline, 'minimal');
        const txt = ((((r.candidates || [])[0] || {}).content || {}).parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
        checks.gemini_text = { ok: !!txt, models: TEXT_MODELS, latency_ms: Date.now() - t0, sample: txt.slice(0, 30) };
      } catch (e) { checks.gemini_text = { ok: false, error: e.message }; }
    })(),
    (async () => {
      const t0 = Date.now();
      try {
        const wavBuf = await ttsOne('בדיקה', deadline, { voice: VOICE });
        checks.voice_tts_zero_robotic = { ok: wavBuf.length > 200, models: TTS_LIST, cached_fast_clips: Object.keys(sysReady).length, bytes: wavBuf.length, latency_ms: Date.now() - t0 };
      } catch (e) { checks.voice_tts_zero_robotic = { ok: false, error: e.message }; }
    })(),
    (async () => {
      const t0 = Date.now();
      try {
        const [places, routes] = await Promise.all([
          queryGooglePlacesIL('תחנה מרכזית ירושלים', 1, deadline),
          computeRoutesV2Call({ address: 'רבי עקיבא 100 בני ברק' }, { address: 'תחנה מרכזית ירושלים' }, 'TRANSIT', nextMorningIsraelIso(), null, deadline)
        ]);
        checks.google_maps_and_places = { ok: places.length > 0 && routes.routes.length > 0, routes_v2_count: routes.routes.length, latency_ms: Date.now() - t0 };
      } catch (e) { checks.google_maps_and_places = { ok: false, error: e.message }; }
    })(),
    (async () => {
      const t0 = Date.now();
      try {
        const [q1, q2] = await Promise.all([
          singleGroqStaggeredQuery('בירת ישראל', 0, deadline),
          singleGroqStaggeredQuery('מזג אוויר בתל אביב', 1, deadline)
        ]);
        checks.groq_staggered_parallel = {
          ok: !q1.error && !q2.error,
          models_balanced: [q1.model_used, q2.model_used],
          urls_extracted: (q1.urls || []).length + (q2.urls || []).length,
          reasoning_models: GROQ_REASONING_MODELS,
          latency_ms: Date.now() - t0
        };
      } catch (e) { checks.groq_staggered_parallel = { ok: false, error: e.message }; }
    })(),
    (async () => {
      const t0 = Date.now();
      try {
        const r = await http(YM + 'GetIVR2Dir?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent('ivr2:/' + CHAT_EXT), { headers: { 'User-Agent': CRAWLER_UA } }, 8000, deadline);
        const j = await r.json();
        checks.yemot_api = { ok: j.responseStatus === 'OK', chat_ext: '/' + CHAT_EXT, player_ext: '/' + MEDIA_PLAYER_EXT, bookmarks_ext: '/' + BOOKMARKS_EXT, history_ext: '/' + HISTORY_EXT, latency_ms: Date.now() - t0 };
      } catch (e) { checks.yemot_api = { ok: false, error: e.message }; }
    })()
  ]);

  checks.config = {
    version: '4.0.0',
    israel_clock: nowIsraelInfo().humanHe,
    rec_max_sec: Number(REC_MAX),
    kbd_wait_sec: KB_WAIT,
    max_agent_steps: MAX_AGENT_STEPS,
    email_configured: !!(GAS_MAIL_URL && TARGET_EMAIL),
    image_search_configured: !!(SEARCH_KEY && SEARCH_CX),
    music_tracks_cached: musicStore.tracks.length,
    ffmpeg_available: !!FFMPEG
  };

  const allOk = Object.entries(checks).filter(([k]) => k !== 'config').every(([, v]) => v.ok);
  res.status(allOk ? 200 : 207).json({ ok: allOk, checks });
});

app.all('/history', handleHistory);
app.all('/bookmarks', handleBookmarks);

app.all(['/yemot', '/yemot/:e'], async (req, res) => {
  const q = { ...req.query, ...req.body };
  const rawId = idOf(q);
  const ph = phoneOf(q);
  // סעיף 13: מפתח סשן מבודד לחלוטין לפי מספר טלפון מתקשר + מזהה שיחה!
  const callKey = (ph ? ph + '_' : '') + rawId;
  const rawExtDigits = String(q.ApiExtension || '').trim().replace(/^\/+|\/+$/g, '');

  if (BOOKMARKS_EXT && (rawExtDigits === BOOKMARKS_EXT || req.params.e === 'bookmarks')) {
    return handleBookmarks(req, res);
  }
  if (HISTORY_EXT && rawExtDigits === HISTORY_EXT && !req.params.e) {
    const existing = calls[callKey];
    if (!existing || !existing.resumedFromHistory) {
      return handleHistory(req, res);
    }
  }

  res.type('text/plain');
  const T0 = Date.now();
  const ext = EXTS[String(req.params.e || '')] || EXT_FIRST;
  const apiExt = normApiExt(q);
  const targetDir = req.params.e ? ext.d : (apiExt !== null ? apiExt : ('/' + CHAT_EXT));

  try {
    if (q.hangup === 'yes') {
      const old = calls[callKey];
      if (old) cleanupReplyFiles(old);
      if (ph && activeCallsByPhone[ph] === callKey) delete activeCallsByPhone[ph];
      delete calls[callKey];
      return res.send('noop=bye');
    }

    let s = calls[callKey];
    if (!s) {
      const mem = ph ? await loadCallerMemory(ph) : null;
      s = calls[callKey] = newSession(targetDir, ext.sys, ext.g, {
        id: rawId,
        ph,
        apiExt,
        callerMem: mem,
        vc: (mem && mem.vc) || '',
        pace: (mem && mem.pace) || '',
        len: (mem && mem.len) || ''
      });
      if (ph) activeCallsByPhone[ph] = callKey;
    }
    s.t = Date.now();

    // סעיף 15: אם המתקשר חזר כרגע מנגן המדיה האישי (/8/<phone>) בלחיצה על 8 או 0 — נמשיך מיד את השיחה הפתוחה!
    if (s.inMediaPlayer) {
      s.inMediaPlayer = false;
      return res.send(await tapAny(s, 'חזרת לשיחה איתי', MENU));
    }

    if (!s.mode) {
      // סעיף 8: בדיקה האם חיכתה למתקשר משימת רקע שהסתיימה (לאחר צנתוק או חזרה לקו)!
      if (s.callerMem && Array.isArray(s.callerMem.completedBgTasks) && s.callerMem.completedBgTasks.length > 0) {
        const latestBg = s.callerMem.completedBgTasks.shift();
        await saveCallerMemoryBg(ph, s.callerMem);
        s.pendingCompletedBg = latestBg;
        return res.send(await speakAndReturn(
          s,
          `${s.g} סיימתי עבורך ברקע את המשימה בנושא ${latestBg.title}! לשמיעת התוצאה ולהמשך אותה שיחה הקש 1, או לשיחה חדשה הקש 2.`,
          Date.now() + 35000,
          'bg_resume',
          ''
        ));
      }
      return res.send(await tapAny(s, s.g, MENU_OPEN));
    }

    const out = await turnStep(s, q, callKey, T0);
    res.send(out);
  } catch (e) {
    console.error(callKey, 'fatal', e.message);
    if (!res.headersSent) {
      const errRef = fallbackErrClipRef || await sysClip({ d: targetDir }, ERR, 12000, 'sys_err');
      res.send('id_list_message=' + errRef);
    }
  }
});

app.use(async (err, req, res, next) => {
  if (!res.headersSent) {
    const errRef = fallbackErrClipRef || await sysClip({ d: '/' + CHAT_EXT }, ERR, 10000, 'sys_err');
    res.type('text/plain').send('id_list_message=' + errRef);
  }
});

// ============================================================================
// סנכרון חכם ומהיר בעליית השרת (סעיף 2 + סעיף 14):
// מזהה את כל הקבצים שכבר קיימים בימות המשיח (0 קריאות TTS מיותרות!), מנקה קבצים ישנים שהוחלפו,
// ומפעיל שאיבה מחזורית של שירים חדשים ברקע.
// ============================================================================
async function syncAudioRegistryAndCatalogOnBoot() {
  // 1. הפעלת שאיבה ראשונית ומחזורית של שירים חדשים ברקע (כל 30 דקות)
  getMusicCatalog(true).catch(() => {});
  setInterval(() => getMusicCatalog(true).catch(() => {}), 30 * 60000).unref();

  if (!TTS_KEYS.length || !TOKEN) return;

  // 2. טעינת אינדקס השמע השמור בימות המשיח + בדיקת הקבצים שקיימים בפועל בשלוחות
  let savedEntries = {};
  if (REGISTRY_PATH) {
    try {
      const u = YM + 'GetTextFile?token=' + encodeURIComponent(TOKEN) + '&what=' + encodeURIComponent(REGISTRY_PATH);
      const r = await fetch(u, { headers: { 'User-Agent': CRAWLER_UA }, signal: AbortSignal.timeout(7000) });
      const j = await r.json().catch(() => ({}));
      if (j.responseStatus === 'OK' && j.contents) {
        const parsed = JSON.parse(j.contents);
        savedEntries = parsed.entries || {};
      }
    } catch (e) {}
  }

  const dirs = uniqueList(['/' + CHAT_EXT, EXT_FIRST.d]);
  const diskMap = {};
  for (const d of dirs) {
    diskMap[d] = await listYemotWavSet(d);
    for (const wavName of diskMap[d]) {
      if (wavName.startsWith('sp')) {
        sysReady[d + '/' + wavName] = true;
      }
    }
  }

  for (const [k, meta] of Object.entries(savedEntries)) {
    if (meta && meta.dir && meta.name && diskMap[meta.dir] && diskMap[meta.dir].has(meta.name)) {
      sysRegistry[k] = meta;
      sysReady[k] = true;
    }
  }

  // 3. בדיקת 8 הודעות הליבה בשלוחה הראשית: אם קובץ כבר קיים בדיסק — מדלגים עליו ב-0ms!
  //    אם חסר (רק אחרי עדכון טקסט) — יוצרים במרווח רגוע של 6.5 שניות כדי לעולם לא לחנוק מכסת RPM!
  const mainDir = '/' + CHAT_EXT;
  const greet = (Object.values(EXTS).find(e => e.d === mainDir) || EXT_FIRST).g;
  const corePrompts = [
    { id: 'sys_open', text: greet + '. ' + MENU_OPEN },
    { id: 'sys_menu', text: MENU },
    { id: 'sys_rec', text: 'דבר אחרי הצליל' },
    { id: 'sys_ack', text: 'קיבלתי, רגע אחד' },
    { id: 'sys_wait', text: 'עוד רגע' },
    { id: 'sys_kb', text: KB_START },
    { id: 'sys_more', text: KB_MORE + '. ' + MENU },
    { id: 'sys_err', text: ERR + '. ' + MENU }
  ];

  const activeCoreHashes = new Set(corePrompts.map(p => clipHashName(VOICE, p.text)));

  // מחיקת קבצי מערכת ישנים שהוחלפו בעדכון קוד (שמירה על ניקיון השלוחה)
  for (const [k, meta] of Object.entries(sysRegistry)) {
    if (meta.dir === mainDir && meta.semanticId && meta.semanticId.startsWith('sys_') && !activeCoreHashes.has(meta.name)) {
      del(meta.name, mainDir);
      delete sysReady[k];
      delete sysRegistry[k];
      registryDirty = true;
    }
  }

  let reusedCount = 0, createdCount = 0;
  for (const item of corePrompts) {
    const hName = clipHashName(VOICE, item.text);
    const key = mainDir + '/' + hName;
    if (sysReady[key]) {
      reusedCount++;
      if (item.id === 'sys_err') fallbackErrClipRef = 'f-' + mainDir + '/' + hName;
      if (!sysRegistry[key]) {
        sysRegistry[key] = { name: hName, dir: mainDir, text: item.text, voice: VOICE, semanticId: item.id, updatedAt: Date.now() };
        registryDirty = true;
      }
      continue;
    }
    await sysClip({ d: mainDir }, item.text, 20000, item.id);
    createdCount++;
    await sleep(6500);
  }

  await persistAudioRegistry();
  console.log(`Audio Registry synced: ${reusedCount} reused instantly from Yemot disk, ${createdCount} newly generated.`);
}

if (require.main === module) {
  app.listen(process.env.PORT || 3000, () => {
    console.log('kav-ai-agentic v4.0.0 up');
    setTimeout(() => syncAudioRegistryAndCatalogOnBoot().catch(e => console.error('Boot sync error:', e.message)), 1000);
  });
}

module.exports = {
  app,
  cleanTransitHe,
  cleanStopName,
  naturalDurationHe,
  naturalDistanceHe,
  parseIsraelTimeInput,
  buildPolishedRouteV2,
  finalizeTopRoutes,
  buildInitialTransitSpeech,
  extractUrlsFromGroqMessage
};
