import test from 'node:test';
import assert from 'node:assert/strict';
import {
  binarize,
  bridgeCollinear,
  distanceTransform,
  extractWalls,
  mergeCollinear,
  otsuThreshold,
  pruneSkeleton,
  skeletonize,
  toGray,
  traceSkeleton,
} from '../src/autowall.js';

function makeImage(width, height, draw) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const set = (x, y, value) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  };
  const fill = (x0, y0, w, h, value) => {
    for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) set(x, y, value);
  };
  draw({ set, fill });
  return { width, height, data };
}

test('toGray converts RGB and blends alpha over white', () => {
  const image = {
    width: 3,
    height: 1,
    data: new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 255, 255, 255,
      255, 0, 0, 128,
    ]),
  };
  const gray = toGray(image);
  assert.equal(gray[0], 0);
  assert.equal(gray[1], 255);
  assert.ok(gray[2] > 120 && gray[2] < 200);
});

test('otsuThreshold splits a bimodal image', () => {
  const gray = new Uint8Array(200);
  gray.fill(0, 0, 60);
  gray.fill(255, 60);
  const threshold = otsuThreshold(gray);
  assert.ok(threshold < 255);
});

test('binarize keeps a dark rectangle out of a light background', () => {
  const image = makeImage(120, 80, ({ fill }) => fill(40, 20, 30, 40, 0));
  const gray = toGray(image);
  const mask = binarize(gray, 120, 80, { window: 31 });
  assert.equal(mask[40 * 120 + 50], 1);
  assert.equal(mask[5 * 120 + 5], 0);
});

test('distanceTransform reports the distance to the nearest background', () => {
  const mask = new Uint8Array(50);
  mask.fill(1, 20, 30);
  const dt = distanceTransform(mask, 50, 1);
  assert.equal(dt[24], 5);
  assert.equal(dt[25], 5);
});

test('skeletonize leaves a one-pixel line untouched', () => {
  const width = 20;
  const mask = new Uint8Array(width * 5);
  for (let x = 2; x < 18; x += 1) mask[2 * width + x] = 1;
  const skeleton = skeletonize(mask, width, 5);
  const pixels = skeleton.reduce((sum, value) => sum + value, 0);
  assert.equal(pixels, 16);
  for (let x = 2; x < 18; x += 1) assert.equal(skeleton[2 * width + x], 1);
});

test('pruneSkeleton drops a short whisker but keeps a long branch', () => {
  const width = 30;
  const mask = new Uint8Array(width * 30);
  for (let x = 0; x < 20; x += 1) mask[15 * width + x] = 1;
  for (let y = 15; y >= 13; y -= 1) mask[y * width + 5] = 1;
  const pruned = pruneSkeleton(mask, width, 30, 5);
  assert.equal(pruned[13 * width + 5], 0);
  assert.equal(pruned[15 * width + 19], 1);
});

test('traceSkeleton walks a straight line into a single polyline', () => {
  const width = 20;
  const mask = new Uint8Array(width * 4);
  for (let x = 1; x < 19; x += 1) mask[2 * width + x] = 1;
  const paths = traceSkeleton(mask, width, 4);
  assert.equal(paths.length, 1);
  assert.equal(paths[0].length, 18);
});

test('mergeCollinear joins two collinear segments across a shared node', () => {
  const merged = mergeCollinear([
    { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, thickness: 8 },
    { a: { x: 10, y: 0 }, b: { x: 25, y: 0 }, thickness: 8 },
    { a: { x: 25, y: 0 }, b: { x: 25, y: 10 }, thickness: 8 },
  ]);
  const horizontal = merged.filter((s) => s.a.y === s.b.y);
  assert.equal(horizontal.length, 1);
  assert.equal(horizontal[0].b.x - horizontal[0].a.x, 25);
  assert.equal(merged.length, 2);
});

test('extractWalls finds the centre-lines of a thick rectangular room', () => {
  const image = makeImage(240, 180, ({ fill }) => {
    fill(30, 30, 180, 120, 255);
    fill(30, 30, 180, 8, 20);
    fill(30, 142, 180, 8, 20);
    fill(30, 30, 8, 120, 20);
    fill(202, 30, 8, 120, 20);
  });
  const result = extractWalls(image, { thresholdWindow: 41 });
  assert.ok(result.segments.length >= 4, `expected at least 4 segments, got ${result.segments.length}`);
  for (const segment of result.segments) {
    const horizontal = Math.abs(segment.a.y - segment.b.y) < 1.5;
    const vertical = Math.abs(segment.a.x - segment.b.x) < 1.5;
    assert.ok(horizontal || vertical, 'detected wall should be axis-aligned');
    assert.ok(segment.thickness >= 6 && segment.thickness <= 11, `thickness ${segment.thickness}`);
  }
  const lengths = result.segments.map((s) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y));
  assert.ok(Math.max(...lengths) > 150);
});

test('bridgeCollinear joins collinear segments across a small gap', () => {
  const bridged = bridgeCollinear(
    [
      { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, thickness: 8 },
      { a: { x: 14, y: 0 }, b: { x: 30, y: 0 }, thickness: 8 },
    ],
    { gap: 6 },
  );
  assert.equal(bridged.length, 1);
  assert.equal(bridged[0].a.x, 0);
  assert.equal(bridged[0].b.x, 30);
});

test('bridgeCollinear does not cross a junction in the gap', () => {
  const bridged = bridgeCollinear(
    [
      { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, thickness: 8 },
      { a: { x: 14, y: 0 }, b: { x: 30, y: 0 }, thickness: 8 },
      { a: { x: 12, y: 0 }, b: { x: 12, y: 20 }, thickness: 8 },
    ],
    { gap: 6 },
  );
  assert.equal(bridged.length, 3);
});

test('extractWalls detects a square pillar as a column, not diagonals', () => {
  const image = makeImage(240, 180, ({ fill }) => {
    fill(20, 86, 200, 8, 20);
    fill(106, 76, 28, 28, 20);
  });
  const result = extractWalls(image, { thresholdWindow: 41 });
  assert.ok(result.columns.length >= 1, 'pillar should be detected as a column');
  const pillar = result.columns[0];
  for (const segment of result.segments) {
    const midX = (segment.a.x + segment.b.x) / 2;
    const midY = (segment.a.y + segment.b.y) / 2;
    const inside =
      Math.abs(midX - pillar.x) <= pillar.w / 2 && Math.abs(midY - pillar.y) <= pillar.h / 2;
    assert.ok(!inside, 'no wall segment should cross the pillar');
  }
});

test('extractWalls ignores an isolated dark blob (furniture)', () => {
  const image = makeImage(240, 180, ({ fill }) => {
    fill(30, 30, 180, 120, 255);
    fill(30, 30, 180, 8, 20);
    fill(30, 142, 180, 8, 20);
    fill(30, 30, 8, 120, 20);
    fill(202, 30, 8, 120, 20);
    fill(100, 80, 40, 40, 0);
  });
  const result = extractWalls(image, { thresholdWindow: 41 });
  for (const segment of result.segments) {
    const midX = (segment.a.x + segment.b.x) / 2;
    const midY = (segment.a.y + segment.b.y) / 2;
    const insideBlob = midX > 100 && midX < 140 && midY > 80 && midY < 120;
    assert.ok(!insideBlob, 'isolated blob must not become a wall');
  }
});

test('extractWalls is deterministic', () => {
  const image = makeImage(240, 180, ({ fill }) => {
    fill(30, 30, 180, 120, 255);
    fill(30, 30, 180, 8, 20);
    fill(30, 142, 180, 8, 20);
    fill(30, 30, 8, 120, 20);
    fill(202, 30, 8, 120, 20);
    fill(120, 30, 8, 120, 20);
  });
  const a = extractWalls(image, { thresholdWindow: 41 });
  const b = extractWalls(image, { thresholdWindow: 41 });
  assert.deepEqual(a.segments, b.segments);
  assert.deepEqual(a.columns, b.columns);
});
