/**
 * Change from a baseline period.
 *
 * A baseline is the forced response averaged over the period, under one
 * shared scenario. These check it three ways: by definition, against the
 * independent map route, and by the linearity the map baseline relies on.
 */

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

import { Bundle } from '../src/lib/bundle.js';
import { PatternArtifact } from '../src/lib/pattern.js';
import { forcedResponse } from '../src/lib/kernel.js';
import { BASELINES, Explorer } from '../src/app/explorer.js';

const DATA = new URL('../data/', import.meta.url);
const MODEL = 'CanESM5';
let explorer;

beforeAll(() => {
  const load = (variable) =>
    new Bundle(readFileSync(new URL(`meteor_${MODEL}_${variable}_bundle_v1.nc`, DATA)));
  explorer = new Explorer({ tas: load('tas'), pr: load('pr') });
  // Loaded here rather than fetched, as the page would.
  for (const variable of ['tas', 'pr']) {
    explorer.patternArtifacts.set(
      variable,
      new PatternArtifact(
        readFileSync(new URL(`meteor_${MODEL}_${variable}_pattern_v1.nc`, DATA))
      )
    );
  }
});

describe('baselines', () => {
  it('are taken from CMIP7 Medium', () => {
    expect(explorer.baselineScenario).toBe('cmip7-medium');
  });

  it('put the reference scenario at zero over its own period', () => {
    const bundle = explorer.bundles.tas;
    const forced = forcedResponse(bundle, 'global', bundle.forcing('cmip7-medium'));
    const offset = explorer.baselineOffset({
      variable: 'tas',
      location: 'global',
      baseline: 'recent',
    });
    const { from, to } = BASELINES.recent;
    let sum = 0;
    for (let year = from; year <= to; year += 1) {
      sum += forced[year - bundle.forcingYearStart] - offset;
    }
    expect(Math.abs(sum / (to - from + 1))).toBeLessThan(1e-9);
  });

  it('shift by the historical warming between the two periods', () => {
    const offset = (baseline) =>
      explorer.baselineOffset({ variable: 'tas', location: 'global', baseline });
    // CanESM5 warms fastest of the seven: about 1.6 °C from 1850-1900 to
    // 2005-2024 in the emulator.
    expect(offset('recent') - offset('pi')).toBeGreaterThan(1.4);
    expect(offset('recent') - offset('pi')).toBeLessThan(1.8);
  });

  it('agree between a drawn whole-globe region and the global mean', async () => {
    // Two independent routes: the bundle's precomputed projection, and the
    // pattern artifact projected onto an area-weighted mask.
    for (const baseline of ['pi', 'recent']) {
      const listed = explorer.baselineOffset({ variable: 'tas', location: 'global', baseline });
      const drawn = await explorer.customBaselineOffset({
        variable: 'tas',
        // Every gridpoint, area-weighted: the global mean by the map route.
        mask: () => true,
        baseline,
      });
      expect(Math.abs(drawn - listed)).toBeLessThan(1e-4 * Math.abs(listed) + 1e-6);
    }
  });

  it('map to the average of the yearly maps over the period', async () => {
    const { mean } = await explorer.baselineMap({ variable: 'pr', baseline: 'recent' });
    const { from, to } = BASELINES.recent;
    const sum = new Float64Array(mean.length);
    for (let year = from; year <= to; year += 1) {
      const { field } = await explorer.forcedMap({
        variable: 'pr',
        scenario: 'cmip7-medium',
        year,
      });
      for (let i = 0; i < sum.length; i += 1) sum[i] += field[i];
    }
    let scale = 0;
    let worst = 0;
    for (let i = 0; i < sum.length; i += 1) {
      const average = sum[i] / (to - from + 1);
      scale = Math.max(scale, Math.abs(average));
      worst = Math.max(worst, Math.abs(average - mean[i]));
    }
    expect(worst / scale).toBeLessThan(1e-9);
  });
});
