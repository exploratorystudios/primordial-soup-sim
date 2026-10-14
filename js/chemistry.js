// Prebiotic chemistry: monomers -> polymers -> self-replicating ribozymes -> lipid vesicles -> protocells.
import { CFG } from './config.js';
import { SpatialHash } from './spatial.js';

export const LIPID = 4;
export const BASES = ['A', 'U', 'G', 'C'];

export class Soup {
  constructor(world) {
    this.world = world;
    const M = CFG.MAX_MONOMERS + 256;
    this.cap = M;
    this.mx = new Float32Array(M);
    this.my = new Float32Array(M);
    this.mt = new Uint8Array(M);
    this.mdead = new Uint8Array(M);
    this.mid = new Int32Array(M); // stable identity, so a single molecule can be followed
    this.nextMid = 1;
    this.n = 0;
    this.builtN = 0;
    this.hash = new SpatialHash(CFG.W, CFG.H, CFG.HASH_CELL);
    this.polymers = [];
    this.newPolys = [];
    this.vesicles = [];
    this.vesId = 1;
    // Rugged "fitness landscape" over base triplets: which local motifs help a chain fold into a catalyst.
    this.landscape = new Float32Array(64);
    for (let i = 0; i < 64; i++) this.landscape[i] = world.rng.next();
    this.stats = { maxLen: 0, bestAct: 0, replicators: 0, protocells: 0, copies: 0 };
    this._nb = [];
    this._cur = { x: 0, y: 0 };
  }

  // ---------------------------------------------------------------- monomers
  addMonomer(x, y, t) {
    if (this.n >= this.cap) return false;
    const i = this.n++;
    this.mx[i] = x; this.my[i] = y; this.mt[i] = t; this.mdead[i] = 0; this.mid[i] = this.nextMid++;
    return true;
  }

  kill(j) { this.mdead[j] = 1; }

  findMonomer(x, y, r, type) {
    const mx = this.mx, my = this.my, mt = this.mt, md = this.mdead, r2 = r * r;
    let best = -1;
    this.hash.query(x, y, r, (j) => {
      if (md[j]) return false;
      const t = mt[j];
      if (type === -1 ? t === LIPID : t !== type) return false;
      const dx = mx[j] - x, dy = my[j] - y;
      if (dx * dx + dy * dy < r2) { best = j; return true; }
      return false;
    });
    return best;
  }

  energyAt(x, y) {
    const F = this.world.fields;
    const c = F.get(F.chem, x, y);
    let e = c / (c + CFG.CHEM_HALF);
    if (y > CFG.H - 90) e += 0.2; // mineral surfaces (clays, pyrite) catalyse polymerisation
    return e > 1 ? 1 : e;
  }

  // ---------------------------------------------------------------- polymers
  makePolymer(seq, x, y) {
    const p = { x, y, ang: this.world.rng.next() * 6.283, seq, act: 0, fid: 0.8, stab: 0, prog: 0, copy: [], dead: false };
    this.evalPolymer(p);
    return p;
  }

  evalPolymer(p) {
    const s = p.seq, L = s.length;
    let gc = 0;
    for (let i = 0; i < L; i++) if (s[i] >= 2) gc++;
    p.stab = gc / L; // G–C pairs have three hydrogen bonds: more stable
    if (L > this.stats.maxLen) this.stats.maxLen = L;
    if (L < CFG.MIN_ACTIVE_LEN) { p.act = 0; p.fid = 0.8; return; }
    // Fold: complementary ends (A-U, G-C) pair up into a hairpin, like a real ribozyme stem.
    const h = L >> 1;
    let pairs = 0;
    for (let i = 0; i < h; i++) {
      const a = s[i], b = s[L - 1 - i];
      if ((a === 0 && b === 1) || (a === 1 && b === 0) || (a === 2 && b === 3) || (a === 3 && b === 2)) pairs++;
    }
    const fold = pairs / h;
    let land = 0;
    for (let i = 0; i <= L - 3; i++) land += this.landscape[s[i] * 16 + s[i + 1] * 4 + s[i + 2]];
    land /= L - 2;
    let a = (0.5 * fold + 0.5 * land - 0.45) * 2.5;
    a *= Math.min(1, (L - CFG.MIN_ACTIVE_LEN + 1) / 6);
    p.act = a < 0 ? 0 : a > 1 ? 1 : a;
    p.fid = 0.92 + 0.075 * p.act; // better ribozymes copy more accurately (error threshold)
    if (p.act > this.stats.bestAct) this.stats.bestAct = p.act;
  }

  // Once life is abundant it devours the prebiotic soup, which shrinks to a remnant.
  get scale() { return this.world.life.cells.length > 300 ? 0.35 : 1; }

  canAddPolymer() {
    return this.polymers.length + this.newPolys.length < CFG.MAX_POLYMERS * this.scale;
  }

  finishCopy(p) {
    const rng = this.world.rng;
    let seq = p.copy;
    if (seq.length > 2 && rng.next() < 0.01) seq.splice(rng.int(seq.length), 1);
    if (seq.length < CFG.MAX_POLY_LEN && rng.next() < 0.01) seq.splice(rng.int(seq.length), 0, rng.int(4));
    p.copy = [];
    p.prog = 0;
    this.stats.copies++;
    return seq;
  }

  breakPolymer(p, into) {
    const rng = this.world.rng;
    const L = p.seq.length;
    const k = 1 + rng.int(L - 1);
    for (const piece of [p.seq.slice(0, k), p.seq.slice(k)]) {
      if (piece.length === 1) {
        if (into) into.pool[piece[0]]++;
        else this.addMonomer(p.x + rng.range(-2, 2), p.y + rng.range(-2, 2), piece[0]);
      } else if (into) {
        into.polys.push(this.makePolymer(piece, p.x, p.y));
      } else if (this.canAddPolymer()) {
        this.newPolys.push(this.makePolymer(piece, p.x + rng.range(-2, 2), p.y + rng.range(-2, 2)));
      } else {
        for (const t of piece) this.addMonomer(p.x, p.y, t);
      }
    }
  }

  // ------------------------------------------------------------------- step
  step() {
    this.spawn();
    this.moveMonomers();
    this.builtN = this.n;
    this.hash.build(this.n, this.mx, this.my);
    this.stepLipids();
    this.dimerize();
    this.stepVesicles();
    this.stepPolymers();
    this.compact();
    if (this.world.t % 25 === 0) this.census();
  }

  spawn() {
    const w = this.world, rng = w.rng;
    if (this.n > CFG.MAX_MONOMERS * this.scale) return;
    for (const v of w.vents) {
      let rate = CFG.VENT_MONOMER_RATE * v.strength * w.ventMul;
      while (rate > 0) {
        if (rng.next() < rate) {
          const t = rng.next() < CFG.LIPID_FRACTION ? LIPID : rng.int(4);
          this.addMonomer(v.x + rng.gauss() * 10, CFG.H - 12 - rng.next() * 10, t);
        }
        rate -= 1;
      }
    }
    if (rng.next() < CFG.SURFACE_MONOMER_RATE) {
      const t = rng.next() < CFG.LIPID_FRACTION * 0.5 ? LIPID : rng.int(4);
      this.addMonomer(rng.next() * CFG.W, rng.next() * 40, t);
    }
  }

  moveMonomers() {
    const w = this.world, rng = w.rng, F = w.fields;
    const mx = this.mx, my = this.my, md = this.mdead, D = CFG.MONO_DIFFUSION * 2;
    const W = CFG.W, H = CFG.H, cur = this._cur;
    for (let i = 0; i < this.n; i++) {
      if (md[i]) continue;
      if (rng.next() < CFG.MONOMER_DECAY * (this.scale < 1 ? 4 : 1)) { md[i] = 1; F.add(F.organic, mx[i], my[i], 0.4); continue; }
      w.current(mx[i], my[i], cur);
      let x = mx[i] + (rng.next() - 0.5) * D + cur.x;
      let y = my[i] + (rng.next() - 0.5) * D + cur.y + w.plume(x, my[i]);
      if (x < 0) x = -x; else if (x > W) x = 2 * W - x;
      if (y < 0) y = -y; else if (y > H) y = 2 * H - y;
      mx[i] = x; my[i] = y;
    }
  }

  stepLipids() {
    const mx = this.mx, my = this.my, mt = this.mt, md = this.mdead, nb = this._nb;
    const parity = this.world.t & 1; // half the lipids per tick
    for (let i = parity; i < this.builtN; i += 2) {
      if (md[i] || mt[i] !== LIPID) continue;
      const x = mx[i], y = my[i];
      let sx = 0, sy = 0;
      nb.length = 0;
      this.hash.query(x, y, 9, (j) => {
        if (j === i || md[j] || mt[j] !== LIPID) return;
        const dx = mx[j] - x, dy = my[j] - y;
        if (dx * dx + dy * dy < 81) { sx += mx[j]; sy += my[j]; nb.push(j); }
      });
      const c = nb.length;
      if (c === 0) continue;
      // Hydrophobic tails cluster together.
      mx[i] += (sx / c - x) * 0.2;
      my[i] += (sy / c - y) * 0.2;
      if (c + 1 >= CFG.VES_NUCLEATE && this.vesicles.length < CFG.MAX_VESICLES * this.scale) {
        this.vesicles.push(this.makeVesicle((sx + x) / (c + 1), (sy + y) / (c + 1), c + 1, 0));
        md[i] = 1;
        for (const j of nb) md[j] = 1;
        this.world.milestone('vesicle', 'Lipids self-assemble into the first membrane vesicle');
      }
    }
  }

  dimerize() {
    const rng = this.world.rng, md = this.mdead, mt = this.mt;
    if (this.builtN < 2) return;
    for (let s = 0; s < CFG.DIMER_SAMPLES; s++) {
      if (!this.canAddPolymer()) return;
      const i = rng.int(this.builtN);
      if (md[i] || mt[i] === LIPID) continue;
      const x = this.mx[i], y = this.my[i];
      if (rng.next() > CFG.DIMER_RATE * this.energyAt(x, y)) continue;
      md[i] = 1;
      const j = this.findMonomer(x, y, 4, -1);
      if (j < 0) { md[i] = 0; continue; }
      md[j] = 1;
      this.newPolys.push(this.makePolymer([mt[i], mt[j]], x, y));
    }
  }

  stepPolymers() {
    const w = this.world, rng = w.rng, cur = this._cur;
    const out = [];
    const pending = this.newPolys; // created earlier this tick (dimers, burst vesicles)
    this.newPolys = [];
    for (const p of this.polymers) {
      if (p.dead) continue;
      const L = p.seq.length;
      const D = (CFG.MONO_DIFFUSION * 2) / Math.sqrt(L);
      w.current(p.x, p.y, cur);
      p.x += (rng.next() - 0.5) * D + cur.x;
      p.y += (rng.next() - 0.5) * D + cur.y + w.plume(p.x, p.y) * 0.7;
      if (p.x < 0) p.x = -p.x; else if (p.x > CFG.W) p.x = 2 * CFG.W - p.x;
      if (p.y < 0) p.y = -p.y; else if (p.y > CFG.H) p.y = 2 * CFG.H - p.y;
      p.ang += (rng.next() - 0.5) * 0.2;
      const e = this.energyAt(p.x, p.y);

      // Chain elongation by condensation.
      if (L < CFG.MAX_POLY_LEN && p.prog === 0 && rng.next() < CFG.POLY_RATE * e) {
        const j = this.findMonomer(p.x, p.y, 5, -1);
        if (j >= 0) { p.seq.push(this.mt[j]); this.kill(j); this.evalPolymer(p); }
      }

      // Template-directed self-replication.
      if (p.act > 0 && rng.next() < (0.15 + p.act) * CFG.REP_RATE * (0.3 + 0.7 * e)) {
        const need = p.seq[p.prog];
        const mutate = rng.next() > p.fid;
        const j = this.findMonomer(p.x, p.y, 8, mutate ? -1 : need);
        if (j >= 0) {
          p.copy.push(this.mt[j]);
          this.kill(j);
          p.prog++;
          if (p.prog >= p.seq.length) {
            const seq = this.finishCopy(p);
            if (this.canAddPolymer()) {
              this.newPolys.push(this.makePolymer(seq, p.x + rng.range(-3, 3), p.y + rng.range(-3, 3)));
              w.milestone('replicator', 'A ribozyme copies itself: the RNA world begins');
            }
          }
        }
      }

      // Hydrolysis, accelerated by surface UV.
      const uv = w.lightAt(p.x, p.y) * CFG.UV_DAMAGE;
      if (rng.next() < CFG.HYDROLYSIS * p.seq.length * (1 - 0.5 * p.stab) * (1 + uv)) {
        this.breakPolymer(p, null);
        continue;
      }
      if (p.seq.length >= 5) w.milestone('polymer', 'Monomers link into the first long polymer chain');
      out.push(p);
    }
    for (const p of pending) out.push(p);
    for (const p of this.newPolys) out.push(p);
    this.newPolys = [];
    this.polymers = out;
  }

  // --------------------------------------------------------------- vesicles
  makeVesicle(x, y, L, gen) {
    return { id: this.vesId++, x, y, L, r: 2.5 + Math.sqrt(L) * 1.25, polys: [], pool: [0, 0, 0, 0], gen, copies: 0, dead: false, age: 0 };
  }

  stepVesicles() {
    const w = this.world, rng = w.rng, cur = this._cur;
    const mx = this.mx, my = this.my, mt = this.mt, md = this.mdead;
    const out = [];
    for (const v of this.vesicles) {
      if (v.dead) continue;
      v.age++;
      w.current(v.x, v.y, cur);
      v.x += (rng.next() - 0.5) * 0.8 + cur.x * 0.7;
      v.y += (rng.next() - 0.5) * 0.8 + cur.y * 0.7 + w.plume(v.x, v.y) * 0.4;
      v.r = 2.5 + Math.sqrt(v.L) * 1.25;
      if (v.x < v.r) v.x = v.r; else if (v.x > CFG.W - v.r) v.x = CFG.W - v.r;
      if (v.y < v.r) v.y = v.r; else if (v.y > CFG.H - v.r) v.y = CFG.H - v.r;
      const np = v.polys.length;

      // Absorb lipids (grow) and nucleotides (fatty-acid membranes are permeable to them).
      const rr = v.r + 1.5, rr2 = rr * rr;
      let poolTotal = v.pool[0] + v.pool[1] + v.pool[2] + v.pool[3];
      this.hash.query(v.x, v.y, rr, (j) => {
        if (md[j]) return;
        const dx = mx[j] - v.x, dy = my[j] - v.y;
        if (dx * dx + dy * dy > rr2) return;
        if (mt[j] === LIPID) {
          // Vesicles full of RNA swell osmotically and steal membrane from their neighbours.
          if (rng.next() < 0.25 + 0.12 * np) { v.L++; md[j] = 1; }
        } else if (poolTotal < CFG.VES_POOL && rng.next() < 0.5) {
          v.pool[mt[j]]++; poolTotal++; md[j] = 1;
        }
      });

      if (v.L > 5 && rng.next() < CFG.VES_LIPID_LOSS / (1 + np)) {
        v.L--;
        const a = rng.next() * 6.283;
        this.addMonomer(v.x + Math.cos(a) * (v.r + 2), v.y + Math.sin(a) * (v.r + 2), LIPID);
      }

      // Occasionally a free polymer gets trapped inside.
      if ((w.t + v.id) % 4 === 0) {
        const r2 = v.r * v.r;
        for (const p of this.polymers) {
          if (p.dead) continue;
          const dx = p.x - v.x, dy = p.y - v.y;
          if (dx * dx + dy * dy < r2 && rng.next() < 0.12) {
            p.dead = true;
            const q = this.makePolymer(p.seq, v.x, v.y);
            v.polys.push(q);
          }
        }
      }

      this.stepInternal(v);

      const crowded = this.vesicles.length > CFG.MAX_VESICLES * this.scale;
      if (v.polys.length > CFG.VES_MAX_POLY || rng.next() < CFG.VES_BURST * (crowded ? 20 : 1)) {
        this.burst(v);
        continue;
      }

      if (v.L >= CFG.VES_SPLIT) {
        const [a, b] = this.split(v);
        out.push(a, b);
        continue;
      }

      // Protocell -> cell transition.
      // Needs heredity (completed self-copies) plus a lineage of divisions.
      if (v.gen >= CFG.CELL_GEN && v.copies >= CFG.CELL_COPIES && w.life.cells.length < CFG.MAX_ORIGINS_POP) {
        let best = null, active = 0;
        for (const p of v.polys) if (p.act > 0) { active++; if (!best || p.act > best.act) best = p; }
        if (best && best.act >= CFG.CELL_ACT && active >= 2) {
          w.life.spawnFromProtocell(v, best);
          continue;
        }
      }
      out.push(v);
    }
    this.vesicles = out;
  }

  pickPool(v) {
    const tot = v.pool[0] + v.pool[1] + v.pool[2] + v.pool[3];
    if (tot === 0) return -1;
    let r = this.world.rng.next() * tot;
    for (let t = 0; t < 4; t++) { r -= v.pool[t]; if (r < 0) return t; }
    return 3;
  }

  stepInternal(v) {
    const rng = this.world.rng;
    const e = this.energyAt(v.x, v.y);
    const polys = v.polys;
    const n0 = polys.length;
    const keep = [];
    for (let k = 0; k < n0; k++) {
      const p = polys[k];
      const L = p.seq.length;
      if (L < CFG.MAX_POLY_LEN && p.prog === 0 && rng.next() < CFG.POLY_RATE * e * 0.5) {
        const t = this.pickPool(v);
        if (t >= 0) { v.pool[t]--; p.seq.push(t); this.evalPolymer(p); }
      }
      if (p.act > 0 && rng.next() < (0.15 + p.act) * CFG.REP_RATE * (0.3 + 0.7 * e)) {
        const need = p.seq[p.prog];
        const t = rng.next() > p.fid ? this.pickPool(v) : (v.pool[need] > 0 ? need : -1);
        if (t >= 0) {
          v.pool[t]--;
          p.copy.push(t);
          p.prog++;
          if (p.prog >= p.seq.length) {
            const seq = this.finishCopy(p);
            polys.push(this.makePolymer(seq, v.x, v.y));
            v.copies++;
            this.world.milestone('replicator', 'A ribozyme copies itself: the RNA world begins');
          }
        }
      }
      // Membranes shelter their contents from UV and hydrolysis.
      if (rng.next() < CFG.HYDROLYSIS * 0.35 * p.seq.length * (1 - 0.5 * p.stab)) {
        this.breakPolymer(p, v);
        continue;
      }
      keep.push(p);
    }
    for (let k = n0; k < polys.length; k++) keep.push(polys[k]);
    v.polys = keep;
    // Spontaneous condensation from the internal pool.
    if (rng.next() < 0.004 * e) {
      const a = this.pickPool(v);
      if (a >= 0) {
        v.pool[a]--;
        const b = this.pickPool(v);
        if (b >= 0) { v.pool[b]--; v.polys.push(this.makePolymer([a, b], v.x, v.y)); }
        else v.pool[a]++;
      }
    }
  }

  split(v) {
    const rng = this.world.rng;
    const ang = rng.next() * 6.283, off = v.r * 0.6;
    const La = v.L >> 1;
    const a = this.makeVesicle(v.x + Math.cos(ang) * off, v.y + Math.sin(ang) * off, La, v.gen + 1);
    const b = this.makeVesicle(v.x - Math.cos(ang) * off, v.y - Math.sin(ang) * off, v.L - La, v.gen + 1);
    for (const p of v.polys) (rng.next() < 0.5 ? a : b).polys.push(p);
    for (let t = 0; t < 4; t++) { a.pool[t] = v.pool[t] >> 1; b.pool[t] = v.pool[t] - a.pool[t]; }
    a.copies = b.copies = v.copies; // replication history of the lineage
    if (a.polys.some((p) => p.act > 0) || b.polys.some((p) => p.act > 0)) {
      this.world.milestone('protocell', 'A vesicle carrying replicators divides: the first protocell');
    }
    return [a, b];
  }

  burst(v) {
    const rng = this.world.rng, F = this.world.fields;
    v.dead = true;
    const lip = Math.min(v.L, 24);
    for (let k = 0; k < lip; k++) {
      const a = rng.next() * 6.283;
      this.addMonomer(v.x + Math.cos(a) * v.r, v.y + Math.sin(a) * v.r, LIPID);
    }
    F.add(F.organic, v.x, v.y, (v.L - lip) * 0.2);
    for (let t = 0; t < 4; t++) for (let k = 0; k < v.pool[t]; k++) this.addMonomer(v.x + rng.range(-v.r, v.r), v.y + rng.range(-v.r, v.r), t);
    for (const p of v.polys) {
      if (this.canAddPolymer()) { p.x = v.x + rng.range(-v.r, v.r); p.y = v.y + rng.range(-v.r, v.r); p.dead = false; this.newPolys.push(p); }
    }
  }

  indexOfMid(id) {
    const mid = this.mid;
    for (let i = 0; i < this.n; i++) if (mid[i] === id) return i;
    return -1;
  }

  compact() {
    const mx = this.mx, my = this.my, mt = this.mt, md = this.mdead;
    let w = 0;
    for (let r = 0; r < this.n; r++) {
      if (md[r]) continue;
      if (w !== r) { mx[w] = mx[r]; my[w] = my[r]; mt[w] = mt[r]; this.mid[w] = this.mid[r]; }
      md[w] = 0;
      w++;
    }
    this.n = w;
  }

  census() {
    let reps = 0, proto = 0;
    for (const p of this.polymers) if (p.act > 0) reps++;
    for (const v of this.vesicles) {
      let has = false;
      for (const p of v.polys) if (p.act > 0) { reps++; has = true; }
      if (has) proto++;
    }
    this.stats.replicators = reps;
    this.stats.protocells = proto;
  }
}
