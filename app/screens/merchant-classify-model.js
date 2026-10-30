// =====================================================================
// 가맹점별로 분류하기 — 화면 없이 계산하는 부분 (CL-061, 사용자 요청 10-30)
// - 대상: 모든 달의 미분류 거래(v_transaction_detail.is_uncategorized — 휴지통·집계 제외·이체는 DB 함수가 이미 뺌), 시험 결제수단 제외
// - 묶음: (수입 | 지출·환불) × 가맹점 정리값(merchant_norm). 건수 큰 순 → 금액(절댓값) 큰 순 → 이름
// - 통장 이체 행(통장 결제수단이고 체크카드 사용이 아닌 행): 이름이 이체 상대라 가맹점 규칙 대신 이체 상대 규칙을 안내
// - 수입 묶음: 가맹점 규칙은 지출 카테고리만이라 규칙 만들기를 끈다
// - 분류는 기존 bulk_set_category(변경 기록 → 되돌리기 가능) + 월 검토와 같이 확인함으로(사용자 결정: 분류하면 확인함)
// 의존: core/format.js, screens/list-model.js(MAX_BULK), screens/rules-model.js(checkRule, PRIORITY_DEFAULT)
// =====================================================================
import { won } from '../core/format.js';
import { MAX_BULK } from './list-model.js';
import { checkRule, PRIORITY_DEFAULT } from './rules-model.js';
import { matchNorm } from '../import/formats.js';

/** 통장 이체 행인가: 통장 결제수단 + 체크카드 사용이 아님 */
export function isTransferLike(row) {
  return row.source_kind === 'bank_account' && row.card_kind !== 'check_card';
}

/**
 * 미분류 행 → 묶음
 * @returns {{ key, merchant, norm, kind, count, total, amount, amountText, ids, toConfirm, splitCount, transferLike, canRule, months }[]}
 *   count = 이번에 바꿀 건수(최대 MAX_BULK), total = 묶음 전체, months = 든 달('YYYY-MM') 오래된 순
 */
export function merchantGroups(rows) {
  const map = new Map();
  for (const r of rows ?? []) {
    if (r.is_uncategorized !== true || r.kind === 'transfer' || r.is_test_source) continue;
    const kind = r.kind === 'income' ? 'income' : 'expense';
    const norm = r.merchant_norm ?? r.merchant_raw ?? '';
    const key = `${kind}|${norm}`;
    if (!map.has(key)) map.set(key, { key, kind, norm, merchant: r.merchant_raw ?? norm, rows: [] });
    map.get(key).rows.push(r);
  }
  const signed = (r) => (r.kind === 'refund' ? -Number(r.amount) : Number(r.amount));
  return [...map.values()].map((g) => {
    const use = g.rows.slice(0, MAX_BULK);
    const amount = g.rows.reduce((s, r) => s + signed(r), 0);
    const transferLike = g.rows.every(isTransferLike);
    return {
      key: g.key, merchant: g.merchant, norm: g.norm, kind: g.kind,
      count: use.length, total: g.rows.length, amount, amountText: won(amount),
      ids: use.map((r) => r.id),
      toConfirm: use.filter((r) => r.review_status !== 'confirmed').map((r) => r.id),
      splitCount: use.filter((r) => Array.isArray(r.lines) && r.lines.length > 1).length,
      transferLike,
      canRule: g.kind === 'expense' && !transferLike,
      months: [...new Set(g.rows.map((r) => String(r.period_month).slice(0, 7)))].sort(),
    };
  }).sort((a, b) => b.total - a.total || Math.abs(b.amount) - Math.abs(a.amount) || a.merchant.localeCompare(b.merchant));
}

/** 묶음 한 줄 아래 글: '12건 · 345,000원 · 3~9월' */
export function groupSub(g) {
  const m = g.months;
  const span = m.length === 0 ? '' : (m.length === 1 ? ` · ${Number(m[0].slice(5))}월`
    : ` · ${m[0].slice(0, 4) === m.at(-1).slice(0, 4) ? `${Number(m[0].slice(5))}~${Number(m.at(-1).slice(5))}월` : `${m[0]}~${m.at(-1)}`}`);
  return `${g.total}건 · ${g.amountText}${span}`;
}

/**
 * 가맹점 규칙 값 → 그 카테고리, 확정. 못 만들면 { ok:false, message }
 * - 기본: 원래 이름이 똑같으면(exact, DB가 match_norm으로 비교 — 띄어쓰기·전각 무시)
 * - contains: 사용자가 줄여 쓴 글자가 들어가면 모두(예: 같은 브랜드 다른 지점). 이 묶음 이름에 그 글자가 들어 있어야 한다
 * @param {{ contains?: string|null }} [o]
 */
export function ruleFor(g, categoryId, { contains = null } = {}) {
  if (!g.canRule) return { ok: false, message: g.transferLike ? '이체 상대는 이체 상대 규칙으로 정해요' : '수입은 가맹점 규칙을 만들 수 없어요' };
  const useContains = contains != null;
  if (useContains && !matchNorm(g.norm).includes(matchNorm(contains))) {
    return { ok: false, message: `'${g.merchant}' 안에 있는 글자로 줄여 주세요` };
  }
  const v = checkRule({
    pattern: useContains ? contains : g.merchant, matchType: useContains ? 'contains' : 'exact', categoryId, isAmbiguous: false, priority: String(PRIORITY_DEFAULT),
  });
  return v.ok ? { ok: true, value: v.value, warning: v.warning } : { ok: false, message: v.message };
}

/** 확인 창 문구 */
export function classifyText(g, categoryName, makeRule, rule = null) {
  const parts = [`${g.merchant} ${g.count}건을 '${categoryName}'(으)로 분류해요.`];
  if (g.splitCount) parts.push(`그중 나눈 거래 ${g.splitCount}건은 나눈 금액이 모두 '${categoryName}' 하나로 바뀌어요.`);
  if (g.toConfirm.length) parts.push(`${g.toConfirm.length}건은 확인함으로 바뀌어요.`);
  if (makeRule && rule?.match_type === 'contains') {
    parts.push(`앞으로 이름에 '${rule.pattern}'이(가) 들어간 가맹점은 모두 올릴 때 '${categoryName}'(으)로 자동 분류돼요(가맹점 규칙).`);
  } else if (makeRule) parts.push(`앞으로 '${g.merchant}' 거래는 올릴 때 '${categoryName}'(으)로 자동 분류돼요(가맹점 규칙).`);
  if (g.total > g.count) parts.push(`(한 번에 ${MAX_BULK}건까지라 나머지 ${g.total - g.count}건은 다음에 해요.)`);
  return { title: '가맹점별로 분류하기', message: parts.join(' '), undoNote: '분류는 더보기 › 변경 기록에서 되돌릴 수 있어요. 규칙은 규칙·카테고리에서 끄거나 지울 수 있어요.' };
}

/** 변경 기록 설명(200자) */
export function classifyDescription(g, categoryName) {
  return `가맹점별 분류 · ${g.merchant} ${g.count}건 → ${categoryName}`.slice(0, 200);
}

/**
 * 같은 규칙이 이미 켜져 있나(category_rules에 유일 제약이 없어 앱이 먼저 본다 — CL-061 리뷰 ④)
 * 같음 = match_type 같고, 정리값(match_norm) 패턴 같고, 카테고리 같음
 * @param rules 켜진 category_rules 행(match_type·category_id로 미리 거른 것이어도 됨)
 */
export function sameRuleExists(rules, value) {
  const n = matchNorm(value.pattern);
  return (rules ?? []).some((r) => r.is_active !== false && r.match_type === value.match_type
    && r.category_id === value.category_id && matchNorm(r.pattern) === n);
}

/**
 * '켜진 규칙으로 한 번에 분류' 대상: 켜진 규칙 중 카테고리가 켜진 것, 적용 순서(priority, created_at, id)
 * (카테고리가 꺼진 규칙은 DB가 LG007로 거부하므로 미리 뺀다)
 */
export function reapplyOrder(rules, categories) {
  const on = new Set((categories ?? []).filter((c) => c.is_active).map((c) => c.id));
  return (rules ?? []).filter((r) => r.is_active && r.category_id && on.has(r.category_id))
    .sort((a, b) => a.priority - b.priority || String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
}

const REAPPLY_CHANGES = new Set(['created', 'updated']);

/** 규칙 하나의 미리보기·적용 결과 → 바뀌는(바뀐) 건수 */
export function reapplyCount(rows) {
  return (rows ?? []).filter((r) => REAPPLY_CHANGES.has(r.result)).length;
}

/** 한 번에 분류 확인 문구 */
export function bulkReapplyText(ruleCount, changeCount, skippedRules) {
  return {
    title: '켜진 규칙으로 한 번에 분류',
    message: `켜진 가맹점 규칙 ${ruleCount}개를 우선 순서대로 모든 달 거래에 적용해요. ${changeCount}건이 분류돼요(직접 고친 거래는 그대로).`
      + (skippedRules ? ` 바뀌는 거래가 없는 규칙 ${skippedRules}개는 건너뛰어요.` : '') + ' 검토 상태는 그대로예요.',
    undoNote: '규칙마다 변경 기록이 하나씩 남아요. 더보기 › 변경 기록에서 규칙별로 되돌릴 수 있어요.',
  };
}
