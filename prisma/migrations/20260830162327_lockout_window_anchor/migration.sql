-- Anchor the lockout window on the first failure of a series rather than on
-- the row's generic updatedAt, which any unrelated write refreshes.
ALTER TABLE "user" ADD COLUMN "firstFailedAttemptAt" TIMESTAMP(3);
