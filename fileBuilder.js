const zlib = require('zlib');

// ============================================================================
// 1. מחולל ארכיוני ZIP תקני בזיכרון (ללא תלויות חיצוניות) — לתוכנות מרובות קבצים
// ============================================================================
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createZipBuffer(entries) {
  // entries: [{ name: 'path/file.ext', data: Buffer | string }]
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const cleanName = String(entry.name || 'file.txt').replace(/^\/+/, '').replace(/\\/g, '/');
    const nameBuf = Buffer.from(cleanName, 'utf8');
    const rawBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data || ''), 'utf8');
    const crc = crc32(rawBuf);
    const compressed = zlib.deflateRawSync(rawBuf, { level: 6 });
    const useStore = compressed.length >= rawBuf.length;
    const bodyBuf = useStore ? rawBuf : compressed;
    const method = useStore ? 0 : 8;

    const localHdr = Buffer.alloc(30);
    localHdr.writeUInt32LE(0x04034b50, 0);
    localHdr.writeUInt16LE(20, 4);
    localHdr.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHdr.writeUInt16LE(method, 8);
    localHdr.writeUInt16LE(0, 10);
    localHdr.writeUInt16LE(0x597B, 12);
    localHdr.writeUInt32LE(crc, 14);
    localHdr.writeUInt32LE(bodyBuf.length, 18);
    localHdr.writeUInt32LE(rawBuf.length, 22);
    localHdr.writeUInt16LE(nameBuf.length, 26);
    localHdr.writeUInt16LE(0, 28);

    localParts.push(localHdr, nameBuf, bodyBuf);

    const centHdr = Buffer.alloc(46);
    centHdr.writeUInt32LE(0x02014b50, 0);
    centHdr.writeUInt16LE(20, 4);
    centHdr.writeUInt16LE(20, 6);
    centHdr.writeUInt16LE(0x0800, 8); // UTF-8 filename flag
    centHdr.writeUInt16LE(method, 10);
    centHdr.writeUInt16LE(0, 12);
    centHdr.writeUInt16LE(0x597B, 14);
    centHdr.writeUInt32LE(crc, 16);
    centHdr.writeUInt32LE(bodyBuf.length, 20);
    centHdr.writeUInt32LE(rawBuf.length, 24);
    centHdr.writeUInt16LE(nameBuf.length, 28);
    centHdr.writeUInt16LE(0, 30);
    centHdr.writeUInt16LE(0, 32);
    centHdr.writeUInt16LE(0, 34);
    centHdr.writeUInt16LE(0, 36);
    centHdr.writeUInt32LE(0, 38);
    centHdr.writeUInt32LE(offset, 42);

    centralParts.push(centHdr, nameBuf);
    offset += localHdr.length + nameBuf.length + bodyBuf.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

// ============================================================================
// 2. מחולל מסמכי Microsoft Word (.docx) תקני עם עברית מלאה מימין לשמאל (RTL)
// ============================================================================
function escXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildDocxRuns(line, baseSizeHalfPt = 24, defaultColor = '1E293B') {
  // תומך בהדגשות **טקסט** בתוך שורה
  const parts = String(line || '').split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  if (!parts.length) return '';
  return parts.map(part => {
    const isBold = part.startsWith('**') && part.endsWith('**') && part.length > 4;
    const text = isBold ? part.slice(2, -2) : part;
    return `<w:r>
      <w:rPr>
        <w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>
        ${isBold ? '<w:b/><w:bCs/>' : ''}
        <w:color w:val="${defaultColor}"/>
        <w:sz w:val="${baseSizeHalfPt}"/>
        <w:szCs w:val="${baseSizeHalfPt}"/>
        <w:rtl/>
      </w:rPr>
      <w:t xml:space="preserve">${escXml(text)}</w:t>
    </w:r>`;
  }).join('');
}

function createRtlDocxBuffer({ title, content }) {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const paragraphs = [];

  if (title) {
    paragraphs.push(`<w:p>
      <w:pPr>
        <w:bidi/>
        <w:jc w:val="right"/>
        <w:spacing w:before="120" w:after="240"/>
        <w:pBdr><w:bottom w:val="single" w:sz="12" w:space="6" w:color="2563EB"/></w:pBdr>
      </w:pPr>
      <w:r>
        <w:rPr>
          <w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>
          <w:b/><w:bCs/>
          <w:color w:val="1E3A8A"/>
          <w:sz w:val="36"/><w:szCs w:val="36"/>
          <w:rtl/>
        </w:rPr>
        <w:t>${escXml(title)}</w:t>
      </w:r>
    </w:p>`);
  }

  let inCode = false;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      paragraphs.push(`<w:p>
        <w:pPr>
          <w:jc w:val="left"/>
          <w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/>
          <w:spacing w:before="20" w:after="20"/>
        </w:pPr>
        <w:r>
          <w:rPr>
            <w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>
            <w:sz w:val="20"/><w:szCs w:val="20"/>
          </w:rPr>
          <w:t xml:space="preserve">${escXml(rawLine)}</w:t>
        </w:r>
      </w:p>`);
      continue;
    }

    if (!trimmed) {
      paragraphs.push('<w:p><w:pPr><w:bidi/><w:spacing w:before="60" w:after="60"/></w:pPr></w:p>');
      continue;
    }

    const h1 = /^#\s+(.+)/.exec(trimmed);
    const h2 = /^##\s+(.+)/.exec(trimmed);
    const h3 = /^###\s+(.+)/.exec(trimmed);
    const bullet = /^[-*•]\s+(.+)/.exec(trimmed);

    if (h1 || h2 || h3) {
      const text = (h1 || h2 || h3)[1];
      const sz = h1 ? 32 : (h2 ? 28 : 25);
      const col = h1 ? '1E3A8A' : (h2 ? '1D4ED8' : '0F172A');
      paragraphs.push(`<w:p>
        <w:pPr><w:bidi/><w:jc w:val="right"/><w:spacing w:before="200" w:after="100"/></w:pPr>
        <w:r>
          <w:rPr>
            <w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>
            <w:b/><w:bCs/>
            <w:color w:val="${col}"/>
            <w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>
            <w:rtl/>
          </w:rPr>
          <w:t>${escXml(text.replace(/\*\*/g, ''))}</w:t>
        </w:r>
      </w:p>`);
    } else if (bullet) {
      paragraphs.push(`<w:p>
        <w:pPr>
          <w:bidi/><w:jc w:val="right"/>
          <w:ind w:right="360"/>
          <w:spacing w:before="40" w:after="60"/>
        </w:pPr>
        ${buildDocxRuns('• ' + bullet[1], 23)}
      </w:p>`);
    } else {
      paragraphs.push(`<w:p>
        <w:pPr><w:bidi/><w:jc w:val="right"/><w:spacing w:before="60" w:after="100"/></w:pPr>
        ${buildDocxRuns(rawLine, 23)}
      </w:p>`);
    }
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs.join('\n')}
    <w:sectPr>
      <w:bidi/>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  return createZipBuffer([
    { name: '[Content_Types].xml', data: contentTypesXml },
    { name: '_rels/.rels', data: relsXml },
    { name: 'word/document.xml', data: documentXml }
  ]);
}

// ============================================================================
// 3. עיצוב מייל HTML משודרג, עשיר ומודרני מימין לשמאל (RTL)
// ============================================================================
function formatInlineHtml(text) {
  return escXml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#0f172a;">$1</strong>')
    .replace(/`([^`]+)`/g, '<code style="background:#f1f5f9;padding:2px 6px;border-radius:4px;font-family:Consolas,monospace;direction:ltr;display:inline-block;color:#0369a1;">$1</code>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#2563eb;text-decoration:underline;direction:ltr;display:inline-block;">$1</a>');
}

function buildRichRtlEmailHtml({ subject, bodyText, badgeText, attachedFilesList, footerNote }) {
  const lines = String(bodyText || '').replace(/\r\n/g, '\n').split('\n');
  const htmlBlocks = [];
  let inCode = false;
  let codeLang = '';
  let codeLines = [];
  let listItems = [];

  const flushList = () => {
    if (listItems.length) {
      htmlBlocks.push(`<ul style="margin:10px 0 16px 0;padding:0 22px 0 0;color:#334155;line-height:1.75;">${listItems.join('')}</ul>`);
      listItems = [];
    }
  };

  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith('```')) {
      flushList();
      if (!inCode) {
        inCode = true;
        codeLang = t.slice(3).trim();
        codeLines = [];
      } else {
        inCode = false;
        htmlBlocks.push(`
          <div style="margin:14px 0;border-radius:10px;overflow:hidden;border:1px solid #cbd5e1;direction:ltr;text-align:left;background:#0f172a;">
            ${codeLang ? `<div style="background:#1e293b;color:#94a3b8;padding:6px 14px;font-size:12px;font-family:Consolas,monospace;">${escXml(codeLang)}</div>` : ''}
            <pre style="margin:0;padding:14px;color:#f8fafc;font-size:13px;line-height:1.55;font-family:Consolas,'Courier New',monospace;overflow-x:auto;">${escXml(codeLines.join('\n'))}</pre>
          </div>`);
        codeLines = [];
      }
      continue;
    }
    if (inCode) {
      codeLines.push(raw);
      continue;
    }
    if (!t) {
      flushList();
      continue;
    }
    if (/^===+\s*(.+?)\s*===+$/.test(t) || /^##\s+(.+)/.test(t) || /^#\s+(.+)/.test(t)) {
      flushList();
      const heading = t.replace(/^===+\s*|\s*===+$/g, '').replace(/^#+\s+/, '');
      htmlBlocks.push(`<h2 style="margin:22px 0 10px 0;font-size:18px;color:#1e3a8a;border-right:4px solid #3b82f6;padding-right:10px;">${formatInlineHtml(heading)}</h2>`);
    } else if (/^###\s+(.+)/.test(t)) {
      flushList();
      htmlBlocks.push(`<h3 style="margin:16px 0 8px 0;font-size:16px;color:#0f172a;">${formatInlineHtml(t.slice(4))}</h3>`);
    } else if (/^[-*•]\s+(.+)/.test(t)) {
      const itemTxt = t.replace(/^[-*•]\s+/, '');
      listItems.push(`<li style="margin-bottom:6px;">${formatInlineHtml(itemTxt)}</li>`);
    } else if (/^---+$/.test(t)) {
      flushList();
      htmlBlocks.push('<hr style="border:none;border-top:1px solid #e2e8f0;margin:18px 0;"/>');
    } else {
      flushList();
      htmlBlocks.push(`<p style="margin:0 0 12px 0;color:#1e293b;font-size:15px;line-height:1.8;">${formatInlineHtml(raw)}</p>`);
    }
  }
  flushList();
  if (inCode && codeLines.length) {
    htmlBlocks.push(`<pre style="direction:ltr;text-align:left;background:#0f172a;color:#f8fafc;padding:14px;border-radius:10px;overflow-x:auto;">${escXml(codeLines.join('\n'))}</pre>`);
  }

  const filesBadgeHtml = (attachedFilesList && attachedFilesList.length)
    ? `<div style="margin-top:20px;padding:14px 16px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;">
        <div style="font-weight:bold;color:#1d4ed8;margin-bottom:8px;font-size:14px;">📎 קבצים מצורפים להודעה זו (${attachedFilesList.length}):</div>
        <ul style="margin:0;padding:0 20px 0 0;color:#1e40af;font-size:13.5px;">
          ${attachedFilesList.map(fn => `<li style="margin-bottom:4px;"><span style="direction:ltr;display:inline-block;font-family:Consolas,monospace;">${escXml(fn)}</span></li>`).join('')}
        </ul>
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body dir="rtl" style="margin:0;padding:24px 12px;background-color:#f1f5f9;font-family:'Segoe UI',Arial,Helvetica,sans-serif;direction:rtl;text-align:right;">
  <div dir="rtl" style="max-width:720px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(15,23,42,0.08);border:1px solid #e2e8f0;">
    <div style="background:linear-gradient(135deg,#1e3a8a 0%,#2563eb 60%,#0ea5e9 100%);padding:24px 28px;color:#ffffff;">
      <div style="font-size:12px;opacity:0.9;margin-bottom:6px;letter-spacing:0.4px;">${escXml(badgeText || 'קו AI החכם • תהילה גרסה 4.0')}</div>
      <h1 style="margin:0;font-size:22px;font-weight:700;line-height:1.4;color:#ffffff;">${escXml(subject || 'סיכום ומסמכים מקו AI')}</h1>
    </div>
    <div style="padding:26px 28px;direction:rtl;text-align:right;">
      ${htmlBlocks.join('\n')}
      ${filesBadgeHtml}
    </div>
    <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:14px 28px;font-size:12.5px;color:#64748b;text-align:center;">
      ${escXml(footerNote || 'נשלח אוטומטית על ידי מערכת קו AI הסוכנותית (תהילה) • ימות המשיח')}
    </div>
  </div>
</body>
</html>`;
}

// ============================================================================
// 4. הקראה ואיות ברור של כתובת מייל לאישור קולי בטלפון (סעיף 11)
// ============================================================================
function normalizeSpokenEmailInput(raw) {
  if (!raw) return '';
  let s = String(raw).trim().toLowerCase();
  s = s
    .replace(/\s*שטרודל\s*|\s*כרוכית\s*|\s+at\s+/gi, '@')
    .replace(/\s*נקודה\s*|\s+dot\s+/gi, '.')
    .replace(/\s*מקף\s*תחתון\s*|\s*קו\s*תחתון\s*/gi, '_')
    .replace(/\s*מקף\s*/gi, '-')
    .replace(/ג['׳]?ימייל/g, 'gmail')
    .replace(/(^|[^א-ת])קום(?=[^א-ת]|$)/g, '$1com')
    .replace(/סי\s*או\s*אי\s*אל/g, 'co.il')
    .replace(/\s+/g, '');
  const match = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.exec(s);
  return match ? match[0].toLowerCase() : '';
}

function spellEmailForHebrewSpeech(email) {
  const clean = String(email || '').trim().toLowerCase();
  const [userPart, domainPart] = clean.split('@');
  if (!userPart || !domainPart) return clean;

  const charSpoken = ch => {
    if (/[a-z]/.test(ch)) return ch.toUpperCase();
    if (/[0-9]/.test(ch)) return ch;
    if (ch === '.') return 'נקודה';
    if (ch === '_') return 'קו תחתון';
    if (ch === '-') return 'מקף';
    if (ch === '+') return 'פלוס';
    return ch;
  };
  // הפרדה נוחה להקראה בין אותיות לספרות
  const tokens = userPart.match(/[a-z]+|[0-9]+|[^a-z0-9]/g) || [userPart];
  const spokenUser = tokens.map(tok => {
    if (/^[a-z]+$/.test(tok)) return tok.split('').map(c => c.toUpperCase()).join(' ');
    if (/^[0-9]+$/.test(tok)) return tok.split('').join(' ');
    return charSpoken(tok);
  }).join(', ');

  let spokenDomain = domainPart
    .replace(/^gmail\.com$/, "ג'ימייל נקודה קום")
    .replace(/^outlook\.com$/, 'אאוטלוק נקודה קום')
    .replace(/^walla\.co\.il$/, 'וואלה נקודה co נקודה il')
    .replace(/\./g, ' נקודה ');

  return `${spokenUser}, שטרודל, ${spokenDomain}`;
}

function guessMimeByExt(filename) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  const map = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    zip: 'application/zip',
    html: 'text/html',
    htm: 'text/html',
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    csv: 'text/csv',
    js: 'text/javascript',
    ts: 'text/plain',
    py: 'text/x-python',
    sql: 'text/plain',
    css: 'text/css',
    xml: 'application/xml'
  };
  return map[ext] || 'application/octet-stream';
}


// עוטף קובץ ZIP (שמכיל קובצי .js שג'ימייל חוסם כצרופה ישירה) בדף HTML אינטראקטיבי להורדה בלחיצה אחת בדפדפן!
function buildSelfExtractingZipHtml({ zipFilename, zipBuffer, title, fileNamesList }) {
  const b64 = zipBuffer.toString('base64');
  const safeZipName = escXml(zipFilename || 'project_bundle.zip');
  const listHtml = (fileNamesList || []).map(fn => `<li style="margin-bottom:5px;font-family:Consolas,monospace;direction:ltr;text-align:left;">${escXml(fn)}</li>`).join('');
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="UTF-8"><title>${escXml(title || safeZipName)}</title></head>
<body dir="rtl" style="margin:0;padding:40px 16px;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;text-align:center;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;box-shadow:0 8px 28px rgba(15,23,42,0.1);border:1px solid #e2e8f0;">
    <h1 style="margin:0 0 12px 0;color:#1e3a8a;font-size:22px;">📦 ${escXml(title || 'חבילת קבצים מוכנה להורדה')}</h1>
    <p style="color:#475569;font-size:15px;line-height:1.7;margin-bottom:24px;">
      כיוון שג'ימייל חוסם צירוף ישיר של קובצי JavaScript (<code>.js</code>) בתוך ZIP, המערכת ארזה עבורך את קובץ ה-ZIP המקורי והמלא בתוך דף הורדה מאובטח זה. לחץ על הכפתור למטה לשמירת קובץ ה-ZIP המלא במחשב:
    </p>
    <a id="dlBtn" download="${safeZipName}" href="data:application/zip;base64,${b64}"
       style="display:inline-block;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;text-decoration:none;font-weight:bold;font-size:17px;padding:15px 32px;border-radius:12px;box-shadow:0 4px 14px rgba(37,99,235,0.35);">
      ⬇️ הורד כעת: ${safeZipName}
    </a>
    ${listHtml ? `<div style="margin-top:26px;text-align:right;background:#f8fafc;padding:14px 18px;border-radius:10px;border:1px solid #e2e8f0;">
      <div style="font-weight:bold;color:#334155;margin-bottom:8px;font-size:14px;">קבצים כלולים בארכיון:</div>
      <ul style="margin:0;padding-left:20px;color:#0f172a;font-size:13px;">${listHtml}</ul>
    </div>` : ''}
  </div>
</body>
</html>`;
}

module.exports = {
  buildSelfExtractingZipHtml,
  createZipBuffer,
  createRtlDocxBuffer,
  buildRichRtlEmailHtml,
  normalizeSpokenEmailInput,
  spellEmailForHebrewSpeech,
  guessMimeByExt
};
