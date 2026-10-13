# Production on this PC (Docker + Cloudflare Tunnel)

Everything runs in Docker Desktop: the web app, API, worker, MongoDB, nightly backups, and the Cloudflare Tunnel that
puts the site on your domain. Nothing is exposed on your network; the tunnel makes an outbound connection to Cloudflare.

All commands run from the repository root in PowerShell or Command Prompt: `deploy\prod.cmd <command>`
(`deploy\prod.cmd help` lists them).

## Settings (`deploy\.env`)

Production settings live in **`deploy\.env`**, separate from the development `.env` in the repository root. Git ignores
it and Docker never copies it into an image.

- `deploy\prod.cmd init` creates it and generates the secrets (auth secret, database passwords, push keys).
- `deploy\prod.cmd edit` opens it in Notepad. `deploy\prod.cmd check` lists what is still missing.
- **After changing anything, run `deploy\prod.cmd up`.** It rebuilds what changed and restarts the affected containers.
- Never paste the file's values into chat, email, or a ticket.

| Setting | Where it comes from |
| --- | --- |
| `APP_DOMAIN` | The hostname you choose for the app, e.g. `app.yourdomain.com` (no `https://`). |
| `RESEND_API_KEY`, `EMAIL_FROM` | Resend dashboard. `EMAIL_FROM` must use a domain verified in Resend. |
| `BOOTSTRAP_ADMIN_EMAIL` | Your email; sign up at `https://APP_DOMAIN/signup` with it to become the first admin. |
| `R2_*` | The **production** bucket (`venture-studio-prod`), not the development one. See below. |
| `TUNNEL_TOKEN` | Cloudflare Zero Trust, see below. The site goes public once this is set. |
| `BACKUP_R2_*` | Optional separate backup bucket. Empty means backups stay on this PC only. |
| `VAPID_SUBJECT` | `mailto:` plus an address you read. |
| `MCP_ENABLED` | `true` turns on Claude connections (`/mcp`, `/mcp/sales` and the Connect Claude page); off when unset. `MCP_WRITES_ENABLED=false` keeps them read-only. See `docs/mcp.md`. |
| `TINYFISH_API_KEY`, `EXA_API_KEY` | Optional. Company search for the Dealflow Sales connector (`search_companies`) and the built-in lead finder. An admin can instead save the keys in the app (Sales → Setup), stored encrypted with a key derived from `BETTER_AUTH_SECRET`; a key saved in the app wins. Never shown to Claude. Changing `BETTER_AUTH_SECRET` makes saved keys unreadable, so enter them again. |
| `SALES_FINDER` | `on` (default) or `off`. The lead finder built into the API works the queued find-leads and enrich runs itself: polite, robots.txt respected, public pages only. |

The two MongoDB passwords take effect when the database is first created. Do not change them afterwards.

**Keep a copy of `deploy\.env` in a password manager.** Backups contain the database's own user accounts, so restoring
one (for example onto a new PC) needs the same passwords, and the auth secret keeps existing sign-ins valid.

### Production R2 bucket

1. Cloudflare dashboard > R2 > `venture-studio-prod` (create it if needed, keep public access off).
2. Settings > CORS policy: allow origin `https://APP_DOMAIN`, methods `GET`, `PUT`, `HEAD`, header `Content-Type`,
   expose header `ETag`.
3. R2 > Manage API tokens > Create token: **Object Read & Write**, limited to `venture-studio-prod`. Put the access key,
   secret, and the account endpoint (`https://<account-id>.r2.cloudflarestorage.com`) in `R2_*`.

For off-PC backups, repeat with a second private bucket (e.g. `venture-studio-backups`, no CORS needed) and its own token
in `BACKUP_R2_*`.

### Cloudflare Tunnel

1. Cloudflare dashboard > Zero Trust > Networks > Tunnels > **Create a tunnel** > Cloudflared. Name it `venture-studio`.
2. On the install step, choose **Docker** and copy only the token (the long value after `--token`) into `TUNNEL_TOKEN`.
3. Public hostname: subdomain and domain matching `APP_DOMAIN`; service type **HTTP**, URL **`web:3000`**.
4. `deploy\prod.cmd up` starts the tunnel container.

## Running it

```
deploy\prod.cmd up          build and start (or apply changed settings)
deploy\prod.cmd status      containers and health
deploy\prod.cmd logs api    follow one service's logs (web, api, worker, mongo, backup, tunnel)
deploy\prod.cmd down        stop everything; data is kept
```

On this PC the site is also at `http://127.0.0.1:3100` for quick checks. Signing in only works on the real HTTPS domain.

## Backups

- A full database backup runs at start-up and then every 24 hours, into `.data\prod-backups` (kept 14 days) and, when
  configured, the backup bucket (kept 30 days).
- `deploy\prod.cmd backup` takes one now, `deploy\prod.cmd backups` lists them.
- `deploy\prod.cmd verify-backup` restores the newest backup into a throwaway database and prints what it contains.
  Run it after setup and occasionally after that.
- `deploy\prod.cmd restore <file>` replaces the live database with a backup, after you type `RESTORE`.
- `status` shows the backup container as **unhealthy** if the last good backup is over 26 hours old.

**Never use Docker Desktop's "Reset to factory defaults", "Clean / Purge data", or delete the `venture-studio-prod`
volumes.** They hold the live database.

## Keeping it online

- Docker Desktop > Settings > General: **Start Docker Desktop when you sign in**. Containers restart by themselves.
- Windows power settings: never sleep. Set Windows Update active hours so restarts happen at night, or enable automatic
  sign-in so the app comes back after a restart without you.
- Optional: in the BIOS, enable power-on after power loss.

Product overview: [../README.md](../README.md). Every environment setting: [../docs/setup-and-operations.md](../docs/setup-and-operations.md).
