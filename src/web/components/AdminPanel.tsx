import { useState, type FormEvent } from "react";
import type { AdminUser } from "../../shared/types";

interface AdminPanelProps {
  users: AdminUser[];
  onChanged: () => void | Promise<void>;
}

export function AdminPanel({ users, onChanged }: AdminPanelProps) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function createUser(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, displayName: displayName || undefined, isAdmin }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Could not create user.");
        return;
      }
      setUsername("");
      setDisplayName("");
      setPassword("");
      setIsAdmin(false);
      await onChanged();
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function act(path: string, method = "POST", body?: unknown) {
    setError(null);
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(parsed?.error ?? "Request failed.");
      return;
    }
    await onChanged();
  }

  return (
    <section className="card admin-panel">
      <h2>Users</h2>

      <table className="admin-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Username</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td>{user.displayName}</td>
              <td>{user.username}</td>
              <td>
                {user.isAdmin ? "admin" : "user"}
                {user.isActive ? "" : " · inactive"}
              </td>
              <td className="admin-actions">
                {user.isActive ? (
                  <button
                    className="secondary"
                    onClick={() => act(`/api/users/${user.id}/deactivate`)}
                  >
                    Deactivate
                  </button>
                ) : (
                  <button
                    className="secondary"
                    onClick={() => act(`/api/users/${user.id}/activate`)}
                  >
                    Activate
                  </button>
                )}
                <button
                  className="secondary"
                  onClick={() => {
                    const next = prompt("New password for " + user.username);
                    if (next) void act(`/api/users/${user.id}/reset-password`, "POST", {
                      password: next,
                    });
                  }}
                >
                  Reset password
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    if (confirm(`Delete ${user.username}? Their items and claims will be removed.`)) {
                      void act(`/api/users/${user.id}`, "DELETE");
                    }
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Create user</h3>
      <form className="item-form" onSubmit={createUser}>
        <div className="field-row">
          <div className="field grow">
            <label htmlFor="new-username">Username</label>
            <input
              id="new-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div className="field grow">
            <label htmlFor="new-display-name">Display name</label>
            <input
              id="new-display-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="new-password">Password</label>
            <input
              id="new-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
          Admin
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create user"}
        </button>
      </form>
    </section>
  );
}