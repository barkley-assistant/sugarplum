#!/usr/bin/env python3
"""Stealth fetch: load a bot-walled product page via invisible_playwright.

stdout: exactly ONE JSON object (see .hermes/plans/wave13-overrides.md §Contracts).
Everything else goes to stderr. Exit 0 whenever a JSON verdict was printed.

This is a TRANSPORT helper — it returns raw HTML; the actual product
extraction stays in the Bun pipeline (one tested extractor in parse.ts).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import signal
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

# Markers of an Imperva Incapsula / Distil challenge interstitial. Consulted
# on the lowercased first 4 KB of html; same approach as fetch.ts.
CHALLENGE_MARKERS = ("_incapsula_resource", "distil_referrer")


class ScrapeTimeout(Exception):
    """Raised by the alarm watchdog so the with-block unwinds cleanly."""


def _on_alarm(signum, frame):  # noqa: ARG001 - signal handler signature
    raise ScrapeTimeout()


def _on_term(signum, frame):  # noqa: ARG001 - signal handler signature
    # Exit through SystemExit so the with-block __exit__ reaps the browser
    # tree before the process dies. The caller sees exit 3 — never a
    # JSON verdict — and maps it to network/stealth-exit-3.
    raise SystemExit(3)


def hostname_of(url: str) -> str | None:
    try:
        host = urlparse(url).hostname or ""
    except Exception:
        return None
    host = host.lower()
    if host.startswith("www."):
        host = host[4:]
    return host or None


def stable_seed(host: str) -> int:
    """int31 seed (Firefox stealth prefs are int32_t; high bit risks negative)."""
    return int.from_bytes(hashlib.sha256(host.encode()).digest()[:4], "big") & 0x7FFF_FFFF


def profile_dir_for(base: Path, host: str) -> Path:
    """Sanitize the hostname for use as a directory name; create parents."""
    safe = re.sub(r"[^a-z0-9.-]", "", host.lower()) or "unknown"
    target = base / safe
    target.mkdir(parents=True, exist_ok=True)
    return target


def html_looks_challenged(sample: str) -> bool:
    lower = sample[:4096].lower()
    return any(marker in lower for marker in CHALLENGE_MARKERS)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Stealth-fetch a URL via invisible_playwright; print JSON verdict."
    )
    parser.add_argument("url", help="Page to load")
    parser.add_argument(
        "--timeout-ms",
        type=int,
        default=60000,
        help="Whole-scrape budget (launch + goto + challenge wait). Default 60000.",
    )
    parser.add_argument(
        "--challenge-wait-ms",
        type=int,
        default=25000,
        help="How long to keep sampling after goto while the page still looks "
             "like an Incapsula interstitial. Default 25000.",
    )
    parser.add_argument(
        "--profiles-dir",
        default="./data/stealth-profiles",
        help="Parent dir for per-host Firefox profiles. Default ./data/stealth-profiles.",
    )
    args = parser.parse_args()

    host = hostname_of(args.url)
    if host is None:
        print(json.dumps({"ok": False, "reason": "error", "detail": "bad url"}), flush=True)
        return 0

    # SIGTERM (parent's escalation): raise SystemExit so the with-block
    # __exit__ still runs — invisible_playwright reaps Firefox+Xvfb in
    # teardown (Linux has no kernel kill-on-exit for the browser tree).
    signal.signal(signal.SIGTERM, _on_term)
    signal.signal(signal.SIGINT, _on_term)

    # Watchdog: fires ceil(timeout_ms/1000) seconds from now. SIGALRM is
    # always delivered to this process even if the browser tree is wedged.
    alarm_seconds = max(1, math.ceil(args.timeout_ms / 1000))
    signal.signal(signal.SIGALRM, _on_alarm)
    signal.alarm(alarm_seconds)

    # Import AFTER arg parsing so bad args fail fast without spinning up
    # invisible_playwright.
    from invisible_playwright import InvisiblePlaywright  # type: ignore

    profile_dir = profile_dir_for(Path(args.profiles_dir), host)
    remaining_ms = args.timeout_ms
    # Bound the goto/page-load timeout well below the alarm budget so
    # playwright's own TimeoutError lands inside the error-verdict path
    # instead of racing the SIGALRM alarm — when the two fire at the
    # same instant, the alarm's unwind wedges the playwright sync driver
    # and the helper hangs forever with no JSON on stdout.
    goto_timeout_ms = max(1000, remaining_ms - 3000)

    try:
        with InvisiblePlaywright(
            seed=stable_seed(host),
            headless=True,
            extra_args=["--no-sandbox", "--disable-dev-shm-usage"],
            profile_dir=profile_dir,
        ) as ctx:
            page = ctx.new_page()
            resp = page.goto(args.url, wait_until="domcontentloaded", timeout=goto_timeout_ms)
            status = resp.status if resp is not None else None

            if resp is not None and status is not None and status >= 400:
                # Body short, just enough to decide. Avoid the full poll loop.
                html = page.content()
                print(json.dumps({
                    "ok": False,
                    "reason": "http",
                    "status": status,
                }), flush=True)
                return 0

            # Poll the body until the challenge markers are gone, or the
            # challenge-wait budget runs out.
            html = page.content()
            deadline = time.monotonic() + (args.challenge_wait_ms / 1000.0)
            poll_seconds = 1.0
            while html_looks_challenged(html) and time.monotonic() < deadline:
                time.sleep(poll_seconds)
                html = page.content()

            verdict = {
                "ok": True,
                "html": html,
                "finalUrl": page.url,
                "status": status,
            }
            if html_looks_challenged(html):
                # Surface the verdict truthfully; Bun's detectBotWall will
                # still upgrade it to botwall + heuristic incapsula.
                verdict = {"ok": False, "reason": "challenged"}
            print(json.dumps(verdict), flush=True)
            return 0
    except ScrapeTimeout:
        # SIGALRM fired (launch wedged past the budget, or the alarm slipped
        # in during the challenge-wait poll). The graceful `return 0`
        # unwinds through the with-block __exit__, which can wedge on a
        # stuck Firefox/Xvfb tree — print the verdict, flush, and die
        # hard so the parent sees a definite exit.
        sys.stdout.write(json.dumps({"ok": False, "reason": "timeout"}) + "\n")
        sys.stdout.flush()
        os._exit(0)
    except SystemExit:
        # SIGTERM path: the with-block already unwound (library teardown
        # reaped Firefox+Xvfb). Exit quietly without printing JSON — the
        # caller maps a non-zero exit to stealth-exit-3.
        raise
    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "reason": "error",
            "detail": str(exc)[:300],
        }), flush=True)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
