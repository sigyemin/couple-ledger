// =====================================================================
// 통장에 찍히는 이름 · 통장끼리 이체 짝 — 화면 없이 계산하는 부분 (v0.23 CL-077, 설계 current/2026-11-17-설계-v0.23.md)
// - 이름 검사는 DB CHECK(ck_mtn_pattern·ck_mtn_contains_len)와 같게: 원문 30자 이하, 정리값 2~20자, 한글·영문 1자 이상,
//   10자리 이상 숫자 금지, '다른 글자와 붙어 찍힘'(contains)은 정리값 3자 이상
// - 이름(원문)은 화면에만 — 기록·주소·콘솔·p_description에 넣지 않는다
// 의존: import/formats.js(matchNorm), core/sensitive.js, core/format.js
// =====================================================================
import { matchNorm } from '../import/formats.js';
import { hasSensitiveNumber } from '../core/sensitive.js';
import { won, day } from '../core/format.js';

export const MATCH_TYPES = Object.freeze([
  ['exact', '정확히(칸 전체가 이 이름)'],
  ['contains', '다른 글자와 붙어 찍힘(이 이름이 들어 있으면)'],
]);
export const CONTAINS_HINT = "실제 통장에는 '은행 이름 + 이름 + 숫자'처럼 다른 글자와 붙어 찍히는 경우가 많아요. 그렇게 찍히면 '다른 글자와 붙어 찍힘'을 고르세요(3글자 이상).";

/**
 * 입력 → member_transfer_names 행. 못 넣으면 { ok:false, message }
 * @param {{ pattern: string, matchType: 'exact'|'contains' }} form
 */
export function checkName(form, memberId) {
  const pattern = String(form.pattern ?? '').normalize('NFKC').trim();
  const norm = matchNorm(pattern);
  const matchType = form.matchType === 'contains' ? 'contains' : 'exact';
  if (!pattern) return { ok: false, message: '이름을 넣어 주세요' };
  if (pattern.length > 30) return { ok: false, message: '30글자까지 넣을 수 있어요' };
  if (norm.length < 2 || norm.length > 20) return { ok: false, message: '띄어쓰기를 빼고 2~20글자로 넣어 주세요' };
  if (!/[가-힣A-Za-z]/.test(norm)) return { ok: false, message: '한글이나 영문이 한 글자 이상 있어야 해요' };
  if (hasSensitiveNumber(pattern)) return { ok: false, message: '계좌번호처럼 보이는 긴 숫자는 넣을 수 없어요' };
  if (matchType === 'contains' && norm.length < 3) return { ok: false, message: "'다른 글자와 붙어 찍힘'은 3글자 이상일 때만 고를 수 있어요(짧으면 가게 이름에 걸려요)" };
  return { ok: true, row: { member_id: memberId, pattern, match_type: matchType } };
}

/** 저장 오류 → 안내(23505 이미 등록, 23514 규칙 위반). 이름은 넣지 않는다 */
export function nameErrorText(err) {
  const s = err?.detail?.sqlState;
  if (s === '23505') return '이미 등록된 이름이에요(두 사람 중 누군가가 같은 이름을 등록했어요).';
  if (s === '23514') return '2글자 이상, 한글·영문 포함, 숫자 10자리 금지예요(다른 글자와 붙어 찍힘은 3글자 이상).';
  return null;
}

/** 이름 목록 → 사람별(자리 순) { id, name, mine, rows } */
export function namesByMember(rows, members, meId) {
  return [...(members ?? [])].sort((a, b) => a.member_slot - b.member_slot).map((m) => ({
    id: m.id, name: m.display_name, mine: m.id === meId,
    rows: (rows ?? []).filter((r) => r.member_id === m.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))),
  }));
}

const NAME_RESULTS = ['updated', 'skipped_counterparty_rule', 'skipped_edited', 'skipped_has_refund', 'skipped_ambiguous'];

/** apply_member_name_transfers 결과 행 → 결과별 건수(+ 바뀜 중 내 계좌 이동·두 사람 간 송금) */
export function nameApplySummary(rows) {
  const s = Object.fromEntries(NAME_RESULTS.map((k) => [k, 0]));
  let internal = 0;
  let personal = 0;
  for (const r of rows ?? []) {
    if (r.result in s) s[r.result] += 1;
    if (r.result === 'updated') {
      if (r.new_exclude_reason === 'internal_transfer') internal += 1;
      else if (r.new_exclude_reason === 'personal_transfer') personal += 1;
    }
  }
  return { ...s, internal, personal };
}

/** 지난 거래 적용 확인 문구 */
export function nameApplyText(sum, rangeCount) {
  const parts = [`이름이 맞는 통장 거래 ${sum.updated}건을 이체로 바꿔요(내 계좌 이동 ${sum.internal} · 두 사람 간 송금 ${sum.personal}). 집계에서 빠지고 '확인함'이 돼요.`];
  if (sum.skipped_counterparty_rule) parts.push(`이체 상대 규칙이 먼저인 ${sum.skipped_counterparty_rule}건은 그대로.`);
  if (sum.skipped_edited) parts.push(`직접 고친 ${sum.skipped_edited}건은 그대로.`);
  if (sum.skipped_has_refund) parts.push(`환불이 연결된 ${sum.skipped_has_refund}건은 그대로.`);
  if (sum.skipped_ambiguous) parts.push(`두 사람 이름이 모두 맞는 ${sum.skipped_ambiguous}건은 그대로.`);
  parts.push('같은 이름의 다른 사람이 보낸 돈일 수도 있어요 — 큰 금액은 내역에서 한 번 봐 주세요.');
  return {
    title: '지난 거래에 이름 적용',
    message: parts.join(' '),
    undoNote: rangeCount > 1
      ? `거래가 많아 기간을 ${rangeCount}개로 나눠 적용해요. 변경 기록에 기간마다 하나씩 남고 각각 되돌릴 수 있어요.`
      : '변경 기록에 하나로 남아요. 더보기 › 변경 기록에서 되돌릴 수 있어요.',
  };
}

// ---------------------------------------------------------------- 통장끼리 이체 짝 (A4)

export const REASON_LABEL = Object.freeze({ internal_transfer: '내 계좌 이동', personal_transfer: '두 사람 간 송금' });

/**
 * find_internal_transfer_pairs 결과 → 화면 묶음
 * - clear: 모호하지 않은 짝(기본 체크)
 * - choose: 모호한 짝 — 출금마다 후보 입금 목록(사용자가 하나 고르거나 고르지 않음)
 * @param details Map(txn id → v_transaction_detail { occurred_on, merchant_raw, amount, source_label, payer_name })
 */
export function pairGroups(rows, details) {
  const clear = [];
  const byOut = new Map();
  for (const p of rows ?? []) {
    const item = {
      outId: p.out_txn_id, inId: p.in_txn_id, amount: Number(p.amount), reason: p.suggested_exclude_reason,
      label: REASON_LABEL[p.suggested_exclude_reason] ?? '이체', out: details.get(p.out_txn_id) ?? null, in: details.get(p.in_txn_id) ?? null,
      outOn: p.out_on, inOn: p.in_on,
    };
    if (!p.is_ambiguous) { clear.push(item); continue; }
    if (!byOut.has(p.out_txn_id)) byOut.set(p.out_txn_id, []);
    byOut.get(p.out_txn_id).push(item);
  }
  const byDate = (a, b) => String(a.outOn).localeCompare(String(b.outOn)) || String(a.outId).localeCompare(String(b.outId));
  return {
    clear: clear.sort(byDate),
    choose: [...byOut.entries()].map(([outId, items]) => ({ outId, items: items.sort((a, b) => String(a.inOn).localeCompare(String(b.inOn))) }))
      .sort((a, b) => byDate(a.items[0], b.items[0])),
  };
}

/** 한 거래 한 줄: '10월 3일 · 시험통장 · 가짜설명' */
export function txnLine(d, on) {
  if (!d) return `${day(on)} · (불러오지 못함)`;
  return `${day(d.occurred_on ?? on)} · ${d.source_label ?? ''} · ${d.merchant_raw ?? ''}`;
}

/** 고른 짝들 → p_pairs. 같은 거래가 두 번 들어가면 뒤의 것을 뺀다(DB가 전체를 거부하지 않게) */
export function pickedPairs(items) {
  const used = new Set();
  const out = [];
  for (const it of items) {
    if (used.has(it.outId) || used.has(it.inId)) continue;
    used.add(it.outId); used.add(it.inId);
    out.push({ out_txn_id: it.outId, in_txn_id: it.inId });
  }
  return out;
}

/** 짝 확인 문구 */
export function pairApplyText(items) {
  const internal = items.filter((x) => x.reason === 'internal_transfer').length;
  const personal = items.length - internal;
  return {
    title: '통장끼리 이체로',
    message: `고른 짝 ${items.length}쌍(내 계좌 이동 ${internal} · 두 사람 간 송금 ${personal})의 출금·입금을 모두 이체로 바꿔요. 집계에서 빠지고 '확인함'이 돼요. 금액 ${won(items.reduce((s, x) => s + x.amount, 0))}.`,
    undoNote: '변경 기록에 하나로 남아요. 더보기 › 변경 기록에서 되돌릴 수 있어요.',
  };
}
