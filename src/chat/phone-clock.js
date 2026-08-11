/**
 * Browser-local projected clock for the phone UI.
 *
 * One real minute advances the phone by one five-minute tick. The persisted
 * anchor contains no role/chat data and is deliberately separate from MVU so
 * rendering the clock never causes a once-per-minute variable write.
 */

export const PHONE_CLOCK_STORAGE_KEY = 'yuelema.phone-clock/v1';
export const PHONE_TICK_MINUTES = 5;
export const REAL_MS_PER_PHONE_TICK = 60_000;
export const PHONE_MS_PER_TICK = PHONE_TICK_MINUTES * 60_000;

const CLOCK_SCHEMA = 'yuelema.phone-clock';
const CLOCK_VERSION = 1;
const MAX_CLOCK_DOCUMENT_BYTES = 4096;
const PHONE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/u;

function defaultStorage() {
    try {
        const storage = globalThis.localStorage;
        return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function' ? storage : null;
    } catch {
        return null;
    }
}

function safeNow(now) {
    const value = Number(now());
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : Date.now();
}

function floorLocalFiveMinutes(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return timestamp;
    date.setSeconds(0, 0);
    date.setMinutes(Math.floor(date.getMinutes() / PHONE_TICK_MINUTES) * PHONE_TICK_MINUTES);
    return date.getTime();
}

function normalizeClockState(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || raw.schema !== CLOCK_SCHEMA || raw.version !== CLOCK_VERSION) return null;
    const realAnchorMs = Number(raw.realAnchorMs);
    const phoneAnchorMs = Number(raw.phoneAnchorMs);
    const lastPhoneMs = Number(raw.lastPhoneMs);
    if (![realAnchorMs, phoneAnchorMs, lastPhoneMs].every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
    if (lastPhoneMs < phoneAnchorMs) return null;
    return { realAnchorMs, phoneAnchorMs, lastPhoneMs };
}

function pad(value) {
    return String(value).padStart(2, '0');
}

export function formatPhoneClock(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '--:--';
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatPhoneTimestamp(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parsePhoneTimestamp(value) {
    if (typeof value !== 'string') return null;
    const match = PHONE_TIME_PATTERN.exec(value);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    if (year < 2000 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31
        || hour < 0 || hour > 23 || minute < 0 || minute > 59 || minute % PHONE_TICK_MINUTES !== 0) return null;
    const date = new Date(year, month - 1, day, hour, minute, 0, 0);
    if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day
        || date.getHours() !== hour || date.getMinutes() !== minute) return null;
    return date.getTime();
}

export function addPhoneMinutes(value, minutes) {
    const timestamp = typeof value === 'string' ? parsePhoneTimestamp(value) : Number(value);
    if (!Number.isFinite(timestamp) || !Number.isInteger(minutes) || minutes % PHONE_TICK_MINUTES !== 0) return '';
    return formatPhoneTimestamp(timestamp + (minutes * 60_000));
}

export function isPhoneTimestampDue(value, currentValue) {
    const timestamp = parsePhoneTimestamp(value);
    const current = parsePhoneTimestamp(currentValue);
    return timestamp !== null && current !== null && timestamp <= current;
}

/**
 * @param {{ storage?: Storage|null, now?: () => number }} [options]
 */
export function createPhoneClock({ storage = defaultStorage(), now = () => Date.now() } = {}) {
    let memoryState = null;

    function persist(state) {
        memoryState = state;
        if (!storage) return false;
        try {
            storage.setItem(PHONE_CLOCK_STORAGE_KEY, JSON.stringify({
                schema: CLOCK_SCHEMA,
                version: CLOCK_VERSION,
                realAnchorMs: state.realAnchorMs,
                phoneAnchorMs: state.phoneAnchorMs,
                lastPhoneMs: state.lastPhoneMs,
            }));
            return true;
        } catch {
            return false;
        }
    }

    function initialState(realNow) {
        const state = {
            realAnchorMs: realNow,
            phoneAnchorMs: floorLocalFiveMinutes(realNow),
            lastPhoneMs: floorLocalFiveMinutes(realNow),
        };
        persist(state);
        return state;
    }

    function load(realNow) {
        if (memoryState) return memoryState;
        if (storage) {
            try {
                const text = storage.getItem(PHONE_CLOCK_STORAGE_KEY);
                if (typeof text === 'string' && text && text.length <= MAX_CLOCK_DOCUMENT_BYTES) {
                    const normalized = normalizeClockState(JSON.parse(text));
                    if (normalized) {
                        memoryState = normalized;
                        return memoryState;
                    }
                }
            } catch {
                // Fall through to a fresh in-memory anchor.
            }
        }
        return initialState(realNow);
    }

    function currentMs() {
        const realNow = safeNow(now);
        const state = load(realNow);
        const elapsedRealMs = Math.max(0, realNow - state.realAnchorMs);
        const ticks = Math.floor(elapsedRealMs / REAL_MS_PER_PHONE_TICK);
        const projected = state.phoneAnchorMs + (ticks * PHONE_MS_PER_TICK);
        const current = Math.max(state.lastPhoneMs, projected);
        if (current !== state.lastPhoneMs) persist({ ...state, lastPhoneMs: current });
        return current;
    }

    // Capture the projection anchor when the runtime creates the phone, not on
    // the first later render. Otherwise a backgrounded tab could silently lose
    // the elapsed interval before its first clock read.
    load(safeNow(now));

    return Object.freeze({
        nowMs: currentMs,
        nowText() { return formatPhoneTimestamp(currentMs()); },
        displayText() { return formatPhoneClock(currentMs()); },
        addMinutes(minutes, from = currentMs()) { return addPhoneMinutes(from, minutes); },
        isDue(value, currentValue = formatPhoneTimestamp(currentMs())) { return isPhoneTimestampDue(value, currentValue); },
        /** Real milliseconds until the next projected five-minute tick. */
        delayUntilNextTick() {
            const realNow = safeNow(now);
            const state = load(realNow);
            const elapsed = Math.max(0, realNow - state.realAnchorMs);
            const remainder = elapsed % REAL_MS_PER_PHONE_TICK;
            return Math.max(50, REAL_MS_PER_PHONE_TICK - remainder);
        },
    });
}
