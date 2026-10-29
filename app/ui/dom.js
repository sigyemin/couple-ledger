// =====================================================================
// 화면 요소 만들기 (공통 컴포넌트 설계 v0.1 7장 출력 규칙)
// - 글자는 textContent로만 넣는다. innerHTML·insertAdjacentHTML·outerHTML 금지
// - style 속성·on* 속성 금지(CSP style-src 'self', 인라인 스크립트 금지) → 모양은 클래스, 동작은 addEventListener
// - 링크는 앱 안 해시 주소(#/…)만. 외부 링크를 만들지 않는다
// 의존 없음.
// =====================================================================

const FORBIDDEN_ATTR = /^(on|style$|srcdoc$|formaction$)/i;
const ALLOWED_HREF = /^#\//;

/**
 * h('section', { class: 'card', text: '...', attrs: { 'aria-label': '…' }, on: { click: fn } }, [자식…])
 * 자식: 요소, 문자열(텍스트 노드), null·false(건너뜀)
 */
export function h(tag, props = {}, children = [], doc = globalThis.document) {
  const el = doc.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text != null) el.textContent = String(props.text);
  for (const [k, v] of Object.entries(props.attrs ?? {})) {
    if (v == null || v === false) continue;
    if (FORBIDDEN_ATTR.test(k)) throw new TypeError(`허용하지 않는 속성: ${k}`);
    if (k === 'href' && !ALLOWED_HREF.test(String(v))) throw new TypeError('앱 안 주소(#/…)만 링크할 수 있습니다');
    el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const [ev, fn] of Object.entries(props.on ?? {})) el.addEventListener(ev, fn);
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    el.append(typeof c === 'string' ? doc.createTextNode(c) : c);
  }
  return el;
}

/** 자식을 모두 지우고 새로 넣는다 */
export function replaceChildren(el, ...children) {
  el.replaceChildren(...children.filter((c) => c != null && c !== false));
}

/** 막대 너비용 클래스(0~100%, 5% 단위). style 속성을 쓰지 않으려고 클래스로 정한다 */
export function widthClass(ratio) {
  const pct = Math.max(0, Math.min(100, Math.round((Number(ratio) || 0) * 20) * 5));
  return `w-${pct}`;
}
