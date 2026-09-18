import { useEffect, useState, type FormEvent } from "react";
import type { AdminUser, Me } from "../../shared/types";
import { S } from "../strings";
import { useToast } from "../toast";
import { useInstallPrompt } from "../pwa/install";
import { clearStoredIdentity, readStoredMe, writeStoredMe } from "../me-store";
import { navigate } from "../router";
import { AdminPanel } from "./AdminPanel";
import { AppShell, AppShellLoading, PageHeader } from "./AppShell";
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
        navigate(`/login?next=${encodeURIComponent("/settings")}`);
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

  async function setSetting(key: "hintsEnabled" | "priceTrackingEnabled", value: boolean) {
    if (!me) return;
    try {
      const res = await fetch("/api/auth/me/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      if (!res.ok) throw new Error();
      const updated = { ...me, [key]: value };
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
      navigate("/login");
    } catch {
      setPasswordError(S.errors.changeSettings);
    } finally {
      setPasswordBusy(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    clearStoredIdentity();
    navigate("/login");
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
    return <AppShellLoading />;
  }

  const userMenu = (
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
  );

  return (
    <AppShell brandHref="/" headerRight={userMenu}>
      <PageHeader title={S.settings.title} />

      <div className="settings-stack">
        <section className="settings-section" aria-label={S.settings.account}>
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
            <button type="submit" className="settings-submit" disabled={profileBusy}>
              {profileBusy ? S.form.saving : S.settings.saveProfile}
            </button>
          </form>
        </section>

        <section className="settings-section" aria-label={S.settings.changePassword}>
          <h3>{S.settings.changePassword}</h3>
          <form className="item-form" onSubmit={changePassword}>
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
            <button type="submit" className="settings-submit" disabled={passwordBusy}>
              {passwordBusy ? S.form.saving : S.settings.setPassword}
            </button>
          </form>
        </section>

        <section className="settings-section" aria-label={S.settings.preferences}>
          <h3>{S.settings.preferences}</h3>
          <button
            type="button"
            className="menu-item"
            role="switch"
            aria-checked={me.hintsEnabled}
            onClick={() => void setSetting("hintsEnabled", !me.hintsEnabled)}
          >
            <span>{S.settings.hintsToggle}</span>
            <span className="menu-item-state">{me.hintsEnabled ? S.settings.on : S.settings.off}</span>
          </button>

          <button
            type="button"
            className="menu-item"
            role="switch"
            aria-checked={me.priceTrackingEnabled}
            onClick={() => void setSetting("priceTrackingEnabled", !me.priceTrackingEnabled)}
          >
            <span>{S.settings.trackToggle}</span>
            <span className="menu-item-state">{me.priceTrackingEnabled ? S.settings.on : S.settings.off}</span>
          </button>
        </section>

        {me.isAdmin && (
          <section className="settings-section" aria-label={S.settings.usersSection}>
            <h3>{S.settings.usersSection}</h3>
            {usersError && <p className="error" role="alert">{usersError}</p>}
            <AdminPanel users={users} onChanged={refreshUsers} />
          </section>
        )}
      </div>
    </AppShell>
  );
}
