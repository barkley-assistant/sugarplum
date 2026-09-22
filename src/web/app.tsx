import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import { AppPage } from "./components/AppPage";
import { AppBottomBar } from "./components/AppBottomBar";
import { AddPage } from "./components/AddPage";
import { ItemPage } from "./components/ItemPage";
import { ItemEditPage } from "./components/ItemEditPage";
import { SettingsPage } from "./components/SettingsPage";
import { SettingsUserNewPage } from "./components/SettingsUserNewPage";
import { SettingsUsersPage } from "./components/SettingsUsersPage";
import { SharePage } from "./components/SharePage";
import { LoginView } from "./components/Login";
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
    case "settingsUsers":
      return <SettingsUsersPage />;
    case "settingsUserNew":
      return <SettingsUserNewPage />;
    case "add":
      return <AddPage search={route.search} />;
    case "item":
      return <ItemPage id={route.id} />;
    case "itemEdit":
      return <ItemEditPage id={route.id} />;
    // /login is an in-SPA view now (one HTML entry for the whole app): the
    // SPA boots the same shell and the router renders the login form.
    case "login":
      return <LoginView />;
    default:
      return <AppPage />;
  }
}

/** Document title per route (#62 D11). The item page overrides this once its
 *  item boots (the item's own title is only known then); every navigation
 *  resets it here first, so a stale item title can't outlive its page.
 *  The settings AREA shares one title (#96): the in-page h2 carries the screen
 *  name, and three tab suffixes for a 3-screen area is noise at mobile tab
 *  widths. */
function titleFor(route: Route): string {
  switch (route.name) {
    case "login":
      return "Sign in · sugarplum";
    case "add":
      return "Add item · sugarplum";
    case "itemEdit":
      return "Edit item · sugarplum";
    case "settings":
    case "settingsUsers":
    case "settingsUserNew":
      return "Settings · sugarplum";
    default:
      return "sugarplum";
  }
}

function Root() {
  const route = useRoute();
  useEffect(() => {
    document.title = titleFor(route);
  }, [route]);
  return (
    <ToastProvider>
      <ConfirmProvider>
        {viewFor(route)}
        {/* #95: persistent shell chrome — one mount, every authenticated
            route; AppBottomBar gates width + route itself (no bar on
            /share/:token or /login). Rendered after the route view so the
            bar is last in the natural Tab order, closing each page's tab
            order exactly as #73's feed contract did. */}
        <AppBottomBar route={route} />
      </ConfirmProvider>
    </ToastProvider>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Root />);
