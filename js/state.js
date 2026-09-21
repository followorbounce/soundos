// Central patch state: nodes + edges, framework-free, observable via a tiny pub/sub.

let idCounter = 1;
export function nextId(prefix) {
  return `${prefix}_${idCounter++}_${Math.random().toString(36).slice(2, 6)}`;
}

export const state = {
  nodes: new Map(), // id -> {id, typeId, x, y, params:{}}
  edges: new Map(), // id -> {id, from:{nodeId,port}, to:{nodeId,port}}
};

// Recorded parameter loops (see recorder.js), keyed by node id. Deliberately
// NOT part of the undo/redo snapshots: a loop is performance material, not
// patch structure, so Ctrl+Z after recording must not wipe the take. Loops
// for deleted nodes stay in the map (so undoing the delete brings the loop
// back) and are simply left out of serialize().
// Shape: {duration (ms), initial:{param:value}, events:[{t (ms), name, value}], start?, end?, layers?: [{duration, initial, events}] (overdubbed tracks, each looping on its own period)}
export const loops = new Map();

const listeners = new Set();
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(kind, payload) {
  for (const fn of listeners) fn(kind, payload);
}

// Undo/redo: a stack of full-state snapshots, not per-field diffs — simplest
// thing that can't go subtly wrong. addNode/removeNode/addEdge/removeEdge/
// clearAll checkpoint themselves, since each is already exactly one discrete
// user action. Continuous things — dragging a node, dragging a knob,
// randomizing, applying a preset — are NOT auto-checkpointed here (that would
// snapshot on every mousemove/every param in a batch); the code that starts
// that continuous gesture calls checkpoint() itself, once, before the first
// moveNode()/setParam() of the gesture.
const HISTORY_LIMIT = 100;
let history = [];
let future = [];

function snapshot() {
  return JSON.stringify(serializeGraph());
}

function restoreSnapshot(json) {
  const data = JSON.parse(json);
  state.nodes.clear();
  state.edges.clear();
  for (const n of data.nodes || []) state.nodes.set(n.id, n);
  for (const e of data.edges || []) state.edges.set(e.id, e);
  emit('load');
}

export function checkpoint() {
  history.push(snapshot());
  if (history.length > HISTORY_LIMIT) history.shift();
  future = [];
}

export function resetHistory() {
  history = [];
  future = [];
}

export function undo() {
  if (!history.length) return false;
  future.push(snapshot());
  restoreSnapshot(history.pop());
  return true;
}

export function redo() {
  if (!future.length) return false;
  history.push(snapshot());
  restoreSnapshot(future.pop());
  return true;
}

export function addNode(typeId, x, y, defParams) {
  checkpoint();
  const id = nextId('n');
  const params = {};
  for (const p of defParams) params[p.name] = p.default;
  state.nodes.set(id, { id, typeId, x, y, params, bypassed: false });
  emit('node-add', id);
  return id;
}

export function toggleBypass(id) {
  const n = state.nodes.get(id);
  if (!n) return;
  n.bypassed = !n.bypassed;
  emit('bypass-change', { id, bypassed: n.bypassed });
  return n.bypassed;
}

export function setBypassState(id, bypassed) {
  const n = state.nodes.get(id);
  if (!n || n.bypassed === bypassed) return;
  n.bypassed = bypassed;
  emit('bypass-change', { id, bypassed });
}

export function removeNode(id) {
  checkpoint();
  state.nodes.delete(id);
  for (const [eid, e] of state.edges) {
    if (e.from.nodeId === id || e.to.nodeId === id) state.edges.delete(eid);
  }
  emit('node-remove', id);
}

export function moveNode(id, x, y) {
  const n = state.nodes.get(id);
  if (!n) return;
  n.x = x;
  n.y = y;
  emit('node-move', id);
}

export function setParam(id, name, value) {
  const n = state.nodes.get(id);
  if (!n) return;
  n.params[name] = value;
  emit('param-change', { id, name, value });
}

export function addEdge(fromNodeId, fromPort, toNodeId, toPort) {
  if (fromNodeId === toNodeId) return null;
  // avoid exact duplicate edges
  for (const e of state.edges.values()) {
    if (
      e.from.nodeId === fromNodeId &&
      e.from.port === fromPort &&
      e.to.nodeId === toNodeId &&
      e.to.port === toPort
    )
      return null;
  }
  checkpoint();
  const id = nextId('e');
  state.edges.set(id, { id, from: { nodeId: fromNodeId, port: fromPort }, to: { nodeId: toNodeId, port: toPort } });
  emit('edge-add', id);
  return id;
}

export function removeEdge(id) {
  checkpoint();
  state.edges.delete(id);
  emit('edge-remove', id);
}

export function clearAll() {
  checkpoint();
  state.nodes.clear();
  state.edges.clear();
  emit('clear');
}

export function setLoop(id, loop) {
  if (loop) loops.set(id, loop); else loops.delete(id);
  emit('loop-change', id);
}

function serializeGraph() {
  return {
    version: 1,
    nodes: [...state.nodes.values()],
    edges: [...state.edges.values()],
  };
}

export function serialize() {
  const data = serializeGraph();
  const saved = {};
  for (const [id, loop] of loops) if (state.nodes.has(id)) saved[id] = loop;
  if (Object.keys(saved).length) data.loops = saved;
  return data;
}

export function deserialize(data) {
  clearAll();
  loops.clear(); // an imported patch replaces the board, so it replaces the takes too
  for (const n of data.nodes || []) state.nodes.set(n.id, n);
  for (const e of data.edges || []) state.edges.set(e.id, e);
  for (const [id, loop] of Object.entries(data.loops || {})) {
    if (state.nodes.has(id) && loop && Array.isArray(loop.events) && loop.duration > 0) loops.set(id, loop);
  }
  emit('load');
}
