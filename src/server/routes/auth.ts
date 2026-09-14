import { Database } from "bun:sqlite";
import { jsonError, jsonOk, requireSession, type RouteRequest, type RouteServer } from "../auth/middleware";
import { verifyDummyPassword, verifyPassword } from "../auth/passwords";
import { RateLimiter } from "../auth/rate-limit";
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  sessionCookie,
  sweepExpiredSessions,
  type SessionUser,
} from "../auth/sessions";
import type { Config } from "../config";

export function meOf(user: Pick<SessionUser, "id" | "username" | "displayName" | "isAdmin">) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    isAdmin: user.isAdmin,
  };
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  is_admin: number;
  is_active: number;
}

export function authRoutes(db: Database, config: Config, limiter: RateLimiter) {
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

        // Per (username + client IP), 10 failures per 15 minutes → 429.
        const ip = server.requestIP(req)?.address ?? "unknown";
        const key = `${username.toLowerCase()}|${ip}`;
        if (limiter.isBlocked(key)) {
          return new Response(JSON.stringify({ error: "Too many attempts. Try again later." }), {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": String(Math.ceil(limiter.retryAfterMs(key) / 1000)),
            },
          });
        }

        const user = db
          .query(
            `SELECT id, username, display_name, password_hash, is_admin, is_active
             FROM users WHERE username = ?`,
          )
          .get(username) as UserRow | undefined;

        if (!user) {
          // Constant-time-ish: same work as a real verify so unknown users are
          // not distinguishable from wrong passwords by timing.
          verifyDummyPassword();
          limiter.recordFailure(key);
          return jsonError(401, "Invalid username or password");
        }

        if (!verifyPassword(password, user.password_hash)) {
          limiter.recordFailure(key);
          return jsonError(401, "Invalid username or password");
        }

        if (!user.is_active) {
          return jsonError(400, "Account deactivated");
        }

        const { token } = createSession(db, user.id, config.sessionTtlDays);
        return new Response(
          JSON.stringify(
            meOf({ id: user.id, username: user.username, displayName: user.display_name, isAdmin: user.is_admin === 1 }),
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