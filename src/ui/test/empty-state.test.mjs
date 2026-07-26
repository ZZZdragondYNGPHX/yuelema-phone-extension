import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createEmptyState, EMPTY_STATE_VARIANTS } from '../empty-state.js';

test('三款变体：变体类 + 本地 SVG 插画（aria-hidden、data-illustration）', () => {
    const env = installMiniDom();
    try {
        assert.deepEqual([...EMPTY_STATE_VARIANTS], ['inbox', 'search', 'heart']);
        for (const variant of EMPTY_STATE_VARIANTS) {
            const empty = createEmptyState({ documentRef: env.document, variant, title: '这里还是空的' });
            assert.ok(empty.classList.contains('yl-empty'));
            assert.ok(empty.classList.contains(`yl-empty--${variant}`));
            const art = empty.querySelector('.yl-empty__art');
            const svg = art.childNodes[0];
            assert.equal(svg.tagName, 'SVG');
            assert.ok(svg.className.includes('yl-empty__svg'));
            assert.equal(svg.getAttribute('viewBox'), '0 0 96 96');
            assert.equal(svg.getAttribute('aria-hidden'), 'true');
            assert.equal(svg.getAttribute('focusable'), 'false');
            assert.equal(svg.getAttribute('stroke'), 'currentColor');
            assert.equal(svg.dataset.illustration, variant);
            assert.ok(svg.childNodes.length >= 2, '插画为多路径本地 SVG');
            for (const child of svg.childNodes) assert.equal(child.tagName, 'PATH');
        }
    } finally { env.restore(); }
});

test('标题必填、hint 可选、无 action 时不渲染按钮', () => {
    const env = installMiniDom();
    try {
        const empty = createEmptyState({ documentRef: env.document, variant: 'inbox', title: '还没有消息', hint: '匹配成功后就可以开始聊天了' });
        assert.equal(empty.querySelector('.yl-empty__title').textContent, '还没有消息');
        assert.equal(empty.querySelector('.yl-empty__hint').textContent, '匹配成功后就可以开始聊天了');
        assert.equal(empty.querySelectorAll('.yl-empty__action').length, 0);

        const minimal = createEmptyState({ documentRef: env.document, variant: 'search', title: '没有找到结果' });
        assert.equal(minimal.querySelector('.yl-empty__hint'), null);

        assert.throws(() => createEmptyState({ documentRef: env.document, variant: 'heart', title: '' }), /yl_empty_title_required/u);
        assert.throws(() => createEmptyState({ documentRef: env.document, variant: 'ghost', title: 'x' }), /yl_empty_variant_invalid/u);
    } finally { env.restore(); }
});

test('action 配置渲染统一按钮（默认 tonal）并可点击', () => {
    const env = installMiniDom();
    try {
        let clicks = 0;
        const empty = createEmptyState({
            documentRef: env.document,
            variant: 'heart',
            title: '还没有心动对象',
            action: { label: '去匹配', onClick: () => { clicks += 1; } },
        });
        const button = empty.querySelector('.yl-empty__action');
        assert.equal(button.tagName, 'BUTTON');
        assert.ok(button.classList.contains('yl-btn'));
        assert.ok(button.classList.contains('yl-btn--tonal'), '缺省动作按钮为 tonal');
        assert.equal(button.querySelector('.yl-btn__label').textContent, '去匹配');
        button.dispatchEvent(new Event('click'));
        assert.equal(clicks, 1);

        const primary = createEmptyState({
            documentRef: env.document,
            variant: 'inbox',
            title: '空空如也',
            action: { label: '刷新', variant: 'primary', icon: 'refresh' },
        });
        const primaryButton = primary.querySelector('.yl-empty__action');
        assert.ok(primaryButton.classList.contains('yl-btn--primary'));
        assert.equal(primaryButton.querySelectorAll('svg').length, 1);
    } finally { env.restore(); }
});
