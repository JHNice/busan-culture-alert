// 부산 문화 캘린더 — 로컬 서버 + Edge 앱 창
//   node calendar/server.mjs            서버 시작 후 앱 창 열기 (이미 떠 있으면 창만 열기)
//   node calendar/server.mjs --logon    config.json 의 openCalendarOnLogon 이 false 면 아무것도 안 함
//   node calendar/server.mjs --no-open  창 없이 서버만 (개발/테스트용)
// 창을 닫으면(하트비트가 끊기면) 몇 분 뒤 서버도 스스로 종료된다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../src/util.mjs';
import { eventsFile } from '../src/events.mjs';
import { loadHolidays } from '../src/holidays.mjs';
import { buildPayload, publishSafe } from '../src/publish.mjs';
import { statusFile as popupStatusFile } from '../src/popups.mjs';
import { cloudEnabled, pullFiles, pushFiles, dispatchWorkflow, PC_OWNED } from '../src/cloudsync.mjs';

const PORT = Number(process.env.BCA_CAL_PORT) || 17863;
const HOST = '127.0.0.1';
const ORIGIN = `http://${HOST}:${PORT}`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const MAIN = path.join(HERE, '..', 'src', 'index.mjs');

// 코드 버전 = 서버·화면·수집 코드 파일들의 마지막 수정 시각. 업데이트 후 새로 실행하면
// 예전 버전 서버를 내리고 교체하며, 열려 있는 창도 알아서 새로고침한다.
function codeVersion() {
  let max = 0;
  for (const dir of [HERE, path.join(HERE, 'public'), path.join(HERE, '..', 'src')]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (/\.(mjs|js|html|css)$/.test(f)) max = Math.max(max, fs.statSync(path.join(dir, f)).mtimeMs);
      }
    } catch {}
  }
  return String(Math.round(max));
}
export const VERSION = codeVersion();
const IDLE_MS = Number(process.env.BCA_CAL_IDLE_MS) || 4 * 60 * 1000; // 숨긴 창은 타이머가 1분 단위로 느려지므로 넉넉히
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };

const args = new Set(process.argv.slice(2));
const log = (...a) => console.log(`[${new Date().toISOString()}] [calendar]`, ...a);

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^﻿/, ''));
  } catch {
    return {};
  }
}

export function openWindow(url = ORIGIN + '/') {
  if (args.has('--no-open')) return;
  if (process.platform === 'win32') {
    // Edge 앱 모드: 주소창 없는 독립 창. 창 크기·위치는 Edge 가 기억한다.
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"start "" msedge --app=${url}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => log('창 열기 실패', e.message));
    child.unref();
  } else {
    log('앱 창은 Windows 에서만 자동으로 열립니다:', url);
  }
}

// ---------- 새로고침 (실제 API 호출, 디스코드 전송 없음) ----------
const refresh = { running: false, startedAt: null, finishedAt: null, ok: null, tail: '' };
// ---------- 클라우드 모드: 상태 Gist 에서 수집 결과 받기 ----------
const cloudInfo = () => (cloudEnabled(readConfig()) ? { ...cloud } : null);
const PULL_FROM_CLOUD = ['events.json', 'holidays.json', 'popup-status.json', 'gist.json'];
const cloud = { lastPull: null, lastError: null, updatedAt: null };
async function cloudPull({ first = false } = {}) {
  const cfg = readConfig();
  if (!cloudEnabled(cfg)) return null;
  try {
    if (first) await pullFiles(cfg, PC_OWNED, { onlyMissing: true }); // 새 PC 에서 처음 열 때 즐겨찾기 등 복원
    const r = await pullFiles(cfg, PULL_FROM_CLOUD);
    Object.assign(cloud, { lastPull: new Date().toISOString(), lastError: null, updatedAt: r.updatedAt });
    if (r.got.length) log('클라우드 결과 받음:', r.got.join(', '));
    return r;
  } catch (e) {
    cloud.lastError = e.message;
    log('클라우드 결과 받기 실패:', e.message);
    return null;
  }
}

async function startCloudRefresh(cfg) {
  Object.assign(refresh, { running: true, startedAt: new Date().toISOString(), ok: null, tail: '' });
  try {
    await pushFiles(cfg, PC_OWNED); // 최신 즐겨찾기·숨김을 먼저 올려 두고
    await dispatchWorkflow(cfg);
    log('클라우드 수집 실행 요청');
  } catch (e) {
    return Object.assign(refresh, { running: false, ok: false, finishedAt: new Date().toISOString(), tail: `클라우드 실행 요청 실패: ${e.message}` });
  }
  const before = fs.existsSync(eventsFile()) ? fs.statSync(eventsFile()).mtimeMs : 0;
  const deadline = Date.now() + 10 * 60 * 1000;
  const tick = async () => {
    await cloudPull();
    const now = fs.existsSync(eventsFile()) ? fs.statSync(eventsFile()).mtimeMs : 0;
    if (now > before) return Object.assign(refresh, { running: false, ok: true, finishedAt: new Date().toISOString(), tail: '' });
    if (Date.now() > deadline) return Object.assign(refresh, { running: false, ok: false, finishedAt: new Date().toISOString(), tail: '10분 안에 클라우드 결과가 오지 않았습니다. GitHub Actions 실행 기록을 확인해 주세요.' });
    setTimeout(tick, 15000);
  };
  setTimeout(tick, 30000);
}

function startRefresh() {
  if (refresh.running) return false;
  const cfg = readConfig();
  if (cloudEnabled(cfg)) {
    startCloudRefresh(cfg);
    return true;
  }
  Object.assign(refresh, { running: true, startedAt: new Date().toISOString(), ok: null, tail: '' });
  const child = spawn(process.execPath, [MAIN, '--refresh-events'], { cwd: ROOT, windowsHide: true });
  let out = '';
  const onData = (d) => { out = (out + d).slice(-4000); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('close', (code) => {
    Object.assign(refresh, { running: false, finishedAt: new Date().toISOString(), ok: code === 0, tail: out.split('\n').filter(Boolean).slice(-8).join('\n') });
    log('새로고침 종료 code', code);
  });
  child.on('error', (e) => Object.assign(refresh, { running: false, ok: false, tail: e.message }));
  return true;
}

// ---------- 즐겨찾기 / 직접 추가한 일정 (data/*.json) ----------
const favFile = () => path.join(ROOT, 'data', 'favorites.json');
const customFile = () => path.join(ROOT, 'data', 'custom-events.json');
const hiddenFile = () => path.join(ROOT, 'data', 'hidden.json');
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 1));
  fs.renameSync(file + '.tmp', file);
}
const EVENT_FIELDS = ['key', 'title', 'category', 'source', 'sourceLabel', 'info', 'start', 'end', 'time', 'place', 'price', 'priceText', 'url', 'image', 'kind', 'memo'];
const pick = (o) => Object.fromEntries(EVENT_FIELDS.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
const isoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1048576) reject(new Error('too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// 즐겨찾기·숨김 공통: { items: { key: 행사정보 } }
async function handleKeyStore(file, req, res) {
  const store = readJson(file, { items: {} });
  if (req.method === 'GET') return send(res, 200, store);
  const body = await readBody(req);
  // 한 개: { key, on, event } / 여러 개(전체 보기의 일괄 처리): { on, items: [{ key, event }] }
  const list = Array.isArray(body.items) ? body.items : [{ key: body.key, event: body.event }];
  if (!list.length || list.some((x) => !x?.key)) return send(res, 400, { error: 'key required' });
  const now = new Date().toISOString();
  for (const { key, event } of list) {
    if (body.on) store.items[key] = { ...pick(event || {}), key, addedAt: now };
    else delete store.items[key];
  }
  writeJson(file, store);
  return send(res, 200, store);
}

async function handleCustom(req, res, url) {
  const data = readJson(customFile(), { events: [] });
  if (req.method === 'GET') return send(res, 200, data);
  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    data.events = data.events.filter((e) => e.key !== id);
    writeJson(customFile(), data);
    return send(res, 200, data);
  }
  const e = pick(await readBody(req));
  e.title = String(e.title || '').trim().slice(0, 200);
  if (!e.title || !isoDate(e.start)) return send(res, 400, { error: '제목과 시작일은 필수입니다' });
  if (!isoDate(e.end) || e.end < e.start) e.end = e.start;
  if (e.url && !/^https?:\/\//i.test(e.url)) e.url = 'https://' + e.url;
  e.kind = e.kind === 'popup' ? 'popup' : 'mine';
  e.source = 'custom';
  e.category = e.kind === 'popup' ? '팝업스토어' : '내 일정';
  e.sourceLabel = '직접 추가';
  e.key ||= `my:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const i = data.events.findIndex((x) => x.key === e.key);
  if (i >= 0) data.events[i] = { ...data.events[i], ...e, updatedAt: new Date().toISOString() };
  else data.events.push({ ...e, createdAt: new Date().toISOString() });
  writeJson(customFile(), data);
  return send(res, 200, { ...data, saved: e.key });
}

// 즐겨찾기·숨김·직접 추가가 바뀌면 몇 초 뒤 Gist 도 갱신 (여러 번 눌러도 한 번만)
let publishTimer = null;
function schedulePublish() {
  clearTimeout(publishTimer);
  publishTimer = setTimeout(async () => {
    const cfg = readConfig();
    if (cloudEnabled(cfg)) {
      try {
        await pushFiles(cfg, PC_OWNED);
      } catch (e) {
        log('즐겨찾기 등 클라우드 올리기 실패:', e.message);
      }
    }
    await publishSafe(cfg);
  }, 4000);
}

// ---------- HTTP ----------
let lastPing = Date.now();
let everPinged = false;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

export function handler(req, res) {
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;
  // 쓰기 요청은 이 앱 화면에서 온 것만 허용 (다른 웹사이트가 보내는 요청 차단)
  if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== ORIGIN) return send(res, 403, { error: 'forbidden' });
  const fail = (e) => send(res, 400, { error: e.message });
  if (req.method !== 'GET' && ['/api/favorites', '/api/hidden', '/api/custom'].includes(p)) schedulePublish();
  if (p === '/api/favorites') return handleKeyStore(favFile(), req, res).catch(fail);
  if (p === '/api/hidden') return handleKeyStore(hiddenFile(), req, res).catch(fail);
  if (p === '/api/custom') return handleCustom(req, res, url).catch(fail);
  // 앞으로 N일 일정 + 즐겨찾기 (기본 7일). ?format=text 는 한국어 요약
  if (p === '/api/week' || p === '/api/favorites/list') {
    const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days')) || 7));
    const { digest, text } = buildPayload({ days });
    if (url.searchParams.get('format') === 'text') return send(res, 200, text, 'text/plain; charset=utf-8');
    if (p === '/api/favorites/list') return send(res, 200, { today: digest.today, count: digest.favorites.length, favorites: digest.favorites });
    return send(res, 200, digest);
  }
  if (p === '/api/popup-status') return send(res, 200, readJson(popupStatusFile(), { sites: [] }));

  if (p === '/api/ping') {
    lastPing = Date.now();
    everPinged = true;
    return send(res, 200, { ok: true, app: 'busan-culture-calendar', version: VERSION });
  }
  // 새 버전 서버가 예전 서버를 내릴 때만 사용 (브라우저 페이지는 이 헤더를 보낼 수 없음: Origin 없음 + 전용 헤더)
  if (p === '/api/shutdown') {
    if (req.method !== 'POST' || req.headers.origin || req.headers['x-bca-takeover'] !== '1') return send(res, 403, { error: 'forbidden' });
    send(res, 200, { ok: true });
    log('새 버전 서버로 교체 → 종료');
    setTimeout(() => process.exit(0), 150);
    return;
  }
  if (p === '/api/events') {
    const file = eventsFile();
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      return send(res, 200, { missing: true, events: [], holidays: loadHolidays().days, mtime: 0, refresh, cloud: cloudInfo() });
    }
    if (url.searchParams.get('since') && Number(url.searchParams.get('since')) >= mtime) {
      return send(res, 200, { unchanged: true, mtime, refresh });
    }
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return send(res, 200, { ...data, holidays: loadHolidays().days, mtime, refresh, cloud: cloudInfo() });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }
  if (p === '/api/refresh') {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    // 다른 웹사이트가 이 주소로 요청을 보내지 못하게 출처 확인
    const origin = req.headers.origin;
    if (origin && origin !== ORIGIN) return send(res, 403, { error: 'forbidden' });
    const started = startRefresh();
    return send(res, started ? 202 : 409, { started, refresh });
  }
  if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

  // 정적 파일
  const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, buf, TYPES[path.extname(file)] || 'application/octet-stream');
  });
}

async function runningInfo() {
  try {
    const r = await fetch(`${ORIGIN}/api/ping`, { signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    return j.app === 'busan-culture-calendar' ? { version: j.version || 'old' } : null;
  } catch {
    return null;
  }
}
async function takeOver() {
  try {
    await fetch(`${ORIGIN}/api/shutdown`, { method: 'POST', headers: { 'X-BCA-Takeover': '1' }, signal: AbortSignal.timeout(2000) });
  } catch {}
  const waitGone = async () => {
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (!(await runningInfo())) return true;
    }
    return false;
  };
  if (await waitGone()) return true;
  // 종료 요청을 모르는 예전 버전: 이 포트를 잡고 있는 프로세스가 '이 캘린더의 server.mjs' 일 때만 종료
  if (process.platform !== 'win32') return false;
  try {
    const ps = `$p=(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if($p){$c=(Get-CimInstance Win32_Process -Filter "ProcessId=$p").CommandLine; if($c -like '*calendar*server.mjs*'){Stop-Process -Id $p -Force; 'stopped'}}`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    log('예전 서버 프로세스 정리:', out.trim() || '해당 없음');
  } catch (e) {
    log('예전 서버 종료 실패:', e.message);
  }
  return waitGone();
}

export function start() {
  const server = http.createServer(handler);
  let retried = false;
  server.on('error', async (err) => {
    const other = err.code === 'EADDRINUSE' ? await runningInfo() : null;
    if (other && other.version === VERSION) {
      log('이미 실행 중 → 창만 엽니다');
      openWindow();
      setTimeout(() => process.exit(0), 1500);
      return;
    }
    if (other && !retried) {
      retried = true;
      log(`예전 버전 서버(${other.version}) 실행 중 → 교체`);
      if (await takeOver()) return server.listen(PORT, HOST);
      log('예전 서버가 종료되지 않음 — 캘린더 창을 모두 닫고 몇 분 뒤 다시 실행해 주세요');
      openWindow();
      setTimeout(() => process.exit(0), 1500);
      return;
    }
    log('서버 오류:', err.message);
    process.exit(1);
  });
  let opened = false;
  server.on('listening', () => {
    log(`실행: ${ORIGIN} (버전 ${VERSION})`);
    cloudPull({ first: true });
    setInterval(() => cloudPull(), 3 * 60 * 1000);
    // 교체한 경우 열려 있던 창은 스스로 새로고침하므로, 창이 이미 있으면 또 열지 않는다
    setTimeout(() => {
      if (!opened && !(retried && everPinged)) openWindow();
      opened = true;
    }, retried ? 2500 : 0);
  });
  server.listen(PORT, HOST);
  // 창이 닫혀 하트비트가 끊기면 종료 (처음 창이 뜨기 전에는 3배 여유)
  const timer = setInterval(() => {
    if (args.has('--no-open') || refresh.running) return;
    const limit = everPinged ? IDLE_MS : IDLE_MS * 3;
    if (Date.now() - lastPing > limit) {
      log('창이 닫혀 종료');
      clearInterval(timer);
      server.close();
      process.exit(0);
    }
  }, 15000);
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (args.has('--logon') && readConfig().openCalendarOnLogon === false) {
    log('openCalendarOnLogon=false → 로그온 시 창 열지 않음');
  } else {
    start();
  }
}
