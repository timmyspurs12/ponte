-- Explicit metadata is required to interpret provider-opaque wrapped DEKs.  A
-- historic evidence row cannot be inferred safely: prior records do not state
-- which provider workflow or opaque ciphertext format produced wrapped_dek.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM route_decision_evidence) THEN
    RAISE EXCEPTION
      'cannot add required KMS envelope metadata while route_decision_evidence contains rows; export/reconcile them with explicit approved metadata before applying migration 004';
  END IF;
END $$;

ALTER TABLE route_decision_evidence
  ADD COLUMN kms_provider text NOT NULL,
  ADD COLUMN wrapped_dek_algorithm text NOT NULL,
  ADD COLUMN wrapped_dek_format text NOT NULL;

-- Stable resource/reference selected for the wrapping operation; this is not
-- an alias for a particular provider version or material identifier.
COMMENT ON COLUMN route_decision_evidence.kms_key_reference IS
  'Stable provider key resource/reference used to wrap the DEK (for example, a parent CryptoKey or KMS key ARN).';

-- Exact provider-specific version or key-material identifier returned or
-- selected for this wrapping operation. Providers without one must fail before
-- insertion rather than storing incomplete metadata.
COMMENT ON COLUMN route_decision_evidence.kms_key_version IS
  'Exact provider-specific key version or key-material identifier recorded for the DEK wrapping operation.';

COMMENT ON COLUMN route_decision_evidence.kms_provider IS
  'Provider identifier for the opaque wrapped DEK; only reviewed provider/format combinations are accepted.';
COMMENT ON COLUMN route_decision_evidence.wrapped_dek_algorithm IS
  'Provider-specific wrapping operation/algorithm identifier required to interpret wrapped_dek.';
COMMENT ON COLUMN route_decision_evidence.wrapped_dek_format IS
  'Non-secret versioned serialization discriminator for the provider-opaque wrapped_dek bytes.';

ALTER TABLE route_decision_evidence
  ADD CONSTRAINT route_decision_evidence_registry_address_nonzero
    CHECK (registry_address <> decode(repeat('00', 20), 'hex')),
  ADD CONSTRAINT route_decision_evidence_kms_key_reference_format
    CHECK (
      char_length(kms_key_reference) BETWEEN 1 AND 2048
      AND kms_key_reference ~ '^[A-Za-z0-9][A-Za-z0-9:/._+=,@-]*$'
    ),
  ADD CONSTRAINT route_decision_evidence_kms_key_version_format
    CHECK (
      char_length(kms_key_version) BETWEEN 1 AND 2048
      AND kms_key_version ~ '^[A-Za-z0-9][A-Za-z0-9:/._+=,@-]*$'
    ),
  ADD CONSTRAINT route_decision_evidence_kms_provider_format
    CHECK (kms_provider ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT route_decision_evidence_wrapped_dek_algorithm_format
    CHECK (wrapped_dek_algorithm ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  ADD CONSTRAINT route_decision_evidence_wrapped_dek_format_format
    CHECK (wrapped_dek_format ~ '^[a-z][a-z0-9-]{2,63}$'),
  ADD CONSTRAINT route_decision_evidence_wrapped_dek_provider_contract
    CHECK (
      (
        kms_provider = 'gcp-cloud-kms'
        AND wrapped_dek_algorithm = 'GOOGLE_SYMMETRIC_ENCRYPTION'
        AND wrapped_dek_format = 'gcp-kms-encrypt-ciphertext-v1'
      )
      OR (
        kms_provider = 'aws-kms'
        AND wrapped_dek_algorithm = 'AWS_KMS_GENERATE_DATA_KEY_AES_256'
        AND wrapped_dek_format = 'aws-kms-generate-data-key-ciphertext-blob-v1'
      )
    );
