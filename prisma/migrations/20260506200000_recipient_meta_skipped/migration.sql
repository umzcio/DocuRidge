-- Conditional routing: per-recipient sender-configured rule + a SKIPPED
-- terminal status applied when the rule isn't satisfied at routing time.
ALTER TYPE "SigningStatus" ADD VALUE 'SKIPPED';
ALTER TABLE "recipient" ADD COLUMN "meta" JSONB;
