import React, { useMemo } from 'react';

const PD_TARGET_HOURS = 100;

function StatTile({ label, value, sub }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-xs text-slate-400 uppercase tracking-widest">{label}</div>
      <div className="font-mono-plex text-2xl font-semibold text-slate-900 mt-1">{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );
}

export default function SummaryView({ entries }) {
  const stats = useMemo(() => {
    let hoursLogged = 0;
    let pdCount = 0;
    let leadershipCount = 0;
    let pendingCount = 0;
    for (const e of entries) {
      if (e.type === 'pd') {
        pdCount += 1;
        if (e.countsAsPD && e.hours) hoursLogged += e.hours;
      } else {
        leadershipCount += 1;
      }
      if (e.resultPending) pendingCount += 1;
    }
    return { hoursLogged, pdCount, leadershipCount, pendingCount };
  }, [entries]);

  const remaining = Math.max(0, PD_TARGET_HOURS - stats.hoursLogged);
  const pct = Math.min(100, Math.round((stats.hoursLogged / PD_TARGET_HOURS) * 100));

  return (
    <div className="summary-root max-w-2xl mx-auto p-4 sm:p-6">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
        .font-mono-plex { font-family: 'IBM Plex Mono', ui-monospace, monospace; }
        .summary-root, .summary-root * { font-family: 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif; }
        .summary-root .font-mono-plex { font-family: 'IBM Plex Mono', ui-monospace, monospace; }
      `}</style>

      <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-widest mb-4">Summary</h2>

      <div className="rounded-xl border border-slate-200 bg-white p-4 mb-4">
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-sm font-medium text-slate-700">PD hours logged</span>
          <span className="font-mono-plex text-sm text-slate-500">
            {stats.hoursLogged} / {PD_TARGET_HOURS}h
          </span>
        </div>
        <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
          <div className="h-full bg-amber-500 rounded-full" style={{ width: `${pct}%` }} />
        </div>
        <div className="text-xs text-slate-400 mt-2">{remaining}h remaining this period</div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <StatTile label="PD entries" value={stats.pdCount} />
        <StatTile label="Leadership" value={stats.leadershipCount} />
        <StatTile label="Pending" value={stats.pendingCount} sub="results not yet filled in" />
      </div>
    </div>
  );
}
