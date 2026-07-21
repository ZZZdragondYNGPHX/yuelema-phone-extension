import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperationActivity, OPERATION_ACTIVITY_MAX_ENTRIES } from '../operation-activity.js';

function tickingClock(...timestamps) {
    let index = 0;
    return () => timestamps[Math.min(index++, timestamps.length - 1)];
}

test('start, succeed, and fail expose only safe display fields', () => {
    const activity = createOperationActivity({
        now: tickingClock(
            '2026-07-21T08:00:00.000Z',
            '2026-07-21T08:00:01.000Z',
            '2026-07-21T08:00:02.000Z',
            '2026-07-21T08:00:03.000Z',
        ),
    });

    const soulMatch = activity.start('灵魂匹配', '灵魂匹配中……');
    const voiceMatch = activity.start('语音匹配', '正在寻找合拍的声音……');
    assert.equal(typeof soulMatch, 'symbol');
    assert.equal(typeof voiceMatch, 'symbol');

    assert.equal(activity.succeed(soulMatch, '灵魂匹配成功，正在打开私聊。'), true);
    assert.equal(activity.fail(voiceMatch, '语音匹配未成功，请稍后再试。'), true);

    const result = activity.snapshot();
    assert.deepEqual(result.current, []);
    assert.deepEqual(result.entries, [
        {
            name: '语音匹配', message: '语音匹配未成功，请稍后再试。', status: 'failure',
            startedAt: '2026-07-21T08:00:01.000Z', updatedAt: '2026-07-21T08:00:03.000Z',
        },
        {
            name: '灵魂匹配', message: '灵魂匹配成功，正在打开私聊。', status: 'success',
            startedAt: '2026-07-21T08:00:00.000Z', updatedAt: '2026-07-21T08:00:02.000Z',
        },
    ]);
    assert.deepEqual(Object.keys(result.entries[0]).sort(), ['message', 'name', 'startedAt', 'status', 'updatedAt']);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.entries), true);
    assert.equal(Object.isFrozen(result.entries[0]), true);
});

test('the feed keeps at most thirty newest entries and invalidates trimmed handles', () => {
    const activity = createOperationActivity({ maxEntries: 999, now: () => 0 });
    const handles = [];
    for (let index = 0; index < OPERATION_ACTIVITY_MAX_ENTRIES + 2; index += 1) {
        handles.push(activity.start(`操作${index}`, `操作${index}进行中……`));
    }

    const result = activity.snapshot();
    assert.equal(result.entries.length, 30);
    assert.equal(result.entries[0].name, '操作31');
    assert.equal(result.entries.at(-1).name, '操作2');
    assert.equal(activity.succeed(handles[0], '不应更新已淘汰条目。'), false);
    assert.equal(activity.succeed(handles.at(-1), '最新操作已完成。'), true);
});

test('subscribe receives immutable snapshots and unsubscribe stops later notifications', () => {
    const activity = createOperationActivity({ now: () => 0 });
    const received = [];
    const unsubscribe = activity.subscribe((value) => received.push(value));

    const handle = activity.start('收藏主动私聊', '正在发起私聊……');
    activity.succeed(handle, '对方接受了私聊邀请。');
    assert.equal(activity.clear(), true);
    assert.equal(activity.clear(), false);
    unsubscribe();
    activity.start('灵魂匹配', '灵魂匹配中……');

    assert.equal(received.length, 4);
    assert.equal(received[0].entries.length, 0);
    assert.equal(received[1].current.length, 1);
    assert.equal(received[2].entries[0].status, 'success');
    assert.equal(received[3].entries.length, 0);
});

test('a throwing subscriber cannot interrupt operation updates', () => {
    const activity = createOperationActivity({ now: () => 0 });
    let healthyCalls = 0;
    activity.subscribe(() => { throw new Error('view failed'); }, { emitCurrent: false });
    activity.subscribe(() => { healthyCalls += 1; }, { emitCurrent: false });

    const handle = activity.start('灵魂匹配', '灵魂匹配中……');
    assert.equal(activity.fail(handle, '匹配未成功，请稍后再试。'), true);
    assert.equal(healthyCalls, 2);
});

test('updates require the original running handle and cannot rewrite completed entries', () => {
    const activity = createOperationActivity({ now: () => 0 });
    const handle = activity.start('灵魂匹配', '灵魂匹配中……');

    assert.equal(activity.succeed(Symbol('operation-activity'), '不会写入。'), false);
    assert.equal(activity.succeed(handle, '灵魂匹配成功。'), true);
    assert.equal(activity.fail(handle, '不能覆盖已完成结果。'), false);
    assert.equal(activity.snapshot().entries[0].status, 'success');
    assert.equal(activity.snapshot().entries[0].message, '灵魂匹配成功。');
});

test('unsafe raw details and non-display values are rejected without entering snapshots', () => {
    const activity = createOperationActivity({ now: () => 0 });
    const rejected = [
        () => activity.start('灵魂匹配', new Error('network failed')),
        () => activity.start('npc_uid_42', '灵魂匹配中……'),
        () => activity.start('灵魂匹配', 'stat_data.角色池.npc_uid_42'),
        () => activity.start('灵魂匹配', '角色 npc_42 匹配成功'),
        () => activity.start('灵魂匹配', 'JSONPatch replace /角色池/npc_42'),
        () => activity.start('灵魂匹配', 'Authorization: Bearer secret-value'),
        () => activity.start('灵魂匹配', 'API Key: sk-abcdefghijklmnopqrstuvwxyz'),
        () => activity.start('灵魂匹配', 'TypeError: fetch failed\n    at send (client.js:1:2)'),
        () => activity.start('灵魂匹配', '{"requestBody":{"prompt":"private"}}'),
        () => activity.start('灵魂匹配', '<script>alert(1)</script>'),
        () => activity.start('灵魂匹配', '原始错误：模型响应包含内部状态树'),
    ];

    for (const operation of rejected) assert.throws(operation, TypeError);
    assert.deepEqual(activity.snapshot().entries, []);

    const handle = activity.start('灵魂匹配', '灵魂匹配中……');
    assert.throws(() => activity.fail(handle, 'request payload: abcdefghijklmnopqrstuvwxyz123456'), TypeError);
    assert.equal(activity.snapshot().entries[0].status, 'running');
    assert.equal(activity.snapshot().entries[0].message, '灵魂匹配中……');
});

test('configuration and subscription inputs are validated', () => {
    assert.throws(() => createOperationActivity({ maxEntries: 0 }), /positive integer/u);
    assert.throws(() => createOperationActivity({ maxEntries: 1.5 }), /positive integer/u);
    assert.throws(() => createOperationActivity({ now: 'today' }), /function/u);

    const activity = createOperationActivity({ now: () => 'not-a-date' });
    assert.throws(() => activity.start('灵魂匹配', '灵魂匹配中……'), /valid date/u);
    assert.throws(() => activity.subscribe(null), /listener/u);
});

