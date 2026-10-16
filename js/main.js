// Entry point: main loop and input handling.
import { World } from './world.js';
import { CFG } from './config.js';
import { Renderer, NM_PER_UNIT, DIM } from './render.js';
import { UI } from './ui.js';
import { fovFor, centreOf, topLevelAt, childAt, contains, ancestors, sel as mkSel, crumbLabel, children, organismOf, molecule } from './parts.js';
import { Cell } from './life.js';
import { Story } from './story.js';
import { Rewind } from './rewind.js';
import { saveToFile, loadFromFile } from './persist.js';
import { detectLive, LiveFeed, FULL_EVERY } from './live.js';

// Ticks per frame. Below 1 the view interpolates between ticks. Max runs the simulation as fast as
// the CPU allows, giving it most of each frame (a choppier view in exchange for more ticks).
const SPEEDS = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 250];
const $ = (id) => document.getElementById(id);

const canvas = $('world');
const renderer = new Renderer(canvas);
const ui = new UI();
const opts = { colorMode: 'troph', overlay: 'none', showChem: true, selected: null, flash: null };

const params = new URLSearchParams(location.search);
// Experiments from the address bar: ?cfg={"DAY_SWING":0} overrides any setting in config.js, and
// ?day=always is a shortcut for constant noon sunlight. They stay in the URL (and apply to new worlds
// and the tour) until removed.
const cfgOverrides = {};
try { Object.assign(cfgOverrides, JSON.parse(params.get('cfg') || '{}')); } catch { /* ignore a malformed cfg */ }
if (params.get('day') === 'always') Object.assign(cfgOverrides, { DAY_MEAN: 1, DAY_SWING: 0 });
Object.assign(CFG, cfgOverrides);
let extraParams = [...params].filter(([k]) => k === 'cfg' || k === 'day').map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');
const urlFor = (s) => `?seed=${s}${extraParams}`;
let seed = +params.get('seed') || Math.floor(Math.random() * 1e6) + 1;
$('seed').value = seed;
let world = new World(seed);
let running = true;
let speedIdx = SPEEDS.indexOf(5);
let maxOn = false; // the Max toggle: as fast as the CPU allows (the slider keeps its setting for when it's off)
const curSpeed = () => (maxOn ? Infinity : SPEEDS[speedIdx]);
let frame = 0;
let live = null; // a LiveFeed while watching a world that runs on the server (see live.js)
let acc = 0;
let alpha = 1; // how far between the previous and current tick to draw (smoothing at slow speeds)

// The slider setting nearest to v ticks per frame.
const speedIndexOf = (v) => SPEEDS.reduce((b, s, i) => (Math.abs(Math.log(s / v)) < Math.abs(Math.log(SPEEDS[b] / v)) ? i : b), 0);
// Milliseconds of simulation allowed per frame: 30 keeps the view smooth.
const simBudget = (s) => (s <= 20 ? 30 : s <= 250 ? 45 : 90);
let tpsTicks = 0, tpsSince = performance.now(), tps = 0;
// True while a mouse button is held anywhere on the page (sliders, buttons, the view).
let interacting = false;
window.addEventListener('pointerdown', () => { interacting = true; }, true);
for (const ev of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(ev, () => { interacting = false; }, true);

function setSpeed(i) {
  speedIdx = Math.max(0, Math.min(SPEEDS.length - 1, i));
  $('speed').value = speedIdx;
  speedLabel();
}
function speedLabel() {
  if (live) {
    const el = $('speed-val'), rate = Math.round(live.tps).toLocaleString();
    el.textContent = `live · ${rate}/s`;
    el.title = `Watching the world running on the server, at about ${rate} ticks per second`;
    return;
  }
  const s = curSpeed();
  $('btn-max').classList.toggle('active', maxOn);
  const set = s === Infinity ? 'max' : s < 1 ? `1 tick/${Math.round(1 / s)} fr` : `${s}/frame`;
  // When the setting is more than the CPU can do, say what it actually achieves. (Kept to one line of
  // fixed width: if the label wrapped, the buttons below jumped and clicks on them could miss.)
  const capped = s >= 1 && running && tps && tps < s * 50;
  const el = $('speed-val'), rate = Math.round(tps).toLocaleString();
  el.textContent = capped ? `${set} · ${rate}/s` : set;
  el.title = s === Infinity ? `As fast as possible: ≈${rate} ticks per second` : s < 1 ? `One tick every ${Math.round(1 / s)} frames` : `${s} ticks per frame${capped ? `; the CPU manages ≈${rate} ticks per second` : ''}`;
}
// ?speed= in ticks per frame (0.01 … 250, or max).
function setMax(on) { maxOn = on; speedLabel(); }
if (params.get('speed') === 'max') { maxOn = true; setSpeed(speedIdx); }
else setSpeed(params.has('speed') ? speedIndexOf(+params.get('speed') || SPEEDS[0]) : speedIdx);
$('scale-note').textContent = `Everything is drawn at true size (habitat ${(CFG.W / 2000).toFixed(1)} × ${(CFG.H / 2000).toFixed(1)} mm). Select something first and the preset zooms into it.`;
function showCfgNote(from) {
  document.querySelector('.cfg-note')?.remove();
  if (!Object.keys(cfgOverrides).length) return;
  const what = params.get('day') === 'always' && from === 'the address bar' ? 'always daytime (full sun)' : JSON.stringify(cfgOverrides);
  const note = document.createElement('p');
  note.className = 'cfg-note';
  note.textContent = `Custom settings (from ${from}): ${what}. Remove them from the URL to go back to normal.`;
  $('scale-note').after(note);
}
showCfgNote('the address bar');

function newWorld(s) {
  if (typeof story !== 'undefined') story.stop();
  stopRewind(); rewind.clear();
  seed = s;
  $('seed').value = seed;
  world = new World(seed);
  ui.reset();
  opts.selected = null;
  history.replaceState(null, '', urlFor(seed));
}

let seeking = null; // { from: milestone count, start: tick } while jumping to the next milestone
const rewind = new Rewind();
let rewinding = null; // { t: the tick being shown (fractional), spec: what was selected, fresh } while playing backwards
let lastNow = performance.now();
// The tour (story mode) swaps in replayed worlds and drives the clock, but leaves the camera free.
const story = new Story({
  cfg: cfgOverrides,
  get world() { return world; },
  get running() { return running; },
  opts,
  ui,
  renderer,
  setWorld(w) { stopRewind(); rewind.clear(); world = w; ui.reset(); ui.seenLogs = w.logs.length; opts.selected = null; flight = null; acc = 0; alpha = 1; },
  setRunning(b) { running = b; playLabel(); },
  setSpeed: (v) => { maxOn = false; setSpeed(speedIndexOf(v)); }, // (each tour chapter plays at its own speed)
  setOverlay(o) { opts.overlay = o; $('overlay').value = o; },
  follow: storyFollow,
});

function loop() {
  frameStep();
  requestAnimationFrame(loop);
}

function frameStep() {
  frame++;
  const now = performance.now(), dt = Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;
  if (live) {
    // Watching the server's world: draw it gliding from the previous frame to the latest one.
    alpha = live.alpha(now);
    world.smooth = true;
  } else if (seeking) {
    // Full speed (within the frame budget) until something new happens.
    const t0 = performance.now();
    while (performance.now() - t0 < 40) {
      world.step();
      if (world.milestones.length > seeking.from || world.t - seeking.start > 400000) { stopSeek(); break; }
    }
    alpha = 1;
    rewind.record(world, performance.now() - t0);
    if (seeking) $('btn-seek').textContent = `⏭ Seeking… tick ${world.t.toLocaleString()}`;
  } else if (rewinding) {
    rewindFrame();
  } else if (running) {
    const sp = curSpeed();
    acc += sp;
    // While the mouse is held on the controls or dragging the view, keep frames short so it stays responsive.
    const t0 = performance.now(), budget = interacting || drag ? Math.min(15, simBudget(sp)) : simBudget(sp);
    // Stay responsive: never spend more than the budget simulating per frame.
    while (acc >= 1 && performance.now() - t0 < budget) { world.step(); acc--; tpsTicks++; }
    if (acc > 1) acc = 0; // (also what keeps Max from piling up)
    alpha = sp >= 1 ? 1 : acc;
    world.smooth = sp < 1; // only pay for in-between frames when they're visible
    rewind.record(world, performance.now() - t0);
  }
  if (now - tpsSince > 500) { tps = (tpsTicks * 1000) / (now - tpsSince); tpsTicks = 0; tpsSince = now; speedLabel(); }
  // Draw everything partway between ticks (the simulation itself never sees these positions).
  story.update(dt);
  $('btn-tour').classList.toggle('active', story.active);
  world.beginInterp(alpha);
  opts.time = world.t - 1 + alpha;
  renderer.time = opts.time;
  const sel = ui.selected;
  if (sel) trackSelection(sel);
  // A strand inside a protocell: place it for this frame before aiming the camera at it.
  for (let q = sel; q; q = q.parent) if (q.kind === 'polymer' && q.obj.home && !q.obj.home.dead) renderer.placeInternal(q.obj, q.obj.home);
  opts.selected = sel && !sel.gone ? sel.obj : null;
  opts.selection = sel && !sel.gone ? sel : null;
  // Following is a setting, not part of one selection: whatever is selected next is followed too,
  // starting from the current view so the camera doesn't jump.
  if (sel && !sel.gone && !flight && sel.follow !== followOn) {
    sel.follow = followOn;
    if (followOn) startFollow(sel);
    ui.lastHTML = null;
  }
  if (flight) fly(dt);
  else if (sel && sel.follow && !sel.gone) chase(sel, dt);
  if (opts.flash) { opts.flash.a -= 0.02; if (opts.flash.a <= 0) opts.flash = null; }
  renderer.draw(world, opts);
  ui.update(world, frame);
  world.endInterp();
}

// ---------------------------------------------------------------- controls
function playLabel() {
  $('btn-play').textContent = running || rewinding ? 'Pause' : 'Play';
  $('btn-rew').classList.toggle('active', !!rewinding);
}
$('btn-play').onclick = () => {
  if (rewinding) stopRewind(); // pauses
  else running = !running;
  playLabel();
};
$('btn-step').onclick = () => { stopRewind(); world.step(); alpha = 1; };
$('btn-rew').onclick = () => { if (rewinding) stopRewind(); else startRewind(); };

// ---------------------------------------------------------------- rewind
// Plays the recent past backwards at the current speed. Below one tick per frame it is smooth (drawn
// between ticks, like playing forward); up to 20 ticks per frame it steps back tick by tick; faster
// than that it hops between the saved moments, which needs no replaying at all.
function startRewind() {
  if (story.active) { ui.toast('The tour has its own rewind (◀◀ and the timeline)', world.t); return; }
  stopSeek();
  if (!(rewind.oldest() < world.t)) { ui.toast('Nothing to rewind yet: let the world run for a moment first', world.t); return; }
  running = false;
  rewinding = { t: world.t - 1 + alpha, spec: selSpec(ui.selected), fresh: true };
  playLabel();
}
function stopRewind() {
  if (!rewinding) return;
  rewinding = null;
  rewind.dropFine();
  acc = 0;
  playLabel();
}
function rewindFrame() {
  const s = curSpeed(), v = s === Infinity ? 250 : s, oldest = rewind.oldest();
  const r = rewinding;
  r.t -= v;
  let end = false;
  if (r.t <= oldest) { r.t = oldest; end = true; }
  const k = Math.floor(r.t), smooth = v < 1;
  let w = null;
  if (v >= 20) {
    const q = rewind.saveAt(k);
    if (q && (q.t !== world.t || r.fresh)) w = rewind.coarse(k);
  } else if (r.fresh || world.t !== (smooth ? k + 1 : k)) w = rewind.exact(k, smooth);
  r.fresh = false;
  const cur = ui.selected;
  if (cur && cur.pan) r.spec.pan = { ...cur.pan }; // keep any panning done while rewinding
  if (w) swapWorld(w, r.spec);
  alpha = smooth ? Math.min(1, Math.max(0, r.t - k)) : 1;
  if (!smooth) r.t = Math.min(r.t, world.t); // (hopping between saves: carry on from where it landed)
  if (end) {
    stopRewind();
    ui.toast(`Rewound as far as the saved history goes (tick ${oldest.toLocaleString()})`, world.t);
  }
}

// Put an earlier version of the world on screen, keeping what was selected (found again by id) and
// the camera on it.
function swapWorld(w, spec) {
  world = w;
  ui.reset();
  ui.seenLogs = w.logs.length;
  opts.selected = null;
  flight = null;
  const s = spec && resolveSpec(spec, w);
  if (!s) return;
  ui.select(world, s);
  s.follow = followOn;
  if (followOn) {
    startFollow(s);
    if (spec.pan) s.pan = { ...spec.pan };
    const t = followTarget(s), o = s.offset;
    renderer.cam.x = t.x + o.x + s.pan.x; renderer.cam.y = t.y + o.y + s.pan.y;
  }
}

// What is selected, described so it can be found again in another copy of the world.
function selSpec(s) {
  if (!s) return null;
  const chain = [];
  for (let q = s; q; q = q.parent) chain.unshift(q);
  const levels = chain.map((q, i) => {
    const L = { kind: q.kind, label: crumbLabel(q) };
    if (q.st) L.mid = q.st.mid;
    else if (q.kind === 'organism') L.members = q.members().map((c) => c.id);
    else if (q.obj && q.obj.id !== undefined) { L.id = q.obj.id; L.parentId = q.obj.parentId; }
    if (i) L.idx = flatKids(chain[i - 1]).filter((k) => k.kind === q.kind && crumbLabel(k) === L.label).findIndex((k) => k.obj === q.obj);
    return L;
  });
  return { levels, pan: s.pan ? { ...s.pan } : null };
}
const flatKids = (s) => { try { return children(s, world, renderer).flatMap((k) => (k.group && k.kids ? k.kids() : [k])); } catch { return []; } };

// Find a selection again, as deep as it still exists (a cell not born yet: its parent).
function resolveSpec(spec, w) {
  const [top, ...rest] = spec.levels;
  let s = findTop(top, w);
  if (!s) return null;
  for (const L of rest) {
    const kids = flatKids(s).filter((k) => k.kind === L.kind && crumbLabel(k) === L.label);
    const k = kids[L.idx] || kids.find((c) => L.id !== undefined && c.obj && c.obj.id === L.id);
    if (!k) break;
    s = k;
  }
  return s;
}
function findTop(L, w) {
  const cells = w.life.cells;
  switch (L.kind) {
    case 'cell': {
      const c = cells.find((q) => q.id === L.id) || (L.parentId !== undefined && cells.find((q) => q.id === L.parentId));
      return c ? mkSel('cell', c) : null;
    }
    case 'organism': {
      const ids = new Set(L.members), c = cells.find((q) => ids.has(q.id) && q.orgSize > 1);
      return c ? organismOf(c, w) : null;
    }
    case 'vesicle': { const v = w.soup.vesicles.find((q) => q.id === L.id); return v ? mkSel('vesicle', v) : null; }
    case 'virus': { const v = w.viruses.list.find((q) => q.id === L.id); if (!v) return null; v.r = v.r || 0.2; return mkSel('virus', v, { world: w }); }
    case 'polymer': {
      let p = w.soup.polymers.find((q) => q.id === L.id), home = null;
      if (!p) for (const v of w.soup.vesicles) { p = v.polys.find((q) => q.id === L.id); if (p) { home = v; break; } }
      if (!p) return null;
      p._rad = polymerRadius(p);
      const s = mkSel('polymer', p);
      if (home) s.parent = mkSel('vesicle', home);
      return s;
    }
    case 'molecule': {
      if (L.mid === undefined) return null;
      const soup = w.soup, i = soup.indexOfMid(L.mid);
      if (i < 0) return null;
      const st = { mid: L.mid, x: soup.mx[i], y: soup.my[i], ang: (L.mid * 2.399) % (Math.PI * 2), gone: false };
      return molecule(soup.mt[i], () => st, () => st.gone, null, { st });
    }
  }
  return null;
}

function stopSeek() {
  seeking = null;
  $('btn-seek').textContent = '⏭ Next milestone';
  $('btn-seek').classList.remove('active');
}
$('btn-seek').onclick = () => {
  if (seeking) { stopSeek(); return; }
  stopRewind();
  if (story.active) return; // the tour's worlds are replays: jumping ahead would leave the scene
  seeking = { from: world.milestones.length, start: world.t };
  $('btn-seek').classList.add('active');
};
$('btn-tour').onclick = () => {
  if (story.active) { story.stop(); return; }
  stopSeek(); stopRewind();
  story.start(seed);
};
$('btn-save').onclick = async () => {
  if (live) { location.href = '/api/save'; return; } // (the server's exact world, not this page's copy)
  const bytes = await saveToFile(world);
  ui.toast(`World saved (${(bytes / 1e6).toFixed(1)} MB)`, world.t);
};
$('btn-load').onclick = () => $('file-load').click();
$('file-load').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const w = await loadFromFile(f);
    story.stop(); stopSeek(); stopRewind(); rewind.clear();
    world = w;
    seed = w.seed;
    $('seed').value = seed;
    ui.reset();
    ui.seenLogs = w.logs.length; // don't replay old notifications
    // The save's own settings now apply (also to new worlds and the tour), and the address shows them.
    if (w.loadedCfg) {
      for (const k of Object.keys(cfgOverrides)) delete cfgOverrides[k];
      Object.assign(cfgOverrides, w.loadedCfg);
      extraParams = Object.keys(cfgOverrides).length ? `&cfg=${encodeURIComponent(JSON.stringify(cfgOverrides))}` : '';
      showCfgNote('the saved world');
    }
    history.replaceState(null, '', urlFor(seed));
    ui.toast(`Loaded seed ${seed} at tick ${w.t.toLocaleString()}${w.loadedCfg ? '' : ' (this save didn’t record its settings, so the current ones stay)'}`, w.t);
  } catch (err) {
    ui.toast(`Could not load: ${err.message}`, world.t);
  }
};
$('btn-fit').onclick = () => { renderer.fit(); reframe(); };
// Zoom presets: jump to a physical field of view, centred on the selection if there is one.
for (const b of document.querySelectorAll('[data-fov]')) {
  b.onclick = () => {
    const fov = +b.dataset.fov;
    if (!fov) { $('btn-fit').click(); return; }
    flight = null;
    renderer.setFieldWidthNm(fov);
    const sel = ui.selected;
    if (sel && !sel.gone) { const c = centreOf(sel); renderer.cam.x = c.x; renderer.cam.y = c.y; followOn = sel.follow = true; startFollow(sel); }
  };
}
$('speed').oninput = (e) => { maxOn = false; setSpeed(+e.target.value); }; // (moving the slider leaves Max)
$('btn-max').onclick = () => setMax(!maxOn);
// New world: a fresh random world, unless a different seed has been typed in. Enter in the seed box
// loads exactly that seed (so the current one can be restarted from tick 0).
const randomSeed = () => Math.floor(Math.random() * 1e6) + 1;
$('btn-new').onclick = () => {
  const typed = Math.floor(+$('seed').value);
  newWorld(typed >= 1 && typed !== seed ? typed : randomSeed());
};
$('seed').onkeydown = (e) => { if (e.key === 'Enter') newWorld(Math.max(1, Math.floor(+$('seed').value) || 1)); };
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
  if (live && (e.code === 'Space' || '+=-mMrR'.includes(e.key))) return; // (the server runs the clock)
  if (e.code === 'Space') { e.preventDefault(); $('btn-play').click(); }
  else if (e.key === 'Escape') {
    $('tree-modal').hidden = true;
    goUp();
  }
  else if (e.key === 'f' || e.key === 'F') toggleFollow();
  else if (story.active && e.key === 'ArrowLeft') { e.preventDefault(); $('st-back').click(); }
  else if (story.active && e.key === 'ArrowRight') { e.preventDefault(); $('st-fwd').click(); }
  else if (e.key === '+' || e.key === '=') { maxOn = false; setSpeed(speedIdx + 1); }
  else if (e.key === '-') { maxOn = false; setSpeed(speedIdx - 1); }
  else if (e.key === 'm' || e.key === 'M') setMax(!maxOn);
  else if (e.key === 'r' || e.key === 'R') $('btn-rew').click();
});

window.addEventListener('resize', () => renderer.resize());

// --------------------------------------------------------- camera & picking
let drag = null;
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  flight = null;
  const r = canvas.getBoundingClientRect();
  const f = Math.exp(-e.deltaY * 0.0015);
  // While following something centred, zoom straight into it; once you've panned, zoom at the cursor.
  const s = ui.selected, following = s && s.follow && !s.gone;
  if (following && !(s.pan && s.pan.hold)) renderer.zoomAt(r.width / 2, r.height / 2, f);
  else { renderer.zoomAt(e.clientX - r.left, e.clientY - r.top, f); if (following) reframe(); }
}, { passive: false });

canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, moved: 0 };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (e.buttons === 0) { endDrag(); return; } // the button was released somewhere we didn't hear about
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  if (drag.moved > 4) {
      flight = null;
    canvas.classList.add('dragging');
    renderer.pan(dx, dy);
    reframe(); // while following, dragging moves where the subject sits on screen, and it stays there
  }
  drag.x = e.clientX; drag.y = e.clientY;
});
canvas.addEventListener('pointerup', (e) => {
  canvas.classList.remove('dragging');
  if (drag && drag.moved <= 4) {
    const r = canvas.getBoundingClientRect();
    pick(renderer.screenToWorld(e.clientX - r.left, e.clientY - r.top));
  }
  endDrag();
});
// A drag must always end, even if the pointer is released outside the window or the browser takes it over.
function endDrag() { drag = null; canvas.classList.remove('dragging'); }
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('lostpointercapture', endDrag);
window.addEventListener('blur', endDrag);

// Keep the selection current. When the selected thing turns into something else (a molecule built
// into a strand, a protocell dividing or becoming a cell, a cell swallowed, a virus infecting),
// hand the selection (and the follow) over to whatever it became.
function trackSelection(sel) {
  const soup = world.soup;
  soup.watchMid = 0;
  let root = sel;
  while (root.parent) root = root.parent;
  for (let q = sel; q; q = q.parent) {
    if (!q.st) continue; // a free molecule from the soup: find it again by its stable id
    soup.watchMid = q.st.mid;
    const i = soup.indexOfMid(q.st.mid);
    if (i < 0) {
      if (!q.st.gone) { q.st.gone = true; q.st.next = soup.watchNext; }
    } else {
      const j = renderer.jig(q.st.mid);
      q.st.sx = soup.mx[i]; q.st.sy = soup.my[i];          // where the simulation has it
      q.st.x = q.st.sx + j.x; q.st.y = q.st.sy + j.y;      // where it is drawn (thermal jiggle)
      q.st.ang = (q.st.mid * 2.399 + (opts.time ?? world.t) * 0.04) % (Math.PI * 2); // molecules tumble
    }
  }
  soup.watchNext = null;
  if (!sel.obj.dead) { sel.gone = false; return; }
  // Find the innermost thing in the chain that turned into something we can follow.
  for (let q = sel; q; q = q.parent) {
    const o = q.st || q.obj;
    if (!(o.dead || o.gone)) continue;
    const nxt = q.st ? q.st.next : { obj: o.next, why: o.nextWhy };
    if (nxt && nxt.obj && !nxt.obj.dead) { handOff(sel, q, nxt.obj, nxt.why); return; }
    if (!sel.gone) ui.toast(`${crumbLabel(q)} ${(nxt && nxt.why) || o.nextWhy || 'is gone'}`, world.t);
    break;
  }
  sel.gone = true;
}

// What the camera tracks: the moving body a selection belongs to (so a part's own motion, a strand
// wandering inside its protocell, or a molecule's jiggle stays visible on screen).
function followTarget(sel) {
  for (let q = sel; q; q = q.parent) {
    if (q.st) return { x: q.st.sx ?? q.st.x, y: q.st.sy ?? q.st.y };
    if (q.kind === 'polymer') {
      const p = q.obj;
      return p.home && !p.home.dead && p._bx !== undefined ? { x: p._bx, y: p._by } : { x: p.x, y: p.y };
    }
    if (q.kind === 'cell' || q.kind === 'vesicle' || q.kind === 'virus' || q.kind === 'organism') return { x: q.obj.x, y: q.obj.y };
  }
  return { x: sel.obj.x, y: sel.obj.y };
}

// Locked camera: the followed thing stays exactly in the middle of the screen, so it never jitters
// however it moves. When following starts (or after a drag or Fit) the camera glides the last bit
// into the centre and then holds.
function startFollow(sel) {
  const t = followTarget(sel);
  let c = t;
  try { c = centreOf(sel); } catch { /* parts without a centre are followed by their body */ }
  sel.offset = { x: c.x - t.x, y: c.y - t.y };
  sel.pan = { x: renderer.cam.x - c.x, y: renderer.cam.y - c.y, hold: false }; // glides into the centre
}

// The tour hands over what to look at: follow s (keeping a given pan, or centred at a field of view),
// or with no subject just look at a place.
function storyFollow(s, view = {}) {
  flight = null;
  if (view.fov) renderer.setFieldWidthNm(view.fov);
  if (!s) { renderer.cam.x = view.x; renderer.cam.y = view.y; ui.select(world, null); return; }
  ui.select(world, s);
  followOn = s.follow = true;
  startFollow(s);
  s.pan = view.pan ? { ...view.pan } : { x: 0, y: 0, hold: false };
  const t = followTarget(s), o = s.offset;
  renderer.cam.x = t.x + o.x + s.pan.x; renderer.cam.y = t.y + o.y + s.pan.y;
  ui.lastHTML = null;
}

function chase(sel, dt) {
  const t = followTarget(sel), o = sel.offset || { x: 0, y: 0 }, p = sel.pan || (sel.pan = { x: 0, y: 0 });
  if (!p.hold) { const k = Math.exp(-dt / 0.35); p.x *= k; p.y *= k; } // ease into the centre
  // After a pan the view rides along with the subject at that offset (you can look anywhere, even
  // well away from it, and everything stays still relative to it).
  renderer.cam.x = t.x + o.x + p.x;
  renderer.cam.y = t.y + o.y + p.y;
  sel.camT = t; // where the camera put the subject this frame (drawn position, between ticks)
}

function kindOf(o) {
  if (o instanceof Cell) return 'cell';
  if (o.polys) return 'vesicle';
  if (o.seq) return 'polymer';
  if (o.k1 !== undefined) { o.r = o.r || 0.2; return 'virus'; }
  return null;
}

function handOff(old, from, obj, why) {
  const kind = kindOf(obj);
  if (!kind) { old.gone = true; return; }
  const s = mkSel(kind, obj, kind === 'virus' ? { world } : {});
  if (kind === 'polymer') s.obj._rad = polymerRadius(obj);
  if (kind === 'polymer' && obj.home) s.parent = mkSel('vesicle', obj.home);
  s.follow = old.follow;
  if (s.follow) startFollow(s); // glides over to the successor, then locks on
  ui.toast(`${crumbLabel(from)} ${why || 'changed'}`, world.t);
  ui.select(world, s);
}

// Select a part from the inspector and fly the camera to it, framed to fit.
let flight = null;
function focus(s) {
  if (s.kind === 'polymer') s.obj._rad = polymerRadius(s.obj);
  ui.select(world, s);
  if (s.obj.dead) return;
  s.follow = followOn; // chasing waits until we arrive (the flight steers the camera meanwhile)
  flight = { sel: s, t: 0, dur: 0.9, from: { x: renderer.cam.x, y: renderer.cam.y, fov: renderer.fieldWidthNm() } };
}

// Log-zoom flight that keeps the destination steady on screen; far jumps pull back first.
function fly(dt) {
  const f = flight, s = f.sel;
  if (s.gone || s.obj.dead || ui.selected !== s) { flight = null; return; }
  f.t += dt;
  const c = centreOf(s), to = { x: c.x, y: c.y, fov: fovFor(s) }, from = f.from;
  const u = Math.min(1, f.t / f.dur), e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  const lerpFov = (a, b, k) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * k);
  const gapNm = Math.hypot(to.x - from.x, to.y - from.y) * NM_PER_UNIT;
  const leg = (a, b, k) => {
    const fov = lerpFov(a.fov, b.fov, k), shrink = b.fov < a.fov;
    const w = shrink ? (fov - b.fov) / (a.fov - b.fov || 1) : 1 - (fov - a.fov) / (b.fov - a.fov || 1);
    renderer.cam.x = b.x + (a.x - b.x) * w; renderer.cam.y = b.y + (a.y - b.y) * w;
    renderer.setFieldWidthNm(fov);
  };
  if (gapNm > 3 * Math.max(from.fov, to.fov)) {
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, fov: gapNm * 1.4 };
    if (e < 0.5) leg(from, mid, e * 2); else leg(mid, to, e * 2 - 1);
  } else leg(from, to, e);
  if (u >= 1) {
    flight = null;
    followOn = s.follow = true; // a fly-to ends following its destination
    const ft = followTarget(s);
    s.offset = { x: c.x - ft.x, y: c.y - ft.y }; // keep the part itself in the middle
    s.pan = { x: 0, y: 0 };
  }
}
ui.onPick = focus;
ui.renderer = renderer;

// Nested selection: click selects the outermost thing; click again inside it to go one level deeper.
function pick(p) {
  const tol = (6 * renderer.dpr) / renderer.ppu;
  const cur = ui.selected;
  if (cur && !cur.gone) {
    const chain = [...ancestors(cur, world), cur];
    for (let i = chain.length - 1; i >= 0; i--) {
      if (!contains(chain[i], p, tol)) continue;
      const child = childAt(chain[i], p, tol, world, renderer);
      if (child) ui.select(world, child);
      else if (i < chain.length - 1) ui.select(world, chain[i]); // inside a parent, between its parts
      return; // inside the current selection but on nothing smaller: keep it
    }
  }
  ui.select(world, topLevelAt(world, p, tol, opts.showChem));
}

// Only the Follow button and the F key turn following off.
let followOn = false;
function toggleFollow() {
  const s = ui.selected;
  if (!s || s.gone) return;
  followOn = s.follow = !followOn;
  // Keep the object where it is on screen instead of snapping it to the centre.
  if (s.follow) startFollow(s);
  ui.lastHTML = null;
}
ui.onFollow = toggleFollow;

// Keep the current view as the following framing (after a drag or Fit): following carries on from there.
function reframe() {
  const s = ui.selected;
  if (!s || s.gone || !s.follow) return;
  // Measure from where the camera last drew the subject, not where the simulation has it: at slow
  // speeds those differ (the view is drawn between ticks), and mixing them made every mouse move
  // nudge the view as well, as if something else were dragging it too.
  const t = s.camT || followTarget(s);
  const o = s.offset || { x: 0, y: 0 };
  s.pan = { x: renderer.cam.x - t.x - o.x, y: renderer.cam.y - t.y - o.y, hold: true }; // stays where you put it
}


// Up one level (inspector button or Esc); keeps following and keeps the view steady.
function goUp() {
  const s = ui.selected;
  const up = s ? ancestors(s, world).at(-1) : null;
  if (up && s.follow) { up.follow = true; startFollow(up); }
  ui.select(world, up || null);
}
ui.onUp = goUp;

function polymerRadius(q) { return (q.seq.length * DIM.ntRise) / 2 / NM_PER_UNIT; }

// Console handle for tinkering, e.g. soup.world.life.cells.length
window.soup = { get world() { return world; }, renderer, ui, opts, story, rewind, frame: frameStep, draw: () => { renderer.draw(world, opts); ui.update(world, 0); } };

// Served by the simulation server (sim-server.mjs)? Then watch its world instead of running one here.
if (await detectLive()) await startLive();
requestAnimationFrame(loop);

async function startLive() {
  const feed = new LiveFeed();
  let w;
  try { w = await feed.full(); } catch (err) { ui.toast(`Could not load the live world (${err.message}); running one here instead`, world.t); return; }
  live = feed;
  running = false;
  // The server runs the clock: no play, speed, rewind, new worlds, tour or planetary events here.
  const hide = (el) => { el.style.display = 'none'; };
  for (const id of ['btn-play', 'btn-rew', 'btn-step', 'btn-seek', 'btn-tour', 'btn-load', 'speed', 'btn-max']) hide($(id));
  hide($('seed').closest('.row'));
  hide($('ev-meteor').closest('section'));
  $('btn-save').title = 'Download the server\'s world as it is now (load it in a local copy to explore it at your own pace)';
  world = w; seed = w.seed;
  ui.reset(); ui.seenLogs = w.logs.length; opts.selected = null;
  const note = document.createElement('p');
  note.className = 'cfg-note';
  note.textContent = `Live: you're watching a world that runs on the server (seed ${w.seed}). It keeps evolving when nobody is watching.`;
  $('scale-note').after(note);
  await feed.frame(world).catch(() => {});
  speedLabel();
  // About once a second a new frame; now and then a full snapshot (genomes of cells born meanwhile).
  const pump = async () => {
    const t0 = performance.now();
    try {
      if (t0 - feed.lastFull > FULL_EVERY) swapWorld(await feed.full(), selSpec(ui.selected));
      await feed.frame(world);
    } catch { /* the server may be restarting: try again shortly */ }
    setTimeout(pump, Math.max(200, 1000 - (performance.now() - t0)));
  };
  setTimeout(pump, 1000);
}
