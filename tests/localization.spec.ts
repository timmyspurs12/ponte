import { resetFixtures } from "./setup-database";
let seedId = "";
import { test, expect } from "@playwright/test";
import { demoQuote } from "../src/lib/quotes";
import { formatNumber } from "../src/lib/i18n/format";
import { translate } from "../src/lib/i18n/messages";

test("Portuguese is default; locale survives navigation, reload, form errors and settlement", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
  await expect(
    page.getByRole("heading", {
      name: "Pagamentos locais. Possibilidades globais.",
    }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Criar uma fatura", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Criar fatura de demonstração" })
    .click();
  await expect(
    page.getByText("Informe um nome de empresa com pelo menos 2 caracteres."),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Idioma", exact: true })
    .selectOption("en-US");
  await expect(
    page.getByText("Enter a business name of at least 2 characters."),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("pt-BR");
  await page
    .getByLabel("Nome do fornecedor / empresa")
    .fill("Fornecedor Brasil");
  await page
    .getByLabel("Endereço da carteira do fornecedor")
    .fill("0x" + "b".repeat(40));
  await page.getByLabel("Referência da fatura").fill("QA-BR-001");
  await page.getByLabel("Vencimento").fill("2027-01-20");
  await page.getByLabel("Valor da fatura (BRL)").fill("25000.01");
  await page
    .getByRole("button", { name: "Criar fatura de demonstração" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Fornecedor Brasil" }),
  ).toBeVisible();
  await expect(page.locator(".payment-amount")).toContainText("25.000,01");
  await expect(page.locator("dl")).toContainText("20/01/2027");
  await page
    .getByRole("button", { name: "Simular recebimento via Pix" })
    .click();
  await page.getByRole("radio", { name: /Liquidez dividida/ }).click();
  const selected = demoQuote(25000.01).routes[1];
  await expect(page.locator(".execution-stats")).toContainText(
    formatNumber(Number(selected.minimumOutputMinor) / 100, "pt-BR"),
  );
  await page
    .getByRole("combobox", { name: "Idioma", exact: true })
    .selectOption("en-US");
  await expect(
    page.getByRole("radio", { name: /Split liquidity/ }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".execution-stats")).toContainText(
    formatNumber(Number(selected.minimumOutputMinor) / 100, "en-US"),
  );
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  // Route selection is persisted when the user locks it, not before.
  await page.getByRole("radio", { name: /Multi-hop route/ }).click();
  await page.getByRole("button", { name: "Select route & continue" }).click();
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("pt-BR");
  await page
    .getByRole("button", { name: "Simular liquidação", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Fornecedor Brasil");
  await page.getByRole("button", { name: "Confirmar simulação" }).click();
  await expect(
    page.getByRole("heading", { name: "Comprovante de liquidação" }),
  ).toBeVisible();
  await expect(
    page.getByText("Rota com múltiplas etapas", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Abrir página de pagamento demonstrativo" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Comprovante de liquidação" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("language selector and bilingual layouts at all five supported widths", async ({
  page,
}) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  for (const width of [1440, 1280, 768, 390, 360]) {
    await page.setViewportSize({ width, height: 950 });
    for (const locale of ["pt-BR", "en-US"] as const) {
      for (const route of [
        "/",
        "/app",
        "/app/invoices",
        "/app/invoices/new",
        `/pay/${seedId}`,
        "/developers",
      ]) {
        await page.goto(route);
        const selector = page.getByRole("combobox", {
          name: /^(Idioma|Language)$/,
        });
        await expect(selector).toBeVisible();
        await selector.selectOption(locale);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        await expect(selector).toHaveValue(locale);
        await page.waitForTimeout(180);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          `${locale} ${route} ${width}`,
        ).toBe(true);
        if (route === "/app") {
          await expect(page.locator(".metrics article").first()).toContainText(
            locale === "pt-BR" ? "172.150,00" : "172,150.00",
          );
          await expect(
            page.getByRole("heading", {
              name: translate(locale, "Recent invoices"),
            }),
          ).toBeVisible();
        }
        if ((width === 1440 || width === 390) && route === "/")
          await page.screenshot({
            path: `test-results/screenshots/home-${locale}-${width}.png`,
            fullPage: true,
          });
      }
    }
  }
  expect(errors).toEqual([]);
});

test("Portuguese accessibility and stable translated status filters", async ({
  page,
}) => {
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const route of ["/", "/app", "/app/invoices/new", `/pay/${seedId}`]) {
    await page.goto(route);
    await page.waitForTimeout(200);
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
  await page.goto("/app/invoices");
  await page
    .getByRole("combobox", { name: "Filtrar por status" })
    .selectOption("Settled");
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page
    .getByRole("combobox", { name: "Idioma", exact: true })
    .selectOption("en-US");
  await expect(
    page.getByRole("combobox", { name: "Filter by status" }),
  ).toHaveValue("Settled");
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(page.locator(".badge").first()).toHaveText("Settled");
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
});
