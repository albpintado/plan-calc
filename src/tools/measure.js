import { render } from '../render.js';
import { createSource, goToPage, releaseSource } from '../source.js';
import { makeTransform } from '../viewport.js';
import {
  distance,
  distanceToSegment,
  findSnapPoint,
  formatArea,
  formatDimension,
  formatLength,
  polygonArea,
  polygonCentroid,
  polygonEdgeDistance,
  pointInPolygon,
  pxToMm,
  snapToDirections,
  toMeters,
  computePxPerMeter,
  segmentAngle,
  constrainAngle,
} from '../measure.js';
import { DEFAULT_LAYER_VISIBILITY, isLayerVisible, resolveLayerVisibility } from '../layers.js';
import { SPACE_TYPES, computeQuantities, quantitiesToRows, toCsv } from '../model.js';
import { createCanvasController } from '../core/canvas.js';
import {
  confirmDialog,
  dataUrlToBlob,
  blobToDataUrl,
  downloadBlob,
  hideLoading,
  openCalibrationDialog,
  showLoading,
  toast,
} from '../core/ui.js';
import { getSheet } from '../project.js';

function el(id) {
  return document.getElementById(id);
}

export async function mountMeasure({ project, save, onExit }) {
  const els = {
    canvas: el('canvas'),
    loupe: el('loupe'),
    loupeCanvas: el('loupeCanvas'),
    deleteHandle: el('deleteHandle'),
    measureToolbar: el('measureToolbar'),
    buildToolbar: el('buildToolbar'),
    toolButtons: [...document.querySelectorAll('#measureToolbar .tool')],
    panel: el('measurePanel'),
    panelToggle: el('panelToggle'),
    panelCount: el('panelCount'),
    panelClose: el('panelClose'),
    snapToggle: el('snapToggle'),
    toolSelect: el('toolSelect'),
    toolButtonsAll: [...document.querySelectorAll('#measureToolbar [data-tool]')],
    pagePrev: el('pagePrev'),
    pageInfo: el('pageInfo'),
    pageNext: el('pageNext'),
    zoomInfo: el('zoomInfo'),
    fitBtn: el('fitBtn'),
    undoBtn: el('undoBtn'),
    redoBtn: el('redoBtn'),
    calibrateStatus: el('calibrateStatus'),
    knownValue: el('knownValue'),
    knownUnit: el('knownUnit'),
    knownSet: el('knownSet'),
    resetCalibration: el('resetCalibration'),
    measureSection: el('measureSection'),
    measureCount: el('measureCount'),
    deleteBtn: el('deleteBtn'),
    clearMeasureBtn: el('clearMeasureBtn'),
    layerMeasureToggle: el('layerMeasureToggle'),
    measurementList: el('measurementList'),
    totalRow: el('totalRow'),
    totalValue: el('totalValue'),
    areaSection: el('areaSection'),
    areaCount: el('areaCount'),
    spaceType: el('spaceType'),
    clearAreaBtn: el('clearAreaBtn'),
    layerAreaToggle: el('layerAreaToggle'),
    areaList: el('areaList'),
    areaTotalRow: el('areaTotalRow'),
    areaTotal: el('areaTotal'),
    measureSummary: el('measureSummary'),
    exportCsv: el('exportCsv'),
    exportPng: el('exportPng'),
    exportProject: el('exportProject'),
    importProject: el('importProject'),
    projectInput: el('projectInput'),
  };

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

  let sheet = getSheet(project, project.activePage);
  let nextId = sheet.measure.nextId || 1;
  let drag = null;
  let history = [];
  let redoStack = [];
  let destroyed = false;

  function layerVisible(layer) {
    return isLayerVisible(state.layerVisibility, layer);
  }

  function snapshot() {
    return {
      calibration: state.calibration ? {
        ...state.calibration,
        a: { ...state.calibration.a },
        b: { ...state.calibration.b },
      } : null,
      measurements: state.measurements.map((m) => ({ ...m, a: { ...m.a }, b: { ...m.b } })),
      areas: state.areas.map((a) => ({ ...a, points: a.points.map((p) => ({ ...p })) })),
      nextId,
    };
  }

  function pushHistory() {
    history.push(snapshot());
    if (history.length > 100) history.shift();
    redoStack = [];
  }

  function restore(snap) {
    state.calibration = snap.calibration;
    state.measurements = snap.measurements;
    state.areas = snap.areas;
    nextId = snap.nextId;
    state.selectedId = null;
  }

  function undo() {
    if (!history.length) return;
    redoStack.push(snapshot());
    restore(history.pop());
    afterChange();
  }

  function redo() {
    if (!redoStack.length) return;
    history.push(snapshot());
    restore(redoStack.pop());
    afterChange();
  }

  function stash() {
    sheet.measure = { nextId, measurements: state.measurements, areas: state.areas };
    sheet.calibration = state.calibration;
    project.activePage = state.source?.page || 1;
    if (project.underlay) project.underlay.pageCount = Math.max(project.underlay.pageCount, project.activePage);
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
    state.measurements = sheet.measure.measurements || [];
    state.areas = sheet.measure.areas || [];
    nextId = sheet.measure.nextId || 1;
    state.selectedId = null;
    state.areaDraft = [];
    state.areaCursor = null;
  }

  // ---- snapping ----
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

  function findMeasurement(id) {
    return state.measurements.find((m) => m.id === id) || null;
  }
  function findArea(id) {
    return state.areas.find((a) => a.id === id) || null;
  }

  // ---- area (space) drawing ----
  function areaText(points) {
    if (state.calibration) {
      return formatArea(polygonArea(points) / state.calibration.pxPerMeter ** 2);
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
    controller.requestRender();
    syncUI();
  }

  function handleAreaTap(screen) {
    const previous = state.areaDraft[state.areaDraft.length - 1] || null;
    const result = resolvePoint(screen, previous, false);
    const point = result.point;
    if (!state.areaDraft.length) {
      state.areaDraft = [point];
      state.areaCursor = point;
      state.snap = null;
      controller.requestRender();
      syncUI();
      return;
    }
    const tolerance = 14 / state.view.scale;
    const first = state.areaDraft[0];
    if (state.areaDraft.length >= 3 && distance(point, first) <= tolerance) {
      commitArea();
      return;
    }
    state.areaDraft.push(point);
    state.areaCursor = point;
    state.snap = null;
    controller.requestRender();
    syncUI();
  }

  // ---- selection / delete ----
  function selectedLabel() {
    if (state.selectedId === 'calibration') return 'calibration line';
    if (findArea(state.selectedId)) return 'space';
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
    if (layerVisible('measure') && state.calibration) {
      const d = distanceToSegment(imagePoint, state.calibration.a, state.calibration.b);
      if (d <= bestDistance) {
        bestDistance = d;
        selected = 'calibration';
      }
    }
    state.selectedId = selected;
    controller.requestRender();
    syncUI();
  }

  async function requestDelete() {
    if (state.selectedId == null) return;
    const ok = await confirmDialog(`Delete this ${selectedLabel()}?`);
    if (!ok) return;
    const selected = state.selectedId;
    pushHistory();
    if (selected === 'calibration') state.calibration = null;
    else if (findArea(selected)) state.areas = state.areas.filter((a) => a.id !== selected);
    else state.measurements = state.measurements.filter((m) => m.id !== selected);
    state.selectedId = null;
    afterChange();
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
      const area = findArea(selected);
      if (area) {
        handle = transform.toScreen(polygonCentroid(area.points));
      } else {
        const measurement = findMeasurement(selected);
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

  // ---- pointer ----
  function onPointerDown(event, screen, { forcePan }) {
    if (forcePan || state.tool === 'select') {
      const measurement = typeof state.selectedId === 'number' ? findMeasurement(state.selectedId) : null;
      if (!forcePan && measurement) {
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
    controller.requestRender();
    if (drag.touch) controller.updateLoupe(screen, start.point);
  }

  function onPointerMove(event, screen) {
    if (!drag) {
      if (state.tool === 'measure' || state.tool === 'calibrate') {
        const result = resolvePoint(screen, null, event.shiftKey);
        state.snap = result.snapped ? result.point : null;
        controller.requestRender();
      } else if (state.tool === 'area') {
        const previous = state.areaDraft[state.areaDraft.length - 1] || null;
        const result = resolvePoint(screen, previous, event.shiftKey);
        state.areaCursor = result.point;
        state.snap = result.snapped ? result.point : null;
        controller.requestRender();
      }
      return;
    }
    if (drag.pointerId !== event.pointerId) return;

    if (drag.mode === 'edit') {
      const measurement = findMeasurement(drag.id);
      if (!measurement) return;
      const other = drag.endpoint === 'a' ? measurement.b : measurement.a;
      const result = resolvePoint(screen, other, event.shiftKey, drag.id);
      if (!drag.moved) {
        pushHistory();
        drag.moved = true;
      }
      measurement[drag.endpoint] = result.point;
      state.snap = result.snapped ? result.point : null;
      controller.requestRender();
      syncUI();
      if (drag.touch) controller.updateLoupe(screen, result.point);
      return;
    }

    if (drag.mode === 'editBody') {
      const measurement = findMeasurement(drag.id);
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
      controller.requestRender();
      syncUI();
      return;
    }

    if (drag.mode === 'area' || drag.mode === 'pan') {
      const dx = screen.x - drag.startScreen.x;
      const dy = screen.y - drag.startScreen.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      state.view = {
        scale: drag.startView.scale,
        tx: drag.startView.tx + dx,
        ty: drag.startView.ty + dy,
      };
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
        save?.();
      }
      state.snap = null;
      controller.requestRender();
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
        controller.requestRender();
      }
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

  // ---- lists ----
  function buildMeasurementList() {
    els.measurementList.textContent = '';
    state.measurements.forEach((measurement, index) => {
      const mm = pxToMm(distance(measurement.a, measurement.b), state.calibration?.pxPerMeter);
      const item = document.createElement('li');
      item.className = measurement.id === state.selectedId ? 'active' : '';
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
        controller.requestRender();
        syncUI();
      });
      els.measurementList.append(item);
    });
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
      const remove = document.createElement('button');
      remove.className = 'remove';
      remove.textContent = '×';
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        pushHistory();
        state.areas = state.areas.filter((a) => a.id !== area.id);
        if (state.selectedId === area.id) state.selectedId = null;
        afterChange();
      });
      const meta = document.createElement('div');
      meta.className = 'meta';
      const type = document.createElement('select');
      for (const option of SPACE_TYPES) {
        const opt = document.createElement('option');
        opt.value = option.value;
        opt.textContent = option.label;
        type.append(opt);
      }
      type.value = area.type || 'medicion';
      type.addEventListener('click', (event) => event.stopPropagation());
      type.addEventListener('change', () => {
        pushHistory();
        area.type = type.value;
        afterChange();
      });
      const metric = document.createElement('span');
      metric.className = 'metric';
      metric.textContent = areaText(area.points);
      meta.append(type, metric);
      item.append(idx, name, remove, meta);
      item.addEventListener('click', () => {
        state.selectedId = area.id;
        controller.requestRender();
        syncUI();
      });
      els.areaList.append(item);
    });
  }

  function buildSummary() {
    const q = computeQuantities(state);
    const rows = [];
    rows.push(['q-label', 'Measured area'], ['q-value', `${q.measuredArea.toFixed(2)} m²`]);
    rows.push(['q-label', 'Useful area'], ['q-value', `${q.usefulArea.toFixed(2)} m²`]);
    for (const [type, area] of q.roomsByType) {
      const label = SPACE_TYPES.find((t) => t.value === type)?.label || type;
      rows.push(['q-label', label], ['q-value', `${area.toFixed(2)} m²`]);
    }
    els.measureSummary.textContent = '';
    for (const [cls, text] of rows) {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      els.measureSummary.append(span);
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
      els.calibrateStatus.className = 'badge ok';
      els.calibrateStatus.textContent = `${formatLength(value, unit)} · ${pxPerMeter.toFixed(2)} px/m`;
      els.resetCalibration.hidden = false;
    } else {
      els.calibrateStatus.className = 'badge warn';
      els.calibrateStatus.textContent = 'Not calibrated';
      els.resetCalibration.hidden = true;
    }
    els.knownSet.disabled = !(typeof state.selectedId === 'number' && findMeasurement(state.selectedId));
    const count = state.measurements.length + state.areas.length;
    els.measureCount.textContent = String(state.measurements.length);
    els.panelCount.textContent = String(count);
    els.panelCount.hidden = count === 0;
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
    buildSummary();
    els.undoBtn.disabled = history.length === 0;
    els.redoBtn.disabled = redoStack.length === 0;
    els.deleteBtn.disabled = state.selectedId == null;
    els.clearMeasureBtn.disabled = state.measurements.length === 0;
    els.clearAreaBtn.disabled = state.areas.length === 0;
    positionDeleteHandle();
  }

  function setTool(tool) {
    const leavingArea = state.tool === 'area' && tool !== 'area';
    state.tool = tool;
    state.preview = null;
    state.snap = null;
    controller.hideLoupe();
    els.canvas.style.cursor = tool === 'select' ? 'grab' : 'crosshair';
    if (leavingArea && state.areaDraft.length) {
      if (state.areaDraft.length >= 3) commitArea();
      else cancelArea();
    }
    if (tool === 'measure' || tool === 'calibrate') setLayerVisible('measure', true);
    if (tool === 'area') setLayerVisible('area', true);
    syncUI();
  }

  function setLayerVisible(layer, visible) {
    if (layerVisible(layer) === visible) return;
    state.layerVisibility = { ...state.layerVisibility, [layer]: visible };
    project.settings.layers = state.layerVisibility;
    if (!visible) {
      if (layer === 'measure' && (state.selectedId === 'calibration' || findMeasurement(state.selectedId))) {
        state.selectedId = null;
      }
      if (layer === 'area' && findArea(state.selectedId)) state.selectedId = null;
    }
    afterChange();
  }

  function toggleLayer(layer) {
    setLayerVisible(layer, !layerVisible(layer));
  }

  function exportPng() {
    if (!state.source || !state.source.bitmap) return;
    const exportState = { ...state, view: { scale: 1, tx: 0, ty: 0 }, selectedId: null, preview: null, snap: null };
    const canvas = document.createElement('canvas');
    canvas.width = state.source.width;
    canvas.height = state.source.height;
    render(canvas.getContext('2d'), exportState, canvas.width, canvas.height, {
      background: '#ffffff',
      showScaleBar: false,
    });
    canvas.toBlob((blob) => {
      if (!blob) return;
      downloadBlob(blob, `${(state.source.name || 'plan').replace(/\.[^.]+$/, '')}-dimensions.png`);
      toast('Exported PNG');
    }, 'image/png');
  }

  function exportCsv() {
    const csv = toCsv(quantitiesToRows(computeQuantities(state)));
    downloadBlob(new Blob([csv], { type: 'text/csv' }), `${(state.source?.name || 'plan').replace(/\.[^.]+$/, '')}-measure.csv`);
    toast('Exported CSV');
  }

  async function exportProjectFile() {
    if (!project.underlay) {
      toast('Nothing to export', true);
      return;
    }
    stash();
    const data = await blobToDataUrl(state.source.blob);
    const payload = {
      format: 'plan-calc-project',
      version: 2,
      project: { ...project, underlay: { ...project.underlay, sourceBuffer: null, sourceBlob: null } },
      source: { type: state.source.blob.type, data },
    };
    downloadBlob(
      new Blob([JSON.stringify(payload)], { type: 'application/json' }),
      `${(project.name || 'project').replace(/\s+/g, '-').toLowerCase()}.plan-calc.json`,
    );
    toast('Project exported');
  }

  async function importProjectFile(file) {
    showLoading('Importing…');
    try {
      const payload = JSON.parse(await file.text());
      if (!payload || payload.format !== 'plan-calc-project' || !payload.source?.data) {
        throw new Error('Not a plan-calc project file');
      }
      const blob = dataUrlToBlob(payload.source.data);
      project.name = payload.project?.name || project.name;
      project.sheets = payload.project?.sheets || project.sheets;
      project.settings = payload.project?.settings || project.settings;
      project.activePage = payload.project?.activePage || 1;
      project.underlay = {
        kind: payload.project?.underlay?.kind || 'image',
        name: payload.project?.underlay?.name || 'plan',
        sourceType: payload.source.type || '',
        sourceBuffer: null,
        sourceBlob: blob,
        pageCount: payload.project?.underlay?.pageCount || 1,
      };
      await loadUnderlay();
      loadSheet();
      state.layerVisibility = resolveLayerVisibility(project.settings.layers);
      state.snapLines = project.settings.snapLines ?? false;
      history = [];
      redoStack = [];
      onExit?.();
    } catch (error) {
      console.error(error);
      toast('Could not import that file', true);
    } finally {
      hideLoading();
    }
  }

  async function loadUnderlay() {
    if (!project.underlay) return;
    const data = project.underlay.sourceBuffer || project.underlay.sourceBlob;
    if (!data) return;
    const file = new File([data], project.underlay.name || 'plan', { type: project.underlay.sourceType || '' });
    showLoading('Loading plan…');
    try {
      if (state.source) releaseSource(state.source);
      let source = await createSource(file);
      if (project.underlay.kind === 'pdf' && project.activePage > 1) {
        source = await goToPage(source, project.activePage);
      }
      state.source = source;
      controller.fit();
    } catch (error) {
      console.error(error);
      toast('Could not load the plan', true);
    } finally {
      hideLoading();
    }
  }

  async function changePage(delta) {
    if (!state.source || !state.source.pdfDoc) return;
    const target = state.source.page + delta;
    if (target < 1 || target > state.source.pageCount) return;
    stash();
    project.activePage = target;
    state.source = await goToPage(state.source, target);
    loadSheet();
    history = [];
    redoStack = [];
    afterChange();
  }

  // ---- bindings ----
  function onKeyDown(event) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.code === 'Space') return;
    if (event.key === '1') setTool('select');
    else if (event.key === '2') setTool('calibrate');
    else if (event.key === '3') setTool('measure');
    else if (event.key === '4') setTool('area');
    else if (event.key === 'Enter' && state.tool === 'area' && state.areaDraft.length >= 3) commitArea();
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
      if (state.areaDraft.length) cancelArea();
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
    render: (ctx, s, w, h) => render(ctx, s, w, h),
    renderLoupe: (ctx, s, w, h, sourceRect) => render(ctx, s, w, h, { showScaleBar: false, sourceRect }),
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onChanged: () => save?.(),
  });

  // populate selects
  els.spaceType.textContent = '';
  for (const option of SPACE_TYPES) {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    els.spaceType.append(opt);
  }
  els.spaceType.value = 'medicion';

  for (const button of els.toolButtons) {
    button.addEventListener('click', () => setTool(button.dataset.tool));
  }
  els.panelToggle.addEventListener('click', () => setPanelVisible(document.body.classList.contains('panel-hidden')));
  els.panelClose.addEventListener('click', () => setPanelVisible(false));
  els.snapToggle.addEventListener('click', () => setSnapLines(!state.snapLines));
  els.deleteBtn.addEventListener('click', requestDelete);
  els.clearMeasureBtn.addEventListener('click', () => {
    if (!state.measurements.length) return;
    pushHistory();
    state.measurements = [];
    state.selectedId = null;
    afterChange();
  });
  els.clearAreaBtn.addEventListener('click', () => {
    if (!state.areas.length) return;
    pushHistory();
    state.areas = [];
    state.selectedId = null;
    afterChange();
  });
  els.layerMeasureToggle.addEventListener('click', () => toggleLayer('measure'));
  els.layerAreaToggle.addEventListener('click', () => toggleLayer('area'));
  els.resetCalibration.addEventListener('click', () => {
    if (!state.calibration) return;
    pushHistory();
    state.calibration = null;
    afterChange();
  });
  els.knownSet.addEventListener('click', () => {
    const measurement = typeof state.selectedId === 'number' ? findMeasurement(state.selectedId) : null;
    if (!measurement) {
      toast('Select a dimension first', true);
      return;
    }
    const value = Number.parseFloat(els.knownValue.value.replace(',', '.'));
    try {
      const realMeters = toMeters(value, els.knownUnit.value);
      pushHistory();
      state.calibration = {
        a: { ...measurement.a },
        b: { ...measurement.b },
        realMeters,
        value,
        unit: els.knownUnit.value,
        pxPerMeter: computePxPerMeter(measurement.a, measurement.b, realMeters),
        source: 'known',
      };
      afterChange();
      toast('Scale set from the selected dimension');
    } catch (error) {
      toast(error.message, true);
    }
  });
  els.exportPng.addEventListener('click', exportPng);
  els.exportCsv.addEventListener('click', exportCsv);
  els.exportProject.addEventListener('click', exportProjectFile);
  els.importProject.addEventListener('click', () => els.projectInput.click());
  els.projectInput.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) importProjectFile(file);
    event.target.value = '';
  });
  els.pagePrev.addEventListener('click', () => changePage(-1));
  els.pageNext.addEventListener('click', () => changePage(1));
  window.addEventListener('keydown', onKeyDown);

  // initial
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
      els.measureToolbar.hidden = !active;
      els.panel.hidden = !active;
    },
    undo,
    redo,
    fit() {
      controller.fit();
      afterChange();
    },
    requestDelete,
    destroy() {
      window.removeEventListener('keydown', onKeyDown);
      controller.destroy();
    },
  };
}
