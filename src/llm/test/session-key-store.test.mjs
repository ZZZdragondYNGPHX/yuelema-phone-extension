import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../settings/settings-store.js';
import {
    API_KEY_CACHE_STORAGE_KEY,
    clearPersistentKeys,
    clearSessionKeys,
    configurePersistentKeyStorage,
    deletePersistentKey,
    hasMemorySessionKey,
    hasPersistentKey,
    hasSessionKey,
    requireSessionKey,
    resetPersistentKeyStorage,
    unlockSessionKey,
} from '../session-key-store.js';

test.afterEach(() => {
    clearPersistentKeys();
    resetPersistentKeyStorage();
});

test('API Key 单独保存到浏览器缓存，清空内存镜像后调用端仍可按预设 ID 恢复', () => {
    const storage = createMemoryStorage();
    configurePersistentKeyStorage(storage);

    const result = unlockSessionKey('quick_model', 'browser-cache-secret');
    assert.deepEqual(result, { persisted: true });
    assert.equal(hasMemorySessionKey('quick_model'), true);
    assert.equal(hasPersistentKey('quick_model'), true);
    assert.equal(hasSessionKey('quick_model'), true);
    assert.ok(storage.getItem(API_KEY_CACHE_STORAGE_KEY));

    clearSessionKeys();
    assert.equal(hasMemorySessionKey('quick_model'), false);
    assert.equal(requireSessionKey('quick_model'), 'browser-cache-secret');
    assert.equal(hasMemorySessionKey('quick_model'), true);
});

test('删除连接 Key 只删除对应浏览器缓存，不影响另一条连接', () => {
    const storage = createMemoryStorage();
    configurePersistentKeyStorage(storage);
    unlockSessionKey('fast', 'fast-browser-key');
    unlockSessionKey('smart', 'smart-browser-key');

    assert.equal(deletePersistentKey('fast'), true);
    assert.equal(hasSessionKey('fast'), false);
    assert.equal(requireSessionKey('smart'), 'smart-browser-key');
});

test('浏览器缓存不可用时仍可本次会话调用，但不会错误标为持久化', () => {
    configurePersistentKeyStorage(null);

    assert.deepEqual(unlockSessionKey('temporary', 'temporary-key'), { persisted: false });
    assert.equal(hasMemorySessionKey('temporary'), true);
    assert.equal(hasPersistentKey('temporary'), false);
    assert.equal(requireSessionKey('temporary'), 'temporary-key');
});
