import { state, loops, setLoop, onChange } from './state.js';

// Per-node "live taping": record every change made to one node's settings for
// up to MAX_RECORD_MS, then replay that gesture in a loop.
//
//  - Recording is driven off state.js's 'param-change' event, so it captures
//    every way a setting can move — knob drag, switch, select, Chance, preset
//    recall — without each control having to know about the recorder.
//  - A take stores the value each touched param had when recording started
//    (`initial`) plus timestamped changes (`events`). Every loop pass starts by
//    restoring `initial`, then replays the events — so the loop is
//    deterministic no matter where the knobs were left.
//  - Playback pushes values back through the canvas' own param path (via the
//    apply hook) so knobs, the audio engine and Video Output's resolution all
//    react exactly as if a hand had turned them. `applying` keeps those
//    replayed changes from being re-recorded.

export const MAX_RECORD_MS = 4000;
const MIN_LOOP_MS = 50;
const TICK_MS = 8;

const recording = new Map(); // nodeId -> {startedAt, initial, events, timer}
const playing = new Map(); // nodeId -> {startedAt, cycle, idx}
let applying = false;
let applyHook = null; // (nodeId, name, value) => void — provided by canvas.js
let statusHook = () => {}; // (nodeId) => void — canvas.js re-renders that node's buttons
let ticker = null;

export function setApplyHook(fn) { applyHook = fn; }
export function setStatusHook(fn) { statusHook = fn; }

export function getStatus(nodeId) {
  const loop = loops.get(nodeId);
  const rec = recording.get(nodeId);
  const play = playing.get(nodeId);
  return {
    recording: !!rec,
    playing: !!play,
    hasLoop: !!loop,
    startedAt: rec ? rec.startedAt : play ? play.startedAt : 0,
    // Length of the bar animation: the fixed cap while recording, the take's own length while looping.
    duration: rec ? MAX_RECORD_MS : loop ? loop.duration : 0,
  };
}

export function toggleRecord(nodeId) {
  if (recording.has(nodeId)) finishRecording(nodeId);
  else startRecording(nodeId);
}

export function togglePlay(nodeId) {
  if (playing.has(nodeId)) { stopPlaying(nodeId); return; }
  // Clicking Play mid-take ends the take and loops it straight away — the
  // natural "record it, then hear it" gesture with no extra click.
  if (recording.has(nodeId)) finishRecording(nodeId);
  startPlaying(nodeId);
}

function startRecording(nodeId) {
  const node = state.nodes.get(nodeId);
  if (!node) return;
  stopPlaying(nodeId); // replayed moves must not fight, or be mistaken for, the new take
  const rec = {
    startedAt: performance.now(),
    initial: { ...node.params },
    events: [],
    timer: setTimeout(() => finishRecording(nodeId), MAX_RECORD_MS),
  };
  recording.set(nodeId, rec);
  statusHook(nodeId);
}

// Returns true if a take was stored. A take with no changes in it is thrown
// away rather than overwriting the previous loop with an empty one.
function finishRecording(nodeId) {
  const rec = recording.get(nodeId);
  if (!rec) return false;
  clearTimeout(rec.timer);
  recording.delete(nodeId);
  let stored = false;
  if (rec.events.length && state.nodes.has(nodeId)) {
    const touched = new Set(rec.events.map((e) => e.name));
    const initial = {};
    for (const name of touched) initial[name] = rec.initial[name];
    const elapsed = Math.min(performance.now() - rec.startedAt, MAX_RECORD_MS);
    const duration = Math.max(MIN_LOOP_MS, elapsed, rec.events[rec.events.length - 1].t + 1);
    setLoop(nodeId, { duration, initial, events: rec.events });
    stored = true;
  }
  statusHook(nodeId);
  return stored;
}

function startPlaying(nodeId) {
  const loop = loops.get(nodeId);
  if (!loop || !state.nodes.has(nodeId)) return;
  playing.set(nodeId, { startedAt: performance.now(), cycle: 0, idx: 0 });
  applyInitial(nodeId, loop);
  ensureTicker();
  statusHook(nodeId);
}

function stopPlaying(nodeId) {
  if (!playing.delete(nodeId)) return;
  if (!playing.size && ticker) { clearInterval(ticker); ticker = null; }
  statusHook(nodeId);
}

function applyValue(nodeId, name, value) {
  if (!applyHook || !state.nodes.has(nodeId)) return;
  applying = true;
  try { applyHook(nodeId, name, value); } finally { applying = false; }
}

function applyInitial(nodeId, loop) {
  for (const [name, value] of Object.entries(loop.initial)) applyValue(nodeId, name, value);
}

function ensureTicker() {
  if (!ticker) ticker = setInterval(tick, TICK_MS);
}

function tick() {
  const now = performance.now();
  for (const [nodeId, p] of playing) {
    const loop = loops.get(nodeId);
    if (!loop || !state.nodes.has(nodeId)) { stopPlaying(nodeId); continue; }
    const elapsed = now - p.startedAt;
    const cycle = Math.floor(elapsed / loop.duration);
    const pos = elapsed - cycle * loop.duration;
    if (cycle !== p.cycle) {
      // Wrapped: restore the starting values and rewind. Any events left in the
      // tail of the old pass (at most one tick's worth) are skipped on purpose —
      // the restore would overwrite them immediately anyway.
      p.cycle = cycle;
      p.idx = 0;
      applyInitial(nodeId, loop);
    }
    while (p.idx < loop.events.length && loop.events[p.idx].t <= pos) {
      const ev = loop.events[p.idx++];
      applyValue(nodeId, ev.name, ev.value);
    }
  }
}

onChange((kind, payload) => {
  if (kind === 'param-change') {
    if (applying) return;
    const rec = recording.get(payload.id);
    if (rec) rec.events.push({ t: Math.round(performance.now() - rec.startedAt), name: payload.name, value: payload.value });
    return;
  }
  if (kind === 'node-remove' || kind === 'clear' || kind === 'load') {
    // Node gone, or its loop gone (import) — nothing left to record into / play.
    for (const id of [...recording.keys()]) {
      if (!state.nodes.has(id)) { clearTimeout(recording.get(id).timer); recording.delete(id); statusHook(id); }
    }
    for (const id of [...playing.keys()]) {
      if (!state.nodes.has(id) || !loops.has(id)) stopPlaying(id);
    }
  }
});
