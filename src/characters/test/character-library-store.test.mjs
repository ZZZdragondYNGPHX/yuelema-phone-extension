import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CHARACTER_LIBRARY_STORAGE_KEY,
    MAX_CHARACTER_LIBRARY_TEMPLATES,
    CharacterLibraryError,
    createCharacterLibraryStore,
} from '../character-library-store.js';
import { CHARACTER_TEMPLATE_FORMAT } from '../character-template-codec.js';

function createFakeStorage(seed = {}) {
    const values = new Map(Object.entries(seed));
    return {
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { values.set(key, String(value)); },
        removeItem(key) { values.delete(key); },
        raw(key) { return values.get(key) ?? null; },
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

function template({ name = '林澈', avatar } = {}) {
    const output = { format: CHARACTER_TEMPLATE_FORMAT, character: adultCharacter(name) };
    if (avatar !== undefined) output.avatar = avatar;
    return output;
}

function expectCode(action, code) {
    assert.throws(action, (error) => {
        assert.ok(error instanceof CharacterLibraryError);
        assert.equal(error.code, code);
        assert.equal(error.message.includes('not-saved-key'), false);
        return true;
    });
}

test('character library persists codec-normalized templates and keeps list metadata-only', () => {
    const storage = createFakeStorage();
    let tick = 0;
    const store = createCharacterLibraryStore({
        storage,
        now: () => `2026-07-19T00:00:0${tick += 1}.000Z`,
    });

    const created = store.create({
        id: 'lin-che',
        metadata: { name: '  上海晚风  ' },
        template: template({ avatar: { kind: 'placeholder' } }),
    });

    assert.deepEqual(created.metadata, {
        name: '上海晚风',
        createdAt: '2026-07-19T00:00:01.000Z',
        updatedAt: '2026-07-19T00:00:01.000Z',
    });
    assert.deepEqual(store.list(), [{ id: 'lin-che', metadata: created.metadata }]);
    assert.equal(Object.hasOwn(store.list()[0], 'template'), false);
    assert.deepEqual(store.get('lin-che').template, template({ avatar: { kind: 'placeholder' } }));

    const fromStorage = JSON.parse(storage.raw(CHARACTER_LIBRARY_STORAGE_KEY));
    assert.deepEqual(fromStorage.templates[0].template, template({ avatar: { kind: 'placeholder' } }));
    assert.equal(JSON.stringify(fromStorage).toLowerCase().includes('apikey'), false);

    const loaded = createCharacterLibraryStore({ storage }).load();
    assert.equal(loaded.templates.length, 1);
    const isolated = store.get('lin-che');
    isolated.template.character.公开资料.兴趣标签.push('篡改');
    assert.deepEqual(store.get('lin-che').template.character.公开资料.兴趣标签, ['电影', '夜跑']);
});

test('CRUD updates codec content, rejects duplicate IDs, and rejects credential or unknown metadata', () => {
    const store = createCharacterLibraryStore({
        storage: createFakeStorage(),
        now: (() => {
            let value = 0;
            return () => `2026-07-19T00:00:0${value += 1}.000Z`;
        })(),
    });
    store.create({ id: 'one', metadata: { name: '初版' }, template: template() });
    const updated = store.update('one', {
        metadata: { name: '改名' },
        template: template({ name: '苏晴', avatar: { kind: 'url', url: 'https://example.com/a.png' } }),
    });
    assert.equal(updated.metadata.name, '改名');
    assert.equal(updated.metadata.createdAt, '2026-07-19T00:00:01.000Z');
    assert.equal(updated.metadata.updatedAt, '2026-07-19T00:00:02.000Z');
    assert.equal(updated.template.character.公开资料.昵称, '苏晴');

    expectCode(() => store.create({ id: 'one', metadata: { name: '重复' }, template: template() }), 'DUPLICATE_TEMPLATE_ID');
    expectCode(() => store.create({
        id: 'unsafe-meta',
        metadata: { name: '不应保存', apiKey: 'not-saved-key' },
        template: template(),
    }), 'INVALID_TEMPLATE_METADATA');
    expectCode(() => store.update('one', { metadata: { name: 'x', extra: 'unknown' } }), 'INVALID_TEMPLATE_METADATA');

    const removed = store.remove('one');
    assert.equal(removed.id, 'one');
    assert.deepEqual(store.list(), []);
    expectCode(() => store.get('one'), 'TEMPLATE_NOT_FOUND');
});

test('single-template export can omit an embedded avatar, and import accepts supplied new IDs only once', () => {
    const store = createCharacterLibraryStore({ storage: createFakeStorage() });
    const source = template({ avatar: { kind: 'embedded', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' } });
    store.create({ id: 'source', metadata: { name: '带头像' }, template: source });

    const withoutAvatar = JSON.parse(store.exportTemplate('source', { includeAvatar: false }));
    assert.deepEqual(withoutAvatar, { format: CHARACTER_TEMPLATE_FORMAT, character: adultCharacter() });
    const withAvatar = JSON.parse(store.exportTemplate('source'));
    assert.deepEqual(withAvatar.avatar, source.avatar);

    const imported = store.importTemplate(JSON.stringify(withAvatar), {
        id: 'copied', metadata: { name: '复制' },
    });
    assert.equal(imported.id, 'copied');
    expectCode(() => store.importTemplate(JSON.stringify(withAvatar), {
        id: 'copied', metadata: { name: '再次复制' },
    }), 'DUPLICATE_TEMPLATE_ID');
});

test('import can generate a new ID and default title from codec-normalized public nickname', () => {
    const store = createCharacterLibraryStore({
        storage: createFakeStorage(),
        now: () => '2026-07-19T12:34:56.789Z',
    });
    const imported = store.importTemplate(template({ name: '周末搭子' }));
    assert.equal(imported.id, 'template_20260719123456789_1');
    assert.equal(imported.metadata.name, '周末搭子');
    assert.equal(store.importTemplate(template({ name: '周末搭子' })).id, 'template_20260719123456789_2');
});

test('library uses codec normalization before persistence and never stores raw input', () => {
    const storage = createFakeStorage();
    const calls = [];
    const canonical = {
        format: 'codec-test/v1',
        character: { 公开资料: { 昵称: '规范化后的角色' } },
    };
    const codec = {
        importCharacterTemplate(input) {
            calls.push(input);
            return canonical;
        },
        exportCharacterTemplate(input, { includeAvatar }) {
            assert.deepEqual(input, canonical);
            return JSON.stringify({ exported: true, includeAvatar });
        },
    };
    const store = createCharacterLibraryStore({ storage, codec });
    store.create({ id: 'codec', metadata: { name: 'codec' }, template: { raw: 'discard-me' } });
    assert.equal(calls.length, 2, 'create persists through a second normalization pass');
    const raw = storage.raw(CHARACTER_LIBRARY_STORAGE_KEY);
    assert.equal(raw.includes('discard-me'), false);
    assert.equal(raw.includes('规范化后的角色'), true);
    assert.deepEqual(JSON.parse(store.exportTemplate('codec', { includeAvatar: false })), { exported: true, includeAvatar: false });
});

test('blocked browser storage falls back to per-store memory without persisting credentials', () => {
    const blocked = {
        getItem() { throw new Error('blocked'); },
        setItem() { throw new Error('blocked'); },
        removeItem() { throw new Error('blocked'); },
    };
    const store = createCharacterLibraryStore({ storage: blocked });
    store.create({ id: 'memory-only', metadata: { name: '内存角色' }, template: template() });
    assert.equal(store.list().length, 1);
    assert.equal(store.get('memory-only').metadata.name, '内存角色');
    assert.deepEqual(store.clear().templates, []);
});

test('maximum character count is exactly fifty', () => {
    const codec = {
        importCharacterTemplate(input) { return structuredClone(input); },
        exportCharacterTemplate(input) { return JSON.stringify(input); },
    };
    const store = createCharacterLibraryStore({ storage: createFakeStorage(), codec });
    for (let index = 0; index < MAX_CHARACTER_LIBRARY_TEMPLATES; index += 1) {
        store.create({
            id: `template-${index}`,
            metadata: { name: `角色 ${index}` },
            template: { format: 'codec-test/v1', character: { index } },
        });
    }
    assert.equal(store.list().length, MAX_CHARACTER_LIBRARY_TEMPLATES);
    expectCode(() => store.create({
        id: 'template-over-limit', metadata: { name: '第 51 位' }, template: { format: 'codec-test/v1', character: {} },
    }), 'TEMPLATE_LIMIT_REACHED');
});
