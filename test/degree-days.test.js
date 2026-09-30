/**
 * Bias-corrected degree days.
 *
 * What must hold: the curves are read correctly; a model's own 1995-2014
 * climate is where its warming is measured from; and so, over 1995-2014, every
 * model gives back the observed degree days, whatever its own absolute
 * climate, which is the point of correcting it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { Bundle } from '../src/lib/bundle.js';
import { Explorer } from '../src/app/explorer.js';
import {
  DEGREE_DAY_PERIOD,
  annualSums,
  curveValue,
  degreeDayFile,
  deterministicMonthly,
  monthlyDegreeDays,
  referenceClimate,
} from '../src/lib/degree-days.js';
import { modelDegreeDays } from '../src/app/summary.js';

const DATA = new URL('../data/', import.meta.url);
const LONDON = 'point:51.5,-0.1';
const curves = JSON.parse(readFileSync(new URL(degreeDayFile(LONDON), DATA)));

const load = (variable) =>
  new Bundle(readFileSync(new URL(`meteor_NorESM2-MM_${variable}_bundle_v1.nc`, DATA)));
const explorer = new Explorer({ tas: load('tas'), pr: load('pr') });

describe('the curves', () => {
  it('are read exactly at their points and linearly between them', () => {
    const { start, step } = curves.shifts;
    const at = (i) => curves.climate.hdd[0][i];
    const zero = Math.round(-start / step);
    expect(curveValue(curves, 'climate', 'hdd', 0, 0)).toBeCloseTo(at(zero), 9);
    expect(curveValue(curves, 'climate', 'hdd', 0, step / 2)).toBeCloseTo(
      (at(zero) + at(zero + 1)) / 2,
      9
    );
  });

  it('add up to the observed annual totals', () => {
    for (const index of ['hdd', 'cdd']) {
      let total = 0;
      for (let m = 0; m < 12; m += 1) total += curveValue(curves, 'climate', index, m, 0);
      expect(total).toBeCloseTo(curves.observed_annual[index], 0);
    }
  });

  it('fall with warming for heating and rise for cooling, never below zero', () => {
    for (let m = 0; m < 12; m += 1) {
      for (const kind of ['climate', 'within']) {
        const hdd = curves[kind].hdd[m];
        const cdd = curves[kind].cdd[m];
        for (let i = 1; i < hdd.length; i += 1) {
          expect(hdd[i]).toBeLessThanOrEqual(hdd[i - 1] + 1e-9);
          expect(cdd[i]).toBeGreaterThanOrEqual(cdd[i - 1] - 1e-9);
        }
        expect(Math.min(...hdd, ...cdd)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('put London\'s observed heating and cooling where they belong', () => {
    // About 2,500 heating and a hundred or two cooling degree days at 18 °C.
    expect(curves.observed_annual.hdd).toBeGreaterThan(2000);
    expect(curves.observed_annual.hdd).toBeLessThan(3200);
    expect(curves.observed_annual.cdd).toBeGreaterThan(20);
    expect(curves.observed_annual.cdd).toBeLessThan(400);
  });

  it('exist for land but not for the sea or the globe', () => {
    expect(existsSync(new URL(degreeDayFile('regional:NEU'), DATA))).toBe(true);
    expect(existsSync(new URL(degreeDayFile('regional:EPO'), DATA))).toBe(false);
    expect(existsSync(new URL(degreeDayFile('global'), DATA))).toBe(false);
  });
});

describe('a model\'s warming', () => {
  it('is measured from its own 1995-2014 climate of each month', () => {
    const monthly = deterministicMonthly(explorer, LONDON, explorer.baselineScenario);
    const reference = referenceClimate(explorer, LONDON);
    const first = (DEGREE_DAY_PERIOD.from - explorer.bundles.tas.forcingYearStart) * 12;
    for (let m = 0; m < 12; m += 1) {
      let sum = 0;
      for (let y = 0; y < 20; y += 1) sum += monthly[first + y * 12 + m];
      expect(reference[m]).toBeCloseTo(sum / 20, 9);
    }
  });

  it('is what the runs scatter around', () => {
    const run = explorer.run({
      variable: 'tas',
      location: LONDON,
      scenario: 'cmip7-high',
      nRealizations: 100,
      seed: 5,
    });
    const monthly = deterministicMonthly(explorer, LONDON, 'cmip7-high');
    const offset = (2015 - explorer.bundles.tas.forcingYearStart) * 12;
    let worst = 0;
    for (let m = 0; m < 12; m += 1) {
      let sum = 0;
      let count = 0;
      for (const series of run.series) {
        for (let t = m; t < series.length; t += 12) {
          sum += series[t] - monthly[offset + t];
          count += 1;
        }
      }
      worst = Math.max(worst, Math.abs(sum / count));
    }
    expect(worst).toBeLessThan(0.1);
  });
});

describe('bias-corrected degree days', () => {
  it('give back the observed climate over 1995-2014, whatever the model', () => {
    for (const index of ['hdd', 'cdd']) {
      const annual = modelDegreeDays(explorer, {
        index,
        location: LONDON,
        scenario: explorer.baselineScenario,
        curves,
      });
      const start = explorer.bundles.tas.forcingYearStart;
      let sum = 0;
      for (let y = DEGREE_DAY_PERIOD.from; y <= DEGREE_DAY_PERIOD.to; y += 1) sum += annual[y - start];
      const observed = curves.observed_annual[index];
      // Within 3%, or a few degree days: warming within the period is small.
      expect(Math.abs(sum / 20 - observed)).toBeLessThan(Math.max(0.03 * observed, 5));
    }
  });

  it('fall for heating and rise for cooling as it warms', () => {
    const at = (index, scenario) => {
      const annual = modelDegreeDays(explorer, { index, location: LONDON, scenario, curves });
      const start = explorer.bundles.tas.forcingYearStart;
      let sum = 0;
      for (let y = 2081; y <= 2100; y += 1) sum += annual[y - start];
      return sum / 20;
    };
    expect(at('hdd', 'cmip7-high')).toBeLessThan(at('hdd', 'cmip7-very-low'));
    expect(at('cdd', 'cmip7-high')).toBeGreaterThan(at('cdd', 'cmip7-very-low'));
  });

  it('turn a realization into monthly degree days on the observed curve', () => {
    const reference = referenceClimate(explorer, LONDON);
    // A realization sitting exactly on the reference climate is the observed
    // climate with no year-to-year variability of its own.
    const series = Float64Array.from({ length: 24 }, (_, t) => reference[t % 12]);
    const monthly = monthlyDegreeDays(curves, 'within', 'hdd', series, reference);
    const [first] = annualSums(monthly);
    let expected = 0;
    for (let m = 0; m < 12; m += 1) expected += curveValue(curves, 'within', 'hdd', m, 0);
    expect(first).toBeCloseTo(expected, 9);
  });
});
