import { existsSync } from "node:fs";

/**
 * Public liveness probe + capability status. The `stealth` field reports
 * whether the stealth-browser scrape capability is actually wired in THIS
 * deployment (its venv python exists at boot): the 2026-11-13 Etsy incident
 * was invisible for a month because a deployment lost the venv and every
 * bot-walled scrape degraded to plain-only with no surface showing it.
 * One word, no internals — operators (and tests) can alarm on it.
 */
export function healthRoutes(deps: { stealthPythonBin?: string } = {}) {
  const stealth =
    deps.stealthPythonBin !== undefined && existsSync(deps.stealthPythonBin)
      ? "ok"
      : "unavailable";
  return {
    "/api/health": {
      GET: () =>
        new Response(JSON.stringify({ status: "ok", stealth }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
  };
}
