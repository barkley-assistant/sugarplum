import { Database } from "bun:sqlite";
import { jsonError, jsonOk, requireSession, type RouteRequest, type RouteServer } from "../auth/middleware";
import { hashPassword, verifyDummyPassword, verifyPassword } from "../auth/passwords";
import { RateLimiter } from "../auth/rate-limit";
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  deleteUserSessions,
  sessionCookie,
  sweepExpiredSessions,
  type SessionUser,
} from "../auth/sessions";
import type { Config } from "../config";

export function meOf(
  user: Pick<SessionUser, "id" | "username" | "displayName" | "isAdmin" | "hintsEnabled" | "priceTrackingEnabled">,
) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    isAdmin: user.isAdmin,
    hintsEnabled: user.hintsEnabled,
    priceTrackingEnabled: user.priceTrackingEnabled,
  };
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  is_admin: number;
  is_active: number;
  hints_enabled: number;
  price_tracking_enabled: number;
}

export function authRoutes(
  db: Database,
  config: Config,
  limiter: RateLimiter,
  ipLimiter: RateLimiter,
) {
  return {
    "/api/auth/login": {
      POST: async (req: RouteRequest, server: RouteServer) => {
        sweepExpiredSessions(db);

        let body: { username?: unknown; password?: unknown };
        try {
          body = (await req.json()) as { username?: unknown; password?: unknown };
        } catch {
          return jsonError(400, "Invalid JSON body");
        }
        const username = typeof body.username === "string" ? body.username.trim() : "";
        const password = typeof body.password === "string" ? body.password : "";
        if (!username || !password) {
          return jsonError(400, "Username and password are required");
        }

        // Two failure buckets, both recorded on any credential failure:
        //  - per (username|IP), 10 / 15 min → the user-facing lockout;
        //  - per IP, 50 / 15 min → the spray backstop (#63 G3). Cycling random
        //    usernames from one IP never trips the first bucket, and every
        //    attempt costs a full scrypt verify.
        const ip = server.requestIP(req)?.address ?? "unknown";
        const key = `${username.toLowerCase()}|${ip}`;
        if (limiter.isBlocked(key) || ipLimiter.isBlocked(ip)) {
          const retryAfterMs = Math.max(limiter.retryAfterMs(key), ipLimiter.retryAfterMs(ip));
          return new Response(JSON.stringify({ error: "Too many attempts. Try again later." }), {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": String(Math.ceil(retryAfterMs / 1000)),
            },
          });
        }

        const user = db
          .query(
            `SELECT id, username, display_name, password_hash, is_admin, is_active, hints_enabled,
                    price_tracking_enabled
             FROM users WHERE username = ?`,
          )
          .get(username) as UserRow | undefined;

        if (!user) {
          // Constant-time-ish: same work as a real verify so unknown users are
          // not distinguishable from wrong passwords by timing.
          verifyDummyPassword();
          limiter.recordFailure(key);
          ipLimiter.recordFailure(ip);
          return jsonError(401, "Invalid username or password");
        }

        if (!verifyPassword(password, user.password_hash)) {
          limiter.recordFailure(key);
          ipLimiter.recordFailure(ip);
          return jsonError(401, "Invalid username or password");
        }

        if (!user.is_active) {
          return jsonError(400, "Account deactivated");
        }

        const { token } = createSession(db, user.id, config.sessionTtlDays);
        return new Response(
          JSON.stringify(
            meOf({
              id: user.id,
              username: user.username,
              displayName: user.display_name,
              isAdmin: user.is_admin === 1,
              hintsEnabled: user.hints_enabled === 1,
              priceTrackingEnabled: user.price_tracking_enabled === 1,
            }),
          ),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": sessionCookie(token, config.cookieSecure),
            },
          },
        );
      },
    },
    "/api/auth/logout": {
      POST: requireSession(db, (req, _user) => {
        const cookies = parseCookieHeader(req.headers.get("cookie"));
        const token = cookies.sugarplum_session;
        if (token) deleteSession(db, token);
        return new Response(null, {
          status: 204,
          headers: { "Set-Cookie": clearSessionCookie() },
        });
      }),
    },
    "/api/auth/me": {
      GET: requireSession(db, (_req, user) => jsonOk(meOf(user))),
    },
    "/api/auth/me/settings": {
      /** Self-only settings. Both knobs are per-user, default-on, and must
       *  hold across devices, so they live in the users row. Either or both
       *  may be set in one call; at least one must be present. */
      PUT: requireSession(db, async (req, user) => {
        let body: { hintsEnabled?: unknown; priceTrackingEnabled?: unknown };
        try {
          body = (await req.json()) as { hintsEnabled?: unknown; priceTrackingEnabled?: unknown };
        } catch {
          return jsonError(400, "Invalid JSON body");
        }
        if (body.hintsEnabled !== undefined && typeof body.hintsEnabled !== "boolean") {
          return jsonError(400, "hintsEnabled must be a boolean");
        }
        if (body.priceTrackingEnabled !== undefined && typeof body.priceTrackingEnabled !== "boolean") {
          return jsonError(400, "priceTrackingEnabled must be a boolean");
        }
        if (body.hintsEnabled === undefined && body.priceTrackingEnabled === undefined) {
          return jsonError(400, "Nothing to update");
        }
        const next = { ...user };
        if (body.hintsEnabled !== undefined) {
          db.run("UPDATE users SET hints_enabled = ? WHERE id = ?", [
            body.hintsEnabled ? 1 : 0,
            user.id,
          ]);
          next.hintsEnabled = body.hintsEnabled;
        }
        if (body.priceTrackingEnabled !== undefined) {
          db.run("UPDATE users SET price_tracking_enabled = ? WHERE id = ?", [
            body.priceTrackingEnabled ? 1 : 0,
            user.id,
          ]);
          next.priceTrackingEnabled = body.priceTrackingEnabled;
        }
        return jsonOk(meOf(next));
      }),
    },
    "/api/auth/me/profile": {
      /** Self-only display name. Same validation as the admin PATCH
       *  displayName branch; scoped to the session user, never the body. */
      PUT: requireSession(db, async (req, user) => {
        let body: { displayName?: unknown };
        try {
          body = (await req.json()) as { displayName?: unknown };
        } catch {
          return jsonError(400, "Invalid JSON body");
        }
        if (typeof body.displayName !== "string" || !body.displayName.trim()) {
          return jsonError(400, "displayName must be a non-empty string");
        }
        const displayName = body.displayName.trim();
        db.run("UPDATE users SET display_name = ? WHERE id = ?", [displayName, user.id]);
        return jsonOk(meOf({ ...user, displayName }));
      }),
    },
    "/api/auth/me/password": {
      /** Self-only password change. Verifies the current password (same
       *  constant-time path as login), then clears ALL of the user's
       *  sessions — including the caller's — so the UI redirects to /login.
       *  Mirrors the admin reset-password session behavior. */
      PUT: requireSession(db, async (req, user) => {
        let body: { currentPassword?: unknown; newPassword?: unknown };
        try {
          body = (await req.json()) as { currentPassword?: unknown; newPassword?: unknown };
        } catch {
          return jsonError(400, "Invalid JSON body");
        }
        const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
        const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
        if (!newPassword) return jsonError(400, "Password is required");

        const row = db
          .query("SELECT password_hash FROM users WHERE id = ?")
          .get(user.id) as { password_hash: string } | undefined;
        if (!row || !verifyPassword(currentPassword, row.password_hash)) {
          return jsonError(401, "Current password is incorrect");
        }

        db.run("UPDATE users SET password_hash = ? WHERE id = ?", [hashPassword(newPassword), user.id]);
        deleteUserSessions(db, user.id);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": clearSessionCookie(),
          },
        });
      }),
    },
  };
}

function parseCookieHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}