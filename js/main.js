import { initCanvas } from './canvas.js';
import { initMenu } from './menu.js';
import { state, addNode, addEdge, clearAll, setParam } from './state.js';
import { NODE_TYPES } from './nodeLibrary.js';
import { engine } from './audio/engine.js';
import { showKeyboard, hideKeyboard } from './keyboard.js';
import { exportPatch, importPatch } from './exporter.js';

const btnGenerate = document.getElementById('btn-generate');
const btnStop = document.getElementById('btn-stop');
const btnExport = document.getElementById('btn-export');
const btnImport = document.getElementById('btn-import');
const fileImport = document.getElementById('file-import');
const btnClear = document.getElementById('btn-clear');
const voiceCountInput = document.getElementById('voice-count');
const toastStack = document.getElementById('toast-stack');

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  toastStack.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function seedDemoPatch() {
  const osc = addNode('oscillator', 260, 120, NODE_TYPES.oscillator.params);
  const env = addNode('envelope', 260, 320, NODE_TYPES.envelope.params);
  const amp = addNode('amp', 480, 160, NODE_TYPES.amp.params);
  const lfo = addNode('lfo', 40, 420, NODE_TYPES.lfo.params);
  const math = addNode('math', 260, 480, NODE_TYPES.math.params);
  const filter = addNode('filter', 700, 160, NODE_TYPES.filter.params);
  const output = addNode('output', 920, 160, NODE_TYPES.output.params);

  addEdge(osc, 'out', amp, 'in');
  addEdge(env, 'out', amp, 'gain_mod');
  addEdge(amp, 'out', filter, 'in');
  addEdge(lfo, 'out', math, 'a');
  addEdge(math, 'out', filter, 'freq_mod');
  addEdge(filter, 'out', output, 'in');

  // Scale the raw ±1 LFO signal into a musically useful cutoff sweep
  // (the Math node's "amount"/"offset" knobs are exactly for this).
  setParam(math, 'amount', 700);
  setParam(math, 'offset', 200);
  // Amp's base gain stays at 0 so the envelope alone controls loudness per note.
  setParam(amp, 'gain', 0);
}

async function onGenerate() {
  if (![...state.nodes.values()].some((n) => n.typeId === 'output')) {
    toast('Добавьте ноду Output, чтобы сгенерировать синтезатор', true);
    return;
  }
  btnGenerate.disabled = true;
  try {
    const voices = parseInt(voiceCountInput.value, 10) || 6;
    await engine.start(voices);
    btnStop.disabled = false;
    showKeyboard();
    toast(`Синтезатор сгенерирован: ${voices} голосов`);
  } catch (err) {
    console.error(err);
    toast('Не удалось запустить аудио: ' + err.message, true);
  } finally {
    btnGenerate.disabled = false;
  }
}

async function onStop() {
  await engine.stop();
  hideKeyboard();
  btnStop.disabled = true;
}

voiceCountInput.addEventListener('change', () => {
  if (engine.isLive()) {
    engine.rebuild(parseInt(voiceCountInput.value, 10) || 6);
    toast('Полифония обновлена');
  }
});

btnGenerate.addEventListener('click', onGenerate);
btnStop.addEventListener('click', onStop);
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

initMenu();
initCanvas();
if (state.nodes.size === 0) seedDemoPatch();
