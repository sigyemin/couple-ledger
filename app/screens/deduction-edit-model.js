// =====================================================================
// 거래 상세 · 카테고리의 연말정산 칸 — 화면 없이 계산하는 부분 (CL-062 ② E3·E4)
// - 거래: transactions.deduction_kind(사람이 고친 공제 항목, null = 자동), beneficiary_member_id(의료비 대상자, null = 결제수단 주인)
// - 자동 판정(v_deduction_txn): 거래에서 고친 값 → 결제 매체 없음(이체·현금) = none → 카테고리 기본값 → 결제 매체
// - 카테고리: default_deduction_kind(카드로 냈을 때 기본 공제 항목, null = 결제수단 따라), tax_credit_kind(세액공제 항목)
// - 공제 구분·대상자는 정산 값이 아니라 '확인 후 변경됨'에 잡히지 않는다(설계 4장)
// 의존 없음
// =====================================================================

export const TXN_KINDS = Object.freeze([
  ['credit_card', '신용카드(15%)'], ['check_card', '체크카드(30%)'], ['cash_receipt', '현금영수증(30%)'],
  ['public_transit', '대중교통(40%)'], ['traditional_market', '전통시장(40%)'], ['culture', '문화체육(도서·공연·체육시설 30%)'],
  ['excluded', '공제 제외(공과금·통신·보험·해외 등)'], ['none', '공제 대상 아님(이체·현금 등)'],
]);
export const CATEGORY_KINDS = Object.freeze([
  ['public_transit', '대중교통'], ['traditional_market', '전통시장'], ['culture', '문화체육'], ['excluded', '공제 제외'],
]);
export const TAX_CREDIT_KINDS = Object.freeze([['medical', '의료비'], ['rent', '월세'], ['insurance', '보험료']]);

const LABEL = new Map([...TXN_KINDS.map(([k, l]) => [k, l.replace(/\(.*\)$/, '')]), ['none', '공제 대상 아님']]);
export const kindLabel = (k) => LABEL.get(k) ?? '-';

/** 이 거래에 연말정산 칸을 보일까: 지출·환불, 휴지통·집계 제외·시험 결제수단 아님 */
export function canEditDeduction(row) {
  return row != null && (row.kind === 'expense' || row.kind === 'refund') && row.deleted_at == null && !row.is_excluded && !row.is_test_source;
}

/**
 * 지금 판정 글. parts = v_deduction_txn 행(이 거래, 라인 카테고리별 몫)
 * @returns {{ text, medical: boolean, beneficiaryId: string|null }}
 */
export function autoView(parts) {
  const list = parts ?? [];
  if (!list.length) return { text: '판정 없음(금액 0 또는 대상 아님)', medical: false, beneficiaryId: null };
  const kinds = [...new Set(list.map((p) => p.deduction_kind))];
  const text = kinds.length === 1 ? kindLabel(kinds[0]) : `${kinds.map(kindLabel).join(' · ')}(나눈 금액마다)`;
  const med = list.find((p) => p.tax_credit_kind === 'medical');
  return { text, medical: Boolean(med), beneficiaryId: med?.beneficiary_member_id ?? null };
}

/**
 * 고친 값 → transactions update 값(바뀐 칸만 + updated_by). 바뀐 게 없으면 null
 * @param cur { deduction_kind, beneficiary_member_id } (transactions 행)
 * @param form { kind: '' | 공제 항목, beneficiary: '' | member id }  '' = 자동·결제수단 주인
 */
export function deductionPatch(cur, form, memberId) {
  const patch = {};
  const kind = form.kind || null;
  if (kind !== null && !TXN_KINDS.some(([k]) => k === kind)) return null;
  if (kind !== (cur?.deduction_kind ?? null)) patch.deduction_kind = kind;
  if ('beneficiary' in form) {
    const ben = form.beneficiary || null;
    if (ben !== (cur?.beneficiary_member_id ?? null)) patch.beneficiary_member_id = ben;
  }
  if (!Object.keys(patch).length) return null;
  patch.updated_by = memberId;
  return patch;
}

/** 대상자 안내: 결제수단 주인과 다른 사람이면 공제 안 될 수 있음 */
export function beneficiaryNote(beneficiaryId, ownerId, members) {
  if (!beneficiaryId || beneficiaryId === ownerId) return null;
  const name = (members ?? []).find((m) => m.id === beneficiaryId)?.display_name ?? '다른 사람';
  return `${name}의 의료비를 다른 사람 명의 결제수단으로 냈어요. 의료비 세액공제가 되지 않을 수 있어요(카드 소득공제는 결제수단 주인에게 들어가요).`;
}

/** 카테고리 연말정산 칸 → categories update 값(바뀐 칸만). 바뀐 게 없으면 null */
export function categoryDeductionPatch(cat, form) {
  const patch = {};
  const d = form.defaultKind || null;
  const t = form.taxCredit || null;
  if (d !== null && !CATEGORY_KINDS.some(([k]) => k === d)) return null;
  if (t !== null && !TAX_CREDIT_KINDS.some(([k]) => k === t)) return null;
  if (d !== (cat.default_deduction_kind ?? null)) patch.default_deduction_kind = d;
  if (t !== (cat.tax_credit_kind ?? null)) patch.tax_credit_kind = t;
  return Object.keys(patch).length ? patch : null;
}

/** 카테고리 줄 꼬리표: '대중교통 · 의료비' (없으면 null) */
export function categoryDeductionTag(cat) {
  const parts = [];
  if (cat.default_deduction_kind) parts.push(CATEGORY_KINDS.find(([k]) => k === cat.default_deduction_kind)?.[1]);
  if (cat.tax_credit_kind) parts.push(TAX_CREDIT_KINDS.find(([k]) => k === cat.tax_credit_kind)?.[1]);
  return parts.filter(Boolean).join(' · ') || null;
}
