import { resetFixtures } from "./setup-database";
let seedId = "";
let routedId = "";
import { test, expect } from "@playwright/test";
import fs from "node:fs";
test.beforeEach(async ({ context }) => {
  await context.addCookies([
    { name: "ponte-locale", value: "en-US", domain: "localhost", path: "/" },
  ]);
});
test("complete invoice lifecycle, validation, filters and persistence", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // R1 deliberately rejects Routing persistence, so the deliberate attempt
    // produces an expected 500 EVIDENCE_PERSISTENCE_FAILED console entry.
    if (
      m.type() === "error" &&
      !/status of 500 \(Internal Server Error\)/.test(m.text())
    ) {
      errors.push(m.text());
    }
  });
  await page.goto("/app");
  await expect(
    page.getByRole("heading", { name: "A clear view of what’s moving." }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/screenshots/overview-desktop.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Create invoice", exact: true }).click();
  await page.getByRole("button", { name: "Create demo invoice" }).click();
  await expect(
    page.getByText("Enter a business name of at least 2 characters."),
  ).toBeVisible();
  await page
    .getByLabel("Supplier / business name")
    .fill("São Paulo Test Supplier");
  await page.getByLabel("Supplier wallet address").fill("0x" + "a".repeat(40));
  await page.getByLabel("Invoice reference").fill("QA-2026-001");
  await page.getByLabel("Due date").fill("2027-01-20");
  await page.getByLabel("Invoice amount (BRL)").fill("25000");
  await page.getByRole("button", { name: "Create demo invoice" }).click();
  await expect(
    page.getByRole("heading", { name: "São Paulo Test Supplier" }),
  ).toBeVisible();
  const detail = page.url();
  const invoiceId = detail.split("/").pop();
  const saved = await page.request.get(`/api/v1/invoices/${invoiceId}`);
  expect(saved.status()).toBe(200);
  expect((await saved.json()).data.fundingMinor).toBe("2500000");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "São Paulo Test Supplier" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Simulate Pix payment received" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Compare illustrative routes" }),
  ).toBeVisible();
  await page.getByRole("radio", { name: /Split liquidity/ }).click();
  // R1: Routing evidence persistence is dormant and fail-closed. The
  // membership lock rejects the Routing attempt, so the invoice stays Funded
  // and no evidence is persisted. The UI presents the limitation clearly.
  await page.getByRole("button", { name: "Select route & continue" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Routing is unavailable in this demo" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Compare illustrative routes" }),
  ).toBeVisible();
  await expect(
    page.getByTestId("invoice-evidence-panel").getByText("Evidence persisted", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Ready for settlement" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Compare illustrative routes" }),
  ).toBeVisible();

  // Settlement is exercised against an admin-primed Routing fixture. The
  // application identity cannot create Routing state (R1), so the fixture is
  // pre-seeded by primeRoutedState and settlement runs on the application
  // identity against that pre-existing state.
  await page.goto(`/app/invoices/${routedId}`);
  await expect(
    page.getByRole("heading", { name: "Ready for settlement" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Simulate settlement", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Simulate settlement", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm simulation" }).click();
  await expect(
    page.getByRole("heading", { name: "Settlement receipt" }),
  ).toBeVisible();
  await expect(
    page.getByText("Split liquidity", { exact: true }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export demo receipt" }).click();
  expect((await download).suggestedFilename()).toContain("PNT-2026-1047");
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(page.locator(".toast")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/screenshots/receipt-desktop.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Open demo payment page" }).click();
  await expect(
    page.getByRole("heading", { name: "Settlement receipt" }),
  ).toBeVisible();
  await page.goto("/app/invoices");
  await page
    .getByRole("textbox", { name: "Search invoices" })
    .fill("QA-2026-001");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page
    .getByRole("combobox", { name: "Filter by status" })
    .selectOption("Failed");
  await expect(
    page.getByRole("heading", { name: "No invoices found" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(6);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await page
    .getByRole("combobox", { name: "Sort invoices" })
    .selectOption("amount");
  await page.goto(`/app/invoices/${routedId}`);
  await expect(
    page.getByRole("heading", { name: "Settlement receipt" }),
  ).toBeVisible();
  const separate = await browser.newContext();
  await separate.addCookies([
    {
      name: "ponte-dev-session",
      value: process.env.PONTE_DEV_TOKEN!,
      domain: "localhost",
      path: "/",
    },
    { name: "ponte-locale", value: "en-US", domain: "localhost", path: "/" },
  ]);
  const reopened = await separate.newPage();
  await reopened.goto(`/app/invoices/${routedId}`);
  await expect(
    reopened.getByRole("heading", { name: "Settlement receipt" }),
  ).toBeVisible();
  await expect(
    reopened.getByText("Split liquidity", { exact: true }),
  ).toBeVisible();
  await separate.close();
  await page.goto("/pay/missing");
  await expect(
    page.getByRole("heading", { name: "Invoice not found" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("responsive layouts and navigation", async ({ page }) => {
  fs.mkdirSync("test-results/screenshots", { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  for (const width of [1440, 1280, 768, 390, 360]) {
    await page.setViewportSize({ width, height: 950 });
    for (const route of [
      "/",
      "/app",
      "/app/invoices",
      "/app/invoices/new",
      `/app/invoices/${seedId}`,
      "/developers",
    ]) {
      await page.goto(route);
      await page.waitForTimeout(350);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${route} at ${width}px`,
      ).toBeTruthy();
      if (route === "/app" && width === 390)
        await page.screenshot({
          path: "test-results/screenshots/overview-mobile.png",
          fullPage: true,
        });
      if (route === "/" && (width === 1440 || width === 390))
        await page.screenshot({
          path: `test-results/screenshots/home-${width}.png`,
          fullPage: true,
        });
    }
    if (width === 390) {
      await page.goto("/");
      await page.getByRole("button", { name: "Open navigation" }).click();
      await expect(
        page.getByRole("link", { name: "Security", exact: true }),
      ).toBeVisible();
      await page.getByRole("link", { name: "Security", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Open navigation" }),
      ).toHaveAttribute("aria-expanded", "false");
    }
  }
  expect(errors).toEqual([]);
});

test("keyboard, reduced motion, workspace demo payment and accessibility", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // R1 deliberately rejects Routing persistence; the deliberate attempt
    // produces an expected 500 console entry.
    if (
      m.type() === "error" &&
      !/status of 500 \(Internal Server Error\)/.test(m.text())
    ) {
      errors.push(m.text());
    }
  });
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const route of ["/", "/app", "/app/invoices/new", `/pay/${seedId}`]) {
    await page.goto(route);
    await page.waitForTimeout(400);
    if (route === "/")
      await expect(page.locator(".hero-visual")).toHaveCSS("opacity", "1");
    if (route.startsWith("/pay/"))
      await expect(page.locator(".execution")).toHaveCSS("opacity", "1");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(
      results.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
      route,
    ).toEqual([]);
  }
  await page
    .getByRole("button", { name: "Simulate Pix payment received" })
    .click();
  const direct = page.getByRole("radio", { name: /Direct liquidity/ });
  await direct.focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("radio", { name: /Split liquidity/ }),
  ).toBeFocused();
  await expect(
    page.getByRole("radio", { name: /Split liquidity/ }),
  ).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Select route & continue" }).click();
  // R1: the Routing attempt is rejected; settlement is unavailable here.
  // Complete the settlement flow on an admin-primed Routing fixture instead.
  await page.goto(`/app/invoices/${routedId}`);
  await page
    .getByRole("button", { name: "Simulate settlement", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  await page
    .getByRole("button", { name: "Simulate settlement", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm simulation" }).click();
  await expect(
    page.getByRole("heading", { name: "Settlement receipt" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(page.locator(".toast")).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "test-results/screenshots/receipt-mobile.png",
    fullPage: true,
  });
});

test.beforeEach(async ({ context, request }) => {
  await resetFixtures();
  await context.addCookies([
    {
      name: "ponte-dev-session",
      value: process.env.PONTE_DEV_TOKEN!,
      domain: "localhost",
      path: "/",
    },
  ]);
  const response = await request.get("/api/v1/invoices", {
    headers: { authorization: `Bearer ${process.env.PONTE_DEV_TOKEN}` },
  });
  const { data } = await response.json();
  seedId = data.find(
    (i: { reference: string }) => i.reference === "PNT-2026-1048",
  ).id;
  // The Routing invoice is an admin-primed synthetic fixture (see
  // tests/setup-database.ts primeRoutedState). R1 makes Routing persistence
  // fail-closed, so the application identity cannot create Routing state; this
  // fixture exists so the settlement/receipt UI can be exercised.
  routedId = data.find(
    (i: { reference: string }) => i.reference === "PNT-2026-1047",
  ).id;
});
test("development login issues an HttpOnly session; unauthenticated API is not public", async ({
  page,
  context,
}) => {
  await context.clearCookies();
  const denied = await page.request.get("/api/v1/invoices");
  expect(denied.status()).toBe(401);
  const invalid = await page.request.post("/dev-login", {
    form: { token: "incorrect-local-token" },
  });
  expect(invalid.status()).toBe(401);
  await page.goto("/dev-login");
  await page.getByLabel("Development token").fill(process.env.PONTE_DEV_TOKEN!);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL("/app");
  const session = (await context.cookies()).find(
    (c) => c.name === "ponte-dev-session",
  )!;
  expect(session.httpOnly).toBe(true);
  expect(session.sameSite).toBe("Strict");
  const allowed = await page.request.get("/api/v1/invoices");
  expect(allowed.status()).toBe(200);
});
