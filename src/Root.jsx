import React, { useEffect, useState } from 'react';
import App from './App';
import RecordApp from './record/RecordApp';

const VIEW_KEY = 'week-planner-top-view';

export default function Root() {
  const [view, setView] = useState(() => localStorage.getItem(VIEW_KEY) || 'planner');

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  return (
    <div className="h-screen w-full flex flex-col overflow-hidden">
      <div className="shrink-0 flex items-center justify-center gap-1 py-1.5 bg-slate-900">
        <button
          onClick={() => setView('planner')}
          className={`text-xs px-3 py-1 rounded-lg font-medium transition-colors ${
            view === 'planner' ? 'bg-white text-slate-900' : 'text-slate-400 hover:text-white'
          }`}
        >
          Planner
        </button>
        <button
          onClick={() => setView('record')}
          className={`text-xs px-3 py-1 rounded-lg font-medium transition-colors ${
            view === 'record' ? 'bg-white text-slate-900' : 'text-slate-400 hover:text-white'
          }`}
        >
          Record
        </button>
      </div>
      <div className="flex-1 min-h-0">{view === 'planner' ? <App /> : <RecordApp />}</div>
    </div>
  );
}
