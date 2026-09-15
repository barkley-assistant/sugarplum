#!/usr/bin/env bash
# Deploy sugarplum from main to the live systemd user service (port 34995).
#
#   live dir:  ~/.local/share/sugarplum        (checked out on main)
#   env file:  ~/.config/sugarplum/.env        (shared with the service)
#   service:   sugarplum.service               (user systemd unit)
#
# Safe to re-run: fetches the branch, installs, builds, restarts, health-polls.
#
# First boot (no env file): seeds a minimal env (port + bind host) and STOPS
# with exit 3 — the operator must fill in the three admin variables before
# the service can start (the server refuses to boot without them).
#
# Exit codes: 0 healthy | 1 health poll failed | 2 bun not found
#             3 first boot — env seeded, admin vars needed | 4 admin vars empty
#             (any other non-zero = the failing tool's own exit code, e.g.
#              systemctl exit 5 = unit not loaded)
#
# Test overrides (used by sandbox tests; do NOT set for a real deploy):
#   DEPLOY_LIVE_DIR, DEPLOY_ENV_FILE, DEPLOY_SERVICE, DEPLOY_HEALTH_URL
#   DEPLOY_STEALTH_VENV, DEPLOY_SKIP_STEALTH (1 = skip venv provision)
#   DEPLOY_REPO_URL   (sandbox ONLY — must be a local bare repo; real
#                      deploys default to git@github.com:barkley-assistant/
#                      sugarplum.git. Setting this to anything other than
#                      a local path/file URL is almost certainly a bug.)

set -euo pipefail

BRANCH="main"
LIVE_DIR="${DEPLOY_LIVE_DIR:-$HOME/.local/share/sugarplum}"
ENV_FILE="${DEPLOY_ENV_FILE:-$HOME/.config/sugarplum/.env}"
SERVICE="${DEPLOY_SERVICE:-sugarplum.service}"
HEALTH_URL="${DEPLOY_HEALTH_URL:-http://127.0.0.1:34995/api/health}"
# DEPLOY_REPO_URL: override the git clone source. The real default is the
# public origin. Sandbox tests MUST set this to a local bare repo (created
# with `git init --bare` under /tmp) so the sandbox can never reach
# github.com. The eeeabf9 incident: a sandbox fixture accidentally pushed
# an empty "initial" commit to the real origin — the fix is making the
# override mandatory in sandbox mode AND refusing to clone from any URL
# the sandbox didn't set.
REPO_URL="${DEPLOY_REPO_URL:-git@github.com:barkley-assistant/sugarplum.git}"

echo "-> sugarplum deploy (branch: $BRANCH, live dir: $LIVE_DIR)"

if [ ! -d "$LIVE_DIR/.git" ]; then
  echo "-> cloning $BRANCH into $LIVE_DIR (from $REPO_URL)"
  git clone -b "$BRANCH" --single-branch "$REPO_URL" "$LIVE_DIR"
else
  echo "-> fetching + checking out $BRANCH (from $REPO_URL)"
  git -C "$LIVE_DIR" remote set-url origin "$REPO_URL" 2>/dev/null || true
  git -C "$LIVE_DIR" fetch origin "$BRANCH"
  git -C "$LIVE_DIR" checkout -f "$BRANCH"
  git -C "$LIVE_DIR" reset --hard "origin/$BRANCH"
fi

first_boot="no"
if [ ! -f "$ENV_FILE" ]; then
  echo "-> first boot: no env file at $ENV_FILE — seeding port + bind host"
  mkdir -p "$(dirname "$ENV_FILE")"
  {
    echo "SUGARPLUM_PORT=34995"
    echo "SUGARPLUM_HOST=0.0.0.0"
    echo "# Fill these three in — the server refuses to boot without them:"
    echo "SUGARPLUM_ADMIN_USERNAME="
    echo "SUGARPLUM_ADMIN_PASSWORD="
    echo "SUGARPLUM_ADMIN_DISPLAY_NAME="
  } >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  first_boot="yes"
fi

# Resolve bun via mise shims (the systemd unit runs `mise exec -- bun`).
if command -v bun >/dev/null 2>&1; then
  BUN="bun"
elif [ -x "$HOME/.local/share/mise/shims/bun" ]; then
  BUN="$HOME/.local/share/mise/shims/bun"
else
  echo "-> ERROR: bun not found (PATH or $HOME/.local/share/mise/shims/bun)" >&2
  exit 2
fi

echo "-> installing dependencies (frozen lockfile)"
(cd "$LIVE_DIR" && "$BUN" install --frozen-lockfile)

echo "-> building web bundle"
(cd "$LIVE_DIR" && "$BUN" run build)

if [ "$first_boot" = "yes" ]; then
  echo ""
  echo "-> FIRST BOOT: seeded $ENV_FILE"
  echo "   1. Edit it and set SUGARPLUM_ADMIN_USERNAME / _PASSWORD /"
  echo "      _DISPLAY_NAME (the server refuses to boot without them)."
  echo "   2. Install the unit:"
  echo "        cp $LIVE_DIR/packaging/systemd/sugarplum.service ~/.config/systemd/user/"
  echo "        systemctl --user daemon-reload && systemctl --user enable --now sugarplum.service"
  echo "   3. Re-run this script to finish the deploy."
  echo ""
  exit 3
fi

# Never restart into a known crash-loop: the server exits 1 when any of the
# three bootstrap-admin vars is empty, so systemd would flap it every 5s.
for var in SUGARPLUM_ADMIN_USERNAME SUGARPLUM_ADMIN_PASSWORD SUGARPLUM_ADMIN_DISPLAY_NAME; do
  val="$(grep -E "^${var}=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' || true)"
  if [ -z "$val" ]; then
    echo "-> ERROR: $var is empty in $ENV_FILE." >&2
    echo "   The server refuses to boot without it; fill it in and re-run." >&2
    exit 4
  fi
done

# ── Stealth browser venv (optional capability; failure is loud but the app
#    boots fine without it — the scraper falls back to plain-only).
STEALTH_VENV="${DEPLOY_STEALTH_VENV:-$LIVE_DIR/../.stealth-venv}"
if [ "${DEPLOY_SKIP_STEALTH:-0}" = "1" ]; then
  echo "-> stealth: skipped (DEPLOY_SKIP_STEALTH=1)"
elif [ -f "$STEALTH_VENV/.provisioned" ]; then
  echo "-> stealth: venv + engine present (marker found)"
else
  if ! command -v python3 >/dev/null 2>&1; then
    echo "-> stealth: python3 not found — skipping provision (scrapes stay plain-only)" >&2
  elif ! command -v Xvfb >/dev/null 2>&1; then
    echo "-> stealth: Xvfb not found — skipping provision (headless engine needs it)" >&2
  else
    echo "-> stealth: provisioning $STEALTH_VENV (first boot: ~238MB engine download)"
    [ -d "$STEALTH_VENV" ] || python3 -m venv "$STEALTH_VENV"
    "$STEALTH_VENV/bin/pip" install --quiet invisible-playwright
    "$STEALTH_VENV/bin/python" -m invisible_playwright fetch   # downloads engine if missing, verifies seal
    date -u +"provisioned %Y-%m-%dT%H:%M:%SZ" > "$STEALTH_VENV/.provisioned"
    echo "-> stealth: provisioned."
  fi
fi

echo "-> restarting $SERVICE"
systemctl --user restart "$SERVICE"

echo "-> waiting for health check"
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
    echo "-> live (commit: $(git -C "$LIVE_DIR" rev-parse --short HEAD) on $BRANCH)"
    exit 0
  fi
  sleep 1
done

echo "-> ERROR: service did not become healthy after deploy" >&2
journalctl --user -u "$SERVICE" --since "30 sec ago" --no-pager | tail -15 >&2
exit 1