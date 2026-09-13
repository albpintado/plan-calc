import { extractWalls } from './autowall.js';

self.onmessage = (event) => {
  const { width, height, data, options } = event.data;
  try {
    const result = extractWalls({ width, height, data }, options);
    self.postMessage({ ok: true, ...result });
  } catch (error) {
    self.postMessage({ ok: false, error: error && error.message ? error.message : String(error) });
  }
};
