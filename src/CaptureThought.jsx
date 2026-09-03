import React, { useState } from 'react';
import { NotebookPen, X, Lightbulb, ListTodo, Flag, MessageCircle, Loader2 } from 'lucide-react';
import { createCapture } from './cloudSync';
import { DURATION_PRESETS, MIN_TASK_MINUTES } from './App';

// Stored value ('idea'/'todo'/'follow-up'/'conversation') is what the Planner
// Sync Bridge's drainCaptureToInbox reads to build the Team Inbox filename and
// the "**Capture category:**" label — keep these in sync with
// Expansions/rohan-planner-sync/runtime/sync.mjs if this list ever changes.
const CATEGORIES = [
  { value: 'idea', label: 'Idea', icon: Lightbulb },
  { value: 'todo', label: 'Todo', icon: ListTodo },
  { value: 'follow-up', label: 'Follow-up', icon: Flag },
  { value: 'conversation', label: 'Conversation', icon: MessageCircle },
];

/**
 * Always-reachable mobile capture flow: FAB -> note -> category -> (Todo only)
 * duration + optional due date. Todo goes through the same addTask the rest of
 * the app uses, so it lands in the one real task list. Everything else is a
 * one-shot write to the `captures` collection, which the sync bridge drains
 * into Team Inbox for Penn's normal routing — this component never talks to
 * myPKA directly.
 */
export default function CaptureThought({ uid, onAddTodo }){
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [category, setCategory] = useState(null);
  const [duration, setDuration] = useState(15);
  const [customDuration, setCustomDuration] = useState(false);
  const [dueDate, setDueDate] = useState('');
  const [saving, setSaving] = useState(false);

  function reset(){
    setNote('');
    setCategory(null);
    setDuration(15);
    setCustomDuration(false);
    setDueDate('');
    setSaving(false);
  }
  function close(){
    setOpen(false);
    reset();
  }

  async function submit(){
    const text = note.trim();
    if (!text || !category || saving) return;
    setSaving(true);
    if (category === 'todo') {
      const mins = Math.max(MIN_TASK_MINUTES, Number(duration) || MIN_TASK_MINUTES);
      onAddTodo({ title: text, duration: mins, dueDate: dueDate || null, pressing: false, source: 'capture' });
    } else {
      await createCapture(uid, { category, note: text });
    }
    close();
  }

  if (!open){
    return (
      <button
        onClick={()=>setOpen(true)}
        aria-label="Capture a thought"
        className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 pl-4 pr-5 py-3.5 rounded-full bg-amber-400 text-slate-900 font-semibold text-sm shadow-2xl shadow-amber-400/30 hover:bg-amber-300 active:scale-95 transition-all"
      >
        <NotebookPen className="w-5 h-5"/> Capture thought
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm" onClick={close}>
      <div
        className="w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-2xl p-5 space-y-4 max-h-[85vh] overflow-y-auto"
        onClick={e=>e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-900">Capture a thought</span>
          <button type="button" onClick={close} aria-label="Close" className="text-slate-400"><X className="w-4 h-4"/></button>
        </div>

        <textarea
          autoFocus
          rows={3}
          value={note}
          onChange={e=>setNote(e.target.value)}
          placeholder="What's on your mind?"
          aria-label="Capture note"
          className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-400"
        />

        <div>
          <label className="text-xs text-slate-400 block mb-1.5">What kind of thought is this?</label>
          <div className="grid grid-cols-2 gap-1.5">
            {CATEGORIES.map(c=>{
              const Icon = c.icon;
              const active = category===c.value;
              return (
                <button
                  key={c.value}
                  type="button"
                  onClick={()=>setCategory(c.value)}
                  className={`flex items-center gap-1.5 text-xs px-2.5 py-2 rounded-lg border transition-colors ${active ? 'bg-slate-900 text-white border-slate-900' : 'border-slate-200 text-slate-600 hover:border-slate-400'}`}
                >
                  <Icon className="w-3.5 h-3.5"/> {c.label}
                </button>
              );
            })}
          </div>
        </div>

        {category === 'todo' && (
          <div className="space-y-3 border-t border-slate-100 pt-3">
            <div>
              <label className="text-xs text-slate-400 block mb-1">How long?</label>
              <div className="flex flex-wrap gap-1.5">
                {DURATION_PRESETS.map(p=>(
                  <button key={p.minutes} type="button" onClick={()=>{ setDuration(p.minutes); setCustomDuration(false); }}
                    className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${!customDuration && duration===p.minutes ? 'bg-slate-900 text-white border-slate-900' : 'border-slate-200 text-slate-600 hover:border-slate-400'}`}>
                    {p.label}
                  </button>
                ))}
                <button type="button" onClick={()=>setCustomDuration(true)}
                  className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${customDuration ? 'bg-slate-900 text-white border-slate-900' : 'border-slate-200 text-slate-600 hover:border-slate-400'}`}>
                  Other
                </button>
              </div>
              {customDuration && (
                <input type="number" min={MIN_TASK_MINUTES} step="5" value={duration} onChange={e=>setDuration(e.target.value)}
                  placeholder="minutes" aria-label="Custom duration in minutes"
                  className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"/>
              )}
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Due by (optional)</label>
              <input type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)} aria-label="Due date" className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"/>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={!note.trim() || !category || saving}
          className="w-full py-2.5 rounded-xl bg-slate-900 text-white text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-2"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin"/>}
          Save
        </button>
      </div>
    </div>
  );
}
