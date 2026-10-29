// =====================================================================
// 이체 상대 규칙 — 화면 없이 계산하는 부분 (화면 설계 v0.2 3-8 시안 17, 선택지는 v0.1 4-2 "새 이체 상대"와 같다)
// - 선택 → 규칙 값: 일반 지출(카테고리, 공동) / 용돈(개인) / 저축·내 계좌(이체·internal_transfer) / 두 사람 간 송금(이체·personal_transfer)
//   / 수입(받을 때만, 수입 카테고리 기본 기타수입). 업로드 미리보기도 같은 표를 쓴다(choiceValues)
// - 규칙 값 → 표시(choiceOf): 위 표의 거꾸로. 표에 없는 조합은 값 그대로 나열
// - 편집하면 다음 업로드부터. 이미 들어온 **검토 대기** 거래에는 미리보기 뒤 적용(apply_counterparty_rule). 확인한 거래는 그대로(결정 C3)
// - 이름(match_text)은 원문이 화면에 나온다(결정 10-26). 코드·시험에는 가짜 이름만
// 의존: core/validate.js, core/format.js
// =====================================================================
import { text as checkText } from '../core/validate.js';
import { won, day } from '../core/format.js';

const ALLOWANCE = 'allowance';
const INCOME_OTHER = 'income_other';
const INCOME_CODE = 'income';

export const CHOICES = Object.freeze([
  { key: 'expense', label: '일반 지출' },
  { key: 'allowance', label: '용돈' },
  { key: 'saving', label: '저축·내 계좌' },
  { key: 'couple', label: '두 사람 간 송금' },
  { key: 'income', label: '수입' },
]);
export const DIRECTIONS = Object.freeze([
  { key: 'out', label: '보낼 때' },
  { key: 'in', label: '받을 때' },
  { key: '', label: '주고받을 때' },
]);

/** 카테고리 행 → Map(id → { name, label, code, isIncome, isActive }) + 코드로 찾기 */
export function categoryIndex(categories) {
  const byId = new Map((categories ?? []).map((c) => [c.id, c]));
  const out = new Map();
  for (const c of categories ?? []) {
    const g = c.parent_id ? byId.get(c.parent_id) : null;
    out.set(c.id, {
      id: c.id, name: c.name, code: c.code ?? null, label: g ? `${g.name} · ${c.name}` : c.name,
      isIncome: (g ?? c).code === INCOME_CODE, isActive: c.is_active !== false,
    });
  }
  out.byCode = (code) => [...out.values()].find((c) => c.code === code) ?? null;
  return out;
}

/** 규칙 값 → { key, label, tag } (화면 설계 v0.2 3-8 표) */
export function choiceOf(rule, cats) {
  const cat = rule.suggested_category_id ? cats.get(rule.suggested_category_id) : null;
  if (rule.suggested_kind === 'transfer') {
    if (rule.suggested_exclude_reason === 'internal_transfer') return { key: 'saving', label: '저축·내 계좌', tag: '집계 제외' };
    if (rule.suggested_exclude_reason === 'personal_transfer') return { key: 'couple', label: '두 사람 간 송금', tag: '집계 제외' };
  }
  if (rule.suggested_kind === 'expense') {
    if (cat?.code === ALLOWANCE && rule.suggested_is_shared === false) return { key: 'allowance', label: '용돈', tag: '개인' };
    if (cat) return { key: 'expense', label: cat.label, tag: rule.suggested_is_shared === false ? '개인' : '공동' };
  }
  if (rule.suggested_kind === 'income') return { key: 'income', label: cat ? cat.label : '수입', tag: null };
  const parts = [];
  if (rule.suggested_kind) parts.push({ expense: '지출', income: '수입', transfer: '이체', refund: '환불' }[rule.suggested_kind] ?? rule.suggested_kind);
  if (cat) parts.push(cat.label);
  if (rule.suggested_is_shared != null) parts.push(rule.suggested_is_shared ? '공동' : '개인');
  return { key: 'custom', label: parts.length ? parts.join(' · ') : '보일 이름만', tag: null };
}

/** 범위 글자: "사용자A 시험통장 · 보낼 때" / "모든 통장 · 주고받을 때" */
export function scopeText(rule, sources) {
  const src = rule.source_id ? (sources.find((s) => s.id === rule.source_id)?.label ?? '알 수 없는 결제수단') : '모든 통장';
  const dir = DIRECTIONS.find((d) => d.key === (rule.direction ?? ''))?.label ?? '';
  return `${src} · ${dir}`;
}

/** 목록 한 줄 */
export function cpRow(rule, cats, sources) {
  const c = choiceOf(rule, cats);
  return {
    id: rule.id,
    name: rule.match_type === 'contains' ? `“${rule.match_text}” 포함` : rule.match_text,
    alias: rule.alias ? `“${rule.alias}”` : null,
    scope: scopeText(rule, sources),
    choice: c.label, tag: c.tag,
    off: !rule.is_active,
  };
}

/** 정렬: 켜진 것 먼저, 이름 가나다, 범위 */
export function cpList(rules, cats, sources) {
  return [...(rules ?? [])].sort((a, b) => (b.is_active === true) - (a.is_active === true)
    || String(a.match_text).localeCompare(String(b.match_text))
    || String(a.direction ?? '').localeCompare(String(b.direction ?? ''))
    || String(a.id).localeCompare(String(b.id)))
    .map((r) => cpRow(r, cats, sources));
}

/**
 * 선택 → 규칙 값(suggested_*·member_id). 두 사람 간 송금의 member_id = 결제수단 주인이 아닌 구성원(범위가 모든 통장이면 나 아닌 사람)
 * @returns {{ ok, value } | { ok:false, message }}
 */
export function choiceValues({ choice, categoryId = null, direction = null, sourceOwnerId = null, meId = null, members = [] }, cats) {
  const none = { suggested_kind: null, suggested_exclude_reason: null, suggested_category_id: null, suggested_is_shared: null, member_id: null };
  if (choice === 'expense') {
    if (!categoryId) return { ok: false, message: '카테고리를 골라 주세요' };
    if (cats.get(categoryId)?.isIncome) return { ok: false, message: '지출 카테고리를 골라 주세요' };
    return { ok: true, value: { ...none, suggested_kind: 'expense', suggested_category_id: categoryId, suggested_is_shared: true } };
  }
  if (choice === 'allowance') {
    const a = cats.byCode(ALLOWANCE);
    if (!a) return { ok: false, message: "'용돈' 카테고리가 없어요" };
    return { ok: true, value: { ...none, suggested_kind: 'expense', suggested_category_id: a.id, suggested_is_shared: false } };
  }
  if (choice === 'saving') return { ok: true, value: { ...none, suggested_kind: 'transfer', suggested_exclude_reason: 'internal_transfer' } };
  if (choice === 'couple') {
    const base = sourceOwnerId ?? meId;
    const other = members.find((m) => m.id !== base)?.id ?? null;
    return { ok: true, value: { ...none, suggested_kind: 'transfer', suggested_exclude_reason: 'personal_transfer', member_id: other } };
  }
  if (choice === 'income') {
    if (direction === 'out') return { ok: false, message: '보낼 때는 수입으로 고를 수 없어요' };
    const id = categoryId ?? cats.byCode(INCOME_OTHER)?.id ?? null;
    if (id && !cats.get(id)?.isIncome) return { ok: false, message: '수입 카테고리를 골라 주세요' };
    return { ok: true, value: { ...none, suggested_kind: 'income', suggested_category_id: id } };
  }
  return { ok: false, message: '어떻게 볼지 골라 주세요' };
}

/** 이름·보일 이름 검사(길이·민감번호) */
export function checkNames({ matchText = null, alias = '' }) {
  const out = {};
  if (matchText !== null) {
    const m = checkText(matchText, 'match_text', { required: true });
    if (!m.ok) return { ok: false, field: 'name', message: m.message };
    out.match_text = m.value;
  }
  const a = checkText(alias, 'alias');
  if (!a.ok) return { ok: false, field: 'alias', message: a.message };
  out.alias = a.value || null;
  return { ok: true, value: out };
}

/** 바뀐 칸만. apply = 검토 대기 거래 적용 미리보기로 갈지(제안 값이 바뀜) */
export function cpPatch(original, value) {
  const patch = {};
  for (const k of ['alias', 'member_id', 'suggested_kind', 'suggested_exclude_reason', 'suggested_category_id', 'suggested_is_shared']) {
    if (k in value && (original[k] ?? null) !== (value[k] ?? null)) patch[k] = value[k];
  }
  const apply = ['suggested_kind', 'suggested_exclude_reason', 'suggested_category_id', 'suggested_is_shared'].some((k) => k in patch);
  return { patch, apply };
}

const KIND_LABEL = { expense: '지출', income: '수입', transfer: '이체', refund: '환불' };
const RESULT_LABEL = {
  updated: '바뀜',
  skipped_priority: '다른 규칙이 먼저라 그대로',
  skipped_direction: '방향이 안 맞아 그대로',
  skipped_has_refund: '연결된 환불이 있어 그대로',
};

/** 적용 미리보기 요약 (apply_counterparty_rule 반환 행) */
export function cpPreview(rows) {
  const by = new Map();
  for (const r of rows ?? []) by.set(r.result, (by.get(r.result) ?? 0) + 1);
  const changed = (rows ?? []).filter((r) => r.result === 'updated');
  return {
    changeCount: changed.length,
    headline: changed.length ? `검토 대기 ${changed.length}건이 바뀌어요` : '바뀌는 검토 대기 거래가 없어요',
    counts: Object.keys(RESULT_LABEL).filter((k) => by.get(k)).map((k) => ({ key: k, label: RESULT_LABEL[k], count: `${by.get(k)}건` })),
    changed,
  };
}

/** 바뀌는 거래 한 줄 */
export function cpChangeLine(r, detail) {
  const kindText = (k, reason) => (k === 'transfer' ? `이체(${reason === 'personal_transfer' ? '두 사람 간' : '내 계좌'})` : (KIND_LABEL[k] ?? k));
  const from = kindText(r.old_kind, r.old_exclude_reason);
  let to = kindText(r.new_kind, r.new_exclude_reason);
  if (r.new_kind === 'expense' && r.new_is_shared != null) to += r.new_is_shared ? ' · 공동' : ' · 개인';
  return {
    id: r.txn_id,
    merchant: detail?.merchant_raw ?? '',
    sub: detail ? `${day(detail.occurred_on)} · ${won(Number(detail.amount))}` : '',
    from, to,
  };
}

export function cpApplyResult(rows) {
  const n = (rows ?? []).filter((r) => r.result === 'updated').length;
  const batchId = (rows ?? []).find((r) => r.change_batch_id)?.change_batch_id ?? null;
  return { count: n, batchId, text: n ? `${n}건 바꿨어요. 검토도 확인함으로 바뀌었어요.` : '바뀐 거래가 없어요.' };
}

export function cpErrorText(err) {
  if (err?.code === 'duplicate') return '이미 같은 이름·범위 규칙이 있어요';
  if (err?.code === 'bulk_invalid') return '대상이 너무 많거나(1,000건 넘음) 꺼진 규칙이에요.';
  return null;
}
