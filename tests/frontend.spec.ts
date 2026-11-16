import { test, expect } from "@playwright/test";
import fs from "node:fs";
test.beforeEach(async ({ context }) => {
  await context.addCookies([
    { name: "ponte-locale", value: "en-US", domain: "localhost", path: "/" },
  ]);
});
test("complete invoice lifecycle, validation, filters and persistence", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
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
  await page
    .getByRole("button", { name: "Simulate Pix payment received" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Compare liquidity routes" }),
  ).toBeVisible();
  await page.getByRole("radio", { name: /Split liquidity/ }).click();
  await page.getByRole("button", { name: "Select route & continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Ready for settlement" }),
  ).toBeVisible();
  await page.reload();
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
  expect((await download).suggestedFilename()).toContain("QA-2026-001");
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
  await page.goto(detail);
  await expect(
    page.getByRole("heading", { name: "Settlement receipt" }),
  ).toBeVisible();
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
      "/app/invoices/demo-1",
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

test("keyboard, reduced motion, public demo payment and accessibility", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const route of ["/", "/app", "/app/invoices/new", "/pay/demo-1"]) {
    await page.goto(route);
    await page.waitForTimeout(400);
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
