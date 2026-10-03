// PC ↔ 클라우드(GitHub Actions) 상태 공유: 비공개 '상태 Gist' 하나에 파일들을 둔다.
// 파일마다 주인이 정해져 있어 서로 덮어쓰지 않는다.
//   클라우드가 쓰는 파일: 수집 결과·보낸 기록·팝업 캐시·공개 Gist 정보
//   PC(캘린더)가 쓰는 파일: 즐겨찾기·숨김·직접 추가
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, log } from './util.mjs';
import { gh } from './github.mjs';

export const CLOUD_OWNED = ['events.json', 'holidays.json', 'popup-status.json', 'popup-cache.json', 'gist.json', 'state.json'];
export const PC_OWNED = ['favorites.json', 'hidden.json', 'custom-events.json'];

export const localPath = (name) => (name === 'state.json' ? path.join(ROOT, 'state.json') : path.join(ROOT, 'data', name));
const stateGistId = (cfg) => cfg.cloud?.stateGistId;
export const cloudEnabled = (cfg) => cfg.mode === 'cloud' && !!stateGistId(cfg) && !!cfg.githubToken;

// 상태 Gist → 로컬. onlyMissing 이면 로컬에 없는 파일만 받는다. 받은 파일 이름 목록과 Gist 수정 시각을 돌려준다.
export async function pullFiles(cfg, names, { onlyMissing = false } = {}) {
  const g = await gh(cfg.githubToken, 'GET', `/gists/${stateGistId(cfg)}`);
  const got = [];
  for (const name of names) {
    const f = g.files?.[name];
    if (!f) continue;
    const file = localPath(name);
    if (onlyMissing && fs.existsSync(file)) continue;
    // 1MB 넘는 파일은 API 응답에서 잘리므로 원본 주소로 다시 받는다
    let content = f.content;
    if (f.truncated || content == null) content = await (await fetch(f.raw_url, { signal: AbortSignal.timeout(30000) })).text();
    try {
      JSON.parse(content);
    } catch {
      log(`상태 Gist 의 ${name} 이 JSON 이 아니라서 건너뜀`);
      continue;
    }
    let same = false;
    try {
      same = fs.readFileSync(file, 'utf8') === content;
    } catch {}
    if (same) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', content);
    fs.renameSync(file + '.tmp', file);
    got.push(name);
  }
  return { updatedAt: g.updated_at, got };
}

// 로컬 → 상태 Gist (지정한 파일만 수정, 나머지 파일은 그대로)
export async function pushFiles(cfg, names) {
  const files = {};
  for (const name of names) {
    try {
      const content = fs.readFileSync(localPath(name), 'utf8');
      if (content.trim()) files[name] = { content };
    } catch {}
  }
  if (!Object.keys(files).length) return { pushed: [] };
  await gh(cfg.githubToken, 'PATCH', `/gists/${stateGistId(cfg)}`, { files });
  return { pushed: Object.keys(files) };
}

export async function createStateGist(token) {
  const g = await gh(token, 'POST', '/gists', {
    description: '부산 문화 알림 — PC·클라우드 공유 상태 (자동 관리, 수정하지 마세요)',
    public: false,
    files: { 'README.md': { content: '부산 문화 알림 프로그램이 자동으로 관리하는 상태 저장소입니다. 직접 수정하지 마세요.\n' } },
  });
  return g.id;
}

// 새로고침 버튼 → 클라우드 수집을 바로 실행 요청
export async function dispatchWorkflow(cfg) {
  const { repo, workflow = 'collect.yml', ref = 'main' } = cfg.cloud || {};
  if (!repo) throw new Error('config.json 의 cloud.repo 가 없습니다');
  await gh(cfg.githubToken, 'POST', `/repos/${repo}/actions/workflows/${workflow}/dispatches`, { ref });
}

// 밤 조용한 시간 (KST 기준, 기본 23시~8시)
export function inQuietHours(cfg, now = new Date()) {
  const q = cfg.quietHours === false ? null : cfg.quietHours || { start: 23, end: 8 };
  if (!q) return false;
  const h = (now.getUTCHours() + 9) % 24;
  return q.start > q.end ? h >= q.start || h < q.end : h >= q.start && h < q.end;
}
