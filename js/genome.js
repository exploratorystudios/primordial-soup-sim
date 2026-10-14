// Fixed-locus genome. Trait genes live in [0,1]; behaviour/regulatory weights in [-1,1].
import { RNG, hashSeq } from './rng.js';

export const SIZE = 0, PHOTO = 1, CHEMO = 2, HETERO = 3, PRED = 4, MOTIL = 5, AEROBIC = 6,
  DIVTH = 7, ADHES = 8, SHARE = 9, ARMOR = 10, MUTR = 11, HUE = 12, LIFESPAN = 13, COLMAX = 14;
// Major-transition and arms-race genes.
export const TRANSL = 15;   // protein translation: ribosomes + genetic code replace ribozyme metabolism
export const DNAG = 16;     // DNA genome (> 0.5): stable storage instead of RNA
export const SEX = 17;      // tendency to reproduce sexually (eukaryotes only)
export const REC1 = 18, REC2 = 19; // shape of surface receptors: what viruses latch onto
export const RESIST = 20;   // CRISPR-like antiviral defence
export const W_LIGHT = 21, W_CHEM = 22, W_ORG = 23, W_PREY = 24, W_FLEE = 25, W_OXY = 26;
export const FIRST_SIGNED = W_LIGHT;
// Gene-regulatory weights deciding cell fate inside a colony: for each cell type,
// a weighted sum of [bias, #neighbours, depth from founder, colony size, light].
export const DIFF = 27, NTYPES = 6, NDIFF_IN = 5;
export const NG = DIFF + NTYPES * NDIFF_IN;

export const GENE_NAMES = [
  'Size', 'Photosynthesis', 'Chemosynthesis', 'Heterotrophy', 'Predation', 'Motility', 'Aerobic resp.',
  'Division threshold', 'Adhesion', 'Energy sharing', 'Armor', 'Mutation rate', 'Pigment hue', 'Lifespan', 'Colony size',
  'Protein translation', 'DNA genome', 'Sexual reproduction', 'Receptor shape A', 'Receptor shape B', 'Viral defence',
  'Seek light', 'Seek chemicals', 'Seek organics', 'Chase prey', 'Flee predators', 'Seek oxygen',
];

// The first cell's genome is derived from the sequence of the replicator that founded it.
// It is an RNA-world cell: ribozymes do the chemistry and the genome is RNA.
export function fromSequence(seq) {
  const r = new RNG(hashSeq(seq));
  const g = new Float32Array(NG);
  g[SIZE] = 0.25 + r.next() * 0.15;
  g[PHOTO] = r.next() * 0.04;
  g[CHEMO] = 0.6 + r.next() * 0.2;
  g[HETERO] = 0.15 + r.next() * 0.2;
  g[PRED] = r.next() * 0.03;
  g[MOTIL] = 0.1 + r.next() * 0.2;
  g[AEROBIC] = r.next() * 0.03;
  g[DIVTH] = 0.4 + r.next() * 0.3;
  g[ADHES] = r.next() * 0.06;
  g[SHARE] = r.next() * 0.2;
  g[ARMOR] = r.next() * 0.05;
  g[MUTR] = 0.3 + r.next() * 0.2;
  g[HUE] = r.next();
  g[LIFESPAN] = 0.3 + r.next() * 0.3;
  g[COLMAX] = r.next() * 0.1;
  g[TRANSL] = 0.15 + r.next() * 0.15;
  g[DNAG] = r.next() * 0.1;
  g[SEX] = 0.05 + r.next() * 0.1; // only expressed once a lineage becomes eukaryotic
  g[REC1] = r.next();
  g[REC2] = r.next();
  g[RESIST] = r.next() * 0.05;
  g[W_LIGHT] = (r.next() - 0.5) * 0.4;
  g[W_CHEM] = 0.4 + r.next() * 0.3;
  g[W_ORG] = r.next() * 0.2;
  g[W_PREY] = r.next() * 0.3;
  g[W_FLEE] = r.next() * 0.3;
  g[W_OXY] = -r.next() * 0.2;
  for (let i = DIFF; i < NG; i++) g[i] = (r.next() - 0.5) * 0.3;
  return g;
}

// rateMul < 1 for DNA genomes (proofreading and repair).
export function mutate(p, rng, rateMul = 1) {
  const g = new Float32Array(p);
  const rate = (0.01 + p[MUTR] * 0.05) * rateMul; // the mutation rate itself evolves
  for (let i = 0; i < NG; i++) {
    if (i === HUE || rng.next() >= rate) continue;
    if (rng.next() < 0.04) g[i] = i >= FIRST_SIGNED ? rng.range(-1, 1) : rng.next(); // large-effect mutation
    else g[i] += rng.gauss() * 0.1;
    const lo = i >= FIRST_SIGNED ? -1 : 0;
    if (g[i] < lo) g[i] = lo; else if (g[i] > 1) g[i] = 1;
  }
  // Neutral pigment drifts every generation: a visible molecular clock.
  g[HUE] = (g[HUE] + rng.gauss() * 0.004 + 1) % 1;
  return g;
}

// Sexual reproduction: each gene comes from one parent or the other (free recombination).
export function recombine(a, b, rng) {
  const g = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) g[i] = rng.next() < 0.5 ? a[i] : b[i];
  return g;
}

export function distance(a, b) {
  let s = 0;
  for (let i = 0; i < NG; i++) {
    if (i === HUE) continue;
    const d = Math.abs(a[i] - b[i]);
    s += i >= FIRST_SIGNED ? d * 0.5 : d;
  }
  return s / (NG - 1);
}
