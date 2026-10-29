// =====================================================================
// 결제수단 관리 (화면 설계 v0.3 3-1 시안 22 · 3-2 시안 23)
// #/sources          : payment_sources, import_formats, members
// #/source/<id>      : 수정 = 이름·끝 4자리·형식(기관)·매달 올림·사용 중. 거래가 있으면 결제자·종류 잠금(DB LG005)
//                      거래·업로드 묶음 0건이면 지우기(쓰는 곳이 있으면 DB FK 거부)
// #/sourcenew        : 추가 = 위 칸 + 결제자·종류. 시험용(is_test)은 화면에서 만들지 않는다(관리자만)
// - 시험용 결제수단은 목록에 따로 보이고 열면 보기만
// - 끝 4자리 칸은 숫자 4개만(입력 단계에서 숫자 아닌 글자를 지우고 4자에서 자른다)
// 의존: ui/dom.js, router.js, core/confirm.js, core/errors.js, screens/sources-model.js, screens/home-model.js, screens/shell.js
// =====================================================================
import { h } from '../ui/dom.js';
import { buildHash } from '../router.js';
import { confirmDialog } from '../core/confirm.js';
import { STAGES } from '../core/errors.js';
import {
  KINDS, COUNT_CAP, formatOptions, sourceGroups, checkSource, sourcePatch, usageText, deleteSourceErrorText, lockErrorText,
} from './sources-model.js';
import { subjectParticle } from './home-model.js';
import { errorView } from './shell.js';

const SRC_COLUMNS = 'id,owner_member_id,kind,institution,label,last4,import_format_id,is_active,is_test,is_monthly_upload';
const FMT_COLUMNS = 'id,institution,kind,version,file_types';
const eq = (col, value) => ({ col, op: 'eq', value });

let sourcesNotice = null;

function head(title, back, doc, extra = null) {
  return h('header', { class: 'screen-head' }, [
    h('nav', { class: 'month-nav' }, [
      h('a', { class: 'icon-btn', text: '‹', attrs: { href: back, 'aria-label': '뒤로' } }, [], doc),
      h('h1', { class: 'title', text: title }, [], doc),
    ], doc),
    extra,
  ], doc);
}

function failView(title, back, err, onError, doc) {
  onError?.(err);
  return h('main', { class: 'screen' }, [head(title, back, doc), errorView(err.message, err.detail?.sqlState ?? err.code, doc)], doc);
}

// ---------------------------------------------------------------- 목록
export async function renderSources({ db, isCurrent, onError }, doc = globalThis.document) {
  const res = await Promise.all([
    db.select('payment_sources', { columns: SRC_COLUMNS }),
    db.select('import_formats', { columns: FMT_COLUMNS }),
    db.select('members', { columns: 'id,member_slot,display_name' }),
  ]);
  if (!isCurrent()) return null;
  const err = res.find((r) => r.error)?.error;
  if (err) return failView('결제수단', buildHash('more'), err, onError, doc);
  const groups = sourceGroups(res[0].data ?? [], res[1].data ?? [], res[2].data ?? []);
  const status = h('p', { class: 'status-line', attrs: { role: 'status', 'aria-live': 'polite' } }, [], doc);
  if (sourcesNotice) { status.textContent = sourcesNotice; sourcesNotice = null; }
  return h('main', { class: 'screen' }, [
    head('결제수단', buildHash('more'), doc),
    status,
    ...(groups.length === 0 ? [h('p', { class: 'card muted', text: '아직 결제수단이 없어요' }, [], doc)] : groups.flatMap((g) => [
      h('h2', { class: 'section-title' }, [
        g.slot ? h('span', { class: `payer payer-${g.slot === 1 || g.slot === 2 ? g.slot : 0}`, text: String(g.title).slice(0, 1), attrs: { 'aria-hidden': 'true' } }, [], doc) : null,
        g.title,
      ], doc),
      h('ul', { class: 'rule-list card' }, g.rows.map((r) => h('li', {}, [
        h('a', { class: `rule${r.off ? ' off' : ''}`, attrs: { href: buildHash('source', { id: r.id }) } }, [
          h('span', { class: 'rule-main' }, [
            h('span', { class: 'rule-title' }, [r.label, ...r.tags.map((t) => h('span', { class: t === '테스트' ? 'tag dark' : 'tag', text: t }, [], doc))], doc),
            h('span', { class: 'sub', text: r.sub }, [], doc),
          ], doc),
          h('span', { class: 'chev', text: '›', attrs: { 'aria-hidden': 'true' } }, [], doc),
        ], doc),
      ], doc)), doc),
    ])),
    h('a', { class: 'btn primary', text: '+ 결제수단 추가', attrs: { href: buildHash('sourcenew') } }, [], doc),
  ], doc);
}

// ---------------------------------------------------------------- 추가·수정
export async function renderSourceEdit({ db, id = null, go, isCurrent, onError }, doc = globalThis.document) {
  const reads = [
    db.select('import_formats', { columns: FMT_COLUMNS }),
    db.select('members', { columns: 'id,member_slot,display_name' }),
  ];
  if (id) {
    reads.push(
      db.select('payment_sources', { columns: SRC_COLUMNS, filters: [eq('id', id)] }),
      db.select('transactions', { columns: 'id', filters: [eq('source_id', id)], range: { from: 0, to: COUNT_CAP } }),
      db.select('import_batches', { columns: 'id,target_month,uploaded_by,uploaded_at', filters: [eq('source_id', id)], order: [{ col: 'uploaded_at', ascending: false }], range: { from: 0, to: 0 } }),
    );
  }
  const res = await Promise.all(reads);
  if (!isCurrent()) return null;
  const back = buildHash('sources');
  const title = id ? '결제수단' : '결제수단 추가';
  const err = res.find((r) => r.error)?.error;
  if (err) return failView(title, back, err, onError, doc);
  const formats = res[0].data ?? [];
  const members = [...(res[1].data ?? [])].sort((a, b) => a.member_slot - b.member_slot);
  const nameOf = new Map(members.map((m) => [m.id, m.display_name]));
  const original = id ? (res[2].data ?? [])[0] : null;
  if (id && !original) return h('main', { class: 'screen' }, [head(title, back, doc), h('p', { class: 'card muted', text: '결제수단을 찾지 못했어요' }, [], doc)], doc);
  const txnRows = id ? (res[3].data ?? []) : [];
  const capped = txnRows.length > COUNT_CAP;
  const txnCount = Math.min(txnRows.length, COUNT_CAP);
  const lastBatch = id ? (res[4].data ?? [])[0] ?? null : null;
  const locked = Boolean(original) && txnRows.length > 0;
  const readOnly = Boolean(original?.is_test);

  const status = h('p', { class: 'status-line', attrs: { role: 'status', 'aria-live': 'polite' } }, [], doc);
  const say = (msg, isError = false) => { status.textContent = msg; status.className = `status-line${isError ? ' error' : ''}`; };
  const failed = (e, special = null) => {
    const code = onError?.(e, { stage: STAGES.db_update });
    say(special ?? `${e.message}${code ? ` (오류 번호 ${code})` : ''}`, true);
  };

  const label = h('input', { class: 'field', attrs: { 'aria-label': '이름', maxlength: '20' } }, [], doc);
  label.value = original?.label ?? '';
  const last4 = h('input', { class: 'field narrow', attrs: { 'aria-label': '끝 4자리 (선택)', inputmode: 'numeric', maxlength: '4', placeholder: '예: 1234', autocomplete: 'off' } }, [], doc);
  last4.value = original?.last4 ?? '';
  // 숫자 아닌 글자는 지우고 4자에서 자른다(붙여넣기 포함) — 카드·계좌 번호 전체를 넣을 길이 없다
  last4.addEventListener('input', () => { last4.value = last4.value.replace(/[^0-9]/g, '').slice(0, 4); });

  const owner = h('select', { class: 'field', attrs: { 'aria-label': '결제자' } }, members.map((m) => h('option', { text: m.display_name, attrs: { value: m.id } }, [], doc)), doc);
  owner.value = original?.owner_member_id ?? members[0]?.id ?? '';
  const kind = h('select', { class: 'field', attrs: { 'aria-label': '종류' } }, KINDS.map((k) => h('option', { text: k.label, attrs: { value: k.key } }, [], doc)), doc);
  kind.value = original?.kind ?? 'credit_card';
  owner.disabled = locked || readOnly;
  kind.disabled = locked || readOnly;

  const format = h('select', { class: 'field', attrs: { 'aria-label': '기관 · 파일 형식' } }, [], doc);
  const institution = h('input', { class: 'field', attrs: { 'aria-label': '기관 이름', maxlength: '20' } }, [], doc);
  institution.value = original && !original.import_format_id ? original.institution : '';
  const formatWrap = h('div', { class: 'form' }, [h('label', { class: 'field-label', text: '기관 · 파일 형식' }, [], doc), format], doc);
  const instWrap = h('div', { class: 'form' }, [h('label', { class: 'field-label', text: '기관 이름' }, [], doc), institution], doc);
  const monthly = h('input', { attrs: { type: 'checkbox', 'aria-label': '매달 올림' } }, [], doc);
  monthly.checked = original ? original.is_monthly_upload : true;
  const active = h('input', { attrs: { type: 'checkbox', 'aria-label': '사용 중' } }, [], doc);
  active.checked = original ? original.is_active : true;
  const monthlyLine = h('label', { class: 'check-line' }, [
    h('span', {}, [h('span', { text: '매달 올리는 파일' }, [], doc), h('span', { class: 'sub', text: '끄면 홈 “안 올린 파일”에 안 나와요' }, [], doc)], doc), monthly,
  ], doc);

  const refresh = () => {
    const k = kind.value;
    const keep = format.value || original?.import_format_id || '';
    format.replaceChildren(
      ...formatOptions(formats, k).map((f) => h('option', { text: f.label, attrs: { value: f.id } }, [], doc)),
      h('option', { text: '형식 없음(파일을 아직 못 읽음)', attrs: { value: '' } }, [], doc),
    );
    format.value = [...format.options].some((o) => o.value === keep) ? keep : (format.options[0]?.value ?? '');
    formatWrap.hidden = k === 'cash';
    instWrap.hidden = k === 'cash' || Boolean(format.value);
    monthlyLine.hidden = k === 'cash';
  };
  kind.addEventListener('change', refresh);
  format.addEventListener('change', refresh);
  refresh();

  const save = h('button', { class: 'btn primary', text: '저장', attrs: { type: 'button' } }, [], doc);
  const controls = () => [label, last4, owner, kind, format, institution, monthly, active, save];
  const lock = (on) => {
    for (const el of controls()) el.disabled = on;
    if (!on) { owner.disabled = locked; kind.disabled = locked; }
  };
  save.addEventListener('click', async () => {
    const v = checkSource({
      label: label.value, last4: last4.value, ownerId: owner.value, kind: kind.value, formatId: format.value,
      institution: institution.value, isMonthly: monthly.checked, isActive: active.checked,
    }, formats, { locked, original });
    if (!v.ok) { say(v.message, true); return; }
    lock(true);
    if (!original) {
      const r = await db.insert('payment_sources', v.value);
      lock(false);
      if (r.error) { failed(r.error); return; }
      sourcesNotice = `'${v.value.label}'을(를) 더했어요.`;
      go(back);
      return;
    }
    const patch = sourcePatch(original, v.value, { locked });
    if (!Object.keys(patch).length) { lock(false); go(back); return; }
    const r = await db.update('payment_sources', original.id, patch);
    lock(false);
    if (r.error) { failed(r.error, lockErrorText(r.error)); return; }
    if (!r.data?.length) { say('저장하지 못했어요. 새로고침해 주세요.', true); return; }
    sourcesNotice = `'${v.value.label}'을(를) 저장했어요.`;
    go(back);
  });

  let del = null;
  if (original && !readOnly && txnRows.length === 0 && !lastBatch) {
    del = h('button', { class: 'btn mini danger-text', text: '지우기', attrs: { type: 'button' } }, [], doc);
    del.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: `'${original.label}' 지우기`, message: '거래·올린 파일이 없는 결제수단이에요. 잘못 만든 것이면 지워요.', confirmLabel: '지우기', danger: true, doc }))) return;
      lock(true);
      const r = await db.delete('payment_sources', original.id);
      lock(false);
      if (r.error) { failed(r.error, deleteSourceErrorText(r.error)); return; }
      if (!r.data?.length) { say('지우지 못했어요. 새로고침해 주세요.', true); return; }
      sourcesNotice = `'${original.label}'을(를) 지웠어요.`;
      go(back);
    });
  }

  if (readOnly) for (const el of controls()) el.disabled = true;
  return h('main', { class: 'screen' }, [
    head(title, back, doc, del),
    status,
    readOnly ? h('p', { class: 'notice small', text: '시험용 결제수단이에요. 집계·정산·리포트에 안 들어가고, 관리자만 고치거나 지울 수 있어요.' }, [], doc) : null,
    h('section', { class: 'card form' }, [
      h('label', { class: 'field-label', text: '이름' }, [], doc), label,
      h('label', { class: 'field-label', text: '끝 4자리 (선택)' }, [], doc), last4,
      h('p', { class: 'muted small', text: '구별용으로 끝 4자리만 적어요. 전체 번호는 적지 않아요.' }, [], doc),
    ], doc),
    h('section', { class: 'card form' }, [
      h('label', { class: 'field-label', text: `결제자${locked ? ' 🔒' : ''}` }, [], doc), owner,
      h('label', { class: 'field-label', text: `종류${locked ? ' 🔒' : ''}` }, [], doc), kind,
      formatWrap, instWrap,
      locked ? h('p', { class: 'muted small', text: '거래가 있어서 결제자·종류·테스트 여부는 못 바꿔요. 바꾸려면 새 결제수단을 만들고 이것은 꺼 주세요.' }, [], doc) : null,
    ], doc),
    h('section', { class: 'card form' }, [
      monthlyLine,
      h('label', { class: 'check-line' }, [
        h('span', {}, [h('span', { text: '사용 중' }, [], doc), h('span', { class: 'sub', text: '끄면 올리기·추가에서 안 보여요' }, [], doc)], doc), active,
      ], doc),
    ], doc),
    original ? h('p', { class: 'muted small', text: usageText(txnCount, capped, lastBatch, nameOf, subjectParticle) }, [], doc) : null,
    readOnly ? null : save,
  ], doc);
}
