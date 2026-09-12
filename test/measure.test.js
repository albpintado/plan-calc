import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePxPerMeter,
  constrainAngle,
  distance,
  distanceToSegment,
  findSnapPoint,
  formatDimension,
  formatLength,
  formatMeters,
  formatMm,
  nearestPointOnSegment,
  niceScaleBar,
  normalizeAngle,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  pxToMm,
  snapToDirections,
  toMeters,
  formatArea,
} from '../src/measure.js';

test('distance is euclidean', () => {
  assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
});

test('toMeters converts supported units', () => {
  assert.equal(toMeters(1000, 'mm'), 1);
  assert.equal(toMeters(100, 'cm'), 1);
  assert.equal(toMeters(2, 'm'), 2);
  assert.ok(Math.abs(toMeters(12, 'in') - 0.3048) < 1e-12);
  assert.throws(() => toMeters(1, 'parsec'));
  assert.throws(() => toMeters(Number.NaN, 'm'));
});

test('computePxPerMeter from a graphic scale', () => {
  const pxPerMeter = computePxPerMeter({ x: 0, y: 0 }, { x: 500, y: 0 }, 5);
  assert.equal(pxPerMeter, 100);
});

test('computePxPerMeter rejects invalid input', () => {
  assert.throws(() => computePxPerMeter({ x: 0, y: 0 }, { x: 10, y: 0 }, 0));
  assert.throws(() => computePxPerMeter({ x: 0, y: 0 }, { x: 0, y: 0 }, 1));
});

test('pxToMm is millimetre precise', () => {
  const pxPerMeter = 100;
  assert.equal(pxToMm(100, pxPerMeter), 1000);
  assert.ok(Math.abs(pxToMm(345.6, pxPerMeter) - 3456) < 1e-9);
  assert.equal(pxToMm(1, null), null);
});

test('formatMm respects the locale and avoids the Spanish comma misread', () => {
  assert.equal(formatMm(3456, 0, 'en-US'), '3,456 mm');
  assert.equal(formatMm(12.34, 1, 'en-US'), '12.3 mm');
  assert.equal(formatMm(3900, 0, 'es-ES'), '3900 mm');
  assert.equal(formatMm(12345, 0, 'es-ES'), '12.345 mm');
  assert.equal(formatMm(null), '—');
});

test('formatMeters drops trailing zeros', () => {
  assert.equal(formatMeters(3.9, 3, 'es-ES'), '3,9 m');
  assert.equal(formatMeters(3.456, 3, 'en-US'), '3.456 m');
  assert.equal(formatMeters(null), '—');
});

test('formatLength keeps the unit the user typed', () => {
  assert.equal(formatLength(0.67, 'cm', 'en-US'), '0.67 cm');
  assert.equal(formatLength(1, 'm', 'en-US'), '1 m');
  assert.equal(formatLength(1000, 'mm', 'en-US'), '1,000 mm');
  assert.equal(formatLength(null, 'm'), '—');
});

test('formatDimension switches unit at 100 mm and 1000 mm', () => {
  assert.equal(formatDimension(45, 'en-US'), '45 mm');
  assert.equal(formatDimension(99.6, 'en-US'), '100 mm');
  assert.equal(formatDimension(100, 'en-US'), '10 cm');
  assert.equal(formatDimension(125, 'en-US'), '12.5 cm');
  assert.equal(formatDimension(999, 'en-US'), '99.9 cm');
  assert.equal(formatDimension(1000, 'en-US'), '1 m');
  assert.equal(formatDimension(3900, 'es-ES'), '3,9 m');
  assert.equal(formatDimension(3456, 'en-US'), '3.456 m');
  assert.equal(formatDimension(12345, 'es-ES'), '12,345 m');
  assert.equal(formatDimension(null), '—');
});

test('constrainAngle snaps to 45 degree steps', () => {
  const snapped = constrainAngle({ x: 0, y: 0 }, { x: 10, y: 1 }, 45);
  assert.equal(Math.round(snapped.x), 10);
  assert.equal(Math.round(snapped.y), 0);
});

test('normalizeAngle wraps to [-PI, PI]', () => {
  assert.ok(Math.abs(normalizeAngle(Math.PI * 2 + 0.5) - 0.5) < 1e-9);
  assert.ok(Math.abs(normalizeAngle(-Math.PI * 2 - 0.5) + 0.5) < 1e-9);
});

test('snapToDirections straightens a diagonal drag to an axis', () => {
  const horizontal = snapToDirections({ x: 0, y: 0 }, { x: 10, y: 0.5 }, [0, Math.PI / 2], 0.22);
  assert.equal(horizontal.snapped, true);
  assert.ok(Math.abs(horizontal.y) < 1e-9);
  assert.ok(Math.abs(horizontal.x - 10) < 1e-9);
  const vertical = snapToDirections({ x: 0, y: 0 }, { x: 0.4, y: 10 }, [0, Math.PI / 2], 0.22);
  assert.equal(vertical.snapped, true);
  assert.ok(Math.abs(vertical.x) < 1e-9);
  assert.ok(Math.abs(vertical.y - 10) < 1e-9);
});

test('snapToDirections aligns to an existing line angle', () => {
  const diag = Math.PI / 4;
  const result = snapToDirections({ x: 0, y: 0 }, { x: 10, y: 10 + 1 }, [diag], 0.22);
  assert.equal(result.snapped, true);
  assert.ok(Math.abs(result.x - result.y) < 1e-9);
});

test('snapToDirections leaves the point alone when nothing is close', () => {
  const result = snapToDirections({ x: 0, y: 0 }, { x: 10, y: 3 }, [0], 0.05);
  assert.equal(result.snapped, false);
  assert.deepEqual({ x: result.x, y: result.y }, { x: 10, y: 3 });
});

test('findSnapPoint returns nearest within tolerance', () => {
  const points = [
    { x: 100, y: 100 },
    { x: 200, y: 200 },
  ];
  assert.deepEqual(findSnapPoint({ x: 104, y: 103 }, points, 10), { x: 100, y: 100 });
  assert.equal(findSnapPoint({ x: 300, y: 300 }, points, 10), null);
});

test('nearestPointOnSegment clamps to the segment', () => {
  const result = nearestPointOnSegment({ x: 50, y: 30 }, { x: 0, y: 0 }, { x: 100, y: 0 });
  assert.deepEqual(result.point, { x: 50, y: 0 });
  assert.equal(distanceToSegment({ x: 150, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }), 50);
});

test('niceScaleBar picks a round distance close to target pixels', () => {
  const bar = niceScaleBar(100, 140);
  assert.deepEqual(bar, { meters: 1, px: 100 });
  const bar2 = niceScaleBar(2, 140);
  assert.equal(bar2.meters, 50);
  assert.equal(bar2.px, 100);
});

test('end-to-end: scale bar then a wall dimension', () => {
  const pxPerMeter = computePxPerMeter({ x: 0, y: 0 }, { x: 250, y: 0 }, 5);
  assert.equal(pxPerMeter, 50);
  const mm = pxToMm(distance({ x: 10, y: 10 }, { x: 10, y: 1740 }), pxPerMeter);
  assert.equal(Math.round(mm), 34600);
});

test('polygonArea uses the shoelace formula', () => {
  assert.equal(polygonArea([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]), 100);
  assert.equal(polygonArea([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }]), 6);
  assert.equal(polygonArea([{ x: 0, y: 0 }, { x: 1, y: 1 }]), 0);
});

test('pointInPolygon detects inside and outside', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.equal(pointInPolygon({ x: 5, y: 5 }, square), true);
  assert.equal(pointInPolygon({ x: 15, y: 5 }, square), false);
});

test('polygonCentroid averages the vertices', () => {
  assert.deepEqual(polygonCentroid([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]), {
    x: 5,
    y: 5,
  });
});

test('area in square metres from pixels', () => {
  const pxPerMeter = 50;
  const areaPx2 = polygonArea([{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 250 }, { x: 0, y: 250 }]);
  const squareMeters = areaPx2 / (pxPerMeter * pxPerMeter);
  assert.equal(squareMeters, 50);
  assert.equal(formatArea(squareMeters, 'en-US'), '50.00 m²');
  assert.equal(formatArea(0.0035, 'en-US'), '35 cm²');
});
