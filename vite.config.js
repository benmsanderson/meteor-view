import { cp } from 'node:fs/promises';
import { defineConfig } from 'vite';

/**
 * Copy the emulator bundles into the build.
 *
 * They live in `data/` rather than `public/` because they are the repository's
 * subject matter, not web assets, and because `scripts/` regenerates them
 * there. Vite only copies `public/`, so this moves them across at build time —
 * a few lines rather than another dependency.
 *
 * Only the bundles: the golden fixtures are twice their size and exist for the
 * test suite, so shipping them would double the payload for no benefit to a
 * visitor.
 */
function copyBundles() {
  return {
    name: 'copy-emulator-bundles',
    apply: 'build',
    async closeBundle() {
      await cp('data', 'dist/data', {
        recursive: true,
        filter: (source) =>
          !source.endsWith('.nc') || source.includes('_bundle_v1.nc'),
      });
    },
  };
}

export default defineConfig({
  // GitHub Pages serves this project at /<repository>/.
  base: process.env.PAGES_BASE ?? '/meteor-view/',
  plugins: [copyBundles()],
  build: {
    target: 'es2022',
  },
});
