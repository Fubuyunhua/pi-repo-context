import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "extensions/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      thresholds: { lines: 85, branches: 80 },
    },
  },
});
