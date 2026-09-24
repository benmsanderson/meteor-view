#!/usr/bin/env bash
#
# Train METEOR on a list of CMIP6 models and export the artifacts this site
# serves. Intended for a machine you do not mind leaving alone for a while.
#
# What it needs, measured rather than estimated (NorESM2-MM, tas + pr):
#
#   memory   12.2-12.7 GB peak resident, so 16 GB minimum and 32 GB comfortable.
#            Higher-resolution models want more; the coarse ones want less.
#   disk     ~2 GB of CMIP6 per model, plus ~700 MB of fitted intermediates.
#            Both live under $METEOR_CACHE and are not needed afterwards.
#   network  anonymous reads from the CMIP6 Google Cloud store; no credentials.
#   time     minutes to hours per model.
#
# What it produces is small: about 4.6 MB per model of bundles, pattern
# artifacts and a climatology, written into $OUT.
#
# One model per invocation of the exporter, so a model that fails takes only
# itself down and the rest of the batch carries on. Models already in the cache
# are not retrained, so re-running after a failure resumes rather than restarts.
#
# Usage:
#   scripts/train-models.sh CanESM5 MIROC6 INM-CM5-0
#   METEOR_CACHE=/mnt/data/cache OUT=data scripts/train-models.sh CanESM5

set -uo pipefail

METEOR_SRC="${METEOR_SRC:-$HOME/METEOR/src}"
METEOR_CACHE="${METEOR_CACHE:-$PWD/cache}"
OUT="${OUT:-data}"
PYTHON="${PYTHON:-python3}"
LOG_DIR="${LOG_DIR:-training-logs}"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 MODEL [MODEL ...]" >&2
  exit 2
fi

[ -d "$METEOR_SRC/meteor" ] || {
  echo "no METEOR at $METEOR_SRC — set METEOR_SRC, or:" >&2
  echo "  git clone -b integration/meteor-view https://github.com/benmsanderson/METEOR.git" >&2
  exit 1
}

mkdir -p "$OUT" "$LOG_DIR" "$METEOR_CACHE"

# Bundles built without the converted ScenarioMIP emissions carry the eight
# SSPs and none of the seven CMIP7 markers -- quietly, because a clone without
# the release must still produce a valid bundle. Easy to train a batch
# overnight and find half the scenarios missing, so say so up front.
if [ -z "$(ls scenario-work/*_em_RCMIP.txt 2>/dev/null)" ]; then
  cat >&2 <<'WARNING'
WARNING: no converted CMIP7 emissions in scenario-work/.
         Bundles will carry the 8 CMIP6 SSPs only, not the 7 CMIP7 markers.
         To include them, download the ScenarioMIP release and run:
           python scripts/convert_scenariomip.py <release.xlsx>
         See data/README.md. Continuing in 5 seconds.
WARNING
  sleep 5
fi

printf 'METEOR      %s\ncache       %s\noutput      %s\nmodels      %s\n\n' \
  "$METEOR_SRC" "$METEOR_CACHE" "$OUT" "$*"

succeeded=(); failed=()
for model in "$@"; do
  log="$LOG_DIR/${model}.log"
  printf '=== %s  (log: %s)\n' "$model" "$log"
  started=$(date +%s)

  if PYTHONPATH="$METEOR_SRC" METEOR_CACHE="$METEOR_CACHE" \
       "$PYTHON" scripts/export_bundles.py "$OUT" "$model" >"$log" 2>&1; then
    elapsed=$(( $(date +%s) - started ))
    printf '    done in %dm %ds\n' $((elapsed / 60)) $((elapsed % 60))
    grep -E '^(wrote|unchanged)' "$log" | sed 's/^/    /'
    succeeded+=("$model")
  else
    elapsed=$(( $(date +%s) - started ))
    printf '    FAILED after %dm %ds\n' $((elapsed / 60)) $((elapsed % 60))
    tail -5 "$log" | sed 's/^/    | /'
    failed+=("$model")
  fi
  echo
done

printf 'trained %d, failed %d\n' "${#succeeded[@]}" "${#failed[@]}"
[ "${#failed[@]}" -eq 0 ] || { printf 'failed: %s\n' "${failed[*]}"; exit 1; }

printf '\nArtifacts are in %s/. Commit the bundles and climatologies; the 2 MB\n' "$OUT"
printf 'pattern artifacts belong in the Zenodo deposit (see data/README.md).\n'
