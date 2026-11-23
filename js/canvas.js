// Vector drawing model: every stroke is kept as data, so undo/redo and
// window resizes re-render losslessly.

export const COLORS = {
  black: '#1d1d1f',
  white: '#ffffff',
  red: '#ff3b30',
  orange: '#ff9500',
  yellow: '#ffcc00',
  green: '#34c759',
  blue: '#007aff',
  purple: '#af52de',
  pink: '#ff2d55',
  brown: '#a2845e',
  gray: '#8e8e93',
  eraser: 'eraser',
};

export const SIZES = [4, 8, 14, 22, 34];

export class Drawing {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.strokes = [];
    this.redoStack = [];
    this.active = null;
    this.resize();
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.render();
  }

  visible() {
    let i = this.strokes.length - 1;
    for (; i >= 0; i--) if (this.strokes[i].type === 'clear') break;
    return this.strokes.slice(i + 1);
  }

  get isEmpty() {
    return this.visible().length === 0;
  }

  lastVisible() {
    const v = this.visible();
    return v[v.length - 1] || null;
  }

  render() {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    for (const s of this.visible()) Drawing.paint(ctx, s);
  }

  begin(stroke) {
    this.active = stroke;
  }

  commit() {
    const a = this.active;
    this.active = null;
    if (a) this.add(a);
  }

  add(stroke) {
    this.strokes.push(stroke);
    this.redoStack.length = 0;
    if (stroke.type === 'clear') this.render();
    else Drawing.paint(this.ctx, stroke);
  }

  undo() {
    const s = this.strokes.pop();
    if (!s) return null;
    this.redoStack.push(s);
    this.render();
    return s;
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return null;
    this.strokes.push(s);
    this.render();
    return s;
  }

  clear() {
    if (this.isEmpty) return false;
    this.add({ type: 'clear' });
    return true;
  }

  snapPoints() {
    const pts = [];
    for (const s of this.visible()) {
      if (s.type === 'line') pts.push(s.a, s.b);
      else if (s.type === 'circle') pts.push(s.c);
    }
    return pts;
  }

  static paint(ctx, s, preview = false) {
    if (s.type === 'clear') return;
    ctx.save();
    if (s.color === 'eraser') {
      if (preview) {
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
      } else {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = '#000';
        ctx.fillStyle = '#000';
      }
    } else {
      const c = COLORS[s.color] || s.color;
      ctx.strokeStyle = c;
      ctx.fillStyle = c;
    }
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (s.type === 'free') {
      const p = s.points;
      if (p.length === 1) {
        ctx.arc(p[0].x, p[0].y, s.width / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.moveTo(p[0].x, p[0].y);
        for (let i = 1; i < p.length - 1; i++) {
          ctx.quadraticCurveTo(p[i].x, p[i].y, (p[i].x + p[i + 1].x) / 2, (p[i].y + p[i + 1].y) / 2);
        }
        ctx.lineTo(p[p.length - 1].x, p[p.length - 1].y);
        ctx.stroke();
      }
    } else if (s.type === 'line') {
      ctx.moveTo(s.a.x, s.a.y);
      ctx.lineTo(s.b.x, s.b.y);
      ctx.stroke();
    } else if (s.type === 'circle') {
      ctx.arc(s.c.x, s.c.y, s.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Flattened PNG-ready canvas. With a video, the mirrored face is the background. */
  exportCanvas(video = null) {
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const x = c.getContext('2d');
    if (video && video.videoWidth) {
      const scale = Math.max(c.width / video.videoWidth, c.height / video.videoHeight);
      const dw = video.videoWidth * scale;
      const dh = video.videoHeight * scale;
      x.save();
      x.translate(c.width, 0);
      x.scale(-1, 1);
      x.drawImage(video, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
      x.restore();
    } else {
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, c.width, c.height);
    }
    x.drawImage(this.canvas, 0, 0);
    return c;
  }
}
