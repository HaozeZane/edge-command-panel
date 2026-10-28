import { defineConfig } from "vitest/config";

// Node-only tests for the fixed GitHub Release download/verification path.
// Kept separate from vitest.config.ts, which runs the Cloudflare Workers pool.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test-release/**/*.test.mjs"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
