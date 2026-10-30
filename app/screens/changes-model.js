// =====================================================================
// 변경 기록 — 화면 없이 계산하는 부분 (화면 설계 v0.3 4-1 시안 24, 4-2 시안 25)
// - 목록: v_change_batch_summary(종류·설명·거래 수·되돌림 여부), 최근 90일
// - 상세: v_change_batch_items(이력 행마다 is_revertible·revert_action — revert_change_batch와 같은 판정, v0.17 S2)
//   + 지금 거래·라인 값(v_transaction_detail) + 카테고리 이름
// - 되돌리기: revert_change_batch(id). 결과 건수는 RPC 반환값으로 센다(미리보기와 다를 수 있음)
// 의존: core/format.js, screens/home-model.js(subjectParticle)
// =====================================================================
import { won, day, dateTime } from '../core/format.js';
import { subjectParticle } from './home-model.js';

export const KIND_NAME = Object.freeze({
  rule_reapply: '규칙 다시 적용', bulk_edit: '카테고리 바꾸기', counterparty_apply: '이체 상대 적용', order_match: '주문 맞추기',
});
const TXN_KIND = { expense: '지출', refund: '환불', income: '수입', transfer: '이체' };
const EXCLUDE = { card_bill: '카드 대금', check_card: '체크카드 출금', internal_transfer: '내 계좌끼리·저축', personal_transfer: '두 사람 사이 송금', other: '기타' };
const REVIEW = { auto: '자동 분류', needs_review: '검토 대기', confirmed: '확인함' };
const who = (name) => (name ? `${name}${subjectParticle(name)}` : '누군가');

/** 목록 시작 시각(최근 90일) */
export function since90(now = new Date()) {
  return new Date(now.getTime() - 90 * 864e5).toISOString();
}

/** 목록 한 줄 */
export function batchRow(b, members) {
  const nameOf = (id) => members.find((m) => m.id === id)?.display_name;
  const reverted = b.reverted_at != null;
  return {
    id: b.id,
    title: `${KIND_NAME[b.kind] ?? b.kind}${b.description ? ` · ${b.description}` : ''}`,
    sub: `거래 ${Number(b.txn_count) || 0}건 · ${dateTime(b.created_at)} · ${nameOf(b.created_by) ?? '-'}`,
    reverted,
    revertedText: reverted ? `되돌림 · ${who(nameOf(b.reverted_by))} ${dateTime(b.reverted_at)}` : null,
  };
}

function catName(cats, id) {
  if (!id) return '미분류';
  const c = cats.get(id);
  if (!c) return '?';
  const parent = c.parent_id ? cats.get(c.parent_id) : null;
  return parent ? `${parent.name} · ${c.name}` : c.name;
}

/**
 * 상세: 거래별로 묶은 미리보기
 * @param items v_change_batch_items 행
 * @param txns Map(txn_id → v_transaction_detail 행)
 * @param cats Map(id → categories 행)
 */
export function batchDetail(batch, items, txns, cats) {
  const byTxn = new Map();
  for (const it of items) {
    if (!byTxn.has(it.txn_id)) byTxn.set(it.txn_id, []);
    byTxn.get(it.txn_id).push(it);
  }
  const rows = [...byTxn.entries()].map(([txnId, its]) => {
    const t = txns.get(txnId);
    const changes = its.map((it) => describe(it, t, cats));
    const revertible = its.some((it) => it.is_revertible);
    return {
      txnId,
      title: t ? `${t.merchant_raw} · ${day(t.occurred_on)} · ${won(Number(t.amount))}` : '(찾을 수 없는 거래)',
      changes,
      revertible,
      tag: batch.reverted_at ? '되돌림' : (revertible ? '원래대로' : '그대로'),
    };
  });
  const back = rows.filter((r) => r.revertible).length;
  const keep = rows.length - back;
  const notes = [];
  if (batch.kind === 'counterparty_apply') notes.push('종류·공동 여부가 돌아가 지출 집계가 바뀌어요. 확인 완료한 달이 \'확인 후 변경됨\'이 돼요.');
  else notes.push('분류만 바뀐 묶음이라 \'확인 후 변경됨\'이 뜨지 않아요.');
  notes.push('되돌린 것을 다시 되돌릴 수는 없어요.');
  return {
    rows,
    preview: batch.reverted_at ? null : `되돌리면 ${back}건이 원래대로${keep ? `, ${keep}건은 그 뒤에 다시 바뀌어 그대로 둬요` : ''}`,
    canRevert: !batch.reverted_at && back > 0,
    buttonLabel: `${back}건 되돌리기`,
    needsConfirm: batch.kind === 'counterparty_apply',
    notes,
  };
}

/** 이력 한 행 → "지금 → 되돌린 뒤" 문장 */
function describe(it, t, cats) {
  if (it.target_kind === 'line') {
    const line = (Array.isArray(t?.lines) ? t.lines : []).find((l) => l.line_id === it.line_id);
    const now = line ? catName(cats, line.category_id) : '라인 없음';
    const after = it.is_created_line ? '분류 지움' : catName(cats, it.old_category_id);
    if (it.revert_action === 'line_missing') return `분류: 나누기·합치기로 라인이 없어 그대로`;
    if (it.revert_action === 'conflict') return line ? `분류: 그 뒤 직접 ${now}(으)로 고쳐 그대로` : '분류: 그 뒤 다시 바뀌어 그대로';
    return `분류: ${now} → ${after}`;
  }
  const parts = [];
  if (it.old_kind !== it.new_kind) parts.push(`종류 ${TXN_KIND[it.new_kind] ?? '-'} → ${TXN_KIND[it.old_kind] ?? '-'}`);
  if (it.old_is_shared !== it.new_is_shared) parts.push(`${it.new_is_shared ? '공동' : '개인'} → ${it.old_is_shared ? '공동' : '개인'}`);
  if (it.old_exclude_reason !== it.new_exclude_reason) parts.push(`제외 ${EXCLUDE[it.new_exclude_reason] ?? '없음'} → ${EXCLUDE[it.old_exclude_reason] ?? '없음'}`);
  if (it.old_review_status !== it.new_review_status) parts.push(`${REVIEW[it.new_review_status] ?? '-'} → ${REVIEW[it.old_review_status] ?? '-'}`);
  const text = parts.length ? parts.join(', ') : '거래 값';
  return it.revert_action === 'conflict' ? `${text}: 그 뒤 다시 바뀌어 그대로` : text;
}

/** revert_change_batch 결과 → 문장 (거래 수 기준) */
export function revertResultText(results) {
  const done = new Set(results.filter((r) => r.result === 'reverted' || r.result === 'deleted').map((r) => r.txn_id));
  const kept = new Set(results.filter((r) => r.result === 'conflict' || r.result === 'line_missing').map((r) => r.txn_id));
  for (const id of done) kept.delete(id);
  return `${done.size}건을 되돌렸어요.${kept.size ? ` ${kept.size}건은 그대로 뒀어요.` : ''}`;
}
