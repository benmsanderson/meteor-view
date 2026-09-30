/**
 * The simple view's numbers: the spread across models of each model's forced
 * change since 1850-1900.
 *
 * The expert view shows one model's internal variability, which a general
 * reader takes for the uncertainty in a projection. What they mean by that is
 * mostly model disagreement, so the simple view shows the spread across every
 * model the site carries instead.
 *
 * Each model contributes its forced response, the signal without internal
 * variability, measured from its own 1850-1900 level under the shared
 * baseline scenario, as the expert view measures it. Precipitation is a
 * percentage of the model's own 1850-1900 level, the convention for
 * precipitation change and the only way to put a desert and a monsoon on one
 * footing.
 *
 * Thirty models of bundles would be 11 MB, so the spread is computed once, at
 * build time, by scripts/build-summary.mjs, and served as one small file per
 * place.
 */

import { forcedResponse } from '../lib/kernel.js';
import { quantiles } from './chart.js';
import { BASELINES } from './explorer.js';

/** The years the simple chart shows: enough history to see it has begun. */
export const SUMMARY_YEARS = { start: 1950, end: 2100 };

/** Median, the middle half and the middle 90% of the models. */
export const SUMMARY_QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];

/** The periods the summary sentence quotes. */
export const SUMMARY_PERIODS = {
  recent: { from: 2005, to: 2024 },
  end: { from: 2081, to: 2100 },
};

/** Where one place's summary is served, relative to the data directory. */
export function summaryFile(location) {
  return `summary_v1/${location.replace(/[^A-Za-z0-9.-]/g, '_')}.json`;
}

/** Fetch one place's summary, or null when none was built. */
export async function loadSummary(base, location) {
  const response = await fetch(`${base}${summaryFile(location)}`);
  return response.ok ? response.json() : null;
}

/**
 * One model's forced change from 1850-1900 at one place, over its whole
 * forcing axis.
 *
 * Temperature in °C. Precipitation in percent of the 1850-1900 level, which
 * the bundle gives through its 2015 precipitation baseline, `transform_baseline`:
 * that level, less the forced change from 1850-1900 to 2015 under the
 * training scenario.
 *
 * @param {import('./explorer.js').Explorer} explorer
 * @param {{variable: 'tas'|'pr', location: string, scenario: string}} options
 * @returns {Float64Array} starting at the bundle's `forcingYearStart`
 */
export function modelChange(explorer, { variable, location, scenario }) {
  const bundle = explorer.bundles[variable];
  const forced = forcedResponse(bundle, location, bundle.forcing(scenario));
  const base = explorer.baselineOffset({ variable, location, baseline: 'pi' });
  const change = forced.map((v) => v - base);
  if (variable === 'tas') return change;

  const training = bundle.attrs.training_scenario;
  const reference = bundle.scenarios.includes(training) ? training : scenario;
  const at2015 = forcedResponse(bundle, location, bundle.forcing(reference))[
    2015 - bundle.forcingYearStart
  ];
  const level = bundle.get('transform_baseline')[bundle.locationIndex(location)] - (at2015 - base);
  return change.map((v) => (level > 0 ? (100 * v) / level : NaN));
}

/** Mean of an annual series over a period, given the series' first year. */
function periodMean(series, start, { from, to }) {
  let sum = 0;
  for (let y = from; y <= to; y += 1) sum += series[y - start];
  return sum / (to - from + 1);
}

const round = (digits) => (v) => Number(v.toFixed(digits));

/**
 * The spread across models at one place, for every scenario and both
 * variables: what one summary file holds.
 *
 * @param {Map<string, import('./explorer.js').Explorer>} explorers by model
 * @param {string} location
 */
export function summarizeLocation(explorers, location) {
  const models = [...explorers.keys()];
  const first = explorers.get(models[0]);
  const { start, end } = SUMMARY_YEARS;
  const out = {
    format: 'meteor-view-summary',
    schema_version: 1,
    location,
    models,
    baseline: BASELINES.pi,
    years: [start, end],
    quantiles: SUMMARY_QUANTILES,
    periods: SUMMARY_PERIODS,
  };
  for (const variable of ['tas', 'pr']) {
    const digits = variable === 'tas' ? 3 : 2;
    out[variable] = {};
    for (const scenario of first.scenarios) {
      const perModel = models.map((model) => {
        const explorer = explorers.get(model);
        return {
          series: modelChange(explorer, { variable, location, scenario }),
          start: explorer.bundles[variable].forcingYearStart,
        };
      });
      const windowed = perModel.map(({ series, start: s }) =>
        series.slice(start - s, end - s + 1)
      );
      const periods = {};
      for (const [name, period] of Object.entries(SUMMARY_PERIODS)) {
        const means = perModel.map(({ series, start: s }) => [periodMean(series, s, period)]);
        periods[name] = quantiles(means, SUMMARY_QUANTILES).map((q) => round(digits)(q[0]));
      }
      out[variable][scenario] = {
        bands: quantiles(windowed, SUMMARY_QUANTILES).map((q) => Array.from(q, round(digits))),
        ...periods,
      };
    }
  }
  return out;
}

/** "+3", "−2", "0": a signed number with a proper minus sign. */
function signed(value, digits) {
  const text = Math.abs(value).toFixed(digits);
  if (Number(text) === 0) return text;
  return `${value > 0 ? '+' : '−'}${text}`;
}

/** "A", "A and B", "A, B and C". */
function listOf(items) {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The simple view's reading of its chart, in one or two plain sentences: the
 * middle model's change by 2081-2100 under each scenario, with the range of
 * the middle 90% of models.
 *
 * @param {object} options
 * @param {object} options.summary one place's summary file
 * @param {'tas'|'pr'} options.variable
 * @param {string[]} options.scenarios in the order to name them
 * @param {(scenario: string) => string} options.label a scenario's name
 * @param {string} options.place the place's name, or 'global'
 * @returns {string}
 */
export function summarySentence({ summary, variable, scenarios, label, place }) {
  const { from, to } = summary.periods.end;
  const quantity = variable === 'tas' ? 'temperature' : 'precipitation';
  const where = place === 'global' ? `global ${quantity}` : `${quantity} in ${place}`;
  const parts = scenarios.map((scenario) => {
    const [low, , middle, , high] = summary[variable][scenario].end;
    if (variable === 'tas') {
      return `${middle.toFixed(1)}\u00a0°C (${low.toFixed(1)}–${high.toFixed(1)}) under ${label(scenario)}`;
    }
    return `${signed(middle, 0)}% (${signed(low, 0)} to ${signed(high, 0)}%) under ${label(scenario)}`;
  });
  const verb = variable === 'tas' ? 'is' : 'changes by';
  const reference = variable === 'tas' ? 'warmer than in 1850–1900' : 'compared with 1850–1900';
  const n = summary.models.length;
  const lead = `By ${from}–${to}, ${where} ${verb} ${listOf(parts)}, ${reference}.`;
  return n > 1
    ? `${lead.charAt(0).toUpperCase()}${lead.slice(1)} Figures in brackets span the middle 90% of the ${n} climate models.`
    : `${lead} From one climate model only, so no range across models.`;
}
