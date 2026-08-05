// Mirrors cloudSync.js's useCloudTasks — same [entries, setEntries, status, loaded]
// shape, one Firestore doc per entry — but kept self-contained here rather than
// added to cloudSync.js, so the working planner sync file stays untouched.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Timestamp,
  collection,
  doc,
  onSnapshot,
  writeBatch,
} from 'firebase/firestore';
import { db } from '../firebase';

const FLUSH_MS = 700;
const BATCH_LIMIT = 400;

function stripUndefined(value) {
  if (Array.isArray(value)) {
    return value.map(stripUndefined).filter((v) => v !== undefined);
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out;
  }
  return value;
}

function decodeTimestamps(value) {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(decodeTimestamps);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decodeTimestamps(v);
    return out;
  }
  return value;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]))
      .join(',') +
    '}'
  );
}

function omitMeta(entry) {
  const { updatedAt, ...rest } = entry || {};
  return rest;
}

function isValidDocId(id) {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length < 1500 &&
    !id.includes('/') &&
    id !== '.' &&
    id !== '..'
  );
}

export function useEntries(uid) {
  const [entries, setEntriesState] = useState([]);
  const [status, setStatus] = useState('connecting'); // connecting|synced|saving|offline
  const [loaded, setLoaded] = useState(false);

  const entriesRef = useRef([]);
  const pendingRef = useRef(new Map()); // id -> { type: 'set'|'delete', data }
  const timerRef = useRef(null);

  const flush = useCallback(async () => {
    if (!uid) return;
    const ops = Array.from(pendingRef.current.entries()).slice(0, BATCH_LIMIT);
    if (ops.length === 0) return;

    const batch = writeBatch(db);
    for (const [id, op] of ops) {
      const ref = doc(db, 'users', uid, 'entries', id);
      if (op.type === 'delete') batch.delete(ref);
      else batch.set(ref, stripUndefined({ ...op.data, updatedAt: Date.now() }));
    }

    try {
      await batch.commit();
      for (const [id] of ops) pendingRef.current.delete(id);
      if (pendingRef.current.size > 0) {
        timerRef.current = setTimeout(flush, FLUSH_MS);
      } else {
        setStatus('synced');
      }
    } catch (error) {
      console.error('[record] entry write failed', error);
      setStatus('offline');
    }
  }, [uid]);

  const scheduleFlush = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, FLUSH_MS);
  }, [flush]);

  useEffect(() => {
    if (!uid) return;
    setStatus('connecting');
    setLoaded(false);

    const unsubscribe = onSnapshot(
      collection(db, 'users', uid, 'entries'),
      { includeMetadataChanges: true },
      (snap) => {
        const remote = snap.docs.map((d) => decodeTimestamps({ ...d.data(), id: d.id }));

        const pending = pendingRef.current;
        const merged = remote
          .filter((e) => pending.get(e.id)?.type !== 'delete')
          .map((e) => (pending.has(e.id) ? pending.get(e.id).data : e));
        for (const [id, op] of pending) {
          if (op.type === 'set' && !merged.some((e) => e.id === id)) {
            merged.push(op.data);
          }
        }

        entriesRef.current = merged;
        setEntriesState(merged);
        setStatus(pending.size > 0 ? 'saving' : snap.metadata.fromCache ? 'offline' : 'synced');
        setLoaded(true);
      },
      (error) => {
        console.error('[record] entries listener failed', error);
        setStatus('offline');
        setLoaded(true);
      }
    );

    return () => {
      unsubscribe();
      clearTimeout(timerRef.current);
    };
  }, [uid]);

  const setEntries = useCallback(
    (updater) => {
      const prev = entriesRef.current;
      const next = typeof updater === 'function' ? updater(prev) : updater;

      entriesRef.current = next;
      setEntriesState(next);
      if (!uid) return;

      const prevById = new Map(prev.map((e) => [e.id, e]));
      const nextById = new Map(next.map((e) => [e.id, e]));

      for (const [id, entry] of nextById) {
        if (!isValidDocId(id)) {
          console.error('[record] entry has an unusable id, not saved:', entry);
          continue;
        }
        const before = prevById.get(id);
        if (!before || stableStringify(omitMeta(before)) !== stableStringify(omitMeta(entry))) {
          pendingRef.current.set(id, { type: 'set', data: entry });
        }
      }
      for (const id of prevById.keys()) {
        if (!nextById.has(id)) pendingRef.current.set(id, { type: 'delete' });
      }

      if (pendingRef.current.size > 0) {
        setStatus('saving');
        scheduleFlush();
      }
    },
    [uid, scheduleFlush]
  );

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
    };
  }, [flush]);

  return [entries, setEntries, status, loaded];
}
