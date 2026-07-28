import assert from 'node:assert/strict';
import test from 'node:test';
import {
    CONVERSATION_IMAGE_STORAGE_KEY,
    createConversationImageStore,
    createMemoryConversationImageStorage,
} from '../conversation-image-store.js';

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAAA';
const directive = Object.freeze({ kind: 'scene_snapshot', scene: 'rainy garden after sunset' });

test('对话生图按界面、会话与消息持久化图片和窄结构提示词', async () => {
    const storage = createMemoryConversationImageStorage();
    const first = createConversationImageStore({ storage, now: () => new Date('2026-07-28T12:00:00.000Z') });
    await first.ready();
    await first.put({
        kind: 'private',
        conversationId: 'chat_1',
        messageId: 'message_1',
        directive,
        imageSource: PNG_DATA_URL,
    });

    const reloaded = createConversationImageStore({ storage });
    await reloaded.ready();
    const record = reloaded.peek('private', 'chat_1', 'message_1');
    assert.equal(record.imageSource, PNG_DATA_URL);
    assert.deepEqual(record.directive, directive);
    assert.equal(reloaded.peek('group', 'chat_1', 'message_1'), null, '不同界面不得串图');
});

test('删除会话只清理该界面的对应生图记录', async () => {
    const store = createConversationImageStore({ storage: createMemoryConversationImageStorage() });
    await store.ready();
    for (const item of [
        { kind: 'private', conversationId: 'chat_1', messageId: 'message_1' },
        { kind: 'private', conversationId: 'chat_2', messageId: 'message_2' },
        { kind: 'group', conversationId: 'chat_1', messageId: 'message_3' },
    ]) {
        await store.put({ ...item, directive, imageSource: PNG_DATA_URL });
    }
    assert.equal(await store.removeConversation('private', 'chat_1'), 1);
    assert.equal(store.peek('private', 'chat_1', 'message_1'), null);
    assert.ok(store.peek('private', 'chat_2', 'message_2'));
    assert.ok(store.peek('group', 'chat_1', 'message_3'));
});

test('图片缓存可以按界面、会话与消息精确删除单张图片', async () => {
    const store = createConversationImageStore({ storage: createMemoryConversationImageStorage() });
    await store.ready();
    for (const item of [
        { kind: 'private', conversationId: 'chat_1', messageId: 'message_1' },
        { kind: 'private', conversationId: 'chat_1', messageId: 'message_2' },
    ]) {
        await store.put({ ...item, directive, imageSource: PNG_DATA_URL });
    }
    assert.equal(await store.remove('private', 'chat_1', 'message_1'), true);
    assert.equal(await store.remove('private', 'chat_1', 'message_1'), false);
    assert.equal(store.peek('private', 'chat_1', 'message_1'), null);
    assert.ok(store.peek('private', 'chat_1', 'message_2'));
});

test('对话生图存储拒绝远程 URL、伪造图片和额外敏感字段', async () => {
    const storage = createMemoryConversationImageStorage();
    const store = createConversationImageStore({ storage });
    await store.ready();
    await assert.rejects(() => store.put({
        kind: 'forum', conversationId: 'post_1', messageId: 'message_1', directive,
        imageSource: 'https://images.example.test/private.png',
    }), (error) => error?.code === 'INVALID_CONVERSATION_IMAGE');
    await assert.rejects(() => store.put({
        kind: 'forum', conversationId: 'post_1', messageId: 'message_1', directive,
        imageSource: 'data:image/png;base64,PGgxPm5vPC9oMT4=',
        characterUid: 'must_not_persist',
    }), (error) => error?.code === 'INVALID_CONVERSATION_IMAGE');
    assert.equal(await storage.getItem(CONVERSATION_IMAGE_STORAGE_KEY), null);
});
