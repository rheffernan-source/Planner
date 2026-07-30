import React, { useState, useEffect, useMemo } from 'react';
import { Check, Plus, X, Trash2, ChevronDown, ChevronUp, Settings2, Loader2, Star, PartyPopper, Zap } from 'lucide-react';
/* ============================================================
   Constants — your real week template
   ============================================================ */
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const DAY_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const WEEKDAY_DAYS = [1,2,3,4,5]; // Mon-Fri — days that check emails / evaluations recur on
const LARGE_THRESHOLD = 30; // minutes — tasks at/above this count as "larger" for the reserved focus blocks
const STORAGE_KEY = 'week-planner-state-v1';
const DEFAULT_SLOTS = [
  { id: 'slot-mon-1', day: 1, start: '07:40', end: '08:00', restricted: false, energy: 'normal' },
  { id: 'slot-mon-2', day: 1, start: '10:30', end: '10:45', restricted: false, energy: 'normal' },
  { id: 'slot-mon-3', day: 1, start: '14:35', end: '15:00', restricted: false, energy: 'low' },
  { id: 'slot-tue-1', day: 2, start: '10:30', end: '10:45', restricted: false, energy: 'normal' },
  { id: 'slot-tue-2', day: 2, start: '14:35', end: '15:00', restricted: false, energy: 'low' },
  { id: 'slot-tue-3', day: 2, start: '19:00', end: '20:00', restricted: true, energy: 'low' },
  { id: 'slot-wed-1', day: 3, start: '07:40', end: '08:00', restricted: false, energy: 'normal' },
  { id: 'slot-wed-2', day: 3, start: '14:35', end: '15:00', restricted: false, energy: 'low' },
  { id: 'slot-thu-1', day: 4, start: '07:40', end: '08:00', restricted: false, energy: 'normal' },
  { id: 'slot-thu-2', day: 4, start: '10:30', end: '12:25', restricted: false, reserved: 'large', energy: 'high' },
  { id: 'slot-fri-1', day: 5, start: '11:35', end: '12:35', restricted: false, reserved: 'large', energy: 'high' },
  { id: 'slot-sat-1', day: 6, start: '10:00', end: '11:00', restricted: true, energy: 'normal' },
];
const DEFAULT_REC_DAILY = [];
const DEFAULT_REC_WEEKLY = [
  { id: 'rec-week-1', title: 'Look at slides for following week', duration: 15, day: null },
  { id: 'rec-week-2', title: 'Homework printing and prep', duration: 15, day: 3 },
  { id: 'rec-week-3', title: 'Collate student data', duration: 10, day: null },
  { id: 'rec-week-4', title: 'Evaluations', duration: 15, day: null },
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
// energy: a slot's focus quality. intensity: how demanding a task is. The scheduler
// prefers to match demanding work to high-energy slots (see energyMatch), but only as a
// soft preference layered inside the existing hard slot rules — nothing ever fails to
// place just because no matching-energy slot is free.
const ENERGY_LEVELS = ['high','normal','low'];
const INTENSITY_LEVELS = ['demanding','normal','light'];
const ENERGY_META = {
  high:   { label:'High focus', dot:'bg-violet-500', soft:'text-violet-600', chip:'bg-violet-50 text-violet-700 border-violet-200' },
  normal: { label:'Normal',     dot:'bg-slate-300', soft:'text-slate-500', chip:'bg-slate-50 text-slate-600 border-slate-200' },
  low:    { label:'Low energy', dot:'bg-teal-400',  soft:'text-teal-600',  chip:'bg-teal-50 text-teal-700 border-teal-200' },
};
const INTENSITY_META = {
  demanding: { label:'Demanding', short:'Demanding', chip:'bg-violet-50 text-violet-700 border-violet-200' },
  normal:    { label:'Normal',    short:'Normal',    chip:'bg-slate-50 text-slate-600 border-slate-200' },
  light:     { label:'Light',     short:'Light',     chip:'bg-teal-50 text-teal-700 border-teal-200' },
};
// Compact labels for tight 3-button rows (the daily energy check-in); ENERGY_META's own
// labels ("High focus", "Low energy") read better in chips/selects than squeezed buttons.
const ENERGY_SHORT = { high:'High', normal:'Normal', low:'Low' };
// A demanding task WANTS a high-energy slot; a light task is ideal in a low-energy slot.
// Returns true when task intensity matches slot energy for pass-1 (preferred) placement.
function energyMatch(task, slot){
  const energy = slot.energy || 'normal';
  const intensity = task.intensity || 'normal';
  if (energy==='high') return intensity==='demanding'; // protect high slots for demanding work
  if (energy==='low')  return intensity!=='demanding'; // low slots suit light/normal, keep demanding away
  return true; // normal slots: any task is a fine match
}
let idSeq = 0;
function genId(){ idSeq += 1; return 'id-'+Date.now().toString(36)+'-'+idSeq; }
/* ============================================================
   Scheduling engine (verified separately with node before wiring into the UI)
   ============================================================ */
function makeTask({ title, duration, dueDate, recurringId=null, source='adhoc', pressing=false, order, preference=null, intensity='normal' }){
  return { id: genId(), title, duration: Number(duration), dueDate, pressing, done:false, doneAt:null, createdAt: order, source, recurringId, preference, intensity, actualMinutes:null, wasRepacked: false };
}
function generateRecurringInstances(existingTasks, recDaily, recWeekly, now, lastGenWeek){
  const newTasks = [];
  const existingKeys = new Set(existingTasks.filter(t=>t.recurringId).map(t=>t.recurringId+'|'+t.dueDate));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thisWeekMonday = startOfWeek(today);
  let start = lastGenWeek ? addDays(parseDateStr(lastGenWeek), 7) : thisWeekMonday;
  const maxBack = addDays(thisWeekMonday, -8*7);
  if (start < maxBack) start = maxBack;
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
            newTasks.push(makeTask({ title: def.title, duration: def.duration, dueDate: dateStr, recurringId: def.id, source:'daily', order: order++, preference: def.preference||null }));
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
        newTasks.push(makeTask({ title: def.title, duration: def.duration, dueDate: dateStr, recurringId: def.id, source:'weekly', order: order++ }));
        existingKeys.add(key);
      }
    });
  }
  return { newTasks, newLastGenWeek: toDateStr(thisWeekMonday) };
}
const MIN_CHUNK = 5; // minutes — never carve off a sliver smaller than this when splitting a task
/*
  REPACKING ENGINE — retained as a no-op passthrough for compatibility, but no longer
  does anything, because it's now fully redundant.
  ================================================================================
  Previously this ran BEFORE buildSchedule to forcibly collapse a split task's pending
  sessions into one block whenever a single slot big enough for the whole remainder
  existed. That made sense under the old "carve once, fixed forever" sessions model,
  where buildSchedule itself would never reconsider an already-split task's shape.

  Under the FLUID REMAINING-WORK MODEL (see buildSchedule), every task's not-yet-done
  work is recarved fresh on every render anyway — buildSchedule will naturally place a
  task's whole remaining duration into one slot if a big-enough slot is available and
  priority order allows it, with no separate "repacking" pre-pass required. Keeping a
  forced collapse here would just be redundant extra work, and risks producing a
  `wasRepacked` session shape that fights with what buildSchedule would compute anyway.

  wasRepacked itself no longer corresponds to a meaningful discrete event under the
  fluid model (reshaping now happens continuously, not as an occasional "repack"), so
  this always returns tasks unchanged and wasRepacked simply stays false going forward.
  The field and its small UI indicator are left in place rather than torn out, in case
  a future scheduling mode wants to reintroduce a discrete repack signal.
*/
function attemptRepacking(tasks, slots){
  return tasks;
}
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
function buildScheduleOnce(tasks, slots, now, weeksAhead=3, unlockRestricted=false, demotedTaskIds=null){
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
        instances.push({ key: slot.id+'|'+dateStr, slotId:slot.id, date:dateStr, dayOfWeek:dow, start:slot.start, end:slot.end, startMin, endMin, restricted:slot.restricted, reserved:slot.reserved||null, energy:slot.energy||'normal', remaining:endMin-startMin, assigned:[] });
      }
    });
  }
  instances.sort((a,b)=> a.date===b.date ? a.startMin-b.startMin : (a.date<b.date?-1:1));
  const instanceIndexOf = new Map(instances.map((inst,idx)=>[inst,idx]));

  const isUrgent = t => t.pressing || (t.dueDate && t.dueDate<todayStr);
  const isLargeUndated = t => t.duration>=LARGE_THRESHOLD && !t.dueDate;
  const prefRank = t => t.preference==='earliest' ? -1 : (t.preference==='latest' ? 1 : 0);
  const isOverdue = t => t.dueDate && t.dueDate<todayStr;

  /*
    STRICT vs RELAXED reserved/restricted eligibility -- closes a real gap: a large,
    due-dated task at genuine risk of missing its deadline (critical slack) had NO
    path into reserved "large task" slots at all, because reserved-slot access only
    checked isUrgent (overdue/pressing) or isLargeUndated (large AND no due date
    whatsoever). A large task WITH a due date, not yet overdue, not pressing, fell
    through the cracks completely -- even when a reserved slot was the only place
    big enough to fit it before its deadline. This is exactly the "Interview Prep"
    pattern: fragmented into slivers across small open slots, spilling past its own
    due date, while a much bigger reserved slot sat unavailable to it the whole time.

    Fix: slack is computed ONCE under STRICT eligibility (avoids circularity -- slack
    must exist before we can ask "is this task critical"). If strict-eligibility
    slack is at or below zero, the task is CRITICAL, and only then does it gain the
    SAME relaxed access an overdue/pressing task already has, for actual PLACEMENT.
    This can never make a task worse off than before -- it only opens additional
    slots to a task that was otherwise mathematically going to miss its own deadline.
  */
  function eligibleMinutesBeforeStrict(task, dueDateStr){
    let total = 0;
    for (const inst of instances){
      if (inst.date > dueDateStr) continue;
      const canUseRestricted = inst.restricted ? isUrgent(task) : true;
      const canUseReserved = inst.reserved==='large' ? (isUrgent(task) || isLargeUndated(task)) : true;
      if (!canUseRestricted || !canUseReserved) continue;
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
  // SAME relaxed reserved/restricted access an overdue/pressing task already has to
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

  for (const task of sortedTasks){
    if (task.sessions && task.sessions.length){
      const completed = task.sessions.filter(s=>s.done).map(s=>({...s}));
      const doneMinutes = completed.reduce((sum,s)=>sum+s.minutesTotal,0);
      completedByTask.set(task.id, completed);
      const remainingMinutes = Math.max(0, task.duration - doneMinutes);
      if (remainingMinutes > 0){
        freeform.set(task.id, [{ id: genId(), minutesTotal: remainingMinutes }]);
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

  function tryPlaceOne(inst, task){
    // Every task's pending work is freeform now — carving is always allowed, every
    // render, so higher-priority tasks can always claim the earliest slot and push
    // lower-priority remaining work later or into a different shape.
    const pieces = freeform.get(task.id);
    if (!pieces.length) return false;
    const front = pieces[0];
    if (front.minutesTotal <= inst.remaining){
      inst.assigned.push({ ...task, id: task.id, sessionId: front.id, duration: front.minutesTotal });
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
    if (priorityTier(task)===2 && !task.dueDate && inst.remaining >= MIN_CHUNK){
      const instIdx = instanceIndexOf.get(inst);
      const laterFit = instances.find((later, idx) => {
        if (idx <= instIdx) return false; // only look forward from here
        if (later.restricted || later.reserved) return false; // don't defer into special slots on a hunch
        return later.remaining >= front.minutesTotal;
      });
      if (laterFit) return false; // hold this piece back; a better slot exists later
    }
    if (inst.remaining >= MIN_CHUNK){
      const carvedMinutes = inst.remaining;
      const remainderMinutes = front.minutesTotal - carvedMinutes;
      const carvedId = genId();
      const remainderId = genId();
      pieces.splice(0, 1, { id: carvedId, minutesTotal: carvedMinutes }, { id: remainderId, minutesTotal: remainderMinutes });
      inst.assigned.push({ ...task, id: task.id, sessionId: carvedId, duration: carvedMinutes });
      inst.remaining -= carvedMinutes;
      pieces.shift();
      return true;
    }
    return false;
  }

  /*
    TWO-PASS PLACEMENT — fixes "open slots left empty while a catch-up/reserved slot
    earlier in the week grabs ordinary tasks" (the bug this file was created to fix).

    Previously this was a single chronological pass: whichever slot came first in date
    order got first refusal on every task, including plain/generic ones. That let an
    unlocked catch-up slot (or a reserved "large tasks" slot with room to spare) sitting
    earlier in the week soak up ordinary undated tasks before the walk ever reached a
    perfectly good OPEN slot later on — even though the open slot needed no unlocking
    and was an equally good (often better) home for that task. This is exactly what was
    happening in the real schedule: catch-up-only blocks on Saturday/Tuesday evening were
    absorbing everyday tasks while genuinely open Wednesday slots sat empty.

    Fix: two full chronological passes over every instance.
      PASS 1 — each slot type takes only ITS OWN native category:
        - restricted (locked or unlocked): urgent tasks only
        - reserved 'large':                urgent or large-undated tasks only
        - open:                            ANY task — this is the real fallback capacity
      PASS 2 — now that every open slot in the whole window has had first claim on
      generic tasks, sweep again and let unlocked-restricted / reserved-large slots
      absorb whatever generic tasks are STILL unplaced, using their leftover room.

    Net effect: a restricted-but-unlocked or reserved slot can never take an ordinary
    task away from an open slot elsewhere in the same scheduling window — it only ever
    catches genuine overflow that open slots couldn't fit anywhere. Urgent placement,
    energy-matching preference, and session-carving rules are completely unchanged;
    only the ORDER in which "anything goes" fallback capacity is offered has moved.

    Verified with an isolated test harness: a 10-check regression suite (urgent/overdue
    access, energy matching, session carving, reserved-slot priority, minute
    conservation), a 500-trial randomized invariant fuzz test (no dropped tasks, no
    over-allocated slots), and a 1000-trial seeded comparison against the original
    single-pass logic showing zero cases where this fix places MORE generic work into
    restricted/reserved slots than before (157 trials strictly better, rest tied).
  */
  // ---- PASS 1: native category only per slot type ----
  // NOTE: reserved/restricted eligibility here uses hasSpecialAccess (isUrgent OR
  // critical due-date slack), not plain isUrgent -- see the STRICT vs RELAXED
  // eligibility comment above. This is what actually lets a critical, large,
  // due-dated task land in a reserved "big tasks" slot instead of being fragmented
  // into slivers across small open slots and missing its own deadline.
  for (const inst of instances){
    if (inst.restricted){
      // Locked or unlocked, pass 1 only ever serves urgent/critical tasks here --
      // energy match preferred first, then any qualifying task regardless of energy.
      for (const task of sortedTasks){
        if (isTaskFullyPlaced(task) || inst.remaining<=0) continue;
        if (!hasSpecialAccess(task) || !energyMatch(task, inst)) continue;
        tryPlaceOne(inst, task);
      }
      for (const task of sortedTasks){
        if (isTaskFullyPlaced(task) || inst.remaining<=0) continue;
        if (!hasSpecialAccess(task)) continue;
        tryPlaceOne(inst, task);
      }
    } else if (inst.reserved==='large'){
      for (const task of sortedTasks){ // big/urgent/critical + energy-matched first
        if (isTaskFullyPlaced(task) || inst.remaining<=0) continue;
        if (!(hasSpecialAccess(task) || isLargeUndated(task)) || !energyMatch(task, inst)) continue;
        tryPlaceOne(inst, task);
      }
      for (const task of sortedTasks){ // big/urgent/critical, any energy
        if (isTaskFullyPlaced(task) || inst.remaining<=0) continue;
        if (!(hasSpecialAccess(task) || isLargeUndated(task))) continue;
        tryPlaceOne(inst, task);
      }
      // The old "leftover space, energy-matched / anything" fallback for reserved
      // slots is deliberately deferred to PASS 2 below — see rationale above.
    } else {
      // genuinely open slots: the real fallback capacity. Energy-matched first, then anything.
      for (const task of sortedTasks){
        if (isTaskFullyPlaced(task) || inst.remaining<=0) continue;
        if (!energyMatch(task, inst)) continue;
        tryPlaceOne(inst, task);
      }
      for (const task of sortedTasks){
        if (isTaskFullyPlaced(task) || inst.remaining<=0) continue;
        tryPlaceOne(inst, task);
      }
    }
  }

  // ---- PASS 2: unlocked-restricted / reserved-large slots absorb remaining overflow ----
  // Only reached for tasks that pass 1 (across the ENTIRE window, including every open
  // slot) could not place. Chronological order still applies within this pass, so
  // earlier leftover room is still used before later leftover room.
  for (const inst of instances){
    if (inst.restricted && unlockRestricted){
      for (const task of sortedTasks){
        if (isTaskFullyPlaced(task) || inst.remaining<=0) continue;
        tryPlaceOne(inst, task);
      }
    } else if (inst.reserved==='large'){
      for (const task of sortedTasks){ // leftover space, energy-matched
        if (isTaskFullyPlaced(task) || inst.remaining<=0) continue;
        if (!energyMatch(task, inst)) continue;
        tryPlaceOne(inst, task);
      }
      for (const task of sortedTasks){ // leftover space, anything
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
      return { ...item, isPartial: count>1, chunkIndex: sessionIndexFor(task, item.sessionId), chunkCount: count };
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
function computeEligibleMinutesBeforeStandalone(task, dueDateStr, slots, now, weeksAhead, isUrgentFn, isLargeUndatedFn){
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
      const canUseReserved = slot.reserved==='large' ? (isUrgentFn(task) || isLargeUndatedFn(task)) : true;
      if (!canUseRestricted || !canUseReserved) continue;
      total += endMin - startMin;
    }
  }
  return total;
}

function buildSchedule(tasks, slots, now, weeksAhead=3, unlockRestricted=false){
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStr = toDateStr(today);
  const isUrgentFn = t => t.pressing || (t.dueDate && t.dueDate<todayStr);
  const isLargeUndatedFn = t => t.duration>=LARGE_THRESHOLD && !t.dueDate;

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
    const eligible = computeEligibleMinutesBeforeStandalone(task, task.dueDate, slots, now, weeksAhead, isUrgentFn, isLargeUndatedFn);
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
  Tasks whose definition doesn't set autoExpire (or isn't a daily recurring task at all)
  are untouched and keep carrying over exactly as before.
*/
function applyAutoExpiry(tasks, recDaily, todayStr){
  let changed = false;
  const next = tasks.map(t=>{
    if (t.done || t.pressing || !t.recurringId) return t;
    if (!(t.dueDate && t.dueDate < todayStr)) return t;
    const def = recDaily.find(d=>d.id===t.recurringId);
    if (def && def.autoExpire){
      changed = true;
      return { ...t, done:true, doneAt:Date.now(), autoExpired:true };
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
function computeStats(tasks, now){
  const todayStr = toDateStr(now);
  const weekStartStr = toDateStr(startOfWeek(now));
  const weekEndStr = toDateStr(addDays(startOfWeek(now),6));
  const monthPrefix = todayStr.slice(0,7);
  const yearPrefix = todayStr.slice(0,4);
  let day=0, week=0, month=0, year=0;
  for (const t of tasks){
    if (!t.done || !t.doneAt) continue;
    const dStr = toDateStr(new Date(t.doneAt));
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
*/
function getActualMinutes(task){
  if (task.sessions && task.sessions.length){
    if (task.sessions.some(s=>s.actualMinutes==null)) return null;
    return task.sessions.reduce((sum,s)=>sum+(s.actualMinutes||0),0);
  }
  return task.actualMinutes;
}
function computeAccuracy(tasks){
  const withData = tasks.filter(t=>t.done && getActualMinutes(t)!=null && t.duration>0);
  if (!withData.length) return null;
  const totalEstimate = withData.reduce((s,t)=>s+t.duration,0);
  const totalActual = withData.reduce((s,t)=>s+getActualMinutes(t),0);
  return { count: withData.length, ratio: totalActual/totalEstimate };
}
function computeWeeklyVolume(tasks, weekStartKeys){
  return weekStartKeys.map(wk=>{
    const wkEnd = toDateStr(addDays(parseDateStr(wk),6));
    const count = tasks.filter(t=>{
      if (!t.done || !t.doneAt) return false;
      const dStr = toDateStr(new Date(t.doneAt));
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
  above zero, is "orange". Zero overflow is "green".
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
  const weeklyCapacityMinutes = slots.reduce((sum,s)=> sum + (timeToMin(s.end)-timeToMin(s.start)), 0);
  const recurringWeeklyMinutes = recDaily.reduce((sum,d)=> sum + d.duration*WEEKDAY_DAYS.length, 0) + recWeekly.reduce((sum,w)=> sum + w.duration, 0);
  const netWeeklyCapacityMinutes = Math.max(0, weeklyCapacityMinutes - recurringWeeklyMinutes);
  let level;
  if (overflowMinutes <= 0) level = 'green';
  else if (netWeeklyCapacityMinutes <= 0 || overflowMinutes >= netWeeklyCapacityMinutes) level = 'red';
  else level = 'orange';
  return { level, overflowMinutes, netWeeklyCapacityMinutes };
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
  const labels = { green: 'On track', orange: 'Getting full', red: 'Overloaded' };
  const descriptions = {
    green: 'Everything besides recurring tasks fits within this week.',
    orange: `${formatDurationHM(workload.overflowMinutes)} of work is running past this week.`,
    red: `${formatDurationHM(workload.overflowMinutes)} of work won't fit this week — catch-up sessions are open to anything until this clears.`,
  };
  return (
    <div className="flex items-center gap-2.5 px-3 py-2 rounded-2xl border border-slate-200 bg-white" title={descriptions[workload.level]}>
      <div className="flex flex-col gap-1 bg-slate-800 rounded-md px-1.5 py-1.5">
        {dotConfig.map(d=>(
          <span key={d.key} className={`w-2.5 h-2.5 rounded-full ${workload.level===d.key?d.activeClass:d.dimClass}`}></span>
        ))}
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-xs font-semibold text-slate-700">{labels[workload.level]}</span>
        <span className="text-xs text-slate-400">This week's load</span>
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
  const emptyColor = isUnlockedRestricted ? 'text-slate-400' : inst.restricted ? 'text-rose-300' : inst.reserved==='large' ? 'text-indigo-300' : 'text-slate-400';
  return (
    <div key={inst.key} className="flap rounded-3xl px-6 py-7 bg-slate-900 shadow-lg shadow-slate-900/10">
      <div className="flex items-center justify-between mb-4">
        <Eyebrow className="text-amber-400">{label}</Eyebrow>
        <div className="flex items-center gap-2">
          {inst.energy==='high' && <Zap className="w-3.5 h-3.5 text-violet-400" fill="currentColor"/>}
          <span className="font-mono-plex text-xs text-slate-400">{timeLabel}</span>
        </div>
      </div>
      {inst.assigned.length===0 ? (
        <div className={`text-sm py-2 ${emptyColor}`}>
          {isUnlockedRestricted ? 'Open — catch-up slot unlocked while things are busy' : inst.restricted ? 'Catch-up block — nothing pressing right now' : inst.reserved==='large' ? 'Focus block — nothing big queued right now' : 'Open — nothing assigned yet'}
        </div>
      ) : (
        <div className="space-y-3">
          {inst.assigned.map(t=>{
            const isAtRisk = atRiskIds.has(t.id);
            return (
              <div key={inst.key+'|'+t.id} className={`flex items-start gap-3 ${isAtRisk?'bg-rose-500/10 border border-rose-500/30 rounded-xl px-3 py-2 -mx-3':''}`}>
                <button onClick={()=>onToggleDone(t.id, t.sessionId)} className={`w-7 h-7 mt-0.5 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors ${t.done?'bg-amber-400 border-amber-400':'border-slate-500 hover:border-amber-400'}`}>
                  {t.done && <Check className="w-4 h-4 text-slate-900"/>}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-lg font-medium ${t.done?'line-through text-slate-500':'text-white'}`}>{t.title}</span>
                    {t.intensity==='demanding' && <Zap className="w-3.5 h-3.5 text-violet-400 shrink-0" fill="currentColor"/>}
                    {t.isPartial && <span className="font-mono-plex text-xs text-slate-400 shrink-0">part {t.chunkIndex} · {t.duration}min</span>}
                    {t.dueDate && t.dueDate<inst.date && <span className="text-amber-400 text-xs shrink-0">from {formatShortDate(t.dueDate)}</span>}
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
function DayColumn({ day, isToday, isNextWeekStart, onToggleDone, onDelete, onTogglePressing, slotsUnlocked, atRiskIds }){
  const d = parseDateStr(day.date);
  return (
    <div className={`flex flex-col h-full rounded-2xl border overflow-hidden ${isToday?'border-amber-300 bg-amber-50/50':'border-slate-200 bg-white'}`}>
      <div className={`px-3 py-2.5 shrink-0 border-b ${isToday?'border-amber-200':'border-slate-100'}`}>
        {isNextWeekStart && <div className="text-xs font-semibold text-indigo-400 uppercase tracking-widest mb-1">Next week</div>}
        <div className={`text-xs font-semibold ${isToday?'text-amber-700':'text-slate-500'}`}>{DAY_NAMES[day.dayOfWeek]}{isToday?' · Today':''}</div>
        <div className="text-xs text-slate-400">{d.toLocaleDateString('en-AU',{day:'numeric',month:'short'})}</div>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {day.slots.length===0 ? (
          <div className="text-xs text-slate-300 italic py-1 px-1">No flex blocks</div>
        ) : day.slots.map(inst=>{
          const isUnlockedRestricted = inst.restricted && slotsUnlocked;
          return (
            <div key={inst.key} className={`rounded-lg px-2 py-1.5 border ${
              isUnlockedRestricted ? 'bg-rose-50/30 border-rose-200' :
              inst.restricted ? 'bg-rose-50/70 border-rose-200 border-dashed' :
              inst.reserved==='large' ? 'bg-indigo-50/70 border-indigo-200 border-dotted' :
              'bg-slate-50 border-slate-100'
            }`}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1">
                  <span className="font-mono-plex text-xs text-slate-500">{minToLabel(inst.startMin)}</span>
                  {inst.energy==='high' && <Zap className="w-3 h-3 text-violet-400" fill="currentColor"/>}
                </div>
                {isUnlockedRestricted && <span className="text-xs text-rose-500 font-medium">unlocked</span>}
              </div>
              <div className="space-y-2">
                {inst.assigned.length===0 ? (
                  <span className={`text-xs ${isUnlockedRestricted?'text-slate-300':inst.restricted?'text-rose-400':inst.reserved==='large'?'text-indigo-400':'text-slate-300'}`}>
                    {isUnlockedRestricted ? 'Open' : inst.restricted?'Catch-up only':inst.reserved==='large'?'Big tasks':'Open'}
                  </span>
                ) : inst.assigned.map(t=>{
                  const isAtRisk = atRiskIds.has(t.id);
                  return (
                    <div key={inst.key+'|'+t.id} className={isAtRisk ? 'rounded-md px-1.5 py-1 -mx-1.5 bg-rose-50 border border-rose-200' : ''}>
                      <div className="flex items-start gap-1.5">
                        <button onClick={()=>onToggleDone(t.id, t.sessionId)} className={`w-3.5 h-3.5 mt-0.5 rounded-full border shrink-0 flex items-center justify-center ${t.done?'bg-emerald-500 border-emerald-500':'border-slate-300'}`}>
                          {t.done && <Check className="w-2.5 h-2.5 text-white"/>}
                        </button>
                        <span className={`flex-1 min-w-0 break-words text-xs ${t.done?'line-through text-slate-400':'text-slate-700'}`}>{t.title}</span>
                        {t.intensity==='demanding' && <Zap className="w-3 h-3 text-violet-400 shrink-0 mt-0.5" fill="currentColor"/>}
                      </div>
                      {isAtRisk && (
                        <div className="pl-5 mt-0.5">
                          <span className="inline-block text-xs font-semibold text-rose-600 bg-rose-100 rounded px-1 py-0.5">
                            At risk · due {formatShortDate(t.dueDate)}
                          </span>
                        </div>
                      )}
                      <div className="flex items-center gap-1.5 mt-1 pl-5">
                        {t.isPartial && (
                          <div className="flex items-center gap-1">
                            <span className="font-mono-plex text-xs text-slate-400 shrink-0">{t.chunkIndex}·{t.duration}m</span>
                            {t.wasRepacked && <span className="text-xs text-teal-600 font-medium shrink-0" title="Remaining sessions consolidated">↫</span>}
                          </div>
                        )}
                        {t.dueDate && t.dueDate<day.date && <span className="text-xs text-amber-600 shrink-0">from {formatShortDate(t.dueDate)}</span>}
                        <span className="flex-1"></span>
                        <button onClick={()=>onTogglePressing(t.id)} className="shrink-0">
                          <Star className={`w-3 h-3 ${t.pressing?'text-amber-500':'text-slate-300'}`} fill={t.pressing?'currentColor':'none'}/>
                        </button>
                        <button onClick={()=>onDelete(t.id)} className="text-slate-300 shrink-0"><Trash2 className="w-3 h-3"/></button>
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
function EnergyCheckIn({ value, onSet }){
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3">
      <div className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-2">Energy today</div>
      <div className="flex gap-1.5">
        {ENERGY_LEVELS.map(lvl=>(
          <button key={lvl} onClick={()=>onSet(lvl)} className={`flex-1 text-xs py-2 rounded-lg border font-medium transition-colors ${value===lvl?'bg-violet-500 text-white border-violet-500':'border-slate-200 text-slate-500 hover:border-violet-300'}`}>
            {ENERGY_SHORT[lvl]}
          </button>
        ))}
      </div>
    </div>
  );
}
function AddTaskForm({ onAdd, onClose }){
  const [title,setTitle] = useState('');
  const [duration,setDuration] = useState(15);
  const [dueDate,setDueDate] = useState('');
  const [pressing,setPressing] = useState(false);
  const [intensity,setIntensity] = useState('normal');
  function submit(){
    if (!title.trim()) return;
    onAdd({ title: title.trim(), duration: Math.max(5, Number(duration)||15), dueDate: dueDate||null, pressing, intensity });
    onClose();
  }
  function handleTitleKeyDown(e){
    if (e.key === 'Enter'){ e.preventDefault(); submit(); }
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-900">Add a task</span>
        <button type="button" onClick={onClose} className="text-slate-400"><X className="w-4 h-4"/></button>
      </div>
      <input autoFocus value={title} onChange={e=>setTitle(e.target.value)} onKeyDown={handleTitleKeyDown} placeholder="What needs doing?" className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"/>
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="text-xs text-slate-400">Minutes</label>
          <input type="number" min="5" step="5" value={duration} onChange={e=>setDuration(e.target.value)} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"/>
        </div>
        <div className="flex-1">
          <label className="text-xs text-slate-400">Due by (optional)</label>
          <input type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"/>
        </div>
      </div>
      <div>
        <label className="text-xs text-slate-400 block mb-1">How demanding is this?</label>
        <div className="flex gap-1.5">
          {INTENSITY_LEVELS.map(lvl=>(
            <button key={lvl} type="button" onClick={()=>setIntensity(lvl)} className={`flex-1 text-xs py-1.5 rounded-lg border transition-colors ${intensity===lvl?'bg-violet-500 text-white border-violet-500':'border-slate-200 text-slate-500 hover:border-violet-300'}`}>
              {INTENSITY_META[lvl].short}
            </button>
          ))}
        </div>
      </div>
      <label className="flex items-start gap-2 text-xs text-slate-600">
        <input type="checkbox" checked={pressing} onChange={e=>setPressing(e.target.checked)} className="mt-0.5"/>
        <span>Pressing / specially requested — eligible for catch-up-only blocks (Tue eve, Sat morning)</span>
      </label>
      <button type="button" onClick={submit} className="w-full py-2.5 rounded-xl bg-slate-900 text-white text-sm font-medium">Add task</button>
    </div>
  );
}
function SettingsPanel({ slots, setSlots, recDaily, setRecDaily, recWeekly, setRecWeekly, onClearBacklog, backlogCount, slotsUnlocked }){
  const [newSlot,setNewSlot] = useState({ day:1, start:'', end:'', restricted:false, reserved:false, energy:'normal' });
  const [newDaily,setNewDaily] = useState({ title:'', duration:10, preference:'', autoExpire:false });
  const [newWeekly,setNewWeekly] = useState({ title:'', duration:15, day:'' });
  function addSlot(){
    if (!newSlot.start || !newSlot.end) return;
    setSlots(prev=>[...prev, { id:genId(), day:Number(newSlot.day), start:newSlot.start, end:newSlot.end, restricted:!!newSlot.restricted, reserved:newSlot.reserved?'large':null, energy:newSlot.energy }]);
    setNewSlot({ day:1, start:'', end:'', restricted:false, reserved:false, energy:'normal' });
  }
  function addDaily(){
    if (!newDaily.title.trim()) return;
    setRecDaily(prev=>[...prev, { id:genId(), title:newDaily.title.trim(), duration:Math.max(5,Number(newDaily.duration)||10), preference:newDaily.preference||null, autoExpire: !!newDaily.autoExpire }]);
    setNewDaily({ title:'', duration:10, preference:'', autoExpire:false });
  }
  function addWeekly(){
    if (!newWeekly.title.trim()) return;
    setRecWeekly(prev=>[...prev, { id:genId(), title:newWeekly.title.trim(), duration:Math.max(5,Number(newWeekly.duration)||15), day: newWeekly.day===''?null:Number(newWeekly.day) }]);
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
              <span className="text-slate-700">{DAY_SHORT[s.day]} {minToLabel(timeToMin(s.start))}–{minToLabel(timeToMin(s.end))}{s.restricted && <span className="text-rose-500"> · catch-up only{slotsUnlocked && ' (unlocked)'}</span>}{s.reserved==='large' && <span className="text-indigo-500"> · big tasks only</span>}{s.energy==='high' && <span className="text-violet-500"> · high energy</span>}{s.energy==='low' && <span className="text-teal-600"> · low energy</span>}</span>
              <button onClick={()=>setSlots(prev=>prev.filter(x=>x.id!==s.id))} className="text-slate-300"><Trash2 className="w-3.5 h-3.5"/></button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2 items-center bg-white border border-slate-200 rounded-xl p-2.5">
          <select value={newSlot.day} onChange={e=>setNewSlot(s=>({...s,day:e.target.value}))} className="text-xs border border-slate-200 rounded-lg px-2 py-1.5">
            {DAY_NAMES.map((n,i)=><option key={i} value={i}>{n}</option>)}
          </select>
          <input type="time" value={newSlot.start} onChange={e=>setNewSlot(s=>({...s,start:e.target.value}))} className="text-xs border border-slate-200 rounded-lg px-2 py-1.5"/>
          <input type="time" value={newSlot.end} onChange={e=>setNewSlot(s=>({...s,end:e.target.value}))} className="text-xs border border-slate-200 rounded-lg px-2 py-1.5"/>
          <select value={newSlot.energy} onChange={e=>setNewSlot(s=>({...s,energy:e.target.value}))} className="text-xs border border-slate-200 rounded-lg px-2 py-1.5">
            {ENERGY_LEVELS.map(lvl=><option key={lvl} value={lvl}>{ENERGY_SHORT[lvl]} energy</option>)}
          </select>
          <label className="flex items-center gap-1 text-xs text-slate-500">
            <input type="checkbox" checked={newSlot.restricted} onChange={e=>setNewSlot(s=>({...s,restricted:e.target.checked}))}/> catch-up only
          </label>
          <label className="flex items-center gap-1 text-xs text-slate-500">
            <input type="checkbox" checked={newSlot.reserved} onChange={e=>setNewSlot(s=>({...s,reserved:e.target.checked}))}/> big tasks only
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
              <button onClick={()=>setRecDaily(prev=>prev.filter(x=>x.id!==r.id))} className="text-slate-300 shrink-0"><Trash2 className="w-3.5 h-3.5"/></button>
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
            <div key={r.id} className="flex items-center justify-between text-sm bg-white border border-slate-200 rounded-xl px-3 py-2">
              <span className="text-slate-700">{r.title} · {r.duration}min{r.day!=null && ` · ${DAY_SHORT[r.day]}`}</span>
              <button onClick={()=>setRecWeekly(prev=>prev.filter(x=>x.id!==r.id))} className="text-slate-300"><Trash2 className="w-3.5 h-3.5"/></button>
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
  const [loaded,setLoaded] = useState(false);
  const [tasks,setTasks] = useState([]);
  const [slots,setSlots] = useState(DEFAULT_SLOTS);
  const [recDaily,setRecDaily] = useState(DEFAULT_REC_DAILY);
  const [recWeekly,setRecWeekly] = useState(DEFAULT_REC_WEEKLY);
  const [lastGenWeek,setLastGenWeek] = useState(null);
  const [now,setNow] = useState(new Date());
  const [showAdd,setShowAdd] = useState(false);
  const [openDrawer,setOpenDrawer] = useState(null); // null | 'settings' | 'trends' — accordion, so only one eats bottom-bar height at a time
  const [toast,setToast] = useState(null);
  const [timeInput,setTimeInput] = useState('');
  const [dailyEnergy,setDailyEnergy] = useState({}); // { 'YYYY-MM-DD': 'high'|'normal'|'low' } — resets naturally each day since it's keyed by date
  const [weeklySnapshots,setWeeklySnapshots] = useState({}); // { 'YYYY-MM-DD' (week start): { level, overflowMinutes } } — history for the term trend view
  const [energySchemeV2,setEnergySchemeV2] = useState(true); // one-time flag: has the Thu/Fri-only high-energy redefinition been applied yet. Defaults true since a fresh install already starts on the new scheme via DEFAULT_SLOTS — existing saved data is checked against its OWN loaded value below, not this default, so it still resyncs correctly the first time it's missing.
  useEffect(()=>{
    const t = setInterval(()=>setNow(new Date()), 30000);
    return ()=>clearInterval(t);
  },[]);
  useEffect(()=>{
    if (!toast || toast.askTime) return; // stay open while waiting for an explicit Save/Skip on the time prompt
    const t = setTimeout(()=> setToast(cur => (cur && cur.id===toast.id ? null : cur)), 2600);
    return ()=>clearTimeout(t);
  },[toast]);
  useEffect(()=>{
    (()=>{
      try {
        const rawValue = window.localStorage.getItem(STORAGE_KEY);
        if (rawValue){
          const data = JSON.parse(rawValue);
          if (data.tasks){
            // migration: tasks saved before intensity/actualMinutes existed default to
            // 'normal' intensity and no logged time — harmless, everyone starts neutral.
            const migratedTasks = data.tasks.map(t=> t.intensity!==undefined ? t : { ...t, intensity:'normal', actualMinutes: t.actualMinutes!==undefined?t.actualMinutes:null });
            setTasks(migratedTasks);
          }
          if (data.slots){
            // migration: slots saved before energy existed backfill from the matching
            // built-in default by id (same pattern as the autoExpire migration below),
            // else 'normal' for a slot the person added themselves.
            let migratedSlots = data.slots.map(s=>{
              if (s.energy !== undefined) return s;
              const def = DEFAULT_SLOTS.find(d=>d.id===s.id);
              return { ...s, energy: def ? def.energy : 'normal' };
            });
            // ONE-TIME redefinition: only the Thu/Fri focus blocks count as high-energy
            // now, everything after 2:30pm stays low, everything else is normal. This
            // force-applies the new scheme once to slots that still carry their original
            // template id; a slot the person deleted and re-added under a fresh id is
            // untouched (no default to match against). Runs only if it hasn't already,
            // so any manual energy edits made in Settings afterward are never overwritten.
            if (!data.energySchemeV2){
              migratedSlots = migratedSlots.map(s=>{
                const def = DEFAULT_SLOTS.find(d=>d.id===s.id);
                return def ? { ...s, energy: def.energy } : s;
              });
            }
            setEnergySchemeV2(true);
            setSlots(migratedSlots);
          }
          if (data.recDaily){
            // "Check emails" and "Evaluations" are no longer daily recurring definitions
            // — filtering by id is naturally idempotent, safe to run every load. Any
            // already-generated instances of either stay put as regular leftover tasks;
            // this only stops NEW ones from being generated going forward.
            const migratedRecDaily = data.recDaily
              .filter(r=>r.id!=='rec-daily-1' && r.id!=='rec-daily-2')
              .map(r=>{
                if (r.autoExpire !== undefined) return r;
                const def = DEFAULT_REC_DAILY.find(d=>d.id===r.id);
                return { ...r, autoExpire: def ? def.autoExpire : false };
              });
            setRecDaily(migratedRecDaily);
          }
          if (data.recWeekly){
            // add new weekly recurring tasks once each, if this saved state predates
            // them — id-checked, so safe to run on every load.
            let migratedRecWeekly = data.recWeekly;
            if (!migratedRecWeekly.some(r=>r.id==='rec-week-3')){
              migratedRecWeekly = [...migratedRecWeekly, { id:'rec-week-3', title:'Collate student data', duration:10, day:null }];
            }
            if (!migratedRecWeekly.some(r=>r.id==='rec-week-4')){
              migratedRecWeekly = [...migratedRecWeekly, { id:'rec-week-4', title:'Evaluations', duration:15, day:null }];
            }
            setRecWeekly(migratedRecWeekly);
          }
          if (data.lastGenWeek) setLastGenWeek(data.lastGenWeek);
          if (data.dailyEnergy) setDailyEnergy(data.dailyEnergy);
          if (data.weeklySnapshots) setWeeklySnapshots(data.weeklySnapshots);
        }
      } catch(e){ /* first ever run — keep defaults */ }
      setLoaded(true);
    })();
  },[]);
  useEffect(()=>{
    if (!loaded) return;
    const currentWeekMonday = toDateStr(startOfWeek(now));
    if (currentWeekMonday === lastGenWeek) return;
    const { newTasks, newLastGenWeek } = generateRecurringInstances(tasks, recDaily, recWeekly, now, lastGenWeek);
    if (newTasks.length) setTasks(prev=>[...prev, ...newTasks]);
    setLastGenWeek(newLastGenWeek);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[loaded, now, lastGenWeek]);
  useEffect(()=>{
    if (!loaded) return;
    const todayStrNow = toDateStr(now);
    setTasks(prev=>applyAutoExpiry(prev, recDaily, todayStrNow));
  },[loaded, now, recDaily]);
  useEffect(()=>{
    if (!loaded) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ tasks, slots, recDaily, recWeekly, lastGenWeek, dailyEnergy, weeklySnapshots, energySchemeV2 }));
    } catch(e){ /* storage unavailable or full — silently skip, same as before */ }
  },[tasks, slots, recDaily, recWeekly, lastGenWeek, dailyEnergy, weeklySnapshots, energySchemeV2, loaded]);
  // Repacking: collapse any split tasks whose pending sessions fit in a single slot
  const repachedTasks = useMemo(()=>attemptRepacking(tasks, slots), [tasks, slots]);
  // Baseline schedule: catch-up slots ALWAYS gated here, regardless of workload level —
  // this is what the traffic light itself is diagnosed from, so the diagnosis never
  // depends on whether the unlock is currently active (see computeWorkload for why).
  const baselineSchedule = useMemo(()=>buildSchedule(repachedTasks, slots, now), [repachedTasks, slots, now]);
  const workload = useMemo(()=>computeWorkload(repachedTasks, baselineSchedule, slots, recDaily, recWeekly, now), [repachedTasks, baselineSchedule, slots, recDaily, recWeekly, now]);
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
      return { ...prev, [wk]: { level: workload.level, overflowMinutes: workload.overflowMinutes } };
    });
  },[loaded, now, workload.level, workload.overflowMinutes]);
  // Due-date risk: a SEPARATE trigger for the same unlock, computed from the same
  // baseline for the same anti-oscillation reason — see computeDueDateRisk.
  const dueDateRisk = useMemo(()=>computeDueDateRisk(repachedTasks, baselineSchedule, toDateStr(now)), [repachedTasks, baselineSchedule, now]);
  // Slots unlock if EITHER the week is overloaded overall OR a specific task's own
  // deadline is projected to be missed — two different questions, one shared remedy.
  const slotsUnlocked = workload.level==='red' || dueDateRisk.count>0;
  // The schedule actually shown/used: identical to baseline unless something unlocked
  // catch-up slots, in which case everything gets recomputed once more with them open.
  const schedule = useMemo(()=>{
    if (slotsUnlocked) return buildSchedule(repachedTasks, slots, now, 3, true);
    return baselineSchedule;
  }, [slotsUnlocked, repachedTasks, slots, now, baselineSchedule]);
  // Persist the current render's session shape back onto each task so the UI reflects
  // it (e.g. "part 2 of 3" labels, completion checkboxes) — and so a completed session
  // stays marked done even though everything else is recarved fresh every render.
  // Also sync wasRepacked flag from repachedTasks into the persisted task.
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
        // Find the repacked version to get wasRepacked flag
        const repachedVersion = repachedTasks.find(rt=>rt.id===t.id);
        const wasRepackedNow = repachedVersion?.wasRepacked || false;
        return { ...t, sessions: newSessions, wasRepacked: wasRepackedNow };
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[schedule.sessionUpdates, loaded, repachedTasks]);
  const stats = useMemo(()=>computeStats(tasks, now), [tasks, now]);
  const todayStr = toDateStr(now);
  const nowMin = now.getHours()*60+now.getMinutes();
  const currentIdx = schedule.instances.findIndex(i=>i.date===todayStr && nowMin>=i.startMin && nowMin<i.endMin);
  const currentInst = currentIdx>=0 ? schedule.instances[currentIdx] : null;
  const nextInst = currentInst ? schedule.instances[currentIdx+1] : schedule.instances[0];
  const nextWeekStart = toDateStr(addDays(startOfWeek(now),7));
  const nextWeekEnd = toDateStr(addDays(startOfWeek(now),13));
  const weekDates = [];
  for (let i=0;i<14;i++){ const s = toDateStr(addDays(startOfWeek(now),i)); if (s>=todayStr && s<=nextWeekEnd) weekDates.push(s); }
  const groupedDays = weekDates.map(dstr=>({
    date: dstr,
    dayOfWeek: parseDateStr(dstr).getDay(),
    slots: schedule.instances.filter(i=>i.date===dstr).sort((a,b)=>a.startMin-b.startMin)
  }));
  const laterCount = schedule.instances.filter(i=>i.date>nextWeekEnd).reduce((sum,i)=>sum+i.assigned.length,0);
  const backlogCount = tasks.filter(t=>!t.done && t.recurringId && t.dueDate < todayStr).length;
  const accuracy = useMemo(()=>computeAccuracy(tasks), [tasks]);
  const weeklyVolume = useMemo(()=>computeWeeklyVolume(tasks, Object.keys(weeklySnapshots).sort().slice(-10)), [tasks, weeklySnapshots]);
  const todaysEnergy = dailyEnergy[todayStr] || null;
  // Warn-only, as decided — never auto-moves anything, just flags it so you can swap a
  // task out yourself if you want to.
  const demandingTodayCount = todaysEnergy==='low'
    ? schedule.instances.filter(i=>i.date===todayStr).reduce((sum,i)=>sum+i.assigned.filter(t=>t.intensity==='demanding').length,0)
    : 0;
  function setTodayEnergy(level){
    setDailyEnergy(prev=>({ ...prev, [todayStr]: level }));
  }
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
  function deleteTask(taskId){
    setTasks(prev=>prev.filter(t=>t.id!==taskId));
  }
  function addTask({ title, duration, dueDate, pressing, intensity }){
    setTasks(prev=>[...prev, makeTask({ title, duration, dueDate, pressing, intensity, source:'adhoc', order: Date.now() })]);
  }
  function clearBacklog(){
    setTasks(prev=>prev.map(t=> (!t.done && t.recurringId && t.dueDate<todayStr) ? {...t, done:true, doneAt:Date.now()} : t));
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
          <WorkloadIndicator workload={workload}/>
          <div className="font-mono-plex text-3xl text-slate-300 tabular-nums">{minToLabel(nowMin)}</div>
        </div>
      </header>
      <div className="planner-shell flex-1 p-5 overflow-hidden">
        <div className="flex flex-col gap-4 overflow-y-auto min-h-0 pr-1">
          <HeroCard currentInst={currentInst} nextInst={nextInst} onToggleDone={toggleDone} slotsUnlocked={slotsUnlocked} atRiskIds={dueDateRisk.atRiskIds}/>
          <EnergyCheckIn value={todaysEnergy} onSet={setTodayEnergy}/>
          <div>
            {!showAdd ? (
              <button onClick={()=>setShowAdd(true)} className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-slate-900 text-white font-semibold text-sm hover:bg-slate-800 transition-colors">
                <Plus className="w-5 h-5"/> New task
              </button>
            ) : (
              <AddTaskForm onAdd={addTask} onClose={()=>setShowAdd(false)}/>
            )}
          </div>
        </div>
        <div className="flex flex-col overflow-hidden min-h-0">
          <div className="flex items-center justify-between mb-3 shrink-0">
            <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-widest">Upcoming</h2>
            {laterCount>0 && <span className="text-xs text-slate-400">+{laterCount} scheduled beyond next week</span>}
          </div>
          {schedule.overflow.length>0 && (
            <div className="mb-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 shrink-0">
              {schedule.overflow.length} task{schedule.overflow.length>1?'s':''} still don't fully fit in the next 3 weeks (even after splitting) — worth trimming your list.
            </div>
          )}
          {dueDateRisk.count>0 && (
            <div className="mb-3 text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2 shrink-0">
              {dueDateRisk.count} task{dueDateRisk.count>1?'s are':' is'} projected to miss {dueDateRisk.count>1?'their':'its'} due date at the current pace — catch-up sessions are open to try to get {dueDateRisk.count>1?'them':'it'} there in time.
            </div>
          )}
          {demandingTodayCount>0 && (
            <div className="mb-3 text-xs text-violet-800 bg-violet-50 border border-violet-200 rounded-xl px-3 py-2 shrink-0 flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 shrink-0" fill="currentColor"/>
              You've marked today low-energy, but {demandingTodayCount} demanding task{demandingTodayCount>1?'s are':' is'} still scheduled today — worth swapping one out if you can.
            </div>
          )}
          <div className="flex-1 overflow-x-auto overflow-y-hidden min-h-0">
            <div className="grid gap-3 h-full" style={{ gridTemplateColumns: `repeat(${Math.max(groupedDays.length,1)}, minmax(260px, 1fr))` }}>
              {groupedDays.map(day=>(
                <DayColumn key={day.date} day={day} isToday={day.date===todayStr} isNextWeekStart={day.date===nextWeekStart} onToggleDone={toggleDone} onDelete={deleteTask} onTogglePressing={togglePressing} slotsUnlocked={slotsUnlocked} atRiskIds={dueDateRisk.atRiskIds}/>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="shrink-0 border-t border-slate-200 bg-white/90 backdrop-blur-sm">
        <div className="flex items-center gap-6 px-6 py-3">
          <StatsBar stats={stats}/>
          <div className="flex-1"></div>
          <button onClick={()=>setOpenDrawer(d=>d==='trends'?null:'trends')} className="flex items-center gap-2 text-sm font-medium text-slate-500 shrink-0">
            Term trends
            {openDrawer==='trends' ? <ChevronUp className="w-4 h-4"/> : <ChevronDown className="w-4 h-4"/>}
          </button>
          <button onClick={()=>setOpenDrawer(d=>d==='settings'?null:'settings')} className="flex items-center gap-2 text-sm font-medium text-slate-500 shrink-0">
            <Settings2 className="w-4 h-4"/> Time slots & recurring tasks
            {openDrawer==='settings' ? <ChevronUp className="w-4 h-4"/> : <ChevronDown className="w-4 h-4"/>}
          </button>
        </div>
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
    </div>
  );
}
