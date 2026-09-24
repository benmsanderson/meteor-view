/**
 * URL state and export.
 *
 * A shared link is only useful if it reproduces the view exactly, so the
 * round-trip is the thing under test.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULTS, MAX_SCENARIOS, fromQuery, toQuery } from '../src/app/state.js';
import { filenameStem, toCsv } from '../src/app/export.js';
import {
  groupScenarios,
  scenarioFamily,
  scenarioLabel,
  selectedColour,
  sortScenarios,
} from '../src/app/scenarios.js';

const CONTEXT = {
  locations: ['global', 'regional:NEU', 'point:19.1,72.9'],
  scenarios: [
    'ssp126', 'ssp245', 'ssp370', 'ssp585', 'ssp119', 'ssp434', 'ssp460',
    'cmip7-low', 'cmip7-high',
  ],
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
      scenarios: ['ssp126', 'ssp370', 'ssp585'],
      compare: ['ssp585', 'ssp126'],
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

  it('reads a single-scenario link from before multi-selection', () => {
    const parsed = fromQuery('?scn=ssp370', CONTEXT);
    expect(parsed.scenarios).toEqual(['ssp370']);
    expect(parsed.compare).toBeNull();
  });

  it('compares the first two selected unless told otherwise', () => {
    expect(fromQuery('?scn=ssp126,ssp585', CONTEXT).compare).toEqual(['ssp126', 'ssp585']);
    // And the default pair is not written out.
    expect(
      toQuery({ ...DEFAULTS, scenarios: ['ssp126', 'ssp585'], compare: ['ssp126', 'ssp585'] })
    ).toBe('?scn=ssp126%2Cssp585');
  });

  it('rejects a comparison outside the selection, or of a scenario with itself', () => {
    const base = '?scn=ssp126,ssp245,ssp585';
    expect(fromQuery(`${base}&cmp=ssp126,ssp370`, CONTEXT).compare).toEqual(['ssp126', 'ssp245']);
    expect(fromQuery(`${base}&cmp=ssp585,ssp585`, CONTEXT).compare).toEqual(['ssp126', 'ssp245']);
    expect(fromQuery(`${base}&cmp=ssp585,ssp245`, CONTEXT).compare).toEqual(['ssp585', 'ssp245']);
  });

  it('drops unknown and repeated scenarios, and caps the selection', () => {
    expect(fromQuery('?scn=ssp126,ssp999,ssp126,ssp585', CONTEXT).scenarios).toEqual([
      'ssp126',
      'ssp585',
    ]);
    const many = CONTEXT.scenarios.join(',');
    expect(fromQuery(`?scn=${many}`, CONTEXT).scenarios).toHaveLength(MAX_SCENARIOS);
    // Nothing valid falls back to the default rather than showing nothing.
    expect(fromQuery('?scn=,ssp999', CONTEXT).scenarios).toEqual(DEFAULTS.scenarios);
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

  const series = [
    Float64Array.from({ length: 24 }, (_, i) => i / 3),
    Float64Array.from({ length: 24 }, (_, i) => -i / 7),
  ];
  const csv = toCsv({
    years: [2015, 2016],
    runs: [
      { scenario: 'ssp245', series },
      { scenario: 'cmip7-high', series: series.map((s) => s.map((v) => v + 1)) },
    ],
    bundle,
    variable: 'tas',
    location: 'global',
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

  it('has one row per scenario and month, one column per realization', () => {
    expect(dataLines[0]).toBe('scenario,year,month,realization_01,realization_02');
    expect(dataLines.length).toBe(1 + 2 * 24);
    expect(dataLines[1].startsWith('ssp245,2015,1,')).toBe(true);
    expect(dataLines[12].startsWith('ssp245,2015,12,')).toBe(true);
    expect(dataLines[13].startsWith('ssp245,2016,1,')).toBe(true);
    expect(dataLines[25].startsWith('cmip7-high,2015,1,')).toBe(true);
  });

  it('lists every scenario in the provenance', () => {
    expect(csv).toContain('# scenarios: ssp245, cmip7-high');
  });

  it('round-trips values without visible loss', () => {
    const third = Number(dataLines[2].split(',')[3]);
    expect(third).toBeCloseTo(1 / 3, 6);
  });
});

describe('scenario selection', () => {
  it('orders a selection as the menu does, whatever order it was ticked in', () => {
    expect(sortScenarios(['ssp585', 'cmip7-high', 'ssp126', 'cmip7-low'])).toEqual([
      'cmip7-low',
      'cmip7-high',
      'ssp126',
      'ssp585',
    ]);
  });

  it('gives every scenario a colour of its own when selected', () => {
    const all = [
      'ssp119', 'ssp126', 'ssp245', 'ssp370', 'ssp434', 'ssp460', 'ssp534-over', 'ssp585',
      'cmip7-very-low', 'cmip7-low', 'cmip7-low-to-negative', 'cmip7-medium-to-low',
      'cmip7-medium', 'cmip7-high-to-low', 'cmip7-high',
    ];
    const colours = all.map((name) => selectedColour(name, 'grey'));
    expect(colours).not.toContain('grey');
    expect(new Set(colours).size).toBe(all.length);
  });
});

describe('filenames', () => {
  it('joins several scenarios', () => {
    expect(
      filenameStem({
        cmip6Model: 'CanESM5',
        variable: 'tas',
        location: 'global',
        scenario: ['ssp126', 'ssp585'],
      })
    ).toBe('meteor_CanESM5_tas_global_ssp126+ssp585');
  });

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
