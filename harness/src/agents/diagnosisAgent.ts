// =============================================================
// diagnosisAgent.ts — LLM-Backed Diagnosis Agent
// Revenue Recovery Agent | Razorpay Buildathon MVP
//
// Groq dual-model routing:
//   1. openai/gpt-oss-20b   (fast, cheap, low latency)
//      └─ confidence < 0.75 → escalate to:
//   2. openai/gpt-oss-120b  (slower, smarter)
//         gets 20B output as additional context
//
// Output validated with Zod before being accepted.
// Retry-on-429: exponential backoff, max 3 retries.
// Every API call (both 20B attempt and 120B escalation) writes
// a separate harness node tagged with the correct model_used.
// =============================================================

import Groq from "groq-sdk";
import { z } from "zod";

import type { HarnessLike, RecordNodeParams } from "../harness.js";
import type {
  FailedPaymentRecord,
  DiagnosisResult,
  RootCauseCategory,
} from "../types.js";

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

export const MODEL_FAST  = "openai/gpt-oss-20b";
export const MODEL_SMART = "openai/gpt-oss-120b";

/** Confidence below this threshold from the fast model triggers smart model escalation. */
const ESCALATION_THRESHOLD = 0.75;

/** Valid root cause categories the LLM must choose from. */
const ROOT_CAUSES = [
  "bank_timeout",
  "insufficient_funds",
  "expired_mandate",
  "gateway_error",
  "unknown",
] as const;

// ─────────────────────────────────────────────────────────────
// Zod schema — strictly validates LLM JSON output
// ─────────────────────────────────────────────────────────────

const DiagnosisOutputSchema = z.object({
  root_cause: z.enum(ROOT_CAUSES),
  confidence: z.number().min(0).max(1),
  reasoning:  z.string().min(5).max(500),
});

type DiagnosisOutput = z.infer<typeof DiagnosisOutputSchema>;

// ─────────────────────────────────────────────────────────────
// Groq client (lazy singleton)
// ─────────────────────────────────────────────────────────────

let _groq: Groq | null = null;
let _warnedNoKey = false;

function getGroqClient(): Groq | null {
  if (_groq) return _groq;
  const key = process.env["GROQ_API_KEY"];
  if (!key || key.includes("your-") || key.includes("placeholder")) {
    if (!_warnedNoKey) {
      console.warn(
        "[DiagnosisAgent] ⚠  GROQ_API_KEY is not set or placeholder. Using simulated dual-model LLM responses."
      );
      _warnedNoKey = true;
    }
    return null;
  }
  _groq = new Groq({ apiKey: key });
  return _groq;
}

// ─────────────────────────────────────────────────────────────
// Simulated LLM inference (used when GROQ_API_KEY is absent)
// ─────────────────────────────────────────────────────────────

function simulateDiagnosis(
  payment: Pick<FailedPaymentRecord, "failure_reason_raw" | "failure_code">,
  model: string,
  priorFast?: DiagnosisOutput
): DiagnosisOutput {
  const raw = payment.failure_reason_raw.toLowerCase();

  if (model === MODEL_FAST) {
    if (raw.includes("standing instruction") || raw.includes("mandate")) {
      return {
        root_cause: "expired_mandate",
        confidence: 0.88,
        reasoning: "Standing instruction invalidation indicates recurring mandate expiration.",
      };
    }
    if (raw.includes("connection dropped") || raw.includes("processing delayed")) {
      return {
        root_cause: "bank_timeout",
        confidence: 0.70, // below 0.75 -> triggers smart model escalation!
        reasoning: "Ambiguous connection drop mid-auth; likely bank timeout but requires higher confidence.",
      };
    }
    if (raw.includes("declined by bank") || raw.includes("issuer")) {
      return {
        root_cause: "insufficient_funds",
        confidence: 0.68, // below 0.75 -> triggers smart model escalation!
        reasoning: "Generic bank decline often indicates insufficient balance; requires 120B confirmation.",
      };
    }
    if (raw.includes("malformed") || raw.includes("unexpected response")) {
      return {
        root_cause: "gateway_error",
        confidence: 0.82,
        reasoning: "Malformed or unexpected processor response indicates gateway error.",
      };
    }
    // Highly ambiguous / unspecified
    return {
      root_cause: "unknown",
      confidence: 0.50, // below 0.75 -> triggers smart model escalation!
      reasoning: "Failure message lacks specific error code or descriptive error context.",
    };
  }

  // MODEL_SMART: receives fast model output as context and performs deeper classification
  if (raw.includes("connection dropped") || raw.includes("processing delayed") || raw.includes("timeout")) {
    return {
      root_cause: "bank_timeout",
      confidence: 0.88,
      reasoning: "Analyzing transaction timing and connection drop confirms transient bank acquirer timeout.",
    };
  }
  if (raw.includes("declined by bank") || raw.includes("issuer") || raw.includes("balance")) {
    return {
      root_cause: "insufficient_funds",
      confidence: 0.86,
      reasoning: "Secondary heuristic analysis of issuer decline correlates strongly with account balance deficit.",
    };
  }
  if (raw.includes("malformed") || raw.includes("gateway") || raw.includes("response code")) {
    return {
      root_cause: "gateway_error",
      confidence: 0.90,
      reasoning: "Processor response signature matches known gateway integration fault.",
    };
  }
  return {
    root_cause: "unknown",
    confidence: 0.82,
    reasoning: "Unspecified failure code verified as unrecoverable unknown error; human review required.",
  };
}

// ─────────────────────────────────────────────────────────────
// Retry-on-429 with exponential backoff & explicit error classification
// ─────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;

async function groqChatWithRetry(
  groq: Groq,
  messages: Groq.Chat.ChatCompletionMessageParam[],
  model: string
): Promise<string> {
  let lastError: Error = new Error("No attempt made");

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await groq.chat.completions.create({
        model,
        messages,
        temperature: 0.1,         // low temp for deterministic structured output
        max_tokens: 1024,
        response_format: { type: "json_object" },
      });

      const content = response.choices[0]?.message?.content ?? "";
      if (!content) throw new Error("Empty response from Groq");
      return content;

    } catch (err) {
      lastError = err as Error;
      const status = (err as { status?: number }).status;
      const msg = (err as Error).message ?? "";

      // Loud, distinct error logging
      if (status === 404 || msg.includes("model_not_found") || msg.includes("does not exist")) {
        console.error(
          `\n[MODEL DEPRECATED] '${model}' is no longer served by Groq (404 model_not_found). ` +
          `Check console.groq.com/docs/deprecations\n`
        );
        throw err;
      }

      if (status === 401 || msg.includes("invalid_api_key") || msg.includes("Invalid API Key")) {
        console.error(
          `\n[AUTH FAILURE] Groq rejected API key (401 invalid_api_key). Check GROQ_API_KEY in .env\n`
        );
        throw err;
      }

      if (status === 429) {
        // Rate-limited — exponential backoff: 1s, 2s, 4s
        const waitMs = Math.pow(2, attempt) * 1000;
        console.warn(
          `[RATE LIMITED] Groq rate-limited on ${model} (attempt ${attempt + 1}/${MAX_RETRIES + 1}). ` +
          `Retrying in ${waitMs}ms…`
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      // Non-429 error — don't retry
      throw err;
    }
  }

  throw new Error(
    `[DiagnosisAgent] Groq ${model} failed after ${MAX_RETRIES + 1} attempts: ${lastError.message}`
  );
}

// ─────────────────────────────────────────────────────────────
// Parse and validate LLM output
// ─────────────────────────────────────────────────────────────

function parseAndValidate(raw: string, model: string): DiagnosisOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `[DiagnosisAgent] ${model} returned invalid JSON: ${raw.slice(0, 200)}`
    );
  }

  const result = DiagnosisOutputSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join(", ");
    throw new Error(
      `[DiagnosisAgent] ${model} output failed Zod validation: ${issues}. Raw: ${raw.slice(0, 200)}`
    );
  }

  return result.data;
}

// ─────────────────────────────────────────────────────────────
// System / user prompt builders
// ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a payment failure diagnosis system for a fintech revenue recovery pipeline.

Your task: classify the root cause of a failed payment into EXACTLY ONE of these categories:
  - bank_timeout       : Issuing bank did not respond in time; transient, retry is likely to succeed
  - insufficient_funds : Customer account has insufficient balance; retry unlikely to succeed immediately
  - expired_mandate    : UPI Autopay or standing instruction is expired; customer action required
  - gateway_error      : Payment processor / gateway internal error; retry may succeed
  - unknown            : Cannot determine root cause with confidence

You must return STRICT JSON (no markdown, no explanation outside JSON):
{
  "root_cause": "<one of the five categories above>",
  "confidence": <float 0.0 to 1.0>,
  "reasoning": "<one sentence explaining why>"
}

Rules:
- confidence reflects how certain you are, not how likely recovery is
- If the failure message is vague or could match multiple categories, use "unknown" with low confidence
- NEVER return additional fields`;

function buildUserPrompt(payment: Pick<FailedPaymentRecord, "failure_reason_raw" | "failure_code" | "method" | "amount">): string {
  return `Payment failure details:
  failure_code:        ${payment.failure_code}
  failure_reason_raw:  ${payment.failure_reason_raw}
  payment_method:      ${payment.method}
  amount_paise:        ${payment.amount}

Classify the root cause. Return only the JSON object.`;
}

function buildSmartContextPrompt(
  payment: Pick<FailedPaymentRecord, "failure_reason_raw" | "failure_code" | "method" | "amount">,
  priorResult: DiagnosisOutput
): string {
  return `${buildUserPrompt(payment)}

Additional context: A smaller model (${MODEL_FAST}) already attempted this classification and returned low confidence:
  Prior classification: ${priorResult.root_cause}
  Prior confidence:     ${priorResult.confidence.toFixed(2)}
  Prior reasoning:      ${priorResult.reasoning}

You may agree or disagree with the prior result. Use your own judgment.
Return only the JSON object.`;
}

// ─────────────────────────────────────────────────────────────
// Core LLM call (one model pass)
// ─────────────────────────────────────────────────────────────

async function callDiagnosisModel(
  groq: Groq | null,
  model: string,
  messages: Groq.Chat.ChatCompletionMessageParam[],
  payment: FailedPaymentRecord,
  priorFast?: DiagnosisOutput
): Promise<DiagnosisOutput> {
  if (!groq) {
    return simulateDiagnosis(payment, model, priorFast);
  }
  const raw = await groqChatWithRetry(groq, messages, model);
  return parseAndValidate(raw, model);
}

// ─────────────────────────────────────────────────────────────
// Public agent function
// ─────────────────────────────────────────────────────────────

/**
 * Runs the LLM Diagnosis Agent on a failed payment.
 *
 * Flow:
 *   1. Call openai/gpt-oss-20b — record harness node
 *   2. If confidence < ESCALATION_THRESHOLD → call openai/gpt-oss-120b
 *      with 20B output as context — record a second harness node (escalated=true)
 *   3. Return the final (highest-confidence) result
 *
 * @param harness        - HarnessLike instance
 * @param run_id         - UUID of the pipeline run
 * @param parent_node_id - Parent node (pre_classifier node_id)
 * @param payment        - Failed payment record (agent-visible fields only)
 */
export async function runDiagnosisAgent(
  harness: HarnessLike,
  run_id: string,
  parent_node_id: string | null,
  payment: FailedPaymentRecord
): Promise<DiagnosisResult> {
  const groq = getGroqClient();

  // Agent-visible input (NO ground-truth fields)
  const agentInput = {
    payment_id:          payment.id,
    failure_code:        payment.failure_code,
    failure_reason_raw:  payment.failure_reason_raw,
    method:              payment.method,
    amount_paise:        payment.amount,
  };

  // ── Step 1: Fast model (openai/gpt-oss-20b) ─────────────────
  const t0 = Date.now();

  const messagesFast: Groq.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user",   content: buildUserPrompt(payment) },
  ];

  let resultFast: DiagnosisOutput;
  let errorFast: string | null = null;

  try {
    resultFast = await callDiagnosisModel(groq, MODEL_FAST, messagesFast, payment);
  } catch (err) {
    // If call fails entirely, use a safe fallback and still record the attempt
    errorFast = (err as Error).message;
    resultFast = { root_cause: "unknown", confidence: 0.0, reasoning: `${MODEL_FAST} call failed: ${errorFast}` };
  }

  const latencyFast = Date.now() - t0;
  const needsEscalation = resultFast.confidence < ESCALATION_THRESHOLD || errorFast !== null;

  const nodeFastParams: RecordNodeParams = {
    run_id,
    parent_node_id,
    agent_name: "diagnosis_agent",
    model_used: MODEL_FAST,
    input:  agentInput,
    output: {
      root_cause:  resultFast.root_cause,
      confidence:  resultFast.confidence,
      reasoning:   resultFast.reasoning,
      needs_smart_escalation: needsEscalation,
      error: errorFast ?? null,
    },
    confidence:    resultFast.confidence > 0 ? resultFast.confidence : null,
    escalated:     needsEscalation,   // true = escalating to smart model
    latency_ms:    latencyFast,
    cost_estimate: estimateCost(MODEL_FAST, latencyFast),
    is_replay:     false,
    replayed_from: null,
  };

  const nodeFastId = await harness.recordNode(nodeFastParams);

  // ── Step 2: Smart model escalation (openai/gpt-oss-120b) ────
  if (!needsEscalation) {
    return {
      root_cause:       resultFast.root_cause,
      confidence:       resultFast.confidence,
      reasoning:        resultFast.reasoning,
      model_used:       MODEL_FAST,
      escalated_to_70b: false,
      node_id:          nodeFastId,
    };
  }

  // Build 120B messages — includes 20B context so it's not starting blind
  const t1 = Date.now();

  const messagesSmart: Groq.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user",   content: buildSmartContextPrompt(payment, resultFast) },
  ];

  let resultSmart: DiagnosisOutput;
  let errorSmart: string | null = null;

  try {
    resultSmart = await callDiagnosisModel(groq, MODEL_SMART, messagesSmart, payment, resultFast);
  } catch (err) {
    errorSmart = (err as Error).message;
    // Fall back to fast result if smart model also fails
    resultSmart = resultFast;
    console.warn(`[DiagnosisAgent] ${MODEL_SMART} escalation failed: ${errorSmart}. Using ${MODEL_FAST} result.`);
  }

  const latencySmart = Date.now() - t1;

  const nodeSmartParams: RecordNodeParams = {
    run_id,
    parent_node_id: nodeFastId,  // smart model is child of fast model in the trace DAG
    agent_name: "diagnosis_agent",
    model_used: MODEL_SMART,
    input: {
      ...agentInput,
      prior_fast_root_cause:  resultFast.root_cause,
      prior_fast_confidence:  resultFast.confidence,
      prior_fast_reasoning:   resultFast.reasoning,
    },
    output: {
      root_cause:  resultSmart.root_cause,
      confidence:  resultSmart.confidence,
      reasoning:   resultSmart.reasoning,
      escalation_reason: `${MODEL_FAST} confidence (${resultFast.confidence.toFixed(2)}) < threshold (${ESCALATION_THRESHOLD})`,
      error: errorSmart ?? null,
    },
    confidence:    resultSmart.confidence > 0 ? resultSmart.confidence : null,
    escalated:     false,   // final hop
    latency_ms:    latencySmart,
    cost_estimate: estimateCost(MODEL_SMART, latencySmart),
    is_replay:     false,
    replayed_from: null,
  };

  const nodeSmartId = await harness.recordNode(nodeSmartParams);

  return {
    root_cause:          resultSmart.root_cause,
    confidence:          resultSmart.confidence,
    reasoning:           resultSmart.reasoning,
    model_used:          MODEL_SMART,
    escalated_to_70b:    true,
    node_id:             nodeFastId,
    escalation_node_id:  nodeSmartId,
  };
}

// ─────────────────────────────────────────────────────────────
// Cost estimate helper (rough token-based approximation)
// ─────────────────────────────────────────────────────────────

function estimateCost(model: string, latency_ms: number): number {
  const inputTokens  = 200;
  const outputTokens = 80;

  if (model === MODEL_FAST) {
    return (inputTokens * 0.05 + outputTokens * 0.08) / 1_000_000;
  }
  if (model === MODEL_SMART) {
    return (inputTokens * 0.59 + outputTokens * 0.79) / 1_000_000;
  }

  void latency_ms;
  return 0;
}
