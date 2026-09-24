# Data

Two kinds of file live here, and the distinction matters.

## Committed: emulator artifacts

`meteor_*_bundle_v1.nc`, `meteor_*_pattern_v1.nc`, `meteor_*_golden_*.nc`

METEOR output, derived from CMIP6 (NorESM2-MM). Small, same-origin, versioned
with the client that reads them. Regenerate with `scripts/export_bundles.py`;
`docs/03-roadmap.md` records the plan to move them to a Zenodo deposit once the
schema settles.

`ar6_regions_v1.json` — AR6 reference region outlines, simplified from
`regionmask`, via `scripts/export_regions.py`. Cite Iturbide et al. (2020),
[Earth Syst. Sci. Data 12, 2959–2970](https://doi.org/10.5194/essd-12-2959-2020),
not this repository.

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
