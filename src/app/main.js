/**
 * Wiring: controls to kernel to canvas.
 *
 * Ensemble generation runs in a small pool of Web Workers (`runner.js`):
 * about 10 ms per realization, so a six-scenario comparison at 100
 * realizations would otherwise freeze the page for seconds. Everything else —
 * maps, the context figure, drawing — is quick and stays on the main thread.
 */

import { annualMeans, drawFanChart, drawScenarioContext, drawSeasonal } from './chart.js';
import { chartToPng, download, downloadText, filenameStem, toCsv } from './export.js';
import {
  boxFromDrag,
  clampView,
  classedScale,
  defaultView,
  drawColourBar,
  drawMap,
  projection,
  regionAt,
  regrid,
  sameGrid,
  toLatLon,
  valueAt,
} from './map.js';
import { BASELINES, Explorer, WINDOW, availableModels } from './explorer.js';
import { EnsembleRunner } from './runner.js';
import { assignModelColours, modelColour } from './models.js';
import { placeLabel } from './places.js';
import {
  groupScenarios,
  scenarioColour,
  scenarioFamily,
  scenarioLabel,
  scenarioShortLabel,
  selectedColour,
  sortScenarios,
} from './scenarios.js';
import {
  DEFAULT_SEED,
  MAX_MODELS,
  MAX_SCENARIOS,
  defaultCompare,
  fromQuery,
  toQuery,
  toUrl,
} from './state.js';

/** Seconds per year, for the precipitation unit conversion. */
const SECONDS_PER_DAY = 86400;

const VARIABLES = {
  tas: {
    label: 'Temperature',
    // METEOR's timeseries output is an anomaly, not an absolute temperature;
    // the page expresses it as change from the chosen baseline.
    yLabel: 'Temperature change (°C)',
    baselined: true,
    convert: (v) => v,
    format: (v) => `${v.toFixed(1)}°`,
  },
  pr: {
    label: 'Precipitation',
    // The bundle works in kg m-2 s-1; mm/day is what anyone reading this wants.
    yLabel: 'Precipitation (mm/day)',
    // Absolute, and through a nonlinear transform: there is no clean level in
    // the reference period to subtract, so the timeseries stays absolute.
    baselined: false,
    convert: (v) => v * SECONDS_PER_DAY,
    format: (v) => v.toFixed(1),
  },
};

const elements = {
  controls: document.getElementById('controls'),
  compareBy: document.getElementById('compare-by'),
  modelPicker: document.getElementById('model-picker'),
  modelList: document.getElementById('model-list'),
  modelSummary: document.getElementById('model-summary'),
  variable: document.getElementById('variable'),
  location: document.getElementById('location'),
  scenarioPicker: document.getElementById('scenario-picker'),
  scenarioList: document.getElementById('scenario-list'),
  scenarioSummary: document.getElementById('scenario-summary'),
  chartLegend: document.getElementById('chart-legend'),
  seasonalLegend: document.getElementById('seasonal-legend'),
  realizations: document.getElementById('realizations'),
  baseline: document.getElementById('baseline'),
  chart: document.getElementById('chart'),
  copyLink: document.getElementById('copy-link'),
  downloadCsv: document.getElementById('download-csv'),
  downloadPng: document.getElementById('download-png'),
  resample: document.getElementById('resample'),
  chartTitle: document.getElementById('chart-title'),
  seasonal: document.getElementById('seasonal'),
  context: document.getElementById('context'),
  contextSeries: document.getElementById('context-series'),
  contextTitle: document.getElementById('context-title'),
  map: document.getElementById('map'),
  mapB: document.getElementById('map-b'),
  mapDiff: document.getElementById('map-diff'),
  maps: document.getElementById('maps'),
  captionA: document.getElementById('caption-a'),
  captionB: document.getElementById('caption-b'),
  captionDiff: document.getElementById('caption-diff'),
  colourbarB: document.getElementById('colourbar-b'),
  colourbarDiff: document.getElementById('colourbar-diff'),
  mapReadout: document.getElementById('map-readout'),
  mapCompare: document.getElementById('map-compare'),
  compareA: document.getElementById('compare-a'),
  compareB: document.getElementById('compare-b'),
  mapModes: document.getElementById('map-modes'),
  modeSelect: document.getElementById('mode-select'),
  modePan: document.getElementById('mode-pan'),
  resetView: document.getElementById('reset-view'),
  mapPanel: document.getElementById('map').closest('.panel'),
  mapTitle: document.getElementById('map-title'),
  mapYear: document.getElementById('map-year'),
  mapYearValue: document.getElementById('map-year-value'),
  mapHint: document.getElementById('map-hint'),
  colourbar: document.getElementById('colourbar'),
  loadMap: document.getElementById('load-map'),
  clearBox: document.getElementById('clear-box'),
  status: document.getElementById('status'),
  provenance: document.getElementById('provenance'),
};

/**
 * The first selected model's explorer: the one that answers for everything
 * that does not depend on the model — places, scenarios, emissions, outlines.
 * @type {Explorer}
 */
let explorer;
/** One explorer per model asked for, loaded once. */
const explorers = new Map();
/** Every model the site carries, from the manifest. */
let availableModelList = [];
/** Whether a view compares scenarios under one model, or models under one scenario. */
let compareBy = 'scenarios';
/** The selected models, in manifest order. Never empty. */
let models = ['NorESM2-MM'];
/** Where the data files are served from. */
let dataBase;
/** Generates ensembles off the main thread. */
let runner;
/** Guards against an older, slower run landing after a newer one. */
let runRequest = 0;
let lastRun = null;
/** Part of the shareable state: the same seed redraws the same realizations. */
let seed = DEFAULT_SEED;
/** AR6 outlines, once loaded. */
let outlines = [];
/** The last map drawn, kept so a resize can redraw without recomputing. */
let lastMap = null;
/** A user-drawn region, or null while a bundled location is selected. */
let customBox = null;
/** Scenario emissions for the context panel, once loaded. */
let scenarioEmissions = null;
/** Coastlines, once loaded. */
let coastlines = [];
/** Which gesture the plain drag performs; shift does the other. */
let mapMode = 'pan';
/** The selected scenarios, in menu order. Never empty. */
let selection = ['ssp245'];
/** The two scenarios or models the maps compare, or null with only one. */
let compare = null;
/** What part of the world the map shows. */
let mapView = defaultView();

function setStatus(message, state = '') {
  elements.status.textContent = message;
  elements.status.dataset.state = state;
}

/** Populate the place and scenario menus from the bundle itself. */
function populateControls() {
  const groups = {
    'Global': [],
    'AR6 regions': [],
    'Cities': [],
  };
  for (const spec of explorer.locations) {
    if (spec === 'global') groups['Global'].push(spec);
    else if (spec.startsWith('regional:')) groups['AR6 regions'].push(spec);
    else groups['Cities'].push(spec);
  }

  elements.location.replaceChildren();
  for (const [name, specs] of Object.entries(groups)) {
    if (specs.length === 0) continue;
    const group = document.createElement('optgroup');
    group.label = name;
    for (const spec of specs) {
      const option = document.createElement('option');
      option.value = spec;
      option.textContent = placeLabel(spec);
      group.append(option);
    }
    elements.location.append(group);
  }

  renderPickers();
}

/**
 * The model and scenario menus, as checkboxes for whichever is being compared
 * and radio buttons for the other: only one of the two can be many at once.
 */
function renderPickers() {
  const many = (dimension) => compareBy === dimension;
  // Grouped by generation, because the two are not interchangeable and the
  // menu is the only place that can say so before a comparison is made.
  fillPicker(elements.scenarioList, {
    name: 'scenario',
    groups: groupScenarios(explorer.scenarios),
    label: scenarioLabel,
    colour: (name) => (many('scenarios') ? selectedColour(name) : null),
    multiple: many('scenarios'),
    cap: MAX_SCENARIOS,
  });
  fillPicker(elements.modelList, {
    name: 'model',
    groups: [{ family: 'CMIP6 models', names: availableModelList }],
    label: (name) => name,
    colour: null,
    multiple: many('models'),
    cap: MAX_MODELS,
  });
}

/** Fill one dropdown list with checkboxes or radio buttons. */
function fillPicker(list, { name, groups, label, colour, multiple, cap }) {
  list.replaceChildren();
  for (const { family, names } of groups) {
    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = family;
    fieldset.append(legend);
    for (const item of names) {
      const row = document.createElement('label');
      const input = document.createElement('input');
      input.type = multiple ? 'checkbox' : 'radio';
      input.value = item;
      input.name = name;
      const swatch = document.createElement('span');
      swatch.className = 'multiselect__swatch';
      swatch.dataset.item = item;
      const hue = colour?.(item);
      if (hue) swatch.style.background = hue;
      row.append(input, swatch, label(item));
      fieldset.append(row);
    }
    list.append(fieldset);
  }
  if (multiple) {
    const note = document.createElement('p');
    note.className = 'multiselect__note';
    note.textContent = `Up to ${cap} at once.`;
    list.append(note);
  }
}

/** Every input in one picker. */
function pickerInputs(list, name) {
  return [...list.querySelectorAll(`input[name="${name}"]`)];
}

/** The items being compared: scenarios or models. */
function comparedItems() {
  return compareBy === 'models' ? models : selection;
}

/** A display name for a compared item. */
function itemLabel(item) {
  return compareBy === 'models' ? item : scenarioLabel(item);
}

/**
 * Make both pickers, their summaries and the compare menus show the
 * selection.
 *
 * Unticked boxes are disabled at the cap rather than the tick being refused
 * after the fact, so the limit is visible before anyone runs into it.
 */
function showSelection() {
  assignModelColours(models);
  const sync = (list, name, chosen, cap) => {
    const full = chosen.length >= cap;
    for (const input of pickerInputs(list, name)) {
      input.checked = chosen.includes(input.value);
      input.disabled = input.type === 'checkbox' && full && !input.checked;
      input.closest('label').dataset.disabled = String(input.disabled);
    }
  };
  sync(elements.scenarioList, 'scenario', selection, MAX_SCENARIOS);
  sync(elements.modelList, 'model', models, MAX_MODELS);
  // Model colours belong to the selection, so repaint their swatches.
  for (const swatch of elements.modelList.querySelectorAll('.multiselect__swatch')) {
    const on = compareBy === 'models' && models.includes(swatch.dataset.item);
    swatch.style.background = on ? modelColour(swatch.dataset.item) : '';
  }

  const summary = (chosen, label, short) =>
    chosen.length === 1 ? label(chosen[0]) : `${short(chosen[0])} + ${chosen.length - 1} more`;
  elements.scenarioSummary.textContent = summary(selection, scenarioLabel, scenarioShortLabel);
  elements.scenarioPicker.title = selection.map(scenarioLabel).join(', ');
  elements.modelSummary.textContent = summary(models, (m) => m, (m) => m);
  elements.modelPicker.title = models.join(', ');

  const items = comparedItems();
  if (!compare || !compare.every((name) => items.includes(name))) {
    compare = defaultCompare(items);
  }
  elements.mapCompare.hidden = !compare;
  elements.maps.dataset.layout = compare ? 'compare' : 'single';
  for (const [menu, chosen] of [
    [elements.compareA, compare?.[0]],
    [elements.compareB, compare?.[1]],
  ]) {
    menu.replaceChildren(
      ...items.map((name) => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = itemLabel(name);
        return option;
      })
    );
    if (chosen) menu.value = chosen;
  }
}

/**
 * Read one picker into the selection, keeping at least one item.
 *
 * @returns {boolean} whether the selection changed
 */
function readPicker(name, changed) {
  const list = name === 'model' ? elements.modelList : elements.scenarioList;
  const order = name === 'model' ? availableModelList : null;
  let chosen = pickerInputs(list, name).filter((b) => b.checked).map((b) => b.value);
  chosen = order ? order.filter((m) => chosen.includes(m)) : sortScenarios(chosen);
  // Unticking the last one would leave nothing to show, so it stays.
  if (chosen.length === 0) {
    changed.checked = true;
    return false;
  }
  if (name === 'model') models = chosen.slice(0, MAX_MODELS);
  else selection = chosen.slice(0, MAX_SCENARIOS);
  // A single choice is made in one click, so the menu has done its job.
  if (changed.type === 'radio') (name === 'model' ? elements.modelPicker : elements.scenarioPicker).open = false;
  return true;
}

/** The explorer for a model, loading its bundles the first time. */
function explorerFor(model) {
  if (!explorers.has(model)) {
    const loading = Explorer.load(dataBase, model).then((loaded) => {
      // Outlines, coastlines and emissions do not depend on the model.
      loaded.regionOutlines = explorer?.regionOutlines ?? null;
      loaded.coastlineRings = explorer?.coastlineRings ?? null;
      loaded.scenarioEmissions = explorer?.scenarioEmissions ?? null;
      return loaded;
    });
    // A failed load must not stay cached, or the model could never be retried.
    loading.catch(() => explorers.delete(model));
    explorers.set(model, loading);
  }
  return explorers.get(model);
}

/**
 * The series a view shows: one per scenario under one model, or one per
 * model under one scenario. Each carries its own label and colour.
 */
function seriesSpecs() {
  if (compareBy === 'models') {
    const scenario = selection[0];
    return models.map((model) => ({
      key: model,
      model,
      scenario,
      label: model,
      colour: modelColour(model),
    }));
  }
  const model = models[0];
  return selection.map((scenario) => ({
    key: scenario,
    model,
    scenario,
    label: scenarioShortLabel(scenario),
    colour: selectedColour(scenario),
  }));
}

/**
 * Run the emulator for every selected scenario and redraw.
 *
 * Every scenario is run with the same seed, so realization k of one and of
 * another are driven by the same random draws: the difference between two
 * ensembles is then the forced difference plus as little sampling noise as
 * the method allows.
 *
 * A custom region takes a different path: the 2 MB pattern artifact gives its
 * forced response, but internal variability would need the EOF maps from the
 * 11 MB noise artifact, which is not loaded. So a drawn region shows the signal
 * without the spread, and says so rather than implying the spread is zero.
 */
async function run() {
  if (!explorer) return;
  const request = ++runRequest;
  if (customBox) {
    runCustomRegion(request);
    return;
  }

  const variable = elements.variable.value;
  const spec = VARIABLES[variable];
  const location = elements.location.value;
  const nRealizations = Number(elements.realizations.value);
  const specs = seriesSpecs();
  const noun = compareBy === 'models' ? 'models' : 'scenarios';

  const started = performance.now();
  let done = 0;
  const progress = () => {
    if (specs.length > 1 && request === runRequest) {
      setStatus(`Generating ${done} of ${specs.length} ${noun}…`);
    }
  };
  progress();

  let results;
  let loaded;
  try {
    loaded = await Promise.all(specs.map((s) => explorerFor(s.model)));
    // Every series at once: the pool spreads them over its workers.
    results = await Promise.all(
      specs.map(({ model, scenario }) =>
        runner.run(model, { variable, location, scenario, nRealizations, seed }).then((r) => {
          done += 1;
          progress();
          return r;
        })
      )
    );
  } catch (error) {
    if (request === runRequest) setStatus(error.message, 'error');
    return;
  }
  // Something newer was asked for while this ran; its result is what to show.
  if (request !== runRequest) return;
  const elapsed = performance.now() - started;

  const years = results[0].years;
  const runs = results.map((result, i) => {
    // Each model is measured from its own baseline: under recent history that
    // is what takes out the part of two models' difference inherited from the
    // past.
    const own = loaded[i];
    const offset = spec.baselined
      ? spec.convert(own.baselineOffset({ variable, location, baseline: elements.baseline.value }))
      : 0;
    return {
      ...specs[i],
      series: result.series.map((series) =>
        subtract(Float64Array.from(series, spec.convert), offset)
      ),
      // What turns a baselined series back into an absolute one, for the
      // seasonal panel, which shows absolute values.
      toAbsolute: offset + own.absoluteOffset({ variable, location }),
    };
  });

  lastRun = { years, runs, variable, location, compareBy, baseline: baselineNote(variable) };
  syncUrl();

  elements.chartTitle.textContent = chartTitle(spec, placeLabel(location), 'at');
  drawChart();
  drawSeasonalPanel();

  setStatus(
    `${nRealizations} realizations of ${spec.label.toLowerCase()} at ` +
      `${placeLabel(location)}, ${describeRuns(runs)}, ` +
      `${WINDOW.start}–${WINDOW.end}, generated in ${elapsed.toFixed(0)} ms.`
  );
}

/** "Temperature at Global mean", naming the one scenario when models vary. */
function chartTitle(spec, place, preposition) {
  const title = `${spec.label} ${preposition} ${place}`;
  return compareBy === 'models' ? `${title}, ${scenarioLabel(selection[0])}` : title;
}

/** "from NorESM2-MM under SSP1-2.6 and SSP5-8.5", or the other way round. */
function describeRuns(runs) {
  const models = [...new Set(runs.map((r) => r.model))];
  const scenarios = [...new Set(runs.map((r) => r.scenario))];
  return `from ${listOf(models)} under ${listOf(scenarios.map(scenarioLabel))}`;
}

/** The y-axis label, naming the baseline when there is one. */
function yLabel(variable) {
  const spec = VARIABLES[variable];
  if (!spec.baselined) return spec.yLabel;
  return `Temperature change from ${BASELINES[elements.baseline.value].label} (°C)`;
}

/** What a run's numbers are measured from, for captions and the CSV. */
function baselineNote(variable) {
  if (!VARIABLES[variable].baselined) return 'absolute (no baseline)';
  const { label } = BASELINES[elements.baseline.value];
  const own = compareBy === 'models' ? ", each model's own" : '';
  return `change from ${label}, the forced-response mean under ${scenarioLabel(explorer.baselineScenario)}${own}`;
}

/** Subtract a baseline in place, in display units. */
function subtract(series, offset) {
  for (let t = 0; t < series.length; t += 1) series[t] -= offset;
  return series;
}

/** "A", "A and B", "A, B and C". */
function listOf(labels) {
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** The forced response for a drawn region, with no ensemble behind it. */
async function runCustomRegion(request) {
  const variable = elements.variable.value;
  const spec = VARIABLES[variable];
  const { boxRegion } = await import('../lib/pattern.js');

  const runs = [];
  let years;
  try {
    const mask = boxRegion(customBox);
    for (const s of seriesSpecs()) {
      const own = await explorerFor(s.model);
      const offset = spec.baselined
        ? spec.convert(
            await own.customBaselineOffset({ variable, mask, baseline: elements.baseline.value })
          )
        : 0;
      const result = await own.customForcedResponse({ variable, scenario: s.scenario, mask });
      years = result.years;
      runs.push({
        ...s,
        series: [subtract(Float64Array.from(result.forced, spec.convert), offset)],
      });
    }
  } catch (error) {
    if (request === runRequest) setStatus(error.message, 'error');
    return;
  }
  if (request !== runRequest || !customBox) return;

  lastRun = {
    years,
    runs,
    variable,
    location: describeBox(customBox),
    compareBy,
    forcedOnly: true,
    baseline: baselineNote(variable),
  };
  syncUrl();

  elements.chartTitle.textContent = chartTitle(spec, describeBox(customBox), 'over');
  drawChart();
  drawSeasonalPanel();

  setStatus(
    `Forced response only over ${describeBox(customBox)}. A drawn region has no ` +
      `ensemble behind it: internal variability needs the EOF maps from the ` +
      `11 MB noise artifact, which this page does not load. Pick a listed ` +
      `place for the full spread.`
  );
}

/** The fan chart and its legend, from the last run. */
function drawChart() {
  if (!lastRun) return;
  const spec = VARIABLES[lastRun.variable];
  drawFanChart(elements.chart, {
    x: lastRun.years,
    groups: lastRun.runs.map(({ label, colour, series }) => ({
      label,
      colour,
      series: series.map(annualMeans),
    })),
    yLabel: yLabel(lastRun.variable),
    format: spec.format,
  });

  // The legend says what the marks are; which series is which is named on
  // the chart itself when there are several.
  const { colour } = lastRun.runs[0];
  const swatch = (kind, text) => {
    const span = document.createElement('span');
    span.className = `swatch swatch--${kind}`;
    span.style.background = colour;
    return [span, ` ${text} `];
  };
  if (lastRun.forcedOnly) {
    elements.chartLegend.textContent = 'Forced response, no ensemble';
  } else if (lastRun.runs.length === 1) {
    elements.chartLegend.replaceChildren(
      ...swatch('median', 'median'),
      ...swatch('band', '25–75%'),
      ...swatch('wide', '5–95%')
    );
  } else {
    const per = lastRun.compareBy === 'models' ? 'model' : 'scenario';
    elements.chartLegend.textContent = `Median (line) and 5–95% (band) per ${per}`;
  }
}

/** A human-readable description of a box. */
function describeBox(box) {
  const ns = (v) => `${Math.abs(v).toFixed(0)}°${v >= 0 ? 'N' : 'S'}`;
  const ew = (v) => {
    const wrapped = ((((v + 180) % 360) + 360) % 360) - 180;
    return `${Math.abs(wrapped).toFixed(0)}°${wrapped >= 0 ? 'E' : 'W'}`;
  };
  return `${ns(box.south)}–${ns(box.north)}, ${ew(box.west)}–${ew(box.east)}`;
}

/** Climatology for the first and last twenty years of the window. */
function drawSeasonalPanel() {
  if (!lastRun) return;
  // A forced-response run is annual, so there is no seasonal cycle in it.
  if (lastRun.forcedOnly) {
    elements.seasonal.closest('.panel').hidden = true;
    return;
  }
  elements.seasonal.closest('.panel').hidden = false;
  const spec = VARIABLES[lastRun.variable];

  // Absolute values, not change: a seasonal cycle reads as temperatures a
  // reader knows — "-10 °C in January" — while a change from a baseline puts
  // winter tens of degrees "below" a period that was never that cold.
  const climatology = (ensemble, fromYear, toYear, shift) => {
    const months = ensemble[0].length;
    const out = new Float64Array(12);
    const from = (fromYear - WINDOW.start) * 12;
    const to = Math.min((toYear - WINDOW.start + 1) * 12, months);
    for (let m = 0; m < 12; m += 1) {
      let sum = 0;
      let count = 0;
      for (const series of ensemble) {
        for (let t = from + m; t < to; t += 12) {
          sum += series[t];
          count += 1;
        }
      }
      out[m] = sum / count + shift;
    }
    return out;
  };

  // Scenarios under one model share a present-day climate, so the early
  // period is drawn once. Models do not — their absolute climates differ by
  // degrees — so comparing models, each gets its own early line too.
  const byModel = lastRun.compareBy === 'models';
  drawSeasonal(elements.seasonal, {
    early: byModel
      ? lastRun.runs.map(({ colour, series, toAbsolute }) => ({
          colour,
          values: climatology(series, 2015, 2034, toAbsolute),
        }))
      : climatology(lastRun.runs[0].series, 2015, 2034, lastRun.runs[0].toAbsolute),
    late: lastRun.runs.map(({ colour, series, toAbsolute }) => ({
      colour,
      values: climatology(series, 2081, 2100, toAbsolute),
    })),
    format: spec.format,
  });

  // Built from text nodes, not markup: the labels are ours, but there is no
  // reason to parse them as HTML.
  const swatch = (className, colour) => {
    const span = document.createElement('span');
    span.className = `swatch ${className}`;
    if (colour) span.style.background = colour;
    return span;
  };
  const items = [swatch('swatch--dashed'), ' 2015–2034 '];
  for (const run of lastRun.runs) {
    const label = lastRun.runs.length === 1 ? '2081–2100' : run.label;
    items.push(swatch('swatch--line', run.colour), ` ${label} `);
  }
  if (lastRun.runs.length > 1) items.push('(2081–2100)');
  // Says so, because the chart above is a change and this is not.
  items.push(lastRun.variable === 'tas' ? ' · absolute, °C' : ' · absolute, mm/day');
  elements.seasonalLegend.replaceChildren(...items);
}

/** The current control state, as the URL records it. */
function currentState() {
  return {
    compareBy,
    models,
    variable: elements.variable.value,
    location: elements.location.value,
    scenarios: selection,
    compare,
    nRealizations: Number(elements.realizations.value),
    baseline: elements.baseline.value,
    seed,
  };
}

/**
 * Keep the address bar in step with what is shown.
 *
 * `replaceState`, not `pushState`: every control change would otherwise add a
 * history entry, and the back button would walk through them one at a time
 * instead of leaving the page.
 */
function syncUrl() {
  const query = toQuery(currentState());
  window.history.replaceState(null, '', `${window.location.pathname}${query}`);
}

/** Apply state parsed from the URL to the controls. */
function applyState(state) {
  compareBy = state.compareBy;
  elements.compareBy.value = compareBy;
  models = availableModelList.filter((m) => state.models.includes(m));
  if (!models.length) models = [availableModelList[0]];
  renderPickers();
  elements.baseline.value = state.baseline;
  elements.variable.value = state.variable;
  if (explorer.locations.includes(state.location)) elements.location.value = state.location;
  selection = sortScenarios(state.scenarios.filter((name) => explorer.scenarios.includes(name)));
  if (!selection.length) selection = [explorer.scenarios.includes('ssp245') ? 'ssp245' : explorer.scenarios[0]];
  compare = state.compare;
  showSelection();
  elements.realizations.value = String(state.nRealizations);
  seed = state.seed;


  // A shared link may ask for a realization count the menu does not list.
  if (elements.realizations.value !== String(state.nRealizations)) {
    const option = document.createElement('option');
    option.value = String(state.nRealizations);
    option.textContent = String(state.nRealizations);
    elements.realizations.append(option);
    elements.realizations.value = String(state.nRealizations);
  }
}

/** Briefly mark a button as having done its job. */
function flash(button, message) {
  const original = button.textContent;
  button.textContent = message;
  button.dataset.done = 'true';
  setTimeout(() => {
    button.textContent = original;
    delete button.dataset.done;
  }, 1600);
}

function attachActions() {
  elements.copyLink.addEventListener('click', async () => {
    const url = toUrl(currentState());
    try {
      await navigator.clipboard.writeText(url);
      flash(elements.copyLink, 'Link copied');
    } catch {
      // Clipboard access can be refused; the URL bar already holds the link.
      flash(elements.copyLink, 'Copy from the address bar');
    }
  });

  elements.downloadCsv.addEventListener('click', () => {
    if (!lastRun) return;
    const spec = VARIABLES[lastRun.variable];
    const csv = toCsv({
      years: lastRun.years,
      runs: lastRun.runs,
      bundle: explorer.bundles[lastRun.variable],
      models: [...new Set(lastRun.runs.map((r) => r.model))],
      variable: lastRun.variable,
      location: lastRun.location,
      units: yLabel(lastRun.variable),
      baseline: lastRun.baseline,
      seed,
      url: toUrl(currentState()),
    });
    downloadText(`${stem()}.csv`, csv);
    flash(elements.downloadCsv, 'CSV saved');
  });

  elements.downloadPng.addEventListener('click', async () => {
    if (!lastRun) return;
    const spec = VARIABLES[lastRun.variable];
    const blob = await chartToPng(elements.chart, {
      title: `${spec.label} at ${placeLabel(lastRun.location)}`,
      subtitle:
        `${[...new Set(lastRun.runs.map((r) => r.model))].join(', ')} · ` +
        `${[...new Set(lastRun.runs.map((r) => scenarioLabel(r.scenario)))].join(', ')} · ` +
        `${lastRun.runs[0].series.length} realizations · ${WINDOW.start}–${WINDOW.end}` +
        (VARIABLES[lastRun.variable].baselined
          ? ` · from ${BASELINES[elements.baseline.value].label}`
          : ''),
    });
    download(`${stem()}.png`, blob);
    flash(elements.downloadPng, 'Chart saved');
  });

  elements.resample.addEventListener('click', () => {
    // A different seed is a different draw from the same distribution, which
    // is the honest way to show that no single realization means anything.
    seed = Math.floor(Math.random() * 0xffffffff);
    run();
  });
}

function stem() {
  return filenameStem({
    cmip6Model: [...new Set(lastRun.runs.map((r) => r.model))].join('+'),
    variable: lastRun.variable,
    location: lastRun.location,
    scenario: [...new Set(lastRun.runs.map((r) => r.scenario))],
  });
}

/**
 * Load the pattern artifact and outlines, then draw the map.
 *
 * Deferred behind a button because it is 2 MB against the bundle's 81 KB, and
 * most visits never need it.
 */
async function loadMap() {
  elements.loadMap.disabled = true;
  elements.loadMap.textContent = 'Loading…';
  try {
    [outlines, coastlines] = await Promise.all([
      explorer.regions(),
      explorer.coastlines(),
    ]);
    await explorer.patterns(elements.variable.value);
    elements.mapPanel.dataset.map = 'ready';
    elements.loadMap.hidden = true;
    elements.mapModes.hidden = false;
    setMapMode(mapMode);
    await renderMap();
  } catch (error) {
    setStatus(`Could not load the map: ${error.message}`, 'error');
    elements.loadMap.disabled = false;
    elements.loadMap.textContent = 'Load map (2 MB)';
  }
}

/**
 * The map's own units, which are not the timeseries panel's.
 *
 * Temperature is a change in °C either way. Precipitation is a *percent*
 * change, which is the convention for maps and the only readable choice: an
 * absolute change of 0.2 mm/day is negligible in the tropics and
 * transformative in a desert, so an absolute map mostly shows where it already
 * rains.
 */
function toMapUnits(field, variable, base, climatology) {
  // Change from the baseline period: the forced response here, less its mean
  // over the period. Both are relative to the same unforced state, so it
  // cancels.
  if (variable === 'tas') return Float64Array.from(field, (v, i) => v - base.mean[i]);
  return Float64Array.from(field, (v, i) => {
    // The denominator is the baseline period's own precipitation. The
    // climatology is the model's 2015 field; the forced response carries it
    // back or forward to the period.
    const level = climatology[i] + base.mean[i] - base.at2015[i];
    // Where there is essentially no rain, a percentage is meaningless rather
    // than large, so leave it blank instead of rendering a spurious extreme.
    if (!Number.isFinite(level) || level <= 1e-9) return NaN;
    return ((v - base.mean[i]) / level) * 100;
  });
}

/** Every map canvas, in grid order. */
function mapCanvases() {
  return [elements.map, elements.mapB, elements.mapDiff];
}

/** Guards against an older, slower render landing after a newer one. */
let mapRequest = 0;

/**
 * Compute and draw the forced-response maps for the selected year.
 *
 * One series selected, one map. Two or more, the pair chosen in the compare
 * menus, each on the same scale, and their difference B − A on its own
 * zero-centred scale. The difference is taken in map units, so for
 * precipitation it is in percentage points. Two models rarely share a grid,
 * so B is interpolated onto A's before the difference is taken.
 */
async function renderMap() {
  if (elements.mapPanel.dataset.map !== 'ready') return;
  const request = ++mapRequest;

  const variable = elements.variable.value;
  const year = Number(elements.mapYear.value);
  const baseline = elements.baseline.value;
  const specs = seriesSpecs();
  const shown = compare ? compare.map((key) => specs.find((s) => s.key === key)) : [specs[0]];

  let fields;
  try {
    fields = await Promise.all(
      shown.map(async (s) => {
        const own = await explorerFor(s.model);
        const base = await own.baselineMap({ variable, baseline });
        const climatology = variable === 'pr' ? await own.climatology() : null;
        const { field, lat, lon } = await own.forcedMap({ variable, scenario: s.scenario, year });
        return { field: toMapUnits(field, variable, base, climatology), lat, lon };
      })
    );
  } catch (error) {
    setStatus(`Could not draw the map: ${error.message}`, 'error');
    return;
  }
  if (request !== mapRequest) return;

  let difference = null;
  if (fields.length === 2) {
    const [a, b] = fields;
    const regridded = !sameGrid(a, b);
    const bOnA = regridded ? regrid(b, a.lat, a.lon) : b.field;
    difference = {
      field: Float64Array.from(bOnA, (v, i) => v - a.field[i]),
      lat: a.lat,
      lon: a.lon,
      regridded,
    };
  }
  lastMap = { fields, difference, specs: shown, variable, year, baseline };

  redrawMap();
  const what = compareBy === 'models' ? 'two models' : 'two scenarios';
  elements.mapTitle.textContent = compare
    ? `Forced response, ${year}: ${what} and their difference`
    : `Forced response, ${year}`;
}

/** Switch which gesture a plain drag performs. */
function setMapMode(mode) {
  mapMode = mode;
  elements.modeSelect.setAttribute('aria-pressed', String(mode === 'select'));
  elements.modePan.setAttribute('aria-pressed', String(mode === 'pan'));
  for (const canvas of mapCanvases()) {
    canvas.style.cursor = mode === 'pan' ? 'grab' : 'crosshair';
  }
  updateTouchAction();
}

/**
 * Who gets a one-finger swipe on a map: the map, or the page.
 *
 * Zoomed in, the map, in every direction: a browser commits a touch to
 * scrolling or not from its first few pixels, so sharing vertical swipes with
 * the page made dragging a zoomed map a coin toss. At the whole-world view
 * there is nowhere to pan vertically, so a vertical swipe is left to scroll
 * the page instead — which is what keeps three stacked maps on a phone from
 * trapping it. Drawing a region needs every direction whatever the zoom.
 * Pinches and taps stay with the map throughout.
 */
function updateTouchAction() {
  const own = mapMode === 'select' || mapView.zoom > 1;
  for (const canvas of mapCanvases()) {
    canvas.style.touchAction = own ? 'none' : 'pan-y';
  }
}

/** Show the view-reset button whenever the view is not the whole world. */
function showResetView() {
  elements.resetView.hidden =
    mapView.zoom === 1 && mapView.centreLat === 0 && mapView.centreLon === 0;
  // Every view change comes through here, so the touch rules follow the zoom.
  updateTouchAction();
}

/** Select the AR6 region under a point, if the bundle carries it. */
function selectRegionAt(point) {
  const region = regionAt(outlines, point);
  if (!region) return;
  const spec = `regional:${region.code}`;
  if (!explorer.locations.includes(spec)) return;
  customBox = null;
  elements.clearBox.hidden = true;
  elements.location.value = spec;
  run();
  redrawMap();
}

/**
 * Selecting a region, drawing one, panning and zooming.
 *
 * Every map listens, and every gesture changes the one shared view or
 * selection, so the three maps in a comparison always show the same place.
 */
function attachMap() {
  elements.loadMap.addEventListener('click', loadMap);
  elements.modeSelect.addEventListener('click', () => setMapMode('select'));
  elements.modePan.addEventListener('click', () => setMapMode('pan'));

  elements.resetView.addEventListener('click', () => {
    mapView = defaultView();
    showResetView();
    redrawMap();
  });

  elements.mapYear.addEventListener('input', () => {
    elements.mapYearValue.textContent = elements.mapYear.value;
  });
  elements.mapYear.addEventListener('change', renderMap);

  elements.clearBox.addEventListener('click', () => {
    customBox = null;
    elements.clearBox.hidden = true;
    run();
    redrawMap();
  });

  let gesture = null;
  // Every pointer down on a map, so a second finger can turn a drag into a
  // pinch. Touch only ever has more than one.
  const pointers = new Map();
  let pinch = null;
  // After a pinch, the finger left on the glass must not become a pan or a
  // tap: nothing more happens until every finger is up.
  let settling = false;
  // A tap waits briefly to see whether it is the first half of a double-tap,
  // so double-tapping to zoom does not also select the region underneath.
  let pendingTap = null;

  const pinchSpan = () => {
    const [a, b] = [...pointers.values()];
    return {
      distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      mid: { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 },
    };
  };

  const endGestures = () => {
    gesture = null;
    setMapMode(mapMode);
  };

  for (const canvas of mapCanvases()) {
    // Wheel zooms about the pointer, so the feature under the cursor stays
    // put — anchoring on the centre instead makes zooming in on anything a
    // chase.
    canvas.addEventListener(
      'wheel',
      (event) => {
        if (elements.mapPanel.dataset.map !== 'ready') return;
        event.preventDefault();
        const factor = Math.exp(-event.deltaY * 0.0015);
        mapView = viewAbout(canvas, mapView, mapView.zoom * factor, event);
        showResetView();
        redrawMap();
      },
      { passive: false }
    );

    canvas.addEventListener('pointerdown', (event) => {
      if (elements.mapPanel.dataset.map !== 'ready') return;
      pointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
      capture(canvas, event);

      if (pointers.size === 2) {
        // A second finger: whatever the first was doing becomes a pinch. A box
        // it had started drawing is put back as it was.
        if (gesture && !gesture.panning) customBox = gesture.boxBefore;
        gesture = null;
        const { distance, mid } = pinchSpan();
        pinch = { canvas, startView: { ...mapView }, distance, mid };
        settling = true;
        return;
      }
      if (pointers.size > 2 || settling) return;

      // Shift does whichever the active mode does not, so either gesture is
      // always one key away without leaving the mode you prefer.
      const panning = event.shiftKey ? mapMode === 'select' : mapMode === 'pan';
      gesture = {
        canvas,
        panning,
        from: toLatLon(canvas, event, mapView),
        startView: { ...mapView },
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        boxBefore: customBox,
      };
      if (panning) canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('pointermove', (event) => {
      if (pointers.has(event.pointerId)) {
        pointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
      }

      if (pinch) {
        if (pointers.size < 2 || pinch.canvas !== canvas) return;
        // Zoom by how far the fingers have spread, about the point that was
        // between them, and pan with their midpoint: two fingers move the
        // map any way at once.
        const { distance, mid } = pinchSpan();
        const zoom = pinch.startView.zoom * (distance / Math.max(pinch.distance, 1));
        mapView = viewAbout(canvas, pinch.startView, zoom, pinch.mid, mid);
        showResetView();
        redrawMap();
        return;
      }

      if (!gesture) {
        if (event.pointerType === 'mouse') showReadout(toLatLon(canvas, event, mapView));
        return;
      }
      if (gesture.canvas !== canvas) return;

      // A click and a tiny drag are the same gesture to a human, so neither
      // a pan nor a box starts until the pointer has moved a few pixels.
      const distance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
      if (!gesture.moved && distance < 4) return;
      gesture.moved = true;

      if (gesture.panning) {
        const rect = canvas.getBoundingClientRect();
        const height = Math.round(rect.width / 2);
        const project = projection(gesture.startView, rect.width, height);
        const scaleY = height / rect.height;
        mapView = clampView({
          zoom: gesture.startView.zoom,
          centreLat:
            gesture.startView.centreLat +
            (event.clientY - gesture.startY) * scaleY * project.degreesPerPixelY,
          centreLon:
            gesture.startView.centreLon -
            (event.clientX - gesture.startX) * project.degreesPerPixelX,
        });
        showResetView();
        redrawMap();
        return;
      }

      // Eastward extent from how far the pointer moved, so a drag across the
      // antimeridian is the strip drawn rather than the rest of the world.
      const rect = canvas.getBoundingClientRect();
      const { degreesPerPixelX } = projection(mapView, rect.width, Math.round(rect.width / 2));
      customBox = boxFromDrag(
        gesture.from,
        toLatLon(canvas, event, mapView).lat,
        (event.clientX - gesture.startX) * degreesPerPixelX
      );
      redrawMap();
    });

    const release = (event) => {
      pointers.delete(event.pointerId);
      if (pinch && pointers.size < 2) pinch = null;
      if (settling) {
        if (pointers.size === 0) settling = false;
        endGestures();
        return false;
      }
      return true;
    };

    canvas.addEventListener('pointerup', (event) => {
      const active = gesture && gesture.canvas === canvas ? gesture : null;
      if (!release(event) || !active) return;
      const { panning, moved } = active;
      endGestures();

      if (moved) {
        if (panning) return;
        elements.clearBox.hidden = false;
        run();
        return;
      }

      // A second tap close by, soon after the first, zooms in about it. The
      // first tap's region selection is cancelled rather than applied.
      const now = performance.now();
      if (
        pendingTap &&
        pendingTap.canvas === canvas &&
        now - pendingTap.time < DOUBLE_TAP_MS &&
        Math.hypot(event.clientX - pendingTap.clientX, event.clientY - pendingTap.clientY) < 30
      ) {
        clearTimeout(pendingTap.timer);
        pendingTap = null;
        mapView = viewAbout(canvas, mapView, mapView.zoom * 2, event);
        showResetView();
        redrawMap();
        return;
      }

      // A plain tap or click selects the AR6 region under it, whichever mode
      // is active: pan is the default, and region picking should not need a
      // mode switch to discover. On touch, where there is no hover, it also
      // reads the values there.
      if (pendingTap) clearTimeout(pendingTap.timer);
      const to = toLatLon(canvas, event, mapView);
      const touch = event.pointerType !== 'mouse';
      pendingTap = {
        canvas,
        time: now,
        clientX: event.clientX,
        clientY: event.clientY,
        timer: setTimeout(() => {
          pendingTap = null;
          selectRegionAt(to);
          if (touch) showReadout(to);
        }, DOUBLE_TAP_MS),
      };
    });

    canvas.addEventListener('pointercancel', (event) => {
      // The browser took the gesture, usually a vertical swipe scrolling the
      // page. Put back any box a drag had started.
      if (gesture && !gesture.panning && gesture.moved) {
        customBox = gesture.boxBefore;
        redrawMap();
      }
      release(event);
      endGestures();
    });

    canvas.addEventListener('pointerleave', (event) => {
      if (!gesture && event.pointerType === 'mouse') showReadout(null);
    });
  }
}

/** How long a tap waits to see whether a second makes it a double-tap. */
const DOUBLE_TAP_MS = 250;

/**
 * A view at a new zoom that keeps one geographic point under the pointer.
 *
 * The point under `from` in `base` lands under `to` in the result, so the same
 * function zooms about the cursor (`to` omitted) and pinches, where the
 * fingers' midpoint also moves and carries the map with it.
 *
 * @param {{clientX: number, clientY: number}} from
 * @param {{clientX: number, clientY: number}} [to]
 */
function viewAbout(canvas, base, zoom, from, to = from) {
  const anchor = toLatLon(canvas, from, base);
  const zoomed = clampView({ ...base, zoom });
  const after = toLatLon(canvas, to, zoomed);
  return clampView({
    zoom: zoomed.zoom,
    centreLat: zoomed.centreLat + (anchor.lat - after.lat),
    centreLon: zoomed.centreLon + (anchor.lon - after.lon),
  });
}

/** Units for a map value, for the readout. */
function mapValueText(value, variable, difference = false) {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  const magnitude = Math.abs(value);
  if (variable === 'tas') return `${sign}${magnitude.toFixed(1)} °C`;
  return `${sign}${magnitude.toFixed(0)}${difference ? ' pts' : ' %'}`;
}

/**
 * What the maps show under the pointer.
 *
 * In a comparison it reads all three at once, which is the point of having
 * them side by side: the colours say roughly, this says exactly.
 */
function showReadout(point) {
  if (!lastMap) return;
  const prompt = compare ? 'Point at any map to read all three.' : '';
  if (!point) {
    elements.mapReadout.textContent = prompt;
    return;
  }
  const ns = `${Math.abs(point.lat).toFixed(0)}°${point.lat >= 0 ? 'N' : 'S'}`;
  const ew = `${Math.abs(point.lon).toFixed(0)}°${point.lon >= 0 ? 'E' : 'W'}`;
  const rows = lastMap.fields.map((grid, i) => [
    lastMap.specs[i].label,
    mapValueText(valueAt(grid, point), lastMap.variable),
  ]);
  if (lastMap.difference) {
    rows.push(['Difference', mapValueText(valueAt(lastMap.difference, point), lastMap.variable, true)]);
  }
  const list = document.createElement('dl');
  for (const [term, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  }
  elements.mapReadout.replaceChildren(`${ns} ${ew}`, list);
}

/**
 * Keep receiving pointer events after the pointer leaves the element.
 *
 * An optimisation rather than a requirement — a drag still works without it,
 * it just stops at the edge — so a browser that refuses should not take the
 * handler down with it.
 */
function capture(element, event) {
  try {
    element.setPointerCapture(event.pointerId);
  } catch {
    // No active pointer with that id: synthetic events, or a stale id.
  }
}

/** Units and formatting for each series the context panel can show. */
const CONTEXT_SERIES = {
  CO2: { label: 'CO₂ emissions (Gt CO₂/yr)', format: (v) => v.toFixed(0) },
  CH4: { label: 'CH₄ emissions (Mt CH₄/yr)', format: (v) => v.toFixed(0) },
  SO2: { label: 'SO₂ emissions (Mt SO₂/yr)', format: (v) => v.toFixed(0) },
  forcing: { label: 'Radiative forcing (W/m²)', format: (v) => v.toFixed(0) },
};

/**
 * Draw every scenario, with the selected one picked out.
 *
 * Emissions come from a small companion file; forcing comes from the bundles,
 * which already carry it per experiment.
 */
async function renderContext() {
  const which = elements.contextSeries.value;
  const spec = CONTEXT_SERIES[which];
  const selected = selection;
  const neutral = getComputedStyle(document.documentElement)
    .getPropertyValue('--muted')
    .trim() || '#64748b';

  let series;
  let range;
  if (which === 'forcing') {
    series = explorer.scenarios.map((name) => {
      const { years, forcing } = explorer.totalForcing(name);
      return { name, years, values: forcing };
    });
    range = [1990, WINDOW.end];
  } else {
    if (!scenarioEmissions) {
      try {
        scenarioEmissions = await explorer.emissions();
      } catch (error) {
        setStatus(`Could not load scenario emissions: ${error.message}`, 'error');
        return;
      }
    }
    const years = scenarioEmissions.years;
    series = explorer.scenarios
      .filter((name) => scenarioEmissions.scenarios[name])
      .map((name) => ({ name, years, values: scenarioEmissions.scenarios[name][which] }));
    range = [years[0], years[years.length - 1]];
  }

  drawScenarioContext(elements.context, {
    scenarios: series.map((s) => ({
      ...s,
      label: scenarioShortLabel(s.name),
      colour: scenarioColour(s.name, neutral),
      selectedColour: selectedColour(s.name, neutral),
      // The CMIP7 markers are the subject and get named; the SSPs are the
      // reference set behind them and would only crowd the margin.
      labelled: scenarioFamily(s.name) === 'CMIP7 ScenarioMIP',
    })),
    selected,
    range,
    yLabel: spec.label,
    format: spec.format,
  });
  elements.contextTitle.textContent =
    selected.length === 1
      ? `Scenario context — ${scenarioLabel(selected[0])}`
      : `Scenario context — ${selected.length} scenarios`;
}

/** A caption: the scenario's colour, then its name. */
function caption(element, text, colour = null) {
  element.replaceChildren();
  if (colour) {
    const swatch = document.createElement('span');
    swatch.className = 'map-caption__swatch';
    swatch.style.background = colour;
    element.append(swatch);
  }
  element.append(text);
}

/** Redraw the maps from the last fields, without recomputing them. */
function redrawMap() {
  if (!lastMap || elements.mapPanel.dataset.map !== 'ready') return;
  const kind = lastMap.variable === 'tas' ? 'temperature' : 'precipitation';
  const shared = {
    regions: outlines,
    coastlines,
    highlight: elements.location.value.startsWith('regional:') && !customBox
      ? elements.location.value.slice('regional:'.length)
      : null,
    box: customBox,
    view: mapView,
  };
  const units = lastMap.variable === 'tas' ? '°C' : '%';
  const noun = lastMap.variable === 'tas' ? 'Temperature' : 'Precipitation';
  const scale = classedScale(kind);
  const bar = (canvas) =>
    drawColourBar(canvas, {
      edges: scale.edges,
      colours: scale.colours,
      label: `${noun} change in ${lastMap.year} from ${BASELINES[lastMap.baseline].label} (${units})`,
    });

  const comparing = lastMap.fields.length === 2;
  elements.maps.dataset.layout = comparing ? 'compare' : 'single';

  const full = (s) => (lastMap.specs.length && compareBy === 'models' ? s.label : scenarioLabel(s.scenario));
  drawMap(elements.map, { ...shared, ...lastMap.fields[0], variable: kind });
  bar(elements.colourbar);
  const [a, b] = lastMap.specs;
  caption(elements.captionA, comparing ? `A: ${full(a)}` : '', comparing ? a.colour : null);

  if (comparing) {
    drawMap(elements.mapB, { ...shared, ...lastMap.fields[1], variable: kind });
    bar(elements.colourbarB);
    caption(elements.captionB, `B: ${full(b)}`, b.colour);

    const differenceKind = `${kind}-difference`;
    drawMap(elements.mapDiff, { ...shared, ...lastMap.difference, variable: differenceKind });
    const differenceScale = classedScale(differenceKind);
    drawColourBar(elements.colourbarDiff, {
      edges: differenceScale.edges,
      colours: differenceScale.colours,
      label:
        lastMap.variable === 'tas'
          ? `B − A in ${lastMap.year} (°C)`
          : `B − A in ${lastMap.year} (percentage points)`,
    });
    // A difference of forced responses carries no internal variability, so
    // it is the signal the scenarios separate by, not a "will differ by".
    caption(
      elements.captionDiff,
      `B − A: ${b.label} minus ${a.label}, forced signal only` +
        (lastMap.difference.regridded ? `, on ${a.label}'s grid` : '')
    );
  }
  showReadout(null);
}

/** Redraw everything from the last run, without regenerating it. */
function redraw() {
  redrawMap();
  renderContext();
  drawChart();
  drawSeasonalPanel();
}

/**
 * After the models or scenarios change: make the first selected model the
 * primary explorer, then redraw everything.
 */
async function selectionChanged() {
  try {
    const primary = await explorerFor(models[0]);
    if (primary !== explorer) {
      explorer = primary;
      showProvenance();
    }
  } catch (error) {
    setStatus(`Could not load ${models[0]}: ${error.message}`, 'error');
    return;
  }
  run();
  renderContext();
  renderMap();
}

function attachControls() {
  // The compare menus pick which two of the selection the maps show. Choosing
  // the scenario already in the other slot swaps the two rather than
  // comparing a scenario with itself.
  for (const [menu, slot] of [[elements.compareA, 0], [elements.compareB, 1]]) {
    menu.addEventListener('change', () => {
      const next = [...compare];
      const other = 1 - slot;
      if (menu.value === next[other]) next[other] = next[slot];
      next[slot] = menu.value;
      compare = next;
      showSelection();
      syncUrl();
      renderMap();
    });
  }

  // The pickers are dropdowns, so close them on a click elsewhere, as a
  // native select would.
  for (const picker of [elements.scenarioPicker, elements.modelPicker]) {
    document.addEventListener('click', (event) => {
      if (!picker.contains(event.target)) picker.open = false;
    });
    picker.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        picker.open = false;
        picker.querySelector('summary').focus();
      }
    });
  }

  elements.controls.addEventListener('change', async (event) => {
    if (event.target === elements.compareBy) {
      // Switching what is compared keeps the first of each: the first model,
      // and the first scenario, carry over as the single choice.
      compareBy = elements.compareBy.value;
      models = models.slice(0, compareBy === 'models' ? MAX_MODELS : 1);
      if (compareBy === 'models') selection = selection.slice(0, 1);
      compare = null;
      renderPickers();
      showSelection();
      await selectionChanged();
      return;
    }
    if (event.target.name === 'scenario' || event.target.name === 'model') {
      if (!readPicker(event.target.name, event.target)) return;
      showSelection();
      await selectionChanged();
      return;
    }
    // Choosing a listed place supersedes a region drawn on the map.
    if (event.target === elements.location && customBox) {
      customBox = null;
      elements.clearBox.hidden = true;
    }
    run();
    renderMap();
  });

  // Redraw whenever a canvas changes size, which covers window resizes and,
  // more importantly, the first paint: a canvas measured before its
  // stylesheet applies has zero height, and the drawing code bails out on
  // that. Without something to retrigger it the chart would stay blank for
  // the life of the page, which is an intermittent bug that depends on
  // whether the CSS beat the module.
  let timer;
  const observer = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(redraw, 50);
  });
  observer.observe(elements.chart);
  observer.observe(elements.seasonal);
  for (const canvas of mapCanvases()) observer.observe(canvas);
  observer.observe(elements.context);
}

/** Which models, trained how, from which version of METEOR. */
function showProvenance() {
  const bundle = explorer.bundles.tas;
  const which = compareBy === 'models' ? models.join(', ') : bundle.attrs.cmip6_model;
  elements.provenance.textContent =
    `Bundles: ${which}, trained on ${bundle.attrs.training_scenario}, ` +
    `METEOR ${bundle.attrs.meteor_version}, schema v${bundle.schemaVersion}. ` +
    `${bundle.locations.length} locations, ${bundle.scenarios.length} scenarios.`;
}

async function start() {
  // An absolute path from the configured base, rather than a relative one:
  // on Pages the page may be served with or without a trailing slash, and a
  // relative URL resolves differently in each case.
  dataBase = `${import.meta.env.BASE_URL}data/`;
  availableModelList = await availableModels(dataBase);
  runner = new EnsembleRunner({
    loadExplorer: (model) => Explorer.load(dataBase, model),
    createWorker: () => {
      // Written out in full so Vite recognises and bundles the worker.
      const worker = new Worker(new URL('./ensemble-worker.js', import.meta.url), {
        type: 'module',
      });
      worker.postMessage({ type: 'init', base: new URL(dataBase, window.location.href).href });
      return worker;
    },
  });

  // The model decides which bundles to fetch, so it is read from the link
  // before anything else; the rest is validated once the bundles say what
  // locations and scenarios exist.
  const first = fromQuery(window.location.search, { models: availableModelList });
  compareBy = first.compareBy;
  try {
    explorer = await explorerFor(first.models[0]);
  } catch (error) {
    setStatus(`Could not load the emulator bundles: ${error.message}`, 'error');
    return;
  }

  populateControls();

  // Apply the shared link before the first run, so a link opens on what it
  // describes rather than flashing the default view first.
  applyState(
    fromQuery(window.location.search, {
      locations: explorer.locations,
      scenarios: explorer.scenarios,
      models: availableModelList,
    })
  );

  attachControls();
  attachActions();
  attachMap();
  elements.contextSeries.addEventListener('change', renderContext);
  elements.mapPanel.dataset.map = 'idle';

  showProvenance();

  run();
  renderContext();
}

start();
