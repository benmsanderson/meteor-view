/**
 * Crop yields: the GGCMI Phase 2 emulators driven by a climate model's change.
 *
 * The emulators (Franke et al. 2020, doi:10.5194/gmd-13-3995-2020; vendored in
 * METEOR as `meteor.impacts.ggcm`) give each crop model's long-term mean
 * rainfed yield at a gridpoint as a third-order polynomial in CO2, the
 * temperature change and the precipitation ratio from 1980-2010, and nitrogen.
 * They have no year-to-year variability: a yield here is the climate's, not a
 * harvest's.
 *
 * The site feeds them each climate model's forced change since 1980-2010, not
 * its absolute climate, which is how GGCMI's own experiments were defined
 * (uniform shifts on the observed climate) and keeps a model's local bias
 * from reading as climate change (METEOR#111). The coefficients come reduced
 * to the site's 2-degree map grid, weighted by rainfed harvested area, by
 * scripts/make_crop_coefficients.py; that reduction is exact for these inputs.
 *
 * Everything is a percentage change from 1980-2010: the emulators reproduce
 * a crop model's response far better than its absolute yields, and the crop
 * models disagree about absolute yields by a factor of two.
 */

import { regrid } from '../app/map.js';
import { dataUrl } from './data-url.js';

/** The emulators' reference period, and so the site's for crops. */
export const CROP_BASELINE = { from: 1980, to: 2010 };

/** Years the crop series cover: from the reference period to 2100. */
export const CROP_YEARS = { start: 1980, end: 2100 };

/** Uniform nitrogen application, kg N per hectare per year. */
export const NITROGEN = 100;

/** The emulators' training ranges (Franke et al. 2020, Table 2); inputs are clamped to them. */
export const CROP_LIMITS = {
  co2: [360, 810],
  temperature: [-1, 6],
  precipitation: [0.5, 1.3],
  nitrogen: [10, 200],
};

/** The crops the site offers, in menu order. */
export const CROPS = {
  wheat: { label: 'Wheat' },
  maize: { label: 'Maize' },
  rice: { label: 'Rice' },
  soy: { label: 'Soybean' },
};

const N_TERMS = 34;

/**
 * The polynomial's 34 terms for one set of inputs, in the order of the
 * coefficient files: METEOR's `get_yields`, term for term.
 */
export function terms(c, t, w, n, out = new Float64Array(N_TERMS)) {
  out[0] = 1;
  out[1] = c;
  out[2] = t;
  out[3] = w;
  out[4] = n;
  out[5] = c * c;
  out[6] = c * t;
  out[7] = c * w;
  out[8] = c * n;
  out[9] = t * t;
  out[10] = t * w;
  out[11] = t * n;
  out[12] = w * w;
  out[13] = w * n;
  out[14] = n * n;
  out[15] = c * c * c;
  out[16] = c * c * t;
  out[17] = c * c * w;
  out[18] = c * c * n;
  out[19] = c * t * t;
  out[20] = c * t * w;
  out[21] = c * t * n;
  out[22] = c * w * w;
  out[23] = c * w * n;
  out[24] = c * n * n;
  out[25] = t * t * t;
  out[26] = t * t * w;
  out[27] = t * t * n;
  out[28] = t * w * w;
  out[29] = t * w * n;
  out[30] = t * n * n;
  out[31] = w * w * w;
  out[32] = w * w * n;
  out[33] = w * n * n;
  return out;
}

const clamp = (v, [lo, hi]) => Math.min(Math.max(v, lo), hi);

/**
 * Yield at one cell, t dry matter per hectare, from the clamped inputs.
 *
 * @param {Float32Array} coefficients one crop file
 * @param {number} cell the cell's position in the file
 * @param {Float64Array} basis from {@link terms}
 */
export function cellYield(coefficients, stride, cell, basis) {
  let sum = 0;
  const offset = cell * stride;
  for (let i = 0; i < N_TERMS; i += 1) sum += coefficients[offset + i] * basis[i];
  return sum > 0 ? sum : 0;
}

/**
 * A climate model's inputs to the emulators at the cells that grow any crop:
 * per year, the temperature change and the precipitation ratio from its own
 * 1980-2010 climate.
 *
 * Both are linear in the step-response PCs, so the pattern loadings are put
 * onto the 2-degree grid once, at those cells, and every year is then a short
 * dot product. Precipitation is the model's absolute level (its 2015
 * climatology carried by the forced response, as the maps take it), so the
 * ratio is of like with like.
 *
 * @param {import('../app/explorer.js').Explorer} explorer with pattern artifacts
 *   and climatology loaded
 * @param {{grid: {lat: Float64Array, lon: Float64Array}, cells: number[]}} where
 * @returns {Promise<(scenario: string) => {temperature: Float64Array, ratio: Float64Array}>}
 *   per scenario, year-major arrays over CROP_YEARS × cells
 */
export async function cropInputs(explorer, { grid, cells }) {
  const { patternKernel, stepResponsePcs } = await import('./pattern.js');
  const loadings = {};
  for (const variable of ['tas', 'pr']) {
    const artifact = await explorer.patterns(variable);
    const stride = artifact.dims.exp * artifact.nModes;
    const matrix = new Float64Array(stride * cells.length);
    const unit = new Float64Array(stride);
    for (let k = 0; k < stride; k += 1) {
      unit.fill(0);
      unit[k] = 1;
      const field = regrid({ field: artifact.map(unit), lat: artifact.lat, lon: artifact.lon }, grid.lat, grid.lon);
      for (let c = 0; c < cells.length; c += 1) matrix[c * stride + k] = field[cells[c]];
    }
    loadings[variable] = { artifact, stride, matrix };
  }
  const climatology = regrid(
    { field: Float64Array.from(await explorer.climatology()), lat: loadings.pr.artifact.lat, lon: loadings.pr.artifact.lon },
    grid.lat,
    grid.lon
  );

  // Each variable's field at the cells, per year, for one scenario.
  const atCells = (variable, scenario) => {
    const { artifact, stride, matrix } = loadings[variable];
    const bundle = explorer.bundles[variable];
    const { pcs } = stepResponsePcs(patternKernel(artifact), bundle.forcing(scenario));
    return (year) => {
      const offset = (year - bundle.forcingYearStart) * stride;
      const out = new Float64Array(cells.length);
      for (let c = 0; c < cells.length; c += 1) {
        let acc = 0;
        for (let k = 0; k < stride; k += 1) acc += matrix[c * stride + k] * pcs[offset + k];
        out[c] = acc;
      }
      return out;
    };
  };

  // The model's own 1980-2010 climate, and its 2015 precipitation, under the
  // baseline scenario.
  const reference = explorer.baselineScenario;
  const tasRef = atCells('tas', reference);
  const prRef = atCells('pr', reference);
  const n = CROP_BASELINE.to - CROP_BASELINE.from + 1;
  const tasBase = new Float64Array(cells.length);
  const prBase = new Float64Array(cells.length);
  for (let year = CROP_BASELINE.from; year <= CROP_BASELINE.to; year += 1) {
    const t = tasRef(year);
    const p = prRef(year);
    for (let c = 0; c < cells.length; c += 1) {
      tasBase[c] += t[c] / n;
      prBase[c] += p[c] / n;
    }
  }
  const pr2015 = prRef(2015);
  // Absolute precipitation is the climatology plus the forced change since 2015.
  const level = Float64Array.from(cells, (cell, c) => climatology[cell] - pr2015[c]);

  return (scenario) => {
    const tas = atCells('tas', scenario);
    const pr = atCells('pr', scenario);
    const nYears = CROP_YEARS.end - CROP_YEARS.start + 1;
    const temperature = new Float64Array(nYears * cells.length);
    const ratio = new Float64Array(nYears * cells.length);
    for (let y = 0; y < nYears; y += 1) {
      const t = tas(CROP_YEARS.start + y);
      const p = pr(CROP_YEARS.start + y);
      for (let c = 0; c < cells.length; c += 1) {
        temperature[y * cells.length + c] = t[c] - tasBase[c];
        const base = level[c] + prBase[c];
        // No meaningful ratio where the model has essentially no rain: no change.
        ratio[y * cells.length + c] = base > 1e-9 ? Math.max(level[c] + p[c], 0) / base : 1;
      }
    }
    return { temperature, ratio };
  };
}

/**
 * The polynomial's terms at a crop's cells for every year, from the clamped
 * inputs: the same for every crop model, so computed once.
 *
 * @param {number[]} positions each of the crop's cells' position in the
 *   inputs' cell list
 * @param {{temperature: Float64Array, ratio: Float64Array}} inputs from
 *   {@link cropInputs}, for one scenario
 * @param {number} nInputCells the inputs' cell count
 * @param {ArrayLike<number>} co2 ppm per year over CROP_YEARS
 * @returns {Float64Array} year-major, then cell, then term
 */
export function cropBases(positions, inputs, nInputCells, co2) {
  const nYears = CROP_YEARS.end - CROP_YEARS.start + 1;
  const out = new Float64Array(nYears * positions.length * N_TERMS);
  const n = clamp(NITROGEN, CROP_LIMITS.nitrogen);
  for (let y = 0; y < nYears; y += 1) {
    const c = clamp(co2[y], CROP_LIMITS.co2);
    for (let k = 0; k < positions.length; k += 1) {
      const i = y * nInputCells + positions[k];
      const t = clamp(inputs.temperature[i], CROP_LIMITS.temperature);
      const w = clamp(inputs.ratio[i], CROP_LIMITS.precipitation);
      terms(c, t, w, n, out.subarray((y * positions.length + k) * N_TERMS, (y * positions.length + k + 1) * N_TERMS));
    }
  }
  return out;
}

/**
 * Yields at a crop's cells for every year, t/ha, year-major.
 *
 * @param {Float32Array} coefficients one crop model's file for the crop
 * @param {Float64Array} bases from {@link cropBases}
 * @param {number} nCells the crop's cell count
 * @param {number} stride values per cell in the coefficient file (35)
 */
export function yieldsFromBases(coefficients, bases, nCells, stride) {
  const n = bases.length / N_TERMS;
  const out = new Float64Array(n);
  for (let j = 0; j < n; j += 1) {
    const k = j % nCells;
    let sum = 0;
    const b = j * N_TERMS;
    const o = k * stride;
    for (let i = 0; i < N_TERMS; i += 1) sum += coefficients[o + i] * bases[b + i];
    out[j] = sum > 0 ? sum : 0;
  }
  return out;
}

/** Yields at a crop's cells for every year, from the inputs: the two steps above. */
export function cropYields(coefficients, positions, inputs, nInputCells, co2, stride) {
  return yieldsFromBases(coefficients, cropBases(positions, inputs, nInputCells, co2), positions.length, stride);
}

/**
 * Percentage change in production-weighted yield over a set of cells, per
 * year: the area-weighted yield relative to its own 1980-2010 mean. Null
 * where the cells grow none of the crop, or the crop model gives it no yield.
 *
 * @param {Float64Array} yields from {@link cropYields}
 * @param {number} nCells
 * @param {Array<[number, number]>} members [cell position, weight] pairs, the
 *   weight being harvested area times the share of the cell in the place
 */
export function yieldChange(yields, nCells, members) {
  const nYears = yields.length / nCells;
  const total = new Float64Array(nYears);
  for (let y = 0; y < nYears; y += 1) {
    let sum = 0;
    for (const [k, w] of members) sum += w * yields[y * nCells + k];
    total[y] = sum;
  }
  let base = 0;
  for (let year = CROP_BASELINE.from; year <= CROP_BASELINE.to; year += 1) base += total[year - CROP_YEARS.start];
  base /= CROP_BASELINE.to - CROP_BASELINE.from + 1;
  if (!(base > 0)) return null;
  return total.map((v) => (100 * (v - base)) / base);
}

/** CO2 per year over CROP_YEARS for one scenario, from data/scenario_co2_v1.json. */
export function co2Series(file, scenario) {
  const values = file.scenarios[scenario];
  if (!values) return null;
  return Float64Array.from({ length: CROP_YEARS.end - CROP_YEARS.start + 1 }, (_, y) => values[CROP_YEARS.start + y - file.year_start]);
}

/** The crop index, and one crop model's coefficients for a crop, from the data directory. */
export async function loadCropIndex(base) {
  const response = await fetch(dataUrl(base, 'crops_v1/index.json'));
  return response.ok ? response.json() : null;
}

export function cropFile(model, crop, variant = 'A0') {
  return `crops_v1/${model}_${crop}_${variant}.f32`;
}

export function parseCoefficients(buffer) {
  return new Float32Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}
