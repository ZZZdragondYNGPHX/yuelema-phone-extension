import { append, element, listen } from '../dom.js';
import { createUiIcon } from '../ui/icon.js';

const TEXT_LIMITS = Object.freeze({
    昵称: 80,
    年龄段: 32,
    性别: 48,
    性取向: 80,
    城市: 80,
    距离范围: 48,
    寻找意图: 120,
    简介: 500,
});
const TAG_FIELDS = Object.freeze(['兴趣标签', '生活方式标签', '性格标签', '沟通风格标签']);
const STEPS = Object.freeze([
    Object.freeze({ eyebrow: '连接已建立', title: '先让这座城市认识你', copy: '用几分钟写下你愿意公开的样子。之后的推荐、匹配和聊天，都会从这里开始。' }),
    Object.freeze({ eyebrow: '01 / 基本资料', title: '留下一张好认的名片', copy: '只填写公开资料。你的实际年龄、隐私和关系数据不会出现在这里。' }),
    Object.freeze({ eyebrow: '02 / 相遇方向', title: '告诉我们你想遇见谁', copy: '性别与性取向会用于双方兼容性判断；请按自己的真实想法填写。' }),
    Object.freeze({ eyebrow: '03 / 生活信号', title: '让同频的人更容易找到你', copy: '用一句简介和几组标签，留下能被自然聊起的线索。' }),
    Object.freeze({ eyebrow: '04 / 确认公开', title: '这是将要展示的你', copy: '确认后只会写入公开资料；不会读取、推断或覆盖任何私密层。' }),
]);

function cleanText(value, maxLength) {
    const text = String(value ?? '').trim().replace(/[\u0000-\u001f\u007f]/gu, '');
    return text.slice(0, maxLength);
}

export function parseOnboardingTags(value) {
    const values = Array.isArray(value) ? value : String(value ?? '').split(/[，,]/u);
    const tags = [];
    for (const raw of values) {
        const tag = cleanText(raw, 32);
        if (tag && !tags.includes(tag)) tags.push(tag);
        if (tags.length >= 12) break;
    }
    return tags;
}

export function createOnboardingProfileDraft(source = {}) {
    const draft = {};
    for (const [field, maxLength] of Object.entries(TEXT_LIMITS)) draft[field] = cleanText(source[field], maxLength);
    for (const field of TAG_FIELDS) draft[field] = parseOnboardingTags(source[field]);
    return draft;
}

export function onboardingProfilePayload(draft) {
    const normalized = createOnboardingProfileDraft(draft);
    return Object.freeze({ 头像引用: '', ...normalized });
}

function hasText(draft, fields) {
    return fields.every((field) => Boolean(cleanText(draft[field], TEXT_LIMITS[field])));
}

export function onboardingStepIssue(step, draft) {
    if (step === 1 && !hasText(draft, ['昵称', '年龄段', '城市'])) return '请填写昵称、公开年龄段和所在城市后继续。';
    if (step === 2 && !hasText(draft, ['性别', '性取向', '距离范围', '寻找意图'])) return '请补全性别、性取向、距离范围和寻找意图。';
    if (step === 3) {
        if (!cleanText(draft.简介, TEXT_LIMITS.简介)) return '写一句公开简介，让别人知道怎样和你打开话题。';
        if (!Array.isArray(draft.兴趣标签) || draft.兴趣标签.length === 0) return '至少添加一个兴趣标签，推荐才有可以回应的生活线索。';
    }
    return '';
}

function profileChanged(source, payload) {
    for (const [field] of Object.entries(TEXT_LIMITS)) if (cleanText(source[field], TEXT_LIMITS[field]) !== payload[field]) return true;
    for (const field of TAG_FIELDS) if (JSON.stringify(parseOnboardingTags(source[field])) !== JSON.stringify(payload[field])) return true;
    return false;
}

function createOption(value, label = value) {
    return element('option', { value, text: label });
}

function addSelectOptions(select, options, value) {
    for (const [optionValue, optionLabel] of options) select.appendChild(createOption(optionValue, optionLabel));
    select.value = value;
}

function field(labelText, control, hint = '') {
    const label = element('label', { className: 'yl-onboarding-field' });
    label.appendChild(element('span', { className: 'yl-onboarding-field-label', text: labelText }));
    label.appendChild(control);
    if (hint) label.appendChild(element('small', { className: 'yl-onboarding-field-hint', text: hint }));
    return label;
}

function textInput(labelText, key, draft, maxLength, placeholder = '') {
    const input = element('input', {
        className: 'yl-settings-control yl-onboarding-control', type: 'text', name: `onboarding-${key}`,
        value: draft[key], maxLength, placeholder, autocomplete: key === '昵称' ? 'nickname' : 'off',
    });
    return [input, field(labelText, input)];
}

function tagInput(labelText, key, draft, hint) {
    const input = element('input', {
        className: 'yl-settings-control yl-onboarding-control', type: 'text', name: `onboarding-${key}`,
        value: draft[key].join('，'), maxLength: 240, placeholder: '用逗号分开，例如：电影，夜跑', autocomplete: 'off',
    });
    return [input, field(labelText, input, hint)];
}

function focusableNodes(root) {
    return ['button', 'input', 'select', 'textarea']
        .flatMap((selector) => [...root.querySelectorAll(selector)])
        .filter((node) => !node.disabled && !node.hidden);
}

/**
 * A browser-memory-only profile onboarding controller. It never reads raw MVU
 * state and it delegates the sole persistent write to `saveProfile`.
 */
export function createOnboardingFlow({ documentRef, root, signal, saveProfile, onComplete, onDismiss, describeFailure = () => '公开资料暂未保存，请稍后重试。' }) {
    let visible = false;
    let step = 0;
    let sourceProfile = null;
    let draft = null;
    let saving = false;
    let issue = '';

    root.classList.add('yl-onboarding');
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '开局个人资料引导');

    function hide({ reset = false } = {}) {
        visible = false;
        root.hidden = true;
        if (reset) { step = 0; sourceProfile = null; draft = null; issue = ''; saving = false; }
    }

    function dismiss() {
        hide();
        onDismiss?.();
    }

    function updateText(key, value) {
        draft[key] = cleanText(value, TEXT_LIMITS[key]);
    }

    function renderIntro(body) {
        const hero = element('div', { className: 'yl-onboarding-hero' });
        const signalArt = element('div', { className: 'yl-onboarding-signal-art' });
        signalArt.setAttribute('aria-hidden', 'true');
        const orbit = element('div', { className: 'yl-onboarding-orbit' });
        for (let index = 0; index < 3; index += 1) orbit.appendChild(element('span', { className: 'yl-onboarding-orbit-dot' }));
        const skyline = element('div', { className: 'yl-onboarding-skyline' });
        for (let index = 0; index < 7; index += 1) skyline.appendChild(element('span', { className: 'yl-onboarding-building' }));
        signalArt.appendChild(orbit);
        signalArt.appendChild(createUiIcon(documentRef, 'logo', { className: 'yl-onboarding-logo', size: 56, strokeWidth: 1.55 }));
        signalArt.appendChild(skyline);
        append(hero, [signalArt, element('p', { className: 'yl-onboarding-hero-note', text: '城市信号已上线 · 只需公开你愿意分享的部分' })]);
        body.appendChild(hero);
    }

    function renderIdentity(body) {
        const grid = element('div', { className: 'yl-onboarding-form yl-onboarding-form--identity' });
        const [nicknameInput, nicknameField] = textInput('怎么称呼你', '昵称', draft, TEXT_LIMITS.昵称, '例如：林澈');
        const age = element('select', { className: 'yl-settings-control yl-onboarding-control', name: 'onboarding-年龄段', ariaLabel: '公开年龄段' });
        addSelectOptions(age, [['', '选择公开年龄段'], ['18-20', '18–20'], ['21-24', '21–24'], ['25-29', '25–29'], ['30-34', '30–34'], ['35-39', '35–39'], ['40+', '40+']], draft.年龄段);
        const [cityInput, cityField] = textInput('你在哪座城市', '城市', draft, TEXT_LIMITS.城市, '例如：上海');
        append(grid, [nicknameField, field('公开年龄段', age, '仅显示年龄段；不会展示实际年龄。'), cityField]);
        listen(nicknameInput, nicknameInput, 'input', () => updateText('昵称', nicknameInput.value), signal);
        listen(age, age, 'change', () => updateText('年龄段', age.value), signal);
        listen(cityInput, cityInput, 'input', () => updateText('城市', cityInput.value), signal);
        body.appendChild(grid);
    }

    function renderDirection(body) {
        const grid = element('div', { className: 'yl-onboarding-form yl-onboarding-form--direction' });
        const gender = element('select', { className: 'yl-settings-control yl-onboarding-control', name: 'onboarding-性别', ariaLabel: '性别' });
        addSelectOptions(gender, [['', '选择性别'], ['女', '女'], ['男', '男'], ['非二元', '非二元'], ['其他', '其他']], draft.性别);
        const orientation = element('select', { className: 'yl-settings-control yl-onboarding-control', name: 'onboarding-性取向', ariaLabel: '性取向' });
        addSelectOptions(orientation, [['', '选择性取向'], ['异性恋', '异性恋'], ['同性恋', '同性恋'], ['双性恋', '双性恋'], ['泛性恋', '泛性恋'], ['无性恋', '无性恋'], ['其他', '其他']], draft.性取向);
        const [distanceInput, distanceField] = textInput('愿意相遇的距离', '距离范围', draft, TEXT_LIMITS.距离范围, '例如：同城 / 10 km');
        const [intentInput, intentField] = textInput('这次想寻找什么', '寻找意图', draft, TEXT_LIMITS.寻找意图, '例如：先聊天，再认真约会');
        append(grid, [field('性别', gender), field('性取向', orientation, '这会用于双方兼容性判断，不会对外展示额外解释。'), distanceField, intentField]);
        listen(gender, gender, 'change', () => updateText('性别', gender.value), signal);
        listen(orientation, orientation, 'change', () => updateText('性取向', orientation.value), signal);
        listen(distanceInput, distanceInput, 'input', () => updateText('距离范围', distanceInput.value), signal);
        listen(intentInput, intentInput, 'input', () => updateText('寻找意图', intentInput.value), signal);
        body.appendChild(grid);
    }

    function renderVibe(body) {
        const form = element('div', { className: 'yl-onboarding-form yl-onboarding-form--vibe' });
        const bio = element('textarea', { className: 'yl-settings-control yl-settings-textarea yl-onboarding-control', name: 'onboarding-简介', rows: 4, maxLength: TEXT_LIMITS.简介, placeholder: '用一句自然的话，让人知道怎样和你打开话题。', value: draft.简介 });
        append(form, [field('一句公开简介', bio, '只会展示在公开资料中。')]);
        listen(bio, bio, 'input', () => updateText('简介', bio.value), signal);
        for (const [key, label, hint] of [
            ['兴趣标签', '兴趣标签', '至少填写一个。'],
            ['生活方式标签', '生活方式', '例如：早睡、常旅行、养猫。'],
            ['性格标签', '性格标签', '例如：慢热、直接、好奇。'],
            ['沟通风格标签', '沟通风格', '例如：语音派、消息有空就回。'],
        ]) {
            const [input, inputField] = tagInput(label, key, draft, hint);
            listen(input, input, 'input', () => { draft[key] = parseOnboardingTags(input.value); }, signal);
            form.appendChild(inputField);
        }
        body.appendChild(form);
    }

    function reviewLine(label, value) {
        const row = element('div', { className: 'yl-onboarding-review-line' });
        row.appendChild(element('span', { text: label }));
        row.appendChild(element('strong', { text: value || '未填写' }));
        return row;
    }

    function renderReview(body) {
        const payload = onboardingProfilePayload(draft);
        const card = element('article', { className: 'yl-onboarding-review-card' });
        const identity = element('div', { className: 'yl-onboarding-review-identity' });
        const initial = payload.昵称.slice(0, 1) || '我';
        const identityCopy = element('div', { className: 'yl-onboarding-review-identity-copy' });
        append(identity, [element('span', { className: 'yl-onboarding-review-avatar', text: initial }), identityCopy]);
        append(identityCopy, [element('strong', { text: payload.昵称 || '未命名的你' }), element('span', { text: [payload.年龄段, payload.城市].filter(Boolean).join(' · ') || '公开资料' })]);
        card.appendChild(identity);
        if (payload.简介) card.appendChild(element('p', { className: 'yl-onboarding-review-bio', text: payload.简介 }));
        const details = element('div', { className: 'yl-onboarding-review-details' });
        append(details, [reviewLine('相遇方向', payload.寻找意图), reviewLine('距离范围', payload.距离范围), reviewLine('性别 / 性取向', [payload.性别, payload.性取向].filter(Boolean).join(' / '))]);
        card.appendChild(details);
        const tags = [...payload.兴趣标签, ...payload.生活方式标签, ...payload.性格标签, ...payload.沟通风格标签];
        if (tags.length) {
            const tagList = element('div', { className: 'yl-onboarding-review-tags', ariaLabel: '公开标签' });
            for (const tag of tags) tagList.appendChild(element('span', { text: `# ${tag}` }));
            card.appendChild(tagList);
        }
        body.appendChild(card);
        if (!profileChanged(sourceProfile, payload)) body.appendChild(element('p', { className: 'yl-onboarding-inline-note', text: '请至少修改一项公开资料后再开启。这样系统才能完成安全建档，而不会进行只有状态标记的写入。' }));
    }

    function render() {
        if (!visible || !draft) return;
        const config = STEPS[step];
        root.hidden = false;
        root.replaceChildren();
        root.dataset.step = String(step + 1);
        const shell = element('section', { className: 'yl-onboarding-shell' });
        const top = element('header', { className: 'yl-onboarding-top' });
        const progress = element('div', { className: 'yl-onboarding-progress', ariaLabel: `建档进度，第 ${step + 1} 步，共 ${STEPS.length} 步` });
        for (let index = 0; index < STEPS.length; index += 1) {
            const marker = element('span', { className: `yl-onboarding-progress-dot${index === step ? ' is-active' : ''}${index < step ? ' is-complete' : ''}`, text: String(index + 1) });
            marker.setAttribute('aria-current', index === step ? 'step' : 'false');
            progress.appendChild(marker);
        }
        top.appendChild(progress);
        if (step > 0) {
            const later = element('button', { className: 'yl-onboarding-later', type: 'button', text: '稍后填写' });
            listen(later, later, 'click', dismiss, signal);
            top.appendChild(later);
        }
        const body = element('div', { className: 'yl-onboarding-body' });
        append(body, [element('p', { className: 'yl-onboarding-eyebrow', text: config.eyebrow }), element('h2', { text: config.title }), element('p', { className: 'yl-onboarding-copy', text: config.copy })]);
        if (step === 0) renderIntro(body);
        else if (step === 1) renderIdentity(body);
        else if (step === 2) renderDirection(body);
        else if (step === 3) renderVibe(body);
        else renderReview(body);

        const status = element('p', { className: 'yl-onboarding-validation', text: issue });
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        const actions = element('footer', { className: 'yl-onboarding-actions' });
        if (step > 0) {
            const back = element('button', { className: 'yl-onboarding-back', type: 'button', text: '上一步', disabled: saving });
            listen(back, back, 'click', () => { if (!saving) { issue = ''; step -= 1; render(); } }, signal);
            actions.appendChild(back);
        } else {
            const later = element('button', { className: 'yl-onboarding-back', type: 'button', text: '稍后填写' });
            listen(later, later, 'click', dismiss, signal);
            actions.appendChild(later);
        }
        const primaryLabel = step === 0 ? '开始建档' : (step === STEPS.length - 1 ? (saving ? '正在保存…' : '保存并开启') : '继续');
        const primary = element('button', { className: 'yl-onboarding-primary', type: 'button', text: primaryLabel, disabled: saving });
        listen(primary, primary, 'click', () => { void advance(); }, signal);
        actions.appendChild(primary);
        append(shell, [top, body, status, actions]);
        root.appendChild(shell);
        const focusTarget = step === 0 ? primary : (body.querySelector('input') ?? body.querySelector('select') ?? body.querySelector('textarea') ?? primary);
        focusTarget?.focus?.();
    }

    async function advance() {
        if (saving) return;
        if (step < STEPS.length - 1) {
            issue = onboardingStepIssue(step, draft);
            if (issue) { render(); return; }
            issue = '';
            step += 1;
            render();
            return;
        }
        const validation = onboardingStepIssue(1, draft) || onboardingStepIssue(2, draft) || onboardingStepIssue(3, draft);
        if (validation) { issue = validation; render(); return; }
        const payload = onboardingProfilePayload(draft);
        if (!profileChanged(sourceProfile, payload)) {
            issue = '请至少修改一项公开资料后再开启。';
            render();
            return;
        }
        saving = true;
        issue = '';
        render();
        let result;
        try { result = await saveProfile(payload); }
        catch { result = { ok: false }; }
        saving = false;
        if (result?.ok) {
            hide({ reset: true });
            onComplete?.(payload);
            return;
        }
        issue = result?.code === 'player_profile_no_change' ? '没有检测到公开资料变化；请修改至少一项后再保存。' : (result?.message || describeFailure(result));
        render();
    }

    listen(root, root, 'keydown', (event) => {
        if (!visible) return;
        if (event.key === 'Escape') { event.preventDefault?.(); event.stopPropagation?.(); dismiss(); return; }
        if (event.key !== 'Tab') return;
        const nodes = focusableNodes(root);
        if (!nodes.length) return;
        const active = documentRef.activeElement;
        const currentIndex = nodes.indexOf(active);
        const nextIndex = event.shiftKey ? (currentIndex <= 0 ? nodes.length - 1 : currentIndex - 1) : (currentIndex < 0 || currentIndex === nodes.length - 1 ? 0 : currentIndex + 1);
        event.preventDefault?.();
        nodes[nextIndex].focus?.();
    }, signal);

    return Object.freeze({
        show(profile) {
            if (!draft) { sourceProfile = createOnboardingProfileDraft(profile); draft = createOnboardingProfileDraft(profile); }
            visible = true;
            render();
            return true;
        },
        hide,
        dismiss,
        isVisible: () => visible,
        snapshot: () => Object.freeze({ step, visible, draft: draft ? onboardingProfilePayload(draft) : null }),
    });
}
