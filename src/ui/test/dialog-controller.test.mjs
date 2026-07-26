import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createDialogController } from '../dialog-controller.js';

function keyEvent(key, { shiftKey = false } = {}) {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperty(event, 'key', { configurable: true, value: key });
    Object.defineProperty(event, 'shiftKey', { configurable: true, value: shiftKey });
    return event;
}

function makeButton(document, label) {
    const button = document.createElement('button');
    button.textContent = label;
    return button;
}

/** 构造挂到 body 的弹窗容器，并按需塞入子节点。 */
function makeDialog(document, children = []) {
    const dialog = document.createElement('div');
    dialog.hidden = true;
    for (const child of children) dialog.appendChild(child);
    document.body.appendChild(dialog);
    return dialog;
}

test('open reveals dialog, sets aria-modal, and focuses the first focusable element', () => {
    const env = installMiniDom();
    try {
        const document = env.document;
        const controller = createDialogController({ documentRef: document });
        const wrapper = document.createElement('div');
        wrapper.appendChild(document.createTextNode('提示文本'));
        const first = makeButton(document, '确定');
        const second = makeButton(document, '取消');
        wrapper.appendChild(first);
        const dialog = makeDialog(document, [wrapper, second]);

        controller.open(dialog);

        assert.equal(dialog.hidden, false);
        assert.equal(dialog.getAttribute('aria-modal'), 'true');
        assert.equal(document.activeElement, first, '应聚焦嵌套子树中的第一个可聚焦元素');
        assert.equal(controller.hasOpenDialog(), true);
        assert.equal(controller.isTopDialog(dialog), true);
    } finally {
        env.restore();
    }
});

test('open prefers initialFocus over the first focusable element', () => {
    const env = installMiniDom();
    try {
        const document = env.document;
        const controller = createDialogController({ documentRef: document });
        const first = makeButton(document, '第一个');
        const preferred = makeButton(document, '优先聚焦');
        const dialog = makeDialog(document, [first, preferred]);

        controller.open(dialog, { initialFocus: preferred });

        assert.equal(document.activeElement, preferred);
    } finally {
        env.restore();
    }
});

test('open focuses the dialog itself with tabindex=-1 when nothing inside is focusable', () => {
    const env = installMiniDom();
    try {
        const document = env.document;
        const controller = createDialogController({ documentRef: document });
        const plain = document.createElement('p');
        plain.textContent = '纯文本内容';
        const disabledButton = makeButton(document, '禁用');
        disabledButton.disabled = true;
        const dialog = makeDialog(document, [plain, disabledButton]);

        controller.open(dialog);

        assert.equal(dialog.getAttribute('tabindex'), '-1');
        assert.equal(document.activeElement, dialog);
    } finally {
        env.restore();
    }
});

test('Escape invokes onRequestClose for the top dialog only, without auto-closing it', () => {
    const env = installMiniDom();
    try {
        const document = env.document;
        const controller = createDialogController({ documentRef: document });
        const lowerCalls = [];
        const topCalls = [];
        const lower = makeDialog(document, [makeButton(document, '下层')]);
        const top = makeDialog(document, [makeButton(document, '上层')]);
        controller.open(lower, { onRequestClose: () => lowerCalls.push('lower') });
        controller.open(top, { onRequestClose: () => topCalls.push('top') });

        const handled = controller.handleKeydown(keyEvent('Escape'));

        assert.equal(handled, true);
        assert.deepEqual(topCalls, ['top'], '只应回调栈顶弹窗');
        assert.deepEqual(lowerCalls, [], '下层弹窗不得被触发');
        assert.equal(controller.isTopDialog(top), true, '关闭动作交由 onRequestClose 决定，控制器不代关');
    } finally {
        env.restore();
    }
});

test('Escape without onRequestClose closes the top dialog directly', () => {
    const env = installMiniDom();
    try {
        const document = env.document;
        const controller = createDialogController({ documentRef: document });
        const dialog = makeDialog(document, [makeButton(document, '关闭我')]);
        controller.open(dialog);

        const handled = controller.handleKeydown(keyEvent('Escape'));

        assert.equal(handled, true);
        assert.equal(dialog.hidden, true);
        assert.equal(controller.hasOpenDialog(), false);
    } finally {
        env.restore();
    }
});

test('Tab and Shift+Tab wrap the focus ring, skip disabled buttons, and call preventDefault', () => {
    const env = installMiniDom();
    try {
        const document = env.document;
        const controller = createDialogController({ documentRef: document });
        const first = makeButton(document, '甲');
        const disabled = makeButton(document, '禁用');
        disabled.disabled = true;
        const last = makeButton(document, '乙');
        const dialog = makeDialog(document, [first, disabled, last]);
        controller.open(dialog);
        assert.equal(document.activeElement, first);

        const forward = keyEvent('Tab');
        assert.equal(controller.handleKeydown(forward), true);
        assert.equal(forward.defaultPrevented, true, 'Tab 必须 preventDefault');
        assert.equal(document.activeElement, last, '禁用按钮应被跳过');

        assert.equal(controller.handleKeydown(keyEvent('Tab')), true);
        assert.equal(document.activeElement, first, '末尾 Tab 应循环回第一个');

        assert.equal(controller.handleKeydown(keyEvent('Tab', { shiftKey: true })), true);
        assert.equal(document.activeElement, last, '开头 Shift+Tab 应循环到最后一个');

        assert.equal(controller.handleKeydown(keyEvent('Tab', { shiftKey: true })), true);
        assert.equal(document.activeElement, first, '中间位置 Shift+Tab 应移动到前一个');
    } finally {
        env.restore();
    }
});

test('Tab pulls focus back to the first focusable element when focus escaped the dialog', () => {
    const env = installMiniDom();
    try {
        const document = env.document;
        const controller = createDialogController({ documentRef: document });
        const outside = makeButton(document, '外部');
        document.body.appendChild(outside);
        const first = makeButton(document, '回到我');
        const dialog = makeDialog(document, [first, makeButton(document, '次要')]);
        controller.open(dialog);

        outside.focus();
        assert.equal(controller.handleKeydown(keyEvent('Tab')), true);
        assert.equal(document.activeElement, first);
    } finally {
        env.restore();
    }
});

test('close restores focus to the opener captured from activeElement', () => {
    const env = installMiniDom();
    try {
        const document = env.document;
        const controller = createDialogController({ documentRef: document });
        const opener = makeButton(document, '打开弹窗');
        document.body.appendChild(opener);
        opener.focus();
        const dialog = makeDialog(document, [makeButton(document, '内部')]);

        controller.open(dialog);
        assert.notEqual(document.activeElement, opener);
        controller.close(dialog);

        assert.equal(dialog.hidden, true);
        assert.equal(document.activeElement, opener);
        assert.equal(controller.hasOpenDialog(), false);
    } finally {
        env.restore();
    }
});

test('close does not steal focus when the user already moved it outside the dialog', () => {
    const env = installMiniDom();
    try {
        const document = env.document;
        const controller = createDialogController({ documentRef: document });
        const opener = makeButton(document, '打开');
        const elsewhere = makeButton(document, '别处');
        document.body.appendChild(opener);
        document.body.appendChild(elsewhere);
        opener.focus();
        const dialog = makeDialog(document, [makeButton(document, '内部')]);
        controller.open(dialog);

        elsewhere.focus();
        controller.close(dialog);

        assert.equal(document.activeElement, elsewhere, '焦点已被用户移走时不得抢回 opener');
    } finally {
        env.restore();
    }
});

test('close stays silent when the opener was removed from the document', () => {
    const env = installMiniDom();
    try {
        const document = env.document;
        const controller = createDialogController({ documentRef: document });
        const opener = makeButton(document, '易碎按钮');
        document.body.appendChild(opener);
        opener.focus();
        const inner = makeButton(document, '内部');
        const dialog = makeDialog(document, [inner]);
        controller.open(dialog);

        opener.remove();
        assert.doesNotThrow(() => controller.close(dialog));
        assert.equal(dialog.hidden, true);
        assert.notEqual(document.activeElement, opener, '已脱离文档的 opener 不应重新获得焦点');
    } finally {
        env.restore();
    }
});

test('stacked dialogs: Escape closes the top layer first and focus walks back through openers', () => {
    const env = installMiniDom();
    try {
        const document = env.document;
        const controller = createDialogController({ documentRef: document });
        const rootOpener = makeButton(document, '根按钮');
        document.body.appendChild(rootOpener);
        rootOpener.focus();

        const innerOpener = makeButton(document, '打开第二层');
        const lower = makeDialog(document, [innerOpener]);
        controller.open(lower);
        assert.equal(document.activeElement, innerOpener);

        const upper = makeDialog(document, [makeButton(document, '顶层按钮')]);
        controller.open(upper);
        assert.equal(controller.isTopDialog(upper), true);
        assert.equal(controller.isTopDialog(lower), false);

        assert.equal(controller.handleKeydown(keyEvent('Escape')), true);
        assert.equal(upper.hidden, true, '应先关闭顶层');
        assert.equal(lower.hidden, false, '下层弹窗保持打开');
        assert.equal(document.activeElement, innerOpener, '焦点应回到下层中打开顶层的按钮');
        assert.equal(controller.isTopDialog(lower), true);

        assert.equal(controller.handleKeydown(keyEvent('Escape')), true);
        assert.equal(lower.hidden, true);
        assert.equal(document.activeElement, rootOpener, '最终焦点应回到最初的 opener');
        assert.equal(controller.hasOpenDialog(), false);
    } finally {
        env.restore();
    }
});

test('empty stack ignores keys, other keys pass through, and closing an unknown dialog is a safe no-op', () => {
    const env = installMiniDom();
    try {
        const document = env.document;
        const controller = createDialogController({ documentRef: document });
        assert.equal(controller.handleKeydown(keyEvent('Escape')), false);
        assert.equal(controller.handleKeydown(keyEvent('Tab')), false);

        const stray = makeDialog(document, [makeButton(document, '未打开')]);
        stray.hidden = false;
        assert.doesNotThrow(() => controller.close(stray));
        assert.equal(stray.hidden, true, '未入栈的弹窗 close 后仍应确保隐藏');

        const dialog = makeDialog(document, [makeButton(document, '按钮')]);
        controller.open(dialog);
        assert.equal(controller.handleKeydown(keyEvent('Enter')), false, '其他按键应返回 false');
        assert.equal(controller.isTopDialog(dialog), true);
    } finally {
        env.restore();
    }
});

test('re-opening the same dialog moves it to the top without duplicating stack entries', () => {
    const env = installMiniDom();
    try {
        const document = env.document;
        const controller = createDialogController({ documentRef: document });
        const dialogA = makeDialog(document, [makeButton(document, 'A')]);
        const dialogB = makeDialog(document, [makeButton(document, 'B')]);

        controller.open(dialogA);
        controller.open(dialogB);
        controller.open(dialogA);
        assert.equal(controller.isTopDialog(dialogA), true, '重复 open 应把弹窗移到栈顶');

        controller.close(dialogA);
        assert.equal(controller.isTopDialog(dialogB), true);
        controller.close(dialogB);
        assert.equal(controller.hasOpenDialog(), false, '各弹窗只应有一条栈记录');
        assert.equal(controller.handleKeydown(keyEvent('Escape')), false);
    } finally {
        env.restore();
    }
});

test('dispose clears the stack without touching dialog DOM state', () => {
    const env = installMiniDom();
    try {
        const document = env.document;
        const controller = createDialogController({ documentRef: document });
        const dialog = makeDialog(document, [makeButton(document, '按钮')]);
        controller.open(dialog);

        controller.dispose();

        assert.equal(controller.hasOpenDialog(), false);
        assert.equal(dialog.hidden, false, 'dispose 不还原 DOM');
        assert.equal(dialog.getAttribute('aria-modal'), 'true');
        assert.equal(controller.handleKeydown(keyEvent('Escape')), false);
    } finally {
        env.restore();
    }
});
