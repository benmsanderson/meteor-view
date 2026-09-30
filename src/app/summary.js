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
import {
  DEGREE_DAY_PERIOD,
  annualSums,
  curveValue,
  deterministicMonthly,
  monthlyDegreeDays,
  referenceClimate,
} from '../lib/degree-days.js';
import { quantiles } from './chart.js';
import { BASELINES } from './explorer.js';
import { dataUrl } from '../lib/data-url.js';

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
  const response = await fetch(dataUrl(base, summaryFile(location)));
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

/**
 * One model's bias-corrected degree days per year at one place, over its
 * whole forcing axis: its forced monthly warming read off the observed curves
 * (src/lib/degree-days.js). The `climate` curves, since a forced response has
 * no year-to-year variability of its own.
 *
 * @param {import('./explorer.js').Explorer} explorer
 * @param {{index: 'hdd'|'cdd', location: string, scenario: string, curves: object,
 *   reference?: ArrayLike<number>, monthly?: Float64Array}} options the
 *   reference climate and the monthly series, when already computed
 * @returns {Float64Array} starting at the bundle's `forcingYearStart`
 */
export function modelDegreeDays(
  explorer,
  { index, location, scenario, curves, reference, monthly: given }
) {
  const monthly = given ?? deterministicMonthly(explorer, location, scenario);
  const ref = reference ?? referenceClimate(explorer, location);
  return annualSums(monthlyDegreeDays(curves, 'climate', index, monthly, ref));
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
export function summarizeLocation(explorers, location, curves = null) {
  const models = [...explorers.keys()];
  const references = new Map();
  // Each model's monthly climate per scenario, shared by heating and cooling.
  const monthlies = new Map();
  const monthlyFor = (model, scenario) => {
    const key = `${model}|${scenario}`;
    if (!monthlies.has(key)) {
      monthlies.set(key, deterministicMonthly(explorers.get(model), location, scenario));
    }
    return monthlies.get(key);
  };
  if (curves) {
    for (const model of models) references.set(model, referenceClimate(explorers.get(model), location));
  }
  return summarize(explorers, location, curves, (model, variable, scenario) => {
    const explorer = explorers.get(model);
    return variable === 'hdd' || variable === 'cdd'
      ? modelDegreeDays(explorer, {
          index: variable,
          location,
          scenario,
          curves,
          reference: references.get(model),
          monthly: monthlyFor(model, scenario),
        })
      : modelChange(explorer, { variable, location, scenario });
  });
}

/**
 * The same, for a city the bundles do not carry: each model's forced response
 * at the city's gridbox, read from its pattern artifacts (which a place in the
 * bundles gets the same way, at export). No seasonal cycle is stored for such
 * a point, so its degree days apply each model's annual warming to every
 * month, still on the observed daily climate.
 *
 * @param {Map<string, import('./explorer.js').Explorer>} explorers with pattern
 *   artifacts, land fraction and precipitation climatology loaded
 * @param {{spec: string}} city with `spec` a `point:lat,lon` specifier
 * @param {object|null} curves the city's observed degree-day curves
 */
export async function summarizeCity(explorers, city, curves = null) {
  const { pointWeights } = await import('../lib/pattern.js');
  const [lat, lon] = city.spec.slice('point:'.length).split(',').map(Number);
  const series = new Map();
  for (const [model, explorer] of explorers) {
    const start = explorer.bundles.tas.forcingYearStart;
    const at = (values, year) => values[year - start];
    const mean = (values, from, to) => {
      let sum = 0;
      for (let y = from; y <= to; y += 1) sum += at(values, y);
      return sum / (to - from + 1);
    };
    const land = explorer.landPercent ?? null;
    const forced = {};
    const points = {};
    for (const variable of ['tas', 'pr']) {
      const artifact = await explorer.patterns(variable);
      points[variable] = pointWeights(artifact, land, lat, lon).index;
      forced[variable] = (scenario) => cachedPoint(explorer, variable, scenario, points[variable]);
    }
    const reference = explorer.baselineScenario;
    const tasBase = mean(await forced.tas(reference), 1850, 1900);
    const prReference = await forced.pr(reference);
    const prBase = mean(prReference, 1850, 1900);
    // The 1850-1900 precipitation level, as the page's maps take it: the
    // model's 2015 climatology, carried back by the forced response.
    const level = explorer.prClimatology[points.pr] + prBase - at(prReference, 2015);
    const recent = mean(await forced.tas(reference), DEGREE_DAY_PERIOD.from, DEGREE_DAY_PERIOD.to);
    for (const scenario of explorer.scenarios) {
      const tas = await forced.tas(scenario);
      const pr = await forced.pr(scenario);
      series.set(`${model}|tas|${scenario}`, tas.map((v) => v - tasBase));
      series.set(
        `${model}|pr|${scenario}`,
        pr.map((v) => (level > 0 ? (100 * (v - prBase)) / level : NaN))
      );
      if (curves) {
        for (const index of ['hdd', 'cdd']) {
          series.set(
            `${model}|${index}|${scenario}`,
            tas.map((v) => {
              let total = 0;
              for (let m = 0; m < 12; m += 1) total += curveValue(curves, 'climate', index, m, v - recent);
              return total;
            })
          );
        }
      }
    }
  }
  return summarize(explorers, city.spec, curves, (model, variable, scenario) =>
    series.get(`${model}|${variable}|${scenario}`)
  );
}

/**
 * Step-response PCs per model, variable and scenario, which every city
 * shares, and a city's annual forced response from them: its gridbox's
 * pattern loadings, read directly rather than projected over the whole grid.
 */
const pcsCache = new WeakMap();
async function cachedPcs(explorer, variable, scenario) {
  const { patternKernel, stepResponsePcs } = await import('../lib/pattern.js');
  const artifact = await explorer.patterns(variable);
  if (!pcsCache.has(artifact)) pcsCache.set(artifact, new Map());
  const byScenario = pcsCache.get(artifact);
  if (!byScenario.has(scenario)) {
    byScenario.set(
      scenario,
      stepResponsePcs(patternKernel(artifact), explorer.bundles[variable].forcing(scenario))
    );
  }
  return { artifact, ...byScenario.get(scenario) };
}

async function cachedPoint(explorer, variable, scenario, index) {
  const { artifact, pcs, nTimes } = await cachedPcs(explorer, variable, scenario);
  const nExp = artifact.dims.exp;
  const nModes = artifact.nModes;
  const space = artifact.nLat * artifact.nLon;
  const patterns = artifact.get('pattern_v');
  const loading = new Float64Array(nExp * nModes);
  for (let e = 0; e < nExp; e += 1) {
    for (let m = 0; m < nModes; m += 1) {
      const value = patterns[((e * artifact.nFields + 0) * nModes + m) * space + index];
      loading[e * nModes + m] = Number.isFinite(value) ? value : 0;
    }
  }
  const annual = new Float64Array(nTimes);
  for (let t = 0; t < nTimes; t += 1) {
    let acc = 0;
    for (let k = 0; k < loading.length; k += 1) acc += pcs[t * loading.length + k] * loading[k];
    annual[t] = acc;
  }
  return annual;
}

/** The spread across models of every series, for one place: one summary file. */
function summarize(explorers, location, curves, seriesFor) {
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
  // Degree days where there are observations to correct them with: land
  // regions and cities, not the sea or the global mean.
  const variables = ['tas', 'pr'];
  if (curves) {
    variables.push('hdd', 'cdd');
    out.observed = { period: DEGREE_DAY_PERIOD, ...curves.observed_annual };
  }
  const DIGITS = { tas: 3, pr: 2, hdd: 0, cdd: 0 };
  for (const variable of variables) {
    const digits = DIGITS[variable];
    out[variable] = {};
    for (const scenario of first.scenarios) {
      const perModel = models.map((model) => ({
        series: seriesFor(model, variable, scenario),
        start: explorers.get(model).bundles.tas.forcingYearStart,
      }));
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
  if (variable === 'hdd' || variable === 'cdd') {
    return degreeDaySentence({ summary, variable, scenarios, label, place });
  }
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

/** "2,450": degree days are counted in thousands, so group them. */
const count = (v) => Math.round(v).toLocaleString('en-GB');

/**
 * The simple view's reading of a degree-days chart: the observed 1995-2014
 * level, then the middle model and the middle 90% by 2081-2100 under each
 * scenario.
 */
function degreeDaySentence({ summary, variable, scenarios, label, place }) {
  const { from, to } = summary.periods.end;
  const noun = variable === 'hdd' ? 'Heating degree days' : 'Cooling degree days';
  const where = place === 'global' ? '' : ` in ${place}`;
  const { period } = summary.observed;
  const parts = scenarios.map((scenario) => {
    const [low, , middle, , high] = summary[variable][scenario].end;
    return `${count(middle)} (${count(low)}–${count(high)}) under ${label(scenario)}`;
  });
  const n = summary.models.length;
  const range =
    n > 1
      ? ` Figures in brackets span the middle 90% of the ${n} climate models.`
      : ' From one climate model only, so no range across models.';
  return (
    `${noun}${where} were ${count(summary.observed[variable])} a year in ` +
    `${period.from}–${period.to}, as observed. By ${from}–${to} they come to ` +
    `${listOf(parts)}.${range}`
  );
}

/** The simple view's map: a common 2-degree grid every model is put onto. */
export const SUMMARY_GRID = {
  lat: Float64Array.from({ length: 90 }, (_, i) => -89 + 2 * i),
  lon: Float64Array.from({ length: 180 }, (_, j) => 1 + 2 * j),
};

/** Where one scenario's map across models is served. */
export function summaryMapFile(scenario) {
  return `summary_v1/map_${scenario.replace(/[^A-Za-z0-9.-]/g, '_')}.json`;
}

/**
 * One model's mean change over a period, as a map in the page's map units:
 * °C for temperature, percent of the 1850-1900 level for precipitation.
 *
 * The forced map is linear in the step-response PCs, so the period mean is the
 * map of the PCs' period mean, exactly.
 *
 * @param {import('./explorer.js').Explorer} explorer with its pattern artifacts,
 *   and for precipitation its climatology, already loaded
 * @param {{variable: 'tas'|'pr', scenario: string, period?: {from: number, to: number}}} options
 * @returns {Promise<{field: Float64Array, lat: Float64Array, lon: Float64Array}>}
 */
export async function modelMapChange(explorer, { variable, scenario, period = SUMMARY_PERIODS.end }) {
  const { toMapUnits } = await import('./map.js');
  const bundle = explorer.bundles[variable];
  const { artifact, pcs } = await cachedPcs(explorer, variable, scenario);
  const stride = artifact.dims.exp * artifact.nModes;
  const mean = new Float64Array(stride);
  for (let year = period.from; year <= period.to; year += 1) {
    const offset = (year - bundle.forcingYearStart) * stride;
    for (let i = 0; i < stride; i += 1) mean[i] += pcs[offset + i] / (period.to - period.from + 1);
  }
  const base = await explorer.baselineMap({ variable, baseline: 'pi' });
  const climatology = variable === 'pr' ? await explorer.climatology() : null;
  return {
    field: toMapUnits(artifact.map(mean), variable, base, climatology),
    lat: artifact.lat,
    lon: artifact.lon,
  };
}

/**
 * The middle model's change at every point of the common grid, for one
 * scenario and both variables: what one map file holds. A point where fewer
 * than half the models have a value (precipitation in the driest deserts,
 * where a percentage means nothing) is left blank.
 *
 * @param {Map<string, import('./explorer.js').Explorer>} explorers by model
 * @param {string} scenario
 */
export async function summarizeMap(explorers, scenario) {
  const { regrid } = await import('./map.js');
  const { lat, lon } = SUMMARY_GRID;
  const out = {
    format: 'meteor-view-summary-map',
    schema_version: 1,
    scenario,
    models: [...explorers.keys()],
    period: SUMMARY_PERIODS.end,
    baseline: BASELINES.pi,
    lat: [lat[0], lat[1] - lat[0], lat.length],
    lon: [lon[0], lon[1] - lon[0], lon.length],
  };
  for (const variable of ['tas', 'pr']) {
    const fields = [];
    for (const explorer of explorers.values()) {
      const map = await modelMapChange(explorer, { variable, scenario });
      fields.push(regrid(map, lat, lon));
    }
    const median = new Array(lat.length * lon.length);
    const column = [];
    for (let k = 0; k < median.length; k += 1) {
      column.length = 0;
      for (const field of fields) if (Number.isFinite(field[k])) column.push(field[k]);
      if (column.length * 2 < fields.length) {
        median[k] = null;
        continue;
      }
      column.sort((a, b) => a - b);
      const mid = (column.length - 1) / 2;
      const value = (column[Math.floor(mid)] + column[Math.ceil(mid)]) / 2;
      median[k] = Number(value.toFixed(variable === 'tas' ? 2 : 1));
    }
    out[variable] = median;
  }
  return out;
}

/** A map file's grid and field, as the map drawing code takes them. */
export function mapFromFile(file, variable) {
  const axis = ([first, step, n]) => Float64Array.from({ length: n }, (_, i) => first + step * i);
  return {
    field: Float64Array.from(file[variable], (v) => (v === null ? NaN : v)),
    lat: axis(file.lat),
    lon: axis(file.lon),
  };
}


/*
 * The expert view's multi-model mean.
 *
 * The expert view offers the mean across models as one more "model": its line
 * is the mean of the models' forced responses and its band their spread, on
 * the expert view's own terms (either baseline, precipitation in mm/day,
 * degree days, a seasonal panel and maps at any year). Like the simple view's
 * spread it is computed at build time, so the page never loads every model.
 */

/** The expert view's window. */
export const EXPERT_YEARS = { start: 2015, end: 2100 };

/** The years the mean maps are stored at; the page interpolates between. */
export const EXPERT_MAP_YEARS = [2015, 2020, 2030, 2040, 2050, 2060, 2070, 2080, 2090, 2100];

/** The expert-view files: one per place, one per scenario's maps, one of baselines. */
export function expertFile(location) {
  return `summary_v1/expert/${location.replace(/[^A-Za-z0-9.-]/g, '_')}.json`;
}
export function expertMapFile(scenario) {
  return `summary_v1/expert/map_${scenario.replace(/[^A-Za-z0-9.-]/g, '_')}.json`;
}
export const EXPERT_BASELINE_MAP = 'summary_v1/expert/map_baseline_recent.json';

const SECONDS_PER_DAY = 86400;

/** Mean and quantiles across models, per year. */
function meanAndBands(series, digits) {
  const n = series[0].length;
  const mean = Array.from({ length: n }, (_, t) => series.reduce((s, x) => s + x[t], 0) / series.length);
  return {
    mean: mean.map(round(digits)),
    bands: quantiles(series, SUMMARY_QUANTILES).map((q) => Array.from(q, round(digits))),
  };
}

/**
 * One place's multi-model mean for the expert view, every scenario.
 *
 * Per model: temperature change from 1850-1900 and from 2005-2024 (each from
 * the model's own period mean under the baseline scenario, as the expert view
 * takes a baseline); precipitation as the model's absolute level in mm/day
 * (its 2015 level carried by the forced response), as the expert view shows
 * precipitation; and, where there are observations, bias-corrected degree
 * days. Then the monthly climatology of 2015-2034 and 2081-2100 for the
 * seasonal panel: absolute temperature and degree days.
 *
 * @param {Map<string, import('./explorer.js').Explorer>} explorers
 * @param {string} location a place the bundles carry
 * @param {object|null} curves its observed degree-day curves
 */
export function summarizeExpert(explorers, location, curves = null) {
  const models = [...explorers.keys()];
  const first = explorers.get(models[0]);
  const { start, end } = EXPERT_YEARS;
  const out = {
    format: 'meteor-view-multi-model-mean',
    schema_version: 1,
    location,
    models,
    years: [start, end],
    quantiles: SUMMARY_QUANTILES,
    scenarios: {},
  };
  const window = (series, first0) => series.slice(start - first0, end - first0 + 1);
  const perModel = new Map();
  for (const model of models) {
    const explorer = explorers.get(model);
    const y0 = explorer.bundles.tas.forcingYearStart;
    const reference = explorer.baselineScenario;
    const recent = periodMean(
      modelChange(explorer, { variable: 'tas', location, scenario: reference }),
      y0,
      BASELINES.recent
    );
    const pr = explorer.bundles.pr;
    const training = pr.scenarios.includes(pr.attrs.training_scenario) ? pr.attrs.training_scenario : reference;
    const at2015 = forcedResponse(pr, location, pr.forcing(training))[2015 - pr.forcingYearStart];
    const level = pr.get('transform_baseline')[pr.locationIndex(location)];
    const climate = curves ? referenceClimate(explorer, location) : null;
    const offset = explorer.absoluteOffset({ variable: 'tas', location });
    perModel.set(model, { explorer, y0, recent, at2015, level, climate, offset });
  }
  const monthlyMeans = (monthly, from, to, y0, shift = 0) => {
    const outMonths = new Array(12).fill(0);
    for (let y = from; y <= to; y += 1) {
      for (let m = 0; m < 12; m += 1) outMonths[m] += (monthly[(y - y0) * 12 + m] + shift) / (to - from + 1);
    }
    return outMonths;
  };
  for (const scenario of first.scenarios) {
    const series = { tas_pi: [], tas_recent: [], pr: [], hdd: [], cdd: [] };
    const seasonal = { tas: [], hdd: [], cdd: [] };
    for (const model of models) {
      const { explorer, y0, recent, at2015, level, climate, offset } = perModel.get(model);
      const tas = modelChange(explorer, { variable: 'tas', location, scenario });
      series.tas_pi.push(window(tas, y0));
      series.tas_recent.push(window(tas.map((v) => v - recent), y0));
      const pr = explorer.bundles.pr;
      const forced = forcedResponse(pr, location, pr.forcing(scenario));
      series.pr.push(window(forced.map((v) => (level + v - at2015) * SECONDS_PER_DAY), pr.forcingYearStart));
      const monthly = deterministicMonthly(explorer, location, scenario);
      seasonal.tas.push({
        early: monthlyMeans(monthly, 2015, 2034, y0, offset),
        late: monthlyMeans(monthly, 2081, 2100, y0, offset),
      });
      if (curves) {
        for (const index of ['hdd', 'cdd']) {
          const days = monthlyDegreeDays(curves, 'climate', index, monthly, climate);
          series[index].push(window(annualSums(days), y0));
          seasonal[index].push({ early: monthlyMeans(days, 2015, 2034, y0), late: monthlyMeans(days, 2081, 2100, y0) });
        }
      }
    }
    const entry = {
      tas_pi: meanAndBands(series.tas_pi, 3),
      tas_recent: meanAndBands(series.tas_recent, 3),
      pr: meanAndBands(series.pr, 4),
      seasonal: {},
    };
    if (curves) {
      entry.hdd = meanAndBands(series.hdd, 0);
      entry.cdd = meanAndBands(series.cdd, 0);
    }
    for (const [key, list] of Object.entries(seasonal)) {
      if (!list.length) continue;
      const digits = key === 'tas' ? 2 : 1;
      const avg = (part) => Array.from({ length: 12 }, (_, m) => round(digits)(list.reduce((s, x) => s + x[part][m], 0) / list.length));
      entry.seasonal[key] = { early: avg('early'), late: avg('late') };
    }
    out.scenarios[scenario] = entry;
  }
  return out;
}

/** The mean across models, point by point, of maps on the common grid. */
function meanField(fields, digits) {
  const n = fields[0].length;
  const out = new Array(n);
  for (let k = 0; k < n; k += 1) {
    let sum = 0;
    let count = 0;
    for (const field of fields) {
      if (Number.isFinite(field[k])) {
        sum += field[k];
        count += 1;
      }
    }
    out[k] = count * 2 < fields.length ? null : Number((sum / count).toFixed(digits));
  }
  return out;
}

/**
 * One scenario's multi-model mean maps, from 1850-1900, at the stored years:
 * temperature in °C and precipitation in percent, on the common grid.
 */
export async function summarizeExpertMap(explorers, scenario) {
  const { regrid } = await import('./map.js');
  const { lat, lon } = SUMMARY_GRID;
  const out = {
    format: 'meteor-view-multi-model-mean-map',
    schema_version: 1,
    scenario,
    models: [...explorers.keys()],
    baseline: BASELINES.pi,
    years: EXPERT_MAP_YEARS,
    lat: [lat[0], lat[1] - lat[0], lat.length],
    lon: [lon[0], lon[1] - lon[0], lon.length],
  };
  for (const variable of ['tas', 'pr']) {
    out[variable] = [];
    for (const year of EXPERT_MAP_YEARS) {
      const fields = [];
      for (const explorer of explorers.values()) {
        const map = await modelMapChange(explorer, { variable, scenario, period: { from: year, to: year } });
        fields.push(regrid(map, lat, lon));
      }
      out[variable].push(meanField(fields, variable === 'tas' ? 2 : 1));
    }
  }
  return out;
}

/**
 * What the recent baseline is on the maps' terms: each model's 2005-2024
 * change from 1850-1900 under the baseline scenario, averaged. Temperature
 * maps from 2005-2024 are the 1850-1900 maps less this, exactly; precipitation
 * percentages are rebased with it, which for a mean across models is close
 * rather than exact.
 */
export async function summarizeExpertBaselineMap(explorers) {
  const { regrid } = await import('./map.js');
  const { lat, lon } = SUMMARY_GRID;
  const out = {
    format: 'meteor-view-multi-model-mean-baseline',
    schema_version: 1,
    models: [...explorers.keys()],
    period: BASELINES.recent,
    lat: [lat[0], lat[1] - lat[0], lat.length],
    lon: [lon[0], lon[1] - lon[0], lon.length],
  };
  for (const variable of ['tas', 'pr']) {
    const fields = [];
    for (const explorer of explorers.values()) {
      const map = await modelMapChange(explorer, {
        variable,
        scenario: explorer.baselineScenario,
        period: BASELINES.recent,
      });
      fields.push(regrid(map, lat, lon));
    }
    out[variable] = meanField(fields, variable === 'tas' ? 2 : 1);
  }
  return out;
}
