# What the port had to infer

Feedback for METEOR from writing the first independent client against schema
v1. Everything below is something the JavaScript port had to work out by
reading METEOR's source, because the schema does not state it. That matters
more than it sounds: each one produces *plausible numbers* rather than an
error, so a port can look finished and be wrong.

Verified against `benmsanderson/METEOR` at `integration/meteor-view`
(`3b32ce2`) on 2026-09-23, which is `base` plus the three PRs in flight.
Ordered by how badly each one bites.

**Status:** all six are filed upstream in
[benmsanderson/METEOR#101](https://github.com/benmsanderson/METEOR/pull/101),
which targets `base`. They were briefly a separate PR (#105) and were folded
into #101 instead, since they document and fix what that PR itself introduces.
It documents findings 1–3 and 6 in the schema, and fixes 4 and 5 in code:
golden fixtures gained a `series_transformed` array and a `locations=`
argument. This client
already depends on both — `test/transform.test.js` validates the precipitation
path against the shipped fixture rather than against a reference it has to
generate with METEOR installed, which is what finding 4 was about.

A seventh turned up while writing those commits, and is fixed there too: **`year_0`
is load-bearing**. It is the first calendar year of `forced_response`, and
forcing read from a bundle starts at `forcing_year_start` — 1750 for the
shipped scenarios, not the 1850 default. Our own first export left the default
alone and so mislabelled the year axis by a century. It changed no stored
value, since `year_0` only labels the axis, but a reader would have been misled.

---

## 1. The documented reconstruction is not what METEOR's timeseries path produces

**The schema says** (`meteor-timeseries-bundle`, "Reconstruction"):

```
series = X @ seasonal_coef[loc] + seasonal_intercept[loc]
       + pcs @ eof_projection[loc]
       + Σ_exp convolve(...) @ pattern_projection[loc, exp]
```

**METEOR's own timeseries path does something else.**
`meteor_interface.py:1439` calls
`generate_regional_mean_realizations(..., noise_only=True, add_base=pattern_agg)`,
and `noise_only=True` subtracts two terms from the seasonal cycle
(`noise_generator.py`, in the branch that computes `seasonal_cycle_full`):

```python
temp_effect = self.seasonal_coef[:, 0] * global_temp_trajectory[:, np.newaxis]
seasonal_cycle_full = seasonal_cycle - intercept_effect - temp_effect
```

So the intercept **and** the `t_glob` term are removed. The level and the trend
come from the forced response instead, and keeping them in the seasonal term
double-counts both.

**Why it is expensive to get wrong.** For NorESM2-MM `tas` the intercept is
287 K, so the series looks like an absolute temperature rather than an anomaly
— which a reader might notice. But the `t_glob` coefficient is 0.99, which
roughly *doubles* the warming trend, and that does not announce itself: a
global mean rising 3.0 K over the century instead of 1.5 K is a plausible
number for a plausible-looking scenario. Measured against METEOR's own
ensemble, this was 6619× the sampling-noise tolerance.

**Suggested fix.** Document both forms and say which one the bundle's consumers
should use. The absolute form is what the golden fixtures contain; the anomaly
form is what METEOR's public API returns. A bundle attribute recording the
convention would be better still, since it is a property of the artifact rather
than of the reader.

## 2. PCs must be spun up over the full trajectory, not the output window

**The schema says** `pcs_t = 0 for t < lag_order`, which reads as an
instruction to start the recursion at the beginning of whatever you are
generating.

**METEOR generates from the pattern model's base year and then slices**
(`meteor_interface.py:1194`), with the comment: *generate over the FULL
trajectory so spin-up is resolved before the output window, then slice to the
window on a January boundary*.

A client that starts the recursion at 2015 opens with PCs pinned at zero and
ramping out of nothing, so the first decades are too quiet. Nothing errors.

**Suggested fix.** State it in the reconstruction section, along with the
reason the January boundary matters: because the harmonic design matrix is
indexed from the start of the array it is given, a slice that is a whole number
of years leaves the seasonal phase unchanged, and one that is not would silently
rotate the seasonal cycle.

## 3. `t_glob` is the variable's own global response, not temperature

The schema never says what drives `t_glob` — the first column of the design
matrix, and the thing `generate_stochastic_pcs` is given.

It is the global mean of **that variable's own** forced response
(`meteor_interface.py:989`, `full_monthly_warming = global_mean(...)` of the
prediction from `self.pattern_models[variable]`). The noise model for a
variable is trained against that variable's own global trajectory, so
generation has to match it.

This is the **opposite** of the warming-pathway denominator, which the schema
does document, emphatically and correctly: that one is always the *temperature*
response whatever the variable. Two adjacent quantities, both "a global mean
trajectory", with opposite rules. A port that reads the pathway note carefully
and then applies the same reasoning to `t_glob` gets it wrong.

**Suggested fix.** Say what `t_glob` is in the reconstruction section, and
contrast it with the pathway denominator explicitly.

## 4. The golden fixtures do not cover the precipitation path

A fixture's `series` is the seasonal cycle plus the EOF projection. It does not
include the forced response (shipped separately as `forced_response`, annual),
the annual-to-monthly expansion, the baseline, or the gamma quantile mapping.

So for `pr` — the harder of the two variables, and the one with the two extra
steps the schema itself warns are "not optional" — **the shipped fixtures
validate none of the steps unique to it**. A port can pass every fixture with
its precipitation path entirely unimplemented.

This client originally had to generate its own reference by running
`apply_transform_from_bundle` over the fixture's PCs, which requires METEOR
installed and so is exactly what the fixtures exist to avoid.

**Fixed** in METEOR#101: fixtures for a transformed variable now carry
`series_transformed`, the complete recipe with the baseline and the quantile
mapping applied. The workaround script is gone and `test/transform.test.js`
validates against the shipped fixture instead, to 2e-7 — float32 wire
precision, since both sides now read the same stored arrays.

## 5. A fixture inherits every location of the bundle it was built from

`export_golden_fixture` iterates the bundle's full `location` coordinate, so a
fixture built from a 67-location bundle carries 67 locations and is large. A
fixture is a validation artifact, and four locations validate the maths as well
as sixty-seven do.

This was easy to work around — build the fixture from a small sub-bundle —
but it is surprising, and the obvious call produces a file several times bigger
than it needs to be.

**Fixed** in METEOR#101: `export_golden_fixture` takes `locations=`.

## 6. Two notes for the schema's netCDF section

**Char variables are padded.** netCDF-3 pads every variable to a four-byte
boundary. A 67-location `location` variable with a 17-character width holds
1139 bytes of data in a 1140-byte record, so chunking the flat run by the
string width alone yields a spurious 68th entry. The count has to come from the
dimension. This cost an hour and would cost every port the same hour; one
sentence in the schema would prevent it.

**Point specifiers carry trailing zeros.** The `location` coordinate holds
`point:40.7,-74.0` and `point:30.0,31.2`. A client that builds a specifier by
formatting numbers gets `point:40.7,-74` and misses. Worth stating that the
coordinate strings are opaque keys to be matched exactly, not reconstructed.

---

## What the schema got right, and should keep

Recording these too, because they are what made the rest of the port
straightforward and it would be easy to lose them in a revision:

- **Shipping the PC sequence as data.** Exactly the right call. It makes the
  deterministic parts checkable without asking a port to reproduce PCG64, and
  it is the reason this client could be validated at all.
- **The `exp_forc == 0` warning.** Stated plainly, in both the schema and the
  prompt, with the consequence (NaN) spelled out. Implemented right first time.
- **The warming-pathway denominator note.** The single most emphatic paragraph
  in the schema, and it needed to be. See finding 3 for its one gap.
- **Classic netCDF-3 over HDF5.** A 12 KB parser against a 1.5 MB WebAssembly
  build; this decision is the reason the client is small.
- **The shared gamma quantile table.** It removes a dependency that genuinely
  has no browser equivalent. The note that the probability axis is refined in
  the tails, and *why*, saved an investigation.
