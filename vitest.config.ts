import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["spikes/**/*.test.ts", "packages/**/*.test.ts"],
    // Tests that start a local Anvil chain need more than the 5 s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
