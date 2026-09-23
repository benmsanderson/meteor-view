# meteor-view: development plan

A browser-based tool for running [METEOR](https://github.com/benmsanderson/METEOR),
served as a static github.io site from this repository.

**Status:** built. The METEOR-side work in
[`01-unblock-meteor-export.md`](01-unblock-meteor-export.md) is done
(benmsanderson/METEOR#101, plus #102 and #104, merged on the integration branch
`integration/meteor-view`). The client is done: a validated JavaScript kernel,
the fixtures wired into CI, and a Pages deploy. See
[`02-client-findings.md`](02-client-findings.md) for what the port had to infer
that the schema did not state — the most useful feedback METEOR can get from
this exercise, because it is what the next port would also get stuck on.

Remaining: the three METEOR PRs are unmerged, so the bundles here were exported
from an integration branch that will drift as they take review. Re-export from
`base` once they land. The Zenodo deposit is still pending, deliberately.

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
to. So the browser knob becomes *pick or draw a warming pathway*, and no SCM
is needed client-side at all. Full custom-emissions runs stay a
server/Colab feature.

Cost: a second implementation of the generation maths, which must be
validated against Python by golden fixtures. That risk is why the fixtures
are a required deliverable, not a nice-to-have.

### C. Server

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
- **Audience — still open.** Climate scientists (who would mostly rather have
  Colab) or impact/policy users (who need point-and-click)? Track 1 covers the
  former cheaply, which is part of why it was first. The built explorer leans
  towards the latter.
- **Gridded maps in the browser — still open, still the one output that forces
  a server.** Reconstructing 100 realizations × 3012 months × ~55k gridpoints
  is not a client-side operation. If maps are essential, architecture C moves
  up the list.
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

## 6. Resuming

Read this file, then `01-unblock-meteor-export.md`. If the METEOR branch has
not been done yet, that prompt is the next action and it needs a session with
push access to `benmsanderson/METEOR`. If it has, the next action is the
meteor-view generation kernel, driven by the bundle schema that branch
produced.
