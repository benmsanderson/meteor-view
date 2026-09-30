/**
 * The simple view's spread across models.
 *
 * What must hold: each model's contribution is exactly the forced response the
 * expert view draws, measured from the same 1850-1900 baseline; the spread of
 * one model is that model; and the sentence says what the numbers say.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { Bundle } from '../src/lib/bundle.js';
import { Explorer } from '../src/app/explorer.js';
import {
  SUMMARY_PERIODS,
  SUMMARY_YEARS,
  modelChange,
  summarizeLocation,
  summaryFile,
  summarySentence,
} from '../src/app/summary.js';

const DATA = new URL('../data/', import.meta.url);
const load = (variable) =>
  new Bundle(readFileSync(new URL(`meteor_NorESM2-MM_${variable}_bundle_v1.nc`, DATA)));
const explorer = new Explorer({ tas: load('tas'), pr: load('pr') });
const start = explorer.bundles.tas.forcingYearStart;

const mean = (series, from, to, first = start) => {
  let sum = 0;
  for (let y = from; y <= to; y += 1) sum += series[y - first];
  return sum / (to - from + 1);
};

describe('one model\'s change', () => {
  it('is the expert view\'s forced response, from the same baseline', () => {
    const location = 'regional:NEU';
    const change = modelChange(explorer, { variable: 'tas', location, scenario: 'cmip7-high' });
    const { forced, years } = explorer.run({
      variable: 'tas',
      location,
      scenario: 'cmip7-high',
      nRealizations: 1,
      seed: 1,
    });
    const offset = explorer.baselineOffset({ variable: 'tas', location, baseline: 'pi' });
    years.forEach((year, i) => {
      expect(change[year - start]).toBeCloseTo(forced[i] - offset, 12);
    });
  });

  it('averages to zero over 1850-1900 under the baseline scenario', () => {
    for (const variable of ['tas', 'pr']) {
      const change = modelChange(explorer, { variable, location: 'global', scenario: 'cmip7-medium' });
      expect(Math.abs(mean(change, 1850, 1900))).toBeLessThan(1e-9);
    }
  });

  it('gives precipitation as a plausible percentage', () => {
    const change = modelChange(explorer, { variable: 'pr', location: 'global', scenario: 'ssp585' });
    // Global precipitation rises by a few percent per degree of warming.
    const late = mean(change, 2081, 2100);
    expect(late).toBeGreaterThan(2);
    expect(late).toBeLessThan(15);
  });
});

describe('a place\'s summary', () => {
  const summary = summarizeLocation(new Map([['NorESM2-MM', explorer]]), 'global');

  it('is the model itself when there is only one', () => {
    const change = modelChange(explorer, { variable: 'tas', location: 'global', scenario: 'ssp245' });
    const { bands, end } = summary.tas.ssp245;
    expect(bands).toHaveLength(5);
    expect(bands[0]).toHaveLength(SUMMARY_YEARS.end - SUMMARY_YEARS.start + 1);
    for (const band of bands) {
      expect(band[0]).toBeCloseTo(change[SUMMARY_YEARS.start - start], 3);
      expect(band[band.length - 1]).toBeCloseTo(change[SUMMARY_YEARS.end - start], 3);
    }
    const { from, to } = SUMMARY_PERIODS.end;
    for (const q of end) expect(q).toBeCloseTo(mean(change, from, to), 3);
  });

  it('carries every scenario, for both variables', () => {
    for (const variable of ['tas', 'pr']) {
      expect(Object.keys(summary[variable]).sort()).toEqual([...explorer.scenarios].sort());
    }
  });

  it('has a file name safe for any place', () => {
    expect(summaryFile('point:-23.5,-46.6')).toBe('summary_v1/point_-23.5_-46.6.json');
    expect(summaryFile('regional:NEU')).toBe('summary_v1/regional_NEU.json');
  });
});

describe('the sentence', () => {
  const summary = {
    models: Array.from({ length: 30 }, (_, i) => `M${i}`),
    periods: SUMMARY_PERIODS,
    tas: { a: { end: [1.14, 1.3, 1.62, 1.9, 2.37] }, b: { end: [2.6, 3, 3.5, 4, 4.6] } },
    pr: { a: { end: [-4.2, -1, 2.9, 4, 5.2] } },
  };
  const label = (s) => ({ a: 'Very Low', b: 'High' })[s];

  it('names each scenario with its middle model and range', () => {
    expect(
      summarySentence({ summary, variable: 'tas', scenarios: ['a', 'b'], label, place: 'global' })
    ).toBe(
      'By 2081–2100, global temperature is 1.6 °C (1.1–2.4) under Very Low and ' +
        '3.5 °C (2.6–4.6) under High, warmer than in 1850–1900. ' +
        'Figures in brackets span the middle 90% of the 30 climate models.'
    );
  });

  it('signs precipitation changes, with a proper minus', () => {
    expect(
      summarySentence({ summary, variable: 'pr', scenarios: ['a'], label, place: 'London' })
    ).toBe(
      'By 2081–2100, precipitation in London changes by +3% (−4 to +5%) under Very Low, ' +
        'compared with 1850–1900. Figures in brackets span the middle 90% of the 30 climate models.'
    );
  });

  it('does not claim a range from one model', () => {
    const one = { ...summary, models: ['M0'] };
    expect(
      summarySentence({ summary: one, variable: 'tas', scenarios: ['a'], label, place: 'global' })
    ).toContain('one climate model only');
  });
});
