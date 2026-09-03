// Sends the daily "here's today's to-do list" push. A Netlify Scheduled
// Function, firing hourly (Netlify's scheduler is UTC-only on every plan) —
// it checks the current Sydney local hour itself and only actually sends
// once that hour matches TARGET_HOUR, with a per-user lastSentDate guard so
// a slow run or a re-fire within the same hour can't double-send.
//
// Credentials: FIREBASE_SERVICE_ACCOUNT_JSON must hold the full contents of
// the Firebase Admin SDK service-account key (Project settings -> Service
// accounts -> Generate new private key), pasted as-is into a Netlify
// environment variable. Set it in the Netlify dashboard — Site settings ->
// Environment variables. Nothing in this repo can set that for you.
//
// "Today's to-do list" here is a deliberate simplification, not the full
// buildSchedule placement from App.jsx (a ~500-line client-side scheduling
// engine, not something to fork into a server function without real testing
// against the live app it must not break). A task counts as "today" when
// it's undone and its dueDate, recurringDate, or pinnedTo.date is today —
// three signals already stored directly on the task doc.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const TARGET_HOUR = 7; // Sydney local time
const TIME_ZONE = "Australia/Sydney";

export const config = { schedule: "0 * * * *" };

let app;
function admin() {
  if (app) return app;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not set");
  app = initializeApp({ credential: cert(JSON.parse(raw)) });
  return app;
}

function sydneyNow() {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: TIME_ZONE,
    hourCycle: "h23",
    hour: "numeric",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    hour: Number(map.hour) % 24,
    dateStr: `${map.year}-${map.month}-${map.day}`,
    weekday: map.weekday,
  };
}

function summarizeTodaysTasks(tasks, dateStr) {
  const todays = tasks.filter(
    (t) =>
      !t.done &&
      (t.dueDate === dateStr ||
        t.recurringDate === dateStr ||
        t.pinnedTo?.date === dateStr)
  );
  if (todays.length === 0) return null;
  const titles = todays.map((t) => t.title).filter(Boolean);
  const shown = titles.slice(0, 3).join(", ");
  const rest = titles.length > 3 ? ` +${titles.length - 3} more` : "";
  return { count: todays.length, body: `${shown}${rest}` };
}

export default async (req) => {
  const { hour, dateStr, weekday } = sydneyNow();
  if (hour !== TARGET_HOUR) {
    return new Response(JSON.stringify({ skipped: "not-target-hour", hour }), { status: 200 });
  }

  admin();
  const db = getFirestore();
  const messaging = getMessaging();

  const userDocs = await db.collection("users").listDocuments();
  let sent = 0, skipped = 0, failed = 0;

  for (const userRef of userDocs) {
    try {
      const [tokenSnap, metaSnap, tasksSnap] = await Promise.all([
        userRef.collection("state").doc("pushToken").get(),
        userRef.collection("state").doc("pushMeta").get(),
        userRef.collection("tasks").get(),
      ]);

      const token = tokenSnap.data()?.value?.token;
      if (!token) { skipped++; continue; }

      const lastSentDate = metaSnap.data()?.value?.lastSentDate;
      if (lastSentDate === dateStr) { skipped++; continue; }

      const tasks = tasksSnap.docs.map((d) => d.data());
      const summary = summarizeTodaysTasks(tasks, dateStr);

      if (summary) {
        await messaging.send({
          token,
          notification: {
            title: `${weekday}'s to-do list`,
            body: `${summary.count} task${summary.count === 1 ? "" : "s"} today: ${summary.body}`,
          },
          webpush: { fcmOptions: { link: "/" } },
        });
        sent++;
      }

      await userRef.collection("state").doc("pushMeta").set(
        { value: { lastSentDate: dateStr }, updatedAt: Date.now() },
        { merge: true }
      );
    } catch (error) {
      failed++;
      // A dead/unregistered token is expected over time (uninstalled PWA,
      // cleared site data) — clear it so future runs stop retrying it.
      if (error?.errorInfo?.code === "messaging/registration-token-not-registered") {
        await userRef.collection("state").doc("pushToken").delete().catch(() => {});
      } else {
        console.error("[morning-summary] failed for user", userRef.id, error?.message || error);
      }
    }
  }

  return new Response(JSON.stringify({ sent, skipped, failed }), { status: 200 });
};
