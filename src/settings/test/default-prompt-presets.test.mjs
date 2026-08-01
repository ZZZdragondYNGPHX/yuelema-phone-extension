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
    for (const id of [BUILTIN_PROMPT_PRESET_IDS.serviceProfileSfw, BUILTIN_PROMPT_PRESET_IDS.serviceProfileNsfw]) {
        assert.match(presetById.get(id).content, /性别、性取向/u, `${id} 必须读取玩家公开匹配条件`);
        assert.match(presetById.get(id).content, /最高优先级硬条件/u, `${id} 必须声明性别与性取向不可被覆盖`);
        assert.match(presetById.get(id).content, /双向性别\/性取向兼容/u, `${id} 必须要求候选人与玩家双向兼容`);
        assert.match(presetById.get(id).content, /玩家明确不喜欢的性别/u, `${id} 不得为题材多样性生成错误性别`);
    }
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

test('SFW 内置提示词升级为恋爱 App 质感的指导式文案（v15 基线）', () => {
    const GUIDANCE_BASELINE = {
        [BUILTIN_PROMPT_PRESET_IDS.recommendationSfw]: [/使用痕迹/, /钩子/, /套话|AI 腔/, /基础匹配硬条件/],
        [BUILTIN_PROMPT_PRESET_IDS.privateChatSfw]: [/有自己生活的真人/, /浪漫张力/, /直球/, /不应因此降温/],
        [BUILTIN_PROMPT_PRESET_IDS.groupChatSfw]: [/有辨识度/, /有来有回/, /长在自己人设上/, /圆桌会议/],
        [BUILTIN_PROMPT_PRESET_IDS.forumSfw]: [/像真人写的/, /情绪温度/, /有来有回/, /拉开差异/],
        [BUILTIN_PROMPT_PRESET_IDS.chatSummarySfw]: [/温度而非流水账/, /关键瞬间/, /话头|悬念/, /接住上次的气氛/],
        [BUILTIN_PROMPT_PRESET_IDS.characterCompletionSfw]: [/咬合/, /本人口吻/, /套话/],
        [BUILTIN_PROMPT_PRESET_IDS.characterAuthoringSfw]: [/反差/, /小缺点/, /钩子/, /纵深/],
        [BUILTIN_PROMPT_PRESET_IDS.serviceProfileSfw]: [/临时恋人|生活搭子/, /卖点/, /陪伴项目/, /流水线话术/],
        [BUILTIN_PROMPT_PRESET_IDS.soulMatchSfw]: [/同一类人/, /具体词优于空泛词/],
        [BUILTIN_PROMPT_PRESET_IDS.voiceMatchSfw]: [/纯关键词驱动/, /相处画面/, /具体词优于空泛词/],
        [BUILTIN_PROMPT_PRESET_IDS.imageMatchSfw]: [/画面词/, /生活抓拍感/, /互相印证/],
    };
    const presets = presetsByMode('SFW');
    assert.equal(Object.keys(GUIDANCE_BASELINE).length, presets.length, '每个 SFW 预设都必须有文案指导基线');
    for (const preset of presets) {
        for (const pattern of GUIDANCE_BASELINE[preset.id]) {
            assert.match(preset.content, pattern, `${preset.id} 缺少文案指导：${pattern}`);
        }
        assert.match(preset.content, /明确成年|成年人/, `${preset.id} 缺少成年边界`);
        assert.ok(preset.content.length <= 12_000, `${preset.id} 超出提示词长度上限`);
    }
    // 与功能语义对齐的关键条款抽查。
    const byId = new Map(createBuiltinPromptPresets().map((preset) => [preset.id, preset]));
    assert.match(byId.get(BUILTIN_PROMPT_PRESET_IDS.voiceMatchSfw).content, /不读取、不考虑、不假设玩家的性别、性取向/, '描述匹配必须保持纯关键词驱动、不读玩家资料');
    assert.match(byId.get(BUILTIN_PROMPT_PRESET_IDS.recommendationSfw).content, /性别与性取向必须服从程序给出的基础匹配硬条件/, '推荐刷新必须尊重候选人性别硬条件');
    assert.match(byId.get(BUILTIN_PROMPT_PRESET_IDS.privateChatSfw).content, /只要尊重已知边界，就不是冒犯/, '私聊必须带 SFW 版友好直白宽容条款');
    assert.match(byId.get(BUILTIN_PROMPT_PRESET_IDS.serviceProfileSfw).content, /租借陪伴服务者/, '约伴 SFW 必须是租借伴侣式日常/恋爱陪伴定位');
});

test('NSFW 内置提示词以明确成年、自愿的全尺度色情表达为默认', () => {
    for (const preset of presetsByMode('NSFW')) {
        assert.match(preset.content, /明确成年|所有人物必须明确成年|明确成年的/, `${preset.id} 缺少成年边界`);
        assert.match(preset.content, /自愿/, `${preset.id} 缺少自愿边界`);
        assert.match(preset.content, /边界清晰|清晰边界/, `${preset.id} 缺少清晰边界`);
        assert.match(preset.content, /同意可撤回|同意明确且可撤回/, `${preset.id} 缺少可撤回同意边界`);
        assert.match(
            preset.content,
            /全尺度|色情强度上限|不设.*上限/,
            `${preset.id} 缺少全尺度成人表达许可`,
        );
        assert.match(preset.content, /裸体/u, `${preset.id} 缺少裸体题材许可`);
        assert.match(preset.content, /性交/u, `${preset.id} 缺少明确性行为许可`);
        assert.match(preset.content, /BDSM/u, `${preset.id} 缺少成人玩法许可`);
        assert.match(
            preset.content,
            /优先|默认|主要话题|完整保留|不设色情强度上限/,
            `${preset.id} 没有把成人表达放在默认优先级`,
        );
        assert.doesNotMatch(
            preset.content,
            /不露骨|不得.{0,8}露骨|只能.{0,12}(?:含糊|隐晦|保守)/,
            `${preset.id} 不得继续施加成人尺度限制`,
        );
        assert.match(preset.content, /不强制.{0,12}(?:含蓄|转场|淡出)|不要求含蓄化|不得含蓄化/u, `${preset.id} 缺少禁止自动降级条款`);
    }
});

test('NSFW 内置提示词从许可式升级为指导式：各职能带具体情色写作指导', () => {
    const GUIDANCE_BASELINE = {
        [BUILTIN_PROMPT_PRESET_IDS.recommendationNsfw]: [/咬合/, /独有的色/, /身体、动作、感官和反应链/, /钩子/],
        [BUILTIN_PROMPT_PRESET_IDS.privateChatNsfw]: [/节奏可慢可快/, /具体动作、感官、身体反应/, /粗俗直白|细腻煽情/, /角色本人/],
        [BUILTIN_PROMPT_PRESET_IDS.groupChatNsfw]: [/各有性格/, /接梗/, /多人互动/, /人设/],
        [BUILTIN_PROMPT_PRESET_IDS.forumNsfw]: [/直接钩子/, /调情接龙/, /交换玩法/, /具体动作、感官/],
        [BUILTIN_PROMPT_PRESET_IDS.chatSummaryNsfw]: [/关键节点/, /称呼/, /兴奋点/, /未完成悬念/],
        [BUILTIN_PROMPT_PRESET_IDS.characterCompletionNsfw]: [/咬合/, /具体场景、动作、节奏/, /身体反应/, /口癖/],
        [BUILTIN_PROMPT_PRESET_IDS.characterAuthoringNsfw]: [/人格化/, /延伸或反差/, /具体场景、动作、器官/, /钩子/, /欲望层次/],
        [BUILTIN_PROMPT_PRESET_IDS.serviceProfileNsfw]: [/动作、器官、节奏/, /成人菜单/, /招牌玩法/, /互相咬合/],
        [BUILTIN_PROMPT_PRESET_IDS.soulMatchNsfw]: [/具体欲望维度/, /身体部位/, /玩法组合/, /同一种色/],
        [BUILTIN_PROMPT_PRESET_IDS.voiceMatchNsfw]: [/主导或顺从/, /身体部位/, /玩法组合/, /节奏/],
        [BUILTIN_PROMPT_PRESET_IDS.imageMatchNsfw]: [/构图/, /光线/, /身体细节/, /完整色情场景/],
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
    assert.match(preset.content, /不把普通饭搭子、轻社交或含蓄暧昧当作默认/);
    assert.match(preset.content, /至少一个公开标签应直接给出成人向特征/);
    assert.doesNotMatch(preset.content, /只能克制地放在允许的公开/u);
});

test('候选生成类内置预设带阈值人设映射与三层资料互相印证指导', () => {
    const byId = new Map(createBuiltinPromptPresets().map((preset) => [preset.id, preset]));
    const candidateGeneratingIds = [
        BUILTIN_PROMPT_PRESET_IDS.recommendationSfw,
        BUILTIN_PROMPT_PRESET_IDS.recommendationNsfw,
        BUILTIN_PROMPT_PRESET_IDS.characterCompletionSfw,
        BUILTIN_PROMPT_PRESET_IDS.characterCompletionNsfw,
        BUILTIN_PROMPT_PRESET_IDS.characterAuthoringSfw,
        BUILTIN_PROMPT_PRESET_IDS.characterAuthoringNsfw,
        BUILTIN_PROMPT_PRESET_IDS.serviceProfileSfw,
        BUILTIN_PROMPT_PRESET_IDS.serviceProfileNsfw,
    ];
    for (const id of candidateGeneratingIds) {
        const content = byId.get(id).content;
        assert.match(content, /容忍度/u, `${id} 缺少阈值容忍度语义`);
        assert.match(content, /彻底断联/u, `${id} 缺少拉黑底线语义`);
        assert.match(content, /至少高 20/u, `${id} 缺少拉黑与已读不回的间距指导`);
        assert.match(content, /不低于 60/u, `${id} 缺少拉黑下限指导`);
        assert.match(content, /互相印证/u, `${id} 缺少三层资料互相印证要求`);
        assert.match(content, /公开年龄段内/u, `${id} 缺少实际年龄与公开年龄段一致性要求`);
    }
    // 真机已发案例：角色先发露骨暗示、玩家对等回应却被秒拉黑。NSFW 生成预设
    // 必须带“对等回应须有同级容忍”的一致性条款。
    for (const id of [
        BUILTIN_PROMPT_PRESET_IDS.recommendationNsfw,
        BUILTIN_PROMPT_PRESET_IDS.characterCompletionNsfw,
        BUILTIN_PROMPT_PRESET_IDS.characterAuthoringNsfw,
        BUILTIN_PROMPT_PRESET_IDS.serviceProfileNsfw,
    ]) {
        assert.match(byId.get(id).content, /对等.{0,8}(?:热度|直白)[^。；]*回应|相同边界内的回应必须有同级容忍/u, `${id} 缺少对等回应容忍条款`);
        assert.match(byId.get(id).content, /秒拉黑|因顾客回应自己主动挑起的话题而拉黑/u, `${id} 缺少禁止秒拉黑条款`);
    }
    // 阈值-初值联动（代码级校验：初始戒备 ≤ 40、已读不回阈值 ≥ 开局压力 + 15）
    // 需要在推荐 / 完整创作 / 约伴服务的生成预设里有对应的一句提示。
    for (const id of [
        BUILTIN_PROMPT_PRESET_IDS.recommendationSfw,
        BUILTIN_PROMPT_PRESET_IDS.recommendationNsfw,
        BUILTIN_PROMPT_PRESET_IDS.characterAuthoringSfw,
        BUILTIN_PROMPT_PRESET_IDS.characterAuthoringNsfw,
        BUILTIN_PROMPT_PRESET_IDS.serviceProfileSfw,
        BUILTIN_PROMPT_PRESET_IDS.serviceProfileNsfw,
    ]) {
        assert.match(byId.get(id).content, /初始戒备不要超过 40/u, `${id} 缺少初始戒备上限提示`);
        assert.match(byId.get(id).content, /开局互动压力之上留出足够安全边际/u, `${id} 缺少已读不回阈值安全边际提示`);
    }
});

test('NSFW 内置提示词只保留成年、自愿、隐私、事实与现实执行硬边界', () => {
    for (const preset of presetsByMode('NSFW')) {
        assert.match(preset.content, /未成年人/, `${preset.id} 缺少未成年人禁止项`);
        assert.match(preset.content, /胁迫/, `${preset.id} 缺少胁迫禁止项`);
        assert.match(preset.content, /非自愿/, `${preset.id} 缺少非自愿禁止项`);
        assert.match(preset.content, /隐私|隐藏资料/, `${preset.id} 缺少隐私隔离`);
        assert.match(
            preset.content,
            /不得[^。；]*(?:伪造|新增|编造)[^。；]*(?:现实经历|事实)|不新增玩家经历/,
            `${preset.id} 缺少不得伪造玩家现实经历的边界`,
        );
        assert.match(
            preset.content,
            /不得自动[^。；]*(?:现实行动|触发现实行动)|不得[^。；]*自动触发现实行动/,
            `${preset.id} 缺少不得自动触发现实行动的边界`,
        );
    }
});
