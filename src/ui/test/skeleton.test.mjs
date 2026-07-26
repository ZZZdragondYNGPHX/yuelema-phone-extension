import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createSkeleton, SKELETON_VARIANTS } from '../skeleton.js';

test('根节点合同：yl-skeleton + 变体类 + aria-hidden，count 控制条目数', () => {
    const env = installMiniDom();
    try {
        assert.deepEqual([...SKELETON_VARIANTS], ['candidate-card', 'post', 'list-row']);
        for (const variant of SKELETON_VARIANTS) {
            const skeleton = createSkeleton({ documentRef: env.document, variant, count: 3 });
            assert.ok(skeleton.classList.contains('yl-skeleton'));
            assert.ok(skeleton.classList.contains(`yl-skeleton--${variant}`));
            assert.equal(skeleton.getAttribute('aria-hidden'), 'true');
            const items = skeleton.querySelectorAll(`.yl-skeleton__item--${variant}`);
            assert.equal(items.length, 3);
            for (const item of items) assert.ok(item.classList.contains('yl-skeleton__item'));
        }
    } finally { env.restore(); }
});

test('list-row 形状：头像圆 + 两条文本条（次条 short）', () => {
    const env = installMiniDom();
    try {
        const skeleton = createSkeleton({ documentRef: env.document, variant: 'list-row' });
        const item = skeleton.childNodes[0];
        assert.ok(item.childNodes[0].classList.contains('yl-skeleton__avatar'));
        const lineBox = item.childNodes[1];
        assert.ok(lineBox.classList.contains('yl-skeleton__lines'));
        assert.equal(lineBox.childNodes.length, 2);
        assert.equal(lineBox.childNodes[0].className, 'yl-skeleton__line');
        assert.ok(lineBox.childNodes[1].classList.contains('yl-skeleton__line--short'));
        assert.equal(item.querySelectorAll('.yl-skeleton__media').length, 0, '列表行骨架无媒体块');
    } finally { env.restore(); }
});

test('candidate-card 形状：媒体块在最前 + 头像 + 三条文本条', () => {
    const env = installMiniDom();
    try {
        const skeleton = createSkeleton({ documentRef: env.document, variant: 'candidate-card' });
        const item = skeleton.childNodes[0];
        assert.ok(item.childNodes[0].classList.contains('yl-skeleton__media'));
        assert.ok(item.childNodes[1].classList.contains('yl-skeleton__avatar'));
        const lineBox = item.childNodes[2];
        assert.equal(lineBox.childNodes.length, 3);
        assert.ok(lineBox.childNodes[2].classList.contains('yl-skeleton__line--short'));
    } finally { env.restore(); }
});

test('post 形状：头像 + 四条文本条（首条 half）+ 媒体块居后', () => {
    const env = installMiniDom();
    try {
        const skeleton = createSkeleton({ documentRef: env.document, variant: 'post' });
        const item = skeleton.childNodes[0];
        assert.ok(item.childNodes[0].classList.contains('yl-skeleton__avatar'));
        const lineBox = item.childNodes[1];
        assert.equal(lineBox.childNodes.length, 4);
        assert.ok(lineBox.childNodes[0].classList.contains('yl-skeleton__line--half'));
        assert.ok(item.childNodes[2].classList.contains('yl-skeleton__media'));
    } finally { env.restore(); }
});

test('count 边界：缺省 1、超过 12 收敛为 12、非法值 fail fast', () => {
    const env = installMiniDom();
    try {
        assert.equal(createSkeleton({ documentRef: env.document, variant: 'post' }).childNodes.length, 1);
        assert.equal(createSkeleton({ documentRef: env.document, variant: 'list-row', count: 40 }).childNodes.length, 12);
        assert.throws(() => createSkeleton({ documentRef: env.document, variant: 'list-row', count: 0 }), /yl_skeleton_count_invalid/u);
        assert.throws(() => createSkeleton({ documentRef: env.document, variant: 'list-row', count: 1.5 }), /yl_skeleton_count_invalid/u);
        assert.throws(() => createSkeleton({ documentRef: env.document, variant: 'table' }), /yl_skeleton_variant_invalid/u);
    } finally { env.restore(); }
});
