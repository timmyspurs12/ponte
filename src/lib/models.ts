import type { MinorUnits } from "./quotes";
export type Status =
  "Draft" | "Pending payment" | "Funded" | "Routing" | "Settled" | "Failed";
export interface Wallet {
  address: string;
  network: "Arbitrum";
}
export interface Business {
  id: string;
  name: string;
  wallet?: Wallet;
}
export interface Payment {
  invoiceId: string;
  currency: "BRL";
  amount: number;
  simulated: true;
  receivedAt?: string;
}
export interface RouteCandidate {
  id: string;
  name: string;
  feeBps: number;
  feeMinor: MinorUnits;
  outputMinor: MinorUnits;
  /** Estimated price impact, not the user protection tolerance. */
  slippageBps: number;
  toleranceBps: number;
  minimumOutputMinor: MinorUnits;
}
export interface PaymentQuote {
  fundingMinor: MinorUnits;
  asset: "USDG";
  demoAssetDecimals: 2;
  rate: { numerator: string; denominator: string };
  executionCostMinor: MinorUnits;
  simulated: true;
  routes: RouteCandidate[];
}
export interface RouteExecution {
  routeId: string;
  costMinor: MinorUnits;
  identifier: string;
  simulated: true;
}
export interface SettlementReceipt {
  invoiceId: string;
  sender: string;
  recipient: string;
  originalAmountMinor: MinorUnits;
  asset: "USDG";
  amountMinor: MinorUnits;
  route: string;
  execution: RouteExecution;
  timestamp: string;
}
export interface Invoice {
  id: string;
  reference: string;
  supplier: string;
  wallet: string;
  amount: number;
  fundingCurrency: "BRL";
  settlementCurrency: "USDG";
  due: string;
  created: string;
  description: string;
  status: Status;
  receipt?: SettlementReceipt;
  payment?: Payment;
  selectedRoute?: string;
}
export type InvoiceInput = Pick<
  Invoice,
  "reference" | "supplier" | "wallet" | "amount" | "due" | "description"
>;
export interface InvoiceService {
  list(): Promise<Invoice[]>;
  create(input: InvoiceInput): Promise<Invoice>;
  transition(id: string, status: Status, route?: string): Promise<Invoice>;
}
