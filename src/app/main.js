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
  clampView,
  classedScale,
  defaultView,
  drawColourBar,
  drawMap,
  projection,
  regionAt,
  toLatLon,
  valueAt,
} from './map.js';
import { BASELINES, Explorer, WINDOW, availableModels } from './explorer.js';
import { EnsembleRunner } from './runner.js';
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
  model: document.getElementById('model'),
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

/** @type {Explorer} */
let explorer;
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
/** Gridded precipitation climatology, the percent-change denominator. */
let prClimatology = null;
/** Which gesture the plain drag performs; shift does the other. */
let mapMode = 'pan';
/** The selected scenarios, in menu order. Never empty. */
let selection = ['ssp245'];
/** The two scenarios the maps compare, or null with only one selected. */
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

  // Grouped by generation, because the two are not interchangeable and the
  // menu is the only place that can say so before a comparison is made.
  elements.scenarioList.replaceChildren();
  for (const { family, names } of groupScenarios(explorer.scenarios)) {
    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = family;
    fieldset.append(legend);
    for (const scenario of names) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = scenario;
      box.name = 'scenario';
      const swatch = document.createElement('span');
      swatch.className = 'multiselect__swatch';
      swatch.style.background = selectedColour(scenario);
      label.append(box, swatch, scenarioLabel(scenario));
      fieldset.append(label);
    }
    elements.scenarioList.append(fieldset);
  }
  const note = document.createElement('p');
  note.className = 'multiselect__note';
  note.textContent = `Up to ${MAX_SCENARIOS} at once.`;
  elements.scenarioList.append(note);
}

/** Every scenario checkbox. */
function scenarioBoxes() {
  return [...elements.scenarioList.querySelectorAll('input[name="scenario"]')];
}

/**
 * Make the checkboxes, the summary and the compare menus show `selection`.
 *
 * Unticked boxes are disabled at the cap rather than the tick being refused
 * after the fact, so the limit is visible before anyone runs into it.
 */
function showSelection() {
  const full = selection.length >= MAX_SCENARIOS;
  for (const box of scenarioBoxes()) {
    box.checked = selection.includes(box.value);
    box.disabled = full && !box.checked;
    box.closest('label').dataset.disabled = String(box.disabled);
  }
  elements.scenarioSummary.textContent =
    selection.length === 1
      ? scenarioLabel(selection[0])
      : `${scenarioShortLabel(selection[0])} + ${selection.length - 1} more`;
  elements.scenarioPicker.title = selection.map(scenarioLabel).join(', ');

  if (!compare || !compare.every((name) => selection.includes(name))) {
    compare = defaultCompare(selection);
  }
  elements.mapCompare.hidden = !compare;
  elements.maps.dataset.layout = compare ? 'compare' : 'single';
  for (const [menu, chosen] of [
    [elements.compareA, compare?.[0]],
    [elements.compareB, compare?.[1]],
  ]) {
    menu.replaceChildren(
      ...selection.map((name) => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = scenarioLabel(name);
        return option;
      })
    );
    if (chosen) menu.value = chosen;
  }
}

/** Read the ticked boxes into `selection`, keeping at least one. */
function readSelection(changed) {
  const ticked = sortScenarios(scenarioBoxes().filter((b) => b.checked).map((b) => b.value));
  // Unticking the last scenario would leave nothing to show, so it stays.
  if (ticked.length === 0) {
    changed.checked = true;
    return false;
  }
  selection = ticked.slice(0, MAX_SCENARIOS);
  return true;
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
  const scenarios = [...selection];
  const model = explorer.model;

  const started = performance.now();
  let done = 0;
  const progress = () => {
    if (scenarios.length > 1 && request === runRequest) {
      setStatus(`Generating ${done} of ${scenarios.length} scenarios…`);
    }
  };
  progress();

  let results;
  try {
    // Every scenario at once: the pool spreads them over its workers.
    results = await Promise.all(
      scenarios.map((scenario) =>
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
  const offset = spec.baselined
    ? spec.convert(explorer.baselineOffset({ variable, location, baseline: elements.baseline.value }))
    : 0;
  const runs = results.map((result, i) => ({
    scenario: scenarios[i],
    series: result.series.map((series) =>
      subtract(Float64Array.from(series, spec.convert), offset)
    ),
  }));

  lastRun = { years, runs, variable, location, baseline: baselineNote(variable) };
  syncUrl();

  elements.chartTitle.textContent = `${spec.label} at ${placeLabel(location)}`;
  drawChart();
  drawSeasonalPanel();

  setStatus(
    `${nRealizations} realizations of ${spec.label.toLowerCase()} at ` +
      `${placeLabel(location)} under ${listScenarios(scenarios)}, ` +
      `${WINDOW.start}–${WINDOW.end}, generated in ${elapsed.toFixed(0)} ms.`
  );
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
  return `change from ${label}, the forced-response mean under ${scenarioLabel(explorer.baselineScenario)}`;
}

/** Subtract a baseline in place, in display units. */
function subtract(series, offset) {
  for (let t = 0; t < series.length; t += 1) series[t] -= offset;
  return series;
}

/** "A", "A and B", "A, B and C". */
function listScenarios(names) {
  const labels = names.map(scenarioLabel);
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
    const offset = spec.baselined
      ? spec.convert(
          await explorer.customBaselineOffset({ variable, mask, baseline: elements.baseline.value })
        )
      : 0;
    for (const scenario of selection) {
      const result = await explorer.customForcedResponse({ variable, scenario, mask });
      years = result.years;
      runs.push({
        scenario,
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
    forcedOnly: true,
    baseline: baselineNote(variable),
  };
  syncUrl();

  elements.chartTitle.textContent = `${spec.label} over ${describeBox(customBox)}`;
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
    groups: lastRun.runs.map(({ scenario, series }) => ({
      label: scenarioShortLabel(scenario),
      colour: selectedColour(scenario),
      series: series.map(annualMeans),
    })),
    yLabel: yLabel(lastRun.variable),
    format: spec.format,
  });

  // The legend says what the marks are; which scenario is which is named on
  // the chart itself when there are several.
  const colour = selectedColour(lastRun.runs[0].scenario);
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
    elements.chartLegend.textContent = 'Median (line) and 5–95% (band) per scenario';
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

  const climatology = (ensemble, fromYear, toYear) => {
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
      out[m] = sum / count;
    }
    return out;
  };

  drawSeasonal(elements.seasonal, {
    // The first scenario's, as the baseline: by 2015-2034 the scenarios have
    // barely begun to diverge.
    early: climatology(lastRun.runs[0].series, 2015, 2034),
    late: lastRun.runs.map(({ scenario, series }) => ({
      colour: selectedColour(scenario),
      values: climatology(series, 2081, 2100),
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
  for (const { scenario } of lastRun.runs) {
    const label = lastRun.runs.length === 1 ? '2081–2100' : scenarioShortLabel(scenario);
    items.push(swatch('swatch--line', selectedColour(scenario)), ` ${label} `);
  }
  if (lastRun.runs.length > 1) items.push('(2081–2100)');
  elements.seasonalLegend.replaceChildren(...items);
}

/** The current control state, as the URL records it. */
function currentState() {
  return {
    model: elements.model.value,
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
  elements.model.value = state.model;
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
        `${explorer.bundles[lastRun.variable].attrs.cmip6_model} · ` +
        `${lastRun.runs.map((r) => scenarioLabel(r.scenario)).join(', ')} · ` +
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
    cmip6Model: explorer.bundles[lastRun.variable].attrs.cmip6_model,
    variable: lastRun.variable,
    location: lastRun.location,
    scenario: lastRun.runs.map((r) => r.scenario),
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
function toMapUnits(field, variable, base) {
  // Change from the baseline period: the forced response here, less its mean
  // over the period. Both are relative to the same unforced state, so it
  // cancels.
  if (variable === 'tas') return Float64Array.from(field, (v, i) => v - base.mean[i]);
  return Float64Array.from(field, (v, i) => {
    // The denominator is the baseline period's own precipitation. The
    // climatology is the model's 2015 field; the forced response carries it
    // back or forward to the period.
    const level = prClimatology[i] + base.mean[i] - base.at2015[i];
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
 * One scenario selected, one map. Two or more, the pair chosen in the
 * compare menus, each on the same scale, and their difference B − A on its
 * own zero-centred scale. The difference is taken in map units, so for
 * precipitation it is in percentage points of the same climatology.
 */
async function renderMap() {
  if (elements.mapPanel.dataset.map !== 'ready') return;
  const request = ++mapRequest;

  const variable = elements.variable.value;
  const year = Number(elements.mapYear.value);

  if (variable === 'pr' && !prClimatology) {
    prClimatology = await explorer.climatology();
  }

  const shown = compare ?? [selection[0]];
  const baseline = elements.baseline.value;
  let fields;
  let grid;
  try {
    const base = await explorer.baselineMap({ variable, baseline });
    fields = [];
    for (const scenario of shown) {
      const { field, lat, lon } = await explorer.forcedMap({ variable, scenario, year });
      grid = { lat, lon };
      fields.push(toMapUnits(field, variable, base));
    }
  } catch (error) {
    setStatus(`Could not draw the map: ${error.message}`, 'error');
    return;
  }
  if (request !== mapRequest) return;

  let difference = null;
  if (fields.length === 2) {
    difference = Float64Array.from(fields[1], (v, i) => v - fields[0][i]);
  }
  lastMap = { ...grid, fields, difference, scenarios: shown, variable, year, baseline };

  redrawMap();
  elements.mapTitle.textContent = compare
    ? `Forced response, ${year}: two scenarios and their difference`
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
}

/** Show the view-reset button whenever the view is not the whole world. */
function showResetView() {
  elements.resetView.hidden =
    mapView.zoom === 1 && mapView.centreLat === 0 && mapView.centreLon === 0;
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

  for (const canvas of mapCanvases()) {
    // Wheel zooms about the pointer, so the feature under the cursor stays
    // put — anchoring on the centre instead makes zooming in on anything a
    // chase.
    canvas.addEventListener(
      'wheel',
      (event) => {
        if (elements.mapPanel.dataset.map !== 'ready') return;
        event.preventDefault();
        const before = toLatLon(canvas, event, mapView);
        const factor = Math.exp(-event.deltaY * 0.0015);
        const zoomed = clampView({ ...mapView, zoom: mapView.zoom * factor });
        const after = toLatLon(canvas, event, zoomed);
        mapView = clampView({
          zoom: zoomed.zoom,
          centreLat: zoomed.centreLat + (before.lat - after.lat),
          centreLon: zoomed.centreLon + (before.lon - after.lon),
        });
        showResetView();
        redrawMap();
      },
      { passive: false }
    );

    canvas.addEventListener('pointerdown', (event) => {
      if (elements.mapPanel.dataset.map !== 'ready') return;
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
      };
      capture(canvas, event);
      if (panning) canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!gesture) {
        showReadout(toLatLon(canvas, event, mapView));
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

      customBox = boxFrom(gesture.from, toLatLon(canvas, event, mapView));
      redrawMap();
    });

    canvas.addEventListener('pointerup', (event) => {
      if (!gesture || gesture.canvas !== canvas) return;
      const { panning, moved } = gesture;
      const to = toLatLon(canvas, event, mapView);
      gesture = null;
      setMapMode(mapMode);

      // A plain click selects the AR6 region under the pointer, whichever
      // mode is active: pan is the default, and region picking should not
      // need a mode switch to discover.
      if (!moved) {
        selectRegionAt(to);
        return;
      }
      if (panning) return;
      elements.clearBox.hidden = false;
      run();
    });

    canvas.addEventListener('pointercancel', () => {
      gesture = null;
      setMapMode(mapMode);
    });

    canvas.addEventListener('pointerleave', () => {
      if (!gesture) showReadout(null);
    });
  }
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
  const read = (field) => valueAt({ field, lat: lastMap.lat, lon: lastMap.lon }, point);
  const rows = lastMap.fields.map((field, i) => [
    scenarioLabel(lastMap.scenarios[i]),
    mapValueText(read(field), lastMap.variable),
  ]);
  if (lastMap.difference) {
    rows.push(['Difference', mapValueText(read(lastMap.difference), lastMap.variable, true)]);
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

/** A normalised box from two corners. */
function boxFrom(a, b) {
  return {
    south: Math.min(a.lat, b.lat),
    north: Math.max(a.lat, b.lat),
    west: Math.min(a.lon, b.lon),
    east: Math.max(a.lon, b.lon),
  };
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
    lat: lastMap.lat,
    lon: lastMap.lon,
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

  drawMap(elements.map, { ...shared, field: lastMap.fields[0], variable: kind });
  bar(elements.colourbar);
  const [a, b] = lastMap.scenarios;
  caption(elements.captionA, comparing ? `A: ${scenarioLabel(a)}` : '', comparing ? selectedColour(a) : null);

  if (comparing) {
    drawMap(elements.mapB, { ...shared, field: lastMap.fields[1], variable: kind });
    bar(elements.colourbarB);
    caption(elements.captionB, `B: ${scenarioLabel(b)}`, selectedColour(b));

    const differenceKind = `${kind}-difference`;
    drawMap(elements.mapDiff, { ...shared, field: lastMap.difference, variable: differenceKind });
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
      `B − A: ${scenarioShortLabel(b)} minus ${scenarioShortLabel(a)}, forced signal only`
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
 * Load another model's bundles and redraw everything from them.
 *
 * Locations and scenarios are the same for every model the exporter writes,
 * but the grid is not, so everything cached from the previous model's pattern
 * artifact — the climatology, the drawn map — goes with it. Outlines,
 * coastlines and emissions do not depend on the model and are carried over.
 */
async function switchModel(model) {
  const previous = explorer;
  elements.model.disabled = true;
  setStatus(`Loading ${model}…`);
  try {
    explorer = await Explorer.load(dataBase, model);
  } catch (error) {
    setStatus(`Could not load ${model}: ${error.message}`, 'error');
    elements.model.value = previous.model;
    elements.model.disabled = false;
    return;
  }
  explorer.regionOutlines = previous.regionOutlines;
  explorer.coastlineRings = previous.coastlineRings;
  explorer.scenarioEmissions = previous.scenarioEmissions;
  prClimatology = null;
  lastMap = null;
  elements.model.disabled = false;

  showProvenance();
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

  // The scenario list is a dropdown, so close it on a click elsewhere, as a
  // native select would.
  document.addEventListener('click', (event) => {
    if (!elements.scenarioPicker.contains(event.target)) elements.scenarioPicker.open = false;
  });
  elements.scenarioPicker.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      elements.scenarioPicker.open = false;
      elements.scenarioPicker.querySelector('summary').focus();
    }
  });

  elements.controls.addEventListener('change', (event) => {
    if (event.target === elements.model) {
      switchModel(elements.model.value);
      return;
    }
    if (event.target.name === 'scenario') {
      if (!readSelection(event.target)) return;
      showSelection();
      run();
      renderContext();
      renderMap();
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

/** Which model, trained how, from which version of METEOR. */
function showProvenance() {
  const bundle = explorer.bundles.tas;
  elements.provenance.textContent =
    `Bundle: ${bundle.attrs.cmip6_model}, trained on ${bundle.attrs.training_scenario}, ` +
    `METEOR ${bundle.attrs.meteor_version}, schema v${bundle.schemaVersion}. ` +
    `${bundle.locations.length} locations, ${bundle.scenarios.length} scenarios.`;
}

/** One entry per model with artifacts on the site. */
function populateModels(models) {
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    elements.model.append(option);
  }
  // A single model is not a choice, so do not present it as one.
  elements.model.closest('.control').hidden = models.length < 2;
}

async function start() {
  // An absolute path from the configured base, rather than a relative one:
  // on Pages the page may be served with or without a trailing slash, and a
  // relative URL resolves differently in each case.
  dataBase = `${import.meta.env.BASE_URL}data/`;
  const models = await availableModels(dataBase);
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
  const { model } = fromQuery(window.location.search, { models });
  try {
    explorer = await Explorer.load(dataBase, model);
  } catch (error) {
    setStatus(`Could not load the emulator bundles: ${error.message}`, 'error');
    return;
  }

  populateModels(models);
  populateControls();

  // Apply the shared link before the first run, so a link opens on what it
  // describes rather than flashing the default view first.
  applyState(
    fromQuery(window.location.search, {
      locations: explorer.locations,
      scenarios: explorer.scenarios,
      models,
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
