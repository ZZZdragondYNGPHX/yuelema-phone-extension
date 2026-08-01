import test from 'node:test';
import assert from 'node:assert/strict';
import { YueLeMaLlmError } from '../../llm/openai-compatible-client.js';
import { buildPrivateChatContext, consumePrivateChatDiagnostics, generatePrivateChatReply, generatePrivateChatSummary } from '../private-chat-service.js';
import { buildPrivateChatPatch, validateControlledPatchAgainstState } from '../../mvu/controlled-patch.js';
import { createEmptyRelationshipNarrative } from '../../mvu/relationship-narrative.js';
import { bodyRelationshipEventIdForSource, createEmptyBodyRelationshipCandidate } from '../../mvu/body-relationship-candidate.js';
import { createEmptyNsfwConsent, grantNsfwConsent } from '../../mvu/nsfw-consent.js';

function state() {
    return {
        系统: { UID计数器: { 角色: 1, 会话: 1, 面基: 0 } },
        软件: { 内容模式: 'SFW', 关于软件点击数: 0 },
        玩家: {
            成人验证: true,
            公开资料: { 昵称: '玩家', 简介: '公开简介' },
            仅好友资料: { 关系状态: '单身', 边界与偏好: '先聊天再决定。' },
            隐藏资料: { 实际年龄: 24, 私人备注: '不得发送' },
        },
        角色池: {
            npc_adult: {
                成人验证: true,
                公开资料: { 昵称: '小满', 简介: '公开资料' },
                仅好友资料: { 关系状态: '开放关系', 边界与偏好: '先确认同意。' },
                隐藏资料: { 实际年龄: 28, 私人备注: '绝不泄露' },
                偏好与边界: '角色内部字段不得发送', 拒绝阈值: 20, 已读不回阈值: 55, 取消匹配阈值: 80, 拉黑阈值: 90,
                与玩家关系: { 状态: '已匹配', 全局账号表现: 60, NPC专属匹配度: 70, 好感: 30, 信任: 40, 戒备: 20, 面基意愿: 10 },
            },
            npc_other: {
                成人验证: true,
                公开资料: { 昵称: '周遥', 简介: '喜欢看展。' },
                仅好友资料: { 关系状态: '单身', 边界与偏好: '尊重彼此节奏。' },
                隐藏资料: { 实际年龄: 30, 私人备注: '不得发送的另一条备注' },
                与玩家关系: { 状态: '已匹配', 全局账号表现: 60, NPC专属匹配度: 65, 好感: 20, 信任: 20, 戒备: 10, 面基意愿: 10 },
            },
        },
        正文记忆: {
            npc_adult: '玩家与小满在线下见过一次，一起喝了咖啡。',
            npc_other: '玩家与周遥一起看过展览，分别时约定分享书单。',
        },
        正文关系候选: {
            npc_adult: createEmptyBodyRelationshipCandidate(),
            npc_other: createEmptyBodyRelationshipCandidate(),
        },
        关系叙事: {
            npc_adult: createEmptyRelationshipNarrative(),
            npc_other: createEmptyRelationshipNarrative(),
        },
        推荐: { 当前队列: [], 临时候选池: {}, 冷却角色UID: [], 收藏角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [] },
        会话: {
            chat_1: {
                对象UID: 'npc_adult', 状态: '已匹配',
                最近消息: [{ 消息UID: 'old', 发送者: '角色', 内容: '嗨', 时间: '', 层数: 1 }],
                对话层数: 1,
                总结: { 已总结消息UID: '', 总结序号: 0, 记录: [], 状态: '空闲', 失败原因: '', 目标总结UID: '', 尝试次数: 0 },
                已确认边界: '', 已确认承诺: '', NSFW同意: createEmptyNsfwConsent(),
            },
        },
        面基记录: {},
    };
}

function activeNsfwState({ scopes = ['成人话题'], turns = 3 } = {}) {
    const current = state();
    current.软件.内容模式 = 'NSFW';
    current.会话.chat_1.NSFW同意 = grantNsfwConsent(current.会话.chat_1.NSFW同意, { scopes, turns });
    return current;
}

function response() {
    return {
        replies: ['晚上好。', '先聊聊彼此的周末？'],
        relationship: { 好感: 2, 信任: 1, 戒备: -2, 面基意愿: 0 },
    };
}


function settingsStore() {
    return {
        resolveFunction(key) {
            assert.equal(key, 'chat');
            return {
                connectionPreset: { id: 'fast', url: 'https://example.test/v1', model: 'model' },
                promptPreset: { enabled: true, content: '保持简短。' },
            };
        },
    };
}

function summarySettingsStore() {
    return {
        getChatSummarySettings() { return { enabled: true, interval: 2, retryLimit: 1 }; },
        resolveFunction(key) {
            assert.equal(key, 'chat_summary');
            return {
                connectionPreset: { id: 'summary', url: 'https://example.test/v1', model: 'model' },
                promptPreset: { enabled: true, content: '只记录已经明确说过的内容。' },
            };
        },
    };
}

test('private chat context includes public + matched friends-only data, never hidden or internal fields', () => {
    const built = buildPrivateChatContext({ state: state(), sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好' });
    assert.equal(built.ok, true);
    const serialized = JSON.stringify(built.context);
    assert.match(serialized, /公开资料/);
    assert.match(serialized, /开放关系/);
    assert.doesNotMatch(serialized, /绝不泄露|不得发送|角色内部字段|实际年龄|私人备注/);
    assert.equal(built.context.recentMessages.length, 1);
    assert.equal(built.context.storyMemory.currentObjectMemory, '玩家与小满在线下见过一次，一起喝了咖啡。');
    assert.deepEqual(built.context.storyMemory.otherObjectMemories, [{
        objectLabel: '其他对象1',
        nickname: '周遥',
        memory: '玩家与周遥一起看过展览，分别时约定分享书单。',
    }]);
    assert.doesNotMatch(JSON.stringify(built.context.storyMemory), /npc_adult|npc_other/u);
});

test('private chat rejects a role without its dedicated story-memory slot', () => {
    const current = state();
    delete current.正文记忆.npc_adult;
    const built = buildPrivateChatContext({ state: current, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好' });
    assert.deepEqual(built, { ok: false, code: 'private_chat_story_memory_schema_outdated' });
});

test('private chat context carries all player public profile fields and normalizes missing values', () => {
    const current = state();
    current.玩家.公开资料 = {
        昵称: '玩家', 城市: '上海', 距离范围: '15 公里内', 寻找意图: '认真交往', 简介: '喜欢逛展和散步。',
        兴趣标签: ['摄影', '爵士'], 生活方式标签: ['早睡', '做饭'],
        性格标签: ['温和', '好奇'], 沟通风格标签: ['慢热', '真诚'],
    };
    const complete = buildPrivateChatContext({ state: current, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好' });
    assert.equal(complete.ok, true);
    assert.deepEqual(complete.context.playerPublicProfile, {
        昵称: '玩家', 年龄段: '', 性别: '', 性取向: '', 城市: '上海', 距离范围: '15 公里内', 寻找意图: '认真交往', 简介: '喜欢逛展和散步。',
        兴趣标签: ['摄影', '爵士'], 生活方式标签: ['早睡', '做饭'], 性格标签: ['温和', '好奇'], 沟通风格标签: ['慢热', '真诚'],
    });

    const missingState = state();
    missingState.玩家.公开资料 = { 昵称: '玩家' };
    const missing = buildPrivateChatContext({ state: missingState, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好' });
    assert.equal(missing.ok, true);
    assert.deepEqual(missing.context.playerPublicProfile, {
        昵称: '玩家', 年龄段: '', 性别: '', 性取向: '', 城市: '', 距离范围: '', 寻找意图: '', 简介: '',
        兴趣标签: [], 生活方式标签: [], 性格标签: [], 沟通风格标签: [],
    });
});

test('private chat transmits every player public-profile field and retains explicit omissions safely', () => {
    const current = state();
    Object.assign(current.玩家.公开资料, {
        城市: '杭州', 距离范围: '15 km', 寻找意图: '先聊天再约会', 简介: '周末喜欢逛书店和骑行。',
        兴趣标签: ['阅读', '骑行'], 生活方式标签: ['早睡'], 性格标签: ['慢热'], 沟通风格标签: ['喜欢长消息'],
    });
    const complete = buildPrivateChatContext({ state: current, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好' });
    assert.equal(complete.ok, true);
    assert.deepEqual(complete.context.playerPublicProfile, {
        昵称: '玩家', 年龄段: '', 性别: '', 性取向: '', 城市: '杭州', 距离范围: '15 km',
        寻找意图: '先聊天再约会', 简介: '周末喜欢逛书店和骑行。',
        兴趣标签: ['阅读', '骑行'], 生活方式标签: ['早睡'], 性格标签: ['慢热'], 沟通风格标签: ['喜欢长消息'],
    });

    delete current.玩家.公开资料.城市;
    current.玩家.公开资料.距离范围 = '   ';
    delete current.玩家.公开资料.寻找意图;
    current.玩家.公开资料.兴趣标签 = null;
    delete current.玩家.公开资料.生活方式标签;
    const omitted = buildPrivateChatContext({ state: current, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '继续聊' });
    assert.equal(omitted.ok, true);
    for (const field of ['城市', '距离范围', '寻找意图', '简介', '兴趣标签', '生活方式标签', '性格标签', '沟通风格标签']) {
        assert.equal(Object.hasOwn(omitted.context.playerPublicProfile, field), true);
    }
    assert.equal(omitted.context.playerPublicProfile.城市, '');
    assert.equal(omitted.context.playerPublicProfile.距离范围, '');
    assert.equal(omitted.context.playerPublicProfile.寻找意图, '');
    assert.deepEqual(omitted.context.playerPublicProfile.兴趣标签, []);
    assert.deepEqual(omitted.context.playerPublicProfile.生活方式标签, []);
});
test('private chat context sends full retained history when summaries are off, or records plus only pending messages when on', () => {
    const current = state();
    current.会话.chat_1.最近消息 = Array.from({ length: 30 }, (_, index) => ({
        消息UID: `m_${index + 1}`,
        发送者: index % 2 === 0 ? '玩家' : '角色',
        内容: `第${index + 1}层聊天`,
        时间: '',
        层数: index + 1,
    }));
    current.会话.chat_1.对话层数 = 30;
    current.会话.chat_1.总结 = {
        已总结消息UID: 'm_20', 总结序号: 1,
        记录: [{ 总结UID: 'summary_1', 起始消息UID: 'm_1', 结束消息UID: 'm_20', 起始层数: 1, 结束层数: 20, 内容: '前二十层已聊过周末安排。', 时间: '' }],
        状态: '成功', 失败原因: '', 目标总结UID: '', 尝试次数: 1,
    };

    const full = buildPrivateChatContext({ state: current, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '继续聊', summaryEnabled: false });
    assert.equal(full.ok, true);
    assert.equal(full.context.contextStrategy, 'full_retained_history');
    assert.equal(full.context.recentMessages.length, 30);
    assert.equal(Object.hasOwn(full.context, 'summaryRecords'), false);

    const summarized = buildPrivateChatContext({ state: current, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '继续聊', summaryEnabled: true });
    assert.equal(summarized.ok, true);
    assert.equal(summarized.context.contextStrategy, 'summary_records_plus_unsummarized_messages');
    assert.deepEqual(summarized.context.summaryRecords, [{ range: '第1-20层', content: '前二十层已聊过周末安排。' }]);
    assert.equal(summarized.context.unsummarizedMessages.length, 10);
    assert.equal(Object.hasOwn(summarized.context, 'recentMessages'), false);
});

test('private chat rejects unmatched, forged, underage and malformed messages before any model request', () => {
    const unmatched = state(); unmatched.会话.chat_1.状态 = '请求中';
    assert.equal(buildPrivateChatContext({ state: unmatched, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '你好' }).ok, false);
    const underage = state(); underage.角色池.npc_adult.隐藏资料.实际年龄 = 17;
    assert.equal(buildPrivateChatContext({ state: underage, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '你好' }).ok, false);
    assert.equal(buildPrivateChatContext({ state: state(), sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '<b>你好</b>' }).ok, false);
    assert.equal(buildPrivateChatContext({ state: state(), sessionUid: 'chat_1', npcUid: 'npc_other', playerMessage: '你好' }).ok, false);
});

test('player adulthood and protected pause/end gates reject before the model is called', async () => {
    for (const mutate of [
        (current) => { current.玩家.成人验证 = false; },
        (current) => { current.关系叙事.npc_adult.进程.边界暂停状态 = '暂停'; },
        (current) => { current.关系叙事.npc_adult.进程.关系结束状态 = '结束联系'; },
    ]) {
        const current = state();
        mutate(current);
        let modelCalls = 0;
        const result = await generatePrivateChatReply({
            state: current, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '你好', settingsStore: settingsStore(),
            llmClient: { async chat() { modelCalls += 1; return { text: JSON.stringify(response()) }; } },
        });
        assert.equal(result.ok, false);
        assert.equal(modelCalls, 0);
    }
});

test('only-SFW context exposes a stage-cropped current-object narrative and no internal progress fields', () => {
    const current = state();
    current.关系叙事.npc_adult.进程.边界暂停状态 = '仅SFW';
    const built = buildPrivateChatContext({ state: current, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '继续聊电影' });
    assert.equal(built.ok, true);
    assert.equal(built.context.onlySfw, true);
    assert.equal(built.context.sfwNarrative.stage, 'ordinary');
    const serialized = JSON.stringify(built.context);
    assert.doesNotMatch(serialized, /边界暂停状态|关系结束状态|冻结关系值|关系叙事|仅SFW/u);
});

test('SFW understanding context projects only the current role protected facts at the eligible stage', () => {
    const current = state();
    current.角色池.npc_adult.与玩家关系.友情值 = 59;
    current.关系叙事.npc_adult.人生底色.完整理解 = '当前对象的受限理解';
    current.关系叙事.npc_adult.未竟心愿.表层愿望 = '开一家夜间书店';
    current.关系叙事.npc_adult.未竟心愿.真实需要 = '被尊重地陪伴';
    current.关系叙事.npc_other.人生底色.完整理解 = '另一对象的绝密理解';
    const built = buildPrivateChatContext({ state: current, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '我愿意认真听你说' });
    assert.equal(built.ok, true);
    assert.equal(built.context.sfwNarrative.stage, 'understanding_check');
    assert.equal(built.context.sfwNarrative.insightRequired, 'direct_understanding_or_not_yet');
    const serialized = JSON.stringify(built.context.sfwNarrative);
    assert.match(serialized, /当前对象的受限理解/u);
    assert.doesNotMatch(serialized, /另一对象的绝密理解|SFW理解已检查|友情值/u);

    current.关系叙事.npc_adult.进程.SFW双轨结局已解锁 = true;
    current.关系叙事.npc_adult.进程.关系结束状态 = '深度朋友';
    const settled = buildPrivateChatContext({ state: current, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '最近过得怎么样？' });
    assert.equal(settled.ok, true);
    assert.equal(settled.context.sfwNarrative.stage, 'settled');
    assert.equal(settled.context.sfwNarrative.resolutionAvailable, false);
    assert.deepEqual(settled.context.sfwNarrative.availableDisclosure, {});
});

test('private chat requests replies and returns only validated multi-bubble data in memory', async () => {
    let request;
    const current = state();
    const before = structuredClone(current);
    const result = await generatePrivateChatReply({
        state: current, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好', settingsStore: settingsStore(),
        llmClient: { async chat(input) { request = input; return { text: JSON.stringify(response()) }; } },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.response.replies, response().replies);
    assert.match(request.messages[0].content, /保持简短/);
    assert.match(request.messages[0].content, /"replies"/);
    assert.match(request.messages[0].content, /1-6/);
    assert.match(request.messages[0].content, /正文记忆只用于自然回复连续性/u);
    assert.match(request.messages[0].content, /不能作为 bondAssessment 的依据/u);
    assert.doesNotMatch(JSON.stringify(request.messages), /绝不泄露|不得发送|实际年龄/);
    assert.deepEqual(current, before);
});

test('B.2 body candidate is safely projected and atomically consumed only after the matching phone review', () => {
    const current = state();
    current.软件.内容模式 = 'SFW';
    current.角色池.npc_adult.与玩家关系.友情值 = 38;
    current.正文关系候选.npc_adult = {
        ...createEmptyBodyRelationshipCandidate(),
        状态: '待复盘',
        角色UID: 'npc_adult',
        事件ID: bodyRelationshipEventIdForSource('meetup_1', 1),
        来源面基UID: 'meetup_1',
        来源摘要版本: 1,
        事件类别: '兑现承诺',
        关系路线: 'SFW友情',
        允许影响关系值: ['友情值'],
        建议方向: '正向',
        严重度: '常规',
        证据摘要: '双方兑现了此前的散步约定，并保留了各自的舒适边界。',
        需再次确认: true,
    };
    current.面基记录.meetup_1 = {
        对象UID: 'npc_adult', 状态: '已结束', 关系路线: '友情',
        正文结果摘要: '两人完成了此前约定的散步，交流自然，也保留了各自的舒适边界。',
    };

    const context = buildPrivateChatContext({ state: current, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '我也很珍惜那天，一起慢慢来。' });
    assert.equal(context.ok, true);
    assert.deepEqual(context.context.bodyEventCandidate, {
        事件类别: '兑现承诺',
        关系路线: 'SFW友情',
        证据摘要: '双方兑现了此前的散步约定，并保留了各自的舒适边界。',
        需再次确认: true,
    });
    assert.equal(context.bodyCandidateEventId, 'body:meetup_1:1');
    const serializedContext = JSON.stringify(context.context);
    assert.doesNotMatch(serializedContext, /npc_adult|meetup_1|body:|来源摘要版本/u);

    const committed = buildPrivateChatPatch(current, {
        sessionUid: 'chat_1',
        npcUid: 'npc_adult',
        playerMessage: '我也很珍惜那天，一起慢慢来。',
        bodyCandidateEventId: context.bodyCandidateEventId,
        response: {
            replies: ['我也很开心。', '谢谢你愿意把节奏留给我们。'],
            relationship: { 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 },
            bodyEventReview: 'confirm',
            bondAssessment: { kind: 'friendly', intensity: 3, direction: 'increase' },
        },
    });
    assert.equal(committed.ok, true);
    assert.equal(validateControlledPatchAgainstState(current, committed.value).ok, true);
    const bondChange = committed.value.find((operation) => operation.path === '/角色池/npc_adult/与玩家关系/友情值');
    assert.deepEqual(bondChange, { op: 'replace', path: '/角色池/npc_adult/与玩家关系/友情值', value: 40 });
    assert.equal(committed.value.filter((operation) => operation.path === '/角色池/npc_adult/与玩家关系/友情值').length, 1);
    assert.equal(committed.value.some((operation) => operation.path === '/关系叙事/npc_adult/进程/已消费事件ID'
        && operation.value.includes('body:meetup_1:1')), true);
    const cleared = committed.value.find((operation) => operation.path === '/正文关系候选/npc_adult');
    assert.deepEqual(cleared?.value, createEmptyBodyRelationshipCandidate());

    const onlySfw = structuredClone(current);
    onlySfw.软件.内容模式 = 'NSFW';
    onlySfw.关系叙事.npc_adult.进程.边界暂停状态 = '仅SFW';
    const onlySfwCommitted = buildPrivateChatPatch(onlySfw, {
        sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '只聊友情，也确认那次散步。',
        bodyCandidateEventId: 'body:meetup_1:1', onlySfwAtRequest: true,
        response: {
            replies: ['好，我们按舒服的友情节奏来。'],
            relationship: { 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 },
            bodyEventReview: 'confirm',
            bondAssessment: { kind: 'friendly', intensity: 1, direction: 'increase' },
        },
    });
    assert.equal(onlySfwCommitted.ok, true);
    assert.equal(onlySfwCommitted.value.some((operation) => operation.path === '/角色池/npc_adult/与玩家关系/友情值' && operation.value === 40), true, '仅 SFW 仍可复盘既有 SFW 友情候选');
    assert.equal(validateControlledPatchAgainstState(onlySfw, onlySfwCommitted.value).ok, true);

    const staleReference = buildPrivateChatPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '我也很珍惜那天，一起慢慢来。',
        bodyCandidateEventId: 'body:meetup_other:1',
        response: { replies: ['我听见了。'], relationship: { 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 }, bodyEventReview: 'confirm' },
    });
    assert.equal(staleReference.ok, true);
    assert.equal(staleReference.value.some((operation) => operation.path === '/正文关系候选/npc_adult'), false);
    assert.equal(staleReference.value.some((operation) => operation.path === '/角色池/npc_adult/与玩家关系/友情值'), false);
});

test('NSFW core contract permits consensual adult chat without treating explicitness as local block pressure', async () => {
    let request;
    const current = activeNsfwState({ scopes: ['成人话题', '露骨调情'], turns: 3 });
    const result = await generatePrivateChatReply({
        state: current, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '我想和你聊些更亲密的事，可以吗？', turnConsentConfirmed: true, settingsStore: settingsStore(),
        llmClient: {
            async chat(input) {
                request = input;
                return { text: JSON.stringify({
                    replies: ['可以，我们按彼此舒服的节奏来。'],
                    relationship: { 好感: 1, 信任: 1, 戒备: 0, 面基意愿: 0 },
                    bondAssessment: { kind: 'sexual_desire', intensity: 1, direction: 'increase' },
                    nsfwConsentAssessment: 'in_scope',
                }) };
            },
        },
    });
    assert.equal(result.ok, true);
    assert.equal(result.response.relationship.戒备, 0);
    assert.equal(result.response.nsfwSafetyAssessment, 'none');
    assert.equal(result.response.nsfwConsentAssessment, 'in_scope');
    assert.deepEqual(result.nsfwConsentReferenceAtRequest, { revision: 1, remainingTurns: 3, scopes: ['成人话题', '露骨调情'] });
    assert.match(request.messages[0].content, /结构化范围、有限剩余轮数与本轮显式确认/u);
    assert.match(request.messages[0].content, /模型不得选路、锁线、给阈值或决定面基/u);
    assert.match(request.messages[0].content, /nsfwConsentAssessment 必须先对照本轮玩家文本与 nsfwConsent\.scopes 分类/u);
    assert.match(request.messages[0].content, /只有 in_scope 才可给出可结算的 romantic_desire\/sexual_desire/u);
    assert.match(request.messages[0].content, /NSFW 允许 none\/friendly\/romantic_flirt\/romantic_desire\/sexual_desire/u);
    assert.match(request.messages[0].content, /普通问候或日常友好交流应使用 none 或 friendly/u);
    assert.doesNotMatch(request.messages[1].content, /剩余轮数|修订号|玩家私聊工具/u);
});

test('private chat summary uses its dedicated preset and returns only validated in-memory text and anchors', async () => {
    const current = state();
    let request;
    const result = await generatePrivateChatSummary({
        state: current,
        sessionUid: 'chat_1',
        npcUid: 'npc_adult',
        settingsStore: summarySettingsStore(),
        llmClient: {
            async chat(input) {
                request = input;
                return { text: '{"summary":"双方礼貌打招呼，并准备继续聊周末安排。"}' };
            },
        },
    });
    assert.equal(result.ok, true);
    assert.equal(result.summary, '双方礼貌打招呼，并准备继续聊周末安排。');
    assert.deepEqual(result.source, { messageUids: ['old'], summaryUid: '' });
    assert.match(request.messages[0].content, /连续摘要/u);
    assert.doesNotMatch(JSON.stringify(request.messages), /绝不泄露|不得发送|实际年龄|私人备注/u);
});

test('private chat rejects unsafe multi-bubble model output without writes or source echo', async () => {
    const current = state();
    const before = structuredClone(current);
    const result = await generatePrivateChatReply({
        state: current, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好', settingsStore: settingsStore(),
        llmClient: { async chat() { return { text: JSON.stringify({ ...response(), replies: ['<script>MODEL_SECRET</script>'] }) }; } },
    });
    assert.deepEqual(result, {
        ok: false,
        code: 'private_chat_response_reply_invalid',
        message: '私聊文本不符合安全格式。',
    });
    assert.equal(JSON.stringify(result).includes('MODEL_SECRET'), false);
    assert.deepEqual(current, before);
});

test('private chat patch consumes the canonical multi-bubble response', () => {
    const current = state();
    const before = structuredClone(current);
    const built = buildPrivateChatPatch(current, { sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好', response: response() });
    assert.equal(built.ok, true);
    assert.deepEqual(built.value.map((operation) => operation.path), [
        '/会话/chat_1/最近消息/-', '/会话/chat_1/最近消息/-', '/会话/chat_1/最近消息/-',
        '/角色池/npc_adult/与玩家关系/好感', '/角色池/npc_adult/与玩家关系/信任', '/角色池/npc_adult/与玩家关系/戒备',
        '/会话/chat_1/对话层数',
    ]);
    assert.equal(built.value[1].value.内容, '晚上好。');
    assert.equal(built.value[2].value.内容, '先聊聊彼此的周末？');
    assert.equal(built.value[3].value, 32);
    assert.equal(built.value[5].value, 18);
    assert.equal(built.value.at(-1).value, 4);
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);
    assert.deepEqual(current, before);
});

test('private chat patch rejects unsafe or stale operations before parse', () => {
    const current = state();
    const built = buildPrivateChatPatch(current, { sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好', response: response() });
    const forged = structuredClone(built.value); forged[1].path = '/会话/chat_1/隐藏资料';
    assert.equal(validateControlledPatchAgainstState(current, forged).ok, false);
    const stale = state(); stale.角色池.npc_adult.与玩家关系.状态 = '已取消';
    assert.equal(buildPrivateChatPatch(stale, { sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好', response: response() }).ok, false);
});


// —— 阶段 77：安全控制台诊断带出通道 ——

test('llm transport failures leave a consumable diagnostic with stage, code and HTTP status', async () => {
    consumePrivateChatDiagnostics('private_chat', 'chat_1');
    const result = await generatePrivateChatReply({
        state: state(), sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好', settingsStore: settingsStore(),
        llmClient: { async chat() { throw new YueLeMaLlmError('SERVER_ERROR', '模型服务暂时不可用，请稍后重试。', { status: 502, retryable: true }); } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SERVER_ERROR');
    const records = consumePrivateChatDiagnostics('private_chat', 'chat_1');
    assert.equal(records.length, 1);
    assert.equal(records[0].stage, '模型请求');
    assert.equal(records[0].code, 'SERVER_ERROR');
    assert.equal(records[0].error.status, 502);
    assert.equal(records[0].error.name, 'YueLeMaLlmError');
    // 消费即清空
    assert.equal(consumePrivateChatDiagnostics('private_chat', 'chat_1').length, 0);
});

test('malformed relationship deltas fail closed to zero without discarding a valid reply', async () => {
    consumePrivateChatDiagnostics('private_chat', 'chat_1');
    const result = await generatePrivateChatReply({
        state: state(), sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好', settingsStore: settingsStore(),
        llmClient: { async chat() { return { text: JSON.stringify({ ...response(), relationship: { 好感: 97, 信任: 1, 戒备: '0' } }) }; } },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.response.relationship, { 好感: 0, 信任: 1, 戒备: 0, 面基意愿: 0 });
    assert.equal(consumePrivateChatDiagnostics('private_chat', 'chat_1').length, 0);
});

test('bondAssessment whitelist violations name the field and allowed kinds without conversation text', async () => {
    consumePrivateChatDiagnostics('private_chat', 'chat_1');
    const sfwState = state();
    sfwState.软件.内容模式 = 'SFW';
    const result = await generatePrivateChatReply({
        state: sfwState, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好', settingsStore: settingsStore(),
        llmClient: { async chat() { return { text: JSON.stringify({ ...response(), bondAssessment: { kind: 'sexual_desire', intensity: 2 } }) }; } },
    });
    assert.equal(result.code, 'private_chat_response_relationship_invalid');
    const records = consumePrivateChatDiagnostics('private_chat', 'chat_1');
    assert.equal(records[0].field, 'bondAssessment.kind');
    assert.match(records[0].expected, /SFW 白名单/u);
    assert.equal(records[0].actual, 'sexual_desire');
    assert.doesNotMatch(JSON.stringify(records), /晚上好/u);
});

test('unparsable model output records only response length, never the raw text', async () => {
    consumePrivateChatDiagnostics('private_chat', 'chat_1');
    const result = await generatePrivateChatReply({
        state: state(), sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好', settingsStore: settingsStore(),
        llmClient: { async chat() { return { text: 'MODEL_RAW_LEAK not json' }; } },
    });
    assert.equal(result.code, 'private_chat_invalid_json');
    const records = consumePrivateChatDiagnostics('private_chat', 'chat_1');
    assert.equal(records[0].stage, '响应解析');
    assert.match(records[0].actual, /响应长度 \d+ 字符/u);
    assert.doesNotMatch(JSON.stringify(records), /MODEL_RAW_LEAK/u);
});

test('missing chat connection preset leaves a connection-stage diagnostic', async () => {
    consumePrivateChatDiagnostics('private_chat', 'chat_1');
    const result = await generatePrivateChatReply({
        state: state(), sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好',
        settingsStore: { resolveFunction() { return { connectionPreset: null, promptPreset: null }; } },
        llmClient: { async chat() { throw new Error('must not be called'); } },
    });
    assert.equal(result.code, 'private_chat_connection_missing');
    const records = consumePrivateChatDiagnostics('private_chat', 'chat_1');
    assert.equal(records[0].stage, '连接检查');
    assert.equal(records[0].code, 'private_chat_connection_missing');
});

test('summary retries accumulate one diagnostic per attempt under the chat_summary scope', async () => {
    consumePrivateChatDiagnostics('chat_summary', 'chat_1');
    const runFailing = () => generatePrivateChatSummary({
        state: state(), sessionUid: 'chat_1', npcUid: 'npc_adult', settingsStore: summarySettingsStore(),
        llmClient: { async chat() { throw new YueLeMaLlmError('TIMEOUT', '模型请求超时，请稍后重试。', { retryable: true }); } },
    });
    await runFailing();
    await runFailing();
    const records = consumePrivateChatDiagnostics('chat_summary', 'chat_1');
    assert.equal(records.length, 2);
    assert.equal(records[0].code, 'TIMEOUT');
    assert.equal(records[1].stage, '模型请求');
    // 私聊与总结两个作用域互不串扰
    assert.equal(consumePrivateChatDiagnostics('private_chat', 'chat_1').length, 0);
});
