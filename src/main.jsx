import React from "react";
import ReactDOM from "react-dom/client";
import AuthGate from "./AuthGate";
import Root from "./Root";

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthGate>
      <Root />
    </AuthGate>
  </React.StrictMode>
);
