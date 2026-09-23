/**
 * The parts the golden fixtures cannot reach.
 *
 * A fixture ships METEOR's PC sequence as data, so it validates everything
 * downstream of the VAR simulation but nothing inside it. The draw itself can
 * only be checked distributionally, and against the bundle's own arrays.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { Bundle, GoldenFixture } from '../src/lib/bundle.js';
import { designMatrix, generateEnsemble, simulateVar } from '../src/lib/kernel.js';
import { normalGenerator } from '../src/lib/stats.js';

const DATA = new URL('../data/', import.meta.url);
const tas = new Bundle(readFileSync(new URL('meteor_NorESM2-MM_tas_bundle_v1.nc', DATA)));
const fixture = new GoldenFixture(
  readFileSync(new URL('meteor_NorESM2-MM_tas_golden_ssp245_v1.nc', DATA))
);

describe('bundle', () => {
  it('reads the classic netCDF-3 bundle', () => {
    expect(tas.variable).toBe('tas');
    expect(tas.nModes).toBe(40);
    expect(tas.lagOrder).toBe(2);
    expect(tas.locations.length).toBe(67);
    expect(tas.scenarios.length).toBe(8);
  });

  it('covers global, the AR6 regions and points', () => {
    expect(tas.locations[0]).toBe('global');
    expect(tas.locations.filter((l) => l.startsWith('regional:')).length).toBe(58);
    expect(tas.locations.filter((l) => l.startsWith('point:')).length).toBe(8);
  });

  it('rejects an artifact from a newer schema', () => {
    // Patching the attribute in place is the cheapest way to prove the guard
    // fires; a real v2 file could reinterpret variables this reader knows.
    const raw = readFileSync(new URL('meteor_NorESM2-MM_tas_bundle_v1.nc', DATA));
    const patched = Uint8Array.from(raw);
    const at = raw.indexOf(Buffer.from('schema_version'));
    expect(at).toBeGreaterThan(0);

    // A netCDF-3 attribute is name (padded to four bytes) then nc_type, then
    // nelems, then the value: here a big-endian int one, whose low byte sits
    // 27 bytes past the start of the name.
    expect(raw[at + 27]).toBe(1);
    patched[at + 27] = 9;

    expect(() => new Bundle(patched)).toThrow(/newer than this reader/);
  });

  it('rejects an unknown location', () => {
    expect(() => tas.locationIndex('regional:NOWHERE')).toThrow(/not in this bundle/);
  });

  it('rejects an unbundled scenario', () => {
    expect(() => tas.forcing('ssp999')).toThrow(/not in this bundle/);
  });
});

describe('VAR simulation', () => {
  it('has a Cholesky factor consistent with the innovation covariance', () => {
    const n = tas.nModes;
    const chol = tas.get('varx_residual_chol');
    const cov = tas.get('varx_residual_cov');

    // L @ L.T == cov, which is what lets a client draw innovations without
    // factoring the covariance itself.
    let scale = 0;
    for (const v of cov) scale = Math.max(scale, Math.abs(v));

    let worst = 0;
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        let acc = 0;
        for (let k = 0; k <= Math.min(i, j); k += 1) acc += chol[i * n + k] * chol[j * n + k];
        worst = Math.max(worst, Math.abs(acc - cov[i * n + j]) / scale);
      }
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('is upper-triangular-free: the factor is lower triangular', () => {
    const n = tas.nModes;
    const chol = tas.get('varx_residual_chol');
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) expect(chol[i * n + j]).toBe(0);
    }
  });

  it('holds PCs at zero for the first lagOrder steps', () => {
    const pcs = simulateVar({
      nTimes: 24,
      intercept: tas.get('varx_intercept'),
      A: tas.get('varx_A'),
      chol: tas.get('varx_residual_chol'),
      nModes: tas.nModes,
      lagOrder: tas.lagOrder,
      normal: normalGenerator(1),
    });
    for (let t = 0; t < tas.lagOrder; t += 1) {
      for (let k = 0; k < tas.nModes; k += 1) expect(pcs[t * tas.nModes + k]).toBe(0);
    }
    expect(pcs.slice(tas.lagOrder * tas.nModes).some((v) => v !== 0)).toBe(true);
  });

  it('matches METEOR in distribution, if not realisation by realisation', () => {
    // A port cannot reproduce NumPy's PCG64 stream, so the PCs differ draw by
    // draw. What must agree is their spread: the leading modes carry most of
    // the variance and are the ones the EOF projection weights most heavily.
    const nTimes = fixture.nMonths;
    const pcs = simulateVar({
      nTimes,
      intercept: tas.get('varx_intercept'),
      A: tas.get('varx_A'),
      chol: tas.get('varx_residual_chol'),
      nModes: tas.nModes,
      lagOrder: tas.lagOrder,
      normal: normalGenerator(2024),
    });

    const std = (values) => {
      const mean = values.reduce((s, v) => s + v, 0) / values.length;
      return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
    };

    const reference = fixture.pcs(0);
    for (let mode = 0; mode < 5; mode += 1) {
      const mine = [];
      const theirs = [];
      for (let t = tas.lagOrder; t < nTimes; t += 1) {
        mine.push(pcs[t * tas.nModes + mode]);
        theirs.push(reference[t * tas.nModes + mode]);
      }
      const ratio = std(mine) / std(theirs);
      // Two finite samples of 478 months from the same process; a factor of
      // two either way would indicate a wrong covariance, not sampling noise.
      expect(ratio, `mode ${mode}`).toBeGreaterThan(0.5);
      expect(ratio, `mode ${mode}`).toBeLessThan(2);
    }
  });
});

describe('generateEnsemble', () => {
  const tGlob = Float64Array.from({ length: 120 }, (_, t) => t / 120);

  it('returns one series per realization', () => {
    const series = generateEnsemble({
      bundle: tas,
      location: 'global',
      tGlob,
      forcedMonthly: null,
      nRealizations: 3,
      normal: normalGenerator(5),
    });
    expect(series.length).toBe(3);
    expect(series[0].length).toBe(120);
    expect(series.every((s) => s.every(Number.isFinite))).toBe(true);
  });

  it('is reproducible for a given seed', () => {
    const run = (seed) =>
      generateEnsemble({
        bundle: tas,
        location: 'regional:NEU',
        tGlob,
        forcedMonthly: null,
        nRealizations: 2,
        normal: normalGenerator(seed),
      });
    expect([...run(11)[0]]).toEqual([...run(11)[0]]);
    expect([...run(11)[0]]).not.toEqual([...run(12)[0]]);
  });

  it('adds the forced response when one is supplied', () => {
    const forcedMonthly = new Float64Array(120).fill(5);
    const without = generateEnsemble({
      bundle: tas,
      location: 'global',
      tGlob,
      forcedMonthly: null,
      nRealizations: 1,
      normal: normalGenerator(9),
    });
    const with_ = generateEnsemble({
      bundle: tas,
      location: 'global',
      tGlob,
      forcedMonthly,
      nRealizations: 1,
      normal: normalGenerator(9),
    });
    for (let t = 0; t < 120; t += 1) {
      expect(with_[0][t] - without[0][t]).toBeCloseTo(5, 10);
    }
  });
});

describe('designMatrix', () => {
  it('lays out the nine features in schema order', () => {
    const design = designMatrix([2, 2]);
    // t=0: t_glob, cos(0)=1, sin(0)=0, cos(0)=1, sin(0)=0, then t_glob times each.
    expect([...design.slice(0, 9)]).toEqual([2, 1, 0, 1, 0, 2, 0, 2, 0]);
  });

  it('completes an annual cycle every twelve months', () => {
    const design = designMatrix(new Float64Array(13));
    // The annual harmonic at month 12 is back where it was at month 0.
    expect(design[12 * 9 + 1]).toBeCloseTo(design[1], 12);
    expect(design[12 * 9 + 2]).toBeCloseTo(design[2], 12);
  });
});
