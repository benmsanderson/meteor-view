"""The simple view's cities, from Natural Earth's populated places.

Every national capital of more than 500,000 people, and every other city of
more than 2.5 million, by Natural Earth's metropolitan population (`pop_max`):
about 250 places. Smaller capitals are left out because most are on islands a
1-3 degree model grid does not resolve, so the "nearest land gridbox" would
not be the city in any useful sense.

The eight cities the bundles already carry keep their own specifiers, so they
keep their year-to-year variability in the expert view; the rest are new
points, for the simple view, whose spread across models is computed at build
time from each model's pattern artifacts.

Natural Earth is in the public domain (https://www.naturalearthdata.com).

Usage::

    python scripts/make_cities.py <ne_10m_populated_places_simple.geojson> <ne_110m_admin_0_countries.geojson>

Writes data/cities_v1.json.
"""

import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "cities_v1.json")

CAPITAL_MIN = 500_000
CITY_MIN = 2_500_000

#: The bundles' own cities, as the exporter names them.
BUNDLE_CITIES = {
    "point:51.5,-0.1": (51.5, -0.1),
    "point:40.7,-74.0": (40.7, -74.0),
    "point:-23.5,-46.6": (-23.5, -46.6),
    "point:6.5,3.4": (6.5, 3.4),
    "point:30.0,31.2": (30.0, 31.2),
    "point:19.1,72.9": (19.1, 72.9),
    "point:39.9,116.4": (39.9, 116.4),
    "point:-33.9,151.2": (-33.9, 151.2),
}

#: Natural Earth's continent names, as the place picker groups them.
CONTINENTS = {
    "North America": "North America",
    "South America": "South America",
    "Europe": "Europe",
    "Africa": "Africa",
    "Asia": "Asia",
    "Oceania": "Oceania",
}


#: Countries too small for the 1:110m country table, by ISO code.
EXTRA_CONTINENTS = {"BHR": "Asia", "MUS": "Africa", "SGP": "Asia"}

#: Names as English readers look for them, and one typo in the source.
RENAME = {
    "København": "Copenhagen",
    "Ōsaka": "Osaka",
    "Shenyeng": "Shenyang",
    "Xian": "Xi'an",
}


def km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    c = math.sin(la1) * math.sin(la2) + math.cos(la1) * math.cos(la2) * math.cos(lo1 - lo2)
    return 6371 * math.acos(max(-1.0, min(1.0, c)))


def main(places_path, countries_path):
    places = [f["properties"] for f in json.load(open(places_path))["features"]]
    continent = dict(EXTRA_CONTINENTS)
    for f in json.load(open(countries_path))["features"]:
        p = f["properties"]
        for key in ("ADM0_A3", "ISO_A3", "SOV_A3"):
            continent.setdefault(p[key], p["CONTINENT"])

    chosen = {}
    for p in places:
        capital = p["featurecla"] == "Admin-0 capital" and p["pop_max"] >= CAPITAL_MIN
        if capital or p["pop_max"] >= CITY_MIN:
            chosen[(p["name"], p["adm0name"])] = (p, capital)

    # Each bundle city goes to the largest chosen place within 50 km of it:
    # the point was placed for Cairo, even if Giza's centre is nearer.
    largest = {}
    for key, (p, _) in chosen.items():
        where = (p["latitude"], p["longitude"])
        for s, at in BUNDLE_CITIES.items():
            if km(at, where) < 50 and (s not in largest or p["pop_max"] > largest[s][1]):
                largest[s] = (key, p["pop_max"])
    builtin = {key: s for s, (key, _) in largest.items()}

    cities = []
    for (name, country), (p, capital) in chosen.items():
        where = (p["latitude"], p["longitude"])
        spec = builtin.get((name, country))
        name = RENAME.get(name, " ".join(name.split()))
        country = " ".join(country.split())
        cities.append(
            {
                "spec": spec or f"point:{where[0]:.2f},{where[1]:.2f}",
                "name": name,
                "country": country,
                "continent": CONTINENTS.get(
                    continent.get(p["adm0_a3"]) or continent.get(p["sov_a3"]), "Other"
                ),
                "capital": capital,
                "population": int(p["pop_max"]),
                "builtin": spec is not None,
            }
        )
    # A name that occurs twice is told apart by its country.
    counts = {}
    for c in cities:
        counts[c["name"]] = counts.get(c["name"], 0) + 1
    for c in cities:
        c["label"] = c["name"] if counts[c["name"]] == 1 else f"{c['name']}, {c['country']}"
    cities.sort(key=lambda c: (c["continent"], c["label"]))

    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "format": "meteor-view-cities",
                "schema_version": 1,
                "source": "Natural Earth 10m populated places (public domain)",
                "rule": f"capitals of more than {CAPITAL_MIN:,}, other cities of more than {CITY_MIN:,} (pop_max)",
                "cities": cities,
            },
            handle,
            ensure_ascii=False,
            indent=1,
        )
    by = {}
    for c in cities:
        by[c["continent"]] = by.get(c["continent"], 0) + 1
    print(f"{len(cities)} cities, {sum(c['builtin'] for c in cities)} already in the bundles: {by}")
    missing = [c["label"] for c in cities if c["continent"] == "Other"]
    if missing:
        print("no continent:", missing)


if __name__ == "__main__":
    main(*sys.argv[1:3])
