// 대한민국 공휴일 (한국천문연구원 특일 정보, 공공데이터포털 키 사용 — 별도 활용신청 필요)
// 올해·내년 공휴일을 받아 data/holidays.json 에 저장. 실패하면 이전에 받아 둔 목록을 그대로 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, toISO, log } from './util.mjs';
import { getText, parseApiResponse } from './http.mjs';

const URL_ = 'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo';
export const holidaysFile = () => path.join(ROOT, 'data', 'holidays.json');

export function loadHolidays() {
  try {
    return JSON.parse(fs.readFileSync(holidaysFile(), 'utf8'));
  } catch {
    return { updatedAt: null, days: [] };
  }
}

export function toHolidayList(items) {
  const map = new Map();
  for (const it of items) {
    if (it.isHoliday && it.isHoliday !== 'Y') continue;
    const date = toISO(it.locdate);
    if (!date || !it.dateName) continue;
    const prev = map.get(date);
    map.set(date, prev && !prev.includes(it.dateName) ? `${prev} · ${it.dateName}` : it.dateName);
  }
  return [...map.entries()].sort().map(([date, name]) => ({ date, name }));
}

async function fetchYear(key, year) {
  const res = await getText(URL_, { ServiceKey: key, solYear: year, numOfRows: 100, _type: 'json' }, { retries: 2, retryDelayMs: 5000 });
  let { items } = parseApiResponse(res);
  if (items.length === 0) {
    // 연 단위 조회가 안 되는 경우 월별로
    items = [];
    for (let m = 1; m <= 12; m++) {
      const r = await getText(URL_, { ServiceKey: key, solYear: year, solMonth: String(m).padStart(2, '0'), numOfRows: 50, _type: 'json' }, { retries: 1 });
      items.push(...parseApiResponse(r).items);
    }
  }
  return items;
}

export async function refreshHolidays(cfg, today) {
  const prev = loadHolidays();
  if (!cfg.dataGoKrKey || cfg.holidays === false) return prev;
  const y = Number(today.slice(0, 4));
  try {
    const items = [...(await fetchYear(cfg.dataGoKrKey, y)), ...(await fetchYear(cfg.dataGoKrKey, y + 1))];
    const data = { updatedAt: new Date().toISOString(), days: toHolidayList(items), error: null };
    fs.mkdirSync(path.dirname(holidaysFile()), { recursive: true });
    fs.writeFileSync(holidaysFile(), JSON.stringify(data));
    log(`공휴일: ${data.days.length}일`);
    return data;
  } catch (err) {
    log('공휴일 조회 실패 —', err.message);
    const data = { ...prev, error: err.message };
    try {
      fs.mkdirSync(path.dirname(holidaysFile()), { recursive: true });
      fs.writeFileSync(holidaysFile(), JSON.stringify(data));
    } catch {}
    return data;
  }
}
