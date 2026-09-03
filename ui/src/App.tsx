import { useState, useEffect } from 'react';
import { AlertCircle, ArrowLeft } from 'lucide-react';
import { Navbar } from './components/Navbar';
import { MetricsCards } from './components/MetricsCards';
import { PaymentsTable } from './components/PaymentsTable';
import { UnresolvedExceptionsSection } from './components/UnresolvedExceptionsSection';
import { DagTraceViewer } from './components/DagTraceViewer';

import type { BatchEvalData, EvalPaymentRecord } from './types';
import rawData from './data/batch_eval_results.json';

const batchData = (rawData ?? null) as unknown as BatchEvalData | null;

export function App() {
  const [currentView, setCurrentView] = useState<'dashboard' | 'trace'>('dashboard');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // Sync with URL hash (e.g. #/trace/run_id or #/dashboard) and path
  useEffect(() => {
    const handleNavigation = () => {
      const hash = window.location.hash || '';
      const path = window.location.pathname || '';
      let runId: string | null = null;

      if (hash.startsWith('#/trace/')) {
        runId = hash.replace('#/trace/', '').trim();
      } else if (path.startsWith('/trace/')) {
        runId = path.replace('/trace/', '').trim();
      }

      if (runId) {
        setSelectedRunId(runId);
        setCurrentView('trace');
      } else {
        setCurrentView('dashboard');
        setSelectedRunId(null);
      }
    };

    handleNavigation();
    window.addEventListener('hashchange', handleNavigation);
    window.addEventListener('popstate', handleNavigation);
    return () => {
      window.removeEventListener('hashchange', handleNavigation);
      window.removeEventListener('popstate', handleNavigation);
    };
  }, []);

  const handleSelectRun = (runId: string) => {
    setSelectedRunId(runId);
    setCurrentView('trace');
    window.location.hash = `#/trace/${runId}`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleNavigateHome = () => {
    setCurrentView('dashboard');
    setSelectedRunId(null);
    window.location.hash = `#/dashboard`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const hasData = Boolean(
    batchData &&
    Array.isArray(batchData.results) &&
    batchData.results.length > 0 &&
    batchData.metrics
  );

  const selectedRecord: EvalPaymentRecord | undefined = hasData
    ? batchData!.results.find((r) => r.pipeline.run_id === selectedRunId)
    : undefined;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      <Navbar
        currentView={currentView}
        activeRunId={selectedRunId ?? undefined}
        onNavigateHome={handleNavigateHome}
      />

      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8">
        {!hasData ? (
          /* Empty / Missing Data State (PRD / Demo Safety) */
          <div className="py-20 flex items-center justify-center">
            <div className="max-w-md w-full p-8 text-center bg-slate-900 rounded-2xl border border-slate-800 shadow-xl">
              <div className="w-12 h-12 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center mx-auto mb-4 border border-amber-500/20">
                <AlertCircle className="w-6 h-6" />
              </div>
              <h3 className="text-lg font-bold text-slate-100">No batch results found</h3>
              <p className="text-xs text-slate-400 mt-2 font-mono leading-relaxed">
                No batch results found — run <code className="text-teal-400 bg-slate-950 px-2 py-1 rounded border border-slate-800">npm run eval:batch</code> to generate results
              </p>
            </div>
          </div>
        ) : currentView === 'dashboard' ? (
          <div className="flex flex-col gap-8">
            {/* Top Overview Banner */}
            <div className="bg-gradient-to-r from-teal-950/40 via-slate-900 to-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 flex flex-col md:flex-row md:items-center justify-between gap-6">
              <div>
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-teal-500/10 border border-teal-500/20 text-teal-400 text-xs font-semibold uppercase tracking-wider mb-3 font-mono">
                  Autonomous Decision Harness • PRD Benchmark
                </div>
                <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-100 tracking-tight">
                  Revenue Recovery Agent
                </h1>
                <p className="text-sm text-slate-400 mt-1 max-w-2xl leading-relaxed">
                  Dual-model Groq routing (<code className="text-slate-300">openai/gpt-oss-20b</code> + <code className="text-slate-300">120b</code>) with deterministic pre-classification, hard code-level policy enforcement, and auditable DAG decision traces.
                </p>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <div className="text-right">
                  <div className="text-xs text-slate-400 uppercase font-mono font-medium">Dataset Status</div>
                  <div className="text-sm font-bold text-emerald-400 font-mono">
                    {batchData!.results.length} Records Verified
                  </div>
                </div>
              </div>
            </div>

            {/* Metrics KPI Cards */}
            <section aria-label="Key Performance Indicators">
              <MetricsCards metrics={batchData!.metrics} />
            </section>

            {/* Unresolved Exceptions Section (PRD Section 7) */}
            <section aria-label="Unresolved Exceptions">
              <UnresolvedExceptionsSection
                exceptions={batchData!.metrics.unresolved_exceptions}
                records={batchData!.results}
                onSelectRun={handleSelectRun}
              />
            </section>

            {/* Batch Records Table */}
            <section aria-label="Batch Records Table">
              <PaymentsTable
                records={batchData!.results}
                onSelectRun={handleSelectRun}
              />
            </section>
          </div>
        ) : selectedRecord ? (
          <DagTraceViewer
            record={selectedRecord}
            onBack={handleNavigateHome}
          />
        ) : (
          /* Trace Not Found State */
          <div className="max-w-lg mx-auto p-12 text-center bg-slate-900 rounded-2xl border border-slate-800 shadow-xl my-12">
            <div className="w-12 h-12 rounded-xl bg-rose-500/10 text-rose-400 flex items-center justify-center mx-auto mb-4 border border-rose-500/20">
              <AlertCircle className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-bold text-slate-100">Trace not found for this run</h3>
            <p className="text-xs text-slate-400 mt-2 font-mono">
              Could not find DAG trace for run ID: <code className="text-teal-400">{selectedRunId}</code>
            </p>
            <div className="mt-6">
              <button
                onClick={handleNavigateHome}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-teal-500 hover:bg-teal-400 text-slate-950 font-bold text-xs transition-colors shadow-lg shadow-teal-500/20"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Back to Dashboard</span>
              </button>
            </div>
          </div>
        )}
      </main>

      <footer className="border-t border-slate-900 bg-slate-950/80 py-6 text-center text-xs text-slate-500 font-mono">
        RAZAR Revenue Recovery Agent • Auditable Decision Harness • Razorpay Buildathon
      </footer>
    </div>
  );
}

export default App;
