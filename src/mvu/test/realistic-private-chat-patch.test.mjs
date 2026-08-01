import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildAppendRealisticPrivateChatPlayerMessagePatch,
    buildDeliverRealisticPrivateChatMessagesPatch,
    buildRealisticPrivateChatBackfillPatch,
    buildRealisticPrivateChatProactivePatch,
    buildRealisticPrivateChatResponsePatch,
    buildToggleRealisticPrivateChatPatch,
    validateControlledPatchAgainstState,
} from '../controlled-patch.js';
import { decodeJsonPointer } from '../json-pointer.js';
import { createEmptyBodyRelationshipCandidate } from '../body-relationship-candidate.js';
import { createEmptyRelationshipNarrative } from '../relationship-narrative.js';
import { closeNsfwConsent, createEmptyNsfwConsent, grantNsfwConsent, nsfwConsentReference } from '../nsfw-consent.js';

function state() {
    return {
        系统: { UID计数器: { 角色: 1, 会话: 1, 面基: 0 } },
        软件: { 内容模式: 'SFW', 关于软件点击数: 0 },
        玩家: { 成人验证: true, 公开资料: {}, 仅好友资料: {}, 推荐偏好: { 标签权重: {} } },
        角色池: {
            npc_one: {
                成人验证: true,
                公开资料: { 昵称: '林澈' },
                仅好友资料: {},
                隐藏资料: { 实际年龄: 26, 私人备注: '' },
                偏好与边界: '', 拒绝阈值: 40, 已读不回阈值: 55, 取消匹配阈值: 70, 拉黑阈值: 100,
                与玩家关系: { 状态: '已匹配', 全局账号表现: 50, NPC专属匹配度: 70, 好感: 20, 信任: 10, 戒备: 15, 面基意愿: 0 },
            },
        },
        正文记忆: { npc_one: '' },
        正文关系候选: { npc_one: createEmptyBodyRelationshipCandidate() },
        关系叙事: { npc_one: createEmptyRelationshipNarrative() },
        会话: {
            chat_1: {
                对象UID: 'npc_one', 状态: '已匹配', 最近消息: [], 对话层数: 0,
                总结: { 已总结消息UID: '', 总结序号: 0, 记录: [], 状态: '空闲', 失败原因: '', 目标总结UID: '', 尝试次数: 0 },
                NSFW同意: createEmptyNsfwConsent(), 已确认边界: '', 已确认承诺: '',
            },
        },
        推荐: { 当前队列: [], 临时候选池: {}, 冷却角色UID: [], 收藏角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [] },
        面基记录: {},
    };
}

function applyPatch(source, patch) {
    const next = structuredClone(source);
    for (const operation of patch) {
        const segments = decodeJsonPointer(operation.path);
        const leaf = segments.pop();
        let target = next;
        for (const segment of segments) target = target[segment];
        if (operation.op === 'remove') {
            if (Array.isArray(target)) target.splice(Number(leaf), 1);
            else delete target[leaf];
        } else if (Array.isArray(target) && leaf === '-') target.push(structuredClone(operation.value));
        else target[leaf] = structuredClone(operation.value);
    }
    return next;
}

function neutralResponse(replies, timing) {
    return {
        replies,
        relationship: { 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 },
        timing,
        bondAssessment: { kind: 'none', intensity: 0, direction: 'none' },
        bodyEventReview: 'defer', sfwInsightAssessment: 'none', sfwResolutionAssessment: 'none',
        nsfwSafetyAssessment: 'none', nsfwConsentAssessment: 'none',
    };
}

test('拟真模式允许玩家连发、AI 先入等待队列并只在到点后进入可见消息', () => {
    let current = state();
    const backfill = buildRealisticPrivateChatBackfillPatch(current);
    assert.equal(backfill.ok, true);
    assert.equal(validateControlledPatchAgainstState(current, backfill.value).ok, true);
    current = applyPatch(current, backfill.value);

    const toggle = buildToggleRealisticPrivateChatPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', enabled: true, phoneTime: '2026-08-02 12:00',
    });
    assert.equal(toggle.ok, true);
    assert.equal(validateControlledPatchAgainstState(current, toggle.value).ok, true);
    current = applyPatch(current, toggle.value);

    for (const [message, phoneTime] of [['我刚出门。', '2026-08-02 12:00'], ['不过忘带伞了。', '2026-08-02 12:05']]) {
        const sent = buildAppendRealisticPrivateChatPlayerMessagePatch(current, {
            sessionUid: 'chat_1', npcUid: 'npc_one', playerMessage: message, phoneTime,
        });
        assert.equal(sent.ok, true);
        assert.equal(validateControlledPatchAgainstState(current, sent.value.patch).ok, true);
        current = applyPatch(current, sent.value.patch);
    }
    assert.deepEqual(current.会话.chat_1.最近消息.map((message) => message.内容), ['我刚出门。', '不过忘带伞了。']);
    assert.equal(current.会话.chat_1.拟真聊天.回复触发时间, '2026-08-02 12:15');

    const planned = buildRealisticPrivateChatResponsePatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', generationTime: '2026-08-02 12:15',
        playerMessageUids: current.会话.chat_1.最近消息.map((message) => message.消息UID),
        response: neutralResponse(['我在便利店，先看看有没有伞。', '你到哪了？'], {
            firstDelayMinutes: 10, betweenReplyMinutes: [5], nextProactiveMinutes: 120,
        }),
        onlySfwAtRequest: false,
    });
    assert.equal(planned.ok, true);
    assert.equal(validateControlledPatchAgainstState(current, planned.value.patch).ok, true);
    current = applyPatch(current, planned.value.patch);
    assert.equal(current.会话.chat_1.最近消息.length, 2, '未到点的 AI 内容不得进入可见消息');
    assert.equal(current.会话.chat_1.拟真聊天.待投递消息.length, 2);

    const tooEarly = buildDeliverRealisticPrivateChatMessagesPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', phoneTime: '2026-08-02 12:20',
    });
    assert.equal(tooEarly.ok, false);
    const firstDelivery = buildDeliverRealisticPrivateChatMessagesPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', phoneTime: '2026-08-02 12:25',
    });
    assert.equal(firstDelivery.ok, true);
    assert.equal(validateControlledPatchAgainstState(current, firstDelivery.value.patch).ok, true);
    current = applyPatch(current, firstDelivery.value.patch);
    assert.equal(current.会话.chat_1.最近消息.at(-1).内容, '我在便利店，先看看有没有伞。');
    assert.equal(current.会话.chat_1.拟真聊天.待投递消息.length, 1);

    current.关系叙事.npc_one.进程.边界暂停状态 = '暂停';
    assert.equal(buildDeliverRealisticPrivateChatMessagesPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', phoneTime: '2026-08-02 12:30',
    }).ok, false, '关系暂停后不得投递此前排队的 AI 消息');
    const disabled = buildToggleRealisticPrivateChatPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', enabled: false, phoneTime: '2026-08-02 12:25',
    });
    assert.equal(disabled.ok, true);
    assert.equal(validateControlledPatchAgainstState(current, disabled.value).ok, true);
    assert.equal(disabled.value[0].value.待投递消息.length, 0, '只读关系也能关闭开关并取消尚未显示的消息');
});

test('主动消息只接受中性计划并保持到点前不可见，伪造调度 Patch 被拒绝', () => {
    let current = state();
    current = applyPatch(current, buildRealisticPrivateChatBackfillPatch(current).value);
    current = applyPatch(current, buildToggleRealisticPrivateChatPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', enabled: true, phoneTime: '2026-08-02 12:00',
    }).value);
    const proactive = buildRealisticPrivateChatProactivePatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', triggerTime: '2026-08-02 13:00', generationTime: '2026-08-02 13:00',
        response: neutralResponse(['刚看到一家店的招牌，莫名想到你。'], {
            firstDelayMinutes: 15, betweenReplyMinutes: [], nextProactiveMinutes: 180,
        }),
    });
    assert.equal(proactive.ok, true, JSON.stringify(proactive));
    assert.equal(validateControlledPatchAgainstState(current, proactive.value.patch).ok, true);
    assert.equal(proactive.value.patch.some((operation) => /\/最近消息\//u.test(operation.path)), false);

    const forged = structuredClone(proactive.value.patch);
    forged.find((operation) => /\/待投递消息\/-$/u.test(operation.path)).value.时间 = '2026-08-02 13:07';
    assert.equal(validateControlledPatchAgainstState(current, forged).ok, false);
});

test('NSFW 主动消息绑定仍有效的同意修订，撤回后不得投递', () => {
    let current = state();
    current.软件.内容模式 = 'NSFW';
    current.会话.chat_1.NSFW同意 = grantNsfwConsent(current.会话.chat_1.NSFW同意, {
        scopes: ['露骨调情', '线上文爱'], turns: 3,
    });
    const consentReference = nsfwConsentReference(current.会话.chat_1.NSFW同意);
    current = applyPatch(current, buildRealisticPrivateChatBackfillPatch(current).value);
    current = applyPatch(current, buildToggleRealisticPrivateChatPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', enabled: true, phoneTime: '2026-08-02 12:00',
    }).value);
    const proactive = buildRealisticPrivateChatProactivePatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', triggerTime: '2026-08-02 13:00', generationTime: '2026-08-02 13:00',
        onlySfwAtRequest: false,
        nsfwConsentReferenceAtRequest: consentReference,
        response: neutralResponse(['今晚想继续你允许的那段露骨幻想。'], {
            firstDelayMinutes: 5, betweenReplyMinutes: [], nextProactiveMinutes: 180,
        }),
    });
    assert.equal(proactive.ok, true, JSON.stringify(proactive));
    assert.equal(validateControlledPatchAgainstState(current, proactive.value.patch).ok, true);
    current = applyPatch(current, proactive.value.patch);
    assert.match(current.会话.chat_1.拟真聊天.待投递消息[0].批次UID, /_proactive_.*_mode_nsfw_r1$/u);
    assert.equal(buildDeliverRealisticPrivateChatMessagesPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', phoneTime: '2026-08-02 13:05',
    }).ok, true);

    const withdrawn = structuredClone(current);
    withdrawn.会话.chat_1.NSFW同意 = closeNsfwConsent(withdrawn.会话.chat_1.NSFW同意, '已撤回');
    assert.equal(buildDeliverRealisticPrivateChatMessagesPatch(withdrawn, {
        sessionUid: 'chat_1', npcUid: 'npc_one', phoneTime: '2026-08-02 13:05',
    }).code, 'private_chat_realistic_delivery_consent_changed');
});

test('拟真回复触发本地拉黑时立即显示固定系统通知且不留下永远无法投递的队列', () => {
    let current = state();
    current.角色池.npc_one.拉黑阈值 = 80;
    current.角色池.npc_one.与玩家关系.好感 = 0;
    current.角色池.npc_one.与玩家关系.信任 = 0;
    current.角色池.npc_one.与玩家关系.戒备 = 90;
    current.会话.chat_1.对话层数 = 12;
    current = applyPatch(current, buildRealisticPrivateChatBackfillPatch(current).value);
    current = applyPatch(current, buildToggleRealisticPrivateChatPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', enabled: true, phoneTime: '2026-08-02 12:00',
    }).value);
    current = applyPatch(current, buildAppendRealisticPrivateChatPlayerMessagePatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', playerMessage: '继续发消息', phoneTime: '2026-08-02 12:00',
    }).value.patch);

    const planned = buildRealisticPrivateChatResponsePatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', generationTime: '2026-08-02 12:10',
        playerMessageUids: [current.会话.chat_1.最近消息.at(-1).消息UID],
        response: neutralResponse(['这段模型文本不得显示。'], {
            firstDelayMinutes: 10, betweenReplyMinutes: [], nextProactiveMinutes: 120,
        }),
        onlySfwAtRequest: false,
    });
    assert.equal(planned.ok, true);
    assert.equal(validateControlledPatchAgainstState(current, planned.value.patch).ok, true);
    current = applyPatch(current, planned.value.patch);
    assert.equal(current.会话.chat_1.状态, '已拉黑');
    assert.deepEqual(current.会话.chat_1.最近消息.map((message) => message.内容), [
        '继续发消息', '对方已将你拉黑，当前会话无法继续发送消息。',
    ]);
    assert.equal(current.会话.chat_1.拟真聊天.待投递消息.length, 0);
    assert.doesNotMatch(JSON.stringify(current), /这段模型文本不得显示/u);
});

test('NSFW 待投递回复绑定计划提交后的同意修订与当前内容模式', () => {
    let current = state();
    current.软件.内容模式 = 'NSFW';
    current.会话.chat_1.NSFW同意 = grantNsfwConsent(current.会话.chat_1.NSFW同意, {
        scopes: ['成人话题'], turns: 3,
    });
    const consentReference = nsfwConsentReference(current.会话.chat_1.NSFW同意);
    current = applyPatch(current, buildRealisticPrivateChatBackfillPatch(current).value);
    current = applyPatch(current, buildToggleRealisticPrivateChatPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', enabled: true, phoneTime: '2026-08-02 12:00',
    }).value);
    current = applyPatch(current, buildAppendRealisticPrivateChatPlayerMessagePatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', playerMessage: '继续刚才允许的成人话题', phoneTime: '2026-08-02 12:00',
        turnConsentConfirmed: true, nsfwConsentReferenceAtSend: consentReference,
    }).value.patch);
    const response = {
        ...neutralResponse(['好，我们只聊你刚才允许的范围。'], {
            firstDelayMinutes: 5, betweenReplyMinutes: [], nextProactiveMinutes: 60,
        }),
        nsfwConsentAssessment: 'in_scope',
    };
    const planned = buildRealisticPrivateChatResponsePatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', generationTime: '2026-08-02 12:10',
        playerMessageUids: [current.会话.chat_1.最近消息.at(-1).消息UID], response,
        onlySfwAtRequest: false, turnConsentConfirmed: true, nsfwConsentReferenceAtRequest: consentReference,
    });
    assert.equal(planned.ok, true);
    assert.equal(validateControlledPatchAgainstState(current, planned.value.patch).ok, true);
    current = applyPatch(current, planned.value.patch);
    assert.match(current.会话.chat_1.拟真聊天.待投递消息[0].批次UID, /_mode_nsfw_r2$/u);

    const changedMode = structuredClone(current);
    changedMode.软件.内容模式 = 'SFW';
    assert.equal(buildDeliverRealisticPrivateChatMessagesPatch(changedMode, {
        sessionUid: 'chat_1', npcUid: 'npc_one', phoneTime: '2026-08-02 12:15',
    }).code, 'private_chat_realistic_delivery_mode_changed');

    const changedConsent = structuredClone(current);
    changedConsent.会话.chat_1.NSFW同意 = closeNsfwConsent(changedConsent.会话.chat_1.NSFW同意, '已撤回');
    assert.equal(buildDeliverRealisticPrivateChatMessagesPatch(changedConsent, {
        sessionUid: 'chat_1', npcUid: 'npc_one', phoneTime: '2026-08-02 12:15',
    }).code, 'private_chat_realistic_delivery_consent_changed');
    assert.equal(buildDeliverRealisticPrivateChatMessagesPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', phoneTime: '2026-08-02 12:15',
    }).ok, true);
});
