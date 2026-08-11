import assert from 'node:assert/strict';
import test from 'node:test';

import {
    bodyRelationshipEventIdForSource,
    createEmptyBodyRelationshipCandidate,
    projectPendingBodyRelationshipCandidate,
    selectPendingBodyRelationshipCandidate,
    validateBodyRelationshipCandidate,
} from '../body-relationship-candidate.js';

function pendingCandidate(overrides = {}) {
    return {
        ...createEmptyBodyRelationshipCandidate(),
        状态: '待复盘',
        角色UID: 'npc_one',
        事件ID: bodyRelationshipEventIdForSource('meetup_one', 1),
        来源面基UID: 'meetup_one',
        来源摘要版本: 1,
        事件类别: '兑现承诺',
        关系路线: 'SFW友情',
        允许影响关系值: ['友情值'],
        建议方向: '正向',
        严重度: '常规',
        证据摘要: '双方按此前约定完成散步，并尊重彼此的节奏。',
        需再次确认: true,
        ...overrides,
    };
}

function candidateState({ candidate = pendingCandidate(), source = {}, roles = { npc_one: {} } } = {}) {
    return {
        角色池: roles,
        正文关系候选: { npc_one: candidate },
        面基记录: {
            meetup_one: {
                对象UID: 'npc_one',
                状态: '已结束',
                关系路线: '友情',
                正文结果摘要: '两人完成约定的散步，交流自然，也保留了各自的舒适边界。',
                ...source,
            },
        },
    };
}

test('empty B.2 slot is strict and selects as no actionable candidate', () => {
    const empty = createEmptyBodyRelationshipCandidate();
    assert.deepEqual(empty, {
        版本: 1,
        状态: '空',
        角色UID: '',
        事件ID: '',
        来源面基UID: '',
        来源摘要版本: 0,
        事件类别: '',
        关系路线: '',
        允许影响关系值: [],
        建议方向: '无变化',
        严重度: '无',
        证据摘要: '',
        需再次确认: false,
    });
    assert.equal(validateBodyRelationshipCandidate(empty).ok, true);
    assert.deepEqual(
        selectPendingBodyRelationshipCandidate(candidateState({ candidate: empty }), 'npc_one'),
        { ok: true, value: null },
    );
});

test('legal pending candidate is selected and its projection leaks no internal anchors', () => {
    const candidate = pendingCandidate();
    const selected = selectPendingBodyRelationshipCandidate(candidateState({ candidate }), 'npc_one');
    assert.equal(selected.ok, true);
    assert.equal(selected.value.事件ID, 'body:meetup_one:1');

    const projected = projectPendingBodyRelationshipCandidate(selected.value);
    assert.deepEqual(projected, {
        事件类别: '兑现承诺',
        关系路线: 'SFW友情',
        证据摘要: '双方按此前约定完成散步，并尊重彼此的节奏。',
        需再次确认: true,
    });
    for (const field of ['角色UID', '事件ID', '来源面基UID', '来源摘要版本', '版本', '状态']) {
        assert.equal(Object.hasOwn(projected, field), false);
    }
    assert.equal(JSON.stringify(projected).includes('meetup_one'), false);
});

test('selection rejects a pending candidate whose role UID differs from its slot key', () => {
    const candidate = pendingCandidate({ 角色UID: 'npc_other' });
    const result = selectPendingBodyRelationshipCandidate(candidateState({
        candidate,
        roles: { npc_one: {}, npc_other: {} },
    }), 'npc_one');
    assert.deepEqual(result, { ok: false, code: 'body_relationship_candidate_uid_mismatch' });
});

test('event id and source-summary version are B.2-only and fail closed', () => {
    assert.equal(bodyRelationshipEventIdForSource('meetup_one', 1), 'body:meetup_one:1');
    assert.equal(bodyRelationshipEventIdForSource('meetup_one', 2), '');
    assert.equal(bodyRelationshipEventIdForSource('bad_meetup', 1), '');
    assert.equal(validateBodyRelationshipCandidate(pendingCandidate({
        来源摘要版本: 2,
        事件ID: 'body:meetup_one:2',
    })).ok, false);
    assert.equal(validateBodyRelationshipCandidate(pendingCandidate({
        事件ID: 'body:meetup_other:1',
    })).ok, false);
});

test('selection requires an ended friendship-route source meetup for the same role', () => {
    const unfinished = selectPendingBodyRelationshipCandidate(candidateState({
        source: { 状态: '正文进行中' },
    }), 'npc_one');
    assert.deepEqual(unfinished, { ok: false, code: 'body_relationship_candidate_source_not_completed' });

    const wrongObject = selectPendingBodyRelationshipCandidate(candidateState({
        source: { 对象UID: 'npc_other' },
    }), 'npc_one');
    assert.deepEqual(wrongObject, { ok: false, code: 'body_relationship_candidate_source_uid_mismatch' });
});

test('stage C accepts only the selected NSFW route field and its matching ended meetup route', () => {
    const love = pendingCandidate({
        事件类别: '推进心愿', 关系路线: 'NSFW爱情', 允许影响关系值: ['心动值'],
    });
    assert.equal(validateBodyRelationshipCandidate(love).ok, true);
    assert.equal(selectPendingBodyRelationshipCandidate(candidateState({ candidate: love, source: { 关系路线: '恋爱' } }), 'npc_one').ok, true);
    assert.equal(selectPendingBodyRelationshipCandidate(candidateState({ candidate: love, source: { 关系路线: '欲望' } }), 'npc_one').code, 'body_relationship_candidate_source_route_invalid');

    const intimacy = pendingCandidate({
        事件类别: '明确同意', 关系路线: 'NSFW共识亲密', 允许影响关系值: ['欲望值'],
    });
    assert.equal(validateBodyRelationshipCandidate(intimacy).ok, true);
    assert.equal(selectPendingBodyRelationshipCandidate(candidateState({ candidate: intimacy, source: { 关系路线: '欲望' } }), 'npc_one').ok, true);
    assert.equal(validateBodyRelationshipCandidate(pendingCandidate({
        关系路线: 'NSFW爱情', 允许影响关系值: ['欲望值'],
    })).ok, false);
});

test('stage B accepts the SFW heart route only with its fixed field and wish-resolution category', () => {
    const heart = pendingCandidate({
        事件类别: '心愿完成或重定义',
        关系路线: 'SFW心动',
        允许影响关系值: ['心动值'],
    });
    assert.equal(validateBodyRelationshipCandidate(heart).ok, true);
    assert.equal(selectPendingBodyRelationshipCandidate(candidateState({ candidate: heart }), 'npc_one').ok, true);
    assert.equal(validateBodyRelationshipCandidate(pendingCandidate({
        关系路线: 'SFW心动',
        允许影响关系值: ['友情值'],
    })).ok, false);
});

test('illegal enums, effect arrays, getters, control text, and markup are rejected', () => {
    assert.equal(validateBodyRelationshipCandidate(pendingCandidate({
        事件类别: '停止或降级',
        建议方向: '正向',
        严重度: '明显',
    })).ok, false);
    assert.equal(validateBodyRelationshipCandidate(pendingCandidate({
        允许影响关系值: ['友情值', '心动值'],
    })).ok, false);
    assert.equal(validateBodyRelationshipCandidate(pendingCandidate({
        证据摘要: '<b>不应进入候选</b>',
    })).ok, false);
    assert.equal(validateBodyRelationshipCandidate(pendingCandidate({
        证据摘要: '包含\u0000控制字符',
    })).ok, false);

    const getterCandidate = pendingCandidate();
    Object.defineProperty(getterCandidate, '证据摘要', {
        enumerable: true,
        get() {
            throw new Error('getter must not execute');
        },
    });
    assert.deepEqual(validateBodyRelationshipCandidate(getterCandidate), {
        ok: false,
        code: 'body_relationship_candidate_invalid',
    });
});
