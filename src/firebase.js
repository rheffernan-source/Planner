// src/firebase.js
// Single place where Firebase is initialised. Nothing else in the app
// should call initializeApp / getAuth / getFirestore directly.

import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";

// ---------------------------------------------------------------------------
// PASTE YOUR CONFIG HERE (Firebase console -> Project settings -> Your apps)
//
// This block is safe to commit. A Firebase web config is a public identifier,
// not a secret — every Firebase web app ships it in the browser bundle. What
// actually protects your data is the Firestore security rules in
// firestore.rules. Do not skip those.
// ---------------------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyDE6bkLtPvFWYAl-SLqCBi9USy40Alhpyc",
  authDomain: "planner2-9958c.firebaseapp.com",
  projectId: "planner2-9958c",
  storageBucket: "planner2-9958c.firebasestorage.app",
  messagingSenderId: "579164547244",
  appId: "1:579164547244:web:a1022af25be1c94d345709"
};

export const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

export const googleProvider = new GoogleAuthProvider();
// Always show the account chooser, so you can pick the right Google account
// on a shared or multi-account device.
googleProvider.setCustomParameters({ prompt: "select_account" });

// Persistent cache = the planner opens instantly and keeps working with no
// signal (train, playground, dead zone). Writes queue in IndexedDB and sync
// when you come back online. Multi-tab manager means two open tabs on the
// work PC won't fight over the cache lock.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
});
