import { existsSync, readFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { defineConfig } from 'vite';

/**
 * This build's data version, which every data request carries
 * (src/lib/data-url.js): the pinned artifact release and when the build ran,
 * so a new deploy never reads a previous one's files from a browser's cache.
 */
function dataVersion() {
  const pin = 'data/artifacts_v1.json';
  const release = existsSync(pin) ? JSON.parse(readFileSync(pin, 'utf8')).release : 'local';
  return `${release}.${Date.now().toString(36)}`;
}

/**
 * Copy the emulator bundles into the build.
 *
 * They live in `data/` rather than `public/` because they are the repository's
 * subject matter, not web assets, and because `scripts/` regenerates them
 * there. Vite only copies `public/`, so this moves them across at build time —
 * a few lines rather than another dependency.
 *
 * Bundles, pattern artifacts and the `pr` climatology, not golden fixtures:
 * the fixtures exist for the test suite and would be dead weight in a
 * deployment. The pattern artifacts are 2 MB each and are fetched only when a
 * visitor asks for a map or a custom region, so they cost nothing on first
 * load. The climatology is the precipitation map's percent-change denominator;
 * leaving it out breaks that map with a 404 and nothing else.
 */
function copyBundles() {
  return {
    name: 'copy-emulator-bundles',
    apply: 'build',
    async closeBundle() {
      await cp('data', 'dist/data', {
        recursive: true,
        filter: (source) =>
          !source.endsWith('.nc') ||
          source.includes('_bundle_v1.nc') ||
          source.includes('_landfrac_v1.nc') ||
          source.includes('_pattern_v1.nc') ||
          source.includes('_climatology_v1.nc'),
      });
    },
  };
}

export default defineConfig({
  // GitHub Pages serves this project at /<repository>/.
  base: process.env.PAGES_BASE ?? '/meteor-view/',
  plugins: [copyBundles()],
  define: {
    __DATA_VERSION__: JSON.stringify(dataVersion()),
  },
  // The ensemble worker imports the kernel lazily, as the page does; only ES
  // module workers can split code that way.
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
  },
});
