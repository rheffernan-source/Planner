// src/AuthGate.jsx
// Wraps the planner. Nothing renders until Firebase knows who you are and the
// one-time import has finished, so the scheduler never sees a half-loaded week.
//
// Styled with Tailwind + the Prism design tokens (tailwind.config.js), matching
// the glass-card treatment used throughout the rest of the app.

import React, { useEffect, useState } from "react";
import { useAuth, migrateLocalDataIfNeeded } from "./cloudSync";

const SHELL = "relative min-h-screen flex items-center justify-center p-6 overflow-hidden bg-prism-base";
const CARD = "relative z-10 w-full max-w-sm rounded-2xl border border-white/60 bg-white/70 backdrop-blur-xl backdrop-saturate-150 shadow-prism-card p-6 text-center";

/*
  Same three ambient blobs used behind the main week view, so the pre-sign-in
  screen and the signed-in app read as one continuous surface rather than two
  different products.
*/
function AmbientBlobs(){
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -top-24 -left-24 w-72 h-72 rounded-full bg-prism-blob-blue opacity-40 blur-prism-blob"></div>
      <div className="absolute top-1/3 -right-20 w-72 h-72 rounded-full bg-prism-blob-violet opacity-40 blur-prism-blob"></div>
      <div className="absolute -bottom-24 left-1/3 w-72 h-72 rounded-full bg-prism-blob-navy opacity-20 blur-prism-blob"></div>
    </div>
  );
}

export default function AuthGate({ children }) {
  const { user, signIn, authError } = useAuth();
  const [migration, setMigration] = useState("idle"); // idle|running|done|failed

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setMigration("running");
    migrateLocalDataIfNeeded(user.uid)
      .then((result) => {
        if (cancelled) return;
        console.info("[migrate]", result);
        setMigration("done");
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("[migrate] failed", error);
        setMigration("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (user === undefined) {
    return (
      <div className={SHELL}>
        <AmbientBlobs/>
        <p className="relative z-10 text-sm text-prism-muted">Checking your sign-in…</p>
      </div>
    );
  }

  if (user === null) {
    return (
      <div className={SHELL}>
        <AmbientBlobs/>
        <div className={CARD}>
          <h1 className="font-display text-xl font-semibold text-prism-ink mb-2">Weekly Planner</h1>
          <p className="text-sm text-prism-muted mb-6">
            Sign in to use the same week on your laptop and your phone.
          </p>
          <button
            onClick={signIn}
            className="w-full min-h-[44px] py-3 rounded-xl bg-prism-cta text-white text-sm font-semibold shadow-prism-cta transition-transform hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep focus-visible:ring-offset-2"
          >
            Sign in with Google
          </button>
          {authError && (
            <p className="mt-4 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
              {authError}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (migration === "running") {
    return (
      <div className={SHELL}>
        <AmbientBlobs/>
        <p className="relative z-10 text-sm text-prism-muted">Bringing your tasks across…</p>
      </div>
    );
  }

  if (migration === "failed") {
    return (
      <div className={SHELL}>
        <AmbientBlobs/>
        <div className={CARD}>
          <p className="text-sm text-prism-ink mb-4">
            Couldn't import your saved tasks. Your local copy is untouched —
            reload to try again.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="w-full min-h-[44px] py-3 rounded-xl bg-prism-cta text-white text-sm font-semibold shadow-prism-cta transition-transform hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-prism-blue-deep focus-visible:ring-offset-2"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

/** Small status pill. Drop <SyncBadge status={status} /> in your header. */
export function SyncBadge({ status }) {
  const label = {
    connecting: "Connecting…",
    saving: "Saving…",
    synced: "All changes saved",
    offline: "Offline — changes will sync",
  }[status];

  const colour = {
    connecting: "text-prism-muted",
    saving: "text-prism-muted",
    synced: "text-emerald-700",
    offline: "text-amber-700",
  }[status];

  if (!label) return null;

  return (
    <span className={`text-xs whitespace-nowrap ${colour}`}>
      {label}
    </span>
  );
}
