import { useState, type FormEvent } from "react";
import type { AdminUser } from "../../shared/types";
import { S } from "../strings";
import { classifyResponse, classifyWriteFailure } from "../net";
import { useConfirm } from "../confirm";
import { useToast } from "../toast";

interface AdminPanelProps {
  users: AdminUser[];
  onChanged: () => void | Promise<void>;
}

/** #96: the users table + inline reset-password form only. The create-user
 *  form moved to its own screen (/settings/users/new); the panel keeps its
 *  {users, onChanged} contract and surfaces action failures (the last-admin
 *  409 among them) in the same alert paragraph the form used to carry. */
export function AdminPanel({ users, onChanged }: AdminPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const confirm = useConfirm();
  const toast = useToast();

  async function act(path: string, method = "POST", body?: unknown) {
    setError(null);
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // #117: a rejected fetch never reaches the branch below, and it is the
      // connection, not the request, that failed.
      const kind = classifyWriteFailure(err);
      setError(kind === "offline" ? S.offline.write : S.admin.networkError);
      return false;
    }
    if (!res.ok) {
      // #117: the SW's own {error:"offline"} body is internal copy — the
      // offline framing replaces it, while every real server message stays.
      const kind = await classifyResponse(res);
      if (kind === "offline") {
        setError(S.offline.write);
        return false;
      }
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

      {error && <p className="error" role="alert">{error}</p>}

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
    </section>
  );
}