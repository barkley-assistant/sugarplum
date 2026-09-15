import { useState, type FormEvent } from "react";
import { S } from "../strings";

/** Open-redirect guard: only follow a same-site relative path. The
 *  share-target prefill fix uses /login?next=<encoded path>; any other
 *  shape (absolute URL, protocol-relative `//evil.example`, empty) falls
 *  back to the home shell. */
function safeNext(raw: string | null): string {
  if (!raw) return "/";
  if (raw.length > 512) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//")) return "/";
  return raw;
}

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
        // Honor ?next= for the share-target carry-through; the safeNext guard
        // blocks open redirects via `//attacker.example` etc.
        const next = safeNext(
          new URLSearchParams(location.search).get("next"),
        );
        location.href = next;
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
        <div className="auth-lockup">
          <img src="/assets/brand/icon.png" alt="" />
          <h1>{S.app.name}</h1>
          <p className="muted">{S.app.tagline}</p>
        </div>

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