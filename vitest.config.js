import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These are numerical tests, not unit tests. Comparing against METEOR's
    // ensemble means simulating a lag-2 VAR on 40 modes over the full 351-year
    // trajectory, once per realization -- billions of multiply-accumulates,
    // several seconds on a CI runner. The 5s default fails them for being slow
    // rather than wrong.
    testTimeout: 60_000,
  },
});
