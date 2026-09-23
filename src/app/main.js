/**
 * Wiring: controls to kernel to canvas.
 *
 * Everything runs on the main thread. A 100-member, 86-year run is a few
 * hundred milliseconds, which is quick enough that a worker would cost more in
 * complexity than it saves in responsiveness.
 */

import { annualMeans, drawFanChart, drawSeasonal } from './chart.js';
import { chartToPng, download, downloadText, filenameStem, toCsv } from './export.js';
import { Explorer, WINDOW } from './explorer.js';
import { placeLabel } from './places.js';
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
  pathwayToggle: document.getElementById('pathway-toggle'),
  pathway: document.getElementById('pathway'),
  pathwayCanvas: document.getElementById('pathway-canvas'),
  pathwayReset: document.getElementById('pathway-reset'),
  chart: document.getElementById('chart'),
  copyLink: document.getElementById('copy-link'),
  downloadCsv: document.getElementById('download-csv'),
  downloadPng: document.getElementById('download-png'),
  resample: document.getElementById('resample'),
  chartTitle: document.getElementById('chart-title'),
  seasonal: document.getElementById('seasonal'),
  status: document.getElementById('status'),
  provenance: document.getElementById('provenance'),
};

/** @type {Explorer} */
let explorer;
/** Drawn warming pathway over the window years, or null while following the scenario. */
let drawnPathway = null;
let lastRun = null;
/** Part of the shareable state: the same seed redraws the same realizations. */
let seed = DEFAULT_SEED;

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

  elements.scenario.replaceChildren();
  for (const scenario of explorer.scenarios) {
    const option = document.createElement('option');
    option.value = scenario;
    option.textContent = scenario.toUpperCase().replace('SSP', 'SSP');
    elements.scenario.append(option);
  }
  elements.scenario.value = explorer.scenarios.includes('ssp245')
    ? 'ssp245'
    : explorer.scenarios[0];
}

/** The scenario's own predicted warming over the window, for the pathway editor. */
function scenarioWarming() {
  const years = explorer.years('tas');
  const full = explorer.globalWarming(elements.scenario.value);
  const start = years.indexOf(WINDOW.start);
  return Float64Array.from(full.subarray(start, start + explorer.windowYears().length));
}

/**
 * Draw the pathway editor: the scenario's warming as a guide, the drawn
 * pathway over it.
 */
function renderPathway() {
  const canvas = elements.pathwayCanvas;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);

  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue('--accent').trim() || '#2563eb';
  const muted = style.getPropertyValue('--muted').trim() || '#64748b';

  const guide = scenarioWarming();
  const values = drawnPathway || guide;
  const bounds = pathwayBounds(guide);
  const grid = style.getPropertyValue('--grid').trim() || '#e2e8f0';

  const sx = (i) => (i / (values.length - 1)) * width;
  const sy = (v) => height - ((v - bounds.low) / (bounds.high - bounds.low)) * height;

  // Whole-degree gridlines, so a drawn pathway can be aimed at a number.
  context.font = '11px ui-sans-serif, system-ui, sans-serif';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.lineWidth = 1;
  for (let degrees = 0; degrees <= bounds.high; degrees += 1) {
    const y = Math.round(sy(degrees)) + 0.5;
    context.strokeStyle = grid;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
    context.fillStyle = muted;
    context.fillText(`${degrees}°C`, 6, y - 7);
  }

  const line = (data, color, dashed) => {
    context.strokeStyle = color;
    context.lineWidth = dashed ? 1.5 : 2.5;
    context.setLineDash(dashed ? [4, 4] : []);
    context.beginPath();
    for (let i = 0; i < data.length; i += 1) context.lineTo(sx(i), sy(data[i]));
    context.stroke();
    context.setLineDash([]);
  };

  line(guide, muted, true);
  if (drawnPathway) line(drawnPathway, accent, false);
}

/**
 * Warming range the editor spans.
 *
 * Adapts to the scenario, so its own trajectory sits comfortably inside the
 * box with room above and below to draw something different. A fixed range
 * wide enough for SSP585 would squash SSP119 onto the floor.
 */
function pathwayBounds(guide) {
  const peak = Math.max(...guide);
  return { low: -0.5, high: Math.max(3, Math.ceil(peak + 2)) };
}

/** Where the pointer was last painted, so a stroke can be joined up. */
let strokeFrom = null;

/**
 * Translate a pointer position into a warming value and write it into the
 * pathway, joining it to wherever the stroke was last painted.
 *
 * A pointer moving quickly emits samples several years apart, so painting only
 * at the sample would leave the curve stepped. Interpolating between the last
 * sample and this one makes a fast drag draw the same curve as a slow one.
 */
function paintPathway(event) {
  const canvas = elements.pathwayCanvas;
  const rect = canvas.getBoundingClientRect();
  const guide = scenarioWarming();
  if (!drawnPathway) drawnPathway = Float64Array.from(guide);

  const bounds = pathwayBounds(guide);
  const last = drawnPathway.length - 1;
  const fraction = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
  const index = Math.round(fraction * last);
  const value = Math.min(
    Math.max(
      bounds.high -
        ((event.clientY - rect.top) / rect.height) * (bounds.high - bounds.low),
      bounds.low
    ),
    bounds.high
  );

  // Quantise to the precision the URL stores, so a shared link reproduces the
  // view exactly rather than to within a rounding step. 0.01 °C is far below
  // what anyone can aim at with a pointer, so nothing is lost by it.
  const quantise = (v) => Math.round(v * 100) / 100;

  const from = strokeFrom ?? { index, value };
  const span = index - from.index;
  if (span === 0) {
    drawnPathway[index] = quantise(value);
  } else {
    const step = span > 0 ? 1 : -1;
    for (let i = from.index; i !== index + step; i += step) {
      const t = (i - from.index) / span;
      drawnPathway[i] = quantise(from.value + t * (value - from.value));
    }
  }

  strokeFrom = { index, value };
  renderPathway();
}

function attachPathwayEditor() {
  const canvas = elements.pathwayCanvas;
  let drawing = false;

  canvas.addEventListener('pointerdown', (event) => {
    drawing = true;
    strokeFrom = null;
    canvas.setPointerCapture(event.pointerId);
    paintPathway(event);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (drawing) paintPathway(event);
  });
  const stop = () => {
    if (!drawing) return;
    drawing = false;
    strokeFrom = null;
    run();
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  elements.pathwayReset.addEventListener('click', () => {
    drawnPathway = null;
    renderPathway();
    run();
  });
}

/**
 * A drawn pathway covers the output window; the kernel wants the full year
 * axis. Before the window the scenario's own warming is used, which makes the
 * scaling exactly one there — the pathway only takes over from 2015.
 */
function fullPathway() {
  if (!drawnPathway) return null;
  const years = explorer.years('tas');
  const full = Float64Array.from(explorer.globalWarming(elements.scenario.value));
  const start = years.indexOf(WINDOW.start);
  for (let i = 0; i < drawnPathway.length; i += 1) full[start + i] = drawnPathway[i];
  return full;
}

/** Run the emulator and redraw. */
function run() {
  if (!explorer) return;

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
      pathway: fullPathway(),
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

  const scenarioLabel = drawnPathway
    ? 'a drawn warming pathway'
    : elements.scenario.value.toUpperCase();
  setStatus(
    `${nRealizations} realizations of ${spec.label.toLowerCase()} at ` +
      `${placeLabel(location)} under ${scenarioLabel}, ` +
      `${WINDOW.start}–${WINDOW.end}, generated in ${elapsed.toFixed(0)} ms.`
  );
}

/** Climatology for the first and last twenty years of the window. */
function drawSeasonalPanel() {
  if (!lastRun) return;
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
    pathway: drawnPathway,
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

  drawnPathway = state.pathway ? Float64Array.from(state.pathway) : null;
  elements.pathwayToggle.checked = Boolean(drawnPathway);
  elements.pathway.hidden = !drawnPathway;

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
      scenario: drawnPathway ? `${lastRun.scenario} (rescaled to a drawn pathway)` : lastRun.scenario,
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
        `${drawnPathway ? 'drawn warming pathway' : lastRun.scenario.toUpperCase()} · ` +
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
    scenario: drawnPathway ? 'pathway' : lastRun.scenario,
  });
}

/** Redraw everything from the last run, without regenerating it. */
function redraw() {
  if (!lastRun) return;
  const spec = VARIABLES[lastRun.variable];
  drawFanChart(elements.chart, {
    x: lastRun.years,
    series: lastRun.converted.map(annualMeans),
    yLabel: spec.yLabel,
    format: spec.format,
  });
  drawSeasonalPanel();
  if (!elements.pathway.hidden) renderPathway();
}

function attachControls() {
  elements.controls.addEventListener('change', (event) => {
    if (event.target === elements.pathwayToggle) {
      elements.pathway.hidden = !elements.pathwayToggle.checked;
      if (elements.pathwayToggle.checked) renderPathway();
      else drawnPathway = null;
    }
    run();
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
      pathwayLength: explorer.windowYears().length,
    })
  );

  attachControls();
  attachPathwayEditor();
  attachActions();
  if (drawnPathway) renderPathway();

  const bundle = explorer.bundles.tas;
  elements.provenance.textContent =
    `Bundle: ${bundle.attrs.cmip6_model}, trained on ${bundle.attrs.training_scenario}, ` +
    `METEOR ${bundle.attrs.meteor_version}, schema v${bundle.schemaVersion}. ` +
    `${bundle.locations.length} locations, ${bundle.scenarios.length} scenarios.`;

  run();
}

start();
