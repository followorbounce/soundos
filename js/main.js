import { initCanvas, setScopeMode, setCompactMode, randomizeAllParams, applyPreset, zoomTo, getZoom } from './canvas.js';
import { initMenu } from './menu.js';
import { state, addNode, addEdge, clearAll, setParam, onChange, resetHistory } from './state.js';
import { NODE_TYPES } from './nodeLibrary.js';
import { engine } from './audio/engine.js';
import { exportPatch, importPatch } from './exporter.js';
import { PRESETS } from './presets.js';

const btnGenerate = document.getElementById('btn-generate');
const btnStop = document.getElementById('btn-stop');
const btnZoomOut = document.getElementById('btn-zoom-out');
const zoomReadout = document.getElementById('zoom-readout');
const btnZoomIn = document.getElementById('btn-zoom-in');
const speedSlider = document.getElementById('speed-slider');
const speedReadout = document.getElementById('speed-readout');
const btnRandom = document.getElementById('btn-random');
const presetSelect = document.getElementById('preset-select');
const btnScopeMode = document.getElementById('btn-scope-mode');
const btnCompact = document.getElementById('btn-compact');
const btnStage = document.getElementById('btn-stage');
const btnExport = document.getElementById('btn-export');
const btnImport = document.getElementById('btn-import');
const fileImport = document.getElementById('file-import');
const btnClear = document.getElementById('btn-clear');
const toastStack = document.getElementById('toast-stack');

// Role -> node id for whatever the current starter rack is, so presets (and
// anything else keyed by role) apply to the right node regardless of the
// random ids addNode() hands out. Populated by seedDemoPatch().
let roles = {};

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  toastStack.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// Starter rack mirroring Pulse Train — Stage II's own default board: same
// 13 units (Tone/Tone II as two Oscillators, Rhythm, LFO, Crush, Ring, Field,
// Freeze, Comb, Drive as Distortion, Shimmer, Space as Reverb, Output), plus
// a Null junction (a passive unity-gain pass-through, see nodeLibrary.js)
// landing all five chains before Output rather than summing directly on
// Output's own 'in' — a real pre-master junction point, in the same spot the
// reference has nothing.
//
// Laid out as one lane per signal chain, not grouped by type: each node's x
// is how many processing steps it sits from its own source, so a two-step
// chain (Tone->Ring->Field) ends and turns toward Null/Output two columns
// earlier than a three-step one (Tone->Crush->Comb->Space) — the cable for
// the shorter chain just runs on a longer diagonal to get there, rather than
// every node being padded out to a shared column. Rhythm has no processing
// at all, so its cable is the longest diagonal of all, top-left corner
// straight across to the junction. Y is grouped by lane: Rhythm alone on
// top, then Tone's two chains (Ring/Field above, Crush/Comb/Space below,
// Tone itself sitting at their midpoint so it fans out to both), then
// Tone II's two chains the same way underneath. The one simplification
// versus the reference: our Oscillator has a single output, not two (a
// plain `out` and a ratio-locked `out2`) — here Tone's own `out` just feeds
// both of its destinations instead.
function seedDemoPatch() {
  const tone = addNode('oscillator', 60, 360, NODE_TYPES.oscillator.params);
  const tone2 = addNode('oscillator', 60, 760, NODE_TYPES.oscillator.params);
  const rhythm = addNode('rhythm', 60, 60, NODE_TYPES.rhythm.params);
  const lfo = addNode('lfo', 1260, 900, NODE_TYPES.lfo.params);

  const ring = addNode('ring', 360, 260, NODE_TYPES.ring.params);
  const crush = addNode('crush', 360, 460, NODE_TYPES.crush.params);
  const freeze = addNode('freeze', 360, 660, NODE_TYPES.freeze.params);
  const drive = addNode('distortion', 360, 860, NODE_TYPES.distortion.params);

  const field = addNode('field', 660, 260, NODE_TYPES.field.params);
  const comb = addNode('comb', 660, 460, NODE_TYPES.comb.params);
  const shimmer = addNode('shimmer', 660, 860, NODE_TYPES.shimmer.params);

  const space = addNode('reverb', 960, 460, NODE_TYPES.reverb.params);

  const junction = addNode('nullNode', 1260, 460, NODE_TYPES.nullNode.params);
  const output = addNode('output', 1560, 460, NODE_TYPES.output.params);

  roles = { tone, tone2, rhythm, lfo, crush, ring, drive, field, freeze, comb, shimmer, space, junction, output };

  addEdge(tone, 'out', crush, 'in');
  addEdge(crush, 'out', comb, 'in');
  addEdge(comb, 'out', space, 'in');
  addEdge(space, 'out', junction, 'in');
  addEdge(tone, 'out', ring, 'in');
  addEdge(ring, 'out', field, 'in');
  addEdge(field, 'out', junction, 'in');
  addEdge(rhythm, 'out', junction, 'in');
  addEdge(tone2, 'out', freeze, 'in');
  addEdge(freeze, 'out', junction, 'in');
  addEdge(tone2, 'out', drive, 'in');
  addEdge(drive, 'out', shimmer, 'in');
  addEdge(shimmer, 'out', junction, 'in');
  addEdge(junction, 'out', output, 'in');
  // LFO is left unpatched, same as the reference — a CV source sitting ready
  // to be dragged onto any `_mod` jack during a set, not part of the fixed chain.

  applyPreset(roles, PRESETS[0].params, PRESETS[0].bypass);
}

async function onGenerate() {
  if (![...state.nodes.values()].some((n) => n.typeId === 'output')) {
    toast('Add an Output node to start the oscillation', true);
    return;
  }
  btnGenerate.disabled = true;
  try {
    await engine.start();
    btnStop.disabled = false;
    toast('Oscillation started');
  } catch (err) {
    console.error(err);
    toast('Could not start audio: ' + err.message, true);
  } finally {
    btnGenerate.disabled = false;
  }
}

async function onStop() {
  await engine.stop();
  btnStop.disabled = true;
}

btnGenerate.addEventListener('click', onGenerate);
btnStop.addEventListener('click', onStop);

btnZoomOut.addEventListener('click', () => zoomTo(getZoom() / 1.25));
btnZoomIn.addEventListener('click', () => zoomTo(getZoom() * 1.25));
zoomReadout.addEventListener('click', () => zoomTo(1));

// Slider position is in octaves (-2..2), not a raw multiplier, so halving
// and doubling the speed both feel like the same amount of drag either way —
// speed = 2^octaves. Applies live via engine.setSpeed(), no rebuild needed.
speedSlider.addEventListener('input', () => {
  const speed = Math.pow(2, parseFloat(speedSlider.value));
  engine.setSpeed(speed);
  speedReadout.textContent = Math.round(speed * 100) + '%';
});
speedReadout.addEventListener('click', () => {
  speedSlider.value = 0;
  engine.setSpeed(1);
  speedReadout.textContent = '100%';
});

btnRandom.addEventListener('click', () => {
  randomizeAllParams();
  toast('Knobs shuffled');
});

let scopeMode = 'wave';
btnScopeMode.addEventListener('click', () => {
  scopeMode = scopeMode === 'wave' ? 'spectrum' : 'wave';
  setScopeMode(scopeMode);
  btnScopeMode.textContent = scopeMode === 'wave' ? 'Scopes: Wave' : 'Scopes: Spectrum';
});

let compactMode = false;
btnCompact.addEventListener('click', () => {
  compactMode = !compactMode;
  setCompactMode(compactMode);
  btnCompact.textContent = compactMode ? 'Compact: On' : 'Compact: Off';
});

btnStage.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
});

PRESETS.forEach((p) => {
  const opt = document.createElement('option');
  opt.value = p.id;
  opt.textContent = p.name;
  presetSelect.appendChild(opt);
});
presetSelect.addEventListener('change', () => {
  const preset = PRESETS.find((p) => p.id === presetSelect.value);
  if (!preset) return;
  applyPreset(roles, preset.params, preset.bypass);
  toast(preset.name + ' — ' + preset.note);
});

btnExport.addEventListener('click', exportPatch);
btnImport.addEventListener('click', () => fileImport.click());
fileImport.addEventListener('change', async () => {
  const file = fileImport.files[0];
  if (!file) return;
  try {
    await importPatch(file);
    toast('Patch loaded');
  } catch (err) {
    toast('Failed to load file: ' + err.message, true);
  }
  fileImport.value = '';
});
btnClear.addEventListener('click', () => {
  if (confirm('Clear the entire patch?')) {
    onStop();
    clearAll();
  }
});

// Patching (adding/removing a node or a cable) is a structural change to the
// graph, not a knob — while the synth is already playing, re-wire it live so
// e.g. deleting the Output node actually silences things immediately instead
// of waiting for another Generate press. This does re-trigger the graph
// (a brief reset, same tradeoff as the initial Generate), unlike a bypass
// toggle or a knob turn, which stay glitch-free.
onChange((kind) => {
  if (engine.isLive() && ['node-add', 'node-remove', 'edge-add', 'edge-remove', 'clear', 'load'].includes(kind)) {
    engine.rebuild();
  }
});

initMenu();
initCanvas();
if (state.nodes.size === 0) {
  seedDemoPatch();
  presetSelect.value = PRESETS[0].id;
  resetHistory(); // building the starter rack shouldn't itself be undoable
}
