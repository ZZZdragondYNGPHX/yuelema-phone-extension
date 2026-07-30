import { isPlainRecord } from './json-pointer.js';

export const BODY_RELATIONSHIP_CANDIDATE_VERSION = 1;
export const BODY_RELATIONSHIP_CANDIDATE_ROOT = '正文关系候选';

const SLOT_FIELDS = Object.freeze([
    '版本', '状态', '角色UID', '事件ID', '来源面基UID', '来源摘要版本',
    '事件类别', '关系路线', '允许影响关系值', '建议方向', '严重度', '证据摘要', '需再次确认',
]);

const PENDING_STATE = '待复盘';
const EMPTY_STATE = '空';
const B2_ROUTE = 'SFW友情';
const B2_RELATIONSHIP_VALUE = '友情值';
const EVENT_CATEGORIES = new Set(['兑现承诺', '推进心愿', '尊重拒绝', '共同完成', '边界不匹配', '停止或降级']);
const POSITIVE_CATEGORIES = new Set(['兑现承诺', '推进心愿', '尊重拒绝', '共同完成']);
const NEGATIVE_CATEGORIES = new Set(['边界不匹配', '停止或降级']);
const POSITIVE_SEVERITIES = new Set(['常规', '明显']);
const NEGATIVE_SEVERITIES = new Set(['常规', '明显', '严重']);
const NPC_UID_PATTERN = /^npc_[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const MEETUP_UID_PATTERN = /^meetup_[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const CONTROL_OR_BIDI_TEXT = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;
const HTML_MARKUP = /<!--|<!doctype\b|<\s*\/?\s*[a-z][^>]*>/iu;

function fail(code) {
    return { ok: false, code };
}

function ownDataDescriptor(record, field) {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(record, field);
        return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor : null;
    } catch {
        return null;
    }
}

function ownDataValue(record, field) {
    return ownDataDescriptor(record, field)?.value;
}

function exactOwnDataRecord(value, fields) {
    if (!isPlainRecord(value)) return false;
    try {
        const names = Object.getOwnPropertyNames(value);
        if (names.length !== fields.length || Object.getOwnPropertySymbols(value).length !== 0) return false;
        for (const field of fields) {
            if (!ownDataDescriptor(value, field)) return false;
        }
        return names.every((name) => fields.includes(name));
    } catch {
        return false;
    }
}

function strictUidSlotMap(value, uidPattern) {
    if (!isPlainRecord(value)) return false;
    try {
        const names = Object.getOwnPropertyNames(value);
        if (Object.getOwnPropertySymbols(value).length !== 0) return false;
        return names.every((name) => uidPattern.test(name) && ownDataDescriptor(value, name));
    } catch {
        return false;
    }
}

function exactStringArray(value, expected) {
    if (!Array.isArray(value)) return null;
    try {
        const names = Object.getOwnPropertyNames(value);
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
        if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')
            || lengthDescriptor.value !== expected.length
            || names.length !== expected.length + 1
            || Object.getOwnPropertySymbols(value).length !== 0) {
            return null;
        }

        const copied = [];
        for (let index = 0; index < expected.length; index += 1) {
            const descriptor = ownDataDescriptor(value, String(index));
            if (!descriptor || descriptor.value !== expected[index]) return null;
            copied.push(descriptor.value);
        }
        if (!names.every((name) => name === 'length' || /^(0|[1-9]\d*)$/u.test(name) && Number(name) < expected.length)) {
            return null;
        }
        return copied;
    } catch {
        return null;
    }
}

function safePlainText(value, maxLength, { required = false } = {}) {
    return typeof value === 'string'
        && value.length <= maxLength
        && value === value.trim()
        && !CONTROL_OR_BIDI_TEXT.test(value)
        && !HTML_MARKUP.test(value)
        && (!required || value.length > 0);
}

function isPositiveCombination(category, direction, severity) {
    return direction === '正向' && POSITIVE_CATEGORIES.has(category) && POSITIVE_SEVERITIES.has(severity);
}

function isNegativeCombination(category, direction, severity) {
    return direction === '负向' && NEGATIVE_CATEGORIES.has(category) && NEGATIVE_SEVERITIES.has(severity);
}

function isNoChangeCombination(category, direction, severity) {
    return direction === '无变化' && EVENT_CATEGORIES.has(category) && severity === '无';
}

function isValidPendingCombination(category, direction, severity) {
    return isPositiveCombination(category, direction, severity)
        || isNegativeCombination(category, direction, severity)
        || isNoChangeCombination(category, direction, severity);
}

function isFormalNpcUid(value) {
    return typeof value === 'string' && NPC_UID_PATTERN.test(value);
}

function isMeetupUid(value) {
    return typeof value === 'string' && MEETUP_UID_PATTERN.test(value);
}

function copyCandidate(fields, allowedValues) {
    return {
        版本: fields.版本,
        状态: fields.状态,
        角色UID: fields.角色UID,
        事件ID: fields.事件ID,
        来源面基UID: fields.来源面基UID,
        来源摘要版本: fields.来源摘要版本,
        事件类别: fields.事件类别,
        关系路线: fields.关系路线,
        允许影响关系值: [...allowedValues],
        建议方向: fields.建议方向,
        严重度: fields.严重度,
        证据摘要: fields.证据摘要,
        需再次确认: fields.需再次确认,
    };
}

function readCandidateFields(value) {
    if (!exactOwnDataRecord(value, SLOT_FIELDS)) return null;
    const fields = {};
    for (const field of SLOT_FIELDS) fields[field] = ownDataValue(value, field);
    const allowedValues = exactStringArray(fields.允许影响关系值, fields.状态 === EMPTY_STATE ? [] : [B2_RELATIONSHIP_VALUE]);
    return allowedValues === null ? null : { fields, allowedValues };
}

/** Creates a fresh, strict empty slot for one formal role's B.2 body candidate. */
export function createEmptyBodyRelationshipCandidate() {
    return {
        版本: BODY_RELATIONSHIP_CANDIDATE_VERSION,
        状态: EMPTY_STATE,
        角色UID: '',
        事件ID: '',
        来源面基UID: '',
        来源摘要版本: 0,
        事件类别: '',
        关系路线: '',
        允许影响关系值: [],
        建议方向: '无变化',
        严重度: '无',
        证据摘要: '',
        需再次确认: false,
    };
}

/** Returns the B.2-only stable event id, or an empty string for an invalid source. */
export function bodyRelationshipEventIdForSource(sourceMeetupUid, sourceSummaryVersion) {
    if (!isMeetupUid(sourceMeetupUid) || sourceSummaryVersion !== BODY_RELATIONSHIP_CANDIDATE_VERSION) return '';
    return `body:${sourceMeetupUid}:${sourceSummaryVersion}`;
}

/**
 * Validates the candidate envelope alone. It never repairs or infers missing
 * values, so callers can fail closed before a controlled MVU write.
 */
export function validateBodyRelationshipCandidate(value) {
    const read = readCandidateFields(value);
    if (!read) return fail('body_relationship_candidate_invalid');
    const { fields, allowedValues } = read;

    if (fields.版本 !== BODY_RELATIONSHIP_CANDIDATE_VERSION) {
        return fail('body_relationship_candidate_invalid');
    }
    if (fields.状态 === EMPTY_STATE) {
        const empty = createEmptyBodyRelationshipCandidate();
        const isExactEmpty = SLOT_FIELDS.every((field) => {
            if (field === '允许影响关系值') return allowedValues.length === 0;
            return fields[field] === empty[field];
        });
        return isExactEmpty
            ? { ok: true, value: copyCandidate(fields, allowedValues) }
            : fail('body_relationship_candidate_invalid');
    }

    if (fields.状态 !== PENDING_STATE
        || !isFormalNpcUid(fields.角色UID)
        || !isMeetupUid(fields.来源面基UID)
        || fields.来源摘要版本 !== BODY_RELATIONSHIP_CANDIDATE_VERSION
        || fields.事件ID !== bodyRelationshipEventIdForSource(fields.来源面基UID, fields.来源摘要版本)
        || !EVENT_CATEGORIES.has(fields.事件类别)
        || fields.关系路线 !== B2_ROUTE
        || allowedValues.length !== 1
        || allowedValues[0] !== B2_RELATIONSHIP_VALUE
        || !isValidPendingCombination(fields.事件类别, fields.建议方向, fields.严重度)
        || !safePlainText(fields.证据摘要, 320, { required: true })
        || typeof fields.需再次确认 !== 'boolean') {
        return fail('body_relationship_candidate_invalid');
    }

    return { ok: true, value: copyCandidate(fields, allowedValues) };
}

function formalRoleExists(rolePool, npcUid) {
    return Boolean(ownDataDescriptor(rolePool, npcUid));
}

function candidateRootMatchesFormalRoles(candidateRoot, rolePool) {
    try {
        return Object.getOwnPropertyNames(candidateRoot).every((uid) => formalRoleExists(rolePool, uid));
    } catch {
        return false;
    }
}

function readSafeSourceMeetup(meetups, sourceMeetupUid) {
    const descriptor = ownDataDescriptor(meetups, sourceMeetupUid);
    if (!descriptor) return { ok: false, code: 'body_relationship_candidate_source_missing' };
    if (!isPlainRecord(descriptor.value)) return { ok: false, code: 'body_relationship_candidate_source_invalid' };
    return { ok: true, value: descriptor.value };
}

/**
 * Reads exactly one candidate slot from latest MVU state. A valid empty slot is
 * deliberately indistinguishable from there being no actionable candidate.
 */
export function selectPendingBodyRelationshipCandidate(state, npcUid) {
    if (!isPlainRecord(state)) return fail('body_relationship_candidate_state_invalid');
    if (!isFormalNpcUid(npcUid)) return fail('body_relationship_candidate_npc_uid_invalid');

    const rolePool = ownDataValue(state, '角色池');
    if (!strictUidSlotMap(rolePool, NPC_UID_PATTERN)) return fail('body_relationship_candidate_role_pool_invalid');
    if (!formalRoleExists(rolePool, npcUid)) return fail('body_relationship_candidate_npc_missing');

    const candidateRoot = ownDataValue(state, BODY_RELATIONSHIP_CANDIDATE_ROOT);
    if (!strictUidSlotMap(candidateRoot, NPC_UID_PATTERN)
        || !candidateRootMatchesFormalRoles(candidateRoot, rolePool)) {
        return fail('body_relationship_candidate_root_invalid');
    }
    const candidateDescriptor = ownDataDescriptor(candidateRoot, npcUid);
    if (!candidateDescriptor) return fail('body_relationship_candidate_slot_missing');

    const candidate = validateBodyRelationshipCandidate(candidateDescriptor.value);
    if (!candidate.ok) return candidate;
    if (candidate.value.状态 === EMPTY_STATE) return { ok: true, value: null };
    if (candidate.value.角色UID !== npcUid) return fail('body_relationship_candidate_uid_mismatch');

    const meetups = ownDataValue(state, '面基记录');
    if (!strictUidSlotMap(meetups, MEETUP_UID_PATTERN)) return fail('body_relationship_candidate_source_registry_invalid');
    const source = readSafeSourceMeetup(meetups, candidate.value.来源面基UID);
    if (!source.ok) return source;

    const sourceNpcUid = ownDataValue(source.value, '对象UID');
    if (sourceNpcUid !== npcUid) return fail('body_relationship_candidate_source_uid_mismatch');
    if (ownDataValue(source.value, '状态') !== '已结束') return fail('body_relationship_candidate_source_not_completed');
    if (ownDataValue(source.value, '关系路线') !== '友情') return fail('body_relationship_candidate_source_route_invalid');
    if (!safePlainText(ownDataValue(source.value, '正文结果摘要'), 1600, { required: true })) {
        return fail('body_relationship_candidate_source_summary_invalid');
    }

    return { ok: true, value: candidate.value };
}

/** Returns the deliberately minimal UI-safe view of a valid pending candidate. */
export function projectPendingBodyRelationshipCandidate(candidate) {
    const validated = validateBodyRelationshipCandidate(candidate);
    if (!validated.ok || validated.value.状态 !== PENDING_STATE) return null;
    return {
        事件类别: validated.value.事件类别,
        关系路线: validated.value.关系路线,
        证据摘要: validated.value.证据摘要,
        需再次确认: validated.value.需再次确认,
    };
}
