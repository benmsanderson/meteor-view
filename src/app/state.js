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
 *
 * The model is part of that state too: the same scenario under a different
 * model is a different claim, so a link that dropped it would be ambiguous.
 *
 * Several scenarios can be selected at once, `scn=ssp126,ssp585`, and with two
 * or more the maps compare a pair of them, `cmp=ssp126,ssp585`. A link from
 * before multi-selection, `scn=ssp370`, is simply a selection of one.
 */

/**
 * Most scenarios a view can hold.
 *
 * Beyond about six, overlaid ensembles stop being readable and the run time
 * adds up; and a link must not be able to ask for all fifteen at 200
 * realizations each.
 */
export const MAX_SCENARIOS = 6;

/** Fixed default seed, so a link without one is still reproducible. */
export const DEFAULT_SEED = 20260921;

export const DEFAULTS = {
  model: 'NorESM2-MM',
  variable: 'tas',
  location: 'global',
  scenarios: ['ssp245'],
  compare: null,
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
  if (state.model !== DEFAULTS.model) params.set('m', state.model);
  if (state.variable !== DEFAULTS.variable) params.set('v', state.variable);
  if (state.location !== DEFAULTS.location) params.set('loc', state.location);
  if (state.scenarios.join(',') !== DEFAULTS.scenarios.join(',')) {
    params.set('scn', state.scenarios.join(','));
  }
  // Only when it is not what the page would choose anyway.
  if (state.compare && state.compare.join(',') !== defaultCompare(state.scenarios)?.join(',')) {
    params.set('cmp', state.compare.join(','));
  }
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
 * @param {string[]} [options.models] models with artifacts on the site
 * @returns {object} state
 */
export function fromQuery(search, { locations = [], scenarios = [], models = [] } = {}) {
  const params = new URLSearchParams(search);
  const state = { ...DEFAULTS };

  const model = params.get('m');
  if (model && models.includes(model)) state.model = model;

  const variable = params.get('v');
  if (variable === 'tas' || variable === 'pr') state.variable = variable;

  const location = params.get('loc');
  if (location && locations.includes(location)) state.location = location;

  // Unknown names dropped, duplicates dropped, capped; an empty result falls
  // back to the default rather than showing nothing.
  const requested = (params.get('scn') ?? '')
    .split(',')
    .filter((name, i, all) => scenarios.includes(name) && all.indexOf(name) === i)
    .slice(0, MAX_SCENARIOS);
  if (requested.length) state.scenarios = requested;

  state.compare = defaultCompare(state.scenarios);
  const pair = (params.get('cmp') ?? '').split(',');
  if (
    pair.length === 2 &&
    pair[0] !== pair[1] &&
    pair.every((name) => state.scenarios.includes(name))
  ) {
    state.compare = pair;
  }

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
 * The pair the maps compare when nothing says otherwise: the first two
 * selected. Null with fewer than two, when there is nothing to compare.
 *
 * @param {string[]} scenarios
 * @returns {[string, string]|null}
 */
export function defaultCompare(scenarios) {
  return scenarios.length >= 2 ? [scenarios[0], scenarios[1]] : null;
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
