import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

export const SESSION_COOKIE = "sugarplum_session";

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  isActive: boolean;
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

/** Returns the session's user, or null when the session is missing/expired/
 *  the user was deactivated (the row is deleted in those cases). */
export function getSessionUser(db: Database, token: string): SessionUser | null {
  const row = db
    .query(
      `SELECT s.expires_at AS expires_at,
              u.id AS id, u.username AS username, u.display_name AS display_name,
              u.is_admin AS is_admin, u.is_active AS is_active
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`,
    )
    .get(token) as
    | {
        expires_at: string;
        id: string;
        username: string;
        display_name: string;
        is_admin: number;
        is_active: number;
      }
    | undefined;

  if (!row) return null;
  if (row.expires_at <= nowIso() || !row.is_active) {
    db.run("DELETE FROM sessions WHERE token = ?", [token]);
    return null;
  }

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    isActive: row.is_active === 1,
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

export function sessionCookie(token: string, secure: boolean): string {
  const attrs = ["HttpOnly", "SameSite=Lax", "Path=/"];
  if (secure) attrs.push("Secure");
  return `${SESSION_COOKIE}=${token}; ${attrs.join("; ")}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function nowIso(): string {
  return new Date().toISOString();
}