import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // The publishing workflow runs every test each round, with all files in parallel. Page tests
    // that load lazy chunks can take seconds under that load, so the limits leave room for it.
    testTimeout: 20000,
    setupFiles: ["./src/test-setup.js"],
  },
  server: {
    port: 5173,
  },
});
