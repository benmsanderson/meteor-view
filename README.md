# meteor-view

A browser-based explorer for [METEOR](https://github.com/benmsanderson/METEOR),
served as a static site from GitHub Pages. Pick a scenario and a region, and
see an ensemble of monthly climate projections. There is no server: the
emulator runs on your machine.

**Status and what to do next:** [`docs/04-status.md`](docs/04-status.md).
The site is live but deliberately unlisted; the next step is training more
CMIP6 models, which is ready to run.

## How it works

METEOR splits into two jobs with very different costs. **Training** pulls
gigabytes of CMIP6 output from Google Cloud and fits EOFs and a VAR-X noise
model; it takes minutes to hours and will never run in a browser. **Generation**
is comparatively trivial — convolve a step-response kernel with scenario
forcing, simulate a lag-2 VAR on 40 modes, project onto a location.

So the model is trained offline, exported to a compact bundle, and the browser
does the arithmetic. The bundle never carries the EOF *maps*, because a region
mean is a fixed weighted sum and therefore commutes with the linear model:

```
mean_region(X @ coef.T + intercept) = X @ (coef.T @ w) + intercept @ w
mean_region(pcs @ eofs)             = pcs @ (eofs @ w)
```

That turns per-gridpoint fields into about 200 bytes per location. A bundle
covering 67 locations and 8 SSP scenarios is 81 KB for temperature and 216 KB
for precipitation; the whole deployed site, code and data together, is 432 KB.

## Layout

| Path | What it is |
|---|---|
| `src/lib/` | The generation kernel: bundle reading, the maths, the two numerical primitives. Validated against METEOR; change with care. |
| `src/app/` | The explorer: orchestration, canvas charts, UI. |
| `data/` | Emulator bundles and golden fixtures, exported from METEOR. |
| `test/` | The quality gate. See below. |
| `scripts/` | Regenerating the data files and keeping METEOR's integration branch honest. Needs METEOR installed; the client does not. |

## The quality gate

A second implementation of a scientific model is only worth having if it can be
shown to agree with the first. Three layers of test do that, and all of them run
in CI on every push:

1. **Golden fixtures** (`test/golden.test.js`). METEOR ships a fixed-seed PC
   sequence as data, because a JavaScript port cannot reproduce NumPy's PCG64
   stream and does not need to. Feeding those PCs in isolates the deterministic
   parts — seasonal cycle, EOF projection, forced response. Agreement is
   **5e-8 relative**, which is float32 wire precision.
2. **The precipitation transform** (`test/transform.test.js`). A fixture's
   `series` stops short of the two steps unique to `pr`, so fixtures now also
   carry `series_transformed` — the complete recipe, baseline and quantile
   mapping included. Agreement is **2e-7 relative**, again float32 wire
   precision.
3. **The whole pipeline** (`test/explorer.test.js`). The layers above validate
   arithmetic; this validates bookkeeping, by comparing a 100-member ensemble
   against a 200-member reference from
   `MeteorInterface.generate_ensemble_outputs` — its mean, its spread and its
   seasonal cycle. This is the layer that caught the errors that mattered.

```bash
npm test
```

## Developing

```bash
npm install
npm run dev
```

`npm run build` produces `dist/`, which is what Pages serves.

Regenerating the data files needs METEOR itself:

```bash
pip install 'git+https://github.com/benmsanderson/METEOR.git@integration/meteor-view'
```

`integration/meteor-view` is METEOR's development branch for this repository:
exactly `base` plus the three PRs in flight (#104, #102, #101), refreshed as
they move. It is not a merge candidate — the PRs merge into `base`
individually. It exists so work here can proceed before they land; point this
at `base` once they have.

Those PRs will change under review, so keep the branch honest with:

```bash
scripts/refresh-integration.sh --test --push
```

It rebuilds the branch from `base`, then *separately* performs the merge
sequence into a throwaway worktree and asserts the two trees are identical. A
drifted or hand-edited integration branch fails there rather than silently, so
"develop against the integration branch" cannot quietly become "develop against
a fiction".

The exporter depends on `series_transformed` and `locations=`, both added by
[METEOR#101](https://github.com/benmsanderson/METEOR/pull/101).

## Maps and your own regions

**Load map** fetches the 2 MB pattern artifact for the variable in view — never
on first load, since most visits do not need it — and draws the forced response
on the model's own grid. The year slider moves through 2015–2100.

The map is also the region picker. **Drag** pans and the wheel zooms.
**Click** an AR6 region to select it. **Draw region** mode, or shift-drag,
defines a region of your own, anywhere, at any size.

## What a region averages over

As the AR6 WGI Atlas does: the **AR6 land regions over land only** (gridboxes
more than half land, by each model's own land fraction), the ocean regions and
the three mixed ones — Mediterranean, Caribbean, South-East Asia — over every
gridbox, and each **city at the nearest gridbox that is more than half land**.
All means are area-weighted. A **drawn region** averages over land by default,
with a *Land only* switch beside it; over open sea it falls back to every
gridbox and says so.

It matters most on coasts. Measured on CanESM5's own output, averaging over
all points instead of land moved 2015–2034 to 2081–2100 warming by up to
0.5 °C in coastal regions (northern and southern Australia, south-western
Africa), and the land-only emulator lands closer to the model's land-only
warming in 9 of 11 regions tested. Each bundle records the convention it was
exported with, and where its land fraction came from: the model's own `sftlf`,
or, for the few models that publish none, the Atlas's 1° land fraction.

## Comparing scenarios

Tick up to six scenarios. The timeseries overlays them — each scenario's
median and 5–95% band in its own colour, named at the end of its line — run
with the same seed, so the realizations are paired across scenarios.

With two or more ticked, the map becomes four panels: two scenarios chosen
from the selection (A and B), their difference B − A on its own zero-centred
scale, and a readout of all three under the pointer. One year slider and one
view drive all three maps. The difference is of forced responses, so it is
the signal the scenarios separate by, with no internal variability in it.

A drawn region shows the **forced response only**: the signal the scenario
drives, with no ensemble around it. That is not a simplification but a limit of
what has been downloaded — internal variability at an arbitrary location needs
the EOF maps from the 11 MB noise artifact, which this page does not load. The
listed places carry their spread precomputed, which is why they keep it.

Validated against METEOR's own gridded prediction: maps agree to 1e-6 relative,
and a box drawn over the Sahara lands within 10% of the AR6 region it
approximates. Two complete maps reconstruct in about 27 ms.

## Comparing models

**Compare: Models** switches what is compared. Tick up to six models, which
all run one scenario; each gets a colour of its own for as long as it stays
selected. The chart, seasonal panel, maps and CSV then answer per model, and
the maps compare any two of them, as for scenarios.

Two models rarely share a grid, so the difference map puts B onto A's grid by
bilinear interpolation before subtracting, and says so in its caption. The
readout reads A and B each on its own grid, so its difference can differ from
B minus A as read by the interpolation, typically by a tenth of a degree.

Each model is measured from its own baseline. From 1850–1900 the differences
include how differently the models warmed over the historical period; from
2005–2024 that part drops out, leaving their disagreement about the future.
The seasonal panel shows each model's own present-day climate as well as its
future one, since their absolute climates differ by degrees.

## Baselines

Temperature, and both maps, are change from a reference period you choose:
**1850–1900**, the pre-industrial convention warming levels are defined
against, or **2005–2024**, recent history. Either is the model's own forced
response averaged over the period under CMIP7 Medium, shared by every
scenario, so the difference between two scenarios — including the B − A map
— does not depend on the choice.

The switch is also a diagnostic. The seven models warm by between 0.7 °C
(NorESM2-MM) and 1.6 °C (CanESM5) from 1850–1900 to 2005–2024, so measuring
from recent history removes the part of their disagreement about the future
that is inherited from their disagreement about the past.

The precipitation timeseries stays in absolute mm/day: it passes through a
nonlinear distribution transform, so there is no clean reference-period level
to subtract. Precipitation *maps* are percent change from the period, relative
to that period's own precipitation.

## Sharing and taking the numbers away

Every control — including the RNG seed — lives in the URL, so a view is a
link:

```
?v=pr&loc=regional%3ASAS&scn=ssp126,ssp370,cmip7-high&cmp=ssp126,cmip7-high&n=50&ref=recent
```

**Copy link to this view** puts that on the clipboard. Opening it reproduces
the chart *exactly*, down to the individual realizations, because the seed
travels with it.

**Download CSV** gives one row per scenario and month, one column per
realization, with the provenance — model, scenarios, METEOR version, and the link that regenerates
it — as `#` comment lines that `pandas.read_csv(..., comment='#')` will skip.

**Download chart** writes a PNG with an opaque background, a title and that
same provenance, because a transparent unlabelled chart is a poor thing to
paste into a document.

**Draw a new sample** re-rolls the seed. Nothing else changes, which is the
quickest way to see that no single realization means anything on its own.

## Where this is going

[`docs/03-roadmap.md`](docs/03-roadmap.md) lays out what is next and what
blocks it. The short version: the tool draws the spread from a **single
model**, which is internal variability rather than projection uncertainty, and
closing that gap — by adding CMIP6 models, and by saying so plainly in the
interface until then — is the most important thing left.

## Limits worth knowing

- **No maps.** Bundles carry no gridded output; reconstructing fields needs the
  full artifacts, which are a different and much larger format.
- **No custom emissions.** Turning emissions into forcing needs CICERO-SCM,
  which is not in the bundle, so the scenarios on offer are the ones it was
  built with. `scaleToWarmingPathway` in the kernel can drive the emulator from
  a prescribed global warming trajectory instead — validated against METEOR,
  and the hook a CMIP7 scenario preset would use — but nothing in the interface
  exposes it.
- **Precipitation is 2015–2100 only**, the window its distribution transform was
  fitted for. Another window needs a re-export on the METEOR side.
- **Seven models.** NorESM2-MM, CanESM5, INM-CM5-0, IPSL-CM6A-LR, MIROC6,
  MPI-ESM1-2-LR and MRI-ESM2-0, each trained on ssp245. Up to six can be
  compared side by side; each band is one model's internal variability, and
  no combined across-model spread is drawn.
- **Two scenario generations, not interchangeable.** The eight CMIP6 SSPs and
  the seven CMIP7 ScenarioMIP markers were built years apart against different
  vintages of history. Both are driven through the same simple climate model
  here, which is what makes comparing them meaningful; see
  [`data/README.md`](data/README.md) for how the CMIP7 forcing is derived and
  why the emissions behind it are not in this repository.

## Data provenance

The bundles are committed here for now: they are small, same-origin, and
versioned alongside the client that reads them. A permanent Zenodo deposit
follows once the schema has survived contact with a real client — a DOI is a
promise you cannot retract.

Schema v1 is documented in
[`docs/emulator_artifact_schema.md`](https://github.com/benmsanderson/METEOR/blob/integration/meteor-view/docs/emulator_artifact_schema.md)
in the METEOR repository. Every artifact carries its own provenance: METEOR
version, CMIP6 model, training scenario and creation date.
