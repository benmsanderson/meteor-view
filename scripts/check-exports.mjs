// Sanity-check freshly exported models: warming, land masking, NaN.
//
//   node scripts/check-exports.mjs            # every model with a golden fixture in data/
//   node scripts/check-exports.mjs CESM2 ...  # just these
//
// Prints each model's 2081-2100 warming against 1850-1900 under three SSPs,
// whether its regions are land-masked and from which land fraction, and flags
// any NaN in the bundle. Run the golden-fixture tests too (npx vitest run
// test/golden.test.js); this checks what they do not: that the numbers are
// plausible, and that the export used the Atlas-style averaging.
import { readFileSync, readdirSync } from 'node:fs';
import { Bundle } from '../src/lib/bundle.js';
import { Explorer } from '../src/app/explorer.js';

const DATA = new URL('../data/', import.meta.url);
const fixture = /^meteor_(.+)_tas_golden_ssp245_v1\.nc$/;
const models = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(DATA).map((f) => f.match(fixture)?.[1]).filter(Boolean).sort();

const rows = [];
for (const model of models) {
  const load = (v) => new Bundle(readFileSync(new URL(`meteor_${model}_${v}_bundle_v1.nc`, DATA)));
  const tas = load('tas');
  const explorer = new Explorer({ tas, pr: load('pr') });
  const nan = ['eof_projection', 'seasonal_coef', 'varx_A'].some((k) =>
    Array.from(tas.get(k)).some((v) => !Number.isFinite(v)),
  );
  const warming = (scenario) => {
    const g = explorer.globalWarming(scenario);
    const y0 = tas.forcingYearStart;
    const mean = (a, b) => {
      let t = 0;
      for (let y = a; y <= b; y++) t += g[y - y0];
      return t / (b - a + 1);
    };
    return mean(2081, 2100) - mean(1850, 1900);
  };
  rows.push({
    model,
    ssp126: warming('ssp126'),
    ssp245: warming('ssp245'),
    ssp585: warming('ssp585'),
    masked: /land gridboxes only/.test(tas.attrs.region_surface ?? ''),
    source: /Atlas/.test(tas.attrs.land_fraction_source ?? '') ? 'Atlas 1°' : 'sftlf',
    nan,
  });
}

rows.sort((a, b) => a.ssp245 - b.ssp245);
for (const r of rows) {
  console.log(
    `${r.model.padEnd(16)} 2081-2100 vs 1850-1900: ` +
      `ssp126 ${r.ssp126.toFixed(2)}  ssp245 ${r.ssp245.toFixed(2)}  ssp585 ${r.ssp585.toFixed(2)} | ` +
      `land-masked ${r.masked} (${r.source})${r.nan ? '  NaN!' : ''}`,
  );
}
const bad = rows.filter((r) => r.nan || !r.masked);
console.log(`${rows.length} models checked; ${bad.length} with NaN or without land masking`);
process.exit(bad.length ? 1 : 0);
