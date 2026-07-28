import {
    ImageLibraryError,
    MAX_IMAGE_LIBRARY_SERIALIZED_BYTES,
    normalizeEmbeddedImageDataUrl,
    projectImageLibraryError,
} from './image-library-store.js';
import { projectRemoteImportError } from './remote-image-import.js';
import { createButton } from '../ui/button.js';
import { createEmptyState } from '../ui/empty-state.js';
import { createSkeleton } from '../ui/skeleton.js';

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
    if (source.kind !== 'embedded' || typeof source.dataUrl !== 'string') return '';
    try {
        return normalizeEmbeddedImageDataUrl(source.dataUrl);
    } catch {
        return '';
    }
}

function normalizeCompressedImage(result) {
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object' && result.kind === 'embedded' && typeof result.dataUrl === 'string') {
        return result.dataUrl;
    }
    throw new TypeError('image_manager_compression_result_invalid');
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
 * The panel owns no persistence and performs no network request. Only validated
 * embedded PNG/JPEG/WebP data URLs may become browser image sources.
 *
 * `dialogController`（可选，app-shell 单例）负责关键词编辑弹窗的焦点陷阱、initialFocus
 * 与关闭回焦；不传时保持旧的 hidden 切换 + 面板自有 document Escape 降级行为。
 */
export function createImageManagerPanel({
    documentRef,
    imageLibrary,
    compressImageFile,
    onFeedback = noop,
    onChange = noop,
    onConfigure = noop,
    dialogController = null,
    openDialog = null,
    // 一次性链接导入能力（url → Blob）。未注入时不渲染任何链接入口；
    // 下载结果仍必须走注入压缩链变成 embedded data URL，URL 本身不落库。
    importRemoteImageFile = null,
    downloadImagePack = null,
} = {}) {
    if (!documentRef || typeof documentRef.createElement !== 'function') {
        throw new TypeError('image_manager_document_invalid');
    }
    if (!imageLibrary || ['list', 'add', 'update', 'remove'].some((method) => typeof imageLibrary[method] !== 'function')) {
        throw new TypeError('image_manager_library_invalid');
    }
    if (typeof onFeedback !== 'function' || typeof onChange !== 'function' || typeof onConfigure !== 'function') {
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
    const titlebar = createElement(documentRef, 'div', { className: 'yl-image-manager-titlebar yl-heading-with-help' });
    titlebar.appendChild(createElement(documentRef, 'h2', { className: 'yl-image-manager-title', text: '图片管理' }));
    const configureButton = createButton({ documentRef, variant: 'ghost', label: '设置', ariaLabel: '配置图片管理预设' });
    configureButton.classList.add('yl-feature-options', 'yl-image-manager-configure');
    titlebar.appendChild(configureButton);
    heading.appendChild(titlebar);
    heading.appendChild(createElement(documentRef, 'p', {
        className: 'yl-image-manager-description',
        text: '上传本地图片，并为每张图片设置用于角色匹配的关键词权重。',
    }));

    const intake = createElement(documentRef, 'div', { className: 'yl-image-manager-intake' });
    const fileLabel = createElement(documentRef, 'label', { className: 'yl-image-manager-file-label' });
    fileLabel.appendChild(createElement(documentRef, 'span', { text: '上传本地图片' }));
    const fileInput = createElement(documentRef, 'input', { type: 'file', name: 'image-file' });
    fileInput.setAttribute('accept', ACCEPTED_IMAGE_TYPES.join(','));
    fileLabel.appendChild(fileInput);

    intake.appendChild(fileLabel);

    const packTransfer = createElement(documentRef, 'div', { className: 'yl-image-pack-transfer' });
    const packImportLabel = createElement(documentRef, 'label', { className: 'yl-image-manager-file-label yl-image-pack-import-label' });
    packImportLabel.appendChild(createElement(documentRef, 'span', { text: '合并导入图包' }));
    const packInput = createElement(documentRef, 'input', { type: 'file', name: 'image-pack-file' });
    packInput.setAttribute('accept', 'application/json,.json');
    packImportLabel.appendChild(packInput);
    const packExportButton = createButton({ documentRef, variant: 'tonal', label: '导出完整图包' });
    packExportButton.classList.add('yl-image-pack-export');
    packTransfer.appendChild(packImportLabel);
    packTransfer.appendChild(packExportButton);
    intake.appendChild(packTransfer);
    intake.appendChild(createElement(documentRef, 'p', {
        className: 'yl-image-remote-import-hint',
        text: '图包包含图片与每张图片的关键词权重；导入只合并，不覆盖现有图片。',
    }));

    let remoteUrlInput = null;
    let remoteImportButton = null;
    if (typeof importRemoteImageFile === 'function') {
        const remoteRow = createElement(documentRef, 'div', { className: 'yl-image-remote-import' });
        remoteUrlInput = createElement(documentRef, 'input', { type: 'text', name: 'image-import-url' });
        remoteUrlInput.setAttribute('inputmode', 'url');
        remoteUrlInput.setAttribute('placeholder', 'https://…');
        remoteUrlInput.setAttribute('aria-label', '要导入的图片链接');
        remoteImportButton = createButton({ documentRef, variant: 'tonal', label: '下载并保存到图片库' });
        remoteImportButton.classList.add('yl-image-remote-import-button');
        remoteRow.appendChild(remoteUrlInput);
        remoteRow.appendChild(remoteImportButton);
        intake.appendChild(remoteRow);
        intake.appendChild(createElement(documentRef, 'p', { className: 'yl-image-remote-import-hint', text: '仅在点击时下载一次并压缩保存；链接本身不会被保存。' }));
    }

    const status = createElement(documentRef, 'p', { className: 'yl-image-manager-status', text: '正在读取图片库…' });
    status.setAttribute('aria-live', 'polite');
    const grid = createElement(documentRef, 'div', { className: 'yl-image-manager-grid' });
    // 初次读取的等待态：骨架屏占位（aria-hidden，读屏由上方 aria-live 状态行播报）；
    // 首次 renderGrid / 读取失败分支的 replaceChildren 会自然移除，无需额外清理逻辑。
    grid.appendChild(createSkeleton({ documentRef, variant: 'candidate-card', count: 3 }));

    // Disclosure 动作列表：不宣称 role=menu（无完整菜单键盘模型），Escape 与外点关闭生命周期保留。
    const contextMenu = createElement(documentRef, 'div', { className: 'yl-image-context-menu', hidden: true });
    contextMenu.setAttribute('aria-label', '图片操作');
    const editMenuButton = createButton({ documentRef, variant: 'ghost', label: '编辑匹配关键词' });
    editMenuButton.classList.add('yl-image-context-action');
    contextMenu.appendChild(editMenuButton);

    const editorBackdrop = createElement(documentRef, 'div', { className: 'yl-image-keyword-backdrop', hidden: true });
    const editor = createElement(documentRef, 'section', { className: 'yl-image-keyword-editor', hidden: true });
    editor.setAttribute('role', 'dialog');
    editor.setAttribute('aria-modal', 'true');
    editor.setAttribute('aria-label', '编辑图片匹配关键词');
    const editorHeader = createElement(documentRef, 'header', { className: 'yl-image-keyword-editor-heading' });
    editorHeader.appendChild(createElement(documentRef, 'h3', { text: '编辑匹配关键词' }));
    editorHeader.appendChild(createElement(documentRef, 'p', { text: '关键词描述图片适合的角色特征；权重为 -5 到 5 的整数。' }));
    const editorPreview = createElement(documentRef, 'div', { className: 'yl-image-keyword-editor-preview' });
    const keywordRows = createElement(documentRef, 'div', { className: 'yl-image-keyword-rows' });
    const addKeywordButton = createButton({ documentRef, variant: 'tonal', icon: 'plus', label: '添加关键词' });
    addKeywordButton.classList.add('yl-image-keyword-add');
    const editorActions = createElement(documentRef, 'footer', { className: 'yl-image-keyword-actions' });
    const deleteButton = createButton({ documentRef, variant: 'danger', label: '删除图片' });
    deleteButton.classList.add('yl-image-delete-button');
    const cancelButton = createButton({ documentRef, variant: 'ghost', label: '取消' });
    cancelButton.classList.add('yl-image-keyword-cancel');
    const saveButton = createButton({ documentRef, variant: 'primary', label: '保存关键词' });
    saveButton.classList.add('yl-image-keyword-save');
    editorActions.appendChild(deleteButton);
    editorActions.appendChild(cancelButton);
    editorActions.appendChild(saveButton);
    editor.appendChild(editorHeader);
    editor.appendChild(editorPreview);
    editor.appendChild(keywordRows);
    editor.appendChild(addKeywordButton);
    editor.appendChild(editorActions);
    editorBackdrop.appendChild(editor);

    // 说明、导入与状态收进同一侧栏容器：phone 保持原纵向阅读顺序，
    // desktop 工作台由 CSS 将其整体作为左列卡片，避免三块内容视觉散落。
    const side = createElement(documentRef, 'div', { className: 'yl-image-manager-side' });
    side.appendChild(heading);
    side.appendChild(intake);
    side.appendChild(status);
    element.appendChild(side);
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
        packInput.disabled = isBusy;
        packExportButton.disabled = isBusy;
        saveButton.disabled = isBusy;
        deleteButton.disabled = isBusy;
        if (remoteImportButton) remoteImportButton.disabled = isBusy;
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

    function sourceLabel() {
        return '本地图片';
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
            const empty = createEmptyState({
                documentRef,
                variant: 'inbox',
                title: '图片库还是空的',
                hint: '上传本地 PNG、JPEG 或 WebP 图片后，预览会显示在这里。',
            });
            empty.classList.add('yl-image-manager-empty');
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
                openEditor(record, card);
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
        const removeButton = createButton({ documentRef, variant: 'ghost', label: '移除' });
        removeButton.classList.add('yl-image-keyword-remove');
        listen(removeButton, 'click', () => row.remove());
        row.appendChild(keywordInput);
        row.appendChild(weightInput);
        row.appendChild(removeButton);
        keywordRows.appendChild(row);
    }

    function closeEditor() {
        // 有控制器时先把编辑器移出焦点栈（controller.close 自带礼貌回焦 opener），再清理瞬态，
        // 避免回焦时机落在已清空的子树之后；controller.close 不会回调 onRequestClose，故与本函数无递归。
        if (dialogController && !editorBackdrop.hidden) dialogController.close(editor);
        editor.hidden = true;
        editorBackdrop.hidden = true;
        activeImageId = null;
        keywordRows.replaceChildren();
        editorPreview.replaceChildren();
    }

    function handleEscape() {
        // 有控制器时：编辑器的 Escape 由 app-shell 委托链先经 dialogController.handleKeydown 处理
        // （onRequestClose → closeEditor），本方法对编辑器一律返回 false，避免双通道重复关闭；
        // 右键菜单是 disclosure、不入控制器栈，Escape 仍由本方法接管。
        if (dialogController) {
            if (contextMenu.hidden) return false;
            clearLongPress();
            closeContextMenu();
            return true;
        }
        const wasOpen = !editorBackdrop.hidden || !contextMenu.hidden;
        if (!wasOpen) return false;
        clearLongPress();
        if (!editorBackdrop.hidden) closeEditor();
        closeContextMenu();
        return true;
    }

    function cardForRecord(recordId) {
        for (const card of grid.querySelectorAll('.yl-image-card')) {
            if (card.dataset.imageId === recordId) return card;
        }
        return null;
    }

    function openEditor(record, opener = null) {
        closeContextMenu();
        activeImageId = record.id;
        keywordRows.replaceChildren();
        editorPreview.replaceChildren(makePreview(record, 'yl-image-keyword-preview-frame'));
        for (const entry of record.keywordWeights) addKeywordRow(entry.keyword, entry.weight);
        if (record.keywordWeights.length === 0) addKeywordRow('', 0);
        editor.hidden = false;
        editorBackdrop.hidden = false;
        // 控制器 open 自带 aria-modal、Tab 焦点环与首个可聚焦元素聚焦（编辑器内即首行关键词输入）；
        // opener 为触发的图片卡片，关闭时由控制器礼貌回焦。无控制器时保持旧的 hidden 切换降级。
        const dialogOptions = {
            opener: opener ?? cardForRecord(record.id),
            onRequestClose: () => closeEditor(),
        };
        if (typeof openDialog === 'function') openDialog(editor, dialogOptions);
        else if (dialogController) dialogController.open(editor, dialogOptions);
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

    listen(packExportButton, 'click', () => {
        void enqueueOperation(async () => {
            setBusy(true, '正在生成完整图包…');
            try {
                if (typeof imageLibrary.export !== 'function') throw new TypeError('image_manager_pack_transfer_unavailable');
                const json = await imageLibrary.export();
                if (typeof downloadImagePack !== 'function') throw new TypeError('image_manager_download_unavailable');
                await downloadImagePack(json);
                status.textContent = `已导出 ${records.length} 张图片及其关键词权重。`;
                report('完整图包已导出。');
            } catch (error) {
                status.textContent = '图包未导出。';
                report(error?.message === 'image_manager_download_unavailable'
                    ? '当前浏览器不支持图包下载。'
                    : error?.message === 'image_manager_pack_transfer_unavailable'
                        ? '当前图片库不支持图包导出。'
                    : feedbackMessage(error));
            } finally {
                if (!disposed) setBusy(false);
            }
        });
    });

    listen(packInput, 'change', () => {
        const file = packInput.files?.[0];
        if (!file) return;
        void enqueueOperation(async () => {
            setBusy(true, '正在校验并合并图包…');
            try {
                if (typeof file.text !== 'function') throw new TypeError('image_manager_pack_read_failed');
                if (typeof imageLibrary.importMerge !== 'function') throw new TypeError('image_manager_pack_transfer_unavailable');
                if (Number.isFinite(file.size) && file.size > MAX_IMAGE_LIBRARY_SERIALIZED_BYTES) {
                    throw new ImageLibraryError('LIBRARY_TOO_LARGE');
                }
                const json = await file.text();
                const result = await imageLibrary.importMerge(json);
                packInput.value = '';
                await reload();
                if (disposed) return;
                const renamed = result.renamedCount > 0 ? `，${result.renamedCount} 张因 ID 重复已自动改名` : '';
                status.textContent = `已导入 ${result.addedCount} 张，跳过 ${result.skippedCount} 张重复图片${renamed}。`;
                report('图包已安全合并；现有图片未被覆盖。');
                notify('import', null);
            } catch (error) {
                status.textContent = '图包未导入，现有图片保持不变。';
                report(error?.message === 'image_manager_pack_read_failed'
                    ? '无法读取所选图包文件。'
                    : error?.message === 'image_manager_pack_transfer_unavailable'
                        ? '当前图片库不支持图包导入。'
                    : feedbackMessage(error));
            } finally {
                if (!disposed) setBusy(false);
            }
        });
    });

    if (remoteImportButton) {
        listen(remoteImportButton, 'click', () => {
            const url = String(remoteUrlInput?.value ?? '').trim();
            if (!url) { status.textContent = '请先粘贴要导入的图片链接。'; return; }
            void enqueueOperation(async () => {
                setBusy(true, '正在下载并压缩链接图片…');
                try {
                    if (typeof compressImageFile !== 'function') throw new TypeError('image_manager_compression_unavailable');
                    const remoteFile = await importRemoteImageFile(url);
                    const dataUrl = normalizeCompressedImage(await compressImageFile(remoteFile));
                    const added = await imageLibrary.add({ source: { kind: 'embedded', dataUrl }, keywordWeights: [] });
                    remoteUrlInput.value = '';
                    await completeMutation('add', added, '链接图片已压缩并保存到图片库；链接本身不会被保存。');
                } catch (error) {
                    // 失败提示只用安全投影文案，不回显链接或宿主异常原文。
                    status.textContent = '链接图片未保存。';
                    report(projectRemoteImportError(error)?.message ?? feedbackMessage(error));
                } finally {
                    if (!disposed) setBusy(false);
                }
            });
        });
    }

    listen(configureButton, 'click', () => safeCallback(onConfigure));

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
    if (!dialogController) {
        // 无控制器降级：Escape 由面板自己的 document keydown 处理。
        // 有控制器时绝不注册本监听——Escape 走 app-shell 全局链的 dialogController.handleKeydown，
        // 双通道会对同一次按键重复处理。
        listen(documentRef, 'keydown', (event) => {
            if (event.key === 'Escape') handleEscape();
        });
    }

    void reload().catch((error) => {
        if (disposed) return;
        records = [];
        const failed = createEmptyState({
            documentRef,
            variant: 'search',
            title: '图片库读取失败。',
        });
        failed.classList.add('yl-image-manager-empty');
        grid.replaceChildren(failed);
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
            // 面板销毁时若编辑器仍在控制器栈内，先出栈（不回焦，宿主即将拆除 DOM），避免栈悬挂。
            if (dialogController && !editorBackdrop.hidden) dialogController.close(editor, { restoreFocus: false });
            controller.abort();
            element.remove();
        },
    });
}

