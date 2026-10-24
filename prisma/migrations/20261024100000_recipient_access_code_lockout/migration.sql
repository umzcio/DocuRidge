-- Per-recipient access-code lockout. Additive only: two defaulted counters
-- and one nullable timestamp (constant defaults are metadata-only in PG11+,
-- so no table rewrite).
ALTER TABLE "recipient" ADD COLUMN "accessCodeFailedAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "recipient" ADD COLUMN "accessCodeLockedUntil" TIMESTAMP(3);
ALTER TABLE "recipient" ADD COLUMN "accessCodeLockouts" INTEGER NOT NULL DEFAULT 0;
