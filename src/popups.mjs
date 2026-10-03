// 팝업스토어 자동 수집 (공개 API가 없어 사이트 페이지를 읽는다)
// - robots.txt 를 지키고, 사이트맵에서 상세 페이지 주소를 모은 뒤 새 페이지만 천천히(기본 1초 간격) 읽는다.
// - 읽은 결과는 data/popup-cache.json 에 저장해서 다음 실행 때 다시 읽지 않는다.
// - 막힌 사이트(403/429/캡차 등)는 data/popup-status.json 에 '막힘'으로 기록 → 캘린더에서 '사이트 열기'로 직접 확인.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, sleep, toISO, log, decodeEntities } from './util.mjs';
import { dump } from './http.mjs';

export const DEFAULT_SITES = [
  {
    id: 'popply',
    label: '팝플리',
    open: 'https://popply.co.kr/maps',
    sitemap: 'https://popply.co.kr/sitemap.xml',
    detail: '^https://popply\\.co\\.kr/popup/(\\d+)/?$',
  },
  {
    id: 'popga',
    label: '팝가',
    open: 'https://popga.co.kr/list/popup',
    sitemap: 'https://popga.co.kr/sitemap.xml',
    detail: '^https://popga\\.co\\.kr/popup/(\\d+)/?$',
  },
  {
    id: 'dayforyou',
    label: '데이포유',
    open: 'https://dayforyou.com/',
    sitemap: 'https://dayforyou.com/sitemap.xml',
    detail: '^https://(?:www\\.)?dayforyou\\.com/.*?(\\d{2,})/?$',
  },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 BusanCultureAlert/1.0 (personal calendar)';
const cacheFile = () => path.join(ROOT, 'data', 'popup-cache.json');
export const statusFile = () => path.join(ROOT, 'data', 'popup-status.json');
const DAY = 86400000;

export class BlockedError extends Error {}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data));
  fs.renameSync(file + '.tmp', file);
}

export function looksBlocked(status, body) {
  if ([401, 403, 429, 503].includes(status)) return true;
  return /cf-chl|challenge-platform|captcha|Access Denied|Request unsuccessful|비정상적인 접근|접근이 차단/i.test(String(body).slice(0, 5000));
}

async function get(url, { timeoutMs = 20000 } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const code = e.cause?.code || '';
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code)) throw new BlockedError(`보안 인증서 문제로 자동 연결 불가 (${code}) — '사이트 열기'로 직접 확인`);
    throw new Error(`네트워크 오류: ${e.message}${code ? ` (${code})` : ''}`);
  }
  const text = await res.text();
  if (dump.enabled) {
    const host = new URL(url).host;
    if (dump.records.filter((r) => r.url.includes(host)).length < 3) dump.records.push({ url, status: res.status, text: text.slice(0, 60000) });
  }
  if (looksBlocked(res.status, text)) throw new BlockedError(`HTTP ${res.status} (자동 접근 차단으로 보임)`);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return text;
}

// ---------- robots.txt (User-agent: * 의 Disallow 만 확인) ----------
export function robotsDisallows(robotsTxt) {
  // 그룹 = 연속된 User-agent 줄들 + 그 뒤 규칙들. '*' 그룹의 Disallow 만 모은다.
  const rules = [];
  let agents = [];
  let inRules = false;
  for (const raw of String(robotsTxt).split(/\r?\n/)) {
    const m = raw.replace(/#.*/, '').trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (inRules) {
        agents = [];
        inRules = false;
      }
      agents.push(val);
    } else {
      inRules = true;
      if (key === 'disallow' && val && agents.includes('*')) rules.push(val);
    }
  }
  return rules;
}
export function isAllowed(url, disallows) {
  const p = new URL(url).pathname;
  return !disallows.some((d) => p.startsWith(d));
}

// ---------- 사이트맵 ----------
export function sitemapLocs(xml) {
  return [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => decodeEntities(m[1]));
}

async function collectDetailUrls(site) {
  const re = new RegExp(site.detail);
  const xml = await get(site.sitemap);
  let locs = sitemapLocs(xml);
  if (/<sitemapindex/i.test(xml)) {
    const children = locs.slice(0, 12);
    locs = [];
    for (const c of children) {
      try {
        locs.push(...sitemapLocs(await get(c)));
      } catch (e) {
        if (e instanceof BlockedError) throw e;
      }
      await sleep(site.delayMs ?? 1000);
    }
  }
  const byId = new Map();
  for (const u of locs) {
    const m = u.match(re);
    if (m) byId.set(m[1], u);
  }
  // 번호가 클수록 최근 등록 → 최신부터
  return [...byId.entries()].sort((a, b) => Number(b[0]) - Number(a[0])).map(([id, url]) => ({ id, url }));
}

// ---------- 상세 페이지 해석 ----------
function meta(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  const m = html.match(re);
  return m ? decodeEntities(m[1] ?? m[2]).trim() : null;
}

export function htmlText(html) {
  return decodeEntities(
    String(html)
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|dd|dt|h\d|tr|section)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}
// Next.js 등 스크립트 안에 들어 있는 글자도 찾기 위해 이스케이프만 풀어서 사용
function scriptText(html) {
  return String(html)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\"/g, '"');
}

const Y = (y, fallbackYear) => {
  if (!y) return fallbackYear;
  const n = Number(y);
  return n < 100 ? 2000 + n : n;
};
const iso = (y, m, d) => toISO(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);

// '26.09.02 - 26.09.06', '2026.10.02 ~ 2026.10.11', '26.10.02(금) - 10.11(일)', '10. 02 - 10. 11', '2026년 10월 2일 ~ 10월 11일'
export function parsePeriod(text, today) {
  const cy = Number(today.slice(0, 4));
  const D = String.raw`(?:\s*\([^)]{1,4}\))?`;
  const patterns = [
    new RegExp(String.raw`(?<!\d)(\d{4}|\d{2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})\.?${D}\s*[~\-–]\s*(?:(\d{4}|\d{2})\s*[.\-/]\s*)?(\d{1,2})\s*[.\-/]\s*(\d{1,2})(?!\d)`),
    new RegExp(String.raw`(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일${D}\s*[~\-–]\s*(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일`),
    new RegExp(String.raw`(?<![\d.])()(\d{1,2})\s*\.\s*(\d{1,2})\.?${D}\s*[~\-–]\s*()(\d{1,2})\s*\.\s*(\d{1,2})(?![\d.])`),
  ];
  for (const re of patterns) {
    const m = String(text).match(re);
    if (!m) continue;
    const [, y1, m1, d1, y2, m2, d2] = m;
    const sy = Y(y1, cy);
    let ey = Y(y2, sy);
    if (!y2 && Number(m2) < Number(m1)) ey = sy + 1;
    const start = iso(sy, m1, d1);
    const end = iso(ey, m2, d2);
    if (start && end && end >= start) return { start, end };
  }
  return null;
}

// 팝가 제목 끝의 '- 수영구 공연', '- 부산 축제', '- 용산 팝업' → 종류로 쓰고 제목에서는 뺀다
export function splitKind(title) {
  const suf = String(title || '').match(/\s+-\s+[가-힣A-Za-z/]{1,10}\s(팝업|공연|축제|전시|행사)$/);
  if (!suf) return { title, kind: 'popup' };
  return {
    title: title.slice(0, suf.index).replace(/\s+-\s+부산$/, '').trim(),
    kind: { 팝업: 'popup', 공연: 'show', 축제: 'festival', 전시: 'exhibit', 행사: 'show' }[suf[1]],
  };
}
const cleanPlace = (s) => (s ? s.replace(/\s*지도\s*보기.*$/, '').trim() || null : null);

const REGION = '(서울|부산|경기|인천|대구|대전|광주|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|특별자치도|도)?';
export function parseAddress(text) {
  const m = String(text).match(new RegExp(`${REGION}\\s+[가-힣]+(?:구|군|시)(?:\\s+[^\\n]{0,40})?`));
  return m ? m[0].replace(/\s+/g, ' ').trim() : null;
}
const BUSAN_HINT = /부산|해운대|광안리|서면|센텀|남포동|기장|동래|수영구|영도|송정/;

export function parsePopupHtml(html, url, today) {
  const text = htmlText(html);
  const raw = scriptText(html);
  let title = meta(html, 'og:title') || (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '');
  title = decodeEntities(title)
    .replace(/\s*[|｜]\s*(팝가|POPPLY|팝플리|데이포유|Popga).*$/i, '')
    .replace(/\s*-\s*(POPPLY|팝플리)\s*$/i, '')
    .trim();
  let kind;
  ({ title, kind } = splitKind(title));
  const period = parsePeriod(text, today) || parsePeriod(raw, today);
  const place = cleanPlace(parseAddress(text) || parseAddress(raw));
  const busan = /부산/.test(place || '') || (!place && BUSAN_HINT.test(title));
  return {
    kind,
    title: title || null,
    start: period?.start ?? null,
    end: period?.end ?? null,
    place,
    busan,
    image: meta(html, 'og:image'),
    desc: meta(html, 'og:description'),
    url,
  };
}

// ---------- 수집 ----------
export async function fetchPopups(cfg, ctx) {
  const today = ctx.today;
  const sites = [...DEFAULT_SITES, ...(cfg.popupSites || [])].filter((s) => s.enabled !== false);
  const maxNew = cfg.popupMaxFetchPerRun ?? 80;
  const scanLimit = cfg.popupScanLimit ?? 400;
  const delayMs = cfg.popupDelayMs ?? 1000;
  const regionRe = new RegExp((cfg.popupRegions?.length ? cfg.popupRegions : ['부산']).join('|'));
  const cache = readJson(cacheFile(), {});
  const status = { checkedAt: new Date().toISOString(), sites: [] };
  const items = [];
  const now = Date.now();
  // popupIntervalHours: 이 시간 안에 이미 사이트를 읽었으면 네트워크 없이 캐시만 사용 (클라우드에서 30분마다 돌 때 사이트 부담 줄이기)
  const prevStatus = readJson(statusFile(), null);
  const intervalH = Number(cfg.popupIntervalHours) || 0;
  const skipNet = intervalH > 0 && !!prevStatus?.checkedAt && now - Date.parse(prevStatus.checkedAt) < intervalH * 3600000;
  if (skipNet) status.checkedAt = prevStatus.checkedAt;

  for (const site of sites) {
    const st = { id: site.id, label: site.label, open: site.open, state: 'ok', message: '', listed: 0, fetched: 0, matched: 0 };
    status.sites.push(st);
    const pages = (cache[site.id] ||= {});
    if (skipNet) Object.assign(st, prevStatus.sites?.find((s) => s.id === site.id) || {}, { matched: 0 });
    else try {
      const origin = new URL(site.sitemap).origin;
      let disallows = [];
      try {
        disallows = robotsDisallows(await get(`${origin}/robots.txt`));
      } catch (e) {
        if (e instanceof BlockedError) throw e;
      }
      const list = (await collectDetailUrls({ ...site, delayMs })).filter((d) => isAllowed(d.url, disallows)).slice(0, scanLimit);
      st.listed = list.length;
      if (!list.length) {
        st.state = 'error';
        st.message = '사이트맵에서 팝업 상세 주소를 찾지 못함 (사이트 구조가 바뀌었을 수 있음)';
      }
      let fetched = 0;
      for (const { id, url } of list) {
        const c = pages[id];
        const stale =
          !c ||
          (c.err && now - c.t > 3 * DAY) ||
          (c.busan && c.end && c.end >= today && now - c.t > 7 * DAY) ||
          (!c.err && !c.start && now - c.t > 7 * DAY);
        if (!stale) continue;
        if (fetched >= maxNew) {
          st.state = st.state === 'ok' ? 'partial' : st.state;
          st.message = `새 페이지가 많아 ${maxNew}개만 읽음 → 다음 실행 때 이어서`;
          break;
        }
        fetched++;
        try {
          pages[id] = { t: now, ...parsePopupHtml(await get(url), url, today) };
        } catch (e) {
          if (e instanceof BlockedError) throw e;
          pages[id] = { t: now, err: e.message, url };
        }
        await sleep(delayMs);
      }
      st.fetched = fetched;
    } catch (e) {
      st.state = e instanceof BlockedError ? 'blocked' : 'error';
      st.message = e.message;
      log(`팝업 ${site.label}: ${st.state === 'blocked' ? '막힘' : '실패'} — ${e.message}`);
    }
    for (const [id, cached] of Object.entries(pages)) {
      if (cached.err || !cached.title || !cached.start) continue;
      // 이전 버전이 저장한 캐시도 같은 규칙으로 정리 (다시 내려받지 않음)
      const p = cached.kind ? cached : { ...cached, ...splitKind(cached.title), place: cleanPlace(cached.place) };
      const inRegion = p.busan || regionRe.test(`${p.place || ''} ${p.title}`);
      if (!inRegion) continue;
      st.matched++;
      const cat = { popup: '팝업스토어', show: '공연·행사', festival: '축제·행사', exhibit: '전시' }[p.kind || 'popup'];
      items.push({
        id: `pp:${site.id}:${id}`,
        category: cat,
        title: p.title,
        start: p.start,
        end: p.end,
        place: p.place,
        priceText: '',
        price: null,
        url: p.url,
        image: p.image,
        info: p.desc ? p.desc.slice(0, 160) : null,
        sourceLabel: `${(p.kind || 'popup') === 'popup' ? '팝업' : cat} · ${site.label}`,
      });
    }
  }
  // 오래된 캐시 정리 (끝난 지 60일 지난 것, 오류 기록 30일 지난 것)
  for (const pages of Object.values(cache)) {
    for (const [id, p] of Object.entries(pages)) {
      if ((p.end && p.end < addDaysIso(today, -60)) || (p.err && now - p.t > 30 * DAY)) delete pages[id];
    }
  }
  writeJson(cacheFile(), cache);
  writeJson(statusFile(), status);
  ctx.popupStatus = status;
  ctx.popupSkippedNetwork = skipNet;
  if (!skipNet && status.sites.length && status.sites.every((s) => s.state === 'blocked' || s.state === 'error')) {
    throw new Error(status.sites.map((s) => `${s.label}: ${s.message}`).join(' / '));
  }
  return items;
}

function addDaysIso(isoDate, n) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
