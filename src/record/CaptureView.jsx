import React, { useRef, useState } from 'react';
import { GraduationCap, Flag } from 'lucide-react';
import RecordListView from './RecordListView';

function genEntryId() {
  return 'entry-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// First non-empty line, trimmed to a sane length — nothing here should ever
// block Save. You can tidy it up later from "Edit details".
function deriveTitle(rawInput) {
  const firstLine = (rawInput.split('\n').find((l) => l.trim()) || '').trim();
  if (firstLine.length <= 80) return firstLine;
  const cut = firstLine.slice(0, 80);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut) + '…';
}

export default function CaptureView({ entries, setEntries }) {
  const [type, setType] = useState('leadership');
  const [text, setText] = useState('');
  const textareaRef = useRef(null);

  function save() {
    const rawInput = text.trim();
    if (!rawInput) return;
    const now = Date.now();
    const entry = {
      id: genEntryId(),
      type,
      date: new Date().toISOString().slice(0, 10),
      hours: null,
      title: deriveTitle(rawInput),
      provider: '',
      countsAsPD: type === 'pd',
      rawInput,
      standards: [],
      practice: null,
      result: '',
      resultPending: type === 'leadership',
      createdAt: now,
      updatedAt: now,
    };
    setEntries((prev) => [...prev, entry]);
    setText('');
    textareaRef.current?.focus();
  }

  function onKeyDown(e) {
    // Cmd/Ctrl+Enter saves without leaving the keyboard — the fast path.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  }

  function onUpdate(id, patch) {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  function onDelete(id) {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }

  const recent = [...entries].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);

  return (
    <div className="capture-root min-h-full">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
        .font-mono-plex { font-family: 'IBM Plex Mono', ui-monospace, monospace; }
        .capture-root, .capture-root * { font-family: 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif; }
      `}</style>
      <div className="max-w-2xl mx-auto p-4 sm:p-6">
        <div className="flex gap-2 mb-3">
          <button
            onClick={() => setType('leadership')}
            className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm border transition-colors ${
              type === 'leadership'
                ? 'bg-emerald-600 text-white border-emerald-600'
                : 'border-slate-200 text-slate-500'
            }`}
          >
            <Flag className="w-4 h-4" /> Leadership
          </button>
          <button
            onClick={() => setType('pd')}
            className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm border transition-colors ${
              type === 'pd' ? 'bg-amber-500 text-white border-amber-500' : 'border-slate-200 text-slate-500'
            }`}
          >
            <GraduationCap className="w-4 h-4" /> PD
          </button>
        </div>

        <textarea
          ref={textareaRef}
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            type === 'leadership'
              ? "What happened? Who was involved, what you did, how it went…"
              : 'What was it, and what did you take from it?'
          }
          rows={8}
          className="w-full text-base rounded-2xl border border-slate-200 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-amber-400 bg-white"
        />

        <button
          onClick={save}
          disabled={!text.trim()}
          className="w-full mt-3 py-4 rounded-2xl bg-slate-900 text-white font-semibold text-base disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Save
        </button>

        <div className="mt-8">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-2">
            Recent
          </h2>
          <RecordListView
            entries={recent}
            onDelete={onDelete}
            onUpdate={onUpdate}
            compact
            emptyLabel="Nothing logged yet — your first save will show up here."
          />
        </div>
      </div>
    </div>
  );
}
