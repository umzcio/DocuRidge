-- AlterTable
ALTER TABLE "envelope_meta" ADD COLUMN     "emailSubject" TEXT;

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "jobTitle" TEXT,
ADD COLUMN     "notificationPrefs" JSONB NOT NULL DEFAULT '{"sentForSignature":true,"recipientSigned":true,"completed":true,"declined":true,"reminderDigest":false}';
