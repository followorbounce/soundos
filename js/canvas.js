import { NODE_TYPES, CATEGORY } from './nodeLibrary.js';
import { state, onChange, moveNode, removeNode, setParam, addEdge, removeEdge } from './state.js';
import { engine } from './audio/engine.js';

const viewport = document.getElementById('canvas-viewport');
const inner = document.getElementById('canvas-inner');
const nodesLayer = document.getElementById('nodes-layer');
const svg = document.getElementById('wires-svg');

const nodeEls = new Map(); // id -> element
let dragState = null; // node drag
let wireDraft = null; // {fromNodeId, fromPort, x1, y1}
let panState = null;
let selectedId = null;

export function screenToInner(clientX, clientY) {
  const r = inner.getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}

export function currentViewportCell() {
  return { scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop, w: viewport.clientWidth, h: viewport.clientHeight };
}

function portEl(nodeId, portId, dir) {
  return nodesLayer.querySelector(`.node[data-id="${nodeId}"] .port-dot[data-port="${portId}"][data-dir="${dir}"]`);
}

function portPos(nodeId, portId, dir) {
  const el = portEl(nodeId, portId, dir);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const innerR = inner.getBoundingClientRect();
  return { x: r.left + r.width / 2 - innerR.left, y: r.top + r.height / 2 - innerR.top };
}

function bezier(x1, y1, x2, y2) {
  const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function renderWires() {
  svg.innerHTML = '';
  for (const edge of state.edges.values()) {
    const p1 = portPos(edge.from.nodeId, edge.from.port, 'out');
    const p2 = portPos(edge.to.nodeId, edge.to.port, 'in');
    if (!p1 || !p2) continue;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', bezier(p1.x, p1.y, p2.x, p2.y));
    path.setAttribute('stroke', '#52d3a0');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('fill', 'none');
    path.setAttribute('opacity', '0.85');
    path.addEventListener('click', (e) => {
      e.stopPropagation();
      removeEdge(edge.id);
    });
    svg.appendChild(path);
  }
  if (wireDraft) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', bezier(wireDraft.x1, wireDraft.y1, wireDraft.x2, wireDraft.y2));
    path.setAttribute('stroke', '#4f8bff');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-dasharray', '4 3');
    path.setAttribute('fill', 'none');
    svg.appendChild(path);
  }
}

function paramControl(nodeId, def, node) {
  const row = document.createElement('div');
  row.className = 'param-row';
  const label = document.createElement('label');
  label.textContent = def.label;
  row.appendChild(label);
  const val = node.params[def.name];

  if (def.type === 'select') {
    const sel = document.createElement('select');
    for (const opt of def.options) {
      const o = document.createElement('option');
      o.value = opt; o.textContent = opt;
      if (opt === val) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => onParamInput(nodeId, def.name, sel.value));
    row.appendChild(sel);
  } else if (def.type === 'bool') {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!val;
    cb.addEventListener('change', () => onParamInput(nodeId, def.name, cb.checked));
    row.appendChild(cb);
  } else {
    const range = document.createElement('input');
    range.type = 'range';
    range.min = def.min; range.max = def.max; range.step = def.step;
    range.value = val;
    const out = document.createElement('span');
    out.className = 'val';
    out.textContent = fmt(val);
    range.addEventListener('input', () => {
      const v = parseFloat(range.value);
      out.textContent = fmt(v);
      onParamInput(nodeId, def.name, v);
    });
    row.appendChild(range);
    row.appendChild(out);
  }
  return row;
}

function fmt(v) {
  if (typeof v !== 'number') return v;
  return Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100;
}

function onParamInput(nodeId, name, value) {
  setParam(nodeId, name, value);
  if (engine.isLive()) engine.updateParam(nodeId, name, value);
}

function renderNode(node) {
  const def = NODE_TYPES[node.typeId];
  if (!def) return;
  let el = nodeEls.get(node.id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'node';
    el.dataset.id = node.id;
    nodesLayer.appendChild(el);
    nodeEls.set(node.id, el);
  }
  el.style.left = node.x + 'px';
  el.style.top = node.y + 'px';
  el.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'node-header';
  header.style.background = CATEGORY[def.category].color;
  const title = document.createElement('span');
  title.textContent = def.label;
  header.appendChild(title);
  const del = document.createElement('button');
  del.className = 'node-del';
  del.textContent = '×';
  del.title = 'Удалить ноду';
  del.addEventListener('click', (e) => { e.stopPropagation(); removeNode(node.id); });
  header.appendChild(del);
  header.addEventListener('mousedown', (e) => startNodeDrag(e, node));
  el.appendChild(header);

  const ports = document.createElement('div');
  ports.className = 'node-ports';
  const colIn = document.createElement('div');
  colIn.className = 'port-col in';
  for (const p of def.inputs) {
    const row = document.createElement('div');
    row.className = 'port-row';
    const dot = document.createElement('div');
    dot.className = `port-dot kind-${p.kind}`;
    dot.dataset.node = node.id; dot.dataset.port = p.id; dot.dataset.dir = 'in';
    dot.addEventListener('mouseup', (e) => finishWire(node.id, p.id));
    row.appendChild(dot);
    const lbl = document.createElement('span');
    lbl.textContent = p.label;
    row.appendChild(lbl);
    colIn.appendChild(row);
  }
  const colOut = document.createElement('div');
  colOut.className = 'port-col out';
  for (const p of def.outputs) {
    const row = document.createElement('div');
    row.className = 'port-row';
    const dot = document.createElement('div');
    dot.className = 'port-dot kind-audio';
    dot.dataset.node = node.id; dot.dataset.port = p.id; dot.dataset.dir = 'out';
    dot.addEventListener('mousedown', (e) => startWire(e, node.id, p.id));
    const lbl = document.createElement('span');
    lbl.textContent = p.label;
    row.appendChild(lbl);
    row.appendChild(dot);
    colOut.appendChild(row);
  }
  ports.appendChild(colIn);
  ports.appendChild(colOut);
  el.appendChild(ports);

  const body = document.createElement('div');
  body.className = 'node-body';
  for (const p of def.params) body.appendChild(paramControl(node.id, p, node));
  if (def.id === 'envelope') {
    const btn = document.createElement('button');
    btn.className = 'btn node-test';
    btn.textContent = 'Test ▸';
    btn.addEventListener('mousedown', () => engine.isLive() && engine.voices.forEach((v) => v.instances.get(node.id)?.gateOn(engine.ctx.currentTime)));
    btn.addEventListener('mouseup', () => engine.isLive() && engine.voices.forEach((v) => v.instances.get(node.id)?.gateOff(engine.ctx.currentTime)));
    body.appendChild(btn);
  }
  el.appendChild(body);

  el.addEventListener('mousedown', () => selectNode(node.id));
}

function selectNode(id) {
  selectedId = id;
  for (const [nid, el] of nodeEls) el.classList.toggle('selected', nid === id);
}

function startNodeDrag(e, node) {
  e.preventDefault();
  e.stopPropagation();
  selectNode(node.id);
  const startX = e.clientX, startY = e.clientY;
  const origX = node.x, origY = node.y;
  dragState = { node, startX, startY, origX, origY };
  document.addEventListener('mousemove', onNodeDragMove);
  document.addEventListener('mouseup', onNodeDragEnd);
}
function onNodeDragMove(e) {
  if (!dragState) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  moveNode(dragState.node.id, Math.max(0, dragState.origX + dx), Math.max(0, dragState.origY + dy));
}
function onNodeDragEnd() {
  dragState = null;
  document.removeEventListener('mousemove', onNodeDragMove);
  document.removeEventListener('mouseup', onNodeDragEnd);
}

function startWire(e, nodeId, portId) {
  e.preventDefault();
  e.stopPropagation();
  const p = portPos(nodeId, portId, 'out');
  wireDraft = { fromNodeId: nodeId, fromPort: portId, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  document.addEventListener('mousemove', onWireMove);
  document.addEventListener('mouseup', cancelWire);
}
function onWireMove(e) {
  if (!wireDraft) return;
  const p = screenToInner(e.clientX, e.clientY);
  wireDraft.x2 = p.x; wireDraft.y2 = p.y;
  renderWires();
}
function finishWire(toNodeId, toPortId) {
  if (!wireDraft) return;
  addEdge(wireDraft.fromNodeId, wireDraft.fromPort, toNodeId, toPortId);
  cancelWire();
}
function cancelWire() {
  wireDraft = null;
  document.removeEventListener('mousemove', onWireMove);
  document.removeEventListener('mouseup', cancelWire);
  renderWires();
}

// Pan the canvas by dragging empty background.
viewport.addEventListener('mousedown', (e) => {
  // nodesLayer fully covers the canvas, so an "empty background" click
  // actually lands on it (or inner/svg) rather than the viewport itself.
  if (e.target !== viewport && e.target !== inner && e.target !== nodesLayer && e.target !== svg) return;
  panState = { startX: e.clientX, startY: e.clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop };
  selectNode(null);
});
document.addEventListener('mousemove', (e) => {
  if (!panState) return;
  viewport.scrollLeft = panState.scrollLeft - (e.clientX - panState.startX);
  viewport.scrollTop = panState.scrollTop - (e.clientY - panState.startY);
});
document.addEventListener('mouseup', () => { panState = null; });

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') {
    removeNode(selectedId);
    selectedId = null;
  }
});

function fullRender() {
  for (const id of [...nodeEls.keys()]) {
    if (!state.nodes.has(id)) { nodeEls.get(id).remove(); nodeEls.delete(id); }
  }
  for (const node of state.nodes.values()) renderNode(node);
  svg.setAttribute('width', inner.offsetWidth);
  svg.setAttribute('height', inner.offsetHeight);
  renderWires();
}

onChange((kind, payload) => {
  if (kind === 'param-change') return; // params re-render locally, no full redraw needed
  if (kind === 'node-move') {
    // Fast path: dragging fires on every mousemove, avoid rebuilding all DOM.
    const el = nodeEls.get(payload);
    const node = state.nodes.get(payload);
    if (el && node) {
      el.style.left = node.x + 'px';
      el.style.top = node.y + 'px';
      renderWires();
    }
    return;
  }
  fullRender();
});

export function initCanvas() {
  fullRender();
}
