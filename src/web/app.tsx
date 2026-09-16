import { createRoot } from "react-dom/client";
import { AppPage } from "./components/AppPage";
import { SettingsPage } from "./components/SettingsPage";
import { SharePage } from "./components/SharePage";
import { ConfirmProvider } from "./confirm";
import { ToastProvider } from "./toast";

// Service worker registration is PROD-gated: dev serves rebuilt bundles with
// SUGARPLUM_DEV=1 and must not fight a stale shell cache.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // Registration failure is non-fatal; the app still works online.
  });
}

// /share/:token renders the ANONYMOUS share view — it must not call
// /api/auth/me (AppPage's boot redirects to /login on 401, which would bounce
// every anonymous visitor to a login wall). The regex enforces the token
// shape; a malformed path falls through to AppPage (a broken link either
// way). /settings is the account + user-management page (exact match, like
// /add on the server).
const shareMatch = /^\/share\/([0-9a-f]{64})$/.exec(location.pathname);
const isSettings = location.pathname === "/settings";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <ToastProvider>
      <ConfirmProvider>
        {shareMatch ? <SharePage token={shareMatch[1]} /> : isSettings ? <SettingsPage /> : <AppPage />}
      </ConfirmProvider>
    </ToastProvider>,
  );
}
