"""Atmospheric CO2 for every scenario the bundles carry, for the crop yields.

The crop yield emulator takes CO2 concentration, which feeds crops directly.
The bundles carry forcing only, and their CO2 experiment lumps in the other
well-mixed gases, so this runs CICERO-SCM's emissions-to-concentrations step
on the same inputs and settings the exporter gives METEOR
(``timeseries_bundle.compute_scenario_forcing``: concentrations prescribed
for the first hundred years, emissions-driven after). The CO2 is then the
CO2 behind the warming the site shows, CMIP7 markers included, rather than
the SSP concentrations those markers' input files inherit.

Usage::

    PYTHONPATH=<meteor>/src python scripts/make_scenario_co2.py

Writes data/scenario_co2_v1.json: ppm, annual, 1750-2100.
"""

import json
import os
import sys
from dataclasses import asdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ciceroscm import concentrations_emissions_handler  # noqa: E402
from meteor import scm_forcer_engine  # noqa: E402

from export_bundles import scenario_inputs  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "scenario_co2_v1.json")


def co2(emissions, concentrations):
    """Annual CO2 in ppm, as CICERO-SCM computes it inside the export."""
    start = int(emissions.index[0])
    engine = scm_forcer_engine.ScmEngineForPatternScaling(
        {
            "conc_run": False,
            "nystart": start,
            "emstart": start + 100,
            "nyend": 2100,
            "concentrations_data": concentrations,
            "emissions_data": emissions,
        }
    )
    pamset = asdict(engine.cfg)
    handler = concentrations_emissions_handler.ConcentrationsEmissionsHandler(engine.input_h, pamset)
    handler.reset_with_new_pams(pamset)
    for year in range(pamset["nystart"], pamset["nyend"] + 1):
        handler.emi2conc(year)
        handler.conc2forc(year, 0, 0)
    years = list(range(start, 2101))
    return start, [round(float(handler.conc["CO2"][y]), 2) for y in years]


def main():
    os.chdir(ROOT)  # scenario_inputs reads scenario-work/ relative to here
    out = {}
    first = None
    for name, (emissions, concentrations) in scenario_inputs().items():
        start, values = co2(emissions, concentrations)
        first = first or start
        if start != first:
            raise ValueError(f"{name} starts at {start}, not {first}")
        out[name] = values
        print(f"{name:24s} {values[1850 - start]:6.1f} ppm in 1850, {values[2020 - start]:6.1f} in 2020, "
              f"{values[-1]:6.1f} in 2100")
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "note": "Atmospheric CO2 (ppm), from CICERO-SCM run on the scenario emissions as in the "
                "bundles' forcing (scripts/make_scenario_co2.py). For the crop yield emulator.",
                "year_start": first,
                "scenarios": out,
            },
            handle,
            separators=(",", ":"),
        )
        handle.write("\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
