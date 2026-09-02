export type AgentOutcome =
  | "resolved"
  | "notify_customer_pending"
  | "escalated_to_human"
  | "stop_rule_hit"
  | "pending";

export type RootCauseCategory =
  | "bank_timeout"
  | "insufficient_funds"
  | "expired_mandate"
  | "gateway_error"
  | "unknown";

export type RecoveryAction =
  | "retry"
  | "notify_customer"
  | "escalate_human";

export interface HarnessTreeNode {
  node_id: string;
  run_id: string;
  parent_node_id: string | null;
  agent_name: string;
  model_used: string | null;
  input: Record<string, any>;
  output: Record<string, any>;
  confidence: number | null;
  escalated: boolean;
  latency_ms: number;
  cost_estimate: number | null;
  is_replay: boolean;
  replayed_from: string | null;
  created_at: string;
  children: HarnessTreeNode[];
}

export interface EvalPaymentRecord {
  payment_id: string;
  amount: number;
  currency: "INR";
  method: "upi" | "card" | "netbanking" | "wallet";
  failure_code: string;
  failure_reason_raw: string;
  attempt_number: number;
  true_root_cause: RootCauseCategory;
  ambiguity: "low" | "high";
  pipeline: {
    run_id: string;
    diagnosed_root_cause: RootCauseCategory | null;
    action_taken: RecoveryAction | string;
    agent_outcome: AgentOutcome;
    used_llm: boolean;
    policy_overridden: boolean;
    decision_path: string;
    duration_ms: number;
  };
  trace: HarnessTreeNode[];
}

export interface EvalMetrics {
  total_records: number;
  financials: {
    total_volume_inr: number;
    recovered_volume_inr: number;
    notified_volume_inr: number;
    unresolved_volume_inr: number;
    recovery_rate_volume_pct: number;
  };
  recovery_rate_pct: number;
  outcomes: Record<AgentOutcome, { count: number; pct: number }>;
  classification_accuracy: {
    overall: { total: number; correct: number; accuracy_pct: number };
    pre_classifier_only: { total: number; correct: number; accuracy_pct: number };
    llm_diagnosed: { total: number; correct: number; accuracy_pct: number };
  };
  false_positive_cost: {
    count: number;
    total_amount_paise: number;
    total_amount_inr: number;
    cases: Array<{
      payment_id: string;
      amount_inr: number;
      true_root_cause: RootCauseCategory;
      diagnosed_root_cause?: RootCauseCategory;
      action_taken: string;
      reason: string;
    }>;
  };
  escalation: {
    total_llm_cases: number;
    escalated_to_70b_count: number;
    escalation_rate_llm_pct: number;
    escalation_rate_total_pct: number;
  };
  policy_overrides: {
    total_overrides: number;
    override_rate_llm_pct: number;
    override_rate_total_pct: number;
    cases: Array<{
      payment_id: string;
      diagnosed_root_cause?: RootCauseCategory;
      llm_suggested_action: string;
      enforced_action: string;
      reason: string;
    }>;
  };
  unresolved_exceptions: Array<{
    payment_id: string;
    amount_inr: number;
    attempt_number: number;
    max_attempts_allowed: number;
    true_root_cause: string;
    failure_reason_raw: string;
    violations: string[];
  }>;
}

export interface BatchEvalData {
  metadata: {
    generated_at: string;
    dataset_size: number;
    pipeline_version: string;
    description: string;
  };
  metrics: EvalMetrics;
  results: EvalPaymentRecord[];
}
