// Build the simple view's multi-model summaries into data/summary_v1/.
//
//   node scripts/build-summary.mjs
//
// One file per place, each holding the spread across every model in
// data/models_v1.json of the forced change since 1850-1900, for every
// scenario and both variables (src/app/summary.js), and the expert view's
// multi-model mean. Run by `npm run build` and `npm run dev` before they
// start; skipped when its inputs have not changed, so a rerun costs seconds.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Artifact, Bundle } from '../src/lib/bundle.js';
import { PatternArtifact } from '../src/lib/pattern.js';
import { Explorer, artifactName } from '../src/app/explorer.js';
import {
  EXPERT_BASELINE_MAP,
  expertFile,
  expertMapFile,
  summarizeCity,
  summarizeExpert,
  summarizeExpertBaselineMap,
  summarizeExpertMap,
  summarizeLocation,
  summarizeMap,
  summaryFile,
  summaryMapFile,
} from '../src/app/summary.js';
import { degreeDayFile } from '../src/lib/degree-days.js';

const DATA = fileURLToPath(new URL('../data/', import.meta.url));
const OUT = join(DATA, 'summary_v1');
const STAMP = join(OUT, 'index.json');

const manifest = join(DATA, 'models_v1.json');
const models = existsSync(manifest)
  ? JSON.parse(readFileSync(manifest, 'utf8')).models
  : ['NorESM2-MM'];
const bundles = models.flatMap((m) =>
  ['tas', 'pr'].flatMap((v) => [
    join(DATA, artifactName(m, v, 'bundle')),
    join(DATA, artifactName(m, v, 'pattern')),
  ])
);
// The simple view's cities beyond the bundles' own.
const citiesFile = join(DATA, 'cities_v1.json');
const cities = existsSync(citiesFile) ? JSON.parse(readFileSync(citiesFile, 'utf8')).cities : [];
// The observed degree-day curves are inputs too.
const curveFiles = existsSync(join(DATA, 'degree_days_v1'))
  ? readdirSync(join(DATA, 'degree_days_v1')).map((f) => join(DATA, 'degree_days_v1', f))
  : [];

// Skipped when nothing it reads has changed: a hash of every input's
// contents, not file times, which a fresh checkout or an unzip resets. The
// same key tells CI when a cached copy of the summaries is still good.
const code = ['src/app/summary.js', 'src/app/explorer.js', 'src/app/map.js', 'src/app/chart.js',
  'src/lib/kernel.js', 'src/lib/pattern.js', 'src/lib/bundle.js', 'src/lib/degree-days.js',
  'scripts/build-summary.mjs'].map((f) => fileURLToPath(new URL(`../${f}`, import.meta.url)));
const extras = models.flatMap((m) => [
  join(DATA, artifactName(m, 'pr', 'climatology')),
  join(DATA, `meteor_${m}_landfrac_v1.nc`),
]);
const hash = createHash('sha256');
for (const file of [manifest, citiesFile, ...bundles, ...extras, ...curveFiles.sort(), ...code]) {
  hash.update(file.slice(file.lastIndexOf('/') + 1));
  if (existsSync(file)) hash.update(readFileSync(file));
}
const key = hash.digest('hex');
if (existsSync(STAMP) && JSON.parse(readFileSync(STAMP, 'utf8')).key === key) {
  console.log(`summaries up to date (${models.length} models)`);
  process.exit(0);
}

const started = Date.now();
const explorers = new Map();
for (const model of models) {
  const load = (v) => new Bundle(readFileSync(join(DATA, artifactName(model, v, 'bundle'))));
  const explorer = new Explorer({ tas: load('tas'), pr: load('pr') });
  // What the page fetches for a map, read from disk instead.
  for (const v of ['tas', 'pr']) {
    const file = join(DATA, artifactName(model, v, 'pattern'));
    explorer.patternArtifacts.set(v, new PatternArtifact(readFileSync(file)));
  }
  const climatology = new Artifact(readFileSync(join(DATA, artifactName(model, 'pr', 'climatology'))));
  explorer.prClimatology = climatology.array('pr_climatology');
  const landfrac = join(DATA, `meteor_${model}_landfrac_v1.nc`);
  explorer.landPercent = existsSync(landfrac) ? new Artifact(readFileSync(landfrac)).array('land_percent') : null;
  explorers.set(model, explorer);
}
const { locations } = explorers.get(models[0]);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'expert'), { recursive: true });
for (const location of locations) {
  const curveFile = join(DATA, degreeDayFile(location));
  const curves = existsSync(curveFile) ? JSON.parse(readFileSync(curveFile, 'utf8')) : null;
  writeFileSync(
    join(DATA, summaryFile(location)),
    JSON.stringify(summarizeLocation(explorers, location, curves))
  );
  // And the expert view's multi-model mean.
  writeFileSync(join(DATA, expertFile(location)), JSON.stringify(summarizeExpert(explorers, location, curves)));
}
// Cities the bundles do not carry, from the pattern artifacts.
const extra = cities.filter((c) => !locations.includes(c.spec));
for (const city of extra) {
  const curveFile = join(DATA, degreeDayFile(city.spec));
  const curves = existsSync(curveFile) ? JSON.parse(readFileSync(curveFile, 'utf8')) : null;
  writeFileSync(join(DATA, summaryFile(city.spec)), JSON.stringify(await summarizeCity(explorers, city, curves)));
}

// The map across models, one file per scenario.
const { scenarios } = explorers.get(models[0]);
for (const scenario of scenarios) {
  writeFileSync(join(DATA, summaryMapFile(scenario)), JSON.stringify(await summarizeMap(explorers, scenario)));
}
for (const scenario of scenarios) {
  writeFileSync(join(DATA, expertMapFile(scenario)), JSON.stringify(await summarizeExpertMap(explorers, scenario)));
}
writeFileSync(join(DATA, EXPERT_BASELINE_MAP), JSON.stringify(await summarizeExpertBaselineMap(explorers)));
writeFileSync(STAMP, JSON.stringify({ key, models, locations: locations.length, scenarios: scenarios.length }));

const sizeOf = (dir) =>
  readdirSync(dir, { withFileTypes: true }).reduce(
    (s, f) => s + (f.isDirectory() ? sizeOf(join(dir, f.name)) : statSync(join(dir, f.name)).size),
    0
  );
const size = sizeOf(OUT);
console.log(
  `summaries: ${locations.length} places and ${extra.length} more cities from ${models.length} models, ` +
    `${(size / 1e6).toFixed(1)} MB, in ${((Date.now() - started) / 1000).toFixed(1)} s`
);
