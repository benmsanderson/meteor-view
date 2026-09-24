# Roadmap

Where meteor-view goes next. [`00-development-plan.md`](00-development-plan.md)
records *why* the architecture is what it is; this records what is left.

Effort figures are rough and are mine, not measured. Sizes are measured.

## Who this is for — decided

**Scientists from adjacent fields who want a rapid climate assessment.** Not
climate modellers: they will clone the repo and run METEOR properly. Not the
general public either. The people in between — impacts, hydrology, ecology,
health, energy, economics — who need credible regional climate information now
and cannot wait for an ESM ensemble.

The sharpest version of that need, and the one worth designing towards:
**scenarios that most ESMs have not run yet.** CMIP7 scenarios exist as
emissions pathways long before the model output does. An emulator trained on
CMIP6 can answer questions about them immediately. That is something this tool
can do that almost nothing else can, and it reframes several items below.

Consequences:

- **Driving from a prescribed warming trajectory** is core, not a novelty: it
  is the mechanism by which a user asks about a future nobody has simulated.
  The freehand *drawing* interface for it has been removed — it invited
  arbitrary curves where the real demand is for published pathways — but
  `scaleToWarmingPathway` remains in the kernel, validated, as the hook a CMIP7
  scenario preset plugs into.
- **Custom regions and points** matter more than a curated list of 67. An
  ecologist's study area is not an AR6 region.
- **Model uncertainty** is not optional for anything called an assessment.
- The audience reads error bars for a living, so the interface can be honest
  and technical rather than protective.

---

## Maps do not need a server

The plan claimed gridded output forces a server. That claim was about
reconstructing every realization × every month × every gridpoint, which is what
METEOR's gridded path does. **It is not what a map view needs**, and the
distinction is worth several megabytes and an entire architecture.

Measured, NorESM2-MM `tas`, float32 (gzip saves under 10% — float32 is
high-entropy, so compression is not a lever here):

| Tier | Extra download | Unlocks |
|---|---:|---|
| Timeseries (today) | — (297 KB total) | 67 fixed locations |
| **Pattern artifact** | **2.0 MB** | Forced-response maps; custom regions and points, forced response |
| Noise artifact | 11.3 MB | Internal variability anywhere: custom regions/points with spread, single-realization maps |

The arithmetic for the 2 MB tier is the convolution the client already does —
the only change is projecting onto `pattern_v (exp, fld, 3, 192, 288)` instead
of the precomputed `pattern_projection`. Three pattern modes over 55,296
gridpoints is ~166k multiply-adds per experiment per timestep: nothing.

A single realization's map costs `pcs(40) @ eof_components(40, 55296)`, about
2.2M operations per map — also nothing per map. What is genuinely infeasible is
*all* realizations × *all* months at once, and no map view asks for that.

So the honest position is: **forced-response maps and custom locations are a
2 MB download away**, and full internal variability anywhere is 13 MB. A server
is still the answer for custom *emissions* (needs CICERO-SCM), and nothing else.

---

## Done

Custom regions and forced-response maps (the 2 MB pattern tier), CMIP7
scenarios by Route C, shareable links and CSV/PNG export, and the
scenario-context figure. Details are below under their original entries.

## Now — agreed order

### 1. The map: coastlines, zoom and pan, discrete colours

**Two to three days.** Design settled 2026-09-24; what follows is decided, not
proposed.

**Coastlines.** `regionmask.defined_regions.natural_earth_v5_0_0.land_110`,
simplified at **0.2°** — measured at 122 KB of GeoJSON, against 70 KB at 0.5°
which looks ragged. Same export route as the AR6 outlines, no new dependency,
Natural Earth is public domain.

**Gestures: mode buttons, with a modifier for experts.** Two controls on the
map, pan and select, wheel to zoom, and shift-drag doing whichever the active
mode is not. Chosen over the web-map convention (drag pans, shift-drag draws)
because drawing a region is a headline feature here and would become invisible,
and because modifier-only designs are poor on touch.

```
[ pan ] [ select ]              scroll to zoom
select mode:  drag = draw region,  shift-drag = pan
pan mode:     drag = pan,          shift-drag = draw
```

**Fixed colour classes, from the AR7 colormaps.** Eleven classes sampled from
the IPCC AR7 WGI diverging colormaps — the same source as the published
figures, so a map from here sits beside them:

| | |
|---|---|
| Temperature (`temp_div`) | `#053061` … `#f9f8f8` … `#67001f` |
| Precipitation (`prec_div`) | `#543005` … `#f8f8f8` … `#003c30` |

Bin edges are **published and fixed** — the same at every year, scenario and
model — with out-of-range values shown by triangles on the bar. This fixes a
real flaw rather than adding polish: the scale currently recomputes per year,
so 2030 renders as red as 2100 and the year slider silently rescales under the
reader. It is also the only option under which the planned difference map means
anything.

**Precipitation as percent change.** The IPCC convention for maps, and the only
readable one: 0.2 mm/day is negligible in the tropics and transformative in a
desert, so an absolute map mostly shows where it already rains. The timeseries
panel stays in mm/day, which is a deliberate divergence worth a note in the UI.

This needs a denominator the map tier does not currently carry: a gridded
precipitation climatology. It is available at export time — the first-year mean
field that `_load_transform_reference` already computes for the gamma fit — and
costs about 220 KB at float32, fetched alongside the pattern artifact.

### 2. Other ESMs, and settle where data lives

**A day of client work per batch, plus training; the storage decision is the
real content.**

Better news than expected on feasibility. METEOR needs only **piControl,
abrupt-4xCO2, historical and one SSP** — `sulxanom`, the aerosol axis, is not a
separate experiment but the scenario run reused
(`cmip6_meteor_data_getter.py`: `training_data["sulxanom"] = training_data[scenario_train]`).
Those are among the most widely available CMIP6 experiments, so the binding
constraint is download and fit time on your machine, not which models ran an
exotic perturbation.

The client side is nearly free: a bundle records its own `cmip6_model` and the
loader already keys off it. What needs deciding is storage, because this is
what forces it:

| per model | committed today |
|---|---:|
| `tas` + `pr` bundles | ~355 KB |
| `tas` + `pr` pattern artifacts | 4 MB |
| noise artifacts, if the 11 MB tier ever ships | 23 MB |

Five models is 20 MB of pattern artifacts before the noise tier is considered,
and git keeps every version of each forever. The tiered answer from the open
decisions below is the one to take: keep the small bundles committed so the
default view stays instant and offline, and fetch the multi-megabyte artifacts
from a Zenodo deposit on demand. That also gives the artifacts a DOI, which
they should have anyway.

Worth settling in the same breath: whether the model picker offers models
individually, shows across-model spread, or both. The second is what turns the
tool from "one model's variability" into something that represents projection
uncertainty honestly.

### 3. Compare two scenarios at once

**Three to four days, and the most UI-heavy item here.**

Two scenarios selected together, and every panel answers for both:

- **Line plots.** Two ensembles overlaid, each in its scenario's colour. The
  fan bands are the hard part: two translucent 5–95% bands over each other turn
  to mud. Options are bands for one and lines for the other, thinner quantile
  bands for both, or a toggle. Worth prototyping before committing.
- **Emissions figure.** Already draws all fifteen; it just needs to highlight
  the whole selection rather than a single name — `drawScenarioContext` takes
  `selected` as one string today, so this becomes a set.
- **Maps: both, and their difference.** The difference map is the point, and it
  needs its own treatment — a scale centred on zero with its own colour bar,
  and a note that it is a difference of *forced responses*, carrying no
  internal variability, so it is a signal difference rather than a "will be
  different by" figure.

Knock-ons: `scn` in the URL becomes a list, which the state codec and its
validation must accept without letting a link request twenty; the CSV export
needs a scenario column or a second file; and the chart title, PNG caption and
status line all assume one scenario today.

Sequencing note: this lands better after item 1, because three maps at once
makes zoom and readable discrete colours matter considerably more than one map
did.

## When the METEOR PRs merge

**An hour, plus half a day.** Re-export from `base`, then delete the
integration-branch machinery — `scripts/refresh-integration.sh`, the branch, and
the paragraphs explaining it. Then the Zenodo deposit via
`scripts/deposit_bundles.py`, which already implements DOI pre-reservation.

## Still needs a server

**Custom emissions only.** Turning an invented emissions trajectory into forcing
needs CICERO-SCM. Rescaling and combining bundled forcings covers most of what
the UI wants, and a drawn warming pathway covers most of the rest. If this
becomes essential, a small service behind a "full run" button is the answer —
not rebuilding the client around one.

## Elsewhere

**Track 1, the Colab badge, is still not done** — no Colab link in METEOR's
README or `notebooks/METEOR_Interface_Examples.ipynb` on `base` (verified
2026-09-23). Given the audience decision it matters slightly less than it did,
since the experts it serves are the ones who would clone the repo anyway. Still
a README edit for real value.

**Impacts.** METEOR has `src/meteor/impacts/`, including a degree-days
calculator — plainly relevant to an impacts audience. Check first whether the
real calculators need daily data; monthly output may not support them, in which
case this is not a browser feature.

---

## Open decisions

1. **Where the data lives.** Deferred, deliberately, and the options are worth
   having on record:

   - **Keep committing to git** (today). Same-origin, no CORS, versioned with
     the client, works offline, one thing to deploy. Fine at 297 KB. Awkward at
     13 MB per variable per model, and git keeps every version forever.
   - **Zenodo at runtime.** The citable copy is the one people load, and the
     repository stays small. Costs a CORS dependency and an external point of
     failure on page load — and Zenodo is not a CDN.
   - **Both, tiered.** Commit the small timeseries bundles so the default view
     always works offline and instantly; fetch the multi-megabyte artifacts from
     Zenodo only when the user asks for maps or a custom location. This matches
     how the tiers are used and is what I would suggest when the time comes.

   Multi-model forces the question: a dozen models will not sit in git.

2. **Precipitation outside 2015–2100.** The gamma parameters are fitted per
   window. Either export several windows or establish that a window-independent
   fit is defensible — a METEOR-side question.

## Suggested order

Items 1, 2 and 3 above, in that order, with the merge chores slotted in
whenever METEOR #104, #102 and #101 land.

The ordering has one real dependency in it: **item 3 wants item 1 done first.**
Three maps at once — two scenarios and their difference — makes zoom and
legible discrete colours matter far more than a single global map did, and
retrofitting a pan gesture around an existing drag-to-draw is worse than
choosing the split once.

Item 2 sits in the middle because its long pole is training time on your
machine, which runs while the client work for item 3 proceeds, and because the
storage decision it forces is one the project needs settled regardless.
