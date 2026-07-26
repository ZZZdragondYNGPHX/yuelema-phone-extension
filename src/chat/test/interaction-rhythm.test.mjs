import test from 'node:test';
import assert from 'node:assert/strict';

import { EARLY_CONVERSATION_LAYER_GRACE, computeInteractionPressure, decideInteractionRhythm, projectInteractionRelationship } from '../interaction-rhythm.js';

// 灵魂/描述匹配物化的固定初值（match-candidate-materializer.js）。
const calm = Object.freeze({ 好感: 20, 信任: 10, 戒备: 15, 面基意愿: 0 });
// 手动创建面板的固定初值（character-creator-panel.js baseCandidate）。
const freshManual = Object.freeze({ 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 });
const neutralDelta = Object.freeze({ 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 });
const pastGrace = EARLY_CONVERSATION_LAYER_GRACE + 4;

test('interaction pressure is deterministic and excludes meetup intent', () => {
    assert.equal(computeInteractionPressure(calm), 30);
    assert.equal(computeInteractionPressure({ ...calm, 面基意愿: 100 }), 30);
    assert.equal(computeInteractionPressure({ 好感: 0, 信任: 0, 戒备: 100, 面基意愿: 0 }), 100);
});

test('freshly generated relationships keep a wide margin below the default read threshold', () => {
    // 校准回归防线：两类固定初值来源的开局压力必须明显低于默认已读不回阈值 55。
    assert.equal(computeInteractionPressure(calm), 30);
    assert.equal(computeInteractionPressure(freshManual), 30);
    assert.ok(55 - computeInteractionPressure(calm) >= 20);
    assert.ok(55 - computeInteractionPressure(freshManual) >= 20);
});

test('relationship projection applies only bounded local deltas with clamping', () => {
    assert.deepEqual(projectInteractionRelationship(
        { 好感: 98, 信任: 2, 戒备: 4, 面基意愿: 100 },
        { 好感: 10, 信任: -10, 戒备: -10, 面基意愿: 4 },
    ), { 好感: 100, 信任: 0, 戒备: 0, 面基意愿: 100 });
    assert.equal(projectInteractionRelationship(calm, { ...neutralDelta, 戒备: 11 }), null);
});

test('a typical first message from a freshly matched character is replied', () => {
    for (const relationship of [calm, freshManual]) {
        const result = decideInteractionRhythm({
            relationship,
            responseRelationship: neutralDelta,
            readWithoutReplyThreshold: 55,
            blockThreshold: 90,
            dialogueLayers: 0,
        });
        assert.equal(result.outcome, 'replied');
        assert.equal(result.pressure, 30);
    }
});

test('one hostile turn from a fresh match still gets a reply; silence requires sustained deterioration', () => {
    const worstTurn = { 好感: -10, 信任: -10, 戒备: 10, 面基意愿: 0 };
    const first = decideInteractionRhythm({
        relationship: calm,
        responseRelationship: worstTurn,
        readWithoutReplyThreshold: 55,
        blockThreshold: 90,
        dialogueLayers: pastGrace,
    });
    // 20/10/15 → 10/0/25：25 + 10 + 15 = 50 < 55。
    assert.equal(first.outcome, 'replied');
    assert.equal(first.pressure, 50);
    const second = decideInteractionRhythm({
        relationship: first.projectedRelationship,
        responseRelationship: worstTurn,
        readWithoutReplyThreshold: 55,
        blockThreshold: 90,
        dialogueLayers: pastGrace,
    });
    // 10/0/25 → 0/0/35：35 + 15 + 15 = 65 ≥ 55，且未改善 → 已读不回。
    assert.equal(second.outcome, 'read_without_reply');
    assert.equal(second.pressure, 65);
});

test('read-without-reply suppresses replies when pressure stays at or above its threshold', () => {
    const result = decideInteractionRhythm({
        relationship: { 好感: 5, 信任: 5, 戒备: 40, 面基意愿: 0 },
        responseRelationship: neutralDelta,
        readWithoutReplyThreshold: 55,
        blockThreshold: 90,
        dialogueLayers: pastGrace,
    });
    // 40 + 12.5 + 12.5 = 65 ≥ 55，压力未下降 → 已读不回。
    assert.equal(result.outcome, 'read_without_reply');
    assert.equal(result.pressure, 65);
});

test('positive interaction walks out of read-without-reply even while still above the threshold', () => {
    const strained = { 好感: 5, 信任: 5, 戒备: 60, 面基意愿: 0 };
    const stuck = decideInteractionRhythm({
        relationship: strained,
        responseRelationship: neutralDelta,
        readWithoutReplyThreshold: 55,
        blockThreshold: 90,
        dialogueLayers: pastGrace,
    });
    assert.equal(stuck.outcome, 'read_without_reply');
    const improving = decideInteractionRhythm({
        relationship: strained,
        responseRelationship: { 好感: 6, 信任: 6, 戒备: -8, 面基意愿: 0 },
        readWithoutReplyThreshold: 55,
        blockThreshold: 90,
        dialogueLayers: pastGrace,
    });
    // 11/11/52：52 + 9.5 + 9.5 = 71，仍 ≥ 55 但已改善 → 回复（确定性恢复路径）。
    assert.equal(improving.outcome, 'replied');
    assert.equal(improving.pressure, 71);
    assert.ok(improving.pressure < stuck.pressure);
});

test('block takes precedence when thresholds overlap after the grace window', () => {
    const result = decideInteractionRhythm({
        relationship: { 好感: 0, 信任: 0, 戒备: 90, 面基意愿: 0 },
        responseRelationship: neutralDelta,
        readWithoutReplyThreshold: 50,
        blockThreshold: 80,
        dialogueLayers: pastGrace,
    });
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.pressure, 100);
});

test('omitting dialogueLayers keeps the legacy no-grace decision', () => {
    const result = decideInteractionRhythm({
        relationship: { 好感: 0, 信任: 0, 戒备: 90, 面基意愿: 0 },
        responseRelationship: neutralDelta,
        readWithoutReplyThreshold: 50,
        blockThreshold: 80,
    });
    assert.equal(result.outcome, 'blocked');
});

test('early conversation grace never blocks and replies on non-worsening turns', () => {
    // 模拟生成侧失准的角色：开局压力 75 已超过其拉黑阈值 70。
    const miscalibrated = { 好感: 20, 信任: 10, 戒备: 60, 面基意愿: 0 };
    const neutral = decideInteractionRhythm({
        relationship: miscalibrated,
        responseRelationship: neutralDelta,
        readWithoutReplyThreshold: 50,
        blockThreshold: 70,
        dialogueLayers: 0,
    });
    // 宽限期内、压力未上升 → 必定回复（第一条消息不可能被拉黑/已读不回）。
    assert.equal(neutral.outcome, 'replied');
    const worsening = decideInteractionRhythm({
        relationship: miscalibrated,
        responseRelationship: { 好感: -10, 信任: -10, 戒备: 10, 面基意愿: 0 },
        readWithoutReplyThreshold: 50,
        blockThreshold: 70,
        dialogueLayers: 2,
    });
    // 宽限期内恶化：最重只能是已读不回，绝不直接拉黑。
    assert.equal(worsening.outcome, 'read_without_reply');
    const afterGrace = decideInteractionRhythm({
        relationship: miscalibrated,
        responseRelationship: neutralDelta,
        readWithoutReplyThreshold: 50,
        blockThreshold: 70,
        dialogueLayers: EARLY_CONVERSATION_LAYER_GRACE,
    });
    // 宽限一结束，恶化不改善的关系仍会拉黑（成年/安全语义不变）。
    assert.equal(afterGrace.outcome, 'blocked');
});

test('invalid thresholds, layers or relationship data are rejected', () => {
    assert.equal(decideInteractionRhythm({ relationship: calm, responseRelationship: neutralDelta, readWithoutReplyThreshold: -1, blockThreshold: 90 }), null);
    assert.equal(decideInteractionRhythm({ relationship: calm, responseRelationship: { ...neutralDelta, 信任: 1.5 }, readWithoutReplyThreshold: 55, blockThreshold: 90 }), null);
    assert.equal(decideInteractionRhythm({ relationship: calm, responseRelationship: neutralDelta, readWithoutReplyThreshold: 55, blockThreshold: 90, dialogueLayers: -1 }), null);
    assert.equal(decideInteractionRhythm({ relationship: calm, responseRelationship: neutralDelta, readWithoutReplyThreshold: 55, blockThreshold: 90, dialogueLayers: 1.5 }), null);
});
