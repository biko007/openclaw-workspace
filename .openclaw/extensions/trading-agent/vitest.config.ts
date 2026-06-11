import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    fileParallelism: false,
    testTimeout: 15000,
    include: ["tests/**/*.test.ts"],
  },
});
