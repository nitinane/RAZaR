// =============================================================
// promiseTracker.ts — Promise-to-Pay (P2P) Tracking Extension
// Revenue Recovery Agent | Razorpay Buildathon (Track 03)
//
// Lightweight, deterministic lifecycle tracker for customers flagged
// with 'notify_customer_pending' (e.g. mandate renewal or top-up prompt).
//
// Rules:
//   - Triggered on action: "notify_customer" -> outcome: "notify_customer_pending"
//   - Initial promise deadline defaults to current_time + 3 days
//   - Escalation logic (pure function, no LLM):
//       currentDate < promised_pay_by        → "on_track"
//       0 <= days_past <= 2                  → "overdue_gentle"
//       days_past >= 3                       → "overdue_firm"
//       promise_status == "kept"             → "resolved"
//
// Records an auditable DAG node in the decision harness.
// =============================================================

import type { HarnessLike, RecordNodeParams } from "../harness.js";
import type {
  FailedPaymentRecord,
  PromiseStatus,
  PromiseEscalationStatus,
  PromiseTrackingData,
} from "../types.js";

// ─────────────────────────────────────────────────────────────
// Pure Escalation Logic (deterministic, no LLM)
// ─────────────────────────────────────────────────────────────

/**
 * Evaluates the current promise-to-pay status against a target reference date.
 *
 * @param record      - Object containing promised_pay_by timestamp and promise_status
 * @param currentDate - Reference date to evaluate against (defaults to now)
 * @returns PromiseEscalationStatus ("on_track" | "overdue_gentle" | "overdue_firm" | "resolved")
 */
export function checkPromiseStatus(
  record: { promised_pay_by?: string | null; promise_status?: PromiseStatus | null },
  currentDate: Date | string = new Date()
): PromiseEscalationStatus {
  if (record.promise_status === "kept") {
    return "resolved";
  }
  if (!record.promised_pay_by || record.promise_status === "none") {
    return "on_track";
  }

  const nowMs = typeof currentDate === "string" ? new Date(currentDate).getTime() : currentDate.getTime();
  const deadlineMs = new Date(record.promised_pay_by).getTime();
  const diffMs = nowMs - deadlineMs;

  // Still before deadline
  if (diffMs < 0) {
    return "on_track";
  }

  // Number of 24h days elapsed past deadline
  const daysPast = diffMs / (1000 * 60 * 60 * 24);

  if (daysPast <= 2) {
    return "overdue_gentle";
  }
  return "overdue_firm";
}

// ─────────────────────────────────────────────────────────────
// Agent Function — records DAG node into Decision Harness
// ─────────────────────────────────────────────────────────────

export interface PromiseTrackerOutput {
  promise_status: PromiseStatus;
  promised_pay_by: string;
  escalation_status: PromiseEscalationStatus;
  node_id: string;
}

/**
 * Runs the Promise-to-Pay tracker for a payment placed in notify_customer_pending.
 *
 * @param harness        - Decision harness instance
 * @param run_id         - Active batch run ID
 * @param parent_node_id - Parent node (typically execution_agent node_id)
 * @param payment        - Failed payment record
 * @param daysUntilPromise - Window given to customer to pay (default 3 days)
 */
export async function runPromiseTracker(
  harness: HarnessLike,
  run_id: string,
  parent_node_id: string | null,
  payment: FailedPaymentRecord,
  daysUntilPromise = 3
): Promise<PromiseTrackerOutput> {
  const t0 = Date.now();

  // If the record already has a pre-seeded promised_pay_by date (for testing/demo), honor it;
  // otherwise default to now + daysUntilPromise.
  const promisedDate =
    payment.promised_pay_by ??
    new Date(Date.now() + daysUntilPromise * 24 * 60 * 60 * 1000).toISOString();

  const promise_status: PromiseStatus = payment.promise_status ?? "pending";
  const escalation_status = checkPromiseStatus(
    { promised_pay_by: promisedDate, promise_status },
    new Date()
  );

  const nodeParams: RecordNodeParams = {
    run_id,
    parent_node_id,
    agent_name: "promise_tracker",
    model_used: null, // deterministic, pure policy logic
    input: {
      payment_id: payment.id,
      customer_id: payment.customer_id,
      amount_paise: payment.amount,
      mandate_id: payment.mandate_id,
      failure_reason: payment.failure_reason_raw,
      initial_promise_window_days: daysUntilPromise,
    },
    output: {
      promise_status,
      promised_pay_by: promisedDate,
      escalation_status,
      action_taken: "promise_tracking_initialized",
      escalation_tier:
        escalation_status === "on_track"
          ? "Tier 0: Waiting for customer response within initial SLA"
          : escalation_status === "overdue_gentle"
          ? "Tier 1: Grace period active (0-2d overdue, gentle reminder scheduled)"
          : "Tier 2: Escalated overdue (3d+ overdue, firm collection warning)",
      notes:
        `Customer ${payment.customer_id} prompted to resolve payment. ` +
        `Tracked deadline: ${promisedDate} (${escalation_status}).`,
    },
    confidence: 1.0,
    escalated: escalation_status !== "on_track",
    latency_ms: Date.now() - t0,
    cost_estimate: 0,
    is_replay: false,
    replayed_from: null,
  };

  const node_id = await harness.recordNode(nodeParams);

  return {
    promise_status,
    promised_pay_by: promisedDate,
    escalation_status,
    node_id,
  };
}
