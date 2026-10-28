# Handoff, 2026-10-28

Written when the project moved to a new account. Read this first;
[`04-status.md`](04-status.md) and the earlier documents are history, kept for
the reasoning behind decisions, but their "next steps" are mostly done.

## Where things stand

The explorer is **live** at <https://benmsanderson.github.io/meteor-view/>,
deployed from the default branch `claude/youthful-brahmagupta-la5z3o` by
`.github/workflows/pages.yml`. It is still **unlisted**: `public/robots.txt`
and the `noindex` meta tag in `index.html` keep it out of search. Removing both
is the whole of announcing it.

Every pull request up to #24 is merged; none is open. The default branch is at
`48d93f1` (merge of #24). 405 tests pass and the production build succeeds.

What the site does:

- **Two views.** The bare URL opens the *simple* view, for a general audience:
  the spread across all models for a variable, a place and some scenarios,
  precomputed at build time. The *expert* view (`?view=expert`, or any link
  from before the simple view existed) runs one model's emulator in the
  browser, with realizations, seeds, baselines, scenario or model comparison
  and maps. State round-trips through the URL (`src/app/state.js`).
- **Variables:** temperature, precipitation, heating and cooling degree days
  (bias-corrected against W5E5 by delta change, cities and AR6 regions only),
  and **crop yields** for maize, rice, soy and wheat.
- **29 CMIP6 models**, 15 scenarios (8 CMIP6 SSPs, 7 CMIP7 markers),
  311 places (global, 58 AR6 regions, 252 cities) plus drawn regions.
- **Multi-model mean** in the expert model menu, precomputed in
  `data/summary_v1/expert/`.

## Data and where it comes from

| What | Where | Built by |
|---|---|---|
| Model bundles, patterns, climatologies | GitHub release `artifacts-2026-10-09`, pinned by SHA-256 in `data/artifacts_v1.json`, fetched by `scripts/fetch-artifacts.mjs` | METEOR `base` `ce9ecb0`, `scripts/package_artifacts.py` |
| Simple-view and multi-model-mean summaries | `data/summary_v1/` (~200 MB, not committed; built and cached in CI) | `npm run summary` (`scripts/build-summary.mjs`), ~17 min with crops; skips itself on a content hash |
| Degree-day curves | `data/degree_days_v1/` | `scripts/make_degree_day_curves.py` (raw W5E5 deleted after) |
| Crop emulators | `data/crops_v1/`, 10 MB, GGCMI Phase 2 reduced to the 2° grid | `scripts/make_crop_coefficients.py` |
| CO₂ per scenario, for crops | `data/scenario_co2_v1.json` | `scripts/make_scenario_co2.py` (CICERO-SCM) |

`data/README.md` has the detail. Use `package_artifacts.py --provisional` only
for exports from unmerged METEOR code.

Excluded or failing models: IPSL-CM6A-LR is left out (its fits are unstable
between trainings). AWI-CM-1-1-MR, EC-Earth3, EC-Earth3-Veg, TaiESM1 and six
others fail to train in METEOR
([METEOR#106](https://github.com/benmsanderson/METEOR/issues/106)).

## Crop yields: decisions already made

Agreed with Ben; don't revisit without asking.

- GGCMI Phase 2 emulators, rainfed, weighted by MIRCA2000 rainfed harvested
  area, change from 1980–2010, with the CO₂ effect, **no adaptation** (the A1
  emulators are not downloaded; a switch is a possible follow-up).
- **Nitrogen** is uniform: 100 kg/ha by default; the expert view offers 10, 60,
  100 or 200. CARAIB, JULES and PROMET have no nitrogen dependence. Proper
  nitrogen is a known future issue.
- Simple view: spread over every pairing of climate model and crop model.
  Expert view: one climate model at a time, crop models stand in for
  realizations; the multi-model mean is precomputed at 100 kg/ha only.
- Inputs are clamped to the emulators' range (CO₂ 360–810 ppm, ΔT −1 to +6 °C,
  precipitation ratio 0.5–1.3). **The bend in SSP5-8.5 curves around 2080 is
  CO₂ hitting 810 ppm**, a limit of the emulators, not a bug.
- Known problems are written up in
  [METEOR#111](https://github.com/benmsanderson/METEOR/issues/111).

## Known problems, not fixed

- At a few very dry cities (Abu Dhabi, Doha, Riyadh, Karachi) some models'
  forced 1850–1900 precipitation is ≤0, so percentage change is NaN and the
  simple view loses its 95% bound.
- METEOR's degree-day formula has a spread bug (coefficients 0.29/0.664 and
  a = 1.698·√N instead of Erbs et al.'s 0.0290/0.0664 and 1.698); the site
  does not use it. Filed as
  [METEOR#107](https://github.com/benmsanderson/METEOR/issues/107).

## Possible next steps (none started)

- Split `summary_v1/expert/crops_<place>.json` per crop, cutting what a viewer
  fetches by four.
- An adaptation (A1) switch for crops: needs the A1 coefficients and ~10 MB.
- Zenodo deposit of the artifacts, then announcing the site. A DOI cannot be
  retracted, so only with an explicit go-ahead.
- METEOR v2 (multivariate noise) with IAM-FIRE as its first consumer: scoped in
  `docs/multivariate_noise_scoping.md` on METEOR's `meteor-mv` branch
  (`ecf4c32`). Before building, check CMIP6 availability of `hurs`, `rsds` and
  daily `pr` for the site's models.

## Working on the CICERO machine

256 cores, 2 TB RAM; everything lives under `/storage/no-backup-nac/users/bensan`.
Home is a 21 GB NFS mount, so keep caches on `/storage`.

- **`../METEOR`, next to this checkout, is Ben's own working copy** (branch
  `paper16revision`, uncommitted work). Never check out, edit or commit there.
- `../meteor-work/` holds everything else: `METEOR-base` (clone of `base`),
  `METEOR-mv` (worktree on `meteor-mv`), `venv` (Python 3.12.3, pinned
  libraries), `cache-base/NorESM2-MM` (kept to regenerate test fixtures with
  `make_ensemble_reference.py` and `make_pattern_reference.py`), `crops/`
  (GGCMI, MIRCA and W5E5 inputs), `release-2026-10-09/`, `excluded-IPSL/`,
  and `base-one.sh` (re-export of one model; 29 in parallel took ~3.5 h,
  CNRM-CM6-1-HR peaks at 86 GB). `notes-2026-10-09.md` is that release's notes.
- The exporter needs `ATLAS_LANDMASK=../meteor-work/Atlas/land_sea_mask_1degree.nc4`
  for CAS-ESM2-0, NESM3, MCM-UA-1-0 and KACE-1-0-G.
- Node, in every shell:
  `source /etc/profile.d/z00_lmod.sh; module load nodejs/20.13.1-GCCcore-13.3.0`.
  `npm ci` skips rolldown's native binding here; fix with
  `npm install --no-save @rolldown/binding-linux-x64-gnu@1.2.9`.
- `training-logs/` in this checkout is untracked output from the model runs.

## How Ben works

- Work on a new branch from the default branch and open a PR against it. Each
  PR targets the default branch, not a previous PR's branch (stacked merges
  went wrong in #10). If a chain must be stacked, merge the last one with a
  merge commit so the earlier ones close.
- **Ask before merging a PR, and before deleting anything** (branches, files,
  caches, releases).
- Verify UI changes in a browser before calling them done; headless
  Playwright against `npx vite` works on this machine.
- Writing style throughout the code and docs: plain, short sentences that say
  why, not just what.

## Housekeeping left over

Old remote branches can be deleted (ask Ben first; he may prefer to do it):
`claude/branding`, `claude/cities`, `claude/crop-expert`, `claude/crop-yields`
(carries a stray duplicate commit `3b49879`, harmless),
`claude/data-cache-busting`, `claude/degree-days`, `claude/expert-cities`,
`claude/fervent-einstein-jw4y40`, `claude/large-model-run`,
`claude/multi-model-mean`, `claude/place-search`, `claude/reexport-from-base`,
`claude/release-artifacts`, `claude/scenario-names`, `claude/simple-layout`,
`claude/simple-mode`. Check `data-staging` and `feat/browser-explorer` are
unneeded before removing them.
