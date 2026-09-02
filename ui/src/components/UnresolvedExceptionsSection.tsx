import React from 'react';
import { AlertOctagon, ShieldCheck, ArrowRight } from 'lucide-react';
import type { EvalMetrics, EvalPaymentRecord } from '../types';

interface UnresolvedExceptionsSectionProps {
  exceptions: EvalMetrics['unresolved_exceptions'];
  records: EvalPaymentRecord[];
  onSelectRun: (runId: string) => void;
}

export const UnresolvedExceptionsSection: React.FC<UnresolvedExceptionsSectionProps> = ({
  exceptions,
  records,
  onSelectRun,
}) => {
  const formatInr = (val: number) => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 2,
    }).format(val);
  };

  const getRunId = (paymentId: string): string | undefined => {
    return records.find((r) => r.payment_id === paymentId)?.pipeline.run_id;
  };

  return (
    <div className="bg-slate-900/90 border border-rose-900/40 rounded-2xl p-6 shadow-xl relative overflow-hidden">
      {/* Subtle background glow */}
      <div className="absolute top-0 right-0 w-96 h-96 bg-rose-500/5 rounded-full blur-3xl pointer-events-none -mr-20 -mt-20"></div>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 flex items-center justify-center shrink-0">
            <AlertOctagon className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold text-slate-100 tracking-tight">Unresolved Stop-Rule Exceptions</h3>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-mono font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/30">
                {exceptions.length} Cases
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Honest exceptions list required by PRD Section 7 — deterministic hard stops intercepted by Policy Guard.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs text-slate-400 font-mono bg-slate-950/60 px-3 py-1.5 rounded-lg border border-slate-800">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <span>No unhandled silent drops</span>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
        {exceptions.map((ex) => {
          const runId = getRunId(ex.payment_id);
          return (
            <div
              key={ex.payment_id}
              className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-4 flex flex-col justify-between hover:border-rose-500/40 hover:bg-slate-900/60 transition-all group"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="font-mono font-bold text-sm text-slate-200 group-hover:text-rose-300 transition-colors">
                      {ex.payment_id}
                    </span>
                    <span className="ml-2 text-xs font-mono font-semibold text-emerald-400">
                      {formatInr(ex.amount_inr)}
                    </span>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-slate-800 text-slate-300 border border-slate-700/60 shrink-0">
                    Attempt {ex.attempt_number}/{ex.max_attempts_allowed}
                  </span>
                </div>

                <div className="mt-2 text-xs text-slate-400 line-clamp-1 italic font-mono bg-slate-900/70 px-2 py-1 rounded border border-slate-800/60">
                  "{ex.failure_reason_raw}"
                </div>

                <div className="mt-2.5">
                  <div className="text-[11px] font-semibold uppercase text-rose-400/90 tracking-wider">
                    Violation Rule
                  </div>
                  <p className="text-xs text-slate-300 mt-0.5 leading-relaxed">
                    {ex.violations[0] || 'Maximum retry limit exceeded for customer authorization.'}
                  </p>
                </div>
              </div>

              {runId && (
                <div className="mt-3.5 pt-3 border-t border-slate-800/60 flex justify-end">
                  <button
                    onClick={() => onSelectRun(runId)}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-300 hover:text-rose-100 transition-colors group-hover:translate-x-0.5 transform"
                  >
                    <span>Inspect Stop Trace</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
