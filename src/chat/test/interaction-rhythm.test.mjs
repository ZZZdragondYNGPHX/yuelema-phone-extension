import test from 'node:test';
import assert from 'node:assert/strict';

import { computeInteractionPressure, decideInteractionRhythm, projectInteractionRelationship } from '../interaction-rhythm.js';

const calm = Object.freeze({ 好感: 20, 信任: 10, 戒备: 15, 面基意愿: 0 });
const neutralDelta = Object.freeze({ 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 });

test('interaction pressure is deterministic and excludes meetup intent', () => {
    assert.equal(computeInteractionPressure(calm), 50);
    assert.equal(computeInteractionPressure({ ...calm, 面基意愿: 100 }), 50);
    assert.equal(computeInteractionPressure({ 好感: 0, 信任: 0, 戒备: 100, 面基意愿: 0 }), 100);
});

test('relationship projection applies only bounded local deltas with clamping', () => {
    assert.deepEqual(projectInteractionRelationship(
        { 好感: 98, 信任: 2, 戒备: 4, 面基意愿: 100 },
        { 好感: 10, 信任: -10, 戒备: -10, 面基意愿: 4 },
    ), { 好感: 100, 信任: 0, 戒备: 0, 面基意愿: 100 });
    assert.equal(projectInteractionRelationship(calm, { ...neutralDelta, 戒备: 11 }), null);
});

test('normal rhythm replies below the read-without-reply threshold', () => {
    const result = decideInteractionRhythm({
        relationship: calm,
        responseRelationship: neutralDelta,
        readWithoutReplyThreshold: 55,
        blockThreshold: 90,
    });
    assert.equal(result.outcome, 'replied');
    assert.equal(result.pressure, 50);
});

test('read-without-reply suppresses replies at its threshold', () => {
    const result = decideInteractionRhythm({
        relationship: calm,
        responseRelationship: { 好感: -10, 信任: 0, 戒备: 5, 面基意愿: 0 },
        readWithoutReplyThreshold: 55,
        blockThreshold: 90,
    });
    assert.equal(result.outcome, 'read_without_reply');
    assert.equal(result.pressure, 60);
});

test('block takes precedence when thresholds overlap', () => {
    const result = decideInteractionRhythm({
        relationship: { 好感: 0, 信任: 0, 戒备: 90, 面基意愿: 0 },
        responseRelationship: neutralDelta,
        readWithoutReplyThreshold: 50,
        blockThreshold: 80,
    });
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.pressure, 100);
});

test('invalid thresholds or relationship data are rejected', () => {
    assert.equal(decideInteractionRhythm({ relationship: calm, responseRelationship: neutralDelta, readWithoutReplyThreshold: -1, blockThreshold: 90 }), null);
    assert.equal(decideInteractionRhythm({ relationship: calm, responseRelationship: { ...neutralDelta, 信任: 1.5 }, readWithoutReplyThreshold: 55, blockThreshold: 90 }), null);
});
