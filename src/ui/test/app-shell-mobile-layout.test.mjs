import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createMemoryStorage } from '../../settings/settings-store.js';

const miniDom = installMiniDom();
const { mountPhoneApp } = await import('../../app-shell.js');

test.after(() => miniDom.restore());

function emptyReadResult() {
    return {
        ok: true,
        state: {
            系统: { UID计数器: { 角色: 0 } }, 软件: { 内容模式: 'SFW' },
            推荐: { 当前队列: [], 临时候选池: {}, 冷却角色UID: [], 收藏角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [] },
            角色池: {}, 会话: {}, 群组: {},
        },
    };
}

function click(node) {
    assert.ok(node, '要点击的控件必须存在');
    node.dispatchEvent(new Event('click'));
}

function openLauncherButton() {
    return miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机');
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

/** 可分发事件的 window 桩：visualViewport 与 window 本身都支持 addEventListener/dispatchEvent。 */
function createViewStub({ innerWidth, innerHeight, visualViewport = null }) {
    const view = new EventTarget();
    view.innerWidth = innerWidth;
    view.innerHeight = innerHeight;
    if (visualViewport) {
        const vv = new EventTarget();
        Object.assign(vv, { offsetLeft: 0, offsetTop: 0, ...visualViewport });
        view.visualViewport = vv;
    }
    return view;
}

/** 面板矩形桩：未写入 left/top 时模拟 CSS 锚点在移动宿主上解析出的（可能越界的）默认位置。 */
function stubPanelRect(panel, styles, { defaultLeft, defaultTop, width, height }) {
    panel.getBoundingClientRect = () => {
        const left = Number.parseFloat(styles.left);
        const top = Number.parseFloat(styles.top);
        const finalLeft = Number.isFinite(left) ? left : defaultLeft;
        const finalTop = Number.isFinite(top) ? top : defaultTop;
        return { left: finalLeft, top: finalTop, width, height, right: finalLeft + width, bottom: finalTop + height };
    };
}

function stubLauncherRect(launcher, { defaultLeft, defaultTop, size = 56 }) {
    launcher.style = {
        position: '', left: '', top: '', right: '', bottom: '', touchAction: 'manipulation',
        setProperty(name, value) { this[name] = value; },
    };
    launcher.getBoundingClientRect = () => {
        const fixed = launcher.style.position === 'fixed';
        const left = fixed ? Number.parseFloat(launcher.style.left) : defaultLeft;
        const top = fixed ? Number.parseFloat(launcher.style.top) : defaultTop;
        return { left, top, width: size, height: size, right: left + size, bottom: top + size };
    };
}

function mountOnSmallViewport({ rootId, storage = createMemoryStorage(), view }) {
    miniDom.document.defaultView = view;
    miniDom.document.documentElement = { clientWidth: view.innerWidth, clientHeight: view.innerHeight };
    return mountPhoneApp({
        documentRef: miniDom.document, rootId, uiLayoutStorage: storage,
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null, llmClient: null, characterLibrary: null, readState: emptyReadResult,
    });
}

test('desktop layout also clamps a transformed-host panel back into the visual viewport on open and reset', () => {
    const previousDefaultView = miniDom.document.defaultView;
    const previousDocumentElement = miniDom.document.documentElement;
    const view = createViewStub({ innerWidth: 360, innerHeight: 740, visualViewport: { width: 360, height: 740 } });
    const storage = createMemoryStorage();
    storage.setItem('yuelema.ui-layout/v1', 'desktop');
    const mounted = mountOnSmallViewport({ rootId: 'ylm-test-desktop-panel-offscreen', storage, view });
    try {
        const panel = miniDom.document.querySelector('.yl-phone-panel');
        const tools = miniDom.document.querySelector('.yl-launcher-tools');
        const styles = installStyleRecorder(panel);
        panel.getBoundingClientRect = () => {
            const left = Number.parseFloat(styles.left);
            const top = Number.parseFloat(styles.top);
            const finalLeft = Number.isFinite(left) ? left : 8;
            const finalTop = Number.isFinite(top) ? top : -723;
            return { left: finalLeft, top: finalTop, right: finalLeft + 401, bottom: finalTop + 715, width: 401, height: 715 };
        };
        click(openLauncherButton());
        assert.equal(panel.dataset.uiLayout, 'desktop');
        assert.equal(styles.left, '0px', 'desktop 打开时必须把负 left 钳回可视视口');
        assert.equal(styles.top, '0px', 'desktop 打开时必须把负 top 钳回可视视口');

        tools.hidden = false;
        const reset = miniDom.document.querySelector('.yl-launcher-tools-reset');
        click(reset);
        assert.equal(styles.left, '0px', '桌面布局归位也必须实际修复面板坐标');
        assert.equal(styles.top, '0px');
    } finally {
        mounted.destroy();
        miniDom.document.defaultView = previousDefaultView;
        miniDom.document.documentElement = previousDocumentElement;
    }
});

test('phone panel with no saved position opens centered in a 360x740 visual viewport even when CSS anchors resolve off-screen', () => {
    const previousDefaultView = miniDom.document.defaultView;
    const previousDocumentElement = miniDom.document.documentElement;
    const view = createViewStub({ innerWidth: 360, innerHeight: 740, visualViewport: { width: 360, height: 740 } });
    const mounted = mountOnSmallViewport({ rootId: 'ylm-test-mobile-panel-center', view });
    try {
        const panel = miniDom.document.querySelector('.yl-phone-panel');
        const styles = installStyleRecorder(panel);
        // 模拟宿主 transform 使 CSS bottom 锚点把面板整体解析到屏幕上方之外。
        stubPanelRect(panel, styles, { defaultLeft: -40, defaultTop: -800, width: 320, height: 640 });
        click(openLauncherButton());
        assert.equal(styles.left, '20px', '无持久化位置时应水平居中于可视视口');
        assert.equal(styles.top, '50px', '无持久化位置时应垂直居中于可视视口');
    } finally {
        mounted.destroy();
        miniDom.document.defaultView = previousDefaultView;
        miniDom.document.documentElement = previousDocumentElement;
    }
});

test('phone panel keeps an in-viewport saved position and honors visualViewport offsets when centering', () => {
    const previousDefaultView = miniDom.document.defaultView;
    const previousDocumentElement = miniDom.document.documentElement;
    const storage = createMemoryStorage();
    storage.setItem('yuelema.phone-panel-position/v1', JSON.stringify({ left: 30, top: 40 }));
    const view = createViewStub({ innerWidth: 360, innerHeight: 740, visualViewport: { width: 360, height: 740 } });
    const mounted = mountOnSmallViewport({ rootId: 'ylm-test-mobile-panel-saved', storage, view });
    try {
        const panel = miniDom.document.querySelector('.yl-phone-panel');
        const styles = installStyleRecorder(panel);
        stubPanelRect(panel, styles, { defaultLeft: 0, defaultTop: 0, width: 220, height: 360 });
        click(openLauncherButton());
        assert.equal(styles.left, '30px', '仍在视口内的持久化位置应继续生效');
        assert.equal(styles.top, '40px');

        // 关闭后模拟软键盘/地址栏收缩：可视视口下移 100px 且变矮，持久化位置随之越界 → 回中。
        click(miniDom.document.querySelector('.yl-phone-close'));
        storage.setItem('yuelema.phone-panel-position/v1', JSON.stringify({ left: 30, top: 40 }));
        Object.assign(view.visualViewport, { offsetTop: 100, width: 360, height: 540 });
        click(openLauncherButton());
        assert.equal(styles.left, '70px', '越界后的居中应以 visualViewport 宽度为准');
        assert.equal(styles.top, '190px', '越界后的居中必须叠加 visualViewport offsetTop');
    } finally {
        mounted.destroy();
        miniDom.document.defaultView = previousDefaultView;
        miniDom.document.documentElement = previousDocumentElement;
    }
});

test('open panel is clamped back into the visual viewport when the viewport resizes', () => {
    const previousDefaultView = miniDom.document.defaultView;
    const previousDocumentElement = miniDom.document.documentElement;
    const storage = createMemoryStorage();
    storage.setItem('yuelema.phone-panel-position/v1', JSON.stringify({ left: 130, top: 40 }));
    const view = createViewStub({ innerWidth: 360, innerHeight: 740, visualViewport: { width: 360, height: 740 } });
    const mounted = mountOnSmallViewport({ rootId: 'ylm-test-mobile-panel-resize', storage, view });
    try {
        const panel = miniDom.document.querySelector('.yl-phone-panel');
        const styles = installStyleRecorder(panel);
        stubPanelRect(panel, styles, { defaultLeft: 0, defaultTop: 0, width: 220, height: 360 });
        click(openLauncherButton());
        assert.equal(styles.left, '130px');
        assert.equal(styles.top, '40px');

        Object.assign(view.visualViewport, { width: 300, height: 500 });
        view.visualViewport.dispatchEvent(new Event('resize'));
        assert.equal(styles.left, '80px', '视口收缩后打开中的面板必须钳回可视范围');
        assert.equal(styles.top, '40px');
    } finally {
        mounted.destroy();
        miniDom.document.defaultView = previousDefaultView;
        miniDom.document.documentElement = previousDocumentElement;
    }
});

test('launcher outside the visual viewport falls back to the bottom-right corner on viewport change', () => {
    const previousDefaultView = miniDom.document.defaultView;
    const previousDocumentElement = miniDom.document.documentElement;
    const view = createViewStub({ innerWidth: 360, innerHeight: 740, visualViewport: { width: 360, height: 740 } });
    const mounted = mountOnSmallViewport({ rootId: 'ylm-test-mobile-launcher-default', view });
    try {
        const launcher = miniDom.document.querySelector('.yl-phone-launcher');
        // 模拟用户实机现象：悬浮球被宿主几何顶到屏幕最上缘、半个身位越界。
        stubLauncherRect(launcher, { defaultLeft: 10, defaultTop: -30 });
        view.visualViewport.dispatchEvent(new Event('resize'));
        assert.equal(launcher.style.position, 'fixed');
        assert.equal(launcher.style.left, '292px', '无持久化坐标的越界悬浮球应回到右下角（360-56-12）');
        assert.equal(launcher.style.top, '672px', '无持久化坐标的越界悬浮球应回到右下角（740-56-12）');
    } finally {
        mounted.destroy();
        miniDom.document.defaultView = previousDefaultView;
        miniDom.document.documentElement = previousDocumentElement;
    }
});

test('a persisted launcher position from a larger viewport is re-clamped into the current one after rotation', () => {
    const previousDefaultView = miniDom.document.defaultView;
    const previousDocumentElement = miniDom.document.documentElement;
    const storage = createMemoryStorage();
    // 横屏（或桌面大屏）里保存的坐标，竖屏 360x740 下已在屏幕外。
    storage.setItem('yuelema.launcher-position/v1', JSON.stringify({ left: 700, top: 380 }));
    const view = createViewStub({ innerWidth: 360, innerHeight: 740, visualViewport: { width: 360, height: 740 } });
    const mounted = mountOnSmallViewport({ rootId: 'ylm-test-mobile-launcher-rotate', storage, view });
    try {
        const launcher = miniDom.document.querySelector('.yl-phone-launcher');
        stubLauncherRect(launcher, { defaultLeft: 700, defaultTop: 380 });
        view.dispatchEvent(new Event('resize'));
        assert.equal(launcher.style.position, 'fixed');
        assert.equal(launcher.style.left, '292px', '持久化坐标越界时应按当前视口钳回（保留可达的最大横向位置）');
        assert.equal(launcher.style.top, '380px', '仍在视口内的纵向坐标应保留');
    } finally {
        mounted.destroy();
        miniDom.document.defaultView = previousDefaultView;
        miniDom.document.documentElement = previousDocumentElement;
    }
});
