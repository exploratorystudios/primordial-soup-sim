// Rewind: play the recent past backwards at the current speed.
// While the world runs forward it is saved every so often (keeping the cost to ~5% of the simulation
// time, and the memory bounded). Going backwards restores the nearest earlier save and replays
// forward to the tick wanted, which reproduces the history exactly. For tick-by-tick rewinding, the
// stretch being rewound through is first replayed once and saved densely, so each step back only
// needs a short replay.
import { deserialize, serialize } from './persist.js';

const MIN_GAP = 25;        // ticks between saves, at least
const OVERHEAD = 0.05;     // fraction of simulation time spent saving, at most
const MAX_BYTES = 100e6;   // memory for saves (oldest dropped first)
const MAX_SAVES = 200;
const FINE = 10;           // dense saves while rewinding tick by tick

const save = (w) => JSON.stringify(serialize(w));
const load = (s) => deserialize(JSON.parse(s));

export class Rewind {
  constructor() { this.clear(); }

  clear() {
    this.saves = [];
    this.bytes = 0;
    this.cost = 0;   // ms the last save took
    this.simMs = 0;  // simulation time since the last save
    this.fine = null;
  }

  oldest() { return this.saves.length ? this.saves[0].t : Infinity; }

  // Called after the world has been stepped forward, with the ms spent stepping.
  record(w, simMs) {
    // Running forward again after a rewind: what was saved ahead of here is replayed anew.
    while (this.saves.length && this.saves[this.saves.length - 1].t > w.t) this.bytes -= this.saves.pop().s.length;
    this.fine = null;
    this.simMs += simMs;
    const last = this.saves[this.saves.length - 1];
    if (last && (w.t - last.t < MIN_GAP || this.simMs * OVERHEAD < this.cost)) return;
    const t0 = performance.now();
    const s = save(w);
    this.cost = performance.now() - t0;
    this.simMs = 0;
    this.saves.push({ t: w.t, s });
    this.bytes += s.length;
    while (this.saves.length > 2 && (this.bytes > MAX_BYTES || this.saves.length > MAX_SAVES)) this.bytes -= this.saves.shift().s.length;
  }

  // The latest save at or before tick t.
  saveAt(t, list = this.saves) {
    let best = null;
    for (const q of list) if (q.t <= t) best = q; else break;
    return best;
  }

  // The world at the save nearest before tick t (fast: no replay). For quick rewinding.
  coarse(t) {
    const q = this.saveAt(t);
    return q ? load(q.s) : null;
  }

  // The world exactly at tick t. With smooth, one tick later instead, remembering where everything
  // was at t, so the view can be drawn anywhere between t and t + 1.
  exact(t, smooth) {
    const f = this.fine;
    if (!f || t < f.t0 || t > f.t1) this.refine(t);
    const w = load(this.saveAt(t, this.fine.list).s);
    while (w.t < t) w.step();
    if (smooth) { w.smooth = true; w.step(); }
    return w;
  }

  // Replay from the save before t up to t, saving densely: the next steps back will land in here.
  refine(t) {
    const base = this.saveAt(t);
    const list = [base];
    const w = load(base.s);
    while (w.t < t) {
      w.step();
      if ((w.t - base.t) % FINE === 0 && w.t <= t) list.push({ t: w.t, s: save(w) });
    }
    this.fine = { t0: base.t, t1: t, list };
  }

  dropFine() { this.fine = null; }
}
