import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PHONE_CLOCK_STORAGE_KEY,
    addPhoneMinutes,
    createPhoneClock,
    formatPhoneTimestamp,
    isPhoneTimestampDue,
    parsePhoneTimestamp,
} from '../phone-clock.js';

function createStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        getItem(key) { return map.has(key) ? map.get(key) : null; },
        setItem(key, value) { map.set(key, String(value)); },
        removeItem(key) { map.delete(key); },
        raw(key) { return map.get(key) ?? null; },
    };
}

test('现实一分钟推进小手机五分钟且跨午夜保持 24 小时格式', () => {
    let realNow = new Date(2026, 7, 2, 23, 58, 40, 0).getTime();
    const clock = createPhoneClock({ storage: createStorage(), now: () => realNow });
    assert.equal(clock.displayText(), '23:55');
    realNow += 60_000;
    assert.equal(clock.displayText(), '00:00');
    assert.match(clock.nowText(), /^2026-08-03 00:00$/u);
});

test('时钟锚点持久化，新实例继续推进而不重置', () => {
    const storage = createStorage();
    let realNow = new Date(2026, 7, 2, 12, 2, 0, 0).getTime();
    const first = createPhoneClock({ storage, now: () => realNow });
    assert.equal(first.displayText(), '12:00');
    realNow += 3 * 60_000;
    assert.equal(first.displayText(), '12:15');
    assert.doesNotMatch(storage.raw(PHONE_CLOCK_STORAGE_KEY), /消息|角色|prompt|key/iu);
    const second = createPhoneClock({ storage, now: () => realNow });
    assert.equal(second.displayText(), '12:15');
});

test('现实系统时间回拨不会让小手机时间倒退', () => {
    const storage = createStorage();
    let realNow = new Date(2026, 7, 2, 9, 0, 0, 0).getTime();
    const clock = createPhoneClock({ storage, now: () => realNow });
    realNow += 4 * 60_000;
    assert.equal(clock.displayText(), '09:20');
    realNow -= 3 * 60_000;
    assert.equal(clock.displayText(), '09:20');
});

test('严格时间文本只接受合法的五分钟刻度并支持到期比较', () => {
    const base = '2026-08-02 23:55';
    assert.equal(formatPhoneTimestamp(parsePhoneTimestamp(base)), base);
    assert.equal(addPhoneMinutes(base, 10), '2026-08-03 00:05');
    assert.equal(isPhoneTimestampDue(base, '2026-08-03 00:00'), true);
    assert.equal(isPhoneTimestampDue('2026-08-03 00:05', '2026-08-03 00:00'), false);
    for (const invalid of ['2026-08-02 23:58', '2026-02-30 12:00', '2026-08-02T12:00', '', null]) {
        assert.equal(parsePhoneTimestamp(invalid), null);
    }
});
