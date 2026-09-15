import { useState, type FormEvent } from "react";
import { S } from "../strings";

export function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.status === 200) {
        // Full navigation so the session cookie applies to the shell fetch.
        location.href = "/";
        return;
      }
      if (res.status === 429) {
        setError(S.auth.tooManyAttempts);
      } else if (res.status === 400) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? S.auth.signInFailed);
      } else {
        setError(S.auth.invalidCredentials);
      }
    } catch {
      setError(S.auth.networkError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <form className="card auth-card" onSubmit={submit}>
        <h1>{S.app.name}</h1>
        <p className="muted">{S.app.tagline}</p>

        <label htmlFor="username">{S.auth.username}</label>
        <input
          id="username"
          type="text"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />

        <label htmlFor="password">{S.auth.password}</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        {error && <p className="error" role="alert">{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? S.auth.signingIn : S.auth.signIn}
        </button>
      </form>
    </main>
  );
}