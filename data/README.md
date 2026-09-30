# Data

Two kinds of file live here, and the distinction matters.

## Where each file lives

Settled 2026-09-29 (`docs/00-development-plan.md` §6), replacing the split of
2026-09-24:

- **Committed here**: the default model, NorESM2-MM, with its golden
  fixtures; region outlines, coastlines, scenario emissions; and
  `artifacts_v1.json`, which pins the release below. A fresh clone works with
  no download, showing NorESM2-MM alone.
- **A GitHub release, one zip per model, fetched at build time**: every other
  model's bundles, pattern artifacts, `pr` climatology and land fraction.
  `node scripts/fetch-artifacts.mjs` downloads the zips, checks each against
  the SHA-256 in `artifacts_v1.json`, unpacks them here (gitignored), and
  writes `models_v1.json` from the models present. Both workflows run it
  before testing, behind a cache keyed on `artifacts_v1.json`. Visitors are
  served the files same-origin from Pages, one model at a time, exactly as
  before. The zips never reach a browser.
- **Noise artifacts, if that tier ships**: about 22 MB per model, too heavy to
  bake into every deploy, so they would be fetched in the browser on demand
  from a separate store.

The current release,
[`artifacts-2026-09-28`](https://github.com/benmsanderson/meteor-view/releases/tag/artifacts-2026-09-28),
is **provisional**: 30 models exported from METEOR `b02011b`, before
METEOR#101, #102 and #104 merge. Once they do, everything is re-exported from
`base` into a new release, and `artifacts_v1.json` is updated to point at it.
A citable Zenodo record can later archive the same zips; the pipeline only
needs `base_url` changed.

To publish a new release: zip each model's `meteor_<model>_{tas,pr}_{bundle,pattern}_v1.nc`,
`meteor_<model>_pr_climatology_v1.nc` and `meteor_<model>_landfrac_v1.nc` as
`meteor_<model>_v1.zip`, attach them to a release, and record the tag, each
zip's size and SHA-256, and its member files in `artifacts_v1.json`.

`summary_v1/`, generated, gitignored: the simple view's spread across models,
one JSON file per place, written by `scripts/build-summary.mjs` from whatever
models are present. `npm run build` and `npm run dev` run it first; it is
skipped when nothing has changed.

`cities_v1.json`, committed: the simple view's 252 cities, every national
capital of more than 500,000 people and every other city of more than 2.5
million, from Natural Earth's populated places (public domain), grouped by
continent. Built by `scripts/make_cities.py`. The eight the bundles carry keep
their specifiers; the rest are read from each model's pattern artifacts at
build time, at the nearest gridbox more than half land, as the bundles place
theirs. The expert view offers the eight until the bundles are re-exported
with the rest.

`degree_days_v1/`, committed: observed degree-day curves, the bias
correction for heating and cooling degree days. One JSON file per city (all
252) and AR6 land region, none for the sea or the global mean: for each calendar month,
the heating and cooling degree days (base 18 °C) of the observed 1995–2014
climate under a uniform temperature shift from −15 to +20 °C, in two forms
(`climate`, keeping year-to-year variability, for forced responses; `within`,
keeping only the spread of days within each month, for realizations). Built
once by `scripts/make_degree_day_curves.py` from W5E5 v2.0 daily temperature
(Lange et al. 2021, doi:10.48364/ISIMIP.342217; Cucchi et al. 2020,
doi:10.5194/essd-12-2097-2020), CC BY 4.0; the 5.9 GB of daily data it reads
is not kept. See `src/lib/degree-days.js` for how the site uses them.

## Emulator artifacts

`meteor_*_bundle_v1.nc`, `meteor_*_pattern_v1.nc`, `meteor_*_golden_*.nc`

METEOR output, derived from CMIP6 (the models in `models_v1.json`, which the
fetch script and the exporter maintain and the client builds its model menu
from). Regenerate with `scripts/export_bundles.py`.

`ar6_regions_v1.json` — AR6 reference region outlines, simplified from
`regionmask`, via `scripts/export_regions.py`. Cite Iturbide et al. (2020),
[Earth Syst. Sci. Data 12, 2959–2970](https://doi.org/10.5194/essd-12-2959-2020),
not this repository.

`scenario_emissions_v1.json` — CO2, CH4 and SO2 for all fifteen scenarios,
annual, global, 1990–2100, for the scenario-context figure. Three species of
the forty METEOR carries, rounded to four significant figures: a figure's worth
of data rather than an inventory. The CMIP7 values derive from the ScenarioMIP
release; see below. It is deliberately not offered as a download in the
interface and is not part of the CSV export — though anything a page plots is
visible in a browser's network tab, so this is about not *providing* it as a
product rather than a technical guarantee.

## Not committed: ScenarioMIP-CMIP7 emissions

**This repository does not re-host the ScenarioMIP emissions.** Download them
yourself:

- Portal: <https://scenariomip.apps.ece.iiasa.ac.at>
- Release: [10.5281/zenodo.19825038](https://doi.org/10.5281/zenodo.19825038) —
  `ScenarioMIP_emissions_marker_scenarios_v0.2.xlsx`

Then convert them into METEOR's format, which writes to the gitignored
`scenario-work/`:

```bash
PYTHONPATH=<meteor>/src python scripts/convert_scenariomip.py \
    ~/Downloads/ScenarioMIP_emissions_marker_scenarios_v0.2.xlsx
```

**Where the line falls.** What a committed bundle carries is the *forcing*
CICERO-SCM derives from those emissions — a product of someone else's data run
through a model, several steps from the source and not usable as emissions.
What would cross the line is a tidy CSV of the emissions themselves, which is
why `scenario-work/` is gitignored and nothing under it is ever published.

### What the conversion does

METEOR wants 40 columns of a specific RCMIP text format; the release carries 55
IAMC-style species. The mapping, the unit conversions and the gaps are in
`scripts/convert_scenariomip.py`. Three things are worth knowing:

- **The release starts in 2023**, its harmonization year, despite year columns
  from 2000. Earlier years come from METEOR's own `ssp245` history, so every
  scenario family in the tool shares one history.
- **BC and OC arrive as totals** and METEOR wants biomass burning separately,
  so the total is split by the history's own ratio for that year. Verified: the
  split reproduces the release total to 1e-9, and OC agrees with `ssp245`'s
  *total* to 4% (against 80% if compared to its non-biomass column, which is
  what confirms the release figure is a total).
- **The splice leaves a step.** Sulphate emissions drop 10% from 2022 to 2023,
  because CMIP7 harmonizes to a newer history than the CMIP6 SSPs did. That is
  **0.08 W/m² of sulphate forcing** in one year. It is kept rather than smoothed:
  smoothing would mean CMIP7 and SSP scenarios no longer share an identical
  history, which is a worse trade than one documented discontinuity.

Major species check out against `ssp245` at the 2023 join — CO2 1.01, CH4 0.93,
N2O 0.98, SO2 0.90, NOx 0.87, CO 0.89, NH3 1.01 — differences that reflect the
newer history rather than unit errors. Minor halocarbons diverge much further
(HFC-32 by 19×, because R-32 replaced R-410A after the SSPs were written); they
are small contributors to total forcing.
