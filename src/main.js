import {
  constrainAngle,
  computePxPerMeter,
  distance,
  distanceToSegment,
  findSnapPoint,
  formatDimension,
  formatLength,
  pxToMm,
  segmentAngle,
  snapToDirections,
  toMeters,
} from './measure.js';
import { fitView, makeTransform } from './viewport.js';
import { render } from './render.js';
import { createSource, goToPage, releaseSource } from './source.js';
import { loadState, saveState } from './persistence.js';

const els = {
  canvas: document.getElementById('canvas'),
  fileInput: document.getElementById('fileInput'),
  openBtn: document.getElementById('openBtn'),
  panelToggle: document.getElementById('panelToggle'),
  panelClose: document.getElementById('panelClose'),
  panelCount: document.getElementById('panelCount'),
  snapToggle: document.getElementById('snapToggle'),
  deleteHandle: document.getElementById('deleteHandle'),
  loupe: document.getElementById('loupe'),
  loupeCanvas: document.getElementById('loupeCanvas'),
  confirmBackdrop: document.getElementById('confirmBackdrop'),
  confirmText: document.getElementById('confirmText'),
  confirmOk: document.getElementById('confirmOk'),
  confirmCancel: document.getElementById('confirmCancel'),
  toolButtons: [...document.querySelectorAll('button.tool')],
  pagePrev: document.getElementById('pagePrev'),
  pageNext: document.getElementById('pageNext'),
  pageInfo: document.getElementById('pageInfo'),
  zoomInfo: document.getElementById('zoomInfo'),
  fitBtn: document.getElementById('fitBtn'),
  undoBtn: document.getElementById('undoBtn'),
  deleteBtn: document.getElementById('deleteBtn'),
  clearBtn: document.getElementById('clearBtn'),
  exportBtn: document.getElementById('exportBtn'),
  calibrateStatus: document.getElementById('calibrateStatus'),
  resetCalibration: document.getElementById('resetCalibration'),
  measurementList: document.getElementById('measurementList'),
  measureCount: document.getElementById('measureCount'),
  totalRow: document.getElementById('totalRow'),
  totalValue: document.getElementById('totalValue'),
  calibDialog: document.getElementById('calibDialog'),
  calibInput: document.getElementById('calibInput'),
  calibUnit: document.getElementById('calibUnit'),
  calibOk: document.getElementById('calibOk'),
  calibCancel: document.getElementById('calibCancel'),
  calibError: document.getElementById('calibError'),
  status: document.getElementById('status'),
};

const ctx = els.canvas.getContext('2d');
const workspace = els.canvas.parentElement;

const state = {
  source: null,
  view: { scale: 1, tx: 0, ty: 0 },
  calibration: null,
  measurements: [],
  selectedId: null,
  preview: null,
  snap: null,
  tool: 'select',
  snapLines: false,
};

const pageStore = new Map();
const history = [];
const activePointers = new Map();
let gesture = null;
let pendingCalibration = null;
let nextId = 1;
let drag = null;
let cssWidth = 0;
let cssHeight = 0;
let spaceDown = false;
let frame = 0;
let zoomFrame = 0;
let zoomGoal = null;
let saveTimer = null;
let statusTimer = null;

function currentPageKey() {
  return state.source && state.source.kind === 'pdf' ? state.source.page : 1;
}

function snapshot() {
  return {
    calibration: state.calibration
      ? { ...state.calibration, a: { ...state.calibration.a }, b: { ...state.calibration.b } }
      : null,
    measurements: state.measurements.map((m) => ({ ...m, a: { ...m.a }, b: { ...m.b } })),
  };
}

function pushHistory() {
  history.push(snapshot());
  if (history.length > 100) history.shift();
}

function undo() {
  const previous = history.pop();
  if (!previous) return;
  state.calibration = previous.calibration;
  state.measurements = previous.measurements;
  state.selectedId = null;
  afterChange();
}

function syncZoom() {
  els.zoomInfo.textContent = `${Math.round(state.view.scale * 100)}%`;
}

function positionDeleteHandle() {
  const selected = state.selectedId;
  let segment = null;
  if (selected === 'calibration' && state.calibration) {
    segment = state.calibration;
  } else if (typeof selected === 'number') {
    segment = state.measurements.find((m) => m.id === selected) || null;
  }
  if (!segment || !state.source) {
    els.deleteHandle.hidden = true;
    return;
  }
  const transform = makeTransform(state.view);
  const a = transform.toScreen(segment.a);
  const b = transform.toScreen(segment.b);
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  let ox = Math.cos(segmentAngle(segment.a, segment.b) + Math.PI / 2);
  let oy = Math.sin(segmentAngle(segment.a, segment.b) + Math.PI / 2);
  if (oy < 0) {
    ox = -ox;
    oy = -oy;
  }
  els.deleteHandle.style.left = `${midX + ox * 48}px`;
  els.deleteHandle.style.top = `${midY + oy * 48}px`;
  els.deleteHandle.hidden = false;
}

function paint() {
  render(ctx, state, cssWidth, cssHeight);
  syncZoom();
  positionDeleteHandle();
}

function hideLoupe() {
  els.loupe.hidden = true;
}

function updateLoupe(screen, imagePoint) {
  if (!state.source) return hideLoupe();
  const dpr = window.devicePixelRatio || 1;
  const canvas = els.loupeCanvas;
  const pixelSize = Math.round(LOUPE_SIZE * dpr);
  if (canvas.width !== pixelSize) {
    canvas.width = pixelSize;
    canvas.height = pixelSize;
  }
  const lctx = canvas.getContext('2d');
  lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
  render(lctx, { ...state, view, selectedId: null }, LOUPE_SIZE, LOUPE_SIZE, {
    showScaleBar: false,
    sourceRect,
  });

  const center = LOUPE_SIZE / 2;
  lctx.strokeStyle = 'rgba(255, 45, 149, 0.9)';
  lctx.lineWidth = 1.5;
  lctx.beginPath();
  lctx.moveTo(center - 8, center);
  lctx.lineTo(center + 8, center);
  lctx.moveTo(center, center - 8);
  lctx.lineTo(center, center + 8);
  lctx.stroke();
  lctx.strokeStyle = 'rgba(255, 45, 149, 0.35)';
  lctx.beginPath();
  lctx.arc(center, center, 5, 0, Math.PI * 2);
  lctx.stroke();

  const half = LOUPE_SIZE / 2;
  let left = screen.x - half;
  let top = screen.y - LOUPE_SIZE - LOUPE_GAP;
  if (top < 8) top = screen.y + LOUPE_GAP;
  left = Math.max(8, Math.min(left, cssWidth - LOUPE_SIZE - 8));
  top = Math.max(8, Math.min(top, cssHeight - LOUPE_SIZE - 8));
  els.loupe.style.left = `${left}px`;
  els.loupe.style.top = `${top}px`;
  els.loupe.hidden = false;
}

function requestRender() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    paint();
  });
}

function afterChange() {
  requestRender();
  syncUI();
  scheduleSave();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 350);
}

async function persist() {
  if (!state.source || !state.source.blob) return;
  stashCurrentPage();
  try {
    await saveState({
      version: 1,
      kind: state.source.kind,
      name: state.source.name,
      page: state.source.page,
      sourceBlob: state.source.blob,
      view: state.view,
      snapLines: state.snapLines,
      pages: [...pageStore.entries()],
    });
  } catch (error) {
    console.warn('persist failed', error);
  }
}

function stashCurrentPage() {
  if (!state.source) return;
  pageStore.set(currentPageKey(), {
    calibration: state.calibration,
    measurements: state.measurements,
  });
}

function loadPageAnnotations() {
  const saved = pageStore.get(currentPageKey());
  state.calibration = saved?.calibration ?? null;
  state.measurements = saved?.measurements ?? [];
  state.selectedId = null;
}

function resize() {
  const rect = workspace.getBoundingClientRect();
  cssWidth = Math.max(1, rect.width);
  cssHeight = Math.max(1, rect.height);
  const dpr = window.devicePixelRatio || 1;
  els.canvas.width = Math.round(cssWidth * dpr);
  els.canvas.height = Math.round(cssHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  requestRender();
}

function fitViewToCanvas() {
  if (!state.source) return;
  cancelZoomAnimation();
  state.view = fitView(state.source.width, state.source.height, cssWidth, cssHeight);
}

function getScreenPoint(event) {
  const rect = els.canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function snapPoints() {
  const points = [];
  for (const measurement of state.measurements) points.push(measurement.a, measurement.b);
  if (state.calibration) points.push(state.calibration.a, state.calibration.b);
  return points;
}

function referenceDirections() {
  const directions = [0, Math.PI / 2];
  for (const measurement of state.measurements) {
    directions.push(segmentAngle(measurement.a, measurement.b));
  }
  if (state.calibration) directions.push(segmentAngle(state.calibration.a, state.calibration.b));
  return directions;
}

function resolvePoint(screen, startImage, shiftKey) {
  const transform = makeTransform(state.view);
  const raw = transform.toImage(screen);
  const tolerance = 10 / state.view.scale;
  const snapped = findSnapPoint(raw, snapPoints(), tolerance);
  if (snapped) return { point: snapped, snapped: true };
  if (shiftKey && startImage) return { point: constrainAngle(startImage, raw, 45), snapped: false };
  if (state.snapLines && startImage) {
    const result = snapToDirections(startImage, raw, referenceDirections(), 0.22);
    return { point: { x: result.x, y: result.y }, snapped: result.snapped };
  }
  return { point: raw, snapped: false };
}

function selectAt(imagePoint) {
  const tolerance = 8 / state.view.scale;
  let selected = null;
  let bestDistance = tolerance;
  for (const measurement of state.measurements) {
    const d = distanceToSegment(imagePoint, measurement.a, measurement.b);
    if (d <= bestDistance) {
      bestDistance = d;
      selected = measurement.id;
    }
  }
  if (state.calibration) {
    const d = distanceToSegment(imagePoint, state.calibration.a, state.calibration.b);
    if (d <= bestDistance) {
      bestDistance = d;
      selected = 'calibration';
    }
  }
  state.selectedId = selected;
  requestRender();
  syncUI();
}

function openConfirmDelete() {
  if (state.selectedId == null) return;
  els.confirmText.textContent =
    state.selectedId === 'calibration' ? 'Delete the calibration line?' : 'Delete this dimension?';
  els.confirmBackdrop.hidden = false;
  els.confirmOk.focus();
}

function closeConfirmDelete() {
  els.confirmBackdrop.hidden = true;
}

function confirmDelete() {
  const selected = state.selectedId;
  closeConfirmDelete();
  if (selected == null) return;
  pushHistory();
  if (selected === 'calibration') {
    state.calibration = null;
  } else {
    state.measurements = state.measurements.filter((m) => m.id !== selected);
  }
  state.selectedId = null;
  afterChange();
}

function clearDimensions() {
  if (!state.measurements.length) return;
  pushHistory();
  state.measurements = [];
  state.selectedId = null;
  afterChange();
}

function resetCalibration() {
  if (!state.calibration) return;
  pushHistory();
  state.calibration = null;
  afterChange();
}

function toast(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle('error', isError);
  els.status.classList.add('show');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => els.status.classList.remove('show'), 2600);
}

async function openFile(file) {
  try {
    toast('Loading…');
    const source = await createSource(file);
    if (state.source) releaseSource(state.source);
    state.source = source;
    pageStore.clear();
    history.length = 0;
    state.calibration = null;
    state.measurements = [];
    state.selectedId = null;
    state.preview = null;
    state.snap = null;
    state.view = { scale: 1, tx: 0, ty: 0 };
    fitViewToCanvas();
    afterChange();
    toast(`Loaded ${source.name}`);
  } catch (error) {
    console.error(error);
    toast('Could not load that file', true);
  }
}

async function changePage(delta) {
  if (!state.source || !state.source.pdfDoc) return;
  const target = state.source.page + delta;
  if (target < 1 || target > state.source.pageCount) return;
  stashCurrentPage();
  state.source = await goToPage(state.source, target);
  history.length = 0;
  loadPageAnnotations();
  afterChange();
}

function exportPng() {
  if (!state.source || !state.source.bitmap) return;
  const exportState = {
    ...state,
    view: { scale: 1, tx: 0, ty: 0 },
    selectedId: null,
    preview: null,
    snap: null,
  };
  const canvas = document.createElement('canvas');
  canvas.width = state.source.width;
  canvas.height = state.source.height;
  const exportCtx = canvas.getContext('2d');
  render(exportCtx, exportState, canvas.width, canvas.height, {
    background: '#ffffff',
    showScaleBar: false,
  });
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(state.source.name || 'plan').replace(/\.[^.]+$/, '')}-dimensions.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Exported PNG');
  }, 'image/png');
}

function openCalibrationDialog(a, b, screen) {
  pendingCalibration = { a, b };
  els.calibDialog.hidden = false;
  els.calibError.hidden = true;
  const rect = els.canvas.getBoundingClientRect();
  const width = els.calibDialog.offsetWidth || 250;
  const height = els.calibDialog.offsetHeight || 150;
  const x = Math.min(Math.max(8, rect.left + screen.x), window.innerWidth - width - 8);
  const y = Math.min(Math.max(8, rect.top + screen.y), window.innerHeight - height - 8);
  els.calibDialog.style.left = `${x}px`;
  els.calibDialog.style.top = `${y}px`;
  els.calibInput.value = '';
  els.calibInput.focus();
}

function closeCalibrationDialog() {
  els.calibDialog.hidden = true;
  els.calibError.hidden = true;
  pendingCalibration = null;
}

function confirmCalibration() {
  if (!pendingCalibration) return;
  const value = Number.parseFloat(els.calibInput.value.replace(',', '.'));
  const unit = els.calibUnit.value;
  try {
    const realMeters = toMeters(value, unit);
    const pxPerMeter = computePxPerMeter(pendingCalibration.a, pendingCalibration.b, realMeters);
    pushHistory();
    state.calibration = {
      a: pendingCalibration.a,
      b: pendingCalibration.b,
      realMeters,
      value,
      unit,
      pxPerMeter,
    };
    closeCalibrationDialog();
    afterChange();
    toast(`Scale set — ${pxPerMeter.toFixed(1)} px / m`);
  } catch (error) {
    els.calibError.textContent = error.message;
    els.calibError.hidden = false;
    els.calibInput.focus();
  }
}

function pointerPair() {
  if (activePointers.size < 2) return null;
  const [a, b] = [...activePointers.values()];
  return [a, b];
}

function beginGesture([p1, p2]) {
  hideLoupe();
  gesture = {
    startDistance: Math.max(1, distance(p1, p2)),
    startMid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
    startView: { ...state.view },
  };
}

function onPointerDown(event) {
  if (!state.source) return;
  cancelZoomAnimation();
  event.preventDefault();
  const screen = getScreenPoint(event);
  try {
    els.canvas.setPointerCapture(event.pointerId);
  } catch {
    // Synthetic or already-released pointers cannot be captured.
  }
  activePointers.set(event.pointerId, screen);

  const pair = pointerPair();
  if (pair) {
    drag = null;
    state.preview = null;
    state.snap = null;
    beginGesture(pair);
    requestRender();
    return;
  }

  const wantsPan = event.button === 1 || spaceDown || state.tool === 'select';
  if (wantsPan) {
    drag = {
      mode: 'pan',
      pointerId: event.pointerId,
      startScreen: screen,
      startView: { ...state.view },
      moved: false,
      wasSelect: state.tool === 'select',
    };
    els.canvas.style.cursor = 'grabbing';
    return;
  }

  const start = resolvePoint(screen, null, event.shiftKey);
  drag = {
    mode: state.tool,
    pointerId: event.pointerId,
    startImage: start.point,
    startScreen: screen,
    moved: false,
    touch: event.pointerType !== 'mouse',
  };
  state.preview = { a: start.point, b: start.point };
  state.snap = start.snapped ? start.point : null;
  requestRender();
  if (drag.touch) updateLoupe(screen, start.point);
}

function onPointerMove(event) {
  if (!state.source) return;
  const screen = getScreenPoint(event);
  if (activePointers.has(event.pointerId)) activePointers.set(event.pointerId, screen);

  if (gesture) {
    const pair = pointerPair();
    if (!pair) return;
    const [p1, p2] = pair;
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const factor = Math.max(1, distance(p1, p2)) / gesture.startDistance;
    const scale = Math.max(0.02, Math.min(80, gesture.startView.scale * factor));
    const imageX = (gesture.startMid.x - gesture.startView.tx) / gesture.startView.scale;
    const imageY = (gesture.startMid.y - gesture.startView.ty) / gesture.startView.scale;
    state.view = { scale, tx: mid.x - imageX * scale, ty: mid.y - imageY * scale };
    requestRender();
    return;
  }

  if (!drag) {
    if (state.tool === 'measure' || state.tool === 'calibrate') {
      const result = resolvePoint(screen, null, event.shiftKey);
      state.snap = result.snapped ? result.point : null;
      requestRender();
    }
    return;
  }

  if (drag.pointerId !== event.pointerId) return;

  if (drag.mode === 'pan') {
    const dx = screen.x - drag.startScreen.x;
    const dy = screen.y - drag.startScreen.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    state.view = {
      scale: drag.startView.scale,
      tx: drag.startView.tx + dx,
      ty: drag.startView.ty + dy,
    };
    requestRender();
    return;
  }

  const result = resolvePoint(screen, drag.startImage, event.shiftKey);
  drag.moved = true;
  state.preview = { a: drag.startImage, b: result.point };
  state.snap = result.snapped ? result.point : null;
  requestRender();
  if (drag.touch) updateLoupe(screen, result.point);
}

function onPointerUp(event) {
  activePointers.delete(event.pointerId);
  hideLoupe();

  if (gesture) {
    if (activePointers.size < 2) {
      gesture = null;
      drag = null;
      scheduleSave();
    }
    requestRender();
    return;
  }

  if (!drag || drag.pointerId !== event.pointerId) return;
  const screen = getScreenPoint(event);
  const finished = drag;
  drag = null;
  els.canvas.style.cursor = state.tool === 'select' ? 'grab' : 'crosshair';

  if (finished.mode === 'pan') {
    if (!finished.moved && finished.wasSelect) {
      selectAt(makeTransform(state.view).toImage(screen));
    } else {
      scheduleSave();
    }
    state.snap = null;
    requestRender();
    return;
  }

  const end = state.preview ? state.preview.b : finished.startImage;
  state.preview = null;
  state.snap = null;

  if (finished.mode === 'measure') {
    if (distance(finished.startImage, end) > 2) {
      pushHistory();
      state.measurements.push({ id: nextId++, a: finished.startImage, b: end });
      afterChange();
    } else {
      requestRender();
    }
    return;
  }

  if (finished.mode === 'calibrate') {
    if (distance(finished.startImage, end) > 4) {
      openCalibrationDialog(finished.startImage, end, screen);
    }
    requestRender();
  }
}

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 80;
const LOUPE_SIZE = 148;
const LOUPE_ZOOM = 2.5;
const LOUPE_GAP = 20;

function clampZoom(scale) {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
}

function normalizeWheelDelta(event) {
  let delta = event.deltaY;
  if (event.deltaMode === 1) delta *= 16;
  else if (event.deltaMode === 2) delta *= cssHeight || 800;
  return Math.max(-240, Math.min(240, delta));
}

function onWheel(event) {
  if (!state.source) return;
  event.preventDefault();
  const delta = normalizeWheelDelta(event);
  if (delta === 0) return;
  const screen = getScreenPoint(event);
  const baseScale = zoomGoal ? zoomGoal.scale : state.view.scale;
  const nextScale = clampZoom(baseScale * Math.exp(-delta * 0.0012));
  const anchor = makeTransform(state.view).toImage(screen);
  zoomGoal = {
    scale: nextScale,
    tx: screen.x - anchor.x * nextScale,
    ty: screen.y - anchor.y * nextScale,
  };
  startZoomAnimation();
}

function startZoomAnimation() {
  if (zoomFrame) return;
  const step = () => {
    zoomFrame = 0;
    if (!zoomGoal) return;
    const easing = 0.3;
    const scale = state.view.scale + (zoomGoal.scale - state.view.scale) * easing;
    const tx = state.view.tx + (zoomGoal.tx - state.view.tx) * easing;
    const ty = state.view.ty + (zoomGoal.ty - state.view.ty) * easing;
    state.view = { scale, tx, ty };
    paint();
    if (Math.abs(zoomGoal.scale - scale) > zoomGoal.scale * 0.001) {
      zoomFrame = requestAnimationFrame(step);
    } else {
      state.view = { ...zoomGoal };
      zoomGoal = null;
      paint();
      scheduleSave();
    }
  };
  zoomFrame = requestAnimationFrame(step);
}

function cancelZoomAnimation() {
  if (zoomFrame) cancelAnimationFrame(zoomFrame);
  zoomFrame = 0;
  zoomGoal = null;
}

function setTool(tool) {
  state.tool = tool;
  state.preview = null;
  state.snap = null;
  hideLoupe();
  els.canvas.style.cursor = tool === 'select' ? 'grab' : 'crosshair';
  syncUI();
}

function setSnapLines(value) {
  state.snapLines = value;
  els.snapToggle.setAttribute('aria-pressed', String(value));
  requestRender();
  scheduleSave();
}

function buildMeasurementList() {
  els.measurementList.textContent = '';
  state.measurements.forEach((measurement, index) => {
    const mm = pxToMm(distance(measurement.a, measurement.b), state.calibration?.pxPerMeter);
    const item = document.createElement('li');
    item.className = measurement.id === state.selectedId ? 'active' : '';
    item.dataset.id = String(measurement.id);

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = `#${index + 1}`;

    const value = document.createElement('span');
    value.className = 'value';
    value.textContent = state.calibration
      ? formatDimension(mm)
      : `${distance(measurement.a, measurement.b).toFixed(0)} px`;

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = '×';
    remove.title = 'Remove';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      pushHistory();
      state.measurements = state.measurements.filter((m) => m.id !== measurement.id);
      if (state.selectedId === measurement.id) state.selectedId = null;
      afterChange();
    });

    item.append(idx, value, remove);
    item.addEventListener('click', () => {
      state.selectedId = measurement.id;
      requestRender();
      syncUI();
    });
    els.measurementList.append(item);
  });
}

function syncUI() {
  for (const button of els.toolButtons) {
    button.classList.toggle('active', button.dataset.tool === state.tool);
  }

  els.snapToggle.setAttribute('aria-pressed', String(state.snapLines));

  els.zoomInfo.textContent = `${Math.round(state.view.scale * 100)}%`;

  const isPdf = state.source?.kind === 'pdf';
  document.body.classList.toggle('has-pdf', isPdf);
  els.pageInfo.textContent = isPdf ? `${state.source.page} / ${state.source.pageCount}` : '–';
  els.pagePrev.disabled = !isPdf || state.source.page <= 1;
  els.pageNext.disabled = !isPdf || state.source.page >= state.source.pageCount;

  if (state.calibration) {
    const { pxPerMeter, unit, value } = state.calibration;
    const mmPerPx = 1000 / pxPerMeter;
    els.calibrateStatus.className = 'badge ok';
    els.calibrateStatus.textContent = `${formatLength(value, unit)} = ${pxPerMeter.toFixed(2)} px · ${mmPerPx.toFixed(3)} mm/px`;
    els.resetCalibration.hidden = false;
  } else {
    els.calibrateStatus.className = 'badge warn';
    els.calibrateStatus.textContent = 'Not calibrated';
    els.resetCalibration.hidden = true;
  }

  els.measureCount.textContent = String(state.measurements.length);
  els.panelCount.textContent = String(state.measurements.length);
  els.panelCount.hidden = state.measurements.length === 0;
  buildMeasurementList();

  if (state.calibration && state.measurements.length > 1) {
    const total = state.measurements.reduce(
      (sum, m) => sum + pxToMm(distance(m.a, m.b), state.calibration.pxPerMeter),
      0,
    );
    els.totalValue.textContent = formatDimension(total);
    els.totalRow.hidden = false;
  } else {
    els.totalRow.hidden = true;
  }

  els.undoBtn.disabled = history.length === 0;
  els.deleteBtn.disabled = state.selectedId == null;
  els.clearBtn.disabled = state.measurements.length === 0;
  els.exportBtn.disabled = !state.source;
}

async function restore() {
  try {
    const saved = await loadState();
    if (!saved || !saved.sourceBlob) return;
    const file = new File([saved.sourceBlob], saved.name || 'plan', {
      type: saved.sourceBlob.type || '',
    });
    let source = await createSource(file);
    if (saved.kind === 'pdf' && saved.page > 1) source = await goToPage(source, saved.page);
    state.source = source;
    pageStore.clear();
    for (const [page, annotations] of saved.pages || []) pageStore.set(page, annotations);
    state.view = saved.view || { scale: 1, tx: 0, ty: 0 };
    state.snapLines = saved.snapLines ?? false;
    loadPageAnnotations();
    requestRender();
    syncUI();
    toast('Restored last session');
  } catch (error) {
    console.warn('restore failed', error);
  }
}

function setPanelVisible(visible) {
  document.body.classList.toggle('panel-hidden', !visible);
  els.panelToggle.setAttribute('aria-pressed', String(visible));
}

function bindEvents() {
  els.openBtn.addEventListener('click', () => els.fileInput.click());
  els.panelToggle.addEventListener('click', () =>
    setPanelVisible(document.body.classList.contains('panel-hidden')),
  );
  els.panelClose.addEventListener('click', () => setPanelVisible(false));
  els.fileInput.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) openFile(file);
    event.target.value = '';
  });

  for (const button of els.toolButtons) {
    button.addEventListener('click', () => setTool(button.dataset.tool));
  }

  els.pagePrev.addEventListener('click', () => changePage(-1));
  els.pageNext.addEventListener('click', () => changePage(1));
  els.fitBtn.addEventListener('click', () => {
    fitViewToCanvas();
    afterChange();
  });
  els.undoBtn.addEventListener('click', undo);
  els.deleteBtn.addEventListener('click', openConfirmDelete);
  els.clearBtn.addEventListener('click', clearDimensions);
  els.exportBtn.addEventListener('click', exportPng);
  els.resetCalibration.addEventListener('click', resetCalibration);

  els.snapToggle.addEventListener('click', () => setSnapLines(!state.snapLines));
  els.deleteHandle.addEventListener('click', openConfirmDelete);
  els.confirmOk.addEventListener('click', confirmDelete);
  els.confirmCancel.addEventListener('click', closeConfirmDelete);
  els.confirmBackdrop.addEventListener('click', (event) => {
    if (event.target === els.confirmBackdrop) closeConfirmDelete();
  });

  els.calibOk.addEventListener('click', confirmCalibration);
  els.calibCancel.addEventListener('click', closeCalibrationDialog);
  els.calibInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') confirmCalibration();
    if (event.key === 'Escape') closeCalibrationDialog();
  });

  els.canvas.addEventListener('pointerdown', onPointerDown);
  els.canvas.addEventListener('pointermove', onPointerMove);
  els.canvas.addEventListener('pointerup', onPointerUp);
  els.canvas.addEventListener('pointercancel', onPointerUp);
  els.canvas.addEventListener('wheel', onWheel, { passive: false });
  els.canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (!els.confirmBackdrop.hidden) {
      if (event.key === 'Escape') {
        closeConfirmDelete();
        event.preventDefault();
      }
      return;
    }
    if (event.code === 'Space') {
      spaceDown = true;
      if (!drag) els.canvas.style.cursor = 'grab';
      event.preventDefault();
      return;
    }
    if (event.key === '1') setTool('select');
    else if (event.key === '2') setTool('calibrate');
    else if (event.key === '3') setTool('measure');
    else if (event.key === 's' || event.key === 'S') setSnapLines(!state.snapLines);
    else if (event.key === 'f' || event.key === 'F') {
      fitViewToCanvas();
      afterChange();
    } else if (event.key === 'h' || event.key === 'H') {
      setPanelVisible(document.body.classList.contains('panel-hidden'));
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      openConfirmDelete();
      event.preventDefault();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      undo();
      event.preventDefault();
    } else if (event.key === 'Escape') {
      closeCalibrationDialog();
      if (drag) {
        drag = null;
        state.preview = null;
        state.snap = null;
        hideLoupe();
        requestRender();
      }
    }
  });

  window.addEventListener('keyup', (event) => {
    if (event.code === 'Space') {
      spaceDown = false;
      els.canvas.style.cursor = state.tool === 'select' ? 'grab' : 'crosshair';
    }
  });

  new ResizeObserver(resize).observe(workspace);
}

function init() {
  bindEvents();
  resize();
  els.canvas.style.cursor = 'grab';
  setPanelVisible(false);
  syncUI();
  restore();
}

init();
