import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createBottomSheet } from '../bottom-sheet.js';
import { createDialogController } from '../dialog-controller.js';

function keyEvent(key) {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperty(event, 'key', { configurable: true, value: key });
    Object.defineProperty(event, 'shiftKey', { configurable: true, value: false });
    return event;
}

test('结构合同：遮罩 + 面板(role=dialog) + titlebar(标题+关闭钮) + 内容区', () => {
    const env = installMiniDom();
    try {
        const doc = env.document;
        const content = doc.createElement('div');
        content.className = 'demo-content';
        const sheet = createBottomSheet({ documentRef: doc, title: '聊天工具', content });

        assert.ok(sheet.root.classList.contains('yl-sheet'));
        assert.equal(sheet.root.hidden, true, '初始隐藏');
        assert.equal(sheet.root.childNodes.length, 2);
        assert.ok(sheet.root.childNodes[0].classList.contains('yl-sheet__scrim'));

        const panel = sheet.root.childNodes[1];
        assert.ok(panel.classList.contains('yl-sheet__panel'));
        assert.equal(panel.tagName, 'SECTION');
        assert.equal(panel.getAttribute('role'), 'dialog');
        assert.equal(panel.getAttribute('aria-modal'), 'true');
        assert.equal(panel.getAttribute('aria-label'), '聊天工具');

        const titlebar = panel.querySelector('.yl-sheet__titlebar');
        assert.equal(titlebar.tagName, 'HEADER');
        assert.equal(titlebar.querySelector('.yl-sheet__title').textContent, '聊天工具');
        const closeButton = titlebar.querySelector('.yl-sheet__close');
        assert.equal(closeButton.tagName, 'BUTTON');
        assert.ok(closeButton.classList.contains('yl-btn--icon'), '关闭钮复用 icon 按钮（44px 热区语义）');
        assert.equal(closeButton.getAttribute('aria-label'), '关闭');

        const body = panel.querySelector('.yl-sheet__body');
        assert.equal(body.childNodes[0], content, '内容节点原样进入内容区');

        assert.throws(() => createBottomSheet({ documentRef: doc, title: ' ' }), /yl_sheet_title_required/u);
    } finally { env.restore(); }
});

test('无控制器降级路径：open/close 只翻 hidden 与 is-open；关闭钮与遮罩点击可关', () => {
    const env = installMiniDom();
    try {
        const doc = env.document;
        const sheet = createBottomSheet({ documentRef: doc, title: '发帖' });
        doc.body.appendChild(sheet.root);

        assert.equal(sheet.isOpen(), false);
        sheet.open();
        assert.equal(sheet.isOpen(), true);
        assert.equal(sheet.root.hidden, false);
        assert.ok(sheet.root.classList.contains('is-open'));

        sheet.open();
        assert.equal(sheet.isOpen(), true, '重复 open 幂等');

        const closeButton = sheet.root.querySelector('.yl-sheet__close');
        closeButton.dispatchEvent(new Event('click'));
        assert.equal(sheet.isOpen(), false);
        assert.equal(sheet.root.hidden, true);
        assert.equal(sheet.root.classList.contains('is-open'), false);

        sheet.open();
        sheet.root.querySelector('.yl-sheet__scrim').dispatchEvent(new Event('click'));
        assert.equal(sheet.isOpen(), false, '遮罩点击关闭');

        sheet.close();
        assert.equal(sheet.isOpen(), false, '重复 close 幂等');
    } finally { env.restore(); }
});

test('无控制器 + onRequestClose：关闭请求只通知调用方，由调用方决定真正 close', () => {
    const env = installMiniDom();
    try {
        const doc = env.document;
        let requests = 0;
        const sheet = createBottomSheet({ documentRef: doc, title: '面基约定', onRequestClose: () => { requests += 1; } });
        doc.body.appendChild(sheet.root);
        sheet.open();

        sheet.root.querySelector('.yl-sheet__close').dispatchEvent(new Event('click'));
        assert.equal(requests, 1);
        assert.equal(sheet.isOpen(), true, '提供 onRequestClose 时不自动关闭');

        sheet.root.querySelector('.yl-sheet__scrim').dispatchEvent(new Event('click'));
        assert.equal(requests, 2);

        sheet.close();
        assert.equal(sheet.isOpen(), false);
        sheet.root.querySelector('.yl-sheet__scrim').dispatchEvent(new Event('click'));
        assert.equal(requests, 2, '已关闭后遮罩点击不再发关闭请求');
    } finally { env.restore(); }
});

test('控制器路径：open 压栈聚焦关闭钮，Escape 走控制器关栈顶并回焦 opener', () => {
    const env = installMiniDom();
    try {
        const doc = env.document;
        const controller = createDialogController({ documentRef: doc });
        const opener = doc.createElement('button');
        opener.textContent = '打开工具';
        doc.body.appendChild(opener);
        opener.focus();

        const sheet = createBottomSheet({ documentRef: doc, title: '聊天工具', dialogController: controller });
        doc.body.appendChild(sheet.root);
        const panel = sheet.root.childNodes[1];

        sheet.open({ opener });
        assert.equal(sheet.root.hidden, false);
        assert.equal(panel.hidden, false);
        assert.equal(controller.hasOpenDialog(), true);
        assert.equal(controller.isTopDialog(panel), true);
        assert.equal(doc.activeElement, sheet.root.querySelector('.yl-sheet__close'), '控制器聚焦面板首个可聚焦元素（关闭钮）');

        const handled = controller.handleKeydown(keyEvent('Escape'));
        assert.equal(handled, true);
        assert.equal(sheet.isOpen(), false, 'Escape 经 onRequestClose 路由到 close()');
        assert.equal(sheet.root.hidden, true);
        assert.equal(controller.hasOpenDialog(), false, '面板已出栈');
        assert.equal(doc.activeElement, opener, '关闭回焦 opener');
    } finally { env.restore(); }
});

test('控制器路径 + onRequestClose：Escape/关闭钮只通知调用方；close({restoreFocus:false}) 不回焦', () => {
    const env = installMiniDom();
    try {
        const doc = env.document;
        const controller = createDialogController({ documentRef: doc });
        const opener = doc.createElement('button');
        doc.body.appendChild(opener);
        opener.focus();

        let requests = 0;
        const sheet = createBottomSheet({
            documentRef: doc,
            title: '生图设置',
            dialogController: controller,
            onRequestClose: () => { requests += 1; },
        });
        doc.body.appendChild(sheet.root);
        const panel = sheet.root.childNodes[1];

        sheet.open({ opener });
        controller.handleKeydown(keyEvent('Escape'));
        assert.equal(requests, 1);
        assert.equal(sheet.isOpen(), true, 'Escape 只发请求不硬关');
        assert.equal(controller.hasOpenDialog(), true);

        sheet.root.querySelector('.yl-sheet__close').dispatchEvent(new Event('click'));
        assert.equal(requests, 2);

        sheet.close({ restoreFocus: false });
        assert.equal(sheet.isOpen(), false);
        assert.equal(controller.hasOpenDialog(), false);
        assert.notEqual(doc.activeElement, opener, 'restoreFocus:false 不回焦 opener');

        sheet.open({ opener });
        assert.equal(controller.isTopDialog(panel), true, '关闭后可再次打开并重新入栈');
        sheet.close();
        assert.equal(doc.activeElement, opener, '默认关闭回焦 opener');
    } finally { env.restore(); }
});

test('控制器路径 Tab 焦点环：焦点在面板可聚焦元素间循环', () => {
    const env = installMiniDom();
    try {
        const doc = env.document;
        const controller = createDialogController({ documentRef: doc });
        const content = doc.createElement('div');
        const confirm = doc.createElement('button');
        confirm.textContent = '确认';
        content.appendChild(confirm);
        const sheet = createBottomSheet({ documentRef: doc, title: '确认操作', content, dialogController: controller });
        doc.body.appendChild(sheet.root);

        sheet.open();
        const closeButton = sheet.root.querySelector('.yl-sheet__close');
        assert.equal(doc.activeElement, closeButton);
        controller.handleKeydown(keyEvent('Tab'));
        assert.equal(doc.activeElement, confirm);
        controller.handleKeydown(keyEvent('Tab'));
        assert.equal(doc.activeElement, closeButton, 'Tab 焦点环回绕');
    } finally { env.restore(); }
});
