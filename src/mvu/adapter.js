import { LATEST_MESSAGE_SCOPE, buildUpdateVariable, validateControlledPatchAgainstState } from './controlled-patch.js';
import { decodeJsonPointer, isPlainRecord } from './json-pointer.js';

function unavailable(code) {
    return { ok: false, status: 'unavailable', code };
}

function failed(code, error) {
    return { ok: false, status: 'failed', code, error: error instanceof Error ? error.message : undefined };
}

function validMvuApi(mvu) {
    return mvu && typeof mvu.getMvuData === 'function'
        && typeof mvu.parseMessage === 'function'
        && typeof mvu.replaceMvuData === 'function';
}

function cloneReadOnly(value) {
    if (typeof structuredClone !== 'function') return value;
    return structuredClone(value);
}

function sameJsonValue(left, right) {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
        return left.every((value, index) => sameJsonValue(value, right[index]));
    }
    if (isPlainRecord(left) || isPlainRecord(right)) {
        if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
        const leftKeys = Object.keys(left);
        const rightKeys = Object.keys(right);
        if (leftKeys.length !== rightKeys.length) return false;
        return leftKeys.every((key) => Object.hasOwn(right, key) && sameJsonValue(left[key], right[key]));
    }
    return false;
}

function cloneJsonValue(value) {
    if (Array.isArray(value)) return value.map(cloneJsonValue);
    if (isPlainRecord(value)) {
        const clone = {};
        for (const [key, item] of Object.entries(value)) clone[key] = cloneJsonValue(item);
        return clone;
    }
    return value;
}

// Some MVU builds normalize the message-scope options in place (for example,
// replacing the symbolic `latest` ID with a numeric message ID). The shared
// default is intentionally frozen, so each host boundary must receive its own
// mutable copy rather than the exported constant itself.
function copyMutableScope(scope) {
    return isPlainRecord(scope) ? { ...scope } : scope;
}

function resolvePatchParent(root, pointer) {
    const segments = decodeJsonPointer(pointer);
    const key = segments.pop();
    let parent = root;
    for (const segment of segments) {
        if (Array.isArray(parent)) {
            if (!/^(0|[1-9]\d*)$/u.test(segment) || Number(segment) >= parent.length) return null;
            parent = parent[Number(segment)];
        } else if (isPlainRecord(parent) && Object.hasOwn(parent, segment)) {
            parent = parent[segment];
        } else {
            return null;
        }
    }
    return { parent, key };
}

function removePatchValue(root, pointer) {
    const target = resolvePatchParent(root, pointer);
    if (!target) return { ok: false };
    const { parent, key } = target;
    if (Array.isArray(parent)) {
        if (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= parent.length) return { ok: false };
        return { ok: true, value: parent.splice(Number(key), 1)[0] };
    }
    if (!isPlainRecord(parent) || !Object.hasOwn(parent, key)) return { ok: false };
    const value = parent[key];
    delete parent[key];
    return { ok: true, value };
}

function addPatchValue(root, pointer, value) {
    const target = resolvePatchParent(root, pointer);
    if (!target) return false;
    const { parent, key } = target;
    const cloned = cloneJsonValue(value);
    if (Array.isArray(parent)) {
        if (key === '-') {
            parent.push(cloned);
            return true;
        }
        if (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) > parent.length) return false;
        parent.splice(Number(key), 0, cloned);
        return true;
    }
    if (!isPlainRecord(parent)) return false;
    parent[key] = cloned;
    return true;
}

function applyPatchToSnapshot(beforeState, patch) {
    const expected = cloneJsonValue(beforeState);
    for (const [operationIndex, operation] of patch.entries()) {
        try {
            if (operation.op === 'add') {
                if (!addPatchValue(expected, operation.path, operation.value)) throw new Error('add_failed');
            } else if (operation.op === 'remove') {
                if (!removePatchValue(expected, operation.path).ok) throw new Error('remove_failed');
            } else if (operation.op === 'replace') {
                const target = resolvePatchParent(expected, operation.path);
                if (!target) throw new Error('replace_failed');
                const { parent, key } = target;
                if (Array.isArray(parent)) {
                    if (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= parent.length) throw new Error('replace_failed');
                    parent[Number(key)] = cloneJsonValue(operation.value);
                } else if (isPlainRecord(parent)) {
                    // Some MVU schemas omit optional object fields; the host
                    // applies replace as an object assignment in that case.
                    parent[key] = cloneJsonValue(operation.value);
                } else {
                    throw new Error('replace_failed');
                }
            } else if (operation.op === 'move') {
                const moved = removePatchValue(expected, operation.from);
                if (!moved.ok || !addPatchValue(expected, operation.path, moved.value)) throw new Error('move_failed');
            } else {
                throw new Error('unsupported_operation');
            }
        } catch {
            return { ok: false, operationIndex, path: operation.path };
        }
    }
    return { ok: true, expected };
}

function validateProviderPostconditions(beforeState, state, patch) {
    const applied = applyPatchToSnapshot(beforeState, patch);
    if (!applied.ok) return applied;
    if (sameJsonValue(applied.expected, state)) return { ok: true };
    return { ok: false, operationIndex: 0, path: patch[0]?.path ?? '/' };
}

function resolveEventEmitter({ eventEmit, getContext }) {
    if (typeof eventEmit === 'function') return eventEmit;
    if (typeof getContext === 'function') {
        try {
            const context = getContext();
            if (typeof context?.eventSource?.emit === 'function') {
                return context.eventSource.emit.bind(context.eventSource);
            }
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Reads only the latest message-scope MVU envelope. The returned snapshot is a
 * clone when the platform supports structuredClone, so callers cannot mutate a
 * live stat_data reference by accident.
 */
export function readLatestState({ mvu = globalThis.Mvu, scope = LATEST_MESSAGE_SCOPE } = {}) {
    if (!mvu || typeof mvu.getMvuData !== 'function') return unavailable('mvu_get_unavailable');
    try {
        const data = mvu.getMvuData(copyMutableScope(scope));
        if (!isPlainRecord(data) || !isPlainRecord(data.stat_data)) return unavailable('mvu_stat_data_unavailable');
        const snapshot = cloneReadOnly(data);
        return { ok: true, status: 'ok', scope: { ...scope }, data: snapshot, state: snapshot.stat_data };
    } catch (error) {
        return failed('mvu_read_failed', error);
    }
}

/**
 * The only write-capable seam. It refuses all paths except the narrow patch
 * whitelist, then invokes the documented MVU parse -> replace -> event sequence.
 * It never assigns to stat_data, chat metadata, or replaceVariables directly.
 */
export async function applyControlledPatch({
    patch,
    mvu = globalThis.Mvu,
    scope = LATEST_MESSAGE_SCOPE,
    eventEmit = globalThis.eventEmit,
    getContext = globalThis.SillyTavern?.getContext?.bind(globalThis.SillyTavern),
} = {}) {
    if (!validMvuApi(mvu)) return unavailable('mvu_official_pipeline_unavailable');
    const emit = resolveEventEmitter({ eventEmit, getContext });
    if (!emit || typeof mvu.events?.VARIABLE_UPDATE_ENDED !== 'string') {
        return unavailable('mvu_variable_event_unavailable');
    }

    let oldData;
    try {
        oldData = mvu.getMvuData(copyMutableScope(scope));
    } catch (error) {
        return failed('mvu_read_failed', error);
    }
    if (!isPlainRecord(oldData) || !isPlainRecord(oldData.stat_data)) return unavailable('mvu_stat_data_unavailable');

    const oldStateSnapshot = cloneJsonValue(oldData.stat_data);
    const eventOldData = { ...oldData, stat_data: oldStateSnapshot };

    const stateValidation = validateControlledPatchAgainstState(oldStateSnapshot, patch);
    if (!stateValidation.ok) return { ok: false, status: 'rejected', code: stateValidation.code, detail: stateValidation.detail };

    const wrapped = buildUpdateVariable(patch);
    if (!wrapped.ok) return { ok: false, status: 'rejected', code: wrapped.code, detail: wrapped.detail };

    let newData;
    try {
        newData = await mvu.parseMessage(wrapped.value, oldData);
    } catch (error) {
        return failed('mvu_parse_failed', error);
    }
    if (!isPlainRecord(newData)) return { ok: false, status: 'no_change', code: 'mvu_parse_returned_no_data' };
    if (!isPlainRecord(newData.stat_data)) {
        return { ok: false, status: 'no_change', code: 'mvu_parse_returned_no_stat_data' };
    }
    // Some MVU builds resolve with an unchanged MvuData when a schema silently
    // rejects every command; treat that as a rejection instead of a fake success.
    if (sameJsonValue(newData.stat_data, oldStateSnapshot)) {
        return { ok: false, status: 'no_change', code: 'mvu_parse_made_no_change' };
    }

    // A provider may return a cloned MvuData even when a command was dropped.
    // Verify every deterministic replace (including content-mode toggle) before
    // allowing replaceMvuData; this is postcondition checking, not a second write.
    const postconditions = validateProviderPostconditions(oldStateSnapshot, newData.stat_data, patch);
    if (!postconditions.ok) {
        return {
            ok: false,
            status: 'no_change',
            code: 'mvu_parse_postcondition_failed',
            detail: { operationIndex: postconditions.operationIndex, path: postconditions.path },
        };
    }

    try {
        await mvu.replaceMvuData(newData, copyMutableScope(scope));
    } catch (error) {
        return failed('mvu_replace_failed', error);
    }

    try {
        await emit(mvu.events.VARIABLE_UPDATE_ENDED, newData, eventOldData);
    } catch (error) {
        // replaceMvuData already succeeded; report a degraded completion rather than
        // retrying a write or falsely claiming that no state changed.
        return { ok: true, status: 'persisted_event_failed', code: 'mvu_event_emit_failed', error: error instanceof Error ? error.message : undefined };
    }
    return { ok: true, status: 'applied', scope: { ...scope }, data: newData };
}
