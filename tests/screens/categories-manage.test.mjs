// 카테고리 관리 다듬기 (CL-064) — 합성 카테고리만
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  categoryTree, reorderUpdates, dropPlan, addPlan, menuActions, NEW_GROUP, BASIC_MOVE_TEXT,
} from '../../app/screens/categories-model.js';

const c = (id, name, parent_id = null, sort_order = 10, o = {}) => ({ id, name, parent_id, sort_order, code: null, is_active: true, ...o });
const ROWS = [
  c('g1', '식비', null, 10, { code: 'food' }), c('a', '식재료', 'g1', 10, { code: 'groceries' }), c('b', '외식', 'g1', 20, { code: 'dining_out' }),
  c('s', '간식', 'g1', 30), c('k', '카페', 'g1', 40),
  c('g2', '생활', null, 20, { code: 'living' }), c('d', '생활용품', 'g2', 10, { code: 'household_goods' }), c('e', '카페', 'g2', 20),
  c('g3', '내 그룹', null, 30),
  c('g9', '수입', null, 900, { code: 'income' }), c('i', '급여', 'g9', 10, { code: 'salary' }),
];
const tree = categoryTree(ROWS);
const node = (id) => [...tree.expense, ...tree.income].flatMap((g) => [g, ...g.items]).find((n) => n.id === id);
const ids = (u) => u.map((x) => `${x.id}:${x.sort_order}${x.parent_id ? `@${x.parent_id}` : ''}`);

test('순서 계산: 앞·가운데·끝으로, 바뀐 것만 10 간격', () => {
  const g1 = ROWS.filter((r) => r.parent_id === 'g1');
  assert.deepEqual(ids(reorderUpdates(g1, 's', 0)), ['s:10', 'a:20', 'b:30']); // 맨 앞(k는 그대로 40)
  assert.deepEqual(ids(reorderUpdates(g1, 'a', 3)), ['b:10', 's:20', 'k:30', 'a:40']); // 맨 끝
  assert.deepEqual(ids(reorderUpdates(g1, 'k', 1)), ['k:20', 'b:30', 's:40']); // 가운데
  assert.deepEqual(reorderUpdates(g1, 'b', 1), []); // 제자리
  assert.deepEqual(reorderUpdates(g1, 'zz', 0), []);
  assert.deepEqual(ids(reorderUpdates(g1, 'a', 99)), ['b:10', 's:20', 'k:30', 'a:40']); // 넘치면 끝
});

test('끌어 놓기 계획: 같은 그룹 순서, 대분류끼리, 다른 그룹은 사용자 항목·같은 쪽·이름 안 겹칠 때만', () => {
  const same = dropPlan(ROWS, tree, node('k'), { groupId: 'g1', index: 0 });
  assert.equal(same.ok, true);
  assert.equal(same.same, true);
  assert.deepEqual(ids(same.updates), ['k:10', 'a:20', 'b:30', 's:40']);
  const groups = dropPlan(ROWS, tree, node('g3'), { groupId: null, index: 0 });
  assert.deepEqual(ids(groups.updates), ['g3:10', 'g1:20', 'g2:30']); // 수입 그룹은 따로
  const moved = dropPlan(ROWS, tree, node('s'), { groupId: 'g2', index: 1 });
  assert.equal(moved.ok, true);
  assert.deepEqual(ids(moved.updates), ['s:20@g2', 'e:30']); // 옮기는 항목 먼저(부모 + 순서), 그 그룹 순서 다시
  assert.deepEqual(dropPlan(ROWS, tree, node('b'), { groupId: 'g2', index: 0 }), { ok: false, message: BASIC_MOVE_TEXT });
  assert.match(dropPlan(ROWS, tree, node('s'), { groupId: 'g9', index: 0 }).message, /지출과 수입/);
  assert.match(dropPlan(ROWS, tree, node('k'), { groupId: 'g2', index: 0 }).message, /같은 이름/); // g2에도 '카페'
});

test('추가 대화상자 검사: 대카테고리 필수, 빈 이름·중복·길이, 새 대분류는 수입 그룹 앞', () => {
  assert.equal(addPlan(ROWS, tree, { groupId: '', name: '야식' }).field, 'group');
  assert.equal(addPlan(ROWS, tree, { groupId: 'g1', name: '  ' }).field, 'name');
  assert.match(addPlan(ROWS, tree, { groupId: 'g1', name: '외식' }).message, /이미 있는 이름/);
  assert.equal(addPlan(ROWS, tree, { groupId: 'g1', name: '가'.repeat(21) }).field, 'name');
  assert.deepEqual(addPlan(ROWS, tree, { groupId: 'g1', name: '야식' }), { ok: true, row: { parent_id: 'g1', name: '야식', sort_order: 50 }, place: '식비' });
  const g = addPlan(ROWS, tree, { groupId: NEW_GROUP, name: '반려동물' });
  assert.equal(g.row.parent_id, null);
  assert.ok(g.row.sort_order < 900);
  assert.match(addPlan(ROWS, tree, { groupId: NEW_GROUP, name: '생활' }).message, /이미 있는 이름/);
  assert.equal(addPlan(ROWS, tree, { groupId: 'nope', name: '야식' }).field, 'group');
});

test('⋯ 메뉴: 기본 항목은 옮기기·지우기 막고 이유, 사용자 항목은 옮길 그룹 목록, 대분류는 옮기기 없음', () => {
  const basic = menuActions(node('b'), tree);
  assert.deepEqual([basic.move.ok, basic.move.reason, basic.remove.ok], [false, BASIC_MOVE_TEXT, false]);
  assert.match(basic.remove.reason, /끄기/);
  const mine = menuActions(node('s'), tree);
  assert.deepEqual([mine.move.ok, mine.move.targets.map((t) => t.id), mine.remove.ok], [true, ['g2', 'g3'], true]);
  assert.equal(menuActions(node('g3'), tree).move.ok, false);
  assert.equal(menuActions({ ...node('s'), isActive: false }, tree).toggle.label, '켜기');
});

test('화면 코드: innerHTML·인라인 style 없음, 그룹마다 있던 추가 칸 없음, 끌기는 pointer events', () => {
  const src = readFileSync(new URL('../../app/screens/categories.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /innerHTML|\.style\b|insertAdjacentHTML/);
  assert.doesNotMatch(src, /cat-add'/);
  for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) assert.match(src, new RegExp(`'${ev}'`));
});
