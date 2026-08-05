import React, { useState } from 'react';
import { useAuth } from '../cloudSync';
import { SyncBadge } from '../AuthGate';
import { useEntries } from './useEntries';
import CaptureView from './CaptureView';
import RecordListView from './RecordListView';
import CoverageView from './CoverageView';
import SummaryView from './SummaryView';

const TABS = ['Capture', 'Record', 'Coverage', 'Summary'];

export default function RecordApp() {
  const { user, signOut } = useAuth();
  const [entries, setEntries, status] = useEntries(user?.uid);
  const [tab, setTab] = useState('Capture');

  function onDelete(id) {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }
  function onUpdate(id, patch) {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  return (
    <div className="h-full overflow-y-auto bg-gradient-to-br from-slate-50 via-white to-amber-50">
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-center gap-1.5 px-3 py-2 border-b border-slate-200 bg-white/90 backdrop-blur-sm">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-xs px-2.5 py-1.5 rounded-lg border font-medium transition-colors ${
              tab === t
                ? 'bg-slate-900 text-white border-slate-900'
                : 'border-slate-200 text-slate-500 hover:border-slate-400'
            }`}
          >
            {t}
          </button>
        ))}
        <SyncBadge status={status} />
        <button onClick={signOut} className="text-xs text-slate-400 hover:text-slate-600 ml-1">
          Sign out
        </button>
      </div>
      {tab === 'Capture' && <CaptureView entries={entries} setEntries={setEntries} />}
      {tab === 'Record' && <RecordListView entries={entries} onDelete={onDelete} onUpdate={onUpdate} />}
      {tab === 'Coverage' && <CoverageView entries={entries} />}
      {tab === 'Summary' && <SummaryView entries={entries} />}
    </div>
  );
}
