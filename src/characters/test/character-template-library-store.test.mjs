import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CHARACTER_TEMPLATE_LIBRARY_SCHEMA,
    CHARACTER_TEMPLATE_LIBRARY_SCHEMA_VERSION,
    CHARACTER_TEMPLATE_LIBRARY_STORAGE_KEY,
    LEGACY_CHARACTER_LIBRARY_STORAGE_KEY,
    MAX_CHARACTER_TEMPLATE_LIBRARY_ENTRIES,
    CharacterTemplateLibraryError,
    createCharacterTemplateLibraryStore,
    projectCharacterTemplateLibraryError,
} from '../character-template-library-store.js';
import {
    CHARACTER_TEMPLATE_FORMAT,
    exportCharacterTemplate,
} from '../character-template-codec.js';

function createFakeStorage(seed = {}) {
    const values = new Map(Object.entries(seed));
    return {
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); },
        removeItem(key) { values.delete(key); },
        raw(key) { return values.has(key) ? values.get(key) : null; },
    };
}

function adultCharacter(name = '林澈') {
    return {
        成人验证: true,
        公开资料: {
            昵称: name,
            头像引用: '',
            年龄段: '25-29',
            性别: '女',
            性取向: '双性恋',
            城市: '上海',
            距离范围: '12 km',
            寻找意图: '先聊天再约会',
            简介: '周末看展，也喜欢深夜散步。',
            兴趣标签: ['电影', '夜跑'],
            生活方式标签: ['夜猫子'],
            性格标签: ['直接'],
            沟通风格标签: ['慢热'],
        },
        仅好友资料: { 关系状态: '单身', 边界与偏好: '先确认边界，尊重拒绝。' },
        隐藏资料: { 实际年龄: 28, 私人备注: '对临时失约很敏感。' },
        偏好与边界: '偏好坦诚交流，不接受骚扰或胁迫。',
        拒绝阈值: 35,
        已读不回阈值: 55,
        取消匹配阈值: 75,
        拉黑阈值: 90,
        与玩家关系: {
            状态: '陌生',
            全局账号表现: 68,
            NPC专属匹配度: 72,
            好感: 0,
            信任: 0,
            戒备: 20,
            面基意愿: 0,
            友情值: 0,
            心动值: 0,
            欲望值: 0,
        },
    };
}

function template(name = '林澈', avatar) {
    const output = { format: CHARACTER_TEMPLATE_FORMAT, character: adultCharacter(name) };
    if (avatar !== undefined) output.avatar = avatar;
    return output;
}

function expectCode(action, code) {
    assert.throws(action, (error) => {
        assert.ok(error instanceof CharacterTemplateLibraryError);
        assert.equal(error.code, code);
        assert.equal(error.message.includes('sk-test'), false);
        assert.equal(error.message.includes('Authorization'), false);
        return true;
    });
}

function clockSequence() {
    let index = 0;
    return () => `2026-07-20T00:00:0${++index}.000Z`;
}

test('saves draft/generated character results, persists them, and keeps list metadata-only', () => {
    const storage = createFakeStorage();
    const store = createCharacterTemplateLibraryStore({ storage, now: clockSequence() });
    const saved = store.saveDraft({
        id: 'lin-che', name: '上海晚风', character: adultCharacter(), avatar: { kind: 'placeholder' },
    });

    assert.equal(saved.id, 'lin-che');
    assert.equal(saved.metadata.name, '上海晚风');
    assert.equal(saved.template.avatar.kind, 'placeholder');
    assert.deepEqual(store.listTemplates(), [{ id: 'lin-che', metadata: saved.metadata }]);
    assert.equal(Object.hasOwn(store.listTemplates()[0], 'template'), false);
    assert.equal(store.status().totalCount, 1);

    const persisted = JSON.parse(storage.raw(CHARACTER_TEMPLATE_LIBRARY_STORAGE_KEY));
    assert.equal(persisted.schema, CHARACTER_TEMPLATE_LIBRARY_SCHEMA);
    assert.equal(persisted.schemaVersion, CHARACTER_TEMPLATE_LIBRARY_SCHEMA_VERSION);
    assert.equal(JSON.stringify(persisted).includes('sk-test'), false);
    assert.equal(JSON.stringify(persisted).includes('connectionPreset'), false);

    const loaded = store.loadTemplate('lin-che');
    loaded.template.character.公开资料.兴趣标签.push('外部篡改');
    assert.deepEqual(store.loadTemplate('lin-che').template.character.公开资料.兴趣标签, ['电影', '夜跑']);

    const reloaded = createCharacterTemplateLibraryStore({ storage });
    assert.equal(reloaded.list()[0].metadata.name, '上海晚风');
    assert.equal(reloaded.get('lin-che').template.character.隐藏资料.实际年龄, 28);
});

test('supports compatibility CRUD plus explicit rename, replacement, and deletion', () => {
    const store = createCharacterTemplateLibraryStore({ storage: createFakeStorage(), now: clockSequence() });
    store.create({ id: 'one', metadata: { name: '初版' }, template: template() });
    const renamed = store.renameTemplate('one', '改名后的版本');
    assert.equal(renamed.metadata.name, '改名后的版本');

    const updated = store.update('one', {
        metadata: { name: '再次改名' },
        template: template('苏晴', { kind: 'url', url: 'https://example.com/a.png' }),
    });
    assert.equal(updated.metadata.name, '再次改名');
    assert.equal(updated.template.character.公开资料.昵称, '苏晴');

    const deleted = store.deleteTemplate('one');
    assert.equal(deleted.id, 'one');
    assert.deepEqual(store.listTemplates(), []);
    expectCode(() => store.loadTemplate('one'), 'TEMPLATE_NOT_FOUND');
    expectCode(() => store.renameTemplate('one', '不存在'), 'TEMPLATE_NOT_FOUND');
    expectCode(() => store.deleteTemplate('one'), 'TEMPLATE_NOT_FOUND');
});

test('rejects duplicate IDs, unsafe metadata, and invalid template data without partial writes', () => {
    const storage = createFakeStorage();
    const store = createCharacterTemplateLibraryStore({ storage, now: clockSequence() });
    store.saveTemplate({ id: 'one', name: '一号', template: template() });
    const before = storage.raw(CHARACTER_TEMPLATE_LIBRARY_STORAGE_KEY);

    expectCode(() => store.saveTemplate({ id: 'one', name: '重复', template: template() }), 'DUPLICATE_TEMPLATE_ID');
    expectCode(() => store.saveTemplate({ id: 'bad id', name: '坏 ID', template: template() }), 'INVALID_TEMPLATE_ID');
    expectCode(() => store.saveTemplate({ id: 'unsafe', name: '不应保存', template: { ...template(), apiKey: 'sk-test' } }), 'SENSITIVE_DATA_FORBIDDEN');
    expectCode(() => store.renameTemplate('one', '<script>坏</script>'), 'INVALID_TEMPLATE_METADATA');
    expectCode(() => store.update('one', { metadata: { name: '<script>坏</script>' }, template: template('不应部分写入') }), 'INVALID_TEMPLATE_METADATA');
    assert.equal(store.get('one').template.character.公开资料.昵称, '林澈');
    expectCode(() => store.saveTemplate({ id: 'two', name: '二号', template: { format: CHARACTER_TEMPLATE_FORMAT, character: { 成人验证: false } } }), 'TEMPLATE_INVALID');
    assert.equal(storage.raw(CHARACTER_TEMPLATE_LIBRARY_STORAGE_KEY), before);
    assert.equal(store.list().length, 1);
});

test('single template JSON import/export validates through the codec and can omit avatars', () => {
    const store = createCharacterTemplateLibraryStore({ storage: createFakeStorage(), now: clockSequence() });
    store.saveTemplate({ id: 'source', name: '带头像', template: template('林澈', { kind: 'embedded', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }) });

    const withoutAvatar = JSON.parse(store.exportTemplateJson('source', { includeAvatar: false }));
    assert.deepEqual(withoutAvatar, { format: CHARACTER_TEMPLATE_FORMAT, character: adultCharacter() });
    const imported = store.importTemplateJson(store.exportTemplateJson('source'), { id: 'copied', name: '复制' });
    assert.equal(imported.id, 'copied');
    assert.deepEqual(store.get('copied').template.avatar, { kind: 'embedded', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' });
    expectCode(() => store.importTemplateJson('{not-json'), 'TEMPLATE_INVALID_JSON');
    expectCode(() => store.importTemplateJson(store.exportTemplateJson('source'), { id: 'copied' }), 'DUPLICATE_TEMPLATE_ID');
    expectCode(() => store.exportTemplateJson('source', { includeAvatar: 'yes' }), 'INVALID_EXPORT_OPTIONS');
});

test('whole-library export/import supports merge and replace with collision protection', () => {
    const sourceStorage = createFakeStorage();
    const source = createCharacterTemplateLibraryStore({ storage: sourceStorage, now: clockSequence() });
    source.saveTemplate({ id: 'one', name: '一号', template: template('一号') });
    source.saveTemplate({ id: 'two', name: '二号', template: template('二号') });
    const libraryJson = source.exportLibraryJson({ includeAvatar: false });
    const exported = JSON.parse(libraryJson);
    assert.equal(exported.schema, CHARACTER_TEMPLATE_LIBRARY_SCHEMA);
    assert.equal(exported.templates.length, 2);
    assert.equal(Object.hasOwn(exported.templates[0].template, 'avatar'), false);

    const target = createCharacterTemplateLibraryStore({ storage: createFakeStorage(), now: clockSequence() });
    assert.deepEqual(target.importLibraryJson(libraryJson), { mode: 'merge', importedCount: 2, totalCount: 2 });
    expectCode(() => target.importLibraryJson(libraryJson), 'DUPLICATE_TEMPLATE_ID');
    assert.deepEqual(target.importLibraryJson(libraryJson, { mode: 'replace' }), { mode: 'replace', importedCount: 2, totalCount: 2 });
    expectCode(() => target.importLibraryJson('{bad'), 'INVALID_LIBRARY_JSON');
    expectCode(() => target.importLibraryJson(libraryJson, { mode: 'unknown' }), 'INVALID_LIBRARY_IMPORT_OPTIONS');
});

test('migrates the existing v1 character library exactly once and exposes migration status', () => {
    const legacy = {
        schema: 'yuelema.character-library',
        schemaVersion: 1,
        templates: [{
            id: 'legacy-one',
            metadata: {
                name: '旧版模板',
                createdAt: '2026-07-19T00:00:00.000Z',
                updatedAt: '2026-07-19T00:00:00.000Z',
            },
            template: template('旧版模板'),
        }],
    };
    const storage = createFakeStorage({ [LEGACY_CHARACTER_LIBRARY_STORAGE_KEY]: JSON.stringify(legacy) });
    const store = createCharacterTemplateLibraryStore({ storage });
    assert.deepEqual(store.status(), {
        schema: CHARACTER_TEMPLATE_LIBRARY_SCHEMA,
        schemaVersion: CHARACTER_TEMPLATE_LIBRARY_SCHEMA_VERSION,
        totalCount: 1,
        migrated: true,
    });
    assert.equal(storage.raw(LEGACY_CHARACTER_LIBRARY_STORAGE_KEY), null);
    assert.equal(JSON.parse(storage.raw(CHARACTER_TEMPLATE_LIBRARY_STORAGE_KEY)).templates[0].id, 'legacy-one');

    const reloaded = createCharacterTemplateLibraryStore({ storage });
    assert.equal(reloaded.status().migrated, false);
    assert.equal(reloaded.list()[0].id, 'legacy-one');
});

test('returns explicit errors for bad persisted JSON, unsupported versions, duplicate records, and oversized data', () => {
    const badJsonStorage = createFakeStorage({ [CHARACTER_TEMPLATE_LIBRARY_STORAGE_KEY]: '{bad' });
    expectCode(() => createCharacterTemplateLibraryStore({ storage: badJsonStorage }).list(), 'INVALID_LIBRARY_JSON');

    const unsupportedStorage = createFakeStorage({
        [CHARACTER_TEMPLATE_LIBRARY_STORAGE_KEY]: JSON.stringify({ schema: CHARACTER_TEMPLATE_LIBRARY_SCHEMA, schemaVersion: 99, templates: [] }),
    });
    expectCode(() => createCharacterTemplateLibraryStore({ storage: unsupportedStorage }).list(), 'UNSUPPORTED_LIBRARY_VERSION');

    const duplicate = {
        schema: CHARACTER_TEMPLATE_LIBRARY_SCHEMA,
        schemaVersion: CHARACTER_TEMPLATE_LIBRARY_SCHEMA_VERSION,
        templates: [
            { id: 'same', metadata: { name: 'A', createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T00:00:00.000Z' }, template: template('A') },
            { id: 'same', metadata: { name: 'B', createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T00:00:00.000Z' }, template: template('B') },
        ],
    };
    expectCode(() => createCharacterTemplateLibraryStore({ storage: createFakeStorage({ [CHARACTER_TEMPLATE_LIBRARY_STORAGE_KEY]: JSON.stringify(duplicate) }) }).list(), 'DUPLICATE_TEMPLATE_ID');

    const oversized = createFakeStorage({ [CHARACTER_TEMPLATE_LIBRARY_STORAGE_KEY]: 'x'.repeat(8 * 1024 * 1024 + 1) });
    expectCode(() => createCharacterTemplateLibraryStore({ storage: oversized }).list(), 'LIBRARY_TOO_LARGE');
});

test('enforces the fifty-template capacity and does not write the rejected entry', () => {
    const storage = createFakeStorage();
    const store = createCharacterTemplateLibraryStore({ storage, now: () => '2026-07-20T00:00:00.000Z' });
    for (let index = 0; index < MAX_CHARACTER_TEMPLATE_LIBRARY_ENTRIES; index += 1) {
        store.saveTemplate({ id: `template-${index}`, name: `模板 ${index}`, template: template(`角色 ${index}`) });
    }
    const before = storage.raw(CHARACTER_TEMPLATE_LIBRARY_STORAGE_KEY);
    expectCode(() => store.saveTemplate({ id: 'over-limit', name: '超限', template: template('超限') }), 'TEMPLATE_LIMIT_REACHED');
    assert.equal(storage.raw(CHARACTER_TEMPLATE_LIBRARY_STORAGE_KEY), before);
});

test('storage failures are explicit and never claim an unsaved template was saved', () => {
    const blocked = {
        getItem() { throw new Error('blocked'); },
        setItem() { throw new Error('blocked'); },
        removeItem() { throw new Error('blocked'); },
    };
    expectCode(() => createCharacterTemplateLibraryStore({ storage: blocked }).list(), 'STORAGE_READ_FAILED');

    const failingWrite = createFakeStorage();
    failingWrite.setItem = () => { throw new Error('quota'); };
    const store = createCharacterTemplateLibraryStore({ storage: failingWrite });
    expectCode(() => store.saveTemplate({ id: 'one', name: '一号', template: template() }), 'STORAGE_WRITE_FAILED');
    assert.deepEqual(store.list(), []);
});

test('codec is the validation and clone authority for saves, loads, and exports', () => {
    const calls = [];
    const canonical = template('规范化角色');
    const codec = {
        CHARACTER_TEMPLATE_FORMAT,
        importCharacterTemplate(input) {
            calls.push(['import', input]);
            return structuredClone(canonical);
        },
        exportCharacterTemplate(input, options) {
            calls.push(['export', input, options]);
            return exportCharacterTemplate(input, options);
        },
    };
    const store = createCharacterTemplateLibraryStore({ storage: createFakeStorage(), codec });
    store.saveTemplate({ id: 'codec', name: 'codec', template: { raw: 'discard-me' } });
    assert.equal(store.get('codec').template.character.公开资料.昵称, '规范化角色');
    assert.equal(calls.some(([kind]) => kind === 'import'), true);
    assert.equal(calls.some(([kind]) => kind === 'export'), true);
});


test('generates stable local IDs, resolves ordinary collisions, and reports exhausted duplicate factories', () => {
    const store = createCharacterTemplateLibraryStore({
        storage: createFakeStorage(),
        now: () => '2026-07-20T12:34:56.789Z',
    });
    assert.equal(store.saveGenerated({ character: adultCharacter('自动一号') }).id, 'template_20260720123456789_1');
    assert.equal(store.saveDraft({ character: adultCharacter('自动二号') }).id, 'template_20260720123456789_2');

    const colliding = createCharacterTemplateLibraryStore({
        storage: createFakeStorage(),
        now: () => '2026-07-20T12:34:56.789Z',
        idFactory: () => 'always-same',
    });
    colliding.saveTemplate({ name: '第一条', template: template('第一条') });
    expectCode(() => colliding.saveTemplate({ name: '第二条', template: template('第二条') }), 'DUPLICATE_TEMPLATE_ID');
});

test('rejects sparse/accessor library arrays and projects unknown errors safely', () => {
    const store = createCharacterTemplateLibraryStore({ storage: createFakeStorage() });
    const sparse = [];
    sparse.length = 1;
    expectCode(() => store.importLibraryJson({
        schema: CHARACTER_TEMPLATE_LIBRARY_SCHEMA,
        schemaVersion: CHARACTER_TEMPLATE_LIBRARY_SCHEMA_VERSION,
        templates: sparse,
    }), 'UNSAFE_LIBRARY_DATA');

    const accessor = [];
    Object.defineProperty(accessor, '0', { enumerable: true, get() { return {}; } });
    accessor.length = 1;
    expectCode(() => store.importLibraryJson({
        schema: CHARACTER_TEMPLATE_LIBRARY_SCHEMA,
        schemaVersion: CHARACTER_TEMPLATE_LIBRARY_SCHEMA_VERSION,
        templates: accessor,
    }), 'UNSAFE_LIBRARY_DATA');

    assert.deepEqual(projectCharacterTemplateLibraryError(new Error('Authorization Bearer sk-test')), {
        code: 'UNKNOWN_LIBRARY_ERROR',
        message: '本地角色模板库操作失败。',
    });
});

test('rejects malformed legacy migrations and credential-bearing whole-library documents', () => {
    const malformedLegacy = createFakeStorage({
        [LEGACY_CHARACTER_LIBRARY_STORAGE_KEY]: JSON.stringify({
            schema: 'yuelema.character-library',
            schemaVersion: 2,
            templates: [],
        }),
    });
    expectCode(() => createCharacterTemplateLibraryStore({ storage: malformedLegacy }).list(), 'LIBRARY_MIGRATION_FAILED');

    const store = createCharacterTemplateLibraryStore({ storage: createFakeStorage() });
    expectCode(() => store.importLibraryJson({
        schema: CHARACTER_TEMPLATE_LIBRARY_SCHEMA,
        schemaVersion: CHARACTER_TEMPLATE_LIBRARY_SCHEMA_VERSION,
        templates: [],
        connectionPreset: { apiKey: 'sk-test' },
    }), 'SENSITIVE_DATA_FORBIDDEN');
    assert.deepEqual(store.list(), []);
});
