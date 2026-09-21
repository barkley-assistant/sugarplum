import { useEffect, useState } from "react";
import type { AdminUser } from "../../shared/types";
import { S } from "../strings";
import { navigate } from "../router";
import { useAdminBoot } from "../use-admin-boot";
import { usePageFocus } from "../use-page-focus";
import { AdminPanel } from "./AdminPanel";
import { AppShell, PageHeader } from "./AppShell";
import { SettingsSkeleton } from "./Skeletons";
import { SettingsUserMenu } from "./SettingsUserMenu";

/** /settings/users (#96): the admin user-management table. Admins only —
 *  non-admins are redirected to /settings by the boot gate, and the
 *  /api/users endpoints 403 them server-side regardless. The users list
 *  lives here now (it was the Account screen's state) so the table's data
 *  and its screen mount together. */
export function SettingsUsersPage() {
  const boot = useAdminBoot();
  const headingRef = usePageFocus(boot.status);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersError, setUsersError] = useState<string | null>(null);

  const isAdmin = (boot.status === "ready" || boot.status === "offline") && boot.me.isAdmin;

  useEffect(() => {
    if (!isAdmin) return;
    void refreshUsers();
  }, [isAdmin]);

  async function refreshUsers() {
    setUsersError(null);
    try {
      const res = await fetch("/api/users");
      if (!res.ok) throw new Error();
      setUsers((await res.json()) as AdminUser[]);
    } catch {
      setUsersError(S.errors.loadWishlist);
    }
  }

  if (boot.status === "loading") return <SettingsSkeleton />;
  if (boot.status === "error") {
    return (
      <AppShell brandHref="/" brandLinkLabel={S.settings.backToList}>
        <p className="error" role="alert">{boot.message}</p>
      </AppShell>
    );
  }
  // Non-admin: the boot gate has already queued the replace-redirect, so keep
  // the skeleton on screen rather than flashing admin chrome on the way out.
  if (!boot.me.isAdmin) return <SettingsSkeleton />;

  return (
    <AppShell
      brandHref="/"
      headerRight={<SettingsUserMenu displayName={boot.me.displayName || boot.me.username} />}
    >
      <PageHeader title={S.settings.titleUsers} headingRef={headingRef} />

      <div className="settings-screen-head">
        <button type="button" className="back-link" onClick={() => navigate("/settings")}>
          <span aria-hidden="true">←</span>
          {S.settings.backToAccount}
        </button>
        <button type="button" onClick={() => navigate("/settings/users/new")}>
          {S.settings.newUser}
        </button>
      </div>

      {usersError && <p className="error" role="alert">{usersError}</p>}
      <div className="settings-section">
        <AdminPanel users={users} onChanged={refreshUsers} />
      </div>
    </AppShell>
  );
}
