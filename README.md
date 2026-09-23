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
