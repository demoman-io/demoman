import { defineConfig } from "@playwright/test";

const port = 4000;
export default defineConfig({
  webServer: [{ command: `npm run dev -- --port ${port}`, port }],
});
