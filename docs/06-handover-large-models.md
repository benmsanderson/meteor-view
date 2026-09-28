# Handover: training the eleven large models

**Done 2026-09-28**: seven succeeded and are on `data-staging`; four fail in
METEOR. Results and measured memory are in
[`05-training-run.md`](05-training-run.md). Kept as the recipe for re-running.

Everything needed to finish the forty-model run on a machine with more memory.
Background is in [`05-training-run.md`](05-training-run.md); this is the how.

## The job

Train and export the eleven models that the 15.7 GB container could not:

```
CESM2 CESM2-WACCM CMCC-CM2-SR5 CMCC-ESM2 TaiESM1 NorESM2-MM
AWI-CM-1-1-MR MPI-ESM1-2-HR EC-Earth3 EC-Earth3-Veg CNRM-CM6-1-HR
```

**NorESM2-MM first**: it is the site's default model, and the copy on the
default branch is still the old export that averages regions over land and sea.

Then add their files to the `data-staging` branch, next to the 23 already there.

The other six failed models (CAMS-CSM1-0, IITM-ESM, FGOALS-g3, GISS-E2-1-H,
KIOST-ESM, NorESM2-LM) are **not** part of this job. They need METEOR fixes
first: [benmsanderson/METEOR#106](https://github.com/benmsanderson/METEOR/issues/106).

## The machine

| | Needed | Why |
|---|---|---|
| Memory | **32 GB**; **70 GB** for CNRM-CM6-1-HR (measured; see `05-training-run.md`) | Noise training peaked above 13.4 GB before the 15.7 GB container killed it; NorESM2-MM alone measured 12.2–12.7 GB. EC-Earth3 and CNRM-CM6-1-HR are finer still. |
| Disk | ~30 GB free | ~2 GB of CMIP6 per model plus fitted caches; `CLEAN_CACHE=1` deletes each model's after it succeeds. The fine grids take more. |
| Network | Outbound HTTPS to `storage.googleapis.com` | Anonymous reads of the Pangeo CMIP6 store; no credentials. |
| Software | Python 3.11, Node 20+, git | |
| Time | ~5–10 min per model on 4 cores; allow ~2 h | |

With no swap, a run over the memory limit is killed outright, with no Python
error; its log just stops. If a model dies that way, the machine is too small.

## 1. Set up

```bash
# The site, on the branch that has the land masking (merged in #7)
git clone -b claude/youthful-brahmagupta-la5z3o https://github.com/benmsanderson/meteor-view.git
cd meteor-view
npm ci

# METEOR, at the exact commit the other 23 were trained from
git clone -b integration/meteor-view https://github.com/benmsanderson/METEOR.git ../METEOR
git -C ../METEOR checkout b02011b   # base + #104, #102, #101

# Python environment
python3.11 -m venv ../venv
../venv/bin/pip install -e ../METEOR
../venv/bin/pip install gcsfs zarr==2.18.7 xarray netCDF4 h5netcdf regionmask geopandas shapely scikit-learn scipy
```

Versions that produced the first 23: xarray 2026.7.0, zarr 2.18.7, gcsfs
2026.8.1, numpy 2.4.6, pandas 3.0.6, scikit-learn 1.9.1, regionmask 0.13.0.
**Keep zarr on 2.x**: the CMIP6 stores are zarr v2.

**The CMIP7 emissions** are gitignored and must be rebuilt, or the bundles
carry the 8 SSPs but not the 7 CMIP7 markers (the script warns about this).
Download `ScenarioMIP_emissions_marker_scenarios_v0.2.xlsx` from
[10.5281/zenodo.19825038](https://doi.org/10.5281/zenodo.19825038), then:

```bash
PYTHONPATH=../METEOR/src ../venv/bin/python scripts/convert_scenariomip.py \
  ScenarioMIP_emissions_marker_scenarios_v0.2.xlsx
ls scenario-work/*_em_RCMIP.txt   # expect 7 files
```

**The Atlas land fraction** is not needed: all eleven models publish their own
`sftlf`. (It is only used for models that don't; set `ATLAS_LANDMASK` if you
ever need it.)

## 2. Train

```bash
CLEAN_CACHE=1 \
METEOR_SRC=../METEOR/src \
METEOR_CACHE=$HOME/meteor-cache \
PYTHON=../venv/bin/python \
scripts/train-models.sh \
  NorESM2-MM CESM2 CESM2-WACCM CMCC-CM2-SR5 CMCC-ESM2 TaiESM1 \
  AWI-CM-1-1-MR MPI-ESM1-2-HR EC-Earth3 EC-Earth3-Veg CNRM-CM6-1-HR \
  2>&1 | tee training-logs/batch.out
```

Each model runs in its own process, so one failure doesn't stop the rest.
Per-model logs are in `training-logs/<model>.log`. Re-running the same command
resumes: models already exported and cached are not retrained.

To watch memory, in a second terminal:
`while sleep 30; do echo "$(date +%T) $(free -m | awk '/Mem/{print $3}')"; done`

## 3. Check

```bash
npx vitest run                     # all tests, including each new model's golden fixtures
node scripts/check-exports.mjs     # warming, land masking and NaN for every model in data/
```

`check-exports.mjs` exits non-zero if any model has NaN or isn't land-masked.
Expect every model to say `land-masked true (sftlf)`, and ssp245 warming for
2081–2100 in roughly the 2–4.5 °C range the first 23 gave (2.14–4.06 °C).
NorESM2-MM's old export gave 2.13 °C; the new one's global warming should be
close to that, since masking changes regions, not the global mean.

## 4. Add to `data-staging`

`data-staging` holds the model data until the Zenodo deposit replaces it. It is
never merged.

```bash
git fetch origin data-staging
git worktree add ../staging data-staging
for m in NorESM2-MM CESM2 CESM2-WACCM CMCC-CM2-SR5 CMCC-ESM2 TaiESM1 \
         AWI-CM-1-1-MR MPI-ESM1-2-HR EC-Earth3 EC-Earth3-Veg CNRM-CM6-1-HR; do
  for f in data/meteor_${m}_*_v1.nc; do
    case "$f" in *golden*) continue ;; esac   # fixtures stay local
    cp -p "$f" ../staging/data/
  done
done
```

Then rebuild the model list, keeping NorESM2-MM first as the default:

```bash
cd ../staging
python3 - <<'PY'
import glob, json, re
models = {re.match(r"data/meteor_(.+)_tas_bundle_v1\.nc", p).group(1)
          for p in glob.glob("data/meteor_*_tas_bundle_v1.nc")}
ordered = sorted(models, key=lambda m: (m != "NorESM2-MM", m.lower()))
json.dump({"models": ordered}, open("data/models_v1.json", "w"), indent=2)
print(len(ordered), "models")
PY
git add data && git commit -m "Stage the eleven large-grid model exports" && git push origin data-staging
```

Only copy models that passed step 3. Expect 34 models in the list if all
eleven succeed (the 23, plus NorESM2-MM replaced, plus ten new).

## 5. Report back

Note in `docs/05-training-run.md` which models succeeded, their ssp245
warming, and peak memory for any that came close to the limit, so the next
person knows what size of machine the finest grids need.

## If something fails

- **Log stops with no error:** out of memory. Needs a bigger machine.
- **`custom_global_temp length … must match`** or **`Input y contains NaN`:**
  the METEOR problems in #106, not a machine problem. Not expected for these eleven.
- **`NetCDF: HDF error`** (AWI-CM-1-1-MR hit this): the disk filled while
  writing. Free space, then re-run that model.
- **Download errors:** the CMIP6 store is occasionally slow. Re-run; completed
  models are skipped.

## Handing this to Claude on the new machine

Paste this as the first message of a Claude Code session in the new clone:

> Follow `docs/06-handover-large-models.md`. First confirm this machine has at
> least 32 GB of memory (`free -h`) and 30 GB of free disk, and stop and tell me
> if not. Then do steps 1–4. Train NorESM2-MM first and check it before
> starting the rest. Push only to `data-staging`; never merge it. Report which
> models succeeded, their ssp245 warming, and peak memory, and update
> `docs/05-training-run.md` on a new branch with a PR.
