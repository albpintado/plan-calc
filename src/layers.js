export const LAYERS = ['measure', 'area'];

export const DEFAULT_LAYER_VISIBILITY = { measure: true, area: true };

export function resolveLayerVisibility(value) {
  const resolved = { ...DEFAULT_LAYER_VISIBILITY };
  if (value && typeof value === 'object') {
    for (const layer of LAYERS) {
      if (typeof value[layer] === 'boolean') resolved[layer] = value[layer];
    }
  }
  return resolved;
}

export function isLayerVisible(visibility, layer) {
  return resolveLayerVisibility(visibility)[layer];
}
