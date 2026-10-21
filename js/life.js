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
    this.up = 0; // MORPH: the colony cell this one grew from (its body-plan 'parent' bond)
    this.oi = -1; // this tick's index of its colony in Life's per-colony arrays (see orgSlot)
    this.germKept = false; // GERM_KEEP: set aside as germline, for good
    this.fated = false; // FATE_COMMIT: has chosen its own job as a colony cell (newborns choose freely first)
    this.gf = 1; // TRADEOFF / SPEC_BONUS: this colony cell's strength at its jobs
    this.para = false; this.paraT = 0; this.paraStart = 0; // PARATOMY: colony growing its copy, to what size, since when
    this.dead = false;
    this.heading = (id * 2.399) % 6.283;
    // DEVPLAN: the direction a founder grows along, this cell's division axis relative to its mother's, and its distance
    // from its body's centre (in cell radii).
    this.axis = parent ? parent.axis : this.heading; this.rel = 0; this.orad = 0;
    this.px = 0; this.py = 0; this.fx = 0; this.fy = 0;
    this._s = 0; this._ds = 0;
    this.nut = 0;
    this.infected = null;
    this.x0 = x; this.y0 = y;
    // Properties set later on (or by the renderer), declared up front in a fixed order: cells then all share
    // one internal shape, which keeps every loop over them fast.
    this.slot = -1; this.sv = 0; // slot in the shared arrays (kernels.js) and version of the traits written there
    this.dirX = undefined; this.dirY = undefined; this.rTarget = undefined; this.mitoN = undefined;
    this.born = 0; this.sexual = false; this.founderSeq = null; this.fromProtocell = false; this.endosymbiont = false;
    this.next = null; this.nextWhy = ''; this._dividing = false; this._fade = undefined;
    decode(this);
  }
}

export function decode(c) {
  c.sv = (c.sv | 0) + 1; // traits change: rewrite them to the shared arrays
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
    // Per-colony sums, in arrays indexed by orgSlot (rebuilt each tick): CULL_FAIR's weakness (WS, WN),
    // COLONY_SWIM's thrust and mass (SWX, SWY, SWM), BODY_SWIM's total thrust and body shape (SWT; BN, BX, BY, BXX,
    // BYY, BXY) and TISSUE_PUSH's shared push (PPX, PPY, PPA, PPHAS).
    this.oiMap = new Map(); this.nOi = 0; this.oiOrg = new Int32Array(0);
    this.WS = this.WN = this.SWX = this.SWY = this.SWM = this.SWT = this.PPX = this.PPY = this.PPA = new Float64Array(0);
    this.BN = this.BX = this.BY = this.BXX = this.BYY = this.BXY = new Float64Array(0); this.PPHAS = new Uint8Array(0);
    this.anySwim = false;
    this.soa = false; // positions in the shared arrays during a tick (see pull)
    this.slotCell = []; this.freeSlots = []; this.nextSlot = 0; // each living cell's fixed slot in the shared arrays
    this.hash = new SpatialHash(CFG.W, CFG.H, CFG.LIFE_HASH);
    this.xs = new Float32Array(4096);
    this.ys = new Float32Array(4096);
    this.species = new Map();
    this.nextSpecies = 1;
    this.nextId = 1;
    this.organisms = [];
    this.origins = 0;
    this.stamp = 0;
    this.fragments = 0; // colonies that split in two (FRAGMENT)
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
    this.oiMap.clear(); this.nOi = 0; // (this tick's colony indices, made as needed)
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
      if (CFG.CULL_FAIR) {
        for (let i = 0; i < n; i++) {
          const c = cells[i];
          if (!c.bonds.length) continue;
          const j = this.orgSlot(c);
          this.WS[j] += this.weakness(c); this.WN[j]++;
        }
      }
      let sw = 0;
      for (let i = 0; i < n; i++) { const w = this.cullWeakness(cells[i]); sw += w * w; }
      this.meanWeak = sw / n || 1;
    }
    // The heavy per-cell work runs in parallel phases (kernels.js): metabolism, sensing and steering, then
    // sharing out each field square's chemicals, food and nutrient; each cell then finishes its tick here.
    this.assignSlots();
    this.prepareKernels(n);
    const V = this.V, F = this.w.fields;
    this.packCells(V);
    this.soa = true; // (positions in the arrays until physics writes them back)
    this.runPhase(V, 'cells');
    this.groupByField(V);
    this.runPhase(V, 'share');
    F.chem.set(V.FCHEM); F.organic.set(V.FORG); F.nutrient.set(V.FNUT); F.oxygen.set(V.FOXY);
    this.anySwim = false;
    for (let k = 0; k < n; k++) if (!cells[k].dead) this.live(cells[k]);
    // Colonies swim as one body: the combined thrust moves every cell alike (more mass, slower).
    if (this.anySwim && CFG.BODY_SWIM) this.bodySwim(cells, n);
    else if (this.anySwim) {
      for (let k = 0; k < n; k++) {
        const c = cells[k];
        if (c.dead || c.orgSize <= 1 || c.bonds.length === 0) continue;
        const i = this.orgSlot(c);
        if (!(this.SWM[i] > 0)) continue;
        const f = 1 / Math.max(1, Math.sqrt(this.SWM[i]));
        this.V.VXC[c.slot] += this.SWX[i] * f; this.V.VYC[c.slot] += this.SWY[i] * f;
      }
    }

    this.interact();
    if (this.w.t % 2 === 0) this.relax();
    this.physics();
    if (this.w.viruses) this.w.viruses.step(); // uses this tick's cell hash

    let anyDead = false;
    for (let i = 0; i < n; i++) if (cells[i].dead) { anyDead = true; break; }
    if (anyDead) for (const c of cells) if (c.dead && c.slot >= 0) { this.slotCell[c.slot] = null; this.freeSlots.push(c.slot); c.slot = -1; }
    this.cells = anyDead ? cells.filter((c) => !c.dead) : cells;
    for (const c of this.newborns) if (!c.dead) this.cells.push(c);
    this.newborns = [];

    if (this.w.t % 10 === 0) this.updateOrganisms();
  }

  // How close a cell is to death: drained energy, old age, or an infection that will burst it (0 healthy … 1).
  // Energy is measured against a standard tank for the cell's size (how long it would last), so eukaryotes'
  // larger tanks (2.2x) don't make healthy ones look half-empty.
  // This tick's index for a cell's colony (c.org) in the per-colony arrays, made on first use.
  orgSlot(c) {
    let i = c.oi;
    if (i >= 0 && i < this.nOi && this.oiOrg[i] === c.org) return i;
    i = this.oiMap.get(c.org);
    if (i === undefined) {
      i = this.nOi++;
      this.roomOi(i + 1);
      this.oiMap.set(c.org, i); this.oiOrg[i] = c.org;
      this.WS[i] = this.WN[i] = this.SWX[i] = this.SWY[i] = this.SWM[i] = this.SWT[i] = this.PPX[i] = this.PPY[i] = this.PPA[i] = 0; this.PPHAS[i] = 0;
    }
    c.oi = i;
    return i;
  }

  roomOi(n) {
    if (n <= this.oiOrg.length) return;
    const cap = Math.max(256, n, this.oiOrg.length * 2), grow = (a, T) => { const b = new T(cap); b.set(a); return b; };
    this.oiOrg = grow(this.oiOrg, Int32Array);
    for (const k of ['WS', 'WN', 'SWX', 'SWY', 'SWM', 'SWT', 'PPX', 'PPY', 'PPA', 'BN', 'BX', 'BY', 'BXX', 'BYY', 'BXY']) this[k] = grow(this[k], Float64Array);
    this.PPHAS = grow(this.PPHAS, Uint8Array);
  }

  // What the crowding cull goes by: with CULL_FAIR, a colony cell counts as its colony's average.
  cullWeakness(c) {
    if (CFG.CULL_FAIR && c.bonds.length) { const i = this.orgSlot(c); if (this.WN[i] > 0) return this.WS[i] / this.WN[i]; }
    return this.weakness(c);
  }
  weakness(c) {
    if (c.infected) return 1;
    const e = 1 - c.energy / (CFG.CAP_K * c.m), a = c.age / c.lifespan;
    return Math.min(1, Math.max(0, e > a ? e : a));
  }

  // Apply a new radius and everything that scales with it.
  resize(c) {
    c.sv++;
    c.area = (c.r / 2) * (c.r / 2);
    c.m = Math.pow(c.area, 0.75);
    c.cap = CFG.CAP_K * c.m * (c.mito ? 2.2 : 1);
    c.nutNeed = c.m * CFG.NUT_PER_AREA * 2 * (c.mito ? CFG.EUK_NUT : 1);
  }

  live(c) {
    const w = this.w, rng = w.rng, tm = TM[c.type], V = this.V, s = c.slot;
    c.age++;
    // After endosymbiosis the new organelle divides inside its host: one, then two, four...
    if (c.endoT !== undefined) c.mitoN = Math.min(99, 1 + Math.floor((w.t - c.endoT) / 40));
    // Metabolism was worked out in the cells and share phases: energy gained minus upkeep, and nutrient.
    c.energy += V.DE[s];
    if (c.energy > c.cap) c.energy = c.cap;

    this.steer(c, tm, s);
    c.nut += V.GNUT[s];
    // Carrying a second body past what oxygen can supply costs extra.
    if (c.para && CFG.REALISTIC_MULTI && c.orgSize > this.bodyLimit(c)) c.energy -= CFG.PARA_COST * c.m;

    if (c.energy <= 0) { this.kill(c, (V.OUTF[s] & K.O_OXDEATH) ? 'oxygen' : 'starved', false); return; }
    if (c.age > c.lifespan || rng.next() < 0.00003) { this.kill(c, 'aged', false); return; }
    // An infected cell bursts when the viruses inside it are ready.
    if (c.infected && w.t >= c.infected.t) { if (w.viruses) w.viruses.lyse(c); this.kill(c, 'virus', false); return; }
    // Safety valve near the CPU population ceiling, so births never stall.
    const fill = this.cells.length / CFG.MAX_CELLS;
    if (fill > 0.85) {
      let p = (fill - 0.85) * 0.02;
      if (CFG.CULL_SELECTIVE) { const wk = this.cullWeakness(c); p *= (wk * wk) / this.meanWeak; } // the weakest go first
      if (rng.next() < p) { this.kill(c, 'crowding', false); return; }
    }

    // A germline cell full of energy buds off to found a new organism.
    // (With GERM_STEM the germ cell stays put and its daughters leave instead: see divide.)
    if (!CFG.GERM_STEM && c.type === T_GERM && c.bonds.length && c.orgSize >= 6 && c.energy > 0.7 * c.cap) {
      const fromOrganism = c.orgSize >= 8;
      for (const o of c.bonds.slice()) unlink(c, o);
      c.type = T_GENERIC; c.sv++; c.orgSize = 1; c.org = c.id;
      if (fromOrganism && this.w.mset.has('multicellular')) this.w.milestone('germline', 'A germline cell buds off to found the next generation of a multicellular organism', c);
    }

    if (c.energy > c.cap * c.divFrac && c.nut >= c.nutNeed && c.age > CFG.MIN_DIV_AGE && this.cells.length + this.newborns.length < CFG.MAX_CELLS && (!CFG.DEVPLAN || this.growthZone(c))) {
      this.divide(c);
    }
    // A new eukaryote grows into its full size gradually (~0.02 µm per tick).
    if (c.rTarget !== undefined) {
      c.r = Math.min(c.rTarget, c.r + 0.04);
      this.resize(c);
      if (c.r >= c.rTarget) c.rTarget = undefined;
      V.R[s] = c.r; V.AREA[s] = c.area; // (collisions this tick use the new size)
    }
  }

  // ---------------------------------------------------------------- body plans (MORPH)
  upCell(c) {
    if (!c.up) return null;
    for (const o of c.bonds) if (o.id === c.up) return o;
    return null;
  }
  // With NEIGHBOR_BOND a cell's bonds include neighbours, which the body plan ignores: its daughters are the cells
  // that grew from it. (Without it every bond but the one to its own parent is a daughter, as before.)
  isDaughter(c, o) { return !(CFG.NEIGHBOR_BOND || CFG.DEVPLAN) || o.up === c.id; }
  firstDaughter(c) { for (const o of c.bonds) if (this.isDaughter(c, o)) return o; return null; }
  // Neighbour adhesion (NEIGHBOR_BOND): touching cells of one colony bond, each pair with a chance per check set by
  // their junction strength, while both have room (MAX_BONDS).
  neighbourBonds(comp) {
    const rng = this.w.rng, P = CFG.NEIGHBOR_P;
    for (let i = 0; i < comp.length; i++) {
      const a = comp[i];
      if (a.bonds.length >= CFG.MAX_BONDS) continue;
      for (let j = i + 1; j < comp.length; j++) {
        const b = comp[j];
        if (b.bonds.length >= CFG.MAX_BONDS) continue;
        const dx = b.x - a.x, dy = b.y - a.y, reach = (a.r + b.r) * 1.1;
        if (dx * dx + dy * dy > reach * reach || a.bonds.includes(b)) continue;
        // (DEVPLAN: the side-adhesion gene, steeply: side-binding adhesion molecules are made in quantity or barely at all,
        // so lineages below ~0.35 don't bind sideways and stay filaments or trees.)
        let side = 1;
        if (CFG.DEVPLAN) { const u = Math.min(1, Math.max(0, ((a.g[Gn.M_LATERAL] + b.g[Gn.M_LATERAL]) * 0.5 - 0.35) / 0.3)); side = u * u * (3 - 2 * u); }
        if (rng.next() < P * side * (CFG.JUNCTIONS ? this.junction(a, b) : (a.adh + b.adh) * 0.5)) link(a, b);
        if (a.bonds.length >= CFG.MAX_BONDS) break;
      }
    }
  }

  // ---------------------------------------------------------------- developmental body plans (DEVPLAN)
  // Whether a colony cell still divides: germ cells and colonies growing their copy (PARATOMY) always do; otherwise
  // only within the growth zone: at the tips (few bonds) if the tip-growth gene is high, and within the growth
  // radius of the body's centre (1 to 15 cell radii). Mature cells stop dividing, as in real tissues.
  growthZone(c) {
    if (!c.bonds.length || c.type === T_GERM || c.para || c.orgSize < 3) return true;
    const g = c.g;
    return c.bonds.length < 2 + (1 - g[Gn.M_BRANCH]) * 4 && c.orad < 1 + g[Gn.M_SIDE] * 14;
  }
  // The direction a cell grew in (from its mother), or a founder's own axis.
  growAxis(c, up) { return up ? Math.atan2(c.y - up.y, c.x - up.x) : c.axis; }
  // Bond a newborn where its division put it: its axis turned from the mother's own by the plane-turn gene (0 to 90°,
  // to alternate sides), plus noise. Dividing straight along a filament, it goes in line, between the mother and
  // the daughter already there (growth along the filament).
  attachDev(c, child) {
    const up = this.upCell(c), g = c.g, rng = this.w.rng, base = this.growAxis(c, up);
    const turn = g[Gn.M_ANGLE] * 1.5707963 * (child.id & 1 ? 1 : -1), noise = (rng.next() - 0.5) * g[Gn.M_SPREAD] * 1.5707963;
    const a = base + turn + noise, rest = (c.r + child.r) * 0.95;
    child.up = c.id; child.rel = a - base; child.axis = a;
    let inLine = null;
    for (const o of c.bonds) {
      if (!this.isDaughter(c, o)) continue;
      let d = Math.atan2(o.y - c.y, o.x - c.x) - a;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      if (Math.abs(d) < 0.6) { inLine = o; break; }
    }
    if (inLine) {
      c.bonds[c.bonds.indexOf(inLine)] = child;
      inLine.bonds[inLine.bonds.indexOf(c)] = child;
      child.bonds.push(c, inLine);
      inLine.up = child.id; child.rel = inLine.rel; inLine.rel = 0;
      child.x = child.x0 = (c.x + inLine.x) / 2; child.y = child.y0 = (c.y + inLine.y) / 2;
    } else {
      link(c, child);
      child.x = child.x0 = c.x + Math.cos(a) * rest; child.y = child.y0 = c.y + Math.sin(a) * rest;
    }
  }

  // Daughters a cell may hold: 1-4 by its branching gene; a colony's founder one more (filaments grow both ways).
  maxDaughters(c, up) { return 1 + Math.floor(c.g[Gn.M_BRANCH] * 3.999) + (up ? 0 : 1); }
  // Direction of a cell's k-th daughter: turned from the cell's own direction by its growth genes; the founder
  // spaces its daughters evenly around itself.
  morphAngle(c, k, up) {
    const g = c.g;
    if (!up) {
      const f = this.firstDaughter(c), a0 = f ? Math.atan2(f.y - c.y, f.x - c.x) : c.heading; // (its first daughter sets its axis)
      return a0 + (k * 6.283185307) / this.maxDaughters(c, null);
    }
    let off = (g[Gn.M_ANGLE] + k * g[Gn.M_SPREAD]) * 1.5707963;
    if (g[Gn.M_SIDE] > 0.5 && ((k + c.depth) & 1)) off = -off;
    return Math.atan2(c.y - up.y, c.x - up.x) + off;
  }
  // Bond a newborn into its parent's colony where the body plan puts it: as a new daughter if the parent has room,
  // otherwise inserted between the parent and its first daughter (growth along a filament).
  attach(c, child) {
    const up = this.upCell(c);
    let nd = 0, first = null;
    for (const o of c.bonds) if (o !== up && this.isDaughter(c, o)) { if (!first) first = o; nd++; }
    child.up = c.id;
    const rest = (c.r + child.r) * 0.95;
    if (nd < this.maxDaughters(c, up) || !first) {
      const a = this.morphAngle(c, nd, up);
      link(c, child);
      child.x = child.x0 = c.x + Math.cos(a) * rest; child.y = child.y0 = c.y + Math.sin(a) * rest;
    } else {
      c.bonds[c.bonds.indexOf(first)] = child;
      first.bonds[first.bonds.indexOf(c)] = child;
      child.bonds.push(c, first);
      first.up = child.id;
      child.x = child.x0 = (c.x + first.x) / 2; child.y = child.y0 = (c.y + first.y) / 2;
    }
  }
  // Angle springs: pull each daughter toward where the body plan puts it (and the cell the other way).
  shapeForces(c) {
    const up = this.upCell(c), K = CFG.MORPH_STIFF, V = this.V, X = V.X, Y = V.Y, cs = c.slot, g = c.g;
    let k = 0;
    for (const o of c.bonds) {
      if (o === up || !this.isDaughter(c, o)) continue;
      // (morphAngle, on the arrays: the cell moves after each daughter, so its direction is read afresh)
      let a;
      if (CFG.DEVPLAN) {
        const f = this.firstDaughter(c);
        const base = up ? Math.atan2(Y[cs] - Y[up.slot], X[cs] - X[up.slot]) : (f ? Math.atan2(Y[f.slot] - Y[cs], X[f.slot] - X[cs]) - f.rel : c.axis);
        a = base + o.rel;
      } else if (!up) {
        const f = this.firstDaughter(c);
        a = (f ? Math.atan2(Y[f.slot] - Y[cs], X[f.slot] - X[cs]) : c.heading) + (k * 6.283185307) / this.maxDaughters(c, null);
      } else {
        let off = (g[Gn.M_ANGLE] + k * g[Gn.M_SPREAD]) * 1.5707963;
        if (g[Gn.M_SIDE] > 0.5 && ((k + c.depth) & 1)) off = -off;
        a = Math.atan2(Y[cs] - Y[up.slot], X[cs] - X[up.slot]) + off;
      }
      k++;
      if (o.dead) continue;
      const os = o.slot, rest = (c.r + o.r) * 0.95;
      const dx = (X[cs] + Math.cos(a) * rest - X[os]) * K, dy = (Y[cs] + Math.sin(a) * rest - Y[os]) * K;
      X[os] += dx; Y[os] += dy; X[cs] -= dx; Y[cs] -= dy;
    }
  }


  // Swim: sensing and the new heading (every third tick) were worked out in the steer phase.
  steer(c, tm, s) {
    const mot = c.motil * tm[4] * c.gf;
    // A colony swims as one body (COLONY_SWIM): every cell adds its mass, and its thrust if it swims.
    const col = CFG.COLONY_SWIM && c.orgSize > 1 && c.bonds.length > 0;
    let oi = -1;
    if (col) { oi = this.orgSlot(c); this.SWM[oi] += c.m; this.anySwim = true; }
    if (mot < 0.03) return;
    const V = this.V, f = V.OUTF[s];
    if (f & K.O_SENSED) { c.px = V.PX[s]; c.py = V.PY[s]; c.fx = V.FX[s]; c.fy = V.FY[s]; }
    if (f & K.O_RETHINK) { c.heading = V.HEAD[s] = V.HEADOUT[s]; c.dirX = V.DIRX[s]; c.dirY = V.DIRY[s]; }
    if (col) { this.SWX[oi] += c.dirX * mot * CFG.MOT_SPEED; this.SWY[oi] += c.dirY * mot * CFG.MOT_SPEED; this.SWT[oi] += mot * CFG.MOT_SPEED; }
    else {
      const th = (mot * CFG.MOT_SPEED) / Math.max(1, Math.sqrt(c.m));
      V.VXC[s] += c.dirX * th; V.VYC[s] += c.dirY * th;
    }
    c.energy -= mot * CFG.MOT_COST * c.m;
  }

  // BODY_SWIM: a colony swims as one coordinated body. Its swimmers agree on one heading (their sensed directions,
  // weighted by thrust) and all push along it, so their thrust adds up instead of partly cancelling. Water resists
  // the body by its width across the direction of travel: a slim body moving lengthwise slips through, one moving
  // broadside is held back. And like a weathervane, an elongated body turns to swim along its length.
  bodySwim(cells, n) {
    const V = this.V, { SWX, SWY, SWM, SWT, BN, BX, BY, BXX, BYY, BXY } = this;
    const member = (c) => !c.dead && c.orgSize > 1 && c.bonds.length > 0;
    BN.fill(0, 0, this.nOi); BX.fill(0, 0, this.nOi); BY.fill(0, 0, this.nOi);
    BXX.fill(0, 0, this.nOi); BYY.fill(0, 0, this.nOi); BXY.fill(0, 0, this.nOi);
    for (let k = 0; k < n; k++) {
      const c = cells[k];
      if (!member(c)) continue;
      const i = this.orgSlot(c);
      if (!(SWT[i] > 0)) continue;
      const x = V.X[c.slot], y = V.Y[c.slot];
      BN[i]++; BX[i] += x; BY[i] += y; BXX[i] += x * x; BYY[i] += y * y; BXY[i] += x * y;
    }
    // Per body: heading, speed, and turning rate (kept in the moment arrays, which are done with by then).
    for (let i = 0; i < this.nOi; i++) {
      const m = BN[i];
      if (!(m > 0)) continue;
      const mx = BX[i] / m, my = BY[i] / m;
      const sxx = BXX[i] / m - mx * mx, syy = BYY[i] / m - my * my, sxy = BXY[i] / m - mx * my;
      let dx = SWX[i], dy = SWY[i];
      const dl = Math.hypot(dx, dy);
      if (!(dl > 0)) { BN[i] = 0; continue; }
      dx /= dl; dy /= dl;
      // Spread of the body along the heading and across it (cell radius squared keeps small bodies round).
      const r2 = 9, along = dx * dx * sxx + 2 * dx * dy * sxy + dy * dy * syy, across = Math.max(0, sxx + syy - along);
      const drag = Math.min(CFG.BODY_DRAG_MAX, Math.max(CFG.BODY_DRAG_MIN, Math.sqrt((across + r2) / ((along + across) / 2 + r2))));
      const v = SWT[i] / (Math.max(1, Math.sqrt(SWM[i])) * drag);
      // Long axis and how elongated the body is; turn it toward the heading, faster the faster it swims.
      const half = (sxx - syy) / 2, rad = Math.hypot(half, sxy), big = (sxx + syy) / 2 + rad, small = (sxx + syy) / 2 - rad;
      const axis = Math.atan2(sxy, half) / 2, elong = big > 0 ? 1 - Math.max(0, small) / big : 0;
      const w = CFG.BODY_TURN * Math.sin(2 * (Math.atan2(dy, dx) - axis)) / 2 * elong * v / Math.sqrt(big + r2);
      BX[i] = mx; BY[i] = my; BXX[i] = dx * v; BYY[i] = dy * v; BXY[i] = w;
    }
    for (let k = 0; k < n; k++) {
      const c = cells[k];
      if (!member(c)) continue;
      const i = this.orgSlot(c);
      if (!(BN[i] > 0)) continue;
      const s = c.slot, w = BXY[i];
      V.VXC[s] += BXX[i] - w * (V.Y[s] - BY[i]);
      V.VYC[s] += BYY[i] + w * (V.X[s] - BX[i]);
    }
  }

  // ---------------------------------------------------------------- positions during a tick
  // From packCells until the end of physics, cells' positions and velocities live in the shared arrays
  // (V.X, V.Y, V.VXC, V.VYC; this.soa), and are written back to the cells once, at the end. pull() brings a cell
  // object up to date where code reads its position in between (collision events, deaths, healing).
  pull(c) {
    if (!this.soa) return;
    const s = c.slot;
    if (s >= 0 && this.slotCell[s] === c) { c.x = this.V.X[s]; c.y = this.V.Y[s]; }
  }
  // A newborn's slot, at birth (bonds and body springs move it this tick, in the arrays).
  slotNow(c) {
    const V = this.V;
    if (!this.soa || !V) return;
    const s = this.freeSlots.length ? this.freeSlots.pop() : this.nextSlot++;
    if (s >= V.X.length) throw new Error('no room for a newborn in the shared arrays'); // (prepareKernels leaves room)
    c.slot = s; this.slotCell[s] = c;
    V.X[s] = c.x; V.Y[s] = c.y; V.VXC[s] = c.vx; V.VYC[s] = c.vy;
  }

  // ---------------------------------------------------------------- parallel phases (kernels.js, pool.js)
  // A slot for every cell that doesn't have one yet (newborns, a loaded world).
  assignSlots() {
    for (const c of this.cells) {
      if (c.slot >= 0 && this.slotCell[c.slot] === c) continue;
      const s = this.freeSlots.length ? this.freeSlots.pop() : this.nextSlot++;
      c.slot = s; this.slotCell[s] = c;
    }
  }

  // Shared (or local) arrays for this tick, with the grids, fields and light settings copied in.
  prepareKernels(n) {
    const w = this.w, F = w.fields, h = this.hash, cells = this.cells;
    // (room for every slot in use, and for this tick's births: newborns get their slot at birth, see slotNow)
    const V = kernelViews(this.nextSlot + 16 + Math.max(0, CFG.MAX_CELLS - n), (w.viruses ? w.viruses.list.length : 0) + 64, h.nc, F.n, w.sunTable.length);
    this.V = V;
    const P = V.P;
    P[K.P_T] = w.t; P[K.P_SEED] = w.seed | 0; P[K.P_MAXR] = this.maxR;
    P[K.P_HCS] = h.cs; P[K.P_HGW] = h.gw; P[K.P_HGH] = h.gh; P[K.P_FCS] = F.cs; P[K.P_FGW] = F.gw; P[K.P_FGH] = F.gh;
    P[K.P_LIGHT] = w.dayFactor * w.lightMul; P[K.P_SUNSCALE] = w.sunScale; P[K.P_H] = CFG.H; P[K.P_VENTGLOW] = CFG.VENT_GLOW;
    const nv = Math.min(w.vents.length, K.MAX_VENTS);
    P[K.P_NVENTS] = nv;
    for (let k = 0; k < nv; k++) { const v = w.vents[k]; P[K.P_VENTS + k * 3] = v.x; P[K.P_VENTS + k * 3 + 1] = v.y; P[K.P_VENTS + k * 3 + 2] = v.strength; }
    P[K.P_N] = n; P[K.P_FN] = F.n; P[K.P_SEGCAP] = V.segCap; P[K.P_VSEGCAP] = V.vsegCap; P[K.P_HGT] = CFG.HGT_P; P[K.P_SYMB] = CFG.SYMBIO_P > 0 ? 1 : 0;
    P[K.P_O2REF] = CFG.O2_REF; P[K.P_AERO] = CFG.AERO_BONUS; P[K.P_O2YIELD] = CFG.O2_YIELD; P[K.P_SQ] = CFG.LIFE_HASH * CFG.LIFE_HASH;
    P[K.P_DAMP] = CFG.DAMP; P[K.P_DRIFT] = CFG.CELL_DRIFT; P[K.P_W] = CFG.W; P[K.P_REACH] = CFG.H * CFG.PLUME_REACH;
    // Grids hold slots.
    V.HSTART.set(h.start.subarray(0, h.nc + 1));
    for (let e = 0; e < n; e++) V.HITEMS[e] = cells[h.items[e]].slot;
    const ph = this.predHash, np = ph.start[ph.nc];
    V.PSTART.set(ph.start.subarray(0, ph.nc + 1)); V.PITEMS.set(ph.items.subarray(0, np));
    for (let p = 0; p < np; p++) V.PIDX[p] = cells[this.pidx[p]].slot;
    V.COV.set(this.coverage);
    V.FCHEM.set(F.chem); V.FORG.set(F.organic); V.FOXY.set(F.oxygen); V.FNUT.set(F.nutrient); V.SUN.set(w.sunTable);
    V.CURX.set(w.curX); V.CURY.set(w.curY);
  }

  // This tick's order and the cells' changing state; traits only for cells whose version changed (or for
  // every cell when these arrays last served another world).
  packCells(V) {
    if (V.owner !== this) { V.SVER.fill(-1); V.owner = this; }
    const cells = this.cells, n = cells.length;
    for (let k = 0; k < n; k++) {
      const c = cells[k], s = c.slot;
      V.ORDER[k] = s; V.RANK[s] = k;
      if (V.SVER[s] !== c.sv || V.ID[s] !== c.id) this.packTraits(V, c, s);
      V.X[s] = c.x; V.Y[s] = c.y; V.VXC[s] = c.vx; V.VYC[s] = c.vy; V.ORG[s] = c.org; V.NUT[s] = c.nut;
      let f = V.SFLAGS[s];
      if (c.dead) f |= K.F_DEAD;
      if (c.infected) f |= K.F_INFECTED;
      if (c.dirX === undefined) f |= K.F_NODIR;
      V.FLAGS[s] = f;
    }
  }

  // A cell's traits as the kernels use them (rewritten when decode, resize or a new cell type bumps c.sv).
  packTraits(V, c, s) {
    const g = c.g, tm = TM[c.type], m = c.m, gf = c.gf;
    V.SVER[s] = c.sv; V.ID[s] = c.id; V.R[s] = c.r; V.AREA[s] = c.area;
    V.EFFPRED[s] = c.effPred; V.SENSE[s] = c.sense; V.MOT[s] = c.motil * tm[4] * gf;
    V.WCHEM[s] = g[Gn.W_CHEM]; V.WORG[s] = g[Gn.W_ORG]; V.WOXY[s] = g[Gn.W_OXY]; V.WLIGHT[s] = g[Gn.W_LIGHT];
    V.WPREY[s] = g[Gn.W_PREY]; V.WFLEE[s] = g[Gn.W_FLEE];
    let f = 0;
    if (c.mito) f |= K.F_MITO;
    if (c.effPred > 0.05) f |= K.F_HUNTS;
    if (c.effPred * tm[3] * gf >= 0.04) f |= K.F_EATS; // (tryEat's first test)
    if (!c.mito && c.dna && c.transl > 0.5) f |= K.F_SHOST; // (trySymbiosis's tests)
    if (!c.mito && c.aer > 0.5) f |= K.F_SPART;
    V.SFLAGS[s] = f;
    const ep = c.effP * tm[0] * gf, ec = c.effC * tm[1] * gf, eh = c.effH * tm[2] * gf;
    V.PHOTOF[s] = ep > 0 ? CFG.PHOTO_K * m * ep * (c.plastid ? 1.8 : 1) * c.prot : 0;
    V.DCHEMK[s] = ec > 0 ? CFG.CHEMO_K * m * ec : 0;
    V.DORGK[s] = eh > 0 ? CFG.HET_K * m * eh : 0;
    V.CF[s] = CFG.CHEMO_EFF * c.prot; V.HPROT[s] = CFG.HET_EFF * c.prot; V.AER[s] = c.aer;
    V.COSTS[s] = CFG.BASE_COST * m * (c.mito ? 1.25 : 1) * tm[6] * (1 + 0.25 * g[Gn.LIFESPAN])
      + c.aer * CFG.AER_COST * m
      + c.armor * tm[5] * CFG.ARM_COST * m
      + c.adh * CFG.ADH_COST
      + (c.effP + c.effC + c.effH + c.effPred) * CFG.MACHINE_COST * m
      + c.transl * CFG.RIBOSOME_COST * m      // building and running ribosomes
      + c.resist * CFG.RESIST_COST * m        // antiviral defence
      + CFG.DNA_COST * c.dnaLevel * m;
    // RNA genomes break easily and need constant repair, worse once oxygen appears (scaled by oxygen in the kernel).
    V.RNAF[s] = CFG.RNA_GENOME_COST * (1 - c.dnaLevel) * m;
    V.TOXB[s] = 1.3 * c.aer + (g[Gn.PHOTO] > 0.4 ? 0.3 : 0); V.TOXM[s] = CFG.TOX * m;
    V.NUTNEED[s] = c.nutNeed; V.NUTUP[s] = CFG.NUT_UPTAKE * m; V.INFC[s] = CFG.BASE_COST * m;
    V.HEAD[s] = c.heading; V.PX[s] = c.px; V.PY[s] = c.py; V.FX[s] = c.fx; V.FY[s] = c.fy;
  }

  // Cells grouped by field square (in their order), for the share phase.
  groupByField(V) {
    const n = this.cells.length, fn = V.fn, FS = V.FSTART, ORDER = V.ORDER, FI = V.FI, FLAGS = V.FLAGS;
    if (!this.fcur || this.fcur.length !== fn) this.fcur = new Int32Array(fn);
    FS.fill(0);
    for (let k = 0; k < n; k++) { const s = ORDER[k]; if (!(FLAGS[s] & K.F_DEAD)) FS[FI[s] + 1]++; }
    for (let q = 0; q < fn; q++) FS[q + 1] += FS[q];
    const cur = this.fcur; cur.set(FS.subarray(0, fn));
    for (let k = 0; k < n; k++) { const s = ORDER[k]; if (!(FLAGS[s] & K.F_DEAD)) V.FITEMS[cur[FI[s]]++] = s; }
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
    const g = Gn.mutate(base, rng, (1 - (1 - CFG.DNA_MUT) * c.dnaLevel) * (c.type === T_GERM ? CFG.GERM_MUT : 1));
    const ang = rng.next() * 6.283;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const child = this.makeCell(c.x + ca * c.r * 0.6, c.y + sa * c.r * 0.6, g, c);
    c.x -= ca * c.r * 0.4; c.y -= sa * c.r * 0.4;
    if (this.V && this.V.owner === this && c.slot >= 0) { this.V.X[c.slot] = c.x; this.V.Y[c.slot] = c.y; }
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
    // A colony growing its copy (PARATOMY) keeps every new cell, past its usual size limit.
    if (c.type !== T_GERM && c.bonds.length < CFG.MAX_BONDS && ((c.para && c.orgSize < c.paraT)
      || (c.orgSize < c.colMax && (!CFG.REALISTIC_MULTI || c.orgSize < this.bodyLimit(c)) && rng.next() < c.adh + CFG.ADH_BOOST))) {
      if (CFG.DEVPLAN) this.attachDev(c, child); else if (CFG.MORPH) this.attach(c, child); else link(c, child);
      child.orad = c.orad;
      child.org = c.org;
      child.orgSize = ++c.orgSize;
      child.type = c.type;
      if (c.para) { child.para = true; child.paraT = c.paraT; child.paraStart = c.paraStart; }
    }
    // A germline stem cell's daughter (germ cells never stay bonded) leaves to found the next generation.
    if (CFG.GERM_STEM && c.type === T_GERM) {
      child.type = T_GENERIC;
      if (c.orgSize >= 8 && this.w.mset.has('multicellular')) this.w.milestone('germline', 'A germline cell releases a spore to found the next generation of a multicellular organism', c);
    }
    child.sexual = sexual;
    this.slotNow(child);
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
    if (this.V && this.V.owner === this && c.slot >= 0) this.V.FLAGS[c.slot] |= K.F_DEAD;
    if (!eaten) this.w.emit(cause === 'virus' ? 'burst' : 'die', cause === 'virus' ? 35 : 60, { cell: snap(c), cause });
    if (!c.nextWhy) c.nextWhy = { starved: 'starved', aged: 'died of old age', oxygen: 'was poisoned by oxygen', virus: 'burst, killed by viruses', crowding: 'died in a crowded patch', impact: 'was killed by the asteroid impact' }[cause] || 'died';
    this.deaths[cause] = (this.deaths[cause] || 0) + 1;
    if (!eaten) {
      const F = this.w.fields;
      this.pull(c);
      let nut = c.nut, en = Math.max(0, c.energy) * 0.5;
      // Recycling (RECYCLE): a colony's living neighbours take up the dying cell's material and energy.
      const fr = c.mito ? CFG.RECYCLE_EUK : CFG.RECYCLE_PROK;
      if (CFG.RECYCLE && c.bonds.length && fr > 0) {
        let n = 0;
        for (const o of c.bonds) if (!o.dead) n++;
        if (n) {
          const gn = (nut * fr) / n, ge = (en * fr) / n;
          for (const o of c.bonds) {
            if (o.dead) continue;
            o.energy = Math.min(o.cap, o.energy + ge);
            o.nut += gn;
            if (o.nut > o.nutNeed) { F.add(F.nutrient, o.x, o.y, o.nut - o.nutNeed); o.nut = o.nutNeed; }
          }
          nut *= 1 - fr; en *= 1 - fr;
        }
      }
      F.add(F.organic, c.x, c.y, (en + c.m * 8) * CFG.DEATH_ORG);
      F.add(F.nutrient, c.x, c.y, nut);
      c.nut = 0;
    }
    const nb = c.bonds.slice();
    for (const o of nb) unlink(c, o);
    if (CFG.JUNCTIONS && nb.length >= 2) this.heal(c, nb);
  }

  // Bond strength from the two cells' adhesion genes (JUNCTIONS).
  junction(a, b) { const s = (a.adh + b.adh) * 0.5; return s > 1 ? 1 : s; }
  // Wound healing: the dead cell's neighbours bond to each other in turn, each with their junction strength, if
  // they're within reach and have room. (Body plans: a neighbour that grew from the dead cell now grows from its partner.)
  heal(dead, nb) {
    const rng = this.w.rng;
    for (let i = 1; i < nb.length; i++) {
      const a = nb[i - 1], b = nb[i];
      if (a.dead || b.dead || a.bonds.includes(b) || a.bonds.length >= CFG.MAX_BONDS || b.bonds.length >= CFG.MAX_BONDS) continue;
      this.pull(a); this.pull(b);
      const dx = b.x - a.x, dy = b.y - a.y, reach = (a.r + b.r) * 0.95 * 3;
      if (dx * dx + dy * dy > reach * reach || rng.next() >= this.junction(a, b)) continue;
      link(a, b);
      if (b.up === dead.id) b.up = a.id; else if (a.up === dead.id) a.up = b.id;
    }
  }

  // Collisions, predation and horizontal gene transfer. Every cell's push comes from the same positions
  // (computed in parallel, then applied together); touching pairs from different organisms then get their
  // chance to eat, exchange genes or merge, one pair at a time in a fixed order.
  interact() {
    const V = this.V;
    const R = this.runPhase(V, 'contact'); // (positions, sizes and deaths in V are current: each change wrote there)
    this.applyPushes(R);
    const chunks = R.P[K.P_CHUNKS], seg = R.P[K.P_SEGCAP], slotCell = this.slotCell;
    for (let ch = 0; ch < chunks; ch++) {
      for (let q = ch * seg, qe = q + R.EVN[ch]; q < qe; q += 3) {
        const a = slotCell[R.EV[q]], b = slotCell[R.EV[q + 1]];
        if (a.dead || b.dead) continue;
        this.pull(a); this.pull(b);
        const ate = this.tryEat(a, b) || this.tryEat(b, a);
        if (!ate && CFG.SYMBIO_P > 0 && !a.dead && !b.dead) this.trySymbiosis(a, b) || this.trySymbiosis(b, a);
        if (R.EV[q + 2] && !a.dead && !b.dead) this.transferGene(a, b);
      }
    }
  }

  // A colony behaves like one big body for engulfment purposes.
  // Extra position-only pass so densely packed cells don't interpenetrate (visible at true scale).
  relax() {
    const V = this.V;
    this.runPhase(V, 'relax');
    this.applyPushes(V);
  }

  // Move every cell out of the cells it overlaps. With TISSUE_PUSH, the push a colony cell gets from other
  // organisms is shared by its whole colony (by size, like one body): the cell keeps 1 - its adhesion of it.
  applyPushes(R) {
    const cells = this.cells, n = cells.length, V = this.V;
    if (!CFG.TISSUE_PUSH) {
      for (let k = 0; k < n; k++) {
        const c = cells[k];
        if (c.dead) continue;
        const s = c.slot;
        V.X[s] += R.PUSHX[s]; V.Y[s] += R.PUSHY[s];
      }
      return;
    }
    // One pass over the cells to note who shares (and how much, and with which colony), the sums in plain
    // arrays, then one pass to move them.
    this.roomOi(this.nOi + n); // (no growing below: the arrays are held)
    if (!this.pkF || this.pkF.length < n) { const m = Math.ceil(n * 1.5) + 64; this.pkF = new Float64Array(m); this.pkA = new Float64Array(m); this.pkI = new Int32Array(m); }
    const { PPX, PPY, PPA, PPHAS, pkF, pkA, pkI } = this, junc = CFG.JUNCTIONS;
    for (let k = 0; k < n; k++) {
      const c = cells[k];
      if (c.dead || !(c.orgSize > 1) || !c.bonds.length) { pkI[k] = -1; continue; }
      pkI[k] = this.orgSlot(c); pkA[k] = c.area; pkF[k] = junc ? Math.min(1, c.adh) : 1;
    }
    const no = this.nOi;
    PPHAS.fill(0, 0, no); PPX.fill(0, 0, no); PPY.fill(0, 0, no); PPA.fill(0, 0, no);
    for (let k = 0; k < n; k++) {
      const i = pkI[k], f = pkF[k];
      if (i < 0 || !f) continue;
      const s = cells[k].slot;
      PPHAS[i] = 1;
      PPX[i] += R.FPUSHX[s] * f * pkA[k]; PPY[i] += R.FPUSHY[s] * f * pkA[k];
    }
    for (let k = 0; k < n; k++) { const i = pkI[k]; if (i >= 0 && PPHAS[i]) PPA[i] += pkA[k]; }
    for (let k = 0; k < n; k++) {
      const c = cells[k];
      if (c.dead) continue;
      const s = c.slot;
      let px = R.PUSHX[s], py = R.PUSHY[s];
      const i = pkI[k], f = i >= 0 ? pkF[k] : 0;
      if (f) {
        px -= R.FPUSHX[s] * f; py -= R.FPUSHY[s] * f;
        if (PPHAS[i] && PPA[i] > 0) { px += PPX[i] / PPA[i]; py += PPY[i] / PPA[i]; }
      }
      V.X[s] += px; V.Y[s] += py;
    }
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
    const pa = a.effPred * TM[a.type][3] * a.gf;
    if (pa < 0.04) return false;
    // Prey must be engulfable. Being part of a large colony is a defence (cf. Boraas' predation experiments).
    if (this.bodyRadius(a) < this.bodyRadius(b) * 1.2) return false;
    if (CFG.SHIELD && b.bonds.length >= CFG.SHIELD_BONDS) return false; // inside its colony, out of reach
    if (CFG.KIN_SPARE > 0 && a.species === b.species && a.energy > a.cap * CFG.KIN_SPARE) return false; // spares kin unless starving
    const rng = this.w.rng;
    const def = Math.min(0.95, b.armor * TM[b.type][5] * (b.type === T_GENERIC ? 1 : b.gf) * 0.8);
    let hunt = 1;
    if (CFG.HUNT) {
      // The chase: a faster predator catches more, faster prey gets away more often (equal speeds: no penalty).
      const ma = a.motil * TM[a.type][4] * a.gf, mb = b.motil * TM[b.type][4] * b.gf;
      hunt = Math.min(1, (2 * (ma + 0.05)) / (ma + mb + 0.1));
      // Prey size: best at a third to half the predator's own (by body radius), less for bigger or tinier prey.
      const lq = Math.log(this.bodyRadius(b) / this.bodyRadius(a) / 0.4);
      hunt *= Math.exp(-(lq * lq) / 0.5);
    }
    if (rng.next() > pa * (1 - def) * CFG.PRED_P * hunt) return false;
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
    const cells = this.cells, rng = this.w.rng, V = this.V, X = V.X, Y = V.Y, VX = V.VXC, VY = V.VYC;
    const broken = [];
    for (const c of cells) {
      if (c.dead) continue;
      const cs = c.slot;
      for (const o of c.bonds) {
        if (o.id < c.id || o.dead) continue;
        const os = o.slot;
        const dx = X[os] - X[cs], dy = Y[os] - Y[cs];
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const rest = (c.r + o.r) * 0.95;
        const js = CFG.JUNCTIONS ? this.junction(c, o) : 0; // (0 = the old fixed bond)
        if (d > rest * (3 + 3 * js) || rng.next() < CFG.BOND_BREAK * (1 - js)) { broken.push(c, o); continue; }
        const k = ((d - rest) / d) * 0.25 * (1 + js);
        X[cs] += dx * k; Y[cs] += dy * k; X[os] -= dx * k; Y[os] -= dy * k;
        // Bonded cells move together.
        const mvx = (VX[cs] + VX[os]) * 0.5, mvy = (VY[cs] + VY[os]) * 0.5;
        VX[cs] += (mvx - VX[cs]) * 0.3; VY[cs] += (mvy - VY[cs]) * 0.3;
        VX[os] += (mvx - VX[os]) * 0.3; VY[os] += (mvy - VY[os]) * 0.3;
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
    if (CFG.MORPH || CFG.DEVPLAN) for (const c of cells) if (!c.dead && c.bonds.length) this.shapeForces(c);
    for (let i = 0; i < broken.length; i += 2) unlink(broken[i], broken[i + 1]);

    // Currents, plumes, jostling and walls: in parallel (move phase), from positions after the bonds. Then the
    // positions go back to the cells (and the newborns, which bonds may have moved).
    this.runPhase(V, 'move');
    this.soa = false;
    const back = (c) => { const s = c.slot; c.x = X[s]; c.y = Y[s]; c.vx = VX[s]; c.vy = VY[s]; };
    for (let k = 0, n = cells.length; k < n; k++) if (!cells[k].dead) back(cells[k]);
    for (const c of this.newborns) if (c.slot >= 0 && this.slotCell[c.slot] === c) back(c);
  }


  // Find connected colonies, compute positional information and let each cell's
  // gene-regulatory network choose its fate.
  updateOrganisms(again = false) {
    const cells = this.cells, w = this.w;
    let split = false;
    const stamp = ++this.stamp;
    const orgs = [];
    const q = [];
    for (const c of cells) {
      if (c.dead || c._s === stamp) continue;
      c._s = stamp;
      if (c.bonds.length === 0) { c.org = c.id; c.orgSize = 1; c.depth = 0; c.para = false; c.germKept = false; c.fated = false; if (c.gf !== 1) { c.gf = 1; c.sv++; } if (c.type !== T_GENERIC) { c.type = T_GENERIC; c.sv++; } continue; }
      q.length = 0; q.push(c);
      let root = c;
      for (let k = 0; k < q.length; k++) {
        const x = q[k];
        if (x.id < root.id) root = x;
        for (const o of x.bonds) if (o._s !== stamp) { o._s = stamp; q.push(o); }
      }
      const comp = q.slice();
      if ((CFG.NEIGHBOR_BOND || CFG.DEVPLAN) && !again && comp.length >= 3) this.neighbourBonds(comp);
      let keep = false; // (cells keep their jobs while the colony grows its copy)
      if (CFG.PARATOMY && !CFG.PARATOMY_EUK && root.mito) {
        for (const x of comp) x.para = false; // (eukaryotes reproduce through their germline instead)
      } else if (CFG.PARATOMY) {
        // Paratomy: a colony that can grow no further first doubles, its new cells taking their parent's job,
        // then splits into two halves with matching make-up.
        const rep = comp.length >= 4 ? comp.find((x) => x.para) : undefined;
        if (rep) {
          if (!again && (comp.length >= rep.paraT || w.t - rep.paraStart > CFG.PARA_TIME)) {
            for (const x of comp) x.para = false;
            this.fragment(comp, root, true); split = true;
          } else {
            keep = true;
            for (const x of comp) if (!x.para) { x.para = true; x.paraT = rep.paraT; x.paraStart = rep.paraStart; }
          }
        } else if (comp.length < 4) {
          for (const x of comp) x.para = false;
        } else if (!again && comp.length >= this.fragLimit(root)) {
          for (const x of comp) { x.para = true; x.paraT = comp.length * 2; x.paraStart = w.t; }
          keep = true;
        }
      } else if (CFG.FRAGMENT && !again && comp.length >= 4 && comp.length >= this.fragLimit(root)) {
        // Reproduction by fragmentation: a colony that can grow no further splits in two.
        this.fragment(comp, root); split = true;
      }
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
        const nt = keep || (CFG.GERM_KEEP && x.germKept && x.type === T_GERM) ? x.type : this.differentiate(x, size, w.lightAt(x.x, x.y));
        if (!keep) x.fated = true;
        if (nt !== x.type) { x.type = nt; x.sv++; }
        // Doing every job at once costs a colony's generalists more the bigger it is (TRADEOFF), and its
        // specialists get better at their one job (SPEC_BONUS).
        const sz = Math.min(1, (size - 1) / 15);
        const gf = x.type === T_GENERIC ? (CFG.TRADEOFF > 0 ? Math.max(0.2, 1 - CFG.TRADEOFF * sz) : 1) : 1 + CFG.SPEC_BONUS * sz;
        if (gf !== x.gf) { x.gf = gf; x.sv++; }
        org.types[x.type]++;
        org.x += x.x; org.y += x.y;
      }
      org.x /= size; org.y /= size;
      if (CFG.DEVPLAN) for (const x of comp) x.orad = Math.hypot(x.x - org.x, x.y - org.y) / x.r;
      // Larger eukaryotic bodies set a germline aside (GERM_SETASIDE) if none of their cells chose it.
      if (CFG.GERM_SETASIDE > 0 && !keep && root.mito && size >= CFG.GERM_SETASIDE && org.types[T_GERM] === 0) {
        const o = Gn.DIFF + T_GERM * Gn.NDIFF_IN;
        let best = null, bs = -0.5;
        for (const x of comp) {
          if (!x.mito) continue;
          const g = x.g, light = w.lightAt(x.x, x.y);
          const s = g[o] + g[o + 1] * (x.bonds.length / 4) + g[o + 2] * Math.min(1, x.depth / 6) + g[o + 3] * Math.min(1, size / 30) + g[o + 4] * light;
          if (s > bs || (best && s === bs && x.bonds.length > best.bonds.length)) { bs = s; best = x; }
        }
        if (best) {
          org.types[best.type]--; org.types[T_GERM]++;
          best.type = T_GERM; best.germKept = true;
          best.gf = 1 + CFG.SPEC_BONUS * Math.min(1, (size - 1) / 15);
          best.sv++;
        }
      }
      let special = 0;
      for (let t = 1; t < 6; t++) if (org.types[t] > 0) special++;
      if (size >= 16 && special >= 3 && org.types[T_GERM] > 0 && (!CFG.REALISTIC_MULTI || root.mito)) org.kind = 'complex';
      else if (size >= 8 && special >= 2) org.kind = 'multicellular';
      orgs.push(org);
    }
    orgs.sort((a, b) => b.size - a.size);
    this.organisms = orgs;
    if (split) this.updateOrganisms(true); // (the halves are colonies of their own)
  }

  // How big this colony may grow: its colony-size gene, and with REALISTIC_MULTI the oxygen-limited body size.
  fragLimit(root) {
    return CFG.REALISTIC_MULTI ? Math.min(root.colMax, this.bodyLimit(root)) : root.colMax;
  }

  // Split a colony into two connected halves, grown outward from its founder and from a cell far from it (the
  // farthest, or with balanced = true whichever of the farthest few gives the closest match in size and cell types).
  fragment(comp, root, balanced = false) {
    const st = ++this.stamp;
    root._ds = st;
    const order = [root];
    for (let k = 0; k < order.length; k++) for (const o of order[k].bonds) if (o._ds !== st) { o._ds = st; order.push(o); }
    const halves = (far) => {
      const side = new Map(), qa = [root], qb = [far];
      side.set(root, 0); side.set(far, 1);
      for (let ia = 0, ib = 0; ia < qa.length || ib < qb.length;) {
        for (const [qq, s, k] of [[qa, 0, ia], [qb, 1, ib]]) {
          if (k >= qq.length) continue;
          for (const o of qq[k].bonds) if (!side.has(o)) { side.set(o, s); qq.push(o); }
        }
        ia++; ib++;
      }
      return side;
    };
    let side = halves(order[order.length - 1]);
    if (balanced) {
      let best = Infinity;
      for (let k = order.length - 1; k >= Math.max(1, order.length - 8); k--) {
        const sd = halves(order[k]), d = new Array(Gn.NTYPES + 1).fill(0);
        for (const c of comp) { const v = sd.get(c) ? -1 : 1; d[c.type] += v; d[Gn.NTYPES] += v; }
        let score = 2 * Math.abs(d[Gn.NTYPES]);
        for (let t = 0; t < Gn.NTYPES; t++) score += Math.abs(d[t]);
        if (score < best) { best = score; side = sd; }
      }
    }
    const cut = [];
    for (const c of comp) for (const o of c.bonds) if (side.get(c) === 0 && side.get(o) === 1) cut.push(c, o);
    for (let i = 0; i < cut.length; i += 2) unlink(cut[i], cut[i + 1]);
    this.fragments++;
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
    let best = 0, bs = -1e9, cur = -1e9;
    for (let t = 0; t < Gn.NTYPES; t++) {
      if (prok && (t === T_MOUTH || t === T_GERM)) continue;
      const o = Gn.DIFF + t * Gn.NDIFF_IN;
      let s = g[o] + g[o + 1] * i1 + g[o + 2] * i2 + g[o + 3] * i3 + g[o + 4] * light;
      if (t === 0) s += CFG.GENERALIST_BIAS;
      if (t === x.type) cur = s;
      if (s > bs) { bs = s; best = t; }
    }
    // Commitment: switching jobs needs a clear reason, not a small nudge in its cues.
    // (A newborn chooses freely first: it inherited its parent's job, not one fitted to its own place.)
    if (x.fated && best !== x.type && cur > -1e9 && bs < cur + CFG.FATE_COMMIT) return x.type;
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
