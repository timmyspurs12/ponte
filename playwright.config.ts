import { defineConfig } from "@playwright/test";
import chromium from "@sparticuz/chromium";
const fallback = process.env.PONTE_CHROMIUM_EXECUTABLE;
export default defineConfig({
  testDir: "./tests",
  timeout: 90000,
  workers: 1,
  use: {
    baseURL: "http://localhost:3000",
    headless: true,
    launchOptions: fallback
      ? {
          executablePath: fallback,
          args: chromium.args.filter((a) => a !== "--single-process"),
        }
      : {},
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
});
