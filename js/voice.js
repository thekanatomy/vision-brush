// Voice commands via the Web Speech API (Chrome, Edge, Safari).

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const voiceSupported = !!SR;

// Each entry: spoken phrases → command. Kept deliberately small so
// people talking nearby rarely trigger anything by accident.
const VOCAB = [
  [['draw', 'drawing', 'start', 'begin', 'pen down'], { type: 'pen', on: true }],
  [['stop', 'pause', 'lift', 'pen up'], { type: 'pen', on: false }],
  [['here', 'hear', 'point', 'next', 'mark'], { type: 'place' }],
  [['done', 'finish', 'finished', 'end'], { type: 'finish' }],
  [['close', 'close shape', 'connect'], { type: 'close' }],
  [['undo', 'oops'], { type: 'undo' }],
  [['redo'], { type: 'redo' }],
  [['clear', 'erase all', 'new page', 'start over', 'clear all'], { type: 'clear' }],
  [['yes', 'confirm', 'yeah', 'sure'], { type: 'yes' }],
  [['no', 'cancel', 'nope', 'keep it'], { type: 'no' }],
  [['save', 'download', 'export'], { type: 'save' }],
  [['photo', 'snapshot', 'picture', 'selfie'], { type: 'photo' }],
  [['line', 'lines', 'straight'], { type: 'mode', mode: 'line' }],
  [['free', 'freehand', 'free hand', 'sketch', 'pencil'], { type: 'mode', mode: 'free' }],
  [['circle', 'circles', 'round'], { type: 'mode', mode: 'circle' }],
  [['black'], { type: 'color', color: 'black' }],
  [['white'], { type: 'color', color: 'white' }],
  [['red'], { type: 'color', color: 'red' }],
  [['orange'], { type: 'color', color: 'orange' }],
  [['yellow'], { type: 'color', color: 'yellow' }],
  [['green'], { type: 'color', color: 'green' }],
  [['blue'], { type: 'color', color: 'blue' }],
  [['purple', 'violet'], { type: 'color', color: 'purple' }],
  [['pink'], { type: 'color', color: 'pink' }],
  [['brown'], { type: 'color', color: 'brown' }],
  [['gray', 'grey'], { type: 'color', color: 'gray' }],
  [['eraser', 'erase', 'rubber'], { type: 'color', color: 'eraser' }],
  [['bigger', 'thicker', 'larger', 'big', 'thick'], { type: 'size', delta: 1 }],
  [['smaller', 'thinner', 'small', 'thin'], { type: 'size', delta: -1 }],
  [['calibrate', 'recalibrate', 'calibration'], { type: 'calibrate' }],
  [['recenter', 're center', 'center', 'centre', 'fix'], { type: 'recenter' }],
  [['steadier', 'smoother', 'steady', 'smooth', 'slower'], { type: 'steady', delta: 1 }],
  [['faster', 'quicker', 'looser', 'sharper'], { type: 'steady', delta: -1 }],
  [['help', 'commands', 'what can i say'], { type: 'help' }],
  [['hide face', 'paper', 'blank'], { type: 'face', on: false }],
  [['show face', 'mirror'], { type: 'face', on: true }],
  [['hide cursor'], { type: 'cursor', on: false }],
  [['show cursor'], { type: 'cursor', on: true }],
  [['dwell on', 'hands free'], { type: 'dwell', on: true }],
  [['dwell off'], { type: 'dwell', on: false }],
  [['use head', 'head mode'], { type: 'input', input: 'head' }],
  [['use eyes', 'eye mode', 'eyes mode'], { type: 'input', input: 'eyes' }],
  [['mute', 'sound off'], { type: 'sound', on: false }],
  [['unmute', 'sound on'], { type: 'sound', on: true }],
];

const MAP = new Map();
for (const [phrases, cmd] of VOCAB) for (const p of phrases) MAP.set(p, cmd);
const MAX_WORDS = Math.max(...[...MAP.keys()].map((k) => k.split(' ').length));

// A word is "ambiguous" if it is the start of a longer phrase that means
// something else ("red" → "redo", "start" → "start over"). When such a
// word is the last thing heard so far, wait for the final transcript.
const AMBIGUOUS = new Set();
for (const k of MAP.keys()) {
  for (const v of MAP.keys()) {
    if (v === k || JSON.stringify(MAP.get(v)) === JSON.stringify(MAP.get(k))) continue;
    const longerPhrase = v.startsWith(`${k} `);
    const longerWord = !k.includes(' ') && !v.includes(' ') && v.startsWith(k);
    if (longerPhrase || longerWord) AMBIGUOUS.add(k);
  }
}

export function parse(text) {
  const words = text
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; ) {
    let hit = false;
    for (let n = Math.min(MAX_WORDS, words.length - i); n >= 1; n--) {
      const phrase = words.slice(i, i + n).join(' ');
      const cmd = MAP.get(phrase);
      if (cmd) {
        out.push({ ...cmd, word: phrase, atEnd: i + n === words.length });
        i += n;
        hit = true;
        break;
      }
    }
    if (!hit) i++;
  }
  return out;
}

export const HELP_GROUPS = [
  ['Draw', [
    ['draw', 'Pen follows your eyes'],
    ['stop', 'Lift the pen'],
    ['here', 'Place a point where you look'],
    ['done', 'Finish the shape'],
  ]],
  ['Tools', [
    ['free · line · circle', 'Switch tool'],
    ['red · blue · black…', 'Change colour'],
    ['bigger · smaller', 'Brush size'],
    ['eraser', 'Erase where you draw'],
  ]],
  ['Edit', [
    ['undo · redo', 'Step back or forward'],
    ['clear', 'Start a fresh page'],
    ['save', 'Download the drawing'],
    ['photo', 'Drawing with your face'],
  ]],
  ['Setup', [
    ['calibrate', 'Re-learn your eyes'],
    ['recenter', 'Fix drift with one dot'],
    ['steadier · faster', 'Smoothing'],
    ['hide face · show face', 'Background'],
  ]],
];

export class Voice {
  constructor({ onCommand, onHeard, onState }) {
    this.onCommand = onCommand;
    this.onHeard = onHeard;
    this.onState = onState;
    this.wanted = false;
    this.failures = 0;
    this.done = new Map();
  }

  start() {
    if (!SR) {
      this.onState('unsupported');
      return;
    }
    this.wanted = true;
    this.spawn();
  }

  stop() {
    this.wanted = false;
    try {
      this.rec?.abort();
    } catch {
      /* ignore */
    }
  }

  spawn() {
    const r = new SR();
    this.rec = r;
    this.done = new Map();
    const lang = navigator.language || 'en-US';
    r.lang = /^en/i.test(lang) ? lang : 'en-US';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onstart = () => this.onState('listening');
    r.onspeechstart = () => this.onState('hearing');
    r.onspeechend = () => this.onState('listening');
    r.onresult = (e) => {
      this.failures = 0;
      this.handle(e);
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.wanted = false;
        this.onState('denied');
      } else if (e.error === 'network') {
        this.failures++;
        this.onState('network');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        this.failures++;
      }
    };
    r.onend = () => {
      if (!this.wanted) {
        this.onState('off');
        return;
      }
      const delay = this.failures ? Math.min(8000, 400 * 2 ** this.failures) : 120;
      setTimeout(() => this.wanted && this.spawn(), delay);
    };
    try {
      r.start();
    } catch {
      setTimeout(() => this.wanted && this.spawn(), 1000);
    }
  }

  handle(e) {
    const t = performance.now();
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const text = res[0].transcript.trim();
      let cmds = parse(text);
      const last = cmds[cmds.length - 1];
      if (!res.isFinal && last?.atEnd && AMBIGUOUS.has(last.word)) cmds = cmds.slice(0, -1);
      const done = this.done.get(i) || 0;
      for (let k = done; k < cmds.length; k++) {
        this.onCommand(cmds[k], { t, text, interim: !res.isFinal, source: 'voice' });
      }
      if (cmds.length > done) this.done.set(i, cmds.length);
      this.onHeard(text, res.isFinal);
    }
  }
}
