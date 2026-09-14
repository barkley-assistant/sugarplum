import { Database } from "bun:sqlite";
import { getSessionUser, SESSION_COOKIE, type SessionUser } from "./sessions";

/** Structural stand-ins for Bun's route handler arguments (BunRequest and
 *  the serve server), so middleware doesn't depend on Bun's internal
 *  namespace types. Bun's Handler<BunRequest, Server, Response> accepts
 *  these because both BunRequest and Server satisfy the minimal shapes. */
export type RouteRequest = Request & { params: Record<string, string> };
export type RouteServer = {
  requestIP: (req: Request) => { address: string } | null;
};

export type RouteHandler = (req: RouteRequest) => Response | Promise<Response>;
export type AuthedHandler = (req: RouteRequest, user: SessionUser) => Response | Promise<Response>;

export function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function parseCookies(header: string | null): Record<string, string> {
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

/** Wraps a handler with session lookup: 401 JSON when the cookie is missing,
 *  invalid, expired, or the user is deactivated. */
export function requireSession(db: Database, handler: AuthedHandler): RouteHandler {
  return (req) => {
    const cookies = parseCookies(req.headers.get("cookie"));
    const token = cookies[SESSION_COOKIE];
    if (!token) return jsonError(401, "Not signed in");
    const user = getSessionUser(db, token);
    if (!user) return jsonError(401, "Not signed in");
    return handler(req, user);
  };
}

/** requireSession + is_admin check → 403 JSON. */
export function requireAdmin(db: Database, handler: AuthedHandler): RouteHandler {
  return requireSession(db, (req, user) => {
    if (!user.isAdmin) return jsonError(403, "Admin access required");
    return handler(req, user);
  });
}