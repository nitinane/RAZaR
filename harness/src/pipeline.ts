// =============================================================
// pipeline.ts — Pipeline Orchestrator
// Revenue Recovery Agent | Razorpay Buildathon MVP
//
// Orchestrates the deterministic part of the recovery pipeline
// for a single failed payment:
//
//   pre_classifier
//     ├── NOT confident  → [TODO: diagnosis_agent LLM — not built yet]
//     │                    → execution_agent("escalate_human")
//     │                    → outcome: escalated_to_human
//     └── confident
//           └── stop_rule_guard
//                 ├── NOT allowed  → execution_agent("escalate_human")
//                 │                  → outcome: stop_rule_hit
//                 └── allowed      → execution_agent("retry")
//                                    → outcome: resolved | escalated_to_human
//
// Updates failed_payments.agent_outcome / agent_run_id at the end.
// Pure input/output contract — the Supabase client and harness are
// both passed in, never constructed internally.
// =============================================================

import { v4 as uuidv4 } from "uuid";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

import type { HarnessLike } from "./harness.js";
import { runPreClassifier } from "./agents/preClassifier.js";
import { runStopRuleGuard } from "./agents/stopRuleGuard.js";
import { runExecutionAgent } from "./agents/executionAgent.js";
import { runDiagnosisAgent } from "./agents/diagnosisAgent.js";
import { runActionDecisionAgent } from "./agents/actionDecisionAgent.js";

import type {
  FailedPaymentRecord,
  AgentOutcome,
  PipelineResult,
  PipelineConfig,
  RootCauseCategory,
  RecoveryAction,
} from "./types.js";

// ─────────────────────────────────────────────────────────────
// DB helpers — read / write failed_payments
// ─────────────────────────────────────────────────────────────

const TABLE = "failed_payments";

/**
 * Fetch a single payment record from Supabase.
 * Throws if not found or DB error.
 */
export async function fetchPayment(
  db: SupabaseClient,
  payment_id: string
): Promise<FailedPaymentRecord> {
  const { data, error } = await db
    .from(TABLE)
    .select("*")
    .eq("id", payment_id)
    .single();

  if (error || !data) {
    throw new Error(
      `[Pipeline] fetchPayment: payment "${payment_id}" not found — ${error?.message ?? "no data"}`
    );
  }
  return data as FailedPaymentRecord;
}

/**
 * Fetch a batch of unprocessed payments (agent_outcome IS NULL).
 * Ordered by created_at ASC so oldest failures are recovered first.
 */
export async function fetchPendingPayments(
  db: SupabaseClient,
  limit = 10
): Promise<FailedPaymentRecord[]> {
  const { data, error } = await db
    .from(TABLE)
    .select("*")
    .is("agent_outcome", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`[Pipeline] fetchPendingPayments failed: ${error.message}`);
  }
  return (data ?? []) as FailedPaymentRecord[];
}

/**
 * Write the agent's outcome back to the failed_payments row.
 * Called once, at the very end of the pipeline, after all
 * harness nodes have been written.
 */
async function updatePaymentOutcome(
  db: SupabaseClient,
  payment_id: string,
  outcome: AgentOutcome,
  run_id: string,
  agent_diagnosis: string | null,
  agent_action: string
): Promise<void> {
  const { error } = await db
    .from(TABLE)
    .update({
      agent_outcome: outcome,
      agent_run_id: run_id,
      agent_diagnosis,
      agent_action,
      agent_processed_at: new Date().toISOString(),
    })
    .eq("id", payment_id);

  if (error) {
    throw new Error(
      `[Pipeline] updatePaymentOutcome failed for "${payment_id}": ${error.message}`
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Core pipeline function
// ─────────────────────────────────────────────────────────────

/**
 * Runs the full deterministic pipeline for one failed payment.
 *
 * @param harness  - HarnessLike instance (real or mock)
 * @param db       - Supabase client (used to write outcome back to failed_payments)
 * @param payment  - The failed payment record to process
 * @param config   - Optional stop-rule / execution config overrides
 *
 * @returns PipelineResult — full decision summary, ready to display or assert on
 */
export async function runPipeline(
  harness: HarnessLike,
  db: SupabaseClient,
  payment: FailedPaymentRecord,
  config: PipelineConfig = {}
): Promise<PipelineResult> {
  const run_id = uuidv4();
  const nodeIds: PipelineResult["harness_node_ids"] = {};
  let agent_outcome: AgentOutcome;
  let action_taken: PipelineResult["action_taken"];
  let agent_diagnosis: string | null = null;
  let decision_path: string;

  // ── Step 1: Pre-Classifier ─────────────────────────────────
  const { result: classification, node_id: pcNodeId } = await runPreClassifier(
    harness,
    run_id,
    null,  // root of the run
    payment
  );
  nodeIds.pre_classifier = pcNodeId;

  let used_llm = false;
  let policy_overridden = false;

  if (!classification.confident) {
    // ── Path A: Not confident → LLM Dual-Model Diagnosis ─────
    used_llm = true;

    // Step 2a: Run Diagnosis Agent (8B -> 70B if confidence < 0.75)
    const diagnosis = await runDiagnosisAgent(
      harness,
      run_id,
      pcNodeId,
      payment
    );
    nodeIds.diagnosis_agent = diagnosis.escalation_node_id ?? diagnosis.node_id;
    agent_diagnosis = diagnosis.root_cause;

    // Step 2b: Run Stop-Rule Guard after diagnosis
    const { result: stopResult, node_id: sgNodeId } = await runStopRuleGuard(
      harness,
      run_id,
      nodeIds.diagnosis_agent,
      payment,
      config.stopRule ?? {}
    );
    nodeIds.stop_rule_guard = sgNodeId;

    if (!stopResult.allowed) {
      decision_path =
        `pre_classifier not confident -> diagnosis_agent diagnosed '${diagnosis.root_cause}' ` +
        `(${diagnosis.model_used}, conf=${diagnosis.confidence.toFixed(2)}). ` +
        `stop_rule_guard blocked: ${stopResult.reason}`;

      const { node_id: execNodeId } = await runExecutionAgent(
        harness,
        run_id,
        sgNodeId,
        payment,
        "escalate_human",
        config.execution ?? {}
      );
      nodeIds.execution_agent = execNodeId;

      action_taken = "escalate_human";
      agent_outcome = "stop_rule_hit";

    } else {
      // Step 2c: Run Action Decision Agent (LLM + policy enforcement)
      const actionDecision = await runActionDecisionAgent(
        harness,
        run_id,
        sgNodeId,
        payment,
        diagnosis
      );
      nodeIds.action_decision_agent = actionDecision.node_id;
      policy_overridden = actionDecision.policy_overridden;
      action_taken = actionDecision.action;

      decision_path =
        `pre_classifier not confident -> diagnosis_agent diagnosed '${diagnosis.root_cause}' ` +
        `(${diagnosis.model_used}, conf=${diagnosis.confidence.toFixed(2)}) -> ` +
        `action_decision_agent decided '${actionDecision.action}'` +
        (policy_overridden ? " [POLICY OVERRIDDEN]" : "");

      // Step 2d: Execute the decided action
      const { result: execResult, node_id: execNodeId } = await runExecutionAgent(
        harness,
        run_id,
        actionDecision.node_id,
        payment,
        actionDecision.action,
        config.execution ?? {}
      );
      nodeIds.execution_agent = execNodeId;

      if (actionDecision.action === "retry") {
        const succeeded =
          execResult.outcome === "success" || execResult.outcome === "simulated_success";
        agent_outcome = succeeded ? "resolved" : "escalated_to_human";
      } else if (actionDecision.action === "notify_customer") {
        agent_outcome = "notify_customer_pending";
      } else {
        agent_outcome = "escalated_to_human";
      }
    }

  } else {
    // ── Path B: Confident → run Stop-Rule Guard ──────────────
    agent_diagnosis = classification.root_cause ?? null;

    const { result: stopResult, node_id: sgNodeId } = await runStopRuleGuard(
      harness,
      run_id,
      pcNodeId,  // parent: pre_classifier
      payment,
      config.stopRule ?? {}
    );
    nodeIds.stop_rule_guard = sgNodeId;

    if (!stopResult.allowed) {
      // ── Path B1: Stop rule triggered ────────────────────────
      decision_path =
        `pre_classifier confident (root_cause=${classification.root_cause}, ` +
        `score=${classification.confidence.toFixed(2)}). ` +
        `stop_rule_guard blocked: ${stopResult.reason}`;

      const { node_id: execNodeId } = await runExecutionAgent(
        harness,
        run_id,
        sgNodeId,  // parent: stop_rule_guard
        payment,
        "escalate_human",
        config.execution ?? {}
      );
      nodeIds.execution_agent = execNodeId;

      action_taken = "escalate_human";
      agent_outcome = "stop_rule_hit";

    } else {
      // ── Path C: All clear → Policy Action Check ──────────────
      // Enforce policy: expired_mandate & insufficient_funds require customer notification, not retry
      const decidedAction: RecoveryAction =
        classification.root_cause === "expired_mandate" || classification.root_cause === "insufficient_funds"
          ? "notify_customer"
          : classification.root_cause === "unknown"
          ? "escalate_human"
          : "retry";

      decision_path =
        `pre_classifier confident (root_cause=${classification.root_cause}, ` +
        `score=${classification.confidence.toFixed(2)}). ` +
        `stop_rule_guard passed. Action: ${decidedAction}.`;

      const { result: execResult, node_id: execNodeId } = await runExecutionAgent(
        harness,
        run_id,
        sgNodeId,  // parent: stop_rule_guard
        payment,
        decidedAction,
        config.execution ?? {}
      );
      nodeIds.execution_agent = execNodeId;

      action_taken = decidedAction;

      if (decidedAction === "retry") {
        const succeeded =
          execResult.outcome === "success" || execResult.outcome === "simulated_success";
        agent_outcome = succeeded ? "resolved" : "escalated_to_human";
      } else if (decidedAction === "notify_customer") {
        agent_outcome = "notify_customer_pending";
      } else {
        agent_outcome = "escalated_to_human";
      }
    }
  }

  // ── Write outcome back to the DB ───────────────────────────
  await updatePaymentOutcome(
    db,
    payment.id,
    agent_outcome,
    run_id,
    agent_diagnosis,
    action_taken
  );

  return {
    payment_id: payment.id,
    run_id,
    root_cause: agent_diagnosis as RootCauseCategory,
    action_taken,
    agent_outcome,
    harness_node_ids: nodeIds,
    decision_path,
    used_llm,
    policy_overridden,
  };
}

// ─────────────────────────────────────────────────────────────
// Factory helpers
// ─────────────────────────────────────────────────────────────

/**
 * Creates a Supabase client from env vars (SUPABASE_URL, SUPABASE_KEY).
 * Returns null if env vars are missing, printing a warning.
 */
export function createDbClient(): SupabaseClient | null {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_KEY"];
  if (!url || !key) {
    console.warn("[Pipeline] ⚠  SUPABASE_URL/SUPABASE_KEY not set — DB writes will be skipped.");
    return null;
  }
  return createClient(url, key);
}
