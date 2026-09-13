import { render } from '../render.js';
import { createSource, goToPage, releaseSource } from '../source.js';
import { makeTransform } from '../viewport.js';
import {
  computePxPerMeter,
  constrainAngle,
  distance,
  distanceToSegment,
  findSnapPoint,
  formatArea,
  formatDimension,
  nearestPointOnSegment,
  pointInPolygon,
  polygonArea,
  polygonEdgeDistance,
  pxToMm,
  segmentAngle,
  snapToDirections,
  toMeters,
} from '../measure.js';
import {
  OPENING_TYPES,
  SPACE_TYPES,
  WALL_TYPES,
  computeQuantities,
  quantitiesToRows,
  toCsv,
} from '../model.js';
import { DEFAULT_LAYER_VISIBILITY, isLayerVisible, resolveLayerVisibility } from '../layers.js';
import { createCanvasController } from '../core/canvas.js';
import WallWorker from '../autowall.worker.js?worker';
import {
  confirmDialog,
  downloadBlob,
  hideLoading,
  openCalibrationDialog,
  showLoading,
  toast,
} from '../core/ui.js';
import { getSheet } from '../project.js';

const COLORS = {
  wall: '#a371f7',
  wallFill: 'rgba(163, 113, 247, 0.35)',
  opening: '#2dd4bf',
  room: '#3fb950',
  roomFill: 'rgba(63, 185, 80, 0.16)',
  selected: '#ff5d55',
  node: '#e6edf3',
  snap: '#ff2d95',
};

function el(id) {
  return document.getElementById(id);
}

function blankSource(width = 1600, height = 1200) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  return {
    kind: 'blank',
    name: 'Model',
    blob: null,
    buffer: null,
    pdfDoc: null,
    page: 1,
    pageCount: 1,
    bitmap: canvas,
    width,
    height,
  };
}

export async function mountBuild({ project, save, getMeasureUnderlay }) {
  const els = {
    canvas: el('canvas'),
    loupe: el('loupe'),
    loupeCanvas: el('loupeCanvas'),
    deleteHandle: el('deleteHandle'),
    buildToolbar: el('buildToolbar'),
    toolButtons: [...document.querySelectorAll('#buildToolbar .tool')],
    panel: el('buildPanel'),
    panelToggle: el('panelToggleB'),
    panelCount: el('panelCountB'),
    panelClose: el('panelCloseB'),
    snapToggle: el('snapToggleB'),
    zoomInfo: el('zoomInfo'),
    fitBtn: el('fitBtn'),
    undoBtn: el('undoBtn'),
    redoBtn: el('redoBtn'),
    calibrateStatus: el('calibrateStatusB'),
    importUnderlay: el('importUnderlay'),
    wallSection: el('wallSection'),
    wallCount: el('wallCount'),
    wallType: el('wallType'),
    wallThickness: el('wallThickness'),
    clearWallBtn: el('clearWallBtn'),
    layerWallToggle: el('layerWallToggle'),
    wallList: el('wallList'),
    wallTotalRow: el('wallTotalRow'),
    wallTotal: el('wallTotal'),
    autoWallBtn: el('autoWallBtn'),
    autoWallReview: el('autoWallReview'),
    autoWallInfo: el('autoWallInfo'),
    autoWallApply: el('autoWallApply'),
    autoWallDiscard: el('autoWallDiscard'),
    openingSection: el('openingSection'),
    openingCount: el('openingCount'),
    openingType: el('openingType'),
    clearOpeningBtn: el('clearOpeningBtn'),
    layerOpeningToggle: el('layerOpeningToggle'),
    openingList: el('openingList'),
    roomSection: el('roomSection'),
    roomCount: el('roomCount'),
    roomType: el('roomType'),
    clearRoomBtn: el('clearRoomBtn'),
    layerRoomToggle: el('layerRoomToggle'),
    roomList: el('roomList'),
    roomTotalRow: el('roomTotalRow'),
    roomTotal: el('roomTotal'),
    buildQuantities: el('buildQuantities'),
    exportBuildCsv: el('exportBuildCsv'),
  };

  const state = {
    source: null,
    view: { scale: 1, tx: 0, ty: 0 },
    calibration: null,
    nodes: [],
    walls: [],
    openings: [],
    rooms: [],
    selected: null,
    preview: null,
    snap: null,
    roomDraft: [],
    roomCursor: null,
    tool: 'select',
    snapLines: false,
    layerVisibility: { ...DEFAULT_LAYER_VISIBILITY },
    pendingWalls: null,
  };

  let sheet = getSheet(project, project.activePage);
  let nextId = sheet.build.nextId || 1;
  let drag = null;
  let history = [];
  let redoStack = [];
  let destroyed = false;

  function layerVisible(layer) {
    return isLayerVisible(state.layerVisibility, layer);
  }

  function snapshot() {
    return {
      calibration: state.calibration ? { ...state.calibration } : null,
      nodes: state.nodes.map((n) => ({ ...n })),
      walls: state.walls.map((w) => ({ ...w })),
      openings: state.openings.map((o) => ({ ...o })),
      rooms: state.rooms.map((r) => ({ ...r, points: r.points.map((p) => ({ ...p })) })),
      nextId,
    };
  }

  function pushHistory() {
    history.push(snapshot());
    if (history.length > 100) history.shift();
    redoStack = [];
  }

  function applySnapshot(snap) {
    state.calibration = snap.calibration;
    state.nodes = snap.nodes;
    state.walls = snap.walls;
    state.openings = snap.openings;
    state.rooms = snap.rooms;
    nextId = snap.nextId;
    state.selected = null;
  }

  function undo() {
    if (!history.length) return;
    redoStack.push(snapshot());
    applySnapshot(history.pop());
    afterChange();
  }

  function redo() {
    if (!redoStack.length) return;
    history.push(snapshot());
    applySnapshot(redoStack.pop());
    afterChange();
  }

  function stash() {
    sheet.build = {
      nextId,
      nodes: state.nodes,
      walls: state.walls,
      openings: state.openings,
      rooms: state.rooms,
    };
    sheet.calibration = state.calibration;
  }

  function afterChange() {
    stash();
    controller.requestRender();
    syncUI();
    if (save) save();
  }

  function loadSheet() {
    sheet = getSheet(project, project.activePage);
    state.calibration = sheet.calibration || null;
    state.nodes = sheet.build.nodes || [];
    state.walls = sheet.build.walls || [];
    state.openings = sheet.build.openings || [];
    state.rooms = sheet.build.rooms || [];
    nextId = sheet.build.nextId || 1;
    state.selected = null;
    state.roomDraft = [];
  }

  function nodeById(id) {
    return state.nodes.find((n) => n.id === id) || null;
  }

  function wallEnds(wall) {
    const a = nodeById(wall.n1);
    const b = nodeById(wall.n2);
    return a && b ? { a, b } : null;
  }

  function findWall(id) {
    return state.walls.find((w) => w.id === id) || null;
  }
  function findOpening(id) {
    return state.openings.find((o) => o.id === id) || null;
  }
  function findRoom(id) {
    return state.rooms.find((r) => r.id === id) || null;
  }

  function selectedElement() {
    const sel = state.selected;
    if (!sel) return null;
    if (sel.kind === 'node') return nodeById(sel.id);
    if (sel.kind === 'wall') return findWall(sel.id);
    if (sel.kind === 'opening') return findOpening(sel.id);
    if (sel.kind === 'room') return findRoom(sel.id);
    return null;
  }

  function selectedLabel() {
    return state.selected?.kind || 'element';
  }

  // ---- snapping ----
  function snapPoints(excludeNodeId = null) {
    const points = [];
    if (layerVisible('wall')) {
      for (const node of state.nodes) {
        if (node.id !== excludeNodeId) points.push({ x: node.x, y: node.y });
      }
    }
    if (layerVisible('opening')) {
      for (const opening of state.openings) points.push(opening.a, opening.b);
    }
    if (layerVisible('room')) {
      for (const room of state.rooms) points.push(...room.points);
      points.push(...state.roomDraft);
    }
    if (state.calibration) points.push(state.calibration.a, state.calibration.b);
    return points;
  }

  function referenceDirections(excludeNodeId = null) {
    const directions = [0, Math.PI / 2];
    if (layerVisible('wall')) {
      for (const wall of state.walls) {
        const ends = wallEnds(wall);
        if (!ends) continue;
        if (ends.a.id !== excludeNodeId && ends.b.id !== excludeNodeId) {
          directions.push(segmentAngle(ends.a, ends.b));
        }
      }
    }
    return directions;
  }

  function resolvePoint(screen, startImage, shiftKey, excludeNodeId = null) {
    const transform = makeTransform(state.view);
    const raw = transform.toImage(screen);
    const tolerance = 10 / state.view.scale;
    const snapped = findSnapPoint(raw, snapPoints(excludeNodeId), tolerance);
    if (snapped) return { point: snapped, snapped: true };
    if (shiftKey && startImage) return { point: constrainAngle(startImage, raw, 45), snapped: false };
    if (state.snapLines && startImage) {
      const result = snapToDirections(startImage, raw, referenceDirections(excludeNodeId), 0.22);
      return { point: { x: result.x, y: result.y }, snapped: result.snapped };
    }
    return { point: raw, snapped: false };
  }

  function nodeAt(point, tolerance) {
    let best = null;
    let bestDistance = tolerance;
    for (const node of state.nodes) {
      const d = distance(point, node);
      if (d <= bestDistance) {
        bestDistance = d;
        best = node;
      }
    }
    return best;
  }

  function createOrReuseNode(point) {
    const tolerance = 6 / state.view.scale;
    const existing = nodeAt(point, tolerance);
    if (existing) return existing.id;
    const node = { id: nextId++, x: point.x, y: point.y };
    state.nodes.push(node);
    return node.id;
  }

  // ---- drawing commits ----
  function commitWall(a, b) {
    if (distance(a, b) <= 2 / state.view.scale) return;
    pushHistory();
    const n1 = createOrReuseNode(a);
    const n2 = createOrReuseNode(b);
    state.walls.push({
      id: nextId++,
      n1,
      n2,
      type: els.wallType.value || 'tabique',
      thickness: readNumber(els.wallThickness, 90),
    });
    afterChange();
  }

  function commitOpening(a, b) {
    if (distance(a, b) <= 2 / state.view.scale) return;
    pushHistory();
    state.openings.push({ id: nextId++, a: { ...a }, b: { ...b }, type: els.openingType.value || 'puerta' });
    afterChange();
  }

  function commitRoom() {
    if (state.roomDraft.length < 3) {
      cancelRoom();
      return;
    }
    pushHistory();
    state.rooms.push({
      id: nextId++,
      points: state.roomDraft.map((p) => ({ ...p })),
      name: '',
      type: els.roomType.value || 'salon',
    });
    state.roomDraft = [];
    state.roomCursor = null;
    state.snap = null;
    afterChange();
  }

  function cancelRoom() {
    state.roomDraft = [];
    state.roomCursor = null;
    state.snap = null;
    controller.requestRender();
    syncUI();
  }

  function handleRoomTap(screen) {
    const previous = state.roomDraft[state.roomDraft.length - 1] || null;
    const result = resolvePoint(screen, previous, false);
    const point = result.point;
    if (!state.roomDraft.length) {
      state.roomDraft = [point];
      state.roomCursor = point;
      state.snap = null;
      controller.requestRender();
      syncUI();
      return;
    }
    const tolerance = 14 / state.view.scale;
    const first = state.roomDraft[0];
    if (state.roomDraft.length >= 3 && distance(point, first) <= tolerance) {
      commitRoom();
      return;
    }
    state.roomDraft.push(point);
    state.roomCursor = point;
    state.snap = null;
    controller.requestRender();
    syncUI();
  }

  function readNumber(input, fallback) {
    const value = Number.parseFloat((input.value || '').replace(',', '.'));
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  // ---- auto wall detection ----
  const AUTO_MAX_DIM = 3000;
  let wallWorker = null;

  function getWallWorker() {
    if (!wallWorker) wallWorker = new WallWorker();
    return wallWorker;
  }

  function renderForDetection() {
    const source = state.source;
    if (!source || !source.bitmap) return null;
    const factor = Math.min(1, AUTO_MAX_DIM / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * factor));
    const height = Math.max(1, Math.round(source.height * factor));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source.bitmap, 0, 0, width, height);
    return { imageData: ctx.getImageData(0, 0, width, height), scale: source.width / width };
  }

  function runExtraction(imageData) {
    return new Promise((resolve, reject) => {
      const worker = getWallWorker();
      worker.onmessage = (event) => {
        const data = event.data;
        if (data && data.ok) resolve(data);
        else reject(new Error((data && data.error) || 'Wall detection failed'));
      };
      worker.onerror = (event) => reject(new Error(event.message || 'Wall detection failed'));
      worker.postMessage(
        { width: imageData.width, height: imageData.height, data: imageData.data },
        [imageData.data.buffer],
      );
    });
  }

  async function detectWalls() {
    const prepared = renderForDetection();
    if (!prepared) {
      toast('Add a plan before detecting walls', true);
      return;
    }
    showLoading('Detecting walls…');
    try {
      const result = await runExtraction(prepared.imageData);
      if (!result.segments.length) {
        toast('No walls detected — try a clearer, straight plan', true);
        return;
      }
      const scale = prepared.scale;
      state.pendingWalls = result.segments.map((segment) => ({
        a: { x: segment.a.x * scale, y: segment.a.y * scale },
        b: { x: segment.b.x * scale, y: segment.b.y * scale },
        thickness: segment.thickness * scale,
      }));
      state.selected = null;
      controller.requestRender();
      syncUI();
      toast(`${state.pendingWalls.length} walls detected — review and Apply`);
    } catch (error) {
      toast(error.message || 'Wall detection failed', true);
    } finally {
      hideLoading();
    }
  }

  function wallTypeForThickness(mm) {
    if (mm >= 280) return 'exterior';
    if (mm >= 180) return 'carga';
    return 'tabique';
  }

  function applyDetectedWalls() {
    const pending = state.pendingWalls;
    if (!pending || !pending.length) return;
    const pxPerMeter = state.calibration?.pxPerMeter || 0;
    pushHistory();
    const cell = 4;
    const nodeByKey = new Map();
    const nodeFor = (point) => {
      const key = `${Math.round(point.x / cell)}:${Math.round(point.y / cell)}`;
      const existing = nodeByKey.get(key);
      if (existing !== undefined) return existing;
      const node = { id: nextId++, x: point.x, y: point.y };
      state.nodes.push(node);
      nodeByKey.set(key, node.id);
      return node.id;
    };
    let added = 0;
    for (const segment of pending) {
      const n1 = nodeFor(segment.a);
      const n2 = nodeFor(segment.b);
      if (n1 === n2) continue;
      const mm = pxPerMeter ? (segment.thickness / pxPerMeter) * 1000 : null;
      state.walls.push({
        id: nextId++,
        n1,
        n2,
        type: mm ? wallTypeForThickness(mm) : 'tabique',
        thickness: mm ? Math.max(10, Math.round(mm)) : 90,
      });
      added += 1;
    }
    state.pendingWalls = null;
    state.selected = null;
    afterChange();
    toast(`Added ${added} walls`);
  }

  function discardDetectedWalls() {
    if (!state.pendingWalls) return;
    state.pendingWalls = null;
    controller.requestRender();
    syncUI();
  }

  // ---- selection ----
  function selectAt(imagePoint) {
    const tolerance = 9 / state.view.scale;
    let best = null;
    let bestDistance = tolerance;

    if (layerVisible('wall')) {
      for (const node of state.nodes) {
        const d = distance(imagePoint, node);
        if (d <= bestDistance) {
          bestDistance = d;
          best = { kind: 'node', id: node.id };
        }
      }
    }
    if (layerVisible('opening')) {
      for (const opening of state.openings) {
        const d = distanceToSegment(imagePoint, opening.a, opening.b);
        if (d <= bestDistance) {
          bestDistance = d;
          best = { kind: 'opening', id: opening.id };
        }
      }
    }
    if (layerVisible('wall')) {
      for (const wall of state.walls) {
        const ends = wallEnds(wall);
        if (!ends) continue;
        const d = distanceToSegment(imagePoint, ends.a, ends.b);
        if (d <= bestDistance) {
          bestDistance = d;
          best = { kind: 'wall', id: wall.id };
        }
      }
    }
    if (layerVisible('room')) {
      for (const room of state.rooms) {
        const inside = pointInPolygon(imagePoint, room.points);
        const d = polygonEdgeDistance(imagePoint, room.points);
        if (inside || d <= bestDistance) {
          bestDistance = inside ? 0 : d;
          best = { kind: 'room', id: room.id };
        }
      }
    }
    state.selected = best;
    controller.requestRender();
    syncUI();
  }

  async function requestDelete() {
    if (!state.selected) return;
    const ok = await confirmDialog(`Delete this ${selectedLabel()}?`);
    if (!ok) return;
    pushHistory();
    const { kind, id } = state.selected;
    if (kind === 'node') {
      state.nodes = state.nodes.filter((n) => n.id !== id);
      state.walls = state.walls.filter((w) => w.n1 !== id && w.n2 !== id);
    } else if (kind === 'wall') {
      state.walls = state.walls.filter((w) => w.id !== id);
    } else if (kind === 'opening') {
      state.openings = state.openings.filter((o) => o.id !== id);
    } else if (kind === 'room') {
      state.rooms = state.rooms.filter((r) => r.id !== id);
    }
    state.selected = null;
    afterChange();
  }

  // ---- pointer ----
  function onPointerDown(event, screen, { forcePan }) {
    if (forcePan || state.tool === 'select') {
      const selected = state.selected;
      const transform = makeTransform(state.view);
      const image = transform.toImage(screen);
      const touch = event.pointerType !== 'mouse';

      if (selected?.kind === 'node' && !forcePan) {
        const node = nodeById(selected.id);
        if (node && distance(screen, transform.toScreen(node)) <= 16) {
          drag = { mode: 'dragNode', id: node.id, pointerId: event.pointerId, moved: false, touch };
          return;
        }
      }
      if (selected?.kind === 'wall' && !forcePan) {
        const wall = findWall(selected.id);
        const ends = wall ? wallEnds(wall) : null;
        if (ends) {
          if (distance(screen, transform.toScreen(ends.a)) <= 16) {
            drag = { mode: 'dragNode', id: ends.a.id, pointerId: event.pointerId, moved: false, touch };
            return;
          }
          if (distance(screen, transform.toScreen(ends.b)) <= 16) {
            drag = { mode: 'dragNode', id: ends.b.id, pointerId: event.pointerId, moved: false, touch };
            return;
          }
          if (distanceToSegment(image, ends.a, ends.b) <= 12 / state.view.scale) {
            drag = {
              mode: 'dragWall',
              id: wall.id,
              pointerId: event.pointerId,
              startImage: image,
              original: { a: { x: ends.a.x, y: ends.a.y }, b: { x: ends.b.x, y: ends.b.y } },
              moved: false,
              touch,
            };
            return;
          }
        }
      }
      if (selected?.kind === 'opening' && !forcePan) {
        const opening = findOpening(selected.id);
        if (opening) {
          if (distance(screen, transform.toScreen(opening.a)) <= 16) {
            drag = { mode: 'editOpeningVertex', id: opening.id, endpoint: 'a', pointerId: event.pointerId, moved: false, touch };
            return;
          }
          if (distance(screen, transform.toScreen(opening.b)) <= 16) {
            drag = { mode: 'editOpeningVertex', id: opening.id, endpoint: 'b', pointerId: event.pointerId, moved: false, touch };
            return;
          }
          if (distanceToSegment(image, opening.a, opening.b) <= 12 / state.view.scale) {
            drag = {
              mode: 'dragOpening',
              id: opening.id,
              pointerId: event.pointerId,
              startImage: image,
              original: { a: { ...opening.a }, b: { ...opening.b } },
              moved: false,
              touch,
            };
            return;
          }
        }
      }
      if (selected?.kind === 'room' && !forcePan) {
        const room = findRoom(selected.id);
        if (room) {
          for (let index = 0; index < room.points.length; index += 1) {
            if (distance(screen, transform.toScreen(room.points[index])) <= 14) {
              drag = { mode: 'editRoomVertex', id: room.id, index, pointerId: event.pointerId, moved: false, touch };
              return;
            }
          }
          if (
            pointInPolygon(image, room.points) ||
            polygonEdgeDistance(image, room.points) <= 12 / state.view.scale
          ) {
            drag = {
              mode: 'dragRoom',
              id: room.id,
              pointerId: event.pointerId,
              startImage: image,
              original: room.points.map((point) => ({ ...point })),
              moved: false,
              touch,
            };
            return;
          }
        }
      }
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

    if (state.tool === 'room') {
      drag = {
        mode: 'room',
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
    controller.requestRender();
    if (drag.touch) controller.updateLoupe(screen, start.point);
  }

  function onPointerMove(event, screen) {
    if (!drag) {
      if (state.tool === 'wall' || state.tool === 'opening') {
        const result = resolvePoint(screen, null, event.shiftKey);
        state.snap = result.snapped ? result.point : null;
        controller.requestRender();
      } else if (state.tool === 'room') {
        const previous = state.roomDraft[state.roomDraft.length - 1] || null;
        const result = resolvePoint(screen, previous, event.shiftKey);
        state.roomCursor = result.point;
        state.snap = result.snapped ? result.point : null;
        controller.requestRender();
      }
      return;
    }
    if (drag.pointerId !== event.pointerId) return;

    const image = makeTransform(state.view).toImage(screen);

    if (drag.mode === 'dragNode') {
      const node = nodeById(drag.id);
      if (!node) return;
      if (!drag.moved) {
        pushHistory();
        drag.moved = true;
      }
      const result = resolvePoint(screen, { x: node.x, y: node.y }, event.shiftKey, drag.id);
      node.x = result.point.x;
      node.y = result.point.y;
      state.snap = result.snapped ? result.point : null;
      controller.requestRender();
      syncUI();
      return;
    }

    if (drag.mode === 'dragWall' || drag.mode === 'dragOpening') {
      const isWall = drag.mode === 'dragWall';
      const element = isWall ? findWall(drag.id) : findOpening(drag.id);
      const ends = isWall ? (element ? wallEnds(element) : null) : element;
      if (!ends) return;
      const dx = image.x - drag.startImage.x;
      const dy = image.y - drag.startImage.y;
      if (!drag.moved) {
        pushHistory();
        drag.moved = true;
      }
      if (isWall) {
        const a = nodeById(element.n1);
        const b = nodeById(element.n2);
        a.x = drag.original.a.x + dx;
        a.y = drag.original.a.y + dy;
        b.x = drag.original.b.x + dx;
        b.y = drag.original.b.y + dy;
      } else {
        element.a = { x: drag.original.a.x + dx, y: drag.original.a.y + dy };
        element.b = { x: drag.original.b.x + dx, y: drag.original.b.y + dy };
      }
      controller.requestRender();
      syncUI();
      return;
    }

    if (drag.mode === 'editOpeningVertex') {
      const opening = findOpening(drag.id);
      if (!opening) return;
      const other = drag.endpoint === 'a' ? opening.b : opening.a;
      const result = resolvePoint(screen, other, event.shiftKey);
      if (!drag.moved) {
        pushHistory();
        drag.moved = true;
      }
      opening[drag.endpoint] = result.point;
      state.snap = result.snapped ? result.point : null;
      controller.requestRender();
      syncUI();
      return;
    }

    if (drag.mode === 'editRoomVertex') {
      const room = findRoom(drag.id);
      if (!room) return;
      const result = resolvePoint(screen, null, event.shiftKey);
      if (!drag.moved) {
        pushHistory();
        drag.moved = true;
      }
      room.points[drag.index] = result.point;
      state.snap = result.snapped ? result.point : null;
      controller.requestRender();
      syncUI();
      return;
    }

    if (drag.mode === 'dragRoom') {
      const room = findRoom(drag.id);
      if (!room) return;
      const dx = image.x - drag.startImage.x;
      const dy = image.y - drag.startImage.y;
      if (!drag.moved && (Math.abs(dx) > 0 || Math.abs(dy) > 0)) {
        pushHistory();
        drag.moved = true;
      }
      room.points = drag.original.map((point) => ({ x: point.x + dx, y: point.y + dy }));
      controller.requestRender();
      syncUI();
      return;
    }

    if (drag.mode === 'room' || drag.mode === 'pan') {
      const dx = screen.x - drag.startScreen.x;
      const dy = screen.y - drag.startScreen.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      state.view = { scale: drag.startView.scale, tx: drag.startView.tx + dx, ty: drag.startView.ty + dy };
      controller.requestRender();
      return;
    }

    const result = resolvePoint(screen, drag.startImage, event.shiftKey);
    drag.moved = true;
    state.preview = { a: drag.startImage, b: result.point };
    state.snap = result.snapped ? result.point : null;
    controller.requestRender();
    if (drag.touch) controller.updateLoupe(screen, result.point);
  }

  function onPointerUp(event, screen) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const finished = drag;
    drag = null;
    els.canvas.style.cursor = state.tool === 'select' ? 'grab' : 'crosshair';

    if (finished.mode.startsWith('drag') || finished.mode.startsWith('edit')) {
      state.snap = null;
      if (finished.moved) afterChange();
      else controller.requestRender();
      return;
    }
    if (finished.mode === 'room') {
      if (!finished.moved) handleRoomTap(finished.startScreen);
      return;
    }
    if (finished.mode === 'pan') {
      if (!finished.moved && finished.wasSelect) {
        selectAt(makeTransform(state.view).toImage(screen));
      } else {
        save?.();
      }
      state.snap = null;
      controller.requestRender();
      return;
    }

    const end = state.preview ? state.preview.b : finished.startImage;
    state.preview = null;
    state.snap = null;

    if (finished.mode === 'wall') {
      if (distance(finished.startImage, end) > 2) commitWall(finished.startImage, end);
      else controller.requestRender();
      return;
    }
    if (finished.mode === 'opening') {
      if (distance(finished.startImage, end) > 2) commitOpening(finished.startImage, end);
      else controller.requestRender();
      return;
    }
    if (finished.mode === 'calibrate') {
      if (distance(finished.startImage, end) > 4) {
        openCalibrationDialog(screen, (value, unit) => {
          try {
            const realMeters = toMeters(value, unit);
            pushHistory();
            state.calibration = {
              a: { ...finished.startImage },
              b: { ...end },
              realMeters,
              value,
              unit,
              pxPerMeter: computePxPerMeter(finished.startImage, end, realMeters),
              source: 'graphic',
            };
            afterChange();
            toast('Scale set');
          } catch (error) {
            toast(error.message, true);
          }
        });
      }
      controller.requestRender();
    }
  }

  // ---- render ----
  function quantitiesInput() {
    const walls = state.walls
      .map((wall) => {
        const ends = wallEnds(wall);
        return ends ? { ...wall, a: ends.a, b: ends.b } : null;
      })
      .filter(Boolean);
    return { ...state, areas: state.rooms, walls };
  }

  function drawNodes(ctx, walls) {
    if (!layerVisible('wall')) return;
    const transform = makeTransform(state.view);
    ctx.save();
    for (const node of state.nodes) {
      const p = transform.toScreen(node);
      const selected = state.selected?.kind === 'node' && state.selected.id === node.id;
      ctx.beginPath();
      ctx.rect(p.x - 3.5, p.y - 3.5, 7, 7);
      ctx.fillStyle = selected ? COLORS.selected : COLORS.node;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#0e1116';
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawOverlay(ctx) {
    if (state.pendingWalls && layerVisible('wall')) {
      const transform = makeTransform(state.view);
      ctx.save();
      ctx.strokeStyle = '#ffb020';
      ctx.fillStyle = '#ffb020';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      for (const segment of state.pendingWalls) {
        const a = transform.toScreen(segment.a);
        const b = transform.toScreen(segment.b);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      for (const segment of state.pendingWalls) {
        for (const point of [segment.a, segment.b]) {
          const p = transform.toScreen(point);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }
    if (state.snap) {
      const transform = makeTransform(state.view);
      const p = transform.toScreen(state.snap);
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.snap;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
  }

  function paintBuild(ctx, s, w, h) {
    const nodes = new Map(s.nodes.map((n) => [n.id, n]));
    const walls = s.walls
      .map((wall) => ({ ...wall, a: nodes.get(wall.n1), b: nodes.get(wall.n2) }))
      .filter((wall) => wall.a && wall.b);
    const layers = {
      measure: false,
      area: s.layerVisibility.room,
      wall: s.layerVisibility.wall,
      opening: s.layerVisibility.opening,
      room: s.layerVisibility.room,
    };
    const selectedId =
      s.selected && ['wall', 'opening', 'room'].includes(s.selected.kind) ? s.selected.id : null;
    render(
      ctx,
      {
        ...s,
        measurements: [],
        areas: s.rooms,
        walls,
        layerVisibility: layers,
        selectedId,
      },
      w,
      h,
      { showScaleBar: false },
    );
    drawNodes(ctx, walls);
    drawOverlay(ctx);
  }

  // ---- lists ----
  function metricLength(a, b) {
    if (!state.calibration) return 'no scale';
    return formatDimension(pxToMm(distance(a, b), state.calibration.pxPerMeter));
  }

  function makeRemove(onRemove) {
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

  function fillSelect(select, options, value) {
    select.textContent = '';
    for (const option of options) {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label;
      select.append(opt);
    }
    select.value = value;
  }

  function selectElement(kind, id) {
    state.selected = { kind, id };
    if (kind === 'node') setLayerVisible('wall', true, false);
    controller.requestRender();
    syncUI();
  }

  function buildWallList() {
    els.wallList.textContent = '';
    state.walls.forEach((wall, index) => {
      const ends = wallEnds(wall);
      if (!ends) return;
      const item = document.createElement('li');
      item.className = state.selected?.kind === 'wall' && state.selected.id === wall.id ? 'active' : '';
      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = `#${index + 1}`;
      const type = document.createElement('select');
      fillSelect(type, WALL_TYPES, wall.type || 'tabique');
      type.addEventListener('click', (e) => e.stopPropagation());
      type.addEventListener('change', () => {
        pushHistory();
        wall.type = type.value;
        afterChange();
      });
      const remove = makeRemove(() => {
        pushHistory();
        state.walls = state.walls.filter((w) => w.id !== wall.id);
        if (state.selected?.id === wall.id) state.selected = null;
        afterChange();
      });
      const meta = document.createElement('div');
      meta.className = 'meta';
      const thickness = document.createElement('input');
      thickness.className = 'num';
      thickness.type = 'number';
      thickness.min = '0';
      thickness.value = String(wall.thickness ?? 90);
      thickness.title = 'Thickness (mm)';
      thickness.addEventListener('click', (e) => e.stopPropagation());
      thickness.addEventListener('change', () => {
        pushHistory();
        wall.thickness = readNumber(thickness, wall.thickness || 90);
        afterChange();
      });
      const unit = document.createElement('span');
      unit.className = 'field-unit';
      unit.textContent = 'mm';
      const metric = document.createElement('span');
      metric.className = 'metric';
      metric.textContent = metricLength(ends.a, ends.b);
      meta.append(thickness, unit, metric);
      item.append(idx, type, remove, meta);
      item.addEventListener('click', () => selectElement('wall', wall.id));
      els.wallList.append(item);
    });
  }

  function buildOpeningList() {
    els.openingList.textContent = '';
    state.openings.forEach((opening, index) => {
      const item = document.createElement('li');
      item.className = state.selected?.kind === 'opening' && state.selected.id === opening.id ? 'active' : '';
      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = `#${index + 1}`;
      const type = document.createElement('select');
      fillSelect(type, OPENING_TYPES, opening.type || 'puerta');
      type.addEventListener('click', (e) => e.stopPropagation());
      type.addEventListener('change', () => {
        pushHistory();
        opening.type = type.value;
        afterChange();
      });
      const remove = makeRemove(() => {
        pushHistory();
        state.openings = state.openings.filter((o) => o.id !== opening.id);
        if (state.selected?.id === opening.id) state.selected = null;
        afterChange();
      });
      item.append(idx, type, remove);
      item.addEventListener('click', () => selectElement('opening', opening.id));
      els.openingList.append(item);
    });
  }

  function buildRoomList() {
    els.roomList.textContent = '';
    state.rooms.forEach((room, index) => {
      const item = document.createElement('li');
      item.className = state.selected?.kind === 'room' && state.selected.id === room.id ? 'active' : '';
      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = `#${index + 1}`;
      const name = document.createElement('input');
      name.className = 'name';
      name.type = 'text';
      name.placeholder = 'Name';
      name.value = room.name || '';
      name.addEventListener('click', (e) => e.stopPropagation());
      name.addEventListener('change', () => {
        pushHistory();
        room.name = name.value.trim();
        afterChange();
      });
      const remove = makeRemove(() => {
        pushHistory();
        state.rooms = state.rooms.filter((r) => r.id !== room.id);
        if (state.selected?.id === room.id) state.selected = null;
        afterChange();
      });
      const meta = document.createElement('div');
      meta.className = 'meta';
      const type = document.createElement('select');
      fillSelect(type, SPACE_TYPES, room.type || 'salon');
      type.addEventListener('click', (e) => e.stopPropagation());
      type.addEventListener('change', () => {
        pushHistory();
        room.type = type.value;
        afterChange();
      });
      const metric = document.createElement('span');
      metric.className = 'metric';
      metric.textContent = state.calibration
        ? formatArea(polygonArea(room.points) / state.calibration.pxPerMeter ** 2)
        : `${polygonArea(room.points).toFixed(0)} px²`;
      meta.append(type, metric);
      item.append(idx, name, remove, meta);
      item.addEventListener('click', () => selectElement('room', room.id));
      els.roomList.append(item);
    });
  }

  function buildQuantitiesUi() {
    const q = computeQuantities(quantitiesInput());
    const rows = [];
    if (!q.calibrated) rows.push(['q-section', 'Not calibrated — set the scale first']);
    rows.push(['q-label', 'Useful area'], ['q-value', `${q.usefulArea.toFixed(2)} m²`]);
    rows.push(['q-label', 'Wall footprint'], ['q-value', `${q.wallArea.toFixed(2)} m²`]);
    rows.push(['q-label', 'Built area (est.)'], ['q-value', `${q.builtArea.toFixed(2)} m²`]);
    rows.push(['q-label', 'Wall length'], ['q-value', `${q.wallLength.toFixed(2)} m`]);
    rows.push(['q-label', 'Openings'], ['q-value', String(q.openingCount)]);
    els.buildQuantities.textContent = '';
    for (const [cls, text] of rows) {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      els.buildQuantities.append(span);
    }
  }

  function syncUI() {
    for (const button of els.toolButtons) {
      button.classList.toggle('active', button.dataset.tool === state.tool);
    }
    els.snapToggle.setAttribute('aria-pressed', String(state.snapLines));
    for (const [layer, toggle, section] of [
      ['wall', els.layerWallToggle, els.wallSection],
      ['opening', els.layerOpeningToggle, els.openingSection],
      ['room', els.layerRoomToggle, els.roomSection],
    ]) {
      const visible = layerVisible(layer);
      toggle.setAttribute('aria-pressed', String(visible));
      toggle.textContent = visible ? 'Hide' : 'Show';
      section.classList.toggle('layer-hidden', !visible);
    }
    els.zoomInfo.textContent = `${Math.round(state.view.scale * 100)}%`;
    if (state.calibration) {
      els.calibrateStatus.className = 'badge ok';
      els.calibrateStatus.textContent = `${state.calibration.pxPerMeter.toFixed(2)} px/m`;
    } else {
      els.calibrateStatus.className = 'badge warn';
      els.calibrateStatus.textContent = 'Not calibrated';
    }
    const count = state.walls.length + state.openings.length + state.rooms.length;
    els.panelCount.textContent = String(count);
    els.panelCount.hidden = count === 0;
    els.wallCount.textContent = String(state.walls.length);
    buildWallList();
    if (state.calibration && state.walls.length) {
      const total = quantitiesInput().walls.reduce(
        (sum, wall) => sum + pxToMm(distance(wall.a, wall.b), state.calibration.pxPerMeter) / 1000,
        0,
      );
      els.wallTotal.textContent = `${total.toFixed(2)} m`;
      els.wallTotalRow.hidden = false;
    } else {
      els.wallTotalRow.hidden = true;
    }
    els.openingCount.textContent = String(state.openings.length);
    buildOpeningList();
    els.roomCount.textContent = String(state.rooms.length);
    buildRoomList();
    const q = computeQuantities(quantitiesInput());
    if (q.calibrated && state.rooms.length) {
      els.roomTotal.textContent = formatArea(q.usefulArea);
      els.roomTotalRow.hidden = false;
    } else {
      els.roomTotalRow.hidden = true;
    }
    buildQuantitiesUi();
    els.undoBtn.disabled = history.length === 0;
    els.redoBtn.disabled = redoStack.length === 0;
    els.clearWallBtn.disabled = state.walls.length === 0;
    els.clearOpeningBtn.disabled = state.openings.length === 0;
    els.clearRoomBtn.disabled = state.rooms.length === 0;
    const pendingCount = state.pendingWalls?.length || 0;
    els.autoWallReview.hidden = pendingCount === 0;
    if (pendingCount) els.autoWallInfo.textContent = `${pendingCount} walls proposed`;
    els.autoWallBtn.disabled = !state.source || !state.source.bitmap;
  }

  function setTool(tool) {
    const leavingRoom = state.tool === 'room' && tool !== 'room';
    state.tool = tool;
    state.preview = null;
    state.snap = null;
    controller.hideLoupe();
    els.canvas.style.cursor = tool === 'select' ? 'grab' : 'crosshair';
    if (leavingRoom && state.roomDraft.length) {
      if (state.roomDraft.length >= 3) commitRoom();
      else cancelRoom();
    }
    if (tool === 'wall') setLayerVisible('wall', true, false);
    if (tool === 'opening') setLayerVisible('opening', true, false);
    if (tool === 'room') setLayerVisible('room', true, false);
    syncUI();
  }

  function setLayerVisible(layer, visible, persist = true) {
    if (layerVisible(layer) === visible) return;
    state.layerVisibility = { ...state.layerVisibility, [layer]: visible };
    project.settings.layers = state.layerVisibility;
    if (!visible && state.selected) {
      const map = { wall: ['wall', 'node'], opening: ['opening'], room: ['room'] };
      if ((map[layer] || []).includes(state.selected.kind)) state.selected = null;
    }
    if (persist) afterChange();
    else {
      state.layerVisibility && save?.();
      controller.requestRender();
      syncUI();
    }
  }

  function toggleLayer(layer) {
    setLayerVisible(layer, !layerVisible(layer));
  }

  function exportCsv() {
    const csv = toCsv(quantitiesToRows(computeQuantities(quantitiesInput())));
    downloadBlob(new Blob([csv], { type: 'text/csv' }), `${(project.name || 'model').replace(/\s+/g, '-').toLowerCase()}-quantities.csv`);
    toast('Exported CSV');
  }

  async function importUnderlay() {
    const underlay = getMeasureUnderlay?.() || project.underlay;
    if (!underlay || !(underlay.sourceBuffer || underlay.sourceBlob)) {
      toast('No plan to import — add one in Measure first', true);
      return;
    }
    project.underlay = underlay;
    showLoading('Importing plan…');
    try {
      await loadUnderlay();
      controller.fit();
      afterChange();
      toast('Plan imported from Measure');
    } finally {
      hideLoading();
    }
  }

  async function loadUnderlay() {
    state.pendingWalls = null;
    if (!project.underlay) {
      if (state.source) releaseSource(state.source);
      state.source = blankSource();
      controller.fit();
      return;
    }
    const data = project.underlay.sourceBuffer || project.underlay.sourceBlob;
    if (!data) {
      if (state.source) releaseSource(state.source);
      state.source = blankSource();
      controller.fit();
      return;
    }
    const file = new File([data], project.underlay.name || 'plan', { type: project.underlay.sourceType || '' });
    if (state.source) releaseSource(state.source);
    let source = await createSource(file);
    if (project.underlay.kind === 'pdf' && project.activePage > 1) {
      source = await goToPage(source, project.activePage);
    }
    state.source = source;
    controller.fit();
  }

  function onKeyDown(event) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.code === 'Space') return;
    if (event.key === '1') setTool('select');
    else if (event.key === '2') setTool('calibrate');
    else if (event.key === '3') setTool('wall');
    else if (event.key === '4') setTool('opening');
    else if (event.key === '5') setTool('room');
    else if (event.key === 'Enter' && state.tool === 'room' && state.roomDraft.length >= 3) commitRoom();
    else if (event.key === 's' || event.key === 'S') setSnapLines(!state.snapLines);
    else if (event.key === 'f' || event.key === 'F') {
      controller.fit();
      afterChange();
    } else if (event.key === 'h' || event.key === 'H') setPanelVisible(document.body.classList.contains('panel-hidden'));
    else if (event.key === 'Delete' || event.key === 'Backspace') {
      requestDelete();
      event.preventDefault();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      if (event.shiftKey) redo();
      else undo();
      event.preventDefault();
    } else if (event.key === 'Escape') {
      if (state.roomDraft.length) cancelRoom();
    }
  }

  function setSnapLines(value) {
    state.snapLines = value;
    project.settings.snapLines = value;
    els.snapToggle.setAttribute('aria-pressed', String(value));
    controller.requestRender();
    save?.();
  }

  function setPanelVisible(visible) {
    document.body.classList.toggle('panel-hidden', !visible);
    els.panelToggle.setAttribute('aria-pressed', String(visible));
  }

  const controller = createCanvasController({
    canvas: els.canvas,
    loupe: els.loupe,
    loupeCanvas: els.loupeCanvas,
    getState: () => state,
    render: paintBuild,
    renderLoupe: null,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onChanged: () => save?.(),
  });

  // populate selects
  els.wallType.textContent = '';
  for (const option of WALL_TYPES) {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    els.wallType.append(opt);
  }
  els.wallType.value = 'tabique';
  els.wallThickness.value = String(WALL_TYPES[0].thickness);
  els.wallType.addEventListener('change', () => {
    els.wallThickness.value = String(WALL_TYPES.find((t) => t.value === els.wallType.value)?.thickness ?? 90);
  });
  els.openingType.textContent = '';
  for (const option of OPENING_TYPES) {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    els.openingType.append(opt);
  }
  els.openingType.value = 'puerta';
  els.roomType.textContent = '';
  for (const option of SPACE_TYPES) {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    els.roomType.append(opt);
  }
  els.roomType.value = 'salon';

  for (const button of els.toolButtons) {
    button.addEventListener('click', () => setTool(button.dataset.tool));
  }
  els.panelToggle.addEventListener('click', () => setPanelVisible(document.body.classList.contains('panel-hidden')));
  els.panelClose.addEventListener('click', () => setPanelVisible(false));
  els.snapToggle.addEventListener('click', () => setSnapLines(!state.snapLines));
  els.importUnderlay.addEventListener('click', importUnderlay);
  els.autoWallBtn.addEventListener('click', detectWalls);
  els.autoWallApply.addEventListener('click', applyDetectedWalls);
  els.autoWallDiscard.addEventListener('click', discardDetectedWalls);
  els.clearWallBtn.addEventListener('click', () => {
    if (!state.walls.length) return;
    pushHistory();
    state.walls = [];
    state.selected = null;
    afterChange();
  });
  els.clearOpeningBtn.addEventListener('click', () => {
    if (!state.openings.length) return;
    pushHistory();
    state.openings = [];
    state.selected = null;
    afterChange();
  });
  els.clearRoomBtn.addEventListener('click', () => {
    if (!state.rooms.length) return;
    pushHistory();
    state.rooms = [];
    state.selected = null;
    afterChange();
  });
  els.layerWallToggle.addEventListener('click', () => toggleLayer('wall'));
  els.layerOpeningToggle.addEventListener('click', () => toggleLayer('opening'));
  els.layerRoomToggle.addEventListener('click', () => toggleLayer('room'));
  els.exportBuildCsv.addEventListener('click', exportCsv);
  window.addEventListener('keydown', onKeyDown);

  state.layerVisibility = resolveLayerVisibility(project.settings.layers);
  state.snapLines = project.settings.snapLines ?? false;
  els.snapToggle.setAttribute('aria-pressed', String(state.snapLines));
  loadSheet();
  await loadUnderlay();
  loadSheet();
  controller.resize();
  syncUI();

  return {
    setActive(active) {
      els.buildToolbar.hidden = !active;
      els.panel.hidden = !active;
    },
    refreshUnderlay: loadUnderlay,
    undo,
    redo,
    fit() {
      controller.fit();
      afterChange();
    },
    requestDelete,
    destroy() {
      window.removeEventListener('keydown', onKeyDown);
      if (wallWorker) {
        wallWorker.terminate();
        wallWorker = null;
      }
      controller.destroy();
    },
  };
}
