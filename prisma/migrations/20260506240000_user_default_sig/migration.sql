-- User-level saved default signature + initials. Adopted-once-reused-everywhere.
ALTER TABLE "user" ADD COLUMN "defaultSignaturePngBase64" TEXT;
ALTER TABLE "user" ADD COLUMN "defaultTypedSignature"     TEXT;
ALTER TABLE "user" ADD COLUMN "defaultInitialsPngBase64"  TEXT;
ALTER TABLE "user" ADD COLUMN "defaultTypedInitials"      TEXT;
