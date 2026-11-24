-- External OAuth subjects are identity bindings, not authorization grants.
-- GitHub's stable numeric account ID is stored as text to preserve its exact
-- value; display_name is an immutable, non-authoritative presentation label.
CREATE TABLE external_identities (
  provider text NOT NULL CHECK (provider = 'github'),
  subject text NOT NULL CHECK (subject ~ '^[1-9][0-9]{0,19}$'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (
    char_length(display_name) BETWEEN 1 AND 39
    AND display_name ~ '^[A-Za-z0-9-]+$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject),
  UNIQUE (provider, user_id)
);

CREATE INDEX external_identities_user_id ON external_identities(user_id);

-- An OAuth callback may create a binding once, but it must never repoint an
-- existing user or provider subject. Presentation labels are likewise kept
-- immutable so a later login cannot silently alter the identity record.
CREATE FUNCTION deny_external_identity_remap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'External identity mappings are immutable';
END
$$;

CREATE TRIGGER immutable_external_identities
  BEFORE UPDATE OR DELETE ON external_identities
  FOR EACH ROW EXECUTE FUNCTION deny_external_identity_remap();
