// =====================================================================
// 금액·날짜 표시 (공통 컴포넌트 설계 v0.1 5장)
// - 날짜만 있는 값(date, 'YYYY-MM-DD')은 Date로 바꾸지 않고 문자열을 나눠 쓴다.
//   new Date('2026-10-06')은 UTC로 해석돼 시간대에 따라 하루가 밀릴 수 있다.
// - 시각이 있는 값(timestamptz)은 Asia/Seoul로 표시한다.
// - 결과는 화면에 textContent로만 넣는다.
// 의존 없음.
// =====================================================================

const TIME_ZONE = 'Asia/Seoul';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const MINUS = '−'; // 표시용 빼기 기호 (하이픈과 구분)

const numberFormat = new Intl.NumberFormat('ko-KR');

function assertInteger(n) {
  if (!Number.isSafeInteger(n)) throw new TypeError('금액은 정수여야 합니다');
}

/** 1234567 → '1,234,567원' (음수는 −1,234원) */
export function won(n) {
  assertInteger(n);
  const body = `${numberFormat.format(Math.abs(n))}원`;
  return n < 0 ? `${MINUS}${body}` : body;
}

/** 정산 차이·환불: +4,000원 / −4,000원, 0은 부호 없음 */
export function signedWon(n) {
  assertInteger(n);
  if (n === 0) return won(0);
  return n > 0 ? `+${won(n)}` : won(n);
}

const RE_DATE_ONLY = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** 'YYYY-MM-DD' → { y, m, d } (실제 있는 날짜만). 아니면 null */
export function parseDateOnly(s) {
  const m = RE_DATE_ONLY.exec(typeof s === 'string' ? s : '');
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

/** 오늘(서울) 'YYYY-MM-DD' */
export function todaySeoul(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function daysInMonth(y, m) {
  // Date.UTC로 계산하므로 시간대 영향 없음
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function requireDate(s) {
  const p = parseDateOnly(s);
  if (!p) throw new TypeError('날짜 형식은 YYYY-MM-DD여야 합니다');
  return p;
}

/** 귀속월 'YYYY-MM-01' → '2026년 10월' */
export function month(ym) {
  const { y, m } = requireDate(ym);
  return `${y}년 ${m}월`;
}

/** '2026-10-06' → '10월 6일 (화)' */
export function day(s) {
  const { y, m, d } = requireDate(s);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${m}월 ${d}일 (${WEEKDAYS[w]})`;
}

const dateTimeFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** timestamptz(ISO 문자열 또는 Date) → '2026-10-06 12:30' (서울 시각) */
export function dateTime(ts) {
  const dt = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(dt.getTime())) throw new TypeError('시각 값이 올바르지 않습니다');
  const parts = Object.fromEntries(dateTimeFormat.formatToParts(dt).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** 분담 비율 50 → '50%', 33.33 → '33.33%' (표시만) */
export function ratio(r) {
  if (typeof r !== 'number' || !Number.isFinite(r)) throw new TypeError('비율은 숫자여야 합니다');
  return `${Number(r.toFixed(2))}%`;
}
