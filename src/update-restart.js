export const UPDATE_REOPEN_SESSION_KEY = 'yuelema.update-reopen/v1';

export const EXTENSION_RUNTIME_LEASE_KEY = Symbol.for('yuelema.phone-extension/runtime-lease/v1');
export const EXTENSION_ROOT_SELECTOR = '.yl-phone-extension';

/**
 * Remove every stale shell left in the host document before a new activation
 * starts. getElementById() only returns one node, so it cannot recover a host
 * that already contains duplicate roots with the same id.
 */
export function removeStaleExtensionRoots(documentRef) {
    if (!documentRef || typeof documentRef.querySelectorAll !== 'function') return 0;
    let removed = 0;
    let roots;
    try { roots = [...documentRef.querySelectorAll(EXTENSION_ROOT_SELECTOR)]; }
    catch { return 0; }
    for (const root of roots) {
        try {
            root?.remove?.();
            removed += 1;
        } catch {
            // A hostile or already-detached stale node must not block the new mount.
        }
    }
    return removed;
}

/**
 * Claim the one live extension runtime across repeated/concurrent activation and
 * cache-busted module copies. A newer claimant releases the older runtime before
 * either can leave duplicate roots, document listeners, or stacked settings dialogs.
 */
export function acquireExtensionRuntimeLease({ globalRef = globalThis, cleanup } = {}) {
    if (typeof cleanup !== 'function') throw new TypeError('extension_runtime_cleanup_required');
    const previous = globalRef?.[EXTENSION_RUNTIME_LEASE_KEY];
    try { previous?.release?.(); } catch { /* stale runtime cleanup is best-effort */ }

    let active = true;
    let globallyPublished = false;
    const lease = Object.freeze({
        isCurrent() {
            return active && (!globallyPublished || globalRef?.[EXTENSION_RUNTIME_LEASE_KEY] === lease);
        },
        release() {
            if (!active) return false;
            active = false;
            try { cleanup(); } finally {
                try {
                    if (globalRef?.[EXTENSION_RUNTIME_LEASE_KEY] === lease) delete globalRef[EXTENSION_RUNTIME_LEASE_KEY];
                } catch { /* global coordination is an optimization; local cleanup already ran */ }
            }
            return true;
        },
    });
    try {
        globalRef[EXTENSION_RUNTIME_LEASE_KEY] = lease;
        globallyPublished = globalRef[EXTENSION_RUNTIME_LEASE_KEY] === lease;
    } catch { /* non-extensible host: retain local lease semantics */ }
    return lease;
}

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
