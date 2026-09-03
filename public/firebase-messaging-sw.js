// NOT registered as its own service worker. vite.config.js pulls this in via
// workbox.importScripts, so this code runs inside the single Workbox-managed
// service worker that owns the '/' scope — see the comment there for why.
//
// Config duplicates src/firebase.js's firebaseConfig. It can't import that
// module (this runs as a classic importScripts, not an ES module), and these
// are public identifiers anyway (see src/firebase.js), so a hand-kept copy is
// the simplest option. Keep the two in sync if the Firebase project changes.
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyDE6bkLtPvFWYAl-SLqCBi9USy40Alhpyc",
  authDomain: "planner2-9958c.firebaseapp.com",
  projectId: "planner2-9958c",
  storageBucket: "planner2-9958c.firebasestorage.app",
  messagingSenderId: "579164547244",
  appId: "1:579164547244:web:a1022af25be1c94d345709",
});

const messaging = firebase.messaging();

// Fires only when the app isn't in the foreground — a foreground push is
// handled in-app instead (there's no in-app foreground handler yet, so a push
// that arrives while the tab is open is silently dropped; the morning summary
// is designed to land while the app isn't open anyway).
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || "Weekly Planner";
  const body = payload.notification?.body || "";
  self.registration.showNotification(title, {
    body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
  });
});
