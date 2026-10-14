// Viruses as particles. They begin as selfish genetic elements that escape from cells, drift and
// decay in the water, and infect cells whose surface receptors match their binding key. Inside,
// they hijack the cell, then burst it and release mutated copies. Hosts escape by changing their
// receptors or evolving defences, so a host–virus arms race emerges. Occasionally a virus carries
// a gene from its last host into a new one (transduction).
import { CFG } from './config.js';
import * as Gn from './genome.js';

const CUR = { x: 0, y: 0 };

export class Viruses {
  constructor(world) {
    this.w = world;
    this.list = [];
    this.pending = [];
    this.nextId = 1;
    this.lineages = 0;
    this.stats = { infections: 0, bursts: 0, transductions: 0 };
  }

  make(x, y, k1, k2, lineage, cargo) {
    return { id: this.nextId++, x, y, x0: x, y0: y, k1, k2, lineage, cargo, age: 0, ang: Math.random() * 6.283 };
  }

  step() {
    const w = this.w, L = w.life, rng = w.rng;
    // A new virus lineage occasionally escapes from a host once life is abundant.
    if (L.cells.length > CFG.VIRUS_ORIGIN_POP && this.list.length < 40 && rng.next() < CFG.VIRUS_ORIGIN_P) {
      const host = L.cells[rng.int(L.cells.length)];
      if (host && !host.dead) {
        this.lineages++;
        for (let k = 0; k < 6; k++) this.list.push(this.make(host.x + rng.range(-host.r, host.r), host.y + rng.range(-host.r, host.r), host.g[Gn.REC1], host.g[Gn.REC2], this.lineages, null));
        w.milestone('virus', 'The first virus: a selfish genetic element escapes its host');
        w.log(`Virus lineage #${this.lineages} emerges`);
      }
    }
    const out = [], cells = L.cells, spec2 = 2 * CFG.VIRUS_SPEC * CFG.VIRUS_SPEC;
    const W = CFG.W, H = CFG.H;
    for (const v of this.list) {
      v.age++;
      // Ultraviolet light near the surface destroys exposed particles.
      if (rng.next() < CFG.VIRUS_DECAY * (1 + w.sunAt(v.y) * 3)) { v.dead = true; v.nextWhy = 'fell apart (UV light and decay)'; continue; }
      w.current(v.x, v.y, CUR);
      v.x += (rng.next() - 0.5) * CFG.VIRUS_D + CUR.x * 0.8;
      v.y += (rng.next() - 0.5) * CFG.VIRUS_D + CUR.y * 0.8;
      if (v.x < 0) v.x = -v.x; else if (v.x > W) v.x = 2 * W - v.x;
      if (v.y < 0) v.y = -v.y; else if (v.y > H) v.y = 2 * H - v.y;
      v.ang += (rng.next() - 0.5) * 0.3;
      let used = false;
      if (cells.length && (v.id + w.t) % 2 === 0) {
        L.hash.query(v.x, v.y, L.maxR + 1, (j) => {
          const c = cells[j];
          if (!c || c.dead || c.infected) return false;
          const dx = c.x - v.x, dy = c.y - v.y;
          if (dx * dx + dy * dy > (c.r + 0.1) * (c.r + 0.1)) return false;
          // Binding: the virus's key must fit the cell's receptor shape.
          const d1 = c.g[Gn.REC1] - v.k1, d2 = c.g[Gn.REC2] - v.k2;
          const fit = Math.exp(-(d1 * d1 + d2 * d2) / spec2);
          if (rng.next() > CFG.VIRUS_INFECT * fit * (1 - 0.9 * c.resist)) return false;
          used = true;
          v.next = c;
          if (v.cargo && rng.next() < CFG.TRANSDUCE) {
            v.nextWhy = `slipped a gene into cell #${c.id}`;
            // Transduction: the virus delivers a gene from its last host instead of taking over.
            c.g = new Float32Array(c.g);
            c.g[v.cargo.i] = v.cargo.v;
            this.stats.transductions++;
            w.life.redecode(c);
          } else {
            v.nextWhy = `injected its genome into cell #${c.id}`;
            c.infected = { t: w.t + CFG.VIRUS_LATENCY + rng.int(CFG.VIRUS_LATENCY), k1: v.k1, k2: v.k2, lineage: v.lineage, since: w.t };
            this.stats.infections++;
          }
          return true;
        });
      }
      if (!used) out.push(v); else v.dead = true;
    }
    for (const v of this.pending) out.push(v);
    this.pending = [];
    this.list = out;
  }

  // The host bursts and releases a new generation, each with a slightly mutated key.
  lyse(c) {
    const rng = this.w.rng, inf = c.infected;
    if (!inf) return;
    const room = CFG.MAX_VIRUSES - this.list.length - this.pending.length;
    const n = Math.max(0, Math.min(room, Math.round(CFG.VIRUS_BURST * Math.min(4, 0.6 + Math.sqrt(c.m)))));
    for (let k = 0; k < n; k++) {
      const a = rng.next() * 6.283, r = rng.next() * c.r;
      // Each progeny may carry a random host gene (not the neutral pigment or receptors).
      let cargo = null;
      if (rng.next() < 0.3) {
        let i = rng.int(Gn.NG);
        if (i === Gn.HUE || i === Gn.REC1 || i === Gn.REC2) i = Gn.SIZE;
        cargo = { i, v: c.g[i] };
      }
      const clamp = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
      this.pending.push(this.make(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, clamp(inf.k1 + rng.gauss() * CFG.VIRUS_MUT), clamp(inf.k2 + rng.gauss() * CFG.VIRUS_MUT), inf.lineage, cargo));
    }
    this.stats.bursts++;
    if (n > 0) { c.next = this.pending.at(-1); c.nextWhy = `burst open, releasing ${n} new viruses; following one`; }
  }
}
