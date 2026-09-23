"""Generate an end-to-end reference from METEOR's own public generation API.

The golden fixtures validate the kernel's arithmetic; this validates the
bookkeeping around it — which trajectory drives what, over which years, and in
which order. Both are needed, because the bookkeeping is where a port gets
plausible-looking wrong answers: a cold-started VAR, an off-by-a-year window,
the wrong global trajectory driving ``t_glob``.

A port cannot reproduce NumPy's PCG64 stream, so this cannot be compared
realisation by realisation. What it records instead is the **ensemble mean**
over a large ensemble, which converges to the deterministic part, plus the
ensemble spread, which is a property of the model rather than the draw.

Usage::

    PYTHONPATH=<meteor>/src python scripts/make_ensemble_reference.py

Regenerate only when the bundles are re-exported.
"""

import json
import os

import numpy as np

from meteor.meteor_interface import MeteorInterface

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "test", "fixtures", "ensemble_reference.json")

CACHE = "/Users/bensan/GitHub/METEOR/cache"
MODEL = "NorESM2-MM"
SCENARIO = "ssp245"
START_YEAR = 2015
END_YEAR = 2100
N_REALIZATIONS = 200
LOCATIONS = ["global", "regional:NEU", "point:19.1,72.9"]


def main():
    emulator = MeteorInterface(MODEL, ["tas", "pr"], cache_dir=CACHE)
    emulator.train(verbose=False)

    np.random.seed(0)
    results = emulator.generate_ensemble_outputs(
        SCENARIO,
        START_YEAR,
        END_YEAR,
        n_realizations=N_REALIZATIONS,
        timeseries=LOCATIONS,
        verbose=False,
    )

    out = {}
    for variable in ("tas", "pr"):
        out[variable] = {}
        for location in LOCATIONS:
            data = np.asarray(results[variable].timeseries[location])
            # (realization, month) -> annual means, then across the ensemble.
            annual = data.reshape(data.shape[0], -1, 12).mean(axis=2)
            out[variable][location] = {
                "ensemble_mean": annual.mean(axis=0).tolist(),
                "ensemble_std": annual.std(axis=0).tolist(),
                "monthly_climatology": data.reshape(data.shape[0], -1, 12)
                .mean(axis=(0, 1))
                .tolist(),
            }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "generated_by": "scripts/make_ensemble_reference.py",
                "source": "MeteorInterface.generate_ensemble_outputs",
                "cmip6_model": MODEL,
                "scenario": SCENARIO,
                "start_year": START_YEAR,
                "end_year": END_YEAR,
                "n_realizations": N_REALIZATIONS,
                "values": out,
            },
            handle,
        )
    print(f"wrote {OUT} ({os.path.getsize(OUT) / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
