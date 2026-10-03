// 디스코드 웹훅 메시지 생성/전송
import { truncate, isHttpUrl, sleep } from './util.mjs';
import { daysLeft } from './core.mjs';

const COLORS = { ending: 0xe74c3c, free: 0x2ecc71, cheap: 0x3498db, unknown: 0x95a5a6 };

export function priceLabel(it) {
  if (it.price === 0) return '무료' + (it.priceText && it.priceText !== '무료' ? ` · ${truncate(it.priceText, 80)}` : '');
  if (it.price != null) return `${it.price.toLocaleString('ko-KR')}원` + (it.priceText ? ` · ${truncate(it.priceText, 80)}` : '');
  if (it.priceText) return `${truncate(it.priceText, 100)} (금액 확인 필요)`;
  return '요금 정보 없음 (확인 필요)';
}

function searchUrl(it) {
  return `https://search.naver.com/search.naver?query=${encodeURIComponent(`${it.title} ${it.place || '부산'}`)}`;
}

export function buildEmbed(it, today, sourceLabel) {
  const left = daysLeft(it, today);
  const kind = it.endingSoon ? 'ending' : it.price === 0 ? 'free' : it.price != null ? 'cheap' : 'unknown';
  let period = it.start === it.end ? `${it.start}` : `${it.start ?? '?'} ~ ${it.end ?? (it.openRun ? '오픈런' : '?')}`;
  if (it.time) period += ` ${it.time}`;
  if (left != null) period += left === 0 ? ' (**오늘 마감**)' : ` (D-${left})`;

  const lines = [];
  if (it.place) lines.push(`📍 ${truncate(it.place, 150)}`);
  lines.push(`🗓 ${period}`);
  if (it.info) lines.push(`${it.source === 'movies' ? '🎬' : 'ℹ️'} ${truncate(it.info, 200)}`);
  const noPrice = (it.source === 'movies' || it.source === 'popups') && it.price == null;
  if (!noPrice) lines.push(`💰 ${priceLabel(it)}`);

  const embed = {
    title: truncate(`${it.endingSoon ? '⏰ ' : ''}${it.title}`, 256),
    url: isHttpUrl(it.url) ? it.url.trim() : searchUrl(it),
    description: truncate(lines.join('\n'), 1000),
    color: COLORS[kind],
    footer: { text: truncate(`${it.category || ''} · ${sourceLabel}`, 200) },
  };
  if (isHttpUrl(it.image)) embed.thumbnail = { url: it.image.trim() };
  return embed;
}

function embedSize(e) {
  return (e.title?.length || 0) + (e.description?.length || 0) + (e.footer?.text?.length || 0);
}

// 디스코드 제한: 메시지당 embed 10개, embed 글자 합계 6000자
export function chunkEmbeds(embeds) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const e of embeds) {
    const s = embedSize(e);
    if (cur.length === 10 || size + s > 5500) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(e);
    size += s;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export function buildMessages({ today, fresh, ending, overflow, errors, labelOf }) {
  const header = [`**📅 ${today} 부산 문화 알림**`, `새로 올라온 것 ${fresh.length}개 · 마감 임박 ${ending.length}개`];
  if (overflow > 0) header.push(`(한 번에 보내는 개수 제한으로 ${overflow}개는 다음 실행 때 이어서 보냅니다)`);
  for (const e of errors) header.push(`⚠️ ${e.label}: ${truncate(e.message, 180)}`);

  const embeds = [...ending, ...fresh].map((it) => buildEmbed(it, today, labelOf(it.source)));
  const chunks = chunkEmbeds(embeds);
  const messages = [{ content: truncate(header.join('\n'), 1900), embeds: chunks.shift() || [] }];
  for (const c of chunks) messages.push({ embeds: c });
  return messages;
}

export async function postWebhook(webhookUrl, payload) {
  const url = webhookUrl + (webhookUrl.includes('?') ? '&' : '?') + 'wait=true';
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '부산 문화 알림', allowed_mentions: { parse: [] }, ...payload }),
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) return;
    const text = await res.text();
    if (res.status === 429) {
      let wait = 2;
      try {
        wait = JSON.parse(text).retry_after ?? 2;
      } catch {}
      await sleep(Math.ceil(wait * 1000) + 250);
      continue;
    }
    throw new Error(`디스코드 전송 실패 HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  throw new Error('디스코드 전송 실패: 429 재시도 초과');
}

export async function sendAll(webhookUrl, messages) {
  for (const m of messages) {
    await postWebhook(webhookUrl, m);
    await sleep(1100);
  }
}

export function isWebhookUrl(s) {
  return /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/.test(String(s || ''));
}
