import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createMemoryStorage, createSettingsStore } from '../../settings/settings-store.js';
import { createEmptyNsfwConsent } from '../../mvu/nsfw-consent.js';

const miniDom = installMiniDom();
const { mountPhoneApp } = await import('../../app-shell.js');

test.after(() => miniDom.restore());

function readyReadResult() {
    const candidate = {
        成人验证: true,
        公开资料: {
            昵称: '公开候选人', 头像引用: '', 年龄段: '25-29', 性别: '女', 性取向: '双性恋',
            城市: '上海', 距离范围: '10 km', 寻找意图: '聊天后约会', 简介: '只展示公开资料。',
            兴趣标签: ['电影'], 生活方式标签: ['夜猫子'], 性格标签: ['直接'], 沟通风格标签: ['慢热'],
        },
        仅好友资料: {}, 隐藏资料: {}, 偏好与边界: '',
        拒绝阈值: 40, 已读不回阈值: 55, 取消匹配阈值: 70, 拉黑阈值: 90,
        与玩家关系: { 状态: '未匹配', 全局账号表现: 80, NPC专属匹配度: 85, 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 },
    };
    return {
        ok: true,
        state: {
            系统: { UID计数器: { 角色: 1 } }, 软件: { 内容模式: 'SFW' },
            玩家: { 公开资料: { ...candidate.公开资料, 昵称: '玩家' } },
            推荐: { 当前队列: ['npc_1'], 临时候选池: { npc_1: candidate }, 冷却角色UID: [], 收藏角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [] },
            角色池: { npc_1: candidate }, 会话: {}, 群组: {},
        },
    };
}

function privateChatReadResult() {
    const result = readyReadResult();
    result.state.角色池.npc_1.与玩家关系.状态 = '已匹配';
    result.state.会话.chat_1 = {
        对象UID: 'npc_1',
        状态: '已匹配',
        最近消息: [{ 消息UID: 'm1', 发送者: '角色', 内容: '晚上好。', 时间: '20:30' }],
        总结: { 记录: [] },
        NSFW同意: createEmptyNsfwConsent(),
    };
    return result;
}

function click(node) {
    assert.ok(node, '要点击的控件必须存在');
    node.dispatchEvent(new Event('click'));
}

function eventWithFields(type, fields = {}) {
    const event = new Event(type, { cancelable: true });
    for (const [key, value] of Object.entries(fields)) {
        Object.defineProperty(event, key, { configurable: true, value });
    }
    return event;
}

async function flushUi() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function installStyleRecorder(node) {
    const values = Object.create(null);
    node.style = new Proxy({
        setProperty(name, value) { values[name] = String(value); },
        removeProperty(name) { delete values[name]; },
        getPropertyValue(name) { return values[name] ?? ''; },
    }, {
        get(target, key) { return key in target ? target[key] : values[key] ?? ''; },
        set(target, key, value) { values[key] = String(value); return true; },
    });
    return values;
}

function installAffineDialogGeometry(dialog, styles, model) {
    let measurements = 0;
    dialog.getBoundingClientRect = () => {
        measurements += 1;
        const cssLeft = Number.parseFloat(styles.left) || 0;
        const cssTop = Number.parseFloat(styles.top) || 0;
        const maxWidth = Number.parseFloat(styles['max-width']);
        const maxHeight = Number.parseFloat(styles['max-height']);
        const cssWidth = Math.min(model.naturalWidth, Number.isFinite(maxWidth) ? maxWidth : model.naturalWidth);
        const cssHeight = Math.min(model.naturalHeight, Number.isFinite(maxHeight) ? maxHeight : model.naturalHeight);
        const width = cssWidth * model.scaleX;
        const height = cssHeight * model.scaleY;
        const centerX = model.offsetX + (cssLeft * model.scaleX);
        const centerY = model.offsetY + (cssTop * model.scaleY);
        return {
            left: centerX - (width / 2), top: centerY - (height / 2),
            width, height,
            right: centerX + (width / 2), bottom: centerY + (height / 2),
        };
    };
    return () => measurements;
}

function assertDialogInsideVisualViewport(dialog, viewport, label) {
    const rect = dialog.getBoundingClientRect();
    const centerX = (rect.left + rect.right) / 2;
    const centerY = (rect.top + rect.bottom) / 2;
    const targetX = viewport.offsetLeft + (viewport.width / 2);
    const targetY = viewport.offsetTop + (viewport.height / 2);
    assert.ok(Math.abs(centerX - targetX) <= 1, `${label} 横向中心误差应不超过 1px：${centerX} vs ${targetX}`);
    assert.ok(Math.abs(centerY - targetY) <= 1, `${label} 纵向中心误差应不超过 1px：${centerY} vs ${targetY}`);
    assert.ok(rect.left >= viewport.offsetLeft + 13.5, `${label} 左边不得飞出可视视口`);
    assert.ok(rect.top >= viewport.offsetTop + 13.5, `${label} 顶边不得飞出可视视口`);
    assert.ok(rect.right <= viewport.offsetLeft + viewport.width - 13.5, `${label} 右边不得飞出可视视口`);
    assert.ok(rect.bottom <= viewport.offsetTop + viewport.height - 13.5, `${label} 底边不得飞出可视视口`);
}

function installTransformedViewport() {
    const previousDefaultView = miniDom.document.defaultView;
    const windowRef = new EventTarget();
    const visualViewport = new EventTarget();
    Object.assign(windowRef, { innerWidth: 360, innerHeight: 640, visualViewport });
    Object.assign(visualViewport, { width: 360, height: 640, offsetLeft: 0, offsetTop: 0 });
    miniDom.document.defaultView = windowRef;
    return { previousDefaultView, windowRef, visualViewport };
}

test('Termux affine transformed host keeps the operation dialog inside resize and scroll viewports', async () => {
    const { previousDefaultView, windowRef, visualViewport } = installTransformedViewport();

    const mounted = mountPhoneApp({
        documentRef: miniDom.document,
        rootId: 'ylm-test-termux-dialog-centering',
        actionBridge: { emit() {}, isPending() { return false; }, async runMvuAction() { return { ok: true }; } },
        settingsStore: null,
        llmClient: null,
        characterLibrary: null,
        readState: readyReadResult,
    });
    try {
        const dialog = miniDom.document.querySelector('.yl-operation-dialog');
        const styles = installStyleRecorder(dialog);
        // 不只模拟平移：html/body transform、页面 zoom 与动画首帧会让 fixed
        // containing block 呈现每轴不同的 affine scale。
        const model = { naturalWidth: 320, naturalHeight: 500, scaleX: 1.35, scaleY: 0.82, offsetX: -74, offsetY: -90 };
        installAffineDialogGeometry(dialog, styles, model);

        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '收藏'));
        await flushUi();

        assert.equal(dialog.hidden, false);
        assertDialogInsideVisualViewport(dialog, visualViewport, '竖屏 operation dialog');

        Object.assign(model, { scaleX: 0.68, scaleY: 1.28, offsetX: 88, offsetY: -140 });
        Object.assign(visualViewport, { width: 640, height: 360, offsetLeft: 9, offsetTop: 17 });
        visualViewport.dispatchEvent(new Event('resize'));
        assertDialogInsideVisualViewport(dialog, visualViewport, '旋转后 operation dialog');

        Object.assign(model, { offsetX: 42, offsetY: -205 });
        Object.assign(visualViewport, { offsetLeft: 25, offsetTop: 40 });
        windowRef.dispatchEvent(new Event('scroll'));
        assertDialogInsideVisualViewport(dialog, visualViewport, '普通文档滚动后 operation dialog');
    } finally {
        mounted.destroy();
        miniDom.document.defaultView = previousDefaultView;
    }
});

test('the matching settings modal uses the same affine visual-viewport correction', () => {
    const { previousDefaultView, visualViewport } = installTransformedViewport();
    const settingsStore = createSettingsStore({ storage: createMemoryStorage() });
    const mounted = mountPhoneApp({
        documentRef: miniDom.document,
        rootId: 'ylm-test-termux-settings-centering',
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore,
        llmClient: null,
        characterLibrary: null,
        readState: readyReadResult,
    });
    try {
        const dialog = miniDom.document.querySelector('.yl-feature-binding-modal');
        const styles = installStyleRecorder(dialog);
        installAffineDialogGeometry(dialog, styles, {
            naturalWidth: 360, naturalHeight: 580,
            scaleX: 0.62, scaleY: 0.74, offsetX: 126, offsetY: -155,
        });

        click(miniDom.document.querySelector('.yl-phone-launcher'));
        click(miniDom.document.querySelectorAll('.yl-phone-nav-item').find((node) => node.dataset.page === 'matches'));
        click(miniDom.document.querySelector('.yl-feature-options'));

        assert.equal(dialog.hidden, false);
        assertDialogInsideVisualViewport(dialog, visualViewport, '匹配设置 modal');
    } finally {
        mounted.destroy();
        miniDom.document.defaultView = previousDefaultView;
    }
});

test('operation dialog refits after loading content grows into a taller success result', async () => {
    const { previousDefaultView, visualViewport } = installTransformedViewport();
    const refreshRequest = deferred();
    const mounted = mountPhoneApp({
        documentRef: miniDom.document,
        rootId: 'ylm-test-termux-dialog-dynamic-height',
        actionBridge: {
            emit() {}, isPending() { return false; },
            runRecommendationRefresh() { return refreshRequest.promise; },
        },
        settingsStore: null,
        llmClient: null,
        characterLibrary: null,
        readState: readyReadResult,
    });
    try {
        const dialog = miniDom.document.querySelector('.yl-operation-dialog');
        const styles = installStyleRecorder(dialog);
        const model = {
            naturalWidth: 320,
            get naturalHeight() { return dialog.dataset.state === 'loading' ? 180 : 720; },
            scaleX: 1,
            scaleY: 1.2,
            offsetX: 0,
            offsetY: -96,
        };
        const measurementCount = installAffineDialogGeometry(dialog, styles, model);

        click(miniDom.document.querySelector('.yl-phone-launcher'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '刷新候选人，显示下一位'));
        await flushUi();

        assert.equal(dialog.dataset.state, 'loading');
        assert.equal(styles['max-height'], '612px', '短 loading 内容无需收紧高度');
        const loadingMeasurements = measurementCount();
        assertDialogInsideVisualViewport(dialog, visualViewport, 'loading operation dialog');

        refreshRequest.resolve({ ok: true });
        await flushUi();

        assert.equal(dialog.dataset.state, 'success');
        assert.ok(measurementCount() > loadingMeasurements, '状态内容变高后必须重新测量');
        assert.ok(Number.parseFloat(styles['max-height']) <= 510.1, '宿主 1.2x 缩放下应收紧 CSS max-height');
        assertDialogInsideVisualViewport(dialog, visualViewport, 'success operation dialog');
    } finally {
        mounted.destroy();
        miniDom.document.defaultView = previousDefaultView;
    }
});

test('launcher recovery toolbar converges beside the launcher under affine host scaling', () => {
    const { previousDefaultView, visualViewport } = installTransformedViewport();
    const mounted = mountPhoneApp({
        documentRef: miniDom.document,
        rootId: 'ylm-test-termux-launcher-tools',
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null,
        llmClient: null,
        characterLibrary: null,
        readState: readyReadResult,
    });
    try {
        const launcher = miniDom.document.querySelector('.yl-phone-launcher');
        const tools = miniDom.document.querySelector('.yl-launcher-tools');
        const styles = installStyleRecorder(tools);
        const launcherRect = { left: 292, top: 500, width: 56, height: 56, right: 348, bottom: 556 };
        launcher.getBoundingClientRect = () => launcherRect;
        const model = { scaleX: 1.4, scaleY: 0.75, offsetX: -120, offsetY: 84 };
        tools.getBoundingClientRect = () => {
            const cssLeft = Number.parseFloat(styles.left) || 0;
            const cssTop = Number.parseFloat(styles.top) || 0;
            const width = 104 * model.scaleX;
            const height = 88 * model.scaleY;
            const left = model.offsetX + (cssLeft * model.scaleX);
            const top = model.offsetY + (cssTop * model.scaleY);
            return { left, top, width, height, right: left + width, bottom: top + height };
        };

        launcher.dispatchEvent(eventWithFields('contextmenu', { pointerType: 'mouse', button: 2 }));

        assert.equal(tools.hidden, false);
        let rect = tools.getBoundingClientRect();
        assert.ok(rect.left >= visualViewport.offsetLeft - 0.5);
        assert.ok(rect.top >= visualViewport.offsetTop - 0.5);
        assert.ok(rect.right <= visualViewport.offsetLeft + visualViewport.width + 0.5);
        assert.ok(rect.bottom <= visualViewport.offsetTop + visualViewport.height + 0.5);
        assert.ok(Math.abs((rect.right + 8) - launcherRect.left) <= 1, '工具栏应在悬浮球左侧保留 8px 间距');

        Object.assign(model, { scaleX: 0.7, scaleY: 1.25, offsetX: 66, offsetY: -130 });
        Object.assign(visualViewport, { offsetLeft: 12, offsetTop: 24, width: 340, height: 560 });
        visualViewport.dispatchEvent(new Event('resize'));
        rect = tools.getBoundingClientRect();
        assert.ok(rect.left >= visualViewport.offsetLeft - 0.5);
        assert.ok(rect.top >= visualViewport.offsetTop - 0.5);
        assert.ok(rect.right <= visualViewport.offsetLeft + visualViewport.width + 0.5);
        assert.ok(rect.bottom <= visualViewport.offsetTop + visualViewport.height + 0.5);
    } finally {
        mounted.destroy();
        miniDom.document.defaultView = previousDefaultView;
    }
});

test('chat BottomSheet covers the visual viewport while its panel keeps the shared focus stack', async () => {
    const { previousDefaultView, windowRef, visualViewport } = installTransformedViewport();
    const readResult = privateChatReadResult();
    const mounted = mountPhoneApp({
        documentRef: miniDom.document,
        rootId: 'ylm-test-termux-bottom-sheet',
        actionBridge: { emit() {}, isPending() { return false; }, async runPrivateChat() { return { ok: true }; } },
        settingsStore: null,
        llmClient: null,
        characterLibrary: null,
        readState: () => readResult,
    });
    try {
        click(miniDom.document.querySelector('.yl-phone-launcher'));
        click(miniDom.document.querySelectorAll('.yl-phone-nav-item').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与公开候选人的私聊'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开聊天工具'));
        await flushUi();

        const sheet = miniDom.document.querySelector('.yl-sheet');
        const sheetPanel = sheet?.querySelector('.yl-sheet__panel');
        assert.ok(sheet && sheetPanel, '聊天工具应使用 BottomSheet');
        assert.equal(miniDom.document.activeElement, sheet.querySelector('.yl-sheet__close'), '接入共享 dialog 栈后应聚焦关闭按钮');

        const styles = installStyleRecorder(sheet);
        const model = { scaleX: 1.3, scaleY: 0.72, offsetX: -84, offsetY: 118 };
        sheet.getBoundingClientRect = () => {
            const cssLeft = Number.parseFloat(styles.left) || 0;
            const cssTop = Number.parseFloat(styles.top) || 0;
            const cssWidth = Number.parseFloat(styles.width) || 1;
            const cssHeight = Number.parseFloat(styles.height) || 1;
            const left = model.offsetX + (cssLeft * model.scaleX);
            const top = model.offsetY + (cssTop * model.scaleY);
            const width = cssWidth * model.scaleX;
            const height = cssHeight * model.scaleY;
            return { left, top, width, height, right: left + width, bottom: top + height };
        };

        visualViewport.dispatchEvent(new Event('resize'));
        let rect = sheet.getBoundingClientRect();
        assert.ok(Math.abs(rect.left - visualViewport.offsetLeft) <= 1);
        assert.ok(Math.abs(rect.top - visualViewport.offsetTop) <= 1);
        assert.ok(Math.abs(rect.right - (visualViewport.offsetLeft + visualViewport.width)) <= 1);
        assert.ok(Math.abs(rect.bottom - (visualViewport.offsetTop + visualViewport.height)) <= 1);

        Object.assign(model, { scaleX: 0.66, scaleY: 1.24, offsetX: 72, offsetY: -190 });
        Object.assign(visualViewport, { offsetLeft: 14, offsetTop: 32, width: 620, height: 350 });
        windowRef.dispatchEvent(new Event('scroll'));
        rect = sheet.getBoundingClientRect();
        assert.ok(Math.abs(rect.left - visualViewport.offsetLeft) <= 1);
        assert.ok(Math.abs(rect.top - visualViewport.offsetTop) <= 1);
        assert.ok(Math.abs(rect.right - (visualViewport.offsetLeft + visualViewport.width)) <= 1);
        assert.ok(Math.abs(rect.bottom - (visualViewport.offsetTop + visualViewport.height)) <= 1);

        miniDom.document.dispatchEvent(eventWithFields('keydown', { key: 'Escape' }));
        await flushUi();
        assert.equal(miniDom.document.querySelector('.yl-sheet'), null, 'Escape 应关闭当前 sheet 并清理旧页 dialog 栈');
        miniDom.document.dispatchEvent(eventWithFields('keydown', { key: 'Escape' }));
        assert.equal(miniDom.document.querySelector('.yl-phone-panel').hidden, true, '第二次 Escape 应直接关闭手机，不得再命中 detached sheet');
    } finally {
        mounted.destroy();
        miniDom.document.defaultView = previousDefaultView;
    }
});
