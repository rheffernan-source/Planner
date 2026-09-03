// Registers this device for the morning to-do push (netlify/functions/morning-summary.js).
// Best-effort only: unsupported browsers, a declined permission prompt, or a
// missing VAPID key all just no-op rather than blocking anything else in the app.

import { getMessaging, getToken, isSupported } from "firebase/messaging";
import { doc, setDoc } from "firebase/firestore";
import { app, db } from "./firebase";

// Generate at: Firebase console -> Project settings -> Cloud Messaging ->
// Web Push certificates -> Generate key pair. Public value, safe to commit
// (same reasoning as firebaseConfig in firebase.js) — paste it here once.
const VAPID_KEY = "PASTE YOUR WEB PUSH VAPID KEY HERE";

export async function registerForPush(uid) {
  if (!uid || !VAPID_KEY || VAPID_KEY.startsWith("PASTE")) return;
  try {
    if (!(await isSupported())) return;
    if (typeof Notification === "undefined") return;

    const permission = await Notification.requestPermission();
    if (permission !== "granted") return;

    // The Workbox-generated service worker (registered by vite-plugin-pwa)
    // also carries the FCM background-message handler — see
    // vite.config.js's workbox.importScripts and public/firebase-messaging-sw.js.
    // getToken() needs that registration passed explicitly since it isn't
    // sitting at Firebase's default /firebase-messaging-sw.js location.
    const registration = await navigator.serviceWorker.ready;
    const messaging = getMessaging(app);
    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: registration,
    });
    if (!token) return;

    await setDoc(
      doc(db, "users", uid, "state", "pushToken"),
      { value: { token, updatedAt: Date.now() } },
      { merge: true }
    );
  } catch (error) {
    console.error("[push] registration failed", error);
  }
}
