import { useEffect, useState, type FormEvent } from "react";
import type { AdminUser, Me } from "../../shared/types";
import { S } from "../strings";
import { useToast } from "../toast";
import { useInstallPrompt } from "../pwa/install";
import { clearStoredIdentity, readStoredMe, writeStoredMe } from "../me-store";
import { AdminPanel } from "./AdminPanel";
import { SkeletonList } from "./SkeletonList";
import { UserMenu } from "./UserMenu";

/** Dedicated settings surface: every user gets the Account section
 *  (display name, password, price-hint preference); admins also get the
 *  user-management table below it. Protected by the same boot-time
 *  /api/auth/me check AppPage uses. */
export function SettingsPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const toast = useToast();
  const install = useInstallPrompt();

  useEffect(() => {
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function boot() {
    try {
      const meRes = await fetch("/api/auth/me");
      if (meRes.status === 401) {
        location.href = `/login?next=${encodeURIComponent("/settings")}`;
        return;
      }
      if (!meRes.ok) {
        const stored = readStoredMe();
        if (!stored) {
          setError(S.errors.loadWishlist);
          setBooted(true);
          return;
        }
        setMe(stored);
        setDisplayName(stored.displayName);
        setBooted(true);
        return;
      }
      const meBody = (await meRes.json()) as Me;
      setMe(meBody);
      setDisplayName(meBody.displayName);
      writeStoredMe(meBody);
      if (meBody.isAdmin) await refreshUsers();
      setBooted(true);
    } catch {
      const stored = readStoredMe();
      if (!stored) {
        setError(S.errors.loadWishlist);
      } else {
        setMe(stored);
        setDisplayName(stored.displayName);
      }
      setBooted(true);
    }
  }

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

  async function setHints(enabled: boolean) {
    if (!me) return;
    try {
      const res = await fetch("/api/auth/me/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hintsEnabled: enabled }),
      });
      if (!res.ok) throw new Error();
      const updated = { ...me, hintsEnabled: enabled };
      setMe(updated);
      writeStoredMe(updated);
    } catch {
      toast(S.errors.changeSettings, "danger");
    }
  }

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    if (!me || profileBusy) return;
    setProfileBusy(true);
    try {
      const res = await fetch("/api/auth/me/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      if (!res.ok) throw new Error();
      const updated = (await res.json()) as Me;
      setMe(updated);
      setDisplayName(updated.displayName);
      writeStoredMe(updated);
      toast(S.settings.profileSaved);
    } catch {
      toast(S.errors.changeSettings, "danger");
    } finally {
      setProfileBusy(false);
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    if (passwordBusy) return;
    setPasswordError(null);
    if (newPassword !== confirmPassword) {
      setPasswordError(S.settings.passwordMismatch);
      return;
    }
    setPasswordBusy(true);
    try {
      const res = await fetch("/api/auth/me/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (res.status === 401) {
        setPasswordError(S.settings.wrongPassword);
        return;
      }
      if (!res.ok) throw new Error();
      // The server cleared every session (including this one) and the
      // cookie — drop the local cache and sign in again.
      toast(S.settings.passwordChanged);
      await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
      clearStoredIdentity();
      location.href = "/login";
    } catch {
      setPasswordError(S.errors.changeSettings);
    } finally {
      setPasswordBusy(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    clearStoredIdentity();
    location.href = "/login";
  }

  if (error && !me) {
    return (
      <main className="auth-page">
        <div className="card auth-card">
          <p className="error" role="alert">{error}</p>
        </div>
      </main>
    );
  }

  if (!booted || !me) {
    return (
      <main className="app-shell">
        <header className="topbar">
          <div className="brand">
            <img className="brand-mark" src="/assets/brand/pwa/favicon-32.png" alt="" />
            <h1 className="brand-name">{S.app.name}</h1>
          </div>
        </header>
        <div className="app-main">
          <SkeletonList />
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label={S.settings.backToList}>
          <img className="brand-mark" src="/assets/brand/pwa/favicon-32.png" alt="" />
          <h1 className="brand-name">{S.app.name}</h1>
        </a>
        <div className="topbar-right">
          <UserMenu
            displayName={me.displayName || me.username}
            onLogout={logout}
            extra={
              install.canInstall ? (
                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  onClick={install.promptInstall}
                >
                  {S.pwa.install}
                </button>
              ) : undefined
            }
          />
        </div>
      </header>

      <div className="app-main">
        <h2 className="page-title">{S.settings.title}</h2>

        <section className="card" aria-label={S.settings.account}>
          <h3>{S.settings.account}</h3>
          <form className="item-form" onSubmit={saveProfile}>
            <div className="field">
              <label htmlFor="settings-display-name">{S.settings.displayName}</label>
              <input
                id="settings-display-name"
                type="text"
                autoComplete="nickname"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </div>
            <button type="submit" disabled={profileBusy}>
              {profileBusy ? S.form.saving : S.settings.saveProfile}
            </button>
          </form>

          <form className="item-form" onSubmit={changePassword}>
            <h3>{S.settings.changePassword}</h3>
            <div className="field">
              <label htmlFor="settings-current-password">{S.settings.currentPassword}</label>
              <input
                id="settings-current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </div>
            <div className="field-row">
              <div className="field grow">
                <label htmlFor="settings-new-password">{S.settings.newPassword}</label>
                <input
                  id="settings-new-password"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                />
              </div>
              <div className="field grow">
                <label htmlFor="settings-confirm-password">{S.settings.confirmPassword}</label>
                <input
                  id="settings-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>
            </div>
            {passwordError && <p className="error" role="alert">{passwordError}</p>}
            <button type="submit" disabled={passwordBusy}>
              {passwordBusy ? S.form.saving : S.settings.setPassword}
            </button>
          </form>

          <button
            type="button"
            className="menu-item"
            role="menuitemcheckbox"
            aria-checked={me.hintsEnabled}
            onClick={() => void setHints(!me.hintsEnabled)}
          >
            <span>{S.settings.hintsToggle}</span>
            <span className="menu-item-state">{me.hintsEnabled ? S.settings.on : S.settings.off}</span>
          </button>
        </section>

        {me.isAdmin && (
          <section aria-label={S.settings.usersSection}>
            {usersError && <p className="error" role="alert">{usersError}</p>}
            <AdminPanel users={users} onChanged={refreshUsers} />
          </section>
        )}
      </div>
    </main>
  );
}
