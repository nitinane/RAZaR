// =============================================================
// harness.ts — Auditable Decision Harness
// Revenue Recovery Agent | Razorpay Buildathon MVP
//
// Framework-agnostic observability + replay layer.
// No agent logic, no LLM calls — purely records, reconstructs,
// and replays pipeline steps stored in Supabase/Postgres.
// =============================================================

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";

// ─────────────────────────────────────────────────────────────
// 1. Zod Schemas
// ─────────────────────────────────────────────────────────────

/**
 * Schema for the params passed to recordNode().
 * All fields are validated before the DB insert.
 */
export const RecordNodeParamsSchema = z.object({
  /** UUID of the pipeline run this node belongs to. */
  run_id: z.string().uuid(),

  /** UUID of the parent node; null for the root node of a run. */
  parent_node_id: z.string().uuid().nullable().default(null),

  /** Logical agent name, e.g. "pre_classifier", "diagnosis_agent". */
  agent_name: z.string().min(1),

  /** LLM model identifier, e.g. "llama-3.1-8b-instant". Null for deterministic agents. */
  model_used: z.string().nullable().default(null),

  /** Full input payload that was passed to the agent. */
  input: z.record(z.string(), z.unknown()),

  /** Full output payload returned by the agent. */
  output: z.record(z.string(), z.unknown()),

  /** Agent's self-reported confidence (0.0–1.0). Null if not applicable. */
  confidence: z.number().min(0).max(1).nullable().default(null),

  /** Whether this node triggered an escalation. */
  escalated: z.boolean().default(false),

  /** Wall-clock duration the agent took, in milliseconds. */
  latency_ms: z.number().int().nonnegative(),

  /** Estimated USD cost for this node (token cost for LLMs). Null if unknown. */
  cost_estimate: z.number().nonnegative().nullable().default(null),

  // Internal — set by replayNode(), callers should not set this directly.
  is_replay: z.boolean().default(false),
  replayed_from: z.string().uuid().nullable().default(null),
});

export type RecordNodeParams = z.infer<typeof RecordNodeParamsSchema>;

/**
 * A single row from harness_nodes, as returned by the DB.
 */
export interface HarnessNode {
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
}

/**
 * A node enriched with its children — used for tree output.
 */
export interface HarnessTreeNode extends HarnessNode {
  children: HarnessTreeNode[];
}

/**
 * Return type of replayNode() — original + new fork for side-by-side comparison.
 */
export interface ReplayResult {
  original: HarnessNode;
  replay: HarnessNode;
}

/**
 * Minimal structural interface agents depend on.
 * Both DecisionHarness (real) and MockHarness (test) satisfy this.
 * Agents import HarnessLike — never the concrete class — so they remain
 * testable without a Supabase connection.
 */
export interface HarnessLike {
  recordNode(params: RecordNodeParams): Promise<string>;
  getRunTrace(run_id: string): Promise<HarnessTreeNode[]>;
}

// ─────────────────────────────────────────────────────────────
// 2. Harness class
// ─────────────────────────────────────────────────────────────

export class DecisionHarness {
  private readonly db: SupabaseClient;
  private readonly TABLE = "harness_nodes";

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.db = createClient(supabaseUrl, supabaseKey);
  }

  // ── 2a. recordNode ─────────────────────────────────────────

  /**
   * Validates params with Zod BEFORE inserting — throws a clear, named error
   * on validation failure so silent bad data never reaches the DB.
   *
   * @throws {Error} with prefix "[Harness] Validation failed"  on bad params
   * @throws {Error} with prefix "[Harness] recordNode failed"  on DB error
   */
  async recordNode(rawParams: RecordNodeParams): Promise<string> {
    // ── Validate first — never reach the DB with bad data ──────
    let params: RecordNodeParams;
    try {
      params = RecordNodeParamsSchema.parse(rawParams);
    } catch (err) {
      if (err instanceof z.ZodError) {
        const issues = err.issues
          .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
          .join("\n");
        throw new Error(
          `[Harness] Validation failed for agent "${rawParams.agent_name ?? "<unknown>"}":\n${issues}`
        );
      }
      throw err; // re-throw non-Zod errors unchanged
    }

    const node_id = uuidv4();

    const row = {
      node_id,
      run_id: params.run_id,
      parent_node_id: params.parent_node_id,
      agent_name: params.agent_name,
      model_used: params.model_used,
      input: params.input,
      output: params.output,
      confidence: params.confidence,
      escalated: params.escalated,
      latency_ms: params.latency_ms,
      cost_estimate: params.cost_estimate,
      is_replay: params.is_replay,
      replayed_from: params.replayed_from,
      // created_at defaults to NOW() in Postgres
    };

    const { error } = await this.db.from(this.TABLE).insert(row);

    if (error) {
      throw new Error(
        `[Harness] recordNode failed for agent "${params.agent_name}": ${error.message}`
      );
    }

    return node_id;
  }

  // ── 2b. getRunTrace ────────────────────────────────────────

  /**
   * Fetches all nodes for a run_id and reconstructs them as a
   * tree rooted at nodes where parent_node_id IS NULL.
   *
   * Nodes are sorted by created_at ascending before tree assembly.
   * Replay forks appear as siblings of the original node (same parent).
   *
   * @returns Array of root HarnessTreeNode objects (usually just one root).
   */
  async getRunTrace(run_id: string): Promise<HarnessTreeNode[]> {
    const { data, error } = await this.db
      .from(this.TABLE)
      .select("*")
      .eq("run_id", run_id)
      .order("created_at", { ascending: true });

    if (error) {
      throw new Error(`[Harness] getRunTrace failed for run "${run_id}": ${error.message}`);
    }

    const nodes = (data ?? []) as HarnessNode[];
    return buildTree(nodes);
  }

  /**
   * Fetches a single node by node_id from Supabase.
   * Returns null if not found.
   */
  async getNode(node_id: string): Promise<HarnessNode | null> {
    const { data, error } = await this.db
      .from(this.TABLE)
      .select("*")
      .eq("node_id", node_id)
      .maybeSingle();

    if (error || !data) return null;
    return data as HarnessNode;
  }

  // ── 2c. replayNode ─────────────────────────────────────────

  /**
   * Fetches the original node by node_id, calls replayFn(modifiedInput)
   * to obtain a new output, then writes a *sibling* node (same parent_node_id)
   * tagged as is_replay=true with replayed_from pointing at the original.
   *
   * The original node is NEVER mutated. Each call to replayNode() creates a
   * NEW sibling fork — calling it twice on the same node produces two
   * independent siblings, not overwrites.
   *
   * ── replayFn is a generic seam ──────────────────────────────────────────
   * replayFn receives the (possibly modified) input and must return the new
   * output alongside observability fields. The harness has zero knowledge of
   * what the function does — it could call an LLM, run a deterministic rule,
   * return a hardcoded fixture, or call a mock. Future agents plug in here.
   *
   * @param node_id       - UUID of the node to fork
   * @param modifiedInput - New input to pass to replayFn (can be identical
   *                        to the original, or fully overridden)
   * @param replayFn      - ANY async function that accepts
   *                        Record<string, unknown> and returns ReplayFnResult.
   *                        The harness never inspects or validates its internals.
   *
   * @returns { original, replay } — both nodes for side-by-side comparison
   */
  async replayNode(
    node_id: string,
    modifiedInput: Record<string, unknown>,
    replayFn: (input: Record<string, unknown>) => Promise<ReplayFnResult>
  ): Promise<ReplayResult> {
    // 1. Fetch the original node
    const { data, error } = await this.db
      .from(this.TABLE)
      .select("*")
      .eq("node_id", node_id)
      .single();

    if (error || !data) {
      throw new Error(
        `[Harness] replayNode: node "${node_id}" not found — ${error?.message ?? "no data"}`
      );
    }

    const original = data as HarnessNode;

    // 2. Call the caller-supplied replay function with the modified input
    const result = await replayFn(modifiedInput);

    // 3. Write a sibling node — same run_id, same parent, tagged as replay
    const replayNodeId = await this.recordNode({
      run_id: original.run_id,
      parent_node_id: original.parent_node_id,     // <-- sibling, not child
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

    // 4. Fetch the newly created replay node for the caller
    const { data: replayData, error: replayErr } = await this.db
      .from(this.TABLE)
      .select("*")
      .eq("node_id", replayNodeId)
      .single();

    if (replayErr || !replayData) {
      throw new Error(
        `[Harness] replayNode: failed to fetch replay node "${replayNodeId}"`
      );
    }

    return {
      original,
      replay: replayData as HarnessNode,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// 3. ReplayFnResult type (what callers return from their replayFn)
// ─────────────────────────────────────────────────────────────

/**
 * What the caller-supplied replayFn must return.
 * The harness uses these values to build the sibling node.
 */
export interface ReplayFnResult {
  /** New output produced by the replayed logic. */
  output: Record<string, unknown>;
  /** Wall-clock time for the replay execution. */
  latency_ms: number;
  /** Optional: confidence from the replayed run. */
  confidence?: number | null;
  /** Optional: estimated USD cost of the replay. */
  cost_estimate?: number | null;
  /** Optional: model used in the replay (may differ from original). */
  model_used?: string | null;
  /** Optional: whether the replay triggered escalation. */
  escalated?: boolean;
}

// ─────────────────────────────────────────────────────────────
// 4. costSavedEstimate helper
// ─────────────────────────────────────────────────────────────

/**
 * Returns the cost difference between the original node and a replay node.
 *
 * A positive value means the replay cost MORE than the original.
 * A negative value means the replay was CHEAPER (common for selective replay
 * vs. re-running the full pipeline from scratch).
 *
 * Use the absolute value when displaying "replay saved X compute":
 *   Math.abs(costSavedEstimate(original, replay))
 *
 * @example
 *   const saved = costSavedEstimate(fullPipelineCostProxy, replayNode);
 *   // saved < 0  →  |saved| USD saved by replaying only this node
 */
export function costSavedEstimate(
  originalNode: Pick<HarnessNode, "cost_estimate">,
  replayNode: Pick<HarnessNode, "cost_estimate">
): number {
  const original = originalNode.cost_estimate ?? 0;
  const replay = replayNode.cost_estimate ?? 0;
  // Positive = original was more expensive (replay saved money)
  return original - replay;
}

// ─────────────────────────────────────────────────────────────
// 5. Internal tree-builder utility
// ─────────────────────────────────────────────────────────────

/**
 * Takes a flat list of HarnessNode rows (already sorted by created_at)
 * and builds a forest (array of roots) with each node's children attached.
 */
function buildTree(nodes: HarnessNode[]): HarnessTreeNode[] {
  const map = new Map<string, HarnessTreeNode>();
  const roots: HarnessTreeNode[] = [];

  // First pass: wrap every node with an empty children array
  for (const node of nodes) {
    map.set(node.node_id, { ...node, children: [] });
  }

  // Second pass: attach each node to its parent (or to roots)
  for (const node of nodes) {
    const treeNode = map.get(node.node_id)!;
    if (node.parent_node_id && map.has(node.parent_node_id)) {
      map.get(node.parent_node_id)!.children.push(treeNode);
    } else {
      roots.push(treeNode);
    }
  }

  return roots;
}

// ─────────────────────────────────────────────────────────────
// 6. Factory helper — convenient one-liner for callers
// ─────────────────────────────────────────────────────────────

/**
 * Creates a DecisionHarness from environment variables.
 * Throws if SUPABASE_URL or SUPABASE_KEY are missing.
 *
 * Expected env vars:
 *   SUPABASE_URL  — your project's Supabase REST URL
 *   SUPABASE_KEY  — service-role or anon key
 */
export function createHarness(): DecisionHarness {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_KEY"];

  if (!url || !key) {
    throw new Error(
      "[Harness] Missing env vars: SUPABASE_URL and SUPABASE_KEY must be set."
    );
  }

  return new DecisionHarness(url, key);
}

/**
 * Soft variant of createHarness().
 *
 * Returns a DecisionHarness when env vars are present, or null when they are
 * missing — printing a console.warn instead of throwing. Use this in scripts
 * that want to fall back to an in-memory mock for local dev without crashing.
 *
 * @example
 *   const harness = tryCreateHarness() ?? new MockHarness();
 */
export function tryCreateHarness(): DecisionHarness | null {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_KEY"];

  if (!url || !key) {
    console.warn(
      "[Harness] ⚠  SUPABASE_URL and/or SUPABASE_KEY not set. " +
      "Returning null — caller should fall back to in-memory mock for local dev."
    );
    return null;
  }

  return new DecisionHarness(url, key);
}
