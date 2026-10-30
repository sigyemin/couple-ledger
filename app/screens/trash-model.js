// =====================================================================
// 휴지통 — 화면 없이 계산하는 부분 (화면 설계 v0.3 2-1 시안 20, 2-2 시안 21)
// - 목록: 지운 날(서울)별 묶음, 최근 순. 꼬리표(환불·직접 추가), "○이 지움", 원거래+연결 환불이 함께 지워졌으면 표시
// - 되살리기: 고른 것 중 원거래 먼저, 환불 나중. 환불만 골랐는데 원거래가 휴지통이면 함께 되살릴지 묻는다(아니면 건너뜀)
//   한 건씩 transactions update(deleted_at·deleted_by = null, updated_by = 나). 중간 실패는 건별 결과로 보인다(묶음 RPC S5 없음)
// 의존: core/format.js, screens/home-model.js(subjectParticle)
// =====================================================================
import { won, day, month, dateTime } from '../core/format.js';
import { subjectParticle } from './home-model.js';

export const TRASH_LIMIT = 200;

/** timestamptz → 서울 'YYYY-MM-DD' */
function seoulDate(ts) {
  return dateTime(ts).slice(0, 10);
}

/**
 * 지운 날별 묶음
 * @param rows v_transaction_detail(deleted_at 있음)
 */
export function trashGroups(rows, members) {
  const nameOf = new Map(members.map((m) => [m.id, m.display_name]));
  const slotOf = new Map(members.map((m) => [m.id, m.member_slot]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const refundsOf = new Map();
  for (const r of rows) {
    if (r.refund_of_txn_id && byId.has(r.refund_of_txn_id)) refundsOf.set(r.refund_of_txn_id, (refundsOf.get(r.refund_of_txn_id) ?? 0) + 1);
  }
  const sorted = [...rows].sort((a, b) => String(b.deleted_at).localeCompare(String(a.deleted_at)) || String(a.id).localeCompare(String(b.id)));
  const groups = [];
  for (const r of sorted) {
    const date = seoulDate(r.deleted_at);
    const tags = [];
    if (r.kind === 'refund') tags.push('환불');
    if (r.origin === 'manual') tags.push('직접 추가');
    const together = refundsOf.get(r.id);
    const slot = slotOf.get(r.payer_member_id);
    const item = {
      id: r.id,
      merchant: r.merchant_raw,
      amount: r.kind === 'refund' ? won(-Number(r.amount)) : won(Number(r.amount)),
      sub: `${day(r.occurred_on)} · ${r.source_label} · ${who(nameOf.get(r.deleted_by))} 지움`,
      tags,
      together: together ? `환불 ${together}건과 함께` : null,
      payer: { initial: String(r.payer_name ?? '').slice(0, 1), name: r.payer_name ?? '', slot: slot === 1 || slot === 2 ? slot : 0 },
    };
    const last = groups[groups.length - 1];
    if (last && last.date === date) last.items.push(item);
    else groups.push({ date, label: `${day(date)} 지움`, items: [item] });
  }
  return groups;
}

const who = (name) => (name ? `${name}${subjectParticle(name)}` : '누군가');

/**
 * 되살리기 계획
 * @param selectedIds 고른 id
 * @param rows 휴지통의 모든 행(지금 읽은 것)
 * @returns {{ picked: object[], askOriginals: {id, text}[] }}
 *   askOriginals = 고르지 않았지만 휴지통에 있는 원거래(함께 되살릴지 물을 것)
 */
export function restorePlan(selectedIds, rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const picked = selectedIds.map((id) => byId.get(id)).filter(Boolean);
  const pickedSet = new Set(picked.map((r) => r.id));
  const askOriginals = [];
  for (const r of picked) {
    const o = r.refund_of_txn_id ? byId.get(r.refund_of_txn_id) : null;
    if (o && !pickedSet.has(o.id) && !askOriginals.some((a) => a.id === o.id)) {
      askOriginals.push({ id: o.id, text: `${o.merchant_raw} ${won(Number(o.amount))}` });
    }
  }
  return { picked, askOriginals };
}

/**
 * 실제 순서(원거래 먼저). includeOriginals = 함께 되살리기로 한 원거래 id, 아니면 그 환불은 건너뜀
 * @returns {{ order: string[], skipped: string[] }}
 */
export function restoreOrder(plan, rows, includeOriginals) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const include = new Set(includeOriginals);
  const ids = new Set(plan.picked.map((r) => r.id));
  for (const id of include) ids.add(id);
  const skipped = [];
  for (const r of plan.picked) {
    const o = r.refund_of_txn_id ? byId.get(r.refund_of_txn_id) : null;
    if (o && !ids.has(o.id)) { ids.delete(r.id); skipped.push(r.id); }
  }
  const all = [...ids].map((id) => byId.get(id));
  const isRefund = (r) => r.kind === 'refund' && r.refund_of_txn_id != null;
  return { order: [...all.filter((r) => !isRefund(r)), ...all.filter(isRefund)].map((r) => r.id), skipped };
}

/**
 * 확인 시트 문구. reviewStates = Map(period_month → review_state)
 * statesUnknown = 확인 상태를 읽지 못함 → '확인 후 변경됨' 여부를 알 수 없다고 적는다(PR #19 리뷰 3)
 */
export function restoreConfirmText(rowsToRestore, reviewStates, { statesUnknown = false } = {}) {
  const first = rowsToRestore[0];
  const title = rowsToRestore.length === 1
    ? `${first.merchant_raw} ${won(Number(first.amount))}을 되살릴까요?`
    : `${rowsToRestore.length}건을 되살릴까요?`;
  const months = [...new Set(rowsToRestore.map((r) => r.period_month))].sort();
  const parts = [`${months.map((m) => month(m)).join(', ')} 집계·정산에 다시 들어가요.`];
  const reviewed = months.filter((m) => reviewStates.get(m) === 'reviewed');
  if (statesUnknown) parts.push("확인 완료한 달인지 확인하지 못했어요. 확인 완료한 달이면 '확인 후 변경됨'이 돼요.");
  else if (reviewed.length) parts.push(`${reviewed.map((m) => month(m)).join(', ')}이 '확인 후 변경됨'이 돼요.`);
  if (rowsToRestore.some((r) => r.kind === 'refund' && r.refund_of_txn_id)) parts.push('원거래를 먼저, 환불을 나중에 되살려요.');
  return { title: '되살리기', message: `${title} ${parts.join(' ')}` };
}

export function restorePatch(memberId) {
  return { deleted_at: null, deleted_by: null, updated_by: memberId };
}

/** 결과 문장: 건별 결과 [{ id, ok, code }] */
export function restoreResultText(results, skippedCount) {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  const parts = [ok > 0 ? `${ok}건 되살렸어요.` : '되살리지 못했어요.'];
  if (failed.length) {
    const refundBlocked = failed.filter((r) => r.code === 'refund_invalid').length;
    const locked = failed.filter((r) => r.code === 'immutable').length; // v0.18 LG005: 되살리기 말고 다른 값까지 바꾸려 함
    if (refundBlocked) parts.push(`${refundBlocked}건은 원거래가 휴지통에 있어 되살리지 못했어요.`);
    if (locked) parts.push(`${locked}건은 휴지통에서 바꿀 수 없는 값이 있어 되살리지 못했어요. 새로고침해 주세요.`);
    if (failed.length - refundBlocked - locked) parts.push(`${failed.length - refundBlocked - locked}건은 오류로 되살리지 못했어요.`);
  }
  if (skippedCount) parts.push(`환불 ${skippedCount}건은 원거래가 휴지통에 있어 건너뛰었어요.`);
  return parts.join(' ');
}
