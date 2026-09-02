// =============================================================
// metrics.ts — Batch Evaluation Metrics Calculator
// Revenue Recovery Agent | Razorpay Buildathon MVP
//
// Computes honest, defensible metrics from ground truth:
//   - recovery_rate: resolved / total
//   - classification_accuracy: pre-classifier vs LLM breakdown
//   - false_positive_cost: wasteful retries (insufficient_funds / expired_mandate)
//   - escalation_rate: 8B -> 70B escalations
//   - policy_override_rate: LLM suggestions overridden by code
//   - outcome_breakdown: 4 distinct outcome buckets
//   - unresolved_exceptions: unabridged list of stop_rule_hit cases
// =============================================================

import type { BatchRecordResult } from "./batchRunner.js";
import type { AgentOutcome, RootCauseCategory, RecoveryAction } from "./types.js";

// ─────────────────────────────────────────────────────────────
// Metric Types
// ─────────────────────────────────────────────────────────────

export interface AccuracyBreakdown {
  total: number;
  correct: number;
  accuracy_pct: number;
}

export interface FalsePositiveRetryCase {
  payment_id: string;
  amount_inr: number;
  true_root_cause: RootCauseCategory;
  diagnosed_root_cause?: RootCauseCategory;
  action_taken: RecoveryAction | string;
  reason: string;
}

export interface FalsePositiveCostMetrics {
  count: number;
  total_amount_paise: number;
  total_amount_inr: number;
  cases: FalsePositiveRetryCase[];
}

export interface PolicyOverrideCase {
  payment_id: string;
  diagnosed_root_cause?: RootCauseCategory;
  llm_suggested_action: string;
  enforced_action: string;
  reason: string;
}

export interface StopRuleExceptionCase {
  payment_id: string;
  amount_inr: number;
  attempt_number: number;
  max_attempts_allowed: number;
  true_root_cause: string;
  failure_reason_raw: string;
  violations: string[];
}

export interface BatchMetrics {
  total_records: number;
  
  // Financial Volume
  financials: {
    total_volume_inr: number;
    recovered_volume_inr: number;
    notified_volume_inr: number;
    unresolved_volume_inr: number;
    recovery_rate_volume_pct: number;
  };

  // Outcome Counts & Rates
  recovery_rate_pct: number;
  outcomes: Record<AgentOutcome, { count: number; pct: number }>;

  // Classification Accuracy
  classification_accuracy: {
    overall: AccuracyBreakdown;
    pre_classifier_only: AccuracyBreakdown;
    llm_diagnosed: AccuracyBreakdown;
  };

  // Honest False-Positive Cost
  false_positive_cost: FalsePositiveCostMetrics;

  // Model Escalation
  escalation: {
    total_llm_cases: number;
    escalated_to_70b_count: number;
    escalation_rate_llm_pct: number;
    escalation_rate_total_pct: number;
  };

  // Policy Enforcement
  policy_overrides: {
    total_overrides: number;
    override_rate_llm_pct: number;
    override_rate_total_pct: number;
    cases: PolicyOverrideCase[];
  };

  // Full Unabridged Stop-Rule List
  unresolved_exceptions: StopRuleExceptionCase[];
}

// ─────────────────────────────────────────────────────────────
// Metrics Calculation Function
// ─────────────────────────────────────────────────────────────

/**
 * Computes comprehensive benchmark metrics for a batch run using ground-truth data.
 *
 * @param batchResults - Array of BatchRecordResult objects
 * @returns BatchMetrics object with calculated rates and breakdowns
 */
export function computeMetrics(batchResults: BatchRecordResult[]): BatchMetrics {
  const total = batchResults.length;
  if (total === 0) {
    throw new Error("[Metrics] Cannot compute metrics on empty batch results.");
  }

  // 1. Outcome Breakdown & Volume
  const outcomeCounts: Record<AgentOutcome, number> = {
    resolved: 0,
    notify_customer_pending: 0,
    escalated_to_human: 0,
    stop_rule_hit: 0,
    pending: 0,
  };

  let totalVolumePaise = 0;
  let recoveredVolumePaise = 0;
  let notifiedVolumePaise = 0;
  let unresolvedVolumePaise = 0;

  for (const item of batchResults) {
    const outcome = item.result.agent_outcome;
    outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1;

    const amt = item.payment.amount;
    totalVolumePaise += amt;

    if (outcome === "resolved") {
      recoveredVolumePaise += amt;
    } else if (outcome === "notify_customer_pending") {
      notifiedVolumePaise += amt;
    } else {
      unresolvedVolumePaise += amt;
    }
  }

  const outcomes = {} as Record<AgentOutcome, { count: number; pct: number }>;
  for (const [key, count] of Object.entries(outcomeCounts)) {
    outcomes[key as AgentOutcome] = {
      count,
      pct: Number(((count / total) * 100).toFixed(2)),
    };
  }

  // 2. Classification Accuracy (Pre-classifier vs LLM vs Overall)
  let preTotal = 0;
  let preCorrect = 0;
  let llmTotal = 0;
  let llmCorrect = 0;

  for (const item of batchResults) {
    const trueCause = item.payment.true_root_cause;
    const diagnosedCause = item.result.root_cause;
    const usedLlm = item.result.used_llm;

    const isCorrect = Boolean(trueCause && diagnosedCause && trueCause === diagnosedCause);

    if (usedLlm) {
      llmTotal++;
      if (isCorrect) llmCorrect++;
    } else {
      preTotal++;
      if (isCorrect) preCorrect++;
    }
  }

  const overallCorrect = preCorrect + llmCorrect;

  const classification_accuracy = {
    overall: {
      total,
      correct: overallCorrect,
      accuracy_pct: Number(((overallCorrect / total) * 100).toFixed(2)),
    },
    pre_classifier_only: {
      total: preTotal,
      correct: preCorrect,
      accuracy_pct: preTotal > 0 ? Number(((preCorrect / preTotal) * 100).toFixed(2)) : 0,
    },
    llm_diagnosed: {
      total: llmTotal,
      correct: llmCorrect,
      accuracy_pct: llmTotal > 0 ? Number(((llmCorrect / llmTotal) * 100).toFixed(2)) : 0,
    },
  };

  // 3. False Positive Retry Cost
  // Retries attempted on insufficient_funds or expired_mandate (wasteful)
  const fpCases: FalsePositiveRetryCase[] = [];
  let fpCostPaise = 0;

  for (const item of batchResults) {
    const action = item.result.action_taken;
    const trueCause = item.payment.true_root_cause;

    if (action === "retry" && (trueCause === "insufficient_funds" || trueCause === "expired_mandate")) {
      fpCostPaise += item.payment.amount;
      fpCases.push({
        payment_id: item.payment.id,
        amount_inr: Number((item.payment.amount / 100).toFixed(2)),
        true_root_cause: trueCause,
        diagnosed_root_cause: item.result.root_cause,
        action_taken: action,
        reason:
          trueCause === "expired_mandate"
            ? "Wasteful retry: Mandate expired; retry will always fail without customer re-authorization."
            : "Wasteful retry: Customer balance insufficient; retry will fail without customer top-up.",
      });
    }
  }

  const false_positive_cost: FalsePositiveCostMetrics = {
    count: fpCases.length,
    total_amount_paise: fpCostPaise,
    total_amount_inr: Number((fpCostPaise / 100).toFixed(2)),
    cases: fpCases,
  };

  // Helper for recursive tree search
  function findInTree(nodes: typeof batchResults[0]["trace"], predicate: (n: typeof batchResults[0]["trace"][0]) => boolean): boolean {
    for (const node of nodes) {
      if (predicate(node)) return true;
      if (node.children && node.children.length > 0 && findInTree(node.children, predicate)) return true;
    }
    return false;
  }

  // 4. Escalation Rate (20B -> 120B)
  let escalatedSmartCount = 0;
  for (const item of batchResults) {
    const hasSmartNode = findInTree(
      item.trace,
      (n) => n.agent_name === "diagnosis_agent" && (n.model_used === "openai/gpt-oss-120b" || n.model_used === "llama-3.3-70b-versatile")
    );
    if (hasSmartNode) {
      escalatedSmartCount++;
    }
  }

  const escalation = {
    total_llm_cases: llmTotal,
    escalated_to_70b_count: escalatedSmartCount,
    escalation_rate_llm_pct: llmTotal > 0 ? Number(((escalatedSmartCount / llmTotal) * 100).toFixed(2)) : 0,
    escalation_rate_total_pct: Number(((escalatedSmartCount / total) * 100).toFixed(2)),
  };

  // 5. Policy Overrides
  const overrideCases: PolicyOverrideCase[] = [];
  for (const item of batchResults) {
    if (item.result.policy_overridden) {
      let llmSuggested = "retry";
      let reason = "Policy guard enforced mandatory action.";

      const extractActionNode = (nodes: typeof item.trace): void => {
        for (const n of nodes) {
          if (n.agent_name === "action_decision_agent") {
            llmSuggested = String(n.output["llm_suggested_action"] ?? "retry");
            reason = String(n.output["policy_override_reason"] ?? reason);
          }
          if (n.children && n.children.length > 0) extractActionNode(n.children);
        }
      };
      extractActionNode(item.trace);

      overrideCases.push({
        payment_id: item.payment.id,
        diagnosed_root_cause: item.result.root_cause,
        llm_suggested_action: llmSuggested,
        enforced_action: item.result.action_taken,
        reason,
      });
    }
  }

  const policy_overrides = {
    total_overrides: overrideCases.length,
    override_rate_llm_pct: llmTotal > 0 ? Number(((overrideCases.length / llmTotal) * 100).toFixed(2)) : 0,
    override_rate_total_pct: Number(((overrideCases.length / total) * 100).toFixed(2)),
    cases: overrideCases,
  };

  // 6. Unresolved Exceptions (Stop Rule Hits)
  const unresolved_exceptions: StopRuleExceptionCase[] = [];
  for (const item of batchResults) {
    if (item.result.agent_outcome === "stop_rule_hit") {
      let violations: string[] = [];
      for (const node of item.trace) {
        const findStopNode = (n: typeof node): void => {
          if (n.agent_name === "stop_rule_guard") {
            violations = (n.output["violations"] as string[]) ?? [];
          }
          n.children.forEach(findStopNode);
        };
        findStopNode(node);
      }

      if (violations.length === 0) {
        if (item.payment.attempt_number >= item.payment.max_attempts_allowed) {
          violations.push(
            `Max retry attempts reached: ${item.payment.attempt_number}/${item.payment.max_attempts_allowed}`
          );
        }
      }

      unresolved_exceptions.push({
        payment_id: item.payment.id,
        amount_inr: Number((item.payment.amount / 100).toFixed(2)),
        attempt_number: item.payment.attempt_number,
        max_attempts_allowed: item.payment.max_attempts_allowed,
        true_root_cause: item.payment.true_root_cause ?? "unknown",
        failure_reason_raw: item.payment.failure_reason_raw,
        violations,
      });
    }
  }

  return {
    total_records: total,
    financials: {
      total_volume_inr: Number((totalVolumePaise / 100).toFixed(2)),
      recovered_volume_inr: Number((recoveredVolumePaise / 100).toFixed(2)),
      notified_volume_inr: Number((notifiedVolumePaise / 100).toFixed(2)),
      unresolved_volume_inr: Number((unresolvedVolumePaise / 100).toFixed(2)),
      recovery_rate_volume_pct: Number(((recoveredVolumePaise / totalVolumePaise) * 100).toFixed(2)),
    },
    recovery_rate_pct: Number(((outcomeCounts.resolved / total) * 100).toFixed(2)),
    outcomes,
    classification_accuracy,
    false_positive_cost,
    escalation,
    policy_overrides,
    unresolved_exceptions,
  };
}
