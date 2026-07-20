import { projectImageLibraryError } from './image-library-store.js';

const ACCEPTED_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
const LONG_PRESS_DELAY_MS = 550;

function noop() {}

function safeCallback(callback, value) {
    try { callback(value); } catch { /* host callbacks must not break the panel */ }
}

function createElement(documentRef, tagName, { className = '', text = null, type = '', name = '', value = '', hidden = false } = {}) {
    const node = documentRef.createElement(tagName);
    if (className) node.className = className;
    if (text !== null) node.textContent = String(text);
    if (type) node.setAttribute('type', type);
    if (name) node.setAttribute('name', name);
    if (value !== '') node.value = String(value);
    node.hidden = Boolean(hidden);
    return node;
}

function sourceUrl(source) {
    if (!source || typeof source !== 'object') return '';
    if (source.kind === 'url' && typeof source.url === 'string' && /^https?:\/\/[^\s<>]+$/iu.test(source.url)) {
        return source.url;
    }
    if (source.kind === 'embedded' && typeof source.dataUrl === 'string'
        && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/iu.test(source.dataUrl)) {
        return source.dataUrl;
    }
    return '';
}

function normalizeCompressedImage(result) {
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object' && result.kind === 'embedded' && typeof result.dataUrl === 'string') {
        return result.dataUrl;
    }
    throw new TypeError('image_manager_compression_result_invalid');
}

function validateRemoteUrl(value) {
    const text = String(value ?? '').trim();
    try {
        const parsed = new URL(text);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('invalid protocol');
        return parsed.href;
    } catch {
        throw new TypeError('image_manager_url_invalid');
    }
}

function parseKeywordRows(rowsContainer) {
    const rows = rowsContainer.querySelectorAll('.yl-image-keyword-row');
    const output = [];
    const seen = new Set();
    for (const row of rows) {
        const inputs = Array.from(row.querySelectorAll('input'));
        const keywordInput = inputs.find((input) => input.dataset.role === 'keyword');
        const weightInput = inputs.find((input) => input.dataset.role === 'weight');
        const keyword = String(keywordInput?.value ?? '').trim();
        const rawWeight = String(weightInput?.value ?? '').trim();
        if (!keyword && !rawWeight) continue;
        if (!keyword || [...keyword].length > 40) throw new TypeError('image_manager_keyword_invalid');
        const weight = Number(rawWeight);
        if (!Number.isInteger(weight) || weight < -5 || weight > 5) throw new TypeError('image_manager_weight_invalid');
        const folded = keyword.normalize('NFKC').toLowerCase();
        if (seen.has(folded)) throw new TypeError('image_manager_keyword_duplicate');
        seen.add(folded);
        output.push({ keyword, weight });
    }
    return output;
}

function feedbackMessage(error) {
    if (error?.message === 'image_manager_url_invalid') return '请输入有效的 HTTP/HTTPS 图片链接。';
    if (error?.message === 'image_manager_file_type_invalid') return '本地图片仅支持 PNG、JPEG 或 WebP。';
    if (error?.message === 'image_manager_compression_unavailable') return '当前页面无法压缩本地图片。';
    if (error?.message === 'image_manager_compression_result_invalid') return '本地图片压缩结果无效，未保存图片。';
    if (error?.message === 'image_manager_keyword_invalid') return '关键词不能为空，且每项不能超过 40 个字符。';
    if (error?.message === 'image_manager_weight_invalid') return '关键词权重必须是 -5 到 5 的整数。';
    if (error?.message === 'image_manager_keyword_duplicate') return '同一张图片不能包含重复关键词。';
    return projectImageLibraryError(error).message;
}

/**
 * Browser-local image library manager.
 *
 * The panel owns no persistence and performs no network request. Remote URLs are
 * handed to the injected image library and displayed only as browser image sources.
 */
export function createImageManagerPanel({
    documentRef,
    imageLibrary,
    compressImageFile,
    onFeedback = noop,
    onChange = noop,
} = {}) {
    if (!documentRef || typeof documentRef.createElement !== 'function') {
        throw new TypeError('image_manager_document_invalid');
    }
    if (!imageLibrary || ['list', 'add', 'update', 'remove'].some((method) => typeof imageLibrary[method] !== 'function')) {
        throw new TypeError('image_manager_library_invalid');
    }
    if (typeof onFeedback !== 'function' || typeof onChange !== 'function') {
        throw new TypeError('image_manager_callback_invalid');
    }

    const controller = new AbortController();
    const { signal } = controller;
    let disposed = false;
    let records = [];
    let activeImageId = null;
    let longPressTimer = null;
    let suppressedClickImageId = null;
    let suppressedClickTimer = null;
    let operationTail = Promise.resolve();

    const element = createElement(documentRef, 'section', { className: 'yl-image-manager' });
    const heading = createElement(documentRef, 'header', { className: 'yl-image-manager-heading' });
    heading.appendChild(createElement(documentRef, 'h2', { className: 'yl-image-manager-title', text: '图片管理' }));
    heading.appendChild(createElement(documentRef, 'p', {
        className: 'yl-image-manager-description',
        text: '上传本地图片或导入图片链接，并为每张图片设置用于角色匹配的关键词权重。',
    }));

    const intake = createElement(documentRef, 'div', { className: 'yl-image-manager-intake' });
    const fileLabel = createElement(documentRef, 'label', { className: 'yl-image-manager-file-label' });
    fileLabel.appendChild(createElement(documentRef, 'span', { text: '上传本地图片' }));
    const fileInput = createElement(documentRef, 'input', { type: 'file', name: 'image-file' });
    fileInput.setAttribute('accept', ACCEPTED_IMAGE_TYPES.join(','));
    fileLabel.appendChild(fileInput);

    const urlGroup = createElement(documentRef, 'div', { className: 'yl-image-manager-url-group' });
    const urlInput = createElement(documentRef, 'input', { type: 'url', name: 'image-url' });
    urlInput.setAttribute('placeholder', 'https://example.com/image.webp');
    urlInput.setAttribute('autocomplete', 'off');
    const urlButton = createElement(documentRef, 'button', { type: 'button', className: 'yl-image-manager-url-button', text: '导入图片链接' });
    urlGroup.appendChild(urlInput);
    urlGroup.appendChild(urlButton);
    intake.appendChild(fileLabel);
    intake.appendChild(urlGroup);

    const status = createElement(documentRef, 'p', { className: 'yl-image-manager-status', text: '正在读取图片库…' });
    status.setAttribute('aria-live', 'polite');
    const grid = createElement(documentRef, 'div', { className: 'yl-image-manager-grid' });

    const contextMenu = createElement(documentRef, 'div', { className: 'yl-image-context-menu', hidden: true });
    contextMenu.setAttribute('role', 'menu');
    const editMenuButton = createElement(documentRef, 'button', { type: 'button', className: 'yl-image-context-action', text: '编辑匹配关键词' });
    editMenuButton.setAttribute('role', 'menuitem');
    contextMenu.appendChild(editMenuButton);

    const editorBackdrop = createElement(documentRef, 'div', { className: 'yl-image-keyword-backdrop', hidden: true });
    const editor = createElement(documentRef, 'section', { className: 'yl-image-keyword-editor' });
    editor.setAttribute('role', 'dialog');
    editor.setAttribute('aria-modal', 'true');
    editor.setAttribute('aria-label', '编辑图片匹配关键词');
    const editorHeader = createElement(documentRef, 'header', { className: 'yl-image-keyword-editor-heading' });
    editorHeader.appendChild(createElement(documentRef, 'h3', { text: '编辑匹配关键词' }));
    editorHeader.appendChild(createElement(documentRef, 'p', { text: '关键词描述图片适合的角色特征；权重为 -5 到 5 的整数。' }));
    const editorPreview = createElement(documentRef, 'div', { className: 'yl-image-keyword-editor-preview' });
    const keywordRows = createElement(documentRef, 'div', { className: 'yl-image-keyword-rows' });
    const addKeywordButton = createElement(documentRef, 'button', { type: 'button', className: 'yl-image-keyword-add', text: '添加关键词' });
    const editorActions = createElement(documentRef, 'footer', { className: 'yl-image-keyword-actions' });
    const deleteButton = createElement(documentRef, 'button', { type: 'button', className: 'yl-image-delete-button', text: '删除图片' });
    const cancelButton = createElement(documentRef, 'button', { type: 'button', className: 'yl-image-keyword-cancel', text: '取消' });
    const saveButton = createElement(documentRef, 'button', { type: 'button', className: 'yl-image-keyword-save', text: '保存关键词' });
    editorActions.appendChild(deleteButton);
    editorActions.appendChild(cancelButton);
    editorActions.appendChild(saveButton);
    editor.appendChild(editorHeader);
    editor.appendChild(editorPreview);
    editor.appendChild(keywordRows);
    editor.appendChild(addKeywordButton);
    editor.appendChild(editorActions);
    editorBackdrop.appendChild(editor);

    element.appendChild(heading);
    element.appendChild(intake);
    element.appendChild(status);
    element.appendChild(grid);
    element.appendChild(contextMenu);
    element.appendChild(editorBackdrop);

    function report(message) {
        if (!disposed) safeCallback(onFeedback, String(message));
    }

    function notify(type, image) {
        if (disposed) return;
        safeCallback(onChange, Object.freeze({ type, image: image ?? null, images: records }));
    }

    function listen(target, eventName, handler) {
        target.addEventListener(eventName, handler, { signal });
    }

    function setBusy(isBusy, message = '') {
        fileInput.disabled = isBusy;
        urlInput.disabled = isBusy;
        urlButton.disabled = isBusy;
        saveButton.disabled = isBusy;
        deleteButton.disabled = isBusy;
        if (message) status.textContent = message;
    }

    function closeContextMenu() {
        activeImageId = editorBackdrop.hidden ? null : activeImageId;
        contextMenu.hidden = true;
        delete contextMenu.dataset.imageId;
    }

    function clearLongPress() {
        if (longPressTimer !== null) {
            globalThis.clearTimeout(longPressTimer);
            longPressTimer = null;
        }
    }

    function clearSuppressedClick() {
        if (suppressedClickTimer !== null) globalThis.clearTimeout(suppressedClickTimer);
        suppressedClickTimer = null;
        suppressedClickImageId = null;
    }

    function sourceLabel(record) {
        return record.source.kind === 'embedded' ? '本地图片' : '远程图片';
    }

    function keywordSummary(record) {
        if (!record.keywordWeights.length) return '尚未设置匹配关键词';
        return record.keywordWeights.map(({ keyword, weight }) => `${keyword} ${weight > 0 ? '+' : ''}${weight}`).join(' · ');
    }

    function openContextMenu(record, event = null) {
        activeImageId = record.id;
        contextMenu.dataset.imageId = record.id;
        contextMenu.hidden = false;
        if (contextMenu.style && event) {
            const x = Number(event.clientX);
            const y = Number(event.clientY);
            if (Number.isFinite(x)) contextMenu.style.left = `${Math.max(0, x)}px`;
            if (Number.isFinite(y)) contextMenu.style.top = `${Math.max(0, y)}px`;
        }
    }

    function makePreview(record, className) {
        const box = createElement(documentRef, 'div', { className });
        const loading = createElement(documentRef, 'span', { className: 'yl-image-preview-state', text: '图片加载中…' });
        const image = createElement(documentRef, 'img', { className: 'yl-image-preview' });
        image.setAttribute('alt', `${sourceLabel(record)}预览`);
        image.setAttribute('loading', 'lazy');
        image.setAttribute('referrerpolicy', 'no-referrer');
        const source = sourceUrl(record.source);
        if (source) image.setAttribute('src', source);
        else loading.textContent = '图片来源无效';
        listen(image, 'load', () => {
            loading.textContent = '';
            loading.hidden = true;
            box.classList?.toggle('is-load-failed', false);
        });
        listen(image, 'error', () => {
            loading.hidden = false;
            loading.textContent = '图片加载失败';
            box.classList?.toggle('is-load-failed', true);
        });
        box.appendChild(image);
        box.appendChild(loading);
        return box;
    }

    function renderGrid() {
        grid.replaceChildren();
        if (records.length === 0) {
            const empty = createElement(documentRef, 'div', { className: 'yl-image-manager-empty' });
            empty.appendChild(createElement(documentRef, 'strong', { text: '图片库还是空的' }));
            empty.appendChild(createElement(documentRef, 'p', { text: '上传本地图片或导入一个 HTTP/HTTPS 图片链接后，预览会显示在这里。' }));
            grid.appendChild(empty);
            status.textContent = '当前没有图片。';
            return;
        }

        status.textContent = `已保存 ${records.length} 张图片。右键图片或在移动端长按可编辑匹配关键词。`;
        for (const record of records) {
            const card = createElement(documentRef, 'article', { className: 'yl-image-card' });
            card.dataset.imageId = record.id;
            card.setAttribute('tabindex', '0');
            card.setAttribute('aria-label', `${sourceLabel(record)}，${keywordSummary(record)}`);
            card.appendChild(makePreview(record, 'yl-image-card-preview'));
            const meta = createElement(documentRef, 'div', { className: 'yl-image-card-meta' });
            meta.appendChild(createElement(documentRef, 'strong', { text: sourceLabel(record) }));
            meta.appendChild(createElement(documentRef, 'p', { className: 'yl-image-card-keywords', text: keywordSummary(record) }));
            card.appendChild(meta);

            listen(card, 'contextmenu', (event) => {
                event.preventDefault();
                clearLongPress();
                openContextMenu(record, event);
            });
            listen(card, 'pointerdown', (event) => {
                clearLongPress();
                if (event.pointerType === 'mouse') return;
                longPressTimer = globalThis.setTimeout(() => {
                    longPressTimer = null;
                    suppressedClickImageId = record.id;
                    if (suppressedClickTimer !== null) globalThis.clearTimeout(suppressedClickTimer);
                    suppressedClickTimer = globalThis.setTimeout(clearSuppressedClick, LONG_PRESS_DELAY_MS + 500);
                    openContextMenu(record, event);
                }, LONG_PRESS_DELAY_MS);
            });
            for (const eventName of ['pointerup', 'pointercancel', 'pointerleave']) {
                listen(card, eventName, clearLongPress);
            }
            listen(card, 'click', (event) => {
                if (suppressedClickImageId !== record.id) return;
                event.preventDefault();
                event.stopPropagation();
                clearSuppressedClick();
            });
            listen(card, 'keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                openEditor(record);
            });
            grid.appendChild(card);
        }
    }

    function addKeywordRow(keyword = '', weight = 0) {
        const row = createElement(documentRef, 'div', { className: 'yl-image-keyword-row' });
        const keywordInput = createElement(documentRef, 'input', { type: 'text', value: keyword });
        keywordInput.dataset.role = 'keyword';
        keywordInput.setAttribute('placeholder', '例如：温柔、夜景、运动');
        keywordInput.setAttribute('maxlength', '40');
        const weightInput = createElement(documentRef, 'input', { type: 'number', value: String(weight) });
        weightInput.dataset.role = 'weight';
        weightInput.setAttribute('min', '-5');
        weightInput.setAttribute('max', '5');
        weightInput.setAttribute('step', '1');
        weightInput.setAttribute('inputmode', 'numeric');
        const removeButton = createElement(documentRef, 'button', { type: 'button', className: 'yl-image-keyword-remove', text: '移除' });
        listen(removeButton, 'click', () => row.remove());
        row.appendChild(keywordInput);
        row.appendChild(weightInput);
        row.appendChild(removeButton);
        keywordRows.appendChild(row);
    }

    function closeEditor() {
        editorBackdrop.hidden = true;
        activeImageId = null;
        keywordRows.replaceChildren();
        editorPreview.replaceChildren();
    }

    function handleEscape() {
        const wasOpen = !editorBackdrop.hidden || !contextMenu.hidden;
        if (!wasOpen) return false;
        clearLongPress();
        if (!editorBackdrop.hidden) closeEditor();
        closeContextMenu();
        return true;
    }

    function openEditor(record) {
        closeContextMenu();
        activeImageId = record.id;
        keywordRows.replaceChildren();
        editorPreview.replaceChildren(makePreview(record, 'yl-image-keyword-preview-frame'));
        for (const entry of record.keywordWeights) addKeywordRow(entry.keyword, entry.weight);
        if (record.keywordWeights.length === 0) addKeywordRow('', 0);
        editorBackdrop.hidden = false;
    }

    function enqueueOperation(action) {
        const result = operationTail.then(action, action);
        operationTail = result.then(noop, noop);
        return result;
    }

    async function reload() {
        const next = await imageLibrary.list();
        if (disposed) return;
        records = Array.isArray(next) ? next : [];
        renderGrid();
    }

    async function completeMutation(type, image, successMessage) {
        await reload();
        if (disposed) return;
        report(successMessage);
        notify(type, image);
    }

    listen(fileInput, 'change', () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        void enqueueOperation(async () => {
            setBusy(true, '正在压缩并保存本地图片…');
            try {
                if (!ACCEPTED_IMAGE_TYPES.includes(String(file.type ?? '').toLowerCase())) {
                    throw new TypeError('image_manager_file_type_invalid');
                }
                if (typeof compressImageFile !== 'function') throw new TypeError('image_manager_compression_unavailable');
                const dataUrl = normalizeCompressedImage(await compressImageFile(file));
                const added = await imageLibrary.add({ source: { kind: 'embedded', dataUrl }, keywordWeights: [] });
                fileInput.value = '';
                await completeMutation('add', added, '本地图片已压缩并保存到图片库。');
            } catch (error) {
                status.textContent = '本地图片未保存。';
                report(feedbackMessage(error));
            } finally {
                if (!disposed) setBusy(false);
            }
        });
    });

    listen(urlButton, 'click', () => {
        void enqueueOperation(async () => {
            setBusy(true, '正在保存远程图片链接…');
            try {
                const url = validateRemoteUrl(urlInput.value);
                const added = await imageLibrary.add({ source: { kind: 'url', url }, keywordWeights: [] });
                urlInput.value = '';
                await completeMutation('add', added, '图片链接已保存；若远程站点拒绝加载，预览会显示失败状态。');
            } catch (error) {
                status.textContent = '图片链接未保存。';
                report(feedbackMessage(error));
            } finally {
                if (!disposed) setBusy(false);
            }
        });
    });

    listen(urlInput, 'keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        urlButton.dispatchEvent(new Event('click'));
    });

    listen(editMenuButton, 'click', () => {
        const record = records.find((item) => item.id === contextMenu.dataset.imageId || item.id === activeImageId);
        if (record) openEditor(record);
    });

    listen(addKeywordButton, 'click', () => addKeywordRow('', 0));
    listen(cancelButton, 'click', closeEditor);
    listen(editorBackdrop, 'click', (event) => {
        if (event.target === editorBackdrop) closeEditor();
    });

    listen(saveButton, 'click', () => {
        const imageId = activeImageId;
        if (!imageId) return;
        void enqueueOperation(async () => {
            setBusy(true, '正在保存关键词权重…');
            try {
                const keywordWeights = parseKeywordRows(keywordRows);
                const updated = await imageLibrary.update(imageId, { keywordWeights });
                closeEditor();
                await completeMutation('update', updated, '图片匹配关键词已保存。');
            } catch (error) {
                status.textContent = '关键词权重未保存。';
                report(feedbackMessage(error));
            } finally {
                if (!disposed) setBusy(false);
            }
        });
    });

    listen(deleteButton, 'click', () => {
        const imageId = activeImageId;
        if (!imageId) return;
        void enqueueOperation(async () => {
            setBusy(true, '正在删除图片…');
            try {
                const removed = await imageLibrary.remove(imageId);
                closeEditor();
                await completeMutation('remove', removed, '图片已从本地图片库删除。');
            } catch (error) {
                status.textContent = '图片未删除。';
                report(feedbackMessage(error));
            } finally {
                if (!disposed) setBusy(false);
            }
        });
    });

    listen(documentRef, 'click', (event) => {
        if (contextMenu.hidden) return;
        if (event.target === contextMenu || event.target === editMenuButton) return;
        closeContextMenu();
    });
    listen(documentRef, 'keydown', (event) => {
        if (event.key === 'Escape') handleEscape();
    });

    void reload().catch((error) => {
        if (disposed) return;
        records = [];
        grid.replaceChildren(createElement(documentRef, 'div', { className: 'yl-image-manager-empty', text: '图片库读取失败。' }));
        status.textContent = '图片库读取失败。';
        report(feedbackMessage(error));
    });

    return Object.freeze({
        element,
        node: element,
        panel: element,
        closeEditor,
        handleEscape,
        dispose() {
            if (disposed) return;
            disposed = true;
            clearLongPress();
            clearSuppressedClick();
            controller.abort();
            element.remove();
        },
    });
}





