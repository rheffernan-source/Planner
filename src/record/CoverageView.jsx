import React, { useMemo } from 'react';
import { APST, PRINCIPAL_PRACTICES } from '../data/standards';

function countsByStandard(entries) {
  const counts = {};
  for (const entry of entries) {
    for (const code of entry.standards) {
      counts[code] = (counts[code] || 0) + 1;
    }
  }
  return counts;
}

function countsByPractice(entries) {
  const counts = {};
  for (const entry of entries) {
    if (entry.practice) counts[entry.practice] = (counts[entry.practice] || 0) + 1;
  }
  return counts;
}

function FocusAreaCell({ code, title, count }) {
  const covered = count > 0;
  return (
    <div
      title={title}
      className={`rounded-lg border px-2.5 py-2 text-center min-w-[64px] ${
        covered ? 'bg-emerald-50 border-emerald-300' : 'bg-slate-50 border-dashed border-slate-200'
      }`}
    >
      <div className={`font-mono-plex text-sm font-semibold ${covered ? 'text-emerald-800' : 'text-slate-300'}`}>
        {code}
      </div>
      <div className={`text-xs ${covered ? 'text-emerald-600' : 'text-slate-300'}`}>{count}</div>
    </div>
  );
}

export default function CoverageView({ entries }) {
  const standardCounts = useMemo(() => countsByStandard(entries), [entries]);
  const practiceCounts = useMemo(() => countsByPractice(entries), [entries]);

  const zeroFocusAreas = APST.reduce(
    (n, std) => n + std.focusAreas.filter((fa) => !standardCounts[fa.code]).length,
    0
  );

  return (
    <div className="coverage-root max-w-3xl mx-auto p-4 sm:p-6">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
        .font-mono-plex { font-family: 'IBM Plex Mono', ui-monospace, monospace; }
        .coverage-root, .coverage-root * { font-family: 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif; }
        .coverage-root .font-mono-plex { font-family: 'IBM Plex Mono', ui-monospace, monospace; }
      `}</style>

      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-widest">Coverage</h2>
        <span className="text-xs text-slate-400">
          {37 - zeroFocusAreas} of 37 focus areas have evidence
        </span>
      </div>
      <p className="text-xs text-slate-400 mb-4">APST focus areas touched by your logged entries.</p>

      <div className="space-y-4">
        {APST.map((std) => (
          <div key={std.standard}>
            <div className="text-xs font-semibold text-slate-500 mb-1.5">
              {std.standard}. {std.title}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {std.focusAreas.map((fa) => (
                <FocusAreaCell key={fa.code} code={fa.code} title={fa.title} count={standardCounts[fa.code] || 0} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-widest mt-8 mb-3">
        Principal practices
      </h2>
      <div className="space-y-2">
        {PRINCIPAL_PRACTICES.map((p) => {
          const count = practiceCounts[p.title] || 0;
          const covered = count > 0;
          return (
            <div
              key={p.title}
              className={`flex items-center justify-between rounded-lg border px-3 py-2 ${
                covered ? 'bg-indigo-50 border-indigo-200' : 'bg-slate-50 border-dashed border-slate-200'
              }`}
            >
              <span className={`text-sm ${covered ? 'text-indigo-800 font-medium' : 'text-slate-400'}`}>
                {p.title}
              </span>
              <span className={`font-mono-plex text-sm ${covered ? 'text-indigo-700' : 'text-slate-300'}`}>
                {count}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
