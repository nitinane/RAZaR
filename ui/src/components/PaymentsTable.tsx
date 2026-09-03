import React, { useState } from 'react';
import { 
  Search, 
  ExternalLink, 
  Sparkles, 
  ShieldAlert, 
  CheckCircle2, 
  Clock, 
  UserCheck, 
  AlertOctagon
} from 'lucide-react';
import type { EvalPaymentRecord, AgentOutcome, PromiseTrackingData } from '../types';

interface PaymentsTableProps {
  records: EvalPaymentRecord[];
  onSelectRun: (runId: string) => void;
}

export const PaymentsTable: React.FC<PaymentsTableProps> = ({ records, onSelectRun }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedOutcome, setSelectedOutcome] = useState<string>('all');

  const getPromiseBadge = (tracking?: PromiseTrackingData) => {
    if (!tracking || !tracking.promise_status || tracking.promise_status === 'none') {
      return null;
    }

    if (tracking.promise_status === 'kept' || tracking.escalation_status === 'resolved') {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          P2P: Kept
        </span>
      );
    }

    if (tracking.escalation_status === 'overdue_gentle') {
      return (
        <span
          className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20"
          title={`Deadline: ${tracking.promised_pay_by ?? 'N/A'}`}
        >
          P2P: Overdue (Gentle)
        </span>
      );
    }

    if (tracking.escalation_status === 'overdue_firm') {
      return (
        <span
          className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20"
          title={`Deadline: ${tracking.promised_pay_by ?? 'N/A'}`}
        >
          P2P: Overdue (Firm)
        </span>
      );
    }

    // Default / on_track
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-slate-300 border border-slate-700"
        title={`Deadline: ${tracking.promised_pay_by ?? 'N/A'}`}
      >
        P2P: On Track
      </span>
    );
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
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>Resolved</span>
          </span>
        );
      case 'notify_customer_pending':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20">
            <Clock className="w-3.5 h-3.5" />
            <span>Notify Customer</span>
          </span>
        );
      case 'escalated_to_human':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <UserCheck className="w-3.5 h-3.5" />
            <span>Escalated (Human)</span>
          </span>
        );
      case 'stop_rule_hit':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/20">
            <AlertOctagon className="w-3.5 h-3.5" />
            <span>Stop Rule Hit</span>
          </span>
        );
      default:
        return <span className="text-xs text-slate-400">{outcome}</span>;
    }
  };

  const filteredRecords = records.filter((r) => {
    const matchesSearch =
      r.payment_id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      r.failure_reason_raw.toLowerCase().includes(searchTerm.toLowerCase()) ||
      r.failure_code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      r.method.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesOutcome =
      selectedOutcome === 'all' || r.pipeline.agent_outcome === selectedOutcome;

    return matchesSearch && matchesOutcome;
  });

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col gap-5">
      
      {/* Header and Controls */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-bold text-slate-100 tracking-tight">Evaluated Payment Batch</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Full 63 canonical records evaluated through auditable decision harness
          </p>
        </div>

        {/* Filter Pills & Search */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search ID, reason, code…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-teal-500/50 w-52 sm:w-64"
            />
          </div>

          <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs">
            {[
              { id: 'all', label: 'All' },
              { id: 'resolved', label: 'Resolved' },
              { id: 'notify_customer_pending', label: 'Notify' },
              { id: 'escalated_to_human', label: 'Escalated' },
              { id: 'stop_rule_hit', label: 'Stop-Rule' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setSelectedOutcome(tab.id)}
                className={`px-2.5 py-1 rounded-lg font-medium transition-colors ${
                  selectedOutcome === tab.id
                    ? 'bg-slate-800 text-teal-300 font-semibold shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-slate-800/80">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="bg-slate-950/80 text-slate-400 border-b border-slate-800 uppercase font-mono tracking-wider text-[11px]">
              <th className="py-3 px-4">Payment ID</th>
              <th className="py-3 px-4">Amount</th>
              <th className="py-3 px-4">Method</th>
              <th className="py-3 px-4">Raw Failure Reason</th>
              <th className="py-3 px-4">Diagnosed Cause</th>
              <th className="py-3 px-4">Agent Outcome</th>
              <th className="py-3 px-4 text-right">Harness DAG</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60 bg-slate-900/40">
            {filteredRecords.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-12 text-center text-slate-400">
                  <div className="flex flex-col items-center justify-center gap-2">
                    <Search className="w-6 h-6 text-slate-500 stroke-[1.5]" />
                    <span className="font-semibold text-slate-300 text-sm">No records match your filter</span>
                    <p className="text-[11px] text-slate-500 font-mono max-w-sm">
                      Try adjusting your search query or switching outcome filter.
                    </p>
                    {(searchTerm || selectedOutcome !== 'all') && (
                      <button
                        onClick={() => {
                          setSearchTerm('');
                          setSelectedOutcome('all');
                        }}
                        className="mt-1 px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-teal-400 text-xs font-mono transition-colors"
                      >
                        Clear filters
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ) : (
              filteredRecords.map((rec) => (
                <tr
                  key={rec.payment_id}
                  className="hover:bg-slate-800/40 transition-colors group cursor-pointer"
                  onClick={() => onSelectRun(rec.pipeline.run_id)}
                >
                  {/* Payment ID */}
                  <td className="py-3 px-4 font-mono font-semibold text-slate-200">
                    <div className="flex items-center gap-1.5">
                      <span>{rec.payment_id}</span>
                      {rec.pipeline.used_llm && (
                        <span title="Processed via Groq Dual-Model (20B/120B)">
                          <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                        </span>
                      )}
                      {rec.pipeline.policy_overridden && (
                        <span title="Policy Guard override enforced">
                          <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono">
                      Attempt {rec.attempt_number}
                    </div>
                  </td>

                  {/* Amount */}
                  <td className="py-3 px-4 font-mono font-medium text-emerald-400">
                    {formatInr(rec.amount)}
                  </td>

                  {/* Method */}
                  <td className="py-3 px-4 font-mono text-slate-300 uppercase">
                    <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700/60 text-[10px]">
                      {rec.method}
                    </span>
                  </td>

                  {/* Failure reason */}
                  <td className="py-3 px-4 max-w-xs text-slate-300 truncate" title={rec.failure_reason_raw}>
                    <div className="truncate font-mono text-[11px]">{rec.failure_reason_raw}</div>
                    <div className="text-[10px] text-slate-500 font-mono">{rec.failure_code}</div>
                  </td>

                  {/* Diagnosed cause */}
                  <td className="py-3 px-4 font-mono text-slate-300">
                    <span className="px-2 py-0.5 rounded bg-slate-950 border border-slate-800 text-[11px]">
                      {rec.pipeline.diagnosed_root_cause || '—'}
                    </span>
                  </td>

                  {/* Outcome & Promise-to-Pay Status */}
                  <td className="py-3 px-4">
                    <div className="flex flex-col gap-1 items-start">
                      {getOutcomeBadge(rec.pipeline.agent_outcome)}
                      {rec.pipeline.agent_outcome === 'notify_customer_pending' &&
                        getPromiseBadge(rec.pipeline.promise_tracking)}
                    </div>
                  </td>

                  {/* View Trace Button */}
                  <td className="py-3 px-4 text-right">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectRun(rec.pipeline.run_id);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-500/10 hover:bg-teal-500/20 text-teal-300 border border-teal-500/30 hover:border-teal-500/50 font-medium text-xs transition-colors"
                    >
                      <span>View Trace</span>
                      <ExternalLink className="w-3 h-3" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-slate-500 pt-2 font-mono">
        <div>Showing {filteredRecords.length} of {records.length} records</div>
        <div>Tip: Click any row or "View Trace" to inspect the auditable DAG node tree.</div>
      </div>

    </div>
  );
};
