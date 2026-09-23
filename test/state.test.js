/**
 * URL state and export.
 *
 * A shared link is only useful if it reproduces the view exactly, so the
 * round-trip is the thing under test — including the drawn pathway, which is
 * the one piece of state too large to put in the URL verbatim.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULTS,
  decodePathway,
  encodePathway,
  fromQuery,
  toQuery,
} from '../src/app/state.js';
import { filenameStem, toCsv } from '../src/app/export.js';

const CONTEXT = {
  locations: ['global', 'regional:NEU', 'point:19.1,72.9'],
  scenarios: ['ssp126', 'ssp245', 'ssp585'],
  pathwayLength: 86,
};

describe('URL state', () => {
  it('omits defaults, so a plain view has a clean URL', () => {
    expect(toQuery({ ...DEFAULTS })).toBe('');
  });

  it('round-trips a full state', () => {
    const state = {
      variable: 'pr',
      location: 'regional:NEU',
      scenario: 'ssp585',
      nRealizations: 50,
      seed: 12345,
      pathway: null,
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
    const parsed = fromQuery('?v=nonsense&loc=regional:NOWHERE&scn=ssp999&n=abc', CONTEXT);
    expect(parsed).toEqual(DEFAULTS);
  });

  it('caps the realization count a link can demand', () => {
    // Otherwise a link is a denial-of-service on whoever opens it.
    expect(fromQuery('?n=1000000', CONTEXT).nRealizations).toBe(DEFAULTS.nRealizations);
    expect(fromQuery('?n=0', CONTEXT).nRealizations).toBe(DEFAULTS.nRealizations);
    expect(fromQuery('?n=200', CONTEXT).nRealizations).toBe(200);
  });
});

describe('pathway encoding', () => {
  const pathway = Float64Array.from({ length: 86 }, (_, i) => 0.8 + i * 0.03);

  it('round-trips to a hundredth of a degree', () => {
    const decoded = decodePathway(encodePathway(pathway), 86);
    expect(decoded).not.toBeNull();
    for (let i = 0; i < pathway.length; i += 1) {
      expect(Math.abs(decoded[i] - pathway[i])).toBeLessThanOrEqual(0.005);
    }
  });

  it('stays short enough to paste', () => {
    // 86 years as decimal text would run to ~500 characters.
    expect(encodePathway(pathway).length).toBeLessThan(250);
  });

  it('is URL-safe', () => {
    const negative = Float64Array.from({ length: 86 }, (_, i) => -2 + i * 0.5);
    expect(encodePathway(negative)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('survives a full state round-trip', () => {
    const state = { ...DEFAULTS, pathway };
    const parsed = fromQuery(toQuery(state), CONTEXT);
    expect(parsed.pathway).not.toBeNull();
    expect(parsed.pathway.length).toBe(86);
  });

  it('rejects a corrupted or truncated pathway rather than throwing', () => {
    expect(decodePathway('not base64 at all!!', 86)).toBeNull();
    expect(decodePathway(encodePathway(pathway), 12)).toBeNull();
    expect(fromQuery('?path=%%%', CONTEXT).pathway).toBeNull();
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
