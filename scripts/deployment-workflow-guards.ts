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
 * the order here is asserted against the workflow's `choice` list.
 */
export const DATABASE_OPERATIONS = [
  "verify",
  "migrate",
  "business-bootstrap",
  "demo-bootstrap",
] as const;

export type DatabaseOperation = (typeof DATABASE_OPERATIONS)[number];

/**
 * Operations that mutate the database. `verify` is read-only and may run at
 * any time; the others additionally require the operator to type a
 * confirmation phrase naming the operation.
 */
const mutatingOperations: ReadonlySet<DatabaseOperation> = new Set([
  "migrate",
  "business-bootstrap",
  "demo-bootstrap",
]);

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
  | "BUSINESS_ID_MATCHES_ADMIN"
  | "BUSINESS_ID_IN_RESERVED_RANGE"
  | "CONFIRMATION_MISSING"
  | "CONFIRMATION_MISMATCH"
  | "UNEXPECTED_INPUT";

export type GuardedOperation = {
  operation: DatabaseOperation;
  /** Present only for `business-bootstrap` and `demo-bootstrap`. */
  businessId?: string;
  /** Present only for `business-bootstrap` and `demo-bootstrap`. */
  businessName?: string;
  /** True for `verify`; every other operation mutates. */
  readOnly: boolean;
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
  const readOnly = operation === "verify";

  // `verify` is the only operation that ignores the business inputs.
  if (readOnly) {
    if (
      input.businessId.length > 0 ||
      input.businessName.length > 0 ||
      input.confirmation.length > 0
    ) {
      return { ok: false, failure: "UNEXPECTED_INPUT" };
    }
    return { ok: true, operation: { operation, readOnly } };
  }

  if (input.confirmation.length === 0) {
    return { ok: false, failure: "CONFIRMATION_MISSING" };
  }
  if (input.confirmation !== expectedConfirmation(operation)) {
    return { ok: false, failure: "CONFIRMATION_MISMATCH" };
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
  if (
    input.administratorBusinessId &&
    businessId === input.administratorBusinessId.trim()
  ) {
    return { ok: false, failure: "BUSINESS_ID_MATCHES_ADMIN" };
  }
  if (!businessNameSchema.safeParse(input.businessName).success) {
    return { ok: false, failure: "INVALID_BUSINESS_NAME" };
  }

  return {
    ok: true,
    operation: {
      operation,
      businessId,
      businessName: input.businessName,
      readOnly,
    },
  };
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
    "Unknown operation. Choose migrate, business-bootstrap, demo-bootstrap, or verify.",
  INVALID_BUSINESS_ID: "business_id must be a UUID.",
  INVALID_BUSINESS_NAME:
    "business_name must be 2-80 characters of letters, digits, spaces, and . , & ' ( ) - / with no surrounding whitespace.",
  BUSINESS_ID_MATCHES_ADMIN:
    "business_id must differ from PONTE_AUTH_BUSINESS_ID.",
  BUSINESS_ID_IN_RESERVED_RANGE:
    "business_id falls in a reserved or placeholder range. Local seed and demonstration identifiers cannot be used here.",
  CONFIRMATION_MISSING:
    "Type the confirmation phrase for this operation to proceed.",
  CONFIRMATION_MISMATCH:
    "The confirmation phrase does not match this operation exactly.",
  UNEXPECTED_INPUT:
    "This operation does not accept those inputs; leave unused inputs empty.",
};
