import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CHARACTER_TEMPLATE_FORMAT,
    MAX_EMBEDDED_AVATAR_DATA_URL_LENGTH,
    exportCharacterTemplate,
    importCharacterTemplate,
    projectCharacterTemplateError,
} from '../character-template-codec.js';

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

test('supports exactly placeholder, URL, and image data URL avatars', () => {
    const placeholder = importCharacterTemplate(template({ kind: 'placeholder' }));
    assert.deepEqual(placeholder.avatar, { kind: 'placeholder' });

    const url = importCharacterTemplate(template({ kind: 'url', url: 'https://cdn.example.com/a.webp' }));
    assert.deepEqual(url.avatar, { kind: 'url', url: 'https://cdn.example.com/a.webp' });

    const embedded = importCharacterTemplate(template({ kind: 'embedded', dataUrl: 'data:image/PNG;base64,iVBORw0KGgo=' }));
    assert.deepEqual(embedded.avatar, { kind: 'embedded', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' });
});

test('exports JSON and can explicitly omit an otherwise valid avatar', () => {
    const source = template({ kind: 'embedded', dataUrl: 'data:image/webp;base64,UklGRg==' });
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

    const avatarCredential = template({ kind: 'url', url: 'https://cdn.example.com/a.png', token: 'never' });
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

    const html = template({ kind: 'url', url: '<img src=x onerror=alert(1)>' });
    expectCode(() => importCharacterTemplate(html), 'template_avatar_invalid');

    const encodedHtml = template({ kind: 'embedded', dataUrl: 'data:image/png;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' });
    expectCode(() => importCharacterTemplate(encodedHtml), 'template_avatar_invalid');
});

test('rejects unsupported avatar details and over-limit embedded data URLs', () => {
    const fileUrl = template({ kind: 'url', url: 'file:///C:/private.png' });
    expectCode(() => importCharacterTemplate(fileUrl), 'template_avatar_invalid');

    const wrongMime = template({ kind: 'embedded', dataUrl: 'data:image/gif;base64,R0lGODlh' });
    expectCode(() => importCharacterTemplate(wrongMime), 'template_avatar_invalid');

    const overLimit = template({
        kind: 'embedded',
        dataUrl: `data:image/png;base64,${'A'.repeat(MAX_EMBEDDED_AVATAR_DATA_URL_LENGTH)}`,
    });
    expectCode(() => importCharacterTemplate(overLimit), 'template_avatar_invalid');
});

test('projects all thrown errors to stable user-safe information', () => {
    let thrown;
    try { importCharacterTemplate(template({ kind: 'url', url: '<script>secret</script>' })); }
    catch (error) { thrown = error; }
    const projected = projectCharacterTemplateError(thrown);
    assert.deepEqual(projected, { code: 'template_avatar_invalid', message: '头像资料不符合安全格式。' });
    assert.equal(JSON.stringify(projected).includes('secret'), false);

    assert.deepEqual(projectCharacterTemplateError(new Error('raw secret')), {
        code: 'template_invalid', message: '角色模板无效。',
    });
});
