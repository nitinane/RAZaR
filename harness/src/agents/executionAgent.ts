// =============================================================
// executionAgent.ts — Execution Agent
// Revenue Recovery Agent | Razorpay Buildathon MVP
//
// Supports three actions:
//   "retry"           → Creates a Razorpay order (test mode), then
//                       simulates a checkout outcome (no real browser).
//   "notify_customer" → Logs a notification event (mandate renewal,
//                       balance top-up prompt). No Razorpay API call.
//   "escalate_human"  → Marks for human review; no API call.
//
// Razorpay reality: there is no "retry payment" endpoint. A retry
// in Razorpay means creating a NEW order for the same amount and
// then completing the checkout. In test mode, we create the order
// via the Orders API and simulate the checkout outcome:
//   - If RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are set → real API call
//   - Otherwise → fully mocked order_id + simulated outcome
//
// Every call records a harness node regardless of action/outcome.
// =============================================================

import type { HarnessLike, RecordNodeParams } from "../harness.js";
import type {
  FailedPaymentRecord,
  ExecutionResult,
  ExecutionConfig,
  RecoveryAction,
} from "../types.js";

// ─────────────────────────────────────────────────────────────
// Razorpay client factory (lazy — only initialised when needed)
// ─────────────────────────────────────────────────────────────

let _razorpayClient: { orders: { create: (o: RazorpayOrderParams) => Promise<RazorpayOrder> } } | null = null;

interface RazorpayOrderParams {
  amount: number;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
}

interface RazorpayOrder {
  id: string;
  status: string;
  amount: number;
  currency: string;
  receipt: string;
}

async function getRazorpayClient(): Promise<typeof _razorpayClient> {
  if (_razorpayClient) return _razorpayClient;

  const keyId     = process.env["RAZORPAY_KEY_ID"];
  const keySecret = process.env["RAZORPAY_KEY_SECRET"];

  if (!keyId || !keySecret) {
    // No credentials — run in mock mode
    return null;
  }

  try {
    const { default: Razorpay } = await import("razorpay");
    _razorpayClient = new (Razorpay as unknown as new (options: { key_id: string; key_secret: string }) => { orders: { create: (o: RazorpayOrderParams) => Promise<RazorpayOrder> } })({ key_id: keyId, key_secret: keySecret });
    return _razorpayClient;
  } catch (err) {
    console.warn("[ExecutionAgent] Failed to load Razorpay SDK:", (err as Error).message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Retry via Razorpay Orders API
// ─────────────────────────────────────────────────────────────

async function createRazorpayOrder(payment: FailedPaymentRecord): Promise<{
  order_id: string;
  mocked: boolean;
}> {
  const client = await getRazorpayClient();

  if (!client) {
    // Mock order — no real API call
    const mockId = `order_MOCK_${payment.id}_${Date.now()}`;
    return { order_id: mockId, mocked: true };
  }

  try {
    const order = await (client.orders as { create: (o: RazorpayOrderParams) => Promise<RazorpayOrder> }).create({
      amount: payment.amount,
      currency: payment.currency,
      receipt: `recovery_${payment.id.replace(/[^a-zA-Z0-9]/g, "_")}`,
      notes: {
        original_payment_id: payment.id,
        customer_id: payment.customer_id,
        recovery_attempt: String(payment.attempt_number + 1),
        mandate_id: payment.mandate_id ?? "none",
      },
    });

    return { order_id: order.id, mocked: false };
  } catch (err) {
    // If the real API call fails, fall back to a mock so the test doesn't crash
    console.warn(`[ExecutionAgent] Razorpay API call failed, using mock: ${(err as Error).message}`);
    const mockId = `order_FALLBACK_${payment.id}_${Date.now()}`;
    return { order_id: mockId, mocked: true };
  }
}

// ─────────────────────────────────────────────────────────────
// Simulate checkout outcome
//
// In production this would be a webhook from Razorpay signalling
// payment.captured or payment.failed. In test mode (no real
// browser), we simulate:
//   - If forceOutcome is set → deterministic
//   - Else → random, biased toward success (70%)
// ─────────────────────────────────────────────────────────────

function simulateCheckoutOutcome(config: ExecutionConfig): "success" | "failure" {
  if (config.forceOutcome) return config.forceOutcome;
  const successRate = config.successRate ?? 0.70;
  return Math.random() < successRate ? "success" : "failure";
}

// ─────────────────────────────────────────────────────────────
// Core execution logic (pure except for the Razorpay call)
// ─────────────────────────────────────────────────────────────

async function execute(
  action: RecoveryAction,
  payment: FailedPaymentRecord,
  config: ExecutionConfig
): Promise<ExecutionResult> {
  const t0 = Date.now();

  if (action === "escalate_human") {
    return {
      action,
      outcome: "escalated",
      notes: `Payment ${payment.id} flagged for human review. No automated action taken.`,
      latency_ms: Date.now() - t0,
    };
  }

  if (action === "notify_customer") {
    // No Razorpay API call — in production this would send a push notification,
    // WhatsApp message, or email with a mandate-renewal / top-up link.
    return {
      action,
      outcome: "escalated",  // same harness bucket — no payment was processed
      notes: `[NOTIFY] Customer ${payment.customer_id} flagged for outbound notification. ` +
             `Reason: root cause requires customer action before retry is viable. ` +
             `Notification channel: production webhook (mocked in test).`,
      latency_ms: Date.now() - t0,
    };
  }

  // action === "retry"
  const { order_id, mocked } = await createRazorpayOrder(payment);
  const checkoutOutcome = simulateCheckoutOutcome(config);
  const latency_ms = Date.now() - t0;

  const outcomeLabel: ExecutionResult["outcome"] = mocked
    ? checkoutOutcome === "success"
      ? "simulated_success"
      : "simulated_failure"
    : checkoutOutcome === "success"
    ? "success"
    : "failure";

  return {
    action: "retry",
    outcome: outcomeLabel,
    razorpay_order_id: order_id,
    notes: mocked
      ? `[MOCK] New order created: ${order_id}. Simulated checkout outcome: ${checkoutOutcome}. ` +
        `Set RAZORPAY_KEY_ID/KEY_SECRET to use the real Orders API.`
      : `New Razorpay order created: ${order_id}. ` +
        `Checkout outcome: ${checkoutOutcome}. ` +
        `In production, this outcome would arrive via Razorpay webhook.`,
    latency_ms,
  };
}

// ─────────────────────────────────────────────────────────────
// Public agent function
// ─────────────────────────────────────────────────────────────

export interface ExecutionAgentOutput {
  result: ExecutionResult;
  node_id: string;
}

/**
 * Executes the decided recovery action for a failed payment.
 *
 * @param harness        - Harness instance to record the node into
 * @param run_id         - UUID of the current pipeline run
 * @param parent_node_id - Parent harness node (stop_rule_guard's or pre_classifier's node_id)
 * @param payment        - The failed payment record to act on
 * @param action         - "retry" | "escalate_human"
 * @param config         - Optional execution config (forceOutcome, successRate)
 *
 * @returns Execution result + the written harness node_id
 */
export async function runExecutionAgent(
  harness: HarnessLike,
  run_id: string,
  parent_node_id: string | null,
  payment: FailedPaymentRecord,
  action: RecoveryAction,
  config: ExecutionConfig = {}
): Promise<ExecutionAgentOutput> {
  // Execute — async because of the Razorpay API call
  const result = await execute(action, payment, config);

  // Determine harness fields from outcome
  const wasSuccessful = result.outcome === "success" || result.outcome === "simulated_success";
  const wasEscalated = result.outcome === "escalated";

  const nodeParams: RecordNodeParams = {
    run_id,
    parent_node_id,
    agent_name: "execution_agent",
    model_used: null,
    input: {
      payment_id: payment.id,
      action_requested: action,
      amount_paise: payment.amount,
      customer_id: payment.customer_id,
      mandate_id: payment.mandate_id ?? null,
      method: payment.method,
      attempt_number: payment.attempt_number,
    },
    output: {
      action_taken: result.action,
      outcome: result.outcome,
      razorpay_order_id: result.razorpay_order_id ?? null,
      notes: result.notes,
    },
    confidence: wasEscalated ? null : wasSuccessful ? 1.0 : 0.0,
    escalated: wasEscalated,
    latency_ms: result.latency_ms,
    // Deterministic path: only LLM retries carry a cost
    // Razorpay API calls themselves are free (we're not paying per call)
    cost_estimate: 0,
    is_replay: false,
    replayed_from: null,
  };

  const node_id = await harness.recordNode(nodeParams);

  return { result, node_id };
}
