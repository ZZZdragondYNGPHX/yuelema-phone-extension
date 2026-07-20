import test from 'node:test';
import assert from 'node:assert/strict';
import { createActionBridge } from '../../action-bridge.js';

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
        软件: { 内容模式: 'SFW', 关于软件点击数: 0 },
        玩家: { 成人验证: true, 公开资料: {}, 推荐偏好: { 标签权重: {} } },
        角色池: {},
        推荐: {
            当前队列: ['npc_ava'],
            临时候选池: {
                npc_ava: {
                    成人验证: true,
                    公开资料: { 昵称: '艾娃' },
                    隐藏资料: { 实际年龄: 24, 私人备注: 'not visible' },
                    与玩家关系: { 状态: '陌生', 数值: 0 },
                },
            },
            冷却角色UID: [],
            收藏角色UID: [],
            不喜欢角色UID: [],
            拉黑角色UID: [],
        },
    };
}

function recommendationState() {
    const current = state();
    current.系统 = { UID计数器: { 角色: 12 } };
    current.玩家 = {
        公开资料: { 昵称: '玩家', 年龄段: '成年人', 性别: '男', 性取向: '异性恋', 城市: '上海', 距离范围: '不限', 寻找意图: '聊天', 简介: '公开简介', 兴趣标签: ['电影'], 生活方式标签: [], 性格标签: [], 沟通风格标签: [] },
        隐藏资料: { 私人备注: '不得发送给快速模型' },
        仅好友资料: { 关系状态: '不得发送给快速模型' },
        推荐偏好: { 标签权重: { 电影: 2 } },
    };
    return current;
}

const connectionPreset = { id: 'fast', name: 'Fast', url: 'https://example.invalid/v1', model: 'quick', temperature: 0.7, maxTokens: 800, timeoutMs: 30_000 };
const settingsStore = { resolveFunction: () => ({ connectionPreset, promptPreset: { enabled: true, content: '保持轻快、真实的都市语气。' } }) };

function resolvePatchParent(root, pointer) {
    const segments = pointer.split('/').slice(1).map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
    const key = segments.pop();
    let node = root;
    for (const segment of segments) node = node[segment];
    return { node, key };
}

function applyJsonPatch(state, patch) {
    for (const operation of patch) {
        const { node, key } = resolvePatchParent(state, operation.path);
        if (operation.op === 'remove') {
            if (Array.isArray(node)) node.splice(Number(key), 1); else delete node[key];
        } else if (operation.op === 'move') {
            const source = resolvePatchParent(state, operation.from);
            const value = source.node[source.key];
            if (Array.isArray(source.node)) source.node.splice(Number(source.key), 1); else delete source.node[source.key];
            if (Array.isArray(node) && key === '-') node.push(value); else node[key] = value;
        } else if (Array.isArray(node) && key === '-') {
            node.push(operation.value);
        } else {
            node[key] = operation.value;
        }
    }
}

function createMvu({ deferredParse = false, initialState = state() } = {}) {
    const calls = [];
    let releaseParse;
    const parsePromise = deferredParse ? new Promise(resolve => { releaseParse = resolve; }) : null;
    const data = { stat_data: initialState };
    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'variable_update_ended' },
        getMvuData(scope) { calls.push(['get', scope]); return data; },
        async parseMessage(raw, oldData) {
            calls.push(['parse', raw, oldData]);
            if (parsePromise) await parsePromise;
            const next = structuredClone(oldData);
            const encoded = raw.match(/<JSONPatch>([\s\S]+)<\/JSONPatch>/u)?.[1];
            if (encoded) applyJsonPatch(next.stat_data, JSON.parse(encoded));
            return next;
        },
        async replaceMvuData(nextData, scope) { calls.push(['replace', nextData, scope]); },
    };
    return { mvu, calls, data, releaseParse: () => releaseParse?.() };
}

test('favorite action is built and committed only through the official MVU pipeline', async () => {
    const { mvu, calls } = createMvu();
    const emitted = [];
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null },
        mvu,
        eventEmit: async (...args) => { emitted.push(args); },
    });

    const result = await bridge.runMvuAction('favorite', 'npc_ava');
    assert.equal(result.ok, true);
    assert.equal(calls.filter(([name]) => name === 'replace').length, 1);
    assert.equal(emitted.length, 1);
    const update = calls.find(([name]) => name === 'parse')[1];
    assert.match(update, /^<UpdateVariable><JSONPatch>/u);
    assert.match(update, /"op":"move"/u);
    assert.match(update, /收藏角色UID/u);
});

test('喜欢和不喜欢只在 MVU 写入成功后同步公开标签到本地个性化权重', async () => {
    const initialState = state();
    initialState.系统 = { UID计数器: { 会话: 0 } };
    initialState.会话 = {};
    initialState.推荐.临时候选池.npc_ava = adultCandidate();
    initialState.推荐.临时候选池.npc_ava.公开资料 = {
        昵称: '艾娃',
        兴趣标签: ['电影', '摄影'],
        生活方式标签: ['夜猫子'],
        性格标签: ['直接'],
        沟通风格标签: ['慢热'],
    };
    const { mvu } = createMvu({ initialState });
    const deltas = [];
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null },
        mvu,
        eventEmit: async () => {},
        settingsStore: {
            applyPersonalizationKeywordWeightDelta(tags, delta) {
                deltas.push([tags, delta]);
            },
        },
    });

    const liked = await bridge.runMvuAction('like', 'npc_ava');
    assert.equal(liked.ok, true);
    assert.deepEqual(deltas, [[['电影', '摄影', '夜猫子', '直接', '慢热'], 3]]);

    const disliked = await bridge.runMvuAction('dislike', 'npc_ava');
    assert.equal(disliked.ok, true);
    assert.deepEqual(deltas, [
        [['电影', '摄影', '夜猫子', '直接', '慢热'], 3],
        [['电影', '摄影', '夜猫子', '直接', '慢热'], -3],
    ]);
});

test('SFW/NSFW 滑块通过受控 MVU 管线实际切换内容模式', async () => {
    const initialState = state();
    delete initialState.软件.关于软件点击数;
    const calls = [];
    const data = { stat_data: initialState };
    let persisted;
    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'variable_update_ended' },
        getMvuData(scope) { calls.push(['get', scope]); return data; },
        async parseMessage(raw, oldData) {
            calls.push(['parse', raw, oldData]);
            const encoded = raw.match(/<JSONPatch>([\s\S]+)<\/JSONPatch>/u)?.[1];
            const patch = JSON.parse(encoded);
            const next = structuredClone(oldData);
            for (const operation of patch) {
                if (operation.path === '/软件/内容模式') next['stat_data']['软件']['内容模式'] = operation.value;
            }
            return next;
        },
        async replaceMvuData(nextData, scope) { calls.push(['replace', nextData, scope]); persisted = nextData; },
    };
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null },
        mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); },
    });

    const result = await bridge.runMvuAction('toggle_content_mode');

    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
    assert.equal(persisted['stat_data']['软件']['内容模式'], 'NSFW');
    assert.equal(Object.hasOwn(persisted['stat_data']['软件'], '关于软件点击数'), false, '本地五击解锁不应要求或写入旧计数字段');
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'parse', 'replace', 'event']);
});

test('duplicate controlled action is rejected while the first action is in flight', async () => {
    const { mvu, releaseParse } = createMvu({ deferredParse: true });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null },
        mvu,
        eventEmit: async () => {},
    });

    const first = bridge.runMvuAction('refresh', 'npc_ava');
    const duplicate = await bridge.runMvuAction('refresh', 'npc_ava');
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.code, 'ui_action_pending');
    releaseParse();
    assert.equal((await first).ok, true);
});

test('invalid generated candidate performs no MVU write and leaves recommendation state untouched', async () => {
    const initialState = recommendationState();
    const before = structuredClone(initialState);
    const { mvu, calls, data } = createMvu({ initialState });
    const emitted = [];
    const seededKeywords = [];
    const underage = adultCandidate();
    underage.隐藏资料.实际年龄 = 17;
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null },
        mvu,
        eventEmit: async (...args) => { emitted.push(args); },
        settingsStore: {
            ...settingsStore,
            ensurePersonalizationKeywordWeights(tags) { seededKeywords.push(tags); },
        },
        llmClient: { async chat() { return { text: JSON.stringify(underage) }; } },
    });

    const result = await bridge.runRecommendationRefresh('npc_ava');

    assert.equal(result.ok, false);
    assert.deepEqual(calls.map(([name]) => name), ['get']);
    assert.equal(calls.some(([name]) => name === 'parse' || name === 'replace'), false);
    assert.deepEqual(emitted, []);
    assert.deepEqual(seededKeywords, [], '模型或 MVU 事务未成功时不得提前污染本地关键词词库。');
    assert.deepEqual(data.stat_data, before);
});

test('successful generated recommendation runs get to parse to replace to event through the controlled boundary', async () => {
    const { mvu, calls } = createMvu({ initialState: recommendationState() });
    const seededKeywords = [];
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null },
        mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); },
        settingsStore: {
            ...settingsStore,
            ensurePersonalizationKeywordWeights(tags) { seededKeywords.push(tags); },
        },
        llmClient: { async chat() { return { text: JSON.stringify(adultCandidate()) }; } },
    });

    const result = await bridge.runRecommendationRefresh('npc_ava');

    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'get', 'parse', 'replace', 'event']);
    const wrappedPatch = calls.find(([name]) => name === 'parse')[1];
    assert.match(wrappedPatch, /^<UpdateVariable><JSONPatch>/u);
    assert.match(wrappedPatch, /npc_llm_13/u);
    assert.match(wrappedPatch, /冷却角色UID/u);
    assert.deepEqual(seededKeywords, [['电影', '夜猫子', '直接', '慢热']], '仅在官方写回成功后才以 0 权重收录新公开标签。');
});
test('user-authored adult character is registered only through the controlled MVU pipeline', async () => {
    const { mvu, calls } = createMvu({ initialState: recommendationState() });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null },
        mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); },
    });

    const result = await bridge.registerCharacter(adultCandidate());

    assert.equal(result.ok, true);
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'parse', 'replace', 'event']);
    const wrappedPatch = calls.find(([name]) => name === 'parse')[1];
    assert.match(wrappedPatch, /npc_custom_13/u);
    assert.match(wrappedPatch, /临时候选池/u);
});

test('invalid user-authored character never enters the MVU write pipeline', async () => {
    const initialState = recommendationState();
    const { mvu, calls, data } = createMvu({ initialState });
    const invalid = adultCandidate();
    invalid.隐藏资料.实际年龄 = 16;
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu, eventEmit: async () => {},
    });

    const result = await bridge.registerCharacter(invalid);
    assert.equal(result.ok, false);
    assert.deepEqual(calls.map(([name]) => name), ['get']);
    assert.deepEqual(data.stat_data, initialState);
});


test('private chat runs model validation before one official MVU write transaction', async () => {
    const initialState = recommendationState();
    initialState.角色池 = {
        npc_ava: {
            成人验证: true,
            公开资料: { 昵称: '艾娃' },
            仅好友资料: { 关系状态: '单身', 边界与偏好: '先确认意愿。' },
            隐藏资料: { 实际年龄: 24, 私人备注: '不得发送' },
            偏好与边界: '', 拒绝阈值: 0, 已读不回阈值: 0, 取消匹配阈值: 80, 拉黑阈值: 90,
            与玩家关系: { 状态: '已匹配', 全局账号表现: 60, NPC专属匹配度: 70, 好感: 20, 信任: 20, 戒备: 20, 面基意愿: 0 },
        },
    };
    initialState.会话 = { chat_1: { 对象UID: 'npc_ava', 状态: '已匹配', 最近消息: [], 长期摘要: '', 已确认边界: '', 已确认承诺: '' } };
    const { mvu, calls } = createMvu({ initialState });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); }, settingsStore,
        llmClient: { async chat() { return { text: JSON.stringify({ reply: '晚上好，聊聊周末？', relationship: { 好感: 1, 信任: 0, 戒备: -1, 面基意愿: 0 } }) }; } },
    });

    const result = await bridge.runPrivateChat({ sessionUid: 'chat_1', npcUid: 'npc_ava', playerMessage: '晚上好' });

    assert.equal(result.ok, true);
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'get', 'parse', 'replace', 'event']);
    const wrappedPatch = calls.find(([name]) => name === 'parse')[1];
    assert.match(wrappedPatch, /会话\/chat_1\/最近消息/u);
    assert.match(wrappedPatch, /与玩家关系\/好感/u);
    assert.doesNotMatch(wrappedPatch, /不得发送/u);
});


test('AI character completion and full authoring return memory drafts before any registration write', async () => {
    const initialState = recommendationState();
    initialState.软件 = { 内容模式: 'NSFW', 关于软件点击数: 0 };
    const { mvu, calls } = createMvu({ initialState });
    const requests = [];
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu, eventEmit: async () => {}, settingsStore,
        llmClient: { async chat(request) { requests.push(request); return { text: JSON.stringify(adultCandidate()) }; } },
    });

    const completion = await bridge.generateCharacterCompletionDraft({
        publicProfile: adultCandidate().公开资料,
        instruction: '补全为一名明确成年、适合先文字聊天的都市角色。',
    });
    assert.equal(completion.ok, true);
    assert.equal(completion.candidate.公开资料.头像引用, '');
    assert.deepEqual(calls, []);
    assert.doesNotMatch(JSON.stringify(requests[0].messages), /对临时失约敏感/u);

    const full = await bridge.generateCharacterAuthoringDraft({ creativeBrief: '创作一名明确成年的现代都市软件角色。' });
    assert.equal(full.ok, true);
    assert.equal(full.candidate.成人验证, true);
    assert.equal(full.candidate.公开资料.头像引用, '');
    assert.deepEqual(calls.map(([name]) => name), ['get']);
    assert.doesNotMatch(JSON.stringify(requests[1].messages), /公开简介|不得发送给快速模型/u);
    assert.equal(calls.some(([name]) => name === 'parse' || name === 'replace'), false);
});



function emptyRecommendationState() {
    const current = recommendationState();
    current.推荐.当前队列 = [];
    current.推荐.临时候选池 = {};
    return current;
}

test('initial fast-model candidate commits get to parse to replace to event only when the queue remains empty', async () => {
    const { mvu, calls } = createMvu({ initialState: emptyRecommendationState() });
    const seededKeywords = [];
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); },
        settingsStore: {
            ...settingsStore,
            ensurePersonalizationKeywordWeights(tags) { seededKeywords.push(tags); },
        },
        llmClient: { async chat() { return { text: JSON.stringify(adultCandidate()) }; } },
    });

    const result = await bridge.runRecommendationInitialCandidate();

    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'get', 'parse', 'replace', 'event']);
    const wrappedPatch = calls.find(([name]) => name === 'parse')[1];
    assert.match(wrappedPatch, /npc_llm_13/u);
    assert.doesNotMatch(wrappedPatch, /冷却角色UID/u);
    assert.deepEqual(seededKeywords, [['电影', '夜猫子', '直接', '慢热']]);
});

test('initial fast-model candidate performs zero writes on model rejection or a changed queue', async () => {
    const invalidState = emptyRecommendationState();
    const invalid = adultCandidate();
    invalid.隐藏资料.实际年龄 = 17;
    const invalidHarness = createMvu({ initialState: invalidState });
    const invalidBridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu: invalidHarness.mvu, eventEmit: async () => {}, settingsStore,
        llmClient: { async chat() { return { text: JSON.stringify(invalid) }; } },
    });
    const invalidResult = await invalidBridge.runRecommendationInitialCandidate();
    assert.equal(invalidResult.ok, false);
    assert.deepEqual(invalidHarness.calls.map(([name]) => name), ['get']);

    const changedState = emptyRecommendationState();
    const changedHarness = createMvu({ initialState: changedState });
    const changedBridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu: changedHarness.mvu, eventEmit: async () => {}, settingsStore,
        llmClient: { async chat() {
            changedHarness.data['stat_data'].推荐.当前队列.push('npc_ava');
            changedHarness.data['stat_data'].推荐.临时候选池.npc_ava = adultCandidate();
            return { text: JSON.stringify(adultCandidate()) };
        } },
    });
    const changedResult = await changedBridge.runRecommendationInitialCandidate();
    assert.equal(changedResult.ok, false);
    assert.equal(changedResult.code, 'recommendation_initial_queue_not_empty');
    assert.deepEqual(changedHarness.calls.map(([name]) => name), ['get', 'get']);
    assert.equal(changedHarness.calls.some(([name]) => name === 'parse' || name === 'replace'), false);
});



test('player public profile save uses only the MVU get to parse to replace to event pipeline', async () => {
    const initialState = recommendationState();
    initialState.软件.功能开关 = { 玩家已建档: false };
    initialState.玩家.成人验证 = true;
    const { mvu, calls } = createMvu({ initialState });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); },
    });
    const profile = {
        昵称: '新昵称', 头像引用: '', 年龄段: '25-29', 性别: '女', 性取向: '双性恋', 城市: '上海', 距离范围: '10 km', 寻找意图: '先聊天', 简介: '只是公开资料',
        兴趣标签: ['电影'], 生活方式标签: [], 性格标签: [], 沟通风格标签: [],
    };
    const result = await bridge.runSavePlayerPublicProfile(profile);
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'parse', 'replace', 'event']);
    const wrappedPatch = calls.find(([name]) => name === 'parse')[1];
    assert.match(wrappedPatch, /玩家\/公开资料\/昵称/u);
    assert.match(wrappedPatch, /玩家已建档/u);
    assert.doesNotMatch(wrappedPatch, /隐藏资料|实际年龄|replaceVariables|chat_metadata/u);
});

function groupDraftState() {
    const current = recommendationState();
    current.角色池 = { npc_group: adultCandidate() };
    current.群组 = {
        group_city: {
            主题: '城市夜谈', 描述: '仅浏览公开兴趣的成年人群组。',
            成员UID: ['npc_group'], 可发现角色UID: ['npc_group'],
        },
    };
    return current;
}

test('group and forum draft bridges read MVU once, use their dedicated bindings, and never write MVU state', async () => {
    const { mvu, calls } = createMvu({ initialState: groupDraftState() });
    const resolved = [];
    const requests = [];
    const groupSettings = {
        resolveFunction(kind) {
            resolved.push(kind);
            return { connectionPreset, promptPreset: { enabled: true, content: '仅使用公开资料。' } };
        },
    };
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu, eventEmit: async (...args) => { calls.push(['event', ...args]); },
        settingsStore: groupSettings,
        llmClient: { async chat(request) {
            requests.push(request);
            return { text: resolved.at(-1) === 'group_chat' ? '{"reply":"今晚有人想聊电影吗？"}' : '{"title":"周末城市夜谈","body":"欢迎分享公开的观影计划。"}' };
        } },
    });

    const groupResult = await bridge.generateGroupChatDraft({ groupUid: 'group_city', playerMessage: '今晚有人聊电影吗？' });
    const forumResult = await bridge.generateForumPostDraft({ groupUid: 'group_city', topic: '周末观影交流' });

    assert.deepEqual(resolved, ['group_chat', 'forum']);
    assert.equal(groupResult.ok, true);
    assert.equal(groupResult.draft.reply, '今晚有人想聊电影吗？');
    assert.equal(forumResult.ok, true);
    assert.equal(forumResult.draft.title, '周末城市夜谈');
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get']);
    assert.equal(calls.some(([name]) => ['parse', 'replace', 'event'].includes(name)), false);
    const userContextJson = requests.map((request) => request.messages.find((message) => message.role === 'user')?.content ?? '').join('\\n');
    assert.doesNotMatch(userContextJson, /不得发送给快速模型|对临时失约敏感|关系状态|npc_group|group_city|UID|JSONPatch|UpdateVariable/u);
});

test('group and forum draft bridge pending keys are isolated by feature and group UID', async () => {
    const { mvu } = createMvu({ initialState: groupDraftState() });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu, eventEmit: async () => {},
        settingsStore: { resolveFunction: () => ({ connectionPreset, promptPreset: { enabled: true, content: '' } }) },
        llmClient: { async chat() { await gate; return { text: '{"reply":"公开短消息"}' }; } },
    });
    const first = bridge.generateGroupChatDraft({ groupUid: 'group_city', playerMessage: '你好' });
    assert.equal(bridge.isPending('group_chat_draft', 'group_city'), true);
    const duplicate = await bridge.generateGroupChatDraft({ groupUid: 'group_city', playerMessage: '你好' });
    assert.equal(duplicate.code, 'ui_action_pending');
    assert.equal(bridge.isPending('forum_draft', 'group_city'), false);
    release();
    assert.equal((await first).ok, true);
});
test('candidate match draft reads through MVU but never commits a patch or event', async () => {
    const initialState = recommendationState();
    const { mvu, calls } = createMvu({ initialState });
    const requests = [];
    const candidateSettingsStore = {
        snapshot() { return { personalization: { keywordWeights: [{ keyword: '电影', weight: 3 }] } }; },
        resolveFunction(key) {
            assert.equal(key, 'soul_match');
            return { connectionPreset, promptPreset: { enabled: true, content: '仅生成成年人公开资料。' } };
        },
    };
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu, eventEmit: async (...args) => { calls.push(['event', ...args]); }, settingsStore: candidateSettingsStore,
        llmClient: { async chat(request) {
            requests.push(request);
            return { text: JSON.stringify({
                profile: {
                    昵称: '林夏', 年龄段: '25-29', 性别: '女', 性取向: '双性恋', 城市: '上海', 距离范围: '10 km',
                    寻找意图: '先聊天再认真约会', 简介: '喜欢电影和夜跑。', 兴趣标签: ['电影'], 生活方式标签: ['夜猫子'], 性格标签: ['慢热'], 沟通风格标签: ['及时回应'],
                }, explanation: '公开兴趣接近。', matchScore: 88,
            }) };
        } },
    });

    const result = await bridge.generateCandidateMatchDraft('soul');

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.draft.profile.昵称, '林夏');
    assert.deepEqual(calls.map(([name]) => name), ['get']);
    assert.equal(requests.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /UID|隐藏资料|关系分|阈值|private-key/u);
});

test('soul match creates an independent npc_match session and never promotes a favourite or queue candidate', async () => {
    const initialState = recommendationState();
    initialState.会话 = {};
    initialState.系统 = { UID计数器: { 角色: 12, 会话: 4 } };
    initialState.推荐.收藏角色UID = ['npc_ava'];
    const { mvu, calls } = createMvu({ initialState });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu, eventEmit: async (...args) => { calls.push(['event', ...args]); },
        settingsStore: {
            snapshot() { return { personalization: { keywordWeights: [{ keyword: '电影', weight: 3 }] } }; },
            resolveFunction(key) { assert.equal(key, 'soul_match'); return { connectionPreset, promptPreset: { enabled: true, content: '' } }; },
        },
        llmClient: { async chat() {
            return { text: JSON.stringify({
                profile: {
                    昵称: '林夏', 年龄段: '25-29', 性别: '女', 性取向: '双性恋', 城市: '上海', 距离范围: '10 km',
                    寻找意图: '先聊天再认真约会', 简介: '喜欢电影和夜跑。', 兴趣标签: ['电影'], 生活方式标签: ['夜猫子'], 性格标签: ['慢热'], 沟通风格标签: ['及时回应'],
                }, explanation: '公开兴趣接近。', matchScore: 88,
            }) };
        } },
    });

    const result = await bridge.runCandidateMatch('soul');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual([result.npcUid, result.sessionUid], ['npc_match_13', 'chat_5']);
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'get', 'parse', 'replace', 'event']);
    const wrappedPatch = calls.find(([name]) => name === 'parse')[1];
    assert.match(wrappedPatch, /角色池\/npc_match_13|角色池~1npc_match_13/u);
    assert.match(wrappedPatch, /会话\/chat_5|会话~1chat_5/u);
    assert.doesNotMatch(wrappedPatch, /收藏角色UID|当前队列|临时候选池\/npc_ava/u);
});

test('voice match first resolves transient voice keywords and then commits the same independent mutual-match session', async () => {
    const initialState = recommendationState();
    initialState.会话 = {};
    initialState.系统 = { UID计数器: { 角色: 5, 会话: 1 } };
    const { mvu, calls } = createMvu({ initialState });
    let modelCall = 0;
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu, eventEmit: async (...args) => { calls.push(['event', ...args]); },
        settingsStore: {
            snapshot() { return { personalization: { keywordWeights: [{ keyword: '电影', weight: 1 }] } }; },
            resolveFunction(key) { assert.equal(key, 'text_match'); return { connectionPreset, promptPreset: { enabled: true, content: '' } }; },
        },
        llmClient: { async chat() {
            modelCall += 1;
            if (modelCall === 1) return { text: '{"keywordWeights":[{"keyword":"逛展","weight":5}]}' };
            return { text: JSON.stringify({
                profile: {
                    昵称: '顾言', 年龄段: '26-31', 性别: '男', 性取向: '双性恋', 城市: '上海', 距离范围: '15 km',
                    寻找意图: '想认真认识一个人', 简介: '周末喜欢看展和散步。', 兴趣标签: ['逛展'], 生活方式标签: ['周末出行'], 性格标签: ['温和'], 沟通风格标签: ['认真倾听'],
                }, explanation: '本次语音关键词优先。', matchScore: 90,
            }) };
        } },
    });

    const result = await bridge.runCandidateMatch('voice', { voiceText: '想找愿意一起逛展、认真聊天的人。' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual([result.npcUid, result.sessionUid], ['npc_match_6', 'chat_2']);
    assert.equal(modelCall, 2, '语音匹配应先解析关键词，再生成候选人');
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'get', 'parse', 'replace', 'event']);
});
