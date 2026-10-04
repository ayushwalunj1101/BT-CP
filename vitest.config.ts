import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "spikes/**/*.test.ts",
      "packages/**/*.test.ts",
      "circuits/**/*.test.ts",
      "web/src/**/*.test.ts",
    ],
    // Tests that start a local Anvil chain need more than the 5 s default.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // One file at a time: the end-to-end suites each run Foundry's deploy script, and Foundry allows
    // only one broadcast per chain id at once.
    fileParallelism: false,
  },
});
