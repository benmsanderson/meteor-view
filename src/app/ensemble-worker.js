/**
 * The worker end: ensembles off the main thread, so the page stays responsive
 * while several scenarios generate.
 */

import { Explorer } from './explorer.js';
import { createEnsembleService } from './ensemble-service.js';

let answer = null;

self.addEventListener('message', async ({ data }) => {
  // The first message says where the data lives. A worker resolves relative
  // URLs against its own script, not the page, so the base arrives absolute.
  if (data.type === 'init') {
    answer = createEnsembleService((model) => Explorer.load(data.base, model));
    return;
  }
  const [reply, transfer] = await answer(data);
  self.postMessage(reply, transfer);
});
