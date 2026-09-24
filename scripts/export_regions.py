"""Export AR6 reference-region outlines and coastlines for the map.

A field of numbers with no geography is unreadable, and these regions are
already what the tool selects by, so their outlines serve twice: as the
landmarks you orient by, and as the thing you click to choose a region.

They are cheap. AR6 regions are largely rectilinear, so simplifying at a
quarter-degree takes all 58 from ~617 KB of raw GeoJSON to ~8 KB while moving
no vertex by more than a fraction of a gridbox.

Coastlines come from Natural Earth via the same route -- public domain, no new
dependency. Simplified at 0.2 degrees they are ~122 KB; 0.5 would halve that
and looks visibly ragged against a 1-degree grid, which is the wrong economy
for the one thing on the map a reader recognises.

Usage::

    PYTHONPATH=<meteor>/src python scripts/export_regions.py data/
"""

import json
import os
import sys

import regionmask
from shapely.geometry import mapping

#: Degrees. The grid is 0.94 x 1.25, so this is well inside one gridbox.
TOLERANCE = 0.25


def rings(geometry):
    """Exterior rings as [[lon, lat], ...], dropping holes (AR6 has none)."""
    shape = mapping(geometry)
    if shape["type"] == "Polygon":
        return [[[round(x, 3), round(y, 3)] for x, y in shape["coordinates"][0]]]
    return [
        [[round(x, 3), round(y, 3)] for x, y in polygon[0]]
        for polygon in shape["coordinates"]
    ]


#: Coastline simplification. Finer than the AR6 boxes because a coastline is
#: read as a shape rather than a boundary, and kinks show.
COASTLINE_TOLERANCE = 0.2


def export_coastlines(out_dir):
    """Write Natural Earth land outlines as rings, like the regions."""
    land = regionmask.defined_regions.natural_earth_v5_0_0.land_110
    outlines = []
    for polygon in land.polygons:
        outlines.extend(rings(polygon.simplify(COASTLINE_TOLERANCE)))

    path = os.path.join(out_dir, "coastlines_v1.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "source": "regionmask natural_earth_v5_0_0.land_110",
                "licence": "Natural Earth, public domain",
                "simplify_tolerance_degrees": COASTLINE_TOLERANCE,
                "rings": outlines,
            },
            handle,
        )
    print(f"wrote {path} ({os.path.getsize(path)/1024:.0f} KB, {len(outlines)} rings)")


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "data"
    os.makedirs(out_dir, exist_ok=True)

    regions = regionmask.defined_regions.ar6.all
    features = []
    for region in regions:
        geometry = region.polygon.simplify(TOLERANCE)
        features.append(
            {
                "code": region.abbrev,
                "name": region.name,
                "rings": rings(geometry),
            }
        )

    path = os.path.join(out_dir, "ar6_regions_v1.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "source": "regionmask.defined_regions.ar6.all",
                "reference": (
                    "Iturbide et al. (2020), An update of IPCC climate reference "
                    "regions, Earth Syst. Sci. Data 12, 2959-2970, "
                    "https://doi.org/10.5194/essd-12-2959-2020"
                ),
                "simplify_tolerance_degrees": TOLERANCE,
                "n_regions": len(features),
                "regions": features,
            },
            handle,
        )
    print(f"wrote {path} ({os.path.getsize(path)/1024:.0f} KB, {len(features)} regions)")
    export_coastlines(out_dir)


if __name__ == "__main__":
    main()
