/** JSON-safe base-10 integer string, denominated in explicitly documented minor units. */
export type MinorUnits = string;
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
  /** Phase 1 legacy major-unit field. Never use for real financial execution. */
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
  createdAt?: string;
  updatedAt?: string;
  fundingMinor?: MinorUnits;
  quote?: PaymentQuote;
  id: string;
  reference: string;
  supplier: string;
  wallet: string;
  /** Phase 1 legacy major-unit field. Never use for real financial execution. */
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
export interface BusinessActivityEvent {
  id: string;
  invoice_id: string;
  kind: string;
  previous_state: Status | null;
  new_state: Status;
  created_at: string;
}
export type EvidenceOutboxSubmissionState =
  | "pending"
  | "submitted"
  | "confirmed"
  | "retryable"
  | "failed"
  | "reconciliation_required";

export type EvidenceProvider = "local-test-only" | "gcp-cloud-kms" | "aws-kms";

/** Non-secret, product-facing disclosure for persisted DEK provenance. */
export interface EvidenceProvenance {
  provider: EvidenceProvider;
  category:
    "synthetic-local-test" | "genuine-gcp-metadata" | "genuine-aws-metadata";
  disclosure: string;
}

/** Only the public commitment and operational metadata are exposed here. */
export interface PersistedInvoiceEvidenceStatus {
  publicEvidenceId: string;
  evidenceKind: number;
  evidenceSchemaVersion: number;
  chainId: string;
  registryAddress: string;
  sequence: string;
  previousPayloadHash: string;
  payloadHash: string;
  provenance: EvidenceProvenance;
  createdAt: string;
  /** Exact persisted outbox state, not an anchoring claim. */
  outboxSubmissionState: EvidenceOutboxSubmissionState | null;
}

/**
 * Anchoring claim for one evidence record.
 *
 * The `verified: false` branch carries no transaction hash, block, or attestor
 * field at all, so a not-yet-verified record cannot accidentally render as
 * anchored. Only a receipt that has satisfied every check in
 * `src/server/evidence/anchor-verification.ts` produces the `verified: true`
 * branch, and that branch is never persisted on its own.
 */
export type EvidenceAnchoringStatus =
  | { verified: false; status: "not_verified" }
  | {
      verified: true;
      status: "verified";
      chainId: string;
      registryAddress: string;
      transactionHash: string;
      blockNumber: string;
      blockHash: string;
      attestor: string;
    };

export type InvoiceEvidenceStatus =
  | {
      state: "missing";
      invoiceId: string;
      evidence: null;
    }
  | {
      state: "persisted";
      invoiceId: string;
      evidence: PersistedInvoiceEvidenceStatus;
      anchoring: EvidenceAnchoringStatus;
    };

export interface WorkspaceAuthentication {
  authenticated: true;
  accountLabel: string;
  access: {
    role: "admin" | "operator" | "viewer";
    readOnly: boolean;
    publicDemo: boolean;
  } | null;
}

export interface InvoiceService {
  activity(): Promise<BusinessActivityEvent[]>;
  list(): Promise<Invoice[]>;
  create(input: InvoiceInput): Promise<Invoice>;
  transition(id: string, status: Status, route?: string): Promise<Invoice>;
  evidence(id: string, signal?: AbortSignal): Promise<InvoiceEvidenceStatus>;
}
