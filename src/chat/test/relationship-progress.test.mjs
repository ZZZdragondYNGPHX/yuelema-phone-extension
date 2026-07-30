import test from 'node:test';
import assert from 'node:assert/strict';

import {
    calculateBondDecline,
    calculateBondGrowth,
    deriveMeetupAccess,
    projectBondProgress,
    relationshipEventIdForTurn,
    settleRelationshipProgress,
} from '../relationship-progress.js';

function progress(overrides = {}) {
    return {
        SFW细微裂缝已触发: false,
        SFW朋友分享已触发: false,
        SFW面基已解锁: false,
        最后结算回合UID: '',
        已消费事件ID: [],
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

test('turn and event locks, pause, ending and frozen fields all settle to zero', () => {
    const turnId = 'msg_chat_1_p_1';
    assert.equal(settle({ progress: progress({ 最后结算回合UID: turnId }), turnId }).delta, 0);
    assert.equal(settle({ progress: progress({ 已消费事件ID: ['chat:1:1'] }), turnId }).delta, 0);
    assert.equal(settle({ progress: progress({ 边界暂停状态: '暂停' }), turnId }).delta, 0);
    assert.equal(settle({ progress: progress({ 关系结束状态: '深度朋友' }), turnId }).delta, 0);
    assert.equal(settle({ progress: progress({ 冻结关系值: '友情值' }), turnId }).delta, 0);
    assert.equal(settle({ replied: false, turnId }).delta, 0);
});

test('event IDs are local, bounded projections of player turn IDs only', () => {
    assert.equal(relationshipEventIdForTurn('msg_chat_abc-123_p_42'), 'chat:abc-123:42');
    assert.equal(relationshipEventIdForTurn('msg_chat_abc-123_n_42'), '');
    assert.equal(relationshipEventIdForTurn('untrusted-value'), '');
});

test('NSFW keeps its existing route gate for phase C but adopts the global bounded decline', () => {
    const result = settle({
        contentMode: 'NSFW', relationship: { 友情值: 20, 心动值: 40, 欲望值: 80 },
        assessment: { kind: 'sexual_desire', intensity: 3, direction: 'decrease' },
    });
    assert.deepEqual(
        { field: result.field, delta: result.delta, nextValue: result.nextValue },
        { field: '欲望值', delta: -4, nextValue: 76 },
    );
    assert.equal(settle({ contentMode: 'NSFW', assessment: { kind: 'friendly', intensity: 2, direction: 'increase' } }).delta, 0);
    assert.equal(deriveMeetupAccess({ contentMode: 'SFW', relationship: { 友情值: 49, 心动值: 100, 欲望值: 100 } }).unlocked, false);
    assert.equal(deriveMeetupAccess({ contentMode: 'SFW', relationship: { 友情值: 50, 心动值: 0, 欲望值: 0 } }).route, '友情');
    assert.equal(deriveMeetupAccess({ contentMode: 'NSFW', relationship: { 友情值: 50, 心动值: 50, 欲望值: 59 } }).unlocked, false);
    assert.equal(deriveMeetupAccess({ contentMode: 'NSFW', relationship: { 友情值: 60, 心动值: 70, 欲望值: 80 } }).route, '欲望');
});
