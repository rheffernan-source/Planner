import React, { useState, useEffect, useMemo } from 'react';
import { Check, Plus, X, Trash2, ChevronDown, ChevronUp, Settings2, Loader2, Star, PartyPopper, Pin, Pencil, Undo2 } from 'lucide-react';
import { useAuth, useCloudTasks, useCloudDoc, importFromThisBrowser } from './cloudSync';
import { SyncBadge } from './AuthGate';
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
const DURATION_PRESETS = [
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
function formatShortDate(dateStr){ const d = parseDateStr(dateStr); return `${DAY_SHORT[d.getDay()]} ${d.getDate()}`; }
function formatDurationHM(mins){ if (mins<=0) return '0m'; const h=Math.floor(mins/60), m=mins%60; if (h===0) return `${m}m`; if (m===0) return `${h}h`; return `${h}h ${m}m`; }
let idSeq = 0;
function genId(){ idSeq += 1; return 'id-'+Date.now().toString(36)+'-'+idSeq; }
/* ============================================================
   Scheduling engine (verified separately with node before wiring into the UI)
   ============================================================ */
function makeTask({ title, duration, dueDate, recurringId=null, recurringDate=null, source='adhoc', pressing=false, order, preference=null }){
  // recurringDate: the date this instance was GENERATED for. Kept separate from dueDate
  // because dueDate is user-editable (see instance editing) and the generator's
  // duplicate check keys on this — if it keyed on dueDate, moving an instance's date
  // would make the generator think that week's instance was missing and create another.
  return { id: genId(), title, duration: Number(duration), dueDate, pressing, done:false, doneAt:null, createdAt: order, source, recurringId, recurringDate, preference, actualMinutes:null, pinnedTo: null };
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
const MIN_TASK_MINUTES = 15;
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
function buildScheduleOnce(tasks, slots, now, weeksAhead=SCHEDULE_WEEKS, unlockRestricted=false, demotedTaskIds=null){
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStr = toDateStr(today);
  const nowMin = now.getHours()*60+now.getMinutes();

  const instances = [];
  for (let i=0;i<weeksAhead*7;i++){
    const d = addDays(today,i);
    const dow = d.getDay();
    const dateStr = toDateStr(d);
    slots.forEach(slot=>{
      if (slot.day===dow){
        const startMin=timeToMin(slot.start), endMin=timeToMin(slot.end);
        if (dateStr===todayStr && endMin<=nowMin) return;
        instances.push({ key: slot.id+'|'+dateStr, slotId:slot.id, date:dateStr, dayOfWeek:dow, start:slot.start, end:slot.end, startMin, endMin, restricted:slot.restricted, remaining:endMin-startMin, assigned:[] });
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
function computeEligibleMinutesBeforeStandalone(task, dueDateStr, slots, now, weeksAhead, isUrgentFn){
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStr = toDateStr(today);
  const nowMin = now.getHours()*60+now.getMinutes();
  let total = 0;
  for (let i=0;i<weeksAhead*7;i++){
    const d = addDays(today,i);
    const dateStr = toDateStr(d);
    if (dateStr > dueDateStr) continue;
    const dow = d.getDay();
    for (const slot of slots){
      if (slot.day!==dow) continue;
      const startMin=timeToMin(slot.start), endMin=timeToMin(slot.end);
      if (dateStr===todayStr && endMin<=nowMin) continue;
      const canUseRestricted = slot.restricted ? isUrgentFn(task) : true;
      if (!canUseRestricted) continue;
      total += endMin - startMin;
    }
  }
  return total;
}

function buildSchedule(tasks, slots, now, weeksAhead=SCHEDULE_WEEKS, unlockRestricted=false){
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStr = toDateStr(today);
  const isUrgentFn = t => t.pressing || (t.dueDate && t.dueDate<todayStr);

  const passA = buildScheduleOnce(tasks, slots, now, weeksAhead, unlockRestricted, null);

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
    const eligible = computeEligibleMinutesBeforeStandalone(task, task.dueDate, slots, now, weeksAhead, isUrgentFn);
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

  const passB = buildScheduleOnce(tasks, slots, now, weeksAhead, unlockRestricted, demotedTaskIds);
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
    <div className="flex items-center gap-2.5 px-3 py-2 rounded-2xl border border-slate-200 bg-white" title={description}>
      <div className="flex flex-col gap-1 bg-slate-800 rounded-md px-1.5 py-1.5">
        {dotConfig.map(d=>(
          <span key={d.key} className={`w-2.5 h-2.5 rounded-full ${workload.level===d.key?d.activeClass:d.dimClass}`}></span>
        ))}
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-xs font-semibold text-slate-700">{label}</span>
        <span className="text-xs text-slate-400">
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
      <div className="rounded-3xl px-6 py-12 text-center bg-slate-900 shadow-lg shadow-slate-900/10">
        <div className="text-slate-400 text-sm">Nothing scheduled — add a task below</div>
      </div>
    );
  }
  const label = currentInst ? 'RIGHT NOW' : 'NEXT UP';
  const timeLabel = currentInst ? `until ${minToLabel(inst.endMin)}` : `${DAY_SHORT[inst.dayOfWeek]} ${minToLabel(inst.startMin)}`;
  const isUnlockedRestricted = inst.restricted && slotsUnlocked;
  const emptyColor = isUnlockedRestricted ? 'text-slate-400' : inst.restricted ? 'text-rose-300' : 'text-slate-400';
  return (
    <div key={inst.key} className="flap rounded-3xl px-6 py-7 bg-slate-900 shadow-lg shadow-slate-900/10">
      <div className="flex items-center justify-between mb-4">
        <Eyebrow className="text-amber-400">{label}</Eyebrow>
        <div className="flex items-center gap-2">
          <span className="font-mono-plex text-xs text-slate-400">{timeLabel}</span>
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
                <button onClick={()=>onToggleDone(t.id, t.sessionId)} className={`w-7 h-7 mt-0.5 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors ${t.done?'bg-amber-400 border-amber-400':'border-slate-500 hover:border-amber-400'}`}>
                  {t.done && <Check className="w-4 h-4 text-slate-900"/>}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-lg font-medium ${t.done?'line-through text-slate-500':'text-white'}`}>{t.title}</span>
                    {t.isPartial && <span className="font-mono-plex text-xs text-slate-400 shrink-0">part {t.chunkIndex} · {t.duration}min</span>}
                    {t.dueDate && t.dueDate<inst.date && <span className="text-amber-400 text-xs shrink-0">from {formatShortDate(t.dueDate)}</span>}
                    {t.pinnedTo && t.pinnedTo.slotId===inst.slotId && t.pinnedTo.date===inst.date && <Pin className="w-3.5 h-3.5 text-indigo-400 shrink-0" fill="currentColor"/>}
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
function DayColumn({ day, isToday, weekLabel, onToggleDone, onDelete, onEdit, onTogglePressing, onUnpin, slotsUnlocked, atRiskIds, draggingTaskId, onDragStartTask, onDragEndTask, dragOverKey, onDragOverSlot, onDropOnSlot, explainingKey, onToggleExplain }){
  const d = parseDateStr(day.date);
  return (
    <div className={`flex flex-col h-full rounded-2xl border overflow-hidden ${isToday?'border-amber-300 bg-amber-50/50':'border-slate-200 bg-white'}`}>
      <div className={`px-3 py-2.5 shrink-0 border-b ${isToday?'border-amber-200':'border-slate-100'}`}>
        {weekLabel && <div className="text-xs font-semibold text-indigo-400 uppercase tracking-widest mb-1">{weekLabel}</div>}
        <div className={`text-xs font-semibold ${isToday?'text-amber-700':'text-slate-500'}`}>{DAY_NAMES[day.dayOfWeek]}{isToday?' · Today':''}</div>
        <div className="text-xs text-slate-400">{d.toLocaleDateString('en-AU',{day:'numeric',month:'short'})}</div>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {day.slots.length===0 ? (
          <div className="text-xs text-slate-300 italic py-1 px-1">No flex blocks</div>
        ) : day.slots.map(inst=>{
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
              className={`rounded-lg px-2 py-1.5 border transition-colors ${
                isDropTarget ? 'bg-amber-50 border-amber-400 border-2' :
                isUnlockedRestricted ? 'bg-rose-50/30 border-rose-200' :
                inst.restricted ? 'bg-rose-50/70 border-rose-200 border-dashed' :
                'bg-slate-50 border-slate-100'
              }`}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1">
                  <span className="font-mono-plex text-xs text-slate-500">{minToLabel(inst.startMin)}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {isUnlockedRestricted && <span className="text-xs text-rose-500 font-medium">unlocked</span>}
                  {/* Capacity: makes wasted fragments visible — a block showing 5 of 25
                      used is obviously leaking time in a way a bare task list isn't. */}
                  <span
                    className={`font-mono-plex text-xs ${usedMinutes===0 ? 'text-slate-300' : freeMinutes===0 ? 'text-emerald-600' : 'text-slate-400'}`}
                    title={`${usedMinutes} of ${capacityMinutes} minutes used${freeMinutes>0?` — ${freeMinutes}min still free`:' — full'}`}>
                    {usedMinutes}/{capacityMinutes}m
                  </span>
                </div>
              </div>
              <div className="space-y-2">
                {inst.assigned.length===0 ? (
                  <span className={`text-xs ${isDropTarget?'text-amber-600 font-medium':isUnlockedRestricted?'text-slate-300':inst.restricted?'text-rose-400':'text-slate-300'}`}>
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
                        <button onClick={()=>onToggleDone(t.id, t.sessionId)} className={`w-3.5 h-3.5 mt-0.5 rounded-full border shrink-0 flex items-center justify-center ${t.done?'bg-emerald-500 border-emerald-500':'border-slate-300'}`}>
                          {t.done && <Check className="w-2.5 h-2.5 text-white"/>}
                        </button>
                        <span className={`flex-1 min-w-0 break-words text-xs ${t.done?'line-through text-slate-400':'text-slate-700'}`}>{t.title}</span>
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
                          <div className="text-xs text-slate-600 bg-white border border-slate-200 rounded-lg px-2 py-1.5 leading-relaxed">
                            {t.placementReason}
                          </div>
                        </div>
                      )}
                      <div className="flex items-center gap-1.5 mt-1 pl-5">
                        {t.isPartial && (
                          <span className="font-mono-plex text-xs text-slate-400 shrink-0">{t.chunkIndex}·{t.duration}m</span>
                        )}
                        {t.dueDate && t.dueDate<day.date && <span className="text-xs text-amber-600 shrink-0">from {formatShortDate(t.dueDate)}</span>}
                        <span className="flex-1"></span>
                        <button
                          onClick={()=>onToggleExplain(explainKey)}
                          aria-label={`Why is ${t.title} scheduled here?`}
                          className={`shrink-0 w-3 h-3 rounded-full border text-[8px] leading-none font-bold flex items-center justify-center ${isExplaining?'bg-slate-700 border-slate-700 text-white':'border-slate-300 text-slate-400'}`}
                          title="Why is this here?">?</button>
                        {isPinnedHere && (
                          <button onClick={()=>onUnpin(t.id)} aria-label={`Unpin ${t.title}`} className="shrink-0" title="Pinned here manually — click to unpin and let it reschedule automatically">
                            <Pin className="w-3 h-3 text-indigo-500" fill="currentColor"/>
                          </button>
                        )}
                        <button onClick={()=>onEdit(t.id)} aria-label={`Edit ${t.title}`} className="text-slate-300 shrink-0 hover:text-slate-500" title={t.recurringId ? 'Edit just this occurrence' : 'Edit this task'}>
                          <Pencil className="w-3 h-3"/>
                        </button>
                        <button onClick={()=>onTogglePressing(t.id)} aria-label={t.pressing?`Unmark ${t.title} as pressing`:`Mark ${t.title} as pressing`} className="shrink-0" title="Pressing — can use catch-up blocks">
                          <Star className={`w-3 h-3 ${t.pressing?'text-amber-500':'text-slate-300'}`} fill={t.pressing?'currentColor':'none'}/>
                        </button>
                        <button onClick={()=>onDelete(t.id)} aria-label={`Delete ${t.title}`} className="text-slate-300 shrink-0 hover:text-rose-500" title="Delete this task"><Trash2 className="w-3 h-3"/></button>
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
    { label:'Today', value: stats.day, color:'text-amber-700' },
    { label:'This week', value: stats.week, color:'text-indigo-700' },
    { label:'This month', value: stats.month, color:'text-violet-700' },
    { label:'This year', value: stats.year, color:'text-emerald-700' },
  ];
  return (
    <div className="flex items-center gap-5">
      <span className="text-xs font-semibold text-slate-400 uppercase tracking-widest shrink-0">Completed</span>
      {rows.map(r=>(
        <div key={r.label} className="flex items-baseline gap-1.5 shrink-0">
          <span className={`font-mono-plex text-lg font-semibold ${r.color}`}>{r.value}</span>
          <span className="text-xs text-slate-400">{r.label}</span>
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
    <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-900">{isEditing ? (isRecurringInstance ? 'Edit this occurrence' : 'Edit task') : 'Add a task'}</span>
        <button type="button" onClick={onClose} aria-label="Close form" className="text-slate-400"><X className="w-4 h-4"/></button>
      </div>
      {isRecurringInstance && (
        <div className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-2 py-1.5">
          This changes only this one occurrence. The repeating task itself stays as it is — edit that under Time slots &amp; recurring tasks.
        </div>
      )}
      <input autoFocus value={title} onChange={e=>setTitle(e.target.value)} onKeyDown={handleTitleKeyDown} placeholder="What needs doing?" aria-label="Task title" className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"/>
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
        {showAdjustment && (
          <div className="mt-1.5 text-xs text-indigo-800 bg-indigo-50 border border-indigo-200 rounded-lg px-2 py-1.5">
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
              className="mt-1.5 text-xs bg-indigo-600 text-white rounded-lg px-2 py-1 font-medium">
              Use {formatDurationHM(adjustedMins)} instead
            </button>
          </div>
        )}
        {exceedsWeek ? (
          <div className="mt-1.5 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2 py-1.5">
            {formatDurationHM(mins)} is more than your entire week of flex time ({formatDurationHM(totalWeeklyMinutes)}). This will spill across several weeks — consider breaking it into smaller tasks.
          </div>
        ) : willSplit ? (
          <div className="mt-1.5 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
            Your largest block is {formatDurationHM(largestSlotMinutes)}, so this will be split across several sittings.
          </div>
        ) : null}
      </div>
      <div>
        <label className="text-xs text-slate-400 block mb-1">Due by (optional)</label>
        <input type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)} aria-label="Due date" className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"/>
      </div>
      <label className="flex items-start gap-2 text-xs text-slate-600">
        <input type="checkbox" checked={pressing} onChange={e=>setPressing(e.target.checked)} className="mt-0.5"/>
        <span>Pressing / specially requested — eligible for catch-up-only blocks (Tue eve, Sat morning)</span>
      </label>
      <button type="button" onClick={submit} className="w-full py-2.5 rounded-xl bg-slate-900 text-white text-sm font-medium">{isEditing ? 'Save changes' : 'Add task'}</button>
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
        <h3 className="text-xs font-semibold text-slate-900 mb-2 uppercase tracking-widest">Flex blocks</h3>
        <div className="space-y-1.5">
          {sortedSlots.map(s=>(
            <div key={s.id} className="flex items-center justify-between text-sm bg-white border border-slate-200 rounded-xl px-3 py-2">
              <span className="text-slate-700">{DAY_SHORT[s.day]} {minToLabel(timeToMin(s.start))}–{minToLabel(timeToMin(s.end))}{s.restricted && <span className="text-rose-500"> · catch-up only{slotsUnlocked && ' (unlocked)'}</span>}</span>
              <button onClick={()=>setSlots(prev=>prev.filter(x=>x.id!==s.id))} aria-label="Delete this flex block" className="text-slate-300"><Trash2 className="w-3.5 h-3.5"/></button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2 items-center bg-white border border-slate-200 rounded-xl p-2.5">
          <select value={newSlot.day} onChange={e=>setNewSlot(s=>({...s,day:e.target.value}))} className="text-xs border border-slate-200 rounded-lg px-2 py-1.5">
            {DAY_NAMES.map((n,i)=><option key={i} value={i}>{n}</option>)}
          </select>
          <input type="time" value={newSlot.start} onChange={e=>setNewSlot(s=>({...s,start:e.target.value}))} className="text-xs border border-slate-200 rounded-lg px-2 py-1.5"/>
          <input type="time" value={newSlot.end} onChange={e=>setNewSlot(s=>({...s,end:e.target.value}))} className="text-xs border border-slate-200 rounded-lg px-2 py-1.5"/>
          <label className="flex items-center gap-1 text-xs text-slate-500">
            <input type="checkbox" checked={newSlot.restricted} onChange={e=>setNewSlot(s=>({...s,restricted:e.target.checked}))}/> catch-up only
          </label>
          <button onClick={addSlot} className="text-xs bg-slate-900 text-white rounded-lg px-2.5 py-1.5 ml-auto">Add</button>
        </div>
      </div>
      <div>
        <h3 className="text-xs font-semibold text-slate-900 mb-2 uppercase tracking-widest">Daily recurring</h3>
        <div className="space-y-1.5">
          {recDaily.map(r=>(
            <div key={r.id} className="flex items-center justify-between text-sm bg-white border border-slate-200 rounded-xl px-3 py-2 gap-2">
              <span className="text-slate-700 flex-1 min-w-0">{r.title} · {r.duration}min</span>
              <select value={r.preference||''} onChange={e=>setRecDaily(prev=>prev.map(x=>x.id===r.id?{...x,preference:e.target.value||null}:x))} className="text-xs border border-slate-200 rounded-lg px-1.5 py-1 shrink-0">
                <option value="">No pref</option>
                <option value="earliest">Earliest</option>
                <option value="latest">Latest</option>
              </select>
              <button onClick={()=>setRecDaily(prev=>prev.map(x=>x.id===r.id?{...x,autoExpire:!x.autoExpire}:x))} className={`text-[10px] px-1.5 py-1 rounded-lg border shrink-0 ${r.autoExpire?'border-amber-300 text-amber-700 bg-amber-50':'border-slate-200 text-slate-400'}`}>
                {r.autoExpire ? 'Auto-expires' : 'Carries over'}
              </button>
              <button onClick={()=>setRecDaily(prev=>prev.filter(x=>x.id!==r.id))} aria-label={`Delete recurring task ${r.title}`} className="text-slate-300 shrink-0"><Trash2 className="w-3.5 h-3.5"/></button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2 items-center bg-white border border-slate-200 rounded-xl p-2.5">
          <input value={newDaily.title} onChange={e=>setNewDaily(s=>({...s,title:e.target.value}))} placeholder="Title" className="flex-1 text-xs border border-slate-200 rounded-lg px-2 py-1.5 min-w-0"/>
          <input type="number" value={newDaily.duration} onChange={e=>setNewDaily(s=>({...s,duration:e.target.value}))} className="w-16 text-xs border border-slate-200 rounded-lg px-2 py-1.5"/>
          <select value={newDaily.preference} onChange={e=>setNewDaily(s=>({...s,preference:e.target.value}))} className="text-xs border border-slate-200 rounded-lg px-1.5 py-1.5">
            <option value="">No pref</option>
            <option value="earliest">Earliest</option>
            <option value="latest">Latest</option>
          </select>
          <button type="button" onClick={()=>setNewDaily(s=>({...s,autoExpire:!s.autoExpire}))} className={`text-[10px] px-1.5 py-1.5 rounded-lg border shrink-0 ${newDaily.autoExpire?'border-amber-300 text-amber-700 bg-amber-50':'border-slate-200 text-slate-500'}`}>
            {newDaily.autoExpire ? 'Auto-expires' : 'Carries over'}
          </button>
          <button onClick={addDaily} className="text-xs bg-slate-900 text-white rounded-lg px-2.5 py-1.5 shrink-0">Add</button>
        </div>
      </div>
      <div>
        <h3 className="text-xs font-semibold text-slate-900 mb-2 uppercase tracking-widest">Weekly recurring</h3>
        <div className="space-y-1.5">
          {recWeekly.map(r=>(
            <div key={r.id} className="flex items-center justify-between text-sm bg-white border border-slate-200 rounded-xl px-3 py-2 gap-2">
              <span className="text-slate-700 flex-1 min-w-0">{r.title} · {r.duration}min{r.day!=null && ` · ${DAY_SHORT[r.day]}`}</span>
              <button onClick={()=>setRecWeekly(prev=>prev.map(x=>x.id===r.id?{...x,autoExpire:!x.autoExpire}:x))}
                className={`text-[10px] px-1.5 py-1 rounded-lg border shrink-0 ${r.autoExpire?'border-amber-300 text-amber-700 bg-amber-50':'border-slate-200 text-slate-400'}`}
                title={r.autoExpire ? 'A missed week is dropped rather than carried forward' : 'A missed week keeps carrying over as overdue'}>
                {r.autoExpire ? 'Auto-expires' : 'Carries over'}
              </button>
              <button onClick={()=>setRecWeekly(prev=>prev.filter(x=>x.id!==r.id))} aria-label={`Delete recurring task ${r.title}`} className="text-slate-300 shrink-0"><Trash2 className="w-3.5 h-3.5"/></button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2 items-center bg-white border border-slate-200 rounded-xl p-2.5">
          <input value={newWeekly.title} onChange={e=>setNewWeekly(s=>({...s,title:e.target.value}))} placeholder="Title" className="flex-1 text-xs border border-slate-200 rounded-lg px-2 py-1.5 min-w-0"/>
          <input type="number" value={newWeekly.duration} onChange={e=>setNewWeekly(s=>({...s,duration:e.target.value}))} className="w-16 text-xs border border-slate-200 rounded-lg px-2 py-1.5"/>
          <select value={newWeekly.day} onChange={e=>setNewWeekly(s=>({...s,day:e.target.value}))} className="text-xs border border-slate-200 rounded-lg px-2 py-1.5">
            <option value="">Any day</option>
            {DAY_NAMES.map((n,i)=><option key={i} value={i}>{n}</option>)}
          </select>
          <button onClick={addWeekly} className="text-xs bg-slate-900 text-white rounded-lg px-2.5 py-1.5">Add</button>
        </div>
      </div>
      </div>
      {backlogCount>0 && (
        <button onClick={onClearBacklog} className="w-full mt-4 text-xs text-slate-500 border border-slate-200 rounded-xl py-2.5">
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
      <div className="flex items-center gap-3 mb-3">
        <h3 className="text-xs font-semibold text-slate-900 uppercase tracking-widest">Completed work</h3>
        <div className="flex gap-1">
          {['week','month','all'].map(r=>(
            <button key={r} onClick={()=>setRange(r)}
              className={`text-xs px-2 py-1 rounded-lg border transition-colors ${range===r?'bg-slate-900 text-white border-slate-900':'border-slate-200 text-slate-500 hover:border-slate-400'}`}>
              {labels[r]}
            </button>
          ))}
        </div>
        <span className="text-xs text-slate-400">
          {filtered.length} task{filtered.length===1?'':'s'} · {formatDurationHM(totalEstimated)} estimated
        </span>
      </div>
      {filtered.length===0 ? (
        <div className="text-xs text-slate-400">Nothing completed in this period yet.</div>
      ) : (
        <div className="space-y-1">
          {filtered.map(r=>{
            const est = r.duration;
            const act = r.actualMinutes;
            const over = act!=null && est>0 ? act/est : null;
            return (
              <div key={r.id+'|'+r.doneAt} className="flex items-baseline gap-2 text-xs border-b border-slate-100 pb-1">
                <span className="font-mono-plex text-slate-400 shrink-0 w-14">{formatShortDate(toDateStr(new Date(r.doneAt)))}</span>
                <span className={`flex-1 min-w-0 truncate ${r.recurringId?'text-emerald-700':'text-slate-700'}`}>{r.title}</span>
                <span className="font-mono-plex text-slate-400 shrink-0">{formatDurationHM(est)}</span>
                {act!=null && (
                  <span className={`font-mono-plex shrink-0 ${over>1.15?'text-amber-600':over<0.85?'text-indigo-600':'text-emerald-600'}`}>
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
        <h3 className="text-xs font-semibold text-slate-900 mb-2 uppercase tracking-widest">Weekly busy-ness</h3>
        {weekKeys.length===0 ? (
          <div className="text-xs text-slate-400">Not enough history yet — this fills in week by week as the traffic light runs.</div>
        ) : (
          <div className="flex items-end gap-2 flex-wrap">
            {weekKeys.map(wk=>(
              <div key={wk} className="flex flex-col items-center gap-1" title={`Week of ${formatShortDate(wk)}: ${weeklySnapshots[wk].level}`}>
                <span className={`w-3.5 h-3.5 rounded-full ${dotColor[weeklySnapshots[wk].level]}`}></span>
                <span className="text-xs text-slate-300 font-mono-plex">{formatShortDate(wk)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div>
        <h3 className="text-xs font-semibold text-slate-900 mb-2 uppercase tracking-widest">Estimate vs actual</h3>
        {!accuracy ? (
          <div className="text-xs text-slate-400">Log actual time on a few completed tasks (via the completion prompt) to see this.</div>
        ) : (
          <div className="text-sm text-slate-600">
            Based on <span className="font-mono-plex font-semibold text-slate-900">{accuracy.count}</span> task{accuracy.count>1?'s':''} with logged time, you're averaging{' '}
            <span className={`font-mono-plex font-semibold ${accuracy.ratio>1.15?'text-amber-600':accuracy.ratio<0.85?'text-indigo-600':'text-emerald-600'}`}>
              {accuracy.ratio>=1 ? `${Math.round((accuracy.ratio-1)*100)}% longer` : `${Math.round((1-accuracy.ratio)*100)}% shorter`}
            </span>{' '}than estimated.
          </div>
        )}
      </div>
      <div>
        <h3 className="text-xs font-semibold text-slate-900 mb-2 uppercase tracking-widest">Completed per week</h3>
        {weeklyVolume.length===0 ? (
          <div className="text-xs text-slate-400">No history yet.</div>
        ) : (
          <div className="flex items-end gap-2 h-16">
            {weeklyVolume.map(w=>{
              const heightPct = w.count===0 ? 4 : Math.max(10, Math.round((w.count/maxVolume)*100));
              return (
                <div key={w.weekStart} className="flex flex-col items-center justify-end gap-1 h-full">
                  <span className="text-xs text-slate-400 font-mono-plex">{w.count}</span>
                  <div className="w-4 bg-violet-300 rounded-t" style={{ height: `${heightPct}%` }}></div>
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
  const [pendingUndo,setPendingUndo] = useState(null); // { task, timeoutId } — a just-deleted task that can still be restored
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
  const baselineSchedule = useMemo(()=>buildSchedule(tasks, slots, now), [tasks, slots, now]);
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
    if (slotsUnlocked) return buildSchedule(tasks, slots, now, SCHEDULE_WEEKS, true);
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
  const groupedDays = weekDates.map(dstr=>({
    date: dstr,
    dayOfWeek: parseDateStr(dstr).getDay(),
    slots: schedule.instances.filter(i=>i.date===dstr).sort((a,b)=>a.startMin-b.startMin)
  }));
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
  /*
    "Everything has a home" — unfinished tasks intrude on your attention, but making a
    concrete plan for them discharges most of that intrusion; you don't have to finish
    them, only genuinely schedule them. The scheduler has always been doing exactly
    that work, silently. This states it, so the reassurance actually lands instead of
    only the warnings being visible.
  */
  const pendingCount = tasks.filter(t=>!t.done).length;
  const allPlaced = pendingCount>0 && overflowByTask.length===0 && dueDateRisk.count===0;
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
  function addTask({ title, duration, dueDate, pressing }){
    setTasks(prev=>[...prev, makeTask({ title, duration, dueDate, pressing, source:'adhoc', order: Date.now() })]);
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
      <div className="h-screen w-full flex items-center justify-center bg-gradient-to-br from-slate-50 via-white to-amber-50">
        <Loader2 className="w-6 h-6 text-slate-300 animate-spin"/>
      </div>
    );
  }
  return (
    <div className="week-planner-root h-screen w-full overflow-hidden bg-gradient-to-br from-slate-50 via-white to-amber-50 text-slate-800 flex flex-col">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
        .font-mono-plex { font-family: 'IBM Plex Mono', ui-monospace, monospace; }
        .week-planner-root, .week-planner-root * { font-family: 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif; }
        .week-planner-root .font-mono-plex { font-family: 'IBM Plex Mono', ui-monospace, monospace; }
        @keyframes flapIn { 0% { opacity:0; transform:rotateX(-90deg);} 60% { opacity:1; } 100% { opacity:1; transform:rotateX(0deg);} }
        .flap { animation: flapIn 0.45s ease-out; transform-origin:top center; }
        @keyframes toastIn { 0% { opacity:0; transform:translateY(14px) scale(0.97);} 100% { opacity:1; transform:translateY(0) scale(1);} }
        .toast-pop { animation: toastIn 0.3s cubic-bezier(0.34,1.56,0.64,1); }
        @media (prefers-reduced-motion: reduce){ .flap, .toast-pop { animation:none; } }
        .planner-shell { display:grid; grid-template-columns: 340px 1fr; gap:1.25rem; min-height:0; }
        @media (max-width: 900px){ .planner-shell { grid-template-columns: 1fr; overflow-y:auto; } }
      `}</style>
      <header className="flex items-center justify-between px-6 py-4 border-b border-slate-200/70 bg-white/70 backdrop-blur-sm shrink-0">
        <div>
          <Eyebrow className="text-amber-600">Week Planner</Eyebrow>
          <div className="text-2xl font-semibold text-slate-900">{DAY_NAMES[now.getDay()]}, {now.toLocaleDateString('en-AU',{day:'numeric',month:'long'})}</div>
        </div>
        <div className="flex items-center gap-4">
          <SyncBadge status={syncStatus}/>
          <WorkloadIndicator workload={workload}/>
          <div className="font-mono-plex text-3xl text-slate-300 tabular-nums">{minToLabel(nowMin)}</div>
          <button onClick={signOut} className="text-xs text-slate-400 hover:text-slate-600 shrink-0">Sign out</button>
        </div>
      </header>
      <div className="planner-shell flex-1 p-5 overflow-hidden">
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
              <button onClick={()=>setShowAdd(true)} className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-slate-900 text-white font-semibold text-sm hover:bg-slate-800 transition-colors">
                <Plus className="w-5 h-5"/> New task
                <kbd className="ml-1 text-xs font-mono-plex bg-slate-700 rounded px-1.5 py-0.5 font-normal">n</kbd>
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
        </div>
        <div className="flex flex-col overflow-hidden min-h-0">
          <div className="flex items-center justify-between mb-3 shrink-0">
            <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-widest">Upcoming</h2>
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-xs text-slate-400">
                <span className="w-2.5 h-2.5 rounded bg-emerald-100 border border-emerald-300 shrink-0"></span>
                recurring
              </span>
              {laterCount>0 && <span className="text-xs text-slate-400">+{laterCount} scheduled beyond next week</span>}
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
                    <span className="font-mono-plex text-amber-700 shrink-0">
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
            <div className="mb-3 text-xs text-indigo-800 bg-indigo-50 border border-indigo-200 rounded-xl px-3 py-2 shrink-0 flex items-center gap-2">
              <Pin className="w-3.5 h-3.5 shrink-0" fill="currentColor"/>
              <span className="flex-1">{pinnedCount} task{pinnedCount>1?'s are':' is'} manually pinned and won't be moved by the scheduler.</span>
              <button onClick={clearAllPins} className="shrink-0 underline font-medium">Clear all pins</button>
            </div>
          )}
          {backlogCount>0 && (
            <div className="mb-3 text-xs text-orange-900 bg-orange-50 border border-orange-200 rounded-xl px-3 py-2 shrink-0 flex items-center gap-2">
              <span className="flex-1">
                {backlogCount} repeating task{backlogCount>1?'s have':' has'} rolled over unfinished and {backlogCount>1?'are':'is'} still competing for your slots.
                {' '}Old housekeeping work rarely needs doing — clear it, or set those tasks to auto-expire in settings.
              </span>
              <button onClick={clearBacklog} className="shrink-0 underline font-medium">Clear {backlogCount}</button>
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
          <div className="flex-1 overflow-x-auto overflow-y-hidden min-h-0">
            <div className="grid gap-3 h-full" style={{ gridTemplateColumns: `repeat(${Math.max(groupedDays.length,1)}, minmax(260px, 1fr))` }}>
              {groupedDays.map(day=>(
                <DayColumn key={day.date} day={day} isToday={day.date===todayStr} weekLabel={day.date===nextWeekStart ? 'Next week' : day.date===weekThreeStart ? 'Week after' : null} onToggleDone={toggleDone} onDelete={deleteTask} onEdit={startEditing} onTogglePressing={togglePressing} onUnpin={unpinTask} slotsUnlocked={slotsUnlocked} atRiskIds={dueDateRisk.atRiskIds} draggingTaskId={draggingTaskId} onDragStartTask={handleDragStartTask} onDragEndTask={handleDragEndTask} dragOverKey={dragOverKey} onDragOverSlot={setDragOverKey} onDropOnSlot={handleDropOnSlot} explainingKey={explainingKey} onToggleExplain={toggleExplain}/>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="shrink-0 border-t border-slate-200 bg-white/90 backdrop-blur-sm">
        <div className="flex items-center gap-6 px-6 py-3">
          <StatsBar stats={stats}/>
          <div className="flex-1"></div>
          <button onClick={()=>setOpenDrawer(d=>d==='completed'?null:'completed')} className="flex items-center gap-2 text-sm font-medium text-slate-500 shrink-0">
            Completed
            {openDrawer==='completed' ? <ChevronUp className="w-4 h-4"/> : <ChevronDown className="w-4 h-4"/>}
          </button>
          <button onClick={()=>setOpenDrawer(d=>d==='trends'?null:'trends')} className="flex items-center gap-2 text-sm font-medium text-slate-500 shrink-0">
            Term trends
            {openDrawer==='trends' ? <ChevronUp className="w-4 h-4"/> : <ChevronDown className="w-4 h-4"/>}
          </button>
          <button onClick={()=>setOpenDrawer(d=>d==='settings'?null:'settings')} className="flex items-center gap-2 text-sm font-medium text-slate-500 shrink-0">
            <Settings2 className="w-4 h-4"/> Time slots & recurring tasks
            {openDrawer==='settings' ? <ChevronUp className="w-4 h-4"/> : <ChevronDown className="w-4 h-4"/>}
          </button>
        </div>
        {openDrawer==='completed' && (
          <div className="max-h-80 overflow-y-auto border-t border-slate-100 px-6 py-4">
            <CompletedPanel records={records}/>
          </div>
        )}
        {openDrawer==='trends' && (
          <div className="max-h-80 overflow-y-auto border-t border-slate-100 px-6 py-4">
            <TrendsPanel weeklySnapshots={weeklySnapshots} weeklyVolume={weeklyVolume} accuracy={accuracy}/>
          </div>
        )}
        {openDrawer==='settings' && (
          <div className="max-h-80 overflow-y-auto border-t border-slate-100 px-6 py-4">
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
              className="w-full mt-4 text-xs text-slate-400 border border-dashed border-slate-200 rounded-xl py-2 hover:text-slate-600 hover:border-slate-300"
              title="Only needed if this browser has tasks that never made it to the cloud — safe to press any time, it never duplicates"
            >
              Import any tasks saved in this browser
            </button>
          </div>
        )}
      </div>
      {toast && (
        <div key={toast.id} className="toast-pop fixed bottom-6 right-6 z-50 bg-slate-900 text-white rounded-2xl shadow-2xl px-5 py-4 max-w-xs">
          <div className="flex items-center gap-3">
            <PartyPopper className="w-5 h-5 text-amber-400 shrink-0"/>
            <span className="text-sm font-medium">{toast.message}</span>
          </div>
          {toast.askTime && (
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-700">
              <span className="text-xs text-slate-400 shrink-0">Actual time?</span>
              <input type="number" min="1" placeholder="min" value={timeInput} onChange={e=>setTimeInput(e.target.value)} className="w-16 text-xs rounded-lg bg-slate-800 border border-slate-700 px-2 py-1 text-white focus:outline-none focus:ring-1 focus:ring-amber-400"/>
              <button onClick={saveActualTime} className="text-xs bg-amber-400 text-slate-900 rounded-lg px-2.5 py-1 font-medium shrink-0">Save</button>
              <button onClick={dismissTimePrompt} className="text-xs text-slate-400 shrink-0">Skip</button>
            </div>
          )}
        </div>
      )}
      {pendingUndo && (
        <div className="toast-pop fixed bottom-6 left-6 z-50 bg-slate-900 text-white rounded-2xl shadow-2xl px-5 py-3 flex items-center gap-3">
          <Trash2 className="w-4 h-4 text-slate-400 shrink-0"/>
          <span className="text-sm">
            Deleted <span className="font-medium">{pendingUndo.task.title}</span>
          </span>
          <button onClick={undoDelete} className="flex items-center gap-1 text-xs bg-amber-400 text-slate-900 rounded-lg px-2.5 py-1.5 font-medium shrink-0">
            <Undo2 className="w-3 h-3"/> Undo
          </button>
        </div>
      )}
    </div>
  );
}
