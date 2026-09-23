import { useState, type FormEvent } from "react";
import type { Me } from "../../shared/types";
import { S } from "../strings";
import { classifyResponse, classifyWriteFailure } from "../net";
import { useToast } from "../toast";
import { clearStoredIdentity, writeStoredMe } from "../me-store";
import { navigate } from "../router";
import { useBootMe } from "../use-boot-me";
import { usePageFocus } from "../use-page-focus";
import { AppShell, PageHeader } from "./AppShell";
import { ChevronRightIcon } from "./IconButton";
import { ListContextBar } from "./ListContextBar";
import { SettingsSkeleton } from "./Skeletons";
import { ToggleSwitch } from "./ToggleSwitch";

/** /settings (#96): the Account & Preferences screen — display name, password
 *  change and the preference switches. Admins get a "Show user management"
 *  switch (#98, default off) plus, when it is on, a Users entry row that leads
 *  to the admin-only /settings/users screen; the user-management table itself
 *  no longer lives on this route.
 *
 *  Boots through the shared useBootMe() ladder (401 → /login?next=, offline →
 *  the cached identity) exactly like the two admin screens; the local
 *  `updated` overlay carries profile/settings writes forward, because the hook
 *  fetches the identity once per mount. */
export function SettingsPage() {
  const boot = useBootMe();
  const headingRef = usePageFocus(boot.status);

  const [updated, setUpdated] = useState<Me | null>(null);
  const [displayNameDraft, setDisplayNameDraft] = useState<string | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const toast = useToast();
  const me = updated ?? (boot.status === "ready" || boot.status === "offline" ? boot.me : null);

  async function setSetting(
    key: "hintsEnabled" | "priceTrackingEnabled" | "showUserManagement",
    value: boolean,
  ) {
    if (!me) return;
    let res: Response | null = null;
    try {
      res = await fetch("/api/auth/me/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      if (!res.ok) throw new Error();
      const next = { ...me, [key]: value };
      setUpdated(next);
      writeStoredMe(next);
    } catch (err) {
      // #117: the connection's fault is named as such; a real server answer
      // keeps the action's own copy.
      const kind = res ? await classifyResponse(res) : classifyWriteFailure(err);
      toast(kind === "offline" ? S.offline.write : S.errors.changeSettings, "danger");
    }
  }

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    if (!me || profileBusy) return;
    setProfileBusy(true);
    let res: Response | null = null;
    try {
      res = await fetch("/api/auth/me/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      if (!res.ok) throw new Error();
      const next = (await res.json()) as Me;
      setUpdated(next);
      setDisplayNameDraft(next.displayName);
      writeStoredMe(next);
      toast(S.settings.profileSaved);
    } catch (err) {
      const kind = res ? await classifyResponse(res) : classifyWriteFailure(err);
      toast(kind === "offline" ? S.offline.write : S.errors.changeSettings, "danger");
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
    let res: Response | null = null;
    try {
      res = await fetch("/api/auth/me/password", {
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
    } catch (err) {
      // #117: this failure renders inline, not as a toast, and it says the
      // same thing — the write did not leave the device.
      const kind = res ? await classifyResponse(res) : classifyWriteFailure(err);
      setPasswordError(kind === "offline" ? S.offline.write : S.errors.changeSettings);
    } finally {
      setPasswordBusy(false);
    }
  }

  if (boot.status === "error") {
    return (
      <main className="auth-page">
        <div className="card auth-card">
          <p className="error" role="alert">{boot.message}</p>
        </div>
      </main>
    );
  }

  if (!me) {
    return <SettingsSkeleton />;
  }

  const displayName = displayNameDraft ?? me.displayName;

  return (
    <AppShell me={me} brandHref="/">
      <PageHeader title={S.settings.titleAccount} headingRef={headingRef} variant="form" />
      {/* #125: the settings screens carry the same header as every other
          authenticated page. The context bar sits under the page heading so
          the heading ladder (brand h1 → screen h2 → sections h3) holds. */}
      <ListContextBar me={me} />

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
                onChange={(e) => setDisplayNameDraft(e.target.value)}
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
            {/* #131: the password change is the cautious, occasional action —
                it wears the shared secondary grammar so the Save button above
                stays the page's single primary CTA. */}
            <button type="submit" className="secondary" disabled={passwordBusy}>
              {passwordBusy ? S.form.saving : S.settings.setPassword}
            </button>
          </form>
        </section>

        <section className="settings-section" aria-label={S.settings.preferences}>
          <h3>{S.settings.preferences}</h3>
          <ToggleSwitch
            label={S.settings.hintsToggle}
            checked={me.hintsEnabled}
            onChange={(next) => void setSetting("hintsEnabled", next)}
          />
          <ToggleSwitch
            label={S.settings.trackToggle}
            checked={me.priceTrackingEnabled}
            onChange={(next) => void setSetting("priceTrackingEnabled", next)}
          />
          {/* #98: the opt-in that reveals the admin user-management area.
              Admins only — members never see the control (and gained nothing
              if they did: the entry below also requires isAdmin). */}
          {me.isAdmin && (
            <ToggleSwitch
              label={S.settings.usersToggle}
              checked={me.showUserManagement}
              onChange={(next) => void setSetting("showUserManagement", next)}
            />
          )}
        </section>

        {me.isAdmin && me.showUserManagement && (
          <section className="settings-section settings-nav-section" aria-label={S.settings.usersEntry}>
            <button
              type="button"
              className="settings-nav-row"
              onClick={() => navigate("/settings/users")}
            >
              <span>{S.settings.usersEntry}</span>
              <span className="settings-nav-chevron">
                <ChevronRightIcon />
              </span>
            </button>
          </section>
        )}
      </div>
    </AppShell>
  );
}
