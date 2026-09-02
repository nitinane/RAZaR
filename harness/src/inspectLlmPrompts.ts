// =============================================================
// inspectLlmPrompts.ts — Visual Inspection of Prompts & LLM I/O
// Revenue Recovery Agent | Verification Script
// =============================================================

import "dotenv/config";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import Groq from "groq-sdk";
import type { FailedPaymentRecord } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const rootDir = join(dirname(__filename), "..");
const dataPath = join(rootDir, "data", "failed_payments.json");
const records: FailedPaymentRecord[] = JSON.parse(readFileSync(dataPath, "utf-8"));

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

function buildUserPrompt(payment: FailedPaymentRecord): string {
  return `Payment failure details:
  failure_code:        ${payment.failure_code}
  failure_reason_raw:  ${payment.failure_reason_raw}
  payment_method:      ${payment.method}
  amount_paise:        ${payment.amount}

Classify the root cause. Return only the JSON object.`;
}

function build70BPrompt(payment: FailedPaymentRecord, prior8B: { root_cause: string; confidence: number; reasoning: string }): string {
  return `${buildUserPrompt(payment)}

Additional context: A smaller model already attempted this classification and returned low confidence:
  Prior classification: ${prior8B.root_cause}
  Prior confidence:     ${prior8B.confidence.toFixed(2)}
  Prior reasoning:      ${prior8B.reasoning}

You may agree or disagree with the prior result. Use your own judgment.
Return only the JSON object.`;
}

async function main() {
  console.log("================================================================================");
  console.log("1. EXACT MESSAGES PAYLOAD SENT TO GROQ (for pay_0003)");
  console.log("================================================================================");

  const pay0003 = records.find((r) => r.id === "pay_0003")!;

  const messages8B_pay0003 = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user",   content: buildUserPrompt(pay0003) },
  ];

  console.log("INPUT RECORD (from DB/JSON):");
  console.log(JSON.stringify(pay0003, null, 2));
  console.log("\nEXACT MESSAGES OBJECT SENT TO GROQ 8B (Notice: NO true_root_cause field):");
  console.log(JSON.stringify(messages8B_pay0003, null, 2));

  console.log("\n================================================================================");
  console.log("2. 70B ESCALATION CONTEXT PAYLOAD (Example for pay_0011)");
  console.log("================================================================================");

  const pay0011 = records.find((r) => r.id === "pay_0011")!;
  const simulatedPrior8B = {
    root_cause: "unknown",
    confidence: 0.50,
    reasoning: "Failure message lacks specific error code or descriptive error context.",
  };

  const messages70B_pay0011 = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user",   content: build70BPrompt(pay0011, simulatedPrior8B) },
  ];

  console.log(JSON.stringify(messages70B_pay0011, null, 2));

  console.log("\n================================================================================");
  console.log("3. SAMPLE LLM REASONING & RAW OUTPUTS FOR 3 CASES");
  console.log("================================================================================");

  const testCases = ["pay_0003", "pay_0011", "pay_0007"];

  for (const id of testCases) {
    const p = records.find((r) => r.id === id)!;
    console.log(`\n--- Case: ${p.id} ---`);
    console.log(`Payment Method  : ${p.method}`);
    console.log(`Failure Code    : ${p.failure_code}`);
    console.log(`Failure Reason  : "${p.failure_reason_raw}"`);
    console.log(`Ground Truth    : ${p.true_root_cause} (hidden from model at inference)`);
    
    // Check if live Groq is callable
    const key = process.env["GROQ_API_KEY"];
    if (key && !key.includes("your-") && !key.includes("placeholder")) {
      try {
        const groq = new Groq({ apiKey: key });
        const res = await groq.chat.completions.create({
          model: "openai/gpt-oss-20b",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user",   content: buildUserPrompt(p) },
          ],
          temperature: 0.1,
          response_format: { type: "json_object" },
        });
        console.log("Raw Groq 8B Output:");
        console.log(res.choices[0]?.message?.content);
      } catch (err) {
        console.log(`Groq API returned error: ${(err as Error).message}`);
      }
    } else {
      console.log("Note: Running in offline simulation mode (GROQ_API_KEY is currently a placeholder).");
    }
  }
}

main().catch(console.error);
