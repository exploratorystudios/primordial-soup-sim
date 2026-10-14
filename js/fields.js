// Diffusing chemical concentration fields on a coarse grid.
export class Fields {
  constructor(W, H, cs) {
    this.cs = cs;
    this.gw = Math.ceil(W / cs);
    this.gh = Math.ceil(H / cs);
    this.n = this.gw * this.gh;
    this.chem = new Float32Array(this.n);     // reduced chemicals from vents
    this.organic = new Float32Array(this.n);  // dissolved organic matter
    this.oxygen = new Float32Array(this.n);   // free O2 from photosynthesis
    this.nutrient = new Float32Array(this.n); // limiting mineral nutrient, recycled through bodies
    this.tmp = new Float32Array(this.n);
  }

  idx(x, y) {
    let cx = (x / this.cs) | 0, cy = (y / this.cs) | 0;
    if (cx < 0) cx = 0; else if (cx >= this.gw) cx = this.gw - 1;
    if (cy < 0) cy = 0; else if (cy >= this.gh) cy = this.gh - 1;
    return cy * this.gw + cx;
  }

  get(f, x, y) { return f[this.idx(x, y)]; }
  add(f, x, y, a) { f[this.idx(x, y)] += a; }
  take(f, x, y, a) {
    const i = this.idx(x, y);
    const v = f[i];
    const t = v < a ? v : a;
    f[i] = v - t;
    return t;
  }

  // Writes a roughly unit gradient vector into out; magnitude shrinks when the field is flat.
  grad(f, x, y, out) {
    const gw = this.gw, gh = this.gh;
    let cx = (x / this.cs) | 0, cy = (y / this.cs) | 0;
    if (cx < 1) cx = 1; else if (cx > gw - 2) cx = gw - 2;
    if (cy < 1) cy = 1; else if (cy > gh - 2) cy = gh - 2;
    const i = cy * gw + cx;
    const gx = f[i + 1] - f[i - 1];
    const gy = f[i + gw] - f[i - gw];
    const m = Math.hypot(gx, gy);
    if (m < 1e-6) { out.x = 0; out.y = 0; return out; }
    const rel = Math.min(1, (m / (f[i] + 0.5)) * 5);
    out.x = (gx / m) * rel;
    out.y = (gy / m) * rel;
    return out;
  }

  diffuse(f, rate, decay) {
    const gw = this.gw, gh = this.gh, t = this.tmp;
    const keep = 1 - decay;
    for (let y = 0; y < gh; y++) {
      const row = y * gw;
      for (let x = 0; x < gw; x++) {
        const i = row + x;
        const c = f[i];
        const l = x > 0 ? f[i - 1] : c;
        const r = x < gw - 1 ? f[i + 1] : c;
        const u = y > 0 ? f[i - gw] : c;
        const d = y < gh - 1 ? f[i + gw] : c;
        t[i] = (c + rate * ((l + r + u + d) * 0.25 - c)) * keep;
      }
    }
    f.set(t);
  }

  mean(f) {
    let s = 0;
    for (let i = 0; i < f.length; i++) s += f[i];
    return s / f.length;
  }
}
