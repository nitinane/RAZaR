// =============================================================
// replayServer.ts — Fork & Replay API Server (Hardened & Audited)
// Revenue Recovery Agent | Razorpay Buildathon MVP
//
// Endpoints:
//   GET  /api/health — Real-time reachability check (Groq, Supabase, models)
//   POST /api/replay — Fork & Replay endpoint with rate limiting, size limits,
//                      UUID validation, and 404 node existence checks.
//
// Run: npm run replay:server
// Vite proxies /api/* → http://localhost:3001/api/*
// =============================================================

import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import Groq from "groq-sdk";
import { createClient } from "@supabase/supabase-js";

import { DecisionHarness, tryCreateHarness } from "./harness.js";
import {
  runDiagnosisAgent,
  sanitizeSecret,
  MODEL_FAST,
  MODEL_SMART,
} from "./agents/diagnosisAgent.js";
import { runActionDecisionAgent } from "./agents/actionDecisionAgent.js";
import type { FailedPaymentRecord, DiagnosisResult } from "./types.js";

// ─────────────────────────────────────────────────────────────
// Config & Startup Environment Validation
// ─────────────────────────────────────────────────────────────

const PORT = 3001;

export function validateStartupEnv(): { valid: boolean; missing: string[] } {
  const required = ["SUPABASE_URL", "SUPABASE_KEY", "GROQ_API_KEY"];
  const missing = required.filter((key) => {
    const val = process.env[key];
    return !val || val.includes("your-") || val.includes("placeholder");
  });
  return { valid: missing.length === 0, missing };
}

// Check on startup
const envCheck = validateStartupEnv();
if (!envCheck.valid) {
  console.warn(
    `\n[STARTUP WARNING] Missing or placeholder environment variables: ${envCheck.missing.join(", ")}.\n` +
    `Fork & Replay and live LLM features require valid credentials in harness/.env.\n`
  );
}

// ─────────────────────────────────────────────────────────────
// Harness helper
// ─────────────────────────────────────────────────────────────

function getHarness(): DecisionHarness | null {
  return tryCreateHarness();
}

// ─────────────────────────────────────────────────────────────
// Express app with Security Middleware
// ─────────────────────────────────────────────────────────────

const app = express();

// CORS: allow local Vite dev server and local clients
app.use(cors({ origin: /localhost/ }));

// Body size limit: reject payloads > 10KB (mitigates DoS and huge inputs)
app.use(express.json({ limit: "10kb" }));

// ── Rate Limiter for Replay Endpoint ─────────────────────────
// Max 10 requests per minute per IP to prevent Groq key exhaustion
const replayLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Rate limit exceeded. Maximum 10 replay requests per minute per IP.",
  },
});

// ─────────────────────────────────────────────────────────────
// Input Complexity Guard (depth <= 3, keys <= 50)
// ─────────────────────────────────────────────────────────────

function getObjectComplexity(obj: unknown, depth = 1): { maxDepth: number; totalKeys: number } {
  if (!obj || typeof obj !== "object") return { maxDepth: depth, totalKeys: 0 };
  let maxDepth = depth;
  let totalKeys = 0;

  for (const val of Object.values(obj as Record<string, unknown>)) {
    totalKeys++;
    if (typeof val === "object" && val !== null) {
      const child = getObjectComplexity(val, depth + 1);
      maxDepth = Math.max(maxDepth, child.maxDepth);
      totalKeys += child.totalKeys;
    }
  }
  return { maxDepth, totalKeys };
}

// ─────────────────────────────────────────────────────────────
// GET /api/health — Live Operational Health Check
// ─────────────────────────────────────────────────────────────

app.get("/api/health", async (_req: Request, res: Response) => {
  const t0 = Date.now();
  let supabaseReachable = false;
  let supabaseError: string | null = null;
  let groqReachable = false;
  let groqLatencyMs: number | null = null;
  let groqError: string | null = null;

  // 1. Test Supabase
  const sbUrl = process.env["SUPABASE_URL"];
  const sbKey = process.env["SUPABASE_KEY"];
  if (sbUrl && sbKey && !sbKey.includes("placeholder")) {
    try {
      // Validate live connection and authentication against the Supabase REST gateway
      const ping = await fetch(`${sbUrl}/rest/v1/`, {
        method: "GET",
        headers: {
          apikey: sbKey,
          Authorization: `Bearer ${sbKey}`,
        },
      });

      if (ping.ok) {
        supabaseReachable = true;
      } else {
        supabaseError = `Supabase gateway returned HTTP ${ping.status} (${ping.statusText})`;
      }
    } catch (err) {
      supabaseError = sanitizeSecret((err as Error).message);
    }
  } else {
    supabaseError = "Credentials not configured in .env";
  }

  // 2. Test Groq
  const groqKey = process.env["GROQ_API_KEY"];
  if (groqKey && !groqKey.includes("placeholder")) {
    try {
      const g0 = Date.now();
      const groq = new Groq({ apiKey: groqKey });
      await groq.models.list();
      groqLatencyMs = Date.now() - g0;
      groqReachable = true;
    } catch (err) {
      groqError = sanitizeSecret((err as Error).message);
    }
  } else {
    groqError = "GROQ_API_KEY not configured in .env";
  }

  const isHealthy = supabaseReachable && groqReachable;

  res.status(isHealthy ? 200 : 207).json({
    status: isHealthy ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    total_health_check_ms: Date.now() - t0,
    dependencies: {
      supabase: {
        reachable: supabaseReachable,
        url: sbUrl ? sbUrl.replace(/https:\/\/(.*)\.supabase\.co.*/, "https://$1.supabase.co") : null,
        error: supabaseError,
      },
      groq: {
        reachable: groqReachable,
        latency_ms: groqLatencyMs,
        error: groqError,
      },
    },
    models: {
      fast_model: MODEL_FAST,
      smart_model: MODEL_SMART,
    },
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/replay — Fork & Replay Endpoint
// ─────────────────────────────────────────────────────────────

interface ReplayRequestBody {
  node_id: string;
  agent_name: "diagnosis_agent" | "action_decision_agent" | string;
  modified_input: Record<string, unknown>;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.post("/api/replay", replayLimiter, async (req: Request, res: Response) => {
  const body = req.body as ReplayRequestBody;

  // ── Input Validation ──────────────────────────────────────
  if (!body?.node_id || typeof body.node_id !== "string" || !UUID_REGEX.test(body.node_id)) {
    res.status(400).json({ error: "Invalid node_id: must be a valid UUID format." });
    return;
  }
  if (!body?.agent_name || typeof body.agent_name !== "string") {
    res.status(400).json({ error: "agent_name is required (string)." });
    return;
  }
  if (!body?.modified_input || typeof body.modified_input !== "object" || Array.isArray(body.modified_input)) {
    res.status(400).json({ error: "modified_input is required and must be an object." });
    return;
  }

  // ── Input Complexity Check ────────────────────────────────
  const complexity = getObjectComplexity(body.modified_input);
  if (complexity.maxDepth > 3 || complexity.totalKeys > 50) {
    res.status(400).json({
      error: `modified_input exceeds safe complexity limits (max depth: 3, max keys: 50). Detected depth: ${complexity.maxDepth}, keys: ${complexity.totalKeys}.`,
    });
    return;
  }

  const harness = getHarness();
  if (!harness) {
    res.status(503).json({
      error:
        "Fork & Replay requires a live Supabase connection to fetch the original node and persist the fork. " +
        "Set SUPABASE_URL + SUPABASE_KEY in harness/.env and restart the replay server.",
    });
    return;
  }

  // ── Node Existence Check in DB ─────────────────────────────
  try {
    const originalNode = await harness.getNode(body.node_id);
    if (!originalNode) {
      res.status(404).json({
        error: "Node not found",
        node_id: body.node_id,
        message: "No harness node exists with this ID in the active dataset.",
      });
      return;
    }
  } catch (checkErr) {
    const checkMsg = sanitizeSecret((checkErr as Error).message ?? String(checkErr));
    if (checkMsg.includes("not found") || checkMsg.includes("no data")) {
      res.status(404).json({
        error: "Node not found",
        node_id: body.node_id,
        message: "No harness node exists with this ID in the active dataset.",
      });
      return;
    }
    res.status(500).json({ error: checkMsg });
    return;
  }

  console.log(`[ReplayServer] Fork & Replay request: node_id=${body.node_id} agent=${body.agent_name}`);

  try {
    const mergedInput = body.modified_input;

    const payment: FailedPaymentRecord = {
      id:                   (mergedInput["payment_id"]         as string)  ?? "replay_unknown",
      amount:               (mergedInput["amount_paise"]        as number)  ?? 0,
      currency:             "INR",
      method:               (mergedInput["method"]              as "upi" | "card" | "netbanking" | "wallet") ?? "upi",
      customer_id:          (mergedInput["customer_id"]         as string)  ?? "replay_cust",
      mandate_id:           (mergedInput["mandate_id"]          as string | null) ?? null,
      failure_code:         (mergedInput["failure_code"]        as string)  ?? "UNKNOWN",
      failure_reason_raw:   (mergedInput["failure_reason_raw"]  as string)  ?? "replay input",
      attempt_number:       (mergedInput["attempt_number"]      as number)  ?? 0,
      max_attempts_allowed: (mergedInput["max_attempts_allowed"] as number) ?? 3,
      created_at:           new Date().toISOString(),
    };

    if (body.agent_name === "diagnosis_agent") {
      const replayResult = await harness.replayNode(
        body.node_id,
        mergedInput,
        async (modInput: Record<string, unknown>) => {
          const modifiedPayment: FailedPaymentRecord = {
            ...payment,
            failure_reason_raw: (modInput["failure_reason_raw"] as string) ?? payment.failure_reason_raw,
            failure_code:        (modInput["failure_code"] as string)       ?? payment.failure_code,
          };

          const t0 = Date.now();
          const result: DiagnosisResult = await runDiagnosisAgent(
            new NoOpHarness(),
            body.node_id,
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
      const diagnosisCtx = {
        root_cause:  (mergedInput["root_cause"]           as DiagnosisResult["root_cause"]) ?? "unknown",
        confidence:  (mergedInput["diagnosis_confidence"] as number) ?? 0.0,
        reasoning:   (mergedInput["diagnosis_reasoning"]  as string) ?? "",
      };

      const replayResult = await harness.replayNode(
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
      res.status(400).json({
        error: `Replay not supported for agent_name='${body.agent_name}'. Supported: diagnosis_agent, action_decision_agent.`,
      });
    }

  } catch (err) {
    const message = sanitizeSecret((err as Error).message ?? String(err));
    console.error(`[ReplayServer] ❌ Replay failed for node ${body.node_id}: ${message}`);
    res.status(500).json({ error: message });
  }
});

// ─────────────────────────────────────────────────────────────
// NoOpHarness — suppresses inner agent writes during replay
// ─────────────────────────────────────────────────────────────

class NoOpHarness {
  async recordNode(_params: unknown): Promise<string> {
    return `noop_${Date.now()}`;
  }
  async getRunTrace(_run_id: string) {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n[ReplayServer] ✅ Server running on http://localhost:${PORT}`);
  console.log(`[ReplayServer]    GET  /api/health — Live Dependency & Model Reachability`);
  console.log(`[ReplayServer]    POST /api/replay — Rate-limited Fork & Replay (Max 10 req/min, 10KB body limit)`);
});
