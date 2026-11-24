import { guardFailureText, guardOperation } from "./deployment-workflow-guards";
import { readOptionalUuid } from "./optional-environment";

/**
 * Validation-only entry point for the manual database workflow.
 *
 * This runs *before* the job environment contains the database secret, so an
 * unapproved actor, a wrong branch, a malformed UUID, or a missing confirmation
 * phrase fails here — with no credential in scope and no network connection
 * attempted. It prints the operation name and the mutated/read-only class only,
 * never an input echo, so a mistyped business name does not land in a public
 * workflow log.
 *
 * The identity and cross-tenant rules are the same ones the operating step
 * re-applies. Three of them are worth naming because they used to be missing
 * or global:
 *
 * - `business-bootstrap` must name exactly `PONTE_AUTH_BUSINESS_ID`;
 * - both demo operations must name a different UUID, and must match
 *   `PONTE_PUBLIC_DEMO_BUSINESS_ID` when it is set;
 * - `demo-verify` is read-only: it takes the tenant inputs and no confirmation.
 */
function main(): void {
  /*
   * `""` from an unset repository variable reaches this step as a real string.
   * The guard normalises it, so nothing here has to; the `demo-verify` line
   * below only echoes back what the guard decided.
   */
  const guarded = guardOperation({
    eventName: process.env.PONTE_DB_OPS_EVENT_NAME ?? "",
    ref: process.env.PONTE_DB_OPS_REF ?? "",
    actor: process.env.PONTE_DB_OPS_ACTOR ?? "",
    operatorAllowlist: process.env.PONTE_DB_OPERATORS,
    operation: process.env.PONTE_DB_OPS_OPERATION ?? "",
    businessId: process.env.PONTE_DB_OPS_BUSINESS_ID ?? "",
    businessName: process.env.PONTE_DB_OPS_BUSINESS_NAME ?? "",
    confirmation: process.env.PONTE_DB_OPS_CONFIRMATION ?? "",
    administratorBusinessId: process.env.PONTE_AUTH_BUSINESS_ID,
    demoBusinessId: process.env.PONTE_PUBLIC_DEMO_BUSINESS_ID,
  });

  if (!guarded.ok) {
    console.error(`Refused: ${guardFailureText[guarded.failure]}`);
    process.exitCode = 1;
    return;
  }

  const { operation, readOnly, businessId } = guarded.operation;
  console.log(
    `Inputs accepted: ${operation} (${readOnly ? "read-only" : "mutating"}).`,
  );
  // A read-only check of the optional variables, printed as states rather than
  // values, so a log never echoes a mistyped identifier. This is what makes the
  // empty-string case visible before the operating step runs.
  const administrator = readOptionalUuid(process.env.PONTE_AUTH_BUSINESS_ID);
  const demo = readOptionalUuid(process.env.PONTE_PUBLIC_DEMO_BUSINESS_ID);
  console.log(
    `Optional configuration: PONTE_AUTH_BUSINESS_ID=${administrator.state}, PONTE_PUBLIC_DEMO_BUSINESS_ID=${demo.state}, PONTE_PUBLIC_DEMO_READ_ONLY=${process.env.PONTE_PUBLIC_DEMO_READ_ONLY || "unset"}.`,
  );
  if (businessId) {
    // The UUID is operator-supplied and already validated; printing it lets an
    // operator confirm they targeted the intended tenant. It is not a secret.
    console.log(`Target tenant: ${businessId}.`);
  }
}

main();
