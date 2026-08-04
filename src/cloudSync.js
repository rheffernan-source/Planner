// src/cloudSync.js
// Drop-in replacements for the useState + localStorage pairs the planner
// currently uses. useCloudTasks returns [tasks, setTasks] with exactly the
// same signature as useState, so the scheduler code above it doesn't change.

import { useCallback, useEffect, useRef, useState } from "react";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  setDoc,
  writeBatch,
} from "firebase/firestore";
import { auth, db, googleProvider } from "./firebase";

// ---------------------------------------------------------------------------
// CHECK THIS BEFORE YOU DEPLOY.
// The planner keeps everything under ONE localStorage key, as a single JSON
// blob: { tasks, slots, recDaily, recWeekly, lastGenWeek, weeklySnapshots,
// archive }. Find the real key with:
//     grep -n "STORAGE_KEY" src/App.jsx
// and look at the line that DEFINES it (not the getItem/setItem lines).
// Get this wrong and migration silently imports nothing.
// ---------------------------------------------------------------------------
export const STORAGE_KEY = "week-planner-state-v1";

const FLUSH_MS = 700; // debounce window — a drag or a burst of edits = 1 write
const BATCH_LIMIT = 400; // Firestore hard limit is 500 ops per batch

// --- helpers ---------------------------------------------------------------

// Firestore rejects any write containing `undefined`. React state is full of
// it (optional fields, cleared inputs). Strip it rather than crash the save.
function stripUndefined(value) {
  if (Array.isArray(value)) {
    return value.map(stripUndefined).filter((v) => v !== undefined);
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out;
  }
  return value;
}

// Firestore hands back Timestamp objects where you wrote Dates. The scheduler
// expects strings, so normalise on the way in.
function decodeTimestamps(value) {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(decodeTimestamps);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decodeTimestamps(v);
    return out;
  }
  return value;
}

// Key order is not stable across a Firestore round-trip, so plain
// JSON.stringify would report every document as "changed" on every snapshot
// and put the app in a write loop. Sort the keys.
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stableStringify(value[k]))
      .join(",") +
    "}"
  );
}

// updatedAt is bookkeeping, not content — never let it trigger a write.
function omitMeta(task) {
  const { updatedAt, ...rest } = task || {};
  return rest;
}

function isValidDocId(id) {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length < 1500 &&
    !id.includes("/") &&
    id !== "." &&
    id !== ".."
  );
}

// --- auth ------------------------------------------------------------------

function describeAuthError(error) {
  switch (error?.code) {
    case "auth/popup-blocked":
      return "Your browser blocked the sign-in window. Allow pop-ups for this site, then try again.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Sign-in was cancelled.";
    case "auth/unauthorized-domain":
      return "This address isn't on the Firebase authorised domains list. Add it under Authentication → Settings → Authorized domains.";
    case "auth/network-request-failed":
      return "No connection. Check your network and try again.";
    case "auth/operation-not-allowed":
      return "Google sign-in isn't switched on for this Firebase project yet.";
    default:
      return error?.message || "Sign-in failed.";
  }
}

export function useAuth() {
  // undefined = still checking, null = signed out, object = signed in
  const [user, setUser] = useState(undefined);
  const [authError, setAuthError] = useState(null);

  useEffect(() => onAuthStateChanged(auth, (u) => setUser(u ?? null)), []);

  const signIn = useCallback(async () => {
    setAuthError(null);
    try {
      // Pop-up, not redirect. The app is hosted on Netlify rather than
      // Firebase Hosting, and signInWithRedirect breaks on Safari, Firefox
      // and Chrome 115+ in that setup because of storage partitioning.
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      setAuthError(describeAuthError(error));
    }
  }, []);

  const signOutNow = useCallback(() => signOut(auth), []);

  return { user, signIn, signOut: signOutNow, authError, clearAuthError: () => setAuthError(null) };
}

// --- tasks: one document per task -----------------------------------------

export function useCloudTasks(uid) {
  const [tasks, setTasksState] = useState([]);
  const [status, setStatus] = useState("connecting"); // connecting|synced|saving|offline
  // True once the FIRST snapshot (or the first error) has come back for the current
  // uid. Distinct from `status` — status keeps changing after that, this doesn't.
  // App-level effects that generate/expire/archive tasks must wait for this, or they
  // run against the empty array above instead of your real data.
  const [loaded, setLoaded] = useState(false);

  const tasksRef = useRef([]);
  const pendingRef = useRef(new Map()); // id -> { type: "set"|"delete", data }
  const timerRef = useRef(null);

  // --- write side ---
  const flush = useCallback(async () => {
    if (!uid) return;
    const ops = Array.from(pendingRef.current.entries()).slice(0, BATCH_LIMIT);
    if (ops.length === 0) return;

    const batch = writeBatch(db);
    for (const [id, op] of ops) {
      const ref = doc(db, "users", uid, "tasks", id);
      if (op.type === "delete") batch.delete(ref);
      else batch.set(ref, stripUndefined({ ...op.data, updatedAt: Date.now() }));
    }

    try {
      await batch.commit();
      for (const [id] of ops) pendingRef.current.delete(id);
      if (pendingRef.current.size > 0) {
        timerRef.current = setTimeout(flush, FLUSH_MS);
      } else {
        setStatus("synced");
      }
    } catch (error) {
      // The write is already queued in IndexedDB and will retry itself.
      console.error("[sync] task write failed", error);
      setStatus("offline");
    }
  }, [uid]);

  const scheduleFlush = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, FLUSH_MS);
  }, [flush]);

  // --- read side ---
  useEffect(() => {
    if (!uid) return;
    setStatus("connecting");
    setLoaded(false);

    const unsubscribe = onSnapshot(
      collection(db, "users", uid, "tasks"),
      { includeMetadataChanges: true },
      (snap) => {
        const remote = snap.docs.map((d) =>
          decodeTimestamps({ ...d.data(), id: d.id })
        );

        // Overlay anything still sitting in the debounce queue, so a snapshot
        // arriving mid-edit can't roll back what you just typed.
        const pending = pendingRef.current;
        const merged = remote
          .filter((t) => pending.get(t.id)?.type !== "delete")
          .map((t) => (pending.has(t.id) ? pending.get(t.id).data : t));
        for (const [id, op] of pending) {
          if (op.type === "set" && !merged.some((t) => t.id === id)) {
            merged.push(op.data);
          }
        }

        tasksRef.current = merged;
        setTasksState(merged);
        setStatus(
          pending.size > 0
            ? "saving"
            : snap.metadata.fromCache
            ? "offline"
            : "synced"
        );
        setLoaded(true);
      },
      (error) => {
        console.error("[sync] task listener failed", error);
        setStatus("offline");
        // Still counts as "loaded" — a permission or network error is an answer, just
        // not a good one. Leaving `loaded` false forever would spin the app's loading
        // screen indefinitely instead of surfacing the offline state it already has.
        setLoaded(true);
      }
    );

    return () => {
      unsubscribe();
      clearTimeout(timerRef.current);
    };
  }, [uid]);

  // --- the useState-shaped setter the app calls ---
  const setTasks = useCallback(
    (updater) => {
      const prev = tasksRef.current;
      const next = typeof updater === "function" ? updater(prev) : updater;

      tasksRef.current = next;
      setTasksState(next);
      if (!uid) return;

      const prevById = new Map(prev.map((t) => [t.id, t]));
      const nextById = new Map(next.map((t) => [t.id, t]));

      for (const [id, task] of nextById) {
        if (!isValidDocId(id)) {
          console.error("[sync] task has an unusable id, not saved:", task);
          continue;
        }
        const before = prevById.get(id);
        if (
          !before ||
          stableStringify(omitMeta(before)) !== stableStringify(omitMeta(task))
        ) {
          pendingRef.current.set(id, { type: "set", data: task });
        }
      }
      for (const id of prevById.keys()) {
        if (!nextById.has(id)) pendingRef.current.set(id, { type: "delete" });
      }

      if (pendingRef.current.size > 0) {
        setStatus("saving");
        scheduleFlush();
      }
    },
    [uid, scheduleFlush]
  );

  // Don't lose the last 700ms of edits when the phone is locked or the tab
  // is closed. Committing here just hands the write to Firestore's own queue.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
    };
  }, [flush]);

  return [tasks, setTasks, status, loaded];
}

// --- everything else: one small shared document ---------------------------
// Snapshots, estimate history, prefs. These change together and are read
// together, so a single doc is cheaper and simpler than a collection.

export function useCloudDoc(uid, docName, initialValue) {
  const [value, setValueState] = useState(initialValue);
  // Same role as useCloudTasks' `loaded`: true once the first snapshot (or error) for
  // this uid/docName has arrived. Before that, `value` is still just `initialValue` —
  // real, or default-shaped filler, and effects reading it can't tell the difference.
  const [loaded, setLoaded] = useState(false);
  const valueRef = useRef(initialValue);
  const dirtyRef = useRef(false);
  const timerRef = useRef(null);

  const flush = useCallback(async () => {
    if (!uid || !dirtyRef.current) return;
    try {
      await setDoc(
        doc(db, "users", uid, "state", docName),
        stripUndefined({ value: valueRef.current, updatedAt: Date.now() }),
        { merge: true }
      );
      dirtyRef.current = false;
    } catch (error) {
      console.error(`[sync] ${docName} write failed`, error);
    }
  }, [uid, docName]);

  useEffect(() => {
    if (!uid) return;
    setLoaded(false);
    const unsubscribe = onSnapshot(
      doc(db, "users", uid, "state", docName),
      (snap) => {
        // A local edit in flight wins, and a doc that doesn't exist yet (first ever
        // sign-in, before any write has landed) just means the caller's initialValue
        // defaults stand — neither case skips marking the read as complete below.
        if (!dirtyRef.current && snap.exists()) {
          const incoming = decodeTimestamps(snap.data()?.value);
          if (incoming !== undefined) {
            valueRef.current = incoming;
            setValueState(incoming);
          }
        }
        setLoaded(true);
      },
      (error) => {
        console.error(`[sync] ${docName} listener failed`, error);
        setLoaded(true); // an error is still an answer — don't block the caller forever
      }
    );
    return () => {
      unsubscribe();
      clearTimeout(timerRef.current);
    };
  }, [uid, docName]);

  const setValue = useCallback(
    (updater) => {
      const next =
        typeof updater === "function" ? updater(valueRef.current) : updater;
      valueRef.current = next;
      setValueState(next);
      dirtyRef.current = true;
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, FLUSH_MS);
    },
    [flush]
  );

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
    };
  }, [flush]);

  return [value, setValue, loaded];
}

// --- one-time import of existing localStorage data ------------------------

function readLocalBlob() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error("[migrate] could not parse local data", error);
    return null;
  }
}

// Pulls the task array and the "everything else" fields apart. The blob is
// { tasks, slots, recDaily, recWeekly, lastGenWeek, weeklySnapshots, archive }
// — tasks becomes one Firestore document each, the rest travels together as
// a single state document since the app reads and writes it as one unit.
function splitLocalBlob(blob) {
  const tasks = Array.isArray(blob?.tasks) ? blob.tasks : [];
  const { tasks: _omit, ...rest } = blob || {};
  return { tasks, rest };
}

// Mirrors the one-off field cleanups the app's old localStorage-load effect used to
// run every time it read data in (stripping the removed energy/intensity system,
// dropping two retired daily-recurring definitions, adding recurring-weekly defaults
// that postdate older saves). Applying it HERE, once, at the moment local data is
// copied into the cloud, means every device reads already-clean Firestore data from
// then on — App.jsx doesn't need to repeat any of this on every load.
function applyLegacyMigrations(tasks, rest) {
  const migratedTasks = tasks.map((t) => {
    const { intensity, ...keep } = t;
    return { ...keep, pinnedTo: keep.pinnedTo !== undefined ? keep.pinnedTo : null };
  });

  let migratedSlots = rest.slots;
  if (Array.isArray(migratedSlots)) {
    migratedSlots = migratedSlots.map((s) => {
      const { energy, reserved, ...keep } = s;
      return keep;
    });
  }

  let migratedRecDaily = rest.recDaily;
  if (Array.isArray(migratedRecDaily)) {
    migratedRecDaily = migratedRecDaily
      .filter((r) => r.id !== "rec-daily-1" && r.id !== "rec-daily-2")
      .map((r) => (r.autoExpire !== undefined ? r : { ...r, autoExpire: false }));
  }

  let migratedRecWeekly = rest.recWeekly;
  if (Array.isArray(migratedRecWeekly)) {
    const additions = [
      { id: "rec-week-3", title: "Collate student data", duration: 10, day: null },
      { id: "rec-week-4", title: "Evaluations", duration: 15, day: null },
      { id: "rec-week-5", title: "Clean up emails", duration: 15, day: null },
    ];
    for (const add of additions) {
      if (!migratedRecWeekly.some((r) => r.id === add.id)) {
        migratedRecWeekly = [...migratedRecWeekly, add];
      }
    }
  }

  return {
    tasks: migratedTasks,
    rest: {
      ...rest,
      slots: migratedSlots,
      recDaily: migratedRecDaily,
      recWeekly: migratedRecWeekly,
    },
  };
}

/**
 * Copies localStorage tasks + state into Firestore the first time you sign in
 * on any device. Guarded by a flag stored in Firestore, so it runs once per
 * account — not once per device, and never a second time after you delete
 * things. localStorage is left untouched as a fallback.
 */
export async function migrateLocalDataIfNeeded(uid) {
  const stateRef = doc(db, "users", uid, "state", "app");
  const existing = await getDoc(stateRef);
  if (existing.exists() && existing.data()?.migratedAt) {
    return { migrated: false, reason: "already-done" };
  }

  const existingTasks = await getDocs(collection(db, "users", uid, "tasks"));
  if (!existingTasks.empty) {
    await setDoc(stateRef, { migratedAt: Date.now() }, { merge: true });
    return { migrated: false, reason: "cloud-not-empty" };
  }

  const rawSplit = splitLocalBlob(readLocalBlob());
  const { tasks: localTasks, rest: localState } = applyLegacyMigrations(
    rawSplit.tasks,
    rawSplit.rest
  );

  if (localTasks.length === 0) {
    // Deliberately NOT stamping migratedAt here. This browser has nothing to
    // give, but another one might: signing in on the Mac first must not lock
    // out the work PC, which is where the real week lives.
    return { migrated: false, reason: "nothing-local", count: 0 };
  }

  let written = 0;
  for (let i = 0; i < localTasks.length; i += BATCH_LIMIT) {
    const batch = writeBatch(db);
    for (const task of localTasks.slice(i, i + BATCH_LIMIT)) {
      const id = isValidDocId(task?.id)
        ? task.id
        : `t_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      batch.set(
        doc(db, "users", uid, "tasks", id),
        stripUndefined({ ...task, id, updatedAt: Date.now() })
      );
      written += 1;
    }
    await batch.commit();
  }

  await setDoc(
    stateRef,
    stripUndefined({
      value: localState,
      migratedAt: Date.now(),
      migratedCount: written,
    }),
    { merge: true }
  );

  return { migrated: true, count: written };
}

/**
 * Manual escape hatch, wired to a button in the app.
 *
 * Use when the automatic migration was skipped — typically because you signed
 * in on another device first, so the cloud wasn't empty by the time the work
 * PC got there. Merges by task id rather than wiping, so running it twice is
 * harmless: a task that's already up there is simply overwritten with the
 * identical local copy.
 */
export async function importFromThisBrowser(uid) {
  const rawSplit = splitLocalBlob(readLocalBlob());
  const { tasks: localTasks, rest: localState } = applyLegacyMigrations(
    rawSplit.tasks,
    rawSplit.rest
  );
  if (localTasks.length === 0) {
    return { imported: false, reason: "nothing-local", count: 0 };
  }

  let written = 0;
  for (let i = 0; i < localTasks.length; i += BATCH_LIMIT) {
    const batch = writeBatch(db);
    for (const task of localTasks.slice(i, i + BATCH_LIMIT)) {
      const id = isValidDocId(task?.id)
        ? task.id
        : `t_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      batch.set(
        doc(db, "users", uid, "tasks", id),
        stripUndefined({ ...task, id, updatedAt: Date.now() })
      );
      written += 1;
    }
    await batch.commit();
  }

  await setDoc(
    doc(db, "users", uid, "state", "app"),
    stripUndefined({
      value: localState,
      migratedAt: Date.now(),
      migratedCount: written,
    }),
    { merge: true }
  );

  return { imported: true, count: written };
}

/** Emergency hatch: pull everything back out as a JSON file. */
export async function exportBackup(uid) {
  const [taskSnap, stateSnap] = await Promise.all([
    getDocs(collection(db, "users", uid, "tasks")),
    getDoc(doc(db, "users", uid, "state", "app")),
  ]);
  const payload = {
    exportedAt: new Date().toISOString(),
    tasks: taskSnap.docs.map((d) => ({ ...d.data(), id: d.id })),
    state: stateSnap.exists() ? stateSnap.data()?.value ?? null : null,
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `weekly-planner-backup-${payload.exportedAt.slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export { deleteDoc };
