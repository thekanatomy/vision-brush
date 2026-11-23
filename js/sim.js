// ?simulate — a fake face tracker for demos and testing without a camera.
// It "looks" at the calibration dot while calibrating, and at the mouse otherwise,
// producing noisy eye features like a real webcam would.

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
      if (!p) return onFrame({ face: false, t });
      const u = p.x / innerWidth - 0.5;
      const v = p.y / innerHeight - 0.5;
      onFrame({
        face: true,
        t,
        blink: 0,
        quality: '',
        f: {
          t: 0.5 + 0.2 * u + 0.04 * u * u + noise(),
          s: 0.09 * v + 0.02 * u * v + noise(),
          ap: 0.3 - 0.05 * v + noise() / 2,
          bh: 0.6 * u + noise() * 4,
          bv: -0.5 * v + noise() * 4,
          yaw: noise() / 2,
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
