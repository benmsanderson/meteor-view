/**
 * URL state and export.
 *
 * A shared link is only useful if it reproduces the view exactly, so the
 * round-trip is the thing under test.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULTS, fromQuery, toQuery } from '../src/app/state.js';
import { filenameStem, toCsv } from '../src/app/export.js';
import { groupScenarios, scenarioFamily, scenarioLabel } from '../src/app/scenarios.js';

const CONTEXT = {
  locations: ['global', 'regional:NEU', 'point:19.1,72.9'],
  scenarios: ['ssp126', 'ssp245', 'ssp585'],
  models: ['NorESM2-MM', 'CanESM5'],
};

describe('URL state', () => {
  it('omits defaults, so a plain view has a clean URL', () => {
    expect(toQuery({ ...DEFAULTS })).toBe('');
  });

  it('round-trips a full state', () => {
    const state = {
      model: 'CanESM5',
      variable: 'pr',
      location: 'regional:NEU',
      scenario: 'ssp585',
      nRealizations: 50,
      seed: 12345,
    };
    expect(fromQuery(toQuery(state), CONTEXT)).toEqual(state);
  });

  it('keeps location specifiers intact through encoding', () => {
    // These carry ':' and ',' and must come back byte-identical, because the
    // bundle matches them as opaque keys.
    const state = { ...DEFAULTS, location: 'point:19.1,72.9' };
    const parsed = fromQuery(toQuery(state), CONTEXT);
    expect(parsed.location).toBe('point:19.1,72.9');
  });

  it('falls back per field rather than failing whole', () => {
    const parsed = fromQuery(
      '?m=HadGEM9&v=nonsense&loc=regional:NOWHERE&scn=ssp999&n=abc',
      CONTEXT
    );
    expect(parsed).toEqual(DEFAULTS);
  });

  it('names the model only when it is not the default', () => {
    expect(toQuery({ ...DEFAULTS, model: 'CanESM5' })).toBe('?m=CanESM5');
    expect(toQuery({ ...DEFAULTS, model: DEFAULTS.model })).toBe('');
  });

  it('accepts only models the site carries', () => {
    // The model decides which files are fetched, so an unknown one must not
    // reach a URL.
    expect(fromQuery('?m=CanESM5', CONTEXT).model).toBe('CanESM5');
    expect(fromQuery('?m=../../etc', CONTEXT).model).toBe(DEFAULTS.model);
    expect(fromQuery('?m=CanESM5', { ...CONTEXT, models: [] }).model).toBe(DEFAULTS.model);
  });

  it('caps the realization count a link can demand', () => {
    // Otherwise a link is a denial-of-service on whoever opens it.
    expect(fromQuery('?n=1000000', CONTEXT).nRealizations).toBe(DEFAULTS.nRealizations);
    expect(fromQuery('?n=0', CONTEXT).nRealizations).toBe(DEFAULTS.nRealizations);
    expect(fromQuery('?n=200', CONTEXT).nRealizations).toBe(200);
  });
});

describe('CSV export', () => {
  const bundle = {
    attrs: {
      cmip6_model: 'NorESM2-MM',
      training_scenario: 'ssp245',
      meteor_version: '1.6.1',
    },
    schemaVersion: 1,
  };

  const csv = toCsv({
    years: [2015, 2016],
    series: [
      Float64Array.from({ length: 24 }, (_, i) => i / 3),
      Float64Array.from({ length: 24 }, (_, i) => -i / 7),
    ],
    bundle,
    variable: 'tas',
    location: 'global',
    scenario: 'ssp245',
    units: 'Temperature anomaly (°C)',
    seed: 42,
    url: 'https://example.invalid/?v=tas',
  });
  const lines = csv.trimEnd().split('\n');
  const dataLines = lines.filter((l) => !l.startsWith('#'));

  it('carries provenance as comment lines', () => {
    expect(csv).toContain('# cmip6_model: NorESM2-MM');
    expect(csv).toContain('# meteor_version: 1.6.1');
    expect(csv).toContain('# regenerate: https://example.invalid/?v=tas');
    // The caveat belongs with the numbers, not only in the UI.
    expect(csv).toContain("cannot");
    expect(csv).toContain('PCG64');
  });

  it('has one row per month and one column per realization', () => {
    expect(dataLines[0]).toBe('year,month,realization_01,realization_02');
    expect(dataLines.length).toBe(1 + 24);
    expect(dataLines[1].startsWith('2015,1,')).toBe(true);
    expect(dataLines[12].startsWith('2015,12,')).toBe(true);
    expect(dataLines[13].startsWith('2016,1,')).toBe(true);
  });

  it('round-trips values without visible loss', () => {
    const third = Number(dataLines[2].split(',')[2]);
    expect(third).toBeCloseTo(1 / 3, 6);
  });
});

describe('filenames', () => {
  it('says what the file is without needing the metadata', () => {
    expect(
      filenameStem({
        cmip6Model: 'NorESM2-MM',
        variable: 'pr',
        location: 'regional:SAS',
        scenario: 'ssp370',
      })
    ).toBe('meteor_NorESM2-MM_pr_SAS_ssp370');
  });

  it('keeps a point location filesystem-safe', () => {
    const stem = filenameStem({
      cmip6Model: 'NorESM2-MM',
      variable: 'tas',
      location: 'point:19.1,72.9',
      scenario: 'ssp245',
    });
    expect(stem).toBe('meteor_NorESM2-MM_tas_19.1_72.9_ssp245');
    expect(stem).not.toMatch(/[:,/\\]/);
  });
});

describe('seed handling', () => {
  it('uses the default seed when a link carries none', () => {
    // Number(null) is 0, not NaN, so an absent seed used to parse as 0 — and
    // since toQuery omits the default, a copied link came back with seed 0 and
    // reproduced a different ensemble than the view it was copied from.
    expect(fromQuery('?v=pr', CONTEXT).seed).toBe(DEFAULTS.seed);
    expect(fromQuery('', CONTEXT).seed).toBe(DEFAULTS.seed);
  });

  it('round-trips a resampled seed', () => {
    const state = { ...DEFAULTS, seed: 0 };
    expect(fromQuery(toQuery(state), CONTEXT).seed).toBe(0);
    const big = { ...DEFAULTS, seed: 4294967295 };
    expect(fromQuery(toQuery(big), CONTEXT).seed).toBe(4294967295);
  });
});

describe('scenario families', () => {
  const ALL = [
    'ssp119', 'ssp126', 'ssp245', 'ssp370', 'ssp434', 'ssp460', 'ssp534-over',
    'ssp585', 'cmip7-very-low', 'cmip7-low', 'cmip7-low-to-negative',
    'cmip7-medium-to-low', 'cmip7-medium', 'cmip7-high-to-low', 'cmip7-high',
  ];

  it('separates the two generations', () => {
    const groups = groupScenarios(ALL);
    expect(groups.map((g) => g.family)).toEqual(['CMIP7 ScenarioMIP', 'CMIP6 SSPs']);
    expect(groups[0].names).toHaveLength(7);
    expect(groups[1].names).toHaveLength(8);
  });

  it('leads with CMIP7, which is the reason to reach for this tool', () => {
    expect(groupScenarios(ALL)[0].family).toBe('CMIP7 ScenarioMIP');
  });

  it('orders by severity rather than alphabetically', () => {
    // The bundle lists scenarios alphabetically, which would put High first.
    const cmip7 = groupScenarios(ALL)[0].names;
    expect(cmip7[0]).toBe('cmip7-very-low');
    expect(cmip7[cmip7.length - 1]).toBe('cmip7-high');
  });

  it('gives readable names', () => {
    expect(scenarioLabel('ssp534-over')).toBe('SSP5-3.4-OS');
    expect(scenarioLabel('cmip7-medium-to-low')).toBe('Medium to Low (SSP2)');
    expect(scenarioFamily('cmip7-high')).toBe('CMIP7 ScenarioMIP');
    expect(scenarioFamily('ssp245')).toBe('CMIP6 SSPs');
  });

  it('falls back for a scenario it has no label for', () => {
    expect(scenarioLabel('ssp999')).toBe('SSP999');
    expect(groupScenarios(['ssp999'])[0].names).toEqual(['ssp999']);
  });
});
