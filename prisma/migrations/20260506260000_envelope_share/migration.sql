-- Public view-link for forwarding completed envelopes. Idempotent.
CREATE TABLE IF NOT EXISTS "envelope_share" (
  "id"              TEXT NOT NULL,
  "envelopeId"      TEXT NOT NULL,
  "token"           TEXT NOT NULL,
  "recipientEmails" TEXT NOT NULL,
  "note"            TEXT,
  "createdById"     TEXT NOT NULL,
  "expiresAt"       TIMESTAMP(3) NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastViewedAt"    TIMESTAMP(3),
  "viewCount"       INTEGER NOT NULL DEFAULT 0,
  "revokedAt"       TIMESTAMP(3),
  CONSTRAINT "envelope_share_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "envelope_share_token_key" ON "envelope_share"("token");
CREATE INDEX IF NOT EXISTS "envelope_share_envelopeId_idx" ON "envelope_share"("envelopeId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'envelope_share_envelopeId_fkey') THEN
    ALTER TABLE "envelope_share"
      ADD CONSTRAINT "envelope_share_envelopeId_fkey"
        FOREIGN KEY ("envelopeId") REFERENCES "envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'envelope_share_createdById_fkey') THEN
    ALTER TABLE "envelope_share"
      ADD CONSTRAINT "envelope_share_createdById_fkey"
        FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
