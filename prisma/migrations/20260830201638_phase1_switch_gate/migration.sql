-- AlterTable
ALTER TABLE "organisation" ADD COLUMN     "ssoClientId" TEXT,
ADD COLUMN     "ssoClientSecret" TEXT,
ADD COLUMN     "ssoEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ssoIssuer" TEXT,
ADD COLUMN     "ssoScopes" TEXT NOT NULL DEFAULT 'openid profile email';

-- AlterTable
ALTER TABLE "recipient" ADD COLUMN     "accessCodeHash" TEXT;

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "ssoOrgId" TEXT,
ADD COLUMN     "ssoSubject" TEXT;

-- CreateIndex
CREATE INDEX "user_ssoSubject_ssoOrgId_idx" ON "user"("ssoSubject", "ssoOrgId");

