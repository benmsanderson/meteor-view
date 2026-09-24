/**
 * The acceptance test for the port: reproduce METEOR's own output.
 *
 * The fixtures ship a fixed-seed PC sequence as data, because a JavaScript port
 * cannot reproduce NumPy's PCG64 stream and does not need to. Feeding those PCs
 * and `t_glob` into the kernel isolates the deterministic parts — the seasonal
 * cycle, the EOF projection, the forced response — which are what a port can
 * actually get wrong.
 *
 * Tolerance is float32 wire precision, ~1e-7 relative. Anything materially
 * worse is a bug in the port, not rounding.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { Bundle, GoldenFixture } from '../src/lib/bundle.js';
import {
  annualToMonthly,
  designMatrix,
  forcedResponse,
  projectPcs,
  scaleToWarmingPathway,
  seasonalCycle,
} from '../src/lib/kernel.js';

const DATA = new URL('../data/', import.meta.url);

/** Relative tolerance: float32 storage precision, with headroom for summation. */
const RELATIVE_TOLERANCE = 2e-7;

function load(name, Kind) {
  return new Kind(readFileSync(new URL(name, DATA)));
}

/**
 * Largest relative difference between two series, scaled by the magnitude of
 * the reference. Absolute magnitude matters here: `pr` anomalies are of order
 * 1e-6, so a per-element relative comparison would divide by near-zero values
 * that carry no information.
 */
function maxRelative(actual, expected) {
  let scale = 0;
  for (const v of expected) scale = Math.max(scale, Math.abs(v));
  if (scale === 0) scale = 1;

  let worst = 0;
  for (let i = 0; i < expected.length; i += 1) {
    worst = Math.max(worst, Math.abs(actual[i] - expected[i]) / scale);
  }
  return worst;
}

/**
 * Every model and variable with a fixture in `data/`.
 *
 * Only NorESM2-MM's are committed; the exporter writes one for each model it
 * trains, so a fresh export is checked against METEOR here before its bundles
 * are committed, without the fixtures themselves going into git.
 */
const FIXTURES = readdirSync(DATA)
  .map((name) => name.match(/^meteor_(.+)_(tas|pr)_golden_ssp245_v1\.nc$/))
  .filter(Boolean)
  .map(([name, model, variable]) => [
    `${model} ${variable}`,
    variable,
    `meteor_${model}_${variable}_bundle_v1.nc`,
    name,
  ]);

it('finds the committed fixtures', () => {
  expect(FIXTURES.map(([label]) => label)).toEqual(
    expect.arrayContaining(['NorESM2-MM tas', 'NorESM2-MM pr'])
  );
});

describe.each(FIXTURES)('%s golden fixture', (_label, variable, bundleFile, fixtureFile) => {
  const bundle = load(bundleFile, Bundle);
  const fixture = load(fixtureFile, GoldenFixture);

  it('bundle and fixture describe the same model', () => {
    expect(bundle.variable).toBe(variable);
    expect(fixture.attrs.variable_name).toBe(variable);
    expect(fixture.attrs.cmip6_model).toBe(bundle.attrs.cmip6_model);
    expect(bundle.schemaVersion).toBe(1);
  });

  it('reproduces series: seasonal cycle plus EOF projection', () => {
    const tGlob = fixture.array('t_glob');
    const design = designMatrix(tGlob);

    for (const [i, location] of fixture.locations.entries()) {
      const seasonal = seasonalCycle(
        design,
        bundle.locationRow('seasonal_coef', location, 9),
        bundle.get('seasonal_intercept')[bundle.locationIndex(location)]
      );
      const projection = bundle.locationRow('eof_projection', location, bundle.nModes);

      for (let r = 0; r < fixture.nRealizations; r += 1) {
        const stochastic = projectPcs(fixture.pcs(r), projection);
        const actual = Float64Array.from(seasonal, (v, t) => v + stochastic[t]);

        const error = maxRelative(actual, fixture.series(i, r));
        expect(error, `${location} realization ${r}`).toBeLessThan(RELATIVE_TOLERANCE);
      }
    }
  });

  it('reproduces the forced response', () => {
    const forcing = bundle.forcing('ssp245');
    const expected = fixture.array('forced_response');
    const nYears = fixture.dims.year;

    for (const [i, location] of fixture.locations.entries()) {
      const actual = forcedResponse(bundle, location, forcing);
      expect(actual.length).toBe(nYears);

      const error = maxRelative(actual, expected.subarray(i * nYears, (i + 1) * nYears));
      expect(error, location).toBeLessThan(RELATIVE_TOLERANCE);
    }
  });

  it('skips the zero-magnitude base experiment rather than yielding NaN', () => {
    // The full mapping includes `base`, whose exp_forc is 0. Dividing the
    // forcing increments by it would poison the whole sum with NaN.
    const forcing = bundle.forcing('ssp245');
    expect([...forcing.keys()]).toContain('base');
    expect(bundle.get('exp_forc')[bundle.experiments.indexOf('base')]).toBe(0);

    const response = forcedResponse(bundle, 'global', forcing);
    expect(response.every(Number.isFinite)).toBe(true);
  });
});

describe('warming pathway scaling', () => {
  const tas = load('meteor_NorESM2-MM_tas_bundle_v1.nc', Bundle);

  it('leaves the response unchanged when the pathway is the prediction', () => {
    const forcing = tas.forcing('ssp245');
    const global = forcedResponse(tas, 'global', forcing);
    const scaled = scaleToWarmingPathway(global, global, global);

    expect(maxRelative(scaled, global)).toBeLessThan(1e-12);
  });

  it('scales the anomaly about the first year', () => {
    const forcing = tas.forcing('ssp245');
    const global = forcedResponse(tas, 'global', forcing);
    const doubled = Float64Array.from(global, (v) => global[0] + 2 * (v - global[0]));
    const scaled = scaleToWarmingPathway(global, global, doubled);

    // Scaling by a factor of two doubles the anomaly, leaving year zero fixed.
    expect(scaled[0]).toBeCloseTo(global[0], 12);
    const last = global.length - 1;
    expect(scaled[last] - global[0]).toBeCloseTo(2 * (global[last] - global[0]), 9);
  });

  it('requires a shared year axis', () => {
    expect(() => scaleToWarmingPathway([1, 2], [1, 2, 3], [1, 2, 3])).toThrow(
      /share a year axis/
    );
  });
});

describe('annual to monthly expansion', () => {
  it('repeats each annual value for twelve months', () => {
    const monthly = annualToMonthly([1, 2, 3]);
    expect(monthly.length).toBe(36);
    expect([...monthly.slice(0, 12)]).toEqual(Array(12).fill(1));
    expect(monthly[12]).toBe(2);
    expect(monthly[35]).toBe(3);
  });

  it('truncates to a requested month count', () => {
    expect(annualToMonthly([1, 2, 3], 18).length).toBe(18);
  });
});
