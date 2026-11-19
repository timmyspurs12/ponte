-- Route-decision evidence is private, immutable application data. It is not a
-- payment, settlement, or blockchain transaction record.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM quotes
    WHERE date_trunc('milliseconds', expires_at) IS DISTINCT FROM expires_at
  ) THEN
    RAISE EXCEPTION
      'quotes.expires_at contains sub-millisecond data and cannot support exact evidence commitments';
  END IF;
END $$;

ALTER TABLE quotes
  ADD CONSTRAINT quotes_expires_at_millisecond_precision
  CHECK (date_trunc('milliseconds', expires_at) = expires_at);

CREATE TABLE route_decision_evidence (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  quote_id uuid NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  routing_correlation_id uuid NOT NULL,
  public_evidence_id bytea NOT NULL UNIQUE,
  evidence_schema_version smallint NOT NULL CHECK (evidence_schema_version = 1),
  quote_schema_version smallint NOT NULL CHECK (quote_schema_version = 1),
  chain_id numeric(20,0) NOT NULL CHECK (chain_id = 421614),
  registry_address bytea NOT NULL CHECK (octet_length(registry_address) = 20),
  sequence numeric(20,0) NOT NULL CHECK (sequence = 1),
  evidence_kind smallint NOT NULL CHECK (evidence_kind = 1),
  selected_route_code smallint NOT NULL CHECK (selected_route_code IN (1,2,3)),
  quote_snapshot_hash bytea NOT NULL CHECK (octet_length(quote_snapshot_hash) = 32),
  previous_payload_hash bytea NOT NULL CHECK (
    octet_length(previous_payload_hash) = 32
    AND previous_payload_hash = decode(repeat('00', 32), 'hex')
  ),
  payload_hash bytea NOT NULL CHECK (
    octet_length(payload_hash) = 32
    AND payload_hash <> decode(repeat('00', 32), 'hex')
  ),
  envelope_version smallint NOT NULL CHECK (envelope_version = 1),
  content_algorithm text NOT NULL CHECK (content_algorithm = 'AES-256-GCM'),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) > 0),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  authentication_tag bytea NOT NULL CHECK (octet_length(authentication_tag) = 16),
  wrapped_dek bytea NOT NULL CHECK (octet_length(wrapped_dek) > 0),
  kms_key_reference text NOT NULL CHECK (kms_key_reference <> ''),
  kms_key_version text NOT NULL CHECK (kms_key_version <> ''),
  aad_version smallint NOT NULL CHECK (aad_version = 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, invoice_id)
    REFERENCES invoices(business_id, id),
  FOREIGN KEY (business_id, invoice_id, quote_id)
    REFERENCES quotes(business_id, invoice_id, id),
  UNIQUE (business_id, invoice_id),
  CHECK (
    octet_length(public_evidence_id) = 32
    AND public_evidence_id <> decode(repeat('00', 32), 'hex')
  )
);

CREATE INDEX route_decision_evidence_business_created
  ON route_decision_evidence(business_id, created_at DESC, id);

CREATE FUNCTION deny_route_decision_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Route-decision evidence is immutable';
END $$;

CREATE TRIGGER immutable_route_decision_evidence
  BEFORE UPDATE OR DELETE ON route_decision_evidence
  FOR EACH ROW EXECUTE FUNCTION deny_route_decision_evidence_mutation();

CREATE TABLE evidence_outbox (
  id uuid PRIMARY KEY,
  evidence_record_id uuid NOT NULL UNIQUE REFERENCES route_decision_evidence(id),
  submission_state text NOT NULL CHECK (submission_state IN (
    'pending',
    'submitted',
    'confirmed',
    'retryable',
    'failed',
    'reconciliation_required'
  )),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_owner text,
  lease_acquired_at timestamptz,
  lease_expires_at timestamptz,
  attestor_address bytea CHECK (
    attestor_address IS NULL OR octet_length(attestor_address) = 20
  ),
  transaction_nonce numeric(78,0) CHECK (
    transaction_nonce IS NULL OR transaction_nonce >= 0
  ),
  calldata_hash bytea CHECK (
    calldata_hash IS NULL OR octet_length(calldata_hash) = 32
  ),
  transaction_hash bytea CHECK (
    transaction_hash IS NULL OR octet_length(transaction_hash) = 32
  ),
  submitted_at timestamptz,
  confirmed_at timestamptz,
  confirmed_block_number numeric(78,0) CHECK (
    confirmed_block_number IS NULL OR confirmed_block_number >= 0
  ),
  confirmed_block_hash bytea CHECK (
    confirmed_block_hash IS NULL OR octet_length(confirmed_block_hash) = 32
  ),
  last_failure_class text CHECK (
    last_failure_class IS NULL OR last_failure_class ~ '^[a-z0-9_]{1,64}$'
  ),
  last_failure_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (lease_token IS NULL AND lease_owner IS NULL AND lease_acquired_at IS NULL AND lease_expires_at IS NULL)
    OR (
      lease_token IS NOT NULL
      AND lease_owner IS NOT NULL
      AND lease_acquired_at IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at > lease_acquired_at
    )
  )
);

CREATE TRIGGER evidence_outbox_updated
  BEFORE UPDATE ON evidence_outbox
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE INDEX evidence_outbox_ready
  ON evidence_outbox(next_attempt_at, created_at, id)
  WHERE submission_state IN ('pending', 'retryable', 'submitted');

CREATE INDEX evidence_outbox_expired_lease
  ON evidence_outbox(lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;
