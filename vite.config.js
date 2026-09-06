import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { execSync } from "node:child_process";

/*
  A visible build stamp. Without one there is no way to tell, from the phone,
  whether what you're looking at is the build that was just deployed or a
  service-worker cache from days ago - which cost a whole debugging session
  of shipping correct fixes at a device that never received them. Netlify
  sets COMMIT_REF on its builders; the git call is the local fallback.
*/
const commitRef = (() => {
  if (process.env.COMMIT_REF) return process.env.COMMIT_REF.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "nogit";
  }
})();
const buildStamp = `${commitRef} \u00b7 ${new Date().toISOString().slice(0, 16).replace("T", " ")}Z`;

export default defineConfig({
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Weekly Planner",
        short_name: "Planner",
        description: "Personal weekly planner and scheduler",
        start_url: "/",
        display: "standalone",
        background_color: "#0f172a",
        theme_color: "#0f172a",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // The app shell (JS/CSS/HTML/icons) is what needs to be installable
        // and load offline. Firestore's own client already handles offline
        // reads/writes via the persistentLocalCache configured in
        // src/firebase.js — the service worker must not also try to cache
        // Firestore's network calls, or the two caching layers fight each
        // other over what "the current data" is.
        globPatterns: ["**/*.{js,css,html,png,svg,ico}"],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/firestore\.googleapis\.com\/.*/i,
            handler: "NetworkOnly",
          },
          {
            urlPattern: /^https:\/\/identitytoolkit\.googleapis\.com\/.*/i,
            handler: "NetworkOnly",
          },
          {
            urlPattern: /^https:\/\/fcmregistrations\.googleapis\.com\/.*/i,
            handler: "NetworkOnly",
          },
        ],
        // Merges FCM's background-message handling into THIS service worker
        // rather than registering public/firebase-messaging-sw.js as its own
        // worker — two service workers can't both control the '/' scope, and
        // Firebase's default separate-file setup would silently lose the fight
        // with the Workbox worker this plugin already generates and owns.
        importScripts: ["firebase-messaging-sw.js"],
      },
    }),
  ],
});
