-- ============================================================
-- Migration: 002_create_failed_payments.sql
-- Purpose  : Stores the synthetic failed-payment batch used
--            for batch evaluation and agent input.
--
-- NOTE: true_root_cause and ambiguity are ground-truth fields
-- used ONLY by the evaluation/scoring layer. They are NEVER
-- exposed to the agent at inference time.
-- ============================================================

CREATE TABLE IF NOT EXISTS failed_payments (
  -- Razorpay-style payment identifier (e.g. "pay_0001")
  id                  TEXT          PRIMARY KEY,

  -- Amount in paise (Razorpay convention: 100 = ₹1)
  amount              INTEGER       NOT NULL,
  currency            TEXT          NOT NULL DEFAULT 'INR',

  -- Payment method used
  method              TEXT          NOT NULL
                        CHECK (method IN ('upi', 'card', 'netbanking', 'wallet')),

  -- Customer and mandate references
  customer_id         TEXT          NOT NULL,
  mandate_id          TEXT,                         -- NULL for non-recurring payments

  -- Failure signals (what the agent sees)
  failure_code        TEXT          NOT NULL,        -- e.g. "BANK_TIMEOUT", "EXPIRED_MANDATE"
  failure_reason_raw  TEXT          NOT NULL,        -- raw, messy string from gateway

  -- Retry tracking
  attempt_number      INTEGER       NOT NULL DEFAULT 1,
  max_attempts_allowed INTEGER      NOT NULL DEFAULT 3,

  -- ── Ground truth (used by eval layer ONLY, never given to agent) ──
  true_root_cause     TEXT          NOT NULL
                        CHECK (true_root_cause IN (
                          'bank_timeout', 'insufficient_funds',
                          'expired_mandate', 'gateway_error', 'unknown'
                        )),
  ambiguity           TEXT          NOT NULL
                        CHECK (ambiguity IN ('low', 'high')),
  -- low  = pre-classifier should handle it without LLM
  -- high = needs Diagnosis Agent (8B) or escalation (70B)

  -- Timestamps
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- ── Agent output columns (filled as the pipeline runs) ───────────
  -- These start NULL and are updated by the execution agent.
  agent_run_id        UUID,                          -- FK to harness run
  agent_diagnosis     TEXT,                          -- root cause the agent decided
  agent_action        TEXT,                          -- action taken
  agent_outcome       TEXT
                        CHECK (agent_outcome IN (
                          'resolved', 'notify_customer_pending',
                          'escalated_to_human', 'stop_rule_hit', 'pending', NULL
                        )),
  agent_processed_at  TIMESTAMPTZ
);

-- ── Indexes ─────────────────────────────────────────────────────────

-- Fast lookup by failure category (used by the pre-classifier query)
CREATE INDEX IF NOT EXISTS idx_failed_payments_failure_code
  ON failed_payments (failure_code);

-- Fast lookup of pending / unprocessed records for batch runs
CREATE INDEX IF NOT EXISTS idx_failed_payments_outcome
  ON failed_payments (agent_outcome)
  WHERE agent_outcome IS NULL;

-- Link back to the harness DAG for a given run
CREATE INDEX IF NOT EXISTS idx_failed_payments_agent_run_id
  ON failed_payments (agent_run_id)
  WHERE agent_run_id IS NOT NULL;

-- ── Comments ─────────────────────────────────────────────────────────
COMMENT ON TABLE  failed_payments IS 'Synthetic failed-payment batch for batch evaluation. true_root_cause and ambiguity are ground-truth columns — never exposed to the agent at inference time.';
COMMENT ON COLUMN failed_payments.id IS 'Razorpay-style payment ID, e.g. pay_0001 or pay_maxed_01.';
COMMENT ON COLUMN failed_payments.amount IS 'Amount in paise (Razorpay convention: 100 = INR 1).';
COMMENT ON COLUMN failed_payments.failure_code IS 'Structured failure code from the gateway, e.g. BANK_TIMEOUT.';
COMMENT ON COLUMN failed_payments.failure_reason_raw IS 'Raw, messy failure string as it arrives from the gateway. This is what the classifier/LLM actually reasons over.';
COMMENT ON COLUMN failed_payments.true_root_cause IS 'Ground truth root cause — used ONLY by the scoring/eval layer, never given to the agent.';
COMMENT ON COLUMN failed_payments.ambiguity IS 'low = pre-classifier should handle without LLM; high = needs Diagnosis Agent or escalation.';
COMMENT ON COLUMN failed_payments.agent_run_id IS 'UUID of the harness run that processed this payment. Links to harness_nodes.run_id.';
COMMENT ON COLUMN failed_payments.agent_outcome IS 'Final outcome written by the execution/stop-rule agent: resolved | escalated_to_human | stop_rule_hit | pending.';
