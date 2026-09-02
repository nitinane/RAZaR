-- ============================================================
-- Migration: 001_create_harness_nodes.sql
-- Purpose  : Auditable Decision Harness — DAG node store
-- Project  : Revenue Recovery Agent (Razorpay Buildathon)
-- ============================================================

-- Enable the pgcrypto extension so gen_random_uuid() is available
-- (already on by default in Supabase; included here for portability)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -------------------------------------------------------
-- harness_nodes
--   One row = one agent step in a pipeline run.
--   Rows are linked into a DAG via parent_node_id.
--   is_replay marks forked/replayed siblings (never mutates
--   the original node).
-- -------------------------------------------------------
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

  -- Quality signals
  confidence      FLOAT,                    -- 0.0 to 1.0, NULL if not produced
  escalated       BOOLEAN       NOT NULL DEFAULT FALSE,

  -- Observability
  latency_ms      INTEGER       NOT NULL,
  cost_estimate   FLOAT,                    -- USD; NULL for deterministic agents

  -- Replay / fork tracking
  is_replay       BOOLEAN       NOT NULL DEFAULT FALSE,
  replayed_from   UUID          REFERENCES harness_nodes(node_id) ON DELETE SET NULL,
  -- replayed_from stores the original node_id this was forked from (NULL for originals)

  -- Timing
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------
-- Indexes
-- -------------------------------------------------------

-- Fast DAG reconstruction for a given run
CREATE INDEX IF NOT EXISTS idx_harness_nodes_run_id
  ON harness_nodes (run_id);

-- Fast parent to children traversal (tree reconstruction)
CREATE INDEX IF NOT EXISTS idx_harness_nodes_parent_node_id
  ON harness_nodes (parent_node_id);

-- Quickly find all replays derived from a specific original node
CREATE INDEX IF NOT EXISTS idx_harness_nodes_replayed_from
  ON harness_nodes (replayed_from)
  WHERE replayed_from IS NOT NULL;

-- -------------------------------------------------------
-- Comments (visible in Supabase Table Editor)
-- -------------------------------------------------------
COMMENT ON TABLE  harness_nodes                IS 'One row per agent step; rows form a DAG (tree) via parent_node_id. Replay forks create sibling nodes tagged with is_replay=TRUE.';
COMMENT ON COLUMN harness_nodes.node_id        IS 'Stable UUID for this specific agent step.';
COMMENT ON COLUMN harness_nodes.run_id         IS 'Groups all nodes that belong to the same pipeline execution.';
COMMENT ON COLUMN harness_nodes.parent_node_id IS 'UUID of the immediately preceding node; NULL means root of the run.';
COMMENT ON COLUMN harness_nodes.agent_name     IS 'Logical name of the agent that produced this node (e.g. diagnosis_agent).';
COMMENT ON COLUMN harness_nodes.model_used     IS 'LLM model identifier used for this step; NULL for deterministic agents.';
COMMENT ON COLUMN harness_nodes.input          IS 'Full input payload passed to the agent, stored as JSONB.';
COMMENT ON COLUMN harness_nodes.output         IS 'Full output payload returned by the agent, stored as JSONB.';
COMMENT ON COLUMN harness_nodes.confidence     IS 'Agent self-reported confidence in its output (0.0-1.0). NULL if not applicable.';
COMMENT ON COLUMN harness_nodes.escalated      IS 'TRUE if this node triggered an escalation to a more capable model or human.';
COMMENT ON COLUMN harness_nodes.latency_ms     IS 'Wall-clock time the agent took to produce its output, in milliseconds.';
COMMENT ON COLUMN harness_nodes.cost_estimate  IS 'Estimated USD cost of this node (token cost for LLMs; 0 for deterministic). NULL if unknown.';
COMMENT ON COLUMN harness_nodes.is_replay      IS 'TRUE for nodes created by replayNode(); original nodes are always FALSE.';
COMMENT ON COLUMN harness_nodes.replayed_from  IS 'For replay nodes: the node_id of the original node this was forked from.';
COMMENT ON COLUMN harness_nodes.created_at     IS 'Wall-clock UTC timestamp when this node was written.';
