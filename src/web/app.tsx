import { createRoot } from "react-dom/client";
import { AppPage } from "./components/AppPage";
import { ConfirmProvider } from "./confirm";
import { ToastProvider } from "./toast";

// Service worker registration is PROD-gated: dev serves rebuilt bundles with
// SUGARPLUM_DEV=1 and must not fight a stale shell cache.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // Registration failure is non-fatal; the app still works online.
  });
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <ToastProvider>
      <ConfirmProvider>
        <AppPage />
      </ConfirmProvider>
    </ToastProvider>,
  );
}