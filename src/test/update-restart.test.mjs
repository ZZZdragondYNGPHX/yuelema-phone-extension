import test from 'node:test';
import assert from 'node:assert/strict';

import {
    UPDATE_RELOAD_DELAY_MS,
    UPDATE_REOPEN_SESSION_KEY,
    createExtensionRestartController,
    consumePhoneReopenAfterUpdate,
    rememberPhoneReopenAfterUpdate,
    reopenPhoneAfterUpdatedReload,
    acquireExtensionRuntimeLease,
} from '../update-restart.js';
import { createMemoryStorage } from '../settings/settings-store.js';

test('the update reopen marker is tab-scoped, exact, and consumed only once', () => {
    const storage = createMemoryStorage();
    assert.equal(rememberPhoneReopenAfterUpdate(storage), true);
    assert.equal(storage.getItem(UPDATE_REOPEN_SESSION_KEY), '1');
    assert.equal(consumePhoneReopenAfterUpdate(storage), true);
    assert.equal(storage.getItem(UPDATE_REOPEN_SESSION_KEY), null);
    assert.equal(consumePhoneReopenAfterUpdate(storage), false);
});

test('successful update restart schedules one delayed reload and preserves the reopen marker', () => {
    const storage = createMemoryStorage();
    const tasks = [];
    let reloads = 0;
    const controller = createExtensionRestartController({
        storage,
        reload() { reloads += 1; },
        schedule(callback, delay) { tasks.push({ callback, delay }); },
    });
    const result = controller.schedule();

    assert.deepEqual(result, { scheduled: true, reopenMarked: true });
    assert.equal(reloads, 0, 'reload must wait long enough for the success UI to render');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].delay, UPDATE_RELOAD_DELAY_MS);
    tasks[0].callback();
    assert.equal(reloads, 1);
});

test('blocked session storage still reloads but reports that automatic reopen is unavailable', () => {
    const blocked = { setItem() { throw new Error('blocked'); } };
    const tasks = [];
    const controller = createExtensionRestartController({ storage: blocked, reload() {}, schedule(callback) { tasks.push(callback); } });
    const result = controller.schedule();
    assert.deepEqual(result, { scheduled: true, reopenMarked: false });
    assert.equal(tasks.length, 1);
});

test('reload or scheduler absence fails softly without claiming a restart', () => {
    const storage = createMemoryStorage();
    assert.deepEqual(createExtensionRestartController({ storage, reload: null, schedule() {} }).schedule(), { scheduled: false, reopenMarked: true });
    assert.deepEqual(createExtensionRestartController({ storage, reload() {}, schedule: null }).schedule(), { scheduled: false, reopenMarked: true });
});

test('new lifecycle mount consumes the marker and opens the phone exactly once', () => {
    const storage = createMemoryStorage();
    let opens = 0;
    const instance = { open() { opens += 1; } };

    assert.equal(reopenPhoneAfterUpdatedReload(instance, storage), false);
    rememberPhoneReopenAfterUpdate(storage);
    assert.equal(reopenPhoneAfterUpdatedReload(instance, storage), true);
    assert.equal(opens, 1);
    assert.equal(reopenPhoneAfterUpdatedReload(instance, storage), false);
    assert.equal(opens, 1);
});

test('marker is preserved until a mount with an open capability is ready', () => {
    const storage = createMemoryStorage();
    rememberPhoneReopenAfterUpdate(storage);
    assert.equal(reopenPhoneAfterUpdatedReload({}, storage), false);
    assert.equal(consumePhoneReopenAfterUpdate(storage), true);
});

test('lifecycle controller deduplicates reloads and cancel clears timer plus marker', () => {
    const storage = createMemoryStorage();
    const tasks = [];
    const cancelled = [];
    let reloads = 0;
    const controller = createExtensionRestartController({
        storage,
        reload() { reloads += 1; },
        schedule(callback, delay) { tasks.push({ callback, delay }); return 42; },
        cancelSchedule(handle) { cancelled.push(handle); },
    });

    assert.deepEqual(controller.schedule(), { scheduled: true, reopenMarked: true });
    assert.deepEqual(controller.schedule(), { scheduled: true, reopenMarked: true });
    assert.equal(tasks.length, 1, 'duplicate update completion must not schedule another reload');
    assert.equal(controller.cancel(), true);
    assert.deepEqual(cancelled, [42]);
    assert.equal(storage.getItem(UPDATE_REOPEN_SESSION_KEY), null);
    tasks[0].callback();
    assert.equal(reloads, 0, 'a callback racing after cancellation must be inert');
    assert.equal(controller.cancel(), false);
});

test('lifecycle controller reopens only from its own one-shot session marker', () => {
    const storage = createMemoryStorage();
    let opens = 0;
    const controller = createExtensionRestartController({ storage, reload() {}, schedule() { return 1; } });
    assert.equal(controller.reopen({ open() { opens += 1; } }), false);
    controller.schedule();
    assert.equal(controller.reopen({ open() { opens += 1; } }), true);
    assert.equal(controller.reopen({ open() { opens += 1; } }), false);
    assert.equal(opens, 1);
    controller.cancel();
});


test('runtime lease tears down the previous activation and rejects stale async completion', () => {
    const globalRef = {};
    const cleaned = [];
    const first = acquireExtensionRuntimeLease({ globalRef, cleanup: () => cleaned.push('first') });
    const second = acquireExtensionRuntimeLease({ globalRef, cleanup: () => cleaned.push('second') });

    assert.deepEqual(cleaned, ['first'], '新的激活租约必须先清理旧实例');
    assert.equal(first.isCurrent(), false);
    assert.equal(second.isCurrent(), true);
    assert.equal(first.release(), false, '旧租约不得二次清理');
    assert.equal(second.release(), true);
    assert.deepEqual(cleaned, ['first', 'second']);
    assert.equal(second.isCurrent(), false);
});
