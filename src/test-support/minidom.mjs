/**
 * Minimal dependency-free DOM for focused Node interaction tests.
 * It deliberately implements only the element, selector and event behavior used by
 * the character editor; it is not a browser compatibility layer.
 */
class MiniNode extends EventTarget {
    constructor() {
        super();
        this.childNodes = [];
        this.parentNode = null;
        this._textContent = '';
    }

    replaceChildren(...children) {
        for (const child of this.childNodes) child.parentNode = null;
        this.childNodes = [];
        for (const child of children) this.appendChild(child);
    }

    appendChild(child) {
        if (!(child instanceof MiniNode)) throw new TypeError('MiniDOM 只能追加 MiniNode。');
        child.remove();
        this.childNodes.push(child);
        child.parentNode = this;
        return child;
    }

    remove() {
        if (!this.parentNode) return;
        const index = this.parentNode.childNodes.indexOf(this);
        if (index >= 0) this.parentNode.childNodes.splice(index, 1);
        this.parentNode = null;
    }

    get textContent() {
        return `${this._textContent}${this.childNodes.map((child) => child.textContent).join('')}`;
    }

    set textContent(value) {
        this._textContent = String(value ?? '');
        for (const child of this.childNodes) child.parentNode = null;
        this.childNodes = [];
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
    }

    querySelectorAll(selector) {
        const matches = [];
        const visit = (node) => {
            for (const child of node.childNodes) {
                if (child instanceof MiniElement && child.matches(selector)) matches.push(child);
                visit(child);
            }
        };
        visit(this);
        return matches;
    }
}

class MiniTextNode extends MiniNode {
    constructor(value) {
        super();
        this._textContent = String(value ?? '');
    }
}

class MiniElement extends MiniNode {
    constructor(tagName) {
        super();
        this.tagName = String(tagName).toUpperCase();
        this.attributes = new Map();
        this.className = '';
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.hidden = false;
        this.files = [];
        this.rows = 0;
        this.multiple = false;
        this.dataset = {};
        const setToken = (name, present) => {
            const token = String(name);
            const tokens = this.className.split(/\s+/u).filter(Boolean);
            const has = tokens.includes(token);
            const output = present ? (has ? tokens : [...tokens, token]) : tokens.filter((item) => item !== token);
            this.className = output.join(' ');
        };
        this.classList = Object.freeze({
            contains: (name) => this.className.split(/\s+/u).includes(String(name)),
            // DOM 标准最简实现：add/remove 支持多 token、幂等，返回 undefined；不改动既有 contains/toggle 行为。
            add: (...names) => { for (const name of names) setToken(name, true); },
            remove: (...names) => { for (const name of names) setToken(name, false); },
            toggle: (name, force) => {
                const token = String(name);
                const present = this.className.split(/\s+/u).filter(Boolean).includes(token);
                const next = force === undefined ? !present : Boolean(force);
                setToken(token, next);
                return next;
            },
        });
    }

    setAttribute(name, value) {
        const key = String(name);
        const text = String(value ?? '');
        this.attributes.set(key, text);
        if (key === 'class') this.className = text;
        if (key === 'value') this.value = text;
    }

    getAttribute(name) {
        return this.attributes.get(String(name)) ?? null;
    }

    focus() {
        const documentRef = this.ownerDocument ?? globalThis.document;
        if (documentRef) documentRef.activeElement = this;
    }

    matches(selector) {
        const nameMatch = /^\[name="([^"]+)"\]$/u.exec(selector);
        if (nameMatch) return this.getAttribute('name') === nameMatch[1];
        const dataMatch = /^\[data-([A-Za-z0-9_-]+)\]$/u.exec(selector);
        if (dataMatch) return Object.hasOwn(this.dataset, dataMatch[1].replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase()));
        if (/^\.[A-Za-z0-9_-]+$/u.test(selector)) return this.className.split(/\s+/u).includes(selector.slice(1));
        return this.tagName.toLowerCase() === String(selector).toLowerCase();
    }
}

class MiniDocument extends MiniNode {
    constructor() {
        super();
        this.ownerDocument = this;
        this.activeElement = null;
        this.body = new MiniElement('body');
        this.body.ownerDocument = this;
        this.appendChild(this.body);
    }

    createElement(tagName) {
        const node = new MiniElement(tagName);
        node.ownerDocument = this;
        return node;
    }

    createElementNS(_namespace, tagName) {
        return this.createElement(tagName);
    }

    createTextNode(value) {
        return new MiniTextNode(value);
    }
}

/** Installs a reversible MiniDOM into the current Node test worker. */
export function installMiniDom() {
    const previousDocument = globalThis.document;
    const previousNode = globalThis.Node;
    const document = new MiniDocument();
    globalThis.document = document;
    globalThis.Node = MiniNode;
    return Object.freeze({
        document,
        restore() {
            if (previousDocument === undefined) delete globalThis.document;
            else globalThis.document = previousDocument;
            if (previousNode === undefined) delete globalThis.Node;
            else globalThis.Node = previousNode;
        },
    });
}

