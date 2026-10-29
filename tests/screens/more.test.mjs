// 더보기·카테고리 보기 모델 (가짜 이름만)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moreMenu } from '../../app/screens/more-model.js';
import { categoryTree } from '../../app/screens/categories-model.js';
import { activeTab } from '../../app/screens/shell.js';
import { parseHash } from '../../app/router.js';

test('더보기 메뉴: 설계 순서, 월 검토 수, 없는 화면은 누를 수 없음', () => {
  const m = moreMenu({ member: { displayName: '가람' }, monthStart: '2026-10-01', needsReview: '18' });
  assert.deepEqual(m.map((x) => x.label), ['구성원', '월 검토', '리포트', '규칙·카테고리', '결제수단', '휴지통', '변경 기록']);
  assert.equal(m[0].sub, '가람 · 구글 계정으로 로그인됨');
  assert.deepEqual([m[1].sub, m[1].href], ['10월 · 검토할 것 18건', '#/review?month=2026-10']);
  assert.equal(m[3].href, '#/categories');
  assert.deepEqual(m.filter((x) => !x.href).map((x) => x.label), ['구성원', '결제수단']);
  assert.equal(moreMenu({ member: { displayName: '가람' }, monthStart: '2026-01-01', needsReview: 0 })[1].sub, '1월 · 검토할 것 없음');
  assert.equal(moreMenu({ member: { displayName: '가람' }, monthStart: '2026-01-01' })[1].sub, '1월 · 검토할 것 없음', '숫자를 못 읽어도');
  assert.deepEqual([activeTab('categories'), parseHash('#/categories').screen], ['more', 'categories']);
});

test('카테고리 보기: 지출·수입 나눔, 순서, 기본·꺼짐 꼬리표', () => {
  const cats = [
    { id: 'g2', parent_id: null, name: '생활', code: 'living', sort_order: 300, is_active: true },
    { id: 'g1', parent_id: null, name: '식비', code: 'food', sort_order: 100, is_active: true },
    { id: 'g9', parent_id: null, name: '수입', code: 'income', sort_order: 900, is_active: true },
    { id: 'gx', parent_id: null, name: '취미모임', code: null, sort_order: 950, is_active: false },
    { id: 'c2', parent_id: 'g1', name: '외식', code: 'dining_out', sort_order: 2, is_active: true },
    { id: 'c1', parent_id: 'g1', name: '식재료', code: 'groceries', sort_order: 1, is_active: true },
    { id: 'c3', parent_id: 'g1', name: '야식', code: null, sort_order: 3, is_active: false },
    { id: 'c9', parent_id: 'g9', name: '급여', code: 'salary', sort_order: 1, is_active: true },
  ];
  const t = categoryTree(cats);
  assert.deepEqual(t.expense.map((g) => [g.name, g.tags]), [['식비', ['기본']], ['생활', ['기본']], ['취미모임', ['꺼짐']]]);
  assert.deepEqual(t.expense[0].items.map((i) => [i.name, i.tags]), [['식재료', ['기본']], ['외식', ['기본']], ['야식', ['꺼짐']]]);
  assert.deepEqual(t.income.map((g) => [g.name, g.items.map((i) => i.name)]), [['수입', ['급여']]]);
});
