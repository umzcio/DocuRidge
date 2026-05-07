# DEPLOYMENT NOTES — REVERSE PROXY + SUBPATH GUIDANCE

DocuRidge ships configured for a **subpath deployment behind a reverse proxy** (`basePath: '/DocuRidge'`). The container does not handle TLS — that's the proxy's job. If you're deploying at the root of a domain, set `basePath` and `assetPrefix` to `''` in `next.config.js`.

## Reverse Proxy Integration

1. The app listens internally on container port `3000`. It is **not** exposed to the host by default — your proxy reaches it via the Docker network.
2. The Docker compose file uses an external network so an existing reverse-proxy container (nginx, Caddy, Traefik, etc.) can resolve `docuridge_app` by name. Set the network name in your override compose file.
3. Postgres and MailHog stay on a private internal network and bind only to `127.0.0.1` for local debugging.
4. An nginx config snippet template lives at `deploy/nginx/docuridge.conf`. It includes the headers DocuRidge expects (`X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-Prefix`, `X-Real-IP`), WebSocket upgrade, and a generous `client_max_body_size` for PDF uploads.

## Subpath (basePath) Handling

DocuRidge is served at `/DocuRidge` by default. To change:

1. Edit `basePath` and `assetPrefix` in `next.config.js`.
2. Set `PUBLIC_URL` to the full public origin + path. All outgoing email links, signing tokens, and absolute redirects derive from this var.
3. All internal links use Next's `<Link>` so basePath applies automatically; do not hardcode `<a href="/dashboard">`.
4. Cookies set `Path` to match the basePath so they don't leak to other apps on the same domain.
5. CSRF origin check validates against `PUBLIC_URL`'s origin, not the request `Host` header alone.
6. Trust `X-Forwarded-*` headers (HTTPS detection via `X-Forwarded-Proto`, real client IP via `X-Forwarded-For` — affects rate limiting, audit logging, and secure-cookie flags).
7. Health endpoints (`/healthz`, `/readyz`) sit at the basePath too. Internal Docker healthchecks may hit the container directly, bypassing the proxy.

## Port Conflict Check

Before binding any host port, verify it's free:

```
ss -tlnp 2>/dev/null | awk '{print $4}' | grep -oE ':[0-9]+$' | sort -u
```

If any default port (`54317` postgres, `8737` mailhog UI, `10737` mailhog SMTP) is taken, increment by 1 until free and update `.env`. The app container does not need a host port at all — your reverse proxy reaches it via the Docker network.

## Test Configuration

Playwright tests run against the basePath:

- `baseURL: 'http://docuridge_app:3000/DocuRidge'` — fast, runs inside the Docker network. **Recommended for CI.**
- `baseURL: 'https://your-domain.example.com/DocuRidge'` — slower, catches proxy-specific bugs. Useful as a post-deploy smoke check.

## DEPLOYMENT.md Runbook Outline

For real production:

1. Identify your reverse-proxy network (`docker network ls` + `docker inspect`)
2. Install the nginx snippet template into the proxy's config directory
3. Reload the proxy without downtime
4. Verify the deployment (curl `https://your-domain.example.com/DocuRidge/healthz`)
5. Roll-back: remove snippet, reload proxy, stop DocuRidge stack
6. Update: pull, `docker compose -p docuridge up -d --build`, verify health
