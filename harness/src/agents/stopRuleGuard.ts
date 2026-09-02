// =============================================================
// stopRuleGuard.ts — Deterministic Stop-Rule Guard Agent
// Revenue Recovery Agent | Razorpay Buildathon MVP
//
// Pure function. Enforces policy limits before any action is
// taken. If any rule fires, the pipeline MUST NOT proceed with
// a retry — it escalates to human review instead.
//
// Rules enforced:
//   1. Attempt limit: attempt_number >= max_attempts_allowed
//   2. Spend cap: amount > maxSpendCapPaise (default INR 50,000)
//
// Every call records a harness node regardless of outcome.
// =============================================================

import type { HarnessLike, RecordNodeParams } from "../harness.js";
import type {
  FailedPaymentRecord,
  StopRuleResult,
  StopRuleConfig,
} from "../types.js";

// ─────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────

const DEFAULT_SPEND_CAP_PAISE = 5_000_000; // INR 50,000

// ─────────────────────────────────────────────────────────────
// Core guard logic (pure, no harness dependency)
// ─────────────────────────────────────────────────────────────

function checkStopRules(
  payment: FailedPaymentRecord,
  config: Required<StopRuleConfig>
): StopRuleResult {
  const violations: string[] = [];

  // Rule 1: Attempt limit
  // Note: we check >= because attempt_number represents the number of
  // attempts ALREADY made, so we must not add another one if we're at
  // or beyond the maximum.
  if (payment.attempt_number >= payment.max_attempts_allowed) {
    violations.push(
      `Attempt limit reached: attempt_number (${payment.attempt_number}) ` +
        `>= max_attempts_allowed (${payment.max_attempts_allowed}). ` +
        `No further automated retries permitted.`
    );
  }

  // Rule 2: Spend cap
  // A high-value payment needs human eyes before we retry, to avoid
  // triggering fraud detection or wasting retries on large amounts.
  if (payment.amount > config.maxSpendCapPaise) {
    const amountINR = (payment.amount / 100).toFixed(2);
    const capINR = (config.maxSpendCapPaise / 100).toFixed(2);
    violations.push(
      `Amount ₹${amountINR} exceeds automated spend cap ₹${capINR}. ` +
        `Manual approval required before retry.`
    );
  }

  // Future rules can be added here without changing the harness shape:
  // Rule 3: Time-based (e.g., don't retry after 7 days)
  // Rule 4: Customer-level retry quota (needs cross-payment lookup — not implemented)

  if (violations.length > 0) {
    return {
      allowed: false,
      reason: `Stop rule(s) triggered: ${violations.length} violation(s) found. Escalating to human review.`,
      violations,
    };
  }

  return {
    allowed: true,
    reason: "All policy checks passed. Pipeline may proceed with automated retry.",
    violations: [],
  };
}

// ─────────────────────────────────────────────────────────────
// Public agent function
// ─────────────────────────────────────────────────────────────

export interface StopRuleGuardOutput {
  result: StopRuleResult;
  node_id: string;
}

/**
 * Runs all stop-rule policy checks for a failed payment.
 *
 * @param harness        - Harness instance to record the node into
 * @param run_id         - UUID of the current pipeline run
 * @param parent_node_id - Parent harness node (pre_classifier's node_id)
 * @param payment        - The failed payment record to check
 * @param config         - Optional policy overrides
 *
 * @returns Stop-rule result + the written harness node_id
 */
export async function runStopRuleGuard(
  harness: HarnessLike,
  run_id: string,
  parent_node_id: string | null,
  payment: FailedPaymentRecord,
  config: StopRuleConfig = {}
): Promise<StopRuleGuardOutput> {
  const t0 = Date.now();

  const resolvedConfig: Required<StopRuleConfig> = {
    maxSpendCapPaise: config.maxSpendCapPaise ?? DEFAULT_SPEND_CAP_PAISE,
  };

  // Enforce rules — pure, no side effects
  const result = checkStopRules(payment, resolvedConfig);

  const latency_ms = Date.now() - t0;

  const nodeParams: RecordNodeParams = {
    run_id,
    parent_node_id,
    agent_name: "stop_rule_guard",
    model_used: null,
    input: {
      payment_id: payment.id,
      attempt_number: payment.attempt_number,
      max_attempts_allowed: payment.max_attempts_allowed,
      amount_paise: payment.amount,
      max_spend_cap_paise: resolvedConfig.maxSpendCapPaise,
    },
    output: {
      allowed: result.allowed,
      reason: result.reason,
      violations: result.violations,
      violations_count: result.violations.length,
    },
    confidence: result.allowed ? 1.0 : 0.0,  // deterministic — always 100% certain
    escalated: !result.allowed,
    latency_ms,
    cost_estimate: 0,
    is_replay: false,
    replayed_from: null,
  };

  const node_id = await harness.recordNode(nodeParams);

  return { result, node_id };
}
