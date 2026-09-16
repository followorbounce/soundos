import { NODE_TYPES, CATEGORY, nodeTypesByCategory } from './nodeLibrary.js';
import { addNode } from './state.js';
import { currentViewportCell, getZoom } from './canvas.js';

const menuEl = document.getElementById('node-menu');
const listEl = document.getElementById('menu-list');
const searchEl = document.getElementById('menu-search');
const closeBtn = document.getElementById('menu-close');
const addBtn = document.getElementById('btn-add-node');
const gridOverlay = document.getElementById('grid-overlay');

const isDesktop = () => window.matchMedia('(min-width: 900px)').matches && !('ontouchstart' in window);

function buildList(filter = '') {
  listEl.innerHTML = '';
  const groups = nodeTypesByCategory();
  for (const catId of ['generator', 'processor', 'video']) {
    const items = groups[catId].filter((t) => t.label.toLowerCase().includes(filter) || t.desc.toLowerCase().includes(filter));
    if (!items.length) continue;
    const section = document.createElement('div');
    section.className = 'menu-section';
    const title = document.createElement('div');
    title.className = 'menu-section-title';
    title.textContent = CATEGORY[catId].label;
    section.appendChild(title);
    for (const t of items) {
      const item = document.createElement('div');
      item.className = 'menu-item';
      const dot = document.createElement('span');
      dot.className = 'menu-item-dot';
      dot.style.background = t.color;
      const name = document.createElement('span');
      name.className = 'menu-item-name';
      name.textContent = t.label;
      const desc = document.createElement('span');
      desc.className = 'menu-item-desc';
      desc.textContent = t.desc;
      item.append(dot, name, desc);
      item.addEventListener('click', () => chooseType(t.id));
      section.appendChild(item);
    }
    listEl.appendChild(section);
  }
}

function chooseType(typeId) {
  closeMenu();
  if (isDesktop()) {
    openGridPlacer(typeId);
  } else {
    const { scrollLeft, scrollTop } = currentViewportCell();
    const zoom = getZoom();
    addNode(typeId, (scrollLeft + 40 + Math.random() * 60) / zoom, (scrollTop + 40 + Math.random() * 60) / zoom, NODE_TYPES[typeId].params);
  }
}

function openGridPlacer(typeId) {
  const cellW = 168, cellH = 130;
  const { scrollLeft, scrollTop, w, h } = currentViewportCell();
  // position:fixed + an explicit rect (not CSS inset) so the picker stays
  // pinned to the visible viewport even though it lives inside a scrolling
  // ancestor that may currently be panned away from its origin.
  const rect = document.getElementById('canvas-viewport').getBoundingClientRect();
  gridOverlay.style.left = rect.left + 'px';
  gridOverlay.style.top = rect.top + 'px';
  gridOverlay.style.width = rect.width + 'px';
  gridOverlay.style.height = rect.height + 'px';
  const cols = Math.max(2, Math.floor(w / cellW));
  const rows = Math.max(2, Math.floor(h / cellH));
  gridOverlay.innerHTML = '';
  gridOverlay.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  gridOverlay.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  const hint = document.createElement('div');
  hint.className = 'grid-hint';
  hint.textContent = `Выберите место: ${NODE_TYPES[typeId].label} — ряд × столбец (Esc для отмены)`;
  gridOverlay.appendChild(hint);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = document.createElement('div');
      cell.className = 'grid-cell';
      cell.textContent = `${r + 1}×${c + 1}`;
      cell.addEventListener('click', () => {
        const zoom = getZoom();
        const x = (scrollLeft + c * cellW + 16) / zoom;
        const y = (scrollTop + r * cellH + 16) / zoom;
        addNode(typeId, x, y, NODE_TYPES[typeId].params);
        closeGridPlacer();
      });
      gridOverlay.appendChild(cell);
    }
  }
  gridOverlay.hidden = false;
  document.addEventListener('keydown', escCloseGrid);
}
function escCloseGrid(e) {
  if (e.key === 'Escape') closeGridPlacer();
}
function closeGridPlacer() {
  gridOverlay.hidden = true;
  gridOverlay.innerHTML = '';
  document.removeEventListener('keydown', escCloseGrid);
}

function openMenu() {
  buildList(searchEl.value.trim().toLowerCase());
  menuEl.hidden = false;
  searchEl.focus();
}
function closeMenu() {
  menuEl.hidden = true;
}

addBtn.addEventListener('click', () => (menuEl.hidden ? openMenu() : closeMenu()));
closeBtn.addEventListener('click', closeMenu);
searchEl.addEventListener('input', () => buildList(searchEl.value.trim().toLowerCase()));

export function initMenu() {
  buildList();
}
