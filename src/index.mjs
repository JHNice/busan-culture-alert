// 부산 문화 알림 — 진입점
//   node src/index.mjs                 평소 실행 (하루 1회만 실제 동작)
//   node src/index.mjs --force         오늘 이미 돌았어도 다시 실행
//   node src/index.mjs --dry-run       디스코드 전송/상태 저장 없이 결과만 콘솔에 출력
//   node src/index.mjs --check         API별 연결·데이터 최신 여부 점검
//   node src/index.mjs --check --dump  + 소스별 원본 응답을 logs/raw/ 에 저장 (키는 *** 로 가림)
//   node src/index.mjs --test-webhook  디스코드 웹훅으로 테스트 메시지 1개 전송
//   node src/index.mjs --refresh-events 전송 없이 캘린더용 data/events.json 만 갱신
//   node src/index.mjs --week          앞으로 7일 일정·즐겨찾기 요약 출력
//   node src/index.mjs --publish       위 요약을 비공개 GitHub Gist 로 올리고 주소 출력
//   node src/index.mjs --cloud         (GitHub Actions 전용) 상태 Gist 받기 → 수집·알림 → 상태 Gist 올리기
//   node src/index.mjs --local         클라우드 모드에서도 PC에서 직접 수집·알림 (평소엔 쓰지 않음)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, todayKST, log, addDays, normalizeKey } from './util.mjs';
import { SOURCES } from './sources.mjs';
import { isActive, passesPrice, dedupe, classify, markSent } from './core.mjs';
import { dump } from './http.mjs';
import { buildMessages, sendAll, postWebhook, isWebhookUrl } from './discord.mjs';
import { buildSnapshot, loadEvents, saveEvents } from './events.mjs';
import { refreshHolidays } from './holidays.mjs';
import { publishSafe, publishGist, buildPayload, rawUrls } from './publish.mjs';
import { CLOUD_OWNED, PC_OWNED, pullFiles, pushFiles, inQuietHours } from './cloudsync.mjs';

const DEFAULTS = {
  dataGoKrKey: '',
  kopisKey: '',
  kobisKey: '',
  discordWebhookUrl: '',
  maxPrice: 20000,
  includeUnknownPrice: true,
  includePaidUnknownPrice: false,
  endingSoonDays: 7,
  lookaheadDays: 30,
  maxItemsPerRun: 0, // 0 = 제한 없음
  runOncePerDay: true,
  cultureInfoRealms: ['전시'],
  sources: {
    busanExhibit: true,
    busanEtc: true,
    busanCultureDay: true,
    cultureInfo: true,
    tourFestival: true,
    kopis: true,
    movies: true,
    popups: true,
  },
  popupRegions: ['부산'],
  popupSites: [],
  holidays: true,
  mode: 'local', // 'cloud' = 수집·알림은 GitHub Actions 가 하고 PC는 캘린더만
  cloud: {},
  popupIntervalHours: 0,
  quietHours: { start: 23, end: 8 }, // 클라우드에서 이 시간엔 디스코드 알림을 모아 두었다가 아침에
};

export function loadConfig(file = path.join(ROOT, 'config.json')) {
  if (!fs.existsSync(file)) {
    throw new Error(`config.json 이 없습니다. config.example.json 을 복사해서 config.json 으로 만들고 키를 넣어주세요. (${file})`);
  }
  const user = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const cfg = { ...DEFAULTS, ...user, sources: { ...DEFAULTS.sources, ...(user.sources || {}) } };
  // 공공데이터포털 'Encoding' 키를 넣은 경우 자동으로 디코딩
  for (const k of ['dataGoKrKey', 'kopisKey', 'kobisKey']) {
    cfg[k] = String(cfg[k] || '').trim();
    if (cfg[k].includes('%')) {
      try {
        cfg[k] = decodeURIComponent(cfg[k]);
      } catch {}
    }
  }
  cfg.discordWebhookUrl = String(cfg.discordWebhookUrl || '').trim();
  cfg.githubToken = String(cfg.githubToken || '').trim();
  return cfg;
}

// 캘린더의 즐겨찾기(favorites.json)·관심 없음(hidden.json) key 목록
function loadKeyStore(name) {
  try {
    return new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', name), 'utf8')).items || {}));
  } catch {
    return new Set();
  }
}

const STATE_FILE = () => path.join(ROOT, 'state.json');
export function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
  } catch {
    return { lastRunDate: null, seen: {} };
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE(), JSON.stringify(state, null, 2));
}

const labelOf = (id) => SOURCES.find((s) => s.id === id)?.label ?? id;

const hasKey = (cfg, s) => !s.keyField || !!cfg[s.keyField];
const CALENDAR_ONLY = new Set(SOURCES.filter((s) => s.calendarOnly).map((s) => s.id));
function enabledSources(cfg) {
  return SOURCES.filter((s) => cfg.sources[s.id] !== false && hasKey(cfg, s));
}

async function collect(cfg, today, state) {
  const all = [];
  const errors = [];
  const ctx = { today };
  for (const src of enabledSources(cfg)) {
    try {
      const items = (await src.fetch(cfg, ctx)).map((it) => ({ ...it, source: src.id }));
      const active = items.filter((it) => isActive(it, today, cfg.lookaheadDays));
      if (src.enrich) {
        await src.enrich(active, cfg, { isNew: (it) => !state.seen[normalizeKey(it.title, it.start)] });
      }
      log(`${src.label}: 받음 ${items.length}개, 진행/예정 ${active.length}개`);
      all.push(...active);
    } catch (err) {
      log(`${src.label}: 실패 —`, err.message);
      errors.push({ label: src.label, message: err.message, calendarOnly: !!src.calendarOnly });
    }
  }
  const filtered = dedupe(all.filter((it) => passesPrice(it, cfg)));
  return { items: filtered, errors, allFailed: errors.length > 0 && errors.length === enabledSources(cfg).length };
}

async function writeSnapshot(items, cfg, state, today) {
  try {
    saveEvents(buildSnapshot(items, { state, today, prev: loadEvents(), labelOf, endingSoonDays: cfg.endingSoonDays }));
  } catch (err) {
    log('캘린더 데이터 저장 실패 —', err.message);
  }
  await refreshHolidays(cfg, today);
  await publishSafe(cfg);
}

async function refreshEvents() {
  const cfg = loadConfig();
  const today = todayKST();
  const state = loadState();
  const { items, errors } = await collect(cfg, today, state);
  classify(items, state, cfg, today);
  await writeSnapshot(items, cfg, state, today);
  log(`캘린더 데이터 갱신: ${items.length}개 / 오류 소스 ${errors.length}개`);
}

async function run({ force, dryRun, cloud = false, local = false, quiet = false, cfg = loadConfig() }) {
  const today = todayKST();
  const state = loadState();

  if (cfg.mode === 'cloud' && !cloud && !local && !dryRun) {
    log('클라우드 모드 → PC에서는 수집·알림을 하지 않음 (GitHub Actions 가 30분마다 실행). 직접 하려면 --local');
    return;
  }
  if (cfg.runOncePerDay && state.lastRunDate === today && !force && !dryRun) {
    log(`오늘(${today}) 이미 실행됨 → 종료 (다시 돌리려면 --force)`);
    return;
  }
  if (!cfg.dataGoKrKey && !cfg.kopisKey) throw new Error('config.json 에 dataGoKrKey(또는 kopisKey)가 비어 있습니다.');
  if (!dryRun && !isWebhookUrl(cfg.discordWebhookUrl)) throw new Error('config.json 의 discordWebhookUrl 이 디스코드 웹훅 주소 형식이 아닙니다.');

  const { items, errors, allFailed } = await collect(cfg, today, state);
  // 영화·팝업은 캘린더 전용 → 디스코드 알림 대상에서 제외
  const hidden = loadKeyStore('hidden.json');
  const favs = loadKeyStore('favorites.json');
  // 캘린더 전용(영화)은 즐겨찾기한 것만 디스코드로. 숨긴 행사는 제외
  const alertItems = items.filter((it) => (!CALENDAR_ONLY.has(it.source) || favs.has(it.key)) && !hidden.has(it.key));
  const { fresh, ending } = classify(alertItems, state, cfg, today);
  classify(items.filter((it) => !alertItems.includes(it)), state, cfg, today);

  const budget = cfg.maxItemsPerRun > 0 ? cfg.maxItemsPerRun : Infinity; // 0 이하 = 제한 없음
  const sendEnding = ending.slice(0, budget);
  const sendFresh = fresh.slice(0, Math.max(0, budget - sendEnding.length));
  const overflow = ending.length + fresh.length - sendEnding.length - sendFresh.length;

  log(`결과: 조건 통과 ${alertItems.length}개 (캘린더 전용 ${items.length - alertItems.length}개 별도) / 새 항목 ${fresh.length}개 / 마감 임박 ${ending.length}개 / 오류 소스 ${errors.length}개`);

  if (dryRun) {
    for (const it of [...sendEnding, ...sendFresh]) {
      console.log(`- [${it.endingSoon ? '마감임박' : '신규'}] ${it.title} | ${it.start}~${it.end} | ${it.place ?? ''} | ${it.price ?? '?'}원 | ${labelOf(it.source)}`);
    }
    log('dry-run: 디스코드 전송과 상태 저장을 건너뜀');
    await writeSnapshot(items, cfg, state, today);
    return;
  }

  const nothing = sendFresh.length === 0 && sendEnding.length === 0;
  if (quiet) {
    // 밤에는 보내지도, 보냄 표시도 하지 않는다 → 아침 첫 실행 때 한꺼번에 나간다
    log(`조용한 시간 → 디스코드 알림 보류 (대기 ${sendFresh.length + sendEnding.length}개)`);
    saveState(state);
    await writeSnapshot(items, cfg, state, today);
    return;
  }
  if (nothing && errors.filter((e) => !e.calendarOnly).length === 0) {
    log('보낼 새 소식 없음');
  } else {
    const alertErrors = errors.filter((e) => !e.calendarOnly);
    const messages = buildMessages({ today, fresh: sendFresh, ending: sendEnding, overflow, errors: alertErrors, labelOf });
    await sendAll(cfg.discordWebhookUrl, messages);
    log(`디스코드 전송 완료: 메시지 ${messages.length}개`);
  }

  markSent(state, [...sendEnding, ...sendFresh], today);
  // 전부 실패(인터넷 미연결 등)면 '오늘 실행함'으로 기록하지 않아 다음 로그온 때 다시 시도
  if (!allFailed) state.lastRunDate = today;
  saveState(state);
  if (!allFailed) await writeSnapshot(items, cfg, state, today);
}

async function check({ withDump = false } = {}) {
  const cfg = loadConfig();
  dump.enabled = withDump;
  const today = todayKST();
  const lines = [`점검 일시: ${new Date().toISOString()} (KST 오늘 ${today})`, ''];
  lines.push(`디스코드 웹훅: ${isWebhookUrl(cfg.discordWebhookUrl) ? '형식 OK' : '❌ 비어 있거나 형식이 다름'}`);
  lines.push(`공공데이터포털 키: ${cfg.dataGoKrKey ? '입력됨' : '❌ 비어 있음'} / KOPIS 키: ${cfg.kopisKey ? '입력됨' : '(선택) 비어 있음'} / KOBIS(영화) 키: ${cfg.kobisKey ? '입력됨' : '비어 있음'}`);
  lines.push('');

  for (const src of SOURCES) {
    if (!hasKey(cfg, src)) {
      lines.push(`■ ${src.label}\n   건너뜀 — ${src.keyField} 없음`);
      continue;
    }
    if (cfg.sources[src.id] === false) {
      lines.push(`■ ${src.label}\n   꺼짐 (config.json sources)`);
      continue;
    }
    dump.records = [];
    const ctx = { today };
    const siteLines = () =>
      (ctx.popupStatus?.sites || []).map((s) => {
        const mark = { ok: '✅', partial: '⏳ 일부', blocked: '⛔ 막힘', error: '❌' }[s.state] || s.state;
        return `   - ${s.label}: ${mark} · 목록 ${s.listed} / 이번에 읽음 ${s.fetched} / 부산 ${s.matched}${s.message ? ' — ' + s.message : ''}`;
      });
    try {
      const items = await src.fetch(cfg, ctx);
      const active = items.filter((it) => isActive(it, today, cfg.lookaheadDays));
      const latestEnd = items.map((it) => it.end).filter(Boolean).sort().at(-1) ?? '없음';
      const verdict =
        items.length === 0 ? '⚠️ 응답은 정상인데 데이터 0건'
        : active.length === 0 ? `⚠️ 데이터는 오지만 진행 중/예정 항목 0건 (가장 늦은 종료일 ${latestEnd}) — 최신화가 안 된 소스일 수 있음`
        : '✅ 사용 가능';
      lines.push(`■ ${src.label}\n   ${verdict}\n   전체 ${items.length}건 / 진행·예정 ${active.length}건 / 가장 늦은 종료일 ${latestEnd}`);
      if (active[0]) lines.push(`   예시: ${active[0].title} (${active[0].start} ~ ${active[0].end}) 가격=${active[0].price ?? '미상'}`);
      lines.push(...siteLines());
    } catch (err) {
      lines.push(`■ ${src.label}\n   ❌ 실패: ${err.message}`, ...siteLines());
    }
    if (withDump && dump.records.length) {
      const dir = path.join(ROOT, 'logs', 'raw');
      fs.mkdirSync(dir, { recursive: true });
      const write = (name, r) => fs.writeFileSync(path.join(dir, name), `URL: ${r.url}\nHTTP ${r.status}\n\n${r.text}`);
      if (src.id === 'popups') dump.records.forEach((r, i) => write(`popups-${i + 1}.txt`, r));
      else write(`${src.id}.txt`, dump.records[0]);
      // 여러 번 호출한 소스는 마지막 응답도 저장 (최신 쪽 페이지, 지역코드 재시도 결과 확인용)
      if (src.id !== 'popups' && dump.records.length > 1) write(`${src.id}-last.txt`, dump.records.at(-1));
    }
    lines.push('');
  }
  lines.push(`GitHub Gist 공개: ${cfg.githubToken ? '토큰 입력됨' : '꺼짐 (githubToken 없음)'}`);
  const hol = await refreshHolidays(cfg, today);
  lines.push(`■ 대한민국 공휴일 (한국천문연구원 특일 정보)`);
  lines.push(hol.error ? `   ❌ 실패: ${hol.error}${hol.days?.length ? ` (이전에 받아 둔 ${hol.days.length}일 사용)` : ''}` : `   ✅ ${hol.days.length}일 (${hol.days[0]?.date ?? '-'} ~ ${hol.days.at(-1)?.date ?? '-'})`);
  lines.push('');
  const report = lines.join('\n');
  console.log(report);
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  const out = path.join(ROOT, 'logs', `check-${today}.txt`);
  fs.writeFileSync(out, report);
  console.log(`\n점검 결과 저장: ${out}`);
}

// GitHub Actions 에서 30분마다 실행
async function cloudRun() {
  const cfg = loadConfig();
  // 공개 저장소의 실행 기록에 키가 찍히지 않도록 가리기 등록
  for (const v of [cfg.dataGoKrKey, encodeURIComponent(cfg.dataGoKrKey || ''), cfg.kopisKey, cfg.kobisKey, cfg.githubToken, cfg.discordWebhookUrl, cfg.cloud?.stateGistId]) {
    if (v && String(v).length > 6) console.log(`::add-mask::${v}`);
  }
  if (!cfg.cloud?.stateGistId || !cfg.githubToken) throw new Error('config 에 cloud.stateGistId / githubToken 이 없습니다');
  const pulled = await pullFiles(cfg, [...CLOUD_OWNED, ...PC_OWNED]);
  log(`상태 Gist 받음: ${pulled.got.length}개 파일`);
  const quiet = inQuietHours(cfg);
  await run({ cloud: true, quiet, cfg: { ...cfg, runOncePerDay: false, popupIntervalHours: cfg.popupIntervalHours || 3 } });
  const pushed = await pushFiles(cfg, CLOUD_OWNED);
  log(`상태 Gist 올림: ${pushed.pushed.join(', ')}`);
}

async function week() {
  console.log(buildPayload().text);
}

async function publish() {
  const cfg = loadConfig();
  if (!cfg.githubToken) throw new Error('config.json 에 githubToken(권한: gist) 이 없습니다.');
  const r = await publishGist(cfg, { force: true });
  console.log('Gist 갱신 완료 — 아래 주소는 바뀌지 않습니다 (주소를 아는 사람은 누구나 읽을 수 있으니 공유하지 마세요)');
  console.log(`  JSON : ${r.urls.json}`);
  console.log(`  텍스트: ${r.urls.text}`);
}

async function testWebhook() {
  const cfg = loadConfig();
  if (!isWebhookUrl(cfg.discordWebhookUrl)) throw new Error('discordWebhookUrl 형식이 올바르지 않습니다.');
  await postWebhook(cfg.discordWebhookUrl, { content: `✅ 부산 문화 알림 웹훅 테스트 (${todayKST()})` });
  log('웹훅 테스트 메시지 전송 완료');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = new Set(process.argv.slice(2));
  const task = args.has('--check') ? check({ withDump: args.has('--dump') })
    : args.has('--test-webhook') ? testWebhook()
    : args.has('--refresh-events') ? refreshEvents()
    : args.has('--week') ? week()
    : args.has('--publish') ? publish()
    : args.has('--cloud') ? cloudRun()
    : run({ force: args.has('--force'), dryRun: args.has('--dry-run'), local: args.has('--local') });
  task.catch((err) => {
    log('오류:', err.message);
    process.exitCode = 1;
  });
}

export { run, check, collect, addDays, refreshEvents, cloudRun };
