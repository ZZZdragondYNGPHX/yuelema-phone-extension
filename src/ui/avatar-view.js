/**
 * Safe, presentation-only avatar DOM builder shared by NPC, player and group views.
 *
 * Image values are normalized through the existing character/player avatar policy.
 * This keeps protocols and embedded-image formats bounded while leaving storage,
 * matching and profile projection to their existing owners.
 */
import { normalizeAvatarReference } from '../characters/character-template-codec.js';
import { avatarImageSource } from '../player-avatar-store.js';

const DEFAULT_FALLBACK = '人';

function ownEnumerableData(record, key) {
    if (!record || typeof record !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined;
    return descriptor.value;
}

function asAvatarReference(input) {
    if (typeof input === 'string') {
        if (input.startsWith('data:')) return { kind: 'embedded', dataUrl: input };
        return { kind: 'url', url: input };
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

    // Image-library matches wrap their already-normalized source in { source }.
    // Read only an enumerable data property so an untrusted getter is never run.
    const wrappedSource = ownEnumerableData(input, 'source');
    return wrappedSource === undefined ? input : wrappedSource;
}

/**
 * Returns a browser-loadable avatar source or an empty string.
 *
 * Accepted inputs:
 * - a bounded http/https URL string;
 * - a bounded PNG/JPEG/WebP base64 data URL string;
 * - an existing { kind: 'url'|'embedded', ... } avatar/image source;
 * - an image-library record shaped as { source: { kind, ... } }.
 */
export function safeAvatarImageSource(input) {
    try {
        const reference = asAvatarReference(input);
        if (!reference) return '';
        return avatarImageSource(normalizeAvatarReference(reference));
    } catch {
        return '';
    }
}

/** Returns the first Unicode code point of the nickname, with a stable fallback. */
export function avatarFallbackText(nickname, fallback = DEFAULT_FALLBACK) {
    const label = typeof nickname === 'string' ? nickname.trim() : '';
    if (label) return [...label][0] ?? DEFAULT_FALLBACK;
    const safeFallback = typeof fallback === 'string' ? fallback.trim() : '';
    return safeFallback ? ([...safeFallback][0] ?? DEFAULT_FALLBACK) : DEFAULT_FALLBACK;
}

/**
 * Creates an avatar container without HTML-string rendering.
 * Invalid sources render the nickname initial immediately; image load failures
 * remove the failed image and restore the same fallback text.
 */
export function createAvatarView({
    documentRef = globalThis.document,
    nickname = '',
    imageSource = '',
    className = '',
    imageClassName = '',
    alt = '',
    fallback = DEFAULT_FALLBACK,
    tagName = 'span',
} = {}) {
    if (!documentRef || typeof documentRef.createElement !== 'function') {
        throw new TypeError('avatar_view_document_required');
    }

    const safeTagName = typeof tagName === 'string' && /^[a-z][a-z0-9-]*$/iu.test(tagName) ? tagName : 'span';
    const root = documentRef.createElement(safeTagName);
    if (typeof className === 'string' && className) root.className = className;

    const fallbackText = avatarFallbackText(nickname, fallback);
    const source = safeAvatarImageSource(imageSource);
    if (!source) {
        root.textContent = fallbackText;
        root.dataset.imageStatus = 'fallback';
        return root;
    }

    const image = documentRef.createElement('img');
    if (typeof imageClassName === 'string' && imageClassName) image.className = imageClassName;
    image.setAttribute('src', source);
    image.setAttribute('alt', typeof alt === 'string' && alt ? alt : `${typeof nickname === 'string' && nickname.trim() ? nickname.trim() : '用户'}的头像`);
    image.setAttribute('loading', 'lazy');
    image.setAttribute('referrerpolicy', 'no-referrer');
    image.setAttribute('decoding', 'async');
    root.dataset.imageStatus = 'loading';

    image.addEventListener('load', () => {
        if (image.parentNode === root) root.dataset.imageStatus = 'ready';
    }, { once: true });
    image.addEventListener('error', () => {
        if (image.parentNode !== root) return;
        image.remove();
        root.textContent = fallbackText;
        root.dataset.imageStatus = 'failed';
    }, { once: true });

    root.appendChild(image);
    return root;
}
