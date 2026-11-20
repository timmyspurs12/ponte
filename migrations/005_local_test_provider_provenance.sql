-- Preserve historical approved provider metadata exactly as stored. This
-- migration only extends the reviewed tuple constraint for explicitly marked
-- local synthetic test data; it neither updates nor relabels existing evidence.
ALTER TABLE route_decision_evidence
  DROP CONSTRAINT route_decision_evidence_wrapped_dek_provider_contract;

ALTER TABLE route_decision_evidence
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
      OR (
        kms_provider = 'local-test-only'
        AND wrapped_dek_algorithm = 'LOCAL_TEST_RANDOM_BYTES_V1'
        AND wrapped_dek_format = 'local-test-random-bytes-v1'
        AND kms_key_reference LIKE 'local-test-only/%'
        AND kms_key_version LIKE 'local-test-only/%'
      )
    );

COMMENT ON COLUMN route_decision_evidence.kms_provider IS
  'Wrapping provenance identifier. local-test-only denotes synthetic local data only and is never evidence of a KMS operation, registry deployment, or on-chain anchoring.';
COMMENT ON COLUMN route_decision_evidence.wrapped_dek_algorithm IS
  'Reviewed provider operation/algorithm identifier, or LOCAL_TEST_RANDOM_BYTES_V1 for non-KMS synthetic local-test bytes.';
COMMENT ON COLUMN route_decision_evidence.wrapped_dek_format IS
  'Non-secret opaque-byte format. local-test-random-bytes-v1 is synthetic local-test data only and is not an interoperable KMS ciphertext.';
