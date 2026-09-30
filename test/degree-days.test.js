/**
 * Degree days against METEOR's own calculator.
 *
 * The reference is METEOR's DegreeDaysCalculator run on synthetic series that
 * exercise every branch (scripts/make_degree_days_reference.py): all heating,
 * all cooling, months either side of the base, the spread at its floor, and a
 * warming trend carrying months across the base.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { annualSums, degreeDays } from '../src/lib/degree-days.js';

const reference = JSON.parse(
  readFileSync(new URL('./fixtures/degree_days_reference.json', import.meta.url))
);

describe.each(Object.entries(reference.cases))('degree days, %s', (_name, expected) => {
  const { hdd, cdd } = degreeDays(expected.temperature, { base: reference.base_temperature });

  it('matches METEOR month by month', () => {
    expected.monthly_hdd.forEach((v, t) => expect(hdd[t]).toBeCloseTo(v, 9));
    expected.monthly_cdd.forEach((v, t) => expect(cdd[t]).toBeCloseTo(v, 9));
  });

  it('matches METEOR year by year', () => {
    expect(Array.from(annualSums(hdd))).toEqual(
      expected.annual_hdd.map((v) => expect.closeTo(v, 7))
    );
    expect(Array.from(annualSums(cdd))).toEqual(
      expected.annual_cdd.map((v) => expect.closeTo(v, 7))
    );
  });
});

describe('degree days', () => {
  it('never both heat and cool in one month', () => {
    const { hdd, cdd } = degreeDays(reference.cases.temperate.temperature);
    hdd.forEach((v, t) => expect(v === 0 || cdd[t] === 0).toBe(true));
  });

  it('come to about a month of degrees far from the base', () => {
    // A January mean of 8 °C, far below 18: nearly 31 days x 10 degrees.
    const { hdd } = degreeDays(Float64Array.from({ length: 12 }, (_, m) => (m === 0 ? 8 : 20)));
    expect(hdd[0]).toBeGreaterThan(300);
    expect(hdd[0]).toBeLessThan(320);
  });
});
