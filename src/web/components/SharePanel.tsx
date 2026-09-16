import { useEffect, useState } from "react";
import type { ShareLinkResponse } from "../../shared/types";
import { S } from "../strings";
import { useToast } from "../toast";
import { useConfirm } from "../confirm";

/** Owner-side share-link manager: shows the active link, copies it, rotates
 *  it and revokes it. The URL is composed client-side (location.origin +
 *  path) because only the client knows the public origin. */
export function SharePanel() {
  const [link, setLink] = useState<ShareLinkResponse | null>(null);
  const [busyOp, setBusyOp] = useState<"create" | "revoke" | null>(null);
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/share");
        if (res.ok) setLink((await res.json()) as ShareLinkResponse);
      } catch {
        // Panel simply shows the create button when the state is unknown.
      }
    })();
  }, []);

  async function create() {
    if (link?.token) {
      const ok = await confirm({
        title: S.share.regenerateConfirmTitle,
        body: S.share.regenerateConfirmBody,
        confirmLabel: S.share.regenerate,
        danger: false,
      });
      if (!ok) return;
    }
    setBusyOp("create");
    try {
      const res = await fetch("/api/share", { method: "POST" });
      if (!res.ok) throw new Error();
      setLink((await res.json()) as ShareLinkResponse);
      setCopied(false);
    } catch {
      toast(S.errors.generic, "danger");
    } finally {
      setBusyOp(null);
    }
  }

  async function revoke() {
    const ok = await confirm({
      title: S.share.revokeConfirmTitle,
      body: S.share.revokeConfirmBody,
      confirmLabel: S.share.revoke,
    });
    if (!ok) return;
    setBusyOp("revoke");
    try {
      const res = await fetch("/api/share", { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error();
      setLink({ token: null, path: null });
    } catch {
      toast(S.errors.generic, "danger");
    } finally {
      setBusyOp(null);
    }
  }

  async function copy() {
    if (!link?.path) return;
    const url = `${location.origin}${link.path}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the read-only input below is the
      // fallback — the user can select it manually.
    }
  }

  const hasLink = link?.token != null;
  const busy = busyOp !== null;
  const url = `${location.origin}${link?.path ?? ""}`;
  return (
    <div className="share-panel">
      <h3>{S.share.shareTitle}</h3>
      <p className="muted">{S.share.shareIntro}</p>
      {hasLink && (
        <div className="share-link-row">
          <input readOnly value={url} aria-label={S.share.shareTitle} onFocus={(e) => e.currentTarget.select()} />
          <button className="secondary" onClick={() => void copy()}>
            {copied ? S.share.copied : S.share.copyLink}
          </button>
        </div>
      )}
      <div className="share-actions">
        <button className={busy ? "primary is-busy" : "primary"} onClick={() => void create()} disabled={busy}>
          {busyOp === "create" ? S.share.creating : hasLink ? S.share.regenerate : S.share.createLink}
        </button>
        {hasLink && (
          <button className={busy ? "danger is-busy" : "danger"} onClick={() => void revoke()} disabled={busy}>
            {busyOp === "revoke" ? S.share.revoking : S.share.revoke}
          </button>
        )}
      </div>
    </div>
  );
}
