import { expect, test } from "@playwright/test";

const response = (data: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({
    data,
    requestId: "00000000-0000-4000-8000-000000000099",
  }),
});

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    { name: "ponte-locale", value: "en-US", domain: "localhost", path: "/" },
  ]);
});

test("sign-in screen explains GitHub authentication without exposing account secrets", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await expect(
    page.getByRole("heading", { name: "Sign in to PONTE" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue with GitHub" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "GitHub authentication does not grant workspace access by itself.",
    ),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("access_token");
});

test("authenticated account without membership sees an explicit denied state", async ({
  page,
}) => {
  await page.route("**/api/auth/context", async (route) =>
    route.fulfill(
      response(
        {
          authenticated: true,
          accountLabel: "GitHub · no-membership",
          access: null,
        },
        403,
      ),
    ),
  );
  await page.goto("/app");
  await expect(
    page.getByRole("heading", { name: "Workspace access denied" }),
  ).toBeVisible();
  await expect(page.getByText("GitHub · no-membership")).toBeVisible();
  await expect(
    page.getByText(
      "Your GitHub account is signed in, but it does not have an active membership for this workspace.",
    ),
  ).toBeVisible();
});

test("public-demo viewer UI is visibly read-only and does not offer invoice creation", async ({
  page,
}) => {
  await page.route("**/api/auth/context", async (route) =>
    route.fulfill(
      response({
        authenticated: true,
        accountLabel: "GitHub · demo-viewer",
        access: { role: "viewer", readOnly: true, publicDemo: true },
      }),
    ),
  );
  await page.route("**/api/v1/activity?limit=3", async (route) =>
    route.fulfill(response([])),
  );
  await page.route("**/api/v1/invoices?limit=100&offset=0", async (route) =>
    route.fulfill(response([])),
  );

  await page.goto("/app/invoices");
  await expect(page.getByText("Read-only demo access").first()).toBeVisible();
  // The public demo states its synthetic scope in the banner: sample invoices,
  // no Pix/wallet/KMS/blockchain connection, and no viewer mutations.
  await expect(page.getByText("Synthetic public demo").first()).toBeVisible();
  await expect(
    page.getByText(
      "Sample invoices only. No Pix payment, wallet, KMS or blockchain transaction is connected, and viewers cannot change anything.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Create invoice" })).toHaveCount(
    0,
  );

  await page.goto("/app/invoices/new");
  await expect(
    page.getByRole("heading", { name: "Read-only demo access" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "This synthetic demo workspace does not allow invoice changes.",
    ),
  ).toBeVisible();
});
