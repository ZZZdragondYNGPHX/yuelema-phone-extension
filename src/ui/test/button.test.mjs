import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createButton, BUTTON_VARIANTS } from '../button.js';

test('每个变体都渲染为 type=button 且携带 yl-btn 基类与变体类', () => {
    const env = installMiniDom();
    try {
        for (const variant of BUTTON_VARIANTS) {
            const button = createButton({
                documentRef: env.document,
                variant,
                label: variant === 'icon' ? '' : '确认',
                icon: variant === 'icon' ? 'close' : null,
                ariaLabel: variant === 'icon' ? '关闭' : '',
            });
            assert.equal(button.tagName, 'BUTTON');
            assert.equal(button.getAttribute('type'), 'button');
            assert.ok(button.classList.contains('yl-btn'));
            assert.ok(button.classList.contains(`yl-btn--${variant}`));
        }
    } finally { env.restore(); }
});

test('文本按钮渲染 yl-btn__label，可选图标渲染在 label 之前', () => {
    const env = installMiniDom();
    try {
        const button = createButton({ documentRef: env.document, variant: 'primary', label: '开始匹配', icon: 'hearts' });
        assert.equal(button.childNodes.length, 2);
        assert.equal(button.childNodes[0].tagName, 'SVG');
        assert.ok(button.childNodes[0].className.includes('yl-btn__icon'));
        assert.equal(button.childNodes[0].dataset.icon, 'hearts');
        assert.ok(button.childNodes[1].classList.contains('yl-btn__label'));
        assert.equal(button.childNodes[1].textContent, '开始匹配');
    } finally { env.restore(); }
});

test('icon 变体是纯图标按钮：必须有 ariaLabel 与 icon，不渲染 label', () => {
    const env = installMiniDom();
    try {
        const button = createButton({ documentRef: env.document, variant: 'icon', icon: 'close', ariaLabel: '关闭' });
        assert.equal(button.getAttribute('aria-label'), '关闭');
        assert.equal(button.querySelectorAll('.yl-btn__label').length, 0);
        assert.equal(button.childNodes.length, 1);
        assert.equal(button.childNodes[0].tagName, 'SVG');

        assert.throws(() => createButton({ documentRef: env.document, variant: 'icon', icon: 'close' }), /yl_button_icon_aria_label_required/u);
        assert.throws(() => createButton({ documentRef: env.document, variant: 'icon', ariaLabel: '关闭' }), /yl_button_icon_name_required/u);
    } finally { env.restore(); }
});

test('非 icon 变体缺 label、未知变体都会 fail fast', () => {
    const env = installMiniDom();
    try {
        assert.throws(() => createButton({ documentRef: env.document, variant: 'primary' }), /yl_button_label_required/u);
        assert.throws(() => createButton({ documentRef: env.document, variant: 'mega', label: 'x' }), /yl_button_variant_invalid/u);
    } finally { env.restore(); }
});

test('点击触发 onClick；disabled 时点击被拦截且不抛出', () => {
    const env = installMiniDom();
    try {
        let clicks = 0;
        const button = createButton({ documentRef: env.document, label: '发送', onClick: () => { clicks += 1; } });
        button.dispatchEvent(new Event('click'));
        assert.equal(clicks, 1);

        const disabledButton = createButton({ documentRef: env.document, label: '发送', disabled: true, onClick: () => { clicks += 1; } });
        assert.equal(disabledButton.disabled, true);
        disabledButton.dispatchEvent(new Event('click'));
        assert.equal(clicks, 1, 'disabled 按钮不得触发 onClick');

        disabledButton.disabled = false;
        disabledButton.dispatchEvent(new Event('click'));
        assert.equal(clicks, 2, '解除 disabled 后恢复可点击');
    } finally { env.restore(); }
});

test('onClick 抛异常不会向外冒泡破坏按钮', () => {
    const env = installMiniDom();
    try {
        const button = createButton({ documentRef: env.document, label: '危险操作', variant: 'danger', onClick: () => { throw new Error('boom'); } });
        assert.doesNotThrow(() => button.dispatchEvent(new Event('click')));
    } finally { env.restore(); }
});
