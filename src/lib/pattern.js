/**
 * The map tier: spatial patterns, and locations the bundle was never built for.
 *
 * A timeseries bundle carries the spatial patterns already projected onto a
 * fixed set of locations, which is what makes it 81 KB. The pattern-scaling
 * artifact carries the patterns themselves — 2 MB — and with them a client can
 * do two things the bundle cannot: draw the forced response as a map, and
 * evaluate it at any location the user cares to name.
 *
 * The plan long assumed this needed a server. It does not, and the arithmetic
 * is why: a forced-response map is three pattern modes over 55,296 gridpoints,
 * about 166k multiply-adds per experiment per timestep. What is genuinely
 * infeasible is every realization × every month × every gridpoint at once —
 * which METEOR's gridded path computes, and no map view ever asks for.
 *
 * This covers the *forced* response only. Internal variability on the grid
 * needs the EOF maps from the noise artifact, which is another 11 MB.
 */

import { Artifact } from './bundle.js';

export const PATTERN_FORMAT = 'meteor-pattern-scaling';

/** Earth's radius is irrelevant: area weights only ever appear as ratios. */
const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * A pattern-scaling artifact: the spatial side of the forced response.
 */
export class PatternArtifact extends Artifact {
  constructor(buffer) {
    super(buffer);
    if (this.format !== PATTERN_FORMAT) {
      throw new Error(`expected a ${PATTERN_FORMAT}, got '${this.format}'`);
    }

    this.experiments = this.strings('exp');
    this.nModes = this.dims.mode;
    this.nLat = this.dims.lat;
    this.nLon = this.dims.lon;
    this.nFields = this.dims.fld;

    this.lat = this.array('lat');
    this.lon = this.array('lon');

    this._cache = new Map();
  }

  get(name) {
    if (!this._cache.has(name)) this._cache.set(name, this.array(name));
    return this._cache.get(name);
  }

  /**
   * Area weights for every gridpoint, normalised to sum to one over a mask.
   *
   * cos(latitude), which is the usual approximation for a regular lat/lon grid
   * and is what METEOR's own reductions use.
   *
   * @param {(lat: number, lon: number) => boolean} [inside] mask predicate
   * @returns {Float64Array} length `nLat * nLon`, summing to 1
   */
  areaWeights(inside) {
    const weights = new Float64Array(this.nLat * this.nLon);
    let total = 0;
    for (let i = 0; i < this.nLat; i += 1) {
      const w = Math.cos(this.lat[i] * DEGREES_TO_RADIANS);
      for (let j = 0; j < this.nLon; j += 1) {
        if (inside && !inside(this.lat[i], this.lon[j])) continue;
        weights[i * this.nLon + j] = w;
        total += w;
      }
    }
    if (total === 0) throw new Error('region selects no gridpoints');
    for (let k = 0; k < weights.length; k += 1) weights[k] /= total;
    return weights;
  }

  /**
   * Project the spatial patterns onto a weight vector.
   *
   * This produces exactly the `pattern_projection` a bundle would carry for
   * that location — which is what lets an arbitrary region reuse the same
   * forced-response code the fixed locations use.
   *
   * NaN marks an absent experiment/field combination, so those are skipped
   * rather than allowed to poison the sum.
   *
   * @param {Float64Array} weights from {@link areaWeights}
   * @param {number} [field] index into the `fld` dimension
   * @returns {Float64Array} row-major `(exp, mode)`
   */
  project(weights, field = 0) {
    const patterns = this.get('pattern_v');
    const nExp = this.dims.exp;
    const space = this.nLat * this.nLon;
    const out = new Float64Array(nExp * this.nModes);

    for (let e = 0; e < nExp; e += 1) {
      for (let m = 0; m < this.nModes; m += 1) {
        const base = ((e * this.nFields + field) * this.nModes + m) * space;
        let acc = 0;
        for (let k = 0; k < space; k += 1) {
          const value = patterns[base + k];
          if (Number.isFinite(value)) acc += value * weights[k];
        }
        out[e * this.nModes + m] = acc;
      }
    }
    return out;
  }

  /**
   * The forced-response map at one time index.
   *
   * @param {Float64Array} pcs row-major `(exp, mode)` step-response PCs at
   *   this time — see {@link stepResponsePcs}
   * @param {number} [field]
   * @returns {Float64Array} row-major `(lat, lon)`
   */
  map(pcs, field = 0) {
    const patterns = this.get('pattern_v');
    const nExp = this.dims.exp;
    const space = this.nLat * this.nLon;
    const out = new Float64Array(space);

    for (let e = 0; e < nExp; e += 1) {
      for (let m = 0; m < this.nModes; m += 1) {
        const weight = pcs[e * this.nModes + m];
        if (weight === 0 || !Number.isFinite(weight)) continue;
        const base = ((e * this.nFields + field) * this.nModes + m) * space;
        for (let k = 0; k < space; k += 1) {
          const value = patterns[base + k];
          if (Number.isFinite(value)) out[k] += weight * value;
        }
      }
    }
    return out;
  }
}

/**
 * Step-response PCs per experiment, convolved with a scenario's forcing.
 *
 * The same convolution `forcedResponse` performs, stopped one step earlier: it
 * returns the PCs rather than projecting them, so the caller can either project
 * onto a location or reconstruct a map.
 *
 * Experiments with a zero step magnitude are skipped — that is `base`, and
 * dividing the forcing increments by it yields NaN.
 *
 * @param {object} kernel step-response arrays, from a bundle or artifact
 * @param {Float64Array} kernel.expForc `(exp,)`
 * @param {Float64Array} kernel.coeffs `(exp, mode)` row-major
 * @param {Float64Array} kernel.timescales `(exp, mode)` row-major
 * @param {string[]} kernel.experiments
 * @param {number} kernel.nModes
 * @param {Map<string, ArrayLike<number>>} forcingByExp
 * @returns {{pcs: Float64Array, nTimes: number}} `pcs` row-major `(time, exp, mode)`
 */
export function stepResponsePcs(
  { expForc, coeffs, timescales, experiments, nModes },
  forcingByExp
) {
  let nTimes = 0;
  for (const [exp, forcing] of forcingByExp) {
    if (experiments.includes(exp)) nTimes = Math.max(nTimes, forcing.length);
  }
  if (nTimes === 0) return { pcs: new Float64Array(0), nTimes: 0 };

  const nExp = experiments.length;
  const pcs = new Float64Array(nTimes * nExp * nModes);

  experiments.forEach((exp, e) => {
    const forcing = forcingByExp.get(exp);
    if (!forcing) return;
    const step = expForc[e];
    if (!Number.isFinite(step) || step === 0) return;

    const dF = new Float64Array(nTimes);
    for (let t = 0; t < forcing.length - 1; t += 1) {
      dF[t] = (forcing[t + 1] - forcing[t]) / step;
    }

    for (let m = 0; m < nModes; m += 1) {
      const coefficient = coeffs[e * nModes + m];
      const timescale = timescales[e * nModes + m];
      if (!Number.isFinite(coefficient) || !Number.isFinite(timescale)) continue;

      // The kernel for this mode, then a truncated convolution with dF.
      const kernel = new Float64Array(nTimes);
      for (let u = 0; u < nTimes; u += 1) {
        kernel[u] = coefficient * (1 - Math.exp(-u / timescale));
      }
      for (let t = 0; t < nTimes; t += 1) {
        let acc = 0;
        for (let u = 0; u <= t; u += 1) acc += kernel[u] * dF[t - u];
        pcs[(t * nExp + e) * nModes + m] = acc;
      }
    }
  });

  return { pcs, nTimes };
}

/**
 * The step-response kernel arrays out of a pattern artifact.
 *
 * `step_coeffs` and `step_timescales` are `(exp, fld, mode)` here, against the
 * bundle's `(exp, mode)`, so the field axis is dropped.
 */
export function patternKernel(artifact, field = 0) {
  const nExp = artifact.dims.exp;
  const nModes = artifact.nModes;
  const pick = (name) => {
    const flat = artifact.get(name);
    const out = new Float64Array(nExp * nModes);
    for (let e = 0; e < nExp; e += 1) {
      for (let m = 0; m < nModes; m += 1) {
        out[e * nModes + m] = flat[(e * artifact.nFields + field) * nModes + m];
      }
    }
    return out;
  };
  return {
    expForc: artifact.get('exp_forc'),
    coeffs: pick('step_coeffs'),
    timescales: pick('step_timescales'),
    experiments: artifact.experiments,
    nModes,
  };
}

/**
 * A rectangular lat/lon region predicate.
 *
 * Longitudes are normalised to the artifact's own convention (0–360 for
 * NorESM2-MM), so a user can say -74 and mean the same place as 286.
 *
 * @returns {(lat: number, lon: number) => boolean}
 */
export function boxRegion({ south, north, west, east }) {
  const wrap = (x) => ((x % 360) + 360) % 360;
  const w = wrap(west);
  const e = wrap(east);
  return (lat, lon) => {
    if (lat < south || lat > north) return false;
    const l = wrap(lon);
    // A box crossing the antimeridian has west > east after wrapping.
    return w <= e ? l >= w && l <= e : l >= w || l <= e;
  };
}
