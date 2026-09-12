import {
  distance,
  formatArea,
  formatDimension,
  formatLength,
  niceScaleBar,
  polygonArea,
  polygonCentroid,
  pxToMm,
} from './measure.js';
import { makeTransform } from './viewport.js';

export const COLORS = {
  background: '#0e1116',
  calibration: '#4da3ff',
  measure: '#ffb020',
  measureActive: '#ff5d55',
  preview: '#7ee787',
  snap: '#ff2d95',
  scaleBar: '#e6edf3',
  area: '#3fb950',
  areaFill: 'rgba(63, 185, 80, 0.18)',
  areaActive: '#ff5d55',
  areaActiveFill: 'rgba(255, 93, 85, 0.24)',
};

const TICK = 9;
const FONT = '600 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawLabel(ctx, x, y, text, angle, color) {
  ctx.save();
  ctx.translate(x, y);
  let rotation = angle;
  if (rotation > Math.PI / 2 || rotation < -Math.PI / 2) rotation += Math.PI;
  ctx.rotate(rotation);
  ctx.font = FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const width = ctx.measureText(text).width;
  const padX = 6;
  const height = 18;
  roundRect(ctx, -width / 2 - padX, -height / 2, width + padX * 2, height, 4);
  ctx.fillStyle = 'rgba(14,17,22,0.88)';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function endTicks(ctx, a, b, color) {
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const perpendicular = angle + Math.PI / 2;
  const dx = Math.cos(perpendicular) * TICK;
  const dy = Math.sin(perpendicular) * TICK;
  ctx.beginPath();
  ctx.moveTo(a.x - dx, a.y - dy);
  ctx.lineTo(a.x + dx, a.y + dy);
  ctx.moveTo(b.x - dx, b.y - dy);
  ctx.lineTo(b.x + dx, b.y + dy);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function screenSegment(transform, a, b) {
  return { a: transform.toScreen(a), b: transform.toScreen(b) };
}

function drawSegment(ctx, transform, a, b, color, text, dashed = false, labelOffset = 0) {
  const { a: sa, b: sb } = screenSegment(transform, a, b);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  if (dashed) ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(sa.x, sa.y);
  ctx.lineTo(sb.x, sb.y);
  ctx.stroke();
  ctx.setLineDash([]);
  endTicks(ctx, sa, sb, color);
  if (text) {
    const angle = Math.atan2(sb.y - sa.y, sb.x - sa.x);
    const perpendicular = angle + Math.PI / 2;
    let midX = (sa.x + sb.x) / 2;
    let midY = (sa.y + sb.y) / 2;
    if (labelOffset) {
      let ox = Math.cos(perpendicular);
      let oy = Math.sin(perpendicular);
      if (oy < 0) {
        ox = -ox;
        oy = -oy;
      }
      midX += ox * labelOffset;
      midY += oy * labelOffset;
    }
    drawLabel(ctx, midX, midY, text, angle, color);
  }
  ctx.restore();
}

function tracePolygon(ctx, screenPoints, close) {
  ctx.beginPath();
  ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
  for (let i = 1; i < screenPoints.length; i += 1) {
    ctx.lineTo(screenPoints[i].x, screenPoints[i].y);
  }
  if (close) ctx.closePath();
}

function drawVertices(ctx, screenPoints, color, highlightFirst) {
  ctx.save();
  ctx.fillStyle = color;
  for (let i = 0; i < screenPoints.length; i += 1) {
    ctx.beginPath();
    ctx.arc(screenPoints[i].x, screenPoints[i].y, i === 0 && highlightFirst ? 6 : 4, 0, Math.PI * 2);
    ctx.fill();
  }
  if (highlightFirst) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(screenPoints[0].x, screenPoints[0].y, 10, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function areaText(points, calibration) {
  if (calibration) {
    const squareMeters = polygonArea(points) / (calibration.pxPerMeter * calibration.pxPerMeter);
    return formatArea(squareMeters);
  }
  return `${polygonArea(points).toFixed(0)} px²`;
}

function drawArea(ctx, transform, points, options) {
  if (points.length < 3) return;
  const screenPoints = points.map((point) => transform.toScreen(point));
  ctx.save();
  tracePolygon(ctx, screenPoints, true);
  ctx.fillStyle = options.fill;
  ctx.fill();
  ctx.strokeStyle = options.stroke;
  ctx.lineWidth = 2;
  if (options.dashed) ctx.setLineDash([6, 5]);
  ctx.stroke();
  ctx.restore();
  drawVertices(ctx, screenPoints, options.stroke, false);
  const center = transform.toScreen(polygonCentroid(points));
  drawLabel(ctx, center.x, center.y, options.label, 0, options.stroke);
}

function drawAreaDraft(ctx, transform, draft, cursor, calibration) {
  if (!draft.length) return;
  const screenPoints = draft.map((point) => transform.toScreen(point));
  const closed = draft.length >= 3 ? [...draft, draft[0]] : draft;
  const previewPoints = closed.map((point) => transform.toScreen(point));
  ctx.save();
  if (draft.length >= 3) {
    tracePolygon(ctx, previewPoints, true);
    ctx.fillStyle = COLORS.areaFill;
    ctx.fill();
  }
  ctx.strokeStyle = COLORS.area;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 5]);
  tracePolygon(ctx, previewPoints, false);
  ctx.stroke();
  if (cursor && draft.length) {
    const last = screenPoints[screenPoints.length - 1];
    ctx.strokeStyle = COLORS.preview;
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    const cursorScreen = transform.toScreen(cursor);
    ctx.lineTo(cursorScreen.x, cursorScreen.y);
    if (draft.length >= 2) {
      ctx.lineTo(screenPoints[0].x, screenPoints[0].y);
    }
    ctx.stroke();
  }
  ctx.restore();
  drawVertices(ctx, screenPoints, COLORS.area, true);
  const areaPoints = draft.length >= 3 ? draft : [...draft, ...(cursor ? [cursor] : [])];
  if (areaPoints.length >= 3) {
    const center = transform.toScreen(polygonCentroid(areaPoints));
    drawLabel(ctx, center.x, center.y, areaText(areaPoints, calibration), 0, COLORS.area);
  }
}

function drawEditHandles(ctx, transform, measurement) {
  const a = transform.toScreen(measurement.a);
  const b = transform.toScreen(measurement.b);
  ctx.save();
  for (const point of [a, b]) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.measureActive;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  ctx.beginPath();
  ctx.arc(midX, midY, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = COLORS.measureActive;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawScaleBar(ctx, state, canvasHeight) {
  if (!state.calibration) return;
  const bar = niceScaleBar(state.calibration.pxPerMeter * state.view.scale, 140);
  if (!bar || bar.px < 8) return;
  const x = 20;
  const y = canvasHeight - 26;
  ctx.save();
  ctx.strokeStyle = COLORS.scaleBar;
  ctx.fillStyle = COLORS.scaleBar;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + bar.px, y);
  ctx.moveTo(x, y - 6);
  ctx.lineTo(x, y + 6);
  ctx.moveTo(x + bar.px, y - 6);
  ctx.lineTo(x + bar.px, y + 6);
  ctx.stroke();
  ctx.font = FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${bar.meters} m`, x, y - 8);
  ctx.restore();
}

function drawEmptyState(ctx, width, height) {
  ctx.save();
  ctx.fillStyle = 'rgba(230,237,243,0.45)';
  ctx.font = '500 15px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Open a plan (image or PDF) to start', width / 2, height / 2);
  ctx.restore();
}

export function render(ctx, state, canvasWidth, canvasHeight, options = {}) {
  const { background = COLORS.background, showScaleBar = true } = options;
  ctx.save();
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  if (!state.source || !state.source.bitmap) {
    drawEmptyState(ctx, canvasWidth, canvasHeight);
    ctx.restore();
    return;
  }

  const transform = makeTransform(state.view);
  const origin = transform.toScreen({ x: 0, y: 0 });
  ctx.imageSmoothingEnabled = state.view.scale < 1;
  if (options.sourceRect) {
    const rect = options.sourceRect;
    ctx.drawImage(
      state.source.bitmap,
      rect.x,
      rect.y,
      rect.w,
      rect.h,
      origin.x + rect.x * state.view.scale,
      origin.y + rect.y * state.view.scale,
      rect.w * state.view.scale,
      rect.h * state.view.scale,
    );
  } else {
    ctx.drawImage(
      state.source.bitmap,
      origin.x,
      origin.y,
      state.source.width * state.view.scale,
      state.source.height * state.view.scale,
    );
  }

  for (const area of state.areas) {
    const selected = area.id === state.selectedId;
    drawArea(ctx, transform, area.points, {
      stroke: selected ? COLORS.areaActive : COLORS.area,
      fill: selected ? COLORS.areaActiveFill : COLORS.areaFill,
      label: areaText(area.points, state.calibration),
    });
  }

  for (const measurement of state.measurements) {
    const selected = measurement.id === state.selectedId;
    const color = selected ? COLORS.measureActive : COLORS.measure;
    const mm = pxToMm(distance(measurement.a, measurement.b), state.calibration?.pxPerMeter);
    const text = state.calibration ? formatDimension(mm) : 'no scale';
    drawSegment(ctx, transform, measurement.a, measurement.b, color, text, false, 16);
  }

  if (state.calibration) {
    const cal = state.calibration;
    const color = state.selectedId === 'calibration' ? COLORS.measureActive : COLORS.calibration;
    drawSegment(
      ctx,
      transform,
      cal.a,
      cal.b,
      color,
      `${formatLength(cal.value, cal.unit)} · scale`,
      true,
      22,
    );
  }

  if (state.preview) {
    const { a, b } = state.preview;
    const mm = pxToMm(distance(a, b), state.calibration?.pxPerMeter);
    const text = state.calibration ? formatDimension(mm) : 'set scale first';
    drawSegment(ctx, transform, a, b, COLORS.preview, text, true, 16);
  }

  drawAreaDraft(ctx, transform, state.areaDraft || [], state.areaCursor, state.calibration);

  if (typeof state.selectedId === 'number') {
    const selectedMeasurement = state.measurements.find((m) => m.id === state.selectedId);
    if (selectedMeasurement) drawEditHandles(ctx, transform, selectedMeasurement);
  }

  if (state.snap) {
    const p = transform.toScreen(state.snap);
    ctx.save();
    ctx.strokeStyle = COLORS.snap;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.moveTo(p.x - 9, p.y);
    ctx.lineTo(p.x + 9, p.y);
    ctx.moveTo(p.x, p.y - 9);
    ctx.lineTo(p.x, p.y + 9);
    ctx.stroke();
    ctx.restore();
  }

  if (showScaleBar) drawScaleBar(ctx, state, canvasHeight);
  ctx.restore();
}