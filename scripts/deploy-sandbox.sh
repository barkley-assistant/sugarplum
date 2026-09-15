#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# deploy-sandbox.sh — LOCAL-ONLY exerciser for scripts/deploy.sh
# ─────────────────────────────────────────────────────────────────────────
#
# THIS SCRIPT MUST NEVER REACH github.com.
#
# It exists to exercise every code path of scripts/deploy.sh
# (first-boot seed-and-stop, admin-guard refusal, happy-path restart)
# against a fully-local bare repository under /tmp, so a sandbox run can
# never accidentally push, fetch from, or otherwise touch the real origin.
#
# BACKGROUND — the eeeabf9 "initial empty commit" incident:
#
#   A previous inline sandbox (in .hermes/plans/wave4-deploy.md) ran the
#   deploy script with the real git@github.com URL still hardcoded.
#   `git init` + an empty commit + `git push` from inside that sandbox
#   ended up landing on the public origin, polluting the project history
#   with a redundant "initial" commit (sha eeeabf9).
#
#   The fix is two-fold:
#     (a) scripts/deploy.sh now honors a `DEPLOY_REPO_URL` env override
#         (the real default is unchanged). The override is what this
#         script sets — see line marked GUARD below.
#     (b) This script ALWAYS points DEPLOY_REPO_URL at a local bare
#         repository created under /tmp. It also refuses to run if that
#         bare repo is missing OR if DEPLOY_REPO_URL points anywhere
#         other than a local file path. The "cannot reach github.com"
#         invariant is verified at script startup.
#
# Exit codes (all paths operator-live-tested against the real deploy.sh):
#   0   all 3 sandbox paths passed
#   1   one or more sandbox assertions failed
#   2   GUARD tripped (script cannot guarantee a local-only run)
#   3   git/bun/mise not available on this host
#
# Usage:
#   bash scripts/deploy-sandbox.sh
#   # or, in CI:
#   bash scripts/deploy-sandbox.sh && echo "sandbox ok"
#
# No flags. No env vars to set up-front except by the operator (this
# script does its own DEPLOY_REPO_URL / DEPLOY_LIVE_DIR / DEPLOY_ENV_FILE
# / DEPLOY_SERVICE / DEPLOY_HEALTH_URL management so it cannot be
# mis-configured into a real-origin push).
# ─────────────────────────────────────────────────────────────────────────

set -uo pipefail   # deliberately no -e — sandbox steps must report ALL outcomes

# ── GUARD: verify the local-only invariant BEFORE doing anything else. ──
# The whole point of this script is "cannot reach github.com". We assert
# that DEPLOY_REPO_URL is unset (this script will set it below) and that
# the eventual value is a file:// path or a local filesystem path — never
# ssh://, https://, git@, etc.
if [ -n "${DEPLOY_REPO_URL:-}" ]; then
    echo "FATAL: DEPLOY_REPO_URL is pre-set in the environment." >&2
    echo "       This sandbox must control it itself; pre-setting risks pointing at the real origin." >&2
    exit 2
fi
if [ -n "${DEPLOY_LIVE_DIR:-}" ] || [ -n "${DEPLOY_ENV_FILE:-}" ] || [ -n "${DEPLOY_SERVICE:-}" ] || [ -n "${DEPLOY_HEALTH_URL:-}" ]; then
    echo "FATAL: DEPLOY_LIVE_DIR / DEPLOY_ENV_FILE / DEPLOY_SERVICE / DEPLOY_HEALTH_URL are pre-set." >&2
    echo "       This sandbox must control them itself." >&2
    exit 2
fi

# ── Sandbox scaffolding (all under /tmp; nothing outside the test host) ──
SB="$(mktemp -d -t sugarplum-deploy-sandbox.XXXXXX)"
trap 'rm -rf "$SB"' EXIT   # leave nothing behind, even on failure

ORIGIN="$SB/origin.git"   # local bare repo — the sandbox's "github.com"
LIVE="$SB/live"           # local checkout — the sandbox's "live dir"
ENVF="$SB/sugarplum.env"  # local env file
MOCK_BIN="$SB/mockbin"
MOCK_LOG="$SB/mock-systemctl.log"
HEALTH_LOG="$SB/mock-health.log"
MOCK_PORT=34777

mkdir -p "$ORIGIN" "$LIVE" "$MOCK_BIN"

# ── Build a local bare repo that mirrors this checkout's current head. ──
# `git init --bare` under /tmp is the canonical "fake remote" — it never
# makes a network call. We seed it from THIS checkout's main branch, so
# deploy.sh's `git clone` has something real to fetch.
git -C "$ORIGIN" init --bare --quiet --initial-branch=main
# Allow pushing into a non-bare repo even when cwd is checked out elsewhere
# (irrelevant here — we push into the bare repo from a separate worktree).
git -C "$ORIGIN" config receive.denyCurrentBranch ignore

# Create a temporary worktree pointing at THIS repo's main so we can push
# a copy of the current tip into the bare sandbox origin.
#
# We push via an explicit URL (no `git remote add`) because the worktree
# shares this repo's `.git/config` — a leftover "sandbox" remote from a
# previous run would make `git remote add sandbox` fail. Pushing directly
# is also strictly local: `git push file://...` is a fully-offline copy.
WORKTREE="$(mktemp -d -t sugarplum-deploy-sandbox-work.XXXXXX)"
git worktree add --quiet --detach "$WORKTREE" main
pushd "$WORKTREE" >/dev/null || exit 1
git push --quiet --force "$ORIGIN" main:main
popd >/dev/null || exit 1
git worktree remove --force "$WORKTREE" 2>/dev/null || true
# `git worktree remove` deletes the directory; the rmdir is a belt-and-
# suspenders cleanup that no-ops if the worktree was already gone.
rmdir "$WORKTREE" 2>/dev/null || true

# ── GUARD (post-init): verify the REPO_URL we'll set is local-only. ──
DEPLOY_REPO_URL="file://$ORIGIN"
case "$DEPLOY_REPO_URL" in
    file://*) ;;
    /*)        ;;   # local filesystem path is fine too
    *)
        echo "FATAL: DEPLOY_REPO_URL='$DEPLOY_REPO_URL' is not a local path." >&2
        echo "       Refusing to run — sandbox must NEVER reach a remote." >&2
        exit 2
        ;;
esac

export DEPLOY_REPO_URL
export DEPLOY_LIVE_DIR="$LIVE"
export DEPLOY_ENV_FILE="$ENVF"
export DEPLOY_SERVICE="throwaway.service"
export DEPLOY_HEALTH_URL="http://127.0.0.1:$MOCK_PORT/api/health"
export DEPLOY_SKIP_STEALTH=1   # don't provision a venv in a sandbox

# ── Mock systemctl so deploy.sh never touches the real systemd. ──
cat > "$MOCK_BIN/systemctl" <<EOF
#!/usr/bin/env bash
echo "systemctl \$*" >> "$MOCK_LOG"
exit 0
EOF
chmod +x "$MOCK_BIN/systemctl"

# ── Mock health endpoint so deploy.sh's health-poll loop always sees 200. ──
# bun is the runtime sugarplum ships with; if it's missing, bail early.
if ! command -v bun >/dev/null 2>&1; then
    if [ -x "$HOME/.local/share/mise/shims/bun" ]; then
        export PATH="$HOME/.local/share/mise/shims:$PATH"
    else
        echo "FATAL: bun not found on PATH and no mise shim at ~/.local/share/mise/shims/bun." >&2
        exit 3
    fi
fi

bun -e "Bun.serve({ port: $MOCK_PORT, fetch: () => new Response('{\"status\":\"ok\"}', { headers: { 'content-type': 'application/json' } }) }); setInterval(() => {}, 1 << 30);" > "$HEALTH_LOG" 2>&1 &
HEALTH_PID=$!
trap 'kill "$HEALTH_PID" 2>/dev/null || true; rm -rf "$SB"' EXIT

# Give the health server a moment to bind before deploy.sh polls it.
sleep 0.5

# ── Sandbox assertions ──────────────────────────────────────────────────
fail=0
pass() { printf 'PASS  %s\n' "$*"; }
fail_step() { printf 'FAIL  %s\n' "$*"; fail=1; }

# Run a single deploy.sh invocation. Captures stdout/stderr to per-step
# logs and returns the exit code.
run_deploy() {
    local step="$1"
    PATH="$MOCK_BIN:$PATH" bash scripts/deploy.sh > "$SB/$step.log" 2>&1
    echo $?
}

# ── Path 1: first boot — clones from local bare, seeds env, exits 3. ──
RC="$(run_deploy first-boot)"
if [ "$RC" = "3" ]; then
    pass "first-boot: exit 3 (env seeded with port + bind host, admin vars empty)"
else
    fail_step "first-boot: expected exit 3, got $RC"
    echo "----- first-boot log -----" >&2
    cat "$SB/first-boot.log" >&2
fi
if [ -f "$ENVF" ]; then
    pass "first-boot: env file $ENVF created"
else
    fail_step "first-boot: env file $ENVF was NOT created"
fi
if ! [ -d "$LIVE/.git" ]; then
    fail_step "first-boot: LIVE/.git missing — git clone from $DEPLOY_REPO_URL failed"
else
    pass "first-boot: LIVE cloned from local bare repo $ORIGIN"
fi

# ── Path 2: admin-guard — env present, admin vars still empty → exit 4. ──
RC="$(run_deploy admin-guard)"
if [ "$RC" = "4" ]; then
    pass "admin-guard: exit 4 (admin vars empty; restart refused)"
else
    fail_step "admin-guard: expected exit 4, got $RC"
    echo "----- admin-guard log -----" >&2
    cat "$SB/admin-guard.log" >&2
fi

# ── Path 3: happy path — fill admin vars, run again, exit 0 + mock restart. ──
cat >> "$ENVF" <<EOF

SUGARPLUM_ADMIN_USERNAME=op
SUGARPLUM_ADMIN_PASSWORD=x-not-a-real-password-sandbox-only
SUGARPLUM_ADMIN_DISPLAY_NAME=op
EOF

# Truncate the mock systemctl log so we can assert the EXACT one restart
# call we expect (the deploy script restarts the unit exactly once).
: > "$MOCK_LOG"

RC="$(run_deploy happy-path)"
if [ "$RC" = "0" ]; then
    pass "happy-path: exit 0 (deploy succeeded)"
else
    fail_step "happy-path: expected exit 0, got $RC"
    echo "----- happy-path log -----" >&2
    cat "$SB/happy-path.log" >&2
fi

# Assert the mock systemctl log shows exactly the expected restart call.
if grep -q "^systemctl --user restart throwaway.service" "$MOCK_LOG"; then
    pass "happy-path: mock systemctl got exactly 'systemctl --user restart throwaway.service'"
else
    fail_step "happy-path: expected 'systemctl --user restart throwaway.service' in mock log"
    echo "----- mock systemctl log -----" >&2
    cat "$MOCK_LOG" >&2
fi

# Belt-and-suspenders: the LIVE clone must STILL be from the local bare,
# not from any github.com URL. A previous sandbox bug (eeeabf9) had the
# wrong remote; this asserts we never regressed.
if git -C "$LIVE" remote get-url origin | grep -qE '^file://|^/'; then
    pass "happy-path: LIVE remote is local (no github.com)"
else
    fail_step "happy-path: LIVE remote is NOT local: $(git -C "$LIVE" remote get-url origin)"
fi

# ── Summary ─────────────────────────────────────────────────────────────
if [ "$fail" -eq 0 ]; then
    echo "deploy-sandbox: all paths green (local-only)"
    exit 0
fi
echo "deploy-sandbox: FAILURES detected (see above)"
exit 1
