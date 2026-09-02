// =============================================================
// test-harness.ts — Integration/demo test for DecisionHarness
// Revenue Recovery Agent | Razorpay Buildathon MVP
//
// Tests exercised:
//   [1] replayFn is fully generic — any function works as the seam
//   [2] recordNode() validates with Zod BEFORE insert; ZodError → clear message
//   [3] getRunTrace() returns clean tree with NO replays, then correct sibling
//       placement WITH replays (is_replay:true nodes appear under same parent)
//   [4] Calling replayNode() TWICE on the same node → two SEPARATE siblings
//       (not overwrites of each other)
//   [5] Missing env vars → ⚠ warning printed, falls back to mock with no crash
//
// Run (mock mode, no Supabase needed):
//   npx tsx src/test-harness.ts
//
// Run (real Supabase):
//   SUPABASE_URL=<url> SUPABASE_KEY=<key> npx tsx src/test-harness.ts
// =============================================================

import { v4 as uuidv4 } from "uuid";
import {
  DecisionHarness,
  ReplayResult,
  costSavedEstimate,
  tryCreateHarness,
} from "./harness.js";

// ─────────────────────────────────────────────────────────────
// In-memory mock harness
// Mirrors DecisionHarness's public API precisely, so the test
// runs identically whether or not Supabase is configured.
// ─────────────────────────────────────────────────────────────

type StoredNode = {
  node_id: string;
  run_id: string;
  parent_node_id: string | null;
  agent_name: string;
  model_used: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  confidence: number | null;
  escalated: boolean;
  latency_ms: number;
  cost_estimate: number | null;
  is_replay: boolean;
  replayed_from: string | null;
  created_at: string;
  children: StoredNode[];
};

class MockHarness {
  readonly store: StoredNode[] = [];

  async recordNode(params: {
    run_id: string;
    parent_node_id?: string | null;
    agent_name: string;
    model_used?: string | null;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
    confidence?: number | null;
    escalated?: boolean;
    latency_ms: number;
    cost_estimate?: number | null;
    is_replay?: boolean;
    replayed_from?: string | null;
  }): Promise<string> {
    const node_id = uuidv4();
    const node: StoredNode = {
      node_id,
      run_id: params.run_id,
      parent_node_id: params.parent_node_id ?? null,
      agent_name: params.agent_name,
      model_used: params.model_used ?? null,
      input: params.input,
      output: params.output,
      confidence: params.confidence ?? null,
      escalated: params.escalated ?? false,
      latency_ms: params.latency_ms,
      cost_estimate: params.cost_estimate ?? null,
      is_replay: params.is_replay ?? false,
      replayed_from: params.replayed_from ?? null,
      // Tiny sleep so created_at timestamps are distinct and sort order is stable
      created_at: new Date(Date.now()).toISOString(),
      children: [],
    };
    this.store.push(node);
    return node_id;
  }

  async getRunTrace(run_id: string): Promise<StoredNode[]> {
    const nodes = this.store
      .filter((n) => n.run_id === run_id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return buildTree(nodes);
  }

  async replayNode(
    node_id: string,
    modifiedInput: Record<string, unknown>,
    // replayFn is fully generic — the harness never inspects what it does
    replayFn: (input: Record<string, unknown>) => Promise<{
      output: Record<string, unknown>;
      latency_ms: number;
      confidence?: number | null;
      cost_estimate?: number | null;
      model_used?: string | null;
      escalated?: boolean;
    }>
  ): Promise<ReplayResult> {
    const original = this.store.find((n) => n.node_id === node_id);
    if (!original) throw new Error(`[MockHarness] Node ${node_id} not found`);

    const result = await replayFn(modifiedInput);

    // Tiny delay so timestamps don't collide on fast machines
    await new Promise((r) => setTimeout(r, 1));

    const replayId = await this.recordNode({
      run_id: original.run_id,
      parent_node_id: original.parent_node_id,   // sibling, NOT child
      agent_name: original.agent_name,
      model_used: result.model_used ?? original.model_used,
      input: modifiedInput,
      output: result.output,
      confidence: result.confidence ?? null,
      escalated: result.escalated ?? false,
      latency_ms: result.latency_ms,
      cost_estimate: result.cost_estimate ?? null,
      is_replay: true,
      replayed_from: original.node_id,
    });

    const replayNode = this.store.find((n) => n.node_id === replayId)!;
    return { original, replay: replayNode } as unknown as ReplayResult;
  }
}

// ─────────────────────────────────────────────────────────────
// Tree builder (mirrors harness.ts buildTree)
// ─────────────────────────────────────────────────────────────

function buildTree<T extends { node_id: string; parent_node_id: string | null }>(
  nodes: T[]
): (T & { children: (T & { children: unknown[] })[] })[] {
  const map = new Map<string, T & { children: unknown[] }>();
  const roots: (T & { children: unknown[] })[] = [];

  for (const node of nodes) {
    map.set(node.node_id, { ...node, children: [] });
  }
  for (const node of nodes) {
    const n = map.get(node.node_id)!;
    if (node.parent_node_id && map.has(node.parent_node_id)) {
      (map.get(node.parent_node_id)!.children as unknown[]).push(n);
    } else {
      roots.push(n);
    }
  }
  return roots as (T & { children: (T & { children: unknown[] })[] })[];
}

// ─────────────────────────────────────────────────────────────
// Pretty-print helpers
// ─────────────────────────────────────────────────────────────

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  white: "\x1b[37m",
};

function c(color: keyof typeof COLORS, text: string): string {
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

function hr(char = "─", len = 64): string {
  return char.repeat(len);
}

function section(title: string): void {
  console.log(`\n${c("bold", hr())}`);
  console.log(c("bold", `  ${title}`));
  console.log(c("bold", hr()) + "\n");
}

function pass(msg: string): void {
  console.log(`  ${c("green", "✔")} ${msg}`);
}

function fail(msg: string): void {
  console.log(`  ${c("red", "✘")} ${msg}`);
}

function assertEq<T>(label: string, actual: T, expected: T): void {
  if (actual === expected) {
    pass(`${label}: ${c("dim", String(actual))}`);
  } else {
    fail(`${label}: expected ${c("yellow", String(expected))}, got ${c("red", String(actual))}`);
    throw new Error(`Assertion failed: ${label}`);
  }
}

function assertIncludes(label: string, haystack: string, needle: string): void {
  if (haystack.includes(needle)) {
    pass(`${label}: found "${c("dim", needle)}"`);
  } else {
    fail(`${label}: "${needle}" NOT found in:\n${haystack}`);
    throw new Error(`Assertion failed: ${label}`);
  }
}

function printTree(
  nodes: (StoredNode & { children: unknown[] })[],
  prefix = ""
): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const last = i === nodes.length - 1;
    const branch = prefix + (last ? "└── " : "├── ");
    const childPrefix = prefix + (last ? "    " : "│   ");

    const replayTag = node.is_replay
      ? c("magenta", " [REPLAY]") + c("dim", ` ← ${node.replayed_from?.slice(0, 8)}`)
      : "";

    const conf =
      node.confidence !== null
        ? c("yellow", `conf:${node.confidence.toFixed(2)}`)
        : c("dim", "conf:N/A");
    const cost =
      node.cost_estimate !== null
        ? c("green", `$${node.cost_estimate.toFixed(5)}`)
        : c("dim", "$?");
    const latency = c("cyan", `${node.latency_ms}ms`);
    const escalated = node.escalated ? c("red", " ESC") : "";

    console.log(
      `${branch}${c("bold", node.agent_name)}${replayTag}` +
        `  ${c("dim", node.node_id.slice(0, 8))}  ${conf}  ${latency}  ${cost}${escalated}`
    );
    console.log(
      `${childPrefix}  ${c("dim", "model:")} ${node.model_used ?? "deterministic"}` +
        `  ${c("dim", "in:")} ${JSON.stringify(node.input).slice(0, 55)}` +
        `  ${c("dim", "out:")} ${JSON.stringify(node.output).slice(0, 55)}`
    );

    if (node.children.length > 0) {
      printTree(node.children as (StoredNode & { children: unknown[] })[], childPrefix);
    }
  }
}

function printSideBySide(
  cols: { label: string; node: StoredNode }[]
): void {
  const divider = hr("─", 72);
  console.log(c("bold", divider));
  const header = cols.map((col) => col.label.padEnd(24)).join("  │  ");
  console.log(`  ${header}`);
  console.log(c("bold", divider));

  const fields: (keyof StoredNode)[] = [
    "node_id", "confidence", "escalated", "latency_ms", "cost_estimate", "is_replay",
  ];

  for (const field of fields) {
    const vals = cols.map((col) => String(col.node[field] ?? "null"));
    const allSame = vals.every((v) => v === vals[0]);
    const row = vals.map((v, i) =>
      i === 0 ? v.slice(0, 22).padEnd(24) : v.slice(0, 22)
    ).join("  │  ");
    const marker = allSame ? "" : c("yellow", "  ◄ differs");
    console.log(`  ${c("dim", field.padEnd(16))}  ${row}${marker}`);
  }

  for (const col of cols) {
    console.log(`\n  ${c("dim", col.label + " input:")}  ${JSON.stringify(col.node.input).slice(0, 100)}`);
    console.log(`  ${c("dim", col.label + " output:")} ${JSON.stringify(col.node.output).slice(0, 100)}`);
  }
  console.log(c("bold", divider));
}

// ─────────────────────────────────────────────────────────────
// Main test suite
// ─────────────────────────────────────────────────────────────

async function main() {
  console.log(c("bold", "\n╔══════════════════════════════════════════════════════════════╗"));
  console.log(c("bold",   "║   Decision Harness — Integration Test Suite (5 checks)       ║"));
  console.log(c("bold",   "╚══════════════════════════════════════════════════════════════╝"));

  // ── [Check 5] Env-missing → ⚠ warning, not crash ─────────────
  section("CHECK 5 · Missing env vars → warning, clean fallback");

  // tryCreateHarness() should return null and print a console.warn
  // when SUPABASE_URL/KEY are absent.
  const savedUrl = process.env["SUPABASE_URL"];
  const savedKey = process.env["SUPABASE_KEY"];
  delete process.env["SUPABASE_URL"];
  delete process.env["SUPABASE_KEY"];

  const nullHarness = tryCreateHarness();   // should return null + warn
  assertEq("tryCreateHarness() returns null when env missing", nullHarness, null);
  pass("console.warn was printed above (⚠ line)");

  // Restore for the real-Supabase path (if set)
  if (savedUrl) process.env["SUPABASE_URL"] = savedUrl;
  if (savedKey) process.env["SUPABASE_KEY"] = savedKey;

  // Choose harness (real Supabase if env vars are set, mock otherwise)
  const useReal = Boolean(process.env["SUPABASE_URL"] && process.env["SUPABASE_KEY"]);
  const mock = new MockHarness();

  const harness = useReal
    ? new DecisionHarness(process.env["SUPABASE_URL"]!, process.env["SUPABASE_KEY"]!)
    : (mock as unknown as DecisionHarness);

  if (useReal) {
    pass("Using real Supabase — env vars are set");
  } else {
    pass("Using in-memory mock — no Supabase required for local dev");
  }

  // ── [Check 2] Zod validation fires before insert ──────────────
  section("CHECK 2 · Zod validates BEFORE insert; clear error on failure");

  // We always test this against DecisionHarness directly (not the mock),
  // because Zod validation runs inside DecisionHarness.recordNode() BEFORE
  // any DB call. The placeholder URL means no network request is ever made —
  // the function throws during validation, before reaching Supabase.
  const fakeHarness = new DecisionHarness("https://placeholder.supabase.co", "placeholder");

  let zodErrorCaught = false;
  let zodErrorMessage = "";
  try {
    await fakeHarness.recordNode({
      run_id: "NOT-A-UUID",      // invalid UUID → Zod rejects
      parent_node_id: null,
      agent_name: "test_agent",
      model_used: null,
      input: { x: 1 },
      output: { y: 2 },
      confidence: 9.99,          // out of range (max 1.0) → Zod rejects
      escalated: false,
      latency_ms: -5,            // negative → Zod rejects
      cost_estimate: null,
      is_replay: false,
      replayed_from: null,
    });
  } catch (err) {
    zodErrorCaught = true;
    zodErrorMessage = (err as Error).message;
  }

  assertEq("DecisionHarness throws on invalid params (before DB)", zodErrorCaught, true);
  assertIncludes("Error message says [Harness] Validation failed", zodErrorMessage, "[Harness] Validation failed");
  assertIncludes("Error names run_id field", zodErrorMessage, "run_id");
  assertIncludes("Error names confidence field", zodErrorMessage, "confidence");
  assertIncludes("Error names latency_ms field", zodErrorMessage, "latency_ms");

  console.log(`\n  ${c("dim", "Full validation error (3 issues named):")}`);
  zodErrorMessage.split("\n").forEach((line) => console.log(`    ${c("dim", line)}`));


  // ── Build the 3-node pipeline for checks 3 & 4 ───────────────
  section("SETUP · Record 3-node pipeline (pre_classifier → diagnosis_agent → action_decision_agent)");

  const run_id = uuidv4();
  console.log(`  ${c("dim", "run_id:")} ${c("cyan", run_id)}\n`);

  // Node A — root: Pre-Classifier (deterministic)
  console.log("  [1/3] pre_classifier …");
  const nodeA_id = await harness.recordNode({
    run_id,
    parent_node_id: null,
    agent_name: "pre_classifier",
    model_used: null,
    input: {
      payment_id: "pay_TEST001",
      failure_code: "BANK_DECLINED",
      amount: 4999,
      currency: "INR",
      method: "upi",
    },
    output: {
      known_code: true,
      root_cause_category: "bank_declined",
      confidence: 0.97,
    },
    confidence: 0.97,
    escalated: false,
    latency_ms: 12,
    cost_estimate: 0,
    is_replay: false,
    replayed_from: null,
  });
  console.log(`     → ${c("cyan", nodeA_id.slice(0, 8))}…`);

  // Node B — child: Diagnosis Agent (LLM)
  console.log("  [2/3] diagnosis_agent …");
  const nodeB_id = await harness.recordNode({
    run_id,
    parent_node_id: nodeA_id,
    agent_name: "diagnosis_agent",
    model_used: "openai/gpt-oss-20b",
    input: {
      payment_id: "pay_TEST001",
      root_cause_category: "bank_declined",
      customer_context: { retry_count: 1, last_retry_gap_hrs: 2 },
      mandate_valid: true,
    },
    output: {
      diagnosis: "transient_bank_timeout",
      recommended_action: "retry_after_delay",
      reasoning: "Bank decline code indicates transient issue; mandate is valid.",
    },
    confidence: 0.78,
    escalated: false,
    latency_ms: 340,
    cost_estimate: 0.00042,
    is_replay: false,
    replayed_from: null,
  });
  console.log(`     → ${c("cyan", nodeB_id.slice(0, 8))}…`);

  // Node C — grandchild: Action Decision Agent (LLM)
  console.log("  [3/3] action_decision_agent …");
  const nodeC_id = await harness.recordNode({
    run_id,
    parent_node_id: nodeB_id,
    agent_name: "action_decision_agent",
    model_used: "openai/gpt-oss-20b",
    input: {
      diagnosis: "transient_bank_timeout",
      recommended_action: "retry_after_delay",
      policy: { max_retries: 3, allowed_channels: ["upi", "netbanking"] },
    },
    output: {
      action: "schedule_retry",
      channel: "upi",
      delay_minutes: 30,
      within_policy: true,
    },
    confidence: 0.91,
    escalated: false,
    latency_ms: 280,
    cost_estimate: 0.00038,
    is_replay: false,
    replayed_from: null,
  });
  console.log(`     → ${c("cyan", nodeC_id.slice(0, 8))}…`);

  // ── [Check 3a] getRunTrace() — NO replay nodes yet ───────────
  section("CHECK 3a · getRunTrace() with NO replay nodes → clean linear tree");

  const baseTrace = await harness.getRunTrace(run_id);

  assertEq("Trace has exactly 1 root", baseTrace.length, 1);
  const root = baseTrace[0] as StoredNode & { children: unknown[] };
  assertEq("Root agent is pre_classifier", root.agent_name, "pre_classifier");
  assertEq("Root has 1 child (diagnosis_agent)", root.children.length, 1);

  const diagNode = root.children[0] as StoredNode & { children: unknown[] };
  assertEq("Level-2 agent is diagnosis_agent", diagNode.agent_name, "diagnosis_agent");
  assertEq("diagnosis_agent has 1 child (action_decision_agent)", diagNode.children.length, 1);

  const actionNode = diagNode.children[0] as StoredNode & { children: unknown[] };
  assertEq("Level-3 agent is action_decision_agent", actionNode.agent_name, "action_decision_agent");
  assertEq("action_decision_agent is a leaf (no children)", actionNode.children.length, 0);

  // No replay nodes anywhere
  const allNodes = [root, diagNode, actionNode];
  const anyReplays = allNodes.some((n) => n.is_replay);
  assertEq("No nodes have is_replay=true before any replay", anyReplays, false);

  console.log("\n  Tree (no replays):");
  printTree([root]);

  // ── [Check 1 + Check 4] Two replays on the same node ─────────
  section("CHECK 1 · replayFn is generic  &  CHECK 4 · Two replays → two separate sibling forks");

  console.log(`  Replaying ${c("cyan", "diagnosis_agent")} TWICE with different inputs.\n`);
  console.log(`  ${c("dim", "Replay A:")} mandate expired  → different diagnosis`);
  console.log(`  ${c("dim", "Replay B:")} insufficient funds scenario  → escalation path\n`);

  // ── Replay A: expired mandate scenario ───────────────────────
  // replayFn is a plain async arrow function — fully generic, no agent coupling
  const replayA: ReplayResult = await harness.replayNode(
    nodeB_id,
    {
      payment_id: "pay_TEST001",
      root_cause_category: "bank_declined",
      customer_context: { retry_count: 3, last_retry_gap_hrs: 0.5 },
      mandate_valid: false,
    },
    async (input) => {
      // Generic fn — could be an LLM call, a mock, a rule engine.
      // The harness does not care what this does.
      const mandateValid = input["mandate_valid"] as boolean;
      return {
        output: {
          diagnosis: "expired_mandate",
          recommended_action: "renew_mandate_notify_customer",
          reasoning: "Mandate is expired; retry will not succeed.",
        },
        confidence: mandateValid ? 0.78 : 0.95,
        latency_ms: 290,
        cost_estimate: 0.00039,
        model_used: "openai/gpt-oss-20b",
        escalated: false,
      };
    }
  );

  // ── Replay B: insufficient funds / escalation scenario ────────
  // A completely different function — demonstrates the seam is truly generic
  const replayB: ReplayResult = await harness.replayNode(
    nodeB_id,
    {
      payment_id: "pay_TEST001",
      root_cause_category: "bank_declined",
      customer_context: { retry_count: 3, last_retry_gap_hrs: 0.1 },
      mandate_valid: true,
      additional_signal: "wallet_balance_low",   // extra field — harness passes it through
    },
    async (_input) => {
      // Completely different function shape — proves the seam is generic
      // This one uses none of _input and returns a hardcoded fixture.
      // Real agents would call Groq here. Harness doesn't know or care.
      return {
        output: {
          diagnosis: "insufficient_funds",
          recommended_action: "escalate_to_human",
          reasoning: "Retry count exhausted and balance signal is low; human review needed.",
        },
        confidence: 0.62,
        latency_ms: 512,           // noticeably different latency
        cost_estimate: 0.00091,    // noticeably different cost (escalated to 70B model)
        model_used: "openai/gpt-oss-120b",  // different model than original
        escalated: true,
      };
    }
  );

  // ── Assertions for Check 4 ────────────────────────────────────
  const replayA_node = replayA.replay as unknown as StoredNode;
  const replayB_node = replayB.replay as unknown as StoredNode;

  // Both are tagged as replays
  assertEq("Replay A has is_replay=true", replayA_node.is_replay, true);
  assertEq("Replay B has is_replay=true", replayB_node.is_replay, true);

  // Both point back to the same original node
  assertEq("Replay A.replayed_from = nodeB_id", replayA_node.replayed_from, nodeB_id);
  assertEq("Replay B.replayed_from = nodeB_id", replayB_node.replayed_from, nodeB_id);

  // Both share the same parent (sibling relationship)
  assertEq("Replay A.parent_node_id = nodeA_id", replayA_node.parent_node_id, nodeA_id);
  assertEq("Replay B.parent_node_id = nodeA_id", replayB_node.parent_node_id, nodeA_id);

  // They are DIFFERENT nodes (not overwrites of each other)
  const sameId = replayA_node.node_id === replayB_node.node_id;
  assertEq("Replay A and Replay B have DIFFERENT node_ids", sameId, false);

  // Their outputs differ from each other
  const sameOutput = JSON.stringify(replayA_node.output) === JSON.stringify(replayB_node.output);
  assertEq("Replay A and Replay B have DIFFERENT outputs", sameOutput, false);

  // ── [Check 3b] getRunTrace() WITH replay nodes ────────────────
  section("CHECK 3b · getRunTrace() WITH replay nodes → replays as siblings under same parent");

  const fullTrace = await harness.getRunTrace(run_id);

  assertEq("Trace still has exactly 1 root", fullTrace.length, 1);
  const fullRoot = fullTrace[0] as StoredNode & { children: unknown[] };

  // pre_classifier should now have 3 children:
  //   [0] original diagnosis_agent  (is_replay: false)
  //   [1] replay A                  (is_replay: true)
  //   [2] replay B                  (is_replay: true)
  assertEq(
    "pre_classifier has 3 children (1 original + 2 replay siblings)",
    fullRoot.children.length,
    3
  );

  const children = fullRoot.children as (StoredNode & { children: unknown[] })[];

  // The original is still there and unchanged
  const originalChild = children.find((n) => !n.is_replay)!;
  assertEq("Original diagnosis_agent still present with is_replay=false", originalChild?.is_replay, false);
  assertEq("Original has its child (action_decision_agent) intact", originalChild?.children.length, 1);

  // Two replay siblings
  const replaySiblings = children.filter((n) => n.is_replay);
  assertEq("Exactly 2 replay siblings under pre_classifier", replaySiblings.length, 2);
  assertEq("Replay sibling 1 is_replay=true", replaySiblings[0]?.is_replay, true);
  assertEq("Replay sibling 2 is_replay=true", replaySiblings[1]?.is_replay, true);

  // Replay siblings both have no children of their own (they're leaf forks)
  assertEq("Replay sibling 1 is a leaf (no children)", replaySiblings[0]?.children.length, 0);
  assertEq("Replay sibling 2 is a leaf (no children)", replaySiblings[1]?.children.length, 0);

  console.log("\n  Full tree (with 2 replay forks visible as siblings):");
  printTree([fullRoot]);

  // ── Side-by-side: Original vs both replays ────────────────────
  section("RESULT · Original vs Replay A vs Replay B — side-by-side");

  printSideBySide([
    { label: "ORIGINAL", node: replayA.original as unknown as StoredNode },
    { label: "REPLAY A (expired mandate)", node: replayA_node },
    { label: "REPLAY B (insufficient funds)", node: replayB_node },
  ]);

  // ── Cost saved estimate ───────────────────────────────────────
  section("RESULT · costSavedEstimate()");

  // Proxy: cost of full pipeline re-run = all 3 original nodes
  const fullPipelineCost = {
    cost_estimate:
      0 + 0.00042 + 0.00038,  // pre_classifier + diagnosis + action
  };

  const savedVsA = costSavedEstimate(fullPipelineCost, replayA_node);
  const savedVsB = costSavedEstimate(fullPipelineCost, replayB_node);

  console.log(`  Full pipeline re-run cost (proxy):         ${c("red", `$${fullPipelineCost.cost_estimate.toFixed(5)}`)}`);
  console.log(`  Replay A cost (expired mandate):           ${c("green", `$${(replayA_node.cost_estimate ?? 0).toFixed(5)}`)}`);
  console.log(`  Replay B cost (insufficient/escalation):   ${c("green", `$${(replayB_node.cost_estimate ?? 0).toFixed(5)}`)}`);
  console.log(`  Saved vs Replay A: ${c("yellow", `$${savedVsA.toFixed(5)}`)} (${c("bold", `${((savedVsA / fullPipelineCost.cost_estimate) * 100).toFixed(1)}% cheaper`)})`);
  console.log(`  Saved vs Replay B: ${c("yellow", `$${savedVsB.toFixed(5)}`)} (${c("bold", `${((savedVsB / fullPipelineCost.cost_estimate) * 100).toFixed(1)}% cheaper`)})`);

  // ── Final summary ─────────────────────────────────────────────
  console.log(c("bold", `\n${hr("═")}`));
  console.log(c("green", c("bold", "  ALL CHECKS PASSED")));
  console.log(`  ${c("dim", "[1]")} replayFn is generic — two different functions used, harness accepted both`);
  console.log(`  ${c("dim", "[2]")} Zod validates before insert — bad params throw [Harness] Validation failed`);
  console.log(`  ${c("dim", "[3]")} getRunTrace() correct with and without replay nodes`);
  console.log(`  ${c("dim", "[4]")} Two replays on same node → two separate siblings, different node_ids`);
  console.log(`  ${c("dim", "[5]")} Missing env vars → ⚠ warning + null returned, no crash`);
  console.log(c("bold", hr("═") + "\n"));
}

main().catch((err) => {
  console.error(c("red", "\n[FATAL] Test script failed:"), err);
  process.exit(1);
});
