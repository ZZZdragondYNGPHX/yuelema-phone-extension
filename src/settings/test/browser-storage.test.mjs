import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserSettingsStorage } from '../browser-storage.js';

test('browser storage adapter uses the supplied storage when available', () => {
    const values = new Map();
    const storage = createBrowserSettingsStorage({
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key),
    });
    storage.setItem('safe', 'value');
    assert.equal(storage.getItem('safe'), 'value');
    storage.removeItem('safe');
    assert.equal(storage.getItem('safe'), null);
});

test('browser storage adapter safely falls back when browser storage throws', () => {
    const storage = createBrowserSettingsStorage({
        getItem() { throw new Error('blocked'); },
        setItem() { throw new Error('blocked'); },
        removeItem() { throw new Error('blocked'); },
    });
    storage.setItem('safe', 'value');
    assert.equal(storage.getItem('safe'), 'value');
    storage.removeItem('safe');
    assert.equal(storage.getItem('safe'), null);
});
