/**
 * The precipitation path, steps 5 and 6.
 *
 * A fixture's `series` stops at step 4 — the seasonal cycle plus the EOF
 * projection — so it exercises none of the steps unique to `pr`. METEOR#105
 * adds `series_transformed` for exactly this: the complete recipe, with the
 * baseline and the gamma quantile mapping applied, so a port can validate its
 * precipitation path without installing METEOR to generate a reference.
 *
 * Note which seasonal form this uses. `series` is the absolute form;
 * `series_transformed` is the anomaly form, because that is what METEOR's own
 * timeseries path produces. They are not interchangeable.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { Bundle, GoldenFixture } from '../src/lib/bundle.js';
import {
  addBaseline,
  annualToMonthly,
  applyTransform,
  designMatrix,
  forcedResponse,
  projectPcs,
  seasonalCycle,
} from '../src/lib/kernel.js';
import { erfc, interp, normalCdf, normalGenerator } from '../src/lib/stats.js';

const DATA = new URL('../data/', import.meta.url);

const bundle = new Bundle(readFileSync(new URL('meteor_NorESM2-MM_pr_bundle_v1.nc', DATA)));
const fixture = new GoldenFixture(
  readFileSync(new URL('meteor_NorESM2-MM_pr_golden_ssp245_v1.nc', DATA))
);

describe('precipitation transform', () => {
  it('carries a gamma transform and its fitted window', () => {
    expect(bundle.hasTransform).toBe(true);
    expect(bundle.attrs.transform_type).toBe('gamma');
    expect(bundle.transformWindow).toEqual([2015, 2100]);
  });

  it('ships a transformed series to validate against', () => {
    expect(fixture.hasTransformed).toBe(true);
    expect(fixture.seasonalForm).toBe('absolute');
    // The forced response is annual and starts here, which is what aligns it
    // to the monthly terms. It must agree with the bundle's forcing axis.
    expect(fixture.year0).toBe(bundle.forcingYearStart);
  });

  it('reproduces METEOR end to end, baseline and quantile mapping included', () => {
    const forcing = bundle.forcing('ssp245');
    const nMonths = fixture.nMonths;
    const nYears = nMonths / 12;
    const offset = bundle.transformWindow[0] - fixture.year0;
    const design = designMatrix(fixture.array('t_glob'));

    for (const [i, location] of fixture.locations.entries()) {
      const forced = forcedResponse(bundle, location, forcing);
      const monthly = annualToMonthly(forced.subarray(offset, offset + nYears), nMonths);

      // The anomaly seasonal form: no intercept, no t_glob term.
      const seasonal = seasonalCycle(
        design,
        bundle.locationRow('seasonal_coef', location, 9),
        bundle.get('seasonal_intercept')[bundle.locationIndex(location)],
        { anomaly: true }
      );
      const projection = bundle.locationRow('eof_projection', location, bundle.nModes);

      const realizations = [];
      for (let r = 0; r < fixture.nRealizations; r += 1) {
        const stochastic = projectPcs(fixture.pcs(r), projection);
        realizations.push(
          Float64Array.from(seasonal, (v, t) => v + stochastic[t] + monthly[t])
        );
      }

      const actual = applyTransform(
        bundle,
        location,
        addBaseline(bundle, location, realizations)
      );

      // Transformed precipitation is strictly positive and of order 1e-5;
      // compare relative to the location's own magnitude.
      let scale = 0;
      for (let r = 0; r < fixture.nRealizations; r += 1) {
        for (const v of fixture.transformed(i, r)) scale = Math.max(scale, Math.abs(v));
      }

      let worst = 0;
      for (let r = 0; r < fixture.nRealizations; r += 1) {
        const expected = fixture.transformed(i, r);
        for (let t = 0; t < nMonths; t += 1) {
          worst = Math.max(worst, Math.abs(actual[r][t] - expected[t]) / scale);
        }
      }
      // Float32 wire precision: unlike the earlier comparison against a
      // Python-generated reference, both sides now go through the fixture's
      // stored float32 arrays.
      expect(worst, location).toBeLessThan(2e-7);

      for (const series of actual) {
        for (const v of series) expect(v).toBeGreaterThan(0);
      }
    }
  });

  it('refuses a bundle with no transform', () => {
    const tas = new Bundle(readFileSync(new URL('meteor_NorESM2-MM_tas_bundle_v1.nc', DATA)));
    expect(tas.hasTransform).toBe(false);
    expect(() => applyTransform(tas, 'global', [new Float64Array(12)])).toThrow(
      /no distribution transform/
    );
  });
});

describe('numerical primitives', () => {
  it('matches known normal CDF values', () => {
    // Reference values from scipy.stats.norm.cdf.
    expect(normalCdf(0)).toBeCloseTo(0.5, 12);
    expect(normalCdf(1)).toBeCloseTo(0.8413447460685429, 14);
    expect(normalCdf(-1)).toBeCloseTo(0.15865525393145707, 14);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021048517795, 14);
    expect(normalCdf(-3.5)).toBeCloseTo(0.00023262907903552502, 15);
  });

  it('keeps erfc symmetric', () => {
    for (const x of [0.1, 0.5, 1, 2, 3]) {
      expect(erfc(x) + erfc(-x)).toBeCloseTo(2, 10);
    }
  });

  it('interpolates linearly and clamps outside the grid', () => {
    const xp = [0, 1, 2];
    const fp = [0, 10, 20];
    expect(interp(0.5, xp, fp)).toBeCloseTo(5, 12);
    expect(interp(1.75, xp, fp)).toBeCloseTo(17.5, 12);
    // numpy.interp clamps rather than extrapolating.
    expect(interp(-1, xp, fp)).toBe(0);
    expect(interp(99, xp, fp)).toBe(20);
  });

  it('draws reproducible standard normals', () => {
    const first = normalGenerator(42);
    const second = normalGenerator(42);
    const a = Array.from({ length: 5 }, () => first());
    const b = Array.from({ length: 5 }, () => second());
    expect(a).toEqual(b);

    const draws = Array.from({ length: 20000 }, () => normalGenerator(7)());
    const sample = Array.from({ length: 20000 }, () => first());
    const mean = sample.reduce((s, v) => s + v, 0) / sample.length;
    const variance =
      sample.reduce((s, v) => s + (v - mean) ** 2, 0) / sample.length;
    expect(mean).toBeCloseTo(0, 1);
    expect(variance).toBeCloseTo(1, 1);
    expect(draws.length).toBe(20000);
  });
});
