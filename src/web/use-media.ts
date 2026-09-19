import { useEffect, useState } from "react";

/** Live media-query subscription. Mirrors the exact pattern the responsive
 *  components already use (ShareMenu / OverflowMenu / ListSwitcher), but
 *  shared so AppPage can branch once for the whole action cluster (#73) —
 *  the app must render exactly ONE Add/Share cluster per width, not two
 *  hidden ones (duplicate DOM breaks Playwright strict mode and screen
 *  readers alike).
 *
 *  The initial value reads the match synchronously; the effect re-reads it
 *  once on mount too, so a resize that lands between render and effect is
 *  adopted rather than missed. */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange(); // adopt the live value in case it moved since init
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
