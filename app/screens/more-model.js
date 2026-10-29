// =====================================================================
// 더보기 — 화면 없이 계산하는 부분 (화면 설계 v0.2 3-1 시안 10, 3-9 카테고리 "보기")
// - 메뉴: 구성원 · 월 검토 · 리포트 · 규칙·카테고리 · 결제수단 · 휴지통 · 로그아웃 (설계 순서 그대로)
//   아직 없는 화면은 "준비 중"으로 보여 주고 누를 수 없다
// - 월 검토 화면(설계 v0.1 4-5)은 아직 없어서, 지금은 그 달 내역의 검토 대기 필터로 보낸다 [판단]
// 의존: router.js
// =====================================================================
import { buildHash } from '../router.js';

/** 메뉴 줄: { label, sub, href|null } */
export function moreMenu({ member, monthStart, needsReview }) {
  const ym = monthStart.slice(0, 7);
  const m = Number(ym.slice(5));
  const n = Number(needsReview) || 0;
  return [
    { label: '구성원', sub: `${member.displayName} · 구글 계정으로 로그인됨`, href: null },
    { label: '월 검토', sub: n > 0 ? `${m}월 · 검토할 것 ${n}건` : `${m}월 · 검토할 것 없음`, href: buildHash('list', { query: { month: ym, status: 'needs_review' } }) },
    { label: '리포트', sub: '준비 중', href: null },
    { label: '규칙·카테고리', sub: '카테고리 보기 (가맹점 규칙·이체 상대·고치기는 준비 중)', href: buildHash('categories') },
    { label: '결제수단', sub: '준비 중', href: null },
    { label: '휴지통', sub: '준비 중', href: null },
  ];
}

const INCOME_CODE = 'income';

/**
 * 카테고리 보기(3-9): 지출 그룹들, 수입 그룹 따로. 항목에 "기본"(code 있음)·"꺼짐" 꼬리표
 * @returns {{ expense: Group[], income: Group[] }}  Group = { name, tags, items: { name, tags }[] }
 */
export function categoryTree(categories) {
  const tags = (c) => [c.code ? '기본' : null, c.is_active ? null : '꺼짐'].filter(Boolean);
  const order = (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name);
  const groups = categories.filter((c) => !c.parent_id).sort(order).map((g) => ({
    name: g.name,
    code: g.code,
    tags: tags(g),
    items: categories.filter((c) => c.parent_id === g.id).sort(order).map((c) => ({ name: c.name, tags: tags(c) })),
  }));
  return {
    expense: groups.filter((g) => g.code !== INCOME_CODE),
    income: groups.filter((g) => g.code === INCOME_CODE),
  };
}
