import { useEffect, useState } from "react";
import type { Me } from "../shared/types";
import { navigate } from "./router";
import { readStoredMe, writeStoredMe } from "./me-store";
import { S } from "./strings";

export type BootMe =
  | { status: "loading" }
  | { status: "ready"; me: Me }
  /** Last-known identity, network dead — the SW-cached bytes still render. */
  | { status: "offline"; me: Me }
  /** No session AND no cached identity. */
  | { status: "error"; message: string };

/** The authed-page boot ladder every owner route needs (#62 D4): a 401 hops
 *  to the SPA login carrying this page's full path+search as `?next=`, so a
 *  share-target `/add?url=…` prefill survives the login round trip (INV-A).
 *  Any non-401 failure falls back to the last-known identity so the
 *  SW-cached list bytes still render (the offline contract the feed has).
 *  Only /api/auth/me decides whether there IS a session — the cache is
 *  presentation state, never a session. */
export function useBootMe(): BootMe {
  const [state, setState] = useState<BootMe>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/me");
        if (res.status === 401) {
          // A 401 is authoritative: even with a cached identity, bounce.
          const here = location.pathname + location.search;
          navigate(`/login?next=${encodeURIComponent(here)}`);
          return; // this route unmounts; nothing else to do
        }
        if (!res.ok) throw new Error("boot-failed");
        const me = (await res.json()) as Me;
        if (cancelled) return;
        writeStoredMe(me);
        setState({ status: "ready", me });
      } catch {
        const stored = readStoredMe();
        if (cancelled) return;
        if (stored) setState({ status: "offline", me: stored });
        else setState({ status: "error", message: S.errors.loadWishlist });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
