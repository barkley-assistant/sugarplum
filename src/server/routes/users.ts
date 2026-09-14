import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { jsonError, jsonOk, requireAdmin } from "../auth/middleware";
import { hashPassword } from "../auth/passwords";
import { deleteUserSessions } from "../auth/sessions";
import type { AdminUser } from "../../shared/types";

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  is_admin: number;
  is_active: number;
}

function toAdminUser(row: UserRow): AdminUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    isActive: row.is_active === 1,
  };
}

function getUserById(db: Database, id: string): UserRow | undefined {
  return db
    .query(
      `SELECT id, username, display_name, is_admin, is_active
       FROM users WHERE id = ?`,
    )
    .get(id) as UserRow | undefined;
}

export function userRoutes(db: Database) {
  return {
    "/api/users": {
      GET: requireAdmin(db, (_req) => {
        const rows = db
          .query(
            `SELECT id, username, display_name, is_admin, is_active
             FROM users ORDER BY username`,
          )
          .all() as UserRow[];
        return jsonOk(rows.map(toAdminUser));
      }),
      POST: requireAdmin(db, async (req) => {
        let body: { username?: unknown; password?: unknown; displayName?: unknown; isAdmin?: unknown };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonError(400, "Invalid JSON body");
        }
        const username = typeof body.username === "string" ? body.username.trim() : "";
        const password = typeof body.password === "string" ? body.password : "";
        if (!username) return jsonError(400, "Username is required");
        if (!password) return jsonError(400, "Password is required");

        const displayName =
          typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : username;
        const isAdmin = body.isAdmin === true;

        const existing = db.query("SELECT id FROM users WHERE username = ?").get(username);
        if (existing) return jsonError(409, "Username already taken");

        const id = randomUUID();
        db.run(
          `INSERT INTO users (id, username, display_name, password_hash, is_admin)
           VALUES (?, ?, ?, ?, ?)`,
          [id, username, displayName, hashPassword(password), isAdmin ? 1 : 0],
        );
        return jsonOk(toAdminUser(getUserById(db, id) as UserRow), 201);
      }),
    },
    "/api/users/:id": {
      PATCH: requireAdmin(db, async (req) => {
        const user = getUserById(db, req.params.id);
        if (!user) return jsonError(404, "User not found");

        let body: { displayName?: unknown };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonError(400, "Invalid JSON body");
        }

        if (body.displayName !== undefined) {
          if (typeof body.displayName !== "string" || !body.displayName.trim()) {
            return jsonError(400, "displayName must be a non-empty string");
          }
          db.run("UPDATE users SET display_name = ? WHERE id = ?", [body.displayName.trim(), user.id]);
        }
        return jsonOk(toAdminUser(getUserById(db, user.id) as UserRow));
      }),
      DELETE: requireAdmin(db, (req) => {
        const user = getUserById(db, req.params.id);
        if (!user) return jsonError(404, "User not found");
        // Their items and sessions cascade-delete; claims they made are
        // released (FK ON DELETE SET NULL on wishlist_items.claimed_by).
        db.run("DELETE FROM users WHERE id = ?", [user.id]);
        return new Response(null, { status: 204 });
      }),
    },
    "/api/users/:id/deactivate": {
      POST: requireAdmin(db, (req) => {
        const user = getUserById(db, req.params.id);
        if (!user) return jsonError(404, "User not found");
        db.run("UPDATE users SET is_active = 0 WHERE id = ?", [user.id]);
        deleteUserSessions(db, user.id);
        return jsonOk(toAdminUser(getUserById(db, user.id) as UserRow));
      }),
    },
    "/api/users/:id/activate": {
      POST: requireAdmin(db, (req) => {
        const user = getUserById(db, req.params.id);
        if (!user) return jsonError(404, "User not found");
        db.run("UPDATE users SET is_active = 1 WHERE id = ?", [user.id]);
        return jsonOk(toAdminUser(getUserById(db, user.id) as UserRow));
      }),
    },
    "/api/users/:id/reset-password": {
      POST: requireAdmin(db, async (req) => {
        const user = getUserById(db, req.params.id);
        if (!user) return jsonError(404, "User not found");

        let body: { password?: unknown };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonError(400, "Invalid JSON body");
        }
        const password = typeof body.password === "string" ? body.password : "";
        if (!password) return jsonError(400, "Password is required");

        db.run("UPDATE users SET password_hash = ? WHERE id = ?", [hashPassword(password), user.id]);
        deleteUserSessions(db, user.id);
        return jsonOk(toAdminUser(getUserById(db, user.id) as UserRow));
      }),
    },
  };
}