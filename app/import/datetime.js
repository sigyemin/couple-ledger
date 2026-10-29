// =====================================================================
// 날짜·시각 형식 읽기 (스키마 import_formats.date_format·time_format)
// 표기: YYYY MM DD HH24 MI SS, [ ]는 있어도 없어도 되는 부분 (예: 'YYYY-MM-DD HH24:MI[:SS]')
// 셀 값 전체가 형식과 맞아야 한다. 실제 있는 날짜·시각만 받는다.
// 결과: { date: 'YYYY-MM-DD' | null, time: 'HH:MI' | 'HH:MI:SS' | null } — 초는 파일에 있을 때만
// 의존: core/format.js
// =====================================================================
import { parseDateOnly } from '../core/format.js';

const TOKENS = [
  ['HH24', 'hour', '([0-9]{1,2})'],
  ['YYYY', 'year', '([0-9]{4})'],
  ['MM', 'month', '([0-9]{1,2})'],
  ['DD', 'day', '([0-9]{1,2})'],
  ['MI', 'minute', '([0-9]{2})'],
  ['SS', 'second', '([0-9]{2})'],
];

const escapeChar = (c) => (/[\\^$.*+?()|{}]/.test(c) ? `\\${c}` : c);

/** 형식 문자열 → { re, fields } (형식이 틀리면 TypeError) */
export function compileFormat(fmt) {
  if (typeof fmt !== 'string' || !fmt || fmt.length > 40) throw new TypeError('날짜 형식이 올바르지 않습니다');
  const fields = [];
  let src = '';
  let depth = 0;
  for (let i = 0; i < fmt.length;) {
    const c = fmt[i];
    if (c === '[') {
      src += '(?:';
      depth++;
      i++;
      continue;
    }
    if (c === ']') {
      if (depth === 0) throw new TypeError('날짜 형식의 괄호가 맞지 않습니다');
      src += ')?';
      depth--;
      i++;
      continue;
    }
    const tok = TOKENS.find(([t]) => fmt.startsWith(t, i));
    if (tok) {
      if (fields.includes(tok[1])) throw new TypeError('날짜 형식에 같은 칸이 두 번 있습니다');
      fields.push(tok[1]);
      src += tok[2];
      i += tok[0].length;
      continue;
    }
    if (/[A-Za-z]/.test(c)) throw new TypeError('날짜 형식에 모르는 글자가 있습니다');
    src += escapeChar(c);
    i++;
  }
  if (depth !== 0) throw new TypeError('날짜 형식의 괄호가 맞지 않습니다');
  return { re: new RegExp(`^${src}$`), fields };
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 셀 값을 형식대로 읽는다. 맞지 않으면 null */
export function parseWith(compiled, value) {
  const s = String(value ?? '').normalize('NFKC').trim();
  const m = compiled.re.exec(s);
  if (!m) return null;
  const v = Object.create(null);
  compiled.fields.forEach((f, i) => {
    if (m[i + 1] !== undefined) v[f] = Number(m[i + 1]);
  });
  let date = null;
  if (v.year !== undefined || v.month !== undefined || v.day !== undefined) {
    if (v.year === undefined || v.month === undefined || v.day === undefined) return null;
    date = `${v.year}-${pad2(v.month)}-${pad2(v.day)}`;
    if (!parseDateOnly(date)) return null;
  }
  let time = null;
  if (v.hour !== undefined) {
    if (v.minute === undefined || v.hour > 23 || v.minute > 59) return null;
    if (v.second !== undefined && v.second > 59) return null;
    time = `${pad2(v.hour)}:${pad2(v.minute)}${v.second !== undefined ? `:${pad2(v.second)}` : ''}`;
  }
  if (!date && !time) return null;
  return { date, time };
}
