// =============================================================
// batchRunner.ts — Sequential Batch Evaluation Runner
// Revenue Recovery Agent | Razorpay Buildathon MVP
//
// Runs a batch of failed payment records through the complete
// pipeline. Each payment gets its own unique run_id and auditable
// harness DAG trace.
//
// Pure and framework-agnostic.
// =============================================================

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { tryCreateHarness } from "./harness.js";
import type { HarnessLike, HarnessTreeNode, RecordNodeParams } from "./harness.js";
import { runPipeline, createDbClient } from "./pipeline.js";
import type {
  FailedPaymentRecord,
  PipelineResult,
  PipelineConfig,
} from "./types.js";
import { v4 as uuidv4 } from "uuid";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface BatchRecordResult {
  payment: FailedPaymentRecord;
  result: PipelineResult;
  trace: HarnessTreeNode[];
  duration_ms: number;
}

export interface BatchRunOutput {
  total: number;
  results: BatchRecordResult[];
  started_at: string;
  completed_at: string;
  total_duration_ms: number;
}

export interface BatchRunnerOptions {
  harness?: HarnessLike;
  db?: SupabaseClient;
  config?: PipelineConfig;
  onProgress?: (index: number, total: number, payment: FailedPaymentRecord, result: PipelineResult) => void;
}

// ─────────────────────────────────────────────────────────────
// Fallback In-Memory Mock Harness for Batch Runs
// ─────────────────────────────────────────────────────────────

type FlatNode = RecordNodeParams & {
  node_id: string;
  created_at: string;
};

export class BatchMockHarness implements HarnessLike {
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

function createMockDb(): SupabaseClient {
  const noop = () => ({ error: null, data: null });
  return {
    from: () => ({
      select: () => ({ eq: () => ({ single: noop, data: null, error: null }) }),
      update: () => ({ eq: noop }),
      is: () => ({ order: () => ({ limit: noop }) }),
    }),
  } as unknown as SupabaseClient;
}

// ─────────────────────────────────────────────────────────────
// Batch Execution Engine
// ─────────────────────────────────────────────────────────────

/**
 * Runs a batch of failed payments through the pipeline sequentially.
 *
 * @param paymentRecords - Array of failed payment records to process
 * @param options        - Harness, DB client, progress callback, and pipeline config
 * @returns BatchRunOutput containing per-record results and timing
 */
export async function runBatch(
  paymentRecords: FailedPaymentRecord[],
  options: BatchRunnerOptions = {}
): Promise<BatchRunOutput> {
  const tStart = Date.now();
  const started_at = new Date(tStart).toISOString();

  // Initialize or fallback harness and db
  let harness: HarnessLike;
  let db: SupabaseClient;

  if (options.harness && options.db) {
    harness = options.harness;
    db = options.db;
  } else {
    const realHarness = tryCreateHarness();
    const realDb = createDbClient();
    let verifiedReal = false;

    if (realHarness && realDb) {
      try {
        const { error } = await realDb.from("failed_payments").select("id").limit(1);
        if (!error) verifiedReal = true;
      } catch {
        verifiedReal = false;
      }
    }

    if (verifiedReal && realHarness && realDb) {
      harness = realHarness;
      db = realDb;
    } else {
      harness = new BatchMockHarness();
      db = createMockDb();
    }
  }

  const results: BatchRecordResult[] = [];

  for (let i = 0; i < paymentRecords.length; i++) {
    const payment = paymentRecords[i];
    const recStart = Date.now();

    const pipelineResult = await runPipeline(
      harness,
      db,
      payment,
      options.config ?? { execution: { forceOutcome: "success" } }
    );

    const trace = await harness.getRunTrace(pipelineResult.run_id);
    const duration_ms = Date.now() - recStart;

    const recordResult: BatchRecordResult = {
      payment,
      result: pipelineResult,
      trace,
      duration_ms,
    };

    results.push(recordResult);

    if (options.onProgress) {
      options.onProgress(i + 1, paymentRecords.length, payment, pipelineResult);
    }
  }

  const tEnd = Date.now();
  const completed_at = new Date(tEnd).toISOString();

  return {
    total: paymentRecords.length,
    results,
    started_at,
    completed_at,
    total_duration_ms: tEnd - tStart,
  };
}
