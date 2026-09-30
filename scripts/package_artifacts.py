"""Package the model artifacts in data/ as a GitHub release, and pin it.

One zip per model, holding what the site serves: the tas and pr bundles and
pattern artifacts, the pr climatology and the land fraction. Golden fixtures
stay out: they exist for the test suite. Writes the zips to an output
directory and rewrites data/artifacts_v1.json to pin them by SHA-256 under
the given release tag; publishing the release is then

    gh release create <tag> --prerelease --title ... <out>/*.zip data/artifacts_v1.json

Usage::

    python scripts/package_artifacts.py <tag> <out dir> [--exclude MODEL ...] [--note TEXT]

Models are those in data/models_v1.json, NorESM2-MM first, less any excluded.
"""

import argparse
import hashlib
import json
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
KINDS = [
    "tas_bundle", "tas_pattern", "pr_bundle", "pr_pattern", "pr_climatology", "landfrac",
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("tag")
    parser.add_argument("out")
    parser.add_argument("--exclude", nargs="*", default=[])
    parser.add_argument("--provenance", default="")
    args = parser.parse_args()

    with open(os.path.join(DATA, "models_v1.json")) as handle:
        models = [m for m in json.load(handle)["models"] if m not in args.exclude]
    os.makedirs(args.out, exist_ok=True)

    entries = []
    for model in models:
        members = [f"meteor_{model}_{kind}_v1.nc" for kind in KINDS]
        members = [m for m in members if os.path.exists(os.path.join(DATA, m))]
        path = os.path.join(args.out, f"meteor_{model}_v1.zip")
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            for member in members:
                # A fixed timestamp, so the same files make the same zip.
                info = zipfile.ZipInfo(member, date_time=(2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                with open(os.path.join(DATA, member), "rb") as source:
                    archive.writestr(info, source.read())
        with open(path, "rb") as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()
        entries.append(
            {
                "model": model,
                "file": os.path.basename(path),
                "size": os.path.getsize(path),
                "sha256": digest,
                "members": members,
            }
        )
        print(f"{model:16s} {len(members)} files -> {os.path.getsize(path) / 1e6:5.2f} MB")

    manifest = {
        "format": "meteor-view-artifacts",
        "schema_version": 1,
        "release": args.tag,
        "base_url": f"https://github.com/benmsanderson/meteor-view/releases/download/{args.tag}/",
        "provisional": True,
        "provenance": json.loads(args.provenance) if args.provenance else {},
        "models": entries,
    }
    with open(os.path.join(DATA, "artifacts_v1.json"), "w") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")
    print(f"{len(entries)} models pinned in data/artifacts_v1.json as {args.tag}")


if __name__ == "__main__":
    main()
