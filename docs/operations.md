# sugarplum operations

Live service for the household wishlist. Runs as a user systemd service on
the home server, exposed at https://sugarplum.barkleyassistant.dev through the
existing Cloudflare tunnel ("openwebui", shared with chat/mcp).

## Access

- URL (anywhere): https://sugarplum.barkleyassistant.dev — login required;
  every non-auth API route needs a session cookie.
- LAN: http://192.168.0.200:34995 (plain HTTP — cookies are Secure-flagged,
  so LAN access over plain HTTP cannot log in from a remote device; use it
  only for /api/health checks; interactive use goes through the HTTPS URL).

## Layout

- Live clone: `~/.local/share/sugarplum` (branch main)
- Env file: `~/.config/sugarplum/.env` (chmod 600)
- Unit: `~/.config/systemd/user/sugarplum.service`
- Data: `~/.local/share/sugarplum/data/` (sqlite db + images/)
- Repo template for the unit: `packaging/systemd/sugarplum.service`
- Repo template for the env: `.env.production.example`

## First-boot setup (once per host)

1. `bash scripts/deploy.sh` — clones the live dir, seeds
   `~/.config/sugarplum/.env` (port 34995 + bind host), builds, exits 3.
2. Edit the env file: set `SUGARPLUM_ADMIN_USERNAME`,
   `SUGARPLUM_ADMIN_PASSWORD`, `SUGARPLUM_ADMIN_DISPLAY_NAME`.
3. Install the unit:
   `cp packaging/systemd/sugarplum.service ~/.config/systemd/user/`
   `systemctl --user daemon-reload`
   `systemctl --user enable --now sugarplum.service`
   (from a repo checkout; the deploy script prints the exact commands on
   first boot)
4. `bash scripts/deploy.sh` again — restarts the service and health-waits.
5. Continue with the Cloudflare tunnel steps below (operator).

## Backup

The whole live state is `data/` + the env file. The db runs in WAL mode, so
copying the db file mid-write is unsafe — use sqlite's online backup:

    sqlite3 ~/.local/share/sugarplum/data/sugarplum.db \
      ".backup '/path/to/backup/sugarplum.db'"
    rsync -a ~/.local/share/sugarplum/data/images/ /path/to/backup/images/
    cp ~/.config/sugarplum/.env /path/to/backup/sugarplum.env

Optional restore drill: copy the backup db to /tmp, boot a throwaway instance
with `SUGARPLUM_PORT=34777 SUGARPLUM_DB_PATH=/tmp/sugarplum.db` (plus the
admin vars), confirm it serves, then kill it.

## Update

    bash scripts/deploy.sh

Idempotent: fetch main → frozen install → build web bundle → restart →
health-wait (~2-5s blip).

## Rollback

    git -C ~/.local/share/sugarplum rev-parse HEAD   # note current sha
    git -C ~/.local/share/sugarplum checkout <previous-sha>
    systemctl --user restart sugarplum.service

The database is forward-only (migrations only add); older code ignores newer
columns, and re-deploying forward re-runs nothing.

## Restore on a new host

1. Install bun via mise; ensure SSH key for github.com works.
2. `git clone git@github.com:barkley-assistant/sugarplum.git
   ~/.local/share/sugarplum`
3. Restore the env file and data/ (backup procedure, reversed).
4. Copy + enable the unit (First-boot setup steps 3-4).
5. Re-run the tunnel cutover below (ingress + DNS already point at the
   tunnel; only the connector side changes if it moved hosts).

## Logs

    journalctl --user -u sugarplum.service -f

## Cloudflare tunnel (operator)

The app is exposed through the EXISTING remotely-managed tunnel "openwebui"
(id e2b5abb8-1de9-4936-9c12-d59b291bd359, account
94c16f23727e6238eee15dbf7e75f8b4, zone barkleyassistant.dev id
aaca682dfa53c8387fe75ffe75d483d6 — re-verify ids at run time). Reuse, never
create a new tunnel; never touch the chat/mcp ingress rules.

### Step 1 — cloudflared compose (host-gateway), ~/docker/cloudflared/docker-compose.yml

Two edits in ONE change:

1. Bump the image pin to the running version (currently 2026.9.1) so the
   recreate does not downgrade the connector.
2. Add under the cloudflared service:

       extra_hosts:
         - "host.docker.internal:host-gateway"

Nothing else changes: same network (openwebui_default), same token, same
command. chat/mcp ingress rules are Cloudflare-side and untouched.

Then recreate the connector (brief blip on chat/mcp — pick a quiet moment):

    cd ~/docker/cloudflared && docker compose up -d

Confirm the mapping landed:

    docker inspect cloudflared --format '{{json .HostConfig.ExtraHosts}}'
    # expect: [{"host.docker.internal":"<host-gateway-ip>"}]

And immediately re-verify chat still works: `curl -sI
https://chat.barkleyassistant.dev` → 200.

### Step 2 — container→host reachability probe

    docker run --rm --add-host host.docker.internal:host-gateway \
      --network openwebui_default busybox nc -z -w 3 host.docker.internal 34995

### Step 3 — ingress rule (Cloudflare API, operator credentials)

GET the current configuration first, then PUT with the sugarplum rule
INSERTED BEFORE the catch-all (keep chat/mcp rules byte-identical):

    GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations

Body for the PUT — note the `config` wrapper (without it: error 1030):

    {
      "config": {
        "ingress": [
          { "hostname": "chat.barkleyassistant.dev", "service": "http://openwebui:8080" },
          { "hostname": "mcp.barkleyassistant.dev", "service": "http://workspace-mcp:8000" },
          { "hostname": "sugarplum.barkleyassistant.dev", "service": "http://host.docker.internal:34995" },
          { "service": "http_status:404" }
        ]
      }
    }

(Read the live rules from the GET — do not trust this listing blindly; the
GET is authoritative. Insert the sugarplum line before the catch-all.)

### Step 4 — DNS record

    POST /zones/{zone_id}/dns_records
    {
      "type": "CNAME",
      "name": "sugarplum",
      "content": "e2b5abb8-1de9-4936-9c12-d59b291bd359.cfargotunnel.com",
      "proxied": true,
      "ttl": 1,
      "comment": "Cloudflare Tunnel: openwebui -> sugarplum"
    }

### Step 5 — verify (from the repo)

    bash scripts/tunnel-probe.sh

All green including the chat/mcp regression steps = done.

## Env-file credential hygiene

`~/.config/sugarplum/.env` holds the bootstrap admin password in plaintext
until first boot consumes it. After the admin exists (first successful
start), rotate the password in-app (admin panel) and replace the env value
with a placeholder (it must stay NON-EMPTY: deploy.sh refuses to restart with
an empty admin var, and the server ignores the values once any admin exists).
No other secrets exist — sessions are opaque DB tokens; there is no
SESSION_SECRET.

## Housekeeping notes

- The tunnel connector self-updates are disabled (--no-autoupdate) and WUD
  watches the image; when bumping the pin, match the version actually running
  (docker ps) to avoid surprise downgrades on `compose up -d`.
- Deploy restarts the live service (~2-5s blip). Serialize with anyone using
  the app.
- The dev instance on port 3499 and openwebui on 34999 are unrelated to this
  service; don't touch them.