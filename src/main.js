import {
  constrainAngle,
  computePxPerMeter,
  distance,
  distanceToSegment,
  findSnapPoint,
  formatArea,
  formatDimension,
  formatLength,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  polygonEdgeDistance,
  pxToMm,
  segmentAngle,
  snapToDirections,
  toMeters,
} from './measure.js';
import { fitView, makeTransform } from './viewport.js';
import { render } from './render.js';
import { createSource, goToPage, releaseSource } from './source.js';
import { loadState, saveState, closeState } from './persistence.js';
import { DEFAULT_LAYER_VISIBILITY, isLayerVisible, resolveLayerVisibility } from './layers.js';
import {
  OPENING_TYPES,
  SPACE_TYPES,
  WALL_TYPES,
  computeQuantities,
  quantitiesToRows,
  toCsv,
  wallType,
} from './model.js';

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
  loading: document.getElementById('loading'),
  loadingText: document.getElementById('loadingText'),
  toolButtons: [...document.querySelectorAll('button.tool')],
  pagePrev: document.getElementById('pagePrev'),
  pageNext: document.getElementById('pageNext'),
  pageInfo: document.getElementById('pageInfo'),
  zoomInfo: document.getElementById('zoomInfo'),
  fitBtn: document.getElementById('fitBtn'),
  undoBtn: document.getElementById('undoBtn'),
  deleteBtn: document.getElementById('deleteBtn'),
  clearMeasureBtn: document.getElementById('clearMeasureBtn'),
  clearAreaBtn: document.getElementById('clearAreaBtn'),
  clearWallBtn: document.getElementById('clearWallBtn'),
  clearOpeningBtn: document.getElementById('clearOpeningBtn'),
  layerMeasureToggle: document.getElementById('layerMeasureToggle'),
  layerAreaToggle: document.getElementById('layerAreaToggle'),
  layerWallToggle: document.getElementById('layerWallToggle'),
  layerOpeningToggle: document.getElementById('layerOpeningToggle'),
  measureSection: document.getElementById('measureSection'),
  areaSection: document.getElementById('areaSection'),
  wallSection: document.getElementById('wallSection'),
  openingSection: document.getElementById('openingSection'),
  spaceType: document.getElementById('spaceType'),
  wallType: document.getElementById('wallType'),
  wallThickness: document.getElementById('wallThickness'),
  openingType: document.getElementById('openingType'),
  wallCount: document.getElementById('wallCount'),
  wallList: document.getElementById('wallList'),
  wallTotalRow: document.getElementById('wallTotalRow'),
  wallTotal: document.getElementById('wallTotal'),
  openingCount: document.getElementById('openingCount'),
  openingList: document.getElementById('openingList'),
  quantities: document.getElementById('quantities'),
  exportCsv: document.getElementById('exportCsv'),
  exportBtn: document.getElementById('exportBtn'),
  calibrateStatus: document.getElementById('calibrateStatus'),
  resetCalibration: document.getElementById('resetCalibration'),
  knownValue: document.getElementById('knownValue'),
  knownUnit: document.getElementById('knownUnit'),
  knownSet: document.getElementById('knownSet'),
  originLabel: document.getElementById('originLabel'),
  exportProject: document.getElementById('exportProject'),
  importProject: document.getElementById('importProject'),
  projectInput: document.getElementById('projectInput'),
  measurementList: document.getElementById('measurementList'),
  measureCount: document.getElementById('measureCount'),
  totalRow: document.getElementById('totalRow'),
  totalValue: document.getElementById('totalValue'),
  areaList: document.getElementById('areaList'),
  areaCount: document.getElementById('areaCount'),
  areaTotalRow: document.getElementById('areaTotalRow'),
  areaTotal: document.getElementById('areaTotal'),
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
  areas: [],
  walls: [],
  openings: [],
  selectedId: null,
  preview: null,
  snap: null,
  areaDraft: [],
  areaCursor: null,
  tool: 'select',
  snapLines: false,
  layerVisibility: { ...DEFAULT_LAYER_VISIBILITY },
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
let pendingSave = Promise.resolve();
let statusTimer = null;

function currentPageKey() {
  return state.source && state.source.kind === 'pdf' ? state.source.page : 1;
}

function layerVisible(layer) {
  return isLayerVisible(state.layerVisibility, layer);
}

function snapshot() {
  return {
    calibration: state.calibration
      ? { ...state.calibration, a: { ...state.calibration.a }, b: { ...state.calibration.b } }
      : null,
    measurements: state.measurements.map((m) => ({ ...m, a: { ...m.a }, b: { ...m.b } })),
    areas: state.areas.map((a) => ({ ...a, points: a.points.map((p) => ({ ...p })) })),
    walls: state.walls.map((w) => ({ ...w, a: { ...w.a }, b: { ...w.b } })),
    openings: state.openings.map((o) => ({ ...o, a: { ...o.a }, b: { ...o.b } })),
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
  state.areas = previous.areas ?? [];
  state.walls = previous.walls ?? [];
  state.openings = previous.openings ?? [];
  state.selectedId = null;
  afterChange();
}

function syncZoom() {
  els.zoomInfo.textContent = `${Math.round(state.view.scale * 100)}%`;
}

function positionDeleteHandle() {
  const selected = state.selectedId;
  if (selected == null || !state.source) {
    els.deleteHandle.hidden = true;
    return;
  }
  const transform = makeTransform(state.view);
  let handle = null;

  if (selected === 'calibration' && state.calibration) {
    const a = transform.toScreen(state.calibration.a);
    const b = transform.toScreen(state.calibration.b);
    let ox = Math.cos(segmentAngle(state.calibration.a, state.calibration.b) + Math.PI / 2);
    let oy = Math.sin(segmentAngle(state.calibration.a, state.calibration.b) + Math.PI / 2);
    if (oy < 0) {
      ox = -ox;
      oy = -oy;
    }
    handle = { x: (a.x + b.x) / 2 + ox * 48, y: (a.y + b.y) / 2 + oy * 48 };
  } else if (typeof selected === 'number') {
    const area = state.areas.find((a) => a.id === selected);
    if (area) {
      const center = transform.toScreen(polygonCentroid(area.points));
      handle = { x: center.x, y: center.y };
    } else {
      const measurement = findSegment(selected);
      if (measurement) {
        const a = transform.toScreen(measurement.a);
        const b = transform.toScreen(measurement.b);
        let ox = Math.cos(segmentAngle(measurement.a, measurement.b) + Math.PI / 2);
        let oy = Math.sin(segmentAngle(measurement.a, measurement.b) + Math.PI / 2);
        if (oy < 0) {
          ox = -ox;
          oy = -oy;
        }
        handle = { x: (a.x + b.x) / 2 + ox * 48, y: (a.y + b.y) / 2 + oy * 48 };
      }
    }
  }

  if (!handle) {
    els.deleteHandle.hidden = true;
    return;
  }
  els.deleteHandle.style.left = `${handle.x}px`;
  els.deleteHandle.style.top = `${handle.y}px`;
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
  persist();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist();
  }, 350);
}

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    persist();
  }
  return pendingSave.finally(closeState);
}

function persist() {
  if (!state.source || !state.source.blob) return pendingSave;
  stashCurrentPage();
  const payload = {
    version: 1,
    kind: state.source.kind,
    name: state.source.name,
    page: state.source.page,
    sourceType: state.source.blob.type || '',
    view: state.view,
    snapLines: state.snapLines,
    layers: state.layerVisibility,
    pages: [...pageStore.entries()],
  };
  // Store raw bytes as an ArrayBuffer. WebKit can evict the backing file of a
  // Blob kept in IndexedDB, which then throws NotFoundError ("The object can
  // not be found here") on restore. Fall back to the Blob for old records.
  if (state.source.buffer) payload.sourceBuffer = state.source.buffer;
  else payload.sourceBlob = state.source.blob;
  pendingSave = saveState(payload).catch((error) => {
    console.warn('persist failed', error && (error.message || error), error);
  });
  return pendingSave;
}

function stashCurrentPage() {
  if (!state.source) return;
  pageStore.set(currentPageKey(), {
    calibration: state.calibration,
    measurements: state.measurements,
    areas: state.areas,
    walls: state.walls,
    openings: state.openings,
  });
}

function loadPageAnnotations() {
  const saved = pageStore.get(currentPageKey());
  state.calibration = saved?.calibration ?? null;
  state.measurements = saved?.measurements ?? [];
  state.areas = saved?.areas ?? [];
  state.walls = saved?.walls ?? [];
  state.openings = saved?.openings ?? [];
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

function snapPoints(excludeId = null) {
  const points = [];
  if (layerVisible('measure')) {
    for (const measurement of state.measurements) {
      if (measurement.id !== excludeId) points.push(measurement.a, measurement.b);
    }
    if (state.calibration) points.push(state.calibration.a, state.calibration.b);
  }
  if (layerVisible('area')) {
    for (const area of state.areas) points.push(...area.points);
    points.push(...state.areaDraft);
  }
  if (layerVisible('wall')) {
    for (const wall of state.walls) {
      if (wall.id !== excludeId) points.push(wall.a, wall.b);
    }
  }
  if (layerVisible('opening')) {
    for (const opening of state.openings) {
      if (opening.id !== excludeId) points.push(opening.a, opening.b);
    }
  }
  return points;
}

function referenceDirections(excludeId = null) {
  const directions = [0, Math.PI / 2];
  if (layerVisible('measure')) {
    for (const measurement of state.measurements) {
      if (measurement.id !== excludeId) directions.push(segmentAngle(measurement.a, measurement.b));
    }
    if (state.calibration) directions.push(segmentAngle(state.calibration.a, state.calibration.b));
  }
  if (layerVisible('wall')) {
    for (const wall of state.walls) {
      if (wall.id !== excludeId) directions.push(segmentAngle(wall.a, wall.b));
    }
  }
  if (layerVisible('opening')) {
    for (const opening of state.openings) {
      if (opening.id !== excludeId) directions.push(segmentAngle(opening.a, opening.b));
    }
  }
  return directions;
}

function resolvePoint(screen, startImage, shiftKey, excludeId = null) {
  const transform = makeTransform(state.view);
  const raw = transform.toImage(screen);
  const tolerance = 10 / state.view.scale;
  const snapped = findSnapPoint(raw, snapPoints(excludeId), tolerance);
  if (snapped) return { point: snapped, snapped: true };
  if (shiftKey && startImage) return { point: constrainAngle(startImage, raw, 45), snapped: false };
  if (state.snapLines && startImage) {
    const result = snapToDirections(startImage, raw, referenceDirections(excludeId), 0.22);
    return { point: { x: result.x, y: result.y }, snapped: result.snapped };
  }
  return { point: raw, snapped: false };
}

function findArea(id) {
  return state.areas.find((area) => area.id === id) || null;
}

function findMeasurement(id) {
  return state.measurements.find((measurement) => measurement.id === id) || null;
}

function findWall(id) {
  return state.walls.find((wall) => wall.id === id) || null;
}

function findOpening(id) {
  return state.openings.find((opening) => opening.id === id) || null;
}

function findSegment(id) {
  return findMeasurement(id) || findWall(id) || findOpening(id) || null;
}

function findElement(id) {
  return findSegment(id) || findArea(id) || null;
}

function setScaleFromSelected() {
  const measurement = typeof state.selectedId === 'number' ? findMeasurement(state.selectedId) : null;
  if (!measurement) {
    toast('Select a dimension first', true);
    return;
  }
  const value = Number.parseFloat(els.knownValue.value.replace(',', '.'));
  const unit = els.knownUnit.value;
  try {
    const realMeters = toMeters(value, unit);
    const pxPerMeter = computePxPerMeter(measurement.a, measurement.b, realMeters);
    pushHistory();
    state.calibration = {
      a: { ...measurement.a },
      b: { ...measurement.b },
      realMeters,
      value,
      unit,
      pxPerMeter,
      source: 'known',
    };
    afterChange();
    toast('Scale set from the selected dimension');
  } catch (error) {
    toast(error.message, true);
  }
}

function selectedLabel() {
  if (state.selectedId === 'calibration') return 'calibration line';
  if (findArea(state.selectedId)) return 'space';
  if (findWall(state.selectedId)) return 'wall';
  if (findOpening(state.selectedId)) return 'opening';
  return 'dimension';
}

function selectAt(imagePoint) {
  const tolerance = 8 / state.view.scale;
  let selected = null;
  let bestDistance = tolerance;
  if (layerVisible('measure')) {
    for (const measurement of state.measurements) {
      const d = distanceToSegment(imagePoint, measurement.a, measurement.b);
      if (d <= bestDistance) {
        bestDistance = d;
        selected = measurement.id;
      }
    }
  }
  if (layerVisible('area')) {
    for (const area of state.areas) {
      const d = polygonEdgeDistance(imagePoint, area.points);
      const inside = pointInPolygon(imagePoint, area.points);
      if (inside || d <= bestDistance) {
        bestDistance = inside ? 0 : d;
        selected = area.id;
      }
    }
  }
  if (layerVisible('wall')) {
    for (const wall of state.walls) {
      const d = distanceToSegment(imagePoint, wall.a, wall.b);
      if (d <= bestDistance) {
        bestDistance = d;
        selected = wall.id;
      }
    }
  }
  if (layerVisible('opening')) {
    for (const opening of state.openings) {
      const d = distanceToSegment(imagePoint, opening.a, opening.b);
      if (d <= bestDistance) {
        bestDistance = d;
        selected = opening.id;
      }
    }
  }
  if (layerVisible('measure') && state.calibration) {
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
  els.confirmText.textContent = `Delete this ${selectedLabel()}?`;
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
  } else if (findArea(selected)) {
    state.areas = state.areas.filter((area) => area.id !== selected);
  } else if (findWall(selected)) {
    state.walls = state.walls.filter((wall) => wall.id !== selected);
  } else if (findOpening(selected)) {
    state.openings = state.openings.filter((opening) => opening.id !== selected);
  } else {
    state.measurements = state.measurements.filter((m) => m.id !== selected);
  }
  state.selectedId = null;
  afterChange();
}

function clearLayerSelection(layer) {
  if (layer === 'measure' && (state.selectedId === 'calibration' || findMeasurement(state.selectedId))) {
    state.selectedId = null;
  }
  if (layer === 'area' && findArea(state.selectedId)) {
    state.selectedId = null;
  }
  if (layer === 'wall' && findWall(state.selectedId)) {
    state.selectedId = null;
  }
  if (layer === 'opening' && findOpening(state.selectedId)) {
    state.selectedId = null;
  }
}

function setLayerVisible(layer, visible) {
  if (layerVisible(layer) === visible) return;
  state.layerVisibility = { ...state.layerVisibility, [layer]: visible };
  if (!visible) clearLayerSelection(layer);
  afterChange();
}

function toggleLayer(layer) {
  setLayerVisible(layer, !layerVisible(layer));
}

function clearMeasurements() {
  if (!state.measurements.length) return;
  pushHistory();
  state.measurements = [];
  if (findMeasurement(state.selectedId)) state.selectedId = null;
  afterChange();
}

function clearAreas() {
  if (!state.areas.length) return;
  pushHistory();
  state.areas = [];
  if (findArea(state.selectedId)) state.selectedId = null;
  afterChange();
}

function clearWalls() {
  if (!state.walls.length) return;
  pushHistory();
  state.walls = [];
  if (findWall(state.selectedId)) state.selectedId = null;
  afterChange();
}

function clearOpenings() {
  if (!state.openings.length) return;
  pushHistory();
  state.openings = [];
  if (findOpening(state.selectedId)) state.selectedId = null;
  afterChange();
}

function currentWallThickness() {
  return readNumber(els.wallThickness, 0);
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

function maybeCommitArea() {
  if (state.areaDraft.length >= 3) {
    commitArea();
    return true;
  }
  if (state.areaDraft.length) {
    cancelArea();
    return true;
  }
  return false;
}

function areaText(points) {
  if (state.calibration) {
    const squareMeters = polygonArea(points) / (state.calibration.pxPerMeter * state.calibration.pxPerMeter);
    return formatArea(squareMeters);
  }
  return `${polygonArea(points).toFixed(0)} px²`;
}

function commitArea() {
  if (state.areaDraft.length < 3) {
    cancelArea();
    return;
  }
  pushHistory();
  state.areas.push({
    id: nextId++,
    points: state.areaDraft.map((point) => ({ ...point })),
    name: '',
    type: els.spaceType.value || 'medicion',
  });
  state.areaDraft = [];
  state.areaCursor = null;
  state.snap = null;
  afterChange();
}

function cancelArea() {
  state.areaDraft = [];
  state.areaCursor = null;
  state.snap = null;
  requestRender();
  syncUI();
}

function handleAreaTap(screen) {
  const result = resolvePoint(screen, null, false);
  const point = result.point;
  if (!state.areaDraft.length) {
    state.areaDraft = [point];
    state.areaCursor = point;
    state.snap = null;
    requestRender();
    syncUI();
    return;
  }
  const first = state.areaDraft[0];
  const tolerance = 14 / state.view.scale;
  if (state.areaDraft.length >= 3 && distance(point, first) <= tolerance) {
    commitArea();
    return;
  }
  state.areaDraft.push(point);
  state.areaCursor = point;
  state.snap = null;
  requestRender();
  syncUI();
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
    state.areas = [];
    state.walls = [];
    state.openings = [];
    state.areaDraft = [];
    state.areaCursor = null;
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

  const forcePan = event.button === 1 || spaceDown;
  if (!forcePan && state.tool === 'select') {
    const measurement = typeof state.selectedId === 'number' ? findSegment(state.selectedId) : null;
    if (measurement) {
      const transform = makeTransform(state.view);
      const a = transform.toScreen(measurement.a);
      const b = transform.toScreen(measurement.b);
      const hitRadius = 16;
      const touch = event.pointerType !== 'mouse';
      if (distance(screen, a) <= hitRadius) {
        drag = { mode: 'edit', id: measurement.id, endpoint: 'a', pointerId: event.pointerId, moved: false, touch };
        return;
      }
      if (distance(screen, b) <= hitRadius) {
        drag = { mode: 'edit', id: measurement.id, endpoint: 'b', pointerId: event.pointerId, moved: false, touch };
        return;
      }
      const image = transform.toImage(screen);
      if (distanceToSegment(image, measurement.a, measurement.b) <= 12 / state.view.scale) {
        drag = {
          mode: 'editBody',
          id: measurement.id,
          pointerId: event.pointerId,
          startImage: image,
          original: { a: { ...measurement.a }, b: { ...measurement.b } },
          moved: false,
          touch,
        };
        return;
      }
    }
  }

  const wantsPan = forcePan || state.tool === 'select';
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

  if (state.tool === 'area') {
    drag = {
      mode: 'area',
      pointerId: event.pointerId,
      startScreen: screen,
      startView: { ...state.view },
      moved: false,
    };
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
    } else if (state.tool === 'area') {
      const result = resolvePoint(screen, null, event.shiftKey);
      state.areaCursor = result.point;
      state.snap = result.snapped ? result.point : null;
      requestRender();
    }
    return;
  }

  if (drag.pointerId !== event.pointerId) return;

  if (drag.mode === 'edit') {
    const measurement = findSegment(drag.id);
    if (!measurement) return;
    const other = drag.endpoint === 'a' ? measurement.b : measurement.a;
    const result = resolvePoint(screen, other, event.shiftKey, drag.id);
    if (!drag.moved) {
      pushHistory();
      drag.moved = true;
    }
    measurement[drag.endpoint] = result.point;
    state.snap = result.snapped ? result.point : null;
    requestRender();
    syncUI();
    if (drag.touch) updateLoupe(screen, result.point);
    return;
  }

  if (drag.mode === 'editBody') {
    const measurement = findSegment(drag.id);
    if (!measurement) return;
    const image = makeTransform(state.view).toImage(screen);
    const dx = image.x - drag.startImage.x;
    const dy = image.y - drag.startImage.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 0) {
      pushHistory();
      drag.moved = true;
    }
    measurement.a = { x: drag.original.a.x + dx, y: drag.original.a.y + dy };
    measurement.b = { x: drag.original.b.x + dx, y: drag.original.b.y + dy };
    requestRender();
    syncUI();
    return;
  }

  if (drag.mode === 'area') {
    const dx = screen.x - drag.startScreen.x;
    const dy = screen.y - drag.startScreen.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) {
      drag.moved = true;
      state.view = {
        scale: drag.startView.scale,
        tx: drag.startView.tx + dx,
        ty: drag.startView.ty + dy,
      };
      requestRender();
    }
    return;
  }

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

  if (finished.mode === 'edit' || finished.mode === 'editBody') {
    state.snap = null;
    afterChange();
    return;
  }

  if (finished.mode === 'area') {
    if (!finished.moved) handleAreaTap(finished.startScreen);
    return;
  }

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

  if (finished.mode === 'wall') {
    if (distance(finished.startImage, end) > 2) {
      pushHistory();
      state.walls.push({
        id: nextId++,
        a: finished.startImage,
        b: end,
        type: els.wallType.value,
        thickness: currentWallThickness(),
      });
      afterChange();
    } else {
      requestRender();
    }
    return;
  }

  if (finished.mode === 'opening') {
    if (distance(finished.startImage, end) > 2) {
      pushHistory();
      state.openings.push({
        id: nextId++,
        a: finished.startImage,
        b: end,
        type: els.openingType.value,
      });
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
  const leavingArea = state.tool === 'area' && tool !== 'area';
  state.tool = tool;
  state.preview = null;
  state.snap = null;
  hideLoupe();
  els.canvas.style.cursor = tool === 'select' ? 'grab' : 'crosshair';
  if (leavingArea && state.areaDraft.length) {
    maybeCommitArea();
  }
  if (tool === 'measure' || tool === 'calibrate') setLayerVisible('measure', true);
  if (tool === 'area') setLayerVisible('area', true);
  if (tool === 'wall') setLayerVisible('wall', true);
  if (tool === 'opening') setLayerVisible('opening', true);
  if (tool === 'area' && !state.areaDraft.length) {
    toast('Tap points on the plan, then tap the first point to close');
  }
  if (tool === 'wall' && !state.walls.length) {
    toast('Drag along a wall; thickness comes from the Walls panel');
  }
  if (tool === 'opening' && !state.openings.length) {
    toast('Drag across a door or window to measure its width');
  }
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

function readNumber(input, fallback = 0) {
  const value = Number.parseFloat((input.value || '').replace(',', '.'));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function makeRemoveButton(onRemove) {
  const remove = document.createElement('button');
  remove.className = 'remove';
  remove.textContent = '×';
  remove.title = 'Remove';
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    onRemove();
  });
  return remove;
}

function makeSelect(options, value, onSelect) {
  const select = document.createElement('select');
  for (const option of options) {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    select.append(opt);
  }
  select.value = value;
  select.addEventListener('click', (event) => event.stopPropagation());
  select.addEventListener('change', () => onSelect(select.value));
  return select;
}

function buildAreaList() {
  els.areaList.textContent = '';
  state.areas.forEach((area, index) => {
    const item = document.createElement('li');
    item.className = area.id === state.selectedId ? 'active' : '';

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = `#${index + 1}`;

    const name = document.createElement('input');
    name.className = 'name';
    name.type = 'text';
    name.placeholder = 'Name';
    name.value = area.name || '';
    name.addEventListener('click', (event) => event.stopPropagation());
    name.addEventListener('change', () => {
      pushHistory();
      area.name = name.value.trim();
      afterChange();
    });

    const remove = makeRemoveButton(() => {
      pushHistory();
      state.areas = state.areas.filter((a) => a.id !== area.id);
      if (state.selectedId === area.id) state.selectedId = null;
      afterChange();
    });

    const meta = document.createElement('div');
    meta.className = 'meta';
    const type = makeSelect(SPACE_TYPES, area.type || 'medicion', (value) => {
      pushHistory();
      area.type = value;
      afterChange();
    });
    const metric = document.createElement('span');
    metric.className = 'metric';
    metric.textContent = areaText(area.points);
    meta.append(type, metric);

    item.append(idx, name, remove, meta);
    item.addEventListener('click', () => {
      state.selectedId = area.id;
      requestRender();
      syncUI();
    });
    els.areaList.append(item);
  });
}

function buildWallList() {
  els.wallList.textContent = '';
  const pxPerMeter = state.calibration?.pxPerMeter;
  state.walls.forEach((wall, index) => {
    const item = document.createElement('li');
    item.className = wall.id === state.selectedId ? 'active' : '';

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = `#${index + 1}`;

    const type = makeSelect(WALL_TYPES, wall.type || 'tabique', (value) => {
      pushHistory();
      wall.type = value;
      afterChange();
    });

    const remove = makeRemoveButton(() => {
      pushHistory();
      state.walls = state.walls.filter((w) => w.id !== wall.id);
      if (state.selectedId === wall.id) state.selectedId = null;
      afterChange();
    });

    const meta = document.createElement('div');
    meta.className = 'meta';
    const thickness = document.createElement('input');
    thickness.className = 'num';
    thickness.type = 'number';
    thickness.min = '0';
    thickness.step = '1';
    thickness.value = String(wall.thickness ?? 0);
    thickness.title = 'Thickness (mm)';
    thickness.addEventListener('click', (event) => event.stopPropagation());
    thickness.addEventListener('change', () => {
      pushHistory();
      wall.thickness = readNumber(thickness, wall.thickness || 0);
      afterChange();
    });
    const unit = document.createElement('span');
    unit.className = 'field-unit';
    unit.textContent = 'mm';
    const metric = document.createElement('span');
    metric.className = 'metric';
    const mm = pxToMm(distance(wall.a, wall.b), pxPerMeter);
    metric.textContent = state.calibration ? formatDimension(mm) : 'no scale';
    meta.append(thickness, unit, metric);

    item.append(idx, type, remove, meta);
    item.addEventListener('click', () => {
      state.selectedId = wall.id;
      requestRender();
      syncUI();
    });
    els.wallList.append(item);
  });
}

function buildOpeningList() {
  els.openingList.textContent = '';
  const pxPerMeter = state.calibration?.pxPerMeter;
  state.openings.forEach((opening, index) => {
    const item = document.createElement('li');
    item.className = opening.id === state.selectedId ? 'active' : '';

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = `#${index + 1}`;

    const type = makeSelect(OPENING_TYPES, opening.type || 'puerta', (value) => {
      pushHistory();
      opening.type = value;
      afterChange();
    });

    const remove = makeRemoveButton(() => {
      pushHistory();
      state.openings = state.openings.filter((o) => o.id !== opening.id);
      if (state.selectedId === opening.id) state.selectedId = null;
      afterChange();
    });

    const meta = document.createElement('div');
    meta.className = 'meta';
    const metric = document.createElement('span');
    metric.className = 'metric';
    const mm = pxToMm(distance(opening.a, opening.b), pxPerMeter);
    metric.textContent = state.calibration ? formatDimension(mm) : 'no scale';
    meta.append(metric);

    item.append(idx, type, remove, meta);
    item.addEventListener('click', () => {
      state.selectedId = opening.id;
      requestRender();
      syncUI();
    });
    els.openingList.append(item);
  });
}

function buildQuantities() {
  const q = computeQuantities(state);
  const rows = [];
  if (!q.calibrated) {
    rows.push(['q-section', 'Not calibrated — values in mm² and m are unavailable']);
  }
  rows.push(['q-label', 'Useful area'], ['q-value', `${q.usefulArea.toFixed(2)} m²`]);
  rows.push(['q-label', 'Wall footprint'], ['q-value', `${q.wallArea.toFixed(2)} m²`]);
  rows.push(['q-label', 'Built area (est.)'], ['q-value', `${q.builtArea.toFixed(2)} m²`]);
  rows.push(['q-label', 'Measured area'], ['q-value', `${q.measuredArea.toFixed(2)} m²`]);
  rows.push(['q-label', 'Wall length'], ['q-value', `${q.wallLength.toFixed(2)} m`]);
  rows.push(['q-label', 'Openings'], ['q-value', `${q.openingCount}`]);
  els.quantities.textContent = '';
  for (const [cls, text] of rows) {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    els.quantities.append(span);
  }
}

function syncUI() {
  for (const button of els.toolButtons) {
    button.classList.toggle('active', button.dataset.tool === state.tool);
  }

  els.snapToggle.setAttribute('aria-pressed', String(state.snapLines));

  for (const [layer, toggle, section] of [
    ['measure', els.layerMeasureToggle, els.measureSection],
    ['area', els.layerAreaToggle, els.areaSection],
    ['wall', els.layerWallToggle, els.wallSection],
    ['opening', els.layerOpeningToggle, els.openingSection],
  ]) {
    const visible = layerVisible(layer);
    toggle.setAttribute('aria-pressed', String(visible));
    toggle.textContent = visible ? 'Hide' : 'Show';
    section.classList.toggle('layer-hidden', !visible);
  }

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

  els.knownSet.disabled = !(typeof state.selectedId === 'number' && findMeasurement(state.selectedId));

  const annotationCount =
    state.measurements.length + state.areas.length + state.walls.length + state.openings.length;
  els.measureCount.textContent = String(state.measurements.length);
  els.panelCount.textContent = String(annotationCount);
  els.panelCount.hidden = annotationCount === 0;
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

  els.areaCount.textContent = String(state.areas.length);
  buildAreaList();
  if (state.calibration && state.areas.length > 1) {
    const totalArea = state.areas.reduce(
      (sum, area) => sum + polygonArea(area.points) / state.calibration.pxPerMeter ** 2,
      0,
    );
    els.areaTotal.textContent = formatArea(totalArea);
    els.areaTotalRow.hidden = false;
  } else {
    els.areaTotalRow.hidden = true;
  }

  els.wallCount.textContent = String(state.walls.length);
  buildWallList();
  if (state.calibration && state.walls.length) {
    const totalLength = state.walls.reduce(
      (sum, wall) => sum + pxToMm(distance(wall.a, wall.b), state.calibration.pxPerMeter) / 1000,
      0,
    );
    els.wallTotal.textContent = `${totalLength.toFixed(2)} m`;
    els.wallTotalRow.hidden = false;
  } else {
    els.wallTotalRow.hidden = true;
  }

  els.openingCount.textContent = String(state.openings.length);
  buildOpeningList();

  buildQuantities();

  els.undoBtn.disabled = history.length === 0;
  els.deleteBtn.disabled = state.selectedId == null;
  els.clearMeasureBtn.disabled = state.measurements.length === 0;
  els.clearAreaBtn.disabled = state.areas.length === 0;
  els.clearWallBtn.disabled = state.walls.length === 0;
  els.clearOpeningBtn.disabled = state.openings.length === 0;
  els.exportBtn.disabled = !state.source;
}

function showLoading(text) {
  els.loadingText.textContent = text;
  els.loading.hidden = false;
}

function hideLoading() {
  els.loading.hidden = true;
}

async function applySavedState(saved) {
  const data = saved.sourceBuffer || saved.sourceBlob;
  if (!data) throw new Error('The saved file is missing');
  const type = saved.sourceType || (saved.sourceBlob && saved.sourceBlob.type) || '';
  const file = new File([data], saved.name || 'plan', { type });
  let source = await createSource(file);
  if (saved.kind === 'pdf' && saved.page > 1) source = await goToPage(source, saved.page);
  if (state.source) releaseSource(state.source);
  state.source = source;
  pageStore.clear();
  for (const [page, annotations] of saved.pages || []) pageStore.set(page, annotations);
  state.view = saved.view || { scale: 1, tx: 0, ty: 0 };
  state.snapLines = saved.snapLines ?? false;
  state.layerVisibility = resolveLayerVisibility(saved.layers);
  history.length = 0;
  loadPageAnnotations();
  afterChange();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function restore() {
  showLoading('Loading project…');
  try {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let phase = 'load';
      try {
        const saved = await loadState();
        if (!saved || (!saved.sourceBlob && !saved.sourceBuffer)) return;
        phase = 'apply';
        await applySavedState(saved);
        lastError = null;
        break;
      } catch (error) {
        lastError = new Error(`${phase} (${error.name || 'Error'}): ${error.message}`);
        if (state.source) {
          releaseSource(state.source);
          state.source = null;
        }
        await wait(150 * (attempt + 1));
      }
    }
    if (lastError) throw lastError;
    toast('Restored last session');
  } catch (error) {
    console.warn('restore failed', error && error.message, error);
    toast('Could not restore the last session', true);
  } finally {
    hideLoading();
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, comma);
  const data = dataUrl.slice(comma + 1);
  const type = (meta.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

function exportQuantitiesCsv() {
  if (!state.source) {
    toast('Nothing to export', true);
    return;
  }
  const csv = toCsv(quantitiesToRows(computeQuantities(state)));
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${(state.source.name || 'plan').replace(/\.[^.]+$/, '')}-quantities.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Exported CSV');
}

async function exportProject() {
  if (!state.source || !state.source.blob) {
    toast('Nothing to export', true);
    return;
  }
  stashCurrentPage();
  try {
    const dataUrl = await blobToDataUrl(state.source.blob);
    const payload = {
      format: 'plan-calc-project',
      version: 1,
      kind: state.source.kind,
      name: state.source.name,
      page: state.source.page,
      view: state.view,
      snapLines: state.snapLines,
      layers: state.layerVisibility,
      pages: [...pageStore.entries()],
      source: { type: state.source.blob.type, data: dataUrl },
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(state.source.name || 'plan').replace(/\.[^.]+$/, '')}.plan-calc.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Project exported');
  } catch (error) {
    console.error(error);
    toast('Could not export the project', true);
  }
}

async function importProject(file) {
  showLoading('Importing project…');
  try {
    const payload = JSON.parse(await file.text());
    if (!payload || payload.format !== 'plan-calc-project' || !payload.source?.data) {
      throw new Error('Not a plan-calc project file');
    }
    await applySavedState({
      kind: payload.kind,
      name: payload.name,
      page: payload.page,
      view: payload.view,
      snapLines: payload.snapLines,
      layers: payload.layers,
      pages: payload.pages,
      sourceBlob: dataUrlToBlob(payload.source.data),
    });
    toast('Project imported');
  } catch (error) {
    console.error(error);
    toast('Could not import that file', true);
  } finally {
    hideLoading();
  }
}

function isPrivateIPv4(host) {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale CGNAT
  return false;
}

function canonicalizeOrigin() {
  const canonical = typeof __CANONICAL_HOST__ !== 'undefined' ? __CANONICAL_HOST__ : null;
  if (!canonical) return false;
  const host = window.location.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const skip = new URLSearchParams(window.location.search).has('nocanonical');
  if (local || skip || host === canonical) return false;
  if (!isPrivateIPv4(host)) return false;
  const port = window.location.port ? `:${window.location.port}` : '';
  const target = `${window.location.protocol}//${canonical}${port}${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (target === window.location.href) return false;
  window.location.replace(target);
  return true;
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
  els.clearMeasureBtn.addEventListener('click', clearMeasurements);
  els.clearAreaBtn.addEventListener('click', clearAreas);
  els.clearWallBtn.addEventListener('click', clearWalls);
  els.clearOpeningBtn.addEventListener('click', clearOpenings);
  els.layerMeasureToggle.addEventListener('click', () => toggleLayer('measure'));
  els.layerAreaToggle.addEventListener('click', () => toggleLayer('area'));
  els.layerWallToggle.addEventListener('click', () => toggleLayer('wall'));
  els.layerOpeningToggle.addEventListener('click', () => toggleLayer('opening'));
  els.exportCsv.addEventListener('click', exportQuantitiesCsv);
  els.wallType.addEventListener('change', () => {
    els.wallThickness.value = String(wallType(els.wallType.value).thickness);
  });
  els.exportBtn.addEventListener('click', exportPng);
  els.resetCalibration.addEventListener('click', resetCalibration);
  els.knownSet.addEventListener('click', setScaleFromSelected);
  els.knownValue.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') setScaleFromSelected();
  });

  els.exportProject.addEventListener('click', exportProject);
  els.importProject.addEventListener('click', () => els.projectInput.click());
  els.projectInput.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) importProject(file);
    event.target.value = '';
  });

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
    else if (event.key === '4') setTool('area');
    else if (event.key === '5') setTool('wall');
    else if (event.key === '6') setTool('opening');
    else if (event.key === 'Enter' && state.tool === 'area' && state.areaDraft.length >= 3) {
      commitArea();
      event.preventDefault();
    } else if (event.key === 's' || event.key === 'S') setSnapLines(!state.snapLines);
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
      if (state.areaDraft.length) {
        cancelArea();
      } else if (drag) {
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

  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });

  new ResizeObserver(resize).observe(workspace);
}

function populateSelect(select, options, value) {
  select.textContent = '';
  for (const option of options) {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    select.append(opt);
  }
  if (value) select.value = value;
}

function populateTypeSelects() {
  populateSelect(els.spaceType, SPACE_TYPES, 'medicion');
  populateSelect(els.wallType, WALL_TYPES, 'tabique');
  populateSelect(els.openingType, OPENING_TYPES, 'puerta');
  els.wallThickness.value = String(wallType('tabique').thickness);
}

function init() {
  if (canonicalizeOrigin()) return;
  populateTypeSelects();
  bindEvents();
  resize();
  els.canvas.style.cursor = 'grab';
  els.originLabel.textContent = window.location.host;
  setPanelVisible(false);
  syncUI();
  restore();
}

init();
