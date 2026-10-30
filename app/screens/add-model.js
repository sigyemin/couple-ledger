// =====================================================================
// 거래 직접 추가 — 화면 없이 계산하는 부분 (화면 설계 v0.1 4-4 "수동 추가는 같은 양식, 결제수단은 현금·카드·통장 중 선택(결제자 = 결제수단 주인)")
// - add_manual_transaction(p_row, p_lines) 한 번(v0.18 A1): 거래 + 카테고리 라인이 한꺼번에 들어가거나 하나도 안 들어간다
//   p_row 키는 정해진 것만(entry_key·source_id·occurred_on·occurred_time·merchant_raw·amount·kind·is_shared·memo — 다른 키면 LG007).
//   dedup_key는 DB가 'manual|<entry_key>'로 만들고, merchant_norm도 DB가 match_norm으로 만든다(앱 matchNorm과 같은 정의)
// - 사람이 직접 넣은 거래라 검토 상태는 확인함(confirmed)으로 넣는다 [판단]
// 의존: core/validate.js, import/formats.js(matchNorm — 업로드와 같은 가맹점 정리값)
// =====================================================================
import { amount as checkAmount, text as checkText, date as checkDate } from '../core/validate.js';
import { matchNorm } from '../import/formats.js';

export const ADD_KINDS = Object.freeze([['expense', '지출'], ['income', '수입']]);
const SOURCE_KIND = { credit_card: '신용카드', check_card: '체크카드', bank_account: '통장', cash: '현금' };
const RE_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 고를 수 있는 결제수단(켜진 것, 시험용 제외 — v0.18 add_manual_transaction이 시험용을 거부). 이름 = 라벨 · 종류 · 주인(결제자) */
export function sourceOptions(sources, members) {
  const nameOf = new Map(members.map((m) => [m.id, m.display_name]));
  return sources.filter((s) => s.is_active && !s.is_test)
    .map((s) => ({
      id: s.id,
      text: `${s.label} · ${SOURCE_KIND[s.kind] ?? ''} · ${nameOf.get(s.owner_member_id) ?? '?'}${s.is_test ? ' · 시험' : ''}`,
      isTest: Boolean(s.is_test),
    }))
    .sort((a, b) => Number(a.isTest) - Number(b.isTest) || a.text.localeCompare(b.text));
}

/**
 * 입력 검사 → insert 행
 * form: { sourceId, kind, date, time, merchant, amountText, categoryId, isShared, memo }
 * ctx: { sourceIds: Set, categoryIds: Set(종류에 맞는 켜진 카테고리), memberId, newId: () => uuid, today: 'YYYY-MM-DD'(날짜 범위 검사, 선택) }
 * @returns {{ ok: true, row, categoryId, amount } | { ok: false, message, field }}
 */
export function buildManualRow(form, ctx) {
  const bad = (field, message) => ({ ok: false, field, message });
  if (!ctx.sourceIds.has(form.sourceId)) return bad('source', '결제수단을 골라 주세요');
  if (!ADD_KINDS.some(([k]) => k === form.kind)) return bad('kind', '종류를 골라 주세요');
  const d = checkDate(form.date, { today: ctx.today ?? null });
  if (!d.ok) return bad('date', d.message);
  const time = String(form.time ?? '').trim();
  if (time && !RE_TIME.test(time)) return bad('time', '시각은 HH:MM으로 입력해 주세요');
  const m = checkText(form.merchant, 'merchant', { required: true });
  if (!m.ok) return bad('merchant', m.message);
  const a = checkAmount(form.amountText);
  if (!a.ok) return bad('amount', a.message);
  if (a.value === 0) return bad('amount', '0원은 넣을 수 없어요');
  const memo = checkText(form.memo, 'memo');
  if (!memo.ok) return bad('memo', memo.message);
  const categoryId = form.categoryId || null;
  if (categoryId && !ctx.categoryIds.has(categoryId)) return bad('category', '카테고리를 다시 골라 주세요');
  const id = ctx.newId();
  if (!RE_UUID.test(id)) throw new TypeError('newId는 uuid를 돌려줘야 합니다');
  return {
    ok: true,
    categoryId,
    amount: a.value,
    row: {
      source_id: form.sourceId,
      origin: 'manual',
      occurred_on: d.value,
      occurred_time: time ? `${time}:00` : null,
      merchant_raw: m.value,
      merchant_norm: matchNorm(m.value),
      amount: a.value,
      kind: form.kind,
      is_shared: Boolean(form.isShared),
      review_status: 'confirmed',
      memo: memo.value || null,
      dedup_key: `manual|${id}`,
      created_by: ctx.memberId,
    },
  };
}

/** buildManualRow 결과 → add_manual_transaction 인자(v0.18 A1). entryKey = 화면이 만든 uuid(다시 눌러도 같은 거래) */
export function manualRpcArgs(b, entryKey) {
  const r = b.row;
  return {
    p_row: {
      entry_key: entryKey, source_id: r.source_id, occurred_on: r.occurred_on, occurred_time: r.occurred_time,
      merchant_raw: r.merchant_raw, amount: r.amount, kind: r.kind, is_shared: r.is_shared, memo: r.memo,
    },
    p_lines: b.categoryId ? [{ category_id: b.categoryId, amount: b.amount, item_note: null }] : [],
  };
}

/** RPC 결과(transactions 한 행 — 객체 또는 한 줄 배열) → id */
export function rpcRowId(data) {
  const row = Array.isArray(data) ? data[0] : data;
  return typeof row?.id === 'string' ? row.id : null;
}

/** 'YYYY-MM-DD' → 그 달 'YYYY-MM-01' */
export function monthOf(date) {
  return `${date.slice(0, 7)}-01`;
}

/** 확인을 마친 달에 정산 영향 거래를 더하면 저장 전에 알린다(v0.1 4-4) */
export function addConfirmText(row, reviewState) {
  if (reviewState !== 'reviewed' && reviewState !== 'changed_after_review') return null;
  const [y, mo] = row.occurred_on.split('-').map(Number);
  return {
    title: '확인한 달에 추가',
    message: `${y}년 ${mo}월은 확인을 마친 달이에요. 이 거래를 더하면 '확인 후 변경됨'으로 표시돼요.`,
  };
}
