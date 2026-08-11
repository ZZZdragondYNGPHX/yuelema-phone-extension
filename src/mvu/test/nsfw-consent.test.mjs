import test from 'node:test';
import assert from 'node:assert/strict';

import {
    closeNsfwConsent,
    consumeNsfwConsent,
    createEmptyNsfwConsent,
    grantNsfwConsent,
    matchesNsfwConsentReference,
    nsfwConsentReference,
    validateNsfwConsent,
} from '../nsfw-consent.js';

test('C.2 consent envelopes are exact, scoped, bounded, and contain no free-form adult text', () => {
    const empty = createEmptyNsfwConsent();
    assert.equal(validateNsfwConsent(empty).ok, true);
    const active = grantNsfwConsent(empty, { scopes: ['线上文爱', '成人话题'], turns: 3 });
    assert.deepEqual(active, {
        版本: 1, 状态: '有效', 允许范围: ['成人话题', '线上文爱'], 剩余轮数: 3, 来源: '玩家私聊工具', 修订号: 1,
    });
    assert.equal(validateNsfwConsent(active).ok, true);
    assert.equal(grantNsfwConsent(empty, { scopes: ['任意原始文本'], turns: 3 }), null);
    assert.equal(grantNsfwConsent(empty, { scopes: ['成人话题'], turns: 99 }), null);
    assert.equal(validateNsfwConsent({ ...active, 任意字段: '禁止' }).ok, false);
    assert.equal(validateNsfwConsent({ ...active, 剩余轮数: 0 }).ok, false);
});

test('C.2 consent is revision-bound, consumed per committed turn, and expires or revokes without retaining scopes', () => {
    const active = grantNsfwConsent(createEmptyNsfwConsent(), { scopes: ['成人话题', '露骨调情'], turns: 3 });
    const reference = nsfwConsentReference(active);
    assert.equal(matchesNsfwConsentReference(active, reference), true);
    const consumed = consumeNsfwConsent(active);
    assert.equal(consumed.状态, '有效');
    assert.equal(consumed.剩余轮数, 2);
    assert.equal(consumed.修订号, 2);
    assert.equal(matchesNsfwConsentReference(consumed, reference), false);
    const oneTurn = grantNsfwConsent(consumed, { scopes: ['线上文爱'], turns: 1 });
    const expired = consumeNsfwConsent(oneTurn);
    assert.deepEqual(expired.允许范围, []);
    assert.equal(expired.状态, '已过期');
    assert.equal(expired.剩余轮数, 0);
    const revoked = closeNsfwConsent(active);
    assert.equal(revoked.状态, '已撤回');
    assert.deepEqual(revoked.允许范围, []);
});

test('C.2 consent rejects accessors, sparse arrays, duplicates, and forged revisions', () => {
    const active = grantNsfwConsent(createEmptyNsfwConsent(), { scopes: ['成人话题'], turns: 1 });
    const accessor = { ...active };
    Object.defineProperty(accessor, '状态', { enumerable: true, get() { return '有效'; } });
    assert.equal(validateNsfwConsent(accessor).ok, false);
    const sparse = { ...active, 允许范围: new Array(1) };
    assert.equal(validateNsfwConsent(sparse).ok, false);
    assert.equal(validateNsfwConsent({ ...active, 允许范围: ['成人话题', '成人话题'] }).ok, false);
    assert.equal(validateNsfwConsent({ ...active, 修订号: 0 }).ok, false);
});
