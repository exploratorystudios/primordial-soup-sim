// The world: ocean environment, chemistry, life, history and milestones.
import { CFG } from './config.js';
import { RNG } from './rng.js';
import { Fields } from './fields.js';
import { Soup } from './chemistry.js';
import { Life } from './life.js';
import { Viruses } from './viruses.js';

export const MILESTONES = [
  ['polymer', 'First polymer'],
  ['vesicle', 'First vesicle'],
  ['replicator', 'First replicator'],
  ['protocell', 'First protocell'],
  ['cell', 'First living cell'],
  ['translation', 'Proteins & genetic code'],
  ['dna', 'DNA genome'],
  ['virus', 'First virus'],
  ['hgt', 'Horizontal gene transfer'],
  ['predator', 'First predator'],
  ['photo', 'Photosynthesis'],
  ['goe', 'Great Oxidation Event'],
  ['aerobic', 'Aerobic respiration'],
  ['eukaryote', 'First eukaryote'],
  ['plastid', 'First alga (chloroplast)'],
  ['sex', 'Sexual reproduction'],
  ['colony', 'First colony'],
  ['multicellular', 'Multicellular organism'],
  ['germline', 'Germ-soma life cycle'],
  ['complex', 'Complex organism'],
  ['cambrian', 'Cambrian-style radiation'],
];

// [milestone, name, description, when this happened on Earth]. Ticks are not years: chemistry
// runs in seconds and evolution over millions of years, so the dates are a guide, not a clock.
const ERAS = [
  [null, 'Hadean Ocean', 'Lightning, UV and hydrothermal vents forge simple organic molecules.', '~4.4–4.0 billion years ago'],
  ['polymer', 'Prebiotic Chemistry', 'Monomers condense into chains on mineral surfaces near the vents.', '~4.2–3.8 billion years ago (hypothesized)'],
  ['replicator', 'RNA World', 'Some chains fold into ribozymes that copy themselves, with errors.', '~4 billion years ago (hypothesized)'],
  ['protocell', 'Protocell Era', 'Fatty-acid vesicles trap replicators; lineages of protocells compete.', 'before ~3.8 billion years ago (hypothesized)'],
  ['cell', 'Archean: Age of Microbes', 'Living cells evolve by mutation and natural selection.', 'from ~3.7 billion years ago'],
  ['dna', 'Archean: DNA & Proteins', 'Proteins take over the chemistry and DNA becomes the archive of genes.', 'before the last common ancestor, >3.5 billion years ago'],
  ['goe', 'Great Oxidation', 'Photosynthesis floods the ocean with oxygen: poison for some, power for others.', '~2.4 billion years ago'],
  ['eukaryote', 'Proterozoic: Eukaryotes', 'Endosymbiosis creates complex cells with mitochondria.', '~2.0–1.6 billion years ago'],
  ['multicellular', 'Multicellular Life', 'Cells stick together, divide labour and become organisms.', 'complex multicellularity from ~1.6 billion years ago'],
  ['cambrian', 'Cambrian Radiation', 'Many lineages of complex organisms diversify.', '~540 million years ago'],
];

export class World {
  constructor(seed) {
    this.seed = seed;
    this.rng = new RNG(seed);
    this.t = 0;
    this.fields = new Fields(CFG.W, CFG.H, CFG.FIELD_CELL);
    this.vents = [];
    for (let i = 0; i < CFG.VENTS; i++) {
      this.vents.push({ x: (CFG.W * (i + 0.5)) / CFG.VENTS + this.rng.range(-90, 90), y: CFG.H - 8, strength: 0.7 + this.rng.next() * 0.6 });
    }
    this.lightMul = 1;
    this.ventMul = 1;
    this.dayFactor = 1;
    this.timers = { snowball: 0, volcano: 0 };
    this.milestones = [];
    this.mset = new Set();
    this.logs = [];
    this.history = [];
    this.historyEvery = 50;
    this.o2 = 0;
    this.soup = new Soup(this);
    this.life = new Life(this);
    this.viruses = new Viruses(this);
    this.phase = this.rng.next() * 1000;
    this.fields.nutrient.fill(CFG.NUT_INIT);
    // Light attenuation with depth, tabulated every 2 units (1 µm).
    this.sunTable = new Float32Array(Math.ceil(CFG.H / 2) + 1);
    for (let i = 0; i < this.sunTable.length; i++) this.sunTable[i] = Math.exp((-CFG.LIGHT_DEPTH * i * 2) / CFG.H);
    this.sunScale = 0.5;
    this.smooth = false; // capture start-of-tick positions for smooth slow-motion rendering
    this.curX = new Float32Array(this.fields.n);
    this.curY = new Float32Array(this.fields.n);
    this.updateCurrents();
  }

  // -------------------------------------------------------------- environment
  sunAt(y) {
    let i = (y * this.sunScale) | 0;
    if (i < 0) i = 0; else if (i >= this.sunTable.length) i = this.sunTable.length - 1;
    return this.dayFactor * this.lightMul * this.sunTable[i];
  }

  lightAt(x, y) {
    let l = this.sunAt(y);
    if (y > CFG.H - 140) {
      for (const v of this.vents) {
        const dx = x - v.x, dy = y - v.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 22500) l += CFG.VENT_GLOW * v.strength * (1 - Math.sqrt(d2) / 150);
      }
    }
    return l;
  }

  // Slow ocean currents, cached on the field grid and refreshed periodically.
  updateCurrents() {
    const F = this.fields, t = this.t + this.phase;
    for (let gy = 0; gy < F.gh; gy++) {
      for (let gx = 0; gx < F.gw; gx++) {
        const x = (gx + 0.5) * F.cs, y = (gy + 0.5) * F.cs, i = gy * F.gw + gx;
        this.curX[i] = CFG.CURRENT * Math.sin(y * 0.008 + t * 0.0005);
        this.curY[i] = CFG.CURRENT * 0.6 * Math.cos(x * 0.006 + t * 0.0004);
      }
    }
  }

  current(x, y, out) {
    const i = this.fields.idx(x, y);
    out.x = this.curX[i];
    out.y = this.curY[i];
    return out;
  }

  // Hot water rises from the vents.
  plume(x, y) {
    const reach = CFG.H * CFG.PLUME_REACH;
    if (y < CFG.H - reach) return 0;
    for (const v of this.vents) {
      if (Math.abs(x - v.x) < 35) return -0.45 * (1 - (CFG.H - y) / reach);
    }
    return 0;
  }

  stepFields() {
    const F = this.fields;
    const gw = F.gw;
    for (const v of this.vents) {
      const amt = CFG.VENT_CHEM * v.strength * this.ventMul;
      const cx = (v.x / F.cs) | 0, cy = F.gh - 1;
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= gw) continue;
        F.chem[cy * gw + x] += amt * (dx === 0 ? 0.5 : 0.25);
      }
    }
    const nv = this.vents;
    for (const v of nv) F.add(F.nutrient, v.x, v.y, CFG.VENT_NUT * v.strength);
    const wpc = CFG.WEATHERING / gw;
    for (let x = 0; x < gw; x++) F.nutrient[x] += wpc;
    // Oxygen is mopped up by reduced chemicals (and, implicitly, dissolved iron): the
    // reason the Great Oxidation Event lagged behind the origin of photosynthesis.
    const chem = F.chem, oxy = F.oxygen;
    if (this.t % 2 === 1 && this.mset.has('photo')) {
      const k = 1 - (1 - CFG.OXY_REACT) * (1 - CFG.OXY_REACT); // two ticks' worth
      for (let i = 0; i < F.n; i++) {
        const o = oxy[i];
        if (o <= 0) continue;
        const r = Math.min(chem[i], o) * k;
        chem[i] -= r; oxy[i] = o - r;
      }
    }
    // Fields change slowly: diffuse every other tick at twice the rate (same transport, half the cost).
    if (this.t % 2 === 0) {
      const d2 = (x) => 1 - (1 - x) * (1 - x);
      F.diffuse(F.chem, CFG.CHEM_DIFF * 2, d2(CFG.CHEM_DECAY));
      F.diffuse(F.organic, CFG.ORG_DIFF * 2, d2(CFG.ORG_DECAY));
      F.diffuse(F.oxygen, Math.min(1, CFG.OXY_DIFF * 2), d2(CFG.OXY_DECAY));
      F.diffuse(F.nutrient, Math.min(1, CFG.NUT_DIFF * 2), d2(CFG.NUT_BURIAL));
    }
  }

  // --------------------------------------------------------------------- step
  step() {
    if (this.smooth) this.capturePrev();
    this.dayFactor = 0.65 + 0.35 * Math.sin((this.t * 2 * Math.PI) / CFG.DAY_LENGTH);
    if (this.t % 20 === 0) this.updateCurrents();
    this.stepFields();
    // Once life is established the soup is a slow-changing backdrop: step it every third tick.
    if (this.life.cells.length < CFG.MAX_ORIGINS_POP * 1.5 || this.t % 3 === 0) this.soup.step();
    this.life.step();
    if (this.t % 100 === 0) {
      this.life.census();
      this.o2 = this.fields.mean(this.fields.oxygen);
      this.checkMilestones();
    }
    if (this.t % this.historyEvery === 0) this.record();
    this.tickEvents();
    this.t++;
  }

  checkMilestones() {
    const st = this.life.stats;
    if (st.proteinCells >= 10) this.milestone('translation', 'Proteins take over: ribosomes and a genetic code replace ribozymes');
    if (st.dnaCells >= 10) this.milestone('dna', 'DNA becomes the genome: a stable archive replaces fragile RNA');
    if (st.photosynthesizers >= 15) this.milestone('photo', 'Photosynthesis evolves: life taps sunlight');
    if (this.o2 > 0.5) this.milestone('goe', 'The Great Oxidation Event: free oxygen accumulates in the ocean');
    if (st.aerobic >= 15) this.milestone('aerobic', 'Aerobic respiration evolves: oxygen becomes fuel');
    if (st.largest >= 4) this.milestone('colony', 'Daughter cells stay stuck together: the first colony');
    if (st.multicellular >= 3) this.milestone('multicellular', 'Cells differentiate within a colony: a true multicellular organism');
    if (st.complex > 0) this.milestone('complex', 'A complex organism: 16+ cells, 3+ specialised cell types and a germline');
    if (st.multiSpecies >= 5) this.milestone('cambrian', 'Five or more species of multicellular organisms coexist');
  }

  milestone(key, text) {
    if (this.mset.has(key)) return;
    this.mset.add(key);
    this.milestones.push({ key, text, t: this.t });
    this.log(text, true);
  }

  log(text, major = false) {
    this.logs.push({ t: this.t, text, major });
    if (this.logs.length > 200) this.logs.shift();
  }

  era() {
    let e = ERAS[0];
    for (const er of ERAS) if (er[0] === null || this.mset.has(er[0])) e = er;
    return { name: e[1], desc: e[2], earth: e[3] };
  }

  record() {
    const s = this.soup, st = this.life.stats;
    this.history.push({
      t: this.t,
      mono: s.n, poly: s.polymers.length, ves: s.vesicles.length, rep: s.stats.replicators, proto: s.stats.protocells,
      cells: this.life.cells.length, photo: st.photo, chemo: st.chemo, hetero: st.hetero, pred: st.pred,
      euk: st.euk, colony: st.inColonies, species: st.speciesAlive, o2: this.o2, viruses: this.viruses.list.length,
    });
    if (this.history.length > 1500) {
      this.history = this.history.filter((_, i) => i % 2 === 0);
      this.historyEvery *= 2;
    }
  }

  // ----------------------------------------------------- smooth rendering
  // Remember where things were at the start of the tick, so the renderer can show in-between frames.
  capturePrev() {
    for (const c of this.life.cells) { c.x0 = c.x; c.y0 = c.y; }
    for (const p of this.soup.polymers) { p.x0 = p.x; p.y0 = p.y; p.a0 = p.ang; }
    for (const v of this.soup.vesicles) { v.x0 = v.x; v.y0 = v.y; }
    if (this.viruses) for (const v of this.viruses.list) { v.x0 = v.x; v.y0 = v.y; }
  }

  // Temporarily move everything to its interpolated position (alpha 0 = start of tick, 1 = end).
  // Must be paired with endInterp(); the simulation never sees these positions.
  beginInterp(alpha) {
    this._interp = this.smooth && alpha < 0.999;
    if (!this._interp) return;
    const lerp = (a, b) => a + (b - a) * alpha;
    const fix = (o) => { if (o.x0 === undefined) return; o._sx = o.x; o._sy = o.y; o.x = lerp(o.x0, o.x); o.y = lerp(o.y0, o.y); };
    for (const c of this.life.cells) fix(c);
    for (const p of this.soup.polymers) { fix(p); if (p.a0 !== undefined) { p._sa = p.ang; p.ang = lerp(p.a0, p.ang); } }
    for (const v of this.soup.vesicles) fix(v);
    if (this.viruses) for (const v of this.viruses.list) fix(v);
    const s = this.soup, n = s.n;
    if (!this._mx || this._mx.length < s.mx.length) { this._mx = new Float32Array(s.mx.length); this._my = new Float32Array(s.mx.length); }
    this._simMx = s.mx; this._simMy = s.my;
    for (let i = 0; i < n; i++) { this._mx[i] = lerp(s.px0[i], s.mx[i]); this._my[i] = lerp(s.py0[i], s.my[i]); }
    s.mx = this._mx; s.my = this._my;
  }

  endInterp() {
    if (!this._interp) return;
    const back = (o) => { if (o._sx === undefined) return; o.x = o._sx; o.y = o._sy; o._sx = undefined; };
    for (const c of this.life.cells) back(c);
    for (const p of this.soup.polymers) { back(p); if (p._sa !== undefined) { p.ang = p._sa; p._sa = undefined; } }
    for (const v of this.soup.vesicles) back(v);
    if (this.viruses) for (const v of this.viruses.list) back(v);
    this.soup.mx = this._simMx; this.soup.my = this._simMy;
    this._interp = false;
  }

  // ------------------------------------------------------------------ events
  meteor() {
    const rng = this.rng;
    const x = rng.next() * CFG.W, y = rng.next() * CFG.H * 0.7;
    let killed = 0;
    for (const c of this.life.cells) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < 350 || rng.next() < 0.6) { this.life.kill(c, 'impact', false); killed++; }
    }
    this.lightMul = 0.25;
    this.timers.impactWinter = 1500;
    this.log(`Asteroid impact! ${killed} cells die and dust blots out the sun`, true);
    return { x, y };
  }

  snowball() {
    this.timers.snowball = 6000;
    this.log('Snowball Earth: ice sheets cover the ocean and sunlight collapses', true);
  }

  volcano() {
    this.timers.volcano = 3000;
    this.log('Volcanic surge: the vents erupt with chemical energy', true);
  }

  tickEvents() {
    const T = this.timers;
    let light = 1;
    if (T.impactWinter > 0) { T.impactWinter--; light = Math.min(light, 0.25 + 0.75 * (1 - T.impactWinter / 1500)); }
    if (T.snowball > 0) { T.snowball--; light = Math.min(light, 0.3); if (T.snowball === 0) this.log('The ice melts: Snowball Earth ends', true); }
    this.lightMul = light;
    this.ventMul = T.volcano > 0 ? (T.volcano--, 4) : 1;
  }
}
