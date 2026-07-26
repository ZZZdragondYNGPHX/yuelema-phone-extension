import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createMediaState, MEDIA_STATE_NAMES } from '../media-state.js';

test('candidate avatar loading state exposes polite live-region and busy semantics', () => {
    const env = installMiniDom();
    try {
        const view = createMediaState({
            documentRef: env.document,
            kind: 'avatar',
            initialState: 'loading',
        });

        assert.equal(view.element.tagName, 'DIV');
        assert.equal(view.element.dataset.mediaKind, 'avatar');
        assert.equal(view.element.dataset.mediaState, 'loading');
        assert.equal(view.element.getAttribute('aria-busy'), 'true');
        assert.equal(view.statusElement.getAttribute('role'), 'status');
        assert.equal(view.statusElement.getAttribute('aria-live'), 'polite');
        assert.equal(view.statusElement.getAttribute('aria-atomic'), 'true');
        assert.equal(view.statusElement.textContent, '正在加载候选头像。');
        assert.equal(view.retryButton.tagName, 'BUTTON');
        assert.equal(view.retryButton.getAttribute('type'), 'button');
        assert.equal(view.retryButton.disabled, true);
        assert.equal(view.retryButton.hidden, true);
        assert.equal(view.retryButton.getAttribute('aria-disabled'), 'true');
    } finally {
        env.restore();
    }
});

test('background view transitions through ready, empty, error, and loading states', () => {
    const env = installMiniDom();
    try {
        const view = createMediaState({
            documentRef: env.document,
            kind: 'background',
            initialState: 'ready',
            stateText: {
                ready: '背景已经准备好。',
                empty: '这位候选人还没有背景图。',
            },
            onRetry() {},
        });

        assert.equal(view.getState(), 'ready');
        assert.equal(view.statusElement.textContent, '背景已经准备好。');
        assert.equal(view.element.getAttribute('aria-busy'), 'false');

        assert.equal(view.setState('empty'), 'empty');
        assert.equal(view.statusElement.textContent, '这位候选人还没有背景图。');
        assert.equal(view.retryButton.hidden, true);
        assert.equal(view.retryButton.disabled, true);

        assert.equal(view.setState('error', { statusText: '背景暂时无法显示，请重试。' }), 'error');
        assert.equal(view.statusElement.textContent, '背景暂时无法显示，请重试。');
        assert.equal(view.retryButton.hidden, false);
        assert.equal(view.retryButton.disabled, false);
        assert.equal(view.retryButton.getAttribute('aria-disabled'), 'false');

        assert.equal(view.setState('loading'), 'loading');
        assert.equal(view.statusElement.textContent, '正在加载候选背景。');
        assert.equal(view.element.getAttribute('aria-busy'), 'true');
        assert.equal(view.retryButton.hidden, true);
        assert.equal(view.retryButton.disabled, true);
    } finally {
        env.restore();
    }
});

test('retry activation only invokes the injected callback while error is actionable', () => {
    const env = installMiniDom();
    try {
        const received = [];
        const view = createMediaState({
            documentRef: env.document,
            initialState: 'loading',
            retryLabel: '重新加载头像',
            onRetry: (event) => received.push(event.type),
        });

        assert.equal(view.retryButton.textContent, '重新加载头像');
        view.retryButton.dispatchEvent(new Event('click'));
        assert.deepEqual(received, []);

        view.setState('error');
        view.retryButton.dispatchEvent(new Event('click'));
        assert.deepEqual(received, ['click']);
        assert.equal(view.getState(), 'error');

        view.destroy();
        view.retryButton.dispatchEvent(new Event('click'));
        assert.deepEqual(received, ['click']);
    } finally {
        env.restore();
    }
});

test('error without a retry callback keeps the native button visible but disabled', () => {
    const env = installMiniDom();
    try {
        const view = createMediaState({
            documentRef: env.document,
            kind: 'avatar',
            initialState: 'error',
        });

        assert.equal(view.retryButton.hidden, false);
        assert.equal(view.retryButton.disabled, true);
        assert.equal(view.retryButton.getAttribute('aria-disabled'), 'true');
        assert.doesNotThrow(() => view.retryButton.dispatchEvent(new Event('click')));
    } finally {
        env.restore();
    }
});

test('component is media-source agnostic and creates no image or remote URL surface', () => {
    const env = installMiniDom();
    try {
        const view = createMediaState({ documentRef: env.document, kind: 'avatar' });

        assert.equal(view.element.querySelector('img'), null);
        assert.equal(view.element.querySelector('source'), null);
        assert.equal(view.element.getAttribute('src'), null);
        assert.equal(view.statusElement.getAttribute('src'), null);
        assert.equal(view.retryButton.getAttribute('src'), null);
    } finally {
        env.restore();
    }
});

test('invalid dependencies and states fail closed', () => {
    assert.deepEqual(MEDIA_STATE_NAMES, ['loading', 'ready', 'empty', 'error']);
    assert.equal(Object.isFrozen(MEDIA_STATE_NAMES), true);
    assert.throws(() => createMediaState({ documentRef: null }), /media_state_document_required/u);

    const env = installMiniDom();
    try {
        assert.throws(() => createMediaState({ documentRef: env.document, initialState: 'pending' }), /media_state_invalid/u);
        assert.throws(() => createMediaState({ documentRef: env.document, onRetry: 'reload' }), /media_state_retry_handler_invalid/u);

        const view = createMediaState({ documentRef: env.document });
        assert.throws(() => view.setState('failed'), /media_state_invalid/u);
        assert.equal(view.getState(), 'empty');
    } finally {
        env.restore();
    }
});

