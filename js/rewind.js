// Rewind: play the recent past backwards at the current speed.
// While the world runs forward it is saved on a fixed schedule, so the last 25,000 ticks can always be
// rewound: every 100 ticks for the most recent stretch, thinned to every 500 further back (keeping the
// memory to a few hundred MB even late in a run). Going backwards restores the nearest earlier save and replays
// forward to the tick wanted, which reproduces the history exactly. For tick-by-tick rewinding, the
// stretch being rewound through is first replayed once and saved densely, so each step back only
// needs a short replay.
import { deserialize, serialize } from './persist.js';

const HORIZON = 25000;     // ticks of history kept
const GAP = 100;           // ticks between saves for the most recent stretch
const RECENT = 2500;       // how far back the saves stay that dense
const OLD_GAP = 500;       // ticks between saves further back
const MAX_BYTES = 600e6;   // backstop only: past this the oldest saves go
const FINE = 10;           // dense saves while rewinding tick by tick

const save = (w) => JSON.stringify(serialize(w));
const load = (s) => deserialize(JSON.parse(s));

export class Rewind {
  constructor() { this.clear(); }

  clear() {
    this.saves = [];
    this.bytes = 0;
    this.fine = null;
  }

  oldest() { return this.saves.length ? this.saves[0].t : Infinity; }

  // Called after the world has been stepped forward.
  record(w) {
    // Running forward again after a rewind: what was saved ahead of here is replayed anew.
    while (this.saves.length && this.saves[this.saves.length - 1].t > w.t) this.bytes -= this.saves.pop().s.length;
    this.fine = null;
    const last = this.saves[this.saves.length - 1];
    // (a frame can step many ticks: save once the world has crossed into the next stretch of GAP)
    if (last && Math.floor(w.t / GAP) === Math.floor(last.t / GAP)) return;
    const s = save(w);
    this.saves.push({ t: w.t, s });
    this.bytes += s.length;
    this.trim(w.t);
  }

  trim(now) {
    // Thin out the older saves to one per OLD_GAP ticks.
    const kept = [];
    let bytes = 0;
    for (const q of this.saves) {
      const prev = kept[kept.length - 1];
      if (prev && q.t < now - RECENT && Math.floor(q.t / OLD_GAP) === Math.floor(prev.t / OLD_GAP)) continue;
      kept.push(q);
      bytes += q.s.length;
    }
    // Forget what is past the horizon, keeping one save at or before it so all of it can be reached.
    while (kept.length > 1 && kept[1].t <= now - HORIZON) bytes -= kept.shift().s.length;
    while (kept.length > 2 && bytes > MAX_BYTES) bytes -= kept.shift().s.length;
    this.saves = kept;
    this.bytes = bytes;
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
    // Smooth: the last few steps record where things were, including the soup's latest step (it may
    // step only every third tick).
    while (w.t < t - 2) w.step();
    w.smooth = smooth;
    while (w.t < t + (smooth ? 1 : 0)) w.step();
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
