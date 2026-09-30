/**
 * Heating and cooling degree days from monthly mean temperature.
 *
 * Port of METEOR's `DegreeDaysCalculator` (meteor/impacts/calculators/
 * degree_days.py), which follows Isaac and van Vuuren (2009), Energy Policy
 * 37, 507-521, with the correction of Erbs et al. (1983), Solar Energy 28,
 * 293-302: daily temperatures are taken to be normally distributed about the
 * monthly mean, with a spread that shrinks as the month warms and grows with
 * the size of the seasonal cycle, so degree days follow from monthly means
 * alone.
 *
 * As METEOR does, each month's degree days go wholly to heating or wholly to
 * cooling, by which side of the base temperature its mean falls. The paper's
 * formula would also give a month near the base a little of the other kind;
 * METEOR drops that tail, and so does this, so the two agree.
 *
 * Checked against METEOR itself in test/degree-days.test.js.
 */

/** METEOR's defaults: base temperature and the Isaac & van Vuuren constants. */
export const DEGREE_DAYS = {
  base: 18,
  sigmaC1: 1.45,
  sigmaC2: 0.29,
  sigmaC3: 0.664,
  aC1: 1.698,
};

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Monthly heating and cooling degree days for one series.
 *
 * @param {ArrayLike<number>} temperature monthly means in °C, starting in
 *   January, as a run's window does
 * @param {object} [options]
 * @param {number} [options.base] base temperature, °C
 * @returns {{hdd: Float64Array, cdd: Float64Array}} degree days per month
 */
export function degreeDays(temperature, { base = DEGREE_DAYS.base } = {}) {
  const { sigmaC1, sigmaC2, sigmaC3, aC1 } = DEGREE_DAYS;
  const n = temperature.length;

  // The spread of the series' own mean seasonal cycle: the standard deviation
  // of its twelve calendar-month means, population form, as xarray's .std().
  const sums = new Float64Array(12);
  const counts = new Float64Array(12);
  for (let t = 0; t < n; t += 1) {
    sums[t % 12] += temperature[t];
    counts[t % 12] += 1;
  }
  const months = [];
  for (let m = 0; m < 12; m += 1) if (counts[m]) months.push(sums[m] / counts[m]);
  const mean = months.reduce((s, v) => s + v, 0) / months.length;
  const sigmaY = Math.sqrt(months.reduce((s, v) => s + (v - mean) ** 2, 0) / months.length);

  const hdd = new Float64Array(n);
  const cdd = new Float64Array(n);
  for (let t = 0; t < n; t += 1) {
    const T = temperature[t];
    const days = DAYS_IN_MONTH[t % 12];
    const root = Math.sqrt(days);
    // Floored, as METEOR does: the linear fit goes negative in hot months.
    const sigmaM = Math.max(sigmaC1 - sigmaC2 * T + sigmaC3 * sigmaY, 0.5);
    const a = aC1 * root;
    const h = Math.abs(base - T) / (sigmaM * root);
    const x = a * h;
    // For large x the log term tends to x, and the bracket to h.
    const bracket = x > 100 ? h : h / 2 + Math.log(Math.exp(-x) + Math.exp(x)) / (2 * a);
    let dd = sigmaM * days ** 1.5 * bracket;
    if (!(dd >= 0) || !Number.isFinite(dd)) dd = 0;
    if (T < base) hdd[t] = dd;
    else if (T > base) cdd[t] = dd;
  }
  return { hdd, cdd };
}

/** Sum a monthly series into calendar years. */
export function annualSums(monthly) {
  const years = Math.floor(monthly.length / 12);
  const out = new Float64Array(years);
  for (let y = 0; y < years; y += 1) {
    let sum = 0;
    for (let m = 0; m < 12; m += 1) sum += monthly[y * 12 + m];
    out[y] = sum;
  }
  return out;
}
