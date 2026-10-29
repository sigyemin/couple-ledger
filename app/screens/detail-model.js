// =====================================================================
// 화면 6 거래 상세 — 화면 없이 계산하는 부분 (화면 설계 v0.1 4-4, v0.2 2-1, v0.3 2-3·5-2)
// - 분류 바꾸기 = bulk_set_category([id], 카테고리) (v0.3 R1, 변경 기록에서 되돌릴 수 있음)
// - 휴지통 = transactions update(deleted_at·deleted_by·updated_by). 연결된 환불이 있으면 환불 먼저(v0.3 2-3, DB가 반대 순서를 거부)
// - 공동 여부·제외·분담은 이번 단계에서 표시만
// 의존: core/format.js, screens/list-model.js
// =====================================================================
import { won, day, month, dateTime, ratio } from '../core/format.js';
import { categoryLabel } from './list-model.js';

const KIND_LABEL = { expense: '지출', refund: '환불', income: '수입', transfer: '이체' };
const REVIEW_LABEL = { auto: '자동 분류', needs_review: '검토 대기', confirmed: '확인함' };
const SOURCE_LABEL = { rule: '규칙', manual: '직접', order_match: '주문 매칭', suggestion: '제안' };
const EXCLUDE_LABEL = {
  card_bill: '카드 대금', check_card: '체크카드 출금', internal_transfer: '내 계좌끼리·저축',
  personal_transfer: '두 사람 사이 송금', other: '기타',
};
const INCOME_CODE = 'income';

/** 월 확인 상태 한 줄 */
export function monthState(row) {
  const m = month(row.period_month).replace(/^[0-9]+년 /, '');
  if (!row.month_reviewed_at) return `${m} 확인 전`;
  return row.is_changed_after_review ? `${m} 확인 후 변경됨` : `${m} 확인 완료`;
}

function amountText(row) {
  const a = Number(row.amount);
  if (row.kind === 'refund') return won(-a);
  if (row.kind === 'income') return `+${won(a)}`;
  return won(a);
}

/**
 * 분류 칸 (v0.2 2-1)
 * @returns {{ lines: {name, amount, source}[], note: string|null, tag: string|null }}
 */
export function classification(row, cats) {
  const lines = Array.isArray(row.lines) ? row.lines : [];
  if (lines.length > 0) {
    return {
      lines: lines.map((l) => ({
        name: l.parent ? `${l.parent} · ${l.category}` : (l.category ?? '미분류'),
        amount: won(Number(l.amount)),
        source: SOURCE_LABEL[l.category_source] ?? '',
        note: l.item_note ?? null,
      })),
      note: null,
      tag: null,
    };
  }
  if (row.kind === 'transfer') return { lines: [], note: '이체는 분류하지 않아요', tag: null };
  if (row.kind === 'refund' && row.refund_of_txn_id) {
    if (row.inherited_category_id) {
      const c = cats.get(row.inherited_category_id);
      const name = c ? (c.parentId ? `${c.groupName} · ${c.name}` : c.name) : '?';
      return {
        lines: [{ name, amount: won(Number(row.amount)), source: '', note: null }],
        note: `이 환불은 따로 분류하지 않아서 원거래 카테고리(${c?.name ?? '?'})에서 빼서 셌어요. 원거래 분류를 바꾸면 함께 바뀌어요.`,
        tag: '원거래 카테고리',
      };
    }
    return { lines: [], note: '원거래가 아직 분류되지 않았어요', tag: null };
  }
  if (row.kind === 'refund') return { lines: [], note: '원거래를 아직 못 찾았어요', tag: null };
  return { lines: [], note: null, tag: null };
}

/** 상세 화면에 보일 값 */
export function buildDetailModel(row, { cats, members, original = null, refunds = [] }) {
  const nameOf = (id) => members.find((m) => m.id === id)?.display_name ?? '';
  const when = row.occurred_time ? `${day(row.occurred_on)} ${String(row.occurred_time).slice(0, 5)}` : day(row.occurred_on);
  const info = [
    [row.kind === 'refund' ? '환불일' : '이용일', when],
    ['결제수단', `${row.source_label} · ${row.payer_name}`],
  ];
  if (row.installment_months) info.push(['할부', `${row.installment_months}개월`]);
  if (row.period_month.slice(0, 7) !== row.occurred_on.slice(0, 7)) info.push(['집계하는 달', month(row.period_month)]);
  info.push(['들어온 길', row.origin === 'manual' ? '직접 추가' : '파일에서 올림']);

  const settle = [];
  if (row.is_excluded) {
    settle.push(['집계', `제외 · ${EXCLUDE_LABEL[row.exclude_reason] ?? '기타'}`]);
  } else if (row.kind === 'expense' || row.kind === 'refund') {
    const follows = row.kind === 'refund' && row.refund_of_txn_id;
    settle.push(['공동', `${follows ? '원거래를 따라요 · ' : ''}${row.is_shared ? '공동' : '개인'}`]);
    if (row.is_shared) {
      settle.push(['분담', `${row.payer_name} ${ratio(Number(row.share_ratio))}`]);
      settle.push(['이 건에서 상대 몫', won(Number(row.other_share_amount))]);
    }
  } else {
    settle.push(['집계', KIND_LABEL[row.kind]]);
  }

  const history = [[row.origin === 'manual' ? '직접 추가' : '올림', `${nameOf(row.created_by) || '-'} · ${dateTime(row.created_at)}`]];
  if (row.updated_at) history.push(['마지막 수정', `${nameOf(row.updated_by) || '-'} · ${dateTime(row.updated_at)}`]);

  return {
    title: row.merchant_raw,
    kindLabel: KIND_LABEL[row.kind] ?? '',
    amount: amountText(row),
    tone: row.is_excluded ? 'excluded' : row.kind,
    status: `${REVIEW_LABEL[row.review_status] ?? ''} · ${monthState(row)}`,
    info,
    classification: classification(row, cats),
    canChangeCategory: row.kind !== 'transfer' && row.deleted_at == null,
    settle,
    memo: row.memo ?? '',
    history,
    original: original ? {
      id: original.id, text: `${day(original.occurred_on)} · ${original.merchant_raw}`, amount: won(Number(original.amount)),
    } : null,
    refunds: refunds.map((r) => ({ id: r.id, text: `${day(r.occurred_on)} · 환불`, amount: won(-Number(r.amount)) })),
    deleted: row.deleted_at != null,
  };
}

/**
 * 고를 수 있는 카테고리 (v0.2 3-9: 켜진 것만, 지출·환불은 수입 그룹 제외, 수입은 수입 그룹만)
 * @returns {{ group: string, items: {id, name}[] }[]}
 */
export function categoryOptions(categories, kind) {
  const groups = categories.filter((c) => !c.parent_id && c.is_active)
    .filter((g) => (kind === 'income' ? g.code === INCOME_CODE : g.code !== INCOME_CODE))
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  return groups.map((g) => ({
    group: g.name,
    items: categories.filter((c) => c.parent_id === g.id && c.is_active)
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
      .map((c) => ({ id: c.id, name: c.name })),
  })).filter((g) => g.items.length > 0);
}

/** 분류 바꾸기 확인 문구. 나눈 거래면 모든 라인이 한 카테고리가 됨을 알린다 */
export function categoryChangeText(row, categoryName) {
  const n = Array.isArray(row.lines) ? row.lines.length : 0;
  return {
    title: '카테고리 바꾸기',
    message: n > 1
      ? `${n}개로 나눈 금액이 모두 '${categoryName}' 하나로 바뀌어요.`
      : `이 거래를 '${categoryName}'(으)로 분류해요.`,
    undoNote: '더보기 › 변경 기록에서 되돌릴 수 있어요.',
  };
}

/** 변경 기록 설명 (change_batches.description, 200자 이하) */
export function changeDescription(row, categoryName) {
  return `거래 상세 · ${row.merchant_raw} → ${categoryName}`.slice(0, 200);
}

/**
 * 휴지통 계획: 환불 먼저, 원거래 나중(v0.3 2-3)
 * @returns {{ ids: string[], title, message, undoNote }}
 */
export function trashPlan(row, refunds) {
  const parts = ['이 거래를 휴지통으로 옮겨요.'];
  if (refunds.length > 0) {
    const sum = refunds.reduce((s, r) => s + Number(r.amount), 0);
    parts.push(`이 결제에 연결된 환불 ${refunds.length}건(${won(-sum)})도 함께 휴지통으로 가요.`);
  }
  if (row.month_reviewed_at) parts.push(`${month(row.period_month)}은 확인을 마친 달이라 '확인 후 변경됨'으로 표시돼요.`);
  return {
    ids: [...refunds.map((r) => r.id), row.id],
    title: '휴지통으로',
    message: parts.join(' '),
    undoNote: '휴지통에서 되살릴 수 있어요.',
  };
}

/** 휴지통 update 값 */
export function trashPatch(memberId, now = new Date()) {
  return { deleted_at: now.toISOString(), deleted_by: memberId, updated_by: memberId };
}

// ---------------------------------------------------------------------
// CL-006 2단계: 확인했어요 · 공동/개인 · 집계 제외 · 나누기 (화면 설계 v0.1 4-4, v0.2 2-1, v0.3 5-2 R2·R3)
// ---------------------------------------------------------------------
const SPLIT_KINDS = ['expense', 'refund', 'income'];
export const MAX_LINES = 50; // set_transaction_lines c_max

/**
 * 이 거래에서 할 수 있는 수정
 * - 공동/개인: 지출, 원거래 없는 환불만(연결 환불은 원거래를 따름 — 트리거가 덮어씀, v0.2 2-1)
 * - 집계 제외: 이체 아닌 거래. 사유는 '기타'만(이체 성격 사유는 종류를 이체로 바꿔야 해서 이번 범위 밖, check_card는 지금 안 씀)
 *   연결된 환불이 있는 원거래는 뺄 수 없다(DB가 거부: "집계 제외된 거래에는 환불을 연결할 수 없습니다")
 */
export function editability(row, refunds = []) {
  if (row.deleted_at != null) {
    return { canConfirm: false, canShare: false, canExclude: false, excludeBlocked: null, canSplit: false, canRevertToOriginal: false };
  }
  const linkedRefund = row.kind === 'refund' && row.refund_of_txn_id != null;
  const lines = Array.isArray(row.lines) ? row.lines : [];
  const excluding = !row.is_excluded;
  return {
    canConfirm: row.review_status !== 'confirmed',
    canShare: !row.is_excluded && (row.kind === 'expense' || (row.kind === 'refund' && !linkedRefund)),
    canExclude: row.kind !== 'transfer',
    excludeBlocked: excluding && refunds.length > 0 ? '연결된 환불이 있어 집계에서 뺄 수 없어요. 환불을 먼저 정리해 주세요.' : null,
    canSplit: SPLIT_KINDS.includes(row.kind),
    canRevertToOriginal: linkedRefund && lines.length > 0,
  };
}

const reviewedNote = (row) => (row.month_reviewed_at
  ? ` ${month(row.period_month)}은 확인을 마친 달이라 '확인 후 변경됨'으로 표시돼요.` : '');

/** 정산에 영향 주는 변경의 확인 문구 (v0.1 4-4: 확인 완료 달이면 저장 전에 알림) */
export function settlementChangeText(row, change, refunds = []) {
  if (change.type === 'share') {
    // 연결된 환불은 원거래의 공동 여부를 따른다(트리거 sync_refund_from_original — 로컬 DB에서 확인)
    const follow = refunds.length > 0 ? ` 연결된 환불 ${refunds.length}건도 함께 바뀌어요.` : '';
    return {
      title: change.to ? '공동 지출로' : '개인 지출로',
      message: (change.to ? '이 거래를 공동 지출로 바꿔 정산에 넣어요.' : '이 거래를 개인 지출로 바꿔 정산에서 빼요.') + follow + reviewedNote(row),
    };
  }
  return {
    title: change.to ? '집계에서 빼기' : '집계에 다시 넣기',
    message: (change.to ? '이 거래를 지출·정산 집계에서 빼요. 사유는 기타로 남아요(메모에 이유를 적어 두세요).' : '이 거래를 다시 지출·정산 집계에 넣어요.') + reviewedNote(row),
  };
}

export function sharePatch(to, memberId) {
  return { is_shared: Boolean(to), updated_by: memberId };
}

export function excludePatch(to, memberId) {
  return to
    ? { is_excluded: true, exclude_reason: 'other', updated_by: memberId }
    : { is_excluded: false, exclude_reason: null, updated_by: memberId };
}

export function confirmPatch(memberId) {
  return { review_status: 'confirmed', updated_by: memberId };
}

/** 나누기 편집의 처음 값: 지금 라인, 없으면 거래 금액 전체 한 줄(카테고리 비움) */
export function linesDraft(row) {
  const lines = Array.isArray(row.lines) ? row.lines : [];
  if (lines.length === 0) return [{ categoryId: '', amountText: String(Number(row.amount)), note: '' }];
  return lines.map((l) => ({ categoryId: l.category_id ?? '', amountText: String(Number(l.amount)), note: l.item_note ?? '' }));
}

/**
 * 나누기 입력 검사 → set_transaction_lines 인자
 * @param {{ categoryId, amountText, note }[]} draft
 * @param {Set<string>} allowedCategoryIds 고를 수 있는 카테고리(켜진 것, 종류에 맞는 그룹)
 * @returns {{ ok: true, lines, sumText } | { ok: false, message, sumText }}
 */
export function validateLines(draft, total, allowedCategoryIds, checks) {
  const sumOf = (xs) => xs.reduce((s, x) => s + x, 0);
  const amounts = draft.map((d) => checks.amount(d.amountText));
  const known = amounts.filter((a) => a.ok).map((a) => a.value);
  const sum = sumOf(known);
  const sumText = `합계 ${won(sum)} / 거래 ${won(Number(total))}`;
  const bad = (message) => ({ ok: false, message, sumText });
  if (draft.length < 1 || draft.length > MAX_LINES) return bad(`1~${MAX_LINES}줄로 나눠 주세요`);
  const lines = [];
  for (const [i, d] of draft.entries()) {
    const n = i + 1;
    if (!allowedCategoryIds.has(d.categoryId)) return bad(`${n}번째 줄의 카테고리를 골라 주세요`);
    if (!amounts[i].ok) return bad(`${n}번째 줄: ${amounts[i].message}`);
    if (amounts[i].value === 0) return bad(`${n}번째 줄 금액은 1원 이상이어야 해요`); // 0원 줄은 앱이 막음(DB는 0 허용, PR #14 리뷰 L1)
    const note = checks.text(d.note, 'item_note');
    if (!note.ok) return bad(`${n}번째 줄 품목: ${note.message}`);
    lines.push({ category_id: d.categoryId, amount: amounts[i].value, item_note: note.value || null });
  }
  if (sum !== Number(total)) {
    const diff = Number(total) - sum;
    return bad(diff > 0 ? `${won(diff)}이 남았어요. 합계가 거래 금액과 같아야 해요` : `${won(-diff)}이 넘쳐요. 합계가 거래 금액과 같아야 해요`);
  }
  return { ok: true, lines, sumText };
}
