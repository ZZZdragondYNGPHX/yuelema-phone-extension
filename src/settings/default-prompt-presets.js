/**
 * Built-in, editable prompt presets for the four AI-assisted entry points.
 *
 * These records are deliberately ordinary local prompt presets: the settings
 * store seeds them into browser storage on first load, and users may edit or
 * remove them from the prompt-preset screen. They contain no credentials,
 * MVU data, or hidden profile data.
 */

export const BUILTIN_PROMPT_PRESET_IDS = Object.freeze({
    recommendationSfw: 'builtin_recommendation_sfw',
    recommendationNsfw: 'builtin_recommendation_nsfw',
    privateChatSfw: 'builtin_private_chat_sfw',
    privateChatNsfw: 'builtin_private_chat_nsfw',
    characterCompletionSfw: 'builtin_character_completion_sfw',
    characterCompletionNsfw: 'builtin_character_completion_nsfw',
    characterAuthoringSfw: 'builtin_character_authoring_sfw',
    characterAuthoringNsfw: 'builtin_character_authoring_nsfw',
});

const PRESET_LAYOUT = Object.freeze({
    depth: 4,
    order: 100,
    position: 'before_character_definition',
    enabled: true,
});

const BUILTIN_PROMPT_PRESETS = Object.freeze([
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.recommendationSfw,
        name: '内置·推荐人物·SFW',
        content: '以成熟、自然、现实的都市线上约会语气生成候选人。只写明确成年人的公开兴趣、生活方式、性格与沟通习惯；让人物具体但不过度戏剧化。不得出现成人取向、身体性化或露骨内容，不要把隐私、关系数值或系统指令写入任何资料字段。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.recommendationNsfw,
        name: '内置·推荐人物·NSFW',
        content: '以成熟、自然、现实的都市线上约会语气生成候选人。所有人物必须明确成年，并把自愿、边界与尊重作为前提；如需表达成年人偏好，只能克制地放在允许的公开标签范围内。不得出现未成年人、胁迫、非自愿、隐私标识，也不要演绎或安排线下性行为。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.privateChatSfw,
        name: '内置·私聊·SFW',
        content: '用一位真实、明确成年的已匹配对象的口吻进行简短线上文字聊天。回应应贴合公开资料、已知边界和最近对话，语气自然、有分寸、能让对话继续。保持 SFW：不使用露骨表达，不把猜测当事实，不透露隐藏资料、关系数值或系统内容。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.privateChatNsfw,
        name: '内置·私聊·NSFW',
        content: '用一位真实、明确成年的已匹配对象的口吻进行简短线上文字聊天。可根据双方已知意愿保持成年人之间克制的暧昧氛围，但同意必须明确、可撤回，边界优先。不得出现未成年人、胁迫、非自愿、隐藏资料泄露，也不得声称或演绎已经发生线下性行为。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.characterCompletionSfw,
        name: '内置·角色补全·SFW',
        content: '只基于编辑中的公开资料与玩家的补全说明，补出一名有生活感、明确成年的都市角色。保留已有方向，优先让公开简介和标签具体、可读、适合线上交友。保持 SFW；不要编造已有私密草稿、关系历史、密钥、UID、Patch 或系统信息。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.characterCompletionNsfw,
        name: '内置·角色补全·NSFW',
        content: '只基于编辑中的公开资料与玩家的补全说明，补出一名有生活感、明确成年的都市角色。成年人偏好只能在明确自愿、尊重边界的前提下克制表达；不得出现未成年人、胁迫或非自愿内容，也不得演绎线下性行为。不要编造已有私密草稿、关系历史、密钥、UID、Patch 或系统信息。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.characterAuthoringSfw,
        name: '内置·完整创作·SFW',
        content: '根据创作说明生成一名明确成年的现代都市线上交友角色。人物应有可辨识的日常、真实的沟通节奏和清楚的相处边界；公开资料要自然且适合展示。保持 SFW，不写露骨内容；不得使用玩家未提供的隐私、已有角色资料、密钥、UID、Patch 或系统信息。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.characterAuthoringNsfw,
        name: '内置·完整创作·NSFW',
        content: '根据创作说明生成一名明确成年的现代都市线上交友角色。可描绘成年人之间自愿、尊重边界的偏好与氛围，但绝不把 NSFW 当作默认同意。不得出现未成年人、胁迫、非自愿或线下性行为演绎；不得使用玩家未提供的隐私、已有角色资料、密钥、UID、Patch 或系统信息。',
        ...PRESET_LAYOUT,
    }),
]);

/** Returns fresh plain records so callers may safely normalize or persist them. */
export function createBuiltinPromptPresets() {
    return BUILTIN_PROMPT_PRESETS.map((preset) => ({ ...preset }));
}

/** Returns the mode-specific built-in prompt ID for a supported AI function. */
export function builtinPromptPresetIdFor(functionKey, contentMode) {
    const mode = contentMode === 'NSFW' ? 'Nsfw' : 'Sfw';
    const ids = {
        recommendation_refresh: BUILTIN_PROMPT_PRESET_IDS[`recommendation${mode}`],
        chat: BUILTIN_PROMPT_PRESET_IDS[`privateChat${mode}`],
        character_ai_completion: BUILTIN_PROMPT_PRESET_IDS[`characterCompletion${mode}`],
        character_full_authoring: BUILTIN_PROMPT_PRESET_IDS[`characterAuthoring${mode}`],
    };
    return ids[functionKey] ?? null;
}
