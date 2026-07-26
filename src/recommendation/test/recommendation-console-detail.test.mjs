/**
 * 推荐/匹配域 → 安全控制台 detail 的端到端接线回归：
 * 桥接层按 action-bridge 的真实语义只回传 { ok, status, code, message }，
 * 页面层必须仍能通过服务层诊断寄存器拿到 HTTP 状态、阶段与字段级不合规点，
 * 且界面 message 保持粗略友好、detail 不含密钥样本与隐藏层字段值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { generateRecommendationCandidate } from '../recommendation-refresh.js';
import { generateCandidateMatchDraft } from '../soul-text-match-service.js';
import { YueLeMaLlmError } from '../../llm/openai-compatible-client.js';

const miniDom = installMiniDom();
const { mountPhoneApp } = await import('../../app-shell.js');

test.after(() => miniDom.restore());

function adultCharacter(nickname = '公开候选人') {
    return {
        成人验证: true,
        公开资料: {
            昵称: nickname, 头像引用: '', 年龄段: '25-29', 性别: '女', 性取向: '双性恋',
            城市: '上海', 距离范围: '10 km', 寻找意图: '聊天后约会', 简介: '只展示公开资料。',
            兴趣标签: ['电影'], 生活方式标签: ['夜猫子'], 性格标签: ['直接'], 沟通风格标签: ['慢热'],
        },
        仅好友资料: {}, 隐藏资料: {}, 偏好与边界: '',
        拒绝阈值: 40, 已读不回阈值: 55, 取消匹配阈值: 70, 拉黑阈值: 90,
        与玩家关系: { 状态: '未匹配', 全局账号表现: 80, NPC专属匹配度: 85, 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 },
    };
}

function generatedCandidate() {
    return {
        成人验证: true,
        公开资料: {
            昵称: '林澈', 头像引用: '', 年龄段: '25-29', 性别: '女', 性取向: '双性恋', 城市: '上海',
            距离范围: '10 km', 寻找意图: '先聊天再约会', 简介: '喜欢看展和散步。',
            兴趣标签: ['电影'], 生活方式标签: ['夜猫子'], 性格标签: ['直接'], 沟通风格标签: ['慢热'],
        },
        仅好友资料: { 关系状态: '单身', 边界与偏好: '尊重拒绝。' },
        隐藏资料: { 实际年龄: 28, 私人备注: '' },
        偏好与边界: '先确认边界。', 拒绝阈值: 35, 已读不回阈值: 55, 取消匹配阈值: 75, 拉黑阈值: 90,
        与玩家关系: { 状态: '陌生', 全局账号表现: 68, NPC专属匹配度: 72, 好感: 0, 信任: 0, 戒备: 20, 面基意愿: 0 },
    };
}

function readyReadResult() {
    const candidate = adultCharacter();
    return {
        ok: true,
        state: {
            系统: { UID计数器: { 角色: 1 } },
            软件: { 内容模式: 'SFW' },
            玩家: { 公开资料: adultCharacter('玩家').公开资料 },
            推荐: { 当前队列: ['npc_1'], 临时候选池: { npc_1: candidate }, 冷却角色UID: [], 收藏角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [] },
            角色池: { npc_1: candidate }, 会话: {}, 群组: {},
        },
    };
}

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

function findButton(predicate) {
    return miniDom.document.querySelectorAll('button').find(predicate);
}

function buttonByPage(page) {
    return [
        ...miniDom.document.querySelectorAll('button'),
        ...miniDom.document.querySelectorAll('.yl-hub-entry'),
    ].find((node) => node.dataset.page === page);
}

async function flushUi() {
    for (let round = 0; round < 6; round += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

const connectionPreset = {
    id: 'fast', name: 'Fast', url: 'https://example.invalid/v1', model: 'quick',
    temperature: 0.7, maxTokens: 800, timeoutMs: 30_000,
};
const refreshSettings = {
    resolveFunction: () => ({ connectionPreset, promptPreset: { enabled: true, content: '保持轻快语气。' } }),
};
const matchSettings = {
    snapshot: () => ({ personalization: { keywordWeightsByMode: { SFW: [], NSFW: [] } } }),
    resolveFunction: () => ({ connectionPreset, promptPreset: { enabled: true, content: '只生成公开角色资料。' } }),
};

/** 与 action-bridge 相同的失败重包语义：额外诊断字段在桥接处丢失。 */
function bridgeStyleFailure(generated) {
    return { ok: false, status: 'rejected', code: generated.code, message: generated.message };
}

test('首页推荐刷新失败：控制台 detail 含阶段/HTTP 状态/摘要，界面 message 保持粗略', async () => {
    const failingLlm = {
        async chat() {
            throw new YueLeMaLlmError('SERVER_ERROR', '模型服务暂时不可用，请稍后重试。', {
                status: 502, retryable: true, bodyExcerpt: 'gateway exploded sk-abcdefgh12345678',
            });
        },
    };
    const bridge = {
        emit() {}, isPending() { return false; },
        async runRecommendationRefresh() {
            const generated = await generateRecommendationCandidate({
                state: readyReadResult().state, settingsStore: refreshSettings, llmClient: failingLlm,
            });
            return bridgeStyleFailure(generated);
        },
        async runMvuAction() { return { ok: true }; },
        async runRecommendationInitialCandidate() { return { ok: true }; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-console-detail-refresh', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: readyReadResult,
    });
    try {
        click(findButton((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(findButton((node) => node.getAttribute('aria-label') === '刷新候选人，显示下一位'));
        await flushUi();
        const entry = mounted.operationActivity.snapshot().entries[0];
        assert.equal(entry.status, 'failure');
        assert.equal(entry.name, '首页推荐');
        assert.equal(entry.message, '下一位候选人未生成，请稍后再试。', '界面提示必须保持粗略友好');
        assert.ok(entry.detail, '失败必须写入控制台 detail');
        assert.match(entry.detail, /操作: 首页推荐/u);
        assert.match(entry.detail, /阶段: 请求快速模型/u);
        assert.match(entry.detail, /错误码: SERVER_ERROR/u);
        assert.match(entry.detail, /HTTP 状态: 502/u);
        assert.match(entry.detail, /gateway exploded/u);
        assert.doesNotMatch(entry.detail, /sk-abcdefgh/u, 'detail 不得携带 Key 样本');
    } finally { mounted.destroy(); }
});

test('空池首位生成失败：detail 报候选校验字段路径与原因，不带隐藏层字段值', async () => {
    const invalid = generatedCandidate();
    invalid.隐藏资料.实际年龄 = 16;
    const bridge = {
        emit() {}, isPending() { return false; },
        async runRecommendationInitialCandidate() {
            const generated = await generateRecommendationCandidate({
                state: emptyReadResult().state, settingsStore: refreshSettings,
                llmClient: { async chat() { return { text: JSON.stringify(invalid) }; } },
            });
            return bridgeStyleFailure(generated);
        },
        async runMvuAction() { return { ok: true }; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-console-detail-initial', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: emptyReadResult,
    });
    try {
        click(findButton((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(findButton((node) => node.getAttribute('aria-label') === '刷新候选人，显示下一位'));
        await flushUi();
        const entry = mounted.operationActivity.snapshot().entries[0];
        assert.equal(entry.status, 'failure');
        assert.equal(entry.name, '首页推荐');
        assert.equal(entry.message, '首位候选人未生成，请稍后再试。');
        assert.match(entry.detail, /阶段: 候选结构与成年人校验/u);
        assert.match(entry.detail, /字段: 隐藏资料\.实际年龄/u);
        assert.match(entry.detail, /integer_out_of_range/u);
        assert.doesNotMatch(entry.detail, /16/u, '隐藏层字段只能报字段名与结论，不得携带值');
    } finally { mounted.destroy(); }
});

test('灵魂匹配失败：detail 报解析阶段与响应形态；无诊断时也能按结果码降级组装', async () => {
    const proseLlm = { async chat() { return { text: '抱歉，这里只有一段散文。' }; } };
    const bridge = {
        emit() {}, isPending() { return false; },
        async runCandidateMatch(mode) {
            const generated = await generateCandidateMatchDraft({
                mode, state: readyReadResult().state, settingsStore: matchSettings, llmClient: proseLlm,
            });
            return bridgeStyleFailure(generated);
        },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-console-detail-match', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: readyReadResult,
    });
    try {
        click(findButton((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(buttonByPage('matches'));
        click(findButton((node) => node.textContent === '开始匹配'));
        await flushUi();
        const entry = mounted.operationActivity.snapshot().entries[0];
        assert.equal(entry.status, 'failure');
        assert.equal(entry.name, '灵魂匹配');
        assert.equal(entry.message, '灵魂匹配未完成，请稍后再试。');
        assert.match(entry.detail, /操作: 灵魂匹配/u);
        assert.match(entry.detail, /阶段: 候选资料生成（解析响应）/u);
        assert.match(entry.detail, /错误码: candidate_match_invalid_json/u);
        assert.match(entry.detail, /实际: 响应共 \d+ 字符/u);

        /* 桥接层吞掉服务诊断（寄存器为空）时，页面仍要按结果码降级组装 detail */
        bridge.runCandidateMatch = async () => ({ ok: false, status: 'rejected', code: 'ui_action_pending', message: undefined });
        click(findButton((node) => node.textContent === '再试一次'));
        await flushUi();
        const fallbackEntry = mounted.operationActivity.snapshot().entries[0];
        assert.equal(fallbackEntry.status, 'failure');
        assert.match(fallbackEntry.detail, /错误码: ui_action_pending/u);
        assert.match(fallbackEntry.detail, /阶段: 候选匹配生成/u);
    } finally { mounted.destroy(); }
});
