// src/AuthGate.jsx
// Wraps the planner. Nothing renders until Firebase knows who you are and the
// one-time import has finished, so the scheduler never sees a half-loaded week.
//
// Styling is inline on purpose — it works whether or not Tailwind made it into
// the Vite project. Swap for your own classes once it's running.

import React, { useEffect, useState } from "react";
import { useAuth, migrateLocalDataIfNeeded } from "./cloudSync";

const shell = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  color: "#1f2937",
};

const card = {
  width: "100%",
  maxWidth: "340px",
  textAlign: "center",
};

const button = {
  width: "100%",
  padding: "12px 16px",
  fontSize: "15px",
  fontWeight: 600,
  color: "#fff",
  background: "#1f2937",
  border: "none",
  borderRadius: "8px",
  cursor: "pointer",
};

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
      <div style={shell}>
        <p style={{ color: "#6b7280" }}>Checking your sign-in…</p>
      </div>
    );
  }

  if (user === null) {
    return (
      <div style={shell}>
        <div style={card}>
          <h1 style={{ fontSize: "20px", margin: "0 0 8px" }}>Weekly Planner</h1>
          <p style={{ color: "#6b7280", margin: "0 0 24px", fontSize: "14px" }}>
            Sign in to use the same week on your laptop and your phone.
          </p>
          <button style={button} onClick={signIn}>
            Sign in with Google
          </button>
          {authError && (
            <p style={{ color: "#b91c1c", fontSize: "13px", marginTop: "16px" }}>
              {authError}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (migration === "running") {
    return (
      <div style={shell}>
        <p style={{ color: "#6b7280" }}>Bringing your tasks across…</p>
      </div>
    );
  }

  if (migration === "failed") {
    return (
      <div style={shell}>
        <div style={card}>
          <p style={{ margin: "0 0 16px", fontSize: "14px" }}>
            Couldn't import your saved tasks. Your local copy is untouched —
            reload to try again.
          </p>
          <button style={button} onClick={() => window.location.reload()}>
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
    connecting: "#6b7280",
    saving: "#6b7280",
    synced: "#15803d",
    offline: "#b45309",
  }[status];

  if (!label) return null;

  return (
    <span style={{ fontSize: "12px", color: colour, whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}
