#!/usr/bin/env bash
# Manual smoke: real Amazon against the REAL extraction pipeline, plus a
# stealth-transport pass when the stealth venv is available. NEVER run in CI
# — it hits live Amazon and the tests/ suite keeps all Amazon coverage local.
#
# Usage:
#   bash scripts/amazon-smoke.sh                # both probe ASINs
#   bash scripts/amazon-smoke.sh <url>          # one URL
#   STEALTH_PY=/path/to/venv/bin/python bash scripts/amazon-smoke.sh
#
# Probe ASINs (2026-09-15 ground truth, docs/research/product-scraping.md):
#   B0DLGMVR4C  featured offer  → price in #aod-ingress-link
#   B0BPCCKL3N  no offer        → price legitimately ABSENT, image still there
#
# Exit code: nonzero when a plain pass yields NEITHER a price NOR an image
# (the generic DOM tier stopped reading Amazon's markup) or when the plain
# pass failed outright (wall/network — see risk R1 in the wave-12 plan:
# that is the signal to flip the amazon.* registry entries to stealth-first).
# The stealth pass is informational; it never changes the exit code.

set -euo pipefail

AVAILABLE="https://www.amazon.co.uk/dp/B0DLGMVR4C"
NOOFFER="https://www.amazon.co.uk/dp/B0BPCCKL3N"

PY="${STEALTH_PY:-$(dirname "$PWD")/.stealth-venv/bin/python}"
PROFILES="$(mktemp -d)/profiles"
mkdir -p "$PROFILES"

urls=("$@")
if [ "${#urls[@]}" -eq 0 ]; then
  urls=("$AVAILABLE" "$NOOFFER")
fi

probe() { bun run scripts/amazon-probe.ts "$@"; }

fail=0
for url in "${urls[@]}"; do
  echo "== plain: $url"
  out="$(probe "$url" || true)"
  echo "$out"

  if printf '%s' "$out" | grep -q '^FAIL'; then
    echo "FAIL: plain fetch/parse did not succeed — if this is a bot wall, flip the"
    echo "      amazon.* registry entries in src/server/scraper/overrides.ts to"
    echo "      [\"stealth-browser\", \"plain\"] (one line, no code change)."
    fail=1
  fi

  price="$(printf '%s\n' "$out" | grep -o 'price=[^ ]*' | head -1 || true)"
  image="$(printf '%s\n' "$out" | grep -o 'image=[^ ]*' | head -1 || true)"
  if [ "$price" = "price=null" ] && [ "$image" = "image=null" ]; then
    echo "FAIL: neither a price nor an image could be extracted from a live page."
    fail=1
  fi

  if [ -x "$PY" ]; then
    echo "== stealth transport: $url"
    python3 -m py_compile scripts/stealth-fetch.py
    python3 -m py_compile scripts/stealth-verdict.py
    verdict="$(mktemp)"
    "$PY" scripts/stealth-fetch.py "$url" --profiles-dir "$PROFILES" > "$verdict" || true
    "$PY" scripts/stealth-verdict.py "$verdict" || true
    probe "$url" "$verdict" || true
  else
    echo "== stealth transport: skipped (no venv python at $PY; set STEALTH_PY)"
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "amazon-smoke: FAIL"
  exit 1
fi
echo "amazon-smoke: PASS (plain extraction produced price and/or image for every URL)"
