// Central patch state: nodes + edges, framework-free, observable via a tiny pub/sub.

let idCounter = 1;
export function nextId(prefix) {
  return `${prefix}_${idCounter++}_${Math.random().toString(36).slice(2, 6)}`;
}

export const state = {
  nodes: new Map(), // id -> {id, typeId, x, y, params:{}}
  edges: new Map(), // id -> {id, from:{nodeId,port}, to:{nodeId,port}}
};

const listeners = new Set();
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(kind, payload) {
  for (const fn of listeners) fn(kind, payload);
}

export function addNode(typeId, x, y, defParams) {
  const id = nextId('n');
  const params = {};
  for (const p of defParams) params[p.name] = p.default;
  state.nodes.set(id, { id, typeId, x, y, params });
  emit('node-add', id);
  return id;
}

export function removeNode(id) {
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
  const id = nextId('e');
  state.edges.set(id, { id, from: { nodeId: fromNodeId, port: fromPort }, to: { nodeId: toNodeId, port: toPort } });
  emit('edge-add', id);
  return id;
}

export function removeEdge(id) {
  state.edges.delete(id);
  emit('edge-remove', id);
}

export function clearAll() {
  state.nodes.clear();
  state.edges.clear();
  emit('clear');
}

export function serialize() {
  return {
    version: 1,
    nodes: [...state.nodes.values()],
    edges: [...state.edges.values()],
  };
}

export function deserialize(data) {
  clearAll();
  for (const n of data.nodes || []) state.nodes.set(n.id, n);
  for (const e of data.edges || []) state.edges.set(e.id, e);
  emit('load');
}
