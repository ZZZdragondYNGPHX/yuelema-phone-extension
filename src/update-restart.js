export const UPDATE_REOPEN_SESSION_KEY = 'yuelema.update-reopen/v1';
export const UPDATE_RELOAD_DELAY_MS = 900;

function sessionStorageOrNull(injected) {
    if (injected !== undefined) return injected;
    try { return globalThis.sessionStorage ?? null; }
    catch { return null; }
}

function reloadOrNull(injected) {
    if (injected !== undefined) return typeof injected === 'function' ? injected : null;
    try {
        return typeof globalThis.location?.reload === 'function'
            ? () => globalThis.location.reload()
            : null;
    } catch { return null; }
}

function schedulerOrNull(injected) {
    if (injected !== undefined) return typeof injected === 'function' ? injected : null;
    return typeof globalThis.setTimeout === 'function' ? globalThis.setTimeout.bind(globalThis) : null;
}

function cancelSchedulerOrNull(injected) {
    if (injected !== undefined) return typeof injected === 'function' ? injected : null;
    return typeof globalThis.clearTimeout === 'function' ? globalThis.clearTimeout.bind(globalThis) : null;
}

export function rememberPhoneReopenAfterUpdate(storage = undefined) {
    try {
        const target = sessionStorageOrNull(storage);
        if (!target || typeof target.setItem !== 'function') return false;
        target.setItem(UPDATE_REOPEN_SESSION_KEY, '1');
        return true;
    } catch { return false; }
}

export function consumePhoneReopenAfterUpdate(storage = undefined) {
    try {
        const target = sessionStorageOrNull(storage);
        if (!target || typeof target.getItem !== 'function' || typeof target.removeItem !== 'function') return false;
        const shouldReopen = target.getItem(UPDATE_REOPEN_SESSION_KEY) === '1';
        target.removeItem(UPDATE_REOPEN_SESSION_KEY);
        return shouldReopen;
    } catch { return false; }
}

export function clearPhoneReopenAfterUpdate(storage = undefined) {
    try {
        const target = sessionStorageOrNull(storage);
        if (!target || typeof target.removeItem !== 'function') return false;
        target.removeItem(UPDATE_REOPEN_SESSION_KEY);
        return true;
    } catch { return false; }
}

/** Consumes the one-shot marker only after the newly mounted app exposes open(). */
export function reopenPhoneAfterUpdatedReload(instance, storage = undefined) {
    if (!instance || typeof instance.open !== 'function') return false;
    if (!consumePhoneReopenAfterUpdate(storage)) return false;
    try {
        instance.open();
        return true;
    } catch { return false; }
}

/**
 * Lifecycle-owned restart controller. A successful update may schedule only one
 * reload; explicit disable/delete can cancel the timer and clear its one-shot
 * marker so an unrelated later activation never reopens the phone.
 */
export function createExtensionRestartController({ storage = undefined, reload = undefined, schedule = undefined, cancelSchedule = undefined } = {}) {
    let pending = false;
    let timerHandle = null;
    let sequence = 0;
    let lastStatus = null;

    return Object.freeze({
        schedule() {
            if (pending && lastStatus) return lastStatus;
            const reopenMarked = rememberPhoneReopenAfterUpdate(storage);
            const reloadPage = reloadOrNull(reload);
            const scheduleTask = schedulerOrNull(schedule);
            if (!reloadPage || !scheduleTask) {
                lastStatus = Object.freeze({ scheduled: false, reopenMarked });
                return lastStatus;
            }

            const token = ++sequence;
            pending = true;
            try {
                timerHandle = scheduleTask(() => {
                    if (!pending || token !== sequence) return;
                    pending = false;
                    timerHandle = null;
                    try { reloadPage(); }
                    catch { /* The update already succeeded; reload failures stay non-fatal. */ }
                }, UPDATE_RELOAD_DELAY_MS);
                lastStatus = Object.freeze({ scheduled: true, reopenMarked });
                return lastStatus;
            } catch {
                pending = false;
                timerHandle = null;
                lastStatus = Object.freeze({ scheduled: false, reopenMarked });
                return lastStatus;
            }
        },
        cancel() {
            const wasPending = pending;
            const handle = timerHandle;
            sequence += 1;
            pending = false;
            timerHandle = null;
            lastStatus = null;
            if (wasPending) {
                try { cancelSchedulerOrNull(cancelSchedule)?.(handle); }
                catch { /* Marker cleanup below still prevents a later unrelated reopen. */ }
            }
            clearPhoneReopenAfterUpdate(storage);
            return wasPending;
        },
        reopen(instance) {
            return reopenPhoneAfterUpdatedReload(instance, storage);
        },
    });
}
