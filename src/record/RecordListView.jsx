import React, { useMemo, useState } from 'react';
import { AlertCircle, GraduationCap, Flag, Trash2, Pencil } from 'lucide-react';
import EntryDetailsEditor from './EntryDetailsEditor';

function formatEntryDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function Chip({ children, tone = 'slate' }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-600',
    indigo: 'bg-indigo-50 text-indigo-700',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

function EntryCard({ entry, onDelete, onUpdate }) {
  const isPD = entry.type === 'pd';
  const [editing, setEditing] = useState(false);
  const hasDetails =
    entry.standards.length > 0 || entry.practice || entry.result || (isPD && entry.hours != null);
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="font-mono-plex">{formatEntryDate(entry.date)}</span>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${
                isPD ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800'
              }`}
            >
              {isPD ? <GraduationCap className="w-3 h-3" /> : <Flag className="w-3 h-3" />}
              {isPD ? 'PD' : 'Leadership'}
            </span>
            {isPD && entry.countsAsPD === false && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">
                Not counted toward 100h
              </span>
            )}
          </div>
          <h3 className="mt-1 text-sm font-semibold text-slate-900 truncate">{entry.title}</h3>
          {isPD && entry.provider && (
            <div className="text-xs text-slate-400">{entry.provider}</div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isPD && entry.hours != null && (
            <span className="font-mono-plex text-sm text-slate-500">{entry.hours}h</span>
          )}
          {entry.resultPending && (
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 text-rose-700 px-2 py-0.5 text-xs font-medium">
              <AlertCircle className="w-3 h-3" /> Result pending
            </span>
          )}
          {onUpdate && !editing && (
            <button
              onClick={() => setEditing(true)}
              className="text-slate-300 hover:text-slate-600"
              title={hasDetails ? 'Edit details' : 'Add details'}
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
          {onDelete && (
            <button
              onClick={() => onDelete(entry.id)}
              className="text-slate-300 hover:text-rose-500"
              title="Delete entry"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {!isPD ? (
        <div className="mt-3 space-y-2">
          <div>
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
              Situation / Task / Action
            </div>
            <p className="text-sm text-slate-700 mt-0.5 whitespace-pre-wrap">{entry.rawInput}</p>
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Result</div>
            {entry.result ? (
              <p className="text-sm text-slate-700 mt-0.5 whitespace-pre-wrap">{entry.result}</p>
            ) : (
              <p className="text-sm text-slate-400 mt-0.5 italic">Not filled in yet.</p>
            )}
          </div>
        </div>
      ) : (
        entry.rawInput && (
          <p className="mt-2 text-sm text-slate-600 whitespace-pre-wrap">{entry.rawInput}</p>
        )
      )}

      {(entry.standards.length > 0 || entry.practice) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {entry.standards.map((code) => (
            <Chip key={code}>{code}</Chip>
          ))}
          {entry.practice && <Chip tone="indigo">{entry.practice}</Chip>}
        </div>
      )}

      {editing && (
        <EntryDetailsEditor
          entry={entry}
          onSave={(patch) => {
            onUpdate(entry.id, patch);
            setEditing(false);
          }}
          onClose={() => setEditing(false)}
        />
      )}

      {!editing && !hasDetails && onUpdate && (
        <button onClick={() => setEditing(true)} className="mt-2 text-xs text-slate-400 underline">
          Add details
        </button>
      )}
    </div>
  );
}

function EntryList({ entries, onDelete, onUpdate, emptyLabel }) {
  return entries.length === 0 ? (
    <div className="text-sm text-slate-400">{emptyLabel}</div>
  ) : (
    <div className="space-y-3">
      {entries.map((entry) => (
        <EntryCard key={entry.id} entry={entry} onDelete={onDelete} onUpdate={onUpdate} />
      ))}
    </div>
  );
}

// compact: skip the page chrome (title, filter pills, fonts, padding) and just
// render the cards — for embedding a short list inside another view (Capture's
// "Recent" section) without a nested "Record" header.
export default function RecordListView({
  entries,
  onDelete,
  onUpdate,
  compact = false,
  emptyLabel = 'Nothing here yet.',
}) {
  const [filter, setFilter] = useState('all'); // all | pd | leadership

  const sorted = useMemo(
    () => [...entries].sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : b.date < a.date ? -1 : 1)),
    [entries]
  );

  if (compact) {
    return <EntryList entries={sorted} onDelete={onDelete} onUpdate={onUpdate} emptyLabel={emptyLabel} />;
  }

  const filtered = sorted.filter((e) => filter === 'all' || e.type === filter);
  const labels = { all: 'All', pd: 'PD', leadership: 'Leadership' };

  return (
    <div className="record-root max-w-2xl mx-auto p-6">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
        .font-mono-plex { font-family: 'IBM Plex Mono', ui-monospace, monospace; }
        .record-root, .record-root * { font-family: 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif; }
        .record-root .font-mono-plex { font-family: 'IBM Plex Mono', ui-monospace, monospace; }
      `}</style>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-widest">Record</h2>
        <div className="flex gap-1">
          {['all', 'pd', 'leadership'].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                filter === f
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'border-slate-200 text-slate-500 hover:border-slate-400'
              }`}
            >
              {labels[f]}
            </button>
          ))}
        </div>
      </div>
      <EntryList entries={filtered} onDelete={onDelete} onUpdate={onUpdate} emptyLabel={emptyLabel} />
    </div>
  );
}
