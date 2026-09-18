import { useEffect, useRef } from "react";

/** Focuses a page's heading when its CONTENT mounts — not when the page
 *  mounts, which is why the caller passes a readiness dep (at mount only the
 *  skeleton exists and the ref is still null). Gives the route change a
 *  screen-reader announcement without popping a keyboard (only form fields
 *  pop keyboards, and the ref is on an h1/h2) and without a scroll jump
 *  (preventScroll — navigate() already scrolled to the top). */
export function usePageFocus(dep: unknown) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [dep]);
  return ref;
}
