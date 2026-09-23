/**
 * Assembling the kernel into a complete run.
 *
 * `kernel.js` holds the validated maths; this holds the bookkeeping around it
 * — which trajectory drives what, over which years, and in which order. Two
 * pieces of that bookkeeping are not in the schema and were read out of
 * METEOR's own generation path:
 *
 * 1. **PCs are simulated over the full trajectory and then sliced** to the
 *    output window. METEOR generates from the pattern model's base year so the
 *    VAR spin-up resolves before the window opens, then slices on a January
 *    boundary. A client that instead starts the recursion at the window would
 *    open with PCs pinned at zero and ramping up out of nothing — plausible
 *    looking, and wrong for the first decades.
 *
 * 2. **`t_glob` is the global mean of the variable's own forced response**, not
 *    of temperature. The noise model for a variable is trained against that
 *    variable's own global trajectory, so generation must match. This is the
 *    opposite of the warming-pathway denominator, which is always temperature
 *    whatever the variable — the two must not be conflated.
 */

import {
  addBaseline,
  annualToMonthly,
  applyTransform,
  forcedResponse,
  generateEnsemble,
  scaleToWarmingPathway,
} from '../lib/kernel.js';
import { normalGenerator } from '../lib/stats.js';

const MONTHS = 12;

/** Output window. The `pr` transform parameters are fitted for these years. */
export const WINDOW = { start: 2015, end: 2100 };

/**
 * Everything one run needs, loaded once.
 *
 * Both bundles are always loaded: a precipitation run still needs the `tas`
 * bundle for the warming-pathway denominator.
 */
export class Explorer {
  /** @param {{tas: import('../lib/bundle.js').Bundle, pr: import('../lib/bundle.js').Bundle}} bundles */
  constructor(bundles) {
    this.bundles = bundles;
    this.locations = bundles.tas.locations;
    this.scenarios = bundles.tas.scenarios;
  }

  /**
   * Load the bundles over HTTP.
   *
   * @param {string} base directory the data files are served from
   * @returns {Promise<Explorer>}
   */
  static async load(base = 'data/') {
    const { Bundle } = await import('../lib/bundle.js');
    const fetchBundle = async (variable) => {
      const url = `${base}meteor_NorESM2-MM_${variable}_bundle_v1.nc`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`could not load ${url}: ${response.status}`);
      return new Bundle(await response.arrayBuffer());
    };
    const [tas, pr] = await Promise.all([fetchBundle('tas'), fetchBundle('pr')]);
    return new Explorer({ tas, pr });
  }

  /** Years of the full forcing axis a bundle carries. */
  years(variable = 'tas') {
    const bundle = this.bundles[variable];
    return Array.from(
      { length: bundle.dims.year },
      (_, i) => bundle.forcingYearStart + i
    );
  }

  /** Years of the output window. */
  windowYears() {
    return Array.from(
      { length: WINDOW.end - WINDOW.start + 1 },
      (_, i) => WINDOW.start + i
    );
  }

  /**
   * The predicted global temperature response for a scenario, over the full
   * forcing axis. This is the warming-pathway denominator, and what a drawn
   * pathway is drawn against.
   */
  globalWarming(scenario) {
    const tas = this.bundles.tas;
    return forcedResponse(tas, 'global', tas.forcing(scenario));
  }

  /**
   * Generate an ensemble.
   *
   * @param {object} options
   * @param {'tas'|'pr'} options.variable
   * @param {string} options.location location specifier
   * @param {string} options.scenario a bundled scenario name
   * @param {number} options.nRealizations
   * @param {number} options.seed
   * @param {ArrayLike<number>|null} [options.pathway] desired global warming
   *   over the full year axis; when given, the forced response is rescaled to
   *   follow it instead of the scenario's own warming
   * @returns {{years: number[], series: Float64Array[], forced: Float64Array}}
   */
  run({ variable, location, scenario, nRealizations, seed, pathway = null }) {
    const bundle = this.bundles[variable];
    const forcing = bundle.forcing(scenario);

    // Step 1, over the full forcing axis rather than the window, so that both
    // the spin-up and the pathway rescaling see the whole trajectory.
    let forcedFull = forcedResponse(bundle, location, forcing);
    let globalFull = forcedResponse(bundle, 'global', forcing);

    // Step 2. The denominator is the temperature response whatever the
    // variable being generated, which is why the tas bundle is always loaded.
    if (pathway) {
      const globalTas = this.globalWarming(scenario);
      forcedFull = scaleToWarmingPathway(forcedFull, globalTas, pathway);
      globalFull = scaleToWarmingPathway(globalFull, globalTas, pathway);
    }

    // Step 3.
    const monthlyForced = annualToMonthly(forcedFull);
    const monthlyGlobal = annualToMonthly(globalFull);

    const startMonth = (WINDOW.start - bundle.forcingYearStart) * MONTHS;
    const nMonths = (WINDOW.end - WINDOW.start + 1) * MONTHS;
    const endMonth = startMonth + nMonths;

    // Step 4, spun up over the full trajectory and sliced to the window on a
    // January boundary, as METEOR does.
    const fullSeries = generateEnsembleWindowed({
      bundle,
      location,
      tGlobFull: monthlyGlobal,
      forcedMonthlyFull: monthlyForced,
      startMonth,
      endMonth,
      nRealizations,
      normal: normalGenerator(seed),
    });

    return {
      years: this.windowYears(),
      series: fullSeries,
      forced: forcedFull.slice(
        WINDOW.start - bundle.forcingYearStart,
        WINDOW.end - bundle.forcingYearStart + 1
      ),
    };
  }
}

/**
 * Run the kernel over the full trajectory, return only the window.
 *
 * The VAR recursion and the seasonal design matrix both run from the base
 * year; only then is the result sliced. Because the window starts in January
 * and the slice is a whole number of years, the harmonic phase is unaffected
 * by the slice — which is exactly why METEOR insists the start month be a
 * multiple of twelve.
 *
 * For `pr` the transform must see the windowed values, not the full
 * trajectory: its gamma parameters are fitted for 2015-2100, and the Gaussian
 * side is fitted to the ensemble being transformed. So the slice happens
 * before steps 5 and 6, not after.
 */
function generateEnsembleWindowed({
  bundle,
  location,
  tGlobFull,
  forcedMonthlyFull,
  startMonth,
  endMonth,
  nRealizations,
  normal,
}) {
  const spunUp = generateEnsemble({
    bundle,
    location,
    tGlob: tGlobFull,
    forcedMonthly: forcedMonthlyFull,
    nRealizations,
    normal,
    transform: false,
    // METEOR's timeseries path asks the noise generator for noise only, which
    // drops the intercept and the t_glob term from the seasonal cycle. The
    // level and the trend come from the forced response instead; keeping them
    // here as well would double-count both.
    anomaly: true,
  });

  let windowed = spunUp.map((series) => series.slice(startMonth, endMonth));

  if (bundle.hasTransform) {
    // Steps 5 and 6, on the window alone.
    windowed = applyTransform(bundle, location, addBaseline(bundle, location, windowed));
  }
  return windowed;
}
