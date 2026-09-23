/**
 * Human-readable names for the locations a bundle carries.
 *
 * The bundle's location coordinate holds specifiers (`global`,
 * `regional:<AR6 code>`, `point:<lat>,<lon>`); these are only for display.
 * AR6 names come from regionmask, which is what METEOR itself uses.
 */

/** AR6 reference region code to name. */
export const AR6_NAMES = {
  "GIC": "Greenland/Iceland",
  "NWN": "N.W.North America",
  "NEN": "N.E.North America",
  "WNA": "W.North America",
  "CNA": "C.North America",
  "ENA": "E.North America",
  "NCA": "N.Central America",
  "SCA": "S.Central America",
  "CAR": "Caribbean",
  "NWS": "N.W.South America",
  "NSA": "N.South America",
  "NES": "N.E.South America",
  "SAM": "South American Monsoon",
  "SWS": "S.W.South America",
  "SES": "S.E.South America",
  "SSA": "S.South America",
  "NEU": "N.Europe",
  "WCE": "West&Central Europe",
  "EEU": "E.Europe",
  "MED": "Mediterranean",
  "SAH": "Sahara",
  "WAF": "Western Africa",
  "CAF": "Central Africa",
  "NEAF": "N.Eastern Africa",
  "SEAF": "S.Eastern Africa",
  "WSAF": "W.Southern Africa",
  "ESAF": "E.Southern Africa",
  "MDG": "Madagascar",
  "RAR": "Russian Arctic",
  "WSB": "W.Siberia",
  "ESB": "E.Siberia",
  "RFE": "Russian Far East",
  "WCA": "W.C.Asia",
  "ECA": "E.C.Asia",
  "TIB": "Tibetan Plateau",
  "EAS": "E.Asia",
  "ARP": "Arabian Peninsula",
  "SAS": "S.Asia",
  "SEA": "S.E.Asia",
  "NAU": "N.Australia",
  "CAU": "C.Australia",
  "EAU": "E.Australia",
  "SAU": "S.Australia",
  "NZ": "New Zealand",
  "EAN": "E.Antarctica",
  "WAN": "W.Antarctica",
  "ARO": "Arctic Ocean",
  "NPO": "N.Pacific Ocean",
  "EPO": "Equatorial. Pacific Ocean",
  "SPO": "S.Pacific Ocean",
  "NAO": "N.Atlantic Ocean",
  "EAO": "Equatorial. Atlantic Ocean",
  "SAO": "S.Atlantic Ocean",
  "ARS": "Arabian Sea",
  "BOB": "Bay of Bengal",
  "EIO": "Equatorial. Indic Ocean",
  "SIO": "S.Indic Ocean",
  "SOO": "Southern Ocean"
};

/** The point locations this bundle was exported with. */
export const CITY_NAMES = {
  "point:51.5,-0.1": "London",
  "point:40.7,-74": "New York",
  "point:-23.5,-46.6": "São Paulo",
  "point:6.5,3.4": "Lagos",
  "point:30,31.2": "Cairo",
  "point:19.1,72.9": "Mumbai",
  "point:39.9,116.4": "Beijing",
  "point:-33.9,151.2": "Sydney"
};

/**
 * A display label for a location specifier.
 *
 * @param {string} spec e.g. `regional:NEU`
 * @returns {string}
 */
export function placeLabel(spec) {
  if (spec === 'global') return 'Global mean';
  if (spec.startsWith('regional:')) {
    const code = spec.slice('regional:'.length);
    return AR6_NAMES[code] ? `${AR6_NAMES[code]} (${code})` : code;
  }
  if (spec.startsWith('point:')) {
    return CITY_NAMES[spec] || spec.slice('point:'.length);
  }
  return spec;
}
