"""Land-aware location weights for the bundle exporter, following the AR6 Atlas.

METEOR averages an AR6 region over every gridpoint inside its polygon, land or
sea, and takes a point as its nearest gridbox. The AR6 WGI Interactive Atlas
instead averages land regions over land (IPCC-WG1/Atlas,
``datasets-aggregated-regionally/scripts/calculate_regional_means.R``: land is
land fraction > 0.5, sea < 0.5, weights cos latitude). Measured on six CMIP6
models, the difference in 2015-2034 to 2081-2100 warming is a median 0.07 C
but reaches 0.3-0.6 C in coastal regions -- NEU, RAR, northern and southern
Australia -- which is where an impacts user will compare against the Atlas.

So, decided 2026-09-26:

- **Land regions** (43 of AR6's 46 land regions): land gridboxes only.
- **Ocean regions**: unchanged. Sea-only and all-points differ by at most
  0.02 C, and sea-only would need a second mask for no gain.
- **The three mixed regions**, MED, CAR and SEA: all points, unchanged. CAR is
  3% land, so a land-only mean would rest on one or two gridboxes of a coarse
  grid.
- **Points** (the cities): the nearest gridbox that is more than half land, so
  a coastal city does not land on a sea gridbox of a coarse grid.

This does not change METEOR. The bundle exporter reduces fields to locations
through two module-level helpers in ``meteor.timeseries_bundle`` --
``_noise_weight_vector`` for the noise and seasonal terms and ``_project_field``
for the forced patterns and the precipitation transform -- and
:func:`install` wraps both. Anything the wrappers do not handle falls through
to METEOR's own code. The right long-term home is an option in METEOR itself.

Land fraction is each model's own ``sftlf`` from the CMIP6 cloud archive. For
the handful of models that publish none it is the Atlas's own 1-degree land
fraction, interpolated to the model grid, and the bundle says so.
"""

import os

import numpy as np
import pandas as pd
import regionmask
import xarray as xr

CATALOG_URL = "https://storage.googleapis.com/cmip6/cmip6-zarr-consolidated-stores.csv"

#: The Atlas's mixed regions, averaged over all points.
MIXED = {"MED", "CAR", "SEA"}

_AR6 = regionmask.defined_regions.ar6
#: AR6 land regions averaged over land only.
LAND_ONLY = set(_AR6.land.abbrevs) - MIXED

#: A gridbox is land when more than this fraction of it is.
THRESHOLD = 0.5

#: Where the Atlas's own 1-degree land fraction lives, for models without sftlf.
ATLAS_MASK = os.environ.get(
    "ATLAS_LANDMASK",
    os.path.join(os.path.dirname(__file__), "..", "..", "Atlas", "reference-grids", "land_sea_mask_1degree.nc4"),
)


def _wrap(lon):
    return np.mod(np.asarray(lon, dtype=float), 360.0)


def _catalog(cache):
    path = os.path.join(cache, "cmip6", "cmip6-zarr-consolidated-stores.csv")
    if os.path.exists(path):
        return pd.read_csv(path)
    return pd.read_csv(CATALOG_URL)


def load_land_fraction(model, lat, lon, cache):
    """
    The model's land fraction on its grid, 0 to 1, and where it came from.

    Cached under ``<cache>/landfrac`` so a re-export does not refetch it.

    Returns
    -------
    (np.ndarray, str)
        ``(n_lat, n_lon)`` fraction, and its source for the bundle's metadata.
    """
    lat = np.asarray(lat, dtype=float)
    lon = np.asarray(lon, dtype=float)
    store = os.path.join(cache, "landfrac", f"{model}_sftlf.nc")
    if os.path.exists(store):
        with xr.open_dataset(store) as ds:
            cached = ds.load()
        if cached.sizes["lat"] == lat.size and cached.sizes["lon"] == lon.size:
            return cached["frac"].values, cached.attrs["source"]

    catalog = _catalog(cache)
    rows = catalog[
        (catalog.source_id == model) & (catalog.table_id == "fx") & (catalog.variable_id == "sftlf")
    ]
    if len(rows):
        import gcsfs

        # Any experiment will do: land fraction is fixed. Prefer the native grid.
        rows = rows.sort_values("grid_label", key=lambda s: s != "gn")
        fs = gcsfs.GCSFileSystem(token="anon")
        field = xr.open_zarr(fs.get_mapper(rows.iloc[0].zstore), consolidated=True)["sftlf"].load()
        source = f"CMIP6 sftlf ({rows.iloc[0].zstore.rstrip('/')})"
        field = field.squeeze(drop=True)
        scale = 100.0 if float(field.max()) > 1.5 else 1.0
        field = field / scale
        method = "nearest"
    else:
        with xr.open_dataset(ATLAS_MASK) as ds:
            field = ds["sftlf"].load()
        source = "IPCC-WG1/Atlas land_sea_mask_1degree.nc4, interpolated (model publishes no sftlf)"
        method = "linear"

    # Onto the model grid: 0-360 longitudes, ascending, then interpolated. For
    # a model's own sftlf the grids match and "nearest" is exact.
    field = field.assign_coords(lon=_wrap(field.lon)).sortby("lon").sortby("lat")
    padded = xr.concat(
        [field.isel(lon=[-1]).assign_coords(lon=field.lon[-1:] - 360), field,
         field.isel(lon=[0]).assign_coords(lon=field.lon[:1] + 360)],
        dim="lon",
    )
    frac = padded.interp(lat=xr.DataArray(lat, dims="lat"), lon=xr.DataArray(_wrap(lon), dims="lon"),
                         method=method, kwargs={"fill_value": None}).values
    frac = np.clip(np.nan_to_num(frac, nan=0.0), 0.0, 1.0)

    os.makedirs(os.path.dirname(store), exist_ok=True)
    xr.Dataset({"frac": (("lat", "lon"), frac)}, coords={"lat": lat, "lon": lon},
               attrs={"source": source}).to_netcdf(store)
    return frac, source


class LandMasks:
    """Region and point masks on one model grid, cached per grid."""

    def __init__(self, model, cache):
        self.model = model
        self.cache = cache
        self._grids = {}
        self.fallbacks = set()
        self.source = None

    def _grid(self, lat, lon):
        key = (len(lat), len(lon), float(lat[0]), float(lon[0]))
        if key not in self._grids:
            frac, self.source = load_land_fraction(self.model, lat, lon, self.cache)
            regions = _AR6.all.mask(_wrap(lon), np.asarray(lat, dtype=float)).values
            self._grids[key] = {"frac": frac, "regions": regions, "lat": np.asarray(lat), "lon": np.asarray(lon)}
        return self._grids[key]

    def region(self, code, lat, lon):
        """Land-only mask for an AR6 land region, or None to use METEOR's own."""
        if code not in LAND_ONLY:
            return None
        grid = self._grid(lat, lon)
        inside = grid["regions"] == _AR6.all.map_keys(code)
        land = inside & (grid["frac"] > THRESHOLD)
        if not land.any():
            # A region with no gridbox over half land on this grid: fall back
            # to every point in it rather than to nothing, and record it.
            self.fallbacks.add(code)
            return None
        return land

    def point(self, target_lat, target_lon, lat, lon):
        """Mask selecting the nearest gridbox that is more than half land."""
        grid = self._grid(lat, lon)
        la = np.deg2rad(grid["lat"])[:, None]
        lo = np.deg2rad(_wrap(grid["lon"]))[None, :]
        t_la, t_lo = np.deg2rad(target_lat), np.deg2rad(_wrap(target_lon))
        # Great-circle distance, so longitude is measured at the right scale.
        cos_d = np.sin(la) * np.sin(t_la) + np.cos(la) * np.cos(t_la) * np.cos(lo - t_lo)
        cos_d = np.where(grid["frac"] > THRESHOLD, cos_d, -2.0)
        i, j = np.unravel_index(np.argmax(cos_d), cos_d.shape)
        mask = np.zeros_like(grid["frac"], dtype=bool)
        mask[i, j] = True
        return mask

    def describe(self):
        """For the bundle's metadata."""
        text = (
            "AR6 land regions averaged over land gridboxes only (land fraction > 0.5, "
            "cos-latitude weights), as the AR6 WGI Atlas; ocean regions and the mixed "
            "regions MED, CAR and SEA over all gridboxes; points at the nearest gridbox "
            "more than half land."
        )
        if self.fallbacks:
            text += f" No land gridbox on this grid, so all gridboxes used: {', '.join(sorted(self.fallbacks))}."
        return text


def _weighted_mean(field, mask):
    """Cos-latitude weighted mean of an xarray field over a (lat, lon) mask."""
    lat = field["lat"].values
    weights = np.cos(np.deg2rad(lat))[:, None] * mask
    values = field.transpose(..., "lat", "lon").values
    return np.nansum(values * weights, axis=(-2, -1)) / weights.sum()


def install(model, cache):
    """
    Wrap METEOR's two location-weight helpers with land-aware ones.

    Returns the :class:`LandMasks`, whose ``describe()`` belongs in the bundle's
    metadata once the export has run.
    """
    from meteor import timeseries_bundle as tb

    masks = LandMasks(model, cache)
    original_noise = tb._noise_weight_vector
    original_project = tb._project_field

    def noise_weight_vector(noise_model, location):
        lat, lon = noise_model.coords["lat"], noise_model.coords["lon"]
        if location["kind"] == "region":
            mask = masks.region(location["region"], lat, lon)
            if mask is not None:
                return noise_model.region_weight_vector(region_mask=mask)
        if location["kind"] == "point":
            mask = masks.point(location["lat"], location["lon"], lat, lon)
            return noise_model.region_weight_vector(region_mask=mask)
        return original_noise(noise_model, location)

    def project_field(field, location):
        lat, lon = field["lat"].values, field["lon"].values
        if location["kind"] == "region":
            mask = masks.region(location["region"], lat, lon)
            if mask is not None:
                return np.asarray(_weighted_mean(field, mask))
        if location["kind"] == "point":
            mask = masks.point(location["lat"], location["lon"], lat, lon)
            return np.asarray(_weighted_mean(field, mask))
        return original_project(field, location)

    tb._noise_weight_vector = noise_weight_vector
    tb._project_field = project_field
    return masks


def export_land_fraction(masks, lat, lon, path):
    """
    The land fraction on the pattern grid, for the browser: drawn regions can
    then average over land too. Whole percent in bytes, ~55 KB at 1 degree.
    """
    frac, source = load_land_fraction(masks.model, lat, lon, masks.cache)
    return xr.Dataset(
        {"land_percent": (("lat", "lon"), np.round(frac * 100).astype(np.int8))},
        coords={"lat": np.asarray(lat, dtype=np.float32), "lon": np.asarray(lon, dtype=np.float32)},
        attrs={
            "format": "meteor-land-fraction",
            "schema_version": "1",
            "description": "Land area fraction of each gridbox, percent.",
            "source": source,
            "land_threshold_percent": int(THRESHOLD * 100),
        },
    )
