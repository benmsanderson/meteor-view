# meteor-view: development plan

A browser-based tool for running [METEOR](https://github.com/benmsanderson/METEOR),
served as a static github.io site from this repository.

**Status:** built. The METEOR-side work in
[`01-unblock-meteor-export.md`](01-unblock-meteor-export.md) is done as
benmsanderson/METEOR#101, alongside #102 and #104. All three target METEOR's
trunk, `base` — note that METEOR's `main` is an unrelated 2023 lineage with no
common ancestor, and is not where anything should be merged.

`integration/meteor-view` is a **development branch, not a merge candidate**:
exactly `base` plus those three PRs, refreshed as they move, so work here can
proceed before they land. Its tree is verified identical to merging the three
into `base`. Recommended merge sequence, for reviewability rather than
correctness (the orders produce byte-identical trees): **#104, then #102, then
#101**. #100 was fully superseded by #104 and is closed.

`scripts/refresh-integration.sh` rebuilds that branch and verifies the property
it depends on, so it can be re-run as the PRs change under review.

The client is done: a validated JavaScript kernel, the fixtures wired into CI,
and a Pages deploy. See [`02-client-findings.md`](02-client-findings.md) for
what the port had to infer that the schema did not state — the most useful
feedback METEOR can get from this exercise, because it is what the next port
would also get stuck on.

Current state and next steps are in [`04-status.md`](04-status.md); what is
left overall is in [`03-roadmap.md`](03-roadmap.md), which supersedes the work
breakdown in §3 below — that section is kept as the original plan, not as a
current to-do list.

Immediately outstanding: the three METEOR PRs are unmerged, so the bundles here
were exported from the integration branch and will need re-exporting from
`base` once they land. The Zenodo deposit is still pending, deliberately: it
waits for the expanded model set and for the checklist in §6.

This document exists so the reasoning does not have to be re-derived. Facts
below were verified against `benmsanderson/METEOR` at commit `f6dc3d1` on
branch `base` (the default branch — not `main`) on 2026-09-18. Anything
inferred rather than checked is labelled.

---

## 1. The finding that determines the architecture

METEOR splits into two jobs with wildly different costs.

**Training** (`MeteorInterface.train`) pulls CMIP6 zarr stores from Google
Cloud — `gcsfs` with `token="anon"`, catalogue at
`https://storage.googleapis.com/cmip6/cmip6-zarr-consolidated-stores.csv`,
read via `xr.open_zarr` — then fits EOFs and a VAR-X noise model. Gigabytes
in, minutes to hours, needs `scikit-learn`/`statsmodels`/`eofs`. This will
never run in a browser and does not need to.

**Generation** (`generate_ensemble_outputs`) is comparatively trivial: run
CICERO-SCM for forcing, scale patterns, simulate a lag-2 VAR on 40 modes,
project onto a region. For `tas` timeseries it touches no CMIP6 data at all —
`meteor_interface.py:1394` says so in as many words: *"tas has no transform,
so its reference data is never loaded."*

So the question is not "browser or server". It is: **train offline, ship the
trained emulator, generate wherever.** Everything below follows from that.

## 2. Architecture options considered

### A. Pyodide — real METEOR in the browser

More viable than expected:

- `ciceroscm` 2.1.2 is a pure-Python wheel (`py3-none-any`, 104 KB); its
  dependencies are click, python-dotenv, tqdm, matplotlib, scipy, numpy,
  pandas. Verified on PyPI.
- `eofs` 2.0.0 is pure-Python, numpy only. Verified on PyPI.
- `gcsfs` is the only dependency with no browser path — and inference does not
  need it.

*Not verified:* that numpy/scipy/pandas/xarray/statsmodels/sklearn/netcdf4/
shapely all ship in Pyodide. Believed true but `pyodide.org` and
`cdn.jsdelivr.net` were both blocked by the session proxy, so the package
list could not be checked. **Confirm against `pyodide-lock.json` before
committing to this route.**

Costs: ~30–50 MB of Pyodide before anything runs; trained models are pickles
containing live `statsmodels`/`sklearn` objects; `pr` generation re-fetches
CMIP6. Best fit for a JupyterLite "try the notebooks" page, not a responsive
explorer.

### B. Static site + a small JS generation kernel — chosen

Export trained emulators offline to a compact format; the browser does the
arithmetic.

The enabling insight: the region/point timeseries path never needs the EOF
*maps*. Read `generate_regional_mean_realizations`
(`noise_generator.py:884`) — a region-mean realization is

```
seasonal_mean + pcs @ eof_projections
```

where `eof_projections` has shape `(n_modes,)`. And because the harmonic
design matrix `X` is identical at every gridpoint, the area-weighted spatial
mean of `X @ coef_.T + intercept_` equals `X @ mean(coef_) + mean(intercept_)`
— so the region-mean seasonal cycle needs 9 coefficients and an intercept per
region, not `n_space × 9`. Roughly 50 floats per location instead of a
multi-megabyte EOF map.

The usual objection is that custom scenarios would need CICERO-SCM
client-side. But `generate_ensemble_outputs` already accepts a
`temp_scaling_ts` argument: an arbitrary GMST trajectory to scale the pattern
to. So the browser knob becomes *pick a warming pathway*, and no SCM is needed
client-side at all. (A freehand drawing interface for this was built and then
removed: the demand is for published pathways, not arbitrary curves. The
capability remains in the kernel.) Full custom-emissions runs stay a
server/Colab feature.

Cost: a second implementation of the generation maths, which must be
validated against Python by golden fixtures. That risk is why the fixtures
are a required deliverable, not a nice-to-have.

### C. Server

*Superseded in part: see §4 — gridded output turned out not to need this.*

FastAPI or Gradio around the real package. Full fidelity — gridded output,
live CMIP6, custom emissions, no reimplementation risk. Cloud Run or Fly.io
(scale-to-zero, cold starts), or HuggingFace Spaces for near-zero ops.

Rejected as the *first* move because it costs money and attention
indefinitely, which is what kills academic tools. Retained as the later home
for gridded maps.

## 3. The plan

Two tracks, serving different audiences.

**Track 1 — Colab badge (hours, not days).** Add an "Open in Colab" badge to
`notebooks/METEOR_Interface_Examples.ipynb` in the METEOR repo. Colab already
has the dependency stack and CMIP6 access. This serves every expert user who
wants real METEOR and costs a README edit. Do this first; it is nearly free
and it takes the pressure off the web tool to be everything.

**Track 2 — this repository.** Architecture B. Knobs: model, variable,
scenario or drawn GMST pathway, region/point, number of realizations. Payload
a few hundred KB. Add architecture C later, behind a "full gridded run"
button, only if demand justifies it.

### Work breakdown

**METEOR side** — see [`01-unblock-meteor-export.md`](01-unblock-meteor-export.md)
for the full prompt. Three stages, ordered so the branch is useful if it stops
early:

1. A portable, versioned, non-executable emulator artifact (netCDF via
   xarray) replacing the pickled `statsmodels`/`sklearn` objects. The real
   content is refactoring the generation paths to consume plain arrays.
2. A compact region-projected bundle for timeseries-only clients, plus golden
   fixtures for cross-language validation.
3. Removing the generation-time CMIP6 fetch from the `pr` path.

Stages 1 and 2 are what unblock this repo. Stage 3 is droppable.

**meteor-view side** — not started, and deliberately not designed in detail
until the bundle schema exists:

1. Read the bundle schema from stage 2; port the generation kernel to JS
   (VAR(2) simulation, harmonic seasonal cycle, EOF projection, pattern
   scaling).
2. Validate against the golden fixtures in CI. This is the quality gate for
   the whole approach.
3. UI: scenario/pathway picker, region selector, ensemble fan chart.
4. GitHub Pages deploy.

## 4. Open decisions

- **Bundle format — settled.** Classic netCDF-3 (`NETCDF3_64BIT`), not
  NETCDF4. Classic parses with `netcdfjs`, a few kilobytes; NETCDF4 is HDF5
  underneath and needs a one-to-two megabyte WebAssembly build of libhdf5
  before a single byte can be read. Nothing was lost: every numeric array is
  bit-identical between the two and the classic file is *smaller*.
- **Audience — settled.** Scientists from adjacent fields wanting a rapid
  climate assessment, particularly for scenarios most ESMs have not run yet
  (CMIP7). Not climate modellers, who will clone the repo; not the general
  public. See [`03-roadmap.md`](03-roadmap.md). The CMIP7 source is
  `10.5281/zenodo.19825038`, which was noted here as **embargoed pre-release
  data**: nothing derived from it to be published until the early access
  period ends. *Re-checked 2026-09-25, to be confirmed:* the record is open
  access (v0.2, published 2026-04-15, no embargo date), and the
  [licence](https://scenariomip.apps.ece.iiasa.ac.at/license) it points to
  permits sharing adapted material "for scientific research, science
  communication or policy consultancy, including … online visualization
  tools", with attribution and without reproducing substantial portions. If
  the early-access restriction came from somewhere other than the record,
  that source still governs. Attribution has been added to the page footer;
  see §6.
- **Gridded maps — the claim below was wrong.** "Reconstructing 100
  realizations × 3012 months × 55k gridpoints is not a client-side operation"
  is true and irrelevant: a map view never asks for that. Measured, a
  forced-response map needs only the 2.0 MB pattern artifact and ~166k
  multiply-adds per timestep, and a single realization's map ~2.2M. Maps and
  custom locations are a download away, not a server away. Only custom
  *emissions* still needs one, for CICERO-SCM.
- **Track 1, the Colab badge — not done.** There is still no Colab link in
  METEOR's README or examples notebook on `base`. It remains the cheapest
  thing on this list.

## 5. Facts worth not re-deriving

Verified in `src/meteor/` at `f6dc3d1`:

- Shipped defaults (`_get_default_config`, `meteor_interface.py:43`):
  `n_modes_pattern=3`, `n_modes_noise=40`, `lag_order=2`. `use_exog='none'`
  for both `tas` and `pr`, so `n_exog` is 0 by default. `pr` gets a `gamma`
  transform; `tas` gets none.
- `_generate_stochastic_pcs` (`noise_generator.py:624`) uses the whole
  `statsmodels` VARX results object only for `params` and `sigma_u`, reducing
  to: intercept `(n_modes,)`, `lag_order` × `(n_modes, n_modes)` lag
  matrices, residual covariance `(n_modes, n_modes)`, and a
  `(n_modes, n_exog)` exogenous matrix. About 4,900 floats at the defaults.
- `seasonal_model` is an `sklearn.LinearRegression` with `coef_` of shape
  `(n_space, 9)` and `intercept_` of shape `(n_space,)`. The 9 harmonic
  features, in order (`_create_harmonic_features`, `:143`): `t_glob`,
  annual cos, annual sin, semiannual cos, semiannual sin, then `t_glob`
  times each of those four.
- Useful existing helpers: `_physical_components` (`:784`),
  `_get_point_eof_values` (`:804`), `_get_regional_eof_projection` (`:844`),
  `_weighted_mean_over_region` (`:1105`), `_get_ar6_region_mask` (`:1151`),
  and `geo_data_utils.list_ar6_regions()` (`:487`).
- `pr` generation calls `_load_transform_reference`
  (`meteor_interface.py:1213`), which fetches monthly gridded
  `historical`+`ssp245` and `piControl` composites at **generation** time
  (`:1248`, `:1254`). Its docstring states the timeseries path aggregates
  these per region and uses the 1D transform — so per-region gamma
  parameters can be baked in rather than shipping gridded reference fields.
  Worth confirming.
- `_generate_stochastic_pcs` draws from the global `np.random` state
  (`:669`, `:732`). Replace with an explicit `Generator` before relying on
  seeded reproducibility across languages.
- Serialization: `noise_generator.py:1187` and `meteor.py:691`. Cache naming
  helpers: `cache_handling.py:657` (pattern scaling) and `:691` (noise).
- Tests live in `tests/unit/` and `tests/integration/`, data in
  `tests/test-data/`. Lint is `ruff==0.8.6` plus black/isort/pylint; see the
  `Makefile` for real invocations.
- `mdls.pkl` in the METEOR repo root is not a pickle. It is a 73 KB saved
  Google Drive HTML page, committed by mistake.
- The METEOR repo is ~119 MB (notebooks 72 MB, tests 30 MB). Don't add to it
  casually.

*Estimated, not measured:* a full EOF map bundle at NorESM2-MM resolution
(288×192 = 55,296 gridpoints) would be ~8.8 MB per variable at 40 modes in
float32. Measure a real export rather than trusting this.

## 6. Data storage for the full model list — discussed 2026-09-24

**Decided:** one DOI, deposited once, carrying the expanded model set, and
only after the outstanding issues below are cleared. Seven models are in the
repository now; about 40 CMIP6 models carry the four experiments METEOR needs.

**Sizes, measured on the seven and extrapolated to forty:**

| Tier | Per model | At 40 models |
|---|---|---|
| Bundles (`tas` + `pr`) and `pr` climatology | 0.4–0.6 MB | ~20 MB |
| Pattern artifacts (`tas` + `pr`) | 0.6–4 MB, averaging 2.1 | 90–150 MB |
| Noise artifacts, if that tier ships | ~22 MB | ~900 MB |

**The limits that shape it.** GitHub Pages sites may be at most 1 GB, with a
soft 100 GB a month of bandwidth. Zenodo records take 50 GB and **at most 100
files**, and Zenodo's advice beyond that is to zip. Forty models at five files
each is 200, so the split settled in `data/README.md` — bundles in git,
patterns on Zenodo as loose files — stops working at about twenty models.

**The plan:**

1. **Git keeps NorESM2-MM only**, since the tests and a fresh clone need one
   model to work without a download. Every other model's bundles move to
   Zenodo too; otherwise each re-export adds ~20 MB of history git keeps for
   ever, and at least one is due, from `base` once the METEOR PRs merge.
2. **One zip per model in the deposit**: 40 files, well inside the cap, and a
   new record version whenever models are added or re-exported.
3. **Fetched at build, cached by record version.** A
   `scripts/fetch-artifacts` script unpacks the record into `data/`
   (gitignored); the Pages workflow runs it behind `actions/cache` keyed on the
   version, so an ordinary deploy downloads nothing and visitors are still
   served from the same site. Developers run the same script for every model
   locally.
4. **The model manifest is generated from the files present**, so a clone
   without the download shows NorESM2-MM alone rather than broken entries.
5. **Noise artifacts, if they ship,** go in a separate record, fetched by the
   browser on demand; ~900 MB would not fit the Pages limit. Zenodo's
   fair-use policy objects to splitting one dataset across records to evade
   the size limit; a separate record for a separate tier seems within it, but
   ask them.

**Git history:** ~35 MB of pattern artifacts from the seven models are
already in history. Taking them out of `HEAD` does not shrink it; rewriting
the default branch would. Not worth it at this size — revisit only if the
repository becomes unwieldy.

**Training the remainder:** 3–7 minutes per model in a 4-core, 15 GB cloud
container, 10.5 GB peak, so the rest is about three hours. ~2 GB of CMIP6
download per model: delete each model's cache after export, since
re-training costs minutes. The high-resolution models (EC-Earth3,
CNRM-CM6-1-HR, MPI-ESM1-2-HR) may exceed 15 GB; run them last or on a larger
machine.

### Before the DOI: outstanding issues

- [ ] METEOR #104, #102, #101 merged, then everything re-exported from
      `base` — so the deposit traces to merged code.
- [ ] CMIP7 data terms confirmed (§4): the embargo note against the open
      record and its licence.
- [x] CMIP7 attribution on the page, as the licence requires. Added
      2026-09-25.
- [ ] CMIP6 data citations: each model's data citation (the CMIP6 terms of
      use require citing the data used) in the deposit metadata and on the
      page.
- [ ] The storage pipeline above built and proven end to end with the seven
      models, before anything is deposited.
- [x] Region averaging settled (2026-09-26): AR6 land regions over land
      (land fraction > 0.5), ocean and mixed regions (MED, CAR, SEA) over all
      points, cities at the nearest land gridbox, drawn regions over land with
      a switch — as the AR6 Atlas. `scripts/landmask.py`, applied at export
      by wrapping METEOR's two location-weight helpers; the proper home is an
      option in METEOR itself.
- [ ] The forty-model run: 23 done (2026-09-26, on `data-staging`); 11 need a
      32 GB machine, 6 need METEOR fixes. See
      [`05-training-run.md`](05-training-run.md).
- [ ] The remaining ~33 models trained, once, from `base`, straight into the
      deposit.
- [ ] The model menu grouped for forty entries — by modelling centre or by
      climate sensitivity.
- [x] Drawn regions across the date line. Fixed in #4.
- [x] Map zoom on phones: pinch and double-tap. Fixed in #4.
- [ ] Missing `favicon.ico` (a 404 on every visit; harmless).
- [ ] Announcing the site — removing `robots.txt` and the `noindex` tag — once
      the above is done.

## 7. Resuming

Read this file, then `01-unblock-meteor-export.md`. If the METEOR branch has
not been done yet, that prompt is the next action and it needs a session with
push access to `benmsanderson/METEOR`. If it has, the next action is the
meteor-view generation kernel, driven by the bundle schema that branch
produced.
