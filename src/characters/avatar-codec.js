/**
 * Browser-side local-avatar intake and compression.
 *
 * This module never writes storage. It converts an explicitly selected image File
 * into the same bounded embedded avatar envelope validated by character-template-codec.
 */
import { MAX_EMBEDDED_AVATAR_DATA_URL_LENGTH } from './character-template-codec.js';

export const MAX_SOURCE_AVATAR_BYTES = 8 * 1024 * 1024;
export const MAX_AVATAR_EDGE = 1024;
export const ACCEPTED_AVATAR_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);

const MIME_TO_EXTENSION = Object.freeze({
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/webp': 'webp',
});

function avatarError(code) {
    const error = new TypeError(`avatar_codec_failed:${code}`);
    error.code = code;
    return error;
}

function fail(code) { throw avatarError(code); }

function isSafeBlob(value) {
    return value && typeof value === 'object'
        && typeof value.type === 'string'
        && typeof value.size === 'number'
        && Number.isFinite(value.size)
        && value.size >= 1;
}

function assertImageFile(file) {
    if (!isSafeBlob(file)) fail('avatar_file_invalid');
    if (!ACCEPTED_AVATAR_TYPES.includes(file.type)) fail('avatar_file_type_invalid');
    if (file.size > MAX_SOURCE_AVATAR_BYTES) fail('avatar_file_too_large');
}

function getDimensions(source) {
    const width = Number(source?.width ?? source?.naturalWidth);
    const height = Number(source?.height ?? source?.naturalHeight);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) fail('avatar_image_invalid');
    return { width, height };
}

function scaledDimensions(width, height, maximumEdge) {
    const factor = Math.min(1, maximumEdge / Math.max(width, height));
    return Object.freeze({
        width: Math.max(1, Math.round(width * factor)),
        height: Math.max(1, Math.round(height * factor)),
    });
}

async function canvasToBlob(canvas, mimeType, quality) {
    if (typeof canvas?.convertToBlob === 'function') {
        const blob = await canvas.convertToBlob({ type: mimeType, quality });
        if (!isSafeBlob(blob)) fail('avatar_compression_failed');
        return blob;
    }
    if (typeof canvas?.toBlob === 'function') {
        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (!isSafeBlob(blob)) { reject(avatarError('avatar_compression_failed')); return; }
                resolve(blob);
            }, mimeType, quality);
        });
    }
    fail('avatar_canvas_unavailable');
}

async function blobToDataUrl(blob) {
    if (typeof blob.arrayBuffer === 'function') {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (bytes.byteLength === 0) fail('avatar_compression_failed');
        let binary = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
        }
        return `data:${blob.type};base64,${globalThis.btoa(binary)}`;
    }
    if (typeof globalThis.FileReader === 'function') {
        return new Promise((resolve, reject) => {
            const reader = new globalThis.FileReader();
            reader.onerror = () => reject(avatarError('avatar_read_failed'));
            reader.onload = () => typeof reader.result === 'string'
                ? resolve(reader.result)
                : reject(avatarError('avatar_read_failed'));
            reader.readAsDataURL(blob);
        });
    }
    fail('avatar_read_unavailable');
}

function defaultCanvasFactory(width, height) {
    if (typeof globalThis.OffscreenCanvas === 'function') return new globalThis.OffscreenCanvas(width, height);
    if (typeof globalThis.document?.createElement === 'function') {
        const canvas = globalThis.document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
    }
    fail('avatar_canvas_unavailable');
}

async function defaultDecode(file) {
    if (typeof globalThis.createImageBitmap === 'function') return globalThis.createImageBitmap(file);
    fail('avatar_decoder_unavailable');
}

/**
 * Converts a selected local image to a bounded data URL.
 * Dependency injection makes it testable without a browser; production callers pass
 * only `file` and rely on browser createImageBitmap/canvas implementations.
 */
export async function compressLocalAvatar(file, {
    maximumEdge = MAX_AVATAR_EDGE,
    mimeType = 'image/webp',
    quality = 0.86,
    decodeImage = defaultDecode,
    canvasFactory = defaultCanvasFactory,
} = {}) {
    assertImageFile(file);
    if (!Number.isInteger(maximumEdge) || maximumEdge < 64 || maximumEdge > MAX_AVATAR_EDGE) fail('avatar_options_invalid');
    if (!ACCEPTED_AVATAR_TYPES.includes(mimeType)) fail('avatar_options_invalid');
    if (typeof quality !== 'number' || !Number.isFinite(quality) || quality < 0.4 || quality > 1) fail('avatar_options_invalid');
    if (typeof decodeImage !== 'function' || typeof canvasFactory !== 'function') fail('avatar_options_invalid');

    let source;
    try {
        source = await decodeImage(file);
        const original = getDimensions(source);
        const size = scaledDimensions(original.width, original.height, maximumEdge);
        const canvas = canvasFactory(size.width, size.height);
        const context = canvas?.getContext?.('2d');
        if (!context || typeof context.drawImage !== 'function') fail('avatar_canvas_unavailable');
        context.drawImage(source, 0, 0, size.width, size.height);
        const compressed = await canvasToBlob(canvas, mimeType, quality);
        if (!ACCEPTED_AVATAR_TYPES.includes(compressed.type)) fail('avatar_compression_failed');
        const dataUrl = await blobToDataUrl(compressed);
        if (typeof dataUrl !== 'string' || dataUrl.length > MAX_EMBEDDED_AVATAR_DATA_URL_LENGTH) fail('avatar_output_too_large');
        const expectedPrefix = `data:${compressed.type};base64,`;
        if (!dataUrl.startsWith(expectedPrefix)) fail('avatar_compression_failed');
        return Object.freeze({ kind: 'embedded', dataUrl, width: size.width, height: size.height, mimeType: compressed.type });
    } catch (error) {
        if (error && typeof error.code === 'string' && error.message?.startsWith('avatar_codec_failed:')) throw error;
        fail('avatar_compression_failed');
    } finally {
        try { source?.close?.(); } catch { /* decoder cleanup must not mask result */ }
    }
}

/** Safe, stable error projection for UI feedback. */
export function projectAvatarError(error) {
    const code = error?.message?.startsWith('avatar_codec_failed:') && typeof error.code === 'string'
        ? error.code
        : 'avatar_compression_failed';
    const messages = {
        avatar_file_invalid: '请选择有效的本地图片。',
        avatar_file_type_invalid: '本地头像仅支持 PNG、JPEG 或 WebP。',
        avatar_file_too_large: '本地头像原文件超过 8 MB。',
        avatar_image_invalid: '无法读取该图片尺寸。',
        avatar_canvas_unavailable: '当前浏览器无法压缩本地头像。',
        avatar_decoder_unavailable: '当前浏览器无法读取本地头像。',
        avatar_output_too_large: '压缩后的头像仍超过导出限制。',
        avatar_compression_failed: '本地头像压缩失败，未保存任何图片。',
        avatar_options_invalid: '头像压缩参数无效。',
    };
    return Object.freeze({ code, message: messages[code] ?? messages.avatar_compression_failed });
}

export function avatarAcceptAttribute() {
    return ACCEPTED_AVATAR_TYPES.join(',');
}
