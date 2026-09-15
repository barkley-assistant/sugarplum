import { createRoot } from "react-dom/client";
import { Login } from "./components/Login";

// PROD-gated like the app shell: dev must not fight a stale shell cache.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // Registration failure is non-fatal; the app still works online.
  });
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<Login />);
}