import test from 'node:test';
import assert from 'node:assert/strict';

import { clearSessionKeys, hasSessionKey, unlockSessionKey } from '../src/llm/session-key-store.js';
import { onDelete, onDisable } from '../index.js';

test.afterEach(() => clearSessionKeys());

test('disable lifecycle hook clears all session-only API keys', () => {
    unlockSessionKey('primary', 'session-key-only');
    assert.equal(hasSessionKey('primary'), true);

    onDisable();

    assert.equal(hasSessionKey('primary'), false);
});

test('delete lifecycle hook also clears all session-only API keys', () => {
    unlockSessionKey('primary', 'session-key-only');
    assert.equal(hasSessionKey('primary'), true);

    onDelete();

    assert.equal(hasSessionKey('primary'), false);
});
