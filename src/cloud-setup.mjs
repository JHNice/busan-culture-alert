// 클라우드(GitHub Actions) 설정을 PC에서 한 번에: node src/cloud-setup.mjs
//  1) 토큰·저장소 확인  2) 비공개 상태 Gist 만들고 지금 PC 데이터 올리기
//  3) 저장소에 코드·워크플로 올리기  4) Secrets 에 BCA_CONFIG 암호화 등록
//  5) 첫 클라우드 실행 → 결과 출력  6) 성공하면 이 PC를 클라우드 모드로 전환
// 키·토큰·웹훅은 화면에 출력하지 않는다. 여러 번 실행해도 안전(이미 된 단계는 이어서 갱신).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './util.mjs';
import { gh } from './github.mjs';
import { createStateGist, pushFiles, CLOUD_OWNED, PC_OWNED } from './cloudsync.mjs';
import { sealBase64 } from './sealedbox.mjs';

const say = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONFIG = path.join(ROOT, 'config.json');

// 저장소에 올릴 파일 (개인 데이터·키가 든 config.json, state.json, data/, logs/ 는 절대 포함하지 않음)
export function repoFiles() {
  const list = [];
  const add = (rel, repoPath = rel) => {
    if (fs.existsSync(path.join(ROOT, rel))) list.push({ local: rel, remote: repoPath.replaceAll('\\', '/') });
  };
  const walk = (dir, filter) => {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return;
    for (const f of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = path.join(dir, f.name);
      if (f.isDirectory()) walk(rel, filter);
      else if (filter(f.name)) add(rel);
    }
  };
  // CLAUDE.md 는 PC 경로·개인 메모가 있어 공개 저장소에 올리지 않음
  for (const f of ['.gitignore', 'README.md', 'config.example.json', 'run.vbs', 'calendar.vbs', 'calendar.cmd', 'install-task.ps1', 'uninstall-task.ps1', 'check.cmd', 'dry-run.cmd', 'run-now.cmd', 'test-webhook.cmd']) add(f);
  walk('src', (n) => /\.(mjs|cjs|txt)$/.test(n));
  walk('calendar', (n) => /\.(mjs|js|html|css|svg|ico)$/.test(n));
  add(path.join('test', 'all.test.mjs'));
  add(path.join('deploy', 'github', 'workflows', 'collect.yml'), '.github/workflows/collect.yml');
  add(path.join('deploy', 'github', 'workflows', 'keepalive.yml'), '.github/workflows/keepalive.yml');
  add(path.join('deploy', 'github', 'heartbeat'), '.github/heartbeat');
  // 안전장치: 비밀값이 들어간 파일이 섞이지 않았는지 확인
  for (const f of list) if (/^(config\.json|state\.json)$|^(data|logs)[\\/]/.test(f.local)) throw new Error(`올리면 안 되는 파일: ${f.local}`);
  return list;
}

function containsSecret(text, secrets) {
  return secrets.some((s) => s && s.length > 6 && text.includes(s));
}

async function uploadFile(token, repo, { local, remote }, secrets) {
  const buf = fs.readFileSync(path.join(ROOT, local));
  if (containsSecret(buf.toString('utf8'), secrets)) throw new Error(`${local} 안에 키/토큰으로 보이는 값이 있어 올리지 않음`);
  const url = `/repos/${repo}/contents/${remote.split('/').map(encodeURIComponent).join('/')}`;
  let sha;
  try {
    const cur = await gh(token, 'GET', url);
    sha = cur.sha;
    if (cur.content && Buffer.from(cur.content, 'base64').equals(buf)) return 'same';
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  await gh(token, 'PUT', url, { message: `update ${remote}`, content: buf.toString('base64'), ...(sha ? { sha } : {}) });
  return sha ? 'updated' : 'created';
}

export async function main() {
  const raw = fs.readFileSync(CONFIG, 'utf8').replace(/^﻿/, '');
  const cfg = JSON.parse(raw);
  const token = String(cfg.githubToken || '').trim();
  if (!token) throw new Error('config.json 에 githubToken 이 없습니다');
  const secrets = [cfg.dataGoKrKey, cfg.kobisKey, cfg.kopisKey, cfg.discordWebhookUrl, token].filter(Boolean).map(String);

  // 1) 토큰·저장소
  const me = await gh(token, 'GET', '/user');
  const repo = cfg.cloud?.repo || `${me.login}/busan-culture-alert`;
  say(`[1/6] GitHub 계정 ${me.login} · 저장소 ${repo}`);
  const r = await gh(token, 'GET', `/repos/${repo}`).catch((e) => {
    throw new Error(`저장소에 접근할 수 없습니다 (${e.message}). 토큰의 Repository access 에 ${repo} 가 있는지 확인하세요.`);
  });
  if (r.private) say('      (비공개 저장소입니다 — Actions 무료 시간이 월 2,000분으로 제한됩니다)');

  // 2) 상태 Gist
  cfg.cloud = { ...(cfg.cloud || {}), repo };
  if (!cfg.cloud.stateGistId) {
    cfg.cloud.stateGistId = await createStateGist(token);
    say('[2/6] 비공개 상태 Gist 를 만들었습니다');
  } else say('[2/6] 기존 상태 Gist 사용');
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2)); // 여기까지 저장 (모드는 아직 local)
  const pushed = await pushFiles(cfg, [...CLOUD_OWNED, ...PC_OWNED]);
  say(`      지금 PC 데이터 올림: ${pushed.pushed.join(', ') || '(없음)'}`);

  // 3) 코드·워크플로 올리기
  const files = repoFiles();
  const counts = { created: 0, updated: 0, same: 0 };
  for (const f of files) counts[await uploadFile(token, repo, f, secrets)]++;
  say(`[3/6] 저장소에 코드 올림: 새로 ${counts.created} · 수정 ${counts.updated} · 그대로 ${counts.same} (총 ${files.length}개)`);

  // 4) Secrets
  const cloudCfg = { ...cfg, mode: 'cloud' };
  const key = await gh(token, 'GET', `/repos/${repo}/actions/secrets/public-key`);
  await gh(token, 'PUT', `/repos/${repo}/actions/secrets/BCA_CONFIG`, { encrypted_value: sealBase64(JSON.stringify(cloudCfg), key.key), key_id: key.key_id });
  say('[4/6] Secrets 에 BCA_CONFIG 등록 (암호화됨)');

  // 5) 첫 실행
  const info = await gh(token, 'GET', `/repos/${repo}`);
  const ref = info.default_branch || 'main';
  const t0 = Date.now();
  let dispatched = false;
  for (let i = 0; i < 8 && !dispatched; i++) {
    try {
      await gh(token, 'POST', `/repos/${repo}/actions/workflows/collect.yml/dispatches`, { ref });
      dispatched = true;
    } catch (e) {
      if (e.status !== 404 && e.status !== 422) throw e;
      await sleep(5000); // 방금 올린 워크플로가 등록되기를 기다림
    }
  }
  if (!dispatched) throw new Error('워크플로를 실행하지 못했습니다. 저장소 Actions 탭에서 Actions 가 켜져 있는지 확인하세요.');
  say('[5/6] 첫 클라우드 실행 시작 — 끝날 때까지 기다립니다 (보통 1~4분)');
  let run = null;
  for (let i = 0; i < 90; i++) {
    await sleep(10000);
    const runs = await gh(token, 'GET', `/repos/${repo}/actions/workflows/collect.yml/runs?per_page=5`);
    run = runs.workflow_runs?.find((x) => Date.parse(x.created_at) >= t0 - 60000) || null;
    if (run?.status === 'completed') break;
    if (i % 3 === 2) say(`      … ${run ? run.status : '대기'}`);
  }
  if (!run || run.status !== 'completed') throw new Error('15분 안에 끝나지 않았습니다. 저장소 Actions 탭에서 확인해 주세요.');
  const jobs = await gh(token, 'GET', `/repos/${repo}/actions/runs/${run.id}/jobs`);
  const job = jobs.jobs?.[0];
  if (job) {
    try {
      const log = await gh(token, 'GET', `/repos/${repo}/actions/jobs/${job.id}/logs`);
      const lines = String(log).split('\n').map((l) => l.replace(/^\S+Z\s/, '')).filter((l) => /^\[\d{4}-|오류|실패|Error|error|::error/.test(l));
      say('      --- 실행 기록 (중요 줄) ---');
      for (const l of lines.slice(-40)) say('      ' + (containsSecret(l, secrets) ? '(가림)' : l));
    } catch {}
  }
  say(`      결과: ${run.conclusion} — ${run.html_url}`);
  if (run.conclusion !== 'success') {
    say('[6/6] 클라우드 실행이 실패해서 이 PC는 그대로(로그인 때 직접 수집) 둡니다. 위 기록을 알려 주세요.');
    process.exitCode = 1;
    return;
  }

  // 6) PC 를 클라우드 모드로
  cfg.mode = 'cloud';
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
  say('[6/6] 완료! 이제 30분마다 클라우드가 수집·알림합니다. 이 PC는 로그인 때 캘린더만 엽니다.');
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('설정 중단:', e.message);
    process.exitCode = 1;
  });
}
