// All tunable constants of the simulation in one place.
export const CFG = {
  W: 1400,
  H: 900,

  // ---- Environment -------------------------------------------------------
  FIELD_CELL: 20,
  VENTS: 4,
  VENT_CHEM: 4.0,          // reduced chemicals (H2, H2S) emitted per vent per tick
  VENT_GLOW: 0.3,         // faint thermal light near vents (anoxygenic photosynthesis stepping stone)
  CHEM_DIFF: 0.25, CHEM_DECAY: 0.0015, CHEM_HALF: 4,
  ORG_DIFF: 0.15, ORG_DECAY: 0.0006,
  OXY_DIFF: 0.3, OXY_DECAY: 0.004, OXY_REACT: 0.01,
  NUT_INIT: 0.3,           // conserved limiting nutrient (think phosphate) per grid cell
  NUT_DIFF: 0.15, NUT_BURIAL: 0.0004,
  VENT_NUT: 0.08,          // minerals from vents
  WEATHERING: 0.07,         // minerals washed in at the surface (rivers, dust)
  O2_REF: 1.5,               // oxygen level considered "fully oxygenated"
  DAY_LENGTH: 4000,
  LIGHT_DEPTH: 1.6,        // light attenuation with depth
  CURRENT: 0.12,

  // ---- Prebiotic chemistry -----------------------------------------------
  HASH_CELL: 16,
  MAX_MONOMERS: 2000,
  VENT_MONOMER_RATE: 1.3,  // per vent per tick
  SURFACE_MONOMER_RATE: 0.35, // Miller–Urey style synthesis by lightning/UV at the surface
  LIPID_FRACTION: 0.3,
  MONOMER_DECAY: 0.0004,
  MONO_DIFFUSION: 1.1,
  MAX_POLYMERS: 500,
  MAX_POLY_LEN: 40,
  DIMER_SAMPLES: 250,
  DIMER_RATE: 0.25,
  POLY_RATE: 0.2,
  HYDROLYSIS: 0.0004,
  UV_DAMAGE: 1.5,
  REP_RATE: 0.8,
  MIN_ACTIVE_LEN: 6,
  MAX_VESICLES: 160,
  VES_NUCLEATE: 8,
  VES_SPLIT: 34,
  VES_POOL: 60,
  VES_MAX_POLY: 14,
  VES_LIPID_LOSS: 0.012,
  VES_BURST: 0.00025,
  CELL_GEN: 2,             // protocell generations needed before it counts as a living cell
  CELL_ACT: 0.2,           // minimum ribozyme activity of the protocell's best replicator
  CELL_COPIES: 1,          // completed self-copies in the protocell lineage (heredity)
  MAX_ORIGINS_POP: 200,    // stop new abiogenesis once life is this abundant

  // ---- Life ---------------------------------------------------------------
  MAX_CELLS: 2600,
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
  GENERALIST_BIAS: 0.2,
  VIRAL_LYSIS: 0.0004,     // per extra neighbour, per tick, in crowded patches    // how strongly colony cells default to the undifferentiated fate
  DEATH_ORG: 0.6,
  NUT_PER_AREA: 2.0,       // nutrient locked into each unit of cell body
  NUT_UPTAKE: 0.06,
};
