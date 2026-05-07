-- Per-user "mark notifications as read" cursor.
-- The dropdown filters audit events to those newer than this timestamp;
-- clicking Clear bumps it to NOW(). Doesn't touch the audit chain.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "notificationsClearedAt" TIMESTAMP(3);
