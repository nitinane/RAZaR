# PRD — Revenue Recovery Agent with Auditable Decision Harness

**Track:** Razorpay Buildathon — Track 03, AI Revenue Recovery
**Author:** Nitin
**Status:** Build spec for hackathon MVP (deadline Sept 5)

---

## 1. Problem

Revenue leaks in payment systems rarely happen in one clean step — a UPI payment fails silently, a card gets declined, a subscription mandate lapses, an invoice goes unpaid. Merchants lose this money not because it's unrecoverable, but because:

- Root cause is rarely diagnosed (a "failed payment" could be bank timeout, insufficient funds, expired mandate, or gateway error — each needs a different fix)
- Recovery actions are either not attempted, attempted blindly (retry-storming), or attempted without bounds/stopping rules
- There is no audit trail showing *why* the agent took an action, making these systems unsafe to trust with real money in production

The buildathon's own bar makes this explicit: agents must show "measured money recovered across a batch, with compliant escalation, stopping rules, and an audit trail." Most teams will build the recovery agent and treat the audit trail as an afterthought (a logs table). That is the gap this project targets.

## 2. Solution

A two-layer system:

1. **Recovery Agent Pipeline** — classifies why a payment/invoice is at risk, decides a bounded recovery action, executes it against Razorpay test-mode APIs, and enforces stopping rules.
2. **Decision Harness** — every agent step is logged as a node in a DAG (input → decision → output → confidence). Any node can be selectively replayed with modified input, in isolation, without re-running the full pipeline — with measured compute/cost savings shown live.

The harness is the differentiator: it turns "trust me, the agent is safe" into "click here and verify it yourself."

## 3. Primary Scenario (MVP scope)

**Payment degradation → root cause → recovery.**

Input: a failed payment record (amount, method, failure code/reason, customer/mandate context).
Output: root cause classification, chosen recovery action, execution result, and a full decision trace.

Stretch (only if time remains): failed-subscription/mandate retry sequencing (same pipeline, different action space).

## 4. Agent Crew

| Agent | Type | Model | Role |
|---|---|---|---|
| Pre-Classifier | Deterministic (rules/regex) | none | Fast pass on known failure codes (e.g. exact bank error strings). No LLM call if confident. |
| Diagnosis Agent | LLM | Groq `llama-3.1-8b-instant` | Reasons over ambiguous failure context to determine root cause category. |
| Diagnosis Escalation | LLM | Groq `llama-3.3-70b-versatile` | Invoked only when 8B confidence is low; deeper reasoning on root cause. |
| Action-Decision Agent | LLM | Groq `llama-3.1-8b-instant` (escalate to 70B on ambiguity) | Given root cause + policy constraints (max retries, allowed channels, spend caps), picks bounded recovery action. |
| Execution Agent | Deterministic | none | Calls Razorpay test-mode API to execute the action (retry, notify, etc). No model involved — pure code, must be deterministic for safety. |
| Stop-Rule Guard | Deterministic | none | Enforces max attempts / policy limits; halts loop and logs exception if breached. |
| Harness Recorder | Cross-cutting middleware | none | Wraps every agent call above; writes node (input, output, decision, confidence, latency, cost) to the DAG store. Not part of the business pipeline — it observes it. |

All LLM outputs are schema-validated (Zod or equivalent) before being consumed downstream — never parse free text directly into an action.

## 5. Agentic Flow

```
Failed Payment Record
        │
        ▼
 [Pre-Classifier] ──confident──► known root cause ─┐
        │ low confidence                            │
        ▼                                            │
 [Diagnosis Agent - 8B]                               │
        │ low confidence                              │
        ▼                                              │
 [Diagnosis Escalation - 70B]                            │
        │                                                │
        └──────────────► root cause ◄────────────────────┘
                              │
                              ▼
                  [Action-Decision Agent]
                    (policy-bounded choice:
                     retry / alt-method / notify / escalate-to-human)
                              │
                              ▼
                     [Stop-Rule Guard]
                    (check attempt count,
                     spend cap, policy)
                     │pass          │fail
                     ▼              ▼
              [Execution Agent]  [Log exception,
              (Razorpay test-      halt, mark for
               mode API call)      human review]
                     │
                     ▼
              Outcome recorded
                     │
                     ▼
        [Harness Recorder] writes every
        step above as a DAG node with
        input/output/decision/confidence
```

Every arrow above is a node write to the harness — this is what enables replay.

## 6. Harness — Design Detail

**Data model (per node):**
```json
{
  "node_id": "uuid",
  "run_id": "uuid (batch run this belongs to)",
  "parent_node_id": "uuid | null",
  "agent_name": "diagnosis_agent",
  "model_used": "llama-3.1-8b-instant | none",
  "input": { "...": "..." },
  "output": { "...": "..." },
  "confidence": 0.0,
  "escalated": false,
  "latency_ms": 0,
  "cost_estimate": 0.0,
  "timestamp": "iso8601"
}
```

**Replay mechanic:** given a `node_id`, re-run only that node with a modified input (same or overridden), producing a new node with the same `parent_node_id` — a fork, not a mutation. The UI shows both branches side by side. This is what proves "selective replay saves compute" — measure and display: full-pipeline cost vs. single-node replay cost.

**Storage:** Postgres (Supabase) table `harness_nodes`, indexed by `run_id` and `parent_node_id` for fast DAG reconstruction.

## 7. Batch Evaluation (satisfies track bar)

- Seed 50+ synthetic failed-payment records covering all root-cause categories (bank timeout, insufficient funds, expired mandate, gateway error, unknown).
- Run the full pipeline over the batch once, store all traces.
- Report, honestly:
  - Recovery rate (successfully resolved / total)
  - False-positive cost (cases where agent acted but shouldn't have — e.g. retried a permanently-failed payment, wasting an attempt)
  - Escalation rate (8B → 70B, and action-decision → human)
  - Unresolved exceptions (hit stop-rule, need human review) — list them, don't hide them

## 8. Tech Stack

- **Frontend:** React + Vite + TypeScript — batch dashboard + DAG/replay viewer
- **Backend:** Node.js + TypeScript
- **DB:** Supabase/Postgres — stores payment records, harness nodes, batch run metadata
- **Payments:** Razorpay test-mode APIs (payment retry/status endpoints)
- **Inference:** Groq API — dual-model routing (`llama-3.1-8b-instant`, `llama-3.3-70b-versatile`), rotating key pool with retry-on-429
- **Validation:** Zod schemas on every LLM output before downstream use
- **Notifications (stretch):** Telegram or email for customer-facing recovery nudges

## 9. Demo Script (3 minutes)

1. Show batch dashboard: 50+ records, recovery rate, false-positive cost, exceptions list (10s)
2. Click into one resolved case → show the DAG for that case (20s)
3. Click a node (e.g. Diagnosis Agent) → show input/output/confidence (20s)
4. Fork that node with modified input → replay → show diverging outcome + compute-saved number vs. full re-run (40s)
5. Show one case that hit the stop-rule guard and was correctly escalated to human review, not silently retried forever (20s)
6. Close: "Every other team can show you money recovered. We can show you why the agent was right to recover it — and let you re-check that decision yourself, live." (10s)

## 10. Explicit Non-Goals (for scope discipline)

- No real government/external fraud data sources (I4C, DoT FRI) — out of scope, not needed for this track
- No live production Razorpay keys — test mode only
- No multi-tenant / auth system — single demo merchant context is enough
- No mobile app — web dashboard only
