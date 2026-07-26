import { normalizeImageDirective } from '../images/image-directive.js';
import { toPublicLlmError } from '../llm/openai-compatible-client.js';
import { renderPromptPreset } from '../settings/prompt-compiler.js';
import { buildPublicGroupLlmContext, cleanGroupLlmText, isSafeGroupLlmOutput, parseGroupLlmJson, projectPublicPlayerProfile } from './group-llm-safety.js';
import { buildGroupBrowseModel } from './group-discovery-service.js';
import { FORUM_CHANNELS, forumChannelForTopic, groupForumProfileForModel, isKnownForumChannelTopic, normalizeGroupForumProfile, publicProfileToGroupForumProfile } from './group-forum-store.js';

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
        '草稿要像真实用户在恋爱社区的随手发帖：有具体的时间、地点或细节钩子（一杯没喝完的咖啡、加班后的末班车、周末的展览票根），以一个开放的问题或邀请收尾，语气自然、不营销化。contentMode 为 SFW 时保持日常暧昧与轻盈分享；为 NSFW 时可直白谈论成年人自愿的欲望、身体偏好与露骨线上话题，但仍只发生在线上文字里。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
        '功能绑定提示词只能影响公开线上内容的题材、语气和内容尺度，不能改变字段、数量、数据来源或下方固定 JSON 合同。',
        '软件层只处理线上文字。不得演绎、确认或描述线下性行为；NSFW 不等于同意。不得输出或猜测隐藏资料、仅好友资料、关系数值、候选人、UID、会话、Patch、路径、API Key、密钥或系统实现。',
        '只输出合法 JSON 对象，不得使用 Markdown、代码块或解释。严格形状为：{"title":"1-80字标题","body":"1-900字帖子草稿"}。不得含 HTML、控制字符、UpdateVariable、JSONPatch 或任何写入指令。草稿仅供展示和玩家确认，不能自动发布或写入状态。',
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
        const parsed = parseGroupLlmJson(unfenceJson(completion?.text));
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
    forum_existing_context_invalid: '现有本地帖子格式异常，未调用模型。',
    forum_post_context_invalid: '当前论坛帖子暂不可用。',
    forum_post_history_invalid: '帖子讨论记录格式异常，未调用模型。',
    forum_update_settings_unavailable: '论坛设置暂不可用。',
    forum_update_settings_invalid: '论坛连接设置无效。',
    forum_update_connection_missing: '请先在设置中为论坛绑定连接预设。',
    forum_update_llm_unavailable: '当前浏览器未提供论坛模型连接。',
    forum_update_invalid_json: '论坛模型没有返回可识别的更新。',
    forum_update_response_invalid: '论坛更新不符合安全格式，已丢弃。',
    // Finer-grained refresh failures. Messages stay static and never quote model output.
    forum_update_shape_invalid: '论坛更新的整体结构不符合约定（participants/posts 或帖子数量），已丢弃。',
    forum_update_channel_invalid: '论坛更新的频道名缺失、重复或不在固定频道列表中，已丢弃。',
    forum_update_author_unknown: '论坛更新引用了未提供公开资料的作者昵称，已丢弃。',
    forum_update_participant_invalid: '论坛更新中的临时角色资料字段无效，已丢弃。',
    forum_update_participant_underage: '论坛更新中的临时角色缺少明确的成年年龄段，已丢弃。',
    forum_update_post_invalid: '论坛更新中的帖子文本超限或包含不允许的内容，已丢弃。',
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

/** Unwraps a single whole-message Markdown code fence; the content is still parsed and validated as strict JSON. */
function unfenceJson(raw) {
    if (typeof raw !== 'string') return raw;
    const text = raw.trim();
    const match = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/u);
    return match ? match[1].trim() : text;
}

// The refresh prompt allows up to 8 posts × 1200-char bodies plus participant
// profiles, so the shared 4000-char JSON default is mathematically too small.
const FORUM_HOME_RESPONSE_MAX_CHARS = 24_000;
const FORUM_CONVERSATION_RESPONSE_MAX_CHARS = 12_000;

/** Trims and hard-caps a draft string before the unchanged safety scans run; the cut remainder is discarded, never shown. */
function boundedText(value, maxLength) {
    return typeof value === 'string' ? cleanGroupLlmText(value.trim().slice(0, maxLength), maxLength) : '';
}

function coerceMatchRate(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
    if (typeof value === 'string' && /^\d{1,3}(?:\.\d+)?\s*%?$/u.test(value.trim())) return Math.round(Number.parseFloat(value));
    return value;
}

const FORUM_PROFILE_FIELDS = Object.freeze(['nickname', 'ageRange', 'gender', 'city', 'mbti', 'zodiac', 'occupation', 'interests', 'presence', 'matchRate']);
const OPTIONAL_PROFILE_DEFAULTS = Object.freeze({ mbti: '', zodiac: '', occupation: '', presence: '在线', matchRate: null });

/**
 * Fills harmlessly omitted optional fields and drops unknown keys before the
 * strict shared profile validator runs. Adult-age verification, dangerous-key
 * rejection and text safety all still happen in normalizeGroupForumProfile.
 */
function completeForumParticipant(value) {
    if (!ownRecord(value)) return value;
    const completed = {};
    for (const field of FORUM_PROFILE_FIELDS) {
        const item = ownValue(value, field);
        if (item !== undefined) completed[field] = item;
    }
    for (const [field, fallback] of Object.entries(OPTIONAL_PROFILE_DEFAULTS)) {
        if (completed[field] === undefined || completed[field] === null) completed[field] = fallback;
    }
    completed.matchRate = coerceMatchRate(completed.matchRate);
    if (completed.interests === undefined) completed.interests = [];
    if (Array.isArray(completed.interests)) {
        completed.interests = completed.interests
            .filter((tag) => !(typeof tag === 'string' && !tag.trim()))
            .slice(0, 12);
    }
    return completed;
}

/**
 * Tolerant tag list: skips empty/duplicate entries and truncates to the cap.
 * Unsafe or oversized tags are dropped (never displayed) instead of killing
 * the whole batch; a non-array still rejects.
 */
function normalizeDraftTags(value, maxCount = 6) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return null;
    const seen = new Set();
    const tags = [];
    for (const raw of value) {
        const clean = boundedText(raw, 32);
        if (!clean || !isSafeGroupLlmOutput(clean, 32)) continue;
        const key = clean.normalize('NFKC').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        tags.push(clean);
        if (tags.length >= maxCount) break;
    }
    return tags;
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
        channels: Object.freeze(FORUM_CHANNELS.map(({ title, note, brief }) => Object.freeze({ title, note, brief }))),
        existingTitles: Object.freeze(cleanTitles),
    }) });
}

/**
 * Validates a home refresh draft. Returns { update } on success or { code } so
 * the UI can explain which contract rule failed without quoting model output.
 * Harmless structural variants are tolerated (unknown extra keys are ignored,
 * participants may be omitted, optional profile fields get defaults, tags are
 * deduplicated/truncated); adult verification, prototype-pollution guards and
 * the text safety scans are unchanged.
 */
function normalizeForumHomeUpdate(value, knownPeople) {
    if (!ownRecord(value)) return { code: 'forum_update_shape_invalid' };
    const participants = ownValue(value, 'participants') ?? [];
    const posts = ownValue(value, 'posts');
    if (!Array.isArray(participants) || participants.length > FORUM_CHANNELS.length || !Array.isArray(posts) || posts.length !== FORUM_CHANNELS.length) {
        return { code: 'forum_update_shape_invalid' };
    }
    const names = new Set(knownPeople.map((profile) => String(profile.nickname).normalize('NFKC').toLowerCase()));
    const normalizedParticipants = [];
    for (const participant of participants) {
        let profile;
        try { profile = normalizeGroupForumProfile(completeForumParticipant(participant)); }
        catch (error) { return { code: error?.code === 'NON_ADULT_PROFILE' ? 'forum_update_participant_underage' : 'forum_update_participant_invalid' }; }
        const key = profile.nickname.normalize('NFKC').toLowerCase();
        // A restated known person keeps the canonical community profile instead of failing the batch.
        if (names.has(key)) continue;
        names.add(key);
        normalizedParticipants.push(profile);
    }
    const seenTopics = new Set();
    const normalizedPosts = [];
    for (const post of posts) {
        if (!ownRecord(post)) return { code: 'forum_update_post_invalid' };
        const author = boundedText(ownValue(post, 'author'), 80);
        const rawTopic = boundedText(ownValue(post, 'topic'), 80);
        const title = boundedText(ownValue(post, 'title'), 120);
        const body = boundedText(ownValue(post, 'body'), 1_200);
        const tags = normalizeDraftTags(ownValue(post, 'tags'));
        if (!rawTopic || !isKnownForumChannelTopic(rawTopic)) return { code: 'forum_update_channel_invalid' };
        const topic = forumChannelForTopic(rawTopic).title;
        if (seenTopics.has(topic)) return { code: 'forum_update_channel_invalid' };
        if (!author || !names.has(author.normalize('NFKC').toLowerCase())) return { code: 'forum_update_author_unknown' };
        if (!title || !body || tags === null
            || !isSafeGroupLlmOutput(topic, 80) || !isSafeGroupLlmOutput(title, 120) || !isSafeGroupLlmOutput(body, 1_200)) {
            return { code: 'forum_update_post_invalid' };
        }
        seenTopics.add(topic);
        normalizedPosts.push(Object.freeze({ author, topic, title, body, tags: Object.freeze(tags) }));
    }
    return { update: Object.freeze({ participants: Object.freeze(normalizedParticipants), posts: Object.freeze(normalizedPosts) }) };
}

function makeForumHomeMessages(context, promptPreset, refreshMode = 'append') {
    const preset = promptSections(promptPreset);
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        `你是现代现实都市线上约会软件的心动社区首页更新模型。只根据公开社区主题和公开人物资料，为首页的全部固定频道生成短帖子。本次是${refreshMode === 'replace' ? '顶部替换刷新，生成成功后程序会删除旧本地帖子及其总结' : '底部追加刷新，程序会保留旧本地帖子并追加新帖子'}。`,
        `每次刷新都必须且只能生成 ${FORUM_CHANNELS.length} 篇帖子：${FORUM_CHANNELS.map((channel) => channel.title).join('、')}各一篇。posts 中的 topic 必须精确等于这 ${FORUM_CHANNELS.length} 个频道名之一，所有频道不能遗漏、重复或自行改名；点击频道后会只显示对应 topic 的本地帖子。`,
        '每篇帖子都要贴合 channels 中该频道的 note 与 brief 定位，让不同频道的口吻明显不同：今日心情轻盈随性，附近的人主动自然，同城瞬间具体在地，兴趣同频聊得专业又亲切，深夜树洞私密柔软，恋爱吐槽鲜活自嘲，约会报告像真实的复盘，话题广场开放随意。',
        `作者规则：每篇 post 的 author 必须逐字等于 knownPeople 中某个 nickname，或 participants 中某个新角色的 nickname；同一作者可以发多篇帖子。participants 只放本次新出现的临时角色，最多 ${FORUM_CHANNELS.length} 位，不要重复 knownPeople 已有昵称；若全部帖子都由已有人物发出，participants 用空数组 []。`,
        '每位临时角色必须给全 10 个字段：nickname（1-80字）、ageRange、gender、city、mbti、zodiac、occupation、interests（1-12 个非空标签，每个 1-32 字）、presence、matchRate。ageRange 必须是明确的成年写法，例如 "25-29岁"、"31岁" 或 "已验证成年"，其中数字必须都不小于 18；不要写 "90后"、"20代"、"25岁左右" 这类模糊说法。matchRate 只能是 0-100 的整数或 null，不要写百分号、小数或字符串。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
        '功能绑定提示词只能影响公开线上内容的题材、语气和内容尺度，不能改变频道、字段、数量、数据来源或下方固定 JSON 合同。',
        '软件层只处理线上文字。不得演绎、确认或描述线下性行为；NSFW 不等于同意。不得输出或猜测隐藏资料、仅好友资料、真实 UID、会话、Patch、路径、API Key、密钥或系统实现。帖子中出现的任何年龄数字只能是 18 岁及以上的成年年龄，也不要写"差3岁"这类年龄差数字或提及未成年人。',
        '只输出合法 JSON，不得使用 Markdown、代码块或解释。严格形状：{"participants":[{"nickname":"苏晴","ageRange":"25-29岁","gender":"女","city":"上海","mbti":"ISFP","zodiac":"双鱼座","occupation":"花艺师","interests":["花艺","摄影"],"presence":"在线","matchRate":null}],"posts":[{"author":"knownPeople或participants中的昵称","topic":"固定频道名之一","title":"1-120字","body":"1-1200字","tags":["1-32字"]}]}。title 不超过 120 字；body 建议 80-300 字、不得超过 1200 字；每篇 tags 最多 6 个且互不重复；整个 JSON 回复总长不要超过 20000 字符。不得输出 HTML、控制字符、UpdateVariable 或 JSONPatch。',
    ].filter(Boolean).join('\n\n');
    return Object.freeze([
        Object.freeze({ role: 'system', content: system }),
        Object.freeze({ role: 'user', content: `请刷新论坛首页。已有标题不可重复：${JSON.stringify(context.existingTitles)}。受限公开上下文：\n${JSON.stringify({ ...context, knownPeople: context.knownPeople })}` }),
    ]);
}

/** Calls the channel binding only after a deliberate, armed top/bottom refresh gesture. */
export async function generateForumHomeRefresh({ state, existingTitles, refreshMode = 'append', binding, settingsStore, llmClient, signal } = {}) {
    const built = buildForumHomeRefreshContext({ state, existingTitles });
    if (!built.ok) return built;
    if (!['replace', 'append'].includes(refreshMode)) return updateFailure('forum_home_context_invalid');
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') return updateFailure('forum_update_settings_unavailable');
    if (!llmClient || typeof llmClient.chat !== 'function') return updateFailure('forum_update_llm_unavailable');
    let resolved;
    try { resolved = settingsStore.resolveFunction('forum', { contentMode: built.context.contentMode, binding }); }
    catch { return updateFailure('forum_update_settings_invalid'); }
    if (!resolved?.connectionPreset) return updateFailure('forum_update_connection_missing');
    try {
        const completion = await llmClient.chat({ preset: resolved.connectionPreset, messages: makeForumHomeMessages(built.context, resolved.promptPreset, refreshMode), signal });
        const parsed = parseGroupLlmJson(unfenceJson(completion?.text), FORUM_HOME_RESPONSE_MAX_CHARS);
        if (!parsed) return updateFailure('forum_update_invalid_json');
        const result = normalizeForumHomeUpdate(parsed, built.context.knownPeople);
        return result.update
            ? Object.freeze({ ok: true, update: result.update, communityProfiles: built.context.knownPeople })
            : updateFailure(result.code ?? 'forum_update_response_invalid');
    } catch (error) {
        const publicError = toPublicLlmError(error);
        return { ok: false, code: publicError.code, message: publicError.message, retryable: publicError.retryable };
    }
}

const LOCAL_FORUM_POST_FIELDS = new Set(['id', 'topic', 'title', 'body', 'tags', 'author', 'participants', 'messages', 'summaries', 'summaryStatus', 'createdAt']);

function normalizeExistingForumPostForContext(value, slot) {
    if (!ownRecord(value) || Object.keys(value).some((key) => !LOCAL_FORUM_POST_FIELDS.has(key))) return null;
    const topic = cleanGroupLlmText(ownValue(value, 'topic'), 80);
    const title = cleanGroupLlmText(ownValue(value, 'title'), 120);
    const body = cleanGroupLlmText(ownValue(value, 'body'), 1_200);
    const tags = ownValue(value, 'tags');
    const messages = ownValue(value, 'messages');
    if (!topic || !title || !body || !isKnownForumChannelTopic(topic) || !Array.isArray(tags) || tags.length > 6 || !Array.isArray(messages) || messages.length > 240) return null;
    const cleanTags = [];
    for (const tag of tags) {
        const clean = cleanGroupLlmText(tag, 32);
        if (!clean || !isSafeGroupLlmOutput(clean, 32) || cleanTags.includes(clean)) return null;
        cleanTags.push(clean);
    }
    try {
        const author = groupForumProfileForModel(normalizeGroupForumProfile(ownValue(value, 'author')));
        return Object.freeze({
            slot,
            topic,
            title,
            // Bounded excerpts keep the all-post automatic refresh practical even
            // when the local cache reaches its maximum number of posts.
            body: body.slice(0, 480),
            tags: Object.freeze(cleanTags),
            author,
            commentCount: messages.length,
        });
    } catch {
        return null;
    }
}

/** Public-only frame for updating every already cached forum post. It never carries IDs or private state. */
export function buildForumExistingPostsUpdateContext({ state, posts } = {}) {
    if (!ownRecord(state) || !Array.isArray(posts) || posts.length < 1 || posts.length > 80) return updateFailure('forum_existing_context_invalid');
    const normalizedPosts = [];
    for (const [index, post] of posts.entries()) {
        const normalized = normalizeExistingForumPostForContext(post, index + 1);
        if (!normalized) return updateFailure('forum_existing_context_invalid');
        normalizedPosts.push(normalized);
    }
    return Object.freeze({ ok: true, context: Object.freeze({
        contentMode: state?.软件?.内容模式 === 'NSFW' ? 'NSFW' : 'SFW',
        playerPublicProfile: projectPublicPlayerProfile(state.玩家),
        posts: Object.freeze(normalizedPosts),
    }) });
}

function normalizeForumExistingPostsUpdate(value, expectedCount) {
    if (!ownRecord(value) || Object.keys(value).sort().join(',') !== 'updates') return null;
    const updates = ownValue(value, 'updates');
    if (!Array.isArray(updates) || updates.length !== expectedCount) return null;
    const slots = new Set();
    const normalized = [];
    for (const item of updates) {
        if (!ownRecord(item) || Object.keys(item).sort().join(',') !== 'body,slot,tags,title') return null;
        const slot = ownValue(item, 'slot');
        const title = boundedText(ownValue(item, 'title'), 120);
        const body = boundedText(ownValue(item, 'body'), 360);
        const tags = normalizeDraftTags(ownValue(item, 'tags'));
        if (!Number.isInteger(slot) || slot < 1 || slot > expectedCount || slots.has(slot) || !title || !body || !isSafeGroupLlmOutput(title, 120) || !isSafeGroupLlmOutput(body, 360) || tags === null) return null;
        slots.add(slot);
        normalized.push(Object.freeze({ slot, title, body, tags: Object.freeze(tags) }));
    }
    return Object.freeze({ updates: Object.freeze(normalized) });
}

function makeForumExistingPostsMessages(context, promptPreset) {
    const preset = promptSections(promptPreset);
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        '你是现代现实都市线上约会软件的心动社区既有帖子自动更新模型。只改写给定的本地帖子可见文案，让它们像持续发生的线上社区动态。',
        '每个 slot 必须恰好更新一次；不得新增、删除、合并、重排帖子，不得改变频道、作者、评论、角色资料或任何未列出的数据。新的本地帖子只能由首页下拉刷新生成。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
        '功能绑定提示词只能影响公开线上内容的题材、语气和内容尺度，不能改变 slot、字段、数量、数据来源或下方固定 JSON 合同。',
        '软件层只处理线上文字。不得演绎、确认或描述线下性行为；NSFW 不等于同意。不得输出或猜测隐藏资料、仅好友资料、真实 UID、会话、Patch、路径、API Key、密钥或系统实现。',
        '只输出合法 JSON，不得使用 Markdown、代码块或解释。严格形状：{"updates":[{"slot":1,"title":"1-120字","body":"1-360字","tags":["1-32字"]}]}。updates 数量必须等于输入 posts 数量，slot 必须从 1 到该数量各出现一次；每篇 tags 最多 6 个且互不重复。不得输出 HTML、控制字符、UpdateVariable 或 JSONPatch。',
    ].filter(Boolean).join('\n\n');
    return Object.freeze([
        Object.freeze({ role: 'system', content: system }),
        Object.freeze({ role: 'user', content: `请自动更新所有现有本地帖子；只依据以下受限公开上下文：\n${JSON.stringify(context)}` }),
    ]);
}

/** Calls the forum binding to update existing local posts only; it never creates a post. */
export async function generateForumExistingPostsUpdate({ state, posts, binding, settingsStore, llmClient, signal } = {}) {
    const built = buildForumExistingPostsUpdateContext({ state, posts });
    if (!built.ok) return built;
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') return updateFailure('forum_update_settings_unavailable');
    if (!llmClient || typeof llmClient.chat !== 'function') return updateFailure('forum_update_llm_unavailable');
    let resolved;
    try { resolved = settingsStore.resolveFunction('forum', { contentMode: built.context.contentMode, binding }); }
    catch { return updateFailure('forum_update_settings_invalid'); }
    if (!resolved?.connectionPreset) return updateFailure('forum_update_connection_missing');
    try {
        const completion = await llmClient.chat({ preset: resolved.connectionPreset, messages: makeForumExistingPostsMessages(built.context, resolved.promptPreset), signal });
        // Up to 80 slots × (360-char body + title + tags) can legitimately exceed the shared 4000-char default.
        const parsed = parseGroupLlmJson(unfenceJson(completion?.text), 4_000 + built.context.posts.length * 1_200);
        if (!parsed) return updateFailure('forum_update_invalid_json');
        const update = normalizeForumExistingPostsUpdate(parsed, built.context.posts.length);
        return update ? Object.freeze({ ok: true, update }) : updateFailure('forum_update_response_invalid');
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
            const profile = normalizeGroupForumProfile(completeForumParticipant(participant));
            const key = profile.nickname.normalize('NFKC').toLowerCase();
            // A restated existing person keeps the canonical stored profile instead of failing the batch.
            if (names.has(key)) continue;
            names.add(key);
            normalizedParticipants.push(profile);
        } catch { return null; }
    }
    const normalizedMessages = [];
    for (const message of messages) {
        if (!ownRecord(message) || Object.keys(message).some((key) => !['speaker', 'text', 'imageDirective'].includes(key)) || !Object.hasOwn(message, 'speaker') || !Object.hasOwn(message, 'text')) return null;
        const speaker = cleanGroupLlmText(ownValue(message, 'speaker'), 80);
        const text = cleanGroupLlmText(ownValue(message, 'text'), 480);
        if (!speaker || !text || !isSafeGroupLlmOutput(text, 480) || !names.has(speaker.normalize('NFKC').toLowerCase())) return null;
        let imageDirective;
        if (Object.hasOwn(message, 'imageDirective')) { try { imageDirective = normalizeImageDirective(ownValue(message, 'imageDirective')); } catch { return null; } }
        normalizedMessages.push(Object.freeze(imageDirective ? { speaker, text, imageDirective } : { speaker, text }));
    }
    return Object.freeze({ participants: Object.freeze(normalizedParticipants), messages: Object.freeze(normalizedMessages) });
}

function makeForumPostMessages(context, promptPreset) {
    const preset = promptSections(promptPreset);
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        '你是现代现实都市线上约会软件内的论坛帖子讨论更新模型。根据公开帖子和受限评论历史，模拟其他用户发表 1–8 条自然评论。',
        '评论要有真实社区的参差感：有人认真接话、有人补充自己的相似经历、有人开玩笑或轻轻抬杠、有人向楼主或玩家追问细节；避免每条都同一种语气或都以问句结尾。contentMode 为 SFW 时保持日常调侃与暧昧试探；为 NSFW 时成年人可直白讨论欲望与露骨话题，但仍只是线上文字互动。',
        '可使用帖子作者或 participants 中已有昵称；如需新评论者，必须先在 participants 给出其公开关键资料。每位临时角色必须给全 10 个字段：nickname、ageRange、gender、city、mbti、zodiac、occupation、interests（非空标签）、presence、matchRate；ageRange 必须是明确的成年写法（如 "25-29岁"、"31岁" 或 "已验证成年"，数字都不小于 18），matchRate 只能是 0-100 的整数或 null。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
        '功能绑定提示词只能影响公开线上内容的题材、语气和内容尺度，不能改变字段、数量、数据来源或下方固定 JSON 合同。',
        '软件层只处理线上文字。不得演绎、确认或描述线下性行为；NSFW 不等于同意。不得输出或猜测隐藏资料、仅好友资料、真实 UID、会话、Patch、路径、API Key、密钥或系统实现。',
        '只输出合法 JSON，不得使用 Markdown、代码块或解释。严格形状：{"participants":[{"nickname":"苏晴","ageRange":"25-29岁","gender":"女","city":"上海","mbti":"ISFP","zodiac":"双鱼座","occupation":"花艺师","interests":["花艺","摄影"],"presence":"在线","matchRate":null}],"messages":[{"speaker":"作者、已有参与者或participants昵称","text":"1-480字","imageDirective":{"kind":"share_photo|selfie|scene_snapshot|private_photo","scene":"English image tags"}}]}。若无新评论者，participants 用空数组 []。imageDirective 可省略，仅在评论确实值得分享照片、角色有分享欲且公开边界允许时使用；不得机械生图。不得输出 UID、URL、完整提示词、绘图 DNA、凭据、HTML、控制字符、UpdateVariable 或 JSONPatch。',
    ].filter(Boolean).join('\n\n');
    return Object.freeze([
        Object.freeze({ role: 'system', content: system }),
        Object.freeze({ role: 'user', content: `请更新该帖子下的讨论：\n${JSON.stringify(context)}` }),
    ]);
}

/** Local-only comments after a user reply in an opened forum post. */
export async function generateForumPostConversationUpdate({ state, post, history, binding, settingsStore, llmClient, signal } = {}) {
    const built = buildForumPostUpdateContext({ state, post, history });
    if (!built.ok) return built;
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') return updateFailure('forum_update_settings_unavailable');
    if (!llmClient || typeof llmClient.chat !== 'function') return updateFailure('forum_update_llm_unavailable');
    let resolved;
    try { resolved = settingsStore.resolveFunction('forum', { contentMode: built.context.contentMode, binding }); }
    catch { return updateFailure('forum_update_settings_invalid'); }
    if (!resolved?.connectionPreset) return updateFailure('forum_update_connection_missing');
    try {
        const completion = await llmClient.chat({ preset: resolved.connectionPreset, messages: makeForumPostMessages(built.context, resolved.promptPreset), signal });
        // Up to 8 comments × 480 chars plus participant profiles can exceed the shared 4000-char default.
        const parsed = parseGroupLlmJson(unfenceJson(completion?.text), FORUM_CONVERSATION_RESPONSE_MAX_CHARS);
        if (!parsed) return updateFailure('forum_update_invalid_json');
        const people = [built.context.post.author, ...built.context.post.participants];
        const update = normalizeForumConversationUpdate(parsed, people);
        return update ? Object.freeze({ ok: true, update }) : updateFailure('forum_update_response_invalid');
    } catch (error) {
        const publicError = toPublicLlmError(error);
        return { ok: false, code: publicError.code, message: publicError.message, retryable: publicError.retryable };
    }
}
