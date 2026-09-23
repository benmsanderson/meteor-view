/**
 * The explorer's state, in the URL.
 *
 * A view of this tool is an argument about the climate, and an argument you
 * cannot link to is one nobody can check. So everything that changes what is
 * drawn — including the drawn pathway and the RNG seed — round-trips through
 * the query string, and the same link always reproduces the same chart down to
 * the individual realizations.
 *
 * Defaults are omitted, so the common case stays short and readable:
 *
 *     ?v=pr&loc=regional%3ASAS&scn=ssp370&n=50
 */

/** Fixed default seed, so a link without one is still reproducible. */
export const DEFAULT_SEED = 20260921;

export const DEFAULTS = {
  variable: 'tas',
  location: 'global',
  scenario: 'ssp245',
  nRealizations: 20,
  seed: DEFAULT_SEED,
  pathway: null,
};

/** Centidegrees: 0.01 °C is far finer than anyone can draw with a pointer. */
const PATHWAY_SCALE = 100;

/**
 * Encode a drawn pathway as base64url.
 *
 * Int16 centidegrees rather than text: 86 years of `-1.23,4.56,...` runs to
 * ~500 characters, where this is 172 bytes and ~230 of base64. Signed 16-bit
 * covers ±327 °C, which is not a constraint anyone will meet.
 *
 * @param {ArrayLike<number>} values warming in °C, one per year
 * @returns {string}
 */
export function encodePathway(values) {
  const quantised = new Int16Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    quantised[i] = Math.max(-32768, Math.min(32767, Math.round(values[i] * PATHWAY_SCALE)));
  }
  const bytes = new Uint8Array(quantised.buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode a pathway, or return null if it is not readable.
 *
 * A malformed pathway in a hand-edited link should drop the user back to the
 * scenario, not break the page.
 *
 * @param {string} encoded
 * @param {number} expectedLength
 * @returns {Float64Array|null}
 */
export function decodePathway(encoded, expectedLength) {
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    if (bytes.length % 2 !== 0) return null;

    const quantised = new Int16Array(bytes.buffer);
    if (expectedLength && quantised.length !== expectedLength) return null;
    return Float64Array.from(quantised, (v) => v / PATHWAY_SCALE);
  } catch {
    return null;
  }
}

/**
 * Serialise state to a query string, omitting anything left at its default.
 *
 * @param {object} state
 * @returns {string} e.g. `?v=pr&loc=global`, or `''` when all defaults
 */
export function toQuery(state) {
  const params = new URLSearchParams();
  if (state.variable !== DEFAULTS.variable) params.set('v', state.variable);
  if (state.location !== DEFAULTS.location) params.set('loc', state.location);
  if (state.scenario !== DEFAULTS.scenario) params.set('scn', state.scenario);
  if (state.nRealizations !== DEFAULTS.nRealizations) {
    params.set('n', String(state.nRealizations));
  }
  if (state.seed !== DEFAULTS.seed) params.set('seed', String(state.seed));
  if (state.pathway) params.set('path', encodePathway(state.pathway));

  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * Parse state from a query string, falling back to defaults per field.
 *
 * Validation is deliberately per-field and forgiving: a link with one bad
 * parameter should still show something, since the most likely cause is a
 * truncated paste rather than an attack.
 *
 * @param {string} search `window.location.search`
 * @param {object} options
 * @param {string[]} options.locations valid location specifiers
 * @param {string[]} options.scenarios valid scenario names
 * @param {number} options.pathwayLength expected pathway length
 * @returns {object} state
 */
export function fromQuery(search, { locations = [], scenarios = [], pathwayLength = 0 } = {}) {
  const params = new URLSearchParams(search);
  const state = { ...DEFAULTS };

  const variable = params.get('v');
  if (variable === 'tas' || variable === 'pr') state.variable = variable;

  const location = params.get('loc');
  if (location && locations.includes(location)) state.location = location;

  const scenario = params.get('scn');
  if (scenario && scenarios.includes(scenario)) state.scenario = scenario;

  // Parse only what is present. `Number(null)` is 0, not NaN, so testing the
  // parsed value alone silently accepts an absent parameter as zero — which
  // for the seed would mean a copied link reproduced a *different* ensemble
  // than the view it was copied from, defeating the point of sharing it.
  const number = (name) => (params.has(name) ? Number(params.get(name)) : null);

  const n = number('n');
  // An open-ended realization count in a URL is a denial-of-service on the
  // person who clicks it, so cap it at what the UI itself offers.
  if (n !== null && Number.isInteger(n) && n >= 1 && n <= 200) state.nRealizations = n;

  const seed = number('seed');
  if (seed !== null && Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff) {
    state.seed = seed;
  }

  const pathway = params.get('path');
  if (pathway) state.pathway = decodePathway(pathway, pathwayLength);

  return state;
}

/**
 * The absolute URL for a state, for copying.
 *
 * @param {object} state
 * @param {string} [base] defaults to the current page without its query
 * @returns {string}
 */
export function toUrl(state, base) {
  const root = base ?? `${window.location.origin}${window.location.pathname}`;
  return `${root}${toQuery(state)}`;
}
