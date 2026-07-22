import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMeetupHandoffPatch, validateControlledPatchAgainstState } from '../controlled-patch.js';
import { createActionBridge } from '../../action-bridge.js';

function matchedState() {
    return {
        系统: { UID计数器: { 角色: 1, 会话: 1, 面基: 4 } },
        软件: { 内容模式: 'SFW', 关于软件点击数: 0 },
        玩家: { 成人验证: true, 公开资料: { 昵称: '玩家' }, 推荐偏好: { 标签权重: {} } },
        角色池: {
            npc_ava: {
                成人验证: true,
                公开资料: { 昵称: '艾娃' },
                仅好友资料: { 关系状态: '单身', 边界与偏好: '不对外发送' },
                隐藏资料: { 实际年龄: 26, 私人备注: '隐藏备注' },
                偏好与边界: '内部边界', 拒绝阈值: 30, 已读不回阈值: 55, 取消匹配阈值: 70, 拉黑阈值: 90,
                与玩家关系: { 状态: '已匹配', 全局账号表现: 60, NPC专属匹配度: 70, 好感: 35, 信任: 35, 戒备: 10, 面基意愿: 60 },
            },
        },
        推荐: { 当前队列: [], 临时候选池: {}, 冷却角色UID: [], 收藏角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [] },
        会话: { chat_1: { 对象UID: 'npc_ava', 状态: '已匹配', 最近消息: [], 长期摘要: '', 已确认边界: '', 已确认承诺: '' } },
        面基记录: {},
    };
}

function request() {
    return {
        sessionUid: 'chat_1', npcUid: 'npc_ava', time: '本周六 19:30', place: '静安寺地铁站 2 号口',
        mutualIntent: '一起吃晚饭并确认是否继续约会', confirmedBoundaries: '只在公共场所见面；任何亲密行为都需要当场再次确认。',
        pendingItems: '散场时间', riskNotice: '各自独立到场，可随时离开。',
    };
}

test('matched adults create one exact pending-send meetup record and a draft without leaking hidden profile fields', () => {
    const state = matchedState();
    const result = buildMeetupHandoffPatch(state, request());
    assert.equal(result.ok, true);
    assert.equal(result.value.meetupUid, 'meetup_5');
    assert.deepEqual(result.value.patch.map(({ op, path }) => [op, path]), [
        ['add', '/面基记录/meetup_5'],
        ['replace', '/系统/UID计数器/面基'],
    ]);
    assert.equal(result.value.patch[0].value.状态, '待发送');
    assert.match(result.value.draft, /现实面基行动草稿/u);
    assert.match(result.value.draft, /静安寺/u);
    assert.doesNotMatch(result.value.draft, /隐藏备注|内部边界|不对外发送|26/u);
    assert.equal(validateControlledPatchAgainstState(state, result.value.patch).ok, true);
    assert.deepEqual(state, matchedState());
});

test('meetup handoff refuses missing confirmed boundaries and forged record content before MVU parsing', () => {
    const state = matchedState();
    const incomplete = request();
    incomplete.confirmedBoundaries = '';
    assert.equal(buildMeetupHandoffPatch(state, incomplete).code, 'meetup_confirmedBoundaries_invalid');

    const valid = buildMeetupHandoffPatch(state, request());
    const forged = structuredClone(valid.value.patch);
    forged[0].path = '/面基记录/meetup_6';
    assert.equal(validateControlledPatchAgainstState(state, forged).ok, false);
});

test('meetup handoff requires every retained private-chat layer to have a controlled summary first', () => {
    const state = matchedState();
    state.会话.chat_1.最近消息 = [{ 消息UID: 'm_1', 发送者: '玩家', 内容: '我们约周六见。', 时间: '', 层数: 1 }];
    state.会话.chat_1.对话层数 = 1;
    state.会话.chat_1.总结 = { 已总结消息UID: '', 总结序号: 0, 记录: [], 状态: '空闲', 失败原因: '', 目标总结UID: '', 尝试次数: 0 };
    assert.equal(buildMeetupHandoffPatch(state, request()).code, 'meetup_summary_required');
});

test('meetup bridge persists before appending the host textarea draft and never sends it', async () => {
    const calls = [];
    const data = { stat_data: matchedState() };
    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'variable_update_ended' },
        getMvuData(scope) { calls.push(['get', scope]); return data; },
        async parseMessage(raw, oldData) {
            calls.push(['parse', raw]);
            const next = structuredClone(oldData);
            const patch = JSON.parse(raw.match(/<JSONPatch>([\s\S]*?)<\/JSONPatch>/u)[1]);
            for (const operation of patch) {
                if (operation.op === 'add' && operation.path.startsWith('/面基记录/')) {
                    next['stat_data']['面基记录'][operation.path.split('/').at(-1)] = operation.value;
                }
                if (operation.op === 'replace' && operation.path === '/系统/UID计数器/面基') {
                    next['stat_data']['系统']['UID计数器']['面基'] = operation.value;
                }
            }
            return next;
        },
        async replaceMvuData(nextData, scope) { calls.push(['replace', scope]); },
    };
    const textarea = {
        value: '已有正文草稿', dispatched: 0, focused: 0,
        dispatchEvent() { this.dispatched += 1; }, focus() { this.focused += 1; },
        setSelectionRange() {},
    };
    const bridge = createActionBridge({
        documentRef: { querySelector: (selector) => selector === '#send_textarea' ? textarea : null },
        mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); },
    });
    const result = await bridge.runMeetupHandoff(request());
    assert.equal(result.ok, true);
    assert.equal(result.draftApplied, true);
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'parse', 'replace', 'event']);
    assert.equal(textarea.dispatched, 1);
    assert.equal(textarea.focused, 1);
    assert.match(textarea.value, /^已有正文草稿\n【现实面基行动草稿】/u);
    assert.equal('click' in textarea, false);
});

test('meetup bridge force-summarizes pending chat through MVU before it writes the host draft', async () => {
    const calls = [];
    const initial = matchedState();
    initial.会话.chat_1.最近消息 = [{ 消息UID: 'm_1', 发送者: '玩家', 内容: '我们约周六在静安寺见。', 时间: '', 层数: 1 }];
    initial.会话.chat_1.对话层数 = 1;
    initial.会话.chat_1.总结 = { 已总结消息UID: '', 总结序号: 0, 记录: [], 状态: '空闲', 失败原因: '', 目标总结UID: '', 尝试次数: 0 };
    const data = { stat_data: initial };
    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'variable_update_ended' },
        getMvuData(scope) { calls.push(['get', scope]); return data; },
        async parseMessage(raw, oldData) {
            calls.push(['parse', raw]);
            const next = structuredClone(oldData);
            const patch = JSON.parse(raw.match(/<JSONPatch>([\s\S]*?)<\/JSONPatch>/u)[1]);
            for (const operation of patch) {
                if (operation.op === 'add' && operation.path === '/会话/chat_1/总结') next.stat_data.会话.chat_1.总结 = operation.value;
                if (operation.op === 'add' && operation.path.startsWith('/面基记录/')) next.stat_data.面基记录[operation.path.split('/').at(-1)] = operation.value;
                if (operation.op === 'replace' && operation.path === '/系统/UID计数器/面基') next.stat_data.系统.UID计数器.面基 = operation.value;
            }
            return next;
        },
        async replaceMvuData(nextData, scope) { calls.push(['replace', scope]); data.stat_data = nextData.stat_data; },
    };
    const textarea = {
        value: '', dispatched: 0, focused: 0,
        dispatchEvent() { this.dispatched += 1; }, focus() { this.focused += 1; }, setSelectionRange() {},
    };
    const bridge = createActionBridge({
        documentRef: { querySelector: (selector) => selector === '#send_textarea' ? textarea : null },
        mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); },
        settingsStore: {
            getChatSummarySettings() { return { enabled: false, interval: 2, retryLimit: 0 }; },
            resolveFunction(key) {
                assert.equal(key, 'chat_summary');
                return { connectionPreset: { id: 'summary', url: 'https://example.test/v1', model: 'summary' }, promptPreset: { enabled: true, content: '只记录已明确的内容。' } };
            },
        },
        llmClient: { async chat() { return { text: '{"summary":"双方正在确认周六于静安寺见面的安排。"}' }; } },
    });

    const result = await bridge.runMeetupHandoff(request());

    assert.equal(result.ok, true);
    assert.equal(result.forcedSummaryCount, 1);
    assert.equal(data.stat_data.会话.chat_1.总结.记录.length, 1);
    assert.equal(data.stat_data.面基记录.meetup_5.状态, '待发送');
    assert.match(textarea.value, /与艾娃角色约定面基/u);
    assert.equal(textarea.dispatched, 1);
    assert.equal(calls.filter(([name]) => name === 'parse').length, 2, '应先写入总结、再写入面基记录');
    assert.equal('click' in textarea, false);
});
