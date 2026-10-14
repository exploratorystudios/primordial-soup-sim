// Seeded PRNG (mulberry32) so every world is reproducible from its seed.
export class RNG {
  constructor(seed) {
    this.s = (seed >>> 0) || 1;
    this._spare = null;
  }
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(n) { return Math.floor(this.next() * n); }
  chance(p) { return this.next() < p; }
  gauss() {
    if (this._spare !== null) { const s = this._spare; this._spare = null; return s; }
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    v = this.next();
    const m = Math.sqrt(-2 * Math.log(u));
    this._spare = m * Math.sin(6.283185307 * v);
    return m * Math.cos(6.283185307 * v);
  }
}

export function hashSeq(seq) {
  let h = 2166136261;
  for (let i = 0; i < seq.length; i++) h = Math.imul(h ^ (seq[i] + 1), 16777619);
  return h >>> 0;
}
