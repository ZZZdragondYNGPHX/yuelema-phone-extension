import test from 'node:test';
import assert from 'node:assert/strict';

import {
    calculateBondDecline,
    calculateBondGrowth,
    deriveMeetupAccess,
    projectBondProgress,
    relationshipEventIdForTurn,
    settleBodyRelationshipCandidate,
    settleRelationshipProgress,
} from '../relationship-progress.js';
import { createEmptyNsfwConsent, grantNsfwConsent } from '../../mvu/nsfw-consent.js';

function progress(overrides = {}) {
    return {
        SFW细微裂缝已触发: false,
        SFW朋友分享已触发: false,
        SFW面基已解锁: false,
        SFW理解已检查: false,
        SFW主动揭示已触发: false,
        SFW心动已解锁: false,
        SFW双轨结局已解锁: false,
        NSFW爱情阶段30已触发: false,
        NSFW爱情阶段40已触发: false,
        NSFW共识亲密阶段30已触发: false,
        NSFW共识亲密阶段40已触发: false,
        NSFW方向确认可用: false,
        NSFW路线锁定: '',
        最后结算回合UID: '',
        已消费事件ID: [],
        最近关系观察: '',
        边界暂停状态: '',
        关系结束状态: '',
        冻结关系值: '',
        ...overrides,
    };
}

function settle(options = {}) {
    return settleRelationshipProgress({
        contentMode: 'SFW', relationship: { 友情值: 0, 心动值: 0, 欲望值: 0 },
        progress: progress(), assessment: { kind: 'friendly', intensity: 1, direction: 'increase' },
        replied: true, turnId: 'msg_chat_1_p_1', ...options,
    });
}

test('global relationship deltas are strictly limited to +1/+2/-2/-3/-4/0', () => {
    const observed = new Set([
        calculateBondGrowth(0, 1),
        calculateBondGrowth(0, 3),
        calculateBondGrowth(10, 3, { highWeight: true }),
        calculateBondGrowth(100, 3),
        calculateBondDecline(80, 1),
        calculateBondDecline(80, 2),
        calculateBondDecline(80, 3),
        calculateBondDecline(0, 3),
    ]);
    assert.deepEqual([...observed].sort((left, right) => left - right), [-4, -3, -2, 0, 1, 2]);
    assert.equal(calculateBondGrowth(99, 3, { highWeight: true }), 1, 'upper bound must clamp +2');
    assert.equal(calculateBondDecline(3, 3), -3, 'lower bound must clamp -4');
});

test('SFW private chat remains on friendship and atomically marks the 40-point share', () => {
    const result = settle({
        relationship: { 友情值: 39, 心动值: 0, 欲望值: 88 },
        assessment: { kind: 'romantic_flirt', intensity: 3, direction: 'increase' },
    });
    assert.equal(result.field, '友情值');
    assert.equal(result.delta, 1);
    assert.equal(result.nextValue, 40);
    assert.equal(result.progressUpdates.最后结算回合UID, 'msg_chat_1_p_1');
    assert.deepEqual(result.progressUpdates.已消费事件ID, ['chat:1:1']);
    assert.equal(result.progressUpdates.SFW朋友分享已触发, true);
    assert.equal(Object.hasOwn(result.progressUpdates, 'SFW面基已解锁'), false);
    assert.equal(projectBondProgress({
        contentMode: 'SFW', relationship: { 友情值: 40, 心动值: 0 }, progress: progress(),
        assessment: { kind: 'romantic_flirt', intensity: 2, direction: 'increase' }, replied: true, turnId: 'msg_chat_1_p_2',
    }).field, '友情值', '60-point insight remains the only future heart-unlock decision');
    assert.equal(settle({ assessment: { kind: 'sexual_desire', intensity: 3, direction: 'increase' } }).delta, 0);
});

test('SFW 20/40/50 flags trigger once when a bounded settlement crosses each threshold', () => {
    const cases = [
        [19, 'SFW细微裂缝已触发'],
        [39, 'SFW朋友分享已触发'],
        [49, 'SFW面基已解锁'],
    ];
    for (const [score, field] of cases) {
        const result = settle({ relationship: { 友情值: score }, turnId: `msg_chat_1_p_${score}` });
        assert.equal(result.nextValue, score + 1);
        assert.equal(result.progressUpdates[field], true);
    }
    const alreadySeen = settle({
        relationship: { 友情值: 19 }, progress: progress({ SFW细微裂缝已触发: true }),
    });
    assert.equal(Object.hasOwn(alreadySeen.progressUpdates, 'SFW细微裂缝已触发'), false);
});

test('turn and event locks, pause, terminal ending and frozen fields all settle to zero', () => {
    const turnId = 'msg_chat_1_p_1';
    assert.equal(settle({ progress: progress({ 最后结算回合UID: turnId }), turnId }).delta, 0);
    assert.equal(settle({ progress: progress({ 已消费事件ID: ['chat:1:1'] }), turnId }).delta, 0);
    assert.equal(settle({ progress: progress({ 边界暂停状态: '暂停' }), turnId }).delta, 0);
    assert.equal(settle({ progress: progress({ 关系结束状态: '结束联系' }), turnId }).delta, 0);
    assert.equal(settle({ progress: progress({ 关系结束状态: '深度朋友' }), turnId }).delta, 1, 'a settled label is not an archive or deletion');
    assert.equal(settle({ progress: progress({ 冻结关系值: '友情值' }), turnId }).delta, 0);
    assert.equal(settle({ replied: false, turnId }).delta, 0);
});

test('event IDs are local, bounded projections of player turn IDs only', () => {
    assert.equal(relationshipEventIdForTurn('msg_chat_abc-123_p_42'), 'chat:abc-123:42');
    assert.equal(relationshipEventIdForTurn('msg_chat_abc-123_n_42'), '');
    assert.equal(relationshipEventIdForTurn('untrusted-value'), '');
});

test('C.2 keeps ordinary NSFW progress closed without an in-scope assessment and allows classified safety declines', () => {
    const ordinaryDecline = settle({
        contentMode: 'NSFW', relationship: { 友情值: 20, 心动值: 40, 欲望值: 80 },
        assessment: { kind: 'sexual_desire', intensity: 3, direction: 'decrease' },
    });
    assert.equal(ordinaryDecline.delta, 0);
    assert.equal(settle({ contentMode: 'NSFW', assessment: { kind: 'sexual_desire', intensity: 2, direction: 'increase' } }).delta, 0);
    const safetyDecline = settle({
        contentMode: 'NSFW', relationship: { 友情值: 20, 心动值: 40, 欲望值: 80 },
        assessment: { kind: 'sexual_desire', intensity: 3, direction: 'decrease' },
        nsfwSafetyAssessment: 'known_boundary_conflict',
    });
    assert.deepEqual(
        { field: safetyDecline.field, delta: safetyDecline.delta, nextValue: safetyDecline.nextValue, safetyPause: safetyDecline.safetyPause },
        { field: '欲望值', delta: -4, nextValue: 76, safetyPause: true },
    );
    const zeroScoreSafety = settle({
        contentMode: 'NSFW', relationship: { 友情值: 0, 心动值: 0, 欲望值: 0 },
        assessment: { kind: 'sexual_desire', intensity: 3, direction: 'decrease' },
        nsfwSafetyAssessment: 'privacy_violation',
    });
    assert.deepEqual({ delta: zeroScoreSafety.delta, safetyPause: zeroScoreSafety.safetyPause }, { delta: 0, safetyPause: true });
});

test('C.3 advances only the assessed NSFW rail, marks 30/40/50 once, and never selects a direction', () => {
    const heart30 = settle({
        contentMode: 'NSFW', relationship: { 友情值: 0, 心动值: 29, 欲望值: 80 },
        assessment: { kind: 'romantic_desire', intensity: 3, direction: 'increase' },
        nsfwConsentAssessment: 'in_scope',
    });
    assert.deepEqual({ field: heart30.field, delta: heart30.delta, nextValue: heart30.nextValue }, { field: '心动值', delta: 1, nextValue: 30 });
    assert.equal(heart30.progressUpdates.NSFW爱情阶段30已触发, true);
    assert.equal(Object.hasOwn(heart30.progressUpdates, 'NSFW共识亲密阶段30已触发'), false);
    assert.equal(Object.hasOwn(heart30.progressUpdates, 'NSFW路线锁定'), false);

    const desire40 = settle({
        contentMode: 'NSFW', relationship: { 友情值: 0, 心动值: 30, 欲望值: 39 },
        progress: progress({ NSFW爱情阶段30已触发: true }),
        assessment: { kind: 'sexual_desire', intensity: 2, direction: 'increase' },
        nsfwConsentAssessment: 'in_scope', turnId: 'msg_chat_1_p_2',
    });
    assert.equal(desire40.nextValue, 40);
    assert.equal(desire40.progressUpdates.NSFW共识亲密阶段40已触发, true);

    const directionGate = settle({
        contentMode: 'NSFW', relationship: { 友情值: 0, 心动值: 49, 欲望值: 40 },
        assessment: { kind: 'romantic_desire', intensity: 1, direction: 'increase' },
        nsfwConsentAssessment: 'in_scope', turnId: 'msg_chat_1_p_3',
    });
    assert.equal(directionGate.nextValue, 50);
    assert.equal(directionGate.progressUpdates.NSFW方向确认可用, true);
    assert.equal(Object.hasOwn(directionGate.progressUpdates, 'NSFW路线锁定'), false);
});

test('only-SFW keeps friendship available while pause/end and NSFW meetup fail closed', () => {
    const onlySfw = settle({
        contentMode: 'NSFW', relationship: { 友情值: 10, 心动值: 90, 欲望值: 90 },
        progress: progress({ 边界暂停状态: '仅SFW' }),
        assessment: { kind: 'friendly', intensity: 2, direction: 'increase' },
    });
    assert.deepEqual(
        { field: onlySfw.field, delta: onlySfw.delta, nextValue: onlySfw.nextValue },
        { field: '友情值', delta: 1, nextValue: 11 },
    );
    assert.equal(deriveMeetupAccess({ contentMode: 'SFW', relationship: { 友情值: 49, 心动值: 100, 欲望值: 100 } }).unlocked, false);
    assert.equal(deriveMeetupAccess({ contentMode: 'SFW', relationship: { 友情值: 50, 心动值: 0, 欲望值: 0 } }).route, '友情');
    const consent = grantNsfwConsent(createEmptyNsfwConsent(), { scopes: ['成人话题'], turns: 3 });
    assert.equal(deriveMeetupAccess({ contentMode: 'NSFW', relationship: { 友情值: 100, 心动值: 100, 欲望值: 100 } }).reason, 'nsfw_consent_required');
    assert.equal(deriveMeetupAccess({ contentMode: 'NSFW', relationship: { 友情值: 100, 心动值: 100, 欲望值: 100 }, nsfwConsent: consent }).reason, 'nsfw_direction_unconfirmed');
    assert.deepEqual(deriveMeetupAccess({
        contentMode: 'NSFW', relationship: { 心动值: 50, 欲望值: 100 },
        progress: progress({ NSFW方向确认可用: true, NSFW路线锁定: '爱情' }), nsfwConsent: consent,
    }), { unlocked: true, route: '恋爱', routes: ['恋爱'], reason: 'eligible' });
    assert.equal(deriveMeetupAccess({
        contentMode: 'NSFW', relationship: { 心动值: 100, 欲望值: 100 },
        progress: progress({ NSFW方向确认可用: true, NSFW路线锁定: '暂不定义' }), nsfwConsent: consent,
    }).reason, 'nsfw_direction_unconfirmed');
    assert.equal(deriveMeetupAccess({ contentMode: 'NSFW', relationship: { 友情值: 100 }, progress: progress({ 边界暂停状态: '仅SFW' }) }).reason, 'only_sfw');
    assert.equal(deriveMeetupAccess({ contentMode: 'SFW', relationship: { 友情值: 100 }, progress: progress({ 边界暂停状态: '暂停' }) }).reason, 'relationship_paused');
    assert.equal(deriveMeetupAccess({ contentMode: 'SFW', relationship: { 友情值: 100 }, progress: progress({ 关系结束状态: '结束联系' }) }).reason, 'relationship_ended');
});

test('SFW 60 direct understanding unlocks heart and closes ordinary positive farming', () => {
    const understood = settle({
        relationship: { 友情值: 59, 心动值: 0, 欲望值: 0 },
        sfwInsightAssessment: 'direct_understanding',
    });
    assert.equal(understood.nextValue, 60);
    assert.equal(understood.progressUpdates.SFW理解已检查, true);
    assert.equal(understood.progressUpdates.SFW心动已解锁, true);
    assert.equal(understood.progressUpdates.最近关系观察, '理解已确认');

    const ordinary = settle({
        relationship: { 友情值: 60, 心动值: 0, 欲望值: 0 },
        progress: progress({ SFW理解已检查: true, SFW心动已解锁: true }),
        turnId: 'msg_chat_1_p_2',
    });
    assert.deepEqual({ field: ordinary.field, delta: ordinary.delta }, { field: '', delta: 0 });
});

test('failed understanding requires active reveal plus later support before delayed dual routes open', () => {
    const missed = settle({
        relationship: { 友情值: 59, 心动值: 0, 欲望值: 0 },
        sfwInsightAssessment: 'not_yet',
    });
    assert.equal(missed.progressUpdates.SFW理解已检查, true);
    assert.equal(Object.hasOwn(missed.progressUpdates, 'SFW心动已解锁'), false);

    const reveal = settle({
        relationship: { 友情值: 60, 心动值: 0, 欲望值: 0 },
        progress: progress({ SFW理解已检查: true }),
        sfwInsightAssessment: 'active_reveal', turnId: 'msg_chat_1_p_2',
    });
    assert.equal(reveal.progressUpdates.SFW主动揭示已触发, true);
    const support = settle({
        relationship: { 友情值: 61, 心动值: 0, 欲望值: 0 },
        progress: progress({ SFW理解已检查: true, SFW主动揭示已触发: true }),
        sfwInsightAssessment: 'post_reveal_support', turnId: 'msg_chat_1_p_3',
    });
    assert.equal(support.progressUpdates.SFW心动已解锁, true);
});

test('SFW body-only heart reaches 100 only with a resolved wish and then accepts an explicit ending', () => {
    const heartCandidate = bodyCandidate({
        事件类别: '心愿完成或重定义',
        关系路线: 'SFW心动',
        允许影响关系值: ['心动值'],
    });
    const heart = settleBodyRelationshipCandidate({
        contentMode: 'SFW', relationship: { 友情值: 62, 心动值: 98 },
        progress: progress({ SFW理解已检查: true, SFW心动已解锁: true }),
        candidate: heartCandidate, turnId: 'msg_chat_1_p_8',
    });
    assert.deepEqual({ field: heart.field, nextValue: heart.nextValue, wish: heart.wishTrajectory }, {
        field: '心动值', nextValue: 100, wish: '重定义',
    });
    assert.equal(heart.progressUpdates.SFW双轨结局已解锁, true);

    const ending = settle({
        relationship: { 友情值: 62, 心动值: 100, 欲望值: 0 },
        progress: progress({ SFW理解已检查: true, SFW心动已解锁: true, SFW双轨结局已解锁: true }),
        assessment: { kind: 'none', intensity: 0, direction: 'none' },
        sfwResolutionAssessment: 'romance_confirmed', turnId: 'msg_chat_1_p_9',
    });
    assert.equal(ending.relationshipEndState, '恋人');
    assert.equal(ending.progressUpdates.最近关系观察, '结局确认');

    const immutable = settle({
        relationship: { 友情值: 62, 心动值: 100, 欲望值: 0 },
        progress: progress({
            SFW理解已检查: true, SFW心动已解锁: true, SFW双轨结局已解锁: true,
            关系结束状态: '恋人',
        }),
        assessment: { kind: 'none', intensity: 0, direction: 'none' },
        sfwResolutionAssessment: 'growth_confirmed', turnId: 'msg_chat_1_p_10',
    });
    assert.equal(immutable.relationshipEndState, '', 'a confirmed SFW ending cannot be rewritten by a later model reply');
    assert.equal(Object.hasOwn(immutable.progressUpdates, '最近关系观察'), false);
});

test('delayed dual friendship winning first settles deep friends and freezes heart', () => {
    const result = settleBodyRelationshipCandidate({
        contentMode: 'SFW', relationship: { 友情值: 98, 心动值: 45 },
        progress: progress({ SFW理解已检查: true, SFW主动揭示已触发: true, SFW心动已解锁: true }),
        candidate: bodyCandidate(), turnId: 'msg_chat_1_p_30',
    });
    assert.equal(result.nextValue, 100);
    assert.equal(result.progressUpdates.SFW双轨结局已解锁, true);
    assert.equal(result.progressUpdates.冻结关系值, '心动值');
    assert.equal(result.relationshipEndState, '深度朋友');
});

function bodyCandidate(overrides = {}) {
    return {
        事件ID: 'body:meetup_1:1',
        事件类别: '共同完成',
        关系路线: 'SFW友情',
        允许影响关系值: ['友情值'],
        建议方向: '正向',
        严重度: '明显',
        需再次确认: false,
        ...overrides,
    };
}

test('B.2 body candidates use only the global bounded deltas and atomically consume body IDs', () => {
    const positive = settleBodyRelationshipCandidate({
        contentMode: 'SFW', relationship: { 友情值: 98 }, progress: progress(),
        candidate: bodyCandidate(), turnId: 'msg_chat_1_p_9',
    });
    assert.deepEqual(
        { handled: positive.handled, consume: positive.consume, field: positive.field, delta: positive.delta, nextValue: positive.nextValue },
        { handled: true, consume: true, field: '友情值', delta: 2, nextValue: 100 },
    );
    assert.deepEqual(positive.progressUpdates.已消费事件ID, ['body:meetup_1:1']);
    assert.equal(positive.progressUpdates.最后结算回合UID, 'msg_chat_1_p_9');

    const crossesSharedMilestone = settleBodyRelationshipCandidate({
        contentMode: 'SFW', relationship: { 友情值: 39 }, progress: progress(),
        candidate: bodyCandidate(), turnId: 'msg_chat_1_p_13',
    });
    assert.equal(crossesSharedMilestone.nextValue, 41);
    assert.equal(crossesSharedMilestone.progressUpdates.SFW朋友分享已触发, true);

    const declineCases = [
        ['常规', -2], ['明显', -3], ['严重', -4],
    ];
    for (const [severity, expected] of declineCases) {
        const result = settleBodyRelationshipCandidate({
            contentMode: 'SFW', relationship: { 友情值: 80 }, progress: progress(),
            candidate: bodyCandidate({ 事件类别: '边界不匹配', 建议方向: '负向', 严重度: severity }),
            turnId: `msg_chat_1_p_${severity}`,
        });
        assert.equal(result.delta, expected);
    }
});

test('B.2 SFW candidates defer pending confirmation, consume a decline as zero, and require their route mode', () => {
    const pending = bodyCandidate({ 需再次确认: true });
    assert.equal(settleBodyRelationshipCandidate({
        contentMode: 'SFW', relationship: { 友情值: 40 }, progress: progress(), candidate: pending, turnId: 'msg_chat_1_p_10',
    }).status, 'awaiting_confirmation');
    const declined = settleBodyRelationshipCandidate({
        contentMode: 'SFW', relationship: { 友情值: 40 }, progress: progress(), candidate: pending,
        review: 'decline', turnId: 'msg_chat_1_p_10',
    });
    assert.deepEqual({ handled: declined.handled, consume: declined.consume, delta: declined.delta, status: declined.status }, {
        handled: true, consume: true, delta: 0, status: 'declined',
    });
    const explicitRetraction = settleBodyRelationshipCandidate({
        contentMode: 'SFW', relationship: { 友情值: 40 }, progress: progress(), candidate: bodyCandidate(),
        review: 'decline', turnId: 'msg_chat_1_p_10b',
    });
    assert.deepEqual({ handled: explicitRetraction.handled, consume: explicitRetraction.consume, delta: explicitRetraction.delta, status: explicitRetraction.status }, {
        handled: true, consume: true, delta: 0, status: 'declined',
    }, 'an explicit retraction must override a no-confirmation candidate');
    assert.equal(settleBodyRelationshipCandidate({
        contentMode: 'NSFW', relationship: { 友情值: 40 }, progress: progress(), candidate: bodyCandidate(), turnId: 'msg_chat_1_p_11',
    }).status, 'deferred');
});

test('stage C reviews only the selected NSFW body route, freezes the other rail, and closes ordinary farming afterward', () => {
    const loveCandidate = bodyCandidate({
        事件类别: '推进心愿', 关系路线: 'NSFW爱情', 允许影响关系值: ['心动值'],
    });
    const established = settleBodyRelationshipCandidate({
        contentMode: 'NSFW', relationship: { 友情值: 40, 心动值: 50, 欲望值: 65 },
        progress: progress({ NSFW方向确认可用: true, NSFW路线锁定: '爱情' }),
        candidate: loveCandidate, review: 'confirm', turnId: 'msg_chat_1_p_20',
    });
    assert.deepEqual({ field: established.field, delta: established.delta, nextValue: established.nextValue }, { field: '心动值', delta: 2, nextValue: 52 });
    assert.equal(established.progressUpdates.冻结关系值, '欲望值');
    assert.equal(established.progressUpdates.最后结算回合UID, 'msg_chat_1_p_20');

    const wrongRoute = settleBodyRelationshipCandidate({
        contentMode: 'NSFW', relationship: { 心动值: 50, 欲望值: 65 },
        progress: progress({ NSFW方向确认可用: true, NSFW路线锁定: '共识亲密' }),
        candidate: loveCandidate, review: 'confirm', turnId: 'msg_chat_1_p_21',
    });
    assert.equal(wrongRoute.status, 'deferred');

    const ordinaryAfterEstablishment = settle({
        contentMode: 'NSFW', relationship: { 友情值: 40, 心动值: 52, 欲望值: 65 },
        progress: progress({ NSFW方向确认可用: true, NSFW路线锁定: '爱情', 冻结关系值: '欲望值' }),
        assessment: { kind: 'romantic_desire', intensity: 3, direction: 'increase' },
        nsfwConsentAssessment: 'in_scope', turnId: 'msg_chat_1_p_22',
    });
    assert.equal(ordinaryAfterEstablishment.delta, 0);
});

test('a stale consumed body candidate is removable without suppressing a new ordinary chat settlement', () => {
    const result = settleBodyRelationshipCandidate({
        contentMode: 'SFW', relationship: { 友情值: 40 },
        progress: progress({ 已消费事件ID: ['body:meetup_1:1'] }),
        candidate: bodyCandidate(), turnId: 'msg_chat_1_p_12',
    });
    assert.deepEqual({ handled: result.handled, consume: result.consume, status: result.status, eventId: result.eventId }, {
        handled: false, consume: true, status: 'already_consumed', eventId: 'body:meetup_1:1',
    });
});
