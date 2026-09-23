/**
 * METEOR's generation kernel, ported to JavaScript.
 *
 * A port of the reference implementations in `meteor.timeseries_bundle`,
 * validated against the golden fixtures in `test/golden.test.js`. The order of
 * operations matters and is documented in `docs/emulator_artifact_schema.md`:
 *
 *   1. forced response    convolve the step-response kernel with scenario
 *                         forcing, project onto the location
 *   2. warming pathway    (optional) rescale the anomaly to a prescribed
 *                         trajectory
 *   3. annual -> monthly  repeat each annual value twelve times
 *   4. stochastic part    VAR(2) innovations -> PCs; seasonal harmonics and
 *                         EOF projection
 *   5. baseline           `pr` only: add the transform baseline
 *   6. transform          `pr` only: Gaussian CDF -> gamma quantile table
 *
 * Steps 5 and 6 are not optional for `pr` and not applicable to `tas`.
 * Precipitation is generated as an anomaly of order 1e-6 kg m-2 s-1 against
 * absolute values of order 1e-5, so skipping them gives an answer in the wrong
 * units rather than a slightly different one.
 */

import { normalCdf, interp } from './stats.js';

/** Months per year, throughout. */
const MONTHS = 12;

/**
 * The nine-column harmonic design matrix, row-major `(n, 9)`.
 *
 * Column order is the schema's `feature` coordinate: `t_glob`, annual cos/sin,
 * semiannual cos/sin, then `t_glob` times each of those four.
 *
 * @param {ArrayLike<number>} tGlob global-mean warming, one value per month
 * @returns {Float64Array} row-major `(tGlob.length, 9)`
 */
export function designMatrix(tGlob) {
  const n = tGlob.length;
  const out = new Float64Array(n * 9);
  for (let t = 0; t < n; t += 1) {
    const g = tGlob[t];
    const a = (2 * Math.PI * t) / MONTHS;
    const c1 = Math.cos(a);
    const s1 = Math.sin(a);
    const c2 = Math.cos(2 * a);
    const s2 = Math.sin(2 * a);
    const o = t * 9;
    out[o] = g;
    out[o + 1] = c1;
    out[o + 2] = s1;
    out[o + 3] = c2;
    out[o + 4] = s2;
    out[o + 5] = g * c1;
    out[o + 6] = g * s1;
    out[o + 7] = g * c2;
    out[o + 8] = g * s2;
  }
  return out;
}

/**
 * The deterministic seasonal cycle at one location.
 *
 * @param {Float64Array} design row-major `(n, 9)` from {@link designMatrix}
 * @param {ArrayLike<number>} coef nine seasonal coefficients
 * @param {number} intercept
 * @returns {Float64Array} length `n`
 */
export function seasonalCycle(design, coef, intercept) {
  const n = design.length / 9;
  const out = new Float64Array(n);
  for (let t = 0; t < n; t += 1) {
    let acc = intercept;
    const o = t * 9;
    for (let k = 0; k < 9; k += 1) acc += design[o + k] * coef[k];
    out[t] = acc;
  }
  return out;
}

/**
 * Project stochastic PCs onto a location's EOF basis.
 *
 * @param {Float64Array} pcs row-major `(n, nModes)`
 * @param {ArrayLike<number>} projection length `nModes`
 * @returns {Float64Array} length `n`
 */
export function projectPcs(pcs, projection) {
  const nModes = projection.length;
  const n = pcs.length / nModes;
  const out = new Float64Array(n);
  for (let t = 0; t < n; t += 1) {
    let acc = 0;
    const o = t * nModes;
    for (let k = 0; k < nModes; k += 1) acc += pcs[o + k] * projection[k];
    out[t] = acc;
  }
  return out;
}

/**
 * Simulate the VAR(lag) noise process.
 *
 * Innovations are drawn as `chol @ z` with `z` independent standard normals;
 * the bundle ships the lower-triangular Cholesky factor so a client need not
 * factor the covariance itself. PCs are zero for `t < lagOrder`.
 *
 * A port cannot reproduce NumPy's PCG64 stream, so an ensemble generated here
 * differs realisation by realisation from METEOR's while matching in
 * distribution. That is why the fixtures ship the PC sequence as data.
 *
 * @param {object} options
 * @param {number} options.nTimes months to simulate
 * @param {ArrayLike<number>} options.intercept `(nModes,)`
 * @param {ArrayLike<number>} options.A `(lag, nModes, nModes)` row-major
 * @param {ArrayLike<number>} options.chol `(nModes, nModes)` lower-triangular
 * @param {number} options.nModes
 * @param {number} options.lagOrder
 * @param {() => number} options.normal standard-normal generator
 * @returns {Float64Array} row-major `(nTimes, nModes)`
 */
export function simulateVar({
  nTimes,
  intercept,
  A,
  chol,
  nModes,
  lagOrder,
  normal,
}) {
  const pcs = new Float64Array(nTimes * nModes);
  const z = new Float64Array(nModes);

  for (let t = lagOrder; t < nTimes; t += 1) {
    for (let k = 0; k < nModes; k += 1) z[k] = normal();
    const row = t * nModes;
    for (let i = 0; i < nModes; i += 1) {
      let acc = intercept[i];
      for (let l = 0; l < lagOrder; l += 1) {
        const prev = (t - l - 1) * nModes;
        const lagBase = (l * nModes + i) * nModes;
        for (let j = 0; j < nModes; j += 1) {
          acc += A[lagBase + j] * pcs[prev + j];
        }
      }
      // Lower-triangular: only columns up to i contribute.
      let eps = 0;
      const cBase = i * nModes;
      for (let j = 0; j <= i; j += 1) eps += chol[cBase + j] * z[j];
      pcs[row + i] = acc + eps;
    }
  }
  return pcs;
}

/**
 * The step-response kernel for one experiment: `s_i * (1 - exp(-t / tau_i))`.
 *
 * @returns {Float64Array} row-major `(nTimes, nPatternModes)`
 */
function stepResponse(coeffs, timescales, nTimes) {
  const nModes = coeffs.length;
  const out = new Float64Array(nTimes * nModes);
  for (let t = 0; t < nTimes; t += 1) {
    for (let k = 0; k < nModes; k += 1) {
      out[t * nModes + k] = coeffs[k] * (1 - Math.exp(-t / timescales[k]));
    }
  }
  return out;
}

/**
 * The annual forced response at one location, summed over experiments.
 *
 * Port of `forced_response_from_bundle`. For each experiment the forcing
 * increments are divided by that experiment's step magnitude and convolved
 * with the step-response kernel, then projected onto the location.
 *
 * Experiments whose `exp_forc` is zero are skipped. That is the `base`
 * experiment: dividing by a zero step magnitude yields NaN and poisons the
 * whole sum, and METEOR's own code skips it explicitly.
 *
 * @param {import('./bundle.js').Bundle} bundle
 * @param {string} location location specifier
 * @param {Map<string, ArrayLike<number>>} forcingByExp from `bundle.forcing()`
 * @returns {Float64Array} annual, starting at the bundle's `forcing_year_start`
 */
export function forcedResponse(bundle, location, forcingByExp) {
  const nPatternModes = bundle.dims.pattern_mode;
  const locIdx = bundle.locationIndex(location);
  const expForc = bundle.get('exp_forc');
  const coeffs = bundle.get('step_coeffs');
  const timescales = bundle.get('step_timescales');
  const projections = bundle.get('pattern_projection');
  const nExp = bundle.dims.exp;

  let total = null;
  bundle.experiments.forEach((exp, j) => {
    const forcing = forcingByExp.get(exp);
    if (!forcing) return;

    const step = expForc[j];
    if (!Number.isFinite(step) || step === 0) return;

    const c = coeffs.subarray(j * nPatternModes, (j + 1) * nPatternModes);
    const ts = timescales.subarray(j * nPatternModes, (j + 1) * nPatternModes);
    if (!c.every(Number.isFinite) || !ts.every(Number.isFinite)) return;

    const nTimes = forcing.length;
    if (total === null) total = new Float64Array(nTimes);

    // Forcing increments: diff(forcing) with a zero appended, over the step.
    const dF = new Float64Array(nTimes);
    for (let t = 0; t < nTimes - 1; t += 1) {
      dF[t] = (forcing[t + 1] - forcing[t]) / step;
    }

    const kernel = stepResponse(c, ts, nTimes);
    const projBase = (locIdx * nExp + j) * nPatternModes;

    // Convolve per mode and project in one pass: the full convolution is
    // truncated to nTimes anyway, so only terms with u <= t are needed.
    for (let t = 0; t < nTimes; t += 1) {
      let acc = 0;
      for (let k = 0; k < nPatternModes; k += 1) {
        let conv = 0;
        for (let u = 0; u <= t; u += 1) conv += kernel[u * nPatternModes + k] * dF[t - u];
        acc += conv * projections[projBase + k];
      }
      total[t] += acc;
    }
  });

  return total === null ? new Float64Array(0) : total;
}

/**
 * Rescale a forced response to follow a prescribed global-warming pathway.
 *
 * Port of `scale_to_warming_pathway`. The anomaly about the first year is
 * scaled by the ratio of desired to predicted warming, with a scaling of 1
 * wherever the denominator is zero.
 *
 * `globalTas` must always be the **temperature** response at `global`, even
 * when rescaling precipitation — METEOR takes the denominator from the `tas`
 * pattern model regardless of the variable. Passing the precipitation response
 * gives numbers that look plausible and are wrong, which is why this argument
 * is required rather than derived from the bundle in hand.
 *
 * @param {ArrayLike<number>} forced annual forced response at the location
 * @param {ArrayLike<number>} globalTas annual global `tas` response, same years
 * @param {ArrayLike<number>} pathway desired global warming, same years
 * @returns {Float64Array}
 */
export function scaleToWarmingPathway(forced, globalTas, pathway) {
  if (forced.length !== globalTas.length || forced.length !== pathway.length) {
    throw new Error(
      `forced (${forced.length}), globalTas (${globalTas.length}) and pathway ` +
        `(${pathway.length}) must share a year axis`
    );
  }
  const out = new Float64Array(forced.length);
  for (let t = 0; t < forced.length; t += 1) {
    const denominator = globalTas[t] - globalTas[0];
    const scaling = denominator !== 0 ? (pathway[t] - pathway[0]) / denominator : 1;
    out[t] = forced[0] + (forced[t] - forced[0]) * scaling;
  }
  return out;
}

/**
 * Expand an annual series to monthly by repeating each value twelve times.
 *
 * The forced response is annual; the seasonal and stochastic terms are monthly
 * throughout. The bundle's `annual_to_monthly` attribute records this rule.
 */
export function annualToMonthly(annual, nMonths = annual.length * MONTHS) {
  const out = new Float64Array(nMonths);
  for (let t = 0; t < nMonths; t += 1) out[t] = annual[Math.floor(t / MONTHS)];
  return out;
}

/**
 * Quantile-map a generated Gaussian ensemble onto the fitted gamma.
 *
 * Port of `apply_transform_from_bundle`. For each month of the year the
 * Gaussian parameters are fitted across the whole block — every realization and
 * every year of that calendar month — because they describe the ensemble just
 * generated and so cannot be precomputed. The gamma side is the shipped table:
 * with `loc = 0` the gamma factorises as `ppf(p; a, scale) = scale * ppf(p; a, 1)`,
 * so one table indexed by shape serves every location and window.
 *
 * Needs only a normal CDF and linear interpolation — no gamma fit, no `ppf`.
 *
 * @param {import('./bundle.js').Bundle} bundle
 * @param {string} location
 * @param {Float64Array[]} realizations monthly values, January first
 * @returns {Float64Array[]} transformed, same shape
 */
export function applyTransform(bundle, location, realizations) {
  if (!bundle.hasTransform) {
    throw new Error('bundle carries no distribution transform');
  }
  const idx = bundle.locationIndex(location);
  const shapes = bundle.get('transform_shape').subarray(idx * MONTHS, (idx + 1) * MONTHS);
  const scales = bundle.get('transform_scale').subarray(idx * MONTHS, (idx + 1) * MONTHS);
  const shapeGrid = bundle.get('gamma_shape');
  const probGrid = bundle.get('gamma_probability');
  const table = bundle.get('gamma_quantile_norm');
  const nProb = bundle.dims.gamma_probability;
  const nShape = bundle.dims.gamma_shape;

  const logShapeGrid = Float64Array.from(shapeGrid, Math.log);
  const gridIndex = Float64Array.from({ length: nShape }, (_, i) => i);

  const nTimes = realizations[0].length;
  const out = realizations.map(() => new Float64Array(nTimes));

  for (let month = 0; month < MONTHS; month += 1) {
    const columns = [];
    for (let t = month; t < nTimes; t += MONTHS) columns.push(t);
    if (columns.length === 0) continue;

    // Mean and standard deviation over the whole block: all realizations and
    // all years of this calendar month. numpy's std is the population one.
    let sum = 0;
    let count = 0;
    for (const r of realizations) {
      for (const t of columns) {
        sum += r[t];
        count += 1;
      }
    }
    const mean = sum / count;
    let sq = 0;
    for (const r of realizations) {
      for (const t of columns) sq += (r[t] - mean) ** 2;
    }
    const std = Math.sqrt(sq / count);

    // Bilinear in (log shape, probability): interpolate the two bracketing
    // shape rows of the table, then along probability within that curve.
    const shape = shapes[month];
    const scale = scales[month];
    const position = interp(Math.log(shape), logShapeGrid, gridIndex);
    const low = Math.min(Math.max(Math.floor(position), 0), nShape - 2);
    const weight = position - low;
    const curve = new Float64Array(nProb);
    for (let p = 0; p < nProb; p += 1) {
      curve[p] =
        (1 - weight) * table[low * nProb + p] + weight * table[(low + 1) * nProb + p];
    }

    for (let r = 0; r < realizations.length; r += 1) {
      for (const t of columns) {
        const probability = std > 0 ? normalCdf((realizations[r][t] - mean) / std) : 0.5;
        out[r][t] = shape * scale * interp(probability, probGrid, curve);
      }
    }
  }
  return out;
}

/**
 * Generate an ensemble of monthly timeseries at one location.
 *
 * Runs the full recipe in order, including the two `pr`-only steps when the
 * bundle carries a transform.
 *
 * @param {object} options
 * @param {import('./bundle.js').Bundle} options.bundle
 * @param {string} options.location location specifier
 * @param {ArrayLike<number>} options.tGlob monthly global warming, driving both
 *   the seasonal design matrix and (as an annual series) the forced response
 * @param {Float64Array} options.forcedMonthly monthly forced response
 * @param {number} options.nRealizations
 * @param {() => number} options.normal standard-normal generator
 * @returns {Float64Array[]} one series per realization
 */
export function generateEnsemble({
  bundle,
  location,
  tGlob,
  forcedMonthly,
  nRealizations,
  normal,
}) {
  const nModes = bundle.nModes;
  const nTimes = tGlob.length;

  const design = designMatrix(tGlob);
  const seasonal = seasonalCycle(
    design,
    bundle.locationRow('seasonal_coef', location, 9),
    bundle.get('seasonal_intercept')[bundle.locationIndex(location)]
  );
  const projection = bundle.locationRow('eof_projection', location, nModes);

  const intercept = bundle.get('varx_intercept');
  const A = bundle.get('varx_A');
  const chol = bundle.get('varx_residual_chol');

  let series = [];
  for (let r = 0; r < nRealizations; r += 1) {
    const pcs = simulateVar({
      nTimes,
      intercept,
      A,
      chol,
      nModes,
      lagOrder: bundle.lagOrder,
      normal,
    });
    const stochastic = projectPcs(pcs, projection);
    const out = new Float64Array(nTimes);
    for (let t = 0; t < nTimes; t += 1) {
      out[t] = seasonal[t] + stochastic[t] + (forcedMonthly ? forcedMonthly[t] : 0);
    }
    series.push(out);
  }

  if (bundle.hasTransform) {
    // `pr` is generated as an anomaly; the baseline goes back on before the
    // transform, which expects absolute values.
    const baseline = bundle.get('transform_baseline')[bundle.locationIndex(location)];
    for (const s of series) {
      for (let t = 0; t < nTimes; t += 1) s[t] += baseline;
    }
    series = applyTransform(bundle, location, series);
  }
  return series;
}
