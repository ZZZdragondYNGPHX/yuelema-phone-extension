import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { avatarFallbackText, createAvatarView, safeAvatarImageSource } from '../avatar-view.js';

const miniDom = installMiniDom();
test.after(() => miniDom.restore());

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

test('安全来源复用现有头像策略并支持图片库记录', () => {
    assert.equal(safeAvatarImageSource('https://cdn.example.test/avatar.webp'), 'https://cdn.example.test/avatar.webp');
    assert.equal(
        safeAvatarImageSource({ kind: 'url', url: 'http://images.example.test/member.png' }),
        'http://images.example.test/member.png',
    );
    assert.equal(
        safeAvatarImageSource({ source: { kind: 'embedded', dataUrl: PNG_DATA_URL } }),
        PNG_DATA_URL,
    );
});

test('拒绝脚本、非图片 data、凭据 URL 和访问器包装，不执行 getter', () => {
    let getterCalls = 0;
    const accessorRecord = {};
    Object.defineProperty(accessorRecord, 'source', {
        enumerable: true,
        get() {
            getterCalls += 1;
            return { kind: 'url', url: 'https://unsafe.example.test/avatar.png' };
        },
    });

    assert.equal(safeAvatarImageSource('javascript:alert(1)'), '');
    assert.equal(safeAvatarImageSource('blob:https://example.test/id'), '');
    assert.equal(safeAvatarImageSource('data:text/html;base64,PGgxPmJvb208L2gxPg=='), '');
    assert.equal(safeAvatarImageSource('https://user:pass@example.test/avatar.png'), '');
    assert.equal(safeAvatarImageSource(accessorRecord), '');
    assert.equal(getterCalls, 0);
});

test('昵称回退取首个 Unicode code point 并提供稳定兜底', () => {
    assert.equal(avatarFallbackText(' 林晚 '), '林');
    assert.equal(avatarFallbackText('🌙月'), '🌙');
    assert.equal(avatarFallbackText('', '我'), '我');
    assert.equal(avatarFallbackText(null, ''), '人');
});

test('NPC 头像创建 img，设置隐私属性且 MiniDOM 可查询', () => {
    const avatar = createAvatarView({
        documentRef: miniDom.document,
        nickname: '林晚',
        imageSource: { source: { kind: 'url', url: 'https://cdn.example.test/lin.webp' } },
        className: 'yl-member-avatar',
        imageClassName: 'yl-member-avatar-image',
    });

    const image = avatar.querySelector('img');
    assert.equal(avatar.tagName, 'SPAN');
    assert.equal(avatar.className, 'yl-member-avatar');
    assert.equal(avatar.dataset.imageStatus, 'loading');
    assert.equal(image?.className, 'yl-member-avatar-image');
    assert.equal(image?.getAttribute('src'), 'https://cdn.example.test/lin.webp');
    assert.equal(image?.getAttribute('alt'), '林晚的头像');
    assert.equal(image?.getAttribute('loading'), 'lazy');
    assert.equal(image?.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(image?.getAttribute('decoding'), 'async');

    image.dispatchEvent(new Event('load'));
    assert.equal(avatar.dataset.imageStatus, 'ready');
});

test('玩家 data 头像可渲染，加载失败后删除图片并回退首字', () => {
    const avatar = createAvatarView({
        documentRef: miniDom.document,
        nickname: '小岚',
        imageSource: { kind: 'embedded', dataUrl: PNG_DATA_URL },
        className: 'yl-player-avatar',
        alt: '当前个人头像',
        tagName: 'button',
    });
    const image = avatar.querySelector('img');
    assert.equal(avatar.tagName, 'BUTTON');
    assert.equal(image?.getAttribute('src'), PNG_DATA_URL);
    assert.equal(image?.getAttribute('alt'), '当前个人头像');

    image.dispatchEvent(new Event('error'));
    assert.equal(avatar.querySelector('img'), null);
    assert.equal(avatar.textContent, '小');
    assert.equal(avatar.dataset.imageStatus, 'failed');
});

test('无效群组成员头像立即回退，不创建 img，也不暴露原始来源', () => {
    const avatar = createAvatarView({
        documentRef: miniDom.document,
        nickname: '<script>',
        imageSource: 'file:///C:/secret/avatar.png',
        fallback: '群',
    });

    assert.equal(avatar.querySelector('img'), null);
    assert.equal(avatar.textContent, '<');
    assert.equal(avatar.dataset.imageStatus, 'fallback');
    assert.doesNotMatch(avatar.textContent, /secret|file:/u);
});

test('缺少 DOM 时抛出固定错误且非法标签退回 span', () => {
    assert.throws(() => createAvatarView({ documentRef: null }), /avatar_view_document_required/u);
    const avatar = createAvatarView({ documentRef: miniDom.document, nickname: '群友', tagName: 'img onerror=alert(1)' });
    assert.equal(avatar.tagName, 'SPAN');
    assert.equal(avatar.textContent, '群');
});
