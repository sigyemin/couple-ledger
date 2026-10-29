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
