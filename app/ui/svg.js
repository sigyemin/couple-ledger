// =====================================================================
// 차트용 SVG 요소 만들기 (화면 설계 v0.2 5장: 인라인 SVG를 createElementNS로, innerHTML 금지)
// - 쓸 수 있는 태그·속성만 허용한다(링크·스크립트·style·on* 없음). 모양은 클래스 + styles.css
// - 글자는 textContent로만
// 의존 없음.
// =====================================================================

export const SVG_NS = 'http://www.w3.org/2000/svg';
const TAGS = new Set(['svg', 'g', 'rect', 'line', 'circle', 'text', 'title']);
const ATTRS = new Set([
  'class', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'rx', 'role', 'aria-label', 'aria-hidden',
  'text-anchor', 'focusable', 'preserveAspectRatio',
  'cx', 'cy', 'r', 'stroke-dasharray', 'stroke-dashoffset', 'transform', // 도넛(CL-059): 색·굵기는 클래스로
]);

/**
 * s('rect', { x: 0, y: 2, width: 10, class: 'bar' }, [자식…], doc)
 * 자식: SVG 요소, 문자열(텍스트), null·false(건너뜀)
 */
export function s(tag, attrs = {}, children = [], doc = globalThis.document) {
  if (!TAGS.has(tag)) throw new TypeError(`허용하지 않는 SVG 태그: ${tag}`);
  const el = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (!ATTRS.has(k)) throw new TypeError(`허용하지 않는 SVG 속성: ${k}`);
    el.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    el.append(typeof c === 'string' ? doc.createTextNode(c) : c);
  }
  return el;
}
