import { defineConfig } from "@playwright/test";
import chromium from "@sparticuz/chromium";
export default defineConfig({
  testDir: "./tests",
  timeout: 90000,
  workers: 1,
  use: {
    baseURL: "http://localhost:3000",
    launchOptions: {
      executablePath: "/tmp/chromium",
      args: chromium.args.filter((a) => a !== "--single-process"),
    },
    headless: true,
  },
  reporter: "list",
});
