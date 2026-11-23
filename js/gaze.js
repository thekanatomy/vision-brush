// Webcam face tracking with MediaPipe Face Landmarker (runs fully on-device).
// Produces a compact feature vector per video frame for the calibration model.

const VERSION = '1.2.3';
const BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/vision_bundle.mjs`;
const WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm`;
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

export class FaceTracker {
  constructor(video) {
    this.video = video;
    this.lastTs = 0;
    this.lastVideoTime = -1;
    this.running = false;
  }

  async load() {
    const { FaceLandmarker, FilesetResolver } = await import(BUNDLE);
    const fileset = await FilesetResolver.forVisionTasks(WASM);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options('GPU'));
    } catch (err) {
      console.warn('[VisionBrush] GPU delegate unavailable, falling back to CPU.', err);
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options('CPU'));
    }
  }

  async startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      const e = new Error('Camera API not available');
      e.name = 'NotSupportedError';
      throw e;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
    });
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    if (!this.video.videoWidth) {
      await new Promise((r) => this.video.addEventListener('loadedmetadata', r, { once: true }));
    }
  }

  start(onFrame) {
    this.onFrame = onFrame;
    this.running = true;
    const v = this.video;
    const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
    const step = () => {
      if (!this.running) return;
      this.process(hasRVFC);
      if (hasRVFC) v.requestVideoFrameCallback(step);
      else requestAnimationFrame(step);
    };
    if (hasRVFC) v.requestVideoFrameCallback(step);
    else requestAnimationFrame(step);
  }

  stop() {
    this.running = false;
  }

  process(hasRVFC) {
    const v = this.video;
    if (!this.landmarker || v.readyState < 2 || !v.videoWidth) return;
    if (!hasRVFC) {
      if (v.currentTime === this.lastVideoTime) return;
      this.lastVideoTime = v.currentTime;
    }
    let ts = performance.now();
    if (ts <= this.lastTs) ts = this.lastTs + 0.01; // timestamps must strictly increase
    this.lastTs = ts;
    let res;
    try {
      res = this.landmarker.detectForVideo(v, ts);
    } catch (err) {
      console.warn('[VisionBrush] detect failed', err);
      return;
    }
    this.onFrame(this.extract(res, ts));
  }

  extract(res, t) {
    const L = res.faceLandmarks?.[0];
    if (!L || L.length < 478) return { face: false, t };
    const W = this.video.videoWidth;
    const H = this.video.videoHeight;
    const P = (i) => ({ x: L[i].x * W, y: L[i].y * H });
    const avg = (a, b) => {
      let x = 0;
      let y = 0;
      for (let i = a; i <= b; i++) {
        x += L[i].x;
        y += L[i].y;
      }
      const n = b - a + 1;
      return { x: (x / n) * W, y: (y / n) * H };
    };
    const irises = [avg(468, 472), avg(473, 477)];

    // Iris position inside one eye, relative to that eye's corners (roll-invariant).
    const eye = (ia, ib, iu, il) => {
      const A = P(ia);
      const B = P(ib);
      const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
      const I = d2(irises[0], mid) < d2(irises[1], mid) ? irises[0] : irises[1];
      const ex = B.x - A.x;
      const ey = B.y - A.y;
      const w2 = ex * ex + ey * ey || 1;
      const w = Math.sqrt(w2);
      const t = ((I.x - A.x) * ex + (I.y - A.y) * ey) / w2;
      const s = (ex * (I.y - mid.y) - ey * (I.x - mid.x)) / w2;
      const U = P(iu);
      const D = P(il);
      return { t, s, ap: Math.hypot(U.x - D.x, U.y - D.y) / w };
    };
    const r = eye(33, 133, 159, 145);
    const l = eye(362, 263, 386, 374);

    const bs = {};
    for (const c of res.faceBlendshapes?.[0]?.categories || []) bs[c.categoryName] = c.score;
    const g = (k) => bs[k] || 0;
    const bh = (g('eyeLookOutLeft') - g('eyeLookInLeft') - (g('eyeLookOutRight') - g('eyeLookInRight'))) / 2;
    const bv = (g('eyeLookUpLeft') + g('eyeLookUpRight') - (g('eyeLookDownLeft') + g('eyeLookDownRight'))) / 2;

    let yaw;
    let pitch;
    const m = res.facialTransformationMatrixes?.[0]?.data;
    if (m && m.length >= 16) {
      yaw = m[8];
      pitch = m[9];
    } else {
      const lc = P(234);
      const rc = P(454);
      const nose = P(1);
      const top = P(10);
      const chin = P(152);
      yaw = (nose.x - (lc.x + rc.x) / 2) / (Math.hypot(rc.x - lc.x, rc.y - lc.y) || 1);
      pitch = (nose.y - (top.y + chin.y) / 2) / (Math.hypot(chin.x - top.x, chin.y - top.y) || 1);
    }

    const nx = L[1].x;
    const ny = L[1].y;
    const scale = Math.hypot(P(33).x - P(263).x, P(33).y - P(263).y) / W;
    let quality = '';
    if (scale < 0.075) quality = 'Move a little closer';
    else if (scale > 0.33) quality = 'Move back a little';
    else if (nx < 0.25 || nx > 0.75 || ny < 0.18 || ny > 0.82) quality = 'Move toward the middle';
    else if (Math.abs(yaw) > 0.4) quality = 'Face the screen';

    return {
      face: true,
      t,
      f: {
        t: (r.t + l.t) / 2,
        s: (r.s + l.s) / 2,
        ap: (r.ap + l.ap) / 2,
        bh,
        bv,
        yaw,
        pitch,
        nx,
        ny,
      },
      blink: Math.min(g('eyeBlinkLeft'), g('eyeBlinkRight')),
      quality,
      lm: L, // for the on-face tracking effect
    };
  }
}
