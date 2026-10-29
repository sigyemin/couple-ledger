// 가져오기 테스트용 가상 형식과 합성 파일 (실제 기관·형식이 아니다)
// 10자리 이상 숫자는 소스에 그대로 쓰지 않고 실행 중에 이어 붙인다.
import * as XLSX from '../../vendor/xlsx-0.20.3/xlsx.mjs';

export { XLSX };
export const j = (...parts) => parts.join('');

/** 1~9로만 된 무작위 숫자열 (실제 번호 체계의 앞자리·0을 쓰지 않는다) */
export function randDigits(n) {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(n)), (b) => String((b % 9) + 1)).join('');
}
// 실행할 때마다 새로 만드는 가짜 번호들 (기대값은 "가려졌는가"만 본다)
export const FAKE = Object.freeze({
  acct: `${randDigits(4)}-${randDigits(4)}-${randDigits(5)}`,
  phone: `${randDigits(4)}-${randDigits(3)}-${randDigits(4)}`,
  card: `${randDigits(4)}-${randDigits(4)}-${randDigits(4)}-${randDigits(4)}`,
  longApproval: randDigits(10),
});
export const SOURCE = 'a0000000-0000-4000-8000-0000000000a1';
export const CAT_ID = 'c0000000-0000-4000-8000-0000000000c1';

// 형식 A: 통장, 입출금 분리, 일시 한 칸, 잔액(키 전용), 매핑 금지 열 하나
export const FORMAT_A = {
  id: 'f0000000-0000-4000-8000-00000000000a',
  institution: '가상기관A', kind: 'bank_account', version: 1, file_types: ['xlsx', 'xls'],
  header_row: null, header_scan_limit: 10,
  column_map: {
    occurred_at: '거래 일시', amount_out: '나간 돈', amount_in: '들어온 돈', merchant: '내용',
    txn_type: '구분', balance_after: '남은 돈',
  },
  sensitive_headers: ['상대 번호'],
  date_format: 'YYYY.MM.DD HH24:MI[:SS]', time_format: null,
  amount_sign: 'split_columns',
  row_rules: [
    { field: 'txn_type', match: 'exact', value: '카드사용', direction: 'out', kind: 'expense', card_kind: 'check_card' },
    { field: 'txn_type', match: 'exact', value: '카드사용', direction: 'in', kind: 'refund', card_kind: 'check_card' },
    { field: 'merchant', match: 'contains', value: '가짜카드대금', kind: 'transfer', exclude_reason: 'card_bill' },
    { field: 'txn_type', match: 'exact', value: '이자', direction: 'in', kind: 'income', category_code: 'interest' },
  ],
};

// 형식 B: 카드, 날짜·시각 두 칸, 승인번호, 상태 취소 → 환불 행 추가
export const FORMAT_B = {
  id: 'f0000000-0000-4000-8000-00000000000b',
  institution: '가상기관B', kind: 'credit_card', version: 1, file_types: ['xls'],
  header_row: null, header_scan_limit: 10,
  column_map: {
    occurred_on: '쓴 날', occurred_time: '쓴 시각', merchant: '가게', amount: '금액', approval_no: '승인',
    status: '상태', cancel_amount: '취소금액', installment: '할부',
  },
  sensitive_headers: ['카드 번호'],
  date_format: 'YYYY-MM-DD', time_format: 'HH24:MI',
  amount_sign: 'expense_positive',
  row_rules: [
    { field: 'status', match: 'exact', value: '취소', also_refund: true, refund_amount_key: 'cancel_amount' },
  ],
};

// 형식 C: 통장, 부호 금액(쉼표·'원' 문자열), html 허용
export const FORMAT_C = {
  id: 'f0000000-0000-4000-8000-00000000000c',
  institution: '가상기관C', kind: 'bank_account', version: 1, file_types: ['xlsx', 'html'],
  header_row: null, header_scan_limit: 5,
  column_map: { occurred_at: '일시', amount: '금액', merchant: '적요' },
  sensitive_headers: [],
  date_format: 'YYYY-MM-DD HH24:MI:SS', time_format: null,
  amount_sign: 'expense_negative',
  row_rules: [],
};

export function bookBytes(rows, bookType = 'xlsx') {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'S');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType }));
}

// 형식 A 합성 시트: 메타 줄(가짜 계좌번호) → 헤더(공백·줄바꿈 표기 차이) → 데이터 → 합계 꼬리 줄
export function sheetA() {
  const { acct, phone } = FAKE;
  return [
    ['조회 계좌', acct],
    ['조회 기간', '2026.10.01 ~ 2026.10.31'],
    ['거래일시', '구분', '내용', '나간\n돈', '들어온 돈', '남은 돈', '상대 번호'],
    ['2026.10.06 12:30', '카드사용', '가짜마트', '15,000', '', '985,000', acct],
    ['2026.10.06 12:30', '카드사용', '가짜마트', '', '15,000', '1,000,000', acct],
    ['2026.10.07 09:00:05', '이체', `김가짜 ${phone}`, '50,000', '', '950,000', acct],
    ['2026.10.08 10:00', '자동이체', '가짜카드대금 10월', '300,000', '', '650,000', ''],
    ['2026.10.09 11:00', '이체', '이시험', '1,000', '', '649,000', ''],
    ['2026.10.09 11:00', '이체', '이시험', '1,000', '', '648,000', ''],
    ['2026.10.31 23:59', '이자', '예금이자', '', '12', '648,012', ''],
    ['2026.10.10 10:00', '이체', '금액 오류', '12.5', '', '', ''],
    ['합 계', '', '', '367,012', '15,012', '', ''],
  ];
}

export function sheetB() {
  const { card } = FAKE;
  return [
    ['가상 카드 이용내역'],
    ['카드 번호', '쓴 날', '쓴 시각', '가게', '금액', '할부', '승인', '상태', '취소금액'],
    [card, '2026-10-03', '18:20', '가짜식당', '32,000', '일시불', '12345678', '정상', ''],
    [card, '2026-10-04', '09:10', '가짜전자', '600,000', '3개월', 'AB12CD34', '취소', '600,000'],
    [card, '2026-10-05', '10:00', '부분취소상점', '20,000', '', '87654321', '취소', '5,000'],
    [card, '2026-10-06', '11:00', '승인번호이상', '1,000', '', FAKE.longApproval, '정상', ''],
    ['', '', '', '', '', '', '', '', ''],
  ];
}
