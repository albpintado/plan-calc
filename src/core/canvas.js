import { zoomAt, fitView } from '../viewport.js';

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 80;
const LOUPE_SIZE = 148;
const LOUPE_ZOOM = 2.5;

export function createCanvasController({
  canvas,
  loupe,
  loupeCanvas,
  getState,
  render,
  renderLoupe,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onChanged,
  onSpaceChange,
}) {
  const ctx = canvas.getContext('2d');
  let cssWidth = 0;
  let cssHeight = 0;
  let dpr = window.devicePixelRatio || 1;
  const activePointers = new Map();
  let gesture = null;
  let frame = 0;
  let spaceDown = false;
  let disposed = false;

  function clampZoom(scale) {
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
  }

  function requestRender() {
    if (disposed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      paint();
    });
  }

  function paint() {
    const state = getState();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render(ctx, state, cssWidth, cssHeight);
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    cssWidth = Math.max(1, Math.round(rect.width));
    cssHeight = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    const state = getState();
    if (state.source && (!state.view || (state.view.scale === 1 && state.view.tx === 0 && state.view.ty === 0))) {
      fit();
    }
    requestRender();
  }

  function fit() {
    const state = getState();
    if (!state.source) return;
    state.view = fitView(state.source.width, state.source.height, cssWidth, cssHeight);
  }

  function getScreenPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function pointerPair() {
    if (activePointers.size < 2) return null;
    return [...activePointers.values()].slice(0, 2);
  }

  function beginGesture(pair) {
    const [p1, p2] = pair;
    gesture = {
      startDistance: Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y)),
      startMid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
      startView: { ...getState().view },
    };
  }

  function hideLoupe() {
    if (loupe) loupe.hidden = true;
  }

  function updateLoupe(screen, imagePoint) {
    const state = getState();
    if (!loupe || !loupeCanvas || !renderLoupe || !state.source) {
      hideLoupe();
      return;
    }
    const localDpr = window.devicePixelRatio || 1;
    const pixelSize = Math.round(LOUPE_SIZE * localDpr);
    if (loupeCanvas.width !== pixelSize) {
      loupeCanvas.width = pixelSize;
      loupeCanvas.height = pixelSize;
    }
    const lctx = loupeCanvas.getContext('2d');
    lctx.setTransform(localDpr, 0, 0, localDpr, 0, 0);
    const scale = Math.min(MAX_ZOOM, state.view.scale * LOUPE_ZOOM);
    const view = {
      scale,
      tx: LOUPE_SIZE / 2 - imagePoint.x * scale,
      ty: LOUPE_SIZE / 2 - imagePoint.y * scale,
    };
    const halfSpan = LOUPE_SIZE / (2 * scale) + 16;
    const sx = Math.max(0, imagePoint.x - halfSpan);
    const sy = Math.max(0, imagePoint.y - halfSpan);
    const sourceRect = {
      x: sx,
      y: sy,
      w: Math.max(1, Math.min(state.source.width - sx, halfSpan * 2)),
      h: Math.max(1, Math.min(state.source.height - sy, halfSpan * 2)),
    };
    renderLoupe(lctx, { ...state, view, selectedId: null }, LOUPE_SIZE, LOUPE_SIZE, sourceRect);

    const center = LOUPE_SIZE / 2;
    lctx.strokeStyle = 'rgba(255, 45, 149, 0.9)';
    lctx.lineWidth = 1.5;
    lctx.beginPath();
    lctx.moveTo(center - 8, center);
    lctx.lineTo(center + 8, center);
    lctx.moveTo(center, center - 8);
    lctx.lineTo(center, center + 8);
    lctx.stroke();

    const rect = canvas.getBoundingClientRect();
    const gap = 20;
    const size = LOUPE_SIZE;
    const half = size / 2;
    const left = Math.min(Math.max(0, screen.x - half), rect.width - size);
    const top = screen.y - size - gap;
    loupe.style.left = `${left}px`;
    loupe.style.top = `${Math.max(0, top)}px`;
    loupe.hidden = false;
  }

  function normalizeWheelDelta(event) {
    let delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 16;
    else if (event.deltaMode === 2) delta *= cssHeight || 800;
    return Math.max(-240, Math.min(240, delta));
  }

  function onWheel(event) {
    if (!getState().source) return;
    event.preventDefault();
    const screen = getScreenPoint(event);
    const factor = Math.exp(-normalizeWheelDelta(event) * 0.0016);
    getState().view = zoomAt(getState().view, screen, factor);
    requestRender();
    if (onChanged) onChanged('view');
  }

  function handlePointerDown(event) {
    if (!getState().source) return;
    event.preventDefault();
    const screen = getScreenPoint(event);
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    activePointers.set(event.pointerId, screen);

    const pair = pointerPair();
    if (pair) {
      gesture = null;
      beginGesture(pair);
      requestRender();
      return;
    }

    const forcePan = event.button === 1 || spaceDown;
    onPointerDown?.(event, screen, { forcePan });
  }

  function handlePointerMove(event) {
    if (!getState().source) return;
    const screen = getScreenPoint(event);
    if (activePointers.has(event.pointerId)) activePointers.set(event.pointerId, screen);

    if (gesture) {
      const pair = pointerPair();
      if (!pair) return;
      const [p1, p2] = pair;
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const factor = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y)) / gesture.startDistance;
      const scale = clampZoom(gesture.startView.scale * factor);
      const imageX = (gesture.startMid.x - gesture.startView.tx) / gesture.startView.scale;
      const imageY = (gesture.startMid.y - gesture.startView.ty) / gesture.startView.scale;
      getState().view = { scale, tx: mid.x - imageX * scale, ty: mid.y - imageY * scale };
      requestRender();
      return;
    }

    onPointerMove?.(event, screen);
  }

  function handlePointerUp(event) {
    activePointers.delete(event.pointerId);
    hideLoupe();

    if (gesture) {
      if (activePointers.size < 2) {
        gesture = null;
        if (onChanged) onChanged('view');
      }
      requestRender();
      return;
    }

    const screen = getScreenPoint(event);
    onPointerUp?.(event, screen);
  }

  function onKeyDown(event) {
    if (event.code === 'Space' && !spaceDown) {
      spaceDown = true;
      canvas.style.cursor = 'grab';
      onSpaceChange?.(true);
      event.preventDefault();
    }
  }

  function onKeyUp(event) {
    if (event.code === 'Space') {
      spaceDown = false;
      canvas.style.cursor = getState().tool === 'select' ? 'grab' : 'crosshair';
      onSpaceChange?.(false);
    }
  }

  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerup', handlePointerUp);
  canvas.addEventListener('pointercancel', handlePointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('resize', resize);

  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
  if (observer) observer.observe(canvas);

  return {
    requestRender,
    paint,
    resize,
    fit,
    getScreenPoint,
    updateLoupe,
    hideLoupe,
    isSpaceDown: () => spaceDown,
    setSpaceDown: (value) => {
      spaceDown = value;
    },
    destroy() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.removeEventListener('pointercancel', handlePointerUp);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('resize', resize);
      if (observer) observer.disconnect();
    },
  };
}
