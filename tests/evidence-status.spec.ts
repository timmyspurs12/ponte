import { expect, test } from "@playwright/test";
import type { Invoice } from "../src/lib/models";
import { resetFixtures } from "./setup-database";

test.beforeEach(async ({ context }) => {
  await resetFixtures();
  await context.addCookies([
    {
      name: "ponte-dev-session",
      value: process.env.PONTE_DEV_TOKEN!,
      domain: "localhost",
      path: "/",
    },
    {
      name: "ponte-locale",
      value: "en-US",
      domain: "localhost",
      path: "/",
    },
  ]);
});

async function fixtureInvoices(page: import("@playwright/test").Page) {
  const response = await page.request.get("/api/v1/invoices");
  expect(response.status()).toBe(200);
  return (await response.json()).data as Invoice[];
}

test("invoice evidence panel renders real loading, empty, and persisted local-test states", async ({
  page,
}) => {
  const invoices = await fixtureInvoices(page);
  const empty = invoices.find(
    (invoice) => invoice.status === "Pending payment",
  );
  const persisted = invoices.find((invoice) => invoice.status === "Routing");
  expect(empty).toBeTruthy();
  expect(persisted).toBeTruthy();

  let releaseLoading: (() => void) | undefined;
  const loadingHeld = new Promise<void>((resolve) => {
    releaseLoading = resolve;
  });
  let evidenceRequestStarted: (() => void) | undefined;
  const evidenceRequestObserved = new Promise<void>((resolve) => {
    evidenceRequestStarted = resolve;
  });
  await page.route(
    `**/api/v1/invoices/${empty!.id}/evidence`,
    async (route) => {
      evidenceRequestStarted?.();
      await loadingHeld;
      await route.continue();
    },
  );

  await page.goto(`/app/invoices/${empty!.id}`);
  await evidenceRequestObserved;
  await expect(
    page.getByText("Loading evidence status…", { exact: true }),
  ).toBeVisible();
  releaseLoading?.();
  await expect(
    page.getByText("No evidence record", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No evidence record has been persisted for this invoice.", {
      exact: true,
    }),
  ).toBeVisible();

  await page.goto(`/app/invoices/${persisted!.id}`);
  await expect(
    page.getByText("Evidence persisted", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Awaiting submission", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Anchoring not verified", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".evidence-disclosure").getByText("Local test provider", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page
      .locator(".evidence-disclosure")
      .getByText(
        "Evidence was prepared and persisted locally. Synthetic test bytes were used; no real cloud KMS operation occurred. No Arbitrum transaction has been verified.",
        { exact: true },
      ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "This payload hash commits to the prepared evidence record. It does not reveal the private payload and does not prove an on-chain transaction or registry anchoring.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText(/^Anchored$/)).toHaveCount(0);
  await expect(page.getByText(/^Verified on Arbitrum$/)).toHaveCount(0);
});

test("invoice evidence panel exposes an unavailable state rather than stale success", async ({
  page,
}) => {
  const invoices = await fixtureInvoices(page);
  const invoice = invoices.find((candidate) => candidate.status === "Routing");
  expect(invoice).toBeTruthy();

  await page.route(`**/api/v1/invoices/${invoice!.id}/evidence`, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "INTERNAL_ERROR" } }),
    }),
  );
  await page.goto(`/app/invoices/${invoice!.id}`);
  await expect(
    page.getByTestId("invoice-evidence-panel").getByRole("alert"),
  ).toContainText(
    "Evidence status is unavailable. No persistence or anchoring result is shown until the authorized status read succeeds.",
  );
  await expect(
    page.getByText("Evidence persisted", { exact: true }),
  ).toHaveCount(0);
});
