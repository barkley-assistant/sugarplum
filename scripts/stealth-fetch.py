#!/usr/bin/env python3
"""Stealth fetch: load a bot-walled product page via invisible_playwright.

stdout: exactly ONE JSON object (see .hermes/plans/wave13-overrides.md §Contracts).
Everything else goes to stderr. Exit 0 whenever a JSON verdict was printed.

This is a TRANSPORT helper — it returns raw HTML; the actual product
extraction stays in the Bun pipeline (one tested extractor in parse.ts).

BLOCKING 2 (wave 13 round 2): Xvfb orphan reaper
=================================================
invisible_core spawns Xvfb with start_new_session=True (a NEW process group),
so the parent's group-kill (process.kill(-helper_pid, ...)) never reaches it.
Without intervention, every hard escalation leaks ~67MB + a display number
and ~300 escalations exhaust Xvfb's :99-:399 range.

Remedy:
1. SIGTERM handler does `os._exit(3)` directly — no graceful unwind that
   can wedge. invisible_playwright's `with`-block teardown is no longer on
   the SIGTERM path.
2. Inside the with-block (where DISPLAY is set), the helper forks a
   DETACHED Xvfb reaper (`spawn_xvfb_reaper`). The reaper does
   `os.setsid()` so it becomes its own session leader — completely
   outside the helper's process group, so the parent's group-kill cannot
   reach it. It waits for the helper's pid to die (any cause: normal
   exit, SIGTERM, SIGKILL, exception), then kills any Xvfb process
   matching the helper's DISPLAY number (e.g. ':99'). Linux has no
   kernel kill-on-exit for the browser tree; this is the only thing
   that reaps an Xvfb orphan after the helper is gone.
3. The reaper is safe: it only kills Xvfb whose cmdline contains the
   EXACT display number from the helper's DISPLAY env var. No blanket
   pkill — a different display (':100') is left alone, a non-Xvfb
   process with ':99' in its cmdline is left alone.

`--xvfb-reap-test` mode runs `reap_xvfb_by_display` synchronously with
mocked scan/kill so the logic is unit-testable from Bun tests without a
real browser.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import signal
import subprocess
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
    # BLOCKING 2 fix: exit HARD without unwinding through the with-block.
    # The with-block __exit__ invokes invisible_playwright's teardown
    # (Firefox subprocess + invisible_core process-group kill) which can
    # wedge forever on a stuck helper. The Xvfb orphan reaper (spawned
    # inside the with-block; see spawn_xvfb_reaper) is detached from
    # this process's group and survives our death — it kills any
    # orphaned Xvfb matching our DISPLAY.
    #
    # Do NOT print JSON here: a JSON verdict on exit 3 would suggest a
    # managed outcome, and the caller maps exit 3 to stealth-exit-3.
    os._exit(3)


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


# ─────────────────────────────────────────────────────────────────────────────
# Xvfb orphan reaper — module-level so tests can exercise it directly.
# ─────────────────────────────────────────────────────────────────────────────

def _default_scan_ps() -> list[tuple[int, str]]:
    """Scan `ps -eo pid=,args=` and return [(pid, cmdline)] for every process.

    The `pid=` (no header) form keeps the output parseable across distros.
    Failures (ps missing, timeout) return []; the caller treats that as a
    no-op rather than a fatal error — the reaper is best-effort defense,
    not a correctness gate.

    Test seam: setting `__SUGARPLUM_FAKE_PS_OUTPUT` to a JSON array of
    `[pid, cmdline]` tuples short-circuits the real ps call. Used by the
    live reaper integration test to exercise the matching logic without
    requiring a real Xvfb on the test host (and without killing it)."""
    fake = os.environ.get("__SUGARPLUM_FAKE_PS_OUTPUT", "")
    if fake:
        try:
            data = json.loads(fake)
            return [(int(item[0]), str(item[1])) for item in data]
        except Exception:
            return []
    try:
        r = subprocess.run(
            ["ps", "-eo", "pid=,args="],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return []
    out: list[tuple[int, str]] = []
    for line in r.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) < 2:
            continue
        try:
            pid = int(parts[0])
        except ValueError:
            continue
        out.append((pid, parts[1]))
    return out


def _default_kill_sigkill(pid: int) -> None:
    """SIGKILL the pid. EPERM/ESRCH are swallowed — we only care that the
    process is gone.

    Test seam: setting `__SUGARPLUM_FAKE_KILL_RECORD` to a file path
    appends each pid we are ASKED to kill (one per line) to that file,
    AND still SIGKILLs the pid. The live reaper integration test uses
    this to record which pids the reaper targeted without ever
    requiring a real Xvfb process to be present. The pid argument is
    what the reaper actually wants to kill — if the pid does not exist
    on the test host, the SIGKILL raises ESRCH, which we swallow (same
    path as a real reap that finds nothing)."""
    rec = os.environ.get("__SUGARPLUM_FAKE_KILL_RECORD", "")
    if rec:
        try:
            with open(rec, "a", encoding="utf-8") as fh:
                fh.write(f"{pid}\n")
        except Exception:
            pass
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass


def _is_xvfb_for_display(cmdline: str, display_num: str) -> bool:
    """Match ONLY Xvfb processes whose cmdline targets the given display
    number. Never blanket-pkill.

    An entry matches iff:
      - cmdline contains the literal token "Xvfb" (the binary name), AND
      - cmdline contains `:NNN` where NNN == display_num (the display arg
        Xvfb was started with), AND
      - the binary path resolves to a basename ending in "Xvfb" (so we
        don't kill e.g. an `Xvfb-wrapper.sh` or a grep over Xvfb args).
    """
    if not cmdline:
        return False
    if display_num and f":{display_num}" not in cmdline:
        return False
    # The first whitespace-delimited token is argv[0]. The basename of
    # argv[0] must end in "Xvfb" (covers /usr/bin/Xvfb, ./Xvfb, Xvfb,
    # but NOT "my-Xvfb-helper" — basename match is exact-equal so
    # things like "Xvfb-launcher" are also rejected, which is what we
    # want).
    first = cmdline.split(None, 1)[0]
    base = os.path.basename(first)
    return base == "Xvfb"


def reap_xvfb_by_display(
    display: str,
    *,
    scan_fn=None,
    kill_fn=None,
) -> list[int]:
    """Kill Xvfb processes whose cmdline matches `display` (e.g. ':99').

    scan_fn: () -> [(pid, cmdline)] — injectable for tests. Defaults to
        `ps -eo pid=,args=`.
    kill_fn: (pid) -> None — injectable for tests. Defaults to SIGKILL.

    Returns the list of pids that were killed (a pid is reported only if
    the kill did not raise; ESRCH/EPERM are treated as "already gone").

    SAFETY:
      - NEVER blanket-pkill (no `pkill Xvfb`): every match is per-pid,
        and the cmdline filter (`_is_xvfb_for_display`) demands both the
        Xvfb basename AND the exact display number from this helper's
        DISPLAY env. An unrelated Xvfb on `:100`, or a non-Xvfb process
        with `Xvfb` in its args, is left alone.
      - Empty `display` → empty list (no scan). Invalid display (no
        numeric suffix) → empty list.
    """
    killed: list[int] = []
    if not display:
        return killed
    display_num = display.lstrip(":")
    if not display_num or not display_num.isdigit():
        return killed
    scan = scan_fn if scan_fn is not None else _default_scan_ps
    kill = kill_fn if kill_fn is not None else _default_kill_sigkill
    for pid, cmdline in scan():
        if not _is_xvfb_for_display(cmdline, display_num):
            continue
        try:
            kill(pid)
            killed.append(pid)
        except Exception:
            # EPERM / ESRCH / etc. — process is already gone or not ours.
            pass
    return killed


def spawn_xvfb_reaper(
    parent_pid: int,
    *,
    poll_budget_seconds: float | None = None,
) -> int | None:
    """Fork a DETACHED child that waits for `parent_pid` to die, then reaps
    any orphaned Xvfb tied to the parent's DISPLAY.

    Detach semantics:
      - The child calls `os.setsid()` so it becomes its own session
        leader and process-group leader. This severs it from the
        parent's group, which is what the parent's group-kill
        (`process.kill(-parent_pid, sig)`) targets. The reaper survives
        SIGKILL of the parent.
      - The child inherits the parent's env at fork time, including
        DISPLAY. Callers MUST fork AFTER `invisible_playwright` has set
        DISPLAY (typically right after entering the
        `InvisiblePlaywright` with-block).

    The reaper's loop:
      - poll `os.kill(parent_pid, 0)` until the parent dies. The wait
        is UNBOUNDED in production — the helper's own SIGALRM bounds
        it in practice (the helper can't run for longer than its alarm
        budget anyway), and a long-running stealth scrape is
        legitimate, so the reaper MUST NOT race the parent.
      - on OBSERVED parent death, run
        `reap_xvfb_by_display(os.environ["DISPLAY"])`. On budget
        exhaustion (test-only path), the reaper exits WITHOUT calling
        reap — calling reap on a live parent is the r3 bug we're
        fixing: it SIGKILLed the live helper's Xvfb at t=120 whenever
        SUGARPLUM_STEALTH_TIMEOUT_MS exceeded ~120000.
      - exit

    `poll_budget_seconds` (test seam only): when set, the loop exits
    after that many seconds if the parent has not died yet. The
    reaper does NOT reap on budget exhaustion. PRODUCTION CALLERS MUST
    PASS None (the default) — the only reason this knob exists is to
    let tests exercise the "budget exhausted + parent alive → no kill"
    semantics without sleeping for 120s of real time.

    Returns the reaper's pid (the parent continues immediately), or
    None if DISPLAY is unset / fork fails.
    """
    display = os.environ.get("DISPLAY", "")
    if not display:
        return None
    try:
        pid = os.fork()
    except OSError:
        return None
    if pid > 0:
        # Parent (the stealth helper). Return immediately — the scrape
        # continues. The reaper will outlive us.
        return pid
    # Child: become session leader so the parent's group-kill can't
    # reach us. PID namespace is unchanged so /proc/<parent_pid> still
    # works for the poll loop.
    try:
        os.setsid()
    except OSError:
        os._exit(0)
    try:
        # Wait for the parent to die. Production default (None) is
        # unbounded — the helper's own SIGALRM bounds the wait in
        # practice. The previous 120s hard deadline was removed in r3
        # because it SIGKILLed a still-running parent's Xvfb whenever
        # the helper legitimately outlived the budget
        # (SUGARPLUM_STEALTH_TIMEOUT_MS > ~120000).
        deadline = (
            time.monotonic() + poll_budget_seconds
            if poll_budget_seconds is not None
            else None
        )
        parent_died = False
        while True:
            if deadline is not None and time.monotonic() >= deadline:
                # Budget exhausted with parent still alive — DO NOT
                # reap. The parent owns this Xvfb and may still be
                # using it. This branch is reachable only on the
                # test-only `poll_budget_seconds` path.
                break
            try:
                os.kill(parent_pid, 0)
            except OSError:
                # Parent is gone — reaping time.
                parent_died = True
                break
            time.sleep(0.5)
        if parent_died:
            # Best-effort reap. Empty list is fine; it's the normal-exit
            # case where the with-block teardown already cleaned up.
            reap_xvfb_by_display(display)
    except Exception:
        # Never let the reaper crash — it has no observer and no
        # recovery path. Silent best-effort is the design.
        pass
    os._exit(0)


def _run_xvfb_reap_test(args: argparse.Namespace) -> int:
    """Synchronous reaper-mode for tests. Reads scan mock from
    --scan-json-file (a JSON list of [pid, cmdline] tuples), runs the
    reaper with that mock and an in-memory kill recorder, prints the
    result as JSON, and exits 0.

    Tests inject:
      - scan_fn: returns the contents of the mock file
      - kill_fn: appends each pid it was asked to kill to
        --kill-record-file (one pid per line) so the test can assert
        which pids were targeted.

    --display is required and is the display we pretend the helper was
    using. The test exercises the matching logic; the fork/setsid path
    is covered by the BLOCKING-2 live integration test."""
    display = args.display or ""
    killed_pids: list[int] = []

    def mock_scan() -> list[tuple[int, str]]:
        if not args.scan_json_file:
            return []
        with open(args.scan_json_file, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return [(int(item[0]), str(item[1])) for item in data]

    def mock_kill(pid: int) -> None:
        killed_pids.append(pid)
        if args.kill_record_file:
            with open(args.kill_record_file, "a", encoding="utf-8") as fh:
                fh.write(f"{pid}\n")

    matched = reap_xvfb_by_display(display, scan_fn=mock_scan, kill_fn=mock_kill)
    print(
        json.dumps(
            {
                "display": display,
                "matched": matched,
                "killed": killed_pids,
            }
        ),
        flush=True,
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Stealth-fetch a URL via invisible_playwright; print JSON verdict."
    )
    parser.add_argument("url", nargs="?", help="Page to load (not required for --xvfb-reap-test)")
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
    # ── Test seam: synchronous reaper exercise (no fork, no invisible_playwright)
    parser.add_argument(
        "--xvfb-reap-test",
        action="store_true",
        help=argparse.SUPPRESS,  # internal — tests only
    )
    parser.add_argument(
        "--display",
        default="",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--scan-json-file",
        default="",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--kill-record-file",
        default="",
        help=argparse.SUPPRESS,
    )
    args = parser.parse_args()

    if args.xvfb_reap_test:
        return _run_xvfb_reap_test(args)

    host = hostname_of(args.url)
    if host is None:
        print(json.dumps({"ok": False, "reason": "error", "detail": "bad url"}), flush=True)
        return 0

    # SIGTERM (parent's escalation): os._exit(3) directly. No graceful
    # unwind through the with-block — the Xvfb orphan reaper is detached
    # and handles browser-tree cleanup on our death.
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
            # Fork the Xvfb orphan reaper IMMEDIATELY after the
            # with-block enters. By now invisible_playwright has set
            # DISPLAY and spawned Xvfb, so the reaper inherits a valid
            # DISPLAY in its env. The reaper is the leader of a new
            # session (setsid), so it survives the parent's group-kill.
            # When this helper dies (any cause: normal exit, SIGTERM,
            # SIGKILL, exception), the reaper kills any orphaned Xvfb
            # tied to our display. Linux has no kernel kill-on-exit
            # for the browser tree, so this is the ONLY thing that
            # reaps Xvfb across a hard escalation.
            spawn_xvfb_reaper(os.getpid())

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
        # hard so the parent sees a definite exit. The reaper is
        # detached and will reap the Xvfb orphan on our death.
        sys.stdout.write(json.dumps({"ok": False, "reason": "timeout"}) + "\n")
        sys.stdout.flush()
        os._exit(0)
    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "reason": "error",
            "detail": str(exc)[:300],
        }), flush=True)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
