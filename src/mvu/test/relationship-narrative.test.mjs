import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createEmptyRelationshipNarrative,
    createRelationshipNarrativeFromProfile,
    validateRelationshipNarrative,
} from '../relationship-narrative.js';
import { buildRelationshipNarrativeBackfillPatch } from '../controlled-patch.js';

function role() {
    return {
        成人验证: true,
        公开资料: {
            昵称: '林澈', 头像引用: '', 年龄段: '25-29', 性别: '女', 性取向: '双性恋',
            城市: '上海', 距离范围: '10 km', 寻找意图: '先聊天再认真约会', 简介: '喜欢旧书店和夜间散步。',
            兴趣标签: ['旧书店', '爵士乐'], 生活方式标签: ['夜猫子'], 性格标签: ['慢热'], 沟通风格标签: ['坦诚'],
        },
        仅好友资料: { 关系状态: '单身', 边界与偏好: '需要先确认安排，也希望承诺能被兑现。' },
        隐藏资料: { 实际年龄: 27, 私人备注: '曾放弃独立书店计划，仍会收集旧书票。' },
    };
}

test('protected narrative is deterministically seeded only from an already authored role profile', () => {
    const seeded = createRelationshipNarrativeFromProfile(role());
    assert.equal(validateRelationshipNarrative(seeded).ok, true);
    assert.match(seeded.人生底色.公开轮廓, /林澈/u);
    assert.equal(seeded.人生底色.关键经历, '曾放弃独立书店计划，仍会收集旧书票。');
    assert.equal(seeded.未竟心愿.真实需要, '需要先确认安排，也希望承诺能被兑现。');
    assert.equal(seeded.未竟心愿.变化轨迹, '坚持');
    assert.equal(seeded.进程.SFW主动揭示已触发, false);
    assert.equal(seeded.进程.最近关系观察, '');
});
test('backfill fills an empty legacy slot but never overwrites existing protected narrative', () => {
    const empty = createEmptyRelationshipNarrative();
    const emptyState = { 角色池: { npc_one: role() }, 关系叙事: { npc_one: empty } };
    const filled = buildRelationshipNarrativeBackfillPatch(emptyState);
    assert.equal(filled.ok, true);
    assert.equal(filled.value.length, 1);
    assert.equal(filled.value[0].op, 'replace');
    assert.match(filled.value[0].value.人生底色.公开轮廓, /林澈/u);

    const retained = createRelationshipNarrativeFromProfile(role());
    retained.人生底色.关键经历 = '用户已有的受保护叙事，不得覆盖。';
    delete retained.进程.SFW主动揭示已触发;
    delete retained.进程.最近关系观察;
    const existingState = { 角色池: { npc_one: role() }, 关系叙事: { npc_one: retained } };
    const migrated = buildRelationshipNarrativeBackfillPatch(existingState);
    assert.equal(migrated.ok, true);
    assert.deepEqual(migrated.value.map((operation) => operation.path), [
        '/关系叙事/npc_one/进程/SFW主动揭示已触发',
        '/关系叙事/npc_one/进程/最近关系观察',
    ]);
    assert.equal(retained.人生底色.关键经历, '用户已有的受保护叙事，不得覆盖。');
});
