// 오프라인 테스트: 실제 API/디스코드는 호출하지 않고 fetch 를 가짜로 바꿔서 검증
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bca-'));
process.env.BCA_ROOT = TMP;

const util = await import('../src/util.mjs');
const { parseApiResponse, ApiError } = await import('../src/http.mjs');
const core = await import('../src/core.mjs');
const discord = await import('../src/discord.mjs');

const TODAY = util.todayKST();
const d = (n) => util.addDays(TODAY, n);

test('toISO: 여러 날짜 형식', () => {
  assert.equal(util.toISO('2026-09-17'), '2026-09-17');
  assert.equal(util.toISO('20260917'), '2026-09-17');
  assert.equal(util.toISO('2026.9.7'), '2026-09-07');
  assert.equal(util.toISO('2019-12-27(금)'), '2019-12-27');
  assert.equal(util.toISO('2026년 9월 17일'), '2026-09-17');
  assert.equal(util.toISO(''), null);
});

test('parsePrice: 무료/일반/만원/시간·연도 무시', () => {
  assert.equal(util.parsePrice('무료'), 0);
  assert.equal(util.parsePrice('무료 (사전예약)'), 0);
  assert.equal(util.parsePrice('일반 16,000원 / 청소년 8,000원'), 16000);
  assert.equal(util.parsePrice('청소년 8,000원, 일반 16,000원'), 16000);
  assert.equal(util.parsePrice('1만6천원'), 16000);
  assert.equal(util.parsePrice('R석 50,000원 S석 30,000원'), 50000);
  assert.equal(util.parsePrice('10:00-18:00 2026년 운영'), null);
  assert.equal(util.parsePrice(''), null);
  assert.equal(util.parsePrice('전석 5000원'), 5000);
});

test('parseXmlItems: CDATA·엔티티', () => {
  const xml = '<r><items><item><title><![CDATA[A & B]]></title><place>영화의전당 &amp; 광장</place></item><item><title>둘째</title></item></items></r>';
  const items = util.parseXmlItems(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'A & B');
  assert.equal(items[0].place, '영화의전당 & 광장');
  // 한눈에보는문화정보 실제 응답: 이중 인코딩된 제목
  const ci = util.parseXmlItems('<items><item><title>혁展 - Beyond &amp;middot;&amp;middot; Who&amp;rsquo;s</title></item></items>');
  assert.equal(ci[0].title, '혁展 - Beyond ·· Who’s');
});

test('parseApiResponse: JSON 정상 / 단일 item 객체 / 빈 items', () => {
  const ok = parseApiResponse({ status: 200, text: JSON.stringify({ x: { header: { resultCode: '00' }, item: [{ a: 1 }], totalCount: 1 } }) });
  assert.deepEqual(ok.items, [{ a: 1 }]);
  assert.equal(ok.totalCount, 1);
  const single = parseApiResponse({ status: 200, text: JSON.stringify({ response: { body: { items: { item: { a: 2 } }, totalCount: 1 } } }) });
  assert.deepEqual(single.items, [{ a: 2 }]);
  const empty = parseApiResponse({ status: 200, text: JSON.stringify({ response: { header: { resultCode: '0000' }, body: { items: '', totalCount: 0 } } }) });
  assert.deepEqual(empty.items, []);
});

test('parseApiResponse: 인증 오류는 ApiError', () => {
  const xml = '<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>';
  assert.throws(() => parseApiResponse({ status: 200, text: xml }), ApiError);
  assert.throws(() => parseApiResponse({ status: 401, text: 'Unauthorized' }), /인증키/);
  assert.throws(() => parseApiResponse({ status: 200, text: JSON.stringify({ response: { header: { resultCode: '10', resultMsg: 'INVALID' } } }) }), /API 오류 10/);
});

test('필터: 종료/먼미래/가격', () => {
  const cfg = { maxPrice: 20000, includeUnknownPrice: true, includePaidUnknownPrice: false };
  assert.equal(core.isActive({ title: 'a', end: d(-1) }, TODAY, 30), false);
  assert.equal(core.isActive({ title: 'a', start: d(40), end: d(50) }, TODAY, 30), false);
  assert.equal(core.isActive({ title: 'a', start: d(-10), end: d(0) }, TODAY, 30), true);
  assert.equal(core.passesPrice({ price: 25000 }, cfg), false);
  assert.equal(core.passesPrice({ price: 16000 }, cfg), true);
  assert.equal(core.passesPrice({ price: null }, cfg), true);
  assert.equal(core.passesPrice({ price: null, paidUnknown: true }, cfg), false);
});

test('dedupe: 같은 행사 병합 시 가격 정보 보존', () => {
  const merged = core.dedupe([
    { title: '《바다》 특별전 [부산]', start: '2026-09-17', price: null, source: 'cultureInfo' },
    { title: '바다 특별전', start: '2026-09-17', price: 0, priceText: '무료', url: 'https://x', source: 'busanExhibit' },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].price, 0);
  assert.equal(merged[0].url, 'https://x');
});

test('classify + markSent: 신규 → 이후 마감 임박 1회만', () => {
  const cfg = { endingSoonDays: 7 };
  const state = { seen: {} };
  const items = core.dedupe([{ title: '전시A', start: d(-20), end: d(20) }]);
  let r = core.classify(items, state, cfg, TODAY);
  assert.equal(r.fresh.length, 1);
  core.markSent(state, r.fresh, TODAY);
  r = core.classify(items, state, cfg, TODAY);
  assert.equal(r.fresh.length + r.ending.length, 0);
  const later = util.addDays(TODAY, 15); // 종료 5일 전
  r = core.classify(items, state, cfg, later);
  assert.equal(r.ending.length, 1);
  core.markSent(state, r.ending, later);
  r = core.classify(items, state, cfg, later);
  assert.equal(r.ending.length, 0);
});

test('discord: 메시지당 embed 10개 이하, 6000자 이하', () => {
  const items = Array.from({ length: 23 }, (_, i) => ({ title: `전시 ${i} ` + 'x'.repeat(200), start: d(0), end: d(10), place: '부산'.repeat(40), price: 0, source: 's' }));
  const msgs = discord.buildMessages({ today: TODAY, fresh: items, ending: [], overflow: 0, errors: [{ label: 'L', message: 'boom' }], labelOf: () => 'src' });
  assert.equal(msgs.reduce((n, m) => n + m.embeds.length, 0), 23);
  for (const m of msgs) {
    assert.ok(m.embeds.length <= 10);
    const size = m.embeds.reduce((n, e) => n + e.title.length + e.description.length + e.footer.text.length, 0);
    assert.ok(size <= 6000);
  }
  assert.match(msgs[0].content, /⚠️ L: boom/);
  assert.ok(discord.isWebhookUrl('https://discord.com/api/webhooks/123/abc-DEF_1'));
  assert.ok(!discord.isWebhookUrl('https://example.com/hook'));
});

// ---------------- 가짜 API로 전체 흐름 ----------------
// 실제 부산 API 응답 구조: { getXxx: { header: { code: '00', message: 'NORMAL_CODE' }, item: [...], numOfRows, pageNo, totalCount } }
function busanJson(op, items, { pageNo = 1, totalCount = items.length } = {}) {
  return JSON.stringify({ [op]: { header: { code: '00', message: 'NORMAL_CODE' }, item: items, numOfRows: 100, pageNo, totalCount } });
}
// 실제 부산 전시 API는 2020년 자료부터 오래된 순으로 3000건 넘게 쌓여 있음 → 최신 항목은 마지막 페이지에 있다
const OLD_EXHIBITS = Array.from({ length: 3250 }, (_, i) => ({ res_no: `old${i}`, title: `옛 전시 ${i}`, op_st_dt: '2020-02-19', op_ed_dt: '2020-03-22', place_nm: '갤러리', price: '무료', op_at: 'N' }));
const kDate = (iso) => { const [y, m, dd] = iso.split('-').map(Number); return `${y}.${m}.${dd}(수)`; };
const cultureInfoXml = `<?xml version="1.0" encoding="UTF-8"?><response><header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header><body><totalCount>3</totalCount><items>
<item><serviceName>전시</serviceName><seq>1</seq><title>바다 특별전</title><startDate>${util.compactDate(d(-5))}</startDate><endDate>${util.compactDate(d(30))}</endDate><place>부산시립미술관</place><realmName>전시</realmName><area>부산</area><sigungu>중구</sigungu><thumbnail>https://img/1.jpg</thumbnail><gpsX>129.1</gpsX><gpsY>35.1</gpsY></item>
<item><serviceName>전시</serviceName><seq>4</seq><title>미술동인 혁展 &amp;middot;&amp;middot; 경계</title><startDate>${util.compactDate(d(-5))}</startDate><endDate>${util.compactDate(d(20))}</endDate><place>갤러리 조이</place><realmName>전시</realmName><area>부산</area><sigungu>해운대구</sigungu><gpsX>129.17</gpsX><gpsY>35.15</gpsY></item>
<item><serviceName>전시</serviceName><seq>5</seq><title>김해 전시</title><startDate>${util.compactDate(d(-5))}</startDate><endDate>${util.compactDate(d(20))}</endDate><place>김해 어딘가</place><realmName>전시</realmName><area>경남</area><sigungu>김해시</sigungu><gpsX>128.8</gpsX><gpsY>35.17</gpsY></item>
<item><seq>2</seq><title>서울 전시</title><startDate>${util.compactDate(d(-5))}</startDate><endDate>${util.compactDate(d(30))}</endDate><place>세종문화회관</place><realmName>전시</realmName><area>서울</area></item>
<item><seq>3</seq><title>부산 콘서트</title><startDate>${util.compactDate(d(3))}</startDate><endDate>${util.compactDate(d(3))}</endDate><place>부산문화회관</place><realmName>음악</realmName><area>부산</area></item>
</items></body></response>`;

const realFetch = globalThis.fetch;
const webhookCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const respond = (status, text) => ({ ok: status >= 200 && status < 300, status, text: async () => text });
  if (u.startsWith('https://discord.com/api/webhooks/')) {
    webhookCalls.push(JSON.parse(opts.body));
    return respond(200, '{}');
  }
  if (u.includes('BusanCultureExhibitDetailService')) {
    const page = Number(new URL(u).searchParams.get('pageNo'));
    const recent = [
      { res_no: '1', title: '바다 특별전', op_st_dt: d(-5), op_ed_dt: d(30), place_nm: '부산시립미술관', price: '무료', dabom_url: 'http://busandabom.net/x', op_at: 'N' },
      { res_no: '2', title: '비싼 전시', op_st_dt: d(-5), op_ed_dt: d(30), place_nm: '어딘가', price: '일반 25,000원', op_at: 'N' },
      { res_no: '3', title: '곧 끝나는 전시', op_st_dt: d(-30), op_ed_dt: d(3), place_nm: '갤러리', price: '일반 5,000원', op_at: 'N' },
      { res_no: '4', title: '지난 전시', op_st_dt: '2020-02-19', op_ed_dt: '2020-03-22', place_nm: '조현화랑', price: '무료', op_at: 'N' },
    ];
    const all = [...OLD_EXHIBITS, ...recent];
    return respond(200, busanJson('getBusanCultureExhibitDetail', all.slice((page - 1) * 100, page * 100), { pageNo: page, totalCount: all.length }));
  }
  if (u.includes('BusanCultureEtcService')) {
    return respond(200, busanJson('getBusanCultureEtc', [
      { res_no: '10', title: '무료 버스킹', op_st_dt: d(1), op_ed_dt: d(1), place_nm: '광안리', pay_at: 'N', op_at: 'N' },
      { res_no: '11', title: '유료 콘서트', op_st_dt: d(1), op_ed_dt: d(1), place_nm: '벡스코', pay_at: 'Y', op_at: 'N' },
      { res_no: '12', title: '관심없는 공연', op_st_dt: d(2), op_ed_dt: d(2), place_nm: '어딘가', pay_at: 'N', op_at: 'N' },
    ]));
  }
  if (u.includes('BusanCultureDayService')) {
    return respond(200, busanJson('getBusanCultureDay', [
      { place_nm: '동구도서관', program_nm: '두배로 대출', dt_ymd: kDate(d(2)), dt_time: '09:00-22:00', benefit: '대출권수확대', gugun: null, place_dtl: '' },
      { place_nm: '금곡도서관', program_nm: '<대출 두배로 데이>', dt_ymd: '매주 수요일, 매월 마지막주 금요일', dt_time: '09:00~22:00', benefit: '도서대출권수 확대', gugun: null, place_dtl: '' },
    ]));
  }
  if (u.includes('B553457/cultureinfo/period2')) {
    assert.match(u, /numOfrows=100/);
    return respond(200, cultureInfoXml);
  }
  if (u.includes('KorService2/searchFestival2')) {
    if (u.includes('areaCode=6')) {
      // 실제 응답: 오류 없이 0건 (items 가 빈 문자열)
      return respond(200, JSON.stringify({ response: { header: { resultCode: '0000', resultMsg: 'OK' }, body: { items: '', numOfRows: 0, pageNo: 1, totalCount: 0 } } }));
    }
    assert.match(u, /lDongRegnCd=26/);
    return respond(200, JSON.stringify({ response: { header: { resultCode: '0000', resultMsg: 'OK' }, body: { items: { item: [
      { contentid: '900', title: '부산 불꽃축제', addr1: '부산광역시 수영구', eventstartdate: util.compactDate(d(10)), eventenddate: util.compactDate(d(10)), firstimage: 'https://img/f.jpg' },
    ] }, totalCount: 1 } } }));
  }
  // ---- 공휴일 (한국천문연구원 특일 정보) ----
  if (u.includes('SpcdeInfoService/getRestDeInfo')) {
    const year = new URL(u).searchParams.get('solYear');
    const item = year === TODAY.slice(0, 4)
      ? [{ dateKind: '01', dateName: '개천절', isHoliday: 'Y', locdate: Number(util.compactDate(d(4))), seq: 1 }, { dateKind: '01', dateName: '대체공휴일', isHoliday: 'Y', locdate: Number(util.compactDate(d(6))), seq: 1 }]
      : { dateKind: '01', dateName: '1월1일', isHoliday: 'Y', locdate: Number(`${year}0101`), seq: 1 };
    return respond(200, JSON.stringify({ response: { header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' }, body: { items: { item }, numOfRows: 100, pageNo: 1, totalCount: 2 } } }));
  }
  // ---- 영화 (KOBIS) ----
  if (u.includes('kobis.or.kr/kobisopenapi/webservice/rest/movie/searchMovieList')) {
    const mv = (cd, nm, open, extra = {}) => ({ movieCd: cd, movieNm: nm, openDt: util.compactDate(open), typeNm: '장편', prdtStatNm: '개봉예정', nationAlt: '한국', genreAlt: '드라마', repNationNm: '한국', directors: [{ peopleNm: '홍감독' }], ...extra });
    return respond(200, JSON.stringify({ movieListResult: { totCnt: 4, source: '영화진흥위원회', movieList: [
      mv('1', '부산행2', d(3)),
      mv('2', '옛날 영화', d(-40)),
      mv('3', '단편 영화', d(5), { typeNm: '단편' }),
      mv('4', '성인 영화', d(5), { genreAlt: '성인물(에로)' }),
      mv('5', '즐찾 안 한 영화', d(6)),
    ] } }));
  }
  // ---- 팝업 사이트: 팝플리 정상 / 팝가 차단 / 데이포유 사이트맵 없음 ----
  if (u.startsWith('https://popply.co.kr/')) {
    if (u.endsWith('/robots.txt')) return respond(200, 'User-agent: *\nAllow: /\nDisallow: /api/\n');
    if (u.endsWith('/sitemap.xml')) return respond(200, `<?xml version="1.0"?><urlset><url><loc>https://popply.co.kr/popup</loc></url><url><loc>https://popply.co.kr/popup/5901</loc></url><url><loc>https://popply.co.kr/popup/5900</loc></url><url><loc>https://popply.co.kr/api/popup/1</loc></url></urlset>`);
    const P = (t, a, b, addr) => `<html><head><meta property="og:title" content="${t} - POPPLY"><meta property="og:image" content="https://img/p.jpg"></head><body><h1>${t}</h1><p>${a} - ${b}</p><p>${addr}</p></body></html>`;
    const yy = (s) => s.slice(2).replaceAll('-', '.');
    if (u.endsWith('/popup/5901')) return respond(200, P('산리오 팝업 in 부산', yy(d(-2)), yy(d(12)), '부산 해운대구 센텀남대로 35 신세계 센텀시티'));
    if (u.endsWith('/popup/5900')) return respond(200, P('성수 팝업', yy(d(-2)), yy(d(12)), '서울 성동구 성수이로8길 3'));
  }
  if (u.startsWith('https://popga.co.kr/')) return respond(403, '<html>Access Denied</html>');
  if (u.startsWith('https://dayforyou.com/')) return respond(404, 'not found');
  throw new Error('예상 못한 URL: ' + u);
};

test('전체 흐름: 첫 실행 전송 → 같은 날 재실행 스킵 → --force 재실행 시 중복 없음 → check', async () => {
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
    dataGoKrKey: 'abc%2Bdef%3D%3D',
    discordWebhookUrl: 'https://discord.com/api/webhooks/1/tok',
    kobisKey: 'kobis-secret',
    popupDelayMs: 0,
  }));
  fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'data', 'favorites.json'), JSON.stringify({ items: { [util.normalizeKey('부산행2', d(3))]: { title: '부산행2' } } }));
  fs.writeFileSync(path.join(TMP, 'data', 'hidden.json'), JSON.stringify({ items: { [util.normalizeKey('관심없는 공연', d(2))]: { title: '관심없는 공연' } } }));
  const { run, check, loadConfig } = await import('../src/index.mjs');
  assert.equal(loadConfig().dataGoKrKey, 'abc+def==', 'Encoding 키 자동 디코딩');

  await run({ force: false, dryRun: false });
  const embeds = webhookCalls.flatMap((m) => m.embeds || []);
  const titles = embeds.map((e) => e.title);
  assert.ok(titles.includes('바다 특별전'), '무료 전시 포함 (두 소스 중복 → 1개)');
  assert.equal(titles.filter((t) => t.includes('바다 특별전')).length, 1);
  assert.ok(!titles.some((t) => t.includes('비싼 전시')), '2만원 초과 제외');
  assert.ok(!titles.some((t) => t.includes('지난 전시')), '종료된 전시 제외');
  assert.ok(!titles.some((t) => t.includes('서울 전시')), '부산 외 지역 제외');
  assert.ok(!titles.some((t) => t.includes('부산 콘서트')), '한눈에보는문화정보는 전시만');
  assert.ok(!titles.some((t) => t.includes('유료 콘서트')), '금액 모르는 유료 공연 제외(기본값)');
  assert.ok(titles.includes('무료 버스킹'), JSON.stringify(titles));
  assert.ok(!titles.includes('관심없는 공연'), '캘린더에서 숨긴 행사는 디스코드로 안 보냄');
  assert.ok(titles.includes('⏰ 곧 끝나는 전시'), '마감 임박 표시');
  assert.ok(titles.includes('부산 불꽃축제'), 'TourAPI 법정동 코드(lDongRegnCd=26) 사용');
  assert.ok(titles.some((t) => t.startsWith('두배로 대출')));
  assert.ok(titles.includes('미술동인 혁展 ·· 경계'), '이중 인코딩 제목 복원');
  assert.ok(!titles.some((t) => t.includes('김해 전시')), '좌표 범위 안이어도 area가 부산이 아니면 제외');
  assert.ok(!titles.some((t) => t.includes('옛 전시')), '오래된 전시 제외');
  assert.match(webhookCalls[0].content, /새로 올라온 것 \d+개/);
  assert.ok(titles.includes('부산행2'), '즐겨찾기한 영화는 디스코드로');
  assert.ok(!titles.includes('즐찾 안 한 영화'), '즐겨찾기 안 한 영화는 캘린더에만');
  assert.ok(titles.includes('산리오 팝업 in 부산'), '팝업스토어는 전부 디스코드로');
  assert.ok(!titles.includes('성수 팝업'), '부산 밖 팝업은 제외');
  {
    const mvEmbed = webhookCalls.flatMap((m) => m.embeds || []).find((e) => e.title === '부산행2');
    assert.match(mvEmbed.description, /🎬 한국 · 드라마 · 감독 홍감독/);
    assert.ok(!/요금 정보 없음/.test(mvEmbed.description), '영화는 요금 줄 생략');
  }
  assert.ok(!webhookCalls[0].content.includes('팝가'), '캘린더 전용 소스 오류는 디스코드 머리말에 안 붙음');
  {
    const snap0 = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'events.json'), 'utf8'));
    const t0 = snap0.events.map((e) => e.title);
    assert.ok(t0.includes('부산행2'), '개봉 예정 영화는 캘린더에');
    assert.ok(t0.includes('관심없는 공연'), '숨긴 행사도 데이터엔 남아 되돌릴 수 있음');
    assert.ok(!t0.includes('옛날 영화') && !t0.includes('단편 영화'), '지난 개봉·단편 제외');
    assert.ok(t0.includes('성인 영화'), '성인물도 포함');
    assert.ok(t0.includes('산리오 팝업 in 부산'), '부산 팝업은 캘린더에');
    assert.ok(!t0.includes('성수 팝업'), '부산 밖 팝업 제외');
    const pp = snap0.events.find((e) => e.title === '산리오 팝업 in 부산');
    assert.equal(pp.sourceLabel, '팝업 · 팝플리');
    assert.equal(pp.start, d(-2));
    const hol = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'holidays.json'), 'utf8'));
    assert.deepEqual(hol.days.find((h) => h.date === d(4)), { date: d(4), name: '개천절' });
    const ps = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'popup-status.json'), 'utf8'));
    const byId = Object.fromEntries(ps.sites.map((x) => [x.id, x]));
    assert.equal(byId.popply.state, 'ok');
    assert.equal(byId.popply.listed, 2, 'robots.txt 가 막은 /api/ 주소는 읽지 않음');
    assert.equal(byId.popga.state, 'blocked', '403 은 막힘으로 표시');
    assert.equal(byId.dayforyou.state, 'error');
  }

  const state = JSON.parse(fs.readFileSync(path.join(TMP, 'state.json'), 'utf8'));
  assert.equal(state.lastRunDate, TODAY);

  const before = webhookCalls.length;
  await run({ force: false, dryRun: false });
  assert.equal(webhookCalls.length, before, '같은 날 두 번째 실행은 스킵');

  await run({ force: true, dryRun: false });
  assert.equal(webhookCalls.length, before, '--force 여도 이미 보낸 항목은 다시 안 보냄');

  const snap = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'events.json'), 'utf8'));
  assert.ok(snap.events.some((e) => e.title === '바다 특별전' && e.sent), '실행 후 캘린더 데이터 저장');
  assert.ok(snap.events.every((e) => e.key && e.title), '모든 항목에 key/title');

  await check({ withDump: true });
  const raw = fs.readFileSync(path.join(TMP, 'logs', 'raw', 'busanExhibit.txt'), 'utf8');
  assert.match(raw, /ServiceKey=\*\*\*/);
  assert.ok(!raw.includes('abc'), '키가 원본 덤프에 남지 않음');
  const report = fs.readFileSync(path.join(TMP, 'logs', `check-${TODAY}.txt`), 'utf8');
  assert.match(report, /부산 전시 \(부산문화포털\)\n {3}✅ 사용 가능/);
  assert.match(report, /KOPIS\)\n {3}건너뜀/);
  assert.match(report, /팝가: ⛔ 막힘/);
  assert.match(report, /대한민국 공휴일[^\n]*\n {3}✅ 3일/);
  for (const f of fs.readdirSync(path.join(TMP, 'logs', 'raw'))) {
    assert.ok(!fs.readFileSync(path.join(TMP, 'logs', 'raw', f), 'utf8').includes('kobis-secret'), `KOBIS 키가 덤프(${f})에 남지 않음`);
  }
});

// ---------------- 캘린더 ----------------
test('캘린더 스냅샷: 전체 행사 저장, 지난 행사 보존·정리, sent/firstSeen', async () => {
  const { buildSnapshot } = await import('../src/events.mjs');
  const state = { seen: { a: { first: d(-3) } } };
  const prev = { events: [
    { key: 'old', title: '오래전', start: d(-200), end: d(-150) },
    { key: 'recent', title: '지난주 끝남', start: d(-20), end: d(-7) },
    { key: 'b', title: '예전 제목', firstSeen: d(-1), start: d(1), end: d(2) },
  ] };
  const snap = buildSnapshot(
    [{ key: 'a', title: 'A', source: 'busanExhibit', start: d(-5), end: d(5), price: 0 }, { key: 'b', title: 'B', source: 'tourFestival', start: d(1), end: d(2) }],
    { state, today: TODAY, prev, labelOf: (id) => `L:${id}`, endingSoonDays: 7 },
  );
  const keys = snap.events.map((e) => e.key);
  assert.ok(!keys.includes('old'), '120일 넘게 지난 행사 정리');
  assert.ok(keys.includes('recent'), '최근 지난 행사는 과거 스크롤용으로 보존');
  const a = snap.events.find((e) => e.key === 'a');
  const b = snap.events.find((e) => e.key === 'b');
  assert.equal(a.sent, true);
  assert.equal(a.firstSeen, d(-3));
  assert.equal(a.sourceLabel, 'L:busanExhibit');
  assert.equal(b.sent, false);
  assert.equal(b.title, 'B', '새 수집 결과로 덮어씀');
  assert.equal(b.firstSeen, d(-1), '처음 본 날짜 유지');
  assert.equal(snap.events.find((e) => e.key === 'recent').current, false);
});

test('캘린더 배치: 주 경계 자르기, 짧은 행사 우선, 줄 초과는 +N', async () => {
  const L = await import('../calendar/public/layout.js');
  const ws = '2026-10-04'; // 일요일
  assert.equal(L.weekStart('2026-10-07'), ws);
  const ev = [
    { key: 'long', title: '1년 드론쇼', source: 'tourFestival', start: '2026-01-01', end: '2026-12-31' },
    { key: 'ex', title: '전시', source: 'busanExhibit', start: '2026-10-06', end: '2026-10-20' },
    { key: 'fest', title: '록페', source: 'tourFestival', start: '2026-10-02', end: '2026-10-05' },
    { key: 'day', title: '문화가 있는 날', source: 'busanCultureDay', start: '2026-10-05', end: '2026-10-05' },
    { key: 'out', title: '다음주', source: 'busanExhibit', start: '2026-10-12', end: '2026-10-13' },
  ];
  const { bars, more, count } = L.layoutWeek(ev, ws, 2);
  const byKey = Object.fromEntries(bars.map((b) => [b.e.key, b]));
  assert.ok(!byKey.out, '주 밖 행사 제외');
  assert.deepEqual([byKey.fest.col, byKey.fest.endCol, byKey.fest.contLeft, byKey.fest.contRight], [0, 1, true, false]);
  assert.deepEqual([byKey.ex.col, byKey.ex.endCol, byKey.ex.contRight], [2, 6, true]);
  assert.ok(!byKey.long, '1년짜리는 줄이 모자라면 밀려남');
  assert.deepEqual(more, [1, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(count, [2, 3, 2, 2, 2, 2, 2]);
  const on = L.eventsOn(ev, '2026-10-05');
  assert.equal(on[0].key, 'day', '이날 시작이 맨 위');
  assert.ok(L.matchesFilter(ev[3], { groups: new Set(['cultureDay']), freeOnly: false, query: '' }));
  assert.ok(!L.matchesFilter(ev[1], { groups: new Set(), freeOnly: true, query: '' }), '가격 모르면 무료만 필터에서 제외');
  assert.ok(L.matchesFilter(ev[0], { groups: new Set(), freeOnly: false, query: '드론' }));
});

test('캘린더 서버: 즐겨찾기·직접 추가 저장, 다른 출처 차단', async () => {
  process.env.BCA_CAL_PORT = '17971';
  const http = await import('node:http');
  const { handler } = await import('../calendar/server.mjs');
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(17971, '127.0.0.1', r));
  const base = 'http://127.0.0.1:17971';
  const call = (p, method = 'GET', body, origin = base) =>
    realFetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  try {
    let r = await call('/api/favorites', 'POST', { key: 'k1', on: true, event: { key: 'k1', title: '바다 특별전', start: d(0), end: d(5), junk: 'x' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.items.k1.title, '바다 특별전');
    assert.equal(r.json.items.k1.junk, undefined, '허용된 필드만 저장');
    r = await call('/api/favorites', 'POST', { key: 'k1', on: true }, 'https://evil.example');
    assert.equal(r.status, 403, '다른 사이트에서 온 쓰기 요청 차단');
    r = await call('/api/custom', 'POST', { title: '  팝업 A  ', start: d(1), end: d(-3), kind: 'popup', url: 'example.com/x' });
    assert.equal(r.status, 200);
    const ev = r.json.events[0];
    assert.deepEqual([ev.title, ev.end, ev.category, ev.source, ev.url], ['팝업 A', d(1), '팝업스토어', 'custom', 'https://example.com/x']);
    r = await call('/api/custom', 'POST', { title: '', start: d(1) });
    assert.equal(r.status, 400, '제목 없으면 거절');
    r = await call('/api/custom', 'POST', { key: ev.key, title: '팝업 B', start: d(2), kind: 'mine' });
    assert.equal(r.json.events.length, 1, '같은 key 는 수정');
    assert.equal(r.json.events[0].category, '내 일정');
    r = await call('/api/custom?id=' + encodeURIComponent(ev.key), 'DELETE');
    assert.equal(r.json.events.length, 0);
    r = await call('/api/hidden', 'POST', { key: 'h1', on: true, event: { key: 'h1', title: '관심 없음' } });
    assert.equal(r.json.items.h1.title, '관심 없음');
    r = await call('/api/hidden', 'POST', { on: true, items: [{ key: 'b1', event: { title: 'B1' } }, { key: 'b2', event: { title: 'B2' } }] });
    assert.ok(r.json.items.b1 && r.json.items.b2, '여러 개 한 번에 숨기기');
    r = await call('/api/hidden', 'POST', { on: false, items: [{ key: 'b1' }, { key: 'b2' }] });
    assert.ok(!r.json.items.b1 && !r.json.items.b2, '여러 개 한 번에 해제');
    r = await call('/api/hidden', 'POST', { on: true, items: [{ event: {} }] });
    assert.equal(r.status, 400, 'key 없는 항목 거절');
    r = await call('/api/hidden', 'POST', { key: 'h1', on: false });
    assert.ok(!('h1' in r.json.items), '숨김 해제');
    r = await call('/api/favorites', 'POST', { key: 'k1', on: false });
    assert.ok(!('k1' in r.json.items), '즐겨찾기 해제');
    r = await call('/api/shutdown', 'POST', {}, base);
    assert.equal(r.status, 403, '브라우저 페이지(Origin 있음)는 서버 종료 불가');
    r = await call('/api/shutdown', 'POST', {}, null);
    assert.equal(r.status, 403, '전용 헤더 없으면 종료 불가');
    const wk = await call('/api/week?days=3');
    assert.equal(wk.json.range.days, 3);
    assert.ok(Array.isArray(wk.json.favorites) && Array.isArray(wk.json.days));
    const wt = await realFetch(base + '/api/week?format=text').then((x) => x.text());
    assert.match(wt, /^📅 부산 문화 일정/);
    const fl = await call('/api/favorites/list');
    assert.ok(Array.isArray(fl.json.favorites));
    const ping = await call('/api/ping');
    assert.match(String(ping.json.version), /^\d+$/, 'ping 에 코드 버전 포함');
    const ev2 = await call('/api/events');
    assert.ok(Array.isArray(ev2.json.holidays), '행사 응답에 공휴일 포함');
  } finally {
    srv.close();
  }
});

test('캘린더 배치: 즐겨찾기가 먼저 자리 잡고, 즐겨찾기만 보기 필터', async () => {
  const L = await import('../calendar/public/layout.js');
  const ws = '2026-10-04';
  const ev = [
    { key: 'a', title: '축제', source: 'tourFestival', start: '2026-10-05', end: '2026-10-05' },
    { key: 'b', title: '긴 전시', source: 'busanExhibit', start: '2026-09-01', end: '2026-12-01' },
    { key: 'p', title: '팝업', source: 'popups', start: '2026-10-05', end: '2026-10-06' },
    { key: 'm', title: '영화', source: 'movies', start: '2026-10-07', end: '2026-10-07' },
    { key: 'c', title: '내 약속', source: 'custom', kind: 'mine', start: '2026-10-08', end: '2026-10-08' },
  ];
  const favs = new Set(['b']);
  const { bars } = L.layoutWeek(ev, ws, 1, favs);
  assert.equal(bars[0].e.key, 'b', '즐겨찾기는 긴 행사라도 첫 줄');
  assert.equal(bars[0].fav, true);
  assert.deepEqual(ev.map(L.groupOf), ['festival', 'exhibit', 'popup', 'movie', 'mine']);
  assert.deepEqual(ev.filter((e) => L.matchesFilter(e, { groups: new Set(), favOnly: true }, favs)).map((e) => e.key), ['b']);
});

test('팝업 해석: 기간·주소 형식, robots, 차단 감지', async () => {
  const P = await import('../src/popups.mjs');
  const t = '2026-09-29';
  assert.deepEqual(P.parsePeriod('26.10.02(금) - 10.11(일) 매일 10:30', t), { start: '2026-10-02', end: '2026-10-11' });
  assert.deepEqual(P.parsePeriod('10. 02 - 10. 11 · 용산', t), { start: '2026-10-02', end: '2026-10-11' });
  assert.deepEqual(P.parsePeriod('2026.12.20 ~ 2027.01.05', t), { start: '2026-12-20', end: '2027-01-05' });
  assert.deepEqual(P.parsePeriod('12.28 - 01.04', t), { start: '2026-12-28', end: '2027-01-04' }, '해 넘김');
  assert.equal(P.parsePeriod('영업 12:00 - 21:00', t), null, '영업시간은 기간이 아님');
  assert.equal(P.parseAddress('주소\n부산광역시 해운대구 센텀남대로 35 1층\n문의'), '부산광역시 해운대구 센텀남대로 35 1층');
  assert.deepEqual(P.robotsDisallows('User-agent: *\nDisallow: /api/\n\nUser-agent: X\nDisallow: /all'), ['/api/']);
  assert.ok(!P.isAllowed('https://a.kr/api/popup/1', ['/api/']));
  assert.ok(P.looksBlocked(200, '<script src="/cdn-cgi/challenge-platform/h/b"></script>'));
  assert.ok(!P.looksBlocked(200, '<html>정상 페이지</html>'));
  const p = P.parsePopupHtml('<meta property="og:title" content="짱구 팝업 | 팝가 Popga"><body><script>x={"period":"26.10.02 - 26.10.20","addr":"부산 부산진구 가야대로 772"}</script></body>', 'u', t);
  assert.deepEqual([p.title, p.start, p.end, p.busan], ['짱구 팝업', '2026-10-02', '2026-10-20', true], '스크립트 안 데이터도 읽음');
});

test('즐겨찾기 영화: 개봉 전날·당일 한 번 더 알림, 팝가 제목 종류 분리', async () => {
  const S = { seen: {} };
  const cfg = { endingSoonDays: 7 };
  const mv = (start) => ({ key: 'm' + start, title: 'M', start, end: start, remindStart: true });
  const r1 = core.classify([mv(d(1)), mv(d(5)), mv(d(0))], S, cfg, TODAY);
  const soon = Object.fromEntries(r1.fresh.map((x) => [x.start, x.endingSoon]));
  assert.deepEqual([soon[d(0)], soon[d(1)], soon[d(5)]], [true, true, false], '개봉 당일·전날만 임박');
  const seen = { seen: { ['m' + d(1)]: { endingNotified: false } } };
  const r2 = core.classify([mv(d(1))], seen, cfg, TODAY);
  assert.equal(r2.ending.length, 1, '이미 알린 영화도 개봉 전날엔 다시');
  const P = await import('../src/popups.mjs');
  const p = P.parsePopupHtml('<meta property="og:title" content="미스터트롯3 TOP7 콘서트 [부산] - 다시, 우리 - 수영구 공연 | 팝가 Popga"><p>26.10.31 - 26.11.01</p><p>부산 수영구 수영로 429 지도보기</p>', 'u', '2026-09-29');
  assert.deepEqual([p.title, p.kind, p.place], ['미스터트롯3 TOP7 콘서트 [부산] - 다시, 우리', 'show', '부산 수영구 수영로 429']);
  const q = P.parsePopupHtml('<meta property="og:title" content="오함마백씨행장 완판본 - 부산 - 수영구 공연 | 팝가"><p>26.10.16 - 26.10.17</p>', 'u', '2026-09-29');
  assert.equal(q.title, '오함마백씨행장 완판본');
});

test('7일 요약: 숨김 제외, 영화는 즐겨찾기만, 시작·마감 날짜별, 텍스트', async () => {
  const { buildDigest, digestText } = await import('../src/digest.mjs');
  const ev = (key, title, source, start, end, extra = {}) => ({ key, title, source, start, end, category: '', ...extra });
  const dg = buildDigest({
    snapshot: { updatedAt: '2026-10-01T00:00:00Z', events: [
      ev('a', '긴 전시', 'busanExhibit', d(-10), d(20), { price: 0, place: '미술관' }),
      ev('b', '주말 축제', 'tourFestival', d(2), d(3)),
      ev('c', '다음달 전시', 'busanExhibit', d(30), d(40)),
      ev('m1', '즐찾 영화', 'movies', d(1), d(1), { info: '한국 · 액션' }),
      ev('m2', '그냥 영화', 'movies', d(1), d(1)),
      ev('h', '숨긴 공연', 'busanEtc', d(1), d(1)),
      ev('e', '곧 끝남', 'busanExhibit', d(-5), d(6)),
    ] },
    favorites: { m1: { key: 'm1' }, c: { key: 'c' }, gone: { key: 'gone', title: '목록에서 빠진 즐겨찾기', start: d(4), end: d(4) } },
    hidden: { h: { key: 'h' } },
    custom: [{ key: 'my1', title: '친구 약속', kind: 'mine', start: d(0), end: d(0) }],
    holidays: [{ date: d(2), name: '개천절' }],
  }, { today: TODAY, days: 7 });
  const titles = dg.events.map((e) => e.title);
  assert.deepEqual(dg.range, { from: TODAY, to: d(6), days: 7 });
  assert.ok(titles.includes('즐찾 영화') && !titles.includes('그냥 영화'), '영화는 즐겨찾기만');
  assert.ok(!titles.includes('숨긴 공연'), '숨긴 항목 제외');
  assert.ok(!titles.includes('다음달 전시'), '7일 밖 제외');
  assert.ok(titles.includes('친구 약속') && titles.includes('목록에서 빠진 즐겨찾기'));
  assert.equal(dg.events[0].favorite, true, '즐겨찾기가 먼저');
  assert.deepEqual(dg.favorites.map((e) => e.title), ['즐찾 영화', '목록에서 빠진 즐겨찾기', '다음달 전시'], '즐겨찾기는 기간과 관계없이 전부(끝난 것 제외)');
  assert.equal(dg.days[2].holiday, '개천절');
  assert.deepEqual(dg.days[2].starting.map((e) => e.title), ['주말 축제']);
  assert.deepEqual(dg.days[6].ending.map((e) => e.title), ['곧 끝남']);
  const text = digestText(dg);
  assert.match(text, /★ 즐겨찾기 \(3\)/);
  assert.match(text, /★ \[영화\] 즐찾 영화 — 한국 · 액션 \| .* \(1일 뒤 개봉\)/);
  assert.match(text, /🎌개천절/);
});

test('Gist 공개: 처음엔 비공개로 만들고, 이후 같은 Gist 수정, 내용 같으면 건너뜀, 토큰은 로그에 없음', async () => {
  const { publishGist } = await import('../src/publish.mjs');
  const calls = [];
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), method: opts.method, auth: opts.headers?.Authorization, body });
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'g123', owner: { login: 'JHNice' } }) };
  };
  try {
    fs.rmSync(path.join(TMP, 'data', 'gist.json'), { force: true });
    assert.deepEqual(await publishGist({}), { skipped: 'githubToken 없음' });
    const r1 = await publishGist({ githubToken: 'ghp_secret' });
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].body.public, false, '비공개 Gist');
    assert.ok(calls[0].body.files['busan-week.json'].content && calls[0].body.files['busan-week.txt'].content);
    assert.equal(calls[0].auth, 'Bearer ghp_secret');
    assert.equal(r1.urls.json, 'https://gist.githubusercontent.com/JHNice/g123/raw/busan-week.json');
    const r2 = await publishGist({ githubToken: 'ghp_secret' });
    assert.equal(r2.unchanged, true, '내용 같으면 안 올림');
    assert.equal(calls.length, 1);
    await publishGist({ githubToken: 'ghp_secret' }, { force: true });
    assert.equal(calls[1].method, 'PATCH');
    assert.match(calls[1].url, /\/gists\/g123$/);
    assert.ok(!logs.join('\n').includes('ghp_secret'), '토큰은 로그에 안 나옴');
    assert.ok(!fs.readFileSync(path.join(TMP, 'data', 'gist.json'), 'utf8').includes('ghp_secret'), '토큰은 gist.json 에 저장 안 함');
  } finally {
    globalThis.fetch = prevFetch;
    console.log = origLog;
  }
});

test('클라우드 실행: 상태 Gist 받기→수집→밤엔 보류·아침에 전송→중복 없음→클라우드 파일만 올림, 키 가리기', async () => {
  const { cloudRun, run } = await import('../src/index.mjs');
  const { inQuietHours, CLOUD_OWNED } = await import('../src/cloudsync.mjs');
  // 조용한 시간 계산 (KST)
  const at = (kstHour) => new Date(Date.UTC(2026, 9, 1, (kstHour + 15) % 24));
  assert.equal(inQuietHours({}, at(23)), true);
  assert.equal(inQuietHours({}, at(3)), true);
  assert.equal(inQuietHours({}, at(8)), false);
  assert.equal(inQuietHours({ quietHours: false }, at(3)), false);

  const store = {
    'favorites.json': JSON.stringify({ items: { [util.normalizeKey('부산행2', d(3))]: { title: '부산행2' } } }),
    'hidden.json': JSON.stringify({ items: {} }),
  };
  const patched = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const respond = (status, obj) => ({ ok: status < 300, status, text: async () => JSON.stringify(obj) });
    if (u === 'https://api.github.com/gists/S1') {
      if ((opts.method || 'GET') === 'GET') {
        return respond(200, { updated_at: 'x', files: Object.fromEntries(Object.entries(store).map(([k, v]) => [k, { content: v, truncated: false }])) });
      }
      const body = JSON.parse(opts.body);
      patched.push(Object.keys(body.files));
      for (const [k, v] of Object.entries(body.files)) store[k] = v.content;
      return respond(200, { id: 'S1' });
    }
    if (u === 'https://api.github.com/gists') return respond(201, { id: 'P1', owner: { login: 'JHNice' } });
    if (u.startsWith('https://api.github.com/gists/P1')) return respond(200, { id: 'P1', owner: { login: 'JHNice' } });
    return prevFetch(url, opts);
  };
  const cfgFile = path.join(TMP, 'config.json');
  const prevCfg = fs.readFileSync(cfgFile, 'utf8');
  const writeCfg = (extra) => fs.writeFileSync(cfgFile, JSON.stringify({
    dataGoKrKey: 'abc%2Bdef%3D%3D', kobisKey: 'kobis-secret', discordWebhookUrl: 'https://discord.com/api/webhooks/1/tok',
    githubToken: 'ghp_cloud', mode: 'cloud', cloud: { stateGistId: 'S1', repo: 'JHNice/bca' }, popupDelayMs: 0, ...extra,
  }));
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    // 깨끗한 클라우드 실행 환경처럼 클라우드 소유 파일 지우기
    for (const f of CLOUD_OWNED) fs.rmSync(f === 'state.json' ? path.join(TMP, f) : path.join(TMP, 'data', f), { force: true });
    fs.rmSync(path.join(TMP, 'data', 'favorites.json'), { force: true });

    writeCfg({ quietHours: { start: 0, end: 24 } }); // 항상 조용한 시간
    let before = webhookCalls.length;
    await cloudRun();
    assert.equal(webhookCalls.length, before, '밤에는 디스코드로 안 보냄');
    assert.ok(JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'favorites.json'), 'utf8')).items, 'PC 즐겨찾기를 상태 Gist 에서 받음');
    assert.ok(store['events.json'] && store['state.json'], '수집 결과·상태를 올림');
    assert.deepEqual(Object.keys(JSON.parse(store['state.json']).seen), [], '보류한 항목은 보냄 표시 안 함');
    assert.ok(patched.every((names) => names.every((n) => CLOUD_OWNED.includes(n))), 'PC 소유 파일은 올리지 않음');
    assert.ok(logs.some((l) => l === '::add-mask::ghp_cloud') && logs.some((l) => l === '::add-mask::kobis-secret'), '공개 실행 기록용 키 가리기');

    writeCfg({ quietHours: false }); // 아침
    await cloudRun();
    const sent = webhookCalls.slice(before).flatMap((m) => m.embeds || []).map((e) => e.title);
    assert.ok(sent.includes('무료 버스킹') && sent.includes('부산행2'), '아침에 밀린 알림 전송(즐겨찾기 영화 포함)');
    before = webhookCalls.length;
    await cloudRun();
    assert.equal(webhookCalls.length, before, '30분 뒤 다시 돌아도 중복 전송 없음');
    assert.ok(JSON.parse(store['gist.json']).id === 'P1', '공개 Gist 정보도 상태로 보관');

    // PC 로그온 실행은 클라우드 모드면 아무것도 안 함
    await run({});
    assert.equal(webhookCalls.length, before);
    assert.ok(logs.some((l) => l.includes('클라우드 모드 → PC에서는 수집·알림을 하지 않음')));
  } finally {
    console.log = origLog;
    globalThis.fetch = prevFetch;
    fs.writeFileSync(cfgFile, prevCfg);
  }
});

test('팝업: popupIntervalHours 안이면 사이트에 접속하지 않고 캐시 사용', async () => {
  const P = await import('../src/popups.mjs');
  const statusPath = path.join(TMP, 'data', 'popup-status.json');
  fs.writeFileSync(statusPath, JSON.stringify({ checkedAt: new Date().toISOString(), sites: [{ id: 'popply', label: '팝플리', state: 'ok', listed: 5 }] }));
  let netCalls = 0;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (...a) => { netCalls++; return prevFetch(...a); };
  try {
    const ctx = { today: TODAY };
    await P.fetchPopups({ popupIntervalHours: 3, popupDelayMs: 0 }, ctx);
    assert.equal(netCalls, 0, '3시간 안에는 접속 안 함');
    assert.equal(ctx.popupSkippedNetwork, true);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('클라우드 설정 스크립트: 상태 Gist·코드 업로드·암호화된 Secret·첫 실행 후 클라우드 모드 전환 (가짜 GitHub)', async () => {
  const S = await import('../src/sealedbox.mjs');
  const kp = S.nacl.box.keyPair();
  // 프로젝트 파일 흉내
  const mk = (rel, body) => { fs.mkdirSync(path.dirname(path.join(TMP, rel)), { recursive: true }); fs.writeFileSync(path.join(TMP, rel), body); };
  mk('README.md', '# readme'); mk('src/a.mjs', 'x'); mk('calendar/public/app.js', 'y');
  mk('deploy/github/workflows/collect.yml', 'name: collect'); mk('deploy/github/workflows/keepalive.yml', 'name: k'); mk('deploy/github/heartbeat', 't');
  mk('CLAUDE.md', 'C:\\\\Users\\\\me 개인 메모');
  mk('src/leak.mjs', 'const k = "REALKEY12345";');
  const cfgFile = path.join(TMP, 'config.json');
  const prevCfg = fs.readFileSync(cfgFile, 'utf8');
  fs.writeFileSync(cfgFile, JSON.stringify({ dataGoKrKey: 'REALKEY12345', discordWebhookUrl: 'https://discord.com/api/webhooks/1/tok', githubToken: 'ghp_setup' }));
  const uploads = {};
  let secretBody = null;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url).replace('https://api.github.com', '');
    const m = opts.method || 'GET';
    const ok = (obj, status = 200) => ({ ok: true, status, text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)) });
    const nf = () => ({ ok: false, status: 404, text: async () => '{"message":"Not Found"}' });
    if (u === '/user') return ok({ login: 'JHNice' });
    if (u === '/repos/JHNice/busan-culture-alert') return ok({ private: false, default_branch: 'main' });
    if (u === '/gists' && m === 'POST') return ok({ id: 'STATE9' }, 201);
    if (u.startsWith('/gists/STATE9')) return ok({ id: 'STATE9' });
    if (u.startsWith('/repos/JHNice/busan-culture-alert/contents/')) {
      const p = decodeURIComponent(u.split('/contents/')[1]);
      if (m === 'GET') return nf();
      uploads[p] = Buffer.from(JSON.parse(opts.body).content, 'base64').toString();
      return ok({}, 201);
    }
    if (u.endsWith('/actions/secrets/public-key')) return ok({ key: Buffer.from(kp.publicKey).toString('base64'), key_id: 'K1' });
    if (u.endsWith('/actions/secrets/BCA_CONFIG')) { secretBody = JSON.parse(opts.body); return ok({}, 201); }
    if (u.endsWith('/dispatches')) return ok('', 204);
    if (u.includes('/actions/workflows/collect.yml/runs')) return ok({ workflow_runs: [{ id: 7, status: 'completed', conclusion: 'success', created_at: new Date().toISOString(), html_url: 'h' }] });
    if (u.endsWith('/runs/7/jobs')) return ok({ jobs: [{ id: 70 }] });
    if (u.endsWith('/jobs/70/logs')) return ok('2026-10-03T00:00:00Z [2026-10-03T00:00:00Z] 디스코드 전송 완료');
    throw new Error('예상 못한 요청 ' + m + ' ' + u);
  };
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => realTimeout(fn, Math.min(ms, 5), ...a); // 기다림 생략
  const out = [];
  const origLog = console.log, origErr = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push('ERR ' + a.join(' '));
  try {
    const { main } = await import('../src/cloud-setup.mjs');
    // 키가 든 파일이 있으면 중단
    await assert.rejects(main(), /leak\.mjs 안에 키/);
    fs.rmSync(path.join(TMP, 'src', 'leak.mjs'));
    await main();
    assert.ok(uploads['.github/workflows/collect.yml'] && uploads['.github/heartbeat'], '워크플로는 .github 아래로');
    assert.ok(uploads['README.md'] && uploads['src/a.mjs'] && uploads['calendar/public/app.js']);
    assert.ok(!Object.keys(uploads).some((p) => /config\.json$|state\.json$|^data\/|^logs\/|CLAUDE\.md/.test(p)), '개인 데이터·CLAUDE.md 는 안 올림');
    assert.equal(secretBody.key_id, 'K1');
    const opened = JSON.parse(S.openSealedBase64(secretBody.encrypted_value, kp));
    assert.equal(opened.mode, 'cloud');
    assert.equal(opened.cloud.stateGistId, 'STATE9');
    assert.equal(opened.dataGoKrKey, 'REALKEY12345', 'Secret 은 GitHub 공개키로만 열림');
    const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.deepEqual([saved.mode, saved.cloud.stateGistId, saved.cloud.repo], ['cloud', 'STATE9', 'JHNice/busan-culture-alert']);
    assert.ok(!out.join('\n').includes('REALKEY12345') && !out.join('\n').includes('ghp_setup'), '키·토큰은 화면에 안 나옴');
  } finally {
    console.log = origLog; console.error = origErr;
    globalThis.setTimeout = realTimeout;
    globalThis.fetch = prevFetch;
    fs.writeFileSync(cfgFile, prevCfg);
  }
});
