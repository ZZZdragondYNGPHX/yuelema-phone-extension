import test from 'node:test';
import assert from 'node:assert/strict';

import {
    clearPersistentKeys,
    clearSessionKeys,
    configurePersistentKeyStorage,
    hasMemorySessionKey,
    hasPersistentKey,
    requireSessionKey,
    resetPersistentKeyStorage,
    unlockSessionKey,
} from '../src/llm/session-key-store.js';
import { createMemoryStorage } from '../src/settings/settings-store.js';
import { onDelete, onDisable } from '../index.js';

test.afterEach(() => {
    clearPersistentKeys();
    resetPersistentKeyStorage();
});

test('disable lifecycle hook clears only the memory mirror while retaining browser-cached API Key', () => {
    configurePersistentKeyStorage(createMemoryStorage());
    unlockSessionKey('primary', 'browser-cached-key');
    assert.equal(hasMemorySessionKey('primary'), true);

    onDisable();

    assert.equal(hasMemorySessionKey('primary'), false);
    assert.equal(hasPersistentKey('primary'), true);
    assert.equal(requireSessionKey('primary'), 'browser-cached-key');
});

test('delete lifecycle hook does not remove a user-saved browser API Key', () => {
    configurePersistentKeyStorage(createMemoryStorage());
    unlockSessionKey('primary', 'browser-cached-key');
    assert.equal(hasMemorySessionKey('primary'), true);

    onDelete();

    assert.equal(hasMemorySessionKey('primary'), false);
    assert.equal(hasPersistentKey('primary'), true);
    assert.equal(requireSessionKey('primary'), 'browser-cached-key');
});
