import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The mapping and adapter logic is pure and needs no browser; anything that does need one
    // belongs in the Playwright suite, not here behind a simulated DOM.
    environment: "happy-dom",
    include: ["test/**/*.test.ts"],
  },
});
