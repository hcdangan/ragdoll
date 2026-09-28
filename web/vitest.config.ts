import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * Vitest configuration.
 *
 * Node environment by default — most of the unit surface is pure logic
 * (chunking maths, session sealing, SSE framing). Component tests opt into jsdom
 * with a `@vitest-environment jsdom` docblock.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      // `server-only` exists to fail a *client* bundle that imports server code.
      // In the Node test environment there is no client boundary, so the guard is
      // aliased away rather than forcing every server module into a mock.
      "server-only": resolve(__dirname, "./tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts"],
    exclude: ["node_modules", ".next", "e2e"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/lib/**", "src/hooks/**"],
      exclude: ["src/lib/pipeline/api-schema.d.ts"],
    },
  },
});
