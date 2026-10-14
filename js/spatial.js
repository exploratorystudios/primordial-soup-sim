// Uniform-grid spatial hash rebuilt each tick with a counting sort.
export class SpatialHash {
  constructor(W, H, cs) {
    this.cs = cs;
    this.gw = Math.ceil(W / cs);
    this.gh = Math.ceil(H / cs);
    this.nc = this.gw * this.gh;
    this.start = new Int32Array(this.nc + 1);
    this.fill = new Int32Array(this.nc);
    this.items = new Int32Array(1024);
    this.cellOf = new Int32Array(1024);
  }

  cell(x, y) {
    let cx = Math.floor(x / this.cs), cy = Math.floor(y / this.cs);
    if (cx < 0) cx = 0; else if (cx >= this.gw) cx = this.gw - 1;
    if (cy < 0) cy = 0; else if (cy >= this.gh) cy = this.gh - 1;
    return cy * this.gw + cx;
  }

  build(n, xs, ys) {
    if (this.items.length < n) {
      this.items = new Int32Array(n * 2);
      this.cellOf = new Int32Array(n * 2);
    }
    const start = this.start, cellOf = this.cellOf;
    start.fill(0);
    for (let i = 0; i < n; i++) {
      const c = this.cell(xs[i], ys[i]);
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < this.nc; c++) start[c + 1] += start[c];
    this.fill.set(start.subarray(0, this.nc));
    for (let i = 0; i < n; i++) this.items[this.fill[cellOf[i]]++] = i;
  }

  // Calls fn(index) for every item in cells overlapping the query box.
  // If fn returns true the query stops early.
  query(x, y, r, fn) {
    const cs = this.cs;
    let x0 = Math.floor((x - r) / cs), x1 = Math.floor((x + r) / cs);
    let y0 = Math.floor((y - r) / cs), y1 = Math.floor((y + r) / cs);
    if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
    if (x1 >= this.gw) x1 = this.gw - 1; if (y1 >= this.gh) y1 = this.gh - 1;
    const start = this.start, items = this.items;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const c = cy * this.gw + cx;
        for (let k = start[c], e = start[c + 1]; k < e; k++) {
          if (fn(items[k]) === true) return;
        }
      }
    }
  }

  countAt(x, y) {
    const c = this.cell(x, y);
    return this.start[c + 1] - this.start[c];
  }
}
