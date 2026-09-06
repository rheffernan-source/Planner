import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Check, Plus, X, Trash2, ChevronDown, ChevronUp, Settings2, Loader2, Star, PartyPopper, Pin, Pencil, Undo2, Users, CalendarPlus, MoreVertical, HelpCircle, TrendingUp, Play, CalendarClock } from 'lucide-react';
import { useAuth, useCloudTasks, useCloudDoc, importFromThisBrowser } from './cloudSync';
import { SyncBadge } from './AuthGate';
import CaptureThought from './CaptureThought';
import { registerForPush } from './pushNotifications';
/* ============================================================
   Constants — your real week template
   ============================================================ */
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const DAY_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const WEEKDAY_DAYS = [1,2,3,4,5]; // Mon-Fri — days that check emails / evaluations recur on
const SNAPSHOT_HISTORY_WEEKS = 52; // keep about a year of weekly workload snapshots, then drop the oldest
const SCHEDULE_WEEKS = 3; // how far ahead the scheduler looks AND how far the board renders — one constant so the two can never drift apart
const ARCHIVE_AFTER_DAYS = 60; // completed tasks older than this are compacted into the archive
const UNDO_WINDOW_MS = 8000; // how long a deleted task can still be restored
// A week running above this fraction of its remaining flex time has no slack left to
// absorb a sick day, an unexpected meeting, or a task running long — so the traffic
// light warns here rather than waiting for work to actually overflow the week.
const HIGH_UTILISATION = 0.8;
// How many completed-and-timed tasks before your personal estimate/actual ratio is
// trustworthy enough to offer as a correction. Below this it's noise, not a pattern.
const MIN_ACCURACY_SAMPLE = 5;
// Quick-pick durations for the add-task form. Note 60min and "1 hour" are the same
// value, so they're a single option here rather than two identical buttons.
export const DURATION_PRESETS = [
  { minutes: 15, label: '15m' },
  { minutes: 30, label: '30m' },
  { minutes: 60, label: '1h' },
  { minutes: 90, label: '1.5h' },
];
const DEFAULT_SLOTS = [
  { id: 'slot-mon-1', day: 1, start: '07:40', end: '08:00', restricted: false },
  { id: 'slot-mon-2', day: 1, start: '10:30', end: '10:45', restricted: false },
  { id: 'slot-mon-3', day: 1, start: '14:35', end: '15:00', restricted: false },
  { id: 'slot-tue-1', day: 2, start: '10:30', end: '10:45', restricted: false },
  { id: 'slot-tue-2', day: 2, start: '14:35', end: '15:00', restricted: false },
  { id: 'slot-tue-3', day: 2, start: '19:00', end: '20:00', restricted: true },
  { id: 'slot-wed-1', day: 3, start: '07:40', end: '08:00', restricted: false },
  { id: 'slot-wed-2', day: 3, start: '14:35', end: '15:00', restricted: false },
  { id: 'slot-thu-1', day: 4, start: '07:40', end: '08:00', restricted: false },
  { id: 'slot-thu-2', day: 4, start: '10:30', end: '12:25', restricted: false },
  { id: 'slot-fri-1', day: 5, start: '11:35', end: '12:35', restricted: false },
  { id: 'slot-sat-1', day: 6, start: '10:00', end: '11:00', restricted: true },
];
const DEFAULT_REC_DAILY = [];
const DEFAULT_REC_WEEKLY = [
  { id: 'rec-week-1', title: 'Look at slides for following week', duration: 15, day: null },
  { id: 'rec-week-2', title: 'Homework printing and prep', duration: 15, day: 3 },
  { id: 'rec-week-3', title: 'Collate student data', duration: 10, day: null },
  { id: 'rec-week-4', title: 'Evaluations', duration: 15, day: null },
  { id: 'rec-week-5', title: 'Clean up emails', duration: 15, day: null },
];
const CELEBRATION_MESSAGES = [
  'Nice one.',
  'One more done — nice work.',
  "That's progress.",
  'Ticked off. Keep going.',
  'Solid work.',
  "That's one less thing.",
  'Nailed it.',
  'Look at you go.',
  'Great work getting that done.',
  'Boom. Sorted.',
];
/* ============================================================
   Date / time helpers
   ============================================================ */
function toDateStr(d){ const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; }
function parseDateStr(s){ const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); }
function addDays(d,n){ const r=new Date(d); r.setDate(r.getDate()+n); return r; }
function startOfWeek(d){ const day=d.getDay(); const diff=(day===0?-6:1-day); return addDays(new Date(d.getFullYear(),d.getMonth(),d.getDate()),diff); }
function timeToMin(t){ const [h,m]=t.split(':').map(Number); return h*60+m; }
function minToLabel(mins){ let h=Math.floor(mins/60), m=mins%60; const ampm=h>=12?'pm':'am'; let h12=h%12; if(h12===0)h12=12; return `${h12}:${String(m).padStart(2,'0')}${ampm}`; }
// Inverse of timeToMin — needed when a meeting splits a slot and the resulting
// fragment needs its own "HH:MM" bounds rather than the parent slot's.
function minToTime(mins){ return `${String(Math.floor(mins/60)).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}`; }
function formatShortDate(dateStr){ const d = parseDateStr(dateStr); return `${DAY_SHORT[d.getDay()]} ${d.getDate()}`; }
function formatDurationHM(mins){ if (mins<=0) return '0m'; const h=Math.floor(mins/60), m=mins%60; if (h===0) return `${m}m`; if (m===0) return `${h}h`; return `${h}h ${m}m`; }
let idSeq = 0;
function genId(){ idSeq += 1; return 'id-'+Date.now().toString(36)+'-'+idSeq; }
/* ============================================================
   Scheduling engine (verified separately with node before wiring into the UI)
   ============================================================ */
function makeTask({ title, duration, dueDate, recurringId=null, recurringDate=null, source='adhoc', pressing=false, order, preference=null, meetingId=null, notBefore=null }){
  // recurringDate: the date this instance was GENERATED for. Kept separate from dueDate
  // because dueDate is user-editable (see instance editing) and the generator's
  // duplicate check keys on this — if it keyed on dueDate, moving an instance's date
  // would make the generator think that week's instance was missing and create another.
  //
  // meetingId / notBefore: set on action points that came OUT of a meeting.
  // notBefore is { date, minute } — the moment the meeting ends. An action point
  // can't be scheduled before the meeting that produced it has actually happened.
  return { id: genId(), title, duration: Number(duration), dueDate, pressing, done:false, doneAt:null, createdAt: order, source, recurringId, recurringDate, preference, actualMinutes:null, pinnedTo: null, meetingId, notBefore };
}
// The later of two { date, minute } boundaries — used so deferring a task can
// only ever push it further out, never pull an existing restriction earlier.
function laterBoundary(a, b){
  if (!a) return b;
  if (!b) return a;
  if (a.date !== b.date) return a.date > b.date ? a : b;
  return a.minute >= b.minute ? a : b;
}
// True when this slot instance starts before the task is allowed to begin.
function blockedByNotBefore(task, inst){
  const nb = task.notBefore;
  if (!nb) return false;
  if (inst.date < nb.date) return true;
  if (inst.date === nb.date && inst.startMin < nb.minute) return true;
  return false;
}
function generateRecurringInstances(existingTasks, recDaily, recWeekly, now, lastGenWeek){
  const newTasks = [];
  // Fall back to dueDate for instances generated before recurringDate existed.
  const existingKeys = new Set(existingTasks.filter(t=>t.recurringId).map(t=>t.recurringId+'|'+(t.recurringDate||t.dueDate)));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thisWeekMonday = startOfWeek(today);
  let start = lastGenWeek ? addDays(parseDateStr(lastGenWeek), 7) : thisWeekMonday;
  const maxBack = addDays(thisWeekMonday, -8*7);
  if (start < maxBack) start = maxBack;
  // Always (re)cover the CURRENT week, even when it has already been generated once.
  // Without this clamp, `start` lands on next Monday as soon as this week has been
  // generated, the loop below never executes, and a recurring task ADDED MID-WEEK
  // produces nothing until the following Monday — it just silently doesn't appear.
  // Re-running the current week is safe and idempotent: every candidate is checked
  // against `existingKeys` first, so nothing is ever duplicated.
  if (start > thisWeekMonday) start = thisWeekMonday;
  let order = Date.now();
  for (let wm = new Date(start); wm <= thisWeekMonday; wm = addDays(wm,7)){
    for (let i=0;i<7;i++){
      const d = addDays(wm,i);
      const dow = d.getDay();
      const dateStr = toDateStr(d);
      if (WEEKDAY_DAYS.includes(dow)){
        recDaily.forEach(def=>{
          const key = def.id+'|'+dateStr;
          if (!existingKeys.has(key)){
            newTasks.push(makeTask({ title: def.title, duration: def.duration, dueDate: dateStr, recurringId: def.id, recurringDate: dateStr, source:'daily', order: order++, preference: def.preference||null }));
            existingKeys.add(key);
          }
        });
      }
    }
    recWeekly.forEach(def=>{
      const targetDate = def.day!=null ? addDays(wm,(def.day-1+7)%7) : addDays(wm,6);
      const dateStr = toDateStr(targetDate);
      const key = def.id+'|'+dateStr;
      if (!existingKeys.has(key)){
        newTasks.push(makeTask({ title: def.title, duration: def.duration, dueDate: dateStr, recurringId: def.id, recurringDate: dateStr, source:'weekly', order: order++ }));
        existingKeys.add(key);
      }
    });
  }
  return { newTasks, newLastGenWeek: toDateStr(thisWeekMonday) };
}
// Never carve a task into a piece smaller than this. Raised from 5 to 15 because a
// 5-minute fragment of a real task is usually swallowed whole by the cost of
// remembering where you were — you reload context and the slot is gone. The trade-off
// is deliberate: small leftovers in a block now stay EMPTY rather than being filled
// with an unusable sliver, so expect marginally more overflow in exchange for
// sessions that are actually long enough to make progress in.
const MIN_CHUNK = 15;
// The floor for any task's own duration, matching MIN_CHUNK so a task can never be
// created smaller than the smallest piece the scheduler is willing to carve.
export const MIN_TASK_MINUTES = 15;
// Where the running timer survives a reload. Device-local by design — see the
// comment on activeTimer in App.
const TIMER_KEY = 'prism.activeTimer';
/*
  SESSIONS MODEL (carve once, then fixed forever)
  ------------------------------------------------
  A task may carry `sessions`: an ordered array of { id, minutesTotal, done, doneAt }.
  No `sessions` field = a single implicit session using the task's own id/duration/done —
  the common case, so small/never-split tasks are completely unaffected.

  THE KEY INVARIANT: once a task has a `sessions` array, its session SIZES are permanent.
  Completing one session never changes the size or identity of any other session, and a
  rebuild never reshapes sessions you haven't touched yet — it only decides which slot
  each still-pending session lands in, in priority + time order. Sessions can be completed
  independently and out of order; the scheduler simply skips over whichever ones are done.

  Splitting (carving) only ever happens for a task that does NOT yet have a `sessions`
  array, at the moment its remaining duration doesn't fit the next slot offered to it in
  the greedy, earliest-first walk. From that point on, its sessions are fixed.

  Due dates still only affect priority ORDER relative to other tasks — they never delay
  a task's own placement. Even a task due weeks out is scheduled into the very next
  available eligible slot, same as before.

  unlockRestricted: when true, catch-up-only slots behave exactly like open slots
  (accept any task, not just urgent ones). Driven by the workload traffic light — see
  computeWorkload below. Always false for the baseline diagnostic pass so the traffic
  light's own read never depends on whether it has already unlocked anything.
*/
/*
  MEETINGS EAT FLEX TIME.

  A meeting is a fixed commitment, not capacity — it isn't scheduled INTO a slot,
  it simply occupies wall-clock time, and any flex slot underneath it stops being
  usable. Drawing meetings on the board without doing this subtraction would let
  the scheduler keep placing work into hours you're sitting in a meeting, and
  would make the traffic light, the overflow warnings, and the "everything has a
  home" banner all quietly wrong.

  Returns the still-free pieces of [slotStart, slotEnd) once every meeting on that
  date is carved out. A meeting covering the whole slot yields nothing; one landing
  mid-slot yields the time on BOTH sides, because a 115-minute block interrupted by
  a half-hour meeting still has two perfectly usable stretches in it. Fragments
  shorter than MIN_CHUNK are dropped — the scheduler can't place anything in them
  anyway, so keeping them would just overstate capacity.
*/
function freeIntervalsWithin(slotStartMin, slotEndMin, meetingsOnDate){
  let intervals = [[slotStartMin, slotEndMin]];
  for (const m of meetingsOnDate){
    const mStart = timeToMin(m.start), mEnd = timeToMin(m.end);
    const next = [];
    for (const [s,e] of intervals){
      if (mEnd <= s || mStart >= e){ next.push([s,e]); continue; } // no overlap
      if (mStart > s) next.push([s, mStart]);   // free time before the meeting
      if (mEnd < e) next.push([mEnd, e]);       // free time after the meeting
    }
    intervals = next;
  }
  return intervals.filter(([s,e]) => e - s >= MIN_CHUNK);
}
function buildScheduleOnce(tasks, slots, now, weeksAhead=SCHEDULE_WEEKS, unlockRestricted=false, demotedTaskIds=null, meetings=[]){
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStr = toDateStr(today);
  const nowMin = now.getHours()*60+now.getMinutes();

  const instances = [];
  for (let i=0;i<weeksAhead*7;i++){
    const d = addDays(today,i);
    const dow = d.getDay();
    const dateStr = toDateStr(d);
    const meetingsToday = meetings.filter(m=>m.date===dateStr);
    slots.forEach(slot=>{
      if (slot.day===dow){
        const startMin=timeToMin(slot.start), endMin=timeToMin(slot.end);
        if (dateStr===todayStr && endMin<=nowMin) return;
        // One instance per free piece. Un-met slots produce exactly one piece
        // spanning the whole slot, so the common case is unchanged.
        const pieces = freeIntervalsWithin(startMin, endMin, meetingsToday);
        pieces.forEach(([pieceStart, pieceEnd], pieceIdx)=>{
          if (dateStr===todayStr && pieceEnd<=nowMin) return;
          // Fragments keep the parent slotId so manual pins still resolve (see
          // clearStalePins, which keys on slotId); the key gets a suffix only
          // when a slot actually split, keeping existing keys stable.
          const key = slot.id+'|'+dateStr+(pieces.length>1?'|'+pieceIdx:'');
          instances.push({ key, slotId:slot.id, date:dateStr, dayOfWeek:dow, start:minToTime(pieceStart), end:minToTime(pieceEnd), startMin:pieceStart, endMin:pieceEnd, restricted:slot.restricted, remaining:pieceEnd-pieceStart, assigned:[], shortenedByMeeting: pieceEnd-pieceStart < endMin-startMin });
        });
      }
    });
  }
  instances.sort((a,b)=> a.date===b.date ? a.startMin-b.startMin : (a.date<b.date?-1:1));
  const instanceIndexOf = new Map(instances.map((inst,idx)=>[inst,idx]));

  const isUrgent = t => t.pressing || (t.dueDate && t.dueDate<todayStr);
  const prefRank = t => t.preference==='earliest' ? -1 : (t.preference==='latest' ? 1 : 0);
  const isOverdue = t => t.dueDate && t.dueDate<todayStr;

  /*
    STRICT vs RELAXED restricted-slot eligibility -- a due-dated task at genuine risk
    of missing its deadline (critical slack) gains the same relaxed access to
    restricted (catch-up-only) slots that an overdue/pressing task already has, for
    actual PLACEMENT. Slack is computed ONCE under STRICT eligibility (avoids
    circularity -- slack must exist before we can ask "is this task critical"). If
    strict-eligibility slack is at or below zero, the task is CRITICAL. This can
    never make a task worse off than before -- it only opens additional slots to a
    task that was otherwise mathematically going to miss its own deadline.
  */
  function eligibleMinutesBeforeStrict(task, dueDateStr){
    let total = 0;
    for (const inst of instances){
      if (inst.date > dueDateStr) continue;
      const canUseRestricted = inst.restricted ? isUrgent(task) : true;
      if (!canUseRestricted) continue;
      // Time before an action point's meeting isn't available to it, so it must
      // not count toward slack — otherwise the task looks less at-risk than it is.
      if (blockedByNotBefore(task, inst)) continue;
      total += inst.endMin - inst.startMin;
    }
    return total;
  }
  function computeSlack(task){
    if (!task.dueDate || isOverdue(task)) return null;
    const remaining = task.sessions && task.sessions.length
      ? Math.max(0, task.duration - task.sessions.filter(s=>s.done).reduce((s,x)=>s+x.minutesTotal,0))
      : task.duration;
    const eligible = eligibleMinutesBeforeStrict(task, task.dueDate);
    return eligible - remaining;
  }
  const slackCache = new Map();
  const slackOf = t => {
    if (!slackCache.has(t.id)) slackCache.set(t.id, computeSlack(t));
    return slackCache.get(t.id);
  };
  // isCritical: strict-eligibility slack is at or below zero -- this task cannot
  // make its own deadline under the old rules alone. hasSpecialAccess grants the
  // SAME relaxed restricted-slot access an overdue/pressing task already has to
  // any critical due-dated task too, used for actual PLACEMENT decisions below.
  const isCritical = t => { const s = slackOf(t); return s !== null && s <= 0; };
  const hasSpecialAccess = t => isUrgent(t) || isCritical(t);
  const priorityTier = t => {
    // DEMOTION (used by the corrective second pass in buildSchedule below): an
    // overdue/pressing task identified as having consumed capacity a genuinely
    // achievable due-dated task needed is pushed to the very bottom tier here, so
    // the due-dated task it was blocking gets first claim this time around.
    if (demotedTaskIds && demotedTaskIds.has(t.id)) return 4;
    const slack = slackOf(t);
    if (slack !== null && slack <= 0) return 0;
    if (isOverdue(t) || t.pressing) return 1;
    if (t.dueDate) return 2;
    return 3;
  };

  const pending = tasks.filter(t=>!t.done);
  const sortedTasks = [...pending].sort((a,b)=>{
    const pa = priorityTier(a), pb = priorityTier(b);
    if (pa!==pb) return pa-pb;
    if (pa===0 || pa===2){
      if (a.dueDate!==b.dueDate) return a.dueDate<b.dueDate?-1:1;
      const sa = slackOf(a), sb = slackOf(b);
      if (sa!==sb) return sa-sb;
      const pr = prefRank(a)-prefRank(b);
      if (pr!==0) return pr;
      return a.createdAt-b.createdAt;
    }
    if (pa===1){
      if (a.dueDate && b.dueDate && a.dueDate!==b.dueDate) return a.dueDate<b.dueDate?-1:1;
      if (a.dueDate && !b.dueDate) return -1;
      if (!a.dueDate && b.dueDate) return 1;
      return a.createdAt-b.createdAt;
    }
    return a.createdAt-b.createdAt; // tier 3 (undated) and tier 4 (demoted): creation order
  });

  /*
    FLUID REMAINING-WORK MODEL (replaces the old "carve once, fixed forever" sessions).
    ---------------------------------------------------------------------------------
    Previously, once a task was split into `sessions`, those pieces' SIZES and ORDER
    were permanent — a rebuild only decided which slot each pending piece landed in,
    walking them strictly in their original array order. That meant a task carved one
    way before a new, more urgent task existed could never be reshaped to make room —
    it just kept re-occupying slots in its old shape, even after due-date priority
    should have pushed it later or into different-sized gaps. This is what caused
    schedules to stop reordering when a new due-soon task was added: existing split
    tasks were structurally locked in, regardless of the (correctly recomputed) sort
    order feeding into placement.

    Fix: COMPLETED sessions are the only thing that stay fixed (they're historical
    record — time already logged against them, shown in stats). Everything NOT yet
    done — whether the task was never split, split once, or split several times
    before — is collapsed back into a single "remaining minutes" pool on every
    recompute, and treated exactly like a brand-new unsplit task: free to be carved
    fresh, in whatever shape current slot availability and current priority order
    call for. There is no cursor walking a frozen array anymore — every task's pending
    work is fully re-evaluated, every render, with zero memory of its previous shape.

    Net effect: due-date priority (see sortedTasks above) now has real teeth — a task
    can always be pushed later, split differently, or have a lower-priority task's
    remaining work displaced around it, because nothing about "not yet done" work is
    ever grandfathered in from a prior render.
  */
  const completedByTask = new Map(); // task.id -> array of its DONE sessions, kept exactly as-is
  const freeform = new Map();        // task.id -> [{ id, minutesTotal }] remaining pool, freely carvable

  // Piece ids are derived from (task.id, a per-task counter) rather than genId(),
  // so that an unchanged carve — same tasks/slots/priority/now — reproduces the
  // exact same ids on every call. genId() (timestamp + global counter) produced a
  // brand-new id for every freeform/carved piece on every single recompute, even
  // when nothing about the task had actually changed. Since buildSchedule reruns
  // on every render (see the "zero memory of previous shape" note above) and its
  // sessionUpdates get persisted back onto the task (see sessionsEqual below),
  // that meant the persisted shape never matched the next render's freshly
  // generated ids, which never matched the render after that — an unbroken write
  // loop that kept resetting the save debounce and left the app stuck on
  // "Saving..." forever. A genuinely different carve (task/slot/priority actually
  // changed) still gets different ids here, so real changes are still detected
  // and saved correctly — only a no-op recompute now looks like a no-op.
  const pieceCounters = new Map(); // task.id -> next piece index
  function nextPieceId(taskId){
    const n = pieceCounters.get(taskId) || 0;
    pieceCounters.set(taskId, n + 1);
    return taskId + '-s' + n;
  }

  for (const task of sortedTasks){
    if (task.sessions && task.sessions.length){
      const completed = task.sessions.filter(s=>s.done).map(s=>({...s}));
      const doneMinutes = completed.reduce((sum,s)=>sum+s.minutesTotal,0);
      completedByTask.set(task.id, completed);
      const remainingMinutes = Math.max(0, task.duration - doneMinutes);
      if (remainingMinutes > 0){
        freeform.set(task.id, [{ id: nextPieceId(task.id), minutesTotal: remainingMinutes }]);
      } else {
        freeform.set(task.id, []); // fully completed via its sessions already
      }
    } else {
      completedByTask.set(task.id, []);
      freeform.set(task.id, [{ id: task.id, minutesTotal: task.duration }]);
    }
  }

  function isTaskFullyPlaced(task){
    return freeform.get(task.id).length===0;
  }

  /*
    PLACEMENT NARRATIVE — the scheduler already knows exactly WHY each task landed
    where it did (priority tier, slack, criticality, demotion, pin, which pass claimed
    it), but until now it threw all of that away the moment placement finished. This
    turns that reasoning into a plain-English sentence attached to each assignment, so
    a surprising schedule can be interrogated instead of just stared at.

    `kind` is supplied by the call site and says WHICH PASS placed the task; everything
    else is derived from the task's own standing at this moment.
  */
  function placementNarrative(task, inst, kind){
    if (kind==='pinned'){
      return 'Pinned here manually. It overrides the scheduler — click the pin icon to release it.';
    }
    const tier = priorityTier(task);
    const slack = slackOf(task);
    const slotDesc = inst.restricted
      ? (unlockRestricted ? 'a catch-up block, unlocked because things are tight' : 'a catch-up block')
      : 'the earliest open block with room';

    if (tier===4){
      return `Pushed down the queue on purpose: it was using capacity that a task with a real deadline needed. Landed in ${slotDesc}.`;
    }
    if (tier===0){
      const days = slack!==null ? Math.round(slack) : null;
      return `Top priority — due ${formatShortDate(task.dueDate)} with only ${days!==null?days:'0'} spare minutes of eligible time before then, so it gets first claim. Placed in ${slotDesc}.`;
    }
    if (tier===1){
      if (isOverdue(task)) return `Overdue (was due ${formatShortDate(task.dueDate)}), so it's treated as urgent and can use catch-up blocks. Placed in ${slotDesc}.`;
      return `Marked pressing, so it's treated as urgent and can use catch-up blocks. Placed in ${slotDesc}.`;
    }
    if (tier===2){
      const spare = slack!==null ? ` (about ${Math.round(slack)} spare minutes of eligible time before then)` : '';
      return `Due ${formatShortDate(task.dueDate)}${spare}. Given ${slotDesc} after anything more urgent was placed.`;
    }
    return `No due date, so it fills in around dated work. Given ${slotDesc}.`;
  }

  function tryPlaceOne(inst, task, ignoreLookahead=false, kind='normal'){
    // An action point can't be worked on before the meeting that produced it has
    // finished. This is the single funnel every placement path goes through —
    // including pinned placement — so the guard belongs here rather than in each
    // caller.
    if (blockedByNotBefore(task, inst)) return false;
    // Every task's pending work is freeform now — carving is always allowed, every
    // render, so higher-priority tasks can always claim the earliest slot and push
    // lower-priority remaining work later or into a different shape.
    const pieces = freeform.get(task.id);
    if (!pieces.length) return false;
    const front = pieces[0];
    if (front.minutesTotal <= inst.remaining){
      inst.assigned.push({ ...task, id: task.id, sessionId: front.id, duration: front.minutesTotal, placementReason: placementNarrative(task, inst, kind) });
      inst.remaining -= front.minutesTotal;
      pieces.shift();
      return true;
    }
    /*
      LOOKAHEAD — prefer a single later slot big enough for the WHOLE remaining chunk
      over carving it up to fit what's on offer right now. Without this, a task could
      get needlessly split into several small pieces even when one bigger slot later
      in the window could have held all of it at once — purely because slots are
      walked in date order and the first (too-small) one offered gets used regardless.

      RESTRICTED TO THE ABSOLUTE BOTTOM OF THE RANKING ONLY: tier 2 (not overdue, not
      pressing) AND no due date at all. This is deliberate, not an oversight: a task
      that waits for a "nicer" later slot is, by definition, giving up its claim on the
      CURRENT slot — and if a lower-priority competitor then takes that slot instead,
      the waiting task has been pushed BEHIND something less urgent than itself. That
      directly breaks "due date is the dominant ranking signal" (the actual bug this
      file exists to fix) for the sake of a cosmetic packing preference.

      Tier alone isn't a tight enough condition: even WITHIN tier 2, a task with an
      earlier due date still outranks one with a later due date, and any due-dated
      tier-2 task outranks an undated tier-2 task (see sortedTasks above). So a tier-2
      task with a due date could still defer and lose its slot to another tier-2 task
      that has no due date (or a later one) and fits the current slot immediately —
      the same failure one level down. The ONLY position with nothing left below it to
      be overtaken by is tier 2 AND undated — that combination always sorts dead last,
      so letting it defer for nicer packing can never cost it ground to anything.
      Every other task — overdue, pressing, or simply due-dated — always carves
      immediately to fit whatever slot the priority walk currently offers it.
    */
    if (!ignoreLookahead && priorityTier(task)===2 && !task.dueDate && inst.remaining >= MIN_CHUNK){
      const instIdx = instanceIndexOf.get(inst);
      const laterFit = instances.find((later, idx) => {
        if (idx <= instIdx) return false; // only look forward from here
        if (later.restricted) return false; // don't defer into special slots on a hunch
        return later.remaining >= front.minutesTotal;
      });
      if (laterFit) return false; // hold this piece back; a better slot exists later
    }
    /*
      CARVING — both halves must clear MIN_CHUNK, not just the piece placed here.

      Taking the whole of inst.remaining looks right but silently breaks the floor:
      a 45min task meeting a 20min slot would carve 20 and leave 25; that 25 later
      meets a 15min slot, carves 15, and leaves 10 — which then places WHOLE via the
      "it fits" branch above, with no floor check, producing exactly the 10-minute
      fragment the floor exists to prevent. Caught by the fuzz test: 303 sub-floor
      pieces across 400 trials, all of them remainders rather than direct carves.

      So the carve is capped at (front - MIN_CHUNK): whatever is taken here must leave
      at least a viable session behind. If that cap drops below MIN_CHUNK itself,
      there's no split of this piece where both halves are usable, so we decline the
      slot entirely and let the task find a bigger one.
    */
    const maxCarveLeavingViableRemainder = front.minutesTotal - MIN_CHUNK;
    const carvedMinutes = Math.min(inst.remaining, maxCarveLeavingViableRemainder);
    if (carvedMinutes >= MIN_CHUNK){
      const remainderMinutes = front.minutesTotal - carvedMinutes;
      const carvedId = nextPieceId(task.id);
      const remainderId = nextPieceId(task.id);
      pieces.splice(0, 1, { id: carvedId, minutesTotal: carvedMinutes }, { id: remainderId, minutesTotal: remainderMinutes });
      inst.assigned.push({ ...task, id: task.id, sessionId: carvedId, duration: carvedMinutes, placementReason: placementNarrative(task, inst, kind) });
      inst.remaining -= carvedMinutes;
      pieces.shift();
      return true;
    }
    return false;
  }

  /*
    PASS 0 — MANUAL PINS (drag-and-drop overrides).
    ------------------------------------------------
    A task with `pinnedTo: { slotId, date }` was manually dragged into that specific
    slot instance by the user. Manual intent beats every automatic rule, so pins are
    honoured FIRST, before any priority-based placement, and they bypass:
      - restricted ("catch-up only") gating — you explicitly chose this block
      - the lookahead deferral heuristic — you asked for HERE, not "somewhere nicer"
      - priority ordering — a pinned task claims its slot even if something more
        urgent would otherwise have taken that space

    A pin is a request for a STARTING point, not a guarantee the whole task fits: as
    much of the task's remaining work as the slot can hold is placed there, and any
    remainder flows through the normal passes below exactly as usual. This keeps pins
    from ever "losing" work — you can pin a 90-minute task into a 20-minute block and
    it simply starts there and continues elsewhere.

    Stale pins (slot deleted, or date now in the past) simply never match an instance
    and are ignored here; they're cleaned off the task separately in the UI layer.
  */
  for (const inst of instances){
    for (const task of sortedTasks){
      if (!task.pinnedTo) continue;
      if (task.pinnedTo.slotId !== inst.slotId || task.pinnedTo.date !== inst.date) continue;
      if (isTaskFullyPlaced(task) || inst.remaining<=0) continue;
      tryPlaceOne(inst, task, true, 'pinned');
    }
  }

  /*
    TWO-PASS PLACEMENT — fixes "open slots left empty while a catch-up slot earlier
    in the week grabs ordinary tasks".

    Previously this was a single chronological pass: whichever slot came first in date
    order got first refusal on every task, including plain/generic ones. That let an
    unlocked catch-up slot sitting earlier in the week soak up ordinary undated tasks
    before the walk ever reached a perfectly good OPEN slot later on — even though the
    open slot needed no unlocking and was an equally good (often better) home for that
    task. This is exactly what was happening in the real schedule: catch-up-only blocks
    on Saturday/Tuesday evening were absorbing everyday tasks while genuinely open
    Wednesday slots sat empty.

    Fix: two full chronological passes over every instance.
      PASS 1 — each slot type takes only ITS OWN native category:
        - restricted (locked or unlocked): urgent tasks only
        - open (including the former "large tasks" focus blocks): ANY task — this is
          the real fallback capacity
      PASS 2 — now that every open slot in the whole window has had first claim on
      generic tasks, sweep again and let unlocked-restricted slots absorb whatever
      generic tasks are STILL unplaced, using their leftover room.

    Net effect: a restricted-but-unlocked slot can never take an ordinary task away
    from an open slot elsewhere in the same scheduling window — it only ever catches
    genuine overflow that open slots couldn't fit anywhere. Urgent placement and
    session-carving rules are completely unchanged; only the ORDER in which "anything
    goes" fallback capacity is offered has moved.

    Verified with an isolated test harness: a 10-check regression suite (urgent/overdue
    access, session carving, minute conservation), a 500-trial randomized invariant
    fuzz test (no dropped tasks, no over-allocated slots), and a 1000-trial seeded
    comparison against the original single-pass logic showing zero cases where this
    fix places MORE generic work into restricted slots than before (157 trials
    strictly better, rest tied).
  */
  // ---- PASS 1: native category only per slot type ----
  // NOTE: restricted eligibility here uses hasSpecialAccess (isUrgent OR critical
  // due-date slack), not plain isUrgent -- see the STRICT vs RELAXED eligibility
  // comment above.
  for (const inst of instances){
    if (inst.restricted){
      // Locked or unlocked, pass 1 only ever serves urgent/critical tasks here.
      for (const task of sortedTasks){
        if (isTaskFullyPlaced(task) || inst.remaining<=0) continue;
        if (!hasSpecialAccess(task)) continue;
        tryPlaceOne(inst, task);
      }
    } else {
      // genuinely open slots (including the former "large tasks" focus blocks): the
      // real fallback capacity — any eligible task, in priority order.
      for (const task of sortedTasks){
        if (isTaskFullyPlaced(task) || inst.remaining<=0) continue;
        tryPlaceOne(inst, task);
      }
    }
  }

  // ---- PASS 2: unlocked-restricted slots absorb remaining overflow ----
  // Only reached for tasks that pass 1 (across the ENTIRE window, including every open
  // slot) could not place. Chronological order still applies within this pass, so
  // earlier leftover room is still used before later leftover room.
  for (const inst of instances){
    if (inst.restricted && unlockRestricted){
      for (const task of sortedTasks){
        if (isTaskFullyPlaced(task) || inst.remaining<=0) continue;
        tryPlaceOne(inst, task);
      }
    }
  }

  // Full session history per task: completed sessions (preserved, always first) +
  // freshly placed pieces this render (in chronological order) + still-pending pieces.
  // Used for chunk-count annotation and for writing sessions back onto the task so the
  // UI reflects this render's live computation — see FLUID REMAINING-WORK MODEL above.
  const fullHistory = new Map();
  for (const task of sortedTasks){
    const completed = completedByTask.get(task.id) || [];
    const placedForThisTask = [];
    for (const inst of instances){
      for (const item of inst.assigned){
        if (item.id===task.id) placedForThisTask.push({ id:item.sessionId, minutesTotal:item.duration, done:false, doneAt:null });
      }
    }
    const stillPending = freeform.get(task.id).map(p=>({ id:p.id, minutesTotal:p.minutesTotal, done:false, doneAt:null }));
    fullHistory.set(task.id, [...completed, ...placedForThisTask, ...stillPending]);
  }

  function sessionCountFor(task){
    return fullHistory.get(task.id).length;
  }
  function sessionIndexFor(task, sessionId){
    return fullHistory.get(task.id).findIndex(s=>s.id===sessionId) + 1;
  }

  for (const inst of instances){
    inst.assigned = inst.assigned.map(item=>{
      const task = sortedTasks.find(t=>t.id===item.id);
      const count = sessionCountFor(task);
      const idx = sessionIndexFor(task, item.sessionId);
      // Splitting is often the most surprising thing the scheduler does, so it's
      // spelled out explicitly rather than left to the terse "2·15m" chip.
      const chunkNote = count>1
        ? ` This is part ${idx} of ${count} — the ${task.duration}min task was split because no single block had room for all of it.`
        : '';
      return { ...item, isPartial: count>1, chunkIndex: idx, chunkCount: count, placementReason: (item.placementReason||'') + chunkNote };
    });
  }

  const overflow = [];
  for (const task of sortedTasks){
    const remaining = freeform.get(task.id);
    const count = fullHistory.get(task.id).length;
    for (const piece of remaining){
      overflow.push({ ...task, id: task.id, sessionId: piece.id, duration: piece.minutesTotal, isPartial: count>1, chunkIndex: sessionIndexFor(task, piece.id), chunkCount: count });
    }
  }

  // What the caller should persist onto each task's `sessions` field going forward.
  // Always the FULL current-render history (completed + placed + still-pending) when
  // there's more than one session total, so the UI reflects this render's live shape —
  // never a frozen shape from a previous render. A task with only ever one session
  // (never split, nothing completed yet) isn't written back at all, same as before.
  const sessionUpdates = new Map();
  for (const task of sortedTasks){
    const full = fullHistory.get(task.id);
    if (full.length > 1) sessionUpdates.set(task.id, full);
  }

  return { instances, overflow, sessionUpdates };
}

/*
  CORRECTIVE TWO-PASS SCHEDULING — buildScheduleOnce's slack is computed per task IN
  ISOLATION (as if that task were the only one competing for capacity before its due
  date). That's accurate for the common case, but testing found a real gap: an
  overdue/pressing task has NO computed slack (nothing stops it early) and can still
  consume capacity that a due-dated task's isolated slack calculation assumed would be
  available — causing that due-dated task to miss a deadline it was genuinely able to
  hit, purely because something with no ticking clock of its own got there first.

  Since making due dates is the top priority, this wrapper runs buildScheduleOnce
  twice when needed:
    PASS A (tentative) — run exactly as before with no demotions.
    CHECK — for every due-dated (non-overdue) task that was mathematically achievable
    on its own (its due date's genuinely eligible capacity is >= its own duration,
    ignoring all other tasks) but still missed its deadline in pass A, find which
    overdue/pressing tasks landed in an instance dated on/before that missed
    deadline — those are the ones that stole its capacity.
    PASS B (corrective) — if any such tasks were found, demote them (see
    priorityTier's demotedTaskIds check in buildScheduleOnce) and rebuild once more.
    A task that was NEVER individually achievable is left as overflow either way —
    correctly, since no reordering can save work that simply doesn't fit anywhere.

  This is bounded at exactly two scheduling passes (never unbounded iteration), fully
  deterministic, and directly closes the gap found in testing without attempting a
  full (NP-hard) optimal multi-task deadline solver.
*/
function computeEligibleMinutesBeforeStandalone(task, dueDateStr, slots, now, weeksAhead, isUrgentFn, meetings=[]){
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStr = toDateStr(today);
  const nowMin = now.getHours()*60+now.getMinutes();
  let total = 0;
  for (let i=0;i<weeksAhead*7;i++){
    const d = addDays(today,i);
    const dateStr = toDateStr(d);
    if (dateStr > dueDateStr) continue;
    const dow = d.getDay();
    const meetingsToday = meetings.filter(m=>m.date===dateStr);
    for (const slot of slots){
      if (slot.day!==dow) continue;
      const startMin=timeToMin(slot.start), endMin=timeToMin(slot.end);
      if (dateStr===todayStr && endMin<=nowMin) continue;
      const canUseRestricted = slot.restricted ? isUrgentFn(task) : true;
      if (!canUseRestricted) continue;
      // Must subtract meetings here too. This function decides whether a task was
      // EVER individually achievable before its due date; counting meeting hours
      // as available would call a task achievable when it isn't, and pass B would
      // then demote other work to chase a deadline that was never reachable.
      for (const [s,e] of freeIntervalsWithin(startMin, endMin, meetingsToday)){
        if (dateStr===todayStr && e<=nowMin) continue;
        if (blockedByNotBefore(task, { date: dateStr, startMin: s })) continue;
        total += e - s;
      }
    }
  }
  return total;
}

function buildSchedule(tasks, slots, now, weeksAhead=SCHEDULE_WEEKS, unlockRestricted=false, meetings=[]){
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStr = toDateStr(today);
  const isUrgentFn = t => t.pressing || (t.dueDate && t.dueDate<todayStr);

  const passA = buildScheduleOnce(tasks, slots, now, weeksAhead, unlockRestricted, null, meetings);

  // Find due-dated, non-overdue tasks that were individually achievable but still
  // missed their deadline in pass A.
  const pending = tasks.filter(t=>!t.done);
  const blockedTasks = [];
  for (const task of pending){
    if (!task.dueDate || task.dueDate < todayStr) continue; // skip undated/overdue
    const remainingDone = task.sessions && task.sessions.length
      ? task.sessions.filter(s=>s.done).reduce((s,x)=>s+x.minutesTotal,0)
      : 0;
    const remaining = Math.max(0, task.duration - remainingDone);
    if (remaining<=0) continue; // already fully done
    const eligible = computeEligibleMinutesBeforeStandalone(task, task.dueDate, slots, now, weeksAhead, isUrgentFn, meetings);
    if (eligible < remaining) continue; // never achievable even alone — pass A's overflow is correct, nothing to fix

    // Did it fully place on or before its due date in pass A?
    let latestDate = null, totalPlaced = 0;
    for (const inst of passA.instances){
      for (const item of inst.assigned){
        if (item.id===task.id){
          totalPlaced += item.duration;
          if (!latestDate || inst.date>latestDate) latestDate = inst.date;
        }
      }
    }
    const overflowForTask = passA.overflow.filter(o=>o.id===task.id).reduce((s,o)=>s+o.duration,0);
    const madeDeadline = overflowForTask===0 && latestDate && latestDate<=task.dueDate;
    if (!madeDeadline) blockedTasks.push(task);
  }

  if (blockedTasks.length===0) return passA; // no correction needed — common case

  /*
    Identify DEMOTION CANDIDATES: any task that consumed an instance dated on/before
    a blocked task's due date, where demoting that task costs NOTHING — i.e. it
    either (a) has no ticking clock of its own (overdue/pressing), or (b) ALSO
    failed to fully make its own deadline in pass A regardless (whether because it
    was never individually achievable, or because it too got squeezed) — so freeing
    the capacity it partially consumed can only help, never create a new failure,
    since that task was already going to be counted as a miss either way. This
    closes the gap where one due-dated task's partial, ultimately-futile consumption
    of shared capacity blocked a DIFFERENT due-dated task that had a genuinely
    achievable path to its own deadline.
  */
  function madeOwnDeadlineInPassA(task){
    if (!task.dueDate) return true; // undated tasks have no deadline to miss
    if (task.dueDate < todayStr) return false; // overdue tasks are handled by the isOverdueOrPressing branch, not this one
    let latestDate = null;
    for (const inst of passA.instances){
      for (const item of inst.assigned){
        if (item.id===task.id && (!latestDate || inst.date>latestDate)) latestDate = inst.date;
      }
    }
    const overflowForIt = passA.overflow.some(o=>o.id===task.id);
    return !overflowForIt && latestDate && latestDate<=task.dueDate;
  }
  const earliestBlockedDue = blockedTasks.reduce((min,t)=> (!min || t.dueDate<min) ? t.dueDate : min, null);
  const demotedTaskIds = new Set();
  for (const inst of passA.instances){
    if (inst.date > earliestBlockedDue) continue;
    for (const item of inst.assigned){
      const task = pending.find(t=>t.id===item.id);
      if (!task) continue;
      // NOTE: a blocked task itself IS a valid demotion candidate for capacity it
      // consumed before ANOTHER blocked task's deadline — a task that already missed
      // its own deadline (blocked) costs nothing extra by being demoted further, and
      // may be partially responsible for blocking a DIFFERENT blocked task. There is
      // no infinite-loop risk: demotion only ever runs pass B once (see below), it
      // never recurses.
      const isOverdueOrPressing = task.pressing || (task.dueDate && task.dueDate<todayStr);
      if (isOverdueOrPressing){ demotedTaskIds.add(task.id); continue; }
      if (task.dueDate && !madeOwnDeadlineInPassA(task)){
        demotedTaskIds.add(task.id); // it missed its own deadline anyway — demoting it costs nothing
      }
    }
  }

  if (demotedTaskIds.size===0) return passA; // nothing identifiable to demote — pass A stands

  const passB = buildScheduleOnce(tasks, slots, now, weeksAhead, unlockRestricted, demotedTaskIds, meetings);
  return passB;
}
/*
  Auto-expiry for daily recurring tasks whose definition says NOT to carry over
  (e.g. "Check emails" — if you miss a day, that day's instance quietly drops rather
  than piling up as an overdue task competing for tomorrow's slots).
  A task marked `pressing` is never auto-expired — an explicit flag on it means the
  person cared enough to mark it, so it should stay until they deal with it themselves.
  Tasks whose definition doesn't set autoExpire are untouched and keep carrying over.

  Now covers WEEKLY definitions too, not just daily. Weekly recurring work is where
  backlog compounds worst: five weekly tasks missed for three weeks is fifteen overdue
  items competing for the same slots, most of which no longer need doing at all —
  nobody collates last fortnight's student data. Expiry is per-definition and opt-in,
  so anything you genuinely want to carry over still does.
*/
function applyAutoExpiry(tasks, recDaily, recWeekly, todayStr){
  let changed = false;
  const next = tasks.map(t=>{
    if (t.done || t.pressing || !t.recurringId) return t;
    if (!(t.dueDate && t.dueDate < todayStr)) return t;
    const def = recDaily.find(d=>d.id===t.recurringId) || recWeekly.find(d=>d.id===t.recurringId);
    if (def && def.autoExpire){
      changed = true;
      return { ...t, done:true, doneAt:Date.now(), autoExpired:true };
    }
    return t;
  });
  return changed ? next : tasks;
}
/*
  Stale pin cleanup — a manual drag-and-drop pin points at one specific slot instance
  ({ slotId, date }). That target can stop existing for two ordinary reasons:
    1. the date has passed (the block came and went), or
    2. the slot itself was deleted in Settings.
  Either way the pin can never be honoured again, so it's cleared off the task and the
  task rejoins normal automatic scheduling rather than silently carrying a dead pin
  forever. Runs on the same cadence as applyAutoExpiry.
*/
function clearStalePins(tasks, slots, todayStr){
  let changed = false;
  const liveSlotIds = new Set(slots.map(s=>s.id));
  const next = tasks.map(t=>{
    if (!t.pinnedTo) return t;
    const expired = t.pinnedTo.date < todayStr;
    const slotGone = !liveSlotIds.has(t.pinnedTo.slotId);
    if (expired || slotGone){
      changed = true;
      return { ...t, pinnedTo: null };
    }
    return t;
  });
  return changed ? next : tasks;
}
/*
  Live completion stats — derived straight from tasks, never a separate log. A task
  counts once, on the calendar day its doneAt was set (for a split task, that's the day
  the LAST session was completed). Un-completing something removes it from the count on
  the next render, since these are always a reflection of current state, not history.
*/
/*
  COMPLETION RECORDS + ARCHIVING
  --------------------------------
  Completed tasks used to live in `tasks` forever — nothing ever removed them. Over a
  school year that's thousands of dead objects riding along in every localStorage write
  and being re-filtered by every scheduler pass, purely so the stats bar can count them.

  Fix: a completed task older than ARCHIVE_AFTER_DAYS is compacted into a small
  COMPLETION RECORD and moved out of `tasks` into `archive`. The record keeps exactly
  what the stats and trends views need (when it was done, estimated vs actual minutes,
  whether it was recurring) and drops everything the scheduler needed but history
  doesn't — sessions, pins, preferences, due dates.

  Everything that reports on completions reads the UNION of live-completed tasks and
  archived records via completionRecords(), so archiving never changes a single number
  on screen; it only stops the live list from growing without bound.
*/
function toCompletionRecord(task){
  return {
    id: task.id,
    title: task.title,
    doneAt: task.doneAt,
    duration: task.duration,
    actualMinutes: getActualMinutes(task),
    recurringId: task.recurringId || null,
  };
}
function completionRecords(tasks, archive){
  const live = tasks.filter(t=>t.done && t.doneAt).map(toCompletionRecord);
  return [...archive, ...live];
}
function archiveOldCompleted(tasks, archive, nowMs){
  const cutoff = nowMs - ARCHIVE_AFTER_DAYS*24*60*60*1000;
  const isStale = t => t.done && t.doneAt && t.doneAt < cutoff;
  const stale = tasks.filter(isStale);
  if (!stale.length) return null; // nothing to do — caller keeps existing state
  return {
    tasks: tasks.filter(t=>!isStale(t)),
    archive: [...archive, ...stale.map(toCompletionRecord)],
  };
}
function computeStats(records, now){
  const todayStr = toDateStr(now);
  const weekStartStr = toDateStr(startOfWeek(now));
  const weekEndStr = toDateStr(addDays(startOfWeek(now),6));
  const monthPrefix = todayStr.slice(0,7);
  const yearPrefix = todayStr.slice(0,4);
  let day=0, week=0, month=0, year=0;
  for (const r of records){
    if (!r.doneAt) continue;
    const dStr = toDateStr(new Date(r.doneAt));
    if (dStr === todayStr) day++;
    if (dStr >= weekStartStr && dStr <= weekEndStr) week++;
    if (dStr.slice(0,7) === monthPrefix) month++;
    if (dStr.slice(0,4) === yearPrefix) year++;
  }
  return { day, week, month, year };
}
/*
  Time-tracking data readers — used by the term trends view.
  getActualMinutes: total logged actual time for a task. For a split task this only
  counts if EVERY session has logged time — partial data would make the comparison
  misleading, so an incomplete task is simply excluded rather than under-counted.
  Archived completion records have no sessions, so this falls through to their flat
  actualMinutes field — the same function works for both shapes.
*/
function getActualMinutes(task){
  if (task.sessions && task.sessions.length){
    if (task.sessions.some(s=>s.actualMinutes==null)) return null;
    return task.sessions.reduce((sum,s)=>sum+(s.actualMinutes||0),0);
  }
  return task.actualMinutes;
}
function computeAccuracy(records){
  const withData = records.filter(r=>r.actualMinutes!=null && r.duration>0);
  if (!withData.length) return null;
  const totalEstimate = withData.reduce((s,r)=>s+r.duration,0);
  const totalActual = withData.reduce((s,r)=>s+r.actualMinutes,0);
  return { count: withData.length, ratio: totalActual/totalEstimate };
}
function computeWeeklyVolume(records, weekStartKeys){
  return weekStartKeys.map(wk=>{
    const wkEnd = toDateStr(addDays(parseDateStr(wk),6));
    const count = records.filter(r=>{
      if (!r.doneAt) return false;
      const dStr = toDateStr(new Date(r.doneAt));
      return dStr>=wk && dStr<=wkEnd;
    }).length;
    return { weekStart: wk, count };
  });
}
/*
  Workload traffic light — TIME-based, not task-count-based.

  Always computed from a BASELINE schedule (catch-up slots still gated to urgent-only),
  never from the live/possibly-unlocked one — otherwise unlocking would relieve the
  overflow, which would look less busy, which would re-lock, which would look busy
  again... an oscillating feedback loop. Reading from baseline keeps the diagnosis
  stable: it only changes when the actual task list, slots, or recurring defs change.

  What counts as "overflow": total MINUTES of non-recurring (adhoc) work that lands
  after this week's Sunday under the baseline (gated) schedule, or that doesn't fit at
  all within the scheduling window — but ONLY for tasks that have no due date, or whose
  due date falls this week or earlier. A task deliberately due next month landing three
  weeks out isn't overload, it's correct prioritisation, so it's excluded on purpose.

  The red/orange line is your own actual weekly capacity: total minutes across your
  flex slots, minus what your recurring dailies/weeklies already claim every week. If
  the overflow is at least that big, clearing it would genuinely take more than another
  full week at your normal pace — that's "red". Anything less than that, but still
  above zero, is "orange".

  UTILISATION / THE 80% RULE: overflow alone only fires once work is ALREADY spilling
  past the week — by which point you have no room to absorb a sick day, a parent
  meeting, or a task running long. Utilisation answers the earlier question: how full
  is the flex time you have LEFT this week? (Past slots are already excluded from the
  schedule's instances, so mid-week this naturally reads as remaining capacity.)
  Crossing HIGH_UTILISATION turns the light orange BEFORE anything overflows, so a
  week that's technically fitting but has no slack still announces itself.

  Note this deliberately does NOT change what unlocks catch-up blocks — that's still
  driven by 'red' and due-date risk only. The 80% rule is a warning, not an action.
*/
function computeWorkload(tasks, baselineSchedule, slots, recDaily, recWeekly, now){
  const weekEndStr = toDateStr(addDays(startOfWeek(now),6));
  const countsTowardWeek = t => !t.dueDate || t.dueDate <= weekEndStr;
  let overflowMinutes = 0;
  for (const inst of baselineSchedule.instances){
    if (inst.date <= weekEndStr) continue;
    for (const item of inst.assigned){
      if (!item.recurringId && countsTowardWeek(item)) overflowMinutes += item.duration;
    }
  }
  for (const item of baselineSchedule.overflow){
    if (!item.recurringId && countsTowardWeek(item)) overflowMinutes += item.duration;
  }
  // How full is the flex time still ahead of us this week?
  let remainingCapacityMinutes = 0, committedMinutes = 0;
  for (const inst of baselineSchedule.instances){
    if (inst.date > weekEndStr) continue;
    remainingCapacityMinutes += inst.endMin - inst.startMin;
    for (const item of inst.assigned) committedMinutes += item.duration;
  }
  const utilisation = remainingCapacityMinutes>0 ? committedMinutes/remainingCapacityMinutes : 0;
  const weeklyCapacityMinutes = slots.reduce((sum,s)=> sum + (timeToMin(s.end)-timeToMin(s.start)), 0);
  const recurringWeeklyMinutes = recDaily.reduce((sum,d)=> sum + d.duration*WEEKDAY_DAYS.length, 0) + recWeekly.reduce((sum,w)=> sum + w.duration, 0);
  const netWeeklyCapacityMinutes = Math.max(0, weeklyCapacityMinutes - recurringWeeklyMinutes);
  let level;
  if (netWeeklyCapacityMinutes <= 0 || (overflowMinutes > 0 && overflowMinutes >= netWeeklyCapacityMinutes)) level = 'red';
  else if (overflowMinutes > 0 || utilisation >= HIGH_UTILISATION) level = 'orange';
  else level = 'green';
  return {
    level, overflowMinutes, netWeeklyCapacityMinutes,
    utilisation, committedMinutes, remainingCapacityMinutes,
    // true when the ONLY reason we're not green is running hot — no overflow yet.
    tightButFitting: overflowMinutes<=0 && utilisation >= HIGH_UTILISATION,
  };
}
/*
  Due-date risk — a SEPARATE, per-task trigger for the same catch-up unlock mechanism
  the workload traffic light uses, but answering a different question. The traffic
  light asks "is the week overloaded overall"; this asks "is any specific task, with
  its own deadline, projected to miss that deadline" — the two can disagree: a single
  looming due date can be at risk while the week's aggregate load still reads green.

  Only tasks that AREN'T YET overdue are checked here (dueDate >= today). An already-
  overdue task is already 'urgent' under the existing isUrgent() rule and already has
  catch-up access regardless of any unlock — this function exists specifically to catch
  a task BEFORE it becomes overdue, while there's still time to act.

  Like computeWorkload, this always reads the BASELINE (still-gated) schedule, never the
  live/possibly-unlocked one — the same anti-oscillation reasoning applies: diagnosing
  from a schedule that unlocking has already changed would make the diagnosis flicker.
*/
function computeDueDateRisk(tasks, baselineSchedule, todayStr){
  const atRiskIds = new Set();
  for (const task of tasks){
    if (task.done || !task.dueDate || task.dueDate < todayStr) continue;
    let latestDate = null;
    for (const inst of baselineSchedule.instances){
      for (const item of inst.assigned){
        if (item.id===task.id && (!latestDate || inst.date>latestDate)) latestDate = inst.date;
      }
    }
    const hasOverflow = baselineSchedule.overflow.some(item=>item.id===task.id);
    if (hasOverflow || !latestDate || latestDate>task.dueDate) atRiskIds.add(task.id);
  }
  return { atRiskIds, count: atRiskIds.size };
}
/* ============================================================
   Small UI atoms
   ============================================================ */
function Eyebrow({ children, className='' }){
  return <div className={`text-xs font-semibold tracking-widest uppercase ${className}`}>{children}</div>;
}
// One item in the phone-only bottom bar. The drawer toggles it replaces read
// as a wrapped third row of text links at 390px, which is what the Capture
// button kept landing on top of.
function TabBarButton({ icon: Icon, label, active, onClick }){
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 flex flex-col items-center justify-center gap-1 min-h-[56px] px-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-prism-blue-deep ${active ? 'text-prism-blue-deep' : 'text-prism-muted'}`}
    >
      <Icon className="w-5 h-5 shrink-0"/>
      <span className="text-[11px] font-semibold leading-none">{label}</span>
    </button>
  );
}

function WorkloadIndicator({ workload }){
  const dotConfig = [
    { key:'red', activeClass:'bg-rose-500', dimClass:'bg-rose-100' },
    { key:'orange', activeClass:'bg-orange-500', dimClass:'bg-orange-100' },
    { key:'green', activeClass:'bg-emerald-500', dimClass:'bg-emerald-100' },
  ];
  const pct = Math.round(workload.utilisation*100);
  // "Getting full" now covers two distinct situations, so the label and tooltip
  // distinguish them: running hot with no overflow yet, vs actually spilling over.
  const label = workload.level==='green' ? 'On track'
    : workload.level==='red' ? 'Overloaded'
    : workload.tightButFitting ? 'No slack left'
    : 'Getting full';
  const description = workload.level==='green'
    ? `Everything besides recurring tasks fits this week, and you're using ${pct}% of your remaining flex time — there's room to absorb a surprise.`
    : workload.tightButFitting
      ? `Everything still fits, but you're committed to ${pct}% of your remaining flex time this week. One disruption and something will slip — worth deferring or trimming now, while you still have the choice.`
      : workload.level==='red'
        ? `${formatDurationHM(workload.overflowMinutes)} of work won't fit this week — catch-up sessions are open to anything until this clears.`
        : `${formatDurationHM(workload.overflowMinutes)} of work is running past this week. You're at ${pct}% of remaining flex time.`;
  return (
    <div className="flex items-center gap-2.5 px-2 sm:px-3 py-1.5 sm:py-2 rounded-2xl border border-white/60 bg-white/55 backdrop-blur-md shadow-prism-soft" title={description}>
      <div className="flex flex-col gap-1 bg-prism-navy rounded-md px-1.5 py-1.5">
        {dotConfig.map(d=>(
          <span key={d.key} className={`w-2.5 h-2.5 rounded-full ${workload.level===d.key?d.activeClass:d.dimClass}`}></span>
        ))}
      </div>
      {/* The traffic light alone carries the signal on a phone. These two
          lines of prose are what crushed the date out of the header at 390px. */}
      <div className="hidden sm:flex flex-col leading-tight">
        <span className="text-xs font-semibold text-prism-ink">{label}</span>
        <span className="text-xs text-prism-muted">
          {workload.remainingCapacityMinutes>0 ? `${pct}% of flex time left this week` : "This week's load"}
        </span>
      </div>
    </div>
  );
}
function HeroCard({ currentInst, nextInst, onToggleDone, slotsUnlocked, atRiskIds }){
  const inst = currentInst || nextInst;
  if (!inst){
    return (
      <div className="rounded-3xl px-6 py-12 text-center bg-prism-cta shadow-prism-card">
        <div className="text-white/70 text-sm">Nothing scheduled — add a task below</div>
      </div>
    );
  }
  const label = currentInst ? 'RIGHT NOW' : 'NEXT UP';
  const timeLabel = currentInst ? `until ${minToLabel(inst.endMin)}` : `${DAY_SHORT[inst.dayOfWeek]} ${minToLabel(inst.startMin)}`;
  const isUnlockedRestricted = inst.restricted && slotsUnlocked;
  const emptyColor = isUnlockedRestricted ? 'text-white/70' : inst.restricted ? 'text-rose-300' : 'text-white/70';
  return (
    <div key={inst.key} className="animate-prism-flap motion-reduce:animate-none [transform-origin:top_center] rounded-3xl px-6 py-7 bg-prism-cta shadow-prism-card">
      <div className="flex items-center justify-between mb-4">
        <Eyebrow className="text-white">{label}</Eyebrow>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-white/60">{timeLabel}</span>
        </div>
      </div>
      {inst.assigned.length===0 ? (
        <div className={`text-sm py-2 ${emptyColor}`}>
          {isUnlockedRestricted ? 'Open — catch-up slot unlocked while things are busy' : inst.restricted ? 'Catch-up block — nothing pressing right now' : 'Open — nothing assigned yet'}
        </div>
      ) : (
        <div className="space-y-3">
          {inst.assigned.map(t=>{
            const isAtRisk = atRiskIds.has(t.id);
            const isRecurring = !!t.recurringId;
            // The hero card sits on a dark panel, so recurring uses a translucent
            // emerald wash rather than the light-green fill used in the day columns.
            // At-risk still wins — a warning outranks a category tint.
            const rowTint = isAtRisk
              ? 'bg-rose-500/10 border border-rose-500/30 rounded-xl px-3 py-2 -mx-3'
              : isRecurring
                ? 'bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-3 py-2 -mx-3'
                : '';
            return (
              <div key={inst.key+'|'+t.id} className={`flex items-start gap-3 ${rowTint}`}>
                <button onClick={()=>onToggleDone(t.id, t.sessionId)} aria-label={t.done?`Mark ${t.title} not done`:`Mark ${t.title} done`} className={`w-7 h-7 mt-0.5 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white ${t.done?'bg-prism-blue border-prism-blue':'border-white/40 hover:border-prism-blue'}`}>
                  {t.done && <Check className="w-4 h-4 text-prism-ink"/>}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-lg font-medium ${t.done?'line-through text-white/50':'text-white'}`}>{t.title}</span>
                    {t.isPartial && <span className="font-mono text-xs text-white/60 shrink-0">part {t.chunkIndex} · {t.duration}min</span>}
                    {t.dueDate && t.dueDate<inst.date && <span className="text-blue-300 text-xs shrink-0">from {formatShortDate(t.dueDate)}</span>}
                    {t.pinnedTo && t.pinnedTo.slotId===inst.slotId && t.pinnedTo.date===inst.date && <Pin className="w-3.5 h-3.5 text-violet-300 shrink-0" fill="currentColor"/>}
                    {t.pressing && <Star className="w-3.5 h-3.5 text-amber-400 shrink-0" fill="currentColor"/>}
                  </div>
                  {isAtRisk && (
                    <span className="inline-block text-xs font-semibold text-rose-300 bg-rose-500/20 rounded px-1.5 py-0.5 mt-1">
                      At risk · due {formatShortDate(t.dueDate)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
/*
  A meeting on the board, plus the action points that came out of it.

  Action points live here rather than in the meeting's edit form because the
  useful question on the board is "what came out of this, and when am I doing
  it?" — each one shows where the scheduler actually placed it, so the meeting
  and its follow-up work read as a single thing.
*/
function MeetingRow({ meeting, actionPoints, placementByTaskId, onEditMeeting, onDeleteMeeting, onAddActionPoint, onToggleDone, onDelete }){
  const [adding,setAdding] = useState(false);
  const [text,setText] = useState('');
  const mins = timeToMin(meeting.end)-timeToMin(meeting.start);

  function submit(){
    const title = text.trim();
    if (!title) return;
    onAddActionPoint(meeting.id, title);
    setText('');
    setAdding(false);
  }
  const open = actionPoints.filter(t=>!t.done);
  const done = actionPoints.filter(t=>t.done);

  return (
    <div className="rounded-xl px-2 py-1.5 border border-prism-violet/25 bg-prism-violet/10 backdrop-blur-sm">
      <div className="flex items-center justify-between mb-0.5">
        <span className="font-mono text-xs text-violet-700">
          {minToLabel(timeToMin(meeting.start))}–{minToLabel(timeToMin(meeting.end))}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="font-mono text-xs text-violet-400">{formatDurationHM(mins)}</span>
          <button onClick={()=>onEditMeeting(meeting.id)} aria-label="Edit meeting" className="text-violet-300 hover:text-violet-600 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep"><Pencil className="w-3 h-3"/></button>
          <button onClick={()=>onDeleteMeeting(meeting.id)} aria-label="Delete meeting" className="text-violet-300 hover:text-rose-500 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep"><Trash2 className="w-3 h-3"/></button>
        </div>
      </div>
      <div className="flex items-start gap-1.5">
        <Users className="w-3.5 h-3.5 text-violet-500 mt-0.5 shrink-0"/>
        <div className="min-w-0">
          <div className="text-xs font-medium text-violet-900 break-words">{meeting.title}</div>
          {meeting.notes && <div className="text-xs text-violet-500 break-words mt-0.5">{meeting.notes}</div>}
        </div>
      </div>

      {(open.length>0 || done.length>0) && (
        <div className="mt-1.5 pt-1.5 border-t border-violet-200/70 space-y-1">
          {[...open, ...done].map(t=>{
            const at = placementByTaskId.get(t.id);
            return (
              <div key={t.id} className="flex items-start gap-1.5">
                <button onClick={()=>onToggleDone(t.id, t.id)} aria-label={t.done?'Mark not done':'Mark done'}
                  className={`w-7 h-7 -mt-1 -ml-1 rounded-full border shrink-0 flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep ${t.done?'bg-violet-600 border-violet-600':'border-violet-300 hover:border-violet-500'}`}>
                  {t.done && <Check className="w-3.5 h-3.5 text-white"/>}
                </button>
                <div className="min-w-0 flex-1">
                  <div className={`text-xs break-words ${t.done?'text-violet-300 line-through':'text-violet-800'}`}>{t.title}</div>
                  {!t.done && (
                    <div className="text-xs text-violet-400 font-mono">
                      {at ? `→ ${formatShortDate(at.date)} ${minToLabel(at.startMin)}` : 'not yet placed'}
                    </div>
                  )}
                </div>
                <button onClick={()=>onDelete(t.id)} aria-label="Delete action point" className="p-1.5 -m-1.5 text-violet-200 hover:text-rose-500 shrink-0 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep"><Trash2 className="w-3 h-3"/></button>
              </div>
            );
          })}
        </div>
      )}

      {adding ? (
        <div className="mt-1.5 flex items-center gap-1">
          <input
            autoFocus value={text} onChange={e=>setText(e.target.value)}
            onKeyDown={e=>{ if(e.key==='Enter'){e.preventDefault();submit();} if(e.key==='Escape'){e.preventDefault();setAdding(false);setText('');} }}
            placeholder="What needs doing after this?" aria-label="Action point"
            className="flex-1 min-w-0 text-xs rounded-md border border-violet-200 px-1.5 py-1 focus:outline-none focus:ring-2 focus:ring-prism-blue-deep"/>
          <button onClick={submit} className="text-xs text-violet-700 font-medium shrink-0 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep">Add</button>
        </div>
      ) : (
        <button onClick={()=>setAdding(true)} className="mt-1.5 flex items-center gap-1 text-xs text-violet-500 hover:text-violet-700 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep">
          <Plus className="w-3 h-3"/> Action point
        </button>
      )}
    </div>
  );
}
/*
  Overflow menu for the less-frequently-used task-row actions ("why is this
  here?", pressing, unpin). Edit and Delete stay inline in the row at a real
  44x44 target each — they're the actions used on every task, every day.
  This menu holds the rest at the same 44x44 floor without eating card width.

  Portal-rendered to document.body and positioned from the trigger's
  getBoundingClientRect(), rather than a plain `absolute` child of the task
  row: the row lives inside DayColumn's `overflow-y-auto` list, and a menu
  tall enough to hold three 44px items would get silently clipped by that
  scroll container if it were positioned relative to the row instead of the
  viewport. Closes on Escape (focus returns to the trigger, matching
  CaptureThought's pattern), on an outside click, and on scroll anywhere in
  the capture phase — covers the day column scrolling, not just window
  scroll, since inner-element scroll events don't bubble.
*/
/*
  The running-task timer.

  It counts UP and keeps going past the estimate rather than stopping or
  alarming: an overrun is information — it is the raw material the accuracy
  figure in Trends is built from — not a failure to be interrupted about. Past
  the estimate the bar stays full and turns amber, and the label switches to
  how far over you are.

  It owns its own one-second tick. Putting that interval in App would re-render
  the whole board — up to three weeks of day columns — every second for the
  sake of one changing label.

  Elapsed time is always derived from the absolute `startedAt`, never
  accumulated, so a locked phone, a backgrounded PWA or a throttled timer
  cannot make the count drift.
*/
function TimerBar({ timer, task, onDone, onNotComplete, onCancel }){
  const [nowMs, setNowMs] = useState(()=>Date.now());
  useEffect(()=>{
    setNowMs(Date.now());
    const h = setInterval(()=>setNowMs(Date.now()), 1000);
    return ()=>clearInterval(h);
  },[timer.startedAt]);

  const elapsedSec = Math.max(0, Math.floor((nowMs - timer.startedAt)/1000));
  const plannedSec = Math.max(60, timer.plannedMinutes*60);
  const over = elapsedSec > plannedSec;
  const pct = Math.min(100, (elapsedSec/plannedSec)*100);
  const overSec = elapsedSec - plannedSec;

  return (
    <div className="px-4 sm:px-6 pt-3 pb-2 border-b border-white/50">
      <div className="flex items-center gap-3 mb-2">
        <span className={`font-mono text-lg tabular-nums shrink-0 ${over?'text-amber-600':'text-prism-ink'}`}>
          {fmtClock(elapsedSec)}
        </span>
        <span className="flex-1 min-w-0 truncate text-sm text-prism-ink">{task ? task.title : 'Timing'}</span>
        <span className={`font-mono text-xs shrink-0 ${over?'text-amber-600 font-semibold':'text-prism-muted'}`}>
          {over ? `+${fmtClock(overSec)} over` : `of ${timer.plannedMinutes}m`}
        </span>
      </div>
      <div
        className="h-1.5 rounded-full bg-prism-muted/15 overflow-hidden"
        role="progressbar"
        aria-label={`Time on ${task ? task.title : 'this task'}`}
        aria-valuemin={0}
        aria-valuemax={timer.plannedMinutes}
        aria-valuenow={Math.round(elapsedSec/60)}
        aria-valuetext={over ? `${Math.round(elapsedSec/60)} minutes, ${Math.round(overSec/60)} over the ${timer.plannedMinutes} minute estimate` : `${Math.round(elapsedSec/60)} of ${timer.plannedMinutes} minutes`}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-1000 ease-linear ${over?'bg-amber-500':'bg-prism-cta'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center gap-2 mt-2.5">
        <button
          onClick={onDone}
          className="flex-1 min-h-[44px] rounded-xl bg-prism-cta text-white text-sm font-semibold shadow-prism-cta flex items-center justify-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep focus-visible:ring-offset-2"
        >
          <Check className="w-4 h-4"/> Done
        </button>
        {/* An honest "I didn't get to the end of it" has to cost one tap, or it
            gets recorded as done. This does not close the task — it sends it
            back to the scheduler for a later slot. */}
        <button
          onClick={onNotComplete}
          className="flex-1 min-h-[44px] rounded-xl border border-white/60 bg-white/60 text-prism-ink text-sm font-medium flex items-center justify-center gap-2 hover:bg-white/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep"
        >
          <CalendarClock className="w-4 h-4"/> Not complete
        </button>
        <button
          onClick={onCancel}
          aria-label="Stop timing without recording anything"
          title="Stop timing without recording anything"
          className="w-11 h-11 shrink-0 rounded-xl text-prism-muted/70 hover:text-prism-ink flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep"
        >
          <X className="w-4 h-4"/>
        </button>
      </div>
    </div>
  );
}
function fmtClock(totalSec){
  const m = Math.floor(totalSec/60);
  const s = totalSec%60;
  return `${m}:${String(s).padStart(2,'0')}`;
}
function TaskActionsMenu({ taskTitle, isExplaining, onToggleExplain, isPinnedHere, onUnpin, pressing, onTogglePressing, onReschedule }){
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null); // { top, left, openUpward }
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  function place(){
    const btn = triggerRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const menuHeight = 4 * 44 + 8; // worst case: explain + pressing + reschedule + unpin, plus py-1 padding
    const openUpward = r.bottom + menuHeight > window.innerHeight;
    setPos({
      left: Math.min(r.right - 190, window.innerWidth - 198),
      top: openUpward ? r.top - menuHeight : r.bottom + 4,
      openUpward,
    });
  }

  function openMenu(){
    place();
    setOpen(true);
  }
  function closeMenu(returnFocus){
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  useEffect(()=>{
    if (!open) return;
    function onDocMouseDown(e){
      if (menuRef.current?.contains(e.target) || triggerRef.current?.contains(e.target)) return;
      closeMenu(false);
    }
    function onKeyDown(e){
      if (e.key === 'Escape'){ e.preventDefault(); closeMenu(true); }
    }
    function onScroll(){ closeMenu(false); }
    document.addEventListener('mousedown', onDocMouseDown);
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    const first = menuRef.current?.querySelector('[role="menuitem"]');
    first?.focus();
    return ()=>{
      document.removeEventListener('mousedown', onDocMouseDown);
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[open]);

  function onMenuKeyDown(e){
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(menuRef.current?.querySelectorAll('[role="menuitem"]') || []);
    if (items.length === 0) return;
    e.preventDefault();
    const idx = items.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? (idx+1+items.length)%items.length : (idx-1+items.length)%items.length;
    items[next]?.focus();
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={()=> open ? closeMenu(false) : openMenu()}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${taskTitle}`}
        className="w-11 h-11 shrink-0 flex items-center justify-center rounded-full text-prism-muted/60 hover:text-prism-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep"
      >
        <MoreVertical className="w-3.5 h-3.5"/>
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Actions for ${taskTitle}`}
          onKeyDown={onMenuKeyDown}
          style={{ position:'fixed', top:pos.top, left:pos.left }}
          className="z-50 w-[190px] rounded-xl border border-white/60 bg-white/95 backdrop-blur-xl backdrop-saturate-150 shadow-prism-card py-1"
        >
          <button
            role="menuitem"
            tabIndex={-1}
            onClick={()=>{ onToggleExplain(); closeMenu(false); }}
            className={`w-full min-h-[44px] flex items-center gap-2.5 px-3 text-sm text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-prism-blue-deep ${isExplaining ? 'bg-prism-blue/10 text-prism-blue-deep' : 'text-prism-ink hover:bg-prism-blue/5'}`}
          >
            <HelpCircle className="w-4 h-4 shrink-0"/> Why is this here?
          </button>
          <button
            role="menuitem"
            tabIndex={-1}
            onClick={()=>{ onTogglePressing(); closeMenu(false); }}
            className="w-full min-h-[44px] flex items-center gap-2.5 px-3 text-sm text-left text-prism-ink hover:bg-prism-blue/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-prism-blue-deep"
          >
            <Star className={`w-4 h-4 shrink-0 ${pressing ? 'text-amber-500' : 'text-prism-muted/50'}`} fill={pressing ? 'currentColor' : 'none'}/> {pressing ? 'Unmark as pressing' : 'Mark as pressing'}
          </button>
          {/* The same "not complete" move as the timer bar's, reachable without
              having timed the task. */}
          <button
            role="menuitem"
            tabIndex={-1}
            onClick={()=>{ onReschedule(); closeMenu(false); }}
            className="w-full min-h-[44px] flex items-center gap-2.5 px-3 text-sm text-left text-prism-ink hover:bg-prism-blue/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-prism-blue-deep"
          >
            <CalendarClock className="w-4 h-4 shrink-0 text-prism-muted/70"/> Not now — reschedule
          </button>
          {isPinnedHere && (
            <button
              role="menuitem"
              tabIndex={-1}
              onClick={()=>{ onUnpin(); closeMenu(false); }}
              className="w-full min-h-[44px] flex items-center gap-2.5 px-3 text-sm text-left text-prism-violet-deep hover:bg-prism-violet/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-prism-blue-deep"
            >
              <Pin className="w-4 h-4 shrink-0" fill="currentColor"/> Unpin — let it reschedule
            </button>
          )}
        </div>,
        document.body
      )}
    </>
  );
}
function DayColumn({ day, isToday, weekLabel, onToggleDone, onDelete, onEdit, onTogglePressing, onUnpin, slotsUnlocked, atRiskIds, draggingTaskId, onDragStartTask, onDragEndTask, dragOverKey, onDragOverSlot, onDropOnSlot, explainingKey, onToggleExplain, onEditMeeting, onDeleteMeeting, onAddActionPoint, actionPointsByMeeting, placementByTaskId, onStartTimer, onReschedule, timingKey }){
  const d = parseDateStr(day.date);
  return (
    /*
      Two layouts, one tree. On a phone the days stack and the PAGE scrolls, so
      the card takes its natural height and its list does not scroll on its own
      (a scroller inside a scroller on a touch screen traps the gesture). From
      `sm` up the days are columns in a horizontal board again, each a
      full-height card with its own scrolling list.
    */
    <div className={`flex-col sm:h-full rounded-2xl border backdrop-blur-md overflow-hidden shadow-prism-soft ${
      // A day with nothing in it is worth a column on the desktop board (it
      // shows the week's shape) but on a phone it is a card that says only
      // "No flex blocks" between you and the next real day.
      day.rows.length===0 ? 'hidden sm:flex' : 'flex'
    } ${isToday?'border-prism-blue/40 bg-prism-blue/5':'border-white/60 bg-white/60'}`}>
      <div className={`px-3 py-2.5 shrink-0 border-b ${isToday?'border-prism-blue/25':'border-white/50'}`}>
        {weekLabel && <div className="text-xs font-semibold text-prism-violet uppercase tracking-widest mb-1">{weekLabel}</div>}
        <div className={`text-xs font-semibold ${isToday?'text-prism-blue-deep':'text-prism-muted'}`}>{DAY_NAMES[day.dayOfWeek]}{isToday?' · Today':''}</div>
        <div className="text-xs text-prism-muted/70">{d.toLocaleDateString('en-AU',{day:'numeric',month:'short'})}</div>
      </div>
      <div className="flex-1 sm:overflow-y-auto p-2 space-y-2">
        {day.rows.length===0 ? (
          <div className="text-xs text-prism-muted/60 italic py-1 px-1">No flex blocks</div>
        ) : day.rows.map(row=>{
          if (row.kind==='meeting'){
            return (
              <MeetingRow
                key={'meeting|'+row.meeting.id}
                meeting={row.meeting}
                actionPoints={actionPointsByMeeting.get(row.meeting.id) || []}
                placementByTaskId={placementByTaskId}
                onEditMeeting={onEditMeeting}
                onDeleteMeeting={onDeleteMeeting}
                onAddActionPoint={onAddActionPoint}
                onToggleDone={onToggleDone}
                onDelete={onDelete}
              />
            );
          }
          const inst = row.inst;
          const isUnlockedRestricted = inst.restricted && slotsUnlocked;
          const isDropTarget = dragOverKey===inst.key;
          const capacityMinutes = inst.endMin - inst.startMin;
          const usedMinutes = inst.assigned.reduce((sum,a)=>sum+a.duration, 0);
          const freeMinutes = capacityMinutes - usedMinutes;
          return (
            <div
              key={inst.key}
              onDragOver={e=>{ e.preventDefault(); onDragOverSlot(inst.key); }}
              onDrop={e=>{ e.preventDefault(); onDropOnSlot(inst.slotId, inst.date); }}
              className={`rounded-xl px-2 py-1.5 border transition-colors ${
                isDropTarget ? 'bg-prism-blue/10 border-prism-blue border-2' :
                isUnlockedRestricted ? 'bg-rose-50/30 border-rose-200' :
                inst.restricted ? 'bg-rose-50/70 border-rose-200 border-dashed' :
                'bg-white/40 border-white/50'
              }`}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1">
                  {/* The full range, not just the start. These blocks ARE the
                      sections of the day — "07:40 – 08:00" says what the block
                      is and how long you have in it without reading the
                      capacity figure. */}
                  <span className="font-mono text-sm sm:text-xs font-medium text-prism-ink sm:text-prism-muted sm:font-normal">
                    {minToLabel(inst.startMin)} – {minToLabel(inst.endMin)}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  {isUnlockedRestricted && <span className="text-xs text-rose-500 font-medium">unlocked</span>}
                  {/* Capacity: makes wasted fragments visible — a block showing 5 of 25
                      used is obviously leaking time in a way a bare task list isn't. */}
                  <span
                    className={`font-mono text-xs ${usedMinutes===0 ? 'text-prism-muted/50' : freeMinutes===0 ? 'text-emerald-600' : 'text-prism-muted'}`}
                    title={`${usedMinutes} of ${capacityMinutes} minutes used${freeMinutes>0?` — ${freeMinutes}min still free`:' — full'}`}>
                    {usedMinutes}/{capacityMinutes}m
                  </span>
                </div>
              </div>
              <div className="space-y-2">
                {inst.assigned.length===0 ? (
                  <span className={`text-xs ${isDropTarget?'text-prism-blue-deep font-medium':isUnlockedRestricted?'text-prism-muted/50':inst.restricted?'text-rose-400':'text-prism-muted/50'}`}>
                    {isDropTarget ? 'Drop here' : isUnlockedRestricted ? 'Open' : inst.restricted?'Catch-up only':'Open'}
                  </span>
                ) : inst.assigned.map(t=>{
                  const isAtRisk = atRiskIds.has(t.id);
                  const isRecurring = !!t.recurringId;
                  const isPinnedHere = t.pinnedTo && t.pinnedTo.slotId===inst.slotId && t.pinnedTo.date===inst.date;
                  const isDragging = draggingTaskId===t.id;
                  const explainKey = inst.key+'|'+t.sessionId;
                  const isExplaining = explainingKey===explainKey;
                  // At-risk (rose) deliberately wins over recurring (green): a warning
                  // should never be hidden by a category tint.
                  const rowTint = isAtRisk
                    ? 'rounded-md px-1.5 py-1 -mx-1.5 bg-rose-50 border border-rose-200'
                    : isRecurring
                      ? 'rounded-md px-1.5 py-1 -mx-1.5 bg-emerald-50 border border-emerald-200'
                      : '';
                  return (
                    <div
                      key={inst.key+'|'+t.id}
                      draggable
                      onDragStart={e=>{ e.dataTransfer.effectAllowed='move'; onDragStartTask(t.id); }}
                      onDragEnd={onDragEndTask}
                      className={`cursor-grab active:cursor-grabbing ${isDragging?'opacity-40':''} ${rowTint}`}>
                      <div className="flex items-start gap-1.5">
                        <button onClick={()=>onToggleDone(t.id, t.sessionId)} aria-label={t.done?`Mark ${t.title} not done`:`Mark ${t.title} done`} className={`w-7 h-7 -mt-1 -ml-1 rounded-full border shrink-0 flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep focus-visible:ring-offset-1 ${t.done?'bg-emerald-500 border-emerald-500':'border-prism-muted/40'}`}>
                          {t.done && <Check className="w-3.5 h-3.5 text-white"/>}
                        </button>
                        <span className={`flex-1 min-w-0 break-words text-sm sm:text-xs ${t.done?'line-through text-prism-muted':'text-prism-ink'}`}>{t.title}</span>
                        {/* Decorative status glyphs — the interactive toggles for both
                            live in the overflow menu now; these just keep pinned/pressing
                            scannable at a glance without needing to open it. */}
                        {isPinnedHere && <Pin aria-hidden="true" title="Pinned here manually" className="w-3 h-3 shrink-0 mt-0.5 text-prism-violet-deep" fill="currentColor"/>}
                        {t.pressing && <Star aria-hidden="true" title="Pressing" className="w-3 h-3 shrink-0 mt-0.5 text-amber-500" fill="currentColor"/>}
                      </div>
                      {isAtRisk && (
                        <div className="pl-5 mt-0.5">
                          <span className="inline-block text-xs font-semibold text-rose-600 bg-rose-100 rounded px-1 py-0.5">
                            At risk · due {formatShortDate(t.dueDate)}
                          </span>
                        </div>
                      )}
                      {isExplaining && t.placementReason && (
                        <div className="pl-5 mt-1 mb-1">
                          <div className="text-xs text-prism-ink bg-white/70 backdrop-blur-sm border border-white/60 rounded-lg px-2 py-1.5 leading-relaxed">
                            {t.placementReason}
                          </div>
                        </div>
                      )}
                      {/* Tap targets: Edit and Delete — the two actions used on every
                          task — get a real 44x44 hit area each (w-11 h-11, icon centred).
                          "Why is this here?", pressing and unpin move into the
                          TaskActionsMenu overflow button (also 44x44), which is where
                          they get their own full-size targets instead of a 24x24
                          compromise. See TaskActionsMenu above DayColumn. */}
                      <div className="flex items-center gap-1 mt-1 pl-4">
                        {t.isPartial && (
                          <span className="font-mono text-xs text-prism-muted shrink-0 mr-1">{t.chunkIndex}·{t.duration}m</span>
                        )}
                        {t.dueDate && t.dueDate<day.date && <span className="text-xs text-prism-blue-deep shrink-0 mr-1">from {formatShortDate(t.dueDate)}</span>}
                        <span className="flex-1"></span>
                        {/* Start is offered only on today's blocks and only for
                            work that isn't finished — a timer on Thursday's
                            block would be timing something you are not doing. */}
                        {isToday && !t.done && (
                          <button
                            onClick={()=>onStartTimer(t)}
                            /* One timer at a time. Silently replacing a running
                               one would throw away however long you had already
                               spent on the first task. */
                            disabled={!!timingKey}
                            aria-label={`Start timing ${t.title}`}
                            title={
                              timingKey === t.id+'|'+t.sessionId ? 'Already timing this'
                              : timingKey ? 'Finish or stop the running timer first'
                              : `Start the ${t.duration}m timer`
                            }
                            className="w-11 h-11 shrink-0 flex items-center justify-center rounded-full text-prism-blue-deep hover:bg-prism-blue/10 disabled:opacity-30 focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep"
                          >
                            <Play className="w-3.5 h-3.5" fill="currentColor"/>
                          </button>
                        )}
                        <button onClick={()=>onEdit(t.id)} aria-label={`Edit ${t.title}`} className="w-11 h-11 text-prism-muted/60 shrink-0 flex items-center justify-center rounded-full hover:text-prism-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep" title={t.recurringId ? 'Edit just this occurrence' : 'Edit this task'}>
                          <Pencil className="w-3.5 h-3.5"/>
                        </button>
                        <button onClick={()=>onDelete(t.id)} aria-label={`Delete ${t.title}`} className="w-11 h-11 text-prism-muted/60 shrink-0 flex items-center justify-center rounded-full hover:text-rose-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep" title="Delete this task"><Trash2 className="w-3.5 h-3.5"/></button>
                        <TaskActionsMenu
                          taskTitle={t.title}
                          isExplaining={isExplaining}
                          onToggleExplain={()=>onToggleExplain(explainKey)}
                          isPinnedHere={isPinnedHere}
                          onUnpin={()=>onUnpin(t.id)}
                          pressing={!!t.pressing}
                          onTogglePressing={()=>onTogglePressing(t.id)}
                          onReschedule={()=>onReschedule(t.id)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
function StatsBar({ stats }){
  const rows = [
    { label:'Today', value: stats.day, color:'text-prism-blue-deep' },
    { label:'This week', value: stats.week, color:'text-prism-violet-deep' },
    { label:'This month', value: stats.month, color:'text-violet-700' },
    { label:'This year', value: stats.year, color:'text-emerald-700' },
  ];
  return (
    <div className="flex items-center gap-5">
      <span className="text-xs font-semibold text-prism-muted uppercase tracking-widest shrink-0">Completed</span>
      {rows.map(r=>(
        <div key={r.label} className="flex items-baseline gap-1.5 shrink-0">
          <span className={`font-mono text-lg font-semibold ${r.color}`}>{r.value}</span>
          <span className="text-xs text-prism-muted">{r.label}</span>
        </div>
      ))}
    </div>
  );
}
function TaskForm({ onSubmit, onClose, existingTask=null, largestSlotMinutes=0, totalWeeklyMinutes=0, accuracy=null }){
  const isEditing = !!existingTask;
  const isRecurringInstance = !!(existingTask && existingTask.recurringId);
  const [title,setTitle] = useState(existingTask ? existingTask.title : '');
  const [duration,setDuration] = useState(existingTask ? existingTask.duration : 15);
  // "Other" is pre-opened when editing a task whose duration isn't one of the presets,
  // so the current value is visible and editable instead of silently unrepresented.
  const [customDuration,setCustomDuration] = useState(
    existingTask ? !DURATION_PRESETS.some(p=>p.minutes===existingTask.duration) : false
  );
  const [dueDate,setDueDate] = useState(existingTask && existingTask.dueDate ? existingTask.dueDate : '');
  const [pressing,setPressing] = useState(existingTask ? !!existingTask.pressing : false);

  const mins = Math.max(MIN_TASK_MINUTES, Number(duration)||MIN_TASK_MINUTES);
  /*
    ENTRY-TIME FIT WARNING — the scheduler will happily shred an oversized task into
    slivers across many blocks, or overflow it entirely, without ever saying so at the
    point where you could still change your mind. These two checks surface the problem
    while you're still typing:
      - bigger than your LARGEST single block  -> it can only ever exist as a split
      - bigger than your whole WEEK's capacity -> it can't fit in a week at all
    Both are warnings, never blocks: a genuinely large task split across blocks is a
    perfectly reasonable thing to want.
  */
  const willSplit = largestSlotMinutes>0 && mins > largestSlotMinutes;
  const exceedsWeek = totalWeeklyMinutes>0 && mins > totalWeeklyMinutes;

  /*
    REFERENCE-CLASS ESTIMATE CORRECTION.
    ------------------------------------
    People systematically underestimate how long their own tasks will take, and simply
    having done the task before doesn't fix it — the reliable correction is to apply
    your own historical ratio rather than trusting the fresh intuition.

    The app has been quietly collecting exactly that: every completed task where you
    logged actual time contributes to computeAccuracy(). Until now it was only shown
    as a retrospective stat in Trends, at the moment it could no longer be acted on.
    Here it's surfaced at the point of decision, with a one-tap button to accept it.

    Deliberately advisory, never automatic: it suggests, shows its working ("based on
    N tasks"), and leaves the number alone unless you press the button. Suppressed
    below MIN_ACCURACY_SAMPLE completions, and when your ratio is close enough to 1
    that a correction would be noise.
  */
  const hasUsableAccuracy = accuracy && accuracy.count >= MIN_ACCURACY_SAMPLE
    && (accuracy.ratio > 1.1 || accuracy.ratio < 0.9);
  const adjustedMins = hasUsableAccuracy ? Math.max(MIN_TASK_MINUTES, Math.round((mins*accuracy.ratio)/5)*5) : null;
  const showAdjustment = hasUsableAccuracy && adjustedMins !== mins;
  const runsOver = hasUsableAccuracy && accuracy.ratio > 1;

  function submit(){
    if (!title.trim()) return;
    onSubmit({ title: title.trim(), duration: mins, dueDate: dueDate||null, pressing });
    onClose();
  }
  function handleTitleKeyDown(e){
    if (e.key === 'Enter'){ e.preventDefault(); submit(); }
    if (e.key === 'Escape'){ e.preventDefault(); onClose(); }
  }
  return (
    <div className="rounded-2xl border border-white/60 bg-white/70 backdrop-blur-xl shadow-prism-soft p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-prism-ink">{isEditing ? (isRecurringInstance ? 'Edit this occurrence' : 'Edit task') : 'Add a task'}</span>
        <button type="button" onClick={onClose} aria-label="Close form" className="text-prism-muted hover:text-prism-ink p-1.5 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep"><X className="w-4 h-4"/></button>
      </div>
      {isRecurringInstance && (
        <div className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-2 py-1.5">
          This changes only this one occurrence. The repeating task itself stays as it is — edit that under Time slots &amp; recurring tasks.
        </div>
      )}
      <input autoFocus value={title} onChange={e=>setTitle(e.target.value)} onKeyDown={handleTitleKeyDown} placeholder="What needs doing?" aria-label="Task title" className="w-full rounded-xl border border-white/60 bg-white/80 px-3 py-2.5 text-sm text-prism-ink placeholder:text-prism-muted focus:outline-none focus:ring-2 focus:ring-prism-blue-deep"/>
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
        {showAdjustment && (
          <div className="mt-1.5 text-xs text-prism-violet-deep bg-prism-violet/10 border border-prism-violet/25 rounded-lg px-2 py-1.5">
            <div>
              Across your last {accuracy.count} timed tasks you've run{' '}
              <span className="font-semibold">
                {runsOver
                  ? `${Math.round((accuracy.ratio-1)*100)}% over`
                  : `${Math.round((1-accuracy.ratio)*100)}% under`}
              </span>{' '}
              your estimates — so this may really take about {formatDurationHM(adjustedMins)}.
            </div>
            <button type="button" onClick={()=>{ setDuration(adjustedMins); setCustomDuration(!DURATION_PRESETS.some(p=>p.minutes===adjustedMins)); }}
              className="mt-1.5 min-h-[32px] text-xs bg-prism-violet-deep text-white rounded-lg px-2 py-1 font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep">
              Use {formatDurationHM(adjustedMins)} instead
            </button>
          </div>
        )}
        {exceedsWeek ? (
          <div className="mt-1.5 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2 py-1.5">
            {formatDurationHM(mins)} is more than your entire week of flex time ({formatDurationHM(totalWeeklyMinutes)}). This will spill across several weeks — consider breaking it into smaller tasks.
          </div>
        ) : willSplit ? (
          <div className="mt-1.5 text-xs text-prism-blue-deep bg-prism-blue/10 border border-prism-blue/25 rounded-lg px-2 py-1.5">
            Your largest block is {formatDurationHM(largestSlotMinutes)}, so this will be split across several sittings.
          </div>
        ) : null}
      </div>
      <div>
        <label className="text-xs text-prism-muted block mb-1">Due by (optional)</label>
        <input type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)} aria-label="Due date" className="w-full rounded-xl border border-white/60 bg-white/80 px-3 py-2 text-sm text-prism-ink focus:outline-none focus:ring-2 focus:ring-prism-blue-deep"/>
      </div>
      <label className="flex items-start gap-2 text-xs text-prism-ink">
        <input type="checkbox" checked={pressing} onChange={e=>setPressing(e.target.checked)} className="mt-0.5 accent-prism-blue-deep w-4 h-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep"/>
        <span>Pressing / specially requested — eligible for catch-up-only blocks (Tue eve, Sat morning)</span>
      </label>
      <button type="button" onClick={submit} className="w-full py-2.5 rounded-xl bg-prism-cta text-white text-sm font-medium shadow-prism-cta transition-transform hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep focus-visible:ring-offset-2">{isEditing ? 'Save changes' : 'Add task'}</button>
    </div>
  );
}
/*
  A meeting is a fixed commitment, so this form asks for wall-clock time directly
  — no duration, no due date, none of the task form's fitting logic. It doesn't
  need to fit anywhere; the schedule bends around it.
*/
function MeetingForm({ onSubmit, onClose, existingMeeting=null, todayStr }){
  const isEditing = !!existingMeeting;
  const [title,setTitle] = useState(existingMeeting?.title || '');
  const [date,setDate] = useState(existingMeeting?.date || todayStr);
  const [start,setStart] = useState(existingMeeting?.start || '09:00');
  const [end,setEnd] = useState(existingMeeting?.end || '10:00');
  const [notes,setNotes] = useState(existingMeeting?.notes || '');

  const startMin = start ? timeToMin(start) : null;
  const endMin = end ? timeToMin(end) : null;
  const badRange = startMin!=null && endMin!=null && endMin <= startMin;
  const durationMins = !badRange && startMin!=null && endMin!=null ? endMin-startMin : null;
  const canSubmit = title.trim() && date && !badRange;

  function submit(){
    if (!canSubmit) return;
    onSubmit({ title: title.trim(), date, start, end, notes: notes.trim() });
    onClose();
  }
  function handleTitleKeyDown(e){
    if (e.key === 'Enter'){ e.preventDefault(); submit(); }
    if (e.key === 'Escape'){ e.preventDefault(); onClose(); }
  }
  return (
    <div className="rounded-2xl border border-white/60 bg-white/70 backdrop-blur-xl shadow-prism-soft p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-prism-ink">{isEditing ? 'Edit meeting' : 'Add a meeting'}</span>
        <button type="button" onClick={onClose} aria-label="Close form" className="text-prism-muted hover:text-prism-ink p-1.5 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep"><X className="w-4 h-4"/></button>
      </div>
      <input autoFocus value={title} onChange={e=>setTitle(e.target.value)} onKeyDown={handleTitleKeyDown} placeholder="What's the meeting?" aria-label="Meeting title" className="w-full rounded-xl border border-white/60 bg-white/80 px-3 py-2.5 text-sm text-prism-ink placeholder:text-prism-muted focus:outline-none focus:ring-2 focus:ring-prism-blue-deep"/>
      <div>
        <label className="text-xs text-prism-muted block mb-1">When?</label>
        <input type="date" value={date} min={todayStr} onChange={e=>setDate(e.target.value)} aria-label="Meeting date" className="w-full rounded-xl border border-white/60 bg-white/80 px-3 py-2 text-sm text-prism-ink focus:outline-none focus:ring-2 focus:ring-prism-blue-deep"/>
      </div>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className="text-xs text-prism-muted block mb-1">From</label>
          <input type="time" value={start} onChange={e=>setStart(e.target.value)} aria-label="Start time" className="w-full rounded-xl border border-white/60 bg-white/80 px-3 py-2 text-sm text-prism-ink focus:outline-none focus:ring-2 focus:ring-prism-blue-deep"/>
        </div>
        <div className="flex-1">
          <label className="text-xs text-prism-muted block mb-1">To</label>
          <input type="time" value={end} onChange={e=>setEnd(e.target.value)} aria-label="End time" className="w-full rounded-xl border border-white/60 bg-white/80 px-3 py-2 text-sm text-prism-ink focus:outline-none focus:ring-2 focus:ring-prism-blue-deep"/>
        </div>
        {durationMins!=null && (
          <span className="text-xs text-prism-muted font-mono pb-2.5 shrink-0">{formatDurationHM(durationMins)}</span>
        )}
      </div>
      {badRange && (
        <div className="text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-lg px-2 py-1.5">
          The finish time needs to be after the start time.
        </div>
      )}
      <textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Notes (optional)" aria-label="Meeting notes" rows={2} className="w-full rounded-xl border border-white/60 bg-white/80 px-3 py-2 text-sm text-prism-ink focus:outline-none focus:ring-2 focus:ring-prism-blue-deep"/>
      <button type="button" onClick={submit} disabled={!canSubmit} className="w-full py-2.5 rounded-xl bg-prism-violet-deep text-white text-sm font-medium disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep focus-visible:ring-offset-2">{isEditing ? 'Save changes' : 'Add meeting'}</button>
    </div>
  );
}
function SettingsPanel({ slots, setSlots, recDaily, setRecDaily, recWeekly, setRecWeekly, onClearBacklog, backlogCount, slotsUnlocked }){
  const [newSlot,setNewSlot] = useState({ day:1, start:'', end:'', restricted:false });
  const [newDaily,setNewDaily] = useState({ title:'', duration:15, preference:'', autoExpire:false });
  const [newWeekly,setNewWeekly] = useState({ title:'', duration:15, day:'' });
  function addSlot(){
    if (!newSlot.start || !newSlot.end) return;
    setSlots(prev=>[...prev, { id:genId(), day:Number(newSlot.day), start:newSlot.start, end:newSlot.end, restricted:!!newSlot.restricted }]);
    setNewSlot({ day:1, start:'', end:'', restricted:false });
  }
  function addDaily(){
    if (!newDaily.title.trim()) return;
    setRecDaily(prev=>[...prev, { id:genId(), title:newDaily.title.trim(), duration:Math.max(MIN_TASK_MINUTES,Number(newDaily.duration)||MIN_TASK_MINUTES), preference:newDaily.preference||null, autoExpire: !!newDaily.autoExpire }]);
    setNewDaily({ title:'', duration:15, preference:'', autoExpire:false });
  }
  function addWeekly(){
    if (!newWeekly.title.trim()) return;
    setRecWeekly(prev=>[...prev, { id:genId(), title:newWeekly.title.trim(), duration:Math.max(MIN_TASK_MINUTES,Number(newWeekly.duration)||MIN_TASK_MINUTES), day: newWeekly.day===''?null:Number(newWeekly.day) }]);
    setNewWeekly({ title:'', duration:15, day:'' });
  }
  const sortedSlots = [...slots].sort((a,b)=> a.day-b.day || a.start.localeCompare(b.start));
  return (
    <div className="mt-2">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      <div>
        <h3 className="text-xs font-semibold text-prism-ink mb-2 uppercase tracking-widest">Flex blocks</h3>
        <div className="space-y-1.5">
          {sortedSlots.map(s=>(
            <div key={s.id} className="flex items-center justify-between text-sm bg-white/70 border border-white/60 rounded-xl px-3 py-2">
              <span className="text-prism-ink">{DAY_SHORT[s.day]} {minToLabel(timeToMin(s.start))}–{minToLabel(timeToMin(s.end))}{s.restricted && <span className="text-rose-500"> · catch-up only{slotsUnlocked && ' (unlocked)'}</span>}</span>
              <button onClick={()=>setSlots(prev=>prev.filter(x=>x.id!==s.id))} aria-label="Delete this flex block" className="text-prism-muted/50 p-1.5 -m-1.5 rounded-full hover:text-rose-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep"><Trash2 className="w-3.5 h-3.5"/></button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2 items-center bg-white/70 border border-white/60 rounded-xl p-2.5">
          <select value={newSlot.day} onChange={e=>setNewSlot(s=>({...s,day:e.target.value}))} className="text-xs border border-white/60 bg-white/80 text-prism-ink rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-prism-blue-deep">
            {DAY_NAMES.map((n,i)=><option key={i} value={i}>{n}</option>)}
          </select>
          <input type="time" value={newSlot.start} onChange={e=>setNewSlot(s=>({...s,start:e.target.value}))} className="text-xs border border-white/60 bg-white/80 text-prism-ink rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-prism-blue-deep"/>
          <input type="time" value={newSlot.end} onChange={e=>setNewSlot(s=>({...s,end:e.target.value}))} className="text-xs border border-white/60 bg-white/80 text-prism-ink rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-prism-blue-deep"/>
          <label className="flex items-center gap-1 text-xs text-prism-muted">
            <input type="checkbox" checked={newSlot.restricted} onChange={e=>setNewSlot(s=>({...s,restricted:e.target.checked}))} className="accent-prism-blue-deep focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep"/> catch-up only
          </label>
          <button onClick={addSlot} className="text-xs bg-prism-cta text-white rounded-lg px-2.5 py-1.5 ml-auto shadow-prism-cta focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep">Add</button>
        </div>
      </div>
      <div>
        <h3 className="text-xs font-semibold text-prism-ink mb-2 uppercase tracking-widest">Daily recurring</h3>
        <div className="space-y-1.5">
          {recDaily.map(r=>(
            <div key={r.id} className="flex items-center justify-between text-sm bg-white/70 border border-white/60 rounded-xl px-3 py-2 gap-2">
              <span className="text-prism-ink flex-1 min-w-0">{r.title} · {r.duration}min</span>
              <select value={r.preference||''} onChange={e=>setRecDaily(prev=>prev.map(x=>x.id===r.id?{...x,preference:e.target.value||null}:x))} className="text-xs border border-white/60 bg-white/80 text-prism-ink rounded-lg px-1.5 py-1 shrink-0 focus:outline-none focus:ring-2 focus:ring-prism-blue-deep">
                <option value="">No pref</option>
                <option value="earliest">Earliest</option>
                <option value="latest">Latest</option>
              </select>
              <button onClick={()=>setRecDaily(prev=>prev.map(x=>x.id===r.id?{...x,autoExpire:!x.autoExpire}:x))} className={`text-[10px] px-1.5 py-1 rounded-lg border shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep ${r.autoExpire?'border-amber-300 text-amber-700 bg-amber-50':'border-white/60 text-prism-muted'}`}>
                {r.autoExpire ? 'Auto-expires' : 'Carries over'}
              </button>
              <button onClick={()=>setRecDaily(prev=>prev.filter(x=>x.id!==r.id))} aria-label={`Delete recurring task ${r.title}`} className="text-prism-muted/50 shrink-0 p-1.5 -m-1.5 rounded-full hover:text-rose-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep"><Trash2 className="w-3.5 h-3.5"/></button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2 items-center bg-white/70 border border-white/60 rounded-xl p-2.5">
          <input value={newDaily.title} onChange={e=>setNewDaily(s=>({...s,title:e.target.value}))} placeholder="Title" className="flex-1 text-xs border border-white/60 bg-white/80 text-prism-ink placeholder:text-prism-muted rounded-lg px-2 py-1.5 min-w-0 focus:outline-none focus:ring-2 focus:ring-prism-blue-deep"/>
          <input type="number" value={newDaily.duration} onChange={e=>setNewDaily(s=>({...s,duration:e.target.value}))} className="w-16 text-xs border border-white/60 bg-white/80 text-prism-ink rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-prism-blue-deep"/>
          <select value={newDaily.preference} onChange={e=>setNewDaily(s=>({...s,preference:e.target.value}))} className="text-xs border border-white/60 bg-white/80 text-prism-ink rounded-lg px-1.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-prism-blue-deep">
            <option value="">No pref</option>
            <option value="earliest">Earliest</option>
            <option value="latest">Latest</option>
          </select>
          <button type="button" onClick={()=>setNewDaily(s=>({...s,autoExpire:!s.autoExpire}))} className={`text-[10px] px-1.5 py-1.5 rounded-lg border shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep ${newDaily.autoExpire?'border-amber-300 text-amber-700 bg-amber-50':'border-white/60 text-prism-muted'}`}>
            {newDaily.autoExpire ? 'Auto-expires' : 'Carries over'}
          </button>
          <button onClick={addDaily} className="text-xs bg-prism-cta text-white rounded-lg px-2.5 py-1.5 shrink-0 shadow-prism-cta focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep">Add</button>
        </div>
      </div>
      <div>
        <h3 className="text-xs font-semibold text-prism-ink mb-2 uppercase tracking-widest">Weekly recurring</h3>
        <div className="space-y-1.5">
          {recWeekly.map(r=>(
            <div key={r.id} className="flex items-center justify-between text-sm bg-white/70 border border-white/60 rounded-xl px-3 py-2 gap-2">
              <span className="text-prism-ink flex-1 min-w-0">{r.title} · {r.duration}min{r.day!=null && ` · ${DAY_SHORT[r.day]}`}</span>
              <button onClick={()=>setRecWeekly(prev=>prev.map(x=>x.id===r.id?{...x,autoExpire:!x.autoExpire}:x))}
                className={`text-[10px] px-1.5 py-1 rounded-lg border shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep ${r.autoExpire?'border-amber-300 text-amber-700 bg-amber-50':'border-white/60 text-prism-muted'}`}
                title={r.autoExpire ? 'A missed week is dropped rather than carried forward' : 'A missed week keeps carrying over as overdue'}>
                {r.autoExpire ? 'Auto-expires' : 'Carries over'}
              </button>
              <button onClick={()=>setRecWeekly(prev=>prev.filter(x=>x.id!==r.id))} aria-label={`Delete recurring task ${r.title}`} className="text-prism-muted/50 shrink-0 p-1.5 -m-1.5 rounded-full hover:text-rose-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep"><Trash2 className="w-3.5 h-3.5"/></button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2 items-center bg-white/70 border border-white/60 rounded-xl p-2.5">
          <input value={newWeekly.title} onChange={e=>setNewWeekly(s=>({...s,title:e.target.value}))} placeholder="Title" className="flex-1 text-xs border border-white/60 bg-white/80 text-prism-ink placeholder:text-prism-muted rounded-lg px-2 py-1.5 min-w-0 focus:outline-none focus:ring-2 focus:ring-prism-blue-deep"/>
          <input type="number" value={newWeekly.duration} onChange={e=>setNewWeekly(s=>({...s,duration:e.target.value}))} className="w-16 text-xs border border-white/60 bg-white/80 text-prism-ink rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-prism-blue-deep"/>
          <select value={newWeekly.day} onChange={e=>setNewWeekly(s=>({...s,day:e.target.value}))} className="text-xs border border-white/60 bg-white/80 text-prism-ink rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-prism-blue-deep">
            <option value="">Any day</option>
            {DAY_NAMES.map((n,i)=><option key={i} value={i}>{n}</option>)}
          </select>
          <button onClick={addWeekly} className="text-xs bg-prism-cta text-white rounded-lg px-2.5 py-1.5 shadow-prism-cta focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep">Add</button>
        </div>
      </div>
      </div>
      {backlogCount>0 && (
        <button onClick={onClearBacklog} className="w-full mt-4 text-xs text-prism-muted border border-white/60 bg-white/50 rounded-xl py-2.5 hover:text-prism-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep">
          Mark {backlogCount} old recurring task{backlogCount>1?'s':''} as done
        </button>
      )}
    </div>
  );
}
/* ============================================================
   Term trends — weekly busy-ness (priority 1), estimate vs actual (priority 2),
   completed volume (priority 3). All hand-rolled with plain divs/inline styles to
   match the app's existing visual language rather than pulling in a chart library.
   ============================================================ */
/* ============================================================
   Completed work — a real record of what actually got done, not just a count.
   Reads the same live+archived union the stats bar uses, so nothing disappears
   from view when old completions are compacted into the archive.
   ============================================================ */
function CompletedPanel({ records }){
  const [range,setRange] = useState('month'); // week | month | all
  const now = new Date();
  const filtered = useMemo(()=>{
    const weekStart = toDateStr(startOfWeek(now));
    const monthPrefix = toDateStr(now).slice(0,7);
    return records
      .filter(r=>{
        if (!r.doneAt) return false;
        const dStr = toDateStr(new Date(r.doneAt));
        if (range==='week') return dStr >= weekStart;
        if (range==='month') return dStr.slice(0,7) === monthPrefix;
        return true;
      })
      .sort((a,b)=>b.doneAt-a.doneAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[records, range]);

  const totalEstimated = filtered.reduce((s,r)=>s+(r.duration||0),0);
  const labels = { week:'This week', month:'This month', all:'All time' };
  return (
    <div>
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <h3 className="text-xs font-semibold text-prism-ink uppercase tracking-widest">Completed work</h3>
        <div className="flex gap-1">
          {['week','month','all'].map(r=>(
            <button key={r} onClick={()=>setRange(r)}
              className={`text-xs px-2 py-1 rounded-lg border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep ${range===r?'bg-prism-cta text-white border-transparent':'border-white/60 bg-white/50 text-prism-muted hover:border-prism-blue/50'}`}>
              {labels[r]}
            </button>
          ))}
        </div>
        <span className="text-xs text-prism-muted/70">
          {filtered.length} task{filtered.length===1?'':'s'} · {formatDurationHM(totalEstimated)} estimated
        </span>
      </div>
      {filtered.length===0 ? (
        <div className="text-xs text-prism-muted/70">Nothing completed in this period yet.</div>
      ) : (
        <div className="space-y-1">
          {filtered.map(r=>{
            const est = r.duration;
            const act = r.actualMinutes;
            const over = act!=null && est>0 ? act/est : null;
            return (
              <div key={r.id+'|'+r.doneAt} className="flex items-baseline gap-2 text-xs border-b border-white/50 pb-1">
                <span className="font-mono text-prism-muted/70 shrink-0 w-14">{formatShortDate(toDateStr(new Date(r.doneAt)))}</span>
                <span className={`flex-1 min-w-0 truncate ${r.recurringId?'text-emerald-700':'text-prism-ink'}`}>{r.title}</span>
                <span className="font-mono text-prism-muted/70 shrink-0">{formatDurationHM(est)}</span>
                {act!=null && (
                  <span className={`font-mono shrink-0 ${over>1.15?'text-amber-600':over<0.85?'text-indigo-600':'text-emerald-600'}`}>
                    actual {formatDurationHM(act)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
function TrendsPanel({ weeklySnapshots, weeklyVolume, accuracy }){
  const weekKeys = Object.keys(weeklySnapshots).sort().slice(-10);
  const dotColor = { green:'bg-emerald-500', orange:'bg-orange-500', red:'bg-rose-500' };
  const maxVolume = Math.max(1, ...weeklyVolume.map(w=>w.count));
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      <div>
        <h3 className="text-xs font-semibold text-prism-ink mb-2 uppercase tracking-widest">Weekly busy-ness</h3>
        {weekKeys.length===0 ? (
          <div className="text-xs text-prism-muted/70">Not enough history yet — this fills in week by week as the traffic light runs.</div>
        ) : (
          <div className="flex items-end gap-2 flex-wrap">
            {weekKeys.map(wk=>(
              <div key={wk} className="flex flex-col items-center gap-1" title={`Week of ${formatShortDate(wk)}: ${weeklySnapshots[wk].level}`}>
                <span className={`w-3.5 h-3.5 rounded-full ${dotColor[weeklySnapshots[wk].level]}`}></span>
                <span className="text-xs text-prism-muted/60 font-mono">{formatShortDate(wk)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div>
        <h3 className="text-xs font-semibold text-prism-ink mb-2 uppercase tracking-widest">Estimate vs actual</h3>
        {!accuracy ? (
          <div className="text-xs text-prism-muted/70">Log actual time on a few completed tasks (via the completion prompt) to see this.</div>
        ) : (
          <div className="text-sm text-prism-muted">
            Based on <span className="font-mono font-semibold text-prism-ink">{accuracy.count}</span> task{accuracy.count>1?'s':''} with logged time, you're averaging{' '}
            <span className={`font-mono font-semibold ${accuracy.ratio>1.15?'text-amber-600':accuracy.ratio<0.85?'text-indigo-600':'text-emerald-600'}`}>
              {accuracy.ratio>=1 ? `${Math.round((accuracy.ratio-1)*100)}% longer` : `${Math.round((1-accuracy.ratio)*100)}% shorter`}
            </span>{' '}than estimated.
          </div>
        )}
      </div>
      <div>
        <h3 className="text-xs font-semibold text-prism-ink mb-2 uppercase tracking-widest">Completed per week</h3>
        {weeklyVolume.length===0 ? (
          <div className="text-xs text-prism-muted/70">No history yet.</div>
        ) : (
          <div className="flex items-end gap-2 h-16">
            {weeklyVolume.map(w=>{
              const heightPct = w.count===0 ? 4 : Math.max(10, Math.round((w.count/maxVolume)*100));
              return (
                <div key={w.weekStart} className="flex flex-col items-center justify-end gap-1 h-full">
                  <span className="text-xs text-prism-muted/70 font-mono">{w.count}</span>
                  <div className="w-4 bg-prism-violet/60 rounded-t" style={{ height: `${heightPct}%` }}></div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
/* ============================================================
   Main component
   ============================================================ */
export default function WeekPlanner(){
  const { user, signOut } = useAuth();
  // Best-effort, once per sign-in. Notification.requestPermission() only
  // actually prompts the user the first time (already-granted/denied
  // resolves immediately), so re-running this on every reload while signed
  // in is harmless.
  useEffect(()=>{ if (user?.uid) registerForPush(user.uid); }, [user?.uid]);
  const [tasks, setTasks, syncStatus, tasksLoaded] = useCloudTasks(user?.uid);
  const [appState, setAppState, appLoaded] = useCloudDoc(user?.uid, 'app', {
    slots: DEFAULT_SLOTS,
    recDaily: DEFAULT_REC_DAILY,
    recWeekly: DEFAULT_REC_WEEKLY,
    lastGenWeek: null,
    weeklySnapshots: {},
    archive: [],
  });
  const { slots, recDaily, recWeekly, lastGenWeek, weeklySnapshots, archive } = appState;
  // Defaulted rather than destructured: an account created before meetings
  // existed has a stored state doc with no `meetings` key, and every consumer
  // below iterates this.
  //
  // Memoised because `x || []` mints a NEW array every render whenever the key
  // is absent, which would change the identity of a buildSchedule dependency on
  // every single render and recompute the whole schedule forever.
  const meetings = useMemo(()=>appState.meetings || [], [appState.meetings]);
  // True once BOTH cloud collections have delivered their first real snapshot.
  // Everything below that generates, expires, or archives tasks must wait for this —
  // running any of it against the hooks' empty starting values (before Firestore has
  // actually replied) would generate a duplicate week's worth of recurring tasks, or
  // silently expire/archive nothing against zero real data. Same role `loaded` played
  // for the old synchronous localStorage read; async cloud data just makes it matter
  // more, since the gap before the first reply is no longer instantaneous.
  const loaded = !!user && tasksLoaded && appLoaded;
  function setSlots(updater){ setAppState(prev => ({ ...prev, slots: typeof updater==='function' ? updater(prev.slots) : updater })); }
  function setRecDaily(updater){ setAppState(prev => ({ ...prev, recDaily: typeof updater==='function' ? updater(prev.recDaily) : updater })); }
  function setRecWeekly(updater){ setAppState(prev => ({ ...prev, recWeekly: typeof updater==='function' ? updater(prev.recWeekly) : updater })); }
  function setLastGenWeek(updater){ setAppState(prev => ({ ...prev, lastGenWeek: typeof updater==='function' ? updater(prev.lastGenWeek) : updater })); }
  function setWeeklySnapshots(updater){ setAppState(prev => ({ ...prev, weeklySnapshots: typeof updater==='function' ? updater(prev.weeklySnapshots) : updater })); }
  function setMeetings(updater){ setAppState(prev => ({ ...prev, meetings: typeof updater==='function' ? updater(prev.meetings || []) : updater })); }
  function setArchive(updater){ setAppState(prev => ({ ...prev, archive: typeof updater==='function' ? updater(prev.archive) : updater })); }
  const [now,setNow] = useState(new Date());
  const [showAdd,setShowAdd] = useState(false);
  const [openDrawer,setOpenDrawer] = useState(null); // null | 'settings' | 'trends' — accordion, so only one eats bottom-bar height at a time
  const [toast,setToast] = useState(null);
  const [timeInput,setTimeInput] = useState('');
  const [draggingTaskId,setDraggingTaskId] = useState(null); // id of the task currently being dragged, or null
  const [dragOverKey,setDragOverKey] = useState(null); // instance key of the slot currently hovered during a drag
  const [explainingKey,setExplainingKey] = useState(null); // which placed session is showing its "why is this here?" explanation
  const [editingTaskId,setEditingTaskId] = useState(null); // task currently open in the edit form, or null
  const [showAddMeeting,setShowAddMeeting] = useState(false);
  const [editingMeetingId,setEditingMeetingId] = useState(null); // meeting open in the edit form, or null
  const [pendingUndo,setPendingUndo] = useState(null); // { task, timeoutId } — a just-deleted task that can still be restored
  /*
    FAB/footer overlap fix. The footer bar (StatsBar + drawer toggles) uses
    `flex-wrap` and wraps onto a second line at narrow widths (measured at
    375px and 768px), while the Capture Thought FAB below is `position:
    fixed`, so it floats independently of document flow and does not push
    off the footer when it grows. A fixed Tailwind breakpoint chosen to
    dodge the wrap is fragile — it only covers the widths someone measured.
    Measuring the footer's real rendered height and feeding it to the FAB as
    a bottom offset is breakpoint-agnostic: it's correct whether the footer
    is one line or two, at any width, on any content change (e.g. a future
    fourth drawer toggle).
  */
  const footerRef = useRef(null);
  const [footerHeight,setFooterHeight] = useState(0);
  const [captureDockEl,setCaptureDockEl] = useState(null);
  /*
    A running timer is deliberately DEVICE-local: it describes what this device
    is doing right now, so it goes to localStorage rather than Firestore. Syncing
    it would make a timer started on the phone appear to be running on the
    laptop, and let two devices race to write the finish time.

    Persisted rather than held in memory only, so locking the phone or the PWA
    reloading mid-task does not lose the count.
  */
  const [activeTimer,setActiveTimer] = useState(()=>{
    try {
      const raw = localStorage.getItem(TIMER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  });
  useEffect(()=>{
    try {
      if (activeTimer) localStorage.setItem(TIMER_KEY, JSON.stringify(activeTimer));
      else localStorage.removeItem(TIMER_KEY);
    } catch { /* private mode / quota — the timer still works for this session */ }
  },[activeTimer]);
  useEffect(()=>{
    const el = footerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries=>{
      const h = entries[0]?.contentRect?.height;
      if (typeof h === 'number') setFooterHeight(h);
    });
    ro.observe(el);
    return ()=>ro.disconnect();
  },[]);
  useEffect(()=>{
    /*
      Tick on the MINUTE, not every 30 seconds. `now` feeds buildSchedule and five
      effects, but the schedule can only actually change when the clock crosses a
      minute boundary (slot starts/ends are minute-granular). Returning the SAME
      Date object when the minute hasn't moved makes React bail out of the re-render
      entirely, so nothing downstream recomputes. Cheap today; important once writes
      go to a cloud backend and every needless recompute costs a round trip.
    */
    const t = setInterval(()=>{
      setNow(prev=>{
        const next = new Date();
        const sameMinute = next.getMinutes()===prev.getMinutes()
          && next.getHours()===prev.getHours()
          && next.getDate()===prev.getDate()
          && next.getMonth()===prev.getMonth()
          && next.getFullYear()===prev.getFullYear();
        return sameMinute ? prev : next;
      });
    }, 15000);
    return ()=>clearInterval(t);
  },[]);
  /*
    Global keyboard shortcuts. Deliberately ignored while focus is in any text field
    or the form is already open, so typing "n" in a task title never opens a new form.
      n / N  -> open the add-task form
      Escape -> close whichever form is open
  */
  useEffect(()=>{
    function onKeyDown(e){
      const el = e.target;
      const typing = el && (el.tagName==='INPUT' || el.tagName==='TEXTAREA' || el.tagName==='SELECT' || el.isContentEditable);
      if (e.key==='Escape'){
        setShowAdd(false);
        setEditingTaskId(null);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key==='n' || e.key==='N'){
        e.preventDefault();
        setEditingTaskId(null);
        setShowAdd(true);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return ()=>window.removeEventListener('keydown', onKeyDown);
  },[]);
  useEffect(()=>{
    if (!toast || toast.askTime) return; // stay open while waiting for an explicit Save/Skip on the time prompt
    const t = setTimeout(()=> setToast(cur => (cur && cur.id===toast.id ? null : cur)), 2600);
    return ()=>clearTimeout(t);
  },[toast]);
  useEffect(()=>{
    if (!loaded) return;
    // NOTE: deliberately NOT short-circuiting when this week has already been
    // generated. A recurring definition added mid-week must produce its instances
    // immediately rather than waiting for next Monday, so this runs whenever the
    // definitions change too. generateRecurringInstances dedupes internally, so
    // re-running is harmless — and setTasks is only called when it actually
    // produced something new.
    const { newTasks, newLastGenWeek } = generateRecurringInstances(tasks, recDaily, recWeekly, now, lastGenWeek);
    if (newTasks.length) setTasks(prev=>[...prev, ...newTasks]);
    if (newLastGenWeek !== lastGenWeek) setLastGenWeek(newLastGenWeek);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[loaded, now, lastGenWeek, recDaily, recWeekly]);
  useEffect(()=>{
    if (!loaded) return;
    const todayStrNow = toDateStr(now);
    setTasks(prev=>applyAutoExpiry(prev, recDaily, recWeekly, todayStrNow));
  },[loaded, now, recDaily, recWeekly]);
  useEffect(()=>{
    if (!loaded) return;
    const todayStrNow = toDateStr(now);
    setTasks(prev=>clearStalePins(prev, slots, todayStrNow));
  },[loaded, now, slots]);
  // Compact long-completed tasks out of the live list. Runs on the same 30s tick as
  // the other maintenance effects; archiveOldCompleted returns null when there's
  // nothing to move, so this is a no-op almost every time it fires.
  useEffect(()=>{
    if (!loaded) return;
    const result = archiveOldCompleted(tasks, archive, Date.now());
    if (!result) return;
    setTasks(result.tasks);
    setArchive(result.archive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[loaded, now]);
  // Baseline schedule: catch-up slots ALWAYS gated here, regardless of workload level —
  // this is what the traffic light itself is diagnosed from, so the diagnosis never
  // depends on whether the unlock is currently active (see computeWorkload for why).
  const baselineSchedule = useMemo(()=>buildSchedule(tasks, slots, now, SCHEDULE_WEEKS, false, meetings), [tasks, slots, now, meetings]);
  const workload = useMemo(()=>computeWorkload(tasks, baselineSchedule, slots, recDaily, recWeekly, now), [tasks, baselineSchedule, slots, recDaily, recWeekly, now]);
  // Term-trend history: write the CURRENT week's workload snapshot under its own
  // week-start key every time it changes. Past weeks' keys are never touched again once
  // the calendar moves on, so they're naturally frozen as history — no separate
  // "week rollover" detection needed, and nothing to get out of sync.
  useEffect(()=>{
    if (!loaded) return;
    const wk = toDateStr(startOfWeek(now));
    setWeeklySnapshots(prev=>{
      const existing = prev[wk];
      if (existing && existing.level===workload.level && existing.overflowMinutes===workload.overflowMinutes) return prev;
      const merged = { ...prev, [wk]: { level: workload.level, overflowMinutes: workload.overflowMinutes } };
      // Cap history at roughly a year. Without this the map grows by one key every
      // week forever and rides along in every localStorage write; the trends view
      // only ever reads the last 10 weeks anyway.
      const keys = Object.keys(merged).sort();
      if (keys.length <= SNAPSHOT_HISTORY_WEEKS) return merged;
      const trimmed = {};
      for (const k of keys.slice(-SNAPSHOT_HISTORY_WEEKS)) trimmed[k] = merged[k];
      return trimmed;
    });
  },[loaded, now, workload.level, workload.overflowMinutes]);
  // Due-date risk: a SEPARATE trigger for the same unlock, computed from the same
  // baseline for the same anti-oscillation reason — see computeDueDateRisk.
  const dueDateRisk = useMemo(()=>computeDueDateRisk(tasks, baselineSchedule, toDateStr(now)), [tasks, baselineSchedule, now]);
  // Slots unlock if EITHER the week is overloaded overall OR a specific task's own
  // deadline is projected to be missed — two different questions, one shared remedy.
  const slotsUnlocked = workload.level==='red' || dueDateRisk.count>0;
  // The schedule actually shown/used: identical to baseline unless something unlocked
  // catch-up slots, in which case everything gets recomputed once more with them open.
  const schedule = useMemo(()=>{
    if (slotsUnlocked) return buildSchedule(tasks, slots, now, SCHEDULE_WEEKS, true, meetings);
    return baselineSchedule;
  }, [slotsUnlocked, tasks, slots, now, baselineSchedule]);
  // Persist the current render's session shape back onto each task so the UI reflects
  // it (e.g. "part 2 of 3" labels, completion checkboxes) — and so a completed session
  // stays marked done even though everything else is recarved fresh every render.
  //
  // IMPORTANT: this must do a real content comparison, not just compare array LENGTH.
  // Under the fluid remaining-work model, a task's session count can legitimately stay
  // the same between renders while the actual sizes/order/ids differ (e.g. its
  // remaining work got recarved into a different shape because a higher-priority task
  // now claims the slot it used to occupy). A length-only check would silently skip
  // writing that new shape back, leaving the UI showing a stale, no-longer-accurate
  // session layout — which is exactly what caused schedules to look "stuck" even after
  // the underlying computation had correctly reordered things.
  function sessionsEqual(a, b){
    if (!a || !b || a.length!==b.length) return false;
    for (let i=0;i<a.length;i++){
      if (a[i].id!==b[i].id || a[i].minutesTotal!==b[i].minutesTotal || a[i].done!==b[i].done) return false;
    }
    return true;
  }
  useEffect(()=>{
    if (!loaded || !schedule.sessionUpdates || schedule.sessionUpdates.size===0) return;
    setTasks(prev=>{
      let changed = false;
      const next = prev.map(t=>{
        if (!schedule.sessionUpdates.has(t.id)) return t;
        const newSessions = schedule.sessionUpdates.get(t.id);
        if (sessionsEqual(t.sessions, newSessions)) return t;
        changed = true;
        return { ...t, sessions: newSessions };
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[schedule.sessionUpdates, loaded]);
  // Live-completed tasks plus archived records — every completion-facing number reads
  // this union, so archiving old work never changes what's displayed.
  const records = useMemo(()=>completionRecords(tasks, archive), [tasks, archive]);
  const stats = useMemo(()=>computeStats(records, now), [records, now]);
  const todayStr = toDateStr(now);
  const nowMin = now.getHours()*60+now.getMinutes();
  const currentIdx = schedule.instances.findIndex(i=>i.date===todayStr && nowMin>=i.startMin && nowMin<i.endMin);
  const currentInst = currentIdx>=0 ? schedule.instances[currentIdx] : null;
  const nextInst = currentInst ? schedule.instances[currentIdx+1] : schedule.instances[0];
  const nextWeekStart = toDateStr(addDays(startOfWeek(now),7));
  const weekThreeStart = toDateStr(addDays(startOfWeek(now),14));
  // Render the FULL scheduling horizon. buildSchedule looks 3 weeks ahead, so showing
  // only 2 meant anything landing in week 3 was invisible — it existed, held capacity,
  // and could miss a due date, but you couldn't see it, drag it, or ask why it was
  // there. The rendered range and SCHEDULE_WEEKS are now driven by the same constant.
  const horizonEnd = toDateStr(addDays(startOfWeek(now), SCHEDULE_WEEKS*7 - 1));
  const weekDates = [];
  for (let i=0;i<SCHEDULE_WEEKS*7;i++){ const s = toDateStr(addDays(startOfWeek(now),i)); if (s>=todayStr && s<=horizonEnd) weekDates.push(s); }
  /*
    Slots and meetings are interleaved into ONE time-ordered list per day rather
    than shown as two separate stacks. The point of the board is to answer "what
    does this day actually look like" — a meeting sitting in its real position
    between two flex blocks answers that; a meetings section bolted above the
    slots does not.
  */
  const groupedDays = weekDates.map(dstr=>{
    const slotRows = schedule.instances
      .filter(i=>i.date===dstr)
      .map(inst=>({ kind:'slot', startMin: inst.startMin, inst }));
    const meetingRows = meetings
      .filter(mt=>mt.date===dstr)
      // A meeting that has already finished today is history, same treatment as
      // a flex block whose time has passed.
      .filter(mt=>!(dstr===todayStr && timeToMin(mt.end)<=nowMin))
      .map(mt=>({ kind:'meeting', startMin: timeToMin(mt.start), meeting: mt }));
    return {
      date: dstr,
      dayOfWeek: parseDateStr(dstr).getDay(),
      rows: [...slotRows, ...meetingRows].sort((a,b)=>a.startMin-b.startMin),
    };
  });
  const laterCount = schedule.instances.filter(i=>i.date>horizonEnd).reduce((sum,i)=>sum+i.assigned.length,0);
  const backlogCount = tasks.filter(t=>!t.done && t.recurringId && t.dueDate < todayStr).length;
  const pinnedCount = tasks.filter(t=>!t.done && t.pinnedTo).length;
  // Overflow is emitted as individual unplaced PIECES; a single task can contribute
  // several. Group them back per task so the banner can name what's actually stuck and
  // how much of it, rather than reporting a piece count nobody can act on.
  const overflowByTask = useMemo(()=>{
    const byId = new Map();
    for (const piece of schedule.overflow){
      const existing = byId.get(piece.id);
      if (existing) existing.unplacedMinutes += piece.duration;
      else byId.set(piece.id, { id: piece.id, title: piece.title, duration: piece.duration, dueDate: piece.dueDate, unplacedMinutes: piece.duration });
    }
    return [...byId.values()].sort((a,b)=>b.unplacedMinutes-a.unplacedMinutes);
  }, [schedule.overflow]);
  const accuracy = useMemo(()=>computeAccuracy(records), [records]);
  const weeklyVolume = useMemo(()=>computeWeeklyVolume(records, Object.keys(weeklySnapshots).sort().slice(-10)), [records, weeklySnapshots]);
  // Slot capacity facts used by the task form's entry-time fit warnings.
  const largestSlotMinutes = useMemo(()=>slots.reduce((max,s)=>Math.max(max, timeToMin(s.end)-timeToMin(s.start)), 0), [slots]);
  const totalWeeklyMinutes = useMemo(()=>slots.reduce((sum,s)=>sum + (timeToMin(s.end)-timeToMin(s.start)), 0), [slots]);
  const editingTask = editingTaskId ? tasks.find(t=>t.id===editingTaskId) || null : null;
  const editingMeeting = editingMeetingId ? meetings.find(mt=>mt.id===editingMeetingId) || null : null;
  // Action points grouped by their meeting, and where the scheduler actually put
  // each one, so a meeting can show its follow-up work and when it's happening.
  const actionPointsByMeeting = useMemo(()=>{
    const byMeeting = new Map();
    for (const t of tasks){
      if (!t.meetingId) continue;
      if (!byMeeting.has(t.meetingId)) byMeeting.set(t.meetingId, []);
      byMeeting.get(t.meetingId).push(t);
    }
    return byMeeting;
  }, [tasks]);
  const placementByTaskId = useMemo(()=>{
    const placed = new Map();
    for (const inst of schedule.instances){
      for (const item of inst.assigned){
        // First placement wins — that's the soonest you'll touch it.
        if (!placed.has(item.id)) placed.set(item.id, { date: inst.date, startMin: inst.startMin });
      }
    }
    return placed;
  }, [schedule]);
  /*
    "Everything has a home" — unfinished tasks intrude on your attention, but making a
    concrete plan for them discharges most of that intrusion; you don't have to finish
    them, only genuinely schedule them. The scheduler has always been doing exactly
    that work, silently. This states it, so the reassurance actually lands instead of
    only the warnings being visible.
  */
  const pendingCount = tasks.filter(t=>!t.done).length;
  const allPlaced = pendingCount>0 && overflowByTask.length===0 && dueDateRisk.count===0;
  /*
    The timer holds only ids, so the task it names can disappear underneath it —
    deleted here, or completed on another device and synced in. Drop the timer
    rather than leaving a bar counting up against nothing.
  */
  const timedTask = activeTimer ? tasks.find(t=>t.id===activeTimer.taskId) : null;
  useEffect(()=>{
    if (!activeTimer || !loaded) return;
    const t = tasks.find(x=>x.id===activeTimer.taskId);
    if (!t || t.done) setActiveTimer(null);
  },[activeTimer, tasks, loaded]);
  function showCompletionToast(taskId, sessionId){
    const message = CELEBRATION_MESSAGES[Math.floor(Math.random()*CELEBRATION_MESSAGES.length)];
    setTimeInput('');
    setToast({ id: Date.now(), message, askTime:true, taskId, sessionId });
  }
  function saveActualTime(){
    if (!toast) return;
    const mins = Math.round(Number(timeInput));
    if (mins>0){
      setTasks(prev=>prev.map(t=>{
        if (t.id!==toast.taskId) return t;
        if (t.sessions && t.sessions.length){
          return { ...t, sessions: t.sessions.map(s=>s.id===toast.sessionId?{...s, actualMinutes:mins}:s) };
        }
        return { ...t, actualMinutes: mins };
      }));
    }
    setToast(null);
  }
  function dismissTimePrompt(){
    setToast(null);
  }
  function toggleDone(taskId, sessionId){
    const current = tasks.find(x=>x.id===taskId);
    let willComplete = false;
    if (current){
      let sessions = current.sessions;
      if ((!sessions || !sessions.length) && schedule.sessionUpdates && schedule.sessionUpdates.has(taskId)){
        sessions = schedule.sessionUpdates.get(taskId);
      }
      if (sessions && sessions.length){
        const target = sessions.find(s=>s.id===sessionId);
        willComplete = target ? !target.done : false;
      } else {
        willComplete = !current.done;
      }
    }
    setTasks(prev=>prev.map(t=>{
      if (t.id!==taskId) return t;
      let sessions = t.sessions;
      if ((!sessions || !sessions.length) && schedule.sessionUpdates && schedule.sessionUpdates.has(taskId)){
        sessions = schedule.sessionUpdates.get(taskId);
      }
      if (sessions && sessions.length){
        const newSessions = sessions.map(s=>s.id===sessionId?{...s, done:!s.done, doneAt: !s.done?Date.now():null}:s);
        const allDone = newSessions.every(s=>s.done);
        return { ...t, sessions: newSessions, done: allDone, doneAt: allDone?Date.now():null };
      }
      return { ...t, done:!t.done, doneAt: !t.done?Date.now():null };
    }));
    if (willComplete) showCompletionToast(taskId, sessionId);
  }
  function togglePressing(taskId){
    setTasks(prev=>prev.map(t=>t.id===taskId?{...t, pressing:!t.pressing}:t));
  }
  /* ---- Timer ---------------------------------------------------------- */
  function startTimer(item){
    // `item` is a scheduled piece, so item.duration is THIS chunk's length —
    // a 90-minute task carved into three sessions times each 30-minute sitting
    // against 30 minutes, not 90.
    setActiveTimer({
      taskId: item.id,
      sessionId: item.sessionId ?? null,
      startedAt: Date.now(),
      plannedMinutes: Math.max(1, Number(item.duration) || MIN_TASK_MINUTES),
    });
  }
  function cancelTimer(){ setActiveTimer(null); }
  /*
    Finishing from the timer writes actualMinutes itself instead of raising the
    "Actual time?" prompt — the whole point of having timed it is that the app
    already knows. The toast then reports the result against the estimate,
    which is the reward for beating it.
  */
  function completeFromTimer(){
    const timer = activeTimer;
    if (!timer) return;
    const mins = Math.max(1, Math.round((Date.now()-timer.startedAt)/60000));
    setActiveTimer(null);
    setTasks(prev=>prev.map(t=>{
      if (t.id!==timer.taskId) return t;
      let sessions = t.sessions;
      if ((!sessions || !sessions.length) && schedule.sessionUpdates && schedule.sessionUpdates.has(t.id)){
        sessions = schedule.sessionUpdates.get(t.id);
      }
      if (sessions && sessions.length){
        const newSessions = sessions.map(s=>s.id===timer.sessionId?{...s, done:true, doneAt:Date.now(), actualMinutes:mins}:s);
        const allDone = newSessions.every(s=>s.done);
        return { ...t, sessions:newSessions, done:allDone, doneAt: allDone?Date.now():t.doneAt };
      }
      return { ...t, done:true, doneAt:Date.now(), actualMinutes:mins };
    }));
    const diff = timer.plannedMinutes - mins;
    const message = diff > 0
      ? `Done in ${mins}m — ${diff}m under your ${timer.plannedMinutes}m estimate.`
      : diff < 0
        ? `Done in ${mins}m — ${-diff}m over the ${timer.plannedMinutes}m you planned.`
        : `Done in ${mins}m — exactly on your estimate.`;
    setToast({ id: Date.now(), message, askTime:false, taskId: timer.taskId, sessionId: timer.sessionId });
  }
  function notCompleteFromTimer(){
    const timer = activeTimer;
    if (!timer) return;
    setActiveTimer(null);
    rescheduleTask(timer.taskId);
  }
  /*
    "Not complete" does NOT close the task. It pushes it past this moment so the
    scheduler places it in a LATER block instead of the one it just failed to
    fit into, and drops any manual pin holding it to that block.

    notBefore is also set by meeting action points (an action point cannot start
    before its meeting ends), so this takes the LATER of the two boundaries: a
    task deferred to next Tuesday must not be loosened back to this afternoon.
  */
  function rescheduleTask(taskId){
    const boundary = { date: todayStr, minute: nowMin + 1 };
    setTasks(prev=>prev.map(t=> t.id===taskId
      ? { ...t, pinnedTo:null, notBefore: laterBoundary(t.notBefore, boundary) }
      : t));
    setToast({ id: Date.now(), message: 'Sent back to the scheduler for a later block.', askTime:false });
  }
  // ---- Drag and drop: manual placement overrides ----
  // Dropping a task on a slot writes a `pinnedTo` marker onto the TASK (not the
  // session), because sessions are recarved fresh on every render and their ids are
  // not stable across recomputes — pinning a session id would break on the very next
  // render. Pinning the task itself is stable, and the scheduler's PASS 0 honours it.
  function handleDragStartTask(taskId){
    setDraggingTaskId(taskId);
  }
  function handleDragEndTask(){
    setDraggingTaskId(null);
    setDragOverKey(null);
  }
  function handleDropOnSlot(slotId, date){
    if (!draggingTaskId) return;
    setTasks(prev=>prev.map(t=> t.id===draggingTaskId ? { ...t, pinnedTo: { slotId, date } } : t));
    setDraggingTaskId(null);
    setDragOverKey(null);
  }
  function unpinTask(taskId){
    setTasks(prev=>prev.map(t=>t.id===taskId?{...t, pinnedTo:null}:t));
  }
  function clearAllPins(){
    setTasks(prev=>prev.map(t=> t.pinnedTo ? {...t, pinnedTo:null} : t));
  }
  function toggleExplain(key){
    setExplainingKey(cur=> cur===key ? null : key);
  }
  /*
    DELETE WITH UNDO — deletion used to be instant and irreversible, on a 12px icon.
    Rather than a confirm dialog on every delete (which gets tiresome fast for a
    routine action), the task is removed immediately but stashed for UNDO_WINDOW_MS,
    with a toast offering to restore it. Fast when you meant it, recoverable when you
    didn't. A second delete during the window commits the first one.
  */
  function deleteTask(taskId){
    const victim = tasks.find(t=>t.id===taskId);
    if (!victim) return;
    if (pendingUndo && pendingUndo.timeoutId) clearTimeout(pendingUndo.timeoutId);
    setTasks(prev=>prev.filter(t=>t.id!==taskId));
    if (editingTaskId===taskId) setEditingTaskId(null);
    const timeoutId = setTimeout(()=>setPendingUndo(null), UNDO_WINDOW_MS);
    setPendingUndo({ task: victim, timeoutId });
  }
  function undoDelete(){
    if (!pendingUndo) return;
    if (pendingUndo.timeoutId) clearTimeout(pendingUndo.timeoutId);
    setTasks(prev=>[...prev, pendingUndo.task]);
    setPendingUndo(null);
  }
  function addTask({ title, duration, dueDate, pressing, source='adhoc' }){
    setTasks(prev=>[...prev, makeTask({ title, duration, dueDate, pressing, source, order: Date.now() })]);
  }
  function addMeeting({ title, date, start, end, notes }){
    setMeetings(prev=>[...prev, { id: genId(), title, date, start, end, notes }]);
    setShowAddMeeting(false);
  }
  function saveMeetingEdit({ title, date, start, end, notes }){
    if (!editingMeetingId) return;
    setMeetings(prev=>prev.map(mt=> mt.id===editingMeetingId ? { ...mt, title, date, start, end, notes } : mt));
    // Moving a meeting moves the earliest moment its action points can be worked
    // on, otherwise a meeting pushed later would leave its follow-up work sitting
    // in slots that now sit before it.
    setTasks(prev=>prev.map(t=> t.meetingId===editingMeetingId
      ? { ...t, notBefore: { date, minute: timeToMin(end) } }
      : t));
    setEditingMeetingId(null);
  }
  function deleteMeeting(meetingId){
    setMeetings(prev=>prev.filter(mt=>mt.id!==meetingId));
    // Deliberately keeps the action points. They're real work you decided to do —
    // deleting a calendar entry shouldn't silently bin your tasks. They just lose
    // the link and the not-before constraint, and carry on as ordinary tasks.
    setTasks(prev=>prev.map(t=> t.meetingId===meetingId
      ? { ...t, meetingId: null, notBefore: null }
      : t));
    if (editingMeetingId===meetingId) setEditingMeetingId(null);
  }
  function addActionPoint(meetingId, title){
    const mt = meetings.find(x=>x.id===meetingId);
    if (!mt || !title.trim()) return;
    setTasks(prev=>[...prev, makeTask({
      title: title.trim(), duration: MIN_TASK_MINUTES, dueDate: null,
      source: 'meeting', order: Date.now(),
      meetingId, notBefore: { date: mt.date, minute: timeToMin(mt.end) },
    })]);
  }
  function startEditingMeeting(meetingId){
    setShowAddMeeting(false);
    setEditingMeetingId(meetingId);
  }
  function saveTaskEdit({ title, duration, dueDate, pressing }){
    if (!editingTaskId) return;
    setTasks(prev=>prev.map(t=> t.id===editingTaskId ? { ...t, title, duration, dueDate, pressing } : t));
    setEditingTaskId(null);
  }
  function startEditing(taskId){
    setShowAdd(false);
    setEditingTaskId(taskId);
  }
  function clearBacklog(){
    setTasks(prev=>prev.map(t=> (!t.done && t.recurringId && t.dueDate<todayStr) ? {...t, done:true, doneAt:Date.now()} : t));
  }
  async function handleManualImport(){
    if (!user) return;
    const result = await importFromThisBrowser(user.uid);
    const message = result.imported
      ? `Imported ${result.count} task${result.count===1?'':'s'} from this browser.`
      : 'Nothing found in this browser to import.';
    setToast({ id: Date.now(), message, askTime:false });
  }
  if (!loaded){
    return (
      <div className="h-screen w-full flex items-center justify-center bg-prism-base">
        <Loader2 className="w-6 h-6 text-prism-muted animate-spin"/>
      </div>
    );
  }
  return (
    <div className="week-planner-root relative h-full w-full overflow-hidden bg-prism-base text-prism-ink flex flex-col isolate">
      {/* Ambient background blobs — decorative only, sit behind every real
          surface so the glass cards above have something to show through.
          Static gradients, not animated, so there's nothing here that
          prefers-reduced-motion needs to suppress. */}
      <div aria-hidden="true" className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
        <div className="absolute -top-44 -left-40 w-[620px] h-[620px] rounded-full bg-prism-blob-blue blur-prism-blob opacity-55"/>
        <div className="absolute -bottom-56 -right-44 w-[680px] h-[680px] rounded-full bg-prism-blob-violet blur-prism-blob opacity-45"/>
        <div className="absolute top-[40%] left-[55%] w-[420px] h-[420px] rounded-full bg-prism-blob-navy blur-prism-blob opacity-[0.14]"/>
      </div>
      <header className="relative z-10 flex items-center justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 pt-[max(0.75rem,env(safe-area-inset-top))] border-b border-white/60 bg-white/55 backdrop-blur-xl backdrop-saturate-150 shrink-0">
        <div className="min-w-0 flex-1">
          <Eyebrow className="hidden sm:block text-prism-blue-deep">Week Planner</Eyebrow>
          <div className="text-lg sm:text-2xl font-display font-semibold text-prism-ink truncate">{DAY_NAMES[now.getDay()]}, {now.toLocaleDateString('en-AU',{day:'numeric',month:'long'})}</div>
        </div>
        <div className="flex items-center gap-2 sm:gap-4 shrink-0">
          {/* Sync state is reassurance, not a control — the workload light is
              the signal worth the width on a phone. */}
          <div className="hidden sm:block"><SyncBadge status={syncStatus}/></div>
          <WorkloadIndicator workload={workload}/>
          {/* The phone's own status bar already shows the time. */}
          <div className="hidden sm:block font-mono text-3xl text-prism-muted/70 tabular-nums">{minToLabel(nowMin)}</div>
          <button onClick={signOut} className="text-xs text-prism-muted hover:text-prism-ink rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep shrink-0">Sign out</button>
        </div>
      </header>
      <div className="relative z-10 grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-5 flex-1 p-4 sm:p-5 overflow-y-auto lg:overflow-hidden min-h-0">
        <div className="flex flex-col gap-4 overflow-y-auto min-h-0 pr-1">
          <HeroCard currentInst={currentInst} nextInst={nextInst} onToggleDone={toggleDone} slotsUnlocked={slotsUnlocked} atRiskIds={dueDateRisk.atRiskIds}/>
          <div>
            {editingTask ? (
              <TaskForm
                key={editingTask.id}
                existingTask={editingTask}
                onSubmit={saveTaskEdit}
                onClose={()=>setEditingTaskId(null)}
                largestSlotMinutes={largestSlotMinutes}
                totalWeeklyMinutes={totalWeeklyMinutes}
                accuracy={accuracy}
              />
            ) : !showAdd ? (
              <button onClick={()=>setShowAdd(true)} className="w-full min-h-[44px] flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-prism-cta text-white font-semibold text-sm shadow-prism-cta transition-transform hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep focus-visible:ring-offset-2">
                <Plus className="w-5 h-5"/> New task
                <kbd className="ml-1 text-xs font-mono bg-white/15 rounded px-1.5 py-0.5 font-normal">n</kbd>
              </button>
            ) : (
              <TaskForm
                onSubmit={addTask}
                onClose={()=>setShowAdd(false)}
                largestSlotMinutes={largestSlotMinutes}
                totalWeeklyMinutes={totalWeeklyMinutes}
                accuracy={accuracy}
              />
            )}
          </div>
          <div>
            {editingMeeting ? (
              <MeetingForm
                key={editingMeeting.id}
                existingMeeting={editingMeeting}
                onSubmit={saveMeetingEdit}
                onClose={()=>setEditingMeetingId(null)}
                todayStr={todayStr}
              />
            ) : !showAddMeeting ? (
              <button onClick={()=>{ setShowAddMeeting(true); setEditingMeetingId(null); }} className="w-full min-h-[44px] flex items-center justify-center gap-2 py-3 rounded-2xl border border-prism-violet/30 bg-white/60 backdrop-blur-md text-violet-700 font-semibold text-sm hover:bg-prism-violet/10 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep">
                <CalendarPlus className="w-4 h-4"/> New meeting
              </button>
            ) : (
              <MeetingForm
                onSubmit={addMeeting}
                onClose={()=>setShowAddMeeting(false)}
                todayStr={todayStr}
              />
            )}
          </div>
        </div>
        <div className="flex flex-col overflow-hidden min-h-0">
          <div className="flex items-center justify-between mb-3 shrink-0">
            <h2 className="text-sm font-semibold text-prism-ink uppercase tracking-widest">Upcoming</h2>
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-xs text-prism-muted">
                <span className="w-2.5 h-2.5 rounded bg-emerald-100 border border-emerald-300 shrink-0"></span>
                recurring
              </span>
              {laterCount>0 && <span className="text-xs text-prism-muted">+{laterCount} scheduled beyond next week</span>}
            </div>
          </div>
          {overflowByTask.length>0 && (
            <div className="mb-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 shrink-0">
              <div className="font-semibold mb-1">
                {overflowByTask.length} task{overflowByTask.length>1?'s don\u2019t':' doesn\u2019t'} fully fit in the next 3 weeks, even after splitting:
              </div>
              <ul className="space-y-0.5">
                {overflowByTask.map(o=>(
                  <li key={o.id} className="flex items-baseline gap-1.5">
                    <span className="truncate">{o.title}</span>
                    <span className="font-mono text-amber-700 shrink-0">
                      {formatDurationHM(o.unplacedMinutes)} unplaced{o.unplacedMinutes<o.duration ? ` of ${formatDurationHM(o.duration)}` : ''}
                    </span>
                    {o.dueDate && <span className="text-amber-600 shrink-0">· due {formatShortDate(o.dueDate)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {dueDateRisk.count>0 && (
            <div className="mb-3 text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2 shrink-0">
              {dueDateRisk.count} task{dueDateRisk.count>1?'s are':' is'} projected to miss {dueDateRisk.count>1?'their':'its'} due date at the current pace — catch-up sessions are open to try to get {dueDateRisk.count>1?'them':'it'} there in time.
            </div>
          )}
          {pinnedCount>0 && (
            <div className="mb-3 text-xs text-prism-violet-deep bg-prism-violet/10 border border-prism-violet/25 rounded-xl px-3 py-2 shrink-0 flex items-center gap-2">
              <Pin className="w-3.5 h-3.5 shrink-0" fill="currentColor"/>
              <span className="flex-1">{pinnedCount} task{pinnedCount>1?'s are':' is'} manually pinned and won't be moved by the scheduler.</span>
              <button onClick={clearAllPins} className="shrink-0 underline font-medium rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep">Clear all pins</button>
            </div>
          )}
          {backlogCount>0 && (
            <div className="mb-3 text-xs text-orange-900 bg-orange-50 border border-orange-200 rounded-xl px-3 py-2 shrink-0 flex items-center gap-2">
              <span className="flex-1">
                {backlogCount} repeating task{backlogCount>1?'s have':' has'} rolled over unfinished and {backlogCount>1?'are':'is'} still competing for your slots.
                {' '}Old housekeeping work rarely needs doing — clear it, or set those tasks to auto-expire in settings.
              </span>
              <button onClick={clearBacklog} className="shrink-0 underline font-medium rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep">Clear {backlogCount}</button>
            </div>
          )}
          {allPlaced && (
            <div className="mb-3 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2 shrink-0 flex items-center gap-2">
              <Check className="w-3.5 h-3.5 shrink-0"/>
              <span>
                All {pendingCount} outstanding task{pendingCount===1?' has':'s have'} a slot — nothing is unplaced, and nothing is projected to miss its due date.
              </span>
            </div>
          )}
          {/* Phone: one full-width day per row, today first, the page scrolling
              down through the horizon. Tablet and up: the original horizontal
              board. The column count has to travel as a CSS variable because an
              inline style cannot be scoped to a breakpoint, and applying it
              unconditionally is exactly what forced a 14-column, 3,600px-wide
              grid onto a 390px screen. */}
          {/* No overflow of its own below `sm`: the content area above is
              already the page scroller there, and a second scroller inside it
              would swallow the drag. */}
          <div className="flex-1 min-h-0 sm:overflow-x-auto sm:overflow-y-hidden">
            <div
              className="grid gap-3 grid-cols-1 sm:h-full sm:grid-cols-[repeat(var(--day-count),minmax(260px,1fr))]"
              style={{ '--day-count': Math.max(groupedDays.length,1) }}
            >
              {groupedDays.map(day=>(
                <DayColumn key={day.date} day={day} isToday={day.date===todayStr} weekLabel={day.date===nextWeekStart ? 'Next week' : day.date===weekThreeStart ? 'Week after' : null} onToggleDone={toggleDone} onDelete={deleteTask} onEdit={startEditing} onTogglePressing={togglePressing} onUnpin={unpinTask} slotsUnlocked={slotsUnlocked} atRiskIds={dueDateRisk.atRiskIds} draggingTaskId={draggingTaskId} onDragStartTask={handleDragStartTask} onDragEndTask={handleDragEndTask} dragOverKey={dragOverKey} onDragOverSlot={setDragOverKey} onDropOnSlot={handleDropOnSlot} explainingKey={explainingKey} onToggleExplain={toggleExplain} onEditMeeting={startEditingMeeting} onDeleteMeeting={deleteMeeting} onAddActionPoint={addActionPoint} actionPointsByMeeting={actionPointsByMeeting} placementByTaskId={placementByTaskId} onStartTimer={startTimer} onReschedule={rescheduleTask} timingKey={activeTimer ? activeTimer.taskId+"|"+activeTimer.sessionId : null}/>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div ref={footerRef} className="relative z-10 shrink-0 border-t border-white/60 bg-white/70 backdrop-blur-xl backdrop-saturate-150">
        {/* Inside the measured footer, so the Capture button clears the timer
            too when one is running. */}
        {activeTimer && (
          <TimerBar
            timer={activeTimer}
            task={timedTask}
            onDone={completeFromTimer}
            onNotComplete={notCompleteFromTimer}
            onCancel={cancelTimer}
          />
        )}
        <div className="flex items-center gap-4 sm:gap-6 px-4 sm:px-6 py-3 sm:pb-[max(0.75rem,env(safe-area-inset-bottom))] flex-wrap">
          <StatsBar stats={stats}/>
          <div className="flex-1"></div>
          {/* Below sm these three live in the bottom bar instead — as text
              links they wrapped onto their own row and the Capture button
              landed on top of them. */}
          <button onClick={()=>setOpenDrawer(d=>d==='completed'?null:'completed')} className="hidden sm:flex items-center gap-2 text-sm font-medium text-prism-muted hover:text-prism-ink rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep shrink-0">
            Completed
            {openDrawer==='completed' ? <ChevronUp className="w-4 h-4"/> : <ChevronDown className="w-4 h-4"/>}
          </button>
          <button onClick={()=>setOpenDrawer(d=>d==='trends'?null:'trends')} className="hidden sm:flex items-center gap-2 text-sm font-medium text-prism-muted hover:text-prism-ink rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep shrink-0">
            Term trends
            {openDrawer==='trends' ? <ChevronUp className="w-4 h-4"/> : <ChevronDown className="w-4 h-4"/>}
          </button>
          <button onClick={()=>setOpenDrawer(d=>d==='settings'?null:'settings')} className="hidden sm:flex items-center gap-2 text-sm font-medium text-prism-muted hover:text-prism-ink rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep shrink-0">
            <Settings2 className="w-4 h-4"/> Time slots & recurring tasks
            {openDrawer==='settings' ? <ChevronUp className="w-4 h-4"/> : <ChevronDown className="w-4 h-4"/>}
          </button>
        </div>
        {openDrawer==='completed' && (
          <div className="max-h-80 overflow-y-auto border-t border-white/50 px-6 py-4">
            <CompletedPanel records={records}/>
          </div>
        )}
        {openDrawer==='trends' && (
          <div className="max-h-80 overflow-y-auto border-t border-white/50 px-6 py-4">
            <TrendsPanel weeklySnapshots={weeklySnapshots} weeklyVolume={weeklyVolume} accuracy={accuracy}/>
          </div>
        )}
        {openDrawer==='settings' && (
          <div className="max-h-80 overflow-y-auto border-t border-white/50 px-6 py-4">
            <SettingsPanel
              slots={slots} setSlots={setSlots}
              recDaily={recDaily} setRecDaily={setRecDaily}
              recWeekly={recWeekly} setRecWeekly={setRecWeekly}
              onClearBacklog={clearBacklog}
              backlogCount={backlogCount}
              slotsUnlocked={slotsUnlocked}
            />
            <button
              onClick={handleManualImport}
              className="w-full mt-4 text-xs text-prism-muted/70 border border-dashed border-white/60 rounded-xl py-2 hover:text-prism-ink hover:border-prism-blue/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep"
              title="Only needed if this browser has tasks that never made it to the cloud — safe to press any time, it never duplicates"
            >
              Import any tasks saved in this browser
            </button>
            {/*
              Which build am I actually looking at? On a PWA the honest answer
              is often "not the one you just deployed" — the service worker can
              serve a cached shell for days. Stamped at build time from the
              commit ref so this can be read straight off the phone instead of
              inferred from whether a fix appears to have worked.
            */}
            <p className="mt-4 text-center font-mono text-[10px] text-prism-muted/60 select-all">
              build {__BUILD_STAMP__}
            </p>
          </div>
        )}
        {/* Phone-only bottom bar. It lives INSIDE the element the footer's
            ResizeObserver watches, so footerHeight already accounts for it and
            the Capture button clears the whole footer without measuring
            anything new. */}
        <nav aria-label="Panels" className="sm:hidden flex items-stretch border-t border-white/50 pb-[env(safe-area-inset-bottom)]">
          <TabBarButton icon={Check} label="Completed" active={openDrawer==='completed'} onClick={()=>setOpenDrawer(d=>d==='completed'?null:'completed')}/>
          <TabBarButton icon={TrendingUp} label="Trends" active={openDrawer==='trends'} onClick={()=>setOpenDrawer(d=>d==='trends'?null:'trends')}/>
          {/* Slot for CaptureThought's docked trigger. It is a callback ref
              into state rather than a useRef so the portal renders as soon as
              this node exists; a plain ref would not re-render CaptureThought
              on mount and the slot would stay empty until something else did. */}
          <div ref={setCaptureDockEl} className="flex-1 flex items-stretch"/>
          <TabBarButton icon={Settings2} label="Slots" active={openDrawer==='settings'} onClick={()=>setOpenDrawer(d=>d==='settings'?null:'settings')}/>
        </nav>
      </div>
      {toast && (
        <div key={toast.id} className="animate-prism-toast motion-reduce:animate-none fixed bottom-6 right-6 z-50 bg-prism-navy text-white rounded-2xl shadow-prism-card px-5 py-4 max-w-xs">
          <div className="flex items-center gap-3">
            <PartyPopper className="w-5 h-5 text-amber-400 shrink-0"/>
            <span className="text-sm font-medium">{toast.message}</span>
          </div>
          {toast.askTime && (
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-white/15">
              <label htmlFor="toast-actual-minutes" className="text-xs text-white/60 shrink-0">Actual time?</label>
              <input id="toast-actual-minutes" type="number" min="1" placeholder="min" value={timeInput} onChange={e=>setTimeInput(e.target.value)} className="w-16 text-xs rounded-lg bg-white/10 border border-white/20 px-2 py-1 text-white focus:outline-none focus:ring-2 focus:ring-prism-blue"/>
              <button onClick={saveActualTime} className="text-xs bg-prism-blue text-prism-ink rounded-lg px-2.5 py-1.5 font-semibold shrink-0 min-h-[32px]">Save</button>
              <button onClick={dismissTimePrompt} className="text-xs text-white/60 hover:text-white shrink-0">Skip</button>
            </div>
          )}
        </div>
      )}
      {pendingUndo && (
        <div className="animate-prism-toast motion-reduce:animate-none fixed bottom-6 left-6 z-50 bg-prism-navy text-white rounded-2xl shadow-prism-card px-5 py-3 flex items-center gap-3">
          <Trash2 className="w-4 h-4 text-white/50 shrink-0"/>
          <span className="text-sm">
            Deleted <span className="font-medium">{pendingUndo.task.title}</span>
          </span>
          <button onClick={undoDelete} className="flex items-center gap-1 text-xs bg-prism-blue text-prism-ink rounded-lg px-2.5 py-1.5 font-semibold shrink-0">
            <Undo2 className="w-3 h-3"/> Undo
          </button>
        </div>
      )}
      <CaptureThought uid={user.uid} onAddTodo={addTask} footerHeight={footerHeight} dockEl={captureDockEl}/>
    </div>
  );
}
