/**
 * Cities on the map: which show at a zoom, and which one a click near a dot
 * means.
 */

import { describe, expect, it } from 'vitest';

import { CITY_ZOOM, citiesAtZoom, cityNear, defaultView } from '../src/app/map.js';

const CITIES = [
  { spec: 'paris', lat: 48.87, lon: 2.33, population: 11e6, capital: true },
  { spec: 'lyon', lat: 45.76, lon: 4.84, population: 2.6e6, capital: false },
  { spec: 'oslo', lat: 59.92, lon: 10.75, population: 0.8e6, capital: true },
  { spec: 'tokyo', lat: 35.69, lon: 139.75, population: 3.2e7, capital: true },
];

describe('cities on the map', () => {
  it('show none over the whole world, the big and the capitals zoomed in, all further in', () => {
    expect(citiesAtZoom(CITIES, 1)).toEqual([]);
    expect(citiesAtZoom(CITIES, CITY_ZOOM.some).map((c) => c.spec)).toEqual(['paris', 'oslo', 'tokyo']);
    expect(citiesAtZoom(CITIES, CITY_ZOOM.all)).toHaveLength(4);
  });

  it('take a click near their dot, and leave one further off to the region', () => {
    // The world at 800 x 400: 0.45 degrees a pixel. Paris sits at x ~ 405, y ~ 91.
    const view = defaultView();
    const x = 400 + 2.33 / 0.45;
    const y = 200 - 48.87 / 0.45;
    expect(cityNear(CITIES, view, 800, 400, x + 3, y - 2, 10)?.spec).toBe('paris');
    expect(cityNear(CITIES, view, 800, 400, x + 30, y, 10)).toBeNull();
  });

  it('pick the nearer of two close dots', () => {
    const view = { zoom: 8, centreLat: 47, centreLon: 4 };
    // Zoomed in on France: Paris and Lyon are far apart in pixels now.
    const between = cityNear(CITIES, view, 800, 400, 400, 200, 400);
    expect(['paris', 'lyon']).toContain(between.spec);
    const nearLyon = cityNear(CITIES, view, 800, 400, 400 + (4.84 - 4) / (360 / 6400), 200 - (45.76 - 47) / (180 / 3200), 12);
    expect(nearLyon.spec).toBe('lyon');
  });
});

describe('the region under a point', async () => {
  const { readFileSync } = await import('node:fs');
  const { regionAt } = await import('../src/app/map.js');
  const outlines = JSON.parse(readFileSync(new URL('../data/ar6_regions_v1.json', import.meta.url)));
  const regions = outlines.regions ?? outlines;
  const at = (lat, lon) => regionAt(regions, { lat, lon })?.code;

  it('keeps the North Pacific, split at the date line, in the Pacific', () => {
    // Its rings have vertices on ±180; wrapping those once put the North
    // Atlantic inside the North Pacific and the western Pacific outside it.
    expect(at(43, -19)).toBe('NAO');
    expect(at(30, -40)).toBe('NAO');
    expect(at(40, 150)).toBe('NPO');
    expect(at(40, -150)).toBe('NPO');
    expect(at(40, 179.9)).toBe('NPO');
    expect(at(40, -179.9)).toBe('NPO');
  });

  it('finds land regions whichever longitude convention the point uses', () => {
    expect(at(48.9, 2.3)).toBe('WCE');
    expect(at(40.7, -74.0)).toBe('ENA');
    expect(at(40.7, 286.0)).toBe('ENA');
  });
});
