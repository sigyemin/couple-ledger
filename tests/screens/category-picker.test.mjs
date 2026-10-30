// 카테고리 고르기 부품 (CL-060) — 합성 카테고리만
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { pickGroups, pickNorm, searchCategories, labelOf, recentItems, pushRecent, RECENT_SHOW, RECENT_KEEP } from '../../app/screens/category-pick-model.js';

const cat = (id, name, parent_id = null, o = {}) => ({ id, name, parent_id, code: null, sort_order: 1, is_active: true, ...o });
const CATS = [
  cat('g1', '식비', null, { sort_order: 1 }), cat('i1', '외식', 'g1', { sort_order: 2 }), cat('i2', '식재료', 'g1', { sort_order: 1 }),
  cat('i9', '야식', 'g1', { is_active: false }),
  cat('g2', '생활 용품', null, { sort_order: 2 }), cat('i3', '세제', 'g2'),
  cat('gx', '꺼진그룹', null, { is_active: false }), cat('ix', '숨은항목', 'gx'),
  cat('g9', '수입', null, { code: 'income', sort_order: 9 }), cat('i8', '급여', 'g9'),
];

test('그룹·항목: 켜진 것만, 지출은 수입 그룹 빼고, 수입은 수입 그룹만, 이름표는 대분류 > 소분류', () => {
  const g = pickGroups(CATS, 'expense');
  assert.deepEqual(g.map((x) => [x.id, x.name, x.items.map((it) => it.label)]), [
    ['g1', '식비', ['식비 > 식재료', '식비 > 외식']], ['g2', '생활 용품', ['생활 용품 > 세제']]]);
  assert.deepEqual(pickGroups(CATS, 'income').map((x) => x.name), ['수입']);
  assert.deepEqual(pickGroups([], 'expense'), []);
});

test('검색: 소분류·대분류 부분 일치, NFKC·공백·대소문자 무시, 꺼진 것 안 나옴', () => {
  const g = pickGroups(CATS, 'expense');
  assert.deepEqual(searchCategories(g, '외').map((x) => x.id), ['i1']);
  assert.deepEqual(searchCategories(g, '식비').map((x) => x.id), ['i2', 'i1']); // 대분류 이름 → 그 아래 전부
  assert.deepEqual(searchCategories(g, '생활용품').map((x) => x.id), ['i3']); // 공백 무시
  assert.deepEqual(searchCategories(g, '야식'), []); // 꺼진 항목
  assert.deepEqual(searchCategories(g, '  '), []);
  assert.equal(pickNorm(' Ａ b '), 'ab');
});

test('이름표·최근: 고를 수 없는 id는 빼고 최근 순, 앞으로 옮기기·개수 제한', () => {
  const g = pickGroups(CATS, 'expense');
  assert.equal(labelOf(g, 'i1'), '식비 > 외식');
  assert.equal(labelOf(g, 'i8'), null); // 수입 항목은 지출 고르기에서 없음
  assert.deepEqual(recentItems(['i8', 'i3', 'i9', 'i1'], g).map((x) => x.id), ['i3', 'i1']);
  assert.deepEqual(recentItems('x', g), []);
  const many = Array.from({ length: 10 }, (_, i) => (i % 2 ? 'i1' : 'i3'));
  assert.ok(recentItems(many, g).length <= RECENT_SHOW);
  assert.deepEqual(pushRecent(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
  assert.equal(pushRecent(Array.from({ length: 20 }, (_, i) => `x${i}`), 'n').length, RECENT_KEEP);
  assert.deepEqual(pushRecent(null, 'a'), ['a']);
});

test('화면에서 카테고리를 <select>로 고르는 곳이 없다(모두 부품으로)', () => {
  const dir = new URL('../../app/screens/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.equal(/categoryOptions\([^)]*\)\.map\(\(g\w*\) => h\('optgroup'/.test(src), false, f);
  }
});
