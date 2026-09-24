/**
 * The worker pool must be invisible in the numbers.
 *
 * Node has no browser Worker, so these drive the pool with a stand-in that
 * answers through the same service the real worker uses, asynchronously and
 * out of order. What must hold is that the result is bit-identical to
 * generating on the page, which is what keeps a shared link exact.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { Bundle } from '../src/lib/bundle.js';
import { Explorer } from '../src/app/explorer.js';
import { createEnsembleService } from '../src/app/ensemble-service.js';
import { EnsembleRunner } from '../src/app/runner.js';

const DATA = new URL('../data/', import.meta.url);

function loadExplorer(model) {
  const load = (variable) =>
    new Bundle(readFileSync(new URL(`meteor_${model}_${variable}_bundle_v1.nc`, DATA)));
  return Promise.resolve(new Explorer({ tas: load('tas'), pr: load('pr') }));
}

/** A Worker look-alike: replies later, and the later the earlier it was asked. */
function fakeWorker() {
  const answer = createEnsembleService(loadExplorer);
  const listeners = { message: [], error: [] };
  let delay = 30;
  return {
    addEventListener: (type, fn) => listeners[type].push(fn),
    postMessage(message) {
      // Clone as postMessage would, so nothing is shared by accident.
      const copy = structuredClone(message);
      delay = Math.max(0, delay - 10);
      setTimeout(async () => {
        const [reply] = await answer(copy);
        for (const fn of listeners.message) fn({ data: structuredClone(reply) });
      }, delay);
    },
    terminate() {},
  };
}

const request = (scenario) => ({
  variable: 'pr',
  location: 'regional:WCE',
  scenario,
  nRealizations: 6,
  seed: 4242,
});
const SCENARIOS = ['ssp126', 'ssp245', 'ssp585', 'cmip7-high'];

describe('ensemble worker pool', () => {
  it('returns exactly what generating on the page would', async () => {
    const direct = await loadExplorer('NorESM2-MM');
    const runner = new EnsembleRunner({ loadExplorer, createWorker: fakeWorker, size: 3 });

    const pooled = await Promise.all(
      SCENARIOS.map((scenario) => runner.run('NorESM2-MM', request(scenario)))
    );
    expect(runner.workers.length).toBe(3);

    SCENARIOS.forEach((scenario, i) => {
      const expected = direct.run(request(scenario));
      expect(pooled[i].years).toEqual(expected.years);
      expect(pooled[i].series.length).toBe(6);
      pooled[i].series.forEach((series, r) => {
        expect(Array.from(series)).toEqual(Array.from(expected.series[r]));
      });
    });
  });

  it('answers on the page when no worker can start', async () => {
    const runner = new EnsembleRunner({
      loadExplorer,
      createWorker: () => {
        throw new Error('no workers here');
      },
    });
    const result = await runner.run('CanESM5', request('ssp245'));
    const expected = (await loadExplorer('CanESM5')).run(request('ssp245'));
    expect(Array.from(result.series[0])).toEqual(Array.from(expected.series[0]));
    expect(runner.createWorker).toBeNull();
  });

  it('reports a bad request as an error rather than hanging', async () => {
    const runner = new EnsembleRunner({ loadExplorer, createWorker: fakeWorker, size: 1 });
    await expect(runner.run('NorESM2-MM', request('ssp999'))).rejects.toThrow();
  });
});
