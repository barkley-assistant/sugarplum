#!/usr/bin/env python3
"""Print a one-line summary of a stealth-fetch verdict JSON file.

Used by scripts/stealth-smoke.sh to summarise /tmp/runN.json without
embedding heredocs in bash (heredocs in shell scripts trip a lot of
tooling). Kept tiny and stdlib-only.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} <verdict.json>", file=sys.stderr)
        return 2
    try:
        verdict = json.loads(Path(argv[1]).read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(f"{argv[1]} parse-error={exc}", file=sys.stderr)
        return 1
    ok = verdict.get("ok")
    reason = verdict.get("reason", "")
    status = verdict.get("status")
    html_len = len(verdict.get("html") or "")
    print(
        f"{argv[1]} ok={ok} status={status} html_len={html_len} reason={reason}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
