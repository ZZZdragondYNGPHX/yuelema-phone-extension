/**
 * Isolated Pointer Events controller for the small-phone launcher.
 *
 * The controller owns only the launcher element. It deliberately does not listen to,
 * inspect, or mutate the phone panel/header, so it can be wired into app-shell without
 * changing the existing panel drag behavior or visual styles.
 */

const DEFAULT_DRAG_THRESHOLD = 8;
const DEFAULT_EDGE_GAP = 0;

/** @param {unknown} value */
function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

/** @param {unknown} value */
function isFinitePositive(value) {
    return Number.isFinite(Number(value)) && Number(value) > 0;
}

/**
 * @param {Document | undefined} documentRef
 * @param {Window | undefined} windowRef
 */
function readViewport(documentRef, windowRef) {
    const visualViewport = windowRef?.visualViewport;
    if (visualViewport
        && isFinitePositive(visualViewport.width)
        && isFinitePositive(visualViewport.height)) {
        return {
            left: finiteNumber(visualViewport.offsetLeft),
            top: finiteNumber(visualViewport.offsetTop),
            width: finiteNumber(visualViewport.width),
            height: finiteNumber(visualViewport.height),
        };
    }

    const documentElement = documentRef?.documentElement;
    const width = finiteNumber(windowRef?.innerWidth, finiteNumber(documentElement?.clientWidth));
    const height = finiteNumber(windowRef?.innerHeight, finiteNumber(documentElement?.clientHeight));
    return { left: 0, top: 0, width, height };
}

/**
 * Keep a rectangle inside the current viewport. If the viewport is smaller than the
 * launcher, the launcher stays anchored at the nearest visible edge rather than
 * producing inverted min/max ranges.
 *
 * @param {{ left: number, top: number, width: number, height: number }} position
 * @param {{ left: number, top: number, width: number, height: number }} viewport
 * @param {number} edgeGap
 */
export function clampLauncherPosition(position, viewport, edgeGap = DEFAULT_EDGE_GAP) {
    const gap = Math.max(0, finiteNumber(edgeGap));
    const minLeft = viewport.left + gap;
    const minTop = viewport.top + gap;
    const maxLeft = Math.max(minLeft, viewport.left + viewport.width - position.width - gap);
    const maxTop = Math.max(minTop, viewport.top + viewport.height - position.height - gap);
    return {
        left: Math.min(Math.max(finiteNumber(position.left), minLeft), maxLeft),
        top: Math.min(Math.max(finiteNumber(position.top), minTop), maxTop),
    };
}

/** @param {Element | null | undefined} node */
function readRect(node) {
    if (!node || typeof node.getBoundingClientRect !== 'function') return null;
    const rect = node.getBoundingClientRect();
    const width = finiteNumber(rect?.width, finiteNumber(rect?.right) - finiteNumber(rect?.left));
    const height = finiteNumber(rect?.height, finiteNumber(rect?.bottom) - finiteNumber(rect?.top));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return {
        left: finiteNumber(rect?.left),
        top: finiteNumber(rect?.top),
        width,
        height,
    };
}

/**
 * @typedef {object} LauncherDragOptions
 * @property {HTMLElement} launcher
 * @property {Document} [documentRef]
 * @property {Window} [windowRef]
 * @property {number} [threshold]
 * @property {number} [edgeGap]
 * @property {() => void} [onDragStart]
 * @property {(position: { left: number, top: number }) => void} [onDragMove]
 * @property {(result: { dragged: boolean, cancelled: boolean, position: { left: number, top: number } | null }) => void} [onDragEnd]
 */

/**
 * Create an isolated draggable controller for the launcher button.
 *
 * Integration is intentionally explicit:
 *
 * ```js
 * const launcherDrag = createLauncherDragController({ launcher, documentRef });
 * // mountPhoneApp.destroy(): launcherDrag.dispose();
 * ```
 *
 * @param {LauncherDragOptions} options
 */
export function createLauncherDragController(options) {
    const launcher = options?.launcher;
    if (!launcher || typeof launcher.addEventListener !== 'function') {
        throw new TypeError('launcher-drag 需要一个可监听事件的 launcher 元素');
    }

    const documentRef = options.documentRef ?? launcher.ownerDocument ?? globalThis.document;
    const windowRef = options.windowRef ?? documentRef?.defaultView ?? globalThis.window;
    const threshold = Math.max(0, finiteNumber(options.threshold, DEFAULT_DRAG_THRESHOLD));
    const edgeGap = Math.max(0, finiteNumber(options.edgeGap, DEFAULT_EDGE_GAP));
    const onDragStart = typeof options.onDragStart === 'function' ? options.onDragStart : null;
    const onDragMove = typeof options.onDragMove === 'function' ? options.onDragMove : null;
    const onDragEnd = typeof options.onDragEnd === 'function' ? options.onDragEnd : null;

    let disposed = false;
    let pointerState = null;
    let suppressNextClick = false;
    let originX = 0;
    let originY = 0;
    let fixedPositionPrepared = false;
    let lastPosition = null;

    // Changing touch-action is behavioral only; restore the caller's inline value on dispose.
    const originalTouchAction = launcher.style?.touchAction ?? '';
    if (launcher.style) launcher.style.touchAction = 'none';

    function pointerMatches(event) {
        return pointerState
            && (event?.pointerId === undefined || event.pointerId === pointerState.pointerId);
    }

    function capturePointer(pointerId) {
        if (pointerId === undefined) return;
        try { launcher.setPointerCapture?.(pointerId); } catch { /* capture may be unavailable */ }
    }

    function releasePointer(pointerId) {
        if (pointerId === undefined) return;
        try { launcher.releasePointerCapture?.(pointerId); } catch { /* capture may already be gone */ }
    }

    function writeFixedPosition(left, top) {
        if (!launcher.style) return;
        launcher.style.position = 'fixed';
        launcher.style.left = `${left}px`;
        launcher.style.top = `${top}px`;
        launcher.style.right = 'auto';
        launcher.style.bottom = 'auto';
    }

    function prepareFixedPosition(startRect) {
        if (fixedPositionPrepared) return;
        // The first write changes the containing-block coordinate system on transformed
        // hosts. Measure once, then carry this offset into every later write.
        writeFixedPosition(startRect.left, startRect.top);
        const check = readRect(launcher);
        originX = finiteNumber(check?.left) - startRect.left;
        originY = finiteNumber(check?.top) - startRect.top;
        if (originX || originY) writeFixedPosition(startRect.left - originX, startRect.top - originY);
        fixedPositionPrepared = true;
    }

    function writeViewportPosition(position) {
        writeFixedPosition(position.left - originX, position.top - originY);
        lastPosition = { left: position.left, top: position.top };
        onDragMove?.(lastPosition);
    }

    function begin(event) {
        if (disposed || pointerState || event?.isPrimary === false) return;
        const button = Number(event?.button);
        if (Number.isFinite(button) && button !== 0) return;
        const startRect = readRect(launcher);
        if (!startRect) return;
        const pointerId = event?.pointerId;
        pointerState = {
            pointerId,
            startX: finiteNumber(event?.clientX),
            startY: finiteNumber(event?.clientY),
            startRect,
            engaged: false,
            cancelled: false,
        };
        fixedPositionPrepared = false;
        originX = 0;
        originY = 0;
        lastPosition = null;
        capturePointer(pointerId);
    }

    function move(event) {
        if (disposed || !pointerMatches(event)) return;
        const deltaX = finiteNumber(event?.clientX) - pointerState.startX;
        const deltaY = finiteNumber(event?.clientY) - pointerState.startY;
        if (!pointerState.engaged) {
            if (Math.hypot(deltaX, deltaY) < threshold) return;
            pointerState.engaged = true;
            suppressNextClick = true;
            prepareFixedPosition(pointerState.startRect);
            onDragStart?.();
        }

        const viewport = readViewport(documentRef, windowRef);
        const position = clampLauncherPosition({
            left: pointerState.startRect.left + deltaX,
            top: pointerState.startRect.top + deltaY,
            width: pointerState.startRect.width,
            height: pointerState.startRect.height,
        }, viewport, edgeGap);
        writeViewportPosition(position);
        event?.preventDefault?.();
    }

    function finish(event, cancelled = false) {
        if (disposed || !pointerMatches(event)) return;
        const completedState = pointerState;
        const wasDragged = completedState.engaged;
        const result = {
            dragged: wasDragged,
            cancelled: Boolean(cancelled),
            position: lastPosition ? { ...lastPosition } : null,
        };
        pointerState = null;
        releasePointer(completedState.pointerId);
        if (!wasDragged) suppressNextClick = false;
        onDragEnd?.(result);
    }

    function handleClick(event) {
        if (!suppressNextClick) return;
        suppressNextClick = false;
        event?.preventDefault?.();
        event?.stopImmediatePropagation?.();
    }

    function handleLostPointerCapture(event) {
        if (pointerMatches(event)) finish(event, true);
    }

    const trackingTarget = typeof documentRef?.addEventListener === 'function' ? documentRef : launcher;
    const onPointerUp = (event) => finish(event, false);
    const onPointerCancel = (event) => finish(event, true);
    launcher.addEventListener('pointerdown', begin);
    launcher.addEventListener('lostpointercapture', handleLostPointerCapture);
    launcher.addEventListener('click', handleClick, true);
    trackingTarget.addEventListener('pointermove', move);
    trackingTarget.addEventListener('pointerup', onPointerUp);
    trackingTarget.addEventListener('pointercancel', onPointerCancel);

    return Object.freeze({
        get dragging() { return Boolean(pointerState?.engaged); },
        get position() { return lastPosition ? { ...lastPosition } : null; },
        dispose() {
            if (disposed) return;
            disposed = true;
            if (pointerState) {
                const pointerId = pointerState.pointerId;
                pointerState = null;
                releasePointer(pointerId);
            }
            launcher.removeEventListener('pointerdown', begin);
            launcher.removeEventListener('lostpointercapture', handleLostPointerCapture);
            launcher.removeEventListener('click', handleClick, true);
            trackingTarget.removeEventListener('pointermove', move);
            trackingTarget.removeEventListener('pointerup', onPointerUp);
            trackingTarget.removeEventListener('pointercancel', onPointerCancel);
            if (launcher.style) launcher.style.touchAction = originalTouchAction;
            suppressNextClick = false;
            lastPosition = null;
        },
    });
}

