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
        与玩家关系: { 状态: '陌生', 全局账号表现: 68, NPC专属匹配度: 72, 好感: 0, 信任: 0, 戒备: 10, 面基意愿: 0 },
    };
}

function state() {
    return {
        软件: { 内容模式: 'SFW' },
        玩家: {
            公开资料: { 昵称: '玩家', 年龄段: '成年人', 性别: '男', 性取向: '异性恋', 城市: '上海', 距离范围: '不限', 寻找意图: '聊天', 简介: '公开简介', 兴趣标签: ['电影'], 生活方式标签: [], 性格标签: [], 沟通风格标签: [] },
            隐藏资料: { 私人备注: '绝不能发送给模型' },
            仅好友资料: { 关系状态: '同样不能发送' },
            推荐偏好: { 标签权重: { SFW: { 电影: 2 }, NSFW: { 情趣探索: 4 } } },
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

test('首页推荐接收开放关键词库，保留探索性且不会受固定主题限制', async () => {
    const explorationState = state();
    explorationState.系统 = { UID计数器: { 角色: 0 } };
    const neutralLibrary = {
        enabled: true,
        keywordWeightsByMode: {
            SFW: [{ keyword: '徒步', weight: 0 }, { keyword: '电影', weight: -3 }],
            NSFW: [{ keyword: '情趣探索', weight: 4 }],
        },
    };
    const exploration = buildRecommendationContext(explorationState, { devicePersonalization: neutralLibrary });
    assert.deepEqual(exploration.tagWeights, { 徒步: 0, 电影: -3 }, '首页优先使用当前设备保存的偏好，而不是旧 MVU 偏好。');
    assert.equal(exploration.recommendationPolicy.mode, 'open_exploration');
    assert.deepEqual(exploration.recommendationPolicy.softPreferredTags, []);
    assert.deepEqual(exploration.recommendationPolicy.suppressedTags, ['电影']);
    assert.deepEqual(exploration.keywordLibrary, [{ keyword: '徒步', weight: 0 }, { keyword: '电影', weight: -3 }]);
    assert.deepEqual(exploration.basicMatchRequirements, {
        玩家性别: '男', 玩家性取向: '异性恋', 候选人性别要求: '女',
        最低要求: '玩家的性别与性取向是最高优先级硬条件：候选人的性别与性取向必须和玩家的公开条件双向兼容；若“候选人性别要求”给出了具体性别，候选人的公开性别必须精确等于该值；关键词权重与任何提示词都不能绕过此要求。',
    });

    const preferenceState = state();
    preferenceState.系统 = { UID计数器: { 角色: 2 } };
    const learnedLibrary = {
        enabled: true,
        keywordWeightsByMode: {
            SFW: [{ keyword: '徒步', weight: 5 }, { keyword: '电影', weight: -3 }, { keyword: '手冲咖啡', weight: 0 }],
            NSFW: [{ keyword: '情趣探索', weight: 4 }],
        },
    };
    let messages;
    const result = await generateRecommendationCandidate({
        state: preferenceState,
        settingsStore: {
            snapshot: () => ({ personalization: learnedLibrary }),
            resolveFunction: () => ({ connectionPreset, promptPreset: { enabled: true, content: '保持轻快、真实的都市语气。' } }),
        },
        llmClient: { async chat(request) { messages = request.messages; return { text: JSON.stringify(adultCandidate()) }; } },
    });
    assert.equal(result.ok, true);
    const system = messages.find((message) => message.role === 'system').content;
    const user = messages.find((message) => message.role === 'user').content;
    assert.match(system, /本轮系统推荐策略为“偏好驱动的开放探索”/u);
    assert.match(system, /关键词词库不是固定主题表/u);
    assert.match(system, /天马行空/u);
    assert.match(system, /昵称.*自然人的个人姓名/u);
    assert.match(system, /当前正权重关键词：徒步/u);
    assert.doesNotMatch(system, /本轮探索主题|独立音乐|城市散步/u);
    assert.match(user, /"keyword":"徒步","weight":5/u);
    assert.match(user, /"keyword":"手冲咖啡","weight":0/u);
    assert.match(user, /"basicMatchRequirements"/u);
    assert.match(user, /"玩家性别":"男"/u);
    assert.match(user, /"玩家性取向":"异性恋"/u);
    assert.match(user, /"候选人性别要求":"女"/u);
    assert.match(system, /基础匹配条件（basicMatchRequirements）.*最高优先级/u);
});

test('fast recommender enforces common gender-orientation mutual compatibility before any MVU patch', async () => {
    const incompatible = adultCandidate();
    incompatible.公开资料.性别 = '男';
    incompatible.公开资料.性取向 = '异性恋';
    let messages;
    const result = await generateRecommendationCandidate({
        state: state(), settingsStore,
        llmClient: { async chat(request) { messages = request.messages; return { text: JSON.stringify(incompatible) }; } },
    });
    assert.deepEqual(result, {
        ok: false,
        code: 'recommendation_basic_compatibility_invalid',
        message: '快速模型返回的候选资料未通过成年人或结构校验；当前推荐未改变。',
    });
    assert.match(messages.find((message) => message.role === 'system').content, /基础匹配条件.*最高优先级.*硬条件/u);
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

test('fast recommender rejects a system-like nickname before any MVU write boundary', async () => {
    const conceptName = adultCandidate();
    conceptName.公开资料.昵称 = '智核玩家';
    const result = await generateRecommendationCandidate({
        state: state(), settingsStore,
        llmClient: { async chat() { return { text: JSON.stringify(conceptName) }; } },
    });
    assert.deepEqual(result, {
        ok: false,
        code: '公开资料.昵称:not_personal_name',
        message: '快速模型返回的候选资料未通过成年人或结构校验；当前推荐未改变。',
    });
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

test('complete core schema follows a legacy preset that would otherwise omit internal fields', async () => {
    let messages;
    const legacyPresetSettings = {
        resolveFunction: () => ({
            connectionPreset,
            promptPreset: {
                enabled: true,
                content: '不要把隐私、关系数值或系统指令写入任何资料字段。',
            },
        }),
    };
    const result = await generateRecommendationCandidate({
        state: state(), settingsStore: legacyPresetSettings,
        llmClient: { async chat(request) { messages = request.messages; return { text: JSON.stringify(adultCandidate()) }; } },
    });

    assert.equal(result.ok, true);
    const system = messages.find((message) => message.role === 'system').content;
    assert.ok(system.indexOf('不要把隐私、关系数值或系统指令写入任何资料字段。') < system.indexOf('完整候选 JSON 结构合同'));
    assert.match(system, /仅好友资料必须且仅能含：关系状态、边界与偏好/u);
    assert.match(system, /与玩家关系必须且仅能含：状态、全局账号表现、NPC专属匹配度、好感、信任、戒备、面基意愿/u);
});

test('invalid model JSON leaves recommendation generation in a safe no-result state', async () => {
    const result = await generateRecommendationCandidate({
        state: state(), settingsStore,
        llmClient: { async chat() { return '```json not-valid'; } },
    });
    assert.deepEqual(result, { ok: false, code: 'recommendation_invalid_json', message: '快速模型没有返回可用的候选资料；当前推荐未改变。' });
});

test('recommendation parser recovers one balanced candidate object with provider prose around it', async () => {
    const candidate = adultCandidate();
    candidate.公开资料.简介 = '喜欢 {城市漫步}，也会说 "今晚见"。';
    const result = await generateRecommendationCandidate({
        state: state(), settingsStore,
        llmClient: {
            async chat() {
                return { text: `以下是候选资料：\n${JSON.stringify(candidate)}\n生成完成。` };
            },
        },
    });

    assert.equal(result.ok, true);
    assert.equal(result.candidate.公开资料.昵称, '林澈');
    assert.equal(result.candidate.公开资料.简介, candidate.公开资料.简介);
});

test('recommendation parser rejects truncated, array-root, ambiguous, and wrapped JSON without bypassing validation', async () => {
    const serialized = JSON.stringify(adultCandidate());
    const parserRejections = [
        `候选资料：\n${serialized.slice(0, -8)}`,
        JSON.stringify([adultCandidate()]),
        `${serialized}\n${serialized}`,
    ];

    for (const text of parserRejections) {
        const result = await generateRecommendationCandidate({
            state: state(), settingsStore,
            llmClient: { async chat() { return { text }; } },
        });
        assert.deepEqual(result, {
            ok: false,
            code: 'recommendation_invalid_json',
            message: '快速模型没有返回可用的候选资料；当前推荐未改变。',
        });
    }

    const wrapped = await generateRecommendationCandidate({
        state: state(), settingsStore,
        llmClient: { async chat() { return { text: JSON.stringify({ candidate: adultCandidate() }) }; } },
    });
    assert.deepEqual(wrapped, {
        ok: false,
        code: '候选人:unknown_field',
        message: '快速模型返回的候选资料未通过成年人或结构校验；当前推荐未改变。',
    });
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
    assert.equal(sfw.publicTagContract.forbidden.includes('成人取向或身体性化关键词'), false, 'SFW 不再携带成人词汇硬禁止项');
    assert.equal(sfw.publicTagContract.forbidden.includes('未成年人'), true);
    assert.equal(sfw.publicTagContract.forbidden.includes('非自愿或胁迫'), true);
    assert.equal(nsfw.publicTagContract.allowedTagCategories.includes('成年人明确自愿的全尺度性偏好、身体偏好或成人玩法公开资料'), true);
    assert.equal(Object.hasOwn(nsfw.publicTagContract, 'examples'), false, '开放标签不应由固定示例词库限定。');
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
    assert.equal(sfw.ok, true, 'SFW 不再把成年人成人词汇当作拒绝理由');
    assert.deepEqual(sfw.candidate.公开资料.生活方式标签, ['翘臀']);
    assert.equal(JSON.stringify(sfwMessages).includes('SFW 输出合同'), true);
    assert.equal(JSON.stringify(sfwMessages).includes('日常社交尺度'), true);
    assert.equal(JSON.stringify(sfwMessages).includes('NSFW 输出合同'), false);
    for (const requiredField of ['成人验证', '仅好友资料', '隐藏资料', '实际年龄', '私人备注', '拒绝阈值', '与玩家关系', '全局账号表现', 'NPC专属匹配度', '面基意愿']) {
        assert.equal(JSON.stringify(sfwMessages).includes(requiredField), true, `SFW 核心合同缺少 ${requiredField}`);
    }
    assert.equal(JSON.stringify(sfwMessages).includes('功能绑定提示词只能补充人物风格'), true);

    let nsfwMessages;
    const nsfw = await generateRecommendationCandidate({
        state: nsfwState(), settingsStore,
        llmClient: { async chat(request) { nsfwMessages = request.messages; return { text: JSON.stringify(adultTagCandidate) }; } },
    });
    assert.equal(nsfw.ok, true);
    assert.deepEqual(nsfw.candidate.公开资料.生活方式标签, ['翘臀']);
    assert.equal(JSON.stringify(nsfwMessages).includes('NSFW 输出合同'), true);
    assert.equal(JSON.stringify(nsfwMessages).includes('简介、寻找意图与四个标签字段'), true);
    assert.equal(JSON.stringify(nsfwMessages).includes('全尺度直白写明'), true);
    assert.equal(JSON.stringify(nsfwMessages).includes('不强制转场或淡出'), true);
    assert.equal(JSON.stringify(nsfwMessages).includes('不得叙述、安排或演绎线下性行为'), false);
    for (const requiredField of ['成人验证', '仅好友资料', '隐藏资料', '实际年龄', '私人备注', '拒绝阈值', '与玩家关系', '全局账号表现', 'NPC专属匹配度', '面基意愿']) {
        assert.equal(JSON.stringify(nsfwMessages).includes(requiredField), true, `NSFW 核心合同缺少 ${requiredField}`);
    }
    assert.equal(JSON.stringify(nsfwMessages).includes('功能绑定提示词只能补充人物风格'), true);
});

test('fast recommender treats a concise player target gender as a non-bypassable hard condition', async () => {
    const constrainedState = state();
    constrainedState.玩家.公开资料.性取向 = '女';
    const incompatible = adultCandidate();
    incompatible.公开资料.性别 = '男';
    incompatible.公开资料.性取向 = '双性恋';
    const result = await generateRecommendationCandidate({
        state: constrainedState, settingsStore,
        llmClient: { async chat() { return { text: JSON.stringify(incompatible) }; } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'recommendation_basic_compatibility_invalid');
});

test('fast recommender rejects an unknown candidate orientation when the player has an explicit orientation hard condition', async () => {
    const incomplete = adultCandidate();
    incomplete.公开资料.性取向 = '随缘';
    const result = await generateRecommendationCandidate({
        state: state(), settingsStore,
        llmClient: { async chat() { return { text: JSON.stringify(incomplete) }; } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'recommendation_basic_compatibility_invalid');
});

/* 安全控制台诊断寄存器接线（阶段：控制台详细报错） */

test('LLM 请求失败会在诊断寄存器登记 HTTP 状态与已脱敏摘要，且为一次性消费', async () => {
    const { YueLeMaLlmError } = await import('../../llm/openai-compatible-client.js');
    const { consumeRecommendationDiagnostics } = await import('../recommendation-diagnostics.js');
    const llmClient = {
        async chat() {
            throw new YueLeMaLlmError('SERVER_ERROR', '模型服务暂时不可用，请稍后重试。', {
                status: 502, retryable: true, bodyExcerpt: 'upstream gateway error',
            });
        },
    };
    const result = await generateRecommendationCandidate({ state: state(), settingsStore, llmClient });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SERVER_ERROR');
    const diagnostics = consumeRecommendationDiagnostics('recommendation_refresh', { code: 'SERVER_ERROR' });
    assert.ok(diagnostics, '失败必须登记诊断');
    assert.equal(diagnostics.stage, '请求快速模型');
    assert.equal(diagnostics.error.status, 502);
    assert.equal(diagnostics.error.name, 'YueLeMaLlmError');
    assert.equal(diagnostics.error.bodyExcerpt.includes('upstream gateway error'), true);
    assert.equal(JSON.stringify(diagnostics).includes('sk-'), false);
    assert.equal(consumeRecommendationDiagnostics('recommendation_refresh'), null, '诊断必须一次性消费');
});

test('解析失败登记响应形态描述；连接缺失登记绑定字段；成功路径不留残余诊断', async () => {
    const { consumeRecommendationDiagnostics } = await import('../recommendation-diagnostics.js');
    const invalidJson = await generateRecommendationCandidate({
        state: state(), settingsStore,
        llmClient: { async chat() { return { text: '这是一段自然语言，绝不是 JSON。' }; } },
    });
    assert.equal(invalidJson.code, 'recommendation_invalid_json');
    const parseDiagnostics = consumeRecommendationDiagnostics('recommendation_refresh', { code: 'recommendation_invalid_json' });
    assert.equal(parseDiagnostics.stage, '解析模型响应');
    assert.match(parseDiagnostics.expected, /JSON/u);
    assert.match(parseDiagnostics.actual, /响应共 \d+ 字符/u);

    const missing = await generateRecommendationCandidate({
        state: state(), settingsStore: { resolveFunction: () => ({}) },
        llmClient: { async chat() { return { text: '{}' }; } },
    });
    assert.equal(missing.code, 'recommendation_connection_missing');
    const missingDiagnostics = consumeRecommendationDiagnostics('recommendation_refresh', { code: 'recommendation_connection_missing' });
    assert.equal(missingDiagnostics.field, 'recommendation_refresh.connectionPreset');

    const success = await generateRecommendationCandidate({
        state: state(), settingsStore,
        llmClient: { async chat() { return { text: JSON.stringify(adultCandidate()) }; } },
    });
    assert.equal(success.ok, true);
    assert.equal(consumeRecommendationDiagnostics('recommendation_refresh'), null, '成功路径必须清空寄存器');
});

test('候选校验失败只登记字段路径与原因，不携带隐藏层字段值', async () => {
    const { consumeRecommendationDiagnostics } = await import('../recommendation-diagnostics.js');
    const invalid = adultCandidate();
    invalid.隐藏资料.实际年龄 = 16;
    const result = await generateRecommendationCandidate({
        state: state(), settingsStore,
        llmClient: { async chat() { return { text: JSON.stringify(invalid) }; } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, '隐藏资料.实际年龄:integer_out_of_range');
    const diagnostics = consumeRecommendationDiagnostics('recommendation_refresh', { code: result.code });
    assert.equal(diagnostics.stage, '候选结构与成年人校验');
    assert.equal(diagnostics.field, '隐藏资料.实际年龄');
    assert.match(diagnostics.actual, /integer_out_of_range/u);
    assert.equal(JSON.stringify(diagnostics).includes('16'), false, '诊断不得携带隐藏字段的具体值');
});
