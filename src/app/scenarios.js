/**
 * Naming and grouping the scenarios a bundle carries.
 *
 * Two generations sit in the same menu and they are **not** interchangeable.
 * The CMIP6 SSPs and the CMIP7 ScenarioMIP markers are different scenario
 * sets, made years apart, harmonized to different vintages of history. Both
 * are driven here through the same simple climate model — CICERO-SCM, the one
 * METEOR uses — so the comparison is at least internally consistent, which it
 * would not be had we taken CMIP7's forcing from its own MAGICC assessment.
 *
 * That was a deliberate choice: MAGICC and CICERO differ by about 0.74 W/m² on
 * present-day anthropogenic forcing, so mixing them would have put a
 * model-versus-model difference into a scenario-versus-scenario comparison
 * with nothing on screen to say so.
 */

/** Display names, by the identifier a bundle stores. */
const LABELS = {
  ssp119: 'SSP1-1.9',
  ssp126: 'SSP1-2.6',
  ssp245: 'SSP2-4.5',
  ssp370: 'SSP3-7.0',
  ssp434: 'SSP4-3.4',
  ssp460: 'SSP4-6.0',
  'ssp534-over': 'SSP5-3.4-OS',
  ssp585: 'SSP5-8.5',

  'cmip7-very-low': 'Very Low (SSP1)',
  'cmip7-low': 'Low (SSP2)',
  'cmip7-low-to-negative': 'Low to Negative (SSP2)',
  'cmip7-medium-to-low': 'Medium to Low (SSP2)',
  'cmip7-medium': 'Medium (SSP2)',
  'cmip7-high-to-low': 'High to Low (SSP5)',
  'cmip7-high': 'High (SSP3)',
};

/** Which generation a scenario belongs to. */
export function scenarioFamily(name) {
  return name.startsWith('cmip7-') ? 'CMIP7 ScenarioMIP' : 'CMIP6 SSPs';
}

/** A display name, falling back to the raw identifier. */
export function scenarioLabel(name) {
  return LABELS[name] ?? name.toUpperCase();
}

/**
 * Group scenarios by generation, newest first.
 *
 * CMIP7 leads because it is the reason to reach for this tool: those scenarios
 * have emissions pathways but, for most models, no ESM output yet.
 *
 * @param {string[]} names as the bundle lists them
 * @returns {Array<{family: string, names: string[]}>}
 */
export function groupScenarios(names) {
  const groups = new Map();
  for (const name of names) {
    const family = scenarioFamily(name);
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(name);
  }
  // Menu order follows the list above rather than the bundle's, which is
  // alphabetical and would put "High" before "Low".
  const order = Object.keys(LABELS);
  for (const list of groups.values()) {
    list.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === 'CMIP7 ScenarioMIP' ? -1 : b === 'CMIP7 ScenarioMIP' ? 1 : 0))
    .map(([family, list]) => ({ family, names: list }));
}
