import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecommendationContext, generateRecommendationCandidate } from '../recommendation-refresh.js';

function adultCandidate() {
    return {
        成人验证: true,
        公开资料: { 昵称: '林澈', 头像引用: '', 年龄段: '25-29', 性别: '女', 性取向: '双性恋', 城市: '上海', 距离范围: '10 km', 寻找意图: '先聊天再约会', 简介: '喜欢看展和散步。', 兴趣标签: ['电影'], 生活方式标签: ['夜猫子'], 性格标签: ['直接'], 沟通风格标签: ['慢热'] },
        仅好友资料: { 关系状态: '单身', 边界与偏好: '尊重拒绝。' },
        隐藏资料: { 实际年龄: 28, 私人备注: '对临时失约敏感。' },
        偏好与边界: '先确认边界。', 拒绝阈值: 35, 已读不回阈值: 55, 取消匹配阈值: 75, 拉黑阈值: 90,
        与玩家关系: { 状态: '陌生', 全局账号表现: 68, NPC专属匹配度: 72, 好感: 0, 信任: 0, 戒备: 20, 面基意愿: 0 },
    };
}

function state() {
    return {
        软件: { 内容模式: 'SFW' },
        玩家: {
            公开资料: { 昵称: '玩家', 年龄段: '成年人', 性别: '男', 性取向: '异性恋', 城市: '上海', 距离范围: '不限', 寻找意图: '聊天', 简介: '公开简介', 兴趣标签: ['电影'], 生活方式标签: [], 性格标签: [], 沟通风格标签: [] },
            隐藏资料: { 私人备注: '绝不能发送给模型' },
            仅好友资料: { 关系状态: '同样不能发送' },
            推荐偏好: { 标签权重: { 电影: 2 } },
        },
    };
}

const connectionPreset = { id: 'fast', name: 'Fast', url: 'https://example.invalid/v1', model: 'quick', temperature: 0.7, maxTokens: 800, timeoutMs: 30_000 };
const settingsStore = { resolveFunction: () => ({ connectionPreset, promptPreset: { enabled: true, content: '保持轻快、真实的都市语气。' } }) };

test('recommendation context exposes only public player fields and bounded tag weights', () => {
    const context = buildRecommendationContext(state());
    const serialized = JSON.stringify(context);
    assert.equal(serialized.includes('绝不能发送给模型'), false);
    assert.equal(serialized.includes('同样不能发送'), false);
    assert.equal(context.tagWeights.电影, 2);
});

test('fast recommender validates one model candidate before any MVU write boundary', async () => {
    let requestInput;
    let messages;
    const result = await generateRecommendationCandidate({
        state: state(), settingsStore,
        llmClient: { async chat(request) { requestInput = request; messages = request.messages; return { text: JSON.stringify(adultCandidate()) }; } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.candidate.成人验证, true);
    assert.equal(requestInput.maxTokens, 2048);
    assert.equal(JSON.stringify(messages).includes('绝不能发送给模型'), false);
    assert.equal(JSON.stringify(messages).includes('同样不能发送'), false);
});

test('fast recommender accepts one fenced JSON object from an otherwise compatible provider', async () => {
    const result = await generateRecommendationCandidate({
        state: state(), settingsStore,
        llmClient: { async chat() { return { text: `\`\`\`json\n${JSON.stringify(adultCandidate())}\n\`\`\`` }; } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.candidate.公开资料.昵称, '林澈');
});

test('fast recommender never lowers a larger saved output budget', async () => {
    let requestInput;
    const highBudgetSettings = {
        resolveFunction: () => ({
            connectionPreset: { ...connectionPreset, maxTokens: 4096 },
            promptPreset: { enabled: true, content: '保持轻快、真实的都市语气。' },
        }),
    };
    const result = await generateRecommendationCandidate({
        state: state(), settingsStore: highBudgetSettings,
        llmClient: { async chat(request) { requestInput = request; return { text: JSON.stringify(adultCandidate()) }; } },
    });
    assert.equal(result.ok, true);
    assert.equal(requestInput.maxTokens, 4096);
});

test('invalid model JSON leaves recommendation generation in a safe no-result state', async () => {
    const result = await generateRecommendationCandidate({
        state: state(), settingsStore,
        llmClient: { async chat() { return '```json not-valid'; } },
    });
    assert.deepEqual(result, { ok: false, code: 'recommendation_invalid_json', message: '快速模型没有返回可用的候选资料；当前推荐未改变。' });
});

test('adult candidate validation failure returns a safe validation result without raw model details', async () => {
    const underage = adultCandidate();
    underage.隐藏资料.实际年龄 = 17;
    const result = await generateRecommendationCandidate({
        state: state(), settingsStore,
        llmClient: { async chat() { return { text: JSON.stringify(underage) }; } },
    });

    assert.deepEqual(result, {
        ok: false,
        code: '隐藏资料.实际年龄:integer_out_of_range',
        message: '快速模型返回的候选资料未通过成年人或结构校验；当前推荐未改变。',
    });
});


function nsfwState() {
    const value = state();
    value.软件.内容模式 = 'NSFW';
    return value;
}

test('SFW and NSFW recommendation contexts expose different public-tag contracts without private player data', () => {
    const sfw = buildRecommendationContext(state());
    const nsfw = buildRecommendationContext(nsfwState());
    assert.equal(sfw.contentMode, 'SFW');
    assert.equal(nsfw.contentMode, 'NSFW');
    assert.deepEqual(sfw.publicTagContract.allowedTagCategories, ['常规兴趣', '生活方式', '性格', '沟通风格']);
    assert.equal(sfw.publicTagContract.forbidden.includes('成人取向或身体性化关键词'), true);
    assert.equal(nsfw.publicTagContract.allowedTagCategories.includes('成年人明确自愿的成人取向或身体偏好公开标签'), true);
    assert.equal(nsfw.publicTagContract.examples.includes('翘臀'), true);
    assert.equal(JSON.stringify(nsfw).includes('绝不能发送给模型'), false);
    assert.equal(JSON.stringify(nsfw).includes('同样不能发送'), false);
});

test('fast recommender applies the selected SFW/NSFW output contract before any write boundary', async () => {
    const adultTagCandidate = adultCandidate();
    adultTagCandidate.公开资料.生活方式标签 = ['翘臀'];

    let sfwMessages;
    const sfw = await generateRecommendationCandidate({
        state: state(), settingsStore,
        llmClient: { async chat(request) { sfwMessages = request.messages; return { text: JSON.stringify(adultTagCandidate) }; } },
    });
    assert.deepEqual(sfw, {
        ok: false,
        code: '公开资料.生活方式标签[0]:adult_keyword_in_sfw',
        message: '快速模型返回的候选资料未通过成年人或结构校验；当前推荐未改变。',
    });
    assert.equal(JSON.stringify(sfwMessages).includes('SFW 输出合同'), true);
    assert.equal(JSON.stringify(sfwMessages).includes('NSFW 输出合同'), false);

    let nsfwMessages;
    const nsfw = await generateRecommendationCandidate({
        state: nsfwState(), settingsStore,
        llmClient: { async chat(request) { nsfwMessages = request.messages; return { text: JSON.stringify(adultTagCandidate) }; } },
    });
    assert.equal(nsfw.ok, true);
    assert.deepEqual(nsfw.candidate.公开资料.生活方式标签, ['翘臀']);
    assert.equal(JSON.stringify(nsfwMessages).includes('NSFW 输出合同'), true);
    assert.equal(JSON.stringify(nsfwMessages).includes('成年人明确自愿的成人取向或身体偏好公开标签'), true);
    assert.equal(JSON.stringify(nsfwMessages).includes('线下性行为'), true);
});
