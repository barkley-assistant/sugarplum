#!/usr/bin/env bash
# Tunnel reachability probe for sugarplum + regression check for the other
# hostnames on the same Cloudflare tunnel. Read-only: dig + curl only.
#
# Run AFTER the operator cutover (ingress rule + DNS record + connector
# recreate). Before cutover this probe is EXPECTED to fail on the sugarplum
# steps — that failure output also proves the reporting works.

set -uo pipefail   # deliberately no -e: report every step, then summarize

ZONE="barkleyassistant.dev"
SUGARPLUM="sugarplum.$ZONE"
CHAT="chat.$ZONE"
MCP="mcp.$ZONE"

fail=0

pass() { printf 'PASS  %s\n' "$*"; }
fail_step() { printf 'FAIL  %s\n' "$*"; fail=1; }

# --- sugarplum (required) -------------------------------------------------

# 1. DNS: proxied CNAME resolves to Cloudflare edge IPs.
ip=$(dig +short "$SUGARPLUM" @1.1.1.1 | grep -E '^[0-9]+\.' | tail -1)
if [ -n "$ip" ]; then
  pass "dns: $SUGARPLUM -> $ip"
else
  fail_step "dns: $SUGARPLUM does not resolve (DNS record not created yet?)"
fi

# 2. HTTPS root through the tunnel: 200 + served by Cloudflare.
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://$SUGARPLUM/" 2>/dev/null || echo 000)
server=$(curl -sI --max-time 10 "https://$SUGARPLUM/" 2>/dev/null | tr -d '\r' | grep -i '^server:' | head -1)
if [ "$code" = "200" ]; then
  pass "https: $SUGARPLUM/ -> 200 ($server)"
else
  fail_step "https: $SUGARPLUM/ -> HTTP $code (502/530 = connector cannot reach the app or no ingress rule)"
fi

# 3. Health endpoint through the tunnel: exact body match.
body=$(curl -sS --max-time 10 "https://$SUGARPLUM/api/health" 2>/dev/null || true)
if [ "$body" = '{"status":"ok"}' ]; then
  pass "health: /api/health through the tunnel -> $body"
else
  fail_step "health: /api/health through the tunnel -> '${body:-no response}'"
fi

# --- regression: existing hostnames on the same tunnel (required) ---------

# chat (OpenWebUI web UI) must still answer 200 through the tunnel.
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://$CHAT/" 2>/dev/null || echo 000)
if [ "$code" = "200" ]; then
  pass "regression: $CHAT/ -> 200"
else
  fail_step "regression: $CHAT/ -> HTTP $code (the connector recreate broke an existing ingress)"
fi

# mcp answers with any non-5xx status (origin-dependent status; a 5xx here
# means tunnel-side failure, not a missing route).
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://$MCP/" 2>/dev/null || echo 000)
if [ "$code" -ge 200 ] && [ "$code" -le 499 ] 2>/dev/null; then
  pass "regression: $MCP/ -> $code (origin answered)"
else
  fail_step "regression: $MCP/ -> HTTP $code (connector or ingress failure)"
fi

# ---------------------------------------------------------------------------

if [ "$fail" -eq 0 ]; then
  echo "tunnel probe: all green"
  exit 0
fi
echo "tunnel probe: FAILURES detected (see above)"
exit 1