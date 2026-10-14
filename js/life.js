// Living cells: metabolism, behaviour, reproduction with mutation, predation,
// endosymbiosis, horizontal gene transfer, colonies, cell differentiation and speciation.
import { CFG } from './config.js';
import { SpatialHash } from './spatial.js';
import * as Gn from './genome.js';

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

const GR = { x: 0, y: 0 };
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
    decode(this);
  }
}

export function decode(c) {
  const g = c.g;
  c.r = c.mito ? 4 + g[Gn.SIZE] * 9 : 2.5 + g[Gn.SIZE] * 5;
  c.area = (c.r / 5) * (c.r / 5);
  const p = g[Gn.PHOTO], ch = g[Gn.CHEMO], h = g[Gn.HETERO], pr = g[Gn.PRED];
  const tot = p + ch + h + pr + 0.05;
  const eff = (x) => Math.pow(x / tot, CFG.SPECIALIZE);
  c.effP = eff(p); c.effC = eff(ch); c.effH = eff(h); c.effPred = eff(pr);
  c.motil = g[Gn.MOTIL];
  c.aer = g[Gn.AEROBIC];
  c.armor = g[Gn.ARMOR];
  c.adh = g[Gn.ADHES];
  c.share = g[Gn.SHARE];
  c.cap = CFG.CAP_K * c.area * (c.mito ? 2.2 : 1);
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
  c.nutNeed = c.area * CFG.NUT_PER_AREA * 2; // enough body material for two cells
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
    this.deaths = { starved: 0, eaten: 0, aged: 0, oxygen: 0, virus: 0, impact: 0 };
    this.stats = { photo: 0, chemo: 0, hetero: 0, pred: 0, euk: 0, plastid: 0, aerobic: 0, inColonies: 0, multicellular: 0, complex: 0, largest: 0, maxGen: 0, speciesAlive: 0, multiSpecies: 0 };
  }

  makeCell(x, y, g, parent) {
    return new Cell(this.nextId++, x, y, g, parent);
  }

  spawnFromProtocell(v, poly) {
    const c = this.makeCell(v.x, v.y, Gn.fromSequence(poly.seq), null);
    c.energy = c.cap * 0.5;
    c.nut = c.nutNeed * 0.5;
    c.origin = ++this.origins;
    c.born = this.w.t;
    c.species = this.newSpecies(c, 0).id;
    c.founderSeq = poly.seq.slice();
    this.newborns.push(c);
    this.w.milestone('cell', 'A protocell becomes a self-sustaining living cell (abiogenesis)');
    this.w.log(`Abiogenesis event #${c.origin}: a new lineage of life is born`);
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

    for (let i = 0; i < n; i++) if (!cells[i].dead) this.live(cells[i]);
    this.interact();
    this.relax();
    this.physics();

    let anyDead = false;
    for (let i = 0; i < n; i++) if (cells[i].dead) { anyDead = true; break; }
    this.cells = anyDead ? cells.filter((c) => !c.dead) : cells;
    for (const c of this.newborns) if (!c.dead) this.cells.push(c);
    this.newborns = [];

    if (this.w.t % 10 === 0) this.updateOrganisms();
  }

  live(c) {
    const w = this.w, F = w.fields, rng = w.rng, g = c.g, tm = TM[c.type];
    c.age++;
    const crowd = this.hash.countAt(c.x, c.y);
    let light = w.lightAt(c.x, c.y);
    if (crowd > 4) light /= 1 + (crowd - 4) * 0.2; // self-shading
    const o2 = F.get(F.oxygen, c.x, c.y);
    const o2f = o2 > CFG.O2_REF ? 1 : o2 / CFG.O2_REF;
    const resp = 1 + c.aer * CFG.AERO_BONUS * o2f * (c.mito ? 2.5 : 1);

    let gain = 0;
    const ep = c.effP * tm[0];
    if (ep > 0) {
      const gp = light * CFG.PHOTO_K * c.area * ep * (c.plastid ? 1.8 : 1);
      gain += gp;
      // Oxygenic photosynthesis needs strong light; dim vent-light photosynthesis is anoxygenic.
      const sun = w.sunAt(c.y);
      F.add(F.oxygen, c.x, c.y, gp * CFG.O2_YIELD * Math.min(1, sun * 2));
    }
    const ec = c.effC * tm[1];
    if (ec > 0) gain += F.take(F.chem, c.x, c.y, CFG.CHEMO_K * c.area * ec) * CFG.CHEMO_EFF;
    const eh = c.effH * tm[2];
    if (eh > 0) gain += F.take(F.organic, c.x, c.y, CFG.HET_K * c.area * eh) * CFG.HET_EFF * resp;

    let cost = CFG.BASE_COST * c.area * (c.mito ? 1.25 : 1) * tm[6] * (1 + 0.25 * g[Gn.LIFESPAN])
      + c.aer * CFG.AER_COST * c.area
      + c.armor * tm[5] * CFG.ARM_COST * c.area
      + c.adh * CFG.ADH_COST
      + (c.effP + c.effC + c.effH + c.effPred) * CFG.MACHINE_COST * c.area;
    // Oxygen is toxic to cells without antioxidant / aerobic machinery.
    const tox = o2f - 1.3 * c.aer - (g[Gn.PHOTO] > 0.4 ? 0.3 : 0);
    let toxCost = 0;
    if (tox > 0) toxCost = tox * CFG.TOX * c.area;
    c.energy += gain - cost - toxCost;
    if (c.energy > c.cap) c.energy = c.cap;

    this.steer(c, tm);

    // Building a body needs scarce nutrient: this is what really limits the biosphere.
    if (c.nut < c.nutNeed) c.nut += F.take(F.nutrient, c.x, c.y, Math.min(c.nutNeed - c.nut, CFG.NUT_UPTAKE * c.area));

    if (c.energy <= 0) { this.kill(c, toxCost > cost * 0.5 ? 'oxygen' : 'starved', false); return; }
    if (c.age > c.lifespan || rng.next() < 0.00003) { this.kill(c, 'aged', false); return; }
    // "Kill the winner": phages spread fastest through dense mats of free-living cells.
    let lysis = crowd > 10 && c.orgSize === 1 ? CFG.VIRAL_LYSIS * (crowd - 10) : 0;
    // Near the population ceiling epidemics sweep the ocean, so births never stall.
    const fill = this.cells.length / CFG.MAX_CELLS;
    if (fill > 0.85) lysis += (fill - 0.85) * 0.02;
    if (lysis > 0 && rng.next() < lysis) { this.kill(c, 'virus', false); return; }

    // A germline cell full of energy buds off to found a new organism.
    if (c.type === T_GERM && c.bonds.length && c.orgSize >= 6 && c.energy > 0.7 * c.cap) {
      const fromOrganism = c.orgSize >= 8;
      for (const o of c.bonds.slice()) unlink(c, o);
      c.type = T_GENERIC; c.orgSize = 1; c.org = c.id;
      if (fromOrganism && this.w.mset.has('multicellular')) this.w.milestone('germline', 'A germline cell buds off to found the next generation of a multicellular organism');
    }

    if (c.energy > c.cap * c.divFrac && c.nut >= c.nutNeed && c.age > CFG.MIN_DIV_AGE && this.cells.length + this.newborns.length < CFG.MAX_CELLS) {
      this.divide(c);
    }
  }

  steer(c, tm) {
    const mot = c.motil * tm[4];
    if (mot < 0.03) return;
    const w = this.w, F = w.fields, g = c.g, rng = w.rng;
    if ((c.id + w.t) % 6 === 0) this.sense(c);
    let dx = 0, dy = 0;
    F.grad(F.chem, c.x, c.y, GR); dx += GR.x * g[Gn.W_CHEM]; dy += GR.y * g[Gn.W_CHEM];
    F.grad(F.organic, c.x, c.y, GR); dx += GR.x * g[Gn.W_ORG]; dy += GR.y * g[Gn.W_ORG];
    F.grad(F.oxygen, c.x, c.y, GR); dx += GR.x * g[Gn.W_OXY]; dy += GR.y * g[Gn.W_OXY];
    dy -= g[Gn.W_LIGHT] * 0.8; // phototaxis: light comes from above
    dx += c.px * g[Gn.W_PREY] + c.fx * g[Gn.W_FLEE];
    dy += c.py * g[Gn.W_PREY] + c.fy * g[Gn.W_FLEE];
    c.heading += (rng.next() - 0.5) * 0.5;
    dx += Math.cos(c.heading) * 0.3;
    dy += Math.sin(c.heading) * 0.3;
    const m = Math.hypot(dx, dy) || 1;
    const th = (mot * CFG.MOT_SPEED) / Math.sqrt(c.area);
    c.vx += (dx / m) * th;
    c.vy += (dy / m) * th;
    c.energy -= mot * CFG.MOT_COST * c.area;
  }

  sense(c) {
    c.px = c.py = c.fx = c.fy = 0;
    const cells = this.cells, s2 = c.sense * c.sense;
    const hunts = c.effPred > 0.05;
    let bp = 1e9, bf = 1e9;
    this.hash.query(c.x, c.y, c.sense, (j) => {
      const o = cells[j];
      if (o === c || o.dead || o.org === c.org) return;
      const dx = o.x - c.x, dy = o.y - c.y, d2 = dx * dx + dy * dy;
      if (d2 > s2) return;
      if (hunts && o.r * 1.2 < c.r && d2 < bp) { bp = d2; c.px = dx; c.py = dy; }
      if (o.effPred > 0.05 && o.r > c.r * 1.2 && d2 < bf) { bf = d2; c.fx = -dx; c.fy = -dy; }
    });
    let m = Math.hypot(c.px, c.py); if (m > 0) { c.px /= m; c.py /= m; }
    m = Math.hypot(c.fx, c.fy); if (m > 0) { c.fx /= m; c.fy /= m; }
  }

  divide(c) {
    const rng = this.w.rng;
    const g = Gn.mutate(c.g, rng);
    const ang = rng.next() * 6.283;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const child = this.makeCell(c.x + ca * c.r * 0.6, c.y + sa * c.r * 0.6, g, c);
    c.x -= ca * c.r * 0.4; c.y -= sa * c.r * 0.4;
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
    if (c.type !== T_GERM && c.orgSize < c.colMax && c.bonds.length < CFG.MAX_BONDS && rng.next() < c.adh) {
      link(c, child);
      child.org = c.org;
      child.orgSize = ++c.orgSize;
      child.type = c.type;
    }
    this.newborns.push(child);
    this.births++;
  }

  kill(c, cause, eaten) {
    if (c.dead) return;
    c.dead = true;
    this.deaths[cause] = (this.deaths[cause] || 0) + 1;
    if (!eaten) {
      const F = this.w.fields;
      F.add(F.organic, c.x, c.y, (Math.max(0, c.energy) * 0.5 + c.area * 8) * CFG.DEATH_ORG);
      F.add(F.nutrient, c.x, c.y, c.nut);
      c.nut = 0;
    }
    for (const o of c.bonds.slice()) unlink(c, o);
  }

  // Collisions, predation and horizontal gene transfer.
  interact() {
    const cells = this.cells, n = cells.length, rng = this.w.rng, maxR = CFG.MAX_R;
    for (let i = 0; i < n; i++) {
      const a = cells[i];
      if (a.dead) continue;
      this.hash.query(a.x, a.y, a.r + maxR, (j) => {
        if (j <= i || a.dead) return;
        const b = cells[j];
        if (b.dead) return;
        const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy, rr = a.r + b.r;
        if (d2 >= rr * rr) return;
        const d = Math.sqrt(d2) || 0.01;
        const nx = dx / d, ny = dy / d, ov = (rr - d) * 0.8, s = a.area + b.area; // membranes barely interpenetrate
        a.x -= nx * ov * (b.area / s); a.y -= ny * ov * (b.area / s);
        b.x += nx * ov * (a.area / s); b.y += ny * ov * (a.area / s);
        if (a.org === b.org) return;
        if (!this.tryEat(a, b)) this.tryEat(b, a);
        if (!a.dead && !b.dead && rng.next() < CFG.HGT_P) this.transferGene(a, b);
      });
    }
  }

  // A colony behaves like one big body for engulfment purposes.
  // Extra position-only pass so densely packed cells don't interpenetrate (visible at true scale).
  relax() {
    const cells = this.cells, n = cells.length, maxR = CFG.MAX_R;
    for (let i = 0; i < n; i++) {
      const a = cells[i];
      if (a.dead) continue;
      this.hash.query(a.x, a.y, a.r + maxR, (j) => {
        if (j <= i) return;
        const b = cells[j];
        if (b.dead) return;
        const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy, rr = (a.r + b.r) * 0.97;
        if (d2 >= rr * rr) return;
        const d = Math.sqrt(d2) || 0.01, ov = (rr - d) * 0.7, s = a.area + b.area;
        a.x -= (dx / d) * ov * (b.area / s); a.y -= (dy / d) * ov * (b.area / s);
        b.x += (dx / d) * ov * (a.area / s); b.y += (dy / d) * ov * (a.area / s);
      });
    }
  }

  bodyRadius(c) { return c.orgSize > 1 ? c.r * Math.sqrt(c.orgSize) * 0.8 : c.r; }

  tryEat(a, b) {
    if (a.dead || b.dead) return false;
    const pa = a.effPred * TM[a.type][3];
    if (pa < 0.04) return false;
    // Prey must be engulfable. Being part of a large colony is a defence (cf. Boraas' predation experiments).
    if (this.bodyRadius(a) < this.bodyRadius(b) * 1.2) return false;
    const rng = this.w.rng;
    const def = Math.min(0.95, b.armor * TM[b.type][5] * 0.8);
    if (rng.next() > pa * (1 - def) * CFG.PRED_P) return false;
    const F = this.w.fields;
    const o2f = Math.min(1, F.get(F.oxygen, a.x, a.y) / CFG.O2_REF);
    const resp = 1 + a.aer * CFG.AERO_BONUS * o2f * (a.mito ? 2.5 : 1);
    a.energy = Math.min(a.cap, a.energy + (Math.max(0, b.energy) * 0.6 + b.area * 6) * (0.6 + 0.4 * resp));
    this.w.milestone('predator', 'The first predator engulfs another cell');
    a.nut += b.nut;
    b.nut = 0;
    if (a.nut > a.nutNeed) { F.add(F.nutrient, a.x, a.y, a.nut - a.nutNeed); a.nut = a.nutNeed; }

    // Endosymbiosis: sometimes the meal survives inside its host.
    if (!a.mito && b.aer > 0.5 && o2f > 0.15 && rng.next() < CFG.ENDO_P) {
      a.mito = true;
      decode(a);
      a.species = this.newSpecies(a, a.species).id;
      this.species.get(a.species).euk = true;
      this.w.milestone('eukaryote', 'Endosymbiosis! An engulfed aerobe becomes a mitochondrion: the first eukaryote');
    } else if (a.mito && !a.plastid && b.effP > 0.25 && rng.next() < CFG.ENDO_P) {
      a.plastid = true;
      decode(a);
      a.species = this.newSpecies(a, a.species).id;
      this.species.get(a.species).euk = true;
      this.w.milestone('plastid', 'A eukaryote keeps a photosynthetic cell as a chloroplast: the first alga');
    }
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
    this.w.milestone('hgt', 'Horizontal gene transfer: two microbes swap genes');
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

    for (const c of cells) {
      if (c.dead) continue;
      this.w.current(c.x, c.y, CUR);
      c.vx += (rng.next() - 0.5) * 0.1 + CUR.x * 0.25;
      c.vy += (rng.next() - 0.5) * 0.1 + CUR.y * 0.25 + this.w.plume(c.x, c.y) * 0.12;
      c.x += c.vx; c.y += c.vy;
      c.vx *= damp; c.vy *= damp;
      if (c.x < c.r) { c.x = c.r; c.vx = Math.abs(c.vx) * 0.5; } else if (c.x > W - c.r) { c.x = W - c.r; c.vx = -Math.abs(c.vx) * 0.5; }
      if (c.y < c.r) { c.y = c.r; c.vy = Math.abs(c.vy) * 0.5; } else if (c.y > H - c.r) { c.y = H - c.r; c.vy = -Math.abs(c.vy) * 0.5; }
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
      if (size >= 16 && special >= 3 && org.types[T_GERM] > 0) org.kind = 'complex';
      else if (size >= 8 && special >= 2) org.kind = 'multicellular';
      orgs.push(org);
    }
    orgs.sort((a, b) => b.size - a.size);
    this.organisms = orgs;
  }

  differentiate(x, size, light) {
    const g = x.g;
    const i1 = x.bonds.length / 4, i2 = Math.min(1, x.depth / 6), i3 = Math.min(1, size / 30);
    let best = 0, bs = -1e9;
    for (let t = 0; t < Gn.NTYPES; t++) {
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
    for (const s of this.species.values()) s.count = 0;
    for (const c of this.cells) {
      if (c.troph === 0) st.photo++; else if (c.troph === 1) st.chemo++; else if (c.troph === 2) st.hetero++; else st.pred++;
      if (c.effP > 0.15) st.photosynthesizers++;
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
