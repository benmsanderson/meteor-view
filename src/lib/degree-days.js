/**
 * Bias-corrected heating and cooling degree days.
 *
 * Degree days depend on absolute temperature, which a model can have a few
 * degrees off at any one place, and on how daily temperatures spread within a
 * month, which METEOR's monthly output does not carry. So both come from
 * observations and only the change comes from the model: for each place and
 * calendar month, scripts/make_degree_day_curves.py records how degree days in
 * the observed 1995-2014 climate (W5E5 v2.0, daily) respond to a uniform
 * temperature shift, and here each model's warming for that month is read off
 * the curve. This is the delta-change method on daily observations; for a
 * region it averages each gridbox's degree days rather than taking the degree
 * days of the region's average temperature.
 *
 * A model's warming for a month is measured from its own 1995-2014 climate of
 * that calendar month, which is the forced response plus its seasonal cycle,
 * whose amplitude changes with global warming: so a model that warms winters
 * more than summers says so here.
 *
 * Two kinds of curve. `climate` keeps the observed year-to-year variability
 * of monthly means, for a forced response that has none of its own; `within`
 * keeps only the spread of days within each month, for a realization that
 * brings its own year-to-year variability, which would otherwise count twice.
 */

import {
  annualToMonthly,
  designMatrix,
  forcedResponse,
  seasonalCycle,
} from './kernel.js';

/** Heating below and cooling above this daily mean temperature, °C: METEOR's default. */
export const DEGREE_DAY_BASE = 18;

/** The observed reference period the curves describe. */
export const DEGREE_DAY_PERIOD = { from: 1995, to: 2014 };

const MONTHS = 12;

/** Where one place's curves are served, relative to the data directory. */
export function degreeDayFile(location) {
  return `degree_days_v1/${location.replace(/[^A-Za-z0-9.-]/g, '_')}.json`;
}

/**
 * Fetch one place's curves, or null for a place without any (sea, global).
 * A server that answers a missing file with a page rather than a 404 counts
 * as none too.
 */
export async function loadDegreeDayCurves(base, location) {
  const response = await fetch(`${base}${degreeDayFile(location)}`);
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Degree days in one calendar month after a temperature shift, by linear
 * interpolation along the curve and linear extrapolation beyond it, where
 * degree days change by a month's days per degree.
 *
 * @param {object} curves one place's curves file
 * @param {'climate'|'within'} kind
 * @param {'hdd'|'cdd'} index
 * @param {number} month 0 for January
 * @param {number} shift °C from the observed 1995-2014 climate
 */
export function curveValue(curves, kind, index, month, shift) {
  const { start, step, n } = curves.shifts;
  const values = curves[kind][index][month];
  const position = (shift - start) / step;
  const i = Math.min(Math.max(Math.floor(position), 0), n - 2);
  const f = position - i;
  return Math.max(values[i] + f * (values[i + 1] - values[i]), 0);
}

/**
 * A model's deterministic monthly temperature at a place, as an anomaly on
 * the kernel's own terms: the seasonal harmonics, whose amplitude follows
 * global warming, plus the forced response. Over the full forcing axis,
 * starting in January of the bundle's first year.
 *
 * @param {import('../app/explorer.js').Explorer} explorer
 * @param {string} location
 * @param {string} scenario
 * @returns {Float64Array}
 */
export function deterministicMonthly(explorer, location, scenario) {
  const bundle = explorer.bundles.tas;
  const forced = annualToMonthly(forcedResponse(bundle, location, bundle.forcing(scenario)));
  const seasonal = seasonalCycle(
    globalDesign(bundle, scenario),
    bundle.locationRow('seasonal_coef', location, 9),
    bundle.get('seasonal_intercept')[bundle.locationIndex(location)],
    { anomaly: true }
  );
  return seasonal.map((v, t) => v + forced[t]);
}

/**
 * The seasonal design matrix a scenario's global warming gives, which every
 * place shares: computed once per bundle and scenario.
 */
const designs = new WeakMap();
function globalDesign(bundle, scenario) {
  if (!designs.has(bundle)) designs.set(bundle, new Map());
  const byScenario = designs.get(bundle);
  if (!byScenario.has(scenario)) {
    const global = forcedResponse(bundle, 'global', bundle.forcing(scenario));
    byScenario.set(scenario, designMatrix(annualToMonthly(global)));
  }
  return byScenario.get(scenario);
}

/**
 * The model's own 1995-2014 climate of each calendar month, on the same
 * anomaly terms as its runs, under the shared baseline scenario.
 *
 * @returns {Float64Array} twelve values, January first
 */
export function referenceClimate(explorer, location) {
  const bundle = explorer.bundles.tas;
  const monthly = deterministicMonthly(explorer, location, explorer.baselineScenario);
  const out = new Float64Array(MONTHS);
  const { from, to } = DEGREE_DAY_PERIOD;
  const first = (from - bundle.forcingYearStart) * MONTHS;
  const years = to - from + 1;
  for (let y = 0; y < years; y += 1) {
    for (let m = 0; m < MONTHS; m += 1) out[m] += monthly[first + y * MONTHS + m] / years;
  }
  return out;
}

/**
 * Monthly degree days for a monthly temperature series on the kernel's
 * anomaly terms, starting in January: each month's warming from the model's
 * reference climate, read off the observed curve for that month.
 *
 * @param {object} curves one place's curves file
 * @param {'climate'|'within'} kind `within` for a realization, `climate` for
 *   a forced response
 * @param {'hdd'|'cdd'} index
 * @param {ArrayLike<number>} series
 * @param {ArrayLike<number>} reference from {@link referenceClimate}
 * @returns {Float64Array}
 */
export function monthlyDegreeDays(curves, kind, index, series, reference) {
  return Float64Array.from(series, (v, t) =>
    curveValue(curves, kind, index, t % MONTHS, v - reference[t % MONTHS])
  );
}

/** Sum a monthly series into calendar years. */
export function annualSums(monthly) {
  const years = Math.floor(monthly.length / MONTHS);
  const out = new Float64Array(years);
  for (let y = 0; y < years; y += 1) {
    let sum = 0;
    for (let m = 0; m < MONTHS; m += 1) sum += monthly[y * MONTHS + m];
    out[y] = sum;
  }
  return out;
}
