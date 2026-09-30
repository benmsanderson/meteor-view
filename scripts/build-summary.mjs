// Build the simple view's multi-model summaries into data/summary_v1/.
//
//   node scripts/build-summary.mjs
//
// One file per place, each holding the spread across every model in
// data/models_v1.json of the forced change since 1850-1900, for every
// scenario and both variables (src/app/summary.js). Run by `npm run build`
// and `npm run dev` before they start; skipped when the summaries are newer
// than the model list and every bundle, so it costs nothing on a rerun.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Bundle } from '../src/lib/bundle.js';
import { Explorer, artifactName } from '../src/app/explorer.js';
import { summarizeLocation, summaryFile } from '../src/app/summary.js';
import { degreeDayFile } from '../src/lib/degree-days.js';

const DATA = fileURLToPath(new URL('../data/', import.meta.url));
const OUT = join(DATA, 'summary_v1');
const STAMP = join(OUT, 'index.json');

const manifest = join(DATA, 'models_v1.json');
const models = existsSync(manifest)
  ? JSON.parse(readFileSync(manifest, 'utf8')).models
  : ['NorESM2-MM'];
const bundles = models.flatMap((m) => ['tas', 'pr'].map((v) => join(DATA, artifactName(m, v, 'bundle'))));
// The observed degree-day curves are inputs too.
const curveFiles = existsSync(join(DATA, 'degree_days_v1'))
  ? readdirSync(join(DATA, 'degree_days_v1')).map((f) => join(DATA, 'degree_days_v1', f))
  : [];

const newest = Math.max(
  ...[manifest, ...bundles, ...curveFiles].filter(existsSync).map((f) => statSync(f).mtimeMs)
);
if (existsSync(STAMP) && statSync(STAMP).mtimeMs > newest) {
  const built = JSON.parse(readFileSync(STAMP, 'utf8'));
  if (built.models.join() === models.join()) {
    console.log(`summaries up to date (${models.length} models)`);
    process.exit(0);
  }
}

const started = Date.now();
const explorers = new Map();
for (const model of models) {
  const load = (v) => new Bundle(readFileSync(join(DATA, artifactName(model, v, 'bundle'))));
  explorers.set(model, new Explorer({ tas: load('tas'), pr: load('pr') }));
}
const { locations } = explorers.get(models[0]);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const location of locations) {
  const curveFile = join(DATA, degreeDayFile(location));
  const curves = existsSync(curveFile) ? JSON.parse(readFileSync(curveFile, 'utf8')) : null;
  writeFileSync(
    join(DATA, summaryFile(location)),
    JSON.stringify(summarizeLocation(explorers, location, curves))
  );
}
writeFileSync(STAMP, JSON.stringify({ models, locations: locations.length }));

const size = readdirSync(OUT).reduce((s, f) => s + statSync(join(OUT, f)).size, 0);
console.log(
  `summaries: ${locations.length} places from ${models.length} models, ` +
    `${(size / 1e6).toFixed(1)} MB, in ${((Date.now() - started) / 1000).toFixed(1)} s`
);
