// The world: ocean environment, chemistry, life, history and milestones.
import { CFG } from './config.js';
import { RNG } from './rng.js';
import { Fields } from './fields.js';
import { Soup } from './chemistry.js';
import { Life } from './life.js';

export const MILESTONES = [
  ['polymer', 'First polymer'],
  ['vesicle', 'First vesicle'],
  ['replicator', 'First replicator'],
  ['protocell', 'First protocell'],
  ['cell', 'First living cell'],
  ['hgt', 'Horizontal gene transfer'],
  ['predator', 'First predator'],
  ['photo', 'Photosynthesis'],
  ['goe', 'Great Oxidation Event'],
  ['aerobic', 'Aerobic respiration'],
  ['eukaryote', 'First eukaryote'],
  ['plastid', 'First alga (chloroplast)'],
  ['colony', 'First colony'],
  ['multicellular', 'Multicellular organism'],
  ['germline', 'Germ-soma life cycle'],
  ['complex', 'Complex organism'],
  ['cambrian', 'Cambrian-style radiation'],
];

const ERAS = [
  [null, 'Hadean Ocean', 'Lightning, UV and hydrothermal vents forge simple organic molecules.'],
  ['polymer', 'Prebiotic Chemistry', 'Monomers condense into chains on mineral surfaces near the vents.'],
  ['replicator', 'RNA World', 'Some chains fold into ribozymes that copy themselves, with errors.'],
  ['protocell', 'Protocell Era', 'Fatty-acid vesicles trap replicators; lineages of protocells compete.'],
  ['cell', 'Archean: Age of Microbes', 'Living cells evolve by mutation and natural selection.'],
  ['goe', 'Great Oxidation', 'Photosynthesis floods the ocean with oxygen: poison for some, power for others.'],
  ['eukaryote', 'Proterozoic: Eukaryotes', 'Endosymbiosis creates complex cells with mitochondria.'],
  ['multicellular', 'Multicellular Life', 'Cells stick together, divide labour and become organisms.'],
  ['cambrian', 'Cambrian Radiation', 'Many lineages of complex organisms diversify.'],
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
    this.phase = this.rng.next() * 1000;
    this.fields.nutrient.fill(CFG.NUT_INIT);
    this.curX = new Float32Array(this.fields.n);
    this.curY = new Float32Array(this.fields.n);
    this.updateCurrents();
  }

  // -------------------------------------------------------------- environment
  sunAt(y) {
    return this.dayFactor * this.lightMul * Math.exp((-CFG.LIGHT_DEPTH * y) / CFG.H);
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
    if (y < CFG.H - 260) return 0;
    for (const v of this.vents) {
      if (Math.abs(x - v.x) < 35) return -0.45 * (1 - (CFG.H - y) / 260);
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
    for (let i = 0; i < F.n; i++) {
      const r = Math.min(chem[i], oxy[i]) * CFG.OXY_REACT;
      chem[i] -= r; oxy[i] -= r;
    }
    F.diffuse(F.chem, CFG.CHEM_DIFF, CFG.CHEM_DECAY);
    F.diffuse(F.organic, CFG.ORG_DIFF, CFG.ORG_DECAY);
    F.diffuse(F.oxygen, CFG.OXY_DIFF, CFG.OXY_DECAY);
    F.diffuse(F.nutrient, CFG.NUT_DIFF, CFG.NUT_BURIAL);
  }

  // --------------------------------------------------------------------- step
  step() {
    this.dayFactor = 0.65 + 0.35 * Math.sin((this.t * 2 * Math.PI) / CFG.DAY_LENGTH);
    if (this.t % 20 === 0) this.updateCurrents();
    this.stepFields();
    this.soup.step();
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
    return { name: e[1], desc: e[2] };
  }

  record() {
    const s = this.soup, st = this.life.stats;
    this.history.push({
      t: this.t,
      mono: s.n, poly: s.polymers.length, ves: s.vesicles.length, rep: s.stats.replicators, proto: s.stats.protocells,
      cells: this.life.cells.length, photo: st.photo, chemo: st.chemo, hetero: st.hetero, pred: st.pred,
      euk: st.euk, colony: st.inColonies, species: st.speciesAlive, o2: this.o2,
    });
    if (this.history.length > 1500) {
      this.history = this.history.filter((_, i) => i % 2 === 0);
      this.historyEvery *= 2;
    }
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
