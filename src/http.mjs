// HTTP 호출 + 공공데이터포털 응답 해석
import { sleep, parseXmlItems, xmlTag, deepFind, findJsonItems, log } from './util.mjs';

// --check --dump 용: 원본 응답을 기록 (키는 가림)
export const dump = { enabled: false, records: [] };
export function maskUrl(u) {
  return u.replace(/([?&](?:serviceKey|ServiceKey|service|key)=)[^&]*/g, '$1***');
}

const OK_CODES = new Set(['0', '00', '0000', 'INFO-000']);

// 네트워크 오류(부팅 직후 인터넷 미연결 등)만 재시도
export async function getText(url, params = {}, { retries = 3, retryDelayMs = 20000, timeoutMs = 20000 } = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const full = qs.toString() ? `${url}?${qs}` : url;

  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(full, { signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      if (dump.enabled) dump.records.push({ url: maskUrl(full), status: res.status, text: text.slice(0, 20000) });
      return { status: res.status, text, url: full };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        log(`네트워크 오류, ${retryDelayMs / 1000}초 후 재시도 (${attempt}/${retries}):`, err.message);
        await sleep(retryDelayMs);
      }
    }
  }
  throw new Error(`네트워크 오류: ${lastErr?.message}`);
}

export class ApiError extends Error {}

// 응답을 { items, totalCount } 로 변환. 인증/파라미터 오류는 ApiError 로 던짐
export function parseApiResponse(res, { xmlItemTag = 'item' } = {}) {
  const body = (res.text || '').trim();
  const head = body.slice(0, 200).replace(/\s+/g, ' ');

  if (res.status !== 200) {
    throw new ApiError(`HTTP ${res.status} ${hintForStatus(res.status, body)} ${head}`.trim());
  }

  if (body.startsWith('{') || body.startsWith('[')) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new ApiError(`JSON 파싱 실패: ${head}`);
    }
    const code = deepFind(data, 'resultCode');
    if (code != null && !OK_CODES.has(String(code))) {
      throw new ApiError(`API 오류 ${code}: ${deepFind(data, 'resultMsg') ?? ''}`);
    }
    const total = Number(deepFind(data, 'totalCount'));
    return { items: findJsonItems(data), totalCount: Number.isFinite(total) ? total : null };
  }

  if (body.startsWith('<')) {
    const authMsg = xmlTag(body, 'returnAuthMsg');
    if (authMsg && authMsg !== 'NORMAL SERVICE.' && authMsg !== 'NORMAL_SERVICE') {
      throw new ApiError(`인증/호출 오류: ${authMsg} (${xmlTag(body, 'returnReasonCode') ?? ''})`);
    }
    const code = xmlTag(body, 'resultCode');
    if (code != null && !OK_CODES.has(code)) {
      throw new ApiError(`API 오류 ${code}: ${xmlTag(body, 'resultMsg') ?? ''}`);
    }
    const total = Number(xmlTag(body, 'totalCount'));
    return { items: parseXmlItems(body, xmlItemTag), totalCount: Number.isFinite(total) ? total : null };
  }

  throw new ApiError(`알 수 없는 응답 형식: ${head}`);
}

function hintForStatus(status, body) {
  if (status === 401 || /Unauthorized/i.test(body)) return '(인증키 미등록/미승인 — 활용신청 후 반영까지 1시간 정도 걸릴 수 있음)';
  if (status === 403) return '(접근 거부 — 해당 API 활용신청 여부 확인)';
  if (status === 429) return '(호출 한도 초과)';
  return '';
}
