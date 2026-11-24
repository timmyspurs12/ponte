import { expect, test } from "@playwright/test";

const response = (data: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({
    data,
    requestId: "00000000-0000-4000-8000-000000000098",
  }),
});

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    { name: "ponte-locale", value: "en-US", domain: "localhost", path: "/" },
  ]);
});

test("the synthetic public demo explains its boundaries on every workspace view", async ({
  page,
}) => {
  const invoices = [
    {
      id: "0f5b6d2a-0a1b-5c3d-8e4f-111111111105",
      reference: "DEMO-SYN-1005",
      supplier: "Fictional Trading House S.A. (sample)",
      wallet: `0x${"5".repeat(40)}`,
      amount: 6300,
      fundingMinor: "630000",
      fundingCurrency: "BRL",
      settlementCurrency: "USDG",
      due: "2027-10-05",
      created: "2026-11-14",
      description: "Synthetic sample invoice — simulated settlement completed.",
      status: "Settled",
      selectedRoute: "direct",
      quote: {
        fundingMinor: "630000",
        asset: "USDG",
        demoAssetDecimals: 2,
        rate: { numerator: "525", denominator: "100" },
        executionCostMinor: "2",
        simulated: true,
        routes: [
          {
            id: "direct",
            name: "Direct liquidity",
            feeBps: 35,
            feeMinor: "1100",
            slippageBps: 5,
            toleranceBps: 50,
            outputMinor: "118880",
            minimumOutputMinor: "118285",
          },
        ],
      },
      receipt: {
        invoiceId: "0f5b6d2a-0a1b-5c3d-8e4f-111111111105",
        sender: "PONTE synthetic public demo",
        recipient: "Fictional Trading House S.A. (sample)",
        originalAmountMinor: "630000",
        asset: "USDG",
        amountMinor: "118880",
        route: "Direct liquidity",
        execution: {
          routeId: "direct",
          costMinor: "2",
          identifier: "SIM-PUBLIC-DEMO-SETTLED",
          simulated: true,
        },
        timestamp: "2026-11-14T12:00:00.000Z",
      },
    },
  ];

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
    route.fulfill(response(invoices)),
  );
  await page.route(
    `**/api/v1/invoices/${invoices[0].id}/evidence`,
    async (route) =>
      route.fulfill(
        response({
          state: "missing",
          invoiceId: invoices[0].id,
          evidence: null,
        }),
      ),
  );

  await page.goto("/app");
  await expect(
    page.getByText("Synthetic public demo", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Sample invoices only. No Pix payment, wallet, KMS or blockchain transaction is connected, and viewers cannot change anything.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Synthetic demonstration", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "No Pix payment was made. No wallet, token transfer, custody or settlement occurred.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "No cloud KMS operation occurred and no blockchain transaction was submitted or verified.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "This demonstration is read-only. Visitors cannot create, change, fund, route or settle anything.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Create invoice", exact: true }),
  ).toHaveCount(0);

  await page.goto("/app/invoices");
  await expect(
    page.getByText("All figures are synthetic sample data", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Create invoice", exact: true }),
  ).toHaveCount(0);

  await page.goto(`/app/invoices/${invoices[0].id}`);
  await expect(
    page.getByText(/Synthetic sample invoice · Created/),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Synthetic demonstration", exact: true }),
  ).toBeVisible();
  // The settlement receipt must never look like a chain transaction, and the
  // evidence panel must stay an explicit empty state rather than an
  // "anchored"/"verified" claim.
  await expect(
    page.getByText("No blockchain transaction occurred.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No evidence record", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/anchored|verified on-chain/i)).toHaveCount(0);
  // Read-only: every mutation control is absent or disabled.
  for (const action of [
    "Simulate settlement",
    "Select route & continue",
    "Simulate Pix payment received",
  ])
    await expect(
      page.getByRole("button", { name: action, exact: true }),
    ).toHaveCount(0);

  const body = await page.locator("body").innerText();
  for (const leak of [
    "PONTE_AUTH_BUSINESS_ID",
    "DATABASE_URL",
    "AUTH_SECRET",
    "AUTH_GITHUB_SECRET",
    "PONTE_DEV_TOKEN",
    "localhost:5432",
  ])
    expect(body.toLowerCase()).not.toContain(leak.toLowerCase());
});

test("a viewer write attempt is refused by the server, not just hidden in the UI", async ({
  page,
}) => {
  const invoiceId = "0f5b6d2a-0a1b-5c3d-8e4f-111111111102";
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
    route.fulfill(
      response([
        {
          id: invoiceId,
          reference: "DEMO-SYN-1002",
          supplier: "Sample Components Ltda (not a real company)",
          wallet: `0x${"2".repeat(40)}`,
          amount: 48200,
          fundingMinor: "4820000",
          fundingCurrency: "BRL",
          settlementCurrency: "USDG",
          due: "2027-07-15",
          created: "2026-11-05",
          description: "Synthetic sample invoice — awaiting simulated funding.",
          status: "Pending payment",
          quote: {
            fundingMinor: "4820000",
            asset: "USDG",
            demoAssetDecimals: 2,
            rate: { numerator: "525", denominator: "100" },
            executionCostMinor: "2",
            simulated: true,
            routes: [
              {
                id: "direct",
                name: "Direct liquidity",
                feeBps: 35,
                feeMinor: "8400",
                slippageBps: 5,
                toleranceBps: 50,
                outputMinor: "909523",
                minimumOutputMinor: "904975",
              },
            ],
          },
        },
      ]),
    ),
  );
  await page.goto(`/app/invoices/${invoiceId}`);
  // The synthetic demo viewer sees no funding button at all.
  await expect(
    page.getByRole("button", { name: "Simulate Pix payment received" }),
  ).toHaveCount(0);
  const refused = await page.request.post(
    `http://localhost:3000/api/v1/invoices/${invoiceId}/transitions`,
    { data: { status: "Funded" }, failOnStatusCode: false },
  );
  // Without a real development session the API refuses before any write.
  expect([401, 403]).toContain(refused.status());
  expect((await refused.json()).data).toBeUndefined();
});
