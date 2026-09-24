# Status and next steps

Written 2026-09-24. Read this first if you are picking the project up cold;
[`03-roadmap.md`](03-roadmap.md) is the plan, this is where it has got to.

## Where things stand

The explorer is **live and working** at
<https://benmsanderson.github.io/meteor-view/>, deployed from the default
branch (`claude/youthful-brahmagupta-la5z3o`) by `.github/workflows/pages.yml`.

It is **deliberately unlisted**: `public/robots.txt` and a `noindex` meta tag
keep it out of search. Anyone with the link can open it. Removing those two is
the whole of "announce it" — but do it together with the re-export described
below, so what is published traces to merged code.

Working today: temperature and precipitation, 67 locations plus any region you
draw, 15 scenarios across two generations, forced-response maps with pan and
zoom, shareable links, CSV and PNG export, and a scenario-context figure. 82
tests, four layers of validation against METEOR itself. Deployed size 4.7 MB.

**Update, later on 2026-09-24.** On this branch, not yet on the default branch
or the live site:

- **Seven models**, switchable from a Model menu and carried in links as `m=`:
  NorESM2-MM plus the six below, all with fifteen scenarios. Golden fixtures
  pass for all seven (133 tests). 2081–2100 warming under ssp245 runs from
  2.1 °C (NorESM2-MM, MIROC6) to 4.1 °C (CanESM5), in the order their
  sensitivities would predict.
- **The live precipitation map is broken** and this branch fixes it: the build
  never copied `pr_climatology`, so the map's denominator 404s.
- **Deployed size is now 18 MB**, 15 MB of it pattern artifacts. That is the
  cost of committing them until the Zenodo deposit exists.
- **`origin/integration/meteor-view` is stale.** It predates #101's `b4cf389`,
  which the exporter needs to pass the CMIP7 emissions in. The six new models
  were exported from a local rebuild (`cb9f593`), which `refresh-integration.sh`
  verified is exactly `base` plus the three PRs, but that commit is not on
  GitHub. Run `scripts/refresh-integration.sh --push` to fix the branch.

## What is in flight

Three METEOR pull requests, all against `base`, all green:

| PR | What |
|---|---|
| [#104](https://github.com/benmsanderson/METEOR/pull/104) | CI: stop unrelated flakes blocking PRs |
| [#102](https://github.com/benmsanderson/METEOR/pull/102) | Validate `use_exog` / `weight_eofs` on a cached noise model |
| [#101](https://github.com/benmsanderson/METEOR/pull/101) | Portable emulator artifacts — the schema this whole repository reads |

**Merge order: #104, then #102, then #101.** Verified interchangeable — merging
in either order gives byte-identical trees — so the sequence is for
reviewability, not correctness.

`integration/meteor-view` is a **development branch, never a merge candidate**:
exactly `base` plus those three. `scripts/refresh-integration.sh` rebuilds it
and *proves* that property rather than assuming it. Re-run it whenever a PR
moves under review.

## Blocked, and on what

1. **Zenodo deposit** → blocked on the three PRs merging, so an artifact traces
   to merged code, and on an explicit go-ahead, since a DOI cannot be
   retracted. `scripts/deposit_bundles.py` in METEOR#101 implements the
   pre-reservation flow.
2. **Build-time artifact fetch** → blocked on the deposit. The storage split is
   decided (see [`../data/README.md`](../data/README.md)); until the deposit
   exists everything stays committed.
3. **Announcing the site** → blocked on re-exporting from `base` after the
   merges.

## Next steps, in order

### 1. Train more models — done for six, see the update above

The six models below trained in a 4-core, 15 GB cloud container in 3–7
minutes each, with a 10.5 GB peak. That is far less than the NorESM2-MM figures
below, because those grids are coarser. The instructions still hold for
further models.

Everything needed is in the repository. Nothing here is blocked.

```bash
git clone -b integration/meteor-view https://github.com/benmsanderson/METEOR.git
pip install -e METEOR            # or: pip install numpy xarray scikit-learn \
                                 #     statsmodels eofs regionmask gcsfs ciceroscm netCDF4

METEOR_SRC=$PWD/METEOR/src \
METEOR_CACHE=/scratch/$USER/meteor-cache \
  scripts/train-models.sh CanESM5 IPSL-CM6A-LR MRI-ESM2-0 MPI-ESM1-2-LR MIROC6 INM-CM5-0
```

**Resources, measured rather than estimated** (NorESM2-MM, `tas` + `pr`):

| | |
|---|---|
| Memory | **12.2–12.7 GB peak resident.** 16 GB minimum, 32 GB comfortable. This is the binding constraint; an 8 GB node will be killed. |
| Disk | ~2 GB of CMIP6 per model under `$METEOR_CACHE`, plus ~700 MB of fitted intermediates. Neither is needed afterwards. |
| Network | Anonymous reads from the CMIP6 store on Google Cloud. **Compute nodes need outbound HTTPS** — on a cluster that blocks it, stage the data from a login node first. |
| Time | Minutes to hours per model. |
| Output | About 4.6 MB per model. |

One process per model, so a failure takes only itself down, and re-running
resumes rather than restarts because METEOR does not retrain what is cached.

A single-node SLURM job, one model per array task:

```bash
#!/bin/bash
#SBATCH --job-name=meteor-train
#SBATCH --array=0-5
#SBATCH --cpus-per-task=4
#SBATCH --mem=32G
#SBATCH --time=08:00:00
#SBATCH --output=training-logs/slurm-%A_%a.out

MODELS=(CanESM5 IPSL-CM6A-LR MRI-ESM2-0 MPI-ESM1-2-LR MIROC6 INM-CM5-0)
export METEOR_SRC=$HOME/METEOR/src
export METEOR_CACHE=/scratch/$USER/meteor-cache
scripts/train-models.sh "${MODELS[$SLURM_ARRAY_TASK_ID]}"
```

**Which models.** 40 CMIP6 models carry monthly `tas` and `pr` across all four
experiments METEOR needs — `piControl`, `abrupt-4xCO2`, `historical` and one
SSP — so availability is not a constraint. The six above span roughly 1.9 to
5.6 °C of equilibrium sensitivity and favour coarser grids, which keeps memory
and time down; with NorESM2-MM that is seven models, enough for across-model
spread to mean something. Higher-resolution models (EC-Earth3, CNRM-CM6-1-HR,
MPI-ESM1-2-HR) will want more memory than the figures above.

**Before you start a batch: the CMIP7 scenarios are opt-in.** A checkout
without `scenario-work/` produces bundles carrying the eight CMIP6 SSPs and
none of the seven CMIP7 markers — by design, so that a clone without the
release still builds something valid, but easy to discover only after training
six models overnight. The runner warns and pauses, but to include them, first:

```bash
python scripts/convert_scenariomip.py ~/ScenarioMIP_emissions_marker_scenarios_v0.2.xlsx
```

You need your own copy of the release; this repository does not redistribute
it. A `tas` bundle with all fifteen scenarios is 110 KB; with the SSPs alone it
is 81 KB, which is the quickest way to tell which you have.

**What to do with the output.** Commit the bundles and climatologies —
~575 KB per model. The 2 MB pattern artifacts belong in the Zenodo deposit
rather than git; until that exists, commit them too but **do not re-export
needlessly**, because every distinct copy stays in history for ever. The
exporter now writes a file only when its numbers change, so a no-op re-export
produces no diff at all.

### 2. Make the client multi-model

The model picker is done. What is left is a decision about whether to
show models individually, show across-model spread, or both — the second is
what turns "one model's internal variability" into something that represents
projection uncertainty honestly.

### 3. Compare two scenarios at once — done

Built as multi-selection with a two-scenario map comparison; see
[`03-roadmap.md`](03-roadmap.md#3-compare-two-scenarios-at-once) for what was
built against the plan.

**Performance, profiled 2026-09-24.** 87% of generation time was the VAR
noise recursion, and three-quarters of that was spin-up: every run simulated
from 1750 to reach a 2015 window, when every model's VAR forgets its starting
state within about 25 years. The client now measures each bundle's spin-up
(`spinUpMonths` in `kernel.js`) and starts there, and generation runs in a
pool of up to four Web Workers (`runner.js`). Six scenarios at 100
realizations went from about 21 s with the page frozen to 2.3 s with the
longest main-thread block at 71 ms. Results are bit-identical between worker
and page; seeds still reproduce, but draw different realizations than before
the spin-up change, so links made earlier show a different sample of the same
ensemble.

### Baselines — done

Change from 1850–1900 (default) or 2005–2024, chosen in the controls and
carried in links as `ref=recent`. Both are the forced-response mean over the
period under CMIP7 Medium, shared by every scenario, so scenario differences
are unchanged by the choice. Applies to temperature everywhere and to the
precipitation maps; the precipitation timeseries stays absolute. Before this,
"anomaly" silently meant change since 1750, the first year of the forcing.

## Things that would surprise you

- **METEOR's trunk is `base`, not `main`.** `main` is a 2023 orphan with no
  common ancestor — 233 files and ~104k lines apart. Nothing should be merged
  there.
- **The CMIP7 emissions are not in this repository and must not be.** Download
  the release yourself and run `scripts/convert_scenariomip.py`; only the
  forcing CICERO derives from them is committed. See
  [`../data/README.md`](../data/README.md).
- **Six things this port had to infer** because METEOR's schema did not state
  them are written up in [`02-client-findings.md`](02-client-findings.md), and
  fixed upstream in #101. The worst produced plausible numbers rather than
  errors: METEOR's timeseries path subtracts the intercept *and* the `t_glob`
  term, which is worth a factor of two in the warming trend, and every golden
  fixture still passed.
- **The map's colour classes are sampled by value, not evenly.** Warming is
  almost entirely positive, so even sampling puts the colormap's white centre
  at 3.5 °C. If you change the bin edges, re-derive the colours.
