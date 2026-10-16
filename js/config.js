// All tunable constants of the simulation in one place.
export const CFG = {
  // World units are 0.5 µm: the habitat is 1.6 × 0.9 mm.
  W: 3200,
  H: 1800,

  // ---- Environment -------------------------------------------------------
  FIELD_CELL: 20,
  VENTS: 7,
  VENT_CHEM: 4.0,          // reduced chemicals (H2, H2S) emitted per vent per tick
  VENT_GLOW: 0.3,         // faint thermal light near vents (anoxygenic photosynthesis stepping stone)
  CHEM_DIFF: 0.25, CHEM_DECAY: 0.0015, CHEM_HALF: 4,
  ORG_DIFF: 0.15, ORG_DECAY: 0.0006,
  OXY_DIFF: 0.3, OXY_DECAY: 0.0005, OXY_REACT: 0.01, // (OXY_DECAY was 0.0015: a ~460-tick half-life, too short for oxygen to build up)
  NUT_INIT: 0.3,           // conserved limiting nutrient (think phosphate) per grid cell
  NUT_DIFF: 0.3, NUT_BURIAL: 0.0004,
  // Oxygenated water rusts dissolved iron into oxides that bind phosphate and carry it to the sea floor: nutrient
  // is buried up to NUT_RUST times faster where the water is fully oxygenated (1 = no effect).
  NUT_RUST: 2,             // (8x kept worlds under the cap but starved eukaryotes; 2x had the most eukaryotes in rust1)
  VENT_NUT: 0.1,          // minerals from vents
  WEATHERING: 0.16,        // minerals washed in at the surface (rivers, dust)
  // Atmosphere: a well-mixed air reservoir swapping oxygen with the surface water, which buffers the ocean
  // through day and night (most of Earth's free oxygen is in the air). ATM_SIZE is its capacity in rows of
  // water (0 = no atmosphere); ATM_EXCHANGE the share of the difference swapped per tick at the surface.
  ATM_SIZE: 8, ATM_EXCHANGE: 0.05, ATM_DECAY: 0.00005,
  O2_REF: 1.5,               // oxygen level considered "fully oxygenated"
  DAY_LENGTH: 1000,        // ticks per day (was 4,000: nights outlasted oxygen, so it crashed every night)
  DAY_MEAN: 0.65, DAY_SWING: 0.35, // sunlight over a day: DAY_MEAN ± DAY_SWING (night 30%, noon 100%)
  LIGHT_DEPTH: 1.6,        // light attenuation with depth
  CURRENT: 0.12,
  CELL_DRIFT: 1.2,         // how strongly currents carry cells (microbes are mostly passive)
  PLUME_REACH: 0.35,       // vent plumes rise this fraction of the ocean depth

  // ---- Prebiotic chemistry -----------------------------------------------
  HASH_CELL: 16,
  MAX_MONOMERS: 3500,
  VENT_MONOMER_RATE: 1.3,  // per vent per tick
  SURFACE_MONOMER_RATE: 0.35, // Miller–Urey style synthesis by lightning/UV at the surface
  LIPID_FRACTION: 0.3,
  MONOMER_DECAY: 0.0004,
  MONO_DIFFUSION: 1.1,
  MAX_POLYMERS: 800,
  MAX_POLY_LEN: 40,
  DIMER_SAMPLES: 250,
  DIMER_RATE: 0.25,
  POLY_RATE: 0.2,
  HYDROLYSIS: 0.0004,
  UV_DAMAGE: 1.5,
  REP_RATE: 0.8,
  MIN_ACTIVE_LEN: 6,
  MAX_VESICLES: 260,
  VES_NUCLEATE: 8,
  VES_SPLIT: 34,
  VES_POOL: 60,
  VES_NT_REACH: 1.5,        // how far beyond its membrane a protocell draws in nucleotides (once life is abundant)
  VES_NT_REACH_EARLY: 4,    // ...before life (null = same as VES_NT_REACH): fades toward it as cells multiply
  VES_NT_FADE: 50,          // living cells at which the early extra reach has halved
  VES_MAX_POLY: 14,
  VES_LIPID_LOSS: 0.012,
  VES_BURST: 0.00025,
  CELL_GEN: 2,             // protocell generations needed before it counts as a living cell
  CELL_ACT: 0.2,           // minimum ribozyme activity of the protocell's best replicator
  CELL_COPIES: 1,          // completed self-copies in the protocell lineage (heredity)
  MAX_ORIGINS_POP: 200,    // stop new abiogenesis once life is this abundant

  // ---- Life ---------------------------------------------------------------
  THREADS: 0,              // threads for the per-tick work (0 = auto: all cores in a browser page, 1 in Node/workers)
  MAX_CELLS: 5000,         // population cap, for CPU (12,000 made late-game ticks ~45 ms in the browser; was 6,000)
  // When crowded (above 85% of the cap) a safety valve culls cells. Selective: the weakest go first (drained energy,
  // near old age, or infected), with the overall cull rate unchanged. false = at random.
  CULL_SELECTIVE: true,
  LIFE_HASH: 24,
  MAX_R: 14,
  CAP_K: 20,
  BASE_COST: 0.03,
  MACHINE_COST: 0.006,
  PHOTO_K: 0.45,
  CHEMO_K: 0.08, CHEMO_EFF: 2.5,
  HET_K: 0.08, HET_EFF: 2.2,
  SPECIALIZE: 1.15,        // >1 means specialists beat generalists
  AERO_BONUS: 2.0,
  AER_COST: 0.006,
  ARM_COST: 0.015,
  ADH_COST: 0.002,
  // Multicellularity (defaults adopted 2026-10-16; the old behaviour in brackets).
  ADH_BOOST: 0,            // added to every cell's chance that a daughter stays attached (its adhesion gene)
  COLMAX_INIT: 0.25,       // founders' colony-size gene starts in [0, this): limit 2 + gene x 60 cells [0.1]
  ADH_INIT: 0.4,           // founders' adhesion gene starts in [0, this): sticky lineages for selection to act on [0.06]
  SHARE_INIT: 0.5,         // founders' energy-sharing gene starts in [0, this) [0.2]
  SHIELD: true,           // predators and viruses reach only a colony's exposed cells (inner cells are shielded)
  SHIELD_BONDS: 3,         // a cell bonded to at least this many neighbours counts as inner
  FRAGMENT: false,         // a colony that reaches its size limit splits into two halves that keep their cells,
                           // bonds and jobs (like snowflake yeast and filamentous cyanobacteria)
  PARATOMY: true,          // instead of splitting at its size limit, a colony first grows a copy of itself (new cells
                           // keep their parent's job) to double size, then splits into two matching halves (cf. annelid
                           // and flatworm paratomy, Volvox daughter colonies). Takes the place of FRAGMENT.
  PARATOMY_EUK: false,     // with PARATOMY, eukaryotic colonies reproduce by paratomy too; false = bacteria only, as in
                           // nature (filamentous bacteria fragment; complex eukaryotes go through a spore or egg)
  GERM_SETASIDE: 16,       // eukaryotic colonies of at least this many cells with no germline set one cell aside as
                           // germline (the one whose fate genes lean most toward it, unless they are strongly against:
                           // score below -0.5), as germ/body splits appear with size in Volvox and its relatives. 0 = off
  GERM_MUT: 0.2,           // mutation rate of a germline cell's offspring, as a fraction of normal: germ cells divide
                           // rarely and are kept from damage (the Weismann barrier), so their offspring start cleaner
  PARA_TIME: 4000,         // ticks a colony may spend doubling before it splits anyway
  PARA_COST: 0.01,         // extra upkeep (x metabolic size) for a doubling colony beyond the oxygen-limited body size
  TRADEOFF: 0,             // convex trade-off (Michod): a generalist cell in a colony feeds, swims and hunts at
                           // 1 - TRADEOFF x min(1, (cells - 1) / 15) of full strength (doing every job at once costs
                           // more as colonies grow; cf. Volvox's flagellation constraint). 0 = off; try 0.4
  SPEC_BONUS: 0,           // division of labour pays: a specialist cell in a colony does its job (feeding, swimming,
                           // engulfing, armour) at 1 + SPEC_BONUS x min(1, (cells - 1) / 15) strength. 0 = off; try 0.5
  MORPH: true,             // body plans: growth genes (angle, branch spread, branching, alternating sides) decide where
                           // each new colony cell attaches, and angle springs hold the shape, so offspring regrow their
                           // parent's form (or a mutated one). Filaments grow by inserting cells along their length.
  MORPH_STIFF: 0.08,       // how firmly bonds hold their angles
  CULL_FAIR: true,         // the crowding cull judges a colony cell by its colony's average weakness, not its own
                           // (colony cells share energy, so one alone can look weak while its colony is healthy)
  GERM_STEM: true,         // germline stem cells: a ready germ cell stays in the body and releases its daughter as the
                           // next generation's founder (a spore or egg), instead of leaving the body itself
  COLONY_SWIM: true,       // a colony swims as one body: its cells' combined thrust over the colony's whole mass
  MOT_COST: 0.015,
  MOT_SPEED: 0.35,
  O2_YIELD: 0.1,
  TOX: 0.05,
  DIV_COST: 0.06,
  MIN_DIV_AGE: 40,
  // Kin recognition: predators spare their own species (many protists recognise kin by surface molecules) unless
  // starving below this share of their energy capacity (cannibalism is mostly a starvation response). 0 = off.
  KIN_SPARE: 0.2,
  // Viruses infect one domain: bacteriophages can't infect eukaryotes (different surfaces, entry and machinery) and
  // eukaryotic viruses can't infect bacteria. A new virus particle jumps to the other domain with VIRUS_JUMP.
  VIRUS_DOMAIN: true, VIRUS_JUMP: 0.001,
  PRED_P: 0.3,             // chance a hunt succeeds (0.25 kept predators rare; 0.4 ate too many colonies)
  ENDO_P: 0.05,
  // Endosymbiosis by partnership (closer to the leading hypothesis: an archaeal host and an aerobic bacterium
  // living in close contact merge, without the host hunting): chance per contact. 0 = only the predation route.
  SYMBIO_P: 0.0005,
  EUK_NUT: 0.5,            // nutrient a eukaryote needs to divide, relative to a bacterium of its size
  MITO_AER: 0.9,           // aerobic capacity a eukaryote gets from its mitochondria (0 = only its own gene)
  SYMBIO_O2: 0.05,         // local oxygen (fraction of O2_REF) the partnership needs
  HGT_P: 0.0004,
  SPECIATE: 0.07,
  DAMP: 0.82,
  BOND_BREAK: 0.00003,     // chance per tick a bond breaks at random [0.00015]
  RECYCLE: true,           // a colony cell that dies (not eaten) passes its nutrient (its body material) and half its
                           // energy to its bonded neighbours instead of the water (apoptosis: neighbours reuse dying cells),
                           // so they can divide to replace it and bodies persist through cell turnover
  // With RECYCLE, the share of a dying cell's nutrient and energy its body keeps (the rest goes to the water).
  // Eukaryotes engulf dying neighbours (phagocytosis) and keep most; a bacterium bursts, and its colony's
  // matrix traps only part. Keeping everything in bacterial colonies (1) locked the world's nutrient inside
  // them: free-living cells starved and no eukaryotes arose.
  RECYCLE_PROK: 0.3,
  RECYCLE_EUK: 0.9,
  JUNCTIONS: true,         // a bond's strength comes from its two cells' adhesion genes (as cadherins both keep daughters
                           // and hold tissue): stronger bonds break less at random, stretch up to twice as far and pull
                           // back harder, and when a cell dies its neighbours re-bond (heal) with that chance
  SHARE_K: 0.3,            // energy and nutrient exchange across bonds (specialists starved at 0.1)
  MAX_BONDS: 5,
  // Multicellularity as on Earth: bacteria form colonies and simple multicellular organisms (no mouth or
  // germline cells: engulfing needs a eukaryotic cytoskeleton), so complex organisms are eukaryotic; and
  // bodies above O2_SIZE_MIN cells need oxygen, up to O2_SIZE_MAX cells when fully oxygenated.
  REALISTIC_MULTI: true,
  O2_SIZE_MIN: 16, O2_SIZE_MAX: 62,
  GENERALIST_BIAS: 0.05,   // how strongly colony cells default to the undifferentiated fate [0.2]

  // Major transitions
  RIBOSOME_COST: 0.004,    // upkeep of protein-synthesis machinery, per unit translation
  RNA_GENOME_COST: 0.004,  // repairing a fragile RNA genome (×3 in full oxygen)
  DNA_COST: 0.002,         // DNA genome upkeep
  DNA_MUT: 0.35,           // mutation-rate multiplier for proofread DNA genomes
  SEX_COST: 0.08,          // energy each parent spends on a sexual birth (fraction of capacity)

  // Viruses
  VIRUS_ORIGIN_POP: 400,   // cells needed before selfish elements can escape as viruses
  VIRUS_ORIGIN_P: 0.0005,
  VIRUS_DECAY: 0.003,      // per tick (×4 at the surface: UV)
  VIRUS_D: 1.5,            // Brownian step (units/tick)
  VIRUS_INFECT: 0.35,
  VIRUS_SPEC: 0.12,        // how closely the key must match the receptor
  VIRUS_LATENCY: 60,
  VIRUS_BURST: 10,
  VIRUS_MUT: 0.04,
  MAX_VIRUSES: 4000,
  TRANSDUCE: 0.1,
  RESIST_COST: 0.008,
  DEATH_ORG: 0.6,
  NUT_PER_AREA: 2.0,       // nutrient locked into each unit of cell body
  NUT_UPTAKE: 0.06,
};

// The defaults, kept so a saved world records (and loading restores) exactly which settings differed.
export const CFG_DEFAULTS = Object.freeze(JSON.parse(JSON.stringify(CFG)));
// Settings that differ from the defaults (THREADS belongs to the machine, not the world).
export function cfgChanges() {
  const o = {};
  for (const k in CFG) if (k !== 'THREADS' && JSON.stringify(CFG[k]) !== JSON.stringify(CFG_DEFAULTS[k])) o[k] = CFG[k];
  return o;
}
// Back to the defaults, plus these changes.
export function setCfg(changes) {
  for (const k in CFG_DEFAULTS) if (k !== 'THREADS') CFG[k] = JSON.parse(JSON.stringify(CFG_DEFAULTS[k]));
  Object.assign(CFG, changes);
}
