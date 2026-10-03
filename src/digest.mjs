// 앞으로 N일 일정 + 즐겨찾기 요약 (로컬 API /api/week 와 GitHub Gist 공개에 공통 사용)
// 규칙은 캘린더와 같다: 숨긴 항목 제외, 영화는 즐겨찾기한 것만, 직접 추가한 일정 포함.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, addDays, diffDays } from './util.mjs';

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const readJson = (name, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', name), 'utf8'));
  } catch {
    return fallback;
  }
};

export function loadAll() {
  return {
    snapshot: readJson('events.json', { events: [] }),
    favorites: readJson('favorites.json', { items: {} }).items || {},
    hidden: readJson('hidden.json', { items: {} }).items || {},
    custom: readJson('custom-events.json', { events: [] }).events || [],
    holidays: readJson('holidays.json', { days: [] }).days || [],
  };
}

export function groupLabel(e) {
  if (e.source === 'custom') return e.kind === 'popup' ? '팝업' : '내 일정';
  if (e.source === 'movies') return '영화';
  if (e.source === 'tourFestival' || /축제/.test(e.category || '')) return '축제';
  if (e.source === 'busanCultureDay') return '문화가 있는 날';
  if (e.source === 'popups' && /팝업/.test(e.category || '')) return '팝업';
  if (e.source === 'busanEtc' || e.source === 'kopis' || /공연/.test(e.category || '')) return '공연';
  if (/전시/.test(e.category || '') || e.source === 'busanExhibit') return '전시';
  return e.category || '기타';
}

function span(e) {
  const start = e.start || e.end || e.firstSeen;
  const end = e.end && e.end >= start ? e.end : start;
  return { start, end };
}
const md = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
const mdw = (s) => `${md(s)}(${DOW[new Date(s + 'T00:00:00Z').getUTCDay()]})`;
function priceText(e) {
  if (e.price === 0) return '무료';
  if (e.price != null) return `${e.price.toLocaleString('ko-KR')}원`;
  return null;
}

function view(e, today, favs) {
  const { start, end } = span(e);
  return {
    key: e.key,
    title: e.title,
    type: groupLabel(e),
    start,
    end,
    time: e.time || null,
    place: e.place || null,
    info: e.info || null,
    price: priceText(e),
    url: e.url || null,
    source: e.sourceLabel || e.source,
    favorite: favs.has(e.key),
    startsInDays: diffDays(start, today),
    endsInDays: diffDays(end, today),
  };
}

export function buildDigest({ snapshot, favorites, hidden, custom, holidays }, { today, days = 7 } = {}) {
  const last = addDays(today, days - 1);
  const favs = new Set(Object.keys(favorites));
  const base = snapshot.events || [];
  const keys = new Set(base.map((e) => e.key));
  const customEv = custom.map((e) => ({ ...e, source: 'custom' }));
  customEv.forEach((e) => keys.add(e.key));
  // 수집 목록에서 빠진 즐겨찾기도 저장해 둔 정보로 포함
  const orphanFavs = Object.values(favorites).filter((f) => !keys.has(f.key) && f.title && (f.start || f.end));
  const pool = [...base, ...customEv, ...orphanFavs].filter((e) => !hidden[e.key] && span(e).start);
  const visible = pool.filter((e) => e.source !== 'movies' || favs.has(e.key));

  const inRange = visible
    .filter((e) => {
      const s = span(e);
      return s.start <= last && s.end >= today;
    })
    .map((e) => view(e, today, favs))
    .sort((a, b) => b.favorite - a.favorite || a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.title.localeCompare(b.title));

  const hol = new Map(holidays.map((h) => [h.date, h.name]));
  const dayList = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(today, i);
    const on = inRange.filter((e) => e.start <= d && d <= e.end);
    dayList.push({
      date: d,
      weekday: DOW[new Date(d + 'T00:00:00Z').getUTCDay()],
      holiday: hol.get(d) || null,
      starting: on.filter((e) => e.start === d),
      ending: on.filter((e) => e.end === d && e.start !== d),
      ongoingCount: on.length,
    });
  }

  const favoritesList = pool
    .filter((e) => favs.has(e.key) && span(e).end >= today)
    .map((e) => view(e, today, favs))
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));

  return {
    generatedAt: new Date().toISOString(),
    dataUpdatedAt: snapshot.updatedAt || null,
    today,
    range: { from: today, to: last, days },
    counts: { events: inRange.length, favorites: favoritesList.length, favoritesThisWeek: inRange.filter((e) => e.favorite).length },
    days: dayList,
    events: inRange,
    favorites: favoritesList,
  };
}

// 단축어·클로드에 바로 넘기기 좋은 한국어 요약
export function digestText(dg, { maxOngoing = 15 } = {}) {
  const L = [];
  const item = (e, extra = '') => {
    const bits = [e.place, e.info, e.price].filter(Boolean).join(' · ');
    return `${e.favorite ? '★' : '-'} [${e.type}] ${e.title}${e.time ? ` (${e.time})` : ''}${bits ? ` — ${bits}` : ''}${extra}`;
  };
  const period = (e) => (e.start === e.end ? mdw(e.start) : `${mdw(e.start)}~${mdw(e.end)}`);

  L.push(`📅 부산 문화 일정 ${mdw(dg.range.from)} ~ ${mdw(dg.range.to)}`);
  L.push(`이번 기간 일정 ${dg.counts.events}개 · 즐겨찾기 ${dg.counts.favorites}개`);
  L.push('');
  L.push(`★ 즐겨찾기 (${dg.favorites.length})`);
  if (!dg.favorites.length) L.push('- 없음');
  for (const e of dg.favorites) {
    const oneDay = e.start === e.end;
    const verb = e.type === '영화' ? '개봉' : oneDay ? '' : '시작';
    const when = e.startsInDays > 0 ? `${e.startsInDays}일 뒤${verb ? ' ' + verb : ''}` : oneDay ? `오늘${verb ? ' ' + verb : ''}` : e.endsInDays === 0 ? '오늘 마감' : `마감 D-${e.endsInDays}`;
    L.push(`${item(e)} | ${period(e)} (${when})`);
  }
  for (const d of dg.days) {
    L.push('');
    const rel = d.date === dg.today ? '오늘 ' : '';
    L.push(`■ ${rel}${mdw(d.date)}${d.holiday ? ` 🎌${d.holiday}` : ''} — 진행 중 ${d.ongoingCount}개`);
    for (const e of d.starting) L.push(`  시작 ${item(e, e.end !== e.start ? ` (~${md(e.end)})` : '')}`);
    for (const e of d.ending) L.push(`  마감 ${item(e)}`);
    if (!d.starting.length && !d.ending.length) L.push('  새로 시작·마감하는 일정 없음');
  }
  const ongoing = dg.events.filter((e) => e.start < dg.today);
  if (ongoing.length) {
    L.push('');
    L.push(`▶ 이미 진행 중인 일정 ${ongoing.length}개${ongoing.length > maxOngoing ? ` (마감 빠른 순 ${maxOngoing}개)` : ''}`);
    for (const e of [...ongoing].sort((a, b) => a.end.localeCompare(b.end)).slice(0, maxOngoing)) L.push(`${item(e)} | ~${mdw(e.end)}`);
  }
  L.push('');
  L.push(`(데이터 기준 ${dg.dataUpdatedAt ? new Date(dg.dataUpdatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-'})`);
  return L.join('\n');
}
