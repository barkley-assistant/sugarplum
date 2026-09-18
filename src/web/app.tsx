import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import { AppPage } from "./components/AppPage";
import { SettingsPage } from "./components/SettingsPage";
import { SharePage } from "./components/SharePage";
import { Login } from "./components/Login";
import { ConfirmProvider } from "./confirm";
import { ToastProvider } from "./toast";
import { useRoute, type Route } from "./router";

// Service worker registration is PROD-gated: dev serves rebuilt bundles with
// SUGARPLUM_DEV=1 and must not fight a stale shell cache.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // Registration failure is non-fatal; the app still works online.
  });
}

// The router owns scroll: navigate() scrolls to top on pushState, popstate
// restores the browser's position. Without this, a soft navigation would
// restore the previous route's scroll offset onto the new view.
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

/** Route → view. /share/:token renders the ANONYMOUS share view and nothing
 *  in that tree calls /api/auth/me (AppPage's boot redirects to /login on
 *  401, which would bounce every anonymous visitor to a login wall); the
 *  token regex is enforced by parseRoute, and a malformed path falls through
 *  to home. */
function viewFor(route: Route) {
  switch (route.name) {
    case "share":
      return <SharePage token={route.token} />;
    case "settings":
      return <SettingsPage />;
    // The SPA /login view is unreachable at this commit (the server still
    // serves login.html at /login, and every navigation to it is still a
    // full load) — it becomes live in the next commit, which renames
    // Login → LoginView and flips the server route.
    case "login":
      return <Login />;
    default:
      return <AppPage />;
  }
}

function Root() {
  const route = useRoute();
  useEffect(() => {
    document.title = route.name === "login" ? "Sign in · sugarplum" : "sugarplum";
  }, [route.name]);
  return (
    <ToastProvider>
      <ConfirmProvider>{viewFor(route)}</ConfirmProvider>
    </ToastProvider>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Root />);
