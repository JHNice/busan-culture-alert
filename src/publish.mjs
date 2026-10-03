// 7일 일정·즐겨찾기를 비공개 GitHub Gist 로 올려서 밖(아이패드 단축어 등)에서 읽을 수 있게 한다.
// - config.json 의 githubToken(권한: gist) 이 있을 때만 동작. 토큰은 로그·응답에 절대 출력하지 않는다.
// - 처음 한 번 비공개(secret) Gist 를 만들고 id 를 data/gist.json 에 저장, 이후엔 같은 Gist 를 수정 → 주소 고정.
// - 내용이 바뀌지 않았으면 올리지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, todayKST, log } from './util.mjs';
import { loadAll, buildDigest, digestText } from './digest.mjs';

const API = 'https://api.github.com';
const gistFile = () => path.join(ROOT, 'data', 'gist.json');
export const FILES = { json: 'busan-week.json', text: 'busan-week.txt' };

function readGistState() {
  try {
    return JSON.parse(fs.readFileSync(gistFile(), 'utf8'));
  } catch {
    return {};
  }
}
function writeGistState(s) {
  fs.mkdirSync(path.dirname(gistFile()), { recursive: true });
  fs.writeFileSync(gistFile(), JSON.stringify(s, null, 2));
}

export function rawUrls(state) {
  if (!state.id || !state.owner) return null;
  const base = `https://gist.githubusercontent.com/${state.owner}/${state.id}/raw`;
  return { json: `${base}/${FILES.json}`, text: `${base}/${FILES.text}`, page: `https://gist.github.com/${state.owner}/${state.id}` };
}

async function gh(token, method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'BusanCultureAlert',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const hint = res.status === 401 ? ' (토큰이 틀렸거나 만료됨)' : res.status === 403 || res.status === 404 ? ' (토큰에 gist 권한이 없거나 Gist 가 삭제됨)' : '';
    const err = new Error(`GitHub ${res.status}${hint}: ${json?.message || text.slice(0, 120)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

export function buildPayload({ today = todayKST(), days = 7 } = {}) {
  const dg = buildDigest(loadAll(), { today, days });
  return { digest: dg, json: JSON.stringify(dg, null, 2), text: digestText(dg) };
}

export async function publishGist(cfg, { force = false } = {}) {
  const token = String(cfg.githubToken || '').trim();
  if (!token || cfg.publishGist === false) return { skipped: 'githubToken 없음' };
  const { json, text } = buildPayload({ days: cfg.publishDays || 7 });
  // generatedAt 은 매번 바뀌므로 비교에서 제외
  const hash = crypto.createHash('sha256').update(json.replace(/"generatedAt": "[^"]*",?/, '')).digest('hex');
  const state = readGistState();
  if (!force && state.id && state.hash === hash) return { unchanged: true, urls: rawUrls(state) };

  const files = { [FILES.json]: { content: json }, [FILES.text]: { content: text } };
  let g;
  if (state.id) {
    try {
      g = await gh(token, 'PATCH', `/gists/${state.id}`, { files });
    } catch (e) {
      if (e.status !== 404) throw e;
      state.id = null; // 지워진 Gist → 새로 만든다
    }
  }
  if (!g) {
    g = await gh(token, 'POST', '/gists', { description: '부산 문화 알림 — 앞으로 7일 일정·즐겨찾기 (자동 갱신)', public: false, files });
    log('비공개 Gist 를 새로 만들었습니다');
  }
  const next = { id: g.id, owner: g.owner?.login || state.owner, hash, updatedAt: new Date().toISOString() };
  writeGistState(next);
  return { updated: true, urls: rawUrls(next) };
}

// 실패해도 본 작업(알림·캘린더)은 계속되도록 감싼 버전
export async function publishSafe(cfg, opts) {
  try {
    const r = await publishGist(cfg, opts);
    if (r.updated) log('Gist 갱신 완료');
    return r;
  } catch (e) {
    log('Gist 갱신 실패 —', e.message);
    return { error: e.message };
  }
}
