import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeQuantities,
  isRoom,
  openingType,
  quantitiesToRows,
  spaceType,
  toCsv,
  wallType,
} from '../src/model.js';

function square(size = 100) {
  return [
    { x: 0, y: 0 },
    { x: size, y: 0 },
    { x: size, y: size },
    { x: 0, y: size },
  ];
}

const baseState = {
  calibration: { pxPerMeter: 100 },
  areas: [
    { id: 1, name: 'Living', type: 'salon', points: square(100) },
    { id: 2, name: '', type: 'medicion', points: square(100) },
  ],
  walls: [{ id: 3, type: 'tabique', thickness: 100, a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }],
  openings: [{ id: 4, type: 'puerta', a: { x: 0, y: 0 }, b: { x: 80, y: 0 } }],
};

test('type helpers resolve and detect rooms', () => {
  assert.equal(spaceType('salon').label, 'Living room');
  assert.equal(spaceType('nope').value, 'medicion');
  assert.equal(isRoom('cocina'), true);
  assert.equal(isRoom('medicion'), false);
  assert.equal(isRoom(undefined), false);
  assert.equal(wallType('carga').thickness, 240);
  assert.equal(openingType('ventana').label, 'Window');
});

test('computes areas, walls and openings from calibrated pixels', () => {
  const q = computeQuantities(baseState);
  assert.equal(q.calibrated, true);
  assert.equal(q.usefulArea, 1);
  assert.equal(q.measuredArea, 2);
  assert.equal(q.wallLength, 1);
  assert.equal(q.wallArea, 0.1);
  assert.equal(q.builtArea, 1.1);
  assert.equal(q.openingCount, 1);
  assert.equal(q.openingWidth, 0.8);
  assert.equal(q.roomsByType.get('salon'), 1);
  assert.equal(q.wallsByType.get('tabique').length, 1);
  assert.equal(q.openingsByType.get('puerta').count, 1);
});

test('reports everything as zero when uncalibrated', () => {
  const q = computeQuantities({ areas: baseState.areas, walls: baseState.walls, openings: baseState.openings });
  assert.equal(q.calibrated, false);
  assert.equal(q.usefulArea, 0);
  assert.equal(q.wallArea, 0);
  assert.equal(q.openingWidth, 0);
});

test('handles a missing/empty state', () => {
  const q = computeQuantities({});
  assert.equal(q.usefulArea, 0);
  assert.equal(q.wallLength, 0);
  assert.equal(q.openingsByType.size, 0);
});

test('quantitiesToRows uses labels and keeps spaces by name', () => {
  const rows = quantitiesToRows(computeQuantities(baseState));
  assert.deepEqual(rows[0], ['Category', 'Item', 'Value', 'Unit']);
  assert.ok(rows.some((row) => row[1] === 'Useful area' && row[2] === 1 && row[3] === 'm2'));
  assert.ok(rows.some((row) => row[0] === 'Spaces' && row[1] === 'Living' && row[2] === 1));
  assert.ok(rows.some((row) => row[0] === 'Walls by type' && row[1] === 'Partition'));
});

test('toCsv quotes fields with commas or quotes', () => {
  const csv = toCsv([
    ['a', 'b'],
    ['x,y', 'say "hi"'],
  ]);
  assert.equal(csv, 'a,b\n"x,y","say ""hi"""');
});
