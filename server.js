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

// --- מפתחות והגדרות בסיס ---
const keyList = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const KEYS = keyList(process.env.GEMINI_API_KEYS);
const TTS_KEYS = keyList(process.env.GEMINI_TTS_KEYS);
const GROQ_KEYS = keyList(process.env.GROQ_API_KEYS);
const MAPS_KEY = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();

const GROQ_BASE = process.env.GROQ_BASE || 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = process.env.GROQ_SEARCH_MODEL || 'openai/gpt-oss-120b';
const TEXT_MODEL = String(process.env.TEXT_MODEL || '').trim() || 'gemini-2.5-flash';
const TEXT_FALLBACK_RAW = String(process.env.TEXT_MODEL_FALLBACK || '').trim() || 'gemini-2.5-flash-lite';
const TEXT_FALLBACK = TEXT_FALLBACK_RAW === 'none' || TEXT_FALLBACK_RAW === TEXT_MODEL ? '' : TEXT_FALLBACK_RAW;
const IMAGE_MODEL = String(process.env.IMAGE_MODEL || '').trim() || 'imagen-3.0-fast-generate-001';
const TTS_LIST = String(process.env.TTS_MODEL || 'gemini-2.5-flash-preview-tts').split(',').map(x => x.trim()).filter(Boolean);

const VOICE = process.env.VOICE || 'Kore';
const EXT = (process.env.EXT_PATH || '1').replace(/^\/+|\/+$/g, '') || '1';
const TOKEN = process.env.YEMOT_TOKEN ||
  (process.env.YEMOT_API_USERNAME && process.env.YEMOT_API_PASSWORD ? process.env.YEMOT_API_USERNAME + ':' + process.env.YEMOT_API_PASSWORD : '');

const YM = process.env.YEMOT_BASE || 'https://www.call2all.co.il/ym/api/';
const GBASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta/models/';
const BUDGET = Number(process.env.TURN_BUDGET_MS) || 85000;
const REC_MAX = String(parseInt(process.env.REC_MAX, 10) || 30);

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
let RADIO_FEEDS = [];
try {
  const rawFeeds = String(process.env.RADIO_FEEDS || '[]').trim().replace(/^'+|'+$/g, '');
  RADIO_FEEDS = JSON.parse(rawFeeds);
} catch (e) {
  RADIO_FEEDS = [];
}
RADIO_FEEDS = (Array.isArray(RADIO_FEEDS) ? RADIO_FEEDS : [])
  .map(f => {
    if (!f || !f.n) return null;
    let u = String(f.u || '').trim();
    const mdMatch = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(u);
    if (mdMatch) u = mdMatch[2];
    return /^https?:\/\//i.test(u) ? { n: String(f.n).trim(), u } : null;
  })
  .filter(Boolean);

const LIVE_STREAM_EXT = String(process.env.LIVE_STREAM_EXT || '').replace(/^\/+|\/+$/g, '');

// --- פונקציות עזר ---
const sp = s => String(s).replace(/[.\-"'&|,=*#\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isBudget = e => !!(e && e.budget);
const rot = { text: 0, tts: 0 };
const RETRY_STATUS = [429, 500, 502, 503, 504];
const calls = {};

setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(calls)) if (now - calls[id].t > 3600000) delete calls[id];
}, 600000).unref();

async function http(url, opt, ms, deadline) {
  const left = deadline ? deadline - Date.now() : ms;
  if (left < 800) { const e = new Error('turn budget exhausted'); e.budget = true; throw e; }
  return fetch(url, { ...opt, signal: AbortSignal.timeout(Math.min(ms, left)) });
}

function pushStatus(s, text) {
  if (!s || !text) return;
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) return;
  s.statusQueue = s.statusQueue || [];
  s.statusQueue.push(clean);
  if (s.onStatus) { const fn = s.onStatus; s.onStatus = null; fn(); }
}

// --- הנחיית המערכת הסוכנותית ---
const VOICE_CTL = ' אם המשתמש מבקש לשנות את הקול, את קצב הדיבור או את אורך התשובות, התחל את התשובה בתג מתאים ואחריו אשר בקצרה: [[VOICE:male]] לקול גברי, [[VOICE:female]] לקול נשי, [[VOICE:default]] לקול רגיל, [[PACE:slow]] לאט, [[PACE:fast]] מהר, [[PACE:normal]] רגיל, [[LEN:short]] לתשובות קצרות, [[LEN:long]] לתשובות מפורטות.';
const TRANSCRIBE_HINT = ' אם השאלה הגיעה כהקלטה קולית, התחל את התשובה בתג [[Q:תמלול מדויק של השאלה במילים]] ואחריו התשובה עצמה.';
const MAXW = Math.min(3000, Math.max(200, parseInt(process.env.MAX_WORDS, 10) || 700));
const EXTRA = String(process.env.EXTRA_INSTRUCTION || '').replace(/\s+/g, ' ').trim().slice(0, 2000);

const AGENTIC_RULES = `
את סוכנת בינה מלאכותית קולית חכמה וסקסית דוברת עברית בשם תהילה, יעילה, אדיבה ומדויקת בטלפון.
עקרון עבודה סוכנותי:
1. לפני כל הפעלת כלי (Tool), עליך להעביר בשדה action_announcement משפט קצר וברור בעברית שמסביר למתקשר מה אתה הולך לעשות כעת (לדוגמה: "אני בודקת כעת שלוש חלופות מסלול בגוגל מפות", "אני מבצעת כעת חיפוש מעמיק במספר מקורות ברשת", "אני מייצרת כעת את התמונה ושולח אותה למייל שלך").
2. ניווט ותחבורה ציבורית (google_maps_route): חובה להשתמש אך ורק בכלי google_maps_route לכל שאלה על מסלול הגעה, תחבורה ציבורית, קווי אוטובוס, רכבת, זמני נסיעה או הוראות הגעה. לעולם אל תשתמש בחיפוש ברשת (web_search_parallel) עבור מסלולי הגעה! העבר מוצא ויעד ברורים בישראל (כולל שם עיר). הכלי שומר אוטומטית עד 3 חלופות מסלול. לאחר שהכלי חוזר, אל תקריא את המסלולים המלאים! במקום זאת, תן תקציר של משפט אחד לכל חלופה (איזה קו וזמן כולל) וסיים במשפט: "הבאתי שלוש חלופות, הקש 1 לשמיעת החלופה הראשונה, 2 לשנייה, או 3 לשלישית".
3. חיפוש ברשת (web_search_parallel): כאשר נדרש מידע עדכני, חדשות, בדיקת עובדות או מחקר (שאינם ניווט), הפעל את כלי החיפוש המקבילי עם מערך של 5 עד 8 שאילתות חיפוש שונות וממוקדות שירוצו בו זמנית. מזג את כל התוצאות לתשובה אחת קוהרנטית ומלאה בלי להקריא כתובות אינטרנט.
4. רדיו וחדשות RSS (play_rss_radio): כאשר מבקשים לשמוע רדיו, חדשות או שידור מפיד RSS, הפעל את הכלי. אם המשתמש ביקש שידור חי רציף (stream) והוגדרה שלוחת שידור חי, ציין mode="live".
5. יצירת תמונות (generate_image): כאשר מבקשים לייצר תמונה, הבן מהבקשה את התיאור המפורט (באנגלית עבור המנוע), את הגודל/יחס הגובה-רוחב (ריבוע 1:1, לרוחב 16:9, לאורך 9:16) ואת כמות התמונות (1 עד 4). הפעל את הכלי שישלח אותן אוטומטית למייל דרך סקריפט גוגל.
6. יצירת אודיו (generate_audio): כאשר מבקשים לייצר קטע שמע, קריינות או הקלטה, הפעל את הכלי וקבע האם להשמיע אותו כאן בשיחה, לשלוח למייל, או שניהם.
7. סגנון דיבור: ענה בעברית טבעית, שוטפת ונעימה להאזנה בטלפון, ללא סימנים מיוחדים, כוכביות או קישורים, באורך של עד ${MAXW} מילים.
`.replace(/\s+/g, ' ').trim();

const buildSys = (mode, extra) => AGENTIC_RULES + ' ' +
  (EXTRA ? 'הנחיית מנהל המערכת: ' + EXTRA + ' ' : '') +
  (extra ? 'הנחיית שלוחה: ' + extra + ' ' : '') + VOICE_CTL + TRANSCRIBE_HINT;

// --- תקשורת מול Gemini API ---
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
      err = model + ' ' + r.status + ' ' + (await r.text()).slice(0, 200);
      if (!RETRY_STATUS.includes(r.status)) break;
    } catch (e) {
      if (isBudget(e)) throw e;
      status = 0;
      err = model + ' ' + (e.name === 'TimeoutError' ? 'timeout' : e.message);
    }
    if (i < tries - 1) await sleep(400 * (i + 1));
  }
  const e = new Error(err); e.status = status; throw e;
}

const THINK = ['minimal', 'low', null];
const thinkIdx = {};
const downUntil = {};
async function textGen(body, deadline) {
  const models = TEXT_FALLBACK ? [TEXT_MODEL, TEXT_FALLBACK] : [TEXT_MODEL];
  let lastErr;
  for (let m = 0; m < models.length; m++) {
    const model = models[m];
    const hasNext = m < models.length - 1;
    if (hasNext && (downUntil[model] || 0) > Date.now()) continue;
    for (;;) {
      const lvl = THINK[thinkIdx[model] || 0];
      const gc = { maxOutputTokens: 8192 };
      if (lvl) gc.thinkingConfig = { thinkingLevel: lvl };
      try {
        return await gem(model, { ...body, generationConfig: gc }, deadline, 'text', hasNext ? { retries: 0, ms: 30000 } : { ms: 45000 });
      } catch (e) {
        lastErr = e;
        if (e.status === 400 && /think/i.test(e.message) && (thinkIdx[model] || 0) < THINK.length - 1) { thinkIdx[model] = (thinkIdx[model] || 0) + 1; continue; }
        break;
      }
    }
    if (isBudget(lastErr) || !(RETRY_STATUS.includes(lastErr.status) || lastErr.status === 0)) throw lastErr;
    if (hasNext) downUntil[model] = Date.now() + 120000;
  }
  throw lastErr;
}

// ============================================================================
// כלי 1: ניווט מדויק בגוגל מפות (Routes API v2 + גיבוי Directions Legacy)
// ============================================================================
const MAPS_DECL = {
  name: 'google_maps_route',
  description: 'REQUIRED for all public transit, bus, train, walking, and driving directions in Israel. Fetches up to 3 alternative routes from Google Maps Routes API with line numbers, stop names, departure/arrival times, stop counts, and walking instructions.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Short Hebrew sentence telling the caller you are checking 3 route alternatives on Google Maps' },
      origin: { type: 'STRING', description: 'Starting address, station, or landmark with city in Israel (e.g., "תחנה מרכזית ירושלים")' },
      destination: { type: 'STRING', description: 'Destination address, station, or landmark with city in Israel (e.g., "דיזנגוף סנטר תל אביב")' },
      mode: { type: 'STRING', description: 'transit (default), walking, or driving' },
      departure_time: { type: 'STRING', description: 'Optional: "now" or ISO-8601 / Unix timestamp' }
    },
    required: ['action_announcement', 'origin', 'destination']
  }
};

const stripHtml = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const fmtTimeIL = iso => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch (e) {
    return '';
  }
};

const fmtDurSec = durStr => {
  const sec = parseInt(String(durStr || '').replace(/s$/, ''), 10);
  if (!sec || Number.isNaN(sec)) return '';
  const mins = Math.round(sec / 60);
  if (mins < 60) return `${mins} דקות`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h} שעות ו-${m} דקות` : `${h} שעות`;
};

function formatRouteV2Speech(route, index, originLabel) {
  const leg = (route.legs || [])[0] || {};
  const durText = (route.localizedValues && route.localizedValues.duration && route.localizedValues.duration.text) ||
    (leg.localizedValues && leg.localizedValues.duration && leg.localizedValues.duration.text) ||
    fmtDurSec(route.duration || leg.duration);

  const steps = leg.steps || [];
  let lastArrival = '';
  for (const st of steps) {
    if (st.transitDetails) {
      const sd = st.transitDetails.stopDetails || {};
      const lv = st.transitDetails.localizedValues || {};
      const arr = (lv.arrivalTime && lv.arrivalTime.time && lv.arrivalTime.time.text) || fmtTimeIL(sd.arrivalTime);
      if (arr) lastArrival = arr;
    }
  }

  const lines = [];
  lines.push(`חלופה מספר ${index + 1}: יציאה מ${originLabel}${durText ? ', משך נסיעה כולל ' + durText : ''}${lastArrival ? ', הגעה משוערת בשעה ' + lastArrival : ''}.`);

  const transitLines = [];
  for (const st of steps) {
    if (st.travelMode === 'TRANSIT' && st.transitDetails) {
      const td = st.transitDetails;
      const tl = td.transitLine || {};
      const agency = (tl.agencies && tl.agencies[0]) ? `של חברת ${tl.agencies[0].name}` : '';
      const lineNum = tl.nameShort || tl.name || '';
      if (lineNum) transitLines.push(lineNum);

      const sd = td.stopDetails || {};
      const lv = td.localizedValues || {};
      const depStop = (sd.departureStop && sd.departureStop.name) || '';
      const depTime = (lv.departureTime && lv.departureTime.time && lv.departureTime.time.text) || fmtTimeIL(sd.departureTime);
      const arrStop = (sd.arrivalStop && sd.arrivalStop.name) || '';
      const arrTime = (lv.arrivalTime && lv.arrivalTime.time && lv.arrivalTime.time.text) || fmtTimeIL(sd.arrivalTime);
      const stopsCount = td.stopCount || 0;

      lines.push(`עולים בתחנת ${depStop}, על קו ${lineNum} ${agency} לכיוון ${td.headsign || ''}${depTime ? ', בשעה ' + depTime : ''}.${stopsCount ? ' נוסעים ' + stopsCount + ' תחנות,' : ''} ויורדים בתחנת ${arrStop}${arrTime ? ' בשעה ' + arrTime : ''}.`);
    } else if (st.travelMode === 'WALK') {
      const instr = (st.navigationInstruction && st.navigationInstruction.instructions) || '';
      const dist = (st.localizedValues && st.localizedValues.distance && st.localizedValues.distance.text) || (st.distanceMeters ? `${st.distanceMeters} מטרים` : '');
      if (instr || dist) {
        lines.push(`הליכה רגלית${dist ? ' של ' + dist : ''}${instr ? ': ' + instr : ''}.`);
      }
    } else {
      const instr = (st.navigationInstruction && st.navigationInstruction.instructions) || '';
      const dist = (st.localizedValues && st.localizedValues.distance && st.localizedValues.distance.text) || (st.distanceMeters ? `${st.distanceMeters} מטרים` : '');
      if (instr || dist) {
        lines.push(`${instr}${dist ? ' (' + dist + ')' : ''}.`);
      }
    }
  }

  return {
    fullText: lines.join(' '),
    summary: {
      option: index + 1,
      duration: durText,
      lines: transitLines.join(' ואז קו ') || 'הליכה / רכב',
      arrival: lastArrival
    }
  };
}

function formatRouteLegacySpeech(route, index) {
  const leg = route.legs[0];
  const lines = [];
  lines.push(`חלופה מספר ${index + 1}: יציאה מ${leg.start_address}, משך נסיעה כולל ${leg.duration ? leg.duration.text : ''}, הגעה משוערת בשעה ${leg.arrival_time ? leg.arrival_time.text : ''}.`);

  const transitLines = [];
  for (const st of (leg.steps || [])) {
    if (st.travel_mode === 'TRANSIT' && st.transit_details) {
      const td = st.transit_details;
      const line = td.line || {};
      const agency = (line.agencies && line.agencies[0]) ? `של חברת ${line.agencies[0].name}` : '';
      const lineNum = line.short_name || line.name || '';
      if (lineNum) transitLines.push(lineNum);
      const depStop = td.departure_stop ? td.departure_stop.name : '';
      const depTime = td.departure_time ? td.departure_time.text : '';
      const arrStop = td.arrival_stop ? td.arrival_stop.name : '';
      const arrTime = td.arrival_time ? td.arrival_time.text : '';
      const stopsCount = td.num_stops || 0;

      lines.push(`עולים בתחנת ${depStop}, על קו ${lineNum} ${agency} לכיוון ${td.headsign || ''}, בשעה ${depTime}. נוסעים ${stopsCount} תחנות, ויורדים בתחנת ${arrStop} בשעה ${arrTime}.`);
    } else if (st.travel_mode === 'WALKING') {
      const mainWalk = stripHtml(st.html_instructions);
      const dist = st.distance ? st.distance.text : '';
      lines.push(`הליכה רגלית של ${dist}: ${mainWalk}.`);
    } else {
      lines.push(`${stripHtml(st.html_instructions)} (${st.distance ? st.distance.text : ''}).`);
    }
  }
  return {
    fullText: lines.join(' '),
    summary: {
      option: index + 1,
      duration: leg.duration ? leg.duration.text : '',
      lines: transitLines.join(' ואז קו ') || 'הליכה / רכב',
      arrival: leg.arrival_time ? leg.arrival_time.text : ''
    }
  };
}

async function runGoogleMapsRoute(args, s, deadline) {
  if (!MAPS_KEY) return { error: 'GOOGLE_MAPS_API_KEY is not configured on the server' };

  const modeMap = { transit: 'TRANSIT', walking: 'WALK', driving: 'DRIVE', bicycling: 'BICYCLE' };
  const travelMode = modeMap[String(args.mode || 'transit').toLowerCase()] || 'TRANSIT';

  const body = {
    origin: { address: String(args.origin).trim() },
    destination: { address: String(args.destination).trim() },
    travelMode,
    computeAlternativeRoutes: true,
    languageCode: 'he',
    regionCode: 'IL',
    units: 'METRIC'
  };

  if (args.departure_time && args.departure_time !== 'now') {
    const ts = Number(args.departure_time);
    body.departureTime = !Number.isNaN(ts) ? new Date(ts * 1000).toISOString() : String(args.departure_time);
  }

  let v2Err = '';
  try {
    const r = await http('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': MAPS_KEY,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.localizedValues,routes.legs.duration,routes.legs.localizedValues,routes.legs.steps.travelMode,routes.legs.steps.distanceMeters,routes.legs.steps.localizedValues,routes.legs.steps.navigationInstruction,routes.legs.steps.transitDetails'
      },
      body: JSON.stringify(body)
    }, 15000, deadline);

    const j = await r.json();
    if (r.ok && j.routes && j.routes.length > 0) {
      const top3 = j.routes.slice(0, 3).map((rt, idx) => formatRouteV2Speech(rt, idx, args.origin));
      s.routeAlternatives = top3.map(x => x.fullText);
      s.awaitingRouteChoice = true;
      return {
        total_alternatives: top3.length,
        brief_summary: top3.map(x => x.summary),
        instruction_to_model: `Present a very short 1-line summary of each of the ${top3.length} alternatives and ask the caller to press 1, 2, or 3 to hear the full step-by-step route.`
      };
    }
    v2Err = (j.error && j.error.message) ? j.error.message : ('HTTP ' + r.status);
    console.error('Routes API v2 response:', v2Err);
  } catch (e) {
    if (isBudget(e)) throw e;
    v2Err = e.message;
    console.error('Routes API v2 exception:', v2Err);
  }

  // גיבוי לממשק Legacy Directions אם מופעל בפרויקט
  const u = new URL('https://maps.googleapis.com/maps/api/directions/json');
  u.searchParams.set('origin', args.origin);
  u.searchParams.set('destination', args.destination);
  u.searchParams.set('mode', args.mode || 'transit');
  u.searchParams.set('alternatives', 'true');
  u.searchParams.set('language', 'he');
  u.searchParams.set('region', 'il');
  u.searchParams.set('departure_time', 'now');
  u.searchParams.set('key', MAPS_KEY);

  const r2 = await http(u.toString(), {}, 15000, deadline);
  const j2 = await r2.json();
  if (j2.status === 'OK' && j2.routes && j2.routes.length > 0) {
    const top3 = j2.routes.slice(0, 3).map((rt, idx) => formatRouteLegacySpeech(rt, idx));
    s.routeAlternatives = top3.map(x => x.fullText);
    s.awaitingRouteChoice = true;
    return {
      total_alternatives: top3.length,
      brief_summary: top3.map(x => x.summary),
      instruction_to_model: `Present a very short 1-line summary of each of the ${top3.length} alternatives and ask the caller to press 1, 2, or 3 to hear the full step-by-step route.`
    };
  }

  return {
    error: `שגיאה מגוגל מפות: ${v2Err || j2.status}. ודא שב-Google Cloud Console מופעל Routes API עבור מפתח ה-API.`
  };
}

// ============================================================================
// כלי 2: חיפוש רשת מקבילי ב-Groq (5 עד 8 שאילתות בו-זמנית)
// ============================================================================
const PARALLEL_SEARCH_DECL = {
  name: 'web_search_parallel',
  description: 'Execute 5 to 8 parallel web search queries simultaneously via Groq for general news, facts, and research (DO NOT use for transit/navigation routes).',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Short Hebrew sentence telling the caller you are performing a deep parallel web search' },
      queries: {
        type: 'ARRAY',
        items: { type: 'STRING' },
        description: 'Between 5 and 8 distinct, targeted search queries to execute concurrently'
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
          { role: 'system', content: 'Search the web and return precise factual findings in 60-90 words. Plain text only, no links, no markdown.' },
          { role: 'user', content: query }
        ],
        tools: [{ type: 'browser_search' }],
        tool_choice: 'required',
        reasoning_effort: 'low',
        max_completion_tokens: 700,
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

async function runParallelGroqSearch(queries, deadline) {
  const list = (Array.isArray(queries) ? queries : []).map(q => String(q).trim()).filter(Boolean).slice(0, 8);
  if (!list.length) return { error: 'No queries provided' };
  const results = await Promise.all(list.map(q => singleGroqQuery(q, deadline)));
  return { executed_count: results.length, findings: results };
}

// ============================================================================
// כלי 3: השמעת רדיו רציפה על פי RSS פעילים (או העברה לשלוחת שידור חי)
// ============================================================================
const RSS_RADIO_DECL = {
  name: 'play_rss_radio',
  description: 'Fetch and play continuous audio episodes or news bulletins from active RSS radio feeds, or transfer to live stream extension if requested.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Short Hebrew sentence telling the caller you are loading the radio broadcast' },
      station_name: { type: 'STRING', description: 'Name or keyword of the radio station/feed, or empty for the first available feed' },
      rss_url: { type: 'STRING', description: 'Optional direct RSS feed URL if known' },
      mode: { type: 'STRING', description: '"rss" (default - plays latest episodes continuously) or "live" (transfers to Yemot live stream extension)' }
    },
    required: ['action_announcement']
  }
};

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

async function prepareRssRadio(args, s, deadline) {
  if (args.mode === 'live' && LIVE_STREAM_EXT) {
    s.transferToExt = '/' + LIVE_STREAM_EXT;
    return { status: 'transferring_to_live_stream', extension: LIVE_STREAM_EXT };
  }

  let feedUrl = String(args.rss_url || '').trim();
  if (!feedUrl && RADIO_FEEDS.length) {
    const qName = String(args.station_name || '').trim();
    const found = qName ? RADIO_FEEDS.find(f => f.n.includes(qName) || qName.includes(f.n)) : RADIO_FEEDS[0];
    feedUrl = (found || RADIO_FEEDS[0]).u;
  }
  if (!feedUrl) throw new Error('לא הוגדרו תחנות רדיו ב-RADIO_FEEDS');

  const r = await http(feedUrl, { headers: { 'User-Agent': 'KavAI-Radio/2.5' } }, 12000, deadline);
  if (!r.ok) throw new Error('שגיאה בטעינת פיד RSS: ' + r.status);
  const xmlText = await r.text();
  const parsed = xmlParser.parse(xmlText);
  const items = (((parsed.rss || {}).channel || {}).item) || [];
  const list = Array.isArray(items) ? items : [items];

  const audioUrls = [];
  const titles = [];
  for (const it of list.slice(0, 6)) {
    if (!it) continue;
    const enc = it.enclosure;
    const url = enc ? (Array.isArray(enc) ? enc[0]['@_url'] : enc['@_url']) : '';
    if (url && /^https?:\/\//i.test(url)) {
      audioUrls.push(url);
      titles.push(String(it.title || '').trim());
    }
  }
  if (!audioUrls.length) throw new Error('לא נמצאו קבצי שמע פעילים בפיד ה-RSS');

  const files = [];
  for (let i = 0; i < Math.min(3, audioUrls.length); i++) {
    try {
      const res = await prepareMedia({ n: titles[i] || 'רדיו', u: audioUrls[i] }, s.d, deadline);
      if (res && res.name) files.push('f-' + s.d + '/' + res.name);
    } catch (e) {
      console.error('RSS item prep failed:', e.message);
    }
  }
  if (!files.length) throw new Error('המרת שידור הרדיו נכשלה');
  return { chain: files.join('.'), titles: titles.slice(0, files.length) };
}

// ============================================================================
// כלי 4: יצירת תמונה ושליחה דרך Google Apps Script
// ============================================================================
const GEN_IMAGE_DECL = {
  name: 'generate_image',
  description: 'Generate AI images with specific aspect ratio/size and count (1-4), and email them via Google Apps Script.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Short Hebrew sentence telling the caller you are generating the images and sending them to email' },
      prompt: { type: 'STRING', description: 'Detailed image generation prompt in English' },
      aspect_ratio: { type: 'STRING', description: 'Image size/ratio: "1:1" (square), "16:9" (landscape/wide), "9:16" (portrait/tall), "4:3", or "3:4"' },
      count: { type: 'INTEGER', description: 'Number of images to generate, between 1 and 4' }
    },
    required: ['action_announcement', 'prompt']
  }
};

async function runGenerateImage(args, deadline) {
  if (!KEYS.length) return { error: 'GEMINI_API_KEYS missing' };

  const count = Math.min(4, Math.max(1, parseInt(args.count, 10) || 1));
  const validRatios = ['1:1', '16:9', '9:16', '4:3', '3:4'];
  const aspectRatio = validRatios.includes(args.aspect_ratio) ? args.aspect_ratio : '1:1';
  const key = KEYS[rot.text++ % KEYS.length];

  const r = await http(GBASE + IMAGE_MODEL + ':predict', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      instances: [{ prompt: String(args.prompt).slice(0, 1000) }],
      parameters: { sampleCount: count, aspectRatio }
    })
  }, 45000, deadline);

  if (!r.ok) {
    const errTxt = await r.text();
    throw new Error('שגיאה ביצירת תמונה: ' + r.status + ' ' + errTxt.slice(0, 150));
  }
  const j = await r.json();
  const preds = j.predictions || [];
  if (!preds.length) throw new Error('לא התקבלו תמונות מהמודל');

  const files = preds.map((p, idx) => ({
    filename: `generated_image_${idx + 1}.png`,
    base64: p.bytesBase64Encoded,
    mimeType: p.mimeType || 'image/png'
  }));

  await sendViaGasEmail({
    subject: `התמונות שיצרת מוכנות (${files.length} תמונות, יחס ${aspectRatio})`,
    body: `שלום,\nמצורפות ${files.length} תמונות שנוצרו לפי הבקשה שלך:\n"${args.prompt}"\nגודל/יחס: ${aspectRatio}`,
    files
  }, deadline);

  return { status: 'success', sent_to: TARGET_EMAIL, count: files.length, aspect_ratio: aspectRatio };
}

// ============================================================================
// כלי 5: יצירת אודיו והשמעתו בקו או שליחתו למייל דרך Google Apps Script
// ============================================================================
const GEN_AUDIO_DECL = {
  name: 'generate_audio',
  description: 'Generate custom spoken audio/narration from text, and either play it on the phone call, send it to the pre-configured email via Google Apps Script, or both.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action_announcement: { type: 'STRING', description: 'Short Hebrew sentence telling the caller you are generating the audio' },
      script_text: { type: 'STRING', description: 'The exact Hebrew text to synthesize into high-quality audio' },
      delivery: { type: 'STRING', description: '"play" (play on phone), "email" (send to email), or "both"' },
      voice_gender: { type: 'STRING', description: '"male" or "female"' },
      title: { type: 'STRING', description: 'Short title for the audio file' }
    },
    required: ['action_announcement', 'script_text', 'delivery']
  }
};

async function runGenerateAudio(args, s, deadline) {
  const voice = args.voice_gender === 'male' ? (process.env.VOICE_MALE || 'Charon') : (process.env.VOICE_FEMALE || 'Kore');
  const wavBuf = await tts(String(args.script_text).slice(0, 4000), deadline, { voice });
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

// --- עיבוד מדיה והעלאה לימות ---
const mediaDone = {};
async function prepareMedia(m, d, dl0) {
  const name = 'mf' + crypto.createHash('sha1').update(m.u).digest('hex').slice(0, 12);
  const key = d + '/' + name;
  if (mediaDone[key]) return { name };
  const dl = dl0 || Date.now() + 90000;
  const tmp = path.join(os.tmpdir(), name + '-' + crypto.randomBytes(3).toString('hex'));
  try {
    const r = await http(m.u, { redirect: 'follow' }, 45000, dl);
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

// --- לולאת הסוכן (Agentic Execution Loop) ---
async function askModel(sys, contents, deadline, s) {
  const base = { systemInstruction: { parts: [{ text: sys }] } };
  const decls = [PARALLEL_SEARCH_DECL, RSS_RADIO_DECL, GEN_IMAGE_DECL, GEN_AUDIO_DECL];
  if (MAPS_KEY) decls.push(MAPS_DECL);

  const tools = [{ functionDeclarations: decls }];
  for (let i = 0; i < 4; i++) {
    const a = await textGen({ ...base, contents, tools }, deadline);
    const cand = (a.candidates || [])[0] || {};
    const fcalls = ((cand.content || {}).parts || []).filter(p => p.functionCall);
    if (!fcalls.length) return a;

    const firstAnnounce = fcalls.map(c => (c.functionCall.args || {}).action_announcement).find(Boolean);
    if (firstAnnounce) pushStatus(s, firstAnnounce);

    const resp = await Promise.all(fcalls.map(async c => {
      const args = c.functionCall.args || {};
      const fname = c.functionCall.name;
      let out;
      try {
        if (fname === 'google_maps_route') {
          out = await runGoogleMapsRoute(args, s, deadline);
        } else if (fname === 'web_search_parallel') {
          out = await runParallelGroqSearch(args.queries, deadline);
        } else if (fname === 'play_rss_radio') {
          const rad = await prepareRssRadio(args, s, deadline);
          if (rad.chain) s.extraPlayChain = (s.extraPlayChain ? s.extraPlayChain + '.' : '') + rad.chain;
          out = rad;
        } else if (fname === 'generate_image') {
          out = await runGenerateImage(args, deadline);
        } else if (fname === 'generate_audio') {
          out = await runGenerateAudio(args, s, deadline);
        } else {
          out = { error: 'Unknown tool' };
        }
      } catch (err) {
        console.error('Tool error', fname, err.message);
        out = { error: err.message };
      }
      return { functionResponse: { name: fname, response: out } };
    }));

    contents = [...contents, cand.content, { role: 'user', parts: resp }];
  }
  return textGen({ ...base, contents }, deadline);
}

// --- מנוע TTS (הקראה קולית) ---
function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const isNewTts = m => /^gemini-(3\.[8-9]|[4-9])/.test(m);
const voicesFor = (model, name) => isNewTts(model)
  ? [{ voice: name }, { prebuiltVoiceConfig: { voiceName: name } }]
  : [{ prebuiltVoiceConfig: { voiceName: name } }, { voice: name }];
const vIdx = {};
const ttsDown = {};
const VOICE_BY = { male: process.env.VOICE_MALE || 'Charon', female: process.env.VOICE_FEMALE || process.env.VOICE || 'Kore' };
const SHORT_NOTE = ' הנחיה מהמשתמש: ענה בקצרה, בשניים עד ארבעה משפטים ועד חמישים מילים.';
const PACE_PREFIX = { slow: 'Say slowly and calmly: ', fast: 'Say quickly: ' };

const SHORT_RE = /^\s*(?:ת?קצר(?:י)? את התשוב(?:ה|ות)|תענה(?: יותר)? קצר|תענה בקצרה|בקצרה|בקיצור)\s*/;
const LONG_RE = /^\s*(?:תפרט|תרחיב|תאריך את התשוב(?:ה|ות)|תענה(?: יותר)? בהרחבה)\s*/;

function parseCtl(text) {
  const ctl = {};
  let q = '';
  const noQ = text.replace(/\[\[\s*Q\s*:([^\]]*)\]\]/gi, (m, v) => { if (!q) q = v.replace(/\s+/g, ' ').trim(); return ' '; });
  const clean = noQ.replace(/\[\[\s*(VOICE|PACE|LEN)\s*:\s*([a-z]+)\s*\]\]/gi, (m, k, v) => { ctl[k.toLowerCase()] = v.toLowerCase(); return ' '; });
  return { text: clean.replace(/\s+/g, ' ').trim(), ctl, q: q.slice(0, 500) };
}

const TTS_CHUNK = 900;
function splitText(text) {
  const out = [];
  let cur = '';
  for (let sn of text.split(/(?<=[.!?:;])\s+/)) {
    while (sn.length > TTS_CHUNK) {
      let k = sn.lastIndexOf(' ', TTS_CHUNK);
      if (k < 200) k = TTS_CHUNK;
      if (cur) { out.push(cur); cur = ''; }
      out.push(sn.slice(0, k).trim());
      sn = sn.slice(k).trim();
    }
    if (!sn) continue;
    if (cur && cur.length + sn.length + 1 > TTS_CHUNK) { out.push(cur); cur = sn; }
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
async function tts(text, deadline, o) {
  const parts = splitText(String(text).slice(0, 7000));
  if (parts.length <= 1) return ttsOne(text, deadline, o);
  const bufs = await Promise.all(parts.map(x => ttsOne(x, deadline, o)));
  const gap = Buffer.alloc(3200);
  const pcms = [];
  bufs.forEach((b, i) => { if (i) pcms.push(gap); pcms.push(to8k(pcmOf(b)).pcm); });
  return wav(Buffer.concat(pcms), 8000);
}

async function ttsOne(text, deadline, o) {
  o = o || {};
  const pre = PACE_PREFIX[o.pace] || '';
  let last = new Error('no audio from tts');
  if (TTS_LIST.every(m => (ttsDown[m] || 0) > Date.now())) { last = new Error('all tts models are out of quota'); last.status = 429; throw last; }
  for (let mi = 0; mi < TTS_LIST.length; mi++) {
    const model = TTS_LIST[mi];
    const hasNext = mi < TTS_LIST.length - 1;
    if ((ttsDown[model] || 0) > Date.now()) continue;
    const V = voicesFor(model, o.voice || VOICE);
    for (let i = 0; i < 3; i++) {
      try {
        const t = await gem(model, {
          contents: [{ role: 'user', parts: [{ text: pre + text.slice(0, 3000) }] }],
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: V[vIdx[model] || 0] } }
        }, deadline, 'tts', hasNext ? { ms: 50000, retries: 0 } : { ms: 50000 });
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
        if (e.status === 400 && /voice|speech/i.test(e.message) && (vIdx[model] || 0) < V.length - 1) { vIdx[model] = (vIdx[model] || 0) + 1; continue; }
        if (e.status === 429 || e.status === 404 || e.status >= 500) break;
      }
    }
    if (hasNext || last.status === 429) ttsDown[model] = Date.now() + (last.status === 429 ? 600000 : 120000);
  }
  throw last;
}

// --- פעולות קבצים מול API ימות המשיח ---
const EXTP = '/' + EXT;
const yp = (name, d) => 'ivr2:' + (d === undefined ? EXTP : d) + '/' + name + (/\.[a-z0-9]+$/.test(name) ? '' : '.wav');

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
    await sleep(i === 0 ? 450 : 650);
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
  const path = yp(name, d);
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
        url += '?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent(path) + '&convertAudio=1';
      } else {
        f.append('token', TOKEN); f.append('path', path); f.append('convertAudio', '1');
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
  throw new Error('upload failed (' + path + ') ' + last);
}

function del(name, d) {
  fetch(YM + 'FileAction?token=' + encodeURIComponent(TOKEN) + '&action=delete&what=' + encodeURIComponent(yp(name, d)), { signal: AbortSignal.timeout(8000) }).catch(() => {});
}

// --- מטמון הודעות מערכת בקול הנשי הצעיר והרענן (Kore) ---
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
      const dl = Date.now() + (timeoutMs || 12000);
      const pcm = await tts(cleanText, dl, { voice });
      await upload(name, pcm, dl, dir, timeoutMs || 10000);
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

// --- ניהול שיחות ותפריטים בימות המשיח ---
let CFG = [];
try { CFG = JSON.parse(process.env.EXTENSIONS || '[]'); } catch (e) { CFG = []; }
if (!Array.isArray(CFG) || !CFG.length) CFG = [{ p: EXT, m: '2', x: '', g: process.env.GREETING || '' }];

const DEFAULT_GREET = 'היי, כאן תהילה.';
const EXTS = {};
for (const c of CFG) {
  const p = String(c.p || '').replace(/^\/+|\/+$/g, '');
  if (!/^[0-9]+(\/[0-9]+)*$/.test(p)) continue;
  EXTS[p.replace(/\//g, '_')] = {
    p, d: '/' + p,
    sys: buildSys(c.m, String(c.x || '').replace(/\s+/g, ' ').trim().slice(0, 1000)),
    g: String(c.g || '').trim().slice(0, 300) || DEFAULT_GREET
  };
}
const EXT_FIRST = EXTS[Object.keys(EXTS)[0]] || { p: EXT, d: '/' + EXT, sys: buildSys('2', ''), g: DEFAULT_GREET };
const AGAIN = 'לא שמעתי טוב, דבר שוב';
const ERR = 'תקלה קטנה, ננסה עוד פעם';

const idOf = q => String(q.ApiCallId || 'x').replace(/[^a-zA-Z0-9]/g, '').slice(-24) || 'x';
const phoneOf = q => { const p = String(q.ApiPhone || '').replace(/\D/g, ''); return p.length >= 7 && p.length <= 15 ? p : ''; };
const normApiExt = q => {
  if (q.ApiExtension === undefined || q.ApiExtension === null) return null;
  const raw = String(q.ApiExtension).trim().replace(/^\/+|\/+$/g, '');
  return raw ? '/' + raw : '';
};
const newSession = (d, sys, g, extra) => Object.assign({ d, sys, g, n: 0, hn: 0, mode: '', job: null, vc: '', pace: '', len: '', h: [], p: '', name: '', r: '', t: 0, e: crypto.randomBytes(3).toString('hex'), statusQueue: [], routeAlternatives: [] }, extra || {});

const EMPTY = 'None';
const TAP_EMPTY = ',No,no,no,,,,Ok,' + EMPTY;
const digitsOf = v => { const x = String(v == null ? '' : v).trim(); return x === EMPTY ? '' : x; };

const KB_KEYS = { '3': 'אבג', '2': 'דהו', '6': 'זחט', '5': 'יכךל', '4': 'מםנן', '9': 'סעפף', '8': 'צץק', '7': 'רשת' };
const KB_FINAL = { 'כ': 'ך', 'מ': 'ם', 'נ': 'ן', 'פ': 'ף', 'צ': 'ץ' };
const KB_WAIT = Math.min(60, Math.max(3, parseInt(process.env.KBD_WAIT, 10) || 20));
const WAIT_SEC = Math.min(15, Math.max(2, parseInt(process.env.INPUT_WAIT_SEC, 10) || 7));
const MENU_OPEN = 'להקלטת בקשה הקש 1, להקלדה הקש 2';
const MENU = 'להקלטה  1, להקלדה  2';
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
  s.statusQueue = ['קיבלתי, רגע אחד'];
  s.extraPlayChain = '';
  s.transferToExt = '';
  s.awaitingRouteChoice = false;
  s.job = doTurn(s, q, id, s.jobT0, typed, recVal).catch(async e => {
    console.error(id, 'turn crashed', e && e.message);
    return await tapAny(s, ERR);
  });
  return await holdStep(s);
}

async function holdStep(s) {
  if (s.statusQueue && s.statusQueue.length > 0) {
    const msg = s.statusQueue.shift();
    s.hn++;
    const clip = await sysClip(s, msg, 5500);
    return 'read=' + clip + '=H' + s.e + s.hn + ',no,1,1,1' + TAP_EMPTY;
  }

  const waitSig = new Promise(res => { s.onStatus = res; });
  const r = await Promise.race([s.job, waitSig.then(() => null), sleep(6000).then(() => 'tick')]);
  s.onStatus = null;

  if (r && r !== 'tick') {
    s.job = null;
    return r;
  }
  if (s.statusQueue && s.statusQueue.length > 0) {
    const msg = s.statusQueue.shift();
    s.hn++;
    const clip = await sysClip(s, msg, 5500);
    return 'read=' + clip + '=H' + s.e + s.hn + ',no,1,1,1' + TAP_EMPTY;
  }
  if (Date.now() - s.jobT0 > BUDGET + 15000) {
    s.job = null;
    return await tapAny(s, ERR);
  }
  s.hn++;
  const waitClip = await sysClip(s, 'עוד רגע', 5500);
  return 'read=' + waitClip + '=H' + s.e + s.hn + ',no,1,1,1' + TAP_EMPTY;
}

async function speakAndReturn(s, text, deadline, useRouteMenu) {
  let pcm = null;
  try { pcm = await tts(text, deadline, { voice: VOICE_BY[s.vc], pace: s.pace }); } catch (te) {}
  const tail = s.extraPlayChain ? '.' + s.extraPlayChain : '';
  s.extraPlayChain = '';
  const builder = useRouteMenu ? routeChoiceFor : ansFor;

  if (!pcm) return builder(s, 't-' + (sp(text) || sp(ERR)) + tail);

  const rn = 'r' + s.e + 'n' + s.n;
  await upload(rn, pcm, deadline, s.d, 30000);
  s.r = rn;
  return builder(s, 'f-' + s.d + '/' + rn + tail);
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
    if (s.r) { del(s.r, s.d); s.r = ''; }

    const a = await askModel(
      s.len === 'short' ? s.sys + SHORT_NOTE : s.sys,
      [...s.h.slice(-8), { role: 'user', parts: [userPart] }],
      deadline,
      s
    );

    if (s.transferToExt) {
      const target = s.transferToExt;
      s.transferToExt = '';
      const trClip = await sysClip(s, 'מעביר אותך לשידור החי', 5500);
      return `id_list_message=${trClip}&go_to_folder=${target}`;
    }

    const parts = (((a.candidates || [])[0] || {}).content || {}).parts || [];
    let text = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();
    if (!text) throw new Error('empty answer');

    const ctl = parseCtl(text);
    text = ctl.text || 'הפעולה בוצעה בהצלחה';
    if (ctl.ctl.voice === 'male' || ctl.ctl.voice === 'female') s.vc = ctl.ctl.voice;
    else if (ctl.ctl.voice === 'default') s.vc = '';
    if (ctl.ctl.len === 'short') s.len = 'short';
    else if (ctl.ctl.len === 'long') s.len = '';
    if (ctl.ctl.pace === 'slow' || ctl.ctl.pace === 'fast') s.pace = ctl.ctl.pace;
    else if (ctl.ctl.pace === 'normal') s.pace = '';

    const qtext = tq || ctl.q;
    s.h.push({ role: 'user', parts: [{ text: qtext || '[בקשה קולית]' }] }, { role: 'model', parts: [{ text }] });
    if (s.h.length > 12) s.h = s.h.slice(-12);

    const isRouteMenu = !!(s.awaitingRouteChoice && s.routeAlternatives && s.routeAlternatives.length > 0);
    return await speakAndReturn(s, text, deadline, isRouteMenu);
  } catch (e) {
    console.error(id, 'turn failed:', e.message);
    if (!typed) del(qn, s.d);
    return await tapAny(s, ERR);
  }
}

async function turnStep(s, q, id, T0) {
  if (s.job) return await holdStep(s);

  // טיפול בבחירת חלופת מסלול (הקש 1, 2 או 3)
  if (s.mode === 'route_choice') {
    const d = digitsOf(q[s.p]);
    const idx = parseInt(d, 10) - 1;
    if (idx >= 0 && idx < (s.routeAlternatives || []).length) {
      const chosenText = s.routeAlternatives[idx] + ' לשמיעת חלופה אחרת הקש 1, 2 או 3. לבקשה חדשה הקש כוכבית או אפס.';
      s.n++;
      return await speakAndReturn(s, chosenText, Date.now() + 45000, true);
    }
    return await tapAny(s, KB_MORE);
  }

  if (s.mode === 'ans') {
    const d = digitsOf(q[s.p]);
    if (d === '1' || d === '2') s.mode = 'menu';
    else return await tapAny(s, KB_MORE);
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

app.get('/', (q, r) => r.send('ok'));

app.all(['/yemot', '/yemot/:e'], async (req, res) => {
  const q = { ...req.query, ...req.body };
  const id = idOf(q);
  res.type('text/plain');
  const T0 = Date.now();
  const ext = EXTS[String(req.params.e || '')] || EXT_FIRST;
  const apiExt = normApiExt(q);
  const targetDir = req.params.e ? ext.d : (apiExt !== null ? apiExt : ext.d);
  try {
    if (q.hangup === 'yes') {
      const old = calls[id];
      if (old && old.r) del(old.r, old.d);
      delete calls[id];
      return res.send('noop=bye');
    }
    const s = calls[id] || (calls[id] = newSession(targetDir, ext.sys, ext.g, { ph: phoneOf(q), apiExt }));
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

// הכנה מראש ברקע של הודעות הפתיחה והתפריטים בקול הנשי הצעיר (Kore)
async function warmSystemPrompts() {
  if (!TTS_KEYS.length || !TOKEN) return;
  const dirs = [...new Set([EXT_FIRST.d, ...Object.values(EXTS).map(e => e.d)])];
  for (const d of dirs) {
    const greet = (Object.values(EXTS).find(e => e.d === d) || EXT_FIRST).g;
    const phrases = [
      greet + '. ' + MENU_OPEN,
      MENU,
      'דבר אחרי הצליל',
      'קיבלתי, רגע אחד',
      'עוד רגע',
      KB_START,
      KB_MORE + '. ' + MENU,
      AGAIN + '. ' + MENU,
      ERR + '. ' + MENU
    ];
    for (const p of phrases) {
      await sysClip({ d }, p, 20000);
      await sleep(300);
    }
  }
}

app.listen(process.env.PORT || 3000, () => {
  console.log('kav-ai-agentic up');
  setTimeout(() => warmSystemPrompts().catch(() => {}), 1500);
});
