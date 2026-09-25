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
 * A view compares either scenarios or models, never both at once. Comparing
 * scenarios (the default), several can be selected, `scn=ssp126,ssp585`, under
 * one model. Comparing models, `by=models`, several models, `m=NorESM2-MM,
 * CanESM5`, run one scenario. With two or more, the maps compare a pair of
 * whichever is being compared, `cmp=a,b`. Links from before any of this —
 * `scn=ssp370`, `m=CanESM5` — are selections of one.
 */

/**
 * Most scenarios a view can hold.
 *
 * Beyond about six, overlaid ensembles stop being readable and the run time
 * adds up; and a link must not be able to ask for all fifteen at 200
 * realizations each.
 */
export const MAX_SCENARIOS = 6;

/** Most models a view can compare, for the same reasons. */
export const MAX_MODELS = 6;

/** Fixed default seed, so a link without one is still reproducible. */
export const DEFAULT_SEED = 20260921;

export const DEFAULTS = {
  compareBy: 'scenarios',
  models: ['NorESM2-MM'],
  variable: 'tas',
  location: 'global',
  scenarios: ['ssp245'],
  compare: null,
  nRealizations: 20,
  seed: DEFAULT_SEED,
  baseline: 'pi',
};

/**
 * Serialise state to a query string, omitting anything left at its default.
 *
 * @param {object} state
 * @returns {string} e.g. `?v=pr&loc=global`, or `''` when all defaults
 */
export function toQuery(state) {
  const params = new URLSearchParams();
  if (state.compareBy !== DEFAULTS.compareBy) params.set('by', state.compareBy);
  if (state.models.join(',') !== DEFAULTS.models.join(',')) params.set('m', state.models.join(','));
  if (state.variable !== DEFAULTS.variable) params.set('v', state.variable);
  if (state.location !== DEFAULTS.location) params.set('loc', state.location);
  if (state.scenarios.join(',') !== DEFAULTS.scenarios.join(',')) {
    params.set('scn', state.scenarios.join(','));
  }
  // Only when it is not what the page would choose anyway.
  const compared = state.compareBy === 'models' ? state.models : state.scenarios;
  if (state.compare && state.compare.join(',') !== defaultCompare(compared)?.join(',')) {
    params.set('cmp', state.compare.join(','));
  }
  if (state.nRealizations !== DEFAULTS.nRealizations) {
    params.set('n', String(state.nRealizations));
  }
  if (state.seed !== DEFAULTS.seed) params.set('seed', String(state.seed));
  if (state.baseline !== DEFAULTS.baseline) params.set('ref', state.baseline);

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

  // Unknown names dropped, duplicates dropped, capped; an empty result falls
  // back to the default rather than showing nothing.
  const list = (name, valid, cap) =>
    (params.get(name) ?? '')
      .split(',')
      .filter((item, i, all) => valid.includes(item) && all.indexOf(item) === i)
      .slice(0, cap);

  if (params.get('by') === 'models') state.compareBy = 'models';

  const requestedModels = list('m', models, MAX_MODELS);
  if (requestedModels.length) state.models = requestedModels;

  const baseline = params.get('ref');
  if (baseline === 'pi' || baseline === 'recent') state.baseline = baseline;

  const variable = params.get('v');
  if (variable === 'tas' || variable === 'pr') state.variable = variable;

  const location = params.get('loc');
  if (location && locations.includes(location)) state.location = location;

  const requested = list('scn', scenarios, MAX_SCENARIOS);
  if (requested.length) state.scenarios = requested;

  // Only what is being compared can be many; the other is a single choice.
  if (state.compareBy === 'models') state.scenarios = state.scenarios.slice(0, 1);
  else state.models = state.models.slice(0, 1);

  const compared = state.compareBy === 'models' ? state.models : state.scenarios;
  state.compare = defaultCompare(compared);
  const pair = (params.get('cmp') ?? '').split(',');
  if (pair.length === 2 && pair[0] !== pair[1] && pair.every((name) => compared.includes(name))) {
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
 * @param {string[]} items the scenarios or models being compared
 * @returns {[string, string]|null}
 */
export function defaultCompare(items) {
  return items.length >= 2 ? [items[0], items[1]] : null;
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
