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
 * Draw one or more ensembles as fan charts.
 *
 * One ensemble gets the full treatment: a 5-95 and a 25-75 band, the
 * realizations while there are few enough to read, and the median over them.
 * Several ensembles overlaid would turn two translucent bands of each into
 * mud, so each is drawn as its 5-95 band alone, thinly, with its median in
 * full colour and its name at the right-hand end. The 25-75 band and the
 * realizations drop out; the median and the outer range are what a comparison
 * reads.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} options
 * @param {number[]} options.x x values (years)
 * @param {Array<{label: string, colour: string, series: Float64Array[]}>}
 *   options.groups one per scenario, each one annual series per realization
 * @param {string} options.yLabel
 * @param {(value: number) => string} options.format tick formatter
 */
export function drawFanChart(canvas, { x, groups, yLabel, format }) {
  const { context, width, height } = prepare(canvas);
  const several = groups.length > 1;
  // Room for the end labels when there are several lines to name.
  const pad = { top: 12, right: several ? 118 : 14, bottom: 34, left: 62 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  if (plotWidth <= 0 || plotHeight <= 0) return;

  const fans = groups.map((group) => {
    const [p05, p25, p50, p75, p95] = quantiles(group.series, [0.05, 0.25, 0.5, 0.75, 0.95]);
    return { ...group, p05, p25, p50, p75, p95 };
  });

  // Scaled to what is drawn: every realization when one ensemble is shown
  // with its realizations, the outer bands otherwise.
  let low = Infinity;
  let high = -Infinity;
  const extend = (values) => {
    for (const v of values) {
      if (v < low) low = v;
      if (v > high) high = v;
    }
  };
  for (const fan of fans) {
    if (!several && fan.series.length <= 24) fan.series.forEach(extend);
    extend(fan.p05);
    extend(fan.p95);
  }
  const span = high - low || 1;
  low -= span * 0.05;
  high += span * 0.05;

  const sx = (i) => pad.left + (i / (x.length - 1)) * plotWidth;
  const sy = (v) => pad.top + plotHeight - ((v - low) / (high - low)) * plotHeight;

  const grid = themeColor('--grid', '#e2e8f0');
  const text = themeColor('--muted', '#64748b');
  const ink = themeColor('--fg', '#0f172a');

  // Axes and grid.
  context.font = AXIS_FONT;
  context.strokeStyle = grid;
  context.fillStyle = text;
  context.lineWidth = 1;

  const yStep = niceStep(high - low, 5);
  const yFormat = tickFormat(format, yStep);
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  for (let v = Math.ceil(low / yStep) * yStep; v <= high; v += yStep) {
    const y = Math.round(sy(v)) + 0.5;
    context.beginPath();
    context.moveTo(pad.left, y);
    context.lineTo(pad.left + plotWidth, y);
    context.stroke();
    context.fillText(yFormat(v), pad.left - 8, y);
  }

  const xStep = niceStep(x[x.length - 1] - x[0], 6);
  context.textAlign = 'center';
  context.textBaseline = 'top';
  for (let year = Math.ceil(x[0] / xStep) * xStep; year <= x[x.length - 1]; year += xStep) {
    const i = year - x[0];
    if (i < 0 || i >= x.length) continue;
    context.fillText(String(year), sx(i), pad.top + plotHeight + 8);
  }

  const band = (lower, upper, colour, alpha) => {
    context.beginPath();
    for (let i = 0; i < x.length; i += 1) context.lineTo(sx(i), sy(upper[i]));
    for (let i = x.length - 1; i >= 0; i -= 1) context.lineTo(sx(i), sy(lower[i]));
    context.closePath();
    context.fillStyle = colour;
    context.globalAlpha = alpha;
    context.fill();
    context.globalAlpha = 1;
  };
  const line = (values, colour, lineWidth, alpha = 1) => {
    context.strokeStyle = colour;
    context.lineWidth = lineWidth;
    context.globalAlpha = alpha;
    context.beginPath();
    for (let i = 0; i < x.length; i += 1) context.lineTo(sx(i), sy(values[i]));
    context.stroke();
    context.globalAlpha = 1;
  };

  if (several) {
    // Every band before any median, so no median is buried under another
    // scenario's band.
    for (const fan of fans) band(fan.p05, fan.p95, fan.colour, 0.13);
    for (const fan of fans) {
      line(fan.p05, fan.colour, 0.8, 0.45);
      line(fan.p95, fan.colour, 0.8, 0.45);
    }
    for (const fan of fans) line(fan.p50, fan.colour, 2);
  } else {
    const [fan] = fans;
    // Spread first, so the median and the realizations sit over it.
    band(fan.p05, fan.p95, fan.colour, 0.16);
    band(fan.p25, fan.p75, fan.colour, 0.26);
    // Individual realizations, only while they are still legible.
    if (fan.series.length <= 24) {
      for (const s of fan.series) line(s, fan.colour, 0.8, 0.3);
    }
    line(fan.p50, fan.colour, 2);
  }

  // Axis frame.
  context.strokeStyle = grid;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(pad.left + 0.5, pad.top);
  context.lineTo(pad.left + 0.5, pad.top + plotHeight + 0.5);
  context.lineTo(pad.left + plotWidth, pad.top + plotHeight + 0.5);
  context.stroke();

  // Name each median at its end: colour alone is not enough to tell six lines
  // apart, least of all for a reader with a colour-vision deficiency. Text in
  // ink, with a short stroke of the line's colour beside it.
  if (several) {
    const ends = fans
      .map((fan) => ({ label: fan.label, colour: fan.colour, y: sy(fan.p50[x.length - 1]) }))
      .sort((a, b) => a.y - b.y);
    spreadLabels(ends, pad.top + 6, pad.top + plotHeight, 14);
    context.font = AXIS_FONT;
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    for (const end of ends) {
      const x0 = pad.left + plotWidth + 6;
      context.strokeStyle = end.colour;
      context.lineWidth = 3;
      context.beginPath();
      context.moveTo(x0, end.y);
      context.lineTo(x0 + 10, end.y);
      context.stroke();
      context.fillStyle = ink;
      context.fillText(end.label, x0 + 14, end.y);
    }
  }

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
 * Nudge vertically sorted labels apart, then back inside `[top, bottom]`.
 *
 * @param {Array<{y: number}>} ends sorted by `y`, adjusted in place
 */
function spreadLabels(ends, top, bottom, gap) {
  for (let i = 1; i < ends.length; i += 1) {
    if (ends[i].y - ends[i - 1].y < gap) ends[i].y = ends[i - 1].y + gap;
  }
  const overflow = ends.length ? ends[ends.length - 1].y - bottom : 0;
  if (overflow > 0) for (const end of ends) end.y -= overflow;
  for (const end of ends) end.y = Math.min(Math.max(end.y, top), bottom);
}

/**
 * A tick formatter with enough decimals for the step.
 *
 * The variable's own formatter rounds to one decimal, which is right for a
 * value and wrong for an axis: precipitation ticks 0.05 apart would all read
 * "3.0".
 */
function tickFormat(format, step) {
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  if (decimals <= 1) return format;
  return (v) => v.toFixed(decimals);
}

/**
 * Draw the monthly climatology for an early and a late period.
 *
 * Monthly output is the reason to run METEOR rather than an annual emulator,
 * so the change in the shape of the seasonal cycle is worth its own panel.
 *
 * With several scenarios, the early period is drawn once — the scenarios have
 * barely diverged by then — and the late period once per scenario, in its
 * colour.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} options
 * @param {Float64Array|Array<{colour: string, values: Float64Array}>} options.early
 *   twelve values, or twelve per series when each has its own present day
 * @param {Array<{colour: string, values: Float64Array}>} options.late twelve
 *   values per series
 * @param {(value: number) => string} options.format
 */
export function drawSeasonal(canvas, { early, late, format }) {
  const { context, width, height } = prepare(canvas);
  const pad = { top: 12, right: 12, bottom: 28, left: 62 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  if (plotWidth <= 0 || plotHeight <= 0) return;

  const earlies = early instanceof Float64Array ? null : early;
  const all = [
    ...(earlies ? earlies.flatMap((e) => [...e.values]) : early),
    ...late.flatMap((l) => [...l.values]),
  ];
  let low = Math.min(...all);
  let high = Math.max(...all);
  const span = high - low || 1;
  low -= span * 0.12;
  high += span * 0.12;

  const sx = (m) => pad.left + (m / 11) * plotWidth;
  const sy = (v) => pad.top + plotHeight - ((v - low) / (high - low)) * plotHeight;

  const grid = themeColor('--grid', '#e2e8f0');
  const text = themeColor('--muted', '#64748b');

  context.font = AXIS_FONT;
  context.strokeStyle = grid;
  context.fillStyle = text;
  context.textAlign = 'right';
  context.textBaseline = 'middle';

  const yStep = niceStep(high - low, 6);
  const yFormat = tickFormat(format, yStep);
  for (let v = Math.ceil(low / yStep) * yStep; v <= high; v += yStep) {
    const y = Math.round(sy(v)) + 0.5;
    context.beginPath();
    context.moveTo(pad.left, y);
    context.lineTo(pad.left + plotWidth, y);
    context.stroke();
    context.fillText(yFormat(v), pad.left - 8, y);
  }

  context.textAlign = 'center';
  context.textBaseline = 'top';
  const labels = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  labels.forEach((label, m) => {
    context.fillText(label, sx(m), pad.top + plotHeight + 7);
  });

  const line = (values, color, dash = []) => {
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.setLineDash(dash);
    context.beginPath();
    for (let m = 0; m < 12; m += 1) context.lineTo(sx(m), sy(values[m]));
    context.stroke();
    context.setLineDash([]);
  };
  // The early period dashed, so it reads as the baseline rather than as one
  // more series: in ink when shared, in each series' colour when not.
  if (earlies) for (const { colour, values } of earlies) line(values, colour, [5, 4]);
  else line(early, text, [5, 4]);
  for (const { colour, values } of late) line(values, colour);
}

/**
 * Every scenario's forcing at once, with one of them picked out.
 *
 * Context for the view above it: which of the fifteen pathways is being shown,
 * and where it sits among the rest. The CMIP7 markers carry the ScenarioMIP
 * team's own colours so a figure from here sits beside the published ones; the
 * CMIP6 SSPs stay neutral, as the reference set rather than the subject.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} options
 * @param {Array<{name: string, label: string, colour: string, years: number[],
 *   values: ArrayLike<number>}>} options.scenarios
 * @param {string[]} options.selected the scenarios to pick out
 * @param {[number, number]} options.range first and last year to draw
 * @param {string} options.yLabel
 * @param {(v: number) => string} [options.format] y tick formatter
 */
export function drawScenarioContext(
  canvas,
  { scenarios, selected, range, yLabel, format = (v) => v.toFixed(0) }
) {
  const { context, width, height } = prepare(canvas);
  const pad = { top: 12, right: 128, bottom: 30, left: 52 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  if (plotWidth <= 0 || plotHeight <= 0) return;

  const [firstYear, lastYear] = range;
  let low = Infinity;
  let high = -Infinity;
  for (const s of scenarios) {
    for (let i = 0; i < s.years.length; i += 1) {
      if (s.years[i] < firstYear || s.years[i] > lastYear) continue;
      low = Math.min(low, s.values[i]);
      high = Math.max(high, s.values[i]);
    }
  }
  const span = high - low || 1;
  low -= span * 0.06;
  high += span * 0.06;

  const sx = (year) => pad.left + ((year - firstYear) / (lastYear - firstYear)) * plotWidth;
  const sy = (v) => pad.top + plotHeight - ((v - low) / (high - low)) * plotHeight;

  const grid = themeColor('--grid', '#e2e8f0');
  const muted = themeColor('--muted', '#64748b');

  context.font = AXIS_FONT;
  context.strokeStyle = grid;
  context.fillStyle = muted;
  context.lineWidth = 1;
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
  const xStep = niceStep(lastYear - firstYear, 5);
  for (let year = Math.ceil(firstYear / xStep) * xStep; year <= lastYear; year += xStep) {
    context.fillText(String(year), sx(year), pad.top + plotHeight + 7);
  }

  // Emissions cross zero and the crossing is the point of several of these
  // scenarios, so mark it when it is in range.
  if (low < 0 && high > 0) {
    context.strokeStyle = muted;
    context.globalAlpha = 0.5;
    context.beginPath();
    const zero = Math.round(sy(0)) + 0.5;
    context.moveTo(pad.left, zero);
    context.lineTo(pad.left + plotWidth, zero);
    context.stroke();
    context.globalAlpha = 1;
  }

  const line = (scenario, emphasis) => {
    context.strokeStyle = emphasis ? scenario.selectedColour ?? scenario.colour : scenario.colour;
    context.globalAlpha = emphasis ? 1 : 0.42;
    context.lineWidth = emphasis ? 2.6 : 1.1;
    context.beginPath();
    let started = false;
    for (let i = 0; i < scenario.years.length; i += 1) {
      const year = scenario.years[i];
      if (year < firstYear || year > lastYear) continue;
      const x = sx(year);
      const y = sy(scenario.values[i]);
      if (started) context.lineTo(x, y);
      else {
        context.moveTo(x, y);
        started = true;
      }
    }
    context.stroke();
    context.globalAlpha = 1;
  };

  // Unselected first, so a highlighted one is never drawn under another.
  const picked = new Set(selected);
  for (const s of scenarios) if (!picked.has(s.name)) line(s, false);
  for (const s of scenarios) if (picked.has(s.name)) line(s, true);

  // Labels at the right-hand end, for the scenarios that asked for one.
  // Naming all fifteen is unreadable at this height, and the greyed reference
  // set does not need naming — the selected one always does.
  const ends = scenarios
    .filter((s) => s.labelled || picked.has(s.name))
    .map((s) => {
      let last = null;
      for (let i = 0; i < s.years.length; i += 1) {
        if (s.years[i] <= lastYear) last = s.values[i];
      }
      return { ...s, y: sy(last) };
    })
    .sort((a, b) => a.y - b.y);

  // Spread where they collide, then pull the whole run back inside the plot if
  // it overflowed the bottom: otherwise the lowest labels land off the canvas.
  spreadLabels(ends, pad.top + 6, pad.top + plotHeight, 13);

  context.textAlign = 'left';
  context.textBaseline = 'middle';
  for (const end of ends) {
    const emphasis = picked.has(end.name);
    context.font = emphasis ? `600 ${12}px ui-sans-serif, system-ui, sans-serif` : AXIS_FONT;
    context.fillStyle = emphasis ? end.selectedColour ?? end.colour : end.colour;
    context.globalAlpha = emphasis ? 1 : 0.65;
    context.fillText(end.label, pad.left + plotWidth + 8, end.y);
    context.globalAlpha = 1;
  }

  context.save();
  context.translate(12, pad.top + plotHeight / 2);
  context.rotate(-Math.PI / 2);
  context.textAlign = 'center';
  context.fillStyle = muted;
  context.font = AXIS_FONT;
  context.fillText(yLabel, 0, 0);
  context.restore();
}
