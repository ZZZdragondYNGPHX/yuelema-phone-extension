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
const IMAGE_GENERATION_PROVIDERS = Object.freeze([
    Object.freeze({ id: 'novelai', label: 'NovelAI' }),
    Object.freeze({ id: 'openai_compatible', label: 'OpenAI-compatible' }),
    Object.freeze({ id: 'comfyui', label: 'ComfyUI' }),
]);
const MAX_GENERATION_PROMPT_LENGTH = 1700;
const MAX_GENERATED_DATA_URL_LENGTH = 32 * 1024 * 1024;
const LONG_PRESS_DELAY_MS = 550;
const FLOATING_SURFACE_GUTTER = 8;

function noop() {}

function visualViewportRect(documentRef) {
    const windowRef = documentRef?.defaultView;
    const viewport = windowRef?.visualViewport;
    const width = Number(viewport?.width);
    const height = Number(viewport?.height);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
        return {
            left: Number.isFinite(Number(viewport.offsetLeft)) ? Number(viewport.offsetLeft) : 0,
            top: Number.isFinite(Number(viewport.offsetTop)) ? Number(viewport.offsetTop) : 0,
            width,
            height,
        };
    }
    return {
        left: 0,
        top: 0,
        width: Math.max(1, Number(windowRef?.innerWidth || documentRef?.documentElement?.clientWidth || 360)),
        height: Math.max(1, Number(windowRef?.innerHeight || documentRef?.documentElement?.clientHeight || 640)),
    };
}

function setInlineStyle(node, property, camelProperty, value) {
    if (typeof node?.style?.setProperty === 'function') node.style.setProperty(property, value);
    else if (node?.style) node.style[camelProperty] = value;
}

function inlineStylePixels(node, property, camelProperty) {
    const direct = Number.parseFloat(node?.style?.[camelProperty]);
    if (Number.isFinite(direct)) return direct;
    if (typeof node?.style?.getPropertyValue !== 'function') return Number.NaN;
    return Number.parseFloat(node.style.getPropertyValue(property));
}

function coordinateCorrection(target, measured, coordinate, previous, limit) {
    const delta = target - measured;
    if (Math.abs(delta) <= 0.5) return 0;
    let response = Number.NaN;
    if (previous && coordinate !== previous.coordinate) {
        response = (measured - previous.measured) / (coordinate - previous.coordinate);
    }
    const step = Number.isFinite(response) && response > 0.05 && response < 8 ? delta / response : delta;
    return Math.max(-limit, Math.min(limit, step));
}

/**
 * Put a short-lived fixed disclosure surface beside its pointer while keeping the
 * rendered rect inside the actual visual viewport. SillyTavern/Termux may make
 * fixed coordinates affine through an html transform or zoom, so correction is
 * based on repeated rendered measurements instead of assuming a 1:1 mapping.
 */
function placeFixedSurfaceInViewport(surface, documentRef, requestedLeft, requestedTop) {
    if (!surface?.style) return;
    const viewport = visualViewportRect(documentRef);
    const availableWidth = Math.max(1, Math.floor(viewport.width - (FLOATING_SURFACE_GUTTER * 2)));
    const availableHeight = Math.max(1, Math.floor(viewport.height - (FLOATING_SURFACE_GUTTER * 2)));
    setInlineStyle(surface, 'position', 'position', 'fixed');
    setInlineStyle(surface, 'right', 'right', 'auto');
    setInlineStyle(surface, 'bottom', 'bottom', 'auto');
    setInlineStyle(surface, 'margin', 'margin', '0');
    setInlineStyle(surface, 'max-width', 'maxWidth', `${availableWidth}px`);
    setInlineStyle(surface, 'max-height', 'maxHeight', `${availableHeight}px`);
    setInlineStyle(surface, 'overflow', 'overflow', 'auto');

    let cssLeft = Number.isFinite(requestedLeft) ? requestedLeft : viewport.left + FLOATING_SURFACE_GUTTER;
    let cssTop = Number.isFinite(requestedTop) ? requestedTop : viewport.top + FLOATING_SURFACE_GUTTER;
    setInlineStyle(surface, 'left', 'left', `${cssLeft.toFixed(2)}px`);
    setInlineStyle(surface, 'top', 'top', `${cssTop.toFixed(2)}px`);

    // A host scale can make a CSS max-size physically exceed the viewport.
    for (let fit = 0; fit < 2; fit += 1) {
        const rect = surface.getBoundingClientRect?.();
        const width = Number(rect?.width);
        const height = Number(rect?.height);
        if (!(width > 0) || !(height > 0)) return;
        let changed = false;
        if (width > availableWidth + 0.5) {
            const current = inlineStylePixels(surface, 'max-width', 'maxWidth');
            if (Number.isFinite(current) && current > 0) {
                setInlineStyle(surface, 'min-width', 'minWidth', '0px');
                setInlineStyle(surface, 'max-width', 'maxWidth', `${Math.max(1, current * (availableWidth / width)).toFixed(2)}px`);
                changed = true;
            }
        }
        if (height > availableHeight + 0.5) {
            const current = inlineStylePixels(surface, 'max-height', 'maxHeight');
            if (Number.isFinite(current) && current > 0) {
                setInlineStyle(surface, 'max-height', 'maxHeight', `${Math.max(1, current * (availableHeight / height)).toFixed(2)}px`);
                changed = true;
            }
        }
        if (!changed) break;
    }

    const measured = surface.getBoundingClientRect?.();
    const width = Number(measured?.width);
    const height = Number(measured?.height);
    if (!(width > 0) || !(height > 0)) return;
    const minLeft = viewport.left + FLOATING_SURFACE_GUTTER;
    const minTop = viewport.top + FLOATING_SURFACE_GUTTER;
    const targetLeft = Math.max(minLeft, Math.min(cssLeft, viewport.left + viewport.width - FLOATING_SURFACE_GUTTER - width));
    const targetTop = Math.max(minTop, Math.min(cssTop, viewport.top + viewport.height - FLOATING_SURFACE_GUTTER - height));
    cssLeft = targetLeft;
    cssTop = targetTop;
    let previousX = null;
    let previousY = null;
    for (let iteration = 0; iteration < 4; iteration += 1) {
        setInlineStyle(surface, 'left', 'left', `${cssLeft.toFixed(2)}px`);
        setInlineStyle(surface, 'top', 'top', `${cssTop.toFixed(2)}px`);
        const rect = surface.getBoundingClientRect?.();
        const left = Number(rect?.left);
        const top = Number(rect?.top);
        if (!Number.isFinite(left) || !Number.isFinite(top)) return;
        const stepX = coordinateCorrection(targetLeft, left, cssLeft, previousX, viewport.width * 4);
        const stepY = coordinateCorrection(targetTop, top, cssTop, previousY, viewport.height * 4);
        if (stepX === 0 && stepY === 0) return;
        previousX = { coordinate: cssLeft, measured: left };
        previousY = { coordinate: cssTop, measured: top };
        cssLeft += stepX;
        cssTop += stepY;
    }
    setInlineStyle(surface, 'left', 'left', `${cssLeft.toFixed(2)}px`);
    setInlineStyle(surface, 'top', 'top', `${cssTop.toFixed(2)}px`);
}

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

function generatedDataUrlToBlob(value) {
    if (typeof value !== 'string' || value.length > MAX_GENERATED_DATA_URL_LENGTH) {
        throw new TypeError('image_manager_generated_image_invalid');
    }
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/iu.exec(value);
    if (!match || typeof globalThis.atob !== 'function' || typeof globalThis.Blob !== 'function') {
        throw new TypeError('image_manager_generated_image_invalid');
    }
    let binary;
    try { binary = globalThis.atob(match[2]); } catch { throw new TypeError('image_manager_generated_image_invalid'); }
    if (!binary.length || binary.length > 24 * 1024 * 1024) throw new TypeError('image_manager_generated_image_invalid');
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new globalThis.Blob([bytes], { type: match[1].toLowerCase() });
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
    if (typeof error?.message === 'string' && error.message.startsWith('avatar_codec_failed:')) return '图片无法压缩到图片库限制内，未保存图片。';
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
    onConfigureGeneration = noop,
    onOpenGeneration = null,
    onCloseGeneration = null,
    dialogController = null,
    openDialog = null,
    importRemoteImageFile = null,
    downloadImagePack = null,
    generateImage = null,
    initialImageProvider = 'novelai',
    initialView = 'library',
} = {}) {
    if (!documentRef || typeof documentRef.createElement !== 'function') {
        throw new TypeError('image_manager_document_invalid');
    }
    if (!imageLibrary || ['list', 'add', 'update', 'remove'].some((method) => typeof imageLibrary[method] !== 'function')) {
        throw new TypeError('image_manager_library_invalid');
    }
    if (typeof onFeedback !== 'function' || typeof onChange !== 'function'
        || typeof onConfigure !== 'function' || typeof onConfigureGeneration !== 'function') {
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
    let generationAbortController = null;
    let generationEpoch = 0;
    let operationTail = Promise.resolve();

    const element = createElement(documentRef, 'section', { className: 'yl-image-manager' });
    const heading = createElement(documentRef, 'header', { className: 'yl-image-manager-heading' });
    const titlebar = createElement(documentRef, 'div', { className: 'yl-image-manager-titlebar yl-heading-with-help' });
    titlebar.appendChild(createElement(documentRef, 'h2', { className: 'yl-image-manager-title', text: '图片管理' }));
    const titleActions = createElement(documentRef, 'div', { className: 'yl-image-manager-title-actions' });
    const generationEntryButton = createButton({ documentRef, variant: 'ghost', label: '生图', ariaLabel: '打开图片库生图' });
    generationEntryButton.classList.add('yl-image-manager-generate-entry');
    const configureButton = createButton({ documentRef, variant: 'ghost', label: '设置', ariaLabel: '配置图片管理预设' });
    configureButton.classList.add('yl-feature-options', 'yl-image-manager-configure');
    titleActions.appendChild(generationEntryButton);
    titleActions.appendChild(configureButton);
    titlebar.appendChild(titleActions);
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
    const remoteImportButton = typeof importRemoteImageFile === 'function'
        ? createButton({ documentRef, variant: 'tonal', label: '下载并保存到图片库' })
        : null;
    if (remoteImportButton) {
        remoteImportButton.classList.add('yl-image-remote-import-button');
        intake.appendChild(remoteImportButton);
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

    const remoteBackdrop = createElement(documentRef, 'div', { className: 'yl-image-keyword-backdrop yl-image-remote-import-backdrop', hidden: true });
    const remoteDialog = createElement(documentRef, 'section', { className: 'yl-image-keyword-editor yl-image-remote-import-dialog', hidden: true });
    remoteDialog.setAttribute('role', 'dialog');
    remoteDialog.setAttribute('aria-modal', 'true');
    remoteDialog.setAttribute('aria-label', '从图片链接下载');
    const remoteHeader = createElement(documentRef, 'header', { className: 'yl-image-keyword-editor-heading' });
    remoteHeader.appendChild(createElement(documentRef, 'h3', { text: '下载链接图片' }));
    remoteHeader.appendChild(createElement(documentRef, 'p', { text: '图片会下载并压缩到本地图片库，链接本身不会保存。' }));
    const remoteField = createElement(documentRef, 'label', { className: 'yl-image-generation-field' });
    remoteField.appendChild(createElement(documentRef, 'span', { text: '图片链接' }));
    const remoteUrlInput = createElement(documentRef, 'input', { type: 'text', name: 'image-import-url' });
    remoteUrlInput.setAttribute('inputmode', 'url');
    remoteUrlInput.setAttribute('placeholder', 'https://…');
    remoteUrlInput.setAttribute('aria-label', '图片链接');
    remoteField.appendChild(remoteUrlInput);
    const remoteStatus = createElement(documentRef, 'p', { className: 'yl-image-remote-import-status', text: '请输入可公开访问的 HTTP 或 HTTPS 图片链接。' });
    remoteStatus.setAttribute('aria-live', 'polite');
    const remoteActions = createElement(documentRef, 'div', { className: 'yl-image-keyword-actions' });
    const remoteCancelButton = createButton({ documentRef, variant: 'ghost', label: '取消' });
    const remoteConfirmButton = createButton({ documentRef, variant: 'primary', label: '确定' });
    remoteActions.appendChild(remoteCancelButton);
    remoteActions.appendChild(remoteConfirmButton);
    remoteDialog.appendChild(remoteHeader);
    remoteDialog.appendChild(remoteField);
    remoteDialog.appendChild(remoteStatus);
    remoteDialog.appendChild(remoteActions);
    remoteBackdrop.appendChild(remoteDialog);

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
    element.appendChild(remoteBackdrop);

    const generationView = createElement(documentRef, 'section', { className: 'yl-image-generation-workbench', hidden: true });
    const generationHeader = createElement(documentRef, 'header', { className: 'yl-image-generation-workbench-header' });
    const generationBackButton = createButton({ documentRef, variant: 'ghost', icon: 'chevron_left', label: '返回图片库' });
    generationBackButton.classList.add('yl-image-generation-back');
    const generationHeading = createElement(documentRef, 'div', { className: 'yl-image-generation-workbench-heading' });
    generationHeading.appendChild(createElement(documentRef, 'h2', { text: '生成图片' }));
    generationHeading.appendChild(createElement(documentRef, 'p', { text: '选择已配置的接口，输入本次提示词；人物会强制按成年人生成，成功图片自动压缩并保存到图片库。' }));
    generationHeader.appendChild(generationBackButton);
    generationHeader.appendChild(generationHeading);

    const generationForm = createElement(documentRef, 'div', { className: 'yl-image-generation-form' });
    const providerLabel = createElement(documentRef, 'label', { className: 'yl-image-generation-field' });
    providerLabel.appendChild(createElement(documentRef, 'span', { text: '生图接口' }));
    const providerSelect = createElement(documentRef, 'select', { name: 'image-library-generation-provider' });
    providerSelect.setAttribute('aria-label', '选择图片库生图接口');
    for (const provider of IMAGE_GENERATION_PROVIDERS) {
        const option = createElement(documentRef, 'option', { value: provider.id, text: provider.label });
        providerSelect.appendChild(option);
    }
    providerSelect.value = IMAGE_GENERATION_PROVIDERS.some((provider) => provider.id === initialImageProvider)
        ? initialImageProvider
        : 'novelai';
    providerLabel.appendChild(providerSelect);

    const promptLabel = createElement(documentRef, 'label', { className: 'yl-image-generation-field' });
    promptLabel.appendChild(createElement(documentRef, 'span', { text: '提示词' }));
    const promptInput = createElement(documentRef, 'textarea', { name: 'image-library-generation-prompt' });
    promptInput.rows = 7;
    promptInput.setAttribute('maxlength', String(MAX_GENERATION_PROMPT_LENGTH));
    promptInput.setAttribute('placeholder', '描述要生成的画面；会自动叠加所选接口已保存的前置、后置与负面提示词。');
    promptInput.setAttribute('aria-label', '图片库生图提示词');
    promptLabel.appendChild(promptInput);

    const generationActions = createElement(documentRef, 'div', { className: 'yl-image-generation-actions' });
    const generationSettingsButton = createButton({ documentRef, variant: 'tonal', label: '接口设置' });
    const generationCancelButton = createButton({ documentRef, variant: 'ghost', label: '取消生成' });
    generationCancelButton.hidden = true;
    const generationButton = createButton({ documentRef, variant: 'primary', icon: 'sparkle', label: '生成并保存' });
    generationActions.appendChild(generationSettingsButton);
    generationActions.appendChild(generationCancelButton);
    generationActions.appendChild(generationButton);
    const generationStatus = createElement(documentRef, 'p', { className: 'yl-image-generation-status', text: '等待输入提示词。' });
    generationStatus.setAttribute('aria-live', 'polite');
    generationForm.appendChild(providerLabel);
    generationForm.appendChild(promptLabel);
    generationForm.appendChild(generationActions);
    generationForm.appendChild(generationStatus);
    generationView.appendChild(generationHeader);
    generationView.appendChild(generationForm);
    element.appendChild(generationView);

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

    function setGenerationBusy(isBusy, message = '') {
        providerSelect.disabled = isBusy;
        promptInput.disabled = isBusy;
        generationButton.disabled = isBusy;
        generationSettingsButton.disabled = isBusy;
        generationCancelButton.hidden = !isBusy;
        if (message) generationStatus.textContent = message;
    }

    function openGenerationView() {
        closeContextMenu();
        closeEditor();
        element.classList.add('is-generation-view');
        side.hidden = true;
        grid.hidden = true;
        generationView.hidden = false;
        generationStatus.textContent = '等待输入提示词。';
        promptInput.focus?.();
    }

    function closeGenerationView({ restoreFocus = true } = {}) {
        if (generationView.hidden) return;
        generationEpoch += 1;
        generationAbortController?.abort?.();
        generationAbortController = null;
        setGenerationBusy(false);
        generationView.hidden = true;
        element.classList.remove('is-generation-view');
        side.hidden = false;
        grid.hidden = false;
        if (restoreFocus) generationEntryButton.focus?.();
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
        const anchorRect = cardForRecord(record.id)?.getBoundingClientRect?.();
        const eventX = Number(event?.clientX);
        const eventY = Number(event?.clientY);
        const x = Number.isFinite(eventX) ? eventX : Number(anchorRect?.left);
        const y = Number.isFinite(eventY) ? eventY : Number(anchorRect?.bottom);
        placeFixedSurfaceInViewport(contextMenu, documentRef, x, y);
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

    function closeRemoteImportDialog({ restoreFocus = true } = {}) {
        if (dialogController && !remoteBackdrop.hidden) dialogController.close(remoteDialog, { restoreFocus });
        remoteDialog.hidden = true;
        remoteBackdrop.hidden = true;
        remoteUrlInput.value = '';
        remoteStatus.textContent = '请输入可公开访问的 HTTP 或 HTTPS 图片链接。';
        remoteConfirmButton.disabled = false;
        remoteCancelButton.disabled = false;
    }

    function openRemoteImportDialog() {
        remoteDialog.hidden = false;
        remoteBackdrop.hidden = false;
        const dialogOptions = {
            opener: remoteImportButton,
            initialFocus: remoteUrlInput,
            onRequestClose: () => closeRemoteImportDialog(),
            coverTarget: remoteBackdrop,
        };
        if (typeof openDialog === 'function') openDialog(remoteDialog, dialogOptions);
        else if (dialogController) dialogController.open(remoteDialog, dialogOptions);
        else remoteUrlInput.focus?.();
    }

    function handleEscape() {
        if (!generationView.hidden) {
            closeGenerationView();
            return true;
        }
        // 有控制器时：编辑器的 Escape 由 app-shell 委托链先经 dialogController.handleKeydown 处理
        // （onRequestClose → closeEditor），本方法对编辑器一律返回 false，避免双通道重复关闭；
        // 右键菜单是 disclosure、不入控制器栈，Escape 仍由本方法接管。
        if (dialogController) {
            if (contextMenu.hidden) return false;
            clearLongPress();
            closeContextMenu();
            return true;
        }
        const wasOpen = !editorBackdrop.hidden || !remoteBackdrop.hidden || !contextMenu.hidden;
        if (!wasOpen) return false;
        clearLongPress();
        if (!editorBackdrop.hidden) closeEditor();
        if (!remoteBackdrop.hidden) closeRemoteImportDialog();
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
            coverTarget: editorBackdrop,
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
        listen(remoteImportButton, 'click', openRemoteImportDialog);
        listen(remoteCancelButton, 'click', () => closeRemoteImportDialog());
        listen(remoteBackdrop, 'click', (event) => {
            if (event.target === remoteBackdrop) closeRemoteImportDialog();
        });
        listen(remoteConfirmButton, 'click', () => {
            const url = String(remoteUrlInput.value ?? '').trim();
            if (!url) {
                remoteStatus.textContent = '请填写图片链接。';
                remoteUrlInput.focus?.();
                return;
            }
            void enqueueOperation(async () => {
                remoteConfirmButton.disabled = true;
                remoteCancelButton.disabled = true;
                remoteStatus.textContent = '正在下载并压缩图片…';
                try {
                    if (typeof compressImageFile !== 'function') throw new TypeError('image_manager_compression_unavailable');
                    const remoteFile = await importRemoteImageFile(url);
                    const dataUrl = normalizeCompressedImage(await compressImageFile(remoteFile));
                    const added = await imageLibrary.add({ source: { kind: 'embedded', dataUrl }, keywordWeights: [] });
                    closeRemoteImportDialog({ restoreFocus: false });
                    await completeMutation('add', added, '链接图片已压缩并保存到图片库；链接本身不会被保存。');
                } catch (error) {
                    remoteStatus.textContent = projectRemoteImportError(error)?.message ?? feedbackMessage(error);
                } finally {
                    if (!disposed) {
                        remoteConfirmButton.disabled = false;
                        remoteCancelButton.disabled = false;
                    }
                }
            });
        });
    }

    listen(generationEntryButton, 'click', () => {
        if (typeof onOpenGeneration === 'function') safeCallback(onOpenGeneration);
        else openGenerationView();
    });
    listen(generationBackButton, 'click', () => {
        if (typeof onCloseGeneration === 'function') safeCallback(onCloseGeneration);
        else closeGenerationView();
    });
    listen(generationSettingsButton, 'click', () => safeCallback(onConfigureGeneration));
    listen(generationCancelButton, 'click', () => {
        generationEpoch += 1;
        generationAbortController?.abort?.();
        generationAbortController = null;
        setGenerationBusy(false, '本次生成已取消，提示词仍保留。');
    });
    listen(generationButton, 'click', () => {
        const prompt = String(promptInput.value ?? '').trim();
        if (!prompt) {
            generationStatus.textContent = '请输入本次生图提示词。';
            promptInput.focus?.();
            return;
        }
        void enqueueOperation(async () => {
            const epoch = ++generationEpoch;
            generationAbortController?.abort?.();
            generationAbortController = new AbortController();
            setGenerationBusy(true, '正在生成图片；完成后会自动压缩并保存…');
            try {
                if (typeof generateImage !== 'function') throw new TypeError('image_manager_generation_unavailable');
                if (typeof compressImageFile !== 'function') throw new TypeError('image_manager_compression_unavailable');
                const result = await generateImage({
                    provider: String(providerSelect.value ?? ''),
                    prompt,
                    signal: generationAbortController.signal,
                });
                if (disposed || epoch !== generationEpoch) return;
                if (!result?.ok) {
                    const message = typeof result?.message === 'string' && result.message.trim()
                        ? result.message.trim().slice(0, 200)
                        : '图片未生成，请检查接口设置后重试。';
                    generationStatus.textContent = message;
                    report(message);
                    return;
                }
                const source = result?.image?.dataUrl || result?.image?.src;
                const sourceBlob = generatedDataUrlToBlob(source);
                const dataUrl = normalizeCompressedImage(await compressImageFile(sourceBlob));
                if (disposed || epoch !== generationEpoch) return;
                const added = await imageLibrary.add({ source: { kind: 'embedded', dataUrl }, keywordWeights: [] });
                if (disposed) return;
                promptInput.value = '';
                closeGenerationView({ restoreFocus: false });
                await completeMutation('generate', added, '图片已生成、压缩并保存到图片库。');
            } catch (error) {
                if (disposed || epoch !== generationEpoch) return;
                const message = error?.message === 'image_manager_generation_unavailable'
                    ? '生图服务当前未接入。'
                    : error?.message === 'image_manager_generated_image_invalid'
                        ? '生图接口返回的图片无效，未保存到图片库。'
                        : feedbackMessage(error);
                generationStatus.textContent = message;
                report(message);
            } finally {
                if (generationAbortController?.signal && epoch === generationEpoch) {
                    generationAbortController = null;
                    if (!disposed) setGenerationBusy(false);
                }
            }
        });
    });

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

    const windowRef = documentRef.defaultView;
    if (typeof windowRef?.addEventListener === 'function') {
        listen(windowRef, 'resize', closeContextMenu);
        listen(windowRef, 'scroll', closeContextMenu);
    }
    if (typeof windowRef?.visualViewport?.addEventListener === 'function') {
        listen(windowRef.visualViewport, 'resize', closeContextMenu);
        listen(windowRef.visualViewport, 'scroll', closeContextMenu);
    }

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

    if (initialView === 'generation') {
        generationBackButton.hidden = typeof onCloseGeneration === 'function';
        openGenerationView();
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
            generationEpoch += 1;
            generationAbortController?.abort?.();
            generationAbortController = null;
            clearLongPress();
            clearSuppressedClick();
            // 面板销毁时若编辑器仍在控制器栈内，先出栈（不回焦，宿主即将拆除 DOM），避免栈悬挂。
            if (dialogController && !editorBackdrop.hidden) dialogController.close(editor, { restoreFocus: false });
            if (dialogController && !remoteBackdrop.hidden) dialogController.close(remoteDialog, { restoreFocus: false });
            controller.abort();
            element.remove();
        },
    });
}
