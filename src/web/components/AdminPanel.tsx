import { useState, type FormEvent } from "react";
import type { AdminUser } from "../../shared/types";
import { S } from "../strings";
import { useConfirm } from "../confirm";
import { useToast } from "../toast";

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
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const confirm = useConfirm();
  const toast = useToast();

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
        setError(body?.error ?? S.admin.createFailed);
        return;
      }
      setUsername("");
      setDisplayName("");
      setPassword("");
      setIsAdmin(false);
      await onChanged();
    } catch {
      setError(S.admin.networkError);
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
      setError(parsed?.error ?? S.admin.requestFailed);
      return false;
    }
    await onChanged();
    return true;
  }

  async function actFor(userId: string, path: string, method = "POST", body?: unknown) {
    setBusyId(userId);
    try {
      return await act(path, method, body);
    } finally {
      setBusyId(null);
    }
  }

  async function submitReset(e: FormEvent, userId: string) {
    e.preventDefault();
    if (!resetPassword.trim()) return;
    const ok = await actFor(userId, `/api/users/${userId}/reset-password`, "POST", { password: resetPassword });
    if (ok) {
      toast(S.admin.passwordReset);
      setResettingId(null);
      setResetPassword("");
    }
  }

  async function deleteUser(user: AdminUser) {
    const ok = await confirm({
      title: S.admin.deleteUserConfirm(user.username),
      body: S.admin.deleteUserBody,
    });
    if (ok) {
      const done = await actFor(user.id, `/api/users/${user.id}`, "DELETE");
      if (done) toast(S.admin.userDeleted);
    }
  }

  return (
    <section className="admin-panel">
      <h2>{S.admin.users}</h2>

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>{S.admin.name}</th>
              <th>{S.admin.username}</th>
              <th>{S.admin.status}</th>
              <th>{S.admin.actions}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.displayName}</td>
                <td>{user.username}</td>
                <td>
                  {user.isAdmin ? S.admin.adminRole : S.admin.userRole}
                  {user.isActive ? "" : S.admin.inactiveSuffix}
                </td>
                <td className="admin-actions">
                  {user.isActive ? (
                    <button
                      className={busyId === user.id ? "secondary is-busy" : "secondary"}
                      disabled={busyId === user.id}
                      onClick={() => void actFor(user.id, `/api/users/${user.id}/deactivate`)}
                    >
                      {S.admin.deactivate}
                    </button>
                  ) : (
                    <button
                      className={busyId === user.id ? "secondary is-busy" : "secondary"}
                      disabled={busyId === user.id}
                      onClick={() => void actFor(user.id, `/api/users/${user.id}/activate`)}
                    >
                      {S.admin.activate}
                    </button>
                  )}
                  <button
                    className="secondary"
                    onClick={() => {
                      setResettingId(resettingId === user.id ? null : user.id);
                      setResetPassword("");
                    }}
                  >
                    {S.admin.resetPassword}
                  </button>
                  <button
                    className={busyId === user.id ? "danger is-busy" : "danger"}
                    disabled={busyId === user.id}
                    onClick={() => void deleteUser(user)}
                  >
                    {S.admin.delete}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {resettingId && (
        <form className="reset-form" onSubmit={(e) => submitReset(e, resettingId)}>
          <label htmlFor="reset-password">{S.admin.newPasswordFor}</label>
          <div className="reset-form-row">
            <input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              placeholder={S.admin.passwordPlaceholder}
              required
            />
            <button type="submit" disabled={!resetPassword.trim()}>
              {S.admin.setPassword}
            </button>
            <button type="button" className="secondary" onClick={() => setResettingId(null)}>
              {S.form.cancel}
            </button>
          </div>
        </form>
      )}

      <h3>{S.admin.createUser}</h3>
      <form className="item-form" onSubmit={createUser}>
        <div className="field-row">
          <div className="field grow">
            <label htmlFor="new-username">{S.admin.username}</label>
            <input
              id="new-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div className="field grow">
            <label htmlFor="new-display-name">{S.admin.displayName}</label>
            <input
              id="new-display-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="new-password">{S.admin.password}</label>
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
          {S.admin.isAdmin}
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? S.admin.creating : S.admin.createUser}
        </button>
      </form>
    </section>
  );
}