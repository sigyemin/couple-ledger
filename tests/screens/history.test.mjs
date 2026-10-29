// 거래 상세 기록 모델 (합성 이름만)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyEntries, fieldsText, HISTORY_NOTE } from '../../app/screens/history-model.js';

const ID = (n) => ['00000000', '0000', '4000', '8000', String(n).padStart(12, '0')].join('-');
const A = ID(71);
const B = ID(72);
const nameOf = new Map([[A, '가람'], [B, '나리']]);
const C1 = ID(11);
const C2 = ID(12);
const cats = new Map([[C1, { name: '식재료' }], [C2, { name: '외식' }]]);
const T = (h, m) => `2026-10-14T${String(h - 9).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.123456+00:00`; // 서울 h:m
const row = { id: ID(1), origin: 'import', batch_id: ID(2), created_at: T(9, 31), created_by: A };
const batch = { file_name: '가상카드_2026-10.xls', row_count: 18, uploaded_by: A, uploaded_at: T(9, 30) };

test('올림·분류 바꿈·고침이 최근 순, 묶음과 같은 순간의 수정 기록은 합친다', () => {
  const B1 = ID(601);
  const e = historyEntries({
    row, batch, cats, nameOf,
    items: [{ change_batch_id: B1, target_kind: 'line', old_category_id: C1, new_category_id: C2 }],
    batches: [{ id: B1, kind: 'bulk_edit', created_by: B, created_at: T(20, 12), reverted_at: null, is_reverted: false }],
    edits: [
      { edited_by: B, edited_at: T(20, 15), changed_fields: ['lines', 'memo'] },
      { edited_by: B, edited_at: T(20, 12), changed_fields: ['lines'] }, // 위 묶음과 같은 순간 → 따로 안 보임
      { edited_by: A, edited_at: T(20, 12), changed_fields: ['memo'] }, // 같은 순간이어도 다른 사람이면 그대로
    ],
  });
  assert.deepEqual(e.map((x) => [x.day, x.time, x.title, x.sub, x.href]), [
    ['10월 14일', '20:15', '나리가 고침', '금액 나누기·분류 · 메모', null],
    ['10월 14일', '20:12', '나리가 분류 바꿈', '식재료 → 외식', `#/change/${B1}`],
    ['10월 14일', '20:12', '가람이 고침', '메모', null],
    ['10월 14일', '09:30', '가람이 올림', '가상카드_2026-10.xls · 18행', null],
  ]);
});

test('직접 추가, 되돌린 묶음(꼬리표 + 되돌림 줄), 이체 상대 적용(종류·확인함), 여러 줄은 "외 N줄", 관리자(구성원 아님)', () => {
  const B1 = ID(602);
  const B2 = ID(603);
  const e = historyEntries({
    row: { ...row, origin: 'manual', batch_id: null, created_by: B }, cats, nameOf,
    items: [
      { change_batch_id: B1, target_kind: 'line', old_category_id: null, new_category_id: C1 },
      { change_batch_id: B1, target_kind: 'line', old_category_id: C2, new_category_id: C1 },
      { change_batch_id: B2, target_kind: 'txn', old_kind: 'expense', new_kind: 'transfer', old_review_status: 'needs_review', new_review_status: 'confirmed' },
    ],
    batches: [
      { id: B1, kind: 'rule_reapply', created_by: A, created_at: T(10, 0), reverted_by: B, reverted_at: T(11, 0), is_reverted: true },
      { id: B2, kind: 'counterparty_apply', created_by: A, created_at: T(12, 0), reverted_at: null, is_reverted: false },
    ],
    edits: [
      { edited_by: B, edited_at: T(11, 0), changed_fields: ['lines', 'memo'] }, // 같은 순간의 다른 칸(메모)은 남는다
      { edited_by: null, edited_at: T(13, 0), changed_fields: ['deleted_at', 'zz_new'] },
    ],
  });
  assert.deepEqual(e.map((x) => [x.time, x.title, x.sub, x.tag]), [
    ['13:00', '관리자가 고침', '휴지통·되살리기 · 기타', null],
    ['12:00', '가람이 이체 상대 적용', '종류 지출 → 이체 · 확인함', null],
    ['11:00', '나리가 되돌림', '규칙 다시 적용', null],
    ['11:00', '나리가 고침', '메모', null],
    ['10:00', '가람이 규칙 다시 적용', '미분류 → 식재료 외 1줄', '되돌림'],
    ['09:31', '나리가 직접 추가', '', null],
  ]);
});

test('바뀐 칸 이름: 값은 없이 이름만, 같은 이름은 한 번', () => {
  assert.equal(fieldsText(['merchant_raw', 'merchant_norm', 'is_excluded', 'exclude_reason', 'amount']), '가맹점 · 집계 제외 · 금액');
  assert.match(HISTORY_NOTE, /고치기 전 값은 분류만/);
});
