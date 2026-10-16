/**
 * Crop yields: the GGCMI emulators as the site evaluates them.
 *
 * What must hold: on the reduced 2-degree coefficients the site gives the
 * yields METEOR's own evaluator gives on the original 0.5-degree ones, for
 * the same change at every cell; a climate model's inputs are its change from
 * its own 1980-2010 climate; and a yield change is measured from 1980-2010.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { Artifact, Bundle } from '../src/lib/bundle.js';
import { PatternArtifact } from '../src/lib/pattern.js';
import { Explorer } from '../src/app/explorer.js';
import { SUMMARY_GRID } from '../src/app/summary.js';
import {
  CROP_BASELINE,
  CROP_LIMITS,
  CROP_YEARS,
  NITROGEN,
  cellYield,
  co2Series,
  cropFile,
  cropInputs,
  cropYields,
  parseCoefficients,
  terms,
  yieldChange,
} from '../src/lib/crops.js';
import { cropSentence } from '../src/app/crop-summary.js';

const DATA = new URL('../data/', import.meta.url);
const json = (name) => JSON.parse(readFileSync(new URL(name, DATA)));
const index = json('crops_v1/index.json');
const co2 = json('scenario_co2_v1.json');
const reference = JSON.parse(readFileSync(new URL('fixtures/crop_reference.json', import.meta.url)));
const coefficients = (model, crop) => parseCoefficients(readFileSync(new URL(cropFile(model, crop), DATA)));
const clamp = (v, [lo, hi]) => Math.min(Math.max(v, lo), hi);

describe('the emulator port', () => {
  it('gives the yields METEOR gives, from the reduced coefficients', () => {
    expect(reference.nitrogen).toBe(NITROGEN);
    for (const c of reference.cases) {
      const k = index.crops[c.crop].cells.indexOf(c.cell);
      expect(k, `${c.crop} grows in cell ${c.cell}`).toBeGreaterThanOrEqual(0);
      const basis = terms(
        clamp(c.co2, CROP_LIMITS.co2),
        clamp(c.warming, CROP_LIMITS.temperature),
        clamp(c.ratio, CROP_LIMITS.precipitation),
        NITROGEN
      );
      const value = cellYield(coefficients(c.model, c.crop), index.coefficients, k, basis);
      // float32 coefficients; and METEOR clips a negative yield to zero cell
      // by cell, the site after averaging them, which only differs where a
      // crop model grows almost nothing.
      expect(Math.abs(value - c.yield) / c.yield, `${c.model} ${c.crop}`).toBeLessThan(2e-3);
    }
  });

  it('responds to CO2 as a crop should, under the reference climate', () => {
    const k = index.crops.maize.cells.indexOf(reference.cases[0].cell);
    const at = (ppm) => cellYield(coefficients('LPJmL', 'maize'), index.coefficients, k, terms(ppm, 0, 1, NITROGEN));
    expect(at(360)).toBeGreaterThan(1);
    expect(at(600)).toBeGreaterThanOrEqual(at(360));
  });
});

describe('a climate model\'s inputs', async () => {
  const read = (name) => readFileSync(new URL(`meteor_NorESM2-MM_${name}_v1.nc`, DATA));
  const explorer = new Explorer({ tas: new Bundle(read('tas_bundle')), pr: new Bundle(read('pr_bundle')) });
  explorer.patternArtifacts.set('tas', new PatternArtifact(read('tas_pattern')));
  explorer.patternArtifacts.set('pr', new PatternArtifact(read('pr_pattern')));
  explorer.prClimatology = new Artifact(read('pr_climatology')).array('pr_climatology');
  const cells = index.crops.maize.cells;
  const inputsFor = await cropInputs(explorer, { grid: SUMMARY_GRID, cells });
  const nYears = CROP_YEARS.end - CROP_YEARS.start + 1;

  it('are the change from its own 1980-2010 climate', () => {
    const { temperature, ratio } = inputsFor(explorer.baselineScenario);
    const n = CROP_BASELINE.to - CROP_BASELINE.from + 1;
    for (const c of [0, Math.floor(cells.length / 2), cells.length - 1]) {
      let t = 0;
      let w = 0;
      for (let year = CROP_BASELINE.from; year <= CROP_BASELINE.to; year += 1) {
        t += temperature[(year - CROP_YEARS.start) * cells.length + c] / n;
        w += ratio[(year - CROP_YEARS.start) * cells.length + c] / n;
      }
      expect(Math.abs(t)).toBeLessThan(1e-9);
      expect(w).toBeCloseTo(1, 6);
    }
  });

  it('warm under a high scenario', () => {
    const { temperature } = inputsFor('ssp585');
    let sum = 0;
    for (let c = 0; c < cells.length; c += 1) sum += temperature[(nYears - 1) * cells.length + c];
    expect(sum / cells.length).toBeGreaterThan(2);
  });

  it('give a yield change measured from 1980-2010', () => {
    const scenario = 'ssp585';
    const inputs = inputsFor(scenario);
    const positions = cells.map((_, k) => k);
    const file = coefficients('LPJmL', 'maize');
    const yields = cropYields(file, positions, inputs, cells.length, co2Series(co2, scenario), index.coefficients);
    const members = cells.map((_, k) => [k, file[k * index.coefficients + index.area_slot]]);
    const change = yieldChange(yields, cells.length, members);
    let base = 0;
    for (let year = CROP_BASELINE.from; year <= CROP_BASELINE.to; year += 1) base += change[year - CROP_YEARS.start];
    expect(Math.abs(base)).toBeLessThan(1e-9);
    expect(Number.isFinite(change.at(-1))).toBe(true);
    expect(Math.abs(change.at(-1))).toBeLessThan(80);
  });
});

describe('the crop sentence', () => {
  const crops = {
    baseline: CROP_BASELINE,
    nitrogen: NITROGEN,
    models: { wheat: { climate_models: 29, crop_models: ['A', 'B', 'C'] } },
    wheat: { pairings: 87, scenarios: { a: { end: [-21.4, -10, -4.2, 1, 6.3] } } },
  };
  it('names the middle pairing, the range, and the conditions', () => {
    expect(
      cropSentence({ crops, crop: 'wheat', scenarios: ['a'], label: () => 'High', place: 'West & Central Europe' })
    ).toBe(
      'By 2081–2100, wheat yields in West & Central Europe change by −4% (−21 to +6%) under High, ' +
        'compared with 1980–2010. Figures in brackets span the middle 90% of 87 pairings of 29 climate ' +
        'models and 3 crop models. Rainfed, with the effect of CO₂ on crops, no adaptation of crop ' +
        'varieties, and 100 kg of nitrogen per hectare everywhere.'
    );
  });
});

describe('the expert view\'s crop yields', async () => {
  // The page's fetches, answered from the data directory.
  const fetchFile = async (url) => {
    const path = new URL(String(url).split('?')[0]);
    try {
      const bytes = readFileSync(path);
      return {
        ok: true,
        json: async () => JSON.parse(bytes),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    } catch {
      return { ok: false };
    }
  };
  const { createCropService } = await import('../src/app/crop-expert.js');
  const read = (name) => readFileSync(new URL(`meteor_NorESM2-MM_${name}_v1.nc`, DATA));
  const explorer = new Explorer({ tas: new Bundle(read('tas_bundle')), pr: new Bundle(read('pr_bundle')) });
  explorer.patternArtifacts.set('tas', new PatternArtifact(read('tas_pattern')));
  explorer.patternArtifacts.set('pr', new PatternArtifact(read('pr_pattern')));
  explorer.prClimatology = new Artifact(read('pr_climatology')).array('pr_climatology');
  const original = globalThis.fetch;
  globalThis.fetch = fetchFile;
  const service = createCropService({ base: DATA.href, explorerFor: async () => explorer });
  const query = { climateModel: 'NorESM2-MM', crop: 'maize', scenario: 'ssp585', location: 'global' };
  const run = (cropModels, nitrogen) => service.placeSeries({ ...query, cropModels, nitrogen });
  const [lpjml] = await run(['LPJmL'], NITROGEN);
  const [lpjmlRich] = await run(['LPJmL'], 200);
  const [caraib] = await run(['CARAIB'], NITROGEN);
  const [caraibRich] = await run(['CARAIB'], 200);
  const all = await run(index.crops.maize.models, NITROGEN);
  const map = await service.cellField({ ...query, cropModels: ['LPJmL'], year: 2100, nitrogen: NITROGEN });
  globalThis.fetch = original;

  it('gives the same series as the simple view computes for that pairing', async () => {
    const cells = index.crops.maize.cells;
    const inputs = (await cropInputs(explorer, { grid: SUMMARY_GRID, cells }))('ssp585');
    const file = coefficients('LPJmL', 'maize');
    const yields = cropYields(file, cells.map((_, k) => k), inputs, cells.length, co2Series(co2, 'ssp585'), index.coefficients);
    const members = cells.map((_, k) => [k, file[k * index.coefficients + index.area_slot]]).filter(([, w]) => w > 0);
    const expected = yieldChange(yields, cells.length, members);
    expect(lpjml.model).toBe('LPJmL');
    for (let y = 0; y < expected.length; y += 1) expect(lpjml.change[y]).toBeCloseTo(expected[y], 9);
  });

  it('runs every crop model at once, one series each', () => {
    expect(all.map((m) => m.model)).toEqual(index.crops.maize.models);
  });

  it('responds to nitrogen, except in the crop models that ran one level', () => {
    expect(lpjmlRich.change.at(-1)).not.toBeCloseTo(lpjml.change.at(-1), 3);
    for (let y = 0; y < caraib.change.length; y += 1) expect(caraibRich.change[y]).toBeCloseTo(caraib.change[y], 9);
  });

  it('maps only the cells that grow the crop', () => {
    const grown = new Set(index.crops.maize.cells);
    let finite = 0;
    map.field.forEach((v, cell) => {
      if (Number.isFinite(v)) {
        finite += 1;
        expect(grown.has(cell)).toBe(true);
      }
    });
    expect(finite).toBeGreaterThan(100);
  });
});
