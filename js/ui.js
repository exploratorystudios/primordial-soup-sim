// Side panel: census, charts, milestones, inspector, tree of life and toasts.
import { MILESTONES } from './world.js';
import { BASES } from './chemistry.js';
import { TYPE_NAMES, TROPH_NAMES } from './life.js';
import { TYPE_COLORS } from './render.js';
import * as Gn from './genome.js';
import { formatLen, NM_PER_UNIT, DIM } from './render.js';
import { children, info, ancestors, crumbLabel } from './parts.js';
import { maturity, stage, phospholipidShare, peptides, protoRibosome, magnesiumCount } from './protocell.js';

const $ = (id) => document.getElementById(id);

const SERIES = [
  ['rep', 'Replicators', '#ff5ce1'],
  ['proto', 'Protocells', '#ffb3f0'],
  ['photo', 'Phototrophs', '#5fd16b'],
  ['chemo', 'Chemotrophs', '#eb963c'],
  ['hetero', 'Heterotrophs', '#9b77f0'],
  ['pred', 'Predators', '#f04a5a'],
  ['euk', 'Eukaryotes', '#ffffff'],
  ['viruses', 'Viruses', '#d4ff6a'],
  ['colony', 'In colonies', '#4fd2ff'],
  ['o2', 'O₂ ×100', '#7f8da3'],
];

const fmt = (n) => (n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n)));

export class UI {
  constructor() {
    this.selected = null;
    this.seenMilestones = 0;
    this.seenLogs = 0;
    this.chart = $('chart');
    $('chart-legend').innerHTML = SERIES.map(([, n, c]) => `<span style="--c:${c}">${n}</span>`).join('');
    this.buildMilestones();
    this.kids = [];
    this.crumbs = [];
    this.onPick = null; // set by main: select + zoom to a part
    // pointerdown (not click) so a re-render between press and release can't swallow it.
    $('inspector').addEventListener('pointerdown', (e) => {
      if (e.target.closest('[data-follow]')) { e.preventDefault(); if (this.onFollow) this.onFollow(); return; }
      if (e.target.closest('[data-up]')) { e.preventDefault(); if (this.onUp) this.onUp(); return; }
      const k = e.target.closest('[data-kid]'), c = e.target.closest('[data-crumb]');
      const target = k ? this.kids[+k.dataset.kid] : c ? this.crumbs[+c.dataset.crumb] : null;
      if (target && this.onPick) { e.preventDefault(); this.onPick(target); }
    });
  }

  reset() {
    this.selected = null;
    this.seenMilestones = 0;
    this.seenLogs = 0;
    this.buildMilestones();
    $('toast-area').innerHTML = '';
    this.renderInspector(null);
  }

  buildMilestones() {
    $('milestones').innerHTML = MILESTONES.map(([k, n]) => `<li data-k="${k}"><span class="name">${n}</span><span class="when"></span></li>`).join('');
  }

  toast(text, t) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<div class="t">tick ${t.toLocaleString()}</div>${text}`;
    const area = $('toast-area');
    area.prepend(el);
    while (area.children.length > 4) area.lastChild.remove();
    setTimeout(() => { el.style.opacity = '0'; }, 7000);
    setTimeout(() => el.remove(), 8000);
  }

  update(world, frame) {
    $('clock').textContent = `tick ${world.t.toLocaleString()}`;
    const era = world.era();
    $('era-name').textContent = era.name;
    $('era-desc').textContent = era.desc;
    $('era-earth').textContent = `On Earth: ${era.earth}`;

    while (this.seenLogs < world.logs.length) {
      const l = world.logs[this.seenLogs++];
      if (l.major) this.toast(l.text, l.t);
    }
    if (world.logs.length < this.seenLogs) this.seenLogs = world.logs.length;
    while (this.seenMilestones < world.milestones.length) {
      const m = world.milestones[this.seenMilestones++];
      const li = document.querySelector(`#milestones li[data-k="${m.key}"]`);
      if (li) { li.classList.add('done'); li.querySelector('.when').textContent = m.t.toLocaleString(); }
    }

    if (frame % 15 === 0) this.renderStats(world);
    if (frame % 30 === 0) this.renderChart(world);
    if (frame % 10 === 0) this.renderInspector(world);
  }

  renderStats(world) {
    const s = world.soup, L = world.life, st = L.stats;
    const big = L.organisms[0];
    const rows = [
      ['Chemistry'],
      ['Free monomers', s.n],
      ['Polymers (longest)', `${s.polymers.length} (${s.stats.maxLen})`],
      ['Replicators', s.stats.replicators],
      ['Vesicles / protocells', `${s.vesicles.length} / ${s.stats.protocells}`],
      ['Life'],
      ['Living cells', L.cells.length],
      ['Abiogenesis events', L.origins],
      ['Species alive', st.speciesAlive],
      ['Deepest generation', st.maxGen],
      ['Protein-making cells', st.proteinCells],
      ['DNA genomes', st.dnaCells],
      ['Eukaryotes', st.euk],
      ['Sexual births', fmt(st.sexualBirths || 0)],
      ['Algae (with plastids)', st.plastid],
      ['Cells in colonies', st.inColonies],
      ['Multicellular organisms', st.multicellular],
      ['Complex organisms', st.complex],
      ['Largest organism', big ? `${big.size} cells` : '—'],
      ['Viruses'],
      ['Virus particles', world.viruses ? world.viruses.list.length : 0],
      ['Virus lineages', world.viruses ? world.viruses.lineages : 0],
      ['Infected cells', st.infected],
      ['Environment'],
      ['Mean oxygen (ocean / air)', `${world.o2.toFixed(2)} / ${(world.atmO2 || 0).toFixed(2)}`],
      ['Births / deaths', `${fmt(L.births)} / ${fmt(Object.values(L.deaths).reduce((a, b) => a + b, 0))}`],
      ['Died: starved / eaten', `${fmt(L.deaths.starved)} / ${fmt(L.deaths.eaten)}`],
      ['Died: O₂ / old age', `${fmt(L.deaths.oxygen)} / ${fmt(L.deaths.aged)}`],
      ['Died: viruses / impacts', `${fmt(L.deaths.virus)} / ${fmt(L.deaths.impact)}`],
    ];
    $('stats').innerHTML = rows.map((r) => (r.length === 1 ? `<div class="group">${r[0]}</div>` : `<dt>${r[0]}</dt><dd>${r[1]}</dd>`)).join('');
  }

  renderChart(world) {
    const cv = this.chart, dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth * dpr, h = cv.clientHeight * dpr;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const H = world.history;
    if (H.length < 2) return;
    const maxV = 4000, ly = (v) => h - 4 - (Math.log10(1 + v) / Math.log10(1 + maxV)) * (h - 8);
    ctx.strokeStyle = '#162238'; ctx.lineWidth = 1;
    ctx.fillStyle = '#4b5a70'; ctx.font = `${10 * dpr}px system-ui`;
    for (const v of [1, 10, 100, 1000]) {
      const y = ly(v);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillText(String(v), 3, y - 2);
    }
    const t0 = H[0].t, t1 = H[H.length - 1].t || 1;
    const lx = (t) => ((t - t0) / Math.max(1, t1 - t0)) * w;
    ctx.lineWidth = 1.4 * dpr;
    for (const [k, , c] of SERIES) {
      ctx.strokeStyle = c;
      ctx.beginPath();
      for (let i = 0; i < H.length; i++) {
        const v = k === 'o2' ? H[i].o2 * 100 : H[i][k];
        const x = lx(H[i].t), y = ly(v);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // Milestone ticks.
    ctx.fillStyle = '#ffb454';
    for (const m of world.milestones) ctx.fillRect(lx(m.t) - dpr * 0.5, 0, dpr, 5 * dpr);
  }

  select(world, sel) {
    this.selected = sel;
    this.lastHTML = null;
    this.renderInspector(world);
  }

  renderInspector(world) {
    const el = $('inspector');
    const sel = this.selected;
    if (!sel || !world) {
      el.innerHTML = '<p class="muted">Click something to select it. Click again inside the selection to select the part under the cursor (Esc goes back up). Its parts are also listed here.</p>';
      this.lastHTML = null;
      return;
    }
    this.crumbs = ancestors(sel, world);
    const crumbs = this.crumbs.map((c, i) => `<a data-crumb="${i}">${esc(crumbLabel(c))}</a> › `).join('') + `<b>${esc(crumbLabel(sel))}</b>`;
    let body;
    if (sel.kind === 'cell') body = this.cellHTML(world, sel.obj);
    else if (sel.kind === 'vesicle') body = this.vesicleHTML(sel.obj);
    else if (sel.kind === 'polymer') body = this.polymerHTML(sel.obj);
    else body = infoHTML(info(sel, world));
    if (sel.gone) body = '<p class="gone">This no longer exists: it was eaten, broke apart, divided, or was built into something larger.</p>' + body;
    this.kids = children(sel, world, this.renderer);
    const kids = this.kids.length
      ? `<h3>Parts <span class="muted">(${this.kids.length})</span></h3><ul class="parts">${this.kids.map((k, i) => `<li data-kid="${i}"><span>${esc(crumbLabel(k))}</span><span class="muted">${esc(k.note || '')}</span></li>`).join('')}</ul>`
      : '';
    const follow = (sel.gone ? '' : `<button class="follow ${sel.follow ? 'on' : ''}" data-follow title="F">${sel.follow ? 'Following' : 'Follow'}</button>`)
      + (this.crumbs.length ? `<button class="follow" data-up title="Esc: select the thing this is part of">↑ Up</button>` : '');
    const html = `<div class="crumbs">${crumbs}${follow}</div>${body}${kids}`;
    // Only touch the DOM when something changed, so clicks are never lost mid-update.
    if (html !== this.lastHTML) { el.innerHTML = html; this.lastHTML = html; }
  }

  polymerHTML(p) {
    const lenNm = p.seq.length * DIM.ntRise;
    return `<div class="insp-title">RNA strand, ${p.seq.length} nucleotides</div>
      <div class="seq">${seqHTML(p.seq)}</div>
      <div class="insp-kv" style="margin-top:6px">
        <span>Length (unfolded)</span><span>${formatLen(lenNm)}</span>
        <span>Ribozyme activity</span><span>${(p.act * 100).toFixed(0)}%</span>
        <span>Copy fidelity</span><span>${p.act > 0 ? (p.fid * 100).toFixed(1) + '%' : '—'}</span>
        <span>G–C stability</span><span>${(p.stab * 100).toFixed(0)}%</span>
        <span>Copy progress</span><span>${p.act > 0 ? `${p.prog}/${p.seq.length}` : '—'}</span>
      </div>
      <p class="muted">${p.act > 0 ? 'This chain folds into a hairpin-shaped catalyst that copies itself, base by base, from free nucleotides.' : 'An inert chain: it cannot fold into a working catalyst.'}</p>`;
  }

  vesicleHTML(v) {
    const reps = v.polys.filter((p) => p.act > 0);
    const m = maturity(v), ph = phospholipidShare(m), peps = peptides(v, m), core = protoRibosome(v, m);
    const mg = v.polys.reduce((n, p) => n + magnesiumCount(p), 0);
    return `<div class="insp-title">${reps.length ? 'Protocell' : 'Lipid vesicle'}</div>
      <div class="insp-kv">
        <span>Stage</span><span>${stage(m)} (${(m * 100).toFixed(0)}% of the way to life)</span>
        <span>Diameter</span><span>${formatLen(v.r * 2 * NM_PER_UNIT)}</span>
        <span>Membrane</span><span>4 nm bilayer: ${ph < 0.01 ? 'fatty acids' : `${(100 - ph * 100).toFixed(0)}% fatty acids, ${(ph * 100).toFixed(0)}% phospholipids`}</span>
        <span>Mg²⁺ on ribozymes</span><span>${mg || '—'}</span>
        <span>Peptides</span><span>${peps.length ? peps.map((p) => p.seq.join('-')).join(', ') : '—'}</span>
        <span>Proto-ribosome</span><span>${core ? `forming (from a ${core.seq.length} nt ribozyme)` : '—'}</span>
        <span>Membrane units (sim)</span><span>${v.L}</span>
        <span>Generation</span><span>${v.gen}</span>
        <span>RNA inside</span><span>${v.polys.length} (${reps.length} replicating)</span>
        <span>Self-copies made</span><span>${v.copies}</span>
        <span>Nucleotide pool A/U/G/C</span><span>${v.pool.join(' / ')}</span>
      </div>
      <p class="muted">Vesicles grow by absorbing fatty acids and divide through a string of beads; ones packed with replicators grow faster. Once a lineage has divided twice and its replicators have copied themselves, the protocell becomes a living cell.</p>
      <p class="muted">On the way, as drawn here: phospholipids mix into the leaky fatty-acid membrane (well established in experiments), ribozymes hold magnesium ions (established), short peptides of prebiotic amino acids appear (plausible), and the best ribozyme grows into a proto-ribosome that joins amino acids (a leading idea, unproven). These follow the lineage’s progress in the simulation but are not simulated themselves.</p>`;
  }

  cellHTML(world, c) {
    const L = world.life, sp = L.species.get(c.species);
    const org = L.organisms.find((o) => o.id === c.org);
    const g = c.g;
    const bar = (i) => {
      const signed = i >= Gn.FIRST_SIGNED, v = g[i];
      const left = signed ? (v < 0 ? 50 + v * 50 : 50) : 0, width = signed ? Math.abs(v) * 50 : v * 100;
      return `<div class="gene"><span>${Gn.GENE_NAMES[i]}</span><div class="bar"><i style="left:${left}%;width:${width}%"></i></div></div>`;
    };
    const kind = c.mito ? (c.plastid ? 'Eukaryotic alga' : 'Eukaryote') : 'Prokaryote';
    return `<div class="insp-title">${kind} #${c.id}</div>
      <div class="insp-kv">
        <span>Diameter</span><span>${formatLen(c.r * 2 * NM_PER_UNIT)}</span>
        <span>Strategy</span><span>${TROPH_NAMES[c.troph]}</span>
        <span>Genome</span><span>${c.dna ? 'DNA' : 'RNA'} · proteins ${Math.round(c.transl * 100)}%</span>
        ${c.infected ? `<span>Status</span><span style="color:#d4ff6a">infected (virus lineage #${c.infected.lineage})</span>` : ''}
        ${c.sexual ? '<span>Born</span><span>sexually</span>' : ''}
        <span>Species</span><span style="color:${c.hueColor}">#${c.species}${sp ? `, born tick ${sp.born.toLocaleString()}` : ''}</span>
        <span>Generation</span><span>${c.gen} (lineage ${c.origin})</span>
        <span>Energy</span><span>${c.energy.toFixed(1)} / ${c.cap.toFixed(0)}</span>
        <span>Age</span><span>${c.age} / ${Math.round(c.lifespan)}</span>
        <span>Organism</span><span>${c.orgSize > 1 ? `${c.orgSize} cells${org ? `, ${org.kind}` : ''}` : 'single cell'}</span>
        ${c.orgSize > 1 ? `<span>Cell fate</span><span style="color:${TYPE_COLORS[c.type]}">${TYPE_NAMES[c.type]}</span>` : ''}
      </div>
      ${[Gn.SIZE, Gn.PHOTO, Gn.CHEMO, Gn.HETERO, Gn.PRED, Gn.MOTIL, Gn.AEROBIC, Gn.ARMOR, Gn.ADHES, Gn.TRANSL, Gn.DNAG, Gn.SEX, Gn.RESIST].map(bar).join('')}
      ${c.founderSeq ? `<p class="muted">Founded by replicator:</p><div class="seq">${seqHTML(c.founderSeq)}</div>` : ''}`;
  }

  drawTree(world) {
    const cv = $('tree'), dpr = window.devicePixelRatio || 1;
    cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
    drawTreeOn(cv, world, dpr);
  }
}

// Phylogeny of every species that reached a population of 5+ (also used by the video renderer).
export function drawTreeOn(cv, world, dpr = 1) {
  {
    const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const L = world.life, all = L.species;
    let list = [...all.values()].filter((s) => s.peak >= 5 || s.count >= 5);
    list.sort((a, b) => b.peak - a.peak);
    list = list.slice(0, 300);
    const keep = new Set(list.map((s) => s.id));
    // Attach each kept species to its nearest kept ancestor.
    const parentOf = (s) => {
      let p = all.get(s.parent);
      while (p && !keep.has(p.id)) p = all.get(p.parent);
      return p ? p.id : 0;
    };
    const kids = new Map();
    for (const s of list) {
      const p = parentOf(s);
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(s);
    }
    for (const arr of kids.values()) arr.sort((a, b) => a.born - b.born);
    const rows = new Map();
    let row = 0;
    const visit = (s) => { rows.set(s.id, row++); for (const k of kids.get(s.id) || []) visit(k); };
    for (const r of kids.get(0) || []) visit(r);
    ctx.font = `${12 * dpr}px system-ui`;
    if (row === 0) { ctx.fillStyle = '#7d8ca3'; ctx.fillText('No species have reached a population of 5 yet.', 20 * dpr, 30 * dpr); return; }
    const t0 = Math.min(...list.map((s) => s.born)), t1 = Math.max(world.t, t0 + 1);
    const pad = 30 * dpr, lx = (t) => pad + ((t - t0) / (t1 - t0)) * (W - pad * 2);
    const rh = Math.min(14 * dpr, (H - pad * 2) / row), ry = (r) => pad + r * rh + rh / 2;
    ctx.fillStyle = '#4b5a70';
    ctx.fillText(`tick ${t0.toLocaleString()}`, pad, H - 8 * dpr);
    const lbl = `tick ${t1.toLocaleString()}`;
    ctx.fillText(lbl, W - pad - ctx.measureText(lbl).width, H - 8 * dpr);
    for (const s of list) {
      const y = ry(rows.get(s.id)), x0 = lx(s.born), x1 = lx(s.extinct >= 0 ? s.extinct : world.t);
      const col = `hsl(${Math.round(s.hue * 360)},70%,${s.count > 0 ? 62 : 38}%)`;
      const p = parentOf(s);
      if (p && rows.has(p)) {
        ctx.strokeStyle = 'rgba(140,160,190,0.35)'; ctx.lineWidth = dpr;
        ctx.beginPath(); ctx.moveTo(x0, ry(rows.get(p))); ctx.lineTo(x0, y); ctx.stroke();
      }
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1, Math.min(rh * 0.8, Math.log2(s.peak) * 0.9 * dpr));
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(Math.max(x1, x0 + 2), y); ctx.stroke();
      if (rh >= 9 * dpr && (s.count > 0 || s.euk || s.multi)) {
        ctx.fillStyle = col;
        const tag = `${s.euk ? '★' : ''}${s.multi ? '◆' : ''} #${s.id} ${TROPH_NAMES[s.troph]}${s.count ? ` (${s.count})` : ''}`;
        const tw = ctx.measureText(tag).width;
        if (x1 + 4 * dpr + tw < W) ctx.fillText(tag, x1 + 4 * dpr, y + 4 * dpr);
        else ctx.fillText(tag, Math.max(0, x1 - tw), y - 4 * dpr);
      }
    }
  }
}

function infoHTML(inf) {
  if (!inf) return '';
  return `<div class="insp-title">${esc(inf.title)}</div>
    ${inf.kv && inf.kv.length ? `<div class="insp-kv">${inf.kv.map(([k, v]) => `<span>${esc(k)}</span><span>${esc(v)}</span>`).join('')}</div>` : ''}
    <p class="muted">${esc(inf.desc || '')}</p>`;
}

function esc(t) {
  return String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function seqHTML(seq) {
  return seq.map((b) => `<b class="${BASES[b]}">${BASES[b]}</b>`).join('');
}
