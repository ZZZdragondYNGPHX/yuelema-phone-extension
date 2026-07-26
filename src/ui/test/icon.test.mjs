import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createUiIcon, UI_ICON_NAMES } from '../icon.js';

const PHASE_67_ICON_NAMES = Object.freeze([
    'group_chat',
    'forum',
    'edit_profile',
    'create_character',
    'favorite',
    'settings',
    'connection',
    'prompt',
    'privacy',
    'image',
    'sparkle',
    'summary',
    'console',
    'info',
    'chevron_right',
]);

test('local UI icon factory creates inert namespaced SVGs for the navigation system', () => {
    const env = installMiniDom();
    try {
        for (const name of UI_ICON_NAMES) {
            const icon = createUiIcon(env.document, name, { className: 'yl-test-icon' });
            assert.equal(icon.tagName, 'SVG');
            assert.equal(icon.className, 'yl-test-icon');
            assert.equal(icon.dataset.icon, name);
            assert.equal(icon.getAttribute('aria-hidden'), 'true');
            assert.equal(icon.getAttribute('focusable'), 'false');
            assert.equal(icon.getAttribute('viewBox'), '0 0 24 24');
            assert.ok(icon.childNodes.length >= 1);
            assert.equal(icon.textContent, '');
        }
    } finally { env.restore(); }
});

test('Phase 67 hub icon names are registered and render as inert local SVGs', () => {
    const env = installMiniDom();
    try {
        for (const name of PHASE_67_ICON_NAMES) {
            assert.ok(UI_ICON_NAMES.includes(name), `Phase 67 icon is not registered: ${name}`);
            const icon = createUiIcon(env.document, name);
            assert.equal(icon.tagName, 'SVG');
            assert.equal(icon.dataset.icon, name);
            assert.equal(icon.getAttribute('aria-hidden'), 'true');
            assert.equal(icon.getAttribute('focusable'), 'false');
            assert.equal(icon.getAttribute('tabindex'), null);
            assert.equal(icon.getAttribute('role'), null);
            assert.equal(icon.getAttribute('onclick'), null);
            assert.equal(icon.textContent, '');
            assert.ok(icon.childNodes.length >= 1, `${name} must contain local SVG paths`);
            for (const child of icon.childNodes) assert.equal(child.tagName, 'PATH');
        }
    } finally { env.restore(); }
});

test('unknown icon names fail closed to an inert profile glyph', () => {
    const env = installMiniDom();
    try {
        const icon = createUiIcon(env.document, 'not-a-real-icon');
        assert.equal(icon.tagName, 'SVG');
        assert.equal(icon.dataset.icon, 'profile');
        assert.equal(icon.getAttribute('aria-hidden'), 'true');
        assert.equal(icon.getAttribute('focusable'), 'false');
        assert.equal(icon.textContent, '');
    } finally { env.restore(); }
});
