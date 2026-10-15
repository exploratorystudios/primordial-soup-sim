// How far a protocell has come on the road to becoming a cell, and what that looks like inside it.
// Drawing and inspector only: everything here is derived from the simulation's own record of the
// lineage (generations, completed self-copies, how good its best ribozyme is), never fed back into it.
//
// What is shown follows the leading origin-of-life ideas. Well supported by experiments: membranes
// of fatty acids that are leaky enough to let nucleotides in and later stiffen as phospholipids mix
// in; RNA copied by pairing nucleotides along a template; ribozymes needing magnesium ions; vesicles
// growing by taking up fatty acids and dividing through a string of beads. Plausible but unproven:
// short peptides made from prebiotic amino acids, stuck to the RNA; a proto-ribosome, an RNA core that
// joins amino acids and later grows into the ribosome.
import { CFG } from './config.js';
import { hash32 } from './anatomy.js';

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const rand01 = (a, b = 0) => hash32(a, b) / 4294967296;

// 0 = a plain fatty-acid bubble, 1 = ready to switch on as a cell.
export function maturity(v) {
  let best = 0, active = 0;
  for (const p of v.polys) if (p.act > 0) { active++; if (p.act > best) best = p.act; }
  const gen = Math.min(1, v.gen / (CFG.CELL_GEN + 1));
  const copies = Math.min(1, v.copies / 3);
  const act = Math.min(1, best / (CFG.CELL_ACT * 1.5)) * (active >= 2 ? 1 : 0.6);
  return clamp01(0.4 * gen + 0.3 * copies + 0.3 * act);
}

export function stage(m) {
  return m < 0.2 ? 'Fatty-acid vesicle' : m < 0.45 ? 'Early protocell' : m < 0.75 ? 'Maturing protocell' : 'On the verge of life';
}

// Share of the membrane made of phospholipids (two tails) rather than fatty acids (one tail).
export function phospholipidShare(m) { return 0.6 * smooth(0.15, 1, m); }

// Prebiotic amino acids (those that form readily without life, e.g. in Miller–Urey experiments).
export const PREBIOTIC_AA = ['Gly', 'Ala', 'Asp', 'Glu', 'Val', 'Ser', 'Pro', 'Leu'];
const AA_COLORS = { Gly: '#d8d8c8', Ala: '#e6c98a', Val: '#e0b070', Leu: '#d9a060', Pro: '#c9b38a', Ser: '#8fdc9a', Asp: '#ff7a6e', Glu: '#ff8f7a' };
export const aaColor = (a) => AA_COLORS[a] || '#ddd';

// Short peptides floating in the protocell (some stuck to its RNA), from the early-protocell stage.
export function peptides(v, m) {
  if (m < 0.4) return [];
  const n = 1 + Math.floor(((m - 0.4) / 0.6) * 5);
  const out = [];
  for (let k = 0; k < n; k++) {
    const len = 4 + (hash32(v.id, k * 13 + 1) % 6);
    const seq = [];
    for (let i = 0; i < len; i++) seq.push(PREBIOTIC_AA[hash32(v.id * 31 + k, i) % PREBIOTIC_AA.length]);
    out.push({ k, seq, onRNA: k % 2 === 0 });
  }
  return out;
}

// The strand that is becoming a proto-ribosome (the protocell's best ribozyme), once it is nearly alive.
export function protoRibosome(v, m) {
  if (m < 0.75) return null;
  let best = null;
  for (const p of v.polys) if (p.act > 0 && (!best || p.act > best.act)) best = p;
  return best;
}

// Magnesium ions held by a ribozyme (it needs them to fold and to catalyse).
export const magnesiumCount = (p) => (p.act > 0 ? 2 + Math.round(p.act * 6) : 0);
