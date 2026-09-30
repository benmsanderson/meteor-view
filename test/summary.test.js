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
const LONDON = 'point:51.5,-0.1';
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

  it('anchors degree days on the observed climate', () => {
    const withDays = {
      ...summary,
      observed: { period: { from: 1995, to: 2014 }, hdd: 2773.7, cdd: 52.9 },
      hdd: { a: { end: [2185, 2393, 2550, 2694, 2851] } },
    };
    expect(
      summarySentence({ summary: withDays, variable: 'hdd', scenarios: ['a'], label, place: 'London' })
    ).toBe(
      'Heating degree days in London were 2,774 a year in 1995–2014, as observed. ' +
        'By 2081–2100 they come to 2,550 (2,185–2,851) under Very Low. ' +
        'Figures in brackets span the middle 90% of the 30 climate models.'
    );
  });

  it('does not claim a range from one model', () => {
    const one = { ...summary, models: ['M0'] };
    expect(
      summarySentence({ summary: one, variable: 'tas', scenarios: ['a'], label, place: 'global' })
    ).toContain('one climate model only');
  });
});

describe('the map across models', async () => {
  const { PatternArtifact } = await import('../src/lib/pattern.js');
  const { Artifact } = await import('../src/lib/bundle.js');
  const { regrid } = await import('../src/app/map.js');
  const { SUMMARY_GRID, mapFromFile, modelMapChange, summarizeMap } = await import('../src/app/summary.js');
  const read = (name) => readFileSync(new URL(`meteor_NorESM2-MM_${name}_v1.nc`, DATA));
  explorer.patternArtifacts.set('tas', new PatternArtifact(read('tas_pattern')));
  explorer.patternArtifacts.set('pr', new PatternArtifact(read('pr_pattern')));
  explorer.prClimatology = new Artifact(read('pr_climatology')).array('pr_climatology');

  it('is the model itself when there is only one, on the common grid', async () => {
    const file = await summarizeMap(new Map([['NorESM2-MM', explorer]]), 'cmip7-high');
    const own = await modelMapChange(explorer, { variable: 'tas', scenario: 'cmip7-high' });
    const onGrid = regrid(own, SUMMARY_GRID.lat, SUMMARY_GRID.lon);
    const { field } = mapFromFile(file, 'tas');
    field.forEach((v, k) => expect(v).toBeCloseTo(onGrid[k], 1));
  });

  it('averages over the globe to the global warming of the same period', async () => {
    const own = await modelMapChange(explorer, { variable: 'tas', scenario: 'cmip7-high' });
    let sum = 0;
    let weight = 0;
    own.lat.forEach((la, i) => {
      const w = Math.cos((la * Math.PI) / 180);
      for (let j = 0; j < own.lon.length; j += 1) {
        sum += w * own.field[i * own.lon.length + j];
        weight += w;
      }
    });
    const global = modelChange(explorer, { variable: 'tas', location: 'global', scenario: 'cmip7-high' });
    expect(sum / weight).toBeCloseTo(mean(global, 2081, 2100), 1);
  });
});

describe('a city beyond the bundles', async () => {
  const { Artifact } = await import('../src/lib/bundle.js');
  const { PatternArtifact, pointWeights } = await import('../src/lib/pattern.js');
  const { summarizeCity } = await import('../src/app/summary.js');
  const read = (name) => readFileSync(new URL(`meteor_NorESM2-MM_${name}_v1.nc`, DATA));
  explorer.patternArtifacts.set('tas', new PatternArtifact(read('tas_pattern')));
  explorer.patternArtifacts.set('pr', new PatternArtifact(read('pr_pattern')));
  explorer.prClimatology = new Artifact(read('pr_climatology')).array('pr_climatology');
  explorer.landPercent = new Artifact(read('landfrac')).array('land_percent');
  const one = new Map([['NorESM2-MM', explorer]]);

  it('is what the bundle gives, for a city the bundle does carry', async () => {
    const byBundle = summarizeLocation(one, LONDON);
    const byPattern = await summarizeCity(one, { spec: LONDON });
    for (const variable of ['tas', 'pr']) {
      for (const scenario of ['ssp245', 'cmip7-high']) {
        byBundle[variable][scenario].bands[2].forEach((v, t) =>
          expect(byPattern[variable][scenario].bands[2][t]).toBeCloseTo(v, 1)
        );
      }
    }
  });

  it('sits on the nearest gridbox that is mostly land', () => {
    const artifact = explorer.patternArtifacts.get('tas');
    // Mumbai: the nearest gridbox is mostly sea, so the city moves inland.
    const { index } = pointWeights(artifact, explorer.landPercent, 19.1, 72.9);
    expect(explorer.landPercent[index]).toBeGreaterThan(50);
    const nearest = pointWeights(artifact, null, 19.1, 72.9).index;
    expect(explorer.landPercent[nearest]).toBeLessThan(50);
  });
});
