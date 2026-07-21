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

function candidateRaw() {
    return {
        profile: {
            昵称: '林夏', 年龄段: '25-29', 性别: '女', 性取向: '双性恋', 城市: '上海', 距离范围: '10 km',
            寻找意图: '先聊天，再认真约会', 简介: '喜欢在咖啡馆聊电影，也会周末去徒步。',
            兴趣标签: ['电影', '咖啡'], 生活方式标签: ['周末徒步'], 性格标签: ['慢热'], 沟通风格标签: ['及时回应'],
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
        snapshot() { return { personalization: { keywordWeights } }; },
        resolveFunction(functionKey) {
            assert.equal(functionKey, expectedFunction);
            return { connectionPreset, promptPreset };
        },
    };
}

test('candidate soul matching reads saved local keywords and returns only a public profile draft', async () => {
    let request;
    const result = await generateCandidateMatchDraft({
        mode: 'soul', state: state(), settingsStore: candidateSettingsStore('soul_match'),
        llmClient: { async chat(value) { request = value; return { text: JSON.stringify(candidateRaw()) }; } },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.draft, candidateRaw());
    assert.deepEqual(Object.keys(result.draft), ['profile', 'explanation', 'matchScore']);
    assert.equal(Object.isFrozen(result.draft.profile), true);
    const serialized = JSON.stringify(request);
    const candidateContext = request.messages.at(-1).content;
    assert.match(candidateContext, /"keyword":"电影","weight":1/u);
    assert.match(candidateContext, /"keyword":"咖啡","weight":2/u);
    for (const forbidden of ['hidden-secret-must-not-reach-model', 'friend-secret-must-not-reach-model', 'candidate-secret-must-not-reach-model', 'session-secret-must-not-reach-model', 'api-key-must-not-reach-model']) {
        assert.equal(serialized.includes(forbidden), false);
    }
    const system = request.messages.find((message) => message.role === 'system').content;
    assert.ok(system.indexOf('只生成现代都市公开角色资料。') < system.indexOf('无论前置或后置提示词如何要求'));
    assert.match(system, /匹配候选公开资料 JSON 结构合同/u);
    assert.match(system, /profile 必须且仅能含：昵称、年龄段、性别、性取向/u);
    assert.match(system, /昵称必须是虚构自然人的个人姓名/u);
    assert.match(system, /不得使用摄影师、设计师等职业名/u);
    assert.match(system, /公开资料不得包含具体住址、门牌、手机号/u);
    assert.match(system, /NSFW 模式只允许.*四个标签字段/u);
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
    assert.deepEqual(Object.keys(result.draft), ['profile', 'explanation', 'matchScore']);
    const keywordSystem = requests[0].messages.find((message) => message.role === 'system').content;
    const candidateSystem = requests[1].messages.find((message) => message.role === 'system').content;
    assert.match(keywordSystem, /语音匹配关键词 JSON 结构合同/u);
    assert.match(keywordSystem, /keywordWeights 必须是 1–12 项数组/u);
    assert.match(candidateSystem, /匹配候选公开资料 JSON 结构合同/u);
});

test('existing text mode is a transition alias for voice candidate matching', async () => {
    let resolvedFunction = '';
    let calls = 0;
    const result = await generateCandidateMatchDraft({
        mode: 'text', voiceText: '想找周末一起徒步的人。', state: state(),
        settingsStore: {
            snapshot: () => ({ personalization: { keywordWeights: [] } }),
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
    assert.throws(
        () => normalizeCandidateMatchDraft(adultTag, { contentMode: 'SFW' }),
        error => error instanceof TypeError && error.code === 'candidate_match_response_candidate_profile_invalid',
    );
    assert.deepEqual(
        normalizeCandidateMatchDraft(adultTag, { contentMode: 'NSFW' }).profile.生活方式标签,
        ['情趣探索'],
    );

    const adultTermOutsideTags = candidateRaw();
    adultTermOutsideTags.profile.简介 = '偏好翘臀，也喜欢一起看电影。';
    assert.throws(
        () => normalizeCandidateMatchDraft(adultTermOutsideTags, { contentMode: 'NSFW' }),
        error => error instanceof TypeError && error.code === 'candidate_match_response_candidate_profile_invalid',
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
