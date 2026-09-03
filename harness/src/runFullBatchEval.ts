// =============================================================
// runFullBatchEval.ts — Full Batch Benchmark Evaluation Runner
// Revenue Recovery Agent | Razorpay Buildathon MVP (PRD Section 7)
//
// Evaluates the full 63-record dataset:
//   1. Runs the complete pipeline across all 63 records
//   2. Computes ground-truth benchmark metrics
//   3. Outputs a comprehensive, transparent terminal report
//   4. Writes `batch_eval_results.json` for Dashboard consumption
//
// Usage:
//   npm run eval:batch
// =============================================================

import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

import { runBatch } from "./batchRunner.js";
import { computeMetrics } from "./metrics.js";
import { createDbClient } from "./pipeline.js";
import { tryCreateHarness } from "./harness.js";
import type { FailedPaymentRecord } from "./types.js";

// ─────────────────────────────────────────────────────────────
// Pretty-Print Formatting Helpers
// ─────────────────────────────────────────────────────────────

const COLORS = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  cyan:    "\x1b[36m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  magenta: "\x1b[35m",
  red:     "\x1b[31m",
  blue:    "\x1b[34m",
  white:   "\x1b[37m",
};

function c(color: keyof typeof COLORS, text: string): string {
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

function hr(char = "─", len = 72): string {
  return char.repeat(len);
}

function header(title: string): void {
  console.log(`\n${c("bold", hr("═"))}`);
  console.log(c("bold", `  ${title}`));
  console.log(c("bold", hr("═")));
}

function section(title: string): void {
  console.log(`\n${c("bold", hr("─"))}`);
  console.log(c("bold", `  ${title}`));
  console.log(c("bold", hr("─")));
}

// ─────────────────────────────────────────────────────────────
// Main Benchmark Runner
// ─────────────────────────────────────────────────────────────

async function main() {
  console.log(c("bold", "\n╔══════════════════════════════════════════════════════════════════════════╗"));
  console.log(c("bold",   "║   REVENUE RECOVERY AGENT — BATCH BENCHMARK EVALUATION (PRD SEC 7)        ║"));
  console.log(c("bold",   "║   Auditable Multi-Agent Pipeline Benchmark on 63-Record Synthetic Batch  ║"));
  console.log(c("bold",   "╚══════════════════════════════════════════════════════════════════════════╝\n"));

  // 1. Resolve dataset
  const __filename = fileURLToPath(import.meta.url);
  const rootDir = join(dirname(__filename), "..");
  const dataPath = join(rootDir, "data", "failed_payments.json");
  const outputPath = join(rootDir, "batch_eval_results.json");

  let records: FailedPaymentRecord[] = [];

  const realDb = createDbClient();
  let dbLoaded = false;

  if (realDb) {
    try {
      const { data, error } = await realDb
        .from("failed_payments")
        .select("*")
        .order("id", { ascending: true });

      if (!error && data && data.length >= 50) {
        records = data as FailedPaymentRecord[];
        dbLoaded = true;
        console.log(c("green", `✔  Loaded ${records.length} records directly from Supabase failed_payments table.`));
      }
    } catch {
      dbLoaded = false;
    }
  }

  if (!dbLoaded) {
    console.log(c("yellow", `ℹ  Reading canonical 63-record dataset from data/failed_payments.json.`));
    records = JSON.parse(readFileSync(dataPath, "utf-8")) as FailedPaymentRecord[];
  }

  console.log(`\nStarting sequential evaluation across ${c("bold", String(records.length))} payments…`);

  // Progress ticker
  let lastPct = -1;
  const batchOutput = await runBatch(records, {
    onProgress: (idx, total, payment, result) => {
      const pct = Math.floor((idx / total) * 100);
      if (pct % 20 === 0 && pct !== lastPct) {
        process.stdout.write(`  [${pct}%] Processed ${idx}/${total} (${payment.id} -> ${result.agent_outcome})\n`);
        lastPct = pct;
      }
    },
  });

  console.log(c("green", `\n✔  Batch run completed in ${(batchOutput.total_duration_ms / 1000).toFixed(2)}s.`));

  // 2. Compute Benchmark Metrics
  const metrics = computeMetrics(batchOutput.results);

  // 3. Print Comprehensive Report
  header("1. FINANCIAL & VOLUME RECOVERY IMPACT");
  console.log(`  Total Invoiced Volume Processed : ${c("bold", `₹${metrics.financials.total_volume_inr.toLocaleString("en-IN")}`)}`);
  console.log(`  Directly Recovered Volume       : ${c("green", c("bold", `₹${metrics.financials.recovered_volume_inr.toLocaleString("en-IN")}`))} (${metrics.financials.recovery_rate_volume_pct}% of total)`);
  console.log(`  Notified Customer (In-Flight)   : ${c("blue", `₹${metrics.financials.notified_volume_inr.toLocaleString("en-IN")}`)}`);
  console.log(`  Unresolved / Escalated Volume   : ${c("yellow", `₹${metrics.financials.unresolved_volume_inr.toLocaleString("en-IN")}`)}`);

  header("2. OUTCOME BREAKDOWN (4 DISTINCT BUCKETS)");
  console.log(`  ${c("green",  "• Resolved (Automated Retry Succeeded)   :")} ${String(metrics.outcomes.resolved.count).padStart(3)} (${metrics.outcomes.resolved.pct.toFixed(1)}%)`);
  console.log(`  ${c("blue",   "• Notify Customer Pending (Mandate/Top-up):")} ${String(metrics.outcomes.notify_customer_pending.count).padStart(3)} (${metrics.outcomes.notify_customer_pending.pct.toFixed(1)}%)`);
  console.log(`  ${c("yellow", "• Escalated to Human (Manual Review)      :")} ${String(metrics.outcomes.escalated_to_human.count).padStart(3)} (${metrics.outcomes.escalated_to_human.pct.toFixed(1)}%)`);
  console.log(`  ${c("red",    "• Stop-Rule Hit (Policy Guard Blocked)    :")} ${String(metrics.outcomes.stop_rule_hit.count).padStart(3)} (${metrics.outcomes.stop_rule_hit.pct.toFixed(1)}%)`);
  console.log(`  ${c("dim",    "─────────────────────────────────────────────────────────────")}`);
  console.log(`  ${c("bold",   "  Total Records Evaluated                 :")} ${String(metrics.total_records).padStart(3)} (100.0%)`);

  header("3. CLASSIFICATION ACCURACY (PRE-CLASSIFIER vs LLM)");
  console.log(`  ${c("bold", "Overall Ground-Truth Accuracy")} : ${metrics.classification_accuracy.overall.accuracy_pct}% (${metrics.classification_accuracy.overall.correct}/${metrics.classification_accuracy.overall.total})`);
  console.log(`  ${c("dim", "• Pre-Classifier (Deterministic) ")} : ${metrics.classification_accuracy.pre_classifier_only.accuracy_pct}% (${metrics.classification_accuracy.pre_classifier_only.correct}/${metrics.classification_accuracy.pre_classifier_only.total} clear cases)`);
  console.log(`  ${c("magenta", "• LLM Diagnosis (20B + 120B Routed) ")} : ${metrics.classification_accuracy.llm_diagnosed.accuracy_pct}% (${metrics.classification_accuracy.llm_diagnosed.correct}/${metrics.classification_accuracy.llm_diagnosed.total} ambiguous cases)`);

  header("4. HONEST FALSE-POSITIVE RETRY COST");
  console.log(
    `  Pointless / Wasteful Retries Attempted: ${
      metrics.false_positive_cost.count === 0
        ? c("green", c("bold", "0 cases (₹0.00) — Policy Guard prevented all wasteful retries!"))
        : c("red", c("bold", `${metrics.false_positive_cost.count} cases (Total: ₹${metrics.false_positive_cost.total_amount_inr.toLocaleString("en-IN")})`))
    }`
  );
  if (metrics.false_positive_cost.cases.length > 0) {
    console.log(c("yellow", "\n  List of False-Positive Retry Attempts:"));
    for (const fp of metrics.false_positive_cost.cases) {
      console.log(`    • ${c("bold", fp.payment_id)} (₹${fp.amount_inr}): ${fp.reason} [diagnosed: ${fp.diagnosed_root_cause}]`);
    }
  } else {
    console.log(c("dim", "  (Policy Guard strictly intercepted expired mandates & insufficient funds from triggering retries)"));
  }

  header("5. DUAL-MODEL ESCALATION & POLICY OVERRIDES");
  console.log(`  LLM Dual-Model Escalations (20B -> 120B) : ${metrics.escalation.escalated_to_70b_count}/${metrics.escalation.total_llm_cases} LLM cases (${metrics.escalation.escalation_rate_llm_pct}%)`);
  console.log(`  Code-Level Policy Overrides Applied     : ${metrics.policy_overrides.total_overrides} (${metrics.policy_overrides.override_rate_total_pct}% of total batch)`);
  if (metrics.policy_overrides.cases.length > 0) {
    console.log(c("dim", "  Sample Policy Overrides Enforced:"));
    for (const po of metrics.policy_overrides.cases.slice(0, 4)) {
      console.log(`    • ${c("bold", po.payment_id)}: LLM suggested '${c("red", po.llm_suggested_action)}' -> Enforced '${c("green", po.enforced_action)}' (${po.diagnosed_root_cause})`);
    }
  }

  header("6. UNRESOLVED EXCEPTIONS (FULL UNABRIDGED LIST)");
  console.log(`  Total Stop-Rule Violations: ${metrics.unresolved_exceptions.length}`);
  if (metrics.unresolved_exceptions.length === 0) {
    console.log("  None.");
  } else {
    for (const ex of metrics.unresolved_exceptions) {
      console.log(`  ${c("red", "•")} ${c("bold", ex.payment_id.padEnd(16))} ₹${ex.amount_inr.toLocaleString("en-IN").padEnd(8)} attempts: ${ex.attempt_number}/${ex.max_attempts_allowed}  [${ex.true_root_cause}]`);
      console.log(`    ${c("dim", "Raw Failure :")} ${ex.failure_reason_raw}`);
      for (const v of ex.violations) {
        console.log(`    ${c("yellow", "Violation   :")} ${v}`);
      }
    }
  }

  // 4. Write Output JSON File
  const jsonOutput = {
    metadata: {
      generated_at: new Date().toISOString(),
      dataset_size: records.length,
      pipeline_version: "1.0.0",
      description: "Batch benchmark evaluation results and metrics for Revenue Recovery Agent",
    },
    metrics,
    results: batchOutput.results.map((r) => ({
      payment_id: r.payment.id,
      amount: r.payment.amount,
      currency: r.payment.currency,
      method: r.payment.method,
      failure_code: r.payment.failure_code,
      failure_reason_raw: r.payment.failure_reason_raw,
      attempt_number: r.payment.attempt_number,
      true_root_cause: r.payment.true_root_cause,
      ambiguity: r.payment.ambiguity,
      pipeline: {
        run_id: r.result.run_id,
        diagnosed_root_cause: r.result.root_cause,
        action_taken: r.result.action_taken,
        agent_outcome: r.result.agent_outcome,
        used_llm: r.result.used_llm,
        policy_overridden: r.result.policy_overridden,
        decision_path: r.result.decision_path,
        duration_ms: r.duration_ms,
        promise_tracking: r.result.promise_tracking,
      },
      trace: r.trace,
    })),
  };

  writeFileSync(outputPath, JSON.stringify(jsonOutput, null, 2), "utf-8");
  console.log(`\n${c("bold", hr("═"))}`);
  console.log(c("green", c("bold", `✔  Full evaluation results & traces saved to:`)));
  console.log(`   ${c("cyan", outputPath)}`);
  console.log(c("bold", hr("═") + "\n"));
}

main().catch((err) => {
  console.error(c("red", "\n[FATAL] Full batch evaluation failed:"), err);
  process.exit(1);
});
