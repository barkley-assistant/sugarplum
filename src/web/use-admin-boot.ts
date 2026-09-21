import { useEffect } from "react";
import { useBootMe, type BootMe } from "./use-boot-me";
import { navigate } from "./router";

/** #96: the admin screens' boot gate. Runs the normal authed-page boot
 *  (/api/auth/me, 401 → /login?next=…) and additionally bounces non-admins
 *  to /settings. The redirect is UX, not security: the server's requireAdmin
 *  403s on /api/users* stay the enforcement (the client only learns isAdmin
 *  from /api/auth/me).
 *
 *  `replace: true` so the back button doesn't trap the user on a screen they
 *  were never allowed to see. Callers render the boot skeleton until this
 *  resolves to a `me` — a non-admin sees the skeleton for the frame the
 *  redirect takes, never a flash of admin UI. */
export function useAdminBoot(): BootMe {
  const boot = useBootMe();
  useEffect(() => {
    if (boot.status === "ready" || boot.status === "offline") {
      if (!boot.me.isAdmin) navigate("/settings", { replace: true });
    }
  }, [boot]);
  return boot;
}
