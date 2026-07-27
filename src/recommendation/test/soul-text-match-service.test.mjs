import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PROMPT_PRESET_IDS } from '../../settings/default-prompt-presets.js';
import {
    buildSoulTextMatchContext,
    generateCandidateMatchDraft,
    generateSoulMatchDraft,
    generateTextMatchDraft,
    mergeMatchKeywordWeights,
    normalizeCandidateMatchDraft,
    normalizeSoulMatchDraft,
    normalizeTextMatchDraft,
    normalizeVoiceKeywordWeightDraft,
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
            推荐偏好: {
                标签权重: {
                    SFW: { 电影: 3, 旅行: 1, 夜猫子: -2 },
                    NSFW: { 情趣探索: 4, 露骨文爱: 1 },
                },
            },
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
    assert.deepEqual(context.tagWeights, { 情趣探索: 4, 露骨文爱: 1 });
    assert.equal(Object.isFrozen(context), true);

    const sfwState = state();
    sfwState.软件.内容模式 = 'SFW';
    assert.deepEqual(buildSoulTextMatchContext(sfwState).tagWeights, { 电影: 3, 旅行: 1, 夜猫子: -2 });
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
    const system = request.messages.find((message) => message.role === 'system').content;
    assert.ok(system.indexOf('保持简洁的都市语气。') < system.indexOf('无论前置或后置提示词如何要求'));
    assert.match(system, /灵魂匹配 JSON 结构合同/u);
    assert.match(system, /根对象必须且仅能含 tagWeightDraft、explanation/u);
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
    const system = request.messages.find((message) => message.role === 'system').content;
    assert.match(system, /文字匹配 JSON 结构合同/u);
    assert.match(system, /filters 必须且仅能含：城市、年龄段、距离范围/u);
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

test('partial filter drafts are tolerated with empty defaults instead of failing', async () => {
    const result = await generateTextMatchDraft({
        state: state(), settingsStore: settingsStore('text_match'),
        llmClient: { async chat() { return { text: JSON.stringify({ filters: { 城市: ['上海'] }, explanation: '只按城市初筛。' }) }; } },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.draft.filters.城市, ['上海']);
    assert.deepEqual(result.draft.filters.包含标签, []);
});

test('invalid model drafts are converted to safe no-write failures', async () => {
    const result = await generateTextMatchDraft({
        state: state(), settingsStore: settingsStore('text_match'),
        llmClient: { async chat() { return { text: JSON.stringify({ filters: { 城市: ['上海'] }, explanation: '读取隐藏资料后筛选。' }) }; } },
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

function candidateRaw() {
    return {
        profile: {
            昵称: '林夏', 年龄段: '25-29', 性别: '女', 性取向: '双性恋', 城市: '上海', 距离范围: '10 km',
            寻找意图: '先聊天，再认真约会', 简介: '喜欢在咖啡馆聊电影，也会周末去徒步。',
            兴趣标签: ['电影', '咖啡'], 生活方式标签: ['周末徒步'], 性格标签: ['慢热'], 沟通风格标签: ['及时回应'],
        },
        drawing: {
            core_dna: 'hair color{black hair}; eye color{brown eyes}; facial features{oval face, soft smile}; body type{slender adult woman}',
            outfit_dna: 'upper body clothing{cream knit sweater}; lower body clothing{navy pleated skirt}; footwear{brown ankle boots}',
        },
        explanation: '同城且兴趣与交流节奏接近，适合从轻松聊天开始认识。',
        matchScore: 91,
    };
}

function voiceKeywordRaw() {
    return { keywordWeights: [{ keyword: '电影', weight: 5 }, { keyword: '徒步', weight: 4 }] };
}

function candidateSettingsStore(expectedFunction, keywordWeights = [
    { keyword: '电影', weight: 1 }, { keyword: '咖啡', weight: 2 },
], promptPreset = { enabled: true, content: '只生成现代都市公开角色资料。' }) {
    return {
        snapshot() {
            return {
                personalization: {
                    keywordWeightsByMode: {
                        SFW: [],
                        NSFW: keywordWeights,
                    },
                },
            };
        },
        resolveFunction(functionKey) {
            assert.equal(functionKey, expectedFunction);
            return { connectionPreset, promptPreset };
        },
    };
}

test('candidate soul matching reads saved local keywords and returns a public profile plus drawing DNA draft', async () => {
    let request;
    const result = await generateCandidateMatchDraft({
        mode: 'soul', state: state(), settingsStore: candidateSettingsStore('soul_match'),
        llmClient: { async chat(value) { request = value; return { text: JSON.stringify(candidateRaw()) }; } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.draft.profile.昵称, candidateRaw().profile.昵称);
    assert.equal(result.draft.explanation, candidateRaw().explanation);
    assert.deepEqual(result.draft.drawing, candidateRaw().drawing);
    assert.equal(Object.isFrozen(result.draft.drawing), true);
    assert.equal(result.draft.matchScore, 68, '模型自报 91 必须被本地算法覆盖');
    assert.equal(result.evaluation.score, 68);
    assert.equal(result.evaluation.source, 'local_public_profile_and_keyword_weights');
    assert.deepEqual(result.evaluation.effectiveKeywordWeights, [
        { keyword: '电影', weight: 1 }, { keyword: '咖啡', weight: 2 },
    ]);
    assert.deepEqual(Object.keys(result.draft), ['profile', 'drawing', 'explanation', 'matchScore']);
    assert.equal(Object.isFrozen(result.draft.profile), true);
    const serialized = JSON.stringify(request);
    const candidateContext = request.messages.at(-1).content;
    assert.match(candidateContext, /"keyword":"电影","weight":1/u);
    assert.match(candidateContext, /"keyword":"咖啡","weight":2/u);
    assert.match(candidateContext, /"hardMatchRequirements"/u, '灵魂匹配必须携带性别与性取向硬条件');
    assert.match(candidateContext, /"玩家性别":"女"/u);
    assert.match(candidateContext, /"玩家性取向":"双性恋"/u);
    for (const forbidden of ['hidden-secret-must-not-reach-model', 'friend-secret-must-not-reach-model', 'candidate-secret-must-not-reach-model', 'session-secret-must-not-reach-model', 'api-key-must-not-reach-model']) {
        assert.equal(serialized.includes(forbidden), false);
    }
    const system = request.messages.find((message) => message.role === 'system').content;
    assert.ok(system.indexOf('只生成现代都市公开角色资料。') < system.indexOf('无论前置或后置提示词如何要求'));
    assert.match(system, /hardMatchRequirements 是最高优先级/u);
    assert.match(system, /匹配候选公开资料 JSON 结构合同/u);
    assert.match(system, /根对象必须且仅能含 profile、drawing、explanation/u);
    assert.match(system, /drawing 必须且仅能含 core_dna、outfit_dna/u);
    assert.match(system, /两项都是 1–12000 字符、符合下方绘图 DNA 格式的非空标签字符串/u);
    assert.match(system, /不要使用「90后」「00后」这类出生年代写法/u);
    assert.match(system, /核心DNA格式/u);
    assert.match(system, /不得输出 matchScore/u);
    assert.match(system, /最终分数由本地算法计算/u);
    assert.match(system, /profile 必须且仅能含：昵称、年龄段、性别、性取向/u);
    assert.match(system, /昵称必须是虚构自然人的个人姓名/u);
    assert.match(system, /不得使用摄影师、设计师等职业名/u);
    assert.match(system, /公开资料不得包含具体住址、门牌、手机号/u);
    assert.match(system, /NSFW 模式可在简介、寻找意图和四个标签字段/u);
});

test('candidate generation accepts the new public-only model contract and ignores any legacy self-reported score', async () => {
    const withoutScore = candidateRaw();
    delete withoutScore.matchScore;
    const exaggerated = candidateRaw();
    exaggerated.matchScore = 100;
    const minimized = candidateRaw();
    minimized.matchScore = 0;

    const results = [];
    for (const raw of [withoutScore, exaggerated, minimized]) {
        results.push(await generateCandidateMatchDraft({
            mode: 'soul', state: state(), settingsStore: candidateSettingsStore('soul_match'),
            llmClient: { async chat() { return { text: JSON.stringify(raw) }; } },
        }));
    }
    assert.deepEqual(results.map((result) => result.ok), [true, true, true]);
    assert.deepEqual(results.map((result) => result.draft.matchScore), [68, 68, 68]);
    assert.deepEqual(results.map((result) => result.evaluation.score), [68, 68, 68]);
});

test('candidate drawing DNA contract accepts the project DNA format but keeps credential/PII bans and preserves legacy matchScore', () => {
    const normalized = normalizeCandidateMatchDraft(candidateRaw());
    assert.deepEqual(normalized.drawing, candidateRaw().drawing);
    assert.equal(normalized.matchScore, 91);

    const missingDrawing = candidateRaw();
    delete missingDrawing.drawing;
    assert.throws(
        () => normalizeCandidateMatchDraft(missingDrawing),
        error => error instanceof TypeError && error.code === 'candidate_match_response_missing_field',
    );

    // Values a compliant real model produces under DRAWING_DNA_RULES: Chinese
    // category names, fullwidth punctuation, the spec's own "hidden color"
    // highlight-position tag, and mixed-language tags.
    const validValues = [
        '发色{black hair}; 挑染与混合色{hidden color, peekaboo color}; 刘海类型{no bangs}; 年龄外观{mid twenties}；「当前发型{同初始}」',
        '黑发, brown eyes',
        'a'.repeat(11_999) + '。',
    ];
    for (const value of validValues) {
        const raw = candidateRaw();
        raw.drawing.core_dna = value;
        assert.equal(normalizeCandidateMatchDraft(raw).drawing.core_dna, value, value.slice(0, 40));
    }

    const invalidValues = [
        '',
        'black hair, https://example.invalid/private.png',
        'black hair, cdn.example.com/portrait.png',
        'black hair, api_key: leaked-credential',
        'black hair, uid: npc_secret',
        'black hair, json patch path: /角色池/npc_secret',
        'black hair, private phone address',
        'black hair, hidden profile data',
        'a'.repeat(12_001),
    ];
    for (const value of invalidValues) {
        const raw = candidateRaw();
        raw.drawing.core_dna = value;
        assert.throws(
            () => normalizeCandidateMatchDraft(raw),
            error => error instanceof TypeError && error.code === 'candidate_match_response_drawing_invalid',
            value.slice(0, 80),
        );
    }

    const extraDrawingField = candidateRaw();
    extraDrawingField.drawing.uid = 'npc_secret';
    assert.throws(
        () => normalizeCandidateMatchDraft(extraDrawingField),
        error => error instanceof TypeError && error.code === 'candidate_match_response_sensitive_key',
    );
});

test('candidate generation isolates legacy built-in keyword prompts from the second-stage profile contract', async () => {
    const cases = [
        ['soul', 'soul_match', BUILTIN_PROMPT_PRESET_IDS.soulMatchSfw, '关键词权重草稿'],
        ['soul', 'soul_match', BUILTIN_PROMPT_PRESET_IDS.soulMatchNsfw, '关键词权重草稿'],
        ['voice', 'text_match', BUILTIN_PROMPT_PRESET_IDS.voiceMatchSfw, '筛选方向或关键词'],
        ['voice', 'text_match', BUILTIN_PROMPT_PRESET_IDS.voiceMatchNsfw, '筛选方向或关键词'],
    ];
    for (const [mode, functionKey, presetId, legacyInstruction] of cases) {
        const requests = [];
        const result = await generateCandidateMatchDraft({
            mode, voiceText: mode === 'voice' ? '周末想徒步，也想找能一起看电影的人。' : undefined,
            state: state(),
            settingsStore: candidateSettingsStore(functionKey, undefined, { id: presetId, enabled: true, content: legacyInstruction }),
            llmClient: { async chat(value) { requests.push(value); return { text: JSON.stringify(mode === 'voice' && requests.length === 1 ? voiceKeywordRaw() : candidateRaw()) }; } },
        });
        assert.equal(result.ok, true, presetId);
        const candidateRequest = requests.at(-1);
        const system = candidateRequest.messages.find((message) => message.role === 'system').content;
        assert.equal(system.includes(legacyInstruction), false, presetId);
        assert.match(system, /匹配候选公开资料 JSON 结构合同/u, presetId);
    }
});

test('candidate response parsing accepts one fenced or prose-wrapped JSON object but rejects parallel objects', async () => {
    const valid = JSON.stringify(candidateRaw());
    const responses = [valid, '前置说明：' + valid + '。后置说明。', '```json\n' + valid + '\n```'];
    for (const response of responses) {
        const result = await generateCandidateMatchDraft({
            mode: 'soul', state: state(), settingsStore: candidateSettingsStore('soul_match'),
            llmClient: { async chat() { return { text: response }; } },
        });
        assert.equal(result.ok, true, response.slice(0, 20));
    }
    const multiple = await generateCandidateMatchDraft({
        mode: 'soul', state: state(), settingsStore: candidateSettingsStore('soul_match'),
        llmClient: { async chat() { return { text: valid + '\n' + valid }; } },
    });
    assert.deepEqual(multiple, {
        ok: false,
        code: 'candidate_match_invalid_json',
        message: '模型没有返回可用的匹配角色草稿；当前状态未改变。',
    });
});
test('voice matching derives transient weights first, lets them override local weights, and never returns the voice input', async () => {
    const requests = [];
    const voiceText = '周末想徒步，也想找能一起看电影的人。';
    const result = await generateCandidateMatchDraft({
        mode: 'voice', voiceText, state: state(), settingsStore: candidateSettingsStore('text_match'),
        llmClient: { async chat(value) { requests.push(value); return { text: JSON.stringify(requests.length === 1 ? voiceKeywordRaw() : candidateRaw()) }; } },
    });
    assert.equal(result.ok, true);
    assert.equal(requests.length, 2);
    const keywordRequest = JSON.stringify(requests[0]);
    const candidateRequest = JSON.stringify(requests[1]);
    assert.equal(keywordRequest.includes(voiceText), true);
    assert.equal(candidateRequest.includes(voiceText), false);
    const candidateContext = requests[1].messages.at(-1).content;
    assert.match(candidateContext, /"keyword":"电影","weight":5/u);
    assert.match(candidateContext, /"keyword":"咖啡","weight":2/u);
    assert.match(candidateContext, /"keyword":"徒步","weight":4/u);
    assert.equal(JSON.stringify(result.draft).includes(voiceText), false);
    assert.deepEqual(Object.keys(result.draft), ['profile', 'drawing', 'explanation', 'matchScore']);
    assert.deepEqual(result.evaluation.effectiveKeywordWeights, [
        { keyword: '电影', weight: 5 }, { keyword: '咖啡', weight: 2 }, { keyword: '徒步', weight: 4 },
    ]);
    assert.equal(result.draft.matchScore, result.evaluation.score);
    // 描述匹配只按临时+本地关键词权重评分：候选 5 个公开标签中，
    // 电影(5)=100、咖啡(2)=70、其余 3 个未命中=50 → (100+70+50*3)/5 = 64。
    assert.equal(result.evaluation.source, 'local_keyword_weights_only');
    assert.equal(result.evaluation.score, 64);
    assert.equal(result.evaluation.keywordScore, 64);
    assert.equal(result.evaluation.heartCardScore, null, '描述匹配不得混入玩家资料心动卡评分');
    const keywordSystem = requests[0].messages.find((message) => message.role === 'system').content;
    const candidateSystem = requests[1].messages.find((message) => message.role === 'system').content;
    assert.match(keywordSystem, /描述匹配关键词 JSON 结构合同/u);
    assert.match(keywordSystem, /keywordWeights 必须是 1–12 项数组/u);
    assert.match(keywordSystem, /不考虑、不假设、不补充任何玩家个人资料/u);
    assert.match(candidateSystem, /匹配候选公开资料 JSON 结构合同/u);
    assert.match(candidateSystem, /纯关键词驱动/u);
    assert.doesNotMatch(candidateSystem, /hardMatchRequirements/u);
    assert.match(candidateContext, /"matchBasis":"keyword_weights_only"/u);
    for (const forbidden of ['playerPublicProfile', 'hardMatchRequirements', '性别', '性取向', '玩家性别', '候选人性别']) {
        assert.equal(candidateContext.includes(forbidden), false, `描述匹配上下文不得包含 ${forbidden}`);
    }
});

test('existing text mode is a transition alias for voice candidate matching', async () => {
    let resolvedFunction = '';
    let calls = 0;
    const result = await generateCandidateMatchDraft({
        mode: 'text', voiceText: '想找周末一起徒步的人。', state: state(),
        settingsStore: {
            snapshot: () => ({ personalization: { keywordWeightsByMode: { SFW: [], NSFW: [] } } }),
            resolveFunction(key) { resolvedFunction = key; return { connectionPreset, promptPreset: null }; },
        },
        llmClient: { async chat() { calls += 1; return { text: JSON.stringify(calls === 1 ? voiceKeywordRaw() : candidateRaw()) }; } },
    });
    assert.equal(result.ok, true);
    assert.equal(resolvedFunction, 'text_match');
    assert.equal(calls, 2);
});

test('voice keyword priority is deterministic and strict candidate codecs reject non-public or underage drafts', () => {
    assert.deepEqual(mergeMatchKeywordWeights(
        [{ keyword: 'Movie', weight: 1 }, { keyword: '咖啡', weight: 2 }],
        [{ keyword: 'movie', weight: 5 }, { keyword: '徒步', weight: 4 }],
    ), [{ keyword: 'movie', weight: 5 }, { keyword: '咖啡', weight: 2 }, { keyword: '徒步', weight: 4 }]);
    assert.throws(() => normalizeVoiceKeywordWeightDraft({ keywordWeights: [{ keyword: '电影', weight: 4, uid: 'nope' }] }), /sensitive_key/);
    assert.throws(() => normalizeCandidateMatchDraft({ ...candidateRaw(), uid: 'npc_1' }), /sensitive_key/);
    const underage = candidateRaw(); underage.profile.年龄段 = '17-19';
    assert.throws(() => normalizeCandidateMatchDraft(underage), /candidate_not_adult/);
    const privateDraft = candidateRaw(); privateDraft.explanation = '读取隐藏资料后推荐。';
    assert.throws(() => normalizeCandidateMatchDraft(privateDraft), /text_invalid/);
});

test('candidate draft and materialization contract reject occupational names, private addresses, and misplaced adult terms', () => {
    const valid = normalizeCandidateMatchDraft(candidateRaw());
    assert.equal(valid.profile.昵称, '林夏');

    const occupationalName = candidateRaw();
    occupationalName.profile.昵称 = '摄影师';
    assert.throws(
        () => normalizeCandidateMatchDraft(occupationalName),
        error => error instanceof TypeError && error.code === 'candidate_match_response_candidate_profile_invalid',
    );

    const privateAddress = candidateRaw();
    privateAddress.profile.简介 = '我住在具体住址南京西路100号。';
    assert.throws(
        () => normalizeCandidateMatchDraft(privateAddress, { contentMode: 'NSFW' }),
        error => error instanceof TypeError && error.code === 'candidate_match_response_candidate_profile_invalid',
    );

    const adultTag = candidateRaw();
    adultTag.profile.生活方式标签 = ['情趣探索'];
    assert.deepEqual(
        normalizeCandidateMatchDraft(adultTag, { contentMode: 'SFW' }).profile.生活方式标签,
        ['情趣探索'],
        'SFW 不再把成年人成人词汇当作拒绝理由',
    );
    assert.deepEqual(
        normalizeCandidateMatchDraft(adultTag, { contentMode: 'NSFW' }).profile.生活方式标签,
        ['情趣探索'],
    );

    const adultTermOutsideTags = candidateRaw();
    adultTermOutsideTags.profile.简介 = '偏好翘臀，也喜欢一起看电影。';
    assert.equal(
        normalizeCandidateMatchDraft(adultTermOutsideTags, { contentMode: 'NSFW' }).profile.简介,
        '偏好翘臀，也喜欢一起看电影。',
    );
});

test('candidate generation maps unsafe public profiles to the stable no-write response error', async () => {
    for (const mutate of [
        raw => { raw.profile.昵称 = '摄影师'; },
        raw => { raw.profile.简介 = '我住在具体住址南京西路100号。'; },
    ]) {
        const raw = candidateRaw();
        mutate(raw);
        const result = await generateCandidateMatchDraft({
            mode: 'soul', state: state(), settingsStore: candidateSettingsStore('soul_match'),
            llmClient: { async chat() { return { text: JSON.stringify(raw) }; } },
        });
        assert.deepEqual(result, {
            ok: false,
            code: 'candidate_match_response_invalid',
            message: '匹配角色草稿不符合公开资料安全格式；当前状态未改变。',
        });
    }
});

test('realistic dirty model output is normalized instead of rejected', async () => {
    const dirty = {
        profile: {
            昵称: '林晚晴',
            年龄段: '二十五到二十九岁',
            性别: '女',
            性取向: '双性恋',
            城市: '上海',
            距离范围: 10,
            寻找意图: '先聊天\n再见面',
            简介: '喜欢电影。\n周末常去徒步，也在规划自己的人生路径。',
            兴趣标签: '电影, 咖啡, 电影',
            生活方式标签: ['夜跑', '夜跑', '早起'],
            性格标签: ['慢热'],
            头像引用: 'https://cdn.example.invalid/avatar.png',
            年龄: 26,
        },
        drawing: {
            core_dna: '发色{black hair}; 挑染与混合色{hidden color}; 刘海类型{no bangs}; 刘海方向{none}; 发型{straight hair}; 头发结构{silky hair}; 发长{long hair}; 瞳色{brown eyes}; 年龄外观{mid twenties}；「当前发型{同初始}」',
            outfit_dna: '妆容{light makeup}; 上身内层{white t-shirt}; 下身内层{blue jeans}; 足部穿着{white sneakers}',
            style: 'photorealistic',
        },
        explanation: '这位候选人与你的兴趣高度契合，期待你们开启第一次会话。',
        matchScore: '88.5',
        note: '以上是生成结果',
    };
    const responseText = '好的，我来生成：\n```json\n' + JSON.stringify(dirty, null, 2) + '\n```\n希望你喜欢。';
    const result = await generateCandidateMatchDraft({
        mode: 'soul', state: state(), settingsStore: candidateSettingsStore('soul_match'),
        llmClient: { async chat() { return { text: responseText }; } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.draft.profile.昵称, '林晚晴');
    assert.equal(result.draft.profile.距离范围, '10');
    assert.equal(result.draft.profile.寻找意图, '先聊天 再见面');
    assert.equal(result.draft.profile.简介.includes('\n'), false);
    assert.deepEqual(result.draft.profile.兴趣标签, ['电影', '咖啡']);
    assert.deepEqual(result.draft.profile.生活方式标签, ['夜跑', '早起']);
    assert.deepEqual(result.draft.profile.沟通风格标签, []);
    assert.equal(result.draft.drawing.core_dna, dirty.drawing.core_dna);
    assert.equal(result.draft.matchScore, result.evaluation.score, '本地评分覆盖模型自报分数');
    const serializedDraft = JSON.stringify(result.draft);
    assert.equal(serializedDraft.includes('cdn.example.invalid'), false, '未知头像字段必须被丢弃');
    assert.equal(serializedDraft.includes('photorealistic'), false, '未知绘图字段必须被丢弃');
});

test('explicit adult age bands in common real-model phrasings are accepted while non-adult bands stay rejected', () => {
    for (const 年龄段 of ['25-29', '28岁', '18+', '已成年', '二十五岁', '二十五到二十九岁', '90后，26岁']) {
        const raw = candidateRaw();
        raw.profile.年龄段 = 年龄段;
        assert.equal(normalizeCandidateMatchDraft(raw).profile.年龄段, 年龄段, 年龄段);
    }
    for (const 年龄段 of ['00后', '十六岁', '成年人17岁', '青年', '十分神秘']) {
        const raw = candidateRaw();
        raw.profile.年龄段 = 年龄段;
        assert.throws(
            () => normalizeCandidateMatchDraft(raw),
            error => error instanceof TypeError && typeof error.code === 'string' && error.code.startsWith('candidate_match_response_'),
            年龄段,
        );
    }
});

test('benign dating-app wording is allowed while internal identifier references stay rejected', () => {
    const benign = candidateRaw();
    benign.explanation = '这位候选人与你的人生路径观念一致，期待你们的第一次会话。';
    assert.equal(normalizeCandidateMatchDraft(benign).explanation, benign.explanation);

    for (const explanation of ['会话UID chat_123 已建立。', '候选池已更新。', '通过 JSON Patch 写入。', '读取隐藏资料后推荐。']) {
        const raw = candidateRaw();
        raw.explanation = explanation;
        assert.throws(
            () => normalizeCandidateMatchDraft(raw),
            error => error instanceof TypeError && error.code === 'candidate_match_response_text_invalid',
            explanation,
        );
    }
});

test('voice keyword drafts tolerate string weights, float weights, duplicates, extras, and overflow', () => {
    const normalized = normalizeVoiceKeywordWeightDraft({
        keywordWeights: [
            { keyword: '电影', weight: '5' },
            { keyword: '徒步', weight: 3.6 },
            { keyword: '电影', weight: 1 },
            { keyword: '咖啡', weight: 2, confidence: 0.9 },
        ],
    });
    assert.deepEqual(normalized.keywordWeights, [
        { keyword: '电影', weight: 5 }, { keyword: '徒步', weight: 4 }, { keyword: '咖啡', weight: 2 },
    ]);

    const overflow = normalizeVoiceKeywordWeightDraft({
        keywordWeights: Array.from({ length: 14 }, (_, index) => ({ keyword: `关键词${index}`, weight: 1 })),
    });
    assert.equal(overflow.keywordWeights.length, 12);

    assert.throws(
        () => normalizeVoiceKeywordWeightDraft({ keywordWeights: [{ keyword: '电影', weight: '很高' }] }),
        /keyword_weights_invalid/,
    );
    assert.throws(
        () => normalizeVoiceKeywordWeightDraft({ keywordWeights: [{ keyword: '电影', weight: 7 }] }),
        /keyword_weights_invalid/,
    );
});

test('soul preference drafts tolerate fenced output, string weights, and benign extra fields', async () => {
    const fenced = '```json\n' + JSON.stringify({
        tagWeightDraft: [{ tag: '电影', weight: '4' }, { tag: '电影', weight: 1 }, { tag: '慢热', weight: 2.4 }],
        explanation: '更重视共同兴趣。',
        notes: '补充说明',
    }) + '\n```';
    const result = await generateSoulMatchDraft({
        state: state(), settingsStore: settingsStore('soul_match'),
        llmClient: { async chat() { return { text: fenced }; } },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.draft.tagWeightDraft, [{ tag: '电影', weight: 4 }, { tag: '慢热', weight: 2 }]);
});

test('long drawing-DNA responses within the shared 20k budget are accepted', async () => {
    const raw = candidateRaw();
    raw.drawing.core_dna = 'black hair, ' + 'long hair, straight hair, '.repeat(400) + 'brown eyes';
    assert.ok(JSON.stringify(raw).length > 8_000, '样本必须超过旧 8k 上限');
    const result = await generateCandidateMatchDraft({
        mode: 'soul', state: state(), settingsStore: candidateSettingsStore('soul_match'),
        llmClient: { async chat() { return { text: JSON.stringify(raw) }; } },
    });
    assert.equal(result.ok, true);
});

test('candidate match rejects missing voice text or unavailable local preferences before model calls', async () => {
    let calls = 0;
    const llmClient = { async chat() { calls += 1; return { text: '{}' }; } };
    const missingVoice = await generateCandidateMatchDraft({ mode: 'voice', state: state(), settingsStore: candidateSettingsStore('text_match'), llmClient });
    assert.deepEqual(missingVoice, { ok: false, code: 'candidate_match_voice_text_invalid', message: '请输入 1–800 个字符的匹配描述。' });
    const missingLocal = await generateCandidateMatchDraft({
        mode: 'soul', state: state(), settingsStore: { resolveFunction: () => ({ connectionPreset, promptPreset: null }) }, llmClient,
    });
    assert.deepEqual(missingLocal, { ok: false, code: 'candidate_match_local_preferences_unavailable', message: '本地个性化关键词暂不可用。' });
    assert.equal(calls, 0);
});

test('candidate generation rejects an incompatible gender before exposing a draft', async () => {
    const constrainedState = state();
    constrainedState.玩家.公开资料.性别 = '男';
    constrainedState.玩家.公开资料.性取向 = '异性恋';
    const incompatible = candidateRaw();
    incompatible.profile.性别 = '男';
    incompatible.profile.性取向 = '双性恋';
    const result = await generateCandidateMatchDraft({
        mode: 'soul', state: constrainedState, settingsStore: candidateSettingsStore('soul_match'),
        llmClient: { async chat() { return { text: JSON.stringify(incompatible) }; } },
    });
    assert.deepEqual(result, {
        ok: false,
        code: 'candidate_match_basic_compatibility_invalid',
        message: '模型返回的角色不符合性别或性取向硬条件；当前状态未改变。',
    });
});

test('描述匹配纯关键词驱动：不注入玩家资料或性别硬条件，也不因性别与玩家资料不符而拒绝', async () => {
    const requests = [];
    const voiceText = '想要温柔爱看电影的女性。';
    const differentGender = candidateRaw();
    differentGender.profile.性别 = '男';
    differentGender.profile.性取向 = '双性恋';
    // 玩家资料是明确的男性异性恋；描述匹配必须无视这些资料条件。
    const constrainedState = state();
    constrainedState.玩家.公开资料.性别 = '男';
    constrainedState.玩家.公开资料.性取向 = '异性恋';
    const result = await generateCandidateMatchDraft({
        mode: 'voice', voiceText, state: constrainedState, settingsStore: candidateSettingsStore('text_match'),
        llmClient: { async chat(value) { requests.push(value); return { text: JSON.stringify(requests.length === 1 ? voiceKeywordRaw() : differentGender) }; } },
    });
    assert.equal(requests.length, 2);
    const keywordUser = requests[0].messages.at(-1).content;
    const candidateSystem = requests[1].messages.find((message) => message.role === 'system').content;
    const candidateContext = requests[1].messages.at(-1).content;
    assert.equal(keywordUser.includes(voiceText), true, '描述原文只进入关键词提取阶段');
    assert.equal(candidateContext.includes(voiceText), false);
    for (const forbidden of ['playerPublicProfile', 'hardMatchRequirements', '性别', '性取向', '异性恋', '玩家']) {
        assert.equal(candidateContext.includes(forbidden), false, `描述匹配候选上下文不得包含 ${forbidden}`);
    }
    assert.match(candidateContext, /"matchBasis":"keyword_weights_only"/u);
    assert.match(candidateContext, /"keywordWeights"/u);
    assert.match(candidateSystem, /纯关键词驱动/u);
    assert.match(candidateSystem, /唯一匹配依据/u);
    assert.doesNotMatch(candidateSystem, /hardMatchRequirements/u);
    assert.equal(result.ok, true, '描述匹配只按关键词权重产出结果，不做性别/性取向筛除');
    assert.equal(result.draft.profile.性别, '男');
    assert.equal(result.evaluation.source, 'local_keyword_weights_only');
    assert.equal(result.evaluation.heartCardScore, null);
});

test('描述匹配仍强制成年与公开资料安全校验', async () => {
    const underage = candidateRaw();
    underage.profile.年龄段 = '17-19';
    let calls = 0;
    const result = await generateCandidateMatchDraft({
        mode: 'voice', voiceText: '想找爱看电影的人。', state: state(), settingsStore: candidateSettingsStore('text_match'),
        llmClient: { async chat() { calls += 1; return { text: JSON.stringify(calls === 1 ? voiceKeywordRaw() : underage) }; } },
    });
    assert.deepEqual(result, {
        ok: false,
        code: 'candidate_match_response_invalid',
        message: '匹配角色草稿不符合公开资料安全格式；当前状态未改变。',
    });
});

test('candidate generation rejects an unknown candidate orientation when player public orientation is explicit', async () => {
    const incomplete = candidateRaw();
    incomplete.profile.性取向 = '随缘';
    const result = await generateCandidateMatchDraft({
        mode: 'soul', state: state(), settingsStore: candidateSettingsStore('soul_match'),
        llmClient: { async chat() { return { text: JSON.stringify(incomplete) }; } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'candidate_match_basic_compatibility_invalid');
});

/* 安全控制台诊断寄存器接线（阶段：控制台详细报错） */

test('候选匹配的 LLM 失败按阶段登记 HTTP 状态与摘要，成功路径清空寄存器', async () => {
    const { YueLeMaLlmError } = await import('../../llm/openai-compatible-client.js');
    const { consumeRecommendationDiagnostics } = await import('../recommendation-diagnostics.js');
    const failing = {
        async chat() {
            throw new YueLeMaLlmError('RATE_LIMITED', '接口请求过于频繁，请稍后重试。', {
                status: 429, retryable: true, bodyExcerpt: 'rate limit exceeded',
            });
        },
    };
    const soulFailure = await generateCandidateMatchDraft({
        mode: 'soul', state: state(), settingsStore: candidateSettingsStore('soul_match'), llmClient: failing,
    });
    assert.equal(soulFailure.ok, false);
    assert.equal(soulFailure.code, 'RATE_LIMITED');
    const soulDiagnostics = consumeRecommendationDiagnostics('candidate_match', { code: 'RATE_LIMITED' });
    assert.equal(soulDiagnostics.stage, '候选资料生成');
    assert.equal(soulDiagnostics.error.status, 429);
    assert.equal(soulDiagnostics.error.bodyExcerpt.includes('rate limit exceeded'), true);
    assert.equal(soulDiagnostics.hint, '该错误可重试');

    const voiceFailure = await generateCandidateMatchDraft({
        mode: 'voice', voiceText: '想遇到喜欢电影的人',
        state: state(), settingsStore: candidateSettingsStore('text_match'), llmClient: failing,
    });
    assert.equal(voiceFailure.ok, false);
    const voiceDiagnostics = consumeRecommendationDiagnostics('candidate_match', { code: 'RATE_LIMITED' });
    assert.equal(voiceDiagnostics.stage, '第一阶段：描述关键词提取');

    const success = await generateCandidateMatchDraft({
        mode: 'soul', state: state(), settingsStore: candidateSettingsStore('soul_match'),
        llmClient: { async chat() { return { text: JSON.stringify(candidateRaw()) }; } },
    });
    assert.equal(success.ok, true);
    assert.equal(consumeRecommendationDiagnostics('candidate_match'), null, '成功路径必须清空寄存器');
});

test('两阶段各自的解析失败与硬条件失败登记可定位的阶段与不合规点', async () => {
    const { consumeRecommendationDiagnostics } = await import('../recommendation-diagnostics.js');
    const proseLlm = { async chat() { return { text: '抱歉，我只想聊聊天。' }; } };
    const stageOne = await generateCandidateMatchDraft({
        mode: 'voice', voiceText: '想遇到喜欢电影的人',
        state: state(), settingsStore: candidateSettingsStore('text_match'), llmClient: proseLlm,
    });
    assert.equal(stageOne.code, 'candidate_match_invalid_json');
    const stageOneDiagnostics = consumeRecommendationDiagnostics('candidate_match', { code: 'candidate_match_invalid_json' });
    assert.equal(stageOneDiagnostics.stage, '第一阶段：描述关键词提取（解析响应）');
    assert.match(stageOneDiagnostics.expected, /keywordWeights/u);
    assert.match(stageOneDiagnostics.actual, /响应共 \d+ 字符/u);

    let calls = 0;
    const stageTwoLlm = {
        async chat() {
            calls += 1;
            if (calls === 1) return { text: JSON.stringify(voiceKeywordRaw()) };
            return { text: '第二阶段返回了散文。' };
        },
    };
    const stageTwo = await generateCandidateMatchDraft({
        mode: 'voice', voiceText: '想遇到喜欢电影的人',
        state: state(), settingsStore: candidateSettingsStore('text_match'), llmClient: stageTwoLlm,
    });
    assert.equal(stageTwo.code, 'candidate_match_invalid_json');
    const stageTwoDiagnostics = consumeRecommendationDiagnostics('candidate_match', { code: 'candidate_match_invalid_json' });
    assert.equal(stageTwoDiagnostics.stage, '第二阶段：候选资料生成（解析响应）');

    const incompatible = candidateRaw();
    incompatible.profile.性取向 = '异性恋';
    incompatible.profile.性别 = '女';
    const hardConditionState = state();
    hardConditionState.玩家.公开资料.性别 = '女';
    hardConditionState.玩家.公开资料.性取向 = '异性恋';
    const hardCondition = await generateCandidateMatchDraft({
        mode: 'soul', state: hardConditionState, settingsStore: candidateSettingsStore('soul_match'),
        llmClient: { async chat() { return { text: JSON.stringify(incompatible) }; } },
    });
    assert.equal(hardCondition.code, 'candidate_match_basic_compatibility_invalid');
    const hardConditionDiagnostics = consumeRecommendationDiagnostics('candidate_match', { code: 'candidate_match_basic_compatibility_invalid' });
    assert.equal(hardConditionDiagnostics.stage, '本地硬条件校验');
    assert.match(hardConditionDiagnostics.field, /profile\.性别/u);
});

test('草稿校验失败与连接缺失都登记诊断；灵魂/文字草稿服务同样接线', async () => {
    const { consumeRecommendationDiagnostics } = await import('../recommendation-diagnostics.js');
    const badDraft = candidateRaw();
    badDraft.profile.昵称 = '摄影师';
    const invalidDraft = await generateCandidateMatchDraft({
        mode: 'soul', state: state(), settingsStore: candidateSettingsStore('soul_match'),
        llmClient: { async chat() { return { text: JSON.stringify(badDraft) }; } },
    });
    assert.equal(invalidDraft.code, 'candidate_match_response_invalid');
    const invalidDraftDiagnostics = consumeRecommendationDiagnostics('candidate_match', { code: 'candidate_match_response_invalid' });
    assert.match(invalidDraftDiagnostics.stage, /草稿校验/u);
    assert.match(invalidDraftDiagnostics.actual, /校验未通过/u);

    const missingConnection = await generateCandidateMatchDraft({
        mode: 'soul', state: state(),
        settingsStore: {
            snapshot: () => ({ personalization: { keywordWeightsByMode: { SFW: [], NSFW: [] } } }),
            resolveFunction: () => ({ connectionPreset: null, promptPreset: null }),
        },
        llmClient: { async chat() { return { text: '{}' }; } },
    });
    assert.equal(missingConnection.code, 'candidate_match_connection_missing');
    const missingDiagnostics = consumeRecommendationDiagnostics('candidate_match', { code: 'candidate_match_connection_missing' });
    assert.equal(missingDiagnostics.field, 'soul_match.connectionPreset');

    const soulDraftFailure = await generateSoulMatchDraft({
        state: state(), settingsStore: settingsStore('soul_match'),
        llmClient: { async chat() { return { text: '不是 JSON 的回答' }; } },
    });
    assert.equal(soulDraftFailure.code, 'soul_match_invalid_json');
    const soulDraftDiagnostics = consumeRecommendationDiagnostics('soul_match_draft', { code: 'soul_match_invalid_json' });
    assert.equal(soulDraftDiagnostics.stage, '解析模型响应');

    const textDraftFailure = await generateTextMatchDraft({
        state: state(), settingsStore: settingsStore('text_match'),
        llmClient: { async chat() { return { text: JSON.stringify({ filters: { 城市: ['上海'] }, explanation: '读取隐藏资料后筛选。' }) }; } },
    });
    assert.equal(textDraftFailure.code, 'text_match_response_invalid');
    const textDraftDiagnostics = consumeRecommendationDiagnostics('text_match_draft', { code: 'text_match_response_invalid' });
    assert.match(textDraftDiagnostics.actual, /text_match_response_/u);
});
