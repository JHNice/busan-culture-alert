import {
  addDays, diffDays, weekStart, localToday, parse, GROUPS, groupOf, span, isFree, priceLabel,
  layoutWeek, eventsOn, matchesFilter,
} from './layout.js';

const $ = (s) => document.querySelector(s);
const scroller = $('#scroller');
const weeksEl = $('#weeks');
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const CHUNK = 10; // 한 번에 덧붙이는 주 수

const state = {
  data: null,
  mtime: 0,
  custom: [], // 직접 추가한 일정
  favs: {}, // key → 저장된 행사 정보
  favSet: new Set(),
  hidden: {}, // key → 숨긴 행사 정보 ('관심 없음')
  hiddenSet: new Set(),
  holidays: new Map(), // date → 이름
  popupStatus: null,
  all: [], // 전체 (수집 + 직접 추가 + 목록에서 사라진 즐겨찾기)
  events: [], // 필터 적용 후
  filters: loadFilters(),
  first: null, // 렌더된 첫 주(일요일)
  last: null,
  lanes: 6,
  rowH: 196,
  today: localToday(),
};

// ---------- 유틸 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const md = (s) => { const d = parse(s); return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`; };
const mdw = (s) => `${md(s)} (${DOW[parse(s).getUTCDay()]})`;
const short = (s) => { const d = parse(s); return `${d.getUTCMonth() + 1}.${d.getUTCDate()}`; };
function period(e) {
  const { start, end } = span(e);
  let t = start === end ? mdw(start) : `${short(start)} (${DOW[parse(start).getUTCDay()]}) ~ ${short(end)} (${DOW[parse(end).getUTCDay()]})`;
  if (e.time) t += ` · ${e.time}`;
  return t;
}
function dday(e) {
  const { start, end } = span(e);
  if (e.source === 'movies') {
    const d = diffDays(start, state.today);
    return d > 0 ? { text: `개봉 D-${d}`, cls: '' } : { text: d === 0 ? '오늘 개봉' : '개봉함', cls: '' };
  }
  const left = diffDays(end, state.today);
  if (left < 0) return { text: '종료', cls: '' };
  if (left === 0) return { text: '오늘 마감', cls: 'red' };
  return { text: `D-${left}`, cls: left <= (state.data?.endingSoonDays ?? 7) ? 'red' : '' };
}
// 가장 최근 수집에서 처음 발견된 행사
const isNew = (e) => !!e.firstSeen && e.firstSeen === (state.data?.today || state.today);
const isFav = (e) => state.favSet.has(e.key);
const searchUrl = (e) => `https://search.naver.com/search.naver?query=${encodeURIComponent(`${e.title} ${e.place || '부산'}`)}`;
const mapUrl = (e) => `https://map.naver.com/p/search/${encodeURIComponent(e.place || e.title)}`;
const groupLabel = (e) => GROUPS.find((x) => x.id === groupOf(e))?.label || e.category;
const findEvent = (key) => (state.pool || []).find((x) => x.key === key) || state.hidden[key];

function toast(msg, ms = 3500, action = null) {
  const t = $('#toast');
  t.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-act';
    b.textContent = action.label;
    b.onclick = () => {
      t.hidden = true;
      action.run();
    };
    t.append(' ', b);
  }
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function loadFilters() {
  try {
    const f = JSON.parse(localStorage.getItem('bca.filters') || '{}');
    return { groups: new Set(f.groups || []), freeOnly: !!f.freeOnly, favOnly: !!f.favOnly, query: '' };
  } catch {
    return { groups: new Set(), freeOnly: false, favOnly: false, query: '' };
  }
}
function saveFilters() {
  try {
    const f = state.filters;
    localStorage.setItem('bca.filters', JSON.stringify({ groups: [...f.groups], freeOnly: f.freeOnly, favOnly: f.favOnly }));
  } catch {}
}

// ---------- 크기: 세로 화면이면 줄을 더 많이 ----------
function measure() {
  const portrait = innerHeight > innerWidth * 1.1;
  const lanes = portrait ? (innerHeight > 1500 ? 6 : 5) : 4;
  const rowH = 30 + lanes * 26 + 24;
  const changed = lanes !== state.lanes || rowH !== state.rowH;
  state.lanes = lanes;
  state.rowH = rowH;
  document.documentElement.style.setProperty('--row-h', `${rowH}px`);
  weeksEl.style.setProperty('--lanes', lanes);
  return changed;
}

// ---------- 주 렌더링 ----------
function renderWeek(ws) {
  const row = document.createElement('div');
  row.className = 'week';
  row.dataset.ws = ws;
  const { bars, more } = layoutWeek(state.events, ws, state.lanes, state.favSet);
  let html = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    const day = Number(d.slice(8));
    const hol = state.holidays.get(d);
    const cls = ['day', i === 0 ? 'sun' : i === 6 ? 'sat' : '', hol ? 'holiday' : '', d === state.today ? 'today' : '', d < state.today ? 'past' : '', day === 1 ? 'first' : ''].filter(Boolean).join(' ');
    const label = day === 1 ? `<span class="mlabel">${Number(d.slice(5, 7))}월</span>` : '';
    const holName = hol ? `<span class="hol" title="${esc(hol)}">${esc(hol)}</span>` : '';
    html += `<div class="${cls}" data-date="${d}" data-m="${d.slice(0, 7)}" style="grid-column:${i + 1}" tabindex="-1">${label}<span class="num">${day}</span>${holName}</div>`;
  }
  for (const b of bars) {
    const e = b.e;
    const g = groupOf(e);
    const fav = isFav(e);
    const single = b.col === b.endCol && !b.contLeft && !b.contRight;
    const { start, end } = span(e);
    const left = diffDays(end, state.today);
    const soon = !b.contRight && left >= 0 && left <= (state.data?.endingSoonDays ?? 7) && start !== end;
    const cls = ['ev', `g-${g}`, fav ? 'fav' : '', b.contLeft ? 'cl' : '', b.contRight ? 'cr' : '', single ? 'single' : '', end < state.today ? 'past' : ''].filter(Boolean).join(' ');
    const star = fav && !b.contLeft ? '<span class="s">★</span>' : '';
    const badge = soon ? `<span class="b">${left === 0 ? '오늘' : 'D-' + left}</span>` : isNew(e) && !b.contLeft ? '<span class="n" title="새로 올라옴"></span>' : '';
    html += `<button class="${cls}" data-key="${esc(e.key)}" style="grid-column:${b.col + 1}/${b.endCol + 2};grid-row:${b.lane + 2}" title="${esc(e.title)}\n${esc(period(e))}\n${esc(e.place || e.info || '')}">${star}<span class="t">${esc(e.title)}</span>${badge}</button>`;
  }
  more.forEach((n, i) => {
    if (n > 0) html += `<div class="more" data-date="${addDays(ws, i)}" style="grid-column:${i + 1}">+${n}개 더</div>`;
  });
  row.innerHTML = html;
  return row;
}

function renderRange(first, last) {
  const frag = document.createDocumentFragment();
  for (let ws = first; ws <= last; ws = addDays(ws, 7)) frag.appendChild(renderWeek(ws));
  return frag;
}

function renderAll({ keepScroll = true } = {}) {
  const top = scroller.scrollTop;
  weeksEl.replaceChildren(renderRange(state.first, state.last));
  if (keepScroll) scroller.scrollTop = top;
  updateMonth();
}

function prepend() {
  const newFirst = addDays(state.first, -7 * CHUNK);
  const before = scroller.scrollHeight;
  weeksEl.prepend(renderRange(newFirst, addDays(state.first, -7)));
  state.first = newFirst;
  scroller.scrollTop += scroller.scrollHeight - before;
}
function append() {
  const newLast = addDays(state.last, 7 * CHUNK);
  weeksEl.append(renderRange(addDays(state.last, 7), newLast));
  state.last = newLast;
}

let ticking = false;
scroller.addEventListener('scroll', () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    const margin = scroller.clientHeight * 1.2;
    if (scroller.scrollTop < margin) prepend();
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < margin) append();
    updateMonth();
  });
});

// 화면 1/3 지점의 주가 속한 달을 제목으로, 다른 달 날짜는 흐리게
const focusStyle = document.createElement('style');
document.head.appendChild(focusStyle);
function updateMonth() {
  const idx = Math.max(0, Math.floor((scroller.scrollTop + scroller.clientHeight / 3) / state.rowH));
  const ws = addDays(state.first, idx * 7);
  const thu = addDays(ws, 4);
  const [y, m] = thu.split('-');
  const key = `${y}-${m}`;
  if (updateMonth.key === key) return;
  updateMonth.key = key;
  $('#monthLabel').innerHTML = `<span class="yr">${y}년</span> ${Number(m)}월`;
  document.title = `${y}년 ${Number(m)}월 · 부산 문화 캘린더`;
  focusStyle.textContent = `.day:not([data-m="${key}"]){background:color-mix(in srgb,var(--bg-2) 45%,transparent)}.day:not([data-m="${key}"]) .num,.day:not([data-m="${key}"]) .mlabel,.day:not([data-m="${key}"]) .hol{color:var(--faint)}.day.today .num{color:#fff}`;
}

function scrollToDate(d, smooth = false) {
  const ws = weekStart(d);
  if (ws < state.first || ws > state.last) {
    state.first = addDays(ws, -7 * CHUNK);
    state.last = addDays(ws, 7 * CHUNK * 2);
    renderAll({ keepScroll: false });
  }
  const idx = diffDays(ws, state.first) / 7;
  scroller.scrollTo({ top: Math.max(0, (idx - 1) * state.rowH), behavior: smooth ? 'smooth' : 'auto' });
  updateMonth.key = null;
  updateMonth();
}

// ---------- 데이터 합치기 + 필터 ----------
function rebuildAll() {
  const base = state.data?.events || [];
  const keys = new Set(base.map((e) => e.key));
  const custom = state.custom.map((e) => ({ ...e, source: 'custom' }));
  for (const e of custom) keys.add(e.key);
  // 수집 목록에서 빠진(오래 지난) 즐겨찾기도 저장해 둔 정보로 계속 표시
  const orphanFavs = Object.values(state.favs).filter((f) => !keys.has(f.key) && f.title && (f.start || f.end));
  state.pool = [...base, ...custom, ...orphanFavs]; // 숨긴 것 포함 전부 (전체 보기용)
  state.all = state.pool.filter((e) => !state.hiddenSet.has(e.key));
}
// 캘린더에는 영화는 즐겨찾기한 것만 (전체 보기에서 ★ 로 골라 넣는다)
const onCalendar = (e) => e.source !== 'movies' || isFav(e);

function applyFilters() {
  state.events = state.all.filter((e) => onCalendar(e) && matchesFilter(e, state.filters, state.favSet));
  const active = state.events.filter((e) => span(e).end >= state.today);
  const free = active.filter(isFree).length;
  const favCount = state.all.filter((e) => isFav(e) && span(e).end >= state.today).length;
  const movieCount = state.all.filter((e) => e.source === 'movies' && !isFav(e) && span(e).end >= state.today).length;
  const upd = state.data?.updatedAt ? new Date(state.data.updatedAt) : null;
  const updText = upd ? `${upd.getMonth() + 1}월 ${upd.getDate()}일 ${String(upd.getHours()).padStart(2, '0')}:${String(upd.getMinutes()).padStart(2, '0')}` : '-';
  const ps = state.popupStatus?.sites || [];
  const bad = ps.filter((s) => s.state === 'blocked' || s.state === 'error').length;
  const popupText = ps.length ? ` · <button class="linkish${bad ? ' warn' : ''}" id="btnPopupSites">팝업 사이트 ${bad ? `⚠ ${bad}곳 확인 필요` : `${ps.length}곳 정상`}</button>` : '';
  const hidCount = state.hiddenSet.size;
  const hidText = hidCount ? ` · <button class="linkish" id="btnHidden">숨김 ${hidCount}개</button>` : '';
  const movieText = movieCount ? ` · <button class="linkish" data-browse="movie">영화 ${movieCount}편은 전체 보기에서 ★</button>` : '';
  const cl = state.data?.cloud;
  const cloudText = cl ? (cl.lastError ? ` · <b class="warn">☁ 클라우드 연결 오류</b>` : ' · ☁ 클라우드 수집(30분마다)') : '';
  $('#status').innerHTML = `진행·예정 <b>${active.length}</b>개 · 무료 <b>${free}</b>개 · ★ <b>${favCount}</b>개${hidText}${movieText} · 업데이트 ${updText}${cloudText}${popupText}` + (state.refreshing ? ' · <b>새로 불러오는 중…</b>' : '');
}

function buildChips() {
  const used = new Set(state.all.map(groupOf));
  const groups = GROUPS.filter((g) => used.has(g.id) || !['etc', 'mine', 'movie', 'popup'].includes(g.id));
  const f = state.filters;
  $('#chips').innerHTML =
    `<button class="chip all" data-g="" aria-pressed="${f.groups.size === 0}">전체</button>` +
    groups.map((g) => `<button class="chip g-${g.id}" data-g="${g.id}" aria-pressed="${f.groups.has(g.id)}"><i></i>${g.label}</button>`).join('');
  $('#freeOnly').checked = f.freeOnly;
  $('#favOnly').checked = f.favOnly;
}

function refreshView() {
  rebuildAll();
  buildChips();
  applyFilters();
  renderAll();
  if (!$('#browse').hidden) renderBrowse();
}

$('#chips').addEventListener('click', (ev) => {
  const b = ev.target.closest('.chip');
  if (!b) return;
  const g = b.dataset.g;
  const set = state.filters.groups;
  if (!g) set.clear();
  else if (set.has(g)) set.delete(g);
  else set.add(g);
  saveFilters();
  buildChips();
  applyFilters();
  renderAll();
});
for (const id of ['freeOnly', 'favOnly']) {
  $('#' + id).addEventListener('change', (ev) => {
    state.filters[id] = ev.target.checked;
    saveFilters();
    applyFilters();
    renderAll();
  });
}
let searchTimer;
$('#search').addEventListener('input', (ev) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.filters.query = ev.target.value;
    applyFilters();
    renderAll();
  }, 180);
});

// ---------- 즐겨찾기 ----------
async function toggleFav(key) {
  const e = findEvent(key);
  if (!e) return;
  const on = !isFav(e);
  try {
    const j = await api('/api/favorites', { method: 'POST', body: JSON.stringify({ key, on, event: e }) });
    setFavs(j);
    toast(on ? '★ 즐겨찾기에 추가했습니다' : '즐겨찾기에서 뺐습니다', 1800);
    refreshView();
    return on;
  } catch (err) {
    toast('즐겨찾기 저장 실패: ' + err.message);
  }
}
async function setHidden(key, on) {
  const e = findEvent(key);
  if (!e) return;
  try {
    if (on && isFav(e)) setFavs(await api('/api/favorites', { method: 'POST', body: JSON.stringify({ key, on: false }) }));
    const j = await api('/api/hidden', { method: 'POST', body: JSON.stringify({ key, on, event: e }) });
    applyHidden(j);
    refreshView();
    if (on) toast(`'${e.title.length > 24 ? e.title.slice(0, 24) + '…' : e.title}' 숨김`, 6000, { label: '되돌리기', run: () => setHidden(key, false) });
    else toast('다시 보이게 했습니다', 1800);
  } catch (err) {
    toast('저장 실패: ' + err.message);
  }
}
function applyHidden(j) {
  state.hidden = j.items || {};
  state.hiddenSet = new Set(Object.keys(state.hidden));
}
function openHiddenList() {
  const list = Object.values(state.hidden).sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
  openSheet(
    `<h2>숨긴 항목 ${list.length}개</h2><div class="sub">'관심 없음'으로 숨긴 행사는 캘린더와 디스코드 알림에 나오지 않습니다.</div>
    <div class="sites">${list
      .map((e) => `<div class="site"><div class="body"><div class="title">${esc(e.title)}</div><div class="meta">${e.start ? esc(period(e)) + ' · ' : ''}${esc(e.sourceLabel || e.category || '')}</div></div>
        <button class="pill" data-unhide="${esc(e.key)}">다시 보기</button></div>`)
      .join('') || '<p class="sub">숨긴 항목이 없습니다.</p>'}</div>`,
    openHiddenList,
  );
}

function setFavs(j) {
  state.favs = j.items || {};
  state.favSet = new Set(Object.keys(state.favs));
}

// ---------- 하단 시트 ----------
function starBtn(e) {
  const on = isFav(e);
  return `<span class="star${on ? ' on' : ''}" role="button" tabindex="0" data-fav="${esc(e.key)}" title="${on ? '즐겨찾기 해제' : '즐겨찾기'}" aria-pressed="${on}">${on ? '★' : '☆'}</span>`;
}
function tagsHtml(e) {
  const dd = dday(e);
  return [
    `<span class="tag">${esc(groupLabel(e))}</span>`,
    isFree(e) ? '<span class="tag green">무료</span>' : '',
    dd.cls ? `<span class="tag red">${dd.text}</span>` : '',
    isNew(e) ? '<span class="tag red">NEW</span>' : '',
    e.source === 'custom' ? '<span class="tag">직접 추가</span>' : '',
  ].join('');
}
function card(e) {
  const g = groupOf(e);
  const dd = dday(e);
  const img = e.image ? `<img src="${esc(e.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
  const price = e.source === 'movies' || e.source === 'custom' ? '' : `<br>💰 ${esc(priceLabel(e))}`;
  return `<div class="card g-${g}${isFav(e) ? ' fav' : ''}" data-key="${esc(e.key)}" role="button" tabindex="0">${img}<div class="body"><div class="tags">${tagsHtml(e)}</div><div class="title">${esc(e.title)}</div>
    <div class="meta">🗓 ${esc(period(e))} · <b>${dd.text}</b>${e.place ? `<br>📍 ${esc(e.place)}` : ''}${e.info ? `<br>🎬 ${esc(e.info)}` : ''}${price}</div></div>
    <div class="cardbtns">${starBtn(e)}${e.source === 'custom' ? '' : `<span class="hide" role="button" tabindex="0" data-hide="${esc(e.key)}" title="관심 없음 (숨기기)">✕</span>`}</div></div>`;
}

let sheetView = null; // 다시 그리기용 (즐겨찾기 토글 후)
function openSheet(html, view = null) {
  sheetView = view;
  $('#sheetBody').innerHTML = html;
  $('#sheet').hidden = false;
  $('#backdrop').hidden = false;
}
function closeSheet() {
  sheetView = null;
  $('#sheet').hidden = true;
  $('#backdrop').hidden = true;
}
function rerenderSheet() {
  if (!sheetView) return;
  const top = $('#sheet').scrollTop;
  sheetView();
  $('#sheet').scrollTop = top;
}

function openDay(d) {
  const list = eventsOn(state.events, d, state.data?.endingSoonDays ?? 7);
  const favFirst = (l) => [...l.filter(isFav), ...l.filter((e) => !isFav(e))];
  const sections = [
    ['이날 시작', favFirst(list.filter((e) => e._rank === 0))],
    ['마감 임박', favFirst(list.filter((e) => e._rank === 1))],
    ['진행 중', favFirst(list.filter((e) => e._rank === 2))],
  ].filter(([, l]) => l.length);
  const rel = diffDays(d, state.today);
  const relText = rel === 0 ? '오늘' : rel === 1 ? '내일' : rel > 0 ? `${rel}일 뒤` : `${-rel}일 전`;
  const hol = state.holidays.get(d);
  const f = state.filters;
  openSheet(
    `<h2>${mdw(d)}${hol ? ` <span class="holtag">${esc(hol)}</span>` : ''}</h2><div class="sub">${relText} · 일정 ${list.length}개${f.groups.size || f.freeOnly || f.favOnly || f.query ? ' (필터 적용 중)' : ''}
      <button class="pill small" data-add="${d}">+ 이날 일정 추가</button></div>` +
      (sections.length
        ? sections.map(([t, l]) => `<h3>${t} · ${l.length}</h3><div class="cards">${l.map(card).join('')}</div>`).join('')
        : '<p class="sub">이날 열리는 행사가 없습니다.</p>'),
    () => openDay(d),
  );
}

function openEvent(key) {
  const e = findEvent(key);
  if (!e) return;
  const g = groupOf(e);
  const dd = dday(e);
  const link = e.url || searchUrl(e);
  const custom = e.source === 'custom';
  const on = isFav(e);
  openSheet(
    `<div class="detail g-${g}">
    ${e.image ? `<img src="${esc(e.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
    <div style="flex:1;min-width:0">
      <div class="tags">${tagsHtml(e)}</div>
      <h2>${on ? '<span class="favmark">★</span> ' : ''}${esc(e.title)}</h2>
      <dl>
        <dt>기간</dt><dd>${esc(period(e))} <b>${dd.text}</b></dd>
        ${e.place ? `<dt>장소</dt><dd>${esc(e.place)}</dd>` : ''}
        ${e.info ? `<dt>정보</dt><dd>${esc(e.info)}</dd>` : ''}
        ${e.memo ? `<dt>메모</dt><dd class="memo">${esc(e.memo)}</dd>` : ''}
        ${!custom && e.source !== 'movies' ? `<dt>요금</dt><dd>${esc(priceLabel(e))}${e.priceText && e.priceText !== priceLabel(e) ? ` <span class="sub">(${esc(e.priceText)})</span>` : ''}</dd>` : ''}
        <dt>출처</dt><dd>${esc(e.sourceLabel || e.source)}</dd>
      </dl>
      <div class="links">
        <button class="pill favbtn${on ? ' on' : ''}" data-fav="${esc(e.key)}">${on ? '★ 즐겨찾기 해제' : '☆ 즐겨찾기'}</button>
        <a class="pill primary" href="${esc(link)}" target="_blank" rel="noopener">${e.url ? '상세 페이지' : '검색하기'}</a>
        ${e.place ? `<a class="pill" href="${esc(mapUrl(e))}" target="_blank" rel="noopener">지도</a>` : ''}
        ${e.url && !custom ? `<a class="pill" href="${esc(searchUrl(e))}" target="_blank" rel="noopener">검색</a>` : ''}
        ${custom ? `<button class="pill" data-edit="${esc(e.key)}">수정</button><button class="pill danger" data-del="${esc(e.key)}">삭제</button>` : `<button class="pill danger" data-hide="${esc(e.key)}">관심 없음 (숨기기)</button>`}
      </div>
    </div></div>`,
    () => openEvent(key),
  );
}

// ---------- 직접 추가 / 수정 ----------
function openForm(e = null, date = null) {
  const d0 = date || state.today;
  const v = e || { kind: 'popup', start: d0, end: d0 };
  openSheet(`<h2>${e ? '일정 수정' : '일정 직접 추가'}</h2>
    <div class="sub">팝업스토어나 개인 일정을 캘린더에 넣습니다. 이 PC의 프로젝트 폴더(data/custom-events.json)에 저장됩니다.</div>
    <form id="evForm" class="form" autocomplete="off">
      <div class="seg" role="radiogroup">
        <label><input type="radio" name="kind" value="popup" ${v.kind === 'popup' ? 'checked' : ''}><span class="g-popup"><i></i>팝업스토어</span></label>
        <label><input type="radio" name="kind" value="mine" ${v.kind !== 'popup' ? 'checked' : ''}><span class="g-mine"><i></i>내 일정</span></label>
      </div>
      <label>제목 *<input name="title" required maxlength="200" value="${esc(v.title || '')}" placeholder="예: ○○ 팝업스토어 in 부산"></label>
      <div class="row2">
        <label>시작일 *<input type="date" name="start" required value="${esc(v.start || d0)}"></label>
        <label>종료일<input type="date" name="end" value="${esc(v.end || v.start || d0)}"></label>
      </div>
      <label>시간<input name="time" maxlength="60" value="${esc(v.time || '')}" placeholder="예: 11:00-20:00"></label>
      <label>장소<input name="place" maxlength="200" value="${esc(v.place || '')}" placeholder="예: 신세계 센텀시티 1층"></label>
      <label>링크<input name="url" maxlength="500" value="${esc(v.url || '')}" placeholder="https://"></label>
      <label>메모<textarea name="memo" rows="3" maxlength="1000">${esc(v.memo || '')}</textarea></label>
      <div class="links"><button class="pill primary" type="submit">${e ? '저장' : '추가'}</button><button class="pill" type="button" data-close>취소</button></div>
    </form>`);
  const form = $('#evForm');
  form.start.addEventListener('change', () => {
    if (!form.end.value || form.end.value < form.start.value) form.end.value = form.start.value;
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    if (e) body.key = e.key;
    try {
      const j = await api('/api/custom', { method: 'POST', body: JSON.stringify(body) });
      state.custom = j.events || [];
      refreshView();
      toast(e ? '저장했습니다' : '추가했습니다', 1800);
      openEvent(j.saved);
      scrollToDate(body.start, true);
    } catch (err) {
      toast('저장 실패: ' + err.message);
    }
  });
  setTimeout(() => form.title.focus(), 50);
}

async function deleteCustom(key) {
  const e = findEvent(key);
  if (!e) return;
  const btn = $(`[data-del="${CSS.escape(key)}"]`);
  // 확인 대화상자 대신 버튼을 한 번 더 누르게 한다
  if (btn && !btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = '정말 삭제?';
    setTimeout(() => {
      if (btn.isConnected) {
        delete btn.dataset.armed;
        btn.textContent = '삭제';
      }
    }, 3000);
    return;
  }
  try {
    const j = await api('/api/custom?id=' + encodeURIComponent(key), { method: 'DELETE' });
    state.custom = j.events || [];
    if (isFav(e)) setFavs(await api('/api/favorites', { method: 'POST', body: JSON.stringify({ key, on: false }) }));
    closeSheet();
    refreshView();
    toast('삭제했습니다', 1800);
  } catch (err) {
    toast('삭제 실패: ' + err.message);
  }
}

// ---------- 팝업 사이트 상태 ----------
function openPopupSites() {
  const st = state.popupStatus;
  const when = st?.checkedAt ? new Date(st.checkedAt).toLocaleString('ko-KR') : '-';
  const label = { ok: ['정상', 'green'], partial: ['일부 읽음', ''], blocked: ['막힘', 'red'], error: ['오류', 'red'] };
  openSheet(`<h2>팝업스토어 자동 수집</h2>
    <div class="sub">마지막 확인 ${esc(when)} · 부산 지역만 표시 · 막힌 사이트는 직접 열어서 확인하고 '직접 추가'로 넣을 수 있습니다.</div>
    <div class="sites">${(st?.sites || [])
      .map((s) => {
        const [t, c] = label[s.state] || [s.state, ''];
        return `<div class="site"><div class="body"><div class="title">${esc(s.label)} <span class="tag ${c}">${t}</span></div>
          <div class="meta">목록 ${s.listed ?? 0}개 · 이번에 읽음 ${s.fetched ?? 0}개 · 부산 ${s.matched ?? 0}개${s.message ? `<br>${esc(s.message)}` : ''}</div></div>
          <a class="pill${s.state === 'blocked' || s.state === 'error' ? ' primary' : ''}" href="${esc(s.open)}" target="_blank" rel="noopener">사이트 열기</a></div>`;
      })
      .join('') || '<p class="sub">아직 수집 기록이 없습니다. 새로고침을 눌러 보세요.</p>'}</div>
    <div class="links" style="margin-top:14px"><button class="pill primary" data-add="">+ 팝업 직접 추가</button></div>`);
}

// ---------- 전체 보기: 예정된 항목을 목록으로 훑으며 ★/숨기기로 미리 거르기 ----------
const browse = loadBrowsePrefs();
function loadBrowsePrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('bca.browse') || '{}');
    return { tab: p.tab || 'all', showHidden: !!p.showHidden, favOnly: !!p.favOnly, query: '', selected: new Set() };
  } catch {
    return { tab: 'all', showHidden: false, favOnly: false, query: '', selected: new Set() };
  }
}
function saveBrowsePrefs() {
  try {
    localStorage.setItem('bca.browse', JSON.stringify({ tab: browse.tab, showHidden: browse.showHidden, favOnly: browse.favOnly }));
  } catch {}
}
function browsePool() {
  // 숨긴 항목은 목록에서 빠진 경우에도 저장해 둔 정보로 보여준다
  const keys = new Set((state.pool || []).map((e) => e.key));
  const hiddenOnly = Object.values(state.hidden).filter((h) => !keys.has(h.key) && h.title);
  return [...(state.pool || []), ...hiddenOnly].filter((e) => {
    const s = span(e);
    return s.start && s.end >= state.today;
  });
}
function browseList() {
  const q = browse.query.trim().toLowerCase();
  return browsePool()
    .filter((e) => browse.showHidden || !state.hiddenSet.has(e.key))
    .filter((e) => !browse.favOnly || isFav(e))
    .filter((e) => browse.tab === 'all' || groupOf(e) === browse.tab)
    .filter((e) => !q || `${e.title} ${e.place || ''} ${e.info || ''}`.toLowerCase().includes(q))
    .sort((a, b) => span(a).start.localeCompare(span(b).start) || span(a).end.localeCompare(span(b).end) || a.title.localeCompare(b.title));
}
function browseRow(e) {
  const g = groupOf(e);
  const hid = state.hiddenSet.has(e.key);
  const fav = isFav(e);
  const dd = dday(e);
  const sel = browse.selected.has(e.key);
  const sub = [period(e), e.place, e.info].filter(Boolean).map(esc).join(' · ');
  const onCal = !hid && onCalendar(e);
  return `<div class="brow g-${g}${hid ? ' hid' : ''}${fav ? ' fav' : ''}${sel ? ' sel' : ''}" data-key="${esc(e.key)}">
    <label class="bsel" title="선택"><input type="checkbox" data-sel="${esc(e.key)}" ${sel ? 'checked' : ''}></label>
    <div class="bbody" data-open="${esc(e.key)}">
      <div class="btitle"><i></i>${esc(e.title)}</div>
      <div class="bmeta"><span class="bdd${dd.cls ? ' red' : ''}">${dd.text}</span> ${sub}</div>
      <div class="btags">${esc(groupLabel(e))}${isFree(e) ? ' · <b class="green">무료</b>' : ''}${isNew(e) ? ' · <b class="red">NEW</b>' : ''}${hid ? ' · <b>숨김</b>' : onCal ? '' : ' · 캘린더에 안 보임(★ 하면 표시)'}</div>
    </div>
    <button class="bstar${fav ? ' on' : ''}" data-bfav="${esc(e.key)}" title="${fav ? '즐겨찾기 해제' : '즐겨찾기 — 캘린더에 표시'}">${fav ? '★' : '☆'}</button>
    ${e.source === 'custom' ? '<span class="bhide-ph"></span>' : `<button class="bhide" data-bhide="${esc(e.key)}" title="${hid ? '다시 보기' : '관심 없음 (숨기기)'}">${hid ? '↺' : '✕'}</button>`}
  </div>`;
}
function renderBrowse() {
  const all = browsePool();
  const visible = all.filter((e) => browse.showHidden || !state.hiddenSet.has(e.key));
  const counts = { all: visible.length };
  for (const e of visible) counts[groupOf(e)] = (counts[groupOf(e)] || 0) + 1;
  const tabs = [{ id: 'all', label: '전체' }, ...GROUPS.filter((g) => counts[g.id])];
  $('#btabs').innerHTML = tabs.map((t) => `<button class="btab g-${t.id}" data-tab="${t.id}" aria-pressed="${browse.tab === t.id}">${t.id === 'all' ? '' : '<i></i>'}${t.label} <span>${counts[t.id] || 0}</span></button>`).join('');
  if (!tabs.some((t) => t.id === browse.tab)) browse.tab = 'all';
  $('#bShowHidden').checked = browse.showHidden;
  $('#bFavOnly').checked = browse.favOnly;
  const hiddenCount = all.filter((e) => state.hiddenSet.has(e.key)).length;
  $('#bHiddenCount').textContent = hiddenCount ? `(${hiddenCount})` : '';

  const list = browseList();
  // 선택은 지금 보이는 목록 안에서만 유지
  const keys = new Set(list.map((e) => e.key));
  for (const k of [...browse.selected]) if (!keys.has(k)) browse.selected.delete(k);

  let html = '';
  const ongoing = list.filter((e) => span(e).start < state.today);
  if (ongoing.length) html += `<h3 class="bgroup">이미 진행 중 · ${ongoing.length}</h3>` + ongoing.map(browseRow).join('');
  let cur = null;
  for (const e of list.filter((x) => span(x).start >= state.today)) {
    const s = span(e).start;
    if (s !== cur) {
      cur = s;
      const rel = diffDays(s, state.today);
      const hol = state.holidays.get(s);
      html += `<h3 class="bgroup">${mdw(s)} 시작${rel === 0 ? ' · 오늘' : rel === 1 ? ' · 내일' : ` · ${rel}일 뒤`}${hol ? ` <span class="holtag">${esc(hol)}</span>` : ''}</h3>`;
    }
    html += browseRow(e);
  }
  $('#blist').innerHTML = html || '<p class="sub bempty">조건에 맞는 항목이 없습니다.</p>';
  const n = browse.selected.size;
  $('#bbulk').hidden = n === 0;
  $('#bSelCount').textContent = `${n}개 선택`;
  $('#bSelAll').checked = n > 0 && n === list.length;
  $('#bSelAll').indeterminate = n > 0 && n < list.length;
  $('#bSummary').textContent = `${list.length}개 표시`;
}
function openBrowse(opts = {}) {
  if (opts.tab) browse.tab = opts.tab;
  if (opts.showHidden) browse.showHidden = true;
  browse.selected.clear();
  closeSheet();
  $('#browse').hidden = false;
  renderBrowse();
  $('#blist').scrollTop = 0;
  saveBrowsePrefs();
}
function closeBrowse() {
  $('#browse').hidden = true;
  browse.selected.clear();
}
async function bulkStore(store, on, keys) {
  const items = keys.map((k) => ({ key: k, event: findEvent(k) })).filter((x) => x.event);
  if (!items.length) return;
  const j = await api(`/api/${store}`, { method: 'POST', body: JSON.stringify({ on, items }) });
  if (store === 'favorites') setFavs(j);
  else applyHidden(j);
}
async function bulk(action) {
  const keys = [...browse.selected];
  if (!keys.length) return;
  try {
    if (action === 'fav') {
      const toFav = keys.filter((k) => !state.hiddenSet.has(k));
      await bulkStore('favorites', true, toFav);
      toast(`★ ${toFav.length}개 즐겨찾기`, 2000);
    } else if (action === 'unfav') {
      await bulkStore('favorites', false, keys);
      toast(`${keys.length}개 즐겨찾기 해제`, 2000);
    } else if (action === 'hide') {
      const custom = new Set(state.custom.map((e) => e.key));
      const toHide = keys.filter((k) => !custom.has(k));
      await bulkStore('favorites', false, toHide.filter((k) => state.favSet.has(k)));
      await bulkStore('hidden', true, toHide);
      toast(`${toHide.length}개 숨김`, 6000, { label: '되돌리기', run: async () => { await bulkStore('hidden', false, toHide); refreshView(); } });
    } else if (action === 'unhide') {
      await bulkStore('hidden', false, keys);
      toast(`${keys.length}개 다시 보기`, 2000);
    }
    browse.selected.clear();
    refreshView();
  } catch (err) {
    toast('저장 실패: ' + err.message);
  }
}

$('#btnBrowse').addEventListener('click', () => openBrowse());
$('#bClose').addEventListener('click', closeBrowse);
$('#btabs').addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-tab]');
  if (!t) return;
  browse.tab = t.dataset.tab;
  browse.selected.clear();
  saveBrowsePrefs();
  renderBrowse();
  $('#blist').scrollTop = 0;
});
for (const [id, k] of [['bShowHidden', 'showHidden'], ['bFavOnly', 'favOnly']]) {
  $('#' + id).addEventListener('change', (ev) => {
    browse[k] = ev.target.checked;
    saveBrowsePrefs();
    renderBrowse();
  });
}
let bSearchTimer;
$('#bSearch').addEventListener('input', (ev) => {
  clearTimeout(bSearchTimer);
  bSearchTimer = setTimeout(() => {
    browse.query = ev.target.value;
    renderBrowse();
  }, 150);
});
$('#bSelAll').addEventListener('change', (ev) => {
  browse.selected = new Set(ev.target.checked ? browseList().map((e) => e.key) : []);
  renderBrowse();
});
$('#bbulk').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-bulk]');
  if (!b) return;
  if (b.dataset.bulk === 'clear') {
    browse.selected.clear();
    return renderBrowse();
  }
  bulk(b.dataset.bulk);
});
$('#blist').addEventListener('change', (ev) => {
  const c = ev.target.closest('[data-sel]');
  if (!c) return;
  if (c.checked) browse.selected.add(c.dataset.sel);
  else browse.selected.delete(c.dataset.sel);
  renderBrowse();
});
$('#blist').addEventListener('click', async (ev) => {
  const f = ev.target.closest('[data-bfav]');
  if (f) return toggleFav(f.dataset.bfav);
  const h = ev.target.closest('[data-bhide]');
  if (h) return setHidden(h.dataset.bhide, !state.hiddenSet.has(h.dataset.bhide));
  const o = ev.target.closest('[data-open]');
  if (o) openEvent(o.dataset.open);
});

// ---------- 클릭 처리 ----------
weeksEl.addEventListener('click', (ev) => {
  const bar = ev.target.closest('.ev');
  if (bar) return openEvent(bar.dataset.key);
  const cell = ev.target.closest('.day, .more');
  if (cell) openDay(cell.dataset.date);
});
$('#sheetBody').addEventListener('click', async (ev) => {
  const fav = ev.target.closest('[data-fav]');
  if (fav) {
    ev.stopPropagation();
    await toggleFav(fav.dataset.fav);
    return rerenderSheet();
  }
  const hide = ev.target.closest('[data-hide]');
  if (hide) {
    ev.stopPropagation();
    const inDetail = !hide.closest('.card');
    await setHidden(hide.dataset.hide, true);
    return inDetail ? closeSheet() : rerenderSheet();
  }
  const unhide = ev.target.closest('[data-unhide]');
  if (unhide) {
    await setHidden(unhide.dataset.unhide, false);
    return rerenderSheet();
  }
  const add = ev.target.closest('[data-add]');
  if (add) return openForm(null, add.dataset.add || null);
  const edit = ev.target.closest('[data-edit]');
  if (edit) return openForm(findEvent(edit.dataset.edit));
  const del = ev.target.closest('[data-del]');
  if (del) return deleteCustom(del.dataset.del);
  if (ev.target.closest('[data-close]')) return closeSheet();
  const c = ev.target.closest('.card');
  if (c) openEvent(c.dataset.key);
});
$('#sheetBody').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.matches('.card, .star, .hide')) ev.target.click();
});
$('#status').addEventListener('click', (ev) => {
  if (ev.target.closest('#btnPopupSites')) openPopupSites();
  if (ev.target.closest('#btnHidden')) openBrowse({ showHidden: true });
  const b = ev.target.closest('[data-browse]');
  if (b) openBrowse({ tab: b.dataset.browse });
});
$('#btnAdd').addEventListener('click', () => openForm());
$('#backdrop').addEventListener('click', closeSheet);
$('#sheetClose').addEventListener('click', closeSheet);
document.addEventListener('keydown', (ev) => {
  if (ev.target.matches('input, textarea')) {
    if (ev.key === 'Escape') ev.target.blur();
    return;
  }
  if (ev.key === 'Escape') {
    if (!$('#sheet').hidden) closeSheet();
    else if (!$('#browse').hidden) closeBrowse();
  }
  if (ev.key === 't' || ev.key === 'T') scrollToDate(state.today, true);
});
$('#btnToday').addEventListener('click', () => scrollToDate(state.today, true));

// ---------- 데이터 ----------
async function loadSide() {
  const [favs, custom, popup, hidden] = await Promise.all([api('/api/favorites'), api('/api/custom'), api('/api/popup-status'), api('/api/hidden')]);
  setFavs(favs);
  applyHidden(hidden);
  state.custom = custom.events || [];
  state.popupStatus = popup.sites?.length ? popup : null;
}

async function load(force = false) {
  const r = await fetch(`/api/events${force || !state.mtime ? '' : `?since=${state.mtime}`}`);
  const j = await r.json();
  setRefreshing(!!j.refresh?.running);
  if (j.unchanged) return false;
  if (j.missing) {
    $('#empty').hidden = !!j.refresh?.running || state.custom.length > 0;
    state.data = { events: [] };
  } else {
    $('#empty').hidden = true;
    state.data = j;
    state.mtime = j.mtime;
  }
  state.holidays = new Map((j.holidays || []).map((h) => [h.date, h.name]));
  await loadSide().catch(() => {});
  refreshView();
  return true;
}

function setRefreshing(on) {
  if (state.refreshing === on) return;
  state.refreshing = on;
  $('#btnRefresh').classList.toggle('spinning', on);
  $('#btnRefresh').disabled = on;
  applyFilters();
}

async function refreshNow() {
  const r = await fetch('/api/refresh', { method: 'POST' });
  const j = await r.json();
  if (!j.started && !j.refresh?.running) return toast('새로고침을 시작하지 못했습니다');
  setRefreshing(true);
  $('#empty').hidden = true;
  toast(state.data?.cloud ? '클라우드 수집을 요청했습니다… (보통 1~3분)' : '공공 API와 팝업 사이트에서 새로 불러오는 중… (처음엔 몇 분 걸릴 수 있음)', 6000);
  const poll = setInterval(async () => {
    const s = await (await fetch('/api/events?since=' + state.mtime)).json();
    if (s.refresh?.running) return;
    clearInterval(poll);
    setRefreshing(false);
    if (s.refresh?.ok === false) toast('불러오기 실패\n' + (s.refresh.tail || ''), 8000);
    else toast('최신 정보로 갱신했습니다');
    await load(true);
  }, 3000);
}
$('#btnRefresh').addEventListener('click', refreshNow);
$('#btnFirstLoad').addEventListener('click', refreshNow);

// 서버 하트비트 + 다른 곳(로그온 실행)에서 데이터가 바뀌면 자동 반영 + 자정 넘으면 오늘 갱신
// 서버가 새 버전으로 바뀌면(업데이트 후) 화면도 자동으로 새로고침
let serverVersion = null;
async function ping() {
  try {
    const j = await (await fetch('/api/ping')).json();
    if (serverVersion && j.version && j.version !== serverVersion) location.reload();
    serverVersion ||= j.version;
  } catch {}
}
setInterval(ping, 5000);
setInterval(() => {
  const t = localToday();
  if (t !== state.today) {
    state.today = t;
    renderAll();
  }
  if (!state.refreshing) load().catch(() => {});
}, 30000);

let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const anchor = addDays(state.first, Math.floor(scroller.scrollTop / state.rowH) * 7);
    if (measure()) {
      renderAll({ keepScroll: false });
      scroller.scrollTop = (diffDays(anchor, state.first) / 7) * state.rowH;
    }
  }, 150);
});

// ---------- 시작 ----------
ping();
measure();
const ws0 = weekStart(state.today);
state.first = addDays(ws0, -7 * CHUNK);
state.last = addDays(ws0, 7 * CHUNK * 2);
buildChips();
applyFilters();
renderAll({ keepScroll: false });
scrollToDate(state.today);
load(true).then(() => scrollToDate(state.today)).catch((e) => toast('데이터를 읽지 못했습니다: ' + e.message));
