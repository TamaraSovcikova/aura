import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import "./index.css";

// Keep the installed app up to date without prompting.
registerSW({ immediate: true });

// Wraps App rather than living inside it, so a throw in App's own render still has
// something left to draw. A blank screen tells her nothing and cannot be escaped.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
