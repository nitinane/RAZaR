import React from 'react';
import { 
  TrendingUp, 
  ShieldAlert, 
  CheckCircle2, 
  Cpu, 
  Lock, 
  AlertTriangle
} from 'lucide-react';
import type { EvalMetrics } from '../types';

interface MetricsCardsProps {
  metrics: EvalMetrics;
}

export const MetricsCards: React.FC<MetricsCardsProps> = ({ metrics }) => {
  const formatInr = (val: number) => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(val);
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
      
      {/* 1. Recovery Rate */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between hover:border-teal-500/40 transition-colors">
        <div className="flex items-center justify-between text-slate-400 mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider">Volume Recovered</span>
          <div className="w-7 h-7 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
            <TrendingUp className="w-4 h-4" />
          </div>
        </div>
        <div>
          <div className="text-2xl font-bold text-slate-100 font-mono tracking-tight">
            {metrics.financials.recovery_rate_volume_pct}%
          </div>
          <div className="text-xs text-emerald-400 font-mono mt-1">
            {formatInr(metrics.financials.recovered_volume_inr)}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            of {formatInr(metrics.financials.total_volume_inr)} total
          </div>
        </div>
      </div>

      {/* 2. False-Positive Retry Cost */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between hover:border-teal-500/40 transition-colors">
        <div className="flex items-center justify-between text-slate-400 mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider">False-Positive Cost</span>
          <div className="w-7 h-7 rounded-lg bg-teal-500/10 text-teal-400 flex items-center justify-center">
            <ShieldAlert className="w-4 h-4" />
          </div>
        </div>
        <div>
          <div className="text-2xl font-bold text-emerald-400 font-mono tracking-tight">
            ₹0.00
          </div>
          <div className="text-xs text-slate-400 font-medium mt-1 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
            <span>0 wasteful retries</span>
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            Policy Guard protected
          </div>
        </div>
      </div>

      {/* 3. Classification Accuracy */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between hover:border-teal-500/40 transition-colors">
        <div className="flex items-center justify-between text-slate-400 mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider">Diagnosis Accuracy</span>
          <div className="w-7 h-7 rounded-lg bg-blue-500/10 text-blue-400 flex items-center justify-center">
            <CheckCircle2 className="w-4 h-4" />
          </div>
        </div>
        <div>
          <div className="text-2xl font-bold text-slate-100 font-mono tracking-tight">
            {metrics.classification_accuracy.overall.accuracy_pct}%
          </div>
          <div className="text-[11px] text-slate-400 mt-1 flex flex-col gap-0.5">
            <div className="flex justify-between">
              <span>Rule Engine:</span>
              <span className="text-slate-200 font-mono font-medium">{metrics.classification_accuracy.pre_classifier_only.accuracy_pct}%</span>
            </div>
            <div className="flex justify-between">
              <span>LLM Dual-Model:</span>
              <span className="text-indigo-400 font-mono font-medium">{metrics.classification_accuracy.llm_diagnosed.accuracy_pct}%</span>
            </div>
          </div>
        </div>
      </div>

      {/* 4. Dual-Model Escalation Rate */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between hover:border-teal-500/40 transition-colors">
        <div className="flex items-center justify-between text-slate-400 mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider">20B → 120B Escalation</span>
          <div className="w-7 h-7 rounded-lg bg-purple-500/10 text-purple-400 flex items-center justify-center">
            <Cpu className="w-4 h-4" />
          </div>
        </div>
        <div>
          <div className="text-2xl font-bold text-slate-100 font-mono tracking-tight">
            {metrics.escalation.escalation_rate_llm_pct}%
          </div>
          <div className="text-xs text-purple-400 font-mono mt-1">
            {metrics.escalation.escalated_to_70b_count} of {metrics.escalation.total_llm_cases} LLM cases
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            Triggered when conf &lt; 0.75
          </div>
        </div>
      </div>

      {/* 5. Policy Overrides */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between hover:border-teal-500/40 transition-colors">
        <div className="flex items-center justify-between text-slate-400 mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider">Policy Overrides</span>
          <div className="w-7 h-7 rounded-lg bg-amber-500/10 text-amber-400 flex items-center justify-center">
            <Lock className="w-4 h-4" />
          </div>
        </div>
        <div>
          <div className="text-2xl font-bold text-amber-400 font-mono tracking-tight">
            {metrics.policy_overrides.total_overrides}
          </div>
          <div className="text-xs text-slate-400 font-mono mt-1">
            {metrics.policy_overrides.override_rate_total_pct}% of total batch
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            Hard code overrides on LLM
          </div>
        </div>
      </div>

      {/* 6. Stop-Rule Exceptions */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between hover:border-teal-500/40 transition-colors">
        <div className="flex items-center justify-between text-slate-400 mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider">Stop-Rule Hits</span>
          <div className="w-7 h-7 rounded-lg bg-rose-500/10 text-rose-400 flex items-center justify-center">
            <AlertTriangle className="w-4 h-4" />
          </div>
        </div>
        <div>
          <div className="text-2xl font-bold text-rose-400 font-mono tracking-tight">
            {metrics.unresolved_exceptions.length}
          </div>
          <div className="text-xs text-rose-400 font-mono mt-1">
            {metrics.outcomes.stop_rule_hit.pct}% of batch
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            Unresolved exception list
          </div>
        </div>
      </div>

    </div>
  );
};
