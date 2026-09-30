"""Reference degree days from METEOR's own calculator, for the JavaScript port.

Runs ``meteor.impacts.DegreeDaysCalculator`` with its defaults on a handful of
synthetic monthly temperature series chosen to exercise every branch: a
cold climate that never cools, a hot one that never heats, a temperate one
whose months cross the 18 °C base, one whose hot months drive the spread to
its floor, and one warming over the years so the months move across the
base. test/degree-days.test.js checks src/lib/degree-days.js against it.

Usage::

    PYTHONPATH=<meteor>/src python scripts/make_degree_days_reference.py
"""

import json
import os

import numpy as np
import xarray as xr

from meteor.impacts import DegreeDaysCalculator

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "test", "fixtures", "degree_days_reference.json")

YEARS = 4
MONTHS = np.arange(12 * YEARS)
PHASE = np.cos(2 * np.pi * ((MONTHS % 12) - 6.5) / 12)  # peaks in July


def series():
    rng = np.random.default_rng(1)
    noise = rng.normal(0, 0.8, MONTHS.size)
    return {
        "arctic": -12 + 14 * PHASE + noise,
        "tropical": 27 + 2 * PHASE + noise,
        "temperate": 11 + 7 * PHASE + noise,
        "hot": 36 + 6 * PHASE + noise,
        "warming": 13 + 8 * PHASE + np.linspace(0, 4, MONTHS.size) + noise,
    }


def main():
    calculator = DegreeDaysCalculator()
    cases = {}
    for name, values in series().items():
        data = xr.DataArray(values, dims=["month"], coords={"month": MONTHS})
        result = calculator.calculate(data).data
        cases[name] = {
            "temperature": values.tolist(),
            "monthly_hdd": result["monthly_hdd"].values.tolist(),
            "monthly_cdd": result["monthly_cdd"].values.tolist(),
            "annual_hdd": result["annual_hdd"].values.tolist(),
            "annual_cdd": result["annual_cdd"].values.tolist(),
        }
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "generated_by": "scripts/make_degree_days_reference.py",
                "source": "meteor.impacts.DegreeDaysCalculator, default settings",
                "base_temperature": calculator.base_temperature,
                "cases": cases,
            },
            handle,
        )
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
