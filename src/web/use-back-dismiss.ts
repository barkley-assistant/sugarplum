import { useEffect, useRef } from "react";

/** #72: makes an overlay dismissible by the app back button (browser /
 *  Android back). On mount it pushes a same-URL sentinel history entry; a
 *  popstate (= back) while mounted closes via `onClose`; any OTHER unmount
 *  (Escape, overlay click, a code-driven state reset) consumes the sentinel
 *  with one guarded history.back() so no dead back press is left behind.
 *
 *  The URL never changes, so the SPA router neither re-renders a different
 *  view nor scrolls: useRoute re-parses the same path to an equal route.
 *
 *  Assumes the consumer is the topmost surface (nothing can be opened on top
 *  of it), which is why no "am I topmost" check is needed. Also assumes no
 *  StrictMode double-mount (app.tsx renders without it) — a double mount
 *  would push two sentinels. */
export function useBackDismiss(onClose: () => void): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    let closedByBack = false;
    history.pushState({ sugarplum: "sheet" }, "", location.href);
    function onPopState() {
      closedByBack = true;
      onCloseRef.current();
    }
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      // Pop only OUR sentinel, and only if back did not already do it: without
      // the guard a second unmount path could traverse past the sentinel and
      // out of the app entirely.
      const state = history.state as { sugarplum?: string } | null;
      if (!closedByBack && state?.sugarplum === "sheet") history.back();
    };
  }, []);
}
