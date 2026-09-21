# SoundOS

A browser-based modular synthesizer builder: assemble a patch from nodes, hit Generate, and it oscillates continuously in real time like a powered-on hardware modular rig — no keyboard, no notes, no polyphony. Sound reference: Ryoji Ikeda / Raster-Noton, Alva Noto.

## Structure

- `index.html` — shell + toolbar (Generate/Stop, Speed, Compact, Scopes toggle, Chance, Stage, preset picker)
- `css/` — visual styling
- `js/nodeLibrary.js` — the node database: every node type's ports, params, and `build(ctx)` Web Audio factory. Adding a node type = adding one object here.
- `js/canvas.js` — the visual patch editor: pannable/zoomable canvas, SVG cables, drag/connect/disconnect, oscilloscopes, Compact layout
- `js/audio/engine.js` — compiles the visual patch into one continuously-running Web Audio graph (no per-voice cloning)
- `js/audio/worklets/mathProcessor.js` — AudioWorklet for the Math node (multiply/min/max need sample-by-sample math)
- `js/menu.js` — node-picker menu (search, desktop grid placement / mobile auto-placement)
- `js/presets.js` — tuning presets ported from Pulse Train — Stage II, applied by node role
- `js/state.js` — patch state + undo/redo (full JSON snapshots, checkpointed per gesture not per frame); also holds `loops` (recorded parameter takes), kept OUT of undo snapshots on purpose and included in export/import
- `js/recorder.js` — per-node live taping: Record (≤4 s, driven off the `param-change` event) and Play-loop buttons in each node header; playback replays through canvas.js's own param path with an `applying` guard so replayed moves aren't re-recorded
- `js/main.js` — wiring + `seedDemoPatch` starter rack
- `js/exporter.js` — JSON patch export/import

Ported by technique/math/topology from `pulse-train-stage-ii.html` and `pulse-train-node-database.html` in `followorbounce.github.io` — the patch architecture (Web Audio graph + JSON state) is original to SoundOS.

## Conventions

- Single continuous graph, no polyphony — this is deliberate (see README "Known simplifications"), not a bug to fix casually.
- Every node with an output gets an always-on oscilloscope (never a toggle per-node); Compact mode is a genuinely different render path (`renderNode()` skips creating the canvas), not just a CSS class on `<body>`.
- Params tagged `scale: 'hz'` or `scale: 'time'` in `nodeLibrary.js` respond to the global Speed control automatically — tag new pitch/rate or duration params accordingly.
- Run via `python3 -m http.server 8080` — ES modules and AudioWorklet don't work over `file://`.
- Never use Russian in code/UI/docs unless the task explicitly calls for it — a prior commit (`3af4dde`) had to translate remaining Russian to English; don't reintroduce it.

## Repo

`origin` → `github.com/followorbounce/soundos`.

## Analytics
Cloudflare Web Analytics beacon added 2026-09-19, shares the `followorbounce.github.io` Web Analytics site (see `[[cloudflare-analytics-setup]]` in memory).
