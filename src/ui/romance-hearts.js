// 恋爱四态动画基元（策划书 §4.5）：SVG 双心 + 中缝状态符号，全部本地矢量、零字符字形。
// 由匹配页（P2-B）与壳层 romance 弹窗（收藏主动私聊）共用；state 必须显式传入四态之一，
// 非法态直接抛错而不是回退渲染，避免出现未定义的“半状态”动画。
const SVG_NS = 'http://www.w3.org/2000/svg';

export const HEART_PATH = 'M12 20.25S4 15.5 4 9.25A4.25 4.25 0 0 1 12 7.3a4.25 4.25 0 0 1 8 1.95c0 6.25-8 11-8 11Z';
export const ROMANCE_STATES = Object.freeze(['connecting', 'accepted', 'declined', 'failure']);

function svgNode(documentRef, name, attributes = {}) {
    const node = documentRef.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
}

/** @param {Document} documentRef @param {'connecting'|'accepted'|'declined'|'failure'} state */
export function createRomanceHearts(documentRef, state) {
    if (!ROMANCE_STATES.includes(state)) throw new TypeError('yl_romance_state_invalid');
    const wrap = documentRef.createElement('span');
    wrap.className = 'yl-hearts yl-hearts--' + state;
    wrap.dataset.state = state;
    wrap.setAttribute('aria-hidden', 'true');
    const svg = svgNode(documentRef, 'svg', { viewBox: '0 0 52 26', fill: 'none', class: 'yl-hearts__svg' });
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const heartAttrs = { d: HEART_PATH, 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    const left = svgNode(documentRef, 'g', { transform: 'translate(1 1)', class: 'yl-hearts__heart yl-hearts__heart--left' });
    left.appendChild(svgNode(documentRef, 'path', heartAttrs));
    const right = svgNode(documentRef, 'g', { transform: 'translate(27 1)', class: 'yl-hearts__heart yl-hearts__heart--right' });
    right.appendChild(svgNode(documentRef, 'path', heartAttrs));
    const mid = svgNode(documentRef, 'g', { class: 'yl-hearts__mid' });
    if (state === 'connecting') {
        for (const cx of [22, 26, 30]) mid.appendChild(svgNode(documentRef, 'circle', { cx, cy: 13, r: 1.5, class: 'yl-hearts__dot' }));
    } else if (state === 'accepted') {
        for (const spark of ['M26 4.5v4', 'M21.5 6.5l2.4 2.6', 'M30.5 6.5l-2.4 2.6']) {
            mid.appendChild(svgNode(documentRef, 'path', { d: spark, 'stroke-width': '1.6', 'stroke-linecap': 'round', class: 'yl-hearts__spark' }));
        }
    } else {
        mid.appendChild(svgNode(documentRef, 'path', { d: 'M28.5 6 23.5 20', 'stroke-width': '1.8', 'stroke-linecap': 'round', class: 'yl-hearts__break' }));
    }
    svg.appendChild(left);
    svg.appendChild(mid);
    svg.appendChild(right);
    wrap.appendChild(svg);
    return wrap;
}
