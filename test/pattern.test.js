/**
 * The map tier, against METEOR's own gridded prediction.
 *
 * The bundle tier is validated by golden fixtures, which are per-location and
 * so exercise none of the arithmetic that reconstructs a field. This holds the
 * gridded reconstruction and arbitrary-region projection to the same standard:
 * `MeteorPatternScaling.predict_from_combined_experiment`, dumped by
 * `scripts/make_pattern_reference.py`.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { Bundle } from '../src/lib/bundle.js';
import {
  PatternArtifact,
  boxRegion,
  patternKernel,
  stepResponsePcs,
} from '../src/lib/pattern.js';
import { forcedResponse } from '../src/lib/kernel.js';

const DATA = new URL('../data/', import.meta.url);
const reference = JSON.parse(
  readFileSync(new URL('./fixtures/pattern_reference.json', import.meta.url))
);

const artifact = new PatternArtifact(
  readFileSync(new URL('meteor_NorESM2-MM_tas_pattern_v1.nc', DATA))
);
const bundle = new Bundle(readFileSync(new URL('meteor_NorESM2-MM_tas_bundle_v1.nc', DATA)));

/** Forced-response maps for the reference years. */
function mapsForScenario() {
  const kernel = patternKernel(artifact);
  const { pcs, nTimes } = stepResponsePcs(kernel, bundle.forcing(reference.scenario));
  const nExp = artifact.dims.exp;
  const nModes = artifact.nModes;

  const out = {};
  for (const year of reference.years) {
    const t = year - reference.base_year;
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThan(nTimes);
    out[year] = artifact.map(pcs.subarray(t * nExp * nModes, (t + 1) * nExp * nModes));
  }
  return out;
}

/** Largest difference, scaled by the reference field's own magnitude. */
function maxRelative(actual, expected) {
  let scale = 0;
  for (const v of expected) scale = Math.max(scale, Math.abs(v));
  let worst = 0;
  for (let i = 0; i < expected.length; i += 1) {
    worst = Math.max(worst, Math.abs(actual[i] - expected[i]) / (scale || 1));
  }
  return worst;
}

describe('pattern artifact', () => {
  it('is classic netCDF the existing reader can parse', () => {
    expect(artifact.format).toBe('meteor-pattern-scaling');
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.nLat).toBe(reference.n_lat);
    expect(artifact.nLon).toBe(reference.n_lon);
  });

  it('shares the bundle experiments and step-response kernel', () => {
    expect(artifact.experiments).toEqual(bundle.experiments);
    const kernel = patternKernel(artifact);
    // The bundle carries the same kernel already reduced over the field axis.
    const bundleCoeffs = bundle.get('step_coeffs');
    for (let i = 0; i < bundleCoeffs.length; i += 1) {
      expect(kernel.coeffs[i]).toBeCloseTo(bundleCoeffs[i], 5);
    }
  });
});

describe('gridded forced response', () => {
  const maps = mapsForScenario();

  it.each(reference.years)('reproduces the METEOR map for %i', (year) => {
    const expected = reference.maps[String(year)];
    const actual = maps[year];
    expect(actual.length).toBe(expected.length);

    // float32 storage on our side against float64 in the reference, so wire
    // precision is the bar — the same one the timeseries tier is held to.
    expect(maxRelative(actual, expected), `map ${year}`).toBeLessThan(2e-6);
  });

  it.each(reference.years)('reproduces the global mean for %i', (year) => {
    const weights = artifact.areaWeights();
    const field = maps[year];
    let mean = 0;
    for (let k = 0; k < field.length; k += 1) mean += field[k] * weights[k];

    // cos-latitude weighting is an approximation of METEOR's own reduction,
    // so this is a physical agreement rather than an arithmetic identity.
    expect(Math.abs(mean - reference.global[String(year)])).toBeLessThan(0.02);
  });
});

describe('arbitrary regions', () => {
  it('reproduces a bundled location through the pattern artifact', () => {
    // The decisive check: projecting the patterns onto a location's weights
    // must give the same forced response the bundle's precomputed projection
    // does. If that holds, an arbitrary region is the same code with different
    // weights, and needs no further validation of its own.
    const forcing = bundle.forcing(reference.scenario);
    const fromBundle = forcedResponse(bundle, 'global', forcing);

    const kernel = patternKernel(artifact);
    const { pcs, nTimes } = stepResponsePcs(kernel, forcing);
    const projection = artifact.project(artifact.areaWeights());
    const nExp = artifact.dims.exp;
    const nModes = artifact.nModes;

    const fromPattern = new Float64Array(nTimes);
    for (let t = 0; t < nTimes; t += 1) {
      let acc = 0;
      for (let e = 0; e < nExp; e += 1) {
        for (let m = 0; m < nModes; m += 1) {
          acc += pcs[(t * nExp + e) * nModes + m] * projection[e * nModes + m];
        }
      }
      fromPattern[t] = acc;
    }

    // Both reduce the same patterns with the same kernel; they differ only in
    // whether the reduction happened at export time or here.
    expect(maxRelative(fromPattern, fromBundle)).toBeLessThan(5e-3);
  });

  it('selects a box region, wrapping longitudes', () => {
    const europe = boxRegion({ south: 48, north: 72, west: -10, east: 40 });
    expect(europe(60, 5)).toBe(true);
    expect(europe(60, 355)).toBe(true); // -5 expressed as 355
    expect(europe(20, 5)).toBe(false);
    expect(europe(60, 120)).toBe(false);

    // A box across the antimeridian: west > east once wrapped.
    const pacific = boxRegion({ south: -10, north: 10, west: 170, east: -170 });
    expect(pacific(0, 175)).toBe(true);
    expect(pacific(0, 185)).toBe(true);
    expect(pacific(0, 0)).toBe(false);
  });

  it('weights a region to sum to one, and refuses an empty one', () => {
    const weights = artifact.areaWeights(boxRegion({ south: 48, north: 72, west: -10, east: 40 }));
    let total = 0;
    let nonZero = 0;
    for (const w of weights) {
      total += w;
      if (w > 0) nonZero += 1;
    }
    expect(total).toBeCloseTo(1, 12);
    expect(nonZero).toBeGreaterThan(100);

    expect(() => artifact.areaWeights(() => false)).toThrow(/no gridpoints/);
  });

  it('warms the Arctic faster than the globe, as the physics requires', () => {
    // A sanity check with physics in it: the Arctic warms faster than the
    // global mean, so its forced response should exceed it.
    const forcing = bundle.forcing(reference.scenario);
    const kernel = patternKernel(artifact);
    const { pcs, nTimes } = stepResponsePcs(kernel, forcing);
    const nExp = artifact.dims.exp;
    const nModes = artifact.nModes;
    const last = (nTimes - 1) * nExp * nModes;
    const slice = pcs.subarray(last, last + nExp * nModes);

    const field = artifact.map(slice);
    const reduce = (mask) => {
      const w = artifact.areaWeights(mask);
      let acc = 0;
      for (let k = 0; k < field.length; k += 1) acc += field[k] * w[k];
      return acc;
    };

    const globe = reduce();
    const arctic = reduce(boxRegion({ south: 70, north: 90, west: 0, east: 360 }));
    expect(arctic).toBeGreaterThan(globe);
  });
});

describe('a drawn region against a bundled one', () => {
  /** Forced response over an arbitrary mask, the way the app computes it. */
  function forcedOverMask(mask) {
    const artifact2 = artifact;
    const kernel = patternKernel(artifact2);
    const { pcs, nTimes } = stepResponsePcs(kernel, bundle.forcing('ssp245'));
    const projection = artifact2.project(artifact2.areaWeights(mask));
    const nExp = artifact2.dims.exp;
    const nModes = artifact2.nModes;

    const out = new Float64Array(nTimes);
    for (let t = 0; t < nTimes; t += 1) {
      let acc = 0;
      for (let e = 0; e < nExp; e += 1) {
        for (let m = 0; m < nModes; m += 1) {
          acc += pcs[(t * nExp + e) * nModes + m] * projection[e * nModes + m];
        }
      }
      out[t] = acc;
    }
    return out;
  }

  it('gives a similar answer for a box drawn over the Sahara', () => {
    // A hand-drawn box is not the AR6 polygon, so these cannot agree exactly.
    // What matters is that a user drawing roughly the right rectangle gets
    // roughly the right number — if the projection were wrong, this would be
    // out by a factor rather than a few percent.
    const box = forcedOverMask(boxRegion({ south: 15, north: 30, west: -10, east: 30 }));
    const bundled = forcedResponse(bundle, 'regional:SAH', bundle.forcing('ssp245'));

    const last = box.length - 1;
    const ratio = box[last] / bundled[last];
    expect(ratio, `box/SAH = ${ratio.toFixed(3)}`).toBeGreaterThan(0.9);
    expect(ratio, `box/SAH = ${ratio.toFixed(3)}`).toBeLessThan(1.1);
  });

  it('warms a subtropical land box more than the globe', () => {
    const sahara = forcedOverMask(boxRegion({ south: 15, north: 30, west: -10, east: 30 }));
    const globe = forcedOverMask();
    const last = sahara.length - 1;
    expect(sahara[last]).toBeGreaterThan(globe[last]);
  });
});
