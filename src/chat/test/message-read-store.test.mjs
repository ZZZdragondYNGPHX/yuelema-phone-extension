import test from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGE_READ_STORAGE_KEY, createMessageReadStore } from '../message-read-store.js';

function createFakeStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        getItem(key) { return map.has(key) ? map.get(key) : null; },
        setItem(key, value) { map.set(key, String(value)); },
        removeItem(key) { map.delete(key); },
        raw(key) { return map.has(key) ? map.get(key) : null; },
    };
}

test('未跟踪会话全部计为未读，markRead 推进水位后未读归零且只前进不回退', () => {
    const storage = createFakeStorage();
    const store = createMessageReadStore({ storage, now: () => 1000 });
    assert.equal(store.unreadCount('chat_a', 5), 5);
    assert.equal(store.markRead('chat_a', 5), true);
    assert.equal(store.unreadCount('chat_a', 5), 0);
    assert.equal(store.unreadCount('chat_a', 7), 2, '新消息到达后未读只算增量');
    store.markRead('chat_a', 3);
    assert.equal(store.unreadCount('chat_a', 7), 2, '较小的总数不得回退已读水位');
});

test('已读/置顶/提示状态持久化到专用 key，并能被新实例读回', () => {
    const storage = createFakeStorage();
    const first = createMessageReadStore({ storage, now: () => 1000 });
    first.markRead('chat_a', 4);
    first.setPinned('chat_a', true);
    first.markIntroSeen('chat_a');
    first.markComposerHintSeen();
    const raw = storage.raw(MESSAGE_READ_STORAGE_KEY);
    assert.ok(raw, '状态必须写入专用 localStorage key');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.schema, 'yuelema.message-read-state');
    assert.deepEqual(Object.keys(parsed.sessions), ['chat_a']);
    assert.doesNotMatch(raw, /昵称|内容|消息UID/u, '本地状态不得包含任何消息内容或资料字段');

    const second = createMessageReadStore({ storage, now: () => 2000 });
    assert.equal(second.unreadCount('chat_a', 4), 0);
    assert.equal(second.isPinned('chat_a'), true);
    assert.equal(second.hasSeenIntro('chat_a'), true);
    assert.equal(second.hasSeenComposerHint(), true);
});

test('storage 不可用或抛错时降级为内存状态且不抛出', () => {
    const throwing = {
        getItem() { throw new Error('blocked'); },
        setItem() { throw new Error('blocked'); },
    };
    for (const store of [createMessageReadStore({ storage: null }), createMessageReadStore({ storage: throwing })]) {
        assert.equal(store.unreadCount('chat_a', 3), 3);
        assert.equal(store.markRead('chat_a', 3), true);
        assert.equal(store.unreadCount('chat_a', 3), 0, '降级后同实例内仍保持已读水位');
        assert.equal(store.setPinned('chat_a', true), true);
        assert.equal(store.isPinned('chat_a'), true);
        assert.equal(store.hasSeenComposerHint(), false);
        store.markComposerHintSeen();
        assert.equal(store.hasSeenComposerHint(), true);
    }
});

test('损坏 JSON、错误 schema 与非法会话键都被安全忽略', () => {
    const badJson = createMessageReadStore({ storage: createFakeStorage({ [MESSAGE_READ_STORAGE_KEY]: '{bad' }) });
    assert.equal(badJson.unreadCount('chat_a', 2), 2);
    const badSchema = createMessageReadStore({
        storage: createFakeStorage({ [MESSAGE_READ_STORAGE_KEY]: JSON.stringify({ schema: 'other', sessions: { chat_a: { read: 2 } } }) }),
    });
    assert.equal(badSchema.unreadCount('chat_a', 2), 2, '陌生 schema 不得读入');
    const polluted = createMessageReadStore({
        storage: createFakeStorage({
            [MESSAGE_READ_STORAGE_KEY]: JSON.stringify({
                schema: 'yuelema.message-read-state', version: 1,
                sessions: { '__proto__': { read: 9, pinned: true }, 'not-a-chat': { read: 9 }, chat_ok: { read: 1, pinned: true, introSeen: true, at: 5 } },
            }),
        }),
    });
    assert.equal(polluted.isPinned('chat_ok'), true);
    assert.equal(polluted.unreadCount('chat_ok', 3), 2);
    assert.equal(polluted.isPinned('not-a-chat'), false);
    assert.equal(Object.prototype.read, undefined, '原型不得被污染');
});

test('非法 sessionUid 一律拒绝且不写入', () => {
    const storage = createFakeStorage();
    const store = createMessageReadStore({ storage });
    for (const bad of ['', 'npc_1', '__proto__', 'chat_', 123, null]) {
        assert.equal(store.markRead(bad, 3), false);
        assert.equal(store.setPinned(bad, true), false);
        assert.equal(store.unreadCount(bad, 3), 0);
        assert.equal(store.isPinned(bad), false);
    }
    assert.equal(storage.raw(MESSAGE_READ_STORAGE_KEY), null);
});

test('forgetSession 清掉单个会话的本地状态', () => {
    const storage = createFakeStorage();
    const store = createMessageReadStore({ storage });
    store.markRead('chat_a', 4);
    store.setPinned('chat_a', true);
    assert.equal(store.forgetSession('chat_a'), true);
    assert.equal(store.unreadCount('chat_a', 4), 4);
    assert.equal(store.isPinned('chat_a'), false);
    assert.equal(store.forgetSession('chat_a'), false, '重复遗忘应返回 false');
});

test('会话条目超过上限时按最近触碰裁剪', () => {
    const storage = createFakeStorage();
    let tick = 0;
    const store = createMessageReadStore({ storage, now: () => (tick += 1) });
    for (let index = 1; index <= 205; index += 1) store.markRead(`chat_s${index}`, 1);
    const parsed = JSON.parse(storage.raw(MESSAGE_READ_STORAGE_KEY));
    const kept = Object.keys(parsed.sessions);
    assert.equal(kept.length <= 200, true, '本地状态必须有界');
    assert.equal(kept.includes('chat_s205'), true, '最近触碰的会话必须保留');
    assert.equal(kept.includes('chat_s1'), false, '最久未触碰的会话应被裁剪');
});
