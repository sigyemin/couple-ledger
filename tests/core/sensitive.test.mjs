// app/core/sensitive.js — DB has_sensitive_number와 같은 시험 사례(스키마 검증 C5-1~11)를 쓴다.
// 10자리 이상 숫자는 소스에 그대로 쓰지 않고 실행 중에 이어 붙인다(이 파일도 유출 검사를 통과해야 함).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasSensitiveNumber, maskSensitiveNumbers, removeKnownPatterns, approvalNoValid, MASK_TEXT,
} from '../../app/core/sensitive.js';

const j = (...parts) => parts.join('');

test('C5-1~11: DB 검증과 같은 판정', () => {
  const cases = [
    ['C5-1 일시', '2026-10-06 12:30:45', false],
    ['C5-2 일시 점', '2026.10.06 12:30', false],
    ['C5-3 붙여 쓴 일시', j('20261006', '123045'), false],
    ['C5-4 카드번호 하이픈', j('1234-5678', '-9012-3456'), true],
    ['C5-5 카드번호 공백', j('1234 5678', ' 9012 3456'), true],
    ['C5-6 휴대폰', j('010-1234', '-5678'), true],
    ['C5-7 계좌번호', j('110-123', '-456789'), true],
    ['C5-8 날짜 뒤 계좌번호', j('2026-10-06 110-123', '-456789'), true],
    ['C5-9 금액 콤마', '1,234,567원', false],
    ['C5-10 일반 가맹점', 'GS25 강남2호점', false],
    ['C5-11 날짜 + 금액', '2026-10-06 15000', false],
  ];
  for (const [name, s, want] of cases) assert.equal(hasSensitiveNumber(s), want, name);
});

test('null·빈 값은 false', () => {
  assert.equal(hasSensitiveNumber(null), false);
  assert.equal(hasSensitiveNumber(undefined), false);
  assert.equal(hasSensitiveNumber(''), false);
});

test('붙여 쓴 일시 단계를 끄면 20xx로 시작하는 12자리 숫자도 걸린다', () => {
  const packed = j('202610', '061230');
  assert.equal(hasSensitiveNumber(packed), false);
  assert.equal(hasSensitiveNumber(packed, { packedDateTime: false }), true);
});

test('removeKnownPatterns는 날짜·시각·천 단위 금액만 지운다', () => {
  assert.equal(removeKnownPatterns('2026-10-06 12:30 abc 15,000원').replace(/ +/g, ' ').trim(), 'abc 원');
  const same = removeKnownPatterns('2026-10-06 x', { sameLength: true });
  assert.equal(same.length, '2026-10-06 x'.length);
});

// 설계 문서 v0.17 민감번호 규칙 — 스키마 검증 L1-1~15와 같은 입력·기대값
// (10자리 이상은 실행 중에 이어 붙인다. 구분자를 사이에 끼워 넣는 방식)
const card = (sep) => ['1234', '5678', '9012', '3456'].join(sep);
test('L1-1~10: 새 구분자·정규화로 잡힌다', () => {
  const cases = [
    ['L1-1 쉼표로 끊은 카드번호', card(',')],
    ['L1-2 콜론', card(':')],
    ['L1-3 엔대시 U+2013', card('\u2013')],
    ['L1-4 폭 없는 공백 U+200B', card('\u200B')],
    ['L1-5 별표', card('*')],
    ['L1-6 아랍-인도 숫자 10자', '\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669\u0660'],
    ['L1-6b 동아랍 숫자 10자', '\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9\u06F0'],
    ['L1-7 빼기 기호 U+2212', ['110', '123', '456789'].join('\u2212')],
    ['L1-7 가운뎃점 U+00B7', ['1234', '5678', '9012'].join('\u00B7')],
    ['L1-7 전각 쉼표', ['1234', '5678', '9012'].join('\uFF0C')],
    ['L1-8 더하기로 이은 전화번호', `+${['82', '10', '1234', '5678'].join('+')}`],
    ['L1-9 쉼표 4자리 묶음 계좌', ['110', '123', '456789'].join(',')],
    ['L1-10 가운데를 가린 6+4 카드번호(설계 판단: 거부)', ['1234', '56**', '****', '7890'].join('-')],
    ['기타 구분자 • ‧ ・ ㆍ', ['1234', '5678', '90'].join('\u2022') + j('\u2027', '1', '\u30FB', '2', '\u318D', '3')],
    ['서식 문자 U+FEFF·U+2066', j('12345', '\uFEFF', '67890', '\u2066')],
  ];
  for (const [name, s] of cases) assert.equal(hasSensitiveNumber(s), true, name);
});

test('L1-11~14: 금액·일시·나열·이미 가린 번호는 오탐 없음', () => {
  const cases = [
    '1,234,567원', '999,999,999', '1,200,000 / 3,400,000', '12,000원, 30,000원',
    '2026-10-06 12:30, 15,000원', '09:00~18:30', '12:30:45',
    '2개 \u00B7 15,000원', '3건 12,000 34,000 56,000', '1+1 행사',
    ['1234', '****', '****', '3456'].join('-'),
  ];
  for (const s of cases) assert.equal(hasSensitiveNumber(s), false, s);
});

test('L1-15: 알려진 오탐(문서화) — 10억 원 이상 금액은 잡힌다', () => {
  assert.equal(hasSensitiveNumber(j('1,234,567', ',890원')), true);
});

test('승인번호 형식 (스키마 검증 M1-1·M1-2)', () => {
  for (const ok of ['12345678', 'AB12CD34', j('1234AB', '567890'), j('A123456789', 'BC')]) {
    assert.equal(approvalNoValid(ok), true, ok);
  }
  for (const bad of [j('12345', '67890'), j('123456', '789012'), j('A12345', '67890'), '123', 'ABCDEFGHIJKLM', '1234-5678', null]) {
    assert.equal(approvalNoValid(bad), false, String(bad));
  }
});

test('maskSensitiveNumbers: 긴 숫자만 가리고 날짜·금액은 남긴다', () => {
  const phone = j('010-1234', '-5678');
  assert.equal(maskSensitiveNumbers(`2026-10-06 12:30 김가짜 ${phone}, 15,000원`),
    `2026-10-06 12:30 김가짜 ${MASK_TEXT}, 15,000원`);
  // 공백은 구분자라 바로 뒤 숫자까지 한 덩어리로 가린다 (DB 판정 단위와 같음)
  assert.equal(maskSensitiveNumbers(`${phone} 15`), MASK_TEXT);
  assert.equal(maskSensitiveNumbers('GS25 강남2호점'), 'GS25 강남2호점');
  assert.equal(hasSensitiveNumber(maskSensitiveNumbers(`메모 ${j('1234 5678', ' 9012 3456')}`)), false);
});

test('마스킹은 검출과 같은 덩어리를 가린다 (날짜를 사이에 둔 숫자)', () => {
  const s = `메모 ${j('12345')} 2026-10-06 ${j('67890')}`;
  assert.equal(hasSensitiveNumber(s), true);
  const masked = maskSensitiveNumbers(s);
  assert.equal(hasSensitiveNumber(masked), false);
  assert.equal(masked, `메모 ${MASK_TEXT}`);
});

test('마스킹도 v0.17 규칙을 따른다: 새 구분자는 가리고 천 단위 금액은 남긴다', () => {
  const masked = maskSensitiveNumbers(`김가짜 ${card(',')} 1,200,000원`);
  assert.equal(masked, `김가짜 ${MASK_TEXT} 1,200,000원`);
  assert.equal(hasSensitiveNumber(masked), false);
  assert.equal(maskSensitiveNumbers(card('\u200B')), MASK_TEXT);
});

test('사용 영역 문자가 있어도 글자를 망가뜨리지 않는다', () => {
  const s = `\uE000\uE0010\uE001 ${j('010-1234', '-5678')}`;
  const masked = maskSensitiveNumbers(s);
  assert.equal(masked, `\uE000\uE0010\uE001 ${MASK_TEXT}`);
  assert.ok(!masked.includes('undefined'));
});

// ---------------------------------------------------------------- QA 결함 D1: 구분자의 NFKC 뒤 모양
import { RUN_SEPARATORS, normalizeForCheck } from '../../app/core/sensitive.js';

test('구분자 목록: 모든 구분자의 NFKC 뒤 모양이 목록 안에 있다 (기계적 점검)', () => {
  for (const c of RUN_SEPARATORS) {
    for (const n of c.normalize('NFKC')) {
      assert.ok(RUN_SEPARATORS.includes(n), `U+${c.codePointAt(0).toString(16).toUpperCase()} → U+${n.codePointAt(0).toString(16).toUpperCase()}`);
    }
  }
});

test('구분자마다 그 구분자 하나만 써서 4자리 묶음 넷을 이으면 잡힌다 (ㆍ U+318D 포함)', () => {
  const groups = ['1234', '5678', '9012', '3456'];
  for (const c of RUN_SEPARATORS) {
    const s = groups.join(c);
    assert.equal(hasSensitiveNumber(s), true, `U+${c.codePointAt(0).toString(16).toUpperCase()}`);
    assert.equal(hasSensitiveNumber(maskSensitiveNumbers(s)), false, `가림 U+${c.codePointAt(0).toString(16).toUpperCase()}`);
  }
  assert.equal(normalizeForCheck('ㆍ'), 'ᆞ'); // 원인
  assert.equal(maskSensitiveNumbers(`김가짜 ${groups.join('ㆍ')} 메모`), `김가짜 ${MASK_TEXT} 메모`);
});

// ---------------------------------------------------------------- 구분자 9자 추가 (설계 문서 v0.17 민감번호 규칙, 최종 26자)
const ADDED_SEPARATORS = [0x2219, 0x22C5, 0x2E31, 0x2E33, 0x2023, 0x2043, 0x25CF, 0x16EB, 0x2981].map((n) => String.fromCodePoint(n));
const hex = (c) => `U+${c.codePointAt(0).toString(16).toUpperCase()}`;

test('구분자 목록: 26자, 추가 9자 포함, 글자 U+A78F·U+11A2는 없음, 중복 없음', () => {
  const list = [...RUN_SEPARATORS];
  assert.equal(list.length, 26);
  assert.equal(new Set(list).size, 26);
  for (const c of ADDED_SEPARATORS) assert.ok(list.includes(c), hex(c));
  assert.ok(!list.includes(String.fromCodePoint(0xA78F)));
  assert.ok(!list.includes(String.fromCodePoint(0x11A2)));
});

test('추가 구분자: 각 문자 단독으로 4-4-4-4를 이으면 잡히고 가려지며, 9자리 이하 이음은 안 잡힌다', () => {
  for (const c of ADDED_SEPARATORS) {
    const s = ['1234', '5678', '9012', '3456'].join(c);
    assert.equal(hasSensitiveNumber(s), true, hex(c));
    assert.equal(maskSensitiveNumbers(`김가짜 ${s} 메모`), `김가짜 ${MASK_TEXT} 메모`, hex(c));
    assert.equal(hasSensitiveNumber(['123', '456', '789'].join(c)), false, `9자리 ${hex(c)}`);
    assert.equal(hasSensitiveNumber(['1234', '5678', '9'].join(c)), false, `9자리 ${hex(c)}`);
    assert.equal(hasSensitiveNumber(['1234', '5678', '90'].join(c)), true, `10자리 ${hex(c)}`);
  }
});

test('글자 U+A78F·U+11A2는 구분자가 아니다: 이를 사이에 둔 숫자는 이어지지 않는다', () => {
  for (const c of [0xA78F, 0x11A2].map((n) => String.fromCodePoint(n))) {
    assert.equal(hasSensitiveNumber(['12345', '67890'].join(c)), false, hex(c));
  }
});

// ---------------------------------------------------------------- DB 9단계와 같은 입력 (SEP-NFKC, SEP-4, SEP-5, SEP-6)
// DB 원문 정규식의 문자 집합. JS 구분자 집합과 정확히 같아야 한다
const DB_RUN_CLASS = '[0-9 ./_()*+,:·•‧・ㆍᆞ∙⋅⸱⸳‣⁃●᛫⦁-]';

test('구분자 집합이 DB 9단계 정규식의 문자 집합과 정확히 같다', () => {
  const db = new Set([...DB_RUN_CLASS.slice('[0-9'.length, -1)]);
  assert.equal(db.size, 26);
  assert.deepEqual([...RUN_SEPARATORS].sort(), [...db].sort());
});

// 1~4단계(NFKC·서식 문자·대시류) 뒤 구분자만 남는 문자를 U+0000~U+2FFFF에서 기계적으로 모은다
// (대시류 U+2010~U+2015·U+2212, 전각 ．／（）등, 공백류 포함). DB 시험의 대시류·전각 12자도 이 안에 든다
const MAPPED_SEPARATORS = [];
for (let cp = 0; cp < 0x30000; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const c = String.fromCodePoint(cp);
  if (RUN_SEPARATORS.includes(c) || /[0-9]/.test(c)) continue;
  const n = normalizeForCheck(c);
  if (n.length > 0 && [...n].every((x) => RUN_SEPARATORS.includes(x))) MAPPED_SEPARATORS.push(c);
}
const SEP_INPUTS = [...RUN_SEPARATORS, ...MAPPED_SEPARATORS];

// DB 시험 SEP-NFKC의 38자 = 구분자 26자 + 대시류 7자 + 전각 5자
const DB_SEP_DASHES = [0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212].map((n) => String.fromCodePoint(n));
const DB_SEP_FULLWIDTH = [0xFF0C, 0xFF1A, 0xFF0A, 0xFF0B, 0xFF65].map((n) => String.fromCodePoint(n));
const DB_SEP_38 = [...RUN_SEPARATORS, ...DB_SEP_DASHES, ...DB_SEP_FULLWIDTH];

test('SEP-NFKC: DB 시험과 같은 38자로 5+5자리를 이으면 잡힌다', () => {
  assert.equal(new Set(DB_SEP_38).size, 38);
  for (const c of DB_SEP_38) assert.equal(hasSensitiveNumber(`12345${c}67890`), true, hex(c));
});

test('SEP-4: DB 시험과 같은 38자로 4+5자리(9자리)를 이으면 안 잡힌다', () => {
  for (const c of DB_SEP_38) assert.equal(hasSensitiveNumber(`1234${c}56789`), false, hex(c));
});

test('SEP-NFKC(전수): 정규화 뒤 구분자가 되는 모든 문자로 5+5자리를 이으면 잡힌다', () => {
  for (const c of [...DB_SEP_DASHES, ...DB_SEP_FULLWIDTH]) assert.ok(MAPPED_SEPARATORS.includes(c), hex(c));
  for (const c of SEP_INPUTS) assert.equal(hasSensitiveNumber(`12345${c}67890`), true, hex(c));
});

test('SEP-4(전수): 같은 문자로 4+5자리(9자리)를 이으면 안 잡힌다', () => {
  for (const c of SEP_INPUTS) assert.equal(hasSensitiveNumber(`1234${c}56789`), false, hex(c));
});

test('SEP-5: U+A78F·U+11A2는 구분자가 아니다', () => {
  for (const c of [0xA78F, 0x11A2].map((n) => String.fromCodePoint(n))) {
    assert.ok(!SEP_INPUTS.includes(c), hex(c));
    assert.equal(hasSensitiveNumber(`12345${c}67890`), false, hex(c));
  }
});

test('SEP-6: ∙ 또는 ●로 끊은 카드번호 모양은 잡힌다', () => {
  const groups = ['1234', '5678', '9012', '3456']; // 파일에 숫자 덩어리를 쓰지 않으려고 실행 중에 잇는다
  assert.equal(hasSensitiveNumber(`결제 ${groups.join('∙')}`), true);
  assert.equal(hasSensitiveNumber(`결제 ${groups.join('●')}`), true);
  assert.equal(hasSensitiveNumber(`결제 1234${'●'.repeat(8)}3456`), false); // 가운데를 가린 번호는 숫자 8자리뿐
});
