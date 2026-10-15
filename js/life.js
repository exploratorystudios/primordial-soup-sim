// Living cells: metabolism, behaviour, reproduction with mutation, predation,
// endosymbiosis, horizontal gene transfer, colonies, cell differentiation and speciation.
import { CFG } from './config.js';
import { SpatialHash } from './spatial.js';
import * as Gn from './genome.js';
import * as K from './kernels.js';
import { views as kernelViews, run as runKernels } from './pool.js';

export const T_GENERIC = 0, T_FEEDER = 1, T_MOTOR = 2, T_MOUTH = 3, T_ARMOR = 4, T_GERM = 5;
export const TYPE_NAMES = ['Generalist', 'Feeder', 'Motor', 'Mouth', 'Armor', 'Germline'];
export const TROPH_NAMES = ['Phototroph', 'Chemotroph', 'Heterotroph', 'Predator'];

// Per-cell-type multipliers: photo, chemo, hetero, predation, motility, armor, upkeep.
// Specialised cells do one job very well and depend on their colony for the rest.
const TM = [
  [1, 1, 1, 1, 1, 1, 1],
  [2, 2, 2, 0.3, 0, 0.6, 0.9],      // feeder: doubles the cell's own metabolism (photo/chemo/absorptive)
  [0.2, 0.2, 0.2, 0, 3, 0.6, 1.1],
  [0.2, 0.6, 2.2, 2.2, 0.6, 0.6, 1.0],
  [0.2, 0.2, 0.2, 0, 0, 3, 0.7],
  [0, 0, 0, 0, 0, 1, 0.35],
];

const snap = (c) => ({ x: c.x, y: c.y, r: c.r, col: c.trophColor, mito: c.mito, id: c.id });
const CUR = { x: 0, y: 0 };

export class Cell {
  constructor(id, x, y, g, parent) {
    this.id = id;
    this.x = x; this.y = y; this.vx = 0; this.vy = 0;
    this.g = g;
    this.energy = 0;
    this.age = 0;
    this.gen = parent ? parent.gen + 1 : 0;
    this.mito = parent ? parent.mito : false;
    this.endoT = parent ? parent.endoT : undefined;
    this.plastid = parent ? parent.plastid : false;
    this.species = parent ? parent.species : 0;
    this.origin = parent ? parent.origin : 0;
    this.parentId = parent ? parent.id : 0;
    this.bonds = [];
    this.type = parent && parent.bonds.length ? parent.type : T_GENERIC;
    this.org = this.id; this.orgSize = 1; this.depth = 0;
    this.dead = false;
    this.heading = (id * 2.399) % 6.283;
    this.px = 0; this.py = 0; this.fx = 0; this.fy = 0;
    this._s = 0; this._ds = 0;
    this.nut = 0;
    this.infected = null;
    this.x0 = x; this.y0 = y;
    // Properties set later on (or by the renderer), declared up front in a fixed order: cells then all share
    // one internal shape, which keeps every loop over them fast.
    this.dirX = undefined; this.dirY = undefined; this.rTarget = undefined; this.mitoN = undefined;
    this.born = 0; this.sexual = false; this.founderSeq = null; this.fromProtocell = false; this.endosymbiont = false;
    this.next = null; this.nextWhy = ''; this._dividing = false; this._fade = undefined;
    decode(this);
  }
}

export function decode(c) {
  const g = c.g;
  // Radius in world units (0.5 µm): prokaryotes 1–3.5 µm across, eukaryotes 6–30 µm.
  const rNow = c.r, growing = c.rTarget !== undefined;
  c.r = c.mito ? 6 + g[Gn.SIZE] * 24 : 1 + g[Gn.SIZE] * 2.5;
  if (growing) { c.rTarget = c.r; c.r = Math.min(rNow, c.r); } // still growing toward its new size
  c.area = (c.r / 2) * (c.r / 2);        // relative to a 2 µm bacterium (collision mass)
  c.m = Math.pow(c.area, 0.75);          // metabolic size: Kleiber-like sublinear scaling
  c.transl = g[Gn.TRANSL];
  c.prot = 0.5 + 0.5 * c.transl;         // ribozyme metabolism is slow; proteins are far better catalysts
  // The switch to DNA happened gradually (enzymes to make deoxyribonucleotides, then polymerases,
  // then repair), so its benefits rise smoothly with the gene; above 0.5 the genome counts as DNA.
  const dg = Math.min(1, Math.max(0, (g[Gn.DNAG] - 0.15) / 0.6));
  c.dnaLevel = dg * dg * (3 - 2 * dg);
  c.dna = g[Gn.DNAG] > 0.5;
  c.resist = g[Gn.RESIST];
  const p = g[Gn.PHOTO], ch = g[Gn.CHEMO], h = g[Gn.HETERO], pr = g[Gn.PRED];
  const tot = p + ch + h + pr + 0.05;
  const eff = (x) => Math.pow(x / tot, CFG.SPECIALIZE);
  c.effP = eff(p); c.effC = eff(ch); c.effH = eff(h); c.effPred = eff(pr);
  c.motil = g[Gn.MOTIL];
  c.aer = g[Gn.AEROBIC];
  if (c.mito && CFG.MITO_AER > c.aer) c.aer = CFG.MITO_AER; // mitochondria are the cell's aerobic machinery
  c.armor = g[Gn.ARMOR];
  c.adh = g[Gn.ADHES];
  c.share = g[Gn.SHARE];
  c.cap = CFG.CAP_K * c.m * (c.mito ? 2.2 : 1);
  c.divFrac = 0.45 + 0.45 * g[Gn.DIVTH];
  c.lifespan = 800 + g[Gn.LIFESPAN] * 4000;
  c.colMax = 2 + Math.floor(g[Gn.COLMAX] * 60);
  c.sense = 20 + g[Gn.MOTIL] * 50;
  const t = [p, ch, h, pr];
  let bi = 0;
  for (let i = 1; i < 4; i++) if (t[i] > t[bi]) bi = i;
  c.troph = bi;
  // Display colour: a blend of metabolic strategies.
  const s = p + ch + h + pr + 1e-6;
  c.colR = Math.round((p * 70 + ch * 235 + h * 150 + pr * 240) / s);
  c.colG = Math.round((p * 210 + ch * 150 + h * 110 + pr * 60) / s);
  c.colB = Math.round((p * 90 + ch * 50 + h * 240 + pr * 70) / s);
  c.nutNeed = c.m * CFG.NUT_PER_AREA * 2 * (c.mito ? CFG.EUK_NUT : 1); // enough body material for two cells
  c.trophColor = `rgb(${c.colR},${c.colG},${c.colB})`;
  c.hueColor = `hsl(${Math.round(g[Gn.HUE] * 360)},75%,60%)`;
}

function link(a, b) { a.bonds.push(b); b.bonds.push(a); }
function unlink(a, b) {
  let i = a.bonds.indexOf(b); if (i >= 0) a.bonds.splice(i, 1);
  i = b.bonds.indexOf(a); if (i >= 0) b.bonds.splice(i, 1);
}

export class Life {
  constructor(world) {
    this.w = world;
    this.cells = [];
    this.newborns = [];
    this.hash = new SpatialHash(CFG.W, CFG.H, CFG.LIFE_HASH);
    this.xs = new Float32Array(4096);
    this.ys = new Float32Array(4096);
    this.species = new Map();
    this.nextSpecies = 1;
    this.nextId = 1;
    this.organisms = [];
    this.origins = 0;
    this.stamp = 0;
    this.births = 0;
    this.deaths = { starved: 0, eaten: 0, aged: 0, oxygen: 0, virus: 0, crowding: 0, impact: 0 };
    this.sexualBirths = 0;
    this.maxR = 1;
    this.stats = { photosynthesizers: 0, dnaCells: 0, proteinCells: 0, infected: 0, sexualBirths: 0, photo: 0, chemo: 0, hetero: 0, pred: 0, euk: 0, plastid: 0, aerobic: 0, inColonies: 0, multicellular: 0, complex: 0, largest: 0, maxGen: 0, speciesAlive: 0, multiSpecies: 0 };
  }

  redecode(c) { decode(c); }

  makeCell(x, y, g, parent) {
    return new Cell(this.nextId++, x, y, g, parent);
  }

  spawnFromProtocell(v, poly) {
    const c = this.makeCell(v.x, v.y, Gn.fromSequence(poly.seq), null);
    c.fromProtocell = true;
    c.energy = c.cap * 0.5;
    c.nut = c.nutNeed * 0.5;
    c.origin = ++this.origins;
    c.born = this.w.t;
    c.species = this.newSpecies(c, 0).id;
    c.founderSeq = poly.seq.slice();
    this.newborns.push(c);
    this.w.milestone('cell', 'A protocell becomes a self-sustaining living cell (abiogenesis)');
    this.w.log(`Abiogenesis event #${c.origin}: a new lineage of life is born`);
    return c;
  }

  newSpecies(c, parentId) {
    const s = {
      id: this.nextSpecies++, parent: parentId, born: this.w.t, rep: new Float32Array(c.g),
      hue: c.g[Gn.HUE], count: 0, peak: 0, extinct: -1, euk: c.mito, troph: c.troph, children: 0, multi: false,
    };
    this.species.set(s.id, s);
    const p = this.species.get(parentId);
    if (p) p.children++;
    return s;
  }

  // ------------------------------------------------------------------- step
  step() {
    if (this.cells.length === 0 && this.newborns.length === 0) return;
    const cells = this.cells, n = cells.length;
    if (this.xs.length < n) { this.xs = new Float32Array(n * 2); this.ys = new Float32Array(n * 2); }
    for (let i = 0; i < n; i++) { this.xs[i] = cells[i].x; this.ys[i] = cells[i].y; }
    this.hash.build(n, this.xs, this.ys);
    // A second grid holding only the predators: most cells can't hunt, so when they look around the only
    // thing they can react to is a predator, and scanning just those finds exactly the same ones.
    if (!this.predHash) { this.predHash = new SpatialHash(CFG.W, CFG.H, CFG.LIFE_HASH); this.pxs = new Float32Array(256); this.pys = new Float32Array(256); this.pidx = new Int32Array(256); }
    let np = 0;
    for (let i = 0; i < n; i++) {
      const c = cells[i];
      if (c.effPred > 0.05) {
        if (np === this.pidx.length) { const grow = (A, T) => { const B = new T(A.length * 2); B.set(A); return B; }; this.pxs = grow(this.pxs, Float32Array); this.pys = grow(this.pys, Float32Array); this.pidx = grow(this.pidx, Int32Array); }
        this.pxs[np] = this.xs[i]; this.pys[np] = this.ys[i]; this.pidx[np++] = i;
      }
    }
    this.predHash.build(np, this.pxs, this.pys);
    // Largest radius present (collision search range) and how much of each grid square is covered by cells.
    let maxR = 1;
    const cov = this.coverage || (this.coverage = new Float32Array(this.hash.nc));
    cov.fill(0);
    const sq = CFG.LIFE_HASH * CFG.LIFE_HASH;
    for (let i = 0; i < n; i++) {
      const c = cells[i];
      if (c.r > maxR) maxR = c.r;
      cov[this.hash.cellOf[i]] += Math.min(Math.PI * c.r * c.r, sq) / sq;
    }
    this.maxR = maxR;

    // Crowding cull weights: mean weakness² this tick, so selective culling keeps the overall rate unchanged.
    if (CFG.CULL_SELECTIVE && n > CFG.MAX_CELLS * 0.85) {
      let sw = 0;
      for (let i = 0; i < n; i++) { const w = this.weakness(cells[i]); sw += w * w; }
      this.meanWeak = sw / n || 1;
    }
    // The heavy per-cell work runs in parallel phases (kernels.js); light, sensing and steering first.
    this.prepareKernels(n);
    this.packCells(this.V);
    this.runPhase(this.V, 'steer');
    for (let i = 0; i < n; i++) if (!cells[i].dead) this.live(cells[i], i);
    this.interact();
    if (this.w.t % 2 === 0) this.relax();
    this.physics();
    if (this.w.viruses) this.w.viruses.step(); // uses this tick's cell hash

    let anyDead = false;
    for (let i = 0; i < n; i++) if (cells[i].dead) { anyDead = true; break; }
    this.cells = anyDead ? cells.filter((c) => !c.dead) : cells;
    for (const c of this.newborns) if (!c.dead) this.cells.push(c);
    this.newborns = [];

    if (this.w.t % 10 === 0) this.updateOrganisms();
  }

  // How close a cell is to death: drained energy, old age, or an infection that will burst it (0 healthy … 1).
  // Energy is measured against a standard tank for the cell's size (how long it would last), so eukaryotes'
  // larger tanks (2.2x) don't make healthy ones look half-empty.
  weakness(c) {
    if (c.infected) return 1;
    const e = 1 - c.energy / (CFG.CAP_K * c.m), a = c.age / c.lifespan;
    return Math.min(1, Math.max(0, e > a ? e : a));
  }

  // Apply a new radius and everything that scales with it.
  resize(c) {
    c.area = (c.r / 2) * (c.r / 2);
    c.m = Math.pow(c.area, 0.75);
    c.cap = CFG.CAP_K * c.m * (c.mito ? 2.2 : 1);
    c.nutNeed = c.m * CFG.NUT_PER_AREA * 2 * (c.mito ? CFG.EUK_NUT : 1);
  }

  live(c, i) {
    const w = this.w, F = w.fields, rng = w.rng, g = c.g, tm = TM[c.type];
    c.age++;
    // After endosymbiosis the new organelle divides inside its host: one, then two, four...
    if (c.endoT !== undefined) c.mitoN = Math.min(99, 1 + Math.floor((w.t - c.endoT) / 40));
    if (c.rTarget !== undefined) {
      c.r = Math.min(c.rTarget, c.r + 0.04); // ~0.02 µm per tick
      this.resize(c);
      if (c.r >= c.rTarget) c.rTarget = undefined;
    }
    // Self-shading: light falls when neighbours cover much of the area around the cell.
    const sq = CFG.LIFE_HASH * CFG.LIFE_HASH;
    const shade = this.coverage[this.hash.cell(c.x, c.y)] - Math.min(Math.PI * c.r * c.r, sq) / sq;
    let light = this.V.LIGHTOUT[i]; // (computed in the steer phase; the cell hasn't moved since)
    if (shade > 0.35) light /= 1 + (shade - 0.35) * 3;
    const o2 = F.get(F.oxygen, c.x, c.y);
    const o2f = o2 > CFG.O2_REF ? 1 : o2 / CFG.O2_REF;
    const resp = 1 + c.aer * CFG.AERO_BONUS * o2f * (c.mito ? 2.5 : 1);

    let gain = 0;
    const ep = c.effP * tm[0];
    if (ep > 0) {
      const gp = light * CFG.PHOTO_K * c.m * ep * (c.plastid ? 1.8 : 1) * c.prot;
      gain += gp;
      // Oxygenic photosynthesis needs strong light; dim vent-light photosynthesis is anoxygenic.
      const sun = w.sunAt(c.y);
      F.add(F.oxygen, c.x, c.y, gp * CFG.O2_YIELD * Math.min(1, sun * 2));
    }
    const ec = c.effC * tm[1];
    if (ec > 0) gain += F.take(F.chem, c.x, c.y, CFG.CHEMO_K * c.m * ec) * CFG.CHEMO_EFF * c.prot;
    const eh = c.effH * tm[2];
    if (eh > 0) gain += F.take(F.organic, c.x, c.y, CFG.HET_K * c.m * eh) * CFG.HET_EFF * resp * c.prot;

    let cost = CFG.BASE_COST * c.m * (c.mito ? 1.25 : 1) * tm[6] * (1 + 0.25 * g[Gn.LIFESPAN])
      + c.aer * CFG.AER_COST * c.m
      + c.armor * tm[5] * CFG.ARM_COST * c.m
      + c.adh * CFG.ADH_COST
      + (c.effP + c.effC + c.effH + c.effPred) * CFG.MACHINE_COST * c.m
      + c.transl * CFG.RIBOSOME_COST * c.m      // building and running ribosomes
      + c.resist * CFG.RESIST_COST * c.m        // antiviral defence
      // RNA genomes break easily and need constant repair, worse once oxygen appears.
      + (CFG.DNA_COST * c.dnaLevel + CFG.RNA_GENOME_COST * (1 - c.dnaLevel) * (1 + 2 * o2f)) * c.m;
    if (c.infected) cost += CFG.BASE_COST * c.m; // the virus hijacks the cell's machinery
    // Oxygen is toxic to cells without antioxidant / aerobic machinery.
    const tox = o2f - 1.3 * c.aer - (g[Gn.PHOTO] > 0.4 ? 0.3 : 0);
    let toxCost = 0;
    if (tox > 0) toxCost = tox * CFG.TOX * c.m;
    c.energy += gain - cost - toxCost;
    if (c.energy > c.cap) c.energy = c.cap;

    this.steer(c, tm, i);

    // Building a body needs scarce nutrient: this is what really limits the biosphere.
    if (c.nut < c.nutNeed) c.nut += F.take(F.nutrient, c.x, c.y, Math.min(c.nutNeed - c.nut, CFG.NUT_UPTAKE * c.m));

    if (c.energy <= 0) { this.kill(c, toxCost > cost * 0.5 ? 'oxygen' : 'starved', false); return; }
    if (c.age > c.lifespan || rng.next() < 0.00003) { this.kill(c, 'aged', false); return; }
    // An infected cell bursts when the viruses inside it are ready.
    if (c.infected && w.t >= c.infected.t) { if (w.viruses) w.viruses.lyse(c); this.kill(c, 'virus', false); return; }
    // Safety valve near the CPU population ceiling, so births never stall.
    const fill = this.cells.length / CFG.MAX_CELLS;
    if (fill > 0.85) {
      let p = (fill - 0.85) * 0.02;
      if (CFG.CULL_SELECTIVE) { const wk = this.weakness(c); p *= (wk * wk) / this.meanWeak; } // the weakest go first
      if (rng.next() < p) { this.kill(c, 'crowding', false); return; }
    }

    // A germline cell full of energy buds off to found a new organism.
    if (c.type === T_GERM && c.bonds.length && c.orgSize >= 6 && c.energy > 0.7 * c.cap) {
      const fromOrganism = c.orgSize >= 8;
      for (const o of c.bonds.slice()) unlink(c, o);
      c.type = T_GENERIC; c.orgSize = 1; c.org = c.id;
      if (fromOrganism && this.w.mset.has('multicellular')) this.w.milestone('germline', 'A germline cell buds off to found the next generation of a multicellular organism', c);
    }

    if (c.energy > c.cap * c.divFrac && c.nut >= c.nutNeed && c.age > CFG.MIN_DIV_AGE && this.cells.length + this.newborns.length < CFG.MAX_CELLS) {
      this.divide(c);
    }
  }

  // Swim: sensing and the new heading (every third tick) were worked out in the steer phase.
  steer(c, tm, i) {
    const mot = c.motil * tm[4];
    if (mot < 0.03) return;
    const V = this.V, f = V.OUTF[i];
    if (f & K.O_SENSED) { c.px = V.PX[i]; c.py = V.PY[i]; c.fx = V.FX[i]; c.fy = V.FY[i]; }
    if (f & K.O_RETHINK) { c.heading = V.HEADOUT[i]; c.dirX = V.DIRX[i]; c.dirY = V.DIRY[i]; }
    const th = (mot * CFG.MOT_SPEED) / Math.max(1, Math.sqrt(c.m));
    c.vx += c.dirX * th; c.vy += c.dirY * th;
    c.energy -= mot * CFG.MOT_COST * c.m;
  }

  // ---------------------------------------------------------------- parallel phases (kernels.js, pool.js)
  // Shared (or local) arrays for this tick, with the grid, predator grid, fields and light settings copied in.
  prepareKernels(n) {
    const w = this.w, F = w.fields, h = this.hash, V = kernelViews(n, (w.viruses ? w.viruses.list.length : 0) + 64, h.nc, F.n, w.sunTable.length);
    this.V = V;
    const P = V.P;
    P[K.P_T] = w.t; P[K.P_SEED] = w.seed | 0; P[K.P_MAXR] = this.maxR;
    P[K.P_HCS] = h.cs; P[K.P_HGW] = h.gw; P[K.P_HGH] = h.gh; P[K.P_FCS] = F.cs; P[K.P_FGW] = F.gw; P[K.P_FGH] = F.gh;
    P[K.P_LIGHT] = w.dayFactor * w.lightMul; P[K.P_SUNSCALE] = w.sunScale; P[K.P_H] = CFG.H; P[K.P_VENTGLOW] = CFG.VENT_GLOW;
    const nv = Math.min(w.vents.length, K.MAX_VENTS);
    P[K.P_NVENTS] = nv;
    for (let k = 0; k < nv; k++) { const v = w.vents[k]; P[K.P_VENTS + k * 3] = v.x; P[K.P_VENTS + k * 3 + 1] = v.y; P[K.P_VENTS + k * 3 + 2] = v.strength; }
    P[K.P_N] = n; P[K.P_SEGCAP] = V.segCap; P[K.P_VSEGCAP] = V.vsegCap; P[K.P_HGT] = CFG.HGT_P; P[K.P_SYMB] = CFG.SYMBIO_P > 0 ? 1 : 0;
    V.HSTART.set(h.start.subarray(0, h.nc + 1)); V.HITEMS.set(h.items.subarray(0, n));
    const ph = this.predHash, np = ph.start[ph.nc];
    V.PSTART.set(ph.start.subarray(0, ph.nc + 1)); V.PITEMS.set(ph.items.subarray(0, np)); V.PIDX.set(this.pidx.subarray(0, np));
    V.FCHEM.set(F.chem); V.FORG.set(F.organic); V.FOXY.set(F.oxygen); V.SUN.set(w.sunTable);
  }

  // Copy the cells' state into the arrays, once per tick; later phases only refresh what changed.
  packCells(V) {
    const cells = this.cells, n = cells.length;
    for (let i = 0; i < n; i++) {
      const c = cells[i], g = c.g;
      V.X[i] = c.x; V.Y[i] = c.y; V.R[i] = c.r; V.AREA[i] = c.area; V.ORG[i] = c.org;
      let f = c.dead ? K.F_DEAD : 0;
      if (c.mito) f |= K.F_MITO;
      if (c.infected) f |= K.F_INFECTED;
      if (c.dirX === undefined) f |= K.F_NODIR;
      if (c.effPred > 0.05) f |= K.F_HUNTS;
      if (c.effPred * TM[c.type][3] >= 0.04) f |= K.F_EATS; // (tryEat's first test)
      if (!c.mito && c.dna && c.transl > 0.5) f |= K.F_SHOST; // (trySymbiosis's tests)
      if (!c.mito && c.aer > 0.5) f |= K.F_SPART;
      V.FLAGS[i] = f;
      V.ID[i] = c.id; V.EFFPRED[i] = c.effPred; V.SENSE[i] = c.sense; V.MOT[i] = c.motil * TM[c.type][4];
      V.WCHEM[i] = g[Gn.W_CHEM]; V.WORG[i] = g[Gn.W_ORG]; V.WOXY[i] = g[Gn.W_OXY]; V.WLIGHT[i] = g[Gn.W_LIGHT];
      V.WPREY[i] = g[Gn.W_PREY]; V.WFLEE[i] = g[Gn.W_FLEE];
      V.HEAD[i] = c.heading; V.PX[i] = c.px; V.PY[i] = c.py; V.FX[i] = c.fx; V.FY[i] = c.fy;
    }
  }

  // After the cells have lived: positions (a dividing cell shifts), sizes (growing eukaryotes) and deaths.
  refreshCells(V) {
    const cells = this.cells, n = cells.length;
    for (let i = 0; i < n; i++) {
      const c = cells[i];
      V.X[i] = c.x; V.Y[i] = c.y; V.R[i] = c.r; V.AREA[i] = c.area;
      if (c.dead) V.FLAGS[i] |= K.F_DEAD;
    }
  }

  // Run a phase; if a chunk's list of contacts or candidates overflowed its slot, redo the phase on the main
  // thread with room to spare (rare). Returns the arrays holding the results.
  runPhase(V, phase) {
    runKernels(V, phase);
    const counts = phase === 'contact' ? V.EVN : phase === 'virus' ? V.VCN : null;
    if (!counts || !counts.some((c) => c < 0)) return V;
    const P = Float64Array.from(V.P);
    const total = phase === 'virus' ? P[K.P_NV] : P[K.P_N];
    P[K.P_CHUNKS] = 1; P[K.P_SEGCAP] = total * 400 + 1024; P[K.P_VSEGCAP] = total * 400 + 1024;
    const T = { ...V, P, EV: new Int32Array(P[K.P_SEGCAP]), EVN: new Int32Array(1), VC: new Int32Array(P[K.P_VSEGCAP]), VCN: new Int32Array(1), VSTART: new Int32Array(V.vcap), VCOUNT: new Int32Array(V.vcap) };
    K.runChunk(T, phase, 0);
    return T;
  }

  divide(c) {
    const rng = this.w.rng;
    // Eukaryotes may reproduce sexually: recombine with a nearby mate of their own kind.
    let base = c.g, sexual = false;
    if (c.mito && rng.next() < c.g[Gn.SEX]) {
      const mate = this.findMate(c);
      if (mate) {
        base = Gn.recombine(c.g, mate.g, rng);
        sexual = true;
        mate.energy -= mate.cap * CFG.SEX_COST;
        c.energy -= c.cap * CFG.SEX_COST;
        this.sexualBirths++;
        this.w.emit('mate', 40, { a: c, b: mate });
        this.w.milestone('sex', 'Sexual reproduction: two eukaryotes combine their genomes', c);
      }
    }
    // DNA polymerases proofread; RNA copying is sloppy.
    const g = Gn.mutate(base, rng, 1 - (1 - CFG.DNA_MUT) * c.dnaLevel);
    const ang = rng.next() * 6.283;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const child = this.makeCell(c.x + ca * c.r * 0.6, c.y + sa * c.r * 0.6, g, c);
    c.x -= ca * c.r * 0.4; c.y -= sa * c.r * 0.4;
    const mx = (c.x + child.x) / 2, my = (c.y + child.y) / 2; // where the renderer starts the pinch
    const e = (c.energy - c.cap * CFG.DIV_COST) / 2;
    c.energy = e;
    child.energy = Math.min(e, child.cap);
    c.nut *= 0.5;
    child.nut = c.nut;
    child.born = this.w.t;
    c.age = 0;
    if (child.gen > this.stats.maxGen) this.stats.maxGen = child.gen;
    const sp = this.species.get(c.species);
    if (!sp || Gn.distance(g, sp.rep) > CFG.SPECIATE) child.species = this.newSpecies(child, c.species).id;
    // Incomplete separation after division: the seed of multicellularity.
    if (c.type !== T_GERM && c.orgSize < c.colMax && c.bonds.length < CFG.MAX_BONDS && (!CFG.REALISTIC_MULTI || c.orgSize < this.bodyLimit(c)) && rng.next() < c.adh) {
      link(c, child);
      child.org = c.org;
      child.orgSize = ++c.orgSize;
      child.type = c.type;
    }
    child.sexual = sexual;
    this.newborns.push(child);
    this.w.emit('divide', 30, { a: c, b: child, mx, my });
    this.births++;
  }

  findMate(c) {
    let best = null, bd = Infinity;
    const r = c.r * 3 + 10, sp = this.species.get(c.species);
    this.hash.query(c.x, c.y, r, (j) => {
      const o = this.cells[j];
      if (o === c || o.dead || !o.mito || o.infected) return;
      if (o.species !== c.species && !(sp && Gn.distance(o.g, sp.rep) < CFG.SPECIATE * 1.5)) return;
      const d = Math.hypot(o.x - c.x, o.y - c.y);
      if (d < bd && d < r) { bd = d; best = o; }
    });
    return best;
  }

  kill(c, cause, eaten) {
    if (c.dead) return;
    c.dead = true;
    if (!eaten) this.w.emit(cause === 'virus' ? 'burst' : 'die', cause === 'virus' ? 35 : 60, { cell: snap(c), cause });
    if (!c.nextWhy) c.nextWhy = { starved: 'starved', aged: 'died of old age', oxygen: 'was poisoned by oxygen', virus: 'burst, killed by viruses', crowding: 'died in a crowded patch', impact: 'was killed by the asteroid impact' }[cause] || 'died';
    this.deaths[cause] = (this.deaths[cause] || 0) + 1;
    if (!eaten) {
      const F = this.w.fields;
      F.add(F.organic, c.x, c.y, (Math.max(0, c.energy) * 0.5 + c.m * 8) * CFG.DEATH_ORG);
      F.add(F.nutrient, c.x, c.y, c.nut);
      c.nut = 0;
    }
    for (const o of c.bonds.slice()) unlink(c, o);
  }

  // Collisions, predation and horizontal gene transfer. Every cell's push comes from the same positions
  // (computed in parallel, then applied together); touching pairs from different organisms then get their
  // chance to eat, exchange genes or merge, one pair at a time in a fixed order.
  interact() {
    const cells = this.cells, n = cells.length, V = this.V;
    this.refreshCells(V);
    const R = this.runPhase(V, 'contact');
    for (let i = 0; i < n; i++) { const c = cells[i]; if (!c.dead) { c.x += R.PUSHX[i]; c.y += R.PUSHY[i]; V.X[i] = c.x; V.Y[i] = c.y; } }
    const chunks = R.P[K.P_CHUNKS], seg = R.P[K.P_SEGCAP];
    for (let k = 0; k < chunks; k++) {
      for (let q = k * seg, qe = q + R.EVN[k]; q < qe; q += 3) {
        const i = R.EV[q], j = R.EV[q + 1], a = cells[i], b = cells[j];
        if (a.dead || b.dead) continue;
        const ate = this.tryEat(a, b) || this.tryEat(b, a);
        if (!ate && CFG.SYMBIO_P > 0 && !a.dead && !b.dead) this.trySymbiosis(a, b) || this.trySymbiosis(b, a);
        if (R.EV[q + 2] && !a.dead && !b.dead) this.transferGene(a, b);
        if (a.dead) V.FLAGS[i] |= K.F_DEAD;
        if (b.dead) V.FLAGS[j] |= K.F_DEAD;
      }
    }
  }

  // A colony behaves like one big body for engulfment purposes.
  // Extra position-only pass so densely packed cells don't interpenetrate (visible at true scale).
  relax() {
    const cells = this.cells, n = cells.length, V = this.V;
    this.runPhase(V, 'relax'); // (positions and deaths are current in V: interact kept them up to date)
    for (let i = 0; i < n; i++) { const c = cells[i]; if (!c.dead) { c.x += V.PUSHX[i]; c.y += V.PUSHY[i]; V.X[i] = c.x; V.Y[i] = c.y; } }
  }

  bodyRadius(c) { return c.orgSize > 1 ? c.r * Math.sqrt(c.orgSize) * 0.8 : c.r; }

  // The host takes in an aerobic bacterium for good: it becomes a mitochondrion and the host a eukaryote.
  becomeEukaryote(a, b, text) {
    a.mito = true;
    b.endosymbiont = true;
    a.endoT = this.w.t; // its mitochondria will multiply from this one
    const r0 = a.r;
    decode(a);
    a.rTarget = a.r; a.r = r0; this.resize(a); // grows into a eukaryote rather than popping
    a.species = this.newSpecies(a, a.species).id;
    this.species.get(a.species).euk = true;
    this.w.milestone('eukaryote', text, a);
  }

  // Endosymbiosis by partnership: a host with a DNA genome and proteins (think archaeon) living in contact
  // with an aerobic bacterium sometimes merges with it, no hunting needed (cf. the hydrogen and syntrophy
  // hypotheses for the origin of mitochondria).
  trySymbiosis(a, b) {
    if (a.mito || b.mito || !a.dna || a.transl <= 0.5 || b.aer <= 0.5 || a.r < b.r) return false;
    const F = this.w.fields, rng = this.w.rng;
    if (Math.min(1, F.get(F.oxygen, a.x, a.y) / CFG.O2_REF) < CFG.SYMBIO_O2 || rng.next() >= CFG.SYMBIO_P) return false;
    a.nut += b.nut; b.nut = 0;
    if (a.nut > a.nutNeed) { F.add(F.nutrient, a.x, a.y, a.nut - a.nutNeed); a.nut = a.nutNeed; }
    this.becomeEukaryote(a, b, 'Endosymbiosis! An aerobic bacterium living with its host moves in for good and becomes a mitochondrion: the first eukaryote');
    b.next = a;
    b.nextWhy = `merged with its partner, cell #${a.id}, and lives on inside it as a mitochondrion`;
    this.w.emit('engulf', 30, { pred: a, prey: snap(b), endo: true });
    this.kill(b, 'symbiosis', true);
    return true;
  }

  tryEat(a, b) {
    if (a.dead || b.dead) return false;
    const pa = a.effPred * TM[a.type][3];
    if (pa < 0.04) return false;
    // Prey must be engulfable. Being part of a large colony is a defence (cf. Boraas' predation experiments).
    if (this.bodyRadius(a) < this.bodyRadius(b) * 1.2) return false;
    if (CFG.KIN_SPARE > 0 && a.species === b.species && a.energy > a.cap * CFG.KIN_SPARE) return false; // spares kin unless starving
    const rng = this.w.rng;
    const def = Math.min(0.95, b.armor * TM[b.type][5] * 0.8);
    if (rng.next() > pa * (1 - def) * CFG.PRED_P) return false;
    const F = this.w.fields;
    const o2f = Math.min(1, F.get(F.oxygen, a.x, a.y) / CFG.O2_REF);
    const resp = 1 + a.aer * CFG.AERO_BONUS * o2f * (a.mito ? 2.5 : 1);
    a.energy = Math.min(a.cap, a.energy + (Math.max(0, b.energy) * 0.6 + b.m * 6) * (0.6 + 0.4 * resp) * a.prot);
    this.w.milestone('predator', 'The first predator engulfs another cell', a);
    a.nut += b.nut;
    b.nut = 0;
    if (a.nut > a.nutNeed) { F.add(F.nutrient, a.x, a.y, a.nut - a.nutNeed); a.nut = a.nutNeed; }

    // Endosymbiosis: sometimes the meal survives inside its host.
    // Only cells that already store their genome as DNA (and make proteins) can host one.
    if (!a.mito && a.dna && a.transl > 0.5 && b.aer > 0.5 && o2f > 0.15 && rng.next() < CFG.ENDO_P) {
      this.becomeEukaryote(a, b, 'Endosymbiosis! An engulfed aerobe becomes a mitochondrion: the first eukaryote');
    } else if (a.mito && !a.plastid && b.effP > 0.25 && rng.next() < CFG.ENDO_P) {
      a.plastid = true;
      b.endosymbiont = true;
      decode(a);
      a.species = this.newSpecies(a, a.species).id;
      this.species.get(a.species).euk = true;
      this.w.milestone('plastid', 'A eukaryote keeps a photosynthetic cell as a chloroplast: the first alga', a);
    }
    b.next = a;
    b.nextWhy = b.endosymbiont ? `was swallowed by cell #${a.id} and lives on inside it as an organelle` : `was swallowed by cell #${a.id}`;
    this.w.emit('engulf', 30, { pred: a, prey: snap(b), endo: !!b.endosymbiont });
    this.kill(b, 'eaten', true);
    return true;
  }

  transferGene(a, b) {
    // Prokaryotes swap genes by conjugation / transformation.
    if (a.mito || b.mito) return;
    const rng = this.w.rng;
    const [to, from] = rng.next() < 0.5 ? [a, b] : [b, a];
    const i = rng.int(Gn.NG);
    if (i === Gn.HUE) return;
    to.g = new Float32Array(to.g);
    to.g[i] = from.g[i];
    decode(to);
    this.w.emit('hgt', 40, { a: from, b: to });
    this.w.milestone('hgt', 'Horizontal gene transfer: two microbes swap genes', to);
  }

  physics() {
    const cells = this.cells, rng = this.w.rng, damp = CFG.DAMP, W = CFG.W, H = CFG.H;
    const broken = [];
    for (const c of cells) {
      if (c.dead) continue;
      for (const o of c.bonds) {
        if (o.id < c.id || o.dead) continue;
        const dx = o.x - c.x, dy = o.y - c.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const rest = (c.r + o.r) * 0.95;
        if (d > rest * 3 || rng.next() < CFG.BOND_BREAK) { broken.push(c, o); continue; }
        const k = ((d - rest) / d) * 0.25;
        c.x += dx * k; c.y += dy * k; o.x -= dx * k; o.y -= dy * k;
        // Bonded cells move together.
        const mvx = (c.vx + o.vx) * 0.5, mvy = (c.vy + o.vy) * 0.5;
        c.vx += (mvx - c.vx) * 0.3; c.vy += (mvy - c.vy) * 0.3;
        o.vx += (mvx - o.vx) * 0.3; o.vy += (mvy - o.vy) * 0.3;
        // Energy flows down the gradient; germ cells act as sinks.
        const fa = (c.energy / c.cap) * (c.type === T_GERM ? 0.5 : 1);
        const fb = (o.energy / o.cap) * (o.type === T_GERM ? 0.5 : 1);
        // Cytoplasmic bridges give a baseline exchange; the sharing gene strengthens it.
        const ks = CFG.SHARE_K * (0.3 + 0.7 * (c.share + o.share) * 0.5);
        const flow = ks * (fa - fb) * Math.min(c.cap, o.cap);
        c.energy -= flow; o.energy += flow;
        // Body-building nutrient flows to whichever cell lacks it most.
        const na = c.nut / c.nutNeed, nb = o.nut / o.nutNeed;
        const nflow = ks * (na - nb) * Math.min(c.nutNeed, o.nutNeed);
        c.nut -= nflow; o.nut += nflow;
      }
    }
    for (let i = 0; i < broken.length; i += 2) unlink(broken[i], broken[i + 1]);

    const V = this.V;
    for (let i = 0, n = cells.length; i < n; i++) {
      const c = cells[i];
      if (c.dead) continue;
      this.w.current(c.x, c.y, CUR);
      // Microbes are carried by the water: currents and vent plumes move them passively.
      c.vx += (rng.next() - 0.5) * 0.1 + CUR.x * CFG.CELL_DRIFT;
      c.vy += (rng.next() - 0.5) * 0.1 + CUR.y * CFG.CELL_DRIFT + this.w.plume(c.x, c.y) * 0.3;
      c.x += c.vx; c.y += c.vy;
      c.vx *= damp; c.vy *= damp;
      if (c.x < c.r) { c.x = c.r; c.vx = Math.abs(c.vx) * 0.5; } else if (c.x > W - c.r) { c.x = W - c.r; c.vx = -Math.abs(c.vx) * 0.5; }
      if (c.y < c.r) { c.y = c.r; c.vy = Math.abs(c.vy) * 0.5; } else if (c.y > H - c.r) { c.y = H - c.r; c.vy = -Math.abs(c.vy) * 0.5; }
      if (V) { V.X[i] = c.x; V.Y[i] = c.y; } // (the virus search reads these)
    }
  }

  // Find connected colonies, compute positional information and let each cell's
  // gene-regulatory network choose its fate.
  updateOrganisms() {
    const cells = this.cells, w = this.w;
    const stamp = ++this.stamp;
    const orgs = [];
    const q = [];
    for (const c of cells) {
      if (c.dead || c._s === stamp) continue;
      c._s = stamp;
      if (c.bonds.length === 0) { c.org = c.id; c.orgSize = 1; c.depth = 0; c.type = T_GENERIC; continue; }
      q.length = 0; q.push(c);
      let root = c;
      for (let k = 0; k < q.length; k++) {
        const x = q[k];
        if (x.id < root.id) root = x;
        for (const o of x.bonds) if (o._s !== stamp) { o._s = stamp; q.push(o); }
      }
      const comp = q.slice();
      root._ds = stamp; root.depth = 0;
      const q2 = [root];
      for (let k = 0; k < q2.length; k++) {
        const x = q2[k];
        for (const o of x.bonds) if (o._ds !== stamp) { o._ds = stamp; o.depth = x.depth + 1; q2.push(o); }
      }
      const size = comp.length;
      const org = { id: root.id, size, types: [0, 0, 0, 0, 0, 0], x: 0, y: 0, species: root.species, kind: 'colony' };
      for (const x of comp) {
        x.org = root.id;
        x.orgSize = size;
        x.type = this.differentiate(x, size, w.lightAt(x.x, x.y));
        org.types[x.type]++;
        org.x += x.x; org.y += x.y;
      }
      org.x /= size; org.y /= size;
      let special = 0;
      for (let t = 1; t < 6; t++) if (org.types[t] > 0) special++;
      if (size >= 16 && special >= 3 && org.types[T_GERM] > 0 && (!CFG.REALISTIC_MULTI || root.mito)) org.kind = 'complex';
      else if (size >= 8 && special >= 2) org.kind = 'multicellular';
      orgs.push(org);
    }
    orgs.sort((a, b) => b.size - a.size);
    this.organisms = orgs;
  }

  // Largest body oxygen allows here: diffusion supplies a big body's inner cells only when oxygen is plentiful.
  bodyLimit(c) {
    const F = this.w.fields, o2f = Math.min(1, F.get(F.oxygen, c.x, c.y) / CFG.O2_REF);
    return CFG.O2_SIZE_MIN + (CFG.O2_SIZE_MAX - CFG.O2_SIZE_MIN) * o2f;
  }

  differentiate(x, size, light) {
    const g = x.g;
    const prok = CFG.REALISTIC_MULTI && !x.mito; // bacteria: no mouth (phagocytosis) or germline cells
    const i1 = x.bonds.length / 4, i2 = Math.min(1, x.depth / 6), i3 = Math.min(1, size / 30);
    let best = 0, bs = -1e9;
    for (let t = 0; t < Gn.NTYPES; t++) {
      if (prok && (t === T_MOUTH || t === T_GERM)) continue;
      const o = Gn.DIFF + t * Gn.NDIFF_IN;
      let s = g[o] + g[o + 1] * i1 + g[o + 2] * i2 + g[o + 3] * i3 + g[o + 4] * light;
      if (t === 0) s += CFG.GENERALIST_BIAS;
      if (s > bs) { bs = s; best = t; }
    }
    return best;
  }

  census() {
    const st = this.stats, t = this.w.t;
    st.photosynthesizers = st.photo = st.chemo = st.hetero = st.pred = st.euk = st.plastid = st.aerobic = st.inColonies = 0;
    st.dnaCells = st.proteinCells = st.infected = 0;
    st.sexualBirths = this.sexualBirths;
    for (const s of this.species.values()) s.count = 0;
    for (const c of this.cells) {
      if (c.troph === 0) st.photo++; else if (c.troph === 1) st.chemo++; else if (c.troph === 2) st.hetero++; else st.pred++;
      if (c.effP > 0.15) st.photosynthesizers++;
      if (c.dna) st.dnaCells++;
      if (c.transl > 0.6) st.proteinCells++;
      if (c.infected) st.infected++;
      if (c.mito) st.euk++;
      if (c.plastid) st.plastid++;
      if (c.aer > 0.5) st.aerobic++;
      if (c.orgSize > 1) st.inColonies++;
      const s = this.species.get(c.species);
      if (s) s.count++;
    }
    st.multicellular = st.complex = 0;
    st.largest = this.organisms.length ? this.organisms[0].size : 1;
    const multiSp = new Set();
    for (const o of this.organisms) {
      if (o.kind !== 'colony') { st.multicellular++; multiSp.add(o.species); const s = this.species.get(o.species); if (s) s.multi = true; }
      if (o.kind === 'complex') st.complex++;
    }
    st.multiSpecies = multiSp.size;
    let alive = 0;
    for (const [id, s] of this.species) {
      if (s.count > s.peak) s.peak = s.count;
      if (s.count > 0) { alive++; s.extinct = -1; }
      else if (s.extinct < 0) s.extinct = t;
      // Forget insignificant extinct twigs to keep memory bounded.
      if (s.count === 0 && s.peak < 4 && s.children === 0 && t - s.extinct > 500) {
        this.species.delete(id);
        const p = this.species.get(s.parent);
        if (p) p.children--;
      }
    }
    st.speciesAlive = alive;
  }
}
