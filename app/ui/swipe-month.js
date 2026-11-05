// =====================================================================
// 폰에서 좌우로 밀어 달 넘기기 (CL-074, 사용자 요청 11-05)
// - 화면마다 따로 만들지 않는다: 문서에 한 번 달고, 지금 화면의 기존 '이전 달'·'다음 달' 링크(.month-nav a[aria-label])를 그대로 따른다
//   → 주소(#/…?month=)·뒤로가기 흐름이 버튼과 같다. 그런 링크가 없는 화면에서는 아무 일도 안 한다
// - 왼쪽으로 밀면 다음 달, 오른쪽으로 밀면 이전 달
// - 터치만(PC 마우스 끌기는 안 함). touch 이벤트는 passive로만 듣고 preventDefault 하지 않는다 → 세로 스크롤·확대·텍스트 선택은 그대로
// - 넘기는 조건(swipeDecision): 가로 이동 ≥ 화면 폭 × MIN_RATIO, 가로가 세로의 VERTICAL_FACTOR배 이상, MAX_MS 안에 끝남, 손가락 하나
// - 막는 곳(isBlockedTarget): 입력칸·select·textarea·편집 칸, 열린 대화상자, 가로로 스크롤되는 영역(표·칩 줄), 끌기 손잡이,
//   차트(svg·canvas), data-no-swipe. 글자를 고르고 있으면(선택 영역) 넘기지 않는다
// - 피드백: 미는 동안 화면이 미는 쪽으로 살짝 기움(.swipe-left/.swipe-right — CSS가 몇 px만), 넘긴 뒤 새 화면의 달 이름을 잠깐 강조.
//   prefers-reduced-motion이면 따라오는 움직임 없이 강조만
// 의존 없음
// =====================================================================

export const MIN_RATIO = 0.2;
export const VERTICAL_FACTOR = 2;
export const MAX_MS = 700;
const FOLLOW_AT = 16; // 이만큼(px) 가로로 밀면 화면이 그 쪽으로 살짝 기운다(클래스 — 인라인 style 쓰지 않음)
const FLASH_MS = 900;

/**
 * 손 뗐을 때 넘길지
 * @param {{ dx: number, dy: number, ms: number, width: number }} m  dx > 0 = 오른쪽으로 밀었음
 * @returns {'prev'|'next'|null}
 */
export function swipeDecision({ dx, dy, ms, width }) {
  if (!(width > 0) || ms > MAX_MS) return null;
  if (Math.abs(dx) < width * MIN_RATIO) return null;
  if (Math.abs(dx) < Math.abs(dy) * VERTICAL_FACTOR) return null;
  return dx < 0 ? 'next' : 'prev';
}

const BLOCK_SELECTOR = 'input, select, textarea, button.cat-handle, .cat-handle, [contenteditable=""], [contenteditable="true"], svg, canvas, [data-no-swipe], dialog';

/** 이 요소(또는 조상)에서 시작한 밀기는 달 넘기기가 아님 */
export function isBlockedTarget(el, win = globalThis) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.matches?.(BLOCK_SELECTOR)) return true;
    // 가로로 스크롤되는 영역(표·칩 줄): 그 안의 가로 밀기는 스크롤
    if (n.scrollWidth > n.clientWidth + 1) {
      const ox = win.getComputedStyle?.(n)?.overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
  }
  return false;
}

/** 지금 화면의 이전·다음 달 링크 */
export function monthLinks(root) {
  const nav = root?.querySelector?.('main .month-nav') ?? root?.querySelector?.('.month-nav');
  if (!nav) return null;
  const prev = nav.querySelector('a[aria-label="이전 달"]');
  const next = nav.querySelector('a[aria-label="다음 달"]');
  return prev || next ? { prev, next } : null;
}

/**
 * 문서에 한 번 단다
 * @returns {{ rendered(view): void, dispose(): void }}  rendered = 새 화면을 그린 뒤(main.js) — 넘긴 직후면 달 이름 강조
 */
export function installMonthSwipe(doc = globalThis.document, win = globalThis) {
  let start = null;
  let moved = null;
  let flash = false;
  const reduced = () => Boolean(win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);

  const reset = () => {
    moved?.classList.remove('swipe-left', 'swipe-right');
    moved = null;
    start = null;
  };

  const onStart = (e) => {
    reset();
    if (e.touches.length !== 1) return;
    if (doc.querySelector('dialog[open]')) return;
    if (isBlockedTarget(e.target, win)) return;
    const links = monthLinks(doc);
    if (!links) return;
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY, at: Date.now(), links };
  };

  const onMove = (e) => {
    if (!start || e.touches.length !== 1) { reset(); return; }
    const t = e.touches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    // 세로가 이기면 이번 손짓은 스크롤 — 끝까지 따라오지 않는다
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) { reset(); return; }
    if (reduced()) return;
    const main = doc.querySelector('main.screen');
    if (!main) return;
    moved = main;
    main.classList.toggle('swipe-left', dx <= -FOLLOW_AT && Math.abs(dx) > Math.abs(dy));
    main.classList.toggle('swipe-right', dx >= FOLLOW_AT && Math.abs(dx) > Math.abs(dy));
  };

  const onEnd = (e) => {
    if (!start) return;
    const t = e.changedTouches[0];
    const s = start;
    reset();
    if (!t) return;
    if (String(win.getSelection?.() ?? '').length) return; // 글자를 고르는 중
    const d = swipeDecision({ dx: t.clientX - s.x, dy: t.clientY - s.y, ms: Date.now() - s.at, width: win.innerWidth });
    const a = d && s.links[d];
    if (!a?.getAttribute('href')) return;
    flash = true;
    win.location.hash = a.getAttribute('href'); // 버튼을 누른 것과 같은 주소 → 같은 뒤로가기
  };

  const opts = { passive: true };
  doc.addEventListener('touchstart', onStart, opts);
  doc.addEventListener('touchmove', onMove, opts);
  doc.addEventListener('touchend', onEnd, opts);
  doc.addEventListener('touchcancel', reset, opts);

  return {
    rendered(view) {
      if (!flash) return;
      flash = false;
      const title = view?.querySelector?.('.month-nav .title');
      if (!title) return;
      title.classList.add('month-flash');
      win.setTimeout?.(() => title.classList.remove('month-flash'), FLASH_MS);
    },
    dispose() {
      doc.removeEventListener('touchstart', onStart, opts);
      doc.removeEventListener('touchmove', onMove, opts);
      doc.removeEventListener('touchend', onEnd, opts);
      doc.removeEventListener('touchcancel', reset, opts);
    },
  };
}
