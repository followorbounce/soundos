import { state, loops, setLoop, onChange } from './state.js';

// Per-node "live taping": record every change made to one node's settings for
// up to MAX_RECORD_MS (a second click on Record stops it early), then replay
// that gesture in a loop.
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
//  - The node's on/off (bypass) state is recorded and replayed like any other
//    setting, under the pseudo-param name BYPASS_KEY (value: true = bypassed).
//  - A take can be trimmed: `start` / `end` (ms on the take's own timeline)
//    bound the part that loops. Each pass first restores the state the take
//    had at `start` (initial values + every event before it), so a trimmed
//    loop is as deterministic as a whole one.

export const MAX_RECORD_MS = 61000;
export const BYPASS_KEY = '__bypass';
const MIN_LOOP_MS = 50;
const TICK_MS = 8;

const recording = new Map(); // nodeId -> {startedAt, initial, events, timer}
const playing = new Map(); // nodeId -> {startedAt, cycle, idx, start, end}
let applying = false;
let applyHook = null; // (nodeId, name, value) => void — provided by canvas.js
let statusHook = () => {}; // (nodeId) => void — canvas.js re-renders that node's buttons
let ticker = null;

export function setApplyHook(fn) { applyHook = fn; }
export function setStatusHook(fn) { statusHook = fn; }

// The loop's active window, always valid: 0 <= start < end <= duration, at
// least MIN_LOOP_MS wide (imported/old takes may carry no trim at all).
export function loopBounds(loop) {
  const dur = loop.duration;
  const min = Math.min(MIN_LOOP_MS, dur);
  const start = Math.min(Math.max(0, Number.isFinite(loop.start) ? loop.start : 0), dur - min);
  const end = Math.min(dur, Math.max(start + min, Number.isFinite(loop.end) ? loop.end : dur));
  return { start, end };
}

export function getStatus(nodeId) {
  const loop = loops.get(nodeId);
  const rec = recording.get(nodeId);
  const play = playing.get(nodeId);
  const b = loop ? loopBounds(loop) : { start: 0, end: 0 };
  return {
    recording: !!rec,
    playing: !!play,
    hasLoop: !!loop,
    startedAt: rec ? rec.startedAt : play ? play.startedAt : 0,
    // Length of the bar animation: the fixed cap while recording, the trimmed window while looping.
    duration: rec ? MAX_RECORD_MS : loop ? b.end - b.start : 0,
    loopDuration: loop ? loop.duration : 0, // full take length (the trim handles' scale)
    trimStart: b.start,
    trimEnd: b.end,
  };
}

// Trim the looping window to [start, end] ms of the take. While playing, the
// pass restarts from the new start so the change is heard straight away.
export function setTrim(nodeId, start, end) {
  const loop = loops.get(nodeId);
  if (!loop) return;
  const b = loopBounds({ duration: loop.duration, start, end });
  const cur = loopBounds(loop);
  if (b.start === cur.start && b.end === cur.end) return;
  loop.start = b.start;
  loop.end = b.end;
  setLoop(nodeId, loop);
  if (playing.has(nodeId)) restartPlaying(nodeId, loop);
  statusHook(nodeId);
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
    initial: { ...node.params, [BYPASS_KEY]: !!node.bypassed },
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
  restartPlaying(nodeId, loop);
  ensureTicker();
  statusHook(nodeId);
}

// (Re)start a pass from the window's start: restore the take's state at that
// point and queue the events after it.
function restartPlaying(nodeId, loop) {
  const { start, end } = loopBounds(loop);
  const p = { startedAt: performance.now(), cycle: 0, idx: 0, start, end };
  playing.set(nodeId, p);
  beginPass(nodeId, loop, p);
}

function beginPass(nodeId, loop, p) {
  // State at the window's start = initial values + every event at or before it.
  const values = { ...loop.initial };
  let i = 0;
  while (i < loop.events.length && loop.events[i].t <= p.start) {
    values[loop.events[i].name] = loop.events[i].value;
    i++;
  }
  p.idx = i;
  for (const [name, value] of Object.entries(values)) applyValue(nodeId, name, value);
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

function ensureTicker() {
  if (!ticker) ticker = setInterval(tick, TICK_MS);
}

function tick() {
  const now = performance.now();
  for (const [nodeId, p] of playing) {
    const loop = loops.get(nodeId);
    if (!loop || !state.nodes.has(nodeId)) { stopPlaying(nodeId); continue; }
    const b = loopBounds(loop);
    if (b.start !== p.start || b.end !== p.end) { restartPlaying(nodeId, loop); continue; } // trimmed under us
    const elapsed = now - p.startedAt;
    const period = p.end - p.start;
    const cycle = Math.floor(elapsed / period);
    const pos = p.start + (elapsed - cycle * period); // position on the take's timeline
    if (cycle !== p.cycle) {
      // Wrapped: restore the state at the window's start and rewind. Any events
      // left in the tail of the old pass (at most one tick's worth) are skipped
      // on purpose — the restore would overwrite them immediately anyway.
      p.cycle = cycle;
      beginPass(nodeId, loop, p);
    }
    while (p.idx < loop.events.length && loop.events[p.idx].t <= pos) {
      const ev = loop.events[p.idx++];
      applyValue(nodeId, ev.name, ev.value);
    }
  }
}

onChange((kind, payload) => {
  if (kind === 'param-change' || kind === 'bypass-change') {
    if (applying) return;
    const rec = recording.get(payload.id);
    if (!rec) return;
    const t = Math.round(performance.now() - rec.startedAt);
    if (kind === 'bypass-change') rec.events.push({ t, name: BYPASS_KEY, value: !!payload.bypassed });
    else rec.events.push({ t, name: payload.name, value: payload.value });
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
