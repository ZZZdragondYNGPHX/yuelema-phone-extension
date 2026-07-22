/**
 * Security-first DOM helpers.
 *
 * UI text is always inserted with textContent. This module deliberately exposes no
 * HTML-string renderer, no style-string interpolation, and no event-attribute path.
 */
const ALLOWED_TAGS = new Set([
    'article', 'aside', 'button', 'div', 'footer', 'form', 'header', 'h1', 'h2', 'label',
    'main', 'nav', 'option', 'p', 'section', 'select', 'span', 'strong', 'textarea', 'input', 'h3', 'img', 'b', 'small',
]);

/** @param {unknown} value */
export function text(value) {
    return String(value ?? '');
}

/**
 * Only non-executable, element-appropriate attributes are accepted. Values set through
 * this helper always become properties or inert attributes; callers cannot attach HTML.
 */
const PROPERTY_OPTIONS = Object.freeze([
    'accept', 'autocomplete', 'checked', 'download', 'id', 'inputMode', 'max', 'maxLength',
    'min', 'minLength', 'multiple', 'name', 'placeholder', 'rows', 'value', 'alt', 'src', 'loading', 'referrerPolicy',
]);

function safeImageSource(value) {
    const source = text(value);
    if (/^https?:\/\/[^\s<>]+$/iu.test(source)) return source;
    if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/iu.test(source)) return source;
    return '';
}

/** @param {string} tag @param {{ className?: string, text?: unknown, ariaLabel?: string, type?: string, disabled?: boolean, pressed?: boolean, hidden?: boolean, htmlFor?: string } & Record<string, unknown>} [options] */
export function element(tag, options = {}) {
    if (!ALLOWED_TAGS.has(tag)) {
        throw new Error(`不允许创建的 DOM 标签：${tag}`);
    }

    const node = document.createElement(tag);
    if (options.className) node.className = options.className;
    if (Object.hasOwn(options, 'text')) node.textContent = text(options.text);
    if (options.ariaLabel) node.setAttribute('aria-label', options.ariaLabel);
    if (options.type && (tag === 'button' || tag === 'input')) node.setAttribute('type', options.type);
    if (typeof options.disabled === 'boolean' && ['button', 'input', 'select', 'textarea'].includes(tag)) node.disabled = options.disabled;
    if (typeof options.pressed === 'boolean' && tag === 'button') node.setAttribute('aria-pressed', String(options.pressed));
    if (typeof options.hidden === 'boolean') node.hidden = options.hidden;
    if (typeof options.htmlFor === 'string' && tag === 'label') node.htmlFor = options.htmlFor;
    for (const key of PROPERTY_OPTIONS) {
        if (!Object.hasOwn(options, key)) continue;
        if (key === 'checked' && tag === 'input') node.checked = Boolean(options[key]);
        else if (key === 'value' && ['input', 'textarea', 'option', 'select'].includes(tag)) node.value = text(options[key]);
        else if (key === 'rows' && tag === 'textarea') node.rows = Number(options[key]);
        else if (key === 'multiple' && (tag === 'input' || tag === 'select')) node.multiple = Boolean(options[key]);
        else if (['min', 'max', 'minLength', 'maxLength'].includes(key) && ['input', 'textarea'].includes(tag)) node[key] = Number(options[key]);
        else if (['accept', 'autocomplete', 'download', 'id', 'inputMode', 'name', 'placeholder'].includes(key)) node.setAttribute(key === 'inputMode' ? 'inputmode' : key, text(options[key]));
        else if (key === 'alt' && tag === 'img') node.setAttribute('alt', text(options[key]));
        else if (key === 'loading' && tag === 'img') node.setAttribute('loading', text(options[key]));
        else if (key === 'referrerPolicy' && tag === 'img') node.setAttribute('referrerpolicy', text(options[key]));
        else if (key === 'src' && tag === 'img') {
            const source = safeImageSource(options[key]);
            if (source) node.setAttribute('src', source);
        }
    }
    return node;
}

/** @param {Node} parent @param {(Node | string | null | undefined)[]} children */
export function append(parent, children) {
    for (const child of children) {
        if (typeof child === 'string') parent.appendChild(document.createTextNode(child));
        else if (child instanceof Node) parent.appendChild(child);
    }
    return parent;
}

/** @param {HTMLElement} node @param {EventTarget} target @param {string} event @param {(event: Event) => void} listener @param {AbortSignal} signal */
export function listen(node, target, event, listener, signal) {
    target.addEventListener(event, listener, { signal });
    return node;
}

