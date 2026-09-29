// Fetch the model artifacts pinned in data/artifacts_v1.json into data/.
//
//   node scripts/fetch-artifacts.mjs              # every model in the manifest
//   node scripts/fetch-artifacts.mjs CESM2 ...    # just these
//
// Git carries the default model only; every other model's bundles, pattern
// artifacts, climatology and land fraction come from a GitHub release, one zip
// per model (docs/00-development-plan.md section 6). The manifest pins each
// zip's SHA-256, so a changed or truncated download is refused rather than
// served. Downloads are kept in $ARTIFACTS_CACHE (default .artifacts-cache/),
// which CI caches keyed on the manifest, so an ordinary build downloads
// nothing.
//
// Afterwards data/models_v1.json is rewritten from the bundles present, the
// default model first, so the model menu lists exactly what can be loaded.
// Needs `unzip` on the PATH.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA = join(ROOT, 'data');
const CACHE = process.env.ARTIFACTS_CACHE ?? join(ROOT, '.artifacts-cache');
const DEFAULT_MODEL = 'NorESM2-MM';

const manifest = JSON.parse(readFileSync(join(DATA, 'artifacts_v1.json'), 'utf8'));
const wanted = process.argv.slice(2);
const unknown = wanted.filter((m) => !manifest.models.some((e) => e.model === m));
if (unknown.length) {
  console.error(`not in ${manifest.release}: ${unknown.join(', ')}`);
  process.exit(1);
}
const entries = wanted.length
  ? manifest.models.filter((e) => wanted.includes(e.model))
  : manifest.models;

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** The zip for one model, from the cache if it is there and intact. */
async function zipFor(entry) {
  const path = join(CACHE, manifest.release, entry.file);
  if (existsSync(path) && sha256(readFileSync(path)) === entry.sha256) {
    return { path, cached: true };
  }
  const url = new URL(entry.file, manifest.base_url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = sha256(buffer);
  if (actual !== entry.sha256) {
    throw new Error(`${entry.file}: SHA-256 ${actual}, manifest pins ${entry.sha256}`);
  }
  mkdirSync(join(CACHE, manifest.release), { recursive: true });
  writeFileSync(`${path}.part`, buffer);
  renameSync(`${path}.part`, path);
  return { path, cached: false };
}

console.log(`${manifest.release}${manifest.provisional ? ' (provisional)' : ''}: ${entries.length} models`);
const failed = [];
for (const entry of entries) {
  try {
    const { path, cached } = await zipFor(entry);
    execFileSync('unzip', ['-o', '-q', path, ...entry.members, '-d', DATA]);
    console.log(`  ${entry.model.padEnd(16)} ${(entry.size / 1e6).toFixed(2)} MB${cached ? '  (cached)' : ''}`);
  } catch (error) {
    console.error(`  ${entry.model.padEnd(16)} FAILED: ${error.message}`);
    failed.push(entry.model);
  }
}

const bundle = /^meteor_(.+)_tas_bundle_v1\.nc$/;
const models = readdirSync(DATA)
  .map((f) => f.match(bundle)?.[1])
  .filter((m) => m && existsSync(join(DATA, `meteor_${m}_pr_bundle_v1.nc`)))
  .sort((a, b) => (a !== DEFAULT_MODEL) - (b !== DEFAULT_MODEL) || a.toLowerCase().localeCompare(b.toLowerCase()));
writeFileSync(join(DATA, 'models_v1.json'), `${JSON.stringify({ models }, null, 2)}\n`);
console.log(`data/models_v1.json: ${models.length} models`);

if (failed.length) {
  console.error(`failed: ${failed.join(', ')}`);
  process.exit(1);
}
