/**
 * A small pool of ensemble workers.
 *
 * Generation is the one expensive thing the page does: about 10 ms per
 * realization, so six scenarios at 100 realizations is six seconds of solid
 * work. On the main thread that freezes the page; here it runs on up to four
 * workers at once, one scenario per request, and the page stays live.
 *
 * Results are identical to generating on the page. The random stream is
 * seeded per request, so which worker runs a scenario, and in what order,
 * cannot change a single value — which is what keeps shared links exact.
 *
 * With no Worker available, or one that fails to start, requests are answered
 * on the page instead, by the same code.
 */

import { createEnsembleService } from './ensemble-service.js';

/** Enough to run a typical selection at once without starving the page. */
const MAX_WORKERS = 4;

export class EnsembleRunner {
  /**
   * @param {object} options
   * @param {(model: string) => Promise<import('./explorer.js').Explorer>}
   *   options.loadExplorer used when answering on the page
   * @param {(() => Worker)|null} [options.createWorker] null to never use one
   * @param {number} [options.size] workers in the pool
   */
  constructor({ loadExplorer, createWorker = null, size = defaultSize() }) {
    this.createWorker = createWorker;
    this.size = Math.max(1, Math.min(size, MAX_WORKERS));
    this.workers = [];
    this.pending = new Map();
    this.nextId = 1;
    this.inline = createEnsembleService(loadExplorer);
  }

  /**
   * Generate one scenario's ensemble.
   *
   * @param {string} model
   * @param {object} request what `Explorer.run` takes
   * @returns {Promise<{years: number[], series: Float64Array[], forced: Float64Array}>}
   */
  run(model, request) {
    const id = this.nextId++;
    const message = { id, model, request };
    const worker = this.pick();
    if (!worker) return this.inline(message).then(([reply]) => settle(reply));

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, worker, message });
      worker.busy += 1;
      worker.handle.postMessage(message);
    });
  }

  /** The least busy worker, starting one if the pool has room; null if none. */
  pick() {
    if (!this.createWorker) return null;
    const idle = this.workers.find((w) => w.busy === 0);
    if (idle) return idle;
    if (this.workers.length < this.size) {
      const started = this.start();
      if (started) return started;
    }
    if (!this.workers.length) return null;
    return this.workers.reduce((a, b) => (b.busy < a.busy ? b : a));
  }

  start() {
    let handle;
    try {
      handle = this.createWorker();
    } catch {
      // No workers here: answer everything on the page from now on.
      this.createWorker = null;
      return null;
    }
    const worker = { handle, busy: 0 };
    handle.addEventListener('message', ({ data }) => {
      const job = this.pending.get(data.id);
      if (!job) return;
      this.pending.delete(data.id);
      worker.busy -= 1;
      try {
        job.resolve(settle(data));
      } catch (error) {
        job.reject(error);
      }
    });
    // A worker that dies (a failed import, say) hands its jobs to the page
    // rather than leaving them waiting for ever.
    handle.addEventListener('error', (event) => {
      event.preventDefault?.();
      this.workers = this.workers.filter((w) => w !== worker);
      handle.terminate();
      for (const [id, job] of this.pending) {
        if (job.worker !== worker) continue;
        this.pending.delete(id);
        this.inline(job.message).then(([reply]) => {
          try {
            job.resolve(settle(reply));
          } catch (error) {
            job.reject(error);
          }
        });
      }
    });
    this.workers.push(worker);
    return worker;
  }
}

/** A reply as a result, or its error thrown. */
function settle(reply) {
  if (reply.error) throw new Error(reply.error);
  return { years: reply.years, series: reply.series, forced: reply.forced };
}

function defaultSize() {
  const cores = globalThis.navigator?.hardwareConcurrency ?? 2;
  return Math.max(1, cores - 1);
}
