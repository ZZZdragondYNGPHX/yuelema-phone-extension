import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePromptPreset, renderPromptPreset } from '../prompt-compiler.js';

const base = { id: 'p', name: '测试预设', depth: 4, order: 0, position: 'after_character_definition', enabled: true };

test('世界书式预设按位置、深度和顺序编译且跳过禁用条目', () => {
    const preset = { ...base, content: JSON.stringify({ schema: 'yuelema.prompt-entries', schemaVersion: 1, entries: [
        { id: 'a', name: '后', depth: 10, order: 2, position: 'after_character_definition', enabled: true, content: '后置' },
        { id: 'b', name: '前二', depth: 5, order: 2, position: 'before_character_definition', enabled: true, content: '前二' },
        { id: 'c', name: '前一', depth: 5, order: 1, position: 'before_character_definition', enabled: true, content: '前一' },
        { id: 'd', name: '停用', depth: 0, order: 0, position: 'after_character_definition', enabled: false, content: '不可见' },
    ] }) };
    assert.deepEqual(compilePromptPreset(preset), { before: ['前一', '前二'], after: ['后置'] });
    assert.deepEqual(renderPromptPreset(preset), { before: '前一\n\n前二', after: '后置' });
});

test('旧版单条纯文本预设保持可用，畸形信封安全降级', () => {
    assert.deepEqual(renderPromptPreset({ ...base, content: '旧条目' }), { before: '', after: '旧条目' });
    assert.deepEqual(renderPromptPreset({ ...base, content: '{' }), { before: '', after: '{' });
    assert.deepEqual(renderPromptPreset({ ...base, enabled: false, content: '不应使用' }), { before: '', after: '' });
});
