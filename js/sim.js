// ?simulate — a fake face tracker for demos and testing without a camera.
// It "looks" at the calibration dot while calibrating, and at the mouse otherwise,
// producing noisy eye features like a real webcam would.
// Tests can inject eye events: window.__vbSim = { blink: 0..1, droop: px-ish } .

// Rough stand-in face mesh (normalized video coords) for previewing the face effect.
function fakeMesh() {
  const L = [];
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 478; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd());
    L.push({ x: 0.5 + 0.12 * r * Math.cos(a), y: 0.5 + 0.19 * r * Math.sin(a), z: 0 });
  }
  const ring = (idx, cx, cy, rx, ry) =>
    idx.forEach((i, k) => {
      const a = (k / idx.length) * Math.PI * 2;
      L[i] = { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), z: 0 };
    });
  ring([10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109].reverse(), 0.5, 0.5, 0.13, 0.2);
  ring([33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246], 0.455, 0.44, 0.03, 0.012);
  ring([263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466], 0.545, 0.44, 0.03, 0.012);
  const iris = (c, cx) => {
    L[c] = { x: cx, y: 0.44, z: 0 };
    for (let k = 1; k <= 4; k++) L[c + k] = { x: cx + 0.011 * Math.cos(k * 1.57), y: 0.44 + 0.011 * Math.sin(k * 1.57), z: 0 };
  };
  iris(468, 0.455);
  iris(473, 0.545);
  return L;
}

export class SimTracker {
  constructor(getTarget) {
    this.getTarget = getTarget;
    this.simulated = true;
  }

  async startCamera() {}

  async load() {}

  start(onFrame) {
    const noise = () => (Math.random() + Math.random() + Math.random() - 1.5) * 0.02;
    this.timer = setInterval(() => {
      const p = this.getTarget();
      const t = performance.now();
      const inj = window.__vbSim || {};
      if (!p || inj.noFace) return onFrame({ face: false, t });
      const u = p.x / innerWidth - 0.5;
      const v = p.y / innerHeight - 0.5 + (inj.droop || 0); // eyelid pulling the iris down
      onFrame({
        face: true,
        t,
        blink: inj.blink || 0,
        quality: '',
        lm: inj.mesh ? (this.mesh ||= fakeMesh()) : undefined,
        f: {
          t: 0.5 + 0.2 * u + 0.04 * u * u + noise(),
          s: 0.09 * v + 0.02 * u * v + noise(),
          ap: 0.3 - 0.05 * v + noise() / 2,
          bh: 0.6 * u + noise() * 4,
          bv: -0.5 * v + noise() * 4,
          yaw: noise() / 2 + (inj.yaw || 0),
          pitch: noise() / 2,
          nx: 0.5,
          ny: 0.45,
        },
      });
    }, 33);
  }

  stop() {
    clearInterval(this.timer);
  }
}
