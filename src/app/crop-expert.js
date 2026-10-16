/**
 * The expert view's crop yields: one climate model at a time, and one crop
 * model or all of them, computed in the browser.
 *
 * The simple view's numbers are precomputed across every pairing of climate
 * and crop model (src/app/crop-summary.js). Here the reader picks the pairing,
 * and the nitrogen applied, so the emulators run on demand: the climate
 * model's pattern artifacts give its change at the crop's cells
 * (src/lib/crops.js, cropInputs), once per climate model and crop, and every
 * crop model, scenario and nitrogen level after that is a short polynomial.
 * The multi-model mean stays precomputed, at the default nitrogen.
 */

import { dataUrl } from '../lib/data-url.js';
import {
  CROP_YEARS,
  cellChanges,
  co2Series,
  cropBases,
  cropFile,
  cropInputs,
  parseCoefficients,
  placeMembers,
  yieldChange,
  yieldsFromBases,
} from '../lib/crops.js';
import { cropExpertFile } from './crop-summary.js';
import { SUMMARY_GRID } from './summary.js';

/** The crop model menu's choice of every crop model at once. */
export const ALL_CROP_MODELS = 'all';

/** The years a crop series covers, as the chart's x axis. */
export const CROP_SERIES_YEARS = Array.from(
  { length: CROP_YEARS.end - CROP_YEARS.start + 1 },
  (_, i) => CROP_YEARS.start + i
);

/** Fetch once, forget a failure so it can be retried. */
function cached(map, key, load) {
  if (!map.has(key)) {
    const pending = load();
    pending.catch(() => map.delete(key));
    map.set(key, pending);
  }
  return map.get(key);
}

/**
 * @param {object} options
 * @param {string} options.base the data directory's URL
 * @param {(model: string) => Promise<import('./explorer.js').Explorer>} options.explorerFor
 */
export function createCropService({ base, explorerFor }) {
  const files = new Map();
  const coefficients = new Map();
  const inputs = new Map();

  const json = (name, required = true) =>
    cached(files, name, async () => {
      const response = await fetch(dataUrl(base, name));
      if (!response.ok) {
        if (required) throw new Error(`could not load ${name}`);
        return null;
      }
      return response.json();
    });

  const index = () => json('crops_v1/index.json');
  const co2File = () => json('scenario_co2_v1.json');

  const coefficientsFor = async (model, crop) => {
    const { variant } = await index();
    return cached(coefficients, `${model}|${crop}`, async () => {
      const response = await fetch(dataUrl(base, cropFile(model, crop, variant)));
      if (!response.ok) throw new Error(`could not load the ${model} emulator for ${crop}`);
      return parseCoefficients(await response.arrayBuffer());
    });
  };

  // A climate model's change at the crop's cells, per scenario.
  const inputsFor = async (climateModel, crop) => {
    const entry = (await index()).crops[crop];
    return cached(inputs, `${climateModel}|${crop}`, async () => {
      const explorer = await explorerFor(climateModel);
      return cropInputs(explorer, { grid: SUMMARY_GRID, cells: entry.cells });
    });
  };

  /**
   * Each crop model's yield at the crop's cells for one climate model,
   * scenario and nitrogen level, year-major.
   */
  async function yieldsFor({ climateModel, crop, cropModels, scenario, nitrogen }) {
    const [file, co2] = [await index(), await co2File()];
    const entry = file.crops[crop];
    const co2Values = co2Series(co2, scenario);
    if (!co2Values) throw new Error(`there is no CO₂ concentration for ${scenario}`);
    const inputsOf = await inputsFor(climateModel, crop);
    const nCells = entry.cells.length;
    const positions = entry.cells.map((_, k) => k);
    const bases = cropBases(positions, inputsOf(scenario), nCells, co2Values, nitrogen);
    const loaded = await Promise.all(cropModels.map((m) => coefficientsFor(m, crop)));
    return {
      entry,
      nCells,
      stride: file.coefficients,
      slot: file.area_slot,
      models: cropModels.map((model, i) => ({
        model,
        coefficients: loaded[i],
        yields: yieldsFromBases(loaded[i], bases, nCells, file.coefficients),
      })),
    };
  }

  return {
    index,

    /** The crop models that have an emulator for a crop. */
    async cropModels(crop) {
      return (await index()).crops[crop]?.models ?? [];
    },

    /**
     * A place's yield change from 1980-2010, per crop model, under one
     * climate model: the crop models that grow enough of the crop there.
     *
     * @returns {Promise<Array<{model: string, change: Float64Array}>>}
     */
    async placeSeries({ climateModel, crop, cropModels, scenario, location, nitrogen }) {
      const { entry, nCells, stride, slot, models } = await yieldsFor({
        climateModel,
        crop,
        cropModels,
        scenario,
        nitrogen,
      });
      const out = [];
      for (const { model, coefficients: k, yields } of models) {
        const members = placeMembers(entry, k, stride, slot, location);
        const change = members && yieldChange(yields, nCells, members);
        if (change) out.push({ model, change });
      }
      return out;
    },

    /**
     * Each cell's yield change in one year from 1980-2010, on the site's
     * 2-degree grid: the one crop model's, or the middle of several. NaN
     * where the crop is not grown enough to say.
     */
    async cellField({ climateModel, crop, cropModels, scenario, year, nitrogen }) {
      const { entry, nCells, stride, slot, models } = await yieldsFor({
        climateModel,
        crop,
        cropModels,
        scenario,
        nitrogen,
      });
      const period = { from: year, to: year };
      const changes = models.map(({ coefficients: k, yields }) => cellChanges(yields, k, stride, slot, nCells, period));
      const field = new Float64Array(SUMMARY_GRID.lat.length * SUMMARY_GRID.lon.length).fill(NaN);
      const values = [];
      for (let c = 0; c < nCells; c += 1) {
        values.length = 0;
        for (const change of changes) if (Number.isFinite(change[c])) values.push(change[c]);
        if (!values.length) continue;
        values.sort((a, b) => a - b);
        const mid = (values.length - 1) / 2;
        field[entry.cells[c]] = (values[Math.floor(mid)] + values[Math.ceil(mid)]) / 2;
      }
      return { field, lat: SUMMARY_GRID.lat, lon: SUMMARY_GRID.lon };
    },

    /**
     * A place's precomputed multi-model mean per crop model: each crop
     * model's spread across climate models, or null where there is none.
     */
    expertFile(location) {
      return json(cropExpertFile(location), false);
    },
  };
}
