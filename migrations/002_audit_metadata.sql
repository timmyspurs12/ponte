-- Forward-only amendment: preserve existing invoice/payment history.
CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END $$;

ALTER TABLE businesses
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE users
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE memberships
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE TRIGGER businesses_updated BEFORE UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER memberships_updated BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Descriptive fields are database-generated projections of the presentation
-- snapshot: there is exactly one writable value, not two independent copies.
ALTER TABLE invoices
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN supplier_name text GENERATED ALWAYS AS (data->>'supplier') STORED NOT NULL,
  ADD COLUMN supplier_wallet_address text GENERATED ALWAYS AS (data->>'wallet') STORED NOT NULL,
  ADD COLUMN funding_currency text GENERATED ALWAYS AS (data->>'fundingCurrency') STORED NOT NULL CHECK (funding_currency='BRL'),
  ADD COLUMN settlement_asset text GENERATED ALWAYS AS (data->>'settlementCurrency') STORED NOT NULL CHECK (settlement_asset='USDG'),
  ADD COLUMN due_date date GENERATED ALWAYS AS (
    make_date(left(data->>'due',4)::int, substring(data->>'due',6,2)::int, substring(data->>'due',9,2)::int)
  ) STORED NOT NULL,
  ADD COLUMN description text GENERATED ALWAYS AS (data->>'description') STORED NOT NULL,
  ADD CONSTRAINT invoice_snapshot_consistent CHECK (
    data ?& ARRAY['id','reference','status','fundingMinor','amount'] AND
    (data->>'id') IS NOT DISTINCT FROM id::text AND
    (data->>'reference') IS NOT DISTINCT FROM reference AND
    (data->>'status') IS NOT DISTINCT FROM status AND
    (data->>'fundingMinor') IS NOT DISTINCT FROM funding_minor::text AND
    (data->'amount') IS NOT DISTINCT FROM to_jsonb(funding_minor::numeric/100)
  );
CREATE TRIGGER invoices_updated BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE INDEX invoice_due ON invoices(business_id,due_date);

ALTER TABLE payments
  ADD COLUMN funding_currency text NOT NULL DEFAULT 'BRL' CHECK (funding_currency='BRL'),
  ADD COLUMN status text NOT NULL DEFAULT 'Confirmed' CHECK (status='Confirmed'),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
-- received_at is the authoritative confirmation timestamp, not a second clock.
ALTER TABLE settlements
  ADD COLUMN settlement_asset text NOT NULL DEFAULT 'USDG' CHECK (settlement_asset='USDG'),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT settled_has_output_and_time CHECK (
    (status='Settled' AND actual_minor IS NOT NULL AND settled_at IS NOT NULL) OR
    (status<>'Settled' AND actual_minor IS NULL AND settled_at IS NULL)
  );
CREATE TRIGGER settlements_updated BEFORE UPDATE ON settlements
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Only the versioned migration owner temporarily removes this trigger for
-- historical backfill. DDL/backfill/reinstatement are in the same transaction.
DROP TRIGGER immutable_events ON payment_events;
ALTER TABLE payment_events ADD COLUMN previous_state text, ADD COLUMN new_state text;
WITH history AS (
  SELECT id, lag(data->>'status') OVER (PARTITION BY business_id,invoice_id ORDER BY created_at,id) AS previous
  FROM payment_events
)
UPDATE payment_events e SET previous_state=h.previous, new_state=e.data->>'status'
FROM history h WHERE e.id=h.id;
ALTER TABLE payment_events
  ALTER COLUMN new_state SET NOT NULL,
  ADD CONSTRAINT event_previous_state CHECK (previous_state IS NULL OR previous_state IN ('Draft','Pending payment','Funded','Routing','Settled','Failed')),
  ADD CONSTRAINT event_new_state CHECK (new_state IN ('Draft','Pending payment','Funded','Routing','Settled','Failed')),
  ADD CONSTRAINT event_snapshot_consistent CHECK ((data->>'status') IS NOT DISTINCT FROM new_state);
CREATE TRIGGER immutable_events BEFORE UPDATE OR DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION deny_event_mutation();
CREATE INDEX business_activity ON payment_events(business_id,created_at DESC,id);
