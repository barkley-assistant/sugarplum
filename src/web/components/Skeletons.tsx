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
