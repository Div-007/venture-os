# Setup and operations

A collaboration and execution workspace organized as:

`Workspace -> Ventures -> Groups -> Channels`

The dashboard direction and whole-app implementation were approved on 2026-09-23. The repository now contains the UI plus an Express/Socket.IO API, MongoDB persistence, a durable reminder/outbox worker, shared contracts, local development adapters, and two hosted MCP connectors for Claude (Venture Studio at `/mcp`, Dealflow Sales at `/mcp/sales`).

## Repository layout

- `apps/web` — Next.js web application
- `apps/api` — Express HTTP API, Better Auth, Socket.IO gateway, uploads, search, and the two hosted MCP connectors (`/mcp`, `/mcp/sales`)
- `apps/worker` — durable reminders, notification outbox claims, retry, email, and Web Push
- `packages/contracts` — shared schemas and API/event contracts
- `packages/core` — framework-independent domain logic
- `docs` — product and architecture decisions
- `TODO.md` — phased delivery checklist and approval gates

## Current commands

Use Node.js 20.19 or newer.

```bash
npm install
npm run build
npm run typecheck
npm test
npm run smoke:backend
npm run dev:web
npm run smoke:web
```

Copy `.env.example` to `.env` and use a MongoDB replica set. Local mode can use labelled development identity, email, push, and object-storage adapters; production mode fails closed when required credentials or transaction support are missing.

For Cloudflare R2 development uploads, use a private development bucket and a bucket-scoped Object Read & Write token. Set `FILE_STORAGE=r2`, `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` in the ignored root `.env`; API startup fails if any are missing. Configure bucket CORS for the local web origin (`http://localhost:3011` in the current preview): allow `PUT`, `GET`, and `HEAD`, allow `Content-Type`, and expose `ETag`. Use a separate private bucket and token in production. An actual signed browser upload/download smoke test still requires configured credentials and must not be inferred from local-adapter tests.

### Production settings

- **Running production on one PC:** `deploy/` holds a Docker Compose stack (web, API, worker, MongoDB with nightly backups, Cloudflare Tunnel) driven by `deploy\prod.cmd`. See [deploy/README.md](../deploy/README.md); its settings live in the git-ignored `deploy/.env`.
- `CLIENT_IP_HEADER` names a header the edge always overwrites with the visitor's address (`cf-connecting-ip` behind Cloudflare). Set it only when every request arrives through that edge; it then keys both the API's and sign-in's per-IP rate limits.
- Set `APP_MODE=production` for the API and worker. They refuse to start when `NODE_ENV=production` is set without it, and production mode requires `BETTER_AUTH_SECRET`, public HTTPS `APP_ORIGIN`/`API_ORIGIN`, Resend, VAPID keys (generate with `npx web-push generate-vapid-keys`), R2 storage, and a MongoDB replica set.
- `npm run build` builds `packages/contracts` and `packages/core` first, then the apps. Start the processes with `npm start --workspace @venture-studio/web`, `@venture-studio/api`, and `@venture-studio/worker`, and run exactly one API instance (realtime fan-out is in-process). Set `VSO_API_ORIGIN` when building the web app, because its API rewrites are fixed at build time. Run `npm run migrate --workspace @venture-studio/api` with the production environment exported.
- `TRUST_PROXY` controls which `X-Forwarded-For` hops the API trusts for IP rate limits. Leave it unset unless a reverse proxy in front of the web app sets the header: the Next.js rewrite to the API forwards client headers unchanged and adds none. With nginx or Caddy on the same host, use `loopback` (or hop count `1`) and make the proxy overwrite the header with the client address. `true` is rejected in production because the client controls the leftmost entry.
- Production builds hide the `/demo` prototype; set `NEXT_PUBLIC_ENABLE_DEMO=true` at build time to keep it.

### External-service development setup

1. In [Cloudflare R2](https://developers.cloudflare.com/r2/buckets/create-buckets/), create a **private development bucket** (for example, `venture-studio-dev`). Do not enable public bucket access. Create an [S3 API token](https://developers.cloudflare.com/r2/api/tokens/) with **Object Read & Write** access limited to that bucket. Save the Access Key ID, Secret Access Key, and account S3 endpoint when shown; do not put them in chat or Git.
2. On that bucket, add [CORS](https://developers.cloudflare.com/r2/buckets/cors/) for the exact web origin in `APP_ORIGIN` (`http://localhost:3011` for the current preview): methods `PUT`, `GET`, `HEAD`; allowed header `Content-Type`; exposed header `ETag`. A browser using signed URLs needs CORS even though the bucket stays private. Add production as a separate bucket and token when deploying; do not share the development token with production.
3. In [Resend Domains](https://resend.com/docs/dashboard/domains/introduction), add and verify a sender domain using the DNS records Resend supplies. Then create a [sending-access API key](https://resend.com/docs/dashboard/api-keys/introduction), restricted to that domain if offered. Use a sender address on the verified domain for `EMAIL_FROM`.
4. Copy `.env.example` to the ignored root `.env`. Set `FILE_STORAGE=r2`, `R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `RESEND_API_KEY`, and `EMAIL_FROM`. Set `APP_ORIGIN` and `API_ORIGIN` to the actual running origins. Never paste secrets into chat or commit `.env`.
5. Restart the API and worker, then perform a real browser upload/download and a test invitation. An email link using a `localhost` `APP_ORIGIN` can be opened only on that same computer; inviting remote people needs a public HTTPS application origin with production-grade authentication. Do not expose local development auth on a public tunnel.

Member notifications default to in-app delivery, plus browser push once the member subscribes and VAPID keys are configured. Email notifications are opt-in, so repeating task reminders do not flood inboxes when Resend is configured; invitation and sign-in emails use their separate delivery flow.

### Testing as several users locally

With `APP_MODE=local` and `ALLOW_DEV_AUTH=true` (never in production; startup refuses it), the API accepts a seeded user ID instead of a real session. In a development build of the web app, each browser origin can pick its user: open `http://alice.localhost:3012` (any `*.localhost`, `localhost`, or `127.0.0.1` origin; each has separate storage), run `localStorage.setItem("vso-dev-user-id", "user-alice")`, and reload. Without that key the origin acts as `user-divyansh`. Realtime accepts these loopback origins only while dev auth is enabled. Use a separate test database for this; production starts from a fresh database.

### First admin account

Set `BOOTSTRAP_ADMIN_EMAIL` in the ignored root `.env` to the first owner's real email address. Configure `RESEND_API_KEY` and a verified `EMAIL_FROM`, and run the API against a MongoDB replica set. Restart the API, open `/signup` on the web app, and request the verification link for that address. Opening the link signs in and claims admin access to the existing single workspace (or creates the first workspace if none exists). The claim is single-use; `/signup` returns 404 after a real admin exists. Remove `BOOTSTRAP_ADMIN_EMAIL` from the environment after claiming. In local development, the sanitized seeded admin is not a real email account and does not close the signup path. Afterward, create a venture and group if needed, then invite members from the group's People controls. The `/sign-in/live` page is for existing members; requesting a sign-in link alone does not grant membership.

Do not expose a fresh installation publicly before its configured owner claims it. Setup is restricted by the owner email and requires possession of the email verification link, but it should still be completed promptly.
Web Push currently accepts Chrome/FCM, Firefox/Mozilla, Safari/Apple, and Edge/Windows push-service endpoints. The endpoint ownership index upgrade retires ambiguous legacy duplicates and requires those browsers to subscribe again. Push alerts are deliberately generic and open the signed-in inbox, because an in-flight send cannot be recalled during a shared-browser account switch. Real closed-tab delivery remains unverified until VAPID keys are configured.

