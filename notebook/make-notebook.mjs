// Build a self-contained Jupyter notebook (any Jupyter server, or Kaggle) that replays many worlds under two (or more) settings and
// compares how often each evolutionary stage emerges. The headless simulation is embedded, so the
// notebook needs nothing else (only Node, which it downloads if the image lacks it).
//
//   node notebook/make-notebook.mjs            -> notebook/primordial-soup-ab.ipynb (+ .py script)
//   node notebook/make-notebook.mjs --compact  -> same, with the embedded code gzipped into short lines
//                                                 (for notebook editors that choke on big cells)
//
// Rebuild after changing the simulation, so the notebook runs the current code.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'notebook', 'primordial-soup-ab.ipynb');

// The simulation's own files: everything world.js pulls in, plus the runner.
const files = new Set();
const queue = ['js/world.js'];
while (queue.length) {
  const f = queue.pop();
  if (files.has(f)) continue;
  files.add(f);
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of src.matchAll(/(?:import|from)\s*\(?['"](\.\/[^'"]+)['"]/g)) queue.push(path.posix.join(path.posix.dirname(f), m[1]));
}
files.add('check-evolution.mjs');
// Embedded either as each file's source in base64 (default), or gzipped and wrapped into short lines
// (--compact), for browser notebook editors that fail to show a notebook with one huge cell.
const compact = process.argv.includes('--compact');
const sources = {};
for (const f of [...files].sort()) sources[f] = fs.readFileSync(path.join(root, f), 'utf8');
sources['package.json'] = JSON.stringify({ type: 'module' });
const packed = zlib.gzipSync(JSON.stringify(sources), { level: 9 }).toString('base64').match(/.{1,100}/g).join('\n');
const blobs = Object.fromEntries(Object.entries(sources).map(([f, t]) => [f, Buffer.from(t).toString('base64')]));

let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(); } catch { /* not a repo */ }
const dirty = (() => { try { return execSync('git status --porcelain', { cwd: root }).toString().trim() ? ' (with uncommitted changes)' : ''; } catch { return ''; } })();

let cellNo = 0;
const id = () => `cell-${++cellNo}`;
const md = (s) => ({ cell_type: 'markdown', id: id(), metadata: {}, source: lines(s) });
const code = (s) => ({ cell_type: 'code', id: id(), metadata: {}, execution_count: null, outputs: [], source: lines(s) });
function lines(s) { const a = s.replace(/^\n/, '').split('\n'); return a.map((l, i) => (i < a.length - 1 ? l + '\n' : l)); }

const cells = [
  md(`
# Primordial Soup: replaying the tape of life, at scale

Runs the evolution simulation headless for many seeds under each setting below, then compares how often each
stage emerges (replicators → cells → proteins → DNA → photosynthesis → Great Oxidation → eukaryotes → sex →
multicellular → complex organisms), when it happens, and what the first cells' genomes looked like.

Simulation code: commit \`${commit}\`${dirty}, built ${new Date().toISOString().slice(0, 10)}.

Works on any Jupyter server (Linux or macOS) and on Kaggle. **Before running:** if there is no Node.js 18+, the setup
cell downloads it from nodejs.org, and it installs pandas / scipy / matplotlib if they are missing, so it needs internet
access the first time (on Kaggle: switch *Internet* on). It uses the CPUs and memory your container is actually allowed.
Results are saved after every world (\`primordial-soup-runs/results-<RUN_TAG>.jsonl\`), so if the kernel stops, run all
cells again and it carries on where it left off. Change \`RUN_TAG\` to start a fresh experiment.
`),
  code(`
# ---- Experiment settings -------------------------------------------------------------------------
# Each entry is a set of overrides for js/config.js (CFG). The first one is the baseline.
CONFIGS = {
    # Tuning food so it, not the 6,000-cell cap, limits mature worlds (the cap's safety valve kills cells at
    # random: ~324k "crowding" deaths per world in check1). A 40k-tick test (nut1) was too early to see crowding,
    # which follows the Great Oxidation, but showed deep cuts hurt young worlds (45%) while 75% did not
    # significantly. So: mild cuts, and one keeping the starting stock full while cutting the ongoing supply.
    "nut_100":   {},
    "nut_85":    {"NUT_INIT": 0.255, "VENT_NUT": 0.085, "WEATHERING": 0.136},
    "nut_75":    {"NUT_INIT": 0.225, "VENT_NUT": 0.075, "WEATHERING": 0.12},
    "supply_75": {"NUT_INIT": 0.3, "VENT_NUT": 0.075, "WEATHERING": 0.12},          # starting stock 100%, vents and weathering 75%
}
TICKS = 80_000            # simulated ticks per world (late stages typically arrive at 40k-70k)
SEEDS_PER_CONFIG = 28     # None: chosen from the number of cores (one full wave)
FIRST_SEED = 5001          # use a fresh range for each new experiment: runs are deterministic, so reused seeds
                           # replay the same worlds (seeds 1-54 were used by pool4, sun2 and o2a)
WORKERS = None            # None: as many as the cores and memory allow
RUN_TAG = "nut2"         # results go to primordial-soup-runs/results-<RUN_TAG>.jsonl
`),
  code(`
# ---- Environment: cores, memory, Python packages, Node.js -----------------------------------------
import os, sys, json, shutil, subprocess, platform, tarfile, urllib.request, base64, time, importlib.util

WORK = "/kaggle/working" if os.path.isdir("/kaggle/working") else os.path.join(os.getcwd(), "primordial-soup-runs")
os.makedirs(WORK, exist_ok=True)
SIM = os.path.join(WORK, "primordial-soup")

missing = [m for m in ("pandas", "scipy", "matplotlib") if importlib.util.find_spec(m) is None]
if missing:
    print("Installing", *missing)
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", *missing], check=True)

def read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None

def usable_cores():
    # The CPUs this process may run on, and any container (cgroup) quota, which os.cpu_count() ignores.
    n = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else (os.cpu_count() or 1)
    q = read("/sys/fs/cgroup/cpu.max")                          # cgroup v2: "<quota> <period>" or "max ..."
    if q and not q.startswith("max"):
        quota, period = map(int, q.split()[:2]); n = min(n, max(1, quota // period))
    q, p = read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"), read("/sys/fs/cgroup/cpu/cpu.cfs_period_us")  # v1
    if q and p and int(q) > 0:
        n = min(n, max(1, int(q) // int(p)))
    return n

def free_gb():
    # Memory still available, within the container's limit if it has one.
    avail = None
    for line in (read("/proc/meminfo") or "").splitlines():
        if line.startswith("MemAvailable:"):
            avail = int(line.split()[1]) / 1e6
    if avail is None:
        try:
            import psutil; avail = psutil.virtual_memory().available / 1e9
        except ImportError:
            avail = 8.0
    for lim, cur in (("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.current"),
                     ("/sys/fs/cgroup/memory/memory.limit_in_bytes", "/sys/fs/cgroup/memory/memory.usage_in_bytes")):
        L, C = read(lim), read(cur)
        if L and C and L.isdigit() and int(L) < 1 << 60:
            avail = min(avail, (int(L) - int(C)) / 1e9)
    return avail

cores, mem = usable_cores(), free_gb()
GB_PER_WORLD = 0.6        # a late-game world with ~4,000 cells peaks around this
if WORKERS is None:
    WORKERS = max(1, min(cores, int(mem / GB_PER_WORLD)))
if SEEDS_PER_CONFIG is None:
    SEEDS_PER_CONFIG = max(16, WORKERS // len(CONFIGS))
print(f"{cores} usable cores, {mem:.0f} GB free -> {WORKERS} worlds at a time; "
      f"{SEEDS_PER_CONFIG} seeds x {len(CONFIGS)} settings = {SEEDS_PER_CONFIG * len(CONFIGS)} worlds")

def node_version(exe):
    try:
        v = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=30).stdout.strip()
        return int(v.lstrip("v").split(".")[0]), v
    except Exception:
        return 0, None

NODE = shutil.which("node")
major, ver = node_version(NODE) if NODE else (0, None)
if major < 18:
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine().lower(), "x64")
    osname = {"linux": "linux", "darwin": "darwin"}.get(sys.platform)
    assert osname, "Install Node.js 18+ yourself on this system (automatic download covers Linux and macOS)"
    name = f"node-v20.18.0-{osname}-{arch}"
    dest = os.path.join(WORK, name)
    if not os.path.isdir(dest):
        ext = "tar.xz" if osname == "linux" else "tar.gz"
        url = f"https://nodejs.org/dist/v20.18.0/{name}.{ext}"
        print("Downloading", url)
        tar = os.path.join(WORK, f"{name}.{ext}")
        urllib.request.urlretrieve(url, tar)
        with tarfile.open(tar) as t:
            t.extractall(WORK)
        os.remove(tar)
    NODE = os.path.join(dest, "bin", "node")
    major, ver = node_version(NODE)
print("Node", ver, "at", NODE)
assert major >= 18, "Node.js 18+ is needed (allow internet access so it can be downloaded, or install it)"
`),
  code(compact ? `
# ---- The simulation (embedded: its ${files.size} source files, gzipped) ------------------------------------
import gzip
PACKED = """
${packed}
"""
for rel, text in json.loads(gzip.decompress(base64.b64decode("".join(PACKED.split())))).items():
    p = os.path.join(SIM, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        f.write(text)
` : `
# ---- The simulation (embedded: its ${files.size} source files, base64) ------------------------------------
FILES = ${JSON.stringify(blobs, null, 1)}
for rel, b64 in FILES.items():
    p = os.path.join(SIM, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(base64.b64decode(b64))
` + `# Smoke test: a short world must reach the first living cell.
r = subprocess.run([NODE, "check-evolution.mjs", "--worker", "1", "--seed", "1", "--ticks", "2500"],
                   cwd=SIM, capture_output=True, text=True, timeout=600)
print(r.stdout.strip()[:300] or r.stderr[-2000:])
`),
  code(`
# ---- Run (resumable) ------------------------------------------------------------------------------
from concurrent.futures import ThreadPoolExecutor, as_completed

RESULTS = os.path.join(WORK, f"results-{RUN_TAG}.jsonl")
done = set()
if os.path.exists(RESULTS):
    for line in open(RESULTS):
        try:
            r = json.loads(line)
            if not r.get("error"):
                done.add((r["config"], r["seed"]))
        except json.JSONDecodeError:
            pass
seeds = range(FIRST_SEED, FIRST_SEED + SEEDS_PER_CONFIG)
# Interleave the settings, so a run that stops early still has a fair comparison.
tasks = [(name, s) for s in seeds for name in CONFIGS if (name, s) not in done]
print(f"{len(done)} worlds already done, {len(tasks)} to go")

def run(task):
    name, seed = task
    cmd = [NODE, "check-evolution.mjs", "--worker", "1", "--seed", str(seed), "--ticks", str(TICKS),
           "--cfg", json.dumps(CONFIGS[name]), "--genes", "1"]
    p = subprocess.run(cmd, cwd=SIM, capture_output=True, text=True)
    try:
        r = json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:
        r = {"seed": seed, "error": (p.stderr or "no output")[-1500:]}
    r["config"] = name
    return r

t0 = time.time()
n = len(tasks)
with ThreadPoolExecutor(WORKERS) as ex, open(RESULTS, "a") as out:
    futs = [ex.submit(run, t) for t in tasks]
    for k, f in enumerate(as_completed(futs), 1):
        r = f.result()
        out.write(json.dumps(r) + "\\n"); out.flush()
        if r.get("error"):
            print("FAILED", r["config"], r["seed"], r["error"][-300:])
        if k == n or k % max(1, n // 40) == 0:
            el = time.time() - t0
            print(f"{k}/{n} worlds, {el/60:.1f} min elapsed, ~{el / k * (n - k) / 60:.0f} min left (rough)")
print("Done:", RESULTS)
`),
  code(`
# ---- Analysis -------------------------------------------------------------------------------------
import pandas as pd, numpy as np
from scipy.stats import fisher_exact, mannwhitneyu
def show(df):
    try:
        display(df)
    except NameError:
        print(df.to_string())

STAGES = [("replicator", "Replicator"), ("protocell", "Protocell"), ("cell", "Living cell"),
          ("translation", "Proteins / genetic code"), ("dna", "DNA genome"), ("photo", "Photosynthesis"),
          ("virus", "Viruses"), ("goe", "Great Oxidation"), ("eukaryote", "Eukaryote"),
          ("sex", "Sexual reproduction"), ("multicellular", "Multicellular"), ("complex", "Complex organism")]
runs = [json.loads(l) for l in open(RESULTS)]
runs = [r for r in runs if not r.get("error") and r["config"] in CONFIGS]
names = list(CONFIGS)
base = names[0]
by = {c: [r for r in runs if r["config"] == c] for c in names}
print({c: len(v) for c, v in by.items()}, "worlds per setting")

def wilson(k, n, z=1.96):
    if n == 0: return (np.nan, np.nan)
    p = k / n; d = 1 + z*z/n; c = (p + z*z/(2*n)) / d; h = z * np.sqrt(p*(1-p)/n + z*z/(4*n*n)) / d
    return (c - h, c + h)

def holm(ps):
    order = np.argsort(ps); adj = np.empty(len(ps)); m = len(ps); run = 0
    for i, j in enumerate(order):
        run = max(run, min(1, (m - i) * ps[j])); adj[j] = run
    return adj

rows = []
for key, label in STAGES:
    row = {"stage": label}
    for c in names:
        t = [r["ms"][key] for r in by[c] if key in r["ms"]]
        n = len(by[c]); k = len(t); lo, hi = wilson(k, n)
        row[f"{c} %"] = round(100 * k / n, 1) if n else np.nan
        row[f"{c} 95% CI"] = f"{100*lo:.0f}-{100*hi:.0f}"
        row[f"{c} median tick"] = int(np.median(t)) if t else None
    for c in names[1:]:
        kb = sum(key in r["ms"] for r in by[base]); nb = len(by[base])
        kc = sum(key in r["ms"] for r in by[c]); nc = len(by[c])
        row[f"p rate ({c})"] = fisher_exact([[kc, nc - kc], [kb, nb - kb]])[1] if nb and nc else np.nan
        tb = [r["ms"][key] for r in by[base] if key in r["ms"]]; tc = [r["ms"][key] for r in by[c] if key in r["ms"]]
        row[f"p timing ({c})"] = mannwhitneyu(tc, tb).pvalue if len(tb) > 2 and len(tc) > 2 else np.nan
    rows.append(row)
table = pd.DataFrame(rows)
for c in names[1:]:
    ps = table[f"p rate ({c})"].fillna(1).values
    table[f"p rate ({c}) Holm"] = holm(ps)
pd.set_option("display.width", 250)
show(table)
print("p rate: Fisher's exact test on how often the stage happened vs the baseline; p timing: Mann-Whitney U on "
      "when it happened (among worlds that reached it); Holm: corrected for testing 12 stages at once.")
`),
  code(`
# ---- Chart: share of worlds reaching each stage, with 95% intervals -----------------------------
import matplotlib.pyplot as plt
x = np.arange(len(STAGES)); w = 0.8 / len(names)
fig, ax = plt.subplots(figsize=(13, 4.5))
for i, c in enumerate(names):
    n = len(by[c]); ks = [sum(k in r["ms"] for r in by[c]) for k, _ in STAGES]
    p = np.array(ks) / max(1, n); ci = np.array([wilson(k, n) for k in ks])
    ax.bar(x + i*w - 0.4 + w/2, 100*p, w, yerr=[np.clip(100*(p - ci[:,0]), 0, None), np.clip(100*(ci[:,1] - p), 0, None)], capsize=3, label=f"{c} (n={n})")
ax.set_xticks(x); ax.set_xticklabels([l for _, l in STAGES], rotation=35, ha="right")
ax.set_ylabel("% of worlds"); ax.set_ylim(0, 105); ax.legend(); ax.set_title(f"Stages reached within {TICKS:,} ticks")
plt.tight_layout(); plt.show()
`),
  code(`
# ---- Founders: did the first cells start out different? -------------------------------------------
# A first cell's genome is built from its protocell's best replicator, so a change to early chemistry can
# change every lineage's starting traits. Compare the average founder genome per world.
genes = next((r["geneNames"] for r in runs if r.get("geneNames")), None)
def founder_means(c):
    out = []
    for r in by[c]:
        fs = r.get("founders") or []
        if fs: out.append(np.mean([f["g"] for f in fs], axis=0))
    return np.array(out)
fb = founder_means(base)
for c in names[1:]:
    fc = founder_means(c)
    if len(fb) < 3 or len(fc) < 3:
        print("Not enough founders yet"); continue
    res = []
    for j, g in enumerate(genes):
        p = mannwhitneyu(fc[:, j], fb[:, j]).pvalue
        res.append((g, fb[:, j].mean(), fc[:, j].mean(), fc[:, j].mean() - fb[:, j].mean(), p))
    df = pd.DataFrame(res, columns=["gene", base, c, "difference", "p"]).sort_values("p")
    df["p Holm"] = holm(df["p"].values)
    print(f"Founder genomes, {c} vs {base} (most different first):")
    show(df.head(12))
    for label, f in [("independent origins of life", lambda r: r.get("origins", 0)),
                     ("first cell's tick", lambda r: r["ms"].get("cell", np.nan)),
                     ("founding replicator length (nt)", lambda r: np.mean([x["len"] for x in r.get("founders") or [{"len": np.nan}]]))]:
        a = np.array([f(r) for r in by[base]], float); b = np.array([f(r) for r in by[c]], float)
        a, b = a[~np.isnan(a)], b[~np.isnan(b)]
        p = mannwhitneyu(b, a).pvalue if len(a) > 2 and len(b) > 2 else np.nan
        print(f"  {label}: {base} median {np.median(a):.1f}, {c} median {np.median(b):.1f} (p={p:.3g})")
`),
];

const nb = {
  cells,
  metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } },
  nbformat: 4, nbformat_minor: 5,
};
fs.writeFileSync(out, JSON.stringify(nb, null, 1));

// The same thing as a plain script, for services where notebooks won't open: python primordial-soup-ab.py
const script = ['# Primordial Soup A/B evolution runs (script version of primordial-soup-ab.ipynb).',
  '# Edit the settings block below, then: python primordial-soup-ab.py   (re-run to resume)', '',
  ...cells.filter((c) => c.cell_type === 'code').map((c) => c.source.join('').replace('plt.tight_layout(); plt.show()', 'plt.tight_layout(); plt.savefig(os.path.join(WORK, f"stages-{RUN_TAG}.png")); print("Chart saved to", os.path.join(WORK, f"stages-{RUN_TAG}.png"))'))].join('\n\n');
fs.writeFileSync(out.replace(/\.ipynb$/, '.py'), script);
console.log(`Wrote ${path.relative(root, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB, ${files.size} simulation files, commit ${commit}${dirty})`);
