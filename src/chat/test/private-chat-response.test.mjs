import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MAX_PRIVATE_CHAT_REPLY_LENGTH,
    MAX_PRIVATE_CHAT_SESSION_SUMMARY_LENGTH,
    normalizePrivateChatResponse,
    projectPrivateChatResponseError,
} from '../private-chat-response.js';

function response(overrides = {}) {
    return {
        reply: '今晚方便聊聊吗？',
        relationship: { 好感: 2, 信任: 1, 戒备: -1, 面基意愿: 0 },
        ...overrides,
    };
}

function expectCode(callback, code) {
    assert.throws(callback, error => error instanceof TypeError && error.code === code);
}

test('accepts exactly the safe response schema and returns an independent clone', () => {
    const raw = response({ sessionSummary: '围绕周末咖啡面基进行了初步交流。' });
    const normalized = normalizePrivateChatResponse(raw);
    assert.deepEqual(normalized, raw);
    assert.notStrictEqual(normalized, raw);
    assert.notStrictEqual(normalized.relationship, raw.relationship);

    raw.reply = '被外部改写';
    raw.relationship.好感 = 10;
    assert.equal(normalized.reply, '今晚方便聊聊吗？');
    assert.equal(normalized.relationship.好感, 2);
});

test('rejects strings, arrays, nulls, missing fields, and unknown fields', () => {
    expectCode(() => normalizePrivateChatResponse('{"reply":"hi"}'), 'private_chat_response_required');
    expectCode(() => normalizePrivateChatResponse([]), 'private_chat_response_required');
    expectCode(() => normalizePrivateChatResponse(null), 'private_chat_response_required');
    expectCode(() => normalizePrivateChatResponse({ reply: 'hi' }), 'private_chat_response_missing_field');
    expectCode(() => normalizePrivateChatResponse(response({ extra: true })), 'private_chat_response_unknown_field');
});

test('strictly validates reply and optional summary text safety and lengths', () => {
    expectCode(() => normalizePrivateChatResponse(response({ reply: '' })), 'private_chat_response_reply_invalid');
    expectCode(() => normalizePrivateChatResponse(response({ reply: ' trailing ' })), 'private_chat_response_reply_invalid');
    expectCode(() => normalizePrivateChatResponse(response({ reply: '<b>unsafe</b>' })), 'private_chat_response_reply_invalid');
    expectCode(() => normalizePrivateChatResponse(response({ reply: 'line\nfeed' })), 'private_chat_response_reply_invalid');
    expectCode(() => normalizePrivateChatResponse(response({ reply: 'x'.repeat(MAX_PRIVATE_CHAT_REPLY_LENGTH + 1) })), 'private_chat_response_reply_invalid');
    expectCode(() => normalizePrivateChatResponse(response({ sessionSummary: '<script>private</script>' })), 'private_chat_response_reply_invalid');
    expectCode(() => normalizePrivateChatResponse(response({ sessionSummary: 'x'.repeat(MAX_PRIVATE_CHAT_SESSION_SUMMARY_LENGTH + 1) })), 'private_chat_response_reply_invalid');
});

test('requires precisely four integer relationship deltas in the inclusive range', () => {
    expectCode(() => normalizePrivateChatResponse(response({ relationship: { 好感: 0, 信任: 0, 戒备: 0 } })), 'private_chat_response_relationship_invalid');
    expectCode(() => normalizePrivateChatResponse(response({ relationship: { 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0, 好友度: 1 } })), 'private_chat_response_unknown_field');
    expectCode(() => normalizePrivateChatResponse(response({ relationship: { 好感: 10.5, 信任: 0, 戒备: 0, 面基意愿: 0 } })), 'private_chat_response_relationship_invalid');
    expectCode(() => normalizePrivateChatResponse(response({ relationship: { 好感: -11, 信任: 0, 戒备: 0, 面基意愿: 0 } })), 'private_chat_response_relationship_invalid');
    assert.equal(normalizePrivateChatResponse(response({ relationship: { 好感: -10, 信任: 10, 戒备: 0, 面基意愿: 10 } })).relationship.信任, 10);
});

test('rejects sensitive keys, prototype-pollution keys, unsafe prototypes, and accessors without executing them', () => {
    const sensitive = response();
    sensitive.apiKey = 'sk-raw-secret';
    expectCode(() => normalizePrivateChatResponse(sensitive), 'private_chat_response_sensitive_key');

    const polluted = response();
    Object.defineProperty(polluted, '__proto__', { value: 'polluted', enumerable: true });
    expectCode(() => normalizePrivateChatResponse(polluted), 'private_chat_response_dangerous_key');

    const exotic = Object.create({ reply: 'inherited' });
    exotic.reply = 'hello';
    exotic.relationship = { 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 };
    expectCode(() => normalizePrivateChatResponse(exotic), 'private_chat_response_unsafe_prototype');

    const accessor = response();
    Object.defineProperty(accessor, 'reply', { enumerable: true, get() { throw new Error('must not run'); } });
    expectCode(() => normalizePrivateChatResponse(accessor), 'private_chat_response_accessor_or_hidden_field');
});

test('projects stable safe errors without exposing model source or underlying errors', () => {
    let thrown;
    try {
        normalizePrivateChatResponse(response({ reply: '<script>MODEL_SECRET</script>' }));
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
