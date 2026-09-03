// =============================================================
// preClassifier.ts — Deterministic Pre-Classifier Agent
// Revenue Recovery Agent | Razorpay Buildathon MVP
//
// Pure function. No LLM calls. No hidden state.
// Matches failure_code and failure_reason_raw against a fixed
// set of regex / exact-match patterns and returns a confidence
// score. If confidence < CONFIDENT_THRESHOLD, returns
// confident:false so the pipeline escalates to the Diagnosis
// Agent (LLM) — not built yet.
//
// Every call records a harness node regardless of outcome.
// =============================================================

import type { HarnessLike, RecordNodeParams } from "../harness.js";
import type {
  FailedPaymentRecord,
  ClassificationResult,
  RootCauseCategory,
} from "../types.js";

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

/**
 * Minimum confidence required for the pre-classifier to be
 * "confident" and skip the LLM Diagnosis Agent.
 *
 * Patterns that score below this threshold intentionally return
 * confident:false so the LLM agent gets a turn.
 */
const CONFIDENT_THRESHOLD = 0.80;

// ─────────────────────────────────────────────────────────────
// Pattern definitions
// Each pattern is tried in order; first match wins.
// Confidence reflects how unambiguous the signal is:
//   0.90–0.95 → strong structural signal (exact code or explicit phrase)
//   0.70–0.79 → weaker signal (vague phrasing — below confident threshold)
// ─────────────────────────────────────────────────────────────

interface Pattern {
  category: RootCauseCategory;
  description: string;     // shown in matched_pattern field
  confidence: number;
  /** Test failure_code (exact string match, case-insensitive) */
  codeExact?: string;
  /** Test failure_reason_raw (regex, case-insensitive) */
  rawPattern?: RegExp;
}

const PATTERNS: Pattern[] = [
  // ── Specific Ambiguous Patterns (MUST be evaluated before generic code matches) ──
  {
    // Ambiguous: "connection dropped" could be gateway or bank
    category: "bank_timeout",
    description: "raw message contains ambiguous mid-auth drop (possible gateway)",
    confidence: 0.72,
    rawPattern: /connection dropped mid.?authorization|payment processing delayed/i,
  },
  {
    // "Transaction declined by bank" — too vague; could be anything
    category: "insufficient_funds",
    description: "raw message generically says 'declined by bank' (ambiguous)",
    confidence: 0.65,
    rawPattern: /^transaction declined by bank$/i,
  },
  {
    // "Standing instruction invalid" — could be mandate issue or account issue
    category: "expired_mandate",
    description: "raw message says 'standing instruction invalid' (ambiguous)",
    confidence: 0.76,
    rawPattern: /standing instruction invalid/i,
  },
  {
    category: "unknown",
    description: "failure_code is UNKNOWN — insufficient signal for classification",
    confidence: 0.0,
    codeExact: "UNKNOWN",
  },
  {
    category: "unknown",
    description: "raw message is completely unhelpful / unspecified",
    confidence: 0.0,
    rawPattern: /^payment failed$|^transaction could not be completed$|^error code unspecified/i,
  },

  // ── High-Confidence Unambiguous Patterns ─────────────────────────
  // ── Bank Timeout ──
  {
    category: "bank_timeout",
    description: "raw message contains unambiguous bank-timeout phrasing",
    confidence: 0.90,
    rawPattern: /BANK_TIMEOUT|no response from acquirer|timed out at bank|timeout window/i,
  },
  {
    category: "bank_timeout",
    description: "failure_code is BANK_TIMEOUT",
    confidence: 0.95,
    codeExact: "BANK_TIMEOUT",
  },

  // ── Insufficient Funds ──
  {
    category: "insufficient_funds",
    description: "raw message explicitly states insufficient balance/funds",
    confidence: 0.92,
    rawPattern: /INSUFFICIENT_FUNDS|insufficient balance|declined by issuer/i,
  },
  {
    category: "insufficient_funds",
    description: "failure_code is INSUFFICIENT_FUNDS",
    confidence: 0.95,
    codeExact: "INSUFFICIENT_FUNDS",
  },

  // ── Expired Mandate ──
  {
    category: "expired_mandate",
    description: "raw message explicitly states mandate expired or invalid",
    confidence: 0.92,
    rawPattern: /MANDATE_EXPIRED|mandate has expired|recurring.*no longer valid/i,
  },
  {
    category: "expired_mandate",
    description: "failure_code is EXPIRED_MANDATE",
    confidence: 0.95,
    codeExact: "EXPIRED_MANDATE",
  },

  // ── Gateway Error ──
  {
    category: "gateway_error",
    description: "raw message contains explicit gateway error code or exception",
    confidence: 0.92,
    rawPattern: /GATEWAY_ERROR|response code 5\d\d|gateway exception/i,
  },
  {
    category: "gateway_error",
    description: "failure_code is GATEWAY_ERROR",
    confidence: 0.95,
    codeExact: "GATEWAY_ERROR",
  },
  {
    // "malformed response" — likely gateway
    category: "gateway_error",
    description: "raw message indicates malformed/unexpected gateway response",
    confidence: 0.82,
    rawPattern: /malformed response|unexpected response/i,
  },
];

// ─────────────────────────────────────────────────────────────
// Core classification logic (pure, no harness dependency)
// ─────────────────────────────────────────────────────────────

function classify(payment: Pick<FailedPaymentRecord, "failure_code" | "failure_reason_raw">): ClassificationResult {
  const failure_code = payment.failure_code ?? "";
  const failure_reason_raw = payment.failure_reason_raw ?? "";

  // Try each pattern in priority order — first match wins
  for (const pattern of PATTERNS) {
    const codeMatches =
      pattern.codeExact !== undefined &&
      failure_code.toUpperCase() === pattern.codeExact.toUpperCase();

    const rawMatches =
      pattern.rawPattern !== undefined &&
      pattern.rawPattern.test(failure_reason_raw);

    if (codeMatches || rawMatches) {
      const confident = pattern.confidence >= CONFIDENT_THRESHOLD;
      return {
        confident,
        root_cause: confident ? pattern.category : undefined,
        confidence: pattern.confidence,
        matched_pattern: pattern.description,
        reasoning: confident
          ? `Pattern matched with high confidence (${pattern.confidence.toFixed(2)}): ${pattern.description}. ` +
            `Root cause classified as '${pattern.category}'. Proceeding without LLM.`
          : `Pattern matched but confidence is too low (${pattern.confidence.toFixed(2)} < ${CONFIDENT_THRESHOLD}): ` +
            `${pattern.description}. Escalating to Diagnosis Agent.`,
      };
    }
  }

  // No pattern matched at all
  return {
    confident: false,
    confidence: 0.0,
    matched_pattern: "no pattern matched",
    reasoning:
      `failure_code='${failure_code}' and failure_reason_raw did not match any known pattern. ` +
      "Escalating to Diagnosis Agent.",
  };
}

// ─────────────────────────────────────────────────────────────
// Public agent function — records harness node on every call
// ─────────────────────────────────────────────────────────────

export interface PreClassifierOutput {
  result: ClassificationResult;
  /** Harness node_id written for this call. */
  node_id: string;
}

/**
 * Runs the deterministic pre-classifier on a failed payment.
 *
 * @param harness        - Harness instance to record the node into
 * @param run_id         - UUID of the current pipeline run
 * @param parent_node_id - Parent harness node (null = root of run)
 * @param payment        - The failed payment record to classify
 *
 * @returns Classification result + the written harness node_id
 */
export async function runPreClassifier(
  harness: HarnessLike,
  run_id: string,
  parent_node_id: string | null,
  payment: FailedPaymentRecord
): Promise<PreClassifierOutput> {
  const t0 = Date.now();

  // Classify — pure, no side effects
  const result = classify(payment);

  const latency_ms = Date.now() - t0;

  // Build harness node params — input is ONLY what the agent sees
  // (no true_root_cause, no ambiguity — those are eval-only)
  const nodeParams: RecordNodeParams = {
    run_id,
    parent_node_id,
    agent_name: "pre_classifier",
    model_used: null,  // deterministic — no LLM
    input: {
      payment_id: payment.id,
      failure_code: payment.failure_code,
      failure_reason_raw: payment.failure_reason_raw,
      amount_paise: payment.amount,
      method: payment.method,
    },
    output: {
      confident: result.confident,
      root_cause: result.root_cause ?? null,
      confidence: result.confidence,
      matched_pattern: result.matched_pattern,
      reasoning: result.reasoning,
    },
    confidence: result.confident ? result.confidence : null,
    escalated: !result.confident,   // true when we need LLM escalation
    latency_ms,
    cost_estimate: 0,  // deterministic — no token cost
    is_replay: false,
    replayed_from: null,
  };

  const node_id = await harness.recordNode(nodeParams);

  return { result, node_id };
}
