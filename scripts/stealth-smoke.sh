#!/usr/bin/env bash
# Manual smoke: real stealth run against a real URL. Never run in CI.
#
# Usage:
#   STEALTH_PY=/path/to/venv/bin/python bash scripts/stealth-smoke.sh [url]
#
# Default venv is a SIBLING of the checkout (<repo>/../.stealth-venv), the
# same layout scripts/deploy.sh provisions for the live dir.
#
# Captures stdout of two runs (cold + warm profile) and prints a small
# summary — that is the one-time proof expected by the wave-13 brief.

set -euo pipefail

PY="${STEALTH_PY:-$(dirname "$PWD")/.stealth-venv/bin/python}"
URL="${1:-https://www.smythstoys.com/en-gb/p/248662}"

python3 -m py_compile scripts/stealth-fetch.py
python3 -m py_compile scripts/stealth-verdict.py

PROFILES="$(mktemp -d)/profiles"
mkdir -p "$PROFILES"

echo "== run 1: cold profile (challenge solve) =="
T1_START=$(date +%s)
"$PY" scripts/stealth-fetch.py "$URL" --profiles-dir "$PROFILES" > /tmp/run1.json
T1_END=$(date +%s)
echo "elapsed: $((T1_END - T1_START))s"

echo "== run 2: warm profile (no re-solve expected) =="
T2_START=$(date +%s)
"$PY" scripts/stealth-fetch.py "$URL" --profiles-dir "$PROFILES" > /tmp/run2.json
T2_END=$(date +%s)
echo "elapsed: $((T2_END - T2_START))s"

echo "== verdicts =="
"$PY" scripts/stealth-verdict.py /tmp/run1.json
"$PY" scripts/stealth-verdict.py /tmp/run2.json

echo "== acceptance check =="
python3 - <<'PYEOF'
import json, sys
r1 = json.load(open("/tmp/run1.json"))
r2 = json.load(open("/tmp/run2.json"))
fail = []
if not r1.get("ok"):
    fail.append(f"run1 not ok: {r1.get('reason')}")
if not r2.get("ok"):
    fail.append(f"run2 not ok: {r2.get('reason')}")
if (r1.get("html") or "")[:1] != "<":
    fail.append("run1 html does not look like a real page")
if len(r1.get("html") or "") < 10_000:
    fail.append(f"run1 html unexpectedly small ({len(r1.get('html') or '')} bytes)")
if (r2.get("html") or "")[:1] != "<":
    fail.append("run2 html does not look like a real page")
if fail:
    for f in fail: print("FAIL:", f)
    sys.exit(1)
print("acceptance: run1 and run2 both ok=true, both real pages — PASS")
PYEOF
