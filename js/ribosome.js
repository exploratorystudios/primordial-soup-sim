// A representative molecular model of a translating ribosome, in nanometres, in the ribosome's own
// frame (x along the messenger RNA, +y toward the large subunit). Shared by the renderer and the
// inspector. Real rRNAs are thousands of nucleotides long; the folds drawn here are scaled down
// (about one drawn nucleotide for every seven real ones) but keep the real overall dimensions.
import { RNG } from './rng.js';

const TAU = Math.PI * 2;
export const AMINO = ['Gly', 'Ala', 'Val', 'Leu', 'Ile', 'Pro', 'Phe', 'Trp', 'Met', 'Ser', 'Thr', 'Cys', 'Tyr', 'Asn', 'Gln', 'Asp', 'Glu', 'Lys', 'Arg', 'His'];
export const AMINO_NAMES = {
  Gly: 'Glycine', Ala: 'Alanine', Val: 'Valine', Leu: 'Leucine', Ile: 'Isoleucine', Pro: 'Proline', Phe: 'Phenylalanine', Trp: 'Tryptophan',
  Met: 'Methionine', Ser: 'Serine', Thr: 'Threonine', Cys: 'Cysteine', Tyr: 'Tyrosine', Asn: 'Asparagine', Gln: 'Glutamine', Asp: 'Aspartate',
  Glu: 'Glutamate', Lys: 'Lysine', Arg: 'Arginine', His: 'Histidine',
};

// A folded RNA chain: a smooth walk confined to an ellipse, one point per nucleotide (0.6 nm apart).
function fold(rng, n, cx, cy, rx, ry) {
  const pts = [];
  let x = cx + (rng.next() - 0.5) * rx, y = cy + (rng.next() - 0.5) * ry, th = rng.next() * TAU;
  for (let k = 0; k < n; k++) {
    th += (rng.next() - 0.5) * 1.1;
    let nx = x + Math.cos(th) * 0.6, ny = y + Math.sin(th) * 0.6;
    if (((nx - cx) / rx) ** 2 + ((ny - cy) / ry) ** 2 > 0.8) { th += Math.PI * 0.75; nx = x + Math.cos(th) * 0.6; ny = y + Math.sin(th) * 0.6; }
    x = nx; y = ny;
    pts.push({ x, y, b: rng.int(4) });
  }
  return pts;
}

function blobs(rng, n, cx, cy, rx, ry, prefix, names) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU + rng.next() * 0.4, f = 0.78 + rng.next() * 0.2;
    out.push({ x: cx + Math.cos(a) * rx * f, y: cy + Math.sin(a) * ry * f, r: 1.4 + rng.next() * 1.2, name: `${prefix}${names[k % names.length]}` });
  }
  return out;
}

const cache = new Map();
export function ribosomeModel(seed, euk) {
  const key = seed * 2 + (euk ? 1 : 0);
  if (cache.has(key)) return cache.get(key);
  const rng = new RNG(seed >>> 0), s = euk ? 1.2 : 1;
  const L = { cx: 0, cy: 4 * s, rx: 10 * s, ry: 7.5 * s };
  const S = { cx: 0, cy: -5.5 * s, rx: 9 * s, ry: 4.5 * s };
  const m = {
    euk, s, L, S,
    rnaL: fold(rng, Math.round(420 * s), L.cx, L.cy + 0.5 * s, L.rx * 0.95, L.ry * 0.9),
    rna5S: fold(rng, 50, L.cx + 5 * s, L.cy + 5.5 * s, 2.6 * s, 1.6 * s),
    rnaS: fold(rng, Math.round(240 * s), S.cx, S.cy, S.rx * 0.95, S.ry * 0.9),
    protL: blobs(rng, 9, L.cx, L.cy, L.rx, L.ry, euk ? 'eL' : 'L', ['2', '3', '4', '13', '14', '22', '23', '24', '29']),
    protS: blobs(rng, 7, S.cx, S.cy, S.rx, S.ry, euk ? 'eS' : 'S', ['2', '3', '4', '5', '7', '12', '15']),
    mrna: [], trna: [], peptide: [],
  };
  // Messenger RNA threading between the subunits.
  for (let x = -26; x <= 26; x += 0.6) m.mrna.push({ x, y: -1.2 * s + Math.sin(x * 0.25) * 0.3, b: rng.int(4) });
  // Transfer RNAs in the A (incoming), P (holding the growing chain) and E (leaving) sites.
  const complement = (b) => (b === 0 ? 1 : b === 1 ? 0 : b === 2 ? 3 : 2);
  ['A', 'P', 'E'].forEach((site, i) => {
    const x = (1 - i) * 2.7 * s, ci = m.mrna.findIndex((q) => q.x >= x - 0.9);
    const codon = m.mrna.slice(ci, ci + 3).map((q) => q.b);
    m.trna.push({
      site, x, codon, anticodon: codon.map(complement).reverse(), aa: AMINO[rng.int(20)],
      // L-shape: anticodon arm down at the mRNA, elbow, acceptor arm up into the large subunit.
      pts: [{ x, y: -1.2 * s + 0.35 }, { x, y: 2.5 * s }, { x: x + 1.2 * s, y: 4.2 * s }, { x: x + 2.4 * s, y: 5.6 * s }],
    });
  });
  // The new protein leaving through the exit tunnel and out of the large subunit.
  const n = 25 + rng.int(40);
  let px = 0.3 * s, py = 5.8 * s;
  for (let k = 0; k < n; k++) {
    if (py < L.cy + L.ry + 1) py += 0.38; // straight up the 10 nm tunnel
    else { const a = Math.sin(k * 0.5) * 1.2 + 0.6; px += Math.cos(a) * 0.38; py += Math.sin(a) * 0.38 * 0.6 + 0.12; }
    m.peptide.push({ x: px, y: py, aa: AMINO[rng.int(20)] });
  }
  if (cache.size > 400) cache.clear();
  cache.set(key, m);
  return m;
}

// Orientation of a given ribosome, deterministic per cell and index.
export function ribosomeAngle(seed) {
  let h = Math.imul(seed + 7, 0x9e3779b9); h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
  return ((h >>> 0) / 4294967296) * TAU;
}

// The elongation cycle at phase T (one unit per codon): the A-site tRNA arrives, the chain is
// handed over, then everything translocates one codon and the empty tRNA leaves from the E site.
export function translationState(m, T) {
  const step = Math.floor(T), u = T - step, sp = 2.7 * m.s;
  const shift = u > 0.6 ? ((u - 0.6) / 0.4) : 0; // translocation
  const e = shift * shift * (3 - 2 * shift);
  const trna = m.trna.map((t, i) => {
    let dx = -e * sp, alpha = 1, dy = 0;
    if (t.site === 'A' && u < 0.3) { const a = u / 0.3; dy = (1 - a) * 6 * m.s; dx += (1 - a) * 4 * m.s; alpha = a; } // arriving
    if (t.site === 'E') { alpha = 1 - e; dy = e * 5 * m.s; dx -= e * 3 * m.s; } // leaving
    return { ...t, dx, dy, alpha, aaHere: t.site === 'A' ? u < 0.45 : t.site === 'P' };
  });
  const len = Math.min(m.peptide.length, 8 + (step % Math.max(1, m.peptide.length - 8)));
  return { step, u, shift: e * sp, codonShift: step * 3, trna, peptideLen: len };
}
