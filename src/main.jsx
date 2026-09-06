import React from "react";
import ReactDOM from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import "./index.css";
import AuthGate from "./AuthGate";
import Root from "./Root";

/*
  `registerType: "autoUpdate"` does NOT reload the page — it only makes the new
  worker skipWaiting + clientsClaim, which hands it control of a page that has
  already parsed the OLD html/css/js. Without importing this virtual module the
  plugin injects a bare `navigator.serviceWorker.register()` and there is no way
  to tell the app an update landed, so a deploy stays invisible until a cold
  launch — and an iOS home-screen app resumed from the app switcher may not cold
  launch for days. That is exactly how correct, verified-deployed fixes kept not
  reaching the phone.

  The visibilitychange check exists for the same reason: home-screen web apps are
  resumed far more often than they are launched, so resume is the only reliable
  moment to ask whether a new worker is waiting.
*/
registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) registration.update();
    });
  },
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthGate>
      <Root />
    </AuthGate>
  </React.StrictMode>
);
