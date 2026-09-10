-- 004 — billing: plans, subscriptions, payments.

DO $$ BEGIN
  CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('pending', 'succeeded', 'failed', 'refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  price_cents      integer NOT NULL CHECK (price_cents >= 0),
  currency         char(3) NOT NULL DEFAULT 'INR',
  billing_interval text NOT NULL DEFAULT 'month' CHECK (billing_interval IN ('month', 'year')),
  max_streams      integer NOT NULL DEFAULT 1 CHECK (max_streams BETWEEN 1 AND 10),
  max_quality      text NOT NULL DEFAULT '480p' CHECK (max_quality IN ('480p', '720p', '1080p', '4k')),
  features         jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active        boolean NOT NULL DEFAULT true,
  sort_order       integer NOT NULL DEFAULT 100,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS plans_set_updated_at ON plans;
CREATE TRIGGER plans_set_updated_at BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  plan_id                  uuid NOT NULL REFERENCES plans (id) ON DELETE RESTRICT,
  status                   subscription_status NOT NULL DEFAULT 'active',
  current_period_start     timestamptz NOT NULL DEFAULT now(),
  current_period_end       timestamptz NOT NULL,
  cancel_at_period_end     boolean NOT NULL DEFAULT false,
  canceled_at              timestamptz,
  trial_end                timestamptz,
  provider                 text NOT NULL DEFAULT 'mock',
  provider_subscription_id text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_period_valid CHECK (current_period_end > current_period_start)
);

-- A user can hold at most one live subscription. Enforced by the database, not by
-- "check-then-insert" application code that races under concurrent requests.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_live_per_user_idx
  ON subscriptions (user_id)
  WHERE status IN ('trialing', 'active', 'past_due');
CREATE INDEX IF NOT EXISTS subscriptions_period_end_idx ON subscriptions (current_period_end);
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions (user_id, created_at DESC);

DROP TRIGGER IF EXISTS subscriptions_set_updated_at ON subscriptions;
CREATE TRIGGER subscriptions_set_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  subscription_id     uuid REFERENCES subscriptions (id) ON DELETE SET NULL,
  plan_id             uuid REFERENCES plans (id) ON DELETE SET NULL,
  amount_cents        integer NOT NULL CHECK (amount_cents >= 0),
  currency            char(3) NOT NULL DEFAULT 'INR',
  status              payment_status NOT NULL DEFAULT 'pending',
  provider            text NOT NULL DEFAULT 'mock',
  provider_payment_id text,
  -- Client-supplied key: retrying a charge must never bill twice.
  idempotency_key     text NOT NULL UNIQUE,
  method_brand        text,
  method_last4        char(4),
  failure_reason      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_user_idx ON payments (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_status_idx ON payments (status, created_at DESC);

DROP TRIGGER IF EXISTS payments_set_updated_at ON payments;
CREATE TRIGGER payments_set_updated_at BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
