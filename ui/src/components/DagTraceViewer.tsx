import React, { useState } from 'react';
import {
  ArrowLeft,
  GitFork,
  ChevronDown,
  ChevronRight,
  Cpu,
  CheckCircle2,
  Clock,
  UserCheck,
  AlertOctagon,
  DollarSign,
  Layers,
  X,
  Play,
  RotateCcw
} from 'lucide-react';
import type { EvalPaymentRecord, HarnessTreeNode, AgentOutcome } from '../types';

interface DagTraceViewerProps {
  record: EvalPaymentRecord;
  onBack: () => void;
}

// Mirrors the HarnessNode shape returned by POST /api/replay
interface ReplayHarnessNode {
  node_id: string;
  run_id: string;
  parent_node_id: string | null;
  agent_name: string;
  model_used: string | null;
  input: Record<string, any>;
  output: Record<string, any>;
  confidence: number | null;
  escalated: boolean;
  latency_ms: number;
  cost_estimate: number | null;
  is_replay: boolean;
  replayed_from: string | null;
  created_at: string;
}

interface ReplayResult {
  original: ReplayHarnessNode;
  replay: ReplayHarnessNode;
  // Derived fields computed in the UI from original + replay
  cost_saved_usd: number;
  cost_saved_pct: number;
}

export const DagTraceViewer: React.FC<DagTraceViewerProps> = ({ record, onBack }) => {
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = useState<Record<string, 'output' | 'input'>>({});
  
  // Fork & Replay state
  const [forkingNode, setForkingNode] = useState<HarnessTreeNode | null>(null);
  const [editedInputText, setEditedInputText] = useState<string>('');
  const [replayState, setReplayState] = useState<Record<string, ReplayResult>>({});
  const [isReplaying, setIsReplaying] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);

  const toggleExpand = (nodeId: string) => {
    setExpandedNodes((prev) => ({ ...prev, [nodeId]: !prev[nodeId] }));
  };

  const setNodeTab = (nodeId: string, tab: 'output' | 'input') => {
    setActiveTab((prev) => ({ ...prev, [nodeId]: tab }));
  };

  const formatInr = (paise: number) => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 2,
    }).format(paise / 100);
  };

  const getOutcomeBadge = (outcome: AgentOutcome) => {
    switch (outcome) {
      case 'resolved':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
            <CheckCircle2 className="w-4 h-4" />
            <span>Resolved</span>
          </span>
        );
      case 'notify_customer_pending':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/30">
            <Clock className="w-4 h-4" />
            <span>Notify Customer Pending</span>
          </span>
        );
      case 'escalated_to_human':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30">
            <UserCheck className="w-4 h-4" />
            <span>Escalated to Human</span>
          </span>
        );
      case 'stop_rule_hit':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/30">
            <AlertOctagon className="w-4 h-4" />
            <span>Stop-Rule Guard Hit</span>
          </span>
        );
      default:
        return <span className="text-xs text-slate-400">{outcome}</span>;
    }
  };

  // Flatten the tree into an array of linear/DAG paths
  const flattenNodes = (nodes: HarnessTreeNode[]): HarnessTreeNode[] => {
    const list: HarnessTreeNode[] = [];
    const traverse = (nodeList: HarnessTreeNode[]) => {
      for (const node of nodeList) {
        list.push(node);
        if (node.children && node.children.length > 0) {
          traverse(node.children);
        }
      }
    };
    traverse(nodes);
    return list;
  };

  const flatNodes = flattenNodes(record.trace);

  // Handle open Fork & Replay dialog
  const handleOpenFork = (node: HarnessTreeNode) => {
    setForkingNode(node);
    // Pre-populate with the failure_reason_raw or input JSON
    if (node.input.failure_reason_raw) {
      setEditedInputText(node.input.failure_reason_raw);
    } else {
      setEditedInputText(JSON.stringify(node.input, null, 2));
    }
  };

  // Real Fork & Replay — calls the backend replayServer (POST /api/replay)
  // which runs the REAL agent (runDiagnosisAgent / runActionDecisionAgent)
  // against the live Groq API and persists the sibling fork via harness.replayNode().
  const handleExecuteReplay = async () => {
    if (!forkingNode) return;
    setIsReplaying(true);
    setReplayError(null);

    // Build modified_input: merge original node input with the user's edited text.
    // If the textarea contains plain text (not JSON), treat it as the new failure_reason_raw.
    // If it contains valid JSON, merge it over the original input.
    let modifiedInput: Record<string, any> = { ...forkingNode.input };
    try {
      const parsed = JSON.parse(editedInputText);
      if (parsed && typeof parsed === 'object') {
        modifiedInput = { ...modifiedInput, ...parsed };
      } else {
        modifiedInput.failure_reason_raw = editedInputText;
      }
    } catch {
      // Not JSON — treat as a plain failure_reason_raw override
      modifiedInput.failure_reason_raw = editedInputText;
    }

    try {
      const resp = await fetch('/api/replay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          node_id: forkingNode.node_id,
          agent_name: forkingNode.agent_name,
          modified_input: modifiedInput,
        }),
      });

      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(errBody.error ?? `Server returned ${resp.status}`);
      }

      const data: { ok: boolean; original: ReplayHarnessNode; replay: ReplayHarnessNode } = await resp.json();

      // Compute cost comparison
      const origCost = data.original.cost_estimate ?? 0;
      const replayCost = data.replay.cost_estimate ?? 0;
      const costSaved = origCost - replayCost;
      const costSavedPct = origCost > 0 ? Math.round((costSaved / origCost) * 100) : 0;

      const replayResult: ReplayResult = {
        original: data.original,
        replay: data.replay,
        cost_saved_usd: costSaved,
        cost_saved_pct: costSavedPct,
      };

      setReplayState((prev) => ({
        ...prev,
        [forkingNode.node_id]: replayResult,
      }));
      setForkingNode(null);
    } catch (err) {
      setReplayError((err as Error).message ?? String(err));
    } finally {
      setIsReplaying(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-6xl mx-auto pb-16">
      
      {/* Top Bar: Back & Overview */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="flex items-start gap-4">
          <button
            onClick={onBack}
            className="mt-1 p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
            title="Back to Dashboard"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="font-mono text-xl font-bold text-slate-100">{record.payment_id}</span>
              <span className="font-mono text-lg font-bold text-emerald-400">{formatInr(record.amount)}</span>
              <span className="px-2.5 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-xs uppercase border border-slate-700">
                {record.method}
              </span>
              {getOutcomeBadge(record.pipeline.agent_outcome)}
            </div>
            <div className="mt-2 text-xs font-mono text-slate-400 flex flex-wrap items-center gap-x-4 gap-y-1">
              <span>Run ID: <code className="text-teal-400">{record.pipeline.run_id}</code></span>
              <span>Attempt: <code className="text-slate-200">{record.attempt_number}</code></span>
              <span>True Root Cause: <code className="text-purple-300">{record.true_root_cause}</code></span>
            </div>
            <div className="mt-2 text-xs text-slate-300 font-mono bg-slate-950/80 px-3 py-1.5 rounded-lg border border-slate-800 inline-block">
              Raw failure: "{record.failure_reason_raw}"
            </div>
          </div>
        </div>

        <div className="flex flex-col items-start md:items-end gap-1.5 shrink-0 bg-slate-950/60 p-4 rounded-xl border border-slate-800">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Decision Path
          </div>
          <div className="text-xs text-slate-300 max-w-sm text-left md:text-right font-mono leading-relaxed">
            {record.pipeline.decision_path}
          </div>
        </div>
      </div>

      {/* DAG Flow Section */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-xl">
        <div className="flex items-center justify-between pb-6 border-b border-slate-800 mb-8">
          <div>
            <div className="flex items-center gap-2">
              <Layers className="w-5 h-5 text-teal-400" />
              <h3 className="text-lg font-bold text-slate-100 tracking-tight">Auditable Decision DAG Trace</h3>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Hierarchical nodes recorded at every step in the decision harness.
            </p>
          </div>

          <div className="text-xs font-mono text-slate-400">
            {flatNodes.length} harness nodes recorded
          </div>
        </div>

        {/* Vertical DAG Tree */}
        <div className="flex flex-col items-center gap-4">
          {flatNodes.map((node, index) => {
            const isExpanded = expandedNodes[node.node_id] ?? false;
            const currentTab = activeTab[node.node_id] ?? 'output';
            const replayBranch = replayState[node.node_id];
            const isCanFork = node.agent_name === 'diagnosis_agent' || node.agent_name === 'action_decision_agent';

            return (
              <React.Fragment key={node.node_id}>
                
                {/* Arrow connector between nodes */}
                {index > 0 && (
                  <div className="flex flex-col items-center my-0.5">
                    <div className="w-0.5 h-6 bg-slate-700"></div>
                    <ChevronDown className="w-4 h-4 text-slate-500 -mt-1" />
                  </div>
                )}

                {/* Node Row (Supports Sibling Replay Branch side-by-side) */}
                <div className="w-full flex flex-col lg:flex-row items-stretch justify-center gap-6">
                  
                  {/* Original Node Card */}
                  <div
                    className={`w-full max-w-2xl bg-slate-950 border rounded-xl overflow-hidden transition-all shadow-md ${
                      node.escalated
                        ? 'border-purple-500/50 hover:border-purple-400'
                        : 'border-slate-800 hover:border-teal-500/50'
                    }`}
                  >
                    {/* Node Header */}
                    <div className="p-4 bg-slate-900/60 flex items-center justify-between gap-4 border-b border-slate-800/80">
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold font-mono ${
                            node.agent_name === 'pre_classifier'
                              ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                              : node.agent_name === 'diagnosis_agent'
                              ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                              : node.agent_name === 'stop_rule_guard'
                              ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                              : node.agent_name === 'action_decision_agent'
                              ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                              : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          }`}
                        >
                          {index + 1}
                        </div>

                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-sm text-slate-100 font-mono">
                              {node.agent_name}
                            </span>
                            {node.model_used && (
                              <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-purple-950/70 text-purple-300 border border-purple-800/50 flex items-center gap-1">
                                <Cpu className="w-3 h-3" />
                                <span>{node.model_used}</span>
                              </span>
                            )}
                            {node.escalated && (
                              <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30 animate-pulse">
                                ESCALATED
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] font-mono text-slate-400 mt-0.5 flex items-center gap-3">
                            <span>ID: <code className="text-slate-300">{node.node_id.slice(0, 8)}</code></span>
                            {node.confidence !== null && (
                              <span>Conf: <code className="text-emerald-400 font-semibold">{Math.round(node.confidence * 100)}%</code></span>
                            )}
                            <span>Latency: <code className="text-slate-300">{node.latency_ms}ms</code></span>
                            {node.cost_estimate !== null && (
                              <span>Cost: <code className="text-slate-300">${node.cost_estimate.toFixed(5)}</code></span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Header Actions */}
                      <div className="flex items-center gap-2">
                        {isCanFork && !replayBranch && (
                          <button
                            onClick={() => handleOpenFork(node)}
                            className="px-2.5 py-1.5 rounded-lg bg-teal-500/10 hover:bg-teal-500/20 text-teal-300 border border-teal-500/30 hover:border-teal-500/50 text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
                            title="Fork this node with modified input to test what-if scenarios"
                          >
                            <GitFork className="w-3.5 h-3.5" />
                            <span>Fork & Replay</span>
                          </button>
                        )}

                        <button
                          onClick={() => toggleExpand(node.node_id)}
                          className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
                          title={isExpanded ? 'Collapse JSON' : 'Expand full JSON'}
                        >
                          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    {/* Summary output pill */}
                    <div className="p-3.5 bg-slate-950/80 text-xs font-mono text-slate-300 border-b border-slate-800/40 flex flex-wrap gap-x-4 gap-y-1 items-center justify-between">
                      <div className="text-slate-300">
                        {node.agent_name === 'pre_classifier' && (
                          <span>
                            {node.output.confident ? '✔ Confident match' : '✘ Ambiguous'} → root cause: <strong className="text-teal-300">{node.output.root_cause || 'none'}</strong>
                          </span>
                        )}
                        {node.agent_name === 'diagnosis_agent' && (
                          <span>
                            Diagnosed: <strong className="text-purple-300">{node.output.root_cause}</strong> ({Math.round((node.output.confidence || 0) * 100)}% conf)
                          </span>
                        )}
                        {node.agent_name === 'stop_rule_guard' && (
                          <span>
                            Safety Guard: <strong className={node.output.allowed ? 'text-emerald-400' : 'text-rose-400'}>{node.output.allowed ? 'PASSED' : 'BLOCKED'}</strong>
                          </span>
                        )}
                        {node.agent_name === 'action_decision_agent' && (
                          <span>
                            Action: <strong className="text-amber-300">{node.output.action}</strong>
                            {node.output.policy_overridden && <span className="ml-2 text-rose-400 font-semibold">[POLICY OVERRIDE]</span>}
                          </span>
                        )}
                        {node.agent_name === 'execution_agent' && (
                          <span>
                            Executed: <strong className="text-emerald-400">{node.output.action}</strong> → outcome: <strong className="text-slate-200">{node.output.outcome}</strong>
                          </span>
                        )}
                      </div>

                      <div className="text-[11px] text-slate-500 italic">
                        {node.output.reasoning ? `"${node.output.reasoning.slice(0, 70)}…"` : ''}
                      </div>
                    </div>

                    {/* Expandable JSON details */}
                    {isExpanded && (
                      <div className="p-4 bg-slate-950 border-t border-slate-800">
                        <div className="flex items-center gap-2 mb-3 border-b border-slate-800/60 pb-2">
                          <button
                            onClick={() => setNodeTab(node.node_id, 'output')}
                            className={`px-3 py-1 rounded-md text-xs font-mono font-medium transition-colors ${
                              currentTab === 'output'
                                ? 'bg-teal-500/20 text-teal-300 border border-teal-500/40'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            Output JSON
                          </button>
                          <button
                            onClick={() => setNodeTab(node.node_id, 'input')}
                            className={`px-3 py-1 rounded-md text-xs font-mono font-medium transition-colors ${
                              currentTab === 'input'
                                ? 'bg-teal-500/20 text-teal-300 border border-teal-500/40'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            Input JSON
                          </button>
                        </div>

                        <pre className="p-3 bg-slate-900 rounded-lg text-slate-300 font-mono text-xs overflow-x-auto border border-slate-800/80">
                          {JSON.stringify(
                            currentTab === 'output' ? node.output : node.input,
                            null,
                            2
                          )}
                        </pre>
                      </div>
                    )}
                  </div>

                  {/* Sibling Replay Branch Card — rendered when Fork & Replay completes */}
                  {replayBranch && (
                    <div className="w-full max-w-2xl bg-slate-950 border-2 border-dashed border-teal-400/80 rounded-xl overflow-hidden shadow-xl shadow-teal-500/10 animate-fade-in">
                      {/* Replay Header */}
                      <div className="p-4 bg-teal-950/40 flex items-center justify-between gap-4 border-b border-teal-900/60">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-teal-500/20 text-teal-300 border border-teal-500/40 flex items-center justify-center font-bold font-mono text-xs">
                            <GitFork className="w-4 h-4" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-sm text-teal-200 font-mono">
                                {replayBranch.replay.agent_name}
                              </span>
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-teal-400 text-slate-950 uppercase tracking-wide">
                                LIVE REPLAY
                              </span>
                            </div>
                            <div className="text-[11px] font-mono text-slate-400 mt-0.5 flex items-center gap-3">
                              <span>Model: <code className="text-purple-300">{replayBranch.replay.model_used ?? 'n/a'}</code></span>
                              {replayBranch.replay.confidence !== null && (
                                <span>Conf: <code className="text-emerald-400">{Math.round((replayBranch.replay.confidence ?? 0) * 100)}%</code></span>
                              )}
                              <span>Latency: <code className="text-slate-300">{replayBranch.replay.latency_ms}ms</code></span>
                              <span className="text-teal-500/80">node: <code className="text-slate-400">{replayBranch.replay.node_id.slice(0, 8)}</code></span>
                            </div>
                          </div>
                        </div>

                        {/* Cost comparison pill */}
                        {replayBranch.cost_saved_usd !== 0 ? (
                          <div className="px-2.5 py-1 rounded-lg bg-emerald-950/80 border border-emerald-500/50 text-emerald-300 text-xs font-mono font-semibold flex items-center gap-1 shadow">
                            <DollarSign className="w-3.5 h-3.5" />
                            <span>
                              {replayBranch.cost_saved_usd > 0
                                ? `Saved $${replayBranch.cost_saved_usd.toFixed(6)} (${replayBranch.cost_saved_pct}% cheaper)`
                                : `Cost $${Math.abs(replayBranch.cost_saved_usd).toFixed(6)} more`
                              }
                            </span>
                          </div>
                        ) : null}
                      </div>

                      {/* Side-by-side comparison: original output vs replay output */}
                      <div className="p-4 bg-slate-900/70 border-b border-slate-800/60 grid grid-cols-2 gap-3">
                        <div className="text-xs font-mono text-slate-400">
                          <div className="mb-1 font-semibold text-slate-300">Original Output</div>
                          <pre className="p-2 bg-slate-950 rounded border border-slate-800 text-slate-300 text-[10px] overflow-auto max-h-48">
                            {JSON.stringify(replayBranch.original.output, null, 2)}
                          </pre>
                        </div>
                        <div className="text-xs font-mono text-teal-400">
                          <div className="mb-1 font-semibold text-teal-300">Replayed Output</div>
                          <pre className="p-2 bg-slate-950 rounded border border-teal-900/60 text-teal-100 text-[10px] overflow-auto max-h-48">
                            {JSON.stringify(replayBranch.replay.output, null, 2)}
                          </pre>
                        </div>
                      </div>

                      {/* Replay footer */}
                      <div className="p-3 bg-slate-950 flex justify-between items-center text-xs font-mono">
                        <span className="text-teal-400/90">
                          ✓ Persisted as sibling node · replayed_from: {replayBranch.replay.replayed_from?.slice(0, 8)}
                        </span>
                        <button
                          onClick={() => {
                            setReplayState((prev) => {
                              const copy = { ...prev };
                              delete copy[node.node_id];
                              return copy;
                            });
                          }}
                          className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white flex items-center gap-1 transition-colors"
                        >
                          <RotateCcw className="w-3 h-3" />
                          <span>Reset Branch</span>
                        </button>
                      </div>
                    </div>
                  )}

                </div>
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Fork & Replay Modal */}
      {forkingNode && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-xl w-full p-6 shadow-2xl animate-scale-up">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-teal-500/10 text-teal-400 flex items-center justify-center">
                  <GitFork className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="font-bold text-slate-100 text-base">Fork & Replay Node</h4>
                  <p className="text-xs text-slate-400 font-mono">Agent: {forkingNode.agent_name} ({forkingNode.node_id.slice(0, 8)})</p>
                </div>
              </div>
              <button
                onClick={() => setForkingNode(null)}
                className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-4 flex flex-col gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase font-mono text-slate-300 mb-1.5">
                  Edit Input Parameter (e.g. modify failure reason or mandate status)
                </label>
                <textarea
                  rows={4}
                  value={editedInputText}
                  onChange={(e) => setEditedInputText(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-slate-200 font-mono focus:outline-none focus:border-teal-500/60"
                  placeholder="Enter modified failure reason or parameters..."
                />
              </div>

              <div className="p-3 rounded-xl bg-teal-950/40 border border-teal-800/40 text-xs text-teal-300 font-mono leading-relaxed">
                <strong>Live Replay:</strong> Submitting calls <code className="text-white">POST /api/replay</code> → server runs the real agent
                against the <strong>live Groq API</strong>, then persists a sibling fork via <code className="text-white">harness.replayNode()</code>.
                The result renders as a side-by-side comparison below the original node.
              </div>
              {replayError && (
                <div className="p-3 rounded-xl bg-rose-950/50 border border-rose-500/40 text-xs text-rose-300 font-mono">
                  <strong>Replay failed:</strong> {replayError}
                </div>
              )}
            </div>

            <div className="mt-6 pt-4 border-t border-slate-800 flex justify-end gap-3">
              <button
                onClick={() => setForkingNode(null)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleExecuteReplay}
                disabled={isReplaying}
                className="px-4 py-2 rounded-xl bg-gradient-to-r from-teal-500 to-emerald-500 hover:from-teal-400 hover:to-emerald-400 text-slate-950 text-xs font-bold flex items-center gap-2 transition-all shadow-lg shadow-teal-500/20 disabled:opacity-50"
              >
                {isReplaying ? (
                  <>
                    <span className="w-3.5 h-3.5 border-2 border-slate-950 border-t-transparent rounded-full animate-spin"></span>
                    <span>Replaying...</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>Execute Replay</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
