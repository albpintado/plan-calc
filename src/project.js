import { DEFAULT_LAYER_VISIBILITY, resolveLayerVisibility } from './layers.js';

export const PROJECT_SCHEMA_VERSION = 2;

export function emptyMeasureDoc() {
  return { nextId: 1, measurements: [], areas: [] };
}

export function emptyBuildDoc() {
  return { nextId: 1, nodes: [], walls: [], openings: [], rooms: [], columns: [] };
}

export function emptySheet() {
  return { calibration: null, measure: emptyMeasureDoc(), build: emptyBuildDoc() };
}

export function createProject({ id, name, now = Date.now() } = {}) {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: id || `p-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: name || 'Untitled project',
    createdAt: now,
    updatedAt: now,
    underlay: null,
    activePage: 1,
    sheets: { 1: emptySheet() },
    settings: {
      layers: { ...DEFAULT_LAYER_VISIBILITY },
      snapLines: false,
    },
  };
}

export function ensureSheet(project, page = 1) {
  const key = String(page);
  if (!project.sheets[key]) project.sheets[key] = emptySheet();
  return project.sheets[key];
}

export function getSheet(project, page = 1) {
  return project.sheets[String(page)] || emptySheet();
}

function nextIdFrom(...lists) {
  let max = 0;
  for (const list of lists) {
    for (const item of list || []) {
      if (typeof item.id === 'number' && item.id > max) max = item.id;
    }
  }
  return max + 1;
}

// Legacy walls are plain segments; the model wants shared nodes so corners move
// together. Rebuild the node table, merging endpoints that coincide.
function buildFromLegacy(walls, openings) {
  const doc = emptyBuildDoc();
  const byKey = new Map();
  const key = (point) => `${Math.round(point.x * 100)},${Math.round(point.y * 100)}`;
  const addNode = (point) => {
    const k = key(point);
    if (byKey.has(k)) return byKey.get(k);
    const node = { id: doc.nextId++, x: point.x, y: point.y };
    doc.nodes.push(node);
    byKey.set(k, node.id);
    return node.id;
  };
  for (const wall of walls || []) {
    doc.walls.push({
      id: doc.nextId++,
      n1: addNode(wall.a),
      n2: addNode(wall.b),
      type: wall.type || 'tabique',
      thickness: wall.thickness ?? 90,
    });
  }
  for (const opening of openings || []) {
    doc.openings.push({
      id: doc.nextId++,
      a: opening.a,
      b: opening.b,
      type: opening.type || 'puerta',
    });
  }
  return doc;
}

export function migrateLegacyRecord(record, { id, name, now = Date.now() } = {}) {
  const project = createProject({ id, name, now });
  const layers = resolveLayerVisibility(record.layers);
  project.settings = {
    layers,
    snapLines: record.snapLines ?? false,
  };

  if (record.sourceBuffer || record.sourceBlob) {
    project.underlay = {
      kind: record.kind || 'image',
      name: record.name || 'plan',
      sourceType:
        record.sourceType || (record.sourceBlob && record.sourceBlob.type) || '',
      sourceBuffer: record.sourceBuffer || null,
      sourceBlob: record.sourceBlob || null,
      pageCount: 1,
    };
  }
  project.activePage = record.page || 1;
  project.sheets = {};

  const entries =
    record.pages instanceof Map
      ? [...record.pages.entries()]
      : Array.isArray(record.pages)
        ? record.pages
        : [];
  let maxPage = project.activePage;
  for (const [page, annotations] of entries) {
    const key = Number(page) || 1;
    maxPage = Math.max(maxPage, key);
    const ann = annotations || {};
    project.sheets[String(key)] = {
      calibration: ann.calibration ?? null,
      measure: {
        nextId: nextIdFrom(ann.measurements, ann.areas),
        measurements: ann.measurements || [],
        areas: ann.areas || [],
      },
      build: buildFromLegacy(ann.walls, ann.openings),
    };
  }
  if (project.underlay) project.underlay.pageCount = Math.max(project.underlay.pageCount, maxPage);
  ensureSheet(project, project.activePage);
  return project;
}
