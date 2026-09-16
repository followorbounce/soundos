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
// Freeze, Comb, Drive as Distortion, Shimmer, Space as Reverb, Output), same
// five groups, and the same default cabling — Output's own 'in' sums five
// parallel chains directly, exactly like the reference, with no separate
// Mixer node needed. The one simplification: our Oscillator has a single
// output, where the reference's Tone/Tone II each have two (a plain `out`
// and a ratio-locked `out2`) — here Tone's own `out` is just patched to both
// of its destinations instead.
function seedDemoPatch() {
  const tone = addNode('oscillator', 60, 60, NODE_TYPES.oscillator.params);
  const tone2 = addNode('oscillator', 300, 60, NODE_TYPES.oscillator.params);
  const rhythm = addNode('rhythm', 540, 60, NODE_TYPES.rhythm.params);
  const lfo = addNode('lfo', 780, 60, NODE_TYPES.lfo.params);

  const crush = addNode('crush', 60, 460, NODE_TYPES.crush.params);
  const ring = addNode('ring', 300, 460, NODE_TYPES.ring.params);
  const drive = addNode('distortion', 540, 460, NODE_TYPES.distortion.params);
  const field = addNode('field', 780, 460, NODE_TYPES.field.params);

  const freeze = addNode('freeze', 60, 860, NODE_TYPES.freeze.params);
  const comb = addNode('comb', 300, 860, NODE_TYPES.comb.params);
  const shimmer = addNode('shimmer', 540, 860, NODE_TYPES.shimmer.params);
  const space = addNode('reverb', 780, 860, NODE_TYPES.reverb.params);

  const output = addNode('output', 400, 1260, NODE_TYPES.output.params);

  roles = { tone, tone2, rhythm, lfo, crush, ring, drive, field, freeze, comb, shimmer, space, output };

  addEdge(tone, 'out', crush, 'in');
  addEdge(crush, 'out', comb, 'in');
  addEdge(comb, 'out', space, 'in');
  addEdge(space, 'out', output, 'in');
  addEdge(tone, 'out', ring, 'in');
  addEdge(ring, 'out', field, 'in');
  addEdge(field, 'out', output, 'in');
  addEdge(rhythm, 'out', output, 'in');
  addEdge(tone2, 'out', freeze, 'in');
  addEdge(freeze, 'out', output, 'in');
  addEdge(tone2, 'out', drive, 'in');
  addEdge(drive, 'out', shimmer, 'in');
  addEdge(shimmer, 'out', output, 'in');
  // LFO is left unpatched, same as the reference — a CV source sitting ready
  // to be dragged onto any `_mod` jack during a set, not part of the fixed chain.

  applyPreset(roles, PRESETS[0].params, PRESETS[0].bypass);
}

async function onGenerate() {
  if (![...state.nodes.values()].some((n) => n.typeId === 'output')) {
    toast('Добавьте ноду Output, чтобы запустить осцилляцию', true);
    return;
  }
  btnGenerate.disabled = true;
  try {
    await engine.start();
    btnStop.disabled = false;
    toast('Осцилляция запущена');
  } catch (err) {
    console.error(err);
    toast('Не удалось запустить аудио: ' + err.message, true);
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
  toast('Ручки перемешаны');
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
    toast('Патч загружен');
  } catch (err) {
    toast('Ошибка загрузки файла: ' + err.message, true);
  }
  fileImport.value = '';
});
btnClear.addEventListener('click', () => {
  if (confirm('Очистить весь патч?')) {
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
