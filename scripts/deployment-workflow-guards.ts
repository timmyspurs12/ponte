import { z } from "zod";

/**
 * Input validation and dispatch policy for the manual database workflow
 * (`.github/workflows/manual-database-operations.yml`).
 *
 * The workflow itself is YAML, which cannot express "operator must be on this
 * allow-list" or "these two UUIDs must differ". Those rules live here, in
 * TypeScript, so that:
 *
 * - they are unit-testable without GitHub,
 * - the workflow can call `npm run db:ops:validate` as its first real step and
 *   fail in seconds, before `secrets.DATABASE_URL_DIRECT` is ever read into a
 *   step environment, and
 * - the same rules can be re-asserted inside each operation, so a forged
 *   `workflow_dispatch` payload cannot widen the blast radius even if the
 *   workflow YAML were edited by someone careless.
 *
 * Nothing in this module touches the network, the filesystem, or secrets.
 */

/** The only branch allowed to dispatch a database operation. */
export const APPROVED_REF = "refs/heads/main";

/**
 * Ordered operations; the workflow runs exactly one per dispatch. `verify` is
 * first because it is the read-only default an operator should reach for, and
 * `demo-verify` is last because it is the read-only check an operator runs
 * after the public demo is enabled. The order here is asserted against the
 * workflow's `choice` list.
 */
export const DATABASE_OPERATIONS = [
  "verify",
  "migrate",
  "business-bootstrap",
  "demo-bootstrap",
  "demo-verify",
] as const;

export type DatabaseOperation = (typeof DATABASE_OPERATIONS)[number];

/**
 * Operations that never write. `verify` may run at any time; `demo-verify`
 * inspects the synthetic tenant and runs `bootstrapPublicDemo` with
 * `verifyOnly: true`, which opens a `READ ONLY` transaction.
 */
export const READ_ONLY_OPERATIONS: ReadonlySet<DatabaseOperation> = new Set([
  "verify",
  "demo-verify",
]);

/**
 * Operations that mutate the database. They additionally require the operator
 * to type a confirmation phrase naming the operation.
 */
export const MUTATING_OPERATIONS: readonly DatabaseOperation[] =
  DATABASE_OPERATIONS.filter(
    (operation) => !READ_ONLY_OPERATIONS.has(operation),
  );

/** True when the operation may be dispatched without a confirmation phrase. */
export function isReadOnlyOperation(operation: DatabaseOperation): boolean {
  return READ_ONLY_OPERATIONS.has(operation);
}

/** Confirmation phrase: `APPLY <operation>`; case-sensitive on purpose. */
export function expectedConfirmation(operation: DatabaseOperation): string {
  return `APPLY ${operation}`;
}

export type GuardFailure =
  | "UNEXPECTED_EVENT"
  | "UNAPPROVED_REF"
  | "UNAPPROVED_ACTOR"
  | "OPERATOR_ALLOWLIST_INVALID"
  | "UNKNOWN_OPERATION"
  | "INVALID_BUSINESS_ID"
  | "INVALID_BUSINESS_NAME"
  | "ADMIN_BUSINESS_INVALID"
  | "BUSINESS_ID_MATCHES_ADMIN"
  | "BUSINESS_ID_DOES_NOT_MATCH_ADMIN"
  | "DEMO_BUSINESS_ID_MISMATCH"
  | "BUSINESS_ID_IN_RESERVED_RANGE"
  | "CONFIRMATION_MISSING"
  | "CONFIRMATION_MISMATCH"
  | "UNEXPECTED_INPUT";

export type GuardedOperation = {
  operation: DatabaseOperation;
  /** Present only for the operations that target a tenant. */
  businessId?: string;
  /** Present only for the operations that target a tenant. */
  businessName?: string;
  /** True for `verify` and `demo-verify`; the others mutate. */
  readOnly: boolean;
  /**
   * `business-bootstrap` with no `PONTE_AUTH_BUSINESS_ID` configured. The row
   * is created first and the variable is set afterwards, so this is a warning
   * the caller prints — not a refusal.
   */
  administratorUnconfigured?: boolean;
  /**
   * A demo operation with no `PONTE_PUBLIC_DEMO_BUSINESS_ID` configured. The
   * checked tenant is then exactly the one the operator supplied, and callers
   * must not describe it as "the configured demo tenant".
   */
  demoBusinessIdUnconfigured?: boolean;
};

export type GuardResult =
  | { ok: true; operation: GuardedOperation }
  | { ok: false; failure: GuardFailure };

/**
 * Business names are shown to real users, so the charset is narrow: letters,
 * digits, spaces, and the punctuation a company name plausibly needs. Control
 * characters, quotes, shell metacharacters, and newlines are excluded so that
 * a name can never alter a command line or a log line.
 */
const businessNameSchema = z
  .string()
  .min(2, "too short")
  .max(80, "too long")
  .refine((value) => value.trim() === value, "surrounding whitespace")
  .refine(
    (value) => /^[\p{L}\p{N}][\p{L}\p{N} .,&'()\-/]*$/u.test(value),
    "unsupported characters",
  )
  // `&` alone is common in company names ("Silva & Filhos"); shell operator
  // sequences (`&&`, `||`, `$(`, `${`) are not, and are refused even though
  // the value only ever reaches the process through an environment variable.
  .refine((value) => !/&&|\|\||\$[({]/.test(value), "operator sequence");

/**
 * UUIDv5 values generated from the demo namespace in `public-demo-data.ts`
 * start with a uniform random-looking prefix, so no prefix test can recognise
 * them. The tenant UUID is supplied by the operator and is checked against the
 * server-side guards (`DEMO_CONFIG_MISMATCH`, `ADMIN_BUSINESS_MISMATCH`)
 * instead. `business-bootstrap`, by contrast, must be a *random* UUIDv4: a
 * version-5 UUID there would mean someone hand-derived a tenant identifier.
 */
const businessBootstrapUuidVersions = ["4"] as const;

const placeholderBusinessIds = [
  // The local seed business and the documented runbook placeholders must never
  // become the production administrator or demo tenant by accident.
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
] as const;

export type GuardInput = {
  eventName: string;
  ref: string;
  /** GitHub login of the operator that dispatched the run. */
  actor: string;
  /** Comma-separated allow-list from repository configuration. */
  operatorAllowlist: string | undefined;
  operation: string;
  businessId: string;
  businessName: string;
  confirmation: string;
  /** `PONTE_AUTH_BUSINESS_ID` from repository configuration. */
  administratorBusinessId: string | undefined;
  /**
   * `PONTE_PUBLIC_DEMO_BUSINESS_ID` from repository configuration. Optional:
   * before the demo is enabled there is nothing to read, and the operator's
   * input is then the only source of the demo UUID.
   */
  demoBusinessId?: string | undefined;
};

function parseAllowlist(
  raw: string | undefined,
): { ok: true; logins: Set<string> } | { ok: false } {
  if (!raw || raw.length > 4096) return { ok: false };
  const logins = raw
    .split(",")
    .map((login) => login.trim())
    .filter((login) => login.length > 0);
  if (!logins.length) return { ok: false };
  // GitHub logins: alphanumeric or single hyphens, max 39 characters.
  if (
    logins.some(
      (login) =>
        !/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(login),
    )
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    logins: new Set(logins.map((login) => login.toLowerCase())),
  };
}

/**
 * Applies the whole dispatch policy. Order is significant: identity and
 * branch are checked before operation semantics, and operation semantics
 * before business identifiers, so an unauthorized actor learns nothing about
 * what the inputs would have done.
 */
export function guardOperation(input: GuardInput): GuardResult {
  if (input.eventName !== "workflow_dispatch") {
    return { ok: false, failure: "UNEXPECTED_EVENT" };
  }
  if (input.ref !== APPROVED_REF) {
    return { ok: false, failure: "UNAPPROVED_REF" };
  }

  const allowlist = parseAllowlist(input.operatorAllowlist);
  if (!allowlist.ok)
    return { ok: false, failure: "OPERATOR_ALLOWLIST_INVALID" };
  if (!allowlist.logins.has(input.actor.trim().toLowerCase())) {
    return { ok: false, failure: "UNAPPROVED_ACTOR" };
  }

  if (!(DATABASE_OPERATIONS as readonly string[]).includes(input.operation)) {
    return { ok: false, failure: "UNKNOWN_OPERATION" };
  }
  const operation = input.operation as DatabaseOperation;
  const readOnly = isReadOnlyOperation(operation);

  // `verify` is the only operation that ignores the business inputs entirely.
  if (operation === "verify") {
    if (
      input.businessId.length > 0 ||
      input.businessName.length > 0 ||
      input.confirmation.length > 0
    ) {
      return { ok: false, failure: "UNEXPECTED_INPUT" };
    }
    return { ok: true, operation: { operation, readOnly } };
  }

  // `demo-verify` is read-only but still names the tenant it inspects.
  if (!readOnly) {
    if (input.confirmation.length === 0) {
      return { ok: false, failure: "CONFIRMATION_MISSING" };
    }
    if (input.confirmation !== expectedConfirmation(operation)) {
      return { ok: false, failure: "CONFIRMATION_MISMATCH" };
    }
  } else if (input.confirmation.length > 0) {
    // A read-only operation must never carry a mutation confirmation: it would
    // mean the operator expected a write.
    return { ok: false, failure: "UNEXPECTED_INPUT" };
  }

  // `migrate` mutates schema only: it must not carry tenant identifiers.
  if (operation === "migrate") {
    if (input.businessId.length > 0 || input.businessName.length > 0) {
      return { ok: false, failure: "UNEXPECTED_INPUT" };
    }
    return { ok: true, operation: { operation, readOnly } };
  }

  const businessId = input.businessId.trim().toLowerCase();
  if (!z.uuid().safeParse(businessId).success) {
    return { ok: false, failure: "INVALID_BUSINESS_ID" };
  }
  if ((placeholderBusinessIds as readonly string[]).includes(businessId)) {
    return { ok: false, failure: "BUSINESS_ID_IN_RESERVED_RANGE" };
  }
  if (
    operation === "business-bootstrap" &&
    !(businessBootstrapUuidVersions as readonly string[]).includes(
      businessId[14],
    )
  ) {
    return { ok: false, failure: "INVALID_BUSINESS_ID" };
  }
  if (!businessNameSchema.safeParse(input.businessName).success) {
    return { ok: false, failure: "INVALID_BUSINESS_NAME" };
  }

  if (operation === "business-bootstrap") {
    return guardPrivateBootstrap(input, businessId, readOnly);
  }
  return guardDemoOperation(input, operation, businessId, readOnly);
}

/**
 * The private bootstrap creates the administrator tenant. Its UUID **must**
 * equal `PONTE_AUTH_BUSINESS_ID` whenever that variable is configured: the
 * documented sequence is "set the variable, then create the row it names", and
 * a mismatch would leave the deployed service pointing at a tenant that does
 * not exist. Creating a *different* private tenant is exactly the mistake the
 * demo path exists to avoid, so it is refused here.
 *
 * When the variable is not configured the operation is allowed with a warning,
 * because the first run necessarily precedes the variable being set.
 */
function guardPrivateBootstrap(
  input: GuardInput,
  businessId: string,
  readOnly: boolean,
): GuardResult {
  const administratorBusinessId = normalizeUuid(input.administratorBusinessId);
  if (input.administratorBusinessId !== undefined && !administratorBusinessId) {
    return { ok: false, failure: "ADMIN_BUSINESS_INVALID" };
  }
  if (administratorBusinessId) {
    if (businessId !== administratorBusinessId) {
      return { ok: false, failure: "BUSINESS_ID_DOES_NOT_MATCH_ADMIN" };
    }
    return {
      ok: true,
      operation: {
        operation: "business-bootstrap",
        businessId,
        businessName: input.businessName,
        readOnly,
      },
    };
  }
  return {
    ok: true,
    operation: {
      operation: "business-bootstrap",
      businessId,
      businessName: input.businessName,
      readOnly,
      administratorUnconfigured: true,
    },
  };
}

/**
 * The demo tenant is a synthetic showcase, never the administrator tenant:
 *
 * - its UUID must differ from `PONTE_AUTH_BUSINESS_ID`;
 * - when `PONTE_PUBLIC_DEMO_BUSINESS_ID` is configured, its UUID must equal it,
 *   so an operator cannot populate one tenant while the service is told to
 *   show another. `demo-bootstrap` and `demo-verify` apply the same rule, so
 *   the check is identical before and after the flag is enabled.
 */
function guardDemoOperation(
  input: GuardInput,
  operation: "demo-bootstrap" | "demo-verify",
  businessId: string,
  readOnly: boolean,
): GuardResult {
  const administratorBusinessId = normalizeUuid(input.administratorBusinessId);
  if (input.administratorBusinessId !== undefined && !administratorBusinessId) {
    return { ok: false, failure: "ADMIN_BUSINESS_INVALID" };
  }
  if (administratorBusinessId && businessId === administratorBusinessId) {
    return { ok: false, failure: "BUSINESS_ID_MATCHES_ADMIN" };
  }

  const configuredDemoBusinessId = normalizeUuid(input.demoBusinessId);
  if (input.demoBusinessId !== undefined && !configuredDemoBusinessId) {
    return { ok: false, failure: "DEMO_BUSINESS_ID_MISMATCH" };
  }
  if (configuredDemoBusinessId && businessId !== configuredDemoBusinessId) {
    return { ok: false, failure: "DEMO_BUSINESS_ID_MISMATCH" };
  }

  return {
    ok: true,
    operation: {
      operation,
      businessId,
      businessName: input.businessName,
      readOnly,
      ...(configuredDemoBusinessId ? {} : { demoBusinessIdUnconfigured: true }),
    },
  };
}

/** Lower-cased UUID text, or `undefined` when the value is absent or invalid. */
function normalizeUuid(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return z.uuid().safeParse(normalized).success ? normalized : undefined;
}

/** One sentence per failure, safe to print in a workflow log. */
export const guardFailureText: Record<GuardFailure, string> = {
  UNEXPECTED_EVENT:
    "This workflow may only run from workflow_dispatch; no other event is accepted.",
  UNAPPROVED_REF:
    "Database operations may only be dispatched from the main branch.",
  UNAPPROVED_ACTOR:
    "The dispatching account is not on PONTE_DB_OPERATORS. Ask a repository administrator to update the allow-list.",
  OPERATOR_ALLOWLIST_INVALID:
    "PONTE_DB_OPERATORS is missing, empty, or not a comma-separated list of GitHub logins.",
  UNKNOWN_OPERATION:
    "Unknown operation. Choose migrate, business-bootstrap, demo-bootstrap, demo-verify, or verify.",
  INVALID_BUSINESS_ID: "business_id must be a UUID.",
  INVALID_BUSINESS_NAME:
    "business_name must be 2-80 characters of letters, digits, spaces, and . , & ' ( ) - / with no surrounding whitespace.",
  ADMIN_BUSINESS_INVALID:
    "PONTE_AUTH_BUSINESS_ID is set but is not a UUID; fix the repository variable before dispatching.",
  BUSINESS_ID_MATCHES_ADMIN:
    "business_id must differ from PONTE_AUTH_BUSINESS_ID; the demo tenant and the administrator tenant are always distinct.",
  BUSINESS_ID_DOES_NOT_MATCH_ADMIN:
    "business-bootstrap must use exactly PONTE_AUTH_BUSINESS_ID; otherwise the deployed service would point at a tenant that was never created. Use demo-bootstrap for the synthetic demo tenant.",
  DEMO_BUSINESS_ID_MISMATCH:
    "business_id must equal the configured PONTE_PUBLIC_DEMO_BUSINESS_ID when that variable is set; the demo tenant in the database and the one the service is told to show must agree.",
  BUSINESS_ID_IN_RESERVED_RANGE:
    "business_id falls in a reserved or placeholder range. Local seed and demonstration identifiers cannot be used here.",
  CONFIRMATION_MISSING:
    "Type the confirmation phrase for this operation to proceed.",
  CONFIRMATION_MISMATCH:
    "The confirmation phrase does not match this operation exactly.",
  UNEXPECTED_INPUT:
    "This operation does not accept those inputs; leave unused inputs empty.",
};
