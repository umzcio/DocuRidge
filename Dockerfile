# syntax=docker/dockerfile:1
# DocuRidge — multi-stage production image.
# Stage 1: deps  — install full deps (build needs them)
# Stage 2: build — Next.js build, prisma generate
# Stage 3: run   — minimal runtime, only standalone build + prisma client + entrypoint

ARG NODE_VERSION=22-alpine

# ─── Stage 1: deps ───────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
RUN apk add --no-cache python3 make g++ openssl libc6-compat bash
WORKDIR /app

COPY package.json package-lock.json* ./
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ─── Stage 2: build ──────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS build
RUN apk add --no-cache openssl libc6-compat bash
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npx prisma generate
RUN npm run build

# ─── Stage 3: run ────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS run
# qpdf strips owner-password encryption from uploaded PDFs so pdf-lib
# can copy real content streams (not still-encrypted bytes) into the
# sealed output. Without it, owner-password PDFs seal as blank pages.
RUN apk add --no-cache openssl libc6-compat bash tini qpdf
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# Non-root runtime user
RUN addgroup -g 1001 -S docuridge && adduser -S -u 1001 -G docuridge docuridge

# Standalone build artifacts
COPY --from=build --chown=docuridge:docuridge /app/.next/standalone ./
COPY --from=build --chown=docuridge:docuridge /app/.next/static ./.next/static
COPY --from=build --chown=docuridge:docuridge /app/public ./public
# PDF worker child (esbuild bundle of src/lib/pdf-worker/child.ts): PDF jobs
# run in a fresh fork of it, one per job. /readyz fails without it. Root-owned
# and world-readable on purpose (no --chown): a compromised child running as
# docuridge must not be able to rewrite the bundle that later jobs run.
COPY --from=build /app/dist/pdf-worker.cjs ./pdf-worker.cjs
# Canonical-documents backfill (esbuild bundle of scripts/canonical-backfill.ts;
# the image has no tsx). Run from /app: see DEPLOYMENT.md. Root-owned like the
# worker bundle, mode 0644.
COPY --from=build /app/dist/canonical-backfill.cjs ./canonical-backfill.cjs
RUN chmod 0644 /app/canonical-backfill.cjs

# Defense in depth: .dockerignore keeps .env out of the build context, but
# Next's standalone output would copy one into the image if it ever got in.
# Runtime configuration comes from the environment (compose `env_file`), never
# from a baked file.
RUN rm -f /app/.env /app/.env.local /app/.env.production /app/.env.development

# Prisma generated client + schema for migrate deploy
COPY --from=build --chown=docuridge:docuridge /app/prisma ./prisma
COPY --from=build --chown=docuridge:docuridge /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=docuridge:docuridge /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build --chown=docuridge:docuridge /app/node_modules/prisma ./node_modules/prisma

# Entrypoint + helper scripts
COPY --chown=docuridge:docuridge scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Data volume mount points (created here so chown works before mount)
RUN mkdir -p /data/uploads /data/sealed /data/keys && chown -R docuridge:docuridge /data
VOLUME ["/data"]

USER docuridge
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
