// =============================================================
// replayServer.ts — Fork & Replay API Server
// Revenue Recovery Agent | Razorpay Buildathon MVP
//
// Exposes a single endpoint:
//   POST /api/replay
//   Body: { node_id: string, agent_name: string, modified_input: Record<string,unknown> }
//
// Wires the UI's "Fork & Replay" button to the REAL harness.replayNode()
// call, which in turn calls the real agent logic (runDiagnosisAgent,
// runActionDecisionAgent, etc.) against the live Groq API.
//
// Run: npx tsx src/replayServer.ts
// Vite proxies /api/* → http://localhost:3001/api/*
// =============================================================

import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";

import { DecisionHarness, tryCreateHarness }  from "./harness.js";
import { runDiagnosisAgent }    from "./agents/diagnosisAgent.js";
import { runActionDecisionAgent } from "./agents/actionDecisionAgent.js";
import type { FailedPaymentRecord, DiagnosisResult } from "./types.js";

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

const PORT = 3001;

// ─────────────────────────────────────────────────────────────
// Harness — real DecisionHarness (requires Supabase creds)
// ─────────────────────────────────────────────────────────────

// replayNode() requires a real DB to fetch the original node and write the
// sibling fork. If Supabase creds are missing, replay is impossible and the
// endpoint returns a clear 503 explaining what's needed.
function getHarness(): DecisionHarness | null {
  return tryCreateHarness();
}

// ─────────────────────────────────────────────────────────────
// Express app
// ─────────────────────────────────────────────────────────────

const app = express();

// Allow requests from the Vite dev server (port 5173) and any local port
app.use(cors({ origin: /localhost/ }));
app.use(express.json({ limit: "1mb" }));

// ── Health check ─────────────────────────────────────────────

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── POST /api/replay ─────────────────────────────────────────

interface ReplayRequestBody {
  /** UUID of the harness node to fork */
  node_id: string;
  /** Agent that produced the original node */
  agent_name: "diagnosis_agent" | "action_decision_agent" | string;
  /** Modified input — only fields that changed need to be set;
   *  merged with the original node's stored input by the harness */
  modified_input: Record<string, unknown>;
}

app.post("/api/replay", async (req: Request, res: Response) => {
  const body = req.body as ReplayRequestBody;

  // ── Input validation ──────────────────────────────────────
  if (!body?.node_id || typeof body.node_id !== "string") {
    res.status(400).json({ error: "node_id is required" });
    return;
  }
  if (!body?.agent_name || typeof body.agent_name !== "string") {
    res.status(400).json({ error: "agent_name is required" });
    return;
  }
  if (!body?.modified_input || typeof body.modified_input !== "object") {
    res.status(400).json({ error: "modified_input is required" });
    return;
  }

  console.log(
    `[ReplayServer] Fork & Replay request: node_id=${body.node_id} ` +
    `agent=${body.agent_name}`
  );

  const harness = getHarness();

  if (!harness) {
    res.status(503).json({
      error:
        "Fork & Replay requires a real Supabase connection to fetch the original node and persist the fork. " +
        "Set SUPABASE_URL + SUPABASE_KEY in harness/.env and restart the replay server.",
    });
    return;
  }

  try {
    // ── Reconstruct FailedPaymentRecord from modified_input ──
    // The harness node input always contains the agent-visible payment fields.
    // We reconstruct a minimal FailedPaymentRecord from those stored fields,
    // then overlay any fields the user modified in the UI.
    const mergedInput = body.modified_input as Record<string, unknown>;

    const payment: FailedPaymentRecord = {
      id:                  (mergedInput["payment_id"]        as string)  ?? "replay_unknown",
      amount:              (mergedInput["amount_paise"]       as number)  ?? 0,
      currency:            "INR",
      method:              (mergedInput["method"]             as "upi" | "card" | "netbanking" | "wallet") ?? "upi",
      customer_id:         (mergedInput["customer_id"]        as string)  ?? "replay_cust",
      mandate_id:          (mergedInput["mandate_id"]         as string | null) ?? null,
      failure_code:        (mergedInput["failure_code"]       as string)  ?? "UNKNOWN",
      failure_reason_raw:  (mergedInput["failure_reason_raw"] as string)  ?? "replay input",
      attempt_number:      (mergedInput["attempt_number"]     as number)  ?? 0,
      max_attempts_allowed:(mergedInput["max_attempts_allowed"] as number) ?? 3,
      created_at:          new Date().toISOString(),
      // Ground-truth fields are NOT included — the agent must never see them
    };

    // ── Dispatch to the right agent replayFn ─────────────────
    if (body.agent_name === "diagnosis_agent") {

      // replayFn: calls the real runDiagnosisAgent with the modified payment.
      // The harness.replayNode() wraps this so the result is stored as a
      // sibling node tagged is_replay=true, replayed_from=<original node_id>.
      const replayResult = await (harness as DecisionHarness).replayNode(
        body.node_id,
        mergedInput,
        async (modInput: Record<string, unknown>) => {
          const modifiedPayment: FailedPaymentRecord = {
            ...payment,
            failure_reason_raw: (modInput["failure_reason_raw"] as string) ?? payment.failure_reason_raw,
            failure_code:       (modInput["failure_code"] as string)       ?? payment.failure_code,
          };

          const t0 = Date.now();
          const result: DiagnosisResult = await runDiagnosisAgent(
            // Use a pass-through harness adapter that doesn't double-write nodes
            // during a replay — only the outer replayNode() call writes the fork.
            new NoOpHarness(),
            body.node_id,   // use original node_id as run_id proxy (good enough for replay)
            null,
            modifiedPayment
          );

          return {
            output: {
              root_cause:       result.root_cause,
              confidence:       result.confidence,
              reasoning:        result.reasoning,
              model_used:       result.model_used,
              escalated_to_120b: result.escalated_to_70b,
              is_replay:        true,
            },
            latency_ms:    Date.now() - t0,
            confidence:    result.confidence,
            model_used:    result.model_used,
            escalated:     result.escalated_to_70b,
            cost_estimate: result.escalated_to_70b ? 0.000118 : 0.0000264,
          };
        }
      );

      res.json({
        ok: true,
        original: replayResult.original,
        replay:   replayResult.replay,
      });

    } else if (body.agent_name === "action_decision_agent") {

      // For action_decision_agent replays, we need the prior diagnosis context.
      // The node's input always includes root_cause + confidence + reasoning.
      const diagnosisCtx = {
        root_cause:  (mergedInput["root_cause"]            as DiagnosisResult["root_cause"]) ?? "unknown",
        confidence:  (mergedInput["diagnosis_confidence"]  as number) ?? 0.0,
        reasoning:   (mergedInput["diagnosis_reasoning"]   as string) ?? "",
      };

      const replayResult = await (harness as DecisionHarness).replayNode(
        body.node_id,
        mergedInput,
        async (_modInput: Record<string, unknown>) => {
          const t0 = Date.now();

          const result = await runActionDecisionAgent(
            new NoOpHarness(),
            body.node_id,
            null,
            payment,
            diagnosisCtx
          );

          return {
            output: {
              llm_suggested_action: result.llm_suggested_action,
              final_action:         result.action,
              policy_overridden:    result.policy_overridden,
              reasoning:            result.reasoning,
              is_replay:            true,
            },
            latency_ms:    Date.now() - t0,
            confidence:    null,
            model_used:    "openai/gpt-oss-20b",
            escalated:     result.action === "escalate_human",
            cost_estimate: 0.0000264,
          };
        }
      );

      res.json({
        ok: true,
        original: replayResult.original,
        replay:   replayResult.replay,
      });

    } else {
      // Unknown agent type — return a clear error
      res.status(400).json({
        error: `Replay not supported for agent_name='${body.agent_name}'. ` +
               `Supported: diagnosis_agent, action_decision_agent.`,
      });
    }

  } catch (err) {
    const message = (err as Error).message ?? String(err);
    console.error(`[ReplayServer] ❌ Replay failed for node ${body.node_id}: ${message}`);
    res.status(500).json({ error: message });
  }
});

// ─────────────────────────────────────────────────────────────
// NoOpHarness — used during replay to prevent double-writing
// When the outer replayNode() call runs the replayFn, the replayFn
// itself calls runDiagnosisAgent which internally tries to write harness
// nodes. We don't want those inner writes — only the outer sibling fork
// node matters. NoOpHarness drops all recordNode() calls silently.
// ─────────────────────────────────────────────────────────────

class NoOpHarness {
  async recordNode(_params: unknown): Promise<string> {
    // Intentionally no-op — suppress inner agent recordNode writes during replay
    return `noop_${Date.now()}`;
  }

  async getRunTrace(_run_id: string) {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[ReplayServer] ✅ Listening on http://localhost:${PORT}`);
  console.log(`[ReplayServer]    POST /api/replay — Fork & Replay endpoint`);
  console.log(`[ReplayServer]    GET  /api/health  — Health check`);
});
