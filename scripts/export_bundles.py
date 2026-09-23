"""Export the four data files in ``data/`` from trained METEOR models.

This is how the committed bundles and fixtures were produced. It needs METEOR
installed and a cache of trained models; the client needs neither.

Bundles cover the global mean, all 58 AR6 reference regions and eight cities,
with forcing baked in for eight SSP scenarios. The ``pr`` bundle additionally
carries the fitted gamma parameters, which requires a CMIP6 reference field —
read from the local cache rather than refetched.

Fixtures are built from a four-location sub-bundle rather than the shipped
one, because ``export_golden_fixture`` carries every location of the bundle it
is given and four validate the maths as well as sixty-seven do.

Usage::

    PYTHONPATH=<meteor>/src python scripts/export_bundles.py data/

Re-export from METEOR's ``base`` branch once #104, #102 and #101 have merged.
These were built from ``integration/meteor-view``, METEOR's development branch
for this repository -- exactly ``base`` plus those three PRs. It supplies the
``series_transformed`` and ``locations=`` support used below, both from #101.
"""

import os
import sys
import tempfile

import numpy as np
import regionmask

from meteor.meteor_interface import MeteorInterface
from meteor.timeseries_bundle import (
    export_golden_fixture,
    export_timeseries_bundle,
    forcing_from_bundle,
    load_timeseries_bundle,
)

CACHE = "/Users/bensan/GitHub/METEOR/cache"
OUT = sys.argv[1] if len(sys.argv) > 1 else "."
MODEL = "NorESM2-MM"
WINDOW = (2015, 2100)
SCENARIOS = ["ssp119", "ssp126", "ssp245", "ssp370", "ssp434", "ssp460", "ssp534-over", "ssp585"]

CITIES = {
    "London": (51.5, -0.1),
    "New York": (40.7, -74.0),
    "Sao Paulo": (-23.5, -46.6),
    "Lagos": (6.5, 3.4),
    "Cairo": (30.0, 31.2),
    "Mumbai": (19.1, 72.9),
    "Beijing": (39.9, 116.4),
    "Sydney": (-33.9, 151.2),
}


def locations():
    locs = ["global"]
    locs += [f"regional:{r.abbrev}" for r in regionmask.defined_regions.ar6.all]
    locs += [f"point:{lat},{lon}" for lat, lon in CITIES.values()]
    return locs


def main():
    os.makedirs(OUT, exist_ok=True)
    locs = locations()
    print(f"{len(locs)} locations, {len(SCENARIOS)} scenarios")

    emu = MeteorInterface(MODEL, ["tas", "pr"], cache_dir=CACHE)
    emu.train(verbose=True)

    for var in ("tas", "pr"):
        noise = emu.noise_models[var]
        pattern = emu.pattern_models[var]

        ref = None
        if var == "pr":
            ref, _ = emu._load_transform_reference(var, *WINDOW, verbose=True)

        path = os.path.join(OUT, f"meteor_{MODEL}_{var}_bundle_v1.nc")
        export_timeseries_bundle(
            noise,
            pattern,
            path,
            locs,
            variable=var,
            cmip6_model=MODEL,
            training_scenario="ssp245",
            transform_reference=ref,
            transform_window=WINDOW if ref is not None else None,
            scenarios=SCENARIOS,
            source_url="https://github.com/benmsanderson/meteor-view",
        )
        print(f"wrote {path}  {os.path.getsize(path)/1024:.1f} KB")

        # Golden fixture: a fixture carries every location of the bundle it is
        # built from, so build it from a 4-location sub-bundle rather than the
        # shipped 67-location one. The locations are a deliberate spread: the
        # global mean, a land region, an ocean region and a point.
        fix_locs = ["global", "regional:NEU", "regional:EPO", "point:19.1,72.9"]
        with tempfile.TemporaryDirectory() as tmp:
            sub = os.path.join(tmp, "sub.nc")
            export_timeseries_bundle(
                noise,
                pattern,
                sub,
                fix_locs,
                variable=var,
                cmip6_model=MODEL,
                training_scenario="ssp245",
                transform_reference=ref,
                transform_window=WINDOW if ref is not None else None,
                scenarios=["ssp245"],
                source_url="https://github.com/benmsanderson/meteor-view",
            )
            sub_bundle = load_timeseries_bundle(sub)
            forcing = forcing_from_bundle(sub_bundle, "ssp245")
            t_glob = np.linspace(0.0, 3.0, 480)
            fix = os.path.join(OUT, f"meteor_{MODEL}_{var}_golden_ssp245_v1.nc")
            export_golden_fixture(
                sub,
                fix,
                noise,
                t_glob,
                seed=0,
                n_realizations=2,
                forcing_by_exp=forcing,
                # The window the transform is fitted for, so a pr fixture
                # carries series_transformed and a client can validate the two
                # steps unique to precipitation without installing METEOR.
                window_start=WINDOW[0],
                # Must match the forcing's own first year, not the 1850
                # default: forcing read out of a bundle starts at the bundle's
                # forcing_year_start, which is 1750 for the shipped scenarios.
                # Leaving the default would mislabel the year axis by a
                # century. It does not change any stored value -- year_0 only
                # labels the axis -- but a reader would be misled.
                year_0=int(sub_bundle.attrs["forcing_year_start"]),
            )
        print(f"wrote {fix}  {os.path.getsize(fix)/1024:.1f} KB")


if __name__ == "__main__":
    main()
