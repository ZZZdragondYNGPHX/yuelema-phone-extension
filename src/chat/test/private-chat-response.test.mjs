import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MAX_PRIVATE_CHAT_REPLY_COUNT,
    MAX_PRIVATE_CHAT_REPLY_LENGTH,
    MAX_PRIVATE_CHAT_REPLIES_TOTAL_LENGTH,
    MAX_PRIVATE_CHAT_SESSION_SUMMARY_LENGTH,
    normalizePrivateChatResponse,
    projectPrivateChatResponseError,
} from '../private-chat-response.js';

function response(overrides = {}) {
    return {
        replies: ['今晚方便聊聊吗？', '我刚好有空。'],
        relationship: { 好感: 2, 信任: 1, 戒备: -1, 面基意愿: 0 },
        ...overrides,
    };
}

function legacyResponse(overrides = {}) {
    return {
        reply: '今晚方便聊聊吗？',
        relationship: { 好感: 2, 信任: 1, 戒备: -1, 面基意愿: 0 },
        ...overrides,
    };
}

function expectCode(callback, code) {
    assert.throws(callback, error => error instanceof TypeError && error.code === code);
}

test('accepts preferred replies and returns an independent canonical clone with a legacy fallback', () => {
    const raw = response({ sessionSummary: '围绕周末咖啡面基进行了初步交流。' });
    const normalized = normalizePrivateChatResponse(raw);
    assert.deepEqual(normalized, {
        replies: ['今晚方便聊聊吗？', '我刚好有空。'],
        reply: '今晚方便聊聊吗？ 我刚好有空。',
        relationship: raw.relationship,
        bondAssessment: { kind: 'none', intensity: 0 },
        sessionSummary: raw.sessionSummary,
    });
    assert.notStrictEqual(normalized, raw);
    assert.notStrictEqual(normalized.replies, raw.replies);
    assert.notStrictEqual(normalized.relationship, raw.relationship);

    raw.replies[0] = '被外部改写';
    raw.relationship.好感 = 10;
    assert.deepEqual(normalized.replies, ['今晚方便聊聊吗？', '我刚好有空。']);
    assert.equal(normalized.relationship.好感, 2);
    assert.deepEqual(normalizePrivateChatResponse(normalized), normalized);
});

test('normalizes legacy reply to one canonical bubble and permits only an equivalent compatibility fallback', () => {
    const legacy = normalizePrivateChatResponse(legacyResponse());
    assert.deepEqual(legacy.replies, ['今晚方便聊聊吗？']);
    assert.equal(legacy.reply, '今晚方便聊聊吗？');

    const compatible = normalizePrivateChatResponse(response({ reply: '今晚方便聊聊吗？ 我刚好有空。' }));
    assert.deepEqual(compatible.replies, ['今晚方便聊聊吗？', '我刚好有空。']);
    expectCode(
        () => normalizePrivateChatResponse(response({ reply: '模型试图制造歧义' })),
        'private_chat_response_reply_invalid',
    );
});

test('accepts only the assessment categories allowed by the current content mode', () => {
    assert.deepEqual(
        normalizePrivateChatResponse(response({ bondAssessment: { kind: 'romantic_flirt', intensity: 2 } }), { contentMode: 'SFW' }).bondAssessment,
        { kind: 'romantic_flirt', intensity: 2 },
    );
    expectCode(
        () => normalizePrivateChatResponse(response({ bondAssessment: { kind: 'sexual_desire', intensity: 2 } }), { contentMode: 'SFW' }),
        'private_chat_response_relationship_invalid',
    );
    assert.deepEqual(
        normalizePrivateChatResponse(response({ bondAssessment: { kind: 'sexual_desire', intensity: 3 } }), { contentMode: 'NSFW' }).bondAssessment,
        { kind: 'sexual_desire', intensity: 3 },
    );
    expectCode(
        () => normalizePrivateChatResponse(response({ bondAssessment: { kind: 'friendly', intensity: 1 } }), { contentMode: 'NSFW' }),
        'private_chat_response_relationship_invalid',
    );
});

test('rejects strings, arrays, nulls, missing reply forms, and unknown fields', () => {
    expectCode(() => normalizePrivateChatResponse('{"reply":"hi"}'), 'private_chat_response_required');
    expectCode(() => normalizePrivateChatResponse([]), 'private_chat_response_required');
    expectCode(() => normalizePrivateChatResponse(null), 'private_chat_response_required');
    expectCode(() => normalizePrivateChatResponse({ relationship: {} }), 'private_chat_response_missing_field');
    expectCode(() => normalizePrivateChatResponse(response({ extra: true })), 'private_chat_response_unknown_field');
});

test('strictly validates each reply bubble, array shape, and aggregate length limit', () => {
    expectCode(() => normalizePrivateChatResponse(response({ replies: [] })), 'private_chat_response_reply_invalid');
    expectCode(() => normalizePrivateChatResponse(response({ replies: Array(MAX_PRIVATE_CHAT_REPLY_COUNT + 1).fill('hi') })), 'private_chat_response_reply_invalid');
    expectCode(() => normalizePrivateChatResponse(response({ replies: [''] })), 'private_chat_response_reply_invalid');
    expectCode(() => normalizePrivateChatResponse(response({ replies: [' trailing '] })), 'private_chat_response_reply_invalid');
    expectCode(() => normalizePrivateChatResponse(response({ replies: ['<b>unsafe</b>'] })), 'private_chat_response_reply_invalid');
    expectCode(() => normalizePrivateChatResponse(response({ replies: ['line\nfeed'] })), 'private_chat_response_reply_invalid');
    expectCode(() => normalizePrivateChatResponse(response({ replies: ['x'.repeat(MAX_PRIVATE_CHAT_REPLY_LENGTH + 1)] })), 'private_chat_response_reply_invalid');
    expectCode(() => normalizePrivateChatResponse(response({ replies: ['x'.repeat(300), 'y'.repeat(300)] })), 'private_chat_response_reply_invalid');
    assert.equal(
        normalizePrivateChatResponse(response({ replies: ['x'.repeat(MAX_PRIVATE_CHAT_REPLIES_TOTAL_LENGTH)] })).reply.length,
        MAX_PRIVATE_CHAT_REPLIES_TOTAL_LENGTH,
    );

    const sparse = ['hi'];
    sparse.length = 2;
    expectCode(() => normalizePrivateChatResponse(response({ replies: sparse })), 'private_chat_response_accessor_or_hidden_field');
    const exotic = ['hi'];
    Object.setPrototypeOf(exotic, null);
    expectCode(() => normalizePrivateChatResponse(response({ replies: exotic })), 'private_chat_response_unsafe_prototype');
});

test('strictly validates optional summary safety and relationship deltas', () => {
    expectCode(() => normalizePrivateChatResponse(response({ sessionSummary: '<script>private</script>' })), 'private_chat_response_reply_invalid');
    expectCode(() => normalizePrivateChatResponse(response({ sessionSummary: 'x'.repeat(MAX_PRIVATE_CHAT_SESSION_SUMMARY_LENGTH + 1) })), 'private_chat_response_reply_invalid');
    expectCode(() => normalizePrivateChatResponse(response({ relationship: { 好感: 0, 信任: 0, 戒备: 0 } })), 'private_chat_response_relationship_invalid');
    expectCode(() => normalizePrivateChatResponse(response({ relationship: { 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0, 好友度: 1 } })), 'private_chat_response_unknown_field');
    expectCode(() => normalizePrivateChatResponse(response({ relationship: { 好感: 10.5, 信任: 0, 戒备: 0, 面基意愿: 0 } })), 'private_chat_response_relationship_invalid');
    expectCode(() => normalizePrivateChatResponse(response({ relationship: { 好感: -11, 信任: 0, 戒备: 0, 面基意愿: 0 } })), 'private_chat_response_relationship_invalid');
    assert.equal(normalizePrivateChatResponse(response({ relationship: { 好感: -10, 信任: 10, 戒备: 0, 面基意愿: 10 } })).relationship.信任, 10);
});

test('rejects sensitive keys, prototype-pollution keys, unsafe records, and accessors without executing them', () => {
    const sensitive = response();
    sensitive.apiKey = 'sk-raw-secret';
    expectCode(() => normalizePrivateChatResponse(sensitive), 'private_chat_response_sensitive_key');

    const repliesWithSensitiveKey = ['hi'];
    Object.defineProperty(repliesWithSensitiveKey, 'token', { value: 'secret', enumerable: true });
    expectCode(() => normalizePrivateChatResponse(response({ replies: repliesWithSensitiveKey })), 'private_chat_response_sensitive_key');

    const polluted = response();
    Object.defineProperty(polluted, '__proto__', { value: 'polluted', enumerable: true });
    expectCode(() => normalizePrivateChatResponse(polluted), 'private_chat_response_dangerous_key');

    const exotic = Object.create({ replies: ['inherited'] });
    exotic.replies = ['hello'];
    exotic.relationship = { 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 };
    expectCode(() => normalizePrivateChatResponse(exotic), 'private_chat_response_unsafe_prototype');

    const accessor = response();
    Object.defineProperty(accessor, 'replies', { enumerable: true, get() { throw new Error('must not run'); } });
    expectCode(() => normalizePrivateChatResponse(accessor), 'private_chat_response_accessor_or_hidden_field');
});

test('projects stable safe errors without exposing model source or underlying errors', () => {
    let thrown;
    try {
        normalizePrivateChatResponse(response({ replies: ['<script>MODEL_SECRET</script>'] }));
    } catch (error) {
        thrown = error;
    }
    const projected = projectPrivateChatResponseError(thrown);
    assert.deepEqual(projected, {
        code: 'private_chat_response_reply_invalid',
        message: '私聊文本不符合安全格式。',
    });
    assert.equal(JSON.stringify(projected).includes('MODEL_SECRET'), false);
    assert.deepEqual(projectPrivateChatResponseError(new Error('transport password=leak')), {
        code: 'private_chat_response_invalid',
        message: '私聊回复无效。',
    });
});
