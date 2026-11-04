import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: "npm run dev -- --host",
    url: "http://localhost:5173",
    timeout: 90000,
  },
});
