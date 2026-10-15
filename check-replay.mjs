// Strict save/restore check: at several ticks, snapshot the world, continue both the original and the
// restored copy, and compare their complete saved state. The tour's rewind depends on this being exact.
//   node check-replay.mjs [seed] [tick,tick,...] [steps]
import { World } from './js/world.js';
import { serialize, deserialize } from './js/persist.js';

const seed = +process.argv[2] || 1;
const ticks = (process.argv[3] || '26,4001,13007,30011').split(',').map(Number);
const steps = +process.argv[4] || 150;
const COSMETIC = new Set(['ang']); // virus orientation is random and only affects drawing

const w = new World(seed);
let bad = 0;
for (const T of ticks) {
  while (w.t < T) w.step();
  const copy = deserialize(structuredClone(serialize(w)));
  for (let i = 0; i < steps; i++) copy.step();
  const diffs = [];
  const cmp = (x, y, path, key) => {
    if (diffs.length > 5 || COSMETIC.has(key)) return;
    if (typeof x !== typeof y) { diffs.push(`${path} (type)`); return; }
    if (x && typeof x === 'object') { for (const k of new Set([...Object.keys(x), ...Object.keys(y || {})])) cmp(x[k], y?.[k], `${path}.${k}`, k); }
    else if (x !== y && !(Number.isNaN(x) && Number.isNaN(y))) diffs.push(`${path}: ${String(x).slice(0, 20)} vs ${String(y).slice(0, 20)}`);
  };
  // The live world continues too: it must match the restored copies.
  for (let i = 0; i < steps; i++) w.step();
  const live = JSON.parse(JSON.stringify(serialize(w)));
  cmp(live, JSON.parse(JSON.stringify(serialize(copy))), '', '');
  console.log(`seed ${seed} tick ${T} + ${steps}: ${diffs.length ? 'DIVERGED\n  ' + diffs.join('\n  ') : 'exact'}`);
  if (diffs.length) bad++;
}
process.exit(bad ? 1 : 0);
