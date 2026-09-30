"""Observed degree-day curves: the bias correction for the site's degree days.

Degree days depend on absolute temperature, which a climate model can have a
few degrees off at any one place, and on the spread of daily temperatures
within a month, which METEOR's monthly output does not carry. So the site
takes both from observations and only the *change* from the models: for each
place and calendar month, this script records how that month's heating and
cooling degree days in the observed 1995-2014 climate respond to a uniform
shift in temperature. The browser, or the build, then reads each model's
warming for that month off the curve.

Two curves per month, because the two views need different things:

- ``climate``: every observed day, shifted. For a model's forced response,
  which has no year-to-year variability of its own, so the observed
  variability of monthly means stays in.
- ``within``: every observed day, less its own month's mean, plus that
  calendar month's 1995-2014 mean, then shifted. For a realization, which
  brings its own year-to-year variability of monthly means; keeping the
  observed variability too would count it twice.

Observations are W5E5 v2.0 (Lange et al. 2021, doi:10.48364/ISIMIP.342217),
daily mean near-surface temperature on a 0.5-degree grid, published by
ISIMIP as GSWP3-W5E5 (W5E5 from 1979), and its land-sea mask. Places follow
the bundles: AR6 land regions average over their land gridboxes, cos-latitude
weighted, the mixed regions MED, CAR and SEA too, since degree days are about
where people live; ocean regions and the global mean get no curves; a city is
the nearest land gridbox.

For a region this averages each gridbox's degree days, not the degree days of
the region's average temperature, which would understate both.

Usage::

    python scripts/make_degree_day_curves.py <dir with the three W5E5 tas files and landseamask.nc>

Writes data/degree_days_v1/<place>.json, about 40 KB each.
"""

import glob
import json
import os
import sys

import numpy as np
import regionmask
import xarray as xr

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
#: Any bundle: the places, exactly as the site names them.
BUNDLE = os.path.join(ROOT, "data", "meteor_NorESM2-MM_tas_bundle_v1.nc")
OUT = os.path.join(ROOT, "data", "degree_days_v1")

BASE = 18.0  # °C, METEOR's default, for heating and cooling alike
PERIOD = (1995, 2014)  # the AR6 recent reference period
SHIFTS = {"start": -15.0, "step": 0.25, "n": 141}  # -15 to +20 °C
BIN = 0.05  # °C, the histogram resolution the curves are summed from
LOW, HIGH = -90.0, 60.0


def slug(location):
    return "".join(c if c.isalnum() or c in ".-" else "_" for c in location)


def places(lat, lon, land):
    """Each place's gridboxes and weights: {spec: (flat indices, weights)}."""
    lon2d, lat2d = np.meshgrid(lon, lat)
    coslat = np.cos(np.deg2rad(lat2d))
    out = {}
    ar6 = regionmask.defined_regions.ar6
    numbers = ar6.all.mask(lon, lat).values
    land_abbrevs = set(ar6.land.abbrevs)
    for region in ar6.all:
        if region.abbrev not in land_abbrevs:
            continue
        cells = (numbers == region.number) & land
        if cells.any():
            idx = np.flatnonzero(cells)
            w = coslat.ravel()[idx]
            out[f"regional:{region.abbrev}"] = (idx, w / w.sum())
    # Cities: the nearest land gridbox, by great-circle distance.
    la, lo = np.deg2rad(lat2d), np.deg2rad(lon2d)
    with xr.open_dataset(BUNDLE) as bundle:
        points = [str(s) for s in bundle["location"].values if str(s).startswith("point:")]
    for spec in points:
        city_lat, city_lon = map(float, spec[len("point:"):].split(","))
        t_la, t_lo = np.deg2rad(city_lat), np.deg2rad(city_lon)
        cos_d = np.sin(la) * np.sin(t_la) + np.cos(la) * np.cos(t_la) * np.cos(lo - t_lo)
        cos_d = np.where(land, cos_d, -2.0)
        out[spec] = (np.array([np.argmax(cos_d)]), np.array([1.0]))
    return out


def open_years(directory):
    files = sorted(glob.glob(os.path.join(directory, "*_obsclim_tas_global_daily_*.nc")))
    ds = xr.open_mfdataset(files, combine="by_coords")
    return ds["tas"].sel(time=slice(f"{PERIOD[0]}-01-01", f"{PERIOD[1]}-12-31"))


def curves_from_histograms(hist, n_years):
    """HDD and CDD curves from a (12, bins) weighted histogram of daily °C."""
    centres = LOW + BIN * (np.arange(hist.shape[1]) + 0.5)
    shifts = SHIFTS["start"] + SHIFTS["step"] * np.arange(SHIFTS["n"])
    shifted = centres[None, :] + shifts[:, None]  # (shift, bin)
    heat = np.maximum(BASE - shifted, 0.0)
    cool = np.maximum(shifted - BASE, 0.0)
    # Degree days per month, averaged over the years of the period.
    hdd = hist @ heat.T / n_years  # (12, shift)
    cdd = hist @ cool.T / n_years
    return np.round(hdd, 2), np.round(cdd, 2)


def main(directory):
    mask = xr.open_dataset(os.path.join(directory, "landseamask.nc"))["mask"]
    tas = open_years(directory)
    lat, lon = tas["lat"].values, tas["lon"].values
    land = mask.reindex_like(tas.isel(time=0), method="nearest").values > 0.5
    where = places(lat, lon, land)
    cells = np.unique(np.concatenate([idx for idx, _ in where.values()]))
    column = {c: i for i, c in enumerate(cells)}
    n_bins = int(round((HIGH - LOW) / BIN))
    years = range(PERIOD[0], PERIOD[1] + 1)
    n_years = len(years)

    # Pass 1: daily values at the gridboxes used, and their monthly means.
    daily = {}
    month_means = np.zeros((n_years, 12, cells.size))
    for k, year in enumerate(years):
        block = tas.sel(time=str(year)).values.reshape(-1, lat.size * lon.size)[:, cells] - 273.15
        months = tas.sel(time=str(year))["time"].dt.month.values - 1
        daily[year] = (block.astype(np.float32), months)
        for m in range(12):
            month_means[k, m] = block[months == m].mean(axis=0)
        print(f"read {year}", flush=True)
    climatology = month_means.mean(axis=0)  # (12, cells)

    os.makedirs(OUT, exist_ok=True)
    for spec, (idx, weights) in where.items():
        cols = np.array([column[c] for c in idx])
        hist = {"climate": np.zeros((12, n_bins)), "within": np.zeros((12, n_bins))}
        monthly_mean = np.zeros(12)
        for k, year in enumerate(years):
            block, months = daily[year]
            values = block[:, cols]
            for m in range(12):
                rows = values[months == m]
                kinds = {
                    "climate": rows,
                    "within": rows - month_means[k, m, cols] + climatology[m, cols],
                }
                for kind, v in kinds.items():
                    bins = np.clip(((v - LOW) / BIN).astype(int), 0, n_bins - 1)
                    w = np.broadcast_to(weights, v.shape)
                    hist[kind][m] += np.bincount(bins.ravel(), w.ravel(), minlength=n_bins)
        monthly_mean = climatology[:, cols] @ weights
        record = {
            "format": "meteor-view-degree-days",
            "schema_version": 1,
            "location": spec,
            "observations": "W5E5 v2.0 (GSWP3-W5E5, ISIMIP3a), doi:10.48364/ISIMIP.342217",
            "period": list(PERIOD),
            "base_temperature": BASE,
            "gridboxes": int(idx.size),
            "shifts": SHIFTS,
            "observed_monthly_tas": np.round(monthly_mean, 3).tolist(),
        }
        for kind in ("climate", "within"):
            hdd, cdd = curves_from_histograms(hist[kind], n_years)
            record[kind] = {"hdd": hdd.tolist(), "cdd": cdd.tolist()}
        zero = int(round(-SHIFTS["start"] / SHIFTS["step"]))
        record["observed_annual"] = {
            "hdd": round(float(np.sum(record["climate"]["hdd"], axis=0)[zero]), 1),
            "cdd": round(float(np.sum(record["climate"]["cdd"], axis=0)[zero]), 1),
        }
        with open(os.path.join(OUT, f"{slug(spec)}.json"), "w", encoding="utf-8") as handle:
            json.dump(record, handle, separators=(",", ":"))
        print(f"{spec:22s} {idx.size:6d} boxes  HDD {record['observed_annual']['hdd']:7.0f}  CDD {record['observed_annual']['cdd']:6.0f}")


if __name__ == "__main__":
    main(sys.argv[1])
