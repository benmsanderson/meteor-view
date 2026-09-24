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

import json
import os
import sys
import tempfile

import numpy as np
import regionmask
import xarray as xr

from ciceroscm import input_handler

from meteor.meteor_interface import MeteorInterface
from meteor.scm_input_lib import load_emissions_concentrations_from_name
from meteor.portable_artifact import export_pattern_scaling
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
#: CMIP6 SSPs, shipped with METEOR.
SSP_SCENARIOS = [
    "ssp119", "ssp126", "ssp245", "ssp370", "ssp434", "ssp460", "ssp534-over", "ssp585",
]

#: CMIP7 ScenarioMIP markers, in ascending forcing order. Their emissions are
#: not shipped with METEOR and are not in this repository: run
#: scripts/convert_scenariomip.py over your own copy of the release first. If
#: the converted files are absent the export simply omits them.
CMIP7_SCENARIOS = [
    "cmip7-very-low", "cmip7-low", "cmip7-low-to-negative", "cmip7-medium-to-low",
    "cmip7-medium", "cmip7-high-to-low", "cmip7-high",
]

#: Where convert_scenariomip.py wrote its output. Gitignored.
SCENARIO_WORK = "scenario-work"

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


def scenario_inputs():
    """
    Emissions and concentrations for every scenario, as a name -> pair mapping.

    Passed to the exporter wholesale rather than as a list of names, because
    the CMIP7 markers have no name METEOR could resolve: their emissions are
    third-party data it does not ship. Loading the SSPs here too keeps one code
    path rather than two.

    Omits the CMIP7 markers, with a warning, when the converted files are not
    present -- an export without them is still a valid bundle.
    """
    inputs = {name: load_emissions_concentrations_from_name(name) for name in SSP_SCENARIOS}

    handler = input_handler.InputHandler({})
    missing = []
    for name in CMIP7_SCENARIOS:
        emissions = os.path.join(SCENARIO_WORK, f"{name}_em_RCMIP.txt")
        concentrations = os.path.join(SCENARIO_WORK, f"{name}_conc_RCMIP.txt")
        if not (os.path.exists(emissions) and os.path.exists(concentrations)):
            missing.append(name)
            continue
        inputs[name] = (
            handler.read_emissions(emissions),
            input_handler.read_inputfile(concentrations),
        )

    if missing:
        print(
            f"  note: {len(missing)} CMIP7 scenarios omitted -- run "
            f"scripts/convert_scenariomip.py to include them"
        )
    return inputs


#: Species plotted in the scenario-context panel, as
#: METEOR column -> (display name, unit, factor from METEOR's unit).
#:
#: Three of the forty METEOR carries, annual, global. Enough to draw the figure
#: that situates a scenario; not an emissions inventory, which is the thing
#: this repository does not redistribute.
PLOTTED_SPECIES = [
    # (display name, unit, columns to sum, factor from METEOR's unit)
    ("CO2", "Gt CO2/yr", ["CO2_FF", "CO2_AFOLU"], 44.009 / 12.011),  # from Pg C
    ("CH4", "Mt CH4/yr", ["CH4"], 1.0),                              # already Tg
    ("SO2", "Mt SO2/yr", ["SO2"], 64.06 / 32.06),                    # from Tg S
]

#: Years the panel spans. Enough recent history to place the present.
PLOT_YEARS = (1990, 2100)


def export_plot_emissions(scenario_inputs_by_name, path):
    """
    Write the emissions the scenario-context panel plots.

    Deliberately a figure's worth of data rather than a dataset: three species
    of forty, annual, global, rounded to four significant figures. The CMIP7
    emissions are third-party and are not offered for download -- this is what
    the chart needs to draw, and the CSV export does not include it.

    CO2 is the sum of the two METEOR columns, fossil and land use, which is how
    scenario figures normally present it.
    """
    first, last = PLOT_YEARS
    out = {}
    for name, (emissions, _) in scenario_inputs_by_name.items():
        years = [int(y) for y in emissions.index if first <= int(y) <= last]
        series = {}
        for label, _unit, columns, factor in PLOTTED_SPECIES:
            values = emissions[columns].sum(axis=1)
            series[label] = [
                float(f"{float(values.loc[y]) * factor:.4g}") for y in years
            ]
        out[name] = series

    with open(path, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "note": (
                    "Annual global emissions for the scenario-context figure. "
                    "Three species of the forty METEOR carries. The CMIP7 "
                    "values derive from the ScenarioMIP release, which this "
                    "repository does not redistribute; see data/README.md."
                ),
                "units": {label: unit for label, unit, _, _f in PLOTTED_SPECIES},
                "years": years,
                "scenarios": out,
            },
            handle,
        )
    return path


def export_pr_climatology(field, path):
    """
    Write the gridded precipitation baseline the percent-change map divides by.

    Squeezed to (lat, lon): the CMIP6 reference arrives with a singleton
    ensemble axis that would otherwise travel all the way to the browser.
    Classic netCDF-3 and float32, like everything else a client reads.
    """
    array = field.squeeze()
    extra = [d for d in array.dims if d not in ("lat", "lon")]
    if extra:
        array = array.isel({d: 0 for d in extra})

    dataset = xr.Dataset(
        {"pr_climatology": (("lat", "lon"), array.values.astype(np.float32))},
        coords={"lat": array["lat"].values, "lon": array["lon"].values},
        attrs={
            "format": "meteor-pr-climatology",
            "schema_version": "1",
            "description": (
                "Annual-mean precipitation over the first year of the output "
                "window, the denominator for percent-change maps."
            ),
            "units": "kg m-2 s-1",
            "window_start": WINDOW[0],
        },
    )
    dataset.to_netcdf(path, format="NETCDF3_64BIT")
    print(f"wrote {path}  {os.path.getsize(path)/1024:.0f} KB")


def locations():
    locs = ["global"]
    locs += [f"regional:{r.abbrev}" for r in regionmask.defined_regions.ar6.all]
    locs += [f"point:{lat},{lon}" for lat, lon in CITIES.values()]
    return locs


def main():
    os.makedirs(OUT, exist_ok=True)
    locs = locations()
    print(f"{len(locs)} locations")

    scenarios = scenario_inputs()
    print(f"{len(scenarios)} scenarios: {sum(1 for k in scenarios if not k.startswith('cmip7'))} SSP, "
          f"{sum(1 for k in scenarios if k.startswith('cmip7'))} CMIP7")

    emu = MeteorInterface(MODEL, ["tas", "pr"], cache_dir=CACHE)
    emu.train(verbose=True)

    for var in ("tas", "pr"):
        noise = emu.noise_models[var]
        pattern = emu.pattern_models[var]

        ref = None
        if var == "pr":
            ref, baseline = emu._load_transform_reference(var, *WINDOW, verbose=True)
            # The map shows precipitation change as a percentage, which needs a
            # gridded denominator the pattern artifact does not carry. This is
            # the same first-year mean field the gamma fit already uses.
            export_pr_climatology(baseline, os.path.join(OUT, f"meteor_{MODEL}_pr_climatology_v1.nc"))

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
            scenarios=scenarios,
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
                cmip6_model=MODEL,
                training_scenario="ssp245",
                transform_reference=ref,
                transform_window=WINDOW if ref is not None else None,
                scenarios={"ssp245": scenarios["ssp245"]},
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

        # The map tier: the pattern-scaling artifact carries the spatial
        # patterns the bundle deliberately leaves out, so a client can
        # reconstruct the forced response anywhere on the grid rather than only
        # at the locations the bundle was built for.
        #
        # Rewritten as classic netCDF-3. export_pattern_scaling writes NETCDF4,
        # which is HDF5 and needs a megabyte-scale WebAssembly reader; classic
        # is the same numbers in the same space and the client already parses
        # it. Worth adding netcdf_format= upstream, as the bundle exporters
        # have, rather than converting here forever.
        pattern_path = os.path.join(OUT, f"meteor_{MODEL}_{var}_pattern_v1.nc")
        with tempfile.TemporaryDirectory() as tmp:
            hdf5 = os.path.join(tmp, "pattern.nc")
            export_pattern_scaling(
                pattern,
                hdf5,
                cmip6_model=MODEL,
                dtype=np.float32,
                source_url="https://github.com/benmsanderson/meteor-view",
            )
            xr.open_dataset(hdf5).load().to_netcdf(
                pattern_path, format="NETCDF3_64BIT"
            )
        print(f"wrote {pattern_path}  {os.path.getsize(pattern_path)/1e6:.2f} MB")

    emissions_path = os.path.join(OUT, "scenario_emissions_v1.json")
    export_plot_emissions(scenarios, emissions_path)
    print(f"wrote {emissions_path}  {os.path.getsize(emissions_path)/1024:.0f} KB")


if __name__ == "__main__":
    main()
