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
  fee: number;
  output: number;
  slippage: number;
}
export interface PaymentQuote {
  rate: number;
  routes: RouteCandidate[];
  minimumOutput: number;
}
export interface RouteExecution {
  routeId: string;
  cost: number;
  identifier: string;
  simulated: true;
}
export interface SettlementReceipt {
  invoiceId: string;
  sender: string;
  recipient: string;
  originalAmount: number;
  asset: "USDG";
  amount: number;
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
