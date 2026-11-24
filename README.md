# VisionBrush

**Draw with your eyes. Guide it with your voice.**

VisionBrush is a full-screen drawing canvas for people with limited hand movement (ALS, spinal cord injury, cerebral palsy, MS, and others). A normal webcam tracks where you look; you speak short commands like “start”, “end”, “fix”, “blue” or “undo”. Nothing to click, no toolbars. The whole screen is the canvas, with your face live behind it.

Built for AME 434 · Machine Learning for Media & Arts · Arizona State University.

## Try it

- **Live:** <https://thekanatomy.github.io/vision-brush/>
- **Local:** `python3 -m http.server 8000` in this folder, then open <http://localhost:8000>
  (the camera only works on `https://` or `localhost`)
- **No camera?** Add `?mouse` (the mouse stands in for your eyes) or `?simulate` (fake eye tracker that follows the calibration dots, then the mouse)

Best in **Chrome or Edge** on a laptop or desktop, webcam at eye level, light on your face, about an arm’s length from the screen.

## How to use it

1. Click once (or press Space) to start. Allow the camera and microphone.
2. **Calibrate:** look at each dot until it moves on (~35 s). VisionBrush reports its accuracy.
3. **Draw:** say a command. Your gaze decides *where*, your voice decides *what*. During calibration and drawing your face stays faded so the room behind you doesn't distract; a faint mesh and glowing iris rings show what's being tracked.

| Say | What happens |
|---|---|
| **start** / **end** | Freehand pen follows your eyes / lifts (also: draw / stop) |
| **fix** | Toggle shape snapping: on “end”, rough circles, ovals, rectangles, triangles and lines snap clean (like Apple Pencil). Say it right after a stroke to fix that one too. “undo” brings back the hand-drawn version. |
| **here** | Place a point where you’re looking (lines, circles, dots) |
| **done** · **close** | Finish a line/circle shape · connect back to the first point |
| **free** · **line** · **circle** | Switch tool |
| **red, orange, yellow, green, blue, purple, pink, brown, gray, black, white** | Colour |
| **eraser** | Erase where you draw |
| **bigger** · **smaller** | Brush size |
| **undo** · **redo** · **clear** (then **yes**/**no**) | Edit |
| **save** · **photo** | Download the drawing · drawing with your face behind it |
| **calibrate** · **recenter** | Full recalibration · one-dot drift fix |
| **steadier** · **faster** | More or less smoothing |
| **hide face** · **show face** | Plain paper or live camera background |
| **hands free** · **dwell off** | No-voice mode: hold your gaze to place points, close your eyes ~1 s to start/stop |
| **use head** · **use eyes** | Point with your nose instead of your eyes (more precise if you can move your head) |
| **help** | Show every command |

**Tip:** for crisp shapes use **line** mode: look at a spot, say “here”, look at the next spot, say “here”. Eyes jump between points naturally, so this is far more precise than freehand.

### Keyboard (for caregivers and switch users)

`Space` start/end or place · `X` fix on/off · `Enter` place · `Esc` stop · `Z` undo · `Shift+Z` redo · `Delete` clear · `1 2 3` free/line/circle · `[ ]` size · `K` next colour · `- =` smoothing · `C` calibrate · `R` recenter · `H` help · `B` face · `D` hands-free · `S` save · `P` photo · `F` fullscreen

## How it works

```
webcam ─▶ MediaPipe Face Landmarker (478 landmarks + iris + blendshapes + head pose, on-device WASM/GPU)
       ─▶ features: iris position inside each eye (roll-invariant), eyelid opening,
          eye-look blendshapes, head yaw/pitch, head position
       ─▶ per-person ridge regression (quadratic eye terms), penalty chosen by
          leave-one-dot-out cross-validation; 13 calibration dots + 4 held-out check dots
       ─▶ One Euro filter with a noise floor measured during calibration
          (steady while you fixate, fast when your eyes jump)
       ─▶ lazy brush (pen trails the gaze on a short string) ─▶ canvas
voice  ─▶ Web Speech API, continuous; commands act on interim results for speed,
          and “here” uses where you were looking just *before* you spoke
```

### Built for real eyes (blinks, itches, glances)

| What eyes do | What VisionBrush does |
|---|---|
| **Blink** | The eyelid drags the iris down just before a blink registers, so the last ~100 ms is rewound, the pen holds during the blink, and the first ~100 ms after reopening is ignored. |
| **Rub an itchy eye / squint** | Frames that look nothing like calibration are dropped. |
| **Hand over face / turn away** | The current line ends cleanly instead of streaking. |
| **Tremor, micro-movements** | One Euro smoothing with a noise floor measured per person during calibration, plus a lazy-brush leash. |
| **Hands-free toggle** | Eyes closed ~0.7–2.5 s *with the head still* starts/stops the pen. Normal blinks are too short; eye-rubs move the head, so they're ignored. |

The thresholds scale with each person's own calibration accuracy and jitter, so a shaky tracker gets more forgiving guards.

Design choices, with the research behind them:

- **Gaze + voice instead of dwell-clicking.** Webcam eye tracking is accurate to roughly 2–5° (≈80–200 px). Clicking by staring (dwell) causes accidental selections, the “Midas touch” problem. Speaking the action while your eyes choose the place avoids it.
- **Point-to-point drawing** (from EyeDraw, CHI 2004): eyes move in jumps, so placing points and joining them beats free-eye drawing.
- **Hands-free fallback** (dwell + long blink) for people who can’t speak, or browsers without speech recognition.
- **No on-screen chrome.** One status pill, a soft HUD for confirmations, and your face as the backdrop.

## Privacy

Video is processed in the browser and never recorded or uploaded. The face model (a few MB) downloads once from Google’s MediaPipe CDN. Voice commands use the browser’s speech recognition service (in Chrome, that’s Google’s servers). Settings are stored in your browser’s localStorage.

## Files

```
index.html          page shell
css/styles.css      Apple-style visual system
js/main.js          app state, commands, calibration flow, rendering
js/gaze.js          MediaPipe face tracking → feature vector
js/calibration.js   ridge regression + cross-validation
js/filters.js       One Euro filter, lazy brush
js/voice.js         speech recognition + command vocabulary
js/canvas.js        vector strokes, undo/redo, export
js/shapes.js        "fix" shape recognizer (line, circle, oval, triangle, rectangle)
js/sim.js           ?simulate fake tracker for demos/tests
```

No build step and no dependencies to install. It’s plain ES modules, so GitHub Pages serves it as-is.

## Credits

MediaPipe Face Landmarker (Google) · One Euro filter (Casiez, Roussel & Vogel, CHI 2012) · EyeDraw (Hornof & Cavender, CHI 2004) · EyeWriter (Tempt One, Not Impossible Labs, Graffiti Research Lab, openFrameworks)
