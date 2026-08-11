import { isPlainRecord } from './json-pointer.js';

export const NSFW_CONSENT_VERSION = 1;
export const NSFW_CONSENT_SCOPES = Object.freeze(['成人话题', '露骨调情', '线上文爱']);
export const NSFW_CONSENT_TURN_OPTIONS = Object.freeze([1, 3, 5]);

const RECORD_FIELDS = Object.freeze(['版本', '状态', '允许范围', '剩余轮数', '来源', '修订号']);
const STATUS_VALUES = new Set(['未确认', '有效', '已撤回', '已过期']);
const SOURCE = '玩家私聊工具';

function exactOwnDataRecord(value, fields) {
    if (!isPlainRecord(value)) return false;
    try {
        const names = Object.getOwnPropertyNames(value);
        if (names.length !== fields.length || Object.getOwnPropertySymbols(value).length !== 0) return false;
        for (const field of fields) {
            if (!Object.hasOwn(value, field)) return false;
            const descriptor = Object.getOwnPropertyDescriptor(value, field);
            if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
        }
        return names.every((name) => fields.includes(name));
    } catch {
        return false;
    }
}

function ownDataValue(record, field) {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(record, field);
        return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    } catch {
        return undefined;
    }
}

function validScopes(value, { active = false } = {}) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
    try {
        const names = Object.getOwnPropertyNames(value);
        if (names.length !== value.length + 1 || !names.includes('length') || Object.getOwnPropertySymbols(value).length !== 0) return false;
        if (active ? value.length < 1 || value.length > NSFW_CONSENT_SCOPES.length : value.length !== 0) return false;
        const seen = new Set();
        for (let index = 0; index < value.length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            const scope = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
            if (!descriptor?.enumerable || !NSFW_CONSENT_SCOPES.includes(scope) || seen.has(scope)) return false;
            seen.add(scope);
        }
        return names.every((name) => name === 'length' || /^(0|[1-9]\d*)$/u.test(name) && Number(name) < value.length);
    } catch {
        return false;
    }
}

export function createEmptyNsfwConsent() {
    return {
        版本: NSFW_CONSENT_VERSION,
        状态: '未确认',
        允许范围: [],
        剩余轮数: 0,
        来源: '',
        修订号: 0,
    };
}

export function validateNsfwConsent(value) {
    if (!exactOwnDataRecord(value, RECORD_FIELDS)
        || ownDataValue(value, '版本') !== NSFW_CONSENT_VERSION
        || !STATUS_VALUES.has(ownDataValue(value, '状态'))
        || !Number.isInteger(ownDataValue(value, '剩余轮数'))
        || !Number.isInteger(ownDataValue(value, '修订号'))
        || ownDataValue(value, '修订号') < 0 || ownDataValue(value, '修订号') > 999999) {
        return { ok: false, code: 'nsfw_consent_invalid' };
    }
    const status = ownDataValue(value, '状态');
    const scopes = ownDataValue(value, '允许范围');
    const remainingTurns = ownDataValue(value, '剩余轮数');
    const source = ownDataValue(value, '来源');
    const revision = ownDataValue(value, '修订号');
    if (status === '有效') {
        if (!validScopes(scopes, { active: true }) || remainingTurns < 1
            || remainingTurns > Math.max(...NSFW_CONSENT_TURN_OPTIONS) || source !== SOURCE || revision < 1) {
            return { ok: false, code: 'nsfw_consent_invalid' };
        }
    } else if (!validScopes(scopes) || remainingTurns !== 0
        || (status === '未确认' ? source !== '' || revision !== 0 : source !== SOURCE || revision < 1)) {
        return { ok: false, code: 'nsfw_consent_invalid' };
    }
    return { ok: true, value };
}

export function isActiveNsfwConsent(value) {
    const validated = validateNsfwConsent(value);
    return validated.ok && validated.value.状态 === '有效';
}

function normalizedScopes(value) {
    if (!validScopes(value, { active: true })) return null;
    return NSFW_CONSENT_SCOPES.filter((scope) => value.includes(scope));
}

function nextRevision(value) {
    const validated = validateNsfwConsent(value);
    if (!validated.ok || validated.value.修订号 >= 999999) return null;
    return validated.value.修订号 + 1;
}

export function grantNsfwConsent(value, { scopes, turns } = {}) {
    const revision = nextRevision(value);
    const allowedScopes = normalizedScopes(scopes);
    if (revision === null || !allowedScopes || !NSFW_CONSENT_TURN_OPTIONS.includes(turns)) return null;
    return {
        版本: NSFW_CONSENT_VERSION,
        状态: '有效',
        允许范围: allowedScopes,
        剩余轮数: turns,
        来源: SOURCE,
        修订号: revision,
    };
}

export function closeNsfwConsent(value, status = '已撤回') {
    if (!['已撤回', '已过期'].includes(status)) return null;
    const revision = nextRevision(value);
    if (revision === null) return null;
    return {
        版本: NSFW_CONSENT_VERSION,
        状态: status,
        允许范围: [],
        剩余轮数: 0,
        来源: SOURCE,
        修订号: revision,
    };
}

export function consumeNsfwConsent(value) {
    const validated = validateNsfwConsent(value);
    if (!validated.ok || validated.value.状态 !== '有效') return null;
    if (validated.value.剩余轮数 === 1) return closeNsfwConsent(validated.value, '已过期');
    if (validated.value.修订号 >= 999999) return null;
    return {
        ...validated.value,
        允许范围: [...validated.value.允许范围],
        剩余轮数: validated.value.剩余轮数 - 1,
        修订号: validated.value.修订号 + 1,
    };
}

export function nsfwConsentReference(value) {
    const validated = validateNsfwConsent(value);
    if (!validated.ok || validated.value.状态 !== '有效') return null;
    return Object.freeze({
        revision: validated.value.修订号,
        remainingTurns: validated.value.剩余轮数,
        scopes: Object.freeze([...validated.value.允许范围]),
    });
}

export function matchesNsfwConsentReference(value, reference) {
    const current = nsfwConsentReference(value);
    return Boolean(current && reference && Number.isInteger(reference.revision)
        && current.revision === reference.revision
        && current.remainingTurns === reference.remainingTurns
        && Array.isArray(reference.scopes)
        && current.scopes.length === reference.scopes.length
        && current.scopes.every((scope, index) => scope === reference.scopes[index]));
}
