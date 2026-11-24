/**
 * Optional repository-variable normalisation.
 *
 * GitHub Actions cannot represent "this repository variable does not exist".
 * A workflow that writes
 *
 * ```yaml
 * env:
 *   PONTE_AUTH_BUSINESS_ID: ${{ vars.PONTE_AUTH_BUSINESS_ID }}
 * ```
 *
 * does not leave the variable undefined when the variable is unset: the
 * expression resolves to the empty string and the child process receives
 * `PONTE_AUTH_BUSINESS_ID=""`. An application that only tests
 * `value === undefined` therefore sees a *configured* variable whose value is
 * blank, and refuses a dispatch the operator believes is correct.
 *
 * This module draws the distinction once, so no caller has to rediscover it:
 *
 * | input                | `readOptionalString` | `readOptionalUuid` | `readDemoFlag` |
 * | -------------------- | -------------------- | ------------------ | -------------- |
 * | absent (`undefined`) | unset                | unset              | unset          |
 * | `""`                 | unset                | unset              | unset          |
 * | `"0"`                | configured           | invalid            | disabled       |
 * | `"1"`                | configured           | invalid            | enabled        |
 * | `"  "` (whitespace)  | **invalid**          | **invalid**        | **invalid**    |
 * | `"<uuid>"`           | configured           | configured         | invalid        |
 *
 * The whitespace row is deliberate. Collapsing *any* blank-looking value to
 * "unset" would let `"   "` mean "no demo tenant configured", which is a
 * different statement from "nobody filled this in yet" and hides a typo. Only
 * the exact empty string — the one shape GitHub itself produces — is treated as
 * absent. Everything else non-empty must survive validation or be refused.
 *
 * This module reads no `process.env`, performs no I/O, and imports nothing, so
 * it is safe in a CLI, in a request handler, and in a unit test.
 */

/** A value that is either genuinely absent or a non-blank string. */
export type OptionalString =
  | { readonly state: "unset" }
  | { readonly state: "configured"; readonly value: string };

/** A value that must be a UUID when it is present at all. */
export type OptionalUuid =
  | { readonly state: "unset" }
  | { readonly state: "configured"; readonly value: string }
  | { readonly state: "invalid"; readonly reason: "malformed" };

/** A tri-state flag: `1` on, absent/`""`/`0` off, anything else wrong. */
export type DemoFlag =
  | { readonly state: "unset" }
  | { readonly state: "disabled" }
  | { readonly state: "enabled" }
  | { readonly state: "invalid" };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `undefined` and the exact empty string both mean "not configured".
 * A whitespace-only string is *not* unset; it is a malformed value and is
 * reported as such by the typed readers below.
 */
export function readOptionalString(value: string | undefined): OptionalString {
  if (value === undefined || value === "") return { state: "unset" };
  return { state: "configured", value };
}

/**
 * A repository variable that must hold a UUID when it holds anything.
 *
 * Surrounding whitespace is trimmed before validation, because a trailing
 * newline pasted from a terminal is a realistic operator mistake that changes
 * nothing about the identifier. A value that is *only* whitespace is rejected:
 * treating it as unset would silently disable a check the operator believes is
 * active.
 */
export function readOptionalUuid(value: string | undefined): OptionalUuid {
  const optional = readOptionalString(value);
  if (optional.state === "unset") return optional;
  const trimmed = optional.value.trim();
  if (!trimmed) return { state: "invalid", reason: "malformed" };
  if (!uuidPattern.test(trimmed))
    return { state: "invalid", reason: "malformed" };
  return { state: "configured", value: trimmed.toLowerCase() };
}

/**
 * `PONTE_PUBLIC_DEMO_READ_ONLY`.
 *
 * The deployed runtime (`auth-config.ts`) accepts `undefined`, `"0"` and `"1"`,
 * and treats every other value as a configuration error. This reader keeps the
 * same contract while adding the empty string, which the runtime never sees
 * because a host dashboard cannot store a blank value.
 */
export function readDemoFlag(value: string | undefined): DemoFlag {
  if (value === undefined || value === "") return { state: "unset" };
  if (value === "0") return { state: "disabled" };
  if (value === "1") return { state: "enabled" };
  return { state: "invalid" };
}

/** Convenience: a flag is on only in the `enabled` state. */
export function demoFlagIsEnabled(value: string | undefined): boolean {
  return readDemoFlag(value).state === "enabled";
}
