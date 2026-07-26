import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createUiIcon, UI_ICON_NAMES } from '../icon.js';

// 设计系统 2.0（策划书 §3.4）追加的图标名。
const DESIGN_SYSTEM_ICON_NAMES = Object.freeze(['logo', 'grip', 'pin', 'search', 'plus', 'hearts']);

// §3.4 需要但此前已存在的名字（本轮不新增，回归其仍在册即可）。
const PREEXISTING_REQUIRED_NAMES = Object.freeze(['send', 'close', 'more_vertical', 'chevron_right', 'chevron_left']);

test('设计系统 2.0 新图标全部注册且可创建为 24 viewBox 的惰性本地 SVG', () => {
    const env = installMiniDom();
    try {
        for (const name of DESIGN_SYSTEM_ICON_NAMES) {
            assert.ok(UI_ICON_NAMES.includes(name), `设计系统图标未注册：${name}`);
            const icon = createUiIcon(env.document, name);
            assert.equal(icon.tagName, 'SVG');
            assert.equal(icon.dataset.icon, name, `${name} 不得回退到兜底图标`);
            assert.equal(icon.getAttribute('viewBox'), '0 0 24 24');
            assert.equal(icon.getAttribute('stroke'), 'currentColor');
            assert.equal(icon.getAttribute('stroke-width'), '1.8');
            assert.equal(icon.getAttribute('fill'), 'none');
            assert.equal(icon.getAttribute('aria-hidden'), 'true');
            assert.equal(icon.getAttribute('focusable'), 'false');
            assert.equal(icon.textContent, '', '图标内不得有文字节点');
            assert.ok(icon.childNodes.length >= 1, `${name} 必须含本地路径`);
            for (const child of icon.childNodes) assert.equal(child.tagName, 'PATH');
        }
    } finally { env.restore(); }
});

test('§3.4 所需既有图标名仍在册（send/close/more_vertical 等未被破坏）', () => {
    const env = installMiniDom();
    try {
        for (const name of PREEXISTING_REQUIRED_NAMES) {
            assert.ok(UI_ICON_NAMES.includes(name), `既有图标缺失：${name}`);
            const icon = createUiIcon(env.document, name);
            assert.equal(icon.dataset.icon, name);
            assert.equal(icon.getAttribute('viewBox'), '0 0 24 24');
        }
    } finally { env.restore(); }
});

test('logo 是双路径（气泡 + 心形）、hearts 是双心路径', () => {
    const env = installMiniDom();
    try {
        assert.equal(createUiIcon(env.document, 'logo').childNodes.length, 2);
        assert.equal(createUiIcon(env.document, 'hearts').childNodes.length, 2);
    } finally { env.restore(); }
});
