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
//  - Overdub: pressing Record on a node that already has a take does not start
//    from scratch. The saved take plays while you record. A setting the take
//    never touched gets a new parallel track merged into it; a setting the take
//    already holds is taken over the moment you move it — its old track goes
//    silent for the rest of the recording and is replaced by what you play. New
//    moves are stamped on the take's own timeline (position within the looping
//    window), so the old and new tracks stay in step; if you keep recording past
//    one pass, a setting's track is whatever you played during the last pass in
//    which you touched it.

export const MAX_RECORD_MS = 61000;
export const BYPASS_KEY = '__bypass';
const MIN_LOOP_MS = 50;
const TICK_MS = 8;

const recording = new Map(); // nodeId -> {startedAt, initial, events, timer, base?, start, end, cur, tracks, muted}
const playing = new Map(); // nodeId -> {startedAt, cycle, idx, start, end, muted?}
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
    overdub: !!(rec && rec.base), // recording on top of the saved take (which keeps playing)
    playing: !!play,
    hasLoop: !!loop,
    startedAt: rec ? rec.startedAt : play ? play.startedAt : 0,
    // Length of the bar animation: the fixed cap while recording fresh, the trimmed window while looping/overdubbing.
    duration: rec && !rec.base ? MAX_RECORD_MS : loop ? b.end - b.start : 0,
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
  if (playing.has(nodeId)) restartPlaying(nodeId, loop, playing.get(nodeId).muted);
  statusHook(nodeId);
}

export function toggleRecord(nodeId) {
  if (recording.has(nodeId)) finishRecording(nodeId);
  else startRecording(nodeId);
}

export function togglePlay(nodeId) {
  // Clicking Play mid-take ends the take and loops it straight away — the
  // natural "record it, then hear it" gesture with no extra click. (An overdub
  // is already looping; finishing it leaves it playing.)
  if (recording.has(nodeId)) {
    finishRecording(nodeId);
    if (!playing.has(nodeId)) startPlaying(nodeId);
    return;
  }
  if (playing.has(nodeId)) { stopPlaying(nodeId); return; }
  startPlaying(nodeId);
}

// Forget every recording in every node: abandons takes in progress, stops all
// loops and empties the loop memory. Returns how many stored loops were dropped.
export function clearAllRecordings() {
  const ids = new Set([...loops.keys(), ...recording.keys(), ...playing.keys()]);
  const dropped = loops.size;
  for (const id of [...recording.keys()]) { clearTimeout(recording.get(id).timer); recording.delete(id); }
  for (const id of [...playing.keys()]) stopPlaying(id);
  for (const id of [...loops.keys()]) setLoop(id, null);
  for (const id of ids) statusHook(id);
  return dropped;
}

function startRecording(nodeId) {
  const node = state.nodes.get(nodeId);
  if (!node) return;
  const base = loops.get(nodeId) || null;
  const rec = {
    startedAt: performance.now(),
    initial: null,
    events: [],
    timer: setTimeout(() => finishRecording(nodeId), MAX_RECORD_MS),
    base, // overdub target, or null for a fresh take
    start: 0, end: 0, // the looping window overdubbed moves are stamped into
    cur: null, // overdub: latest value seen per setting
    tracks: new Map(), // overdub: setting -> {cycle, initial, events} (its latest pass)
    muted: new Set(), // overdub: settings the user has taken over from the saved take
  };
  if (base) {
    // Overdub: play the saved take from the top of its window and stamp new
    // moves on its timeline. Snapshot the starting values AFTER the pass has
    // restored the take's state, so a taken-over setting starts where the take did.
    recording.set(nodeId, rec);
    restartPlaying(nodeId, base, rec.muted);
    const p = playing.get(nodeId);
    rec.startedAt = p.startedAt;
    rec.start = p.start;
    rec.end = p.end;
  } else {
    stopPlaying(nodeId); // replayed moves must not fight, or be mistaken for, the new take
  }
  rec.initial = { ...node.params, [BYPASS_KEY]: !!node.bypassed };
  rec.cur = { ...rec.initial };
  recording.set(nodeId, rec);
  if (base) ensureTicker();
  statusHook(nodeId);
}

// Fold an overdub's tracks into the saved take: each recorded setting's old
// events are replaced by the new ones (untouched settings keep theirs), then
// the events are put back in time order (stable, so ties keep insertion order).
function mergeOverdub(rec) {
  const base = rec.base;
  const names = new Set(rec.tracks.keys());
  const initial = { ...base.initial };
  const events = base.events.filter((e) => !names.has(e.name));
  for (const [name, tr] of rec.tracks) {
    initial[name] = tr.initial;
    events.push(...tr.events);
  }
  events.sort((a, b) => a.t - b.t);
  return { ...base, initial, events };
}

// Returns true if a take was stored. A take with no changes in it is thrown
// away rather than overwriting the previous loop with an empty one.
function finishRecording(nodeId) {
  const rec = recording.get(nodeId);
  if (!rec) return false;
  clearTimeout(rec.timer);
  recording.delete(nodeId);
  let stored = false;
  if (rec.base) {
    if (rec.tracks.size && state.nodes.has(nodeId) && loops.get(nodeId) === rec.base) {
      setLoop(nodeId, mergeOverdub(rec));
      stored = true;
    }
    // The take was playing throughout; carry on with the merged take from the top.
    const loop = loops.get(nodeId);
    if (loop && state.nodes.has(nodeId)) { restartPlaying(nodeId, loop); ensureTicker(); }
    statusHook(nodeId);
    return stored;
  }
  if (rec.events.length && state.nodes.has(nodeId)) {
    const touched = new Set(rec.events.map((e) => e.name));
    const initial = {};
    for (const name of touched) initial[name] = rec.initial[name];
    // The node's on/off position at the start is always part of a take, even if
    // the switch was never touched — every pass restores it.
    initial[BYPASS_KEY] = rec.initial[BYPASS_KEY];
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
function restartPlaying(nodeId, loop, muted = null) {
  const { start, end } = loopBounds(loop);
  const p = { startedAt: performance.now(), cycle: 0, idx: 0, start, end, muted };
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
  for (const [name, value] of Object.entries(values)) {
    if (!p.muted || !p.muted.has(name)) applyValue(nodeId, name, value);
  }
}

// Stop every playing loop (a preset recall re-tunes the whole board, so loops
// must not keep fighting it).
export function stopAllPlaying() {
  for (const id of [...playing.keys()]) stopPlaying(id);
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
    if (b.start !== p.start || b.end !== p.end) { restartPlaying(nodeId, loop, p.muted); continue; } // trimmed under us
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
      if (!p.muted || !p.muted.has(ev.name)) applyValue(nodeId, ev.name, ev.value);
    }
  }
}

// Overdub move: stamp it at its position within the looping window and file it
// under its setting's track. The first move of a saved setting mutes that
// setting's old track for the rest of the recording (the user has taken over).
function recordOverdubMove(rec, name, value) {
  const period = rec.end - rec.start;
  const elapsed = performance.now() - rec.startedAt;
  const cycle = Math.floor(elapsed / period);
  const t = Math.round(rec.start + (elapsed - cycle * period));
  rec.muted.add(name);
  let tr = rec.tracks.get(name);
  if (!tr || tr.cycle !== cycle) {
    tr = { cycle, initial: rec.cur[name], events: [] }; // a later pass replaces the earlier one
    rec.tracks.set(name, tr);
  }
  tr.events.push({ t, name, value });
  rec.cur[name] = value;
}

onChange((kind, payload) => {
  if (kind === 'param-change' || kind === 'bypass-change') {
    if (applying) return;
    const rec = recording.get(payload.id);
    if (!rec) return;
    const name = kind === 'bypass-change' ? BYPASS_KEY : payload.name;
    const value = kind === 'bypass-change' ? !!payload.bypassed : payload.value;
    if (rec.base) { recordOverdubMove(rec, name, value); return; }
    rec.events.push({ t: Math.round(performance.now() - rec.startedAt), name, value });
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
