// 데이터 소스별 수집기. 모두 같은 형태의 항목으로 정규화한다.
// 항목: { id, source, category, title, start, end, place, price, priceText, paidUnknown, url, image, openRun }
import { getText, parseApiResponse, ApiError } from './http.mjs';
import { toISO, parsePrice, compactDate, addDays, sleep, parseXmlItems, log } from './util.mjs';
import { fetchPopups } from './popups.mjs';

const BUSAN = 'https://apis.data.go.kr/6260000';
const MAX_PAGES = 5;
// 부산 API 3종은 날짜 필터 없이 전체를 오래된 순서로 준다 (전시는 3000건 이상).
// 최신 항목은 뒤쪽에 있으므로 1쪽으로 전체 건수를 확인한 뒤 마지막 쪽부터 읽는다.
const BUSAN_MAX_PAGES = 30;
const ROWS = 100;

// 부산 대략 좌표 범위 (한눈에보는문화정보 지역 필터 보조용)
const BUSAN_BBOX = { xmin: 128.75, xmax: 129.35, ymin: 34.95, ymax: 35.45 };

async function paged(fetchPage, maxPages = MAX_PAGES) {
  const all = [];
  let total = Infinity;
  for (let page = 1; page <= maxPages && all.length < total; page++) {
    const { items, totalCount } = await fetchPage(page);
    all.push(...items);
    total = totalCount ?? all.length;
    if (items.length < ROWS) break;
  }
  return all;
}

async function busanPaged(pathName, key) {
  const fetchPage = async (page) =>
    parseApiResponse(
      await getText(`${BUSAN}/${pathName}`, { ServiceKey: key, pageNo: page, numOfRows: ROWS, resultType: 'json' }),
    );
  const first = await fetchPage(1);
  const lastPage = Math.ceil((first.totalCount ?? first.items.length) / ROWS);
  if (lastPage <= 1) return first.items;
  const fromPage = Math.max(2, lastPage - (BUSAN_MAX_PAGES - 1) + 1);
  if (fromPage > 2) log(`${pathName}: 전체 ${first.totalCount}건 → 1쪽 + 최신 ${lastPage - fromPage + 1}쪽(${fromPage}~${lastPage})만 읽음`);
  const all = [...first.items];
  for (let page = lastPage; page >= fromPage; page--) all.push(...(await fetchPage(page)).items);
  return all;
}

export const SOURCES = [
  {
    id: 'busanExhibit',
    label: '부산 전시 (부산문화포털)',
    keyField: 'dataGoKrKey',
    async fetch(cfg) {
      const raw = await busanPaged('BusanCultureExhibitDetailService/getBusanCultureExhibitDetail', cfg.dataGoKrKey);
      return raw.map((r) => ({
        id: `bx:${r.res_no}`,
        category: '전시',
        title: r.title,
        start: toISO(r.op_st_dt),
        end: toISO(r.op_ed_dt),
        place: r.place_nm,
        priceText: r.price || '',
        price: parsePrice(r.price),
        url: r.dabom_url,
        openRun: r.op_at === 'Y',
      }));
    },
  },
  {
    id: 'busanEtc',
    label: '부산 기타 공연·행사 (부산문화포털)',
    keyField: 'dataGoKrKey',
    async fetch(cfg) {
      const raw = await busanPaged('BusanCultureEtcService/getBusanCultureEtc', cfg.dataGoKrKey);
      return raw.map((r) => {
        const free = r.pay_at === 'N';
        return {
          id: `be:${r.res_no}`,
          category: '공연·행사',
          title: r.title,
          start: toISO(r.op_st_dt),
          end: toISO(r.op_ed_dt),
          place: r.place_nm,
          priceText: free ? '무료' : '유료',
          price: free ? 0 : null,
          paidUnknown: !free,
          openRun: r.op_at === 'Y',
        };
      });
    },
  },
  {
    id: 'busanCultureDay',
    label: '부산 문화가 있는 날',
    keyField: 'dataGoKrKey',
    async fetch(cfg) {
      const raw = await busanPaged('BusanCultureDayService/getBusanCultureDay', cfg.dataGoKrKey);
      return raw.map((r) => {
        const day = toISO(r.dt_ymd);
        return {
          id: `cd:${r.place_nm}|${r.program_nm}|${day}`,
          category: '문화가 있는 날',
          title: [r.program_nm, r.place_nm].filter(Boolean).join(' @ '),
          start: day,
          end: day,
          place: [r.gugun, r.place_dtl || r.place_nm].filter(Boolean).join(' '),
          priceText: r.benefit ? `혜택: ${r.benefit}` : '',
          price: parsePrice(r.benefit) === 0 ? 0 : null,
          url: r.url,
          time: r.dt_time,
        };
      });
    },
  },
  {
    id: 'cultureInfo',
    label: '한눈에보는문화정보 (한국문화정보원)',
    keyField: 'dataGoKrKey',
    async fetch(cfg, ctx) {
      const from = compactDate(ctx.today);
      const to = compactDate(addDays(ctx.today, cfg.lookaheadDays));
      const raw = await paged(async (page) =>
        parseApiResponse(
          await getText('https://apis.data.go.kr/B553457/cultureinfo/period2', {
            serviceKey: cfg.dataGoKrKey,
            PageNo: page,
            numOfrows: ROWS, // 이 API는 소문자 r (numOfrows)
            from,
            to,
            gpsxfrom: BUSAN_BBOX.xmin,
            gpsxto: BUSAN_BBOX.xmax,
            gpsyfrom: BUSAN_BBOX.ymin,
            gpsyto: BUSAN_BBOX.ymax,
            sortStdr: 1,
          }),
        ),
      );
      const realms = cfg.cultureInfoRealms || [];
      return raw
        .filter((r) => isBusan(r))
        .filter((r) => realms.length === 0 || realms.some((k) => String(r.realmName || '').includes(k)))
        .map((r) => ({
          id: `ci:${r.seq}`,
          category: r.realmName || '문화행사',
          title: r.title,
          start: toISO(r.startDate),
          end: toISO(r.endDate),
          place: r.place,
          priceText: r.price || '',
          price: parsePrice(r.price),
          url: r.url,
          image: r.thumbnail,
        }));
    },
  },
  {
    id: 'tourFestival',
    label: '축제·행사 (한국관광공사 TourAPI)',
    keyField: 'dataGoKrKey',
    async fetch(cfg, ctx) {
      const base = {
        serviceKey: cfg.dataGoKrKey,
        MobileOS: 'ETC',
        MobileApp: 'BusanCultureAlert',
        _type: 'json',
        numOfRows: ROWS,
        // 이미 시작해서 진행 중인 축제도 잡기 위해 넉넉히 과거부터 조회 후 종료일로 거른다
        eventStartDate: compactDate(addDays(ctx.today, -120)),
      };
      const url = 'https://apis.data.go.kr/B551011/KorService2/searchFestival2';
      const run = (region) =>
        paged(async (page) => parseApiResponse(await getText(url, { ...base, ...region, pageNo: page })));
      // 실제 확인(2026-09): KorService2 에서 areaCode=6 은 오류 없이 0건을 준다 → 신규 법정동 코드(부산=26) 우선
      let raw = [];
      try {
        raw = await run({ lDongRegnCd: 26 });
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
      }
      if (raw.length === 0) raw = await run({ areaCode: 6 }); // 구 지역코드로 재시도
      return raw
        .filter((r) => !r.addr1 || /부산/.test(r.addr1))
        .map((r) => ({
          id: `tf:${r.contentid}`,
          category: '축제·행사',
          title: r.title,
          start: toISO(r.eventstartdate),
          end: toISO(r.eventenddate),
          place: r.addr1,
          priceText: '',
          price: null,
          image: r.firstimage,
        }));
    },
  },
  {
    id: 'kopis',
    label: '공연 (KOPIS)',
    keyField: 'kopisKey',
    async fetch(cfg, ctx) {
      const stdate = compactDate(ctx.today);
      const eddate = compactDate(addDays(ctx.today, cfg.lookaheadDays));
      const raw = await paged(async (page) => {
        const res = await getText('http://www.kopis.or.kr/openApi/restful/pblprfr', {
          service: cfg.kopisKey,
          stdate,
          eddate,
          cpage: page,
          rows: ROWS,
          signgucode: 26, // 부산
        });
        const parsed = parseApiResponse(res, { xmlItemTag: 'db' });
        return { items: parsed.items, totalCount: null };
      });
      return raw.map((r) => ({
        id: `kp:${r.mt20id}`,
        kopisId: r.mt20id,
        category: r.genrenm || '공연',
        title: r.prfnm,
        start: toISO(r.prfpdfrom),
        end: toISO(r.prfpdto),
        place: r.fcltynm,
        priceText: '',
        price: null,
        paidUnknown: true, // 상세 조회 전까지는 가격 모름
        image: r.poster,
      }));
    },
    // 새 항목만 상세를 조회해서 가격을 채운다 (호출 수 절약)
    async enrich(items, cfg, { isNew }) {
      let calls = 0;
      for (const it of items) {
        if (!isNew(it) || calls >= 60) continue;
        calls++;
        try {
          const res = await getText(`http://www.kopis.or.kr/openApi/restful/pblprfr/${it.kopisId}`, { service: cfg.kopisKey }, { retries: 1 });
          const d = parseXmlItems(res.text, 'db')[0];
          if (d?.pcseguidance) {
            it.priceText = d.pcseguidance;
            it.price = parsePrice(d.pcseguidance);
            it.paidUnknown = it.price == null;
          }
        } catch {
          /* 상세 실패는 무시하고 가격 미상으로 둔다 */
        }
        await sleep(150);
      }
    },
  },
  {
    id: 'movies',
    label: '영화 개봉 (KOBIS)',
    keyField: 'kobisKey',
    calendarOnly: true, // 디스코드는 즐겨찾기한 영화만 (index.mjs)
    async fetch(cfg, ctx) {
      const y = Number(ctx.today.slice(0, 4));
      const url = 'http://www.kobis.or.kr/kobisopenapi/webservice/rest/movie/searchMovieList.json';
      const all = [];
      for (let page = 1; page <= 40; page++) {
        const res = await getText(url, { key: cfg.kobisKey, openStartDt: y, openEndDt: y + 1, itemPerPage: 100, curPage: page });
        if (res.status !== 200) throw new ApiError(`HTTP ${res.status}`);
        let data;
        try {
          data = JSON.parse(res.text);
        } catch {
          throw new ApiError(`JSON 파싱 실패: ${res.text.slice(0, 120)}`);
        }
        if (data.faultInfo) throw new ApiError(`KOBIS 오류: ${data.faultInfo.message} (${data.faultInfo.errorCode})`);
        const list = data.movieListResult?.movieList || [];
        all.push(...list);
        if (list.length < 100 || all.length >= Number(data.movieListResult?.totCnt || 0)) break;
        await sleep(150);
      }
      const from = addDays(ctx.today, -14);
      return all
        .filter((m) => m.openDt && m.typeNm !== '단편' && m.prdtStatNm !== '기타')
        .map((m) => {
          const day = toISO(m.openDt);
          const director = (m.directors || []).map((d) => d.peopleNm).filter(Boolean).slice(0, 2).join(', ');
          return {
            id: `mv:${m.movieCd}`,
            category: '영화',
            title: m.movieNm,
            start: day,
            end: day,
            place: null,
            priceText: '',
            price: null,
            info: [m.repNationNm || m.nationAlt, m.genreAlt, director && `감독 ${director}`].filter(Boolean).join(' · '),
            url: `https://search.naver.com/search.naver?query=${encodeURIComponent(`영화 ${m.movieNm}`)}`,
            remindStart: true, // 즐겨찾기한 영화는 개봉 하루 전에 한 번 더 알림
          };
        })
        .filter((m) => m.start && m.start >= from);
    },
  },
  {
    id: 'popups',
    label: '팝업스토어 (팝플리·팝가·데이포유)',
    keyField: null, // 키 필요 없음
    fetch: (cfg, ctx) => fetchPopups(cfg, ctx),
  },
];

function isBusan(r) {
  if (r.area) return /부산/.test(r.area);
  const x = Number(r.gpsX);
  const y = Number(r.gpsY);
  if (Number.isFinite(x) && Number.isFinite(y) && x && y) {
    return x >= BUSAN_BBOX.xmin && x <= BUSAN_BBOX.xmax && y >= BUSAN_BBOX.ymin && y <= BUSAN_BBOX.ymax;
  }
  return /부산/.test(r.place || '');
}
