// Per-person mapping from eye features to screen position.
// Ridge regression on standardized features; the penalty is chosen by
// leave-one-dot-out cross-validation so the model generalizes to the
// parts of the screen between calibration dots.

// Normalized screen positions (x, y). Order snakes around the screen
// so the eyes never make a huge jump between dots.
export const CAL_POINTS = [
  [0.5, 0.5],
  [0.08, 0.1], [0.5, 0.1], [0.92, 0.1],
  [0.92, 0.5], [0.71, 0.3], [0.29, 0.3],
  [0.08, 0.5], [0.29, 0.7], [0.71, 0.7],
  [0.92, 0.9], [0.5, 0.9], [0.08, 0.9],
];

// Held-out points used to measure accuracy before the final refit.
export const VAL_POINTS = [
  [0.25, 0.5], [0.5, 0.27], [0.75, 0.5], [0.5, 0.73],
];

export function median(values) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Solve A x = b with partial pivoting. A is n×n (array of arrays). */
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (p !== c) [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / piv;
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / (M[r][r] || 1e-12);
  }
  return x;
}

function ridge(Z, yx, yy, idx, lam) {
  const p = Z[0].length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const bx = new Array(p).fill(0);
  const by = new Array(p).fill(0);
  for (const i of idx) {
    const z = Z[i];
    for (let a = 0; a < p; a++) {
      bx[a] += z[a] * yx[i];
      by[a] += z[a] * yy[i];
      for (let b = a; b < p; b++) A[a][b] += z[a] * z[b];
    }
  }
  for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
  for (let a = 1; a < p; a++) A[a][a] += lam; // never penalize the intercept
  A[0][0] += 1e-9;
  return { x: solve(A, bx), y: solve(A, by) };
}

const dot = (w, z) => {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i] * z[i];
  return s;
};

export class GazeModel {
  /** @param kind 'eyes' (gaze) or 'head' (nose pointer) */
  constructor(kind = 'eyes') {
    this.kind = kind;
    this.cvError = null;
  }

  terms(f) {
    if (this.kind === 'head') {
      return [f.yaw, f.pitch, f.nx, f.ny, f.yaw * f.yaw, f.pitch * f.pitch, f.yaw * f.pitch];
    }
    return [
      f.t, f.s, f.t * f.t, f.s * f.s, f.t * f.s, // iris position inside the eye
      f.ap, f.bh, f.bv,                           // eyelid opening + eye-look blendshapes
      f.yaw, f.pitch, f.nx, f.ny,                 // head rotation + position
    ];
  }

  /** samples: [{ f, x, y, g }] where g is the calibration-dot id */
  fit(samples) {
    const X = samples.map((s) => this.terms(s.f));
    const n = X.length;
    const d = X[0].length;
    const mean = new Array(d).fill(0);
    const std = new Array(d).fill(0);
    for (const r of X) for (let j = 0; j < d; j++) mean[j] += r[j] / n;
    for (const r of X) for (let j = 0; j < d; j++) std[j] += (r[j] - mean[j]) ** 2 / n;
    for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) > 1e-9 ? Math.sqrt(std[j]) : 1;

    const Z = X.map((r) => [1, ...r.map((v, j) => (v - mean[j]) / std[j])]);
    const yx = samples.map((s) => s.x);
    const yy = samples.map((s) => s.y);

    const groups = [...new Set(samples.map((s) => s.g))];
    const candidates = [1e-4, 1e-3, 3e-3, 1e-2, 3e-2, 0.1, 0.3, 1];
    let best = 1e-2;
    let bestErr = Infinity;
    if (groups.length >= 5) {
      for (const c of candidates) {
        let err = 0;
        for (const g of groups) {
          const train = [];
          const test = [];
          samples.forEach((s, i) => (s.g === g ? test : train).push(i));
          const w = ridge(Z, yx, yy, train, c * train.length);
          const mx = median(test.map((i) => dot(w.x, Z[i])));
          const my = median(test.map((i) => dot(w.y, Z[i])));
          err += Math.hypot(mx - yx[test[0]], my - yy[test[0]]);
        }
        err /= groups.length;
        if (err < bestErr) {
          bestErr = err;
          best = c;
        }
      }
    }
    const all = samples.map((_, i) => i);
    const w = ridge(Z, yx, yy, all, best * n);
    Object.assign(this, { wx: w.x, wy: w.y, mean, std, lambda: best, cvError: bestErr });
    return this;
  }

  predict(f) {
    const r = this.terms(f);
    let x = this.wx[0];
    let y = this.wy[0];
    for (let j = 0; j < r.length; j++) {
      const z = (r[j] - this.mean[j]) / this.std[j];
      x += this.wx[j + 1] * z;
      y += this.wy[j + 1] * z;
    }
    return { x, y };
  }
}

/** Drop frames where the eyes were still moving or the tracker glitched. */
export function cleanSamples(list, model) {
  if (list.length < 6) return list;
  const T = list.map((f) => model.terms(f));
  const keep = new Array(list.length).fill(true);
  for (const j of [0, 1]) {
    const v = T.map((r) => r[j]);
    const m = median(v);
    const mad = median(v.map((x) => Math.abs(x - m))) * 1.4826 + 1e-9;
    v.forEach((x, i) => {
      if (Math.abs(x - m) / mad > 3.5) keep[i] = false;
    });
  }
  const out = list.filter((_, i) => keep[i]);
  return out.length >= 5 ? out : list;
}
