/**
 * The explorer's state, in the URL.
 *
 * A view of this tool is an argument about the climate, and an argument you
 * cannot link to is one nobody can check. So everything that changes what is
 * drawn — including the RNG seed — round-trips through the query string, and
 * the same link always reproduces the same chart down to the individual
 * realizations.
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
};

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
 * @returns {object} state
 */
export function fromQuery(search, { locations = [], scenarios = [] } = {}) {
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
