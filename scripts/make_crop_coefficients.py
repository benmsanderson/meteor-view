"""The crop yield emulator, reduced to what the site needs.

METEOR carries the GGCMI Phase 2 crop yield emulators (Franke et al. 2020,
doi:10.5194/gmd-13-3995-2020): for each crop model, crop and 0.5-degree grid
cell, a third-order polynomial giving the long-term mean rainfed yield from
CO2, the temperature change and precipitation ratio relative to 1980-2010
(AgMERRA), and nitrogen. The coefficients are 3.7 GB for the A0 (no
adaptation) set; this reduces them to the site's 2-degree map grid.

That reduction is exact, not an approximation, for two reasons. The
polynomial is linear in its coefficients, so the area-weighted mean yield of
the 0.5-degree cells within a 2-degree cell is the polynomial with their
area-weighted mean coefficients. And the site gives the emulator each climate
model's change, not its absolute climate (the delta method, as GGCMI's own
experiments were defined and as METEOR#111 proposes), and that change is one
value per 2-degree cell, so every 0.5-degree cell within it sees the same
inputs, clamped the same way. The one thing lost is the clipping of a
negative yield to zero, cell by cell, which only matters where a crop model
has a crop growing where it should not.

Weights are rainfed harvested area around 2000 (MIRCA2000 v1.1, Portmann et
al. 2010, doi:10.1029/2008GB003435), matching the emulator's rainfed
yields. MIRCA2000 does not split wheat into winter and spring wheat, which
the emulator treats separately; GGCMI's own rule does (Mueller et al. 2019,
doi:10.1038/s41597-019-0023-8): winter wheat where the coldest month of the
year averages between -10 and 5 degC, spring wheat elsewhere, here on
W5E5 v2.0 for 2001-2010. Wheat is then one crop, each 0.5-degree cell
contributing the coefficients of the wheat it grows: the same linearity.

Usage::

    python scripts/make_crop_coefficients.py <work dir>

with, in the work dir, ggcmi/*_A0.nc4 (Zenodo record 3592453),
mirca/harvested_area_grids/ (Zenodo record 7422506) and
w5e5_tas_2001_2010.nc (ISIMIP3a GSWP3-W5E5 obsclim, daily).

Writes data/crops_v1/: one little-endian float32 file per crop model and
crop, 35 values per 2-degree cell (the polynomial's 34 coefficients, and
the cell's harvested area in hectares),
and index.json, which lists the cells, the crop models and how each AR6
region shares each cell.
"""

import glob
import gzip
import json
import os
import sys

import numpy as np
import regionmask
import xarray as xr

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "crops_v1")

#: The site's map grid (src/app/summary.js, SUMMARY_GRID): 2-degree cells
#: centred on odd degrees, latitude from the south, longitude from 0.
GRID = {"lat": [-89.0, 2.0, 90], "lon": [1.0, 2.0, 180]}

#: What the site calls each crop, and the MIRCA2000 rainfed crop class.
CROPS = {"maize": 2, "rice": 3, "soy": 8, "wheat": 1}

#: Winter wheat where the coldest month is within this range, degC.
WINTER_WHEAT = (-10.0, 5.0)

VARIANT = "A0"
#: Values per cell in the output: the polynomial's 34 terms (Franke et al.
#: 2020, Eq. 1, which has no N^3 term), and the cell's harvested area.
N_COEFFICIENTS = 35
AREA_SLOT = 34

#: Crop models that ran one nitrogen level only (PROMET, for example) have a
#: 20-term emulator: Eq. 1 without the terms in N, in the same order. These
#: are their places among the 34.
WITHOUT_NITROGEN = [0, 1, 2, 3, 5, 6, 7, 9, 10, 12, 15, 16, 17, 19, 20, 22, 25, 26, 28, 31]


def read_mirca(path):
    """A MIRCA2000 30-arcminute ESRI ASCII grid, north row first, in hectares."""
    with gzip.open(path, "rt") as handle:
        header = [next(handle) for _ in range(6)]
        nodata = float(header[5].split()[1])
        values = np.loadtxt(handle, dtype=np.float64)
    values[values == nodata] = 0.0
    assert values.shape == (360, 720), values.shape
    return values


def coldest_month(path):
    """Mean temperature of the coldest calendar month, degC, on the 0.5-degree grid, north row first."""
    with xr.open_dataset(path) as ds:
        tas = ds["tas"]
        monthly = tas.groupby("time.month").mean("time") - 273.15
        coldest = monthly.min("month")
        coldest = coldest.sortby("lat", ascending=False).sortby("lon")
        return coldest.values


def emulator(work, model, crop):
    """One crop model's coefficients for one emulator crop, (35, 360, 720), north row first, or None."""
    path = os.path.join(work, "ggcmi", f"{model}_{crop}_ggcmi_phase2_emulator_{VARIANT}.nc4")
    if not os.path.exists(path):
        return None
    with xr.open_dataset(path, decode_times=False) as ds:
        k = ds["K_rf"]
        lat = ds[k.dims[1]].values
        values = k.values.astype(np.float64)
    if lat[0] < lat[-1]:
        values = values[:, ::-1, :]
    if values.shape[0] == len(WITHOUT_NITROGEN):
        full = np.zeros((AREA_SLOT,) + values.shape[1:])
        full[WITHOUT_NITROGEN] = values
        values = full
    if values.shape[0] != AREA_SLOT:
        raise ValueError(f"{path}: {values.shape[0]} coefficients, expected 34 or 20")
    return values


def cell_of():
    """Each 0.5-degree cell's 2-degree cell, as a flat index on the site's grid."""
    lat = 89.75 - 0.5 * np.arange(360)
    lon = -179.75 + 0.5 * np.arange(720)
    i = np.floor((lat + 90.0) / 2.0).astype(int)
    j = np.floor(np.mod(lon, 360.0) / 2.0).astype(int)
    return (i[:, None] * GRID["lon"][2] + j[None, :]), lat, lon


def main():
    work = sys.argv[1]
    os.makedirs(OUT, exist_ok=True)
    cells, lat, lon = cell_of()
    n_cells = GRID["lat"][2] * GRID["lon"][2]

    regions = regionmask.defined_regions.ar6.all
    region_of = regions.mask(lon, lat).values  # NaN outside every region
    codes = [regions[int(n)].abbrev for n in regions.numbers]
    numbers = list(regions.numbers)

    cached = os.path.join(work, "coldest_month.npy")
    if not os.path.exists(cached):
        np.save(cached, coldest_month(os.path.join(work, "w5e5_tas_2001_2010.nc")))
    coldest = np.load(cached)
    winter = (coldest > WINTER_WHEAT[0]) & (coldest < WINTER_WHEAT[1])

    models = sorted({os.path.basename(p).split("_")[0] for p in glob.glob(os.path.join(work, "ggcmi", "*.nc4"))})
    index = {
        "format": "meteor-view-crop-emulator",
        "schema_version": 1,
        "grid": GRID,
        "variant": VARIANT,
        "coefficients": N_COEFFICIENTS,  # values per cell
        "area_slot": AREA_SLOT,
        "sources": {
            "emulator": "GGCMI Phase 2 emulators, Franke et al. 2020, doi:10.5194/gmd-13-3995-2020 (Zenodo 3592453)",
            "area": "MIRCA2000 v1.1 rainfed harvested area, Portmann et al. 2010, doi:10.1029/2008GB003435",
            "wheat": "winter wheat where the coldest month averages -10 to 5 degC (GGCMI, Mueller et al. 2019, "
            "doi:10.1038/s41597-019-0023-8), on W5E5 v2.0 2001-2010",
        },
        "crops": {},
    }

    for crop, mirca in CROPS.items():
        area = read_mirca(
            os.path.join(work, "mirca", "harvested_area_grids", f"annual_area_harvested_rfc_crop{mirca:02d}_ha_30mn.asc.gz")
        )
        # Which emulator each 0.5-degree cell takes.
        if crop == "wheat":
            parts = [("winter_wheat", area * winter), ("spring_wheat", area * ~winter)]
        else:
            parts = [(crop, area)]

        # The 2-degree cells growing the crop, in grid order.
        total = np.bincount(cells.ravel(), weights=area.ravel(), minlength=n_cells)
        kept = np.flatnonzero(total > 0)
        position = np.full(n_cells, -1)
        position[kept] = np.arange(kept.size)

        entry = {"cells": kept.tolist(), "area_ha": round(float(area.sum())), "models": [], "regions": {}}

        # How the regions share each cell, by the crop's area.
        share = {}
        for number, code in zip(numbers, codes):
            inside = np.where(region_of == number, area, 0.0)
            by_cell = np.bincount(cells.ravel(), weights=inside.ravel(), minlength=n_cells)[kept]
            nonzero = np.flatnonzero(by_cell > 0)
            if nonzero.size:
                share[code] = [[int(k), round(float(by_cell[k] / total[kept][k]), 4)] for k in nonzero]
        entry["regions"] = share

        for model in models:
            loaded = [(emulator(work, model, name), weights) for name, weights in parts]
            if any(k is None for k, _ in loaded):
                continue  # this crop model did not simulate this crop (or one of the wheats)
            out = np.zeros((kept.size, N_COEFFICIENTS))
            weight = np.zeros(kept.size)
            for k, weights in loaded:
                # A cell the crop model did not simulate has no emulator:
                # NaN in some files, every coefficient zero in most.
                valid = np.all(np.isfinite(k), axis=0) & np.any(k != 0, axis=0) & (weights > 0)
                w = np.where(valid, weights, 0.0)
                flat = cells.ravel()
                for c in range(AREA_SLOT):
                    sums = np.bincount(flat, weights=(np.where(valid, k[c], 0.0) * w).ravel(), minlength=n_cells)
                    out[:, c] += sums[kept]
                weight += np.bincount(flat, weights=w.ravel(), minlength=n_cells)[kept]
            with np.errstate(invalid="ignore", divide="ignore"):
                out[:, :AREA_SLOT] /= weight[:, None]
            out[weight == 0, :AREA_SLOT] = 0.0
            out[:, AREA_SLOT] = weight
            name = f"{model}_{crop}_{VARIANT}.f32"
            out.astype("<f4").tofile(os.path.join(OUT, name))
            entry["models"].append(model)
            covered = weight.sum() / max(total[kept].sum(), 1)
            print(f"{crop:6s} {model:10s} {kept.size} cells, {covered:.1%} of the harvested area covered")
        index["crops"][crop] = entry

    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as handle:
        json.dump(index, handle, separators=(",", ":"))
        handle.write("\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
