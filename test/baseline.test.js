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
        landOnly: false,
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

describe('absolute values', () => {
  it('turn a temperature run into temperatures a reader would recognise', () => {
    const at = (location) => explorer.absoluteOffset({ variable: 'tas', location });
    // The unforced annual-mean level: a global mean near 14 °C, the Sahara
    // hot and East Antarctica far below freezing.
    expect(at('global')).toBeGreaterThan(12);
    expect(at('global')).toBeLessThan(16);
    expect(at('regional:SAH')).toBeGreaterThan(20);
    expect(at('regional:EAN')).toBeLessThan(-20);
  });

  it('leave precipitation alone, which is absolute already', () => {
    expect(explorer.absoluteOffset({ variable: 'pr', location: 'global' })).toBe(0);
  });
});

describe('drawn regions over land', () => {
  // A synthetic land mask rather than a model's: these test the weighting,
  // and the model data lives off this branch (docs/05-training-run.md). Land
  // is 0-60 E between the equator and 70 N; everything else is sea.
  beforeAll(async () => {
    const artifact = await explorer.patterns('tas');
    const { lat, lon, nLat, nLon } = artifact;
    explorer.landPercent = Float64Array.from({ length: nLat * nLon }, (_, k) => {
      const la = lat[Math.floor(k / nLon)];
      const lo = lon[k % nLon];
      return la >= 0 && la <= 70 && lo >= 0 && lo <= 60 ? 100 : 0;
    });
  });

  const box = (south, north, west, east) => (lat, lon) => {
    const l = ((lon % 360) + 360) % 360;
    return lat >= south && lat <= north && (west <= east ? l >= west && l <= east : l >= west || l <= east);
  };

  it('average over land only when asked, which differs in a part-land box', async () => {
    // 350 E to 10 E: sea to the west of the meridian, land to the east.
    const mask = box(40, 50, 350, 10);
    const land = await explorer.customForcedFull({ variable: 'tas', scenario: 'ssp585', mask, landOnly: true });
    const all = await explorer.customForcedFull({ variable: 'tas', scenario: 'ssp585', mask, landOnly: false });
    expect(land.landOnly).toBe(true);
    expect(all.landOnly).toBe(false);
    const last = land.annual.length - 1;
    expect(Math.abs(land.annual[last] - all.annual[last])).toBeGreaterThan(1e-3);
  });

  it('fall back to every gridbox over open sea, and say so', async () => {
    const mask = box(-40, -30, 220, 230);
    const result = await explorer.customForcedFull({ variable: 'tas', scenario: 'ssp245', mask, landOnly: true });
    expect(result.landOnly).toBe(false);
  });

  it('change nothing in a box that is all land', async () => {
    const mask = box(20, 26, 5, 20);
    const land = await explorer.customForcedFull({ variable: 'tas', scenario: 'ssp245', mask, landOnly: true });
    const all = await explorer.customForcedFull({ variable: 'tas', scenario: 'ssp245', mask, landOnly: false });
    const last = land.annual.length - 1;
    expect(Math.abs(land.annual[last] - all.annual[last])).toBeLessThan(1e-9);
  });
});
