import { AppShell } from "./AppShell";

/** Settings-shaped boot skeleton: stacked section cards with a heading line
 *  + two field rows, mirroring the .settings-section rhythm. Also used on the
 *  feed → settings route transition (the target component boots into this
 *  state), so a soft navigation never flashes blank. */
export function SettingsSkeleton() {
  return (
    <AppShell brandHref="/" brandLinkLabel="Back to list">
      <div className="skeleton-settings" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton-section">
            <div className="skeleton-line short" />
            <div className="skeleton-line" />
            <div className="skeleton-line" />
          </div>
        ))}
      </div>
    </AppShell>
  );
}

/** Auth-card-shaped skeleton for the /login authed-check boot. Deliberately
 *  does NOT reuse the .auth-card class: e2e (app.spec test 16, spa.spec s4)
 *  targets .auth-card for the REAL form; transient skeleton chrome must not
 *  match those selectors. */
export function AuthSkeleton() {
  return (
    <main className="auth-page">
      <div className="card skeleton-auth" aria-hidden="true">
        <div className="skeleton-line short" />
        <div className="skeleton-line" />
        <div className="skeleton-line" />
        <div className="skeleton-line" />
      </div>
    </main>
  );
}
