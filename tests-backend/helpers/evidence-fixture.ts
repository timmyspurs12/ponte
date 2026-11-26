/**
 * Minimal valid `route_decision_evidence` envelope for fixtures.
 *
 * Every one of the 29 columns is NOT NULL with no default, and several carry
 * CHECK constraints, so a hand-written INSERT is easy to get subtly wrong:
 *
 * - `chain_id` must be exactly 421614, `sequence` 1, `evidence_kind` 1,
 *   `envelope_version` 1, `aad_version` 1.
 * - `selected_route_code` is `smallint` and must be 1, 2 or 3.
 * - `content_algorithm` must be the literal 'AES-256-GCM'.
 * - `previous_payload_hash` must be 32 zero bytes; `payload_hash` 32 non-zero.
 * - `kms_provider='local-test-only'` requires both wrapped-DEK fields to be
 *   marked `local-test-only`.
 *
 * The bytes are synthetic and carry no meaning: this helper asserts nothing
 * about KMS or on-chain anchoring, and it is only ever used to reach a state a
 * read test starts from.
 */
import { randomBytes, randomUUID } from "node:crypto";

export const EVIDENCE_INSERT_SQL = `INSERT INTO route_decision_evidence(
  id, business_id, invoice_id, quote_id, created_by_user_id,
  routing_correlation_id, public_evidence_id, evidence_schema_version,
  quote_schema_version, chain_id, registry_address, sequence, evidence_kind,
  selected_route_code, quote_snapshot_hash, previous_payload_hash, payload_hash,
  envelope_version, content_algorithm, ciphertext, nonce, authentication_tag,
  wrapped_dek, kms_provider, wrapped_dek_algorithm, wrapped_dek_format,
  kms_key_reference, kms_key_version, aad_version
) VALUES($1,$2,$3,$4,$5,$6,$7,1,1,421614,$8,1,1,1,$9,$10,$11,1,'AES-256-GCM',$12,$13,$14,$15,'local-test-only','LOCAL_TEST_RANDOM_BYTES_V1','local-test-random-bytes-v1','local-test-only/fixture/v1','local-test-only/fixture/v1',1)`;

/** The 15 bind parameters `EVIDENCE_INSERT_SQL` expects, in `$n` order. */
export function evidenceFixtureValues(foreign: {
  id: string;
  businessId: string;
  invoiceId: string;
  quoteId: string;
  userId: string;
}): unknown[] {
  return [
    foreign.id,
    foreign.businessId,
    foreign.invoiceId,
    foreign.quoteId,
    foreign.userId,
    randomUUID(), // routing_correlation_id
    randomBytes(32), // public_evidence_id: UNIQUE across rows
    Buffer.alloc(20, 2), // registry_address
    Buffer.alloc(32, 3), // quote_snapshot_hash
    Buffer.alloc(32, 0), // previous_payload_hash: MUST be all zero
    Buffer.alloc(32, 4), // payload_hash: MUST be non-zero
    Buffer.alloc(24, 5), // ciphertext
    Buffer.alloc(12, 6), // nonce
    Buffer.alloc(16, 7), // authentication_tag
    Buffer.alloc(48, 8), // wrapped_dek
  ];
}
