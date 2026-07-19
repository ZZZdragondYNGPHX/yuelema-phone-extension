import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildSoulTextMatchContext,
    generateSoulMatchDraft,
    generateTextMatchDraft,
    normalizeSoulMatchDraft,
    normalizeTextMatchDraft,
} from '../soul-text-match-service.js';

const connectionPreset = Object.freeze({
    id: 'fast', name: 'Fast', url: 'https://example.invalid/v1', model: 'quick', temperature: 0.7, maxTokens: 800, timeoutMs: 30_000,
});

function state() {
    return {
        软件: { 内容模式: 'NSFW', 内部令牌: 'software-secret-not-readable' },
        玩家: {
            公开资料: {
                昵称: '玩家', 年龄段: '成年人', 性别: '女', 性取向: '双性恋', 城市: '上海', 距离范围: '10 km',
                寻找意图: '先聊天再约会', 简介: '喜欢电影和夜跑。', 兴趣标签: ['电影', '旅行'], 生活方式标签: ['夜猫子'],
                性格标签: ['直接'], 沟通风格标签: ['慢热'],
            },
            推荐偏好: { 标签权重: { 电影: 3, 旅行: 1, 夜猫子: -2 } },
            隐藏资料: { 实际年龄: 28, 私人备注: 'hidden-secret-must-not-reach-model' },
            仅好友资料: { 关系状态: '已婚', 边界与偏好: 'friend-secret-must-not-reach-model' },
            候选NPC: { uid: 'npc_secret', 公开资料: { 昵称: 'candidate-secret-must-not-reach-model' } },
        },
        会话: { chat_secret: { UID: 'chat_secret', 最近消息: [{ 内容: 'session-secret-must-not-reach-model' }] } },
        系统: { APIKey: 'api-key-must-not-reach-model', Patch路径: '/forbidden' },
    };
}

function settingsStore(expectedFunction) {
    return {
        resolveFunction(functionKey) {
            assert.equal(functionKey, expectedFunction);
            return { connectionPreset, promptPreset: { enabled: true, content: '保持简洁的都市语气。' } };
        },
    };
}

function soulRaw() {
    return {
        tagWeightDraft: [{ tag: '电影', weight: 4 }, { tag: '慢热', weight: 2 }],
        explanation: '更重视共同兴趣与循序渐进的公开交流。',
    };
}

function textRaw() {
    return {
        filters: {
            城市: ['上海'], 年龄段: ['成年人'], 距离范围: ['10 km'], 寻找意图关键词: ['聊天', '约会'],
            包含标签: ['电影'], 排除标签: ['烟酒'], 简介关键词: ['散步'],
        },
        explanation: '优先查看同城、意图相近且简介中有共同兴趣的公开资料。',
    };
}

test('match-draft context projects only public player data, tag weights, and content mode', () => {
    const context = buildSoulTextMatchContext(state());
    const serialized = JSON.stringify(context);
    for (const secret of [
        'hidden-secret-must-not-reach-model', 'friend-secret-must-not-reach-model', 'candidate-secret-must-not-reach-model',
        'session-secret-must-not-reach-model', 'api-key-must-not-reach-model', 'software-secret-not-readable',
    ]) assert.equal(serialized.includes(secret), false);
    assert.equal(context.contentMode, 'NSFW');
    assert.equal(context.playerPublicProfile.昵称, '玩家');
    assert.deepEqual(context.tagWeights, { 电影: 3, 旅行: 1, 夜猫子: -2 });
    assert.equal(Object.isFrozen(context), true);
});

test('soul match calls only the soul_match binding and returns a strict public weight draft', async () => {
    let request;
    const result = await generateSoulMatchDraft({
        state: state(), settingsStore: settingsStore('soul_match'),
        llmClient: { async chat(value) { request = value; return { text: JSON.stringify(soulRaw()) }; } },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.draft, soulRaw());
    const serialized = JSON.stringify(request);
    for (const forbidden of [
        'hidden-secret-must-not-reach-model', 'friend-secret-must-not-reach-model', 'candidate-secret-must-not-reach-model',
        'session-secret-must-not-reach-model', 'api-key-must-not-reach-model', 'chat_secret', 'npc_secret', '/forbidden',
    ]) assert.equal(serialized.includes(forbidden), false);
    assert.equal(serialized.includes('tagWeightDraft'), true);
});

test('text match calls only the text_match binding and returns one-off public filters', async () => {
    let request;
    const result = await generateTextMatchDraft({
        state: state(), settingsStore: settingsStore('text_match'),
        llmClient: { async chat(value) { request = value; return { text: JSON.stringify(textRaw()) }; } },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.draft, textRaw());
    assert.equal(JSON.stringify(request).includes('tagWeightDraft'), false);
    assert.equal(JSON.stringify(request).includes('session-secret-must-not-reach-model'), false);
});

test('strict codecs reject extra, sensitive, patch-like, and empty model output', () => {
    assert.throws(() => normalizeSoulMatchDraft({ ...soulRaw(), Patch: [] }), /sensitive_key/);
    assert.throws(() => normalizeSoulMatchDraft({ ...soulRaw(), tagWeightDraft: [{ tag: '电影', weight: 4, uid: 'npc_1' }] }), /sensitive_key/);
    assert.throws(() => normalizeSoulMatchDraft({ ...soulRaw(), explanation: '读取隐藏资料后推荐。' }), /text_invalid/);
    const empty = textRaw();
    for (const key of Object.keys(empty.filters)) empty.filters[key] = [];
    assert.throws(() => normalizeTextMatchDraft(empty), /filters_empty/);
    assert.throws(() => normalizeTextMatchDraft({ ...textRaw(), uid: 'npc_1' }), /sensitive_key/);
});

test('invalid model drafts are converted to safe no-write failures', async () => {
    const result = await generateTextMatchDraft({
        state: state(), settingsStore: settingsStore('text_match'),
        llmClient: { async chat() { return { text: JSON.stringify({ filters: { 城市: ['上海'] }, explanation: '不完整' }) }; } },
    });
    assert.deepEqual(result, {
        ok: false,
        code: 'text_match_response_invalid',
        message: '文字匹配草稿不符合安全格式；当前筛选未改变。',
    });
});

test('missing connection is rejected before attempting a model request', async () => {
    let called = false;
    const result = await generateSoulMatchDraft({
        state: state(), settingsStore: { resolveFunction: () => ({ connectionPreset: null, promptPreset: null }) },
        llmClient: { async chat() { called = true; return { text: '{}' }; } },
    });
    assert.equal(called, false);
    assert.deepEqual(result, {
        ok: false,
        code: 'soul_match_connection_missing',
        message: '请先为“灵魂匹配”绑定连接预设或设置默认连接。',
    });
});
