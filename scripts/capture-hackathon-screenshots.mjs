// Regenerates the current hackathon screenshots from the running local application.
// Requires a seeded development database and `npm run dev` on localhost:3000.
// Windows/macOS use ordinary Playwright Chromium after `npm run test:install`.
// Only the restricted Linux fallback needs PONTE_BROWSER_FALLBACK=1.
import { loadEnvFile, env } from "node:process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { chromium } from "@playwright/test";
import { prepareBrowser } from "./prepare-browser.mjs";

loadEnvFile(".env.local");

const baseURL = "http://localhost:3000";
const token = env.PONTE_DEV_TOKEN;
const output = "docs/screenshots";
const reference = "PNT-2026-1048";

if (!token) throw new Error("PONTE_DEV_TOKEN is required in .env.local");
fs.mkdirSync(output, { recursive: true });

const launchOptions = {};
if (env.PONTE_BROWSER_FALLBACK === "1") {
  const { default: sparticuzChromium } = await import("@sparticuz/chromium");
  const browser = await prepareBrowser();
  env.LD_LIBRARY_PATH = [browser.libraryPath, env.LD_LIBRARY_PATH]
    .filter(Boolean)
    .join(":");
  launchOptions.executablePath = browser.executablePath;
  launchOptions.args = sparticuzChromium.args.filter(
    (arg) => arg !== "--single-process",
  );
}

const browser = await chromium.launch({ headless: true, ...launchOptions });
try {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 950 },
  });
  await context.addCookies([
    { name: "ponte-dev-session", value: token, domain: "localhost", path: "/" },
    { name: "ponte-locale", value: "en-US", domain: "localhost", path: "/" },
  ]);
  const page = await context.newPage();

  // `page.getByRole(...)` returns a lazy locator; it does nothing until an action
  // or an explicit wait runs on it. Every readiness check here is therefore either
  // `.waitFor()` or `expect(...).toBeVisible()`.
  async function waitForHeading(name) {
    await page.getByRole("heading", { name }).waitFor({ state: "visible" });
  }

  // Waits for a Motion enter transition to actually finish rather than relying on
  // a fixed delay. Polls the element's computed opacity/transform until they match
  // the resting state, so a mid-animation frame can never be captured.
  async function settled(selector) {
    await page.waitForFunction(
      (sel) => {
        const node = document.querySelector(sel);
        if (!node) return false;
        const style = getComputedStyle(node);
        const opacity = Number.parseFloat(style.opacity);
        const matrix = style.transform;
        const resting =
          matrix === "none" ||
          matrix === "matrix(1, 0, 0, 1, 0, 0)" ||
          matrix === "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)";
        return opacity >= 0.999 && resting;
      },
      selector,
      { timeout: 15000 },
    );
  }

  async function shot(name, { settle } = {}) {
    if (settle) await settled(settle);
    // Belt-and-braces: confirm no CSS transition is still in flight anywhere.
    await page.evaluate(async () => {
      const running = document
        .getAnimations()
        .filter((a) => a.playState === "running");
      await Promise.all(running.map((a) => a.finished.catch(() => {})));
    });
    // Remove only development chrome/transient toasts, never product content.
    await page.evaluate(() => {
      document.querySelector("nextjs-portal")?.remove();
      document.querySelectorAll(".toast").forEach((node) => node.remove());
    });
    const path = `${output}/${name}.png`;
    await page.screenshot({ path, fullPage: true });
    console.log(path);
  }

  async function settledHeroVisible() {
    await page.waitForFunction(() => {
      const node = document.querySelector(".hero-visual");
      return node && getComputedStyle(node).opacity === "1";
    });
  }

  const list = await page.request.get("/api/v1/invoices?limit=100");
  if (!list.ok()) throw new Error(`API refused local access: ${list.status()}`);
  const { data: invoices } = await list.json();
  const invoice = invoices.find((item) => item.reference === reference);
  if (!invoice || invoice.status !== "Pending payment")
    throw new Error(
      `${reference} must be Pending payment; reset with npm run db:reset -- --confirm-local-reset && npm run db:fixtures`,
    );

  await page.goto("/");
  await settledHeroVisible();
  await shot("home-1440");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await settledHeroVisible();
  await shot("home-390");

  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto("/app");
  await page.waitForSelector(".metrics");
  await shot("overview-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app");
  await page.waitForSelector(".metrics");
  await shot("overview-mobile");

  const funding = await page.request.post(
    `/api/v1/invoices/${invoice.id}/payments`,
    {
      data: {},
      headers: { "Idempotency-Key": randomUUID() },
    },
  );
  if (!funding.ok())
    throw new Error(`Could not simulate Pix funding: ${funding.status()}`);

  // Desktop composition. At >=851px the page is a two-column grid whose right
  // column (the workspace-restricted payment link) is only ~440px tall, while the
  // left column runs ~900px. A fullPage capture at 1440px therefore has a large
  // white area on the right, roughly as tall as the page. 850px is the exact point
  // at which the grid becomes a single column, so the same content — funding
  // details, simulation notices, evidence labels and all three route options —
  // fills the frame with no gap. Nothing is cropped away.
  await page.setViewportSize({ width: 850, height: 950 });
  await page.goto(`/app/invoices/${invoice.id}`);
  await waitForHeading("Compare illustrative routes");
  await shot("invoice-routes-desktop", { settle: ".execution" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/app/invoices/${invoice.id}`);
  await waitForHeading("Compare illustrative routes");
  await shot("invoice-routes-mobile", { settle: ".execution" });

  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto(`/app/invoices/${invoice.id}`);
  await page.getByRole("radio", { name: /Split liquidity/ }).click();
  await page.getByRole("button", { name: "Select route & continue" }).click();
  await waitForHeading("Ready for settlement");
  // The status transition is persisted server-side; reload so the action button
  // renders the settled-state control ('Simulate settlement').
  await page.reload();
  await waitForHeading("Ready for settlement");
  await page
    .getByRole("button", { name: "Simulate settlement", exact: true })
    .click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "Confirm simulation" }).click();
  await waitForHeading("Settlement receipt");
  const dismiss = page.getByRole("button", { name: "Dismiss notification" });
  if (await dismiss.count()) await dismiss.click();
  await shot("receipt-desktop", { settle: ".execution" });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/app/invoices/${invoice.id}`);
  await waitForHeading("Settlement receipt");
  await shot("receipt-mobile", { settle: ".execution" });

  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto("/developers");
  await page
    .getByRole("heading", { name: /One bridge/ })
    .waitFor({ state: "visible" });
  await shot("developers-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/developers");
  await page
    .getByRole("heading", { name: /One bridge/ })
    .waitFor({ state: "visible" });
  await shot("developers-mobile");

  console.log("Screenshots regenerated from the running application.");
} finally {
  await browser.close();
}
