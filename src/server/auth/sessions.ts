import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

export const SESSION_COOKIE = "sugarplum_session";

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  isActive: boolean;
  /** Honesty gate for automated price hints (users.hints_enabled). */
  hintsEnabled: boolean;
  /** Daily price-tracking opt-in (users.price_tracking_enabled, default on). */
  priceTrackingEnabled: boolean;
  /** #98: admin UI-exposure opt-in (users.show_user_management, default off).
   *  UI gating only — never consulted by /api/users* authorization. */
  showUserManagement: boolean;
}

export function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export function createSession(
  db: Database,
  userId: string,
  ttlDays: number,
): { token: string; expiresAt: string } {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  db.run("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)", [
    token,
    userId,
    expiresAt,
  ]);
  return { token, expiresAt };
}

/** Returns the session's user (plus whether sliding renewal fired this
 *  request), or null when the session is missing/expired/ the user was
 *  deactivated (the row is deleted in those cases).
 *
 *  Sliding renewal (#63): a session used inside the LAST half of its window
 *  is extended by its full window, so an active user is never surprise-logged-
 *  out. The window is the row's own `expires_at − created_at` span (the TTL
 *  current at mint), and BOTH columns are co-updated on renewal so the span
 *  never drifts — `created_at` means "window start (mint or last renewal)".
 *  Renewal happens at most once per half-window; an idle row is never written
 *  and still dies at its edge (the sweep and the expiry check are unchanged). */
export function getSessionUser(
  db: Database,
  token: string,
): { user: SessionUser | null; renewed: boolean } {
  const row = db
    .query(
      `SELECT s.expires_at AS expires_at, s.created_at AS created_at,
              u.id AS id, u.username AS username, u.display_name AS display_name,
              u.is_admin AS is_admin, u.is_active AS is_active, u.hints_enabled AS hints_enabled,
              u.price_tracking_enabled AS price_tracking_enabled,
              u.show_user_management AS show_user_management
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`,
    )
    .get(token) as
    | {
        expires_at: string;
        created_at: string;
        id: string;
        username: string;
        display_name: string;
        is_admin: number;
        is_active: number;
        hints_enabled: number;
        price_tracking_enabled: number;
        show_user_management: number;
      }
    | undefined;

  if (!row) return { user: null, renewed: false };
  const now = Date.now();
  if (row.expires_at <= nowIso() || !row.is_active) {
    db.run("DELETE FROM sessions WHERE token = ?", [token]);
    return { user: null, renewed: false };
  }

  // Fail-closed on a torn row: a non-positive window (unparseable dates)
  // never renews — that row dies at its edge exactly like before.
  const expiresMs = Date.parse(row.expires_at);
  const windowMs = expiresMs - Date.parse(row.created_at);
  let renewed = false;
  if (windowMs > 0 && expiresMs - now < windowMs / 2) {
    const startedAt = new Date(now).toISOString();
    db.run("UPDATE sessions SET created_at = ?, expires_at = ? WHERE token = ?", [
      startedAt,
      new Date(now + windowMs).toISOString(),
      token,
    ]);
    renewed = true;
  }

  return {
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      isAdmin: row.is_admin === 1,
      isActive: row.is_active === 1,
      hintsEnabled: row.hints_enabled === 1,
      priceTrackingEnabled: row.price_tracking_enabled === 1,
      showUserManagement: row.show_user_management === 1,
    },
    renewed,
  };
}

export function deleteSession(db: Database, token: string): void {
  db.run("DELETE FROM sessions WHERE token = ?", [token]);
}

export function deleteUserSessions(db: Database, userId: string): void {
  db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
}

export function sweepExpiredSessions(db: Database): void {
  db.run("DELETE FROM sessions WHERE expires_at < ?", [nowIso()]);
}

export function sessionCookie(token: string, secure: boolean, maxAgeDays: number): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(maxAgeDays * 86400)}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function nowIso(): string {
  return new Date().toISOString();
}