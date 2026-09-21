import { S } from "../strings";
import { navigate } from "../router";
import { useInstallPrompt } from "../pwa/install";
import { clearStoredIdentity } from "../me-store";
import { UserMenu } from "./UserMenu";

/** The topbar menu the settings screens share (#96): identity, the install
 *  entry when the browser offers one, sign-out. The Account screen had this
 *  inline; the Users and New user screens need the same chrome, so it lives
 *  here instead of three times. */
export function SettingsUserMenu({ displayName }: { displayName: string }) {
  const install = useInstallPrompt();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    clearStoredIdentity();
    navigate("/login");
  }

  return (
    <UserMenu
      displayName={displayName}
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
}
