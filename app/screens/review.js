// =====================================================================
// 월 검토 (화면 설계 v0.1 4-5, 시안 7)
// 조회: v_monthly_summary(그 달), 그 달 거래(list.js readMonthRows), v_possible_duplicates(그 달 이용일), v_line_mismatch, categories
// 쓰기: 분류 → 확인 대화상자 → bulk_set_category(가맹점 묶음, 500건까지) → 그 거래들을 review_status = confirmed로 한 건씩
//       (사용자 결정 10-29. bulk_set_category는 검토 상태를 바꾸지 않음 — 스키마 v0.17)
//       둘 다 맞음 → transactions update(review_status = confirmed) 한 건씩
// 원거래를 못 찾은 환불(CL-034, 사용자 결정 U-13): 환불마다 카드. 체크카드 취소는 find_refund_candidates로 연결 제안(조건 1~4, refund-model.js)
//   → 연결하기(link_refund + 확인함) / 다른 결제 찾기(#/refund). 제안된 것만 "모두 연결"(확인 창에 목록, 한 건씩, 멈추면 안내, n/N)
// 분류 뒤 같은 가맹점 규칙 저장(CL-066): 묶음마다 '앞으로 같은 가맹점 자동 분류' 체크(지출·통장 이체 아님) → 분류·확인함 뒤
//   가맹점별 분류(CL-061)와 같은 saveMerchantRule(같은 패턴 켜진 규칙이 있으면 만들지 않고 안내)
// 아직 안 정한 이체 상대(CL-066): 그 달 검토 대기 통장 행 중 켜진 이체 상대 규칙에 안 맞는 것을 묶어 보여 주고(unmatchedCounterparties)
//   '규칙 만들기' → 이체 상대 직접 추가(#/cprulenew, 이름·통장·방향 미리 채움 — 이름은 주소에 넣지 않음) → 저장 뒤 검토 대기 거래에 적용 화면
// 의존: ui/dom.js, router.js, core/format.js, core/errors.js, screens/list.js, screens/review-model.js, screens/merchant-classify-model.js(ruleFor),
//       screens/merchant-rule.js, screens/counterparty.js(startCounterpartyDraft), screens/shell.js
// =====================================================================
import { h, widthClass } from '../ui/dom.js';
import { addMonths, buildHash } from '../router.js';
import { month, day, won } from '../core/format.js';
import { STAGES, ACTIONS } from '../core/errors.js';
import { readMonthRows } from './list.js';
import { confirmDialog } from '../core/confirm.js';
import {
  progress, uncategorizedGroups, classifyConfirmText, duplicateGroups, unlinkedRefundCount, mismatchItems, confirmBothPatch,
  unmatchedCounterparties, CP_GROUP_LIMIT,
} from './review-model.js';
import { ruleFor } from './merchant-classify-model.js';
import { saveMerchantRule } from './merchant-rule.js';
import { startCounterpartyDraft } from './counterparty.js';
import { categoryPicker } from './category-picker.js';
import { readCandidates, readReviewStates, linkOne } from './refund.js';
import {
  SUGGEST_CALL_LIMIT, isSuggestTarget, monthSuggestions, suggestionText, reviewedNote, bulkPlan, bulkConfirmText, bulkResultText,
} from './refund-model.js';
import { errorView } from './shell.js';

let reviewNotice = null;

export async function loadReview(db, monthStart) {
  const eq = (col, value) => ({ col, op: 'eq', value });
  const [summary, rows, dups, mismatch, categories, cpRules] = await Promise.all([
    db.select('v_monthly_summary', { columns: 'period_month,txn_count,needs_review_count,uncategorized_count,unlinked_refund_count', filters: [eq('period_month', monthStart)] }),
    readMonthRows(db, monthStart),
    db.select('v_possible_duplicates', {
      columns: 'source_id,occurred_on,merchant_norm,amount,kind,txn_count',
      filters: [{ col: 'occurred_on', op: 'gte', value: monthStart }, { col: 'occurred_on', op: 'lt', value: addMonths(monthStart, 1) }],
    }),
    // 귀속월과 이용일이 다를 수 있어(연결 환불) 앞뒤 한 달까지 읽고, 화면에서 그 달 거래와 맞춘다(PR #20 리뷰 4)
    db.select('v_line_mismatch', {
      columns: 'id,occurred_on,merchant_raw,amount,lines_amount',
      filters: [{ col: 'occurred_on', op: 'gte', value: addMonths(monthStart, -1) }, { col: 'occurred_on', op: 'lt', value: addMonths(monthStart, 2) }],
      range: { from: 0, to: 499 },
    }),
    db.select('categories', { columns: 'id,parent_id,name,code,sort_order,is_active' }),
    // 아직 안 정한 이체 상대: 켜진 규칙(순서는 서버 정렬 — 업로드와 같음)
    db.select('counterparty_rules', {
      columns: 'id,match_field,match_text,match_type,source_id,direction,txn_type,suggested_kind,is_active',
      filters: [eq('is_active', true)], order: [{ col: 'priority' }, { col: 'created_at' }, { col: 'id' }],
    }),
  ]);
  // 이체 상대 규칙을 못 읽어도 월 검토는 그대로(그 카드만 오류 줄)
  const error = [summary, rows, dups, mismatch, categories].find((r) => r.error)?.error;
  if (error) return { error };
  // 원거래를 못 찾은 환불(검토 대기·연결 없음, 테스트 결제수단은 readMonthRows가 뺌)과 체크카드 취소의 후보
  const unlinked = rows.data.rows.filter((r) => r.kind === 'refund' && !r.refund_of_txn_id && r.review_status === 'needs_review')
    .sort((x, y) => String(x.occurred_on).localeCompare(String(y.occurred_on)) || String(x.id).localeCompare(String(y.id)));
  const targets = unlinked.filter(isSuggestTarget).slice(0, SUGGEST_CALL_LIMIT);
  const [cands, states] = await Promise.all([
    Promise.all(targets.map((r) => readCandidates(db, r.id))),
    readReviewStates(db),
  ]);
  const byRefund = new Map();
  targets.forEach((r, i) => { if (!cands[i].error) byRefund.set(r.id, cands[i].data ?? []); });
  return {
    data: {
      summary: summary.data?.[0] ?? null, rows: rows.data.rows, capped: rows.data.capped,
      dups: dups.data ?? [], mismatch: mismatch.data ?? [], categories: categories.data ?? [], cpRules: cpRules.error ? null : (cpRules.data ?? []), cpRulesError: cpRules.error ?? null,
      unlinked, suggestions: monthSuggestions(byRefund), states,
      suggestFailed: cands.some((c) => c.error), suggestCapped: unlinked.filter(isSuggestTarget).length > targets.length,
    },
  };
}

/**
 * @param {{ db, member, monthStart, reload(), isCurrent(), onError(err, extra) → string }} ctx
 */
export async function renderReview({ db, member, monthStart, reload, isCurrent, onError }, doc = globalThis.document) {
  const res = await loadReview(db, monthStart);
  if (!isCurrent()) return null;
  const ym = (m) => m.slice(0, 7);
  const nav = (n, label, text) => h('a', { class: 'icon-btn', text, attrs: { href: buildHash('review', { query: { month: ym(addMonths(monthStart, n)) } }), 'aria-label': label } }, [], doc);
  const head = h('header', { class: 'screen-head' }, [
    h('nav', { class: 'month-nav', attrs: { 'aria-label': '달 선택' } }, [
      nav(-1, '이전 달', '‹'),
      h('h1', { class: 'title', text: `${month(monthStart).replace(/^[0-9]+년 /, '')} 검토` }, [], doc),
      nav(1, '다음 달', '›'),
    ], doc),
  ], doc);
  if (res.error) {
    onError?.(res.error);
    return h('main', { class: 'screen' }, [head, errorView(res.error.message, res.error.detail?.sqlState ?? res.error.code, doc)], doc);
  }
  const { summary, rows, capped, dups, mismatch, categories, cpRules, cpRulesError, unlinked: refunds, suggestions, states, suggestFailed, suggestCapped } = res.data;
  const status = h('p', { class: 'status-line', attrs: { role: 'status', 'aria-live': 'polite' } }, [], doc);
  // link: { href, text } — 안내 끝에 붙는 앱 안 링크(같은 패턴 다른 카테고리 규칙 → 규칙 화면)
  const say = (msg, isError = false, link = null) => {
    status.replaceChildren(msg, ...(link ? [' ', h('a', { text: link.text, attrs: { href: link.href } }, [], doc)] : []));
    status.className = `status-line${isError ? ' error' : ''}`;
  };
  if (reviewNotice) { say(reviewNotice.text, reviewNotice.isError, reviewNotice.link); reviewNotice = null; }
  const fail = (err, extra) => {
    const code = onError?.(err, extra);
    say(`${err.message}${code ? ` (오류 번호 ${code})` : ''}`, true);
  };
  const card = (title, children) => h('section', { class: 'card' }, [h('h2', { class: 'card-title', text: title }, [], doc), ...children], doc);
  const link = (text, href, sub) => h('a', { class: 'todo', attrs: { href } }, [
    h('span', { class: 'todo-text' }, [h('span', { text }, [], doc), sub ? h('span', { class: 'sub', text: sub }, [], doc) : null], doc),
    h('span', { class: 'chev', text: '›', attrs: { 'aria-hidden': 'true' } }, [], doc),
  ], doc);

  // 진행률
  const p = progress(summary);
  const progressCard = card('진행률', [
    h('p', { class: 'muted', text: p.text }, [], doc),
    h('span', { class: 'bar-track progress', attrs: { role: 'img', 'aria-label': `확인 ${Math.round(p.ratio * 100)}%` } }, [
      h('span', { class: `bar-fill ${widthClass(p.ratio)}` }, [], doc),
    ], doc),
    p.pending ? link('검토 대기 거래 보기', buildHash('list', { query: { month: ym(monthStart), status: 'needs_review' } })) : null,
    capped ? h('p', { class: 'muted small', text: '이 달 거래가 많아 앞 2,000건 안에서만 묶었어요.' }, [], doc) : null,
  ]);

  // 분류가 필요해요
  const groups = uncategorizedGroups(rows);
  const classifyCard = card(`분류가 필요해요${groups.length ? ` · ${groups.reduce((s, g) => s + g.total, 0)}건` : ''}`, [
    link('모든 달을 가맹점별로 분류하기(규칙도 함께)', buildHash('classify')), // CL-061
    groups.length === 0 ? h('p', { class: 'muted', text: '분류가 필요한 거래가 없어요' }, [], doc)
      : h('ul', { class: 'review-groups' }, groups.map((g) => {
        const sel = categoryPicker({ categories, kind: g.kind, label: `${g.merchant} 카테고리`, doc });
        const go = h('button', { class: 'btn secondary small-btn', text: `${g.count}건 바꾸기`, attrs: { type: 'button' } }, [], doc);
        // 분류 뒤 같은 가맹점 규칙 저장(화면 v0.1 4-5) — 지출이고 통장 이체가 아닐 때만, 기본은 켬(가맹점별 분류와 같음)
        const ruleBox = g.canRule ? h('input', { attrs: { type: 'checkbox', 'aria-label': `앞으로 ${g.merchant} 자동 분류` } }, [], doc) : null;
        if (ruleBox) ruleBox.checked = true;
        const lock = (on) => { go.disabled = on; sel.setDisabled(on); if (ruleBox) ruleBox.disabled = on; };
        go.addEventListener('click', async () => {
          if (!sel.value) { say('카테고리를 골라 주세요', true); return; }
          const name = sel.selectedName;
          const makeRule = Boolean(ruleBox?.checked);
          const rv = makeRule ? ruleFor(g, sel.value) : null;
          if (rv && !rv.ok) { say(`규칙을 만들 수 없어요: ${rv.message}. 체크를 끄고 분류만 할 수 있어요.`, true); return; }
          const text = classifyConfirmText(g, name, makeRule);
          if (rv?.warning) text.message += ` (${rv.warning})`;
          if (!(await confirmDialog({ ...text, confirmLabel: '분류하기', doc }))) return;
          lock(true);
          const r = await db.rpc('bulk_set_category', { p_txn_ids: g.ids, p_category_id: sel.value, p_description: `월 검토 · ${g.merchant} → ${name}`.slice(0, 200) });
          if (r.error) { lock(false); fail(r.error, { stage: STAGES.db_rpc, action: ACTIONS.bulk_edit }); return; }
          // 분류한 거래를 확인함으로(이미 확인함인 것은 건너뜀). 실패하면 거기서 멈추고 몇 건 됐는지 알림
          let confirmed = 0;
          const total = g.toConfirm.length;
          for (const id of g.toConfirm) {
            if (total > 1) say(`확인함으로 바꾸는 중 ${confirmed + 1}/${total}`);
            const u = await db.update('transactions', id, confirmBothPatch(member.memberId));
            if (u.error || !u.data?.length) {
              const code = u.error ? onError?.(u.error, { stage: STAGES.db_update, txnId: id }) : null;
              reviewNotice = {
                text: `${g.count}건을 '${name}'(으)로 분류했지만 확인함으로는 ${confirmed}건만 바꿨어요${makeRule ? '(규칙은 만들지 않았어요)' : ''}. 나머지는 상세에서 확인해 주세요.${code ? ` (오류 번호 ${code})` : ''}`,
                isError: true,
              };
              reload();
              return;
            }
            confirmed += 1;
          }
          let ruleNote = '';
          let ruleLink = null;
          if (makeRule) {
            const sr = await saveMerchantRule({ db, member, value: rv.value, categories, onError });
            if (!sr.ok) {
              reviewNotice = { text: `${g.merchant} ${g.count}건을 '${name}'(으)로 분류하고 확인함으로 바꿨지만 ${sr.text}`, isError: true };
              reload();
              return;
            }
            ruleNote = sr.note;
            ruleLink = sr.link;
          }
          reviewNotice = {
            text: `${g.merchant} ${g.count}건을 '${name}'(으)로 분류하고 확인함으로 바꿨어요.${ruleNote}${ruleLink ? '' : ' 분류는 더보기 › 변경 기록에서 되돌릴 수 있어요.'}`,
            isError: false, link: ruleLink,
          };
          reload();
        });
        return h('li', { class: 'review-group' }, [
          h('p', {}, [h('strong', { text: g.merchant }, [], doc), h('span', { class: 'sub', text: ` ${g.total}건 · ${g.amountText}${g.splitCount ? ` · 나눈 거래 ${g.splitCount}건` : ''}` }, [], doc)], doc),
          h('div', { class: 'review-pick' }, [sel, go], doc),
          ruleBox ? h('label', { class: 'filter-check' }, [ruleBox, h('span', { text: '앞으로 같은 가맹점 자동 분류(가맹점 규칙 만들기)' }, [], doc)], doc)
            : (g.transferLike ? h('p', { class: 'muted small' }, [
              '통장 이체예요. 앞으로 자동으로 하려면 ', h('a', { text: '이체 상대 규칙', attrs: { href: buildHash('cprules') } }, [], doc), '에서 정해요.',
            ], doc) : null),
        ], doc);
      }), doc),
  ]);

  // 같은 거래일 수도 있어요
  const dupGroups = duplicateGroups(dups, rows);
  const dupCard = card(`같은 거래일 수도 있어요${dupGroups.length ? ` · ${dupGroups.length}묶음` : ''}`, [
    dupGroups.length === 0 ? h('p', { class: 'muted', text: '겹쳐 보이는 거래가 없어요' }, [], doc)
      : h('ul', { class: 'review-groups' }, dupGroups.map((g) => {
        const ok = h('button', { class: 'btn secondary small-btn', text: '둘 다 맞음', attrs: { type: 'button' } }, [], doc);
        ok.addEventListener('click', async () => {
          ok.disabled = true;
          let done = 0;
          for (const id of g.pendingIds) {
            const r = await db.update('transactions', id, confirmBothPatch(member.memberId));
            if (r.error || !r.data?.length) {
              ok.disabled = false;
              if (r.error) fail(r.error, { stage: STAGES.db_update, txnId: id });
              else say('저장하지 못했어요. 새로고침해 주세요.', true);
              if (done) reload();
              return;
            }
            done += 1;
          }
          reviewNotice = { text: '둘 다 맞는 거래로 확인했어요.', isError: false };
          reload();
        });
        return h('li', { class: 'review-group' }, [
          h('p', {}, [h('strong', { text: g.title }, [], doc)], doc),
          h('ul', {}, g.items.map((it) => h('li', {}, [link(it.text, buildHash('txn', { id: it.id }), '하나가 잘못 들어왔으면 상세에서 휴지통으로')], doc)), doc),
          ok,
        ], doc);
      }), doc),
  ]);

  // 원거래를 못 찾은 환불 (CL-034): 환불마다 카드, 체크카드 취소는 연결 제안
  const unlinked = unlinkedRefundCount(summary);
  const fmtDay = (d) => day(d).replace(/ \(.\)$/, '');
  const plan = bulkPlan(refunds, suggestions);
  const refundBusy = (on) => { for (const b of refundCard.querySelectorAll('button')) b.disabled = on; };
  const linkSuggested = async (r, o) => {
    const note = reviewedNote([`${String(o.occurred_on).slice(0, 7)}-01`], states);
    if (note && !(await confirmDialog({ title: `${r.merchant_raw} 환불 연결`, message: `${fmtDay(o.occurred_on)} ${won(Number(o.amount))} 결제와 연결해요. ${note}`, confirmLabel: '연결', doc }))) return;
    refundBusy(true);
    const res2 = await linkOne(db, member.memberId, r.id, o.txn_id, { onlyIfUnlinked: true });
    refundBusy(false);
    if (res2.skipped) { reviewNotice = { text: `${r.merchant_raw} 환불은 다른 사람이 먼저 연결했거나 휴지통으로 옮겼어요.`, isError: true }; reload(); return; }
    if (!res2.ok && !res2.linked) { fail(res2.error, { stage: STAGES.db_rpc, txnId: r.id }); return; }
    reviewNotice = res2.ok
      ? { text: `${r.merchant_raw} 환불을 연결했어요.`, isError: false }
      : { text: `${r.merchant_raw} 환불을 연결했지만 확인함으로는 바꾸지 못했어요. 상세에서 "확인했어요"를 눌러 주세요.`, isError: true };
    reload();
  };
  const linkAll = async () => {
    if (!plan.pairs.length) return;
    if (!(await confirmDialog({ ...bulkConfirmText(plan, states), confirmLabel: `${plan.pairs.length}건 연결`, doc }))) return;
    refundBusy(true);
    let done = 0;
    let skipped = 0;
    let failedAt = null;
    for (const [i, p] of plan.pairs.entries()) {
      say(`연결 중 ${i + 1}/${plan.pairs.length}`);
      const r2 = await linkOne(db, member.memberId, p.refund.id, p.original.txn_id, { onlyIfUnlinked: true });
      if (r2.skipped) { skipped += 1; continue; } // 그사이 다른 사람이 연결·휴지통 → 건너뜀
      if (!r2.ok) {
        if (r2.error) onError?.(r2.error, { stage: STAGES.db_rpc, txnId: p.refund.id });
        failedAt = p.refund;
        if (r2.linked) done += 1; // 연결은 됐고 확인함만 못 바꿈
        break;
      }
      done += 1;
    }
    reviewNotice = { text: bulkResultText(done, plan.pairs.length - skipped, failedAt, skipped), isError: failedAt != null || skipped > 0 };
    reload();
  };
  const refundItem = (r) => {
    const sg = suggestions.get(r.id);
    const t = suggestionText(sg);
    const find = (label) => h('a', { class: 'btn secondary small-btn', text: label, attrs: { href: buildHash('refund', { id: r.id }) } }, [], doc);
    let box;
    if (t?.kind === 'suggest') {
      const go = h('button', { class: 'btn primary small-btn', text: '연결하기', attrs: { type: 'button' } }, [], doc);
      go.addEventListener('click', () => linkSuggested(r, sg.suggest));
      box = h('div', { class: 'suggest-box', attrs: { role: 'group', 'aria-label': `${r.merchant_raw} 연결 제안` } }, [
        h('p', { class: 'small strong', text: t.title }, [], doc),
        h('p', { text: t.what }, [], doc),
        h('p', { class: 'muted small', text: t.why }, [], doc),
        h('div', { class: 'btn-row' }, [go, find('다른 결제 찾기')], doc),
      ], doc);
    } else {
      box = h('div', {}, [t ? h('p', { class: 'muted small', text: t.text }, [], doc) : null, h('div', { class: 'btn-row' }, [find('원거래 찾기')], doc)], doc);
    }
    return h('li', { class: 'refund-item' }, [
      h('a', { class: 'txn tone-refund', attrs: { href: buildHash('txn', { id: r.id }) } }, [
        h('span', { class: 'txn-main' }, [
          h('span', { class: 'txn-merchant' }, [r.merchant_raw, h('span', { class: 'tag', text: r.card_kind === 'check_card' ? '체크카드 취소' : '환불' }, [], doc)], doc),
          h('span', { class: 'sub', text: `${fmtDay(r.occurred_on)} · ${r.source_label}` }, [], doc),
        ], doc),
        h('span', { class: 'txn-amount', text: won(-Number(r.amount)) }, [], doc),
      ], doc),
      box,
    ], doc);
  };
  let bulkBtn = null;
  if (plan.pairs.length) {
    bulkBtn = h('button', { class: 'btn primary', text: `제안 ${plan.pairs.length}건 모두 연결`, attrs: { type: 'button' } }, [], doc);
    bulkBtn.addEventListener('click', linkAll);
  }
  const refundCard = card(`원거래를 못 찾은 환불${unlinked || refunds.length ? ` · ${Math.max(unlinked, refunds.length)}건` : ''}${plan.pairs.length ? ` · 연결 제안 ${plan.pairs.length}건` : ''}`, [
    refunds.length === 0 ? h('p', { class: 'muted', text: '못 찾은 환불이 없어요' }, [], doc)
      : h('ul', { class: 'refund-list' }, refunds.slice(0, 100).map(refundItem), doc),
    refunds.length > 100 ? link(`나머지 ${refunds.length - 100}건은 내역에서`, buildHash('list', { query: { month: ym(monthStart), kind: 'refund_unlinked' } })) : null,
    suggestFailed ? h('p', { class: 'notice small', text: '일부 환불의 후보를 읽지 못해 제안을 빼고 보여요.' }, [], doc) : null,
    suggestCapped ? h('p', { class: 'muted small', text: `체크카드 취소가 많아 앞 ${SUGGEST_CALL_LIMIT}건만 제안을 계산했어요.` }, [], doc) : null,
    bulkBtn,
    refunds.length ? h('p', { class: 'muted small', text: '연결하면 그 결제의 달·카테고리로 집계되고 "확인했어요" 처리돼요. 원거래가 다른 달이면 환불이 그 달로 옮겨 가서, 확인 완료한 달이 "확인 후 변경됨"이 될 수 있어요.' }, [], doc) : null,
  ]);

  // 아직 안 정한 이체 상대 (CL-066): 규칙에 안 맞는 검토 대기 통장 행 묶음 → 이체 상대 규칙 만들기(이름 등 미리 채움)
  const cp = cpRules ? unmatchedCounterparties(rows, cpRules) : { groups: [], unsure: 0 };
  const cpCode = cpRulesError ? onError?.(cpRulesError, { stage: STAGES.list }) : null;
  const cpItem = (g) => {
    const make = h('a', { class: 'btn secondary small-btn', text: '규칙 만들기', attrs: { href: buildHash('cprulenew'), 'aria-label': `${g.name} 이체 상대 규칙 만들기` } }, [], doc);
    make.addEventListener('click', () => startCounterpartyDraft({ matchText: g.name, sourceId: g.sourceId, direction: g.direction }));
    return h('li', { class: 'review-group' }, [
      h('p', {}, [h('strong', { text: g.name }, [], doc), h('span', { class: 'sub', text: ` ${g.sourceLabel} · ${g.direction === 'out' ? '출금' : '입금'} · ${g.count}건 · ${g.amountText}` }, [], doc)], doc),
      make,
    ], doc);
  };
  const counterpartyCard = card(`아직 안 정한 이체 상대${cp.groups.length ? ` · ${cp.groups.length}곳` : ''}`, [
    cpRulesError ? h('p', { class: 'notice small', attrs: { role: 'alert' }, text: `이체 상대 규칙을 불러오지 못했어요. 다시 열어 주세요.${cpCode ? ` (오류 번호 ${cpCode})` : ''}` }, [], doc)
      : cp.groups.length === 0 ? h('p', { class: 'muted', text: '정할 이체 상대가 없어요' }, [], doc)
      : h('ul', { class: 'review-groups' }, cp.groups.slice(0, CP_GROUP_LIMIT).map(cpItem), doc),
    cp.groups.length > CP_GROUP_LIMIT ? h('p', { class: 'muted small', text: `많아서 앞 ${CP_GROUP_LIMIT}곳만 보여요. 규칙을 만들면 나머지가 앞으로 와요.` }, [], doc) : null,
    cp.unsure ? h('p', { class: 'muted small', text: `거래 종류·상대 칸을 보는 규칙이 있어 ${cp.unsure}건은 여기서 판정하지 못해 뺐어요.` }, [], doc) : null,
    cp.groups.length ? h('p', { class: 'muted small', text: '규칙을 저장하면 이 달을 포함한 검토 대기 거래에 적용할지 미리 보여 드려요. 이미 확인한 거래는 바뀌지 않아요.' }, [], doc) : null,
    link('이체 상대 규칙 모두 보기', buildHash('cprules')),
  ]);

  // 나눈 금액이 안 맞는 거래
  const mm = mismatchItems(mismatch, rows);
  const mismatchCard = card(`나눈 금액이 안 맞는 거래${mm.length ? ` · ${mm.length}건` : ''}`, [
    mm.length === 0 ? h('p', { class: 'muted', text: '없어요' }, [], doc)
      : h('ul', { class: 'todo-list' }, mm.map((m) => h('li', {}, [link(m.text, buildHash('txn', { id: m.id }), m.sub)], doc)), doc),
  ]);

  return h('main', { class: 'screen' }, [head, status, progressCard, classifyCard, dupCard, refundCard, counterpartyCard, mismatchCard], doc);
}
