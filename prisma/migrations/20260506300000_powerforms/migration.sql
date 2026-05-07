-- PowerForms: public-link envelope creation from a template.
ALTER TABLE "envelope" ADD COLUMN "publicFormToken" TEXT;
ALTER TABLE "envelope" ADD COLUMN "publicFormEnabled" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "envelope_publicFormToken_key" ON "envelope"("publicFormToken");
