// =====================================================================
// 가맹점 규칙 — 화면 없이 계산하는 부분 (화면 설계 v0.2 3-5 시안 14, 3-6 시안 15, 3-7 시안 16)
// - 목록 순서 = 실제 적용 순서: 켜진 것 먼저, priority → created_at → id (reapply_category_rule의 앞선 규칙 판정과 같음)
// - 편집: 포함(contains)·일치(exact)만. 정규식(regex) 규칙은 보여 주되 패턴·방식은 못 바꾼다(결정 C2)
//   패턴은 DB match_norm과 같은 정리(NFKC·공백 제거)로 1글자 이상, 2글자 미만이면 경고만. 민감번호 검사(DB도 LG002)
// - 저장 뒤: 새 규칙이거나 패턴·방식·카테고리를 바꿨으면(켜진 규칙만) 과거 적용 화면으로, 아니면 목록으로
// - 과거 적용: 기간 칩(전체 / 올해 / 최근 3개월) → 미리보기(p_apply false) → 적용(true) → 변경 묶음으로 되돌리기
// 의존: core/validate.js, core/format.js, router.js
// =====================================================================
import { text as checkText } from '../core/validate.js';
import { won, day } from '../core/format.js';
import { addMonths } from '../router.js';

export const PRIORITY_DEFAULT = 100;
export const PRIORITY_MAX = 9999; // 앱 제안 값(DB는 int)
export const PREVIEW_FIRST = 4;
export const PREVIEW_STEP = 20;

const MATCH_LABEL = { contains: '포함', exact: '일치', regex: '정규식' };
const INCOME_CODE = 'income';

/** DB match_norm과 같은 정리: NFKC + 공백류 제거 */
export function matchNorm(s) {
  return String(s ?? '').normalize('NFKC').replace(/[ \t\n\r\f\v]/g, '');
}

/** 카테고리 행 → Map(id → { name, label: '그룹 · 항목', isActive, isIncome }) */
export function categoryLabels(categories) {
  const byId = new Map((categories ?? []).map((c) => [c.id, c]));
  const out = new Map();
  for (const c of categories ?? []) {
    const g = c.parent_id ? byId.get(c.parent_id) : null;
    out.set(c.id, {
      name: c.name,
      label: g ? `${g.name} · ${c.name}` : c.name,
      isActive: c.is_active !== false && (g ? g.is_active !== false : true),
      isIncome: (g ?? c).code === INCOME_CODE,
    });
  }
  return out;
}

const ruleOrder = (a, b) => (b.is_active === true) - (a.is_active === true)
  || a.priority - b.priority
  || String(a.created_at).localeCompare(String(b.created_at))
  || String(a.id).localeCompare(String(b.id));

/** 목록 한 줄 */
export function ruleRow(r, cats) {
  const c = r.category_id ? cats.get(r.category_id) : null;
  const tags = [];
  if (r.is_ambiguous) tags.push('검토 대기로');
  if (!r.is_active) tags.push('꺼짐');
  else if (c && !c.isActive) tags.push('카테고리 꺼짐');
  return {
    id: r.id,
    title: `“${r.pattern}” ${MATCH_LABEL[r.match_type] ?? r.match_type}`,
    target: `→ ${c ? c.label : '카테고리 없음'}${r.is_ambiguous ? ' (제안만)' : ''}`,
    priority: `우선 ${r.priority}`,
    tags,
    off: !r.is_active,
  };
}

/** 정렬 + 찾기(패턴·카테고리 이름, 띄어쓰기 무시) */
export function ruleList(rules, cats, q = '') {
  const needle = matchNorm(q).toLowerCase();
  return [...(rules ?? [])].sort(ruleOrder)
    .filter((r) => !needle
      || matchNorm(r.pattern).toLowerCase().includes(needle)
      || matchNorm(cats.get(r.category_id)?.label ?? '').toLowerCase().includes(needle))
    .map((r) => ruleRow(r, cats));
}

/**
 * 고를 수 있는 카테고리: 켜진 지출 카테고리(그룹 › 항목). 지금 규칙의 카테고리가 목록에 없으면(꺼짐·수입) 맨 앞에 남긴다
 * @returns {{ group, items: {id, name}[] }[]}
 */
export function ruleCategoryOptions(categories, currentId = null) {
  const groups = (categories ?? []).filter((c) => !c.parent_id && c.is_active && c.code !== INCOME_CODE)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  const out = groups.map((g) => ({
    group: g.name,
    items: categories.filter((c) => c.parent_id === g.id && c.is_active)
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
      .map((c) => ({ id: c.id, name: c.name })),
  })).filter((g) => g.items.length > 0);
  if (currentId && !out.some((g) => g.items.some((i) => i.id === currentId))) {
    const labels = categoryLabels(categories);
    const l = labels.get(currentId);
    if (l) out.unshift({ group: '지금 값', items: [{ id: currentId, name: `${l.label}${l.isActive ? '' : ' (꺼짐)'}` }] });
  }
  return out;
}

/**
 * 입력 검사 → { ok, value: { pattern, match_type, category_id, is_ambiguous, priority }, warning } | { ok:false, field, message }
 * regex 규칙(original.match_type = 'regex')은 패턴·방식을 원래 값 그대로 쓴다
 */
export function checkRule(input, original = null) {
  const isRegex = original?.match_type === 'regex';
  let pattern = original?.pattern ?? '';
  let matchType = original?.match_type ?? 'contains';
  let warning = null;
  if (!isRegex) {
    const v = checkText(input.pattern, 'rule_pattern', { required: true });
    if (!v.ok) return { ok: false, field: 'pattern', message: v.message };
    const n = matchNorm(v.value);
    if (!n) return { ok: false, field: 'pattern', message: '글자를 넣어 주세요' };
    pattern = v.value;
    if (!['contains', 'exact'].includes(input.matchType)) return { ok: false, field: 'match', message: '일치 방식을 골라 주세요' };
    matchType = input.matchType;
    if (matchType === 'contains' && [...n].length < 2) warning = '한 글자 규칙은 많은 가맹점에 맞을 수 있어요';
  }
  if (!input.categoryId) return { ok: false, field: 'category', message: '카테고리를 골라 주세요' };
  const p = String(input.priority ?? '').trim();
  if (!/^[0-9]{1,4}$/.test(p) || Number(p) > PRIORITY_MAX) return { ok: false, field: 'priority', message: `우선 순서는 0~${PRIORITY_MAX} 숫자예요` };
  return {
    ok: true,
    warning,
    value: { pattern, match_type: matchType, category_id: input.categoryId, is_ambiguous: Boolean(input.isAmbiguous), priority: Number(p) },
  };
}

/** 바뀐 칸만. reapply = 과거 적용 화면으로 갈지(패턴·방식·카테고리가 바뀜) */
export function rulePatch(original, value) {
  const patch = {};
  for (const k of ['pattern', 'match_type', 'category_id', 'is_ambiguous', 'priority']) {
    if (original[k] !== value[k]) patch[k] = value[k];
  }
  const reapply = ['pattern', 'match_type', 'category_id'].some((k) => k in patch);
  return { patch, reapply };
}

/** 기간 칩 → RPC 인자. 올해 = 1월부터, 최근 3개월 = 이번 달 포함 3개월 [판단] */
export const PERIODS = Object.freeze([
  { key: 'all', label: '전체' },
  { key: 'year', label: '올해' },
  { key: '3m', label: '최근 3개월' },
]);
export function periodRange(key, thisMonth) {
  if (key === 'year') return { from: `${thisMonth.slice(0, 4)}-01-01`, to: null };
  if (key === '3m') return { from: addMonths(thisMonth, -2), to: null };
  return { from: null, to: null };
}

const RESULT_ORDER = ['created', 'updated', 'unchanged', 'manual_kept', 'skipped_priority'];
const CHANGES = new Set(['created', 'updated']);

/**
 * 미리보기 요약
 * @param rows reapply_category_rule 반환 행
 * @returns {{ changeCount, headline, counts: {key, label, count}[], changed: rows[] }}
 */
export function previewSummary(rows, cats, rule) {
  const catName = cats.get(rule.category_id)?.name ?? '같은 카테고리';
  const label = {
    created: '새로 분류',
    updated: '다른 카테고리에서 바뀜',
    unchanged: `이미 ${catName}`,
    manual_kept: '직접 고친 거래라 그대로',
    skipped_priority: '다른 규칙이 먼저라 그대로',
  };
  const by = new Map();
  for (const r of rows ?? []) by.set(r.result, (by.get(r.result) ?? 0) + 1);
  const changed = (rows ?? []).filter((r) => CHANGES.has(r.result));
  const changeCount = changed.length;
  return {
    changeCount,
    headline: changeCount ? `${changeCount}건이 바뀌어요` : '바뀌는 거래가 없어요',
    counts: RESULT_ORDER.filter((k) => by.get(k)).map((k) => ({ key: k, label: label[k], count: `${by.get(k)}건` })),
    changed,
  };
}

/** 바뀌는 거래 한 줄. detail = v_transaction_detail 행(없으면 가맹점 정리값만) */
export function changeLine(r, detail, cats) {
  const from = r.old_category_id ? (cats.get(r.old_category_id)?.name ?? '?') : '미분류';
  const to = cats.get(r.new_category_id)?.name ?? '?';
  const amount = detail ? (detail.kind === 'refund' ? won(-Number(detail.amount)) : won(Number(detail.amount))) : null;
  return {
    id: r.txn_id,
    merchant: detail?.merchant_raw ?? r.merchant_norm ?? '',
    sub: detail ? `${day(detail.occurred_on)} · ${amount}` : '',
    from: r.result === 'updated' && r.old_category_id === r.new_category_id ? '제안' : from,
    to: r.result === 'updated' && r.old_category_id === r.new_category_id ? `${to} 확정` : to,
  };
}

/** 적용 결과 문장(적용 호출의 반환값으로 센다 — 미리보기와 다를 수 있음) */
export function applyResult(rows) {
  const n = (rows ?? []).filter((r) => CHANGES.has(r.result)).length;
  const batchId = (rows ?? []).find((r) => r.change_batch_id)?.change_batch_id ?? null;
  return { count: n, batchId, text: n ? `${n}건 바꿨어요.` : '바뀐 거래가 없어요.' };
}

/** 과거 적용 실패 안내(LG007 = 2000건 초과 또는 카테고리 없는 모호 규칙) */
export function reapplyErrorText(err) {
  if (err?.code === 'bulk_invalid') return '대상이 너무 많거나(2,000건 넘음) 규칙에 카테고리가 없어요. 기간을 좁혀 주세요.';
  return null;
}
