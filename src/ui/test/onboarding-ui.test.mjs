import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';

const miniDom = installMiniDom();
const { mountPhoneApp } = await import('../../app-shell.js');
const { createOnboardingFlow, onboardingProfilePayload, onboardingStepIssue, parseOnboardingTags } = await import('../../onboarding/onboarding-flow.js');

test.after(() => miniDom.restore());

function publicProfile(overrides = {}) {
    return {
        昵称: '', 头像引用: '', 年龄段: '', 性别: '', 性取向: '', 城市: '', 距离范围: '', 寻找意图: '', 简介: '',
        兴趣标签: [], 生活方式标签: [], 性格标签: [], 沟通风格标签: [], ...overrides,
    };
}

function readResult(gate = false, profile = publicProfile()) {
    const 功能开关 = gate === 'missing' ? {} : { 玩家已建档: gate };
    return {
        ok: true,
        state: {
            软件: { 内容模式: 'SFW', 功能开关 },
            玩家: { 成人验证: true, 公开资料: profile, 仅好友资料: { 私密: 'never-render' }, 隐藏资料: { 秘密: 'never-render' } },
            推荐: { 当前队列: [], 临时候选池: {} }, 角色池: {}, 会话: {}, 群组: {},
        },
    };
}

function click(node) {
    assert.ok(node, '要点击的控件必须存在');
    node.dispatchEvent(new Event('click'));
}

function buttonByText(text) {
    return miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes(text));
}

function setControl(name, value, eventName = 'input') {
    const control = miniDom.document.querySelector(`[name="${name}"]`);
    assert.ok(control, `应存在控件 ${name}`);
    control.value = value;
    control.dispatchEvent(new Event(eventName));
}

async function flushUi() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
}

function fillFlowThroughReview() {
    click(buttonByText('开始建档'));
    setControl('onboarding-昵称', '林澈');
    setControl('onboarding-年龄段', '25-29', 'change');
    setControl('onboarding-城市', '上海');
    click(buttonByText('继续'));
    setControl('onboarding-性别', '女', 'change');
    setControl('onboarding-性取向', '双性恋', 'change');
    setControl('onboarding-距离范围', '10 km');
    setControl('onboarding-寻找意图', '先聊天，再认真约会');
    click(buttonByText('继续'));
    setControl('onboarding-简介', '喜欢在夜色里散步，也愿意认真认识一个人。');
    setControl('onboarding-兴趣标签', '电影，夜跑，电影');
    setControl('onboarding-生活方式标签', '养猫，早睡');
    setControl('onboarding-性格标签', '慢热，真诚');
    setControl('onboarding-沟通风格标签', '消息有空就回');
    click(buttonByText('继续'));
}

function mount({ gate = false, saveProfile, profile = publicProfile(), rootId = 'yl-onboarding-test' } = {}) {
    let current = readResult(gate, profile);
    const calls = [];
    const actionBridge = {
        emit() {}, isPending() { return false; },
        async runSavePlayerPublicProfile(payload) {
            calls.push(payload);
            const result = saveProfile ? await saveProfile(payload) : { ok: true };
            if (result?.ok) current = readResult(true, payload);
            return result;
        },
    };
    const mounted = mountPhoneApp({ documentRef: miniDom.document, rootId, actionBridge, settingsStore: null, llmClient: null, characterLibrary: null, readState: () => current });
    return { mounted, calls };
}

function openPhone() {
    click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
}

test('标签归一化和分步校验保持公开资料边界', () => {
    assert.deepEqual(parseOnboardingTags('电影，夜跑,电影'), ['电影', '夜跑']);
    assert.match(onboardingStepIssue(1, publicProfile()), /昵称/u);
    assert.match(onboardingStepIssue(2, publicProfile({ 昵称: '林澈', 年龄段: '25-29', 城市: '上海' })), /性别/u);
    assert.match(onboardingStepIssue(3, publicProfile({ 简介: '一句话' })), /兴趣标签/u);
    const payload = onboardingProfilePayload(publicProfile({ 昵称: '林澈', 兴趣标签: ['电影'] }));
    assert.equal(payload.头像引用, '');
    assert.equal(Object.hasOwn(payload, '隐藏资料'), false);
    assert.equal(Object.hasOwn(payload, '仅好友资料'), false);
    assert.equal(Object.hasOwn(payload, 'UID'), false);
    assert.equal(Object.hasOwn(payload, 'stat_data'), false);
    assert.equal(Object.hasOwn(payload, 'patch'), false);
    assert.equal(Object.hasOwn(payload, 'pointer'), false);
});

test('严格 gate=false 时打开小手机展示现代建档引导，缺失 gate 或已建档不展示', () => {
    for (const [gate, expected] of [[false, true], ['missing', false], [true, false]]) {
        const { mounted } = mount({ gate, rootId: `yl-onboarding-gate-${String(gate)}` });
        try {
            openPhone();
            const overlay = miniDom.document.querySelector('.yl-onboarding');
            assert.equal(overlay.hidden, !expected);
            assert.equal(Boolean(miniDom.document.querySelector('.yl-onboarding-signal-art')), expected);
        } finally { mounted.destroy(); }
    }
});

test('完整引导只调用一次受控公开资料保存，成功后关闭并进入我的页', async () => {
    const { mounted, calls } = mount({ rootId: 'yl-onboarding-success' });
    try {
        openPhone();
        fillFlowThroughReview();
        assert.match(miniDom.document.querySelector('.yl-onboarding-review-card').textContent, /林澈/u);
        click(buttonByText('保存并开启'));
        await flushUi();
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], {
            头像引用: '', 昵称: '林澈', 年龄段: '25-29', 性别: '女', 性取向: '双性恋', 城市: '上海', 距离范围: '10 km',
            寻找意图: '先聊天，再认真约会', 简介: '喜欢在夜色里散步，也愿意认真认识一个人。',
            兴趣标签: ['电影', '夜跑'], 生活方式标签: ['养猫', '早睡'], 性格标签: ['慢热', '真诚'], 沟通风格标签: ['消息有空就回'],
        });
        assert.equal(miniDom.document.querySelector('.yl-onboarding').hidden, true);
        assert.ok(miniDom.document.querySelector('.yl-page-profile'));
        assert.match(miniDom.document.querySelector('.yl-profile-hero').textContent, /林澈/u);
        assert.match(miniDom.document.querySelector('.yl-profile-hero').textContent, /上海/u);
    } finally { mounted.destroy(); }
});

test('保存失败保留当前引导和草稿，稍后填写不触发受控写入且本次挂载不重弹', async () => {
    const { mounted, calls } = mount({
        rootId: 'yl-onboarding-failure',
        saveProfile: async () => ({ ok: false, code: 'mvu_get_unavailable', message: 'MVU 尚未就绪，暂时无法读取本聊天状态。' }),
    });
    try {
        openPhone();
        fillFlowThroughReview();
        click(buttonByText('保存并开启'));
        await flushUi();
        assert.equal(calls.length, 1);
        assert.equal(miniDom.document.querySelector('.yl-onboarding').hidden, false);
        assert.match(miniDom.document.querySelector('.yl-onboarding').textContent, /MVU 尚未就绪/u);
        click(buttonByText('稍后填写'));
        assert.equal(calls.length, 1);
        assert.equal(miniDom.document.querySelector('.yl-onboarding').hidden, true);
        click(miniDom.document.querySelector('.yl-phone-launcher'));
        click(miniDom.document.querySelector('.yl-phone-launcher'));
        assert.equal(miniDom.document.querySelector('.yl-onboarding').hidden, true);
    } finally { mounted.destroy(); }
});

test('关闭小手机会隐藏引导并恢复表面，重新打开时继续本次内存草稿', () => {
    const { mounted } = mount({ rootId: 'yl-onboarding-panel-close' });
    try {
        openPhone();
        click(buttonByText('开始建档'));
        setControl('onboarding-昵称', '暂存昵称');
        click(miniDom.document.querySelector('.yl-phone-launcher'));
        assert.equal(miniDom.document.querySelector('.yl-onboarding').hidden, true);
        click(miniDom.document.querySelector('.yl-phone-launcher'));
        assert.equal(miniDom.document.querySelector('.yl-onboarding').hidden, false);
        assert.equal(miniDom.document.querySelector('[name="onboarding-昵称"]').value, '暂存昵称');
    } finally { mounted.destroy(); }
});

test('独立引导控制器关闭后保留浏览器内存草稿，重新展示可续填', () => {
    const root = miniDom.document.createElement('div');
    miniDom.document.body.appendChild(root);
    const abortController = new AbortController();
    const flow = createOnboardingFlow({ documentRef: miniDom.document, root, signal: abortController.signal, saveProfile: async () => ({ ok: true }) });
    flow.show(publicProfile());
    click(buttonByText('开始建档'));
    setControl('onboarding-昵称', '未完成草稿');
    flow.hide();
    flow.show(publicProfile());
    assert.equal(miniDom.document.querySelector('[name="onboarding-昵称"]').value, '未完成草稿');
    abortController.abort();
    root.remove();
});
