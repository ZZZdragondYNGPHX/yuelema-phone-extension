import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSoulMatchPreferencePatch, validateControlledPatchAgainstState } from '../controlled-patch.js';

function state() {
    return {
        系统: { UID计数器: { 角色: 1, 会话: 0, 面基: 0 } },
        软件: { 内容模式: 'SFW', 关于软件点击数: 0 },
        玩家: { 成人验证: true, 公开资料: {}, 推荐偏好: { 标签权重: { SFW: { 电影: 1, 夜猫子: -2 }, NSFW: {} } } },
        角色池: {}, 推荐: { 当前队列: [], 临时候选池: {}, 冷却角色UID: [], 收藏角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [] }, 会话: {}, 面基记录: {},
    };
}

const draft = Object.freeze({
    tagWeightDraft: Object.freeze([Object.freeze({ tag: '电影', weight: 4 }), Object.freeze({ tag: '徒步', weight: 2 })]),
    explanation: '基于公开标签建议提高电影和徒步的权重。',
});

test('only a user-confirmed valid soul draft can produce exact public preference target writes', () => {
    const before = state();
    const result = buildSoulMatchPreferencePatch(before, { draft });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, [
        { op: 'replace', path: '/玩家/推荐偏好/标签权重/SFW/电影', value: 4 },
        { op: 'add', path: '/玩家/推荐偏好/标签权重/SFW/徒步', value: 2 },
    ]);
    assert.equal(validateControlledPatchAgainstState(before, result.value).ok, true);
    assert.deepEqual(before, state());
});

test('soul preference rejects invalid drafts, no-change drafts, and forged non-preference paths', () => {
    const before = state();
    assert.equal(buildSoulMatchPreferencePatch(before, { draft: { tagWeightDraft: [{ tag: '电影', weight: 4 }], explanation: '' } }).ok, false);
    const unchanged = { tagWeightDraft: [{ tag: '电影', weight: 1 }, { tag: '夜猫子', weight: -2 }], explanation: '公开偏好保持不变。' };
    assert.equal(buildSoulMatchPreferencePatch(before, { draft: unchanged }).code, 'soul_match_preference_no_change');
    assert.equal(validateControlledPatchAgainstState(before, [{ op: 'replace', path: '/系统/UID计数器/角色', value: 2 }]).ok, false);
});
