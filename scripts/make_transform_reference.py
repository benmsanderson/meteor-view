"""Generate a reference for the precipitation transform, from METEOR itself.

The shipped golden fixtures stop short of the ``pr`` path: a fixture's
``series`` is the seasonal cycle plus the EOF projection, with the baseline and
the gamma quantile mapping — steps 5 and 6 of the schema's recipe — left out.
Those two steps are exactly the ones a port is most likely to get wrong, and
skipping them gives an answer in the wrong units rather than a slightly
different one, so they need a reference of their own.

This runs METEOR's own ``apply_transform_from_bundle`` over the fixture's PCs
and writes the result as JSON for the JavaScript test suite to compare against.
It is a development-time script: it needs METEOR installed, which the client
does not.

Usage::

    PYTHONPATH=<meteor>/src python scripts/make_transform_reference.py

Regenerate only when the bundles are re-exported.
"""

import json
import os

import numpy as np
import xarray as xr

from meteor.timeseries_bundle import (
    apply_transform_from_bundle,
    forced_response_from_bundle,
    forcing_from_bundle,
    load_timeseries_bundle,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(ROOT, "test", "fixtures", "pr_transform_reference.json")

#: Window the fixture months are taken to cover. The transform parameters are
#: fitted for 2015-2100 and are not valid outside it.
START_YEAR = 2015
SCENARIO = "ssp245"


def main():
    bundle = load_timeseries_bundle(
        os.path.join(DATA, "meteor_NorESM2-MM_pr_bundle_v1.nc")
    )
    fixture = xr.open_dataset(
        os.path.join(DATA, "meteor_NorESM2-MM_pr_golden_ssp245_v1.nc")
    )

    forcing = forcing_from_bundle(bundle, SCENARIO)
    year_start = int(bundle.attrs["forcing_year_start"])
    offset = START_YEAR - year_start

    n_months = fixture.sizes["month"]
    n_years = n_months // 12
    locations = [str(s) for s in fixture["location"].values]

    out = {}
    for i, location in enumerate(locations):
        forced = forced_response_from_bundle(bundle, location, forcing, year_0=1850)
        window = forced[offset : offset + n_years]
        monthly = np.repeat(window, 12)

        # Steps 1-4 from the fixture and the forced response, then step 5: the
        # baseline goes back on before the transform, which expects absolute
        # values rather than the anomaly generation produces.
        series = fixture["series"].values[i] + monthly[None, :]
        series = series + float(bundle["transform_baseline"].values[i])

        # Step 6.
        transformed = apply_transform_from_bundle(bundle, location, series)
        out[location] = np.asarray(transformed, dtype=float).tolist()

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "generated_by": "scripts/make_transform_reference.py",
                "source": "meteor.timeseries_bundle.apply_transform_from_bundle",
                "meteor_version": bundle.attrs.get("meteor_version", ""),
                "bundle": "meteor_NorESM2-MM_pr_bundle_v1.nc",
                "fixture": "meteor_NorESM2-MM_pr_golden_ssp245_v1.nc",
                "scenario": SCENARIO,
                "start_year": START_YEAR,
                "year_0": 1850,
                "values": out,
            },
            handle,
        )
    print(f"wrote {OUT} ({os.path.getsize(OUT) / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
