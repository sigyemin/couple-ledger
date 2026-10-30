// =====================================================================
// 카테고리 관리 — 화면 없이 계산하는 부분 (화면 설계 v0.2 3-9 시안 18)
// - 보기: 지출 그룹들 / 수입 그룹(code income). "기본"(code 있음)·"꺼짐" 꼬리표
// - 순서: ↑↓로 이웃과 sort_order 맞바꿈. 값이 같으면 그 묶음을 10 간격으로 다시 매김
// - 이름: 같은 그룹 같은 이름 금지(DB unique (parent_id, name) → 23505)
// - 끄기: 확인 대화상자(규칙 N개·이체 상대 규칙 M개는 남지만 다시 적용할 수 없음). 그룹 끄기 = 안의 켜진 항목까지
// - 지우기·옮기기: 사용자가 만든 것(code 없음)만. 옮기기는 같은 쪽(지출/수입) 그룹으로만. 쓰는 거래·규칙이 있으면 DB가 지우기를 거부(23503)
// - 2단계(그룹 › 항목)까지만: 항목 아래 항목은 만들지 않는다
// 의존: core/validate.js
// =====================================================================
import { text as checkText } from '../core/validate.js';

const INCOME_CODE = 'income';
const order = (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name);

/** 그룹과 항목 트리. 각 줄에 꼬리표·할 수 있는 일 */
export function categoryTree(categories) {
  const node = (c) => ({
    id: c.id, name: c.name, code: c.code ?? null, parentId: c.parent_id ?? null, sortOrder: c.sort_order, isActive: c.is_active,
    tags: [c.code ? '기본' : null, c.is_active ? null : '꺼짐'].filter(Boolean),
    canDelete: !c.code, canMove: !c.code && c.parent_id != null,
  });
  const groups = categories.filter((c) => !c.parent_id).sort(order).map((g) => ({
    ...node(g),
    items: categories.filter((c) => c.parent_id === g.id).sort(order).map(node),
  }));
  return {
    expense: groups.filter((g) => g.code !== INCOME_CODE),
    income: groups.filter((g) => g.code === INCOME_CODE),
  };
}

/**
 * 이름 검사: 길이·민감번호(공통 검증) + 같은 묶음 안 중복
 * @param siblings 같은 parent의 카테고리들
 */
export function checkName(name, siblings, selfId = null) {
  const v = checkText(name, 'category_name', { required: true });
  if (!v.ok) return v;
  if (siblings.some((s) => s.id !== selfId && s.name === v.value)) return { ok: false, reason: 'duplicate', message: '이미 있는 이름이에요' };
  return v;
}

/**
 * ↑↓ 이동 → 바꿀 sort_order 목록 [{ id, sort_order }]
 * 이웃과 값이 다르면 둘을 맞바꾸고, 같은 값이 있으면 묶음 전체를 새 순서대로 10, 20, …으로 다시 매긴다
 * @param siblings 같은 묶음(정렬 전 그대로 넘겨도 됨)
 */
export function moveUpdates(siblings, id, dir) {
  const list = [...siblings].sort(order);
  const i = list.findIndex((c) => c.id === id);
  const j = i + (dir === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= list.length) return [];
  const values = list.map((c) => c.sort_order);
  if (new Set(values).size === values.length) {
    return [{ id: list[i].id, sort_order: list[j].sort_order }, { id: list[j].id, sort_order: list[i].sort_order }];
  }
  [list[i], list[j]] = [list[j], list[i]];
  return list.map((c, k) => ({ id: c.id, sort_order: (k + 1) * 10 })).filter((u, k) => u.sort_order !== list[k].sort_order);
}

/** 새로 넣을 때 sort_order: 묶음의 가장 큰 값 + 10 (지출 그룹은 수입 그룹보다 앞) */
export function nextSortOrder(siblings, { before = null } = {}) {
  const max = siblings.reduce((m, c) => Math.max(m, c.sort_order), 0);
  const next = max + 10;
  return before != null && next >= before ? Math.max(max + 1, before - 1) : next;
}

/** 옮길 수 있는 그룹: 같은 쪽(지출↔지출, 수입↔수입)의 다른 그룹. DB는 지출·수입 구분을 검사하지 않는다 */
export function moveTargets(tree, node) {
  const side = tree.income.some((g) => g.id === node.parentId) ? tree.income : tree.expense;
  return side.filter((g) => g.id !== node.parentId);
}

/** 끄기 대상: 항목이면 자신, 그룹이면 자신 + 켜진 항목 */
export function offTargets(node) {
  return [node.id, ...(node.items ?? []).filter((c) => c.isActive).map((c) => c.id)];
}

/** 끄기 확인 문구 (v0.2 3-9) */
export function offConfirmText(node, ruleCount, counterpartyCount) {
  const inside = node.items ? ` 안의 켜진 항목 ${node.items.filter((c) => c.isActive).length}개도 함께 꺼져요.` : '';
  return {
    title: `'${node.name}' 끄기`,
    message: `고르기 목록에서 빠져요.${inside} 이 카테고리를 쓰는 가맹점 규칙 ${ruleCount}개·이체 상대 규칙 ${counterpartyCount}개는 남지만 다시 적용할 수 없어요. 지난 거래·리포트는 그대로예요.`,
  };
}

/** 옮기기 확인 문구 */
export function moveGroupText(node, toGroupName) {
  return {
    title: '다른 그룹으로',
    message: `'${node.name}'을(를) '${toGroupName}' 그룹으로 옮겨요. 지난 리포트도 새 그룹으로 다시 묶여요.`,
  };
}

/** 지우기 실패(23503 등) 안내 */
export function deleteErrorText(err) {
  return err?.detail?.sqlState === '23503' ? '쓰는 거래·규칙이나 항목이 있어 끌 수만 있어요' : categoryErrorText(err);
}

/**
 * v0.18 카테고리 보호 안내(A5): LG004 기본 카테고리 삭제, LG005 기본 카테고리 옮기기·시스템 코드, 23514 2단계·지출↔수입·자기 아래
 * 그 밖이면 null(일반 오류 문구)
 */
export function categoryErrorText(err) {
  const s = err?.detail?.sqlState;
  if (s === 'LG004') return '기본 카테고리는 지울 수 없어요. 끄기(사용 안 함)로 바꿔 주세요.';
  if (s === 'LG005') return '기본 카테고리는 다른 그룹으로 옮기거나 시스템 값을 바꿀 수 없고, 카테고리 번호는 바꿀 수 없어요.'; // v0.19: id 변경도 LG005
  if (s === '23514') return '카테고리는 그룹 → 항목 2단계까지만 되고, 지출과 수입 사이로는 옮길 수 없어요.';
  return null;
}

/** 이름 저장 실패(23505) 안내 */
export function nameErrorText(err) {
  return err?.code === 'duplicate' ? '이미 있는 이름이에요' : categoryErrorText(err);
}
