-- Recipient's chosen cursive font when adopting a typed signature.
ALTER TABLE "signature" ADD COLUMN IF NOT EXISTS "typedFont" TEXT;

-- Org-wide default font for typed text fields rendered on sealed PDFs.
ALTER TABLE "organisation" ADD COLUMN IF NOT EXISTS "defaultFieldFont" TEXT;
