"""Convert the ScenarioMIP-CMIP7 release into METEOR's emissions format.

Route C of `docs/03-roadmap.md`: drive METEOR's own CICERO-SCM with CMIP7
emissions, so CMIP7 scenarios and the CMIP6 SSPs share a simple climate model
and can honestly sit in the same menu. Driving from MAGICC's assessed forcing
instead would be cheaper and would make the two families differ by 0.74 W/m2 of
present-day forcing for reasons the user cannot see.

**The release is not redistributed by this repository.** Download it yourself:

    https://scenariomip.apps.ece.iiasa.ac.at
    10.5281/zenodo.19825038  ->  ScenarioMIP_emissions_marker_scenarios_v0.2.xlsx

This writes METEOR-format emissions into a working directory that is
gitignored, and only the *forcing* CICERO derives from them ever reaches a
committed bundle. That is the line: forcing is a derived product several steps
from the source; a tidy CSV of the emissions themselves would be re-hosting
them.

Usage::

    PYTHONPATH=<meteor>/src python scripts/convert_scenariomip.py \\
        ~/Downloads/ScenarioMIP_emissions_marker_scenarios_v0.2.xlsx

Needs `openpyxl`, which METEOR does not require:

    pip install openpyxl
"""

import os
import sys

# --- Species mapping -------------------------------------------------------
#
# METEOR column -> (release species, factor). Units on each side differ and the
# factors below are molecular-weight or scale conversions, never guesses:
#
#   Mt CO2  -> Pg C    12.011/44.009 / 1000
#   kt N2O  -> Tg N    28.014/44.013 / 1000
#   Mt SO2  -> Tg S    32.06/64.06          (Mt and Tg are the same unit)
#   Mt NO2  -> Mt N    14.007/46.006
#   kt X    -> Gg X    1                    (a kilotonne is a gigagram)
#   Mt X    -> Tg X    1
#
CO2_TO_C = 12.011 / 44.009 / 1000.0
N2O_TO_N = 28.014 / 44.013 / 1000.0
SO2_TO_S = 32.06 / 64.06
NO2_TO_N = 14.007 / 46.006

SPECIES = {
    "CO2_fossil_fuel": ("CO2|Energy and Industrial Processes", CO2_TO_C),
    "CO2_landuse": ("CO2|AFOLU", CO2_TO_C),
    "CH4": ("CH4", 1.0),
    "N2O": ("N2O", N2O_TO_N),
    "SO2": ("Sulfur", SO2_TO_S),
    "CFC-11": ("CFC11", 1.0),
    "CFC-12": ("CFC12", 1.0),
    "CFC-113": ("CFC113", 1.0),
    "CFC-114": ("CFC114", 1.0),
    "CFC-115": ("CFC115", 1.0),
    "CH3Br": ("CH3Br", 1.0),
    "CCl4": ("CCl4", 1.0),
    "CH3CCl3": ("CH3CCl3", 1.0),
    "HCFC-22": ("HCFC22", 1.0),
    "HCFC-141b": ("HCFC141b", 1.0),
    # The release carries no HCFC-123, and neither do METEOR's own SSP files --
    # their Reference row reads "No data" for it -- so leaving it at zero
    # matches the existing behaviour rather than introducing a gap.
    "HCFC-123": (None, 0.0),
    "HCFC-142b": ("HCFC142b", 1.0),
    "H-1211": ("Halon1211", 1.0),
    "H-1301": ("Halon1301", 1.0),
    "H-2402": ("Halon2402", 1.0),
    "HFC125": ("HFC|HFC125", 1.0),
    "HFC134a": ("HFC|HFC134a", 1.0),
    "HFC143a": ("HFC|HFC143a", 1.0),
    "HFC227ea": ("HFC|HFC227ea", 1.0),
    "HFC23": ("HFC|HFC23", 1.0),
    "HFC245fa": ("HFC|HFC245fa", 1.0),
    "HFC32": ("HFC|HFC32", 1.0),
    "HFC4310mee": ("HFC|HFC43-10", 1.0),
    "C2F6": ("C2F6", 1.0),
    "C6F14": ("C6F14", 1.0),
    "CF4": ("CF4", 1.0),
    "SF6": ("SF6", 1.0),
    "NOx": ("NOx", NO2_TO_N),
    "CO": ("CO", 1.0),
    "NMVOC": ("VOC", 1.0),
    "NH3": ("NH3", 1.0),
    # BC and OC are split below rather than mapped directly; see split_aerosol.
    "BMB_AEROS_BC": (None, 0.0),
    "BMB_AEROS_OC": (None, 0.0),
    "BC": ("BC", 1.0),
    "OC": ("OC", 1.0),
}

#: Species the release carries that METEOR cannot ingest. Their forcing is lost;
#: all are small, but the list is here so the loss is explicit rather than
#: silent.
DROPPED = [
    "C3F8", "C4F10", "C5F12", "C7F16", "C8F18", "cC4F8", "NF3", "SO2F2",
    "CH2Cl2", "CHCl3", "CH3Cl", "Halon1202", "HFC|HFC152a", "HFC|HFC236fa",
    "HFC|HFC365mfc",
]

#: Marker scenario -> the short name a bundle will carry.
SCENARIOS = {
    "Very Low - SSP1 (Marker)": "cmip7-very-low",
    "Low - SSP2 (Marker)": "cmip7-low",
    "Low-to-Negative - SSP2 (Marker)": "cmip7-low-to-negative",
    "Medium-to-Low - SSP2 (Marker)": "cmip7-medium-to-low",
    "Medium - SSP2 (Marker)": "cmip7-medium",
    "High-to-Low - SSP5 (Marker)": "cmip7-high-to-low",
    "High - SSP3 (Marker)": "cmip7-high",
}

#: The SSP whose history and concentrations the CMIP7 scenarios inherit. The
#: release starts in 2000; METEOR's forcing axis starts in 1750, and the first
#: hundred years are concentration-driven, so both the early emissions and the
#: concentration file have to come from somewhere. The CMIP7 emissions are
#: harmonized *to* this history, which is what makes the splice defensible --
#: and what the 2015 agreement check below tests.
HISTORY_SCENARIO = "ssp245"

#: First year taken from the release. Before this, history is used.
#:
#: The release's year columns start at 2000 but are empty until 2023, which is
#: its harmonization year. Splicing there takes every year it actually has.
SPLICE_YEAR = 2023


def find_meteor_data():
    """
    Locate METEOR's bundled scenario inputs.

    Only the data directory is needed, not a working METEOR install, so an
    explicit path is accepted too — this script otherwise depends on nothing
    but openpyxl.
    """
    override = os.environ.get("METEOR_DATA")
    if override:
        return override
    try:
        import meteor.scm_input_lib as lib  # noqa: PLC0415

        return os.path.join(os.path.dirname(lib.__file__), "default_scm_data")
    except ImportError:
        pass
    for root in (os.environ.get("PYTHONPATH") or "").split(os.pathsep):
        candidate = os.path.join(root, "meteor", "default_scm_data")
        if os.path.isdir(candidate):
            return candidate
    raise SystemExit(
        "cannot find METEOR's default_scm_data; set METEOR_DATA to its path"
    )


def read_release(path):
    """Emissions by scenario and species, as {scenario: {species: {year: value}}}."""
    import openpyxl  # noqa: PLC0415 — an operational dependency, not a library one

    workbook = openpyxl.load_workbook(path, read_only=True)
    rows = workbook["data"].iter_rows(values_only=True)
    header = [str(h) for h in next(rows)]
    years = [h for h in header if h.isdigit()]

    prefix = "Climate Assessment|Harmonized and Infilled|Emissions|"
    out = {}
    for row in rows:
        record = dict(zip(header, row))
        variable = record.get("variable") or ""
        if not variable.startswith(prefix):
            continue
        scenario = record.get("scenario")
        if scenario not in SCENARIOS:
            continue
        species = variable[len(prefix) :]
        out.setdefault(scenario, {})[species] = {
            int(y): (0.0 if record[y] is None else float(record[y])) for y in years
        }
    return out, [int(y) for y in years]


def read_meteor_emissions(path):
    """METEOR's tab-separated emissions file as (header_lines, {year: [values]})."""
    with open(path, encoding="utf-8") as handle:
        lines = handle.read().rstrip("\n").split("\n")
    header = lines[:4]
    data = {}
    for line in lines[4:]:
        parts = line.split("\t")
        if not parts[0].strip():
            continue
        data[int(parts[0])] = [p.strip() for p in parts[1:]]
    return header, data


def split_aerosol(total, history_open, history_biomass):
    """
    Split a total BC or OC emission into open-burning and other.

    The release gives one number per species; METEOR wants biomass burning
    separately, because CICERO gives the two different forcing efficiencies.
    The split keeps the history's own ratio for that year, which preserves the
    total exactly and leaves the partition as close to METEOR's SSP files as
    the available information allows.
    """
    denominator = history_open + history_biomass
    if denominator <= 0:
        return total, 0.0
    fraction = history_biomass / denominator
    return total * (1.0 - fraction), total * fraction


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    release_path = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "scenario-work"

    meteor_data = find_meteor_data()
    history_path = os.path.join(meteor_data, f"{HISTORY_SCENARIO}_em_RCMIP.txt")
    header, history = read_meteor_emissions(history_path)
    columns = [c.strip() for c in header[0].split("\t")[1:]]

    # The two CO2 columns share a name and are told apart by the description
    # row, so index them by position rather than by name.
    descriptions = [d.strip() for d in header[2].split("\t")[1:]]
    keys = []
    for name, description in zip(columns, descriptions):
        keys.append(f"{name}_{description}" if name == "CO2" else name)

    release, release_years = read_release(release_path)
    os.makedirs(out_dir, exist_ok=True)

    print(f"history: {HISTORY_SCENARIO}, spliced from {SPLICE_YEAR}")
    print(f"dropping {len(DROPPED)} species METEOR cannot ingest\n")

    for scenario, short in SCENARIOS.items():
        if scenario not in release:
            print(f"  {short}: not in the release, skipped")
            continue
        species = release[scenario]

        lines = list(header)
        for year in sorted(history):
            values = list(history[year])
            if year >= SPLICE_YEAR and year in release_years:
                bc_open, bc_bmb = split_aerosol(
                    species["BC"][year],
                    float(history[year][keys.index("BC")]),
                    float(history[year][keys.index("BMB_AEROS_BC")]),
                )
                oc_open, oc_bmb = split_aerosol(
                    species["OC"][year],
                    float(history[year][keys.index("OC")]),
                    float(history[year][keys.index("BMB_AEROS_OC")]),
                )
                overrides = {
                    "BC": bc_open,
                    "BMB_AEROS_BC": bc_bmb,
                    "OC": oc_open,
                    "BMB_AEROS_OC": oc_bmb,
                }
                for i, key in enumerate(keys):
                    if key in overrides:
                        values[i] = f"{overrides[key]:.8f}"
                        continue
                    source, factor = SPECIES.get(key, (None, 0.0))
                    if source is None:
                        continue
                    if source not in species:
                        raise KeyError(f"{short}: release has no {source!r}")
                    values[i] = f"{species[source][year] * factor:.8f}"
            lines.append(f"{year} \t " + "\t".join(values))

        path = os.path.join(out_dir, f"{short}_em_RCMIP.txt")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")

        # Concentrations drive only the first hundred years, which are pure
        # history, so the SSP file is the right one for every CMIP7 scenario.
        source = os.path.join(meteor_data, f"{HISTORY_SCENARIO}_conc_RCMIP.txt")
        with open(source, encoding="utf-8") as src:
            conc = src.read()
        with open(
            os.path.join(out_dir, f"{short}_conc_RCMIP.txt"), "w", encoding="utf-8"
        ) as dst:
            dst.write(conc)

        print(f"  {short}: {os.path.getsize(path)/1024:.0f} KB")

    print(f"\nwrote to {out_dir}/ (gitignored: the release is not redistributed)")


if __name__ == "__main__":
    main()
