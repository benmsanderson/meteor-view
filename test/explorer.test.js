/**
 * End-to-end: the whole client pipeline against METEOR's own generation API.
 *
 * The golden fixtures check the kernel's arithmetic. This checks the
 * bookkeeping around it — which trajectory drives what, over which years, in
 * which order — which is where a port produces plausible-looking wrong
 * answers rather than errors.
 *
 * A port cannot reproduce NumPy's PCG64 stream, so this compares the ensemble
 * *mean* over 200 realizations, which converges to the deterministic part, and
 * the ensemble spread, which is a property of the model rather than the draw.
 * Reference in `test/fixtures/ensemble_reference.json`, from
 * `scripts/make_ensemble_reference.py`.
 */

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

import { Bundle } from '../src/lib/bundle.js';
import { Explorer, WINDOW } from '../src/app/explorer.js';
import { placeLabel } from '../src/app/places.js';

const DATA = new URL('../data/', import.meta.url);
const reference = JSON.parse(
  readFileSync(new URL('./fixtures/ensemble_reference.json', import.meta.url))
);

/**
 * Ensemble size for this side of the comparison.
 *
 * Need not match the reference's, since the tolerance below is derived from
 * both counts. Half of it keeps the suite quick without weakening the test:
 * the standard error of the difference grows only from 0.100 to 0.122 standard
 * deviations, while the runtime halves.
 */
const N_REALIZATIONS = 100;

let explorer;

beforeAll(() => {
  const load = (variable) =>
    new Bundle(readFileSync(new URL(`meteor_NorESM2-MM_${variable}_bundle_v1.nc`, DATA)));
  explorer = new Explorer({ tas: load('tas'), pr: load('pr') });
});

/** Annual means of a monthly series. */
function annualMeans(series) {
  const years = series.length / 12;
  return Float64Array.from({ length: years }, (_, y) => {
    let sum = 0;
    for (let m = 0; m < 12; m += 1) sum += series[y * 12 + m];
    return sum / 12;
  });
}

function ensembleStatistics(series) {
  const annual = series.map(annualMeans);
  const years = annual[0].length;
  const mean = new Float64Array(years);
  const std = new Float64Array(years);
  for (let y = 0; y < years; y += 1) {
    let sum = 0;
    for (const a of annual) sum += a[y];
    mean[y] = sum / annual.length;
    let sq = 0;
    for (const a of annual) sq += (a[y] - mean[y]) ** 2;
    std[y] = Math.sqrt(sq / annual.length);
  }
  return { mean, std };
}

describe.each(['tas', 'pr'])('%s against METEOR', (variable) => {
  it.each(['global', 'regional:NEU', 'point:19.1,72.9'])(
    'reproduces the ensemble mean at %s',
    (location) => {
      const expected = reference.values[variable][location];
      const { series } = explorer.run({
        variable,
        location,
        scenario: reference.scenario,
        nRealizations: N_REALIZATIONS,
        seed: 12345,
      });

      expect(series.length).toBe(N_REALIZATIONS);
      const { mean, std } = ensembleStatistics(series);
      expect(mean.length).toBe(expected.ensemble_mean.length);

      // Two independent ensembles of the same process, of possibly different
      // sizes, so the difference of their means has standard error
      // std * sqrt(1/n + 1/m) per year. Taking the worst of 86 years samples
      // the tail, so the gate is six of those rather than the ~3 a single year
      // would need.
      //
      // This is loose in absolute terms and still very tight against the
      // failures that matter: the undocumented anomaly convention showed up
      // here at 6600x, a cold-started VAR or a mis-sliced window at hundreds.
      const referenceStd = expected.ensemble_std;
      const standardError = Math.sqrt(
        1 / N_REALIZATIONS + 1 / reference.n_realizations
      );
      const combined = (y) => referenceStd[y] * standardError;

      let worst = 0;
      for (let y = 0; y < mean.length; y += 1) {
        const tolerance = 6 * combined(y);
        worst = Math.max(
          worst,
          Math.abs(mean[y] - expected.ensemble_mean[y]) / (tolerance || 1)
        );
      }
      expect(worst, `${variable} ${location} ensemble mean`).toBeLessThan(1);

      // Averaging over the window beats the per-year noise down by another
      // sqrt(86), so the window means must agree far more closely. This is
      // the assertion that would catch a small constant bias.
      const windowMean = (values) =>
        [...values].reduce((s, v) => s + v, 0) / values.length;
      const bias = Math.abs(windowMean(mean) - windowMean(expected.ensemble_mean));
      const biasTolerance =
        (6 * windowMean(referenceStd) * standardError) / Math.sqrt(mean.length);
      expect(bias, `${variable} ${location} window-mean bias`).toBeLessThan(
        biasTolerance
      );

      // The spread is a model property, not a draw property: it should agree
      // much more closely than any single realization does.
      const meanStd = std.reduce((s, v) => s + v, 0) / std.length;
      const referenceMeanStd =
        referenceStd.reduce((s, v) => s + v, 0) / referenceStd.length;
      expect(meanStd / referenceMeanStd, `${variable} ${location} spread`).toBeGreaterThan(0.8);
      expect(meanStd / referenceMeanStd, `${variable} ${location} spread`).toBeLessThan(1.25);
    }
  );

  it.each(['global', 'regional:NEU'])('reproduces the seasonal cycle at %s', (location) => {
    const expected = reference.values[variable][location].monthly_climatology;
    const { series } = explorer.run({
      variable,
      location,
      scenario: reference.scenario,
      nRealizations: 60,
      seed: 999,
    });

    // Climatology: mean over realizations and years, by calendar month.
    const climatology = new Float64Array(12);
    for (let m = 0; m < 12; m += 1) {
      let sum = 0;
      let count = 0;
      for (const s of series) {
        for (let t = m; t < s.length; t += 12) {
          sum += s[t];
          count += 1;
        }
      }
      climatology[m] = sum / count;
    }

    // The seasonal cycle is large compared to the sampling noise in its mean,
    // so compare against the amplitude of the cycle itself.
    const amplitude = Math.max(...expected) - Math.min(...expected);
    for (let m = 0; m < 12; m += 1) {
      expect(
        Math.abs(climatology[m] - expected[m]) / amplitude,
        `${variable} ${location} month ${m}`
      ).toBeLessThan(0.05);
    }
  });
});

describe('explorer bookkeeping', () => {
  it('returns the output window the transform is fitted for', () => {
    const { years, series } = explorer.run({
      variable: 'tas',
      location: 'global',
      scenario: 'ssp245',
      nRealizations: 2,
      seed: 1,
    });
    expect(years[0]).toBe(WINDOW.start);
    expect(years[years.length - 1]).toBe(WINDOW.end);
    expect(series[0].length).toBe(years.length * 12);
    expect(explorer.bundles.pr.transformWindow).toEqual([WINDOW.start, WINDOW.end]);
  });

  it('spins the VAR up before the window rather than starting from zero', () => {
    // A cold start would pin the first months at zero and ramp out of nothing.
    // The spread in the opening year should already match the closing year's.
    const { series } = explorer.run({
      variable: 'tas',
      location: 'global',
      scenario: 'ssp245',
      nRealizations: 120,
      seed: 7,
    });
    const spreadAt = (month) => {
      const values = series.map((s) => s[month]);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      return Math.sqrt(
        values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length
      );
    };
    const opening = spreadAt(0);
    const closing = spreadAt(series[0].length - 1);
    expect(opening).toBeGreaterThan(0);
    expect(opening / closing).toBeGreaterThan(0.5);
    expect(opening / closing).toBeLessThan(2);
  });

  it('follows a prescribed warming pathway', () => {
    const years = explorer.years('tas');
    const predicted = explorer.globalWarming('ssp245');

    // Hold warming flat from 2015 onwards, at its 2015 level.
    const index2015 = years.indexOf(2015);
    const pathway = Float64Array.from(predicted);
    for (let i = index2015; i < pathway.length; i += 1) pathway[i] = predicted[index2015];

    const flat = explorer.run({
      variable: 'tas',
      location: 'global',
      scenario: 'ssp245',
      nRealizations: 40,
      seed: 3,
      pathway,
    });
    const free = explorer.run({
      variable: 'tas',
      location: 'global',
      scenario: 'ssp245',
      nRealizations: 40,
      seed: 3,
    });

    const trend = (run) => {
      const first = annualMeans(run.series[0]);
      return first[first.length - 1] - first[0];
    };
    // ssp245 warms over the century; a pathway held flat must not.
    expect(trend(free)).toBeGreaterThan(1);
    expect(Math.abs(trend(flat))).toBeLessThan(trend(free) / 2);
  });

  it('uses the temperature response as the pathway denominator for pr too', () => {
    // Precipitation rescaled to a flat temperature pathway must also flatten.
    // If the denominator were the precipitation response, the ratio would be
    // wrong and this would not hold.
    const years = explorer.years('tas');
    const predicted = explorer.globalWarming('ssp245');
    const index2015 = years.indexOf(2015);
    const pathway = Float64Array.from(predicted);
    for (let i = index2015; i < pathway.length; i += 1) pathway[i] = predicted[index2015];

    const flat = explorer.run({
      variable: 'pr',
      location: 'global',
      scenario: 'ssp245',
      nRealizations: 20,
      seed: 4,
      pathway,
    });
    const free = explorer.run({
      variable: 'pr',
      location: 'global',
      scenario: 'ssp245',
      nRealizations: 20,
      seed: 4,
    });
    const meanTrend = (run) => {
      const annual = run.series.map(annualMeans);
      const at = (y) => annual.reduce((s, a) => s + a[y], 0) / annual.length;
      return at(annual[0].length - 1) - at(0);
    };
    expect(meanTrend(free)).toBeGreaterThan(0);
    expect(meanTrend(flat)).toBeLessThan(meanTrend(free));
  });

  it('generates strictly positive precipitation', () => {
    const { series } = explorer.run({
      variable: 'pr',
      location: 'regional:NEU',
      scenario: 'ssp585',
      nRealizations: 5,
      seed: 2,
    });
    for (const s of series) for (const v of s) expect(v).toBeGreaterThan(0);
  });

  it('offers every bundled scenario', () => {
    expect(explorer.scenarios).toContain('ssp126');
    expect(explorer.scenarios).toContain('ssp585');
    expect(explorer.scenarios.length).toBe(15);
  });
});

describe('place labels', () => {
  it('names global, regions and cities', () => {
    expect(placeLabel('global')).toBe('Global mean');
    expect(placeLabel('regional:NEU')).toMatch(/NEU/);
    expect(placeLabel('point:19.1,72.9')).toBe('Mumbai');
  });

  it('falls back to the specifier for an unknown place', () => {
    expect(placeLabel('point:1,2')).toBe('1,2');
  });
});
