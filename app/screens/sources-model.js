// =====================================================================
// 결제수단 관리 — 화면 없이 계산하는 부분 (화면 설계 v0.3 3-1 시안 22, 3-2 시안 23)
// - 목록: 구성원별 묶음(자리 순) + 시험용 묶음 따로. 사용 중 먼저, 같은 안에서 이름 순, 꺼진 것은 아래
// - 끝 4자리: 정확히 숫자 4개만(빈칸 = 없음). 그 밖의 숫자·전체 번호를 넣을 길이 없다. DB도 CHECK ^[0-9]{4}$
// - 종류: 신용카드 / 통장(체크카드 포함) / 현금. check_card는 선택지에 없음(체크카드 사용은 통장 행이 원천)
// - 시험용(is_test)은 화면에서 만들지 않는다(시험 데이터는 관리자만 — 총괄 지시 10-29). 시험용 결제수단은 보기만
// - 거래가 있으면 결제자·종류 잠금(DB LG005). 거래·업로드 묶음이 0건일 때만 지우기
// - 기관(institution, DB 필수): 파일 형식을 고르면 그 형식의 기관, 현금은 '현금', 형식 없음이면 직접 입력 [판단]
// 의존: core/validate.js, core/format.js
// =====================================================================
import { text as checkText } from '../core/validate.js';
import { month, dateTime, day } from '../core/format.js';

export const KINDS = Object.freeze([
  { key: 'credit_card', label: '신용카드' },
  { key: 'bank_account', label: '통장(체크카드 포함)' },
  { key: 'cash', label: '현금' },
]);
const KIND_LABEL = { credit_card: '신용카드', bank_account: '통장', check_card: '체크카드', cash: '현금' };
export const CASH_INSTITUTION = '현금';
export const COUNT_CAP = 2000;

/** 끝 4자리: 빈칸 → null, 숫자 정확히 4개 → 그 값, 그 밖 → 오류 */
export function checkLast4(v) {
  const s = String(v ?? '').trim();
  if (!s) return { ok: true, value: null };
  if (!/^[0-9]{4}$/.test(s)) return { ok: false, message: '끝 4자리는 숫자 4개만 넣을 수 있어요' };
  return { ok: true, value: s };
}

/** 형식 고르기: 같은 종류의 형식만(기관 이름 순). 현금은 없음 */
export function formatOptions(formats, kind) {
  if (kind === 'cash') return [];
  return (formats ?? []).filter((f) => f.kind === kind)
    .sort((a, b) => a.institution.localeCompare(b.institution) || (b.version ?? 1) - (a.version ?? 1))
    .map((f) => ({ id: f.id, label: `${f.institution}${f.file_types?.length ? ` (${f.file_types.join('·')})` : ''}` }));
}

/** 목록 한 줄 */
export function sourceRow(s, formatsById, nameOf) {
  const f = s.import_format_id ? formatsById.get(s.import_format_id) : null;
  const tags = [];
  if (s.is_test) tags.push('테스트');
  if (!s.is_active) tags.push('꺼짐');
  if (s.kind !== 'cash' && !s.import_format_id) tags.push('형식 없음');
  else if (s.kind !== 'cash' && !s.is_monthly_upload) tags.push('가끔 올림');
  let sub;
  if (s.is_test) sub = `${nameOf.get(s.owner_member_id) ?? '?'} · 집계·정산·리포트에 안 들어가요`;
  else if (s.kind === 'cash') sub = '현금 · 직접 추가만';
  else if (!f) sub = `${KIND_LABEL[s.kind] ?? s.kind} · 파일을 아직 못 읽어요`;
  else sub = `${KIND_LABEL[s.kind] ?? s.kind} · ${f.institution} 형식 · ${s.is_monthly_upload ? '매달 올림' : '직접 쓴 달만'}`;
  return { id: s.id, label: s.last4 ? `${s.label} ··${s.last4}` : s.label, tags, sub, off: !s.is_active };
}

/** 구성원별 묶음 + 시험용 묶음. members 자리 순 */
export function sourceGroups(sources, formats, members) {
  const formatsById = new Map((formats ?? []).map((f) => [f.id, f]));
  const nameOf = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const order = (a, b) => (b.is_active === true) - (a.is_active === true) || String(a.label).localeCompare(String(b.label));
  const groups = [...(members ?? [])].sort((a, b) => a.member_slot - b.member_slot).map((m) => ({
    key: m.id, title: m.display_name, slot: m.member_slot,
    rows: (sources ?? []).filter((s) => !s.is_test && s.owner_member_id === m.id).sort(order).map((s) => sourceRow(s, formatsById, nameOf)),
  })).filter((g) => g.rows.length);
  const tests = (sources ?? []).filter((s) => s.is_test).sort(order).map((s) => sourceRow(s, formatsById, nameOf));
  if (tests.length) groups.push({ key: 'test', title: '시험용', slot: 0, rows: tests });
  return groups;
}

/**
 * 입력 검사 → 저장 값(시험용 칸 없음)
 * @param input { label, last4, ownerId, kind, formatId, institution, isMonthly, isActive }
 */
export function checkSource(input, formats, { locked = false, original = null } = {}) {
  const l = checkText(input.label, 'source_label', { required: true });
  if (!l.ok) return { ok: false, field: 'label', message: l.message };
  const d = checkLast4(input.last4);
  if (!d.ok) return { ok: false, field: 'last4', message: d.message };
  const ownerId = locked ? original.owner_member_id : input.ownerId;
  const kind = locked ? original.kind : input.kind;
  if (!ownerId) return { ok: false, field: 'owner', message: '결제자를 골라 주세요' };
  if (!KINDS.some((k) => k.key === kind) && !(locked && kind)) return { ok: false, field: 'kind', message: '종류를 골라 주세요' };
  let formatId = kind === 'cash' ? null : (input.formatId || null);
  let institution;
  if (kind === 'cash') institution = CASH_INSTITUTION;
  else if (formatId) {
    const f = (formats ?? []).find((x) => x.id === formatId && x.kind === kind);
    if (!f) return { ok: false, field: 'format', message: '종류에 맞는 형식을 골라 주세요' };
    institution = f.institution;
  } else {
    const inst = checkText(input.institution, 'source_label', { required: true });
    if (!inst.ok) return { ok: false, field: 'institution', message: inst.reason === 'required' ? '기관 이름을 넣어 주세요' : inst.message };
    institution = inst.value;
    formatId = null;
  }
  return {
    ok: true,
    value: {
      owner_member_id: ownerId, kind, institution, label: l.value, last4: d.value, import_format_id: formatId,
      is_monthly_upload: kind === 'cash' ? false : Boolean(input.isMonthly), is_active: Boolean(input.isActive),
    },
  };
}

/** 바뀐 칸만(잠긴 칸은 빼고) */
export function sourcePatch(original, value, { locked }) {
  const patch = {};
  const keys = ['label', 'last4', 'import_format_id', 'institution', 'is_monthly_upload', 'is_active'];
  if (!locked) keys.push('owner_member_id', 'kind');
  for (const k of keys) if ((original[k] ?? null) !== (value[k] ?? null)) patch[k] = value[k];
  return patch;
}

/** 아래 정보: "거래 37건 · 마지막 파일 9월분 (9월 3일 가람이 올림)" */
export function usageText(txnCount, capped, lastBatch, nameOf, particle) {
  const n = capped ? `거래 ${COUNT_CAP.toLocaleString('ko-KR')}건 넘음` : `거래 ${txnCount}건`;
  if (!lastBatch) return `${n} · 올린 파일 없음`;
  const who = nameOf.get(lastBatch.uploaded_by);
  const when = day(dateTime(lastBatch.uploaded_at).slice(0, 10)).replace(/ \(.\)$/, '');
  return `${n} · 마지막 파일 ${month(lastBatch.target_month).replace(/^[0-9]+년 /, '')}분 (${when}${who ? ` ${who}${particle(who)}` : ''} 올림)`;
}

/** 지우기 실패 안내(쓰는 곳이 있으면 FK 23503) */
export function deleteSourceErrorText(err) {
  return err?.detail?.sqlState === '23503' ? '쓰는 거래·규칙이 있어 지울 수 없어요. 꺼 주세요.' : null;
}

/** 잠금 안내(DB LG005): 거래가 있는 결제수단의 결제자·종류, 또는 시험용 여부(v0.18 — 관리자만) */
export function lockErrorText(err) {
  return err?.detail?.sqlState === 'LG005'
    ? '바꿀 수 없는 값이에요. 거래가 있으면 결제자·종류는 못 바꾸고(새 결제수단을 만들고 이것은 꺼 주세요), 시험용 여부는 관리자만 정해요.'
    : null;
}
