-- ============================================================
-- 000_FULL_SETUP.sql — Hardened Production Database Setup
-- Project: Revenue Recovery Agent (Razorpay Buildathon)
-- Includes:
--   1. Schema: harness_nodes, failed_payments, promise tracking
--   2. Referential Integrity & Performance Indexes
--   3. Row Level Security (RLS) & Role-Based Policies
--   4. Audit Trail Immutability Trigger (DB-enforced append-only)
-- ============================================================

-- ── 1. Extensions ──────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 2. Table: harness_nodes (Auditable Decision Trace Store) 
CREATE TABLE IF NOT EXISTS harness_nodes (
  -- Identity
  node_id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID          NOT NULL,
  parent_node_id  UUID          REFERENCES harness_nodes(node_id) ON DELETE SET NULL,

  -- Agent metadata
  agent_name      TEXT          NOT NULL,
  model_used      TEXT,                     -- NULL for deterministic agents

  -- Payload
  input           JSONB         NOT NULL,
  output          JSONB         NOT NULL,

  -- Quality & observability
  confidence      FLOAT,
  escalated       BOOLEAN       NOT NULL DEFAULT FALSE,
  latency_ms      INTEGER       NOT NULL,
  cost_estimate   FLOAT,                    -- USD

  -- Replay tracking
  is_replay       BOOLEAN       NOT NULL DEFAULT FALSE,
  replayed_from   UUID          REFERENCES harness_nodes(node_id) ON DELETE SET NULL,

  -- Timing
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Indexes for fast tree reconstruction and parent/child lookups
CREATE INDEX IF NOT EXISTS idx_harness_nodes_run_id 
  ON harness_nodes (run_id);
CREATE INDEX IF NOT EXISTS idx_harness_nodes_parent_node_id 
  ON harness_nodes (parent_node_id);
CREATE INDEX IF NOT EXISTS idx_harness_nodes_replayed_from 
  ON harness_nodes (replayed_from);

-- ── 3. Table: failed_payments (Synthetic Benchmark & Outcomes) 
CREATE TABLE IF NOT EXISTS failed_payments (
  -- Identity
  id                   TEXT          PRIMARY KEY,

  -- Payment details
  amount               INTEGER       NOT NULL,
  currency             TEXT          NOT NULL DEFAULT 'INR',
  method               TEXT          NOT NULL CHECK (method IN ('upi', 'card', 'netbanking', 'wallet')),
  customer_id          TEXT          NOT NULL,
  mandate_id           TEXT,

  -- Failure signals
  failure_code         TEXT          NOT NULL,
  failure_reason_raw   TEXT          NOT NULL,
  attempt_number       INTEGER       NOT NULL DEFAULT 1,
  max_attempts_allowed INTEGER       NOT NULL DEFAULT 3,

  -- Evaluation ground truth (isolated from inference agents)
  true_root_cause      TEXT          NOT NULL CHECK (true_root_cause IN (
                         'bank_timeout', 'insufficient_funds',
                         'expired_mandate', 'gateway_error', 'unknown'
                       )),
  ambiguity            TEXT          NOT NULL CHECK (ambiguity IN ('low', 'high')),

  -- Audit & execution tracking
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  agent_run_id         UUID,
  agent_diagnosis      TEXT,
  agent_action         TEXT,
  agent_outcome        TEXT CHECK (agent_outcome IN (
                         'resolved', 'notify_customer_pending',
                         'escalated_to_human', 'stop_rule_hit', 'pending', NULL
                       )),
  agent_processed_at   TIMESTAMPTZ,

  -- Track 03: Promise-to-Pay Extension columns
  promised_pay_by      TIMESTAMPTZ,
  promise_status       TEXT CHECK (promise_status IN ('none', 'pending', 'kept', 'broken', NULL)) DEFAULT 'none'
);

-- Indexes for pipeline lookups
CREATE INDEX IF NOT EXISTS idx_failed_payments_failure_code 
  ON failed_payments (failure_code);
CREATE INDEX IF NOT EXISTS idx_failed_payments_outcome 
  ON failed_payments (agent_outcome) 
  WHERE agent_outcome IS NULL;
CREATE INDEX IF NOT EXISTS idx_failed_payments_agent_run_id 
  ON failed_payments (agent_run_id);

-- ── 4. Security: Row Level Security (RLS) ──────────────────
-- Enforce RLS on both tables so anonymous public requests are blocked.
ALTER TABLE harness_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE failed_payments ENABLE ROW LEVEL SECURITY;

-- Remove any old policies to ensure a clean state
DROP POLICY IF EXISTS "Service role has full access to harness_nodes" ON harness_nodes;
DROP POLICY IF EXISTS "Deny anon access to harness_nodes" ON harness_nodes;
DROP POLICY IF EXISTS "Service role has full access to failed_payments" ON failed_payments;
DROP POLICY IF EXISTS "Deny anon access to failed_payments" ON failed_payments;

-- Explicit Policy: Backend service role (used by harness & pipeline) has full read/write access
CREATE POLICY "Service role has full access to harness_nodes"
  ON harness_nodes
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role has full access to failed_payments"
  ON failed_payments
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Explicit Policy: Public anon role is completely denied read & write
CREATE POLICY "Deny anon access to harness_nodes"
  ON harness_nodes
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Deny anon access to failed_payments"
  ON failed_payments
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

-- ── 5. Security: Database-Enforced Audit Trail Immutability ─
-- Function & Trigger: Strictly reject any UPDATE or DELETE on harness_nodes.
-- Guarantees the auditable decision trail cannot be tampered with.
CREATE OR REPLACE FUNCTION enforce_harness_node_immutability()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'harness_nodes rows are immutable decision audit records and cannot be modified or deleted (attempted % on node_id %)', TG_OP, OLD.node_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_harness_node_immutable ON harness_nodes;
CREATE TRIGGER trg_harness_node_immutable
  BEFORE UPDATE OR DELETE ON harness_nodes
  FOR EACH ROW
  EXECUTE FUNCTION enforce_harness_node_immutability();
