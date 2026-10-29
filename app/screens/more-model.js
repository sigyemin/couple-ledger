// =====================================================================
// 더보기 — 화면 없이 계산하는 부분 (화면 설계 v0.2 3-1 시안 10)
// - 메뉴: 구성원 · 월 검토 · 리포트 · 규칙·카테고리 · 결제수단 · 휴지통 · 로그아웃 (설계 순서 그대로)
//   아직 없는 화면은 "준비 중"으로 보여 주고 누를 수 없다
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
    { label: '월 검토', sub: n > 0 ? `${m}월 · 검토할 것 ${n}건` : `${m}월 · 검토할 것 없음`, href: buildHash('review', { query: { month: ym } }) },
    { label: '리포트', sub: '월 추이 · 지난달과 비교', href: buildHash('report') },
    { label: '규칙·카테고리', sub: '카테고리 (가맹점 규칙·이체 상대는 준비 중)', href: buildHash('categories') },
    { label: '결제수단', sub: '준비 중', href: null },
    { label: '휴지통', sub: '지운 거래 보기 · 되살리기', href: buildHash('trash') },
    { label: '변경 기록', sub: '한 번에 바꾼 기록 · 되돌리기', href: buildHash('changes') },
  ];
}
