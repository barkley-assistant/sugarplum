import { readStoredMe } from "../me-store";
import { AppShell } from "./AppShell";

/** #125 C.3: every boot skeleton seeds its header from the identity cache, so
 *  the shell paints the SAME 66px topbar the booted page is about to paint
 *  instead of a bare 52px lockup that grows when /api/auth/me answers. The
 *  cache is presentation state, never a session: a 401 boot still bounces to
 *  /login, and logout clears the key (me-store), so a signed-out skeleton
 *  stays bare. */

/** Settings-shaped boot skeleton: stacked section cards with a heading line
 *  + two field rows, mirroring the .settings-section rhythm. Also used on the
 *  feed → settings route transition (the target component boots into this
 *  state), so a soft navigation never flashes blank. */
export function SettingsSkeleton() {
  return (
    <AppShell me={readStoredMe()} brandHref="/" brandLinkLabel="Back to list">
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

/** Add/edit-page-shaped boot skeleton (#62): one section card with a heading
 *  line + two field rows — the paste-link-first form's rhythm. Same recipe
 *  as SettingsSkeleton, which is why it carries its own shell. `hideHeaderAdd`
 *  mirrors the page's own flag: /add drops the Add chip (D3), the edit page
 *  keeps it, and one skeleton serves both. */
export function FormSkeleton({ hideHeaderAdd = false }: { hideHeaderAdd?: boolean }) {
  return (
    <AppShell
      me={readStoredMe()}
      hideHeaderAdd={hideHeaderAdd}
      brandHref="/"
      brandLinkLabel="Back to list"
    >
      <div className="skeleton-form" aria-hidden="true">
        <div className="skeleton-section">
          <div className="skeleton-line short" />
          <div className="skeleton-line" />
          <div className="skeleton-line" />
        </div>
      </div>
    </AppShell>
  );
}

/** Item-page-shaped boot skeleton (#62): hero (thumb + lines) then two
 *  section cards — the detail page's rhythm. */
export function ItemSkeleton() {
  return (
    <AppShell me={readStoredMe()} brandHref="/" brandLinkLabel="Back to list">
      <div className="skeleton-item" aria-hidden="true">
        <div className="skeleton-hero">
          <div className="skeleton-thumb" />
          <div className="skeleton-hero-lines">
            <div className="skeleton-line short" />
            <div className="skeleton-line" />
          </div>
        </div>
        <div className="skeleton-section">
          <div className="skeleton-line" />
          <div className="skeleton-line" />
          <div className="skeleton-line" />
        </div>
        <div className="skeleton-section">
          <div className="skeleton-line" />
          <div className="skeleton-line" />
        </div>
      </div>
    </AppShell>
  );
}
