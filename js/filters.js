// Signal filters for a noisy gaze point.

const alpha = (cutoff, dt) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

/**
 * 2D One Euro filter (Casiez et al., CHI 2012).
 * Heavy smoothing while the eyes rest, quick follow when they jump.
 * Both axes share one speed estimate so the cursor never "slides" diagonally.
 */
export class OneEuro2D {
  constructor({ minCutoff = 0.5, beta = 0.001, dCutoff = 0.6, speedFloor = 0 } = {}) {
    this.configure({ minCutoff, beta, dCutoff, speedFloor });
    this.reset();
  }

  /** speedFloor (px/s): velocity below this is treated as sensor noise, not movement. */
  configure({ minCutoff, beta, dCutoff, speedFloor }) {
    if (minCutoff !== undefined) this.minCutoff = minCutoff;
    if (beta !== undefined) this.beta = beta;
    if (dCutoff !== undefined) this.dCutoff = dCutoff;
    if (speedFloor !== undefined) this.speedFloor = speedFloor;
  }

  reset() {
    this.prev = null;
    this.vx = 0;
    this.vy = 0;
    this.tPrev = 0;
  }

  /** Jump the filter to a known-good point (e.g. rewinding past a blink). */
  set(p, t) {
    this.prev = { x: p.x, y: p.y };
    this.vx = 0;
    this.vy = 0;
    if (t !== undefined) this.tPrev = t;
  }

  /** @param p {x,y} in px, @param t seconds */
  filter(p, t) {
    if (!this.prev) {
      this.prev = { x: p.x, y: p.y };
      this.tPrev = t;
      return { x: p.x, y: p.y };
    }
    const dt = Math.min(0.25, Math.max(1e-3, t - this.tPrev));
    // Smooth the signed velocity vector: random jitter cancels out,
    // a real eye jump (saccade) does not.
    const ad = alpha(this.dCutoff, dt);
    this.vx += ad * ((p.x - this.prev.x) / dt - this.vx);
    this.vy += ad * ((p.y - this.prev.y) / dt - this.vy);
    const speed = Math.max(0, Math.hypot(this.vx, this.vy) - this.speedFloor);
    const a = alpha(this.minCutoff + this.beta * speed, dt);
    this.prev = {
      x: this.prev.x + a * (p.x - this.prev.x),
      y: this.prev.y + a * (p.y - this.prev.y),
    };
    this.tPrev = t;
    return { x: this.prev.x, y: this.prev.y };
  }
}

/**
 * "Lazy brush": the pen trails the gaze on an invisible string.
 * Small jitter inside the string length never reaches the canvas.
 */
export class LazyBrush {
  constructor(radius = 24) {
    this.radius = radius;
    this.pos = null;
  }

  reset(p = null) {
    this.pos = p ? { x: p.x, y: p.y } : null;
  }

  update(target) {
    if (!this.pos) {
      this.pos = { x: target.x, y: target.y };
      return true;
    }
    const dx = target.x - this.pos.x;
    const dy = target.y - this.pos.y;
    const d = Math.hypot(dx, dy);
    if (d <= this.radius) return false;
    const k = (d - this.radius) / d;
    this.pos.x += dx * k;
    this.pos.y += dy * k;
    return true;
  }
}
