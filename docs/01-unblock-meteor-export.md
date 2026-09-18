# Prompt: unblock METEOR for a browser-based tool

Hand the section below to a session working in `benmsanderson/METEOR`
(default branch: `base`). It is written to stand alone.

Context for why this exists: we want a browser-based METEOR explorer hosted
from `benmsanderson/meteor-view` (a github.io site). Training will always
happen offline on a real machine; the web tool only ever needs to *generate*.
The work below is the part that has to happen inside METEOR to make that
possible. It is worth doing on its own merits — the current trained-model
format cannot be loaded by anything except a byte-compatible Python
environment.

---

## Task

Make a trained METEOR emulator portable, so that generation can run outside
the training environment — including in a browser (Pyodide) or a
reimplementation in another language.

Work on a feature branch off `base`. Do not merge to `base`.

### Background you should verify before changing anything

Read these first; the plan below depends on them being true:

- `src/meteor/noise_generator.py:1187` (`MeteorNoiseGenerator.save_model`) and
  `src/meteor/meteor.py:691` (`MeteorPatternScaling.save_model`). Both
  `pickle.dump` a dict of live objects.
- `src/meteor/noise_generator.py:624` (`_generate_stochastic_pcs`) and
  `:698` (`_generate_stochastic_pcs_batched`).
- `src/meteor/noise_generator.py:143` (`_create_harmonic_features`),
  `:784` (`_physical_components`), `:804` (`_get_point_eof_values`),
  `:844` (`_get_regional_eof_projection`),
  `:884` (`generate_regional_mean_realizations`),
  `:1105` (`_weighted_mean_over_region`), `:1151` (`_get_ar6_region_mask`).
- `src/meteor/meteor_interface.py:1213` (`_load_transform_reference`) and
  `:1327` (`_generate_timeseries`).

Two observations motivate the whole task:

1. **The pickles carry live third-party objects.** The noise model pickle
   contains a fitted `statsmodels` VARX *results* object (`varx_results`) and
   an `sklearn.LinearRegression` (`seasonal_model`). Neither is loadable
   without a matching version of the library that wrote it, and
   `load_model` on a user-supplied file is an arbitrary-code-execution path.

2. **Generation needs far less than the pickle stores.** Read
   `_generate_stochastic_pcs`: the entire `varx_results` object is used only
   to pull `params` and `sigma_u`, which reduce to
   - `intercept`, shape `(n_modes,)`
   - `A_matrices`, `lag_order` arrays of shape `(n_modes, n_modes)`
   - `residual_cov` (`sigma_u`), shape `(n_modes, n_modes)`
   - `B_matrix`, shape `(n_modes, n_exog)` — and note the shipped defaults in
     `_get_default_config` set `use_exog='none'` for both `tas` and `pr`, so
     `n_exog` is 0 in the default configuration.

   At the default `n_modes=40, lag_order=2` that is roughly 4,900 floats.

### Stage 1 — a portable emulator artifact (the core deliverable)

Add save/load of trained emulators in a self-describing, non-executable
format. Use netCDF via xarray (the project already depends on it) unless you
find a concrete reason to prefer `.npz`.

- Export **arrays, not objects**: the VARX quantities listed above, the
  seasonal model as plain `coef_` / `intercept_` arrays, `pca.components_`
  (store the physical-units version from `_physical_components()`, or store
  the raw components plus `eof_weights` — pick one and document which),
  `coords`, and the pattern-scaling arrays (`pattern_dict`, `dacanom`,
  `exp_forc_dict`, `exp_list`, `patternflds`, `anom_timescales`).
- Include a **schema version** field and the provenance needed to reproduce
  the artifact: METEOR version, CMIP6 source model, training scenario, the
  full training config dict, and the date.
- Write floats as **float32** in exported artifacts. Keep float64 internally.
- Reconstruct on load into whatever the existing generation code paths need,
  so that `generate_ensemble_outputs` works identically from a loaded
  artifact. Do not reconstruct `statsmodels`/`sklearn` objects — refactor the
  two generation paths to consume plain arrays instead. That refactor is the
  real content of this stage.
- **Keep the existing pickle `load_model` working** for backward
  compatibility with already-trained caches. Only new writes need to use the
  new format. Existing cache-naming helpers are in
  `src/meteor/cache_handling.py:657` and `:691` — extend, don't break them.

Acceptance: a test that trains (or loads a fixture), exports, re-loads into a
fresh object, and generates an ensemble with a fixed seed — and asserts the
result is numerically identical to generating from the in-memory model. Not
"close": identical, since the same arrays drive the same arithmetic.

### Stage 2 — a compact bundle for timeseries-only clients

This is what the web tool actually downloads. The insight is that the
region/point timeseries path never needs the EOF *maps*.

Read `generate_regional_mean_realizations` (`:884`) and confirm: a region-mean
realization is
`seasonal_mean + pcs @ eof_projections`, where `eof_projections` is
`(n_modes,)` and `seasonal_mean` comes from a spatial mean of a *linear*
prediction. Because the harmonic design matrix `X` is identical at every
gridpoint, the area-weighted spatial mean of `X @ coef_.T + intercept_` equals
`X @ mean(coef_) + mean(intercept_)`. So the region-mean seasonal cycle needs
only 9 coefficients plus an intercept per region — not `n_space × 9`.

Verify that equivalence numerically before relying on it, and check how
`_weighted_mean_over_region` handles NaN gridpoints (land/ocean masking may
make the weighted means non-trivial).

Add an export that, for a given emulator and a list of locations (`global`,
the AR6 region codes from `geo_data_utils.list_ar6_regions()`, and arbitrary
lat/lon points), writes:

- the shared VARX arrays (intercept, `A` matrices, `residual_cov`),
- per location: `eof_projections` `(n_modes,)`, `seasonal_coef` `(9,)`,
  `seasonal_intercept` (scalar),
- the region-projected pattern-scaling response needed to reproduce the forced
  term for the timeseries path — work out the minimal form by reading
  `_compute_timeseries_scaling` (`meteor_interface.py:1016`) and
  `MeteorPatternScaling.predict_from_forcing_profile` (`meteor.py:439`),
- for `pr`, the per-region **1D** gamma transform parameters. The docstring of
  `_load_transform_reference` states the timeseries path aggregates the
  reference per region and uses the 1D transform, so these can be baked in
  per region rather than shipped as gridded fields. Confirm this.

Document the layout in `docs/` as a versioned schema. At 40 modes and ~47
locations this should be tens of KB, and that size claim is worth asserting in
a test.

Also emit **golden fixtures**: for a couple of (model, variable, scenario,
region) combinations, a fixed-seed PC sequence and the resulting timeseries,
stored as plain arrays. These are what a non-Python reimplementation gets
validated against, so make the seeding path explicit and reproducible —
note that `_generate_stochastic_pcs` currently uses the global
`np.random` state, which is worth replacing with an explicit
`np.random.Generator` for this purpose.

### Stage 3 — make `pr` generation self-contained (lower priority)

Right now `tas` generation touches no CMIP6 data — `_generate_timeseries`
says so explicitly at `meteor_interface.py:1394`. But `pr` calls
`_load_transform_reference`, which re-fetches monthly gridded
`historical`+`ssp245` *and* `piControl` composites from Google Cloud at
**generation** time (`:1248`, `:1254`) purely to fit the gamma transform.

Move that fitting to training time and store the fitted parameters in the
Stage 1 artifact, so generation needs no network and no `gcsfs`. Preserve
current numerical behaviour — if the fitted parameters depend on the
requested output window (the `pr` first-year-baseline logic suggests they
might), say so clearly in the PR description rather than silently changing
results.

If you run short of time, stop after Stage 2 and leave Stage 3 as a written
follow-up. Stages 1 and 2 are what unblock the tool.

### Constraints

- Do not change default generation behaviour or any existing public signature.
- No new required dependencies. Do not add a dependency to make export
  prettier.
- Follow the repo's existing conventions: numpydoc docstrings, `ruff==0.8.6`,
  `black`, `isort`, `pylint`. Check the `Makefile` for the real invocations
  and run them before pushing.
- Tests go in `tests/unit/` and `tests/integration/` following the existing
  layout. Anything requiring CMIP6 downloads belongs in `integration`.
- Do not commit trained artifacts or fixtures larger than a few hundred KB.
  The repo is already ~119 MB.

### Also worth fixing while you are here

`mdls.pkl` in the repository root is not a pickle. It is a 73 KB saved Google
Drive HTML page ("mdls.pkl - Google Disk"), committed by mistake. Delete it,
or replace it with the artifact it was meant to be.

### Deliverable

A branch with the above, and a PR description that states: the schema and its
version, what is deliberately *not* in the compact bundle (gridded output,
custom emissions scenarios), and the measured size of one exported bundle.
