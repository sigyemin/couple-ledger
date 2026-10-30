// =====================================================================
// 월 검토 — 화면 없이 계산하는 부분 (화면 설계 v0.1 4-5, 시안 7)
// 항목: 진행률 · 분류가 필요해요(분류 뒤 같은 가맹점 규칙 저장 — CL-066) · 같은 거래일 수도 있어요
//       · 원거래를 못 찾은 환불(CL-034) · 아직 안 정한 이체 상대(CL-066) · 나눈 금액이 안 맞는 거래
// - 숫자 기준은 DB 뷰(v_monthly_summary·v_possible_duplicates·v_line_mismatch)와 같게, 거래 목록은 그 달 내역(휴지통·테스트 결제수단 제외)
// 의존: core/format.js, router.js, import/normalize.js(matchCounterpartyRule), screens/merchant-classify-model.js(isTransferLike)
// =====================================================================
import { won, day } from '../core/format.js';
import { addMonths, currentMonth } from '../router.js';
import { MAX_BULK } from './list-model.js';
import { matchCounterpartyRule } from '../import/normalize.js';
import { matchNorm } from '../import/formats.js';
import { isTransferLike } from './merchant-classify-model.js';

/** 월 검토 기본 달 = 지난달(사용자 결정 10-29, 서울 기준. 1월이면 전년 12월). 더보기 '월 검토' 링크도 이 함수 */
export function defaultReviewMonth(now = new Date()) {
  return addMonths(currentMonth(now), -1);
}

/** 진행률: 그 달 거래 중 검토 대기가 아닌 비율 (v_monthly_summary.txn_count·needs_review_count) */
export function progress(summary) {
  const total = Number(summary?.txn_count) || 0;
  const pending = Number(summary?.needs_review_count) || 0;
  const done = Math.max(0, total - pending);
  return { total, pending, done, ratio: total ? done / total : 1, text: total ? `${total}건 중 ${done}건 확인 · 검토 대기 ${pending}건` : '이 달 거래가 없어요' };
}

/**
 * 분류가 필요해요: 미분류 거래 전체(검토 상태와 무관 — txn_is_uncategorized 기준, PR #20 리뷰 3), 이체 제외.
 * 가맹점 정리값별로 묶음(수입과 지출은 따로 — 카테고리 그룹이 다름). 한 묶음은 MAX_BULK(500)건까지(bulk_set_category 상한)
 * @returns {{ key, merchant, norm, kind: 'income'|'expense', count, total, amountText, ids, splitCount, toConfirm, transferLike, canRule }[]} 건수 많은 순
 *   toConfirm = 분류하면 확인함으로 바꿀 id(이미 확인함인 것 제외 — 사용자 결정 10-29)
 *   canRule = 가맹점 규칙을 만들 수 있나(지출 묶음이고 통장 이체 행이 아님 — 가맹점별 분류 CL-061과 같은 판단)
 */
export function uncategorizedGroups(rows) {
  const map = new Map();
  for (const r of rows) {
    if (r.is_uncategorized !== true || r.kind === 'transfer') continue;
    const kind = r.kind === 'income' ? 'income' : 'expense';
    const key = `${kind}|${r.merchant_norm ?? r.merchant_raw}`;
    if (!map.has(key)) map.set(key, { key, merchant: r.merchant_raw, norm: r.merchant_norm ?? r.merchant_raw ?? '', kind, rows: [] });
    map.get(key).rows.push(r);
  }
  return [...map.values()]
    .sort((a, b) => b.rows.length - a.rows.length || a.merchant.localeCompare(b.merchant))
    .map((g) => {
      const use = g.rows.slice(0, MAX_BULK);
      const sum = use.reduce((s, r) => s + (r.kind === 'refund' ? -Number(r.amount) : Number(r.amount)), 0);
      const transferLike = g.rows.every(isTransferLike);
      return {
        key: g.key, merchant: g.merchant, norm: g.norm, kind: g.kind, count: use.length, total: g.rows.length, amountText: won(sum),
        transferLike, canRule: g.kind === 'expense' && !transferLike,
        ids: use.map((r) => r.id),
        splitCount: use.filter((r) => Array.isArray(r.lines) && r.lines.length > 1).length,
        toConfirm: use.filter((r) => r.review_status !== 'confirmed').map((r) => r.id),
      };
    });
}

/**
 * 분류 확인 문구 (사용자 결정: 분류하면 확인함으로 바뀜. 나눈 거래가 있으면 알림 — PR #20 리뷰 2)
 * makeRule이면 같은 가맹점 규칙도 저장한다고 알림(CL-066, 화면 v0.1 4-5)
 */
export function classifyConfirmText(g, categoryName, makeRule = false) {
  const parts = [`${g.merchant} ${g.count}건을 '${categoryName}'(으)로 분류해요.`];
  if (g.splitCount) parts.push(`그중 나눈 거래 ${g.splitCount}건은 나눈 금액이 모두 '${categoryName}' 하나로 바뀌어요.`);
  if (g.toConfirm.length) parts.push(`${g.toConfirm.length}건은 확인함으로 바뀌어요.`);
  if (makeRule) parts.push(`앞으로 '${g.merchant}' 거래는 올릴 때 '${categoryName}'(으)로 자동 분류돼요(가맹점 규칙).`);
  if (g.total > g.count) parts.push(`(한 번에 ${MAX_BULK}건까지라 나머지 ${g.total - g.count}건은 다음에 해요.)`);
  return {
    title: '분류하기', message: parts.join(' '),
    undoNote: `분류는 더보기 › 변경 기록에서 되돌릴 수 있어요(확인함은 그대로 남아요).${makeRule ? ' 규칙은 규칙·카테고리에서 끄거나 지울 수 있어요.' : ''}`,
  };
}

/** 이체 상대 묶음 화면 상한(그 달 통장 행이 아주 많을 때) */
export const CP_GROUP_LIMIT = 50;

/**
 * 아직 안 정한 이체 상대(CL-066, 화면 v0.1 4-5): 그 달 검토 대기 통장 행 중 켜진 이체 상대 규칙에 안 맞는 것
 * - 대상은 DB apply_counterparty_rule과 같게: 검토 대기, 통장 결제수단, 종류 지출·수입, 카드 사용 행 아님(card_kind 없음)
 * - 규칙 일치는 업로드와 같은 matchCounterpartyRule(설명 칸). 거래 종류·상대 칸(raw)을 보는 규칙은 화면 목록에 그 칸이 없어
 *   판정하지 못하므로, 범위(통장·방향)가 맞으면 '맞을 수도 있음'으로 보고 목록에서 뺀다(unsure 건수로 알림)
 * - 묶음: 통장 × 방향 × 이름 정리값. 건수 많은 순 → 금액 큰 순 → 이름
 * - 이름(이체 상대 원문)은 화면에만 쓴다 — 주소·기록·오류에 넣지 않는다(보안 원칙)
 * @param rules 켜진 counterparty_rules(서버 정렬: priority, created_at, id)
 * @returns {{ groups: { key, name, sourceId, sourceLabel, direction, count, amountText, ids }[], unsure: number }}
 */
export function unmatchedCounterparties(rows, rules) {
  const judged = [];
  const unjudged = [];
  for (const r of rules ?? []) {
    if (r.is_active === false) continue;
    (r.txn_type || r.match_field !== 'merchant' ? unjudged : judged).push(r);
  }
  const map = new Map();
  let unsure = 0;
  for (const r of rows ?? []) {
    if (r.review_status !== 'needs_review' || r.source_kind !== 'bank_account' || r.card_kind) continue;
    if (r.kind !== 'expense' && r.kind !== 'income') continue;
    const direction = r.kind === 'expense' ? 'out' : 'in';
    if (unjudged.some((u) => (!u.source_id || u.source_id === r.source_id) && (!u.direction || u.direction === direction))) { unsure += 1; continue; }
    if (matchCounterpartyRule(judged, { sourceId: r.source_id, direction, txnType: null, merchantRaw: r.merchant_raw ?? '', counterparty: '' })) continue;
    const key = `${r.source_id}|${direction}|${matchNorm(r.merchant_raw ?? '')}`;
    if (!map.has(key)) map.set(key, { key, name: r.merchant_raw ?? '', sourceId: r.source_id, sourceLabel: r.source_label ?? '', direction, rows: [] });
    map.get(key).rows.push(r);
  }
  const groups = [...map.values()].map((g) => {
    const amount = g.rows.reduce((s, r) => s + Number(r.amount), 0);
    return { key: g.key, name: g.name, sourceId: g.sourceId, sourceLabel: g.sourceLabel, direction: g.direction, count: g.rows.length, amount, amountText: won(amount), ids: g.rows.map((r) => r.id) };
  }).sort((a, b) => b.count - a.count || b.amount - a.amount || a.name.localeCompare(b.name));
  return { groups, unsure };
}

/**
 * 같은 거래일 수도 있어요: v_possible_duplicates(결제수단·날짜·가맹점·금액·종류가 같은 2건 이상) 중
 * 그 달 거래에 2건 이상 있고 아직 검토 대기가 있는 묶음만(둘 다 맞음 = 확인함으로 바꾸면 사라짐 [판단: 뷰에는 "맞음" 표시 칸이 없음])
 */
export function duplicateGroups(dupRows, rows) {
  const out = [];
  for (const d of dupRows) {
    const same = rows.filter((r) => r.source_id === d.source_id && r.occurred_on === d.occurred_on
      && (r.merchant_norm ?? '') === (d.merchant_norm ?? '') && Number(r.amount) === Number(d.amount) && r.kind === d.kind);
    if (same.length < 2 || !same.some((r) => r.review_status === 'needs_review')) continue;
    out.push({
      title: `${same[0].merchant_raw} · ${day(d.occurred_on)} · ${won(Number(d.amount))} · ${same.length}건`,
      items: same.map((r) => ({ id: r.id, text: `${r.source_label}${r.occurred_time ? ` · ${String(r.occurred_time).slice(0, 5)}` : ''}${r.memo ? ` · ${r.memo}` : ''}` })),
      pendingIds: same.filter((r) => r.review_status === 'needs_review').map((r) => r.id),
    });
  }
  return out;
}

/** 원거래를 못 찾은 환불 수 (v_monthly_summary.unlinked_refund_count와 같은 기준) */
export function unlinkedRefundCount(summary) {
  return Number(summary?.unlinked_refund_count) || 0;
}

/**
 * 나눈 금액이 안 맞는 거래: v_line_mismatch 중 그 달 거래이면서 라인이 1개 이상인 것
 * [사실: 로컬 DB] 뷰가 left join이라 라인 없는 거래(규칙 없는 업로드·라인 없는 직접 추가)도 lines_amount 0으로 나온다 → 앱에서 뺀다
 */
export function mismatchItems(mismatchRows, rows) {
  const withLines = new Set(rows.filter((r) => Array.isArray(r.lines) && r.lines.length > 0).map((r) => r.id));
  return mismatchRows.filter((m) => withLines.has(m.id)).map((m) => ({
    id: m.id,
    text: `${m.merchant_raw} · ${day(m.occurred_on)}`,
    sub: `거래 ${won(Number(m.amount))} · 나눈 합계 ${won(Number(m.lines_amount))}`,
  }));
}

/** 둘 다 맞음 patch */
export function confirmBothPatch(memberId) {
  return { review_status: 'confirmed', updated_by: memberId };
}
