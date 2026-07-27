import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';

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

function click(node) {
    assert.ok(node, '要点击的控件必须存在');
    node.dispatchEvent(new Event('click'));
}

async function flushUi() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
}

function installStyleRecorder(node) {
    const values = Object.create(null);
    node.style = new Proxy({
        setProperty(name, value) { values[name] = String(value); },
        removeProperty(name) { delete values[name]; },
    }, {
        get(target, key) { return key in target ? target[key] : values[key] ?? ''; },
        set(target, key, value) { values[key] = String(value); return true; },
    });
    return values;
}

test('Termux transformed host centers an operation dialog in the actual visual viewport and recenters it after resize', async () => {
    const previousDefaultView = miniDom.document.defaultView;
    const windowRef = new EventTarget();
    const visualViewport = new EventTarget();
    Object.assign(windowRef, { innerWidth: 360, innerHeight: 640, visualViewport });
    Object.assign(visualViewport, { width: 360, height: 640, offsetLeft: 0, offsetTop: 0 });
    miniDom.document.defaultView = windowRef;

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
        // 模拟被 Termux/SillyTavern transformed host 捕获的 fixed 坐标系：
        // fixed left/top 会额外产生 (32, -180) 的实际屏幕偏移，且保留 CSS 的 translate(-50%, -50%)。
        dialog.getBoundingClientRect = () => {
            const centerX = Number.parseFloat(styles.left);
            const centerY = Number.parseFloat(styles.top);
            return {
                left: centerX + 32 - 160,
                top: centerY - 180 - 250,
                width: 320,
                height: 500,
                right: centerX + 32 + 160,
                bottom: centerY - 180 + 250,
            };
        };

        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '收藏'));
        await flushUi();

        assert.equal(dialog.hidden, false);
        assert.equal(styles.left, '148px');
        assert.equal(styles.top, '500px');
        assert.equal(styles['max-width'], '332px');
        assert.equal(styles['max-height'], '612px');

        Object.assign(visualViewport, { width: 640, height: 360 });
        visualViewport.dispatchEvent(new Event('resize'));

        assert.equal(styles.left, '288px', '地址栏、软键盘或旋转导致 visualViewport 变化后，应再次补偿宿主坐标');
        assert.equal(styles.top, '360px');
        assert.equal(styles['max-width'], '612px');
        assert.equal(styles['max-height'], '332px');
    } finally {
        mounted.destroy();
        miniDom.document.defaultView = previousDefaultView;
    }
});
