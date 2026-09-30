/**
 * The URL of a data file, tagged with the build's data version.
 *
 * Data files keep their names from one release to the next, and GitHub Pages
 * lets a browser reuse a file for ten minutes. Without a tag, a visitor who
 * came before a deploy could get the new page with an old model bundle: a
 * 67-location bundle beside a 252-city list, say. The tag changes with every
 * build, so a new page never asks for a file it might get from the old
 * cache, while files are still cached within one build.
 *
 * The version is defined by vite.config.js at build time; in Node, and in
 * the dev server before a build, there is none and the URL is untagged.
 */

/* global __DATA_VERSION__ */
const VERSION = typeof __DATA_VERSION__ === 'string' ? __DATA_VERSION__ : '';

/**
 * @param {string} base the data directory, ending in a slash
 * @param {string} name a file within it
 */
export function dataUrl(base, name) {
  return VERSION ? `${base}${name}?v=${encodeURIComponent(VERSION)}` : `${base}${name}`;
}
