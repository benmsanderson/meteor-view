/**
 * Generating an ensemble on request, wherever that happens.
 *
 * The same code answers in a Web Worker and, when there is no worker to be
 * had, on the page itself: a request names the model, and the service keeps
 * one Explorer per model it has been asked about. Kept apart from the worker
 * entry point so it can be tested without one.
 */

/**
 * @param {(model: string) => Promise<import('./explorer.js').Explorer>} loadExplorer
 * @returns {(message: {id: number, model: string, request: object}) =>
 *   Promise<[object, ArrayBuffer[]]>} a reply and the buffers to transfer
 */
export function createEnsembleService(loadExplorer) {
  const explorers = new Map();

  return async function answer({ id, model, request }) {
    try {
      if (!explorers.has(model)) explorers.set(model, loadExplorer(model));
      const explorer = await explorers.get(model);
      const { years, series, forced } = explorer.run(request);
      // Transferred, not copied: at 100 realizations a scenario is 0.8 MB.
      // A Set, because transferring the same buffer twice is an error.
      const buffers = new Set([...series, forced].map((values) => values.buffer));
      return [{ id, years, series, forced }, [...buffers]];
    } catch (error) {
      // A failed load must not stay cached, or every later request fails too.
      explorers.delete(model);
      return [{ id, error: error.message }, []];
    }
  };
}
