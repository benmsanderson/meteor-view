/**
 * Finding a place by typing: forgiving about accents and case, and ranking a
 * name that starts with the query above one that merely contains it.
 */

import { describe, expect, it } from 'vitest';

import { fold, searchPlaces } from '../src/app/place-search.js';

const PLACES = [
  { spec: 'regional:WCE', label: 'West & Central Europe (WCE)', group: 'AR6 regions' },
  { spec: 'regional:SAS', label: 'S.Asia (SAS)', group: 'AR6 regions' },
  { spec: 'p1', label: 'São Paulo', group: 'Cities: South America', keywords: 'Brazil, South America' },
  { spec: 'p2', label: 'Paris', group: 'Cities: Europe', keywords: 'France, Europe' },
  { spec: 'p3', label: 'Ho Chi Minh City', group: 'Cities: Asia', keywords: 'Vietnam, Asia' },
  { spec: 'p4', label: 'Hyderabad, India', group: 'Cities: Asia', keywords: 'India, Asia' },
  { spec: 'p5', label: 'Hyderabad, Pakistan', group: 'Cities: Asia', keywords: 'Pakistan, Asia' },
];
const specs = (query) => searchPlaces(PLACES, query).map((p) => p.spec);

describe('place search', () => {
  it('ignores accents and case', () => {
    expect(fold('São Paulo')).toBe('sao paulo');
    expect(specs('SAO')).toContain('p1');
  });

  it('puts names that start with the query first', () => {
    expect(specs('pa')[0]).toBe('p2');
    expect(specs('pa')).toContain('p1'); // Paulo, a later word
  });

  it('finds a place by a word inside its name, its country or its region code', () => {
    expect(specs('minh')).toEqual(['p3']);
    expect(specs('france')).toEqual(['p2']);
    expect(specs('wce')).toEqual(['regional:WCE']);
    expect(specs('pakistan')).toEqual(['p5']);
  });

  it('puts the bigger of two equal matches first', () => {
    const japan = [
      { spec: 'f', label: 'Fukuoka', group: 'Asia', keywords: 'Japan', weight: 2.8e6 },
      { spec: 't', label: 'Tokyo', group: 'Asia', keywords: 'Japan', weight: 3.2e7 },
    ];
    expect(searchPlaces(japan, 'japan').map((p) => p.spec)).toEqual(['t', 'f']);
  });

  it('lists everything for an empty query, and nothing for nonsense', () => {
    expect(specs('  ')).toHaveLength(PLACES.length);
    expect(specs('zzz')).toEqual([]);
  });
});
