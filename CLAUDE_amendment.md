# DEPLOYMENT CONTEXT — READ FIRST, ARCHITECT AROUND THIS

The agent is running directly on `your-host.example.com`, the production-ish host. The app will be served publicly at:

```
https://your-host.example.com/DocuRidge
```

This is a **subpath** deployment behind an existing nginx reverse proxy container. TLS is terminated at the proxy. The DocuRidge stack does not handle TLS or certificates.

## Hard Constraints — Reverse Proxy Integration

1. **The existing nginx reverse proxy container is OFF LIMITS.** Do not modify it, restart it, recreate it, or edit its config files. It is one of the "containers you didn't create" the prompt forbids touching.
2. **Discover the existing nginx Docker network** before writing the compose file. Run `docker network ls` and identify the network the existing nginx container is attached to. Confirm by inspecting the nginx container: `docker inspect <nginx_container> --format '{{json .NetworkSettings.Networks}}'`. If multiple networks exist, pick the one nginx uses for upstream proxying. Document the chosen network name in `DECISIONS.md`.
3. **Attach the DocuRidge app container to that existing network as `external: true`** in the compose file. This lets nginx reach the app by container name without exposing a host port. Postgres and MailHog stay on a private internal network — they must NOT join the nginx network.
4. **Do not bind the app to a host port for public traffic.** The app listens internally on a container port (default `3000` inside the container), reachable only via the nginx network as `docuridge_app:3000`. Postgres and MailHog can still bind to host ports for local debugging (`54317`, `8737`, `10737` defaults) but only on `127.0.0.1`, never `0.0.0.0`.
5. **Produce — do not apply — an nginx config snippet** at `deploy/nginx/docuridge.conf` that the owner will drop into the existing proxy himself. Snippet must include:
   - `location /DocuRidge/ { ... proxy_pass http://docuridge_app:3000/; ... }` (note the trailing slash — strips the prefix when proxying upstream)
   - `proxy_set_header Host $host;`
   - `proxy_set_header X-Forwarded-Proto $scheme;`
   - `proxy_set_header X-Forwarded-Host $host;`
   - `proxy_set_header X-Forwarded-Prefix /DocuRidge;`
   - `proxy_set_header X-Real-IP $remote_addr;`
   - `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
   - WebSocket upgrade headers if any feature uses them (signing-page live updates would)
   - `client_max_body_size` set generously for PDF uploads (e.g. `50m`)
   - A separate `location = /DocuRidge { return 301 /DocuRidge/; }` to handle the no-trailing-slash case
6. **Document deployment steps** in `DEPLOYMENT.md`: how to discover the nginx network, how to install the snippet, how to reload nginx (`docker exec <nginx> nginx -s reload` — the *owner* runs this, not the agent).

## Hard Constraints — Subpath (basePath) Handling

The app is served at `/DocuRidge`, not at root. Every part of the app must respect this:

1. **Configure `basePath: '/DocuRidge'` in `next.config.js`** from Phase 1. Do not retrofit this later — every link, asset, and route is affected.
2. **Set `assetPrefix: '/DocuRidge'`** so `_next/static` assets resolve correctly behind the proxy.
3. **Public URL env var.** Add `PUBLIC_URL=https://your-host.example.com/DocuRidge` to `.env.example` and `.env`. All outgoing email links, signing-token URLs, and absolute redirects use this value. Never construct public URLs from request headers without sanitizing through this var.
4. **All internal links use Next's `<Link>`** (which respects basePath automatically). Never write a hardcoded `<a href="/dashboard">` — it will break.
5. **All API/server-action calls use relative paths** so basePath applies. Never `fetch('/api/foo')` from the client without going through the basePath-aware helper.
6. **Cookies set `Path=/DocuRidge`** so they're scoped correctly and don't leak to other apps on the same domain.
7. **CSRF origin check** validates against `PUBLIC_URL`'s origin (`https://your-host.example.com`), not the request `Host` header alone.
8. **Trust proxy headers.** Configure the framework to trust `X-Forwarded-*` headers since nginx is the only thing in front of the app. The app sees HTTPS via `X-Forwarded-Proto`, real client IP via `X-Forwarded-For`. This affects rate limiting (key off real IP), audit logging (record real IP), and secure-cookie flags.
9. **Redirect handling.** Any server-side `redirect('/dashboard')` must end up at `/DocuRidge/dashboard` publicly. Next.js handles this correctly when basePath is configured — just verify in tests.
10. **Health endpoints** (`/healthz`, `/readyz`) are served at the basePath too: publicly `https://your-host.example.com/DocuRidge/healthz`. The nginx snippet must route these correctly. Internal Docker healthchecks can hit the container directly bypassing the proxy.

## Hard Constraints — Port Conflict Check

Before binding any host port, the agent must verify it's free on `your-host.example.com`. Run:

```
ss -tlnp 2>/dev/null | awk '{print $4}' | grep -oE ':[0-9]+$' | sort -u
```

If any default port (`54317` postgres, `8737` mailhog UI, `10737` mailhog SMTP) is taken, increment by 1 until free and document the actual ports used in `.env.example` and `README.md`. The app container does not need a host port at all — it's reached via the nginx network.

## Test Implications

Playwright tests must run against the basePath:

- `baseURL: 'http://docuridge_app:3000/DocuRidge'` for tests running inside the Docker network, OR
- `baseURL: 'https://your-host.example.com/DocuRidge'` for tests running through the real proxy

Pick one and document. The first option is faster and more isolated; the second catches proxy-specific bugs. Recommendation: default to internal-network tests, add a small smoke-test suite that runs against the public URL in Phase 7.

## What Goes in DEPLOYMENT.md

A copy-pasteable runbook the owner can follow:

1. How to identify the nginx network (`docker network ls` + `docker inspect`)
2. How to install the nginx snippet into the existing proxy's config directory
3. How to reload nginx without downtime (`nginx -s reload`)
4. How to verify the deployment (curl `https://your-host.example.com/DocuRidge/healthz`)
5. How to roll back (remove snippet, reload nginx, stop DocuRidge stack)
6. How to update DocuRidge (pull, `docker compose -p docuridge up -d --build`, verify health)
