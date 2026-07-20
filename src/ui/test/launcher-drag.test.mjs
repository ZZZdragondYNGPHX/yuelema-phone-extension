import test from 'node:test';
import assert from 'node:assert/strict';
import { clampLauncherPosition, createLauncherDragController } from '../../launcher-drag.js';

function pointerEvent(type, properties = {}) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries(properties)) {
        Object.defineProperty(event, key, { configurable: true, enumerable: true, value });
    }
    return event;
}

class TestDocument extends EventTarget {
    constructor({ width = 400, height = 300, visualViewport = null } = {}) {
        super();
        this.documentElement = { clientWidth: width, clientHeight: height };
        this.defaultView = { innerWidth: width, innerHeight: height, visualViewport };
    }
}

class TestLauncher extends EventTarget {
    constructor(documentRef, {
        left = 100,
        top = 80,
        width = 60,
        height = 60,
        fixedOffsetX = 0,
        fixedOffsetY = 0,
    } = {}) {
        super();
        this.ownerDocument = documentRef;
        this.style = {
            position: '', left: '', top: '', right: '', bottom: '', touchAction: 'manipulation',
        };
        this.baseRect = { left, top, width, height };
        this.fixedOffsetX = fixedOffsetX;
        this.fixedOffsetY = fixedOffsetY;
        this.capturedPointerId = null;
        this.captureCalls = 0;
        this.releaseCalls = 0;
    }

    setPointerCapture(pointerId) {
        this.capturedPointerId = pointerId;
        this.captureCalls += 1;
    }

    releasePointerCapture(pointerId) {
        if (this.capturedPointerId === pointerId) this.capturedPointerId = null;
        this.releaseCalls += 1;
    }

    getBoundingClientRect() {
        const fixed = this.style.position === 'fixed';
        const left = fixed ? Number.parseFloat(this.style.left) + this.fixedOffsetX : this.baseRect.left;
        const top = fixed ? Number.parseFloat(this.style.top) + this.fixedOffsetY : this.baseRect.top;
        return {
            left,
            top,
            right: left + this.baseRect.width,
            bottom: top + this.baseRect.height,
            width: this.baseRect.width,
            height: this.baseRect.height,
        };
    }
}

test('clampLauncherPosition keeps the whole launcher inside normal and undersized viewports', () => {
    assert.deepEqual(
        clampLauncherPosition(
            { left: -100, top: 900, width: 60, height: 60 },
            { left: 0, top: 0, width: 320, height: 240 },
            4,
        ),
        { left: 4, top: 176 },
    );
    assert.deepEqual(
        clampLauncherPosition(
            { left: 200, top: 200, width: 80, height: 90 },
            { left: 10, top: 20, width: 40, height: 50 },
            6,
        ),
        { left: 16, top: 26 },
    );
});

test('touch and mouse Pointer Events use an 8px threshold and suppress exactly one post-drag click', () => {
    const documentRef = new TestDocument();
    const launcher = new TestLauncher(documentRef);
    const dragEnds = [];
    const controller = createLauncherDragController({
        launcher,
        documentRef,
        onDragEnd(result) { dragEnds.push(result); },
    });
    let activations = 0;
    launcher.addEventListener('click', () => { activations += 1; });

    launcher.dispatchEvent(pointerEvent('pointerdown', {
        pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 110, clientY: 90,
    }));
    const belowThreshold = pointerEvent('pointermove', {
        pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 115, clientY: 95,
    });
    documentRef.dispatchEvent(belowThreshold);
    assert.equal(belowThreshold.defaultPrevented, false, '阈值内移动不能劫持普通点击/触摸');
    assert.equal(launcher.style.position, '', '越过阈值前不能改变布局定位');
    documentRef.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, pointerType: 'touch' }));
    launcher.dispatchEvent(new Event('click', { cancelable: true }));
    assert.equal(activations, 1, '普通触摸点击仍应打开小手机');
    assert.equal(dragEnds.at(-1).dragged, false);

    launcher.dispatchEvent(pointerEvent('pointerdown', {
        pointerId: 2, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 110, clientY: 90,
    }));
    const dragMove = pointerEvent('pointermove', {
        pointerId: 2, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 140, clientY: 120,
    });
    documentRef.dispatchEvent(dragMove);
    assert.equal(dragMove.defaultPrevented, true, '真正拖动后应阻止浏览器默认手势');
    assert.equal(controller.dragging, true);
    documentRef.dispatchEvent(pointerEvent('pointerup', { pointerId: 2, pointerType: 'mouse', button: 0 }));
    assert.equal(controller.dragging, false);

    const syntheticClick = new Event('click', { cancelable: true });
    launcher.dispatchEvent(syntheticClick);
    assert.equal(syntheticClick.defaultPrevented, true);
    assert.equal(activations, 1, '拖动结束产生的 click 必须被吃掉');
    launcher.dispatchEvent(new Event('click', { cancelable: true }));
    assert.equal(activations, 2, '只能抑制一次，下一次真实点击必须恢复');
    assert.equal(dragEnds.at(-1).dragged, true);

    controller.dispose();
});

test('drag clamps to the visual viewport and compensates transformed fixed containing blocks', () => {
    const visualViewport = { offsetLeft: 10, offsetTop: 20, width: 300, height: 220 };
    const documentRef = new TestDocument({ width: 500, height: 400, visualViewport });
    const launcher = new TestLauncher(documentRef, {
        left: 220, top: 130, width: 60, height: 60, fixedOffsetX: 30, fixedOffsetY: 15,
    });
    const moves = [];
    const controller = createLauncherDragController({
        launcher,
        documentRef,
        edgeGap: 4,
        onDragMove(position) { moves.push(position); },
    });

    launcher.dispatchEvent(pointerEvent('pointerdown', {
        pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: 230, clientY: 140,
    }));
    documentRef.dispatchEvent(pointerEvent('pointermove', {
        pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: 900, clientY: 900,
    }));

    assert.deepEqual(moves.at(-1), { left: 246, top: 176 }, '应按 visualViewport 与边距钳制');
    assert.equal(launcher.style.left, '216px', '写入坐标应扣除 transform containing-block 的 X 偏移');
    assert.equal(launcher.style.top, '161px', '写入坐标应扣除 transform containing-block 的 Y 偏移');
    assert.deepEqual(
        { left: launcher.getBoundingClientRect().left, top: launcher.getBoundingClientRect().top },
        { left: 246, top: 176 },
        '补偿后的真实 viewport 坐标必须与钳制结果一致',
    );

    documentRef.dispatchEvent(pointerEvent('pointerup', { pointerId: 7, pointerType: 'touch' }));
    assert.equal(launcher.capturedPointerId, null);
    assert.ok(launcher.releaseCalls >= 1);
    assert.deepEqual(controller.position, { left: 246, top: 176 });
    controller.dispose();
});

test('dispose removes listeners, restores touch behavior, and unrelated header events stay untouched', () => {
    const documentRef = new TestDocument();
    const launcher = new TestLauncher(documentRef);
    const unrelatedHeader = new EventTarget();
    const controller = createLauncherDragController({ launcher, documentRef });
    assert.equal(launcher.style.touchAction, 'none');

    const headerMove = pointerEvent('pointermove', { pointerId: 99, clientX: 200, clientY: 200 });
    unrelatedHeader.dispatchEvent(headerMove);
    assert.equal(headerMove.defaultPrevented, false, '控制器不得介入 panel header 的独立拖动事件');
    assert.equal(launcher.style.position, '');

    launcher.dispatchEvent(pointerEvent('pointerdown', {
        pointerId: 3, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 100, clientY: 80,
    }));
    assert.equal(launcher.capturedPointerId, 3);
    controller.dispose();
    assert.equal(launcher.capturedPointerId, null);
    assert.equal(launcher.style.touchAction, 'manipulation');

    documentRef.dispatchEvent(pointerEvent('pointermove', {
        pointerId: 3, pointerType: 'mouse', button: 0, clientX: 300, clientY: 250,
    }));
    assert.equal(launcher.style.position, '', 'dispose 后 document fallback 监听也必须清理');

    launcher.dispatchEvent(pointerEvent('pointerdown', {
        pointerId: 4, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 100, clientY: 80,
    }));
    assert.equal(launcher.captureCalls, 1, 'dispose 后 launcher 本身也不得再启动拖动');
});
