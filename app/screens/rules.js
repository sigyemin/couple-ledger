// =====================================================================
// 가맹점 규칙 (화면 설계 v0.2 3-5 시안 14 · 3-6 시안 15 · 3-7 시안 16)
// 14 #/rules            : category_rules, categories — 찾기는 앱 메모리에서
// 15 #/rule/<id> · #/rulenew : category_rules insert(새 규칙, created_by = 나) · update(바뀐 칸만, 끄기·켜기 = is_active)
//    지우기는 두지 않는다(라인이 rule_id로 가리켜 DB가 거부할 수 있음 — 끄기만)
// 16 #/reapply/<id>?period=all|year|3m : reapply_category_rule(id, false, from, to) 미리보기 → (id, true, …) 적용
//    → 변경 묶음 id로 변경 기록 상세(#/change/<id>)에서 되돌리기
// - 분류만 바뀌고 검토 상태·정산은 그대로(함수 주석). 결과 건수는 적용 호출의 반환값으로 센다
// 의존: ui/dom.js, router.js, core/confirm.js, core/errors.js, screens/rules-model.js, screens/shell.js
// =====================================================================
import { h } from '../ui/dom.js';
import { buildHash, currentMonth } from '../router.js';
import { dateTime, day } from '../core/format.js';
import { confirmDialog } from '../core/confirm.js';
import { STAGES } from '../core/errors.js';
import {
  PRIORITY_DEFAULT, PREVIEW_FIRST, PREVIEW_STEP, PERIODS, categoryLabels, ruleList, ruleCategoryOptions, checkRule, rulePatch,
  periodRange, previewSummary, changeLine, applyResult, reapplyErrorText,
} from './rules-model.js';
import { errorView, rulesTabs } from './shell.js';
import { subjectParticle } from './home-model.js';

const RULE_COLUMNS = 'id,pattern,match_type,category_id,is_ambiguous,priority,is_active,created_by,created_at';
const CAT_COLUMNS = 'id,parent_id,name,code,sort_order,is_active';
const DETAIL_CHUNK = 50;
const eq = (col, value) => ({ col, op: 'eq', value });

// 다시 그린 목록에 한 번 보여 줄 안내
let rulesNotice = null;

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
  el.say = (msg, isError = false) => {
    el.textContent = msg;
    el.className = `status-line${isError ? ' error' : ''}`;
  };
  return el;
}

function failView(title, back, err, onError, doc) {
  onError?.(err);
  return h('main', { class: 'screen' }, [head(title, back, doc), errorView(err.message, err.detail?.sqlState ?? err.code, doc)], doc);
}

// ---------------------------------------------------------------- 14 목록
export async function renderRules({ db, isCurrent, onError }, doc = globalThis.document) {
  const [rules, categories] = await Promise.all([
    db.select('category_rules', { columns: RULE_COLUMNS }),
    db.select('categories', { columns: CAT_COLUMNS }),
  ]);
  if (!isCurrent()) return null;
  const err = rules.error ?? categories.error;
  if (err) return failView('규칙·카테고리', buildHash('more'), err, onError, doc);
  const cats = categoryLabels(categories.data ?? []);
  const status = statusLine(doc);
  if (rulesNotice) { status.say(rulesNotice.text, rulesNotice.isError); rulesNotice = null; }

  const list = h('ul', { class: 'rule-list card' }, [], doc);
  const draw = (q) => {
    const rows = ruleList(rules.data ?? [], cats, q);
    list.replaceChildren(...(rows.length === 0
      ? [h('li', { class: 'muted', text: q ? '찾는 규칙이 없어요' : '아직 규칙이 없어요' }, [], doc)]
      : rows.map((r) => h('li', {}, [
        h('a', { class: `rule${r.off ? ' off' : ''}`, attrs: { href: buildHash('rule', { id: r.id }) } }, [
          h('span', { class: 'rule-main' }, [
            h('span', { class: 'rule-title' }, [r.title, ...r.tags.map((t) => h('span', { class: 'tag', text: t }, [], doc))], doc),
            h('span', { class: 'sub', text: r.target }, [], doc),
          ], doc),
          h('span', { class: 'rule-pri', text: r.priority }, [], doc),
          h('span', { class: 'chev', text: '›', attrs: { 'aria-hidden': 'true' } }, [], doc),
        ], doc),
      ], doc))));
  };
  const search = h('input', { class: 'field', attrs: { type: 'search', 'aria-label': '규칙 찾기', placeholder: '가맹점 이름이나 카테고리로 찾기', maxlength: '50' } }, [], doc);
  search.addEventListener('input', () => draw(search.value));
  draw('');

  return h('main', { class: 'screen' }, [
    head('규칙·카테고리', buildHash('more'), doc),
    rulesTabs('rules', doc),
    status,
    search,
    h('p', { class: 'muted small', text: '가맹점 이름에 글자가 들어 있으면 그 카테고리로 분류해요. 두 규칙이 겹치면 우선 숫자가 작은 규칙이 이겨요.' }, [], doc),
    list,
    h('a', { class: 'btn primary', text: '+ 규칙 추가', attrs: { href: buildHash('rulenew') } }, [], doc),
  ], doc);
}

// ---------------------------------------------------------------- 15 편집
/**
 * @param {{ db, member, id|null, go(hash), isCurrent(), onError }} ctx — id가 없으면 새 규칙
 */
export async function renderRuleEdit({ db, member, id = null, go, isCurrent, onError }, doc = globalThis.document) {
  const reads = [db.select('categories', { columns: CAT_COLUMNS }), db.select('members', { columns: 'id,display_name' })];
  if (id) reads.push(db.select('category_rules', { columns: RULE_COLUMNS, filters: [eq('id', id)] }));
  const res = await Promise.all(reads);
  if (!isCurrent()) return null;
  const back = buildHash('rules');
  const err = res.find((r) => r.error)?.error;
  if (err) return failView('가맹점 규칙', back, err, onError, doc);
  const categories = res[0].data ?? [];
  const cats = categoryLabels(categories);
  const original = id ? (res[2].data ?? [])[0] : null;
  if (id && !original) {
    return h('main', { class: 'screen' }, [head('가맹점 규칙', back, doc), h('p', { class: 'card muted', text: '규칙을 찾지 못했어요' }, [], doc)], doc);
  }
  const isRegex = original?.match_type === 'regex';
  const status = statusLine(doc);
  const failed = (e, special = null) => {
    const code = onError?.(e, { stage: STAGES.db_update });
    status.say(special ?? `${e.message}${code ? ` (오류 번호 ${code})` : ''}`, true);
  };

  // 칸
  const pattern = h('input', { class: 'field', attrs: { 'aria-label': '가맹점 이름에', maxlength: '100', placeholder: '예: 커피' } }, [], doc);
  pattern.value = original?.pattern ?? '';
  pattern.disabled = isRegex;
  const radio = (value, label) => {
    const r = h('input', { attrs: { type: 'radio', name: 'match_type', value } }, [], doc);
    r.checked = (original?.match_type ?? 'contains') === value;
    r.disabled = isRegex;
    return h('label', { class: 'radio' }, [r, label], doc);
  };
  const matchGroup = h('div', { class: 'radio-group', attrs: { role: 'radiogroup', 'aria-label': '일치 방식' } }, isRegex
    ? [h('p', { class: 'muted small', text: '정규식 규칙이에요. 화면에서는 글자와 방식을 바꿀 수 없어요(카테고리·우선 순서·끄기만).' }, [], doc)]
    : [radio('contains', '이 글자가 들어 있으면'), radio('exact', '이름이 똑같으면')], doc);
  const cat = h('select', { class: 'field', attrs: { 'aria-label': '이 카테고리로' } }, [
    h('option', { text: '카테고리 고르기', attrs: { value: '' } }, [], doc),
    ...ruleCategoryOptions(categories, original?.category_id).map((g) => h('optgroup', { attrs: { label: g.group } },
      g.items.map((it) => h('option', { text: it.name, attrs: { value: it.id } }, [], doc)), doc)),
  ], doc);
  cat.value = original?.category_id ?? '';
  const amb = h('input', { attrs: { type: 'checkbox', 'aria-label': '검토 대기로 두기' } }, [], doc);
  amb.checked = Boolean(original?.is_ambiguous);
  const pri = h('input', { class: 'field narrow', attrs: { 'aria-label': '우선 순서 (작을수록 먼저)', inputmode: 'numeric', maxlength: '4' } }, [], doc);
  pri.value = String(original?.priority ?? PRIORITY_DEFAULT);

  const save = h('button', { class: 'btn primary', text: '저장', attrs: { type: 'button' } }, [], doc);
  const lock = (on) => { for (const el of main.querySelectorAll('button, input, select')) el.disabled = on || (isRegex && (el === pattern || el.name === 'match_type')); };
  save.addEventListener('click', async () => {
    const mt = main.querySelector('input[name="match_type"]:checked')?.value ?? null;
    const v = checkRule({ pattern: pattern.value, matchType: mt, categoryId: cat.value, isAmbiguous: amb.checked, priority: pri.value }, original);
    if (!v.ok) { status.say(v.message, true); return; }
    lock(true);
    if (!original) {
      const r = await db.insert('category_rules', { ...v.value, created_by: member.memberId });
      lock(false);
      if (r.error) { failed(r.error, r.error.code === 'duplicate' ? '이미 같은 규칙이 있어요' : null); return; }
      const newId = r.data?.[0]?.id;
      if (!newId) { status.say('저장했는지 확인하지 못했어요. 목록에서 확인해 주세요.', true); return; }
      go(buildHash('reapply', { id: newId }));
      return;
    }
    const { patch, reapply } = rulePatch(original, v.value);
    if (!Object.keys(patch).length) { go(back); return; }
    const r = await db.update('category_rules', original.id, patch);
    lock(false);
    if (r.error) { failed(r.error); return; }
    if (!r.data?.length) { status.say('저장하지 못했어요. 새로고침해 주세요.', true); return; }
    if (reapply && original.is_active) { go(buildHash('reapply', { id: original.id })); return; }
    rulesNotice = { text: `“${v.value.pattern}” 규칙을 저장했어요.${v.warning ? ` ${v.warning}` : ''}`, isError: false };
    go(back);
  });

  let toggle = null;
  if (original) {
    toggle = h('button', { class: 'btn mini', text: original.is_active ? '끄기' : '켜기', attrs: { type: 'button' } }, [], doc);
    toggle.addEventListener('click', async () => {
      const on = !original.is_active;
      if (!on && !(await confirmDialog({
        title: `“${original.pattern}” 규칙 끄기`,
        message: '다음 업로드부터 이 규칙으로 분류하지 않아요. 이미 분류된 거래는 그대로예요.',
        confirmLabel: '끄기', doc,
      }))) return;
      lock(true);
      const r = await db.update('category_rules', original.id, { is_active: on });
      lock(false);
      if (r.error) { failed(r.error); return; }
      if (!r.data?.length) { status.say('저장하지 못했어요. 새로고침해 주세요.', true); return; }
      if (on) { go(buildHash('reapply', { id: original.id })); return; }
      rulesNotice = { text: `“${original.pattern}” 규칙을 껐어요.`, isError: false };
      go(back);
    });
  }

  const who = original ? (res[1].data ?? []).find((m) => m.id === original.created_by)?.display_name : null;
  const madeBy = original?.created_at
    ? ` ${day(dateTime(original.created_at).slice(0, 10))}${who ? ` ${who}${subjectParticle(who)}` : ''} 만듦.`
    : '';
  const warn = h('p', { class: 'muted small' }, [], doc);
  pattern.addEventListener('input', () => {
    const v = checkRule({ pattern: pattern.value, matchType: 'contains', categoryId: 'x', priority: '0' });
    const mt = main.querySelector('input[name="match_type"]:checked')?.value;
    warn.textContent = v.ok && v.warning && mt === 'contains' ? v.warning : '';
  });

  const main = h('main', { class: 'screen' }, [
    head('가맹점 규칙', back, doc, toggle),
    status,
    original && !original.is_active ? h('p', { class: 'notice small', text: '꺼진 규칙이에요. 켜야 분류에 쓰여요.' }, [], doc) : null,
    h('section', { class: 'card form' }, [
      h('label', { class: 'field-label', text: '가맹점 이름에' }, [], doc), pattern, warn,
      matchGroup,
      h('p', { class: 'muted small', text: '띄어쓰기·전각 문자는 무시하고 비교해요. 예: “동네 커피” “커피집” 둘 다 맞아요.' }, [], doc),
    ], doc),
    h('section', { class: 'card form' }, [
      h('label', { class: 'field-label', text: '이 카테고리로' }, [], doc), cat,
      h('label', { class: 'check-line' }, [
        h('span', {}, [
          h('span', { text: '확정하지 않고 검토 대기로 두기' }, [], doc),
          h('span', { class: 'sub', text: '여러 가지를 파는 곳. 카테고리는 제안으로만 붙어요' }, [], doc),
        ], doc),
        amb,
      ], doc),
    ], doc),
    h('section', { class: 'card form' }, [
      h('label', { class: 'field-label', text: '우선 순서 (작을수록 먼저)' }, [], doc), pri,
      h('p', { class: 'muted small', text: '한 가맹점에 두 규칙이 맞을 때만 쓰여요. 같으면 먼저 만든 규칙이 이겨요.' }, [], doc),
    ], doc),
    h('p', { class: 'muted small', text: `저장하면 다음 업로드부터 적용돼요. 이미 들어온 거래에도 적용할지 다음 화면에서 미리 보여 드려요.${madeBy}` }, [], doc),
    save,
  ], doc);
  return main;
}

// ---------------------------------------------------------------- 16 과거 적용
async function readDetails(db, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += DETAIL_CHUNK) {
    const part = ids.slice(i, i + DETAIL_CHUNK);
    const r = await db.select('v_transaction_detail', { columns: 'id,occurred_on,amount,kind,merchant_raw', filters: [{ col: 'id', op: 'in', value: part }] });
    if (r.error) return { error: r.error };
    for (const row of r.data ?? []) out.set(row.id, row);
  }
  return { data: out };
}

/**
 * @param {{ db, id, query(Map), go(hash), isCurrent(), onError }} ctx
 */
export async function renderReapply({ db, id, query, go, isCurrent, onError }, doc = globalThis.document) {
  const periodKey = PERIODS.some((p) => p.key === query.get('period')) ? query.get('period') : 'all';
  const back = buildHash('rule', { id });
  const [rule, categories] = await Promise.all([
    db.select('category_rules', { columns: RULE_COLUMNS, filters: [eq('id', id)] }),
    db.select('categories', { columns: CAT_COLUMNS }),
  ]);
  if (!isCurrent()) return null;
  const err0 = rule.error ?? categories.error;
  if (err0) return failView('이미 들어온 거래에도 적용', back, err0, onError, doc);
  const r0 = (rule.data ?? [])[0];
  const cats = categoryLabels(categories.data ?? []);
  const title = '이미 들어온 거래에도 적용';
  if (!r0 || !r0.is_active) {
    return h('main', { class: 'screen' }, [head(title, back, doc),
      h('p', { class: 'card muted', text: r0 ? '꺼진 규칙은 적용할 수 없어요. 규칙을 켠 뒤 다시 와 주세요.' : '규칙을 찾지 못했어요' }, [], doc)], doc);
  }
  const range = periodRange(periodKey, currentMonth());
  const args = { p_rule_id: id, p_apply: false, p_from_month: range.from, p_to_month: range.to };
  const preview = await db.rpc('reapply_category_rule', args, { retry: true });
  if (!isCurrent()) return null;

  const status = statusLine(doc);
  const ruleText = `“${r0.pattern}” ${r0.match_type === 'exact' ? '일치' : (r0.match_type === 'regex' ? '정규식' : '포함')} → ${cats.get(r0.category_id)?.label ?? '카테고리 없음'}`;
  const chips = h('div', { class: 'chips', attrs: { role: 'radiogroup', 'aria-label': '기간' } }, PERIODS.map((p) => h('a', {
    class: `chip${p.key === periodKey ? ' on' : ''}`, text: p.label,
    attrs: { role: 'radio', 'aria-checked': p.key === periodKey ? 'true' : 'false', href: buildHash('reapply', { id, query: { period: p.key === 'all' ? null : p.key } }) },
  }, [], doc)), doc);
  const top = h('section', { class: 'card' }, [h('p', { class: 'rule-title', text: ruleText }, [], doc), chips], doc);
  const later = h('a', { class: 'btn secondary', text: '나중에', attrs: { href: buildHash('rules') } }, [], doc);

  if (preview.error) {
    const code = onError?.(preview.error, { stage: STAGES.db_rpc });
    const msg = reapplyErrorText(preview.error) ?? `${preview.error.message}${code ? ` (오류 번호 ${code})` : ''}`;
    return h('main', { class: 'screen' }, [head(title, back, doc), top, errorView(msg, null, doc), later], doc);
  }
  const sum = previewSummary(preview.data ?? [], cats, r0);
  const counts = h('section', { class: 'card' }, [
    h('p', { class: 'amount-l', text: sum.headline }, [], doc),
    h('ul', { class: 'count-list' }, sum.counts.map((c) => h('li', { class: c.key }, [h('span', { text: c.label }, [], doc), h('span', { text: c.count }, [], doc)], doc)), doc),
  ], doc);

  // 바뀌는 거래: 앞 4건 + 더 보기(20건씩). 날짜·금액은 보이는 행만 읽는다
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
      const v = changeLine(r, d.data?.get(r.txn_id), cats);
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
    const r = await db.rpc('reapply_category_rule', { ...args, p_apply: true, p_description: `규칙 “${r0.pattern}” 다시 적용`.slice(0, 200) });
    if (r.error) {
      apply.disabled = false;
      const code = onError?.(r.error, { stage: STAGES.db_rpc });
      status.say(reapplyErrorText(r.error) ?? `${r.error.message}${code ? ` (오류 번호 ${code})` : ''}`, true);
      return;
    }
    const a = applyResult(r.data);
    status.say(a.text);
    apply.hidden = true;
    later.textContent = '규칙 목록으로';
    result.replaceChildren(a.batchId
      ? h('a', { class: 'btn secondary', text: '되돌리기', attrs: { href: buildHash('change', { id: a.batchId }) } }, [], doc)
      : null);
  });

  return h('main', { class: 'screen' }, [
    head(title, back, doc), status, top, counts,
    sum.changed.length ? h('section', { class: 'card' }, [changeList, more], doc) : null,
    h('p', { class: 'muted small', text: r0.is_ambiguous
      ? '검토 대기로 두는 규칙이라 카테고리는 제안으로 붙어요(검토 대기는 그대로).'
      : '분류만 바뀌고 정산 숫자는 그대로라 확인 완료한 달에 “확인 후 변경됨”이 뜨지 않아요. 바꾼 뒤에도 한 번에 되돌릴 수 있어요.' }, [], doc),
    apply, result, later,
  ], doc);
}
