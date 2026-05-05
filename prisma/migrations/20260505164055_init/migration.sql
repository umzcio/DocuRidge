-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('ADMIN', 'SENDER', 'VIEWER');

-- CreateEnum
CREATE TYPE "EnvelopeType" AS ENUM ('DOCUMENT', 'TEMPLATE');

-- CreateEnum
CREATE TYPE "EnvelopeStatus" AS ENUM ('DRAFT', 'SENT', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RoutingMode" AS ENUM ('SEQUENTIAL', 'PARALLEL');

-- CreateEnum
CREATE TYPE "Privacy" AS ENUM ('ISOLATED', 'SHARED');

-- CreateEnum
CREATE TYPE "StorageType" AS ENUM ('LOCAL_FS', 'S3');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('UNSCANNED', 'CLEAN', 'INFECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "RecipientRole" AS ENUM ('SIGNER', 'APPROVER', 'CC', 'VIEWER');

-- CreateEnum
CREATE TYPE "ReadStatus" AS ENUM ('NOT_OPENED', 'OPENED');

-- CreateEnum
CREATE TYPE "SigningStatus" AS ENUM ('NOT_SIGNED', 'SIGNED', 'DECLINED');

-- CreateEnum
CREATE TYPE "SendStatus" AS ENUM ('NOT_SENT', 'SENT', 'BOUNCED', 'FAILED');

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('SIGNATURE', 'INITIALS', 'DATE', 'TEXT', 'NUMBER', 'CHECKBOX', 'RADIO', 'DROPDOWN', 'EMAIL', 'NAME');

-- CreateEnum
CREATE TYPE "BulkStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BulkRowStatus" AS ENUM ('PENDING', 'DISPATCHED', 'FAILED', 'SKIPPED_ALLOWLIST');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "organisation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoUrl" TEXT,
    "senderEmailFromName" TEXT,
    "defaultEnvelopeTtl" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_member" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "mustResetPassword" BOOLEAN NOT NULL DEFAULT false,
    "emailVerifiedAt" TIMESTAMP(3),
    "name" TEXT NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastSignedInAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_token" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "password_reset_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_token" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "email_verification_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_security_audit_event" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_security_audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "envelope" (
    "id" TEXT NOT NULL,
    "secondaryId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "folderId" TEXT,
    "type" "EnvelopeType" NOT NULL,
    "status" "EnvelopeStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "subject" TEXT,
    "message" TEXT,
    "templateOriginId" TEXT,
    "templateSnapshot" JSONB,
    "routingMode" "RoutingMode" NOT NULL DEFAULT 'SEQUENTIAL',
    "recipientPrivacy" "Privacy" NOT NULL DEFAULT 'ISOLATED',
    "expiresAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "declinedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "envelope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "envelope_item" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "documentFileId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "pageCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "envelope_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_file" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "storageType" "StorageType" NOT NULL DEFAULT 'LOCAL_FS',
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedById" TEXT,
    "scanStatus" "ScanStatus" NOT NULL DEFAULT 'UNSCANNED',
    "scannedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "document_file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipient" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "roleLabel" TEXT,
    "recipientRole" "RecipientRole" NOT NULL DEFAULT 'SIGNER',
    "signingOrder" INTEGER NOT NULL,
    "readStatus" "ReadStatus" NOT NULL DEFAULT 'NOT_OPENED',
    "signingStatus" "SigningStatus" NOT NULL DEFAULT 'NOT_SIGNED',
    "sendStatus" "SendStatus" NOT NULL DEFAULT 'NOT_SENT',
    "tokenJti" TEXT,
    "currentTokenExpiresAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastReminderSentAt" TIMESTAMP(3),
    "nextReminderAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "consentGivenAt" TIMESTAMP(3),
    "consentDisclosureVersion" TEXT,

    CONSTRAINT "recipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "envelopeItemId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "type" "FieldType" NOT NULL,
    "page" INTEGER NOT NULL,
    "x" DECIMAL(8,6) NOT NULL,
    "y" DECIMAL(8,6) NOT NULL,
    "w" DECIMAL(8,6) NOT NULL,
    "h" DECIMAL(8,6) NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "defaultValue" TEXT,
    "meta" JSONB,
    "value" TEXT,
    "filledAt" TIMESTAMP(3),
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "field_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "fieldId" TEXT,
    "imagePngBase64" TEXT,
    "typedSignature" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "signature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "envelope_meta" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "signaturesAllowed" JSONB NOT NULL DEFAULT '{"drawn": true, "typed": true, "uploaded": false}',
    "reminderSettings" JSONB NOT NULL DEFAULT '{"daysBeforeFirst": 3, "daysBetween": 3, "maxReminders": 3}',
    "language" TEXT NOT NULL DEFAULT 'en-US',
    "redirectUrl" TEXT,

    CONSTRAINT "envelope_meta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorRecipientId" TEXT,
    "actorEmail" TEXT,
    "actorName" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "data" JSONB,
    "prevHash" TEXT NOT NULL,
    "eventHash" TEXT NOT NULL,
    "signature" TEXT NOT NULL DEFAULT '',
    "signedByKeyId" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sealed_document" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "documentFileId" TEXT NOT NULL,
    "manifestJson" JSONB NOT NULL,
    "manifestSignature" TEXT NOT NULL DEFAULT '',
    "chainHeadHash" TEXT NOT NULL,
    "signedByKeyId" TEXT NOT NULL DEFAULT '',
    "sealedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sealed_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_event" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "envelopeId" TEXT,
    "recipientId" TEXT,
    "type" TEXT NOT NULL,
    "messageId" TEXT,
    "subject" TEXT,
    "toAddress" TEXT NOT NULL,
    "error" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folder" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "type" "EnvelopeType" NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "folder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_direct_link" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_direct_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_send_job" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "templateEnvelopeId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "status" "BulkStatus" NOT NULL DEFAULT 'PENDING',
    "totalRows" INTEGER NOT NULL,
    "succeededRows" INTEGER NOT NULL DEFAULT 0,
    "failedRows" INTEGER NOT NULL DEFAULT 0,
    "csvFilename" TEXT NOT NULL,
    "csvSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "bulk_send_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_send_row" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "recipientMap" JSONB NOT NULL,
    "fieldOverrides" JSONB,
    "envelopeId" TEXT,
    "status" "BulkRowStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,

    CONSTRAINT "bulk_send_row_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_signing_key" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'ed25519',
    "publicKeyPem" TEXT NOT NULL,
    "keyFilename" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "org_signing_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_token" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "api_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_subscription" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[],
    "secret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "webhook_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_call" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_call_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "background_job" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "background_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit" (
    "key" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rate_limit_pkey" PRIMARY KEY ("key","action","bucket")
);

-- CreateTable
CREATE TABLE "bootstrap_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "pendingAdminUserId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bootstrap_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organisation_slug_key" ON "organisation"("slug");

-- CreateIndex
CREATE INDEX "org_member_orgId_idx" ON "org_member"("orgId");

-- CreateIndex
CREATE INDEX "org_member_userId_idx" ON "org_member"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "org_member_orgId_userId_key" ON "org_member"("orgId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_deletedAt_idx" ON "user"("deletedAt");

-- CreateIndex
CREATE INDEX "session_userId_expiresAt_idx" ON "session"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "session_expiresAt_idx" ON "session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_token_tokenHash_key" ON "password_reset_token"("tokenHash");

-- CreateIndex
CREATE INDEX "password_reset_token_userId_idx" ON "password_reset_token"("userId");

-- CreateIndex
CREATE INDEX "password_reset_token_expiresAt_idx" ON "password_reset_token"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_token_tokenHash_key" ON "email_verification_token"("tokenHash");

-- CreateIndex
CREATE INDEX "email_verification_token_userId_idx" ON "email_verification_token"("userId");

-- CreateIndex
CREATE INDEX "email_verification_token_expiresAt_idx" ON "email_verification_token"("expiresAt");

-- CreateIndex
CREATE INDEX "user_security_audit_event_userId_createdAt_idx" ON "user_security_audit_event"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "user_security_audit_event_type_idx" ON "user_security_audit_event"("type");

-- CreateIndex
CREATE UNIQUE INDEX "envelope_secondaryId_key" ON "envelope"("secondaryId");

-- CreateIndex
CREATE INDEX "envelope_orgId_status_createdAt_idx" ON "envelope"("orgId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "envelope_orgId_deletedAt_idx" ON "envelope"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "envelope_createdById_idx" ON "envelope"("createdById");

-- CreateIndex
CREATE INDEX "envelope_templateOriginId_idx" ON "envelope"("templateOriginId");

-- CreateIndex
CREATE INDEX "envelope_item_envelopeId_idx" ON "envelope_item"("envelopeId");

-- CreateIndex
CREATE UNIQUE INDEX "envelope_item_envelopeId_order_key" ON "envelope_item"("envelopeId", "order");

-- CreateIndex
CREATE INDEX "document_file_orgId_idx" ON "document_file"("orgId");

-- CreateIndex
CREATE INDEX "document_file_sha256_idx" ON "document_file"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "recipient_tokenJti_key" ON "recipient"("tokenJti");

-- CreateIndex
CREATE INDEX "recipient_envelopeId_signingOrder_idx" ON "recipient"("envelopeId", "signingOrder");

-- CreateIndex
CREATE INDEX "recipient_email_idx" ON "recipient"("email");

-- CreateIndex
CREATE INDEX "recipient_signingStatus_idx" ON "recipient"("signingStatus");

-- CreateIndex
CREATE INDEX "field_envelopeId_recipientId_idx" ON "field"("envelopeId", "recipientId");

-- CreateIndex
CREATE INDEX "field_envelopeItemId_page_idx" ON "field"("envelopeItemId", "page");

-- CreateIndex
CREATE UNIQUE INDEX "signature_fieldId_key" ON "signature"("fieldId");

-- CreateIndex
CREATE INDEX "signature_recipientId_idx" ON "signature"("recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "envelope_meta_envelopeId_key" ON "envelope_meta"("envelopeId");

-- CreateIndex
CREATE UNIQUE INDEX "audit_event_eventHash_key" ON "audit_event"("eventHash");

-- CreateIndex
CREATE INDEX "audit_event_envelopeId_createdAt_idx" ON "audit_event"("envelopeId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_event_type_idx" ON "audit_event"("type");

-- CreateIndex
CREATE UNIQUE INDEX "audit_event_envelopeId_seq_key" ON "audit_event"("envelopeId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "sealed_document_envelopeId_key" ON "sealed_document"("envelopeId");

-- CreateIndex
CREATE INDEX "email_event_orgId_createdAt_idx" ON "email_event"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "email_event_envelopeId_idx" ON "email_event"("envelopeId");

-- CreateIndex
CREATE INDEX "email_event_recipientId_idx" ON "email_event"("recipientId");

-- CreateIndex
CREATE INDEX "folder_orgId_type_idx" ON "folder"("orgId", "type");

-- CreateIndex
CREATE INDEX "folder_parentId_idx" ON "folder"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "template_direct_link_envelopeId_key" ON "template_direct_link"("envelopeId");

-- CreateIndex
CREATE UNIQUE INDEX "template_direct_link_token_key" ON "template_direct_link"("token");

-- CreateIndex
CREATE INDEX "bulk_send_job_orgId_createdAt_idx" ON "bulk_send_job"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "bulk_send_job_status_idx" ON "bulk_send_job"("status");

-- CreateIndex
CREATE UNIQUE INDEX "bulk_send_row_jobId_rowNumber_key" ON "bulk_send_row"("jobId", "rowNumber");

-- CreateIndex
CREATE UNIQUE INDEX "org_signing_key_fingerprint_key" ON "org_signing_key"("fingerprint");

-- CreateIndex
CREATE INDEX "org_signing_key_orgId_idx" ON "org_signing_key"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "api_token_tokenHash_key" ON "api_token"("tokenHash");

-- CreateIndex
CREATE INDEX "api_token_orgId_idx" ON "api_token"("orgId");

-- CreateIndex
CREATE INDEX "api_token_userId_idx" ON "api_token"("userId");

-- CreateIndex
CREATE INDEX "webhook_subscription_orgId_idx" ON "webhook_subscription"("orgId");

-- CreateIndex
CREATE INDEX "webhook_call_subscriptionId_createdAt_idx" ON "webhook_call"("subscriptionId", "createdAt");

-- CreateIndex
CREATE INDEX "background_job_status_runAt_idx" ON "background_job"("status", "runAt");

-- CreateIndex
CREATE INDEX "background_job_type_idx" ON "background_job"("type");

-- CreateIndex
CREATE INDEX "rate_limit_bucket_idx" ON "rate_limit"("bucket");

-- AddForeignKey
ALTER TABLE "org_member" ADD CONSTRAINT "org_member_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_member" ADD CONSTRAINT "org_member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_token" ADD CONSTRAINT "password_reset_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_token" ADD CONSTRAINT "email_verification_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_security_audit_event" ADD CONSTRAINT "user_security_audit_event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envelope" ADD CONSTRAINT "envelope_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envelope" ADD CONSTRAINT "envelope_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envelope" ADD CONSTRAINT "envelope_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "folder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envelope" ADD CONSTRAINT "envelope_templateOriginId_fkey" FOREIGN KEY ("templateOriginId") REFERENCES "envelope"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envelope_item" ADD CONSTRAINT "envelope_item_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envelope_item" ADD CONSTRAINT "envelope_item_documentFileId_fkey" FOREIGN KEY ("documentFileId") REFERENCES "document_file"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_file" ADD CONSTRAINT "document_file_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_file" ADD CONSTRAINT "document_file_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipient" ADD CONSTRAINT "recipient_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field" ADD CONSTRAINT "field_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field" ADD CONSTRAINT "field_envelopeItemId_fkey" FOREIGN KEY ("envelopeItemId") REFERENCES "envelope_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field" ADD CONSTRAINT "field_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "recipient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature" ADD CONSTRAINT "signature_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "recipient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature" ADD CONSTRAINT "signature_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "field"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envelope_meta" ADD CONSTRAINT "envelope_meta_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "envelope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sealed_document" ADD CONSTRAINT "sealed_document_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "envelope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_event" ADD CONSTRAINT "email_event_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_event" ADD CONSTRAINT "email_event_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "envelope"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folder" ADD CONSTRAINT "folder_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folder" ADD CONSTRAINT "folder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "folder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folder" ADD CONSTRAINT "folder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_direct_link" ADD CONSTRAINT "template_direct_link_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_send_job" ADD CONSTRAINT "bulk_send_job_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_send_job" ADD CONSTRAINT "bulk_send_job_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_send_row" ADD CONSTRAINT "bulk_send_row_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "bulk_send_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_signing_key" ADD CONSTRAINT "org_signing_key_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_subscription" ADD CONSTRAINT "webhook_subscription_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_call" ADD CONSTRAINT "webhook_call_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "webhook_subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
