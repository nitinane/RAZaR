// =============================================================
// test-pipeline.ts — Pipeline Integration Test (Deterministic + LLM)
// Revenue Recovery Agent | Razorpay Buildathon MVP
//
// Runs 6 curated failed_payments records through the full pipeline:
//   #1 pay_0001  BANK_TIMEOUT / low ambiguity     → deterministic confident → retry (Path C)
//   #2 pay_0006  INSUFFICIENT_FUNDS / low         → deterministic confident → retry (Path C)
//   #3 pay_0008  GATEWAY_ERROR / low              → deterministic confident → retry (Path C)
//   #4 pay_0011  UNKNOWN / high ambiguity         → LLM Dual-Model Diagnosis → Action Decision
//   #5 pay_0003  EXPIRED_MANDATE / ambiguous msg  → LLM Diagnosis → Policy Override Check
//   #6 pay_maxed_01 BANK_TIMEOUT / attempt=3=max  → stop-rule trip (Path B1)
//
// Mode detection:
//   With SUPABASE_URL/KEY → fetches from DB, writes results back
//   Without              → reads from data/failed_payments.json, uses mock harness
//
// Run:
//   npx tsx src/test-pipeline.ts
// =============================================================

import "dotenv/config";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { v4 as uuidv4 } from "uuid";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

import { tryCreateHarness } from "./harness.js";
import type { HarnessLike, RecordNodeParams, HarnessTreeNode } from "./harness.js";
import { runPipeline, createDbClient } from "./pipeline.js";
import type { FailedPaymentRecord, PipelineResult } from "./types.js";

// ─────────────────────────────────────────────────────────────
// In-memory mock harness (mirrors harness.ts MockHarness)
// ─────────────────────────────────────────────────────────────

type FlatNode = RecordNodeParams & {
  node_id: string;
  created_at: string;
};

class MockHarness implements HarnessLike {
  readonly nodes: FlatNode[] = [];

  async recordNode(params: RecordNodeParams): Promise<string> {
    const node_id = uuidv4();
    this.nodes.push({ ...params, node_id, created_at: new Date().toISOString() });
    return node_id;
  }

  async getRunTrace(run_id: string): Promise<HarnessTreeNode[]> {
    const flat = this.nodes
      .filter((n) => n.run_id === run_id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));

    const map = new Map<string, HarnessTreeNode>();
    const roots: HarnessTreeNode[] = [];

    for (const n of flat) {
      map.set(n.node_id, {
        node_id: n.node_id,
        run_id: n.run_id,
        parent_node_id: n.parent_node_id ?? null,
        agent_name: n.agent_name,
        model_used: n.model_used ?? null,
        input: n.input,
        output: n.output,
        confidence: n.confidence ?? null,
        escalated: n.escalated ?? false,
        latency_ms: n.latency_ms,
        cost_estimate: n.cost_estimate ?? null,
        is_replay: n.is_replay ?? false,
        replayed_from: n.replayed_from ?? null,
        created_at: n.created_at,
        children: [],
      });
    }

    for (const n of flat) {
      const node = map.get(n.node_id)!;
      const pid = n.parent_node_id;
      if (pid && map.has(pid)) {
        map.get(pid)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }
}

// ─────────────────────────────────────────────────────────────
// Mock Supabase DB (writes are no-ops)
// ─────────────────────────────────────────────────────────────

function createMockDb() {
  const noop = () => ({ error: null, data: null });
  return {
    from: () => ({
      select: () => ({ eq: () => ({ single: noop, data: null, error: null }) }),
      update: () => ({ eq: noop }),
      is: () => ({ order: () => ({ limit: noop }) }),
    }),
  } as unknown as ReturnType<typeof createClient>;
}

// ─────────────────────────────────────────────────────────────
// Pretty-print helpers
// ─────────────────────────────────────────────────────────────

const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  cyan:    "\x1b[36m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  magenta: "\x1b[35m",
  red:     "\x1b[31m",
  white:   "\x1b[37m",
  blue:    "\x1b[34m",
};
const c = (color: keyof typeof C, t: string) => `${C[color]}${t}${C.reset}`;
const hr = (ch = "─", n = 68) => ch.repeat(n);

function outcomeColor(outcome: string): string {
  switch (outcome) {
    case "resolved":                return c("green", outcome);
    case "notify_customer_pending": return c("blue", outcome);
    case "stop_rule_hit":           return c("red", outcome);
    case "escalated_to_human":      return c("yellow", outcome);
    default:                        return c("dim", outcome);
  }
}

function printTrace(tree: HarnessTreeNode[], prefix = ""): void {
  for (let i = 0; i < tree.length; i++) {
    const node = tree[i];
    const last  = i === tree.length - 1;
    const branch = prefix + (last ? "└── " : "├── ");
    const child  = prefix + (last ? "    " : "│   ");

    const conf =
      node.confidence !== null
        ? c("yellow", `conf:${node.confidence.toFixed(2)}`)
        : c("dim", "conf:—");
    const esc  = node.escalated ? c("red", " ESC") : "";
    const lat  = c("cyan", `${node.latency_ms}ms`);
    const cost = node.cost_estimate !== null && node.cost_estimate > 0
      ? c("green", ` $${node.cost_estimate.toFixed(5)}`)
      : "";

    console.log(
      `${branch}${c("bold", node.agent_name)}  ${c("dim", node.node_id.slice(0, 8))}  ` +
      `${node.model_used ? c("magenta", `[${node.model_used}] `) : ""}` +
      `${conf}  ${lat}${cost}${esc}`
    );

    // Key output fields per agent
    const out = node.output;
    if (node.agent_name === "pre_classifier") {
      console.log(
        `${child}  ${c("dim", "confident:")} ${out["confident"]}  ` +
        `${c("dim", "root_cause:")} ${out["root_cause"] ?? "—"}  ` +
        `${c("dim", "pattern:")} ${String(out["matched_pattern"]).slice(0, 55)}`
      );
    } else if (node.agent_name === "diagnosis_agent") {
      console.log(
        `${child}  ${c("dim", "root_cause:")} ${c("bold", String(out["root_cause"]))}  ` +
        `${c("dim", "confidence:")} ${out["confidence"]}  ` +
        `${c("dim", "escalated_70b:")} ${out["needs_70b_escalation"] ?? false}`
      );
      console.log(`${child}  ${c("dim", "reasoning:")} ${String(out["reasoning"]).slice(0, 85)}`);
    } else if (node.agent_name === "action_decision_agent") {
      const overridden = out["policy_overridden"] as boolean;
      console.log(
        `${child}  ${c("dim", "action:")} ${c("bold", String(out["final_action"]))}  ` +
        `${c("dim", "llm_suggested:")} ${out["llm_suggested_action"]}  ` +
        (overridden ? c("yellow", " [POLICY OVERRIDDEN]") : c("green", " [POLICY OK]"))
      );
      console.log(`${child}  ${c("dim", "reasoning:")} ${String(out["llm_reasoning"]).slice(0, 85)}`);
      if (overridden) {
        console.log(`${child}  ${c("yellow", "override_reason:")} ${String(out["policy_override_reason"]).slice(0, 85)}`);
      }
    } else if (node.agent_name === "stop_rule_guard") {
      const viol = (out["violations"] as string[]) ?? [];
      console.log(
        `${child}  ${c("dim", "allowed:")} ${out["allowed"]}  ` +
        (viol.length > 0 ? c("red", `violations: ${viol.length}`) : c("green", "no violations"))
      );
      if (viol.length > 0) {
        for (const v of viol) {
          console.log(`${child}    ${c("red", "•")} ${v.slice(0, 90)}`);
        }
      }
    } else if (node.agent_name === "execution_agent") {
      console.log(
        `${child}  ${c("dim", "action:")} ${out["action_taken"]}  ` +
        `${c("dim", "outcome:")} ${out["outcome"]}  ` +
        `${c("dim", "order_id:")} ${out["razorpay_order_id"] ?? "—"}`
      );
      console.log(`${child}  ${c("dim", "notes:")} ${String(out["notes"]).slice(0, 90)}`);
    }

    if (node.children.length > 0) {
      printTrace(node.children, child);
    }
  }
}

function printResult(payment: FailedPaymentRecord, result: PipelineResult, trace: HarnessTreeNode[]): void {
  console.log(`\n${c("bold", hr())}`);
  console.log(
    `  ${c("bold", payment.id)}  ` +
    `${c("dim", `₹${(payment.amount / 100).toFixed(0)}`)}  ` +
    `${c("blue", payment.method)}  ` +
    `${c("cyan", payment.failure_code)}  ` +
    `attempt ${payment.attempt_number}/${payment.max_attempts_allowed}`
  );
  console.log(`  ${c("dim", "failure_reason:")}    ${payment.failure_reason_raw}`);
  console.log(`  ${c("dim", "run_id:")}            ${result.run_id}`);
  console.log(`  ${c("dim", "used_llm:")}          ${result.used_llm ? c("magenta", "YES (Groq Dual-Model)") : c("dim", "NO (deterministic)")}`);
  console.log(`  ${c("dim", "root_cause:")}        ${c("bold", result.root_cause ?? "unknown")}`);
  console.log(`  ${c("dim", "action_taken:")}      ${c("bold", result.action_taken)}`);
  console.log(`  ${c("dim", "policy_override:")}   ${result.policy_overridden ? c("yellow", "TRUE (overrode LLM action)") : c("dim", "false")}`);
  console.log(`  ${c("dim", "agent_outcome:")}     ${outcomeColor(result.agent_outcome)}`);
  console.log(`  ${c("dim", "decision_path:")}     ${result.decision_path}`);
  console.log(`\n  ${c("bold", "Harness Trace:")}`);
  printTrace(trace);
  console.log(c("bold", hr()));
}

// ─────────────────────────────────────────────────────────────
// Test records — 6 curated IDs covering all paths
// ─────────────────────────────────────────────────────────────

const TEST_IDS = [
  "pay_0001",      // Path C: BANK_TIMEOUT, low ambiguity     → deterministic → retry
  "pay_0006",      // Path C: INSUFFICIENT_FUNDS, low         → deterministic → retry
  "pay_0008",      // Path C: GATEWAY_ERROR, low              → deterministic → retry
  "pay_0011",      // Path A: UNKNOWN, high ambiguity         → LLM Diagnosis + Action Decision
  "pay_0003",      // Path A: EXPIRED_MANDATE / ambiguous msg → LLM Diagnosis + Policy Override
  "pay_maxed_01",  // Path B1: BANK_TIMEOUT, attempt=3=max    → stop_rule_hit
];

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  console.log(c("bold", "\n╔════════════════════════════════════════════════════════════════════╗"));
  console.log(c("bold",   "║   Revenue Recovery Pipeline — Full Test (Deterministic + LLM)      ║"));
  console.log(c("bold",   "╚════════════════════════════════════════════════════════════════════╝\n"));

  const realHarness = tryCreateHarness();
  const realDb      = createDbClient();

  let harness: HarnessLike = new MockHarness();
  let db: SupabaseClient = createMockDb();
  let useReal = false;

  if (realHarness && realDb) {
    try {
      const { error } = await realDb.from("failed_payments").select("id").limit(1);
      if (error) throw error;
      harness = realHarness;
      db = realDb;
      useReal = true;
      console.log(c("green", "✔  Supabase connected and verified. DB reads/writes are live.\n"));
    } catch (err) {
      console.warn(
        c("yellow", `⚠  Supabase check failed (${(err as Error).message}). Falling back to in-memory mock + local JSON dataset.\n`)
      );
    }
  } else {
    console.log(c("yellow", "⚠  No Supabase env vars. Using in-memory mock + local JSON dataset.\n"));
  }

  if (process.env["GROQ_API_KEY"]) {
    console.log(c("green", "✔  GROQ_API_KEY detected. LLM Dual-Model agents active (openai/gpt-oss-20b -> openai/gpt-oss-120b).\n"));
  } else {
    console.log(c("red", "✘  GROQ_API_KEY is not set. LLM cases will use simulation.\n"));
  }

  // ── Load test payments ────────────────────────────────────────
  let payments: FailedPaymentRecord[];

  if (useReal) {
    const { data, error } = await db
      .from("failed_payments")
      .select("*")
      .in("id", TEST_IDS)
      .order("created_at", { ascending: true });

    if (error || !data || data.length === 0) {
      console.warn(c("yellow", `[Test] ⚠ Could not fetch test payments from Supabase (${error?.message ?? "table is empty"}). Using local failed_payments.json.`));
      const __filename = fileURLToPath(import.meta.url);
      const dataPath = join(dirname(__filename), "..", "data", "failed_payments.json");
      const all = JSON.parse(readFileSync(dataPath, "utf-8")) as FailedPaymentRecord[];
      const byId = new Map(all.map((p) => [p.id, p]));
      payments = TEST_IDS.flatMap((id) => {
        const p = byId.get(id);
        if (!p) { console.warn(`[Test] Payment ${id} not in JSON.`); return []; }
        return [p];
      });
    } else {
      const byId = new Map((data as FailedPaymentRecord[]).map((p) => [p.id, p]));
      payments = TEST_IDS.flatMap((id) => {
        const p = byId.get(id);
        if (!p) { console.warn(`[Test] Payment ${id} not found in DB.`); return []; }
        return [p];
      });
    }
  } else {
    const __filename = fileURLToPath(import.meta.url);
    const dataPath = join(dirname(__filename), "..", "data", "failed_payments.json");
    const all = JSON.parse(readFileSync(dataPath, "utf-8")) as FailedPaymentRecord[];
    const byId = new Map(all.map((p) => [p.id, p]));
    payments = TEST_IDS.flatMap((id) => {
      const p = byId.get(id);
      if (!p) { console.warn(`[Test] Payment ${id} not in JSON.`); return []; }
      return [p];
    });
  }

  console.log(
    `Running ${c("bold", String(payments.length))} payments through the pipeline…\n` +
    `  ${c("green",   "Deterministic Path: 3 cases (pay_0001, pay_0006, pay_0008)")}\n` +
    `  ${c("magenta", "LLM Diagnosis Path:  2 cases (pay_0011, pay_0003)")}\n` +
    `  ${c("red",     "Stop-Rule Guard:     1 case  (pay_maxed_01)")}\n`
  );

  const summary: Record<string, number> = {
    resolved: 0,
    notify_customer_pending: 0,
    escalated_to_human: 0,
    stop_rule_hit: 0,
    llm_used_count: 0,
    policy_overridden_count: 0,
  };

  for (let i = 0; i < payments.length; i++) {
    const payment = payments[i];
    console.log(
      `\n[${i + 1}/${payments.length}] Processing ${c("bold", payment.id)}  ` +
      `${c("dim", payment.failure_code)}  reason="${payment.failure_reason_raw.slice(0, 45)}…"…`
    );

    try {
      const result = await runPipeline(harness, db, payment, {
        execution: { forceOutcome: "success" },
      });

      const trace = await harness.getRunTrace(result.run_id);
      printResult(payment, result, trace);

      summary[result.agent_outcome] = (summary[result.agent_outcome] ?? 0) + 1;
      if (result.used_llm) summary["llm_used_count"]++;
      if (result.policy_overridden) summary["policy_overridden_count"]++;

    } catch (err) {
      console.error(`  ${c("red", "[ERROR]")} Pipeline failed for ${payment.id}:`, err);
    }
  }

  // ── Summary table ─────────────────────────────────────────────
  console.log(`\n${c("bold", "═".repeat(68))}`);
  console.log(c("bold", "  PIPELINE EXECUTION SUMMARY"));
  console.log(c("bold", "═".repeat(68)));
  console.log(`  ${c("green",   `resolved                 : ${summary["resolved"] ?? 0}`)}`);
  console.log(`  ${c("blue",    `notify_customer_pending  : ${summary["notify_customer_pending"] ?? 0}`)}`);
  console.log(`  ${c("yellow",  `escalated_to_human       : ${summary["escalated_to_human"] ?? 0}`)}`);
  console.log(`  ${c("red",     `stop_rule_hit            : ${summary["stop_rule_hit"] ?? 0}`)}`);
  console.log(`  ${c("magenta", `LLM agent path used      : ${summary["llm_used_count"] ?? 0}`)}`);
  console.log(`  ${c("yellow",  `policy overrides applied : ${summary["policy_overridden_count"] ?? 0}`)}`);
  console.log(`  ${c("dim",     `total payments processed : ${payments.length}`)}`);
  console.log(c("bold", "═".repeat(68)));

  // ── Assertions ────────────────────────────────────────────────
  console.log(`\n${c("bold", "Assertions:")}`);

  function assert(label: string, condition: boolean): void {
    if (condition) {
      console.log(`  ${c("green", "✔")} ${label}`);
    } else {
      console.log(`  ${c("red", "✘")} ${label}`);
      process.exitCode = 1;
    }
  }

  assert("Total 6 payments processed", payments.length === 6);
  assert("Retries resolved cleanly", (summary["resolved"] ?? 0) >= 2);
  assert("Customer notifications pending", (summary["notify_customer_pending"] ?? 0) >= 1);
  assert("Stop rule triggered for maxed attempt", (summary["stop_rule_hit"] ?? 0) === 1);
  assert("LLM Dual-Model path exercised (2 cases)", (summary["llm_used_count"] ?? 0) === 2);

  console.log(c("bold", `\n${"═".repeat(68)}\n`));
}

main().catch((err) => {
  console.error("\x1b[31m[FATAL]\x1b[0m", err);
  process.exit(1);
});
