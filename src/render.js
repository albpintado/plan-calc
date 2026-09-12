import { distance, formatDimension, formatLength, niceScaleBar, pxToMm } from './measure.js';
import { makeTransform } from './viewport.js';

export const COLORS = {
  background: '#0e1116',
  calibration: '#4da3ff',
  measure: '#ffb020',
  measureActive: '#ff5d55',
  preview: '#7ee787',
  snap: '#ff2d95',
  scaleBar: '#e6edf3',
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