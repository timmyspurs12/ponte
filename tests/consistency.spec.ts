import { test, expect } from "@playwright/test";
import { resetFixtures } from "./setup-database";
import type { Invoice } from "../src/lib/models";
import { translate } from "../src/lib/i18n/messages";

test.beforeEach(async ({ context }) => {
  await resetFixtures();
  await context.addCookies([
    {
      name: "ponte-dev-session",
      value: process.env.PONTE_DEV_TOKEN!,
      domain: "localhost",
      path: "/",
    },
  ]);
});

for (const locale of ["pt-BR", "en-US"] as const) {
  test(`Failed is terminal and replacement navigation preserves the original invoice (${locale})`, async ({
    page,
    context,
  }) => {
    await context.addCookies([
      { name: "ponte-locale", value: locale, domain: "localhost", path: "/" },
    ]);
    const response = await page.request.get("/api/v1/invoices");
    expect(response.status()).toBe(200);
    const failed = ((await response.json()).data as Invoice[]).find(
      (i) => i.status === "Failed",
    )!;
    expect(failed).toBeTruthy();
    const original = (
      await (await page.request.get(`/api/v1/invoices/${failed.id}`)).json()
    ).data;
    const history = (
      await (
        await page.request.get(`/api/v1/invoices/${failed.id}/activity`)
      ).json()
    ).data;
    const mutations: string[] = [];
    page.on("request", (r) => {
      if (r.method() !== "GET" && r.url().includes("/api/v1/"))
        mutations.push(r.url());
    });
    await page.goto(`/app/invoices/${failed.id}`);
    await expect(
      page.getByRole("heading", {
        name: translate(locale, "Invoice failed"),
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        translate(
          locale,
          "This failed invoice cannot be retried. Its record and activity history are preserved.",
        ),
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: /Retry demo payment request|Tentar solicitação novamente/,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: translate(locale, "Create demo payment request"),
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: translate(locale, "Simulate Pix payment received"),
        exact: true,
      }),
    ).toHaveCount(0);
    const replacement = page.getByRole("link", {
      name: translate(locale, "Create replacement invoice"),
      exact: true,
    });
    await expect(replacement).toHaveAttribute("href", "/app/invoices/new");
    await expect(replacement).toHaveClass(/\bbutton\b/);
    await replacement.click();
    await expect(page).toHaveURL("/app/invoices/new");
    await expect(
      page.getByRole("button", {
        name: translate(locale, "Create demo invoice"),
        exact: true,
      }),
    ).toBeVisible();
    expect(mutations).toEqual([]);
    expect(
      (await (await page.request.get(`/api/v1/invoices/${failed.id}`)).json())
        .data,
    ).toEqual(original);
    expect(
      (
        await (
          await page.request.get(`/api/v1/invoices/${failed.id}/activity`)
        ).json()
      ).data,
    ).toEqual(history);
  });

  test(`Payment links explain workspace restrictions, copy internally and reject anonymous readers (${locale})`, async ({
    page,
    context,
    browser,
  }) => {
    await context.addCookies([
      { name: "ponte-locale", value: locale, domain: "localhost", path: "/" },
    ]);
    const response = await page.request.get("/api/v1/invoices");
    expect(response.status()).toBe(200);
    const invoice = ((await response.json()).data as Invoice[]).find(
      (i) => i.status === "Pending payment",
    )!;
    let copied = "";
    await page.exposeFunction("__captureCopiedLink", (value: string) => {
      copied = value;
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            await (
              window as unknown as {
                __captureCopiedLink: (text: string) => Promise<void>;
              }
            ).__captureCopiedLink(value);
          },
        },
      });
    });
    await page.goto(`/app/invoices/${invoice.id}`);
    for (const message of [
      "Workspace-restricted payment link",
      "This link is restricted to this workspace and is for internal demonstrations only.",
      "Sign in with an account that already has access to this workspace to view this invoice.",
      "External supplier access is not implemented yet.",
    ])
      await expect(
        page.getByText(translate(locale, message), { exact: true }),
      ).toBeVisible();
    await expect(
      page.getByText(
        /public-facing demo checkout|browser’s local demo store|página pública de pagamento|dados locais deste navegador/,
      ),
    ).toHaveCount(0);
    await page
      .getByRole("button", {
        name: translate(locale, "Copy demo payment link"),
        exact: true,
      })
      .click();
    await expect
      .poll(() => copied)
      .toBe(`http://localhost:3000/pay/${invoice.id}`);
    await page
      .getByRole("link", {
        name: translate(locale, "Open demo payment page"),
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(`/pay/${invoice.id}`);
    await expect(
      page.getByRole("heading", { name: invoice.supplier, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        translate(locale, "External supplier access is not implemented yet."),
        { exact: true },
      ),
    ).toBeVisible();
    const allowed = await page.request.get(`/api/v1/invoices/${invoice.id}`);
    expect(allowed.status()).toBe(200);
    expect((await allowed.json()).data.id).toBe(invoice.id);
    const anonymous = await browser.newContext();
    try {
      await anonymous.addCookies([
        { name: "ponte-locale", value: locale, domain: "localhost", path: "/" },
      ]);
      const denied = await anonymous.request.get(
        `http://localhost:3000/api/v1/invoices/${invoice.id}`,
      );
      expect(denied.status()).toBe(401);
      const body = await denied.json();
      expect(body.error.code).toBe("UNAUTHENTICATED");
      expect(body.data).toBeUndefined();
      const anonymousPage = await anonymous.newPage();
      await anonymousPage.goto(`http://localhost:3000/pay/${invoice.id}`);
      await expect(
        anonymousPage.getByRole("main").getByRole("alert"),
      ).toContainText(translate(locale, "Sign in required"));
      await expect(
        anonymousPage.getByRole("heading", {
          name: invoice.supplier,
          exact: true,
        }),
      ).toHaveCount(0);
      expect(await anonymousPage.content()).not.toContain(invoice.reference);
      expect(await anonymousPage.content()).not.toContain(invoice.wallet);
    } finally {
      await anonymous.close();
    }
  });
}
