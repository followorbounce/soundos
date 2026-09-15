import { engine } from './audio/engine.js';

const panel = document.getElementById('keyboard-panel');
const piano = document.getElementById('piano');
const octaveLabel = document.getElementById('kb-octave');

// Standard "computer keyboard as piano" layout, two rows not needed — one
// chromatic row is enough to reach a full octave plus a few extra notes.
const KEY_MAP = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j', 'k'];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B', 'C'];

let octave = 4;
const pressed = new Set();

function midiFor(index) {
  // index 0..12 across KEY_MAP, C of `octave` = MIDI 12*(octave+1)
  return 12 * (octave + 1) + index;
}
function freqFromMidi(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function keyDown(index) {
  const noteKey = `k${index}`;
  if (pressed.has(noteKey)) return;
  pressed.add(noteKey);
  const midi = midiFor(index);
  engine.noteOn(noteKey, freqFromMidi(midi));
  updateKeyVisual(index, true);
}
function keyUp(index) {
  const noteKey = `k${index}`;
  pressed.delete(noteKey);
  engine.noteOff(noteKey);
  updateKeyVisual(index, false);
}

function updateKeyVisual(index, active) {
  const el = piano.querySelector(`[data-idx="${index}"]`);
  if (el) el.classList.toggle('active', active);
}

function buildPiano() {
  piano.innerHTML = '';
  NOTE_NAMES.forEach((name, i) => {
    const key = document.createElement('div');
    key.className = 'pkey' + (name.includes('#') ? ' black' : '');
    key.dataset.idx = i;
    key.title = `${name}${octave}`;
    key.addEventListener('pointerdown', (e) => { e.preventDefault(); keyDown(i); });
    key.addEventListener('pointerup', () => keyUp(i));
    key.addEventListener('pointerleave', () => keyUp(i));
    piano.appendChild(key);
  });
}

window.addEventListener('keydown', (e) => {
  if (panel.hidden) return;
  if (document.activeElement && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return;
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 'z') { octave = Math.max(0, octave - 1); octaveLabel.textContent = `Октава: ${octave}`; return; }
  if (k === 'x') { octave = Math.min(8, octave + 1); octaveLabel.textContent = `Октава: ${octave}`; return; }
  const idx = KEY_MAP.indexOf(k);
  if (idx >= 0) keyDown(idx);
});
window.addEventListener('keyup', (e) => {
  const idx = KEY_MAP.indexOf(e.key.toLowerCase());
  if (idx >= 0) keyUp(idx);
});

export function showKeyboard() {
  buildPiano();
  octaveLabel.textContent = `Октава: ${octave}`;
  panel.hidden = false;
}
export function hideKeyboard() {
  panel.hidden = true;
  pressed.clear();
}
