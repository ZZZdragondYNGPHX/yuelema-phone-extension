import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CHARACTER_TEMPLATE_FORMAT,
    MAX_EMBEDDED_AVATAR_DATA_URL_LENGTH,
    dropLegacyUrlAvatar,
    exportCharacterTemplate,
    importCharacterTemplate,
    normalizeEmbeddedAvatarDataUrl,
    projectCharacterTemplateError,
} from '../character-template-codec.js';

// Minimal base64 payloads that begin with the real binary signature of each format.
const AVATAR_SIGNATURE_BYTES = Object.freeze({
    'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
    'image/webp': [0x52, 0x49, 0x46, 0x46, 0x0c, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50],
});

function signedDataUrl(mimeType, extraBytes = []) {
    return `data:${mimeType};base64,${Buffer.from([...AVATAR_SIGNATURE_BYTES[mimeType], ...extraBytes]).toString('base64')}`;
}

function adultCharacter() {
    return {
        成人验证: true,
        公开资料: {
            昵称: '林澈',
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
        绘图: { core_dna: '', outfit_dna: '' },
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

function template(avatar) {
    const output = { format: CHARACTER_TEMPLATE_FORMAT, character: adultCharacter() };
    if (avatar !== undefined) output.avatar = avatar;
    return output;
}

function expectCode(action, code) {
    assert.throws(action, (error) => {
        assert.ok(error instanceof TypeError);
        assert.equal(error.code, code);
        assert.ok(error.message.startsWith('character_template_validation_failed:'));
        assert.equal(error.message.includes('林澈'), false);
        return true;
    });
}

test('imports the yuelema.character/v1 envelope and returns an isolated adult clone', () => {
    const source = template({ kind: 'placeholder' });
    const imported = importCharacterTemplate(JSON.stringify(source));

    assert.deepEqual(imported, source);
    assert.notStrictEqual(imported, source);
    assert.notStrictEqual(imported.character, source.character);
    assert.notStrictEqual(imported.character.公开资料.兴趣标签, source.character.公开资料.兴趣标签);
    source.character.公开资料.兴趣标签.push('篡改');
    assert.deepEqual(imported.character.公开资料.兴趣标签, ['电影', '夜跑']);
});

test('supports only placeholder and signature-verified embedded data URL avatars; kind url is rejected', () => {
    const placeholder = importCharacterTemplate(template({ kind: 'placeholder' }));
    assert.deepEqual(placeholder.avatar, { kind: 'placeholder' });

    const embedded = importCharacterTemplate(template({ kind: 'embedded', dataUrl: 'data:image/PNG;base64,iVBORw0KGgo=' }));
    assert.deepEqual(embedded.avatar, { kind: 'embedded', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' });
    for (const mimeType of ['image/png', 'image/jpeg', 'image/webp']) {
        const dataUrl = signedDataUrl(mimeType);
        assert.deepEqual(importCharacterTemplate(template({ kind: 'embedded', dataUrl })).avatar, { kind: 'embedded', dataUrl });
    }

    // The url key itself is no longer part of the avatar contract at all.
    expectCode(() => importCharacterTemplate(template({ kind: 'url', url: 'https://cdn.example.com/a.webp' })), 'template_unknown_field');
    expectCode(() => importCharacterTemplate(template({ kind: 'url' })), 'template_avatar_invalid');
});

test('exports JSON and can explicitly omit an otherwise valid avatar', () => {
    const source = template({ kind: 'embedded', dataUrl: signedDataUrl('image/webp') });
    const withoutAvatar = JSON.parse(exportCharacterTemplate(source, { includeAvatar: false }));
    assert.deepEqual(withoutAvatar, { format: CHARACTER_TEMPLATE_FORMAT, character: adultCharacter() });

    const withAvatar = importCharacterTemplate(exportCharacterTemplate(source));
    assert.deepEqual(withAvatar.avatar, source.avatar);
});

test('requires a complete explicitly adult candidate through the shared candidate normalizer', () => {
    const underage = template();
    underage.character.隐藏资料.实际年龄 = 17;
    expectCode(() => importCharacterTemplate(underage), 'template_character_invalid');

    const notNew = template();
    notNew.character.与玩家关系.状态 = '已匹配';
    expectCode(() => importCharacterTemplate(notNew), 'template_character_invalid');
});

test('strictly rejects unknown, dangerous, and credential fields at every envelope boundary', () => {
    const unknown = template();
    unknown.extra = true;
    expectCode(() => importCharacterTemplate(unknown), 'template_unknown_field');

    const credential = template();
    credential.apiKey = 'sk-should-never-be-accepted';
    expectCode(() => importCharacterTemplate(credential), 'template_sensitive_key');

    const avatarCredential = template({ kind: 'embedded', dataUrl: signedDataUrl('image/png'), token: 'never' });
    expectCode(() => importCharacterTemplate(avatarCredential), 'template_sensitive_key');

    const polluted = template();
    Object.defineProperty(polluted, '__proto__', { value: 'polluted', enumerable: true });
    expectCode(() => importCharacterTemplate(polluted), 'template_dangerous_key');

    const characterCredential = template();
    characterCredential.character.公开资料.apiKey = 'never';
    expectCode(() => importCharacterTemplate(characterCredential), 'template_character_invalid');
});

test('rejects malformed envelopes, accessors, unsupported versions, and source HTML', () => {
    expectCode(() => importCharacterTemplate('{oops'), 'template_invalid_json');

    const invalidFormat = template();
    invalidFormat.format = 'yuelema.character/v2';
    expectCode(() => importCharacterTemplate(invalidFormat), 'template_format_invalid');

    const accessor = template();
    Object.defineProperty(accessor, 'avatar', { enumerable: true, get() { throw new Error('must not execute'); } });
    expectCode(() => importCharacterTemplate(accessor), 'template_accessor_or_hidden_field');

    // HTML delivered as a URL avatar now dies on the removed url key itself.
    const html = template({ kind: 'url', url: '<img src=x onerror=alert(1)>' });
    expectCode(() => importCharacterTemplate(html), 'template_unknown_field');

    // Base64-encoded HTML is rejected because it cannot carry a PNG binary signature.
    const encodedHtml = template({ kind: 'embedded', dataUrl: 'data:image/png;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' });
    expectCode(() => importCharacterTemplate(encodedHtml), 'template_avatar_invalid');
});

test('rejects unsupported avatar details, mismatched signatures, and over-limit embedded data URLs', () => {
    const wrongMime = template({ kind: 'embedded', dataUrl: 'data:image/gif;base64,R0lGODlh' });
    expectCode(() => importCharacterTemplate(wrongMime), 'template_avatar_invalid');

    // Claimed media type must match the leading binary signature bytes.
    const pngWithJpegBytes = template({
        kind: 'embedded',
        dataUrl: `data:image/png;base64,${Buffer.from(AVATAR_SIGNATURE_BYTES['image/jpeg']).toString('base64')}`,
    });
    expectCode(() => importCharacterTemplate(pngWithJpegBytes), 'template_avatar_invalid');

    const jpegWithPngBytes = template({
        kind: 'embedded',
        dataUrl: `data:image/jpeg;base64,${Buffer.from(AVATAR_SIGNATURE_BYTES['image/png']).toString('base64')}`,
    });
    expectCode(() => importCharacterTemplate(jpegWithPngBytes), 'template_avatar_invalid');

    // RIFF prefix without the WEBP fourcc at bytes 8-11 is not a WebP file.
    const truncatedWebp = template({ kind: 'embedded', dataUrl: 'data:image/webp;base64,UklGRg==' });
    expectCode(() => importCharacterTemplate(truncatedWebp), 'template_avatar_invalid');

    const overLimit = template({
        kind: 'embedded',
        dataUrl: `data:image/png;base64,${'A'.repeat(MAX_EMBEDDED_AVATAR_DATA_URL_LENGTH)}`,
    });
    expectCode(() => importCharacterTemplate(overLimit), 'template_avatar_invalid');
});

test('projects all thrown errors to stable user-safe information', () => {
    let thrown;
    // Base64 of "<script>secret</script>" smuggled as a PNG: rejected by the signature check.
    try { importCharacterTemplate(template({ kind: 'embedded', dataUrl: 'data:image/png;base64,PHNjcmlwdD5zZWNyZXQ8L3NjcmlwdD4=' })); }
    catch (error) { thrown = error; }
    const projected = projectCharacterTemplateError(thrown);
    assert.deepEqual(projected, { code: 'template_avatar_invalid', message: '头像资料不符合安全格式。' });
    assert.equal(JSON.stringify(projected).includes('secret'), false);
    assert.equal(thrown.message.includes('secret'), false);

    assert.deepEqual(projectCharacterTemplateError(new Error('raw secret')), {
        code: 'template_invalid', message: '角色模板无效。',
    });
});

test('normalizeEmbeddedAvatarDataUrl verifies signatures, enforces the size bound, and normalizes case', () => {
    // Media-type case is normalized while the base64 body is preserved verbatim.
    assert.equal(
        normalizeEmbeddedAvatarDataUrl('data:image/PNG;base64,iVBORw0KGgo='),
        'data:image/png;base64,iVBORw0KGgo=',
    );
    for (const mimeType of ['image/png', 'image/jpeg', 'image/webp']) {
        const dataUrl = signedDataUrl(mimeType);
        assert.equal(normalizeEmbeddedAvatarDataUrl(dataUrl), dataUrl);
    }

    // Signature mismatches for every accepted media type are rejected.
    expectCode(() => normalizeEmbeddedAvatarDataUrl(`data:image/png;base64,${Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).toString('base64')}`), 'template_avatar_invalid');
    expectCode(() => normalizeEmbeddedAvatarDataUrl(`data:image/jpeg;base64,${Buffer.from(AVATAR_SIGNATURE_BYTES['image/webp']).toString('base64')}`), 'template_avatar_invalid');
    expectCode(() => normalizeEmbeddedAvatarDataUrl(`data:image/webp;base64,${Buffer.from(AVATAR_SIGNATURE_BYTES['image/png']).toString('base64')}`), 'template_avatar_invalid');

    // Non-string, empty, untrimmed, non-image, and malformed base64 inputs are rejected.
    expectCode(() => normalizeEmbeddedAvatarDataUrl(null), 'template_avatar_invalid');
    expectCode(() => normalizeEmbeddedAvatarDataUrl(''), 'template_avatar_invalid');
    expectCode(() => normalizeEmbeddedAvatarDataUrl(' data:image/png;base64,iVBORw0KGgo= '), 'template_avatar_invalid');
    expectCode(() => normalizeEmbeddedAvatarDataUrl('data:text/html;base64,iVBORw0KGgo='), 'template_avatar_invalid');
    expectCode(() => normalizeEmbeddedAvatarDataUrl('data:image/png;base64,@@@@'), 'template_avatar_invalid');

    // Size limit: a signed payload padded to exactly the limit passes; one byte over fails.
    const prefix = 'data:image/png;base64,';
    const signedBody = Buffer.from([...AVATAR_SIGNATURE_BYTES['image/png'], 0]).toString('base64'); // 12 chars, no padding
    const fillLength = ((MAX_EMBEDDED_AVATAR_DATA_URL_LENGTH - prefix.length - signedBody.length) >> 2) << 2;
    const atLimit = `${prefix}${signedBody}${'A'.repeat(fillLength)}`;
    assert.ok(atLimit.length <= MAX_EMBEDDED_AVATAR_DATA_URL_LENGTH);
    assert.equal(normalizeEmbeddedAvatarDataUrl(atLimit), atLimit);
    expectCode(() => normalizeEmbeddedAvatarDataUrl(`${prefix}${signedBody}${'A'.repeat(fillLength + 4)}`), 'template_avatar_invalid');
});

test('dropLegacyUrlAvatar strips the avatar only from the exact persisted legacy URL envelope', () => {
    const character = adultCharacter();
    const legacy = { format: CHARACTER_TEMPLATE_FORMAT, character, avatar: { kind: 'url', url: 'https://cdn.example.com/a.webp' } };
    const stripped = dropLegacyUrlAvatar(legacy);
    assert.deepEqual(stripped, { format: CHARACTER_TEMPLATE_FORMAT, character });
    assert.equal(Object.hasOwn(stripped, 'avatar'), false);

    // The avatar-free copy passes the normal import path; the URL never survives anywhere.
    const imported = importCharacterTemplate(stripped);
    assert.equal(Object.hasOwn(imported, 'avatar'), false);
    assert.equal(JSON.stringify(imported).includes('cdn.example.com'), false);
});

test('dropLegacyUrlAvatar returns null for anything but the exact legacy envelope', () => {
    const base = () => ({ format: CHARACTER_TEMPLATE_FORMAT, character: adultCharacter() });

    assert.equal(dropLegacyUrlAvatar(null), null);
    assert.equal(dropLegacyUrlAvatar('{"avatar":{"kind":"url"}}'), null);
    assert.equal(dropLegacyUrlAvatar([]), null);
    assert.equal(dropLegacyUrlAvatar(base()), null); // no avatar key at all

    // Extra keys anywhere disqualify the envelope.
    assert.equal(dropLegacyUrlAvatar({ ...base(), avatar: { kind: 'url', url: 'https://a.example/' }, extra: 1 }), null);
    assert.equal(dropLegacyUrlAvatar({ ...base(), avatar: { kind: 'url', url: 'https://a.example/', token: 'never' } }), null);

    // Only the literal legacy kind=url with a string url is eligible.
    assert.equal(dropLegacyUrlAvatar({ ...base(), avatar: { kind: 'embedded', url: 'https://a.example/' } }), null);
    assert.equal(dropLegacyUrlAvatar({ ...base(), avatar: { kind: 'url', url: 42 } }), null);
    assert.equal(dropLegacyUrlAvatar({ ...base(), avatar: { kind: 'url' } }), null);

    // Accessors must not execute and disqualify the envelope.
    let executed = false;
    const accessor = base();
    Object.defineProperty(accessor, 'avatar', {
        enumerable: true,
        get() { executed = true; return { kind: 'url', url: 'https://a.example/' }; },
    });
    assert.equal(dropLegacyUrlAvatar(accessor), null);
    assert.equal(executed, false);

    const avatarAccessor = base();
    avatarAccessor.avatar = {};
    Object.defineProperty(avatarAccessor.avatar, 'url', {
        enumerable: true,
        get() { executed = true; return 'https://a.example/'; },
    });
    Object.defineProperty(avatarAccessor.avatar, 'kind', { enumerable: true, value: 'url' });
    assert.equal(dropLegacyUrlAvatar(avatarAccessor), null);
    assert.equal(executed, false);

    // Prototype pollution attempts are rejected without touching prototypes.
    const polluted = base();
    polluted.avatar = { kind: 'url', url: 'https://a.example/' };
    Object.defineProperty(polluted, '__proto__', { value: { hijacked: true }, enumerable: true });
    assert.equal(dropLegacyUrlAvatar(polluted), null);

    const foreignPrototype = Object.assign(Object.create({ hidden: true }), base());
    foreignPrototype.avatar = { kind: 'url', url: 'https://a.example/' };
    assert.equal(dropLegacyUrlAvatar(foreignPrototype), null);

    const foreignAvatarPrototype = base();
    foreignAvatarPrototype.avatar = Object.assign(Object.create({ kind: 'url' }), { kind: 'url', url: 'https://a.example/', extra: 1 });
    assert.equal(dropLegacyUrlAvatar(foreignAvatarPrototype), null);
});
