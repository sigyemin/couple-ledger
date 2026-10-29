// =====================================================================
// 이체 상대 (화면 설계 v0.2 3-8 시안 17)
// #/cprules            : counterparty_rules, payment_sources, categories
// #/cprule/<id>        : 편집 = 선택(v0.1 4-2와 같은 선택지) + 보일 이름 + 끄기·켜기. 이름·범위는 그대로 보여 준다
// #/cprulenew          : 직접 추가 = 이름·일치 방식·범위(통장·방향) + 선택 + 보일 이름
// #/cpapply/<id>       : apply_counterparty_rule(id, false) 미리보기 → (id, true) 적용 → 변경 기록 상세에서 되돌리기
// - 쓰기: counterparty_rules insert(created_by = 나) · update(바뀐 칸만). 지우기는 두지 않는다(끄기만 — 설계 일관성)
// - 같은 이름·범위 중복은 DB가 거부(23505)
// - 이미 확인한 거래는 바뀌지 않는다(결정 C3). 적용한 거래는 검토가 확인함이 된다(함수 주석)
// 의존: ui/dom.js, router.js, core/confirm.js, core/errors.js, screens/counterparty-model.js, screens/counterparty-card.js, screens/shell.js
// =====================================================================
import { h } from '../ui/dom.js';
import { buildHash } from '../router.js';
import { confirmDialog } from '../core/confirm.js';
import { STAGES } from '../core/errors.js';
import {
  DIRECTIONS, categoryIndex, choiceOf, cpList, scopeText, choiceValues, checkNames, cpPatch, cpPreview, cpChangeLine,
  cpApplyResult, cpErrorText,
} from './counterparty-model.js';
import { choiceCard } from './counterparty-card.js';
import { errorView, rulesTabs } from './shell.js';

const RULE_COLUMNS = [
  'id', 'match_field', 'match_text', 'match_type', 'source_id', 'direction', 'txn_type', 'alias', 'member_id', 'suggested_kind',
  'suggested_exclude_reason', 'suggested_category_id', 'suggested_is_shared', 'priority', 'is_active', 'created_at',
].join(',');
const CAT_COLUMNS = 'id,parent_id,name,code,sort_order,is_active';
const SRC_COLUMNS = 'id,label,kind,owner_member_id,is_active';
const PREVIEW_FIRST = 4;
const PREVIEW_STEP = 20;
const DETAIL_CHUNK = 50;
const eq = (col, value) => ({ col, op: 'eq', value });

let cpNotice = null;

function head(title, back, doc, extra = null) {
  return h('header', { class: 'screen-head' }, [
    h('nav', { class: 'month-nav' }, [
      h('a', { class: 'icon-btn', text: '‹', attrs: { href: back, 'aria-label': '뒤로' } }, [], doc),
      h('h1', { class: 'title', text: title }, [], doc),
    ], doc),
    extra,
  ], doc);
}

function statusLine(doc) {
  const el = h('p', { class: 'status-line', attrs: { role: 'status', 'aria-live': 'polite' } }, [], doc);
  el.say = (msg, isError = false) => { el.textContent = msg; el.className = `status-line${isError ? ' error' : ''}`; };
  return el;
}

function failView(title, back, err, onError, doc) {
  onError?.(err);
  return h('main', { class: 'screen' }, [head(title, back, doc), errorView(err.message, err.detail?.sqlState ?? err.code, doc)], doc);
}

// ---------------------------------------------------------------- 목록
export async function renderCounterparties({ db, isCurrent, onError }, doc = globalThis.document) {
  const [rules, categories, sources] = await Promise.all([
    db.select('counterparty_rules', { columns: RULE_COLUMNS }),
    db.select('categories', { columns: CAT_COLUMNS }),
    db.select('payment_sources', { columns: SRC_COLUMNS }),
  ]);
  if (!isCurrent()) return null;
  const err = rules.error ?? categories.error ?? sources.error;
  if (err) return failView('규칙·카테고리', buildHash('more'), err, onError, doc);
  const cats = categoryIndex(categories.data ?? []);
  const rows = cpList(rules.data ?? [], cats, sources.data ?? []);
  const status = statusLine(doc);
  if (cpNotice) { status.say(cpNotice.text, cpNotice.isError); cpNotice = null; }
  const list = h('ul', { class: 'rule-list card' }, rows.length === 0
    ? [h('li', { class: 'muted', text: '아직 이체 상대가 없어요' }, [], doc)]
    : rows.map((r) => h('li', {}, [
      h('a', { class: `rule${r.off ? ' off' : ''}`, attrs: { href: buildHash('cprule', { id: r.id }) } }, [
        h('span', { class: 'rule-main' }, [
          h('span', { class: 'rule-title' }, [
            r.name, r.alias ? h('span', { class: 'alias', text: ` ${r.alias}` }, [], doc) : null,
            r.off ? h('span', { class: 'tag', text: '꺼짐' }, [], doc) : null,
          ], doc),
          h('span', { class: 'sub', text: r.scope }, [], doc),
        ], doc),
        h('span', { class: 'cp-choice' }, [
          h('span', { text: r.choice }, [], doc),
          r.tag ? h('span', { class: 'sub', text: r.tag }, [], doc) : null,
        ], doc),
        h('span', { class: 'chev', text: '›', attrs: { 'aria-hidden': 'true' } }, [], doc),
      ], doc),
    ], doc)), doc);
  return h('main', { class: 'screen' }, [
    head('규칙·카테고리', buildHash('more'), doc),
    rulesTabs('cprules', doc),
    status,
    h('p', { class: 'muted small', text: '통장에서 사람·계좌와 주고받은 돈을 어떻게 볼지 정한 것이에요. 올리기에서 고른 값이 여기에 쌓여요.' }, [], doc),
    list,
    h('a', { class: 'btn primary', text: '+ 이체 상대 직접 추가', attrs: { href: buildHash('cprulenew') } }, [], doc),
  ], doc);
}

// ---------------------------------------------------------------- 편집·추가
export async function renderCounterpartyEdit({ db, member, id = null, go, isCurrent, onError }, doc = globalThis.document) {
  const reads = [
    db.select('categories', { columns: CAT_COLUMNS }),
    db.select('payment_sources', { columns: SRC_COLUMNS }),
    db.select('members', { columns: 'id,member_slot,display_name' }),
  ];
  if (id) reads.push(db.select('counterparty_rules', { columns: RULE_COLUMNS, filters: [eq('id', id)] }));
  const res = await Promise.all(reads);
  if (!isCurrent()) return null;
  const back = buildHash('cprules');
  const title = id ? '이체 상대' : '이체 상대 직접 추가';
  const err = res.find((r) => r.error)?.error;
  if (err) return failView(title, back, err, onError, doc);
  const categories = res[0].data ?? [];
  const sources = res[1].data ?? [];
  const members = res[2].data ?? [];
  const cats = categoryIndex(categories);
  const original = id ? (res[3].data ?? [])[0] : null;
  if (id && !original) return h('main', { class: 'screen' }, [head(title, back, doc), h('p', { class: 'card muted', text: '이체 상대를 찾지 못했어요' }, [], doc)], doc);
  const status = statusLine(doc);
  const failed = (e) => {
    const code = onError?.(e, { stage: STAGES.db_update });
    status.say(cpErrorText(e) ?? `${e.message}${code ? ` (오류 번호 ${code})` : ''}`, true);
  };
  const radio = (name, value, label, checked) => {
    const r = h('input', { attrs: { type: 'radio', name, value } }, [], doc);
    r.checked = checked;
    return h('label', { class: 'radio' }, [r, label], doc);
  };
  const picked = (name) => main.querySelector(`input[name="${name}"]:checked`)?.value ?? null;

  // 이름·범위: 새로 만들 때만 고친다
  let nameInput = null;
  let srcSel = null;
  const scopeSection = original
    ? h('section', { class: 'card' }, [
      h('p', { class: 'rule-title', text: original.match_type === 'contains' ? `“${original.match_text}” 포함` : original.match_text }, [], doc),
      h('p', { class: 'muted small', text: scopeText(original, sources) }, [], doc),
    ], doc)
    : (() => {
      nameInput = h('input', { class: 'field', attrs: { 'aria-label': '상대 이름(통장 설명 칸 그대로)', maxlength: '100' } }, [], doc);
      const banks = sources.filter((s) => s.kind === 'bank_account' && s.is_active);
      srcSel = h('select', { class: 'field', attrs: { 'aria-label': '어느 통장' } }, [
        h('option', { text: '모든 통장', attrs: { value: '' } }, [], doc),
        ...banks.map((s) => h('option', { text: s.label, attrs: { value: s.id } }, [], doc)),
      ], doc);
      return h('section', { class: 'card form' }, [
        h('label', { class: 'field-label', text: '상대 이름(통장 설명 칸 그대로)' }, [], doc), nameInput,
        h('div', { class: 'radio-group', attrs: { role: 'radiogroup', 'aria-label': '일치 방식' } }, [
          radio('match_type', 'exact', '이름이 똑같으면', true), radio('match_type', 'contains', '이 글자가 들어 있으면', false),
        ], doc),
        h('label', { class: 'field-label', text: '어느 통장' }, [], doc), srcSel,
        h('div', { class: 'radio-group', attrs: { role: 'radiogroup', 'aria-label': '방향' } },
          DIRECTIONS.map((d) => radio('direction', d.key, d.label, d.key === 'out')), doc),
      ], doc);
    })();

  // 선택 카드(업로드 미리보기와 같은 부품)
  const card = choiceCard({ categories, cats, initial: original, direction: original ? original.direction : 'out' }, doc);

  const save = h('button', { class: 'btn primary', text: '저장', attrs: { type: 'button' } }, [], doc);
  const lock = (on) => { for (const el of main.querySelectorAll('button, input, select')) el.disabled = on; card.setDisabled(on); };
  save.addEventListener('click', async () => {
    const input = card.read();
    const names = checkNames({ matchText: original ? null : nameInput.value, alias: input.alias });
    if (!names.ok) { status.say(names.message, true); return; }
    const { choice } = input;
    const direction = original ? (original.direction ?? null) : (picked('direction') || null);
    const sourceId = original ? original.source_id : (srcSel.value || null);
    let values = {};
    if (choice || !card.isCustom) {
      const cv = choiceValues({
        choice, categoryId: input.categoryId, direction,
        sourceOwnerId: sources.find((s) => s.id === sourceId)?.owner_member_id ?? null, meId: member.memberId, members,
      }, cats);
      if (!cv.ok) { status.say(cv.message, true); return; }
      values = cv.value;
    }
    lock(true);
    if (!original) {
      const row = {
        match_field: 'merchant', match_text: names.value.match_text, match_type: picked('match_type') ?? 'exact',
        source_id: sourceId, direction, alias: names.value.alias, ...values, created_by: member.memberId,
      };
      const r = await db.insert('counterparty_rules', row);
      lock(false);
      if (r.error) { failed(r.error); return; }
      const newId = r.data?.[0]?.id;
      if (!newId) { status.say('저장했는지 확인하지 못했어요. 목록에서 확인해 주세요.', true); return; }
      go(buildHash('cpapply', { id: newId }));
      return;
    }
    const { patch, apply } = cpPatch(original, { alias: names.value.alias, ...values });
    if (!Object.keys(patch).length) { lock(false); go(back); return; }
    const r = await db.update('counterparty_rules', original.id, patch);
    lock(false);
    if (r.error) { failed(r.error); return; }
    if (!r.data?.length) { status.say('저장하지 못했어요. 새로고침해 주세요.', true); return; }
    if (apply && original.is_active) { go(buildHash('cpapply', { id: original.id })); return; }
    cpNotice = { text: '저장했어요. 다음 업로드부터 적용돼요.', isError: false };
    go(back);
  });

  let toggle = null;
  if (original) {
    toggle = h('button', { class: 'btn mini', text: original.is_active ? '끄기' : '켜기', attrs: { type: 'button' } }, [], doc);
    toggle.addEventListener('click', async () => {
      const on = !original.is_active;
      if (!on && !(await confirmDialog({
        title: '이체 상대 끄기', message: '다음 업로드부터 이 규칙을 쓰지 않아요. 이미 들어온 거래는 그대로예요.', confirmLabel: '끄기', doc,
      }))) return;
      lock(true);
      const r = await db.update('counterparty_rules', original.id, { is_active: on });
      lock(false);
      if (r.error) { failed(r.error); return; }
      if (!r.data?.length) { status.say('저장하지 못했어요. 새로고침해 주세요.', true); return; }
      if (on) { go(buildHash('cpapply', { id: original.id })); return; }
      cpNotice = { text: '이체 상대 규칙을 껐어요.', isError: false };
      go(back);
    });
  }

  const main = h('main', { class: 'screen' }, [
    head(title, back, doc, toggle),
    status,
    original && !original.is_active ? h('p', { class: 'notice small', text: '꺼진 규칙이에요. 켜야 업로드에 쓰여요.' }, [], doc) : null,
    scopeSection,
    h('section', { class: 'card' }, [card.el], doc),
    h('p', { class: 'muted small', text: '저장하면 다음 업로드부터 적용돼요. 이미 들어온 검토 대기 거래에도 적용할지 다음 화면에서 미리 보여 드려요. 이미 확인한 거래는 바뀌지 않아요.' }, [], doc),
    save,
  ], doc);
  main.addEventListener('change', (e) => { if (e.target.name === 'direction') card.setDirection(e.target.value); });
  return main;
}

// ---------------------------------------------------------------- 검토 대기 거래에 적용
async function readDetails(db, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += DETAIL_CHUNK) {
    const r = await db.select('v_transaction_detail', { columns: 'id,occurred_on,amount,merchant_raw', filters: [{ col: 'id', op: 'in', value: ids.slice(i, i + DETAIL_CHUNK) }] });
    if (r.error) return { error: r.error };
    for (const row of r.data ?? []) out.set(row.id, row);
  }
  return { data: out };
}

export async function renderCounterpartyApply({ db, id, isCurrent, onError }, doc = globalThis.document) {
  const back = buildHash('cprule', { id });
  const title = '검토 대기 거래에도 적용';
  const [rule, categories, sources] = await Promise.all([
    db.select('counterparty_rules', { columns: RULE_COLUMNS, filters: [eq('id', id)] }),
    db.select('categories', { columns: CAT_COLUMNS }),
    db.select('payment_sources', { columns: SRC_COLUMNS }),
  ]);
  if (!isCurrent()) return null;
  const err0 = rule.error ?? categories.error ?? sources.error;
  if (err0) return failView(title, back, err0, onError, doc);
  const r0 = (rule.data ?? [])[0];
  const later = h('a', { class: 'btn secondary', text: '나중에', attrs: { href: buildHash('cprules') } }, [], doc);
  if (!r0 || !r0.is_active) {
    return h('main', { class: 'screen' }, [head(title, back, doc),
      h('p', { class: 'card muted', text: r0 ? '꺼진 규칙은 적용할 수 없어요.' : '이체 상대를 찾지 못했어요' }, [], doc), later], doc);
  }
  const cats = categoryIndex(categories.data ?? []);
  const c = choiceOf(r0, cats);
  const top = h('section', { class: 'card' }, [
    h('p', { class: 'rule-title', text: `${r0.match_type === 'contains' ? `“${r0.match_text}” 포함` : r0.match_text} → ${c.label}${c.tag ? ` · ${c.tag}` : ''}` }, [], doc),
    h('p', { class: 'muted small', text: scopeText(r0, sources.data ?? []) }, [], doc),
  ], doc);
  const preview = await db.rpc('apply_counterparty_rule', { p_rule_id: id, p_apply: false }, { retry: true });
  if (!isCurrent()) return null;
  const status = statusLine(doc);
  if (preview.error) {
    const code = onError?.(preview.error, { stage: STAGES.db_rpc });
    return h('main', { class: 'screen' }, [head(title, back, doc), top,
      errorView(cpErrorText(preview.error) ?? `${preview.error.message}${code ? ` (오류 번호 ${code})` : ''}`, null, doc), later], doc);
  }
  const sum = cpPreview(preview.data ?? []);
  const counts = h('section', { class: 'card' }, [
    h('p', { class: 'amount-l', text: sum.headline }, [], doc),
    h('ul', { class: 'count-list' }, sum.counts.map((x) => h('li', { class: x.key === 'updated' ? 'updated' : '' }, [h('span', { text: x.label }, [], doc), h('span', { text: x.count }, [], doc)], doc)), doc),
  ], doc);
  const changeList = h('ul', { class: 'change-list' }, [], doc);
  const more = h('button', { class: 'btn secondary small-btn', attrs: { type: 'button' } }, [], doc);
  let shown = 0;
  const showMore = async (n) => {
    const next = sum.changed.slice(shown, shown + n);
    more.disabled = true;
    const d = await readDetails(db, next.map((r) => r.txn_id));
    more.disabled = false;
    if (d.error) { const code = onError?.(d.error); status.say(`${d.error.message}${code ? ` (오류 번호 ${code})` : ''}`, true); }
    for (const r of next) {
      const v = cpChangeLine(r, d.data?.get(r.txn_id));
      changeList.append(h('li', { class: 'change-line' }, [
        h('span', { class: 'txn-main' }, [h('span', { class: 'txn-merchant', text: v.merchant }, [], doc), v.sub ? h('span', { class: 'sub', text: v.sub }, [], doc) : null], doc),
        h('span', { class: 'change-to' }, [`${v.from} → `, h('strong', { text: v.to }, [], doc)], doc),
      ], doc));
    }
    shown += next.length;
    const left = sum.changed.length - shown;
    more.textContent = `${left}건 더 보기`;
    more.hidden = left <= 0;
  };
  more.addEventListener('click', () => showMore(PREVIEW_STEP));
  if (sum.changed.length) await showMore(PREVIEW_FIRST);
  if (!isCurrent()) return null;

  const apply = h('button', { class: 'btn primary', text: sum.changeCount ? `${sum.changeCount}건 바꾸기` : '바꿀 거래 없음', attrs: { type: 'button' } }, [], doc);
  apply.disabled = sum.changeCount === 0;
  const result = h('div', {}, [], doc);
  apply.addEventListener('click', async () => {
    apply.disabled = true;
    const r = await db.rpc('apply_counterparty_rule', { p_rule_id: id, p_apply: true, p_description: `이체 상대 “${r0.alias ?? r0.match_text}” 적용`.slice(0, 200) });
    if (r.error) {
      apply.disabled = false;
      const code = onError?.(r.error, { stage: STAGES.db_rpc });
      status.say(cpErrorText(r.error) ?? `${r.error.message}${code ? ` (오류 번호 ${code})` : ''}`, true);
      return;
    }
    const a = cpApplyResult(r.data);
    status.say(a.text);
    apply.hidden = true;
    later.textContent = '이체 상대 목록으로';
    result.replaceChildren(a.batchId ? h('a', { class: 'btn secondary', text: '되돌리기', attrs: { href: buildHash('change', { id: a.batchId }) } }, [], doc) : null);
  });
  return h('main', { class: 'screen' }, [
    head(title, back, doc), status, top, counts,
    sum.changed.length ? h('section', { class: 'card' }, [changeList, more], doc) : null,
    h('p', { class: 'muted small', text: '검토 대기인 통장 거래만 바뀌고, 바뀐 거래는 확인함이 돼요. 이미 확인한 거래는 그대로예요. 바꾼 뒤에도 한 번에 되돌릴 수 있어요.' }, [], doc),
    apply, result, later,
  ], doc);
}
