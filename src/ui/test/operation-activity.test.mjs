import test from 'node:test';
import assert from 'node:assert/strict';
import {
    OPERATION_ACTIVITY_MAX_DETAIL_LENGTH,
    OPERATION_ACTIVITY_MAX_ENTRIES,
    buildErrorDetail,
    createOperationActivity,
    sanitizeDiagnosticDetail,
} from '../operation-activity.js';

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
    const voiceMatch = activity.start('描述匹配', '正在寻找合拍的描述……');
    assert.equal(typeof soulMatch, 'symbol');
    assert.equal(typeof voiceMatch, 'symbol');

    assert.equal(activity.succeed(soulMatch, '灵魂匹配成功，正在打开私聊。'), true);
    assert.equal(activity.fail(voiceMatch, '描述匹配未成功，请稍后再试。'), true);

    const result = activity.snapshot();
    assert.deepEqual(result.current, []);
    assert.deepEqual(result.entries, [
        {
            name: '描述匹配', message: '描述匹配未成功，请稍后再试。', detail: null, status: 'failure',
            startedAt: '2026-07-21T08:00:01.000Z', updatedAt: '2026-07-21T08:00:03.000Z',
        },
        {
            name: '灵魂匹配', message: '灵魂匹配成功，正在打开私聊。', detail: null, status: 'success',
            startedAt: '2026-07-21T08:00:00.000Z', updatedAt: '2026-07-21T08:00:02.000Z',
        },
    ]);
    assert.deepEqual(Object.keys(result.entries[0]).sort(), ['detail', 'message', 'name', 'startedAt', 'status', 'updatedAt']);
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

test('dismissed operations settle without being reported as failures', () => {
    const activity = createOperationActivity({ now: () => 0 });
    const handle = activity.start('灵魂匹配', '灵魂匹配中……');

    assert.equal(activity.dismiss(handle, '提示已关闭，结果未展示。'), true);
    assert.deepEqual(activity.snapshot().current, []);
    assert.equal(activity.snapshot().entries[0].status, 'dismissed');
    assert.equal(activity.snapshot().entries[0].message, '提示已关闭，结果未展示。');
    assert.equal(activity.succeed(handle, '不应覆盖已关闭的提示。'), false);
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

test('optional detail is stored per entry, replaced only when provided, and cleared with null', () => {
    const activity = createOperationActivity({ now: () => 0 });

    const withDetail = activity.start('灵魂匹配', '灵魂匹配中……', { detail: '阶段: 请求模型' });
    assert.equal(activity.snapshot().entries[0].detail, '阶段: 请求模型');
    assert.equal(activity.fail(withDetail, '匹配未成功，请稍后再试。', { detail: 'HTTP 状态: 502\n提示: 上游网关错误' }), true);
    assert.equal(activity.snapshot().entries[0].detail, 'HTTP 状态: 502\n提示: 上游网关错误');
    assert.equal(activity.snapshot().entries[0].status, 'failure');

    const keepDetail = activity.start('描述匹配', '正在寻找合拍的描述……', { detail: '阶段: 组装上下文' });
    assert.equal(activity.succeed(keepDetail, '描述匹配成功。'), true);
    assert.equal(activity.snapshot().entries[0].detail, '阶段: 组装上下文', '省略 detail 键时保留既有详情');

    const clearDetail = activity.start('收藏主动私聊', '正在发起私聊……', { detail: '阶段: 等待回应' });
    assert.equal(activity.dismiss(clearDetail, '提示已关闭，结果未展示。', { detail: null }), true);
    assert.equal(activity.snapshot().entries[0].detail, null, 'detail: null 显式清空');

    const plain = activity.start('首页推荐', '正在生成候选人……');
    assert.equal(activity.snapshot().entries[0].detail, null, '二参旧签名保持兼容且 detail 为 null');
    assert.equal(activity.succeed(plain, '候选人已生成。'), true);
    assert.equal(activity.snapshot().entries[0].detail, null);
    assert.equal(Object.isFrozen(activity.snapshot().entries[0]), true);
});

test('detail always passes the diagnostic sanitizer before it enters the ledger', () => {
    const activity = createOperationActivity({ now: () => 0 });
    const handle = activity.start('AI 操作', 'AI 处理中……');
    activity.fail(handle, 'AI 操作未完成，请稍后再试。', {
        detail: '请求 https://api.example.com/v1/models?key=sk-abcdefghijklmnop 返回 401\nAuthorization: Bearer sk-abcdefghijklmnopqrstuvwxyz',
    });
    const detail = activity.snapshot().entries[0].detail;
    assert.doesNotMatch(detail, /sk-[A-Za-z0-9_-]{8,}/u);
    assert.doesNotMatch(detail, /key=/u);
    assert.match(detail, /https:\/\/api\.example\.com\/v1\/models/u);
    assert.match(detail, /\[已脱敏\]/u);
    assert.match(detail, /401/u);

    const coerced = activity.start('AI 操作', 'AI 处理中……', { detail: new TypeError('候选结构不完整') });
    assert.equal(activity.snapshot().entries[0].detail, 'TypeError: 候选结构不完整', '非字符串 detail 先转字符串再脱敏');
    assert.equal(typeof coerced, 'symbol');
});

test('sanitizeDiagnosticDetail redacts credentials while keeping diagnostic substance', () => {
    assert.equal(sanitizeDiagnosticDetail('API key sk-abcdefghijklmnop rejected'), 'API key [已脱敏] rejected');
    assert.equal(sanitizeDiagnosticDetail('header Bearer abc.def-ghi was invalid'), 'header [已脱敏] was invalid');
    assert.equal(sanitizeDiagnosticDetail('Authorization: Bearer whatever-secret-value'), 'Authorization: [已脱敏]');
    assert.equal(sanitizeDiagnosticDetail(`payload ${'A'.repeat(40)} overflow`), 'payload [已脱敏] overflow');
    assert.equal(sanitizeDiagnosticDetail('api_key=abc123 was sent'), 'api_key: [已脱敏] was sent');
    assert.equal(sanitizeDiagnosticDetail('密钥：abc123 已拒绝'), '密钥：[已脱敏] 已拒绝');
});

test('sanitizeDiagnosticDetail keeps url origin and path but strips query, fragment, and userinfo', () => {
    assert.equal(
        sanitizeDiagnosticDetail('POST https://api.example.com/v1/chat/completions?key=secret123#frag failed with 429'),
        'POST https://api.example.com/v1/chat/completions failed with 429',
    );
    assert.equal(
        sanitizeDiagnosticDetail('wss://user:pass@relay.example.com/socket?token=abc closed'),
        'wss://relay.example.com/socket closed',
    );
});

test('sanitizeDiagnosticDetail cleans control characters, truncates, and rejects non-strings', () => {
    const bell = String.fromCharCode(7);
    const escapeChar = String.fromCharCode(27);
    assert.equal(sanitizeDiagnosticDetail(`第一行${bell}${escapeChar}\n\t第二行`), '第一行\n\t第二行');

    const long = '错'.repeat(OPERATION_ACTIVITY_MAX_DETAIL_LENGTH + 500);
    const truncated = sanitizeDiagnosticDetail(long);
    assert.equal(truncated.length, OPERATION_ACTIVITY_MAX_DETAIL_LENGTH + '…（详情已截断）'.length);
    assert.match(truncated, /…（详情已截断）$/u);
    assert.equal(OPERATION_ACTIVITY_MAX_DETAIL_LENGTH, 2000);

    assert.equal(sanitizeDiagnosticDetail(undefined), null);
    assert.equal(sanitizeDiagnosticDetail(null), null);
    assert.equal(sanitizeDiagnosticDetail(42), null);
    assert.equal(sanitizeDiagnosticDetail('   \n  '), null);
});

test('buildErrorDetail formats Error, string, and object inputs with optional context lines', () => {
    const httpError = new TypeError('候选结构校验失败');
    httpError.code = 'invalid_candidate';
    const detail = buildErrorDetail(httpError, {
        operation: '首页推荐刷新',
        httpStatus: 422,
        field: '公开资料.年龄段',
        expected: '成年年龄段枚举',
        actual: '17-19',
        hint: '模型返回未成年段位，已整体拒绝',
    });
    assert.deepEqual(detail.split('\n'), [
        '操作: 首页推荐刷新',
        '错误类型: TypeError',
        '错误信息: 候选结构校验失败',
        '错误码: invalid_candidate',
        'HTTP 状态: 422',
        '字段: 公开资料.年龄段',
        '期望: 成年年龄段枚举',
        '实际: 17-19',
        '提示: 模型返回未成年段位，已整体拒绝',
    ]);

    assert.equal(buildErrorDetail('模型输出缺少 JSON 主体'), '错误信息: 模型输出缺少 JSON 主体');
    const objectDetail = buildErrorDetail({ name: 'HttpError', message: 'Bad Gateway', status: 502 });
    assert.match(objectDetail, /错误类型: HttpError/u);
    assert.match(objectDetail, /HTTP 状态: 502/u);

    const chained = new Error('上游调用未完成');
    chained.cause = new RangeError('响应超出限制');
    assert.match(buildErrorDetail(chained), /起因: RangeError: 响应超出限制/u);

    const expectedObject = buildErrorDetail(null, { field: '回复气泡数', expected: { max: 5 }, actual: 9 });
    assert.match(expectedObject, /期望: \{"max":5\}/u);
    assert.match(expectedObject, /实际: 9/u);

    assert.equal(buildErrorDetail(undefined), null);
    assert.equal(buildErrorDetail(''), null);
    assert.equal(buildErrorDetail(null, {}), null);
});

test('buildErrorDetail output is sanitized automatically', () => {
    const leaky = new Error('调用 https://api.example.com/v1/chat?api-key=sk-abcdefghijklmnop 失败');
    const detail = buildErrorDetail(leaky, { hint: 'Bearer sk-abcdefghijklmnopqrstuvwxyz 已被服务器拒绝' });
    assert.doesNotMatch(detail, /sk-[A-Za-z0-9_-]{8,}/u);
    assert.doesNotMatch(detail, /api-key=/u);
    assert.match(detail, /\[已脱敏\]/u);
    assert.match(detail, /https:\/\/api\.example\.com\/v1\/chat/u);
});

test('configuration and subscription inputs are validated', () => {
    assert.throws(() => createOperationActivity({ maxEntries: 0 }), /positive integer/u);
    assert.throws(() => createOperationActivity({ maxEntries: 1.5 }), /positive integer/u);
    assert.throws(() => createOperationActivity({ now: 'today' }), /function/u);

    const activity = createOperationActivity({ now: () => 'not-a-date' });
    assert.throws(() => activity.start('灵魂匹配', '灵魂匹配中……'), /valid date/u);
    assert.throws(() => activity.subscribe(null), /listener/u);
});

