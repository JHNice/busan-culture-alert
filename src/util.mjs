// 공용 유틸: 날짜, 가격 파싱, XML/JSON 응답 파싱
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = process.env.BCA_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 날짜 (KST 기준, 'YYYY-MM-DD' 문자열로 통일) ----------
export function todayKST(now = Date.now()) {
  return new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDays(a, b) {
  // a - b (일)
  return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
}

export function compactDate(iso) {
  return iso.replaceAll('-', '');
}

// '2026-09-17', '20260917', '2026.09.17', '2019-12-27(금)' → '2026-09-17'
export function toISO(value) {
  if (value == null) return null;
  const m = String(value).match(/(\d{4})\s*[.\-/년]?\s*(\d{1,2})\s*[.\-/월]?\s*(\d{1,2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return Number.isNaN(Date.parse(iso + 'T00:00:00Z')) ? null : iso;
}

// ---------- 가격 ----------
// 반환: 0 = 무료, 숫자 = 성인(일반) 기준 원, null = 판단 불가
export function parsePrice(text) {
  if (text == null) return null;
  const raw = String(text).trim();
  if (!raw) return null;
  const t = raw.replace(/\s+/g, '');

  const amounts = [];
  // 1만6천원, 1만원
  for (const m of t.matchAll(/(\d+)만(?:(\d)천)?원/g)) {
    amounts.push({ idx: m.index, value: Number(m[1]) * 10000 + Number(m[2] || 0) * 1000 });
  }
  // 16,000원 / 5000원
  for (const m of t.matchAll(/(\d{1,3}(?:,\d{3})+|\d{3,})원/g)) {
    amounts.push({ idx: m.index, value: Number(m[1].replaceAll(',', '')) });
  }
  const valid = amounts.filter((a) => a.value >= 100);

  if (valid.length === 0) return /무료|free/i.test(t) ? 0 : null;

  // '일반/성인/어른' 바로 뒤에 붙은 금액이 있으면 그것을 사용
  const adult = t.match(/(일반|성인|어른)/);
  if (adult) {
    const after = valid.filter((a) => a.idx > adult.index).sort((a, b) => a.idx - b.idx)[0];
    if (after && after.idx - adult.index <= 12) return after.value;
  }
  // 없으면 가장 비싼 금액(보수적으로 판단)
  return Math.max(...valid.map((a) => a.value));
}

// ---------- 중복 판정용 키 ----------
export function normalizeKey(title, start) {
  const t = String(title || '')
    .replace(/\[[^\]]*\]|\([^)]*\)|<[^>]*>|《|》|「|」|『|』/g, '')
    .replace(/[^0-9a-zA-Z가-힣]/g, '')
    .toLowerCase();
  return `${t}|${start || ''}`;
}

// ---------- XML ----------
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  middot: '·', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', ndash: '–', mdash: '—',
};
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

function xmlValue(inner) {
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  // 한눈에보는문화정보는 제목이 이중 인코딩되어 옴 (&amp;middot; → &middot; → ·)
  return (cdata ? cdata[1] : decodeEntities(decodeEntities(inner))).trim();
}

// 평평한 구조의 <item>...</item> 목록을 객체 배열로 변환
export function parseXmlItems(xml, tag = 'item') {
  const out = [];
  const itemRe = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  for (const m of xml.matchAll(itemRe)) {
    const obj = {};
    for (const c of m[1].matchAll(/<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
      obj[c[1]] = xmlValue(c[2]);
    }
    out.push(obj);
  }
  return out;
}

export function xmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? xmlValue(m[1]) : null;
}

// ---------- JSON ----------
export function deepFind(obj, key, depth = 0) {
  if (obj == null || typeof obj !== 'object' || depth > 8) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const found = deepFind(v, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function findJsonItems(obj) {
  const item = deepFind(obj, 'item');
  if (Array.isArray(item)) return item;
  if (item && typeof item === 'object') return [item];
  return [];
}

// ---------- 기타 ----------
export function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function isHttpUrl(s) {
  return typeof s === 'string' && /^https?:\/\/\S+$/i.test(s.trim());
}

let logFile = null;
export function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  console.log(line);
  try {
    if (!logFile) {
      const dir = path.join(ROOT, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      logFile = path.join(dir, `${todayKST().slice(0, 7)}.log`);
    }
    fs.appendFileSync(logFile, line + '\n');
  } catch {
    /* 로그 실패는 무시 */
  }
}
