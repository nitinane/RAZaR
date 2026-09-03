import React, { useState, useEffect, useRef } from 'react';
import { Activity, AlertCircle, CheckCircle2, XCircle, RefreshCw } from 'lucide-react';

interface DependencyStatus {
  reachable: boolean;
  latency_ms?: number | null;
  url?: string | null;
  error?: string | null;
}

interface HealthResponse {
  status: 'healthy' | 'degraded';
  timestamp: string;
  total_health_check_ms?: number;
  dependencies?: {
    supabase?: DependencyStatus;
    groq?: DependencyStatus;
  };
  models?: {
    fast_model: string;
    smart_model: string;
  };
}

export const LiveHealthIndicator: React.FC = () => {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [serverError, setServerError] = useState<string | null>(null);
  const [showTooltip, setShowTooltip] = useState<boolean>(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const checkHealth = async () => {
    try {
      // Fetch via Vite proxy (/api/health -> http://localhost:3001/api/health)
      const res = await fetch('/api/health');
      if (!res.ok && res.status !== 207) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }
      const data: HealthResponse = await res.json();
      setHealth(data);
      setServerError(null);
      setLastChecked(new Date());
    } catch (err) {
      setServerError((err as Error).message || 'Backend unreachable');
      setHealth(null);
      setLastChecked(new Date());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkHealth();
    // Poll every 30 seconds
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  // Close tooltip if clicked outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowTooltip(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const groqReachable = health?.dependencies?.groq?.reachable ?? false;
  const supabaseReachable = health?.dependencies?.supabase?.reachable ?? false;

  const getDotClass = (reachable: boolean) => {
    if (loading && !health && !serverError) {
      return 'bg-slate-400 animate-pulse'; // checking
    }
    if (serverError || !reachable) {
      return 'bg-rose-500'; // unreachable
    }
    return 'bg-emerald-400 animate-pulse'; // healthy
  };

  return (
    <div
      ref={containerRef}
      className="relative flex items-center"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {/* Pills Container */}
      <div
        onClick={() => setShowTooltip((prev) => !prev)}
        className="flex items-center gap-1.5 p-1 rounded-lg bg-slate-800/80 border border-slate-700/60 cursor-pointer hover:border-slate-600 transition-colors"
        title="Click or hover to inspect live dependency health"
      >
        {/* Groq Pill */}
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-900/60 text-[11px] font-mono">
          <span className={`w-2 h-2 rounded-full ${getDotClass(groqReachable)}`} />
          <span className="text-slate-300">Groq</span>
        </div>

        {/* Supabase Pill */}
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-900/60 text-[11px] font-mono">
          <span className={`w-2 h-2 rounded-full ${getDotClass(supabaseReachable)}`} />
          <span className="text-slate-300">Supabase</span>
        </div>

        {/* Optional offline warning label */}
        {serverError && (
          <span className="hidden md:inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono bg-rose-500/10 text-rose-400 border border-rose-500/20">
            <AlertCircle className="w-3 h-3" />
            <span>backend unreachable</span>
          </span>
        )}
      </div>

      {/* Floating Tooltip Detail Dropdown */}
      {showTooltip && (
        <div className="absolute right-0 top-full mt-2 w-72 bg-slate-900 border border-slate-700 rounded-xl p-3.5 shadow-2xl z-50 text-xs font-mono animate-scale-up">
          <div className="flex items-center justify-between pb-2 mb-2.5 border-b border-slate-800">
            <div className="flex items-center gap-1.5 font-bold text-slate-200">
              <Activity className="w-3.5 h-3.5 text-teal-400" />
              <span>Live System Health</span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setLoading(true);
                checkHealth();
              }}
              className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-teal-300 transition-colors"
              title="Refresh now"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {serverError ? (
            <div className="p-2.5 rounded-lg bg-rose-950/40 border border-rose-800/40 text-rose-300 flex flex-col gap-1">
              <div className="flex items-center gap-1.5 font-semibold">
                <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                <span>Backend Unreachable</span>
              </div>
              <p className="text-[10px] text-rose-400/90 leading-normal">
                {serverError}. Ensure <code className="text-white">npm run replay:server</code> is running on port 3001.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {/* Groq Details */}
              <div className="p-2 rounded-lg bg-slate-950/80 border border-slate-800 flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-200">Groq LLM API</span>
                  {groqReachable ? (
                    <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400">
                      <CheckCircle2 className="w-3 h-3" />
                      <span>{health?.dependencies?.groq?.latency_ms ? `${health.dependencies.groq.latency_ms}ms` : 'Ready'}</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[10px] text-rose-400">
                      <XCircle className="w-3 h-3" />
                      <span>Offline</span>
                    </span>
                  )}
                </div>
                {health?.dependencies?.groq?.error && (
                  <p className="text-[10px] text-rose-400 mt-0.5 truncate" title={health.dependencies.groq.error}>
                    Error: {health.dependencies.groq.error}
                  </p>
                )}
                <div className="text-[10px] text-slate-500 truncate">
                  Models: {health?.models?.fast_model ?? 'gpt-oss-20b'} / {health?.models?.smart_model ?? '120b'}
                </div>
              </div>

              {/* Supabase Details */}
              <div className="p-2 rounded-lg bg-slate-950/80 border border-slate-800 flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-200">Supabase DB</span>
                  {supabaseReachable ? (
                    <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400">
                      <CheckCircle2 className="w-3 h-3" />
                      <span>Connected</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[10px] text-rose-400">
                      <XCircle className="w-3 h-3" />
                      <span>Offline</span>
                    </span>
                  )}
                </div>
                {health?.dependencies?.supabase?.error ? (
                  <p className="text-[10px] text-rose-400 mt-0.5 truncate" title={health.dependencies.supabase.error}>
                    Error: {health.dependencies.supabase.error}
                  </p>
                ) : (
                  <div className="text-[10px] text-slate-500 truncate">
                    URL: {health?.dependencies?.supabase?.url ?? 'Connected'}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="mt-2.5 pt-2 border-t border-slate-800/80 text-[10px] text-slate-500 flex items-center justify-between">
            <span>Polled every 30s</span>
            <span>{lastChecked ? lastChecked.toLocaleTimeString() : 'Checking…'}</span>
          </div>
        </div>
      )}
    </div>
  );
};
