import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createListRow } from '../list-row.js';

function keyEvent(key) {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperty(event, 'key', { configurable: true, value: key });
    return event;
}

test('完整列表行：头像槽 + 双行文案 + meta（时间/chips/徽章/箭头）', () => {
    const env = installMiniDom();
    try {
        const doc = env.document;
        const avatar = doc.createElement('img');
        const chipNode = doc.createElement('span');
        chipNode.className = 'yl-chip yl-chip--status yl-chip--danger';
        const row = createListRow({
            documentRef: doc,
            avatar,
            title: '林澈',
            subtitle: '刚看完一部电影，想找人聊聊',
            meta: { time: '21:30', badge: 3, chevron: true, chips: ['同城', chipNode] },
        });

        assert.equal(row.tagName, 'DIV');
        assert.ok(row.classList.contains('yl-row'));
        assert.equal(row.getAttribute('role'), 'button');
        assert.equal(row.getAttribute('tabindex'), '0');
        assert.ok(row.classList.contains('is-unread'), '有未读时根节点标 is-unread');

        const avatarBox = row.querySelector('.yl-row__avatar');
        assert.ok(avatarBox);
        assert.equal(avatarBox.childNodes[0], avatar, '头像节点原样进入头像槽');

        const main = row.querySelector('.yl-row__main');
        assert.equal(main.querySelector('.yl-row__title').textContent, '林澈');
        assert.equal(main.querySelector('.yl-row__subtitle').textContent, '刚看完一部电影，想找人聊聊');

        const meta = row.querySelector('.yl-row__meta');
        assert.equal(meta.querySelector('.yl-row__time').textContent, '21:30');
        const chips = meta.querySelector('.yl-row__chips');
        assert.equal(chips.childNodes.length, 2);
        assert.ok(chips.childNodes[0].classList.contains('yl-chip--tag'), '字符串 chip 自动包成标签 chip');
        assert.equal(chips.childNodes[0].textContent, '同城');
        assert.equal(chips.childNodes[1], chipNode, '节点 chip 原样透传');
        const badge = meta.querySelector('.yl-badge--unread');
        assert.equal(badge.textContent, '3');
        const chevron = meta.querySelector('.yl-row__chevron');
        assert.equal(chevron.dataset.icon, 'chevron_right');
        assert.equal(chevron.getAttribute('aria-hidden'), 'true');
    } finally { env.restore(); }
});

test('极简行：无头像/副标题/meta 时不渲染空容器；无未读不标 is-unread', () => {
    const env = installMiniDom();
    try {
        const row = createListRow({ documentRef: env.document, title: '连接预设' });
        assert.equal(row.querySelector('.yl-row__avatar'), null);
        assert.equal(row.querySelector('.yl-row__subtitle'), null);
        assert.equal(row.querySelector('.yl-row__meta'), null);
        assert.equal(row.classList.contains('is-unread'), false);
        assert.equal(row.querySelector('.yl-row__title').textContent, '连接预设');
    } finally { env.restore(); }
});

test('badge=0 不渲染徽章但不影响其余 meta；title 缺失 fail fast', () => {
    const env = installMiniDom();
    try {
        const row = createListRow({ documentRef: env.document, title: '设置', meta: { badge: 0, chevron: true } });
        assert.equal(row.querySelector('.yl-badge--unread'), null);
        assert.ok(row.querySelector('.yl-row__chevron'));
        assert.equal(row.classList.contains('is-unread'), false);
        assert.throws(() => createListRow({ documentRef: env.document, title: '  ' }), /yl_list_row_title_required/u);
    } finally { env.restore(); }
});

test('键盘行为：Enter 与空格都激活 onClick 并 preventDefault，其他键不激活', () => {
    const env = installMiniDom();
    try {
        let activations = 0;
        const row = createListRow({ documentRef: env.document, title: '林澈', onClick: () => { activations += 1; } });

        const enter = keyEvent('Enter');
        row.dispatchEvent(enter);
        assert.equal(activations, 1);
        assert.equal(enter.defaultPrevented, true);

        row.dispatchEvent(keyEvent(' '));
        assert.equal(activations, 2);

        row.dispatchEvent(keyEvent('Escape'));
        assert.equal(activations, 2, '非激活键不触发 onClick');

        row.dispatchEvent(new Event('click'));
        assert.equal(activations, 3, '点击同样激活');
    } finally { env.restore(); }
});

test('右键：contextmenu 被 preventDefault 并回调 onContextMenu；未提供时不注册', () => {
    const env = installMiniDom();
    try {
        let contextCalls = 0;
        const row = createListRow({
            documentRef: env.document,
            title: '林澈',
            onContextMenu: () => { contextCalls += 1; },
        });
        const event = new Event('contextmenu', { cancelable: true });
        row.dispatchEvent(event);
        assert.equal(contextCalls, 1);
        assert.equal(event.defaultPrevented, true);

        const plain = createListRow({ documentRef: env.document, title: '设置' });
        const plainEvent = new Event('contextmenu', { cancelable: true });
        plain.dispatchEvent(plainEvent);
        assert.equal(plainEvent.defaultPrevented, false, '未提供 onContextMenu 时不拦截右键');
    } finally { env.restore(); }
});

test('onClick 抛异常不破坏列表行', () => {
    const env = installMiniDom();
    try {
        const row = createListRow({ documentRef: env.document, title: '林澈', onClick: () => { throw new Error('boom'); } });
        assert.doesNotThrow(() => row.dispatchEvent(new Event('click')));
        assert.doesNotThrow(() => row.dispatchEvent(keyEvent('Enter')));
    } finally { env.restore(); }
});
