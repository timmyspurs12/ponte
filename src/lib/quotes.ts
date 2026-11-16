import type { PaymentQuote, RouteCandidate } from "./models";
/** JSON-safe integer minor units. Demo USDG scale is 2; NOT onchain token decimals. */
export type MinorUnits = string;
export interface QuoteInput {
  fundingMinor: MinorUnits;
}
export function majorToMinor(value: number): MinorUnits {
  if (!Number.isFinite(value) || value < 0 || value > 10000000)
    throw new Error("Invalid demo amount.");
  // Legacy invoice-form boundary only. Reject sub-cent input; never use this in execution.
  const text = value.toFixed(2);
  if (Number(text) !== value) throw new Error("Invalid demo amount.");
  return text.replace(".", "");
}
/** Display boundary only. Never feed its result back into quote/execution math. */
export const minorToDisplayNumber = (value: MinorUnits) => Number(value) / 100;
export function quote({ fundingMinor }: QuoteInput): PaymentQuote {
  if (!/^\d+$/.test(fundingMinor) || BigInt(fundingMinor) > 1000000000n)
    throw new Error("Invalid demo amount.");
  const funding = BigInt(fundingMinor),
    gross = (funding * 100n) / 525n;
  const routes: RouteCandidate[] = [
    ["direct", "Direct liquidity", 35, 5],
    ["split", "Split liquidity", 48, 8],
    ["multi", "Multi-hop route", 65, 12],
  ].map(([id, name, fee, slippage]) => {
    const feeBps = Number(fee),
      slippageBps = Number(slippage),
      output = (funding * 100n * BigInt(10000 - feeBps)) / (525n * 10000n);
    return {
      id: String(id),
      name: String(name),
      feeBps,
      feeMinor: (gross - output).toString(),
      slippageBps,
      toleranceBps: 50,
      outputMinor: output.toString(),
      minimumOutputMinor: ((output * 9950n) / 10000n).toString(),
    };
  });
  return {
    fundingMinor,
    asset: "USDG",
    demoAssetDecimals: 2,
    rate: { numerator: "525", denominator: "100" },
    executionCostMinor: "2",
    simulated: true,
    routes,
  };
}
/** Adapter from Phase 1's existing browser-local major-unit invoices. */
export const demoQuote = (amount: number) =>
  quote({ fundingMinor: majorToMinor(amount) });
