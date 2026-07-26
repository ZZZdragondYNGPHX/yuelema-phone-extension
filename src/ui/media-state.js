const MEDIA_STATE_SET = new Set(['loading', 'ready', 'empty', 'error']);

export const MEDIA_STATE_NAMES = Object.freeze([...MEDIA_STATE_SET]);

const DEFAULT_TEXT = Object.freeze({
    media: Object.freeze({
        loading: '正在加载候选媒体。',
        ready: '候选媒体已加载。',
        empty: '暂时没有候选媒体。',
        error: '候选媒体加载失败。',
    }),
    background: Object.freeze({
        loading: '正在加载候选背景。',
        ready: '候选背景已加载。',
        empty: '暂时没有候选背景。',
        error: '候选背景加载失败。',
    }),
    avatar: Object.freeze({
        loading: '正在加载候选头像。',
        ready: '候选头像已加载。',
        empty: '暂时没有候选头像。',
        error: '候选头像加载失败。',
    }),
});

function requireDocument(documentRef) {
    if (!documentRef || typeof documentRef.createElement !== 'function') {
        throw new TypeError('media_state_document_required');
    }
    return documentRef;
}

function normalizeState(state) {
    if (typeof state !== 'string' || !MEDIA_STATE_SET.has(state)) {
        throw new RangeError('media_state_invalid');
    }
    return state;
}

function normalizeKind(kind) {
    return typeof kind === 'string' && Object.hasOwn(DEFAULT_TEXT, kind) ? kind : 'media';
}

function ownString(record, key) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return '';
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return '';
    return typeof descriptor.value === 'string' && descriptor.value.trim() ? descriptor.value.trim() : '';
}

function className(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/**
 * Creates a dependency-free DOM status view for candidate backgrounds and avatars.
 *
 * The view never loads media itself. Its only side effect is invoking the injected
 * retry callback after an enabled native button is activated while in the error state.
 */
export function createMediaState({
    documentRef = globalThis.document,
    kind = 'media',
    initialState = 'empty',
    stateText = {},
    retryLabel = '重试加载',
    onRetry = null,
    className: rootClassName = 'yl-media-state',
    statusClassName = 'yl-media-state__status',
    retryClassName = 'yl-media-state__retry',
} = {}) {
    const document = requireDocument(documentRef);
    const mediaKind = normalizeKind(kind);
    let currentState = normalizeState(initialState);

    if (onRetry !== null && typeof onRetry !== 'function') {
        throw new TypeError('media_state_retry_handler_invalid');
    }

    const root = document.createElement('div');
    root.className = className(rootClassName, 'yl-media-state');
    root.dataset.mediaKind = mediaKind;

    const status = document.createElement('span');
    status.className = className(statusClassName, 'yl-media-state__status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');

    const retryButton = document.createElement('button');
    retryButton.className = className(retryClassName, 'yl-media-state__retry');
    retryButton.setAttribute('type', 'button');
    retryButton.textContent = typeof retryLabel === 'string' && retryLabel.trim() ? retryLabel.trim() : '重试加载';

    root.appendChild(status);

    function textFor(state, override) {
        if (typeof override === 'string' && override.trim()) return override.trim();
        return ownString(stateText, state) || DEFAULT_TEXT[mediaKind][state];
    }

    function render(state, statusText) {
        currentState = normalizeState(state);
        const canRetry = currentState === 'error' && typeof onRetry === 'function';
        root.dataset.mediaState = currentState;
        root.setAttribute('aria-busy', String(currentState === 'loading'));
        status.textContent = textFor(currentState, statusText);
        retryButton.disabled = !canRetry;
        retryButton.hidden = currentState !== 'error';
        retryButton.setAttribute('aria-disabled', String(!canRetry));
        if (currentState === 'error') {
            if (retryButton.parentNode !== root) root.appendChild(retryButton);
        } else if (retryButton.parentNode === root) {
            retryButton.remove();
        }
        return currentState;
    }

    function handleRetry(event) {
        if (currentState !== 'error' || retryButton.disabled || typeof onRetry !== 'function') return;
        onRetry(event);
    }

    retryButton.addEventListener('click', handleRetry);
    render(currentState);

    return Object.freeze({
        element: root,
        statusElement: status,
        retryButton,
        getState() {
            return currentState;
        },
        setState(nextState, { statusText = '' } = {}) {
            return render(nextState, statusText);
        },
        destroy() {
            retryButton.removeEventListener('click', handleRetry);
        },
    });
}
