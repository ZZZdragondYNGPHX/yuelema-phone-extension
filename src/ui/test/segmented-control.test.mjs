import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createSegmentedControl } from '../segmented-control.js';

const SEGMENTS = Object.freeze([
    { id: 'square', label: '广场' },
    { id: 'group', label: '群聊' },
    { id: 'nearby', label: '附近' },
]);

function keyEvent(key) {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperty(event, 'key', { configurable: true, value: key });
    return event;
}

function items(control) {
    return control.root.querySelectorAll('.yl-seg__item');
}

test('radiogroup 结构与 roving tabindex：激活项 tabindex=0/aria-checked=true/is-active', () => {
    const env = installMiniDom();
    try {
        const control = createSegmentedControl({ documentRef: env.document, segments: SEGMENTS, ariaLabel: '社区内容切换' });
        assert.ok(control.root.classList.contains('yl-seg'));
        assert.equal(control.root.getAttribute('role'), 'radiogroup');
        assert.equal(control.root.getAttribute('aria-label'), '社区内容切换');

        const buttons = items(control);
        assert.equal(buttons.length, 3);
        assert.equal(control.getActiveId(), 'square', '未指定 activeId 时默认第一段');
        for (const [index, button] of buttons.entries()) {
            assert.equal(button.tagName, 'BUTTON');
            assert.equal(button.getAttribute('type'), 'button');
            assert.equal(button.getAttribute('role'), 'radio');
            assert.equal(button.dataset.segmentId, SEGMENTS[index].id);
            assert.equal(button.querySelector('.yl-seg__label').textContent, SEGMENTS[index].label);
            const active = index === 0;
            assert.equal(button.getAttribute('aria-checked'), active ? 'true' : 'false');
            assert.equal(button.getAttribute('tabindex'), active ? '0' : '-1');
            assert.equal(button.classList.contains('is-active'), active);
        }
    } finally { env.restore(); }
});

test('activeId 生效；未知 activeId 回退第一段；segments 非法 fail fast', () => {
    const env = installMiniDom();
    try {
        const control = createSegmentedControl({ documentRef: env.document, segments: SEGMENTS, activeId: 'group' });
        assert.equal(control.getActiveId(), 'group');
        const fallback = createSegmentedControl({ documentRef: env.document, segments: SEGMENTS, activeId: 'nope' });
        assert.equal(fallback.getActiveId(), 'square');

        assert.throws(() => createSegmentedControl({ documentRef: env.document, segments: [] }), /yl_seg_segments_required/u);
        assert.throws(() => createSegmentedControl({ documentRef: env.document, segments: [{ id: '', label: 'x' }] }), /yl_seg_segment_invalid/u);
        assert.throws(() => createSegmentedControl({
            documentRef: env.document,
            segments: [{ id: 'a', label: '甲' }, { id: 'a', label: '乙' }],
        }), /yl_seg_segment_duplicate/u);
    } finally { env.restore(); }
});

test('点击切换：触发 onChange 一次，重复点击当前段不触发', () => {
    const env = installMiniDom();
    try {
        const changes = [];
        const control = createSegmentedControl({ documentRef: env.document, segments: SEGMENTS, onChange: (id) => changes.push(id) });
        const buttons = items(control);
        buttons[1].dispatchEvent(new Event('click'));
        assert.deepEqual(changes, ['group']);
        assert.equal(control.getActiveId(), 'group');
        assert.ok(buttons[1].classList.contains('is-active'));
        assert.equal(buttons[0].classList.contains('is-active'), false);

        buttons[1].dispatchEvent(new Event('click'));
        assert.deepEqual(changes, ['group'], '重复选择不重复通知');
    } finally { env.restore(); }
});

test('键盘漫游：左右键即时选中并移动焦点，首尾环绕，Home/End 跳边界', () => {
    const env = installMiniDom();
    try {
        const doc = env.document;
        const changes = [];
        const control = createSegmentedControl({ documentRef: doc, segments: SEGMENTS, onChange: (id) => changes.push(id) });
        doc.body.appendChild(control.root);
        const buttons = items(control);

        const right = keyEvent('ArrowRight');
        buttons[0].dispatchEvent(right);
        assert.equal(control.getActiveId(), 'group');
        assert.equal(doc.activeElement, buttons[1], '漫游同时移动焦点');
        assert.equal(right.defaultPrevented, true);
        assert.equal(buttons[1].getAttribute('tabindex'), '0');
        assert.equal(buttons[0].getAttribute('tabindex'), '-1');

        buttons[1].dispatchEvent(keyEvent('ArrowRight'));
        assert.equal(control.getActiveId(), 'nearby');
        buttons[2].dispatchEvent(keyEvent('ArrowRight'));
        assert.equal(control.getActiveId(), 'square', '尾部右移环绕回第一段');
        buttons[0].dispatchEvent(keyEvent('ArrowLeft'));
        assert.equal(control.getActiveId(), 'nearby', '头部左移环绕到最后一段');

        buttons[2].dispatchEvent(keyEvent('Home'));
        assert.equal(control.getActiveId(), 'square');
        buttons[0].dispatchEvent(keyEvent('End'));
        assert.equal(control.getActiveId(), 'nearby');
        assert.deepEqual(changes, ['group', 'nearby', 'square', 'nearby', 'square', 'nearby']);

        const other = keyEvent('a');
        buttons[2].dispatchEvent(other);
        assert.equal(other.defaultPrevented, false, '无关按键不拦截');
        assert.equal(control.getActiveId(), 'nearby');
    } finally { env.restore(); }
});

test('setActive 程序式切换：更新视觉与 roving tabindex 但不触发 onChange；未知 id 返回 false', () => {
    const env = installMiniDom();
    try {
        const changes = [];
        const control = createSegmentedControl({ documentRef: env.document, segments: SEGMENTS, onChange: (id) => changes.push(id) });
        assert.equal(control.setActive('nearby'), true);
        assert.equal(control.getActiveId(), 'nearby');
        assert.ok(items(control)[2].classList.contains('is-active'));
        assert.deepEqual(changes, [], '程序式切换不通知');
        assert.equal(control.setActive('nope'), false);
        assert.equal(control.getActiveId(), 'nearby');
    } finally { env.restore(); }
});

test('onChange 抛异常不破坏控件后续切换', () => {
    const env = installMiniDom();
    try {
        const control = createSegmentedControl({
            documentRef: env.document,
            segments: SEGMENTS,
            onChange: () => { throw new Error('boom'); },
        });
        const buttons = items(control);
        assert.doesNotThrow(() => buttons[1].dispatchEvent(new Event('click')));
        assert.equal(control.getActiveId(), 'group');
        assert.doesNotThrow(() => buttons[2].dispatchEvent(new Event('click')));
        assert.equal(control.getActiveId(), 'nearby');
    } finally { env.restore(); }
});
