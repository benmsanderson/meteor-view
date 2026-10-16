"""Reference yields for the crop emulator port, from METEOR's own evaluator.

The site evaluates the GGCMI emulators on coefficients reduced to its 2-degree
grid (scripts/make_crop_coefficients.py, src/lib/crops.js). This checks that
port end to end: for a few crop models, crops, cells and inputs, METEOR's
``get_yields`` on the original 0.5-degree coefficients and AgMERRA baseline,
given the same change at every 0.5-degree cell of a 2-degree cell, and
averaged over them by rainfed harvested area. The test suite then holds the
site to those numbers (test/crops.test.js).

Only crop models with the full 34-term emulator: METEOR's evaluator cannot
take the 20-term ones.

Usage::

    PYTHONPATH=<meteor>/src python scripts/make_crop_reference.py <work dir>
"""

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from meteor.impacts.ggcm.baseline import load_agmerra_baseline  # noqa: E402
from meteor.impacts.ggcm.coefficients import get_yields  # noqa: E402

import make_crop_coefficients as reduce  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "test", "fixtures", "crop_reference.json")

#: As the site (src/lib/crops.js, NITROGEN), kg N per hectare per year.
NITROGEN = 100.0

CASES = [
    # crop model, crop, (lat, lon) inside the 2-degree cell, CO2, warming, precipitation ratio
    ("LPJmL", "maize", (41.0, -93.0), 360.0, 0.0, 1.0),  # Iowa, the reference climate
    ("LPJmL", "maize", (41.0, -93.0), 550.0, 2.5, 0.9),
    ("pDSSAT", "wheat", (50.0, 10.0), 450.0, 1.5, 1.1),  # Germany: winter wheat
    ("pDSSAT", "wheat", (52.0, 70.0), 600.0, 4.0, 0.8),  # Kazakhstan: spring wheat
    ("EPIC-TAMU", "rice", (23.0, 90.0), 700.0, 3.0, 1.2),  # Bangladesh
    ("GEPIC", "soy", (-12.0, -55.0), 500.0, 7.0, 0.4),  # Mato Grosso, beyond the training range
]


def main():
    work = sys.argv[1]
    cells, lat, lon = reduce.cell_of()
    t_base, p_base = load_agmerra_baseline()
    coldest = np.load(os.path.join(work, "coldest_month.npy"))
    winter = (coldest > reduce.WINTER_WHEAT[0]) & (coldest < reduce.WINTER_WHEAT[1])
    out = []
    for model, crop, (la, lo), co2, warming, ratio in CASES:
        i = int(np.floor((la + 90.0) / 2.0))
        j = int(np.floor(np.mod(lo, 360.0) / 2.0))
        cell = i * reduce.GRID["lon"][2] + j
        inside = cells == cell
        area = reduce.read_mirca(
            os.path.join(
                work, "mirca", "harvested_area_grids",
                f"annual_area_harvested_rfc_crop{reduce.CROPS[crop]:02d}_ha_30mn.asc.gz",
            )
        )
        parts = (
            [("winter_wheat", area * winter), ("spring_wheat", area * ~winter)]
            if crop == "wheat"
            else [(crop, area)]
        )
        total = 0.0
        weight = 0.0
        for name, weights in parts:
            k = reduce.emulator(work, model, name)
            yields, _, _ = get_yields(
                np.nan_to_num(k), co2, t_base + warming, p_base * ratio, NITROGEN, t_base, p_base
            )
            valid = inside & np.all(np.isfinite(k), axis=0) & np.any(k != 0, axis=0) & (weights > 0)
            total += float((yields * weights)[valid].sum())
            weight += float(weights[valid].sum())
        out.append(
            {
                "model": model,
                "crop": crop,
                "cell": int(cell),
                "co2": co2,
                "warming": warming,
                "ratio": ratio,
                "yield": total / weight,
            }
        )
        print(f"{model:10s} {crop:6s} cell {cell}: {total / weight:.3f} t/ha")
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "generated_by": "scripts/make_crop_reference.py",
                "source": "meteor.impacts.ggcm.coefficients.get_yields, area-weighted over each 2-degree cell",
                "nitrogen": NITROGEN,
                "cases": out,
            },
            handle,
            indent=1,
        )
        handle.write("\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
