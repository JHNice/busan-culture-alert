// 캘린더 배치 계산 (DOM 없음 → Node 테스트 가능)
// 날짜는 모두 'YYYY-MM-DD' 문자열. 주는 일요일 시작.

export function iso(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
export function parse(s) {
  return new Date(s + 'T00:00:00Z');
}
export function addDays(s, n) {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
export function diffDays(a, b) {
  return Math.round((parse(a) - parse(b)) / 86400000);
}
export function weekStart(s) {
  return addDays(s, -parse(s).getUTCDay());
}
export function localToday(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// 행사 분류 → 색/필터 그룹
export const GROUPS = [
  { id: 'festival', label: '축제' },
  { id: 'show', label: '공연·행사' },
  { id: 'exhibit', label: '전시' },
  { id: 'popup', label: '팝업' },
  { id: 'movie', label: '영화 개봉' },
  { id: 'cultureDay', label: '문화가 있는 날' },
  { id: 'mine', label: '내 일정' },
  { id: 'etc', label: '기타' },
];
export function groupOf(e) {
  if (e.source === 'custom') return e.kind === 'popup' ? 'popup' : 'mine';
  if (e.source === 'popups') return /공연/.test(e.category) ? 'show' : /축제/.test(e.category) ? 'festival' : e.category === '전시' ? 'exhibit' : 'popup';
  if (e.source === 'movies') return 'movie';
  if (e.source === 'tourFestival') return 'festival';
  if (e.source === 'busanCultureDay') return 'cultureDay';
  if (e.source === 'busanEtc' || e.source === 'kopis') return 'show';
  if (/전시/.test(e.category || '') || e.source === 'busanExhibit') return 'exhibit';
  return 'etc';
}
// 짧고 놓치기 쉬운 행사를 위쪽 줄에 먼저 배치. 3주 넘게 하는 장기 행사는 분류와 관계없이 뒤로.
export const LONG_DAYS = 21;
const PRIORITY = { mine: 0, festival: 0, show: 1, popup: 1, cultureDay: 1, movie: 2, etc: 2, exhibit: 3 };

// 표시용 기간 (시작/종료가 비어 있으면 보정)
export function span(e) {
  const start = e.start || e.end || e.firstSeen;
  const end = e.end && e.end >= start ? e.end : start;
  return { start, end };
}

export function isFree(e) {
  return e.price === 0;
}

export function priceLabel(e) {
  if (e.price === 0) return '무료';
  if (e.price != null) return `${e.price.toLocaleString('ko-KR')}원`;
  if (e.priceText) return e.priceText;
  return '요금 정보 없음';
}

// 한 주에 걸친 막대 배치: lane(줄) 번호를 정하고, 줄이 모자라면 날짜별 '+N' 으로 센다
export function layoutWeek(events, weekStartIso, maxLanes, favs = null) {
  const weekEnd = addDays(weekStartIso, 6);
  const inWeek = [];
  for (const e of events) {
    const { start, end } = span(e);
    if (!start || end < weekStartIso || start > weekEnd) continue;
    const s = start < weekStartIso ? weekStartIso : start;
    const t = end > weekEnd ? weekEnd : end;
    inWeek.push({
      e,
      col: diffDays(s, weekStartIso),
      endCol: diffDays(t, weekStartIso),
      contLeft: start < weekStartIso,
      contRight: end > weekEnd,
      len: diffDays(end, start) + 1,
      pri: PRIORITY[groupOf(e)] ?? 2,
      long: diffDays(end, start) + 1 > LONG_DAYS,
      fav: !!favs?.has(e.key),
    });
  }
  // 즐겨찾기 → 짧은 행사 → 분류 우선순위 → 기간 짧은 순
  inWeek.sort((a, b) => b.fav - a.fav || a.long - b.long || a.pri - b.pri || a.len - b.len || a.col - b.col || a.e.title.localeCompare(b.e.title));

  const lanes = []; // lanes[l] = 7칸 사용 여부
  const bars = [];
  const more = [0, 0, 0, 0, 0, 0, 0];
  const count = [0, 0, 0, 0, 0, 0, 0];
  for (const b of inWeek) {
    for (let c = b.col; c <= b.endCol; c++) count[c]++;
    let lane = -1;
    for (let l = 0; l < maxLanes; l++) {
      lanes[l] ||= Array(7).fill(false);
      let free = true;
      for (let c = b.col; c <= b.endCol; c++) if (lanes[l][c]) { free = false; break; }
      if (free) { lane = l; break; }
    }
    if (lane < 0) {
      for (let c = b.col; c <= b.endCol; c++) more[c]++;
      continue;
    }
    for (let c = b.col; c <= b.endCol; c++) lanes[lane][c] = true;
    bars.push({ ...b, lane });
  }
  bars.sort((a, b) => a.lane - b.lane || a.col - b.col);
  return { bars, more, count };
}

// 특정 날짜에 열리는 행사 (하단 목록용): 오늘 시작 → 마감 임박 → 진행 중
export function eventsOn(events, day, endingSoonDays = 7) {
  const list = events.filter((e) => {
    const { start, end } = span(e);
    return start <= day && day <= end;
  });
  const rank = (e) => {
    const { start, end } = span(e);
    if (start === day) return 0;
    const left = diffDays(end, day);
    if (start !== end && left <= endingSoonDays) return 1;
    return 2;
  };
  return list
    .map((e) => ({ e, r: rank(e) }))
    .sort((a, b) => a.r - b.r || (PRIORITY[groupOf(a.e)] ?? 2) - (PRIORITY[groupOf(b.e)] ?? 2) || span(a.e).end.localeCompare(span(b.e).end))
    .map((x) => ({ ...x.e, _rank: x.r }));
}

export function matchesFilter(e, { groups, freeOnly, query, favOnly }, favs = null) {
  if (favOnly && !favs?.has(e.key)) return false;
  if (groups && groups.size && !groups.has(groupOf(e))) return false;
  if (freeOnly && !isFree(e)) return false;
  if (query) {
    const q = query.trim().toLowerCase();
    if (q && !`${e.title} ${e.place || ''}`.toLowerCase().includes(q)) return false;
  }
  return true;
}
