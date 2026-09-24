/**
 * Wiring: controls to kernel to canvas.
 *
 * Everything runs on the main thread. A 100-member, 86-year run is a few
 * hundred milliseconds, which is quick enough that a worker would cost more in
 * complexity than it saves in responsiveness.
 */

import { annualMeans, drawFanChart, drawScenarioContext, drawSeasonal } from './chart.js';
import { chartToPng, download, downloadText, filenameStem, toCsv } from './export.js';
import { drawColourBar, drawMap, regionAt, toLatLon } from './map.js';
import { Explorer, WINDOW } from './explorer.js';
import { placeLabel } from './places.js';
import {
  groupScenarios,
  scenarioColour,
  scenarioFamily,
  scenarioLabel,
  scenarioShortLabel,
} from './scenarios.js';
import { DEFAULT_SEED, fromQuery, toQuery, toUrl } from './state.js';

/** Seconds per year, for the precipitation unit conversion. */
const SECONDS_PER_DAY = 86400;

const VARIABLES = {
  tas: {
    label: 'Temperature',
    // METEOR's timeseries output is an anomaly, not an absolute temperature.
    yLabel: 'Temperature anomaly (°C)',
    convert: (v) => v,
    format: (v) => `${v.toFixed(1)}°`,
  },
  pr: {
    label: 'Precipitation',
    // The bundle works in kg m-2 s-1; mm/day is what anyone reading this wants.
    yLabel: 'Precipitation (mm/day)',
    convert: (v) => v * SECONDS_PER_DAY,
    format: (v) => v.toFixed(1),
  },
};

const elements = {
  controls: document.getElementById('controls'),
  variable: document.getElementById('variable'),
  location: document.getElementById('location'),
  scenario: document.getElementById('scenario'),
  realizations: document.getElementById('realizations'),
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
  elements.scenario.replaceChildren();
  for (const { family, names } of groupScenarios(explorer.scenarios)) {
    const group = document.createElement('optgroup');
    group.label = family;
    for (const scenario of names) {
      const option = document.createElement('option');
      option.value = scenario;
      option.textContent = scenarioLabel(scenario);
      group.append(option);
    }
    elements.scenario.append(group);
  }
  elements.scenario.value = explorer.scenarios.includes('ssp245')
    ? 'ssp245'
    : explorer.scenarios[0];
}

/**
 * Run the emulator and redraw.
 *
 * A custom region takes a different path: the 2 MB pattern artifact gives its
 * forced response, but internal variability would need the EOF maps from the
 * 11 MB noise artifact, which is not loaded. So a drawn region shows the signal
 * without the spread, and says so rather than implying the spread is zero.
 */
function run() {
  if (!explorer) return;
  if (customBox) {
    runCustomRegion();
    return;
  }

  const variable = elements.variable.value;
  const spec = VARIABLES[variable];
  const location = elements.location.value;
  const nRealizations = Number(elements.realizations.value);

  const started = performance.now();
  let result;
  try {
    result = explorer.run({
      variable,
      location,
      scenario: elements.scenario.value,
      nRealizations,
      seed,
    });
  } catch (error) {
    setStatus(error.message, 'error');
    return;
  }
  const elapsed = performance.now() - started;

  const converted = result.series.map((series) =>
    Float64Array.from(series, spec.convert)
  );
  lastRun = { ...result, converted, variable, location, scenario: elements.scenario.value };
  syncUrl();

  elements.chartTitle.textContent = `${spec.label} at ${placeLabel(location)}`;
  drawFanChart(elements.chart, {
    x: result.years,
    series: converted.map(annualMeans),
    yLabel: spec.yLabel,
    format: spec.format,
  });
  drawSeasonalPanel();

  setStatus(
    `${nRealizations} realizations of ${spec.label.toLowerCase()} at ` +
      `${placeLabel(location)} under ${scenarioLabel(elements.scenario.value)}, ` +
      `${WINDOW.start}–${WINDOW.end}, generated in ${elapsed.toFixed(0)} ms.`
  );
}

/** The forced response for a drawn region, with no ensemble behind it. */
async function runCustomRegion() {
  const variable = elements.variable.value;
  const spec = VARIABLES[variable];
  const { boxRegion } = await import('../lib/pattern.js');

  let result;
  try {
    result = await explorer.customForcedResponse({
      variable,
      scenario: elements.scenario.value,
      mask: boxRegion(customBox),
    });
  } catch (error) {
    setStatus(error.message, 'error');
    return;
  }

  const forced = Float64Array.from(result.forced, spec.convert);
  lastRun = {
    years: result.years,
    series: [forced],
    converted: [forced],
    variable,
    location: describeBox(customBox),
    scenario: elements.scenario.value,
    forcedOnly: true,
  };
  syncUrl();

  elements.chartTitle.textContent = `${spec.label} over ${describeBox(customBox)}`;
  drawFanChart(elements.chart, {
    x: result.years,
    series: [forced],
    yLabel: spec.yLabel,
    format: spec.format,
  });
  drawSeasonalPanel();

  setStatus(
    `Forced response only over ${describeBox(customBox)}. A drawn region has no ` +
      `ensemble behind it: internal variability needs the EOF maps from the ` +
      `11 MB noise artifact, which this page does not load. Pick a listed ` +
      `place for the full spread.`
  );
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
  const months = lastRun.converted[0].length;

  const climatology = (fromYear, toYear) => {
    const out = new Float64Array(12);
    const from = (fromYear - WINDOW.start) * 12;
    const to = Math.min((toYear - WINDOW.start + 1) * 12, months);
    for (let m = 0; m < 12; m += 1) {
      let sum = 0;
      let count = 0;
      for (const series of lastRun.converted) {
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
    early: climatology(2015, 2034),
    late: climatology(2081, 2100),
    format: spec.format,
  });
}

/** The current control state, as the URL records it. */
function currentState() {
  return {
    variable: elements.variable.value,
    location: elements.location.value,
    scenario: elements.scenario.value,
    nRealizations: Number(elements.realizations.value),
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
  elements.variable.value = state.variable;
  if (explorer.locations.includes(state.location)) elements.location.value = state.location;
  if (explorer.scenarios.includes(state.scenario)) elements.scenario.value = state.scenario;
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
      series: lastRun.converted,
      bundle: explorer.bundles[lastRun.variable],
      variable: lastRun.variable,
      location: lastRun.location,
      scenario: lastRun.scenario,
      units: spec.yLabel,
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
        `${scenarioLabel(lastRun.scenario)} · ` +
        `${lastRun.converted.length} realizations · ${WINDOW.start}–${WINDOW.end}`,
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
    scenario: lastRun.scenario,
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
    outlines = await explorer.regions();
    await explorer.patterns(elements.variable.value);
    elements.mapPanel.dataset.map = 'ready';
    elements.loadMap.hidden = true;
    await renderMap();
  } catch (error) {
    setStatus(`Could not load the map: ${error.message}`, 'error');
    elements.loadMap.disabled = false;
    elements.loadMap.textContent = 'Load map (2 MB)';
  }
}

/** Compute and draw the forced-response map for the selected year. */
async function renderMap() {
  if (elements.mapPanel.dataset.map !== 'ready') return;

  const variable = elements.variable.value;
  const spec = VARIABLES[variable];
  const year = Number(elements.mapYear.value);

  const { field, lat, lon } = await explorer.forcedMap({
    variable,
    scenario: elements.scenario.value,
    year,
  });

  const converted = Float64Array.from(field, spec.convert);
  lastMap = { field: converted, lat, lon, variable, year };

  const scale = drawMap(elements.map, {
    field: converted,
    lat,
    lon,
    regions: outlines,
    highlight: elements.location.value.startsWith('regional:')
      ? elements.location.value.slice('regional:'.length)
      : null,
    box: customBox,
    // Temperature is an anomaly about zero and wants a diverging scale;
    // precipitation here is a change too, so it does as well.
    diverging: true,
  });

  drawColourBar(elements.colourbar, {
    ...scale,
    label: `${spec.label} change in ${year} (${variable === 'tas' ? '°C' : 'mm/day'})`,
  });
  elements.mapTitle.textContent = `Forced response, ${year}`;
}

/** Selecting a region, or drawing one, on the map. */
function attachMap() {
  elements.loadMap.addEventListener('click', loadMap);

  elements.mapYear.addEventListener('input', () => {
    elements.mapYearValue.textContent = elements.mapYear.value;
  });
  elements.mapYear.addEventListener('change', renderMap);

  elements.clearBox.addEventListener('click', () => {
    customBox = null;
    elements.clearBox.hidden = true;
    run();
    renderMap();
    renderContext();
  });

  let dragFrom = null;
  let dragged = false;

  elements.map.addEventListener('pointerdown', (event) => {
    if (elements.mapPanel.dataset.map !== 'ready') return;
    dragFrom = toLatLon(elements.map, event);
    dragged = false;
    capture(elements.map, event);
  });

  elements.map.addEventListener('pointermove', (event) => {
    if (!dragFrom) return;
    const to = toLatLon(elements.map, event);
    // A click and a tiny drag are the same gesture to a human, so only treat
    // it as a box once it is big enough to have been meant.
    if (Math.abs(to.lat - dragFrom.lat) < 2 && Math.abs(to.lon - dragFrom.lon) < 2) return;
    dragged = true;
    customBox = boxFrom(dragFrom, to);
    // Redraw from the field already in hand: the outline moves with the
    // pointer, and recomputing the map for each move would not.
    redrawMap();
  });

  const finish = (event) => {
    if (!dragFrom) return;
    const to = toLatLon(elements.map, event);
    dragFrom = null;

    if (dragged) {
      elements.clearBox.hidden = false;
      run();
      return;
    }

    // A plain click selects the AR6 region under the pointer, if the bundle
    // carries it — every AR6 region does.
    const region = regionAt(outlines, to);
    if (!region) return;
    const spec = `regional:${region.code}`;
    if (!explorer.locations.includes(spec)) return;
    customBox = null;
    elements.clearBox.hidden = true;
    elements.location.value = spec;
    run();
    renderMap();
  };
  elements.map.addEventListener('pointerup', finish);
  elements.map.addEventListener('pointercancel', () => {
    dragFrom = null;
  });
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
  const selected = elements.scenario.value;
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
      // The CMIP7 markers are the subject and get named; the SSPs are the
      // reference set behind them and would only crowd the margin.
      labelled: scenarioFamily(s.name) === 'CMIP7 ScenarioMIP',
    })),
    selected,
    range,
    yLabel: spec.label,
    format: spec.format,
  });
  elements.contextTitle.textContent = `Scenario context — ${scenarioLabel(selected)}`;
}

/** Redraw the map from the last field, without recomputing it. */
function redrawMap() {
  if (!lastMap || elements.mapPanel.dataset.map !== 'ready') return;
  const spec = VARIABLES[lastMap.variable];
  const scale = drawMap(elements.map, {
    field: lastMap.field,
    lat: lastMap.lat,
    lon: lastMap.lon,
    regions: outlines,
    highlight: elements.location.value.startsWith('regional:')
      ? elements.location.value.slice('regional:'.length)
      : null,
    box: customBox,
    diverging: true,
  });
  drawColourBar(elements.colourbar, {
    ...scale,
    label: `${spec.label} change in ${lastMap.year} (${lastMap.variable === 'tas' ? '°C' : 'mm/day'})`,
  });
}

/** Redraw everything from the last run, without regenerating it. */
function redraw() {
  redrawMap();
  renderContext();
  if (!lastRun) return;
  const spec = VARIABLES[lastRun.variable];
  drawFanChart(elements.chart, {
    x: lastRun.years,
    series: lastRun.converted.map(annualMeans),
    yLabel: spec.yLabel,
    format: spec.format,
  });
  drawSeasonalPanel();
}

function attachControls() {
  elements.controls.addEventListener('change', (event) => {
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
  observer.observe(elements.map);
  observer.observe(elements.context);
}

async function start() {
  try {
    // An absolute path from the configured base, rather than a relative one:
    // on Pages the page may be served with or without a trailing slash, and a
    // relative URL resolves differently in each case.
    explorer = await Explorer.load(`${import.meta.env.BASE_URL}data/`);
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
    })
  );

  attachControls();
  attachActions();
  attachMap();
  elements.contextSeries.addEventListener('change', renderContext);
  elements.mapPanel.dataset.map = 'idle';

  const bundle = explorer.bundles.tas;
  elements.provenance.textContent =
    `Bundle: ${bundle.attrs.cmip6_model}, trained on ${bundle.attrs.training_scenario}, ` +
    `METEOR ${bundle.attrs.meteor_version}, schema v${bundle.schemaVersion}. ` +
    `${bundle.locations.length} locations, ${bundle.scenarios.length} scenarios.`;

  run();
  renderContext();
}

start();
