import React, { useEffect, useRef, useState } from 'react';
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
export default function CaptureThought({ uid, onAddTodo, footerHeight = 0 }){
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [category, setCategory] = useState(null);
  const [duration, setDuration] = useState(15);
  const [customDuration, setCustomDuration] = useState(false);
  const [dueDate, setDueDate] = useState('');
  const [saving, setSaving] = useState(false);
  const sheetRef = useRef(null);
  const triggerRef = useRef(null);

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
    // Restore focus to the FAB that opened the sheet, mirroring the
    // TaskForm/MeetingForm pattern of returning focus to the trigger.
    triggerRef.current?.focus();
  }

  /*
    Escape-to-close, mirroring the global handler in App.jsx (n/N + Escape)
    for the two full-page forms. This sheet is its own mounted overlay so it
    needs its own listener rather than piggybacking on that one.
  */
  useEffect(()=>{
    if (!open) return;
    function onKeyDown(e){
      if (e.key === 'Escape'){
        e.preventDefault();
        close();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return ()=>window.removeEventListener('keydown', onKeyDown);
  },[open]);

  /*
    Focus trap: while the sheet is open, Tab/Shift+Tab cycle only through its
    own focusable elements instead of escaping into the still-mounted page
    behind it. Also moves initial focus into the sheet on open.
  */
  useEffect(()=>{
    if (!open) return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    const selector = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    function getFocusable(){
      return Array.from(sheet.querySelectorAll(selector)).filter(el => el.offsetParent !== null);
    }
    function onKeyDown(e){
      if (e.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first){
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last){
        e.preventDefault();
        first.focus();
      }
    }
    sheet.addEventListener('keydown', onKeyDown);
    return ()=>sheet.removeEventListener('keydown', onKeyDown);
  },[open]);

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

  return (
    <>
      {/*
        The trigger stays mounted at all times (rather than being swapped out
        for the overlay) so `triggerRef` never goes stale — a conditionally
        unmounted trigger loses its DOM node while the sheet is open, which
        breaks focus restoration on close. Hidden + inert while the sheet is
        open instead: not in the tab order, not visible, not screen-reader
        reachable, but still a live, focusable element for `close()` to
        return to.
      */}
      {/*
        `bottom` is set inline rather than via a Tailwind `bottom-*` class:
        the footer bar below wraps to a second line at some widths (measured
        at 375px and 768px) and not others, so a fixed class would only be
        correct at the widths someone happened to measure. `footerHeight`
        (from a ResizeObserver on the footer in App.jsx) is the footer's real
        rendered height at the current width/content, so this offset is
        correct at every breakpoint and stays correct if the footer's
        content changes later. +16px is the same visual gap `bottom-6`
        (24px) minus the extra breathing room already inside the footer's
        own padding gave a single-line footer.
      */}
      <button
        ref={triggerRef}
        onClick={()=>setOpen(true)}
        aria-label="Capture a thought"
        tabIndex={open ? -1 : 0}
        aria-hidden={open}
        style={{ bottom: footerHeight > 0 ? `${footerHeight + 16}px` : '1.5rem' }}
        className={`fixed left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 pl-4 pr-5 py-3.5 min-h-[44px] rounded-full bg-prism-cta text-white font-semibold text-sm shadow-prism-cta active:scale-95 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-prism-blue-deep ${open ? 'opacity-0 pointer-events-none' : ''}`}
      >
        <NotebookPen className="w-5 h-5"/> Capture thought
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-prism-navy/50 backdrop-blur-sm" onClick={close}>
          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-label="Capture a thought"
            className="w-full sm:max-w-sm bg-white/80 backdrop-blur-2xl backdrop-saturate-150 border border-white/60 rounded-t-3xl sm:rounded-2xl p-5 space-y-4 max-h-[85vh] overflow-y-auto shadow-prism-card"
            onClick={e=>e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-prism-ink">Capture a thought</span>
              <button type="button" onClick={close} aria-label="Close" className="text-prism-muted hover:text-prism-ink p-1.5 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep"><X className="w-4 h-4"/></button>
            </div>

            <textarea
              autoFocus
              rows={3}
              value={note}
              onChange={e=>setNote(e.target.value)}
              placeholder="What's on your mind?"
              aria-label="Capture note"
              className="w-full rounded-xl border border-white/60 bg-white/80 px-3 py-2.5 text-sm text-prism-ink placeholder:text-prism-muted resize-none focus:outline-none focus:ring-2 focus:ring-prism-blue-deep"
            />

            <div>
              <label className="text-xs text-prism-muted block mb-1.5">What kind of thought is this?</label>
              <div className="grid grid-cols-2 gap-1.5">
                {CATEGORIES.map(c=>{
                  const Icon = c.icon;
                  const active = category===c.value;
                  return (
                    <button
                      key={c.value}
                      type="button"
                      onClick={()=>setCategory(c.value)}
                      aria-pressed={active}
                      className={`min-h-[44px] flex items-center gap-1.5 text-xs px-2.5 py-2 rounded-lg border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep ${active ? 'bg-prism-cta text-white border-transparent' : 'border-white/60 bg-white/50 text-prism-muted hover:border-prism-blue/50'}`}
                    >
                      <Icon className="w-3.5 h-3.5"/> {c.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {category === 'todo' && (
              <div className="space-y-3 border-t border-white/50 pt-3">
                <div>
                  <label className="text-xs text-prism-muted block mb-1">How long?</label>
                  <div className="flex flex-wrap gap-1.5">
                    {DURATION_PRESETS.map(p=>(
                      <button key={p.minutes} type="button" onClick={()=>{ setDuration(p.minutes); setCustomDuration(false); }}
                        className={`min-h-[36px] text-xs px-2.5 py-1.5 rounded-lg border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep ${!customDuration && duration===p.minutes ? 'bg-prism-cta text-white border-transparent' : 'border-white/60 bg-white/50 text-prism-muted hover:border-prism-blue/50'}`}>
                        {p.label}
                      </button>
                    ))}
                    <button type="button" onClick={()=>setCustomDuration(true)}
                      className={`min-h-[36px] text-xs px-2.5 py-1.5 rounded-lg border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep ${customDuration ? 'bg-prism-cta text-white border-transparent' : 'border-white/60 bg-white/50 text-prism-muted hover:border-prism-blue/50'}`}>
                      Other
                    </button>
                  </div>
                  {customDuration && (
                    <input type="number" min={MIN_TASK_MINUTES} step="5" value={duration} onChange={e=>setDuration(e.target.value)}
                      placeholder="minutes" aria-label="Custom duration in minutes"
                      className="mt-1.5 w-full rounded-xl border border-white/60 bg-white/80 px-3 py-2 text-sm text-prism-ink focus:outline-none focus:ring-2 focus:ring-prism-blue-deep"/>
                  )}
                </div>
                <div>
                  <label className="text-xs text-prism-muted block mb-1">Due by (optional)</label>
                  <input type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)} aria-label="Due date" className="w-full rounded-xl border border-white/60 bg-white/80 px-3 py-2 text-sm text-prism-ink focus:outline-none focus:ring-2 focus:ring-prism-blue-deep"/>
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={submit}
              disabled={!note.trim() || !category || saving}
              className="w-full py-2.5 min-h-[44px] rounded-xl bg-prism-cta text-white text-sm font-medium shadow-prism-cta disabled:opacity-40 disabled:shadow-none flex items-center justify-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep focus-visible:ring-offset-2"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin"/>}
              Save
            </button>
          </div>
        </div>
      )}
    </>
  );
}
