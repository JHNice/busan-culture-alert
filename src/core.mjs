// 필터링 / 중복 제거 / 새 항목·마감 임박 분류 (네트워크 없음 → 테스트 가능)
import { addDays, diffDays, normalizeKey } from './util.mjs';

export function isActive(item, today, lookaheadDays) {
  if (!item.title) return false;
  if (item.end && item.end < today) return false;
  if (item.start && item.start > addDays(today, lookaheadDays)) return false;
  if (!item.start && !item.end && !item.openRun) return false;
  return true;
}

export function passesPrice(item, cfg) {
  if (item.price == null) {
    return item.paidUnknown ? cfg.includePaidUnknownPrice : cfg.includeUnknownPrice;
  }
  return item.price <= cfg.maxPrice;
}

// 여러 소스에 같은 행사가 있으면 하나로 합침 (가격·링크 정보가 있는 쪽 우선)
export function dedupe(items) {
  const map = new Map();
  for (const it of items) {
    it.key = normalizeKey(it.title, it.start);
    const prev = map.get(it.key);
    if (!prev) {
      map.set(it.key, it);
      continue;
    }
    if (prev.price == null && it.price != null) {
      prev.price = it.price;
      prev.priceText = it.priceText;
      prev.paidUnknown = it.paidUnknown;
    }
    prev.url ||= it.url;
    prev.image ||= it.image;
    prev.place ||= it.place;
    prev.end ||= it.end;
  }
  return [...map.values()];
}

export function daysLeft(item, today) {
  return item.end ? diffDays(item.end, today) : null;
}

export function classify(items, state, cfg, today) {
  const fresh = [];
  const ending = [];
  for (const it of items) {
    const left = daysLeft(it, today);
    // 하루짜리 행사는 '마감 임박' 의미가 없으니 기간이 있는 것만 표시
    const multiDay = !it.start || it.start !== it.end;
    it.endingSoon = multiDay && left != null && left >= 0 && left <= cfg.endingSoonDays;
    if (it.remindStart && it.start) {
      const until = diffDays(it.start, today);
      it.endingSoon = until >= 0 && until <= 1; // 개봉 전날·당일
    }
    const seen = state.seen[it.key];
    if (!seen) fresh.push(it);
    else if (it.endingSoon && !seen.endingNotified) ending.push(it);
  }
  const byEnd = (a, b) => (a.end || '9999').localeCompare(b.end || '9999');
  fresh.sort(byEnd);
  ending.sort(byEnd);
  return { fresh, ending };
}

// 보낸 항목만 state 에 기록. 오래 지난 항목은 정리
export function markSent(state, sentItems, today) {
  for (const it of sentItems) {
    const prev = state.seen[it.key] || { first: today };
    state.seen[it.key] = {
      first: prev.first,
      end: it.end || prev.end || null,
      title: it.title,
      endingNotified: prev.endingNotified || it.endingSoon,
    };
  }
  const cutoff = addDays(today, -30);
  for (const [k, v] of Object.entries(state.seen)) {
    if (v.end && v.end < cutoff) delete state.seen[k];
  }
}
