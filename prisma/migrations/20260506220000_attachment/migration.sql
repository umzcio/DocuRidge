-- Recipient-uploaded supporting files attached to ATTACHMENT-typed fields.
-- Note: the original migration also ran `ALTER TYPE "FieldType" ADD VALUE
-- 'ATTACHMENT'`, but Postgres rejects ADD VALUE inside a transaction block
-- (the wrapper Prisma uses). The enum value is already present from an
-- earlier manual apply on this database; for fresh installs the value is
-- introduced via the dedicated enum migrations that ship before this one.
-- This migration's job is just the table + constraints. Idempotent.
CREATE TABLE IF NOT EXISTS "field_attachment" (
  "id"          TEXT NOT NULL,
  "fieldId"     TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "filename"    TEXT NOT NULL,
  "mimeType"    TEXT NOT NULL,
  "sizeBytes"   INTEGER NOT NULL,
  "sha256"      TEXT NOT NULL,
  "storagePath" TEXT NOT NULL,
  "uploadedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "field_attachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "field_attachment_fieldId_key" ON "field_attachment"("fieldId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_attachment_fieldId_fkey') THEN
    ALTER TABLE "field_attachment"
      ADD CONSTRAINT "field_attachment_fieldId_fkey"
        FOREIGN KEY ("fieldId") REFERENCES "field"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_attachment_recipientId_fkey') THEN
    ALTER TABLE "field_attachment"
      ADD CONSTRAINT "field_attachment_recipientId_fkey"
        FOREIGN KEY ("recipientId") REFERENCES "recipient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
