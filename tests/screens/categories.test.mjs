// 카테고리 관리 모델 (합성 이름만)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categoryTree, checkName, moveUpdates, nextSortOrder, offTargets, offConfirmText, moveGroupText, deleteErrorText, nameErrorText,
} from '../../app/screens/categories-model.js';

const cats = [
  { id: 'g1', parent_id: null, name: '식비', code: 'food', sort_order: 100, is_active: true },
  { id: 'g2', parent_id: null, name: '취미모임', code: null, sort_order: 110, is_active: true },
  { id: 'g9', parent_id: null, name: '수입', code: 'income', sort_order: 900, is_active: true },
  { id: 'c1', parent_id: 'g1', name: '식재료', code: 'groceries', sort_order: 1, is_active: true },
  { id: 'c2', parent_id: 'g1', name: '야식', code: null, sort_order: 2, is_active: true },
  { id: 'c3', parent_id: 'g1', name: '간식', code: null, sort_order: 3, is_active: false },
];

test('트리: 지출/수입, 꼬리표, 기본은 지우기·옮기기 없음, 그룹은 옮기기 없음', () => {
  const t = categoryTree(cats);
  assert.deepEqual(t.expense.map((g) => [g.name, g.canDelete, g.canMove]), [['식비', false, false], ['취미모임', true, false]]);
  assert.deepEqual(t.expense[0].items.map((i) => [i.name, i.tags, i.canDelete, i.canMove]), [
    ['식재료', ['기본'], false, false], ['야식', [], true, true], ['간식', ['꺼짐'], true, true]]);
  assert.deepEqual(t.income.map((g) => g.name), ['수입']);
});

test('이름: 필수·길이·민감번호·같은 묶음 중복', () => {
  const sib = cats.filter((c) => c.parent_id === 'g1');
  assert.deepEqual(checkName(' 배달 ', sib), { ok: true, value: '배달' });
  assert.equal(checkName('야식', sib).message, '이미 있는 이름이에요');
  assert.equal(checkName('야식', sib, 'c2').ok, true, '자기 이름 그대로는 됨');
  assert.equal(checkName('', sib).ok, false);
  assert.equal(checkName('가'.repeat(21), sib).ok, false);
  const digits = Array.from({ length: 10 }, () => 1 + Math.floor(Math.random() * 9)).join('');
  assert.equal(checkName(`계좌 ${digits}`, sib).reason, 'sensitive');
  assert.equal(nameErrorText({ code: 'duplicate' }), '이미 있는 이름이에요');
});

test('순서: 값이 다르면 둘만 맞바꿈, 같은 값이 있으면 10 간격으로 다시 매김, 끝에서는 없음', () => {
  const sib = cats.filter((c) => c.parent_id === 'g1');
  assert.deepEqual(moveUpdates(sib, 'c2', 'up'), [{ id: 'c2', sort_order: 1 }, { id: 'c1', sort_order: 2 }]);
  assert.deepEqual(moveUpdates(sib, 'c1', 'up'), []);
  assert.deepEqual(moveUpdates(sib, 'c3', 'down'), []);
  const same = [{ id: 'a', name: 'ㄱ', sort_order: 0 }, { id: 'b', name: 'ㄴ', sort_order: 0 }, { id: 'c', name: 'ㄷ', sort_order: 0 }];
  assert.deepEqual(moveUpdates(same, 'c', 'up'), [{ id: 'a', sort_order: 10 }, { id: 'c', sort_order: 20 }, { id: 'b', sort_order: 30 }]);
});

test('새 순서: 가장 큰 값 + 10, 지출 그룹은 수입보다 앞', () => {
  assert.equal(nextSortOrder([{ sort_order: 1 }, { sort_order: 3 }]), 13);
  assert.equal(nextSortOrder([]), 10);
  assert.equal(nextSortOrder([{ sort_order: 100 }, { sort_order: 110 }], { before: 900 }), 120);
  assert.equal(nextSortOrder([{ sort_order: 895 }], { before: 900 }), 899);
});

test('끄기: 그룹은 켜진 항목까지, 문구에 규칙 수, 옮기기·지우기 실패 문구', () => {
  const t = categoryTree(cats);
  assert.deepEqual(offTargets(t.expense[0]), ['g1', 'c1', 'c2']);
  assert.deepEqual(offTargets(t.expense[0].items[1]), ['c2']);
  assert.match(offConfirmText(t.expense[0], 3, 1).message, /안의 켜진 항목 2개도 함께 꺼져요\. 이 카테고리를 쓰는 가맹점 규칙 3개·이체 상대 규칙 1개는 남지만/);
  assert.doesNotMatch(offConfirmText(t.expense[0].items[1], 0, 0).message, /안의 켜진 항목/);
  assert.match(moveGroupText({ name: '야식' }, '취미모임').message, /지난 리포트도 새 그룹으로 다시 묶여요/);
  assert.equal(deleteErrorText({ detail: { sqlState: '23503' } }), '쓰는 거래·규칙이나 항목이 있어 끌 수만 있어요');
  assert.equal(deleteErrorText({ detail: {} }), null);
});
