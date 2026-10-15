// The chapters of the story mode: every kind of transition the simulation can produce, in the order
// they usually happen. Shared by the search worker (which finds each one in the world's history) and
// the player (which shows it). speed is an index into the speed slider (0 = 0.25 ticks per frame).

export const CHAPTERS = {
  vent: {
    title: 'Molecules form at a vent',
    text: 'Hot, mineral-rich water from a hydrothermal vent drives chemistry that builds nucleotides, the letters of RNA. Watch new ones appear and start drifting through the water.',
    speed: 0,
  },
  bond: {
    title: 'Two nucleotides bond',
    text: 'On mineral surfaces near the vents, two nucleotides can link through their phosphate and sugar. Follow this one: it is about to meet a partner and become the start of a chain.',
    speed: 0,
  },
  chain: {
    title: 'A chain grows',
    text: 'Strands grow one nucleotide at a time as free ones bump into an end and stick. Watch this short strand lengthen.',
    speed: 0,
  },
  replicator: {
    title: 'RNA copies itself',
    text: 'Some RNA strands fold into ribozymes that can copy RNA. This one is copying itself: nucleotides pair with its letters one by one (A with U, G with C) until a complete copy peels away. The RNA world begins.',
    speed: 0,
  },
  vesicle: {
    title: 'A membrane bubble forms',
    text: 'Fatty acids (lipids) have water-loving heads and oily tails. When enough of them gather, they close up into a hollow bubble, a vesicle, all by themselves.',
    speed: 0,
  },
  innercopy: {
    title: 'RNA copying inside a protocell',
    text: 'Trapped inside a vesicle, a ribozyme copies itself from the nucleotides that leak in. Its copies stay inside: the bubble and its RNA now share a fate.',
    speed: 0,
  },
  protocell: {
    title: 'A protocell divides',
    text: 'As its membrane takes up more lipids the protocell swells, until it pinches in two. Each daughter carries some of the RNA: heredity, before there were cells.',
    speed: 1,
  },
  cell: {
    title: 'Life begins',
    text: 'When a protocell holds enough working ribozymes, its chemistry becomes self-sustaining. Watch it switch on and become the first living cell (abiogenesis).',
    speed: 1,
  },
  division: {
    title: 'A cell divides',
    text: 'The cell copies its genome, grows, and pinches in two by binary fission. Each daughter gets one copy, with the occasional mutation.',
    speed: 0,
  },
  protein: {
    title: 'Proteins take over',
    text: 'Ribosomes read messenger RNA three letters at a time and string amino acids into proteins, which do chemistry far better than ribozymes. Zoom into a ribosome to watch the tRNAs cycle and the chain grow.',
    speed: 0,
  },
  dna: {
    title: 'DNA becomes the genome',
    text: 'DNA is a sturdier archive than RNA. Watch polymerases read genes into messenger RNA, and replication forks copy the chromosome before the cell divides.',
    speed: 1,
  },
  predator: {
    title: 'The first predator',
    text: 'Instead of making its own food, this cell engulfs another and digests it inside a food vacuole.',
    speed: 0,
  },
  virus: {
    title: 'The first viruses',
    text: 'A stretch of genes escapes its host cell, wrapped in a protein shell. Viruses can only copy themselves inside cells.',
    speed: 0,
  },
  infection: {
    title: 'A virus infects a cell',
    text: 'Follow this virus as it drifts until its tail fibres catch on a matching receptor, then injects its genome into the cell.',
    speed: 0,
  },
  lysis: {
    title: 'An infected cell bursts',
    text: 'Inside, the virus has hijacked the cell to build hundreds of copies. Now the cell bursts open and releases them.',
    speed: 0,
  },
  hgt: {
    title: 'Microbes swap genes',
    text: 'Bacteria pass genes to each other directly (horizontal gene transfer), so a useful trick can spread sideways through a population.',
    speed: 0,
  },
  photo: {
    title: 'Photosynthesis',
    text: 'This cell captures sunlight in its thylakoid membranes and uses it to make sugar from carbon dioxide, releasing oxygen as waste.',
    speed: 1,
  },
  goe: {
    title: 'The Great Oxidation Event',
    text: 'A time-lapse of the whole habitat with the oxygen overlay on. Photosynthesisers pour out oxygen faster than it can be used up, and the ocean slowly fills with it.',
    speed: 7, overlay: 'oxygen',
  },
  eukaryote: {
    title: 'Endosymbiosis: the first eukaryote',
    text: 'This cell is about to swallow an oxygen-breathing bacterium that survives inside it and becomes a mitochondrion. Watch the host grow into a eukaryote while its new organelle multiplies.',
    speed: 1,
  },
  plastid: {
    title: 'The first alga',
    text: 'A eukaryote swallows a photosynthetic bacterium and keeps it as a chloroplast. From now on it can live on sunlight.',
    speed: 1,
  },
  sex: {
    title: 'Sex',
    text: 'Two eukaryotes of the same kind join and mix their genomes, so the offspring inherits a new combination of genes from both parents.',
    speed: 0,
  },
  colony: {
    title: 'The first colony',
    text: 'Follow this cell as it divides, and watch its daughters stay stuck together instead of drifting apart.',
    speed: 3,
  },
  multicellular: {
    title: 'A multicellular organism',
    text: 'Within this colony, cells take on different jobs (feeding, moving, defending, reproducing) and share what they make. It is becoming one organism.',
    speed: 4,
  },
  germline: {
    title: 'The next generation',
    text: 'A germline cell buds off from its organism and will grow into a whole new one: the start of a life cycle.',
    speed: 1,
  },
  complex: {
    title: 'A complex organism',
    text: 'Sixteen or more cells, at least three specialised cell types and a germline. Watch it grow and work as a whole.',
    speed: 4,
  },
};

// Narrative order, used for chapters found at the same tick.
export const ORDER = Object.keys(CHAPTERS);
