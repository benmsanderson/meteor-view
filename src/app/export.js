/**
 * Taking the numbers away: CSV of the ensemble, PNG of the chart.
 *
 * The point of the CSV is that someone can check or reuse the output without
 * this tool, so it carries enough provenance to say what it is — which model,
 * which scenario, which METEOR version, and the link that regenerates it.
 */

/** Comment lines, so pandas can skip them with `comment='#'`. */
function provenanceLines({ bundle, variable, location, scenarios, units, url, nRealizations, seed }) {
  return [
    `# METEOR emulator output, generated in the browser by meteor-view`,
    `# variable: ${variable} (${units})`,
    `# location: ${location}`,
    `# scenarios: ${scenarios.join(', ')}`,
    `# realizations: ${nRealizations}, seed: ${seed}`,
    `# cmip6_model: ${bundle.attrs.cmip6_model}`,
    `# training_scenario: ${bundle.attrs.training_scenario}`,
    `# meteor_version: ${bundle.attrs.meteor_version}`,
    `# schema_version: ${bundle.schemaVersion}`,
    `# generated: ${new Date().toISOString()}`,
    `# regenerate: ${url}`,
    '#',
    `# Realizations differ from METEOR's run for run: a JavaScript port cannot`,
    `# reproduce NumPy's PCG64 stream. They match in distribution, and the`,
    `# deterministic parts are validated against METEOR's golden fixtures.`,
  ];
}

/**
 * The ensembles as CSV: one row per scenario and month, one column per
 * realization.
 *
 * Long in scenario rather than wide, so the file has the same columns however
 * many scenarios were selected, and `df.groupby('scenario')` is all it takes
 * to split it. Every scenario shares the seed, so realization_01 of one and of
 * another were driven by the same random draws.
 *
 * @param {object} options
 * @param {number[]} options.years
 * @param {Array<{scenario: string, series: Float64Array[]}>} options.runs
 *   monthly, in display units
 * @returns {string}
 */
export function toCsv({ years, runs, ...provenance }) {
  const nRealizations = runs[0].series.length;
  const lines = provenanceLines({
    ...provenance,
    scenarios: runs.map((run) => run.scenario),
    nRealizations,
  });

  const header = ['scenario', 'year', 'month'];
  for (let r = 0; r < nRealizations; r += 1) {
    header.push(`realization_${String(r + 1).padStart(2, '0')}`);
  }
  lines.push(header.join(','));

  for (const { scenario, series } of runs) {
    const months = series[0].length;
    for (let t = 0; t < months; t += 1) {
      const row = [scenario, years[Math.floor(t / 12)], (t % 12) + 1];
      for (const s of series) row.push(formatValue(s[t]));
      lines.push(row.join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Six significant figures: more than the float32 bundle behind it can justify,
 * and enough that a round trip through the CSV changes nothing visible.
 */
function formatValue(value) {
  if (!Number.isFinite(value)) return '';
  return Number(value.toPrecision(6)).toString();
}

/** Trigger a download of some text. */
export function downloadText(filename, text, type = 'text/csv') {
  download(filename, new Blob([text], { type: `${type};charset=utf-8` }));
}

/** Trigger a download of a blob. */
export function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Render the chart to a PNG with a background and a caption.
 *
 * The chart canvas is transparent and unlabelled on its own, which makes for a
 * poor thing to paste into a document: on a dark background it would be
 * invisible, and out of context it would not say what it shows. So the export
 * composites onto an opaque background and writes the caption in.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.subtitle
 * @returns {Promise<Blob>}
 */
export function chartToPng(canvas, { title, subtitle }) {
  const ratio = window.devicePixelRatio || 1;
  const margin = 16 * ratio;
  const titleHeight = 54 * ratio;
  const captionHeight = 26 * ratio;

  const out = document.createElement('canvas');
  out.width = canvas.width + margin * 2;
  out.height = canvas.height + titleHeight + captionHeight + margin;

  const context = out.getContext('2d');
  const style = getComputedStyle(document.documentElement);
  context.fillStyle = style.getPropertyValue('--surface').trim() || '#ffffff';
  context.fillRect(0, 0, out.width, out.height);

  context.fillStyle = style.getPropertyValue('--fg').trim() || '#0f172a';
  context.font = `600 ${17 * ratio}px ui-sans-serif, system-ui, sans-serif`;
  context.textBaseline = 'top';
  context.fillText(title, margin, margin);

  context.fillStyle = style.getPropertyValue('--muted').trim() || '#64748b';
  context.font = `${12 * ratio}px ui-sans-serif, system-ui, sans-serif`;
  context.fillText(subtitle, margin, margin + 24 * ratio);

  context.drawImage(canvas, margin, titleHeight);

  context.fillText(
    'METEOR emulator · meteor-view',
    margin,
    titleHeight + canvas.height + 6 * ratio
  );

  return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
}

/**
 * A filename stem that says what the file is without needing the metadata.
 *
 * @param {object} options
 * @param {string|string[]} options.scenario one scenario or several, joined
 *   with `+`
 */
export function filenameStem({ cmip6Model, variable, location, scenario }) {
  const place = location.replace(/^regional:/, '').replace(/^point:/, '').replace(/[^\w.-]+/g, '_');
  const scenarios = [scenario].flat().join('+');
  return `meteor_${cmip6Model}_${variable}_${place}_${scenarios}`;
}
