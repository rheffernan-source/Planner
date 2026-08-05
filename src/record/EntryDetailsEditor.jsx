import React, { useState } from 'react';
import { APST, PRINCIPAL_PRACTICES } from '../data/standards';

// The fields you don't need to fill in at capture time: hours/provider (PD),
// standards, practice, result. Opens inline on the entry itself.
export default function EntryDetailsEditor({ entry, onSave, onClose }) {
  const isPD = entry.type === 'pd';
  const [title, setTitle] = useState(entry.title);
  const [hours, setHours] = useState(entry.hours ?? '');
  const [provider, setProvider] = useState(entry.provider ?? '');
  const [countsAsPD, setCountsAsPD] = useState(entry.countsAsPD);
  const [standards, setStandards] = useState(entry.standards ?? []);
  const [practice, setPractice] = useState(entry.practice ?? null);
  const [result, setResult] = useState(entry.result ?? '');
  const [resultPending, setResultPending] = useState(entry.resultPending ?? false);

  function toggleStandard(code) {
    setStandards((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  }

  function save() {
    onSave({
      title: title.trim() || entry.title,
      hours: isPD && hours !== '' ? Number(hours) : null,
      provider: isPD ? provider.trim() : '',
      countsAsPD: isPD ? countsAsPD : false,
      standards,
      practice,
      result: result.trim(),
      resultPending,
    });
  }

  return (
    <div className="mt-3 pt-3 border-t border-slate-100 space-y-3">
      <div>
        <label className="text-xs text-slate-400">Title</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full text-sm rounded-lg border border-slate-200 px-2.5 py-1.5 mt-0.5 focus:outline-none focus:ring-2 focus:ring-amber-400"
        />
      </div>

      {isPD && (
        <div className="flex gap-3">
          <div className="w-24">
            <label className="text-xs text-slate-400">Hours</label>
            <input
              type="number"
              min="0"
              step="0.5"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              className="w-full text-sm rounded-lg border border-slate-200 px-2.5 py-1.5 mt-0.5 focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
          </div>
          <div className="flex-1">
            <label className="text-xs text-slate-400">Provider</label>
            <input
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="w-full text-sm rounded-lg border border-slate-200 px-2.5 py-1.5 mt-0.5 focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-slate-500 shrink-0 self-end pb-2">
            <input type="checkbox" checked={countsAsPD} onChange={(e) => setCountsAsPD(e.target.checked)} />
            Counts toward 100h
          </label>
        </div>
      )}

      <div>
        <label className="text-xs text-slate-400">Standards</label>
        <div className="mt-1 max-h-40 overflow-y-auto border border-slate-200 rounded-lg p-2 space-y-1.5">
          {APST.map((std) => (
            <div key={std.standard}>
              <div className="text-xs font-semibold text-slate-500">
                {std.standard}. {std.title}
              </div>
              <div className="flex flex-wrap gap-1 mt-1 mb-1.5">
                {std.focusAreas.map((fa) => {
                  const active = standards.includes(fa.code);
                  return (
                    <button
                      key={fa.code}
                      type="button"
                      onClick={() => toggleStandard(fa.code)}
                      title={fa.title}
                      className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                        active
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'border-slate-200 text-slate-500 hover:border-slate-400'
                      }`}
                    >
                      {fa.code}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <label className="text-xs text-slate-400">Principal practice</label>
        <div className="flex flex-wrap gap-1 mt-1">
          {PRINCIPAL_PRACTICES.map((p) => (
            <button
              key={p.title}
              type="button"
              onClick={() => setPractice(practice === p.title ? null : p.title)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                practice === p.title
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'border-slate-200 text-slate-500 hover:border-slate-400'
              }`}
            >
              {p.title}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-xs text-slate-400">Result — what actually changed</label>
        <textarea
          value={result}
          onChange={(e) => setResult(e.target.value)}
          rows={3}
          className="w-full text-sm rounded-lg border border-slate-200 px-2.5 py-1.5 mt-0.5 focus:outline-none focus:ring-2 focus:ring-amber-400"
        />
        <label className="flex items-center gap-1.5 text-xs text-slate-500 mt-1">
          <input type="checkbox" checked={resultPending} onChange={(e) => setResultPending(e.target.checked)} />
          Still waiting on the outcome
        </label>
      </div>

      <div className="flex gap-2">
        <button onClick={save} className="text-xs bg-slate-900 text-white rounded-lg px-3 py-1.5 font-medium">
          Save details
        </button>
        <button onClick={onClose} className="text-xs text-slate-400">
          Cancel
        </button>
      </div>
    </div>
  );
}
