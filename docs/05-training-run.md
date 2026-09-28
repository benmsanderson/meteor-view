# The forty-model training run, 2026-09-26

What was run, what worked, what did not and why, and a draft issue for METEOR
covering the failures that are METEOR's to fix.

## What was run

All 40 CMIP6 models that carry monthly `tas` and `pr` for `piControl`,
`abrupt-4xCO2`, `historical` and `ssp245` in the Pangeo CMIP6 cloud archive,
trained and exported one at a time with `scripts/train-models.sh`
(`CLEAN_CACHE=1`) in a 4-core, 15.7 GB cloud container, from METEOR
`integration/meteor-view` at `b02011b` — verified by
`scripts/refresh-integration.sh` to be exactly `base` plus #104, #102 and
#101. Region averaging as the AR6 Atlas (`scripts/landmask.py`; see README,
*What a region averages over*).

Models took 2–9 minutes each. The artifacts are on the `data-staging` branch,
which is not for merging: it holds them until the Zenodo deposit and the
build-time fetch replace it (`00-development-plan.md` §6).

## Result: 23 of 40

Every one passes its golden fixtures against the JavaScript kernel, no bundle
carries NaN, and the warming they give is in the order the models'
sensitivities predict.

| Model | 2081–2100 warming vs 1850–1900, ssp245 | Land fraction |
|---|---:|---|
| MIROC6 | 2.14 °C | sftlf |
| GFDL-ESM4 | 2.15 | sftlf |
| INM-CM5-0 | 2.20 | sftlf |
| INM-CM4-8 | 2.22 | sftlf |
| MPI-ESM1-2-LR | 2.28 | sftlf |
| MIROC-ES2L | 2.36 | sftlf |
| MRI-ESM2-0 | 2.57 | sftlf |
| FGOALS-f3-L | 2.63 | sftlf |
| NESM3 | 2.64 | Atlas 1° |
| BCC-CSM2-MR | 2.66 | sftlf |
| MCM-UA-1-0 | 2.75 | Atlas 1° |
| GFDL-CM4 | 2.85 | sftlf |
| CNRM-ESM2-1 | 2.86 | sftlf |
| ACCESS-ESM1-5 | 2.93 | sftlf |
| CNRM-CM6-1 | 2.96 | sftlf |
| GISS-E2-1-G | 3.03 | sftlf |
| CAS-ESM2-0 | 3.17 | Atlas 1° |
| ACCESS-CM2 | 3.18 | sftlf |
| IPSL-CM6A-LR | 3.35 | sftlf |
| HadGEM3-GC31-LL | 3.49 | sftlf |
| UKESM1-0-LL | 3.80 | sftlf |
| KACE-1-0-G | 3.81 | Atlas 1° |
| CanESM5 | 4.06 | sftlf |

## The 17 that failed

### Eleven exceed 15 GB — run on a larger machine, 2026-09-28

CESM2, CESM2-WACCM, CMCC-CM2-SR5, CMCC-ESM2, TaiESM1, **NorESM2-MM**,
AWI-CM-1-1-MR, MPI-ESM1-2-HR, EC-Earth3, EC-Earth3-Veg, CNRM-CM6-1-HR: the grids
of about 1° and finer. In the 15.7 GB container, noise training was killed by
the kernel with no Python error.

Rerun as in [`06-handover-large-models.md`](06-handover-large-models.md) on a
256-core, 2 TB machine, all eleven at once, each in its own process and cache,
same METEOR commit and library versions (Python 3.12.3 rather than 3.11).
Peak memory is `/usr/bin/time -v`'s maximum resident set size.

**Seven succeeded** and are on `data-staging`, which now lists 30 models with
NorESM2-MM first. All pass their golden fixtures and `check-exports.mjs`
(land-masked from their own `sftlf`, no NaN):

| Model | ssp245 2081–2100 warming | Peak memory | Time |
|---|---:|---:|---:|
| NorESM2-MM | 2.13 °C | 15.4 GB | 4 min |
| MPI-ESM1-2-HR | 2.24 | 20.3 | 9 |
| CESM2-WACCM | 3.09 | 15.5 | 4 |
| CESM2 | 3.29 | 18.7 | 8 |
| CNRM-CM6-1-HR | 3.54 | **69.7** | 16 |
| CMCC-ESM2 | 3.79 | 15.5 | 4 |
| CMCC-CM2-SR5 | 3.80 | 15.5 | 5 |

NorESM2-MM's global warming is unchanged by the land masking, as it should be.
The 32 GB the handover asked for is not enough for the finest grids:
CNRM-CM6-1-HR needs 70 GB, and EC-Earth3 reached 40 GB before failing.

NorESM2-MM's re-export also replaces its copy on the default branch, with new
golden fixtures and a regenerated `test/fixtures/ensemble_reference.json`. That
end-to-end test compares the site against METEOR's own
`generate_ensemble_outputs`, which averages over all points, so after the land
masking it failed at NEU and Mumbai (whose nearest NorESM2-MM gridbox is 10%
land) by the masking alone. It now uses MED, a mixed region averaged over all
points by both, and Beijing, whose nearest gridbox is land; the land-masked
arithmetic is what the golden fixtures cover.

**Four failed in METEOR, not for memory** (peaks 9–40 GB on a 2 TB machine),
so they join the six below:

| Model | Peak | Failure |
|---|---:|---|
| AWI-CM-1-1-MR | 9.4 GB | `tas` noise fit: `Input y contains NaN` |
| EC-Earth3 | 40.3 GB | `pr` pattern fit: `KeyError: 'outp'` |
| TaiESM1 | 15.5 GB | `pr`: piControl baseline `0.000`, then `Gamma distribution requires positive data` |
| EC-Earth3-Veg | 35.8 GB | the same as TaiESM1 |

### Ten are METEOR's to fix

Four are time axes METEOR does not expect, four are NaN that METEOR itself
introduces — the archive data has none — and two are a zero precipitation
baseline. The draft issue below (filed as
[METEOR#106](https://github.com/benmsanderson/METEOR/issues/106)) has the
first six; the addendum after it, the four from the larger machine.

## Draft issue for METEOR

> **Training fails for six CMIP6 models: unexpected time axes, and NaN from
> joining experiments of different lengths**
>
> Training `MeteorInterface(model, ["tas", "pr"])` on the 40 models in the
> Pangeo CMIP6 archive with monthly `tas` and `pr` for `piControl`,
> `abrupt-4xCO2`, `historical` and `ssp245` (METEOR `base` + #104, #102, #101)
> fails for six of them for reasons in the data getter or the experiment
> join, not in the models.
>
> **1. Scenario runs that do not end in December 2100.**
> `noise_generator.fit` raises `custom_global_temp length (3012) must match
> data time dimension (N)`. The trajectory is 1850–2100 (3012 months), but the
> historical + ssp245 series is joined by index (`decode_times=False`, overlap
> trimmed by count), so its length is whatever the stores hold:
>
> | Model | Member | historical | ssp245 | Joined |
> |---|---|---|---|---:|
> | CAMS-CSM1-0 | r1i1p1f1 | 1850-01 – 2014-12 | 2015-01 – **2099-12** | 3000 |
> | IITM-ESM | r1i1p1f1 | 1850-01 – 2014-12 | 2015-01 – **2099-12** | 3000 |
> | FGOALS-g3 | r1i1p1f1 | 1850-01 – **2016-12** | 2015-01 – 2100-12 | 3036 |
> | GISS-E2-1-H | r1i1p1f2 | 1850-01 – 2014-12 | 2015-01 – **2500-12** | 7812 |
>
> *Suggested fix:* in `cmip6_meteor_data_getter`, decode times and select by
> date — historical to 2014-12, the scenario 2015-01 to 2100-12 — rather than
> by index. For runs that end in 2099, either end the trajectory with the data
> or skip the model with a clear message; padding a year would invent data.
>
> **2. NaN from joining experiments of different lengths.**
> `noise_generator.fit` raises `Input y contains NaN` for KIOST-ESM and
> NorESM2-LM, whose archive data contain no NaN in any of the four experiments
> for `tas` or `pr` (checked on every value). The likely source is
> `meteor.py:123`, which concatenates the experiments along `expt` with
> xarray's default outer join on `year` (the run logs carry the matching
> `FutureWarning`), so an experiment longer than the others is padded with NaN:
> KIOST-ESM's `abrupt-4xCO2` is 151 years (1812 months) against the 150 years
> `piControl` is cut to. NorESM2-LM logs a `piControl` precipitation baseline
> of exactly `0.000`, which suggests its `piControl` is missing or empty after
> `mdl_skipmbrs` skips `r1i1p1f1` (whose ssp245 time axis is also garbled in
> the archive: 2031-01 … 2030-12). *Not confirmed by stepping through;
> hypotheses from the logs and the archive.*
>
> *Suggested fix:* join with `join="inner"` or trim every experiment to a
> common length before concatenating, and raise if a required experiment is
> empty rather than carrying zeros forward.

### Addendum for #106: four more from the 1° grids, 2026-09-28

> Four of the eleven finer-grid models fail the same way once memory is not
> the limit. Their archive data carry no NaN in the first 100 years of any
> experiment; what stands out is the time axes (first member of each
> experiment, which may not be the one METEOR picks):
>
> | Model | Failure | Archive |
> |---|---|---|
> | AWI-CM-1-1-MR | `tas` noise fit: `Input y contains NaN` | `abrupt-4xCO2` 151 years, as KIOST-ESM; `tas` `historical` starts 1851-01; `tas` `ssp245` r1i1p1f1 covers only 2028-01 – 2065-12 |
> | EC-Earth3 | `pr` pattern fit: `KeyError: 'outp'` at `meteor.py:473` | `abrupt-4xCO2` r3i1p1f1 160 years; `historical` r101i1p1f1 only 1970–2014 |
> | TaiESM1 | `pr` piControl baseline logged as `0.000`, then `Gamma distribution requires positive data` | `piControl` dated 0201–0700, `abrupt-4xCO2` 0001–0150; values normal (2.9e-5 kg m⁻² s⁻¹) |
> | EC-Earth3-Veg | as TaiESM1 | `piControl` 2000 years, 1850–3849; values normal |
>
> The EC-Earth3 error is the NaN again, surfacing elsewhere:
> `_make_pattern_dict` silently skips an experiment whose first 100 years of
> anomaly contain NaN (`meteor.py:376`), and `_add_patterns_for_residual_exp`
> then looks up its missing `outp`. The zero baselines look like a date-window
> selection on `piControl` that comes back empty and is averaged to zero.
> *Hypotheses from logs and archive, not confirmed by stepping through.*
>
> *Suggested fix, beyond the above:* raise in `_make_pattern_dict` rather than
> skipping, naming the experiment; and select the `piControl` baseline by
> position (first N years) rather than by calendar date.
