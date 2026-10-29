// =====================================================================
// 업로드: 묶음 만들기(또는 이어 올리기) → import_transactions RPC를 200행씩 (공통 컴포넌트 설계 4장, 화면 설계 4-2 ④)
// - 같은 결제수단·같은 파일 해시의 묶음이 이미 있으면 그 묶음으로 이어 올린다("빠진 행만").
//   이미 들어간 행은 RPC가 duplicate로 건너뛴다
// - 묶음 파일명은 원본 파일명이 아니라 앱이 만든 이름(<기관>_<YYYY-MM>.<확장자>)만 (스키마 import_batches [I2])
// - 쓰기 RPC는 재시도하지 않는다. 중간에 실패하면 멈추고 지금까지의 결과를 돌려준다(같은 파일을 다시 올리면 이어진다)
// - 같은 묶음 안에서 원거래 행을 환불 행보다 앞에 둔다(정규화 결과 순서 그대로 보낸다)
// - 환불 행이 duplicate인데 DB에 이미 있는 그 환불의 금액이 새 파일 값과 다르면 알림(notices)으로 돌려준다
//   (부분취소 금액이 바뀜 — 사용자가 확인, 자동 반영 안 함. 설계 확인 D3). 조회는 구성원 select 권한 안에서
// 의존: core/db.js(createDb 결과), core/errors.js, core/sensitive.js, ./normalize.js
// =====================================================================
import { AppError } from '../core/errors.js';
import { hasSensitiveNumber } from '../core/sensitive.js';
import { toRpcRows } from './normalize.js';

export const CHUNK_ROWS = 200;
const LOOKUP_IDS = 100; // 금액 대조 조회 한 번에 넣는 id 수
export const RESULTS = Object.freeze(['inserted', 'duplicate', 'sensitive', 'refund_invalid', 'invalid']);

const RE_MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])-01$/;
const RE_HASH = /^[0-9a-f]{64}$/;

/** 묶음 파일명: '<기관>_<YYYY-MM>.<확장자>' (60자 이하, 민감번호 없음) */
export function batchFileName(institution, targetMonth, fileType) {
  const inst = String(institution ?? '').normalize('NFKC').replace(/[^0-9A-Za-z가-힣]/g, '').slice(0, 40) || 'file';
  const name = `${inst}_${targetMonth.slice(0, 7)}.${fileType}`;
  if (name.length > 60 || hasSensitiveNumber(name)) throw new TypeError('묶음 파일명을 만들 수 없습니다');
  return name;
}

/**
 * 묶음 찾기 또는 만들기. uploaded_by는 호출자 값을 받지 않고 인증 가드가 확인한 내 구성원 id만 쓴다
 * @param guard createAuthGuard 결과 (requireMember)
 * @returns {Promise<{ batchId: string, resumed: boolean }>}  실패 시 AppError throw
 */
export async function ensureBatch(db, guard, { sourceId, targetMonth, fileHash, fileName }) {
  if (!RE_MONTH.test(targetMonth ?? '')) throw new TypeError('대상 달은 YYYY-MM-01이어야 합니다');
  if (!RE_HASH.test(fileHash ?? '')) throw new TypeError('파일 해시 형식이 맞지 않습니다');
  const find = () => db.select('import_batches', {
    columns: 'id',
    filters: [{ col: 'source_id', op: 'eq', value: sourceId }, { col: 'file_hash', op: 'eq', value: fileHash }],
  });
  const found = await find();
  if (found.error) throw found.error;
  if (found.data?.[0]) return { batchId: found.data[0].id, resumed: true };

  const { memberId } = await guard.requireMember(); // 구성원이 아니면 여기서 throw
  const made = await db.insert('import_batches', {
    source_id: sourceId, target_month: targetMonth, file_name: fileName, file_hash: fileHash, uploaded_by: memberId,
  });
  if (!made.error && made.data?.[0]) return { batchId: made.data[0].id, resumed: false };
  // 동시에 같은 파일을 올려 유니크 위반이 났으면 다시 찾는다
  if (made.error?.code === 'duplicate') {
    const again = await find();
    if (!again.error && again.data?.[0]) return { batchId: again.data[0].id, resumed: true };
  }
  throw made.error ?? new AppError('unknown', '잠시 후 다시 시도해 주세요');
}

/**
 * 행을 200행씩 보낸다
 * @param rows normalizeRows 결과 rows (rowNo 포함)
 * @returns {Promise<{ counts: object, failures: {rowNo:number, result:string, sqlState:string|null}[],
 *                     notices: {rowNo:number, kind:'refund_amount_changed', oldAmount:number, newAmount:number}[],
 *                     noticeCheckFailed: boolean, sentRows: number, error: AppError|null }>}
 *   failures: inserted·duplicate가 아닌 행 + 자동 환불 연결 실패(inserted, detail LG003)
 */
export async function uploadRows(db, batchId, rows, { chunkRows = CHUNK_ROWS, onProgress } = {}) {
  const counts = Object.fromEntries(RESULTS.map((r) => [r, 0]));
  const failures = [];
  const dupRefunds = []; // { rowNo, txnId, amount }
  let sentRows = 0;
  for (let i = 0; i < rows.length; i += chunkRows) {
    const part = rows.slice(i, i + chunkRows);
    const { data, error } = await db.rpc('import_transactions', { p_batch_id: batchId, p_rows: toRpcRows(part) });
    if (error) return { counts, failures, notices: [], noticeCheckFailed: false, sentRows, error };
    for (const r of data ?? []) {
      const src = part[r.row_no - 1];
      const result = RESULTS.includes(r.result) ? r.result : 'invalid';
      counts[result]++;
      const sqlState = typeof r.detail === 'string' && /^[0-9A-Z]{5}$/.test(r.detail) ? r.detail : null;
      if (result === 'duplicate' && src?.kind === 'refund' && typeof r.txn_id === 'string') {
        dupRefunds.push({ rowNo: src.rowNo ?? null, txnId: r.txn_id, amount: src.amount });
      }
      if (result !== 'inserted' && result !== 'duplicate') failures.push({ rowNo: src?.rowNo ?? null, result, sqlState });
      else if (result === 'inserted' && sqlState === 'LG003') failures.push({ rowNo: src?.rowNo ?? null, result: 'refund_unlinked', sqlState });
    }
    sentRows += part.length;
    onProgress?.({ sentRows, total: rows.length });
  }
  const { notices, failed } = await refundAmountNotices(db, dupRefunds);
  return { counts, failures, notices, noticeCheckFailed: failed, sentRows, error: null };
}

/** duplicate 환불의 DB 금액과 새 파일 금액 대조 (조회 실패는 업로드 결과를 막지 않고 failed로 알린다) */
async function refundAmountNotices(db, dupRefunds) {
  const notices = [];
  for (let i = 0; i < dupRefunds.length; i += LOOKUP_IDS) {
    const part = dupRefunds.slice(i, i + LOOKUP_IDS);
    const { data, error } = await db.select('transactions', {
      columns: 'id,amount',
      filters: [{ col: 'id', op: 'in', value: part.map((d) => d.txnId) }],
    });
    if (error) return { notices, failed: true };
    const amounts = new Map((data ?? []).map((t) => [t.id, Number(t.amount)]));
    for (const d of part) {
      const old = amounts.get(d.txnId);
      if (old !== undefined && old !== d.amount) {
        notices.push({ rowNo: d.rowNo, kind: 'refund_amount_changed', oldAmount: old, newAmount: d.amount });
      }
    }
  }
  return { notices, failed: false };
}
