// "fix": turn a rough, eye-drawn stroke into the clean shape it was meant to be
// (like Apple Pencil's draw-and-hold). Recognizes lines, circles, ellipses,
// triangles and rectangles. Returns null when nothing fits well, so real
// sketches are left alone.

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function pathLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += dist(pts[i - 1], pts[i]);
  return d;
}

/** Evenly spaced points along the path ($1-recognizer style). */
function resample(points, n) {
  const pts = points.map((p) => ({ x: p.x, y: p.y }));
  const step = pathLength(pts) / (n - 1);
  if (!step) return pts.slice(0, 1);
  const out = [{ ...pts[0] }];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i]);
    if (acc + d >= step) {
      const k = (step - acc) / d;
      const q = { x: pts[i - 1].x + k * (pts[i].x - pts[i - 1].x), y: pts[i - 1].y + k * (pts[i].y - pts[i - 1].y) };
      out.push(q);
      pts.splice(i, 0, q);
      acc = 0;
    } else acc += d;
  }
  while (out.length < n) out.push({ ...pts[pts.length - 1] });
  return out.slice(0, n);
}

function segDist(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function polyError(pts, verts) {
  let e = 0;
  for (const p of pts) {
    let m = Infinity;
    for (let i = 0; i < verts.length; i++) m = Math.min(m, segDist(p, verts[i], verts[(i + 1) % verts.length]));
    e += m;
  }
  return e / pts.length;
}

function centroid(pts) {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

/** PCA ellipse fit (robust for evenly resampled outlines). */
function fitEllipse(pts, diag) {
  const c = centroid(pts);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const n = pts.length;
  const rot = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const cos = Math.cos(-rot);
  const sin = Math.sin(-rot);
  let vx = 0;
  let vy = 0;
  const local = pts.map((p) => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const q = { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
    vx += q.x * q.x;
    vy += q.y * q.y;
    return q;
  });
  const rx = Math.SQRT2 * Math.sqrt(vx / n);
  const ry = Math.SQRT2 * Math.sqrt(vy / n);
  let err = 0;
  for (const q of local) {
    const rho = Math.hypot(q.x / rx, q.y / ry);
    const r = Math.hypot(q.x, q.y);
    err += r ? Math.abs(r - r / rho) : 0; // radial distance to the ellipse
  }
  err /= n * diag;
  const ratio = rx / ry;
  if (ratio > 0.82 && ratio < 1.22) {
    const r = (rx + ry) / 2;
    let e = 0;
    for (const p of pts) e += Math.abs(dist(p, c) - r);
    return { err: e / (n * diag), shape: { type: 'circle', c, r }, label: 'Circle' };
  }
  return { err, shape: { type: 'ellipse', c, rx, ry, rot }, label: 'Oval' };
}

function hull(points) {
  const pts = [...points].sort((p, q) => p.x - q.x || p.y - q.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Best triangle: the largest triangle that fits on the outline's convex hull (robust to rounded corners). */
function fitTriangle(ring, diag) {
  let h = hull(ring);
  if (h.length > 36) h = h.filter((_, i) => i % Math.ceil(h.length / 36) === 0);
  let best = null;
  let bestArea = 0;
  for (let i = 0; i < h.length; i++) {
    for (let j = i + 1; j < h.length; j++) {
      for (let k = j + 1; k < h.length; k++) {
        const area = Math.abs((h[j].x - h[i].x) * (h[k].y - h[i].y) - (h[k].x - h[i].x) * (h[j].y - h[i].y));
        if (area > bestArea) {
          bestArea = area;
          best = [h[i], h[j], h[k]];
        }
      }
    }
  }
  if (!best) return null;
  return { err: polyError(ring, best) / diag, shape: { type: 'poly', points: best.map((p) => ({ x: p.x, y: p.y })), closed: true }, label: 'Triangle' };
}

/**
 * Best rectangle for the outline: sweep orientations and keep the tightest box.
 * Works even when eye-drawn corners come out rounded.
 */
function fitRect(ring, diag) {
  let best = null;
  for (let deg = 0; deg < 90; deg += 1.5) {
    const th = (deg * Math.PI) / 180;
    const cos = Math.cos(-th);
    const sin = Math.sin(-th);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of ring) {
      const x = p.x * cos - p.y * sin;
      const y = p.x * sin + p.y * cos;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const back = (x, y) => ({ x: x * Math.cos(th) - y * Math.sin(th), y: x * Math.sin(th) + y * Math.cos(th) });
    const pts = [back(minX, minY), back(maxX, minY), back(maxX, maxY), back(minX, maxY)];
    const err = polyError(ring, pts) / diag;
    if (!best || err < best.err) best = { err, pts, w: maxX - minX, h: maxY - minY, deg };
  }
  // Nearly axis-aligned? Make it exactly axis-aligned, like a ruler would.
  if (best.deg < 8 || best.deg > 82) {
    const xs = best.pts.map((p) => p.x);
    const ys = best.pts.map((p) => p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    best.pts = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  }
  const square = Math.min(best.w, best.h) / Math.max(best.w, best.h) > 0.88;
  return { err: best.err, shape: { type: 'poly', points: best.pts, closed: true }, label: square ? 'Square' : 'Rectangle' };
}

export function recognize(points) {
  if (!points || points.length < 6) return null;
  const pts = resample(points, 72);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (diag < 40) return null;

  const len = pathLength(pts);
  const a = pts[0];
  const b = pts[pts.length - 1];
  const chord = dist(a, b);

  // Straight line
  if (chord / len > 0.92) {
    const err = pts.reduce((e, p) => e + segDist(p, a, b), 0) / (pts.length * chord);
    if (err < 0.05) return { shape: { type: 'line', a: { ...a }, b: { ...b } }, label: 'Line' };
  }

  // Closed shapes: the end must come back near the start (eyes rarely close it exactly).
  if (chord > Math.max(45, 0.5 * diag)) return null;
  const ring = resample([...points, points[0]], 72).slice(0, -1);

  const candidates = [fitEllipse(ring, diag), fitRect(ring, diag), fitTriangle(ring, diag)].filter(Boolean);
  candidates.sort((x, y) => x.err - y.err);
  const best = candidates[0];
  return best.err < 0.055 ? best : null;
}
