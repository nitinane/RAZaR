// =============================================================
// types.ts — Shared domain types for the Revenue Recovery Pipeline
// Revenue Recovery Agent | Razorpay Buildathon MVP
//
// ⚠  true_root_cause and ambiguity are ground-truth fields.
//    They exist on FailedPaymentRecord for the eval/scoring layer
//    but are NEVER read by any agent at inference time.
// =============================================================

// ─────────────────────────────────────────────────────────────
// Domain enums
// ─────────────────────────────────────────────────────────────

export type RootCauseCategory =
  | "bank_timeout"
  | "insufficient_funds"
  | "expired_mandate"
  | "gateway_error"
  | "unknown";

export type PaymentMethod = "upi" | "card" | "netbanking" | "wallet";

/** Action the pipeline decides to take for a payment. */
export type RecoveryAction =
  | "retry"            // Create new Razorpay order, attempt collection
  | "notify_customer"  // Send customer notification (e.g. mandate renewal link)
  | "escalate_human";  // Mark for human review, no automated action

/** Final outcome written back to failed_payments.agent_outcome. */
export type AgentOutcome =
  | "resolved"                 // retry succeeded
  | "notify_customer_pending"  // customer notified (mandate renewal / top-up prompt sent)
  | "escalated_to_human"       // handed to human (unclear diagnosis / unrecoverable)
  | "stop_rule_hit"            // exceeded attempt limit or spend cap
  | "pending";                 // in-flight (should not appear in final state)

// ─────────────────────────────────────────────────────────────
// Promise-to-Pay (P2P) Tracking Types (Track 03 Extension)
// ─────────────────────────────────────────────────────────────

export type PromiseStatus = "none" | "pending" | "kept" | "broken";
export type PromiseEscalationStatus = "on_track" | "overdue_gentle" | "overdue_firm" | "resolved";

export interface PromiseTrackingData {
  promise_status: PromiseStatus;
  promised_pay_by: string | null;
  escalation_status?: PromiseEscalationStatus;
  days_overdue?: number;
}

// ─────────────────────────────────────────────────────────────
// failed_payments table row (as read from Supabase)
// ─────────────────────────────────────────────────────────────

export interface FailedPaymentRecord {
  // Core payment fields (what the agent sees)
  id: string;
  amount: number;           // paise (Razorpay convention: 100 = ₹1)
  currency: "INR";
  method: PaymentMethod;
  customer_id: string;
  mandate_id: string | null;
  failure_code: string;
  failure_reason_raw: string;
  attempt_number: number;
  max_attempts_allowed: number;
  created_at: string;

  // Promise-to-Pay tracking fields
  promised_pay_by?: string | null;
  promise_status?: PromiseStatus | null;

  // Ground truth — eval layer ONLY, never given to agents at inference time
  true_root_cause?: RootCauseCategory;
  ambiguity?: "low" | "high";

  // Agent output columns (null until pipeline runs)
  agent_run_id?: string | null;
  agent_diagnosis?: string | null;
  agent_action?: string | null;
  agent_outcome?: AgentOutcome | null;
  agent_processed_at?: string | null;
}

// ─────────────────────────────────────────────────────────────
// Pre-Classifier output
// ─────────────────────────────────────────────────────────────

export interface ClassificationResult {
  /** True if the pre-classifier is confident enough to proceed without LLM. */
  confident: boolean;
  /** Identified root cause. Only set when confident = true. */
  root_cause?: RootCauseCategory;
  /** Classifier's confidence score (0.0–1.0). */
  confidence: number;
  /** Human-readable description of the pattern that matched. */
  matched_pattern: string;
  /** Textual reasoning — surfaced in the harness node output. */
  reasoning: string;
}

// ─────────────────────────────────────────────────────────────
// Stop-Rule Guard output
// ─────────────────────────────────────────────────────────────

export interface StopRuleResult {
  /** True = pipeline may proceed. False = must escalate_human. */
  allowed: boolean;
  /** Single-sentence summary of the decision. */
  reason: string;
  /** All violated rules (can be multiple). Empty when allowed=true. */
  violations: string[];
}

export interface StopRuleConfig {
  /** Max INR spend (in paise) the agent is allowed to trigger. Default: 5_000_000 = INR 50,000 */
  maxSpendCapPaise?: number;
}

// ─────────────────────────────────────────────────────────────
// Execution Agent output
// ─────────────────────────────────────────────────────────────

export interface ExecutionResult {
  action: RecoveryAction;
  /** Outcome of the execution step. */
  outcome: "success" | "failure" | "escalated" | "simulated_success" | "simulated_failure";
  /** Razorpay order_id, set when action=retry and an order was created. */
  razorpay_order_id?: string;
  /** Human-readable notes on what happened. */
  notes: string;
  /** Wall-clock duration of the execution step in ms. */
  latency_ms: number;
}

export interface ExecutionConfig {
  /** Pin the outcome for deterministic testing. Defaults to random (70% success). */
  forceOutcome?: "success" | "failure";
  /** Override success probability (0–1). Default 0.70. */
  successRate?: number;
}

// ─────────────────────────────────────────────────────────────
// Diagnosis Agent output (LLM)
// ─────────────────────────────────────────────────────────────

export interface DiagnosisResult {
  root_cause: RootCauseCategory;
  confidence: number;
  reasoning: string;
  /** Which model produced the final result. */
  model_used: string;
  /** True if the 70B escalation was triggered (confidence < 0.75 from 8B). */
  escalated_to_70b: boolean;
  /** node_id of the primary 8B harness node. */
  node_id: string;
  /** node_id of the 70B escalation harness node, if triggered. */
  escalation_node_id?: string;
}

// ─────────────────────────────────────────────────────────────
// Action Decision Agent output (LLM)
// ─────────────────────────────────────────────────────────────

export interface ActionDecisionResult {
  action: RecoveryAction;
  reasoning: string;
  /** True if the policy layer overrode the LLM's suggested action. */
  policy_overridden: boolean;
  /** The action the LLM originally suggested before policy enforcement. */
  llm_suggested_action: RecoveryAction;
  node_id: string;
}

// ─────────────────────────────────────────────────────────────
// Pipeline output
// ─────────────────────────────────────────────────────────────

export interface PipelineResult {
  payment_id: string;
  run_id: string;
  /** Root cause as determined by pre-classifier or diagnosis agent. */
  root_cause?: RootCauseCategory;
  /** What action the pipeline decided. */
  action_taken: RecoveryAction | "pending_llm_diagnosis";
  /** Final DB-writeable outcome. */
  agent_outcome: AgentOutcome;
  /** node_ids for each harness step, for downstream linking. */
  harness_node_ids: {
    pre_classifier?: string;
    stop_rule_guard?: string;
    diagnosis_agent?: string;
    action_decision_agent?: string;
    execution_agent?: string;
    promise_tracker?: string;
  };
  /** Promise-to-Pay tracking state (set when outcome is notify_customer_pending). */
  promise_tracking?: PromiseTrackingData;
  /** Reason the pipeline took this path (for logging/display). */
  decision_path: string;
  /** True if the LLM path was used (diagnosis + action-decision agents). */
  used_llm: boolean;
  /** True if policy layer overrode the LLM's action choice. */
  policy_overridden?: boolean;
}

// ─────────────────────────────────────────────────────────────
// Pipeline config (passed at construction time)
// ─────────────────────────────────────────────────────────────

export interface PipelineConfig {
  stopRule?: StopRuleConfig;
  execution?: ExecutionConfig;
}
