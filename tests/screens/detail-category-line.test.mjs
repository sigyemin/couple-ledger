// 거래 상세 분류 줄 위계 (CL-067) — 소스 점검(화면 동작은 브라우저에서 확인)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p) => readFileSync(new URL(`../../app/${p}`, import.meta.url), 'utf8');

test('상세: 폭 가득 "카테고리 바꾸기…" 버튼 없음, 지금 카테고리 줄이 버튼(aria "카테고리 바꾸기, 지금 ○○")', () => {
  const d = src('screens/detail.js');
  assert.doesNotMatch(d, /placeholder: '카테고리 바꾸기…'/);
  assert.doesNotMatch(d, /classCard\.append\(h\('div', \{ class: 'filter-field' \}, \[pick\]/, '고르기 부품 버튼을 카드에 붙이지 않음');
  assert.match(d, /`카테고리 바꾸기, 지금 \$\{l\.name\}`, '바꾸기 ›'/);
  assert.match(d, /'분류하기, 지금 미분류', '분류하기 ›'/);
  assert.match(d, /b\.addEventListener\('click', \(\) => pick\.open\(b\)\)/, '줄을 누르면 대화상자, 닫히면 그 줄로 초점');
  assert.match(d, /c\.lines\.map\(\(l\) => h\('li', \{\}, \[\s*pick \? lineButton/, '나눈 거래도 줄마다 같은 모양');
  assert.match(d, /button\('금액 나누기', 'secondary'/, '금액 나누기 버튼은 그대로');
  assert.doesNotMatch(d, /innerHTML/);
});

test('고르기 부품: 다른 화면 모양은 그대로, open(focusBack)만 더함', () => {
  const p = src('screens/category-picker.js');
  assert.match(p, /el\.open = \(back = null\) => \{ if \(trigger\.disabled\) return; focusBack = back; open\(\); \};/);
  assert.match(p, /const back = focusBack \?\? trigger;/);
  assert.match(p, /class: 'field cat-pick-btn'/, '부품 버튼 모양 그대로');
});

test('스타일: 카테고리 이름이 크고 굵게, 미분류는 분류하기가 눈에 띄게', () => {
  const css = src('styles.css');
  assert.match(css, /\.line-name \{ font-size: 17px; font-weight: 700;/);
  assert.match(css, /\.line-btn\.uncat \{[^}]*background: var\(--blue-soft\)/);
  assert.match(css, /\.line-btn\.uncat \.line-act \{[^}]*font-weight: 700/);
});
