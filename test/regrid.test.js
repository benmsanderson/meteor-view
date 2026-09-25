/**
 * Moving a field from one model's grid to another's, for the model-difference
 * map. Bilinear interpolation is exact for fields linear in each coordinate,
 * which is what these lean on, plus the two places it can go quietly wrong:
 * the longitude seam, and blanks.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PatternArtifact } from '../src/lib/pattern.js';
import { regrid, sameGrid } from '../src/app/map.js';

const artifact = (model) =>
  new PatternArtifact(readFileSync(new URL(`../data/meteor_${model}_tas_pattern_v1.nc`, import.meta.url)));
const noresm = artifact('NorESM2-MM');
const canesm = artifact('CanESM5');

const grid = (lat, lon, f) => ({
  lat,
  lon,
  field: Float64Array.from({ length: lat.length * lon.length }, (_, k) =>
    f(lat[Math.floor(k / lon.length)], lon[k % lon.length])
  ),
});

describe('regrid', () => {
  it('leaves a field on its own grid unchanged', () => {
    const source = grid(canesm.lat, canesm.lon, (la, lo) => Math.sin(la) + Math.cos(lo));
    const out = regrid(source, canesm.lat, canesm.lon);
    out.forEach((v, k) => expect(v).toBeCloseTo(source.field[k], 12));
  });

  it('is exact for a field linear in latitude', () => {
    const source = grid(noresm.lat, noresm.lon, (la) => 2 * la + 5);
    const out = regrid(source, canesm.lat, canesm.lon);
    const inside = (la) => la >= noresm.lat[0] && la <= noresm.lat[noresm.lat.length - 1];
    canesm.lat.forEach((la, i) => {
      if (!inside(la)) return;
      expect(out[i * canesm.lon.length]).toBeCloseTo(2 * la + 5, 9);
    });
  });

  it('interpolates across the longitude seam rather than off the end', () => {
    // Two columns, at 0° and 180°: a point at 270° lies half way between 180°
    // and 360° = 0°, so must read the mean of the two.
    const source = { lat: [-10, 10], lon: [0, 180], field: [0, 10, 0, 10] };
    const [value] = regrid(source, [0], [270]);
    expect(value).toBeCloseTo(5, 12);
  });

  it('keeps blanks blank instead of smearing them', () => {
    const source = { lat: [-10, 10], lon: [0, 180], field: [NaN, 10, 0, 10] };
    expect(Number.isNaN(regrid(source, [0], [45])[0])).toBe(true);
  });

  it('keeps a real map\'s global mean moving NorESM2-MM onto CanESM5\'s grid', () => {
    // Pattern mode 0, experiment 0: a smooth warming pattern.
    const space = noresm.nLat * noresm.nLon;
    const field = Float64Array.from(noresm.get('pattern_v').subarray(0, space));
    const moved = regrid({ field, lat: noresm.lat, lon: noresm.lon }, canesm.lat, canesm.lon);
    const mean = (f, lat, nLon) => {
      let sum = 0;
      let weight = 0;
      for (let i = 0; i < lat.length; i += 1) {
        const w = Math.cos((lat[i] * Math.PI) / 180);
        for (let j = 0; j < nLon; j += 1) {
          sum += w * f[i * nLon + j];
          weight += w;
        }
      }
      return sum / weight;
    };
    const before = mean(field, noresm.lat, noresm.nLon);
    const after = mean(moved, canesm.lat, canesm.nLon);
    expect(Math.abs(after - before)).toBeLessThan(0.01 * Math.abs(before));
  });

  it('knows when two grids are the same', () => {
    expect(sameGrid(noresm, noresm)).toBe(true);
    expect(sameGrid(noresm, canesm)).toBe(false);
  });
});
