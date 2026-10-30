// =====================================================================
// 월 검토 (화면 설계 v0.1 4-5, 시안 7)
// 조회: v_monthly_summary(그 달), 그 달 거래(list.js readMonthRows), v_possible_duplicates(그 달 이용일), v_line_mismatch, categories
// 쓰기: 분류 → 확인 대화상자 → bulk_set_category(가맹점 묶음, 500건까지) → 그 거래들을 review_status = confirmed로 한 건씩
//       (사용자 결정 10-29. bulk_set_category는 검토 상태를 바꾸지 않음 — 스키마 v0.17)
//       둘 다 맞음 → transactions update(review_status = confirmed) 한 건씩
// 원거래를 못 찾은 환불(CL-034, 사용자 결정 U-13): 환불마다 카드. 체크카드 취소는 find_refund_candidates로 연결 제안(조건 1~4, refund-model.js)
//   → 연결하기(link_refund + 확인함) / 다른 결제 찾기(#/refund). 제안된 것만 "모두 연결"(확인 창에 목록, 한 건씩, 멈추면 안내, n/N)
// 준비 중: 아직 안 정한 이체 상대(규칙 화면 필요),
//          분류 뒤 "같은 가맹점 규칙 저장"(규칙 화면 필요)
// 의존: ui/dom.js, router.js, core/format.js, core/errors.js, screens/list.js, screens/review-model.js, screens/detail-model.js, screens/shell.js
// =====================================================================
import { h, widthClass } from '../ui/dom.js';
import { addMonths, buildHash } from '../router.js';
import { month, day, won } from '../core/format.js';
import { STAGES, ACTIONS } from '../core/errors.js';
import { readMonthRows } from './list.js';
import { confirmDialog } from '../core/confirm.js';
import {
  progress, uncategorizedGroups, classifyConfirmText, duplicateGroups, unlinkedRefundCount, mismatchItems, confirmBothPatch,
} from './review-model.js';
import { categoryOptions } from './detail-model.js';
import { readCandidates, readReviewStates, linkOne } from './refund.js';
import {
  SUGGEST_CALL_LIMIT, isSuggestTarget, monthSuggestions, suggestionText, reviewedNote, bulkPlan, bulkConfirmText, bulkResultText,
} from './refund-model.js';
import { errorView } from './shell.js';

let reviewNotice = null;

export async function loadReview(db, monthStart) {
  const eq = (col, value) => ({ col, op: 'eq', value });
  const [summary, rows, dups, mismatch, categories] = await Promise.all([
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
  ]);
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
      dups: dups.data ?? [], mismatch: mismatch.data ?? [], categories: categories.data ?? [],
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
  const { summary, rows, capped, dups, mismatch, categories, unlinked: refunds, suggestions, states, suggestFailed, suggestCapped } = res.data;
  const status = h('p', { class: 'status-line', attrs: { role: 'status', 'aria-live': 'polite' } }, [], doc);
  const say = (msg, isError = false) => {
    status.textContent = msg;
    status.className = `status-line${isError ? ' error' : ''}`;
  };
  if (reviewNotice) { say(reviewNotice.text, reviewNotice.isError); reviewNotice = null; }
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
    groups.length === 0 ? h('p', { class: 'muted', text: '분류가 필요한 거래가 없어요' }, [], doc)
      : h('ul', { class: 'review-groups' }, groups.map((g) => {
        const sel = h('select', { class: 'field', attrs: { 'aria-label': `${g.merchant} 카테고리` } }, [
          h('option', { text: '카테고리 고르기', attrs: { value: '' } }, [], doc),
          ...categoryOptions(categories, g.kind).map((grp) => h('optgroup', { attrs: { label: grp.group } },
            grp.items.map((it) => h('option', { text: it.name, attrs: { value: it.id } }, [], doc)), doc)),
        ], doc);
        const go = h('button', { class: 'btn secondary small-btn', text: `${g.count}건 바꾸기`, attrs: { type: 'button' } }, [], doc);
        go.addEventListener('click', async () => {
          if (!sel.value) { say('카테고리를 골라 주세요', true); return; }
          const name = sel.selectedOptions[0]?.textContent ?? '';
          if (!(await confirmDialog({ ...classifyConfirmText(g, name), confirmLabel: '분류하기', doc }))) return;
          go.disabled = true;
          const r = await db.rpc('bulk_set_category', { p_txn_ids: g.ids, p_category_id: sel.value, p_description: `월 검토 · ${g.merchant} → ${name}`.slice(0, 200) });
          if (r.error) { go.disabled = false; fail(r.error, { stage: STAGES.db_rpc, action: ACTIONS.bulk_edit }); return; }
          // 분류한 거래를 확인함으로(이미 확인함인 것은 건너뜀). 실패하면 거기서 멈추고 몇 건 됐는지 알림
          let confirmed = 0;
          const total = g.toConfirm.length;
          for (const id of g.toConfirm) {
            if (total > 1) say(`확인함으로 바꾸는 중 ${confirmed + 1}/${total}`);
            const u = await db.update('transactions', id, confirmBothPatch(member.memberId));
            if (u.error || !u.data?.length) {
              const code = u.error ? onError?.(u.error, { stage: STAGES.db_update, txnId: id }) : null;
              reviewNotice = {
                text: `${g.count}건을 '${name}'(으)로 분류했지만 확인함으로는 ${confirmed}건만 바꿨어요. 나머지는 상세에서 확인해 주세요.${code ? ` (오류 번호 ${code})` : ''}`,
                isError: true,
              };
              reload();
              return;
            }
            confirmed += 1;
          }
          reviewNotice = { text: `${g.merchant} ${g.count}건을 '${name}'(으)로 분류하고 확인함으로 바꿨어요. 분류는 더보기 › 변경 기록에서 되돌릴 수 있어요.`, isError: false };
          reload();
        });
        return h('li', { class: 'review-group' }, [
          h('p', {}, [h('strong', { text: g.merchant }, [], doc), h('span', { class: 'sub', text: ` ${g.total}건 · ${g.amountText}${g.splitCount ? ` · 나눈 거래 ${g.splitCount}건` : ''}` }, [], doc)], doc),
          h('div', { class: 'review-pick' }, [sel, go], doc),
        ], doc);
      }), doc),
    h('p', { class: 'muted small', text: '같은 가맹점 규칙으로 저장하기는 규칙 화면과 함께 열어요(준비 중).' }, [], doc),
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
    const res2 = await linkOne(db, member.memberId, r.id, o.txn_id);
    refundBusy(false);
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
    let failedAt = null;
    for (const p of plan.pairs) {
      say(`연결 중 ${done + 1}/${plan.pairs.length}`);
      const r2 = await linkOne(db, member.memberId, p.refund.id, p.original.txn_id);
      if (!r2.ok) {
        if (r2.error) onError?.(r2.error, { stage: STAGES.db_rpc, txnId: p.refund.id });
        failedAt = p.refund;
        if (r2.linked) done += 1; // 연결은 됐고 확인함만 못 바꿈
        break;
      }
      done += 1;
    }
    reviewNotice = { text: bulkResultText(done, plan.pairs.length, failedAt), isError: failedAt != null };
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

  // 아직 안 정한 이체 상대 (준비 중)
  const counterpartyCard = card('아직 안 정한 이체 상대', [h('p', { class: 'muted', text: '이체 상대 지정은 규칙 화면과 함께 열어요(준비 중).' }, [], doc)]);

  // 나눈 금액이 안 맞는 거래
  const mm = mismatchItems(mismatch, rows);
  const mismatchCard = card(`나눈 금액이 안 맞는 거래${mm.length ? ` · ${mm.length}건` : ''}`, [
    mm.length === 0 ? h('p', { class: 'muted', text: '없어요' }, [], doc)
      : h('ul', { class: 'todo-list' }, mm.map((m) => h('li', {}, [link(m.text, buildHash('txn', { id: m.id }), m.sub)], doc)), doc),
  ]);

  return h('main', { class: 'screen' }, [head, status, progressCard, classifyCard, dupCard, refundCard, counterpartyCard, mismatchCard], doc);
}
