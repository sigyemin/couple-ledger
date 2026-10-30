// =====================================================================
// 가맹점별로 분류하기 #/classify (CL-061): 모든 달의 미분류 거래를 가맹점으로 묶어 한 번에 분류
// 조회: v_transaction_detail(is_uncategorized, 휴지통·시험 결제수단 제외, 쪽 단위, 최대 MAX_ROWS), categories
// 쓰기(묶음마다): bulk_set_category(변경 기록 — 되돌리기 가능) → 확인함으로(transactions update, 월 검토와 같음)
//               → '앞으로 같은 가맹점 자동 분류'면 category_rules insert(정리값 똑같으면, 확정 — 또는 사용자가 줄인 글자가 들어가면). 같은 규칙이 이미 있으면 건너뜀
//               (만들기 전에 같은 규칙 — 방식·정리값 패턴·카테고리 — 이 켜져 있는지 조회: DB에 유일 제약 없음, 리뷰 ④)
// - 맨 위 '켜진 규칙으로 한 번에 분류'(v0.22): reapply_all_category_rules 미리보기(p_apply=false) → result별 건수 확인 →
//   적용(p_apply=true) — 변경 묶음 하나. 시간 초과(57014)·5,000건 초과(LG007)면 귀속월 기간을 반씩 나눠 다시(기간마다 묶음 하나)
// - 통장 이체 행 묶음은 이름을 보여 주되 규칙은 이체 상대 규칙 쪽으로 안내
// 의존: ui/dom.js, router.js, core/confirm.js, core/errors.js, screens/merchant-classify-model.js, screens/category-picker.js,
//       screens/review-model.js(confirmBothPatch), screens/merchant-rule.js(규칙 저장), screens/shell.js
// =====================================================================
import { h } from '../ui/dom.js';
import { buildHash } from '../router.js';
import { confirmDialog } from '../core/confirm.js';
import { STAGES, ACTIONS } from '../core/errors.js';
import {
  merchantGroups, groupSub, ruleFor, classifyText, classifyDescription,
  reapplyAllSummary, addSummary, splitRange, shouldSplit, rangeText, reapplyAllText,
} from './merchant-classify-model.js';
import { reapplyErrorText } from './rules-model.js';
import { categoryPicker } from './category-picker.js';
import { saveMerchantRule } from './merchant-rule.js';
import { confirmBothPatch } from './review-model.js';
import { errorView } from './shell.js';

const COLUMNS = 'id,merchant_raw,merchant_norm,kind,amount,lines,review_status,source_kind,card_kind,period_month,is_uncategorized,is_test_source';
const PAGE_SIZE = 1000;
const eq = (col, value) => ({ col, op: 'eq', value });
export const MAX_ROWS = 3000;

// 다시 그린 화면에 한 번 보여 줄 안내
let classifyNotice = null;

/** 미분류 거래를 쪽 단위로 끝까지(빈 쪽까지, id로 중복 거름) */
export async function readUncategorized(db, { pageSize = PAGE_SIZE, max = MAX_ROWS } = {}) {
  const rows = [];
  const seen = new Set();
  let offset = 0;
  while (rows.length <= max) {
    const r = await db.select('v_transaction_detail', {
      columns: COLUMNS,
      filters: [
        { col: 'is_uncategorized', op: 'eq', value: true }, { col: 'deleted_at', op: 'is', value: null },
        { col: 'is_test_source', op: 'eq', value: false },
      ],
      order: [{ col: 'id', ascending: true }],
      range: { from: offset, to: offset + Math.min(pageSize, max + 1 - rows.length) - 1 },
    });
    if (r.error) return { error: r.error };
    const page = r.data ?? [];
    if (page.length === 0) break;
    offset += page.length;
    for (const row of page) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
  }
  return { data: { rows: rows.slice(0, max), capped: rows.length > max } };
}

/**
 * @param {{ db, member, reload(), isCurrent(), onError(err, extra) → string }} ctx
 */
export async function renderMerchantClassify({ db, member, reload, isCurrent, onError }, doc = globalThis.document) {
  const [txns, cats] = await Promise.all([
    readUncategorized(db),
    db.select('categories', { columns: 'id,parent_id,name,code,sort_order,is_active' }),
  ]);
  if (!isCurrent()) return null;
  const head = h('header', { class: 'screen-head' }, [
    h('nav', { class: 'month-nav' }, [
      h('a', { class: 'icon-btn', text: '‹', attrs: { href: buildHash('more'), 'aria-label': '더보기로' } }, [], doc),
      h('h1', { class: 'title', text: '가맹점별로 분류하기' }, [], doc),
    ], doc),
  ], doc);
  const error = txns.error ?? cats.error;
  if (error) {
    onError?.(error);
    return h('main', { class: 'screen' }, [head, errorView(error.message, error.detail?.sqlState ?? error.code, doc)], doc);
  }
  const categories = cats.data ?? [];
  const groups = merchantGroups(txns.data.rows);

  const status = h('p', { class: 'status-line', attrs: { role: 'status', 'aria-live': 'polite' } }, [], doc);
  // link: { href, text } — 안내 끝에 붙는 앱 안 링크(같은 패턴 다른 카테고리 규칙 → 규칙 화면)
  const say = (msg, isError = false, link = null) => {
    status.replaceChildren(msg, ...(link ? [' ', h('a', { text: link.text, attrs: { href: link.href } }, [], doc)] : []));
    status.className = `status-line${isError ? ' error' : ''}`;
  };
  if (classifyNotice) { say(classifyNotice.text, classifyNotice.isError, classifyNotice.link); classifyNotice = null; }
  const fail = (err, extra) => {
    const code = onError?.(err, extra);
    say(`${err.message}${code ? ` (오류 번호 ${code})` : ''}`, true);
  };
  const done = (text, isError = false, link = null) => { classifyNotice = { text, isError, link }; reload(); };

  const groupItem = (g) => {
    const pick = categoryPicker({ categories, kind: g.kind, label: `${g.merchant} 카테고리`, doc });
    const rule = h('input', { attrs: { type: 'checkbox', 'aria-label': `앞으로 ${g.merchant} 자동 분류` } }, [], doc);
    rule.checked = g.canRule;
    // 같은 브랜드 다른 지점: 글자를 줄여 '들어가면 모두'로(사용자가 고칠 때만)
    const wide = h('input', { attrs: { type: 'checkbox', 'aria-label': `${g.merchant} 글자가 들어가면 모두` } }, [], doc);
    const widePattern = h('input', { class: 'field', attrs: { 'aria-label': `${g.merchant} 규칙 글자(줄여 쓰기)`, maxlength: '100' } }, [], doc);
    widePattern.value = g.merchant;
    const wideBox = h('div', { class: 'mc-wide', attrs: { hidden: true } }, [
      widePattern, h('p', { class: 'muted small', text: '예: 지점 이름을 지우면 같은 브랜드 모든 지점에 맞아요.' }, [], doc),
    ], doc);
    wide.addEventListener('change', () => { wideBox.hidden = !wide.checked; });
    rule.addEventListener('change', () => { wide.disabled = !rule.checked; if (!rule.checked) { wide.checked = false; wideBox.hidden = true; } });
    const go = h('button', { class: 'btn primary small-btn', text: `${g.count}건 분류`, attrs: { type: 'button' } }, [], doc);
    const lock = (on) => {
      go.disabled = on; rule.disabled = on || !g.canRule; pick.setDisabled(on);
      wide.disabled = on || !g.canRule || !rule.checked; widePattern.disabled = on;
    };
    lock(false);
    go.addEventListener('click', async () => {
      if (!pick.value) { say(`${g.merchant}: 카테고리를 골라 주세요`, true); return; }
      const name = pick.selectedName;
      const makeRule = g.canRule && rule.checked;
      const rv = makeRule ? ruleFor(g, pick.value, { contains: wide.checked ? widePattern.value : null }) : null;
      if (rv && !rv.ok) { say(`규칙을 만들 수 없어요: ${rv.message}. 체크를 끄고 분류만 할 수 있어요.`, true); return; }
      const text = classifyText(g, name, makeRule, rv?.value);
      if (rv?.warning) text.message += ` (${rv.warning})`;
      if (!(await confirmDialog({ ...text, confirmLabel: '분류하기', doc }))) return;
      lock(true);
      const r = await db.rpc('bulk_set_category', { p_txn_ids: g.ids, p_category_id: pick.value, p_description: classifyDescription(g, name) });
      if (r.error) { lock(false); fail(r.error, { stage: STAGES.db_rpc, action: ACTIONS.bulk_edit }); return; }
      // 확인함으로(이미 확인함은 건너뜀). 실패하면 멈추고 몇 건 됐는지 알림
      let confirmed = 0;
      for (const id of g.toConfirm) {
        if (g.toConfirm.length > 1) say(`확인함으로 바꾸는 중 ${confirmed + 1}/${g.toConfirm.length}`);
        const u = await db.update('transactions', id, confirmBothPatch(member.memberId));
        if (u.error || !u.data?.length) {
          const code = u.error ? onError?.(u.error, { stage: STAGES.db_update, txnId: id }) : null;
          done(`${g.count}건을 '${name}'(으)로 분류했지만 확인함으로는 ${confirmed}건만 바꿨어요${makeRule ? '(규칙은 만들지 않았어요)' : ''}.${code ? ` (오류 번호 ${code})` : ''}`, true);
          return;
        }
        confirmed += 1;
      }
      let ruleNote = '';
      let ruleLink = null;
      if (makeRule) {
        const sr = await saveMerchantRule({ db, member, value: rv.value, categories, onError });
        if (!sr.ok) { done(`${g.count}건을 '${name}'(으)로 분류했지만 ${sr.text}`, true); return; }
        ruleNote = sr.note;
        ruleLink = sr.link;
      }
      done(ruleLink
        ? `${g.merchant} ${g.count}건을 '${name}'(으)로 분류했어요.${ruleNote}`
        : `${g.merchant} ${g.count}건을 '${name}'(으)로 분류했어요.${ruleNote} 변경 기록에서 되돌릴 수 있어요.`, false, ruleLink);
    });
    return h('li', { class: 'mc-item' }, [
      h('div', { class: 'mc-head' }, [
        h('strong', { class: 'mc-name', text: g.merchant }, [], doc),
        g.transferLike ? h('span', { class: 'tag', text: '이체 상대' }, [], doc) : null,
        g.kind === 'income' ? h('span', { class: 'tag', text: '수입' }, [], doc) : null,
      ], doc),
      h('p', { class: 'muted small', text: groupSub(g) }, [], doc),
      pick,
      g.canRule
        ? h('div', { class: 'mc-rule' }, [
          h('label', { class: 'filter-check' }, [rule, h('span', { text: '앞으로 같은 가맹점 자동 분류(가맹점 규칙 만들기)' }, [], doc)], doc),
          h('label', { class: 'filter-check' }, [wide, h('span', { text: '이 글자가 들어가면 모두(지점이 달라도)' }, [], doc)], doc),
          wideBox,
        ], doc)
        : (g.transferLike
          ? h('p', { class: 'muted small' }, [
            '통장 이체예요. 앞으로 자동으로 하려면 ',
            h('a', { text: '이체 상대 규칙', attrs: { href: buildHash('cprules') } }, [], doc),
            '에서 정해요.',
          ], doc)
          : h('p', { class: 'muted small', text: '수입은 가맹점 규칙 없이 분류만 해요.' }, [], doc)),
      go,
    ], doc);
  };

  // 켜진 규칙으로 한 번에 분류: 규칙마다 미리보기(p_apply=false) → 합계 확인 → 적용(p_apply=true), 기간 전체, 적용 순서대로
  const bulkBtn = h('button', { class: 'btn secondary', text: '켜진 규칙으로 한 번에 분류', attrs: { type: 'button' } }, [], doc);
  // 잠글 때 원래 상태를 적어 두고 풀 때 되돌린다(묶음별로 꺼 둔 체크·버튼이 풀리지 않게 — 재리뷰 낮음)
  let locked = null;
  const lockAll = (on) => {
    if (on) {
      locked = [...main.querySelectorAll('button, input, select')].map((el) => [el, el.disabled]);
      for (const [el] of locked) el.disabled = true;
    } else if (locked) {
      for (const [el, was] of locked) el.disabled = was;
      locked = null;
    }
  };
  // 거래가 든 귀속월 처음·끝(기간을 나눌 때만 읽는다)
  async function monthSpan() {
    const one = (ascending) => db.select('v_transaction_detail', {
      columns: 'period_month', filters: [{ col: 'deleted_at', op: 'is', value: null }, eq('is_test_source', false)],
      order: [{ col: 'period_month', ascending }], range: { from: 0, to: 0 },
    });
    const [a, b] = await Promise.all([one(true), one(false)]);
    if (a.error || b.error) return { error: a.error ?? b.error };
    const from = a.data?.[0]?.period_month;
    const to = b.data?.[0]?.period_month;
    return from && to ? { data: { from: String(from).slice(0, 10), to: String(to).slice(0, 10) } } : { data: null };
  }

  /**
   * 미리보기: 모든 달을 한 번에. 시간 초과(57014)·5,000건 초과(LG007)면 기간을 반씩 나눠 다시(달 하나까지)
   * @returns {{ ranges: { from, to, summary }[] } | { error, range }}
   */
  async function previewAll() {
    const call = (r) => db.rpc('reapply_all_category_rules', { p_apply: false, p_from_month: r.from ?? null, p_to_month: r.to ?? null }, { retry: true });
    const first = await call({});
    if (!first.error) return { ranges: [{ from: null, to: null, summary: reapplyAllSummary(first.data) }] };
    if (!shouldSplit(first.error)) return { error: first.error, range: {} };
    const span = await monthSpan();
    if (span.error) return { error: span.error, range: {} };
    if (!span.data) return { error: first.error, range: {} };
    const ranges = [];
    const queue = splitRange(span.data) ?? [];
    if (!queue.length) return { error: first.error, range: span.data };
    while (queue.length) {
      const r = queue.shift();
      say(`거래가 많아 기간을 나눠 미리 보는 중… ${rangeText(r)}`);
      const pv = await call(r);
      if (!pv.error) { ranges.push({ ...r, summary: reapplyAllSummary(pv.data) }); continue; }
      const halves = shouldSplit(pv.error) ? splitRange(r) : null;
      if (!halves) return { error: pv.error, range: r };
      queue.unshift(...halves);
    }
    return { ranges };
  }

  // 켜진 규칙으로 한 번에 분류(v0.22): reapply_all_category_rules 미리보기(p_apply=false) → 확인 → 적용(p_apply=true). 변경 묶음은 기간마다 하나
  bulkBtn.addEventListener('click', async () => {
    lockAll(true);
    say('미리 보는 중…');
    const pv = await previewAll();
    if (pv.error) {
      lockAll(false);
      const code = onError?.(pv.error, { stage: STAGES.db_rpc });
      say(`미리보기에서 멈췄어요(${rangeText(pv.range)}): ${reapplyErrorText(pv.error) ?? pv.error.message}${code ? ` (오류 번호 ${code})` : ''}`, true);
      return;
    }
    const total = pv.ranges.reduce((acc, r) => addSummary(acc, r.summary), null);
    if (!total.changed) {
      lockAll(false);
      say(`켜진 규칙으로 바뀌는 거래가 없어요.${total.manual_kept ? ` (직접 고친 거래 ${total.manual_kept}건은 그대로)` : ''}${total.skipped_no_category ? ` (카테고리가 꺼진 규칙 때문에 ${total.skipped_no_category}건 건너뜀)` : ''}`);
      return;
    }
    say('');
    if (!(await confirmDialog({ ...reapplyAllText(total, pv.ranges), confirmLabel: '한 번에 분류', doc }))) { lockAll(false); return; }
    const todo = pv.ranges.filter((r) => r.summary.changed > 0);
    let changed = 0;
    let doneRanges = 0;
    for (const r of todo) {
      if (todo.length > 1) say(`분류하는 중 ${doneRanges + 1}/${todo.length} · ${rangeText(r)}`);
      // 설명에는 규칙 이름·가맹점 등 값을 넣지 않는다(기간만)
      const res = await db.rpc('reapply_all_category_rules', {
        p_apply: true, p_from_month: r.from, p_to_month: r.to, p_description: `켜진 규칙 한 번에 분류 · ${rangeText(r)}`,
      });
      if (res.error) {
        const code = onError?.(res.error, { stage: STAGES.db_rpc });
        done(`${todo.length > 1 ? `기간 ${todo.length}개 중 ${doneRanges}개를 적용했어요(${changed}건). ${rangeText(r)}에서 멈췄어요: ` : '분류하지 못했어요: '}${reapplyErrorText(res.error) ?? res.error.message}${code ? ` (오류 번호 ${code})` : ''}`, true);
        return;
      }
      doneRanges += 1;
      changed += reapplyAllSummary(res.data).changed;
    }
    done(`켜진 규칙으로 ${changed}건 분류했어요. 변경 기록에서 되돌릴 수 있어요.`);
  });

  const total = groups.reduce((s, g) => s + g.total, 0);
  const main = h('main', { class: 'screen' }, [
    head,
    status,
    h('section', { class: 'card' }, [
      h('h2', { class: 'card-title', text: '규칙으로 먼저' }, [], doc),
      h('p', { class: 'muted small', text: '켜진 가맹점 규칙을 모든 달 거래에 우선 순서대로 적용해요. 미리 몇 건이 바뀌는지 보여 드려요.' }, [], doc),
      bulkBtn,
    ], doc),
    h('section', { class: 'card' }, [
      h('p', { class: 'muted', text: groups.length ? `미분류 ${total}건 · 가맹점 ${groups.length}곳. 건수가 많은 곳부터 보여요.` : '분류가 필요한 거래가 없어요' }, [], doc),
      txns.data.capped ? h('p', { class: 'notice small', text: `거래가 많아 앞 ${MAX_ROWS.toLocaleString('ko-KR')}건 안에서만 묶었어요. 분류하고 나면 나머지가 보여요.` }, [], doc) : null,
      h('p', { class: 'muted small', text: '분류하면 확인함으로 바뀌어요. 가맹점 규칙은 이름이 똑같은 가맹점(띄어쓰기·전각 무시)에 적용돼요.' }, [], doc),
    ], doc),
    groups.length ? h('ul', { class: 'mc-list' }, groups.map(groupItem), doc) : null,
  ], doc);
  return main;
}
