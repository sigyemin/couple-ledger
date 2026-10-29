// =====================================================================
// 거래 상세 "기록" — 화면 없이 계산하는 부분 (화면 설계 v0.3 5-3 시안 26). 읽기만
// 줄의 출처(최근 순):
//   올림 / 직접 추가   : transactions.created_by·created_at + import_batches(file_name·row_count)
//   분류·종류 바꿈     : v_change_batch_items(txn_id) + v_change_batch_summary(묶음 종류·누가·언제·되돌림) → "변경 기록에서 보기"
//   되돌림             : v_change_batch_summary.reverted_by·reverted_at
//   고침               : txn_edit_log(누가·언제·어느 칸 — 값 없음). 같은 순간(같은 트랜잭션)에 같은 사람이 한 묶음·되돌림의 흔적은 그 줄에 합친다
// - 고치기 전 값은 분류(변경 묶음 이력)만 보인다. 가맹점·메모 원문을 다른 곳에 복사해 두지 않는다(설계 5-3)
// - 이름은 members.display_name만
// 의존: core/format.js, screens/changes-model.js(KIND_NAME), screens/home-model.js(subjectParticle)
// =====================================================================
import { dateTime } from '../core/format.js';
import { KIND_NAME } from './changes-model.js';
import { subjectParticle } from './home-model.js';

export const EDIT_LIMIT = 200;
export const ITEM_LIMIT = 500;

// txn_edit_log.changed_fields → 화면 이름(같은 이름은 한 번만)
const FIELD_LABEL = {
  amount: '금액', occurred_on: '날짜', occurred_time: '시각', merchant_raw: '가맹점', merchant_norm: '가맹점', memo: '메모',
  is_shared: '공동·개인', share_ratio: '분담', is_excluded: '집계 제외', exclude_reason: '집계 제외', kind: '종류',
  review_status: '검토 상태', deleted_at: '휴지통·되살리기', refund_of_txn_id: '환불 연결', linked_txn_id: '연결',
  installment_months: '할부', source_id: '결제수단', lines: '금액 나누기·분류', created_at: '등록 시각',
};
// 변경 묶음(분류·재적용·이체 상대 적용)과 되돌리기가 바꾸는 칸 — 같은 순간의 수정 기록에서는 묶음 줄로 보인다
const BATCH_FIELDS = new Set(['lines', 'kind', 'is_excluded', 'exclude_reason', 'is_shared', 'review_status']);
const TXN_KIND = { expense: '지출', refund: '환불', income: '수입', transfer: '이체' };

const who = (nameOf, id) => {
  const n = id ? nameOf.get(id) : null;
  return n ? `${n}${subjectParticle(n)}` : '관리자가';
};

/** 'YYYY-MM-DD HH:MM'(서울) → { day: '10월 14일', time: '20:15' } */
function when(ts) {
  const s = dateTime(ts);
  return { day: `${Number(s.slice(5, 7))}월 ${Number(s.slice(8, 10))}일`, time: s.slice(11, 16) };
}

export function fieldsText(fields) {
  return [...new Set((fields ?? []).map((f) => FIELD_LABEL[f] ?? '기타'))].join(' · ');
}

/** 한 묶음의 이력 → 둘째 줄("식재료 → 외식", "종류 지출 → 이체") */
function itemsText(items, cats) {
  const name = (id) => (id ? (cats.get(id)?.name ?? '?') : '미분류');
  const lines = items.filter((x) => x.target_kind === 'line');
  const txns = items.filter((x) => x.target_kind === 'txn');
  const parts = [];
  if (lines.length) {
    const first = `${name(lines[0].old_category_id)} → ${name(lines[0].new_category_id)}`;
    parts.push(lines.length > 1 ? `${first} 외 ${lines.length - 1}줄` : first);
  }
  for (const t of txns.slice(0, 1)) {
    if (t.old_kind !== t.new_kind) parts.push(`종류 ${TXN_KIND[t.old_kind] ?? '-'} → ${TXN_KIND[t.new_kind] ?? '-'}`);
    if (t.old_review_status !== t.new_review_status && t.new_review_status === 'confirmed') parts.push('확인함');
  }
  return parts.join(' · ');
}

/**
 * @param o.row        v_transaction_detail 행(created_at·created_by·origin·batch_id)
 * @param o.batch      import_batches 행 또는 null
 * @param o.items      v_change_batch_items 행(이 거래)
 * @param o.batches    v_change_batch_summary 행(위 items의 묶음)
 * @param o.edits      txn_edit_log 행(이 거래)
 * @returns {{ at, day, time, title, sub, href }[]} 최근 순
 */
export function historyEntries({ row, batch = null, items = [], batches = [], edits = [], cats, nameOf }) {
  const out = [];
  const add = (at, title, sub = '', href = null, tag = null) => out.push({ at: String(at), ...when(at), title, sub, href, tag });

  if (row.origin === 'manual') add(row.created_at, `${who(nameOf, row.created_by)} 직접 추가`);
  else add(batch?.uploaded_at ?? row.created_at, `${who(nameOf, batch?.uploaded_by ?? row.created_by)} 올림`,
    batch ? `${batch.file_name} · ${batch.row_count}행` : '');

  // 묶음·되돌림의 순간(같은 트랜잭션 now()) — 이 순간·같은 사람의 수정 기록은 따로 보이지 않는다
  const covered = new Set();
  const byBatch = new Map();
  for (const it of items) byBatch.set(it.change_batch_id, [...(byBatch.get(it.change_batch_id) ?? []), it]);
  for (const b of batches) {
    const its = byBatch.get(b.id) ?? [];
    if (!its.length) continue;
    const verb = b.kind === 'bulk_edit' ? '분류 바꿈' : (KIND_NAME[b.kind] ?? '한 번에 바꿈');
    add(b.created_at, `${who(nameOf, b.created_by)} ${verb}`, itemsText(its, cats), `#/change/${b.id}`, b.is_reverted ? '되돌림' : null);
    covered.add(`${b.created_at}|${b.created_by ?? ''}`);
    if (b.reverted_at) {
      add(b.reverted_at, `${who(nameOf, b.reverted_by)} 되돌림`, KIND_NAME[b.kind] ?? '', `#/change/${b.id}`);
      covered.add(`${b.reverted_at}|${b.reverted_by ?? ''}`);
    }
  }
  for (const e of edits) {
    // 묶음·되돌림과 같은 순간이면 묶음이 바꾸는 칸만 뺀다(같은 트랜잭션에서 다른 칸을 고쳤다면 그 칸은 남긴다)
    const fields = covered.has(`${e.edited_at}|${e.edited_by ?? ''}`)
      ? (e.changed_fields ?? []).filter((f) => !BATCH_FIELDS.has(f))
      : (e.changed_fields ?? []);
    if (fields.length) add(e.edited_at, `${who(nameOf, e.edited_by)} 고침`, fieldsText(fields));
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

export const HISTORY_NOTE = '기록에는 누가·언제·어느 칸을 고쳤는지만 남아요. 고치기 전 값은 분류만 남아요.';
