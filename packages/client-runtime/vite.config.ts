import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["../shared/src/testing/longTempDir.ts"],
    // Homelab fork: CI runs on smaller GitHub-hosted runners than upstream's.
    testTimeout: 30_000,
  },
});
