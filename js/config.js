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
  OXY_DIFF: 0.3, OXY_DECAY: 0.0015, OXY_REACT: 0.01,
  NUT_INIT: 0.3,           // conserved limiting nutrient (think phosphate) per grid cell
  NUT_DIFF: 0.3, NUT_BURIAL: 0.0004,
  VENT_NUT: 0.1,          // minerals from vents
  WEATHERING: 0.16,         // minerals washed in at the surface (rivers, dust)
  O2_REF: 1.5,               // oxygen level considered "fully oxygenated"
  DAY_LENGTH: 4000,
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
  MAX_CELLS: 4000,
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
  MOT_COST: 0.015,
  MOT_SPEED: 0.35,
  O2_YIELD: 0.1,
  TOX: 0.05,
  DIV_COST: 0.06,
  MIN_DIV_AGE: 40,
  PRED_P: 0.25,
  ENDO_P: 0.05,
  HGT_P: 0.0004,
  SPECIATE: 0.07,
  DAMP: 0.82,
  BOND_BREAK: 0.00015,
  SHARE_K: 0.1,
  MAX_BONDS: 5,
  // Multicellularity as on Earth: bacteria form colonies and simple multicellular organisms (no mouth or
  // germline cells: engulfing needs a eukaryotic cytoskeleton), so complex organisms are eukaryotic; and
  // bodies above O2_SIZE_MIN cells need oxygen, up to O2_SIZE_MAX cells when fully oxygenated.
  REALISTIC_MULTI: false,
  O2_SIZE_MIN: 16, O2_SIZE_MAX: 62,
  GENERALIST_BIAS: 0.2,

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
  RESIST_COST: 0.008,    // how strongly colony cells default to the undifferentiated fate
  DEATH_ORG: 0.6,
  NUT_PER_AREA: 2.0,       // nutrient locked into each unit of cell body
  NUT_UPTAKE: 0.06,
};
