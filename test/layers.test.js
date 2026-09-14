import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LAYER_VISIBILITY,
  LAYERS,
  isLayerVisible,
  resolveLayerVisibility,
} from '../src/layers.js';

test('defaults to every layer visible', () => {
  assert.deepEqual(resolveLayerVisibility(undefined), DEFAULT_LAYER_VISIBILITY);
  assert.deepEqual(resolveLayerVisibility(null), DEFAULT_LAYER_VISIBILITY);
  assert.deepEqual(resolveLayerVisibility({}), DEFAULT_LAYER_VISIBILITY);
});

test('keeps a partial visibility object and fills the rest', () => {
  assert.deepEqual(resolveLayerVisibility({ area: false }), {
    measure: true,
    area: false,
    wall: true,
    opening: true,
    room: true,
    column: true,
  });
  assert.deepEqual(resolveLayerVisibility({ measure: false }), {
    measure: false,
    area: true,
    wall: true,
    opening: true,
    room: true,
    column: true,
  });
});

test('accepts the new wall and opening layers', () => {
  assert.deepEqual(resolveLayerVisibility({ wall: false, opening: false }), {
    measure: true,
    area: true,
    wall: false,
    opening: false,
    room: true,
    column: true,
  });
});

test('ignores unknown and non-boolean values', () => {
  const resolved = resolveLayerVisibility({ measure: 'yes', area: false, future: false });
  assert.deepEqual(resolved, {
    measure: true,
    area: false,
    wall: true,
    opening: true,
    room: true,
    column: true,
  });
  assert.deepEqual(Object.keys(resolved).sort(), [...LAYERS].sort());
});

test('does not mutate the input', () => {
  const input = { area: false };
  resolveLayerVisibility(input);
  assert.deepEqual(input, { area: false });
});

test('isLayerVisible resolves a boolean for a single layer', () => {
  assert.equal(isLayerVisible(undefined, 'measure'), true);
  assert.equal(isLayerVisible({ area: false }, 'area'), false);
  assert.equal(isLayerVisible({ area: false }, 'measure'), true);
});
