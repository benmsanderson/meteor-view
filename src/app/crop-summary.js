/**
 * The simple view's crop yields: the spread across every pairing of climate
 * model and crop model, computed at build time (scripts/build-summary.mjs).
 *
 * Each pairing contributes the crop model's emulated yield under the climate
 * model's forced change, as a percentage of its own 1980-2010 level
 * (src/lib/crops.js). The spread is then over both kinds of model at once,
 * which is the uncertainty a reader means: the climate models disagree about
 * the climate, and the crop models about what it does to crops.
 */

import { quantiles } from './chart.js';
import {
  CROPS,
  CROP_BASELINE,
  CROP_YEARS,
  NITROGEN,
  co2Series,
  cropBases,
  cropInputs,
  yieldChange,
  yieldsFromBases,
} from '../lib/crops.js';
import { SUMMARY_GRID, SUMMARY_PERIODS, SUMMARY_QUANTILES } from './summary.js';

/** A region needs this much of a crop, in hectares, to be given a yield for it. */
export const MIN_REGION_AREA = 100_000;

/** A map cell needs this much of a crop, in hectares, to be coloured. */
export const MIN_CELL_AREA = 5_000;

/** Where one scenario's crop maps are served. */
export function cropMapFile(scenario) {
  return `summary_v1/crops_${scenario.replace(/[^A-Za-z0-9.-]/g, '_')}.json`;
}

const round1 = (v) => Number(v.toFixed(1));

/** One cell's mean yield over a period, from year-major yields. */
function periodMean(yields, nCells, k, { from, to }) {
  let sum = 0;
  for (let year = from; year <= to; year += 1) sum += yields[(year - CROP_YEARS.start) * nCells + k];
  return sum / (to - from + 1);
}

/**
 * Every place's crop yield spread, and every scenario's crop maps.
 *
 * @param {Map<string, import('./explorer.js').Explorer>} explorers by climate
 *   model, with pattern artifacts and climatology loaded
 * @param {object} index data/crops_v1/index.json
 * @param {(model: string, crop: string) => Float32Array} coefficientsFor
 * @param {object} co2 data/scenario_co2_v1.json
 * @returns {Promise<{places: Map<string, object>, maps: Map<string, object>}>}
 *   places by location specifier, the `crops` entry of its summary file
 */
export async function summarizeCrops(explorers, index, coefficientsFor, co2) {
  const stride = index.coefficients;
  const slot = index.area_slot;
  const grid = SUMMARY_GRID;
  const end = SUMMARY_PERIODS.end;

  // Every cell growing any crop, and where each crop's cells sit among them.
  const union = [...new Set(Object.values(index.crops).flatMap((c) => c.cells))].sort((a, b) => a - b);
  const at = new Map(union.map((cell, i) => [cell, i]));
  const crops = Object.keys(CROPS).filter((crop) => index.crops[crop]?.models.length);
  const layout = {};
  for (const crop of crops) {
    const entry = index.crops[crop];
    const positions = entry.cells.map((cell) => at.get(cell));
    // Each place's cells, weighted by area and the place's share of the cell,
    // per crop model (each covers a slightly different area).
    const places = { global: entry.cells.map((_, k) => [k, 1]) };
    for (const [code, members] of Object.entries(entry.regions)) places[`regional:${code}`] = members;
    layout[crop] = { entry, positions, places };
  }

  // Weighted member lists per crop model, and which places have enough area.
  const weighted = new Map();
  const placesFor = (crop, model) => {
    const key = `${crop}|${model}`;
    if (!weighted.has(key)) {
      const coefficients = coefficientsFor(model, crop);
      const area = (k) => coefficients[k * stride + slot];
      const out = {};
      for (const [location, members] of Object.entries(layout[crop].places)) {
        const list = members.map(([k, share]) => [k, area(k) * share]).filter(([, w]) => w > 0);
        const total = list.reduce((s, [, w]) => s + w, 0);
        if (total >= MIN_REGION_AREA) out[location] = list;
      }
      weighted.set(key, out);
    }
    return weighted.get(key);
  };

  const inputsByModel = new Map();
  for (const [model, explorer] of explorers) {
    inputsByModel.set(model, await cropInputs(explorer, { grid, cells: union }));
  }

  const scenarios = explorers.values().next().value.scenarios;
  const places = new Map();
  const maps = new Map();
  const pairings = {};
  for (const scenario of scenarios) {
    const co2Values = co2Series(co2, scenario);
    if (!co2Values) continue;
    // Per crop: per place, each pairing's series; per cell, each pairing's end-of-century change.
    const series = {};
    const cellChanges = {};
    for (const crop of crops) {
      series[crop] = new Map();
      cellChanges[crop] = layout[crop].entry.cells.map(() => []);
    }
    for (const [climateModel, inputsFor] of inputsByModel) {
      const inputs = inputsFor(scenario);
      for (const crop of crops) {
        const { entry, positions } = layout[crop];
        const bases = cropBases(positions, inputs, union.length, co2Values);
        for (const cropModel of entry.models) {
          const coefficients = coefficientsFor(cropModel, crop);
          const yields = yieldsFromBases(coefficients, bases, positions.length, stride);
          for (const [location, members] of Object.entries(placesFor(crop, cropModel))) {
            const change = yieldChange(yields, positions.length, members);
            if (!change) continue;
            if (!series[crop].has(location)) series[crop].set(location, []);
            series[crop].get(location).push(Float32Array.from(change));
          }
          // Each cell's change by the end of the century, where it grows
          // enough: the two period means, without the series between.
          const nCells = positions.length;
          for (let k = 0; k < nCells; k += 1) {
            if (coefficients[k * stride + slot] < MIN_CELL_AREA) continue;
            const base = periodMean(yields, nCells, k, CROP_BASELINE);
            if (!(base > 0)) continue;
            cellChanges[crop][k].push((100 * (periodMean(yields, nCells, k, end) - base)) / base);
          }
          pairings[crop] ??= new Set();
          pairings[crop].add(`${climateModel}|${cropModel}`);
        }
      }
    }

    // The spread at every place.
    for (const crop of crops) {
      for (const [location, list] of series[crop]) {
        if (!places.has(location)) places.set(location, {});
        const entry = places.get(location);
        entry[crop] ??= { pairings: list.length, scenarios: {} };
        const ends = list.map((s) => {
          let sum = 0;
          for (let year = end.from; year <= end.to; year += 1) sum += s[year - CROP_YEARS.start];
          return [sum / (end.to - end.from + 1)];
        });
        entry[crop].scenarios[scenario] = {
          bands: quantiles(list, SUMMARY_QUANTILES).map((q) => Array.from(q, round1)),
          end: quantiles(ends, SUMMARY_QUANTILES).map((q) => round1(q[0])),
        };
      }
    }

    // The middle pairing's change at every cell.
    const file = {
      format: 'meteor-view-crop-map',
      schema_version: 1,
      scenario,
      period: end,
      baseline: CROP_BASELINE,
      lat: [grid.lat[0], grid.lat[1] - grid.lat[0], grid.lat.length],
      lon: [grid.lon[0], grid.lon[1] - grid.lon[0], grid.lon.length],
    };
    for (const crop of crops) {
      const field = new Array(grid.lat.length * grid.lon.length).fill(null);
      const { entry } = layout[crop];
      entry.cells.forEach((cell, k) => {
        const values = cellChanges[crop][k];
        if (!values.length) return;
        values.sort((a, b) => a - b);
        const mid = (values.length - 1) / 2;
        field[cell] = round1((values[Math.floor(mid)] + values[Math.ceil(mid)]) / 2);
      });
      file[crop] = field;
    }
    maps.set(scenario, file);
  }

  const counts = (crop) => {
    const climate = new Set([...pairings[crop]].map((p) => p.split('|')[0]));
    const crop_ = new Set([...pairings[crop]].map((p) => p.split('|')[1]));
    return { climate_models: climate.size, crop_models: [...crop_].sort() };
  };
  const shared = {
    years: [CROP_YEARS.start, CROP_YEARS.end],
    baseline: CROP_BASELINE,
    nitrogen: NITROGEN,
    variant: index.variant,
    models: Object.fromEntries(crops.map((crop) => [crop, counts(crop)])),
  };
  for (const [location, entry] of places) places.set(location, { ...shared, ...entry });
  for (const file of maps.values()) file.models = shared.models;
  return { places, maps };
}

/** "+3", "−2", "0": a signed whole number with a proper minus sign. */
function signed(value) {
  const text = Math.abs(value).toFixed(0);
  if (Number(text) === 0) return text;
  return `${value > 0 ? '+' : '−'}${text}`;
}

/** "A", "A and B", "A, B and C". */
function listOf(items) {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The simple view's reading of a crop chart: the middle pairing's change by
 * 2081-2100 under each scenario, the middle 90% of pairings, and the
 * conditions every number assumes.
 *
 * @param {object} options
 * @param {object} options.crops a summary file's `crops` entry
 * @param {string} options.crop
 * @param {string[]} options.scenarios
 * @param {(scenario: string) => string} options.label
 * @param {string} options.place the place's name, or 'global'
 */
export function cropSentence({ crops, crop, scenarios, label, place }) {
  const { from, to } = SUMMARY_PERIODS.end;
  const { baseline } = crops;
  const noun = `${CROPS[crop].label.toLowerCase()} yields`;
  const where = place === 'global' ? `global ${noun}` : `${noun} in ${place}`;
  const parts = scenarios.map((scenario) => {
    const [low, , middle, , high] = crops[crop].scenarios[scenario].end;
    return `${signed(middle)}% (${signed(low)} to ${signed(high)}%) under ${label(scenario)}`;
  });
  const { climate_models: climate, crop_models: cropModels } = crops.models[crop];
  const lead = `By ${from}–${to}, ${where} change by ${listOf(parts)}, compared with ${baseline.from}–${baseline.to}.`;
  return (
    `${lead.charAt(0).toUpperCase()}${lead.slice(1)} Figures in brackets span the middle 90% of ` +
    `${crops[crop].pairings} pairings of ${climate} climate models and ${cropModels.length} crop models. ` +
    `Rainfed, with the effect of CO₂ on crops, no adaptation of crop varieties, and ` +
    `${crops.nitrogen} kg of nitrogen per hectare everywhere.`
  );
}
