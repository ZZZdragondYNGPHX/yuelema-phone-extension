import { append, element, listen } from '../dom.js';
import { createAvatarView } from '../ui/avatar-view.js';
import { buildErrorDetail } from '../ui/operation-activity.js';
import { createUiIcon } from '../ui/icon.js';
import { CHARACTER_TEMPLATE_FORMAT, importCharacterTemplate, projectCharacterTemplateError } from './character-template-codec.js';
import { avatarAcceptAttribute, compressLocalAvatar, projectAvatarError } from './avatar-codec.js';
import { projectRemoteImportError } from '../images/remote-image-import.js';

const TAG_KEYS = Object.freeze(['兴趣标签', '生活方式标签', '性格标签', '沟通风格标签']);
const PUBLIC_TEXT_KEYS = Object.freeze(['昵称', '年龄段', '性别', '性取向', '城市', '距离范围', '寻找意图', '简介']);
const FRIEND_TEXT_KEYS = Object.freeze(['关系状态', '边界与偏好']);
const THRESHOLD_KEYS = Object.freeze(['拒绝阈值', '已读不回阈值', '取消匹配阈值', '拉黑阈值']);

function cleanText(value) { return String(value ?? '').trim(); }
function splitTags(value) { return cleanText(value).split(/[，,]/u).map((tag) => tag.trim()).filter(Boolean); }

function baseCandidate() {
    return {
        成人验证: true,
        公开资料: {
            昵称: '', 头像引用: '', 年龄段: '18+', 性别: '', 性取向: '', 城市: '', 距离范围: '', 寻找意图: '', 简介: '',
            兴趣标签: [], 生活方式标签: [], 性格标签: [], 沟通风格标签: [],
        },
        仅好友资料: { 关系状态: '未说明', 边界与偏好: '沟通后再确认。' },
        隐藏资料: { 实际年龄: 18, 私人备注: '' },
        绘图: { core_dna: '', outfit_dna: '' },
        偏好与边界: '',
        拒绝阈值: 40, 已读不回阈值: 55, 取消匹配阈值: 70, 拉黑阈值: 85,
        与玩家关系: { 状态: '陌生', 全局账号表现: 50, NPC专属匹配度: 50, 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0, 友情值: 0, 心动值: 0, 欲望值: 0 },
    };
}

function textField(container, labelText, { name, value = '', rows = 0, required = false, placeholder = '', type = 'text', min, max, inputMode, hint = '', className = '' } = {}) {
    const label = element('label', { className: `yl-character-field${className ? ` ${className}` : ''}` });
    const labelRow = element('span', { className: 'yl-character-field-heading' });
    labelRow.appendChild(element('span', { className: 'yl-character-field-label', text: labelText }));
    if (required) labelRow.appendChild(element('span', { className: 'yl-character-field-required', text: '必填' }));
    const control = rows > 0
        ? element('textarea', { name, value, rows, required, placeholder, maxLength: 1200 })
        : element('input', { name, type, value, required, placeholder, min, max, inputMode, maxLength: type === 'number' ? undefined : 500 });
    append(label, [labelRow, control]);
    if (hint) label.appendChild(element('span', { className: 'yl-character-field-hint', text: hint }));
    container.appendChild(label);
    return control;
}

function sectionHeading(container, { step = '', eyebrow = '', title, description = '' }) {
    const header = element('header', { className: 'yl-character-section-heading' });
    if (step) header.appendChild(element('span', { className: 'yl-character-step-badge', text: step }));
    const copy = element('div', { className: 'yl-character-section-copy' });
    if (eyebrow) copy.appendChild(element('p', { className: 'yl-character-section-eyebrow', text: eyebrow }));
    copy.appendChild(element('h2', { className: 'yl-character-section-title', text: title }));
    if (description) copy.appendChild(element('p', { className: 'yl-character-section-description', text: description }));
    header.appendChild(copy);
    container.appendChild(header);
    return header;
}

function fieldGroup(container, title, description = '', className = '') {
    const group = element('div', { className: `yl-character-field-group${className ? ` ${className}` : ''}` });
    group.appendChild(element('h3', { className: 'yl-character-field-group-title', text: title }));
    if (description) group.appendChild(element('p', { className: 'yl-character-field-group-description', text: description }));
    container.appendChild(group);
    return group;
}

function readNamed(form, name) {
    const control = form.querySelector(`[name="${name}"]`);
    return control ? control.value : '';
}

function candidateFromForm(form, avatar) {
    const candidate = baseCandidate();
    for (const key of PUBLIC_TEXT_KEYS) candidate.公开资料[key] = cleanText(readNamed(form, `public-${key}`));
    candidate.公开资料.头像引用 = avatar.kind === 'embedded' ? '本地头像' : '';
    for (const key of TAG_KEYS) candidate.公开资料[key] = splitTags(readNamed(form, `tag-${key}`));
    for (const key of FRIEND_TEXT_KEYS) candidate.仅好友资料[key] = cleanText(readNamed(form, `friend-${key}`));
    candidate.隐藏资料.实际年龄 = Number(readNamed(form, 'hidden-age'));
    candidate.隐藏资料.私人备注 = cleanText(readNamed(form, 'hidden-note'));
    candidate.绘图.core_dna = cleanText(readNamed(form, 'drawing-core-dna'));
    candidate.绘图.outfit_dna = cleanText(readNamed(form, 'drawing-outfit-dna'));
    candidate.偏好与边界 = cleanText(readNamed(form, 'boundary'));
    for (const key of THRESHOLD_KEYS) candidate[key] = Number(readNamed(form, `threshold-${key}`));
    return candidate;
}

/** Builds the only existing editor data that may be sent to AI completion: public fields and tags, never avatar or private layers. */
function publicProfileFromForm(form) {
    const profile = { 头像引用: '' };
    for (const key of PUBLIC_TEXT_KEYS) profile[key] = cleanText(readNamed(form, `public-${key}`));
    for (const key of TAG_KEYS) profile[key] = splitTags(readNamed(form, `tag-${key}`));
    return profile;
}
function avatarFromForm(form, localAvatar) {
    return readNamed(form, 'avatar-kind') === 'embedded' && localAvatar
        ? localAvatar
        : { kind: 'placeholder' };
}

function candidateToForm(form, template) {
    const candidate = template.character;
    for (const key of PUBLIC_TEXT_KEYS) {
        const control = form.querySelector(`[name="public-${key}"]`);
        if (control) control.value = candidate.公开资料[key] ?? '';
    }
    for (const key of TAG_KEYS) {
        const control = form.querySelector(`[name="tag-${key}"]`);
        if (control) control.value = (candidate.公开资料[key] ?? []).join(', ');
    }
    for (const key of FRIEND_TEXT_KEYS) {
        const control = form.querySelector(`[name="friend-${key}"]`);
        if (control) control.value = candidate.仅好友资料[key] ?? '';
    }
    form.querySelector('[name="hidden-age"]').value = String(candidate.隐藏资料.实际年龄);
    form.querySelector('[name="hidden-note"]').value = candidate.隐藏资料.私人备注 ?? '';
    form.querySelector('[name="drawing-core-dna"]').value = candidate.绘图?.core_dna ?? '';
    form.querySelector('[name="drawing-outfit-dna"]').value = candidate.绘图?.outfit_dna ?? '';
    form.querySelector('[name="boundary"]').value = candidate.偏好与边界 ?? '';
    for (const key of THRESHOLD_KEYS) form.querySelector(`[name="threshold-${key}"]`).value = String(candidate[key]);
    const avatarKind = form.querySelector('[name="avatar-kind"]');
    if (avatarKind) avatarKind.value = template.avatar?.kind ?? 'placeholder';
}

function safeLibraryMessage(error) {
    const code = typeof error?.code === 'string' ? error.code : '';
    const messages = {
        TEMPLATE_LIMIT_REACHED: '本地角色模板已达 50 条上限。',
        DUPLICATE_TEMPLATE_ID: '本地角色模板 ID 重复；请删除冲突项后再合并导入。',
        LIBRARY_TOO_LARGE: '本地角色模板库容量已满。',
        TEMPLATE_NOT_FOUND: '本地角色模板已不存在。',
        INVALID_LIBRARY_JSON: '角色模板库 JSON 无法解析。',
        UNSUPPORTED_LIBRARY_VERSION: '角色模板库版本不受支持。',
        TEMPLATE_INVALID_JSON: '角色模板 JSON 无法解析。',
        TEMPLATE_INVALID: '角色模板未通过成年人或结构校验。',
        SENSITIVE_DATA_FORBIDDEN: '角色模板不能包含 API Key、连接设置或其他凭据。',
        UNSAFE_LIBRARY_DATA: '角色模板库包含不安全的数据结构。',
        STORAGE_READ_FAILED: '读取本地角色模板库失败。',
        STORAGE_WRITE_FAILED: '保存本地角色模板库失败。',
    };
    return messages[code] ?? '本地角色模板操作未完成。';
}

/**
 * Full-data editor for explicitly creating/importing a candidate.
 * The editor may show the current private draft because the player owns it; normal
 * recommendation cards remain public-projection-only in app-shell/ui-model.
 */
export function buildCharacterCreatorPanel({ documentRef, actionBridge, characterLibrary, signal, contentMode = 'SFW', onFeedback, onRegistered, onConfigureFeature = null, importAvatarFromUrl = null, operationActivity = null }) {
    const section = element('section', { className: 'yl-phone-empty-actions yl-character-editor yl-character-creator' });

    /* —— 安全控制台接线（2026-07-27）——
     * operationActivity 为可选注入；缺省时全部静默跳过，面板行为与既有完全一致。
     * 界面提示（onFeedback 文案）保持原有粗略文案不变；具体失败原因只进 detail，
     * 且 detail 只携带错误码、字段名/路径与校验结论——绝无 API Key、隐藏资料值、
     * 关系分或阈值数值，detail 入账时还会再经 sanitizeDiagnosticDetail 脱敏。 */
    const activity = operationActivity && typeof operationActivity.start === 'function' ? operationActivity : null;
    function startActivity(name, message) {
        if (!activity) return null;
        try { return activity.start(name, message); } catch { return null; }
    }
    function settleActivity(kind, handle, message, detail) {
        if (!activity || !handle) return;
        try { activity[kind](handle, message, { detail: detail ?? null }); } catch { /* 控制台不可用时绝不影响功能路径 */ }
    }
    /** 32+ 连续 ASCII token 会被控制台脱敏器视作凭据整体抹除；给长错误码按下划线注入空格保住可读性。 */
    function displayCode(code) {
        const text = typeof code === 'string' ? code : '';
        return text.length >= 32 ? text.replaceAll('_', '_ ').trim() : text;
    }
    /** 把服务层失败结果（code/message/reason/detail/status）压成一条脱敏详情。 */
    function failureDetail(source, context) {
        try {
            if (source && typeof source === 'object' && !(source instanceof Error)) {
                const specifics = [source.message, source.reason, source.detail]
                    .filter((item) => typeof item === 'string' && item).join('；');
                return buildErrorDetail({
                    message: specifics,
                    code: displayCode(source.code),
                    status: Number.isInteger(source.status) ? source.status : undefined,
                }, context);
            }
            return buildErrorDetail(source ?? null, context);
        } catch { return null; }
    }

    const hero = element('article', { className: 'yl-character-hero' });
    const heroCopy = element('div', { className: 'yl-character-hero-copy' });
    heroCopy.appendChild(element('p', { className: 'yl-character-hero-eyebrow', text: '创建新角色' }));
    heroCopy.appendChild(element('h2', { className: 'yl-character-hero-title', text: '让下一次心动，从一份认真资料开始' }));
    const heroTrust = element('div', { className: 'yl-character-hero-trust' });
    append(heroTrust, [
        element('span', { className: 'yl-character-trust-chip', text: '仅限明确成年人' }),
        element('span', { className: 'yl-character-trust-chip', text: 'AI 只生成草稿' }),
        element('span', { className: 'yl-character-trust-chip', text: '首页仅展示公开资料' }),
    ]);
    heroCopy.appendChild(heroTrust);
    // 4 步 journey：真锚点导航（按钮在分段构建完成后接线），不再是纯装饰条。
    const journey = element('nav', { className: 'yl-character-journey', ariaLabel: '创建角色步骤' });
    append(hero, [heroCopy, journey]);
    section.appendChild(hero);

    const stepRail = element('nav', { className: 'yl-character-step-rail', ariaLabel: '创建角色步骤导航' });
    section.appendChild(stepRail);

    const form = element('form', { className: 'yl-character-form' });

    // —— 步骤卡折叠（手机端单列可折叠；锚点跳转与表单校验会自动展开目标卡） ——
    const collapsibleCards = new Map();
    function expandCard(target) {
        const setCollapsed = collapsibleCards.get(target);
        if (setCollapsed) setCollapsed(false);
    }
    function expandCardContaining(node) {
        let current = node;
        while (current) {
            if (collapsibleCards.has(current)) { expandCard(current); return; }
            current = current.parentNode ?? null;
        }
    }
    function collapsibleBody(sectionEl, heading, titleText) {
        const body = element('div', { className: 'yl-character-card-body' });
        const toggle = element('button', { className: 'yl-character-card-toggle', type: 'button', ariaLabel: `折叠：${titleText}` });
        toggle.setAttribute('aria-expanded', 'true');
        toggle.appendChild(createUiIcon(documentRef ?? globalThis.document, 'chevron_right', { className: 'yl-ui-icon yl-character-card-toggle-icon' }));
        heading.appendChild(toggle);
        sectionEl.appendChild(body);
        const setCollapsed = (collapsed) => {
            sectionEl.classList.toggle('is-collapsed', collapsed);
            body.hidden = collapsed;
            toggle.setAttribute('aria-expanded', String(!collapsed));
            toggle.setAttribute('aria-label', `${collapsed ? '展开' : '折叠'}：${titleText}`);
        };
        listen(toggle, toggle, 'click', () => setCollapsed(!sectionEl.classList.contains('is-collapsed')), signal);
        collapsibleCards.set(sectionEl, setCollapsed);
        return body;
    }

    const publicSection = element('section', { className: 'yl-phone-empty-actions yl-character-card yl-character-card-public', id: 'yl-character-section-public' });
    const publicHeading = sectionHeading(publicSection, {
        step: '01', eyebrow: '公开资料', title: '先做一张让人愿意停留的心动名片',
    });
    const publicBody = collapsibleBody(publicSection, publicHeading, '心动名片');
    const identityGroup = fieldGroup(publicBody, '基本印象', '', 'yl-character-field-grid yl-character-field-grid-two');
    textField(identityGroup, '怎么称呼 TA', { name: 'public-昵称', required: true, placeholder: '例如：林夏' });
    textField(identityGroup, '公开年龄段', { name: 'public-年龄段', required: true, placeholder: '例如：25-29', hint: '页面展示年龄段；实际年龄在私密资料中单独校验。' });
    textField(identityGroup, '性别认同', { name: 'public-性别', required: true, placeholder: '例如：女 / 男 / 非二元' });
    textField(identityGroup, '期待遇见谁', { name: 'public-性取向', required: true, placeholder: '例如：双性恋 / 异性恋' });

    const encounterGroup = fieldGroup(publicBody, '相遇坐标', '', 'yl-character-field-grid yl-character-field-grid-two');
    textField(encounterGroup, '所在城市', { name: 'public-城市', required: true, placeholder: '例如：上海' });
    textField(encounterGroup, '愿意相遇的距离', { name: 'public-距离范围', required: true, placeholder: '例如：10 km / 同城' });
    textField(encounterGroup, '这次想寻找什么', { name: 'public-寻找意图', required: true, placeholder: '例如：先聊天，再认真约会', className: 'yl-character-field-wide' });
    textField(encounterGroup, '一句让人想继续了解的介绍', { name: 'public-简介', required: true, rows: 3, placeholder: '写下日常里的小习惯、喜欢的相处方式，或最近正期待的一件事。', className: 'yl-character-field-wide' });

    const tagsGroup = fieldGroup(publicBody, '心动关键词', '', 'yl-character-field-grid yl-character-field-grid-two yl-character-tags-group');
    const tagCopy = {
        兴趣标签: ['兴趣与爱好', '例如：电影, 咖啡, 城市漫步'],
        生活方式标签: ['生活节奏', '例如：夜猫子, 周末早起, 偶尔小酌'],
        性格标签: ['相处时的性格', '例如：慢热, 直接, 温柔坚定'],
        沟通风格标签: ['聊天与沟通方式', '例如：及时回应, 喜欢长消息'],
    };
    for (const key of TAG_KEYS) {
        const [label, placeholder] = tagCopy[key];
        textField(tagsGroup, label, { name: `tag-${key}`, placeholder });
    }

    const avatarSection = element('section', { className: 'yl-phone-empty-actions yl-character-card yl-character-card-avatar', id: 'yl-character-section-avatar' });
    const avatarHeading = sectionHeading(avatarSection, {
        step: '02', eyebrow: '头像与形象', title: '选一张有故事感的头像',
    });
    const avatarBody = collapsibleBody(avatarSection, avatarHeading, '形象与灵感');
    const avatarLayout = element('div', { className: 'yl-character-avatar-layout' });
    const avatarSourceField = element('label', { className: 'yl-character-field yl-character-avatar-source' });
    avatarSourceField.appendChild(element('span', { className: 'yl-character-field-label', text: '头像来源' }));
    const avatarKind = element('select', { name: 'avatar-kind', ariaLabel: '头像来源' });
    append(avatarKind, [element('option', { value: 'placeholder', text: '先用占位头像' }), element('option', { value: 'embedded', text: '选择本地图片（压缩后保存）' })]);
    avatarSourceField.appendChild(avatarKind);
    avatarLayout.appendChild(avatarSourceField);
    const avatarUpload = element('label', { className: 'yl-character-field yl-character-avatar-upload' });
    avatarUpload.appendChild(element('span', { className: 'yl-character-avatar-upload-title', text: '从本机选择一张照片' }));
    avatarUpload.appendChild(element('span', { className: 'yl-character-avatar-upload-description', text: '图片会在当前浏览器内压缩处理，不会交给 AI 创作请求。' }));
    const avatarFile = element('input', { name: 'avatar-file', type: 'file', accept: avatarAcceptAttribute(), ariaLabel: '选择本地头像' });
    avatarUpload.appendChild(avatarFile);
    avatarLayout.appendChild(avatarUpload);
    // 链接导入是能力门控 UI：宿主没有注入导入器时完全不渲染，不留死控件。
    let remoteUrlInput = null;
    let remoteImportButton = null;
    if (typeof importAvatarFromUrl === 'function') {
        const remoteField = element('label', { className: 'yl-character-field yl-character-avatar-remote' });
        remoteField.appendChild(element('span', { className: 'yl-character-field-label', text: '或粘贴图片链接' }));
        // type=text 而非 type=url：避免半截链接触发浏览器原生校验、阻塞整表单提交；合法性由导入器统一裁决。
        remoteUrlInput = element('input', { name: 'avatar-import-url', type: 'text', inputMode: 'url', placeholder: 'https://…', ariaLabel: '要导入的图片链接' });
        remoteField.appendChild(remoteUrlInput);
        remoteField.appendChild(element('span', { className: 'yl-character-field-hint', text: '仅在点击导入时下载一次并压缩为本地头像；链接本身不会被保存或用于展示。' }));
        remoteImportButton = element('button', { className: 'yl-character-library-action yl-character-avatar-remote-button', type: 'button', text: '下载并压缩为本地头像' });
        remoteField.appendChild(remoteImportButton);
        avatarLayout.appendChild(remoteField);
    }
    const avatarNote = element('p', { className: 'yl-phone-page-description yl-character-avatar-note', text: '本地头像会压缩为最长边不超过 1024px 的 WebP；导出模板时可自行选择是否包含头像。' });
    const drawingGroup = fieldGroup(avatarBody, '生图身份锚点', '英文绘图标签会在生成图片时固定人物外观和当前穿搭；它们不会进入推荐评分、关系判断或普通名片。', 'yl-character-field-grid yl-character-field-grid-two');
    textField(drawingGroup, 'core_dna（固定外观）', { name: 'drawing-core-dna', rows: 3, placeholder: '例如：adult woman, short black bob, warm brown eyes, beauty mark', hint: '首次确定后尽量稳定；只写外观锚点。' });
    textField(drawingGroup, 'outfit_dna（当前穿搭）', { name: 'drawing-outfit-dna', rows: 3, placeholder: '例如：cream knit cardigan, dark denim skirt, ankle boots', hint: '明确换装时再更新；只写服装与配饰。' });
    append(avatarBody, [avatarLayout, avatarNote, drawingGroup]);

    const aiSection = element('section', { className: 'yl-phone-empty-actions yl-character-card yl-character-card-ai', id: 'yl-character-section-ai' });
    const aiHeading = sectionHeading(aiSection, {
        step: '02 · 可选', eyebrow: '创作助手', title: 'AI 补全 / 完整创作：还没想完整？让 AI 帮你补上灵感',
    });
    const aiBody = collapsibleBody(aiSection, aiHeading, '创作助手');
    const aiChoices = element('div', { className: 'yl-character-ai-choices' });
    const completionCard = element('article', { className: 'yl-character-ai-choice yl-character-ai-choice-completion' });
    if (typeof onConfigureFeature === 'function') {
        const configureCompletion = element('button', { className: 'yl-feature-options yl-character-feature-options', type: 'button', text: 'AI 设置', ariaLabel: '配置 AI 补全预设' });
        listen(configureCompletion, configureCompletion, 'click', () => onConfigureFeature({ key: 'character_ai_completion', title: 'AI 补全' }), signal);
        completionCard.appendChild(configureCompletion);
    }
    completionCard.appendChild(element('span', { className: 'yl-character-ai-choice-badge', text: '保留现有设定' }));
    completionCard.appendChild(element('h3', { className: 'yl-character-ai-choice-title', text: '完善当前名片' }));
    completionCard.appendChild(element('p', { className: 'yl-character-ai-choice-description', text: '适合已经有基本想法，只想让公开简介和标签更完整。仅发送当前表单里的公开字段。' }));
    const completionInstruction = textField(completionCard, '告诉 AI 哪些地方需要补全', { name: 'ai-completion-instruction', rows: 3, placeholder: '例如：保留已有定位，把简介补成成熟、自然的都市约会资料。' });
    const completionButton = element('button', { className: 'yl-phone-action-card yl-character-ai-button yl-button-ai', type: 'button', text: 'AI 完善补全到草稿' });
    completionCard.appendChild(completionButton);

    const authoringCard = element('article', { className: 'yl-character-ai-choice yl-character-ai-choice-authoring' });
    if (typeof onConfigureFeature === 'function') {
        const configureAuthoring = element('button', { className: 'yl-feature-options yl-character-feature-options', type: 'button', text: 'AI 设置', ariaLabel: '配置 AI 完整创作预设' });
        listen(configureAuthoring, configureAuthoring, 'click', () => onConfigureFeature({ key: 'character_full_authoring', title: 'AI 完整创作' }), signal);
        authoringCard.appendChild(configureAuthoring);
    }
    authoringCard.appendChild(element('span', { className: 'yl-character-ai-choice-badge', text: '从一句话开始' }));
    authoringCard.appendChild(element('h3', { className: 'yl-character-ai-choice-title', text: '创作完整角色草稿' }));
    authoringCard.appendChild(element('p', { className: 'yl-character-ai-choice-description', text: '适合只有氛围和方向时使用。只发送你的创作说明与最小玩家公开匹配上下文。' }));
    const creativeBrief = textField(authoringCard, '描述你想遇见的那个人', { name: 'ai-creative-brief', rows: 3, placeholder: '例如：一名明确成年、生活在上海、偏好先文字聊天再认真约会的独立角色。' });
    const authoringButton = element('button', { className: 'yl-phone-action-card yl-character-ai-button yl-button-ai', type: 'button', text: 'AI 完整创作到草稿' });
    authoringCard.appendChild(authoringButton);
    append(aiChoices, [completionCard, authoringCard]);
    aiBody.appendChild(aiChoices);
    aiBody.appendChild(element('p', { className: 'yl-character-safety-note', text: '隐私提示：AI 补全不会读取头像、仅好友资料、隐藏资料、偏好与边界或互动阈值。' }));

    const friendSection = element('section', { className: 'yl-phone-empty-actions yl-character-card yl-character-card-private', id: 'yl-character-section-private' });
    const friendHeading = sectionHeading(friendSection, {
        step: '03', eyebrow: '私密与边界', title: '把亲近后的真实与边界写清楚',
        description: '这一部分只在你拥有的完整编辑草稿中出现，不会进入普通推荐卡 DOM。明确边界不是扫兴，而是让关系有被尊重的可能。',
    });
    const friendBody = collapsibleBody(friendSection, friendHeading, '边界与节奏');
    const friendGroup = fieldGroup(friendBody, '熟悉之后可以知道', '仅好友资料用于更深入的关系推进，不会出现在首页推荐。', 'yl-character-field-grid yl-character-field-grid-two');
    textField(friendGroup, '关系状态', { name: 'friend-关系状态', required: true, placeholder: '例如：单身 / 未说明' });
    textField(friendGroup, '希望对方尊重的边界', { name: 'friend-边界与偏好', required: true, rows: 3, placeholder: '例如：尊重明确拒绝，重要决定先沟通。' });
    const hiddenGroup = fieldGroup(friendBody, '只属于这份角色草稿', '隐藏资料供系统校验和受控上下文使用，不进入普通 UI 展示。', 'yl-character-field-grid yl-character-field-grid-two yl-character-private-group');
    textField(hiddenGroup, '实际年龄', { name: 'hidden-age', type: 'number', value: '18', min: 18, max: 120, required: true, inputMode: 'numeric', hint: '必须满 18 岁；登记前仍会经过完整成年人校验。' });
    textField(hiddenGroup, '私人创作备注', { name: 'hidden-note', rows: 3, placeholder: '记录不希望公开展示的角色设定，可留空。' });
    textField(hiddenGroup, '整体偏好与边界', { name: 'boundary', rows: 3, placeholder: '记录关系推进中需要长期遵守的偏好与边界，可留空。', className: 'yl-character-field-wide' });

    const thresholdSection = element('section', { className: 'yl-phone-empty-actions yl-character-card yl-character-card-thresholds', id: 'yl-character-section-thresholds' });
    const thresholdHeading = sectionHeading(thresholdSection, {
        step: '03 · 进阶', eyebrow: '互动节奏', title: '设定 TA 的互动节奏',
        description: '0–100 的数值用于表达角色在不同负面互动下的反应门槛。它们不是公开标签，也不会替代剧情中的具体沟通与判断。',
    });
    const thresholdBody = collapsibleBody(thresholdSection, thresholdHeading, '互动节奏');
    const thresholdGrid = fieldGroup(thresholdBody, '关系反应阈值', '从人设推导这四个数值并保持内在一致：数值越高越难触发对应反应。外向包容的人整体偏高，敏感高戒备的人偏低，但不该低到一言不合就断联。AI 生成的新角色会强制要求拉黑阈值不低于 60 且高于已读不回阈值。', 'yl-character-field-grid yl-character-field-grid-four yl-character-threshold-grid');
    const thresholdHints = {
        拒绝阈值: '何时会明确表达不适或拒绝；越高代表对契合度越挑剔。',
        已读不回阈值: '对负面互动压力的容忍线，越过便已读不回；越高越能忍。',
        取消匹配阈值: '何时会结束当前匹配关系；越高越难走到这一步。',
        拉黑阈值: '彻底断联的心理底线；建议比已读不回阈值至少高 20，且不低于 60。',
    };
    for (const key of THRESHOLD_KEYS) textField(thresholdGrid, key, { name: `threshold-${key}`, type: 'number', value: String(baseCandidate()[key]), min: 0, max: 100, required: true, inputMode: 'numeric', hint: thresholdHints[key] });

    const submitSection = element('footer', { className: 'yl-character-submit-card', id: 'yl-character-section-submit' });
    const submitCopy = element('div', { className: 'yl-character-submit-copy' });
    submitCopy.appendChild(element('span', { className: 'yl-character-step-badge', text: '04' }));
    const submitWords = element('div', { className: 'yl-character-submit-words' });
    submitWords.appendChild(element('h2', { className: 'yl-character-submit-title', text: '最后检查一次，再让 TA 出现在这段故事里' }));
    submitWords.appendChild(element('p', { className: 'yl-character-submit-description', text: '提交会重新执行模板结构、成年人和资料边界校验；只有校验通过后才会登记到当前聊天。' }));
    submitCopy.appendChild(submitWords);
    const saveLocal = element('input', { name: 'save-local', type: 'checkbox', checked: true, ariaLabel: '同时保存本地模板' });
    const saveLabel = element('label', { className: 'yl-character-save-local' });
    append(saveLabel, [saveLocal, element('span', { text: '同时保存到本地模板库（仅此浏览器，且不含 API Key）' })]);
    const saveDraftButton = element('button', { className: 'yl-phone-action-card yl-character-import-button', type: 'button', text: '只保存当前草稿到本地模板库' });
    const submit = element('button', { className: 'yl-phone-action-card yl-character-submit-button', type: 'submit', text: '验证并登记到当前聊天' });
    append(submitSection, [submitCopy, saveLabel, saveDraftButton, submit]);

    append(form, [publicSection, avatarSection, aiSection, friendSection, thresholdSection, submitSection]);
    section.appendChild(form);

    // —— 步骤锚点：hero journey 条与 desktop rail 共用同一步骤状态与跳转逻辑 ——
    const stepTargets = [
        ['01', '心动名片', publicSection],
        ['02', '形象与灵感', avatarSection],
        ['03', '边界与节奏', friendSection],
        ['04', '确认登记', submitSection],
    ];
    const stepButtons = [];
    const journeyButtons = [];
    function activateStep(activeIndex) {
        for (const list of [journeyButtons, stepButtons]) {
            list.forEach((button, index) => {
                const isActive = index === activeIndex;
                button.classList.toggle('is-active', isActive);
                if (isActive) button.setAttribute('aria-current', 'step');
                else if (typeof button.removeAttribute === 'function') button.removeAttribute('aria-current');
                else button.setAttribute('aria-current', 'false');
            });
        }
    }
    function goToStep(index, target) {
        expandCard(target);
        activateStep(index);
        const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
        target.scrollIntoView?.({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    }
    stepTargets.forEach(([number, label, target], index) => {
        const targetId = target.getAttribute('id') ?? '';
        const journeyButton = element('button', { className: 'yl-character-journey-item', type: 'button' });
        append(journeyButton, [
            element('span', { className: 'yl-character-journey-number', text: number }),
            element('span', { className: 'yl-character-journey-label', text: label }),
        ]);
        const railButton = element('button', { className: 'yl-character-step-link', type: 'button' });
        append(railButton, [
            element('span', { className: 'yl-character-step-number', text: number }),
            element('span', { className: 'yl-character-step-label', text: label }),
        ]);
        for (const button of [journeyButton, railButton]) {
            button.dataset.stepTarget = targetId;
            button.setAttribute('data-step-target', targetId);
            listen(button, button, 'click', () => goToStep(index, target), signal);
        }
        journeyButtons.push(journeyButton);
        journey.appendChild(journeyButton);
        stepButtons.push(railButton);
        stepRail.appendChild(railButton);
    });
    activateStep(0);

    // 滚动时高亮当前步：可选能力（真机有 IntersectionObserver；MiniDOM 无则跳过，点击高亮不受影响）。
    const scrollSpySections = [
        [publicSection, 0],
        [avatarSection, 1], [aiSection, 1],
        [friendSection, 2], [thresholdSection, 2],
        [submitSection, 3],
    ];
    const ObserverCtor = globalThis.IntersectionObserver;
    if (typeof ObserverCtor === 'function') {
        const visibleRatio = new Map();
        const observer = new ObserverCtor((entries) => {
            for (const entry of entries) visibleRatio.set(entry.target, entry.isIntersecting ? Math.max(entry.intersectionRatio, 0.0001) : 0);
            for (const [node, stepIndex] of scrollSpySections) {
                if ((visibleRatio.get(node) ?? 0) > 0) { activateStep(stepIndex); return; }
            }
        }, { threshold: [0, 0.2, 0.55] });
        for (const [node] of scrollSpySections) observer.observe(node);
        signal?.addEventListener?.('abort', () => observer.disconnect(), { once: true });
    }

    const preview = element('aside', { className: 'yl-character-preview' });
    const previewHeader = element('header', { className: 'yl-character-preview-header' });
    previewHeader.appendChild(element('p', { className: 'yl-character-section-eyebrow', text: '实时预览' }));
    previewHeader.appendChild(element('h2', { className: 'yl-character-preview-title', text: '公开名片实时预览' }));
    previewHeader.appendChild(element('p', { className: 'yl-character-preview-description', text: '这里只显示会出现在发现页的公开资料。' }));
    const previewCard = element('article', { className: 'yl-character-preview-card' });
    append(preview, [
        previewHeader,
        previewCard,
        element('p', { className: 'yl-character-preview-note', text: '预览只包含公开资料；仅好友与隐藏资料绝不会出现在这里。' }),
    ]);
    section.appendChild(preview);

    const templateWorkspace = element('section', { className: 'yl-character-template-workspace' });
    const templateIntro = element('header', { className: 'yl-character-template-heading' });
    templateIntro.appendChild(element('p', { className: 'yl-character-section-eyebrow', text: '我的角色衣橱' }));
    templateIntro.appendChild(element('h2', { className: 'yl-character-template-title', text: '把喜欢的角色草稿收进资料箱' }));
    templateIntro.appendChild(element('p', { className: 'yl-character-template-description', text: '导入、导出与本地模板都不会绕过登记校验。你可以先收藏和继续编辑，准备好后再加入当前聊天。' }));
    templateWorkspace.appendChild(templateIntro);

    const importSection = element('section', { className: 'yl-phone-empty-actions yl-character-card yl-character-import-card' });
    sectionHeading(importSection, {
        eyebrow: '导入与导出', title: '导入或导出角色模板',
    });
    const templateText = element('textarea', { name: 'character-template-json', rows: 6, placeholder: '在这里粘贴 yuelema.character/v1 JSON 模板' });
    templateText.className = 'yl-character-template-textarea';
    const importButton = element('button', { className: 'yl-phone-action-card yl-character-import-button', type: 'button', text: '校验并载入到编辑器' });
    const importTemplateToLibraryButton = element('button', { className: 'yl-character-library-action yl-character-library-action-primary', type: 'button', text: '导入单个模板到本地库' });
    const importLibraryButton = element('button', { className: 'yl-character-library-action', type: 'button', text: '合并导入整个模板库' });
    const exportLibraryWithAvatarButton = element('button', { className: 'yl-character-library-action', type: 'button', text: '导出整个库（含头像）' });
    const exportLibraryTextOnlyButton = element('button', { className: 'yl-character-library-action', type: 'button', text: '导出整个库（不含头像）' });
    append(importSection, [templateText, importButton, importTemplateToLibraryButton, importLibraryButton, exportLibraryWithAvatarButton, exportLibraryTextOnlyButton]);
    templateWorkspace.appendChild(importSection);

    const librarySection = element('section', { className: 'yl-phone-empty-actions yl-character-card yl-character-library' });
    sectionHeading(librarySection, {
        eyebrow: '本地模板', title: '本地模板库',
        description: '最多保存 50 条，仅保留在当前浏览器。你可以载入继续修改，或导出为自己的备份。',
    });
    templateWorkspace.appendChild(librarySection);
    section.appendChild(templateWorkspace);

    let localAvatar = null;
    /** Rebuilds the public-card preview strictly from public form fields plus the in-memory avatar draft. */
    function updatePreview() {
        const profile = publicProfileFromForm(form);
        if (!profile.昵称) {
            previewCard.replaceChildren(element('p', { className: 'yl-character-preview-empty', text: '填写昵称后，这里会出现 TA 的名片。' }));
            return;
        }
        const imageSource = readNamed(form, 'avatar-kind') === 'embedded' && localAvatar ? localAvatar.dataUrl : '';
        const children = [
            createAvatarView({ documentRef: documentRef ?? globalThis.document, nickname: profile.昵称, imageSource, className: 'yl-character-preview-avatar' }),
            element('strong', { className: 'yl-character-preview-name', text: profile.昵称 }),
        ];
        const meta = [profile.年龄段, profile.城市, profile.距离范围].filter(Boolean).join(' · ');
        if (meta) children.push(element('p', { className: 'yl-character-preview-meta', text: meta }));
        if (profile.寻找意图) children.push(element('p', { className: 'yl-character-preview-intent', text: `想找：${profile.寻找意图}` }));
        if (profile.简介) children.push(element('p', { className: 'yl-character-preview-bio', text: profile.简介 }));
        const tags = [...new Set(TAG_KEYS.flatMap((key) => profile[key]))].slice(0, 12);
        if (tags.length) {
            const tagList = element('div', { className: 'yl-character-preview-tags' });
            for (const tag of tags) tagList.appendChild(element('span', { className: 'yl-character-preview-tag', text: tag }));
            children.push(tagList);
        }
        previewCard.replaceChildren(...children);
    }
    for (const tagName of ['input', 'textarea', 'select']) {
        for (const field of form.querySelectorAll(tagName)) {
            listen(field, field, 'input', () => updatePreview(), signal);
            listen(field, field, 'change', () => updatePreview(), signal);
            // 原生必填校验命中折叠卡内控件时自动展开，避免「不可聚焦的失效控件」拦截提交。
            listen(field, field, 'invalid', () => expandCardContaining(field), signal);
        }
    }

    function templateFromEditor() {
        const avatar = avatarFromForm(form, localAvatar);
        return importCharacterTemplate({ format: CHARACTER_TEMPLATE_FORMAT, character: candidateFromForm(form, avatar), avatar });
    }
    function saveTemplateToLibrary(template) {
        if (typeof characterLibrary?.saveTemplate === 'function') return characterLibrary.saveTemplate({ template });
        return characterLibrary?.importTemplate?.(template);
    }
    function renderLibrary() {
        const previous = [...librarySection.querySelectorAll('.yl-character-library-row')];
        previous.forEach((node) => node.remove());
        let entries = [];
        try { entries = characterLibrary?.list?.() ?? []; } catch (error) { onFeedback(safeLibraryMessage(error)); return; }
        if (!entries.length) { librarySection.appendChild(element('p', { className: 'yl-phone-page-description yl-character-library-row', text: '尚无本地模板。' })); return; }
        for (const entry of entries) {
            const row = element('div', { className: 'yl-character-library-row yl-character-library-item' });
            row.appendChild(element('strong', { text: entry.metadata.name }));
            const load = element('button', { className: 'yl-character-library-action yl-character-library-action-primary', type: 'button', text: '载入' });
            const exportWithAvatar = element('button', { className: 'yl-character-library-action', type: 'button', text: '导出含头像' });
            const exportTextOnly = element('button', { className: 'yl-character-library-action', type: 'button', text: '导出不含头像' });
            const remove = element('button', { className: 'yl-character-library-action yl-character-library-action-danger', type: 'button', text: '删除' });
            listen(load, load, 'click', () => {
                try { const record = characterLibrary.get(entry.id); candidateToForm(form, record.template); localAvatar = record.template.avatar?.kind === 'embedded' ? record.template.avatar : null; avatarNote.textContent = localAvatar ? '已载入已压缩的本地头像。' : '已载入模板头像设置。'; updatePreview(); onFeedback('已载入本地模板草稿，尚未登记到当前聊天。'); } catch (error) { onFeedback(safeLibraryMessage(error)); }
            }, signal);
            for (const [button, includeAvatar] of [[exportWithAvatar, true], [exportTextOnly, false]]) listen(button, button, 'click', () => {
                try { templateText.value = characterLibrary.exportTemplate(entry.id, { includeAvatar }); onFeedback(includeAvatar ? '已写入含头像的导出 JSON，可复制保存。' : '已写入不含头像的导出 JSON，可复制保存。'); } catch (error) { onFeedback(safeLibraryMessage(error)); }
            }, signal);
            listen(remove, remove, 'click', () => { try { characterLibrary.remove(entry.id); renderLibrary(); onFeedback('已从本地模板库删除；当前聊天变量未改变。'); } catch (error) { onFeedback(safeLibraryMessage(error)); } }, signal);
            append(row, [load, exportWithAvatar, exportTextOnly, remove]);
            librarySection.appendChild(row);
        }
    }

    function adoptAiCandidate(candidate, message) {
        const template = importCharacterTemplate({ format: CHARACTER_TEMPLATE_FORMAT, character: candidate, avatar: { kind: 'placeholder' } });
        candidateToForm(form, template);
        localAvatar = null;
        avatarKind.value = 'placeholder';
        avatarNote.textContent = 'AI 草稿不携带头像；可自行选择本地图片或占位头像。';
        updatePreview();
        onFeedback(message);
    }

    async function runAiDraft(kind) {
        const isCompletion = kind === 'completion';
        const button = isCompletion ? completionButton : authoringButton;
        const method = isCompletion ? actionBridge.generateCharacterCompletionDraft : actionBridge.generateCharacterAuthoringDraft;
        if (typeof method !== 'function') { onFeedback('角色创作模型桥接尚未就绪。'); return; }
        const instruction = isCompletion ? cleanText(completionInstruction.value) : cleanText(creativeBrief.value);
        if (!instruction) { onFeedback(isCompletion ? '请先填写补全说明；当前草稿未改变。' : '请先填写完整创作说明；当前草稿未改变。'); return; }
        button.disabled = true;
        const operationName = isCompletion ? 'AI 补全' : 'AI 完整创作';
        const activityHandle = startActivity(operationName, isCompletion ? '正在生成公开资料补全草稿……' : '正在生成完整角色草稿……');
        onFeedback(isCompletion ? '正在生成公开资料补全草稿；不会自动登记。' : '正在生成完整角色草稿；不会自动登记。');
        try {
            const result = await (isCompletion
                ? method({ publicProfile: publicProfileFromForm(form), instruction, contentMode, signal })
                : method({ creativeBrief: instruction, signal }));
            if (!result?.ok || !result?.candidate) {
                settleActivity('fail', activityHandle, '角色草稿未生成。', failureDetail(result, { operation: operationName, stage: '模型生成与校验' }));
                onFeedback(isCompletion ? 'AI 补全未生成可用草稿；当前草稿未改变。' : 'AI 完整创作未生成可用草稿；当前草稿未改变。');
                return;
            }
            settleActivity('succeed', activityHandle, '角色草稿已载入编辑器。');
            adoptAiCandidate(result.candidate, isCompletion ? 'AI 补全草稿已载入编辑器；请检查私有层、边界和阈值后再登记。' : 'AI 完整创作草稿已载入编辑器；请检查全部字段后再登记。');
        } catch (error) {
            settleActivity('fail', activityHandle, '角色草稿未生成。', failureDetail(error, { operation: operationName, stage: '调用角色创作桥接' }));
            onFeedback('AI 角色创作未完成；当前草稿未改变。');
        }
        finally { button.disabled = false; }
    }

    listen(completionButton, completionButton, 'click', () => { void runAiDraft('completion'); }, signal);
    listen(authoringButton, authoringButton, 'click', () => { void runAiDraft('authoring'); }, signal);
    listen(avatarFile, avatarFile, 'change', () => {
        const file = avatarFile.files?.[0];
        if (!file) return;
        avatarNote.textContent = '正在压缩本地头像…';
        void compressLocalAvatar(file).then((avatar) => { localAvatar = avatar; avatarKind.value = 'embedded'; avatarNote.textContent = `本地头像已压缩为 ${avatar.width}×${avatar.height} WebP。`; updatePreview(); }).catch((error) => { localAvatar = null; avatarNote.textContent = projectAvatarError(error).message; updatePreview(); });
    }, signal);
    if (remoteImportButton) {
        listen(remoteImportButton, remoteImportButton, 'click', async () => {
            const url = cleanText(remoteUrlInput?.value);
            if (!url) { avatarNote.textContent = '请先粘贴要导入的图片链接。'; return; }
            remoteImportButton.disabled = true;
            avatarNote.textContent = '正在下载并压缩链接图片…';
            try {
                const avatar = await importAvatarFromUrl(url);
                localAvatar = avatar;
                avatarKind.value = 'embedded';
                avatarNote.textContent = `链接图片已压缩为 ${avatar.width}×${avatar.height} WebP 本地头像；链接本身不会被保存。`;
                updatePreview();
            } catch (error) {
                // 失败不改动当前头像草稿；提示只用安全投影文案，不回显链接或宿主异常原文。
                avatarNote.textContent = projectRemoteImportError(error)?.message ?? projectAvatarError(error).message;
            } finally {
                remoteImportButton.disabled = false;
            }
        }, signal);
    }

    listen(importButton, importButton, 'click', () => {
        try {
            const template = importCharacterTemplate(templateText.value);
            candidateToForm(form, template);
            localAvatar = template.avatar?.kind === 'embedded' ? template.avatar : null;
            avatarNote.textContent = localAvatar ? '已导入已压缩的本地头像。' : '已导入头像设置。';
            updatePreview();
            onFeedback('模板已通过完整成年人和结构校验；请检查草稿后再登记。');
        } catch (error) {
            const projected = projectCharacterTemplateError(error);
            settleActivity('fail', startActivity('模板载入', '正在校验角色模板……'), '角色模板未通过校验。',
                failureDetail({ code: projected.code, detail: projected.detail }, { operation: '模板载入编辑器', stage: '模板结构与成年人校验' }));
            onFeedback(projected.message);
        }
    }, signal);

    /** 本地模板库失败仅补控制台详情（错误码 + 可选的字段结论）；界面文案不变。 */
    function reportLibraryFailure(operation, error) {
        settleActivity('fail', startActivity('本地模板库', '正在处理本地角色模板……'), '本地角色模板操作未完成。',
            failureDetail({ code: typeof error?.code === 'string' ? error.code : '', detail: typeof error?.detail === 'string' ? error.detail : '' }, { operation, stage: '本地模板库' }));
    }

    listen(saveDraftButton, saveDraftButton, 'click', () => {
        try {
            saveTemplateToLibrary(templateFromEditor());
            renderLibrary();
            onFeedback('当前角色草稿已保存到本地模板库，尚未登记到当前聊天。');
        } catch (error) {
            const code = typeof error?.code === 'string' ? error.code : '';
            reportLibraryFailure('保存当前草稿到本地模板库', /^[A-Z0-9_]+$/u.test(code) ? error : { code: projectCharacterTemplateError(error).code, detail: projectCharacterTemplateError(error).detail });
            onFeedback(/^[A-Z0-9_]+$/u.test(code) ? safeLibraryMessage(error) : projectCharacterTemplateError(error).message);
        }
    }, signal);

    listen(importTemplateToLibraryButton, importTemplateToLibraryButton, 'click', () => {
        try {
            if (typeof characterLibrary?.importTemplateJson === 'function') characterLibrary.importTemplateJson(templateText.value);
            else characterLibrary?.importTemplate?.(templateText.value);
            renderLibrary();
            onFeedback('角色模板已校验并导入本地模板库，当前聊天变量未改变。');
        } catch (error) { reportLibraryFailure('导入单个模板到本地库', error); onFeedback(safeLibraryMessage(error)); }
    }, signal);

    listen(importLibraryButton, importLibraryButton, 'click', () => {
        try {
            if (typeof characterLibrary?.importLibraryJson !== 'function') throw Object.assign(new Error('library import unavailable'), { code: 'UNSUPPORTED_LIBRARY_VERSION' });
            const result = characterLibrary.importLibraryJson(templateText.value, { mode: 'merge' });
            renderLibrary();
            onFeedback('已合并导入 ' + result.importedCount + ' 条角色模板；当前聊天变量未改变。');
        } catch (error) { reportLibraryFailure('合并导入整个模板库', error); onFeedback(safeLibraryMessage(error)); }
    }, signal);

    for (const [button, includeAvatar] of [[exportLibraryWithAvatarButton, true], [exportLibraryTextOnlyButton, false]]) {
        listen(button, button, 'click', () => {
            try {
                if (typeof characterLibrary?.exportLibraryJson !== 'function') throw Object.assign(new Error('library export unavailable'), { code: 'UNSUPPORTED_LIBRARY_VERSION' });
                templateText.value = characterLibrary.exportLibraryJson({ includeAvatar });
                onFeedback(includeAvatar ? '整个本地模板库已导出为含头像 JSON，可复制保存。' : '整个本地模板库已导出为不含头像 JSON，可复制保存。');
            } catch (error) { onFeedback(safeLibraryMessage(error)); }
        }, signal);
    }

    listen(form, form, 'submit', (event) => {
        event.preventDefault();
        if (submit.disabled) return;
        try {
            const template = templateFromEditor();
            submit.disabled = true;
            const activityHandle = startActivity('角色登记', '正在校验并登记角色……');
            Promise.resolve(actionBridge.registerCharacter(template.character)).then((result) => {
                submit.disabled = false;
                if (!result?.ok) {
                    settleActivity('fail', activityHandle, '角色未登记到当前聊天。', failureDetail(result, { operation: '角色登记', stage: '受控写入前校验' }));
                    onFeedback('角色未登记：MVU 当前不可写入或资料未通过最终校验。');
                    return;
                }
                settleActivity('succeed', activityHandle, '角色已登记到当前聊天。');
                if (saveLocal.checked && characterLibrary) {
                    try { characterLibrary.importTemplate(template); renderLibrary(); } catch (error) { reportLibraryFailure('登记后保存本地模板', error); onFeedback(`角色已登记，但本地保存失败：${safeLibraryMessage(error)}`); onRegistered?.(); return; }
                }
                onFeedback('角色已通过成年人校验并登记到当前聊天。');
                onRegistered?.();
            }).catch((error) => {
                submit.disabled = false;
                settleActivity('fail', activityHandle, '角色未登记到当前聊天。', failureDetail(error, { operation: '角色登记', stage: '调用受控写入边界' }));
                onFeedback('角色登记未完成，未展示底层错误。');
            });
        } catch (error) {
            const projected = projectCharacterTemplateError(error);
            settleActivity('fail', startActivity('角色登记', '正在校验并登记角色……'), '角色未登记到当前聊天。',
                failureDetail({ code: projected.code, detail: projected.detail }, { operation: '角色登记', stage: '编辑器模板校验' }));
            onFeedback(projected.message);
        }
    }, signal);

    renderLibrary();
    updatePreview();
    return section;
}
