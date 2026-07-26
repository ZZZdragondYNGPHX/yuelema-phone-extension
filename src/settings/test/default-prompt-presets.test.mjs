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
    'service_profile_generation',
]);

function presetsByMode(contentMode) {
    return createBuiltinPromptPresets().filter((preset) => preset.contentMode === contentMode);
}

test('内置 SFW/NSFW 提示词保持一一隔离的模式映射', () => {
    const presets = createBuiltinPromptPresets();
    const presetById = new Map(presets.map((preset) => [preset.id, preset]));

    assert.equal(presets.length, 22);
    assert.equal(presetsByMode('SFW').length, 11);
    assert.equal(presetsByMode('NSFW').length, 11);
    assert.equal(new Set(presets.map((preset) => preset.id)).size, presets.length);

    for (const functionKey of FUNCTION_KEYS) {
        const sfwId = builtinPromptPresetIdFor(functionKey, 'SFW');
        const nsfwId = builtinPromptPresetIdFor(functionKey, 'NSFW');
        assert.notEqual(sfwId, nsfwId, `${functionKey} 的两个模式不得共用提示词`);
        assert.equal(presetById.get(sfwId)?.contentMode, 'SFW');
        assert.equal(presetById.get(nsfwId)?.contentMode, 'NSFW');
    }

    // 「描述匹配」只改显示名与文案；持久化 ID 恒为 builtin_voice_match_*。
    assert.equal(BUILTIN_PROMPT_PRESET_IDS.voiceMatchSfw, 'builtin_voice_match_sfw');
    assert.equal(BUILTIN_PROMPT_PRESET_IDS.voiceMatchNsfw, 'builtin_voice_match_nsfw');
    assert.equal(presetById.get(BUILTIN_PROMPT_PRESET_IDS.voiceMatchSfw).name, '内置·描述匹配·SFW');
    assert.equal(presetById.get(BUILTIN_PROMPT_PRESET_IDS.voiceMatchNsfw).name, '内置·描述匹配·NSFW');
    assert.doesNotMatch(presetById.get(BUILTIN_PROMPT_PRESET_IDS.voiceMatchSfw).content, /语音/u);
    assert.doesNotMatch(presetById.get(BUILTIN_PROMPT_PRESET_IDS.voiceMatchNsfw).content, /语音/u);

    assert.equal(BUILTIN_PROMPT_PRESET_IDS.privateChatSfw, 'builtin_private_chat_sfw');
    assert.equal(BUILTIN_PROMPT_PRESET_IDS.privateChatNsfw, 'builtin_private_chat_nsfw');
    assert.equal(BUILTIN_PROMPT_PRESET_IDS.serviceProfileSfw, 'builtin_service_profile_sfw');
    assert.equal(BUILTIN_PROMPT_PRESET_IDS.serviceProfileNsfw, 'builtin_service_profile_nsfw');
});

test('SFW 内置提示词只用一句话表达日常社交尺度，不再携带硬性禁止清单', () => {
    for (const preset of presetsByMode('SFW')) {
        assert.match(
            preset.content,
            /本模式保持日常社交尺度/,
            `${preset.id} 缺少日常社交尺度提示`,
        );
        assert.doesNotMatch(
            preset.content,
            /不得出现成人取向|不得把成人或色情取向混入|不使用露骨|不写露骨|不引入性化|不输出性化、露骨/,
            `${preset.id} 不得保留 SFW 硬性禁止清单`,
        );
        assert.doesNotMatch(
            preset.content,
            /允许(?:直截了当地|直接的).*?(?:调情|露骨文爱|欲望表达)|可直接(?:呈现|写明|描绘|保留|使用).*?(?:露骨文爱|欲望偏好)/,
            `${preset.id} 不得混入 NSFW 直接成人表达授权`,
        );
    }
});

test('NSFW 内置提示词以自愿成年人的主动线上成人表达为默认', () => {
    for (const preset of presetsByMode('NSFW')) {
        assert.match(preset.content, /明确成年|所有人物必须明确成年|明确成年的/, `${preset.id} 缺少成年边界`);
        assert.match(preset.content, /自愿/, `${preset.id} 缺少自愿边界`);
        assert.match(preset.content, /边界清晰|清晰边界/, `${preset.id} 缺少清晰边界`);
        assert.match(preset.content, /同意可撤回|同意明确且可撤回/, `${preset.id} 缺少可撤回同意边界`);
        assert.match(
            preset.content,
            /直白调情|直截了当地调情|直接的成人调情|成人调情|主动调情|露骨文爱|线上文爱|欲望表达|欲望偏好|情色角色扮演|成人向特征/,
            `${preset.id} 缺少直接成人表达许可`,
        );
        assert.match(
            preset.content,
            /优先|默认主动|主要话题|完整保留/,
            `${preset.id} 没有把成人表达放在默认优先级`,
        );
        assert.doesNotMatch(
            preset.content,
            /克制|不露骨|不得.{0,8}露骨|只能.{0,12}(?:含糊|隐晦|保守)/,
            `${preset.id} 不得继续施加成人尺度限制`,
        );
    }
});

test('NSFW 内置提示词从许可式升级为指导式：各职能带具体情色写作指导', () => {
    const GUIDANCE_BASELINE = {
        [BUILTIN_PROMPT_PRESET_IDS.recommendationNsfw]: [/咬合/, /独有的色/, /感官画面/, /钩子/],
        [BUILTIN_PROMPT_PRESET_IDS.privateChatNsfw]: [/欲擒故纵/, /感官细节/, /破碎|喘息/, /命令与恳求/, /隔着屏幕/],
        [BUILTIN_PROMPT_PRESET_IDS.groupChatNsfw]: [/荤法/, /有来有回/, /分寸差异/, /人设/],
        [BUILTIN_PROMPT_PRESET_IDS.forumNsfw]: [/钩子/, /有来有回|接龙/, /个性差异/, /感官细节/],
        [BUILTIN_PROMPT_PRESET_IDS.chatSummaryNsfw]: [/温度而非流水账/, /关键节点/, /兴奋点与雷区/, /热度/],
        [BUILTIN_PROMPT_PRESET_IDS.characterCompletionNsfw]: [/咬合/, /独有的色/, /场景、节奏/, /口癖/],
        [BUILTIN_PROMPT_PRESET_IDS.characterAuthoringNsfw]: [/人格化/, /延伸或反差/, /口癖/, /钩子/, /欲望层次/],
        [BUILTIN_PROMPT_PRESET_IDS.serviceProfileNsfw]: [/剧目要具体可选/, /卖点/, /感官细节/, /咬合/],
        [BUILTIN_PROMPT_PRESET_IDS.soulMatchNsfw]: [/欲望维度/, /细化/, /同一种色/],
        [BUILTIN_PROMPT_PRESET_IDS.voiceMatchNsfw]: [/欲望信号/, /节奏与强度/, /羞耻点/],
        [BUILTIN_PROMPT_PRESET_IDS.imageMatchNsfw]: [/氛围与构图/, /光线/, /衣物细节/, /独有的色/],
    };
    const presets = presetsByMode('NSFW');
    assert.equal(Object.keys(GUIDANCE_BASELINE).length, presets.length, '每个 NSFW 预设都必须有写作指导基线');
    for (const preset of presets) {
        for (const pattern of GUIDANCE_BASELINE[preset.id]) {
            assert.match(preset.content, pattern, `${preset.id} 缺少写作指导：${pattern}`);
        }
        assert.ok(preset.content.length <= 12_000, `${preset.id} 超出提示词长度上限`);
    }
});

test('NSFW 推荐人物预设不再把普通社交或含糊成人标签当作默认', () => {
    const preset = createBuiltinPromptPresets().find((item) => item.id === BUILTIN_PROMPT_PRESET_IDS.recommendationNsfw);
    assert.match(preset.content, /不把普通饭搭子或轻社交当作默认/);
    assert.match(preset.content, /至少一个公开标签应直接给出成人向特征/);
    assert.doesNotMatch(preset.content, /只能克制地放在允许的公开/u);
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
