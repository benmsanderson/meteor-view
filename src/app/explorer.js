/**
 * Assembling the kernel into a complete run.
 *
 * `kernel.js` holds the validated maths; this holds the bookkeeping around it
 * — which trajectory drives what, over which years, and in which order. Two
 * pieces of that bookkeeping are not in the schema and were read out of
 * METEOR's own generation path:
 *
 * 1. **PCs are spun up before the window and then sliced** to it. METEOR
 *    generates from the pattern model's base year so the VAR spin-up
 *    resolves before the window opens, then slices on a January boundary. A
 *    client that instead starts the recursion at the window would open with
 *    PCs pinned at zero and ramping up out of nothing — plausible looking,
 *    and wrong for the first decades. This client spins up for as long as the
 *    bundle's VAR measurably needs (see `spinUpMonths`) rather than from
 *    1750, which is the same process in distribution at a quarter of the
 *    cost.
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
  spinUpMonths,
} from '../lib/kernel.js';
import { normalGenerator } from '../lib/stats.js';

const MONTHS = 12;

/** Output window. The `pr` transform parameters are fitted for these years. */
export const WINDOW = { start: 2015, end: 2100 };

/**
 * The reference periods change can be measured from.
 *
 * Pre-industrial is the IPCC convention, and what warming levels like 1.5 °C
 * are defined against. Recent history answers "how much more than now?" —
 * and removes the part of the spread between models that each inherited from
 * its own historical warming, which is worth saying wherever it is shown.
 *
 * Both are means of the *forced* response over the period, so a baseline is a
 * property of the model and the place, not of any one realization.
 */
export const BASELINES = {
  pi: { label: '1850–1900', from: 1850, to: 1900 },
  recent: { label: '2005–2024', from: 2005, to: 2024 },
};

/**
 * Which scenario a baseline is taken from.
 *
 * One shared scenario, so every scenario shifts by the same amount and the
 * difference between any two is untouched by the choice of baseline. History
 * is identical in all of them to 2014; 2015-2024 differs by at most 0.04 °C in
 * the global mean. CMIP7 Medium, falling back to SSP2-4.5 in a build without
 * the CMIP7 scenarios.
 */
export const BASELINE_SCENARIOS = ['cmip7-medium', 'ssp245'];

/** Mean of an annual series, starting at `yearStart`, over `[from, to]`. */
function periodMean(series, yearStart, from, to) {
  let sum = 0;
  for (let year = from; year <= to; year += 1) sum += series[year - yearStart];
  return sum / (to - from + 1);
}

/** The model the site shipped with, and what a link without `m=` means. */
export const DEFAULT_MODEL = 'NorESM2-MM';

/**
 * The CMIP6 models with artifacts in `data/`, from its manifest.
 *
 * A missing or unreadable manifest falls back to the default model alone, so a
 * checkout that predates it still loads.
 *
 * @param {string} base directory the data files are served from
 * @returns {Promise<string[]>}
 */
export async function availableModels(base = 'data/') {
  try {
    const response = await fetch(`${base}models_v1.json`);
    if (!response.ok) return [DEFAULT_MODEL];
    const { models } = await response.json();
    return Array.isArray(models) && models.length ? models : [DEFAULT_MODEL];
  } catch {
    return [DEFAULT_MODEL];
  }
}

/** Filename of one model's artifact of a given kind. */
export function artifactName(model, variable, kind) {
  return `meteor_${model}_${variable}_${kind}_v1.nc`;
}

/**
 * Everything one run needs, loaded once.
 *
 * Both bundles are always loaded: a precipitation run still needs the `tas`
 * bundle for the warming-pathway denominator.
 */
export class Explorer {
  /**
   * @param {{tas: import('../lib/bundle.js').Bundle, pr: import('../lib/bundle.js').Bundle}} bundles
   * @param {string} [base] where the on-demand artifacts are served from
   */
  constructor(bundles, base = 'data/') {
    this.bundles = bundles;
    this.base = base;
    /** Which model the bundles came from; every on-demand artifact must match. */
    this.model = bundles.tas.attrs.cmip6_model;
    this.locations = bundles.tas.locations;
    this.scenarios = bundles.tas.scenarios;
    /** Lazily loaded 2 MB pattern artifacts, by variable. */
    this.patternArtifacts = new Map();
    this.regionOutlines = null;
    this.scenarioEmissions = null;
    this.coastlineRings = null;
    this.prClimatology = null;
    /** Baseline offsets and fields, which never change for a loaded model. */
    this.baselineCache = new Map();
  }

  /** The scenario baselines are taken from. */
  get baselineScenario() {
    return BASELINE_SCENARIOS.find((name) => this.scenarios.includes(name)) ?? this.scenarios[0];
  }

  /**
   * The forced response at a listed location, averaged over a baseline period.
   *
   * Subtracted from a run to express it as change from that period.
   *
   * @param {object} options
   * @param {'tas'|'pr'} options.variable
   * @param {string} options.location
   * @param {keyof BASELINES} options.baseline
   * @returns {number} in the bundle's units
   */
  baselineOffset({ variable, location, baseline }) {
    const key = `offset:${variable}:${location}:${baseline}`;
    if (!this.baselineCache.has(key)) {
      const bundle = this.bundles[variable];
      const forced = forcedResponse(bundle, location, bundle.forcing(this.baselineScenario));
      const { from, to } = BASELINES[baseline];
      this.baselineCache.set(key, periodMean(forced, bundle.forcingYearStart, from, to));
    }
    return this.baselineCache.get(key);
  }

  /**
   * What to add to a run, before any baseline is taken off, to make it an
   * absolute value in display units.
   *
   * A temperature run is an anomaly: the harmonics and noise about zero, plus
   * the forced response since the unforced state. The seasonal model's
   * intercept is the location's absolute level in that unforced state, so the
   * two together are the absolute temperature — checked against the ESMs' own
   * output, where the 2015-2034 and 2081-2100 monthly climatologies of NEN and
   * NEU agree to 0.2-1.1 °C RMS for CanESM5 and MIROC6. Precipitation runs
   * are absolute already.
   *
   * @returns {number} °C for `tas`; 0 for `pr`
   */
  absoluteOffset({ variable, location }) {
    if (variable !== 'tas') return 0;
    const bundle = this.bundles.tas;
    return bundle.get('seasonal_intercept')[bundle.locationIndex(location)] - 273.15;
  }

  /** As {@link baselineOffset}, for a drawn region. Not cached: masks vary. */
  async customBaselineOffset({ variable, mask, baseline }) {
    const forced = await this.customForcedFull({
      variable,
      scenario: this.baselineScenario,
      mask,
    });
    const { from, to } = BASELINES[baseline];
    return periodMean(forced, this.bundles[variable].forcingYearStart, from, to);
  }

  /**
   * The forced-response map averaged over a baseline period, and the map for
   * the first year of the precipitation climatology.
   *
   * The average of maps is the map of the averaged PCs, since the map is
   * linear in them, so this costs one convolution and one projection rather
   * than one per year.
   *
   * @returns {Promise<{mean: Float64Array, at2015: Float64Array}>}
   */
  async baselineMap({ variable, baseline }) {
    const key = `map:${variable}:${baseline}`;
    if (!this.baselineCache.has(key)) {
      const artifact = await this.patterns(variable);
      const { patternKernel, stepResponsePcs } = await import('../lib/pattern.js');
      const bundle = this.bundles[variable];
      const { pcs } = stepResponsePcs(
        patternKernel(artifact),
        bundle.forcing(this.baselineScenario)
      );
      const stride = artifact.dims.exp * artifact.nModes;
      const rows = (from, to) => {
        const mean = new Float64Array(stride);
        for (let year = from; year <= to; year += 1) {
          const offset = (year - bundle.forcingYearStart) * stride;
          for (let i = 0; i < stride; i += 1) mean[i] += pcs[offset + i];
        }
        return mean.map((v) => v / (to - from + 1));
      };
      const { from, to } = BASELINES[baseline];
      this.baselineCache.set(key, {
        mean: artifact.map(rows(from, to)),
        at2015: artifact.map(rows(2015, 2015)),
      });
    }
    return this.baselineCache.get(key);
  }

  /**
   * Load the bundles over HTTP.
   *
   * @param {string} base directory the data files are served from
   * @param {string} [model] CMIP6 model whose bundles to load
   * @returns {Promise<Explorer>}
   */
  static async load(base = 'data/', model = DEFAULT_MODEL) {
    const { Bundle } = await import('../lib/bundle.js');
    const fetchBundle = async (variable) => {
      const url = `${base}${artifactName(model, variable, 'bundle')}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`could not load ${url}: ${response.status}`);
      return new Bundle(await response.arrayBuffer());
    };
    const [tas, pr] = await Promise.all([fetchBundle('tas'), fetchBundle('pr')]);
    return new Explorer({ tas, pr }, base);
  }

  /** Years of the full forcing axis a bundle carries. */
  years(variable = 'tas') {
    const bundle = this.bundles[variable];
    return Array.from(
      { length: bundle.dims.year },
      (_, i) => bundle.forcingYearStart + i
    );
  }

  /**
   * Load the pattern artifact for a variable, once, on demand.
   *
   * 2 MB against the bundle's 81 KB, so it is fetched only when a visitor asks
   * for a map or a region the bundle was not built for — never on first load.
   */
  async patterns(variable) {
    if (!this.patternArtifacts.has(variable)) {
      const { PatternArtifact } = await import('../lib/pattern.js');
      const url = `${this.base}${artifactName(this.model, variable, 'pattern')}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`could not load ${url}: ${response.status}`);
      this.patternArtifacts.set(variable, new PatternArtifact(await response.arrayBuffer()));
    }
    return this.patternArtifacts.get(variable);
  }

  /**
   * Annual emissions for the scenario-context figure.
   *
   * Three species, global, for every scenario the bundles carry. A figure's
   * worth of data rather than an inventory — see `data/README.md` for why the
   * CMIP7 emissions behind it are not offered as a file.
   */
  async emissions() {
    if (!this.scenarioEmissions) {
      const response = await fetch(`${this.base}scenario_emissions_v1.json`);
      if (!response.ok) throw new Error('could not load scenario emissions');
      this.scenarioEmissions = await response.json();
    }
    return this.scenarioEmissions;
  }

  /** AR6 outlines, once, on demand. */
  async regions() {
    if (!this.regionOutlines) {
      const response = await fetch(`${this.base}ar6_regions_v1.json`);
      if (!response.ok) throw new Error('could not load region outlines');
      this.regionOutlines = (await response.json()).regions;
    }
    return this.regionOutlines;
  }

  /** Coastlines, once, on demand. The geography a reader orients by. */
  async coastlines() {
    if (!this.coastlineRings) {
      const response = await fetch(`${this.base}coastlines_v1.json`);
      if (!response.ok) throw new Error('could not load coastlines');
      this.coastlineRings = (await response.json()).rings;
    }
    return this.coastlineRings;
  }

  /**
   * Gridded precipitation climatology, the denominator for percent change.
   *
   * Only `pr` has one, and only the map needs it: 220 KB fetched beside the
   * pattern artifact rather than on load.
   */
  async climatology() {
    if (!this.prClimatology) {
      const { Artifact } = await import('../lib/bundle.js');
      const url = `${this.base}${artifactName(this.model, 'pr', 'climatology')}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`could not load ${url}`);
      const artifact = new Artifact(await response.arrayBuffer());
      this.prClimatology = artifact.array('pr_climatology');
    }
    return this.prClimatology;
  }

  /**
   * The forced response on the grid, for one scenario and year.
   *
   * @returns {Promise<{field: Float64Array, lat: Float64Array, lon: Float64Array}>}
   */
  async forcedMap({ variable, scenario, year, pathway = null }) {
    const artifact = await this.patterns(variable);
    const { patternKernel, stepResponsePcs } = await import('../lib/pattern.js');
    const bundle = this.bundles[variable];

    const { pcs, nTimes } = stepResponsePcs(
      patternKernel(artifact),
      bundle.forcing(scenario)
    );
    const index = year - bundle.forcingYearStart;
    if (index < 0 || index >= nTimes) throw new Error(`year ${year} is outside the forcing`);

    const stride = artifact.dims.exp * artifact.nModes;
    let field = artifact.map(pcs.subarray(index * stride, (index + 1) * stride));

    // A drawn pathway rescales the whole field by the same factor the global
    // response is rescaled by, which is what METEOR's own scaling does: the
    // pattern is fixed and only its amplitude moves.
    if (pathway) {
      // The same ratio scale_to_warming_pathway applies: the pattern is fixed
      // and only its amplitude moves, so the whole field scales together.
      const globalTas = this.globalWarming(scenario);
      const denominator = globalTas[index] - globalTas[0];
      const factor = denominator !== 0 ? (pathway[index] - pathway[0]) / denominator : 1;
      field = Float64Array.from(field, (v) => v * factor);
    }

    return { field, lat: artifact.lat, lon: artifact.lon };
  }

  /**
   * Make a location the bundle never carried, by projecting the artifacts onto
   * an arbitrary mask.
   *
   * The forced term needs only the 2 MB pattern artifact. Internal variability
   * needs the EOF maps from the 11 MB noise artifact, which is not loaded here
   * — so this returns the forced response alone, and says so.
   */
  async customForcedResponse({ variable, scenario, mask, pathway = null }) {
    let annual = await this.customForcedFull({ variable, scenario, mask });
    if (pathway) {
      annual = scaleToWarmingPathway(annual, this.globalWarming(scenario), pathway);
    }
    const bundle = this.bundles[variable];
    const start = WINDOW.start - bundle.forcingYearStart;
    const nYears = WINDOW.end - WINDOW.start + 1;
    return {
      years: this.windowYears(),
      forced: annual.slice(start, start + nYears),
    };
  }

  /** The forced response over a mask, annual, over the full forcing axis. */
  async customForcedFull({ variable, scenario, mask }) {
    const artifact = await this.patterns(variable);
    const { patternKernel, stepResponsePcs } = await import('../lib/pattern.js');
    const bundle = this.bundles[variable];

    const weights = artifact.areaWeights(mask);
    const projection = artifact.project(weights);
    const { pcs, nTimes } = stepResponsePcs(
      patternKernel(artifact),
      bundle.forcing(scenario)
    );

    const nExp = artifact.dims.exp;
    const nModes = artifact.nModes;
    const annual = new Float64Array(nTimes);
    for (let t = 0; t < nTimes; t += 1) {
      let acc = 0;
      for (let e = 0; e < nExp; e += 1) {
        for (let m = 0; m < nModes; m += 1) {
          acc += pcs[(t * nExp + e) * nModes + m] * projection[e * nModes + m];
        }
      }
      annual[t] = acc;
    }
    return annual;
  }

  /**
   * Total effective radiative forcing for a scenario, over the full year axis.
   *
   * The sum over experiments of what the bundle carries — which is what
   * CICERO-SCM produced from that scenario's emissions, and what the emulator
   * is actually driven by. Absent experiments are stored as NaN and skipped.
   *
   * @param {string} scenario
   * @param {'tas'|'pr'} [variable] either bundle carries the same forcing
   * @returns {{years: number[], forcing: Float64Array}}
   */
  totalForcing(scenario, variable = 'tas') {
    const bundle = this.bundles[variable];
    const byExperiment = bundle.forcing(scenario);
    const years = this.years(variable);

    const total = new Float64Array(years.length);
    for (const series of byExperiment.values()) {
      for (let i = 0; i < total.length; i += 1) {
        if (Number.isFinite(series[i])) total[i] += series[i];
      }
    }
    return { years, forcing: total };
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
  // Start the recursion only as far before the window as the VAR needs. The
  // spin-up is a whole number of years, so the harmonics keep their phase.
  const spinUp = Math.min(startMonth, spinUpMonths(bundle));
  const from = startMonth - spinUp;
  const spunUp = generateEnsemble({
    bundle,
    location,
    tGlob: tGlobFull.subarray(from, endMonth),
    forcedMonthly: forcedMonthlyFull.subarray(from, endMonth),
    nRealizations,
    normal,
    transform: false,
    // METEOR's timeseries path asks the noise generator for noise only, which
    // drops the intercept and the t_glob term from the seasonal cycle. The
    // level and the trend come from the forced response instead; keeping them
    // here as well would double-count both.
    anomaly: true,
  });

  let windowed = spunUp.map((series) => series.slice(spinUp));

  if (bundle.hasTransform) {
    // Steps 5 and 6, on the window alone.
    windowed = applyTransform(bundle, location, addBaseline(bundle, location, windowed));
  }
  return windowed;
}
