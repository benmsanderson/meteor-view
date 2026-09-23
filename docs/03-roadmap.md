# Roadmap

Where meteor-view goes next, grouped by what has to be true before each item
can start. [`00-development-plan.md`](00-development-plan.md) records *why* the
architecture is what it is; this records what is left.

Effort figures are rough and are mine, not measured.

## Where it stands

The client works and is validated: temperature and precipitation, 67 locations,
8 SSPs, drawn warming pathways, an ensemble fan chart and a seasonal-cycle
panel, shareable links and CSV/PNG export. 70 tests across three layers, green
in CI. 440 KB deployed, no server.

What it is *not* is finished as a scientific instrument. The single largest gap
is below under "Needs offline compute", and it is a credibility issue rather
than a feature gap.

---

## Now — nothing blocks these

### 1. Context, before the numbers travel further — *recommended next*

**Half a day.** An about/methods panel: what METEOR is, what the ensemble
spread does and does not represent, the single-model caveat, the 2015–2100
precipitation window, and what "drawn pathway" actually does to the forced
response.

This moved to the top *because* sharing shipped. Links and captioned PNGs mean
output now travels without a person attached to explain it, and the most likely
misreading is the one the tool currently does nothing to prevent: **the spread
shown is internal variability from one model.** It is not model uncertainty,
and it is not "the" uncertainty in a projection. Someone pasting a fan chart
into a report will assume otherwise unless told.

Cheap, and it is the difference between a tool that informs and one that
misleads confidently.

### 2. Comparison mode

**2–3 days.** Overlay two or more scenarios, or two or more places, on one
chart. The thing a scientist actually wants, and the thing that makes the
scenario spread legible rather than something you hold in your head across
clicks.

Design questions to settle first: how many series stay readable (probably
3–4 with bands, more if bands collapse to lines); whether comparison is a
separate mode or the picker becomes multi-select; how the URL encodes a set
rather than a single value. The last one is why this is days rather than hours
— the state codec currently assumes one of each.

### 3. Polish

**1–2 days, separable.** Keyboard and screen-reader passes over the pathway
editor, which is currently pointer-only and therefore unusable without a mouse.
`prefers-reduced-motion`. Moving generation into a worker so a 100-member run
cannot jank the page — not needed at present speeds (~600 ms), but it becomes
one as ensembles or models multiply.

---

## When the METEOR PRs merge

### 4. Re-export from `base`

**An hour.** One command, then delete the integration-branch machinery:
`scripts/refresh-integration.sh`, the branch itself, and the paragraphs in the
README and plan that explain it. The dependency is deliberate and temporary,
and should not outlive its reason.

### 5. Zenodo deposit and a DOI

**Half a day.** METEOR#101 ships `scripts/deposit_bundles.py` with a DOI
pre-reservation flow. Deposit the bundles, record the DOI in the artifacts
themselves, and cite it from the site.

Then decide — see open decisions — whether the data files keep living in git.
Committing them was right while the schema was still moving; it is less obviously
right once there is a citable copy with a permanent identifier.

---

## Needs offline compute (hours per model, on a real machine)

### 6. More CMIP6 models — the biggest scientific gap

**A day of work, plus training time.** Today there is one model, so the spread
the tool draws is internal variability alone. Real projection uncertainty is
dominated by model spread, so the tool currently understates uncertainty in a
way that looks authoritative.

The client work is modest: a model picker, one bundle per model, and the loader
already keys everything off the bundle. The cost is training — gigabytes of
CMIP6 and an hour or more per model per variable, on your machine.

Worth doing in two stages: several models selectable individually first, then a
multi-model view that shows across-model spread alongside within-model
variability. The second is the one that changes what the tool *means*.

Note that the bundle format already supports this without change: a bundle
records its own `cmip6_model`, and the client reads it.

---

## Needs METEOR-side schema work

These are small individually, and all want the same thing: a re-export with
different parameters, which means a METEOR change first.

- **Precipitation outside 2015–2100.** The gamma parameters are fitted per
  window. Either export several windows, or work out whether a window-independent
  parameterisation is defensible. The schema is explicit that the fit depends on
  the window, so this is a real constraint, not an oversight.
- **Arbitrary locations.** A bundle covers the locations it was exported with,
  so "my town" is not available unless it was chosen in advance. Options: export
  a denser point set, or ship the EOF maps for a coarse grid and interpolate —
  which starts to give back the size advantage the bundle exists for.
- **Impacts.** METEOR has `src/meteor/impacts/`, including a degree-days
  calculator. Heating and cooling degree days are exactly what an impacts or
  policy user wants and are cheap to compute client-side from monthly output —
  but check first whether the real calculators need daily data, in which case
  this is not a browser feature at all.

## Needs a server (architecture C)

Still deliberately unbuilt, for the reason in the plan: a server costs money and
attention indefinitely, which is what kills academic tools.

- **Gridded maps.** The one output that genuinely forces a server.
  Reconstructing 100 realizations × 1032 months × 55k gridpoints is not a
  client-side operation.
- **Custom emissions.** Needs CICERO-SCM to turn emissions into forcing.
  Rescaling and combining the bundled forcings covers most of what the UI wants;
  starting from an invented emissions trajectory does not.

If either becomes essential, the honest move is a small service behind a "full
run" button rather than rebuilding the client around it.

## Elsewhere, but on the critical path for adoption

**Track 1, the Colab badge, is still not done.** METEOR's README and
`notebooks/METEOR_Interface_Examples.ipynb` carry no Colab link on `base`
(verified 2026-09-23). It remains the cheapest thing on any of these lists: it
serves every expert user who would rather have real METEOR than a web tool, and
it costs a README edit. It takes pressure off this repository to be everything.

---

## Open decisions

These change the ordering above, and none of them are mine to make.

1. **Audience.** Climate scientists or impact/policy users? The tool currently
   leans policy — point and click, named places, mm/day — while the people most
   able to check it are scientists. Comparison mode serves the former; Colab and
   multi-model serve the latter.
2. **Are maps essential?** If yes, architecture C moves up and the roadmap
   changes shape. If no, say so explicitly so it stops being an open question.
3. **Where the data lives after the DOI.** Keep committing bundles to git, or
   fetch from Zenodo at runtime? Committed means same-origin, no CORS, versioned
   with the client, and works offline. Fetched means the repository stays small
   and the citable copy is the one people actually load. Multi-model makes this
   decision for us eventually — a dozen models will not sit comfortably in git.

## Suggested order

1 → 6 (start training early, it is the long pole) → 2 → 4 and 5 when the PRs
land → decide on 3 and the METEOR-side items from what users actually ask for.

The argument for that order: sharing shipped, so context is now urgent; the
single-model caveat that context has to explain is the same problem multi-model
solves properly; and everything else is either blocked or better decided with
real usage in hand.
