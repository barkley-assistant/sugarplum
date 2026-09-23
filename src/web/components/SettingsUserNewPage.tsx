import { useState, type FormEvent } from "react";
import { S } from "../strings";
import { classifyResponse, classifyWriteFailure } from "../net";
import { navigate } from "../router";
import { useToast } from "../toast";
import { useAdminBoot } from "../use-admin-boot";
import { usePageFocus } from "../use-page-focus";
import { AppShell, PageHeader } from "./AppShell";
import { ListContextBar } from "./ListContextBar";
import { SettingsSkeleton } from "./Skeletons";

/** /settings/users/new (#96): the create-user form, moved off the Account
 *  screen verbatim (same .item-form / .field-row markup and #new-* input ids,
 *  so the #97 row-geometry contract transfers untouched). Admins only — same
 *  boot gate as the users table (#98: role + the user-management opt-in),
 *  which is where a successful create lands. */
export function SettingsUserNewPage() {
  const boot = useAdminBoot();
  const headingRef = usePageFocus(boot.status);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function createUser(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, displayName: displayName || undefined, isAdmin }),
      });
      if (!res.ok) {
        // #117: the SW's {error:"offline"} body is internal copy — the
        // offline framing replaces it; a real server answer keeps its own.
        const kind = await classifyResponse(res);
        if (kind === "offline") {
          setError(S.offline.write);
          return;
        }
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? S.admin.createFailed);
        return;
      }
      toast(S.admin.userCreated);
      // The users screen refetches on mount, so the new row is there.
      navigate("/settings/users");
    } catch (err) {
      const kind = classifyWriteFailure(err);
      setError(kind === "offline" ? S.offline.write : S.admin.networkError);
    } finally {
      setBusy(false);
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
  // Not an admin — or an admin without the #98 user-management opt-in: the
  // boot gate has already queued the replace-redirect.
  if (!boot.me.isAdmin || !boot.me.showUserManagement) return <SettingsSkeleton />;

  return (
    <AppShell me={boot.me} brandHref="/">
      <PageHeader title={S.settings.titleNewUser} headingRef={headingRef} variant="form" />
      {/* #125: same header, same context row as every other authed page. */}
      <ListContextBar me={boot.me} />

      <div className="settings-screen-head">
        <button type="button" className="back-link" onClick={() => navigate("/settings/users")}>
          <span aria-hidden="true">←</span>
          {S.settings.backToUsers}
        </button>
      </div>

      <section className="settings-section" aria-label={S.settings.titleNewUser}>
        <form className="item-form" onSubmit={createUser}>
          <div className="field-row">
            <div className="field grow">
              <label htmlFor="new-username">{S.admin.username}</label>
              <input
                id="new-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
            <div className="field grow">
              <label htmlFor="new-display-name">{S.admin.displayName}</label>
              <input
                id="new-display-name"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <div className="field grow">
              <label htmlFor="new-password">{S.admin.password}</label>
              <input
                id="new-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
            {S.admin.isAdmin}
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? S.admin.creating : S.admin.createUser}
          </button>
        </form>
      </section>
    </AppShell>
  );
}
