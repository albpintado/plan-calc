import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROJECT_SCHEMA_VERSION,
  createProject,
  emptyBuildDoc,
  emptySheet,
  ensureSheet,
  getSheet,
  migrateLegacyRecord,
} from '../src/project.js';

test('createProject starts with one empty sheet and default settings', () => {
  const project = createProject({ id: 'p1', name: 'Casa', now: 1000 });
  assert.equal(project.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.equal(project.id, 'p1');
  assert.equal(project.name, 'Casa');
  assert.equal(project.activePage, 1);
  assert.deepEqual(project.sheets['1'], emptySheet());
  assert.equal(project.settings.layers.measure, true);
  assert.equal(project.settings.snapLines, false);
});

test('ensureSheet creates and returns a sheet per page', () => {
  const project = createProject({ id: 'p1' });
  const sheet = ensureSheet(project, 3);
  assert.equal(project.sheets['3'], sheet);
  assert.equal(getSheet(project, 3), sheet);
  assert.deepEqual(getSheet(project, 9), emptySheet());
});

test('migrateLegacyRecord moves dimensions/areas to measure and walls/openings to build', () => {
  const now = 5000;
  const legacy = {
    kind: 'image',
    name: 'plano.png',
    sourceType: 'image/png',
    sourceBuffer: new ArrayBuffer(4),
    page: 1,
    snapLines: true,
    layers: { measure: true, area: false },
    pages: [
      [
        1,
        {
          calibration: { pxPerMeter: 50 },
          measurements: [{ id: 1, a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }],
          areas: [{ id: 2, points: [] }],
          walls: [
            { id: 3, a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, type: 'carga', thickness: 240 },
            { id: 4, a: { x: 100, y: 0 }, b: { x: 100, y: 50 }, type: 'tabique', thickness: 90 },
          ],
          openings: [{ id: 5, a: { x: 10, y: 0 }, b: { x: 20, y: 0 }, type: 'puerta' }],
        },
      ],
    ],
  };

  const project = migrateLegacyRecord(legacy, { id: 'legacy', name: 'Imported', now });
  assert.equal(project.id, 'legacy');
  assert.equal(project.name, 'Imported');
  assert.equal(project.settings.snapLines, true);
  assert.equal(project.settings.layers.area, false);
  assert.equal(project.settings.layers.wall, true);
  assert.equal(project.underlay.sourceBuffer.byteLength, 4);
  assert.equal(project.underlay.name, 'plano.png');

  const sheet = project.sheets['1'];
  assert.equal(sheet.calibration.pxPerMeter, 50);
  assert.equal(sheet.measure.measurements.length, 1);
  assert.equal(sheet.measure.areas.length, 1);
  assert.equal(sheet.build.walls.length, 2);
  assert.equal(sheet.build.openings.length, 1);

  // Three distinct nodes for the two walls (the shared corner is reused).
  assert.equal(sheet.build.nodes.length, 3);
  const wallA = sheet.build.walls[0];
  const wallB = sheet.build.walls[1];
  assert.equal(wallA.n2, wallB.n1, 'shared corner node is reused');
  const ids = [
    ...sheet.build.nodes,
    ...sheet.build.walls,
    ...sheet.build.openings,
  ].map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, 'element ids are unique');
});

test('emptyBuildDoc has a fresh id counter', () => {
  assert.deepEqual(emptyBuildDoc(), { nextId: 1, nodes: [], walls: [], openings: [], rooms: [] });
});
