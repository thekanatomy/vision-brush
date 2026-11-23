// VisionBrush — draw with your eyes, guide it with your voice.
import { OneEuro2D, LazyBrush } from './filters.js';
import { GazeModel, CAL_POINTS, VAL_POINTS, cleanSamples, median } from './calibration.js';
import { Voice, voiceSupported, HELP_GROUPS } from './voice.js';
import { Drawing, COLORS, SIZES } from './canvas.js';

const $ = (s) => document.querySelector(s);
const ui = {
  body: document.body,
  video: $('#camera'),
  art: $('#art'),
  overlay: $('#overlay'),
  cursor: $('#cursor'),
  ring: $('#cursor .ring circle'),
  calDot: $('#cal-dot'),
  island: $('#island'),
  mic: $('#island .mic'),
  state: $('#island .state'),
  mode: $('#island .mode'),
  swatch: $('#island .swatch'),
  sizeDot: $('#island .size i'),
  caption: $('#caption'),
  toast: $('#toast'),
  card: $('#card'),
  cardTitle: $('#card .card-title'),
  cardBody: $('#card .card-body'),
  cardExtra: $('#card .card-extra'),
  welcome: $('#welcome'),
  tryMouse: $('#try-mouse'),
};

const params = new URLSearchParams(location.search);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const octx = ui.overlay.getContext('2d');
const drawing = new Drawing(ui.art);

const MODE_LABEL = { free: 'Freehand', line: 'Lines', circle: 'Circles' };
const RING_LEN = 2 * Math.PI * 19;
const SNAP_PX = 38;
const DWELL_R = 50;
const DWELL_MS = 1100;
const BLINK = 0.62;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Settings (remembered per browser) ----------
const KEY = 'visionbrush.v1';
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
})();

const S = {
  phase: 'welcome', // welcome → starting → calibrating → ready (or idle when uncalibrated)
  input: saved.input === 'head' ? 'head' : 'eyes',
  pen: false,
  mode: MODE_LABEL[saved.mode] ? saved.mode : 'free',
  color: COLORS[saved.color] ? saved.color : 'black',
  sizeIdx: clamp(saved.sizeIdx ?? 1, 0, SIZES.length - 1),
  steadiness: clamp(saved.steadiness ?? 6, 1, 10),
  dwellPref: saved.dwell, // only set when the person asks for it
  dwell: saved.dwell ?? !voiceSupported,
  showFace: saved.showFace ?? true,
  showCursor: saved.showCursor ?? true,
  sound: saved.sound ?? true,
  model: null,
  bias: { x: 0, y: 0 },
  accuracy: null,
  noise: 80, // px of frame-to-frame jitter; measured during calibration
  gaze: null,
  history: [],
  face: { present: false, lastSeen: 0, blinkStart: 0 },
  lastFrame: null,
  anchor: null,
  chainStart: null,
  card: null, // 'help' | 'confirm' | 'info' | 'blocking'
  dwellState: { c: null, t0: 0, armed: true, progress: 0 },
  collector: null,
  calLabel: '',
  statusText: '',
  micState: 'off',
  pulses: [],
  mouse: null,
  lastMouseMove: 0,
  tracker: null,
  viewport: { w: innerWidth, h: innerHeight },
};

function persist() {
  if (params.has('simulate') || params.has('mouse')) return;
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        input: S.input === 'mouse' ? undefined : S.input,
        mode: S.mode,
        color: S.color,
        sizeIdx: S.sizeIdx,
        steadiness: S.steadiness,
        dwell: S.dwellPref,
        showFace: S.showFace,
        showCursor: S.showCursor,
        sound: S.sound,
      }),
    );
  } catch {
    /* private mode — fine */
  }
}

// ---------- Filters ----------
const euro = new OneEuro2D();
const brush = new LazyBrush();
function applySteadiness() {
  if (S.input === 'mouse') {
    euro.configure({ minCutoff: 3, beta: 0.02, dCutoff: 1.2 });
    brush.radius = 4;
    return;
  }
  const s = S.steadiness;
  euro.configure({
    minCutoff: 1.3 * 0.72 ** (s - 1),
    beta: 0.003 * 0.8 ** (s - 1),
    dCutoff: 0.6,
    speedFloor: clamp(S.noise * 25, 600, 5000), // ignore movement that is just this person's tracking jitter
  });
  brush.radius = Math.max(12 + s * 2, Math.min(40, S.noise * 0.25));
}
applySteadiness();

// ---------- Sound (tiny confirmation blips) ----------
let audio = null;
function blip(freq = 880, ms = 70, gain = 0.05) {
  if (!S.sound) return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(gain, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + ms / 1000);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + ms / 1000 + 0.02);
  } catch {
    /* audio unavailable */
  }
}

// ---------- UI primitives ----------
let cardTimer = 0;
function showCard({ title, body = '', extra = null, kind = 'info', autoHide = 0, wide = false }) {
  clearTimeout(cardTimer);
  S.card = kind;
  ui.cardTitle.textContent = title;
  ui.cardBody.textContent = body;
  ui.cardBody.hidden = !body;
  ui.cardExtra.replaceChildren();
  if (extra) ui.cardExtra.append(extra);
  ui.card.classList.toggle('wide', wide);
  ui.card.dataset.kind = kind;
  ui.card.classList.add('show');
  if (autoHide) cardTimer = setTimeout(hideCard, autoHide);
}

function hideCard() {
  clearTimeout(cardTimer);
  S.card = null;
  ui.card.classList.remove('show');
}

let toastTimer = 0;
function toast(text, { swatch = null, ms = 1500 } = {}) {
  clearTimeout(toastTimer);
  ui.toast.replaceChildren();
  if (swatch) {
    const dot = document.createElement('span');
    dot.className = 'toast-swatch';
    dot.style.background = swatch === 'eraser' ? 'transparent' : COLORS[swatch];
    if (swatch === 'eraser') dot.classList.add('eraser');
    ui.toast.append(dot);
  }
  ui.toast.append(document.createTextNode(text));
  ui.toast.classList.add('show');
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), ms);
}

let captionTimer = 0;
function showCaption(text, final) {
  if (!text) return;
  clearTimeout(captionTimer);
  ui.caption.textContent = `“${text}”`;
  ui.caption.classList.add('show');
  ui.caption.classList.toggle('final', final);
  captionTimer = setTimeout(() => ui.caption.classList.remove('show'), final ? 1800 : 3000);
}

let islandSig = '';
function renderIsland() {
  let state;
  let alert = false;
  const camera = S.input !== 'mouse';
  if (S.phase === 'starting') state = S.statusText || 'Getting ready';
  else if (S.phase === 'calibrating') state = S.calLabel || 'Calibrating';
  else if (S.phase === 'idle') state = S.tracker ? 'Say “calibrate” to begin' : 'Not ready';
  else if (camera && !S.face.present) {
    state = 'Can’t see your face';
    alert = true;
  } else if (S.mode === 'free') state = S.pen ? 'Drawing' : 'Paused · say “draw”';
  else if (S.anchor) state = S.mode === 'circle' ? 'Look at the edge · “here”' : 'Next point · “here” or “done”';
  else state = 'Look, then say “here”';

  const mode = MODE_LABEL[S.mode] + (S.dwell ? ' · Hands-free' : '');
  const sig = [state, mode, S.color, S.sizeIdx, S.micState, S.pen, alert, S.phase].join('|');
  if (sig === islandSig) return;
  islandSig = sig;
  ui.state.textContent = state;
  ui.mode.textContent = mode;
  ui.swatch.style.background = S.color === 'eraser' ? 'transparent' : COLORS[S.color];
  ui.swatch.classList.toggle('eraser', S.color === 'eraser');
  const px = SIZES[S.sizeIdx];
  ui.sizeDot.style.width = ui.sizeDot.style.height = `${clamp(px * 0.55, 4, 16)}px`;
  ui.mic.dataset.state = S.micState;
  ui.island.dataset.pen = String(S.pen && S.mode === 'free' && S.phase === 'ready');
  ui.island.classList.toggle('alert', alert);
  ui.island.classList.toggle('compact', S.phase !== 'ready');
}

function applyFace() {
  const on = S.showFace && S.input !== 'mouse' && !!S.tracker;
  ui.body.classList.toggle('face', on);
}

function moveDot(x, y) {
  S.simTarget = { x, y };
  ui.calDot.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  ui.calDot.classList.remove('shrink', 'collect');
  void ui.calDot.offsetWidth; // restart animation
  ui.calDot.classList.add('shrink');
}

// ---------- Gaze samples ----------
function onFaceFrame(fr) {
  S.lastFrame = fr;
  if (!fr.face) return;
  S.face.present = true;
  S.face.lastSeen = fr.t;
  const blinking = fr.blink > BLINK;
  longBlink(blinking, fr.t);
  if (S.collector && !blinking) S.collector.push(fr.f);
  if (blinking || !S.model || S.phase === 'calibrating' || S.input === 'mouse') return;
  const p = S.model.predict(fr.f);
  onGazeSample({ x: p.x + S.bias.x, y: p.y + S.bias.y }, fr.t);
}

function onGazeSample(raw, t) {
  const W = innerWidth;
  const H = innerHeight;
  const r = { x: clamp(raw.x, -60, W + 60), y: clamp(raw.y, -60, H + 60) };
  const g = euro.filter(r, t / 1000);
  g.x = clamp(g.x, 0, W);
  g.y = clamp(g.y, 0, H);
  S.gaze = g;
  S.history.push({ t, x: g.x, y: g.y });
  while (S.history.length && S.history[0].t < t - 2500) S.history.shift();
  if (S.phase !== 'ready' || S.card === 'help' || S.card === 'confirm') return;
  if (S.mode === 'free' && S.pen) freeDraw(g, t);
  if (S.dwell && S.mode !== 'free') dwellStep(g, t);
}

/** Where the person was looking just before a command was spoken. */
function gazeBefore(t, from = 900, to = 150) {
  const pts = S.history.filter((h) => h.t >= t - from && h.t <= t - to);
  if (pts.length < 3) return S.gaze ? { ...S.gaze } : null;
  return { x: median(pts.map((p) => p.x)), y: median(pts.map((p) => p.y)) };
}

function snap(p) {
  const pts = drawing.snapPoints();
  if (S.chainStart) pts.push(S.chainStart);
  let best = null;
  let bd = SNAP_PX;
  for (const q of pts) {
    const d = dist(p, q);
    if (d < bd && !(S.anchor && q === S.anchor)) {
      bd = d;
      best = q;
    }
  }
  return best ? { x: best.x, y: best.y, snapped: true } : null;
}

// ---------- Drawing ----------
function freeDraw(g, t) {
  brush.update(g);
  const a = drawing.active;
  if (!a) {
    drawing.begin({
      type: 'free',
      color: S.color,
      width: SIZES[S.sizeIdx],
      points: [{ x: brush.pos.x, y: brush.pos.y, t }],
    });
    return;
  }
  const last = a.points[a.points.length - 1];
  if (dist(brush.pos, last) >= 1.5) a.points.push({ x: brush.pos.x, y: brush.pos.y, t });
}

/** End the current freehand stroke, trimming the glance that happened while saying "stop". */
function commitActive(trimMs = 0) {
  const a = drawing.active;
  if (!a) return;
  if (trimMs && a.points.length > 2) {
    const cut = performance.now() - trimMs;
    const first = a.points[0].t;
    if (cut > first + 150) {
      const kept = a.points.filter((p) => p.t <= cut);
      if (kept.length) a.points = kept;
    }
  }
  drawing.commit();
}

function penOn() {
  if (S.mode !== 'free') setMode('free', true);
  S.pen = true;
  brush.reset(S.gaze);
  drawing.active = null;
  blip(988);
}

function penOff(trimMs = 0) {
  if (!S.pen) return;
  S.pen = false;
  commitActive(trimMs);
  brush.reset(null);
  blip(660);
}

function finishShape() {
  S.anchor = null;
  S.chainStart = null;
}

function place(p) {
  if (!p) return;
  const sp = snap(p);
  if (sp) p = sp;
  const style = { color: S.color, width: SIZES[S.sizeIdx] };
  if (S.mode === 'free') {
    drawing.add({ type: 'free', ...style, points: [{ x: p.x, y: p.y }] });
  } else if (S.mode === 'line') {
    if (!S.anchor) {
      S.anchor = { x: p.x, y: p.y };
      S.chainStart = S.anchor;
    } else if (dist(S.anchor, p) < 8) {
      finishShape(); // same spot twice = done
    } else {
      const b = { x: p.x, y: p.y };
      drawing.add({ type: 'line', ...style, a: S.anchor, b });
      if (S.chainStart && dist(b, S.chainStart) < 1) finishShape(); // closed the loop
      else S.anchor = b;
    }
  } else if (S.mode === 'circle') {
    if (!S.anchor) S.anchor = { x: p.x, y: p.y };
    else {
      const r = dist(S.anchor, p);
      if (r > 4) drawing.add({ type: 'circle', ...style, c: S.anchor, r });
      S.anchor = null;
    }
  }
  S.pulses.push({ x: p.x, y: p.y, t: performance.now() });
  blip(1175, 60);
}

function dwellStep(g, t) {
  const d = S.dwellState;
  if (!d.c || dist(g, d.c) > DWELL_R) {
    d.armed = true;
    d.c = { x: g.x, y: g.y };
    d.t0 = t;
    d.progress = 0;
    return;
  }
  if (!d.armed) return;
  d.progress = (t - d.t0) / DWELL_MS;
  if (d.progress >= 1) {
    d.armed = false;
    d.progress = 0;
    place({ ...d.c });
  }
}

function longBlink(blinking, now) {
  if (blinking) {
    if (!S.face.blinkStart) S.face.blinkStart = now;
    return;
  }
  if (!S.face.blinkStart) return;
  const dur = now - S.face.blinkStart;
  S.face.blinkStart = 0;
  if (!S.dwell || S.phase !== 'ready' || dur < 600 || dur > 2500) return;
  if (S.mode === 'free') (S.pen ? penOff : penOn)();
  else finishShape();
}

function setMode(mode, quiet = false) {
  if (S.mode === 'free') penOff();
  S.mode = mode;
  finishShape();
  S.dwellState.c = null;
  if (!quiet) {
    const hint = {
      free: 'Freehand — say “draw”',
      line: 'Lines — look, then say “here”',
      circle: 'Circles — “here” at the centre, then the edge',
    }[mode];
    toast(hint, { ms: 2200 });
  }
}

function undo() {
  if (drawing.active) {
    drawing.active = null;
    S.pen = false;
    brush.reset(null);
    toast('Undo');
    return;
  }
  if (S.anchor) {
    const last = drawing.lastVisible();
    if (S.mode === 'line' && last?.type === 'line' && dist(last.b, S.anchor) < 1) {
      drawing.undo();
      S.anchor = last.a;
    } else finishShape();
    toast('Undo');
    return;
  }
  toast(drawing.undo() ? 'Undo' : 'Nothing to undo');
}

function save(withFace) {
  const c = drawing.exportCanvas(withFace && S.tracker && S.input !== 'mouse' ? ui.video : null);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  c.toBlob((blob) => {
    if (!blob) return toast('Couldn’t save the image');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `visionbrush-${stamp}.png`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(withFace ? 'Photo saved' : 'Drawing saved');
    blip(1320, 90);
  }, 'image/png');
}

function confirmClear() {
  if (drawing.isEmpty && !S.anchor) return toast('Page is already empty');
  const row = document.createElement('div');
  row.className = 'choices';
  const yes = document.createElement('button');
  yes.className = 'pill danger';
  yes.textContent = 'Clear';
  yes.onclick = () => run({ type: 'yes' });
  const no = document.createElement('button');
  no.className = 'pill';
  no.textContent = 'Keep';
  no.onclick = () => run({ type: 'no' });
  row.append(no, yes);
  showCard({
    title: 'Clear the page?',
    body: 'Say “yes” to clear, or “no” to keep your drawing.',
    extra: row,
    kind: 'confirm',
    autoHide: 10000,
  });
}

function openHelp() {
  const grid = document.createElement('div');
  grid.className = 'help';
  for (const [group, items] of HELP_GROUPS) {
    const col = document.createElement('div');
    const h = document.createElement('h3');
    h.textContent = group;
    col.append(h);
    for (const [say, what] of items) {
      const row = document.createElement('p');
      const b = document.createElement('b');
      b.textContent = `“${say}”`;
      const span = document.createElement('span');
      span.textContent = what;
      row.append(b, span);
      col.append(row);
    }
    grid.append(col);
  }
  showCard({
    title: 'Say any of these',
    body: S.dwell
      ? 'Hands-free is on: hold your gaze on a spot to place a point, or close your eyes for a second to start and stop.'
      : '',
    extra: grid,
    kind: 'help',
    wide: true,
    autoHide: 15000,
  });
}

// ---------- Command router (voice, keyboard, or console) ----------
function run(cmd, meta = {}) {
  const t = meta.t ?? performance.now();
  if (S.phase === 'welcome') return;

  if (S.card === 'confirm') {
    if (cmd.type === 'yes') {
      hideCard();
      finishShape();
      if (drawing.clear()) toast('Cleared — say “undo” to bring it back', { ms: 2400 });
    } else if (cmd.type === 'no' || (cmd.type === 'pen' && !cmd.on)) {
      hideCard();
      toast('Kept');
    }
    return;
  }
  if (S.card && S.card !== 'blocking' && cmd.type !== 'help') {
    const wasHelp = S.card === 'help';
    hideCard();
    if (wasHelp && (cmd.type === 'close' || cmd.type === 'no')) return;
  }

  if (S.phase === 'calibrating') {
    if (cmd.type === 'calibrate') calibrate();
    else if (cmd.type === 'no' || (cmd.type === 'pen' && !cmd.on)) cancelCalibration();
    else if (cmd.type === 'help') openHelp();
    return;
  }

  const needsModel = ['pen', 'place', 'recenter'].includes(cmd.type);
  if (needsModel && S.input !== 'mouse' && !S.model) {
    toast('Say “calibrate” first');
    return;
  }

  switch (cmd.type) {
    case 'pen':
      if (cmd.on) penOn();
      else if (S.mode === 'free') penOff(meta.source === 'voice' ? 450 : 0);
      else finishShape();
      break;
    case 'place':
      place(meta.source === 'voice' ? gazeBefore(t) : gazeBefore(t, 250, 0));
      break;
    case 'finish':
      if (S.mode === 'free') penOff(meta.source === 'voice' ? 450 : 0);
      else finishShape();
      break;
    case 'close':
      if (S.mode === 'line' && S.anchor && S.chainStart && dist(S.anchor, S.chainStart) > 8) {
        drawing.add({ type: 'line', color: S.color, width: SIZES[S.sizeIdx], a: S.anchor, b: S.chainStart });
      }
      finishShape();
      break;
    case 'undo':
      undo();
      break;
    case 'redo':
      toast(drawing.redo() ? 'Redo' : 'Nothing to redo');
      break;
    case 'clear':
      if (S.pen) penOff();
      confirmClear();
      break;
    case 'save':
      save(false);
      break;
    case 'photo':
      save(true);
      break;
    case 'mode':
      setMode(cmd.mode);
      break;
    case 'color':
      S.color = cmd.color;
      if (drawing.active) {
        commitActive();
        brush.reset(S.gaze);
      }
      toast(cmd.color === 'eraser' ? 'Eraser' : cmd.color[0].toUpperCase() + cmd.color.slice(1), { swatch: cmd.color });
      break;
    case 'size':
      S.sizeIdx = clamp(S.sizeIdx + cmd.delta, 0, SIZES.length - 1);
      if (drawing.active) {
        commitActive();
        brush.reset(S.gaze);
      }
      toast(`Size ${S.sizeIdx + 1} of ${SIZES.length}`);
      break;
    case 'calibrate':
      calibrate();
      break;
    case 'recenter':
      recenter();
      break;
    case 'steady':
      S.steadiness = clamp(S.steadiness + cmd.delta, 1, 10);
      applySteadiness();
      toast(`Steadiness ${S.steadiness} of 10`);
      break;
    case 'help':
      if (S.card === 'help') hideCard();
      else openHelp();
      break;
    case 'face':
      S.showFace = cmd.on;
      applyFace();
      toast(cmd.on ? 'Face shown' : 'Plain paper');
      break;
    case 'cursor':
      S.showCursor = cmd.on;
      toast(cmd.on ? 'Cursor shown' : 'Cursor hidden');
      break;
    case 'dwell':
      S.dwell = cmd.on;
      S.dwellPref = cmd.on;
      S.dwellState.c = null;
      toast(cmd.on ? 'Hands-free on' : 'Hands-free off');
      break;
    case 'input':
      if (!S.tracker) {
        toast('Camera isn’t running');
        break;
      }
      S.input = cmd.input;
      applySteadiness();
      applyFace();
      calibrate();
      break;
    case 'sound':
      S.sound = cmd.on;
      toast(cmd.on ? 'Sound on' : 'Sound off');
      break;
    default:
      break;
  }
  persist();
  renderIsland();
}

// ---------- Calibration ----------
let calToken = 0;

async function waitForFace(alive) {
  let since = 0;
  let firstSeen = 0;
  const t0 = performance.now();
  let warned = false;
  while (alive()) {
    const now = performance.now();
    const fr = S.lastFrame;
    const present = fr?.face && now - fr.t < 500;
    if (present && !firstSeen) firstSeen = now;
    const good = present && (!fr.quality || now - firstSeen > 4000);
    S.calLabel = !present ? 'Looking for your face…' : fr.quality && !good ? fr.quality : 'Hold still…';
    renderIsland();
    if (good) {
      if (!since) since = now;
      if (now - since > 900) {
        if (warned) hideCard();
        return true;
      }
    } else since = 0;
    if (!present && !warned && now - t0 > 6000) {
      warned = true;
      showCard({
        title: 'Can’t see your face',
        body: 'Sit facing the camera with light on your face. Calibration starts by itself once you’re visible.',
        kind: 'blocking',
      });
    }
    await sleep(100);
  }
  return false;
}

async function collectAt(x, y, alive) {
  moveDot(x, y);
  await sleep(reducedMotion ? 650 : 850);
  if (!alive()) return null;
  ui.calDot.classList.add('collect');
  const list = [];
  S.collector = list;
  const start = performance.now();
  while (performance.now() - start < 4000) {
    await sleep(40);
    if (!alive()) break;
    if (list.length >= 26 && performance.now() - start >= 1000) break;
  }
  S.collector = null;
  ui.calDot.classList.remove('collect');
  if (!alive()) return null;
  return list.length >= 8 ? list : [];
}

function endCalibrationUI() {
  S.simTarget = null;
  ui.calDot.classList.remove('on', 'shrink', 'collect');
  ui.body.classList.remove('calibrating');
  S.collector = null;
}

function cancelCalibration() {
  calToken++;
  endCalibrationUI();
  S.phase = S.model ? 'ready' : 'idle';
  hideCard();
  toast(S.model ? 'Calibration cancelled' : 'Say “calibrate” when you’re ready', { ms: 2400 });
  renderIsland();
}

async function calibrate() {
  if (S.input === 'mouse') {
    toast('Mouse mode doesn’t need calibration');
    return;
  }
  if (!S.tracker) {
    if (S.phase === 'idle') location.reload(); // setup failed earlier — retry from scratch
    return;
  }
  const token = ++calToken;
  const alive = () => token === calToken;
  if (S.pen) penOff();
  finishShape();
  hideCard();
  S.phase = 'calibrating';
  ui.body.classList.add('calibrating');
  renderIsland();

  if (!(await waitForFace(alive))) return;

  const head = S.input === 'head';
  S.calLabel = 'Calibrating';
  showCard({
    title: head ? 'Point with your nose' : 'Follow the dot',
    body: head
      ? 'Keep your eyes relaxed and point your nose at each dot until it moves on.'
      : 'Keep your head still and look right at each dot until it moves on.',
    kind: 'blocking',
  });
  await sleep(2600);
  if (!alive()) return;
  hideCard();

  const W = innerWidth;
  const H = innerHeight;
  S.viewport = { w: W, h: H };
  const model = new GazeModel(head ? 'head' : 'eyes');
  ui.calDot.style.transition = 'none';
  ui.calDot.style.transform = `translate3d(${W / 2}px, ${H / 2}px, 0)`;
  void ui.calDot.offsetWidth;
  ui.calDot.style.transition = '';
  ui.calDot.classList.add('on');

  const fail = () => {
    endCalibrationUI();
    S.phase = S.model ? 'ready' : 'idle';
    showCard({
      title: 'Couldn’t see your eyes clearly',
      body: 'Try more light on your face and keep it in view, then say “calibrate”.',
      autoHide: 7000,
    });
    renderIsland();
  };

  const samples = [];
  for (let i = 0; i < CAL_POINTS.length; i++) {
    const x = CAL_POINTS[i][0] * W;
    const y = CAL_POINTS[i][1] * H;
    S.calLabel = `Calibrating · ${i + 1} of ${CAL_POINTS.length}`;
    renderIsland();
    const got = await collectAt(x, y, alive);
    if (!alive()) return;
    if (!got.length) return fail();
    for (const f of cleanSamples(got, model)) samples.push({ f, x, y, g: i });
  }
  model.fit(samples);

  const errors = [];
  for (let j = 0; j < VAL_POINTS.length; j++) {
    const x = VAL_POINTS[j][0] * W;
    const y = VAL_POINTS[j][1] * H;
    S.calLabel = `Checking · ${j + 1} of ${VAL_POINTS.length}`;
    renderIsland();
    const got = await collectAt(x, y, alive);
    if (!alive()) return;
    if (!got.length) return fail();
    const clean = cleanSamples(got, model);
    const preds = clean.map((f) => model.predict(f));
    errors.push(Math.hypot(median(preds.map((p) => p.x)) - x, median(preds.map((p) => p.y)) - y));
    for (const f of clean) samples.push({ f, x, y, g: 100 + j });
  }
  model.fit(samples); // final model uses every dot

  // Frame-to-frame jitter while staring at a dot → tunes the smoothing filter.
  const spread = [];
  for (const g of new Set(samples.map((s) => s.g))) {
    const preds = samples.filter((s) => s.g === g).map((s) => model.predict(s.f));
    const mx = median(preds.map((p) => p.x));
    const my = median(preds.map((p) => p.y));
    spread.push(median(preds.map((p) => Math.hypot(p.x - mx, p.y - my))) * 1.2);
  }

  endCalibrationUI();
  S.model = model;
  S.bias = { x: 0, y: 0 };
  S.accuracy = median(errors);
  S.noise = clamp(median(spread), 10, 250);
  applySteadiness();
  euro.reset();
  brush.reset(null);
  S.history = [];
  S.phase = 'ready';
  blip(1320, 120);

  const acc = Math.round(S.accuracy);
  const label = acc <= 70 ? 'Great' : acc <= 120 ? 'Good' : acc <= 190 ? 'Fair' : 'Rough';
  const tip = acc > 190 ? ' Try more light, sit a little closer, and say “calibrate”.' : '';
  showCard({
    title: `${label} calibration`,
    body: `Accurate to about ${acc} px. Say “draw” to start, or “help” for every command.${tip}`,
    autoHide: 6000,
  });
  renderIsland();
}

async function recenter() {
  if (S.input === 'mouse' || !S.model) return;
  const token = ++calToken;
  const alive = () => token === calToken;
  if (S.pen) penOff();
  S.phase = 'calibrating';
  S.calLabel = 'Look at the dot';
  ui.body.classList.add('calibrating');
  const x = innerWidth / 2;
  const y = innerHeight / 2;
  ui.calDot.classList.add('on');
  const got = await collectAt(x, y, alive);
  if (!alive()) return;
  endCalibrationUI();
  S.phase = 'ready';
  if (got.length) {
    const preds = got.map((f) => S.model.predict(f));
    S.bias = { x: x - median(preds.map((p) => p.x)), y: y - median(preds.map((p) => p.y)) };
    euro.reset();
    toast('Recentered');
    blip(1175, 80);
  } else toast('Couldn’t see your eyes — try again');
  renderIsland();
}

// ---------- Overlay rendering ----------
function drawOverlay(now) {
  const dpr = drawing.dpr;
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, innerWidth, innerHeight);
  if (drawing.active) Drawing.paint(octx, drawing.active, true);

  const g = S.gaze;
  if (S.phase === 'ready' && g && (S.input === 'mouse' || S.face.present)) {
    const color = S.color === 'eraser' ? '#ffffff' : COLORS[S.color];
    const width = SIZES[S.sizeIdx];
    if (S.mode === 'free' && S.pen && brush.pos) {
      octx.strokeStyle = 'rgba(0,0,0,0.25)';
      octx.lineWidth = 1;
      octx.beginPath();
      octx.moveTo(brush.pos.x, brush.pos.y);
      octx.lineTo(g.x, g.y);
      octx.stroke();
      octx.fillStyle = color;
      octx.strokeStyle = 'rgba(255,255,255,0.9)';
      octx.lineWidth = 2;
      octx.beginPath();
      octx.arc(brush.pos.x, brush.pos.y, Math.max(3, width / 2), 0, Math.PI * 2);
      octx.fill();
      octx.stroke();
    }
    if (S.mode !== 'free') {
      const sp = snap(g);
      const p = sp || g;
      if (S.anchor) {
        octx.save();
        octx.globalAlpha = 0.55;
        octx.strokeStyle = color;
        octx.lineWidth = width;
        octx.lineCap = 'round';
        octx.setLineDash([width * 1.5, width * 2]);
        octx.beginPath();
        if (S.mode === 'line') {
          octx.moveTo(S.anchor.x, S.anchor.y);
          octx.lineTo(p.x, p.y);
        } else {
          octx.arc(S.anchor.x, S.anchor.y, dist(S.anchor, p), 0, Math.PI * 2);
        }
        octx.stroke();
        octx.restore();
        drawHandle(S.anchor, color);
        if (S.chainStart && S.chainStart !== S.anchor) drawHandle(S.chainStart, color);
      }
      if (sp) {
        octx.strokeStyle = '#007aff';
        octx.lineWidth = 2.5;
        octx.beginPath();
        octx.arc(sp.x, sp.y, 14, 0, Math.PI * 2);
        octx.stroke();
      }
    }
  }

  S.pulses = S.pulses.filter((p) => now - p.t < 500);
  for (const p of S.pulses) {
    const k = (now - p.t) / 500;
    octx.strokeStyle = `rgba(0,122,255,${0.6 * (1 - k)})`;
    octx.lineWidth = 3;
    octx.beginPath();
    octx.arc(p.x, p.y, 10 + k * 34, 0, Math.PI * 2);
    octx.stroke();
  }
}

function drawHandle(p, color) {
  octx.fillStyle = '#fff';
  octx.strokeStyle = color === '#ffffff' ? '#8e8e93' : color;
  octx.lineWidth = 3;
  octx.beginPath();
  octx.arc(p.x, p.y, 7, 0, Math.PI * 2);
  octx.fill();
  octx.stroke();
}

function updateCursor() {
  const g = S.gaze;
  const show =
    S.phase === 'ready' && S.showCursor && g && (S.input === 'mouse' || S.face.present) && S.card !== 'confirm';
  ui.cursor.classList.toggle('visible', !!show);
  if (!show) return;
  ui.cursor.style.transform = `translate3d(${g.x}px, ${g.y}px, 0)`;
  ui.cursor.dataset.pen = String(S.pen && S.mode === 'free');
  const p = S.dwell && S.mode !== 'free' ? clamp(S.dwellState.progress, 0, 1) : 0;
  ui.ring.style.strokeDashoffset = String(RING_LEN * (1 - p));
}

function frame() {
  const now = performance.now();
  if (S.input === 'mouse' && S.mouse && S.phase === 'ready') onGazeSample({ ...S.mouse }, now);
  if (S.input !== 'mouse' && S.face.present && now - S.face.lastSeen > 700) {
    S.face.present = false;
    if (drawing.active) commitActive(300);
    brush.reset(null);
    S.dwellState.c = null;
  }
  drawOverlay(now);
  updateCursor();
  renderIsland();
  const hidePointer =
    S.phase === 'ready' && !S.card && (S.input === 'mouse' || now - S.lastMouseMove > 2500);
  if (hidePointer !== ui.body.classList.contains('hide-pointer')) ui.body.classList.toggle('hide-pointer', hidePointer);
  requestAnimationFrame(frame);
}

// ---------- Startup ----------
let voice = null;
function startVoice() {
  if (voice) return;
  voice = new Voice({
    onCommand: (cmd, meta) => run(cmd, meta),
    onHeard: showCaption,
    onState: (state) => {
      S.micState = state;
      if (state === 'denied') {
        S.dwell = true;
        showCard({
          title: 'Microphone is blocked',
          body: 'Allow the microphone from the address bar for voice commands. Hands-free mode is on meanwhile: hold your gaze to place points, close your eyes for a second to start or stop.',
          autoHide: 9000,
        });
      } else if (state === 'network') {
        toast('Voice needs an internet connection', { ms: 2500 });
      }
      renderIsland();
    },
  });
  voice.start();
}

function fatal(title, body) {
  S.phase = 'idle';
  const reload = document.createElement('button');
  reload.className = 'pill primary';
  reload.textContent = 'Reload';
  reload.onclick = () => location.reload();
  const row = document.createElement('div');
  row.className = 'choices';
  row.append(reload);
  showCard({ title, body: `${body} You can also say “calibrate” to retry.`, extra: row, kind: 'blocking' });
  renderIsland();
}

function cameraError(e) {
  console.error('[VisionBrush]', e);
  const name = e?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return fatal('Camera access is off', 'Allow the camera from the icon in the address bar, then reload the page.');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return fatal('No camera found', 'Connect a webcam, then reload the page.');
  }
  if (name === 'NotReadableError') {
    return fatal('Camera is busy', 'Another app is using the camera. Close it, then reload.');
  }
  return fatal('Couldn’t load eye tracking', 'Check your internet connection and reload. The model downloads once, then runs on this computer.');
}

async function begin(mouse = false) {
  if (S.phase !== 'welcome') return;
  S.phase = 'starting';
  if (!mouse && !params.has('nofs') && document.fullscreenEnabled && !document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(() => {});
  }
  ui.welcome.classList.add('gone');
  ui.body.classList.add('started');
  blip(880, 1, 0.0001); // unlock audio inside the user gesture
  startVoice();

  if (mouse || params.has('mouse')) {
    S.input = 'mouse';
    applySteadiness();
    applyFace();
    S.phase = 'ready';
    ui.body.classList.add('mouse');
    showCard({
      title: 'Mouse preview',
      body: 'The mouse stands in for your eyes. Speak commands, or press Space to draw and H for help.',
      autoHide: 6000,
    });
    renderIsland();
    return;
  }

  if (!window.isSecureContext) {
    return fatal('Needs a secure page', 'Open VisionBrush over https:// (or localhost) so the camera can turn on.');
  }

  S.statusText = 'Starting camera';
  showCard({ title: 'Getting ready', body: 'Allow the camera and microphone when your browser asks.', kind: 'blocking' });
  renderIsland();
  try {
    let tracker;
    if (params.has('simulate')) {
      const { SimTracker } = await import('./sim.js');
      tracker = new SimTracker(() => S.simTarget || S.mouse);
      S.showFace = false;
    } else {
      const { FaceTracker } = await import('./gaze.js');
      tracker = new FaceTracker(ui.video);
    }
    await tracker.startCamera();
    S.statusText = 'Loading eye tracking';
    renderIsland();
    await tracker.load();
    S.tracker = tracker;
    tracker.start(onFaceFrame);
  } catch (e) {
    return cameraError(e);
  }
  applyFace();
  hideCard();
  calibrate();
}

// Keyboard: for caregivers, switch users, and testing.
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (S.phase === 'welcome') {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      begin(false);
    } else if (e.key === 'm' || e.key === 'M') begin(true);
    return;
  }
  const k = e.key;
  const cmd = {
    ' ': S.mode === 'free' ? { type: 'pen', on: !S.pen } : { type: 'place' },
    Enter: { type: 'place' },
    Escape: S.card ? { type: 'no' } : { type: 'pen', on: false },
    z: { type: 'undo' },
    Z: { type: 'redo' },
    Backspace: { type: 'clear' },
    Delete: { type: 'clear' },
    c: { type: 'calibrate' },
    r: { type: 'recenter' },
    h: { type: 'help' },
    '?': { type: 'help' },
    b: { type: 'face', on: !S.showFace },
    1: { type: 'mode', mode: 'free' },
    2: { type: 'mode', mode: 'line' },
    3: { type: 'mode', mode: 'circle' },
    '[': { type: 'size', delta: -1 },
    ']': { type: 'size', delta: 1 },
    '-': { type: 'steady', delta: -1 },
    '=': { type: 'steady', delta: 1 },
    s: { type: 'save' },
    p: { type: 'photo' },
    d: { type: 'dwell', on: !S.dwell },
    y: { type: 'yes' },
    n: { type: 'no' },
    k: { type: 'color', color: nextColor() },
  }[k];
  if (k === 'f') {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
    return;
  }
  if (!cmd) return;
  e.preventDefault();
  run(cmd, { source: 'key' });
});

function nextColor() {
  const names = Object.keys(COLORS);
  return names[(names.indexOf(S.color) + 1) % names.length];
}

addEventListener('mousemove', (e) => {
  S.mouse = { x: e.clientX, y: e.clientY };
  S.lastMouseMove = performance.now();
});

let resizeTimer = 0;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    drawing.resize();
    ui.overlay.width = Math.round(innerWidth * drawing.dpr);
    ui.overlay.height = Math.round(innerHeight * drawing.dpr);
    const { w, h } = S.viewport;
    if (S.model && (Math.abs(w - innerWidth) > 40 || Math.abs(h - innerHeight) > 40)) {
      S.viewport = { w: innerWidth, h: innerHeight };
      toast('Window changed size — say “calibrate” for best accuracy', { ms: 3200 });
    }
  }, 120);
});

ui.overlay.width = Math.round(innerWidth * drawing.dpr);
ui.overlay.height = Math.round(innerHeight * drawing.dpr);

ui.welcome.addEventListener('click', () => begin(false));
ui.tryMouse.addEventListener('click', (e) => {
  e.stopPropagation();
  begin(true);
});
if (!voiceSupported) ui.body.classList.add('no-voice');

// Returning visitors who already allowed the camera start hands-free.
(async () => {
  if (params.has('mouse')) return;
  try {
    const cam = await navigator.permissions.query({ name: 'camera' });
    const mic = voiceSupported ? await navigator.permissions.query({ name: 'microphone' }) : { state: 'granted' };
    if (cam.state === 'granted' && mic.state === 'granted' && S.phase === 'welcome') begin(false);
  } catch {
    /* permissions API unsupported — wait for a click */
  }
})();

// Console / test hook: visionbrush.say('blue')
window.visionbrush = {
  say: (text) => import('./voice.js').then(({ parse }) => parse(text).forEach((c) => run(c, { source: 'console' }))),
  state: S,
};

renderIsland();
requestAnimationFrame(frame);
