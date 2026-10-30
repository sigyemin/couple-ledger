// =====================================================================
// 카테고리 고르기 부품 — 화면 없이 계산하는 부분 (CL-060, 사용자 요청 10-30)
// - 대분류 → 소분류 2단. 켜진 것만, 지출·환불은 수입 그룹 제외, 수입은 수입 그룹만(categoryOptions와 같은 규칙)
// - 검색: 소분류·대분류 이름 부분 일치(NFKC·공백 무시·대소문자 무시), 결과 이름은 '대분류 > 소분류'
// - 최근 쓴 카테고리: 이 기기 저장소(목록만, 금액·거래 없음). 지금 고를 수 있는 것만 보여 준다
// 의존: screens/detail-model.js(categoryOptions)
// =====================================================================
import { categoryOptions } from './detail-model.js';

export const RECENT_SHOW = 5;
export const RECENT_KEEP = 12;

/** 고를 수 있는 그룹·항목 + 이름표 */
export function pickGroups(categories, kind) {
  return categoryOptions(categories ?? [], kind).map((g) => ({
    id: g.id,
    name: g.group,
    items: g.items.map((it) => ({ id: it.id, name: it.name, label: `${g.group} > ${it.name}` })),
  }));
}

/** 검색용 정리: NFKC + 소문자 + 공백 제거 */
export function pickNorm(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/**
 * 검색 결과(소분류 단위). 대분류 이름이 맞으면 그 아래 소분류 전부
 * @returns {{ id, name, label }[]}
 */
export function searchCategories(groups, q) {
  const n = pickNorm(q);
  if (!n) return [];
  const out = [];
  for (const g of groups) {
    const groupHit = pickNorm(g.name).includes(n);
    for (const it of g.items) if (groupHit || pickNorm(it.name).includes(n)) out.push(it);
  }
  return out;
}

/** id → '대분류 > 소분류' (고를 수 없는 id면 null) */
export function labelOf(groups, id) {
  for (const g of groups) for (const it of g.items) if (it.id === id) return it.label;
  return null;
}

/** 저장된 최근 id 목록 → 지금 고를 수 있는 항목(최근 순, 최대 RECENT_SHOW개) */
export function recentItems(ids, groups, max = RECENT_SHOW) {
  const byId = new Map(groups.flatMap((g) => g.items.map((it) => [it.id, it])));
  return (Array.isArray(ids) ? ids : []).map((id) => byId.get(id)).filter(Boolean).slice(0, max);
}

/** 고른 id를 맨 앞으로(중복 없이, 최대 RECENT_KEEP개) */
export function pushRecent(ids, id, keep = RECENT_KEEP) {
  const list = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && x !== id);
  return [id, ...list].slice(0, keep);
}
