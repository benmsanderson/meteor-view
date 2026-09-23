/**
 * Canvas plotting: an ensemble fan chart and a seasonal-cycle panel.
 *
 * Hand-drawn rather than pulled from a charting library, for the same reason
 * the bundles are classic netCDF: the payload is a few hundred kilobytes and a
 * chart library would be a large fraction of that again.
 *
 * The point of METEOR is the variability, so the fan chart leads with the
 * spread — a 5-95 and a 25-75 band — and draws the median over it. Individual
 * realizations are drawn underneath when there are few enough to read.
 */

const AXIS_FONT = '12px ui-sans-serif, system-ui, -apple-system, sans-serif';

/** Read a CSS custom property, so the canvas follows the page theme. */
function themeColor(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name);
  return value.trim() || fallback;
}

/**
 * Size a canvas for the device pixel ratio and return its 2D context.
 *
 * @returns {{context: CanvasRenderingContext2D, width: number, height: number}}
 */
function prepare(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);

  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return { context, width, height };
}

/** Percentile of a sorted array, by linear interpolation between ranks. */
function percentile(sorted, p) {
  if (sorted.length === 1) return sorted[0];
  const position = p * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (position - low) * (sorted[high] - sorted[low]);
}

/**
 * Per-year percentiles across an ensemble.
 *
 * @param {Float64Array[]} series one per realization, all the same length
 * @param {number[]} probabilities
 * @returns {Float64Array[]} one array per probability
 */
export function quantiles(series, probabilities) {
  const n = series[0].length;
  const out = probabilities.map(() => new Float64Array(n));
  const column = new Float64Array(series.length);

  for (let t = 0; t < n; t += 1) {
    for (let r = 0; r < series.length; r += 1) column[r] = series[r][t];
    const sorted = Float64Array.from(column).sort();
    probabilities.forEach((p, i) => {
      out[i][t] = percentile(sorted, p);
    });
  }
  return out;
}

/** Annual means of a monthly series. */
export function annualMeans(series) {
  const years = Math.floor(series.length / 12);
  const out = new Float64Array(years);
  for (let y = 0; y < years; y += 1) {
    let sum = 0;
    for (let m = 0; m < 12; m += 1) sum += series[y * 12 + m];
    out[y] = sum / 12;
  }
  return out;
}

/** A round-ish step for axis ticks, given an approximate target. */
function niceStep(range, targetTicks) {
  const raw = range / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalised = raw / magnitude;
  const step = normalised >= 5 ? 10 : normalised >= 2 ? 5 : normalised >= 1 ? 2 : 1;
  return step * magnitude;
}

/**
 * Draw an ensemble fan chart.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} options
 * @param {number[]} options.x x values (years)
 * @param {Float64Array[]} options.series one annual series per realization
 * @param {string} options.yLabel
 * @param {(value: number) => string} options.format tick formatter
 */
export function drawFanChart(canvas, { x, series, yLabel, format }) {
  const { context, width, height } = prepare(canvas);
  const pad = { top: 12, right: 14, bottom: 34, left: 62 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  if (plotWidth <= 0 || plotHeight <= 0) return;

  const bands = quantiles(series, [0.05, 0.25, 0.5, 0.75, 0.95]);
  const [p05, p25, p50, p75, p95] = bands;

  let low = Infinity;
  let high = -Infinity;
  for (const s of series) {
    for (const v of s) {
      if (v < low) low = v;
      if (v > high) high = v;
    }
  }
  const span = high - low || 1;
  low -= span * 0.05;
  high += span * 0.05;

  const sx = (i) => pad.left + (i / (x.length - 1)) * plotWidth;
  const sy = (v) => pad.top + plotHeight - ((v - low) / (high - low)) * plotHeight;

  const grid = themeColor('--grid', '#e2e8f0');
  const text = themeColor('--muted', '#64748b');
  const accent = themeColor('--accent', '#2563eb');

  // Axes and grid.
  context.font = AXIS_FONT;
  context.strokeStyle = grid;
  context.fillStyle = text;
  context.lineWidth = 1;

  const yStep = niceStep(high - low, 5);
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  for (let v = Math.ceil(low / yStep) * yStep; v <= high; v += yStep) {
    const y = Math.round(sy(v)) + 0.5;
    context.beginPath();
    context.moveTo(pad.left, y);
    context.lineTo(pad.left + plotWidth, y);
    context.stroke();
    context.fillText(format(v), pad.left - 8, y);
  }

  const xStep = niceStep(x[x.length - 1] - x[0], 6);
  context.textAlign = 'center';
  context.textBaseline = 'top';
  for (let year = Math.ceil(x[0] / xStep) * xStep; year <= x[x.length - 1]; year += xStep) {
    const i = year - x[0];
    if (i < 0 || i >= x.length) continue;
    context.fillText(String(year), sx(i), pad.top + plotHeight + 8);
  }

  // Spread first, so the median and the realizations sit over it.
  const band = (lower, upper, alpha) => {
    context.beginPath();
    for (let i = 0; i < x.length; i += 1) context.lineTo(sx(i), sy(upper[i]));
    for (let i = x.length - 1; i >= 0; i -= 1) context.lineTo(sx(i), sy(lower[i]));
    context.closePath();
    context.fillStyle = accent;
    context.globalAlpha = alpha;
    context.fill();
    context.globalAlpha = 1;
  };
  band(p05, p95, 0.16);
  band(p25, p75, 0.26);

  // Individual realizations, only while they are still legible.
  if (series.length <= 24) {
    context.strokeStyle = accent;
    context.globalAlpha = 0.3;
    context.lineWidth = 0.8;
    for (const s of series) {
      context.beginPath();
      for (let i = 0; i < x.length; i += 1) context.lineTo(sx(i), sy(s[i]));
      context.stroke();
    }
    context.globalAlpha = 1;
  }

  context.strokeStyle = accent;
  context.lineWidth = 2;
  context.beginPath();
  for (let i = 0; i < x.length; i += 1) context.lineTo(sx(i), sy(p50[i]));
  context.stroke();

  // Axis frame.
  context.strokeStyle = grid;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(pad.left + 0.5, pad.top);
  context.lineTo(pad.left + 0.5, pad.top + plotHeight + 0.5);
  context.lineTo(pad.left + plotWidth, pad.top + plotHeight + 0.5);
  context.stroke();

  context.save();
  context.translate(14, pad.top + plotHeight / 2);
  context.rotate(-Math.PI / 2);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = text;
  context.fillText(yLabel, 0, 0);
  context.restore();
}

/**
 * Draw the monthly climatology for an early and a late period.
 *
 * Monthly output is the reason to run METEOR rather than an annual emulator,
 * so the change in the shape of the seasonal cycle is worth its own panel.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} options
 * @param {Float64Array} options.early twelve values
 * @param {Float64Array} options.late twelve values
 * @param {(value: number) => string} options.format
 */
export function drawSeasonal(canvas, { early, late, format }) {
  const { context, width, height } = prepare(canvas);
  const pad = { top: 12, right: 12, bottom: 28, left: 62 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  if (plotWidth <= 0 || plotHeight <= 0) return;

  let low = Math.min(...early, ...late);
  let high = Math.max(...early, ...late);
  const span = high - low || 1;
  low -= span * 0.12;
  high += span * 0.12;

  const sx = (m) => pad.left + (m / 11) * plotWidth;
  const sy = (v) => pad.top + plotHeight - ((v - low) / (high - low)) * plotHeight;

  const grid = themeColor('--grid', '#e2e8f0');
  const text = themeColor('--muted', '#64748b');
  const accent = themeColor('--accent', '#2563eb');
  const warm = themeColor('--warm', '#dc2626');

  context.font = AXIS_FONT;
  context.strokeStyle = grid;
  context.fillStyle = text;
  context.textAlign = 'right';
  context.textBaseline = 'middle';

  const yStep = niceStep(high - low, 4);
  for (let v = Math.ceil(low / yStep) * yStep; v <= high; v += yStep) {
    const y = Math.round(sy(v)) + 0.5;
    context.beginPath();
    context.moveTo(pad.left, y);
    context.lineTo(pad.left + plotWidth, y);
    context.stroke();
    context.fillText(format(v), pad.left - 8, y);
  }

  context.textAlign = 'center';
  context.textBaseline = 'top';
  const labels = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  labels.forEach((label, m) => {
    context.fillText(label, sx(m), pad.top + plotHeight + 7);
  });

  const line = (values, color) => {
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.beginPath();
    for (let m = 0; m < 12; m += 1) context.lineTo(sx(m), sy(values[m]));
    context.stroke();
  };
  line(early, accent);
  line(late, warm);
}
