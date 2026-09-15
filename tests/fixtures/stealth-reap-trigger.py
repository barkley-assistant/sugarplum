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

    spec = importlib.util.spec_from_file_location(
        "stealth_fetch", "/home/agent/projects/barkley-assistant/sugarplum/scripts/stealth-fetch.py"
    )
    if spec is None or spec.loader is None:
        print("failed to load stealth_fetch module", file=sys.stderr)
        return 3
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)

    reaper_pid = m.spawn_xvfb_reaper(os.getpid())
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
