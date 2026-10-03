// 캘린더 앱용 행사 스냅샷 (data/events.json)
// 매 실행마다 조건을 통과한 전체 행사를 저장한다. 지난 행사도 일정 기간 남겨서 캘린더를 과거로 스크롤해도 보이게 한다.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, addDays } from './util.mjs';

export const KEEP_PAST_DAYS = 120;
export const eventsFile = () => path.join(ROOT, 'data', 'events.json');

export function loadEvents(file = eventsFile()) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function buildSnapshot(items, { state, today, prev, labelOf = (id) => id, endingSoonDays = 7 }) {
  const map = new Map();
  const cutoff = addDays(today, -KEEP_PAST_DAYS);
  for (const e of prev?.events || []) {
    if (e.end && e.end < cutoff) continue;
    map.set(e.key, { ...e, current: false });
  }
  for (const it of items) {
    const old = map.get(it.key);
    map.set(it.key, {
      key: it.key,
      title: it.title,
      category: it.category || '',
      source: it.source,
      sourceLabel: it.sourceLabel || labelOf(it.source),
      info: it.info || null,
      start: it.start || null,
      end: it.end || null,
      time: it.time || null,
      place: it.place || null,
      price: it.price ?? null,
      priceText: it.priceText || '',
      paidUnknown: !!it.paidUnknown,
      url: it.url || null,
      image: it.image || null,
      openRun: !!it.openRun,
      sent: !!state.seen[it.key],
      firstSeen: state.seen[it.key]?.first || old?.firstSeen || today,
      current: true,
    });
  }
  const events = [...map.values()].sort((a, b) => (a.start || '').localeCompare(b.start || '') || a.title.localeCompare(b.title));
  return { updatedAt: new Date().toISOString(), today, endingSoonDays, events };
}

export function saveEvents(snapshot, file = eventsFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot));
  fs.renameSync(tmp, file); // 캘린더가 쓰는 도중의 파일을 읽지 않도록 교체 방식으로 저장
}
