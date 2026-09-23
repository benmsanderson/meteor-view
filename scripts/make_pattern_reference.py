"""Reference for the map tier, from METEOR's own pattern-scaling prediction.

The bundle tier is validated against golden fixtures; the map tier needs its
own reference, because reconstructing the forced response *on the grid* is
arithmetic no fixture exercises. This dumps METEOR's gridded annual prediction
for a scenario, plus its global and regional means, so the JavaScript port can
be held to the same numbers.

Usage::

    PYTHONPATH=<meteor>/src python scripts/make_pattern_reference.py
"""

import json
import os

import numpy as np

from meteor.geo_data_utils import global_mean, regional_mean
from meteor.meteor_interface import MeteorInterface

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "test", "fixtures", "pattern_reference.json")

CACHE = "/Users/bensan/GitHub/METEOR/cache"
MODEL = "NorESM2-MM"
SCENARIO = "ssp245"
VARIABLE = "tas"
#: Years to compare maps at, relative to the prediction's own first year.
YEARS = [2050, 2100]


def main():
    emulator = MeteorInterface(MODEL, [VARIABLE], cache_dir=CACHE)
    emulator.train(verbose=False)
    pattern = emulator.pattern_models[VARIABLE]

    from meteor.scm_input_lib import load_emissions_concentrations_from_name

    emissions, concentrations = load_emissions_concentrations_from_name(SCENARIO)
    prediction = pattern.predict_from_combined_experiment(
        emissions, concentrations, [VARIABLE]
    )[VARIABLE]

    base_year = int(prediction.year[0]) if hasattr(prediction, "year") else 1750
    years = list(range(base_year, base_year + prediction.shape[0]))

    out = {"maps": {}, "global": {}, "regional": {}}
    for year in YEARS:
        field = prediction.isel(time=years.index(year))
        # Six significant figures: the client reads float32 (~7 digits) and
        # the comparison is at 2e-6 relative, so more would only be file size.
        values = np.asarray(field.values, dtype=float).ravel()
        out["maps"][str(year)] = [float(f"{v:.6g}") for v in values]
        out["global"][str(year)] = float(global_mean(field).values)
        out["regional"][str(year)] = {
            code: float(regional_mean(field, region_code=code).values)
            for code in ("NEU", "SAS", "EAS")
        }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "generated_by": "scripts/make_pattern_reference.py",
                "source": "MeteorPatternScaling.predict_from_combined_experiment",
                "cmip6_model": MODEL,
                "variable": VARIABLE,
                "scenario": SCENARIO,
                "base_year": base_year,
                "n_lat": int(prediction.sizes["lat"]),
                "n_lon": int(prediction.sizes["lon"]),
                "years": YEARS,
                **out,
            },
            handle,
        )
    print(f"wrote {OUT} ({os.path.getsize(OUT)/1e6:.2f} MB)")


if __name__ == "__main__":
    main()
