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
  // R1 deliberately rejects Routing persistence with a 500
  // EVIDENCE_PERSISTENCE_FAILED. Rather than blanket-suppressing every HTTP
  // 500 console entry, capture the transitions response explicitly and assert
  // its status and code; only the verified-expected 500 console message is
  // allowed, so an unexpected 500 or an unrelated console error stays
  // detectable.
  let expectedRouting500s = 0;
  // Collect every HTTP 5xx response so the complete failure list can be
  // asserted, not just the single expected transitions response. Each entry
  // carries the URL, status, request method and sanitised error code. The
  // async parse is tracked as a task from the moment the 5xx is received,
  // so the list can be awaited in full before assertion instead of racing
  // expect.poll on a partially processed list.
  const failedResponses: Array<{
    url: string;
    status: number;
    method: string;
    code: string | null;
  }> = [];
  const captureTasks: Promise<void>[] = [];
  page.on("response", (response) => {
    if (response.status() < 500) return;
    captureTasks.push(
      (async () => {
        let code: string | null = null;
        try {
          const body = await response.json();
          code = body?.error?.code ?? null;
        } catch {
          code = null;
        }
        failedResponses.push({
          url: response.url(),
          status: response.status(),
          method: response.request().method(),
          code,
        });
      })(),
    );
  });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (
      /Failed to load resource: the server responded with a status of 500/.test(
        text,
      )
    ) {
      // Allow only as many expected 500 console entries as verified
      // transitions responses; any surplus is an unexpected 500.
      if (expectedRouting500s > 0) {
        expectedRouting500s--;
        return;
      }
    }
    errors.push(text);
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
  // and no evidence is persisted. Assert the POST transitions response
  // explicitly is 500 EVIDENCE_PERSISTENCE_FAILED, then verify the UI
  // presents the limitation clearly.
  expectedRouting500s = 1;
  const transitionsUrl = `/api/v1/invoices/${invoiceId}/transitions`;
  const transitionsPromise = page.waitForResponse(
    (response) =>
      response.url().includes(transitionsUrl) &&
      response.request().method() === "POST" &&
      response.status() >= 500,
  );
  await page.getByRole("button", { name: "Select route & continue" }).click();
  const transitionsResponse = await transitionsPromise;
  expect(transitionsResponse.status()).toBe(500);
  const transitionsBody = await transitionsResponse.json();
  expect(transitionsBody.error?.code).toBe("EVIDENCE_PERSISTENCE_FAILED");
  // Wait for all outstanding 5xx capture tasks to settle, then assert the
  // complete failure list is exactly the expected Routing transition: the
  // transitions POST, status 500, code EVIDENCE_PERSISTENCE_FAILED, and no
  // other HTTP 5xx responses.
  await Promise.all(captureTasks);
  expect(failedResponses).toEqual([
    {
      url: expect.stringContaining(transitionsUrl),
      status: 500,
      method: "POST",
      code: "EVIDENCE_PERSISTENCE_FAILED",
    },
  ]);
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
  // R1 deliberately rejects Routing persistence with a 500
  // EVIDENCE_PERSISTENCE_FAILED. Capture the transitions response explicitly
  // and assert its status and code; only the verified-expected 500 console
  // message is allowed, so an unexpected 500 or an unrelated console error
  // stays detectable.
  let expectedRouting500s = 0;
  // Collect every HTTP 5xx response so the complete failure list can be
  // asserted, not just the single expected transitions response. The async
  // parse is tracked as a task from the moment the 5xx is received, so the
  // list can be awaited in full before assertion instead of racing
  // expect.poll on a partially processed list.
  const failedResponses: Array<{
    url: string;
    status: number;
    method: string;
    code: string | null;
  }> = [];
  const captureTasks: Promise<void>[] = [];
  page.on("response", (response) => {
    if (response.status() < 500) return;
    captureTasks.push(
      (async () => {
        let code: string | null = null;
        try {
          const body = await response.json();
          code = body?.error?.code ?? null;
        } catch {
          code = null;
        }
        failedResponses.push({
          url: response.url(),
          status: response.status(),
          method: response.request().method(),
          code,
        });
      })(),
    );
  });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (
      /Failed to load resource: the server responded with a status of 500/.test(
        text,
      )
    ) {
      if (expectedRouting500s > 0) {
        expectedRouting500s--;
        return;
      }
    }
    errors.push(text);
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
  // R1: the Routing attempt is rejected with a 500 EVIDENCE_PERSISTENCE_FAILED.
  // Assert the transitions response explicitly, then complete the settlement
  // flow on an admin-primed Routing fixture instead.
  expectedRouting500s = 1;
  const transitionsPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/v1/invoices/${seedId}/transitions`) &&
      response.request().method() === "POST" &&
      response.status() >= 500,
  );
  await page.getByRole("button", { name: "Select route & continue" }).click();
  const transitionsResponse = await transitionsPromise;
  expect(transitionsResponse.status()).toBe(500);
  const transitionsBody = await transitionsResponse.json();
  expect(transitionsBody.error?.code).toBe("EVIDENCE_PERSISTENCE_FAILED");
  // Wait for all outstanding 5xx capture tasks to settle, then assert the
  // complete failure list is exactly the expected Routing transition and no
  // other HTTP 5xx responses.
  await Promise.all(captureTasks);
  expect(failedResponses).toEqual([
    {
      url: expect.stringContaining(`/api/v1/invoices/${seedId}/transitions`),
      status: 500,
      method: "POST",
      code: "EVIDENCE_PERSISTENCE_FAILED",
    },
  ]);
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

test("Routing provider-unavailable shows a clear message and keeps the invoice funded (en-US and pt-BR)", async ({
  page,
}) => {
  // R1: when the evidence provider is unavailable the backend rejects a
  // Routing attempt with 503 EVIDENCE_PROVIDER_UNAVAILABLE. Intercept the
  // transitions response with a controlled 503 so the UI's sanitised
  // handling can be exercised without a real provider or any backend
  // change. Verify the English and Portuguese messages and that the
  // invoice remains Funded.
  await page.goto(`/app/invoices/${seedId}`);
  await page
    .getByRole("button", { name: "Simulate Pix payment received" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Compare illustrative routes" }),
  ).toBeVisible();
  await page.getByRole("radio", { name: /Split liquidity/ }).click();

  // Intercept only the Routing transitions POST and fulfill it with the
  // sanitised provider-unavailable error. Other requests pass through.
  await page.route(
    "**/api/v1/invoices/*/transitions",
    async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "EVIDENCE_PROVIDER_UNAVAILABLE" },
            requestId: "provider-unavailable-test",
          }),
        });
      } else {
        await route.continue();
      }
    },
  );
  await page.getByRole("button", { name: "Select route & continue" }).click();

  // English message and the invoice stays Funded.
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Routing is unavailable in this environment" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Compare illustrative routes" }),
  ).toBeVisible();

  // Switch to Portuguese and verify the translated message and heading.
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("pt-BR");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "O roteamento não está disponível neste ambiente" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Compare rotas ilustrativas" }),
  ).toBeVisible();
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
