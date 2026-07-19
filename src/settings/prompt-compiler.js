/**
 * 将“世界书式”提示词预设安全编译为第二 API 可用的系统消息片段。
 * 本地预设仅是调用配置，不属于 MVU 状态，也不含 API Key。
 */
const ENVELOPE_SCHEMA = 'yuelema.prompt-entries';
const ENVELOPE_VERSION = 1;
const POSITIONS = new Set(['before_character_definition', 'after_character_definition']);
const MAX_ENTRIES = 48;
const MAX_ENTRY_CONTENT = 12_000;

function ownPlainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function cleanText(value, maxLength) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    if (!text || text.length > maxLength || /[\u0000-\u001F\u007F]/u.test(text)) return '';
    return text;
}

function normalizeEntry(entry, fallback) {
    if (!ownPlainRecord(entry)) return null;
    const content = cleanText(entry.content, MAX_ENTRY_CONTENT);
    const position = cleanText(entry.position, 64);
    if (!content || !POSITIONS.has(position) || typeof entry.enabled !== 'boolean'
        || !Number.isInteger(entry.depth) || entry.depth < 0 || entry.depth > 1000
        || !Number.isInteger(entry.order) || entry.order < -1000 || entry.order > 1000) return null;
    return Object.freeze({
        name: cleanText(entry.name, 80) || fallback,
        content,
        position,
        enabled: entry.enabled,
        depth: entry.depth,
        order: entry.order,
    });
}

function legacyEntry(preset) {
    if (!ownPlainRecord(preset) || preset.enabled !== true) return [];
    // The first release stored a single bare text field. Preserve it even when
    // lightweight service calls or older documents omit Worldbook metadata.
    const content = cleanText(preset.content, MAX_ENTRY_CONTENT);
    if (!content) return [];
    return [Object.freeze({
        name: cleanText(preset.name, 80) || '提示词条目',
        content,
        position: POSITIONS.has(preset.position) ? preset.position : 'after_character_definition',
        enabled: true,
        depth: Number.isInteger(preset.depth) && preset.depth >= 0 && preset.depth <= 1000 ? preset.depth : 4,
        order: Number.isInteger(preset.order) && preset.order >= -1000 && preset.order <= 1000 ? preset.order : 0,
    })];
}

/**
 * Returns enabled entry texts grouped by their configured position. Within each
 * position, shallower insertion comes first, then explicit order and name.
 */
export function compilePromptPreset(preset) {
    if (!ownPlainRecord(preset) || preset.enabled !== true) return Object.freeze({ before: Object.freeze([]), after: Object.freeze([]) });
    const fallback = cleanText(preset.name, 80) || '提示词条目';
    let entries = null;
    try {
        const parsed = JSON.parse(String(preset.content ?? ''));
        if (ownPlainRecord(parsed) && parsed.schema === ENVELOPE_SCHEMA && parsed.schemaVersion === ENVELOPE_VERSION && Array.isArray(parsed.entries) && parsed.entries.length > 0 && parsed.entries.length <= MAX_ENTRIES) {
            entries = parsed.entries.map((entry) => normalizeEntry(entry, fallback));
            if (entries.some((entry) => entry === null)) entries = null;
        }
    } catch {
        // A legacy plain-text preset is valid and handled below.
    }
    if (!entries) entries = legacyEntry(preset);
    const buckets = { before: [], after: [] };
    for (const entry of entries) {
        if (!entry.enabled) continue;
        buckets[entry.position === 'before_character_definition' ? 'before' : 'after'].push(entry);
    }
    const sortEntries = (items) => items.sort((left, right) => left.depth - right.depth || left.order - right.order || left.name.localeCompare(right.name, 'zh-CN')).map((entry) => entry.content);
    return Object.freeze({ before: Object.freeze(sortEntries(buckets.before)), after: Object.freeze(sortEntries(buckets.after)) });
}

/** Produces a compact ordered text suitable for existing single-system-message call sites. */
export function renderPromptPreset(preset) {
    const compiled = compilePromptPreset(preset);
    return Object.freeze({ before: compiled.before.join('\n\n'), after: compiled.after.join('\n\n') });
}
