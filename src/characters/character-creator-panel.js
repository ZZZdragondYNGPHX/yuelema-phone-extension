import { append, element, listen } from '../dom.js';
import { CHARACTER_TEMPLATE_FORMAT, importCharacterTemplate, projectCharacterTemplateError } from './character-template-codec.js';
import { avatarAcceptAttribute, compressLocalAvatar, projectAvatarError } from './avatar-codec.js';

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
        偏好与边界: '',
        拒绝阈值: 40, 已读不回阈值: 55, 取消匹配阈值: 70, 拉黑阈值: 85,
        与玩家关系: { 状态: '陌生', 全局账号表现: 50, NPC专属匹配度: 50, 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 },
    };
}

function textField(container, labelText, { name, value = '', rows = 0, required = false, placeholder = '', type = 'text', min, max, inputMode } = {}) {
    const label = element('label', { className: 'yl-phone-page-description', text: labelText });
    const control = rows > 0
        ? element('textarea', { name, value, rows, required, placeholder, maxLength: 1200 })
        : element('input', { name, type, value, required, placeholder, min, max, inputMode, maxLength: type === 'number' ? undefined : 500 });
    append(label, [control]);
    container.appendChild(label);
    return control;
}

function readNamed(form, name) {
    const control = form.querySelector(`[name="${name}"]`);
    return control ? control.value : '';
}

function candidateFromForm(form, avatar) {
    const candidate = baseCandidate();
    for (const key of PUBLIC_TEXT_KEYS) candidate.公开资料[key] = cleanText(readNamed(form, `public-${key}`));
    candidate.公开资料.头像引用 = avatar.kind === 'url' ? avatar.url : avatar.kind === 'embedded' ? '本地头像' : '';
    for (const key of TAG_KEYS) candidate.公开资料[key] = splitTags(readNamed(form, `tag-${key}`));
    for (const key of FRIEND_TEXT_KEYS) candidate.仅好友资料[key] = cleanText(readNamed(form, `friend-${key}`));
    candidate.隐藏资料.实际年龄 = Number(readNamed(form, 'hidden-age'));
    candidate.隐藏资料.私人备注 = cleanText(readNamed(form, 'hidden-note'));
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
    const kind = readNamed(form, 'avatar-kind');
    if (kind === 'url') return { kind: 'url', url: cleanText(readNamed(form, 'avatar-url')) };
    if (kind === 'embedded') return localAvatar ?? { kind: 'placeholder' };
    return { kind: 'placeholder' };
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
    form.querySelector('[name="boundary"]').value = candidate.偏好与边界 ?? '';
    for (const key of THRESHOLD_KEYS) form.querySelector(`[name="threshold-${key}"]`).value = String(candidate[key]);
    const avatarKind = form.querySelector('[name="avatar-kind"]');
    if (avatarKind) avatarKind.value = template.avatar?.kind ?? 'placeholder';
    const avatarUrl = form.querySelector('[name="avatar-url"]');
    if (avatarUrl) avatarUrl.value = template.avatar?.kind === 'url' ? template.avatar.url : '';
}

function safeLibraryMessage(error) {
    const code = typeof error?.code === 'string' ? error.code : '';
    const messages = {
        TEMPLATE_LIMIT_REACHED: '本地角色模板已达 50 条上限。',
        DUPLICATE_TEMPLATE_ID: '本地角色模板 ID 重复。',
        LIBRARY_TOO_LARGE: '本地角色模板库容量已满。',
        TEMPLATE_NOT_FOUND: '本地角色模板已不存在。',
    };
    return messages[code] ?? '本地角色模板操作未完成。';
}

/**
 * Full-data editor for explicitly creating/importing a candidate.
 * The editor may show the current private draft because the player owns it; normal
 * recommendation cards remain public-projection-only in app-shell/ui-model.
 */
export function buildCharacterCreatorPanel({ documentRef, actionBridge, characterLibrary, signal, onFeedback, onRegistered }) {
    const section = element('section', { className: 'yl-phone-empty-actions yl-character-editor' });
    section.appendChild(element('h2', { text: '创建或导入角色' }));
    section.appendChild(element('p', { className: 'yl-phone-page-description', text: '仅明确成年人可以登记。编辑器可显示你正在编辑的完整草稿；登记后的首页始终只显示公开资料。' }));

    const form = element('form', { className: 'yl-character-form' });
    const publicSection = element('section', { className: 'yl-phone-empty-actions' });
    publicSection.appendChild(element('h2', { text: '公开资料（必填）' }));
    for (const key of PUBLIC_TEXT_KEYS) textField(publicSection, key, { name: `public-${key}`, required: true, rows: key === '简介' ? 3 : 0 });
    for (const key of TAG_KEYS) textField(publicSection, `${key}（逗号分隔，可留空）`, { name: `tag-${key}`, placeholder: '例如：电影, 咖啡' });

    const aiSection = element('section', { className: 'yl-phone-empty-actions' });
    aiSection.appendChild(element('h2', { text: 'AI 补全 / 完整创作' }));
    aiSection.appendChild(element('p', { className: 'yl-phone-page-description', text: 'AI 结果只会载入本地编辑器草稿，绝不自动登记、保存模板或生成头像；请逐项检查后再提交。补全仅发送此表单的公开字段，完整创作仅发送创作说明与最小玩家公开匹配上下文。' }));
    const completionInstruction = textField(aiSection, '补全说明（基于当前公开资料）', { name: 'ai-completion-instruction', rows: 3, placeholder: '例如：将简介补为成熟都市约会软件资料，保留已填写的公开定位。' });
    const completionButton = element('button', { className: 'yl-phone-action-card', type: 'button', text: 'AI 完善补全到草稿' });
    const creativeBrief = textField(aiSection, '完整创作说明', { name: 'ai-creative-brief', rows: 3, placeholder: '例如：创作一名明确成年、现代上海、偏好先文字聊天再约会的独立角色。' });
    const authoringButton = element('button', { className: 'yl-phone-action-card', type: 'button', text: 'AI 完整创作到草稿' });
    append(aiSection, [completionButton, authoringButton]);
    const avatarSection = element('section', { className: 'yl-phone-empty-actions' });
    avatarSection.appendChild(element('h2', { text: '头像' }));
    const avatarKind = element('select', { name: 'avatar-kind', ariaLabel: '头像来源' });
    append(avatarKind, [element('option', { value: 'placeholder', text: '占位头像' }), element('option', { value: 'url', text: '图片 URL' }), element('option', { value: 'embedded', text: '本地图片（压缩后保存）' })]);
    avatarSection.appendChild(avatarKind);
    const avatarUrl = textField(avatarSection, '图片 URL（仅 http/https）', { name: 'avatar-url', placeholder: 'https://example.com/avatar.webp' });
    const avatarFile = element('input', { name: 'avatar-file', type: 'file', accept: avatarAcceptAttribute(), ariaLabel: '选择本地头像' });
    avatarSection.appendChild(avatarFile);
    const avatarNote = element('p', { className: 'yl-phone-page-description', text: '本地头像会在当前浏览器压缩为最多 1024px 的 WebP；可在导出时选择是否打包。' });
    avatarSection.appendChild(avatarNote);

    const friendSection = element('section', { className: 'yl-phone-empty-actions' });
    friendSection.appendChild(element('h2', { text: '仅好友与隐藏资料（仅草稿可见）' }));
    for (const key of FRIEND_TEXT_KEYS) textField(friendSection, key, { name: `friend-${key}`, required: true, rows: key === '边界与偏好' ? 3 : 0 });
    textField(friendSection, '实际年龄（必须满 18 岁）', { name: 'hidden-age', type: 'number', value: '18', min: 18, max: 120, required: true, inputMode: 'numeric' });
    textField(friendSection, '私人备注（可留空）', { name: 'hidden-note', rows: 3 });
    textField(friendSection, '偏好与边界（可留空）', { name: 'boundary', rows: 3 });

    const thresholdSection = element('section', { className: 'yl-phone-empty-actions' });
    thresholdSection.appendChild(element('h2', { text: '互动阈值（0–100）' }));
    for (const key of THRESHOLD_KEYS) textField(thresholdSection, key, { name: `threshold-${key}`, type: 'number', value: String(baseCandidate()[key]), min: 0, max: 100, required: true, inputMode: 'numeric' });

    const saveLocal = element('input', { name: 'save-local', type: 'checkbox', checked: true, ariaLabel: '同时保存本地模板' });
    const saveLabel = element('label', { className: 'yl-phone-page-description', text: '同时保存到本地模板库（仅此浏览器，且不含 API Key）' });
    saveLabel.appendChild(saveLocal);
    const submit = element('button', { className: 'yl-phone-action-card', type: 'submit', text: '验证并登记到当前聊天' });
    append(form, [publicSection, aiSection, avatarSection, friendSection, thresholdSection, saveLabel, submit]);
    section.appendChild(form);

    const importSection = element('section', { className: 'yl-phone-empty-actions' });
    importSection.appendChild(element('h2', { text: '导入 / 导出角色模板' }));
    const templateText = element('textarea', { name: 'character-template-json', rows: 6, placeholder: '粘贴 yuelema.character/v1 JSON 模板' });
    const importButton = element('button', { className: 'yl-phone-action-card', type: 'button', text: '校验并载入到编辑器' });
    append(importSection, [templateText, importButton]);
    section.appendChild(importSection);

    const librarySection = element('section', { className: 'yl-phone-empty-actions' });
    librarySection.appendChild(element('h2', { text: '本地模板库（最多 50 条）' }));
    section.appendChild(librarySection);

    let localAvatar = null;
    function renderLibrary() {
        const previous = [...librarySection.querySelectorAll('.yl-character-library-row')];
        previous.forEach((node) => node.remove());
        let entries = [];
        try { entries = characterLibrary?.list?.() ?? []; } catch (error) { onFeedback(safeLibraryMessage(error)); return; }
        if (!entries.length) { librarySection.appendChild(element('p', { className: 'yl-phone-page-description yl-character-library-row', text: '尚无本地模板。' })); return; }
        for (const entry of entries) {
            const row = element('div', { className: 'yl-character-library-row' });
            row.appendChild(element('strong', { text: entry.metadata.name }));
            const load = element('button', { type: 'button', text: '载入' });
            const exportWithAvatar = element('button', { type: 'button', text: '导出含头像' });
            const exportTextOnly = element('button', { type: 'button', text: '导出不含头像' });
            const remove = element('button', { type: 'button', text: '删除' });
            listen(load, load, 'click', () => {
                try { const record = characterLibrary.get(entry.id); candidateToForm(form, record.template); localAvatar = record.template.avatar?.kind === 'embedded' ? record.template.avatar : null; avatarNote.textContent = localAvatar ? '已载入已压缩的本地头像。' : '已载入模板头像设置。'; onFeedback('已载入本地模板草稿，尚未登记到当前聊天。'); } catch (error) { onFeedback(safeLibraryMessage(error)); }
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
        avatarUrl.value = '';
        avatarNote.textContent = 'AI 草稿不携带头像；可自行选择 URL、本地图片或占位头像。';
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
        onFeedback(isCompletion ? '正在生成公开资料补全草稿；不会自动登记。' : '正在生成完整角色草稿；不会自动登记。');
        try {
            const result = await (isCompletion
                ? method({ publicProfile: publicProfileFromForm(form), instruction, signal })
                : method({ creativeBrief: instruction, signal }));
            if (!result?.ok || !result?.candidate) { onFeedback(isCompletion ? 'AI 补全未生成可用草稿；当前草稿未改变。' : 'AI 完整创作未生成可用草稿；当前草稿未改变。'); return; }
            adoptAiCandidate(result.candidate, isCompletion ? 'AI 补全草稿已载入编辑器；请检查私有层、边界和阈值后再登记。' : 'AI 完整创作草稿已载入编辑器；请检查全部字段后再登记。');
        } catch { onFeedback('AI 角色创作未完成；当前草稿未改变。'); }
        finally { button.disabled = false; }
    }

    listen(completionButton, completionButton, 'click', () => { void runAiDraft('completion'); }, signal);
    listen(authoringButton, authoringButton, 'click', () => { void runAiDraft('authoring'); }, signal);
    listen(avatarFile, avatarFile, 'change', () => {
        const file = avatarFile.files?.[0];
        if (!file) return;
        avatarNote.textContent = '正在压缩本地头像…';
        void compressLocalAvatar(file).then((avatar) => { localAvatar = avatar; avatarKind.value = 'embedded'; avatarNote.textContent = `本地头像已压缩为 ${avatar.width}×${avatar.height} WebP。`; }).catch((error) => { localAvatar = null; avatarNote.textContent = projectAvatarError(error).message; });
    }, signal);

    listen(importButton, importButton, 'click', () => {
        try {
            const template = importCharacterTemplate(templateText.value);
            candidateToForm(form, template);
            localAvatar = template.avatar?.kind === 'embedded' ? template.avatar : null;
            avatarNote.textContent = localAvatar ? '已导入已压缩的本地头像。' : '已导入头像设置。';
            onFeedback('模板已通过完整成年人和结构校验；请检查草稿后再登记。');
        } catch (error) { onFeedback(projectCharacterTemplateError(error).message); }
    }, signal);

    listen(form, form, 'submit', (event) => {
        event.preventDefault();
        if (submit.disabled) return;
        try {
            const avatar = avatarFromForm(form, localAvatar);
            const template = importCharacterTemplate({ format: CHARACTER_TEMPLATE_FORMAT, character: candidateFromForm(form, avatar), avatar });
            submit.disabled = true;
            Promise.resolve(actionBridge.registerCharacter(template.character)).then((result) => {
                submit.disabled = false;
                if (!result?.ok) { onFeedback('角色未登记：MVU 当前不可写入或资料未通过最终校验。'); return; }
                if (saveLocal.checked && characterLibrary) {
                    try { characterLibrary.importTemplate(template); renderLibrary(); } catch (error) { onFeedback(`角色已登记，但本地保存失败：${safeLibraryMessage(error)}`); onRegistered?.(); return; }
                }
                onFeedback('角色已通过成年人校验并登记到当前聊天。');
                onRegistered?.();
            }).catch(() => { submit.disabled = false; onFeedback('角色登记未完成，未展示底层错误。'); });
        } catch (error) { onFeedback(projectCharacterTemplateError(error).message); }
    }, signal);

    renderLibrary();
    return section;
}

