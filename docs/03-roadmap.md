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

## Now

### 1. Custom regions and points, and forced-response maps

**A week, in two halves.** The 2 MB tier above. First half: load the pattern
artifact, reconstruct the forced response on the grid, draw a map. Second half:
let the user define a location — a lat/lon point, a box, or a drawn rectangle —
and project onto it.

Validate against METEOR the way everything else here was: compare a
reconstructed map and a custom-region timeseries against
`generate_ensemble_outputs` with `gridded=` and a matching `regional:` request.
The reconstruction identity is in the schema, so this should agree to float32
precision; if it does not, that is a finding, not a tolerance to loosen.

Then decide whether the 11.3 MB noise tier is worth an opt-in button for
variability at a custom location. My guess is yes, for this audience, and that
it should be an explicit click rather than something the page does on load.

### 2. CMIP7 scenarios — done (Route C)

**Shipped.** All seven markers are in the bundles, driven through METEOR's own
CICERO-SCM from the release's harmonized emissions — Route C, the consistent
one. `scripts/convert_scenariomip.py` converts a copy you download yourself;
`data/README.md` records where the redistribution line falls. METEOR#101 gained
the ability to accept supplied emissions so the forcing could be bundled
without the emissions ever being.

Resulting global response at 2100 (NorESM2-MM, K): very-low 1.30, low 1.47,
low-to-negative 1.37 (it peaks at 1.49 in 2050 and declines — net-negative
emissions doing what they should), medium-to-low 1.97, high-to-low 2.31,
medium 2.59, high 2.93. These run cooler than MAGICC's assessed GSAT for the
same scenarios, which is NorESM2-MM's sensitivity rather than an error.

Source: **ScenarioMIP-CMIP7 IAM quantification**, `10.5281/zenodo.19825038`,
v0.2. Examined 2026-09-23; the early-access embargo has since lifted.

**We may use it; we may not openly re-serve it.** That is a different
constraint from the embargo and it does not expire. The precedent is
[`benmsanderson/FLEX/data/README.md`](https://github.com/benmsanderson/FLEX/tree/main/data):
the scenario files are not stored in the repository, a documented script
converts them from the user's own download, and anything that *is* retained is
attributed separately from the repository's own licence.

What it contains — 7 marker scenarios (High–SSP3, High-to-Low–SSP5,
Medium–SSP2, Medium-to-Low–SSP2, Low–SSP2, Low-to-Negative–SSP2, Very Low–SSP1),
7 IAMs, MAGICCv7.6.0a3, annual 2000–2100:

- **GSAT** — median, 33rd, 67th percentile. 2100 medians span **1.37 °C
  (Very Low)** to **3.42 °C (High)**.
- **Effective radiative forcing**, decomposed: total, anthropogenic, CO2, CH4,
  N2O, F-gases, greenhouse gases, ozone, aerosols (direct BC/OC/SOx, indirect),
  Montreal gases, solar, volcanic.

No emissions, despite the title — only the climate assessment. That rules out
the RCMIP-into-CICERO route, and it does not matter: METEOR's experiments are a
greenhouse-gas axis and an aerosol axis (`co2x4`, `sulxanom`), which is exactly
the split this file already provides, assessed by MAGICC. Per-experiment forcing
can be built from the ERF columns directly, skipping our own SCM run.

#### How METEOR splits a scenario's forcing — verified, not assumed

METEOR's pattern model has two response axes, and `compute_scenario_forcing`
feeds them by running CICERO-SCM and splitting its components. Read from
`scm_forcer_engine.run_and_return_per_forcer_results` and then confirmed
numerically on ssp245:

```
sulxanom = SO2 + SO4_IND                    (exact, 0.0e+00)
co2x4    = Total_forcing - sulxanom         (1.8e-15, float noise)
```

Two details that a reasonable guess gets wrong:

* **BC and OC belong on the CO2 axis, not the aerosol one.** `bc_oc_to_co2` is
  true by default, on the argument that CO2 timescales suit carbonaceous
  aerosols better than sulphate ones. So the aerosol axis is *sulphate only* —
  direct plus indirect — and mapping CMIP7's whole `ERF|Aerosols` group onto
  `sulxanom` would be wrong.
* **METEOR's forcing is anthropogenic-only.** CICERO returns no solar or
  volcanic component, so the CMIP7 equivalent is `ERF|Anthropogenic`, not the
  `ERF` total.

Which gives the mapping, if ERF is used directly:

| METEOR axis | CICERO today | CMIP7 ERF equivalent |
|---|---|---|
| `sulxanom` | `SO2 + SO4_IND` | `ERF\|Aerosols\|Direct Effect\|SOx` + `ERF\|Aerosols\|Indirect Effect` |
| `co2x4` | `Total - sulxanom` | `ERF\|Anthropogenic` − the above |

#### But the two SCMs disagree, and that decides the route

Comparing METEOR's own ssp245 forcing against MAGICC's Medium–SSP2:

| W/m² | METEOR (CICERO) | MAGICC | |
|---|---:|---:|---|
| 2020 anthropogenic total | 3.430 | 2.694 | **0.74 apart** |
| 2020 sulphate axis | −0.781 | −0.958 | |
| 2100 anthropogenic total | 5.113 | 5.305 | |
| 2100 sulphate axis | −0.286 | −0.498 | |

MAGICC's 2.69 W/m² for 2020 is close to AR6's assessed present-day forcing;
CICERO's is higher. Either is defensible on its own, but **mixing them is not**:
a user comparing SSP245 against Medium–SSP2 in the same interface would see a
difference that is partly scenario and partly simple climate model, with
nothing on screen to say which.

#### The file does contain emissions

Correcting an earlier note in this document: the release carries 55
`Harmonized and Infilled|Emissions|*` species as well as the climate
assessment. An earlier scan missed them by only printing MAGICC-suffixed
variables. That makes it possible to drive METEOR's own CICERO-SCM with CMIP7
emissions and stay consistent with the existing SSP bundles.

Conversion to METEOR's RCMIP format is real but bounded work:

* **Years.** The release covers 2000–2100; METEOR's forcing axis starts at
  1750. Splice onto the historical part of an existing SSP emissions file —
  the CMIP7 emissions are harmonized *to* that history, so the overlap should
  be close, and the splice is worth checking rather than assuming.
* **Units.** Per species: Mt CO2 → Pg C, kt N2O → Tg N, Mt SO2 → Tg S,
  Mt NO2 → Mt N, and so on.
* **Gaps.** METEOR wants `HCFC-123`, which the release does not carry, and
  wants biomass-burning BC/OC split from total BC/OC, which it also does not.
  It carries species METEOR cannot ingest (NF3, SO2F2, cC4F8, CH2Cl2, CHCl3,
  CH3Cl, several PFCs), whose forcing would simply be lost.

#### Three routes

| | Cost | Consistent with the SSPs? | Regional pattern |
|---|---|---|---|
| **A** GSAT as pathway presets | Hours | GSAT matches MAGICC, forcing does not | Base scenario's, rescaled — wrong where aerosols differ |
| **B** MAGICC ERF onto the two axes | ~A day | **No** — CICERO vs MAGICC, 0.74 W/m² apart in 2020 | Correct, from this scenario's own aerosol/GHG mix |
| **C** CICERO on CMIP7 emissions | Days | **Yes** | Correct |

C is the one that leaves the tool honest when both scenario families sit in the
same menu, and it reuses `compute_scenario_forcing` unchanged. B is a
worthwhile cross-check on the way: if a CICERO run on CMIP7 emissions lands
near MAGICC's ERF, the conversion is probably right, and where it does not is
itself worth knowing.

#### The wrinkle a browser tool has and FLEX does not

FLEX is a pipeline: the person running it downloads the data themselves, so
"don't redistribute" is satisfied by a README and a converter. A hosted site
*serves* whatever it needs to its visitors. Baking CMIP7 forcing or GSAT into a
public bundle is redistribution, even though it is only a few kilobytes.

Three ways to live with that, in preference order:

1. **Load-your-own, client side.** A file input: the visitor downloads the
   release from IIASA/Zenodo themselves — as they must anyway — and drops it
   into the page. The browser parses it locally and nothing is ever served by
   us. This keeps the rapid-assessment use case intact, redistributes nothing,
   and generalises to any pathway or forcing set a user wants to try. It is
   also a feature in its own right.
2. **Local bundle generation.** `scripts/export_bundles.py` grows a
   `--scenario-file` argument, so anyone can build a CMIP7-enabled bundle from
   their own copy for their own use. Not served by us.
3. **Ask.** Whether a *derived* product — regional timeseries, or forcing
   already convolved into a step response — counts as re-serving the input is a
   rights question rather than a technical one, and the portal can answer it. If
   the answer is that derived products are fine, the hosted site can ship CMIP7
   scenarios directly and options 1 and 2 become conveniences.

Until that is settled, build option 1 and do not commit any ScenarioMIP file.

### 3. Multi-model

**A day of client work, plus hours of training per model per variable.**
Today's spread is internal variability from one model, which for an assessment
tool understates uncertainty in a way that looks authoritative. For this
audience that is the difference between useful and misleading.

Two stages: several models selectable individually, then an across-model view.
The bundle format already supports it — each bundle records its own
`cmip6_model` and the client keys off that.

The long pole is training, on your machine. Worth starting before it is needed.

### 4. Say what is emulated and what is not

**Half a day.** A methods panel, pitched at someone who reads error bars: what
METEOR emulates, what the spread currently represents, how the drawn pathway
rescales the forced response, the 2015–2100 precipitation window, and a link to
the validation evidence. Shorter and more technical than it would be for a
public audience, but no less necessary once output travels as links and PNGs.

### 5. Comparison mode and polish

**2–3 days, plus 1–2.** Overlay scenarios or places; keyboard access to the
pathway editor, which is pointer-only today; a worker if ensembles or models
multiply enough to make generation janky.

---

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

1 → 3 (start training early) → 2 → 4 → 5, with the merge chores slotted in
whenever the PRs land.

The argument: custom regions and maps are the thing you asked for and are far
cheaper than anyone thought; multi-model is the long pole and the credibility
fix; CMIP7 is the most distinctive feature and is cheap to build, but cannot be
*published* until its embargo lifts — so it is worth building behind that, not
waiting on it.

Three uncertainties would then be separable, which for an assessment tool is a
better story than any one of them alone:

| Source | Where it comes from |
|---|---|
| Internal variability | METEOR's ensemble, today |
| Model and pattern uncertainty | Multi-model bundles (item 3) |
| Forcing and climate sensitivity | MAGICC 33rd/67th percentiles (item 2) |
