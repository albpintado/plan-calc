export const MM_PER_METER = 1000;

export const UNIT_TO_METERS = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254,
  ft: 0.3048,
};

export function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function toMeters(value, unit) {
  const factor = UNIT_TO_METERS[unit];
  if (!factor) throw new Error(`Unknown unit: ${unit}`);
  if (!Number.isFinite(value)) throw new Error('Value must be a finite number');
  return value * factor;
}

export function computePxPerMeter(a, b, realMeters) {
  if (!(realMeters > 0)) throw new Error('Real distance must be greater than zero');
  const px = distance(a, b);
  if (px <= 0) throw new Error('Calibration points must be different');
  return px / realMeters;
}

export function pxToMm(px, pxPerMeter) {
  if (!pxPerMeter) return null;
  return (px / pxPerMeter) * MM_PER_METER;
}

export function formatMm(mm, decimals = 0, locale = undefined) {
  if (mm == null || !Number.isFinite(mm)) return '—';
  const factor = 10 ** decimals;
  const rounded = Math.round(mm * factor) / factor;
  return `${rounded.toLocaleString(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} mm`;
}

export function formatMeters(meters, decimals = 3, locale = undefined) {
  if (meters == null || !Number.isFinite(meters)) return '—';
  return `${meters.toLocaleString(locale, {
    maximumFractionDigits: decimals,
  })} m`;
}

export function formatLength(value, unit, locale = undefined) {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toLocaleString(locale, { maximumFractionDigits: 6 })} ${unit}`;
}

export function formatDimension(mm, locale = undefined) {
  if (mm == null || !Number.isFinite(mm)) return '—';
  const abs = Math.abs(mm);
  if (abs < 100) return `${mm.toLocaleString(locale, { maximumFractionDigits: 0 })} mm`;
  if (abs < 1000) return `${(mm / 10).toLocaleString(locale, { maximumFractionDigits: 1 })} cm`;
  return `${(mm / 1000).toLocaleString(locale, { maximumFractionDigits: 3 })} m`;
}

export function constrainAngle(a, b, stepDeg = 45) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const r = Math.hypot(dx, dy);
  if (r === 0) return { x: b.x, y: b.y };
  const step = (stepDeg * Math.PI) / 180;
  const snapped = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: a.x + Math.cos(snapped) * r, y: a.y + Math.sin(snapped) * r };
}

export function normalizeAngle(angle) {
  const twoPi = Math.PI * 2;
  let value = angle % twoPi;
  if (value > Math.PI) value -= twoPi;
  if (value < -Math.PI) value += twoPi;
  return value;
}

export function snapToDirections(a, b, directions, toleranceRad = 0.22) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0 || !directions.length) return { x: b.x, y: b.y, snapped: false };
  const angle = Math.atan2(dy, dx);
  let bestAngle = angle;
  let bestDiff = Infinity;
  for (const direction of directions) {
    for (const candidate of [direction, direction + Math.PI]) {
      const diff = Math.abs(normalizeAngle(candidate - angle));
      if (diff < bestDiff) {
        bestDiff = diff;
        bestAngle = candidate;
      }
    }
  }
  if (bestDiff > toleranceRad) return { x: b.x, y: b.y, snapped: false };
  const projection = dx * Math.cos(bestAngle) + dy * Math.sin(bestAngle);
  return {
    x: a.x + Math.cos(bestAngle) * projection,
    y: a.y + Math.sin(bestAngle) * projection,
    snapped: true,
  };
}

export function segmentAngle(a, b) {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

export function segmentMidpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function findSnapPoint(pt, points, tolerance) {
  let best = null;
  let bestDistance = tolerance;
  for (const candidate of points) {
    const d = distance(pt, candidate);
    if (d <= bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

export function nearestPointOnSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return { point: { x: a.x, y: a.y }, t: 0 };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return { point: { x: a.x + t * dx, y: a.y + t * dy }, t };
}

export function distanceToSegment(p, a, b) {
  return distance(p, nearestPointOnSegment(p, a, b).point);
}

export function niceScaleBar(pxPerMeter, targetPx = 140) {
  if (!pxPerMeter) return null;
  const targetMeters = targetPx / pxPerMeter;
  const power = 10 ** Math.floor(Math.log10(targetMeters));
  const candidates = [1, 2, 5, 10].map((c) => c * power);
  let best = candidates[0];
  for (const candidate of candidates) {
    if (Math.abs(candidate - targetMeters) < Math.abs(best - targetMeters)) best = candidate;
  }
  return { meters: best, px: best * pxPerMeter };
}
