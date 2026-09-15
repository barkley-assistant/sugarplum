"""Spawn the Xvfb reaper from a fresh Python process, then exit hard.

Used by tests/stealth.test.ts to exercise spawn_xvfb_reaper end-to-end
without spinning up a real invisible_playwright. The script:
  1. Imports scripts/stealth-fetch.py as a module.
  2. Sets up the test-only env seams (__SUGARPLUM_FAKE_PS_OUTPUT,
     __SUGARPLUM_FAKE_KILL_RECORD) and DISPLAY=:99.
  3. Calls spawn_xvfb_reaper(os.getpid()) — returns the reaper pid to
     stdout as a single line, then exits via os._exit(0).
  4. The reaper detects the parent's death (os._exit is sudden) and
     runs reap_xvfb_by_display with the inherited DISPLAY. Kills land
     in the kill-record file.

The bun test asserts:
  - this script printed the reaper pid
  - the kill-record file contains exactly the expected pids

Usage:
  python3 tests/fixtures/stealth-reap-trigger.py \\
      --fake-ps '<JSON array>' \\
      --kill-record /path/to/record.txt
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fake-ps",
        required=True,
        help='JSON array of [pid, cmdline] tuples; injected as the fake ps output',
    )
    parser.add_argument(
        "--kill-record",
        required=True,
        help="File path the reaper appends each killed pid to (one per line)",
    )
    parser.add_argument(
        "--display",
        default=":99",
        help="DISPLAY value the helper is pretending to use (default :99)",
    )
    parser.add_argument(
        "--settle-ms",
        type=int,
        default=300,
        help="How long to wait after spawn before os._exit, so the reaper has time to call setsid",
    )
    parser.add_argument(
        "--poll-budget-seconds",
        type=float,
        default=None,
        help=(
            "If set, cap the reaper's parent-poll wait at this many seconds. "
            "Test-only: the production helper calls spawn_xvfb_reaper with "
            "the default (None = unbounded) so a long-running stealth scrape "
            "is never raced. Used by the r3 regression test to exercise "
            "'budget exhausted + parent alive -> no kill' without sleeping "
            "for 120s."
        ),
    )
    args = parser.parse_args()

    # Validate --fake-ps as JSON before forking so a typo fails fast.
    try:
        json.loads(args.fake_ps)
    except json.JSONDecodeError as exc:
        print(f"bad --fake-ps json: {exc}", file=sys.stderr)
        return 2

    # Set env BEFORE importing the module so the reaper's _default_scan_ps
    # picks up the fake. The fork inherits these.
    os.environ["DISPLAY"] = args.display
    os.environ["__SUGARPLUM_FAKE_PS_OUTPUT"] = args.fake_ps
    os.environ["__SUGARPLUM_FAKE_KILL_RECORD"] = args.kill_record

    # Derive the helper path from THIS file's location so the fixture
    # works on a fresh clone at any absolute path. Previously this was
    # hardcoded to /home/agent/projects/barkley-assistant/sugarplum/...
    # which silently loaded the DEV checkout's helper instead of the
    # clone's on this box, masking the r3 regression.
    # Path: tests/fixtures/stealth-reap-trigger.py -> parents[2] is the
    # repo root (parents[0] = tests/fixtures, parents[1] = tests,
    # parents[2] = repo root).
    helper_path = (
        Path(__file__).resolve().parents[2] / "scripts" / "stealth-fetch.py"
    )
    if not helper_path.is_file():
        print(f"stealth-fetch.py not found at {helper_path}", file=sys.stderr)
        return 5

    spec = importlib.util.spec_from_file_location(
        "stealth_fetch", str(helper_path)
    )
    if spec is None or spec.loader is None:
        print("failed to load stealth_fetch module", file=sys.stderr)
        return 3
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)

    reaper_pid = m.spawn_xvfb_reaper(
        os.getpid(),
        poll_budget_seconds=args.poll_budget_seconds,
    )
    if reaper_pid is None or reaper_pid <= 0:
        print(f"spawn_xvfb_reaper failed: {reaper_pid}", file=sys.stderr)
        return 4
    # Single-line output — the bun test parses it.
    print(f"{reaper_pid}", flush=True)

    # Give the reaper a moment to call setsid() before we os._exit, so
    # /proc shows the new session/pgrp if anything reads it.
    time.sleep(args.settle_ms / 1000.0)
    os._exit(0)


if __name__ == "__main__":
    raise SystemExit(main())
