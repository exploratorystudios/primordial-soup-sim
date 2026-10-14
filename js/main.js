// Entry point: main loop and input handling.
import { World } from './world.js';
import { Renderer, NM_PER_UNIT, DIM } from './render.js';
import { UI } from './ui.js';
import { sel as mkSel, molecule, refine, fovFor } from './parts.js';

const SPEEDS = [0.25, 1, 2, 5, 10, 20, 50, 100, 250]; // ticks per frame
const $ = (id) => document.getElementById(id);

const canvas = $('world');
const renderer = new Renderer(canvas);
const ui = new UI();
const opts = { colorMode: 'troph', overlay: 'none', showChem: true, selected: null, flash: null };

const params = new URLSearchParams(location.search);
let seed = +params.get('seed') || Math.floor(Math.random() * 1e6) + 1;
$('seed').value = seed;
let world = new World(seed);
let running = true;
let speedIdx = 3;
let frame = 0;
let acc = 0;

function setSpeed(i) {
  speedIdx = i;
  $('speed').value = i;
  const s = SPEEDS[i];
  $('speed-val').textContent = s < 1 ? `${s}×/frame` : `${s}/frame`;
}
setSpeed(+params.get('speed') || speedIdx);

function newWorld(s) {
  seed = s;
  world = new World(seed);
  ui.reset();
  opts.selected = null;
  history.replaceState(null, '', `?seed=${seed}`);
}

function loop() {
  frame++;
  if (running) {
    acc += SPEEDS[speedIdx];
    const t0 = performance.now();
    // Stay responsive: never spend more than ~30 ms simulating per frame.
    while (acc >= 1 && performance.now() - t0 < 30) { world.step(); acc--; }
    if (acc > 1) acc = 0;
  }
  const sel = ui.selected;
  if (sel) trackSelection(sel);
  opts.selected = sel && !sel.gone ? sel.obj : null;
  if (sel && sel.follow && !sel.gone) { renderer.cam.x = sel.obj.x; renderer.cam.y = sel.obj.y; }
  if (opts.flash) { opts.flash.a -= 0.02; if (opts.flash.a <= 0) opts.flash = null; }
  renderer.draw(world, opts);
  ui.update(world, frame);
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- controls
$('btn-play').onclick = () => { running = !running; $('btn-play').textContent = running ? 'Pause' : 'Play'; };
$('btn-step').onclick = () => { world.step(); };
$('btn-fit').onclick = () => { renderer.fit(); if (ui.selected) ui.selected.follow = false; };
// Zoom presets: jump to a physical field of view, centred on the selection if there is one.
for (const b of document.querySelectorAll('[data-fov]')) {
  b.onclick = () => {
    const fov = +b.dataset.fov;
    if (!fov) { $('btn-fit').click(); return; }
    renderer.setFieldWidthNm(fov);
    const sel = ui.selected;
    if (sel && !sel.gone) { sel.follow = true; renderer.cam.x = sel.obj.x; renderer.cam.y = sel.obj.y; }
  };
}
$('speed').oninput = (e) => setSpeed(+e.target.value);
$('btn-new').onclick = () => newWorld(Math.max(1, +$('seed').value || 1));
$('seed').onkeydown = (e) => { if (e.key === 'Enter') $('btn-new').click(); };
$('color-mode').onchange = (e) => { opts.colorMode = e.target.value; };
$('overlay').onchange = (e) => { opts.overlay = e.target.value; };
$('show-chem').onchange = (e) => { opts.showChem = e.target.checked; };
$('ev-meteor').onclick = () => { const p = world.meteor(); opts.flash = { x: p.x, y: p.y, a: 1 }; };
$('ev-snowball').onclick = () => world.snowball();
$('ev-volcano').onclick = () => world.volcano();
$('btn-tree').onclick = () => { $('tree-modal').hidden = false; ui.drawTree(world); };
$('tree-close').onclick = () => { $('tree-modal').hidden = true; };
$('tree-modal').onclick = (e) => { if (e.target.id === 'tree-modal') $('tree-modal').hidden = true; };

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); $('btn-play').click(); }
  else if (e.key === 'Escape') { $('tree-modal').hidden = true; ui.select(world, null); }
  else if (e.key === '+' || e.key === '=') setSpeed(Math.min(SPEEDS.length - 1, speedIdx + 1));
  else if (e.key === '-') setSpeed(Math.max(0, speedIdx - 1));
});

window.addEventListener('resize', () => renderer.resize());

// --------------------------------------------------------- camera & picking
let drag = null;
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const f = Math.exp(-e.deltaY * 0.0015);
  // While following something, zoom straight into it.
  if (ui.selected && ui.selected.follow && !ui.selected.gone) renderer.zoomAt(r.width / 2, r.height / 2, f);
  else renderer.zoomAt(e.clientX - r.left, e.clientY - r.top, f);
}, { passive: false });

canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, moved: 0 };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  if (drag.moved > 4) {
    canvas.classList.add('dragging');
    renderer.pan(dx, dy);
    if (ui.selected) ui.selected.follow = false;
  }
  drag.x = e.clientX; drag.y = e.clientY;
});
canvas.addEventListener('pointerup', (e) => {
  canvas.classList.remove('dragging');
  if (drag && drag.moved <= 4) {
    const r = canvas.getBoundingClientRect();
    pick(renderer.screenToWorld(e.clientX - r.left, e.clientY - r.top));
  }
  drag = null;
});
canvas.addEventListener('dblclick', () => { if (ui.selected && ui.selected.kind === 'cell') ui.selected.follow = true; });

// Keep the selection's position current; molecules and polymers can vanish into other structures.
function trackSelection(sel) {
  const soup = world.soup;
  for (let q = sel; q; q = q.parent) {
    if (!q.st) continue; // a free molecule from the soup: find it again by its stable id
    const i = soup.indexOfMid(q.st.mid);
    if (i < 0) q.st.gone = true;
    else { q.st.x = soup.mx[i]; q.st.y = soup.my[i]; }
  }
  sel.gone = !!sel.obj.dead;
}

// Select a part from the inspector and fly the camera to it at a fitting magnification.
function focus(s) {
  if (s.kind === 'polymer') s.obj._rad = polymerRadius(s.obj);
  ui.select(world, s);
  s.follow = true;
  renderer.setFieldWidthNm(fovFor(s));
  if (!s.obj.dead) { renderer.cam.x = s.obj.x; renderer.cam.y = s.obj.y; }
}
ui.onPick = focus;
ui.renderer = renderer;

// Pick the smallest object under the cursor, so you can click into a protocell to grab its RNA.
function pick(p) {
  const tol = (10 * renderer.dpr) / renderer.ppu;
  const soup = world.soup;
  let best = null, bestR = Infinity, bestD = Infinity;
  const consider = (kind, obj, r, extra) => {
    const d = Math.hypot(obj.x - p.x, obj.y - p.y);
    if (d > r + tol) return;
    if (r < bestR || (r === bestR && d < bestD)) { bestR = r; bestD = d; best = { kind, obj, follow: renderer.cam.zoom > 3, ...extra }; }
  };
  for (const c of world.life.cells) consider('cell', c, c.r);
  if (opts.showChem) {
    for (const v of soup.vesicles) {
      consider('vesicle', v, v.r);
      for (const q of v.polys) if (q._fx !== undefined) consider('polymer', q, polymerRadius(q), { parent: mkSel('vesicle', v) });
    }
    for (const q of soup.polymers) consider('polymer', q, polymerRadius(q));
    for (let i = 0; i < soup.n; i++) {
      const dx = soup.mx[i] - p.x, dy = soup.my[i] - p.y;
      if (Math.abs(dx) > tol || Math.abs(dy) > tol) continue;
      consider('monomer', { x: soup.mx[i], y: soup.my[i] }, 1 / NM_PER_UNIT, { mid: soup.mid[i], t: soup.mt[i] });
    }
  }
  if (best && best.kind === 'monomer') {
    const st = { mid: best.mid, x: best.obj.x, y: best.obj.y, ang: (best.mid * 2.399) % (Math.PI * 2), gone: false };
    best = molecule(best.t, () => st, () => st.gone, null, { st });
  }
  if (best && best.kind === 'polymer') best.obj._rad = polymerRadius(best.obj);
  // Zoomed in? Resolve the click to the deepest visible part (organelle, ribosome, lipid, nucleotide, atom group).
  if (best) best = refine(best, p, tol, world, renderer);
  if (best) best.follow = renderer.cam.zoom > 3;
  ui.select(world, best);
}

function polymerRadius(q) { return (q.seq.length * DIM.ntRise) / 2 / NM_PER_UNIT; }

// Console handle for tinkering, e.g. soup.world.life.cells.length
window.soup = { get world() { return world; }, renderer, ui, opts, draw: () => { renderer.draw(world, opts); ui.update(world, 0); } };

requestAnimationFrame(loop);
