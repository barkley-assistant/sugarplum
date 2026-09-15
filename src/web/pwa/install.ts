import { useCallback, useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Restrained install affordance (D: no banners). Captures
 *  beforeinstallprompt and exposes a user-initiated prompt() call; the
 *  entry simply never renders when the event does not fire (already
 *  installed, unsupported browser, iOS). */
export function useInstallPrompt(): { canInstall: boolean; promptInstall: () => void } {
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    function onPrompt(e: Event) {
      e.preventDefault();
      setEvent(e as BeforeInstallPromptEvent);
    }
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const promptInstall = useCallback(() => {
    if (!event) return;
    void event.prompt();
    // The browser fires beforeinstallprompt only once per engagement; hide
    // the entry after the user acts so it does not linger.
    void event.userChoice.then(() => setEvent(null));
  }, [event]);

  return { canInstall: event !== null, promptInstall };
}