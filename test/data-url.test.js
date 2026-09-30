/**
 * Data requests carry the build's version, so a deploy never mixes old and
 * new files from a browser's cache.
 */

import { describe, expect, it } from 'vitest';

import { dataUrl } from '../src/lib/data-url.js';

describe('data URLs', () => {
  it('are plain where no build has defined a version, as under Node', () => {
    expect(dataUrl('/meteor-view/data/', 'models_v1.json')).toBe('/meteor-view/data/models_v1.json');
  });

  it('keep the file name intact before the tag', () => {
    expect(dataUrl('data/', 'summary_v1/point_48.87_2.33.json').split('?')[0]).toBe(
      'data/summary_v1/point_48.87_2.33.json'
    );
  });
});
