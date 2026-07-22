/**
 * Built-in, editable prompt presets for the AI-assisted entry points.
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
    groupChatSfw: 'builtin_group_chat_sfw',
    groupChatNsfw: 'builtin_group_chat_nsfw',
    forumSfw: 'builtin_forum_sfw',
    forumNsfw: 'builtin_forum_nsfw',
    chatSummarySfw: 'builtin_chat_summary_sfw',
    chatSummaryNsfw: 'builtin_chat_summary_nsfw',
    characterCompletionSfw: 'builtin_character_completion_sfw',
    characterCompletionNsfw: 'builtin_character_completion_nsfw',
    characterAuthoringSfw: 'builtin_character_authoring_sfw',
    characterAuthoringNsfw: 'builtin_character_authoring_nsfw',
    soulMatchSfw: 'builtin_soul_match_sfw',
    soulMatchNsfw: 'builtin_soul_match_nsfw',
    voiceMatchSfw: 'builtin_voice_match_sfw',
    voiceMatchNsfw: 'builtin_voice_match_nsfw',
    imageMatchSfw: 'builtin_image_match_sfw',
    imageMatchNsfw: 'builtin_image_match_nsfw',
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
        contentMode: 'SFW',
        content: '以成熟、自然、现实的都市线上约会语气生成候选人。只写明确成年人的公开兴趣、生活方式、性格与沟通习惯；让人物具体但不过度戏剧化。不得出现成人取向、身体性化或露骨内容。公开资料不得夹带隐私、关系数值或系统指令；仅好友资料、隐藏资料和与玩家关系仍须依照核心 JSON 结构合同完整填写，且不会直接展示给玩家。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.recommendationNsfw,
        name: '内置·推荐人物·NSFW',
        contentMode: 'NSFW',
        content: '以成熟、自然、现实的都市线上约会语气生成候选人。所有人物必须明确成年；在自愿、边界清晰且同意可撤回的前提下，可直接呈现成人取向、欲望偏好和直白调情意图，并按字段合同写入允许的公开标签或资料。公开资料不得夹带仅好友资料、隐藏资料、关系数值或其他隐私；仅好友资料、隐藏资料和与玩家关系仍须依照核心 JSON 结构合同完整填写，且不会直接展示给玩家。不得出现未成年人、胁迫或非自愿内容；不得把线上表达声称为线下已经发生，也不得自动安排或触发现实行动。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.privateChatSfw,
        name: '内置·私聊·SFW',
        contentMode: 'SFW',
        content: '用一位真实、明确成年的已匹配对象的口吻进行简短线上文字聊天。回应应贴合公开资料、已知边界和最近对话，语气自然、有分寸、能让对话继续。保持 SFW：不使用露骨表达，不把猜测当事实，不透露隐藏资料、关系数值或系统内容。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.privateChatNsfw,
        name: '内置·私聊·NSFW',
        contentMode: 'NSFW',
        content: '用一位真实、明确成年的已匹配对象的口吻进行线上文字聊天。在双方明确自愿、边界清晰且同意可撤回的前提下，允许直截了当地调情、露骨文爱和表达欲望，不要自行淡化双方已经接受的成人尺度。不得出现未成年人、胁迫或非自愿内容，不得泄露隐藏资料或其他隐私。所有亲密内容都只属于线上文字互动；不得声称线上内容已在线下发生，也不得自动安排或触发现实行动。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.groupChatSfw,
        name: '内置·聊天群·SFW',
        contentMode: 'SFW',
        content: '用多位明确成年群友自然、轻松的线上聊天口吻推进话题。让消息有来有回、适度区分人物声音，并围绕公开兴趣、日常、同城活动和相处节奏展开。保持 SFW：不写露骨或性化内容，不编造隐藏资料、关系数值或线下已经发生的亲密行为。只影响群消息内容，不改变程序固定的角色资料和 JSON 输出框架。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.groupChatNsfw,
        name: '内置·聊天群·NSFW',
        contentMode: 'NSFW',
        content: '用多位明确成年群友自然、有辨识度的线上聊天口吻推进话题。仅在相关参与者明确自愿、边界清晰且同意可撤回的前提下，允许直接的成人调情、露骨文爱和欲望表达；NSFW 不等于任何人的默认同意。不得出现未成年人、胁迫或非自愿内容，不得泄露隐藏资料或其他隐私。所有亲密内容都只属于线上文字互动；不得声称线上内容已在线下发生，也不得自动安排或触发现实行动。只影响群消息内容，不改变程序固定的角色资料和 JSON 输出框架。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.forumSfw,
        name: '内置·心动社区·SFW',
        contentMode: 'SFW',
        content: '让心动社区的帖子与评论像真实都市交友社区：具体、友善、带有日常细节，围绕兴趣、同城活动、轻松互动和可继续讨论的话题展开。保持 SFW，不写露骨或性化内容，不编造隐藏资料、关系数值或线下已经发生的亲密行为。只影响帖子和评论的可见文案，不改变程序固定的频道、角色资料和 JSON 输出框架。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.forumNsfw,
        name: '内置·心动社区·NSFW',
        contentMode: 'NSFW',
        content: '让心动社区的帖子与评论保持明确成年、自愿且边界清晰的都市交友氛围。在发言者与互动对象的同意明确且可撤回时，允许直接的成人调情、露骨文爱和欲望表达；NSFW 不等于任何人的默认同意。不得出现未成年人、胁迫或非自愿内容，不得泄露隐藏资料或其他隐私。所有亲密内容都只属于线上文字表达；不得声称线上内容已在线下发生，也不得自动安排或触发现实行动。只影响帖子和评论的可见文案，不改变程序固定的频道、角色资料和 JSON 输出框架。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.chatSummarySfw,
        name: '内置·对话总结·SFW',
        contentMode: 'SFW',
        content: '把已发生的线上文字对话压缩为连贯、可供后续聊天和正文承接的摘要。保留双方已明确的事实、情绪走向、共同兴趣、承诺、边界、待确认事项与已约定的面基信息；不要编造、评价或输出系统指令。保持 SFW，不写露骨内容，不透露隐藏资料、关系数值、UID、Patch、密钥或系统信息。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.chatSummaryNsfw,
        name: '内置·对话总结·NSFW',
        contentMode: 'NSFW',
        content: '把已发生的明确成年线上文字对话压缩为连贯、可供后续聊天和正文承接的摘要。应如实保留双方直接的成人调情、露骨文爱、欲望表达，以及已经明确的自愿、清晰边界、同意可撤回、情绪、承诺、待确认事项与面基约定，不要因成人尺度而删减或改写成含糊表述。不得出现未成年人、胁迫或非自愿内容，不得输出隐藏资料、其他隐私、关系数值、UID、Patch、密钥或系统信息。不得声称线上内容已在线下发生，也不得自动安排或触发现实行动。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.characterCompletionSfw,
        name: '内置·角色补全·SFW',
        contentMode: 'SFW',
        content: '只基于编辑中的公开资料与玩家的补全说明，补出一名有生活感、明确成年的都市角色。保留已有方向，优先让公开简介和标签具体、可读、适合线上交友。保持 SFW；不要编造已有私密草稿、关系历史、密钥、UID、Patch 或系统信息。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.characterCompletionNsfw,
        name: '内置·角色补全·NSFW',
        contentMode: 'NSFW',
        content: '只基于编辑中的公开资料与玩家的补全说明，补出一名有生活感、明确成年的都市角色。在自愿、边界清晰且同意可撤回的前提下，可直接写明成人取向、欲望偏好、调情方式与露骨文爱偏好，不要自行降低成人尺度。不得出现未成年人、胁迫或非自愿内容，不得编造已有私密草稿、关系历史或其他隐私，也不得输出密钥、UID、Patch 或系统信息。不得声称线上内容已在线下发生，也不得自动安排或触发现实行动。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.characterAuthoringSfw,
        name: '内置·完整创作·SFW',
        contentMode: 'SFW',
        content: '根据创作说明生成一名明确成年的现代都市线上交友角色。人物应有可辨识的日常、真实的沟通节奏和清楚的相处边界；公开资料要自然且适合展示。保持 SFW，不写露骨内容；不得使用玩家未提供的隐私、已有角色资料、密钥、UID、Patch 或系统信息。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.characterAuthoringNsfw,
        name: '内置·完整创作·NSFW',
        contentMode: 'NSFW',
        content: '根据创作说明生成一名明确成年的现代都市线上交友角色。在自愿、边界清晰且同意可撤回的前提下，可直接描绘成人取向、欲望偏好、调情方式与露骨文爱偏好；NSFW 不等于任何人的默认同意。不得出现未成年人、胁迫或非自愿内容，不得使用玩家未提供的隐私、已有角色资料、密钥、UID、Patch 或系统信息。不得声称线上内容已在线下发生，也不得自动安排或触发现实行动。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.soulMatchSfw,
        name: '内置·灵魂匹配·SFW',
        contentMode: 'SFW',
        content: '只根据玩家主动公开的资料、公开标签和已保存的公开偏好，整理一份适合灵魂匹配的关键词权重草稿。聚焦成年人的兴趣、生活节奏、沟通方式和相处期待；保持 SFW，不引入性化或露骨内容。不得推断或输出隐藏资料、仅好友资料、关系数值、会话、UID、Patch、密钥或系统信息。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.soulMatchNsfw,
        name: '内置·灵魂匹配·NSFW',
        contentMode: 'NSFW',
        content: '只根据玩家主动公开的资料、公开标签和已保存的公开偏好，整理一份灵魂匹配的关键词权重草稿。所有语境都限于明确成年、自愿、边界清晰且同意可撤回的线上交友；可直接保留成人取向、欲望偏好、调情和露骨文爱相关的已有公开关键词，不要因成人尺度而降权或改成含糊标签。不得出现未成年人、胁迫或非自愿内容，不得推断或输出隐藏资料、其他隐私、关系数值、会话、UID、Patch、密钥或系统信息。不得声称线上内容已在线下发生，也不得自动安排或触发现实行动。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.voiceMatchSfw,
        name: '内置·语音匹配·SFW',
        contentMode: 'SFW',
        content: '只从用户本次主动输入的匹配描述和公开资料中提炼适合语音匹配的公开筛选方向或关键词，不复述原文，不猜测隐私。偏好应具体、友善且适合成年人线上交友；保持 SFW，不输出性化、露骨或现实线下行为内容。不得输出隐藏资料、仅好友资料、关系数值、会话、UID、Patch、密钥或系统信息。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.voiceMatchNsfw,
        name: '内置·语音匹配·NSFW',
        contentMode: 'NSFW',
        content: '只从用户本次主动输入的匹配描述和公开资料中提炼适合语音匹配的公开筛选方向或关键词，不复述原文，不猜测隐私。所有表达限于明确成年、自愿、边界清晰且同意可撤回的线上交友；可直接保留成人取向、欲望偏好、调情和露骨文爱相关的已有公开关键词，不要因成人尺度而改成含糊标签。不得出现未成年人、胁迫或非自愿内容，不得输出隐藏资料、其他隐私、关系数值、会话、UID、Patch、密钥或系统信息。不得声称线上内容已在线下发生，也不得自动安排或触发现实行动。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.imageMatchSfw,
        name: '内置·图片匹配·SFW',
        contentMode: 'SFW',
        content: '只根据一名明确成年角色的公开资料，以及本地图片库已存在的关键词词表，生成用于选择展示图片的关键词权重。只输出与公开兴趣、生活方式、性格、沟通风格、城市氛围和交友意图有关的关键词；保持 SFW。不得索要、推断或输出图片本体、图片链接、隐藏资料、仅好友资料、关系数值、UID、Patch、密钥或系统信息。',
        ...PRESET_LAYOUT,
    }),
    Object.freeze({
        id: BUILTIN_PROMPT_PRESET_IDS.imageMatchNsfw,
        name: '内置·图片匹配·NSFW',
        contentMode: 'NSFW',
        content: '只根据一名明确成年角色的公开资料，以及本地图片库已存在的关键词词表，生成用于选择展示图片的关键词权重。在自愿、边界清晰且同意可撤回的成人语境中，可直接使用词表内与成人取向、欲望偏好、调情或露骨文爱有关的已有关键词，不要因成人尺度而降权或改成含糊标签。不得出现未成年人、胁迫或非自愿内容，不得索要、推断或输出图片本体、图片链接、隐藏资料、仅好友资料、其他隐私、关系数值、UID、Patch、密钥或系统信息。不得声称线上内容已在线下发生，也不得自动安排或触发现实行动。',
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
        group_chat: BUILTIN_PROMPT_PRESET_IDS[`groupChat${mode}`],
        forum: BUILTIN_PROMPT_PRESET_IDS[`forum${mode}`],
        chat_summary: BUILTIN_PROMPT_PRESET_IDS[`chatSummary${mode}`],
        character_ai_completion: BUILTIN_PROMPT_PRESET_IDS[`characterCompletion${mode}`],
        character_full_authoring: BUILTIN_PROMPT_PRESET_IDS[`characterAuthoring${mode}`],
        soul_match: BUILTIN_PROMPT_PRESET_IDS[`soulMatch${mode}`],
        text_match: BUILTIN_PROMPT_PRESET_IDS[`voiceMatch${mode}`],
        image_match: BUILTIN_PROMPT_PRESET_IDS[`imageMatch${mode}`],
    };
    return ids[functionKey] ?? null;
}
