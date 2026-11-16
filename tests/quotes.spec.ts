import { test, expect } from "@playwright/test";
import { demoQuote, majorToMinor, quote } from "../src/lib/quotes";
import { formatDate, formatMoney, formatNumber } from "../src/lib/i18n/format";
import { translate } from "../src/lib/i18n/messages";

test("quote preserves illustrative output and gives every route its own floored minimum", () => {
  const q = quote({ fundingMinor: "2500000" });
  expect(q.simulated).toBe(true);
  expect(q).not.toHaveProperty("minimumOutput");
  expect(q.routes.map((r) => r.outputMinor)).toEqual([
    "474523",
    "473904",
    "473095",
  ]);
  for (const r of q.routes) {
    expect(r.slippageBps).toBeLessThanOrEqual(r.toleranceBps);
    expect(BigInt(r.outputMinor)).toBe(
      (2500000n * 100n * BigInt(10000 - r.feeBps)) / (525n * 10000n),
    );
    expect(BigInt(r.minimumOutputMinor)).toBe(
      (BigInt(r.outputMinor) * BigInt(10000 - r.toleranceBps)) / 10000n,
    );
    expect(BigInt(r.minimumOutputMinor)).toBeLessThan(BigInt(r.outputMinor));
    expect(BigInt(r.feeMinor) + BigInt(r.outputMinor)).toBe(
      (2500000n * 100n) / 525n,
    );
  }
  expect(new Set(q.routes.map((r) => r.minimumOutputMinor)).size).toBe(3);
  expect(JSON.parse(JSON.stringify(q))).toEqual(q);
});
test("quote handles cent edges and rejects ambiguous/fractional inputs", () => {
  for (const amount of ["0", "1", "100", "101", "999999999", "1000000000"]) {
    const q = quote({ fundingMinor: amount });
    for (const route of q.routes)
      expect(BigInt(route.minimumOutputMinor)).toBeLessThanOrEqual(
        BigInt(route.outputMinor),
      );
  }
  for (const fundingMinor of ["-1", "1.2", "NaN", "1000000001"])
    expect(() => quote({ fundingMinor })).toThrow("Invalid demo amount.");
  expect(majorToMinor(25000)).toBe("2500000");
  expect(majorToMinor(1.01)).toBe("101");
  expect(demoQuote(25000)).toEqual(quote({ fundingMinor: "2500000" }));
  for (const v of [1.001, NaN, Infinity, -1])
    expect(() => majorToMinor(v)).toThrow();
});
test("formatting is locale-aware and translation preserves identifiers", () => {
  expect(formatMoney(25000, "pt-BR").replace(/\u00a0/g, " ")).toBe(
    "R$ 25.000,00",
  );
  expect(formatMoney(25000, "en-US")).toBe("R$25,000.00");
  expect(formatNumber(4745.23, "pt-BR")).toBe("4.745,23");
  expect(formatNumber(4745.23, "en-US")).toBe("4,745.23");
  expect(formatDate("2026-11-20", "pt-BR")).toBe("20/11/2026");
  expect(formatDate("2026-11-20", "en-US")).toBe("11/20/2026");
  expect(formatDate("2026-11-16T09:30:00.000Z", "pt-BR", true)).toContain(
    "09:30:00 UTC",
  );
  expect(
    translate("pt-BR", "Open {reference}", { reference: "PNT-2026-1048" }),
  ).toBe("Abrir PNT-2026-1048");
  expect(translate("pt-BR", "USDG")).toBe("USDG");
});

test("all static interface translation keys have Portuguese messages", async () => {
  const ts = await import("typescript");
  const fs = await import("node:fs");
  const { ptBR } = await import("../src/lib/i18n/pt-BR");
  const missing: string[] = [];
  for (const file of fs.readdirSync("src/components")) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(`src/components/${file}`, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    function visit(node: import("typescript").Node) {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === "t" &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const key = node.arguments[0].text;
        if (!Object.prototype.hasOwnProperty.call(ptBR, key)) missing.push(key);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(missing).toEqual([]);
});
