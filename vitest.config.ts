import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts"],
    exclude: ["packages/*/src/**/*.integration.test.ts", "node_modules"],
    globals: false,
  },
  resolve: {
    alias: {
      "@zeloop/core": path.resolve(__dirname, "packages/core/src/index.ts"),
      "@zeloop/postgres": path.resolve(__dirname, "packages/postgres/src/index.ts"),
      "@zeloop/outbox": path.resolve(__dirname, "packages/outbox/src/index.ts"),
    },
  },
});
