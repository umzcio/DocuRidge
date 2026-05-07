-- Per-envelope comments thread (sender + recipient back-channel).
CREATE TABLE "envelope_comment" (
  "id"                TEXT NOT NULL,
  "envelopeId"        TEXT NOT NULL,
  "authorUserId"      TEXT,
  "authorRecipientId" TEXT,
  "authorName"        TEXT NOT NULL,
  "body"              TEXT NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "envelope_comment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "envelope_comment_envelopeId_createdAt_idx"
  ON "envelope_comment"("envelopeId", "createdAt");
ALTER TABLE "envelope_comment"
  ADD CONSTRAINT "envelope_comment_envelopeId_fkey"
    FOREIGN KEY ("envelopeId") REFERENCES "envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "envelope_comment"
  ADD CONSTRAINT "envelope_comment_authorUserId_fkey"
    FOREIGN KEY ("authorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "envelope_comment"
  ADD CONSTRAINT "envelope_comment_authorRecipientId_fkey"
    FOREIGN KEY ("authorRecipientId") REFERENCES "recipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
