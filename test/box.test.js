/**
 * Drawn regions across the antimeridian.
 *
 * Longitude is ambiguous on a globe: 170°E to 170°W bounds both a 20° strip of
 * the Pacific and the 340° remainder. Getting that wrong gives plausible
 * numbers for the wrong place, so both halves of the path are tested: the
 * drag that makes a box, and the predicate that turns one into gridpoints.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PatternArtifact, boxRegion } from '../src/lib/pattern.js';
import { boxFromDrag } from '../src/app/map.js';

const artifact = new PatternArtifact(
  readFileSync(new URL('../data/meteor_NorESM2-MM_tas_pattern_v1.nc', import.meta.url))
);

/** Which of the artifact's longitudes a box selects, at the equator. */
function selectedLongitudes(box) {
  const inside = boxRegion(box);
  return [...artifact.lon].filter((lon) => inside(0, lon));
}

describe('boxFromDrag', () => {
  it('goes east from where a drag started', () => {
    expect(boxFromDrag({ lat: 10, lon: 20 }, -5, 30)).toEqual({
      south: -5,
      north: 10,
      west: 20,
      east: 50,
    });
  });

  it('puts the start at the east edge of a westward drag', () => {
    expect(boxFromDrag({ lat: 0, lon: 20 }, 5, -30)).toEqual({
      south: 0,
      north: 5,
      west: -10,
      east: 20,
    });
  });

  it('crosses the antimeridian as the strip drawn, either way', () => {
    // 170°E eastward 20° to 170°W, and the same strip dragged back.
    const eastward = boxFromDrag({ lat: -10, lon: 170 }, 10, 20);
    expect(eastward).toMatchObject({ west: 170, east: 190 });
    const westward = boxFromDrag({ lat: -10, lon: -170 }, 10, -20);
    expect(westward).toMatchObject({ west: 170, east: 190 });
  });

  it('never spans more than the globe', () => {
    const box = boxFromDrag({ lat: 0, lon: 0 }, 10, 500);
    expect(box.east - box.west).toBe(360);
  });
});

describe('boxRegion', () => {
  it('selects only the strip for a box across the antimeridian', () => {
    const strip = selectedLongitudes({ south: -10, north: 10, west: 170, east: 190 });
    // The grid is about 1.25° apart, so 20° of it is 16 or 17 columns.
    expect(strip.length).toBeGreaterThanOrEqual(15);
    expect(strip.length).toBeLessThanOrEqual(18);
    expect(strip.every((lon) => lon >= 170 && lon <= 190)).toBe(true);
  });

  it('reads the older east-before-west form the same way', () => {
    expect(selectedLongitudes({ south: -10, north: 10, west: 170, east: -170 })).toEqual(
      selectedLongitudes({ south: -10, north: 10, west: 170, east: 190 })
    );
  });

  it('selects every longitude for a box spanning the globe', () => {
    // -180 and 180 wrap to the same meridian; this used to select only it.
    const all = selectedLongitudes({ south: -90, north: 90, west: -180, east: 180 });
    expect(all.length).toBe(artifact.lon.length);
  });
});
