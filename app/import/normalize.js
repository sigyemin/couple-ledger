// =====================================================================
// 행 정규화: 셀 문자열 → import_transactions RPC 행 (스키마 import_formats 주석 "파서 규칙", 4장 중복 키)
// - 매핑한 열만 읽는다(P3). sensitive_headers 열·매핑 안 한 열은 읽지 않는다
// - 날짜(일시) 칸이 형식대로 읽히지 않는 줄(합계 등 꼬리 줄)은 버린다
// - 금액: 쉼표·공백·'원'을 지우고 정수만. 소수점 등은 행 오류
// - 방향·금액: amount_sign
//     split_columns    = 출금(amount_out) > 0 → out, 입금(amount_in) > 0 → in, 둘 다 없으면 행 오류
//     expense_negative = amount < 0 → out, > 0 → in, 0·빈 값은 행 오류
//     expense_positive = amount > 0 → out. 음수·0원은 행 오류(카드는 모두 양수가 정의, 취소는 상태 열 규칙으로만)
//   direction(입금/출금 구분) 열이 매핑돼 있으면 정한 방향과 대조해 다르면 행 오류
// - 제안 순서: row_rules(위에서 첫 일치) → 통장이면 이체 상대 규칙(counterparty_rules, priority 작은 것부터)
//   → 기본값(out → expense, in → income)
// - 카드 취소(also_refund): 환불 금액 칸(refund_amount_key)이 정해져 있는데 비었거나 0이면 행 오류
// - 모든 글자 칸은 민감번호 규칙으로 가린다('[숫자 가림]', 붙여 쓴 일시 단계는 끈 보수적 검사)
// - 승인번호가 형식(영숫자 4~12자, 숫자 10개 연속 금지)에 맞지 않으면 행 오류
// - 검토 상태는 needs_review. 단 가맹점 규칙(확정)으로 분류된 지출·수입 행은 confirmed(사용자 결정 U-16·Q3)
// - 가맹점 규칙(category_rules)은 형식 행 규칙·이체 상대 규칙으로 분류되지 않은 지출·환불·수입 행(집계 제외 빼고)에만,
//   DB reapply_category_rule과 같은 일치·순서로. 환불은 분류만 하고 검토 대기 그대로(v_unlinked_refunds가 검토 대기 환불만 봄)
// - 통장 행이 행 규칙·이체 상대 규칙 어디에도 안 맞으면 newCounterparty = true + merchantVariant(가림 전 설명의 파일 안 번호)
//   둘 다 화면 표시용이라 RPC로는 안 보낸다(toRpcRows)
// - 한 파일 안에서 같은 1순위 키(결제수단|승인번호|kind)가 두 번째로 나오면 그 행은 행 오류(duplicate_key)
//   1순위 키에 n번째·금액을 넣지 않는다(설계 확인 D2). 조용히 버리지 않고 미리보기에 보인다
// - 2순위 키의 일시는 분 단위(YYYY-MM-DD HH:MI). 초는 키에서 뺀다(저장하는 시각은 그대로, 사용자 결정 D1)
// 결과에는 셀 원문(가리기 전 값)을 담지 않는다.
// 의존: core/sensitive.js, ./datetime.js, ./formats.js, ./dedup.js
// =====================================================================
import { maskSensitiveNumbers, approvalNoValid } from '../core/sensitive.js';
import { compileFormat, parseWith } from './datetime.js';
import { matchNorm } from './formats.js';
import { primaryKey, secondaryPrefix, hashKey } from './dedup.js';

// raw에 넣는 표준 키(DB raw_key_list와 같음). balance_after는 키 전용이라 raw에 넣지 않는다
export const RAW_KEYS = Object.freeze([
  'occurred_on', 'occurred_time', 'occurred_at', 'merchant', 'amount', 'amount_out', 'amount_in',
  'direction', 'txn_type', 'approval_no', 'installment', 'counterparty',
  'status', 'cancel_amount', 'amount_foreign', 'counterparty_bank',
]);
const DATE_KEYS = new Set(['occurred_on', 'occurred_time', 'occurred_at']);
const CARD_KINDS = new Set(['credit_card', 'check_card']);
const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD[ HH24:MI[:SS]]';

/** 금액 문자열 → 정수 (빈 값 null, 형식 오류 NaN) */
export function parseAmount(v) {
  const s = String(v ?? '').normalize('NFKC').replace(/[, \t원]/g, '');
  if (!s) return null;
  if (!/^[+-]?[0-9]{1,15}$/.test(s)) return Number.NaN;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : Number.NaN;
}

/** 할부 개월 수: '3', '3개월'처럼 2 이상 숫자만. 그 밖(일시불 등)은 null [추정: 실제 표기는 QA가 확인] */
export function parseInstallment(v) {
  const m = /^([0-9]{1,2})(개월)?$/.exec(String(v ?? '').normalize('NFKC').replace(/[ \t]/g, ''));
  const n = m ? Number(m[1]) : 0;
  return n >= 2 ? n : null;
}

/** row_rules에서 처음 맞는 규칙 (없으면 null) */
export function matchRowRule(rules, cell, direction) {
  for (const rule of rules ?? []) {
    if (rule.direction && rule.direction !== direction) continue;
    const field = cell(rule.field);
    if (rule.match === 'any') return rule;
    if (field === null) continue;
    const a = matchNorm(field);
    const b = matchNorm(rule.value);
    if (rule.match === 'exact' ? a === b : a.includes(b)) return rule;
  }
  return null;
}

const DIRECTION_WORDS = new Map([['출금', 'out'], ['입금', 'in']]);

/** 방향 열 값 → out / in (모르는 값은 null) */
export function parseDirection(v) {
  return DIRECTION_WORDS.get(matchNorm(v)) ?? null;
}

/**
 * 이체 상대 규칙에서 처음 맞는 규칙 (DB counterparty_rule_matches와 같은 조건).
 * rules는 서버가 정렬해 준 순서(order by priority, created_at, id — DB apply_counterparty_rule의 앞선 규칙 판정과 같음) 그대로 쓴다.
 * 앱에서 시각 글자를 다시 비교하지 않는다(소수 자리·마이크로초 차이로 순서가 틀어짐 — CL-046)
 * 제안 종류가 방향과 안 맞는 규칙(출금 → 수입, 입금 → 지출, 환불 제안)은 건너뛴다(apply_counterparty_rule과 같은 판단)
 */
export function matchCounterpartyRule(rules, { sourceId, direction, txnType, merchantRaw, counterparty }) {
  for (const r of rules ?? []) {
    if (r.is_active === false) continue;
    const text = matchNorm(r.match_text);
    if (!text) continue;
    if (r.source_id && r.source_id !== sourceId) continue;
    if (r.direction && r.direction !== direction) continue;
    if (r.txn_type && matchNorm(r.txn_type) !== matchNorm(txnType)) continue;
    const target = matchNorm(r.match_field === 'counterparty' ? counterparty : merchantRaw);
    if (r.match_type === 'contains' ? !target.includes(text) : target !== text) continue;
    const k = r.suggested_kind;
    if (k === 'refund' || (k === 'income' && direction === 'out') || (k === 'expense' && direction === 'in')) continue;
    return r;
  }
  return null;
}

/**
 * 가맹점 규칙 하나가 설명(merchant_norm)에 맞는지 — DB category_rule_matches와 같은 판정(contains·exact).
 * 비활성은 맞지 않음. regex는 브라우저에서 실행하지 않는다(null = 판정 안 함)
 */
export function categoryRuleMatches(rule, merchantNorm) {
  if (!rule || rule.is_active === false) return false;
  if (rule.match_type === 'regex') return null;
  const p = matchNorm(rule.pattern);
  const m = matchNorm(merchantNorm);
  if (rule.match_type === 'exact') return m === p;
  return p !== '' && m.includes(p);
}

/**
 * 업로드 행에 붙일 가맹점 규칙(사용자 결정 U-16 A안): 순서대로 처음 맞는 규칙.
 * 순서는 서버가 정렬해 준 그대로 쓴다(select … order by priority, created_at, id — DB reapply의 앞선 규칙 판정과 같은 순서).
 * 그 규칙의 카테고리가 꺼졌거나 없으면 분류하지 않는다(DB도 그 규칙은 재적용 불가, 뒤 규칙은 skipped_priority — 설계 v0.2 3-6)
 * regex 규칙은 브라우저에서 판정하지 않는다. 맞는 규칙보다 앞에 regex 규칙이 있으면 결과를 알 수 없으므로 분류하지 않는다
 * (업로드와 DB 재적용 결과가 달라지지 않게) → { blocked: 'regex' }
 * @param rules 정렬된 켜진 규칙들 { pattern, match_type, category_id, is_ambiguous, categoryActive }
 * @returns {{ category_id, source: 'rule'|'suggestion' } | { blocked: 'regex' } | null}
 */
export function pickCategoryRule(rules, merchantNorm) {
  for (const r of rules ?? []) {
    const hit = categoryRuleMatches(r, merchantNorm);
    if (hit === null) return { blocked: 'regex' };
    if (hit === false) continue;
    if (!r.category_id || r.categoryActive === false) return null;
    return { category_id: r.category_id, source: r.is_ambiguous ? 'suggestion' : 'rule' };
  }
  return null;
}

function decideAmount(sign, cell) {
  if (sign === 'split_columns') {
    const out = parseAmount(cell('amount_out'));
    const inn = parseAmount(cell('amount_in'));
    if (Number.isNaN(out) || Number.isNaN(inn)) return null;
    if (out > 0 && !(inn > 0)) return { direction: 'out', amount: out };
    if (inn > 0 && !(out > 0)) return { direction: 'in', amount: inn };
    return null;
  }
  const a = parseAmount(cell('amount'));
  if (a === null || Number.isNaN(a)) return null;
  if (sign === 'expense_negative') {
    if (a === 0) return null;
    return a < 0 ? { direction: 'out', amount: -a } : { direction: 'in', amount: a };
  }
  return a > 0 ? { direction: 'out', amount: a } : null; // expense_positive: 음수·0원은 정의 밖
}

/**
 * @param {string[][]} grid
 * @param {object} format   import_formats 행
 * @param {{ headerIndex: number, columns: Map<string, number> }} header  findHeader 결과
 * @param {{ sourceId: string, categories?: Map<string, string>, counterpartyRules?: object[] }} ctx
 *   categories: category code → id, counterpartyRules: 활성 이체 상대 규칙 행(통장 형식에만 적용)
 * @returns {Promise<{ rows: object[], errors: {rowNo:number, reason:string}[], skipped: number, maskedCells: number }>}
 *   rows: RPC 행 + rowNo(파일 줄 번호, 1부터. RPC에 보낼 때는 뺀다)
 */
export async function normalizeRows(grid, format, header, ctx) {
  const { sourceId, categories = new Map() } = ctx ?? {};
  const merchantRules = Array.isArray(ctx?.categoryRules) ? ctx.categoryRules : [];
  // 가맹점 규칙(U-16): 형식 행 규칙·이체 상대 규칙으로 분류되지 않은 지출·환불·수입 행에만(이체·집계 제외는 건너뜀).
  // 확정 규칙 → 출처 rule, 지출·수입은 확인함(Q3) / 모호 규칙 → 출처 suggestion. 환불은 검토 대기 그대로
  const applyMerchantRule = (row) => {
    if (row.category_id || row.is_excluded || !['expense', 'refund', 'income'].includes(row.kind)) return;
    const hit = pickCategoryRule(merchantRules, row.merchant_norm);
    if (!hit) return;
    if (hit.blocked) { row.merchantRule = 'regex'; return; }
    row.category_id = hit.category_id;
    row.category_source = hit.source;
    if (hit.source === 'rule' && row.kind !== 'refund') row.review_status = 'confirmed';
    row.merchantRule = hit.source;
  };
  const cpRules = format.kind === 'bank_account' && Array.isArray(ctx?.counterpartyRules) ? ctx.counterpartyRules : [];
  if (typeof sourceId !== 'string' || !sourceId) throw new TypeError('결제수단 id가 필요합니다');
  const dateFmt = compileFormat(format.date_format || DEFAULT_DATE_FORMAT);
  const timeFmt = format.time_format ? compileFormat(format.time_format) : null;
  const isCard = CARD_KINDS.has(format.kind);
  const rules = Array.isArray(format.row_rules) ? format.row_rules : [];
  const { columns } = header;

  const rows = [];
  const errors = [];
  let skipped = 0;
  let maskedCells = 0;
  const seen = new Map(); // 2순위 앞부분 → 개수
  const primarySeen = new Set(); // 이 파일에서 나온 1순위 키
  const merchantVariants = new Map(); // 가림 전 설명 → 번호(이 파일 안에서만, 원문은 밖으로 안 나감)

  for (let r = header.headerIndex + 1; r < grid.length; r++) {
    const line = grid[r] ?? [];
    const rowNo = r + 1;
    const cell = (key) => {
      const i = columns.get(key);
      if (i === undefined) return null;
      const v = String(line[i] ?? '').trim();
      return v === '' ? null : v;
    };

    // 일시
    let when = null;
    if (columns.has('occurred_at')) {
      when = parseWith(dateFmt, cell('occurred_at'));
    } else if (columns.has('occurred_on')) {
      const d = parseWith(dateFmt, cell('occurred_on'));
      if (d?.date) {
        const t = timeFmt && cell('occurred_time') !== null ? parseWith(timeFmt, cell('occurred_time')) : null;
        when = { date: d.date, time: t?.time ?? d.time ?? null };
      }
    }
    if (!when?.date) {
      skipped++; // 꼬리 줄(합계 등)·빈 줄
      continue;
    }

    const money = decideAmount(format.amount_sign, cell);
    if (!money) {
      errors.push({ rowNo, reason: 'amount' });
      continue;
    }
    if (columns.has('direction') && parseDirection(cell('direction')) !== money.direction) {
      errors.push({ rowNo, reason: 'direction' });
      continue;
    }

    let approvalNo = cell('approval_no');
    if (approvalNo !== null) {
      approvalNo = approvalNo.normalize('NFKC');
      if (!approvalNoValid(approvalNo)) {
        errors.push({ rowNo, reason: 'approval_no' });
        continue;
      }
    }

    // raw: 매핑한 표준 키만, 글자는 가린 값
    const raw = {};
    for (const key of RAW_KEYS) {
      const v = cell(key);
      if (v === null) continue;
      if (key === 'approval_no') {
        raw[key] = approvalNo;
        continue;
      }
      const masked = maskSensitiveNumbers(v, DATE_KEYS.has(key) ? undefined : { packedDateTime: false });
      if (masked !== v.normalize('NFKC')) maskedCells++;
      raw[key] = masked;
    }

    const merchantRaw = raw.merchant ?? '';
    const merchantNorm = matchNorm(merchantRaw);
    const rule = matchRowRule(rules, cell, money.direction);
    // 카드 취소: 환불 금액 칸이 정해져 있는데 비었거나 0·형식 오류면 행 오류(부분취소를 전액 환불로 잡지 않게)
    let refundAmount = null;
    if (rule?.also_refund) {
      if (rule.refund_amount_key) {
        const v = parseAmount(cell(rule.refund_amount_key));
        if (v === null || Number.isNaN(v) || v === 0) {
          errors.push({ rowNo, reason: 'refund_amount' });
          continue;
        }
        refundAmount = Math.abs(v);
      } else {
        refundAmount = money.amount;
      }
    }
    const cp = rule ? null : matchCounterpartyRule(cpRules, {
      sourceId, direction: money.direction, txnType: cell('txn_type'), merchantRaw, counterparty: raw.counterparty ?? '',
    });

    const kind = rule?.kind ?? cp?.suggested_kind ?? (money.direction === 'out' ? 'expense' : 'income');
    const excludeReason = rule ? (rule.exclude_reason ?? null) : kind === 'transfer' ? (cp?.suggested_exclude_reason ?? null) : null;
    const base = {
      occurred_on: when.date,
      occurred_time: when.time,
      merchant_raw: merchantRaw,
      merchant_norm: merchantNorm,
      amount: money.amount,
      kind,
      card_kind: rule?.card_kind ?? (format.kind === 'credit_card' ? 'credit_card' : null),
      approval_no: approvalNo,
      installment_months: parseInstallment(cell('installment')),
      is_shared: rule?.is_shared ?? (kind === 'expense' ? cp?.suggested_is_shared : null) ?? true,
      is_excluded: excludeReason !== null,
      exclude_reason: excludeReason,
      review_status: 'needs_review',
      raw,
      category_id: rule?.category_code ? (categories.get(rule.category_code) ?? null)
        : cp?.suggested_category_id && (kind === 'expense' || kind === 'income') ? cp.suggested_category_id : null,
    };
    if (base.category_id) base.category_source = 'rule';
    applyMerchantRule(base);
    // 통장 행인데 행 규칙·이체 상대 규칙에 안 맞았으면 "새 이체 상대" 후보(화면 4-2 ②). RPC로는 보내지 않는다(toRpcRows가 뺌)
    if (format.kind === 'bank_account' && !rule && !cp) {
      base.newCounterparty = true;
      // 숫자 가림으로 서로 다른 설명이 같은 값이 될 수 있어, 가림 전 값의 번호만 붙인다(화면이 "N개가 같아졌어요"를 셈)
      const original = String(cell('merchant') ?? '').normalize('NFKC');
      if (!merchantVariants.has(original)) merchantVariants.set(original, merchantVariants.size);
      base.merchantVariant = merchantVariants.get(original);
    }
    if (base.card_kind && !['expense', 'refund'].includes(kind)) base.card_kind = null;

    const occurredAt = when.time ? `${when.date} ${when.time.slice(0, 5)}` : when.date; // 분 단위
    const balance = (() => {
      const b = cell('balance_after');
      if (b === null) return '';
      const n = parseAmount(b);
      return n === null || Number.isNaN(n) ? matchNorm(b) : String(n);
    })();

    const variants = [{ ...base, direction: money.direction }];
    // 카드 취소 행: 원거래(지출)와 같은 승인번호의 환불 행 두 개 (원거래를 먼저)
    if (rule?.also_refund) {
      const refund = { ...base, kind: 'refund', amount: refundAmount, is_excluded: false, exclude_reason: null, direction: 'in' };
      // 원거래에 붙인 가맹점 규칙 결과는 떼고 환불 행으로 다시 판정(환불은 확인함으로 바꾸지 않음)
      if (refund.merchantRule) {
        if (refund.merchantRule !== 'regex') { refund.category_id = null; delete refund.category_source; }
        delete refund.merchantRule;
        refund.review_status = 'needs_review';
      }
      applyMerchantRule(refund);
      variants.push(refund);
    }

    const usesPrimary = (v) => isCard && approvalNo && (v.kind === 'expense' || v.kind === 'refund');
    const primaries = variants.filter(usesPrimary).map((v) => primaryKey({ sourceId, approvalNo, kind: v.kind }));
    if (primaries.some((k) => primarySeen.has(k))) {
      errors.push({ rowNo, reason: 'duplicate_key' });
      continue;
    }
    primaries.forEach((k) => primarySeen.add(k));

    for (const v of variants) {
      const { direction, ...row } = v;
      let keyString;
      if (usesPrimary(row)) {
        keyString = primaryKey({ sourceId, approvalNo, kind: row.kind });
        row.row_seq = 1;
      } else {
        const prefix = secondaryPrefix({ sourceId, direction, occurredAt, merchantNorm, amount: row.amount, balanceAfter: balance });
        const n = (seen.get(prefix) ?? 0) + 1;
        seen.set(prefix, n);
        keyString = `${prefix}|${n}`;
        row.row_seq = n;
      }
      row.dedup_key = await hashKey(keyString);
      rows.push({ rowNo, ...row });
    }
  }
  return { rows, errors, skipped, maskedCells };
}

/** RPC로 보낼 모양(rowNo·화면용 표시 newCounterparty·merchantVariant·merchantRule 제거) */
export function toRpcRows(rows) {
  return rows.map(({ rowNo, newCounterparty, merchantVariant, merchantRule, ...r }) => r);
}
