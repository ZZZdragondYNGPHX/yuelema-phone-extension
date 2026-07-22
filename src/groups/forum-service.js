import { toPublicLlmError } from '../llm/openai-compatible-client.js';
import { renderPromptPreset } from '../settings/prompt-compiler.js';
import { buildPublicGroupLlmContext, cleanGroupLlmText, isSafeGroupLlmOutput, parseGroupLlmJson, projectPublicPlayerProfile } from './group-llm-safety.js';
import { buildGroupBrowseModel } from './group-discovery-service.js';
import { groupForumProfileForModel, normalizeGroupForumProfile, publicProfileToGroupForumProfile } from './group-forum-store.js';

const ERROR_MESSAGES = Object.freeze({
    forum_target_invalid: '请选择一个可用的论坛主题。',
    forum_group_not_found: '该论坛主题暂不可用。',
    forum_topic_invalid: '请输入简短、明确的发帖主题。',
    forum_settings_unavailable: '论坛设置暂不可用。',
    forum_settings_invalid: '论坛连接设置无效。',
    forum_connection_missing: '请先在设置中为论坛绑定连接预设。',
    forum_llm_unavailable: '当前浏览器未提供论坛模型连接。',
    forum_invalid_json: '论坛模型没有返回可识别的帖子草稿。',
    forum_response_invalid: '论坛模型草稿不符合安全格式，已丢弃。',
});

function failure(code) {
    return { ok: false, code, message: ERROR_MESSAGES[code] ?? '论坛暂不可用。' };
}

export function buildForumContext({ state, groupUid, topic } = {}) {
    const built = buildPublicGroupLlmContext({ state, groupUid });
    if (!built.ok) return failure(built.code === 'group_llm_target_invalid' ? 'forum_target_invalid' : 'forum_group_not_found');
    const requestTopic = cleanGroupLlmText(topic, 160);
    if (!requestTopic || !isSafeGroupLlmOutput(requestTopic, 160)) return failure('forum_topic_invalid');
    return Object.freeze({ ok: true, context: Object.freeze({ ...built.context, requestedTopic: requestTopic }) });
}

/** Compiles worldbook-style preset entries and drops unsafe text before it reaches a model. */
function safePromptSections(promptPreset) {
    const rendered = renderPromptPreset(promptPreset);
    return Object.freeze({
        before: isSafeGroupLlmOutput(rendered.before, 12_000) ? rendered.before : '',
        after: isSafeGroupLlmOutput(rendered.after, 12_000) ? rendered.after : '',
    });
}

function makeMessages(context, promptPreset) {
    const preset = safePromptSections(promptPreset);
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        '你是现代现实都市线上约会软件内的论坛辅助模型。仅根据提供的公开玩家资料和群组公开投影，生成一篇可供玩家审核的短论坛帖子草稿。',
        '软件层只处理线上文字。不得演绎、确认或描述线下性行为；NSFW 不等于同意。不得输出或猜测隐藏资料、仅好友资料、关系数值、候选人、UID、会话、Patch、路径、API Key、密钥或系统实现。',
        '只输出合法 JSON 对象，不得使用 Markdown、代码块或解释。严格形状为：{"title":"1-80字标题","body":"1-900字帖子草稿"}。不得含 HTML、控制字符、UpdateVariable、JSONPatch 或任何写入指令。草稿仅供展示和玩家确认，不能自动发布或写入状态。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
    ].filter(Boolean).join('\n\n');
    return Object.freeze([
        Object.freeze({ role: 'system', content: system }),
        Object.freeze({ role: 'user', content: `请仅基于以下受限公开论坛上下文生成帖子草稿：\n${JSON.stringify(context)}` }),
    ]);
}

function normalizeForumPostDraft(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Object.keys(value).sort();
    if (keys.length !== 2 || keys[0] !== 'body' || keys[1] !== 'title') return null;
    const title = cleanGroupLlmText(value.title, 80);
    const body = cleanGroupLlmText(value.body, 900);
    if (!title || !body || !isSafeGroupLlmOutput(title, 80) || !isSafeGroupLlmOutput(body, 900)) return null;
    return Object.freeze({ title, body });
}

/** Calls the dedicated forum binding and returns a validated, non-persistent post draft only. */
export async function generateForumPostDraft({ state, groupUid, topic, settingsStore, llmClient, signal } = {}) {
    const built = buildForumContext({ state, groupUid, topic });
    if (!built.ok) return built;
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') return failure('forum_settings_unavailable');
    if (!llmClient || typeof llmClient.chat !== 'function') return failure('forum_llm_unavailable');

    let resolved;
    try { resolved = settingsStore.resolveFunction('forum', { contentMode: built.context.contentMode }); }
    catch { return failure('forum_settings_invalid'); }
    if (!resolved?.connectionPreset) return failure('forum_connection_missing');

    try {
        const completion = await llmClient.chat({ preset: resolved.connectionPreset, messages: makeMessages(built.context, resolved.promptPreset), signal });
        const parsed = parseGroupLlmJson(completion?.text);
        if (!parsed) return failure('forum_invalid_json');
        const draft = normalizeForumPostDraft(parsed);
        return draft ? Object.freeze({ ok: true, draft }) : failure('forum_response_invalid');
    } catch (error) {
        const publicError = toPublicLlmError(error);
        return { ok: false, code: publicError.code, message: publicError.message, retryable: publicError.retryable };
    }
}

const UPDATE_ERROR_MESSAGES = Object.freeze({
    forum_home_context_invalid: '论坛首页暂时无法读取公开社区信息。',
    forum_home_history_invalid: '论坛首页历史格式异常，未调用模型。',
    forum_post_context_invalid: '当前论坛帖子暂不可用。',
    forum_post_history_invalid: '帖子讨论记录格式异常，未调用模型。',
    forum_update_settings_unavailable: '论坛设置暂不可用。',
    forum_update_settings_invalid: '论坛连接设置无效。',
    forum_update_connection_missing: '请先在设置中为论坛绑定连接预设。',
    forum_update_llm_unavailable: '当前浏览器未提供论坛模型连接。',
    forum_update_invalid_json: '论坛模型没有返回可识别的更新。',
    forum_update_response_invalid: '论坛更新不符合安全格式，已丢弃。',
});

function updateFailure(code) {
    return { ok: false, code, message: UPDATE_ERROR_MESSAGES[code] ?? '论坛更新未完成。' };
}

function ownRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function ownValue(value, key) {
    if (!ownRecord(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function promptSections(promptPreset) {
    const rendered = renderPromptPreset(promptPreset);
    return Object.freeze({
        before: isSafeGroupLlmOutput(rendered.before, 12_000) ? rendered.before : '',
        after: isSafeGroupLlmOutput(rendered.after, 12_000) ? rendered.after : '',
    });
}

function normalizeHistory(value) {
    if (!ownRecord(value) || Object.keys(value).some((key) => !['summaries', 'messages'].includes(key))) return null;
    const summaries = ownValue(value, 'summaries');
    const messages = ownValue(value, 'messages');
    if (!Array.isArray(summaries) || summaries.length > 24 || !Array.isArray(messages) || messages.length > 48) return null;
    const normalizedSummaries = [];
    for (const item of summaries) {
        if (!ownRecord(item) || Object.keys(item).some((key) => !['startFloor', 'endFloor', 'content'].includes(key))) return null;
        const startFloor = ownValue(item, 'startFloor');
        const endFloor = ownValue(item, 'endFloor');
        const content = cleanGroupLlmText(ownValue(item, 'content'), 1_600);
        if (!Number.isInteger(startFloor) || !Number.isInteger(endFloor) || startFloor < 1 || endFloor < startFloor || !content || !isSafeGroupLlmOutput(content, 1_600)) return null;
        normalizedSummaries.push(Object.freeze({ startFloor, endFloor, content }));
    }
    const normalizedMessages = [];
    for (const item of messages) {
        if (!ownRecord(item) || Object.keys(item).some((key) => !['sender', 'speaker', 'content'].includes(key))) return null;
        const sender = ownValue(item, 'sender');
        const speaker = cleanGroupLlmText(ownValue(item, 'speaker'), 80);
        const content = cleanGroupLlmText(ownValue(item, 'content'), 600);
        if (!['user', 'member'].includes(sender) || !speaker || !content || !isSafeGroupLlmOutput(content, 600)) return null;
        normalizedMessages.push(Object.freeze({ sender, speaker, content }));
    }
    return Object.freeze({ summaries: Object.freeze(normalizedSummaries), messages: Object.freeze(normalizedMessages) });
}

function communityContext(state) {
    const groups = buildGroupBrowseModel(state).群组;
    const people = new Map();
    const communities = [];
    for (const group of groups.slice(0, 12)) {
        const members = [];
        for (const person of group.成员.slice(0, 12)) {
            try {
                const profile = groupForumProfileForModel(publicProfileToGroupForumProfile(person.公开资料));
                members.push(profile);
                people.set(profile.nickname.normalize('NFKC').toLowerCase(), profile);
            } catch { /* malformed public data is intentionally omitted */ }
        }
        communities.push(Object.freeze({ topic: group.主题, description: group.描述, members: Object.freeze(members) }));
    }
    return Object.freeze({ communities: Object.freeze(communities), people: Object.freeze([...people.values()]) });
}

/** Public-only context for the pull-to-refresh forum home call. */
export function buildForumHomeRefreshContext({ state, existingTitles = [] } = {}) {
    if (!ownRecord(state) || !Array.isArray(existingTitles) || existingTitles.length > 24) return updateFailure('forum_home_context_invalid');
    const cleanTitles = [];
    for (const title of existingTitles) {
        const clean = cleanGroupLlmText(title, 120);
        if (!clean || !isSafeGroupLlmOutput(clean, 120)) return updateFailure('forum_home_history_invalid');
        cleanTitles.push(clean);
    }
    const community = communityContext(state);
    return Object.freeze({ ok: true, context: Object.freeze({
        contentMode: state?.软件?.内容模式 === 'NSFW' ? 'NSFW' : 'SFW',
        playerPublicProfile: projectPublicPlayerProfile(state.玩家),
        communities: community.communities,
        knownPeople: community.people,
        existingTitles: Object.freeze(cleanTitles),
    }) });
}

function normalizeForumHomeUpdate(value, knownPeople) {
    if (!ownRecord(value) || Object.keys(value).sort().join(',') !== 'participants,posts') return null;
    const participants = ownValue(value, 'participants');
    const posts = ownValue(value, 'posts');
    if (!Array.isArray(participants) || participants.length > 6 || !Array.isArray(posts) || posts.length < 1 || posts.length > 6) return null;
    const names = new Set(knownPeople.map((profile) => String(profile.nickname).normalize('NFKC').toLowerCase()));
    const normalizedParticipants = [];
    for (const participant of participants) {
        try {
            const profile = normalizeGroupForumProfile(participant);
            const key = profile.nickname.normalize('NFKC').toLowerCase();
            if (names.has(key)) return null;
            names.add(key);
            normalizedParticipants.push(profile);
        } catch { return null; }
    }
    const normalizedPosts = [];
    for (const post of posts) {
        if (!ownRecord(post) || Object.keys(post).sort().join(',') !== 'author,body,tags,title,topic') return null;
        const author = cleanGroupLlmText(ownValue(post, 'author'), 80);
        const topic = cleanGroupLlmText(ownValue(post, 'topic'), 80);
        const title = cleanGroupLlmText(ownValue(post, 'title'), 120);
        const body = cleanGroupLlmText(ownValue(post, 'body'), 1_200);
        const tags = ownValue(post, 'tags');
        if (!author || !topic || !title || !body || !names.has(author.normalize('NFKC').toLowerCase()) || !Array.isArray(tags) || tags.length > 6
            || !isSafeGroupLlmOutput(topic, 80) || !isSafeGroupLlmOutput(title, 120) || !isSafeGroupLlmOutput(body, 1_200)) return null;
        const cleanTags = [];
        for (const tag of tags) {
            const clean = cleanGroupLlmText(tag, 32);
            if (!clean || !isSafeGroupLlmOutput(clean, 32) || cleanTags.includes(clean)) return null;
            cleanTags.push(clean);
        }
        normalizedPosts.push(Object.freeze({ author, topic, title, body, tags: Object.freeze(cleanTags) }));
    }
    return Object.freeze({ participants: Object.freeze(normalizedParticipants), posts: Object.freeze(normalizedPosts) });
}

function makeForumHomeMessages(context, promptPreset) {
    const preset = promptSections(promptPreset);
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        '你是现代现实都市线上约会软件的心动社区首页更新模型。只根据公开社区主题和公开人物资料，生成 1–6 篇适合首页展示的短帖子。',
        '可以使用 knownPeople 中已有人物的 nickname；如需新作者，必须先在 participants 给出其公开关键资料。participants 只放本次新出现的临时角色，已有角色不要重复。每位临时角色必须含 nickname、ageRange、gender、city、mbti、zodiac、occupation、interests、presence、matchRate。',
        '软件层只处理线上文字。不得演绎、确认或描述线下性行为；NSFW 不等于同意。不得输出或猜测隐藏资料、仅好友资料、真实 UID、会话、Patch、路径、API Key、密钥或系统实现。',
        '只输出合法 JSON，不得使用 Markdown、代码块或解释。严格形状：{"participants":[{"nickname":"","ageRange":"","gender":"","city":"","mbti":"","zodiac":"","occupation":"","interests":[""],"presence":"在线","matchRate":null}],"posts":[{"author":"knownPeople或participants昵称","topic":"1-80字","title":"1-120字","body":"1-1200字","tags":["1-32字"]}]}。不得输出 HTML、控制字符、UpdateVariable 或 JSONPatch。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
    ].filter(Boolean).join('\n\n');
    return Object.freeze([
        Object.freeze({ role: 'system', content: system }),
        Object.freeze({ role: 'user', content: `请刷新论坛首页。已有标题不可重复：${JSON.stringify(context.existingTitles)}。受限公开上下文：\n${JSON.stringify({ ...context, knownPeople: context.knownPeople })}` }),
    ]);
}

/** Calls the forum binding only after a deliberate, armed pull-to-refresh gesture. */
export async function generateForumHomeRefresh({ state, existingTitles, settingsStore, llmClient, signal } = {}) {
    const built = buildForumHomeRefreshContext({ state, existingTitles });
    if (!built.ok) return built;
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') return updateFailure('forum_update_settings_unavailable');
    if (!llmClient || typeof llmClient.chat !== 'function') return updateFailure('forum_update_llm_unavailable');
    let resolved;
    try { resolved = settingsStore.resolveFunction('forum', { contentMode: built.context.contentMode }); }
    catch { return updateFailure('forum_update_settings_invalid'); }
    if (!resolved?.connectionPreset) return updateFailure('forum_update_connection_missing');
    try {
        const completion = await llmClient.chat({ preset: resolved.connectionPreset, messages: makeForumHomeMessages(built.context, resolved.promptPreset), signal });
        const parsed = parseGroupLlmJson(completion?.text);
        if (!parsed) return updateFailure('forum_update_invalid_json');
        const update = normalizeForumHomeUpdate(parsed, built.context.knownPeople);
        return update ? Object.freeze({ ok: true, update, communityProfiles: built.context.knownPeople }) : updateFailure('forum_update_response_invalid');
    } catch (error) {
        const publicError = toPublicLlmError(error);
        return { ok: false, code: publicError.code, message: publicError.message, retryable: publicError.retryable };
    }
}

function normalizePostConversation(post, history) {
    if (!ownRecord(post) || Object.keys(post).some((key) => !['id', 'topic', 'title', 'body', 'tags', 'author', 'participants', 'messages', 'summaries', 'summaryStatus', 'createdAt'].includes(key))) return null;
    const topic = cleanGroupLlmText(ownValue(post, 'topic'), 80);
    const title = cleanGroupLlmText(ownValue(post, 'title'), 120);
    const body = cleanGroupLlmText(ownValue(post, 'body'), 1_200);
    const participants = ownValue(post, 'participants');
    if (!topic || !title || !body || !Array.isArray(participants) || participants.length > 32) return null;
    let author;
    let normalizedParticipants;
    try {
        author = groupForumProfileForModel(normalizeGroupForumProfile(ownValue(post, 'author')));
        normalizedParticipants = participants.map((profile) => groupForumProfileForModel(normalizeGroupForumProfile(profile)));
    } catch { return null; }
    const normalizedHistory = normalizeHistory(history);
    if (!normalizedHistory) return null;
    return Object.freeze({ topic, title, body, author, participants: Object.freeze(normalizedParticipants), history: normalizedHistory });
}

export function buildForumPostUpdateContext({ state, post, history } = {}) {
    const normalizedPost = normalizePostConversation(post, history);
    if (!normalizedPost) return updateFailure('forum_post_context_invalid');
    return Object.freeze({ ok: true, context: Object.freeze({
        contentMode: state?.软件?.内容模式 === 'NSFW' ? 'NSFW' : 'SFW',
        playerPublicProfile: projectPublicPlayerProfile(state?.玩家),
        post: normalizedPost,
    }) });
}

function normalizeForumConversationUpdate(value, profiles) {
    if (!ownRecord(value) || Object.keys(value).sort().join(',') !== 'messages,participants') return null;
    const participants = ownValue(value, 'participants');
    const messages = ownValue(value, 'messages');
    if (!Array.isArray(participants) || participants.length > 3 || !Array.isArray(messages) || messages.length < 1 || messages.length > 8) return null;
    const names = new Set(profiles.map((profile) => String(profile.nickname).normalize('NFKC').toLowerCase()));
    const normalizedParticipants = [];
    for (const participant of participants) {
        try {
            const profile = normalizeGroupForumProfile(participant);
            const key = profile.nickname.normalize('NFKC').toLowerCase();
            if (names.has(key)) return null;
            names.add(key);
            normalizedParticipants.push(profile);
        } catch { return null; }
    }
    const normalizedMessages = [];
    for (const message of messages) {
        if (!ownRecord(message) || Object.keys(message).sort().join(',') !== 'speaker,text') return null;
        const speaker = cleanGroupLlmText(ownValue(message, 'speaker'), 80);
        const text = cleanGroupLlmText(ownValue(message, 'text'), 480);
        if (!speaker || !text || !isSafeGroupLlmOutput(text, 480) || !names.has(speaker.normalize('NFKC').toLowerCase())) return null;
        normalizedMessages.push(Object.freeze({ speaker, text }));
    }
    return Object.freeze({ participants: Object.freeze(normalizedParticipants), messages: Object.freeze(normalizedMessages) });
}

function makeForumPostMessages(context, promptPreset) {
    const preset = promptSections(promptPreset);
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        '你是现代现实都市线上约会软件内的论坛帖子讨论更新模型。根据公开帖子和受限评论历史，模拟其他用户发表 1–8 条自然评论。',
        '可使用帖子作者或 participants 中已有昵称；如需新评论者，必须先在 participants 给出其公开关键资料。每位临时角色必须含 nickname、ageRange、gender、city、mbti、zodiac、occupation、interests、presence、matchRate。',
        '软件层只处理线上文字。不得演绎、确认或描述线下性行为；NSFW 不等于同意。不得输出或猜测隐藏资料、仅好友资料、真实 UID、会话、Patch、路径、API Key、密钥或系统实现。',
        '只输出合法 JSON，不得使用 Markdown、代码块或解释。严格形状：{"participants":[{"nickname":"","ageRange":"","gender":"","city":"","mbti":"","zodiac":"","occupation":"","interests":[""],"presence":"在线","matchRate":null}],"messages":[{"speaker":"作者、已有参与者或participants昵称","text":"1-480字"}]}。不得输出 HTML、控制字符、UpdateVariable 或 JSONPatch。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
    ].filter(Boolean).join('\n\n');
    return Object.freeze([
        Object.freeze({ role: 'system', content: system }),
        Object.freeze({ role: 'user', content: `请更新该帖子下的讨论：\n${JSON.stringify(context)}` }),
    ]);
}

/** Local-only comments after a user reply in an opened forum post. */
export async function generateForumPostConversationUpdate({ state, post, history, settingsStore, llmClient, signal } = {}) {
    const built = buildForumPostUpdateContext({ state, post, history });
    if (!built.ok) return built;
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') return updateFailure('forum_update_settings_unavailable');
    if (!llmClient || typeof llmClient.chat !== 'function') return updateFailure('forum_update_llm_unavailable');
    let resolved;
    try { resolved = settingsStore.resolveFunction('forum', { contentMode: built.context.contentMode }); }
    catch { return updateFailure('forum_update_settings_invalid'); }
    if (!resolved?.connectionPreset) return updateFailure('forum_update_connection_missing');
    try {
        const completion = await llmClient.chat({ preset: resolved.connectionPreset, messages: makeForumPostMessages(built.context, resolved.promptPreset), signal });
        const parsed = parseGroupLlmJson(completion?.text);
        if (!parsed) return updateFailure('forum_update_invalid_json');
        const people = [built.context.post.author, ...built.context.post.participants];
        const update = normalizeForumConversationUpdate(parsed, people);
        return update ? Object.freeze({ ok: true, update }) : updateFailure('forum_update_response_invalid');
    } catch (error) {
        const publicError = toPublicLlmError(error);
        return { ok: false, code: publicError.code, message: publicError.message, retryable: publicError.retryable };
    }
}
