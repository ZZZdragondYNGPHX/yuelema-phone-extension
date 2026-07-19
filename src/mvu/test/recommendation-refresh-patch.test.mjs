import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCharacterRegistrationPatch, buildRecommendationInitialCandidatePatch, buildRecommendationRefreshPatch, validateControlledPatchAgainstState } from '../controlled-patch.js';

function candidate() {
    return {
        成人验证: true,
        公开资料: { 昵称: '新候选', 头像引用: '', 年龄段: '25-29', 性别: '女', 性取向: '双性恋', 城市: '上海', 距离范围: '10 km', 寻找意图: '聊天约会', 简介: '热爱看展。', 兴趣标签: ['电影'], 生活方式标签: ['夜猫子'], 性格标签: ['直接'], 沟通风格标签: ['慢热'] },
        仅好友资料: { 关系状态: '单身', 边界与偏好: '尊重拒绝。' },
        隐藏资料: { 实际年龄: 28, 私人备注: '不渲染。' },
        偏好与边界: '确认边界。', 拒绝阈值: 35, 已读不回阈值: 55, 取消匹配阈值: 75, 拉黑阈值: 90,
        与玩家关系: { 状态: '陌生', 全局账号表现: 60, NPC专属匹配度: 70, 好感: 0, 信任: 0, 戒备: 20, 面基意愿: 0 },
    };
}

function state() {
    return {
        系统: { UID计数器: { 角色: 12 } }, 软件: { 内容模式: 'SFW', 关于软件点击数: 0 }, 角色池: {},
        推荐: { 当前队列: ['npc_old'], 临时候选池: { npc_old: { 成人验证: true, 公开资料: {}, 仅好友资料: {}, 隐藏资料: { 实际年龄: 30, 私人备注: '旧秘密' }, 与玩家关系: { 状态: '陌生' } } }, 冷却角色UID: [], 收藏角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [] },
    };
}

test('generated refresh is one exact atomic transition with a fresh UID', () => {
    const patch = buildRecommendationRefreshPatch(state(), { replacedNpcUid: 'npc_old', candidate: candidate() });
    assert.equal(patch.ok, true);
    assert.deepEqual(patch.value.map((item) => item.path), ['/推荐/冷却角色UID/-', '/推荐/当前队列/0', '/推荐/临时候选池/npc_llm_13', '/推荐/当前队列/-', '/系统/UID计数器/角色']);
    assert.equal(validateControlledPatchAgainstState(state(), patch.value).ok, true);
});

test('generated refresh returns cloned patch data and never mutates the pre-commit state', () => {
    const current = state();
    const generated = candidate();
    const stateBefore = structuredClone(current);
    const candidateBefore = structuredClone(generated);

    const patch = buildRecommendationRefreshPatch(current, { replacedNpcUid: 'npc_old', candidate: generated });

    assert.equal(patch.ok, true);
    assert.deepEqual(current, stateBefore);
    assert.deepEqual(generated, candidateBefore);
    assert.notStrictEqual(patch.value[2].value, generated);
    assert.equal(patch.value[2].value.隐藏资料.实际年龄, 28);
});

test('generated refresh rejects altered sequence or invalid adult data before MVU parsing', () => {
    const patch = buildRecommendationRefreshPatch(state(), { replacedNpcUid: 'npc_old', candidate: candidate() });
    const forged = structuredClone(patch.value);
    forged[4].value = 42;
    assert.equal(validateControlledPatchAgainstState(state(), forged).ok, false);
    const underage = candidate(); underage.隐藏资料.实际年龄 = 17;
    assert.equal(buildRecommendationRefreshPatch(state(), { replacedNpcUid: 'npc_old', candidate: underage }).ok, false);
});

test('refresh refuses a candidate that is no longer in the visible queue', () => {
    const current = state();
    current.推荐.当前队列 = [];
    const before = structuredClone(current);

    const result = buildRecommendationRefreshPatch(current, { replacedNpcUid: 'npc_old', candidate: candidate() });

    assert.deepEqual(result, { ok: false, code: 'recommendation_refresh_source_not_queued', detail: '' });
    assert.deepEqual(current, before);
});
test('registers a complete user-authored adult candidate through one exact add-only patch', () => {
    const before = state();
    const candidateInput = candidate();
    const patch = buildCharacterRegistrationPatch(before, { candidate: candidateInput });

    assert.equal(patch.ok, true);
    assert.deepEqual(patch.value.map((operation) => operation.path), [
        '/推荐/临时候选池/npc_custom_13', '/推荐/当前队列/-', '/系统/UID计数器/角色',
    ]);
    assert.equal(validateControlledPatchAgainstState(before, patch.value).ok, true);
    assert.equal(JSON.stringify(patch.value).includes('私人备注'), true);
    assert.deepEqual(before, state());
    assert.deepEqual(candidateInput, candidate());
});

test('registration rejects forged uid and incomplete candidate data before MVU parsing', () => {
    const built = buildCharacterRegistrationPatch(state(), { candidate: candidate() });
    const forged = structuredClone(built.value);
    forged[0].path = '/推荐/临时候选池/npc_forged';
    assert.equal(validateControlledPatchAgainstState(state(), forged).ok, false);

    const incomplete = candidate();
    delete incomplete.仅好友资料;
    assert.equal(buildCharacterRegistrationPatch(state(), { candidate: incomplete }).ok, false);
});


test('initial fast-model candidate seeds only an empty queue through one exact patch', () => {
    const current = state();
    current.推荐.当前队列 = [];
    current.推荐.临时候选池 = {};
    const before = structuredClone(current);

    const patch = buildRecommendationInitialCandidatePatch(current, { candidate: candidate() });

    assert.equal(patch.ok, true);
    assert.deepEqual(patch.value.map((item) => item.path), [
        '/推荐/临时候选池/npc_llm_13', '/推荐/当前队列/-', '/系统/UID计数器/角色',
    ]);
    assert.equal(validateControlledPatchAgainstState(current, patch.value).ok, true);
    assert.deepEqual(current, before);
});

test('initial fast-model candidate rejects existing queue, invalid age, and forged patch with zero mutation', () => {
    const occupied = state();
    const occupiedBefore = structuredClone(occupied);
    assert.deepEqual(buildRecommendationInitialCandidatePatch(occupied, { candidate: candidate() }), {
        ok: false, code: 'recommendation_initial_queue_not_empty', detail: '',
    });
    assert.deepEqual(occupied, occupiedBefore);

    const empty = state();
    empty.推荐.当前队列 = [];
    empty.推荐.临时候选池 = {};
    const underage = candidate();
    underage.隐藏资料.实际年龄 = 17;
    assert.equal(buildRecommendationInitialCandidatePatch(empty, { candidate: underage }).ok, false);

    const built = buildRecommendationInitialCandidatePatch(empty, { candidate: candidate() });
    const forged = structuredClone(built.value);
    forged[0].path = '/推荐/临时候选池/npc_custom_13';
    assert.equal(validateControlledPatchAgainstState(empty, forged).ok, false);
});
