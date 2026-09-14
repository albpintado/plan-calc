// Deterministic wall extraction from a raster floor plan.
//
// The pipeline is fixed and allocation-light, so the same image always yields
// the same segments (no randomness anywhere):
//
//   grayscale -> Otsu + local-mean binarize -> keep the structural components
//   -> distance transform -> thinning (Zhang-Suen) -> trace paths
//   -> simplify (Douglas-Peucker) -> snap to axis -> merge -> measure thickness
//
// It targets plans whose walls are drawn as solid dark strokes on a light
// sheet (the common "poché" style). It is a best-effort vectorizer, not an
// oracle: the caller is expected to let the user review the result.

const SQRT2 = Math.SQRT2;
const INF = 1e9;

const NEIGHBORS = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

// ---------------------------------------------------------------------------
// Pixel stages
// ---------------------------------------------------------------------------

export function toGray({ width, height, data }) {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const a = data[p + 3];
    let v = 0.299 * r + 0.587 * g + 0.114 * b;
    if (a < 255) v = (v * a + 255 * (255 - a)) / 255;
    out[i] = v;
  }
  return out;
}

export function otsuThreshold(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i += 1) hist[gray[i]] += 1;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t += 1) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

// Adaptive local-mean threshold, capped by a global Otsu level. The cap is what
// keeps flat mid-gray fills (room shading, terrace floors) out of the mask
// while still forgiving uneven lighting in photos/scans.
export function binarize(gray, width, height, { window = 0, c = 12, cap = null } = {}) {
  const limit = cap ?? Math.min(255, otsuThreshold(gray) + 40);
  const win = window > 0 ? window | 1 : Math.max(15, (Math.round(Math.min(width, height) / 24) | 1));
  const r = win >> 1;
  const stride = width + 1;
  const integral = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    const src = y * width;
    const prev = y * stride;
    const cur = (y + 1) * stride;
    for (let x = 0; x < width; x += 1) {
      rowSum += gray[src + x];
      integral[cur + x + 1] = integral[prev + x + 1] + rowSum;
    }
  }
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const y0 = y - r < 0 ? 0 : y - r;
    const y1 = y + r >= height ? height - 1 : y + r;
    for (let x = 0; x < width; x += 1) {
      const v = gray[y * width + x];
      if (v >= limit) continue;
      const x0 = x - r < 0 ? 0 : x - r;
      const x1 = x + r >= width ? width - 1 : x + r;
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        integral[(y1 + 1) * stride + (x1 + 1)] -
        integral[y0 * stride + (x1 + 1)] -
        integral[(y1 + 1) * stride + x0] +
        integral[y0 * stride + x0];
      if (v < sum / area - c) mask[y * width + x] = 1;
    }
  }
  return mask;
}

// Keep the connected ink components that are plausibly structural: the wall
// network is the big one; text, furniture and logos are small islands.
export function keepStructuralComponents(mask, width, height, { ratio = 0.2, minArea = 150 } = {}) {
  const labels = new Int32Array(width * height).fill(-1);
  const sizes = [];
  const stack = new Int32Array(width * height);
  let nextLabel = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start] !== -1) continue;
    const label = nextLabel;
    let top = 0;
    stack[top] = start;
    top += 1;
    labels[start] = label;
    let size = 0;
    while (top > 0) {
      top -= 1;
      const idx = stack[top];
      size += 1;
      const x = idx % width;
      const y = (idx / width) | 0;
      for (let k = 0; k < 8; k += 1) {
        const nx = x + NEIGHBORS[k][0];
        const ny = y + NEIGHBORS[k][1];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (mask[nIdx] && labels[nIdx] === -1) {
          labels[nIdx] = label;
          stack[top] = nIdx;
          top += 1;
        }
      }
    }
    sizes.push(size);
    nextLabel += 1;
  }

  let largest = 0;
  for (const size of sizes) if (size > largest) largest = size;
  const floor = Math.max(minArea, largest * ratio);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] && sizes[labels[i]] >= floor) out[i] = 1;
  }
  return { mask: out, components: sizes.length, kept: sizes.filter((s) => s >= floor).length };
}

export function distanceTransform(mask, width, height) {
  const d = new Float32Array(width * height);
  for (let i = 0; i < mask.length; i += 1) d[i] = mask[i] ? INF : 0;
  const w = width;
  for (let y = 0; y < height; y += 1) {
    const row = y * w;
    const up = row - w;
    for (let x = 0; x < w; x += 1) {
      const i = row + x;
      if (d[i] === 0) continue;
      let best = d[i];
      if (x > 0) best = Math.min(best, d[i - 1] + 1);
      if (y > 0) {
        if (x > 0) best = Math.min(best, d[up + x - 1] + SQRT2);
        best = Math.min(best, d[up + x] + 1);
        if (x < w - 1) best = Math.min(best, d[up + x + 1] + SQRT2);
      }
      d[i] = best;
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    const row = y * w;
    const down = row + w;
    for (let x = w - 1; x >= 0; x -= 1) {
      const i = row + x;
      if (d[i] === 0) continue;
      let best = d[i];
      if (x < w - 1) best = Math.min(best, d[i + 1] + 1);
      if (y < height - 1) {
        if (x < w - 1) best = Math.min(best, d[down + x + 1] + SQRT2);
        best = Math.min(best, d[down + x] + 1);
        if (x > 0) best = Math.min(best, d[down + x - 1] + SQRT2);
      }
      d[i] = best;
    }
  }
  return d;
}

// Zhang-Suen thinning.
export function skeletonize(mask, width, height) {
  const img = mask.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step += 1) {
      const remove = [];
      for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
          const i = y * width + x;
          if (!img[i]) continue;
          const p2 = img[i - width];
          const p3 = img[i - width + 1];
          const p4 = img[i + 1];
          const p5 = img[i + width + 1];
          const p6 = img[i + width];
          const p7 = img[i + width - 1];
          const p8 = img[i - 1];
          const p9 = img[i - width - 1];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let a = 0;
          for (let k = 0; k < 8; k += 1) if (seq[k] === 0 && seq[k + 1] === 1) a += 1;
          if (a !== 1) continue;
          if (step === 0) {
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }
          remove.push(i);
        }
      }
      if (remove.length) {
        changed = true;
        for (const i of remove) img[i] = 0;
      }
    }
  }
  return img;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function perpendicularDistance(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  return Math.abs(dy * point.x - dx * point.y + b.x * a.y - b.y * a.x) / length;
}

export function simplifyPath(points, tolerance) {
  if (points.length < 3) return points.map((p) => ({ ...p }));
  const a = points[0];
  const b = points[points.length - 1];
  let maxDistance = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = perpendicularDistance(points[i], a, b);
    if (d > maxDistance) {
      maxDistance = d;
      index = i;
    }
  }
  if (maxDistance <= tolerance) return [{ ...a }, { ...b }];
  const left = simplifyPath(points.slice(0, index + 1), tolerance);
  const right = simplifyPath(points.slice(index), tolerance);
  return left.slice(0, -1).concat(right);
}

function snapSegment(a, b, toleranceDeg) {
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const deg = (angle * 180) / Math.PI;
  const candidates = [0, 45, 90, 135, 180, -180, -135, -90, -45];
  let target = null;
  let best = toleranceDeg;
  for (const candidate of candidates) {
    const delta = Math.abs(deg - candidate);
    if (delta < best) {
      best = delta;
      target = candidate;
    }
  }
  if (target === null) return { a: { ...a }, b: { ...b } };
  const rad = (target * Math.PI) / 180;
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const halfLength = Math.hypot(b.x - a.x, b.y - a.y) / 2;
  const ox = Math.cos(rad) * halfLength;
  const oy = Math.sin(rad) * halfLength;
  return {
    a: { x: midX - ox, y: midY - oy },
    b: { x: midX + ox, y: midY + oy },
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sampleThickness(dt, width, height, a, b) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(2, Math.round(length / 3));
  const values = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = Math.round(a.x + (b.x - a.x) * t);
    const y = Math.round(a.y + (b.y - a.y) * t);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    values.push(dt[y * width + x]);
  }
  return median(values) * 2;
}

// ---------------------------------------------------------------------------
// Trace the thinned mask into polylines
// ---------------------------------------------------------------------------

// Remove short dead-end branches (whiskers) left by thinning. Real wall ends
// (at a door/window opening) are usually longer than a few pixels, so a small
// threshold keeps them while dropping staircase noise.
export function pruneSkeleton(skel, width, height, minBranch = 5) {
  const size = width * height;
  const work = skel.slice();
  const degree = new Uint8Array(size);
  const scratch = new Int8Array(8);
  const computeDegree = () => {
    for (let i = 0; i < size; i += 1) {
      degree[i] = work[i] ? fillDirs(work, width, height, i % width, (i / width) | 0, scratch) : 0;
    }
  };
  computeDegree();
  let changed = true;
  while (changed) {
    changed = false;
    const toRemove = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) {
      if (!work[i] || degree[i] !== 1) continue;
      const chain = [i];
      let prev = -1;
      let cur = i;
      for (;;) {
        const x = cur % width;
        const y = (cur / width) | 0;
        const count = fillDirs(work, width, height, x, y, scratch);
        let nextIdx = -1;
        for (let k = 0; k < count; k += 1) {
          const d = scratch[k];
          const ni = (y + NEIGHBORS[d][1]) * width + (x + NEIGHBORS[d][0]);
          if (ni !== prev) {
            nextIdx = ni;
            break;
          }
        }
        if (nextIdx === -1) break;
        if (degree[nextIdx] !== 2) break;
        chain.push(nextIdx);
        if (chain.length >= minBranch) break;
        prev = cur;
        cur = nextIdx;
      }
      if (chain.length < minBranch) for (const p of chain) toRemove[p] = 1;
    }
    for (let i = 0; i < size; i += 1) {
      if (toRemove[i]) {
        work[i] = 0;
        changed = true;
      }
    }
    if (changed) computeDegree();
  }
  return work;
}

function fillDirs(skel, width, height, x, y, out) {
  let count = 0;
  for (let k = 0; k < 8; k += 1) {
    const nx = x + NEIGHBORS[k][0];
    const ny = y + NEIGHBORS[k][1];
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    if (skel[ny * width + nx]) {
      out[count] = k;
      count += 1;
    }
  }
  return count;
}

export function traceSkeleton(skel, width, height) {
  const size = width * height;
  const degree = new Uint8Array(size);
  const scratch = new Int8Array(8);
  for (let i = 0; i < size; i += 1) {
    if (!skel[i]) continue;
    degree[i] = fillDirs(skel, width, height, i % width, (i / width) | 0, scratch);
  }

  const edgeVisited = new Uint8Array(size * 8);

  // Walk a chain. At every step we move to a neighbour other than the one we
  // came from, so the walk is strictly monotonic along the chain and always
  // terminates (at a node, a dead end, or when it closes a loop).
  function walk(startIdx, firstDir) {
    const x0 = startIdx % width;
    const y0 = (startIdx / width) | 0;
    const path = [{ x: x0, y: y0 }];
    let prev = startIdx;
    let dir = firstDir;
    for (let guard = 0; guard <= size; guard += 1) {
      const px = prev % width;
      const py = (prev / width) | 0;
      const nx = px + NEIGHBORS[dir][0];
      const ny = py + NEIGHBORS[dir][1];
      const cur = ny * width + nx;
      if (edgeVisited[prev * 8 + dir]) break;
      edgeVisited[prev * 8 + dir] = 1;
      edgeVisited[cur * 8 + ((dir + 4) % 8)] = 1;
      path.push({ x: nx, y: ny });
      if (degree[cur] !== 2) break;
      const count = fillDirs(skel, width, height, nx, ny, scratch);
      let nextDir = -1;
      for (let k = 0; k < count; k += 1) {
        const candidate = scratch[k];
        const ax = nx + NEIGHBORS[candidate][0];
        const ay = ny + NEIGHBORS[candidate][1];
        if (ay * width + ax !== prev) {
          nextDir = candidate;
          break;
        }
      }
      if (nextDir === -1) break;
      prev = cur;
      dir = nextDir;
    }
    return path;
  }

  const paths = [];
  // Chains that start or end at a node (endpoint or junction).
  for (let i = 0; i < size; i += 1) {
    if (!skel[i] || degree[i] === 2 || degree[i] === 0) continue;
    const x = i % width;
    const y = (i / width) | 0;
    const count = fillDirs(skel, width, height, x, y, scratch);
    for (let k = 0; k < count; k += 1) {
      if (!edgeVisited[i * 8 + scratch[k]]) paths.push(walk(i, scratch[k]));
    }
  }
  // Pure closed loops (no node anywhere on them).
  for (let i = 0; i < size; i += 1) {
    if (!skel[i] || degree[i] !== 2) continue;
    const x = i % width;
    const y = (i / width) | 0;
    const count = fillDirs(skel, width, height, x, y, scratch);
    let dir = -1;
    for (let k = 0; k < count; k += 1) {
      if (!edgeVisited[i * 8 + scratch[k]]) {
        dir = scratch[k];
        break;
      }
    }
    if (dir === -1) continue;
    const path = walk(i, dir);
    if (path.length > 3) paths.push(path);
  }

  return paths;
}

// ---------------------------------------------------------------------------
// Merge collinear passes and build the final segment list
// ---------------------------------------------------------------------------

function clusterKey(point, cell) {
  return `${Math.round(point.x / cell)}:${Math.round(point.y / cell)}`;
}

function segmentAngleDiff(a1, a2) {
  let diff = Math.abs(a1 - a2) % Math.PI;
  if (diff > Math.PI / 2) diff = Math.PI - diff;
  return diff;
}

export function mergeCollinear(segments, { nodeCell = 3, angleTolerance = 0.12 } = {}) {
  const keyToId = new Map();
  const nodes = [];
  const nodeId = (point) => {
    const key = clusterKey(point, nodeCell);
    if (keyToId.has(key)) return keyToId.get(key);
    const id = nodes.length;
    nodes.push({ id, x: point.x, y: point.y });
    keyToId.set(key, id);
    return id;
  };

  let edges = [];
  const seen = new Set();
  for (const segment of segments) {
    const na = nodeId(segment.a);
    const nb = nodeId(segment.b);
    if (na === nb) continue;
    const key = na < nb ? `${na}-${nb}` : `${nb}-${na}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const a = nodes[na];
    const b = nodes[nb];
    edges.push({ na, nb, angle: Math.atan2(b.y - a.y, b.x - a.x), thickness: segment.thickness });
  }

  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < edges.length && !merged; i += 1) {
      const e1 = edges[i];
      for (let j = i + 1; j < edges.length; j += 1) {
        const e2 = edges[j];
        const shared =
          e1.na === e2.na || e1.na === e2.nb || e1.nb === e2.na || e1.nb === e2.nb;
        if (!shared) continue;
        if (segmentAngleDiff(e1.angle, e2.angle) > angleTolerance) continue;
        const sharedNode = [e1.na, e1.nb].find((n) => n === e2.na || n === e2.nb);
        const far1 = e1.na === sharedNode ? e1.nb : e1.na;
        const far2 = e2.na === sharedNode ? e2.nb : e2.na;
        if (far1 === far2) continue;
        const a = nodes[far1];
        const b = nodes[far2];
        const newAngle = Math.atan2(b.y - a.y, b.x - a.x);
        if (segmentAngleDiff(newAngle, e1.angle) > angleTolerance) continue;
        const thickness = (e1.thickness + e2.thickness) / 2;
        edges = edges.filter((e, k) => k !== i && k !== j);
        edges.push({ na: far1, nb: far2, angle: newAngle, thickness });
        merged = true;
        break;
      }
    }
  }

  return edges.map((edge) => ({
    a: { x: nodes[edge.na].x, y: nodes[edge.na].y },
    b: { x: nodes[edge.nb].x, y: nodes[edge.nb].y },
    thickness: edge.thickness,
  }));
}

// Bridge collinear segments separated by a small gap (thinning often breaks a
// straight wall into pieces around junctions or window jambs). A junction
// endpoint anywhere in the gap blocks the bridge, so real openings survive.
export function bridgeCollinear(segments, { gap = 8, offset = 4, angle = 0.1 } = {}) {
  let list = segments.map((s) => ({ ...s, a: { ...s.a }, b: { ...s.b } }));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const s = list[i];
        const t = list[j];
        const dx = s.b.x - s.a.x;
        const dy = s.b.y - s.a.y;
        const length = Math.hypot(dx, dy) || 1;
        const ux = dx / length;
        const uy = dy / length;
        const sAngle = Math.atan2(dy, dx);
        if (segmentAngleDiff(sAngle, Math.atan2(t.b.y - t.a.y, t.b.x - t.a.x)) > angle) continue;
        const perpendicular = (p) => Math.abs(-uy * (p.x - s.a.x) + ux * (p.y - s.a.y));
        if (perpendicular(t.a) > offset || perpendicular(t.b) > offset) continue;
        const project = (p) => ux * (p.x - s.a.x) + uy * (p.y - s.a.y);
        const i0 = Math.min(project(s.a), project(s.b));
        const i1 = Math.max(project(s.a), project(s.b));
        const j0 = Math.min(project(t.a), project(t.b));
        const j1 = Math.max(project(t.a), project(t.b));
        const separation = j0 > i1 ? j0 - i1 : i0 > j1 ? i0 - j1 : 0;
        if (separation > gap) continue;
        const lo = Math.min(i0, j0);
        const hi = Math.max(i1, j1);
        let blocked = false;
        for (let k = 0; k < list.length && !blocked; k += 1) {
          if (k === i || k === j) continue;
          for (const p of [list[k].a, list[k].b]) {
            const q = project(p);
            if (q > lo + 1 && q < hi - 1 && perpendicular(p) <= offset + Math.max(s.thickness, t.thickness) * 0.5) {
              blocked = true;
              break;
            }
          }
        }
        if (blocked) continue;
        const thickness =
          (s.thickness * (i1 - i0) + t.thickness * (j1 - j0)) / ((i1 - i0) + (j1 - j0) || 1);
        list = list.filter((_, k) => k !== i && k !== j);
        list.push({
          a: { x: s.a.x + ux * lo, y: s.a.y + uy * lo },
          b: { x: s.a.x + ux * hi, y: s.a.y + uy * hi },
          thickness,
        });
        changed = true;
        break outer;
      }
    }
  }
  return list;
}

// Columns are compact regions noticeably thicker than the surrounding wall:
// opening the mask with a disk larger than the wall half-width leaves only
// their cores. The wall half-width is estimated from the upper tail of the
// distance transform along the skeleton (thin lines are the noise floor).
export function detectColumns(dt, mask, skeleton, width, height, { maxSide = 140 } = {}) {
  const samples = [];
  for (let i = 0; i < skeleton.length; i += 1) if (skeleton[i]) samples.push(dt[i]);
  samples.sort((a, b) => a - b);
  const wallHalf = samples.length ? samples[Math.floor(samples.length * 0.9)] : 0;
  const radius = Math.round(wallHalf) + 1;
  if (radius < 3) return [];

  const core = new Uint8Array(width * height);
  for (let i = 0; i < core.length; i += 1) if (mask[i] && dt[i] > radius) core[i] = 1;

  const labels = new Int32Array(width * height).fill(-1);
  const stack = new Int32Array(width * height);
  const columns = [];
  for (let start = 0; start < core.length; start += 1) {
    if (!core[start] || labels[start] !== -1) continue;
    const label = start;
    let top = 0;
    stack[top] = start;
    top += 1;
    labels[start] = label;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let sumX = 0;
    let sumY = 0;
    let size = 0;
    let maxDt = 0;
    while (top > 0) {
      top -= 1;
      const idx = stack[top];
      const x = idx % width;
      const y = (idx / width) | 0;
      size += 1;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (dt[idx] > maxDt) maxDt = dt[idx];
      for (let k = 0; k < 4; k += 1) {
        const nx = x + NEIGHBORS[k * 2][0];
        const ny = y + NEIGHBORS[k * 2][1];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (core[nIdx] && labels[nIdx] === -1) {
          labels[nIdx] = label;
          stack[top] = nIdx;
          top += 1;
        }
      }
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const ratio = Math.max(w, h) / Math.max(1, Math.min(w, h));
    const side = Math.round(maxDt * 2);
    if (size < 15 || ratio > 2.8 || Math.min(w, h) < 4 || side > maxSide) continue;
    columns.push({ x: sumX / size, y: sumY / size, w: side, h: side });
  }
  return columns;
}

// ---------------------------------------------------------------------------
// Top level
// ---------------------------------------------------------------------------

export function extractWalls(image, options = {}) {
  const { width, height } = image;
  const {
    thresholdWindow = 0,
    thresholdC = 12,
    componentRatio = 0.2,
    componentMinArea = 150,
    simplifyTolerance = 1.6,
    snapToleranceDeg = 4,
    nodeCell = 3,
    minWallThickness = 4,
    minWallLength = 12,
    minBranch = 5,
    columnMaxSide = 140,
    bridgeGap = 8,
  } = options;

  const gray = options.gray || toGray(image);
  const rawMask = binarize(gray, width, height, { window: thresholdWindow, c: thresholdC });
  const { mask, components, kept } = keepStructuralComponents(rawMask, width, height, {
    ratio: componentRatio,
    minArea: componentMinArea,
  });
  const dt = distanceTransform(mask, width, height);
  const skeleton = pruneSkeleton(skeletonize(mask, width, height), width, height, minBranch);
  const columns = detectColumns(dt, mask, skeleton, width, height, { maxSide: columnMaxSide });
  const paths = traceSkeleton(skeleton, width, height);

  let segments = [];
  for (const path of paths) {
    const simplified = simplifyPath(path, simplifyTolerance).map((p) => ({ x: p.x, y: p.y }));
    for (let i = 0; i < simplified.length - 1; i += 1) {
      const raw = { a: simplified[i], b: simplified[i + 1] };
      const sn = snapSegment(raw.a, raw.b, snapToleranceDeg);
      const length = Math.hypot(sn.b.x - sn.a.x, sn.b.y - sn.a.y);
      if (length < minWallLength) continue;
      const thickness = sampleThickness(dt, width, height, sn.a, sn.b);
      if (thickness < minWallThickness) continue;
      segments.push({ a: sn.a, b: sn.b, thickness });
    }
  }

  const insideColumn = (point) =>
    columns.some(
      (column) =>
        Math.abs(point.x - column.x) <= column.w / 2 && Math.abs(point.y - column.y) <= column.h / 2,
    );
  if (columns.length) {
    segments = segments.filter((segment) => {
      const mid = { x: (segment.a.x + segment.b.x) / 2, y: (segment.a.y + segment.b.y) / 2 };
      return !insideColumn(mid);
    });
  }

  const bridged = bridgeCollinear(segments, { gap: bridgeGap });
  const merged = mergeCollinear(bridged, { nodeCell });
  const final = merged.filter(
    (segment) =>
      Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y) >= minWallLength &&
      segment.thickness >= minWallThickness &&
      !insideColumn({
        x: (segment.a.x + segment.b.x) / 2,
        y: (segment.a.y + segment.b.y) / 2,
      }),
  );

  return {
    segments: final,
    columns,
    stats: {
      width,
      height,
      components,
      keptComponents: kept,
      rawSegments: segments.length,
      segments: final.length,
      columns: columns.length,
    },
  };
}
