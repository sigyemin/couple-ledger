// =====================================================================
// 올리기 — 화면 없이 계산하는 부분 (화면 설계 v0.1 4-2 ①·③·④, 보정 CL-029 2판)
// - 파일 해시: import/dedup.js fileHash(SHA-256 hex). 같은 결제수단·같은 해시면 이어 올리기("빠진 행만")
// - 결제수단 맞춤: 파일 내용(헤더)이 맞는 형식 → 그 형식을 쓰는 켜진 결제수단. 1개면 자동, 여러 개면 고르기, 없으면 건너뜀
//   시험용(is_test)은 자동으로 고르지 않는다 — 하나뿐이어도 고르기로 두고 경고(실제 파일이 시험용으로 들어가면 집계에서 빠지고 일괄 삭제될 수 있음)
// - 미리보기: 새로 넣을 건수(이미 DB에 같은 중복 키가 있으면 뺌), 이미 있음, 행 오류(사유별), 꼬리 줄, 집계 제외,
//   체크카드 사용, 숫자 가림. 검토 상태는 모두 검토 대기(정규화 규칙)
// - 셀 원문은 화면에 오지 않는다(Worker가 정규화한 행·건수만 준다)
// 의존: core/format.js
// =====================================================================
import { won, month as monthLabel } from '../core/format.js';
import { matchNorm } from '../import/formats.js';
import { MASK_TEXT } from '../core/sensitive.js';

export const MAX_FILES = 12;
export const KEY_CHUNK = 100; // 중복 키 조회 한 번에 넣는 수

/**
 * 맞는 형식 id → 결제수단 후보(켜진 것만, 이름 순)
 * @returns {{ choices: {id,label,formatId,institution,isTest}[], autoId: string|null }}
 */
export function matchSources(formatIds, sources) {
  const ids = new Set(formatIds ?? []);
  const choices = (sources ?? []).filter((s) => s.is_active && s.import_format_id && ids.has(s.import_format_id))
    .sort((a, b) => Number(a.is_test) - Number(b.is_test) || String(a.label).localeCompare(String(b.label)))
    .map((s) => ({ id: s.id, label: s.is_test ? `${s.label} (시험용)` : s.label, formatId: s.import_format_id, institution: s.institution, isTest: Boolean(s.is_test) }));
  return { choices, autoId: choices.length === 1 && !choices[0].isTest ? choices[0].id : null };
}

const ROW_ERROR = {
  amount: '금액을 읽지 못함', direction: '입출금 방향이 안 맞음', approval_no: '승인번호 형식이 안 맞음',
  refund_amount: '취소 금액이 비어 있음', duplicate_key: '같은 승인번호가 두 번',
};

/**
 * 파일 하나의 미리보기 숫자
 * @param parsed Worker parse 결과 { rows, errors, skipped, maskedCells }
 * @param existingKeys DB에 이미 있는 dedup_key 집합
 */
export function previewOf(parsed, existingKeys = new Set()) {
  const rows = parsed?.rows ?? [];
  const fresh = rows.filter((r) => !existingKeys.has(r.dedup_key));
  const errs = new Map();
  for (const e of parsed?.errors ?? []) errs.set(e.reason, (errs.get(e.reason) ?? 0) + 1);
  const sum = (list) => list.reduce((s, r) => s + (r.kind === 'refund' ? -r.amount : r.amount), 0);
  return {
    newCount: fresh.length,
    dupCount: rows.length - fresh.length,
    errorCount: (parsed?.errors ?? []).length,
    errorLines: [...errs].map(([k, n]) => `${ROW_ERROR[k] ?? '읽지 못한 행'} ${n}줄`),
    errorRows: (parsed?.errors ?? []).slice(0, 20).map((e) => e.rowNo),
    skipped: parsed?.skipped ?? 0,
    excluded: fresh.filter((r) => r.is_excluded).length,
    checkCard: fresh.filter((r) => r.card_kind === 'check_card').length,
    refunds: fresh.filter((r) => r.kind === 'refund').length,
    masked: parsed?.maskedCells ?? 0,
    spendText: won(sum(fresh.filter((r) => !r.is_excluded && (r.kind === 'expense' || r.kind === 'refund')))),
  };
}

/** 미리보기 숫자 → 화면 줄 [label, value] (0인 것은 뺀다) */
export function previewLines(p) {
  const out = [];
  if (p.dupCount) out.push(['이미 들어온 행(건너뜀)', `${p.dupCount}건`]);
  if (p.excluded) out.push(['집계 제외(카드대금·이체 등)', `${p.excluded}건`]);
  if (p.checkCard) out.push(['체크카드 사용', `${p.checkCard}건`]);
  if (p.refunds) out.push(['환불', `${p.refunds}건`]);
  if (p.masked) out.push(['숫자 가림(카드·계좌번호로 보이는 칸)', `${p.masked}칸`]);
  if (p.skipped) out.push(['합계·빈 줄(읽지 않음)', `${p.skipped}줄`]);
  return out;
}

const WORKER_ERROR = {
  unsupported_file: '엑셀(xls·xlsx)이나 은행 html 파일이 아니에요',
  too_many_rows: '행이 너무 많아요(2만 줄 넘음). 기간을 나눠 내려받아 주세요',
  format_mismatch: '고른 결제수단의 파일 형식과 맞지 않아요',
  zip_too_large: '압축을 풀면 너무 커요. 파일을 다시 내려받아 주세요',
  too_big: '파일이 너무 커요(5MB 넘음)',
  timeout: '파일을 읽는 데 너무 오래 걸려요',
};

/** Worker·읽기 실패 안내. 휴대폰이면 "PC에서 다시" 한 줄을 더한다(설계 3-3) */
export function readErrorText(code, phone = false) {
  const base = WORKER_ERROR[code] ?? '파일을 읽지 못했어요';
  return phone ? `${base}. PC에서 다시 올려 주세요.` : `${base}.`;
}

/** 저장 결과 문장 */
export function resultLines(res) {
  const c = res?.counts ?? {};
  const out = [`새로 ${c.inserted ?? 0}건 넣었어요.`];
  if (c.duplicate) out.push(`이미 있던 ${c.duplicate}건은 건너뛰었어요.`);
  const bad = (c.sensitive ?? 0) + (c.invalid ?? 0) + (c.refund_invalid ?? 0);
  if (bad) out.push(`${bad}건은 넣지 못했어요(행 번호는 아래).`);
  const unlinked = (res?.failures ?? []).filter((f) => f.result === 'refund_unlinked').length;
  if (unlinked) out.push(`환불 ${unlinked}건은 원거래를 못 찾아 따로 넣었어요(월 검토에서 확인).`);
  for (const n of res?.notices ?? []) {
    if (n.kind === 'refund_amount_changed') out.push(`${n.rowNo}행: 이미 있는 환불 금액 ${won(n.oldAmount)}과 파일 값 ${won(n.newAmount)}이 달라요. 거래를 확인해 주세요.`);
  }
  if (res?.noticeCheckFailed) out.push('환불 금액 대조를 하지 못했어요.');
  if (res?.error) out.push(`${res.sentRows ?? 0}행까지 보내고 멈췄어요. 같은 파일을 다시 올리면 이어서 넣어요.`);
  return out;
}

/** 넣지 못한 행 번호 (최대 20개) */
export function failedRows(res) {
  return (res?.failures ?? []).filter((f) => f.result !== 'refund_unlinked').slice(0, 20).map((f) => f.rowNo).filter((n) => n != null);
}

/**
 * 새 이체 상대 묶음(v0.1 4-2 ②): 통장 행 중 규칙에 안 맞은 행(newCounterparty)을 (방향, 설명 정리값)으로 묶는다. 건수 많은 순
 * 방향은 정규화 기본값에서 온다(규칙이 없으면 out → 지출, in → 수입)
 * variantCount = 가림 전 설명이 몇 가지였는지(2 이상이면 숫자 가림으로 서로 다른 설명이 한 카드가 됨 — 경고, 리뷰 PR #30)
 * ruleAllowed = 가림 표시를 빼고 2글자 이상일 때만 규칙을 만들 수 있다(너무 넓은 규칙 방지)
 * @returns {{ key, text, direction, count, totalText, variantCount, ruleAllowed }[]}
 */
export function counterpartyGroups(rows) {
  const groups = new Map();
  for (const r of rows ?? []) {
    if (!r.newCounterparty) continue;
    const norm = matchNorm(r.merchant_raw);
    if (!norm) continue;
    const direction = r.kind === 'income' ? 'in' : 'out';
    const key = `${direction}|${norm}`;
    const g = groups.get(key) ?? { key, text: r.merchant_raw, direction, count: 0, total: 0, variants: new Set() };
    g.count += 1;
    g.total += r.amount;
    g.variants.add(r.merchantVariant ?? 0);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.total - a.total || a.text.localeCompare(b.text))
    .map(({ total, variants, ...g }) => ({
      ...g, totalText: won(total), variantCount: variants.size,
      ruleAllowed: [...matchNorm(g.text.split(MASK_TEXT).join(''))].length >= 2,
    }));
}

/** 고른 값 → 규칙 행(기본 범위 = 그 통장 + 같은 방향, 이름이 똑같으면). 미리보기용 draft는 id·created_at을 앞에 둬 기존 규칙보다 뒤에 온다 */
export function counterpartyRule(group, sourceId, values, alias = null) {
  return {
    match_field: 'merchant', match_text: group.text, match_type: 'exact', source_id: sourceId, direction: group.direction,
    alias, ...values,
  };
}
export function draftRule(rule, n) {
  return { ...rule, id: `draft-${n}`, txn_type: null, priority: 100, is_active: true, created_at: '9999-12-31T00:00:00Z' };
}

/**
 * 결제수단 고르기 반영. 빈 값으로 되돌리면 고른 결제수단·미리보기를 지우고 '고르기' 상태(저장 불가)로 — PR #29 재리뷰
 * @returns {'prepare'|'cleared'}
 */
export function applySourceChoice(f, value) {
  f.result = null;
  if (!value) {
    Object.assign(f, { sourceId: null, parsed: null, preview: null, cards: [], state: 'choose' });
    return 'cleared';
  }
  f.sourceId = value;
  return 'prepare';
}

/**
 * 저장한 파일에 체크카드 취소(환불)가 있으면 그 이용일의 달들(최대 3, 오래된 달부터) — 저장 뒤 연결 제안 수를 셀 달 (CL-042)
 * 미연결 환불의 귀속월은 이용일의 달이다
 */
export function checkCancelMonths(savedFiles, max = 3) {
  const months = new Set();
  for (const f of savedFiles ?? []) {
    for (const r of f.parsed?.rows ?? []) if (r.kind === 'refund' && r.card_kind === 'check_card') months.add(`${String(r.occurred_on).slice(0, 7)}-01`);
  }
  return [...months].sort().slice(0, max);
}

/** 올리기 결과의 연결 제안 한 줄 */
export function suggestLineText(counts) {
  const total = counts.reduce((s, c) => s + c.count, 0);
  if (!total) return null;
  const first = counts.find((c) => c.count > 0);
  return { text: `체크카드 취소 연결 제안 ${total}건이 있어요. 월 검토에서 연결해요.`, month: first.month };
}

export const TEST_SOURCE_WARNING = '시험용 결제수단이에요(집계 제외, 나중에 일괄 삭제됨). 실제 파일이면 다른 결제수단을 골라 주세요.';

export const monthTitle = (m) => `${monthLabel(m).replace(/^[0-9]+년 /, '')} 파일`;
