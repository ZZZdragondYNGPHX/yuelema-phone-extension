/**
 * JSON Pointer helpers for the phone extension's MVU boundary.
 *
 * These helpers deliberately accept only own data properties. They never traverse
 * prototype keys, so a hostile UID/path cannot reach Object.prototype.
 */
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const ARRAY_INDEX = /^(0|[1-9]\d*)$/;

export function isPlainRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/** @param {unknown} pointer @returns {string[]} */
export function decodeJsonPointer(pointer) {
    if (typeof pointer !== 'string' || !pointer.startsWith('/')) {
        throw new TypeError('JSON Pointer 必须是以 / 开头的字符串。');
    }

    const segments = pointer.slice(1).split('/').map((segment) => {
        if (/~(?:[^01]|$)/.test(segment)) {
            throw new TypeError('JSON Pointer 含有无效的 ~ 转义。');
        }
        const decoded = segment.replace(/~1/g, '/').replace(/~0/g, '~');
        if (UNSAFE_SEGMENTS.has(decoded)) {
            throw new TypeError('JSON Pointer 不允许访问原型链字段。');
        }
        return decoded;
    });

    if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
        throw new TypeError('JSON Pointer 不允许空路径段。');
    }
    return segments;
}

/** @param {string[]} segments */
export function encodeJsonPointer(segments) {
    if (!Array.isArray(segments) || segments.length === 0) {
        throw new TypeError('JSON Pointer 至少需要一个路径段。');
    }
    return `/${segments.map((segment) => {
        const text = String(segment);
        if (!text || UNSAFE_SEGMENTS.has(text)) throw new TypeError('JSON Pointer 含不安全路径段。');
        return text.replace(/~/g, '~0').replace(/\//g, '~1');
    }).join('/')}`;
}

/**
 * Own-property-only lookup. `-` is never a readable array index.
 * @param {unknown} root
 * @param {string} pointer
 */
export function getAtPointer(root, pointer) {
    const segments = decodeJsonPointer(pointer);
    let current = root;
    for (const segment of segments) {
        if (Array.isArray(current)) {
            if (!ARRAY_INDEX.test(segment)) return { found: false, value: undefined };
            const index = Number(segment);
            if (index >= current.length) return { found: false, value: undefined };
            current = current[index];
            continue;
        }
        if (!isPlainRecord(current) || !Object.hasOwn(current, segment)) {
            return { found: false, value: undefined };
        }
        current = current[segment];
    }
    return { found: true, value: current };
}

export function hasUnsafePointerSegment(pointer) {
    try {
        decodeJsonPointer(pointer);
        return false;
    } catch {
        return true;
    }
}
