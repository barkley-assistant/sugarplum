import { useEffect, useState, type FormEvent } from "react";
import { S } from "../strings";
import { navigate, safeNext } from "../router";
import { AuthSkeleton } from "./Skeletons";

/** In-SPA login view (the /login route). Renders the same form it always
 *  did; the difference is transport — successful sign-in is a pushState,
 *  never a document load. On mount it asks the server whether this browser
 *  already has a session: a 200 means the user is already signed in and must
 *  land on the app instead of a dead form (INV-6). The check hits the
 *  server, not the localStorage identity cache, because a stale cached
 *  identity would present a dead session as valid. */
export function LoginView() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [authCheck, setAuthCheck] = useState<"checking" | "anonymous">("checking");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/me");
        if (!cancelled && res.ok) {
          // replace: Back from the app must not land on /login, which would
          // immediately bounce forward again.
          navigate(safeNext(new URLSearchParams(location.search).get("next")), { replace: true });
          return;
        }
      } catch {
        // Offline → show the form; the submit path surfaces any error.
      }
      if (!cancelled) setAuthCheck("anonymous");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
        // Honor ?next= for the share-target carry-through; safeNext blocks
        // open redirects via `//attacker.example` etc.
        navigate(safeNext(new URLSearchParams(location.search).get("next")));
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

  if (authCheck === "checking") {
    return <AuthSkeleton />;
  }

  return (
    <main className="auth-page">
      <form className="card auth-card" onSubmit={submit}>
        <div className="auth-lockup">
          <img src="/assets/brand/sugarplum-icon.png" alt="" />
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

        <button type="submit" className="settings-submit" disabled={busy}>
          {busy ? S.auth.signingIn : S.auth.signIn}
        </button>
      </form>
    </main>
  );
}
