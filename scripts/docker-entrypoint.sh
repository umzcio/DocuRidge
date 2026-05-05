#!/usr/bin/env bash
# DocuRidge container entrypoint.
#
# Responsibilities:
#   1. Generate randomized cryptographic secrets if env vars are blank.
#   2. Ensure /data subdirectories exist with correct permissions.
#   3. Run database migrations (prisma migrate deploy).
#   4. If the bootstrap state row is absent, create the org + admin (with
#      no password yet) and the BootstrapState row pointing at it. The
#      operator completes setup via the /setup page using BOOTSTRAP_TOKEN.
#   5. exec the app process.
#
# This script must NOT log secrets to stdout. The ".env" file is the
# canonical persistence target for any randomly-generated secret.

set -euo pipefail

ENV_FILE="/app/.env"

log() {
  printf '[entrypoint] %s\n' "$1"
}

ensure_secret() {
  # Args: VAR_NAME, BYTE_LENGTH
  local name="$1"
  local bytes="$2"
  local current
  current=$(printenv "$name" || true)
  if [ -z "$current" ]; then
    local generated
    generated=$(node -e "process.stdout.write(require('crypto').randomBytes(${bytes}).toString('base64url'))")
    export "$name"="$generated"
    if [ -w "$ENV_FILE" ] || [ ! -e "$ENV_FILE" ]; then
      printf '%s=%s\n' "$name" "$generated" >> "$ENV_FILE"
      log "generated $name and appended to $ENV_FILE"
    else
      log "generated $name (in-process only — $ENV_FILE not writable)"
    fi
  fi
}

# ─── Step 1: secrets ─────────────────────────────────────────────────────
ensure_secret SESSION_SECRET 32
ensure_secret JWS_SIGNING_TOKEN_SECRET 32
ensure_secret JWS_RESET_TOKEN_SECRET 32
ensure_secret BOOTSTRAP_TOKEN 24

# ─── Step 2: data dirs ───────────────────────────────────────────────────
mkdir -p "${UPLOADS_DIR:-/data/uploads}" "${SEALED_DIR:-/data/sealed}" "${KEYS_DIR:-/data/keys}"
chmod 700 "${KEYS_DIR:-/data/keys}"

# ─── Step 3: migrations ──────────────────────────────────────────────────
log "running prisma migrate deploy…"
node node_modules/prisma/build/index.js migrate deploy

# ─── Step 4: bootstrap admin ─────────────────────────────────────────────
log "checking bootstrap state…"
node /app/node_modules/.bin/prisma --version >/dev/null 2>&1 || true
node - <<'NODE_BOOTSTRAP'
const crypto = require('node:crypto');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');

(async () => {
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.bootstrapState.findUnique({ where: { id: 1 } }).catch(() => null);
    if (existing) {
      console.log('[entrypoint] bootstrap state exists; skipping.');
      return;
    }
    const adminEmail = (process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com').toLowerCase();
    const adminName = process.env.BOOTSTRAP_ADMIN_NAME || 'DocuRidge Admin';
    const orgName = process.env.BOOTSTRAP_ORG_NAME || 'Acme Org';
    const orgSlug = process.env.BOOTSTRAP_ORG_SLUG || 'acme';
    const bootstrapToken = process.env.BOOTSTRAP_TOKEN;
    if (!bootstrapToken) {
      throw new Error('BOOTSTRAP_TOKEN not set');
    }
    const tokenHash = crypto.createHash('sha256').update(bootstrapToken, 'utf8').digest('hex');

    await prisma.$transaction(async (tx) => {
      let org = await tx.organisation.findUnique({ where: { slug: orgSlug } });
      if (!org) {
        org = await tx.organisation.create({ data: { name: orgName, slug: orgSlug } });
      }
      let user = await tx.user.findUnique({ where: { email: adminEmail } });
      if (!user) {
        user = await tx.user.create({
          data: {
            email: adminEmail,
            name: adminName,
            mustResetPassword: true,
          },
        });
      }
      const membership = await tx.orgMember.findUnique({
        where: { orgId_userId: { orgId: org.id, userId: user.id } },
      });
      if (!membership) {
        await tx.orgMember.create({
          data: { orgId: org.id, userId: user.id, role: 'ADMIN' },
        });
      }
      await tx.bootstrapState.create({
        data: { id: 1, pendingAdminUserId: user.id, tokenHash },
      });
    });
    console.log('[entrypoint] bootstrap state initialised; visit /setup to complete.');
  } finally {
    await prisma.$disconnect();
  }
})().catch((err) => {
  console.error('[entrypoint] bootstrap failed:', err);
  process.exit(1);
});
NODE_BOOTSTRAP

# ─── Step 5: exec app ────────────────────────────────────────────────────
log "starting app: $*"
exec "$@"
