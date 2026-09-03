import React from 'react';
import { ShieldCheck, Activity, ArrowLeft } from 'lucide-react';
import { LiveHealthIndicator } from './LiveHealthIndicator';

interface NavbarProps {
  currentView: 'dashboard' | 'trace';
  activeRunId?: string;
  onNavigateHome: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ currentView, onNavigateHome }) => {
  return (
    <header className="sticky top-0 z-40 bg-slate-900/90 backdrop-blur-md border-b border-slate-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        
        {/* Left: Brand / Title */}
        <div className="flex items-center gap-3">
          {currentView === 'trace' && (
            <button
              onClick={onNavigateHome}
              className="mr-1 p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors flex items-center gap-1.5 text-xs font-medium"
              title="Back to Dashboard"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Dashboard</span>
            </button>
          )}

          <div className="flex items-center gap-2.5 cursor-pointer" onClick={onNavigateHome}>
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-teal-500 to-emerald-400 flex items-center justify-center shadow-lg shadow-teal-500/20">
              <ShieldCheck className="w-5 h-5 text-slate-950 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-slate-100 text-base tracking-tight">RAZAR</span>
                <span className="text-[10px] uppercase font-semibold px-2 py-0.5 rounded-full bg-teal-500/10 text-teal-400 border border-teal-500/20">
                  Decision Harness
                </span>
              </div>
              <p className="text-xs text-slate-400 font-mono">Revenue Recovery Agent</p>
            </div>
          </div>
        </div>

        {/* Center / Right: Status & Model badges & Live Health */}
        <div className="flex items-center gap-3">
          {/* Live Dependency Health Indicator (Groq + Supabase) */}
          <LiveHealthIndicator />

          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700/60 text-xs font-mono text-slate-300">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>Groq: openai/gpt-oss-20b + 120b</span>
          </div>

          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-teal-950/60 border border-teal-800/50 text-xs font-medium text-teal-300">
            <Activity className="w-3.5 h-3.5" />
            <span>63 Seed Benchmark</span>
          </div>
        </div>
      </div>
    </header>
  );
};
