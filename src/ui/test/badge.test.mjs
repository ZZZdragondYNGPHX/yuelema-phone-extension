import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createUnreadBadge, createStatusChip, createTagChip, STATUS_CHIP_TONES } from '../badge.js';

test('未读徽章 99+ 边界：99 原样、100 显示 99+，非正数返回 null', () => {
    const env = installMiniDom();
    try {
        const doc = env.document;
        assert.equal(createUnreadBadge(0, { documentRef: doc }), null);
        assert.equal(createUnreadBadge(-3, { documentRef: doc }), null);
        assert.equal(createUnreadBadge(Number.NaN, { documentRef: doc }), null);
        assert.equal(createUnreadBadge('abc', { documentRef: doc }), null);

        const one = createUnreadBadge(1, { documentRef: doc });
        assert.equal(one.textContent, '1');
        assert.ok(one.classList.contains('yl-badge'));
        assert.ok(one.classList.contains('yl-badge--unread'));
        assert.equal(one.getAttribute('aria-label'), '1 条未读');

        assert.equal(createUnreadBadge(99, { documentRef: doc }).textContent, '99');
        const overflow = createUnreadBadge(100, { documentRef: doc });
        assert.equal(overflow.textContent, '99+');
        assert.equal(overflow.getAttribute('aria-label'), '99+ 条未读');
        assert.equal(createUnreadBadge(1234, { documentRef: doc }).textContent, '99+');
        assert.equal(createUnreadBadge(5.9, { documentRef: doc }).textContent, '5', '小数向下取整');
    } finally { env.restore(); }
});

test('状态 chip：六种 tone 各得对应类，未知 tone / 空文本 fail fast', () => {
    const env = installMiniDom();
    try {
        for (const tone of STATUS_CHIP_TONES) {
            const chip = createStatusChip({ documentRef: env.document, text: '已匹配', tone });
            assert.equal(chip.tagName, 'SPAN');
            assert.ok(chip.classList.contains('yl-chip'));
            assert.ok(chip.classList.contains('yl-chip--status'));
            assert.ok(chip.classList.contains(`yl-chip--${tone}`));
            assert.equal(chip.textContent, '已匹配');
        }
        const fallback = createStatusChip({ documentRef: env.document, text: '默认' });
        assert.ok(fallback.classList.contains('yl-chip--neutral'), '缺省 tone 为 neutral');

        assert.throws(() => createStatusChip({ documentRef: env.document, text: 'x', tone: 'gold' }), /yl_chip_tone_invalid/u);
        assert.throws(() => createStatusChip({ documentRef: env.document, text: '  ' }), /yl_chip_text_required/u);
    } finally { env.restore(); }
});

test('标签 chip：yl-chip--tag、纯文本、空文本 fail fast', () => {
    const env = installMiniDom();
    try {
        const chip = createTagChip('夜跑', { documentRef: env.document });
        assert.ok(chip.classList.contains('yl-chip'));
        assert.ok(chip.classList.contains('yl-chip--tag'));
        assert.equal(chip.textContent, '夜跑');
        assert.equal(chip.childNodes.length, 0, '标签 chip 不含子元素');
        assert.throws(() => createTagChip('', { documentRef: env.document }), /yl_chip_text_required/u);
    } finally { env.restore(); }
});
