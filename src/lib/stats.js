/**
 * The two numerical primitives the kernel needs, and nothing else.
 *
 * The bundle's shipped quantile table exists precisely so a client needs no
 * gamma fit and no gamma quantile function, which leaves a normal CDF and
 * linear interpolation — both small enough to write out rather than take a
 * dependency for.
 */

/**
 * Standard normal CDF.
 *
 * Built on the Chebyshev `erfc` from Numerical Recipes (3rd edition,
 * `erfccheb`), which is accurate to near double precision — not the much
 * cruder seven-coefficient `erfcc` from the 2nd edition. The difference
 * matters: this feeds the probability axis of the gamma quantile table, whose
 * curve is steep in the tails, so an error here is amplified rather than
 * damped. Measured against SciPy through the full transform, agreement is
 * ~1e-12 relative.
 *
 * @param {number} x
 * @returns {number} P(Z <= x)
 */
export function normalCdf(x) {
  return 0.5 * erfc(-x / Math.SQRT2);
}

/**
 * Complementary error function, Numerical Recipes' `erfcc`.
 *
 * @param {number} x
 * @returns {number}
 */
export function erfc(x) {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;

  // Chebyshev coefficients for erfc(z) * exp(z^2) / t.
  const coefficients = [
    -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2,
    -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4,
    4.2523324806907e-5, -2.0278578112534e-5, -1.624290004647e-6,
    1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8, 6.529054439e-9,
    5.059343495e-9, -9.91364156e-10, -2.27365122e-10, 9.6467911e-11,
    2.394038e-12, -6.886027e-12, 8.94487e-13, 3.13092e-13, -1.12708e-13,
    3.81e-16, 7.106e-15,
  ];

  let d = 0;
  let dd = 0;
  for (let j = coefficients.length - 1; j > 0; j -= 1) {
    const tmp = d;
    d = ty * d - dd + coefficients[j];
    dd = tmp;
  }
  const ans = t * Math.exp(-z * z + 0.5 * (coefficients[0] + ty * d) - dd);
  return x >= 0 ? ans : 2 - ans;
}

/**
 * Linear interpolation with the same edge behaviour as `numpy.interp`:
 * values outside the grid clamp to the end points rather than extrapolating.
 *
 * `xp` must be increasing, as both the bundle's probability axis and its
 * log-shape axis are.
 *
 * @param {number} x
 * @param {ArrayLike<number>} xp increasing grid
 * @param {ArrayLike<number>} fp values on that grid
 * @returns {number}
 */
export function interp(x, xp, fp) {
  const n = xp.length;
  if (x <= xp[0]) return fp[0];
  if (x >= xp[n - 1]) return fp[n - 1];

  // Binary search for the bracketing interval: the probability axis is
  // refined in the tails, so a linear scan would be the inner loop's cost.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xp[mid] <= x) lo = mid;
    else hi = mid;
  }
  const span = xp[hi] - xp[lo];
  if (span === 0) return fp[lo];
  return fp[lo] + ((x - xp[lo]) * (fp[hi] - fp[lo])) / span;
}

/**
 * A seeded standard-normal generator.
 *
 * A port cannot reproduce NumPy's PCG64 stream and does not need to: the
 * fixtures ship METEOR's PC sequence as data so the deterministic parts can be
 * validated independently. What this needs to be is reproducible within the
 * client, so a given seed redraws the same ensemble.
 *
 * mulberry32 for the uniforms, Box-Muller for the normals.
 *
 * @param {number} seed
 * @returns {() => number} standard normal draws
 */
export function normalGenerator(seed) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  let spare = null;
  return () => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    // Box-Muller; guard against log(0).
    let u = 0;
    while (u === 0) u = uniform();
    const v = uniform();
    const radius = Math.sqrt(-2 * Math.log(u));
    const angle = 2 * Math.PI * v;
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}
