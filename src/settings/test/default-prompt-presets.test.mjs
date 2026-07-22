import assert from 'node:assert/strict';
import test from 'node:test';
import {
    BUILTIN_PROMPT_PRESET_IDS,
    builtinPromptPresetIdFor,
    createBuiltinPromptPresets,
} from '../default-prompt-presets.js';

const FUNCTION_KEYS = Object.freeze([
    'recommendation_refresh',
    'chat',
    'group_chat',
    'forum',
    'chat_summary',
    'character_ai_completion',
    'character_full_authoring',
    'soul_match',
    'text_match',
    'image_match',
]);

function presetsByMode(contentMode) {
    return createBuiltinPromptPresets().filter((preset) => preset.contentMode === contentMode);
}

test('内置 SFW/NSFW 提示词保持一一隔离的模式映射', () => {
    const presets = createBuiltinPromptPresets();
    const presetById = new Map(presets.map((preset) => [preset.id, preset]));

    assert.equal(presets.length, 20);
    assert.equal(presetsByMode('SFW').length, 10);
    assert.equal(presetsByMode('NSFW').length, 10);
    assert.equal(new Set(presets.map((preset) => preset.id)).size, presets.length);

    for (const functionKey of FUNCTION_KEYS) {
        const sfwId = builtinPromptPresetIdFor(functionKey, 'SFW');
        const nsfwId = builtinPromptPresetIdFor(functionKey, 'NSFW');
        assert.notEqual(sfwId, nsfwId, `${functionKey} 的两个模式不得共用提示词`);
        assert.equal(presetById.get(sfwId)?.contentMode, 'SFW');
        assert.equal(presetById.get(nsfwId)?.contentMode, 'NSFW');
    }

    assert.equal(BUILTIN_PROMPT_PRESET_IDS.privateChatSfw, 'builtin_private_chat_sfw');
    assert.equal(BUILTIN_PROMPT_PRESET_IDS.privateChatNsfw, 'builtin_private_chat_nsfw');
});

test('SFW 内置提示词继续限制露骨或性化内容', () => {
    for (const preset of presetsByMode('SFW')) {
        assert.match(
            preset.content,
            /保持 SFW|不得出现成人取向|不使用露骨|不写露骨|不引入性化|不输出性化/,
            `${preset.id} 缺少 SFW 非露骨限制`,
        );
        assert.doesNotMatch(
            preset.content,
            /允许(?:直截了当地|直接的).*?(?:调情|露骨文爱|欲望表达)|可直接(?:呈现|写明|描绘|保留|使用).*?(?:露骨文爱|欲望偏好)/,
            `${preset.id} 不得混入 NSFW 直接成人表达授权`,
        );
    }
});

test('NSFW 内置提示词允许自愿成年人的直接线上成人表达且不再要求克制', () => {
    for (const preset of presetsByMode('NSFW')) {
        assert.match(preset.content, /明确成年|所有人物必须明确成年|明确成年的/, `${preset.id} 缺少成年边界`);
        assert.match(preset.content, /自愿/, `${preset.id} 缺少自愿边界`);
        assert.match(preset.content, /边界清晰|清晰边界/, `${preset.id} 缺少清晰边界`);
        assert.match(preset.content, /同意可撤回|同意明确且可撤回/, `${preset.id} 缺少可撤回同意边界`);
        assert.match(
            preset.content,
            /直白调情|直截了当地调情|直接的成人调情|露骨文爱|欲望表达|欲望偏好/,
            `${preset.id} 缺少直接成人表达许可`,
        );
        assert.doesNotMatch(
            preset.content,
            /克制|不露骨|不得.{0,8}露骨|只能.{0,12}(?:含糊|隐晦|保守)/,
            `${preset.id} 不得继续施加成人尺度限制`,
        );
    }
});

test('NSFW 内置提示词仍保留同意、隐私、线上边界和现实行动硬限制', () => {
    for (const preset of presetsByMode('NSFW')) {
        assert.match(preset.content, /未成年人/, `${preset.id} 缺少未成年人禁止项`);
        assert.match(preset.content, /胁迫/, `${preset.id} 缺少胁迫禁止项`);
        assert.match(preset.content, /非自愿/, `${preset.id} 缺少非自愿禁止项`);
        assert.match(preset.content, /隐私|隐藏资料/, `${preset.id} 缺少隐私隔离`);
        assert.match(
            preset.content,
            /不得[^。；]*线上[^。；]*线下[^。；]*发生/,
            `${preset.id} 缺少线上内容不得冒充线下事实的边界`,
        );
        assert.match(
            preset.content,
            /不得自动安排或触发现实行动/,
            `${preset.id} 缺少不得自动触发现实行动的边界`,
        );
    }
});
