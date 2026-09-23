# meteor-view

A browser-based explorer for [METEOR](https://github.com/benmsanderson/METEOR),
served as a static site from GitHub Pages. Pick a scenario or draw a global
warming pathway, pick a region or a city, and see an ensemble of monthly
climate projections. There is no server: the emulator runs on your machine.

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
on the model's own 192×288 grid. The year slider moves through 2015–2100.

The map is also the region picker. **Click** an AR6 region to select it.
**Drag** to define a region of your own, anywhere, at any size.

A drawn region shows the **forced response only**: the signal the scenario
drives, with no ensemble around it. That is not a simplification but a limit of
what has been downloaded — internal variability at an arbitrary location needs
the EOF maps from the 11 MB noise artifact, which this page does not load. The
listed places carry their spread precomputed, which is why they keep it.

Validated against METEOR's own gridded prediction: maps agree to 1e-6 relative,
and a box drawn over the Sahara lands within 10% of the AR6 region it
approximates. Two complete maps reconstruct in about 27 ms.

## Sharing and taking the numbers away

Every control — including the drawn pathway and the RNG seed — lives in the
URL, so a view is a link:

```
?v=pr&loc=regional%3ASAS&scn=ssp370&n=50
```

**Copy link to this view** puts that on the clipboard. Opening it reproduces
the chart *exactly*, down to the individual realizations: the seed travels with
it, and a drawn pathway is quantised to 0.01 °C as you draw so that what you
see is precisely what the link encodes. A drawn pathway costs about 230
characters, against the ~500 the same 86 numbers would take as text.

**Download CSV** gives one row per month and one column per realization, with
the provenance — model, scenario, METEOR version, and the link that regenerates
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
  which is not in the bundle. A drawn pathway rescales a bundled scenario's
  forced response rather than running new emissions.
- **Precipitation is 2015–2100 only**, the window its distribution transform was
  fitted for. Another window needs a re-export on the METEOR side.
- **One model.** NorESM2-MM, trained on ssp245.

## Data provenance

The bundles are committed here for now: they are small, same-origin, and
versioned alongside the client that reads them. A permanent Zenodo deposit
follows once the schema has survived contact with a real client — a DOI is a
promise you cannot retract.

Schema v1 is documented in
[`docs/emulator_artifact_schema.md`](https://github.com/benmsanderson/METEOR/blob/integration/meteor-view/docs/emulator_artifact_schema.md)
in the METEOR repository. Every artifact carries its own provenance: METEOR
version, CMIP6 model, training scenario and creation date.
