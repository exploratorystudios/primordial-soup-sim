// Hierarchical anatomy for the inspector. Every selectable thing can list its parts, down to the
// chemical groups of a single molecule, and every part knows where it is (at true scale) so the
// camera can zoom into it. Sub-cellular parts are procedural: they follow the cell's simulated
// state (eukaryote or not, plastids, size, armor, genome) but are not simulated one by one.
import { BASES, LIPID } from './chemistry.js';
import { NM_PER_UNIT, DIM, formatLen, dnaBase } from './render.js';
import { ribosomeModel, ribosomeAngle, AMINO_NAMES } from './ribosome.js';
import { wallLayers, wallLayerR, WALL_LINK, WALL_UNIT, microtubules, erRibosomes, golgiCisternae, golgiVesicles, nuclearPores, piliLines, flagellumPath, capsids, mitoSize, plastSize, cristae, grana, local, toLocal, membraneProteinAt, membraneProteinSpacing } from './anatomy.js';
import { TYPE_NAMES } from './life.js';
import { maturity, phospholipidShare, peptides, protoRibosome, magnesiumCount, PREBIOTIC_AA } from './protocell.js';
import * as Gn from './genome.js';

const NM = 1 / NM_PER_UNIT;
const TAU = Math.PI * 2;
const um = (units) => formatLen(units * NM_PER_UNIT);

export const NT_INFO = [
  { name: 'Adenosine monophosphate (AMP)', base: 'Adenine', formula: 'C₁₀H₁₄N₅O₇P', baseFormula: 'C₅H₅N₅', ring: 'purine: two fused rings', pair: 'U' },
  { name: 'Uridine monophosphate (UMP)', base: 'Uracil', formula: 'C₉H₁₃N₂O₉P', baseFormula: 'C₄H₄N₂O₂', ring: 'pyrimidine: one ring', pair: 'A' },
  { name: 'Guanosine monophosphate (GMP)', base: 'Guanine', formula: 'C₁₀H₁₄N₅O₈P', baseFormula: 'C₅H₅N₅O', ring: 'purine: two fused rings', pair: 'C' },
  { name: 'Cytidine monophosphate (CMP)', base: 'Cytosine', formula: 'C₉H₁₄N₃O₈P', baseFormula: 'C₄H₅N₃O', ring: 'pyrimidine: one ring', pair: 'G' },
];

const GENE_DESC = {
  [Gn.SIZE]: 'Cell size. Bigger cells store more energy and are hard to swallow, but cost more to run.',
  [Gn.PHOTO]: 'Investment in photosynthetic pigments and photosystems.',
  [Gn.CHEMO]: 'Investment in enzymes that harvest energy from vent chemicals (H₂, H₂S).',
  [Gn.HETERO]: 'Investment in absorbing dissolved organic matter.',
  [Gn.PRED]: 'Investment in engulfing other cells (phagocytosis).',
  [Gn.MOTIL]: 'Flagellum strength: swimming speed.',
  [Gn.AEROBIC]: 'Aerobic respiration and antioxidant defences: uses oxygen, resists its toxicity.',
  [Gn.DIVTH]: 'How much energy the cell banks before dividing.',
  [Gn.ADHES]: 'Chance that daughter cells stay stuck together after division.',
  [Gn.SHARE]: 'Strength of cytoplasmic bridges that pass energy and nutrients to neighbours.',
  [Gn.ARMOR]: 'Cell wall / pellicle thickness: defence against predators.',
  [Gn.MUTR]: 'Fidelity of DNA copying (higher means more mutations per division).',
  [Gn.HUE]: 'A neutral pigment gene that drifts randomly: a molecular clock for lineages.',
  [Gn.LIFESPAN]: 'Maintenance and repair investment: longer life at a small upkeep cost.',
  [Gn.COLMAX]: 'How large a colony may grow before it fragments.',
  [Gn.W_LIGHT]: 'Phototaxis: swim toward (+) or away from (−) light.',
  [Gn.W_CHEM]: 'Chemotaxis toward (+) or away from (−) vent chemicals.',
  [Gn.W_ORG]: 'Chemotaxis toward organic matter.',
  [Gn.W_PREY]: 'Hunting drive: steer toward smaller cells.',
  [Gn.W_FLEE]: 'Escape drive: steer away from predators.',
  [Gn.W_OXY]: 'Aerotaxis: swim toward (+) or away from (−) oxygen.',
};
const DIFF_INPUTS = ['bias', 'number of neighbours', 'distance from founder cell', 'colony size', 'light'];

// ------------------------------------------------------------------ helpers
export function sel(kind, obj, extra = {}) { return { kind, obj, follow: false, ...extra }; } // the camera's follow setting is applied on the next frame

// A point that moves with its parent; pos() returns {x, y} in world units.
function anchored(pos, r, isDead) {
  return { get x() { return pos().x; }, get y() { return pos().y; }, r, get dead() { return isDead(); } };
}

function part(label, obj, info, extra = {}) {
  return sel('part', obj, { label, info, ...extra });
}

// Point (lx, ly) in nm inside a frame {x, y, ang}.
function inFrame(f, lx, ly) {
  const c = Math.cos(f.ang), s = Math.sin(f.ang);
  return { x: f.x + (lx * c - ly * s) * NM, y: f.y + (lx * s + ly * c) * NM };
}

// Field of view (nm) that frames an object of radius r (world units) nicely.
export function fovFor(s) {
  if (s.outline) {
    const o = s.outline();
    return Math.max(6, (o.type === 'ellipse' ? Math.max(o.rx, o.ry) : o.r) * 2 * NM_PER_UNIT * 1.35);
  }
  if (s.shape) {
    // Thin structures (flagellum, ER, microtubule, pilus): frame their whole extent.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const pts of s.shape.lines()) for (const q of pts) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    return Math.max(6, Math.max(x1 - x0, (y1 - y0) * 16 / 9) * NM_PER_UNIT * 1.4);
  }
  const r = s.obj.r || s.obj._rad || 1 * NM;
  return Math.max(6, r * NM_PER_UNIT * 2 * 3.5);
}

// Where to point the camera to frame a part (the middle of a thin structure, else its centre).
export function centreOf(s) {
  if (s.outline) { const o = s.outline(); return { x: o.x, y: o.y }; }
  if (s.shape) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const pts of s.shape.lines()) for (const q of pts) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  }
  return { x: s.obj.x, y: s.obj.y };
}

// ------------------------------------------------------------ molecules
// A molecule (free, in a polymer, in a membrane or in a pool), positioned by a frame function.
export function molecule(t, frame, isDead, parent, extra = {}) {
  const r = (t === LIPID ? 1.0 : 0.7) * NM;
  const obj = anchored(() => inFrame(frame(), 0, t === LIPID ? 0.9 : 0.5), r, isDead);
  return sel('molecule', obj, { label: t === LIPID ? 'Fatty acid' : `${BASES[t]} · ${NT_INFO[t].base}`, t, frame, parent, ...extra });
}

function moleculeParts(s) {
  const { t, frame } = s, dead = () => s.obj.dead;
  const at = (lx, ly, r) => anchored(() => inFrame(frame(), lx, ly), r * NM, dead);
  if (s.phospho) {
    return [
      part('Phosphate head (choline)', at(0, 0, 0.35), { title: 'Polar head: phosphate + choline', kv: [['Size', '≈ 0.8 nm'], ['Character', 'hydrophilic']], desc: 'The charged phosphate group (with a small alcohol such as choline or ethanolamine) faces the water.' }, { parent: s }),
      part('Glycerol backbone', at(0, 0.45, 0.25), { title: 'Glycerol backbone (C₃)', kv: [], desc: 'Links the head to the two tails via ester bonds (ether bonds in archaea).' }, { parent: s }),
      part('Two fatty-acid tails', at(0, 1.3, 0.8), { title: 'Two hydrocarbon tails (C₁₆–C₁₈)', kv: [['Length', '≈ 2 nm']], desc: 'Twice the tails of a prebiotic fatty acid make a much tighter, less leaky membrane, good enough to hold ion gradients.' }, { parent: s }),
    ];
  }
  if (t === LIPID) {
    return [
      part('Carboxyl head', at(0, 0, 0.35), { title: 'Carboxyl head group (–COOH)', kv: [['Size', '≈ 0.3 nm'], ['Character', 'hydrophilic (water-loving)']], desc: 'Ionises to –COO⁻ in water. In a membrane the heads face the water on both sides.' }, { parent: s }),
      part('Hydrocarbon tail', at(0, 1.1, 0.8), { title: 'Hydrocarbon tail (C₉H₁₉)', kv: [['Length', '≈ 1.2 nm'], ['Character', 'hydrophobic (water-fearing)']], desc: 'Tails hide from water by pairing up inside the membrane. That is what makes fatty acids assemble into vesicles by themselves.' }, { parent: s }),
    ];
  }
  const n = NT_INFO[t];
  return [
    part('Phosphate group', at(0, 0, 0.3), { title: 'Phosphate group (PO₄)', kv: [['Size', '≈ 0.3 nm'], ['Charge', 'negative']], desc: 'In a chain, each phosphate bridges the sugars of two neighbouring nucleotides (a phosphodiester bond), forming the RNA backbone.' }, { parent: s }),
    part('Ribose sugar', at(0, 0.38, 0.28), { title: 'Ribose (C₅H₁₀O₅)', kv: [['Size', '≈ 0.5 nm'], ['Ring', 'five-membered']], desc: 'A five-carbon sugar. Its extra 2′-OH group (absent in DNA) lets RNA fold into shapes that catalyse reactions.' }, { parent: s }),
    part(`${n.base} base`, at(0, 0.9, 0.4), { title: `${n.base} (${n.baseFormula})`, kv: [['Type', n.ring], ['Pairs with', n.pair], ['Size', '≈ 0.6 nm']], desc: `The information-carrying part. ${n.base} pairs with ${n.pair} through hydrogen bonds, which is how RNA templates its own copies.` }, { parent: s }),
  ];
}

function moleculeInfo(s) {
  if (s.phospho) {
    return { title: 'Phospholipid (e.g. phosphatidylcholine)', kv: [['Length', '≈ 2.5 nm'], ['Area in membrane', '≈ 0.65 nm²'], ['Tails', 'two']], desc: 'The building block of modern cell membranes. Cells evolved these from the simpler fatty acids of protocells.' };
  }
  if (s.t === LIPID) {
    return { title: 'Fatty acid (decanoic acid, C₁₀H₂₀O₂)', kv: [['Length', '≈ 1.5 nm'], ['Head', 'carboxyl (hydrophilic)'], ['Tail', 'hydrocarbon (hydrophobic)']], desc: 'A simple amphiphile likely present in the prebiotic ocean. In water such molecules self-assemble into bilayer membranes 4 nm thick.' };
  }
  const n = NT_INFO[s.t];
  return { title: n.name, kv: [['Formula', n.formula], ['Size', '≈ 1 nm'], ['Base', `${n.base} (${n.ring})`], ['Pairs with', n.pair]], desc: 'An RNA building block: phosphate + ribose sugar + nucleobase. Free nucleotides are drawn from the soup by replicators and protocells.' };
}

// ------------------------------------------------------------- polymers
function polymerFrame(p) { return { x: p._rx ?? p.x, y: p._ry ?? p.y, ang: p._drawAng ?? p.ang }; }

function nucleotideIn(p, i, renderer, parent) {
  const frame = () => {
    const lay = renderer.layout(p), q = lay.pts[Math.min(i, lay.pts.length - 1)];
    const f = polymerFrame(p), pos = inFrame(f, q[0], q[1]);
    return { x: pos.x, y: pos.y, ang: f.ang + Math.atan2(q[3], q[2]) - Math.PI / 2 };
  };
  return molecule(p.seq[i], frame, () => p.dead || i >= p.seq.length, parent, { label: `${i + 1}. ${BASES[p.seq[i]]} · ${NT_INFO[p.seq[i]].base}`, polymer: p, index: i });
}

function polymerParts(s, renderer) {
  const p = s.obj, lay = renderer.layout(p), out = [];
  if (p.prog > 0) {
    out.push(part(`Daughter strand (${p.prog}/${p.seq.length})`, anchored(() => p, s.obj._rad || 0.01, () => p.dead), {
      title: 'Daughter strand being copied',
      kv: [['Copied so far', `${p.prog} of ${p.seq.length} bases`], ['Copy fidelity', `${(p.fid * 100).toFixed(1)}% per base`]],
      desc: `The ribozyme is building a copy of itself, one nucleotide at a time, from free nucleotides: ${p.copy.map((b) => BASES[b]).join('')}…`,
    }, { parent: s }));
  }
  if (lay.pairs.length) {
    out.push(part('Hairpin stem', anchored(() => p, s.obj._rad || 0.01, () => p.dead), {
      title: 'Hairpin fold',
      kv: [['Stem pairs', String(lay.pairs.length)], ['Loop', `${p.seq.length - lay.pairs.length * 2} nt`]],
      desc: 'Complementary ends of the chain zip together, folding it into a shape. Folding is what turns an inert chain into a catalyst (ribozyme).',
    }, { parent: s }));
  }
  for (let i = 0; i < p.seq.length; i++) out.push(nucleotideIn(p, i, renderer, s));
  return out;
}

// --------------------------------------------------------------- membranes
function membraneLipid(cx, cy, R, theta, isDead, parent, label, phospho = false) {
  const hr = DIM.lipidHead * NM;
  const frame = () => { const c = { x: cx(), y: cy() }; return { x: c.x + Math.cos(theta) * (R() - hr), y: c.y + Math.sin(theta) * (R() - hr), ang: theta + Math.PI / 2 }; };
  return molecule(LIPID, frame, isDead, parent, { label, phospho });
}

function lipidCount(rUnits, areaPerLipid) {
  const rNm = rUnits * NM_PER_UNIT;
  const n = (2 * 4 * Math.PI * rNm * rNm) / areaPerLipid;
  return n.toExponential(1).replace('e+', ' × 10^');
}

// --------------------------------------------------------------- vesicles
function vesicleParts(s, renderer) {
  const v = s.obj, dead = () => v.dead, out = [];
  const m = maturity(v), ph = phospholipidShare(m);
  const mem = part(ph > 0.01 ? 'Mixed bilayer membrane' : 'Fatty-acid bilayer membrane', anchored(() => ({ x: v.x + v.r, y: v.y }), DIM.bilayer * NM * 3, dead), {
    title: ph > 0.01 ? 'Fatty-acid / phospholipid bilayer' : 'Fatty-acid bilayer',
    kv: [['Thickness', '≈ 4 nm'], ['Diameter', um(v.r * 2)], ['Molecules (3D estimate)', lipidCount(v.r, 0.3)], ['Phospholipids', `${(ph * 100).toFixed(0)}% (blue heads, two tails)`]],
    desc: ph > 0.01
      ? 'Two layers of lipids, tails inward. Phospholipids are mixing in among the fatty acids: they pack tighter, so the membrane gets sturdier and less leaky. A fully phospholipid membrane, as in cells, keeps nucleotides out, so cells later need transport proteins.'
      : 'Two layers of fatty acids, tails inward. Leaky enough to let nucleotides diffuse in, tight enough to keep RNA chains trapped.',
  }, { parent: s, ring: { c: v, phospho: false, label: 'A fatty acid in the membrane' }, outline: () => ({ type: 'circle', x: v.x, y: v.y, r: v.r, w: DIM.bilayer * NM }) });
  mem.kids = () => [membraneLipid(() => v.x, () => v.y, () => v.r, 0, dead, mem, 'A fatty acid in the membrane')];
  out.push(mem);
  const core = protoRibosome(v, m);
  for (const p of v.polys) {
    out.push(sel('polymer', p, { parent: s, label: `RNA, ${p.seq.length} nt${p === core ? ' · proto-ribosome' : p.act > 0 ? ' · ribozyme' : ''}`, note: p.act > 0 ? `${(p.act * 100).toFixed(0)}% active · ${magnesiumCount(p)} Mg²⁺` : '' }));
  }
  if (core) out.push(part('Proto-ribosome', anchored(() => core, Math.max(5, (core.seq.length * DIM.ntRise) / 2 + 2.5) * NM, dead), {
    title: 'Proto-ribosome (hypothesis)',
    kv: [['Built from', `a ${core.seq.length} nt ribozyme`], ['Size', '≈ 10 nm']],
    desc: 'The protocell’s best ribozyme, folded together with more RNA into a pocket that joins amino acids into chains. The heart of every modern ribosome is RNA that does exactly this, which suggests it began as a structure like this one.',
  }, { parent: s }));
  const peps = peptides(v, m);
  if (peps.length) {
    const g = part('Peptides', anchored(() => v, v.r * 0.6, dead), {
      title: 'Short peptides (plausible)', kv: [['Count', String(peps.length)], ['Amino acids', PREBIOTIC_AA.join(', ')]],
      desc: 'Short chains of the amino acids that form without life (as in the Miller–Urey experiments). Some stick to the RNA and may help it fold or work: an early partnership between RNA and protein.',
    }, { parent: s, group: true, note: `×${peps.length}` });
    g.kids = () => peps.map((pep) => part(`Peptide ${pep.seq.join('-')}`, anchored(() => renderer.peptideAt(v, pep, v.r - DIM.bilayer * NM, protoRibosome(v, maturity(v))), pep.seq.length * 0.3 * NM, dead), {
      title: `Peptide, ${pep.seq.length} amino acids`, kv: [['Sequence', pep.seq.join('-')], ['Length', `≈ ${(pep.seq.length * 0.38).toFixed(1)} nm`], ['Where', pep.onRNA ? 'stuck to an RNA strand' : 'free in the protocell']],
      desc: 'Amino acids linked by peptide bonds. Without a ribosome and a genetic code their order is random, not encoded.',
    }, { parent: g }));
    out.push(g);
  }
  const inner = () => v.r - DIM.bilayer * NM;
  for (let t = 0; t < 4; t++) {
    if (!v.pool[t]) continue;
    const g = part(`Free ${BASES[t]} nucleotides`, anchored(() => v, v.r * 0.6, dead), {
      title: `Pool of ${NT_INFO[t].name}`, kv: [['Count (simulated)', String(v.pool[t])]],
      desc: 'Nucleotides that diffused in through the membrane, waiting to be built into RNA.',
    }, { parent: s, group: true, note: `×${v.pool[t]}` });
    g.kids = () => {
      const out2 = [];
      for (let k = 0; k < Math.min(v.pool[t], 5); k++) {
        // Same positions the renderer uses for pool molecules.
        const seed = (v.id * 7919 + t * 131 + k * 17) >>> 0;
        const frame = () => {
          const r = renderer.rngFor(seed), a = r.next() * TAU, rr = Math.sqrt(r.next()) * 0.85;
          return { x: v.x + Math.cos(a) * rr * inner(), y: v.y + Math.sin(a) * rr * inner(), ang: r.next() * TAU };
        };
        out2.push(molecule(t, frame, dead, g));
      }
      return out2;
    };
    out.push(g);
  }
  return out;
}

// ------------------------------------------------------------------ cells
function cellParts(s, world, renderer) {
  const c = s.obj, a = renderer.anatomy(c), dead = () => c.dead, out = [];
  const at = (fx, fy, r) => anchored(() => ({ x: c.x + fx * c.r, y: c.y + fy * c.r }), r, dead);
  const volUm3 = (4 / 3) * Math.PI * Math.pow(c.r * 0.5, 3);

  const mem = part('Plasma membrane', anchored(() => ({ x: c.x + c.r, y: c.y }), DIM.bilayer * NM * 3, dead), {
    title: 'Plasma membrane (phospholipid bilayer)',
    kv: [['Thickness', '≈ 4 nm'], ['Lipid molecules (estimate)', lipidCount(c.r, 0.65)]],
    desc: 'Phospholipids with two tails each, studded with transport and energy proteins. It holds the proton gradient that powers ATP synthesis.',
  }, { parent: s, ring: { c, phospho: true, label: 'A phospholipid in the membrane' }, outline: () => ({ type: 'circle', x: c.x, y: c.y, r: c.r, w: DIM.bilayer * NM }) });
  mem.kids = () => {
    const out2 = [membraneLipid(() => c.x, () => c.y, () => c.r, 0, dead, mem, 'A phospholipid in the membrane', true)];
    // One example of each kind of membrane protein, at its real slot in the membrane.
    const seen = new Set(), sp = membraneProteinSpacing(c.r);
    for (let k = 0; k < 400 && seen.size < 5; k++) {
      const pr = membraneProteinAt(c, k);
      if (!pr || seen.has(pr.name)) continue;
      seen.add(pr.name);
      out2.push(membraneProtein(c, k, mem));
    }
    return out2;
  };
  out.push(mem);

  const armor = c.armor * (c.type === 4 ? 3 : 1);
  if (armor > 0.15) {
    out.push(part('Cell wall', anchored(() => ({ x: c.x - c.r, y: c.y }), (20 + armor * 80) * NM * 2, dead), {
      title: c.mito ? 'Pellicle / cell wall' : 'Cell wall (peptidoglycan)',
      kv: [['Thickness', formatLen(20 + armor * 80)], ['Armor gene', c.armor.toFixed(2)]],
      desc: 'A tough mesh of sugar chains (glycan strands) tied together by short peptides: it resists bursting and makes the cell harder for predators to digest.',
    }, { parent: s, wallOf: { c, wall: (20 + armor * 80) * NM }, outline: () => ({ type: 'circle', x: c.x, y: c.y, r: c.r + (20 + armor * 80) * NM, w: (20 + armor * 80) * NM }) }));
  }

  out.push(part('Cytoplasm', at(0.6, 0.3, c.r * 0.3), {
    title: 'Cytoplasm',
    kv: [['Volume', `${volUm3.toFixed(1)} µm³`], ['Energy stored', `${c.energy.toFixed(1)} / ${c.cap.toFixed(0)}`], ['Nutrient', `${c.nut.toFixed(2)} / ${c.nutNeed.toFixed(2)}`],
      ['Protein machinery', `${Math.round(c.transl * 100)}%`], ...(c.infected ? [['Infected by virus lineage', `#${c.infected.lineage}`]] : [])],
    desc: 'A crowded gel of water (~70%), proteins, RNA and metabolites, where the chemistry of life happens.',
  }, { parent: s }));

  // Genetic material.
  const genome = part(c.mito ? 'Chromosomes (genome)' : c.dna ? 'Chromosome (nucleoid)' : 'RNA genome', at(c.mito ? a.nuc.fx * 0.34 : 0, c.mito ? a.nuc.fy * 0.34 : 0, c.r * (c.mito ? 0.25 : 0.46)), {
    title: c.mito ? 'Chromatin: DNA wound on nucleosomes' : c.dna ? 'Circular DNA chromosome (nucleoid)' : 'RNA genome (RNA-world cell)',
    kv: [['Genome', c.dna ? 'DNA, double-stranded, proofread' : 'RNA, single-stranded, error-prone'], ['Width', c.mito ? '30 nm fibre / 11 nm nucleosomes' : c.dna ? '2 nm' : '≈ 1 nm'],
      ['Simulated genes', String(Gn.NG)], ['Generation', String(c.gen)], ['Mutation rate gene', c.g[Gn.MUTR].toFixed(2)]],
    desc: c.dna
      ? 'The genome, stored as DNA. Its genes set every trait of the cell; each division copies it, with occasional mutations. Real chromosomes are hundreds of times longer than the cell; this tangle is scaled down.'
      : 'This early cell still keeps its genes in RNA, a leftover of the RNA world. RNA is fragile and copied sloppily; lineages that switch to DNA mutate less.',
  }, { parent: s, genomeOf: c });
  genome.kids = () => geneGroups(c, genome);

  if (c.mito) {
    const nuc = part('Nucleus', at(0, 0, c.r * 0.34 + 90 * NM), { // includes the envelope and its pores
      title: 'Nucleus', kv: [['Diameter', um(c.r * 0.68)], ['Envelope', 'two membranes, 30 nm apart']],
      desc: 'Walls the genome off from the cytoplasm, a defining feature of eukaryotes.',
    }, { parent: s, nucleusOf: c, outline: () => ({ type: 'circle', x: c.x, y: c.y, r: c.r * 0.34 + DIM.nuclearGap * NM }) });
    genome.parent = nuc; // in eukaryotes the genome lives inside the nucleus
    nuc.kids = () => [
      part('Nuclear envelope & pores', at(0.34, 0, DIM.nuclearPore * NM), { title: 'Nuclear envelope', kv: [['Pore diameter', '≈ 100 nm'], ['Gap between membranes', '≈ 30 nm'], ['Pores (drawn)', String(nuclearPores(c).length)]], desc: 'A double membrane perforated by pore complexes, gates that let RNA out and proteins in.' }, { parent: nuc, outline: () => ({ type: 'circle', x: c.x, y: c.y, r: c.r * 0.34 + DIM.nuclearGap * NM, w: DIM.nuclearGap * NM }) }),
      part('Nucleolus', at(a.nuc.fx * 0.34, a.nuc.fy * 0.34, c.r * 0.1), { title: 'Nucleolus', kv: [['Diameter', um(c.r * 0.2)]], desc: 'Dense region where ribosomal RNA is made and ribosomes are assembled.' }, { parent: nuc }),
      genome,
    ];
    out.push(nuc);
  } else {
    out.push(genome);
  }

  // Ribosomes.
  const nRib = a.ribo.length / 2;
  // ~20,000 per µm³ in a fast-growing bacterium; eukaryotes are far less densely packed (~4,000 per µm³).
  const ribEst = Math.round(volUm3 * (c.mito ? 4000 : 20000) * (0.3 + 0.7 * c.transl));
  const ribs = part('Ribosomes', at(a.ribo[0] || 0, a.ribo[1] || 0, c.r * 0.5), {
    title: `Ribosomes (${c.mito ? '80S' : '70S'})`,
    kv: [['Size', c.mito ? '≈ 25–30 nm' : '≈ 22 nm'], ['In this cell (estimate)', `≈ ${ribEst.toLocaleString()}`], ['Drawn (2D slice)', String(nRib)]],
    desc: 'Molecular machines that read messenger RNA and build proteins. They are largely made of RNA, a living echo of the RNA world.',
  }, { parent: s, group: true, note: `≈ ${ribEst.toLocaleString()}` });
  ribs.kids = () => {
    const list = [];
    for (let k = 0; k < Math.min(nRib, 8); k++) list.push(ribosome(c, k, at, ribs));
    return list;
  };
  out.push(ribs);

  if (a.thyl) {
    out.push(part('Thylakoid membranes', at(0.72, 0, c.r * 0.1), {
      title: 'Thylakoid membranes', kv: [['Spacing', '≈ 50 nm'], ['Photosynthesis gene', c.g[Gn.PHOTO].toFixed(2)]],
      desc: 'Internal membranes packed with chlorophyll and photosystems that turn light into chemical energy, as in cyanobacteria.',
    }, { parent: s, shape: { w: 10 * NM * 3, lines: () => [0.8, 0.72, 0.64].map((f) => circlePts(c.x, c.y, c.r * f)) } }));
  }

  if (!c.mito) {
    const grp = (label, list, make, info) => {
      if (!list.length) return;
      const g = part(label, at(list[0].fx, list[0].fy, c.r * 0.2), info, { parent: s, group: true, note: `×${list.length}` });
      g.kids = () => list.map((q, k) => make(q, k, g));
      out.push(g);
    };
    grp('Plasmids', a.plasmids, (q, k, g) => part(`Plasmid ${k + 1}`, at(q.fx, q.fy, 100 * NM), {
      title: 'Plasmid', kv: [['Form', 'small circle of DNA'], ['Size (drawn)', '≈ 0.5 µm around']],
      desc: 'An extra mini-chromosome separate from the main genome. Plasmids often carry handy genes and can be copied into other cells through a pilus.',
    }, { parent: g }), { title: 'Plasmids', kv: [], desc: 'Small extra DNA circles.' });
    grp('Storage granules', a.granules, (q, k, g) => part(`Granule ${k + 1}`, at(q.fx, q.fy, 50 * NM * q.s), {
      title: 'Storage granule', kv: [['Diameter', formatLen(100 * q.s)], ['Holds', 'polyphosphate or glycogen']], desc: 'Energy and phosphate stockpiled for lean times.',
    }, { parent: g }), { title: 'Storage granules', kv: [], desc: 'Reserves of energy and nutrients.' });
    grp('Carboxysomes', a.carbox, (q, k, g) => {
      const cb = part(`Carboxysome ${k + 1}`, at(q.fx, q.fy, 60 * NM * q.s), {
        title: 'Carboxysome', kv: [['Diameter', formatLen(120 * q.s)], ['Shape', 'icosahedral protein shell']],
        desc: 'A protein shell that concentrates CO₂ around the enzyme RuBisCO, making carbon fixation far more efficient.',
      }, { parent: g });
      cb.kids = () => [
        part('RuBisCO', at(q.fx, q.fy, 6 * NM), { title: 'RuBisCO enzyme', kv: [['Size', '≈ 11 nm'], ['Job', 'fixes CO₂ into sugar']], desc: 'Probably the most abundant protein on Earth, and a famously slow one.' }, { parent: cb }),
        part('Shell proteins', at(q.fx + 0.001, q.fy, 10 * NM), { title: 'Shell proteins', kv: [], desc: 'Hexagonal tiles that assemble into the shell, letting bicarbonate in but keeping CO₂ from leaking out.' }, { parent: cb }),
      ];
      return cb;
    }, { title: 'Carboxysomes', kv: [], desc: 'Carbon-fixing compartments of photosynthetic bacteria.' });
    if (a.pili.length) {
      const pg = part('Pili', at(Math.cos(a.pili[0].ang), Math.sin(a.pili[0].ang), 7 * NM), { title: 'Pili', kv: [['Count', String(a.pili.length)], ['Width', '≈ 7 nm']], desc: 'Hair-like protein filaments for gripping surfaces and for conjugation: passing DNA to another cell.' },
        { parent: s, group: true, note: `×${a.pili.length}` });
      pg.kids = () => piliLines(c, a).map((l, k) => {
        const pl = part(`Pilus ${k + 1}`, anchored(() => ({ x: (l.x1 + l.x2) / 2, y: (l.y1 + l.y2) / 2 }), 7 * NM, dead), {
          title: 'Pilus', kv: [['Length', formatLen(Math.hypot(l.x2 - l.x1, l.y2 - l.y1) / NM)], ['Width', '≈ 7 nm']],
          desc: 'A thin rod of pilin proteins. A conjugative pilus reaches out to another cell, pulls it close, and a copy of a plasmid passes across.',
        }, { parent: pg, shape: { w: 7 * NM * 2, lines: () => { const q = piliLines(c, a)[k]; return [[{ x: q.x1, y: q.y1 }, { x: q.x2, y: q.y2 }]]; } } });
        pl.kids = () => [part('Pilin subunits', anchored(() => ({ x: l.x2, y: l.y2 }), 3 * NM, dead), { title: 'Pilin', kv: [['Size', '≈ 15 kDa protein']], desc: 'Thousands of copies spiral together to build the filament; it can grow or retract.' }, { parent: pl })];
        return pl;
      });
      out.push(pg);
    }
  }

  if (c.mito) {
    // Endoplasmic reticulum (rough: studded with ribosomes).
    const erLines = () => a.er.map((e) => arcPts(c.x, c.y, e.rr * c.r, e.a0, e.a0 + e.span));
    const er = part('Endoplasmic reticulum', at(a.er[0].rr * Math.cos(a.er[0].a0), a.er[0].rr * Math.sin(a.er[0].a0), c.r * 0.1), {
      title: 'Rough endoplasmic reticulum', kv: [['Tubule width', '≈ 50 nm'], ['Bound ribosomes (drawn)', String(erRibosomes(c, a).length)]],
      desc: 'A folded membrane network continuous with the nuclear envelope. Ribosomes on its surface feed new proteins straight inside, to be folded and shipped.',
    }, { parent: s, shape: { w: 120 * NM, lines: erLines }, erOf: c }); // the tubules plus their bound ribosomes
    er.kids = () => [
      part('ER membrane', anchored(() => erLines()[0][0], 25 * NM, dead), { title: 'ER membrane', kv: [], desc: 'One continuous membrane enclosing the lumen, where proteins fold.' }, { parent: er }),
      boundRibosome(c, a, 0, er),
    ];
    out.push(er);

    // Golgi apparatus.
    const gl = part('Golgi apparatus', at(a.golgi.fx, a.golgi.fy, Math.min(1.2, c.r * 0.15)), {
      title: 'Golgi apparatus', kv: [['Cisternae', String(a.golgi.n)], ['Width', '≈ 1.2 µm']],
      desc: 'The cell’s post office: proteins from the ER pass through its stacked sacs, get modified and sorted, then leave in vesicles.',
    }, { parent: s, golgiOf: c });
    gl.kids = () => [
      ...golgiCisternae(c, a).map((cis) => part(`${cis.face[0].toUpperCase() + cis.face.slice(1)} cisterna`, anchored(() => golgiCisternae(c, a)[cis.i].pts[5], 15 * NM, dead), {
        title: `Golgi cisterna (${cis.face} face)`, kv: [['Thickness', '≈ 30 nm']],
        desc: cis.face === 'cis' ? 'Receives cargo from the ER.' : cis.face === 'trans' ? 'Ships finished proteins out in vesicles.' : 'Adds and trims sugar chains on proteins passing through.',
      }, { parent: gl, shape: { w: 30 * NM, lines: () => [golgiCisternae(c, a)[cis.i].pts] } })),
      ...golgiVesicles(c, a, renderer.time ?? 0).map((v, k) => part(`Transport vesicle ${k + 1}`, anchored(() => golgiVesicles(c, a, renderer.time ?? 0)[k], 30 * NM, dead), {
        title: 'Transport vesicle', kv: [['Diameter', '≈ 60 nm']], desc: 'A tiny membrane bubble carrying cargo to the cell surface or to lysosomes.',
      }, { parent: gl })),
    ];
    out.push(gl);

    // Centrosome and the microtubule cytoskeleton.
    const ce = part('Centrosome', at(a.centro.fx, a.centro.fy, 500 * NM), {
      title: 'Centrosome', kv: [['Diameter', '≈ 1 µm'], ['Centrioles', '2, at right angles']],
      desc: 'The main microtubule-organising centre. It anchors the cytoskeleton and, when the cell divides, organises the spindle that separates the chromosomes.',
    }, { parent: s });
    ce.kids = () => [0, 1].map((k) => part(`Centriole ${k + 1}`, anchored(() => ({ x: c.x + a.centro.fx * c.r + (k ? 0.12 : -0.12) * 0, y: c.y + a.centro.fy * c.r }), 250 * NM, dead), {
      title: 'Centriole', kv: [['Size', '≈ 250 × 500 nm'], ['Structure', '9 triplets of microtubules']],
      desc: 'A short barrel of microtubules; a pair sits at the heart of every centrosome, and the same barrel builds the base of a flagellum.',
    }, { parent: ce }));
    out.push(ce);
    const mtg = part('Microtubules', at(a.centro.fx, a.centro.fy, 25 * NM), {
      title: 'Microtubules', kv: [['Diameter', '25 nm'], ['Drawn', String(a.mts.length)]],
      desc: 'Hollow tubes of tubulin radiating from the centrosome: tracks along which motor proteins haul organelles and vesicles.',
    }, { parent: s, group: true, note: `×${a.mts.length}` });
    mtg.kids = () => microtubules(c, a, renderer.time ?? 0).map((m, k) => {
      const mt = part(`Microtubule ${k + 1}`, anchored(() => { const q = microtubules(c, a, renderer.time ?? 0)[k]; return { x: (q.x1 + q.x2) / 2, y: (q.y1 + q.y2) / 2 }; }, 12 * NM, dead), {
        title: 'Microtubule', kv: [['Diameter', '25 nm'], ['Built from', 'α/β-tubulin dimers, 13 protofilaments']],
        desc: 'Grows and shrinks at its tip all the time (dynamic instability), letting the cell remodel its skeleton within minutes.',
      }, { parent: mtg, shape: { w: 25 * NM, lines: () => { const q = microtubules(c, a, renderer.time ?? 0)[k]; return [[{ x: q.x1, y: q.y1 }, { x: q.x2, y: q.y2 }]]; } }, mtOf: { c, k } });
      return mt;
    });
    out.push(mtg);

    const blobGroup = (label, list, R, info, one) => {
      if (!list || !list.length) return;
      const g = part(label, at(list[0].fx, list[0].fy, R), info, { parent: s, group: true, note: `×${list.length}` });
      g.kids = () => list.map((q, k) => part(`${one} ${k + 1}`, at(q.fx, q.fy, R * q.s), { ...info, title: one, kv: [['Diameter', formatLen((R * q.s * 2) / NM)]] }, { parent: g }));
      out.push(g);
    };
    blobGroup('Lysosomes', a.lyso, 250 * NM, { title: 'Lysosomes', kv: [], desc: 'Acidic sacs of digestive enzymes that break down worn-out parts and anything the cell swallows.' }, 'Lysosome');
    blobGroup('Peroxisomes', a.perox, 200 * NM, { title: 'Peroxisomes', kv: [], desc: 'Small compartments that break down fatty acids and destroy toxic hydrogen peroxide, important once oxygen arrived.' }, 'Peroxisome');
    if (a.vacuole) {
      out.push(part('Central vacuole', at(a.vacuole.fx, a.vacuole.fy, a.vacuole.r * c.r), {
        title: 'Central vacuole', kv: [['Diameter', um(a.vacuole.r * c.r * 2)]], desc: 'A large water-filled sac that keeps an alga firm and stores ions, sugars and pigments.',
      }, { parent: s }));
    }

    const mg = part(`Mitochondria`, at(a.mitos[0].fx, a.mitos[0].fy, c.r * 0.5), {
      title: 'Mitochondria', kv: [['Count (drawn)', String(a.mitos.length)], ['Aerobic gene', c.aer.toFixed(2)]],
      desc: 'Descendants of an aerobic bacterium engulfed by this lineage’s ancestor (endosymbiosis). They burn food with oxygen for far more energy.',
    }, { parent: s, group: true, note: `×${a.mitos.length}` });
    mg.kids = () => a.mitos.map((m, k) => mitochondrion(c, m, k, at, mg));
    out.push(mg);
    if (a.plast.length) {
      const pg = part('Chloroplasts', at(a.plast[0].fx, a.plast[0].fy, c.r * 0.5), {
        title: 'Chloroplasts', kv: [['Count (drawn)', String(a.plast.length)]],
        desc: 'Descendants of a photosynthetic bacterium kept by a eukaryote: this lineage is an alga.',
      }, { parent: s, group: true, note: `×${a.plast.length}` });
      pg.kids = () => a.plast.map((p, k) => chloroplast(c, p, k, at, pg));
      out.push(pg);
    }
  }

  // Viruses being assembled inside an infected cell.
  if (c.infected) {
    const caps = capsids(c, renderer.time ?? world.t);
    if (caps.length) {
      const vg = part('New virus particles', anchored(() => capsids(c, renderer.time ?? world.t)[0] || c, DIM.virus * NM, dead), {
        title: 'Virus particles assembling', kv: [['So far', String(caps.length)], ['Virus lineage', `#${c.infected.lineage}`]],
        desc: 'The cell’s own machinery has been hijacked to build virus capsids. When enough are ready, the cell bursts and releases them.',
      }, { parent: s, group: true, note: `×${caps.length}` });
      vg.kids = () => capsids(c, renderer.time ?? world.t).map((q, k) => part(`Assembling capsid ${k + 1}`, anchored(() => capsids(c, renderer.time ?? world.t)[k] || q, DIM.virus * NM, dead), {
        title: 'Assembling virus capsid', kv: [['Diameter', '≈ 100 nm']], desc: 'A new shell, being packed with a copy of the viral genome.',
      }, { parent: vg }));
      out.push(vg);
    }
  }

  if (c.motil > 0.3) {
    const len = Math.min(20, c.r * 5);
    const fpos = () => {
      const sp = Math.hypot(c.vx, c.vy);
      let ux = -Math.cos(c.heading), uy = -Math.sin(c.heading);
      if (sp > 0.02) { ux = -c.vx / sp; uy = -c.vy / sp; }
      return { x: c.x + ux * (c.r + len * 0.3), y: c.y + uy * (c.r + len * 0.3) };
    };
    const fl = part('Flagellum', anchored(fpos, len * 0.3, dead), c.mito ? {
      title: 'Eukaryotic flagellum (undulipodium)', kv: [['Length', um(len)], ['Width', '≈ 250 nm'], ['Motility gene', c.motil.toFixed(2)]],
      desc: 'A whip of 9+2 microtubules that bends by dynein motors, a completely different machine from the bacterial flagellum.',
    } : {
      title: 'Bacterial flagellum', kv: [['Length', um(len)], ['Filament width', '≈ 20 nm'], ['Motility gene', c.motil.toFixed(2)]],
      desc: 'A rigid helical propeller spun at hundreds of revolutions per second by a rotary motor in the membrane.',
    }, { parent: s, shape: { w: (c.mito ? 250 : 20) * NM * 2, lines: () => [flagellumPath(c, renderer.time ?? world.t)] } });
    if (c.mito) {
      fl.kids = () => [
        part('Axoneme (9+2 microtubules)', anchored(fpos, 125 * NM, dead), { title: 'Axoneme', kv: [['Layout', '9 doublets around 2 central microtubules'], ['Width', '≈ 250 nm']], desc: 'The core of the flagellum, the same design in sperm tails, cilia and algae.' }, { parent: fl }),
        part('Dynein motors', anchored(fpos, 40 * NM, dead), { title: 'Dynein arms', kv: [['Fuel', 'ATP']], desc: 'Motor proteins that walk the doublets past one another; because they are tied together, the whole whip bends.' }, { parent: fl }),
        part('Basal body', at(-1, 0, 125 * NM), { title: 'Basal body', kv: [['Structure', 'a centriole']], desc: 'Anchors the flagellum in the cell, and grows it.' }, { parent: fl }),
      ];
    } else {
      fl.kids = () => [
        part('Rotary motor (basal body)', at(-1, 0, 45 * NM), { title: 'Basal body motor', kv: [['Diameter', '≈ 45 nm'], ['Power', 'proton flow across the membrane']], desc: 'A true rotary engine of about 20 protein types, spinning the hook and filament.' }, { parent: fl }),
        part('Hook', at(-1.05, 0, 30 * NM), { title: 'Hook', kv: [['Length', '≈ 55 nm']], desc: 'A flexible universal joint between motor and filament.' }, { parent: fl }),
        part('Filament (flagellin)', anchored(fpos, 20 * NM, dead), { title: 'Filament', kv: [['Width', '≈ 20 nm'], ['Made of', 'thousands of flagellin proteins']], desc: 'The helical propeller itself.' }, { parent: fl }),
      ];
    }
    out.push(fl);
  }

  // Junctions to neighbouring cells in the same organism.
  if (c.bonds.length) {
    const jg = part(`Cell junctions (${c.bonds.length})`, at(0.9, 0, c.r * 0.2), {
      title: 'Cell–cell junctions', kv: [['Neighbours', String(c.bonds.length)], ['Sharing gene', c.share.toFixed(2)]],
      desc: 'Adhesion between daughter cells that never fully separated. Cytoplasmic bridges let energy and nutrients flow between them.',
    }, { parent: s, group: true, note: `×${c.bonds.length}` });
    jg.kids = () => c.bonds.map((o) => {
      const pos = () => { const t = c.r / (c.r + o.r); return { x: c.x + (o.x - c.x) * t, y: c.y + (o.y - c.y) * t }; };
      const j = part(`Junction with cell #${o.id}`, anchored(pos, Math.min(c.r, o.r) * 0.45, () => c.dead || o.dead), {
        title: 'Cell junction', kv: [['Neighbour', `#${o.id} (${TYPE_NAMES[o.type]})`]],
        desc: 'Where two daughter cells never fully separated: adhesion proteins hold the membranes together, and channels (cytoplasmic bridges) let food and signals pass between them.',
      }, { parent: jg, note: TYPE_NAMES[o.type] });
      j.kids = () => [sel('cell', o, { label: `Neighbour cell #${o.id}`, note: TYPE_NAMES[o.type] })];
      return j;
    });
    out.push(jg);
  }
  return out;
}

function ribosome(c, k, at, parent) {
  const a = c._anat, fx = a.ribo[k * 2], fy = a.ribo[k * 2 + 1];
  const pos = () => ({ x: c.x + fx * c.r, y: c.y + fy * c.r });
  return translatingRibosome(c, pos, c.id * 4099 + k, `Ribosome ${k + 1}`, parent);
}

// A ribosome as the molecular machine it is (see ribosome.js): subunits of rRNA and protein,
// messenger RNA, transfer RNAs and the protein being made, all clickable down to single residues.
function translatingRibosome(c, pos, seed, label, parent, bound = false) {
  const m = ribosomeModel(seed, c.mito), ang = ribosomeAngle(seed), dead = () => c.dead, euk = c.mito;
  const W = (lx, ly) => { const p = pos(), ca = Math.cos(ang), sa = Math.sin(ang); return { x: p.x + (lx * ca - ly * sa) * NM, y: p.y + (lx * sa + ly * ca) * NM }; };
  const at = (lx, ly, r) => anchored(() => W(lx, ly), r * NM, dead);
  const shape = (pts, w) => ({ w: w * NM, lines: () => [pts.map((q) => W(q.x, q.y))] });
  const ell = (e) => () => { const q = W(e.cx, e.cy); return { type: 'ellipse', x: q.x, y: q.y, rx: e.rx * NM, ry: e.ry * NM, ang }; };
  const rb = part(label, at(0, 0, (DIM.ribosome * (euk ? 1.2 : 1)) / 2), {
    title: bound ? '80S ribosome on the ER' : euk ? '80S ribosome' : '70S ribosome',
    kv: [['Diameter', euk ? '≈ 25 nm' : '≈ 21 nm'], ['Mass', euk ? '≈ 4.3 MDa' : '≈ 2.5 MDa'], ['RNA content', '≈ 60%'], ['Now making', `a protein, ${m.peptide.length} amino acids so far`]],
    desc: (bound ? 'Docked on the ER, it threads the protein it makes straight through the membrane. ' : '') + 'It reads a messenger RNA three bases (one codon) at a time; transfer RNAs bring the matching amino acids, and the large subunit links them into a protein. The catalytic core is made of RNA, a living echo of the RNA world.',
  }, { parent });
  const rnaPart = (lbl, pts, info, par) => part(lbl, at(pts[pts.length >> 1].x, pts[pts.length >> 1].y, 1), info, { parent: par, shape: shape(pts, 1.6), rnaOf: { pts, W, c } });
  rb.kids = () => {
    const Lg = part(euk ? 'Large subunit (60S)' : 'Large subunit (50S)', at(m.L.cx, m.L.cy, m.L.ry), {
      title: 'Large subunit', kv: [['Contains', euk ? '28S, 5.8S, 5S rRNA + ~47 proteins' : '23S + 5S rRNA + ~33 proteins']],
      desc: 'Holds the peptidyl-transferase centre, a ribozyme that forges peptide bonds, and the tunnel the new protein leaves through.',
    }, { parent: rb, outline: ell(m.L) });
    Lg.kids = () => [
      rnaPart(euk ? '28S rRNA' : '23S rRNA', m.rnaL, { title: euk ? '28S ribosomal RNA' : '23S ribosomal RNA', kv: [['Real length', euk ? '≈ 4,700 nucleotides' : '≈ 2,900 nucleotides'], ['Drawn', `${m.rnaL.length} nucleotides (scaled down)`]], desc: 'The structural and catalytic heart of the large subunit. Its folded chain forms the active site that joins amino acids.' }, Lg),
      rnaPart('5S rRNA', m.rna5S, { title: '5S ribosomal RNA', kv: [['Real length', '≈ 120 nucleotides']], desc: 'A small RNA that helps hold the large subunit together.' }, Lg),
      ...m.protL.map((pr) => part(`Ribosomal protein ${pr.name}`, at(pr.x, pr.y, pr.r), { title: `Ribosomal protein ${pr.name}`, kv: [['Size', `≈ ${(pr.r * 2).toFixed(0)} nm`]], desc: 'One of the proteins that clamp and stabilise the rRNA fold. They mostly sit on the outside; the RNA does the chemistry.' }, { parent: Lg })),
      part('Peptidyl-transferase centre', at(0.6 * m.s, 5.9 * m.s, 1.2), { title: 'Peptidyl-transferase centre', kv: [['Made of', 'rRNA only']], desc: 'Where each new amino acid is joined to the growing chain. It is a ribozyme: proof that RNA can catalyse the chemistry of life.' }, { parent: Lg }),
      part('Exit tunnel', at(0.3 * m.s, 9 * m.s, 0.8), { title: 'Polypeptide exit tunnel', kv: [['Length', '≈ 10 nm'], ['Width', '≈ 1.5 nm']], desc: 'The new protein snakes out through this narrow tunnel in the large subunit.' }, { parent: Lg, shape: { w: 1.6 * NM, lines: () => [[W(0.3 * m.s, 5.8 * m.s), W(0.3 * m.s, m.L.cy + m.L.ry)]] } }),
    ];
    const Sm = part(euk ? 'Small subunit (40S)' : 'Small subunit (30S)', at(m.S.cx, m.S.cy, m.S.ry), {
      title: 'Small subunit', kv: [['Contains', euk ? '18S rRNA + ~33 proteins' : '16S rRNA + ~21 proteins']],
      desc: 'Grips the messenger RNA and checks each codon against the anticodon of the incoming transfer RNA.',
    }, { parent: rb, outline: ell(m.S) });
    Sm.kids = () => [
      rnaPart(euk ? '18S rRNA' : '16S rRNA', m.rnaS, { title: euk ? '18S ribosomal RNA' : '16S ribosomal RNA', kv: [['Real length', euk ? '≈ 1,900 nucleotides' : '≈ 1,500 nucleotides'], ['Drawn', `${m.rnaS.length} nucleotides (scaled down)`]], desc: 'Forms the decoding centre. Its sequence changes so slowly that biologists use it to build the tree of all life.' }, Sm),
      ...m.protS.map((pr) => part(`Ribosomal protein ${pr.name}`, at(pr.x, pr.y, pr.r), { title: `Ribosomal protein ${pr.name}`, kv: [['Size', `≈ ${(pr.r * 2).toFixed(0)} nm`]], desc: 'A protein of the small subunit.' }, { parent: Sm })),
      part('Decoding centre', at(2.7 * m.s, -1.2 * m.s, 1), { title: 'Decoding centre', kv: [], desc: 'Where the codon on the mRNA and the anticodon of the tRNA are checked for a perfect match before the amino acid is accepted.' }, { parent: Sm }),
    ];
    const mr = part('Messenger RNA', at(0, m.mrna[0].y, 1), {
      title: 'Messenger RNA (mRNA)', kv: [['Read', '5′ → 3′, one codon (3 bases) at a time'], ['Drawn', `${m.mrna.length} nucleotides`]],
      desc: 'A working copy of one gene. The ribosome slides along it, translating its codons into amino acids.',
    }, { parent: rb, shape: shape(m.mrna, 1.4), rnaOf: { pts: m.mrna, W, c } });
    const B = ['A', 'U', 'G', 'C'];
    const trna = m.trna.map((t) => {
      const tp = part(`tRNA in the ${t.site} site`, at(t.pts[1].x, t.pts[1].y, 1.5), {
        title: `Transfer RNA (${t.site} site)`,
        kv: [['Anticodon', t.anticodon.map((b) => B[b]).join('')], ['Pairs with codon', t.codon.map((b) => B[b]).join('')], ['Carries', t.site === 'E' ? 'nothing (it has delivered)' : AMINO_NAMES[t.aa]], ['Size', '≈ 7 nm, L-shaped']],
        desc: t.site === 'A' ? 'Arriving with the next amino acid. It stays only if its anticodon matches the codon.' : t.site === 'P' ? 'Holding the growing protein chain while the next amino acid is added.' : 'Empty, about to leave the ribosome and be reloaded with another amino acid.',
      }, { parent: rb, shape: shape(t.pts, 1.8) });
      tp.kids = () => [
        part(`Anticodon ${t.anticodon.map((b) => B[b]).join('')}`, at(t.x, t.pts[0].y, 1), { title: 'Anticodon loop', kv: [['Bases', t.anticodon.map((b) => B[b]).join('')]], desc: 'Three bases that pair with the codon on the mRNA, the dictionary of the genetic code.' }, { parent: tp }),
        ...(t.site !== 'E' ? [part(AMINO_NAMES[t.aa], at(t.pts[3].x + 0.4, t.pts[3].y + 0.3, 0.5), { title: `${AMINO_NAMES[t.aa]} (${t.aa})`, kv: [], desc: 'The amino acid this tRNA carries, attached to its acceptor end.' }, { parent: tp })] : []),
      ];
      return tp;
    });
    const pe = part('New protein chain', at(m.peptide[m.peptide.length >> 1].x, m.peptide[m.peptide.length >> 1].y, 1), {
      title: 'Nascent protein', kv: [['Length so far', `${m.peptide.length} amino acids`], ['Sequence start', m.peptide.slice(0, 8).map((q) => q.aa).join('-') + '…']],
      desc: 'The protein being made, emerging from the exit tunnel. Once released it will fold into its working shape.',
    }, { parent: rb, shape: shape(m.peptide, 0.9), peptideOf: { pts: m.peptide, W, c } });
    return [Lg, Sm, mr, ...trna, pe];
  };
  return rb;
}

function mitochondrion(c, m, k, at, parent) {
  const { L, W } = mitoSize(c, m), dead = () => c.dead;
  const lp = (lx, ly) => () => local(c, m, lx, ly);
  const mt = part(`Mitochondrion ${k + 1}`, at(m.fx, m.fy, L / 2), {
    title: 'Mitochondrion', kv: [['Length', um(L)], ['Membranes', 'outer + folded inner']],
    desc: 'The cell’s power plant: pumps protons across its inner membrane and lets them flow back through ATP synthase.',
  }, { parent, mitoOf: { c, m }, outline: () => { const q = local(c, m, 0, 0); return { type: 'ellipse', x: q.x, y: q.y, rx: L / 2, ry: W / 2, ang: m.ang }; } });
  mt.kids = () => [
    part('Outer membrane', anchored(lp(L / 2, 0), 7 * NM, dead), { title: 'Outer membrane', kv: [['Thickness', '≈ 7 nm']], desc: 'Smooth and porous: a remnant of the ancestral bacterium’s outer envelope.' }, { parent: mt, outer: true, outline: () => { const q = local(c, m, 0, 0); return { type: 'ellipse', x: q.x, y: q.y, rx: L / 2, ry: W / 2, ang: m.ang }; } }),
    ...cristae(L, W).map((cr, i) => {
      const cp = part(`Crista ${i + 1}`, anchored(lp(cr.x, (cr.y1 + cr.y2) / 2), 10 * NM, dead), {
        title: 'Crista (fold of the inner membrane)', kv: [['Holds', 'electron transport chain, ATP synthase']],
        desc: 'Folding the inner membrane packs in far more respiratory machinery. Electrons flow down the chain, pumping protons into the folds.',
      }, { parent: mt, shape: { w: 34 * NM, lines: () => [[local(c, m, cr.x, cr.y1), local(c, m, cr.x, cr.y2)]] } }); // fold plus its ATP synthases
      cp.kids = () => [part('ATP synthase', anchored(lp(cr.x + 8 * NM, (cr.y1 + cr.y2) / 2), 5 * NM, dead), {
        title: 'ATP synthase', kv: [['Size', '≈ 10 nm head'], ['Speed', '~100 rotations per second']],
        desc: 'Protons rushing back through it turn a rotor, and each turn makes three ATP molecules.',
      }, { parent: cp })];
      return cp;
    }),
    part('Mitochondrial DNA', anchored(lp(L * 0.18, 0), W * 0.12, dead), { title: 'mtDNA', kv: [['Form', 'small circular chromosome']], desc: 'Its own little genome, proof of its bacterial origin.' }, { parent: mt }),
    part('Matrix', anchored(lp(-L * 0.2, 0), W * 0.35, dead), { title: 'Matrix', kv: [], desc: 'Interior where the citric-acid cycle strips electrons from food.' }, { parent: mt, matrix: true }),
  ];
  return mt;
}

function chloroplast(c, p, k, at, parent) {
  const { L, W } = plastSize(c), dead = () => c.dead;
  const lp = (lx, ly) => () => local(c, p, lx, ly);
  const cp = part(`Chloroplast ${k + 1}`, at(p.fx, p.fy, L / 2), {
    title: 'Chloroplast', kv: [['Length', um(L)]], desc: 'Captures sunlight; releases oxygen as a by-product.',
  }, { parent, plastOf: { c, p }, outline: () => { const q = local(c, p, 0, 0); return { type: 'ellipse', x: q.x, y: q.y, rx: L / 2, ry: W / 2, ang: p.ang }; } });
  cp.kids = () => [
    ...grana(L, W).map((g, gi) => {
      const gp = part(`Granum ${gi + 1}`, anchored(lp(g.x, g.y), Math.max(g.w, g.h) / 2 + 10 * NM, dead), {
        title: 'Granum (stack of thylakoids)', kv: [['Discs', String(g.discs.length)], ['Disc diameter', '≈ 0.5 µm']],
        desc: 'A stack of membrane discs, like coins. Light is captured here and used to split water, releasing oxygen.',
      }, { parent: cp });
      gp.kids = () => g.discs.map((dsc, di) => {
        // (each disc is clickable along its whole width)
        const td = part(`Thylakoid disc ${di + 1}`, anchored(lp(dsc.x + dsc.w / 2, dsc.y + dsc.h / 2), dsc.h / 2 + 4 * NM, dead), {
          title: 'Thylakoid disc', kv: [['Thickness', '≈ 15 nm']], desc: 'A flattened sac whose membrane is crowded with chlorophyll-protein complexes.',
        }, { parent: gp, shape: { w: dsc.h + 24 * NM, lines: () => [[local(c, p, dsc.x, dsc.y + dsc.h / 2), local(c, p, dsc.x + dsc.w, dsc.y + dsc.h / 2)]] } });
        td.kids = () => [
          part('Photosystem II', anchored(lp(dsc.x + dsc.w * 0.3, dsc.y - 5 * NM), 10 * NM, dead), { title: 'Photosystem II', kv: [['Size', '≈ 20 nm'], ['Job', 'splits water, releasing O₂']], desc: 'The complex that started the oxygen revolution: light-powered water splitting.' }, { parent: td }),
          part('Photosystem I', anchored(lp(dsc.x + dsc.w * 0.6, dsc.y - 5 * NM), 9 * NM, dead), { title: 'Photosystem I', kv: [['Size', '≈ 18 nm']], desc: 'A second light trap that boosts electrons to make NADPH for building sugar.' }, { parent: td }),
          part('ATP synthase', anchored(lp(dsc.x + dsc.w * 0.85, dsc.y - 5 * NM), 5 * NM, dead), { title: 'ATP synthase', kv: [['Size', '≈ 10 nm head']], desc: 'The same rotary motor as in mitochondria, here driven by protons pumped into the disc.' }, { parent: td }),
        ];
        return td;
      });
      return gp;
    }),
    part('Chloroplast DNA', anchored(lp(L * 0.3, W * 0.22), W * 0.08, dead), { title: 'cpDNA', kv: [['Form', 'circular']], desc: 'Inherited from the engulfed cyanobacterium.' }, { parent: cp }),
    part('Stroma', anchored(lp(0, W * 0.3), W * 0.2, dead), { title: 'Stroma', kv: [], desc: 'Fluid where the Calvin cycle (and RuBisCO) fixes CO₂ into sugar.' }, { parent: cp, matrix: true }),
  ];
  return cp;
}

function boundRibosome(c, a, k, parent) {
  const q = () => erRibosomes(c, a)[k] || c;
  return translatingRibosome(c, q, c.id * 4099 + 100000 + k, 'Bound ribosome', parent, true);
}

function membraneProtein(c, k, parent) {
  const pr = membraneProteinAt(c, k), sp = membraneProteinSpacing(c.r);
  const th = k * sp, pos = () => ({ x: c.x + Math.cos(th) * (c.r - 2 * NM), y: c.y + Math.sin(th) * (c.r - 2 * NM) });
  return part(pr.name, anchored(pos, (pr.size / 2) * NM + 2 * NM, () => c.dead), {
    title: pr.name, kv: [['Size', `≈ ${pr.size} nm`], ['Spans', 'the whole 4 nm bilayer']], desc: pr.desc,
  }, { parent });
}

// Points along a circle / arc (world units), used for clickable lines.
function arcPts(cx, cy, R, a0, a1, n = 40) {
  const out = [];
  for (let k = 0; k <= n; k++) { const a = a0 + ((a1 - a0) * k) / n; out.push({ x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R }); }
  return out;
}
const circlePts = (cx, cy, R) => arcPts(cx, cy, R, 0, TAU, 64);

function geneGroups(c, parent) {
  const groups = [
    ['Metabolism & body genes', [Gn.SIZE, Gn.PHOTO, Gn.CHEMO, Gn.HETERO, Gn.PRED, Gn.AEROBIC, Gn.ARMOR, Gn.LIFESPAN, Gn.DIVTH, Gn.MUTR, Gn.HUE]],
    ['Behaviour genes', [Gn.MOTIL, Gn.W_LIGHT, Gn.W_CHEM, Gn.W_ORG, Gn.W_OXY, Gn.W_PREY, Gn.W_FLEE]],
    ['Multicellularity genes', [Gn.ADHES, Gn.SHARE, Gn.COLMAX]],
    ['Body-plan genes', [Gn.M_ANGLE, Gn.M_SPREAD, Gn.M_BRANCH, Gn.M_SIDE]],
  ];
  const out = groups.map(([name, idx]) => {
    const g = part(name, parent.obj, { title: name, kv: [['Genes', String(idx.length)]], desc: 'Click a gene to see its value and what it does.' }, { parent, note: String(idx.length) });
    g.kids = () => idx.map((i) => gene(c, i, g));
    return g;
  });
  const dev = part('Cell-fate network genes', parent.obj, { title: 'Gene-regulatory network for cell fate', kv: [['Genes', String(Gn.NTYPES * Gn.NDIFF_IN)]], desc: 'Inside a colony, each cell weighs these cues to decide what it becomes: generalist, feeder, motor, mouth, armor or germline.' }, { parent, note: String(Gn.NTYPES * Gn.NDIFF_IN) });
  dev.kids = () => {
    const list = [];
    for (let t = 0; t < Gn.NTYPES; t++) for (let k = 0; k < Gn.NDIFF_IN; k++) list.push(gene(c, Gn.DIFF + t * Gn.NDIFF_IN + k, dev, `${TYPE_NAMES[t]} ← ${DIFF_INPUTS[k]}`));
    return list;
  };
  out.push(dev);
  return out;
}

function gene(c, i, parent, name) {
  const v = c.g[i];
  const label = name || Gn.GENE_NAMES[i] || Gn.MORPH_NAMES[i - Gn.NG];
  return part(label, parent.obj, {
    title: `Gene: ${label}`,
    kv: [['Value', v.toFixed(3)], ['Range', i >= Gn.FIRST_SIGNED && i < Gn.NG ? '−1 … 1' : '0 … 1'], ['Locus', `#${i}`]],
    desc: name ? `A weight in the cell-fate network: how strongly “${DIFF_INPUTS[(i - Gn.DIFF) % Gn.NDIFF_IN]}” pushes the cell toward becoming a ${TYPE_NAMES[Math.floor((i - Gn.DIFF) / Gn.NDIFF_IN)]} cell.` : GENE_DESC[i],
    gene: i,
  }, { parent, note: v.toFixed(2) });
}

// ------------------------------------------------------------- organisms
export function organismOf(cell, world) {
  const id = cell.org;
  const members = () => world.life.cells.filter((c) => c.org === id && !c.dead);
  const obj = {
    get x() { const m = members(); return m.length ? m.reduce((a, c) => a + c.x, 0) / m.length : cell.x; },
    get y() { const m = members(); return m.length ? m.reduce((a, c) => a + c.y, 0) / m.length : cell.y; },
    get r() { const m = members(); if (!m.length) return cell.r; const x = this.x, y = this.y; return Math.max(...m.map((c) => Math.hypot(c.x - x, c.y - y) + c.r)); },
    get dead() { return members().length < 2; },
  };
  return sel('organism', obj, { id, members, label: `Organism #${id}` });
}

function organismParts(s, world) {
  const m = s.members();
  const byType = new Map();
  for (const c of m) { if (!byType.has(c.type)) byType.set(c.type, []); byType.get(c.type).push(c); }
  return [...byType.entries()].map(([t, cells]) => {
    const g = part(`${TYPE_NAMES[t]} cells`, anchored(() => cells[0], cells[0].r, () => cells[0].dead), {
      title: `${TYPE_NAMES[t]} cells`, kv: [['Count', String(cells.length)]], desc: FATE_DESC[t],
    }, { parent: s, group: true, note: `×${cells.length}` });
    g.kids = () => cells.map((c) => sel('cell', c, { parent: s, label: `Cell #${c.id}`, note: `${c.bonds.length} junctions` }));
    return g;
  });
}

const FATE_DESC = [
  'Undifferentiated cells that do a bit of everything.',
  'Feeding specialists: double the cell’s own metabolism (photosynthesis, chemosynthesis or absorption) and give up motility.',
  'Motor cells with strong flagella that move the whole organism.',
  'Mouth cells specialised for absorbing food and engulfing prey.',
  'Armor cells with thick walls that protect the organism.',
  'Germline cells: they draw energy from the body and bud off to found the next generation.',
];

function organismInfo(s, world) {
  const m = s.members(), types = [0, 0, 0, 0, 0, 0];
  for (const c of m) types[c.type]++;
  const o = world.life.organisms.find((x) => x.id === s.id);
  return {
    title: `Organism #${s.id}`,
    kv: [['Cells', String(m.length)], ['Span', um(s.obj.r * 2)], ['Classification', o ? o.kind : 'colony'], ['Cell types', types.map((n, t) => (n ? `${TYPE_NAMES[t]} ${n}` : '')).filter(Boolean).join(', ')]],
    desc: 'A body of bonded cells that descend from one founder. Selection now acts on the whole organism, not just on single cells.',
  };
}

// ------------------------------------------------------------------ viruses
function virusParts(s) {
  const v = s.obj, dead = () => !!v.dead;
  const at = (lx, ly, r) => anchored(() => inFrame({ x: v.x, y: v.y, ang: v.ang }, lx, ly), r * NM, dead);
  return [
    part('Capsid (protein shell)', at(0, 0, 50), { title: 'Icosahedral capsid', kv: [['Diameter', '≈ 100 nm'], ['Made of', 'hundreds of copies of a few proteins']], desc: 'A geometric protein shell that protects the viral genome outside a host.' }, { parent: s }),
    part('Viral genome', at(0, 0, 30), { title: 'Packed viral genome', kv: [['Size', 'tens of kilobases'], ...(v.cargo ? [['Carrying host gene', Gn.GENE_NAMES[v.cargo.i] || `#${v.cargo.i}`]] : [])], desc: 'Just enough genes to make more viruses. Sometimes it carries a stolen host gene into the next host.' }, { parent: s }),
    part('Tail', at(0, 100, 50), { title: 'Contractile tail', kv: [['Length', '≈ 110 nm']], desc: 'Contracts like a syringe to inject the genome through the host’s envelope.' }, { parent: s }),
    part('Tail fibres', at(0, 190, 35), { title: 'Tail fibres (receptor-binding proteins)', kv: [['Binding key', `${v.k1.toFixed(2)} / ${v.k2.toFixed(2)}`]], desc: 'They grab the host only if its surface receptors have the matching shape. Hosts escape by mutating their receptors; viruses follow.' }, { parent: s }),
  ];
}

function virusInfo(s) {
  const v = s.obj;
  return {
    title: `${v.euk ? 'Eukaryotic virus' : 'Virus (phage)'} · lineage #${v.lineage}`,
    kv: [['Infects', v.euk ? 'eukaryotes only' : 'bacteria only'], ['Size', v.euk ? '≈ 100 nm capsid' : '≈ 100 nm head, 200 nm tail'], ['Binding key', `${v.k1.toFixed(2)} / ${v.k2.toFixed(2)}`], ['Age', `${v.age} ticks`], ['Carries host gene', v.cargo ? (Gn.GENE_NAMES[v.cargo.i] || `#${v.cargo.i}`) : 'no']],
    desc: 'Not alive on its own: a packaged genome that drifts until it meets a cell with matching receptors, takes it over, and bursts it to release ~10–40 copies.' + (v.euk ? ' Eukaryotic viruses are tailless capsids; they arise when a virus lineage makes a rare jump from bacteria to eukaryotes.' : ' Bacteriophages cannot infect eukaryotes: their surfaces and machinery are too different.'),
  };
}

// The wall node under the cursor: a glycan strand (layer), a cross-link, or a single sugar unit.
function wallNodeAt(ws, p, tol, pxnm) {
  if (pxnm < 1.5) return null; // too far away to make out the mesh
  const { c, wall } = ws.wallOf, n = wallLayers(wall), th = Math.atan2(p.y - c.y, p.x - c.x), d = Math.hypot(p.x - c.x, p.y - c.y);
  let li = 0, bd = Infinity;
  for (let i = 0; i < n; i++) { const e = Math.abs(d - wallLayerR(c, wall, i)); if (e < bd) { bd = e; li = i; } }
  const R = wallLayerR(c, wall, li), pos = (r, a) => () => ({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
  // On a cross-link? (they sit between layers li and li+1 at staggered angles)
  for (const i of [li - 1, li]) {
    if (i < 0 || i + 1 >= n) continue;
    const r1 = wallLayerR(c, wall, i), r2 = wallLayerR(c, wall, i + 1);
    if (d < r1 - tol || d > r2 + tol) continue;
    const da = WALL_LINK / r1, off = (i % 2) * 0.5, k = Math.round(th / da - off), a = (k + off) * da;
    if (Math.abs(th - a) * d < 0.6 * NM + tol && d > r1 + 0.5 * NM && d < r2 - 0.5 * NM) {
      return part('Peptide cross-link', anchored(pos((r1 + r2) / 2, a), 1.5 * NM, () => c.dead), {
        title: 'Peptide cross-link', kv: [['Length', '≈ 4 nm'], ['Joins', `layers ${i + 1} and ${i + 2}`]],
        desc: 'A short chain of amino acids (some of them unusual D-forms) bridging two glycan strands. Penicillin works by blocking the enzyme that makes these links.',
      }, { parent: ws });
    }
  }
  if (bd > 1 * NM + tol) return null;
  const strand = part(`Glycan strand (layer ${li + 1} of ${n})`, anchored(pos(R, th), 0.5 * NM, () => c.dead), {
    title: 'Glycan strand', kv: [['Layer', `${li + 1} of ${n}`], ['Made of', 'alternating NAG and NAM sugars']],
    desc: 'A long sugar chain wrapped around the cell. Layers of them, cross-linked by peptides, make the wall.',
  }, { parent: ws, shape: { w: 1.6 * NM, lines: () => [arcPts(c.x, c.y, R, th - 0.004, th + 0.004, 6)] } });
  const ua = Math.round(th / (WALL_UNIT / R)) * (WALL_UNIT / R);
  strand.kids = () => {
    const unit = part('NAG–NAM disaccharide', anchored(pos(R, ua), 0.5 * NM, () => c.dead), {
      title: 'NAG–NAM unit', kv: [['Size', '≈ 1 nm'], ['Sugars', 'N-acetylglucosamine + N-acetylmuramic acid']],
      desc: 'The repeating brick of a glycan strand. A short peptide stem hangs off each NAM, ready to be cross-linked.',
    }, { parent: strand });
    unit.kids = () => [
      part('N-acetylglucosamine (NAG)', anchored(pos(R, ua - 0.25 * WALL_UNIT / R), 0.25 * NM, () => c.dead), { title: 'N-acetylglucosamine', kv: [['Formula', 'C₈H₁₅NO₆']], desc: 'An amino sugar, also the building block of chitin.' }, { parent: unit }),
      part('N-acetylmuramic acid (NAM)', anchored(pos(R, ua + 0.25 * WALL_UNIT / R), 0.25 * NM, () => c.dead), { title: 'N-acetylmuramic acid', kv: [['Formula', 'C₁₁H₁₉NO₈']], desc: 'Found only in bacterial walls; carries the peptide stem.' }, { parent: unit }),
      part('Peptide stem', anchored(pos(R + 0.6 * NM, ua), 0.3 * NM, () => c.dead), { title: 'Peptide stem', kv: [['Length', '4–5 amino acids']], desc: 'The handle that gets cross-linked to a neighbouring strand.' }, { parent: unit }),
    ];
    return [unit];
  };
  return strand;
}

function nuclearPore(c, k, parent) {
  const pos = () => nuclearPores(c)[k] || c;
  const np = part(`Nuclear pore ${k + 1}`, anchored(pos, (DIM.nuclearPore / 2) * NM, () => c.dead), {
    title: 'Nuclear pore complex', kv: [['Diameter', '≈ 100 nm'], ['Made of', '~30 kinds of nucleoporin, ~1000 proteins'], ['Symmetry', 'eight-fold']],
    desc: 'A gate through both envelope membranes. Messenger RNA leaves through it; proteins with the right address tag are let in.',
  }, { parent });
  np.kids = () => [
    part('Nucleoporins', anchored(pos, 15 * NM, () => c.dead), { title: 'Nucleoporins', kv: [], desc: 'Scaffold proteins arranged in eight spokes around the channel.' }, { parent: np }),
    part('Central channel', anchored(pos, 20 * NM, () => c.dead), { title: 'Central channel', kv: [['Width', '≈ 40 nm']], desc: 'Filled with a mesh of floppy protein strands that block anything not escorted by a transport receptor.' }, { parent: np }),
  ];
  return np;
}

function nucleosomeAt(gs, p, tol, renderer) {
  const c = gs.genomeOf, a = renderer.anatomy(c), pts = a.chrom, R = c.r * 0.34;
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const x1 = c.x + pts[k] * R, y1 = c.y + pts[k + 1] * R, x2 = c.x + pts[k + 2] * R, y2 = c.y + pts[k + 3] * R;
    const Lnm = Math.hypot(x2 - x1, y2 - y1) / NM, n = Math.max(1, Math.floor(Lnm / 25));
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n, q = { x: x1 + (x2 - x1) * f, y: y1 + (y2 - y1) * f };
      if (Math.hypot(q.x - p.x, q.y - p.y) > 5.5 * NM + tol) continue;
      const nu = part('Nucleosome', anchored(() => q, 5.5 * NM, () => c.dead), {
        title: 'Nucleosome', kv: [['Diameter', '≈ 11 nm'], ['DNA wrapped', '147 base pairs, 1.65 turns'], ['Core', '8 histone proteins']],
        desc: 'DNA spooled around a histone core: how two metres of DNA fit into a nucleus a few micrometres wide. Chemical tags on the histones help switch genes on and off.',
      }, { parent: gs });
      nu.kids = () => ['H2A', 'H2B', 'H3', 'H4'].map((h) => part(`Histone ${h} (×2)`, anchored(() => q, 2.5 * NM, () => c.dead), {
        title: `Histone ${h}`, kv: [['Copies per nucleosome', '2']], desc: 'A small, positively charged protein that grips the negatively charged DNA backbone.',
      }, { parent: nu }));
      return nu;
    }
  }
  return null;
}

// A base pair in a drawn chromosome near point p (only when the double helix is visible).
function basePairAt(gs, p, tol, renderer) {
  const c = gs.genomeOf, a = renderer.anatomy(c);
  const euk = c.mito, pts = euk ? a.chrom : a.dna, R = euk ? c.r * 0.34 : c.r;
  let best = null, bd = Infinity;
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const x1 = c.x + pts[k] * R, y1 = c.y + pts[k + 1] * R, x2 = c.x + pts[k + 2] * R, y2 = c.y + pts[k + 3] * R;
    const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy || 1e-12;
    const f = Math.max(0, Math.min(1, ((p.x - x1) * dx + (p.y - y1) * dy) / L2));
    const d = Math.hypot(x1 + dx * f - p.x, y1 + dy * f - p.y);
    if (d < bd) { bd = d; best = { k, f, L: Math.sqrt(L2) / NM, x: x1 + dx * f, y: y1 + dy * f }; }
  }
  if (!best || bd > 2 * NM + tol) return null;
  const NAMES = ['A', c.dna ? 'T' : 'U', 'G', 'C'];
  const FULL = ['Adenine', c.dna ? 'Thymine' : 'Uracil', 'Guanine', 'Cytosine'];
  const spacing = c.dna ? 0.34 : DIM.ntRise, i = Math.round((best.f * best.L) / spacing);
  const b = dnaBase(c.id, best.k, i);
  const pos = { x: best.x, y: best.y };
  const dead = () => c.dead;
  if (!c.dna) {
    return part(`RNA base ${NAMES[b]}`, anchored(() => pos, 0.6 * NM, dead), { title: `${FULL[b]} in the RNA genome`, kv: [['Rise', '0.59 nm per base']], desc: 'A single strand: there is no partner to check copying errors against.' }, { parent: gs });
  }
  const pair = b === 0 ? 1 : b === 1 ? 0 : b === 2 ? 3 : 2;
  const bp = part(`Base pair ${NAMES[b]}–${NAMES[pair]}`, anchored(() => pos, 1 * NM, dead), {
    title: `DNA base pair ${NAMES[b]}–${NAMES[pair]}`,
    kv: [['Hydrogen bonds', b >= 2 ? '3 (G–C)' : '2 (A–T)'], ['Rise', '0.34 nm per base pair'], ['Helix', '10.5 bp per turn, 2 nm wide']],
    desc: 'One rung of the double helix. Each strand is a template for the other, so errors can be detected and repaired.',
  }, { parent: gs });
  bp.kids = () => [
    part(`${FULL[b]} (strand 1)`, anchored(() => pos, 0.5 * NM, dead), { title: FULL[b], kv: [['Type', b === 0 || b === 2 ? 'purine' : 'pyrimidine']], desc: 'Read by the cell three bases at a time.' }, { parent: bp }),
    part(`${FULL[pair]} (strand 2)`, anchored(() => pos, 0.5 * NM, dead), { title: FULL[pair], kv: [['Type', pair === 0 || pair === 2 ? 'purine' : 'pyrimidine']], desc: 'The complementary partner on the opposite strand.' }, { parent: bp }),
    part('Deoxyribose–phosphate backbone', anchored(() => pos, 0.9 * NM, dead), { title: 'Sugar–phosphate backbone', kv: [['Sugar', 'deoxyribose (no 2′-OH)']], desc: 'Missing one oxygen compared with RNA’s ribose, which makes DNA far more chemically stable.' }, { parent: bp }),
  ];
  return bp;
}

// ------------------------------------------------------------- public API
export function children(s, world, renderer) {
  if (s.gone) return [];
  switch (s.kind) {
    case 'organism': return organismParts(s, world);
    case 'cell': return cellParts(s, world, renderer);
    case 'vesicle': return vesicleParts(s, renderer);
    case 'polymer': return polymerParts(s, renderer);
    case 'molecule': return moleculeParts(s);
    case 'virus': return virusParts(s);
    case 'part': return s.kids ? s.kids() : [];
  }
  return [];
}

export function info(s, world) {
  if (s.kind === 'part') return s.info;
  if (s.kind === 'molecule') return moleculeInfo(s);
  if (s.kind === 'organism') return organismInfo(s, world);
  if (s.kind === 'virus') return virusInfo(s);
  return null;
}

// Chain of enclosing selections, outermost first.
export function ancestors(s, world) {
  const chain = [];
  let p = s.parent;
  let last = s;
  while (p) { chain.unshift(p); last = p; p = p.parent; }
  if (last.kind === 'cell' && last.obj.orgSize > 1 && !last.obj.dead) chain.unshift(organismOf(last.obj, world));
  return chain;
}

export function crumbLabel(s) {
  if (s.label) return s.label;
  if (s.kind === 'cell') return `Cell #${s.obj.id}`;
  if (s.kind === 'vesicle') return s.obj.polys.some((p) => p.act > 0) ? 'Protocell' : 'Vesicle';
  if (s.kind === 'polymer') return `RNA ${s.obj.seq.length} nt`;
  if (s.kind === 'virus') return `Virus #${s.obj.id}`;
  return s.kind;
}

// ---------------------------------------------------------- nested picking
// Selection works like nested groups: the first click selects the outermost thing; clicking again
// inside the current selection goes one level deeper (list-only groups are skipped); clicking inside
// an ancestor selects the sibling under the cursor; clicking outside starts over.

const flatten = (kids) => kids.flatMap((k) => (k.group && k.kids ? k.kids() : [k]));
const dist = (s, p) => Math.hypot(s.obj.x - p.x, s.obj.y - p.y);
const radius = (s) => s.obj.r ?? s.obj._rad ?? 0;

function segDist(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1e-18;
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / L2));
  return Math.hypot(a.x + dx * t - px, a.y + dy * t - py);
}
// Distance from p to a part's edge: lines and arcs for thin structures, otherwise a circle.
function edgeDist(c, p) {
  if (c.shape) {
    let d = Infinity;
    for (const pts of c.shape.lines()) for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(p.x, p.y, pts[i - 1], pts[i]));
    return d - c.shape.w / 2;
  }
  return dist(c, p) - radius(c);
}
const sizeOf = (c) => (c.shape ? c.shape.w : radius(c));

function smallestHit(cands, p, tol, maxR = Infinity) {
  let best = null, br = Infinity;
  for (const c of cands) {
    const r = sizeOf(c);
    if (r >= maxR || edgeDist(c, p) > tol) continue;
    if (r < br) { br = r; best = c; }
  }
  return best;
}

export function contains(s, p, tol) {
  return !!s && !s.gone && !s.obj.dead && dist(s, p) <= radius(s) + tol;
}

// The outermost object under the cursor.
export function topLevelAt(world, p, tol, showChem) {
  const cands = [];
  for (const c of world.life.cells) {
    if (Math.hypot(c.x - p.x, c.y - p.y) > c.r + tol) continue;
    cands.push(c.orgSize > 1 ? organismOf(c, world) : sel('cell', c));
  }
  if (world.viruses) {
    for (const v of world.viruses.list) {
      if (Math.hypot(v.x - p.x, v.y - p.y) <= DIM.virus * NM * 2 + tol) cands.push(sel('virus', Object.assign(v, { r: DIM.virus * NM * 2 }), { world }));
    }
  }
  if (showChem) {
    const soup = world.soup;
    for (const v of soup.vesicles) if (Math.hypot(v.x - p.x, v.y - p.y) <= v.r + tol) cands.push(sel('vesicle', v));
    for (const q of soup.polymers) {
      q._rad = (q.seq.length * DIM.ntRise * NM) / 2;
      if (Math.hypot(q.x - p.x, q.y - p.y) <= q._rad + tol) cands.push(sel('polymer', q));
    }
    for (let i = 0; i < soup.n; i++) {
      const dx = soup.mx[i] - p.x, dy = soup.my[i] - p.y;
      if (Math.abs(dx) > tol + NM || Math.abs(dy) > tol + NM) continue;
      const st = { mid: soup.mid[i], x: soup.mx[i], y: soup.my[i], ang: (soup.mid[i] * 2.399) % TAU, gone: false };
      cands.push(molecule(soup.mt[i], () => st, () => st.gone, null, { st }));
    }
  }
  let best = null;
  for (const c of cands) if (!best || radius(c) < radius(best)) best = c;
  if (best) best.follow = false;
  return best;
}

// The part of s directly under the cursor (one level down), or null.
export function childAt(s, p, tol, world, renderer) {
  const pxnm = renderer.ppu / NM_PER_UNIT;
  const out = (c) => { if (c) c.follow = false; return c; };
  if (s.kind === 'organism') {
    return out(smallestHit(s.members().map((c) => sel('cell', c, { parent: s })), p, tol));
  }
  if (s.kind === 'cell') {
    const c = s.obj;
    if (c.r * renderer.ppu < 14) return null; // too small on screen to show its parts
    const kids = cellParts(s, world, renderer), all = flatten(kids);
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (Math.abs(d - c.r) < DIM.bilayer * NM + tol) return out(kids[0]);
    const named = (re) => all.filter((k) => re.test(k.label));
    if (d > c.r) {
      // Outside the membrane: the wall band first, then flagellum, pili, junctions.
      const wallPart = kids.find((k) => k.wallOf);
      if (wallPart && d - c.r <= wallPart.wallOf.wall + 2 * NM + tol) return out(wallPart);
      return out(smallestHit([...named(/^Flagellum|^Pilus|^Junction/)], p, tol));
    }
    // Inside: compact organelles first (they are drawn on top), then thin networks, then ribosomes.
    const isLine = (k) => !!k.shape;
    const skip = /^(Plasma membrane|Cytoplasm|Cell wall|Flagellum|Pilus|Junction|Ribosome |Chromosome|RNA genome)/;
    const solid = all.filter((k) => !skip.test(k.label) && !isLine(k) && k.kind === 'part');
    const hit = smallestHit(solid, p, tol);
    if (hit) return out(hit);
    const lineHit = smallestHit(all.filter((k) => isLine(k) && !/^Flagellum|^Pilus/.test(k.label)), p, tol);
    if (lineHit) return out(lineHit);
    const a = c._anat, ribs = kids.find((k) => k.label === 'Ribosomes');
    if (DIM.ribosome * pxnm >= 3) {
      const at = (fx, fy, r) => anchored(() => ({ x: c.x + fx * c.r, y: c.y + fy * c.r }), r, () => c.dead);
      for (let k = 0; k < a.ribo.length / 2; k++) {
        if (Math.hypot(c.x + a.ribo[k * 2] * c.r - p.x, c.y + a.ribo[k * 2 + 1] * c.r - p.y) < DIM.ribosome * NM + tol) return out(ribosome(c, k, at, ribs));
      }
    }
    const genome = all.filter((k) => /^Chromosome|^RNA genome/.test(k.label));
    return out(smallestHit(genome, p, tol) || kids.find((k) => k.label === 'Cytoplasm'));
  }
  if (s.kind === 'vesicle') {
    const v = s.obj, kids = vesicleParts(s, renderer);
    const d = Math.hypot(p.x - v.x, p.y - v.y);
    if (Math.abs(d - v.r) < DIM.bilayer * NM + tol) return out(kids[0]);
    const strands = kids.filter((k) => k.kind === 'polymer' && k.obj._fx !== undefined);
    for (const k of strands) k.obj._rad = (k.obj.seq.length * DIM.ntRise * NM) / 2;
    const hit = smallestHit(strands, p, tol);
    if (hit) return out(hit);
    if (pxnm >= 2.5) {
      const inner = v.r - DIM.bilayer * NM;
      for (let t = 0; t < 4; t++) {
        const group = kids.find((k) => k.label === `Free ${BASES[t]} nucleotides`);
        for (let k = 0; k < Math.min(v.pool[t], 40); k++) {
          const seed = (v.id * 7919 + t * 131 + k * 17) >>> 0;
          const frame = () => { const r = renderer.rngFor(seed), a = r.next() * TAU, rr = Math.sqrt(r.next()) * 0.85; return { x: v.x + Math.cos(a) * rr * inner, y: v.y + Math.sin(a) * rr * inner, ang: r.next() * TAU }; };
          const m = molecule(t, frame, () => v.dead, group || s);
          if (dist(m, p) < m.obj.r + tol) return out(m);
        }
      }
    }
    return null;
  }
  if (s.kind === 'polymer') {
    if (pxnm < 4) return null;
    return out(smallestHit(polymerParts(s, renderer).filter((k) => k.kind === 'molecule'), p, tol));
  }
  if (s.kind === 'molecule' || s.kind === 'virus') {
    if (pxnm < 10) return null;
    return out(smallestHit(children(s, world, renderer), p, tol));
  }
  if (s.kind === 'part') {
    if (s.ring) {
      // A membrane: drill into the protein or lipid under the cursor once they are resolvable.
      if (DIM.lipidSpacing * pxnm < 2.5) return null;
      const o = s.ring.c, th = Math.atan2(p.y - o.y, p.x - o.x);
      if (s.ring.phospho) {
        const sp = membraneProteinSpacing(o.r), k = Math.round(th / sp), kk = ((k % 100000) + 100000) % 100000;
        const pr = membraneProteinAt(o, kk);
        if (pr && Math.abs(th - k * sp) * o.r < (pr.size / 2) * NM + tol) return out(membraneProtein(o, k, s));
      }
      return out(membraneLipid(() => o.x, () => o.y, () => o.r, th, () => o.dead, s, s.ring.label, s.ring.phospho));
    }
    if (s.nucleusOf) {
      const c = s.nucleusOf, nr = c.r * 0.34, kids = s.kids();
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (Math.abs(d - nr) < (DIM.nuclearGap + 60) * NM + tol) {
        // A single nuclear pore, if one is under the cursor.
        const pr = nuclearPores(c).find((q) => Math.hypot(q.x - p.x, q.y - p.y) < (DIM.nuclearPore / 2) * NM + tol);
        if (pr && DIM.nuclearPore * pxnm >= 2) return out(nuclearPore(c, pr.k, kids[0]));
        return out(kids[0]);
      }
      return out(smallestHit([kids[1]], p, tol) || kids[2]);
    }
    if (s.genomeOf) {
      const g = s.genomeOf;
      if (g.mito && pxnm >= 0.4) { const nu = nucleosomeAt(s, p, tol, renderer); if (nu) return out(nu); }
      const pxOK = g.mito ? pxnm >= 2 : pxnm >= 2;
      return pxOK ? out(basePairAt(s, p, tol, renderer)) : null;
    }
    if (s.mitoOf || s.plastOf) {
      // Inside a mitochondrion or chloroplast: membranes, cristae/grana, DNA, else matrix/stroma.
      const { c, m, p: pl } = { ...s.mitoOf, ...s.plastOf };
      const o = m || pl, { L, W } = m ? mitoSize(c, o) : plastSize(c), q = toLocal(c, o, p.x, p.y);
      const e = Math.hypot(q.lx / (L / 2), q.ly / (W / 2));
      const kids = s.kids();
      if (e > 0.92) return out(m ? kids.find((k) => k.outer) : null);
      const inner = smallestHit(kids.filter((k) => !k.outer && !k.matrix), p, tol);
      return out(inner || kids.find((k) => k.matrix));
    }
    if (s.erOf) {
      const c = s.erOf, a = c._anat;
      if (DIM.ribosome * pxnm >= 3) {
        const list = erRibosomes(c, a);
        for (let k = 0; k < list.length; k++) if (Math.hypot(list[k].x - p.x, list[k].y - p.y) < DIM.ribosome * NM + tol) return out(boundRibosome(c, a, k, s));
      }
      return out(s.kids()[0]);
    }
    if (s.rnaOf || s.peptideOf) {
      if (pxnm < 4) return null;
      const { pts, W, c } = s.rnaOf || s.peptideOf;
      let best = -1, bd = Infinity;
      for (let i = 0; i < pts.length; i++) { const q = W(pts[i].x, pts[i].y), d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; best = i; } }
      if (best < 0 || bd > 1.2 * NM + tol) return null;
      const i = best, q = () => W(pts[i].x, pts[i].y);
      const dir = () => { const a = W(pts[Math.max(0, i - 1)].x, pts[Math.max(0, i - 1)].y), b = W(pts[Math.min(pts.length - 1, i + 1)].x, pts[Math.min(pts.length - 1, i + 1)].y); return Math.atan2(b.y - a.y, b.x - a.x); };
      if (s.rnaOf) {
        const frame = () => { const w = q(); return { x: w.x, y: w.y, ang: dir() }; };
        return out(molecule(pts[i].b, frame, () => c.dead, s, { label: `${i + 1}. ${BASES[pts[i].b]} · ${NT_INFO[pts[i].b].base}` }));
      }
      const aa = pts[i].aa;
      const res = part(`${i + 1}. ${AMINO_NAMES[aa]}`, anchored(q, 0.3 * NM, () => c.dead), {
        title: `${AMINO_NAMES[aa]} (${aa}), residue ${i + 1}`, kv: [['Size', '≈ 0.4 nm along the chain']],
        desc: 'One of the 20 amino acids life uses. Its side chain decides whether this part of the protein is oily, charged or reactive, and so how the protein folds.',
      }, { parent: s });
      res.kids = () => [
        part('Peptide backbone (N–Cα–C)', anchored(q, 0.2 * NM, () => c.dead), { title: 'Peptide backbone', kv: [], desc: 'The repeating nitrogen–carbon–carbon chain shared by every amino acid, linked by peptide bonds.' }, { parent: res }),
        part(`Side chain of ${AMINO_NAMES[aa]}`, anchored(q, 0.25 * NM, () => c.dead), { title: 'Side chain', kv: [['Amino acid', AMINO_NAMES[aa]]], desc: 'The part that differs between amino acids and gives each its chemistry.' }, { parent: res }),
      ];
      return out(res);
    }
    if (s.mtOf) {
      if (8 * NM * renderer.ppu < 3) return null;
      const { c, k } = s.mtOf, m = microtubules(c, c._anat, renderer.time ?? 0)[k];
      const L = Math.hypot(m.x2 - m.x1, m.y2 - m.y1), t = Math.max(0, Math.min(1, ((p.x - m.x1) * (m.x2 - m.x1) + (p.y - m.y1) * (m.y2 - m.y1)) / (L * L)));
      const pos = { x: m.x1 + (m.x2 - m.x1) * t, y: m.y1 + (m.y2 - m.y1) * t };
      return out(part('α/β-tubulin dimer', anchored(() => pos, 4 * NM, () => c.dead), {
        title: 'α/β-tubulin dimer', kv: [['Length', '8 nm'], ['Binds', 'GTP']], desc: 'The brick of every microtubule. Dimers stack head-to-tail into protofilaments; 13 of those make the tube.',
      }, { parent: s }));
    }
    if (s.wallOf) return out(wallNodeAt(s, p, tol, pxnm));
    // Compact things (drawn on top) before thin strands running underneath them.
    const kidsList = s.kids ? flatten(s.kids()) : [], lim = sizeOf(s) || Infinity;
    return out(smallestHit(kidsList.filter((k) => !k.shape), p, tol, lim) || smallestHit(kidsList.filter((k) => k.shape), p, tol, lim));
  }
  return null;
}
